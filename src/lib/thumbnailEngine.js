// Thumbnail engine — "given a file, what do I paint in a tile?"
//
// REWRITE NOTE (replaces lib/thumbnailResolver.js). The old resolver treated
// every thumbnail as an async job: fetch the bytes, decode them in the
// renderer, mint a blob: URL, cache the string, revoke it on eviction. That
// design produced the random breakage this replaces:
//
//   • No concurrency limit. A folder of 200 files started 200 fetches, pdf.js
//     parses and <video> elements at once. Chromium caps concurrent media
//     decoders, so the 6–8s internal timeouts fired in bursts and whole
//     screens of tiles fell back to glyphs — different ones each time.
//   • Blob URLs were revoked by FIFO cache eviction while <img> elements were
//     still painting them, so scrolling a big folder broke tiles that had
//     already loaded.
//   • An <img> load error re-ran the SAME resolution, which produced the same
//     URL, which failed again — a retry loop that competed with the storm.
//   • Full-resolution images were used as tile posters, so a folder of camera
//     photos decoded hundreds of megapixels to paint 120px squares.
//
// The new model: a thumbnail is a LIST OF CANDIDATE URLS, tried in order.
// On Electron the first candidate is `localfile://…?thumb=N`, which the main
// process answers with a small JPEG from the OS thumbnailer (Windows Shell /
// macOS QuickLook) backed by a persistent on-disk cache. That is a plain
// <img src> — no fetch, no canvas, no blob URL, nothing to revoke, and the
// browser's own lazy-loading decides when it's fetched. If a candidate fails,
// the component walks to the next one; when the list runs out it paints the
// file's glyph. Renderer-side generation (pdf.js / video frame grab / PPTX
// preview) is now only the LAST resort — for the web build, or where no OS
// provider exists — and it runs through a bounded queue with single-flight,
// refcounted blob URLs, and a negative cache so failures don't stampede.
//
// Exports:
//   buildCandidates(descriptor) → Candidate[]   (pure, synchronous)
//   generate(descriptor)        → Promise<string|null>   (queued, cached)
//   retain(key) / release(key)  — refcount a generated blob URL
//   clearThumbnailCache()       — Debug menu / sign-out

import { generateThumbnail, isPptxFile } from './thumbnails';
import { readLocalBlob } from './localFolder';

// Width requested from the OS thumbnailer. Tiles paint at ~120 CSS px and can
// be zoomed to ~200; 256 covers those at 2x DPI without asking the shell for
// anything expensive.
export const THUMB_W = 256;

// Renderer-side generation is the expensive path — cap how much of it can run
// at once. Three is enough to keep a scroll filled without ever putting enough
// pressure on the decoders to start timing out.
const MAX_CONCURRENT_GENERATIONS = 3;
// A generator that hangs must not pin a queue slot forever.
const GENERATE_TIMEOUT_MS = 15000;
// How long a failure is remembered before we'd try again, and how many times
// we're willing to try at all. Shared per file — NOT per component, so twenty
// tiles of the same file can't multiply the retries.
const FAIL_TTL_MS = 60000;
const MAX_ATTEMPTS = 2;

// ── Type classification ───────────────────────────────────────────────────

function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i > 0 ? s.slice(i + 1).toLowerCase() : '';
}

// Images the browser itself decodes. Anything here can safely fall back to the
// original bytes when no OS thumbnail exists.
const BROWSER_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico']);
// Images the browser CANNOT decode. These must never fall back to raw bytes —
// that's what painted a broken (non-square) image instead of a clean glyph.
// The OS thumbnailer handles most of them, which is why they're still worth a
// `?thumb=` request.
const OPAQUE_IMAGE_EXTS = new Set([
  'tif', 'tiff', 'heic', 'heif', 'psd', 'ai', 'eps',
  'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2', 'raf', 'srw',
]);
// Animation / vector formats: a downscaled OS thumbnail would freeze a GIF and
// rasterise an SVG, and both are small enough to paint directly.
const SKIP_OS_THUMB_EXTS = new Set(['gif', 'webp', 'svg', 'ico']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ogv']);
// Document types the OS shell can render a page preview for.
const DOC_THUMB_EXTS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf']);

// One classification used by every decision below. Extension first: the
// local-folder MIME guesser reports plenty of real formats (.pptx, .heic) as
// application/octet-stream, so trusting MIME alone loses thumbnails.
export function classifyForThumb(mime, name) {
  const m = String(mime || '').toLowerCase();
  const ext = extOf(name);
  if (m.startsWith('image/') || BROWSER_IMAGE_EXTS.has(ext) || OPAQUE_IMAGE_EXTS.has(ext)) {
    return OPAQUE_IMAGE_EXTS.has(ext) || /photoshop|illustrator|tiff|heic|heif|postscript/.test(m)
      ? 'image-opaque'
      : 'image';
  }
  if (m.startsWith('video/') || VIDEO_EXTS.has(ext)) return 'video';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (isPptxFile(m, name)) return 'pptx';
  if (DOC_THUMB_EXTS.has(ext)) return 'doc';
  return 'other';
}

// ── Candidate list ────────────────────────────────────────────────────────
//
// Descriptor (built by lib/thumbnailDescriptor.js):
//   { name, mime, path, url, contentKey, duration }
//     path — on-disk path (Electron) or a 'web://…' pseudo-path, else null
//     url  — an already-usable URL the caller holds (blob: from a staged
//            upload, http(s):), else null
//
// Candidate = { kind: 'url', url } | { kind: 'generate' }

function localfileUrl(path, { thumb = 0, bust = '' } = {}) {
  const base = `localfile://local/${encodeURIComponent(path)}`;
  const params = [];
  if (thumb) params.push(`thumb=${thumb}`);
  // The main process serves thumbnails with a 1h cache-control, so the URL has
  // to change when the bytes do or a re-render repaints stale pixels.
  if (bust) params.push(`t=${encodeURIComponent(bust)}`);
  return params.length ? `${base}?${params.join('&')}` : base;
}

// A disk path we can hand to the localfile:// protocol (Electron only).
function osPathOf(descriptor) {
  const p = descriptor?.path;
  if (typeof p === 'string' && p && !p.startsWith('web://')) return p;
  // Legacy call sites pass a localfile:// URL instead of a path — recover the
  // path so those surfaces get OS thumbnails too.
  const u = descriptor?.url;
  if (typeof u === 'string' && u.startsWith('localfile://local/')) {
    try {
      const raw = new URL(u).pathname.replace(/^\//, '');
      return decodeURIComponent(raw);
    } catch { return null; }
  }
  return null;
}

// ── What has already failed ───────────────────────────────────────────────
//
// Two levels, because a tile can mount many times in a session (re-render,
// scroll, a folder refresh) and each mount would otherwise repeat a request
// that's already known to fail — which is what filled the console with
// identical 415s.
//
//   1. Exact URL. Precise and safe: the URL embeds the file's mtime, so an
//      edited file mints a new URL and is retried.
//   2. Extension. Only for formats whose OS thumbnail is the ONLY option
//      (Office / OpenDocument): once two distinct files of that type have
//      come back empty, this machine clearly has no provider for it, so stop
//      asking for the rest of the folder. Deliberately NOT applied to images
//      or video — those have their own fallbacks, and a batch of files behind
//      a permission error would otherwise poison a whole format.
const failedUrls = new Set();
const FAILED_URLS_MAX = 5000;
const extFailures = new Map();     // ext → Set<path>
let unsupportedExts = new Set();
let refreshingExts = false;
// Formats where no OS thumbnail means no thumbnail at all.
const OS_ONLY_EXTS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'odt', 'ods', 'odp', 'rtf']);

// Called by the component when a painted candidate fails to load.
export function noteCandidateFailure(candidate, descriptor) {
  if (candidate?.kind === 'url' && candidate.url) {
    if (failedUrls.size >= FAILED_URLS_MAX) failedUrls.clear();
    failedUrls.add(candidate.url);
  }
  if (candidate?.id !== 'os') return;
  const ext = extOf(descriptor?.name);
  if (OS_ONLY_EXTS.has(ext)) {
    const seen = extFailures.get(ext) || new Set();
    seen.add(descriptor?.path || descriptor?.url || '');
    extFailures.set(ext, seen);
    if (seen.size >= 2) unsupportedExts.add(ext);
  }
  // The main process knows authoritatively which formats it could never
  // thumbnail (it tracks real provider results); fold that in too.
  refreshUnsupportedExts();
}

export function refreshUnsupportedExts() {
  if (refreshingExts) return;
  const api = typeof window !== 'undefined' ? window.electronAPI : null;
  if (!api?.getUnsupportedThumbExts) return;
  refreshingExts = true;
  api.getUnsupportedThumbExts()
    .then((list) => {
      if (Array.isArray(list)) list.forEach((e) => unsupportedExts.add(e));
    })
    .catch(() => { /* keep what we've learned locally */ })
    .finally(() => { refreshingExts = false; });
}

export function buildCandidates(descriptor) {
  if (!descriptor) return [];
  const kind = classifyForThumb(descriptor.mime, descriptor.name);
  if (kind === 'other') return [];              // straight to the glyph

  const out = [];
  const path = osPathOf(descriptor);
  const bust = descriptor.bust || '';
  const ext = extOf(descriptor.name);

  if (path) {
    // 1. OS thumbnail — small, cached on disk by the main process, painted by
    //    a plain <img>. The one candidate that covers every type.
    const osUrl = localfileUrl(path, { thumb: THUMB_W, bust });
    if (!(kind === 'image' && SKIP_OS_THUMB_EXTS.has(ext))
        && !unsupportedExts.has(ext)
        && !failedUrls.has(osUrl)) {
      out.push({ kind: 'url', url: osUrl, id: 'os' });
    }
    // 2. Original bytes — only for formats the browser decodes itself.
    if (kind === 'image') {
      const rawUrl = localfileUrl(path, { bust });
      if (!failedUrls.has(rawUrl)) out.push({ kind: 'url', url: rawUrl, id: 'raw' });
    }
  } else if (descriptor.url) {
    // A caller-supplied URL (staged upload blob:, remote https:). Images can be
    // painted as-is; everything else has to be generated from those bytes.
    if (kind === 'image') out.push({ kind: 'url', url: descriptor.url, id: 'raw' });
  }

  // 3. Renderer-side generation. Last resort: the web build (no localfile://),
  //    a platform with no shell thumbnail provider (Linux), or a format whose
  //    provider is missing (PDF without a viewer installed).
  if (kind === 'pdf' || kind === 'video' || kind === 'pptx'
      || (kind === 'image' && !path)) {
    out.push({ kind: 'generate', id: 'gen' });
  }
  return out;
}

// ── Generated-thumbnail cache (refcounted) ────────────────────────────────
//
// Blob URLs live here keyed by contentKey. `refs` counts the mounted
// components currently painting one: eviction NEVER revokes a URL with a live
// reference, which is what used to break tiles mid-scroll.

const _cache = new Map();     // key → { url, refs, at }
const _inflight = new Map();  // key → Promise<string|null>
const _failed = new Map();    // key → { attempts, until }
const CACHE_MAX = 200;

function evictIfNeeded() {
  if (_cache.size <= CACHE_MAX) return;
  // Oldest-first, but only entries nothing is painting.
  const entries = [..._cache.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [key, entry] of entries) {
    if (_cache.size <= CACHE_MAX) break;
    if (entry.refs > 0) continue;
    try { URL.revokeObjectURL(entry.url); } catch { /* already gone */ }
    _cache.delete(key);
  }
}

export function retain(key) {
  const entry = key && _cache.get(key);
  if (entry) entry.refs += 1;
}

export function release(key) {
  const entry = key && _cache.get(key);
  if (entry && entry.refs > 0) entry.refs -= 1;
}

export function clearThumbnailCache() {
  for (const entry of _cache.values()) {
    try { URL.revokeObjectURL(entry.url); } catch { /* ignore */ }
  }
  _cache.clear();
  _inflight.clear();
  _failed.clear();
}

// Has this file already failed enough that we shouldn't try again yet?
export function isKnownBad(key) {
  const f = key && _failed.get(key);
  if (!f) return false;
  if (f.attempts >= MAX_ATTEMPTS) return true;   // give up for the session
  return Date.now() < f.until;                   // cooling off
}

function noteFailure(key) {
  if (!key) return;
  const prev = _failed.get(key) || { attempts: 0 };
  _failed.set(key, { attempts: prev.attempts + 1, until: Date.now() + FAIL_TTL_MS });
}

// ── Bounded work queue ────────────────────────────────────────────────────

let activeJobs = 0;
const queued = [];

function pump() {
  while (activeJobs < MAX_CONCURRENT_GENERATIONS && queued.length) {
    const job = queued.shift();
    activeJobs += 1;
    job.run().then(job.resolve, job.reject).finally(() => {
      activeJobs -= 1;
      pump();
    });
  }
}

function schedule(run) {
  return new Promise((resolve, reject) => {
    queued.push({ run, resolve, reject });
    pump();
  });
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

// ── Generation ────────────────────────────────────────────────────────────

// Pull the file's bytes as a File so the generators (which dispatch on
// file.type) route correctly. Prefers the folder backend's own reader — on web
// that's the cached FileSystemFileHandle, no network involved.
async function bytesOf(descriptor, kind) {
  const { path, url, name, mime } = descriptor;
  let blob = null;
  if (path) {
    blob = await readLocalBlob(path);
  } else if (url) {
    const res = await fetch(url);
    if (!res.ok) return null;
    blob = await res.blob();
  }
  if (!blob) return null;
  // generateThumbnail dispatches on file.type, and the local-folder MIME
  // guesser hands back application/octet-stream for plenty of real formats —
  // so state the type our own classification already determined.
  const byKind = { pdf: 'application/pdf', video: 'video/mp4' };
  const type = byKind[kind] || mime || blob.type || 'application/octet-stream';
  return new File([blob], name || 'file', { type });
}

// Grab a poster frame by streaming the source into a hidden <video>, rather
// than downloading the whole file. Range requests make the seek cheap.
function videoPoster(sourceUrl, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    // crossOrigin is only correct for remote sources: some Chromium builds
    // reject it on custom protocols and silently abort the load.
    if (/^https?:/i.test(sourceUrl)) video.crossOrigin = 'anonymous';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onerror = null;
      try { video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.onerror = () => finish(null);
    video.onloadedmetadata = () => {
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      video.onseeked = () => {
        try {
          const w = video.videoWidth || 320;
          const h = video.videoHeight || 180;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(video, 0, 0, w, h);
          canvas.toBlob(
            (blob) => finish(blob ? URL.createObjectURL(blob) : null),
            'image/jpeg',
            0.78,
          );
        } catch { finish(null); }
      };
      try { video.currentTime = Math.min(1, Math.max(0, dur * 0.1)); } catch { finish(null); }
    };
    video.src = sourceUrl;
  });
}

async function runGeneration(descriptor) {
  const kind = classifyForThumb(descriptor.mime, descriptor.name);
  const path = osPathOf(descriptor);

  if (kind === 'video') {
    // Stream, don't download: a poster frame shouldn't cost the whole file.
    const src = path ? localfileUrl(path, { bust: descriptor.bust || '' }) : descriptor.url;
    if (src) {
      const poster = await videoPoster(src);
      if (poster) return poster;
    }
    if (!descriptor.path?.startsWith('web://')) return null;
    // Web build: no streamable URL, fall through to the bytes path below.
  }

  const file = await bytesOf(descriptor, kind);
  if (!file) return null;
  const blob = await generateThumbnail(file);
  return blob ? URL.createObjectURL(blob) : null;
}

// Generate (or reuse) a thumbnail for this descriptor. Single-flight per
// contentKey, queued, timeout-bounded, and negative-cached on failure.
// Callers must retain(key) while painting the result and release(key) after.
export async function generate(descriptor) {
  const key = descriptor?.contentKey || null;
  if (!key) return withTimeout(schedule(() => runGeneration(descriptor)), GENERATE_TIMEOUT_MS);

  const hit = _cache.get(key);
  if (hit) { hit.at = Date.now(); return hit.url; }
  if (isKnownBad(key)) return null;
  const inflight = _inflight.get(key);
  if (inflight) return inflight;

  const job = (async () => {
    try {
      const url = await withTimeout(schedule(() => runGeneration(descriptor)), GENERATE_TIMEOUT_MS);
      if (url) {
        _cache.set(key, { url, refs: 0, at: Date.now() });
        _failed.delete(key);
        evictIfNeeded();
      } else {
        noteFailure(key);
      }
      return url;
    } catch {
      noteFailure(key);
      return null;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, job);
  return job;
}

// Cached result without starting work — lets a re-mount paint on the first
// frame instead of flashing its glyph.
export function peek(key) {
  const hit = key && _cache.get(key);
  return hit ? hit.url : null;
}

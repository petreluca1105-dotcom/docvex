// Content search for the Files page — "does this file CONTAIN the query", as
// opposed to the name match the list has always done.
//
// Reading a folder's worth of documents is expensive (a PDF goes through
// pdf.js, a .docx through docx-preview, a workbook through SheetJS), so the
// cost is contained on four fronts:
//   • only formats extractFileText can actually read are attempted at all,
//   • each file's text is cached, keyed by size+mtime so an edit re-reads it,
//   • oversized files are skipped rather than pulled into memory,
//   • the caller drives it with a small worker pool and an abort signal, so
//     typing another character cancels the scan in flight.
// Nothing here touches the network; extraction is entirely in-renderer.

import { readLocalBlob } from './localFolder';
import { extractFileText } from './extractFileText';
import { loadCaptions } from './captionsHistory';

// Formats extractFileText understands. Anything else (images, video, archives,
// legacy .doc) can't be read in the renderer, so it never even opens.
const SEARCHABLE_RE = /\.(txt|md|markdown|csv|tsv|json|js|jsx|ts|tsx|html|htm|css|scss|xml|yml|yaml|log|ini|env|py|java|c|h|cpp|cs|rb|go|rs|sh|sql|toml|rtf|pdf|docx|xlsx|xlsm|xlsb|xls)$/i;

// Past this we skip rather than read: a 40MB PDF would stall the scan for
// seconds and it's rarely what someone is searching for by content.
const MAX_SEARCH_BYTES = 24 * 1024 * 1024;

// Bounded LRU-ish cache. Text is capped at MAX_FILE_TEXT_CHARS (16k) by the
// extractor, so this tops out around a few MB of strings.
const MAX_CACHED = 400;
const cache = new Map();   // path → { key, text }

export function isContentSearchable(name, sizeBytes) {
  if (!SEARCHABLE_RE.test(name || '')) return false;
  if (sizeBytes != null && sizeBytes > MAX_SEARCH_BYTES) return false;
  return true;
}

// ── Captions ─────────────────────────────────────────────────────────────
// A recording that's been transcribed in the Doc Viewer already has its words
// on this machine (lib/captionsHistory.js), so a content search should find
// them: typing "insurance" ought to surface the interview where it was said,
// not just the documents where it was written. Nothing is transcribed FOR a
// search — only transcripts that already exist are read, so this costs nothing
// and reaches no network.

// The cached transcript for a file, or null. Read fresh every time rather than
// cached here: a transcript can be generated or hand-edited in another window
// while a search is running, and it's a localStorage hit, not a file read.
export function captionsFor(file) {
  const cap = file?.path ? loadCaptions(file.path) : null;
  return cap && cap.text ? cap : null;
}

export function hasCaptions(file) {
  return !!captionsFor(file);
}

// Everything the literal pass can look inside: readable documents, plus any
// file (an mp3, an mp4) that carries a transcript.
export function isSearchableFile(file) {
  return isContentSearchable(file?.name, file?.sizeBytes) || hasCaptions(file);
}

function formatTimestamp(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const rest = String(s % 60).padStart(2, '0');
  if (m < 60) return `${m}:${rest}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${rest}`;
}

// A caption hit is worth more than the words — it's worth WHERE in the
// recording they were said. When the match falls inside a timed segment the
// snippet leads with its timestamp so the row reads "12:04 — …the insurance
// called the next morning…".
function captionSnippet(cap, needle) {
  const seg = (cap.segments || []).find((s) => String(s?.text || '').toLowerCase().includes(needle));
  if (seg) {
    const body = String(seg.text).replace(/\s+/g, ' ').trim();
    return `${formatTimestamp(seg.start)} — ${body}`;
  }
  // No timed segment carries it (a hand-edited transcript, or a match that
  // straddles two segments) — fall back to the plain text window.
  return snippetAround(cap.text, needle);
}

// Version key for a cached extraction: any edit changes size or mtime, so a
// stale body can't survive one. Falls back to the path alone when the caller
// has no stat info (nothing to invalidate on, but still better than re-reading).
function versionKey(file) {
  return `${file?.sizeBytes ?? '?'}:${file?.mtimeIso ?? '?'}`;
}

// Extracted text for one file, from cache when possible. Returns '' for
// anything unreadable — callers treat that as "no match", not as an error.
export async function textForFile(file) {
  const path = file?.path;
  if (!path) return '';
  // A media file reaches here now that captions make it searchable — there's
  // no text to extract from an mp4, so don't open it.
  if (!isContentSearchable(file.name, file.sizeBytes)) return '';
  const key = versionKey(file);
  const hit = cache.get(path);
  if (hit && hit.key === key) {
    // Refresh recency so the eviction below drops genuinely cold entries.
    cache.delete(path);
    cache.set(path, hit);
    return hit.text;
  }
  let text = '';
  try {
    const blob = await readLocalBlob(path);
    if (blob) {
      const res = await extractFileText(blob, file.name || path);
      text = res?.text || '';
    }
  } catch {
    text = '';   // unreadable file — cached as a miss so we don't retry it
  }
  cache.set(path, { key, text });
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  return text;
}

// A readable excerpt around the match, for showing WHY a file matched.
// Trimmed to word boundaries where possible so it doesn't start mid-syllable.
const SNIPPET_BEFORE = 48;
const SNIPPET_AFTER = 110;
export function snippetAround(text, needle) {
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return '';
  let start = Math.max(0, at - SNIPPET_BEFORE);
  let end = Math.min(text.length, at + needle.length + SNIPPET_AFTER);
  // Nudge to the nearest space so words aren't cut in half.
  if (start > 0) {
    const sp = text.indexOf(' ', start);
    if (sp > -1 && sp < at) start = sp + 1;
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > at + needle.length) end = sp;
  }
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

// Scan `files` for `query`, calling onHit(file, snippet) as each match is found
// so the UI can fill in progressively instead of waiting for the whole folder.
// `signal` is an AbortSignal — abort it to stop between files.
export async function searchContents(files, query, { onHit, signal, concurrency = 3 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];
  const queue = [...files];
  const hits = [];

  const worker = async () => {
    while (queue.length) {
      if (signal?.aborted) return;
      const file = queue.shift();
      // Transcripts first: they're a localStorage read, so a recording resolves
      // instantly instead of queueing behind someone else's PDF parse.
      const cap = captionsFor(file);
      let snippet = '';
      if (cap && cap.text.toLowerCase().includes(needle)) {
        snippet = captionSnippet(cap, needle);
      } else {
        const text = await textForFile(file);
        if (signal?.aborted) return;      // re-check: extraction is slow
        if (text && text.toLowerCase().includes(needle)) snippet = snippetAround(text, needle);
      }
      if (snippet) {
        hits.push({ file, snippet });
        onHit?.(file, snippet);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return hits;
}

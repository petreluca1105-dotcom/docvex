// Persistent AI index of a folder's files — the thing that makes AI search
// cheap enough to run on every query.
//
// The naive version of AI search re-uploads the whole folder on every search:
// text excerpts for the readable files and a re-encoded still for every photo
// and video. Images dominate the bill, and paying for them again on a query
// that differs by one word is pure waste — the FILES didn't change, only the
// question did.
//
// So the expensive part is separated from the per-query part and done once:
// each file is read (or looked at) a single time and reduced to a one-line
// description of what it actually is. That description is cached on disk,
// keyed by size+mtime, and every subsequent search — any query, any wording —
// reads descriptions instead of contents. A photo is decoded and uploaded once
// in its lifetime rather than once per search.
//
// Consequences worth knowing:
//   • First AI search in a folder costs the indexing pass; later ones are a
//     fraction of it.
//   • Editing a file changes its size/mtime, which drops its description and
//     re-describes it on the next search. Untouched files are never re-read.
//   • Indexing runs on Haiku (cheapest model); only the final match step needs
//     a stronger one, and by then it's reading 25-word summaries.

import { askProjectAi } from './projectAi';
import { textForFile, isContentSearchable, captionsFor } from './fileContentSearch';
import { encodeVisualThumb, isVisualFile } from './visualThumb';

const STORE_KEY = 'docvex:ai-file-index:v1';

// Indexing is deliberately the cheapest model in the picker: writing "scanned
// invoice from Vodafone, March 2024" off an excerpt is not a reasoning task.
const INDEX_MODEL = 'claude-haiku-4-5';

// Batch sizes. Text files are cheap, so eight ride in one request; images cost
// ~350 tokens each, so they go four at a time to keep a single failure from
// wasting much.
const TEXT_BATCH = 8;
const IMAGE_BATCH = 4;

const EXCERPT_CHARS = 700;   // per file, fed to the describer
const DESC_CHARS = 240;      // stored description, hard-trimmed
const MAX_ENTRIES = 800;     // ~200KB of localStorage at the trim above

// Ceiling on how many files one search will describe. A 2,000-file folder
// shouldn't turn the first search into a bill; the rest index on later
// searches, a batch at a time, until the folder is covered.
const MAX_INDEX_PER_RUN = 120;

const INDEX_SYSTEM = [
  'You write one-line descriptions of files so they can later be found by natural-language search.',
  'For each numbered file, describe WHAT IT IS and WHAT IT IS ABOUT in at most 25 words:',
  'document type, subject matter, the people/companies/places involved, dates, and — for pictures — what is visibly happening in the image.',
  'Write plain descriptive prose. Do not judge, summarise opinions, or add anything not present in the file.',
  'Return ONLY a JSON array, no prose and no code fences: [{"n": <file number>, "d": "<description>"}]',
  'Include every file you were given. If a file is unreadable or empty, describe it from its name and type.',
].join('\n');

// ── Store ────────────────────────────────────────────────────────────────
// path → { key, desc, at }. `key` is size:mtime, so any edit invalidates the
// description without needing a content hash. `at` drives eviction.
let store = null;

function loadStore() {
  if (store) return store;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    store = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    store = {};
  }
  return store;
}

// Debounced so a 40-file indexing run writes localStorage once, not 40 times.
let saveTimer = null;
function saveStore() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const s = loadStore();
      const keys = Object.keys(s);
      if (keys.length > MAX_ENTRIES) {
        // Drop the least recently written entries. They only cost a re-read if
        // the file is ever searched again.
        keys.sort((a, b) => (s[a]?.at || 0) - (s[b]?.at || 0));
        for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete s[k];
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
    } catch { /* quota or private mode — the in-memory copy still serves this session */ }
  }, 400);
}

// A description is stale when the file changes — and also when its TRANSCRIPT
// changes. A recording described before it was transcribed says nothing about
// what's in it; once captions exist (or are hand-edited) it deserves a
// description written from what was actually said.
function captionStamp(file) {
  const cap = captionsFor(file);
  return cap ? `c${cap.createdAt || 0}-${cap.text.length}` : '';
}

export function versionKey(file) {
  return `${file?.sizeBytes ?? '?'}:${file?.mtimeIso ?? '?'}:${captionStamp(file)}`;
}

// The cached description for a file, or '' when it has none or the file has
// changed since it was written.
export function describedText(file) {
  if (!file?.path) return '';
  const hit = loadStore()[file.path];
  return hit && hit.key === versionKey(file) ? (hit.desc || '') : '';
}

function putDescription(file, desc) {
  const s = loadStore();
  s[file.path] = { key: versionKey(file), desc: String(desc || '').slice(0, DESC_CHARS), at: Date.now() };
  saveStore();
}

// How much of a folder is already described — drives the "first search costs
// more" hint in the UI.
export function indexCoverage(files) {
  let described = 0;
  for (const f of files || []) if (describedText(f)) described += 1;
  return { described, total: (files || []).length };
}

export function clearAiFileIndex() {
  store = {};
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
}

// ── Describing ───────────────────────────────────────────────────────────

function parseDescriptions(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Store whatever came back, matched by the 1-based number we labelled each
// file with. A file the model skipped keeps no entry, so it's retried later
// rather than cached as blank.
function absorb(batch, text) {
  let written = 0;
  for (const item of parseDescriptions(text)) {
    const file = batch[Number(item?.n) - 1];
    const desc = String(item?.d || '').trim();
    if (!file || !desc) continue;
    putDescription(file, desc);
    written += 1;
  }
  return written;
}

// The opening of a file's cached transcript, if it has one. Only what already
// exists is used — indexing never triggers a transcription.
function transcriptExcerpt(file) {
  const cap = captionsFor(file);
  return cap ? cap.text.slice(0, EXCERPT_CHARS).replace(/\s+/g, ' ').trim() : '';
}

// One request describing up to TEXT_BATCH readable files from their excerpts.
async function describeTextBatch(batch, signal) {
  const parts = [];
  for (let i = 0; i < batch.length; i += 1) {
    const file = batch[i];
    if (signal?.aborted) return;
    let excerpt = '';
    if (isContentSearchable(file.name, file.sizeBytes)) {
      excerpt = (await textForFile(file)).slice(0, EXCERPT_CHARS).replace(/\s+/g, ' ').trim();
    }
    // A recording that's been transcribed describes itself far better from what
    // was said than from its filename.
    const spoken = transcriptExcerpt(file);
    parts.push([
      `${i + 1}. ${file.name}${file.mimeType ? ` (${file.mimeType})` : ''}`,
      excerpt && `   text: ${excerpt}`,
      spoken && `   transcript: ${spoken}`,
    ].filter(Boolean).join('\n'));
  }
  if (signal?.aborted) return;
  const res = await askProjectAi({
    messages: [{ role: 'user', content: `${INDEX_SYSTEM}\n\nFiles:\n${parts.join('\n')}` }],
    model: INDEX_MODEL,
    tools: false,
  });
  if (signal?.aborted || res.error) return;
  absorb(batch, res.text);
}

// One request describing up to IMAGE_BATCH pictures/videos. Files whose still
// can't be produced (odd codec, corrupt) fall through to name-only so they
// still get an entry rather than being re-attempted every search.
async function describeImageBatch(batch, signal) {
  const shown = [];
  const blocks = [];
  for (const file of batch) {
    if (signal?.aborted) return;
    const thumb = await encodeVisualThumb(file);
    if (!thumb) continue;
    shown.push(file);
    // A video's still shows the scene; its transcript says what happened in it.
    const spoken = transcriptExcerpt(file);
    blocks.push({ type: 'text', text: `${shown.length}. ${file.name}:${spoken ? `\n   transcript: ${spoken}` : ''}` });
    blocks.push({ type: 'image', source: { type: 'base64', media_type: thumb.media_type, data: thumb.data } });
  }
  if (signal?.aborted) return;
  // Nothing decoded — describe them by name so the batch isn't retried forever.
  if (!shown.length) {
    for (const file of batch) putDescription(file, `${file.name} — ${file.mimeType || 'media file'} (contents could not be read)`);
    return;
  }
  const res = await askProjectAi({
    messages: [{ role: 'user', content: [{ type: 'text', text: `${INDEX_SYSTEM}\n\nEach image below is numbered with its file name.` }, ...blocks] }],
    model: INDEX_MODEL,
    tools: false,
  });
  if (signal?.aborted || res.error) return;
  absorb(shown, res.text);
}

// Describe every file in `files` that has no fresh description. Returns the
// number newly described. `onProgress({ done, total })` fires per batch so the
// UI can show the one-time cost being paid down.
export async function indexFiles(files, { signal, onProgress } = {}) {
  const pending = (files || []).filter((f) => f?.path && !describedText(f)).slice(0, MAX_INDEX_PER_RUN);
  if (!pending.length) return 0;

  // Split by how they have to be read: pictures need a decode + upload, the
  // rest need a text extraction. Mixing them in one batch would put an image
  // request's cost on files that didn't need it.
  const visual = pending.filter((f) => isVisualFile(f.name));
  const textual = pending.filter((f) => !isVisualFile(f.name));

  const batches = [];
  for (let i = 0; i < textual.length; i += TEXT_BATCH) batches.push({ kind: 'text', batch: textual.slice(i, i + TEXT_BATCH) });
  for (let i = 0; i < visual.length; i += IMAGE_BATCH) batches.push({ kind: 'image', batch: visual.slice(i, i + IMAGE_BATCH) });

  const total = pending.length;
  let done = 0;
  onProgress?.({ done, total });

  // Two at a time: enough to hide the latency of a slow PDF extraction without
  // firing a dozen concurrent requests at the function.
  const queue = [...batches];
  const worker = async () => {
    while (queue.length) {
      if (signal?.aborted) return;
      const job = queue.shift();
      try {
        if (job.kind === 'image') await describeImageBatch(job.batch, signal);
        else await describeTextBatch(job.batch, signal);
      } catch { /* a failed batch just stays undescribed and retries next search */ }
      done += job.batch.length;
      if (!signal?.aborted) onProgress?.({ done: Math.min(done, total), total });
    }
  };
  await Promise.all([worker(), worker()]);

  let described = 0;
  for (const f of pending) if (describedText(f)) described += 1;
  return described;
}

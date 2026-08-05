// Background metadata extraction for files as they arrive.
//
// The Doc Viewer's Metadata tab used to be a button you pressed and then
// waited on: extraction re-reads the whole file (a SHA-256 over every byte, a
// ZIP walk for OOXML docProps, a pdf.js parse, a media-duration probe), which
// on a large document is seconds. The result was already cached
// (lib/metadataHistory.js) — but only after you'd paid for it once.
//
// This pays for it up front instead. Whenever a folder is listed, anything
// without a fresh snapshot is extracted quietly in the background, so by the
// time anyone opens the Metadata tab the answer is already on disk. Uploads
// are covered by the same path: writing a file triggers a relist, the relist
// includes the new file, and the new file has no snapshot.
//
// It's all local — nothing here touches the network — but it's still real work
// on the user's machine, so it's deliberately unobtrusive:
//   • one file at a time, started only when the main thread is idle,
//   • files already described (and unchanged) are skipped entirely,
//   • very large files are left for the button, since hashing them would spin
//     a core for seconds to save a click,
//   • a new listing cancels the previous sweep instead of queueing behind it.

import { extractFileMetadata } from './fileMetadata';
import { loadMetadata, saveMetadata } from './metadataHistory';

// Past this we don't pre-hash. The Metadata tab still works on demand — it
// just isn't worth reading a 300MB video end to end on the chance someone
// opens the tab.
const MAX_PREFETCH_BYTES = 128 * 1024 * 1024;

// Between files, so a big folder doesn't hold the main thread for a stretch.
const GAP_MS = 250;

// Paths attempted this session that failed — a corrupt file shouldn't be
// retried on every relist.
const failed = new Set();

let current = null;   // { cancel() } for the sweep in flight

const idle = (fn) => (typeof requestIdleCallback === 'function'
  ? requestIdleCallback(fn, { timeout: 2000 })
  : setTimeout(fn, 200));

function needsExtraction(file) {
  const path = file?.path;
  if (!path || failed.has(path)) return false;
  if (file.sizeBytes != null && file.sizeBytes > MAX_PREFETCH_BYTES) return false;
  return !loadMetadata(path, { size: file.sizeBytes, mtime: file.mtimeIso });
}

// Extract + cache one file. Returns true when a snapshot was written.
async function extractOne(file) {
  try {
    const result = await extractFileMetadata({ name: file.name, path: file.path, mimeType: file.mimeType });
    if (!result?.groups?.length) { failed.add(file.path); return false; }
    saveMetadata(file.path, result, { size: file.sizeBytes, mtime: file.mtimeIso });
    return true;
  } catch {
    failed.add(file.path);
    return false;
  }
}

// Start (or restart) the background sweep for `files`. Returns a cancel
// function; calling it — or starting another sweep — stops the current one
// between files. `onDone(count)` fires with how many snapshots were written.
export function prefetchMetadata(files, { onDone } = {}) {
  current?.cancel();
  const pending = (files || []).filter(needsExtraction);
  if (!pending.length) { current = null; return () => {}; }

  let cancelled = false;
  const cancel = () => { cancelled = true; };
  current = { cancel };

  let written = 0;
  const step = async () => {
    if (cancelled) return;
    const file = pending.shift();
    if (!file) { current = null; onDone?.(written); return; }
    // Re-check: another surface (the Metadata tab itself) may have cached it
    // while this sweep was working through the queue.
    if (needsExtraction(file) && await extractOne(file)) written += 1;
    if (cancelled) return;
    setTimeout(() => idle(step), GAP_MS);
  };
  idle(step);

  return cancel;
}

export function cancelMetadataPrefetch() {
  current?.cancel();
  current = null;
}

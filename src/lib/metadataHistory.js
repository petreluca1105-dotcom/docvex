// Per-file cache of the DocViewer Metadata tab's extraction result. Extracting
// re-reads the file end to end (a SHA-256 over the whole thing, a ZIP walk for
// OOXML docProps, a pdf.js parse, a media-duration probe), which is slow enough
// on a big file to be worth not repeating — so the result is saved to
// localStorage keyed by the file's on-disk path and restored when the tab is
// reopened. One result per file, like lib/captionsHistory.js (the OCR history
// instead keeps a LIST of snippets — see lib/extractionHistory.js).
//
// The cache is keyed by path alone, so an edited file would return stale
// values; `size` and `mtime` are stored alongside for exactly that reason —
// loadMetadata() takes the file's current stat and discards a snapshot that
// doesn't match, rather than serving metadata that no longer describes it.
// Both come straight from localFolderApi.stat: `size` is `sizeBytes`, `mtime`
// is `mtimeIso` (a string compares fine, it's the same field either way).

const KEY_PREFIX = 'docvex:doc-viewer:metadata:';

// Exposed so other surfaces can recognise our keys (e.g. a cache sweep).
export const METADATA_PREFIX = KEY_PREFIX;

function safeRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeWrite(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function safeRemove(key) {
  try { localStorage.removeItem(key); return true; } catch { return false; }
}

// Returns the stored { groups, warnings, extractedAt } | null. Pass the file's
// current { size, mtime } to have a snapshot of a since-changed file rejected;
// omit them and whatever was stored is returned as-is.
export function loadMetadata(filePath, stamp) {
  if (!filePath) return null;
  const raw = safeRead(KEY_PREFIX + filePath);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.groups)) return null;
    // Only compare the fields we actually have on both sides — a caller with
    // no stat info shouldn't invalidate a good snapshot.
    if (stamp) {
      if (stamp.size != null && parsed.size != null && Number(stamp.size) !== Number(parsed.size)) return null;
      if (stamp.mtime != null && parsed.mtime != null && String(stamp.mtime) !== String(parsed.mtime)) return null;
    }
    return {
      groups: parsed.groups,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      extractedAt: parsed.extractedAt || 0,
    };
  } catch {
    return null;
  }
}

export function saveMetadata(filePath, data, stamp) {
  if (!filePath || !data || !Array.isArray(data.groups)) return false;
  return safeWrite(KEY_PREFIX + filePath, JSON.stringify({
    groups: data.groups,
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
    extractedAt: data.extractedAt || Date.now(),
    size: stamp?.size ?? null,
    mtime: stamp?.mtime ?? null,
  }));
}

export function clearMetadata(filePath) {
  if (!filePath) return false;
  return safeRemove(KEY_PREFIX + filePath);
}

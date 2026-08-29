// Per-file cache of the DocViewer AI-advisor conversation (and, for generated
// documents, the version iterations). Saved to localStorage keyed by the file's
// on-disk path so reopening the same file restores the whole thread — matching
// how lib/extractionHistory.js (OCR snippets) and lib/captionsHistory.js (audio
// captions) persist their interactions per file.

const KEY_PREFIX = 'docvex:doc-viewer:conversation:';

// Exposed so other surfaces can recognise our keys (e.g. cross-window `storage`).
export const CONVERSATION_PREFIX = KEY_PREFIX;

function safeRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeWrite(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function safeRemove(key) {
  try { localStorage.removeItem(key); return true; } catch { return false; }
}

// Normalise a file path into a STABLE storage key. The same file can reach us
// with different path text depending on where it came from — the create flow
// (writeFiles result), a later double-click (directory listing), or a
// generate-time rename — which on Windows can differ in separator (\ vs /),
// drive-letter casing, or a trailing slash. Folding those out means a file
// always maps to the same conversation, so reopening it shows the saved chat.
function keyFor(filePath) {
  const norm = String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  return KEY_PREFIX + norm;
}

function parseRecord(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed) return null;
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      versions: Array.isArray(parsed.versions) ? parsed.versions : [],
      // Branch set for the advisor's split conversations; undefined for older
      // records (pre-branching) so the caller falls back to a single "Main".
      branches: Array.isArray(parsed.branches) ? parsed.branches : undefined,
      activeBranchId: parsed.activeBranchId || undefined,
      // Per-paragraph conversations, keyed `para:<indices>`. Each is isolated
      // from the document thread and from every other paragraph's, so reopening
      // a file has to restore them all — not just the one that was on screen.
      paraThreads: (parsed.paraThreads && typeof parsed.paraThreads === 'object'
        && !Array.isArray(parsed.paraThreads)) ? parsed.paraThreads : undefined,
      updatedAt: parsed.updatedAt || 0,
    };
  } catch {
    return null;
  }
}

// Returns { messages: [...], versions: [...], updatedAt } | null.
export function loadConversation(filePath) {
  if (!filePath) return null;
  // Prefer the normalised key; fall back to the legacy raw-path key so chats
  // saved before this normalisation still surface (and get migrated on save).
  return parseRecord(safeRead(keyFor(filePath))) || parseRecord(safeRead(KEY_PREFIX + filePath));
}

export function saveConversation(filePath, { messages, versions, branches, activeBranchId, paraThreads }) {
  if (!filePath) return false;
  const msgs = Array.isArray(messages) ? messages : [];
  const vers = Array.isArray(versions) ? versions : [];
  const brs = Array.isArray(branches) ? branches : null;
  // Drop paragraph threads that never got a message — an empty one is just a
  // paragraph somebody clicked on, not a conversation worth storing.
  const paras = {};
  for (const [k, v] of Object.entries(paraThreads || {})) {
    if (Array.isArray(v) && v.length) paras[k] = v;
  }
  const hasParaContent = Object.keys(paras).length > 0;
  // A thread may live only in a non-active branch, so count branch content too.
  const hasBranchContent = !!brs && brs.some((b) => Array.isArray(b.messages) && b.messages.length);
  // Empty → no-op. We must NOT delete here: the provider's save effect fires on
  // mount with the initial empty thread (before the load effect has populated
  // it), and in React StrictMode that empty save runs BEFORE the load re-reads
  // storage — deleting on empty would wipe the saved chat on every reopen. Use
  // clearConversation() to remove a thread on purpose.
  if (!msgs.length && !vers.length && !hasBranchContent && !hasParaContent) return false;
  const record = { messages: msgs, versions: vers, updatedAt: Date.now() };
  // Persist the branch set (split conversations) + which one is active so
  // reopening the file restores every branch, not just the active thread.
  if (brs) {
    record.branches = brs;
    record.activeBranchId = activeBranchId || undefined;
  }
  if (hasParaContent) record.paraThreads = paras;
  return safeWrite(keyFor(filePath), JSON.stringify(record));
}

export function clearConversation(filePath) {
  if (!filePath) return false;
  safeRemove(KEY_PREFIX + filePath); // legacy raw key, if any
  return safeRemove(keyFor(filePath));
}

// Move a saved conversation from one path to another so the chat FOLLOWS the
// file across a rename or a move (the key is path-derived, so without this the
// thread would be orphaned under the old path). Call this from the rename/move
// handlers. No-op when there's nothing saved or the destination already has a
// thread (don't clobber).
export function migrateConversation(oldPath, newPath) {
  if (!oldPath || !newPath) return false;
  const fromKey = keyFor(oldPath);
  const toKey = keyFor(newPath);
  if (fromKey === toKey) return false;
  const raw = safeRead(fromKey) || safeRead(KEY_PREFIX + oldPath);
  if (!raw) return false;
  if (safeRead(toKey)) return false; // a chat already exists at the destination
  safeWrite(toKey, raw);
  safeRemove(fromKey);
  safeRemove(KEY_PREFIX + oldPath);
  return true;
}

// Migrate every conversation under a folder prefix (used when a FOLDER is
// renamed/moved — all the files inside shift path together).
export function migrateConversationsUnder(oldDir, newDir) {
  if (!oldDir || !newDir) return 0;
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const from = KEY_PREFIX + norm(oldDir) + '/';
  const to = KEY_PREFIX + norm(newDir) + '/';
  let moved = 0;
  let keys;
  try { keys = Object.keys(localStorage); } catch { return 0; }
  keys.forEach((k) => {
    if (!k.startsWith(from)) return;
    const dest = to + k.slice(from.length);
    const raw = safeRead(k);
    if (raw && !safeRead(dest)) { safeWrite(dest, raw); safeRemove(k); moved += 1; }
  });
  return moved;
}

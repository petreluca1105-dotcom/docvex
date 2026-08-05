// Last-known chat thread, per project, so re-entering the Chat tab paints
// instantly instead of showing an empty column while Supabase answers.
//
// `listChatMessages` is a network round-trip, and the tab is one people bounce
// in and out of all day — every visit re-paid it. The thread barely changes
// between two visits a minute apart, so the previous batch is kept on disk and
// rendered immediately; the fetch still runs and replaces it, and the Realtime
// subscription keeps it live from there.
//
// A display cache, not a source of truth. Nothing writes through it and no
// action is taken against a cached row that isn't taken against the live one —
// worst case a message deleted on another device lingers for the half-second
// before the fetch resolves. Bodies are already in this renderer's memory and
// stay on this machine; nothing here reaches the network.

const PREFIX = 'docvex.chat.cache.';
const INDEX_KEY = 'docvex.chat.cache.index';

// Matches listChatMessages' own default page — caching more than the tab loads
// would just be dead weight.
const MAX_MESSAGES = 100;
// How many projects keep a cached thread. Past this the coldest is dropped;
// it only costs that project one uncached open.
const MAX_PROJECTS = 6;

const keyFor = (projectId) => `${PREFIX}${projectId}`;

function readIndex() {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

// Move `projectId` to the front and evict anything past MAX_PROJECTS. Kept in
// its own key so reading one project's thread doesn't mean parsing every
// project's thread.
function touchIndex(projectId) {
  try {
    const next = [projectId, ...readIndex().filter((id) => id !== projectId)];
    for (const stale of next.slice(MAX_PROJECTS)) {
      localStorage.removeItem(keyFor(stale));
    }
    localStorage.setItem(INDEX_KEY, JSON.stringify(next.slice(0, MAX_PROJECTS)));
  } catch { /* quota / private mode */ }
}

export function readCachedChat(projectId) {
  if (!projectId) return [];
  try {
    const raw = localStorage.getItem(keyFor(projectId));
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((m) => m && m.id) : [];
  } catch {
    return [];
  }
}

// Debounced: a busy thread fires a Realtime event per message, and each one
// would otherwise serialise the whole batch to localStorage synchronously on
// the main thread.
let writeTimer = null;
let pending = null;
export function writeCachedChat(projectId, messages) {
  if (!projectId || !Array.isArray(messages)) return;
  pending = { projectId, messages };
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const job = pending;
    pending = null;
    if (!job) return;
    try {
      // Keep the TAIL: the thread renders oldest→newest and the bottom is what
      // anyone actually looks at when they come back.
      localStorage.setItem(keyFor(job.projectId), JSON.stringify(job.messages.slice(-MAX_MESSAGES)));
      touchIndex(job.projectId);
    } catch { /* quota — the tab just waits for the fetch next time */ }
  }, 500);
}

export function clearCachedChat(projectId) {
  try {
    if (projectId) { localStorage.removeItem(keyFor(projectId)); return; }
    for (const id of readIndex()) localStorage.removeItem(keyFor(id));
    localStorage.removeItem(INDEX_KEY);
  } catch { /* ignore */ }
}

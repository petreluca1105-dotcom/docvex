// Last-known project list, per user, so the Hub paints instantly.
//
// `listMyProjects()` is a network round-trip to Supabase, and until it lands
// the Hub has nothing to draw — which on a cold open is a blank grid where the
// user's matters should be. The list barely changes between visits, so the
// previous answer is kept on disk and rendered immediately; the fetch still
// runs and replaces it the moment it returns.
//
// This is a display cache, not a source of truth: it never gates a write, and
// anything acting on a project (open, rename, delete) goes through the live
// row. Worst case a project that was renamed on another machine shows its old
// name for the half-second before the fetch resolves.

const PREFIX = 'docvex.projects.cache.';
// Enough to fill several screens of the Hub; past that the cache stops being
// worth its localStorage footprint.
const MAX_CACHED = 60;

const keyFor = (userId) => `${PREFIX}${userId || '_anonymous'}`;

export function readCachedProjects(userId) {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((p) => p && p.id) : [];
  } catch {
    return [];
  }
}

export function writeCachedProjects(userId, projects) {
  if (!Array.isArray(projects)) return;
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(projects.slice(0, MAX_CACHED)));
  } catch { /* quota / private mode — the Hub just waits for the fetch */ }
}

export function clearCachedProjects(userId) {
  try { localStorage.removeItem(keyFor(userId)); } catch { /* ignore */ }
}

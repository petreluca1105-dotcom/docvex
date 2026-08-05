// Answer cache for AI file search — the second of the two token savings, on
// top of the per-file description index (lib/aiFileIndex.js).
//
// The index makes each search cheap; this makes a REPEATED search free. People
// search the same folder for the same thing constantly — they clear the box,
// navigate away, come back, retype it — and the answer can only have changed
// if the folder changed. So a result is stored against a signature of the
// folder's contents, and any add, delete, rename or edit invalidates every
// answer for that folder at once.
//
// Queries are normalised before they're keyed, so "Car Crash", "car  crash "
// and "car crash" are one entry rather than three.

const KEY = 'docvex:ai-search-answers:v1';
const MAX_ENTRIES = 80;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;   // a week; the signature does the real invalidating

let store = null;

function load() {
  if (store) return store;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    store = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    store = {};
  }
  return store;
}

function persist() {
  try {
    const s = load();
    const keys = Object.keys(s);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => (s[a]?.at || 0) - (s[b]?.at || 0));
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete s[k];
    }
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* quota — session-only cache is still a win */ }
}

// Fold the query's incidental differences away: case, surrounding space, and
// runs of whitespace. Punctuation is kept — "v." and "v" can mean different
// things in a case name.
export function normalizeQuery(q) {
  return String(q || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// djb2 over each file's path and version. Cheap, order-independent (the list is
// sorted first), and changes on any add / remove / rename / edit in the set.
export function folderSignature(files) {
  const parts = (files || [])
    .map((f) => `${f?.path || ''}:${f?.sizeBytes ?? '?'}:${f?.mtimeIso ?? '?'}`)
    .sort();
  let h = 5381;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${parts.length}-${h.toString(36)}`;
}

// Returns the cached [{ path, why }] for this exact (folder, query), or null.
export function readAnswer(signature, query) {
  const hit = load()[`${signature}|${normalizeQuery(query)}`];
  if (!hit || !Array.isArray(hit.hits)) return null;
  if (Date.now() - (hit.at || 0) > TTL_MS) return null;
  return hit.hits;
}

export function writeAnswer(signature, query, hits) {
  const s = load();
  s[`${signature}|${normalizeQuery(query)}`] = {
    at: Date.now(),
    hits: (hits || []).map((h) => ({ path: h.path, why: h.why })),
  };
  persist();
}

export function clearAiSearchAnswers() {
  store = {};
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

// Warm cache for the Hub's project list (/projects).
//
// `listMyProjects()` is several sequential Supabase round-trips, so the Hub
// used to open on an empty frame and fill in a beat later. This module keeps
// the last answer in memory and lets the sidebar start the fetch on HOVER —
// by the time the click lands the rows are usually already here, so the Hub
// paints populated on its very first frame.
//
// Three layers cover the Hub together, cheapest first:
//   1. `projectListCache` (localStorage)  — survives restarts, may be stale.
//   2. this snapshot (memory)             — this session, seconds old.
//   3. `listMyProjects()`                 — the network truth.
// The Hub renders 1 immediately, upgrades to 2 synchronously when present,
// and settles on 3.

import { listMyProjects, PROJECTS_CHANGED_EVENT } from './projects';

// How long a snapshot counts as "good enough to render without refetching".
// Short: the list barely changes, but a stale role/name on a 30s-old open
// would be visible. Anything older still renders instantly from the snapshot,
// it just also kicks off a refresh.
const FRESH_MS = 20000;

let snapshot = null;   // { at, data }
let inflight = null;   // de-dupes concurrent callers (hover + mount)

// The freshest known rows, or null. Synchronous — safe to call from a
// useState initializer so the first paint already has content.
export function peekProjects(maxAge = Infinity) {
  if (!snapshot) return null;
  if (Date.now() - snapshot.at > maxAge) return null;
  return snapshot.data;
}

// Fetch, reusing an in-flight request and skipping the network entirely when
// the snapshot is still fresh. Always resolves `{ data, error }`.
export function fetchProjects({ maxAge = FRESH_MS } = {}) {
  const fresh = peekProjects(maxAge);
  if (fresh) return Promise.resolve({ data: fresh, error: null });
  if (inflight) return inflight;
  inflight = listMyProjects()
    .then((res) => {
      inflight = null;
      if (res?.data && !res.error) snapshot = { at: Date.now(), data: res.data };
      return res;
    })
    .catch((error) => {
      inflight = null;
      return { data: [], error };
    });
  return inflight;
}

// Fire-and-forget warm-up — called from the sidebar's Projects row on hover.
export function prefetchProjects() {
  fetchProjects().catch(() => { /* warm-up only */ });
}

// Drop the snapshot so the next read goes to the network. Called after any
// local mutation and on the app-wide "projects changed" event.
export function invalidateProjects() {
  snapshot = null;
}

// Keep the snapshot in sync with the mutations that publish this event
// (create / delete / leave) — otherwise a freshly-created project wouldn't
// show up until the snapshot aged out.
try {
  window.addEventListener(PROJECTS_CHANGED_EVENT, invalidateProjects);
} catch { /* non-browser context */ }

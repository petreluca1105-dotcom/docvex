import { createClient } from '@supabase/supabase-js';

// Build-time constant set by .env / .env.web. The web build sets
// VITE_TARGET=web; the Electron build leaves it undefined (or 'electron').
// Vite inlines the comparison at build time, so the resulting bundle
// contains only the branch that applies.
const IS_WEB = import.meta.env.VITE_TARGET === 'web';

// A short, unique-per-call suffix for Realtime channel topics. Supabase
// rejects a duplicate-topic subscribe on the same client, and split view can
// mount two subscribers for the same project at once (the primary pane and a
// secondary pane viewing the same project / chat). Appending this keeps each
// subscription's channel name distinct.
export function realtimeSuffix() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

// Per-WINDOW auth lock, replacing supabase-js's default.
//
// GoTrueClient picks `navigatorLock` whenever it sees `navigator.locks` — which
// every Electron renderer has. Web Locks are held per ORIGIN, not per window,
// so every DocVex window's auth client contends for the same
// `lock:sb-<ref>-auth-token`: the sign-in window, the app window, each open Doc
// Viewer. An auth call in one window then waits on a token refresh in another,
// and since the app window now stays alive (hidden) behind the sign-in window,
// that contention is constant rather than occasional. It shows up as OAuth
// working most of the time and silently hanging the rest — whichever way the
// race fell.
//
// This serialises auth operations within a window and lets windows proceed
// independently, which is what Supabase's own `processLock` does for
// non-single-tab environments. Written out rather than imported because
// `processLock` lives in @supabase/auth-js, which we depend on only
// transitively.
const authLockChain = new Map();   // lock name → tail of the queue
function windowAuthLock(name, _acquireTimeout, fn) {
  const prev = authLockChain.get(name) || Promise.resolve();
  // Run whether the previous holder resolved or rejected — a failed auth call
  // must not wedge the queue behind it.
  const run = prev.then(fn, fn);
  authLockChain.set(name, run.then(() => {}, () => {}));
  return run;
}

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      // PKCE returns `?code=...` to the redirect URL; the renderer exchanges it
      // for a session. Avoids the implicit flow's `#access_token=...` fragment,
      // which is awkward to parse from a custom-scheme callback.
      flowType: 'pkce',
      // Electron: the callback is a docvex:// URL the renderer never sees in
      //   window.location — AuthContext drives exchangeCodeForSession itself
      //   after the deep-link handler fires.
      // Web: the callback IS the URL the browser navigates to
      //   (/app/auth/callback?code=…), so let supabase-js auto-detect and
      //   exchange it before any React effect runs.
      detectSessionInUrl: IS_WEB,
      // See windowAuthLock above — must not be the cross-window Web Lock.
      lock: windowAuthLock,
    },
  }
);

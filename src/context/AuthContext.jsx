import React, { createContext, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { isNotificationsStorageKey } from '../lib/notifications';
import { isActivityStorageKey } from '../lib/activityLog';
import { deleteAllForUser as deleteAllNotificationsForUser } from '../lib/notificationsRepo';
import { sendWelcomeEmail } from '../lib/sendWelcome';
import { PENDING_INVITE_TOKEN_KEY } from '../pages/Projects/InviteAccept';
import {
  isElectron,
  onDeepLink,
  getStartupDeepLink,
  onAccountSwitch,
  openOAuthUrl,
  quitApp,
} from '../lib/platform';

// Pick the OAuth callback URL based on which build is running. Electron
// uses the custom protocol the OS routes to main; web uses an HTTPS path
// on whichever origin the page is served from (production: docvex.ro/app,
// dev: localhost:5174/app). Kept as a function so it picks up the current
// origin at the time of the OAuth click rather than module-eval time.
//
// Web: we redirect to `/app/` (the SPA's root, which is a real file:
// docs/demo/index.html). Avoids needing GitHub Pages SPA-fallback magic
// just for OAuth — the page loads, supabase-js's detectSessionInUrl
// auto-exchanges the `?code=…` query param, then strips it from the URL
// via history.replaceState. React Router then routes `/` → Dashboard.
function getOAuthRedirectUrl() {
  if (isElectron) return 'docvex://auth/callback';
  return `${window.location.origin}/demo/`;
}

// Which window started an OAuth flow. sessionStorage is per-window in Electron
// (localStorage is shared), so this is exactly "did I open the browser?" —
// the question that decides who gets to spend the single-use auth code.
const OAUTH_INITIATOR_KEY = 'docvex.oauth.initiator';
// How long a non-initiating window waits before assuming nobody is coming.
// Long enough to cover the exchange round-trip, short enough that a cold-start
// deep link doesn't feel stuck.
const OAUTH_BACKSTOP_MS = 1500;

function markOAuthInitiator() {
  try { sessionStorage.setItem(OAUTH_INITIATOR_KEY, '1'); } catch { /* ignore */ }
}
// One-shot: reading it clears it, so a second callback can't be claimed by a
// window that already spent its turn.
function consumeOAuthInitiator() {
  try {
    if (sessionStorage.getItem(OAUTH_INITIATOR_KEY) !== '1') return false;
    sessionStorage.removeItem(OAUTH_INITIATOR_KEY);
    return true;
  } catch {
    return false;
  }
}

// A safe, fully-shaped fallback so consumers never crash on a null context.
// This is read in two situations: (1) a component rendered outside AuthProvider
// (a real bug — but it degrades to "still loading" instead of white-screening),
// and (2) a Vite Fast Refresh remount where a consumer momentarily reads the
// context's default value before the provider re-binds. `loading: true` keeps
// auth-gated UI in its loading state until the real provider takes over; the
// methods are async no-ops so an accidental call mid-HMR doesn't throw.
const noop = async () => {};
const AUTH_FALLBACK = {
  session: null,
  loading: true,
  lastAuthEvent: null,
  signInWithEmail: noop,
  signUpWithEmail: noop,
  signInWithGoogle: noop,
  linkGoogle: noop,
  setPassword: noop,
  signOut: noop,
  logout: noop,
  eraseData: noop,
  deleteAccount: noop,
};

const AuthContext = createContext(AUTH_FALLBACK);

export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  // Latest (event, session) tuple from onAuthStateChange. Consumers like the
  // notifications source-hook read this instead of subscribing to Supabase a
  // second time — one stream, one source of truth.
  // event ∈ INITIAL_SESSION | SIGNED_IN | SIGNED_OUT | TOKEN_REFRESHED | USER_UPDATED | …
  const [lastAuthEvent, setLastAuthEvent] = useState(null);

  useEffect(() => {
    // Subscribe FIRST. supabase-js v2 fires an INITIAL_SESSION event on
    // attach with the persisted (or null) session, which replaces the
    // explicit getSession() bootstrap the older code used to await. The
    // pre-refactor sequential pattern (getSession → subscribe) meant the
    // subscription's INITIAL_SESSION fired with the same data the getSession
    // had just returned — a redundant double set.
    //
    // We also fire a parallel getSession() as a belt-and-suspenders safety
    // net (see bootstrappedRef below). If INITIAL_SESSION fires first (the
    // documented behaviour), the parallel getSession's .then becomes a no-op.
    // If it ever doesn't fire (StrictMode quirks, future SDK regression), the
    // getSession path still clears the loading state so the app doesn't hang
    // on a spinner.
    const bootstrappedRef = { current: false };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      // Tag with `at` so a downstream effect can detect repeated events of the
      // same name (e.g. two TOKEN_REFRESHED in a row would otherwise look like
      // a no-op via reference equality).
      setLastAuthEvent({ event, session, at: Date.now() });

      if (event === 'INITIAL_SESSION') {
        bootstrappedRef.current = true;
        setLoading(false);
      }

      // Auto-resume a pending invite-accept after the user signs in. The
      // token is stashed by InviteAccept's signed-out branch (or by the
      // email-mismatch "Sign out & switch account" path) before redirecting
      // to /auth — see PENDING_INVITE_TOKEN_KEY in InviteAccept.jsx.
      if (event === 'SIGNED_IN') {
        try {
          const pending = sessionStorage.getItem(PENDING_INVITE_TOKEN_KEY);
          if (pending) {
            sessionStorage.removeItem(PENDING_INVITE_TOKEN_KEY);
            navigate(`/invite/${pending}`, { replace: true });
          }
        } catch { /* sessionStorage may be unavailable; non-fatal */ }

        // Welcome email — sent exactly once per account, on the first
        // SIGNED_IN where `user_metadata.welcome_email_sent` is missing.
        // The flag lives on auth.users.raw_user_meta_data so it survives
        // device switches and reinstalls. Fire-and-forget; never blocks
        // the sign-in UX. On send failure the flag stays unset and the
        // next sign-in retries.
        if (session?.user && !session.user.user_metadata?.welcome_email_sent) {
          (async () => {
            try {
              const { error } = await sendWelcomeEmail();
              if (error) {
                console.warn('[auth] welcome email failed', error);
                return;
              }
              const { error: updErr } = await supabase.auth.updateUser({
                data: { welcome_email_sent: true },
              });
              if (updErr) {
                // The send succeeded but the flag write failed — the
                // next sign-in will try to resend. Log so a recurring
                // duplicate is debuggable.
                console.warn('[auth] welcome_email_sent flag write failed', updErr);
              }
            } catch (err) {
              console.warn('[auth] welcome email crashed', err);
            }
          })();
        }
      }
    });

    // Safety net: if INITIAL_SESSION hasn't fired by the time getSession
    // resolves, fall back to its result. Skipped entirely when the
    // subscription already handled the bootstrap.
    supabase.auth.getSession()
      .then(({ data: { session: bootstrapSession } }) => {
        if (bootstrappedRef.current) return;
        bootstrappedRef.current = true;
        setSession(bootstrapSession);
        setLoading(false);
      })
      .catch(() => {
        if (bootstrappedRef.current) return;
        bootstrappedRef.current = true;
        setLoading(false);
      });

    // The `oauth:callback-url` IPC channel was originally OAuth-only, but
    // main.js routes every docvex:// URL through it — so this is really an
    // "OS handed us a deep-link URL" handler. We branch on the URL shape:
    //   docvex://auth/callback?code=…       → OAuth code exchange
    //   docvex://invite?token=…             → navigate to /invite/<token>
    // Other shapes fall through with a console.warn — useful when adding
    // new deep-link routes (you'll see exactly what got through unhandled).
    const handleDeepLinkUrl = async (url) => {
      let parsed;
      try { parsed = new URL(url); }
      catch { return; }

      // For docvex://invite?token=… the URL parser puts "invite" in the
      // hostname (no path) and "?token=…" in the search; for docvex:// links
      // with paths like docvex://auth/callback?code=… the hostname is "auth"
      // and the pathname is "/callback". Normalising on `parsed.host` lets us
      // route either shape with the same logic.
      const host = (parsed.host || parsed.hostname || '').toLowerCase();

      if (host === 'invite') {
        const token = parsed.searchParams.get('token');
        if (token) {
          navigate(`/invite/${encodeURIComponent(token)}`);
        }
        return;
      }

      // docvex://mail/callback?provider=…&code=… — the Mail tab's mailbox OAuth.
      // NOT a Supabase auth code: re-broadcast it as a window event for the Mail
      // page to consume (which owns the mail-sync `connect` exchange). Returning
      // here is critical — otherwise the generic code-exchange below would feed a
      // Gmail/Graph code into supabase.auth.exchangeCodeForSession and corrupt
      // the user's session.
      if (host === 'mail') {
        window.dispatchEvent(new CustomEvent('docvex:mail-callback', { detail: url }));
        return;
      }

      // OAuth callback (default / legacy path).
      //
      // Main sends the callback to EVERY app window, because it can't know
      // which one started the flow (see sendDeepLink in main.js). An auth code
      // is single-use, though, so if two windows exchange it at once one of
      // them loses — and the loser is left with no session, which is the whole
      // sign-in silently failing about half the time.
      //
      // So exactly one window acts: the one that started the flow. It marks
      // itself in sessionStorage, which in Electron is per-window (unlike
      // localStorage, which every window shares).
      const code = parsed.searchParams.get('code');
      if (!code) return;
      if (consumeOAuthInitiator()) {
        await supabase.auth.exchangeCodeForSession(code);
        return;
      }
      // Not the initiator. Stand down — but not forever: on a cold start the
      // OS hands the callback to an app that was never running, so NO window
      // initiated it and somebody has to. Give the real initiator a beat, then
      // exchange only if no session has appeared.
      await new Promise((r) => setTimeout(r, OAUTH_BACKSTOP_MS));
      const { data } = await supabase.auth.getSession();
      if (!data?.session) await supabase.auth.exchangeCodeForSession(code);
    };

    // Subscribe to deep-link URLs the OS routes back to the app. On web
    // the adapter returns a no-op unsubscribe — deep links on web arrive
    // as browser navigations and are handled by BrowserRouter.
    const unsubscribeDeepLink = onDeepLink(handleDeepLinkUrl);

    // Pull any docvex:// URL that arrived on the command line at COLD
    // start — the `oauth:callback-url` event fires only on subsequent
    // launches (via second-instance), so a fresh first launch with a URL
    // in argv would otherwise drop it. Safe to call when nothing is
    // pending: the adapter returns null on web and main returns null on
    // Electron when nothing is queued. The handle is one-shot on the main
    // side, so a StrictMode double-mount can't process the same URL twice.
    getStartupDeepLink().then((url) => {
      if (url) handleDeepLinkUrl(url);
    });

    // Dev-only "Account" menu wiring. On web this is a no-op (no native
    // menu). On Electron the menu item's click handler in main.js sends
    // { email, password? } here; we sign out of the current session,
    // stash the credentials so AuthPage can prefill them on the next
    // render, and hard-reload so every in-memory context (project,
    // notifications, selected project) drops its previous-user data
    // instead of leaking it into the next session.
    const unsubscribeAccountSwitch = onAccountSwitch(async (payload) => {
      // Tolerate the older string-only payload shape for forward-compat
      // during dev: { email, password } today, or just an email string
      // if someone hand-fires the IPC.
      const email = typeof payload === 'string' ? payload : payload?.email;
      const password = typeof payload === 'object' ? payload?.password : null;
      if (!email) return;
      try {
        sessionStorage.setItem('docvex.prefillEmail', email);
        if (password) {
          sessionStorage.setItem('docvex.prefillPassword', password);
        } else {
          sessionStorage.removeItem('docvex.prefillPassword');
        }
      } catch { /* private mode */ }
      // Best-effort sign-out before the reload — even if it errors
      // (offline, expired token), the reload clears in-memory state
      // and supabase-js will treat the next mount as signed-out.
      try { await supabase.auth.signOut(); } catch { /* non-fatal */ }
      window.location.reload();
    });

    return () => {
      subscription.unsubscribe();
      unsubscribeDeepLink();
      unsubscribeAccountSwitch();
    };
  }, [navigate]);

  const signInWithEmail = (email, password) =>
    supabase.auth.signInWithPassword({ email, password });

  // `meta`, when present, is written to auth.users.raw_user_meta_data via
  // signUp's options.data — the onboarding flow passes { full_name, firm,
  // newsletter_opt_in } so the profile + newsletter preference survive the
  // email-confirmation round-trip. Backward compatible: the 2-arg call shape
  // (email, password) still works for any caller that doesn't onboard.
  const signUpWithEmail = (email, password, meta) =>
    supabase.auth.signUp(
      meta ? { email, password, options: { data: meta } } : { email, password },
    );

  const signInWithGoogle = async () => {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: getOAuthRedirectUrl(),
        // Electron: hand the URL off to the OS browser ourselves so the
        // OAuth tab doesn't open inside the BrowserWindow.
        // Web: let supabase-js do the full-page redirect — that's the
        // standard browser OAuth flow and lets detectSessionInUrl pick
        // up the response on /demo/auth/callback.
        skipBrowserRedirect: isElectron,
      },
    });
    if (error) throw error;
    // On Electron we get a URL back to open externally. On web supabase-js
    // has already navigated by this point.
    if (data?.url && isElectron) {
      // Claim the callback before the browser opens: this window holds the
      // PKCE verifier and is the one that should spend the auth code when it
      // comes back (see handleDeepLinkUrl).
      markOAuthInitiator();
      openOAuthUrl(data.url);
    }
  };

  // Link a Google identity to the CURRENT signed-in account (vs. signing in
  // a brand-new account). Used by the "Google" pill on the Account page
  // when the user hasn't already linked Google. The OAuth round-trip uses
  // the same docvex://auth/callback handler as sign-in — the existing
  // handleDeepLinkUrl above runs exchangeCodeForSession on the returned
  // code, which Supabase resolves into the link rather than a fresh
  // session because the caller still has a valid one.
  //
  // Caveat: requires "Allow account linking" enabled in Supabase Auth
  // settings (Dashboard → Authentication → Sign In / Up → Manual Linking).
  // Without it the call returns a "Manual linking is disabled" error.
  const linkGoogle = async () => {
    const { data, error } = await supabase.auth.linkIdentity({
      provider: 'google',
      options: {
        redirectTo: getOAuthRedirectUrl(),
        skipBrowserRedirect: isElectron,
      },
    });
    if (error) throw error;
    if (data?.url && isElectron) {
      // Same claim as sign-in: this window holds the verifier, so it exchanges.
      markOAuthInitiator();
      openOAuthUrl(data.url);
    }
  };

  // Set or change the password on the currently signed-in account.
  // Wraps supabase.auth.updateUser({ password }) so callers don't have
  // to import the supabase client directly.
  //
  // Use case: a user who originally signed up via Google OAuth wants to
  // ALSO be able to sign in with email + password (e.g. when Google
  // sign-in is unavailable or they want a fallback). Calling this with
  // a password on a Google-only account creates the email identity
  // server-side, so the next visit to user.identities will include a
  // `provider: 'email'` entry alongside the existing `provider: 'google'`.
  //
  // Returns the raw `{ data, error }` from updateUser so the caller can
  // distinguish "wrong format" / "too short" / "rate limited" responses.
  // The session itself doesn't change — supabase-js emits USER_UPDATED
  // which flows through onAuthStateChange and re-renders consumers with
  // the fresh identity list.
  const setPassword = (password) =>
    supabase.auth.updateUser({ password });

  const signOut = () => supabase.auth.signOut();

  // Deliberate logout from the UI (TitleBar dropdown / Account page). Clears the
  // local session, then quits the whole app so no signed-in state lingers in any
  // window. Distinct from the plain signOut() used by the dev account-switch and
  // the invite email-mismatch flow, which sign out only to reopen /auth in the
  // same window — those must NOT quit. We await signOut (it clears local storage
  // even if the network revoke fails) before quitting so the next launch is
  // genuinely signed out. quitApp() is a no-op on web, so logout there just
  // signs out and the caller's navigation takes over.
  const logout = async () => {
    try { await signOut(); } catch { /* local session still cleared; quit anyway */ }
    quitApp();
  };

  // Permanently delete the user's account (auth.users row + cascade-linked
  // data — project memberships, notifications). Goes through the
  // `delete-user` Edge Function because admin.auth.deleteUser requires the
  // service-role key, which the renderer must never see. On success we
  // also call signOut to flush the (now-invalid) local session; the
  // caller is responsible for navigating away from authenticated screens.
  //
  // Returns { error: null } on success or { error } from either the
  // function call or the local sign-out leg. On a non-2xx from the
  // function, we try to parse `{ error, detail }` out of the response body
  // so the caller's toast shows the actual reason ("delete_failed:
  // foreign key violation on …") instead of supabase-js's generic
  // "Edge Function returned a non-2xx status code" message.
  const deleteAccount = async () => {
    const { data, error: invokeErr } = await supabase.functions.invoke('delete-user', { body: {} });
    if (invokeErr) {
      // FunctionsHttpError carries the response on .context — read the
      // body once and synthesize a clearer Error. Wrap in try/catch in case
      // the body is empty / non-JSON.
      try {
        const ctx = invokeErr.context;
        if (ctx && typeof ctx.json === 'function') {
          const body = await ctx.json();
          if (body && (body.error || body.detail)) {
            const msg = body.detail
              ? `${body.error || 'function_error'}: ${body.detail}`
              : body.error;
            return { error: new Error(msg) };
          }
        }
      } catch { /* fall through to the raw invoke error */ }
      return { error: invokeErr };
    }
    if (data && data.error) return { error: new Error(data.error) };
    // Best-effort sign-out — the server-side delete already invalidated
    // the token, so signOut may itself error; not fatal for the caller.
    try { await supabase.auth.signOut(); } catch { /* non-fatal */ }
    return { error: null };
  };

  // Revoke every refresh token for this user (all devices) and wipe any
  // supabase-persisted state from this machine. Distinct from signOut, which
  // only ends the current device's session. Also deletes the user's
  // notifications from Supabase — "erase" means erase, not just sign out.
  const eraseData = async () => {
    // Delete server-side rows BEFORE signOut while we still have a valid
    // session (RLS would reject the delete otherwise). Non-fatal: if the
    // network is down we still proceed with the local wipe so the user's
    // device-side state matches their intent.
    const uid = session?.user?.id;
    if (uid) {
      try { await deleteAllNotificationsForUser(uid); }
      catch { /* non-fatal — local wipe still runs */ }
    }
    const { error } = await supabase.auth.signOut({ scope: 'global' });
    try {
      Object.keys(localStorage)
        .filter((k) => (
          k.startsWith('sb-')
          || k.startsWith('supabase.')
          || isNotificationsStorageKey(k)
          || isActivityStorageKey(k)
          // Phase 2 client-side state — pendingChanges queue,
          // lastSeenMainVersion cursor, and the migration marker
          // that gates the one-time DB → localStorage sweep. These
          // are user-scoped (keyed by uid) so "erase" should wipe
          // them along with the supabase session state. Without
          // this filter, a user who signed out and another user
          // who signed in on the same machine would inherit the
          // first user's queued renames.
          || k.startsWith('docvex:pending-changes:')
          || k.startsWith('docvex:last-seen-main-version:')
          || k.startsWith('docvex:branch-changes-migrated:')
        ))
        .forEach((k) => localStorage.removeItem(k));
    } catch {
      /* localStorage may be unavailable in some contexts; non-fatal */
    }
    return { error };
  };

  return (
    <AuthContext.Provider value={{ session, loading, lastAuthEvent, signInWithEmail, signUpWithEmail, signInWithGoogle, linkGoogle, setPassword, signOut, logout, eraseData, deleteAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  // `?? AUTH_FALLBACK` guards the one case createContext's default can't: if an
  // older provider higher up still passes an explicit `null` value through a
  // stale module instance during HMR, useContext returns that null, not the
  // default. Coalescing here means useAuth() is never null for any consumer.
  return useContext(AuthContext) ?? AUTH_FALLBACK;
}

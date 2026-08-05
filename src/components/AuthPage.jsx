import React, { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { isElectron, isAuthWindow, authCompleted, authRequired } from '../lib/platform';
import { useAuthFlow } from './auth/useAuthFlow';
import AuthCabinet from './auth/AuthCabinet';
import './AuthPage.css';
import './auth/authCabinet.css';

// One-shot read of the prefill credentials written by AuthContext when the
// user triggered the "Switch to <email>" menu item. Done eagerly during the
// initial render (via useState's init fn) so we never miss them; the storage
// keys are cleared immediately so a manual reload or a sign-out-and-back-in
// doesn't replay stale values. `password` is '' when the menu item only
// carried an email.
function consumePrefillCreds() {
  try {
    const email = sessionStorage.getItem('docvex.prefillEmail') || '';
    const password = sessionStorage.getItem('docvex.prefillPassword') || '';
    if (email) sessionStorage.removeItem('docvex.prefillEmail');
    if (password) sessionStorage.removeItem('docvex.prefillPassword');
    return { email, password };
  } catch {
    return { email: '', password: '' };
  }
}

// The logged-out screen — "The Cabinet" treatment from the "Auth Screens"
// design handoff: split brand panel beside the sign-in / 3-step onboarding form.
export default function AuthPage() {
  const { session } = useAuth();
  // useState init fn runs once on mount, so the storage read + clear happens
  // in the same tick the page first renders.
  const [prefilled] = useState(consumePrefillCreds);
  const flow = useAuthFlow(prefilled);

  // Latest session, reachable from the unmount cleanup without re-running the
  // effect on every auth event.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const signedIn = !!session && !session.user?.is_anonymous;

  // In the dedicated sign-in window, a session means the job is done: tell the
  // main process to bring the app window forward and close this one. (This page
  // used to reshape the APP window into a login box and back again — which is
  // why every launch through sign-in came back at the wrong size. Two surfaces,
  // two windows now.)
  useEffect(() => {
    if (isAuthWindow && signedIn) authCompleted();
  }, [signedIn]);

  // Reached inside the APP window while signed out — normally invisible, since
  // the app window stays hidden until there's a session. It's the fallback for
  // anyone who does get here (a stray navigation, a window shown by the tray):
  // point them at the real sign-in window rather than drawing a second copy of
  // the Cabinet in a window that isn't meant to be showing one.
  if (isElectron && !isAuthWindow && !signedIn) {
    return (
      <div className="auth-page auth-handoff">
        <p className="auth-handoff-text">Sign in to continue.</p>
        <button type="button" className="auth-handoff-btn" onClick={authRequired}>
          Open sign-in
        </button>
      </div>
    );
  }

  // Once AuthContext has a session (email sign-in resolves, or the OAuth
  // callback completes exchangeCodeForSession), bounce out of /auth onto the
  // Hub — the app's default landing (matches the cold-launch route).
  // An ANONYMOUS session (the web build's demo sign-in) does NOT bounce:
  // this page is exactly where an anonymous visitor upgrades to a real
  // account, so it must stay reachable while one is active. The sign-in window
  // doesn't navigate at all — it's closing.
  if (signedIn && !isAuthWindow) {
    return <Navigate to="/projects" replace />;
  }

  return (
    <div className="auth-page">
      {/* Ambient dot grid only (.auth-page::before). The window-wide cursor
          spotlight that used to sit here was removed: the Cabinet already
          paints a contained one on its brand panel, and running two
          pointer-driven radial gradients over the whole window made the
          sign-in screen feel heavy. */}
      <AuthCabinet flow={flow} />
    </div>
  );
}

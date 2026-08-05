import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { isElectron, authAppReady, authRequired } from '../lib/platform';

// Decides which of the two windows the user should be looking at.
//
// The app window boots HIDDEN (main.js createWindow) and stays that way until
// this reports a session. Signed in → the app window reveals itself in the size
// and mode it was last closed in. Signed out → it stays hidden and the
// dedicated sign-in window comes up in front of it. That's the whole reason the
// app window no longer shrinks itself into a login box: the two surfaces are
// two windows, not one window wearing two shapes.
//
// Renders nothing. Mounted once, in the app window only (renderer.jsx) — the
// sign-in window reports its own completion from AuthPage, and the doc viewer /
// tray / snip windows have no say in this at all.
export default function AuthWindowGate() {
  const { session, loading } = useAuth();
  // Only the transitions matter. Re-sending 'app-ready' on every token refresh
  // would re-focus the window out from under whatever the user is doing.
  const lastSent = useRef(null);

  useEffect(() => {
    if (!isElectron || loading) return;
    // An anonymous session (the web build's demo sign-in) is not a signed-in
    // user; it never reaches this window, but treat it as signed out anyway so
    // the two builds can't disagree about what a session means.
    const signedIn = !!session && !session.user?.is_anonymous;
    const next = signedIn ? 'app' : 'auth';
    if (lastSent.current === next) return;
    lastSent.current = next;
    if (signedIn) authAppReady();
    else authRequired();
  }, [session, loading]);

  return null;
}

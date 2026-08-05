import './index.css';
import './styles/tokens.css';
import './styles/miniHeader.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { AppPrefsProvider } from './context/AppPrefsContext';
import { UpdatesProvider } from './context/UpdatesContext';
import { NotificationsProvider } from './context/NotificationsContext';
import { SelectedProjectProvider } from './context/SelectedProjectContext';
import { ChatUnreadProvider } from './context/ChatUnreadContext';
import NotificationCenter from './components/NotificationCenter';
import AuthWindowGate from './components/AuthWindowGate';
import { isElectron, isMac } from './lib/platform';
import App from './App';

// Document-viewer windows (opened from the Files page) boot straight into the
// full-screen /doc-viewer route, carrying the file's path/name/mime through.
// Tray "Extract text" overlay windows boot into /snip with the frozen
// screenshot's path. Every other window is the main app.
const launchParams = new URLSearchParams(window.location.search);
const isDocViewer = launchParams.get('docViewer') === '1';
// The dedicated sign-in window (main.js openAuthWindow) — the same renderer
// booted straight into /auth at the Cabinet's fixed size. The app window is
// never reshaped into a login box any more.
const isAuthWindow = launchParams.get('authWindow') === '1';
const isSnip = launchParams.get('snip') === '1';
const isSnipPanel = launchParams.get('snipPanel') === '1';
const isSnipCountdown = launchParams.get('snipCountdown') === '1';
// The app-drawn system-tray menu (main.js anchors it to the tray icon).
const isTrayMenu = launchParams.get('trayMenu') === '1';
// Only the main app window shows notification toasts / runs the notification
// source hooks — aux windows (Doc Viewer, snip overlay, snip launcher,
// countdown) must not pop toasts over their own surfaces.
const isMainWindow = !isDocViewer && !isSnip && !isSnipPanel && !isSnipCountdown && !isTrayMenu && !isAuthWindow;

// The Snipping-Tool launcher panel and the delayed-capture countdown ride in
// TRANSPARENT windows (their cards paint themselves; everything else must
// stay invisible). Flag the document before first paint so index.css drops
// the opaque page background before anything renders.
if (isSnipPanel) document.documentElement.classList.add('is-snip-panel');
if (isSnipCountdown) document.documentElement.classList.add('is-snip-countdown');
// Same deal for the tray menu — only its card paints.
if (isTrayMenu) document.documentElement.classList.add('is-tray-menu');

// Frameless Electron build draws a custom title bar — flag the document
// BEFORE first paint so the layout reserves --titlebar-h (no startup shift).
// Web keeps the browser chrome and skips this. The tray "Extract text"
// overlay is chromeless edge-to-edge (the frozen screenshot must fill the
// display exactly), so it skips the reservation too — as do the launcher
// panel (it draws its own mini title bar) and the countdown badge.
if (isElectron && !isSnip && !isSnipPanel && !isSnipCountdown && !isTrayMenu) {
  document.documentElement.classList.add('with-titlebar');
  // macOS keeps the native traffic-light buttons (titleBarStyle:'hidden' in
  // main.js) floating over our bar, so the title bar insets its brand to clear
  // them and hides its own window controls. Flag it before first paint too.
  if (isMac) document.documentElement.classList.add('is-mac');
}
const initialEntries = isAuthWindow
  ? ['/auth']
  : isDocViewer
  ? [`/doc-viewer?${launchParams.toString()}`]
  : isTrayMenu
  ? [`/tray-menu?${launchParams.toString()}`]
  : isSnipCountdown
    ? [`/snip-countdown?${launchParams.toString()}`]
    : isSnipPanel
      ? [`/snip-panel?${launchParams.toString()}`]
      : isSnip
        ? [`/snip?${launchParams.toString()}`]
        // Main window boots straight into the project's Files tab — the tab
        // people actually work in. (Signed out, ProtectedRoute bounces to
        // /auth; with no project selected, the page shows its "pick a project"
        // CTA.) The Activity feed stays one click away on the sidebar's "/".
        : ['/files'];

// Provider order:
//   AuthProvider                — session
//   ThemeProvider               — needs Auth (per-user theme localStorage key);
//                                 sits OUTSIDE the rest so the data-theme
//                                 attribute on <html> is set before any other
//                                 provider's children render (avoids a paint
//                                 with the wrong tokens).
//   SelectedProjectProvider     — needs AuthContext (per-user storage key + auto-clear)
//   UpdatesProvider             — independent
//   NotificationsProvider       — needs Auth + Updates via its source hooks.
//                                 NotificationCenter renders inside it (toast
//                                 stack at z 9999).
//   ChatUnreadProvider          — chat unread badges.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={initialEntries}>
      <AuthProvider>
        {/* Signed in → reveal the app window; signed out → hide it and raise
            the dedicated sign-in window. App window only. */}
        {isMainWindow && <AuthWindowGate />}
        <ThemeProvider>
          <AppPrefsProvider>
            <SelectedProjectProvider>
              <UpdatesProvider>
                {/* Aux windows (Doc Viewer / snip overlay / snip launcher)
                    restore the cached session on boot — suppress the source
                    hooks there so "Signed in as …" only toasts in the main
                    window, and don't mount the toast stack at all: toasts
                    render ONLY in the main window. */}
                <NotificationsProvider sourcesEnabled={isMainWindow}>
                  <ChatUnreadProvider>
                    <App />
                  </ChatUnreadProvider>
                  {isMainWindow && <NotificationCenter />}
                </NotificationsProvider>
              </UpdatesProvider>
            </SelectedProjectProvider>
          </AppPrefsProvider>
        </ThemeProvider>
      </AuthProvider>
    </MemoryRouter>
  </React.StrictMode>
);

// Platform adapter — the single module that knows which environment the app
// is running in. Every Electron capability the renderer would otherwise pull
// from `window.electronAPI` (see src/preload.js) goes through here, with a
// web fallback for each entry point. The rest of the app imports from this
// module; nothing else touches `window.electronAPI` directly.
//
// Two flags expose the environment:
//   - `isElectron` — runtime feature detection (presence of window.electronAPI).
//     Use this for runtime branching where the answer might differ from
//     what the build was targeting (e.g. a future "test under web entry
//     during Electron dev" scenario).
//   - `isWebBuild`  — build-time constant from import.meta.env.VITE_TARGET.
//     Use this for code that should be tree-shaken in one build (e.g. a
//     dynamic import of an Electron-only module).
//
// Today these are equivalent in practice; the distinction exists so that
// callers can pick the right semantic.

import { BASE_APP_ZOOM } from './appZoom';

const electronAPI =
  typeof window !== 'undefined' && window.electronAPI ? window.electronAPI : null;

export const isElectron = !!electronAPI;
export const isWebBuild = import.meta.env.VITE_TARGET === 'web';

// Web build served from localhost — gates dev-only conveniences (the Debug
// tab, the demo seed-files button) in the BUILT web app, where
// import.meta.env.DEV is false.
export const isLocalhostWeb = !isElectron
  && typeof window !== 'undefined'
  && ['localhost', '127.0.0.1'].includes(window.location.hostname);

// Synchronous OS guess from the userAgent — available before first paint (the
// async getPlatformInfo() IPC isn't). Electron's renderer userAgent always
// reports "Macintosh; Intel Mac OS X" on macOS (both Intel and Apple Silicon),
// so a substring test is reliable. Drives the macOS title-bar layout: the
// native traffic-light buttons replace the custom window controls, so the bar
// insets its brand and hides its own min/max/close on Mac.
export const isMac =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent || '');

// True in auxiliary windows — Doc Viewer (?docViewer=1) and the tray
// "Extract text" windows (?snip / ?snipPanel / ?snipCountdown). These share
// the renderer bundle with the main app window, but they must NOT each pay
// for the main window's background infrastructure (project-files prefetch,
// notifications history fetch + Realtime channel, chat-unread channel,
// GitHub releases fetch): with several viewer windows open at once those
// duplicated fetches, sockets, and folder scans multiply into real lag.
// Contexts consult this flag to skip their background work in aux windows;
// the main window (no marker param) keeps full behaviour.
export const isAuxWindow =
  typeof window !== 'undefined' &&
  (() => {
    try {
      const q = new URLSearchParams(window.location.search);
      return ['docViewer', 'snip', 'snipPanel', 'snipCountdown', 'trayMenu'].some((k) => q.get(k) === '1');
    } catch {
      return false;
    }
  })();

// ── App metadata ──────────────────────────────────────────────────────────

// Returns the running app's semver string.
// Electron: IPC to main (reads app.getVersion()).
// Web: Vite inlines VITE_APP_VERSION from package.json at build time.
export async function getAppVersion() {
  if (electronAPI?.getAppVersion) return electronAPI.getAppVersion();
  return import.meta.env.VITE_APP_VERSION ?? '0.0.0-web';
}

// True for packaged Electron builds (i.e. installed via Squirrel, not run
// from `electron-forge start`). Drives the auto-update gating in
// UpdatesContext — a packaged build polls update.electronjs.org; dev and
// web both should not.
export async function isPackaged() {
  if (electronAPI?.isPackaged) return electronAPI.isPackaged();
  return false;
}

// Returns { platform, arch } for the running build.
// Electron: IPC to main (process.platform / process.arch — e.g.
//   { platform: 'darwin', arch: 'arm64' }).
// Web: a synthetic 'web' marker so callers route into the no-installer path.
// Drives the manual-download update fallback's asset selection on platforms
// where the in-app auto-updater can't run (unsigned macOS / Linux).
export async function getPlatformInfo() {
  if (electronAPI?.getPlatformInfo) return electronAPI.getPlatformInfo();
  return { platform: 'web', arch: 'web' };
}

// ── External / OAuth URLs ─────────────────────────────────────────────────

// Open an arbitrary URL in the user's default browser.
// Electron: routes through main's shell.openExternal (filtered to http(s)).
// Web: opens in a new tab. noopener prevents the new tab from reading
// window.opener — standard safety for cross-origin links.
export function openExternal(url) {
  if (electronAPI?.openExternal) {
    electronAPI.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ── Window controls (frameless title bar) ─────────────────────────────────
// Electron runs frameless; the renderer's title bar drives the window through
// these. All no-op on web (the browser owns the window chrome there).
export function windowMinimize() { electronAPI?.windowMinimize?.(); }
export function windowToggleMaximize() { electronAPI?.windowToggleMaximize?.(); }
export function windowClose() { electronAPI?.windowClose?.(); }
export async function windowIsMaximized() {
  return electronAPI?.windowIsMaximized ? electronAPI.windowIsMaximized() : false;
}
// Subscribe to OS maximize/unmaximize. Returns an unsubscribe fn (no-op stub
// on web) so callers can clean up uniformly.
export function onWindowMaximizedChanged(handler) {
  return electronAPI?.onWindowMaximizedChanged
    ? electronAPI.onWindowMaximizedChanged(handler)
    : () => {};
}
export async function windowIsFullscreen() {
  return electronAPI?.windowIsFullscreen ? electronAPI.windowIsFullscreen() : false;
}

// True in the dedicated sign-in window (main.js openAuthWindow boots the same
// renderer with ?authWindow=1). Everything else — the app window, the doc
// viewer, the tray menu — is false, and on web it's always false: a browser tab
// can't open a second window, so the web build keeps rendering /auth inline.
export const isAuthWindow = (() => {
  try {
    return isElectron && new URLSearchParams(window.location.search).get('authWindow') === '1';
  } catch {
    return false;
  }
})();

// Handover between the app window and the sign-in window. All no-ops on web.
//   authAppReady()  — app window, signed in: reveal me, dismiss the sign-in window.
//   authRequired()  — app window, signed out: hide me, put the sign-in window up.
//   authCompleted() — sign-in window: a session landed, hand back to the app.
export function authAppReady() {
  electronAPI?.authAppReady?.();
}
export function authRequired() {
  electronAPI?.authRequired?.();
}
export function authCompleted() {
  electronAPI?.authCompleted?.();
}

// Quit the entire app (closes all windows). Used by a deliberate logout.
// No-op on web — there's no app process to quit.
export function quitApp() {
  electronAPI?.quitApp?.();
}
// Subscribe to native fullscreen enter/leave. Returns an unsubscribe fn (no-op
// stub on web). Drives the macOS title bar's traffic-light inset.
export function onWindowFullscreenChanged(handler) {
  return electronAPI?.onWindowFullscreenChanged
    ? electronAPI.onWindowFullscreenChanged(handler)
    : () => {};
}

// True for files Chromium's built-in viewers render inline (image
// tags, native <video>, pdf.js, text). DOCX gets `false` here because
// Chromium can't render it natively — but it has its own custom viewer
// (see viewerTypeFor below), so callers that hand off through
// openFileWindow should consult viewerTypeFor rather than gating on
// canViewInBrowser alone.
export function canViewInBrowser(mime, name) {
  const m = (mime || '').toLowerCase();
  const lcName = (name || '').toLowerCase();
  if (lcName.endsWith('.docx')) return false;
  return m === 'application/pdf'
    || m.startsWith('image/')
    || m.startsWith('video/')
    || m.startsWith('text/');
}

// True if the file is a Word document (matches the canonical DOCX
// MIME OR the .docx extension — the local-folder MIME mapper has
// historically returned `application/octet-stream` for some .docx
// files, so the extension check is the reliable signal). Callers
// route through openDocx for these; everything else goes through
// openFileWindow.
export function isDocxFile(mime, name) {
  const m = (mime || '').toLowerCase();
  const lcName = (name || '').toLowerCase();
  return m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || lcName.endsWith('.docx');
}

// True if the file is viewable inside DocVex — either by Chromium
// (image/video/PDF/text) OR by routing DOCX through openDocx (Word
// locally / Office Online / OS default). Used by callers to decide
// whether double-click should attempt an in-app open at all.
export function canOpenInApp(mime, name) {
  return canViewInBrowser(mime, name) || isDocxFile(mime, name);
}

// Open a file URL in a dedicated in-app window (image / video / PDF
// / text — types Chromium renders natively). DOCX uses openDocx
// below instead, because it has its own fallback chain that doesn't
// always end in a BrowserWindow at all.
//
// Electron: main opens a fresh BrowserWindow titled "DocVex - <fileName>"
//   with the app icon. The window has no preload + sandbox=true so it
//   can't reach electronAPI.
// Web: no Electron chrome to embed inside, so we fall back to a new
//   browser tab.
export function openFileWindow(url, fileName) {
  if (electronAPI?.openFileWindow) {
    electronAPI.openFileWindow(url, fileName);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

// Open a file in DocVex's document-viewer window — the file preview PLUS a
// Legal AI panel (src/pages/DocViewer.jsx). `file` is { path, name, mime }.
// Electron opens a dedicated app window; web opens the /doc-viewer route in
// a NEW BROWSER TAB (the viewer reconnects the folder backend itself — the
// demo workspace's OPFS restores without any permission prompt). Returns
// true when handled. WhatsApp-export opens stay Electron-only (the zip
// prep that produces `chatPath` never runs on web), so they fall through.
export function openDocViewerWindow(file) {
  if (electronAPI?.openDocViewerWindow) {
    electronAPI.openDocViewerWindow(file);
    return true;
  }
  if (typeof window !== 'undefined' && file?.path && !file?.isWhatsApp) {
    const q = new URLSearchParams({
      path: file.path,
      name: file.name || '',
      mime: file.mime || '',
    });
    // BASE_URL is '/demo/' on the web build, so this resolves to
    // /demo/doc-viewer regardless of the current route. No 'noopener' —
    // the viewer's own close paths call window.close(), which browsers
    // only honour for script-opened tabs that kept their opener.
    window.open(`${import.meta.env.BASE_URL}doc-viewer?${q.toString()}`, '_blank');
    return true;
  }
  return false;
}

// ── Pre-warmed doc-viewer window (Electron) ────────────────────────────────
// A viewer window boots hidden and empty so the NEXT file opens instantly:
// main hands it the file over IPC and shows it once the document has painted.
// All three no-op on web, where each viewer is a browser tab.
export function notifyDocViewerWarmReady() {
  try { electronAPI?.notifyDocViewerWarmReady?.(); } catch { /* non-fatal */ }
}
export function notifyDocViewerFilePainted() {
  try { electronAPI?.notifyDocViewerFilePainted?.(); } catch { /* non-fatal */ }
}
export function onDocViewerOpenFile(handler) {
  if (!electronAPI?.onDocViewerOpenFile) return () => {};
  return electronAPI.onDocViewerOpenFile(handler);
}

// Surface a known on-disk file for localfile:// preview without opening a
// window (timeline source thumbnails). Awaitable — resolves once the path
// is inside containment. No-op (resolved) on web.
export function allowLocalFile(p) {
  try {
    return Promise.resolve(electronAPI?.allowLocalFile?.(p));
  } catch {
    return Promise.resolve(false);
  }
}

// "Opened with DocVex" — standalone files opened via the OS file association
// (Explorer/Finder "Open with"), not linked to any project. list snapshots
// the recorded opens; onExternalOpensChanged subscribes to changes
// (unsubscribe fn returned); open re-launches one in its own Doc Viewer
// window; remove drops it from the list. All no-op / empty on web.
export function listExternalOpens() {
  return electronAPI?.listExternalOpens ? electronAPI.listExternalOpens() : Promise.resolve([]);
}
export function openExternalFile(p) {
  electronAPI?.openExternalFile?.(p);
}
export function removeExternalOpen(p) {
  return electronAPI?.removeExternalOpen ? electronAPI.removeExternalOpen(p) : Promise.resolve(false);
}
export function onExternalOpensChanged(cb) {
  return electronAPI?.onExternalOpensChanged ? electronAPI.onExternalOpensChanged(cb) : (() => {});
}

// On-disk path of a picked/dropped File object (webUtils.getPathForFile via
// the preload — File.path itself was removed in Electron 32). Returns '' on
// web or for synthetic Files that have no disk path.
export function pathForFile(file) {
  try { return electronAPI?.getPathForFile?.(file) || ''; } catch { return ''; }
}

// Subscribe to "open this file as a new tab" pushes for the shared doc-viewer
// window. Returns an unsubscribe fn (no-op on web).
export function onDocViewerAddFile(cb) {
  return electronAPI?.onDocViewerAddFile ? electronAPI.onDocViewerAddFile(cb) : (() => {});
}

// Open doc-viewer windows registry — backs the main app sidebar's "Open files"
// section. `listDocViewerTabs` snapshots the open viewers; `onDocViewerTabs`
// subscribes to live open/close changes (unsubscribe fn returned); focus/close
// act on a viewer by its window id. All no-op / empty on web (no extra windows).
export function listDocViewerTabs() {
  return electronAPI?.listDocViewerTabs ? electronAPI.listDocViewerTabs() : Promise.resolve([]);
}
// Report this doc-viewer window's AI advisor busy state to the main app's
// "Open files" sidebar (no-op on web — viewers aren't separate windows there).
export function setDocViewerAiStatus(busy) {
  electronAPI?.setDocViewerAiStatus?.(busy);
}
export function onDocViewerTabs(cb) {
  return electronAPI?.onDocViewerTabs ? electronAPI.onDocViewerTabs(cb) : (() => {});
}
export function focusDocViewerTab(id) {
  electronAPI?.focusDocViewerTab?.(id);
}
export function closeDocViewerTab(id) {
  electronAPI?.closeDocViewerTab?.(id);
}
// "Back to app" from a doc-viewer window — raise the main app window (no-op on
// web, where there's only one surface).
export function focusMainWindow() {
  electronAPI?.focusMainWindow?.();
}

// File mutations (trash, rename) need to reach two audiences:
//   • SAME renderer — the doc-viewer's tab sidebar and its embedded Files tab
//     live in one window, so a `window` event refreshes the footer directly,
//     with no IPC round-trip (works even if the preload/main process hasn't
//     reloaded, and on web).
//   • OTHER windows — the main window's Files tab, reached via IPC; main fans
//     the broadcast back out to every window EXCEPT the sender (the sender
//     already handled it through the local `window` event).
const FILES_REMOVED_EVENT = 'docvex:files-removed';
const FILES_CHANGED_EVENT = 'docvex:files-changed';

// Tell every window that `paths` (file or folder paths) were just trashed /
// deleted, so the doc-viewer can close their tabs and other Files tabs re-list.
export function notifyFilesRemoved(paths) {
  try { window.dispatchEvent(new CustomEvent(FILES_REMOVED_EVENT, { detail: paths })); } catch { /* noop */ }
  electronAPI?.notifyFilesRemoved?.(paths);
}

// Subscribe to the "files removed" signal (same-window event + cross-window
// IPC). Returns an unsubscribe fn.
export function onFilesRemoved(cb) {
  const onLocal = (e) => cb(e.detail);
  window.addEventListener(FILES_REMOVED_EVENT, onLocal);
  const unsubIpc = electronAPI?.onFilesRemoved ? electronAPI.onFilesRemoved(cb) : null;
  return () => { window.removeEventListener(FILES_REMOVED_EVENT, onLocal); unsubIpc?.(); };
}

// Announce a generic on-disk file change (e.g. a rename) so every window's
// Files tab re-lists.
export function notifyFilesChanged() {
  try { window.dispatchEvent(new Event(FILES_CHANGED_EVENT)); } catch { /* noop */ }
  electronAPI?.notifyFilesChanged?.();
}

// Subscribe to the "files changed" signal (same-window event + cross-window
// IPC). Returns an unsubscribe fn.
export function onFilesChanged(cb) {
  const onLocal = () => cb();
  window.addEventListener(FILES_CHANGED_EVENT, onLocal);
  const unsubIpc = electronAPI?.onFilesChanged ? electronAPI.onFilesChanged(cb) : null;
  return () => { window.removeEventListener(FILES_CHANGED_EVENT, onLocal); unsubIpc?.(); };
}

// Extract readable text from a legacy .doc file (parsed in the Electron main
// process). Resolves { text } or { error }; { error:'unsupported' } on web.
export function extractDocText(filePath) {
  return electronAPI?.extractDocText ? electronAPI.extractDocText(filePath) : Promise.resolve({ error: 'unsupported' });
}

// Extract a WhatsApp export .zip (main process) and locate its chat transcript.
// Resolves { ok, chatPath, name } so the caller can open the reconstructed
// conversation in the doc-viewer; { ok: false } when it isn't a WhatsApp export
// or on web (no filesystem / IPC).
export function prepareWhatsAppZip(zipPath) {
  return electronAPI?.prepareWhatsAppZip ? electronAPI.prepareWhatsAppZip(zipPath) : Promise.resolve({ ok: false });
}

// Same, for an already-extracted WhatsApp export FOLDER: locate its chat
// transcript so the caller can open the reconstructed conversation in the
// doc-viewer. Resolves { ok, chatPath, name } or { ok: false } (incl. web).
export function prepareWhatsAppFolder(dirPath) {
  return electronAPI?.prepareWhatsAppFolder ? electronAPI.prepareWhatsAppFolder(dirPath) : Promise.resolve({ ok: false });
}

// Content-based WhatsApp recognition for the Files tab. Resolves a
// { [path]: boolean } map for the given folder / .zip paths — true when the
// path CONTAINS a chat transcript (decided in the main process by reading
// inside, so renaming the zip/folder doesn't lose recognition). Web has no
// filesystem/IPC → empty map (the UI falls back to its name heuristic).
export function detectWhatsApp(paths) {
  return electronAPI?.detectWhatsApp ? electronAPI.detectWhatsApp(paths) : Promise.resolve({});
}

// Open a self-contained HTML string in its own window. Used by the
// .docx viewer (the document is rendered to HTML via docx-preview in the
// renderer). Electron stages it to a temp file + native window; web opens
// a blank tab and writes the markup in (no `noopener` here — we need the
// handle to write).
export function openHtmlWindow(html, fileName) {
  if (electronAPI?.openHtmlWindow) {
    electronAPI.openHtmlWindow(html, fileName);
    return;
  }
  const w = window.open('', '_blank');
  if (w) {
    w.document.open();
    w.document.write(html);
    w.document.close();
    try { w.document.title = fileName || 'Document'; } catch { /* cross-origin guard, n/a here */ }
  }
}

// Open a DOCX with the best-available renderer. Pass whichever
// sources you have — local disk path (My-branch files) and/or a
// signed cloud URL (Cloud-tab files, or My-branch files that have
// a cloud counterpart for the no-Word fallback).
//
// Routing (Electron):
//   1. Word installed → shell.openPath(localPath) when available,
//      else shell.openExternal('ms-word:ofv|u|<cloudUrl>').
//   2. No Word, cloudUrl present → Office Online in BrowserWindow.
//   3. No Word, localPath only → shell.openPath (OS default app).
//
// Routing (web):
//   - cloudUrl present → Office Online in new tab.
//   - localPath only   → no-op (no concept of a local file on web).
export function openDocx({ localPath = null, cloudUrl = null, fileName = 'file' }) {
  if (electronAPI?.openDocx) {
    electronAPI.openDocx({ localPath, cloudUrl, fileName });
    return;
  }
  if (cloudUrl && /^https?:\/\//i.test(cloudUrl)) {
    const officeOnline = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(cloudUrl)}`;
    window.open(officeOnline, '_blank', 'noopener,noreferrer');
  }
}

// Send the user through an OAuth provider's auth URL.
// Electron: pops the OS browser via main; the renderer waits for the
//   docvex:// callback (handled by onDeepLink below).
// Web: full-page redirect — supabase-js completes the flow when the user
//   lands back on /app/auth/callback?code=…
export function openOAuthUrl(url) {
  if (electronAPI?.openOAuthUrl) {
    electronAPI.openOAuthUrl(url);
    return;
  }
  window.location.assign(url);
}

// ── Deep links ────────────────────────────────────────────────────────────

// Subscribe to docvex:// URLs the OS routes back to the app. Returns an
// unsubscribe function. On web this is a no-op — deep links arrive as
// browser navigations and are handled by BrowserRouter directly.
export function onDeepLink(handler) {
  if (!electronAPI?.onOAuthCallback) return () => {};
  electronAPI.onOAuthCallback(handler);
  return () => {
    try { electronAPI.removeOAuthListener?.(); } catch { /* non-fatal */ }
  };
}

// One-shot fetch of any docvex:// URL passed on the command line at COLD
// start (e.g. clicking an invite link when the app isn't running yet).
// Resolves to null when nothing is pending OR on web (browsers don't get
// argv).
export async function getStartupDeepLink() {
  if (!electronAPI?.getStartupDeepLink) return null;
  try {
    return await electronAPI.getStartupDeepLink();
  } catch {
    return null;
  }
}

// ── Dev-only account switcher ─────────────────────────────────────────────

// Subscribe to the dev "Account" menu's switch event. Returns an unsubscribe
// fn. No web equivalent — the dev menu doesn't exist there.
export function onAccountSwitch(handler) {
  if (!electronAPI?.onAccountSwitch) return () => {};
  return electronAPI.onAccountSwitch(handler);
}

// ── Auto-updater ──────────────────────────────────────────────────────────

// Trigger a manual update check. Resolves to a status object whose `state`
// field drives the UI:
//   - Electron packaged: 'checking' → autoUpdater events take over
//   - Electron dev:      { state: 'dev' }
//   - Web:               { state: 'web' } — there is no installer to manage
export async function checkForUpdates() {
  if (electronAPI?.checkForUpdates) return electronAPI.checkForUpdates();
  return { state: 'web' };
}

// Pull the last-known updater status from main (recovers e.g. 'downloaded'
// after a renderer reload, since update:status events are push-only).
// { state: 'idle' } on web / when the bridge is missing.
export async function getUpdateStatus() {
  if (electronAPI?.getUpdateStatus) return electronAPI.getUpdateStatus();
  return { state: 'idle' };
}

// Trigger Squirrel's quit-and-install path. No-op on web.
export function installUpdate() {
  electronAPI?.installUpdate?.();
}

// macOS self-update fallback (the build can't use Squirrel.Mac — see
// UpdatesContext). Downloads the new build, swaps the .app bundle, and
// relaunches. Resolves to { ok, error? }; on success the app quits itself.
// Progress is reported via onUpdateStatus ('downloading' with percent →
// 'installing'). No-op-ish on web / non-Electron.
export async function downloadAndInstallUpdate(url) {
  if (electronAPI?.downloadAndInstallUpdate) return electronAPI.downloadAndInstallUpdate(url);
  return { ok: false, error: 'Not supported on this platform.' };
}

// Subscribe to autoUpdater lifecycle events. Returns an unsubscribe fn.
// No-op on web.
export function onUpdateStatus(handler) {
  if (!electronAPI?.onUpdateStatus) return () => {};
  return electronAPI.onUpdateStatus(handler);
}

// ── App-wide UI scale (Settings → Text size) ──────────────────────────────

// Apply a global UI zoom factor (1 = 100%). This is RELATIVE to the app's
// baseline 20% downscale (`:root { zoom: 0.8 }` in index.css; see
// src/lib/appZoom.js) — total visual scale = 0.8 × factor.
// Electron: webFrame (browser) zoom — it rescales the VIEWPORT, so vh/vw,
//   media queries and clientX-vs-layout math stay consistent, and it stacks
//   multiplicatively on the CSS baseline without touching it. Same mechanism
//   VS Code uses; renders text crisply.
// Web: no webFrame, so the factor is folded into the inline CSS `zoom` on
//   <html>. The inline style overrides index.css's 0.8 declaration, so the
//   baseline must be multiplied in here — and any vh/vw correction reads the
//   LIVE zoom (appZoom()) rather than the constant for exactly this reason.
export function setAppZoom(factor) {
  const f = Number(factor) || 1;
  if (electronAPI?.setZoomFactor) {
    electronAPI.setZoomFactor(f);
    return;
  }
  if (typeof document !== 'undefined') {
    try {
      const z = f * BASE_APP_ZOOM;
      const root = document.documentElement;
      root.style.zoom = String(z);
      // Re-derive the vh/vw correction units (declared in index.css for the
      // baseline) against the new effective zoom, so 100*var(--vh1) keeps
      // meaning "the real window height" at every display-scale setting.
      root.style.setProperty('--vh1', `calc(1vh / ${z})`);
      root.style.setProperty('--vw1', `calc(1vw / ${z})`);
    } catch { /* non-fatal */ }
  }
}

// ── OS-level notifications ────────────────────────────────────────────────

// Show a system-level (outside-the-app) notification. Today's preload
// doesn't expose this — Electron path is a silent no-op until it does.
// Web path is also a no-op for now; revisit if we want to wire the
// browser Notifications API.
export function showOSNotification(/* opts */) {
  // Intentional no-op on both targets. See risk callout in the plan.
}

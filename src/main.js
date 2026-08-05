import { app, BrowserWindow, Menu, Tray, ipcMain, shell, autoUpdater, dialog, protocol, nativeImage, screen, session, desktopCapturer } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import started from 'electron-squirrel-startup';
import { updateElectronApp } from 'update-electron-app';

// Resolve the path to Word's executable when Microsoft Word is
// installed locally. Electron's `app.getApplicationNameForProtocol`
// only finds Word when the `ms-word:` URL scheme is registered, which
// some Office installs (Microsoft Store / Click-to-Run variants) skip
// or strip — so we ALSO probe the well-known WINWORD.EXE locations
// across Office versions. The first hit wins. Returns null when Word
// can't be found by any method (Linux, macOS without Office, or a
// Windows install we don't recognise).
//
// Splitting "is Word installed?" from "open with Word" means the
// DOCX handler can branch reliably even when the protocol layer is
// flaky: with a real .exe path we can `child_process.spawn(winword,
// [arg])` directly, bypassing the registry entirely.
function getWinwordPath() {
  if (process.platform !== 'win32') return null;
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  // Walk the Click-to-Run layout first (current Microsoft default),
  // then the legacy MSI layout. Office 16 covers 2016 / 2019 / 2021 /
  // 365; 15 = 2013, 14 = 2010. Older isn't worth probing — those
  // versions don't accept HTTPS URLs as command-line args anyway.
  const candidates = [
    `${pf}\\Microsoft Office\\root\\Office16\\WINWORD.EXE`,
    `${pfx86}\\Microsoft Office\\root\\Office16\\WINWORD.EXE`,
    `${pf}\\Microsoft Office\\Office16\\WINWORD.EXE`,
    `${pfx86}\\Microsoft Office\\Office16\\WINWORD.EXE`,
    `${pf}\\Microsoft Office\\Office15\\WINWORD.EXE`,
    `${pfx86}\\Microsoft Office\\Office15\\WINWORD.EXE`,
    `${pf}\\Microsoft Office\\Office14\\WINWORD.EXE`,
    `${pfx86}\\Microsoft Office\\Office14\\WINWORD.EXE`,
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; }
    catch { /* permission denied — try next */ }
  }
  return null;
}

// True when ANY of our Word-detection routes report it's available.
// Falsy when neither the executable nor the protocol handler turns
// up — at that point the DOCX flow falls back to Office Online.
function isWordInstalled() {
  if (getWinwordPath()) return true;
  // Last-ditch: trust Electron's protocol-handler query. Returns
  // empty string when nothing is registered for ms-word:.
  return Boolean(app.getApplicationNameForProtocol('ms-word:'));
}

// Spawn Word as a detached child process. Word accepts EITHER a local
// file path OR an http(s) URL as its first positional argument; for
// URLs it fetches and opens the document itself (no DocVex byte
// handling). `detached` + `unref` so the user can close DocVex without
// killing Word, and stdio:'ignore' so DocVex doesn't accumulate a
// pile of pipes from each Word launch.
function spawnWord(winwordPath, arg) {
  if (!winwordPath || !arg) return false;
  try {
    const child = spawn(winwordPath, [arg], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// Custom `localfile://` scheme — lets the renderer load arbitrary
// files from the user's chosen branch folder via `<img src=…>`,
// without flipping webSecurity off. Registration MUST happen before
// app.whenReady because the scheme privileges are global. The actual
// request handler is wired in app.whenReady below.
//
// Privileges:
//   standard        — REQUIRED for fetch + <img> to work. Without it
//                     Chromium treats the scheme as opaque (like
//                     mailto:) and `<img>` loads fail with
//                     ERR_UNKNOWN_URL_SCHEME before the handler runs.
//   secure          — treat as same-origin (so it can be loaded from
//                     http(s) and Vite-served pages)
//   supportFetchAPI — fetch() works against this scheme (future-proof)
//   stream          — large videos / PDFs stream rather than buffer
//   bypassCSP       — allow the renderer's CSP to load it
//   corsEnabled     — without this, `fetch('localfile://…')` from the
//                     Vite dev origin (http://localhost:5173) is blocked
//                     by Chromium CORS before the protocol handler runs.
//                     `<img src>` works without it, but the SHA-256
//                     hashing path uses fetch() to read bytes as a Blob.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'localfile',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
]);

// Known accounts for the dev-only "Account" menu. Clicking an item sends an
// IPC to the renderer, which signs out of the current Supabase session,
// stashes the target credentials for prefill, and reloads the page so the
// auth screen comes up clean with the email (and optionally password)
// already typed.
//
// Developer's personal test accounts for the dev-only account switcher (gated on
// !app.isPackaged below). Passwords are NEVER hard-coded — a committed password
// leaks into source + git history and ships in the bundled main process. Set
// DOCVEX_DEV_PASSWORD in your local (untracked) env to auto-fill; otherwise an
// account just prefills the email and you type the password by hand.
const ACCOUNTS = [
  { email: 'petreluca25@stud.ase.ro', password: process.env.DOCVEX_DEV_PASSWORD || undefined },
  { email: 'petreluca1105@gmail.com' },
];

if (started) {
  app.quit();
}

// Capture any docvex:// URL passed on the command line at COLD start. The
// `second-instance` event below handles the subsequent-launch case (single-
// instance lock has already routed the URL to us), but on the very first
// launch — when the app wasn't running and the user clicked, say, an invite
// link in their email — nobody else is listening, so we have to scan our
// own argv. The renderer pulls this value via the `app:get-startup-deep-link`
// IPC handle once it's mounted and ready to act on it.
let pendingStartupDeepLink = (process.argv || [])
  .find((arg) => typeof arg === 'string' && arg.startsWith('docvex://')) || null;

// ── "Open with DocVex" (OS file association) ───────────────────────────────
// A plain file path on the command line means the OS handed us a file to
// open (Explorer's "Open with DocVex" verb on Windows; Finder's Open With
// on macOS fires `open-file` instead). Standalone — the file is NOT linked
// to any project: it opens in its own Doc Viewer window and is recorded in
// the "Opened with DocVex" list the Hub displays.
const pendingExternalOpens = [];
function isOpenableFileArg(arg) {
  if (typeof arg !== 'string' || !arg) return false;
  if (arg.startsWith('-') || arg.startsWith('docvex://')) return false;
  try { return fs.statSync(arg).isFile(); } catch { return false; }
}
// Cold start: skip the executable (and the app path in dev) before probing.
(process.argv || []).slice(process.defaultApp ? 2 : 1).forEach((arg) => {
  if (isOpenableFileArg(arg)) pendingExternalOpens.push(arg);
});
// macOS delivers file-opens as an event — often BEFORE ready on cold start,
// so the listener must exist this early and queue until the app is up.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) openExternalFile(filePath);
  else pendingExternalOpens.push(filePath);
});

// Windows: disable Chromium's native window-occlusion tracking. With it on
// (the default), fully-covered windows are marked hidden and their renderers
// suspended — and hovering the app's TASKBAR icon makes DWM request a live
// thumbnail of EVERY window at once, so Chromium flips them all back to
// visible simultaneously: every doc-viewer window re-rasterizes its whole
// surface through the one shared GPU process, and the visibility state
// thrashes for as long as the preview flyout is open. With several viewer
// windows open this stalls the whole desktop (see electron/electron#25291).
// Disabling the feature keeps background windows composited normally, so
// taskbar previews are cheap. Trade-off: a fully-occluded (but not
// minimized) window no longer gets the "hidden" throttle — acceptable, as
// idle DocVex windows render static content. Must run before app 'ready'.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

// Squirrel-based in-place auto-update only works on Windows for this app.
// The macOS build is NOT Developer-ID signed (forge.config.js ad-hoc signs
// it), so Squirrel.Mac's autoUpdater refuses to apply updates — it emits an
// `error` ("Could not get code signature for running application") and never
// downloads anything. On macOS (and Linux) the renderer falls back to a
// manual browser download of the new build instead — see the `update:check`
// handler and the Updates page's StatusBanner.
const AUTO_UPDATE_SUPPORTED = process.platform === 'win32';

// Auto-update via update.electronjs.org (free, public-repo hosted feed).
// Polls every 10 min, downloads in the background, installs on next launch.
// No-op in dev (`electron-forge start`) — only runs in packaged builds, and
// only on platforms where Squirrel can actually apply the update.
if (app.isPackaged && AUTO_UPDATE_SUPPORTED) {
  updateElectronApp({
    repo: 'petreluca1105-dotcom/docvex',
    updateInterval: '10 minutes',
  });
}

// Branding: report a proper product name instead of the bundle default.
// In a packaged build the macOS dock / menu read the bundle's CFBundleName
// (set from package.json#productName at package time); under
// `electron-forge start` the bundle is plain "Electron", so the dock label
// stays "Electron" in dev — only the packaged app shows "DocVex" there.
// setName still fixes app.getName(), the app menu, and notification source
// names everywhere. Pin userData to its pre-rename location first so the
// rename doesn't move the dev session/cache to a new Application Support
// folder (which would silently log the user out).
const __userDataBeforeRename = app.getPath('userData');
app.setName('DocVex');
app.setPath('userData', __userDataBeforeRename);
// Windows identity. Without an explicit AppUserModelID every window inherits
// the host process's (electron.exe's) identity, which is what puts "Electron"
// and the Electron logo at the head of the taskbar's right-click menu and on
// toast notifications. Setting it ties our windows to a DocVex identity that
// the Squirrel-installed shortcut also carries.
//
// Caveat worth knowing in dev: under `electron-forge start` the running binary
// really is electron.exe, and Windows reads the jump-list header's label and
// icon from the executable's own resources unless a Start-menu shortcut with a
// matching AppUserModelID exists. So the dev taskbar may still say "Electron";
// the packaged build (DocVex.exe, own icon + FileDescription) does not.
if (process.platform === 'win32') app.setAppUserModelId('com.docvex.app');

// Register custom URL scheme for OAuth callbacks.
// In dev mode (`electron-forge start`), process.defaultApp is true and we must
// pass the path to this app so Windows launches `electron.exe <app-path> docvex://...`
// rather than `electron.exe docvex://...` (which tries to treat the URL as an app path).
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('docvex', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('docvex');
}

// Enforce single instance so second launch delivers the OAuth URL here.
// DEV ESCAPE HATCH: when DOCVEX_ALLOW_MULTI is set (used by
// `npm run start:multi` to spin up multiple parallel dev instances
// for testing realtime / multi-user flows from one machine), skip the
// lock entirely so each child electron-forge process can boot its
// own window. OAuth callbacks won't be delivered between instances
// in this mode — that's the trade-off for parallel testing.
const allowMulti = Boolean(process.env.DOCVEX_ALLOW_MULTI);
if (!allowMulti) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  }
}

let mainWindow = null;

// System-tray handle — must stay referenced for the app's lifetime (a GC'd
// Tray silently vanishes from the notification area). Set up in app.whenReady.
let appTray = null;

// ── Multi-monitor / window-state persistence ───────────────────────────────
// Remember where each KIND of window last lived (which monitor, what size,
// whether it was maximized) so the next one opens the same way, and pin every
// secondary window to whichever monitor the main window is currently on.
// State is a tiny JSON file in userData, keyed by role:
//   { main: {x,y,width,height,maximized,fullscreen}, docViewer: {…} }
// Resizing a doc-viewer window therefore sets the size for the NEXT document
// you open, exactly like the main window. (A pre-roles file held the main
// window's rect at the top level — readWindowState still accepts that shape.)
// All of `screen` is only valid after the app is ready, but these run at
// window-creation time, so that holds.
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function isUsableRect(s) {
  return !!s && Number.isFinite(s.width) && Number.isFinite(s.height);
}

function readWindowStateFile() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    if (!s || typeof s !== 'object') return {};
    // Legacy flat shape → treat it as the main window's state.
    if (isUsableRect(s) && !s.main && !s.docViewer) return { main: s };
    return s;
  } catch { /* no/invalid state — fall back to defaults */ }
  return {};
}

function readWindowState(role = 'main') {
  const state = readWindowStateFile()[role];
  return isUsableRect(state) ? state : null;
}

function saveWindowState(win, role = 'main') {
  if (!win || win.isDestroyed()) return;
  try {
    // getNormalBounds() is the restored (non-maximized) rect, so we can reopen
    // at the user's chosen size even when they quit while maximized.
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    const all = readWindowStateFile();
    // A minimized window reports isMaximized() === false and a stale rect —
    // the OS has already collapsed it. So while minimized we keep whatever was
    // last recorded for those fields and only flip the `minimized` flag;
    // otherwise "maximize, minimize, quit" would come back un-maximized.
    const minimized = win.isMinimized();
    const prev = all[role] || null;
    all[role] = minimized && prev
      ? { ...prev, minimized: true }
      : {
        x: b.x, y: b.y, width: b.width, height: b.height,
        maximized: win.isMaximized(), fullscreen: win.isFullScreen(),
        minimized,
      };
    fs.writeFileSync(windowStateFile(), JSON.stringify(all));
  } catch { /* best-effort */ }
}

// Persist a window's size + position (i.e. which monitor) under `role`.
// Debounced on move/resize so a force-quit still leaves a recent state, and
// flushed on close.
function trackWindowState(win, role) {
  let saveTimer = null;
  const schedule = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win, role), 400);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('minimize', schedule);
  win.on('restore', schedule);
  win.on('close', () => { clearTimeout(saveTimer); saveWindowState(win, role); });
}

// Put a freshly-created window into the maximized / fullscreen / minimized mode
// it was last left in. `saved` is a readWindowState() record (bounds are applied
// at creation time, not here).
function applySavedWindowMode(win, saved, { allowMinimized = false } = {}) {
  if (!win || win.isDestroyed() || !saved) return;
  if (saved.maximized) win.maximize();
  if (saved.fullscreen) win.setFullScreen(true);
  // Only the main window honours this: a doc-viewer window is created BECAUSE
  // the user asked to see a document, so opening it minimized would swallow the
  // very action that spawned it.
  if (allowMinimized && saved.minimized) win.minimize();
}

// A saved rect is only usable if it still overlaps a CONNECTED display — a
// monitor may have been unplugged or rearranged since last launch. Require a
// decent overlap so the (grabbable) title bar can't land off-screen.
function boundsAreOnScreen(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return false;
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    const ix = Math.max(b.x, wa.x);
    const iy = Math.max(b.y, wa.y);
    const ax = Math.min(b.x + b.width, wa.x + wa.width);
    const ay = Math.min(b.y + b.height, wa.y + wa.height);
    return ax - ix > 96 && ay - iy > 64;
  });
}

// Center a width×height rect within the work area of the display that currently
// holds `refWin` (the main window) — used to open every secondary window on the
// same monitor as the base app. Falls back to the primary display.
function centeredOnDisplayOf(refWin, width, height) {
  let display;
  try {
    display = refWin && !refWin.isDestroyed()
      ? screen.getDisplayMatching(refWin.getBounds())
      : screen.getPrimaryDisplay();
  } catch {
    display = screen.getPrimaryDisplay();
  }
  const wa = display.workArea;
  const w = Math.min(width, wa.width);
  const h = Math.min(height, wa.height);
  return {
    width: w,
    height: h,
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: Math.round(wa.y + (wa.height - h) / 2),
  };
}

// Latest known update status. Kept here so renderers that mount after an
// event has already fired can still recover the current state on request.
let updateStatus = { state: 'idle' };

const sendUpdateStatus = (payload) => {
  updateStatus = payload;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', payload);
  }
};

// Hand off the account switch to the renderer via IPC. The renderer owns
// the Supabase client (the session lives in its localStorage) and the
// React-Router state, so the actual signOut + page-refresh has to happen
// there. Main's only job is to ferry the target credentials across the
// bridge. Password is optional — accounts without one just prefill the
// email and let the user type the password manually.
function switchAccount(account) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('account:switch-to', {
      email: account.email,
      password: account.password || null,
    });
  }
}

// The previous custom application menu (File / Edit / View / Window / Account
// / DEBUG submenus) has been removed — we now run with no native menu bar at
// all. The dev-only DEBUG actions it used to host moved into an in-app
// "Debug" page in the renderer's Personal sidebar section (see
// src/pages/Debug.jsx), so they no longer need IPC round-trips through main.

// Wire autoUpdater events → renderer. update-electron-app drives the actual
// checkForUpdates / setFeedURL calls; we just observe. Skipped on platforms
// where the autoUpdater can't run (see AUTO_UPDATE_SUPPORTED) so the macOS
// build doesn't emit spurious 'error' status events from a no-op updater.
if (app.isPackaged && AUTO_UPDATE_SUPPORTED) {
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }));
  autoUpdater.on('update-available', () => sendUpdateStatus({ state: 'downloading' }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus({ state: 'up-to-date' }));
  autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
    sendUpdateStatus({ state: 'downloaded', releaseName, releaseNotes });
  });
  autoUpdater.on('error', (err) => {
    sendUpdateStatus({ state: 'error', message: String(err?.message || err) });
  });
}

// Restore DevTools access on a window. The app removes the native menu
// (setApplicationMenu(null) + per-window removeMenu()), which ALSO strips the
// default DevTools keyboard accelerators (F12 / Ctrl+Shift+I / Cmd+Opt+I) that
// the menu's `toggleDevTools` role provided. We re-add them per-window via the
// raw input event, plus a right-click "Inspect element" context menu, so the
// inspector is reachable again even without a menu bar.
function wireDevtoolsShortcuts(win) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    const isF12 = key === 'f12';
    // Ctrl+Shift+I (Win/Linux) or Cmd+Opt+I (macOS).
    const isInspectCombo =
      key === 'i' &&
      input.shift &&
      (input.control || input.meta) &&
      (process.platform === 'darwin' ? input.alt : true);
    if (isF12 || isInspectCombo) {
      event.preventDefault();
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools();
    }
  });
  // Right-click → "Inspect element" at the cursor.
  wc.on('context-menu', (_event, params) => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Inspect element',
        click: () => {
          wc.inspectElement(params.x, params.y);
          if (!wc.isDevToolsOpened()) wc.openDevTools();
        },
      },
    ]);
    menu.popup({ window: win });
  });
}

// Shared factory for an app window (the main window OR the doc-viewer window).
// All windows are frameless with the renderer-drawn title bar; `query` is
// appended to the loaded URL (e.g. `?docViewer=1`) so the renderer can boot
// straight into a specific surface. `openDevtools` only for the primary window
// so the doc-viewer window doesn't pop its own devtools.
// Default app-window size — used as the launch fallback for the signed-in app.
const DEFAULT_WINDOW_SIZE = { width: 1200, height: 750 };
// Fixed size the signed-out (auth) screen pins the window to — its own compact,
// centred, non-resizable window rather than the full app frame. Kept >720px wide
// so the split brand panel stays visible (its hide breakpoint in
// authCabinet.css is tuned to match).
// White (form) side is double the fixed 368px blue panel → 736px, so the window
// is 368 + 736 = 1104px wide. The height is sized to the tallest step of the
// sign-up flow; the form column scrolls if a translation makes it taller.
const AUTH_WINDOW_SIZE = { width: 1104, height: 640 };

function createAppWindow({ query, openDevtools = false, bounds = null, show = true } = {}) {
  const win = new BrowserWindow({
    // `show: false` backs the pre-warmed doc-viewer window — it boots fully but
    // stays invisible until a file is handed to it.
    show,
    // `bounds` pins size + monitor: restored main-window state on launch, or a
    // rect centered on the main window's display for secondary windows. Without
    // it Electron centers a default-sized window on the primary display.
    width: bounds?.width ?? DEFAULT_WINDOW_SIZE.width,
    height: bounds?.height ?? DEFAULT_WINDOW_SIZE.height,
    ...(bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
      ? { x: bounds.x, y: bounds.y }
      : {}),
    // Floor on how small the user can drag the window. Below this the sidebar
    // + layout start to crowd; 900×600 keeps the chrome usable.
    minWidth: 900,
    minHeight: 600,
    title: 'DocVex',
    // Title-bar chrome: the renderer draws its own bar (src/components/TitleBar.jsx).
    //  • Windows / Linux — fully frameless (frame:false strips the OS title bar
    //    AND its min/max/close buttons); the renderer supplies custom controls.
    //  • macOS — `titleBarStyle:'hidden'` keeps the native traffic-light buttons
    //    (close / minimize / zoom) at top-left, which users expect, while hiding
    //    the rest of the OS bar so our custom bar shows through. The bar is 44px
    //    tall (--titlebar-h in index.css, same as Win/Linux). trafficLightPosition
    //    is the TOP-LEFT inset of the ~12px-tall button cluster, so to centre it
    //    vertically in the 44px bar — VS Code's tight look — y = (44-12)/2 ≈ 16.
    //    x:19 puts the first light a hair in from the left, matching VS Code. The
    //    renderer insets its brand to clear them and hides its own window controls
    //    (is-mac CSS). Nudge `y` a px or two if the lights look high or low.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 13, y: 10 } }
      : { frame: false }),
    icon: path.join(__dirname, 'appicon_desktop.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Tell this window's title bar when its OS maximized state flips (double-
  // click drag region, Win+Up, snap, etc.) so it can swap the maximize⇄restore
  // glyph. The renderer also queries the initial state via window:is-maximized.
  const sendMaxState = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:maximized-changed', win.isMaximized());
    }
  };
  win.on('maximize', sendMaxState);
  win.on('unmaximize', sendMaxState);

  // Tell the title bar when this window enters/leaves native fullscreen. On
  // macOS fullscreen hides the traffic-light buttons, so the renderer drops the
  // brand's left inset that normally clears them (is-fullscreen CSS).
  const sendFullscreenState = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:fullscreen-changed', win.isFullScreen());
    }
  };
  win.on('enter-full-screen', sendFullscreenState);
  win.on('leave-full-screen', sendFullscreenState);

  // Tag this as a preload-bearing app window so the navigation guard pins it to
  // app content (the no-preload viewer windows aren't tagged and stay free to
  // load remote office/PDF viewer URLs).
  const wcId = win.webContents.id;
  appWindowContentIds.add(wcId);
  win.on('closed', () => appWindowContentIds.delete(wcId));

  // No native menu bar (per-window on Windows, so removeMenu each window).
  win.removeMenu();
  // Removing the menu also drops the default DevTools accelerators — re-add them.
  wireDevtoolsShortcuts(win);

  // Let the renderer drive the taskbar / dock / Alt-Tab title (there's no
  // in-window OS title bar). The app sets document.title per window via
  // <WindowTitle> — "DocVex — Hub", "DocVex — <project>", "DocVex — <file>" —
  // so each instance is distinguishable in the macOS Window menu / dock. We do
  // NOT preventDefault here, so Chromium mirrors document.title onto the window
  // title. index.html ships "DocVex" as the pre-mount fallback.

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}${qs}`);
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      query ? { query } : undefined,
    );
  }

  if (openDevtools) win.webContents.openDevTools();
  return win;
}

// The app window is created HIDDEN and revealed once its renderer reports an
// authenticated session (`auth:app-ready`). Signed out, it stays hidden and the
// dedicated sign-in window opens in front of it instead — the app window is the
// app, and it no longer shrinks itself into a login box.
//   • `pendingMainReveal` holds the saved window mode until that reveal, because
//     maximize() SHOWS a window on Windows and would defeat the point.
//   • `mainRevealTimer` is the backstop: a renderer that never reports (old
//     bundle, crash before mount) must not leave a headless process running.
let pendingMainReveal = null;
let mainRevealTimer = null;
const MAIN_REVEAL_FALLBACK_MS = 8000;

function revealMainWindow() {
  clearTimeout(mainRevealTimer);
  mainRevealTimer = null;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const mode = pendingMainReveal;
  pendingMainReveal = null;
  // Order matters: maximize() shows the window on Windows, so it goes first;
  // minimize() must come last or the other two would undo it.
  if (mode?.maximized) mainWindow.maximize();
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mode?.fullscreen) mainWindow.setFullScreen(true);
  if (mode?.minimized) mainWindow.minimize();
  else mainWindow.focus();
}

const createWindow = () => {
  // Reopen on the same monitor + size as last time, when that display is still
  // connected (otherwise let Electron center on the primary display).
  const saved = readWindowState();
  const bounds = saved && boundsAreOnScreen(saved) ? saved : null;
  mainWindow = createAppWindow({ openDevtools: true, bounds, show: false });
  // Reopen in the mode it was closed in — maximized, fullscreen, or minimized
  // to the taskbar. (Minimized is deliberate: "reopen how I left it" includes
  // that. The tray icon and taskbar button both bring it back.) Applied at
  // reveal, not now.
  pendingMainReveal = saved;
  clearTimeout(mainRevealTimer);
  mainRevealTimer = setTimeout(revealMainWindow, MAIN_REVEAL_FALLBACK_MS);
  // Persist size + position (i.e. which monitor) for next launch.
  trackWindowState(mainWindow, 'main');
  // Once the app itself is up and idle, pre-boot the doc-viewer window so the
  // first file opens instantly. Deliberately late: warming during startup
  // would compete with the main window's own first paint.
  mainWindow.webContents.once('did-finish-load', () => scheduleWarmDocViewer(4000));
};

// ── Dedicated sign-in window ───────────────────────────────────────────────
// Signing in gets its own window rather than reshaping the app window. It's
// the same renderer booted with `?authWindow=1`, pinned to the Cabinet's size
// and non-resizable, centred on whichever display the app window is on.
let authWindow = null;
// Set while the sign-in window is closing BECAUSE sign-in succeeded, so its
// 'closed' handler hands over to the app instead of quitting.
let authHandedOver = false;

function openAuthWindow() {
  if (authWindow && !authWindow.isDestroyed()) {
    if (authWindow.isMinimized()) authWindow.restore();
    authWindow.show();
    authWindow.focus();
    return authWindow;
  }
  const bounds = centeredOnDisplayOf(mainWindow, AUTH_WINDOW_SIZE.width, AUTH_WINDOW_SIZE.height);
  const win = createAppWindow({ query: { authWindow: '1' }, bounds });
  // A login box has one size. (The app-wide 900×600 floor is below the Cabinet,
  // so nothing needs relaxing here.)
  win.setResizable(false);
  win.setMaximizable(false);
  win.setFullScreenable(false);
  authWindow = win;
  authHandedOver = false;
  win.on('closed', () => {
    const handedOver = authHandedOver;
    authWindow = null;
    authHandedOver = false;
    // Closing the sign-in window without signing in ends the attempt. With the
    // app window still hidden behind it, leaving the process running would look
    // exactly like a hang — so quit, the way any login window does.
    if (handedOver) return;
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) app.quit();
  });
  return win;
}

// Deliver a `docvex://` deep link (the Google OAuth callback) to the window
// that's waiting for it. While the sign-in window is up it's the one that
// started the flow, so it must be the one to run exchangeCodeForSession —
// sending the code to the hidden app window instead would leave the sign-in
// screen sitting there having apparently done nothing.
// It goes to BOTH the sign-in window and the app window, not just one.
//
// Which of them can actually complete the exchange depends on which one holds
// the PKCE code verifier, and that's whichever one started the flow — not
// something the main process can know. Sending to one and guessing wrong loses
// the sign-in silently. Sending to both is safe: the verifier is consumed by
// the first successful exchange, so the other window's attempt just returns an
// error, and either outcome finishes the flow —
//   • sign-in window wins → it reports `auth:completed`;
//   • app window wins     → its gate reports `auth:app-ready`, which reveals
//                           the app and closes the sign-in window anyway.
// A window still loading gets the URL on `did-finish-load` instead of dropping
// it on the floor.
function sendDeepLink(url) {
  const targets = [authWindow, mainWindow].filter((w) => w && !w.isDestroyed());
  for (const win of targets) {
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => {
        if (!win.isDestroyed()) win.webContents.send('oauth:callback-url', url);
      });
    } else {
      win.webContents.send('oauth:callback-url', url);
    }
  }
}

function closeAuthWindow() {
  if (!authWindow || authWindow.isDestroyed()) return;
  authHandedOver = true;
  authWindow.close();
  authWindow = null;
}

// The app window's renderer resolved its session.
//   'app-ready' → signed in: reveal the app window, dismiss any sign-in window.
//   'required'  → signed out: hide the app window and put the sign-in window up.
ipcMain.on('auth:app-ready', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w !== mainWindow) return;
  closeAuthWindow();
  revealMainWindow();
});

ipcMain.on('auth:required', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w !== mainWindow) return;
  clearTimeout(mainRevealTimer);
  mainRevealTimer = null;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide();
  openAuthWindow();
});

// The sign-in window got a session. The app window booted signed-out, so it's
// reloaded rather than messaged: a reload remounts the whole React tree against
// the session now sitting in localStorage, and there's no in-flight state to
// lose at sign-in time. It reveals itself again via `auth:app-ready`.
ipcMain.on('auth:completed', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (authWindow && w !== authWindow) return;
  authHandedOver = true;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    clearTimeout(mainRevealTimer);
    mainRevealTimer = setTimeout(revealMainWindow, MAIN_REVEAL_FALLBACK_MS);
    mainWindow.webContents.reload();
  }
  closeAuthWindow();
});

// Document-viewer window — opened from the Files page when a file is double-
// clicked. Each file gets its OWN dedicated window (one file = one window); the
// window boots at /doc-viewer with the file in the query and shows just that
// document. Opening more files spawns more windows side by side.
// Registry of open doc-viewer windows so the main app's sidebar can list every
// open document and refocus / close one on click. Keyed by BrowserWindow id →
// { id, name, path, mime }. Kept in sync as viewer windows open and close; any
// change is broadcast to every window via the `doc-viewer:tabs` channel.
const docViewerWindows = new Map();
function docViewerTabList() {
  return [...docViewerWindows.values()];
}
function broadcastDocViewerTabs() {
  const list = docViewerTabList();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('doc-viewer:tabs', list);
  }
}

// Normalise an on-disk path for comparison (Windows separators + drive-letter
// casing, trailing slash) so the same file maps to one identity.
function normDocPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function createDocViewerWindow(file) {
  // The viewer loads this file (and its WhatsApp media siblings) via
  // localfile:// — allow reads in its folder.
  if (file?.path) registerLocalfileFile(file.path);
  // Never open the same file in two windows — if a viewer already shows this
  // path, restore + focus it and reuse it instead of spawning a duplicate.
  if (file?.path) {
    const want = normDocPath(file.path);
    for (const [winId, meta] of docViewerWindows) {
      if (meta.path && normDocPath(meta.path) === want) {
        const existing = BrowserWindow.fromId(winId);
        if (existing && !existing.isDestroyed()) {
          if (existing.isMinimized()) existing.restore();
          existing.focus();
          return existing;
        }
        // Stale registry entry (window already gone) — drop it and fall through.
        docViewerWindows.delete(winId);
      }
    }
  }
  // A warm viewer is already booted and idle — hand it the file instead of
  // paying for a whole new window + renderer + bundle parse (see below).
  if (warmViewerReady && warmViewer && !warmViewer.isDestroyed()) {
    return adoptWarmDocViewer(file);
  }
  // Cold path: no warm window available (first open of the session, or two
  // files opened back to back). Build one the slow way and warm the next.
  const query = { docViewer: '1' };
  if (file?.path) query.path = file.path;
  if (file?.name) query.name = file.name;
  if (file?.mime) query.mime = file.mime;
  // A freshly-created "New file" opens with the AI generator armed so the
  // advisor prompts for what to put in the (currently empty) document.
  if (file?.generate) query.generate = '1';
  const { restorable, bounds } = docViewerBounds();
  const win = createAppWindow({ query, bounds });
  applyViewerWindowState(win, restorable);
  registerDocViewerWindow(win, file);
  scheduleWarmDocViewer();
  return win;
}

// ── Instant open: a pre-warmed doc-viewer window ───────────────────────────
// Opening a file used to cost a full window boot — new renderer process, the
// app bundle parsed and executed, every provider mounted, the lazy /doc-viewer
// chunk (pdf.js, docx-preview, the AI panel) fetched — before anything could
// paint. That's the second or two between double-clicking a file and seeing it.
//
// So the app keeps ONE viewer window pre-booted and hidden, sized exactly like
// the next one will be. Opening a file sends it the file over IPC, the already-
// mounted React tree swaps its state, and the window is shown the moment it
// reports the new document painted — no process spawn, no bundle parse, no
// chunk fetch on the critical path. A replacement is warmed in the background
// straight afterwards, so back-to-back opens stay fast too.
//
// The warm window is NOT in `docViewerWindows` (the sidebar's open-files list)
// and must never keep the app alive on its own — see the last-window watcher.
let warmViewer = null;
let warmViewerReady = false;
let warmViewerTimer = null;

// Where the next viewer window should open: the size/monitor the last one was
// left at, else centered on the main window's display.
function docViewerBounds() {
  const saved = readWindowState('docViewer');
  const restorable = saved && boundsAreOnScreen(saved) ? saved : null;
  return { restorable, bounds: restorable || centeredOnDisplayOf(mainWindow, 1200, 800) };
}

// Maximize / fullscreen to match what the user left behind. First ever open
// (no saved state) maximizes, which is the long-standing behaviour.
function applyViewerWindowState(win, restorable) {
  if (win.isDestroyed()) return;
  if (!restorable || restorable.maximized) win.maximize();
  if (restorable?.fullscreen) win.setFullScreen(true);
  trackWindowState(win, 'docViewer');
}

// Enter a viewer window into the open-files registry + broadcast it.
function registerDocViewerWindow(win, file) {
  docViewerWindows.set(win.id, {
    id: win.id,
    name: file?.name || 'Document',
    path: file?.path || null,
    mime: file?.mime || null,
    // Recognised WhatsApp conversation → the sidebar shows the WhatsApp glyph.
    isWhatsApp: !!file?.isWhatsApp,
    aiBusy: false,
  });
  broadcastDocViewerTabs();
  win.on('closed', () => {
    docViewerWindows.delete(win.id);
    broadcastDocViewerTabs();
  });
}

function scheduleWarmDocViewer(delayMs = 1200) {
  clearTimeout(warmViewerTimer);
  warmViewerTimer = setTimeout(() => {
    if (warmViewer && !warmViewer.isDestroyed()) return;
    // Don't warm while the app is shutting down or before there's a main
    // window to take bounds from.
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { restorable, bounds } = docViewerBounds();
    // `warm=1` tells the renderer to boot the viewer shell with no document
    // and report readiness instead of trying to open a file.
    const win = createAppWindow({ query: { docViewer: '1', warm: '1' }, bounds, show: false });
    // Lay it out at its eventual size WITHOUT maximize(): on Windows maximize()
    // also SHOWS the window, which is what used to make an empty viewer pop up
    // next to the real one. The maximized state is applied at reveal instead.
    if (!restorable || restorable.maximized) {
      try {
        const wa = screen.getDisplayMatching(win.getBounds()).workArea;
        win.setBounds(wa);
      } catch { /* keep the bounds it was created with */ }
    }
    warmViewer = win;
    warmViewerReady = false;
    // Safety net: a warm window must never be visible. Anything that shows it
    // (an OS quirk, a stray focus call) puts it straight back to hidden — by
    // adoption time `warmViewer` is already null, so real windows are unaffected.
    win.on('show', () => {
      if (warmViewer === win && !win.isDestroyed()) win.hide();
    });
    win.on('closed', () => {
      if (warmViewer === win) { warmViewer = null; warmViewerReady = false; }
    });
  }, delayMs);
}

// The warm renderer finished mounting — it can accept a file now.
ipcMain.on('doc-viewer:warm-ready', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && win === warmViewer) warmViewerReady = true;
});

// The adopted renderer paints its document — kept as a no-op so an older
// renderer (or a reload racing an update) sending it isn't an unhandled
// channel. The window no longer waits on it: adoptWarmDocViewer shows the
// window straight away and the renderer covers the gap with a spinner.
ipcMain.on('doc-viewer:file-painted', () => {});

// Hand the warm window a file and promote it to a real viewer window.
function adoptWarmDocViewer(file) {
  const win = warmViewer;
  // Clearing this FIRST also disarms the "hide if shown" guard above, so the
  // window is free to become visible now that it owns a document.
  warmViewer = null;
  warmViewerReady = false;
  const { restorable, bounds } = docViewerBounds();
  const wantsMaximized = !restorable || restorable.maximized;
  if (!wantsMaximized && restorable) win.setBounds(bounds);
  trackWindowState(win, 'docViewer');
  registerDocViewerWindow(win, file);
  win.webContents.send('doc-viewer:open-file', file);

  // Show it NOW. This used to wait for the renderer's "document painted" ack
  // (with a 600ms backstop) so the window would appear fully laid out — but
  // that put the whole decode of a heavy PDF between the double-click and any
  // visible response, which reads as the app ignoring you. The window opens
  // immediately instead and the renderer paints a spinner in the document
  // pane until the file is ready (see `docLoading` in DocViewer.jsx).
  if (win.isDestroyed()) return win;
  if (wantsMaximized) win.maximize();   // also shows it, on Windows
  win.show();
  if (restorable?.fullscreen) win.setFullScreen(true);
  win.focus();
  // Line up the next one.
  scheduleWarmDocViewer();
  return win;
}

ipcMain.on('window:open-doc-viewer', (_, file) => createDocViewerWindow(file));

// ── Tray "Extract text" — Snipping-Tool-style capture ─────────────────────
// The tray item opens a small launcher window (openSnipPanel, /snip-panel) —
// a Snipping-Tool bar: New · Delay · a freeze-scope toggle (all screens vs
// the screen the panel is on). "New" fires snip:new {mode, delay, allScreens}:
// the panel hides, the optional delay elapses, then openScreenSnip screenshots
// the target display(s) at full physical resolution, stages each to a temp
// PNG (served via localfile://), and opens a frameless fullscreen overlay per
// display showing its frozen shot. Each overlay boots the renderer at /snip
// (?snip=1&shot=<path>&mode=<mode>) — a top pill switches the selection mode
// live; the crop runs through the shared OCR pipeline (lib/ocr.js → doc-ai
// Edge Function). Starting a selection on one display closes the other frozen
// overlays (snip:selection-started); when the last overlay closes, the
// launcher panel pops back up (like the real Snipping Tool after a capture).
let snipWindows = [];
let snipPanelWindow = null;
const SNIP_MODES = new Set(['rect', 'free', 'full']);

// Freeze target: every display, or the one the launcher panel sits on
// (falling back to the cursor's display if the panel is gone).
function snipTargetDisplays(allScreens) {
  if (allScreens) return screen.getAllDisplays();
  const panelDisplay = snipPanelWindow && !snipPanelWindow.isDestroyed()
    ? screen.getDisplayMatching(snipPanelWindow.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return [panelDisplay];
}

async function openScreenSnip(mode = 'rect', { allScreens = false } = {}) {
  const alive = snipWindows.filter((w) => !w.isDestroyed());
  if (alive.length) { alive[0].focus(); return; }
  snipWindows = [];

  const displays = snipTargetDisplays(allScreens);

  // desktopCapturer applies ONE thumbnailSize to every source, so capture
  // per display — each shot is requested at exactly THAT display's physical
  // resolution (CSS size × scale factor). A shared max-size box would
  // aspect-fit smaller displays into it and their shots wouldn't match
  // their screen's native resolution.
  for (const [displayIndex, display] of displays.entries()) {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    });
    const source = sources.find((s) => s.display_id === String(display.id))
      || (displays.length === 1 ? sources[0] : null);
    if (!source || source.thumbnail.isEmpty()) continue;
    const shotPath = path.join(app.getPath('temp'), `docvex-snip-${display.id}-${Date.now()}.png`);
    await fsp.writeFile(shotPath, source.thumbnail.toPNG());
    registerLocalfileFile(shotPath);

    const win = new BrowserWindow({
      // Bounds place the window on the right display; `fullscreen` then snaps
      // it to cover that display completely — sizing to display.bounds alone
      // can leave the window a few px short on Windows (DPI rounding / Win11
      // rounded-corner inset), letting the real desktop peek through.
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      fullscreen: true,
      frame: false,
      // NOTE: no `resizable: false` — on Windows a non-resizable window can't
      // enter fullscreen, which left the overlay at its plain bounds with the
      // desktop visible around it. Fullscreen itself blocks user resizing.
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    // Above fullscreen apps / the taskbar, like a screenshot tool.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setFullScreen(true);
    // Belt-and-suspenders: re-assert the display's full bounds once the page
    // is ready, in case the WM applied the fullscreen transition to a stale
    // rect.
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.setBounds(display.bounds);
    });
    // Pin to app content (navigation hardening) like every preload window.
    const wcId = win.webContents.id;
    appWindowContentIds.add(wcId);
    win.removeMenu();
    const query = { snip: '1', shot: shotPath, mode: SNIP_MODES.has(mode) ? mode : 'rect' };
    // Multi-screen capture: number each overlay (w1, w2, …) — the overlay
    // suffixes its saved screenshot with the number so every screen's capture
    // + snippets can be kept side by side.
    if (displays.length > 1) query.w = String(displayIndex + 1);
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}?${new URLSearchParams(query).toString()}`);
    } else {
      win.loadFile(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
        { query },
      );
    }
    snipWindows.push(win);
    win.on('closed', () => {
      appWindowContentIds.delete(wcId);
      snipWindows = snipWindows.filter((w) => w !== win);
      fsp.unlink(shotPath).catch(() => { /* temp dir self-cleans */ });
      // When the LAST overlay closes, bring the launcher panel back — like
      // the real Snipping Tool returning after a capture.
      if (!snipWindows.length && snipPanelWindow && !snipPanelWindow.isDestroyed()) {
        snipPanelWindow.show();
        snipPanelWindow.focus();
      }
    });
  }
}

// The Snipping-Tool-style launcher bar. A small, frameless, TRANSPARENT
// window — the visible card paints itself in the renderer (/snip-panel); the
// window is taller than the card so the Mode/Delay dropdowns have room to
// open inside it (a child window can't overflow its own bounds).
function openSnipPanel() {
  if (snipPanelWindow && !snipPanelWindow.isDestroyed()) {
    snipPanelWindow.show();
    snipPanelWindow.focus();
    return;
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const W = 560;
  const H = 380;
  const win = new BrowserWindow({
    x: Math.round(display.workArea.x + (display.workArea.width - W) / 2),
    y: Math.round(display.workArea.y + display.workArea.height * 0.16),
    width: W,
    height: H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  const wcId = win.webContents.id;
  appWindowContentIds.add(wcId);
  win.removeMenu();
  const query = { snipPanel: '1' };
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}?${new URLSearchParams(query).toString()}`);
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { query },
    );
  }
  snipPanelWindow = win;
  win.on('closed', () => {
    appWindowContentIds.delete(wcId);
    if (snipPanelWindow === win) snipPanelWindow = null;
    // Closing the tool aborts a delayed capture that hasn't fired yet.
    clearTimeout(snipDelayTimer);
    snipDelayTimer = null;
    closeSnipCountdowns();
  });
}

// Panel "New" → optional delay → hide the panel → capture. The panel must be
// hidden BEFORE desktopCapturer runs or the tool photographs itself; the tiny
// wait lets the OS actually take it off screen.
// Delayed-capture countdown — a small click-through, non-focusable window at
// the centre of every target display showing the seconds tick down (/snip-
// countdown route). Destroyed BEFORE the screenshot so it never captures
// itself.
let snipCountdownWindows = [];
function closeSnipCountdowns() {
  for (const w of [...snipCountdownWindows]) {
    if (!w.isDestroyed()) w.destroy();
  }
  snipCountdownWindows = [];
}
function openSnipCountdowns(delaySec, allScreens) {
  closeSnipCountdowns();
  const S = 240;
  for (const display of snipTargetDisplays(allScreens)) {
    const wa = display.workArea;
    const win = new BrowserWindow({
      x: Math.round(wa.x + (wa.width - S) / 2),
      y: Math.round(wa.y + (wa.height - S) / 2),
      width: S,
      height: S,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      show: false,
      // Never steal focus from whatever the user is arranging for the shot.
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    // Clicks fall through to whatever is underneath.
    win.setIgnoreMouseEvents(true);
    const wcId = win.webContents.id;
    appWindowContentIds.add(wcId);
    win.removeMenu();
    const query = { snipCountdown: '1', n: String(delaySec) };
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}?${new URLSearchParams(query).toString()}`);
    } else {
      win.loadFile(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
        { query },
      );
    }
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
    snipCountdownWindows.push(win);
    win.on('closed', () => {
      appWindowContentIds.delete(wcId);
      snipCountdownWindows = snipCountdownWindows.filter((w) => w !== win);
    });
  }
}

let snipDelayTimer = null;
ipcMain.on('snip:new', (_e, opts) => {
  const mode = SNIP_MODES.has(opts?.mode) ? opts.mode : 'rect';
  const delaySec = Math.min(10, Math.max(0, Math.round(Number(opts?.delay) || 0)));
  const allScreens = !!opts?.allScreens;
  clearTimeout(snipDelayTimer);
  const start = () => {
    snipDelayTimer = null;
    (async () => {
      closeSnipCountdowns();
      if (snipPanelWindow && !snipPanelWindow.isDestroyed()) {
        snipPanelWindow.hide();
      }
      // Let the countdown/panel actually leave the screen before the shot.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await openScreenSnip(mode, { allScreens });
    })().catch(() => {
      // Capture unavailable — bring the panel back so the tool isn't lost.
      if (snipPanelWindow && !snipPanelWindow.isDestroyed()) snipPanelWindow.show();
    });
  };
  if (delaySec > 0) {
    openSnipCountdowns(delaySec, allScreens);
    snipDelayTimer = setTimeout(start, delaySec * 1000);
  } else {
    start();
  }
});
// Esc in the panel while a delayed capture is counting down — abort the
// countdown (timer + badges) but leave the Extract Tool window open.
ipcMain.on('snip:cancel-pending', () => {
  clearTimeout(snipDelayTimer);
  snipDelayTimer = null;
  closeSnipCountdowns();
});

// Esc in any overlay → close every snip window from the main process.
// destroy() (not close()) so the frozen shots vanish in one frame — a
// fullscreen window's close() can lag through async teardown, and the other
// displays' overlays wouldn't hear a renderer-side window.close() at all.
// (The last overlay's 'closed' handler above re-shows the launcher panel.)
ipcMain.on('snip:cancel', () => {
  for (const w of [...snipWindows]) {
    if (!w.isDestroyed()) w.destroy();
  }
  snipWindows = [];
});

// ── System-tray menu (app-drawn) ───────────────────────────────────────────
// Clicking the tray icon opens /tray-menu (src/pages/TrayMenu.jsx) instead of
// a native Menu: the app's themed card, a live status header, and a recent-
// projects flyout can't be expressed in a Menu template. It rides in one
// reusable transparent, frameless, always-on-top window that:
//   • is anchored to the tray icon's bounds (clamped to the work area, so it
//     never sits under the taskbar or off a display edge),
//   • is sized by the RENDERER — the card measures itself and sends
//     `tray:resize`, so the window is exactly as tall as the menu and only
//     grows wider while the recent-projects flyout is open,
//   • hides on blur / Esc / after any action, and toggles on tray click.
// Every row's effect comes back over `tray:action`, handled at the bottom.
let trayMenuWindow = null;
// The window hides on blur, and clicking the tray icon blurs it first — so a
// click that was meant to CLOSE the menu would immediately reopen it. Ignore
// tray clicks that land right after a hide.
let trayMenuHiddenAt = 0;
// Where the tray sits, so the card animates from the right corner and clamps
// its flyout on the correct side ('bottom' = Windows taskbar, 'top' = macOS
// menu bar).
let trayMenuAnchor = 'bottom';
const TRAY_MENU_MARGIN = 8;
// Pre-measurement fallback only — the renderer reports the real size (card +
// the permanent flyout apron) as soon as it has laid the menu out, and the
// window stays hidden until then so it can never appear clipped.
const TRAY_MENU_DEFAULT = { width: 435, height: 460 };
// Set while a freshly created menu window waits for its first size report.
let trayMenuPendingReveal = null;
// Coalesces a BURST of measurements into one reveal. The renderer re-measures
// several times as the card settles (the recent-projects list, its relative
// timestamps, the updater row), and each measurement used to move the window —
// which on a transparent always-on-top window replays the OS show animation.
// That's what read as the menu fading in twice.
let trayMenuRevealTimer = null;
const TRAY_MEASURE_SETTLE_MS = 40;
// Last size the renderer reported. Reveal positions from THIS rather than
// win.getBounds(): a setBounds applied while the window is still hidden isn't
// always reflected back on Windows, and reading a stale (default) height there
// is what left the menu clipped at the top on first open.
let trayMenuSize = null;

// Place the (already sized) menu next to the tray icon: right edge aligned to
// the icon, above the taskbar when the tray is at the bottom, below the menu
// bar when it's at the top. Falls back to the cursor's display when the
// platform gives no tray bounds.
function positionTrayMenu(width, height) {
  const point = screen.getCursorScreenPoint();
  let trayBounds = null;
  try {
    const b = appTray?.getBounds?.();
    if (b && b.width > 0 && b.height > 0) trayBounds = b;
  } catch { /* no tray bounds on this platform — cursor fallback below */ }
  const display = trayBounds
    ? screen.getDisplayMatching(trayBounds)
    : screen.getDisplayNearestPoint(point);
  const wa = display.workArea;

  const anchorX = trayBounds ? trayBounds.x + trayBounds.width / 2 : point.x;
  // The card hugs the window's RIGHT edge (the flyout opens into the space on
  // the left), so anchor the right edge just past the icon's centre.
  let x = Math.round(anchorX - width + 24);
  x = Math.min(Math.max(x, wa.x + TRAY_MENU_MARGIN), wa.x + wa.width - width - TRAY_MENU_MARGIN);

  const atBottom = trayBounds ? trayBounds.y + trayBounds.height / 2 > wa.y + wa.height / 2 : true;
  trayMenuAnchor = atBottom ? 'bottom' : 'top';
  let y = atBottom
    ? wa.y + wa.height - height - TRAY_MENU_MARGIN
    : wa.y + TRAY_MENU_MARGIN;
  y = Math.min(Math.max(y, wa.y + TRAY_MENU_MARGIN), Math.max(wa.y, wa.y + wa.height - height - TRAY_MENU_MARGIN));

  return { x, y, width, height };
}

function createTrayMenuWindow() {
  const win = new BrowserWindow({
    ...positionTrayMenu(TRAY_MENU_DEFAULT.width, TRAY_MENU_DEFAULT.height),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,          // the card paints its own shadow
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // Above the taskbar, like the native tray menu it replaces.
  win.setAlwaysOnTop(true, 'pop-up-menu');
  const wcId = win.webContents.id;
  appWindowContentIds.add(wcId);
  win.removeMenu();
  const query = { trayMenu: '1' };
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}?${new URLSearchParams(query).toString()}`);
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { query },
    );
  }
  // Click-away dismissal. DevTools focus counts as a blur too, so keep the
  // menu out of the dev-tools flow (it's a plain route — open /tray-menu in
  // the main window to inspect it).
  win.on('blur', () => hideTrayMenu());
  win.on('closed', () => {
    appWindowContentIds.delete(wcId);
    if (trayMenuWindow === win) trayMenuWindow = null;
  });
  trayMenuWindow = win;
  return win;
}

function hideTrayMenu() {
  // Drop any reveal still waiting on measurements — otherwise a menu dismissed
  // during the settle window pops open again a frame later.
  clearTimeout(trayMenuRevealTimer);
  trayMenuRevealTimer = null;
  trayMenuPendingReveal = null;
  if (trayMenuWindow && !trayMenuWindow.isDestroyed() && trayMenuWindow.isVisible()) {
    trayMenuWindow.hide();
    trayMenuHiddenAt = Date.now();
  }
}

function showTrayMenu() {
  const existing = (trayMenuWindow && !trayMenuWindow.isDestroyed()) ? trayMenuWindow : null;
  const win = existing || createTrayMenuWindow();
  // Already up — a second show() would replay the OS window animation on a
  // menu that's already on screen.
  if (existing && win.isVisible()) return;
  const reveal = () => {
    if (win.isDestroyed() || win.isVisible()) return;
    const size = trayMenuSize || win.getBounds();
    win.setBounds(positionTrayMenu(size.width, size.height));
    win.show();
    // show() normally activates the window too; focusing an already-focused
    // window is a SECOND activation, which Windows animates a second time.
    // Keep the call only as the fallback for when show() didn't take focus
    // (without it the blur-to-dismiss never arms).
    if (!win.isFocused()) win.focus();
  };

  // Hold the window back until the renderer has MEASURED the menu — the
  // pending reveal fires from the tray:resize handler. This runs on EVERY
  // open, not just the first: the card's height changes between opens (the
  // recent-projects list, the relative timestamps in it, the updater row), and
  // resizing a transparent always-on-top window that's already on screen reads
  // as the menu fading in a second time. Measure first, then show once.
  trayMenuPendingReveal = reveal;
  // Reused window: the renderer is alive and re-measures as soon as it handles
  // tray:opened, so the safety net can be short. A cold window has to boot the
  // bundle first.
  const fallbackMs = existing ? 250 : 2000;
  setTimeout(() => {
    if (trayMenuPendingReveal !== reveal) return;
    clearTimeout(trayMenuRevealTimer);
    trayMenuRevealTimer = null;
    trayMenuPendingReveal = null;
    reveal();
  }, fallbackMs);

  // Tell the reused renderer it's opening again: reset the flyout, re-read the
  // recent projects + updater state, and re-send its size (which is what
  // releases the reveal above).
  if (existing) win.webContents.send('tray:opened', { anchor: trayMenuAnchor });
}

function toggleTrayMenu() {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed() && trayMenuWindow.isVisible()) {
    hideTrayMenu();
    return;
  }
  // A click right after a blur-hide is the SAME click that closed the menu.
  if (Date.now() - trayMenuHiddenAt < 250) return;
  showTrayMenu();
}

// The menu window is HIDDEN, not closed, between uses — which would keep the
// app alive after the user closes every real window, because
// 'window-all-closed' only fires once the last window is DESTROYED. Watch for
// the last real window going away and tear the menu down so the normal quit
// path runs (the menu is rebuilt on the next tray click).
app.on('browser-window-created', (_e, created) => {
  created.on('closed', () => {
    setImmediate(() => {
      // The tray menu and the pre-warmed viewer are infrastructure: neither is
      // a window the user opened, so neither should hold the app open.
      const alive = BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed() && w !== trayMenuWindow && w !== warmViewer);
      if (alive.length) return;
      clearTimeout(warmViewerTimer);
      if (warmViewer && !warmViewer.isDestroyed()) warmViewer.destroy();
      if (trayMenuWindow && !trayMenuWindow.isDestroyed()) trayMenuWindow.destroy();
      if (process.platform !== 'darwin') app.quit();
    });
  });
});

// Raise the main window (creating it if the user closed it on macOS), and
// optionally send it somewhere. A freshly created window can't receive the
// route until its renderer has booted.
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return mainWindow;
  }
  // Still waiting on its first reveal (booted hidden, session not resolved yet)
  // — reveal it in the mode it was last left in rather than at whatever size
  // it happens to be sitting at offscreen.
  if (pendingMainReveal !== null || !mainWindow.isVisible()) {
    revealMainWindow();
    return mainWindow;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

function navigateMainWindow(dest) {
  const win = showMainWindow();
  if (!win || win.isDestroyed() || typeof dest !== 'string' || !dest) return;
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send('app:navigate', dest);
    });
  } else {
    win.webContents.send('app:navigate', dest);
  }
}

// The card's measured size (DIP) → resize + re-anchor. Clamped so a runaway
// measurement can't paint a window across the whole screen.
ipcMain.on('tray:resize', (e, size) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed() || win !== trayMenuWindow) return;
  const width = Math.max(200, Math.min(900, Math.round(Number(size?.width) || 0)));
  const height = Math.max(120, Math.min(1200, Math.round(Number(size?.height) || 0)));
  if (!width || !height) return;
  const changed = !trayMenuSize || trayMenuSize.width !== width || trayMenuSize.height !== height;
  trayMenuSize = { width, height };
  // Moving a window that's already on screen replays the OS window animation.
  // A re-measurement that lands on the SAME size has nothing to apply, so
  // skipping it is the difference between one fade and two.
  if (changed || !win.isVisible()) win.setBounds(positionTrayMenu(width, height));
  // Measurements arrive in bursts as the card settles. Wait out the burst
  // before showing, so the window appears once, already at its final size,
  // instead of appearing and then being resized into place.
  if (trayMenuPendingReveal) {
    clearTimeout(trayMenuRevealTimer);
    trayMenuRevealTimer = setTimeout(() => {
      trayMenuRevealTimer = null;
      const pending = trayMenuPendingReveal;
      trayMenuPendingReveal = null;
      pending?.();
    }, TRAY_MEASURE_SETTLE_MS);
  }
});

ipcMain.on('tray:close', () => hideTrayMenu());

ipcMain.handle('tray:state', () => ({
  version: app.getVersion(),
  isPackaged: app.isPackaged,
  platform: process.platform,
  updateState: updateStatus?.state || 'idle',
  anchor: trayMenuAnchor,
}));

// Every menu row lands here. The menu always closes first — an action that
// raises the main window shouldn't leave the menu floating over it.
ipcMain.on('tray:action', (_e, msg) => {
  const action = msg?.action;
  const payload = msg?.payload;
  hideTrayMenu();
  switch (action) {
    case 'open':
      showMainWindow();
      break;
    case 'navigate':
      navigateMainWindow(payload);
      break;
    case 'external':
      openExternalSafe(payload);
      break;
    case 'extract':
      try { openSnipPanel(); } catch { /* capture unavailable — non-fatal */ }
      break;
    case 'check-updates':
      // Show the release history (which reports the result), and kick the
      // packaged updater. Dev / macOS builds just land on the page — see the
      // `update:check` handler for why Squirrel is Windows-only.
      navigateMainWindow('/versions');
      if (app.isPackaged && AUTO_UPDATE_SUPPORTED && updateStatus.state !== 'downloaded') {
        try { autoUpdater.checkForUpdates(); } catch { /* reported via update:status */ }
      }
      break;
    case 'install-update':
      if (app.isPackaged && updateStatus.state === 'downloaded') autoUpdater.quitAndInstall();
      break;
    case 'restart':
      app.relaunch();
      app.quit();
      break;
    case 'quit':
      app.quit();
      break;
    default:
      break;
  }
});

// Sidebar "Open files" section IPC: snapshot the open viewers, and refocus /
// close a specific one by its BrowserWindow id.
ipcMain.handle('doc-viewer:list', () => docViewerTabList());
ipcMain.on('doc-viewer:focus', (_e, id) => {
  const w = BrowserWindow.fromId(id);
  if (w && !w.isDestroyed()) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
});
ipcMain.on('doc-viewer:close', (_e, id) => {
  const w = BrowserWindow.fromId(id);
  if (w && !w.isDestroyed()) w.close();
});
// "Back to app" from a doc-viewer window — surface the main app window (restore
// if minimized, raise it to the front). The viewer window stays open behind it.
ipcMain.on('window:focus-main', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});
// A doc-viewer window reports its AI advisor busy/idle state. Stamp it onto that
// window's registry entry and re-broadcast so the main app's "Open files" list
// can mark the row as "AI working".
ipcMain.on('doc-viewer:ai-status', (e, busy) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const meta = win && docViewerWindows.get(win.id);
  if (!meta) return;
  const next = Boolean(busy);
  if (meta.aiBusy === next) return; // no change → don't spam the broadcast
  meta.aiBusy = next;
  broadcastDocViewerTabs();
});

// A Files-tab instance just trashed/deleted some paths. Fan the event out to
// every OTHER window (the file watcher only ever pings the main window) so the
// doc-viewer can close tabs that show a now-deleted file AND any other Files
// tab can re-list. The sender window is skipped — it already refreshed itself
// (and closed its own tabs) via a same-renderer `window` event in platform.js.
ipcMain.on('files:removed', (e, paths) => {
  const list = Array.isArray(paths) ? paths : [paths];
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.webContents !== e.sender) w.webContents.send('files:removed', list);
  }
});

// Generic on-disk change (e.g. a rename from the doc-viewer tab sidebar) — fan
// it out to every other window's Files tab. Sender skipped (same reason).
ipcMain.on('files:changed', (e) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.webContents !== e.sender) w.webContents.send('files:changed');
  }
});

// Extract readable text from a legacy .doc (OLE binary) via word-extractor in
// the main process — the sandboxed renderer can't parse that format. Returns
// { text } or { error }; the doc viewer renders the text. word-extractor is
// lazy-imported so its weight isn't paid until a .doc is actually opened.
ipcMain.handle('doc:extract-text', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { error: 'no_path' };
  try {
    const { default: WordExtractor } = await import('word-extractor');
    const doc = await new WordExtractor().extract(filePath);
    return { text: (doc.getBody() || '').trim() };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
});

// ── WhatsApp export (.zip) → extract + locate the chat transcript ──────
// WhatsApp's "Export chat" produces a .zip holding the transcript (`_chat.txt`
// on iOS, "WhatsApp Chat with NAME.txt" on Android) plus every media file. To
// reconstruct the conversation we extract the zip to a temp folder ONCE
// (cached by the zip's path+size+mtime so re-opening is instant) and hand the
// doc-viewer the on-disk path of the transcript — its media siblings then load
// straight from that temp folder via localfile://, reusing the normal renderer.
//
// A WhatsApp line starts with a bracketed/locale-loose timestamp; this signature
// keeps us from hijacking arbitrary zips that merely happen to contain a .txt.
// Tolerances for real-world exports: any leading invisible/direction marks or
// BOM, `[`-bracketed (iOS) or bare (Android) dates, `/ . -` date separators,
// and a `:` OR `.` time separator (some EU locales export `21.42`).
const WHATSAPP_SIGNATURE = /(^|\n)[\s‎‏‪-‮⁦-⁩﻿]*\[?\s*\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s+\d{1,2}[:.]\d{2}/;

// Recursively find the best transcript candidate inside an extracted export.
// Preference: an exact `_chat.txt` → a "WhatsApp Chat …".txt → the largest .txt.
async function findChatTranscript(dir, depth = 0) {
  let exact = null;
  let named = null;
  let largest = null;
  let largestSize = -1;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (depth >= 4) continue; // exports are flat / one level — cap the walk
      const nested = await findChatTranscript(full, depth + 1);
      if (nested) { if (/(^|[\\/])_chat\.txt$/i.test(nested)) return nested; named = named || nested; }
      continue;
    }
    if (!/\.txt$/i.test(ent.name)) continue;
    if (/^_chat\.txt$/i.test(ent.name)) exact = full;
    else if (/whatsapp chat/i.test(ent.name)) named = named || full;
    try { const st = await fsp.stat(full); if (st.size > largestSize) { largestSize = st.size; largest = full; } } catch { /* skip */ }
  }
  return exact || named || largest;
}

async function looksLikeWhatsApp(filePath) {
  try {
    const fd = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(16 * 1024);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      return WHATSAPP_SIGNATURE.test(buf.slice(0, bytesRead).toString('utf8'));
    } finally { await fd.close(); }
  } catch { return false; }
}

ipcMain.handle('whatsapp:prepare-zip', async (_e, zipPath) => {
  if (typeof zipPath !== 'string' || !/\.zip$/i.test(zipPath)) return { ok: false };
  try {
    const stat = await fsp.stat(zipPath);
    const { createHash } = await import('node:crypto');
    const key = createHash('sha1').update(`${zipPath}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 16);
    const destDir = path.join(app.getPath('temp'), 'docvex-wa', key);

    // Reuse a previous extraction when the chat transcript is already present.
    let chatPath = await findChatTranscript(destDir);
    if (!chatPath) {
      await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});
      await fsp.mkdir(destDir, { recursive: true });
      const { default: extract } = await import('extract-zip');
      await extract(zipPath, { dir: destDir });
      // Drop any hostile symlink entries the archive planted before we serve it.
      await stripSymlinks(destDir);
      chatPath = await findChatTranscript(destDir);
    }
    if (!chatPath || !(await looksLikeWhatsApp(chatPath))) return { ok: false };
    // The reconstructed conversation (transcript + media) is served via
    // localfile:// — allow reads inside this extraction folder only.
    registerLocalfileRoot(destDir);

    // Friendly tab name: the Android transcript names itself; iOS `_chat.txt`
    // is anonymous, so fall back to the zip's own filename.
    const base = path.basename(chatPath);
    const name = /^_chat\.txt$/i.test(base)
      ? path.basename(zipPath).replace(/\.zip$/i, '')
      : base.replace(/\.txt$/i, '');
    return { ok: true, chatPath, name };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// A WhatsApp export can also live as an already-extracted FOLDER (transcript +
// media side by side). Locate the transcript inside it so the Files tab can
// open the reconstructed conversation directly — no extraction step.
ipcMain.handle('whatsapp:prepare-folder', async (_e, dirPath) => {
  if (typeof dirPath !== 'string' || !dirPath) return { ok: false };
  try {
    const chatPath = await findChatTranscript(dirPath);
    if (!chatPath || !(await looksLikeWhatsApp(chatPath))) return { ok: false };
    registerLocalfileRoot(dirPath); // media served from this folder via localfile://
    const base = path.basename(chatPath);
    const name = /^_chat\.txt$/i.test(base) ? path.basename(dirPath) : base.replace(/\.txt$/i, '');
    return { ok: true, chatPath, name };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// ── WhatsApp recognition for the Files tab (content-based) ──────────────
// Given folder / .zip paths, decide whether each one IS a WhatsApp export by
// looking INSIDE it (transcript file + timestamp signature) — never at the
// path's own name, so a renamed export keeps its WhatsApp mark in the file
// grid. Verdicts are memoised per path+size+mtime for the app's lifetime.
const waDetectCache = new Map();

// Does the zip contain a WhatsApp transcript? Scans the central directory
// lazily (yauzl — already in the tree as extract-zip's engine) and signature-
// tests the first bytes of the first few .txt entries, so a multi-hundred-MB
// export is decided from a couple of KB without extracting anything.
async function zipContainsWhatsAppChat(zipPath) {
  const { default: yauzl } = await import('yauzl');
  return new Promise((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) { resolve(false); return; }
      let txtTested = 0;
      let settled = false;
      const finish = (verdict) => {
        if (settled) return;
        settled = true;
        try { zf.close(); } catch { /* already closed */ }
        resolve(verdict);
      };
      zf.on('entry', (entry) => {
        const isTxt = !/\/$/.test(entry.fileName) && /\.txt$/i.test(entry.fileName);
        if (!isTxt || txtTested >= 6) { zf.readEntry(); return; }
        txtTested += 1;
        zf.openReadStream(entry, (e2, rs) => {
          if (e2 || !rs) { zf.readEntry(); return; }
          let head = '';
          let judged = false;
          const judge = () => {
            if (judged || settled) return;
            judged = true;
            if (WHATSAPP_SIGNATURE.test(head)) finish(true);
            else zf.readEntry();
          };
          rs.on('data', (d) => {
            head += d.toString('utf8');
            if (head.length >= 16 * 1024) { judge(); rs.destroy(); }
          });
          rs.on('end', judge);
          rs.on('error', judge);
        });
      });
      zf.on('end', () => finish(false));
      zf.on('error', () => finish(false));
      zf.readEntry();
    });
  });
}

ipcMain.handle('whatsapp:detect', async (_e, paths) => {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [];
  const out = {};
  await Promise.all(list.map(async (p) => {
    try {
      const st = await fsp.stat(p);
      const key = `${p}:${st.size}:${st.mtimeMs}`;
      if (waDetectCache.has(key)) { out[p] = waDetectCache.get(key); return; }
      let hit = false;
      if (st.isDirectory()) {
        // An extracted export: a folder whose transcript passes the signature
        // test. Reuses the same walk the zip-open path uses.
        const chatPath = await findChatTranscript(p);
        hit = Boolean(chatPath && (await looksLikeWhatsApp(chatPath)));
      } else if (/\.zip$/i.test(p)) {
        hit = await zipContainsWhatsAppChat(p);
      } else if (/\.txt$/i.test(p)) {
        // A loose, already-extracted transcript dropped in on its own
        // (`_chat.txt` / "WhatsApp Chat with NAME.txt"): recognise it by its
        // first bytes carrying WhatsApp's timestamp signature.
        hit = await looksLikeWhatsApp(p);
      }
      waDetectCache.set(key, hit);
      out[p] = hit;
    } catch {
      out[p] = false;
    }
  }));
  return out;
});

// On Windows: when the OS opens docvex:// in a second instance, argv contains the URL
app.on('second-instance', (_, argv) => {
  // Raise whichever window is actually the user's current surface — while
  // they're signing in that's the sign-in window, not the (hidden) app window.
  const front = authWindow && !authWindow.isDestroyed() ? authWindow : mainWindow;
  if (front && !front.isDestroyed()) {
    if (front.isMinimized()) front.restore();
    front.focus();
  }
  const callbackUrl = argv.find((arg) => arg.startsWith('docvex://'));
  if (callbackUrl) sendDeepLink(callbackUrl);
  // "Open with DocVex" while the app is already running — the second
  // instance's argv carries the file path(s).
  (argv || []).slice(1).forEach((arg) => {
    if (isOpenableFileArg(arg)) openExternalFile(arg);
  });
});

// ── "Opened with DocVex" store + opener ────────────────────────────────────
// Standalone files opened through the OS association. Persisted to userData
// (JSON, newest first, capped) so the Hub's "Opened with DocVex" section
// survives restarts. Deliberately NOT linked to any project.
const EXTERNAL_OPENS_FILE = path.join(app.getPath('userData'), 'external-opens.json');
const EXTERNAL_OPENS_CAP = 50;
function loadExternalOpens() {
  try {
    const arr = JSON.parse(fs.readFileSync(EXTERNAL_OPENS_FILE, 'utf8'));
    return Array.isArray(arr) ? arr.filter((e) => e && typeof e.path === 'string') : [];
  } catch { return []; }
}
function saveExternalOpens(list) {
  try { fs.writeFileSync(EXTERNAL_OPENS_FILE, JSON.stringify(list.slice(0, EXTERNAL_OPENS_CAP))); }
  catch { /* best-effort */ }
}
function broadcastExternalOpensChanged() {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('external-opens:changed'); } catch { /* closing */ }
  }
}
function recordExternalOpen(filePath) {
  const norm = path.resolve(filePath);
  const list = loadExternalOpens().filter((e) => e.path !== norm);
  list.unshift({ path: norm, name: path.basename(norm), mime: guessMimeFromName(norm), at: Date.now() });
  saveExternalOpens(list);
  broadcastExternalOpensChanged();
}
// Open an OS-handed file in a standalone Doc Viewer window (no project).
function openExternalFile(filePath) {
  try { if (!fs.statSync(filePath).isFile()) return; } catch { return; }
  recordExternalOpen(filePath);
  createDocViewerWindow({
    path: path.resolve(filePath),
    name: path.basename(filePath),
    mime: guessMimeFromName(filePath),
  });
}
// The Hub's section: list (pruned to files that still exist), reopen, remove.
ipcMain.handle('external-opens:list', () => loadExternalOpens().filter((e) => {
  try { return fs.statSync(e.path).isFile(); } catch { return false; }
}));
ipcMain.on('external-opens:open', (_, p) => {
  if (typeof p === 'string') openExternalFile(p);
});
ipcMain.handle('external-opens:remove', (_, p) => {
  saveExternalOpens(loadExternalOpens().filter((e) => e.path !== p));
  broadcastExternalOpensChanged();
  return true;
});

// Windows "Open with DocVex" — an Explorer context-menu verb for every file
// type, written per-user (HKCU\Software\Classes\*\shell — no admin prompt).
// Dev registers the electron.exe + app-path command form, the same trick as
// the docvex:// protocol registration, so the verb works under forge start.
// Best-effort and silent: a locked-down registry just means no verb.
function registerOpenWithDocVexVerb() {
  if (process.platform !== 'win32') return;
  const exe = process.execPath;
  const cmd = process.defaultApp && process.argv.length >= 2
    ? `"${exe}" "${path.resolve(process.argv[1])}" "%1"`
    : `"${exe}" "%1"`;
  const base = 'HKCU\\Software\\Classes\\*\\shell\\DocVex';
  const run = (args) => new Promise((resolve) => {
    try {
      const child = spawn('reg.exe', ['add', ...args, '/f'], { windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    } catch { resolve(false); }
  });
  // The menu entry's icon. A packaged build's own exe embeds the app icon, so
  // pointing at it is right — but in DEV `process.execPath` is electron.exe,
  // which is why the entry showed the Electron logo. Fall back to the .ico on
  // disk there. (Only in dev: once packaged that file lives inside app.asar,
  // which Explorer can't read an icon out of.)
  let iconSpec = `"${exe}",0`;
  if (!app.isPackaged) {
    const icoPath = path.join(__dirname, 'favicon.ico');
    try { if (fs.existsSync(icoPath)) iconSpec = `"${icoPath}"`; } catch { /* keep the exe */ }
  }
  (async () => {
    await run([base, '/ve', '/d', 'Open with DocVex']);
    await run([base, '/v', 'Icon', '/d', iconSpec]);
    await run([`${base}\\command`, '/ve', '/d', cmd]);
  })();
}

// On macOS: the OS fires open-url instead of launching a second instance
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith('docvex://')) sendDeepLink(url);
});

// ── Navigation hardening (Electron security checklist) ─────────────────────
// The preload-bearing app windows expose the full electronAPI bridge, and
// Chromium re-injects the preload on every top-level navigation. If an injection
// ever drove such a window to a remote origin, that origin would inherit the
// bridge (file read/write/delete, openExternal, …). Pin those windows to app
// content and route any external link to the system browser. window.open is
// denied everywhere (the app never uses it — file windows are spawned via IPC).
const appWindowContentIds = new Set();
function isAppContentUrl(url) {
  if (typeof url !== 'string') return false;
  if (/^localfile:\/\//i.test(url) || /^file:\/\//i.test(url) || /^devtools:\/\//i.test(url)) return true;
  return !!MAIN_WINDOW_VITE_DEV_SERVER_URL && url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL);
}
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!appWindowContentIds.has(contents.id)) return; // viewer windows load remote docs — allowed
    if (!isAppContentUrl(url)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});

// Single validated opener for BOTH external-URL channels. Only http(s) (and the
// app's own docvex:// scheme) is allowed — so a compromised/XSS renderer can't
// pass file://, ms-msdt:, or a UNC path (\\host\share) to shell.openExternal and
// launch a local program or force an SMB auth (NetNTLM leak). Keeping both
// channels on one guard stops them drifting apart again.
function openExternalSafe(url) {
  if (typeof url !== 'string') return;
  if (/^https?:\/\//i.test(url) || /^docvex:\/\//i.test(url)) {
    shell.openExternal(url);
  }
}

// OAuth + release links open in the system browser via the same guard.
ipcMain.on('oauth:open-external', (_, url) => openExternalSafe(url));
// Generic external-URL opener (release links, GitHub, etc.).
ipcMain.on('app:open-external', (_, url) => openExternalSafe(url));

// Custom window controls — the window is frameless (frame:false), so the
// renderer's title bar owns minimize / maximize / close. Multi-window now, so
// each control acts on the window that SENT the event (not just mainWindow).
// The renderer queries the current maximized state on mount and subscribes to
// changes so it shows the right maximize⇄restore glyph.
ipcMain.on('window:minimize', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.minimize();
});
ipcMain.on('window:toggle-maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  // Respect the auth-screen lock: when the window is pinned non-maximizable
  // (signed-out screen), the custom title bar's maximize button is inert so
  // the lock can't be bypassed.
  if (!w.isMaximizable()) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on('window:close', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close();
});
ipcMain.handle('window:is-maximized', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  return !!(w && w.isMaximized());
});
ipcMain.handle('window:is-fullscreen', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  return !!(w && w.isFullScreen());
});

// (The old `window:auth-state` channel is gone. The signed-out screen used to
// resize the APP window into a login box and restore it afterwards, which meant
// every launch through sign-in threw away the size the user had chosen. Signing
// in has its own window now — see openAuthWindow above.)

// Quit the entire app — fired by a deliberate logout. Closes every window
// (each runs its own close handler, so the main window still persists its
// bounds) and exits the process.
ipcMain.on('app:quit', () => {
  app.quit();
});

// Resolve the bundled favicon path ONCE at module load. The previous
// inline `path.join(__dirname, 'favicon.ico')` only worked in dev mode
// (where __dirname is the source `src/` directory). In packaged
// builds __dirname is `app.asar/.vite/build/` and the icon doesn't
// live there, so the BrowserWindow silently fell back to Electron's
// generic icon. `app.getAppPath()` returns the project root in dev
// and the app.asar root in packaged — same relative path resolves in
// both. If the file is missing for some reason we leave it null and
// the BrowserWindow inherits the .exe's embedded icon (which was set
// from the same favicon by electron-packager's packagerConfig).
const APP_ICON_PATH = (() => {
  try {
    const p = path.join(app.getAppPath(), 'src', 'favicon.ico');
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();

// Floating "READ ONLY" pill injected into every cloud-URL viewer
// window — same visual recipe as ProjectBanner.css's "Working in"
// pill (top-centre, fixed, gold-cognac fill, rounded ends, soft
// shadow). Colours are inlined because the loaded page is a remote
// origin (Supabase storage, view.officeapps.live.com) where our
// :root token variables aren't available.
//
// The script runs in the loaded page's main frame after every
// successful navigation — Chromium's PDF viewer, the image/video
// auto-wrapper, and Office Online all expose a `document.body` we
// can append to. The dataset marker keeps the inject idempotent so
// SPA navigations / cross-origin redirects don't stack multiple
// pills. Office Online and the PDF viewer ARE cross-origin from
// our window, but executeJavaScript runs in the page's own context
// so same-origin rules don't apply.
const READ_ONLY_PILL_INJECT = `
(() => {
  if (document.getElementById('docvex-read-only-pill')) return;
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => {
      window.__docvexInjectPill && window.__docvexInjectPill();
    }, { once: true });
    return;
  }
  const pill = document.createElement('div');
  pill.id = 'docvex-read-only-pill';
  pill.textContent = 'READ ONLY';
  pill.setAttribute('aria-label', 'Read-only view');
  pill.style.cssText = [
    'position: fixed',
    'top: 0.75rem',
    'left: 50%',
    'transform: translateX(-50%)',
    'z-index: 2147483647',
    'display: inline-flex',
    'align-items: center',
    'justify-content: center',
    'background: #8B4513',
    'color: #FFF8E7',
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif',
    'font-size: 0.78rem',
    'font-weight: 700',
    'letter-spacing: 0.08em',
    'border-radius: 999px',
    'border: 1px solid rgba(255, 248, 231, 0.18)',
    'line-height: 1.4',
    'padding: 0.4rem 1rem',
    'white-space: nowrap',
    'box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32)',
    'pointer-events: none',
    'user-select: none',
  ].join(';') + ';';
  document.body.appendChild(pill);
})();
`;

// Helper — wraps the "open this URL inside a DocVex BrowserWindow"
// boilerplate used by every in-app viewer path (raw-load + Office
// Online). Title is pinned against page-title-updated so Chromium's
// PDF viewer / Office Online iframe can't overwrite our chrome.
//
// Cloud-URL opens (https://…) get a "(READ ONLY)" suffix on the
// title AND a floating pill injected into the page (see
// READ_ONLY_PILL_INJECT above) because the signed Supabase URL is
// GET-only — any edit attempt inside Office Online / PDF.js / a
// video element has nowhere to save back to. localfile:// URLs
// render the user's own local working copy, which IS editable via
// the OS, so neither the title marker nor the pill applies there.
function openInAppWindow(url, fileName) {
  const isCloud = /^https?:\/\//i.test(url);
  const title = isCloud
    ? `DocVex - ${fileName} (READ ONLY)`
    : `DocVex - ${fileName}`;
  // Open on the same monitor as the base app.
  const pos = centeredOnDisplayOf(mainWindow, 1100, 800);
  const opts = {
    width: pos.width,
    height: pos.height,
    x: pos.x,
    y: pos.y,
    title,
    // No preload + sandbox defaults: this window only renders the
    // signed file URL / external viewer page, it never needs access
    // to electronAPI / fs.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (APP_ICON_PATH) opts.icon = APP_ICON_PATH;
  const win = new BrowserWindow(opts);
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    win.setTitle(title);
  });
  win.setMenu(null);
  wireDevtoolsShortcuts(win);

  if (isCloud) {
    // Re-inject on every navigation — Office Online does internal
    // redirects to its rendering host (officeapps.live.com →
    // word-edit.officeapps.live.com), and Chromium's PDF viewer
    // counts as its own navigation. Each navigation rebuilds
    // document.body, dropping the previously-injected node.
    const inject = () => {
      win.webContents.executeJavaScript(READ_ONLY_PILL_INJECT, true)
        .catch(() => { /* page may have torn down mid-inject; harmless */ });
    };
    win.webContents.on('did-finish-load', inject);
    win.webContents.on('did-frame-finish-load', (_e, isMainFrame) => {
      if (isMainFrame) inject();
    });
  }

  win.loadURL(url);
  return win;
}

// Open a file URL inside its own in-app BrowserWindow — replaces the
// shell.openExternal path for "View" so images / videos / PDFs render
// inside DocVex's chrome (titled "DocVex - <filename>" with the app
// icon) instead of being handed off to the user's default browser.
//
// Allowed URL schemes for the file URL:
//   • http(s)    — signed Supabase URLs for cloud-backed files.
//   • localfile  — our own protocol handler (registered above) for
//                  My-branch files on disk.
// Other schemes are rejected — keeps a compromised renderer from
// smuggling a navigation that bypasses our security model.
//
// DOCX has its own IPC (`app:open-docx`) because the routing fans
// out: try Word locally → fall back to Office Online → fall back
// to OS default. That logic doesn't belong wedged inside this
// browser-native-types path.
ipcMain.on('app:open-file-window', (_, payload) => {
  const url = payload?.url;
  const fileName = typeof payload?.fileName === 'string' ? payload.fileName : 'file';
  if (typeof url !== 'string') return;
  if (!/^https?:\/\//i.test(url) && !/^localfile:\/\//i.test(url)) return;
  // Allow the localfile:// handler to serve the file being opened here.
  if (/^localfile:\/\//i.test(url)) {
    try { registerLocalfileFile(decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))); }
    catch { /* malformed URL — openInAppWindow will fail harmlessly */ }
  }
  openInAppWindow(url, fileName);
});

// Surface a single known file path for localfile:// preview WITHOUT opening
// a window — used by the case-timeline's source-file thumbnails: a timeline
// restored from storage carries absolute paths whose folders may never have
// been opened this session, so without this the thumbnail requests fall
// outside the containment roots and 403. Grants the same per-file dirname
// scope the doc-viewer/file-window paths already get.
// invoke-style so the renderer can AWAIT registration before mounting the
// <img> tiles — a fire-and-forget send could lose the race against the
// first thumbnail fetch.
ipcMain.handle('localfile:allow-file', (_, p) => {
  if (typeof p === 'string' && p) registerLocalfileFile(p);
  return true;
});

// Open an arbitrary HTML string in its own in-app window. Used by the
// .docx viewer: Chromium can't render .docx bytes natively, so the
// renderer rasterizes the document to self-contained HTML via
// docx-preview (styles inlined, images base64) and hands the markup
// here. We stage it to a temp file and loadFile() it — top-level data:
// URL navigation is blocked by Chromium, and the sandboxed renderer
// can't write files itself. The temp file is deleted once the window has
// parsed it (the inlined assets mean nothing references it afterwards).
async function openHtmlContentWindow(html, fileName) {
  const title = `DocVex - ${fileName} (READ ONLY)`;
  // Open on the same monitor as the base app.
  const pos = centeredOnDisplayOf(mainWindow, 1100, 800);
  const opts = {
    width: pos.width,
    height: pos.height,
    x: pos.x,
    y: pos.y,
    title,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (APP_ICON_PATH) opts.icon = APP_ICON_PATH;
  const win = new BrowserWindow(opts);
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    win.setTitle(title);
  });
  win.setMenu(null);
  wireDevtoolsShortcuts(win);

  const tmpFile = path.join(
    app.getPath('temp'),
    `docvex-docx-${Date.now()}-${Math.random().toString(36).slice(2)}.html`,
  );
  try {
    await fsp.writeFile(tmpFile, html, 'utf8');
  } catch {
    win.destroy();
    return;
  }
  const cleanup = () => { fsp.unlink(tmpFile).catch(() => { /* temp dir self-cleans */ }); };
  win.webContents.once('did-finish-load', cleanup);
  win.on('closed', cleanup);
  win.loadFile(tmpFile);
}

ipcMain.on('app:open-html-window', (_, payload) => {
  const html = typeof payload?.html === 'string' ? payload.html : null;
  const fileName = typeof payload?.fileName === 'string' ? payload.fileName : 'file';
  if (!html) return;
  openHtmlContentWindow(html, fileName);
});

// Open a DOCX, walking a fallback chain so the user always gets the
// best available render:
//
//   1. WINWORD.EXE found on disk (most reliable detection — see
//      getWinwordPath above) → spawn Word directly with the file
//      path or URL as a positional arg. Bypasses the registry, so it
//      works for Click-to-Run, Microsoft Store, and MSI installs
//      even when the ms-word: protocol isn't registered.
//
//   2. ms-word: URL scheme registered (fallback for unusual installs
//      where WINWORD.EXE lives somewhere we didn't probe)
//      a. localPath → shell.openPath. Whatever app the OS has
//         registered for .docx — Word when it's the default.
//      b. cloudUrl → shell.openExternal('ms-word:ofe|u|<url>').
//         Word fetches the URL itself; `ofe` = open for edit.
//
//   3. No Word, cloudUrl available → Office Online viewer
//      (https://view.officeapps.live.com/op/view.aspx?src=…) rendered
//      inside an in-app BrowserWindow. Microsoft's servers fetch the
//      signed URL and produce a full-fidelity Word render.
//
//   4. No Word, only localPath → shell.openPath. OS picks whatever
//      DOCX handler the user has, or surfaces an "Open with…" dialog.
//
// `ms-word:` URL grammar:
//   ms-word:ofv|u|<url>   — open for view (read-only).
//   ms-word:ofe|u|<url>   — open for edit (DocVex uses this so the
//                           user can edit immediately on open).
// Reference: https://learn.microsoft.com/office/client-developer/office-uri-schemes
//
// Routing:
//   • cloudUrl present  → Office Online (web Word) in a new DocVex
//                          BrowserWindow. Unconditional — no more
//                          "try local Word first" detour. Office
//                          Online's view UI is consistent on every
//                          machine and matches the read-only semantics
//                          of a signed Supabase URL (which is GET-
//                          only — Word's local Save would fail with
//                          a 403 anyway, then drop into a confusing
//                          Save-As dialog). The user explicitly asked
//                          for "the web version of Word" for cloud
//                          DOCX, so the local-Word branch is gone.
//   • localPath only    → local file on disk. Local Word handles
//                          this best (in-place save + watcher picks
//                          up the edit). Fall back to `ms-word:` URL
//                          scheme, then to `shell.openPath` so the
//                          OS default DOCX handler takes over.
ipcMain.on('app:open-docx', (_, payload) => {
  const localPath = typeof payload?.localPath === 'string' && payload.localPath
    ? payload.localPath
    : null;
  const rawCloudUrl = typeof payload?.cloudUrl === 'string' ? payload.cloudUrl : null;
  const cloudUrl = rawCloudUrl && /^https?:\/\//i.test(rawCloudUrl) ? rawCloudUrl : null;
  const fileName = typeof payload?.fileName === 'string' ? payload.fileName : 'file';
  if (!localPath && !cloudUrl) return;
  if (localPath) registerLocalfileFile(localPath);

  // Cloud DOCX → Office Online viewer in a fresh window. The
  // openInAppWindow helper handles the title (DocVex - <name>
  // (READ ONLY)), the icon, and the floating READ ONLY pill inject.
  if (cloudUrl) {
    const officeOnlineUrl = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(cloudUrl)}`;
    openInAppWindow(officeOnlineUrl, fileName);
    return;
  }

  // Local DOCX → keep the Word-on-disk chain so the user can edit
  // in place. Local Word saves directly to the file; our watcher
  // picks the change up into the diff layer like any other edit.
  const winwordPath = getWinwordPath();
  if (winwordPath && spawnWord(winwordPath, localPath)) return;
  if (app.getApplicationNameForProtocol('ms-word:')) {
    shell.openPath(localPath);
    return;
  }
  // No Word installed — let the OS pick whatever DOCX handler the
  // user has registered.
  shell.openPath(localPath);
});

// Update IPC ---------------------------------------------------------------
ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:is-packaged', () => app.isPackaged);
// OS + CPU arch for the running build. The renderer uses this to pick the
// right release asset for the manual-download update fallback (e.g. the
// arm64 vs x64 macOS zip) — see UpdatesContext.installerAssetFor.
ipcMain.handle('app:get-platform-info', () => ({
  platform: process.platform,
  arch: process.arch,
}));

// One-shot pull of a docvex:// URL captured at cold start (see argv scan
// above). Renderer calls this once during AuthContext mount; we hand back
// the URL and clear it so a remount (StrictMode double-effect in dev) or a
// later refetch can't replay the deep-link. Returns null when nothing is
// pending. The `second-instance` event continues to push subsequent URLs
// via the `oauth:callback-url` channel — this handle is only for the
// FIRST-launch race that the event misses.
ipcMain.handle('app:get-startup-deep-link', () => {
  const url = pendingStartupDeepLink;
  pendingStartupDeepLink = null;
  return url;
});

ipcMain.handle('update:check', async () => {
  // Return last-known status synchronously; autoUpdater.checkForUpdates is
  // a no-op in dev (Squirrel can't update an unpackaged app).
  if (!app.isPackaged) return { state: 'dev' };
  // macOS/Linux: unsigned build — Squirrel can't apply updates in place. Tell
  // the renderer to use its manual browser-download fallback instead of
  // spinning forever on a 'checking' state that never resolves.
  if (!AUTO_UPDATE_SUPPORTED) return { state: 'unsupported' };
  // Already staged: Squirrel has fully applied the update to the next-launch
  // folder — re-checking here can emit `update-not-available` and clobber the
  // 'downloaded' state (the renderer's "restart to apply" prompt would
  // vanish). Re-broadcast + return it instead so the UI settles on the
  // restart prompt rather than hanging on a re-download that never comes.
  if (updateStatus.state === 'downloaded') {
    sendUpdateStatus(updateStatus);
    return updateStatus;
  }
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    sendUpdateStatus({ state: 'error', message: String(err?.message || err) });
  }
  return updateStatus;
});

// Pull-based recovery of the last-known updater status. update:status is
// push-only, so a renderer that mounts (or reloads) AFTER the background
// download already finished would otherwise sit at 'idle' forever and never
// show the restart prompt. UpdatesContext calls this once at mount.
ipcMain.handle('update:get-status', () => updateStatus);

ipcMain.on('update:install', () => {
  if (app.isPackaged && updateStatus.state === 'downloaded') {
    autoUpdater.quitAndInstall();
  }
});

// ── macOS self-update ──────────────────────────────────────────────────────
// The macOS build isn't Developer-ID signed, so Squirrel.Mac's autoUpdater
// can't apply updates (see AUTO_UPDATE_SUPPORTED). To still give Mac users a
// one-click "update my app" button, we reimplement the essential steps that
// Squirrel.Mac would otherwise do: download the new build's .zip, extract it,
// swap the running .app bundle for the new one, and relaunch. No signature
// verification — acceptable for a self-distributed app. Because we replace the
// ENTIRE bundle (matching binary + asar together), the embedded-asar-integrity
// fuse stays satisfied.

// Resolve the running app's .app bundle from the executable path, e.g.
// /Applications/docvex.app/Contents/MacOS/docvex → /Applications/docvex.app.
// Returns null when not running from a bundle (dev / bare binary).
function currentMacAppBundle() {
  const marker = '.app/Contents/MacOS/';
  const idx = process.execPath.indexOf(marker);
  return idx === -1 ? null : process.execPath.slice(0, idx + 4); // keep ".app"
}

// Find the first *.app directory within `dir` (one level deep, then nested).
async function findDotApp(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory() && e.name.endsWith('.app')) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const nested = await findDotApp(path.join(dir, e.name));
      if (nested) return nested;
    }
  }
  return null;
}

// Stream a URL to disk, reporting integer percent via onProgress (best-effort:
// only fires when the server sends Content-Length).
async function downloadToFile(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  let lastPct = -1;
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
      if (total && onProgress) {
        const pct = Math.floor((received / total) * 100);
        if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      out.on('error', reject);
      out.end(resolve);
    });
  }
}

// Run a command, resolving on exit 0 and rejecting otherwise.
function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)),
    );
  });
}

ipcMain.handle('update:download-and-install', async (_evt, payload) => {
  const url = payload?.url;
  if (process.platform !== 'darwin') return { ok: false, error: 'Auto-install is only supported on macOS here.' };
  if (!app.isPackaged) return { ok: false, error: 'Auto-install only works in the installed app.' };
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'No valid download URL for this build.' };
  }
  const currentApp = currentMacAppBundle();
  if (!currentApp) return { ok: false, error: "Couldn't locate the installed app bundle." };

  let work;
  try {
    work = await fsp.mkdtemp(path.join(app.getPath('temp'), 'docvex-update-'));
    const zipPath = path.join(work, 'update.zip');
    const extractDir = path.join(work, 'extracted');
    await fsp.mkdir(extractDir, { recursive: true });

    // 1. Download the new build.
    sendUpdateStatus({ state: 'downloading', percent: 0 });
    await downloadToFile(url, zipPath, (percent) => {
      sendUpdateStatus({ state: 'downloading', percent });
    });

    // 2. Extract. ditto restores the framework symlinks + exec bits the zip
    //    stored (make-mac-zips.mjs preserves them as real symlinks).
    sendUpdateStatus({ state: 'installing' });
    await runCommand('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);

    // 3. Locate the new bundle.
    const newApp = await findDotApp(extractDir);
    if (!newApp) throw new Error('No .app found inside the downloaded archive.');

    // 4. Stage the new bundle right next to the target (same volume → atomic
    //    rename later) BEFORE we touch the installed app. Doing the copy now
    //    means a permission failure (e.g. no write access to /Applications)
    //    surfaces here, harmlessly, instead of mid-swap.
    const stagedApp = `${currentApp}.docvex-new`;
    const backupApp = `${currentApp}.docvex-old`;
    await fsp.rm(stagedApp, { recursive: true, force: true });
    await runCommand('/usr/bin/ditto', [newApp, stagedApp]);

    // 4b. Ad-hoc re-sign the staged bundle. The published macOS builds have
    //     their Electron fuses flipped AFTER the (linker) ad-hoc signature is
    //     applied — which happens whenever packaging runs on a non-macOS host,
    //     where forge.config.js's resetAdHocDarwinSignature can't run. That
    //     leaves the Electron Framework's signature invalid, so on Apple
    //     Silicon the kernel SIGKILLs the app at launch ("Code Signature
    //     Invalid", crashing inside fuses::IsRunAsNodeEnabled). A fresh ad-hoc
    //     re-sign on the user's own Mac makes the on-disk bytes match the
    //     signature again. Done BEFORE the swap so any failure aborts without
    //     touching the installed app. codesign ships with macOS itself, so
    //     this needs no Xcode install. Strip extended attributes first —
    //     codesign rejects FinderInfo / resource-fork "detritus" with
    //     "resource fork ... not allowed".
    await runCommand('/usr/bin/xattr', ['-cr', stagedApp]);
    await runCommand('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', stagedApp]);

    // 5. Hand off to a detached script that waits for THIS process to quit,
    //    swaps the bundle, and relaunches. A running process can't reliably
    //    replace its own bundle, so the script does it once we're gone. Paths
    //    are passed as argv (not interpolated into the script body) so they're
    //    injection-safe even with spaces / special chars.
    const scriptPath = path.join(work, 'apply-update.sh');
    const sh = [
      '#!/bin/bash',
      'set -e',
      'PID="$1"; CURRENT="$2"; STAGED="$3"; BACKUP="$4"; WORK="$5"',
      // Wait up to ~30s for the old app to exit so the swap is safe.
      'for i in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done',
      'rm -rf "$BACKUP"',
      'mv "$CURRENT" "$BACKUP"',
      // Roll back if the swap fails, so the user is never left without an app.
      'if ! mv "$STAGED" "$CURRENT"; then mv "$BACKUP" "$CURRENT"; exit 1; fi',
      '/usr/bin/xattr -dr com.apple.quarantine "$CURRENT" 2>/dev/null || true',
      'rm -rf "$BACKUP"',
      'open "$CURRENT"',
      'rm -rf "$WORK"',
      '',
    ].join('\n');
    await fsp.writeFile(scriptPath, sh, { mode: 0o755 });

    sendUpdateStatus({ state: 'ready-relaunch' });
    const child = spawn(
      '/bin/bash',
      [scriptPath, String(process.pid), currentApp, stagedApp, backupApp, work],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();

    // Give the renderer a beat to paint the relaunch state, then quit so the
    // handoff script can replace the bundle.
    setTimeout(() => app.quit(), 600);
    return { ok: true };
  } catch (err) {
    const message = String(err?.message || err);
    sendUpdateStatus({ state: 'error', message });
    if (work) fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: message };
  }
});
// --------------------------------------------------------------------------

// Local-folder sync IPC ----------------------------------------------------
// Backs the Files page's "download from cloud" workflow: the renderer
// chooses a folder, lists its contents, and asks main to fetch a batch
// of signed Supabase URLs into it. We do the file I/O here (not the
// renderer) because the renderer is sandboxed away from `fs` by
// contextIsolation, and because Node's streaming fetch + writeFile is
// the easiest path that avoids loading multi-MB videos into renderer
// memory just to pipe them back out.

// Map a filename's extension to a best-effort MIME type so the renderer
// can pick the right card icon (PDF / video / image / text / generic).
// Mirrors the categoriser in ProjectFiles.jsx so local + cloud cards
// bucket into the same Photos / Videos / Documents sections.
function guessMimeFromName(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!ext) return '';
  if (['jpg', 'jpeg'].includes(ext)) return 'image/jpeg';
  if (['png', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(ext)) return `image/${ext}`;
  if (['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(ext)) return `video/${ext}`;
  // Audio — WhatsApp voice notes are Ogg-Opus (`.opus`); the rest cover the
  // common shared-audio formats. Without these the localfile handler falls
  // back to octet-stream and Chromium refuses to decode the <audio> element.
  if (['opus', 'ogg', 'oga'].includes(ext)) return 'audio/ogg';
  if (ext === 'mp3') return 'audio/mpeg';
  if (['m4a', 'aac'].includes(ext)) return 'audio/mp4';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'md') return 'text/markdown';
  if (['txt', 'log', 'json', 'csv', 'xml', 'html', 'css', 'js', 'ts'].includes(ext)) return 'text/plain';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (['doc', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'application/octet-stream';
  return '';
}

// Strip path separators + Windows-reserved chars. The cloud filename
// almost always comes from `File.name` (already sanitised by the OS file
// picker), but a renamed display name could carry "/" or ":" — those
// would either escape the target dir or fail to create on Windows.
// Replace with underscore so a stray character doesn't blow up the
// whole batch.
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 240);
}

// Open the native folder picker. Returns the chosen absolute path, or
// null when the user canceled. `createDirectory` lets the picker offer
// a "New folder" button on macOS; on Windows the OS dialog has its own
// affordance and the flag is a no-op.
ipcMain.handle('local-folder:pick', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose download folder',
  });
  if (result.canceled) return null;
  const picked = result.filePaths?.[0] || null;
  if (picked) registerLocalfileRoot(picked);
  return picked;
});

// Per-project working directory. Each project auto-binds to a fixed folder
// under the user's Documents (`Documents/Docvex/<projectId>`) — there's no
// manual folder picking; the Files page calls this on mount to resolve (and
// create) the directory. Returns the absolute path.
// Resolve (and create on first use) the per-project local folder. THE SAME
// folder is used at project-creation time (ProjectCreate mirrors the new
// project to disk) and by the Files page — so files added in Files land in the
// project's own directory.
//
// Resolution order:
//   1. Registry hit  — .docvex-projects.json (in Documents/Docvex) maps
//      projectId → FULL folder path; reused even after a rename.
//   2. Legacy "Docvex/<uuid>" folder — adopted so old files aren't orphaned.
//   3. An existing "<baseDir>/<name>" folder whose .docvex.json claims this
//      project — adopted (covers projects created by the old hub flow).
//   4. New → create "<baseDir>/<name>" (baseDir = the user's chosen projects
//      directory from the hub; falls back to Documents/Docvex), de-duping
//      name collisions with a numeric suffix.
//
// Accepts a projectId string (back-compat) or { projectId, name, baseDir }.
function sanitizeFolderName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/[\\/:*?"<>|]/g, ' ')   // strip path-illegal characters
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')            // Windows: no trailing dot/space
    .slice(0, 80)
    .trim();
}

// Read the projectId a folder's .docvex.json sidecar claims (or null).
async function sidecarProjectId(dirPath) {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(dirPath, '.docvex.json'), 'utf8'));
    return j?.projectId || null;
  } catch { return null; }
}

ipcMain.handle('local-folder:project-dir', async (_, arg) => {
  const projectId = typeof arg === 'string' ? arg : arg?.projectId;
  const projectName = (arg && typeof arg === 'object') ? arg.name : undefined;
  const baseDir = (arg && typeof arg === 'object' && arg.baseDir) ? String(arg.baseDir) : null;
  if (!projectId) return { path: null, error: 'No project id' };
  try {
    const docvexRoot = path.join(app.getPath('documents'), 'Docvex');
    await fsp.mkdir(docvexRoot, { recursive: true });
    // Every per-project folder lives under this root (or the hub's baseDir), so
    // registering these covers all project files for localfile:// serving.
    registerLocalfileRoot(docvexRoot);
    if (baseDir) registerLocalfileRoot(baseDir);
    const registryPath = path.join(docvexRoot, '.docvex-projects.json');

    let registry = {};
    try { registry = JSON.parse(await fsp.readFile(registryPath, 'utf8')) || {}; }
    catch { registry = {}; }
    const writeRegistry = () => fsp.writeFile(registryPath, JSON.stringify(registry, null, 2)).catch(() => {});
    // Resolve a registry value (full path now; bare folder name for legacy
    // entries) to an absolute path.
    const toAbs = (v) => (path.isAbsolute(v) ? v : path.join(docvexRoot, v));

    // 1. Already mapped → reuse that folder.
    if (registry[projectId]) {
      const dir = toAbs(registry[projectId]);
      await fsp.mkdir(dir, { recursive: true });
      return { path: dir, error: null };
    }

    // 2. Legacy "<uuid>" folder under Docvex → adopt it.
    const legacy = path.join(docvexRoot, String(projectId));
    try {
      if ((await fsp.stat(legacy)).isDirectory()) {
        registry[projectId] = legacy;
        await writeRegistry();
        return { path: legacy, error: null };
      }
    } catch { /* none */ }

    // 3 + 4. Resolve under the project base dir (the hub's chosen folder), or
    // Documents/Docvex when none was given.
    const root = baseDir || docvexRoot;
    await fsp.mkdir(root, { recursive: true });
    const base = sanitizeFolderName(projectName) || String(projectId);
    const takenPaths = new Set(Object.values(registry).map(toAbs));

    let folderName = base;
    let n = 2;
    for (;;) {
      const dir = path.join(root, folderName);
      let exists = false;
      try { exists = (await fsp.stat(dir)).isDirectory(); } catch { exists = false; }
      if (!exists && !takenPaths.has(dir)) {
        await fsp.mkdir(dir, { recursive: true });
        registry[projectId] = dir;
        await writeRegistry();
        return { path: dir, error: null };
      }
      // Folder already there — adopt it only if it's already THIS project's
      // (sidecar match); otherwise try the next suffixed name so we never
      // dump files into an unrelated folder.
      if (exists && !takenPaths.has(dir) && (await sidecarProjectId(dir)) === projectId) {
        registry[projectId] = dir;
        await writeRegistry();
        return { path: dir, error: null };
      }
      folderName = `${base} (${n})`;
      n += 1;
    }
  } catch (err) {
    return { path: null, error: err?.message || String(err) };
  }
});

// Filenames that should never surface as "your project's files" — they
// are OS / editor bookkeeping artifacts that materialise transiently
// next to the documents the user actually cares about. Leaving them
// visible causes three classes of bugs:
//   1. Word's `~$report.docx` lockfile appears as a phantom new file
//      every time the user opens a .docx for editing, gets minted a
//      sidecar UUID, and rides into the next commit (the bug the
//      user explicitly hit and reported).
//   2. Vim / IDE swap files (`.swp`, `.swo`, `*~`) flicker in and out
//      of the list, racing the watcher debounce.
//   3. macOS / Windows file managers drop hidden metadata (`.DS_Store`,
//      `desktop.ini`, `Thumbs.db`) the user never agreed to share.
//
// The check is filename-only — we don't try to peek at file headers
// or sizes. Anything matching one of these patterns is dropped from
// the list before it has a chance to be hashed, reconciled with the
// sidecar, or compared against cloud state.
function isIgnoredLocalFilename(name) {
  if (!name) return true;
  // Dotfiles cover the broadest swath: .DS_Store, .git, .vscode/,
  // .env, the sidecar's own .docvex.json, .Trashes, .Spotlight-V100,
  // etc. The Files tab is for documents, not config.
  if (name.startsWith('.')) return true;
  // Office lockfiles use ~$ prefix — Word, Excel, PowerPoint all do
  // this. The lockfile exists for the duration of the open session
  // and is deleted on clean close. Without this filter, a user
  // editing a .docx gets a phantom "~$Report.docx" card.
  if (name.startsWith('~$')) return true;
  // Vim / classic editor backup files end with ~ — e.g. `report.docx~`.
  if (name.endsWith('~')) return true;
  // Editor swap files — Vim / NeoVim are the dominant offenders.
  if (/\.(swp|swo|swn|swm)$/i.test(name)) return true;
  // Lockfile patterns from various OSes / editors (LibreOffice's
  // `.~lock.report.docx#`, OS-level `.lock`, `.lck`). The dotfile
  // rule catches LibreOffice's because it starts with `.`; the
  // generic `.lock` / `.lck` extension catch covers third parties.
  if (/\.(lock|lck)$/i.test(name)) return true;
  // Generic temp scratch — most apps write `*.tmp` and `*.temp` next
  // to the open file for atomic rename-on-save. They disappear after
  // save but the watcher tick can catch them mid-flight.
  if (/\.(tmp|temp|bak|partial|crdownload|part)$/i.test(name)) return true;
  // Windows folder metadata (capital-T variant for older releases).
  if (name === 'Thumbs.db' || name === 'thumbs.db') return true;
  if (name === 'desktop.ini' || name === 'Desktop.ini') return true;
  if (name === 'ehthumbs.db') return true;
  // macOS quirks not always caught by the dotfile rule.
  if (name === 'Icon\r') return true; // Finder custom-icon marker
  return false;
}

// List regular files in `dir`. Subdirectories are filtered out — the
// Files tab is flat by design, and recursing could surface a project's
// node_modules. Each entry carries size + mtime so the card meta line
// can show the same "size · date" pair the cloud cards use.
ipcMain.handle('local-folder:list', async (_, dir) => {
  if (!dir) return { files: [], dirs: [], error: 'No directory specified' };
  registerLocalfileRoot(dir); // the user is viewing this folder → its files are serveable
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files = [];
    const dirs = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Hide dotfolders (.git, .vscode, …) — same "show only the
        // project's stuff" spirit as the file-noise filter. Visible
        // folders are what the user organises with.
        if (entry.name.startsWith('.')) continue;
        try {
          const full = path.join(dir, entry.name);
          const stat = await fsp.stat(full);
          // `empty` = no VISIBLE entries inside (ignoring dotfolders +
          // noise files) — drives the outline-vs-filled folder icon.
          let empty = true;
          try {
            const children = await fsp.readdir(full, { withFileTypes: true });
            empty = !children.some((c) => (
              c.isDirectory()
                ? !c.name.startsWith('.')
                : (c.isFile() && !isIgnoredLocalFilename(c.name))
            ));
          } catch { /* unreadable → treat as empty */ }
          dirs.push({ name: entry.name, path: full, mtimeIso: stat.mtime.toISOString(), empty });
        } catch { /* skip dirs we can't stat */ }
        continue;
      }
      if (!entry.isFile()) continue;
      // Drop OS / editor / lockfile noise so the local pane reads
      // as "your project's documents" only. See isIgnoredLocalFilename
      // for the exact pattern set and the rationale per pattern.
      if (isIgnoredLocalFilename(entry.name)) continue;
      try {
        const full = path.join(dir, entry.name);
        const stat = await fsp.stat(full);
        files.push({
          name: entry.name,
          path: full,
          sizeBytes: stat.size,
          mtimeIso: stat.mtime.toISOString(),
          mimeType: guessMimeFromName(entry.name),
        });
      } catch { /* skip files we can't stat (permission, symlink to gone target) */ }
    }
    // Newest first — matches the cloud list's `uploaded_at DESC` order.
    files.sort((a, b) => (a.mtimeIso < b.mtimeIso ? 1 : -1));
    // Folders alphabetical — a stable, scannable order for navigation.
    dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return { files, dirs, error: null };
  } catch (err) {
    return { files: [], dirs: [], error: err?.message || 'Could not read directory' };
  }
});

// Filesystem facts for ONE path — the Doc Viewer's Metadata tab reads the
// dates/size the OS holds (which no amount of parsing the bytes can give).
// Returns `{ error }` rather than throwing so the panel can show a row-level
// failure instead of losing the whole extraction.
ipcMain.handle('local-folder:stat', async (_, filePath) => {
  if (!filePath) return { error: 'No path specified' };
  try {
    const stat = await fsp.stat(filePath);
    return {
      path: filePath,
      name: path.basename(filePath),
      dir: path.dirname(filePath),
      sizeBytes: stat.size,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      mtimeIso: stat.mtime.toISOString(),
      // Creation time is only real on Windows/macOS; on Linux birthtime can
      // come back as the epoch or equal to ctime — the panel just shows it.
      birthtimeIso: stat.birthtime ? stat.birthtime.toISOString() : null,
      ctimeIso: stat.ctime.toISOString(),
      atimeIso: stat.atime.toISOString(),
      // POSIX permission bits, e.g. 644. Windows reports a synthesised mode.
      mode: (stat.mode & 0o777).toString(8),
      error: null,
    };
  } catch (err) {
    return { error: err?.message || 'Could not read file info' };
  }
});

// Recursive listing — every file anywhere under `dir`, each tagged with
// its `folderPath` (relative dir from the root, forward-slash separated,
// '' for root). This is the SYNC source: the branch flow needs to see
// files in subfolders so the folder structure can sync to the team.
// Dotfolders + noise files are skipped, same as the flat list.
async function walkLocalDir(root, rel, out) {
  const dir = rel ? path.join(root, rel) : root;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      await walkLocalDir(root, childRel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isIgnoredLocalFilename(entry.name)) continue;
    try {
      const full = path.join(dir, entry.name);
      const stat = await fsp.stat(full);
      out.push({
        name: entry.name,
        path: full,
        folderPath: rel || '',
        sizeBytes: stat.size,
        mtimeIso: stat.mtime.toISOString(),
        mimeType: guessMimeFromName(entry.name),
      });
    } catch { /* skip unstattable */ }
  }
}

ipcMain.handle('local-folder:list-recursive', async (_, dir) => {
  if (!dir) return { files: [], error: 'No directory specified' };
  registerLocalfileRoot(dir); // recursive listing → the whole subtree is serveable
  try {
    const files = [];
    await walkLocalDir(dir, '', files);
    files.sort((a, b) => (a.mtimeIso < b.mtimeIso ? 1 : -1));
    return { files, error: null };
  } catch (err) {
    return { files: [], error: err?.message || 'Could not read directory' };
  }
});

// ── Folder management (My-branch local organisation) ──────────────────
// Create / delete a subfolder and move a file between folders, all
// confined to the picked branch folder via the same resolve + prefix
// guard the file ops use. Folders are a LOCAL organisation layer — the
// cloud project stays flat — so these never touch Supabase.
function sanitizeSegment(name) {
  // Single path segment only: strip separators + illegal chars so a
  // typed folder name can't escape the parent or break Windows.
  return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\.+$/, '').trim().slice(0, 120);
}

// Path-containment guard. A raw `resolved.startsWith(normalizedDir)` is unsafe:
// path.resolve() strips the trailing separator, so a SIBLING folder that shares
// the parent's name prefix (…\Proj vs …\Proj-x or "…\Proj Backup") passes the
// check and file ops escape the intended folder. Compare via path.relative
// instead and reject anything that walks up (`..`) or resolves absolute.
// `allowRoot` decides whether `target === root` counts as inside (default no —
// callers that operate ON children want the root itself rejected).
function isInsideDir(root, target, { allowRoot = false } = {}) {
  const rel = path.relative(root, target);
  if (rel === '') return allowRoot;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// A user-supplied name that must stay a single child segment of a directory
// (folder / rename handlers do `path.resolve(dir, name)`; a `..` or a separator
// would escape or retarget). True only for a plain in-place child name.
function isSingleSegment(name) {
  const s = String(name);
  return s.length > 0 && s !== '.' && s !== '..'
    && !s.includes('/') && !s.includes('\\') && !path.isAbsolute(s);
}

// ── localfile:// read allow-list ──────────────────────────────────────────
// The `localfile://` protocol streams file BYTES to the renderer. Without a
// containment check it would read ANY absolute path the renderer names, turning
// any content-injection / XSS foothold (or a crafted filename in an opened doc)
// into arbitrary local-file disclosure. We instead only serve files inside
// directories the user has actually surfaced through the app — folders they
// picked/listed/watched, the per-project Documents\Docvex tree, the WhatsApp
// extraction temp, and the parent of any file opened in a viewer window.
const localfileRoots = new Set();
function registerLocalfileRoot(dir) {
  if (!dir || typeof dir !== 'string') return;
  try { localfileRoots.add(path.resolve(dir)); } catch { /* ignore bad path */ }
}
// Permit a file by registering its containing directory (used when the renderer
// is handed a single file path, e.g. a Doc Viewer / file window).
function registerLocalfileFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return;
  try { localfileRoots.add(path.dirname(path.resolve(filePath))); } catch { /* ignore */ }
}
// Is `filePath` inside an allowed root? Resolves symlinks first (fs.realpath) so
// a symlink planted inside an allowed folder can't point out of it and leak an
// external file (defends the zip-symlink vector too).
async function isLocalfileAllowed(filePath) {
  if (!localfileRoots.size) return false;
  let real;
  try { real = await fsp.realpath(filePath); }
  catch { real = path.resolve(filePath); } // not-yet-existing → check resolved
  for (const root of localfileRoots) {
    let realRoot;
    try { realRoot = await fsp.realpath(root); } catch { realRoot = root; }
    if (real === realRoot || isInsideDir(realRoot, real, { allowRoot: true })) return true;
  }
  return false;
}

// Recursively delete any SYMLINK entries from a just-extracted archive tree. A
// malicious zip can carry a symlink entry whose target points OUTSIDE the
// extraction folder (extract-zip blocks `..` in names but writes symlinks
// verbatim, CWE-59); left in place a later read/write could follow it out of
// containment. Dirent.isSymbolicLink()/isDirectory() come from lstat, so we
// never traverse INTO a symlinked directory.
async function stripSymlinks(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      await fsp.rm(full, { force: true }).catch(() => { /* best-effort */ });
    } else if (entry.isDirectory()) {
      await stripSymlinks(full);
    }
  }
}

ipcMain.handle('local-folder:create-folder', async (_, payload) => {
  const dir = payload?.dir;
  const name = sanitizeSegment(payload?.name || '');
  if (!dir || !name) return { error: 'Missing or invalid name' };
  try {
    const normalizedDir = path.resolve(dir);
    const target = path.resolve(dir, name);
    if (!isInsideDir(normalizedDir, target)) return { error: 'Path outside branch folder' };
    await fsp.mkdir(target); // non-recursive: throws EEXIST if it exists
    return { ok: true, name, path: target, error: null };
  } catch (err) {
    if (err?.code === 'EEXIST') return { error: 'A folder with that name already exists' };
    return { error: err?.message || String(err) };
  }
});

ipcMain.handle('local-folder:delete-folder', async (_, payload) => {
  const dir = payload?.dir;
  const name = payload?.name;
  if (!dir || !name) return { error: 'Missing args' };
  // `name` must be a single child segment — reject `..`/separators so a crafted
  // payload can't resolve to a sibling or parent directory.
  if (!isSingleSegment(name)) return { error: 'Invalid folder name' };
  try {
    const normalizedDir = path.resolve(dir);
    const target = path.resolve(dir, name);
    // Must be strictly inside the parent (never the parent itself).
    if (!isInsideDir(normalizedDir, target)) {
      return { error: 'Path outside branch folder' };
    }
    await fsp.rm(target, { recursive: true, force: true });
    return { ok: true, error: null };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
});

// Move a file (or folder) into another folder. `root` is the branch
// folder boundary; both source and destination must resolve inside it.
ipcMain.handle('local-folder:move', async (_, payload) => {
  const root = payload?.root;
  const fromPath = payload?.fromPath;
  const toDir = payload?.toDir;
  if (!root || !fromPath || !toDir) return { error: 'Missing args' };
  try {
    const normalizedRoot = path.resolve(root);
    const from = path.resolve(fromPath);
    const to = path.resolve(toDir, path.basename(from));
    if (!isInsideDir(normalizedRoot, from) || !isInsideDir(normalizedRoot, to)) {
      return { error: 'Path outside branch folder' };
    }
    if (from === to) return { ok: true, error: null };
    // Refuse to clobber an existing destination entry.
    try {
      await fsp.access(to);
      return { error: 'An item with that name already exists in the destination' };
    } catch { /* doesn't exist — safe to move */ }
    await fsp.rename(from, to);
    return { ok: true, path: to, error: null };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
});

// Download a batch of cloud files into `dir`. Caller passes pre-signed
// URLs so we don't need Supabase credentials in the main process; we
// just fetch each URL and write the bytes. Results are returned per-
// file so the renderer can show a "3 of 5 downloaded" summary.
// Existing files at the target path are overwritten — the user
// explicitly asked to sync from cloud, so cloud is the source of
// truth.
// Only Supabase-hosted pre-signed storage URLs are ever legitimate download
// sources. Restricting to https + a *.supabase.co host turns the main-process
// fetch from an SSRF primitive (cloud-metadata 169.254.169.254, loopback/intranet
// services the renderer sandbox can't reach) into a narrow, expected call.
function isAllowedDownloadUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // no IP literals
  return host === 'supabase.co' || host.endsWith('.supabase.co');
}

ipcMain.handle('local-folder:download', async (_, payload) => {
  const dir = payload?.dir;
  const files = Array.isArray(payload?.files) ? payload.files : [];
  if (!dir) return { results: [], error: 'No directory specified' };
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    return { results: [], error: `Could not create directory: ${err?.message || err}` };
  }
  const results = [];
  for (const f of files) {
    if (!f?.url || !f?.filename) {
      results.push({ filename: f?.filename || '?', ok: false, error: 'Missing url or filename' });
      continue;
    }
    if (!isAllowedDownloadUrl(f.url)) {
      results.push({ filename: f.filename, ok: false, error: 'Blocked: URL is not a Supabase storage URL' });
      continue;
    }
    try {
      const res = await fetch(f.url, { redirect: 'error' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // f.subdir is the file's folder_path (relative, '' = root). Recreate
      // the structure so a teammate's download lands files in the same
      // folders. Each segment is sanitised + the resolved path is verified
      // to stay inside the branch folder.
      const relDir = (f.subdir || '').split('/').map(sanitizeSegment).filter(Boolean).join(path.sep);
      const targetDir = relDir ? path.join(dir, relDir) : dir;
      if (!isInsideDir(path.resolve(dir), path.resolve(targetDir), { allowRoot: true })) {
        throw new Error('Path outside branch folder');
      }
      if (relDir) await fsp.mkdir(targetDir, { recursive: true });
      const target = path.join(targetDir, sanitizeFilename(f.filename));
      await fsp.writeFile(target, buf);
      results.push({ filename: f.filename, path: target, ok: true });
    } catch (err) {
      results.push({ filename: f.filename, ok: false, error: err?.message || String(err) });
    }
  }
  return { results, error: null };
});

// Write user-provided bytes (typically files picked via the FAB on
// 'mine' branch) directly into the branch folder. Sibling of the
// download handler above, which fetches URLs — here the renderer
// already holds the bytes, so the IPC payload carries an
// ArrayBuffer per file. Filenames are sanitised the same way as
// download; collisions overwrite (last writer wins) so a re-upload
// of the same name behaves predictably.
ipcMain.handle('local-folder:write-files', async (_, payload) => {
  const dir = payload?.dir;
  const files = Array.isArray(payload?.files) ? payload.files : [];
  if (!dir) return { results: [], error: 'No directory specified' };
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    return { results: [], error: `Could not create directory: ${err?.message || err}` };
  }
  const results = [];
  for (const f of files) {
    if (!f?.filename || !f?.bytes) {
      results.push({ filename: f?.filename || '?', ok: false, error: 'Missing filename or bytes' });
      continue;
    }
    try {
      const buf = Buffer.from(f.bytes);
      const target = path.join(dir, sanitizeFilename(f.filename));
      await fsp.writeFile(target, buf);
      results.push({ filename: f.filename, path: target, ok: true });
    } catch (err) {
      results.push({ filename: f.filename, ok: false, error: err?.message || String(err) });
    }
  }
  return { results, error: null };
});

// Rename a file inside the user's branch folder. Used when the
// FileDetailModal name input is committed on the My branch view —
// the metadata-rename branch_change is queued in parallel; this
// IPC handles the actual on-disk move so File Explorer reflects
// the new name. Same defensive `path.resolve` + `startsWith(dir)`
// check as delete-files so a stray path can't escape the branch.
ipcMain.handle('local-folder:rename-file', async (_, payload) => {
  const dir = payload?.dir;
  const fromName = payload?.fromName;
  const toName = payload?.toName;
  if (!dir || !fromName || !toName) return { error: 'Missing args' };
  if (fromName === toName) return { ok: true, error: null };
  // A rename stays in-place: both names must be plain child segments so a
  // crafted `..\sibling` payload can't rename across folder boundaries.
  if (!isSingleSegment(fromName) || !isSingleSegment(toName)) {
    return { error: 'Invalid file name' };
  }
  try {
    const normalizedDir = path.resolve(dir);
    const fromPath = path.resolve(dir, fromName);
    const toPath = path.resolve(dir, toName);
    if (!isInsideDir(normalizedDir, fromPath) || !isInsideDir(normalizedDir, toPath)) {
      return { error: 'Path outside branch folder' };
    }
    await fsp.rename(fromPath, toPath);
    return { ok: true, error: null };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      // Source file already gone (raced with watcher, manual move).
      // Surface as a soft failure so the caller can refresh without
      // panic.
      return { error: 'Source file not found' };
    }
    return { error: err?.message || String(err) };
  }
});

// Open a local file (or its parent folder) in the OS file manager /
// default app. Used for the card click handler on local files and the
// "Open folder" button next to the local pane header.
ipcMain.handle('local-folder:open-path', async (_, targetPath) => {
  if (!targetPath) return '';
  // shell.openPath returns an empty string on success, an error message
  // on failure. Pass it through so the renderer can surface failures.
  return shell.openPath(targetPath);
});

// "Save as…" — copy a file already on disk (e.g. a WhatsApp chat attachment in
// the export folder) to a user-chosen location via the native save dialog.
ipcMain.handle('local-folder:save-as', async (_, srcPath) => {
  try {
    if (typeof srcPath !== 'string' || !srcPath) return { ok: false };
    const st = await fsp.stat(srcPath);
    if (!st.isFile()) return { ok: false, error: 'Not a file' };
    const res = await dialog.showSaveDialog({ defaultPath: path.basename(srcPath) });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    await fsp.copyFile(srcPath, res.filePath);
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// "Open contents" for a compressed file in the Files tab. A .zip is unpacked
// into a sibling folder named after the archive (deduped if it already exists)
// so the user can browse it inline; other formats (rar/7z/tar/gz) have no
// bundled extractor, so they're handed to the OS archiver via shell.openPath.
// Returns { ok, extracted, path, created } — `path` is the new folder when
// extracted, `created` false if we merged into a folder that already existed.
ipcMain.handle('local-folder:extract-archive', async (_, srcPath) => {
  try {
    if (typeof srcPath !== 'string' || !srcPath) return { ok: false };
    const st = await fsp.stat(srcPath);
    if (!st.isFile()) return { ok: false, error: 'Not a file' };

    if (!/\.zip$/i.test(srcPath)) {
      // No native extractor for this format — open it in the OS archiver.
      const err = await shell.openPath(srcPath);
      return err ? { ok: false, error: err } : { ok: true, extracted: false };
    }

    // Always unpack into ONE sibling folder named after the archive. If it
    // already exists, merge into it (extract-zip overwrites same-named files)
    // rather than spawning "name (2)", "name (3)" duplicates.
    const parent = path.dirname(srcPath);
    const baseName = path.basename(srcPath).replace(/\.zip$/i, '');
    const dest = path.join(parent, `${baseName} - unzipped`);
    // Whether WE created the folder decides if the extract is undoable: when it
    // already existed we've merged into someone else's files, and undoing by
    // deleting the folder would take those with it.
    let created = false;
    try { await fsp.stat(dest); } catch { created = true; }
    await fsp.mkdir(dest, { recursive: true });
    const { default: extract } = await import('extract-zip');
    await extract(srcPath, { dir: dest });
    // Strip any hostile symlink entries the archive planted (CWE-59 link-follow).
    await stripSymlinks(dest);
    return { ok: true, extracted: true, path: dest, created };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Reveal a local file in the OS file manager (Explorer on Windows,
// Finder on macOS, the default file manager on Linux) with the file
// pre-selected. Wired to the "Show in explorer" context-menu item
// on My-branch cards. Returns nothing useful (shell call is sync-ish
// and best-effort).
ipcMain.handle('local-folder:show-in-folder', async (_, targetPath) => {
  if (!targetPath) return { ok: false, error: 'No path' };
  try {
    shell.showItemInFolder(targetPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Delete a batch of files inside the user's branch folder. Used by
// the "Sync to main" flow when the local copy has files that no
// longer exist on main. We only accept paths INSIDE the chosen
// directory (`dir`) — defensive against a malformed path slipping
// through and deleting something outside the branch.
ipcMain.handle('local-folder:delete-files', async (_, payload) => {
  const dir = payload?.dir;
  const paths = Array.isArray(payload?.paths) ? payload.paths : [];
  if (!dir) return { results: [], error: 'No directory specified' };
  const results = [];
  // Normalize the dir prefix once so the inside-the-folder check is
  // a cheap startsWith on the canonical resolved path.
  let normalizedDir;
  try {
    normalizedDir = path.resolve(dir);
  } catch (err) {
    return { results: [], error: `Bad directory: ${err?.message || err}` };
  }
  for (const p of paths) {
    if (!p || typeof p !== 'string') {
      results.push({ path: p, ok: false, error: 'Invalid path' });
      continue;
    }
    let resolved;
    try {
      resolved = path.resolve(p);
    } catch (err) {
      results.push({ path: p, ok: false, error: err?.message || String(err) });
      continue;
    }
    if (!isInsideDir(normalizedDir, resolved)) {
      results.push({ path: p, ok: false, error: 'Path is outside branch folder' });
      continue;
    }
    try {
      await fsp.unlink(resolved);
      results.push({ path: p, ok: true });
    } catch (err) {
      // ENOENT is benign — the file's already gone, treat as success
      // so the sync's "delete these N files" tally still works.
      if (err?.code === 'ENOENT') {
        results.push({ path: p, ok: true });
      } else {
        results.push({ path: p, ok: false, error: err?.message || String(err) });
      }
    }
  }
  return { results, error: null };
});

// ── Filesystem watcher ────────────────────────────────────────────────
// Watches the user's branch folder for add / change / delete events
// and pings the renderer so it can re-list. One watcher at a time
// (we only ever have one selected folder); switching folders closes
// the old watcher and opens a new one. fs.watch emits multiple
// events per single user action (a save can fire rename + change),
// so we debounce 200ms before notifying.
//
// fs.watch on Windows is reliable for top-level adds/removes/renames
// in a single directory. It does NOT recurse into subdirectories,
// which matches the Files-tab semantics (the list itself is flat).
let watcher = null;
let watcherDebounce = null;
let watchedDir = null;

const stopWatcher = () => {
  if (watcher) {
    try { watcher.close(); } catch { /* swallow */ }
    watcher = null;
  }
  if (watcherDebounce) {
    clearTimeout(watcherDebounce);
    watcherDebounce = null;
  }
  watchedDir = null;
};

ipcMain.handle('local-folder:watch', (_, dir) => {
  stopWatcher();
  if (!dir) return { ok: true };
  registerLocalfileRoot(dir); // active folder → serveable
  try {
    // recursive so changes inside synced subfolders are noticed too
    // (Windows + macOS support recursive fs.watch; on platforms that
    // don't, it degrades to top-level only).
    watcher = fs.watch(dir, { persistent: false, recursive: true }, () => {
      // Debounce: collapse a burst of events (rename + change pairs
      // during a save) into a single notification.
      if (watcherDebounce) clearTimeout(watcherDebounce);
      watcherDebounce = setTimeout(() => {
        watcherDebounce = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('local-folder:changed', dir);
        }
      }, 200);
    });
    watcher.on('error', () => stopWatcher());
    watchedDir = dir;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('local-folder:unwatch', () => {
  stopWatcher();
  return { ok: true };
});

// Per-folder sidecar (.docvex.json) — the on-disk source of truth for
// "which filename IS which stable fileId". Lives next to the user's
// files so IDs survive a localStorage clear, ship to teammates via
// Dropbox/iCloud, and don't need a separate bootstrap pass when the
// user re-picks the folder. Both handlers operate INSIDE the chosen
// folder; we don't accept absolute paths to .docvex.json so a stray
// path can't escape and read/write arbitrary user files.
ipcMain.handle('local-folder:read-sidecar', async (_, dir) => {
  if (!dir) return { json: null, error: 'No directory specified' };
  try {
    const target = path.join(dir, '.docvex.json');
    const raw = await fsp.readFile(target, 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(raw); }
    catch (parseErr) { return { json: null, error: `Bad JSON: ${parseErr?.message || parseErr}` }; }
    return { json: parsed, error: null };
  } catch (err) {
    // ENOENT is the normal "no sidecar yet" case — return null without
    // surfacing an error so callers treat it as an empty mapping.
    if (err?.code === 'ENOENT') return { json: null, error: null };
    return { json: null, error: err?.message || String(err) };
  }
});

ipcMain.handle('local-folder:write-sidecar', async (_, payload) => {
  const dir = payload?.dir;
  const json = payload?.json;
  if (!dir) return { ok: false, error: 'No directory specified' };
  if (!json || typeof json !== 'object') return { ok: false, error: 'Invalid payload' };
  try {
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, '.docvex.json');
    await fsp.writeFile(target, JSON.stringify(json, null, 2), 'utf8');
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ── Recently deleted (local recycle bin) ─────────────────────────────
// Deleting a file in the Files page MOVES it into a hidden `.docvex-trash/`
// folder inside the picked project folder rather than unlinking it. Each
// trashed file gets a `deletedAt` timestamp recorded in
// `.docvex-trash/.trashmeta.json`, so the renderer can show a "Deletes in
// N days" countdown and the main process can auto-purge entries older than
// 30 days. `.docvex-trash` is a dotfolder, so it's already skipped by the
// list/walk handlers and never leaks into "My drafts".
const TRASH_DIRNAME = '.docvex-trash';
const TRASH_META_FILE = '.trashmeta.json';
const TRASH_RETENTION_DAYS = 30;

function trashDir(dir) {
  return path.join(dir, TRASH_DIRNAME);
}

async function readTrashMeta(dir) {
  try {
    const raw = await fsp.readFile(path.join(trashDir(dir), TRASH_META_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeTrashMeta(dir, meta) {
  await fsp.mkdir(trashDir(dir), { recursive: true });
  await fsp.writeFile(
    path.join(trashDir(dir), TRASH_META_FILE),
    JSON.stringify(meta, null, 2),
    'utf8',
  );
}

// Mint a collision-proof stored name: `<epoch>__<sanitized original>`.
// The timestamp prefix keeps repeated deletes of the same name distinct.
function mintStoredName(originalName, nowMs) {
  return `${nowMs}__${sanitizeFilename(originalName)}`;
}

// Core sweep used by BOTH the IPC handler and the periodic timer. Unlinks
// every trashed entry whose deletedAt is older than the cutoff, plus orphan
// files (in the trash dir without a meta record) older than the cutoff by
// mtime. Returns the number of files purged.
async function purgeTrashDir(dir, olderThanDays = TRASH_RETENTION_DAYS, nowMs = Date.now()) {
  const tdir = trashDir(dir);
  let entries;
  try {
    entries = await fsp.readdir(tdir, { withFileTypes: true });
  } catch {
    return 0; // no trash folder yet
  }
  const meta = await readTrashMeta(dir);
  const cutoff = nowMs - olderThanDays * 86400000;
  let purged = 0;
  let metaDirty = false;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === TRASH_META_FILE) continue;
    const stored = entry.name;
    const rec = meta[stored];
    let expired = false;
    if (rec?.deletedAt) {
      expired = Date.parse(rec.deletedAt) <= cutoff;
    } else {
      // Orphan with no record — fall back to file mtime.
      try {
        const stat = await fsp.stat(path.join(tdir, stored));
        expired = stat.mtimeMs <= cutoff;
      } catch { expired = false; }
    }
    if (!expired) continue;
    try {
      await fsp.unlink(path.join(tdir, stored));
      purged += 1;
    } catch (err) {
      if (err?.code !== 'ENOENT') continue;
    }
    if (rec) { delete meta[stored]; metaDirty = true; }
  }
  if (metaDirty) {
    try { await writeTrashMeta(dir, meta); } catch { /* best-effort */ }
  }
  return purged;
}

// Rename with a short retry on Windows lock errors. A file that was just
// written (flush still settling, antivirus scanning) or is briefly held by a
// preview window can throw EPERM/EBUSY on rename; a couple of quick retries
// clears the transient case (a file genuinely open in another app still fails).
async function renameWithRetry(from, to, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      const transient = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
      if (!transient || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
}

// Move a single file into the bin. `path` must resolve inside `dir`.
ipcMain.handle('local-folder:trash-file', async (_, payload) => {
  const dir = payload?.dir;
  const filePath = payload?.path;
  if (!dir || !filePath) return { ok: false, error: 'Missing args' };
  try {
    const normalizedDir = path.resolve(dir);
    const resolved = path.resolve(filePath);
    if (!isInsideDir(normalizedDir, resolved)) {
      return { ok: false, error: 'Path is outside project folder' };
    }
    const originalName = path.basename(resolved);
    // Record the file's location relative to the project root so a restore
    // can put it back where it came from (subfolder included).
    const originalRelDir = path
      .relative(normalizedDir, path.dirname(resolved))
      .split(path.sep).join('/');
    const nowMs = Date.now();
    const stored = mintStoredName(originalName, nowMs);
    await fsp.mkdir(trashDir(dir), { recursive: true });
    await renameWithRetry(resolved, path.join(trashDir(dir), stored));
    const meta = await readTrashMeta(dir);
    meta[stored] = { originalName, deletedAt: new Date(nowMs).toISOString(), originalRelDir };
    await writeTrashMeta(dir, meta);
    return { ok: true, stored, error: null };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, error: 'File not found' };
    if (err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES') {
      return { ok: false, error: 'The file is open in another program (e.g. Word or the preview window). Close it and try again.' };
    }
    return { ok: false, error: err?.message || String(err) };
  }
});

// Move an entire folder into the bin. There's no "trashed directory" concept —
// instead every file inside is trashed individually with its original relative
// path recorded, so a restore drops each file back where it lived (recreating
// the folder structure). After the files are moved out, the now-empty folder
// tree (plus any ignored/lock leftovers) is removed. Reuses all the existing
// trash machinery (list / restore / countdown / purge) — folders ride the same
// rails as single-file deletes. Returns the list of stored names so the caller
// can offer an undo that restores them all.
ipcMain.handle('local-folder:trash-folder', async (_, payload) => {
  const dir = payload?.dir;
  const folderPath = payload?.path;
  if (!dir || !folderPath) return { ok: false, error: 'Missing args' };
  try {
    const normalizedDir = path.resolve(dir);
    const resolved = path.resolve(folderPath);
    // Must be strictly inside the root (never the root itself or outside it).
    if (!isInsideDir(normalizedDir, resolved)) {
      return { ok: false, error: 'Path is outside project folder' };
    }
    const tdir = trashDir(dir);
    await fsp.mkdir(tdir, { recursive: true });
    const meta = await readTrashMeta(dir);
    const nowMs = Date.now();
    const deletedAt = new Date(nowMs).toISOString();
    const stored = [];
    let counter = 0;
    // Tag every file from this delete with one group id + the folder's own name
    // and parent location, so the bin can show ONE folder item (Windows-style)
    // instead of each file, and restore can recreate the folder where it lived.
    const folderGroup = `g${nowMs}`;
    const folderName = path.basename(resolved);
    const folderRelDir = path
      .relative(normalizedDir, path.dirname(resolved))
      .split(path.sep).join('/');
    // Recursively trash every file under the folder, preserving each file's
    // location relative to the project root so restore puts it back exactly.
    const walk = async (current) => {
      let entries;
      try { entries = await fsp.readdir(current, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.isFile()) continue;
        const originalRelDir = path
          .relative(normalizedDir, path.dirname(full))
          .split(path.sep).join('/');
        // nowMs + counter keeps the stored-name prefix unique across the batch
        // while every file shares one deletedAt (same 30-day countdown).
        const storedName = mintStoredName(entry.name, nowMs + counter);
        counter += 1;
        try {
          await fsp.rename(full, path.join(tdir, storedName));
          meta[storedName] = { originalName: entry.name, deletedAt, originalRelDir, folderGroup, folderName, folderRelDir };
          stored.push(storedName);
        } catch { /* skip unreadable */ }
      }
    };
    await walk(resolved);
    await writeTrashMeta(dir, meta);
    // Remove the now-empty folder tree (and any leftover ignored/lock files).
    await fsp.rm(resolved, { recursive: true, force: true });
    return { ok: true, stored, error: null };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, error: 'Folder not found' };
    return { ok: false, error: err?.message || String(err) };
  }
});

// DEV-only: seed the bin with dummy files whose `deletedAt` is backdated so
// each one is N days from its 30-day purge. Drives the countdown-ring UI.
ipcMain.handle('local-folder:debug-seed-trash', async (_, payload) => {
  const dir = payload?.dir;
  const days = Array.isArray(payload?.days) ? payload.days : [];
  if (!dir) return { ok: false, error: 'No directory specified' };
  try {
    const tdir = trashDir(dir);
    await fsp.mkdir(tdir, { recursive: true });
    const meta = await readTrashMeta(dir);
    const nowMs = Date.now();
    let count = 0;
    for (const d of days) {
      const daysLeft = Number(d);
      if (!Number.isFinite(daysLeft)) continue;
      const deletedAtMs = nowMs - Math.max(0, TRASH_RETENTION_DAYS - daysLeft) * 86400000;
      const originalName = `debug-expires-in-${daysLeft}d.txt`;
      const stored = mintStoredName(originalName, nowMs + count);
      await fsp.writeFile(path.join(tdir, stored), `Debug trash item — expires in ${daysLeft} day(s).\n`, 'utf8');
      meta[stored] = { originalName, deletedAt: new Date(deletedAtMs).toISOString(), originalRelDir: '' };
      count += 1;
    }
    await writeTrashMeta(dir, meta);
    return { ok: true, count, error: null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// List bin contents, joining each stored file with its meta record.
ipcMain.handle('local-folder:list-trash', async (_, dir) => {
  if (!dir) return { items: [], error: 'No directory specified' };
  const tdir = trashDir(dir);
  let entries;
  try {
    entries = await fsp.readdir(tdir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return { items: [], error: null };
    return { items: [], error: err?.message || String(err) };
  }
  const meta = await readTrashMeta(dir);
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === TRASH_META_FILE) continue;
    const stored = entry.name;
    const rec = meta[stored] || {};
    const full = path.join(tdir, stored);
    try {
      const stat = await fsp.stat(full);
      const originalName = rec.originalName || stored.replace(/^\d+__/, '');
      items.push({
        stored,
        originalName,
        deletedAt: rec.deletedAt || stat.mtime.toISOString(),
        originalRelDir: rec.originalRelDir || '',
        // Present only for files that were trashed as part of a folder delete —
        // lets the renderer collapse them into one folder item in the bin.
        folderGroup: rec.folderGroup || null,
        folderName: rec.folderName || '',
        folderRelDir: rec.folderRelDir || '',
        sizeBytes: stat.size,
        mimeType: guessMimeFromName(originalName),
        path: full,
      });
    } catch { /* skip unreadable */ }
  }
  // Most-recently-deleted first.
  items.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
  return { items, error: null };
});

// Restore a binned file back to its original location (subfolder included).
ipcMain.handle('local-folder:restore-from-trash', async (_, payload) => {
  const dir = payload?.dir;
  const stored = payload?.stored;
  if (!dir || !stored) return { ok: false, error: 'Missing args' };
  try {
    const from = path.join(trashDir(dir), stored);
    const meta = await readTrashMeta(dir);
    const rec = meta[stored] || {};
    const originalName = rec.originalName || stored.replace(/^\d+__/, '');
    const destDir = rec.originalRelDir ? path.join(dir, rec.originalRelDir) : dir;
    await fsp.mkdir(destDir, { recursive: true });
    let target = path.join(destDir, originalName);
    // Collision → suffix "(restored)" before the extension.
    try {
      await fsp.access(target);
      const ext = path.extname(originalName);
      const base = originalName.slice(0, originalName.length - ext.length);
      target = path.join(destDir, `${base} (restored)${ext}`);
    } catch { /* no collision */ }
    await fsp.rename(from, target);
    if (rec) { delete meta[stored]; await writeTrashMeta(dir, meta); }
    return { ok: true, restoredPath: target, error: null };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, error: 'File not found in bin' };
    return { ok: false, error: err?.message || String(err) };
  }
});

// Permanently delete a single binned file ("Delete forever").
ipcMain.handle('local-folder:delete-from-trash', async (_, payload) => {
  const dir = payload?.dir;
  const stored = payload?.stored;
  if (!dir || !stored) return { ok: false, error: 'Missing args' };
  try {
    try { await fsp.unlink(path.join(trashDir(dir), stored)); }
    catch (err) { if (err?.code !== 'ENOENT') throw err; }
    const meta = await readTrashMeta(dir);
    if (meta[stored]) { delete meta[stored]; await writeTrashMeta(dir, meta); }
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Sweep entries older than `olderThanDays` (default 30). Called by the
// renderer on folder open and by the periodic timer below.
ipcMain.handle('local-folder:purge-trash', async (_, payload) => {
  const dir = payload?.dir;
  const olderThanDays = payload?.olderThanDays ?? TRASH_RETENTION_DAYS;
  if (!dir) return { purged: 0, error: 'No directory specified' };
  try {
    const purged = await purgeTrashDir(dir, olderThanDays);
    return { purged, error: null };
  } catch (err) {
    return { purged: 0, error: err?.message || String(err) };
  }
});

// Periodic auto-sweep: every 6h, purge the currently-watched folder's bin.
// Main only knows the active folder (`watchedDir`); other folders are swept
// on open by the renderer. Cleared on before-quit alongside the watcher.
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let purgeTimer = null;
const stopPurgeTimer = () => {
  if (purgeTimer) { clearInterval(purgeTimer); purgeTimer = null; }
};

// Tear the watcher + purge timer down on quit so we don't leave handles dangling.
app.on('before-quit', () => { stopWatcher(); stopPurgeTimer(); });
// --------------------------------------------------------------------------

app.whenReady().then(() => {
  // Content-Security-Policy backstop for packaged builds. If any rendering
  // dependency (docx-preview, react-markdown, pdf.js, …) ever leaked injected
  // HTML into the privileged renderer, this caps the blast radius: scripts must
  // be app-origin, connections are limited to Supabase/GitHub/localfile, and
  // objects/base-uri/frame-ancestors are locked down so exfil + navigation
  // tricks are blocked. NOT applied in dev — Vite HMR needs eval + ws:.
  if (app.isPackaged) {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval' blob:",
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' localfile: data: blob: https:",
      "media-src 'self' localfile: blob: data:",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.github.com https://*.githubusercontent.com localfile: data: blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
  }

  // macOS dock icon. BrowserWindow({ icon }) is ignored on macOS (the dock
  // uses the bundle icon), and under `electron-forge start` the bundle is
  // Electron's, so the dock shows the generic Electron icon. Set it at
  // runtime from the same asset the window uses (copied next to main.js by
  // vite.main.config's copyMainIcon plugin). No-op on Windows/Linux.
  if (process.platform === 'darwin' && app.dock) {
    try {
      const dockIcon = nativeImage.createFromPath(path.join(__dirname, 'appicon_desktop.png'));
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
    } catch { /* non-fatal — fall back to the bundle icon */ }
  }

  // Resolve `localfile://local/<encoded-absolute-path>` requests by
  // streaming the file off disk via fs.createReadStream wrapped in a
  // Response. The renderer URL-encodes the full path as a single
  // segment, including drive letters / backslashes / spaces, so we
  // just decode the pathname and read directly — no further URL
  // wrangling.
  //
  // Why streaming + a Node ReadStream instead of net.fetch(file://…):
  //   • net.fetch on file:// hits ERR_UNEXPECTED on Windows when the
  //     path contains a drive letter that's been URL-parsed weirdly.
  //   • A Node stream wrapped in a Response gives the renderer
  //     proper byte-range support for `<video>` / `<img>` requests
  //     without buffering large files into memory.
  //
  // Security: reads are CONTAINED to directories the user has actually opened
  // through the app (isLocalfileAllowed / localfileRoots), resolved via
  // fs.realpath so a symlink can't point out of an allowed folder. Without this
  // the scheme would read any absolute path the renderer names, turning any
  // content-injection/XSS foothold into arbitrary local-file disclosure.
  // ── Thumbnail service (the `?thumb=N` branch below) ──────────────────────
  // The renderer paints tiles with a plain <img src="localfile://…?thumb=256">,
  // so this is where every file grid's thumbnail actually comes from. Three
  // things make it reliable under load, all of which the renderer used to lack:
  //
  //   • A CONCURRENCY GATE. createThumbnailFromPath goes out to the Windows
  //     Shell / QuickLook; hundreds of simultaneous calls (one folder of
  //     photos = one call per tile) make the providers slow down and start
  //     failing. Four at a time keeps them healthy and is still faster than
  //     the renderer could ever decode.
  //   • SINGLE-FLIGHT. Several windows (Files grid, sidebar, doc viewer) ask
  //     for the same file's thumbnail at the same moment; they share one job.
  //   • A DISK CACHE. Thumbnails survive restarts and folder revisits, so the
  //     second open of a folder paints instantly and costs the shell nothing.
  //     Keyed by path+mtime+width, so an edited file re-renders automatically.
  const thumbMemCache = new Map();      // key → { buffer, mime } | null (null = "can't")
  const thumbInflight = new Map();      // key → Promise
  const THUMB_MEM_MAX = 300;
  const THUMB_DISK_MAX_BYTES = 256 * 1024 * 1024;
  const THUMB_CONCURRENCY = 4;
  let thumbActive = 0;
  const thumbQueue = [];
  const thumbDir = () => path.join(app.getPath('userData'), 'thumbnails');

  function thumbPump() {
    while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
      const job = thumbQueue.shift();
      thumbActive += 1;
      // A rejection must resolve to null, not to the error object — a truthy
      // "thumbnail" would be served as an image body.
      job.run().then(job.resolve, () => job.resolve(null)).finally(() => {
        thumbActive -= 1;
        thumbPump();
      });
    }
  }
  function thumbSchedule(run) {
    return new Promise((resolve) => {
      thumbQueue.push({ run, resolve });
      thumbPump();
    });
  }

  // Cache filename for a key — hashed so path separators / length limits and
  // unicode filenames can't produce an invalid name.
  function thumbCacheFile(key, ext) {
    const hash = crypto.createHash('sha1').update(key).digest('hex');
    return path.join(thumbDir(), `${hash}.${ext}`);
  }

  // Trim the on-disk cache to THUMB_DISK_MAX_BYTES, oldest-accessed first.
  // Runs at most once per session start and then every ~500 writes.
  let thumbWritesSinceSweep = 0;
  async function sweepThumbCache() {
    try {
      const dir = thumbDir();
      const names = await fsp.readdir(dir);
      const entries = [];
      let total = 0;
      for (const n of names) {
        try {
          const st = await fsp.stat(path.join(dir, n));
          if (!st.isFile()) continue;
          entries.push({ file: path.join(dir, n), size: st.size, at: st.mtimeMs });
          total += st.size;
        } catch { /* vanished mid-sweep */ }
      }
      if (total <= THUMB_DISK_MAX_BYTES) return;
      entries.sort((a, b) => a.at - b.at);
      for (const e of entries) {
        if (total <= THUMB_DISK_MAX_BYTES) break;
        try { await fsp.unlink(e.file); total -= e.size; } catch { /* ignore */ }
      }
    } catch { /* no cache dir yet — nothing to sweep */ }
  }

  async function readThumbFromDisk(key, ext, mime) {
    try {
      const buffer = await fsp.readFile(thumbCacheFile(key, ext));
      if (!buffer?.length) return null;
      return { buffer, mime };
    } catch { return null; }
  }

  async function writeThumbToDisk(key, ext, buffer) {
    try {
      await fsp.mkdir(thumbDir(), { recursive: true });
      await fsp.writeFile(thumbCacheFile(key, ext), buffer);
      thumbWritesSinceSweep += 1;
      if (thumbWritesSinceSweep >= 500) {
        thumbWritesSinceSweep = 0;
        sweepThumbCache();
      }
    } catch { /* cache write is best-effort */ }
  }

  function rememberThumb(key, value) {
    if (thumbMemCache.size >= THUMB_MEM_MAX) {
      thumbMemCache.delete(thumbMemCache.keys().next().value);
    }
    thumbMemCache.set(key, value);
    return value;
  }

  // Per-extension verdict on whether this machine has a thumbnail provider at
  // all. Without it, a PC with no Office installed re-asks the shell for every
  // .docx in every folder, and the renderer logs a 415 for each. Only counted
  // from genuine "the provider returned nothing" results — a blocked path is
  // rejected long before it reaches here — and a couple of failures with zero
  // successes is what marks a format unsupported (so one corrupt file can't).
  const thumbExtStats = new Map();   // ext → { ok, fail }
  function noteExtResult(ext, ok) {
    if (!ext) return;
    const s = thumbExtStats.get(ext) || { ok: 0, fail: 0 };
    if (ok) s.ok += 1; else s.fail += 1;
    thumbExtStats.set(ext, s);
  }
  ipcMain.handle('thumb:unsupported-exts', () => (
    [...thumbExtStats.entries()]
      .filter(([, s]) => s.ok === 0 && s.fail >= 2)
      .map(([ext]) => ext)
  ));

  // Returns { buffer, mime } or null when this file has no OS thumbnail.
  async function thumbnailFor(filePath, mtimeMs, width, mime) {
    const key = `${filePath}:${mtimeMs}:${width}`;
    const hit = thumbMemCache.get(key);
    if (hit !== undefined) return hit;
    const inflight = thumbInflight.get(key);
    if (inflight) return inflight;

    // PNG sources keep alpha; everything else is smaller as JPEG.
    const asPng = mime === 'image/png';
    const ext = asPng ? 'png' : 'jpg';
    const outMime = asPng ? 'image/png' : 'image/jpeg';

    const job = (async () => {
      try {
        const cached = await readThumbFromDisk(key, ext, outMime);
        if (cached) return rememberThumb(key, cached);
        const built = await thumbSchedule(async () => {
          try {
            // OS thumbnailer (Windows Shell / macOS QuickLook) — fast, and
            // renders HEIC/RAW/Office/PDF that Chromium can't. Absent on most
            // Linux setups, where this simply returns null.
            const img = await nativeImage.createThumbnailFromPath(filePath, { width, height: width });
            if (!img || img.isEmpty()) return null;
            const buffer = asPng ? img.toPNG() : img.toJPEG(82);
            return buffer?.length ? { buffer, mime: outMime } : null;
          } catch { return null; }
        });
        noteExtResult(path.extname(filePath).slice(1).toLowerCase(), Boolean(built));
        if (built) writeThumbToDisk(key, ext, built.buffer);
        return rememberThumb(key, built);
      } finally {
        thumbInflight.delete(key);
      }
    })();
    thumbInflight.set(key, job);
    return job;
  }

  // One sweep per launch so a cache grown large in a previous session gets
  // trimmed even if this one writes little.
  sweepThumbCache();

  protocol.handle('localfile', async (request) => {
    let filePath = '';
    try {
      const url = new URL(request.url);
      // pathname is the encoded path segment; strip leading slash and
      // decode in one go.
      const raw = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
      filePath = decodeURIComponent(raw);
      // Containment: only serve files inside a directory the user has actually
      // opened through the app. Blocks arbitrary-path reads from a compromised
      // renderer or a crafted filename, and (via realpath) symlink escapes.
      if (!(await isLocalfileAllowed(filePath))) {
        return new Response('Forbidden', { status: 403 });
      }
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) {
        return new Response('Not a file', { status: 404 });
      }
      const mime = guessMimeFromName(filePath) || 'application/octet-stream';
      const total = stat.size;
      // CORS on every body response: the DocViewer's text-extraction tool
      // loads media with crossOrigin="anonymous" so it can draw the element
      // to a canvas and export the crop — without this header the CORS-mode
      // load fails outright, and without crossOrigin the canvas is tainted.
      const cors = { 'access-control-allow-origin': '*' };
      // `?thumb=N` — serve a downscaled thumbnail instead of the original
      // bytes. The WhatsApp reconstruction asks for these: painting 167
      // full-resolution camera photos into ~300px bubbles re-rasters tens of
      // megapixels every scroll frame, which is what tanks the frame rate on
      // media-heavy conversations. Videos are included — the OS thumbnailer
      // returns a poster frame (the same one Explorer shows), which the
      // file grids and the rail paint as the video's thumbnail. Only
      // opted-in formats are downscaled — webp/gif keep animation + alpha
      // and are small anyway, so they (and any failure here) fall through
      // to the normal full-file stream; callers must therefore check the
      // response's content-type before treating the bytes as an image.
      const thumbW = parseInt(url.searchParams.get('thumb') || '', 10);
      // Classification is EXTENSION-first: the MIME guesser reports plenty of
      // real formats (.heic, .pptx, legacy .doc/.xls/.ppt) as
      // application/octet-stream, and those are exactly the files that most
      // need the OS thumbnailer.
      const thumbExt = path.extname(filePath).slice(1).toLowerCase();
      // Images Chromium decodes itself. If no OS thumbnail exists we can
      // safely fall through and stream the original — an <img> will render it.
      const isBrowserImage = /^image\//.test(mime)
        || ['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico'].includes(thumbExt);
      // Formats an <img> can NOT decode. Streaming their raw bytes just paints
      // a broken image (and, for video, downloads megabytes to do it), so
      // these answer 415 and let the renderer fall back to its type glyph.
      const isOpaqueImage = ['tif', 'tiff', 'heic', 'heif', 'psd', 'ai', 'eps',
        'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2', 'raf', 'srw'].includes(thumbExt);
      const isVideoThumb = /^video\//.test(mime)
        || ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ogv'].includes(thumbExt);
      const isDocThumb = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'].includes(thumbExt);
      // Animated / vector formats are served as-is: a shell thumbnail would
      // freeze a GIF or WhatsApp sticker and rasterise an SVG, and all three
      // are small enough to paint directly. (The renderer's engine skips
      // asking for a thumb on these too — keep the two lists in step.)
      const isAnimatedOrVector = ['gif', 'webp', 'svg', 'ico'].includes(thumbExt)
        || /^image\/(gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/.test(mime);
      if (Number.isFinite(thumbW) && thumbW > 0 && !isAnimatedOrVector
          && (isBrowserImage || isOpaqueImage || isVideoThumb || isDocThumb)) {
        const body = await thumbnailFor(filePath, stat.mtimeMs, Math.min(1024, thumbW), mime);
        if (body) {
          return new Response(body.buffer, {
            headers: {
              ...cors,
              'content-type': body.mime,
              'content-length': String(body.buffer.length),
              // Immutable per URL: the renderer never reuses a thumb URL for
              // different bytes (the path encodes the file, and callers fold
              // mtime into the query so a save mints a new URL).
              'cache-control': 'max-age=3600',
            },
          });
        }
        // No thumbnail could be produced (Linux, no shell provider for this
        // format, a corrupt file). Only browser-decodable images fall through
        // to the raw stream; everything else says so plainly.
        if (!isBrowserImage) {
          return new Response('No thumbnail', { status: 415, headers: cors });
        }
      }
      // Honour HTTP Range requests so <audio>/<video> can seek and read
      // duration. Chromium needs a 206 partial response for this; an .ogg
      // voice note in particular reports duration = Infinity (and won't
      // scrub) when the server replies 200 with the whole body. Wrap the
      // Node Readable in a web ReadableStream so the Fetch Response accepts
      // it (ReadableStream.from — Electron 42 bundles Node 22).
      const range = request.headers.get('range');
      const rm = range && /bytes=(\d*)-(\d*)/.exec(range);
      if (rm) {
        let start = rm[1] ? parseInt(rm[1], 10) : 0;
        let end = rm[2] ? parseInt(rm[2], 10) : total - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end >= total) end = total - 1;
        if (start > end || start >= total) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { ...cors, 'content-range': `bytes */${total}`, 'accept-ranges': 'bytes' },
          });
        }
        const partStream = ReadableStream.from(fs.createReadStream(filePath, { start, end }));
        return new Response(partStream, {
          status: 206,
          headers: {
            ...cors,
            'content-type': mime,
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${total}`,
            'accept-ranges': 'bytes',
          },
        });
      }
      const webStream = ReadableStream.from(fs.createReadStream(filePath));
      return new Response(webStream, {
        headers: {
          ...cors,
          'content-type': mime,
          'content-length': String(total),
          'accept-ranges': 'bytes',
        },
      });
    } catch (err) {
      // Don't reflect the decoded path back — it would echo attacker-probed
      // paths. Log locally for debugging instead.
      console.error('localfile read error:', err?.message || err);
      return new Response('Could not read file', { status: err?.code === 'ENOENT' ? 404 : 500 });
    }
  });

  // Application menu:
  //  • Windows / Linux — none. setApplicationMenu(null) removes the bar entirely
  //    (the renderer's custom title bar carries everything).
  //  • macOS — a minimal native menu. macOS ALWAYS shows a menu bar at the top
  //    of the screen, and the standard editing/clipboard/window shortcuts
  //    (Cmd+C/V/X/A/Z, Cmd+Q/W/M/H) only work when their menu roles exist. With
  //    a null menu they silently break, so we install the standard roles. There
  //    is no File menu — the app is windowless-document by design.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        role: 'appMenu', // DocVex › About / Hide / Quit
      },
      {
        role: 'editMenu', // Undo / Redo / Cut / Copy / Paste / Select All
      },
      {
        label: 'View',
        submenu: [
          { role: 'togglefullscreen' },
          { type: 'separator' },
          { role: 'toggleDevTools' },
        ],
      },
      {
        role: 'windowMenu', // Minimize / Zoom / Close
      },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  createWindow();

  // "Open with DocVex": register the Explorer verb (Windows, best-effort)
  // and open any files the OS handed us before we were ready.
  registerOpenWithDocVexVerb();
  if (pendingExternalOpens.length) {
    pendingExternalOpens.splice(0).forEach((p) => openExternalFile(p));
  }

  // ── System tray / menu-bar icon ─────────────────────────────────────────
  // Puts the app icon in the Windows notification area / macOS menu bar.
  // Left- OR right-clicking opens the APP-DRAWN menu (showTrayMenu above) —
  // themed like the rest of DocVex, with a status header, recent projects,
  // and "Extract text" (which freezes the desktop and OCRs a selection, see
  // openScreenSnip). A native Menu is kept as the fallback if that window
  // can't be created, so the tray is never a dead icon.
  try {
    let trayIcon = nativeImage.createFromPath(path.join(__dirname, 'appicon_desktop.png'));
    // Tray icons render at ~16px; macOS in particular shows a giant blurry
    // icon without an explicit resize.
    if (!trayIcon.isEmpty()) trayIcon = trayIcon.resize({ width: 16, height: 16 });
    appTray = new Tray(trayIcon);
    appTray.setToolTip('DocVex');
    // macOS: don't wait out the double-click interval before reacting.
    try { appTray.setIgnoreDoubleClickEvents(true); } catch { /* Windows/Linux — no-op */ }
    // Left click raises the app, right click opens the menu — the Windows
    // convention, and what the user asked for.
    appTray.on('click', () => { hideTrayMenu(); showMainWindow(); });
    const openMenu = () => {
      try {
        toggleTrayMenu();
      } catch {
        // Custom window unavailable — fall back to a native menu with the
        // essentials so the tray still works.
        appTray.popUpContextMenu(Menu.buildFromTemplate([
          { label: 'Open DocVex', click: () => showMainWindow() },
          { label: 'Extract text', click: () => { try { openSnipPanel(); } catch { /* non-fatal */ } } },
          { type: 'separator' },
          { label: 'Quit DocVex', click: () => app.quit() },
        ]));
      }
    };
    appTray.on('right-click', openMenu);
    appTray.on('double-click', () => { hideTrayMenu(); showMainWindow(); });
  } catch { /* tray unavailable (some Linux DEs) — non-fatal */ }

  // Best-effort sweep of stale WhatsApp-zip extractions (temp/docvex-wa) on
  // startup — drop folders not touched in 7 days so extracted media doesn't
  // pile up. Cached extractions are keyed by zip path+mtime, so a dropped
  // folder just means the next open re-extracts.
  (async () => {
    try {
      const root = path.join(app.getPath('temp'), 'docvex-wa');
      const entries = await fsp.readdir(root, { withFileTypes: true });
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const full = path.join(root, ent.name);
        try {
          const st = await fsp.stat(full);
          if (st.mtimeMs < cutoff) await fsp.rm(full, { recursive: true, force: true });
        } catch { /* skip */ }
      }
    } catch { /* no extractions yet — nothing to sweep */ }
  })();

  // Periodic bin auto-sweep — purge the active folder's `.docvex-trash`
  // of entries older than 30 days every 6h while the app runs. Other
  // folders are swept on open by the renderer.
  stopPurgeTimer();
  purgeTimer = setInterval(() => {
    if (watchedDir) {
      purgeTrashDir(watchedDir).catch(() => { /* best-effort */ });
    }
  }, PURGE_INTERVAL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

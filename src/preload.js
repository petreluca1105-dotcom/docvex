const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // On-disk path for a picked/dropped File object. Electron 32 removed the
  // old `File.path` property — webUtils.getPathForFile is its replacement,
  // and it only exists in the preload context, hence the bridge. Returns ''
  // for synthetic Files (e.g. constructed blobs) that have no disk path.
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },

  // OAuth bridge (also carries `docvex://invite?token=…` URLs — the channel
  // name is historical; main.js routes both kinds through it).
  openOAuthUrl: (url) => ipcRenderer.send('oauth:open-external', url),
  onOAuthCallback: (handler) =>
    ipcRenderer.on('oauth:callback-url', (_, url) => handler(url)),
  removeOAuthListener: () =>
    ipcRenderer.removeAllListeners('oauth:callback-url'),

  // One-shot: pulls any docvex:// URL passed on the command line at COLD
  // start (e.g. clicking an invite link when the app isn't running yet).
  // Returns null if nothing pending. The renderer calls this once during
  // AuthContext setup; main clears the value after serving it, so a remount
  // or refetch can't replay the deep-link.
  getStartupDeepLink: () => ipcRenderer.invoke('app:get-startup-deep-link'),

  // Dev-only account switcher. The main process's "Account" menu sends the
  // target email on click; the renderer signs out of the current Supabase
  // session, stashes the email for prefill, and reloads the page so the
  // auth screen comes up clean. Returns an unsubscribe fn.
  onAccountSwitch: (handler) => {
    const listener = (_, email) => handler(email);
    ipcRenderer.on('account:switch-to', listener);
    return () => ipcRenderer.removeListener('account:switch-to', listener);
  },

  // Dev-only "DEBUG → Clear all cached data" menu hook. Main fires the
  // event when the menu item is clicked; the renderer wipes its module-
  // level caches (signed URLs, parsed pdf.js docs) so the next open
  // re-fetches everything from scratch. Returns an unsubscribe fn.
  onDebugClearCache: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('debug:clear-cache', listener);
    return () => ipcRenderer.removeListener('debug:clear-cache', listener);
  },

  // Dev-only "DEBUG → Send all test notifications" menu hook. Fires every
  // entry in TEST_NOTIFICATIONS so devs can preview the full toast +
  // history surface for each category × priority × icon combination
  // without manually triggering the live actions. Returns an unsubscribe fn.
  onSendTestNotifications: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('debug:send-test-notifications', listener);
    return () => ipcRenderer.removeListener('debug:send-test-notifications', listener);
  },

  // Dev-only "DEBUG → Send all email previews to me" menu hook. Fires the
  // welcome, invite, and support-report Edge Functions with the debug
  // flag set so each template lands in the signed-in user's own inbox.
  // Returns an unsubscribe fn.
  onDebugSendEmailPreviews: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('debug:send-email-previews', listener);
    return () => ipcRenderer.removeListener('debug:send-email-previews', listener);
  },

  // Open any URL in the user's default browser (used for release links etc.)
  openExternal: (url) => ipcRenderer.send('app:open-external', url),

  // App-wide UI scale (Settings → Text size). webFrame zoom scales the ENTIRE
  // renderer — text, icons, spacing, px-based sizes alike — unlike a root
  // font-size which only moves rem/em. Stays consistent with clientX /
  // getBoundingClientRect (both remain CSS-px), so tooltip/morph-pill math is
  // unaffected. Persists for the webContents' lifetime; the renderer re-applies
  // the saved preference on every boot.
  setZoomFactor: (factor) => { try { webFrame.setZoomFactor(factor); } catch { /* non-fatal */ } },
  getZoomFactor: () => { try { return webFrame.getZoomFactor(); } catch { return 1; } },

  // Custom window controls — the app runs frameless (frame:false), so the
  // renderer's title bar draws its own minimize / maximize / close buttons
  // and drives the window through these channels. `onWindowMaximizedChanged`
  // lets the title bar swap the maximize⇄restore glyph when the OS state
  // changes (e.g. the user double-clicks the drag region or uses Win+Up).
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowMaximizedChanged: (handler) => {
    const listener = (_, isMax) => handler(isMax);
    ipcRenderer.on('window:maximized-changed', listener);
    return () => ipcRenderer.removeListener('window:maximized-changed', listener);
  },
  // Sign-in lives in its own window (main.js openAuthWindow), so the app window
  // never reshapes itself into a login box. The app window reports which of the
  // two should be on screen; the sign-in window reports when it's done.
  //   authAppReady — signed in: reveal the app window, close the sign-in window.
  //   authRequired — signed out: hide the app window, raise the sign-in window.
  //   authCompleted — sent BY the sign-in window once a session lands.
  authAppReady: () => ipcRenderer.send('auth:app-ready'),
  authRequired: () => ipcRenderer.send('auth:required'),
  authCompleted: () => ipcRenderer.send('auth:completed'),

  // Quit the whole app — used by a deliberate logout to close all windows.
  quitApp: () => ipcRenderer.send('app:quit'),

  // Native fullscreen state — the macOS title bar drops its traffic-light inset
  // when fullscreen hides the lights.
  windowIsFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  onWindowFullscreenChanged: (handler) => {
    const listener = (_, isFs) => handler(isFs);
    ipcRenderer.on('window:fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('window:fullscreen-changed', listener);
  },

  // Open a signed file URL inside a dedicated in-app BrowserWindow.
  // Used by FileDetailModal's View button + double-click handlers
  // for image / video / PDF / text — types Chromium renders natively.
  // DOCX has its own helper (openDocx below) because it needs more
  // routing (Word → Office Online → OS default).
  openFileWindow: (url, fileName) =>
    ipcRenderer.send('app:open-file-window', { url, fileName }),

  // Open a self-contained HTML string in its own in-app window. Used by
  // the .docx viewer — the renderer turns the document into HTML via
  // docx-preview and hands the markup here (main stages it to a temp
  // file and loads it).
  openHtmlWindow: (html, fileName) =>
    ipcRenderer.send('app:open-html-window', { html, fileName }),

  // Open a file in a dedicated DocVex document-viewer window (file preview
  // + Legal AI panel). The renderer boots the /doc-viewer route from the
  // path/name/mime query params (see renderer.jsx).
  openDocViewerWindow: (file) =>
    ipcRenderer.send('window:open-doc-viewer', file),

  // The shared doc-viewer window listens for additional files to open as new
  // tabs (subsequent double-clicks in the Files page). Returns an unsubscribe.
  onDocViewerAddFile: (cb) => {
    const listener = (_e, file) => cb(file);
    ipcRenderer.on('doc-viewer:add-file', listener);
    return () => ipcRenderer.removeListener('doc-viewer:add-file', listener);
  },

  // Open doc-viewer windows registry — the main app's "Open files" sidebar
  // section lists every open document viewer and can refocus / close one.
  // `onDocViewerTabs` pushes the current list whenever a viewer opens/closes.
  listDocViewerTabs: () => ipcRenderer.invoke('doc-viewer:list'),
  focusDocViewerTab: (id) => ipcRenderer.send('doc-viewer:focus', id),
  closeDocViewerTab: (id) => ipcRenderer.send('doc-viewer:close', id),
  // "Back to app" from a doc-viewer window — raise the main app window.
  focusMainWindow: () => ipcRenderer.send('window:focus-main'),

  // ── Pre-warmed doc-viewer window ────────────────────────────────────────
  // A viewer window boots hidden and empty (?warm=1), says it's ready, and is
  // later handed a file over `doc-viewer:open-file` — that swap is what makes
  // opening a document instant. It acks once the document has painted so main
  // can show the window with content already on screen.
  notifyDocViewerWarmReady: () => ipcRenderer.send('doc-viewer:warm-ready'),
  notifyDocViewerFilePainted: () => ipcRenderer.send('doc-viewer:file-painted'),
  onDocViewerOpenFile: (handler) => {
    const listener = (_, file) => handler(file);
    ipcRenderer.on('doc-viewer:open-file', listener);
    return () => ipcRenderer.removeListener('doc-viewer:open-file', listener);
  },
  // Tray "Extract text" overlay: Esc → main destroys every snip window
  // (instant, no async close teardown).
  snipCancel: () => ipcRenderer.send('snip:cancel'),
  // Snipping-Tool launcher panel (/snip-panel): "New" starts a capture with
  // the chosen mode + delay + freeze scope ({ allScreens }).
  snipNew: (opts) => ipcRenderer.send('snip:new', opts),
  // Abort a delayed capture that hasn't fired yet (Esc during the countdown)
  // — kills the timer + countdown badges, keeps the panel open.
  snipCancelPending: () => ipcRenderer.send('snip:cancel-pending'),

  // ── System-tray menu (/tray-menu, src/pages/TrayMenu.jsx) ───────────────
  // The tray menu is drawn by the app, not the OS, so every row hands its
  // effect back to main: 'open' | 'navigate' | 'external' | 'extract' |
  // 'check-updates' | 'install-update' | 'restart' | 'quit'. Main runs the
  // action and hides the menu window.
  trayMenuAction: (action, payload) => ipcRenderer.send('tray:action', { action, payload }),
  // The card measures itself and main resizes + re-anchors the window to the
  // tray icon (sizes are DIP — the renderer multiplies out its zoom factor).
  trayMenuResize: (size) => ipcRenderer.send('tray:resize', size),
  trayMenuClose: () => ipcRenderer.send('tray:close'),
  // App facts the menu shows: { version, isPackaged, platform, updateState }.
  getTrayMenuState: () => ipcRenderer.invoke('tray:state'),
  // Fired each time the tray re-opens the (reused) window, with the edge the
  // tray sits on ({ anchor: 'bottom' | 'top' }) so the card animates from the
  // right corner. Returns an unsubscribe fn.
  onTrayMenuOpened: (handler) => {
    const listener = (_, payload) => handler(payload);
    ipcRenderer.on('tray:opened', listener);
    return () => ipcRenderer.removeListener('tray:opened', listener);
  },
  // Main → main-window navigation, driven by the tray menu's rows. Payload is
  // a route path, or '@report' for the Report-a-problem modal. Returns an
  // unsubscribe fn.
  onAppNavigate: (handler) => {
    const listener = (_, dest) => handler(dest);
    ipcRenderer.on('app:navigate', listener);
    return () => ipcRenderer.removeListener('app:navigate', listener);
  },
  // A doc-viewer window reports whether its AI advisor is currently working, so
  // the main app's "Open files" list can show an AI-busy marker on that row.
  setDocViewerAiStatus: (busy) => ipcRenderer.send('doc-viewer:ai-status', busy),
  onDocViewerTabs: (cb) => {
    const listener = (_e, list) => cb(list);
    ipcRenderer.on('doc-viewer:tabs', listener);
    return () => ipcRenderer.removeListener('doc-viewer:tabs', listener);
  },

  // Announce that some local paths were just trashed/deleted, and subscribe to
  // the broadcast main fans back out to every window. Lets the doc-viewer close
  // tabs for deleted files and keeps every Files tab's listing in sync.
  notifyFilesRemoved: (paths) => ipcRenderer.send('files:removed', paths),
  onFilesRemoved: (cb) => {
    const listener = (_e, paths) => cb(paths);
    ipcRenderer.on('files:removed', listener);
    return () => ipcRenderer.removeListener('files:removed', listener);
  },

  // Generic "a file changed on disk" (rename, etc.) broadcast — tells every
  // window's Files tab to re-list. Used so a rename in the doc-viewer tab
  // sidebar propagates to the Files tabs (the watcher only pings the main
  // window, so the doc-viewer's own embedded Files tab would otherwise miss it).
  notifyFilesChanged: () => ipcRenderer.send('files:changed'),
  onFilesChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('files:changed', listener);
    return () => ipcRenderer.removeListener('files:changed', listener);
  },

  // Surface a known file path for localfile:// preview (timeline source
  // thumbnails restored from a saved timeline). Awaitable so callers can
  // register BEFORE mounting <img> tiles.
  allowLocalFile: (p) => ipcRenderer.invoke('localfile:allow-file', p),
  // File extensions this machine has no OS thumbnail provider for (e.g. .docx
  // with no Office installed). The thumbnail engine stops requesting `?thumb=`
  // for them instead of re-asking — and logging a 415 — per file.
  getUnsupportedThumbExts: () => ipcRenderer.invoke('thumb:unsupported-exts'),

  // "Opened with DocVex" — standalone files opened through the OS file
  // association (not linked to any project). The Hub lists them; open
  // re-launches a file in its own Doc Viewer window.
  listExternalOpens: () => ipcRenderer.invoke('external-opens:list'),
  openExternalFile: (p) => ipcRenderer.send('external-opens:open', p),
  removeExternalOpen: (p) => ipcRenderer.invoke('external-opens:remove', p),
  onExternalOpensChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('external-opens:changed', listener);
    return () => ipcRenderer.removeListener('external-opens:changed', listener);
  },

  // Extract text from a legacy .doc file (main process parses the binary).
  extractDocText: (filePath) => ipcRenderer.invoke('doc:extract-text', filePath),

  // Extract a WhatsApp export .zip to a temp folder and locate its chat
  // transcript. Resolves { ok, chatPath, name } when it's a WhatsApp export
  // (so the doc-viewer can reconstruct it with media), else { ok: false }.
  prepareWhatsAppZip: (zipPath) => ipcRenderer.invoke('whatsapp:prepare-zip', zipPath),

  // Same, for an already-extracted WhatsApp export FOLDER: locate the
  // transcript inside it. Resolves { ok, chatPath, name } or { ok: false }.
  prepareWhatsAppFolder: (dirPath) => ipcRenderer.invoke('whatsapp:prepare-folder', dirPath),

  // Content-based WhatsApp recognition for the Files tab: given folder /
  // .zip paths, resolves { [path]: bool } by inspecting their CONTENTS in
  // main (never the names — a renamed export keeps its mark).
  detectWhatsApp: (paths) => ipcRenderer.invoke('whatsapp:detect', paths),

  // Open a DOCX with the best-available renderer. Main walks the
  // fallback chain: installed Word → Office Online (in-app window)
  // → OS default. Callers pass whichever sources they have
  // (`localPath` for My-branch files, `cloudUrl` for cloud-backed
  // files, or BOTH when a My-branch card has a cloud counterpart so
  // the no-Word fallback can still use Office Online with the
  // signed cloud URL).
  openDocx: ({ localPath, cloudUrl, fileName }) =>
    ipcRenderer.send('app:open-docx', { localPath, cloudUrl, fileName }),

  // Updates
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  isPackaged: () => ipcRenderer.invoke('app:is-packaged'),
  // { platform, arch } of the running build — lets the renderer pick the
  // correct release asset for the manual-download update fallback on
  // platforms where the in-app updater can't run (unsigned macOS / Linux).
  getPlatformInfo: () => ipcRenderer.invoke('app:get-platform-info'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  // Last-known updater status (pull). Lets a renderer that mounted after an
  // update:status push already fired (e.g. background download finished
  // before boot) recover the 'downloaded' state and prompt for a restart.
  getUpdateStatus: () => ipcRenderer.invoke('update:get-status'),
  installUpdate: () => ipcRenderer.send('update:install'),
  // macOS self-update: download the new build's zip, swap the .app bundle,
  // and relaunch. Resolves to { ok, error? }; on success the app quits and
  // the replacement relaunches automatically. Progress arrives via the
  // update:status channel (state 'downloading' with percent → 'installing').
  downloadAndInstallUpdate: (url) =>
    ipcRenderer.invoke('update:download-and-install', { url }),
  onUpdateStatus: (handler) => {
    const listener = (_, payload) => handler(payload);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },

  // Local-folder sync — backs the Files page's "download to my PC"
  // workflow. The renderer pre-signs Supabase URLs and hands them off
  // to main, which does the actual fs writes (renderer is sandboxed
  // away from fs by contextIsolation). Web build doesn't have any of
  // these — ProjectFiles gates the whole local pane on
  // `window.electronAPI?.localFolder` being defined.
  localFolder: {
    pick: () => ipcRenderer.invoke('local-folder:pick'),
    // Resolve (and create) the per-project directory. The folder is named
    // after the project and created under `baseDir` (the user's projects
    // folder) on first use — the SAME folder the hub creates.
    projectDir: (projectId, name, baseDir) => ipcRenderer.invoke('local-folder:project-dir', { projectId, name, baseDir }),
    list: (dir) => ipcRenderer.invoke('local-folder:list', dir),
    // Filesystem facts for one path (size + created/modified/accessed) —
    // the Doc Viewer's Metadata tab.
    stat: (filePath) => ipcRenderer.invoke('local-folder:stat', filePath),
    listRecursive: (dir) => ipcRenderer.invoke('local-folder:list-recursive', dir),
    download: (payload) => ipcRenderer.invoke('local-folder:download', payload),
    // Write raw bytes already held in the renderer (e.g. files the
    // user picked via <input type=file>) directly into the user's
    // branch folder. Sibling of `download`, which fetches a URL —
    // here the renderer already has the bytes, so the IPC payload
    // carries them as an ArrayBuffer per file.
    writeFiles: (payload) => ipcRenderer.invoke('local-folder:write-files', payload),
    deleteFiles: (payload) => ipcRenderer.invoke('local-folder:delete-files', payload),
    renameFile: (payload) => ipcRenderer.invoke('local-folder:rename-file', payload),
    // Folder management — create / delete a subfolder, move an entry
    // between folders. Local organisation only (the cloud stays flat).
    createFolder: (payload) => ipcRenderer.invoke('local-folder:create-folder', payload),
    deleteFolder: (payload) => ipcRenderer.invoke('local-folder:delete-folder', payload),
    move: (payload) => ipcRenderer.invoke('local-folder:move', payload),
    openPath: (target) => ipcRenderer.invoke('local-folder:open-path', target),
    saveAs: (target) => ipcRenderer.invoke('local-folder:save-as', target),
    extractArchive: (target) => ipcRenderer.invoke('local-folder:extract-archive', target),
    showInFolder: (target) => ipcRenderer.invoke('local-folder:show-in-folder', target),
    // Filesystem watcher — main wraps a single fs.watch handle around
    // the requested dir. Renderer pairs `watch(dir)` with a handler
    // subscription via `onChange(...)`; the returned unsubscribe fn
    // detaches just the renderer listener (the watcher itself is
    // shared per-window and closed via `unwatch()`).
    watch: (dir) => ipcRenderer.invoke('local-folder:watch', dir),
    unwatch: () => ipcRenderer.invoke('local-folder:unwatch'),
    onChange: (handler) => {
      const listener = (_, dir) => handler(dir);
      ipcRenderer.on('local-folder:changed', listener);
      return () => ipcRenderer.removeListener('local-folder:changed', listener);
    },
    // Per-folder sidecar (.docvex.json) — persists the unique-ID
    // mapping for each file alongside the files themselves. Survives
    // browser-storage clears and syncs across teammates via
    // Dropbox/iCloud. See lib/localBranchMeta.js for the data shape
    // and reconciliation logic.
    readSidecar: (dir) => ipcRenderer.invoke('local-folder:read-sidecar', dir),
    writeSidecar: (payload) => ipcRenderer.invoke('local-folder:write-sidecar', payload),
    // Recently deleted (local recycle bin) — deleting a file moves it into
    // a hidden `.docvex-trash/` folder with a deletedAt timestamp; main
    // auto-purges entries older than 30 days. See main.js trash handlers.
    trashFile: (payload) => ipcRenderer.invoke('local-folder:trash-file', payload),
    trashFolder: (payload) => ipcRenderer.invoke('local-folder:trash-folder', payload),
    listTrash: (dir) => ipcRenderer.invoke('local-folder:list-trash', dir),
    restoreFromTrash: (payload) => ipcRenderer.invoke('local-folder:restore-from-trash', payload),
    deleteFromTrash: (payload) => ipcRenderer.invoke('local-folder:delete-from-trash', payload),
    purgeTrash: (payload) => ipcRenderer.invoke('local-folder:purge-trash', payload),
    debugSeedTrash: (payload) => ipcRenderer.invoke('local-folder:debug-seed-trash', payload),
  },
});

// Unified local-folder abstraction. Two backends share one interface:
//
//   • Electron — `window.electronAPI.localFolder` IPC layer (preload
//     bridges to fs.watch / fsp / shell). Full filesystem access,
//     persistent paths, native folder picker.
//
//   • Web — the File System Access API (`window.showDirectoryPicker`).
//     User-gesture-driven, returns a FileSystemDirectoryHandle. Files
//     are read via `getFile()` (returns a Blob), written via
//     `createWritable()`. No native fs.watch — we poll every 3s and
//     diff snapshots to fire change events. Chromium-family browsers
//     only; absent in Firefox/Safari (those see the same "no local
//     branch" experience as the Electron-less web build did before).
//
// The exported `localFolderApi` is shape-identical to the previous
// Electron-only window.electronAPI.localFolder, so callers don't
// have to branch. Consumers that DO need to know which backend is
// active (for path persistence, input editability, etc.) read
// `isElectronBranch` / `isWebBranch`.

import { DEMO_PROJECT_ID, ensureDemoFolder } from './demoWorkspace';

const electronApi = typeof window !== 'undefined' ? window.electronAPI?.localFolder : null;
const hasElectron = Boolean(electronApi);
const hasWebFs    = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
// OPFS backs the web demo workspace — a real FileSystemDirectoryHandle with
// no permission prompts, available in every modern engine (not just the
// Chromium-only showDirectoryPicker).
const hasOpfs     = typeof navigator !== 'undefined' && Boolean(navigator.storage?.getDirectory);

// ── IndexedDB persistence for the web's FileSystemDirectoryHandle ───────
// The File System Access API hands back an opaque handle each pick,
// which we used to drop on page reload. IDB can structured-clone the
// handle, so persisting it across sessions costs almost nothing —
// the only catch is permission: the user must regrant via a user
// gesture each session (queryPermission returns 'prompt' on cold
// load). That's surfaced in the UI as a "Reconnect" button.
//
// Keyed by projectId so different projects can each remember their
// own folder. localStorage stores Electron paths (path-as-string is
// useful there); IDB stores the actual handle here on web.
const IDB_NAME = 'docvex-fs-handles';
const IDB_STORE = 'handles';
const IDB_VERSION = 1;

function openIdb() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('No IndexedDB'));
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(projectId) {
  try {
    const db = await openIdb();
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(projectId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function idbPut(projectId, value) {
  try {
    const db = await openIdb();
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, projectId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

async function idbDelete(projectId) {
  try {
    const db = await openIdb();
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(projectId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

// Web-backend module-level state. The dirHandle is the chosen
// directory; handlesByName maps each top-level filename to its
// FileSystemFileHandle so subsequent reads/writes don't have to
// re-walk the directory. lastSnapshot + pollTimer + changeHandlers
// drive the polling-based watcher (no real fs.watch on the web).
const webState = {
  dirHandle: null,
  handlesByName: new Map(),
  // Size + mtime of each handled file, used by snapshotHandles to
  // detect in-place byte edits in addition to add/remove/rename.
  // Filled alongside handlesByName by listWeb; cleared in the same
  // pick/restore/forget paths.
  metaByName: new Map(),
  // Separate one-slot handle for `.docvex.json` — kept out of
  // handlesByName because that map is filtered to non-dotfiles
  // (see listWeb). Cached so back-to-back writeSidecar calls skip
  // the per-write directory walk. Cleared on pick / restore /
  // forget so a folder switch can't reuse the previous sidecar.
  sidecarHandle: null,
  lastSnapshot: null,
  pollTimer: null,
  changeHandlers: [],
};

// Duplicate of main.js's guessMimeFromName — extension-based MIME
// inference for files the browser handed us without metadata. Kept
// in sync by convention; if a third copy shows up, extract to a
// shared util. Exported so surfaces that only know a filename (e.g. the
// Extractions tab, which stores paths but not MIME) can build a thumbnail
// descriptor the resolver will actually act on.
export function guessMimeFromName(name) {
  const i = name.lastIndexOf('.');
  if (i < 0) return '';
  const ext = name.slice(i + 1).toLowerCase();
  if (['jpg', 'jpeg'].includes(ext)) return 'image/jpeg';
  if (['png', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(ext)) return `image/${ext}`;
  if (['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(ext)) return `video/${ext}`;
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'md') return 'text/markdown';
  if (['txt', 'log', 'json', 'csv', 'xml', 'html', 'css', 'js', 'ts'].includes(ext)) return 'text/plain';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (['doc', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'application/octet-stream';
  return '';
}

// Same sanitisation as main.js's pending-upload helper — keeps web
// downloads compatible with the canonical-storage-path layout the
// approve RPC eventually writes.
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 240);
}

// Filename-based ignore set for the web listing — kept in sync with
// the Electron-side isIgnoredLocalFilename() in src/main.js. Both
// surfaces have to filter the same way or the diff layer sees
// different file sets depending on the build.
function isIgnoredLocalFilenameWeb(name) {
  if (!name) return true;
  if (name.startsWith('.')) return true;
  if (name.startsWith('~$')) return true;
  if (name.endsWith('~')) return true;
  if (/\.(swp|swo|swn|swm)$/i.test(name)) return true;
  if (/\.(lock|lck)$/i.test(name)) return true;
  if (/\.(tmp|temp|bak|partial|crdownload|part)$/i.test(name)) return true;
  if (name === 'Thumbs.db' || name === 'thumbs.db') return true;
  if (name === 'desktop.ini' || name === 'Desktop.ini') return true;
  if (name === 'ehthumbs.db') return true;
  if (name === 'Icon\r') return true;
  return false;
}

async function listWeb() {
  const dir = webState.dirHandle;
  if (!dir) return { files: [], error: 'No folder picked' };
  // Build fresh maps in locals and swap them in atomically at the end. The
  // 3s poller runs this repeatedly; clearing webState's maps up-front then
  // repopulating behind `await entry.getFile()` opened a window where a
  // concurrent readLocalBlob() saw an empty/half-built map and threw
  // "No handle". snapshotHandles() reads metaByName so the poller still
  // detects in-place byte edits (Word "Save"), not just adds/removes/renames.
  const nextHandles = new Map();
  const nextMeta = new Map();
  const files = [];
  try {
    for await (const entry of dir.values()) {
      if (entry.kind !== 'file') continue;
      // Drop OS / editor / lockfile noise — same matrix as Electron.
      if (isIgnoredLocalFilenameWeb(entry.name)) continue;
      let f;
      try { f = await entry.getFile(); }
      catch { continue; }  // permission revoked mid-iteration, skip
      nextHandles.set(entry.name, entry);
      nextMeta.set(entry.name, { size: f.size, mtime: f.lastModified });
      files.push({
        name: entry.name,
        // Synthetic path scheme so the renderer can detect web vs
        // electron via `path.startsWith('web://')`. The folder
        // segment is just the picker-supplied dir.name (FSA doesn't
        // surface real absolute paths for privacy reasons).
        path: `web://${dir.name}/${entry.name}`,
        sizeBytes: f.size,
        mtimeIso: new Date(f.lastModified).toISOString(),
        mimeType: guessMimeFromName(entry.name),
      });
    }
    files.sort((a, b) => (a.mtimeIso < b.mtimeIso ? 1 : -1));
    // Swap the fully-built maps in at once — no reader ever sees a partial map.
    webState.handlesByName = nextHandles;
    webState.metaByName = nextMeta;
    return { files, error: null };
  } catch (err) {
    return { files: [], error: err?.message || String(err) };
  }
}

// Snapshot tuples "name:size:mtime" joined into a single string.
// Including size + mtime (not just name) means an in-place edit
// (Word's "Save" writing new bytes to the same path) shifts the
// snapshot and fires the change handler. Without these fields,
// the web watcher missed byte edits entirely — only adds, removes,
// and renames triggered listeners.
function snapshotHandles() {
  const items = [];
  for (const [name] of webState.handlesByName) {
    const m = webState.metaByName.get(name) || { size: 0, mtime: 0 };
    items.push(`${name}:${m.size}:${m.mtime}`);
  }
  return items.sort().join('|');
}

function startWebPolling() {
  if (webState.pollTimer) return;
  webState.pollTimer = setInterval(async () => {
    if (!webState.dirHandle) return;
    // listWeb refreshes the handle map; we then diff the snapshot.
    await listWeb();
    const snap = snapshotHandles();
    if (webState.lastSnapshot !== null && snap !== webState.lastSnapshot) {
      const dirName = webState.dirHandle?.name || '';
      for (const h of webState.changeHandlers) {
        try { h(dirName); } catch { /* swallow */ }
      }
    }
    webState.lastSnapshot = snap;
  }, 3000);
}

function stopWebPolling() {
  if (webState.pollTimer) clearInterval(webState.pollTimer);
  webState.pollTimer = null;
  webState.lastSnapshot = null;
}

export const isElectronBranch = hasElectron;
export const isWebBranch      = !hasElectron && hasWebFs;
export const hasLocalFolderApi = hasElectron || hasWebFs || hasOpfs;

export const localFolderApi = {
  // Resolve the fixed per-project directory (Electron only). Web has no
  // ambient filesystem path — it returns null so the caller falls back to the
  // File System Access picker.
  projectDir: async (projectId, name, baseDir) => {
    if (hasElectron) return electronApi.projectDir(projectId, name, baseDir);
    return { path: null, error: 'web' };
  },

  pick: async () => {
    if (hasElectron) return electronApi.pick();
    if (!hasWebFs) return null;
    try {
      // mode: 'readwrite' so download() can write via createWritable.
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      webState.dirHandle = handle;
      webState.sidecarHandle = null;
      webState.lastSnapshot = null;
      return handle.name;
    } catch (err) {
      // User-cancelled (clicked away from the OS dialog) — return null
      // so the caller knows nothing changed.
      if (err?.name === 'AbortError') return null;
      throw err;
    }
  },

  list: async (dir) => {
    if (hasElectron) return electronApi.list(dir);
    // Web has no in-app folder navigation (the FSA backend tracks a
    // single flat directory handle), so it never surfaces subfolders.
    const res = await listWeb();
    return { ...res, dirs: [] };
  },

  // Filesystem facts for ONE file (size + created / modified / accessed +
  // permission bits) — the Doc Viewer's Metadata tab. The web backend has no
  // paths: the File System Access API only exposes `lastModified` + size on
  // the File object, so the web shape carries what it can and leaves the
  // rest null.
  stat: async (pathOrName) => {
    if (hasElectron) return electronApi.stat(pathOrName);
    try {
      const dir = webState.dirHandle;
      if (!dir) return { error: 'No folder connected' };
      const handle = await dir.getFileHandle(pathOrName);
      const f = await handle.getFile();
      return {
        path: null,
        name: f.name,
        dir: null,
        sizeBytes: f.size,
        isFile: true,
        isDirectory: false,
        mtimeIso: f.lastModified ? new Date(f.lastModified).toISOString() : null,
        birthtimeIso: null,
        ctimeIso: null,
        atimeIso: null,
        mode: null,
        error: null,
      };
    } catch (err) {
      return { error: err?.message || 'Could not read file info' };
    }
  },

  // Recursive listing — the SYNC source. Every file under `dir` tagged
  // with its `folderPath` (relative dir, '' = root). Electron walks the
  // tree; web has no subfolders so it returns the flat listing with
  // folderPath '' on each entry.
  listAll: async (dir) => {
    if (hasElectron) return electronApi.listRecursive(dir);
    const res = await listWeb();
    return { files: (res.files || []).map((f) => ({ ...f, folderPath: '' })), error: res.error };
  },

  // ── Folder management (Electron only) ─────────────────────────────
  // Create / delete a subfolder and move an entry between folders.
  // Local organisation layer; the cloud project stays flat. The web
  // backend can't navigate subfolders, so these report unsupported
  // rather than silently no-op'ing (callers surface the message).
  createFolder: async (payload) => {
    if (hasElectron) return electronApi.createFolder(payload);
    return { error: 'Folders are available in the desktop app' };
  },
  deleteFolder: async (payload) => {
    if (hasElectron) return electronApi.deleteFolder(payload);
    return { error: 'Folders are available in the desktop app' };
  },
  // Move a whole folder (and its contents) into the recycle bin instead of
  // hard-deleting it. Electron walks the tree and trashes each file; web has
  // no subfolders so this is desktop-only.
  trashFolder: async (payload) => {
    if (hasElectron) return electronApi.trashFolder(payload);
    return { ok: false, error: 'Folders are available in the desktop app' };
  },
  move: async (payload) => {
    if (hasElectron) return electronApi.move(payload);
    return { error: 'Folders are available in the desktop app' };
  },

  download: async (payload) => {
    if (hasElectron) return electronApi.download(payload);
    const dir = webState.dirHandle;
    if (!dir) return { results: [], error: 'No folder picked' };
    const results = [];
    for (const f of payload?.files || []) {
      if (!f?.url || !f?.filename) {
        results.push({ filename: f?.filename || '?', ok: false, error: 'Missing url/filename' });
        continue;
      }
      try {
        const res = await fetch(f.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const safe = sanitizeFilename(f.filename);
        // create:true so re-downloads / first-downloads both work.
        // The writable replaces existing content — same semantics as
        // the Electron path's `fsp.writeFile`.
        const fh = await dir.getFileHandle(safe, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        webState.handlesByName.set(safe, fh);
        results.push({ filename: f.filename, ok: true, path: `web://${dir.name}/${safe}` });
      } catch (err) {
        results.push({ filename: f.filename, ok: false, error: err?.message || String(err) });
      }
    }
    return { results, error: null };
  },

  // Write bytes the renderer already has (File / Blob from a picker
  // or drag-drop) into the branch folder. Used by the FAB on 'mine'
  // branch — uploads now stay local until the user explicitly pushes.
  //
  // Accepts `{ dir, files: [{ filename, blob }] }`. Internally
  // serialises each blob to an ArrayBuffer for IPC (Electron) or
  // writes via createWritable (web).
  writeFiles: async (payload) => {
    const dir = payload?.dir;
    const files = Array.isArray(payload?.files) ? payload.files : [];
    if (!dir) return { results: [], error: 'No directory specified' };
    if (hasElectron) {
      // Electron IPC can't transfer Blob directly — convert to
      // ArrayBuffer first and let the main process write the bytes.
      const ipcFiles = [];
      for (const f of files) {
        if (!f?.filename || !f?.blob) {
          ipcFiles.push({ filename: f?.filename || '?', bytes: null });
          continue;
        }
        try {
          const bytes = await f.blob.arrayBuffer();
          ipcFiles.push({ filename: f.filename, bytes });
        } catch (err) {
          ipcFiles.push({ filename: f.filename, bytes: null, error: err?.message || String(err) });
        }
      }
      return electronApi.writeFiles({ dir, files: ipcFiles });
    }
    const dirHandle = webState.dirHandle;
    if (!dirHandle) return { results: [], error: 'No folder picked' };
    const results = [];
    for (const f of files) {
      if (!f?.filename || !f?.blob) {
        results.push({ filename: f?.filename || '?', ok: false, error: 'Missing filename or blob' });
        continue;
      }
      try {
        const safe = sanitizeFilename(f.filename);
        const fh = await dirHandle.getFileHandle(safe, { create: true });
        const w = await fh.createWritable();
        await w.write(f.blob);
        await w.close();
        webState.handlesByName.set(safe, fh);
        results.push({ filename: f.filename, ok: true, path: `web://${dirHandle.name}/${safe}` });
      } catch (err) {
        results.push({ filename: f.filename, ok: false, error: err?.message || String(err) });
      }
    }
    return { results, error: null };
  },

  // Delete a batch of files from the picked folder. Used by the
  // "Sync to main" flow when main no longer has files that are
  // still present locally. Both backends accept `{ dir, paths }`
  // and return per-path { ok, error? } so the caller can report
  // partial failures.
  deleteFiles: async (payload) => {
    if (hasElectron) return electronApi.deleteFiles(payload);
    const dir = webState.dirHandle;
    if (!dir) return { results: [], error: 'No folder picked' };
    const results = [];
    for (const p of payload?.paths || []) {
      // Web paths are synthetic — extract the filename and remove via
      // the directory handle. removeEntry throws if missing, which we
      // swallow as success (matches Electron's ENOENT handling).
      const name = (p || '').startsWith('web://') ? p.split('/').pop() : p;
      if (!name) {
        results.push({ path: p, ok: false, error: 'Invalid path' });
        continue;
      }
      try {
        await dir.removeEntry(name);
        webState.handlesByName.delete(name);
        webState.metaByName.delete(name);
        results.push({ path: p, ok: true });
      } catch (err) {
        if (err?.name === 'NotFoundError') {
          results.push({ path: p, ok: true });
        } else {
          results.push({ path: p, ok: false, error: err?.message || String(err) });
        }
      }
    }
    return { results, error: null };
  },

  // Rename a file inside the picked folder. Used by the
  // FileDetailModal's name commit on My branch so File Explorer
  // shows the new name alongside the queued metadata rename.
  //
  // Electron: single fsp.rename.
  // Web: prefer FileSystemFileHandle.move() (Chromium 110+; atomic).
  //      Fallback to read+write+delete for older browsers that
  //      shipped the FSA API before move() landed.
  renameFile: async (payload) => {
    if (hasElectron) return electronApi.renameFile(payload);
    const dir = webState.dirHandle;
    if (!dir) return { error: 'No folder picked' };
    const fromName = payload?.fromName;
    const toName = payload?.toName;
    if (!fromName || !toName) return { error: 'Missing names' };
    if (fromName === toName) return { ok: true, error: null };
    try {
      const handle = webState.handlesByName.get(fromName);
      if (!handle) return { error: 'Source file not found' };
      // Atomic path — move() exists on FileSystemFileHandle in
      // Chromium 110+. Avoids a roundtrip through memory.
      if (typeof handle.move === 'function') {
        await handle.move(toName);
        const newHandle = await dir.getFileHandle(toName);
        webState.handlesByName.delete(fromName);
        webState.handlesByName.set(toName, newHandle);
        // metaByName lives next to handlesByName; carry the entry over
        // (or drop both) so snapshotHandles stays consistent.
        const carried = webState.metaByName.get(fromName);
        webState.metaByName.delete(fromName);
        if (carried) webState.metaByName.set(toName, carried);
        return { ok: true, error: null };
      }
      // Fallback: copy bytes to a fresh handle, then delete the
      // original. Two round-trips through the renderer's memory but
      // works on every FSA-supporting browser.
      const file = await handle.getFile();
      const newHandle = await dir.getFileHandle(toName, { create: true });
      const writable = await newHandle.createWritable();
      await writable.write(file);
      await writable.close();
      await dir.removeEntry(fromName);
      webState.handlesByName.delete(fromName);
      webState.handlesByName.set(toName, newHandle);
      const carried = webState.metaByName.get(fromName);
      webState.metaByName.delete(fromName);
      if (carried) webState.metaByName.set(toName, carried);
      return { ok: true, error: null };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  },

  // No web equivalent for "open in OS file manager" / "open in default
  // app" — browsers don't expose those for sandboxed file handles.
  // Returns an empty string so callers can treat it as a no-op (matches
  // the Electron API's success contract).
  openPath: async (target) => {
    if (hasElectron) return electronApi.openPath(target);
    return '';
  },

  // "Save as…" — copy a file already on disk to a user-chosen location. Electron
  // opens the native save dialog (main does the copy); web falls back to a
  // browser download of the file's blob (the closest equivalent in a sandbox).
  saveAs: async (target) => {
    if (hasElectron) return electronApi.saveAs(target);
    try {
      const blob = await localFolderApi.readLocalBlob(target);
      if (!blob) return { ok: false };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = String(target || '').split(/[\\/]/).pop() || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },

  // "Open contents" of a compressed file — Electron unpacks a .zip into a
  // sibling folder (other formats open in the OS archiver). No web equivalent
  // (the sandbox can't write a sibling folder), so it's a no-op there.
  extractArchive: async (target) => {
    if (hasElectron) return electronApi.extractArchive(target);
    return { ok: false, error: 'Not supported on web' };
  },

  // Reveal a file in the OS file manager (Explorer / Finder) with the
  // file pre-selected. Electron-only; web returns a no-op success
  // shape since browsers can't drive the host's file manager.
  showInFolder: async (target) => {
    if (hasElectron) return electronApi.showInFolder(target);
    return { ok: false, error: 'Not supported on web' };
  },

  watch: async (dir) => {
    if (hasElectron) return electronApi.watch(dir);
    startWebPolling();
    return { ok: true };
  },

  unwatch: async () => {
    if (hasElectron) return electronApi.unwatch();
    stopWebPolling();
    return { ok: true };
  },

  onChange: (handler) => {
    if (hasElectron) return electronApi.onChange(handler);
    webState.changeHandlers.push(handler);
    return () => {
      webState.changeHandlers = webState.changeHandlers.filter((h) => h !== handler);
    };
  },

  // ── Web folder persistence ────────────────────────────────────────
  // Electron persists the chosen folder as a path string in
  // localStorage (handled by the caller, see ProjectFiles.jsx).
  // Web can't — `showDirectoryPicker` returns an opaque handle, no
  // path. IDB structured-clones the handle so we can carry it
  // across page reloads; permission grants don't persist by
  // default, hence the reconnect step below.
  //
  // All four are no-ops on Electron so callers can fire them
  // unconditionally without branching.

  // Save the currently-picked handle to IDB keyed by projectId.
  // Call this right after a successful `pick()` so the next visit
  // can find it. Failure is silent — folder still works this session;
  // the user just has to pick again next time.
  persistPickedHandle: async (projectId) => {
    if (hasElectron) return;
    if (projectId === DEMO_PROJECT_ID) return; // OPFS folder needs no IDB row
    if (!hasWebFs || !projectId || !webState.dirHandle) return;
    await idbPut(projectId, {
      handle: webState.dirHandle,
      name: webState.dirHandle.name,
      savedAt: Date.now(),
    });
  },

  // Look up the persisted handle for a project. Returns
  // `{ name, needsPermission }` when one exists, `null` otherwise.
  // Side-effect: when found, the handle is hot-loaded into
  // webState so subsequent operations (after permission is granted
  // via `reconnectHandle`) work without further setup.
  //
  // `needsPermission` distinguishes the two restore outcomes:
  //   • false → permission still 'granted' (rare; only when the
  //             browser remembered the grant from a prior session,
  //             which Chromium 122+ allows for some flows). The
  //             caller can list/read immediately.
  //   • true  → permission is 'prompt' or 'denied'. The caller
  //             should show a Reconnect affordance; the user's
  //             click on it must be the gesture that drives
  //             `reconnectHandle()` below.
  restorePersistedHandle: async (projectId) => {
    if (hasElectron) return null;
    // Demo workspace: the folder lives in OPFS (seeded with starter files on
    // first visit) — a real directory handle the rest of this backend works
    // on unchanged, and one that never needs a permission grant.
    if (projectId === DEMO_PROJECT_ID) {
      const dir = await ensureDemoFolder();
      if (!dir) return null;
      webState.dirHandle = dir;
      webState.sidecarHandle = null;
      webState.lastSnapshot = null;
      return { name: 'Demo files', needsPermission: false };
    }
    if (!hasWebFs || !projectId) return null;
    const stored = await idbGet(projectId);
    if (!stored?.handle) return null;
    webState.dirHandle = stored.handle;
    webState.sidecarHandle = null;
    webState.lastSnapshot = null;
    let perm = 'prompt';
    try {
      perm = await stored.handle.queryPermission({ mode: 'readwrite' });
    } catch { /* older browsers without queryPermission — fall through */ }
    return {
      name: stored.name || stored.handle.name,
      needsPermission: perm !== 'granted',
    };
  },

  // User-gesture-driven permission request. Returns true if the
  // handle is now usable. MUST be called from inside a user gesture
  // (e.g., onClick handler) — the FSA spec rejects bare programmatic
  // calls. The caller should disable the surrounding UI while this
  // promise is in flight.
  reconnectHandle: async () => {
    if (hasElectron) return true;
    if (!hasWebFs || !webState.dirHandle) return false;
    try {
      const perm = await webState.dirHandle.requestPermission({ mode: 'readwrite' });
      return perm === 'granted';
    } catch {
      return false;
    }
  },

  // Drop the persisted handle for a project and clear in-memory
  // state. Used by an explicit "forget folder" affordance or when
  // a project gets deleted. Idempotent.
  forgetPersistedHandle: async (projectId) => {
    if (hasElectron) return;
    if (!projectId) return;
    await idbDelete(projectId);
    if (webState.dirHandle) {
      webState.dirHandle = null;
      webState.handlesByName.clear();
      webState.metaByName.clear();
      webState.sidecarHandle = null;
      webState.lastSnapshot = null;
    }
  },

  // ── Sidecar (.docvex.json) I/O ────────────────────────────────────
  // Reads / writes a single hidden JSON file inside the picked folder.
  // The sidecar carries the fileId ↔ filename mapping for the local
  // branch; storing it in-folder means the IDs survive a localStorage
  // clear, ride along with the files when shared via Dropbox/iCloud,
  // and re-attach automatically when the user re-picks the folder
  // (no bootstrap window where unrecognised files briefly render as
  // missing).
  //
  // Both methods are async and return { json | ok, error }. Missing
  // files (read on a never-written folder) resolve to { json: null,
  // error: null } — the caller treats null as "empty mapping".
  //
  // Web path: bypasses `webState.handlesByName` (which excludes
  // dotfiles to keep the file grid clean). Goes straight through
  // `dir.getFileHandle('.docvex.json', { create: true })`. A single
  // sidecar handle is cached in `webState.sidecarHandle` to skip the
  // per-write directory walk; cleared when the folder is forgotten /
  // re-picked.
  readSidecar: async (dir) => {
    if (hasElectron) return electronApi.readSidecar(dir);
    const dirHandle = webState.dirHandle;
    if (!dirHandle) return { json: null, error: 'No folder picked' };
    try {
      // create:true so the handle always resolves — if the file
      // doesn't exist yet we just read an empty handle and return
      // null below (via the empty-text branch).
      const fh = await dirHandle.getFileHandle('.docvex.json', { create: true });
      webState.sidecarHandle = fh;
      const file = await fh.getFile();
      if (file.size === 0) return { json: null, error: null };
      const text = await file.text();
      let parsed = null;
      try { parsed = JSON.parse(text); }
      catch (parseErr) { return { json: null, error: `Bad JSON: ${parseErr?.message || parseErr}` }; }
      return { json: parsed, error: null };
    } catch (err) {
      return { json: null, error: err?.message || String(err) };
    }
  },

  writeSidecar: async (payload) => {
    const dir = payload?.dir;
    const json = payload?.json;
    if (!dir) return { ok: false, error: 'No directory specified' };
    if (!json || typeof json !== 'object') return { ok: false, error: 'Invalid payload' };
    if (hasElectron) return electronApi.writeSidecar({ dir, json });
    const dirHandle = webState.dirHandle;
    if (!dirHandle) return { ok: false, error: 'No folder picked' };
    try {
      const fh = webState.sidecarHandle
        || await dirHandle.getFileHandle('.docvex.json', { create: true });
      webState.sidecarHandle = fh;
      const w = await fh.createWritable();
      await w.write(JSON.stringify(json, null, 2));
      await w.close();
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },

  // ── Recently deleted (local recycle bin) ───────────────────────────
  // Electron handlers do the real work (see main.js). Web implements an
  // equivalent over the FSA directory handle: a `.docvex-trash` subdir
  // holding moved files + a `.trashmeta.json` map. Browsers without the
  // FSA API (no dirHandle) get an empty, no-op bin.
  trashFile: async (payload) => {
    if (hasElectron) return electronApi.trashFile(payload);
    const res = await webTrashFile(payload);
    return res;
  },
  listTrash: async (dir) => {
    if (hasElectron) return electronApi.listTrash(dir);
    return webListTrash();
  },
  restoreFromTrash: async (payload) => {
    if (hasElectron) return electronApi.restoreFromTrash(payload);
    return webRestoreFromTrash(payload);
  },
  deleteFromTrash: async (payload) => {
    if (hasElectron) return electronApi.deleteFromTrash(payload);
    return webDeleteFromTrash(payload);
  },
  purgeTrash: async (payload) => {
    if (hasElectron) return electronApi.purgeTrash(payload);
    return webPurgeTrash(payload);
  },
  // DEV-only trash seeder (Electron only).
  debugSeedTrash: async (payload) => {
    if (hasElectron) return electronApi.debugSeedTrash(payload);
    return { error: 'Desktop app only' };
  },
};

// ── Web recycle-bin helpers (FSA backend) ────────────────────────────
const WEB_TRASH_DIR = '.docvex-trash';
const WEB_TRASH_META = '.trashmeta.json';
const WEB_TRASH_RETENTION_DAYS = 30;

async function webTrashSubdir(create = false) {
  const dir = webState.dirHandle;
  if (!dir) return null;
  try { return await dir.getDirectoryHandle(WEB_TRASH_DIR, { create }); }
  catch { return null; }
}

async function webReadTrashMeta(tdir) {
  if (!tdir) return {};
  try {
    const fh = await tdir.getFileHandle(WEB_TRASH_META, { create: false });
    const file = await fh.getFile();
    if (!file.size) return {};
    return JSON.parse(await file.text()) || {};
  } catch { return {}; }
}

async function webWriteTrashMeta(tdir, meta) {
  const fh = await tdir.getFileHandle(WEB_TRASH_META, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(meta, null, 2));
  await w.close();
}

async function webTrashFile(payload) {
  const dir = webState.dirHandle;
  if (!dir) return { ok: false, error: 'No folder picked' };
  const p = payload?.path;
  const name = (p || '').startsWith('web://') ? p.split('/').pop() : p;
  if (!name) return { ok: false, error: 'Invalid path' };
  try {
    const handle = webState.handlesByName.get(name) || await dir.getFileHandle(name);
    const file = await handle.getFile();
    const tdir = await webTrashSubdir(true);
    const nowMs = Date.now();
    const stored = `${nowMs}__${name}`;
    const destHandle = await tdir.getFileHandle(stored, { create: true });
    const w = await destHandle.createWritable();
    await w.write(file);
    await w.close();
    await dir.removeEntry(name);
    webState.handlesByName.delete(name);
    webState.metaByName.delete(name);
    const meta = await webReadTrashMeta(tdir);
    meta[stored] = { originalName: name, deletedAt: new Date(nowMs).toISOString(), originalRelDir: '' };
    await webWriteTrashMeta(tdir, meta);
    return { ok: true, stored, error: null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function webListTrash() {
  const tdir = await webTrashSubdir(false);
  if (!tdir) return { items: [], error: null };
  const meta = await webReadTrashMeta(tdir);
  const items = [];
  try {
    for await (const [entryName, handle] of tdir.entries()) {
      if (handle.kind !== 'file' || entryName === WEB_TRASH_META) continue;
      const rec = meta[entryName] || {};
      try {
        const file = await handle.getFile();
        const originalName = rec.originalName || entryName.replace(/^\d+__/, '');
        items.push({
          stored: entryName,
          originalName,
          deletedAt: rec.deletedAt || new Date(file.lastModified).toISOString(),
          originalRelDir: rec.originalRelDir || '',
          sizeBytes: file.size,
          mimeType: file.type || '',
          path: `web://${WEB_TRASH_DIR}/${entryName}`,
        });
      } catch { /* skip */ }
    }
  } catch { /* iteration unsupported */ }
  items.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
  return { items, error: null };
}

async function webRestoreFromTrash(payload) {
  const dir = webState.dirHandle;
  const stored = payload?.stored;
  if (!dir || !stored) return { ok: false, error: 'Missing args' };
  try {
    const tdir = await webTrashSubdir(false);
    if (!tdir) return { ok: false, error: 'Bin not found' };
    const meta = await webReadTrashMeta(tdir);
    const rec = meta[stored] || {};
    const originalName = rec.originalName || stored.replace(/^\d+__/, '');
    const srcHandle = await tdir.getFileHandle(stored);
    const file = await srcHandle.getFile();
    let targetName = originalName;
    try {
      await dir.getFileHandle(originalName, { create: false });
      const dot = originalName.lastIndexOf('.');
      targetName = dot > 0
        ? `${originalName.slice(0, dot)} (restored)${originalName.slice(dot)}`
        : `${originalName} (restored)`;
    } catch { /* no collision */ }
    const destHandle = await dir.getFileHandle(targetName, { create: true });
    const w = await destHandle.createWritable();
    await w.write(file);
    await w.close();
    await tdir.removeEntry(stored);
    if (meta[stored]) { delete meta[stored]; await webWriteTrashMeta(tdir, meta); }
    return { ok: true, restoredPath: `web://${targetName}`, error: null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function webDeleteFromTrash(payload) {
  const stored = payload?.stored;
  if (!stored) return { ok: false, error: 'Missing args' };
  try {
    const tdir = await webTrashSubdir(false);
    if (!tdir) return { ok: true, error: null };
    try { await tdir.removeEntry(stored); } catch { /* already gone */ }
    const meta = await webReadTrashMeta(tdir);
    if (meta[stored]) { delete meta[stored]; await webWriteTrashMeta(tdir, meta); }
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function webPurgeTrash(payload) {
  const olderThanDays = payload?.olderThanDays ?? WEB_TRASH_RETENTION_DAYS;
  try {
    const tdir = await webTrashSubdir(false);
    if (!tdir) return { purged: 0, error: null };
    const meta = await webReadTrashMeta(tdir);
    const cutoff = Date.now() - olderThanDays * 86400000;
    let purged = 0;
    let dirty = false;
    for await (const [entryName, handle] of tdir.entries()) {
      if (handle.kind !== 'file' || entryName === WEB_TRASH_META) continue;
      const rec = meta[entryName];
      let expired = false;
      if (rec?.deletedAt) expired = Date.parse(rec.deletedAt) <= cutoff;
      else {
        try { const f = await handle.getFile(); expired = f.lastModified <= cutoff; }
        catch { expired = false; }
      }
      if (!expired) continue;
      try { await tdir.removeEntry(entryName); purged += 1; } catch { /* skip */ }
      if (rec) { delete meta[entryName]; dirty = true; }
    }
    if (dirty) await webWriteTrashMeta(tdir, meta);
    return { purged, error: null };
  } catch (err) {
    return { purged: 0, error: err?.message || String(err) };
  }
}

// Read a local file as a Blob, regardless of backend. Used by the
// commit modal (to PUT bytes into the pending bucket) and by
// LocalFileCard (to build thumbnails on web). On Electron this
// fetches via the custom `localfile://` protocol; on web it reads
// the cached FileSystemFileHandle.
export async function readLocalBlob(pathOrName) {
  if (hasElectron) {
    const url = `localfile://local/${encodeURIComponent(pathOrName)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Read failed: ${res.status}`);
    return await res.blob();
  }
  // Web: the value may be either the synthetic `web://dir/name` path
  // or just the bare filename. Strip the prefix in either case.
  const name = (pathOrName || '').startsWith('web://')
    ? pathOrName.split('/').pop()
    : pathOrName;
  const handle = webState.handlesByName.get(name);
  if (!handle) throw new Error(`No handle for "${name}" — pick the folder again`);
  return await handle.getFile();
}

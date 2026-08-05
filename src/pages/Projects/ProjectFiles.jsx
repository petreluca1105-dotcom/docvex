import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { useNotifications } from '../../context/NotificationsContext';
import { useAuth } from '../../context/AuthContext';
import FilesWorkspace from '../../components/FilesWorkspace';
import { useUndoRedo } from '../../components/useUndoRedo';
import { describeLocalFile } from '../../lib/thumbnailDescriptor';
import {
  localFolderApi,
  hasLocalFolderApi,
  isElectronBranch,
  readLocalBlob,
} from '../../lib/localFolder';
import { openDocx, isDocxFile, openFileWindow, canViewInBrowser, openDocViewerWindow, prepareWhatsAppZip, prepareWhatsAppFolder, detectWhatsApp, notifyFilesRemoved, onFilesRemoved, onFilesChanged, allowLocalFile } from '../../lib/platform';
import { openDocxInWindow } from '../../lib/openDocxWindow';
import { emptyDocumentBlob, docKindFromName, mimeForKind } from '../../lib/documentGen';
import { clearConversation, migrateConversation, migrateConversationsUnder } from '../../lib/conversationHistory';
import { readProjectsDir } from '../../lib/projectsDir';
import {
  loadSidecar,
  saveSidecar,
  emptySidecar,
  addEntry as addSidecarEntry,
  removeByFilename as removeSidecarByFilename,
  renameEntry as renameSidecarEntry,
  reconcileWithFilesystem,
} from '../../lib/localBranchMeta';
import { getPrefetchedProjectFiles } from '../../lib/projectFilesPrefetch';
import { prefetchMetadata } from '../../lib/metadataPrefetch';
import { loadCaseTimeline } from '../../lib/caseTimeline';
import './ProjectScoped.css';
import './ProjectFiles.css';

// Recently-deleted retention window (mirrors the Electron main sweep).
const TRASH_RETENTION_DAYS = 30;


// ── Small formatting helpers ──────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Masthead-kicker formatters — mirror ProjectOverview's hero so the Files
// masthead reads identically (KB / MB / GB; thousands-separated counts).
function fmtBytesFull(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
function fmtCount(n) {
  return (Number(n) || 0).toLocaleString();
}

function splitNameAndExtension(name) {
  if (!name) return { base: '', ext: '' };
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === name.length - 1) return { base: name, ext: '' };
  const ext = name.slice(lastDot + 1);
  if (ext.length > 8) return { base: name, ext: '' };
  return { base: name.slice(0, lastDot), ext };
}
const fileExtOf = (name) => (splitNameAndExtension(name).ext || '').toLowerCase();

// Compact relative-ish date — "today / yesterday / Nd ago / Mon DD".
function formatDate(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  const now = new Date();
  const dayDiff = Math.floor((now - then) / 86400000);
  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'yesterday';
  if (dayDiff < 7) return `${dayDiff}d ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Days remaining before a binned file is permanently purged.
function daysUntilPurge(deletedAt) {
  if (!deletedAt) return TRASH_RETENTION_DAYS;
  const age = Math.floor((Date.now() - Date.parse(deletedAt)) / 86400000);
  return Math.max(0, TRASH_RETENTION_DAYS - age);
}

// localfile:// URL for an on-disk path (Electron). Web paths (web://…) have
// no streamable URL, so the thumbnail resolver falls back to a glyph.
function localUrlFor(path, cacheBust) {
  if (!path || (typeof path === 'string' && path.startsWith('web://'))) return null;
  const t = cacheBust ? `?t=${encodeURIComponent(cacheBust)}` : '';
  return `localfile://local/${encodeURIComponent(path)}${t}`;
}

// Project-scoped Files page. Local-only: files come from a folder the user
// picks on their computer ("My drafts"); deleting a file moves it into a
// hidden `.docvex-trash` recycle bin ("Recently deleted") that auto-purges
// after 30 days.
export default function ProjectFiles({ embedded = false } = {}) {
  const { selectedProject, loading: projLoading } = useSelectedProject();
  const navigate = useNavigate();
  const projectId = selectedProject?.id || null;
  const { notify } = useNotifications();
  const { session } = useAuth();
  const userId = session?.user?.id || null;

  const supportsFolders = isElectronBranch;

  // One-shot warm-cache seed captured at mount for the project we open with.
  // When <App>'s ProjectPrefetch has already resolved this project's folder +
  // listings (the common "open the Hub, then click Project" path), the page
  // paints its grid from the seed on the first frame — no folder-resolve or
  // "Loading…" flash. Captured once (the `=== null` guard) so a later render
  // can't swap the seed mid-flight; null on a cold open (web, or no prefetch).
  const seedRef = useRef(null);
  if (seedRef.current === null) seedRef.current = getPrefetchedProjectFiles(projectId) || false;
  const seed = seedRef.current || null;

  // ── State ────────────────────────────────────────────────────────────
  const [localFolder, setLocalFolder] = useState(seed?.folder || '');
  const [localFiles, setLocalFiles] = useState(seed?.localFiles || []);      // recursive listing (counts + reconcile)
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [hydratedProjectId, setHydratedProjectId] = useState(seed ? projectId : null);
  // Electron project-directory resolution error + a retry trigger. Without
  // this a failed/rejected projectDir IPC (e.g. the main process hasn't picked
  // up the handler yet) would leave the page stuck on "Setting up…".
  const [folderError, setFolderError] = useState(null);
  const [folderRetry, setFolderRetry] = useState(0);

  // Folder navigation.
  const [folderStack, setFolderStack] = useState([]);    // [{ name, path }]
  const [browseCache, setBrowseCache] = useState(() => {
    const m = new Map(); // dir → { files, dirs }
    if (seed?.folder) m.set(seed.folder, { files: seed.rootListing.files, dirs: seed.rootListing.dirs });
    return m;
  });
  const [browseTick, setBrowseTick] = useState(0);

  const [sidecar, setSidecar] = useState(() => seed?.sidecar || emptySidecar(projectId, seed?.folder || ''));

  const [filesTab, setFilesTab] = useState('drafts');    // 'drafts' | 'trash'
  const [trashItems, setTrashItems] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);
  // Path of a freshly-created file that should be auto-selected + put into
  // rename mode in the workspace (instead of opening it). Cleared once applied.
  // MUST stay up here with the other hooks — the "no project selected" guard
  // below returns early, so a hook declared past it would change the hook
  // count between renders (React: "Rendered more hooks than during the
  // previous render").
  const [renameTargetPath, setRenameTargetPath] = useState(null);
  // Path of a just-created folder the workspace should select (not open) —
  // set after an archive is extracted.
  const [selectTargetPath, setSelectTargetPath] = useState(null);

  // The project's saved case timeline (built in the Timeline tab, stored via
  // lib/caseTimeline) — used below only to surface timeline files that were
  // picked from outside the project folder. Re-read when the panel mode
  // changes so the listing picks up a timeline built since this page mounted.
  const caseTimeline = useMemo(() => loadCaseTimeline(projectId), [projectId, filesTab]);

  // Timeline files picked from OUTSIDE the project folder need explicit
  // localfile:// permission before their tiles can paint — the containment
  // layer only serves folders the user has actually opened, so mounting them
  // first makes every thumbnail 403. Register the paths, THEN let the items
  // into the listing (see externalTimelineItems below).
  const [timelineFilesAllowed, setTimelineFilesAllowed] = useState(false);
  useEffect(() => {
    let alive = true;
    const paths = Object.values(caseTimeline?.fileRefs || {})
      .map((r) => r?.path)
      .filter(Boolean);
    if (!paths.length) { setTimelineFilesAllowed(true); return undefined; }
    setTimelineFilesAllowed(false);
    Promise.all(paths.map((p) => allowLocalFile(p)))
      .catch(() => { /* best-effort — unregistered paths just show a glyph */ })
      .then(() => { if (alive) setTimelineFilesAllowed(true); });
    return () => { alive = false; };
  }, [caseTimeline]);

  // Undo / redo stack for file operations (delete, rename, new folder,
  // import, restore). Each action records its own inverse; see the
  // primitive helpers below.
  const { pushAction, clear: clearUndo, undo, redo, canUndo, canRedo, undoLabel, redoLabel } = useUndoRedo();

  const localUploadInputRef = useRef(null);
  const localFolderUploadInputRef = useRef(null);
  const localFolderDebounceRef = useRef(null);

  // The project id the warm seed belongs to (null on a cold open). The mount-
  // time reset effects below skip their wipes while we're still showing this
  // project so the seeded grid stays painted. Comparing projectId (rather than
  // a one-shot "first run" flag) keeps the guards idempotent — StrictMode's
  // double effect-invoke in dev re-runs them with the same projectId and so
  // still skips, while a real project switch (different id) takes the cold path.
  const seedProjectIdRef = useRef(seed ? projectId : null);

  const atRoot = folderStack.length === 0;
  const currentDir = atRoot ? localFolder : folderStack[folderStack.length - 1].path;
  const browseListing = browseCache.get(currentDir);
  const browseFiles = browseListing?.files || [];
  const browseDirs = browseListing?.dirs || [];

  // ── WhatsApp-export recognition (content-based) ────────────────────────
  // Probe the folders + .zip archives at the current browse level for a chat
  // transcript INSIDE them (main process: `_chat.txt` / a .txt whose first
  // bytes carry WhatsApp's timestamp signature). Verdicts are keyed by path
  // and stamped onto the item model below — recognition follows the
  // CONTENTS, not the name, so a renamed export keeps its WhatsApp mark.
  // The candidate list is keyed as a joined string so the effect re-probes
  // only when the visible set actually changes (browseFiles is a fresh []
  // every render while a listing is loading).
  const [waByPath, setWaByPath] = useState(() => ({}));
  const waCandidatesKey = [
    ...browseDirs.map((d) => d.path),
    // Folders + .zip archives carry their transcript inside; a loose .txt IS the
    // transcript (an extracted `_chat.txt`), so probe those by content too.
    ...browseFiles.filter((f) => /\.(zip|txt)$/i.test(f.name || '')).map((f) => f.path),
  ].filter(Boolean).join('\n');
  useEffect(() => {
    if (!isElectronBranch || !waCandidatesKey) return undefined;
    let cancelled = false;
    detectWhatsApp(waCandidatesKey.split('\n'))
      .then((res) => {
        if (!cancelled && res && typeof res === 'object') {
          setWaByPath((prev) => ({ ...prev, ...res }));
        }
      })
      .catch(() => { /* recognition is cosmetic — just no mark */ });
    return () => { cancelled = true; };
  }, [waCandidatesKey]);

  // ── Hydrate the chosen folder when the project switches ───────────────
  useEffect(() => {
    if (!projectId) {
      setLocalFolder('');
      setLocalFiles([]);
      setLocalError(null);
      setNeedsReconnect(false);
      setHydratedProjectId(null);
      return undefined;
    }
    if (isElectronBranch) {
      // Auto-bind to the fixed per-project directory (Documents/Docvex/<id>).
      // No manual folder picking — the directory IS the project's directory.
      let cancelled = false;
      // While we're still showing the warm-seeded project the listing state is
      // already populated from the prefetch cache — don't blank it (that would
      // re-introduce the "Loading…" flash). The projectDir refresh below still
      // runs to reconcile against the live folder. A switch to a different
      // project (id ≠ the seeded one) blanks normally.
      if (projectId !== seedProjectIdRef.current) setLocalFiles([]);
      setLocalError(null);
      setFolderError(null);
      setNeedsReconnect(false);
      Promise.resolve(localFolderApi.projectDir(projectId, selectedProject?.name, readProjectsDir(userId) || undefined))
        .then(({ path, error }) => {
          if (cancelled) return;
          if (path) {
            setLocalFolder(path);
          } else {
            setLocalFolder('');
            setFolderError(error || 'Could not open the project folder.');
          }
          setHydratedProjectId(projectId);
        })
        .catch((err) => {
          if (cancelled) return;
          // Most common cause: the Electron main process is still the old one
          // (it doesn't hot-reload) and lacks the project-dir handler. Surface
          // it instead of hanging on the "Setting up…" placeholder.
          setLocalFolder('');
          setFolderError(err?.message || 'Could not open the project folder. Restart the app and try again.');
          setHydratedProjectId(projectId);
        });
      return () => { cancelled = true; };
    }
    // Web restore path.
    let cancelled = false;
    setLocalFolder('');
    setLocalFiles([]);
    setLocalError(null);
    setNeedsReconnect(false);
    localFolderApi.restorePersistedHandle(projectId).then((restored) => {
      if (cancelled) return;
      if (restored) {
        setLocalFolder(restored.name);
        setNeedsReconnect(Boolean(restored.needsPermission));
      }
      setHydratedProjectId(projectId);
    });
    return () => { cancelled = true; };
  }, [projectId, folderRetry]);

  // ── Refresh the recursive listing when the folder resolves ────────────
  useEffect(() => {
    if (!projectId) return undefined;
    if (!hasLocalFolderApi || !localFolder) {
      setLocalFiles([]);
      setLocalError(null);
      return undefined;
    }
    if (needsReconnect) {
      setLocalFiles([]);
      setLocalError(null);
      return undefined;
    }
    if (localFolderDebounceRef.current) clearTimeout(localFolderDebounceRef.current);
    let cancelled = false;
    localFolderDebounceRef.current = setTimeout(async () => {
      // Only surface the full-panel "Loading…" when we have nothing to show
      // yet. A warm-seeded open already has a populated grid, so it refreshes
      // silently rather than flashing the spinner over it; a cold open (empty
      // list) shows the spinner as before.
      if (localFiles.length === 0) setLocalLoading(true);
      setLocalError(null);
      const { files: list, error } = await localFolderApi.listAll(localFolder);
      if (cancelled) return;
      setLocalLoading(false);
      if (error) { setLocalError(error); setLocalFiles([]); }
      else setLocalFiles(list || []);
    }, 300);
    return () => {
      cancelled = true;
      if (localFolderDebounceRef.current) clearTimeout(localFolderDebounceRef.current);
    };
  }, [projectId, localFolder, hydratedProjectId, needsReconnect]);

  // ── Recently deleted: sweep expired entries on folder open, then list ──
  const refetchTrash = useCallback(async () => {
    if (!hasLocalFolderApi || !localFolder) { setTrashItems([]); return; }
    setTrashLoading(true);
    const { items } = await localFolderApi.listTrash(localFolder);
    setTrashItems(items || []);
    setTrashLoading(false);
  }, [localFolder]);

  useEffect(() => {
    if (!hasLocalFolderApi || !localFolder || needsReconnect) { setTrashItems([]); return undefined; }
    let cancelled = false;
    (async () => {
      await localFolderApi.purgeTrash({ dir: localFolder });
      if (cancelled) return;
      const { items } = await localFolderApi.listTrash(localFolder);
      if (!cancelled) setTrashItems(items || []);
    })();
    return () => { cancelled = true; };
  }, [localFolder, needsReconnect]);

  // ── Activity tagging ──────────────────────────────────────────────────
  // Attaches project + file context to a notify() payload so the event also
  // lands in the personal activity log (lib/activityLog.js) — that log powers
  // the Activity page's metrics strip and its per-file / per-action grouping.
  const actMeta = useCallback((action, fileName, extra = {}) => ({
    activity: {
      action,
      fileName: fileName || null,
      projectId,
      projectName: selectedProject?.name || null,
      ...extra,
    },
  }), [projectId, selectedProject?.name]);

  // Watcher-detected content edits — a changed mtime on a path that already
  // existed means the file was saved (in Word, an external editor, or by the
  // doc-viewer). Recorded silently (no toast); one event per file per
  // 5 minutes so a save-happy editor doesn't flood the feed. prevFilesRef
  // tracks the last committed listing to diff against.
  const prevFilesRef = useRef(null);
  useEffect(() => { prevFilesRef.current = localFiles; }, [localFiles]);

  // ── Metadata, extracted on arrival ────────────────────────────────────
  // Every file in the folder gets its metadata read and cached in the
  // background, so the Doc Viewer's Metadata tab is already filled in the
  // first time it's opened rather than making the user press a button and
  // wait through a whole-file hash. Uploads come through here too: a write
  // triggers a relist, and a new file has no snapshot yet.
  //
  // The listing array is rebuilt every fetch, so the effect keys on a
  // value-equal signature instead — a poll that returns identical stats must
  // not restart the sweep. Files already cached (unchanged size+mtime) are
  // skipped inside prefetchMetadata, so a steady folder does no work at all.
  const localFilesRef = useRef(localFiles);
  localFilesRef.current = localFiles;
  const metaSweepKey = useMemo(
    () => (localFiles || []).map((f) => `${f.path}:${f.sizeBytes}:${f.mtimeIso}`).join('|'),
    [localFiles],
  );
  useEffect(() => {
    const files = localFilesRef.current;
    if (!files?.length) return undefined;
    return prefetchMetadata(files.filter((f) => f?.path && !String(f.name || '').startsWith('.docvex')));
  }, [metaSweepKey]);
  const editLogGuardRef = useRef(new Map()); // path → last logged ts
  const recordExternalEdits = useCallback((prevList, nextList) => {
    if (!Array.isArray(prevList) || prevList.length === 0) return;
    const EDIT_LOG_THROTTLE_MS = 5 * 60 * 1000;
    const prevByPath = new Map(prevList.map((f) => [f.path, f]));
    const now = Date.now();
    for (const f of nextList) {
      if (!f?.path || !f.mtimeIso) continue;
      const name = String(f.name || '');
      if (name.startsWith('.docvex')) continue; // sidecar / trash bookkeeping
      const prev = prevByPath.get(f.path);
      if (!prev || !prev.mtimeIso || prev.mtimeIso === f.mtimeIso) continue;
      const last = editLogGuardRef.current.get(f.path) || 0;
      if (now - last < EDIT_LOG_THROTTLE_MS) continue;
      editLogGuardRef.current.set(f.path, now);
      notify({
        category: 'file',
        variant: 'info',
        icon: 'edit',
        title: 'File edited',
        body: `“${name}” changed on disk.`,
        silent: true,
        dedupeKey: `fx-edit:${f.path}:${f.mtimeIso}`,
        payload: actMeta('edit', name, { filePath: f.path }),
      });
    }
  }, [notify, actMeta]);

  // ── Live-reload on disk change (Electron fs.watch / web poll) ──────────
  useEffect(() => {
    if (!hasLocalFolderApi || !localFolder) return undefined;
    localFolderApi.watch(localFolder);
    const unsub = localFolderApi.onChange((changedDir) => {
      if (changedDir && changedDir !== localFolder) return;
      localFolderApi.listAll(localFolder).then(({ files: list, error }) => {
        if (!error) {
          recordExternalEdits(prevFilesRef.current, list || []);
          setLocalFiles(list || []);
        }
      });
      setBrowseTick((t) => t + 1);
      refetchTrash();
    });
    return () => { unsub?.(); localFolderApi.unwatch(); };
  }, [localFolder, refetchTrash, recordExternalEdits]);

  // ── Cross-window change sync ──────────────────────────────────────────
  // The disk watcher only ever pings the main window, so a delete or rename in
  // another window (or the doc-viewer's tab sidebar) leaves other Files tabs —
  // notably the doc-viewer's embedded one — stale. These broadcasts re-list
  // every instance: files:removed after a trash, files:changed after a rename.
  useEffect(() => {
    if (!hasLocalFolderApi || !localFolder) return undefined;
    const relist = () => {
      localFolderApi.listAll(localFolder).then(({ files: list, error }) => {
        if (!error) setLocalFiles(list || []);
      });
      setBrowseTick((t) => t + 1);
      refetchTrash();
    };
    const unsubRemoved = onFilesRemoved(relist);
    const unsubChanged = onFilesChanged(relist);
    return () => { unsubRemoved?.(); unsubChanged?.(); };
  }, [localFolder, refetchTrash]);

  // Reset folder navigation when the project / picked folder changes.
  useEffect(() => {
    // While showing the warm-seeded project at its root, keep the seeded root
    // browse cache so the grid stays painted (clearing it would blank the grid
    // for one IPC). folderStack/undo are empty on a fresh mount anyway, so
    // resetting just them is a no-op. Any project/folder change off the seed
    // takes the full reset. (projectId compare → StrictMode-idempotent)
    if (seed?.folder && projectId === seedProjectIdRef.current && localFolder === seed.folder) {
      setFolderStack([]);
      return;
    }
    setFolderStack([]);
    setBrowseCache(new Map());
    clearUndo(); // undo history is folder-scoped — a switch starts fresh
  }, [projectId, localFolder, clearUndo]);

  // ── Browse listing for the CURRENT directory (drafts grid) ────────────
  // Runs on BOTH backends: Electron lists the actual currentDir (real
  // subfolder navigation); the web backend's list() ignores the dir argument
  // and returns the flat folder listing (no subfolders on web) — without this
  // the web grid rendered permanently empty, since draftItems reads only this
  // browse cache (the recursive `localFiles` listing feeds counts, not the grid).
  useEffect(() => {
    if (!localFolder) return undefined;
    let cancelled = false;
    const writeCache = (files, dirs) => {
      setBrowseCache((prev) => {
        const next = new Map(prev);
        next.set(currentDir, { files: files || [], dirs: dirs || [] });
        return next;
      });
    };
    localFolderApi.list(currentDir).then(({ files: bf, dirs: bd }) => {
      if (!cancelled) writeCache(bf, bd);
    }).catch(() => { if (!cancelled) writeCache([], []); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localFolder, currentDir, browseTick]);

  // ── Sidecar: load on folder change, reconcile on listing change ───────
  useEffect(() => {
    if (!projectId || !localFolder) { setSidecar(emptySidecar(projectId, '')); return undefined; }
    let cancelled = false;
    loadSidecar(projectId, localFolder).then((sc) => { if (!cancelled) setSidecar(sc); });
    return () => { cancelled = true; };
  }, [projectId, localFolder]);

  useEffect(() => {
    if (!localFolder) return;
    setSidecar((prev) => {
      if (prev.localFolder !== localFolder) return prev; // not loaded for this folder yet
      const { sidecar: next, changed } = reconcileWithFilesystem(prev, localFiles, [], new Map(), new Map());
      if (changed) saveSidecar(next);
      return next;
    });
  }, [localFiles, localFolder]);

  // ── Folder actions ────────────────────────────────────────────────────
  const refetchLocalFiles = useCallback(async () => {
    if (!hasLocalFolderApi || !localFolder) return;
    const { files: list, error } = await localFolderApi.listAll(localFolder);
    if (!error) setLocalFiles(list || []);
  }, [localFolder]);

  // ── Primitive operations (no undo bookkeeping) ────────────────────────
  // These do the actual filesystem work + sidecar/refetch side-effects and
  // return a small result. The public handlers below call a primitive and
  // then record an inverse on the undo stack; the undo/redo thunks call the
  // primitives directly so they don't push new history.
  const primTrash = useCallback(async (filePath, fileName) => {
    const { ok, stored, error } = await localFolderApi.trashFile({ dir: localFolder, path: filePath });
    if (error || ok === false) return { ok: false, error };
    if (fileName) {
      setSidecar((prev) => {
        const next = removeSidecarByFilename(prev, fileName);
        if (next !== prev) saveSidecar(next);
        return next;
      });
    }
    // Let the doc-viewer close any tab showing this now-deleted file (and any
    // other Files tab re-list).
    notifyFilesRemoved([filePath]);
    setBrowseTick((t) => t + 1);
    await refetchLocalFiles();
    await refetchTrash();
    return { ok: true, stored };
  }, [localFolder, refetchLocalFiles, refetchTrash]);

  const primRestore = useCallback(async (stored) => {
    const { ok, restoredPath, error } = await localFolderApi.restoreFromTrash({ dir: localFolder, stored });
    if (error || ok === false) return { ok: false, error };
    setBrowseTick((t) => t + 1);
    await refetchLocalFiles();
    await refetchTrash();
    return { ok: true, restoredPath };
  }, [localFolder, refetchLocalFiles, refetchTrash]);

  const primRename = useCallback(async (dir, fromName, toName, { syncSidecar = true } = {}) => {
    if (!fromName || !toName || fromName === toName) return { ok: false };
    const { error } = await localFolderApi.renameFile({ dir, fromName, toName });
    if (error) return { ok: false, error };
    // Keep the AI chat (and any saved versions) with the file across the rename.
    // Clear any ORPHANED chat sitting at the destination name first — a since-
    // deleted file of the same name may have left a stale thread there, and
    // because a rename to an occupied name fails on disk, the destination is
    // always free, so any saved thread under it is dead. Without this the
    // renamed file would inherit that other file's history.
    try {
      clearConversation(`${dir}/${toName}`);
      migrateConversation(`${dir}/${fromName}`, `${dir}/${toName}`);
    } catch { /* non-fatal */ }
    if (syncSidecar) {
      setSidecar((prev) => {
        const next = renameSidecarEntry(prev, fromName, toName);
        if (next !== prev) saveSidecar(next);
        return next;
      });
    }
    setBrowseTick((t) => t + 1);
    await refetchLocalFiles();
    return { ok: true };
  }, [refetchLocalFiles]);

  const primCreateFolder = useCallback(async (dir, name) => {
    const { error } = await localFolderApi.createFolder({ dir, name });
    if (error) return { ok: false, error };
    setBrowseTick((t) => t + 1);
    return { ok: true };
  }, []);

  const primDeleteFolder = useCallback(async (dir, name) => {
    const { error } = await localFolderApi.deleteFolder({ dir, name });
    if (error) return { ok: false, error };
    setBrowseTick((t) => t + 1);
    await refetchLocalFiles();
    return { ok: true };
  }, [refetchLocalFiles]);

  // Move a whole folder into the recycle bin (every file inside is trashed,
  // recoverable for 30 days). Returns the stored names so an undo can restore
  // the lot — mirrors primTrash but for a directory.
  const primTrashFolder = useCallback(async (folderPath) => {
    const { ok, stored, error } = await localFolderApi.trashFolder({ dir: localFolder, path: folderPath });
    if (error || ok === false) return { ok: false, error };
    // Close doc-viewer tabs for any file that lived inside this folder.
    notifyFilesRemoved([folderPath]);
    setSidecar((prev) => {
      // Drop any sidecar entries whose files just went to the bin.
      let next = prev;
      for (const s of stored || []) {
        const original = String(s).replace(/^\d+__/, '');
        const after = removeSidecarByFilename(next, original);
        if (after !== next) next = after;
      }
      if (next !== prev) saveSidecar(next);
      return next;
    });
    setBrowseTick((t) => t + 1);
    await refetchLocalFiles();
    await refetchTrash();
    return { ok: true, stored: stored || [] };
  }, [localFolder, refetchLocalFiles, refetchTrash]);

  // Unpack a compressed file. A .zip lands in a sibling "<name> - unzipped"
  // folder; every other format is handed to the OS archiver by main, which
  // comes back as { extracted: false } — nothing changed on disk here, so
  // there's nothing to refetch or undo.
  const primExtractArchive = useCallback(async (srcPath) => {
    const res = await localFolderApi.extractArchive(srcPath);
    if (!res || res.ok === false) return { ok: false, error: res?.error };
    if (res.extracted) {
      setBrowseTick((t) => t + 1);
      await refetchLocalFiles();
    }
    return { ok: true, extracted: !!res.extracted, path: res.path, created: !!res.created };
  }, [refetchLocalFiles]);

  // Restore a batch of binned files (the inverse of primTrashFolder). Best-
  // effort: keeps going if one item can't be restored.
  const primRestoreMany = useCallback(async (storedList) => {
    let okAll = true;
    for (const s of (storedList || [])) {
      const r = await localFolderApi.restoreFromTrash({ dir: localFolder, stored: s });
      if (r.error || r.ok === false) okAll = false;
    }
    setBrowseTick((t) => t + 1);
    await refetchLocalFiles();
    await refetchTrash();
    return okAll;
  }, [localFolder, refetchLocalFiles, refetchTrash]);

  // ── Undo / redo drivers ───────────────────────────────────────────────
  const handleUndo = useCallback(async () => {
    const res = await undo();
    if (!res) return;
    notify(res.ok
      ? { category: 'file', variant: 'info', icon: 'restore', title: 'Undone', body: res.label, dedupeKey: 'fx-undo' }
      : { category: 'file', variant: 'error', title: 'Couldn’t undo', body: `“${res.label}” could not be reversed.`, dedupeKey: 'fx-undo' });
  }, [undo, notify]);

  const handleRedo = useCallback(async () => {
    const res = await redo();
    if (!res) return;
    notify(res.ok
      ? { category: 'file', variant: 'info', icon: 'restore', title: 'Redone', body: res.label, dedupeKey: 'fx-redo' }
      : { category: 'file', variant: 'error', title: 'Couldn’t redo', body: `“${res.label}” could not be reapplied.`, dedupeKey: 'fx-redo' });
  }, [redo, notify]);

  // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo. Suppressed while
  // typing in an input (rename field, search) so it doesn't hijack the
  // browser's text undo.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); handleRedo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUndo, handleRedo]);

  const handleEnterFolder = useCallback((dir) => {
    if (!dir?.path) return;
    setFolderStack((stack) => [...stack, { name: dir.name, path: dir.path }]);
  }, []);

  // Open a WhatsApp export folder's reconstructed conversation in the
  // doc-viewer (transcript located inside it by the main process). Falls back
  // to browsing the folder when it isn't really a WhatsApp export / on web.
  const handleOpenWhatsAppFolder = useCallback(async (dir) => {
    if (!dir?.path) return;
    try {
      const prepped = await prepareWhatsAppFolder(dir.path);
      if (prepped?.ok && prepped.chatPath) {
        openDocViewerWindow({ path: prepped.chatPath, name: prepped.name || dir.name, mime: 'text/plain', isWhatsApp: true });
        return;
      }
    } catch { /* fall through to browse */ }
    handleEnterFolder(dir);
  }, [handleEnterFolder]);

  const handleNavigateCrumb = useCallback((index) => {
    setFolderStack((stack) => (index < 0 ? [] : stack.slice(0, index + 1)));
  }, []);

  const handleCreateFolder = useCallback(async (name) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    const dir = currentDir;
    const res = await primCreateFolder(dir, trimmed);
    if (!res.ok) { notify({ category: 'file', variant: 'error', title: 'Couldn’t create folder', body: res.error || 'Failed to create folder', dedupeKey: 'folder-create-error' }); return; }
    notify({ category: 'file', variant: 'success', icon: 'folder-plus', title: 'Folder created', body: `“${trimmed}” added to this folder.`, silent: true, payload: actMeta('create-folder', trimmed, { folder: true }) });
    pushAction({
      label: `New folder “${trimmed}”`,
      undo: async () => (await primDeleteFolder(dir, trimmed)).ok,
      redo: async () => (await primCreateFolder(dir, trimmed)).ok,
    });
  }, [currentDir, notify, actMeta, primCreateFolder, primDeleteFolder, pushAction]);

  const handleRenameFolder = useCallback(async (folder, newName) => {
    const parent = currentDir;
    const from = folder?.name;
    const to = (newName || '').trim();
    if (!from || !to || to === from) return;
    const res = await primRename(parent, from, to, { syncSidecar: false });
    if (!res.ok) { notify({ category: 'file', variant: 'error', title: 'Couldn’t rename folder', body: res.error || 'Failed to rename folder', dedupeKey: 'folder-rename-error' }); return; }
    notify({ category: 'file', variant: 'success', icon: 'edit', title: 'Folder renamed', body: `“${from}” is now “${to}”.`, silent: true, payload: actMeta('rename', to, { detail: `from “${from}”`, folder: true }) });
    // Move every conversation saved for files inside the folder to the new path.
    try { migrateConversationsUnder(`${parent}/${from}`, `${parent}/${to}`); } catch { /* non-fatal */ }
    pushAction({
      label: `Rename “${from}” → “${to}”`,
      undo: async () => { const ok = (await primRename(parent, to, from, { syncSidecar: false })).ok; if (ok) { try { migrateConversationsUnder(`${parent}/${to}`, `${parent}/${from}`); } catch { /* non-fatal */ } } return ok; },
      redo: async () => { const ok = (await primRename(parent, from, to, { syncSidecar: false })).ok; if (ok) { try { migrateConversationsUnder(`${parent}/${from}`, `${parent}/${to}`); } catch { /* non-fatal */ } } return ok; },
    });
  }, [currentDir, notify, actMeta, primRename, pushAction]);

  const handleDeleteFolder = useCallback(async (dir) => {
    const folderPath = dir?.path;
    const parent = currentDir;
    if (!folderPath) return;
    const res = await primTrashFolder(folderPath);
    if (!res.ok) { notify({ category: 'file', variant: 'error', title: 'Couldn’t delete folder', body: res.error || 'Failed to delete folder', dedupeKey: 'folder-delete-error' }); return; }
    // variant 'error' paints the toast/row red (destructive action); explicit
    // normal priority keeps it from being escalated like a real failure.
    notify({ category: 'file', variant: 'error', priority: 'normal', icon: 'trash', title: 'Moved to Trash', body: `“${dir.name}” will be removed for good in ${TRASH_RETENTION_DAYS} days.`, dedupeKey: `fx-trash-folder:${folderPath}`, payload: actMeta('delete', dir.name, { folder: true }) });
    // Track the stored names so redo (re-trash) can update them; an empty
    // folder leaves nothing in the bin, so undo just recreates it.
    const state = { stored: res.stored, path: folderPath };
    pushAction({
      label: `Delete folder “${dir.name}”`,
      undo: async () => {
        if (state.stored.length) return primRestoreMany(state.stored);
        return (await primCreateFolder(parent, dir.name)).ok;
      },
      redo: async () => {
        const r = await primTrashFolder(state.path);
        if (r.ok) state.stored = r.stored;
        return r.ok;
      },
    });
  }, [currentDir, notify, actMeta, primTrashFolder, primRestoreMany, primCreateFolder, pushAction]);

  const handleBrowseFolder = useCallback(async () => {
    if (!hasLocalFolderApi) return;
    const picked = await localFolderApi.pick();
    if (!picked) return;
    setLocalFolder(picked);
    setNeedsReconnect(false);
    if (projectId) await localFolderApi.persistPickedHandle(projectId);
  }, [projectId]);

  const handleReconnect = useCallback(async () => {
    if (!hasLocalFolderApi) return;
    const ok = await localFolderApi.reconnectHandle();
    if (ok) setNeedsReconnect(false);
    else notify({ category: 'file', variant: 'error', title: 'Folder access denied', body: 'Pick the folder again to reconnect.', dedupeKey: 'reconnect-folder-denied' });
  }, [notify]);

  // Double-click / "Open" — render the file inside its OWN DocVex window
  // instead of handing it to the OS default app. Routing:
  //   • image / video / PDF / text → openFileWindow (Chromium renders the
  //     localfile:// URL natively in a titled "DocVex - <file>" window).
  //   • .docx → rasterized to self-contained HTML via docx-preview and shown
  //     in its own window; falls back to Word/Office on render failure.
  //   • anything Chromium can't render (zip / psd / exe / …) → OS default app.
  // On web there's no localfile:// scheme, so we mint an object URL from the
  // cached file handle's bytes for the viewable types.
  const handleOpenLocalFile = useCallback(async (file) => {
    if (!hasLocalFolderApi || !file?.path) return;
    const name = file.name || 'file';
    const mime = file.mimeType;
    // A WhatsApp export ships as a .zip (transcript + media). Extract it and,
    // if it really is a WhatsApp export, open the reconstructed conversation
    // (with media) in the doc-viewer instead of treating the zip as an opaque
    // archive. Non-WhatsApp zips fall through to the normal handling below.
    if (/\.zip$/i.test(name)) {
      const prepped = await prepareWhatsAppZip(file.path);
      if (prepped?.ok && prepped.chatPath) {
        openDocViewerWindow({ path: prepped.chatPath, name: prepped.name || name, mime: 'text/plain', isWhatsApp: true });
        return;
      }
    }
    // Open EVERY file type in DocVex's document-viewer window (file preview +
    // Legal AI panel). Types it can't preview show a fallback with an "open in
    // default app" button. Electron only; returns false on web, so we fall
    // through to the per-type in-app / OS open below.
    if (openDocViewerWindow({ path: file.path, name, mime: mime || '' })) {
      return;
    }
    // Resolve a window-loadable URL for the on-disk file: localfile:// on
    // Electron, an object URL from the file bytes on web.
    const resolveUrl = async () => {
      const direct = localUrlFor(file.path);
      if (direct) return direct;
      try { return URL.createObjectURL(await readLocalBlob(file.path)); } catch { return null; }
    };

    if (isDocxFile(mime, name)) {
      const url = await resolveUrl();
      if (url) {
        const { error } = await openDocxInWindow({ signedUrl: url, fileName: name });
        if (!error) return;
      }
      openDocx({ localPath: file.path, fileName: name }); // Word / Office fallback
      return;
    }

    if (canViewInBrowser(mime, name)) {
      const url = await resolveUrl();
      if (url) { openFileWindow(url, name); return; }
    }

    // Not renderable in a window — let the OS open it in its default app.
    localFolderApi.openPath(file.path);
  }, []);

  // Copy a set of File/Blob objects (filename + bytes) INTO the folder the
  // user is browsing. Shared by the "Import" button (hidden file input) and
  // drag-and-drop from the OS file manager — both just hand off a file list.
  const importFiles = useCallback(async (picked) => {
    if (!picked || picked.length === 0 || !localFolder) return;
    const payload = picked
      .filter((file) => file && file.name)
      .map((file) => ({ filename: file.name, blob: file }));
    if (payload.length === 0) return;
    const { results, error } = await localFolderApi.writeFiles({ dir: currentDir, files: payload });
    if (error) { notify({ category: 'file', variant: 'error', title: 'Could not add files', body: error, dedupeKey: 'fab-write-error' }); return; }
    const okCount = (results || []).filter((r) => r.ok).length;
    const failCount = (results || []).length - okCount;
    const importedNames = (results || []).filter((r) => r.ok && r.filename).map((r) => r.filename);
    notify({
      category: 'file',
      variant: failCount > 0 ? 'error' : 'success',
      title: failCount > 0 ? 'Added with errors' : 'Files added',
      body: failCount > 0 ? `${okCount} of ${results.length} added · ${failCount} failed` : `${okCount} file${okCount === 1 ? '' : 's'} added.`,
      dedupeKey: 'fab-write-result',
      payload: okCount > 0
        ? actMeta('import', importedNames.length === 1 ? importedNames[0] : null, { count: okCount, files: importedNames })
        : undefined,
    });
    if (okCount > 0) {
      setSidecar((prev) => {
        let next = prev;
        for (const r of results || []) {
          if (!r.ok || !r.filename) continue;
          const lc = r.filename.toLowerCase();
          if (next.byFilename.has(lc)) continue;
          const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          next = addSidecarEntry(next, id, { filename: r.filename, contentHash: null, mtime: new Date().toISOString() });
        }
        if (next !== prev) saveSidecar(next);
        return next;
      });
    }
    setBrowseTick((t) => t + 1);
    await refetchLocalFiles();

    // Record an undo: imported files go to the recycle bin (recoverable),
    // and redo restores them. Each entry's identifiers move with it.
    const added = (results || []).filter((r) => r.ok && r.path).map((r) => ({ path: r.path, name: r.filename, stored: null }));
    if (added.length > 0) {
      pushAction({
        label: added.length === 1 ? `Import “${added[0].name}”` : `Import ${added.length} files`,
        undo: async () => {
          let allOk = true;
          for (const ent of added) {
            const r = await primTrash(ent.path, ent.name);
            if (r.ok) ent.stored = r.stored; else allOk = false;
          }
          return allOk;
        },
        redo: async () => {
          let allOk = true;
          for (const ent of added) {
            if (!ent.stored) { allOk = false; continue; }
            const r = await primRestore(ent.stored);
            if (r.ok && r.restoredPath) ent.path = r.restoredPath; else allOk = false;
          }
          return allOk;
        },
      });
    }
  }, [localFolder, currentDir, notify, actMeta, refetchLocalFiles, pushAction, primTrash, primRestore]);

  // "Import" button → hidden <input type=file>.
  const handleLocalFilesPicked = useCallback(async (e) => {
    const input = e.target;
    const picked = Array.from(input.files || []);
    input.value = '';
    await importFiles(picked);
  }, [importFiles]);

  // Import a WHOLE folder (preserving its subfolder structure) into the current
  // folder. Each entry is { file, relPath } where relPath is like
  // "myFolder/sub/file.txt"; we group by relative directory and write each
  // group into the matching nested dir. write-files mkdir's the target
  // recursively, so the subfolders are created in place. Shared by the
  // <input webkitdirectory> picker and a drag-dropped folder.
  const importFolderEntries = useCallback(async (entries) => {
    if (!entries || entries.length === 0 || !localFolder) return;
    // relDir -> [{ filename, blob }]
    const groups = new Map();
    for (const ent of entries) {
      const f = ent?.file;
      if (!f || !f.name) continue;
      const rel = String(ent.relPath || f.name).replace(/\\/g, '/');
      const slash = rel.lastIndexOf('/');
      const relDir = slash >= 0 ? rel.slice(0, slash) : '';
      const base = slash >= 0 ? rel.slice(slash + 1) : rel;
      if (!base) continue;
      if (!groups.has(relDir)) groups.set(relDir, []);
      groups.get(relDir).push({ filename: base, blob: f });
    }
    if (groups.size === 0) return;
    let ok = 0;
    let fail = 0;
    // Forward slashes in the appended relDir are normalised by Node's path on
    // the main side, so this works regardless of the OS separator in currentDir.
    for (const [relDir, groupFiles] of groups) {
      const dir = relDir ? `${currentDir}/${relDir}` : currentDir;
      const { results, error } = await localFolderApi.writeFiles({ dir, files: groupFiles });
      if (error) { fail += groupFiles.length; continue; }
      ok += (results || []).filter((r) => r.ok).length;
      fail += (results || []).filter((r) => !r.ok).length;
    }
    notify({
      category: 'file',
      variant: fail > 0 ? 'error' : 'success',
      title: fail > 0 ? 'Folder added with errors' : 'Folder added',
      body: fail > 0
        ? `${ok} of ${ok + fail} files imported · ${fail} failed`
        : `${ok} file${ok === 1 ? '' : 's'} imported across ${groups.size} folder${groups.size === 1 ? '' : 's'}.`,
      dedupeKey: 'fx-folder-import',
      payload: ok > 0 ? actMeta('import', null, { count: ok, detail: 'folder import' }) : undefined,
    });
    setBrowseTick((t) => t + 1);
    await refetchLocalFiles();
  }, [localFolder, currentDir, notify, actMeta, refetchLocalFiles]);

  // Drag-and-drop from the OS file manager → copy the dropped files into the
  // current folder. Each entry is { file, relPath }; loose files (no folder in
  // relPath) keep the sidecar/undo handling of importFiles, while anything
  // dropped inside a folder is routed through importFolderEntries so its nested
  // structure is recreated. (Earlier this only read a flat FileList and so
  // silently dropped folders on the floor.)
  const handleDropFiles = useCallback(async (entries) => {
    const list = Array.isArray(entries)
      ? entries
      : Array.from(entries || []).map((f) => ({ file: f, relPath: f?.name }));
    const loose = [];
    const nested = [];
    for (const ent of list) {
      const f = ent?.file;
      if (!f || !f.name) continue;
      const rel = String(ent.relPath || f.name).replace(/\\/g, '/');
      if (rel.includes('/')) nested.push(ent);
      else loose.push(f);
    }
    if (loose.length) await importFiles(loose);
    if (nested.length) await importFolderEntries(nested);
  }, [importFiles, importFolderEntries]);

  // "Import folder" → hidden <input webkitdirectory>. The picked files carry a
  // `webkitRelativePath`; map them into the shared { file, relPath } shape.
  const handleLocalFolderPicked = useCallback(async (e) => {
    const input = e.target;
    const picked = Array.from(input.files || []);
    input.value = '';
    const entries = picked
      .filter((f) => f && f.name)
      .map((f) => ({ file: f, relPath: f.webkitRelativePath || f.name }));
    await importFolderEntries(entries);
  }, [importFolderEntries]);

  const handleRenameLocalFile = useCallback(async (file, newName) => {
    const trimmed = (newName || '').trim();
    if (!trimmed || !file?.name || trimmed === file.name) return;
    const parent = currentDir;
    const from = file.name;
    const res = await primRename(parent, from, trimmed);
    if (!res.ok) { notify({ category: 'file', variant: 'error', title: 'Couldn’t rename', body: res.error || 'Failed to rename', dedupeKey: 'fx-rename-err' }); return; }
    notify({ category: 'file', variant: 'success', icon: 'edit', title: 'File renamed', body: `“${from}” is now “${trimmed}”.`, silent: true, payload: actMeta('rename', trimmed, { detail: `from “${from}”` }) });
    pushAction({
      label: `Rename “${from}” → “${trimmed}”`,
      undo: async () => (await primRename(parent, trimmed, from)).ok,
      redo: async () => (await primRename(parent, from, trimmed)).ok,
    });
  }, [currentDir, notify, actMeta, primRename, pushAction]);

  // ── Copy / paste ──────────────────────────────────────────────────────
  // Paste copies the clipboard's source files (read by their on-disk path)
  // into the CURRENT folder, minting a non-clobbering "… copy" name when a
  // file of the same name already lives here.
  const handlePasteItems = useCallback(async (clipItems) => {
    if (!localFolder || !Array.isArray(clipItems) || clipItems.length === 0) return;
    const taken = new Set(browseFiles.map((f) => (f.name || '').toLowerCase()));
    const uniqueName = (name) => {
      if (!taken.has((name || '').toLowerCase())) return name;
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let candidate = `${base} copy${ext}`;
      let n = 2;
      while (taken.has(candidate.toLowerCase())) { candidate = `${base} copy ${n}${ext}`; n += 1; }
      return candidate;
    };
    const toWrite = [];
    for (const it of clipItems) {
      if (!it?.path) continue;
      try {
        const blob = await readLocalBlob(it.path);
        const filename = uniqueName(it.name || 'file');
        taken.add(filename.toLowerCase());
        toWrite.push({ filename, blob });
      } catch { /* unreadable source — skip */ }
    }
    if (toWrite.length === 0) {
      notify({ category: 'file', variant: 'error', title: 'Couldn’t paste', body: 'The copied file(s) could not be read.', dedupeKey: 'fx-paste-err' });
      return;
    }
    const { results, error } = await localFolderApi.writeFiles({ dir: currentDir, files: toWrite });
    if (error) { notify({ category: 'file', variant: 'error', title: 'Couldn’t paste', body: error, dedupeKey: 'fx-paste-err' }); return; }
    const written = (results || []).filter((r) => r.ok && r.path);
    setBrowseTick((t) => t + 1);
    await refetchLocalFiles();
    notify({ category: 'file', variant: 'success', icon: 'copy', title: written.length > 1 ? 'Files pasted' : 'File pasted', body: `${written.length} file${written.length === 1 ? '' : 's'} added to this folder.`, dedupeKey: 'fx-paste', payload: actMeta('import', written.length === 1 ? written[0].filename : null, { count: written.length, files: written.map((r) => r.filename), detail: 'pasted' }) });
    pushAction({
      label: `Paste ${written.length} file${written.length === 1 ? '' : 's'}`,
      undo: async () => { for (const r of written) await primTrash(r.path, r.filename); setBrowseTick((t) => t + 1); await refetchLocalFiles(); return true; },
      redo: async () => { await localFolderApi.writeFiles({ dir: currentDir, files: toWrite }); setBrowseTick((t) => t + 1); await refetchLocalFiles(); return true; },
    });
  }, [localFolder, currentDir, browseFiles, notify, actMeta, refetchLocalFiles, primTrash, pushAction]);

  // Paste of CUT files — move each from its source folder into the current
  // folder. Inverse moves files back to where they came from.
  const handlePasteCut = useCallback(async (clipItems) => {
    if (!localFolder || !Array.isArray(clipItems) || clipItems.length === 0) return;
    const target = currentDir;
    const join = (d, n) => `${d}/${n}`;
    const parentOf = (p) => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i >= 0 ? p.slice(0, i) : p; };
    const moved = [];
    let fail = 0;
    for (const it of clipItems) {
      if (!it?.path) { fail += 1; continue; }
      const { ok } = await localFolderApi.move({ root: localFolder, fromPath: it.path, toDir: target });
      if (ok) moved.push({ name: it.name, origDir: parentOf(it.path) }); else fail += 1;
    }
    setBrowseTick((t) => t + 1);
    await refetchLocalFiles();
    if (moved.length === 0) {
      notify({ category: 'file', variant: 'error', title: 'Couldn’t move', body: 'The file(s) could not be moved here (a file with that name may already exist).', dedupeKey: 'fx-move-err' });
      return;
    }
    notify({ category: 'file', variant: 'success', icon: 'folder', title: moved.length > 1 ? 'Files moved' : 'File moved', body: `${moved.length} file${moved.length === 1 ? '' : 's'} moved here.`, dedupeKey: 'fx-move', payload: actMeta('move', moved.length === 1 ? moved[0].name : null, { count: moved.length, files: moved.map((m) => m.name) }) });
    pushAction({
      label: `Move ${moved.length} file${moved.length === 1 ? '' : 's'}`,
      undo: async () => { for (const m of moved) await localFolderApi.move({ root: localFolder, fromPath: join(target, m.name), toDir: m.origDir }); setBrowseTick((t) => t + 1); await refetchLocalFiles(); return true; },
      redo: async () => { for (const m of moved) await localFolderApi.move({ root: localFolder, fromPath: join(m.origDir, m.name), toDir: target }); setBrowseTick((t) => t + 1); await refetchLocalFiles(); return true; },
    });
  }, [localFolder, currentDir, notify, actMeta, refetchLocalFiles, pushAction]);

  // ── Move (drag a file onto a folder) ──────────────────────────────────
  // Dragged items always come from the CURRENT folder, so the inverse of a
  // move is just moving them back into `currentDir`.
  const handleMoveItems = useCallback(async (items, targetFolder) => {
    const toDir = targetFolder?._dir?.path || targetFolder?.path;
    const origDir = currentDir;
    if (!localFolder || !toDir || !Array.isArray(items) || items.length === 0) return;
    if (toDir === origDir) return;
    const join = (d, n) => `${d}/${n}`;
    const moved = [];
    let fail = 0;
    for (const it of items) {
      // Files carry their path on `_raw`, folders on `_dir`. The main-process
      // move handler renames either kind by basename, so both work the same.
      const fromPath = it?._raw?.path || it?._dir?.path;
      if (!fromPath) { fail += 1; continue; }
      const { ok, error } = await localFolderApi.move({ root: localFolder, fromPath, toDir });
      if (ok) {
        moved.push({ name: it.name });
        // Keep the AI chat with the file/folder across the move.
        try {
          const toPath = join(toDir, it.name);
          if (it?._dir) migrateConversationsUnder(fromPath, toPath);
          // Drop any orphaned chat left at the destination path by a since-gone
          // file of the same name before moving this file's thread in.
          else { clearConversation(toPath); migrateConversation(fromPath, toPath); }
        } catch { /* non-fatal */ }
      } else fail += 1;
    }
    setBrowseTick((t) => t + 1);
    await refetchLocalFiles();
    if (moved.length === 0) {
      notify({ category: 'file', variant: 'error', title: 'Couldn’t move', body: fail ? 'The item(s) could not be moved (a file with that name may already exist there).' : 'Nothing to move.', dedupeKey: 'fx-move-err' });
      return;
    }
    notify({ category: 'file', variant: 'success', icon: 'folder', title: moved.length > 1 ? 'Files moved' : 'File moved', body: `${moved.length} item${moved.length === 1 ? '' : 's'} moved to “${targetFolder.name}”.`, dedupeKey: 'fx-move', payload: actMeta('move', moved.length === 1 ? moved[0].name : null, { count: moved.length, files: moved.map((m) => m.name), detail: `to “${targetFolder.name}”` }) });
    pushAction({
      label: `Move ${moved.length} item${moved.length === 1 ? '' : 's'} to “${targetFolder.name}”`,
      undo: async () => { for (const m of moved) await localFolderApi.move({ root: localFolder, fromPath: join(toDir, m.name), toDir: origDir }); setBrowseTick((t) => t + 1); await refetchLocalFiles(); return true; },
      redo: async () => { for (const m of moved) await localFolderApi.move({ root: localFolder, fromPath: join(origDir, m.name), toDir }); setBrowseTick((t) => t + 1); await refetchLocalFiles(); return true; },
    });
  }, [localFolder, currentDir, notify, actMeta, refetchLocalFiles, pushAction]);

  // ── Recently deleted actions ──────────────────────────────────────────
  const handleDeleteLocalCard = useCallback(async (file) => {
    if (!file?.path) return;
    const res = await primTrash(file.path, file.name);
    if (!res.ok) { notify({ category: 'file', variant: 'error', title: 'Couldn’t delete', body: res.error || 'Failed to delete', dedupeKey: 'fx-trash-err' }); return; }
    // variant 'error' paints the toast/row red (destructive action); explicit
    // normal priority keeps it from being escalated like a real failure.
    notify({ category: 'file', variant: 'error', priority: 'normal', icon: 'trash', title: 'Moved to Trash', body: `"${file.name}" will be removed for good in ${TRASH_RETENTION_DAYS} days.`, dedupeKey: `fx-trash:${file.path}`, payload: actMeta('delete', file.name, { filePath: file.path }) });
    const state = { stored: res.stored, path: file.path, name: file.name };
    pushAction({
      label: `Delete “${file.name}”`,
      undo: async () => {
        const r = await primRestore(state.stored);
        if (r.ok && r.restoredPath) state.path = r.restoredPath;
        return r.ok;
      },
      redo: async () => {
        const r = await primTrash(state.path, state.name);
        if (r.ok) state.stored = r.stored;
        return r.ok;
      },
    });
  }, [notify, actMeta, primTrash, primRestore, pushAction]);

  const handleRestoreFromTrash = useCallback(async (trash) => {
    if (!trash?.stored) return;
    const res = await primRestore(trash.stored);
    if (!res.ok) { notify({ category: 'file', variant: 'error', title: 'Couldn’t restore', body: res.error || 'Failed to restore', dedupeKey: 'fx-restore-err' }); return; }
    notify({ category: 'file', variant: 'success', icon: 'check', title: 'Restored', body: `"${trash.originalName}" is back in your folder.`, dedupeKey: `fx-restore:${trash.stored}`, payload: actMeta('restore', trash.originalName) });
    const state = { stored: trash.stored, path: res.restoredPath, name: trash.originalName };
    pushAction({
      label: `Restore “${trash.originalName}”`,
      undo: async () => {
        const r = await primTrash(state.path, state.name);
        if (r.ok) state.stored = r.stored;
        return r.ok;
      },
      redo: async () => {
        const r = await primRestore(state.stored);
        if (r.ok && r.restoredPath) state.path = r.restoredPath;
        return r.ok;
      },
    });
  }, [notify, actMeta, primTrash, primRestore, pushAction]);

  // Empty the whole bin — permanently delete every trashed file. Not
  // undoable (mirrors single permanent delete).
  const handleEmptyBin = useCallback(async () => {
    if (!localFolder || trashItems.length === 0) return;
    const count = trashItems.length;
    const results = await Promise.all(
      trashItems.map((t) => localFolderApi.deleteFromTrash({ dir: localFolder, stored: t.stored })),
    );
    const failed = results.filter((r) => r && r.error).length;
    notify(failed > 0
      ? { category: 'file', variant: 'error', title: 'Couldn’t empty the bin', body: `${failed} of ${count} could not be deleted.`, dedupeKey: 'fx-empty-bin' }
      : { category: 'file', variant: 'success', icon: 'trash', title: 'Trash emptied', body: `${count} file${count === 1 ? '' : 's'} permanently deleted.`, dedupeKey: 'fx-empty-bin', payload: actMeta('purge', null, { count }) });
    await refetchTrash();
  }, [localFolder, trashItems, notify, actMeta, refetchTrash]);

  const handlePermanentDelete = useCallback(async (trash) => {
    if (!trash?.stored) return;
    const { error } = await localFolderApi.deleteFromTrash({ dir: localFolder, stored: trash.stored });
    if (error) { notify({ category: 'file', variant: 'error', title: 'Couldn’t delete', body: error, dedupeKey: 'fx-perm-del-err' }); return; }
    notify({ category: 'file', variant: 'success', icon: 'trash', title: 'Permanently deleted', body: `"${trash.originalName}" is gone for good.`, dedupeKey: `fx-perm-del:${trash.stored}`, payload: actMeta('purge', trash.originalName) });
    await refetchTrash();
  }, [localFolder, notify, actMeta, refetchTrash]);

  // Restore every file of a deleted folder back to where it lived.
  const handleRestoreGroup = useCallback(async (item) => {
    const recs = item?._trashGroup || [];
    if (!recs.length) return;
    const okAll = await primRestoreMany(recs.map((r) => r.stored));
    notify(okAll
      ? { category: 'file', variant: 'success', icon: 'check', title: 'Restored', body: `“${item.name}” is back in your folder.`, dedupeKey: `fx-restore-grp:${item.id}`, payload: actMeta('restore', item.name) }
      : { category: 'file', variant: 'error', title: 'Some files couldn’t be restored', body: `Part of “${item.name}” could not be put back.`, dedupeKey: `fx-restore-grp-err:${item.id}` });
  }, [primRestoreMany, notify, actMeta]);

  // Permanently delete every file of a deleted folder.
  const handlePermanentDeleteGroup = useCallback(async (item) => {
    const recs = item?._trashGroup || [];
    if (!recs.length) return;
    for (const r of recs) {
      await localFolderApi.deleteFromTrash({ dir: localFolder, stored: r.stored });
    }
    notify({ category: 'file', variant: 'success', icon: 'trash', title: 'Permanently deleted', body: `“${item.name}” is gone for good.`, dedupeKey: `fx-perm-del-grp:${item.id}`, payload: actMeta('purge', item.name) });
    await refetchTrash();
  }, [localFolder, notify, actMeta, refetchTrash]);

  // ── Guards (after all hooks) ──────────────────────────────────────────
  if (projLoading && !selectedProject) return null;
  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to see its files.</p>
        <button type="button" className="project-scoped-cta" onClick={() => navigate('/projects')}>Browse projects</button>
      </div>
    );
  }

  // ── Item model ────────────────────────────────────────────────────────
  // Folder metrics — total size + last-modified across EVERYTHING under the
  // folder, from the recursive listing (path-prefix match). Null when the
  // folder has no matched files (empty, or the backend's paths can't be
  // prefix-matched) so the row falls back to its '—' placeholders.
  const statsForDir = (dirPath) => {
    if (typeof dirPath !== 'string' || !dirPath) return null;
    let bytes = 0;
    let latest = 0;
    let count = 0;
    for (const f of localFiles) {
      if (typeof f.path !== 'string') continue;
      if (!(f.path.startsWith(`${dirPath}\\`) || f.path.startsWith(`${dirPath}/`))) continue;
      count += 1;
      bytes += Number(f.sizeBytes) || 0;
      const t = f.mtimeIso ? new Date(f.mtimeIso).getTime() : 0;
      if (t > latest) latest = t;
    }
    return count > 0 ? { bytes, latest } : null;
  };
  const realDraftFolders = browseDirs.map((dir) => {
    const stats = statsForDir(dir.path);
    return {
      id: `dir:${dir.path}`,
      kind: 'folder',
      name: dir.name,
      empty: dir.empty,
      status: 'synced',
      sizeLabel: stats ? formatBytes(stats.bytes) : '',
      modifiedLabel: stats?.latest ? formatDate(new Date(stats.latest).toISOString()) : '',
      // Content-probed (see the waByPath effect) — an extracted WhatsApp
      // export folder keeps its mark whatever it's renamed to.
      isWhatsApp: waByPath[dir.path] === true,
      _dir: dir,
    };
  });

  // The Recycle bin lives INSIDE the My drafts panel as a special folder at
  // the root — opening it shows the deleted files (with restore / delete-
  // forever + the 30-day countdown). No separate tab.
  // Count bin contents the way they're shown: a deleted folder is ONE item, not
  // each file inside it (matching the collapsed folder display below).
  const trashDisplayCount = (() => {
    const groups = new Set();
    let loose = 0;
    for (const t of trashItems) {
      if (t.folderGroup) groups.add(t.folderGroup);
      else loose += 1;
    }
    return groups.size + loose;
  })();
  // The special entries carry real metrics like any folder: total size of
  // their contents, and — since neither has a filesystem mtime of its own —
  // the PROJECT's creation date as their date column.
  const projectCreatedLabel = selectedProject?.created_at ? formatDate(selectedProject.created_at) : '';
  const trashBytes = trashItems.reduce((sum, t) => sum + (Number(t.sizeBytes) || 0), 0);
  const binEntryItem = {
    id: '__recycle-bin',
    kind: 'folder',
    name: 'Trash',
    empty: trashItems.length === 0,
    status: 'synced',
    binEntry: true,
    binCount: trashDisplayCount,
    sizeLabel: trashItems.length > 0 ? formatBytes(trashBytes) : '',
    modifiedLabel: projectCreatedLabel,
  };
  const draftItems = browseFiles.map((lf) => {
    const fid = sidecar.byFilename.get((lf.name || '').toLowerCase());
    return {
      id: fid || lf.path || lf.name,
      kind: 'file',
      name: lf.name,
      ext: fileExtOf(lf.name),
      sizeLabel: lf.sizeBytes != null ? formatBytes(lf.sizeBytes) : '',
      modifiedLabel: formatDate(lf.mtimeIso),
      author: 'You',
      status: 'synced',
      // Content-probed verdict for .zip archives and loose .txt transcripts
      // (true/false once resolved; undefined while pending / for other types →
      // FilesWorkspace falls back to its name heuristic until the probe lands).
      isWhatsApp: lf.path ? waByPath[lf.path] : undefined,
      descriptor: describeLocalFile({ localFile: lf }),
      _raw: lf,
    };
  });

  // ── Case-timeline files picked from OUTSIDE the project folder ──
  // There's no separate "Timeline" folder: a timeline's files are just files.
  // Anything the timeline references that already lives in the local folder
  // shows up on its own (in whichever folder it sits in). What's left are the
  // files picked from elsewhere on disk when the timeline was built — surface
  // those in Home so the timeline's evidence is never hidden, and treat them
  // like every other file (same menus, rename / delete / open).
  const externalTimelineItems = (() => {
    if (!caseTimeline || !atRoot || !timelineFilesAllowed) return [];
    const out = [];
    const seen = new Set();
    const known = new Set(localFiles.map((f) => (f.name || '').toLowerCase()));
    const shownHere = new Set(browseFiles.map((f) => (f.name || '').toLowerCase()));
    for (const ev of caseTimeline.events || []) {
      for (const name of ev.files || []) {
        const key = (name || '').toLowerCase();
        if (!key || seen.has(key) || known.has(key) || shownHere.has(key)) continue;
        const ref = caseTimeline.fileRefs?.[name];
        if (!ref?.path) continue;
        seen.add(key);
        const raw = { name, path: ref.path, mimeType: ref.mime };
        out.push({
          id: ref.path,
          kind: 'file',
          name,
          ext: fileExtOf(name),
          sizeLabel: raw.sizeBytes != null ? formatBytes(raw.sizeBytes) : '',
          modifiedLabel: raw.mtimeIso ? formatDate(raw.mtimeIso) : '',
          author: 'You',
          status: 'synced',
          descriptor: describeLocalFile({ localFile: raw }),
          _raw: raw,
        });
      }
    }
    return out;
  })();
  if (externalTimelineItems.length) draftItems.push(...externalTimelineItems);
  // Surface the bin as the first item in every folder (it opens the one
  // project-wide view regardless of where you are in the tree).
  const draftFolders = [binEntryItem, ...realDraftFolders];

  // Files deleted as part of a folder share a `folderGroup`; collapse each
  // group into ONE folder item (Windows-style) so the bin shows the deleted
  // folder, not every file inside it. Loose files stay individual.
  const binFolderItems = [];
  const binFileItems = [];
  const trashGroups = new Map();
  for (const t of trashItems) {
    if (t.folderGroup) {
      if (!trashGroups.has(t.folderGroup)) trashGroups.set(t.folderGroup, []);
      trashGroups.get(t.folderGroup).push(t);
      continue;
    }
    const synthetic = { name: t.originalName, path: t.path, mimeType: t.mimeType, mtimeIso: t.deletedAt };
    binFileItems.push({
      id: t.stored,
      kind: 'file',
      name: t.originalName,
      ext: fileExtOf(t.originalName),
      sizeLabel: t.sizeBytes != null ? formatBytes(t.sizeBytes) : '',
      modifiedLabel: formatDate(t.deletedAt),
      author: 'You',
      status: 'deleted',
      deletesInDays: daysUntilPurge(t.deletedAt),
      descriptor: describeLocalFile({ localFile: synthetic }),
      _raw: synthetic,
      _trash: t,
    });
  }
  for (const [gid, recs] of trashGroups) {
    const first = recs[0];
    const totalBytes = recs.reduce((sum, r) => sum + (r.sizeBytes || 0), 0);
    binFolderItems.push({
      id: `trashgroup:${gid}`,
      kind: 'folder',
      name: first.folderName || 'Folder',
      empty: recs.length === 0,
      status: 'deleted',
      deletesInDays: daysUntilPurge(first.deletedAt),
      sizeLabel: formatBytes(totalBytes),
      modifiedLabel: formatDate(first.deletedAt),
      // The underlying trash records, for whole-folder restore / delete-forever.
      _trashGroup: recs,
    });
  }

  // Breadcrumb. In the bin view, the crumb chain is Home › Trash (clicking
  // Home exits back to drafts).
  const fxCrumbs = filesTab === 'trash'
    ? [
        { label: 'Home', path: '__drafts' },
        { label: 'Trash', path: '__bin' },
      ]
    : [
        { label: 'Home', path: '__root' },
        ...folderStack.map((seg, i) => ({ label: seg.name, path: `__stack:${i}` })),
      ];
  const fxCanUp = filesTab !== 'drafts' ? true : folderStack.length > 0;

  // ── Workspace action handlers ─────────────────────────────────────────
  const fxOpen = (item) => {
    if (item.binEntry) { setFilesTab('trash'); return; }        // open the recycle bin
    if (item.kind === 'folder') {
      // Double-clicking any folder — including a WhatsApp export — browses its
      // contents. The export's reconstructed conversation is reachable from the
      // right-click menu's "Open conversation" instead.
      if (item._dir) handleEnterFolder(item._dir);
      return;
    }
    handleOpenLocalFile(item._raw);
  };
  // The menu's "Open content(s)". For a folder it browses the files (bypassing
  // the WhatsApp conversation a WhatsApp export folder opens by default). For a
  // compressed file it unpacks the archive: a .zip extracts to a sibling folder
  // we then navigate into; other formats open in the OS archiver.
  const fxOpenContent = async (item) => {
    if (item?._dir) {
      // A WhatsApp export folder's menu entry opens the reconstructed
      // conversation (double-click now browses instead).
      if (item.isWhatsApp && item._dir.path) { handleOpenWhatsAppFolder(item._dir); return; }
      handleEnterFolder(item._dir);
      return;
    }
    const src = item?._raw?.path;
    if (!src) return;
    const res = await primExtractArchive(src);
    if (!res.ok) {
      notify({ category: 'file', variant: 'error', title: 'Couldn’t open the archive', body: res.error || 'The compressed file could not be opened.', dedupeKey: 'fx-extract-fail' });
      return;
    }
    // Handed to the OS archiver — nothing landed in this folder.
    if (!res.extracted || !res.path) return;
    // Select the new folder rather than navigating into it: extracting is a
    // step in whatever you were doing here, not a reason to leave the folder.
    const folderName = res.path.split(/[\\/]/).pop();
    setSelectTargetPath(res.path);
    notify({ category: 'file', variant: 'success', icon: 'folder-plus', title: 'Archive extracted', body: `“${item.name}” unpacked into “${folderName}”.`, silent: true, payload: actMeta('create-folder', folderName, { folder: true }) });
    // Undoable only when the extract CREATED the folder. If it already existed
    // we merged into it, and we can't tell the archive's files apart from the
    // ones that were already there — so an "undo" would delete someone's work.
    if (!res.created) return;
    const state = { path: res.path, stored: [] };
    pushAction({
      label: `Extract “${item.name}”`,
      // Undo bins the folder (30-day recycle bin) rather than deleting it, so
      // even a failed redo can't lose the extracted files.
      undo: async () => {
        const r = await primTrashFolder(state.path);
        if (r.ok) state.stored = r.stored;
        return r.ok;
      },
      // Prefer restoring what undo binned — faster than unpacking again, and it
      // brings back anything the user had added to the folder meanwhile.
      redo: async () => {
        if (state.stored.length) return primRestoreMany(state.stored);
        const r = await primExtractArchive(src);
        if (r.ok && r.path) state.path = r.path;
        return r.ok;
      },
    });
  };
  const fxCrumbNav = (path) => {
    if (path === '__drafts') { setFilesTab('drafts'); return; } // leave the bin
    if (path === '__bin') return;
    if (path === '__root') handleNavigateCrumb(-1);
    else if (typeof path === 'string' && path.startsWith('__stack:')) handleNavigateCrumb(Number(path.slice(8)));
  };
  const fxUp = () => {
    if (filesTab !== 'drafts') { setFilesTab('drafts'); return; }
    handleNavigateCrumb(folderStack.length - 2);
  };
  const fxRename = (item, newName) => {
    if (item.kind === 'folder') { if (item._dir?.name) handleRenameFolder(item._dir, (newName || '').trim()); return; }
    handleRenameLocalFile(item._raw, newName);
  };
  const fxDelete = (item) => {
    if (filesTab === 'trash') {
      if (item?._trashGroup) { handlePermanentDeleteGroup(item); return; }
      handlePermanentDelete(item._trash);
      return;
    }
    if (item.kind === 'folder') { if (item._dir) handleDeleteFolder(item._dir); return; }
    handleDeleteLocalCard(item._raw);
  };
  const fxRestore = (item) => {
    if (item?._trashGroup) { handleRestoreGroup(item); return; }
    if (item?._trash) handleRestoreFromTrash(item._trash);
  };
  const fxOpenLocation = (item) => {
    const p = item?.kind === 'folder' ? item?._dir?.path : item?._raw?.path;
    if (p) localFolderApi.showInFolder(p);
  };
  const fxNewFolder = (name) => {
    if (!localFolder) { notify({ category: 'file', variant: 'info', title: 'Connect a folder first', body: 'Choose a folder on your computer, then you can organise it.', dedupeKey: 'fx-newfolder-nofolder' }); return; }
    const trimmed = (name || '').trim();
    if (trimmed) handleCreateFolder(trimmed);
  };
  // New file → create an empty file of the named type on disk, then open it in a
  // Doc Viewer window with the AI generator armed, so the user can describe what
  // they want in the advisor and have Claude fill the document.
  const fxNewFile = async (name) => {
    if (!localFolder) { notify({ category: 'file', variant: 'info', title: 'Connect a folder first', body: 'Choose a folder on your computer, then you can create files in it.', dedupeKey: 'fx-newfile-nofolder' }); return; }
    const filename = (name || '').trim();
    if (!filename) return;
    // Don't assume a type. If the user typed a recognised extension, honour it;
    // otherwise create a "wildcard" placeholder with no extension — the AI
    // advisor infers the real kind from what the user describes and renames the
    // file to the matching extension when it generates the document.
    const kind = docKindFromName(filename);
    try {
      const blob = kind ? await emptyDocumentBlob(kind) : new Blob([''], { type: 'application/octet-stream' });
      const { results, error } = await localFolderApi.writeFiles({ dir: currentDir, files: [{ filename, blob }] });
      setBrowseTick((t) => t + 1);
      const res = results?.[0];
      if (error || !res?.ok || !res?.path) {
        notify({ category: 'file', variant: 'error', title: 'Couldn’t create file', body: error || res?.error || 'Failed to create the file', dedupeKey: 'fx-newfile-error' });
        return;
      }
      await refetchLocalFiles();
      notify({ category: 'file', variant: 'success', icon: 'plus', title: 'File created', body: `“${filename}” added to this folder.`, silent: true, payload: actMeta('create', filename, { filePath: res.path }) });
      // A brand-new file must start with a clean AI thread — drop any stale
      // conversation saved at this exact path by a previous, since-renamed file
      // (e.g. an earlier "Untitled" that became "Untitled.docx"). Without this,
      // the new file would load the old file's chat history.
      clearConversation(res.path);
      // Leave the new file in place (selected for rename) — don't auto-open a
      // Doc Viewer window. The user opens it themselves when ready.
    } catch (err) {
      notify({ category: 'file', variant: 'error', title: 'Couldn’t create file', body: err?.message || String(err), dedupeKey: 'fx-newfile-error' });
    }
  };
  // Create new <type> file → write an empty styled Office file of the chosen kind
  // (docx / pptx / xlsx) to disk, then open it in a Doc Viewer window with the AI
  // generator armed (generate:true) so the user describes what they want and
  // Claude builds it. Uses a unique "Untitled" name so repeated creates don't
  // collide. Backs the "Create new file" dropdown in the Files toolbar.
  const fxCreateTypedFile = async (kind) => {
    if (!localFolder) { notify({ category: 'file', variant: 'info', title: 'Connect a folder first', body: 'Choose a folder on your computer, then you can create files in it.', dedupeKey: 'fx-newfile-nofolder' }); return; }
    const ext = ['pptx', 'xlsx', 'pdf'].includes(kind) ? kind : 'docx';
    // Pick the first free "Untitled[.n].<ext>" against the current folder listing.
    const existing = new Set((localFiles || []).map((f) => String(f.name || '').toLowerCase()));
    let filename = `Untitled.${ext}`;
    for (let n = 2; existing.has(filename.toLowerCase()); n += 1) filename = `Untitled ${n}.${ext}`;
    try {
      const blob = await emptyDocumentBlob(ext);
      const { results, error } = await localFolderApi.writeFiles({ dir: currentDir, files: [{ filename, blob }] });
      setBrowseTick((t) => t + 1);
      const res = results?.[0];
      if (error || !res?.ok || !res?.path) {
        notify({ category: 'file', variant: 'error', title: 'Couldn’t create file', body: error || res?.error || 'Failed to create the file', dedupeKey: 'fx-newfile-error' });
        return;
      }
      await refetchLocalFiles();
      notify({ category: 'file', variant: 'success', icon: 'plus', title: 'File created', body: `“${filename}” added to this folder.`, silent: true, payload: actMeta('create', filename, { filePath: res.path }) });
      // A brand-new file starts with a clean AI thread (drop any stale chat saved
      // at this exact path by a since-renamed file).
      clearConversation(res.path);
      // Don't open it — select the new file and drop into rename mode so the
      // user can name it first (the workspace applies this once it lists).
      setRenameTargetPath(res.path);
    } catch (err) {
      notify({ category: 'file', variant: 'error', title: 'Couldn’t create file', body: err?.message || String(err), dedupeKey: 'fx-newfile-error' });
    }
  };
  const fxUpload = () => {
    if (!localFolder) { handleBrowseFolder(); return; }
    if (needsReconnect) { handleReconnect(); return; }
    localUploadInputRef.current?.click();
  };
  // Resolve a breadcrumb path token to its real directory, then move the
  // dragged files there (reuses the same move + undo machinery).
  const fxMoveToCrumb = (crumb, items) => {
    const tokenPath = crumb?.path;
    let dir = null;
    if (tokenPath === '__root') dir = { path: localFolder, name: 'Home' };
    else if (typeof tokenPath === 'string' && tokenPath.startsWith('__stack:')) {
      const seg = folderStack[Number(tokenPath.slice(8))];
      if (seg) dir = { path: seg.path, name: seg.name };
    }
    if (!dir?.path) return;
    handleMoveItems(items, { name: dir.name, _dir: { path: dir.path } });
  };
  const fxUploadFolder = () => {
    if (!localFolder) { handleBrowseFolder(); return; }
    if (needsReconnect) { handleReconnect(); return; }
    localFolderUploadInputRef.current?.click();
  };

  // Masthead — a Versions-style hero for the Files tab. The eyebrow + kicker
  // describe the FILES (not the project): where they live, how many, how big,
  // and when they last changed. Totals come from the recursive listing.
  // Shown only in the drafts tab (not the recycle bin).
  // The masthead follows the folder you're in: at Home it's the project-wide
  // "Files" hero; inside a subfolder the hero becomes THAT folder (its name
  // as the title, its contents' stats as the kicker, and the containing path
  // as the muted eyebrow tail). Stats scope to everything under the current
  // folder via a path-prefix match on the recursive listing, falling back to
  // the current level's listing when paths can't be matched (web backend).
  const inFolder = folderStack.length > 0;
  const mastheadFiles = (() => {
    if (!inFolder) return localFiles;
    if (typeof currentDir === 'string' && currentDir) {
      const matches = localFiles.filter((f) => typeof f.path === 'string'
        && (f.path.startsWith(`${currentDir}\\`) || f.path.startsWith(`${currentDir}/`)));
      if (matches.length) return matches;
    }
    return browseFiles;
  })();
  const fxTotalBytes = mastheadFiles.reduce((sum, f) => sum + (Number(f.sizeBytes) || 0), 0);
  const fxLatestMtime = mastheadFiles.reduce((latest, f) => {
    const t = f.mtimeIso ? new Date(f.mtimeIso).getTime() : 0;
    return t > latest ? t : latest;
  }, 0);
  const fxUpdatedLabel = fxLatestMtime
    ? new Date(fxLatestMtime).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  const fxKicker = mastheadFiles.length === 0
    ? (inFolder ? 'Empty folder' : 'No files yet — add or import files to get started')
    : [
        `${fmtCount(mastheadFiles.length)} ${mastheadFiles.length === 1 ? 'file' : 'files'}`,
        fmtBytesFull(fxTotalBytes),
        fxUpdatedLabel ? `Updated ${fxUpdatedLabel}` : null,
      ].filter(Boolean).join(' · ');
  const filesMasthead = filesTab === 'drafts' ? (inFolder ? {
    eyebrow: 'Project files',
    // The folder's location — Home plus any folders above it in the stack.
    access: ['Home', ...folderStack.slice(0, -1).map((s) => s.name)].join(' › '),
    title: folderStack[folderStack.length - 1].name,
    kicker: fxKicker,
  } : {
    eyebrow: 'Project files',
    access: 'Stored in your local folder',
    title: 'Files',
    kicker: fxKicker,
  }) : {
    eyebrow: 'Project files',
    access: 'Recycle bin',
    title: 'Trash',
    kicker: trashDisplayCount === 0
      ? 'Trash is empty'
      : `${fmtCount(trashDisplayCount)} ${trashDisplayCount === 1 ? 'item' : 'items'} · Removed for good after ${TRASH_RETENTION_DAYS} days`,
  };

  const filesWorkspaceProps = {
    projectId,
    masthead: filesMasthead,
    summaryText: `${localFiles.length} ${localFiles.length === 1 ? 'file' : 'files'}`,
    // `tab` ('drafts' | 'trash') is the in-panel mode: 'trash' is the recycle
    // bin, entered by opening its root folder entry and exited via the
    // breadcrumb.
    tab: filesTab,
    canEdit: true,
    hasLocalFolder: Boolean(localFolder),
    // Electron auto-binds the project directory (no manual picking) — only the
    // web backend exposes a folder picker / reconnect affordance.
    onPickFolder: isElectronBranch ? undefined : (needsReconnect ? handleReconnect : handleBrowseFolder),
    hasLocalFolderApi,
    folderError,
    onRetryFolder: () => setFolderRetry((t) => t + 1),
    crumbs: fxCrumbs,
    onCrumb: fxCrumbNav,
    onBack: fxUp,
    onUp: fxUp,
    canBack: fxCanUp,
    canUp: fxCanUp,
    folders: filesTab === 'drafts' ? draftFolders : binFolderItems,
    items: filesTab === 'drafts' ? draftItems : binFileItems,
    loading: filesTab === 'trash' ? trashLoading : localLoading,
    onOpen: fxOpen,
    onOpenContent: fxOpenContent,
    onRename: fxRename,
    onDelete: fxDelete,
    onRestore: fxRestore,
    onOpenLocation: fxOpenLocation,
    // No toolbar refresh button — the doc-viewer's "Files" chrome has its own
    // refresh (which broadcasts files:changed → relist), and the main Files page
    // auto-refreshes on the disk watcher.
    onRefresh: undefined,
    onNewFolder: fxNewFolder,
    onNewFile: (hasLocalFolderApi && filesTab === 'drafts' && Boolean(localFolder)) ? fxNewFile : undefined,
    onCreateTypedFile: (hasLocalFolderApi && filesTab === 'drafts' && Boolean(localFolder)) ? fxCreateTypedFile : undefined,
    renameTargetPath,
    onRenameTargetConsumed: () => setRenameTargetPath(null),
    selectTargetPath,
    onSelectTargetConsumed: () => setSelectTargetPath(null),
    onUpload: fxUpload,
    onUploadFolder: fxUploadFolder,
    onEmptyBin: handleEmptyBin,
    // DEV-only: seed the bin with items at staggered expiry to preview the
    // countdown rings.
    onDebugSeedTrash: (import.meta.env.DEV && filesTab === 'trash' && Boolean(localFolder))
      ? async () => {
          await localFolderApi.debugSeedTrash({ dir: localFolder, days: [30, 25, 20, 15, 10, 5, 3, 2, 1] });
          setBrowseTick((t) => t + 1);
          await refetchTrash();
        }
      : undefined,
    // Open the current folder in the OS file manager (Electron only).
    onOpenDirectory: (hasLocalFolderApi && currentDir)
      ? () => localFolderApi.openPath(currentDir)
      : undefined,
    // Drag-and-drop import — copies dropped OS files into the current folder.
    // Disabled in the bin and when no folder is bound.
    onDropFiles: (filesTab === 'drafts' && Boolean(localFolder)) ? handleDropFiles : undefined,
    // Copy / paste (footer + Ctrl+C / Ctrl+V) and drag-to-move between folders
    // — drafts only, and only with a bound local folder.
    onPasteItems: (filesTab === 'drafts' && Boolean(localFolder)) ? handlePasteItems : undefined,
    onPasteCut: (filesTab === 'drafts' && Boolean(localFolder)) ? handlePasteCut : undefined,
    onMoveItems: (filesTab === 'drafts' && Boolean(localFolder)) ? handleMoveItems : undefined,
    onMoveToCrumb: (filesTab === 'drafts' && Boolean(localFolder)) ? fxMoveToCrumb : undefined,
    // Undo / redo (footer buttons + Ctrl+Z / Ctrl+Y).
    onUndo: handleUndo,
    onRedo: handleRedo,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
  };

  return (
    <div className="project-scoped-page project-files-page fx-root">
      <FilesWorkspace {...filesWorkspaceProps} />
      <input
        ref={localUploadInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleLocalFilesPicked}
      />
      {/* Folder import — webkitdirectory/directory are set via the ref callback
          because React doesn't reliably render those non-standard attributes. */}
      <input
        ref={(el) => {
          localFolderUploadInputRef.current = el;
          if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', ''); }
        }}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleLocalFolderPicked}
      />
      {localError && filesTab === 'drafts' && (
        <p className="fx-local-error" role="alert">{localError}</p>
      )}
    </div>
  );
}

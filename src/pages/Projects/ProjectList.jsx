import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { useNotifications } from '../../context/NotificationsContext';
import { updateProject, deleteProject } from '../../lib/projects';
import {
  sortProjectsByRecent,
  getMostRecentProjectId,
  getRecentMap,
  markProjectAccessed,
  RECENT_PROJECTS_CHANGED_EVENT,
} from '../../lib/recentProjects';
import { readProjectsDir } from '../../lib/projectsDir';
import { readCachedProjects, writeCachedProjects } from '../../lib/projectListCache';
import { fetchProjects, peekProjects, invalidateProjects } from '../../lib/projectListPrefetch';
import { localFolderApi, isElectronBranch } from '../../lib/localFolder';
import {
  openExternal,
  listExternalOpens,
  openExternalFile,
  removeExternalOpen,
  onExternalOpensChanged,
} from '../../lib/platform';
import { glyphForFile } from '../../components/fileGlyph';
import { formatRelativeTime } from '../../lib/notifications';
import { PLAN } from '../../lib/plan';
import { getStatusOption, updateStatus, DEFAULT_STATUS_KEY } from '../../lib/userStatus';
import Tooltip from '../../components/Tooltip';
import StatusPicker from '../../components/StatusPicker';
import DeleteProjectModal from '../../components/DeleteProjectModal';
import './ProjectList.css';

// Projects "Hub" — recreates the old launch-hub Projects screen (a left rail +
// expandable project rows) inside the main app at /projects. Opening a project
// selects it and navigates to the Files page in the SAME window (single-window
// app — there are no per-project windows anymore). Create / rename / delete use
// the main app's flows. All `lh-`-prefixed (carried over from the hub so the
// visuals match). The title bar shows "DOCVEX | HUB" on this route.

const DOCS_URL = 'https://docvex.ro/';

// ── Icons (inline per codebase convention; stroke = currentColor) ──
const PlusIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);
const SearchIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);
const CaretIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 6 15 12 9 18" />
  </svg>
);
const UsersIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
const FolderIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);
const PencilIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);
const TrashIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

// ── Sidebar nav icons ──
const ProjectsNavIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
  </svg>
);
const UpdatesNavIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 3 21 9 15 9" />
  </svg>
);
const SettingsNavIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
const DocsNavIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </svg>
);

// Same 12-colour djb2 avatar scheme used across the app.
const AVATAR_PALETTE = ['#0891B2', '#BE185D', '#4F46E5', '#047857', '#B45309', '#6D28D9', '#DC2626', '#0369A1', '#DB2777', '#059669', '#7C3AED', '#EA580C'];
function avatarColor(seed) {
  let h = 0;
  for (let i = 0; i < (seed || '').length; i++) { h = ((h << 5) - h) + seed.charCodeAt(i); h |= 0; }
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

function timeAgo(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function getDisplayName(user) {
  const meta = user?.user_metadata;
  if (meta?.full_name) return meta.full_name;
  if (meta?.name) return meta.name;
  if (user?.email) {
    const at = user.email.indexOf('@');
    return at > 0 ? user.email.slice(0, at) : user.email;
  }
  return 'there';
}

function AvatarStack({ members = [], max = 4 }) {
  const shown = members.slice(0, max);
  if (shown.length === 0) return null;
  return (
    <div className="lh-avatars">
      {shown.map((m) => (
        <Tooltip key={m.userId} content={m.name}>
          <span
            className="lh-avatar"
            style={m.avatarUrl ? undefined : { background: avatarColor(m.userId) }}
          >
            {m.avatarUrl
              ? <img src={m.avatarUrl} alt="" referrerPolicy="no-referrer" draggable={false} />
              : m.initials}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

// Display path for a project: the projects directory (Settings) joined with the
// project name, when a directory is set. There's no per-project path here, so
// this is a derived display.
function projectPathFor(projectsDir, project) {
  if (!projectsDir) return 'No local folder set';
  const sep = projectsDir.includes('\\') ? '\\' : '/';
  return `${projectsDir.replace(/[\\/]+$/, '')}${sep}${project.name}`;
}

function ProjectRow({ project, lastOpened, mostRecent, projectsDir, onOpen, onRename, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const [savingName, setSavingName] = useState(false);
  const menuRef = useRef(null);
  const inputRef = useRef(null);
  const cancelRef = useRef(false);
  const n = project.member_count;
  const lastAccessed = lastOpened ? timeAgo(lastOpened) : (timeAgo(project.updated_at) || '—');
  const pathLine = projectPathFor(projectsDir, project);

  // Close the cog menu on outside-click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  // Focus + select the inline rename input when entering edit mode.
  useEffect(() => {
    if (editing) requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
  }, [editing]);

  const startRename = () => { setDraftName(project.name); setMenuOpen(false); setEditing(true); };

  // Single commit path (Enter / Escape both blur; onBlur decides save vs cancel).
  const onRenameKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); inputRef.current?.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelRef.current = true; inputRef.current?.blur(); }
  };
  const onRenameBlur = async () => {
    if (cancelRef.current) { cancelRef.current = false; setEditing(false); setDraftName(project.name); return; }
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === project.name) { setEditing(false); setDraftName(project.name); return; }
    setSavingName(true);
    const ok = await onRename(project, trimmed);
    setSavingName(false);
    setEditing(false);
    if (!ok) setDraftName(project.name);
  };

  return (
    <div className={`lh-row${expanded ? ' is-expanded' : ''}`}>
      <div className="lh-row-top">
        {/* Dropdown — toggles the project-data panel below. */}
        <button
          type="button"
          className="lh-row-expand"
          onClick={() => setExpanded((v) => !v)}
          aria-label="View project data"
          aria-expanded={expanded}
        >
          <span className="lh-row-expand-caret">{CaretIcon}</span>
        </button>

        {/* Name + path. Clicking opens the project; in rename mode the name
            becomes an inline input. */}
        {editing ? (
          <div className="lh-row-main lh-row-main-edit">
            <input
              ref={inputRef}
              type="text"
              className="lh-row-name-input"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={onRenameKey}
              onBlur={onRenameBlur}
              maxLength={60}
              disabled={savingName}
              aria-label="Rename project"
            />
            <span className="lh-row-path">{pathLine}</span>
          </div>
        ) : (
          <button type="button" className="lh-row-main" onClick={() => onOpen(project)}>
            <span className="lh-row-name-main">
              {project.name}
              {mostRecent && <span className="lh-recent-tag">most recent</span>}
            </span>
            <span className="lh-row-path">{pathLine}</span>
          </button>
        )}

        {/* Last accessed. */}
        <div className="lh-row-accessed">
          <span className="lh-row-accessed-label">last accessed</span>
          <span className="lh-row-accessed-val">{lastAccessed}</span>
        </div>

        {/* Cog — opens a Rename / Delete menu. */}
        <div className="lh-row-config-wrap" ref={menuRef}>
          <Tooltip content={menuOpen ? undefined : 'Project options'}>
            <button
              type="button"
              className={`lh-row-config${menuOpen ? ' is-open' : ''}`}
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Project options"
            >
              {SettingsNavIcon}
            </button>
          </Tooltip>
          {menuOpen && (
            <div className="lh-row-menu" role="menu">
              <button type="button" role="menuitem" className="lh-row-menu-item" onClick={startRename}>
                <span className="lh-row-menu-icon">{PencilIcon}</span> Rename
              </button>
              <button
                type="button"
                role="menuitem"
                className="lh-row-menu-item is-danger"
                onClick={() => { setMenuOpen(false); onDelete(project); }}
              >
                <span className="lh-row-menu-icon">{TrashIcon}</span> Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Always rendered (not conditional) so the panel can animate open AND
          closed; `.lh-row.is-expanded` drives the grid-rows reveal. The inner
          clip layer carries no padding/border so it collapses fully to 0. */}
      <div className="lh-row-data-anim">
        <div className="lh-row-data-clip">
          <div className="lh-row-data">
            <div className="lh-row-data-item">
              <span className="lh-row-data-key">Role</span>
              <span className={`lh-pill is-${project.role}`}>{project.role}</span>
            </div>
            <div className="lh-row-data-item">
              <span className="lh-row-data-key">Members</span>
              <span className="lh-row-data-members">
                <AvatarStack members={project.members} max={4} />
                <span className="lh-row-member-count">
                  <span className="lh-users-icon">{UsersIcon}</span>
                  {typeof n === 'number' ? n : '—'}
                </span>
              </span>
            </div>
            <div className="lh-row-data-item">
              <span className="lh-row-data-key">Last updated</span>
              <span className="lh-row-data-val">{timeAgo(project.updated_at) || '—'}</span>
            </div>
            <div className="lh-row-data-item lh-row-data-desc">
              <span className="lh-row-data-key">Description</span>
              <span className="lh-row-data-val">{project.description || 'No description.'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ProjectList() {
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  const navigate = useNavigate();
  const { selectProject, beginSwitch } = useSelectedProject();
  const { notify } = useNotifications();

  // Seed synchronously so the very FIRST painted frame has rows: the session's
  // prefetch snapshot if the sidebar hover warmed one, otherwise the last list
  // written to localStorage. Doing this in an effect (as it was) meant one
  // guaranteed empty frame — the blank flash on every Hub open.
  const seed = useRef(null);
  if (seed.current === null) seed.current = peekProjects() || readCachedProjects(userId);
  const [projects, setProjects] = useState(seed.current);
  const [loading, setLoading] = useState(seed.current.length === 0);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [openMsg, setOpenMsg] = useState('');
  const [projectsDir, setProjectsDir] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [statusAnchor, setStatusAnchor] = useState(null);
  // Bump to recompute ordering when the recency map changes.
  const [recencyTick, setRecencyTick] = useState(0);

  useEffect(() => { setProjectsDir(readProjectsDir(userId)); }, [userId]);

  // The synchronous seed above runs before `session` has necessarily hydrated,
  // so it may have read the anonymous cache key. Once the real user id lands,
  // fill in from that user's cache — but only into an empty list, so a fetch
  // that already produced live rows is never overwritten by the cache.
  useEffect(() => {
    if (!userId) return;
    const cached = readCachedProjects(userId);
    if (!cached.length) return;
    setProjects((prev) => (prev.length ? prev : cached));
    setLoading(false);
  }, [userId]);

  // No setLoading(true) here: with cached rows already on screen, flipping back
  // to the skeleton would make a background refresh look like a reload.
  // Routed through the prefetch module so a hover-warmed request is adopted
  // rather than duplicated.
  const loadProjects = useCallback(async () => {
    const { data, error: err } = await fetchProjects();
    if (data) setProjects(data);
    setError(err);
    setLoading(false);
  }, []);

  useEffect(() => { if (session) loadProjects(); }, [session, loadProjects]);

  // Mirror whatever is on screen back to the cache — this catches the fetch
  // AND the local mutations (rename, delete), so the next open doesn't flash
  // a name the user already changed.
  useEffect(() => {
    if (userId && projects.length) writeCachedProjects(userId, projects);
  }, [userId, projects]);

  useEffect(() => {
    const onRecent = () => setRecencyTick((t) => t + 1);
    window.addEventListener(RECENT_PROJECTS_CHANGED_EVENT, onRecent);
    return () => window.removeEventListener(RECENT_PROJECTS_CHANGED_EVENT, onRecent);
  }, [userId]);

  // "Opened with DocVex" — standalone files opened through the OS file
  // association. Electron-only (the web list is always empty) and NOT tied
  // to any project.
  const [externalOpens, setExternalOpens] = useState([]);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      listExternalOpens().then((l) => { if (alive) setExternalOpens(Array.isArray(l) ? l : []); });
    };
    refresh();
    const off = onExternalOpensChanged(refresh);
    return () => { alive = false; off(); };
  }, []);

  const ordered = useMemo(() => sortProjectsByRecent(userId, projects), [userId, projects, recencyTick]);
  const mostRecentId = useMemo(() => getMostRecentProjectId(userId), [userId, projects, recencyTick]);
  const recentMap = useMemo(() => getRecentMap(userId), [userId, projects, recencyTick]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q),
    );
  }, [ordered, query]);

  // True once we've confirmed the user has zero projects (not just mid-load).
  const showEmptyState = !loading && !error && projects.length === 0;
  const showNoFolder = isElectronBranch && !projectsDir;

  // Open a project in the SAME window: stamp recency, show the switch overlay,
  // select it globally, then land on the working Files surface.
  const onOpen = (project) => {
    markProjectAccessed(userId, project.id, project.name);
    beginSwitch(project.name);
    selectProject(project.id, project);
    navigate('/files');
  };

  const onNewProject = () => navigate('/projects/new');

  // Open a project from a folder on disk: pick a directory, read its
  // `.docvex.json` sidecar for the project id, and open that project if it's
  // one the user has access to.
  const onOpenFromDirectory = async () => {
    setOpenMsg('');
    const dir = await localFolderApi.pick();
    if (!dir) return;
    const { json } = await localFolderApi.readSidecar(dir);
    const pid = json?.projectId;
    if (!pid) {
      setOpenMsg("That folder isn't a Docvex project — no .docvex.json was found in it.");
      return;
    }
    const match = projects.find((p) => p.id === pid);
    if (!match) {
      setOpenMsg("That project isn't in your account, or you don't have access to it.");
      return;
    }
    onOpen(match);
  };

  // Rename — inline from the row title. Persists, updates the list in place,
  // and returns success so the row can revert its draft on failure.
  const onRenameProject = async (project, newName) => {
    const { data, error: err } = await updateProject(project.id, { name: newName });
    if (err) {
      notify?.({ category: 'project', variant: 'error', icon: 'alert', title: 'Could not rename project', body: err.message, dedupeKey: `rename-fail-${project.id}` });
      return false;
    }
    const finalName = data?.name || newName;
    // The session snapshot still holds the old name; drop it so a later Hub
    // open doesn't paint the pre-rename row for a beat.
    invalidateProjects();
    setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, name: finalName } : p)));
    notify?.({ category: 'project', variant: 'success', icon: 'folder', title: `Renamed to “${finalName}”`, dedupeKey: `rename-${project.id}` });
    return true;
  };

  // Delete — opens the GitHub-style retype-to-confirm modal.
  const onRequestDelete = (project) => setDeleteTarget(project);
  const confirmDeleteProject = async () => {
    if (!deleteTarget) return;
    setDeletingProject(true);
    const { error: err } = await deleteProject(deleteTarget.id);
    setDeletingProject(false);
    if (err) {
      notify?.({ category: 'project', variant: 'error', icon: 'alert', title: 'Could not delete project', body: err.message, dedupeKey: `delete-fail-${deleteTarget.id}` });
      return;
    }
    const name = deleteTarget.name;
    invalidateProjects();
    setProjects((prev) => prev.filter((p) => p.id !== deleteTarget.id));
    setDeleteTarget(null);
    notify?.({ category: 'project', variant: 'warning', icon: 'trash', title: `Deleted “${name}”`, dedupeKey: `project-deleted-${name}` });
  };

  const displayName = getDisplayName(session?.user);
  const avatarUrl = session?.user?.user_metadata?.avatar_url || null;
  const avatarInitial = (displayName || '?').trim().charAt(0).toUpperCase();
  const statusOpt = getStatusOption(session?.user?.user_metadata?.status || DEFAULT_STATUS_KEY);

  return (
    <div className="lh-hub lh-hub-no-rail">
      <main className="lh-main">
        <div className="lh-main-inner">
          {showEmptyState ? (
            <div className="lh-empty">
              <h2>No projects yet</h2>
              <p>
                {showNoFolder
                  ? 'Set a projects folder in Settings, then create your first project to start working with your team.'
                  : 'Create your first project to start working with your team.'}
              </p>
              <button type="button" className="lh-new-btn" onClick={onNewProject}>
                {PlusIcon} Create your first project
              </button>
              {isElectronBranch && (
                <>
                  <span className="lh-empty-or">or</span>
                  <button type="button" className="lh-open-btn lh-empty-open" onClick={onOpenFromDirectory}>
                    {FolderIcon} Import project
                  </button>
                </>
              )}
            </div>
          ) : (
            <>
              <header className="lh-headline">
                <div className="lh-eyebrow">
                  <span>Workspace</span>
                </div>
                <h1 className="lh-title">Hub</h1>
                <p className="lh-greeting">Welcome back, {displayName}</p>
              </header>

              {/* No projects folder set → nudge the user to pick one in Settings
                  (new projects mirror to a folder there). */}
              {showNoFolder && (
                <button type="button" className="lh-nofolder" onClick={() => navigate('/settings')}>
                  <span className="lh-nofolder-icon">{FolderIcon}</span>
                  <span className="lh-nofolder-text">
                    <strong>No projects folder selected</strong>
                    <span>Choose a folder in Settings to auto-create a folder for each new project.</span>
                  </span>
                  <span className="lh-nofolder-cta">Open Settings</span>
                </button>
              )}

              <div className="lh-toolbar">
                <div className="lh-search">
                  <span className="lh-search-icon">{SearchIcon}</span>
                  <input
                    type="text"
                    className="lh-search-input"
                    placeholder="Search projects…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                {isElectronBranch && (
                  <button type="button" className="lh-open-btn" onClick={onOpenFromDirectory}>
                    {FolderIcon} Import
                  </button>
                )}
                <button type="button" className="lh-new-btn" onClick={onNewProject}>
                  {PlusIcon} New
                </button>
              </div>

              {openMsg && <div className="lh-open-msg">{openMsg}</div>}

              <div className="lh-list-frame">
                {!loading && error && (
                  <div className="lh-state lh-state-error">
                    Couldn't load projects: {error.message}
                  </div>
                )}

                {!loading && !error && filtered.length === 0 && (
                  <div className="lh-state">No projects match “{query}”.</div>
                )}

                {!loading && !error && filtered.length > 0 && (
                  <div className="lh-list">
                    {filtered.map((p) => (
                      <ProjectRow
                        key={p.id}
                        project={p}
                        lastOpened={recentMap[p.id]?.ts}
                        mostRecent={p.id === mostRecentId}
                        projectsDir={projectsDir}
                        onOpen={onOpen}
                        onRename={onRenameProject}
                        onDelete={onRequestDelete}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* Standalone files opened via the OS "Open with DocVex" verb —
              each reopens in its own Doc Viewer window; none belong to a
              project. */}
          {externalOpens.length > 0 && (
            <section className="lh-extopens">
              <div className="lh-extopens-head">Opened with DocVex</div>
              <div className="lh-extopens-list">
                {externalOpens.map((f) => (
                  <div
                    key={f.path}
                    className="lh-extopen-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => openExternalFile(f.path)}
                    onKeyDown={(e) => { if (e.key === 'Enter') openExternalFile(f.path); }}
                  >
                    <span className="lh-extopen-ico">{glyphForFile(f.mime || '', f.name)}</span>
                    <span className="lh-extopen-main">
                      <span className="lh-extopen-name">{f.name}</span>
                      <span className="lh-extopen-path">{f.path}</span>
                    </span>
                    <span className="lh-extopen-time">{formatRelativeTime(f.at)}</span>
                    <Tooltip content="Remove from this list">
                      <button
                        type="button"
                        className="lh-extopen-remove"
                        aria-label={`Remove ${f.name} from this list`}
                        onClick={(e) => { e.stopPropagation(); removeExternalOpen(f.path); }}
                      >
                        ×
                      </button>
                    </Tooltip>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>

      {/* GitHub-style "type the name to confirm" delete dialog. */}
      <DeleteProjectModal
        open={!!deleteTarget}
        projectName={deleteTarget?.name || ''}
        pending={deletingProject}
        onConfirm={confirmDeleteProject}
        onCancel={() => { if (!deletingProject) setDeleteTarget(null); }}
      />

      {/* Status picker — anchored to the clicked status circle in the footer. */}
      {statusAnchor && (
        <StatusPicker
          anchorRect={statusAnchor}
          currentStatus={session?.user?.user_metadata?.status || DEFAULT_STATUS_KEY}
          onPick={async (key) => { setStatusAnchor(null); await updateStatus(key); }}
          onClose={() => setStatusAnchor(null)}
        />
      )}
    </div>
  );
}

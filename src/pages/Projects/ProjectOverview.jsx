import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useProject } from '../../context/ProjectContext';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { useNotifications } from '../../context/NotificationsContext';
import { useAuth } from '../../context/AuthContext';
import {
  deleteProject,
  getProjectAiUsage,
  listInvitations,
  notifyProjectsChanged,
  removeMember,
  revokeInvite,
  sendInvite,
  updateProject,
  updateProjectAiContext,
  updateProjectJurisdiction,
} from '../../lib/projects';
import { JURISDICTIONS, DEFAULT_JURISDICTION, getJurisdiction } from '../../lib/jurisdictions';
import { deleteCustomRole } from '../../lib/customRoles';
import { localFolderApi, isElectronBranch } from '../../lib/localFolder';
import { readProjectsDir } from '../../lib/projectsDir';
import { wipeProjectFiles, wipeProjectAiMemory, wipeProjectFileData } from '../../lib/projectDataWipe';
import { miniHeaderSpot } from '../../lib/miniHeaderSpot';
import { readAiTokens, resetAiTokens, AI_TOKENS_CHANGED_EVENT } from '../../lib/aiTokenMeter';
import MiniHeaderFade from '../../components/MiniHeaderFade';
import { useHasCapability } from '../../hooks/useHasCapability';
import DeleteProjectModal from '../../components/DeleteProjectModal';
import InviteMemberModal from '../../components/InviteMemberModal';
import RemoveMemberModal from '../../components/RemoveMemberModal';
import ChangeMemberRoleModal from '../../components/ChangeMemberRoleModal';
import RoleLocked from '../../components/RoleLocked';
import RoleBadge, { builtInLabel } from '../../components/RoleBadge';
import CustomRoleEditor from '../../components/CustomRoleEditor';
import ConfirmModal from '../../components/ConfirmModal';
import FilterTabs from '../../components/FilterTabs';
import DangerZone, { DangerRow } from '../../components/DangerZone';
import Tooltip from '../../components/Tooltip';
import StatusBadge from '../../components/StatusBadge';
import './ProjectDashboard.css';
import './ProjectDossier.css';

// Plus glyph for the "Invite member" CTA. Same stroke recipe as the
// PlusIcon constant in ProjectList.jsx so the two CTAs read as siblings.
const PlusIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

// Chevron-down glyph for the per-row expand affordance. Rotates 180° via
// CSS when the row is expanded so the same SVG serves both states; same
// stroke recipe as the other inline icons here.
const ChevronDownIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

// Matches the UsersIcon used on Project cards in ProjectList.jsx so the
// "N members" affordance reads consistently across the two surfaces.
const UsersIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

// Pencil glyph for the inline "rename in the header" affordance — appears
// next to the hero title for owners; clicking swaps the title for an input.
const PencilIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

// Check glyph for the AI-context Save button.
const CheckIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

// Small generic usage gauge for the dossier Overview. Most gauges are
// static placeholders (no data source yet); "Active members" and "AI tokens"
// are real. `fmt` compacts large numbers (token counts run to six digits, which
// would blow the row's layout unformatted).
function UsageGauge({ label, used, total, unit, tint, hint, fmt }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const show = fmt || ((v) => v);
  return (
    <div className="pjd-usage-row">
      <div className="pjd-usage-head">
        <span className="pjd-usage-label">{label}</span>
        <span className="pjd-usage-value">{show(used)}<span className="pjd-usage-of"> / {show(total)} {unit}</span></span>
      </div>
      <div className="pjd-usage-bar"><span className="pjd-usage-fill" style={{ width: pct + '%', background: tint }} /></div>
      <div className="pjd-usage-hint">{hint}</div>
    </div>
  );
}

// Free-plan monthly allowances the AI-usage bars fill against. These are the
// denominators ("418 / 1,000"); the numerators are real values from
// get_project_ai_usage. When real plan tiers land (lib/plan.js), source these
// from the active plan instead.
// `tokens` is the combined allowance the merged "AI tokens" gauge on the
// Overview fills against — input + output, since that's the single number the
// gauge reports. The split caps stay for the AI tab's per-direction cells.
const AI_MONTHLY_CAPS = { requests: 1000, tokens: 750000, inputTokens: 500000, outputTokens: 250000, sessions: 50 };

// "1,240" for small counts, "214K" / "2.1M" for large ones — keeps the stat
// values compact without losing the order of magnitude.
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}K`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return v.toLocaleString();
}

// Plain thousands-separated integer for request / session counts.
function fmtCount(n) {
  return (Number(n) || 0).toLocaleString();
}

// Human-readable byte size for the hero kicker ("0 B" / "12.4 KB" / "2.4 MB").
function fmtBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// Compact relative-time for the activity timeline ("12m", "3h", "2d", …).
function relTime(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (Number.isNaN(mins)) return '';
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d === 1) return '1d';
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.round(d / 7)}w`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Project Overview — the landing page for /projects/:id. Reached by clicking
// a card in the Projects list. Focus: "who's on this project" + "manage it".
// The "working surface" (recent files) lives at /projects/:id/dashboard so
// users can keep two distinct mental models for the two destinations.
//
// Auto-selecting this project into SelectedProjectContext is handled by
// <ProjectAutoSelect/> at the ProjectShell level — see App.jsx.

// Resolves a human-readable display name from a member profile in the same
// order as the Sidebar/Account helpers (full_name > name > email local part).
function getMemberName(profile) {
  if (!profile) return 'Unknown member';
  if (profile.full_name) return profile.full_name;
  if (profile.name) return profile.name;
  if (profile.email) {
    const at = profile.email.indexOf('@');
    return at > 0 ? profile.email.slice(0, at) : profile.email;
  }
  return 'Unknown member';
}

function MemberAvatar({ profile }) {
  const avatarUrl = profile?.avatar_url;
  const initial = (profile?.email || profile?.full_name || '?').charAt(0).toUpperCase();
  const status = profile?.status;
  const avatarEl = avatarUrl ? (
    <img className="member-avatar" src={avatarUrl} alt="" referrerPolicy="no-referrer" />
  ) : (
    <span className="member-avatar member-avatar-fallback">{initial}</span>
  );
  return (
    <span className="member-avatar-wrap">
      {avatarEl}
      <StatusBadge status={status} size="sm" ringColor="var(--bg-card)" />
    </span>
  );
}

// "Expires in N days" hint for a pending invitation. Rounds down on the day
// — a row that expires in 23h59m reads as "Expires today", a row that
// expires in 1d05m reads as "Expires in 1 day". Past dates render "Expired".
function formatExpiry(isoString) {
  if (!isoString) return '';
  const expires = new Date(isoString).getTime();
  const now = Date.now();
  const ms = expires - now;
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'Expired';
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `Expires in ${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
  return 'Expires soon';
}

// The page's sections, in the order they read: what the project IS, who's on
// it, what the AI knows, and what can be destroyed. Same shape FilterTabs takes
// on the Activity feed.
const SETTINGS_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'members', label: 'Members' },
  { id: 'ai', label: 'AI' },
  { id: 'danger', label: 'Danger zone' },
];

// Confirm copy for the danger zone's three wipes. Each says plainly what goes,
// what stays, and — where it matters — that this machine is the only one
// affected. A destructive confirm that just says "Are you sure?" makes the
// user guess at the blast radius.
const WIPE_COPY = {
  files: {
    title: 'Delete every file in this project?',
    message: 'Every file and folder inside this project\'s folder on this computer will be permanently deleted. This is not the recycle bin — they do not come back. The project, its members and its chat are unaffected, and a teammate\'s copy of the folder is untouched.',
    confirm: 'Delete all files',
  },
  aiMemory: {
    title: 'Wipe this project\'s AI memory?',
    message: 'Clears the project\'s standing AI instructions — which are shared with your team, so this affects everyone — along with every AI file description, cached search answer, and per-document advisor conversation on this computer. Your files are not touched, but the next AI search has to read the folder again, which costs requests.',
    confirm: 'Wipe AI memory',
  },
  fileData: {
    title: 'Clear derived file data?',
    message: 'Deletes the transcripts, extracted text, metadata snapshots and audio waveforms DocVex built from your documents, plus this project\'s cached chat — all on this computer only. Your files are not touched. Anything you need again is re-read on demand; transcripts have to be generated again, which costs a request.',
    confirm: 'Clear file data',
  },
};

export default function ProjectOverview() {
  const {
    project, role, members, customRoles, loading, error, refresh,
    removeMemberLocal, setMemberRoleLocal, removeCustomRoleLocal,
    refreshCustomRoles,
  } = useProject();
  // Capability-aware gates for the affordances that ARE in the toggleable
  // set (post-migration 008). Owners/admins resolve to true for all of
  // these via the base-tier matrix; custom-role members get them per their
  // override set. Manage-custom-roles is NOT in the capability set on
  // purpose — gated on the legacy admin+ tier below via `isAdmin`.
  const canInvite     = useHasCapability('members.invite');
  const canRemove     = useHasCapability('members.remove');
  const canChangeRole = useHasCapability('members.change_role');
  const { clearSelection, patchSelectedProject } = useSelectedProject();
  const { notify } = useNotifications();
  const { session } = useAuth();
  const navigate = useNavigate();
  // The caller's auth id, used to flag their row in the Members list with a
  // "You" pill. Read off the session because useProject() returns members
  // joined with profile data only — no flag for self.
  const currentUserId = session?.user?.id ?? null;

  // Stable "you first, then everyone else in their existing order" ordering.
  // useMemo so we don't re-allocate the array on every unrelated re-render
  // (notifications, etc.) — members itself is referentially stable across
  // those because ProjectContext only swaps it when the Realtime channel
  // fires.
  const orderedMembers = useMemo(() => {
    if (!currentUserId) return members;
    const selfIdx = members.findIndex((m) => m.user_id === currentUserId);
    if (selfIdx <= 0) return members;
    return [members[selfIdx], ...members.slice(0, selfIdx), ...members.slice(selfIdx + 1)];
  }, [members, currentUserId]);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  // Danger-zone wipes: which one is awaiting confirmation, which is running,
  // and the folder they operate on.
  // Which section the tab strip is showing.
  const [section, setSection] = useState('overview');
  const [wipe, setWipe] = useState(null);        // 'files' | 'aiMemory' | 'fileData' | null
  const [wiping, setWiping] = useState(null);
  const [wipeError, setWipeError] = useState(null);
  const [localFolderPath, setLocalFolderPath] = useState('');

  // Kick-member state — `removeTarget` holds the member row whose kick
  // modal is open (null when closed). Splitting target / pending / error
  // mirrors the delete-project trio above so the patterns read the same.
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState(null);

  // Change-role state — `roleChangeTarget` holds the member row whose role
  // picker is open. Lives in the modal itself; no pending/error mirrored
  // here because the modal owns its own RPC lifecycle (same pattern as
  // CustomRoleEditor).
  const [roleChangeTarget, setRoleChangeTarget] = useState(null);

  // Per-row expanded-actions state. Stores the user_id of the row whose
  // actions panel is currently revealed (or null if none). Single-slot:
  // expanding one row auto-collapses any other — matches the accordion
  // pattern users already expect from this kind of list. Esc collapses
  // whichever is open; we don't close on outside click because the panel
  // is inline (no overlay), so the click-anywhere-to-dismiss convention
  // would surprise more than help.
  const [expandedUserId, setExpandedUserId] = useState(null);

  useEffect(() => {
    if (expandedUserId === null) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setExpandedUserId(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [expandedUserId]);

  // Admin-only — owner+admin both qualify per the RANK helper in RoleGate.
  // Inline comparison avoids the extra hook call since we only need it once.
  const isAdmin = role === 'owner' || role === 'admin';
  const isOwner = role === 'owner';

  // Show "Remove" on a member row when the viewer has the members.remove
  // capability (admin+ by default, OR a custom-role member with the
  // override granted), the target row is NOT the owner (RLS would reject
  // anyway), AND the target row is NOT the viewer themselves (self-removal
  // will get a dedicated "Leave project" flow in a follow-up).
  const canRemoveMember = (m) =>
    canRemove && m.role !== 'owner' && m.user_id !== currentUserId;

  // Show "Change role" on a member row when the viewer has the
  // members.change_role capability AND the target row is NOT the owner
  // (RLS's `with check (role <> 'owner')` rejects owner edits anyway, and
  // the picker omits owner as an option). Self-edit is permitted in
  // principle — RLS doesn't block it — but we hide the button on the
  // viewer's own row to avoid foot-guns like "I just demoted myself out
  // of admin and can't undo it." A separate flow can be added if anyone
  // ever needs to self-demote.
  const canChangeMemberRole = (m) =>
    canChangeRole && m.role !== 'owner' && m.user_id !== currentUserId;

  // ── Custom roles tab state ──────────────────────────────────────────────
  // `editorTarget` semantics:
  //   undefined  → editor is closed.
  //   null       → editor is open in CREATE mode.
  //   {role row} → editor is open in EDIT mode for that role.
  // We distinguish closed vs create-mode with `!== undefined` because both
  // null and an object are valid "open" states.
  const [editorTarget, setEditorTarget] = useState(undefined);
  // Delete-confirm state for a custom role row. Same target-or-null pattern
  // as the member-kick flow.
  const [roleDeleteTarget, setRoleDeleteTarget] = useState(null);
  const [roleDeletePending, setRoleDeletePending] = useState(false);


  // AI project-context textarea — real, persisted to projects.ai_context
  // (migration 030). Local edit buffer seeded from the project row via the
  // effect below; only Save commits. `savingAiContext` drives the button
  // label; admins write (RLS gates non-admins out anyway, and the UI disables
  // editing for them).
  const [aiContext, setAiContext] = useState('');
  const [savingAiContext, setSavingAiContext] = useState(false);

  // Jurisdiction — which country's law this project is worked under (migration
  // 033). Unlike the context textarea this is a single choice, so it saves the
  // moment it changes rather than through a dirty buffer + Save button. The
  // select reads straight from the project row; `savingJurisdiction` holds the
  // in-flight code so the control can show which value is landing.
  const [savingJurisdiction, setSavingJurisdiction] = useState(null);
  const jurisdictionCode = project?.jurisdiction || DEFAULT_JURISDICTION;
  const jurisdiction = getJurisdiction(jurisdictionCode);
  const handleJurisdictionChange = async (code) => {
    if (savingJurisdiction || code === jurisdictionCode) return;
    setSavingJurisdiction(code);
    const { error: jErr } = await updateProjectJurisdiction(project.id, code);
    setSavingJurisdiction(null);
    if (jErr) {
      notify({
        category: 'project',
        variant: 'error',
        title: 'Could not change the jurisdiction',
        body: jErr.message || 'The server rejected the request.',
      });
      return;
    }
    // Mirror into the selected-project row so the ambient jurisdiction every AI
    // request is stamped with updates now, without waiting for a refetch.
    patchSelectedProject?.({ jurisdiction: code });
    refresh?.();
    notify({
      category: 'project',
      variant: 'success',
      icon: 'edit',
      title: `Jurisdiction set to ${getJurisdiction(code).name}`,
      body: 'The AI will apply this law to legal work in this project.',
      dedupeKey: `project-jurisdiction-${project.id}`,
    });
  };

  // Real monthly AI usage aggregates for this project (get_project_ai_usage
  // RPC). null while loading / on error. Counts are genuinely zero until a
  // project-scoped AI feature logs its first request via logProjectAiUsage.
  const [aiUsage, setAiUsage] = useState(null);
  const [aiUsageLoading, setAiUsageLoading] = useState(true);

  // Locally-tracked per-project token total (lib/aiTokenMeter). Read
  // synchronously and refreshed on the meter's change event, so the gauge
  // moves the moment an AI request finishes anywhere in the app.
  const [aiTokenMeter, setAiTokenMeter] = useState(() => readAiTokens(project?.id));
  useEffect(() => {
    const sync = () => setAiTokenMeter(readAiTokens(project?.id));
    sync();
    window.addEventListener(AI_TOKENS_CHANGED_EVENT, sync);
    return () => window.removeEventListener(AI_TOKENS_CHANGED_EVENT, sync);
  }, [project?.id]);

  // File count + total bytes for the hero kicker. Files are local-only now (no
  // cloud file store since migration 031), so these come from the project's
  // local folder — Electron only; the web build has no ambient folder and shows
  // zeros. Mirrors the count the title bar shows.
  const [fileStats, setFileStats] = useState({ count: 0, bytes: 0 });

  // Compact-header-on-scroll, mirroring the Versions page. The page scrolls
  // inside the single-window pane's `.sv-single-scroll` (falling back to
  // `.main-content`); we listen there and fade a fixed, blurred bar in once the
  // hero has scrolled away. Hysteresis (show past 32px, hide under 8px) avoids
  // flicker at the threshold. Keyed on project/loading so it re-attaches once
  // the real page (with `pageRef`) mounts after the loading state.
  const pageRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const scroller = pageRef.current?.closest('.sv-single-scroll, .main-content');
    if (!scroller) return undefined;
    const onScroll = () => {
      const top = scroller.scrollTop;
      setScrolled((s) => (s ? top > 8 : top > 32));
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [project?.id, loading, error]);
  const scrollToTop = () => {
    pageRef.current?.closest('.sv-single-scroll, .main-content')?.scrollTo({ top: 0, behavior: 'smooth' });
  };


  // ── Project (name + description) edit form ──────────────────────────────
  // Local form state mirrors the server's project row, synced from useProject()
  // via the effect below. We keep it separate from project.{name,description}
  // so the user can type freely without optimistically writing into the
  // shared context — only Save commits.
  const [editName, setEditName] = useState('');
  const [savingProject, setSavingProject] = useState(false);
  // Inline header rename — `editingName` swaps the hero <h1> for an input.
  // Owner-only; commits on Enter/blur, reverts on Escape.
  const [editingName, setEditingName] = useState(false);
  const nameInputRef = useRef(null);
  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [editingName]);

  // Sync the editable name from the server whenever the project row changes
  // (initial load + any Realtime UPDATE from ProjectContext's postgres_changes
  // subscription). This means a rename committed elsewhere — another admin,
  // another window — appears in the hero immediately. Guarded on !editingName
  // so a remote echo can't clobber an in-progress edit mid-keystroke.
  useEffect(() => {
    if (!editingName) setEditName(project?.name ?? '');
  }, [project?.id, project?.name, editingName]);

  // Seed the AI-context buffer from the project row — initial load + any
  // Realtime UPDATE (another admin saving elsewhere). Keyed on ai_context so a
  // remote change refreshes the buffer; because Save writes the trimmed value,
  // the post-save Realtime echo re-seeds to the same text rather than clobbering
  // in-flight typing.
  useEffect(() => {
    setAiContext(project?.ai_context ?? '');
  }, [project?.id, project?.ai_context]);

  // Commit the inline header rename. No-ops / invalid input revert to the
  // server value and close the editor; a real change persists via
  // updateProject (name-only patch) and mirrors into SelectedProjectContext +
  // the picker cache, same as the old Settings form did.
  const commitName = async () => {
    if (savingProject) return;
    const trimmedName = editName.trim();
    // Empty / too long / unchanged → revert and close without a write.
    if (trimmedName.length === 0 || trimmedName.length > 80 || trimmedName === (project?.name ?? '')) {
      if (trimmedName.length === 0) {
        notify({
          category: 'project',
          variant: 'error',
          title: 'Name is required',
          dedupeKey: `project-name-empty-${project.id}`,
        });
      } else if (trimmedName.length > 80) {
        notify({
          category: 'project',
          variant: 'error',
          title: 'Name is too long',
          body: 'Project names are capped at 80 characters.',
          dedupeKey: `project-name-long-${project.id}`,
        });
      }
      setEditName(project?.name ?? '');
      setEditingName(false);
      return;
    }
    setSavingProject(true);
    const { data: updated, error: updErr } = await updateProject(project.id, {
      name: trimmedName,
    });
    setSavingProject(false);
    setEditingName(false);
    if (updErr) {
      setEditName(project?.name ?? '');
      notify({
        category: 'project',
        variant: 'error',
        title: 'Could not rename project',
        body: updErr.message || 'The server rejected the request.',
      });
      return;
    }
    // ProjectContext's Realtime UPDATE handler patches `project` and resets
    // the form via the sync effect above — but Realtime has a 50-300ms
    // round-trip and (more importantly) only feeds ProjectContext.
    // SelectedProjectContext keeps its own `selectedProject` snapshot for
    // the sidebar trigger + ProjectBanner; without an explicit patch it
    // would render the stale name until the user reloads or re-selects.
    // The Hub (project list) caches projects and invalidates on
    // PROJECTS_CHANGED_EVENT, so we fire that too so the Hub shows the new
    // name next time it's opened. Use the server's returned row
    // when present (`updated`) so the patch reflects authoritative values
    // including any trimming Postgres applied.
    const patch = updated || { id: project.id, name: trimmedName };
    patchSelectedProject(patch);
    notifyProjectsChanged();
    notify({
      category: 'project',
      variant: 'success',
      icon: 'edit',
      title: 'Project renamed',
      dedupeKey: `project-updated-${project.id}`,
    });
  };

  // Persist the per-project AI context. Admin-gated in the UI; the underlying
  // RLS ("admins update projects") rejects non-admins too. The Realtime UPDATE
  // from ProjectContext re-seeds the buffer to the saved value, so no explicit
  // local patch is needed here.
  const handleSaveAiContext = async () => {
    if (savingAiContext) return;
    setSavingAiContext(true);
    const { error: aiErr } = await updateProjectAiContext(project.id, aiContext);
    setSavingAiContext(false);
    if (aiErr) {
      notify({
        category: 'project',
        variant: 'error',
        title: 'Could not save AI context',
        body: aiErr.message || 'The server rejected the request.',
      });
      return;
    }
    notify({
      category: 'project',
      variant: 'success',
      icon: 'edit',
      title: 'AI context saved',
      dedupeKey: `ai-context-saved-${project.id}`,
    });
  };

  // Pending invitations state. Only fetched + rendered for admins (RLS would
  // return an empty list to non-admins anyway, but the fetch is wasted work
  // and rendering an empty Pending card on non-admin views would be misleading).
  const [invitations, setInvitations] = useState([]);
  const [invLoaded, setInvLoaded] = useState(false);
  const [revokingId, setRevokingId] = useState(null);
  const [resendingId, setResendingId] = useState(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  // Tracks which invitation row most recently had its link copied, so the
  // per-row button can briefly flip its label to "Copied" without holding
  // shared "I copied SOMETHING" state across all rows.
  const [copiedInviteId, setCopiedInviteId] = useState(null);

  useEffect(() => {
    if (!project?.id || !isAdmin) {
      setInvitations([]);
      setInvLoaded(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error: invErr } = await listInvitations(project.id);
      if (cancelled) return;
      // listInvitations returns { data: [], error } on failure — render an
      // empty list rather than blocking the page. Admin-targeting failures
      // are rare and the page still functions without the pending section.
      setInvitations(invErr ? [] : (data || []));
      setInvLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [project?.id, isAdmin]);

  // Monthly AI usage aggregates for the AI tab. Visible to all members (the
  // RPC's underlying RLS handles access), so no role gate — re-fetched per
  // project. Counts are real and start at zero until a project-scoped AI
  // feature logs a request.
  useEffect(() => {
    if (!project?.id) { setAiUsage(null); setAiUsageLoading(false); return; }
    let cancelled = false;
    setAiUsageLoading(true);
    (async () => {
      const { data } = await getProjectAiUsage(project.id);
      if (cancelled) return;
      setAiUsage(data);
      setAiUsageLoading(false);
    })();
    return () => { cancelled = true; };
  }, [project?.id]);

  // File count + total size for the hero kicker — read from the project's local
  // folder and summed locally. Electron only (web has no ambient folder path);
  // re-fetched per project; falls back to zeros on error or when unresolved.
  // The resolved path is kept: the danger zone's wipes need it, and it's the
  // same lookup.
  useEffect(() => {
    if (!project?.id || !isElectronBranch) { setFileStats({ count: 0, bytes: 0 }); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        const { path } = await localFolderApi.projectDir(project.id, project.name, readProjectsDir(currentUserId) || undefined);
        if (!cancelled) setLocalFolderPath(path || '');
        if (!path) { if (!cancelled) setFileStats({ count: 0, bytes: 0 }); return; }
        const { files, error: fErr } = await localFolderApi.listAll(path);
        if (cancelled) return;
        if (fErr || !files) { setFileStats({ count: 0, bytes: 0 }); return; }
        const bytes = files.reduce((sum, f) => sum + (Number(f.sizeBytes) || 0), 0);
        setFileStats({ count: files.length, bytes });
      } catch { if (!cancelled) setFileStats({ count: 0, bytes: 0 }); }
    })();
    return () => { cancelled = true; };
  }, [project?.id, project?.name, currentUserId]);

  // ── Danger-zone wipes ─────────────────────────────────────────────────
  // `wipe` names the pending action (and drives the confirm dialog); `wiping`
  // is the one in flight. Nothing runs without passing through ConfirmModal.
  const runWipe = async () => {
    const action = wipe;
    if (!action) return;
    setWipeError(null);
    setWiping(action);
    try {
      if (action === 'files') {
        const { deleted, failed } = await wipeProjectFiles(localFolderPath);
        setFileStats({ count: 0, bytes: 0 });
        notify({
          category: 'file',
          variant: failed ? 'warning' : 'info',
          icon: 'trash',
          title: failed ? 'Some files could not be deleted' : 'Project files deleted',
          body: failed
            ? `${deleted} removed, ${failed} could not be — they may be open in another program.`
            : `${deleted} item${deleted === 1 ? '' : 's'} deleted from this computer.`,
          dedupeKey: `wipe-files:${project.id}`,
        });
      } else if (action === 'aiMemory') {
        await wipeProjectAiMemory(project.id, localFolderPath);
        setAiContext('');
        notify({
          category: 'project',
          variant: 'info',
          icon: 'sparkles',
          title: 'AI memory wiped',
          body: 'Instructions, file descriptions, cached answers and advisor threads cleared.',
          dedupeKey: `wipe-ai:${project.id}`,
        });
      } else {
        const { cleared } = wipeProjectFileData(project.id, localFolderPath);
        notify({
          category: 'file',
          variant: 'info',
          icon: 'sparkles',
          title: 'File data cleared',
          body: `${cleared} cached result${cleared === 1 ? '' : 's'} removed from this computer.`,
          dedupeKey: `wipe-data:${project.id}`,
        });
      }
      setWipe(null);
    } catch (err) {
      setWipeError(err?.message || 'That didn’t finish. Nothing else was changed.');
    } finally {
      setWiping(null);
    }
  };

  const handleInviteSent = (newInvitation) => {
    // Prepend so the freshest invite reads first (matches the API's order-by
    // created_at desc). De-dup by email + id so a re-invite of the same
    // address (which the Edge Function upserts) doesn't create a phantom row.
    setInvitations((prev) => {
      const sameAddr = prev.findIndex((i) =>
        i.email?.toLowerCase() === newInvitation.email?.toLowerCase());
      if (sameAddr >= 0) {
        const next = prev.slice();
        next[sameAddr] = { ...prev[sameAddr], ...newInvitation };
        return next;
      }
      return [newInvitation, ...prev];
    });
  };

  // Copy the docvex://invite?token=... URL to the clipboard so the admin
  // can DM it manually when the auto-send email leg failed (Resend
  // domain not verified, no API key, etc.). The token is already in the
  // local state from listInvitations(); admins can see it because the RLS
  // policy on project_invitations gates SELECT on has_project_role('admin').
  const handleCopyLink = async (inv) => {
    if (!inv?.token) return;
    const url = `docvex://invite?token=${inv.token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedInviteId(inv.id);
      // Auto-reset so a row that was once copied doesn't stay highlighted
      // forever across re-renders.
      setTimeout(() => {
        setCopiedInviteId((cur) => (cur === inv.id ? null : cur));
      }, 1800);
    } catch {
      notify({
        category: 'system',
        variant: 'error',
        title: 'Could not copy',
        body: 'Clipboard access was denied.',
      });  // icon falls back to 'alert' via variant default
    }
  };

  // Retrigger the email send for an EXISTING pending invitation. The
  // send-invite Edge Function's upsert path takes the existing row's
  // token (no new invitation created), runs the same Resend call as a
  // fresh invite, and returns email_status + email_error so we can toast
  // the result. Useful for "the email went to spam" / "Resend was misconfigured
  // and I just fixed it" / "Gmail dropped it on the floor" cases.
  const handleResend = async (inv) => {
    if (!inv?.email || !inv?.role) return;
    setResendingId(inv.id);
    const { data, error } = await sendInvite(project.id, inv.email, inv.role);
    setResendingId(null);
    if (error) {
      notify({
        category: 'member',
        variant: 'error',
        title: 'Could not resend invitation',
        body: error.message || 'The server rejected the request.',
      });
      return;
    }
    const emailStatus = data?.email_status;
    if (emailStatus === 'sent') {
      notify({
        category: 'member',
        variant: 'success',
        icon: 'envelope',
        title: 'Invitation resent',
        body: `Email delivered to ${inv.email}.`,
        dedupeKey: `invite-resent-${inv.id}`,
      });
    } else {
      const reasonByStatus = {
        skipped_no_key: 'RESEND_API_KEY not configured on the server.',
        rejected: 'Resend rejected the email — check the sender domain is verified.',
        failed: 'The server could not reach Resend (network or runtime error).',
      };
      const shortReason = reasonByStatus[emailStatus] || 'Unknown email error.';
      notify({
        category: 'member',
        variant: 'warning',
        icon: 'envelope-off',
        title: 'Email not delivered',
        body: `${shortReason} (${data?.email_error || ''})`.trim(),
        dedupeKey: `invite-resend-failed-${inv.id}`,
        duration: 12000,
      });
    }
  };

  const handleRevoke = async (invitationId) => {
    setRevokingId(invitationId);
    const { error: revErr } = await revokeInvite(invitationId);
    setRevokingId(null);
    if (revErr) {
      notify({
        category: 'member',
        variant: 'error',
        title: 'Could not revoke invitation',
        body: revErr.message || 'The server rejected the request.',
      });
      return;
    }
    setInvitations((prev) => prev.filter((i) => i.id !== invitationId));
    notify({
      category: 'member',
      variant: 'success',
      icon: 'envelope-off',
      title: 'Invitation revoked',
      dedupeKey: `invite-revoked-${invitationId}`,
    });
  };

  if (loading) {
    return (
      <div className="project-dashboard">
        <div className="project-dashboard-loading">Loading project…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="project-dashboard">
        <div className="project-dashboard-error">
          {error.message}
          <Link to="/projects" className="project-dashboard-back-link">Back to projects</Link>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="project-dashboard">
        <div className="project-dashboard-error">
          Project not found.
          <Link to="/projects" className="project-dashboard-back-link">Back to projects</Link>
        </div>
      </div>
    );
  }

  const handleConfirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    const { error: delErr } = await deleteProject(project.id);
    if (delErr) {
      // Typical failure: role was demoted out of 'owner' between load and
      // click and RLS now rejects. Leave the modal open so the owner can see
      // the reason and either retry or close.
      setDeleteError(delErr.message || 'Failed to delete project.');
      setDeleting(false);
      return;
    }
    // Drop the stale selection so the sidebar's picker doesn't keep naming a
    // deleted project for a frame after navigation.
    clearSelection();
    navigate('/projects', { replace: true });
  };

  // Kick the targeted member. RLS gates this to admin+ on non-owner rows;
  // a defensive RLS rejection (e.g. the actor got demoted between load and
  // click) surfaces as a returned error and we keep the modal open with
  // an inline message rather than closing on the user.
  const handleRemoveMember = async () => {
    if (!removeTarget || removePending) return;
    setRemovePending(true);
    setRemoveError(null);
    const { error: remErr } = await removeMember(project.id, removeTarget.user_id);
    setRemovePending(false);
    if (remErr) {
      setRemoveError(remErr.message || 'Could not remove member.');
      return;
    }
    notify({
      category: 'member',
      variant: 'success',
      icon: 'user-minus',
      title: 'Member removed',
      body: getMemberName(removeTarget.profile),
      dedupeKey: `member-removed:${project.id}:${removeTarget.user_id}`,
    });
    // Optimistic local patch — drops the row from `members` on this device
    // instantly. Cross-device clients get the same drop via the realtime
    // DELETE handler in ProjectContext (working as of migration 007).
    removeMemberLocal(removeTarget.user_id);
    setRemoveTarget(null);
  };

  // Custom-role delete handler. RLS gates this to admin+ on the role's
  // project; the local state cleanup (`removeCustomRoleLocal`) also clears
  // any member rows' custom_role_id locally so the Members list reverts
  // their pill to the built-in label without waiting on realtime.
  const handleConfirmDeleteRole = async () => {
    if (!roleDeleteTarget || roleDeletePending) return;
    setRoleDeletePending(true);
    const { error: delErr } = await deleteCustomRole(roleDeleteTarget.id);
    setRoleDeletePending(false);
    if (delErr) {
      notify({
        category: 'role',
        variant: 'error',
        title: 'Could not delete role',
        body: delErr.message || 'The server rejected the request.',
      });
      return;
    }
    notify({
      category: 'role',
      variant: 'success',
      icon: 'trash',
      title: 'Custom role deleted',
      body: roleDeleteTarget.name,
      dedupeKey: `role-deleted:${roleDeleteTarget.id}`,
    });
    removeCustomRoleLocal(roleDeleteTarget.id);
    setRoleDeleteTarget(null);
  };

  // AI-context token/char estimate for the live counter in the AI tab.
  const aiTokens = Math.round(aiContext.length / 4);

  // Dirty when the trimmed buffer differs from the saved value (null/'' both
  // read as "empty"). Drives the Save/Discard enabled state.
  const aiContextDirty = aiContext.trim() !== (project?.ai_context ?? '');

  // Real AI-usage cells for the AI tab, derived from the monthly aggregate.
  // `used` comes from get_project_ai_usage; `cap` is the plan allowance the bar
  // fills against. Zero is honest — it means no AI feature has logged a request
  // this month yet.
  const usage = aiUsage || { requests: 0, input_tokens: 0, output_tokens: 0, sessions: 0, last_used_at: null };
  const aiUsageStats = [
    { key: 'requests', label: 'Requests', used: Number(usage.requests) || 0, cap: AI_MONTHLY_CAPS.requests, fmt: fmtCount, tint: 'var(--accent)', hint: 'Resets monthly' },
    { key: 'input', label: 'Input tokens', used: Number(usage.input_tokens) || 0, cap: AI_MONTHLY_CAPS.inputTokens, fmt: fmtTokens, tint: 'var(--cat-update)', hint: 'Sent to the model' },
    { key: 'output', label: 'Output tokens', used: Number(usage.output_tokens) || 0, cap: AI_MONTHLY_CAPS.outputTokens, fmt: fmtTokens, tint: 'var(--cat-member)', hint: 'Generated in responses' },
    { key: 'sessions', label: 'Sessions', used: Number(usage.sessions) || 0, cap: AI_MONTHLY_CAPS.sessions, fmt: fmtCount, tint: 'var(--cat-file)', hint: usage.last_used_at ? `Last: ${relTime(usage.last_used_at)} ago` : 'No sessions yet' },
  ];
  const aiHasUsage = aiUsageStats.some((s) => s.used > 0);

  // Total tokens this project has spent, as tracked on this device by
  // lib/aiTokenMeter (every project-ai turn adds to it). Distinct from the
  // `usage` aggregate above, which is the server-side monthly roll-up across
  // the whole team — this one is all-time, instant, and is what the AI tab's
  // debug Reset clears.
  const aiTokenTotal = aiTokenMeter.total;


  return (
    <div className="project-dashboard pjd-page" ref={pageRef}>
      {/* Compact header — fades/slides in once the hero has scrolled away,
          mirroring the Versions page exactly: title · eyebrow · a clickable
          status pill (with a dot) that jumps back to the top. */}
      <MiniHeaderFade visible={scrolled} />
      <div className={`pjd-compact mini-glow${scrolled ? ' is-visible' : ''}`} aria-hidden={!scrolled} onMouseMove={miniHeaderSpot}>
        <span className="pjd-compact-title">{project.name}</span>
        <span className="pjd-compact-sep" aria-hidden="true">·</span>
        <span className="pjd-compact-eyebrow">
          {project.created_at && <>Created {new Date(project.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · </>}
          {fmtCount(fileStats.count)} {fileStats.count === 1 ? 'file' : 'files'} · {fmtBytes(fileStats.bytes)}
        </span>
        <Tooltip content="Back to top">
          <button
            type="button"
            className="pjd-compact-status"
            onClick={scrollToTop}
          >
            <span className="pjd-compact-dot" aria-hidden="true" />
            Back to top
          </button>
        </Tooltip>
      </div>

      {/* Hero — masthead styling that mirrors the Versions page: accent eyebrow
          + muted tail, big display title, then a kicker stat line (real member
          count + created / last-updated). The description follows when set. */}
      <header className="pjd-hero">
        <div>
          <div className="pjd-hero-eyebrow">
            <span>Project settings</span>
            <span className="pjd-muted">· {role} access</span>
          </div>
          {isOwner ? (
            editingName ? (
              <input
                ref={nameInputRef}
                className="pjd-hero-title-input"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitName(); }
                  else if (e.key === 'Escape') { setEditName(project.name ?? ''); setEditingName(false); }
                }}
                maxLength={80}
                disabled={savingProject}
                aria-label="Project name"
              />
            ) : (
              <Tooltip content="Rename project">
                <button
                  type="button"
                  className="pjd-hero-title-btn"
                  onClick={() => { setEditName(project.name ?? ''); setEditingName(true); }}
                >
                  <h1 className="pjd-hero-title">{project.name}</h1>
                  <span className="pjd-hero-title-pencil" aria-hidden="true">{PencilIcon}</span>
                </button>
              </Tooltip>
            )
          ) : (
            <h1 className="pjd-hero-title">{project.name}</h1>
          )}
          <p className="pjd-hero-kicker">
            {project.created_at ? (
              <><strong>Created {new Date(project.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</strong></>
            ) : (
              <strong>Active project</strong>
            )}
            {' · '}{fmtCount(fileStats.count)} {fileStats.count === 1 ? 'file' : 'files'} · {fmtBytes(fileStats.bytes)}
            {Number(usage.requests) > 0 && <> · {fmtCount(usage.requests)} AI {Number(usage.requests) === 1 ? 'request' : 'requests'} this month</>}
          </p>
          {project.description && <p className="pjd-hero-desc">{project.description}</p>}
        </div>
      </header>

      {/* Section tabs. The page used to stack every section in one long
          scroll inside rounded cards; it's one section at a time now, chosen
          from the same sliding-underline strip the Activity feed uses — the
          literal component (components/FilterTabs), not a lookalike. */}
      <div className="pjd-tabstrip">
        <FilterTabs
          tabs={SETTINGS_SECTIONS}
          active={section}
          onSelect={setSection}
          underlineCat="project"
          ariaLabel="Project sections"
        />
      </div>

      {/* Overview — Usage gauges (left) + Team (right). */}
      <div className="pjd-grid" style={{ marginBottom: 24, display: section === 'overview' ? undefined : 'none' }}>
        <section className="pjd-panel">
          <div className="pjd-panel-head">
            <div className="pjd-panel-title">Usage</div>
          </div>
          <div className="pjd-usage-grid">
            <UsageGauge label="Project memory" used={2.4} total={5} unit="GB" tint="var(--accent)" hint="Files, thumbnails, and version snapshots." />
            {/* One gauge for AI spend. The old pair ("AI requests" and "AI
                context tokens") measured two different things in two different
                units, neither of which was what a user wants to know — this is
                the actual total the project has sent to and received from the
                model. */}
            <UsageGauge
              label="AI tokens"
              used={aiTokenTotal}
              total={AI_MONTHLY_CAPS.tokens}
              unit="tokens"
              fmt={fmtTokens}
              tint="var(--cat-update)"
              hint={aiTokenMeter.requests
                ? `${fmtCount(aiTokenMeter.requests)} AI ${aiTokenMeter.requests === 1 ? 'request' : 'requests'} tracked for this project.`
                : 'Counts every AI request made in this project.'}
            />
            <UsageGauge label="Active members" used={members.length} total={10} unit="seats" tint="var(--cat-file)" hint={`${members.length} of 10 seats on the Free plan.`} />
          </div>
        </section>

        <div className="pjd-rail">
          <section className="pjd-panel">
            <div className="pjd-panel-head">
              <div className="pjd-panel-title">Team · {members.length}</div>
            </div>
            <div className="pjd-members-list">
              {orderedMembers.slice(0, 6).map((m) => {
                const mCustom = m.custom_role_id ? customRoles.find((cr) => cr.id === m.custom_role_id) : null;
                return (
                  <div key={m.user_id} className="pjd-member-row">
                    <MemberAvatar profile={m.profile} />
                    <div style={{ minWidth: 0 }}>
                      <div className="pjd-mr-name">{getMemberName(m.profile)}</div>
                      {m.profile?.email && <div className="pjd-mr-sub">{m.profile.email}</div>}
                    </div>
                    <RoleBadge role={m.role} customRole={mCustom} showBase />
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>

      {/* Project renaming lives in the hero title (click to edit, owner-only),
          so the old "Project details" settings form is gone. Sections are
          hidden with display:none rather than unmounted — the members and
          invitations lists carry fetched state and in-flight role changes that
          shouldn't be thrown away by switching tabs and back. */}
      <div className="pjd-stack">
        <div style={{ display: section === 'members' ? undefined : 'none' }}>
          <section className="project-dashboard-card">
            <div className="project-dashboard-card-header">
              <h2 className="project-dashboard-card-title">Members</h2>
              <div className="project-dashboard-card-actions">
                <span className="project-dashboard-card-count">
                  {UsersIcon}
                  {members.length} {members.length === 1 ? 'member' : 'members'}
                </span>
                {/* Invite-member button is gated on the members.invite
                    capability — admin+ by default, plus any custom-role
                    member who's been granted the override. Opted out of
                    the overlay pattern (per user direction): users without
                    the capability don't see the button at all. */}
                {canInvite && (
                  <button
                    type="button"
                    className="project-dashboard-card-btn"
                    onClick={() => setInviteOpen(true)}
                  >
                    {PlusIcon} Invite member
                  </button>
                )}
              </div>
            </div>
            <p className="project-dashboard-card-subtitle">
              Everyone with access to this project.
            </p>

            {members.length === 0 ? (
              <div className="project-dashboard-empty">No members yet.</div>
            ) : (
              <ul className="member-list">
                {orderedMembers.map((m) => {
                  const isSelf = m.user_id === currentUserId;
                  // Resolve custom role for the pill so each row shows the
                  // assigned label ("Designer") instead of just the base
                  // tier ("Member") when an override is active.
                  const memberCustomRole = m.custom_role_id
                    ? customRoles.find((cr) => cr.id === m.custom_role_id)
                    : null;
                  const hasActions = canChangeMemberRole(m) || canRemoveMember(m);
                  const isExpanded = expandedUserId === m.user_id;
                  const actionsPanelId = `member-actions-${m.user_id}`;
                  return (
                    <li
                      key={m.user_id}
                      className={`member-row${isExpanded ? ' is-expanded' : ''}${hasActions ? '' : ' is-static'}`}
                    >
                      <button
                        type="button"
                        className="member-row-toggle"
                        onClick={() => setExpandedUserId(isExpanded ? null : m.user_id)}
                        disabled={!hasActions}
                        aria-expanded={hasActions ? isExpanded : undefined}
                        aria-controls={hasActions ? actionsPanelId : undefined}
                      >
                        <MemberAvatar profile={m.profile} />
                        <div className="member-text">
                          <div className="member-name">{getMemberName(m.profile)}</div>
                          {m.profile?.email && (
                            <div className="member-email">{m.profile.email}</div>
                          )}
                        </div>
                        {/* On the viewer's own row, the "me" chip sits to
                            the left of the role badge so a glance at the
                            right edge of the list answers "which row is
                            me?" without scanning every name. */}
                        {isSelf && <span className="member-self-pill">me</span>}
                        <RoleBadge role={m.role} customRole={memberCustomRole} showBase />
                        {hasActions && (
                          <span className="member-row-chevron" aria-hidden="true">
                            {ChevronDownIcon}
                          </span>
                        )}
                      </button>

                      {hasActions && (
                        // Wrapping shell stays mounted regardless of
                        // expanded state so the grid-template-rows
                        // transition has both a start and end value to
                        // animate between. `inert` keeps the buttons
                        // out of the tab order + click flow while
                        // collapsed without unmounting them.
                        <div
                          className="member-row-actions-shell"
                          aria-hidden={!isExpanded}
                          inert={!isExpanded ? true : undefined}
                        >
                          <div id={actionsPanelId} className="member-row-actions">
                            {canChangeMemberRole(m) && (
                              <button
                                type="button"
                                className="member-action-btn"
                                onClick={() => {
                                  setRoleChangeTarget(m);
                                  setExpandedUserId(null);
                                }}
                              >
                                Change role
                              </button>
                            )}
                            {canRemoveMember(m) && (
                              <button
                                type="button"
                                className="member-action-btn member-action-btn-destructive"
                                onClick={() => {
                                  setRemoveTarget(m);
                                  setExpandedUserId(null);
                                }}
                                disabled={removePending && removeTarget?.user_id === m.user_id}
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Pending invitations — gated on the members.invite capability
              (admin+ by default, plus any custom-role member with the
              override), AND opted out of the overlay pattern per explicit
              user direction: users without the capability don't see the
              card at all. (Rationale: pending invitee emails are sensitive
              enough that even a placeholder card with a blur on top reads
              as "info leak adjacent." Hiding entirely is unambiguous.)
              Also hidden when there's nothing pending, to keep the page
              uncluttered. */}
          {canInvite && invLoaded && invitations.length > 0 && (
            <section className="project-dashboard-card">
              <div className="project-dashboard-card-header">
                <h2 className="project-dashboard-card-title">Pending invitations</h2>
                <span className="project-dashboard-card-count">
                  {invitations.length} pending
                </span>
              </div>
              <p className="project-dashboard-card-subtitle">
                Waiting on the invitee to click the link in their email.
              </p>
              <ul className="invitation-list">
                {invitations.map((inv) => {
                  // Resolve custom role for the invitation pill — same join
                  // pattern as member rows. The invitation's custom_role_id
                  // landed in migration 008.
                  const invCustomRole = inv.custom_role_id
                    ? customRoles.find((cr) => cr.id === inv.custom_role_id)
                    : null;
                  return (
                  <li key={inv.id || inv.email} className="invitation-row">
                    <div className="invitation-text">
                      <div className="invitation-email">{inv.email}</div>
                      <div className="invitation-meta">
                        {formatExpiry(inv.expires_at)}
                      </div>
                    </div>
                    <RoleBadge role={inv.role} customRole={invCustomRole} />
                    <Tooltip content="Copy docvex:// invite link (useful when the email didn't deliver)">
                      <button
                        type="button"
                        className="invitation-copy-btn"
                        onClick={() => handleCopyLink(inv)}
                      >
                        {copiedInviteId === inv.id ? 'Copied!' : 'Copy link'}
                      </button>
                    </Tooltip>
                    <Tooltip content="Resend the invitation email (re-uses the same token, no new row)">
                      <button
                        type="button"
                        className="invitation-copy-btn"
                        onClick={() => handleResend(inv)}
                        disabled={resendingId === inv.id}
                      >
                        {resendingId === inv.id ? 'Resending…' : 'Resend email'}
                      </button>
                    </Tooltip>
                    <Tooltip content="Revoke this invitation">
                      <button
                        type="button"
                        className="invitation-revoke-btn"
                        onClick={() => handleRevoke(inv.id)}
                        disabled={revokingId === inv.id}
                      >
                        {revokingId === inv.id ? 'Revoking…' : 'Revoke'}
                      </button>
                    </Tooltip>
                  </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>

      {/* Roles tab removed from this surface per the Dossier design — the
          RolesDossier component stays on disk (unrouted here). Custom roles can
          still be assigned via the per-member "Change role" flow (the editor
          modals below remain mounted, just not opened from this page). */}

      {/* AI — usage stats are real monthly aggregates from get_project_ai_usage
          (zero until a project-scoped AI feature logs a request); the
          project-context textarea persists to projects.ai_context (admin-gated
          write). */}
        <div className="pjd-ai-grid" style={{ display: section === 'ai' ? undefined : 'none' }}>
          <section className="pjd-panel">
            <div className="pjd-panel-head">
              <div className="pjd-panel-title">AI usage</div>
              <span className="pjd-placeholder-note">This month</span>
            </div>
            <div className="pjd-ai-stats">
              {aiUsageStats.map((s) => {
                const pct = s.cap > 0 ? Math.min(100, Math.round((s.used / s.cap) * 100)) : 0;
                return (
                  <div className="pjd-ai-stat" key={s.key}>
                    <span className="pjd-ai-stat-label">{s.label}</span>
                    <span className="pjd-ai-stat-value">
                      {s.fmt(s.used)}<span className="pjd-ai-stat-sub">/{s.fmt(s.cap)}</span>
                    </span>
                    <div className="pjd-ai-stat-bar"><span style={{ width: `${pct}%`, background: s.tint }} /></div>
                    <span className="pjd-ai-stat-hint">{s.hint}</span>
                  </div>
                );
              })}
            </div>
            {!aiUsageLoading && !aiHasUsage && (
              <p className="pjd-ai-help" style={{ margin: '14px 0 0' }}>
                No AI activity yet this month. Usage will populate here once the project's
                AI tools run their first request.
              </p>
            )}

            {/* All-time token counter tracked on this device (lib/aiTokenMeter),
                alongside the monthly server aggregate above. The Reset is a
                debug affordance: it zeroes THIS counter only — the
                project_ai_usage rows behind the monthly stats have no client
                delete path, so the panel above is unaffected. */}
            <div className="pjd-ai-meter">
              <div className="pjd-ai-meter-main">
                <span className="pjd-ai-meter-label">Tokens tracked for this project</span>
                <span className="pjd-ai-meter-value">
                  {fmtCount(aiTokenTotal)}
                  <span className="pjd-ai-meter-split">
                    {aiTokenMeter.total > 0
                      ? ` · ${fmtTokens(aiTokenMeter.input)} in / ${fmtTokens(aiTokenMeter.output)} out`
                      : ' · nothing recorded yet'}
                  </span>
                </span>
              </div>
              <Tooltip content="Debug: zero the locally-tracked token count for this project. Doesn't touch the monthly usage above.">
                <button
                  type="button"
                  className="pjd-ai-meter-reset"
                  onClick={() => {
                    resetAiTokens(project.id);
                    notify?.({
                      category: 'system',
                      variant: 'info',
                      icon: 'settings',
                      title: 'AI token count reset',
                      body: `The tracked token total for “${project.name}” is back to zero.`,
                      dedupeKey: `ai-tokens-reset-${project.id}`,
                    });
                  }}
                  disabled={aiTokenTotal === 0}
                >
                  Reset count
                </button>
              </Tooltip>
            </div>
          </section>

          {/* Jurisdiction — which country's law the AI applies in this project.
              Stamped onto every AI request (lib/jurisdictions → the ambient
              value SelectedProjectContext keeps in sync), so the model cites
              that country's legislation and courts and answers in its
              language. Saves on change; admin-gated like the context below. */}
          <section className="pjd-panel pjd-juris-panel">
            <div className="pjd-panel-head">
              <div className="pjd-panel-title">Jurisdiction</div>
              <span className="pjd-placeholder-note">
                {jurisdiction.flag} {jurisdiction.name}
              </span>
            </div>
            <p className="pjd-ai-help">
              The law this project is worked under. The AI applies it to legal research,
              document drafting and compliance checks — citing {jurisdiction.adjective} sources
              and answering in {jurisdiction.language} by default
              {jurisdiction.eu && jurisdiction.code !== 'EU' ? ', alongside directly applicable EU law' : ''}.
            </p>
            <div className="pjd-juris-row">
              <select
                className="pjd-juris-select"
                value={jurisdictionCode}
                onChange={(e) => handleJurisdictionChange(e.target.value)}
                disabled={!isAdmin || !!savingJurisdiction}
                aria-label="Project jurisdiction"
              >
                {JURISDICTIONS.map((j) => (
                  <option key={j.code} value={j.code}>
                    {j.flag} {j.name}
                  </option>
                ))}
              </select>
              <span className="pjd-ai-stat-hint">
                {savingJurisdiction
                  ? 'Saving…'
                  : isAdmin
                    ? project?.jurisdiction
                      ? 'Applies to everyone working in this project.'
                      : `Not set — defaulting to ${getJurisdiction(DEFAULT_JURISDICTION).name}.`
                    : 'Admins choose the jurisdiction.'}
              </span>
            </div>
          </section>

          <section className="pjd-panel pjd-ai-context-panel">
            <div className="pjd-panel-head">
              <div className="pjd-panel-title">Project AI context</div>
              <span className="pjd-ai-token-count">
                <span className="pjd-ai-token-dot" />
                ≈ {aiTokens.toLocaleString()} tokens · {aiContext.length} chars{aiContextDirty ? ' · unsaved' : ''}
              </span>
            </div>
            <p className="pjd-ai-help">
              Persistent instructions prepended to every AI request in this project.
              Use it for tone, terminology, document conventions, and citation rules.
            </p>
            <textarea
              className="pjd-ai-input"
              value={aiContext}
              onChange={(e) => setAiContext(e.target.value)}
              placeholder="Describe how you want the AI to behave inside this project — terminology, tone, citation conventions, anything it should always remember…"
              rows={10}
              readOnly={!isAdmin}
            />
            <div className="pjd-ai-foot">
              <div className="pjd-ai-tags">
                <span className="pjd-ai-tag">+ Add tone preset</span>
                <span className="pjd-ai-tag">+ Pin a file as reference</span>
                <span className="pjd-ai-tag">+ Reference a glossary</span>
              </div>
              {isAdmin ? (
                <div className="pjd-ai-actions">
                  <button
                    type="button"
                    className="pjd-btn-ghost"
                    onClick={() => setAiContext(project?.ai_context ?? '')}
                    disabled={savingAiContext || !aiContextDirty}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className="pjd-btn-primary"
                    onClick={handleSaveAiContext}
                    disabled={savingAiContext || !aiContextDirty}
                  >
                    {CheckIcon} {savingAiContext ? 'Saving…' : 'Save context'}
                  </button>
                </div>
              ) : (
                <span className="pjd-ai-stat-hint">Admins manage the AI context.</span>
              )}
            </div>
          </section>
        </div>

        {/* Danger zone — shared component replicating the Developer Console
            (Admin) danger card, so every danger zone in the app matches. */}
        {/* Wrapper carries the section visibility: RoleLocked renders its
            children bare when unlocked, so a style prop on it would vanish for
            owners. */}
        <div style={{ display: section === 'danger' ? undefined : 'none' }}>
        <RoleLocked locked={!isOwner} requiredRole="owner">
          <DangerZone subtitle="Irreversible actions for this project.">
            {/* Ordered least → most destructive, so the row that ends the
                project sits at the bottom rather than next to the ones that
                only clear caches. Each is separately confirmed: they destroy
                different things and someone reaching for one shouldn't get
                any of the others. */}
            <DangerRow
              title="Clear derived file data"
              desc="Deletes what DocVex worked out from your documents on this computer — transcripts, extracted text, metadata snapshots, audio waveforms, and this project's cached chat. Your files are not touched; anything you need again is re-read (or re-transcribed) on demand."
            >
              <button type="button" className="dz-btn" onClick={() => setWipe('fileData')} disabled={!!wiping}>
                {wiping === 'fileData' ? 'Clearing…' : 'Clear file data'}
              </button>
            </DangerRow>

            <DangerRow
              title="Wipe AI memory"
              desc="Clears the project's standing AI instructions (shared with your team), every AI file description and cached search answer, and the per-document advisor conversations on this computer. The next AI search re-reads the folder, which costs requests."
            >
              <button type="button" className="dz-btn" onClick={() => setWipe('aiMemory')} disabled={!!wiping}>
                {wiping === 'aiMemory' ? 'Wiping…' : 'Wipe AI memory'}
              </button>
            </DangerRow>

            <DangerRow
              title="Delete all uploaded files"
              desc="Permanently deletes every file and folder inside this project's folder on this computer. The project, its members, and its chat stay. This does not touch a teammate's copy, and it is not the recycle bin — the files do not come back."
            >
              <button type="button" className="dz-btn" onClick={() => setWipe('files')} disabled={!!wiping || !localFolderPath}>
                {wiping === 'files' ? 'Deleting…' : 'Delete all files'}
              </button>
            </DangerRow>

            <DangerRow
              title="Delete this project"
              desc="Once deleted, you can't recover it. All members, pending invites, and uploaded files will be removed."
            >
              <button
                type="button"
                className="dz-btn"
                onClick={() => { setDeleteError(null); setDeleteOpen(true); }}
                disabled={deleting}
              >
                Delete project
              </button>
            </DangerRow>
            {deleteError && <div className="dz-error" role="alert">{deleteError}</div>}
            {wipeError && <div className="dz-error" role="alert">{wipeError}</div>}
          </DangerZone>
        </RoleLocked>
        </div>

        {/* One confirm for all three wipes — each carries its own copy so the
            dialog states exactly what is about to be destroyed. */}
        <ConfirmModal
          open={!!wipe}
          title={WIPE_COPY[wipe]?.title || ''}
          message={WIPE_COPY[wipe]?.message || ''}
          confirmLabel={wiping ? 'Working…' : (WIPE_COPY[wipe]?.confirm || 'Continue')}
          cancelLabel="Cancel"
          destructive
          onConfirm={runWipe}
          onCancel={() => { if (!wiping) setWipe(null); }}
        />
      </div>

      <DeleteProjectModal
        open={deleteOpen}
        projectName={project.name}
        pending={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => { if (!deleting) setDeleteOpen(false); }}
      />

      <InviteMemberModal
        open={inviteOpen}
        projectId={project.id}
        projectName={project.name}
        customRoles={customRoles}
        onClose={() => setInviteOpen(false)}
        onSent={handleInviteSent}
      />

      <RemoveMemberModal
        open={!!removeTarget}
        memberName={removeTarget ? getMemberName(removeTarget.profile) : ''}
        projectName={project.name}
        error={removeError}
        pending={removePending}
        onConfirm={handleRemoveMember}
        onCancel={() => {
          if (removePending) return;
          setRemoveTarget(null);
          setRemoveError(null);
        }}
      />

      <ChangeMemberRoleModal
        open={!!roleChangeTarget}
        member={roleChangeTarget}
        projectId={project.id}
        customRoles={customRoles}
        memberName={roleChangeTarget ? getMemberName(roleChangeTarget.profile) : ''}
        onClose={() => setRoleChangeTarget(null)}
        onSaved={({ baseRole, customRoleId }) => {
          // Optimistic patch — same idiom as removeMemberLocal. Realtime
          // UPDATE also fires and runs the same map; the second pass is a
          // no-op because the row is already in the target state.
          if (roleChangeTarget) {
            setMemberRoleLocal(roleChangeTarget.user_id, baseRole, customRoleId);
          }
        }}
      />

      <CustomRoleEditor
        open={editorTarget !== undefined}
        role={editorTarget || null}
        projectId={project.id}
        onClose={() => setEditorTarget(undefined)}
        onSaved={() => {
          // Refetch the catalog explicitly even though realtime will also
          // fire — gives the actor immediate confirmation that the save
          // landed instead of waiting up to 200ms for the debounced reconcile.
          refreshCustomRoles();
        }}
      />

      <ConfirmModal
        open={!!roleDeleteTarget}
        title="Delete custom role?"
        message={
          roleDeleteTarget
            ? `Members assigned to "${roleDeleteTarget.name}" will revert to ${builtInLabel(roleDeleteTarget.base_role)} (its base tier). This can't be undone.`
            : ''
        }
        confirmLabel={roleDeletePending ? 'Deleting…' : 'Delete role'}
        destructive
        onConfirm={handleConfirmDeleteRole}
        onCancel={() => { if (!roleDeletePending) setRoleDeleteTarget(null); }}
      />
    </div>
  );
}

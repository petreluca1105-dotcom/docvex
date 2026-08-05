import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { getProject, listMembers } from '../lib/projects';
import { listCustomRoles, subscribeForProjectRoles } from '../lib/customRoles';
import { markProjectAccessed } from '../lib/recentProjects';
import { useAuth } from './AuthContext';
import { DEMO_PROJECT, DEMO_PROJECT_ID } from '../lib/demoWorkspace';

// Scoped to a single /projects/:projectId subtree. Mounted by App.jsx only
// inside the project routes so unrelated pages (Dashboard, Account, Updates)
// don't pay the cost of a project fetch + Realtime channel.
//
// State: { project, role, members, customRoles, loading, error, refresh,
//          refreshCustomRoles, removeMemberLocal, removeCustomRoleLocal }.
//   - project    — full row from public.projects, null while loading/error
//   - role       — caller's role on this project: 'owner'|'admin'|'member'|'viewer'|null
//   - members    — array of { user_id, role, custom_role_id, added_at, profile }
//                  from listMembers(). When custom_role_id is set, the
//                  member's effective display + capabilities come from the
//                  customRoles catalog entry of that id.
//   - customRoles — array of { id, name, description, base_role, capabilities }
//                  from listCustomRoles(). Capabilities is the override set
//                  (rows that differ from the base_role's defaults).
//   - loading    — true during the initial fetch (refresh() doesn't flip this)
//   - error      — Error from the initial fetch, null on success
//   - refresh()  — manual re-fetch trigger; useful after mutations that don't
//                  themselves come through Realtime (e.g. updateMemberRole
//                  triggers a Realtime UPDATE event, but a Dashboard rename
//                  needs a manual refresh for the name to update locally).
//   - refreshCustomRoles() — refetch just the custom roles list, used after
//                  a successful create/update from the editor modal.
//   - removeMemberLocal(userId) — optimistic local removal for the actor's
//                  device. The realtime DELETE handler does the same filter
//                  cross-device; this just skips the round-trip latency for
//                  the user who clicked Remove.
//   - setMemberRoleLocal(userId, baseRole, customRoleId) — optimistic local
//                  patch of role + custom_role_id on a member row. Same
//                  pattern as removeMemberLocal: the actor's UI updates
//                  immediately, the realtime UPDATE handler keeps everyone
//                  else in sync.
//   - removeCustomRoleLocal(id) — optimistic local removal of a custom role
//                  + cleans up any member rows that pointed at it (resets
//                  their custom_role_id to null on the local copy; the FK
//                  on the server handles the truth).

const ProjectContext = createContext(null);

// Module-level stale-while-revalidate cache of the last-good payload per
// project, so re-opening a project (e.g. via the sidebar's project button)
// paints instantly from memory while a background refetch reconciles. Survives
// unmount/remount of the provider for the session; cleared on full reload. Each
// entry is { project, role, members, customRoles }. Kept current by the sync
// effect below (covers both the initial fetch and live Realtime patches).
const PROJECT_CACHE = new Map();

export function ProjectProvider({ children }) {
  const { projectId } = useParams();
  const { session } = useAuth();
  const selfUserId = session?.user?.id ?? null;
  // Seed initial state from the cache so the very first render after a remount
  // shows real data instead of the "Loading project…" placeholder.
  const seed = PROJECT_CACHE.get(projectId) || null;
  const [project, setProject] = useState(seed?.project ?? null);
  const [role, setRole] = useState(seed?.role ?? null);
  const [members, setMembers] = useState(seed?.members ?? []);
  const [customRoles, setCustomRoles] = useState(seed?.customRoles ?? []);
  const [loading, setLoading] = useState(!seed);
  const [error, setError] = useState(null);

  // Monotonic generation token for async loads. A single shared boolean cancel
  // flag was unsafe: each projectId change reset it to false before the previous
  // project's in-flight fetch resolved, so a slow load for project A could write
  // A's data while the UI had already moved to B. Every load captures the token
  // at start and bails if it no longer matches — so only the newest run can
  // commit. Realtime refetch effects use their own per-run local flag instead.
  const loadSeqRef = useRef(0);
  // Unique-per-mount suffix for Realtime channel topics. Split view can mount
  // TWO ProjectProviders for the same project at once (the sidebar-driven
  // primary pane AND a secondary pane viewing the same project), so a fixed
  // `project:<id>` topic would collide — Supabase rejects a duplicate-topic
  // subscribe, and the resulting effect error blanks the tree. A per-instance
  // suffix keeps each provider's channel distinct.
  const channelSuffixRef = useRef(null);
  if (channelSuffixRef.current === null) {
    channelSuffixRef.current = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  }
  // Debounce handle for the Realtime member-changes refetch. A batch of N
  // member events (e.g. an admin bulk-importing invitations that all accept
  // around the same time) coalesces into one listMembers() call instead of N.
  const memberRefetchTimerRef = useRef(null);
  // Same debounce pattern for custom-role + capability events. A single
  // role edit fires up to 1 custom_roles UPDATE + N capability INSERT/DELETE
  // rows; the debounce coalesces them.
  const rolesRefetchTimerRef = useRef(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    // Web demo: the Demo Workspace has no Supabase row — resolve it locally
    // (owner role so every surface is explorable) instead of letting the
    // fetch fail and blank the subtree to an error page.
    if (projectId === DEMO_PROJECT_ID) {
      setProject({ ...DEMO_PROJECT, role: 'owner' });
      setRole('owner');
      setMembers([]);
      setCustomRoles([]);
      setError(null);
      setLoading(false);
      return;
    }
    const myRun = ++loadSeqRef.current;

    const [
      { data: projData, error: projErr },
      { data: memData,  error: memErr  },
      { data: rolesData, error: rolesErr },
    ] = await Promise.all([
      getProject(projectId),
      listMembers(projectId),
      listCustomRoles(projectId),
    ]);
    // A newer load (or a projectId change, which triggers one) has superseded us.
    if (loadSeqRef.current !== myRun) return;

    if (projErr) {
      // On a background revalidation (we already have a cached payload for this
      // id) keep showing the stale-but-good data rather than blanking to an
      // error on a transient network blip. Only surface the error on a cold
      // cache-miss load.
      if (PROJECT_CACHE.has(projectId)) {
        setLoading(false);
        return;
      }
      setError(projErr);
      setProject(null);
      setRole(null);
      setMembers([]);
      setCustomRoles([]);
      setLoading(false);
      return;
    }

    setProject(projData);
    setRole(projData?.role ?? null);
    setMembers(memErr ? [] : (memData || []));
    // listCustomRoles errors are non-fatal: a viewer with RLS access but a
    // transient network blip still sees the page; capability resolution
    // falls back to the base-tier matrix.
    setCustomRoles(rolesErr ? [] : (rolesData || []));
    setError(null);
    setLoading(false);
    // Stamp the recency map so visiting a project's Overview or Dashboard
    // counts as "accessed" even when the selection wasn't changed via the
    // picker. selectProject already stamps on picker selection; this catches
    // the URL-nav-to-overview path that doesn't go through selectProject.
    if (projData?.id && selfUserId) markProjectAccessed(selfUserId, projData.id, projData.name);
  }, [projectId, selfUserId]);

  // Initial load when projectId changes. When we have a cached payload for the
  // new id, seed from it and skip the loading state — the load() below still
  // runs to revalidate in the background (stale-while-revalidate). Only show the
  // "Loading project…" placeholder on a genuine cache miss.
  useEffect(() => {
    const cached = PROJECT_CACHE.get(projectId);
    if (cached) {
      setProject(cached.project);
      setRole(cached.role);
      setMembers(cached.members);
      setCustomRoles(cached.customRoles);
      setError(null);
      setLoading(false);
    } else {
      setLoading(true);
      setError(null);
    }
    // load() bumps loadSeqRef, invalidating any still-in-flight fetch for the
    // previous project — so no separate cleanup flag is needed here.
    load();
  }, [projectId, load]);

  // Keep the cache current with the live state — covers the initial fetch AND
  // Realtime patches (role change, member add/remove, project rename), so the
  // next remount seeds from fresh data. Only cache a fully-loaded, error-free
  // project.
  useEffect(() => {
    if (loading || error || !project?.id) return;
    PROJECT_CACHE.set(project.id, { project, role, members, customRoles });
  }, [project, role, members, customRoles, loading, error]);

  // Realtime subscriptions — project row + membership list. Same pattern as
  // notificationsRepo.subscribeForUser, scoped to one channel per project.
  //
  // The `project_members` handler patches the local members array in place
  // for UPDATE (role change) and DELETE (removal). INSERT can't be patched
  // optimistically because the payload doesn't include the profile join —
  // it falls through to the debounced refetch, which also serves as a
  // catch-all reconcile to cover any patch-missed edge case (e.g. an UPDATE
  // for a user we never had in the array yet). The debounce coalesces a
  // batch of events into a single network call.
  useEffect(() => {
    if (!projectId || projectId === DEMO_PROJECT_ID) return;
    // Per-run flag: a debounced refetch that already fired and is awaiting when
    // this effect tears down (projectId change) must not write into the next
    // project's state.
    let cancelled = false;
    const refreshMembersDebounced = () => {
      if (memberRefetchTimerRef.current) clearTimeout(memberRefetchTimerRef.current);
      memberRefetchTimerRef.current = setTimeout(async () => {
        memberRefetchTimerRef.current = null;
        const { data, error: memErr } = await listMembers(projectId);
        if (cancelled) return;
        if (!memErr) setMembers(data || []);
      }, 200);
    };

    const channel = supabase
      .channel(`project:${projectId}:${channelSuffixRef.current}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'projects', filter: `id=eq.${projectId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            PROJECT_CACHE.delete(projectId);
            setProject(null);
            setError(new Error('Project was deleted'));
          } else if (payload.new) {
            setProject((prev) => (prev ? { ...prev, ...payload.new } : payload.new));
          }
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'project_members', filter: `project_id=eq.${projectId}` },
        (payload) => {
          // Optimistic local patches so the UI reflects role/removal changes
          // immediately, without waiting for the debounced refetch. The
          // refetch then reconciles to authoritative data — covers INSERTs
          // and any UPDATE where the affected user isn't in our array yet.
          if (payload.eventType === 'UPDATE' && payload.new?.user_id) {
            const { user_id: changedId, role: newRole, custom_role_id: newCustomRoleId } = payload.new;
            setMembers((prev) =>
              prev.map((m) => (m.user_id === changedId
                ? { ...m, role: newRole, custom_role_id: newCustomRoleId ?? null }
                : m)),
            );
            // If the caller is the affected user, patch the provider's role
            // state too — keeps "I just got promoted" UI in sync without
            // waiting on the network.
            if (selfUserId && changedId === selfUserId) {
              setRole(newRole);
              setProject((prev) => (prev ? { ...prev, role: newRole } : prev));
            }
          } else if (payload.eventType === 'DELETE' && payload.old?.user_id) {
            const removedId = payload.old.user_id;
            setMembers((prev) => prev.filter((m) => m.user_id !== removedId));
          }
          refreshMembersDebounced();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      if (memberRefetchTimerRef.current) {
        clearTimeout(memberRefetchTimerRef.current);
        memberRefetchTimerRef.current = null;
      }
      try { supabase.removeChannel(channel); } catch { /* non-fatal */ }
    };
  }, [projectId, selfUserId]);

  // Custom-roles realtime subscription. Separate from the projects/members
  // channel above because (a) the capability table can't be filtered on
  // project_id at the realtime layer (the FK is on custom_role_id, not
  // project_id), so the subscription is unfiltered + reconciled via a
  // debounced refetch; and (b) keeping it isolated means a custom-role
  // refresh doesn't churn the members list query.
  useEffect(() => {
    if (!projectId || projectId === DEMO_PROJECT_ID) return undefined;

    let cancelled = false;
    const refreshRolesDebounced = () => {
      if (rolesRefetchTimerRef.current) clearTimeout(rolesRefetchTimerRef.current);
      rolesRefetchTimerRef.current = setTimeout(async () => {
        rolesRefetchTimerRef.current = null;
        const { data, error: rolesErr } = await listCustomRoles(projectId);
        if (cancelled) return;
        if (!rolesErr) setCustomRoles(data || []);
      }, 200);
    };

    const unsubscribe = subscribeForProjectRoles(projectId, () => {
      // Every change (insert/update/delete on either table) triggers a
      // reconcile. Cheap — the roles list is small.
      refreshRolesDebounced();
    });

    return () => {
      cancelled = true;
      if (rolesRefetchTimerRef.current) {
        clearTimeout(rolesRefetchTimerRef.current);
        rolesRefetchTimerRef.current = null;
      }
      try { unsubscribe(); } catch { /* non-fatal */ }
    };
  }, [projectId]);

  // Public refresh — same as the effect's load(), but exposed so pages can
  // re-pull after a mutation (e.g. updateProject from the Settings page).
  // Doesn't flip `loading` so the UI doesn't flicker.
  const refresh = useCallback(async () => { await load(); }, [load]);

  // Custom-roles-only refresh, exposed so the editor modal can pull a fresh
  // catalog after a successful save without re-fetching the project + members.
  const refreshCustomRoles = useCallback(async () => {
    if (!projectId) return;
    const myRun = loadSeqRef.current;
    const { data, error: err } = await listCustomRoles(projectId);
    // A projectId change triggers a load() that bumps the token — bail if so.
    if (loadSeqRef.current !== myRun) return;
    if (!err) setCustomRoles(data || []);
  }, [projectId]);

  // Optimistic local removal helper. Mirrors the realtime DELETE handler's
  // setMembers filter — exposed so the local actor (the admin clicking
  // "Remove" on a member row) sees the row vanish instantly, without
  // waiting on the realtime echo round-trip. The realtime DELETE event
  // also fires and runs the same filter; the second pass is a no-op
  // because the row is already gone. Cross-device clients still rely on
  // the realtime DELETE event (now actually delivered post-migration 007).
  const removeMemberLocal = useCallback((userId) => {
    setMembers((prev) => prev.filter((m) => m.user_id !== userId));
  }, []);

  // Optimistic role-change helper. Mirrors the realtime UPDATE branch in
  // the project_members handler — patches role + custom_role_id on the
  // matching row. Exposed so the local actor (the admin who just saved
  // the change-role modal) sees the pill update instantly, instead of
  // waiting on the realtime echo (which can take hundreds of ms or, in
  // rare cases of dropped frames, never arrive at all until the next
  // reconcile). Cross-device clients still update via the realtime
  // UPDATE event. Also patches the provider's `role` state when the
  // actor edited their own row, for symmetry with the realtime handler.
  const setMemberRoleLocal = useCallback((userId, baseRole, customRoleId) => {
    setMembers((prev) =>
      prev.map((m) => (m.user_id === userId
        ? { ...m, role: baseRole, custom_role_id: customRoleId ?? null }
        : m)),
    );
    if (selfUserId && userId === selfUserId) {
      setRole(baseRole);
      setProject((prev) => (prev ? { ...prev, role: baseRole } : prev));
    }
  }, [selfUserId]);

  // Optimistic local removal for a custom role. Two state updates:
  //   1. Drop the role from the catalog so the Roles tab updates instantly.
  //   2. Clear `custom_role_id` on any member assigned to it so their pill
  //      reverts to the built-in label without waiting for the realtime
  //      echo. The DB's FK is ON DELETE SET NULL, so the server state
  //      arrives at the same shape; this is a latency shortcut.
  const removeCustomRoleLocal = useCallback((roleId) => {
    setCustomRoles((prev) => prev.filter((r) => r.id !== roleId));
    setMembers((prev) => prev.map((m) =>
      m.custom_role_id === roleId ? { ...m, custom_role_id: null } : m,
    ));
  }, []);

  const value = useMemo(
    () => ({
      project, role, members, customRoles, loading, error,
      refresh, refreshCustomRoles,
      removeMemberLocal, setMemberRoleLocal, removeCustomRoleLocal,
    }),
    [project, role, members, customRoles, loading, error,
     refresh, refreshCustomRoles,
     removeMemberLocal, setMemberRoleLocal, removeCustomRoleLocal],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used inside <ProjectProvider>');
  return ctx;
}

// Like useProject(), but returns null when no provider is in scope instead
// of throwing. For consumers that can ALSO get by with just the
// SelectedProjectContext's role (e.g. useHasCapability, which works on both
// /projects/:id full-context routes AND on /files where only SelectedProject
// is available). Don't use this where the consumer genuinely depends on
// `members` or `customRoles` being populated — those are only present under
// a real ProjectProvider.
export function useProjectOptional() {
  return useContext(ProjectContext);
}

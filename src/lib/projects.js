// Thin Supabase wrappers for the projects + members + invitations tables.
//
// Every read goes through RLS scoped on auth.uid() via has_project_role(),
// so callers don't need to add their own user-id filters for safety. Every
// function returns `{ data, error }` — same idiom as supabase-js itself, no
// throwing. Inspired by src/lib/notificationsRepo.js.
//
// The Edge Function calls (sendInvite / acceptInvite / revokeInvite) hand off
// to the deployed functions via supabase.functions.invoke(); their bodies and
// auth handling live in supabase/functions/<name>/index.ts.

import { supabase } from './supabaseClient';

// Name of the window CustomEvent the picker (and any other consumer of the
// caller's project list) listens for to invalidate cached project lists.
// Dispatched after any mutation that changes which projects the caller is a
// member of: createProject, deleteProject, leaveProject. Centralised here so
// publishers and subscribers can't drift.
export const PROJECTS_CHANGED_EVENT = 'docvex:projects-changed';

// Convenience for publishers: fire-and-forget dispatch. Wrapped in a
// try/catch because non-browser contexts (e.g. a unit test) may not have
// `window` available, and a missing CustomEvent shouldn't break the caller.
export function notifyProjectsChanged() {
  try {
    window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
  } catch { /* non-browser context */ }
}

// Up-to-two-letter initials from a display name, for avatar fallbacks.
function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

// ── Projects ──────────────────────────────────────────────────────────────

// All projects the caller is a member of, newest-active first, with their
// role + total member count joined in. We query project_members as the base
// and embed the project relation; the project relation then re-embeds
// project_members as a `count` aggregate so the card grid can render
// "5 members" without an N+1.
//
// MUST filter by user_id = self on the outer query. The "members read members"
// RLS policy lets any member SELECT every project_members row for projects
// they belong to (so the Members card can render the full list). Without an
// explicit user_id filter here, a project with N members would come back as
// N rows — each embedding the same project — and the renderer would show
// N duplicate project cards. The bug surfaces the moment someone accepts an
// invite, because the project flips from "just me" to "me + inviter".
//
// The inner `member_count:project_members(count)` embed runs through RLS
// independently and counts every row the caller can see for that project —
// for a project the caller is a member of, that's the full membership, so
// the number matches what the Project Overview's Members card would show.
export async function listMyProjects() {
  // getSession() reads the persisted session from storage; getUser() is a
  // round-trip to /auth/v1/user. This runs on every Hub open, where it used to
  // add a whole request's latency before the first query could even start, so
  // prefer the local read and only fall back to the network one.
  const sessionResult = await supabase.auth.getSession();
  let userId = sessionResult.data.session?.user?.id;
  if (!userId) {
    const userResult = await supabase.auth.getUser();
    userId = userResult.data.user?.id;
  }
  if (!userId) return { data: [], error: new Error('Not signed in') };

  const { data, error } = await supabase
    .from('project_members')
    .select(`
      role,
      added_at,
      project:projects(
        id, name, description, created_at, updated_at, created_by,
        member_count:project_members(count)
      )
    `)
    .eq('user_id', userId)
    .order('added_at', { ascending: false });

  if (error) return { data: [], error };

  // Flatten { role, project: {...} } → { ...project, role, member_count }.
  // PostgREST returns the count aggregate as [{ count: N }] (it's an embedded
  // resource, always an array even when aggregated) so we unwrap the first
  // element. Default to 1 — the caller is at minimum a member of any project
  // returned here, so 0 would be lying.
  const flat = (data || [])
    .filter((r) => r.project)
    .map((r) => ({
      ...r.project,
      role: r.role,
      member_count: r.project.member_count?.[0]?.count ?? 1,
      members: [],
    }));

  // Best-effort: attach a few member profiles per project so the card grid can
  // render an avatar stack instead of a bare count. RLS lets a member read
  // every project_members row for projects they belong to, so one batched
  // query covers all the caller's projects; the profiles (incl. avatar_url)
  // come from the SECURITY DEFINER get_member_profiles RPC because auth.users
  // is blocked from direct client reads. A failure here leaves members: []
  // and the count still renders — never blanks the list.
  const projectIds = flat.map((p) => p.id);
  if (projectIds.length) {
    const { data: memberRows } = await supabase
      .from('project_members')
      .select('project_id, user_id, added_at')
      .in('project_id', projectIds)
      .order('added_at', { ascending: true });

    if (memberRows?.length) {
      const uniqueIds = [...new Set(memberRows.map((m) => m.user_id))];
      const { data: profiles } = await supabase.rpc('get_member_profiles', { p_user_ids: uniqueIds });
      const profileById = new Map((profiles || []).map((p) => [p.id, p]));
      const byProject = new Map();
      for (const m of memberRows) {
        if (!byProject.has(m.project_id)) byProject.set(m.project_id, []);
        const prof = profileById.get(m.user_id) || null;
        const name = prof?.full_name || prof?.name || prof?.email || 'Member';
        byProject.get(m.project_id).push({
          userId: m.user_id,
          name,
          initials: initialsOf(name),
          avatarUrl: prof?.avatar_url || null,
        });
      }
      for (const p of flat) p.members = byProject.get(p.id) || [];
    }
  }

  return { data: flat, error: null };
}

// Create a new project. The projects_add_owner trigger automatically inserts
// the creator into project_members as 'owner', so by the time this returns
// the caller already has full access. Fires PROJECTS_CHANGED_EVENT on success
// so the picker's cached list invalidates without each caller having to
// remember.
export async function createProject({ name, description = null }) {
  const userResult = await supabase.auth.getUser();
  const userId = userResult.data.user?.id;
  if (!userId) return { data: null, error: new Error('Not signed in') };

  const { data, error } = await supabase
    .from('projects')
    .insert({ name: name?.trim(), description: description?.trim() || null, created_by: userId })
    .select('*')
    .single();
  if (!error) notifyProjectsChanged();
  return { data, error };
}

// Fetch a single project plus the caller's role on it. Two queries because
// the role lives in project_members and PostgREST embedding for the "current
// user's row" requires an awkward filter.
//
// Field list covers what the JSX consumers read: id, name, description, AI
// context, plus the dossier-hero metadata (`created_at`, `updated_at`).
// `created_by` is still omitted (nothing renders it). Keep this in lockstep
// with updateProject()'s select below so the two return shapes stay aligned.
//
// `ai_context` / `ai_context_updated_at` back the Project Overview AI tab —
// included here so the textarea seeds from the project row (and stays in sync
// via ProjectContext's Realtime UPDATE merge, which carries the new columns).
export async function getProject(projectId) {
  const userResult = await supabase.auth.getUser();
  const userId = userResult.data.user?.id;
  if (!userId) return { data: null, error: new Error('Not signed in') };

  const [{ data: project, error: pErr }, { data: membership, error: mErr }] = await Promise.all([
    supabase.from('projects').select('id, name, description, ai_context, ai_context_updated_at, created_at, updated_at').eq('id', projectId).maybeSingle(),
    supabase.from('project_members').select('role').eq('project_id', projectId).eq('user_id', userId).maybeSingle(),
  ]);
  if (pErr) return { data: null, error: pErr };
  if (mErr) return { data: null, error: mErr };
  if (!project) return { data: null, error: new Error('Project not found') };

  return { data: { ...project, role: membership?.role ?? null }, error: null };
}

// Patch a project. RLS "admins update projects" enforces admin+; non-admins
// get an empty result with no error (Postgres just returns 0 rows).
export async function updateProject(projectId, patch) {
  const allowed = {};
  if (typeof patch.name === 'string') allowed.name = patch.name.trim();
  if ('description' in patch) allowed.description = patch.description?.trim() || null;
  if (Object.keys(allowed).length === 0) return { data: null, error: new Error('No fields to update') };

  // Match getProject's narrowed shape — keeps the two return values
  // interchangeable for consumers that read back the updated row.
  const { data, error } = await supabase
    .from('projects')
    .update(allowed)
    .eq('id', projectId)
    .select('id, name, description, ai_context, ai_context_updated_at')
    .single();
  return { data, error };
}

// ── Project AI: context + usage tracking ────────────────────────────────────
// Backs the Project Overview "AI" tab. See migration 030.

// Persist the per-project AI context (free-text instructions prepended to
// every AI request in the project). Admin-only via the same "admins update
// projects" RLS policy that guards name/description — a non-admin save just
// returns zero rows (the UI gates the editor to admins anyway). Empty string
// is stored as NULL so "configured" is a simple `is not null` check. Stamps
// ai_context_updated_at so the usage/overview surfaces can show "updated N ago".
export async function updateProjectAiContext(projectId, aiContext) {
  const value = typeof aiContext === 'string' ? aiContext.trim() : '';
  const { data, error } = await supabase
    .from('projects')
    .update({
      ai_context: value.length ? value : null,
      ai_context_updated_at: new Date().toISOString(),
    })
    .eq('id', projectId)
    .select('id, ai_context, ai_context_updated_at')
    .single();
  return { data, error };
}

// Monthly AI usage aggregates for a project, via the get_project_ai_usage RPC
// (SECURITY INVOKER → RLS filters to projects the caller belongs to; a
// non-member or a project with no usage yields an all-zero row). The RPC
// returns a single-row table, so unwrap the first element. Returns a plain
// object { requests, input_tokens, output_tokens, sessions, last_used_at } or
// null on error.
export async function getProjectAiUsage(projectId) {
  const { data, error } = await supabase.rpc('get_project_ai_usage', { p_project_id: projectId });
  if (error) return { data: null, error };
  const row = Array.isArray(data) ? data[0] : data;
  return { data: row || null, error: null };
}

// Logging primitive for project-scoped AI features (Generate / Automate / chat
// assistant / summarise / …) to record one request's token usage. Inserts a
// row attributed to the caller; the "members insert own" RLS policy gates it to
// project members. Fire-and-forget at call sites — a failed log shouldn't break
// the AI feature that emitted it. Server-side emitters (Edge Functions) use the
// service role and write to this table directly instead.
export async function logProjectAiUsage({
  projectId,
  action = 'generate',
  model = null,
  inputTokens = 0,
  outputTokens = 0,
  sessionId = null,
}) {
  const userResult = await supabase.auth.getUser();
  const userId = userResult.data.user?.id ?? null;
  const { data, error } = await supabase
    .from('project_ai_usage')
    .insert({
      project_id: projectId,
      user_id: userId,
      action,
      model,
      input_tokens: Math.max(0, Math.round(Number(inputTokens) || 0)),
      output_tokens: Math.max(0, Math.round(Number(outputTokens) || 0)),
      session_id: sessionId,
    })
    .select('id')
    .single();
  return { data, error };
}

// Owner-only via RLS. Cascade clears project_members + project_invitations.
// Fires PROJECTS_CHANGED_EVENT on success so picker caches invalidate.
export async function deleteProject(projectId) {
  const { error } = await supabase.from('projects').delete().eq('id', projectId);
  if (!error) notifyProjectsChanged();
  return { data: null, error };
}

// ── Members ───────────────────────────────────────────────────────────────

// Members of a project with their auth.users profile data joined client-side.
// Two queries because RLS blocks direct client access to auth.users — we go
// through the SECURITY DEFINER get_member_profiles() RPC which reads
// auth.users on our behalf, filtered to "users you share a project with"
// based on the caller's auth.uid().
export async function listMembers(projectId) {
  const { data: members, error: mErr } = await supabase
    .from('project_members')
    .select('user_id, role, added_at, custom_role_id')
    .eq('project_id', projectId)
    .order('added_at', { ascending: true });
  if (mErr) return { data: [], error: mErr };
  if (!members?.length) return { data: [], error: null };

  const userIds = members.map((m) => m.user_id);
  const { data: profiles, error: pErr } = await supabase
    .rpc('get_member_profiles', { p_user_ids: userIds });
  if (pErr) return { data: [], error: pErr };

  const profileById = new Map((profiles || []).map((p) => [p.id, p]));
  return {
    data: members.map((m) => ({
      user_id: m.user_id,
      role: m.role,
      // custom_role_id (nullable). When set, ProjectContext joins it against
      // its customRoles catalog so consumers can read the resolved role
      // name + base_role straight from the member row.
      custom_role_id: m.custom_role_id ?? null,
      added_at: m.added_at,
      profile: profileById.get(m.user_id) ?? null,
    })),
    error: null,
  };
}

// Admin-only via RLS. Updating the 'owner' role is rejected by the policy's
// WITH CHECK clause (role <> 'owner'); ownership transfer needs a different
// mechanism we'll add when the use case comes up.
export async function updateMemberRole(projectId, userId, role) {
  if (role === 'owner') {
    return { data: null, error: new Error('Cannot promote to owner via this path') };
  }
  const { data, error } = await supabase
    .from('project_members')
    .update({ role })
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .select('*')
    .single();
  return { data, error };
}

// Admin-only via RLS. The "delete members" policy guards role <> 'owner',
// so trying to remove an owner just no-ops (zero rows) — explicit check here
// gives a clearer error to the caller.
export async function removeMember(projectId, userId) {
  const { error } = await supabase
    .from('project_members')
    .delete()
    .eq('project_id', projectId)
    .eq('user_id', userId);
  return { data: null, error };
}

// Self-removal. RLS allows it via the "delete members" policy's second branch
// (user_id = auth.uid() and role <> 'owner') — owners must transfer ownership
// or delete the project; they can't just leave. Fires PROJECTS_CHANGED_EVENT
// on success so picker caches invalidate.
export async function leaveProject(projectId) {
  const userResult = await supabase.auth.getUser();
  const userId = userResult.data.user?.id;
  if (!userId) return { data: null, error: new Error('Not signed in') };
  const result = await removeMember(projectId, userId);
  if (!result.error) notifyProjectsChanged();
  return result;
}

// ── Invitations ───────────────────────────────────────────────────────────

// Pending invitations (accepted_at is null) on a project. Admin-only via RLS
// "admins read invitations" policy.
export async function listInvitations(projectId) {
  const { data, error } = await supabase
    .from('project_invitations')
    .select('id, email, role, custom_role_id, token, expires_at, created_at, invited_by')
    .eq('project_id', projectId)
    .is('accepted_at', null)
    .order('created_at', { ascending: false });
  return { data: data || [], error };
}

// Edge Function calls. Each function bundles auth + admin check + the
// service-role-dependent work (Resend send, RPC-based atomic accept).
// supabase.functions.invoke automatically sends the user JWT in the
// Authorization header so the function can verify it.

// Optional customRoleId is the id of a `custom_roles` row for the project.
// When set, the Edge Function persists it on the invitation; accept_invitation
// then uses the custom role's base_role for the project_members.role enum
// AND copies custom_role_id onto the new member row. Backward-compat: omit
// the arg and behaviour is identical to before.
export async function sendInvite(projectId, email, role, customRoleId = null) {
  const body = { project_id: projectId, email, role };
  if (customRoleId) body.custom_role_id = customRoleId;
  const { data, error } = await supabase.functions.invoke('send-invite', { body });
  return { data, error };
}

// Debug-only: trigger the invite Edge Function with `debug: true`. The
// function skips its capability/upsert path and sends a brand-styled
// preview to the caller's own email — used by the DEBUG menu's "Send
// all email previews" item. No project context required.
export async function sendInviteDebug() {
  const { data, error } = await supabase.functions.invoke('send-invite', {
    body: { debug: true },
  });
  return { data, error };
}

export async function acceptInvite(token) {
  const { data, error } = await supabase.functions.invoke('accept-invite', {
    body: { token },
  });
  return { data, error };
}

export async function revokeInvite(invitationId) {
  const { data, error } = await supabase.functions.invoke('revoke-invite', {
    body: { invitation_id: invitationId },
  });
  return { data, error };
}

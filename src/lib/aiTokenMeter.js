// Per-project AI token accounting.
//
// Every Claude call the app makes comes back with `{ input_tokens,
// output_tokens }`. This module is where those land: it keeps a running
// per-project total on this device AND mirrors each request into the
// `project_ai_usage` table so the server-side monthly aggregate
// (get_project_ai_usage) stays real.
//
// Why a local counter at all when there's a table:
//   - It's synchronous, so the Overview gauge paints the right number on its
//     first frame instead of after an RPC.
//   - It survives an offline / RLS-blocked insert — the user still sees what
//     their project has spent.
//   - It can be reset from the UI. The table has no client DELETE policy (see
//     migration 030), so a reset button that promised to clear it would be
//     lying; this counter is the thing the reset button owns.
// The two are the same number in practice — both are fed from the same call
// site — the local one just answers instantly and is the resettable one.
//
// Attribution is AMBIENT: `setAiUsageProject` is driven by
// SelectedProjectContext, so a call made while working in a project is billed
// to that project without every AI helper in the codebase having to thread a
// project id through. Callers that are explicitly NOT project work (the
// personal Mail tab) opt out by passing `usageProject: null`.

import { logProjectAiUsage } from './projects';

const KEY = 'docvex.ai.tokens.v1';

// Fired after any change (a recorded request or a reset) so open gauges
// re-read without polling.
export const AI_TOKENS_CHANGED_EVENT = 'docvex:ai-tokens-changed';

// The project AI calls are attributed to when they don't name one.
let activeProjectId = null;
export function setAiUsageProject(projectId) {
  activeProjectId = projectId || null;
}
export function getAiUsageProject() {
  return activeProjectId;
}

const EMPTY = { input: 0, output: 0, total: 0, requests: 0, lastAt: null };

function readAll() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(map) {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* quota */ }
}

function announce() {
  try { window.dispatchEvent(new CustomEvent(AI_TOKENS_CHANGED_EVENT)); } catch { /* non-browser */ }
}

// AI requests also originate in the Doc Viewer, which is its own window with
// its own renderer — its writes land in the same localStorage but its
// CustomEvent doesn't cross the window boundary. `storage` does, so re-announce
// locally when another window touches the key and the main window's gauge stays
// live. (Concurrent read-modify-write from two windows can lose a request's
// worth of tokens; the server-side rows in project_ai_usage remain complete.)
try {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) announce();
  });
} catch { /* non-browser */ }

// Totals for one project. Always returns a full shape so callers can read
// `.total` without guarding.
export function readAiTokens(projectId) {
  if (!projectId) return { ...EMPTY };
  const row = readAll()[projectId];
  if (!row) return { ...EMPTY };
  const input = Number(row.input) || 0;
  const output = Number(row.output) || 0;
  return {
    input,
    output,
    total: input + output,
    requests: Number(row.requests) || 0,
    lastAt: row.lastAt || null,
  };
}

// Zero one project's counter. The debug "Reset" button in the AI tab.
export function resetAiTokens(projectId) {
  if (!projectId) return;
  const map = readAll();
  if (!map[projectId]) return;
  delete map[projectId];
  writeAll(map);
  announce();
}

// Record one request's usage. Fire-and-forget at call sites: the local add is
// synchronous, the table insert is best-effort (a failed log must never break
// the AI feature that emitted it).
//
// `projectId` undefined → the ambient active project. `null` → don't track
// (an explicitly non-project call).
export function recordAiTokens({ projectId, usage, action = 'chat', model = null, sessionId = null } = {}) {
  const pid = projectId === undefined ? activeProjectId : projectId;
  if (!pid) return;
  const input = Math.max(0, Math.round(Number(usage?.input_tokens) || 0));
  const output = Math.max(0, Math.round(Number(usage?.output_tokens) || 0));
  if (!input && !output) return;

  const map = readAll();
  const prev = map[pid] || { input: 0, output: 0, requests: 0 };
  map[pid] = {
    input: (Number(prev.input) || 0) + input,
    output: (Number(prev.output) || 0) + output,
    requests: (Number(prev.requests) || 0) + 1,
    lastAt: new Date().toISOString(),
  };
  writeAll(map);
  announce();

  // The table's `action` column is CHECK-constrained (migration 030) — an
  // unknown value would 400 the insert, so anything unrecognised is filed as
  // 'other' rather than dropped.
  const ACTIONS = new Set(['generate', 'automate', 'chat', 'summarize', 'digest', 'other']);
  logProjectAiUsage({
    projectId: pid,
    action: ACTIONS.has(action) ? action : 'other',
    model,
    inputTokens: input,
    outputTokens: output,
    sessionId,
  }).catch(() => { /* best-effort mirror */ });
}

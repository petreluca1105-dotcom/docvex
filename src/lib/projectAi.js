// Client wrapper for the `project-ai` Edge Function — live Claude for the
// project AI hub (the /ai surface). Mirrors the invoke pattern in
// legalFeed.getWeeklyDigest: the function returns a 200 with
// `{ ok:false, error }` when the AI key isn't configured, so callers fall
// back gracefully instead of throwing on a non-2xx.

import { supabase } from './supabaseClient';
import { recordAiTokens } from './aiTokenMeter';
import { getActiveJurisdiction } from './jurisdictions';

// Every request carries the open project's jurisdiction so the Edge Function
// can build a system prompt that names the right law, courts and answer
// language (it re-resolves the code against its own allow-list — see
// supabase/functions/_shared/jurisdictions.ts). Omitted when nothing is set,
// which leaves the function on its Romania default.
function withJurisdiction(body, override) {
  const code = override === undefined ? getActiveJurisdiction() : override;
  return code ? { ...body, jurisdiction: code } : body;
}

// Selectable Claude models, surfaced in the chat composer's model picker. The
// `best` line is the in-UI guidance for "which model for which task". `id`s are
// passed through to the `project-ai` Edge Function, which allow-lists them.
// Default is Opus 4.7 (the model the chat has always used here, so the default
// behaviour is unchanged); Sonnet/Haiku are opt-in for speed/cost.
export const AI_MODELS = [
  {
    id: 'claude-opus-4-7',
    label: 'Opus',
    tagline: 'Deepest reasoning',
    best: 'Complex drafting, nuanced legal analysis, and long documents. Most capable — slowest and priciest.',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet',
    tagline: 'Fast & balanced',
    best: 'Most everyday tasks — chat, summaries, and building slide decks / Word docs. Great quality, much quicker than Opus.',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku',
    tagline: 'Fastest & cheapest',
    best: 'Quick questions, short edits, and simple lists. Snappiest and cheapest; less deep on hard reasoning.',
  },
];
export const DEFAULT_AI_MODEL = 'claude-opus-4-7';
const MODEL_IDS = new Set(AI_MODELS.map((m) => m.id));
// Normalise a possibly-stale/unknown model id to a valid one (or the default).
export function coerceModel(id) {
  return MODEL_IDS.has(id) ? id : DEFAULT_AI_MODEL;
}

function unwrap(data, error) {
  if (error) return { error };
  if (!data || data.ok === false) {
    return { error: new Error(data?.error || 'ai_unavailable') };
  }
  return { data };
}

// Q&A turn. `messages` is the running conversation as
// [{ role: 'user' | 'assistant', content }] — `content` is a string for ordinary
// turns or an array of content blocks for a tool round-trip. Returns
// `{ text, usage, stopReason?, tool?, toolUse?, askUser?, assistantContent? }` or
// `{ error }`.
//   • `usage` = { input_tokens, output_tokens } for the token-usage indicator.
//   • When the model calls a tool, `stopReason === 'tool_use'` and `tool` names it:
//     - 'ask_user'       → `askUser = { id, input:{ questions:[…] } }`
//     - 'write_document' → `toolUse = { id, input:{ kind, summary?, content } }`
//     `assistantContent` is the raw assistant content blocks (replay on resume).
// Options:
//   • `tools: false`   — utility calls (e.g. title generation): no tools at all.
//   • `docTools: true` — DocViewer "generate" surface: expose write_document so
//     the model drives an iterative document build (it may also ask_user).
//   • `forceDocument: true` — pin tool_choice to write_document (guarantees a new
//     version; use when the user clearly asked for a document).
//   • `docKind` — 'docx'|'pptx'|'xlsx' to lock the format across versions.
//   • `usageProject` — which project this turn's tokens are billed to. Omit for
//     the ambient selected project (the normal case); pass `null` for calls
//     that aren't project work at all (the personal Mail tab).
//   • `usageAction` — the project_ai_usage action bucket for this turn.
export async function askProjectAi({ messages, projectName, fileNames, model, tools, docTools, forceDocument, docKind, jurisdiction, usageProject, usageAction = 'chat' }) {
  const body = withJurisdiction({ action: 'ask', messages, projectName, fileNames, model }, jurisdiction);
  if (tools === false) body.tools = false;
  if (docTools) body.docTools = true;
  if (forceDocument) body.forceDocument = true;
  if (docKind) body.docKind = docKind;
  const { data, error } = await supabase.functions.invoke('project-ai', { body });
  const res = unwrap(data, error);
  if (res.error) return res;
  const usage = res.data.usage || { input_tokens: 0, output_tokens: 0 };
  // Every project-ai `ask` turn — chat, the Doc Viewer advisor, AI file
  // indexing, AI search, the timeline council — funnels through here, so this
  // one line is what makes the per-project token total real. Fire-and-forget:
  // it must not delay or fail the answer.
  recordAiTokens({ projectId: usageProject, usage, action: usageAction, model: model || null });
  return {
    text: res.data.text || '',
    usage,
    stopReason: res.data.stopReason || null,
    tool: res.data.tool || null,
    toolUse: res.data.toolUse || null,
    askUser: res.data.askUser || null,
    assistantContent: res.data.assistantContent || null,
  };
}

// Build the two messages that RESUME a paused ask_user turn: the assistant turn
// replayed exactly as received (its tool_use block) + a user turn carrying the
// tool_result. Append both to history before the next askProjectAi call.
export function buildAskResume(askUser, assistantContent, answers) {
  return [
    { role: 'assistant', content: assistantContent || [{ type: 'tool_use', id: askUser.id, name: 'ask_user', input: askUser.input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: askUser.id, content: JSON.stringify(answers) }] },
  ];
}

// Normalise the panel's per-question selections into the tool_result payload the
// model reads back. `perQuestion` is keyed by question id → an array of selected
// option ids, a free-text string, or a boolean (confirm).
export function makeAskAnswers(questions, perQuestion, { dismissed = false } = {}) {
  if (dismissed) return { answers: [], dismissed: true };
  const answers = (questions || []).map((q) => {
    const v = perQuestion[q.id];
    if (q.response_type === 'free_text') return { question_id: q.id, response_type: 'free_text', text: String(v ?? '') };
    if (q.response_type === 'confirm') return { question_id: q.id, response_type: 'confirm', approved: !!v };
    const ids = Array.isArray(v) ? v : v != null ? [v] : [];
    const labels = ids.map((id) => (q.options || []).find((o) => o.id === id)?.label).filter(Boolean);
    return { question_id: q.id, response_type: q.response_type, selected: ids, label: labels };
  });
  return { answers };
}

// Suggest content-aware actions for a dropped file. `excerpt` is an optional
// text sample (texty files only); binaries pass just name + mime. Returns
// `{ suggestions: [{ label, prompt }] }` or `{ error }` so the caller can fall
// back to its own heuristic list.
export async function suggestFileActions({ fileName, excerpt, mimeType }) {
  const { data, error } = await supabase.functions.invoke('project-ai', {
    body: { action: 'suggest', fileName, excerpt, mimeType },
  });
  const res = unwrap(data, error);
  if (res.error) return res;
  return { suggestions: Array.isArray(res.data.suggestions) ? res.data.suggestions : [] };
}

// Draft a document. Returns `{ text }` or `{ error }`.
//
// The user's learned writing style (Playbook) is folded into the instructions
// rather than sent as its own field: `generate` takes free-text instructions, so
// this works against the function as already deployed and needs nothing added
// server-side. Lazy-imported to keep this module free of a cycle — writingStyle
// calls askProjectAi from right here.
export async function generateDocument({ template, instructions, projectName, fileNames }) {
  let steered = instructions;
  try {
    const { styleSteer } = await import('./writingStyle');
    const steer = await styleSteer();
    if (steer) steered = `${instructions || ''}\n\n${steer}`.trim();
  } catch { /* a generic voice is a worse draft, not a failed one */ }
  const { data, error } = await supabase.functions.invoke('project-ai', {
    body: withJurisdiction({ action: 'generate', template, instructions: steered, projectName, fileNames }),
  });
  const res = unwrap(data, error);
  if (res.error) return res;
  return { text: res.data.text || '' };
}

// Build a real Office file from `content` using Anthropic's document Agent Skills
// (pptx/docx/xlsx/pdf) — the high-fidelity path. Returns `{ base64, kind }` on
// success, or `{ unavailable: true }` when the account lacks the betas (so the
// caller falls back to the local JS builders), or `{ error }` on a hard failure.
export async function generateOfficeFile({ kind, content, instructions, model }) {
  const { data, error } = await supabase.functions.invoke('project-ai', {
    body: withJurisdiction({ action: 'office', kind, content, instructions, model }),
  });
  if (error) return { error, detail: error.message };
  if (data?.ok && data.base64) return { base64: data.base64, kind: data.kind || kind, containerId: data.containerId || null };
  // Soft signals → fall back to local generation rather than failing the write.
  if (data?.error === 'office_unavailable' || data?.error === 'unsupported_kind' || data?.error === 'no_file') {
    return { unavailable: true, code: data.error, detail: data.detail };
  }
  return { error: new Error(data?.error || 'office_failed'), detail: data?.detail };
}

// Playbook — the user's own documents, and the writing style the AI learns
// from them.
//
// The problem this solves: a generated draft that is *correct* but does not
// sound like the person sending it still has to be rewritten, so the time it
// saved is spent again. The fix is not a better prompt — it is showing the
// model how this particular person actually writes. So the user imports
// documents they wrote by hand, one pass distils them into a description of
// their drafting habits, and that description rides along with every request
// that writes or edits prose.
//
// PERSONAL, not project-scoped: how someone writes follows them across every
// matter, so both tables hang off the account (`user_id = auth.uid()`, see
// migration 034) and the style is the same in every project they open.
//
// What leaves the machine: a CAPPED excerpt of each imported document, and the
// distilled profile. Not the file. The user is told this on the page.

import { supabase } from './supabaseClient';
import { askProjectAi } from './projectAi';

// Per-sample store cap. Long enough that the style signal is unmistakable —
// openings, closings, how clauses are built, how lists are numbered — and short
// enough that a folder of contracts is not being copied into a database.
export const SAMPLE_EXCERPT_CHARS = 12000;
// What one sample contributes to a distillation pass, and the budget for all of
// them together. Style is legible from the first pages; the rest is repetition.
const PER_SAMPLE_CHARS = 6000;
const TOTAL_DISTILL_CHARS = 60000;
// The distilled profile rides on EVERY drafting request, so it is priced like a
// system prompt rather than like a document.
const MAX_PROFILE_CHARS = 2600;

// Cheap and fast: this reads documents and describes them, which is not the
// kind of work Opus is needed for.
const DISTILL_MODEL = 'claude-sonnet-4-6';

// ── Samples ─────────────────────────────────────────────────────────────

export async function listSamples() {
  const { data, error } = await supabase
    .from('writing_samples')
    .select('id, name, doc_kind, mime_type, char_count, created_at')
    .order('created_at', { ascending: false });
  if (error) return { error };
  return { samples: data || [] };
}

// `text` is the extracted plain text of the document. Stored capped — see the
// note at the top of the file.
export async function addSample({ name, mimeType = '', docKind = '', text = '' }) {
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!body) return { error: new Error('no_text') };
  const { data, error } = await supabase
    .from('writing_samples')
    .insert({
      name: String(name || 'Untitled'),
      mime_type: mimeType || '',
      doc_kind: docKind || '',
      char_count: body.length,
      excerpt: body.slice(0, SAMPLE_EXCERPT_CHARS),
    })
    .select('id, name, doc_kind, mime_type, char_count, created_at')
    .single();
  if (error) return { error };
  return { sample: data };
}

export async function removeSample(id) {
  const { error } = await supabase.from('writing_samples').delete().eq('id', id);
  return error ? { error } : { ok: true };
}

// ── The learned profile ─────────────────────────────────────────────────

export async function loadProfile() {
  const { data, error } = await supabase
    .from('writing_profiles')
    .select('profile, sample_count, model, enabled, generated_at, updated_at')
    .maybeSingle();
  if (error) return { error };
  if (!data) return { profile: null };
  return {
    profile: {
      text: data.profile || '',
      sampleCount: data.sample_count || 0,
      model: data.model || '',
      enabled: data.enabled !== false,
      generatedAt: data.generated_at || null,
      updatedAt: data.updated_at || null,
    },
  };
}

// The switch that turns imitation off without deleting what was taught — for a
// one-off piece that has to read neutrally.
export async function setStyleEnabled(on) {
  const { data: sess } = await supabase.auth.getUser();
  const userId = sess?.user?.id;
  if (!userId) return { error: new Error('signed_out') };
  const { error } = await supabase
    .from('writing_profiles')
    .upsert({ user_id: userId, enabled: !!on, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) return { error };
  invalidateStyleCache();
  return { ok: true };
}

function distillPrompt(samples) {
  const lines = [
    'Below are excerpts from documents ONE person wrote by hand. Study how they write and produce a style guide that another writer could follow to produce work indistinguishable from theirs.',
    '',
    'Describe, concretely and with their own examples where useful:',
    '- Register and tone — formal or plain, warm or clipped, first person or impersonal.',
    '- Sentence and paragraph shape — typical length, how clauses are built, whether they front-load conclusions.',
    '- Structure — how documents open and close, how sections are titled and numbered, list and indentation habits.',
    '- Recurring formulations — the phrases, connectives and set expressions they reach for again and again. Quote them.',
    '- Conventions — defined terms, capitalisation, dates, amounts, party naming, how references and citations are written.',
    '- Language — which language they write in, and any consistent mixing.',
    '',
    'Rules:',
    '- Describe only what the excerpts actually show. Where they are silent, say nothing — do not invent a preference.',
    '- Write it as direct instructions to a writer ("Open with…", "Prefer…"), not as an essay about the author.',
    `- Under ${MAX_PROFILE_CHARS} characters. It is read before every draft, so every line has to earn its place.`,
    '- Return the guide only. No preamble, no heading, no code fence.',
    '',
  ];
  let budget = TOTAL_DISTILL_CHARS;
  samples.forEach((sm, i) => {
    if (budget <= 0) return;
    const slice = String(sm.excerpt || '').slice(0, Math.min(PER_SAMPLE_CHARS, budget));
    if (!slice.trim()) return;
    budget -= slice.length;
    lines.push(`--- DOCUMENT ${i + 1}: ${sm.name}${sm.doc_kind ? ` (${sm.doc_kind})` : ''} ---`, slice, '');
  });
  return lines.join('\n');
}

// Re-read every sample and rewrite the profile. Called when the user imports or
// removes a document, and from the page's own "Learn again" action.
export async function rebuildProfile() {
  const { data: sess } = await supabase.auth.getUser();
  const userId = sess?.user?.id;
  if (!userId) return { error: new Error('signed_out') };

  const { data, error } = await supabase
    .from('writing_samples')
    .select('name, doc_kind, excerpt')
    .order('created_at', { ascending: false })
    .limit(24);
  if (error) return { error };
  const samples = (data || []).filter((s) => String(s.excerpt || '').trim());

  // Nothing left to learn from. Clear the profile rather than leaving the last
  // one standing — a style guide derived from documents that have been deleted
  // is a claim about the user that nothing on the page supports any more.
  if (!samples.length) {
    await supabase.from('writing_profiles').upsert({
      user_id: userId,
      profile: '',
      sample_count: 0,
      generated_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    invalidateStyleCache();
    return { profile: { text: '', sampleCount: 0, enabled: true, generatedAt: null } };
  }

  const res = await askProjectAi({
    messages: [{ role: 'user', content: distillPrompt(samples) }],
    model: DISTILL_MODEL,
    tools: false,
    // Personal work, not a project's — it must not land in any project's
    // token bill (the Mail tab does the same).
    usageProject: null,
    usageAction: 'writing-style',
  });
  if (res.error) return { error: res.error };

  const text = String(res.text || '').trim().slice(0, MAX_PROFILE_CHARS);
  if (!text) return { error: new Error('empty_profile') };

  const now = new Date().toISOString();
  const { error: saveErr } = await supabase.from('writing_profiles').upsert({
    user_id: userId,
    profile: text,
    sample_count: samples.length,
    model: DISTILL_MODEL,
    generated_at: now,
    updated_at: now,
  }, { onConflict: 'user_id' });
  if (saveErr) return { error: saveErr };

  invalidateStyleCache();
  return { profile: { text, sampleCount: samples.length, model: DISTILL_MODEL, enabled: true, generatedAt: now } };
}

// ── Riding along with a drafting request ────────────────────────────────

// One network read serves every turn for a few minutes. Invalidated outright by
// anything on the Playbook page that changes the answer, so a "Learn again" is
// in force on the very next message rather than whenever a timer happens to
// lapse.
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, steer: '' };
let inflight = null;

export function invalidateStyleCache() {
  cache = { at: 0, steer: '' };
  inflight = null;
}

function buildSteer(text) {
  return [
    '[Writing style — the user\'s own. The following was learned from documents THIS user wrote by hand. When you write or edit any prose for them, match it: their register, sentence shape, structure, and their recurring formulations. The result should read as though they wrote it.',
    '',
    text,
    '',
    'Two limits. It governs WORDING and FORM only — never change legal substance, facts, figures or the parties\' obligations to make something sound more like them. And an explicit instruction in the request always wins over this description.]',
  ].join('\n');
}

// The block to append to a drafting turn, or '' when there is nothing learned,
// the user has switched it off, or nobody is signed in. Never throws and never
// blocks a turn on a failure: writing in a generic voice is a worse answer,
// not a broken one.
export async function styleSteer() {
  const now = Date.now();
  if (cache.at && now - cache.at < CACHE_MS) return cache.steer;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { profile } = await loadProfile();
      const text = profile?.enabled ? String(profile.text || '').trim() : '';
      cache = { at: Date.now(), steer: text ? buildSteer(text) : '' };
      return cache.steer;
    } catch {
      cache = { at: Date.now(), steer: '' };
      return '';
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// Append the style block to the last user message of an API payload — the same
// shape the file-creation steer uses, so a turn carries both without either
// having to know about the other. Returns the array unchanged when there is no
// style to apply.
export async function withStyleSteer(apiMessages) {
  const steer = await styleSteer();
  if (!steer || !apiMessages?.length) return apiMessages;
  const last = apiMessages[apiMessages.length - 1];
  // Only ever onto a plain-text user turn. A tool_result turn is a structured
  // payload the model is mid-way through reading; appending prose to it would
  // corrupt the round-trip, and the steer it already saw still applies.
  if (last?.role !== 'user' || typeof last.content !== 'string') return apiMessages;
  return [...apiMessages.slice(0, -1), { ...last, content: `${last.content}\n\n${steer}` }];
}

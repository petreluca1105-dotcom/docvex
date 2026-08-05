// doc-ai — Claude backend for the in-app Legal AI document viewer.
//
// When a user opens a file in DocVex it shows in a dedicated window
// (src/pages/DocViewer.jsx): the document preview + a Legal AI task pane
// with Draft / Review / Ask tabs. The pane extracts the document's text in
// the renderer and POSTs it here; Claude responds and the pane renders /
// applies the result.
//
// verify_jwt stays ON: the viewer window shares the user's DocVex
// (Supabase) session, so supabase-js attaches the JWT and only DocVex
// users can spend the firm's Anthropic budget.
//
// Actions (dispatched on `task`):
//   "ask"      { documentText, question }              -> { ok, answer }   (markdown)
//   "summary" | "risks" | "romanian" { documentText }  -> { ok, answer }   (markdown)
//   "draft"    { documentText, instruction, clause? }  -> { ok, text }     (revised/new clause)
//   "review"   { playbook, paragraphs: string[] }      -> { ok, findings } (JSON)
//        findings: [{ paragraphIndex, issue, severity:"high"|"medium"|"low", suggestion }]
//   "ocr"      { image: base64, mediaType }            -> { ok, text }     (exact transcription)
//        backs the DocViewer's "Extract text" selection tool on photos /
//        paused video frames; runs on a cheap fast model (DOC_AI_OCR_MODEL).
//   "transcribe" { audio: base64, mediaType, filename? } -> { ok, text, segments, language }
//        backs the DocViewer audio player's "Generate captions" button.
//        Claude has no audio input, so this calls OpenAI's Whisper API
//        instead (DOC_AI_TRANSCRIBE_MODEL, default "whisper-1"). Requires
//        the OPENAI_API_KEY secret — independent of ANTHROPIC_API_KEY.
//        Optional speaker diarization: when DOC_AI_ALLOW_DEEPGRAM=1 AND
//        DEEPGRAM_API_KEY are both set, the audio is also run through Deepgram
//        purely for speaker turns, and each Whisper segment gets a `speaker`
//        index grafted on (Whisper keeps the text — stronger on Romanian).
//        Otherwise segments ship speaker-less and the client falls back to a
//        silence-gap heuristic. The double opt-in is deliberate — see the
//        training-posture note by DEEPGRAM_ALLOWED below.
//
// Claude is called over raw REST (x-api-key), same shape as legal-ai —
// no SDK to bundle. Model defaults to claude-opus-4-7 (override via
// DOC_AI_MODEL / LEGAL_AI_MODEL). Required secret: ANTHROPIC_API_KEY.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function preflight(req: Request): Response | null {
  return req.method === "OPTIONS" ? new Response("ok", { headers: corsHeaders }) : null;
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL =
  Deno.env.get("DOC_AI_MODEL") ??
  Deno.env.get("LEGAL_AI_MODEL") ??
  "claude-opus-4-7";
// OCR is plain transcription — a fast cheap model does it as well as Opus.
const OCR_MODEL = Deno.env.get("DOC_AI_OCR_MODEL") ?? "claude-haiku-4-5-20251001";

// Audio transcription has no Claude equivalent — backed by OpenAI Whisper.
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const TRANSCRIBE_MODEL = Deno.env.get("DOC_AI_TRANSCRIBE_MODEL") ?? "whisper-1";

// Optional speaker diarization (Deepgram) — only speaker turns are used; the
// transcript text still comes from Whisper. Absent the key, transcription works
// exactly as before with no speaker labels.
//
// TRAINING POSTURE — why this needs a SECOND opt-in beyond the key.
// Anthropic and OpenAI both contractually exclude API traffic from model
// training by default, so the rest of this file can send client material and
// know it isn't learned from. Deepgram's standard (non-Enterprise) terms do
// NOT make that promise — usage data may be used to improve their models
// unless the account is on a plan/contract that opts out. This app handles
// privileged legal material, including recorded client and witness audio, so
// a key sitting in the environment must not be enough on its own to start
// shipping that audio to a provider that may learn from it. Diarization stays
// OFF until an operator sets DOC_AI_ALLOW_DEEPGRAM=1, which is the point at
// which they've confirmed their Deepgram contract forbids training.
const DEEPGRAM_ALLOWED = (Deno.env.get("DOC_AI_ALLOW_DEEPGRAM") ?? "") === "1";
const DEEPGRAM_API_KEY = DEEPGRAM_ALLOWED ? (Deno.env.get("DEEPGRAM_API_KEY") ?? "") : "";
const DEEPGRAM_MODEL = Deno.env.get("DOC_AI_DIARIZE_MODEL") ?? "nova-2";

const MAX_DOC_CHARS = 40000;
const MAX_QUESTION_CHARS = 2000;
const MAX_PLAYBOOK_CHARS = 4000;
const MAX_PARAGRAPHS = 200;

// ── Claude Messages API (raw REST) ──────────────────────────────────
async function callClaude(opts: {
  system: string;
  // A plain string, or an array of content blocks (the OCR task sends an
  // image block + a text block).
  user: string | unknown[];
  maxTokens: number;
  jsonSchema?: Record<string, unknown>;
  model?: string;
}): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model ?? MODEL,
    max_tokens: opts.maxTokens,
    system: [
      { type: "text", text: opts.system, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: opts.user }],
  };
  if (opts.jsonSchema) {
    body.output_config = { format: { type: "json_schema", schema: opts.jsonSchema } };
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 400);
    throw new Error(`anthropic_${resp.status}: ${detail}`);
  }
  const data = await resp.json();
  return (data?.content ?? [])
    .filter((b: { type?: string }) => b?.type === "text")
    .map((b: { text?: string }) => b.text ?? "")
    .join("")
    .trim();
}

const BASE_SYSTEM =
  "You are DocVex Legal AI, an assistant for a Romanian law firm. You work with the text of a " +
  "legal document a lawyer has open. Be precise, neutral, and practical; cite concrete dates, " +
  "parties, amounts, deadlines, and article/clause references when they appear in the text. Never " +
  "invent facts that are not in the document — if something is missing or ambiguous, say so. " +
  "Answer in Romanian by default; if the user writes in another language, answer in that language.";

// ── ask / summary / risks / romanian (markdown answers) ─────────────
function instructionFor(task: string, question: string): string {
  switch (task) {
    case "summary":
      return "Task: Summarise this document for a busy lawyer. Use Markdown: a one-paragraph overview, " +
        "then `## Puncte cheie` (key terms), then `## Obligații & termene` (obligations + deadlines).";
    case "risks":
      return "Task: Review for legal risk. Markdown: `## Clauze riscante`, `## Lipsuri` (missing protections), " +
        "`## Clauze esențiale`. Rank risky clauses high→low.";
    case "romanian":
      return "Task: Assess against Romanian law/compliance. Markdown: `## Conformitate`, `## Referințe legale`, " +
        "`## Recomandări`. Flag anything potentially unenforceable. This is informational, not formal legal advice.";
    case "ask":
    default:
      return `Task: Answer the user's question about this document.\nUser question: ${question}`;
  }
}

async function handleText(task: string, body: Record<string, string>): Promise<Response> {
  const documentText = (body.documentText ?? "").trim().slice(0, MAX_DOC_CHARS);
  const question = (body.question ?? "").trim().slice(0, MAX_QUESTION_CHARS);
  if (task === "ask" && !question) return jsonResponse({ ok: false, error: "missing_question" }, 400);
  if (!documentText) return jsonResponse({ ok: false, error: "empty_document" }, 400);

  const user =
    `${instructionFor(task, question)}\n\nWrite in clear Markdown (## headings, **bold**, - lists).\n\n` +
    `Document text:\n"""\n${documentText}\n"""`;
  try {
    const answer = await callClaude({ system: BASE_SYSTEM, user, maxTokens: task === "ask" ? 1200 : 1800 });
    return jsonResponse({ ok: true, answer });
  } catch (err) {
    return jsonResponse({ ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) }, 502);
  }
}

// ── draft (rewrite the given clause, or draft a new one) ────────────
async function handleDraft(body: Record<string, string>): Promise<Response> {
  const documentText = (body.documentText ?? "").trim().slice(0, MAX_DOC_CHARS);
  const instruction = (body.instruction ?? "").trim().slice(0, MAX_QUESTION_CHARS);
  const clause = (body.clause ?? "").trim().slice(0, 8000);
  if (!instruction) return jsonResponse({ ok: false, error: "missing_instruction" }, 400);

  const user = clause
    ? `You are a meticulous legal drafting assistant. Rewrite the clause per the instruction. Return ONLY ` +
      `the revised clause text — no preamble, no quotes, no markdown.\n\nInstruction: ${instruction}\n\nClause to rewrite:\n${clause}`
    : `You are a meticulous legal drafting assistant. Draft a single clause from the instruction, consistent ` +
      `with the surrounding agreement. Return ONLY the clause text — no preamble, no markdown.\n\n` +
      `Existing agreement:\n${documentText}\n\nDraft a clause: ${instruction}`;
  try {
    const text = await callClaude({ system: BASE_SYSTEM, user, maxTokens: 900 });
    return jsonResponse({ ok: true, text });
  } catch (err) {
    return jsonResponse({ ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) }, 502);
  }
}

// ── review (playbook → structured findings) ─────────────────────────
const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          paragraphIndex: { type: "integer" },
          issue: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          suggestion: { type: "string" },
        },
        required: ["paragraphIndex", "issue", "severity", "suggestion"],
      },
    },
  },
  required: ["findings"],
};

async function handleReview(body: { playbook?: string; paragraphs?: unknown }): Promise<Response> {
  const playbook = (body.playbook ?? "").trim().slice(0, MAX_PLAYBOOK_CHARS);
  const paragraphs = Array.isArray(body.paragraphs)
    ? (body.paragraphs as unknown[]).slice(0, MAX_PARAGRAPHS).map((p) => String(p ?? ""))
    : [];
  if (paragraphs.length === 0) return jsonResponse({ ok: false, error: "empty_document" }, 400);

  const numbered = paragraphs.map((p, i) => `[${i}] ${p}`).join("\n\n").slice(0, MAX_DOC_CHARS);
  const system =
    BASE_SYSTEM +
    " You are acting as a contract-review engine. Check the document against the playbook and return ONLY " +
    "the findings. For each problematic paragraph: `paragraphIndex` (the [n] index), a one-sentence `issue` " +
    "in Romanian, a `severity` (high/medium/low), and a `suggestion` — a FULL revised version of that " +
    "paragraph, in Romanian, ready to drop in. Omit compliant paragraphs.";
  const user = `PLAYBOOK:\n${playbook}\n\nDOCUMENT (paragraphs indexed):\n${numbered}`;
  try {
    const raw = await callClaude({ system, user, maxTokens: 2500, jsonSchema: REVIEW_SCHEMA });
    let parsed: { findings?: unknown };
    try { parsed = JSON.parse(raw); } catch { parsed = { findings: [] }; }
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    return jsonResponse({ ok: true, findings });
  } catch (err) {
    return jsonResponse({ ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) }, 502);
  }
}

// ── ocr (image region → exact text transcription) ───────────────────
const OCR_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
// Claude caps images at ~5 MB binary; reject oversized uploads before paying
// for the round-trip (base64 inflates ~4/3).
const MAX_IMAGE_B64 = 7_000_000;

async function handleOcr(body: { image?: string; mediaType?: string }): Promise<Response> {
  const image = String(body.image ?? "").trim();
  const mediaType = OCR_MEDIA_TYPES.has(String(body.mediaType)) ? String(body.mediaType) : "image/jpeg";
  if (!image) return jsonResponse({ ok: false, error: "missing_image" }, 400);
  if (image.length > MAX_IMAGE_B64) return jsonResponse({ ok: false, error: "image_too_large" }, 400);

  const system =
    "You are a precise OCR engine. Transcribe the text visible in the image exactly as written — " +
    "same language, same casing, same punctuation, preserving line breaks and reading order. Do not " +
    "translate, correct, summarise, or describe the image. Output ONLY the transcribed text. If no " +
    "readable text is present, output exactly: [no text]";
  const user = [
    { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
    { type: "text", text: "Transcribe all text in this image." },
  ];
  try {
    const answer = await callClaude({ system, user, maxTokens: 2000, model: OCR_MODEL });
    const text = /^\[no text\]$/i.test(answer.trim()) ? "" : answer;
    return jsonResponse({ ok: true, text });
  } catch (err) {
    return jsonResponse({ ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) }, 502);
  }
}

// ── transcribe (audio → text + timed segments via OpenAI Whisper) ────
// Whisper's raw-file cap is 25 MB; base64 inflates that by ~4/3.
const MAX_AUDIO_B64 = 35_000_000;
const AUDIO_EXT_BY_MEDIA_TYPE: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/webm": "webm",
};

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Run the audio through Deepgram with diarization on, returning a flat list of
// words [{ start, end, speaker }] (speaker is an integer). Best-effort: the
// caller swallows failures and keeps the Whisper-only transcript.
async function deepgramWords(
  bytes: Uint8Array,
  mediaType: string,
): Promise<Array<{ start: number; end: number; speaker: number }>> {
  const resp = await fetch(
    `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(DEEPGRAM_MODEL)}&diarize=true&punctuate=true`,
    {
      method: "POST",
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, "Content-Type": mediaType },
      body: bytes,
    },
  );
  if (!resp.ok) throw new Error(`deepgram_${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const words = data?.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
  return Array.isArray(words)
    ? words
        .filter((w: { speaker?: unknown }) => Number.isInteger(w.speaker))
        .map((w: { start?: number; end?: number; speaker: number }) => ({
          start: w.start ?? 0, end: w.end ?? 0, speaker: w.speaker,
        }))
    : [];
}

// Graft a `speaker` index onto each Whisper segment by aligning it to the
// Deepgram words in time: majority speaker among words whose midpoint lands in
// the segment, else the nearest word by time.
function assignSpeakers<T extends { start: number; end: number }>(
  segments: T[],
  words: Array<{ start: number; end: number; speaker: number }>,
): Array<T & { speaker?: number }> {
  if (words.length === 0) return segments;
  return segments.map((seg) => {
    const counts = new Map<number, number>();
    for (const w of words) {
      const mid = (w.start + w.end) / 2;
      if (mid >= seg.start && mid < seg.end) counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
    }
    let best: number | null = null;
    let bestN = 0;
    for (const [spk, n] of counts) if (n > bestN) { bestN = n; best = spk; }
    if (best === null) {
      const c = (seg.start + seg.end) / 2;
      let nd = Infinity;
      for (const w of words) {
        const d = Math.abs((w.start + w.end) / 2 - c);
        if (d < nd) { nd = d; best = w.speaker; }
      }
    }
    return best === null ? seg : { ...seg, speaker: best };
  });
}

async function handleTranscribe(body: { audio?: string; mediaType?: string; filename?: string }): Promise<Response> {
  if (!OPENAI_API_KEY) return jsonResponse({ ok: false, error: "ai_not_configured" }, 500);

  const audio = String(body.audio ?? "").trim();
  if (!audio) return jsonResponse({ ok: false, error: "missing_audio" }, 400);
  if (audio.length > MAX_AUDIO_B64) return jsonResponse({ ok: false, error: "audio_too_large" }, 400);

  const mediaType = String(body.mediaType ?? "audio/mpeg");
  const ext = AUDIO_EXT_BY_MEDIA_TYPE[mediaType] ?? "mp3";
  const filename = String(body.filename ?? `audio.${ext}`);

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(audio);
  } catch {
    return jsonResponse({ ok: false, error: "invalid_audio" }, 400);
  }

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mediaType }), filename);
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  try {
    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 400);
      throw new Error(`openai_${resp.status}: ${detail}`);
    }
    const data = await resp.json();
    let segments = Array.isArray(data?.segments)
      ? data.segments.map((s: { start?: number; end?: number; text?: string }) => ({
          start: s.start ?? 0,
          end: s.end ?? 0,
          text: (s.text ?? "").trim(),
        }))
      : [];
    // Best-effort speaker diarization: graft Deepgram speaker turns onto the
    // Whisper segments. Failures (no key, Deepgram error) keep Whisper-only.
    if (DEEPGRAM_API_KEY && segments.length > 0) {
      try {
        const words = await deepgramWords(bytes, mediaType);
        segments = assignSpeakers(segments, words);
      } catch (_) { /* diarization is optional — keep Whisper-only segments */ }
    }
    return jsonResponse({ ok: true, text: (data?.text ?? "").trim(), segments, language: data?.language ?? null });
  } catch (err) {
    return jsonResponse({ ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) }, 502);
  }
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  const task = String(body.task ?? "");

  // Audio transcription is backed by OpenAI, not Claude — check independently.
  if (task === "transcribe") {
    return handleTranscribe(body as { audio?: string; mediaType?: string; filename?: string });
  }
  if (!ANTHROPIC_API_KEY) return jsonResponse({ ok: false, error: "ai_not_configured" }, 500);

  switch (task) {
    case "ask":
    case "summary":
    case "risks":
    case "romanian":
      return handleText(task, body as Record<string, string>);
    case "draft":
      return handleDraft(body as Record<string, string>);
    case "review":
      return handleReview(body as { playbook?: string; paragraphs?: unknown });
    case "ocr":
      return handleOcr(body as { image?: string; mediaType?: string });
    default:
      return jsonResponse({ ok: false, error: "unknown_task" }, 400);
  }
});

// Party extraction for the case timeline.
//
// By the time the council has reconstructed the story it has read every file in
// the case, and it knows exactly who is in it — the client, the other side, the
// witnesses, the companies behind them. That knowledge used to evaporate with
// the run. This turns it into one identity file per party, written into the
// project's Identities/ folder, so the Files tab ends up with a record for
// everybody involved instead of just the documents they appear in.
//
// Merge, never clobber: a party the user has already filled in by hand keeps
// every field they typed. Only blanks are completed, and the source filenames
// are unioned so a disputed detail can be traced back to the document it came
// out of.

import { askProjectAi } from './projectAi';
import { recognizeCanvas, OCR_MAX_EDGE } from './ocr';
import {
  emptyIdentity, identityKey, mergeIdentity, listIdentities, writeIdentity,
} from './identities';

const EXTRACT_MODEL = 'claude-sonnet-4-6';

// How much of each file the extractor sees. Parties are named in the opening
// paragraphs and the signature block far more often than in the middle, so a
// generous per-file slice matters less than covering every file.
const PER_FILE_CHARS = 3500;
const TOTAL_CHARS = 60000;

const JSON_SPEC = `Respond with ONLY a JSON object — no prose, no markdown fences — in exactly this shape:
{
  "identities": [
    {
      "name": "Popescu Ion",
      "kind": "person",
      "role": "Client",
      "legalName": "Popescu Ion-Marian",
      "aka": "",
      "nationalId": "",
      "dateOfBirth": "",
      "nationality": "",
      "idSeries": "",
      "idNumber": "",
      "taxId": "",
      "regNo": "",
      "legalForm": "",
      "representative": "",
      "address": "",
      "email": "",
      "phone": "",
      "notes": "One or two sentences on what this party does in the story.",
      "sources": ["contract.pdf"]
    }
  ]
}

Field rules:
- "kind" is "person" for a natural person, "org" for a company, authority, court or any other legal entity.
- "name" is how the party is referred to day to day — it becomes the record's title. Keep it short and use the same spelling throughout.
- "role" is what they are TO THIS CASE: Client, Opposing party, Witness, Expert, Counsel, Court, Authority, Third party. One value.
- Person-only fields (nationalId = CNP, dateOfBirth, nationality, idSeries + idNumber) stay empty for organisations; organisation-only fields (taxId = CUI/VAT, regNo = trade register number, legalForm, representative) stay empty for people.
- An act of identity is TWO values: "seria RX nr. 456789" is idSeries "RX" and idNumber "456789". Never put both in one field.
- Copy the address as ONE line, in the order the document writes it: "Str. Mihai Eminescu nr. 12, bl. A3, sc. B, ap. 15, București, sector 3". DocVex splits it into its parts; keeping the "str." / "nr." / "bl." markers is what makes that split reliable.
- "sources" lists the EXACT filenames, verbatim from the set provided, that each detail was read out of.
- Copy values VERBATIM from the documents. Leave a field as "" when the documents do not state it. Never guess a CNP, a registration number, an address or a date.
- Include every named party that matters to the story. Skip people mentioned only in passing with no bearing on it, and skip the law firm's own software or systems.
- Write notes and roles in English; keep names, company names and identifiers exactly as they appear in the source.
- If there are no identifiable parties, return {"identities": []}.`;

function excerptBlock(excerpts) {
  let budget = TOTAL_CHARS;
  const out = [];
  for (const f of excerpts || []) {
    if (budget <= 0) break;
    const text = (f.text || '').slice(0, Math.min(PER_FILE_CHARS, budget));
    if (!text) continue;
    budget -= text.length;
    out.push(`--- FILE: ${f.name} ---\n${text}`);
  }
  return out.join('\n\n') || '(no readable file contents)';
}

// Ask the model for every party in the case. Returns `{ identities }` — always
// an array, empty on any failure, because this runs as a side-effect of the
// timeline and must never be able to fail the story it rides along with.
export async function extractIdentities({ projectName, timeline, excerpts, jurisdiction, usageProject }) {
  const story = [
    timeline?.lede ? `STORY SUMMARY:\n${timeline.lede}` : '',
    Array.isArray(timeline?.events) && timeline.events.length
      ? `EVENTS:\n${timeline.events.slice(0, 80).map((e) => `- ${e.d || ''} ${e.y || ''} — ${e.title || ''}: ${e.body || ''}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');

  const prompt = [
    `You are reading a case file${projectName ? ` for the matter "${projectName}"` : ''} and listing every party involved — the people and the organisations.`,
    '',
    story || '(no reconstructed story available)',
    '',
    'FILE CONTENTS:',
    excerptBlock(excerpts),
    '',
    JSON_SPEC,
  ].join('\n');

  try {
    const res = await askProjectAi({
      messages: [{ role: 'user', content: prompt }],
      projectName,
      fileNames: (excerpts || []).map((f) => f.name),
      model: EXTRACT_MODEL,
      tools: false,
      jurisdiction,
      usageProject,
      usageAction: 'identity-extract',
    });
    if (res.error) return { identities: [], error: res.error };
    return { identities: parseIdentities(res.text || ''), usage: res.usage };
  } catch (err) {
    return { identities: [], error: err };
  }
}

// Pull the identities array out of a model reply. Bare JSON is asked for; a
// fenced block or a sentence of preamble is the usual failure mode, so fall
// back to the outermost braces before giving up.
export function parseIdentities(text) {
  const tryParse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text || '');
  const first = (text || '').indexOf('{');
  const last = (text || '').lastIndexOf('}');
  const candidates = [text, fenced?.[1], first >= 0 && last > first ? text.slice(first, last + 1) : null];
  for (const c of candidates) {
    const obj = c ? tryParse(String(c).trim()) : null;
    const list = Array.isArray(obj?.identities) ? obj.identities : Array.isArray(obj) ? obj : null;
    if (!list) continue;
    return list
      .filter((r) => r && typeof r.name === 'string' && r.name.trim())
      .map((r) => {
        const base = emptyIdentity(r.kind === 'org' ? 'org' : 'person');
        const out = { ...base, origin: 'timeline' };
        for (const key of Object.keys(base)) {
          if (key === 'sources') continue;
          if (typeof r[key] === 'string') out[key] = r[key].trim();
        }
        out.name = r.name.trim();
        out.kind = r.kind === 'org' ? 'org' : 'person';
        out.sources = Array.isArray(r.sources) ? r.sources.filter((sv) => typeof sv === 'string') : [];
        return out;
      });
  }
  return [];
}

// Write the extracted parties into the project's Identities/ folder, folding
// each into whatever is already there. Returns what actually changed, so the
// caller can report "4 added, 2 updated" rather than a bare count.
export async function saveExtractedIdentities(projectDir, identities) {
  if (!projectDir || !identities?.length) return { added: 0, updated: 0, names: [] };
  const existing = await listIdentities(projectDir);
  const byKey = new Map(existing.map((e) => [identityKey(e), e]));
  let added = 0;
  let updated = 0;
  const names = [];
  for (const incoming of identities) {
    const key = identityKey(incoming);
    if (!key) continue;
    const prior = byKey.get(key);
    // A record the user has already opened and filled in keeps everything they
    // typed; only its blanks get completed.
    const record = prior ? mergeIdentity(prior, incoming) : incoming;
    const res = await writeIdentity(projectDir, record, { previousFileName: prior?._fileName });
    if (res.error) continue;
    if (prior) updated += 1; else added += 1;
    names.push(record.name);
    byKey.set(key, { ...record, _fileName: res.filename });
  }
  return { added, updated, names };
}

// Read an image file with the OCR the Doc Viewer already uses. The lasso tool
// hands `recognizeCanvas` a cropped canvas; here the whole picture is the crop,
// scaled down to the edge Claude works at so the upload stays small.
//
// Two decode paths on purpose. `createImageBitmap` is the fast one but throws
// on formats the browser will still happily paint — HEIC from an iPhone above
// all, which is exactly what a photo of an ID card arrives as. An <img> decode
// covers those, so a picture the viewer can SHOW is a picture this can read.
async function decodeToCanvas(blob) {
  let width = 0;
  let height = 0;
  let source = null;
  try {
    source = await createImageBitmap(blob);
    width = source.width; height = source.height;
  } catch {
    source = null;
  }
  if (!source) {
    const url = URL.createObjectURL(blob);
    try {
      source = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('decode_failed'));
        img.src = url;
      });
      width = source.naturalWidth; height = source.naturalHeight;
    } finally {
      // Revoked after draw, below — an <img> still needs its src while painting.
      source && (source._objectUrl = url);
      if (!source) URL.revokeObjectURL(url);
    }
  }
  if (!width || !height) throw new Error('decode_failed');

  const scale = Math.min(1, OCR_MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  // A white ground: a photo with transparency would otherwise reach the model
  // as text on black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  try { source.close?.(); } catch { /* not all engines expose close() */ }
  if (source._objectUrl) URL.revokeObjectURL(source._objectUrl);
  return canvas;
}

async function ocrImageBlob(blob) {
  const canvas = await decodeToCanvas(blob);
  return recognizeCanvas(canvas);
}

// ── Reading a record off a photograph ───────────────────────────────────
// An identity card, a passport page, a company certificate: the details are
// already written down, and typing them again is the kind of work a computer
// should be doing. So the record can be filled from a picture of the document
// it came from.
//
// Two steps, both already built: `doc-ai`'s OCR reads the image, and the field
// extraction below turns that text into this record's shape. Kept as two calls
// rather than one vision prompt because the OCR step is the one that has to be
// accurate — a transcription can be checked, an inference can't.
//
// It NEVER overwrites: a value already on the record was put there on purpose,
// and a photograph is not grounds to replace it. What it can offer is what the
// record is still missing, and the caller is told exactly which fields moved.
const AUTOFILL_KEYS = [
  'legalName', 'nationalId', 'dateOfBirth', 'placeOfBirth', 'nationality', 'gender',
  'idType', 'idSeries', 'idNumber', 'idIssuer', 'idIssuedAt',
  'taxId', 'regNo', 'legalForm', 'representative',
  'address', 'city', 'county', 'country',
];

function autofillPrompt(kind, text) {
  return [
    kind === 'org'
      ? 'The text below was read off a photograph of a Romanian company document (certificat de înregistrare, CUI certificate, or similar).'
      : 'The text below was read off a photograph of a Romanian identity document (carte de identitate, buletin or passport).',
    '',
    'Return ONE JSON object, nothing else — no prose, no code fence. Use exactly these keys:',
    JSON.stringify(Object.fromEntries(AUTOFILL_KEYS.map((k) => [k, ''])), null, 0),
    '',
    'Rules:',
    '- Copy values VERBATIM. Leave a key as "" when the text does not state it. Never guess.',
    '- legalName is the full name exactly as printed (surname first, as Romanian documents write it).',
    '- "SERIA RX NR 456789" is idSeries "RX" and idNumber "456789" — two separate keys, never one.',
    '- CNP is the 13-digit personal code. Do not confuse it with the document number.',
    '- gender: "male" for M / masculin, "female" for F / feminin, "" if not stated.',
    '- dateOfBirth and idIssuedAt in the document\'s own format (e.g. 12.04.1990).',
    '- address is the full domiciliu line as printed, in one string, keeping its "str." / "nr." / "bl." markers.',
    '- city is the locality, county is the județ or sector.',
    '',
    'TEXT:',
    text,
  ].join('\n');
}

// Pull the JSON object out of a model reply that may have wrapped it.
function parseAutofill(reply) {
  const raw = String(reply || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const braced = /\{[\s\S]*\}/.exec(raw);
  for (const candidate of [fenced?.[1], braced?.[0], raw]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* try the next shape */ }
  }
  return null;
}

// Read `imageBlob` and return the fields it can offer for `record`.
//   { fields: { key: value }, error?: string }
// `fields` holds only keys the record is MISSING — what the caller may fill in.
export async function readIdentityFromImage(imageBlob, record, { jurisdiction, projectId } = {}) {
  if (!imageBlob) return { fields: {}, error: 'no_image' };
  let text = '';
  try {
    text = await ocrImageBlob(imageBlob);
  } catch (e) {
    // Distinguish "the browser could not decode this picture" from "the AI
    // could not read it" — they have completely different remedies, and the
    // one message that covered both sent people off sharpening photographs
    // that were never the problem.
    const why = String(e?.message || '');
    if (why === 'decode_failed') return { fields: {}, error: 'decode_failed' };
    return { fields: {}, error: 'ocr_failed', detail: why };
  }
  if (!text.trim()) return { fields: {}, error: 'no_text' };

  const res = await askProjectAi({
    messages: [{ role: 'user', content: autofillPrompt(record?.kind || 'person', text) }],
    jurisdiction,
    usageProject: projectId,
    usageAction: 'identity-autofill',
  });
  if (res?.error) {
    return { fields: {}, error: 'ai_failed', detail: String(res.error?.message || res.error) };
  }
  const parsed = parseAutofill(res?.text);
  // The OCR worked and the model answered — it just did not answer in the shape
  // asked for. Hand back the transcription so the caller can say as much.
  if (!parsed) return { fields: {}, error: 'unreadable', text };

  const fields = {};
  for (const key of AUTOFILL_KEYS) {
    const value = String(parsed[key] ?? '').trim();
    if (!value) continue;
    fields[key] = value;
  }
  // EVERYTHING it read, including values the record already has. Nothing here
  // is applied: the form shows each reading under the field it belongs to and
  // waits to be told. So a value that DISAGREES with what is already typed is
  // the most useful thing this can hand back — dropping it, as this used to,
  // hid the one case worth a person's attention. The caller decides what to
  // show; overwriting is still never automatic.
  return { fields, text };
}

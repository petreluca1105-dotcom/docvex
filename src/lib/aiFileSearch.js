// AI file search — "find me the thing I'm describing", as opposed to the
// literal substring match in fileContentSearch.js.
//
// A query like "car crash" should surface a photo named `IMG_2231.jpg`, a
// witness statement that never uses the word "crash", and a video of an
// accident. None of those match a substring scan, so the model has to judge
// meaning rather than characters.
//
// What it judges, though, is NOT the folder's contents. Reading every file on
// every search — excerpts for the documents, a re-encoded still for every
// photo — is the expensive way to do this, and it re-pays the whole bill for a
// query that differs by one word. Instead the work is split in two:
//
//   1. lib/aiFileIndex.js describes each file ONCE (cheap model, batched,
//      cached on disk against size+mtime). A photo is decoded and uploaded a
//      single time in its life, not once per search.
//   2. This module matches the query against those descriptions — a few dozen
//      words per file — and caches the answer against a signature of the
//      folder (lib/aiSearchCache.js), so asking the same thing twice costs
//      nothing at all.
//
// So the three tiers of cost are: repeat search = free, new query in a known
// folder = one small request, first search in a folder = the indexing pass.

import { askProjectAi } from './projectAi';
import { indexFiles, describedText, indexCoverage } from './aiFileIndex';
import { folderSignature, normalizeQuery, readAnswer, writeAnswer } from './aiSearchCache';

// Matching 25-word summaries doesn't need the deepest model — Sonnet reads the
// catalogue as well as Opus would at a fraction of the price. (Indexing runs on
// Haiku, cheaper still; see aiFileIndex.js.)
const MATCH_MODEL = 'claude-sonnet-4-6';

// Ceiling on catalogue size per request. Descriptions are ~50 tokens each, so
// this is a few thousand tokens — small enough to run on every query.
const MAX_CATALOGUE = 120;

const SYSTEM = [
  'You match files to a natural-language request.',
  'You are given a numbered catalogue of files: name, type, and a short description of what each file is and contains.',
  'The descriptions were written from the files themselves — for pictures and video they describe what is visibly in the image.',
  'Return ONLY a JSON array — no prose, no code fences — of the files that genuinely answer the request:',
  '[{"n": <catalogue number>, "why": "<max 12 words, why this file matches>"}]',
  'Judge on meaning, not keywords: a request for "car crash" is answered by a collision photo, an accident report, or an insurance claim, whether or not those words appear.',
  'Order best match first. Return [] if nothing matches. Never invent a catalogue number.',
].join('\n');

// Strip the code fence a model sometimes wraps JSON in, then parse. Returns []
// on anything unparseable — a bad response degrades to "no results", never to
// a thrown error in the middle of typing.
function parseMatches(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// When a folder holds more files than one request should carry, rank by how
// many of the query's words appear in the file's name or description and take
// the top slice. This is a CAP, not the search: lexical overlap is a poor
// judge of meaning (that's the model's job), it's only being used to decide
// which files are most worth spending the request on. The caller is told how
// many were left out.
function rankForQuery(entries, query) {
  if (entries.length <= MAX_CATALOGUE) return { catalogue: entries, dropped: 0 };
  const terms = normalizeQuery(query).split(' ').filter((t) => t.length > 2);
  const scored = entries.map((e, i) => {
    const hay = `${e.file.name} ${e.desc}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += 1;
    return { e, score, i };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return { catalogue: scored.slice(0, MAX_CATALOGUE).map((s) => s.e), dropped: entries.length - MAX_CATALOGUE };
}

// Returns:
//   { matches: [{ file, why }], cached, indexed, dropped, coverage, usage }
// `cached: true` means the answer came from disk and no request was made.
// `onProgress({ done, total })` reports the indexing pass so the UI can show
// the one-time cost being paid down.
export async function aiSearchFiles({ query, files, projectName, signal, onProgress }) {
  const q = String(query || '').trim();
  if (!q || !files?.length) return { matches: [] };

  const byPath = new Map(files.map((f) => [f.path, f]));
  const signature = folderSignature(files);

  // Tier 1 — this exact question about this exact folder has been answered.
  const cachedHits = readAnswer(signature, q);
  if (cachedHits) {
    const matches = cachedHits.map((h) => ({ file: byPath.get(h.path), why: h.why })).filter((m) => m.file);
    return { matches, cached: true, coverage: indexCoverage(files) };
  }

  // Tier 2 — describe whatever isn't described yet. Usually nothing; on a
  // fresh folder this is the whole cost of the feature.
  const indexed = await indexFiles(files, { signal, onProgress });
  if (signal?.aborted) return { matches: [] };

  // Files that still have no description (indexing hit the per-run cap, or a
  // batch failed) go in on name + type alone rather than being dropped —
  // a name is a weak signal, but it's better than the file being invisible.
  const entries = files.map((file) => ({
    file,
    desc: describedText(file) || `${file.mimeType || 'file'} (not yet described)`,
  }));
  const { catalogue, dropped } = rankForQuery(entries, q);

  const listing = catalogue
    .map(({ file, desc }, i) => `${i + 1}. ${file.name}${file.mimeType ? ` (${file.mimeType})` : ''}\n   ${desc.replace(/\s+/g, ' ')}`)
    .join('\n');

  const res = await askProjectAi({
    messages: [{ role: 'user', content: `${SYSTEM}\n\nRequest: ${q}\n\nCatalogue:\n${listing}` }],
    projectName,
    model: MATCH_MODEL,
    // No tools: this is a one-shot classification, and a tool call here would
    // stall the search waiting for a turn that never comes.
    tools: false,
  });
  if (signal?.aborted) return { matches: [] };
  if (res.error) return { matches: [], error: res.error, indexed };

  const picked = parseMatches(res.text);
  const matches = [];
  for (const m of picked) {
    const hit = catalogue[Number(m?.n) - 1];
    if (!hit) continue;                                       // hallucinated index
    if (matches.some((x) => x.file === hit.file)) continue;   // deduped
    matches.push({ file: hit.file, why: String(m.why || '').slice(0, 120) });
  }

  writeAnswer(signature, q, matches.map((m) => ({ path: m.file.path, why: m.why })));
  return { matches, indexed, dropped, coverage: indexCoverage(files), usage: res.usage };
}

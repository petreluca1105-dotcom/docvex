// The destructive project-wide erasers behind the Settings tab's danger zone.
//
// Each one is deliberately narrow and separately confirmable, because they
// destroy different things and a firm needs to be able to reach for exactly
// one of them:
//
//   wipeProjectFiles      — the DOCUMENTS. Everything in the project's folder
//                           on this computer. Not recoverable through the app.
//   wipeProjectAiMemory   — what the AI has been told and what it worked out:
//                           the project's standing instructions, its file
//                           descriptions, its cached search answers, and the
//                           per-document advisor threads.
//   wipeProjectFileData   — what DocVex derived from the documents and kept
//                           on this machine: transcripts, OCR snippets,
//                           metadata snapshots, waveforms. The documents
//                           themselves are untouched.
//
// Everything except the ai_context row is local to this computer. Wiping on
// one machine doesn't wipe a teammate's copy — the callers say so, and it's
// why these are worded as "on this computer" rather than "everywhere".

import { supabase } from './supabaseClient';
import { localFolderApi } from './localFolder';
import { clearAiFileIndex } from './aiFileIndex';
import { clearAiSearchAnswers } from './aiSearchCache';
import { clearCachedChat } from './chatCache';
import { CAPTIONS_PREFIX } from './captionsHistory';
import { METADATA_PREFIX } from './metadataHistory';
import { OCR_HISTORY_PREFIX } from './extractionHistory';
import { CONVERSATION_PREFIX } from './conversationHistory';

// Per-file localStorage caches, all keyed `<prefix><absolute file path>`.
// (The envelope cache has no exported constant — its prefix is inlined here
// and in lib/audioEnvelopeCache.js; keep the two in step.)
const AUDIO_ENVELOPE_PREFIX = 'docvex:doc-viewer:envelope:';

const FILE_DATA_PREFIXES = [
  CAPTIONS_PREFIX,
  METADATA_PREFIX,
  OCR_HISTORY_PREFIX,
  AUDIO_ENVELOPE_PREFIX,
];

// Remove every localStorage entry whose key is one of `prefixes` + a path that
// sits inside `dir`. Collected first, then deleted — removing while iterating
// localStorage skips entries.
function purgeByPrefixUnder(prefixes, dir) {
  const root = String(dir || '').replace(/[\\/]+$/, '').toLowerCase();
  const doomed = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      const prefix = prefixes.find((p) => key.startsWith(p));
      if (!prefix) continue;
      // No folder given → the caller wants all of them.
      if (!root) { doomed.push(key); continue; }
      const path = key.slice(prefix.length).toLowerCase();
      if (path.startsWith(root)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch { /* storage unavailable — nothing to purge */ }
  return doomed.length;
}

// Delete every file and folder in the project's local folder, leaving the
// folder itself (and its .docvex.json sidecar) in place so the project stays
// connected. Returns { deleted, failed }.
export async function wipeProjectFiles(dir) {
  if (!dir) return { deleted: 0, failed: 0 };
  // localFolderApi.list returns the folder's immediate children split in two:
  // { files, dirs }.
  const { files = [], dirs = [], error } = await localFolderApi.list(dir);
  if (error) throw new Error(error);
  // Leave DocVex's own bookkeeping alone: the .docvex.json sidecar is what
  // keeps file identities stable across renames, and .docvex-trash has its
  // own purge.
  const keep = (e) => !String(e?.name || '').startsWith('.docvex');
  let deleted = 0;
  let failed = 0;
  for (const folder of dirs.filter(keep)) {
    try {
      const res = await localFolderApi.deleteFolder(folder.path);
      if (res?.error) failed += 1; else deleted += 1;
    } catch { failed += 1; }
  }
  const filePaths = files.filter(keep).map((f) => f.path);
  if (filePaths.length) {
    try {
      const res = await localFolderApi.deleteFiles(filePaths);
      if (res?.error) failed += filePaths.length; else deleted += filePaths.length;
    } catch { failed += filePaths.length; }
  }
  return { deleted, failed };
}

// Clear what the AI knows about this project. `dir` scopes the per-file caches
// to this project's folder; the index and answer caches are dropped wholesale
// (they're cheap to rebuild and shared across projects, so a partial wipe would
// be more surprising than a full one).
export async function wipeProjectAiMemory(projectId, dir, { clearContext = true } = {}) {
  const threads = purgeByPrefixUnder([CONVERSATION_PREFIX], dir);
  clearAiFileIndex();
  clearAiSearchAnswers();
  let contextCleared = false;
  if (clearContext && projectId) {
    // The standing instructions are server-side and shared with the team —
    // this is the one part of the wipe that isn't local to this computer.
    const { error } = await supabase
      .from('projects')
      .update({ ai_context: null, ai_context_updated_at: new Date().toISOString() })
      .eq('id', projectId);
    if (error) throw error;
    contextCleared = true;
  }
  return { threads, contextCleared };
}

// Clear everything DocVex derived FROM the files — transcripts, OCR snippets,
// metadata snapshots, waveforms — plus this project's cached chat. The files
// themselves are not touched.
export function wipeProjectFileData(projectId, dir) {
  const cleared = purgeByPrefixUnder(FILE_DATA_PREFIXES, dir);
  if (projectId) clearCachedChat(projectId);
  return { cleared };
}

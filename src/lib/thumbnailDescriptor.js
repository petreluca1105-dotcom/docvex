// Descriptor builders for the thumbnail system (lib/thumbnailEngine.js).
//
// A descriptor is the minimum the engine needs to decide what to paint:
//
//   {
//     name:       string,          // filename — drives type classification
//     mime:       string,          // MIME type, when the caller knows one
//     path:       string | null,   // on-disk path, or a 'web://…' pseudo-path
//     url:        string | null,   // a URL the caller already holds (blob:, http:)
//     contentKey: string,          // stable identity; changes when bytes change
//     bust:       string,          // cache-buster folded into localfile:// URLs
//     duration:   number | null,   // seconds, for the video duration pill
//   }
//
// `contentKey` keys the generated-thumbnail cache and the failure memo, so it
// must be stable across re-renders and must change when the file's bytes do.
// mtime is the practical signal for local files (a content hash would be
// better but costs a full read per file).
//
// Pre-migration-031 this module also built descriptors for cloud rows and
// change-request items. Both tables are gone (files are local-only now), so
// those builders were removed rather than left as dead code.

// ── A file in the user's local project folder ─────────────────────────────
//
// `localFile` is a local-folder listing entry: { name, path, mimeType, mtimeIso }.
// `localUrl` is optional — callers that already built a localfile:// URL can
// pass it, but the engine derives its own URLs from `path` anyway.
export function describeLocalFile({ localFile, localUrl = null } = {}) {
  if (!localFile) return null;
  const path = localFile.path || null;
  const bust = localFile.mtimeIso || '';
  return {
    name: localFile.name || '',
    mime: localFile.mimeType || '',
    path,
    url: localUrl || null,
    // Path + mtime: same file, same bytes → same key → one generation shared
    // by every surface showing it.
    contentKey: path ? `local:${path}:${bust}` : `local:${localFile.name || ''}:${bust}`,
    bust,
    duration: localFile.durationSeconds || null,
  };
}

// ── A file the caller only has loose facts about ──────────────────────────
//
// Backs the surfaces that pass individual props rather than a descriptor
// (the sidebar's open-documents list, the Activity feed, staged uploads).
// `url` may be a localfile:// URL, a blob: from a staged File, or an http(s):
// link; the engine recovers a disk path from the first form so those surfaces
// still get OS thumbnails.
export function describeLooseFile({ name = '', mime = '', url = null, path = null, duration = null } = {}) {
  if (!name && !url && !path) return null;
  const keyPart = path || url || name;
  return {
    name,
    mime,
    path,
    url,
    contentKey: keyPart ? `loose:${keyPart}` : '',
    bust: '',
    duration,
  };
}

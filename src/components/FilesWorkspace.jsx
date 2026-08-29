import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import FileThumbnail from './FileThumbnail';
import { ExtGlyph, extCategory } from './fileGlyph';
import Tooltip from './Tooltip';
import { useMorphPill } from './useMorphPill';
import { usePaneChromeSlot, usePaneChromePortalEl } from '../context/PaneChromeContext';
import { useAppPrefs } from '../context/AppPrefsContext';
import { useAuth } from '../context/AuthContext';
import { setDraggedFiles, clearDraggedFiles, getDraggedFiles } from '../lib/fileDragBus';
import { toLayoutPx } from '../lib/appZoom';
import { isSearchableFile, searchContents } from '../lib/fileContentSearch';
import { aiSearchFiles } from '../lib/aiFileSearch';
import { FOLDER_COLOR_PRESETS, loadFolderColors, persistFolderColors } from '../lib/folderColors';
import { miniHeaderSpot } from '../lib/miniHeaderSpot';
import MiniHeaderFade from './MiniHeaderFade';
import './FilesWorkspace.css';

// Platform hint for the search shortcut chip (⌘F on macOS, Ctrl F elsewhere).
const isMacPlatform = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || '');

// ── Dropped-folder traversal ───────────────────────────────────────────
// A plain `dataTransfer.files` read can't see inside a dropped folder — a
// directory only expands through the webkitGetAsEntry() FileSystem API.
// These helpers walk every dropped entry (files AND directory trees) and
// return a flat list of { file, relPath } so folder drops import with their
// nested structure intact (matching the <input webkitdirectory> path).
function readEntryFile(entry) {
  return new Promise((resolve) => entry.file((f) => resolve(f), () => resolve(null)));
}
function readAllDirEntries(reader) {
  // readEntries() yields at most ~100 entries per call — pump until empty.
  return new Promise((resolve) => {
    const all = [];
    const pump = () => reader.readEntries(
      (batch) => { if (!batch.length) { resolve(all); return; } all.push(...batch); pump(); },
      () => resolve(all),
    );
    pump();
  });
}
async function walkEntry(entry, prefix, out) {
  if (!entry) return;
  if (entry.isFile) {
    const f = await readEntryFile(entry);
    if (f) out.push({ file: f, relPath: prefix ? `${prefix}/${f.name}` : f.name });
  } else if (entry.isDirectory) {
    const dirPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    const children = await readAllDirEntries(entry.createReader());
    for (const child of children) await walkEntry(child, dirPrefix, out);
  }
}
// Resolve a drop's DataTransfer into [{ file, relPath }]. The entry objects
// must be grabbed synchronously (the item list is invalid after the event),
// so collect them up front, then traverse asynchronously.
async function collectDropEntries(dataTransfer) {
  const out = [];
  const items = dataTransfer?.items;
  if (items && items.length && typeof items[0]?.webkitGetAsEntry === 'function') {
    const entries = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind !== 'file') continue;
      const entry = items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    if (entries.length) {
      for (const entry of entries) await walkEntry(entry, '', out);
      return out;
    }
  }
  // Fallback (no entry API): plain files only — folders are unreadable here.
  const files = dataTransfer?.files;
  if (files) for (const f of files) out.push({ file: f, relPath: f.name });
  return out;
}

// Files tab — presentational File-Explorer workspace. All data and actions
// are supplied by the parent (ProjectFiles), which owns the local-folder
// logic; this component only paints:
//   window card → tab strip → toolbar → breadcrumb → tile/list canvas →
//   status bar.
//
// Two tabs (deliberately plain vocabulary):
//   • My drafts        — the files in your local project folder.
//   • Recently deleted — a recycle bin; deleted files wait here for 30 days
//                        then auto-delete. Each item shows a countdown pill.

// ── Inline icon set (Feather-style, currentColor) ─────────────────────
// Exported so surfaces that borrow the Files chrome — the Doc Viewer's
// fill-from-a-picture picker — draw from the SAME glyph set. A second copy
// would drift on the first icon either side changed.
export function Icon({ name, size = 16, strokeWidth = 1.8, className = '', filled = false }) {
  const p = {
    width: size, height: size, viewBox: '0 0 24 24', fill: filled ? 'currentColor' : 'none',
    stroke: 'currentColor', strokeWidth, strokeLinecap: 'round',
    strokeLinejoin: 'round', className, 'aria-hidden': 'true',
  };
  switch (name) {
    // A party to the case — used by "Add identity".
    case 'identity':
      return (
        <svg {...p}>
          <circle cx="12" cy="8" r="3.4" />
          <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
        </svg>
      );
    case 'folder': return <svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
    case 'edit-pen': return <svg {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
    case 'trash': return <svg {...p}><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /></svg>;
    case 'restore': return <svg {...p}><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>;
    case 'plus': return <svg {...p}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
    case 'upload': return <svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>;
    case 'search': return <svg {...p}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>;
    case 'chev-left': return <svg {...p}><polyline points="15 18 9 12 15 6" /></svg>;
    case 'chev-right': return <svg {...p}><polyline points="9 18 15 12 9 6" /></svg>;
    case 'chev-up': return <svg {...p}><polyline points="18 15 12 9 6 15" /></svg>;
    case 'chev-down': return <svg {...p}><polyline points="6 9 12 15 18 9" /></svg>;
    case 'home': return <svg {...p}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>;
    case 'close': return <svg {...p}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>;
    case 'inbox': return <svg {...p}><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>;
    case 'open': return <svg {...p}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>;
    case 'folder-plus': return <svg {...p}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" /></svg>;
    case 'select': return <svg {...p}><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>;
    case 'clock': return <svg {...p}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>;
    case 'undo': return <svg {...p}><polyline points="9 14 4 9 9 4" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" /></svg>;
    case 'redo': return <svg {...p}><polyline points="15 14 20 9 15 4" /><path d="M4 20v-7a4 4 0 0 1 4-4h12" /></svg>;
    case 'copy': return <svg {...p}><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>;
    case 'paste': return <svg {...p}><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" ry="1" /></svg>;
    case 'cut': return <svg {...p}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" /><line x1="8.12" y1="8.12" x2="12" y2="12" /></svg>;
    case 'refresh': return <svg {...p}><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>;
    case 'sparkles': return <svg {...p}><path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4z" /><path d="M5 15l.9 2.3L8 18l-2.1.7L5 21l-.9-2.3L2 18l2.1-.7z" /></svg>;
    case 'file-doc': return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="9" x2="10" y2="9" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="16" y2="17" /></svg>;
    case 'file-slides': return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><rect x="8" y="12" width="8" height="5" rx="1" /></svg>;
    case 'file-sheet': return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="16" x2="16" y2="16" /><line x1="12" y1="11" x2="12" y2="17" /></svg>;
    case 'file-pdf': return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><path d="M8.5 13.5h1a1 1 0 0 0 0-2h-1z" /><path d="M8.5 11.5v4" /><path d="M12.5 11.5v4h1a1.2 1.2 0 0 0 1.2-1.2v-1.6a1.2 1.2 0 0 0-1.2-1.2z" /></svg>;
    case 'categories': return <svg {...p}><rect x="3" y="3" width="18" height="6" rx="1.5" /><rect x="3" y="13" width="18" height="6" rx="1.5" /></svg>;
    case 'grid': return <svg {...p}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>;
    case 'list': return <svg {...p}><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>;
    case 'image': return <svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>;
    default: return null;
  }
}

// Folder icon. `filled` paints a solid folder — used when the folder has
// contents; the outline variant marks an empty folder at a glance.
function FolderGlyph({ filled = false, size = 42, color }) {
  return (
    <svg
      className={`fx-folder-glyph${filled ? ' is-filled' : ''}`}
      width={size} height={size} viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor" strokeWidth={filled ? 1 : 1.4}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      // A picked folder colour overrides the accent the CSS paints by default.
      style={color ? { color } : undefined}
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

// Generic document glyph — the new-file draft tile/row placeholder.
function GenericFileGlyph({ size = 42 }) {
  return (
    <svg
      className="fx-file-glyph"
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={1.4}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14 3 14 8 19 8" />
    </svg>
  );
}

// A FILLED trash can — shown for the Recycle bin entry when it holds at least
// one file, so a glance reads "the bin has something in it". The empty bin uses
// the outline trash icon instead.
function FullBinGlyph({ size = 42 }) {
  return (
    <svg className="fx-bin-full" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {/* handle */}
      <path d="M9.5 5V4.4A1.4 1.4 0 0 1 10.9 3h2.2A1.4 1.4 0 0 1 14.5 4.4V5"
        fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      {/* lid */}
      <rect x="3.4" y="5.2" width="17.2" height="2.1" rx="1.05" fill="currentColor" />
      {/* filled can body */}
      <path d="M5.6 8.4h12.8l-0.9 11.1A2 2 0 0 1 15.5 21.4H8.5a2 2 0 0 1-2-1.9z" fill="currentColor" />
    </svg>
  );
}

// Glyph for a folder-kind item: the Recycle bin entry gets the trash icon —
// FILLED when it holds files, outline when empty; a folder probed as a
// WhatsApp export (it CONTAINS a chat transcript — see isWhatsAppExport) gets
// the WhatsApp mark like the export zips do; every other folder gets the
// folder glyph (optionally a custom colour).
// Exported alongside ItemThumbnail: a surface borrowing the Files tiles needs
// the folder glyph too, or its folders come out as generic documents.
export function FolderOrBinGlyph({ item, size = 42, color }) {
  if (item.binEntry) {
    const s = Math.round(size * 0.92);
    const full = item.binCount > 0;
    return (
      <span className={`fx-bin-glyph${full ? ' is-full' : ''}`}>
        {full ? <FullBinGlyph size={s} /> : <Icon name="trash" size={s} strokeWidth={1.6} />}
      </span>
    );
  }
  if (item.isWhatsApp) {
    return (
      <WithWhatsAppBadge>
        <FolderGlyph filled={!item.empty} size={size} color={color} />
      </WithWhatsAppBadge>
    );
  }
  return <FolderGlyph filled={!item.empty} size={size} color={color} />;
}

// Swatch row shown at the top of a folder's right-click menu — pick a colour
// for the folder icon (or "Default" to clear it).
function FolderColorRow({ current, onPick }) {
  const active = current || null;
  return (
    <div className="fx-color-row" role="group" aria-label="Folder colour">
      {FOLDER_COLOR_PRESETS.map((c) => (
        <Tooltip key={c.id} content={c.label}>
          <button
            type="button"
            className={`fx-color-swatch${active === c.value ? ' is-active' : ''}${c.value ? '' : ' is-default'}`}
            style={c.value ? { '--sw': c.value } : undefined}
            aria-label={c.label}
            aria-pressed={active === c.value}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onPick(c.value); }}
          >
            {c.value ? null : <Icon name="close" size={12} strokeWidth={2} />}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

// Right-click menu header for a recognised WhatsApp export (and the folder
// colour-swatch row when it's an editable folder). Returns undefined when
// neither applies, so the menu has no header.
function whatsappMenuHeader(item, isFolder, canEdit, folderColor, onSetColor) {
  // Only the zip/loose-file exports get the WhatsApp header — never folders.
  const isWa = isWhatsAppExport(item) && !isFolder;
  const showColors = isFolder && !item.binEntry && canEdit;
  if (!isWa && !showColors) return undefined;
  return (closeMenu) => (
    <>
      {isWa && (
        <div className="fx-wa-menu-head">
          <span className="fx-wa-menu-head-mark">{WhatsAppMark}</span>
          <span className="fx-wa-menu-head-text">
            <span className="fx-wa-menu-head-title">WhatsApp chat export</span>
            <span className="fx-wa-menu-head-sub">Open to read the conversation</span>
          </span>
        </div>
      )}
      {showColors && (
        <FolderColorRow current={folderColor} onPick={(v) => { onSetColor?.(item.id, v); closeMenu(); }} />
      )}
    </>
  );
}

const STATUS_LABEL = { deleted: 'In bin', synced: '' };

// Tile-zoom bounds (px, the grid's min column width). Below the threshold
// the tile grid gives way to the list view. The threshold is also the
// DEFAULT tile size — i.e. tiles start at the smallest size before the list
// view kicks in, and Ctrl+scroll zooms up from there.
// Slider floor. Raised one step (was 68) to drop the smallest/most-cramped
// notch from the icon-size slider.
const FX_MIN_TILE = 70;
const FX_MAX_TILE = 320;
// Below this the tile grid gives way to the list view. Raised by 2 slider steps
// (4px) so the list view spans two extra notches at its large end (see
// listRowVars — those top steps grow the rows more aggressively).
const FX_LIST_THRESHOLD = 100;

// Toolbar "Categorize" view — when on, items are grouped into these coarse
// buckets, each rendered as its own labelled section (in this order). Keep in
// sync with `itemCat` in FilesWorkspace. Sections with no items are skipped.
const FX_GROUPS = [
  { key: 'trash', label: 'Trash', icon: 'trash' },
  { key: 'folders', label: 'Folders & compressed folders', icon: 'folder' },
  { key: 'media', label: 'Media', icon: 'image' },
  { key: 'office', label: 'Office documents', icon: 'file-doc' },
  { key: 'other', label: 'Other files', icon: 'inbox' },
];

// extCategory + ExtGlyph moved to fileGlyph.jsx — they're the app's ONE
// file-icon style now, shared with the sidebar / Activity / project list via
// glyphForFile(). Imported at the top of this file.

// A WhatsApp "Export chat" produces a .zip — or, extracted, a folder —
// holding the transcript + media. ProjectFiles probes the CONTENTS in the
// main process and stamps `item.isWhatsApp` (true/false), so recognition
// survives a rename. Items that can't be probed (cloud rows, web build,
// probe still in flight) leave the flag undefined and fall back to the old
// filename heuristic.
function isWhatsAppExport(item) {
  if (item?.isWhatsApp !== undefined) return item.isWhatsApp === true;
  return item?.ext === 'zip' && /whatsapp/i.test(item?.name || '');
}

const WhatsAppMark = (
  <svg className="fx-glyph-wa-logo" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2a10 10 0 0 0-8.6 15l-1.3 4.8 4.9-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-2.9.8.8-2.8-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.6-6.1c-.3-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-2-1.2 7.4 7.4 0 0 1-1.4-1.7c-.1-.3 0-.4.1-.5l.4-.5.3-.4v-.4l-.8-1.9c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 2.9 2.9 0 0 0-.9 2.2 5 5 0 0 0 1.1 2.7 11.5 11.5 0 0 0 4.4 3.9c2.6 1 2.6.7 3.1.6a2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .1-1.2c-.1-.1-.3-.2-.5-.3z" />
  </svg>
);

// Recognised WhatsApp conversation (a .zip export, a loose exported .txt, …) —
// shows ONLY the WhatsApp logo on its brand green (no zip/type icon, no morph),
// so the file reads as a WhatsApp conversation at a glance. See .fx-glyph-whatsapp.
function WhatsAppMorphGlyph() {
  return (
    <span className="fx-glyph fx-glyph-icon fx-glyph-whatsapp">
      {WhatsAppMark}
    </span>
  );
}

// Previously wrapped a recognised WhatsApp file/folder glyph with a persistent
// green corner pill. The pill was removed per request — recognition still drives
// the hover tooltip, right-click header, and "open conversation" action, but the
// glyph itself is no longer marked. Kept as a pass-through so the call sites
// (file + folder glyphs) don't need to branch.
function WithWhatsAppBadge({ children }) {
  return <>{children}</>;
}

// Resolve a file's fallback glyph: the WhatsApp mark for recognised export
// zips, otherwise the extension badge. Exported — the doc-viewer's open-files
// sidebar renders its tiles with the same glyph so both surfaces match.
export function ItemGlyph({ item }) {
  // Anything recognised as a WhatsApp conversation (a .zip export, a loose
  // exported .txt, etc.) uses the same vertical-push glyph: a zipped folder at
  // rest that slides up on hover to reveal the WhatsApp logo from below.
  if (isWhatsAppExport(item)) return <WhatsAppMorphGlyph />;
  return <ExtGlyph ext={item.ext} />;
}

// Real file thumbnail (poster / video slideshow / type glyph). Video files get
// a centred play button layered over the poster so they read as playable at a
// glance — in both tile and list views (it's %-sized off the thumb). The badge
// is CSS-hidden when no real poster resolved (the type-glyph badge — which
// already shows its own play triangle — is showing). See .fx-video-play in
// FilesWorkspace.css.
export function ItemThumbnail({ item }) {
  const isVideo = extCategory(item.ext) === 'vid';
  return (
    <>
      <FileThumbnail descriptor={item.descriptor} glyph={<ItemGlyph item={item} />} />
      {/* Extension pill — CSS reveals it only when the tile fell back to the
          GENERIC document glyph (no thumbnail and no type icon of its own), so
          an unknown format still says what it is. */}
      {item.ext ? <span className="fx-ext-pill" aria-hidden="true">{String(item.ext).toUpperCase()}</span> : null}
      {isVideo ? (
        <span className="fx-video-play" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.78-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z" fill="currentColor" />
          </svg>
        </span>
      ) : null}
    </>
  );
}

// Countdown pill for a bin item — "Deletes in N days" (turns red near the
// end of the 30-day retention). Driven by item.deletesInDays.
function CountdownPill({ days, className = '' }) {
  if (days === null || days === undefined) return null;
  const label = days <= 0 ? 'Deletes today' : `Deletes in ${days} ${days === 1 ? 'day' : 'days'}`;
  const urgent = days <= 3;
  return (
    <Tooltip content={label}>
      <span className={`fx-countdown-pill${urgent ? ' is-urgent' : ''} ${className}`.trim()}>
        <Icon name="clock" size={11} />
        <span>{label}</span>
      </span>
    </Tooltip>
  );
}

// Circular progress for a trashed item: the ring fills with ELAPSED time over
// the 30-day retention, with the days-left number in the centre. Turns red in
// the final stretch. Driven by item.deletesInDays.
function CountdownRing({ days, total = 30, size = 34, className = '' }) {
  if (days === null || days === undefined) return null;
  const left = Math.max(0, days);
  const elapsed = Math.min(1, Math.max(0, (total - left) / total));
  const urgent = left <= 3;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className={`fx-countdown-ring${urgent ? ' is-urgent' : ''} ${className}`.trim()} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - elapsed)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
    </span>
  );
}

// Short "time remaining" label for a trashed item.
function countdownLabel(days) {
  if (days === null || days === undefined) return '';
  if (days <= 0) return 'Deletes today';
  return `${days} ${days === 1 ? 'day' : 'days'} left`;
}

// Hover-tooltip content for a trashed item: a time-remaining chip (bg matches
// the urgency of the countdown ring) followed by the file name.
function trashHoverContent(item) {
  const days = item.deletesInDays;
  const urgent = (days ?? 99) <= 3;
  return (
    <span className="fx-hover-rich">
      <span className={`fx-hover-countdown${urgent ? ' is-urgent' : ''}`}>{countdownLabel(days)}</span>
      <span className="fx-hover-name">{item.name}</span>
    </span>
  );
}

// (The rich WhatsApp hover pill — badge + "recognised as WhatsApp convo"
// note — was removed; WhatsApp files show the standard name pill like every
// other file. The right-click MENU header keeps its WhatsApp treatment via
// whatsappMenuHeader.)

// Right-click menu for a file / folder item. Tab-aware: in the bin, items
// offer Restore + Delete forever; in drafts, the usual Open / Rename /
// Properties / Open-file-location / Delete. Falsy entries collapse via
// useMorphPill's filter.
function itemMenuItems(item, { tab, onOpen, onOpenContent, onRename, onProperties, onOpenLocation, onDelete, onRestore, onEmptyBin, canEdit, selectMode, isMultiSelected, bulkCount, onBulkDelete, onCopy, onCut }) {
  // The Recycle bin entry opens the bin; when it holds files it can also be
  // emptied (permanent delete of everything inside).
  if (item.binEntry) {
    // The Trash entry's menu is intentionally just two actions: open it, or
    // empty it (the latter only when it actually holds something).
    const entries = [{ key: 'open', label: 'Open', onClick: () => onOpen?.(item) }];
    if (item.binCount > 0) {
      entries.push({
        key: 'empty',
        label: 'Empty',
        danger: true,
        onClick: () => onEmptyBin?.(),
        confirm: {
          count: item.binCount,
          subtitle: 'Permanent · can’t be undone',
          title: `Delete ${item.binCount} file${item.binCount === 1 ? '' : 's'}?`,
          message: `${item.binCount} item${item.binCount === 1 ? '' : 's'} in the trash will be permanently deleted — this can’t be undone.`,
          confirmLabel: 'Empty trash',
          cancelLabel: 'Cancel',
        },
      });
    }
    return entries;
  }
  const isFolder = item.kind === 'folder';
  const isBin = tab === 'trash';
  const localPath = isFolder ? item._dir?.path : item._raw?.path;
  const bulk = Boolean(isMultiSelected && bulkCount > 1);
  const subject = bulk ? `${bulkCount} items` : (isFolder ? `“${item.name}” and everything inside it` : `“${item.name}”`);

  if (isBin) {
    // Bin items: open (read in place), restore to the folder, or delete forever.
    return [
      { key: 'open', label: 'Open', onClick: () => onOpen?.(item) },
      { key: 'restore', label: 'Restore', onClick: () => onRestore?.(item) },
      {
        key: 'delete', label: bulk ? `Delete ${bulkCount} forever` : 'Delete forever', danger: true,
        onClick: () => (bulk ? onBulkDelete?.() : onDelete?.(item)),
        confirm: {
          count: bulk ? bulkCount : 1,
          subtitle: 'Permanent · can’t be undone',
          title: bulk ? `Permanently delete ${bulkCount} items?` : 'Permanently delete this file?',
          message: `${subject} will be permanently deleted from your computer. This can’t be undone.`,
          confirmLabel: bulk ? `Delete ${bulkCount}` : 'Delete forever',
          cancelLabel: 'Cancel',
        },
      },
    ];
  }

  const deleteEntry = canEdit && {
    key: 'delete',
    label: bulk ? `Delete ${bulkCount} items` : (isFolder ? 'Delete folder' : 'Delete'),
    danger: true,
    onClick: () => (bulk ? onBulkDelete?.() : onDelete?.(item)),
    confirm: {
      count: bulk ? bulkCount : 1,
      subtitle: isFolder ? 'Removed from your computer' : 'Recoverable for 30 days',
      title: bulk ? `Delete ${bulkCount} items?` : (isFolder ? 'Delete this folder?' : 'Delete this file?'),
      message: isFolder
        ? `${subject} will be deleted from your computer.`
        : `${subject} will be moved to the Trash. It stays recoverable for 30 days.`,
      confirmLabel: bulk ? `Delete ${bulkCount}` : 'Delete',
      cancelLabel: 'Cancel',
    },
  };

  if (isFolder) {
    return [
      { key: 'open', label: 'Open', onClick: () => onOpen?.(item) },
      // "Open" now browses any folder; a WhatsApp export's reconstructed
      // conversation moves to this dedicated entry.
      item.isWhatsApp && { key: 'open-content', label: 'Open conversation', onClick: () => onOpenContent?.(item) },
      !bulk && canEdit && localPath && { key: 'rename', label: 'Rename', onClick: () => onRename?.(item) },
      localPath && { key: 'loc', label: 'Open file location', onClick: () => onOpenLocation?.(item) },
      deleteEntry,
    ];
  }
  const isArchive = extCategory(item.ext) === 'zip';
  return [
    { key: 'open',   label: 'Open',               onClick: () => onOpen?.(item) },
    // A compressed file can be unpacked and browsed in place (zip extracts to a
    // sibling folder; other formats open in the OS archiver).
    isArchive && { key: 'open-content', label: 'Extract contents', onClick: () => onOpenContent?.(item) },
    !bulk && canEdit && { key: 'rename', label: 'Rename',  onClick: () => onRename?.(item) },
    canEdit && onCopy && { key: 'copy', label: bulk ? `Copy ${bulkCount} items` : 'Copy', onClick: () => onCopy?.(item) },
    canEdit && onCut && { key: 'cut', label: bulk ? `Cut ${bulkCount} items` : 'Cut', onClick: () => onCut?.(item) },
    { key: 'props',  label: 'Properties',         onClick: () => onProperties?.(item) },
    localPath && { key: 'loc', label: 'Open file location', onClick: () => onOpenLocation?.(item) },
    deleteEntry,
  ];
}

// Files show their name like Explorer's "hide extensions" mode: the label under
// the icon is just the base name, and a rename edits only the base — the
// extension is re-attached on commit so the file format is never changed by
// accident. Folders have no extension. `ext` keeps its leading dot.
function splitNameExt(name) {
  const n = String(name || '');
  const i = n.lastIndexOf('.');
  // No dot, a leading-dot dotfile (".gitignore"), or a trailing dot → no ext.
  if (i <= 0 || i === n.length - 1) return { base: n, ext: '' };
  return { base: n.slice(0, i), ext: n.slice(i) };
}
function displayBaseName(item) {
  if (!item || item.kind === 'folder') return item?.name || '';
  return splitNameExt(item.name).base || item.name;
}
function joinBaseExt(base, originalName) {
  const { ext } = splitNameExt(originalName);
  const b = String(base || '').trim();
  if (!ext) return b;
  return b.toLowerCase().endsWith(ext.toLowerCase()) ? b : b + ext;
}
// The new name to commit from a rename input — folders pass through, files get
// their original extension re-attached.
function renamedName(item, typed) {
  return item.kind === 'folder' ? typed : joinBaseExt(typed, item.name);
}

// ── Inline name input (rename + new-folder draft) ─────────────────────
function InlineNameInput({ initial = '', placeholder, onCommit, onCancel, className = '', selectBaseName = false }) {
  const [value, setValue] = useState(initial);
  const ref = useRef(null);
  const doneRef = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // For a named file, pre-select just the base name (before the extension) so
    // typing replaces the name but keeps the ".docx" the user chose.
    const dot = selectBaseName ? initial.lastIndexOf('.') : -1;
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, []);
  const finish = (fn) => { if (doneRef.current) return; doneRef.current = true; fn(); };
  const commit = () => finish(() => {
    const v = value.trim();
    if (v) onCommit(v); else onCancel();
  });
  const cancel = () => finish(() => onCancel());
  return (
    <input
      ref={ref}
      className={`fx-inline-input ${className}`}
      type="text"
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      }}
      onBlur={commit}
    />
  );
}

// ── Tile ──────────────────────────────────────────────────────────────
function Tile({ item, tab, selected, onSelect, onOpen, onOpenContent, onRename, onProperties, onOpenLocation, onDelete, onRestore, onEmptyBin, canEdit, selectMode, isMultiSelected, bulkCount, onBulkDelete, onCopy, onCut, renaming, onCommitName, onCancelName, draggable, beginItemDrag, endItemDrag, onFolderDragOver, onFolderDragLeave, onFolderDrop, dropFolderId, cutPaths, folderColors, onSetColor }) {
  const isFolder = item.kind === 'folder';
  const status = item.status || 'synced';
  const isDropTarget = isFolder && dropFolderId === item.id;
  const isBinDrop = item.binEntry && isDropTarget;
  const isCut = !isFolder && cutPaths?.has(item._raw?.path);
  const folderColor = isFolder && !item.binEntry ? folderColors?.[item.id] : undefined;
  const morph = useMorphPill({
    // WhatsApp files use the SAME plain name pill as every other file (the
    // old rich "recognised as WhatsApp convo" hover pill was removed).
    hoverContent: tab === 'trash' && !item.binEntry ? trashHoverContent(item) : item.name,
    menuItems: itemMenuItems(item, { tab, onOpen, onOpenContent, onRename, onProperties, onOpenLocation, onDelete, onRestore, onEmptyBin, canEdit, selectMode, isMultiSelected, bulkCount, onBulkDelete, onCopy: isFolder ? null : onCopy, onCut: isFolder ? null : onCut }),
    // WhatsApp exports get a "recognised as WhatsApp convo" header; folders get
    // a colour-swatch row atop their menu (both shown if it's a WhatsApp folder).
    menuHeader: whatsappMenuHeader(item, isFolder, canEdit, folderColor, onSetColor),
  });
  if (renaming) {
    return (
      <div className={`fx-tile${isFolder ? ' is-folder' : ''} is-renaming`}>
        <span className="fx-tile-thumb">
          {isFolder ? <FolderGlyph filled={!item.empty} color={folderColor} /> : <ItemThumbnail item={item} />}
        </span>
        <span>
          <InlineNameInput className="fx-tile-name" initial={displayBaseName(item)} onCommit={(name) => onCommitName(renamedName(item, name))} onCancel={onCancelName} />
        </span>
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        data-fx-id={item.id}
        className={`fx-tile${isFolder ? ' is-folder' : ''}${selected ? ' is-selected' : ''}${status === 'deleted' ? ' is-deleted' : ''}${isDropTarget ? ' is-droptarget' : ''}${isBinDrop ? ' is-bindrop' : ''}${isCut ? ' is-cut' : ''}`}
        onClick={(e) => onSelect(item, e)}
        onDoubleClick={(e) => onOpen(item, e)}
        onMouseMove={morph.handleMouseMove}
        onMouseLeave={morph.handleMouseLeave}
        onContextMenu={(e) => { e.stopPropagation(); morph.handleContextMenu(e); }}
        draggable={draggable && !item.binEntry ? true : undefined}
        onDragStart={draggable && !item.binEntry ? (e) => beginItemDrag?.(item, e) : undefined}
        onDragEnd={draggable && !item.binEntry ? () => endItemDrag?.() : undefined}
        onDragOver={isFolder ? (e) => onFolderDragOver?.(item, e) : undefined}
        onDragLeave={isFolder ? () => onFolderDragLeave?.(item) : undefined}
        onDrop={isFolder ? (e) => onFolderDrop?.(item, e) : undefined}
      >
        {/* Bin items show a circular elapsed-time countdown; drafts carry no ribbon. */}
        {tab === 'trash' && <CountdownRing days={item.deletesInDays} size={20} className="fx-tile-countdown" />}
        <span className="fx-tile-thumb">
          {isFolder ? <FolderOrBinGlyph item={item} color={folderColor} /> : <ItemThumbnail item={item} />}
        </span>
        <span>
          <span className="fx-tile-name">
            {displayBaseName(item)}
            {/* The Recycle bin entry shows how many items are inside —
                inline, right of the label (not a corner badge). */}
            {item.binEntry && item.binCount > 0 && <span className="fx-bin-count is-inline">{item.binCount}</span>}
          </span>
        </span>
      </button>
      {morph.node}
    </>
  );
}

// New-folder draft tile — a folder placeholder whose name is an inline input.
function NewFolderTile({ onCommit, onCancel }) {
  return (
    <div className="fx-tile is-folder is-renaming">
      <span className="fx-tile-thumb"><FolderGlyph filled={false} /></span>
      <span>
        <InlineNameInput className="fx-tile-name" placeholder="new folder" onCommit={onCommit} onCancel={onCancel} />
      </span>
    </div>
  );
}

// New-file draft tile — a generic-file placeholder whose name (with extension,
// e.g. "Proposal.docx") is an inline input. The input pre-selects the base name
// so you can type a new name right away.
function NewFileTile({ onCommit, onCancel }) {
  return (
    <div className="fx-tile is-renaming">
      <span className="fx-tile-thumb"><GenericFileGlyph /></span>
      <span>
        <InlineNameInput className="fx-tile-name" initial="Untitled" selectBaseName placeholder="new file" onCommit={onCommit} onCancel={onCancel} />
      </span>
    </div>
  );
}

// ── List row ──────────────────────────────────────────────────────────
function Row({ item, tab, selected, onSelect, onOpen, onOpenContent, onRename, onProperties, onOpenLocation, onDelete, onRestore, onEmptyBin, canEdit, selectMode, isMultiSelected, bulkCount, onBulkDelete, onCopy, onCut, renaming, onCommitName, onCancelName, draggable, beginItemDrag, endItemDrag, onFolderDragOver, onFolderDragLeave, onFolderDrop, dropFolderId, cutPaths, folderColors, onSetColor }) {
  const isFolder = item.kind === 'folder';
  const status = item.status || 'synced';
  const isBin = tab === 'trash';
  const isDropTarget = isFolder && dropFolderId === item.id;
  const isBinDrop = item.binEntry && isDropTarget;
  const isCut = !isFolder && cutPaths?.has(item._raw?.path);
  const folderColor = isFolder && !item.binEntry ? folderColors?.[item.id] : undefined;
  const morph = useMorphPill({
    // WhatsApp files use the SAME plain name pill as every other file.
    hoverContent: isBin && !item.binEntry ? trashHoverContent(item) : item.name,
    menuItems: itemMenuItems(item, { tab, onOpen, onOpenContent, onRename, onProperties, onOpenLocation, onDelete, onRestore, onEmptyBin, canEdit, selectMode, isMultiSelected, bulkCount, onBulkDelete, onCopy: isFolder ? null : onCopy, onCut: isFolder ? null : onCut }),
    menuHeader: whatsappMenuHeader(item, isFolder, canEdit, folderColor, onSetColor),
  });
  if (renaming) {
    return (
      <div className="fx-list-row is-renaming">
        <span className="fx-list-name">
          <span className="fx-list-thumb">
            {isFolder ? <FolderGlyph filled={!item.empty} size={20} color={folderColor} /> : <ItemThumbnail item={item} />}
          </span>
          <InlineNameInput className="fx-name" initial={displayBaseName(item)} onCommit={(name) => onCommitName(renamedName(item, name))} onCancel={onCancelName} />
        </span>
        <span /><span /><span />
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        data-fx-id={item.id}
        className={`fx-list-row${isBin ? ' is-bin' : ''}${selected ? ' is-selected' : ''}${status === 'deleted' ? ' is-deleted' : ''}${isDropTarget ? ' is-droptarget' : ''}${isBinDrop ? ' is-bindrop' : ''}${isCut ? ' is-cut' : ''}`}
        onClick={(e) => onSelect(item, e)}
        onDoubleClick={(e) => onOpen(item, e)}
        onMouseMove={morph.handleMouseMove}
        onMouseLeave={morph.handleMouseLeave}
        onContextMenu={(e) => { e.stopPropagation(); morph.handleContextMenu(e); }}
        draggable={draggable && !item.binEntry ? true : undefined}
        onDragStart={draggable && !item.binEntry ? (e) => beginItemDrag?.(item, e) : undefined}
        onDragEnd={draggable && !item.binEntry ? () => endItemDrag?.() : undefined}
        onDragOver={isFolder ? (e) => onFolderDragOver?.(item, e) : undefined}
        onDragLeave={isFolder ? () => onFolderDragLeave?.(item) : undefined}
        onDrop={isFolder ? (e) => onFolderDrop?.(item, e) : undefined}
      >
        <span className="fx-list-name">
          {isBin && <CountdownRing days={item.deletesInDays} size={18} className="fx-row-countdown" />}
          <span className="fx-list-thumb">
            {isFolder ? <FolderOrBinGlyph item={item} size={20} color={folderColor} /> : <ItemThumbnail item={item} />}
          </span>
          <span className="fx-name">
            {displayBaseName(item)}
            {/* Bin count pill INSIDE the name span so it hugs the label text
                (the span stretches flex:1 — a sibling pill would be pushed to
                the column's far edge, next to the Date column). */}
            {item.binEntry && item.binCount > 0 && <span className="fx-bin-count is-inline">{item.binCount}</span>}
          </span>
        </span>
        <span className="fx-list-muted">{item.modifiedLabel || '—'}</span>
        <span className="fx-list-muted">{item.binEntry ? 'Trash' : isFolder ? 'Folder' : (item.ext ? item.ext.toUpperCase() : 'File')}</span>
        <span className="fx-list-muted">{item.sizeLabel || '—'}</span>
      </button>
      {morph.node}
    </>
  );
}

// New-folder draft row — a folder placeholder whose name is an inline input.
function NewFolderRow({ onCommit, onCancel }) {
  return (
    <div className="fx-list-row is-renaming">
      <span className="fx-list-name">
        <span className="fx-list-thumb"><FolderGlyph filled={false} size={20} /></span>
        <InlineNameInput className="fx-name" placeholder="new folder" onCommit={onCommit} onCancel={onCancel} />
      </span>
      <span /><span /><span />
    </div>
  );
}

// New-file draft row — a file placeholder whose name (with extension) is an
// inline input.
function NewFileRow({ onCommit, onCancel }) {
  return (
    <div className="fx-list-row is-renaming">
      <span className="fx-list-name">
        <span className="fx-list-thumb"><GenericFileGlyph size={20} /></span>
        <InlineNameInput className="fx-name" initial="Untitled" selectBaseName placeholder="new file" onCommit={onCommit} onCancel={onCancel} />
      </span>
      <span /><span /><span />
    </div>
  );
}

// ── Main workspace ────────────────────────────────────────────────────
export default function FilesWorkspace({
  projectId,
  // Versions-style hero for the top of the canvas: { eyebrow, access, title,
  // kicker }. Scrolls away with the file grid; a compact bar fades in once it's
  // past. Null hides both (e.g. the recycle-bin tab).
  masthead,
  summaryText,
  // In-panel mode: 'drafts' (the project folder) or 'trash' (the recycle bin,
  // entered by opening the bin folder). There is no tab strip — one panel.
  tab,
  canEdit,
  hasLocalFolder,
  onPickFolder,      // web only — Electron auto-binds the project directory
  hasLocalFolderApi,
  folderError,       // Electron — project-directory resolution failed
  onRetryFolder,
  // folder navigation
  crumbs,            // [{ label, path }] — last is current
  onCrumb,           // (path) => void
  onBack, onUp, canBack, canUp,
  // data for the active mode
  folders,           // folder items (drafts only; includes the Recycle bin entry)
  items,             // file items
  loading,
  renameTargetPath,       // path of a just-created file to auto-select + rename
  onRenameTargetConsumed, // () => void — clear the request once it's applied
  selectTargetPath,       // path of a just-created file/FOLDER to auto-select (no rename)
  onSelectTargetConsumed, // () => void — clear the request once it's applied
  // actions
  onOpen, onOpenContent, onRename, onDelete, onRestore, onNewFolder, onNewFile, onCreateTypedFile, onAddIdentity, onUpload, onUploadFolder, onOpenLocation,
  onEmptyBin,
  onRefresh,         // () => void — re-list the folder (toolbar refresh button)
  onDebugSeedTrash,  // DEV-only — seed the bin with staggered-expiry dummy items
  onOpenDirectory,   // () => void — open the current folder in the OS file manager
  onDropFiles,       // ([{ file, relPath }]) => void — drag-and-drop import,
                     //   folders included (relPath carries nested structure)
  onPasteItems,      // (items) => void — paste COPIED files into the current folder
  onPasteCut,        // (items) => void — paste CUT files (move) into the current folder
  onMoveItems,       // (items, targetFolder) => void — drag files onto a folder to move
  onMoveToCrumb,     // (crumb, items) => void — drag files onto a breadcrumb folder to move
  // undo / redo (footer)
  onUndo, onRedo, canUndo, canRedo, undoLabel, redoLabel,
}) {
  const isBin = tab === 'trash';
  // Tile zoom — driven by Ctrl+scroll over the canvas. Zoom out far enough
  // and the grid collapses into the list view; zoom back in and the tiles
  // return. The INITIAL view honors Settings → "Default file view": 'list'
  // seeds the zoomed-out (list) size, 'grid' the default tile size.
  const { prefs: appPrefs } = useAppPrefs();
  // Per-user persistence of the view controls (icon-size slider + categorize
  // toggle) so they survive leaving and re-entering the Files tab. Falls back to
  // the Settings "Default file view" for the size, ungrouped for categorize.
  const { session } = useAuth();
  const viewPrefsKey = `docvex.filesView.${session?.user?.id || '_anon'}`;
  const savedViewPrefs = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(viewPrefsKey) || 'null') || {}; }
    catch { return {}; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewPrefsKey]);
  const [tileSize, setTileSize] = useState(() => (
    typeof savedViewPrefs.tileSize === 'number'
      ? Math.max(FX_MIN_TILE, Math.min(FX_MAX_TILE, savedViewPrefs.tileSize))
      : (appPrefs.fileView === 'list' ? FX_MIN_TILE : FX_LIST_THRESHOLD)
  ));
  const view = tileSize < FX_LIST_THRESHOLD ? 'list' : 'tiles';
  // List-view row density follows the slider. The standard range grows gently;
  // the TOP TWO steps (the two notches just below the tile threshold) bump up
  // much harder so they read as a distinct "large" list size. Published as CSS
  // vars on the canvas and consumed by .fx-list-row / .fx-list-thumb.
  const listRowVars = useMemo(() => {
    if (view !== 'list') return null;
    const idx = Math.round((tileSize - FX_MIN_TILE) / 2);            // 0 … top
    const topIdx = Math.round((FX_LIST_THRESHOLD - 2 - FX_MIN_TILE) / 2);
    const fromTop = topIdx - idx;                                    // 0 = largest step
    // Only the thumbnail icon + row height scale with the slider — the file-name
    // text stays a fixed size (see .fx-list-row font-size).
    let thumb = 19 + idx * 0.7;
    let pad = 4.5 + idx * 0.25;
    if (fromTop === 1) { thumb += 5; pad += 1.8; }
    if (fromTop === 0) { thumb += 12; pad += 4; }
    return {
      '--fx-row-thumb': `${thumb}px`,
      '--fx-row-pad': `${pad}px`,
    };
  }, [view, tileSize]);
  const [query, setQuery] = useState('');
  // Selection — `multiSel` (a Set of ids) is the single source of truth.
  // Plain click selects one; Ctrl/Cmd+click toggles; Shift+click extends a
  // range from the anchor. The "Select" button (selectMode) makes plain
  // clicks additive for mouse-only / touch use. `anchorId` is the pivot for
  // Shift-range selection.
  const [multiSel, setMultiSel] = useState(() => new Set());
  const [anchorId, setAnchorId] = useState(null);
  const [selectMode, setSelectMode] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  // "Categorize" toolbar toggle — when on, the flat grid/list is split into
  // labelled category sections (folders incl. compressed archives, pictures &
  // videos, Office docs, the Recycle bin, then everything else) stacked
  // vertically. Off → one flat list (the default).
  const [grouped, setGrouped] = useState(() => savedViewPrefs.grouped === true);
  // Persist the view controls whenever they change (debounced naturally by React
  // batching) so the next visit to Files restores the same size + categorize state.
  useEffect(() => {
    try { localStorage.setItem(viewPrefsKey, JSON.stringify({ tileSize, grouped })); }
    catch { /* storage full / blocked — non-critical */ }
  }, [viewPrefsKey, tileSize, grouped]);
  const [propsItem, setPropsItem] = useState(null);
  // Pointer-anchored "this is a compressed file" prompt — { item, x, y } in
  // viewport px (null coords = no pointer, e.g. opened with Enter → centred).
  const [archivePrompt, setArchivePrompt] = useState(null);
  const [dragOver, setDragOver] = useState(false);   // OS file drag over the canvas
  const [clipboard, setClipboard] = useState(null);  // { mode: 'copy'|'cut', items: [{ name, path }] }
  const [dropFolderId, setDropFolderId] = useState(null); // folder hovered during a move drag
  const [dropCrumb, setDropCrumb] = useState(null);  // breadcrumb path hovered during a move drag
  // Masthead scroll-away: true once the canvas has scrolled past the hero, which
  // collapses the full masthead and reveals the compact mini header. Hysteresis
  // (collapse past 36px, expand under 10px) avoids flicker at the threshold.
  const [headerScrolled, setHeaderScrolled] = useState(false);
  // Per-folder icon colour (localStorage-backed, keyed by project + folder id).
  const [folderColors, setFolderColors] = useState(() => loadFolderColors(projectId));
  useEffect(() => { setFolderColors(loadFolderColors(projectId)); }, [projectId]);
  const setFolderColor = (folderId, value) => {
    setFolderColors((cur) => {
      const next = { ...cur };
      if (value) next[folderId] = value; else delete next[folderId];
      persistFolderColors(projectId, next);
      return next;
    });
  };
  const createMenuRef = useRef(null);
  const canvasRef = useRef(null);
  const pageRef = useRef(null);   // root, used to scope shortcuts to this pane
  const searchRef = useRef(null);
  const actionsRef = useRef({});  // latest copy/paste handlers for the key listener
  const kbdRef = useRef({});      // latest selection/nav handlers for the key listener

  // Watch the PAGE scroll position to drive the masthead scroll-away (the whole
  // Files page scrolls as one, like the other personal tabs — the sticky nav
  // strip then carries the title once the hero scrolls off). Falls back to the
  // canvas scroller if the page scroller isn't found (e.g. embedded contexts).
  const pageScroller = () => pageRef.current?.closest('.sv-single-scroll') || canvasRef.current;
  useEffect(() => {
    const el = pageScroller();
    if (!el || !masthead) { setHeaderScrolled(false); return undefined; }
    const onScroll = () => {
      // Pinned only once the pathbar is ACTUALLY stuck at the top (its rect
      // reaches the scroller's top + the sticky `top` gap), so the section bg
      // doesn't appear early while the masthead is still scrolling away.
      const bar = el.querySelector('.fx-pathbar');
      setHeaderScrolled(!!bar && (bar.getBoundingClientRect().top - el.getBoundingClientRect().top) <= 8);
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [masthead, hasLocalFolder, loading, view]);
  const scrollToTop = () => pageScroller()?.scrollTo({ top: 0, behavior: 'smooth' });

  // Inline name editing (Electron has no window.prompt).
  const [renamingId, setRenamingId] = useState(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);
  const requestRename = (item) => { if (item) { setCreatingFolder(false); setCreatingFile(false); setRenamingId(item.id); } };
  const requestNewFolder = () => { setRenamingId(null); setCreatingFile(false); setCreatingFolder(true); };
  const requestNewFile = () => { setRenamingId(null); setCreatingFolder(false); setCreatingFile(true); };
  const commitRename = (item, name) => { setRenamingId(null); onRename?.(item, name); };
  const cancelRename = () => setRenamingId(null);

  // Parent created a file and wants it renamed (not opened): once the new file
  // appears in the listing, select it and drop straight into rename mode — the
  // inline input auto-focuses and selects the name text. Re-runs as `items`
  // updates so it catches the file after the post-write refetch lands.
  useEffect(() => {
    if (!renameTargetPath) return;
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const target = norm(renameTargetPath);
    const match = (items || []).find((it) => it?._raw?.path && norm(it._raw.path) === target);
    if (!match) return; // not listed yet — this effect re-runs when items change
    setCreatingFolder(false);
    setCreatingFile(false);
    setMultiSel(new Set([match.id]));
    setAnchorId(match.id);
    setRenamingId(match.id);
    onRenameTargetConsumed?.();
  }, [renameTargetPath, items]); // eslint-disable-line react-hooks/exhaustive-deps

  // Parent made something and wants it SELECTED but not opened — the folder an
  // archive was just extracted into. Unlike the rename request above this
  // searches folders as well as files, and stops at selection: no rename mode,
  // no navigation. Re-runs as the listing updates so it catches the folder
  // once the post-extract refetch lands.
  useEffect(() => {
    if (!selectTargetPath) return;
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const target = norm(selectTargetPath);
    if (!target) return;
    const match = [...(folders || []), ...(items || [])]
      .find((it) => it && norm(it._dir?.path || it._raw?.path) === target);
    if (!match) return;  // not listed yet — this effect re-runs when they change
    setMultiSel(new Set([match.id]));
    setAnchorId(match.id);
    onSelectTargetConsumed?.();
    requestAnimationFrame(() => {
      try {
        canvasRef.current?.querySelector(`[data-fx-id="${CSS.escape(match.id)}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      } catch { /* CSS.escape unsupported */ }
    });
  }, [selectTargetPath, folders, items]); // eslint-disable-line react-hooks/exhaustive-deps
  const commitNewFolder = (name) => { setCreatingFolder(false); onNewFolder?.(name); };
  const cancelNewFolder = () => setCreatingFolder(false);
  const commitNewFile = (name) => { setCreatingFile(false); onNewFile?.(name); };
  const cancelNewFile = () => setCreatingFile(false);

  // Write actions (rename / import / new folder) are only offered in the
  // My-drafts tab — the bin is restore / delete-forever only.
  const menuEditable = !isBin && canEdit;

  // Clear selection + inline edits when the tab changes.
  useEffect(() => {
    setMultiSel(new Set());
    setAnchorId(null);
    setSelectMode(false);
    setRenamingId(null);
    setCreatingFolder(false);
  }, [tab]);

  // Escape closes the Properties dialog.
  useEffect(() => {
    if (!propsItem) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPropsItem(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [propsItem]);

  // Ctrl/Cmd+F focuses the folder search — but only for the SELECTED window.
  // In split view every Files pane shares this global listener, so we gate on
  // the pane's focus state: fire only when this instance lives in the focused
  // `.sv-pane` (or in single-window mode, where there's no `.sv-pane` at all).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        const pane = pageRef.current?.closest('.sv-pane');
        if (pane && !pane.classList.contains('is-focused')) return;
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Ctrl/Cmd+C copies the selection; Ctrl/Cmd+V pastes into the current folder.
  // Scoped to the focused pane and suppressed while typing in an input so it
  // doesn't hijack normal text copy/paste.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = (e.key || '').toLowerCase();
      if (k !== 'c' && k !== 'v' && k !== 'x') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // Don't clobber a real text selection (let the browser copy that).
      if (k === 'c' && window.getSelection && String(window.getSelection())) return;
      const pane = pageRef.current?.closest('.sv-pane');
      if (pane && !pane.classList.contains('is-focused')) return;
      const a = actionsRef.current;
      if (k === 'c' && a.hasCopyable) { e.preventDefault(); a.copySelection(); }
      else if (k === 'x' && a.canCut) { e.preventDefault(); a.cutSelection(); }
      else if (k === 'v' && a.canPaste) { e.preventDefault(); a.pasteHere(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Explorer-style keys (Delete / F2 / Enter / Backspace / Ctrl+A / arrows /
  // Home / End / Escape). Scoped to the focused pane; suppressed while typing.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const pane = pageRef.current?.closest('.sv-pane');
      if (pane && !pane.classList.contains('is-focused')) return;
      const k = kbdRef.current;
      switch (e.key) {
        case 'Delete':
          if (k.hasSelection) { e.preventDefault(); k.deleteSelection(); }
          break;
        case 'F2':
          if (k.menuEditable && k.oneSelected) { e.preventDefault(); k.renameSelected(); }
          break;
        case 'Enter':
          if (k.oneSelected) { e.preventDefault(); k.openSelected(); }
          break;
        case 'Backspace':
          if (k.canUp) { e.preventDefault(); k.onUp(); }
          break;
        case 'Escape':
          if (k.hasSelection) { e.preventDefault(); k.clearSelection(); }
          break;
        case 'a': case 'A':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); k.selectAll(); }
          break;
        case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': case 'Home': case 'End':
          if (!e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); k.navigateSelection(e.key, e.shiftKey); }
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Deselect any selected file(s) when this pane loses focus — selection should
  // only persist in the active window. Watches the pane's `is-focused` class;
  // single-window mode (no `.sv-pane`) has no unfocus concept, so it's skipped.
  useEffect(() => {
    const pane = pageRef.current?.closest('.sv-pane');
    if (!pane || typeof MutationObserver === 'undefined') return undefined;
    const obs = new MutationObserver(() => {
      if (!pane.classList.contains('is-focused')) {
        setMultiSel((prev) => (prev.size ? new Set() : prev));
        setAnchorId(null);
      }
    });
    obs.observe(pane, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  // Publish the live description into the window chrome (top bar), and grab its
  // row-2 portal slot so the folder toolbar (nav + breadcrumb + search) renders
  // INTO the chrome — merging into one bar — instead of a separate in-page row.
  usePaneChromeSlot({
    description: isBin
      ? 'Deleted files are removed for good after 30 days.'
      : summaryText,
  });
  const chromeSlotEl = usePaneChromePortalEl();

  // Ctrl+scroll over the canvas zooms the tiles.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey || !e.deltaY) return;
      e.preventDefault();
      setTileSize((prev) => {
        const next = prev - Math.sign(e.deltaY) * 14;
        return Math.max(FX_MIN_TILE, Math.min(FX_MAX_TILE, next));
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Close the Create-new-file menu on outside click / Esc.
  useEffect(() => {
    if (!createMenuOpen) return undefined;
    const onDoc = (e) => { if (!createMenuRef.current?.contains(e.target)) setCreateMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setCreateMenuOpen(false); };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey); };
  }, [createMenuOpen]);

  const q = query.trim().toLowerCase();
  const matches = (name) => !q || (name || '').toLowerCase().includes(q);
  // Case-insensitive, number-aware name sort ("file2" before "file10").
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
  // Coarse category of an item, for the "Categorize" section view: the Recycle
  // bin entry → trash; folders + compressed archives → folders; images, video
  // and audio (+ design files) → media; Office docs (Word / Excel / PowerPoint
  // / PDF) → office; everything else → other. Keep in sync with FX_GROUPS.
  const itemCat = (f) => {
    if (f.binEntry) return 'trash';
    if (f.kind === 'folder') return 'folders';
    const c = extCategory(f.ext);
    if (c === 'zip') return 'folders';
    if (c === 'img' || c === 'vid' || c === 'aud' || c === 'psd' || c === 'ai') return 'media';
    if (c === 'doc' || c === 'xls' || c === 'ppt' || c === 'pdf') return 'office';
    return 'other';
  };
  // One flat ordering (no Folders/Files category split): the Recycle bin entry
  // first, then folders A→Z, then files A→Z.
  const binFolders = useMemo(
    () => (folders || []).filter((f) => f.binEntry && matches(f.name)),
    [folders, q], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const shownFolders = useMemo(
    () => (folders || []).filter((f) => !f.binEntry && matches(f.name)).sort(byName),
    [folders, q], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Compressed archives (zip / rar / 7z / tar / gz) are "compressed folders" —
  // arrange them with the folders: they sort to the FRONT of the file list so,
  // rendered right after the real folders, they sit next to them. Within each
  // group (archives, then plain files) it's still A→Z.
  const isArchiveItem = (f) => extCategory(f.ext) === 'zip';
  const shownItems = useMemo(
    () => (items || []).filter((f) => matches(f.name)).sort((a, b) => {
      const aa = isArchiveItem(a) ? 0 : 1;
      const bb = isArchiveItem(b) ? 0 : 1;
      return aa !== bb ? aa - bb : byName(a, b);
    }),
    [items, q], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Bin → folders → files, in render order. Drives both the grid/list and the
  // Shift-range selection axis.
  const displayFolders = useMemo(() => [...binFolders, ...shownFolders], [binFolders, shownFolders]);

  // ── Content search ──────────────────────────────────────────────────────
  // A query matches two ways: by NAME (instant, the filter above) and by
  // CONTENT (has to read the files). The two result sets are kept disjoint —
  // a file whose name already matched isn't scanned or listed twice — and the
  // content pass runs in the background so typing never waits on a PDF parse.
  // [{ item, snippet }] — the snippet is the text around the match (literal
  // search) or the model's one-line reason (AI search).
  const [contentHits, setContentHits] = useState([]);
  const [contentScanning, setContentScanning] = useState(false);
  const [contentError, setContentError] = useState('');
  // ── AI section ──────────────────────────────────────────────────────────
  // Its own category beside the literal passes, and it only runs when ASKED:
  // an AI search costs a request (and uploads picture stills — see
  // lib/visualThumb.js), so it's a button in the section, not something every
  // keystroke fires. Results are tagged with the query they answer so a stale
  // set can't sit under a query it has nothing to do with.
  const [aiHits, setAiHits] = useState([]);
  const [aiScanning, setAiScanning] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiRanFor, setAiRanFor] = useState('');
  // The query a run was STARTED for, set whether or not it succeeded. `aiRanFor`
  // only records successes, so gating the auto-run on it would retry a failing
  // query forever.
  const [aiAttemptedFor, setAiAttemptedFor] = useState('');
  // { done, total } while the one-time description pass runs (lib/aiFileIndex),
  // null otherwise. Only ever non-null for files this folder hasn't described
  // yet, so it shows on the first search and rarely again.
  const [aiIndexing, setAiIndexing] = useState(null);
  const aiAbortRef = useRef(null);
  // The first AI search on a device asks for informed consent: it's the only
  // feature here that sends a matter's contents off the machine, so the user
  // gets told exactly what leaves before any of it does. Once granted the
  // button runs directly — a firm shouldn't have to re-read the notice on
  // every search.
  const [aiConsentOpen, setAiConsentOpen] = useState(false);
  const [aiConsented, setAiConsented] = useState(() => {
    try { return localStorage.getItem('docvex.aiSearchConsent') === '1'; } catch { return false; }
  });
  const acceptAiConsent = () => {
    try { localStorage.setItem('docvex.aiSearchConsent', '1'); } catch { /* ignore */ }
    setAiConsented(true);
    setAiConsentOpen(false);
    runAiSearch();
  };

  // Typing invalidates whatever the AI last answered.
  useEffect(() => {
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    setAiHits([]);
    setAiScanning(false);
    setAiError('');
    setAiRanFor('');
    setAiAttemptedFor('');
    setAiIndexing(null);
  }, [q]);

  const runAiSearch = async () => {
    if (!q || aiScanning) return;
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setAiAttemptedFor(q);
    setAiScanning(true);
    setAiError('');
    setAiHits([]);
    setAiIndexing(null);
    // Everything but folders: an image can only be judged by looking at it, so
    // unreadable-as-text formats are exactly what this pass is for. Files
    // already listed under "By name" are skipped — they're above.
    const candidates = (itemsRef.current || []).filter((f) => (
      f && f.kind !== 'folder' && f._raw?.path && !(f.name || '').toLowerCase().includes(q)
    )).map((f) => ({ item: f, file: f._raw }));
    const byPath = new Map(candidates.map((c) => [c.file.path, c.item]));
    try {
      const { matches, error } = await aiSearchFiles({
        query: q,
        files: candidates.map((c) => c.file),
        // The masthead title is the project's own name — context for what the
        // folder is about.
        projectName: masthead?.title || '',
        signal: controller.signal,
        // Reported only while files are being described for the first time.
        onProgress: (p) => { if (!controller.signal.aborted) setAiIndexing(p.done >= p.total ? null : p); },
      });
      if (controller.signal.aborted) return;
      if (error) { setAiError(typeof error === 'string' ? error : 'AI search failed.'); return; }
      setAiHits(matches.map((m) => ({ item: byPath.get(m.file.path), snippet: m.why })).filter((h) => h.item));
      setAiRanFor(q);
    } catch (err) {
      if (!controller.signal.aborted) setAiError(err?.message || 'AI search failed.');
    } finally {
      if (!controller.signal.aborted) { setAiScanning(false); setAiIndexing(null); }
    }
  };

  // Once the user has consented, AI search stops being a thing they press: the
  // pitch and its Enable button are gone and each query just runs, alongside
  // the two literal passes. Read through a ref because runAiSearch is rebuilt
  // every render and would otherwise re-fire this effect endlessly.
  const runAiRef = useRef(null);
  runAiRef.current = runAiSearch;
  useEffect(() => {
    if (!aiConsented || q.length < 2) return undefined;
    if (aiAttemptedFor === q || aiScanning) return undefined;
    // Longer than the literal pass's debounce: this one costs a request, so it
    // waits until the typing has actually stopped.
    const t = setTimeout(() => runAiRef.current?.(), 650);
    return () => clearTimeout(t);
  }, [q, aiConsented, aiAttemptedFor, aiScanning]);

  // `items` is rebuilt every render, so it can't be an effect dependency —
  // this value-equal string can.
  const itemsKey = useMemo(() => (items || []).map((f) => f.id).join('|'), [items]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    // One character matches nearly everything; scanning a folder for it is
    // pure waste. The debounce keeps mid-word keystrokes from starting scans
    // that are immediately abandoned.
    if (q.length < 2) { setContentHits([]); setContentScanning(false); setContentError(''); return undefined; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      // Files whose NAME already matched are shown in the section above — they
      // aren't scanned again here, so the two sections stay disjoint. The AI
      // pass considers every file (an image can only match by name/type), the
      // literal pass only what it can actually read: documents whose text we
      // can extract, plus recordings that already carry a transcript from the
      // Doc Viewer's captions.
      const candidates = (itemsRef.current || []).filter((f) => (
        f && f.kind !== 'folder' && f._raw?.path
        && !(f.name || '').toLowerCase().includes(q)
        && isSearchableFile(f._raw)
      )).map((f) => ({ item: f, file: f._raw }));
      if (!candidates.length) { setContentHits([]); setContentError(''); return; }
      setContentHits([]);
      setContentError('');
      setContentScanning(true);
      const byPath = new Map(candidates.map((c) => [c.file.path, c.item]));
      try {
        await searchContents(candidates.map((c) => c.file), q, {
          signal: controller.signal,
          // Append as they land so the section fills in progressively.
          onHit: (file, snippet) => {
            if (controller.signal.aborted) return;
            const item = byPath.get(file.path);
            if (!item) return;
            setContentHits((prev) => (prev.some((h) => h.item === item) ? prev : [...prev, { item, snippet }]));
          },
        });
      } catch (err) {
        if (!controller.signal.aborted) setContentError(err?.message || 'Search failed.');
      } finally {
        if (!controller.signal.aborted) setContentScanning(false);
      }
    }, 320);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [q, itemsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const searching = q.length > 0;
  // While searching the AI section is always rendered (it holds its own run
  // button), so a search never falls through to the "no matches" empty state.
  const totalShown = displayFolders.length + shownItems.length
    + (searching ? contentHits.length + aiHits.length + 1 : 0);

  // Category sections for the "Categorize" view — every displayed item bucketed
  // by itemCat, in FX_GROUPS order, empty sections dropped. The folders section
  // naturally lists real folders before archives (they come first in the union)
  // and each bucket keeps its A→Z order. Only built when grouping is on.
  const groups = useMemo(() => {
    if (!grouped) return [];
    const all = [...displayFolders, ...shownItems];
    return FX_GROUPS
      .map((g) => ({ ...g, items: all.filter((f) => itemCat(f) === g.key) }))
      .filter((g) => g.items.length > 0);
  }, [grouped, displayFolders, shownItems]); // eslint-disable-line react-hooks/exhaustive-deps

  const itemById = useMemo(() => {
    const m = new Map();
    for (const f of (folders || [])) m.set(f.id, f);
    for (const f of (items || [])) m.set(f.id, f);
    return m;
  }, [folders, items]);

  const multiSelItems = useMemo(
    () => [...multiSel].map((id) => itemById.get(id)).filter(Boolean),
    [multiSel, itemById],
  );

  // A single selection drives the Open / Rename / Properties affordances.
  const selectedItem = multiSel.size === 1 ? (itemById.get([...multiSel][0]) || null) : null;

  // Visible order — the axis for Shift-range selection. In the categorize view
  // it follows the section layout so a range drag tracks what the eye sees;
  // otherwise the flat bin → folders → files order.
  const orderedIds = useMemo(
    () => {
      // Must mirror RENDER order — it's the axis Shift-range selection walks.
      if (searching) {
        return [...displayFolders, ...shownItems, ...contentHits.map((h) => h.item), ...aiHits.map((h) => h.item)]
          .map((f) => f.id);
      }
      return (grouped ? groups.flatMap((g) => g.items) : [...displayFolders, ...shownItems]).map((f) => f.id);
    },
    [searching, contentHits, aiHits, grouped, groups, displayFolders, shownItems],
  );

  // Click selection. Modifiers compose like Windows File Explorer:
  //   • plain          → select just this item (re-clicking KEEPS it selected;
  //                      empty-canvas click is what clears — see the canvas
  //                      onClick — matching Explorer)
  //   • Ctrl/Cmd+click → toggle this item in/out of the selection
  //   • Shift+click    → select the range from the anchor to this item
  //   • selectMode on  → plain clicks behave additively (toggle)
  const onSelect = (item, e) => {
    const id = item.id;
    const additive = (e && (e.ctrlKey || e.metaKey)) || selectMode;
    const range = Boolean(e && e.shiftKey);
    if (range && anchorId != null) {
      const a = orderedIds.indexOf(anchorId);
      const b = orderedIds.indexOf(id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const slice = orderedIds.slice(lo, hi + 1);
        setMultiSel((prev) => {
          const base = (additive ? new Set(prev) : new Set());
          slice.forEach((x) => base.add(x));
          return base;
        });
        return;
      }
    }
    if (additive) {
      setMultiSel((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      setAnchorId(id);
      return;
    }
    // Plain click — single select (Explorer keeps it selected on re-click;
    // clicking empty canvas is what clears).
    setMultiSel(new Set([id]));
    setAnchorId(id);
  };

  const clearSelection = () => { setMultiSel(new Set()); setAnchorId(null); };

  // Click-away deselect, WINDOW-wide. The canvas's own handler only covers the
  // grid's own row, so a click on the masthead, the page margin or anywhere
  // else on screen used to leave a file selected. Bound at the document instead
  // of stretching an invisible layer over the app: a real full-screen element
  // would have to swallow the click to see it, breaking everything under it.
  // Anything actionable is exempt — a toolbar button, a menu entry, a rename
  // input — since those operate ON the selection and must not lose it first.
  useEffect(() => {
    if (!multiSel.size) return undefined;   // nothing to clear — don't listen
    const onDocClick = (e) => {
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest('.fx-tile, .fx-list-row, button, a, input, textarea, select, [role="menuitem"], [contenteditable="true"]')) return;
      clearSelection();
    };
    // Bubble phase, so a tile's own onClick has already run and set the new
    // selection before this sees the event.
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [multiSel.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const exitSelectMode = () => { setSelectMode(false); clearSelection(); };
  const toggleSelectMode = () => {
    setSelectMode((on) => { if (on) clearSelection(); return !on; });
  };
  const bulkDelete = () => {
    if (!multiSelItems.length) return;
    multiSelItems.forEach((it) => onDelete?.(it));
    exitSelectMode();
  };
  const selectAll = () => { if (orderedIds.length) setMultiSel(new Set(orderedIds)); };

  // Grid column count (1 in list view) — read from the live CSS grid so arrow
  // Up/Down move by a true row.
  const getColumns = () => {
    if (view === 'list') return 1;
    const grid = canvasRef.current?.querySelector('.fx-grid');
    if (!grid) return 1;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
    return Math.max(1, cols);
  };

  // Arrow-key navigation, Explorer-style. Plain arrows move the single
  // selection; Shift+arrow extends the range from the anchor. Up/Down step a
  // full row in grid view; Home/End jump to the first/last item.
  const navigateSelection = (key, shift) => {
    const ids = orderedIds;
    if (!ids.length) return;
    const cols = getColumns();
    let cur = anchorId != null ? ids.indexOf(anchorId) : -1;
    if (cur < 0 && multiSel.size) cur = ids.indexOf([...multiSel][multiSel.size - 1]);
    let target;
    if (cur < 0) {
      target = (key === 'ArrowUp' || key === 'ArrowLeft' || key === 'End') ? ids.length - 1 : 0;
    } else if (key === 'ArrowRight') target = cur + 1;
    else if (key === 'ArrowLeft') target = cur - 1;
    else if (key === 'ArrowDown') target = cur + cols;
    else if (key === 'ArrowUp') target = cur - cols;
    else if (key === 'Home') target = 0;
    else if (key === 'End') target = ids.length - 1;
    else target = cur;
    if (target < 0 || target >= ids.length) {
      // Up/Down clamp to the ends; Left/Right past an edge is a no-op.
      if (key === 'ArrowDown' || key === 'ArrowUp') target = Math.max(0, Math.min(ids.length - 1, target));
      else return;
    }
    const targetId = ids[target];
    if (shift && anchorId != null) {
      const a = ids.indexOf(anchorId);
      const [lo, hi] = a <= target ? [a, target] : [target, a];
      setMultiSel(new Set(ids.slice(lo, hi + 1)));
    } else {
      setMultiSel(new Set([targetId]));
      setAnchorId(targetId);
    }
    requestAnimationFrame(() => {
      try { canvasRef.current?.querySelector(`[data-fx-id="${CSS.escape(targetId)}"]`)?.scrollIntoView({ block: 'nearest' }); } catch { /* CSS.escape unsupported */ }
    });
  };

  // Opening an archive can't do what "open" normally does — there's nothing to
  // preview inside a .zip — so it asks first, in a card pinned to the pointer.
  // Every open path funnels through here (double-click, the menu's "Open", the
  // toolbar button, Enter), so the prompt can't be bypassed by one of them.
  // The bin is excluded: a trashed archive has no live path to extract to. So
  // is a recognised WhatsApp export — it's a .zip, but double-clicking it has
  // always opened the reconstructed conversation, which IS a useful preview.
  const openItem = (item, e) => {
    if (tab !== 'trash' && item && item.kind !== 'folder' && !isWhatsAppExport(item)
        && item._raw?.path && extCategory(item.ext) === 'zip') {
      setArchivePrompt({ item, x: e?.clientX ?? null, y: e?.clientY ?? null });
      return;
    }
    onOpen?.(item);
  };

  // Latest handlers/state for the global key listener (avoids re-binding it).
  kbdRef.current = {
    hasSelection: multiSel.size > 0,
    oneSelected: !!selectedItem,
    canUp,
    menuEditable,
    deleteSelection: bulkDelete,
    renameSelected: () => { if (selectedItem) requestRename(selectedItem); },
    openSelected: () => { if (selectedItem) openItem(selectedItem); },
    selectAll,
    clearSelection,
    navigateSelection,
    onUp: () => onUp?.(),
  };

  // ── Clipboard (copy / paste) + drag-to-move ─────────────────────────────
  // `clipboard` holds copied file descriptors [{ name, path }]; it survives
  // folder navigation (this component stays mounted) so you can copy in one
  // folder and paste in another. Copy/paste + move are drafts-only.
  const fileItemsFrom = (list) => list.filter((it) => it && it.kind !== 'folder' && it._raw?.path).map((it) => ({ name: it.name, path: it._raw.path }));
  const pickedForClipboard = () => fileItemsFrom(multiSelItems.length ? multiSelItems : (selectedItem ? [selectedItem] : []));
  const copySelection = () => {
    if (!menuEditable) return;
    const picked = pickedForClipboard();
    if (picked.length) setClipboard({ mode: 'copy', items: picked });
  };
  const cutSelection = () => {
    if (!menuEditable || !onMoveItems) return;
    const picked = pickedForClipboard();
    if (picked.length) setClipboard({ mode: 'cut', items: picked });
  };
  const pasteHere = () => {
    if (!clipboard?.items?.length) return;
    if (clipboard.mode === 'cut') {
      if (onPasteCut) onPasteCut(clipboard.items);
      setClipboard(null); // a cut is consumed by the paste
    } else if (onPasteItems) {
      onPasteItems(clipboard.items);
    }
  };
  // Context-menu copy/cut act on the right-clicked item — or the whole
  // selection when that item is part of it.
  const itemsForContext = (item) => fileItemsFrom(multiSel.has(item.id) && multiSelItems.length > 1 ? multiSelItems : [item]);
  const copyItem = (item) => { if (!menuEditable) return; const picked = itemsForContext(item); if (picked.length) setClipboard({ mode: 'copy', items: picked }); };
  const cutItem = (item) => { if (!menuEditable || !onMoveItems) return; const picked = itemsForContext(item); if (picked.length) setClipboard({ mode: 'cut', items: picked }); };
  const canPaste = !!clipboard?.items?.length && (clipboard.mode === 'cut' ? !!onPasteCut : !!onPasteItems);

  // Right-click on empty canvas → a morph menu with Paste / Import / Create /
  // Open directory (drafts only). "Import" is a single action (import files);
  // "Create" expands an inline submenu mirroring the footer Create button
  // (New folder + the Build-with-AI document types).
  const bgMorph = useMorphPill({
    // No hover tooltip precedes this one, so there's nothing to morph FROM —
    // the scale-up just made the menu look like it took 220ms to appear.
    instant: true,
    hoverContent: '',
    menuItems: [
      menuEditable && canPaste && { key: 'paste', label: clipboard?.items?.length > 1 ? `Paste ${clipboard.items.length} items` : 'Paste', onClick: () => pasteHere() },
      menuEditable && { key: 'import', label: 'Import', onClick: () => onUpload?.() },
      menuEditable && {
        key: 'create',
        label: <span className="project-files-morph-ai-label"><Icon name="sparkles" className="fx-icon" /> Create</span>,
        className: 'project-files-morph-ai',
        submenu: [
          { key: 'newfolder', label: <><Icon name="folder-plus" className="fx-icon" /> New folder</>, onClick: () => requestNewFolder() },
          onAddIdentity && { key: 'identity', label: <><Icon name="identity" className="fx-icon" /> Add identity</>, onClick: () => onAddIdentity() },
          onCreateTypedFile && {
            key: 'aigroup',
            aiGroup: true,
            heading: 'Build with AI',
            items: [
              { key: 'docx', label: <><Icon name="file-doc" className="fx-icon fx-create-ico fx-create-ico-doc" /> Word</>, onClick: () => onCreateTypedFile('docx') },
              { key: 'pptx', label: <><Icon name="file-slides" className="fx-icon fx-create-ico fx-create-ico-ppt" /> PowerPoint</>, onClick: () => onCreateTypedFile('pptx') },
              { key: 'xlsx', label: <><Icon name="file-sheet" className="fx-icon fx-create-ico fx-create-ico-xls" /> Excel</>, onClick: () => onCreateTypedFile('xlsx') },
            ],
          },
        ].filter(Boolean),
      },
      onOpenDirectory && { key: 'opendir', label: 'Open directory', onClick: () => onOpenDirectory() },
    ],
  });
  actionsRef.current = { copySelection, cutSelection, pasteHere, hasCopyable: menuEditable && (multiSel.size > 0 || !!selectedItem), canCut: menuEditable && !!onMoveItems && (multiSel.size > 0 || !!selectedItem), canPaste };

  // ── Background right-click (New folder / Import) ────────────────────────
  // Bound to the DOCUMENT, so a right-click anywhere in the window opens it.
  // Element-scoped versions kept leaving dead zones: the canvas is one track of
  // a grid and only as wide as the file content, and .fx-page is capped at
  // --content-max-width, so on a wide window the gutter beside the content had
  // no handler at all.
  //
  // Right-clicking again while it's open just re-anchors it — handleContextMenu
  // rewrites the position, it doesn't toggle — so the menu follows the pointer
  // rather than needing to be dismissed first.
  //
  // Three exemptions, and they're all load-bearing:
  //   • tiles / rows      — they have their own item menus. They stop
  //                         propagation natively too, so this rarely even sees
  //                         them; the check is belt and braces.
  //   • the menu itself   — it's portalled to <body>, i.e. OUTSIDE React's root
  //                         container, so its events do reach this listener.
  //                         Without this, right-clicking a menu entry would
  //                         re-open the menu on top of itself.
  //   • text fields       — keep the platform's own editing menu.
  // The handler is read through a ref, refreshed every render. Binding
  // bgMorph.handleContextMenu directly would freeze the closure from whichever
  // render registered the listener, so a SECOND right-click ran against stale
  // menu state — which is what made the reopened menu come up broken.
  const bgMenuRef = useRef(null);
  bgMenuRef.current = bgMorph.handleContextMenu;
  useEffect(() => {
    if (!menuEditable) return undefined;
    const onMenu = (e) => {
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest('.project-files-morph-pill, .fx-tile, .fx-list-row, input, textarea, [contenteditable="true"]')) return;
      bgMenuRef.current?.(e);
    };
    document.addEventListener('contextmenu', onMenu);
    return () => document.removeEventListener('contextmenu', onMenu);
  }, [menuEditable]); // eslint-disable-line react-hooks/exhaustive-deps

  // On-disk path of an item — files carry it on `_raw`, folders on `_dir`.
  const itemDiskPath = (it) => it?._raw?.path || it?._dir?.path || null;

  // The id set being dragged — the current selection if the grabbed item is
  // part of it, else just that item. Both files AND folders can be dragged to
  // move (the Recycle bin entry can't); file-only consumers (chat/AI) skip the
  // folders by kind.
  const dragPayloadFor = (item) => {
    const inSel = multiSel.has(item.id);
    const base = inSel ? multiSelItems : [item];
    return base.filter((it) => it && !it.binEntry && itemDiskPath(it));
  };

  // Drag source — file/folder tiles/rows publish a docvex payload that a folder
  // or breadcrumb (→ move) and a chat composer (→ attach) can read. Drafts only.
  const beginItemDrag = (item, e) => {
    if (!menuEditable) return;
    // Normalise to a flat { name, path, kind } shape — every drop consumer
    // reads a top-level `d.path`; `kind` lets a move recreate a folder while
    // file-only consumers (chat / AI composers) drop the folders.
    const rich = dragPayloadFor(item);
    const picked = rich.map((it) => ({ name: it.name, path: itemDiskPath(it), kind: it.kind === 'folder' ? 'folder' : 'file' }));
    if (!picked.length) { e.preventDefault(); return; }
    // Publish the rich models (descriptor + name + kind) so drop targets can
    // preview the drag live (dragover can't read dataTransfer data).
    setDraggedFiles(rich.map((it) => ({ name: it.name, path: itemDiskPath(it), kind: it.kind === 'folder' ? 'folder' : 'file', descriptor: it.descriptor })));
    try {
      e.dataTransfer.setData('application/x-docvex-files', JSON.stringify({ items: picked }));
      e.dataTransfer.setData('text/plain', picked.map((p) => p.name).join('\n'));
      e.dataTransfer.effectAllowed = 'copyMove';
    } catch { /* setData can throw in odd states */ }
  };
  const endItemDrag = () => clearDraggedFiles();

  // True when `target` is `folderPath` itself or sits inside it — blocks
  // dropping a folder onto itself or into one of its own descendants.
  const isSelfOrDescendant = (target, folderPath) => {
    if (!target || !folderPath) return false;
    return target === folderPath || target.startsWith(`${folderPath}/`) || target.startsWith(`${folderPath}\\`);
  };
  // Map a serialized drag item back to the { name, kind, _raw|_dir } shape the
  // move handlers expect.
  const dropItemFromData = (d) => (d.kind === 'folder'
    ? { name: d.name, kind: 'folder', _dir: { path: d.path } }
    : { name: d.name, kind: 'file', _raw: { path: d.path } });

  // Folder drop target — moving dragged files/folders into that folder.
  const dragHasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('application/x-docvex-files');
  // Reconstruct a serialized drag item into the { name, kind, _raw|_dir } shape
  // the delete handler reads (path AND name on the inner object).
  const deleteItemFromData = (d) => (d.kind === 'folder'
    ? { name: d.name, kind: 'folder', _dir: { path: d.path, name: d.name } }
    : { name: d.name, kind: 'file', _raw: { path: d.path, name: d.name } });
  const onFolderDragOver = (folder, e) => {
    // The Recycle bin entry is a drop target for delete: drop files/folders on
    // it to move them to the trash.
    if (folder.binEntry) {
      if (!onDelete || !dragHasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropFolderId !== folder.id) setDropFolderId(folder.id);
      return;
    }
    if (!onMoveItems || !dragHasFiles(e)) return;
    // Don't accept a folder dropped onto itself / its own descendants — the
    // live payload comes from the drag bus since dragover can't read dataTransfer.
    const targetPath = folder._dir?.path;
    const dragged = getDraggedFiles();
    if (dragged && dragged.some((d) => d.kind === 'folder' && isSelfOrDescendant(targetPath, d.path))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropFolderId !== folder.id) setDropFolderId(folder.id);
  };
  const onFolderDragLeave = (folder) => { setDropFolderId((cur) => (cur === folder.id ? null : cur)); };
  const onFolderDrop = (folder, e) => {
    // Drop on the Recycle bin entry → delete (move each dragged item to trash).
    if (folder.binEntry) {
      if (!onDelete || !dragHasFiles(e)) return;
      e.preventDefault();
      setDropFolderId(null);
      let data = null;
      try { data = JSON.parse(e.dataTransfer.getData('application/x-docvex-files')); } catch { /* malformed */ }
      const toDelete = (data?.items || []).filter((d) => d?.path).map(deleteItemFromData);
      toDelete.forEach((it) => onDelete(it));
      return;
    }
    if (!onMoveItems || !dragHasFiles(e)) return;
    e.preventDefault();
    setDropFolderId(null);
    let data = null;
    try { data = JSON.parse(e.dataTransfer.getData('application/x-docvex-files')); } catch { /* malformed */ }
    const targetPath = folder._dir?.path;
    const items = (data?.items || [])
      .filter((d) => d?.path)
      .filter((d) => !(d.kind === 'folder' && isSelfOrDescendant(targetPath, d.path)))
      .map(dropItemFromData);
    if (items.length) onMoveItems(items, folder);
  };

  // Breadcrumb drop target — moving dragged files into an ancestor folder by
  // dropping on its crumb. The current (last) crumb is skipped (no-op).
  const onCrumbDragOver = (crumb, isLast, e) => {
    if (!onMoveToCrumb || isLast || !dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropCrumb !== crumb.path) setDropCrumb(crumb.path);
  };
  const onCrumbDragLeave = (crumb) => { setDropCrumb((cur) => (cur === crumb.path ? null : cur)); };
  const onCrumbDrop = (crumb, isLast, e) => {
    if (!onMoveToCrumb || isLast || !dragHasFiles(e)) return;
    e.preventDefault();
    setDropCrumb(null);
    let data = null;
    try { data = JSON.parse(e.dataTransfer.getData('application/x-docvex-files')); } catch { /* malformed */ }
    const items = (data?.items || []).filter((d) => d?.path).map(dropItemFromData);
    if (items.length) onMoveToCrumb(crumb, items);
  };

  // Common props every Tile/Row needs.
  const itemCommon = {
    tab,
    onSelect, onOpen: openItem, onOpenContent,
    onRename: requestRename,
    onProperties: setPropsItem,
    onOpenLocation, onDelete, onRestore, onEmptyBin,
    canEdit: menuEditable,
    selectMode,
    bulkCount: multiSelItems.length,
    onBulkDelete: bulkDelete,
    onCopy: onPasteItems ? copyItem : null,
    onCut: onMoveItems ? cutItem : null,
    // Drag-to-move: file items are draggable; non-bin folders accept drops.
    draggable: menuEditable,
    beginItemDrag,
    endItemDrag,
    onFolderDragOver,
    onFolderDragLeave,
    onFolderDrop,
    dropFolderId,
    // Per-folder icon colour map + setter (for the right-click colour swatches).
    folderColors,
    onSetColor: setFolderColor,
    // Files currently "cut" to the clipboard render dimmed (Explorer-style).
    cutPaths: clipboard?.mode === 'cut' ? new Set(clipboard.items.map((i) => i.path)) : null,
  };

  // One item → a Tile / Row, with the shared selection + rename wiring. Used by
  // both the flat grid/list and the per-section grids/lists in categorize mode.
  const renderTile = (f) => (
    <Tile key={f.id} item={f} selected={multiSel.has(f.id)} isMultiSelected={multiSel.has(f.id)} renaming={renamingId === f.id} onCommitName={(name) => commitRename(f, name)} onCancelName={cancelRename} {...itemCommon} />
  );
  const renderRow = (f) => (
    <Row key={f.id} item={f} selected={multiSel.has(f.id)} isMultiSelected={multiSel.has(f.id)} renaming={renamingId === f.id} onCommitName={(name) => commitRename(f, name)} onCancelName={cancelRename} {...itemCommon} />
  );

  const emptyHint = {
    drafts: 'No files in your folder yet. Add or import files and they’ll show up here.',
    trash: 'Files you delete wait in the trash for 30 days before they’re removed for good.',
  }[tab];

  // List view shows its column header INSIDE the window chrome (same bar/section
  // as the search), aligned with the full-bleed rows below — so it renders only
  // when the list is actually populated.
  const showListHead = view === 'list' && hasLocalFolder && !loading && (totalShown > 0 || creatingFolder || creatingFile);

  // Folder toolbar — nav + breadcrumb + search (+ the list column header in
  // list view). Rendered INTO the window chrome's row-2 slot when available
  // (one merged bar); falls back to an in-page pathbar row if there's no chrome.
  const toolbar = (
    <>
      <div className="fx-chrome-tools">
        <div className="fx-pathbar-nav">
          {onRefresh && (
            <Tooltip content="Refresh"><button onClick={() => onRefresh()}><Icon name="refresh" size={14} /></button></Tooltip>
          )}
          <Tooltip content="Back"><button onClick={() => onBack?.()} disabled={!canBack}><Icon name="chev-left" size={14} /></button></Tooltip>
          <Tooltip content="Forward"><button disabled><Icon name="chev-right" size={14} /></button></Tooltip>
        </div>
        <nav className="fx-crumbs" aria-label="Folder path">
          {(crumbs || []).map((cr, i) => {
            const isLast = i === crumbs.length - 1;
            // Every crumb carries a glyph for the surface it points at: the
            // Recycle bin gets its trash can; the root and every directory a
            // folder (the root's is filled, matching the Files-tab tiles).
            const crumbIcon = cr.path === '__bin' ? 'trash' : 'folder';
            return (
              <React.Fragment key={cr.path ?? i}>
                {i > 0 && <Icon name="chev-right" size={12} className="fx-crumb-sep" />}
                <Tooltip content={cr.label}>
                  <button
                    type="button"
                    className={`fx-crumb${i === 0 ? ' is-root' : ''}${isLast ? ' is-current' : ''}${dropCrumb === cr.path && !isLast ? ' is-droptarget' : ''}`}
                    onClick={isLast ? undefined : () => onCrumb?.(cr.path)}
                    onDragOver={(e) => onCrumbDragOver(cr, isLast, e)}
                    onDragLeave={() => onCrumbDragLeave(cr)}
                    onDrop={(e) => onCrumbDrop(cr, isLast, e)}
                  >
                    {/* Every crumb glyph uses the FILLED variant — folders
                        included (no hollow icons); Trash matches the Files
                        tab's bin glyph, tinted gray. */}
                    <Icon name={crumbIcon} size={i === 0 ? 16 : 14} className={`fx-crumb-icon${crumbIcon === 'trash' ? ' is-trash' : ''}`} filled />
                    <span className="fx-crumb-label">{cr.label}</span>
                  </button>
                </Tooltip>
              </React.Fragment>
            );
          })}
        </nav>
        <div style={{ flex: 1 }} />
        {/* Icon-size slider — drives the same tileSize as Ctrl+scroll zoom
            (smallest size flips to the list view). Sits just left of search. */}
        <Tooltip content="Icon size">
          <div className="fx-size-slider">
            <span className="fx-size-dot fx-size-dot-sm" aria-hidden="true" />
            <input
              type="range"
              className="fx-size-range"
              min={FX_MIN_TILE}
              max={FX_MAX_TILE}
              step={2}
              value={tileSize}
              onChange={(e) => setTileSize(Number(e.target.value))}
              aria-label="Icon size"
            />
            <span className="fx-size-dot fx-size-dot-lg" aria-hidden="true" />
          </div>
        </Tooltip>
        {/* Grid ⇄ list toggle — the icon reflects the CURRENT view and flips
            with it. Drives the same tileSize the slider / Ctrl+scroll use:
            the list side snaps to the smallest step, the grid side to the
            default tile size. Sits beside the categorize button. */}
        <Tooltip content={view === 'list' ? 'Switch to grid view' : 'Switch to list view'}>
          <button
            type="button"
            className="fx-cat-btn fx-view-btn"
            aria-label={view === 'list' ? 'Switch to grid view' : 'Switch to list view'}
            onClick={() => setTileSize(view === 'list' ? FX_LIST_THRESHOLD : FX_MIN_TILE)}
          >
            {/* Filled + accent, matching the file glyphs in the thumbs below —
                the view switch reads as part of the same icon family rather
                than a stroked outlier. */}
            <Icon name={view === 'list' ? 'list' : 'grid'} size={14} filled />
          </button>
        </Tooltip>
        {/* Categorize — split the listing into labelled category sections
            (folders & archives, media, Office docs, the Recycle bin, then
            other files) stacked vertically. Toggle. Available in the Recycle
            bin too — trashed items bucket by the same type categories. */}
        <Tooltip content={grouped ? 'Show as one list' : 'Group by category'}>
          <button
            type="button"
            className={`fx-cat-btn${grouped ? ' is-active' : ''}`}
            aria-label="Group by category"
            aria-pressed={grouped}
            onClick={() => setGrouped((v) => !v)}
          >
            {/* Filled + accent (the folder colour) when active. */}
            <Icon name="categories" size={14} filled={grouped} />
          </button>
        </Tooltip>
        <div className={`fx-search${query ? ' is-active' : ''}`}>
          <Icon name="search" size={15} className="fx-search-glyph" />
          <input
            ref={searchRef}
            placeholder="Search this folder"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }}
          />
          {query ? (
            <Tooltip content="Clear search">
              <button
                type="button"
                className="fx-search-clear"
                aria-label="Clear search"
                onClick={() => { setQuery(''); searchRef.current?.focus(); }}
              >
                <Icon name="close" size={13} strokeWidth={2} />
              </button>
            </Tooltip>
          ) : (
            <span className="fx-search-kbd">
              <kbd>{isMacPlatform ? '⌘' : 'Ctrl'}</kbd>
              <span className="fx-search-kbd-plus">+</span>
              <kbd>F</kbd>
            </span>
          )}
        </div>
      </div>
      {showListHead && (
        <div className="fx-list-head fx-list-head--chrome">
          <div>Name</div><div>Date</div><div>Type</div><div>Size</div>
        </div>
      )}
    </>
  );

  return (
    <div
      className="fx-page"
      ref={pageRef}
      // No handlers here: the background right-click menu and the click-away
      // deselect are both bound at the document (see the effects above), so
      // neither is limited to this element's box.
    >
      {chromeSlotEl && createPortal(toolbar, chromeSlotEl)}
      {/* Masthead — Versions-style hero (the page is chromeless on /files, so
          this is the page title). The whole page scrolls, so it simply scrolls
          away; the sticky nav strip below carries the title once it's gone. */}
      {masthead && (
        <header className="fx-masthead">
          <div className="fx-mh-eyebrow">
            <span>{masthead.eyebrow}</span>
            {masthead.access && <span className="fx-mh-muted">· {masthead.access}</span>}
          </div>
          <h1 className="fx-mh-title">{masthead.title}</h1>
          {masthead.kicker && <p className="fx-mh-kicker">{masthead.kicker}</p>}
        </header>
      )}
      <div className="fx-window">
        {!chromeSlotEl && (
          <>
            <MiniHeaderFade visible={headerScrolled} />
            <div className={`fx-pathbar mini-glow${headerScrolled ? ' is-pinned' : ''}`} onMouseMove={miniHeaderSpot}>{toolbar}</div>
          </>
        )}

        {/* Canvas */}
        <div
          className={`fx-canvas${dragOver ? ' fx-canvas--drag' : ''}`}
          ref={canvasRef}
          style={{ '--fx-tile': `${tileSize}px`, ...(listRowVars || {}) }}
          onClick={(e) => {
            // A click anywhere in the canvas dismisses the background menu — the
            // grid/list fills the canvas, so empty-area clicks land on it, not
            // the canvas node.
            if (bgMorph.isMenuOpen) bgMorph.closeMenu();
            // Deselection isn't handled here — the document-level click-away
            // above covers the whole window, this row included.
          }}
          // No onContextMenu here — .fx-page owns the background menu so it
          // covers the whole surface, not just this grid track.
          onDragEnter={onDropFiles ? (e) => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) { e.preventDefault(); setDragOver(true); } } : undefined}
          onDragOver={onDropFiles ? (e) => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!dragOver) setDragOver(true); } } : undefined}
          onDragLeave={onDropFiles ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); } : undefined}
          onDrop={onDropFiles ? (e) => { e.preventDefault(); setDragOver(false); const dt = e.dataTransfer; collectDropEntries(dt).then((entries) => { if (entries.length) onDropFiles(entries); }); } : undefined}
        >
          {dragOver && (
            <div className="fx-drop-overlay" aria-hidden="true">
              <div className="fx-drop-overlay-card">
                <Icon name="upload" size={28} strokeWidth={1.6} />
                <strong>Drop to copy here</strong>
                <span>Files are copied into this folder</span>
              </div>
            </div>
          )}
          {!hasLocalFolder ? (
            onPickFolder ? (
              // Web — no ambient project directory; the user grants a folder.
              <div className="fx-empty">
                <Icon name="folder" className="fx-icon" strokeWidth={1.2} />
                <h3>Connect a folder to start</h3>
                <p>Pick a folder on your computer — that’s where this project’s files live.</p>
                <button className="fx-btn-primary" onClick={() => onPickFolder?.()}><Icon name="folder" size={14} /> Choose folder</button>
              </div>
            ) : folderError ? (
              // Electron — resolving the project directory failed (most often
              // the main process needs a restart to pick up the handler).
              <div className="fx-empty">
                <Icon name="folder" className="fx-icon" strokeWidth={1.2} />
                <h3>Couldn’t open the project folder</h3>
                <p>{folderError} If you just updated the app, fully restart it.</p>
                {onRetryFolder && <button className="fx-btn-primary" onClick={() => onRetryFolder()}>Try again</button>}
              </div>
            ) : (
              // Electron — the project directory is resolving (auto-bound).
              <div className="fx-empty"><p>Setting up the project folder…</p></div>
            )
          ) : loading ? (
            <div className="fx-empty"><p>Loading…</p></div>
          ) : (totalShown === 0 && !contentScanning && !creatingFolder && !creatingFile) ? (
            // While the content pass is still running there may yet be hits —
            // claiming "no matches" and then filling in behind it would be a lie.
            <div className="fx-empty">
              <Icon name={isBin ? 'trash' : 'inbox'} className="fx-icon" strokeWidth={1.2} />
              <h3>{q ? 'No matches' : (isBin ? 'Trash is empty' : 'Nothing here yet')}</h3>
              <p>{q ? `Nothing matches “${query}” by name or content.` : emptyHint}</p>
            </div>
          ) : searching ? (
            // Search view — two labelled sections, using the Categorize view's
            // section chrome so a divider means the same thing everywhere.
            // Name matches first (they're instant); content matches below,
            // filling in as the background scan reads each file.
            <div className="fx-cat-groups">
              {(displayFolders.length + shownItems.length) > 0 && (
                <section className="fx-cat-section">
                  <div className="fx-cat-head">
                    <Icon name="a" className="fx-cat-head-ico" size={13} />
                    <span className="fx-cat-head-label">By name</span>
                    <span className="fx-cat-head-count">{displayFolders.length + shownItems.length}</span>
                  </div>
                  {view === 'tiles'
                    ? <div className="fx-grid">{[...displayFolders, ...shownItems].map(renderTile)}</div>
                    : <div className="fx-list">{[...displayFolders, ...shownItems].map(renderRow)}</div>}
                </section>
              )}
              {(contentHits.length > 0 || contentScanning || contentError) && (
                <section className="fx-cat-section">
                  <div className="fx-cat-head">
                    <Icon name="search" className="fx-cat-head-ico" size={13} />
                    <span className="fx-cat-head-label">By content</span>
                    <span className="fx-cat-head-count">{contentHits.length}</span>
                    {contentScanning && <span className="fx-cat-head-spinner" aria-label="Searching file contents" />}
                  </div>
                  {contentError && <p className="fx-hit-error">{contentError}</p>}
                  {/* Always a vertical list, whatever the tile/list view is
                      set to: each row pairs the file with the snippet that
                      explains WHY it matched, which a tile grid has no room
                      for. */}
                  <div className="fx-hits">
                    {contentHits.map(({ item, snippet }) => (
                      <HitRow
                        key={item.id}
                        item={item}
                        snippet={snippet}
                        highlight={q}
                        fallback="Match found in this file."
                        selected={multiSel.has(item.id)}
                        onSelect={onSelect}
                        onOpen={openItem}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* ── AI ── Its own category, and it only runs when asked: the
                  request costs money and uploads picture stills, so it waits
                  for the button rather than firing on every keystroke. */}
              <section className="fx-cat-section">
                <div className="fx-cat-head">
                  <Icon name="sparkles" className="fx-cat-head-ico" size={13} />
                  <span className="fx-cat-head-label">AI search</span>
                  {aiRanFor === q && <span className="fx-cat-head-count">{aiHits.length}</span>}
                  {aiScanning && <span className="fx-cat-head-spinner" aria-label="Searching with AI" />}
                </div>
                {aiError && <p className="fx-hit-error">{aiError}</p>}
                {/* The pitch is a one-time thing: after consent the section
                    just shows results, so this only renders while AI search
                    hasn't been enabled yet. */}
                {!aiConsented && !aiScanning && (
                  <div className="fx-ai-cta">
                    <h4 className="fx-ai-cta-title">
                      <Icon name="sparkles" className="fx-ai-cta-ico" size={19} filled />
                      <span>AI Search</span>
                    </h4>
                    <p className="fx-ai-cta-desc">
                      Finds what “{query}” describes — reading the documents and{' '}
                      <strong>looking at the pictures and video</strong>.
                    </p>
                    <button
                      type="button"
                      className="fx-ai-run"
                      onClick={() => (aiConsented ? runAiSearch() : setAiConsentOpen(true))}
                    >
                      <span>Enable</span>
                    </button>
                  </div>
                )}
                {/* The description pass is the one-time cost, so it's named as
                    such — "reading" a folder for the twentieth time would look
                    like the search is slow when it's actually the index being
                    built for files that have never been read. */}
                {aiScanning && (
                  <p className="fx-ai-hint">
                    {aiIndexing
                      ? `Reading new files — ${aiIndexing.done} of ${aiIndexing.total}. Only happens once per file.`
                      : 'Searching…'}
                  </p>
                )}
                {/* Between the keystroke and the debounce firing there's a
                    beat with nothing to show — say so rather than flashing
                    "nothing matches" at a search that hasn't run yet. */}
                {aiConsented && !aiScanning && aiAttemptedFor !== q && !aiError && (
                  <p className="fx-ai-hint">Waiting for you to finish typing…</p>
                )}
                {aiRanFor === q && !aiScanning && aiHits.length === 0 && !aiError && (
                  <p className="fx-ai-hint">Nothing in this folder matches that.</p>
                )}
                {aiHits.length > 0 && (
                  <div className="fx-hits">
                    {aiHits.map(({ item, snippet }) => (
                      <HitRow
                        key={item.id}
                        item={item}
                        snippet={snippet}
                        fallback="Matches your request."
                        selected={multiSel.has(item.id)}
                        onSelect={onSelect}
                        onOpen={openItem}
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : grouped ? (
            // Categorize view — one labelled section per category, stacked
            // vertically. New-item drafts sit in a leading block; each section
            // renders its bucket as a grid (tiles) or rows (list).
            <div className="fx-cat-groups">
              {(creatingFolder || creatingFile) && (
                view === 'tiles' ? (
                  <div className="fx-grid">
                    {creatingFolder && <NewFolderTile onCommit={commitNewFolder} onCancel={cancelNewFolder} />}
                    {creatingFile && <NewFileTile onCommit={commitNewFile} onCancel={cancelNewFile} />}
                  </div>
                ) : (
                  <div className="fx-list">
                    {creatingFolder && <NewFolderRow onCommit={commitNewFolder} onCancel={cancelNewFolder} />}
                    {creatingFile && <NewFileRow onCommit={commitNewFile} onCancel={cancelNewFile} />}
                  </div>
                )
              )}
              {groups.map((g) => (
                <section className="fx-cat-section" key={g.key}>
                  <div className="fx-cat-head">
                    <Icon name={g.icon} className="fx-cat-head-ico" size={13} />
                    <span className="fx-cat-head-label">{g.label}</span>
                    <span className="fx-cat-head-count">{g.items.length}</span>
                  </div>
                  {view === 'tiles'
                    ? <div className="fx-grid">{g.items.map(renderTile)}</div>
                    : <div className="fx-list">{g.items.map(renderRow)}</div>}
                </section>
              ))}
            </div>
          ) : view === 'tiles' ? (
            // One flat grid — no Folders/Files category heads. Order: the
            // Recycle bin first, the new-folder draft, then folders A→Z, then
            // files A→Z.
            <div className="fx-grid">
              {binFolders.map(renderTile)}
              {creatingFolder && <NewFolderTile onCommit={commitNewFolder} onCancel={cancelNewFolder} />}
              {creatingFile && <NewFileTile onCommit={commitNewFile} onCancel={cancelNewFile} />}
              {shownFolders.map(renderTile)}
              {shownItems.map(renderTile)}
            </div>
          ) : (
            <div className="fx-list">
              {binFolders.map(renderRow)}
              {creatingFolder && <NewFolderRow onCommit={commitNewFolder} onCancel={cancelNewFolder} />}
              {creatingFile && <NewFileRow onCommit={commitNewFile} onCancel={cancelNewFile} />}
              {shownFolders.map(renderRow)}
              {shownItems.map(renderRow)}
            </div>
          )}
        </div>

        {/* Bottom action bar — file operations on the left, item count on the
            right. My drafts shows the full toolset; the bin shows
            Open / Restore / Delete-forever. */}
        <div className="fx-bottombar">
          <div className="fx-bottombar-actions">
            {(onUndo || onRedo) && (
              <>
                <Tooltip content={canUndo ? `Undo ${undoLabel}` : 'Nothing to undo'}>
                  <button
                    className="fx-tb-btn fx-tb-icon"
                    disabled={!canUndo}
                    onClick={() => onUndo?.()}
                  >
                    <Icon name="undo" className="fx-icon" />
                  </button>
                </Tooltip>
                <Tooltip content={canRedo ? `Redo ${redoLabel}` : 'Nothing to redo'}>
                  <button
                    className="fx-tb-btn fx-tb-icon"
                    disabled={!canRedo}
                    onClick={() => onRedo?.()}
                  >
                    <Icon name="redo" className="fx-icon" />
                  </button>
                </Tooltip>
                <div className="fx-tb-sep" />
              </>
            )}
            {!isBin ? (
              <>
                {/* Single "Create" button — a dropdown merging New folder with the
                    Build-with-AI file types. */}
                <div className="fx-menu-wrap" ref={createMenuRef}>
                  <Tooltip content="Create a folder or a new document">
                    <button
                      className="fx-tb-btn"
                      disabled={!canEdit}
                      onClick={() => setCreateMenuOpen((v) => !v)}
                    >
                      <Icon name="plus" className="fx-icon" />
                      <span>Create</span>
                      <Icon name="chev-up" className="fx-caret" />
                    </button>
                  </Tooltip>
                  {createMenuOpen && (
                    <div className="fx-menu is-up fx-create-menu" role="menu">
                      <button onClick={() => { setCreateMenuOpen(false); requestNewFolder(); }}>
                        <Icon name="folder-plus" className="fx-icon" /> New folder
                      </button>
                      {/* A party to the case rather than a document — it lands
                          in the project's Identities folder. */}
                      {onAddIdentity && (
                        <button onClick={() => { setCreateMenuOpen(false); onAddIdentity(); }}>
                          <Icon name="identity" className="fx-icon" /> Identity
                        </button>
                      )}
                      {onCreateTypedFile && (
                        <>
                          <div className="fx-create-menu-head">Build with AI</div>
                          <button onClick={() => { setCreateMenuOpen(false); onCreateTypedFile('docx'); }}>
                            <Icon name="file-doc" className="fx-icon fx-create-ico fx-create-ico-doc" /> Word document
                          </button>
                          <button onClick={() => { setCreateMenuOpen(false); onCreateTypedFile('pptx'); }}>
                            <Icon name="file-slides" className="fx-icon fx-create-ico fx-create-ico-ppt" /> PowerPoint presentation
                          </button>
                          <button onClick={() => { setCreateMenuOpen(false); onCreateTypedFile('xlsx'); }}>
                            <Icon name="file-sheet" className="fx-icon fx-create-ico fx-create-ico-xls" /> Excel spreadsheet
                          </button>
                          <button onClick={() => { setCreateMenuOpen(false); onCreateTypedFile('pdf'); }}>
                            <Icon name="file-pdf" className="fx-icon fx-create-ico fx-create-ico-pdf" /> PDF document
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <button className="fx-tb-btn" disabled={!canEdit} onClick={() => onUpload?.()}>
                  <Icon name="upload" className="fx-icon" /><span>Import</span>
                </button>
                <div className="fx-tb-sep" />
                <button className="fx-tb-btn" disabled={!selectedItem} onClick={(e) => selectedItem && openItem(selectedItem, e)}>
                  <Icon name="open" className="fx-icon" /><span>Open</span>
                </button>
                <button className="fx-tb-btn" disabled={!selectedItem || !canEdit} onClick={() => selectedItem && requestRename(selectedItem)}>
                  <Icon name="edit-pen" className="fx-icon" /><span>Rename</span>
                </button>
                <button
                  className="fx-tb-btn"
                  disabled={!canEdit || multiSelItems.length === 0}
                  onClick={() => bulkDelete()}
                >
                  <Icon name="trash" className="fx-icon" />
                  <span>Delete{multiSelItems.length > 1 ? ` (${multiSelItems.length})` : ''}</span>
                </button>
                {(onPasteItems || onMoveItems) && (
                  <>
                    <div className="fx-tb-sep" />
                    <Tooltip content="Copy (Ctrl+C)">
                      <button
                        className="fx-tb-btn"
                        disabled={!canEdit || (multiSel.size === 0 && !selectedItem)}
                        onClick={copySelection}
                      >
                        <Icon name="copy" className="fx-icon" /><span>Copy{multiSel.size > 1 ? ` (${multiSel.size})` : ''}</span>
                      </button>
                    </Tooltip>
                    {onMoveItems && (
                      <Tooltip content="Cut (Ctrl+X)">
                        <button
                          className="fx-tb-btn"
                          disabled={!canEdit || (multiSel.size === 0 && !selectedItem)}
                          onClick={cutSelection}
                        >
                          <Icon name="cut" className="fx-icon" /><span>Cut{multiSel.size > 1 ? ` (${multiSel.size})` : ''}</span>
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip content="Paste (Ctrl+V)">
                      <button
                        className="fx-tb-btn"
                        disabled={!canEdit || !canPaste}
                        onClick={pasteHere}
                      >
                        <Icon name="paste" className="fx-icon" /><span>Paste{clipboard?.items?.length > 1 ? ` (${clipboard.items.length})` : ''}</span>
                      </button>
                    </Tooltip>
                  </>
                )}
              </>
            ) : (
              <>
                <button className="fx-tb-btn" disabled={!selectedItem} onClick={(e) => selectedItem && openItem(selectedItem, e)}>
                  <Icon name="open" className="fx-icon" /><span>Open</span>
                </button>
                <button
                  className="fx-tb-btn"
                  disabled={multiSelItems.length === 0}
                  onClick={() => { multiSelItems.forEach((it) => onRestore?.(it)); exitSelectMode(); }}
                >
                  <Icon name="restore" className="fx-icon" /><span>Restore{multiSelItems.length > 1 ? ` (${multiSelItems.length})` : ''}</span>
                </button>
                <button
                  className="fx-tb-btn"
                  disabled={multiSelItems.length === 0}
                  onClick={() => bulkDelete()}
                >
                  <Icon name="trash" className="fx-icon" />
                  <span>Delete forever{multiSelItems.length > 1 ? ` (${multiSelItems.length})` : ''}</span>
                </button>
                {onDebugSeedTrash && (
                  <>
                    <div className="fx-tb-sep" />
                    <Tooltip content="DEV: spawn items expiring in 30/25/20/15/10/5/3/2/1 days">
                      <button className="fx-tb-btn" onClick={() => onDebugSeedTrash()}>
                        <Icon name="clock" className="fx-icon" /><span>Seed test items</span>
                      </button>
                    </Tooltip>
                  </>
                )}
              </>
            )}
            <div className="fx-tb-sep" />
            <button
              className={`fx-tb-btn${selectMode ? ' is-active' : ''}`}
              onClick={toggleSelectMode}
              aria-pressed={selectMode}
            >
              <Icon name="select" className="fx-icon" /><span>{selectMode ? 'Done' : 'Select'}</span>
            </button>
          </div>
          <div className="fx-bottombar-status">
            {/* No ambient file/folder tally — the masthead kicker carries the
                counts; the footer only reports an active selection. */}
            {multiSel.size > 0 && <span>{multiSel.size} selected</span>}
          </div>
        </div>

        {/* Background right-click menu (Import / New folder) — portalled. */}
        {bgMorph.node}
      </div>


      {aiConsentOpen && (
        <AiConsentModal onAccept={acceptAiConsent} onCancel={() => setAiConsentOpen(false)} />
      )}
      {propsItem && <PropertiesModal item={propsItem} onClose={() => setPropsItem(null)} />}
      {archivePrompt && (
        <ArchivePrompt
          item={archivePrompt.item}
          x={archivePrompt.x}
          y={archivePrompt.y}
          onExtract={() => { const it = archivePrompt.item; setArchivePrompt(null); onOpenContent?.(it); }}
          onClose={() => setArchivePrompt(null)}
        />
      )}
    </div>
  );
}

// ── AI search consent ──────────────────────────────────────────────────
// Shown before the FIRST AI search on a device. Everything else in the Files
// page is local — this is the one action that sends a matter's contents to a
// third party, and the people using this app owe their clients an answer about
// that, so the notice is specific rather than a vague "AI may be used".
function AiConsentModal({ onAccept, onCancel }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fx-consent-scrim"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="fx-consent" role="dialog" aria-modal="true" aria-labelledby="fx-consent-title">
        <h3 id="fx-consent-title" className="fx-consent-title">AI search sends this folder’s contents to Anthropic</h3>
        <p className="fx-consent-lead">
          Every other part of the Files page works on your machine alone. This one doesn’t —
          answering “find what I’m describing” means something has to read the files.
        </p>
        <ul className="fx-consent-list">
          <li><strong>Text from documents.</strong> A short excerpt of each readable file (Word, PDF, Excel, text) — about 700 characters.</li>
          <li><strong>Pictures and video frames.</strong> Downscaled, re-compressed stills. Small, but a person could still recognise a face or an ID card in one.</li>
          <li><strong>Filenames</strong> of everything in this folder.</li>
        </ul>
        <p className="fx-consent-note">
          <strong>Each file is read once.</strong> What comes back is a one-line description of what
          the file is, saved on this computer. Later searches are matched against those descriptions,
          so a document’s text and a photo’s image leave your machine a single time, not on every
          search. A file you edit is read again.
        </p>
        <p className="fx-consent-note">
          It goes to Anthropic’s business API, whose terms exclude your data from training their
          models. It is held about 30 days for abuse monitoring, then deleted. Nothing is sent
          unless you press the button, and nothing leaves for a normal (non-AI) search.
        </p>
        <p className="fx-consent-note">
          Consider whether the client material in this folder is something you may send to a
          processor outside your firm before continuing.
        </p>
        <div className="fx-consent-actions">
          <button type="button" className="fx-consent-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="fx-consent-btn is-primary" onClick={onAccept} autoFocus>
            I understand — search
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Search-hit row ─────────────────────────────────────────────────────
// One result in the "By content" / "AI" lists: the file on the left, the
// evidence on the right. `highlight` marks the searched text inside the
// snippet — only the literal pass passes it, since an AI reason is the model's
// own words and won't contain the query verbatim.
function HitRow({ item, snippet, highlight, fallback, selected, onSelect, onOpen }) {
  return (
    <div
      className={`fx-hit${selected ? ' is-selected' : ''}`}
      data-fx-id={item.id}
      onClick={(e) => onSelect(item, e)}
      onDoubleClick={(e) => onOpen(item, e)}
      role="button"
      tabIndex={-1}
    >
      <span className="fx-hit-thumb"><ItemThumbnail item={item} /></span>
      <span className="fx-hit-name" title={item.name}>{item.name}</span>
      <span className="fx-hit-snippet" title={snippet || ''}>
        {snippet ? <Marked text={snippet} needle={highlight} /> : fallback}
      </span>
    </div>
  );
}

// Wrap every case-insensitive occurrence of `needle` in <mark>. Split rather
// than innerHTML: the snippet is file content, so it must never be parsed as
// markup. A missing/empty needle renders the text unchanged.
function Marked({ text, needle }) {
  const q = (needle || '').trim();
  if (!q) return text;
  const lower = String(text).toLowerCase();
  const target = q.toLowerCase();
  const out = [];
  let at = 0;
  for (;;) {
    const found = lower.indexOf(target, at);
    if (found < 0) break;
    if (found > at) out.push(text.slice(at, found));
    out.push(<mark className="fx-hit-mark" key={found}>{text.slice(found, found + target.length)}</mark>);
    at = found + target.length;
  }
  if (!out.length) return text;
  if (at < text.length) out.push(text.slice(at));
  return out;
}

// ── Compressed-file prompt ─────────────────────────────────────────────
// Opening an archive has no useful default: a .zip unpacks into a sibling
// folder we then browse, anything else is handed to the OS archiver (see
// local-folder:extract-archive in main). So the double-click asks, in a card
// pinned to the pointer rather than a centred dialog — the answer belongs next
// to the file you just hit.
function ArchivePrompt({ item, x, y, onExtract, onClose }) {
  const cardRef = useRef(null);
  const isZip = /^zip$/i.test(item.ext || '');
  // Hidden until measured: the card has to know its own size before it can be
  // flipped away from a screen edge, and a visible jump would be worse.
  const [pos, setPos] = useState(x == null || y == null ? 'center' : null);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el || x == null || y == null) return;
    // Clamp in VIEWPORT px (what clientX and getBoundingClientRect speak),
    // then convert once — under the Settings display-scale the two spaces
    // differ, and left/top are layout px.
    const M = 12;                       // keep this much clear of every edge
    const { width: w, height: h } = el.getBoundingClientRect();
    let left = x + 8;
    let top = y + 8;
    if (left + w > window.innerWidth - M) left = x - w - 8;   // flip left
    if (top + h > window.innerHeight - M) top = y - h - 8;    // flip above
    setPos({ left: toLayoutPx(Math.max(M, left)), top: toLayoutPx(Math.max(M, top)) });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const style = pos === 'center' || pos == null
    ? undefined
    : { left: `${pos.left}px`, top: `${pos.top}px` };

  return (
    <div className="fx-arch-scrim" role="presentation" onMouseDown={onClose}>
      <div
        ref={cardRef}
        className={`fx-arch${pos === 'center' ? ' is-centered' : ''}${pos == null ? ' is-measuring' : ''}`}
        style={style}
        role="dialog"
        aria-label="Compressed file"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="fx-arch-head">
          <span className="fx-arch-glyph"><ExtGlyph ext={item.ext} /></span>
          <div className="fx-arch-heading">
            <h4>Compressed file</h4>
            <p className="fx-arch-name" title={item.name}>{item.name}</p>
          </div>
        </div>
        <p className="fx-arch-body">
          {isZip
            ? 'There’s nothing to preview inside an archive. Extract it to a folder here — you can undo it afterwards.'
            : 'There’s nothing to preview inside an archive. DocVex can’t unpack this format, so it opens in your system’s archiver.'}
        </p>
        <div className="fx-arch-actions">
          <button type="button" className="fx-arch-btn" onClick={onClose}>Close</button>
          <button type="button" className="fx-arch-btn is-primary" onClick={onExtract} autoFocus>
            {isZip ? 'Extract files' : 'Open in archiver'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Properties dialog ──────────────────────────────────────────────────
// Read-only inspector for a single file / folder, built from the item model
// the workspace already has (no extra fetch).
function PropertiesModal({ item, onClose }) {
  const isFolder = item.kind === 'folder';
  const typeLabel = item.binEntry
    ? 'Trash'
    : isFolder
    ? 'Folder'
    : (item.ext ? `${item.ext.toUpperCase()} file` : 'File');
  const location = isFolder
    ? (item._dir?.path || item.path || '')
    : (item._raw?.path || '');
  const statusLabel = STATUS_LABEL[item.status] || 'Up to date';
  const rows = [
    ['Name', item.name],
    ['Type', typeLabel],
    item.sizeLabel && ['Size', item.sizeLabel],
    item.modifiedLabel && ['Modified', item.modifiedLabel],
    ['Status', statusLabel],
    !isFolder && item.author && ['Edited by', item.author],
    location && ['Location', location, true],
  ].filter(Boolean);
  return (
    <div className="fx-props-scrim" role="presentation" onClick={onClose}>
      <div className="fx-props" role="dialog" aria-label="Properties" onClick={(e) => e.stopPropagation()}>
        <div className="fx-props-head">
          <h3>Properties</h3>
          <button className="fx-drawer-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="fx-props-thumb">
          {isFolder ? <FolderGlyph filled={!item.empty} /> : <ItemThumbnail item={item} />}
        </div>
        <dl className="fx-props-list">
          {rows.map(([label, value, isPath]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className={isPath ? 'fx-props-path' : undefined}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

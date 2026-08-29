import React from 'react';
import { DOCX_MIME, PPTX_MIME } from '../lib/thumbnails';
import './fileGlyph.css';

// Office Open XML + legacy binary MIME types, kept here next to the
// glyph dispatcher (thumbnails.js only exports the two it needs).
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOC_MIME = 'application/msword';
const PPT_MIME = 'application/vnd.ms-powerpoint';
const XLS_MIME = 'application/vnd.ms-excel';

// The whole app's file icons. <ExtGlyph/> is the artwork (it was the Files
// tab's, hence the `fx-` class names and fileGlyph.css) and glyphForFile() is
// the MIME/filename → glyph dispatcher every other surface calls — the
// sidebar's open-file rows, Activity, the project list, the doc-viewer tabs.
//
// Those surfaces used to get a SEPARATE set of line-art glyphs defined here,
// so the same file wore one icon in the Files tab and a different one in the
// rail. That set is gone; there is one style now, and a glyph tweak lands
// everywhere at once.
//
// Sizing is the host's job: `.fx-glyph` fills the box it's given, so a 17px
// sidebar row and a zoomable Files tile share artwork without sharing scale.

// ── Microsoft Office file icons ─────────────────────────────────────
// Authentic Word / Excel / PowerPoint file icons: a white document with
// faint brand-coloured content hints and the app's letter badge sitting on
// the lower-left corner — the recognizable real Office look, in Microsoft's
// own brand colours (not the app palette). Full-colour SVGs (explicit fills,
// not currentColor), so the container's accent colour doesn't affect them.
const OFFICE_SPECS = {
  word: {
    color: '#185ABD',
    letter: 'W',
    content: (
      <path d="M6.8 5.9h10.4M6.8 8.5h10.4M6.8 11.1h7" stroke="#185ABD" strokeOpacity="0.5" strokeWidth="1.25" strokeLinecap="round" />
    ),
  },
  excel: {
    color: '#107C41',
    letter: 'X',
    content: (
      <path d="M6.8 6.1h10.4M6.8 9h10.4M10.6 4.6v6.9M14.1 4.6v6.9" stroke="#107C41" strokeOpacity="0.5" strokeWidth="1.1" />
    ),
  },
  ppt: {
    color: '#C43E1C',
    letter: 'P',
    content: (
      <>
        <circle cx="9.3" cy="7.6" r="3.1" fill="none" stroke="#C43E1C" strokeOpacity="0.5" strokeWidth="1.2" />
        <path d="M14.2 6h3.2M14.2 8.5h3.2M14.2 11h3.2" stroke="#C43E1C" strokeOpacity="0.5" strokeWidth="1.2" strokeLinecap="round" />
      </>
    ),
  },
};

export function OfficeFileIcon({ kind, className }) {
  const s = OFFICE_SPECS[kind] || OFFICE_SPECS.word;
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" style={{ width: '100%', height: '100%' }}>
      <rect x="4.6" y="2.5" width="14.8" height="19" rx="1.7" fill="#fff" stroke="rgba(0,0,0,0.16)" strokeWidth="0.8" />
      {s.content}
      <rect x="1.8" y="11.4" width="11" height="10.1" rx="1.8" fill={s.color} />
      <text x="7.3" y="19.3" textAnchor="middle" fontFamily="var(--font-display, sans-serif)" fontSize="8.6" fontWeight="700" fill="#fff">{s.letter}</text>
    </svg>
  );
}



// MIME → a representative extension, for callers that only know the type.
// Only consulted when the filename doesn't carry a usable extension.
function extFromMime(mime) {
  const m = (mime || '').toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m === DOCX_MIME || m === DOC_MIME) return 'docx';
  if (m === PPTX_MIME || m === PPT_MIME) return 'pptx';
  if (m === XLSX_MIME || m === XLS_MIME) return 'xlsx';
  if (m === 'application/zip' || m === 'application/x-zip-compressed') return 'zip';
  if (m.startsWith('image/')) return 'png';
  if (m.startsWith('video/')) return 'mp4';
  if (m.startsWith('audio/')) return 'mp3';
  if (m.startsWith('text/')) return 'txt';
  return '';
}

// Pick the glyph for a given MIME + filename. Filename matters because
// DOCX-like files sometimes upload with mime_type='application/octet-stream'
// when the OS didn't resolve the type before upload — falling back to the
// extension catches those. The reverse is also true (a name with no extension,
// or a trailing "v1.2" that only looks like one), so a name-derived extension
// is only trusted when it's a type we actually recognise.
//
// Returns the SAME <ExtGlyph/> the Files tab paints. It used to return a
// separate set of line-art glyphs, which is why a file could wear one icon in
// the Files tab and a different one in the sidebar; there is now one style.
export function glyphForFile(mime, name) {
  const named = /\.([a-z0-9]{1,5})$/i.exec(String(name || '').trim());
  const namedExt = named ? named[1].toLowerCase() : '';
  const ext = (namedExt && extCategory(namedExt) !== 'gen') ? namedExt : (extFromMime(mime) || namedExt);
  return <ExtGlyph ext={ext} />;
}

// File-type → category for the colored ext-label glyph (from the design).
export function extCategory(ext) {
  const e = (ext || '').toLowerCase();
  // DocVex's own record format (`<Name>.dvx`) — a party to the case. The
  // Files tab refines this to 'identity-org' once it has read the record's
  // kind, so a company wears a facade instead of a bust. See lib/identities.js.
  if (e === 'dvx' || e === 'identity') return 'identity';
  if (e === 'identity-org') return e;
  if (e === 'pdf') return 'pdf';
  // Word and everything it can save/export to (incl. templates, macro-enabled,
  // RTF and the OpenDocument / Pages equivalents).
  if (['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'rtf', 'odt', 'pages'].includes(e)) return 'doc';
  // Excel and everything it can save/export to (workbooks, macro-enabled,
  // binary, templates, CSV and the OpenDocument / Numbers equivalents).
  if (['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm', 'csv', 'ods', 'numbers'].includes(e)) return 'xls';
  // PowerPoint and everything it can save/export to (decks, macro-enabled,
  // shows, templates and the OpenDocument / Keynote equivalents).
  if (['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'ppsm', 'pot', 'potx', 'potm', 'odp', 'key'].includes(e)) return 'ppt';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return 'zip';
  if (e === 'psd') return 'psd';
  if (e === 'ai') return 'ai';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'bmp', 'tif', 'tiff'].includes(e)) return 'img';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(e)) return 'vid';
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus', 'wma', 'aif', 'aiff'].includes(e)) return 'aud';
  if (['txt', 'md', 'rtf', 'log'].includes(e)) return 'txt';
  return 'gen';
}

// Colored ext-label badge — shown for files with no real preview.
export function ExtGlyph({ ext }) {
  const cat = extCategory(ext);
  // Videos read as a video at a glance: a centred play triangle, with the
  // format tucked into the corner.
  if (cat === 'vid') {
    return (
      <span className="fx-glyph fx-glyph-vid">
        <svg className="fx-glyph-play" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.78-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z" fill="currentColor" />
        </svg>
      </span>
    );
  }
  // Audio reads as audio at a glance: a decibel line — a row of equalizer bars
  // of varying heights (a sound waveform / level meter).
  if (cat === 'aud') {
    return (
      <span className="fx-glyph fx-glyph-aud">
        <svg className="fx-glyph-audio" viewBox="0 0 24 24" aria-hidden="true">
          <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 10.5v3" />
            <path d="M6.5 7.5v9" />
            <path d="M10 4.5v15" />
            <path d="M13.5 8.5v7" />
            <path d="M17 6v12" />
            <path d="M20.5 9.5v5" />
          </g>
        </svg>
      </span>
    );
  }
  // Identity records read as WHO they describe, not as a file: a person's bust
  // for an individual, a building for an organisation.
  if (cat === 'identity' || cat === 'identity-org') {
    return (
      <span className="fx-glyph fx-glyph-icon fx-glyph-identity">
        <svg className="fx-type-icon" viewBox="0 0 24 24" aria-hidden="true">
          <rect className="fx-type-base" x="4.4" y="3.6" width="15.2" height="16.8" rx="2.4" />
          {cat === 'identity' ? (
            <g className="fx-idn-mark">
              <circle cx="12" cy="10" r="2.6" />
              <path d="M7.4 17.4a4.9 4.9 0 0 1 9.2 0" />
            </g>
          ) : (
            <g className="fx-idn-mark">
              <path d="M8.4 17.6V8.2h7.2v9.4" />
              <path d="M10.4 10.6h1.2M13.4 10.6h1.2M10.4 13.2h1.2M13.4 13.2h1.2" />
            </g>
          )}
        </svg>
      </span>
    );
  }
  // Microsoft Office files use authentic Office file icons — a white document
  // with the brand-colour letter badge (Word / Excel / PowerPoint).
  if (cat === 'doc') {
    return <span className="fx-glyph fx-glyph-icon"><OfficeFileIcon kind="word" className="fx-type-icon" /></span>;
  }
  if (cat === 'xls') {
    return <span className="fx-glyph fx-glyph-icon"><OfficeFileIcon kind="excel" className="fx-type-icon" /></span>;
  }
  // Archives (zip / rar / 7z / tar / gz) read as a zipped folder, Windows-style:
  // a folder with a zipper (teeth + pull) down the middle.
  if (cat === 'zip') {
    return (
      <span className="fx-glyph fx-glyph-icon">
        <svg className="fx-type-icon" viewBox="0 0 24 24" aria-hidden="true">
          {/* folder */}
          <path className="fx-type-base" d="M2.6 6.6a2.2 2.2 0 0 1 2.2-2.2h4.2l2 2h8.2a2.2 2.2 0 0 1 2.2 2.2v8.6a2.2 2.2 0 0 1-2.2 2.2H4.8a2.2 2.2 0 0 1-2.2-2.2z" />
          {/* zipper teeth (thick dashed line down the middle) */}
          <line className="fx-zip-teeth" x1="12" y1="9.2" x2="12" y2="19.3" />
          {/* zipper pull — slider + tab */}
          <circle className="fx-type-detail" cx="12" cy="9.4" r="1.8" />
          <rect className="fx-type-detail" x="11.25" y="9.4" width="1.5" height="3.5" rx="0.75" />
        </svg>
      </span>
    );
  }
  // Image types (img / psd) — a picture: a frame with a sun + mountains.
  if (cat === 'img' || cat === 'psd') {
    return (
      <span className="fx-glyph fx-glyph-icon">
        <svg className="fx-type-icon" viewBox="0 0 24 24" aria-hidden="true">
          <rect className="fx-type-base" x="3" y="4" width="18" height="16" rx="2.6" />
          <circle className="fx-type-detail" cx="8.5" cy="9.5" r="2" />
          <path className="fx-type-detail" d="M4 19 L9.5 12.5 L13 16 L16 12.5 L20 19 Z" />
        </svg>
      </span>
    );
  }
  // PowerPoint — authentic Office file icon (see doc/xls above).
  if (cat === 'ppt') {
    return <span className="fx-glyph fx-glyph-icon"><OfficeFileIcon kind="ppt" className="fx-type-icon" /></span>;
  }
  // Everything else (doc / txt / pdf / ai / generic) — a document with text
  // lines. This is the "we have no icon for this type" case, so the tile also
  // gets a corner pill naming the extension (see .fx-ext-pill, shown by CSS
  // only when this generic glyph is what's painted).
  return (
    <span className="fx-glyph fx-glyph-icon fx-glyph-generic">
      <svg className="fx-type-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect className="fx-type-base" x="4" y="2.5" width="16" height="19" rx="2.6" />
        <rect className="fx-type-detail" x="7" y="7" width="10" height="1.8" rx="0.9" />
        <rect className="fx-type-detail" x="7" y="11" width="10" height="1.8" rx="0.9" />
        <rect className="fx-type-detail" x="7" y="15" width="7" height="1.8" rx="0.9" />
      </svg>
    </span>
  );
}

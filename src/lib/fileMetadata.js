// File metadata extraction for the Doc Viewer's Metadata tab.
//
// Two layers:
//   • Filesystem facts — size + created / modified / accessed + permissions,
//     from localFolderApi.stat (Node's fs.stat on Electron, the File object's
//     lastModified on web). Nothing inside the bytes can tell you these.
//   • Embedded metadata — whatever the format itself carries: EXIF for JPEG,
//     the IHDR/text chunks for PNG, the PDF info dictionary, OOXML core/app
//     properties for Word / Excel / PowerPoint, duration + dimensions for
//     audio/video, and counts for plain text. Plus a SHA-256 of the bytes,
//     which is the thing you actually cite when a document's integrity is
//     questioned.
//
// Everything is best-effort and independent: one format parser throwing never
// loses the other groups — it lands in `warnings` and the rest still renders.
// No new dependencies: OOXML is unzipped with DecompressionStream, EXIF is
// parsed by hand (see readExif), PDFs reuse the app's pdf.js.

import { localFolderApi, readLocalBlob } from './localFolder';
import { loadPdfModule } from './pdfWorker';

// Cap the digest to something that stays responsive on a slow disk; larger
// files report their size instead of a hash.
const MAX_HASH_BYTES = 256 * 1024 * 1024;

export function formatBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b < 0) return '—';
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]} (${b.toLocaleString()} bytes)`;
}

function formatWhen(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatDuration(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const two = (n) => String(Math.floor(n)).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

function extOf(name) {
  const i = (name || '').lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

// A row is dropped when its value is null/'' — parsers can emit optimistically.
function group(id, title, rows) {
  const kept = (rows || []).filter((r) => r && r.value !== null && r.value !== undefined && r.value !== '');
  return kept.length ? { id, title, rows: kept } : null;
}

// ── ZIP (OOXML) ────────────────────────────────────────────────────────────
// Minimal reader for ONE named entry: walk the End-of-Central-Directory record
// back to the central directory, find the entry, then inflate its raw deflate
// stream with DecompressionStream. Enough for docProps/*.xml, which is all the
// metadata tab needs — no zip dependency for a 200-byte XML file.
async function readZipEntry(blob, wanted) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  // EOCD signature (PK\5\6), scanned from the end over the max comment length.
  let eocd = -1;
  const from = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= from; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip container');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // central directory offset
  const dec = new TextDecoder();
  for (let i = 0; i < count; i += 1) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      // Local header: the name/extra lengths differ from the central copy.
      const lNameLen = dv.getUint16(localOffset + 26, true);
      const lExtraLen = dv.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const bytes = buf.subarray(start, start + compSize);
      if (method === 0) return dec.decode(bytes);
      if (method !== 8) throw new Error(`Unsupported zip compression (${method})`);
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return await new Response(stream).text();
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function xmlText(xml, tag) {
  if (!xml) return null;
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return null;
  const v = m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim();
  return v || null;
}

// ── EXIF (JPEG APP1) ───────────────────────────────────────────────────────
// Hand-rolled TIFF-header walk over the IFD0 + Exif sub-IFD + GPS IFD tags the
// panel shows. Returns a flat {tagName: value} map; unknown tags are skipped.
const EXIF_TAGS = {
  0x010f: 'Make', 0x0110: 'Model', 0x0112: 'Orientation', 0x0131: 'Software',
  0x0132: 'DateTime', 0x013b: 'Artist', 0x8298: 'Copyright',
  0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8827: 'ISO',
  0x9003: 'DateTimeOriginal', 0x920a: 'FocalLength', 0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension', 0x9286: 'UserComment', 0xa434: 'LensModel',
};
const GPS_TAGS = { 1: 'GPSLatitudeRef', 2: 'GPSLatitude', 3: 'GPSLongitudeRef', 4: 'GPSLongitude', 6: 'GPSAltitude' };
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readExifValue(dv, entry, tiff, le) {
  const type = dv.getUint16(entry + 2, le);
  const count = dv.getUint32(entry + 4, le);
  const size = (TYPE_SIZE[type] || 0) * count;
  if (!size) return null;
  const at = size > 4 ? tiff + dv.getUint32(entry + 8, le) : entry + 8;
  if (type === 2) {
    let s = '';
    for (let i = 0; i < count; i += 1) {
      const c = dv.getUint8(at + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s.trim() || null;
  }
  const readOne = (i) => {
    const o = at + i * TYPE_SIZE[type];
    if (type === 1 || type === 7) return dv.getUint8(o);
    if (type === 3) return dv.getUint16(o, le);
    if (type === 4) return dv.getUint32(o, le);
    if (type === 9) return dv.getInt32(o, le);
    if (type === 5) { const d = dv.getUint32(o + 4, le); return d ? dv.getUint32(o, le) / d : 0; }
    if (type === 10) { const d = dv.getInt32(o + 4, le); return d ? dv.getInt32(o, le) / d : 0; }
    return null;
  };
  const values = [];
  for (let i = 0; i < Math.min(count, 8); i += 1) values.push(readOne(i));
  return values.length === 1 ? values[0] : values;
}

function readIfd(dv, ifd, tiff, le, names, out) {
  const n = dv.getUint16(ifd, le);
  let exifOffset = null;
  let gpsOffset = null;
  for (let i = 0; i < n; i += 1) {
    const entry = ifd + 2 + i * 12;
    const tag = dv.getUint16(entry, le);
    if (tag === 0x8769) { exifOffset = dv.getUint32(entry + 8, le); continue; }
    if (tag === 0x8825) { gpsOffset = dv.getUint32(entry + 8, le); continue; }
    const name = names[tag];
    if (!name) continue;
    const value = readExifValue(dv, entry, tiff, le);
    if (value !== null) out[name] = value;
  }
  return { exifOffset, gpsOffset };
}

function readExif(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(0) !== 0xffd8) return null;         // not a JPEG
  let p = 2;
  while (p + 4 < bytes.length) {
    if (dv.getUint8(p) !== 0xff) break;
    const marker = dv.getUint8(p + 1);
    const len = dv.getUint16(p + 2);
    if (marker === 0xe1) {
      // "Exif\0\0" then a TIFF header.
      const tiff = p + 10;
      if (tiff + 8 > bytes.length) return null;
      const le = dv.getUint16(tiff) === 0x4949;
      const out = {};
      const first = tiff + dv.getUint32(tiff + 4, le);
      const { exifOffset, gpsOffset } = readIfd(dv, first, tiff, le, EXIF_TAGS, out);
      if (exifOffset) readIfd(dv, tiff + exifOffset, tiff, le, EXIF_TAGS, out);
      if (gpsOffset) readIfd(dv, tiff + gpsOffset, tiff, le, GPS_TAGS, out);
      return Object.keys(out).length ? out : null;
    }
    if (marker === 0xda) break;   // start of scan — no metadata past here
    p += 2 + len;
  }
  return null;
}

const ORIENTATIONS = {
  1: 'Normal', 2: 'Mirrored', 3: 'Rotated 180°', 4: 'Mirrored, 180°',
  5: 'Mirrored, 90° CCW', 6: 'Rotated 90° CW', 7: 'Mirrored, 90° CW', 8: 'Rotated 90° CCW',
};

function gpsDecimal(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  const [d, m, s] = dms;
  const sign = (ref === 'S' || ref === 'W') ? -1 : 1;
  const v = sign * (Number(d) + Number(m) / 60 + Number(s) / 3600);
  return Number.isFinite(v) ? v.toFixed(6) : null;
}

// ── Per-format extractors ──────────────────────────────────────────────────
async function imageGroups(blob, mime, name, warnings) {
  const out = [];
  const facts = [];
  try {
    const bmp = await createImageBitmap(blob);
    facts.push({ label: 'Dimensions', value: `${bmp.width} × ${bmp.height} px` });
    facts.push({ label: 'Megapixels', value: `${((bmp.width * bmp.height) / 1e6).toFixed(1)} MP` });
    facts.push({ label: 'Aspect ratio', value: (bmp.width / bmp.height).toFixed(3) });
    bmp.close?.();
  } catch { warnings.push('Could not decode the image for dimensions.'); }

  const ext = extOf(name);
  if (mime === 'image/jpeg' || ext === 'jpg' || ext === 'jpeg') {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const exif = readExif(bytes);
      if (exif) {
        const rows = [
          { label: 'Camera', value: [exif.Make, exif.Model].filter(Boolean).join(' ') || null },
          { label: 'Lens', value: exif.LensModel || null },
          { label: 'Taken', value: exif.DateTimeOriginal || exif.DateTime || null },
          { label: 'Exposure', value: exif.ExposureTime ? `${exif.ExposureTime < 1 ? `1/${Math.round(1 / exif.ExposureTime)}` : exif.ExposureTime} s` : null },
          { label: 'Aperture', value: exif.FNumber ? `f/${Number(exif.FNumber).toFixed(1)}` : null },
          { label: 'ISO', value: exif.ISO ?? null },
          { label: 'Focal length', value: exif.FocalLength ? `${Math.round(exif.FocalLength)} mm` : null },
          { label: 'Orientation', value: ORIENTATIONS[exif.Orientation] || null },
          { label: 'Software', value: exif.Software || null },
          { label: 'Artist', value: exif.Artist || null },
          { label: 'Copyright', value: exif.Copyright || null },
        ];
        const lat = gpsDecimal(exif.GPSLatitude, exif.GPSLatitudeRef);
        const lon = gpsDecimal(exif.GPSLongitude, exif.GPSLongitudeRef);
        if (lat && lon) rows.push({ label: 'GPS', value: `${lat}, ${lon}`, hint: 'Location recorded by the camera' });
        const g = group('exif', 'Camera (EXIF)', rows);
        if (g) out.push(g);
      }
    } catch { warnings.push('EXIF block could not be read.'); }
  }

  const g = group('image', 'Image', facts);
  if (g) out.unshift(g);
  return out;
}

async function pdfGroups(blob, warnings) {
  try {
    const pdfjs = await loadPdfModule();
    const data = new Uint8Array(await blob.arrayBuffer());
    const doc = await pdfjs.getDocument({ data }).promise;
    try {
      const meta = await doc.getMetadata();
      const info = meta?.info || {};
      // PDF dates are 'D:YYYYMMDDHHmmSS…' — show the readable part.
      const pdfDate = (d) => {
        if (typeof d !== 'string') return null;
        const m = d.match(/^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
        if (!m) return d;
        const [, y, mo, da, h = '00', mi = '00', s = '00'] = m;
        return formatWhen(`${y}-${mo}-${da}T${h}:${mi}:${s}`) || d;
      };
      let pageSize = null;
      try {
        const page = await doc.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        // PDF units are 1/72", so /72 gives inches and ×25.4 gives mm.
        pageSize = `${Math.round(vp.width)} × ${Math.round(vp.height)} pt (${(vp.width / 72 * 25.4).toFixed(0)} × ${(vp.height / 72 * 25.4).toFixed(0)} mm)`;
      } catch { /* page 1 unreadable — skip the row */ }
      return [group('pdf', 'PDF', [
        { label: 'Pages', value: doc.numPages },
        { label: 'Page size', value: pageSize },
        { label: 'Title', value: info.Title || null },
        { label: 'Author', value: info.Author || null },
        { label: 'Subject', value: info.Subject || null },
        { label: 'Keywords', value: info.Keywords || null },
        { label: 'Creator', value: info.Creator || null },
        { label: 'Producer', value: info.Producer || null },
        { label: 'Created', value: pdfDate(info.CreationDate) },
        { label: 'Modified', value: pdfDate(info.ModDate) },
        { label: 'PDF version', value: info.PDFFormatVersion || null },
        { label: 'Encrypted', value: info.IsEncrypted ? 'Yes' : 'No' },
        { label: 'Linearized', value: info.IsLinearized ? 'Yes (fast web view)' : null },
      ])].filter(Boolean);
    } finally {
      try { doc.destroy(); } catch { /* already gone */ }
    }
  } catch {
    warnings.push('PDF structure could not be parsed.');
    return [];
  }
}

async function ooxmlGroups(blob, warnings) {
  try {
    const core = await readZipEntry(blob, 'docProps/core.xml');
    const appx = await readZipEntry(blob, 'docProps/app.xml').catch(() => null);
    const rows = [
      { label: 'Title', value: xmlText(core, 'dc:title') },
      { label: 'Subject', value: xmlText(core, 'dc:subject') },
      { label: 'Author', value: xmlText(core, 'dc:creator') },
      { label: 'Last saved by', value: xmlText(core, 'cp:lastModifiedBy') },
      { label: 'Revision', value: xmlText(core, 'cp:revision') },
      { label: 'Created', value: formatWhen(xmlText(core, 'dcterms:created')) },
      { label: 'Modified', value: formatWhen(xmlText(core, 'dcterms:modified')) },
      { label: 'Last printed', value: formatWhen(xmlText(core, 'cp:lastPrinted')) },
      { label: 'Category', value: xmlText(core, 'cp:category') },
      { label: 'Keywords', value: xmlText(core, 'cp:keywords') },
      { label: 'Description', value: xmlText(core, 'dc:description') },
    ];
    const stats = [
      { label: 'Application', value: xmlText(appx, 'Application') },
      { label: 'App version', value: xmlText(appx, 'AppVersion') },
      { label: 'Company', value: xmlText(appx, 'Company') },
      { label: 'Manager', value: xmlText(appx, 'Manager') },
      { label: 'Template', value: xmlText(appx, 'Template') },
      { label: 'Pages', value: xmlText(appx, 'Pages') },
      { label: 'Slides', value: xmlText(appx, 'Slides') },
      { label: 'Words', value: xmlText(appx, 'Words') },
      { label: 'Characters', value: xmlText(appx, 'Characters') },
      { label: 'Paragraphs', value: xmlText(appx, 'Paragraphs') },
      { label: 'Editing time', value: (() => {
        const m = Number(xmlText(appx, 'TotalTime'));
        return Number.isFinite(m) && m > 0 ? `${Math.floor(m / 60)}h ${m % 60}m` : null;
      })() },
    ];
    return [
      group('office', 'Document properties', rows),
      group('office-stats', 'Document statistics', stats),
    ].filter(Boolean);
  } catch {
    warnings.push('Office properties could not be read (the file may not be a valid OOXML package).');
    return [];
  }
}

async function mediaGroups(blob, mime, warnings) {
  const isVideo = (mime || '').startsWith('video/');
  const url = URL.createObjectURL(blob);
  try {
    const el = document.createElement(isVideo ? 'video' : 'audio');
    el.preload = 'metadata';
    el.src = url;
    await new Promise((resolve, reject) => {
      const done = () => resolve();
      el.addEventListener('loadedmetadata', done, { once: true });
      el.addEventListener('error', () => reject(new Error('media')), { once: true });
      setTimeout(() => reject(new Error('timeout')), 8000);
    });
    const rows = [
      { label: 'Duration', value: formatDuration(el.duration) },
      isVideo ? { label: 'Dimensions', value: el.videoWidth ? `${el.videoWidth} × ${el.videoHeight} px` : null } : null,
      isVideo && el.videoWidth ? { label: 'Aspect ratio', value: (el.videoWidth / el.videoHeight).toFixed(3) } : null,
      { label: 'Average bitrate', value: el.duration ? `${Math.round((blob.size * 8) / el.duration / 1000)} kbps` : null },
    ].filter(Boolean);
    return [group('media', isVideo ? 'Video' : 'Audio', rows)].filter(Boolean);
  } catch {
    warnings.push('Media could not be probed for duration.');
    return [];
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function textGroups(blob) {
  const text = await blob.text();
  const lines = text.split(/\r\n|\r|\n/);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const eol = text.includes('\r\n') ? 'Windows (CRLF)' : text.includes('\r') ? 'Classic Mac (CR)' : 'Unix (LF)';
  return [group('text', 'Text', [
    { label: 'Characters', value: text.length.toLocaleString() },
    { label: 'Words', value: words.toLocaleString() },
    { label: 'Lines', value: lines.length.toLocaleString() },
    { label: 'Line endings', value: eol },
    { label: 'Byte-order mark', value: text.charCodeAt(0) === 0xfeff ? 'Present (UTF-8 BOM)' : 'None' },
  ])].filter(Boolean);
}

async function sha256(blob) {
  if (!crypto?.subtle || blob.size > MAX_HASH_BYTES) return null;
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const OOXML_EXT = new Set(['docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm']);

// Extract everything we can about one file.
//   file: { name, path, mimeType | mime }
// Returns { groups: [{ id, title, rows: [{label, value, hint?}] }], warnings }.
// Never rejects for a format-level failure — those land in `warnings`.
export async function extractFileMetadata(file) {
  const name = file?.name || '';
  const filePath = file?.path || name;
  const mime = file?.mimeType || file?.mime || '';
  const ext = extOf(name);
  const warnings = [];
  const groups = [];

  // 1. Filesystem facts.
  let stat = null;
  try { stat = await localFolderApi.stat(filePath); } catch { /* handled below */ }
  if (stat?.error) warnings.push(stat.error);

  // 2. The bytes (needed by every format parser + the digest).
  let blob = null;
  try { blob = await readLocalBlob(filePath); } catch (err) {
    warnings.push(err?.message || 'The file could not be read from disk.');
  }

  const sizeBytes = stat?.sizeBytes ?? blob?.size ?? null;
  const fileGroup = group('file', 'File', [
    { label: 'Name', value: name },
    { label: 'Type', value: mime || (ext ? `${ext.toUpperCase()} file` : 'Unknown') },
    { label: 'Extension', value: ext ? `.${ext}` : null },
    { label: 'Size', value: sizeBytes != null ? formatBytes(sizeBytes) : null },
    { label: 'Location', value: stat?.dir || (file?.path ? null : 'Connected folder') },
    { label: 'Modified', value: formatWhen(stat?.mtimeIso) },
    { label: 'Created', value: formatWhen(stat?.birthtimeIso) },
    { label: 'Metadata changed', value: formatWhen(stat?.ctimeIso) },
    { label: 'Last opened', value: formatWhen(stat?.atimeIso) },
    { label: 'Permissions', value: stat?.mode || null },
  ]);
  if (fileGroup) groups.push(fileGroup);

  if (blob) {
    // 3. Format-specific groups — each isolated so one failure isn't fatal.
    try {
      if ((mime || '').startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) {
        groups.push(...await imageGroups(blob, mime, name, warnings));
      } else if (mime === 'application/pdf' || ext === 'pdf') {
        groups.push(...await pdfGroups(blob, warnings));
      } else if (OOXML_EXT.has(ext)) {
        groups.push(...await ooxmlGroups(blob, warnings));
      } else if ((mime || '').startsWith('audio/') || (mime || '').startsWith('video/')
        || ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) {
        groups.push(...await mediaGroups(blob, mime, warnings));
      } else if ((mime || '').startsWith('text/') || ['txt', 'md', 'csv', 'json', 'xml', 'log', 'html', 'js', 'css'].includes(ext)) {
        groups.push(...await textGroups(blob));
      }
    } catch (err) {
      warnings.push(err?.message || 'Format-specific metadata could not be read.');
    }

    // 4. Integrity — the hash you cite when a document's authenticity is
    //    challenged. Skipped for very large files (see MAX_HASH_BYTES).
    try {
      const hash = await sha256(blob);
      const g = group('digest', 'Integrity', [
        { label: 'SHA-256', value: hash, hint: 'Fingerprint of the exact bytes on disk' },
        { label: 'Note', value: hash ? null : `File is larger than ${formatBytes(MAX_HASH_BYTES).split(' (')[0]} — digest skipped` },
      ]);
      if (g) groups.push(g);
    } catch { warnings.push('Checksum could not be computed.'); }
  }

  return { groups, warnings, extractedAt: new Date().toISOString() };
}

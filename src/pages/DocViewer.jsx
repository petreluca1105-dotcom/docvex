import React, { useCallback, useContext, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import FilePreview from '../components/FilePreview';
import CursorSpotlight from '../components/CursorSpotlight';
import Tooltip from '../components/Tooltip';
import { useMorphPill } from '../components/useMorphPill';
import { localFolderApi, readLocalBlob } from '../lib/localFolder';
import { getCachedPdf } from '../lib/pdfCache';
// Cursor coords / innerWidth / DOMRects are viewport px; the left/top/width
// CSS we set are layout px — under the app's CSS-zoom downscale the two
// differ (see lib/appZoom).
import { toLayoutPx } from '../lib/appZoom';
import { recognizeCanvas, OCR_MAX_EDGE } from '../lib/ocr';
import { loadOcrHistory, saveOcrHistory } from '../lib/extractionHistory';
import { loadCaptions, saveCaptions, clearCaptions } from '../lib/captionsHistory';
import { useNotifications } from '../context/NotificationsContext';
import { loadEnvelope, saveEnvelope } from '../lib/audioEnvelopeCache';
import { loadCaptionSettings, saveCaptionSettings } from '../lib/captionPosition';
import { transcribeAudio } from '../lib/transcribe';
import { askProjectAi, AI_MODELS, DEFAULT_AI_MODEL, coerceModel, makeAskAnswers } from '../lib/projectAi';
import { useAppPrefs } from '../context/AppPrefsContext';
import AskUserPanel from '../components/AskUserPanel';
import TokenUsagePill from '../components/TokenUsagePill';
import { docKindFromName, buildDocumentBlobSmart, mimeForKind, inferDocKind, withKindExtension, labelForKind } from '../lib/documentGen';
import { renderedOfficeToPdfBlob } from '../lib/exportPdf';
import { loadConversation, saveConversation, clearConversation } from '../lib/conversationHistory';
import { isElectron, extractDocText, openExternal, onFilesRemoved, notifyFilesChanged, setDocViewerAiStatus, onDocViewerOpenFile, notifyDocViewerWarmReady, notifyDocViewerFilePainted } from '../lib/platform';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { extractFileText } from '../lib/extractFileText';
import { extractFileMetadata } from '../lib/fileMetadata';
import { loadMetadata, saveMetadata } from '../lib/metadataHistory';
import { parseWhatsAppChat, splitTimestamp } from '../lib/whatsappChat';
import gavelLoader from '../gavel-loader.svg';
import './DocViewer.css';
// The Generate tab's chat reuses the main app's AI-advisor bubbles/markdown so it
// looks identical. Those rules are scoped under .ai-hub / .ai-chat-page (we apply
// both classes to the thread wrapper); width is neutralised in DocViewer.css.
import './Projects/ProjectAI.css';
import './Projects/ProjectAIChat.css';

// Full-screen document viewer window (opened from the Files page when a file
// is double-clicked). Each opened file gets its OWN window — the file arrives in
// the query string and the window previews just that one document: image /
// video / PDF / text via FilePreview, .docx via docx-preview, and a fallback
// (with an OS-open button) for everything else.

// `thumb` asks the localfile handler for a downscaled copy (see main.js) —
// the chat/rail never paint full-resolution photos, which is what made
// media-heavy conversations drop frames while scrolling. Non-image formats
// (and webp/gif, which keep animation + alpha) ignore the param and stream
// the original bytes.
function localUrlFor(path, thumb) {
  if (!path) return null;
  const base = `localfile://local/${encodeURIComponent(path)}`;
  return thumb ? `${base}?thumb=${thumb}` : base;
}

// Web build: the viewer opens in its OWN browser tab, so the folder backend
// connected in the Files tab doesn't carry over — reconnect it here before
// the first readLocalBlob. One shared connect per page-load; the demo
// workspace's OPFS folder restores without any permission prompt (a real
// picked folder restores only if the browser kept the grant).
let webFolderReadyPromise = null;
let webFolderReadyFor = null;
function ensureWebFolder(projectId) {
  // No project yet (selection still hydrating) — don't cache a failed
  // connect; the caller re-runs once the id arrives.
  if (!projectId) return Promise.resolve();
  if (!webFolderReadyPromise || webFolderReadyFor !== projectId) {
    webFolderReadyFor = projectId;
    webFolderReadyPromise = (async () => {
      await localFolderApi.restorePersistedHandle(projectId);
      await localFolderApi.list(); // populates the by-name handle map readLocalBlob reads
    })().catch(() => {});
  }
  return webFolderReadyPromise;
}
function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}
// Human file size ("426 kB", "1.2 MB") for the attachment meta line.
function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Mirrors guessMimeFromName in main.js — used when the file listing's
// mime is empty/generic and we only have the extension to go on.
const AUDIO_MIME_BY_EXT = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wma: 'audio/x-ms-wma',
  weba: 'audio/webm',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
};

// ── Date-range filtering for the WhatsApp view ──────────────────────────
// Message timestamps are locale-raw strings ("15/01/2023", "1/15/23",
// "2023-01-15" …) — the view normally avoids parsing them (day dividers
// group by the raw label), but a from/to filter needs real dates. The
// day-vs-month ambiguity is resolved by scanning the WHOLE transcript: any
// label with a first component > 12 proves day-first (dd/mm), any with a
// second component > 12 proves month-first; an ambiguous export falls back
// to day-first (the non-US default). Comparable keys are y*10000+m*100+d.
const DATE_PARTS_RE = /(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})/;

function buildDayResolver(messages) {
  let dayFirst = null;
  for (const m of messages) {
    const { date } = splitTimestamp(m.time);
    const p = date && DATE_PARTS_RE.exec(date);
    if (!p || p[1].length === 4) continue; // ISO labels carry no ambiguity
    if (+p[1] > 12) { dayFirst = true; break; }
    if (+p[2] > 12 && dayFirst == null) dayFirst = false;
  }
  if (dayFirst == null) dayFirst = true;
  const cache = new Map();
  return (time) => {
    const { date } = splitTimestamp(time);
    if (!date) return null;
    if (cache.has(date)) return cache.get(date);
    const p = DATE_PARTS_RE.exec(date);
    let key = null;
    if (p) {
      let d; let mo; let y;
      if (p[1].length === 4) { y = +p[1]; mo = +p[2]; d = +p[3]; }
      else {
        const a = +p[1]; const b = +p[2]; y = +p[3];
        if (a > 12) { d = a; mo = b; }
        else if (b > 12) { d = b; mo = a; }
        else if (dayFirst) { d = a; mo = b; }
        else { d = b; mo = a; }
        if (y < 100) y += 2000;
      }
      if (y >= 1990 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) key = y * 10000 + mo * 100 + d;
    }
    cache.set(date, key);
    return key;
  };
}

// "2023-01-15" (an <input type="date"> value) → the same comparable key.
function dateInputKey(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
  return m ? (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]) : null;
}
// Inverse of dateInputKey: a comparable key (y*10000+m*100+d) → "2023-01-15"
// for an <input type="date">. null/invalid → '' (empty input).
function keyToDateInput(key) {
  if (key == null) return '';
  const y = Math.floor(key / 10000);
  const mo = Math.floor((key % 10000) / 100);
  const d = key % 100;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ── Date-range picker (calendar modal) ────────────────────────────────────
// The WhatsApp conversation's From → To filter is driven by a single button
// (showing "from — to") that opens a modal over the conversation: two month
// calendars (left picks the From day, right picks the To day) with a live
// tally of everything that falls inside the chosen window between them.
const CAL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const CAL_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CAL_WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
function keyParts(key) {
  return { y: Math.floor(key / 10000), mo: Math.floor((key % 10000) / 100), d: key % 100 };
}
function partsToKey(y, mo, d) { return y * 10000 + mo * 100 + d; }
// "2023-01-15" → "15 Jan 2023" for the trigger button. Empty → an en-dash.
function formatDateLabel(v) {
  const k = dateInputKey(v);
  if (k == null) return '—';
  const { y, mo, d } = keyParts(k);
  return `${d} ${CAL_MONTHS_SHORT[mo - 1]} ${y}`;
}

const CalendarGlyph = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
);

// Every month from minKey's month through maxKey's month (inclusive), so the
// picker can lay the whole conversation history out at once.
function monthsBetween(minKey, maxKey) {
  if (minKey == null || maxKey == null) return [];
  const a = keyParts(minKey);
  const b = keyParts(maxKey);
  const out = [];
  let y = a.y; let mo = a.mo;
  while ((y < b.y || (y === b.y && mo <= b.mo)) && out.length < 1200) {
    out.push({ y, mo });
    mo += 1; if (mo > 12) { mo = 1; y += 1; }
  }
  return out;
}

// One month grid (title + day cells), no navigation — the modal stacks every
// month in the span. `fromKey`/`toKey` highlight the selected range; days
// outside [minKey, maxKey] are disabled. Clicking a day calls onPickDay(key).
function MonthGrid({ view, fromKey, toKey, minKey, maxKey, onPickDay, onHoverDay }) {
  const firstDow = new Date(view.y, view.mo - 1, 1).getDay();
  const daysInMonth = new Date(view.y, view.mo, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);
  return (
    <div className="dv-cal">
      <div className="dv-cal-head">
        <span className="dv-cal-title">{CAL_MONTHS[view.mo - 1]} {view.y}</span>
      </div>
      <div className="dv-cal-grid" onMouseLeave={() => onHoverDay?.(null)}>
        {CAL_WEEKDAYS.map((w) => <span key={w} className="dv-cal-dow">{w}</span>)}
        {cells.map((d, i) => {
          if (d == null) return <span key={`e${i}`} className="dv-cal-cell is-empty" aria-hidden="true" />;
          const key = partsToKey(view.y, view.mo, d);
          const disabled = (minKey != null && key < minKey) || (maxKey != null && key > maxKey);
          const isFrom = key === fromKey;
          const isTo = key === toKey;
          const inRange = fromKey != null && toKey != null && key >= fromKey && key <= toKey;
          const cls = `dv-cal-cell${inRange ? ' is-range' : ''}${isFrom ? ' is-from' : ''}${isTo ? ' is-to' : ''}`;
          return (
            <button
              key={d}
              type="button"
              className={cls}
              disabled={disabled}
              onClick={() => onPickDay(key)}
              onMouseEnter={onHoverDay ? () => onHoverDay(key) : undefined}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Count every conversation item (messages, media, voice, …) whose source
// message falls inside [fromKey, toKey]. `railAll` is the prebuilt bucket set
// so we only re-run the cheap filter as the draft range changes.
function countInRange(messages, railAll, dayResolver, fromKey, toKey) {
  const inRange = (time) => {
    const k = dayResolver(time);
    if (k == null) return false;
    if (fromKey != null && k < fromKey) return false;
    if (toKey != null && k > toKey) return false;
    return true;
  };
  const cnt = (arr) => arr.reduce((n, it) => (inRange(messages[it.msgIndex]?.time) ? n + 1 : n), 0);
  let textCount = 0;
  let days = new Set();
  for (const m of messages) {
    const k = dayResolver(m.time);
    if (k != null && (fromKey == null || k >= fromKey) && (toKey == null || k <= toKey)) days.add(k);
    if (m.system || m.attachment || m.omitted) continue;
    if (m.text && detectCall(m.text)) continue;
    if (m.text && inRange(m.time)) textCount += 1;
  }
  return [
    { key: 'days', one: 'day', many: 'days', n: days.size },
    { key: 'messages', one: 'message', many: 'messages', n: textCount },
    { key: 'media', one: 'media file', many: 'media', n: cnt(railAll.media) },
    { key: 'voice', one: 'voice note', many: 'voice notes', n: cnt(railAll.voice) },
    { key: 'stickers', one: 'sticker', many: 'stickers', n: cnt(railAll.stickers) },
    { key: 'docs', one: 'document', many: 'documents', n: cnt(railAll.docs) },
    { key: 'links', one: 'link', many: 'links', n: cnt(railAll.links) },
    { key: 'calls', one: 'call', many: 'calls', n: cnt(railAll.calls) },
    { key: 'contacts', one: 'contact', many: 'contacts', n: cnt(railAll.contacts) },
  ];
}

// Shared date-range picker state. When the picker is open, its content REPLACES
// the conversation bodies: the calendar grid takes the messages body and the
// in-range tally takes the rail's files body. The provider holds the draft
// (start day → end day, with hover preview) and exposes it to both views.
const DateRangeCtx = React.createContext(null);

function DateRangeProvider({ open, messages, dayResolver, fromKey, toKey, minKey, maxKey, onChange, onReset, children }) {
  const railAll = useMemo(() => buildRailContent(messages), [messages]);
  const safeMin = minKey ?? fromKey ?? partsToKey(new Date().getFullYear(), 1, 1);
  const safeMax = maxKey ?? toKey ?? safeMin;
  // dTo === null means a range is mid-selection (start picked, end pending).
  const [dFrom, setDFrom] = useState(fromKey ?? safeMin);
  const [dTo, setDTo] = useState(toKey ?? safeMax);
  const [hoverKey, setHoverKey] = useState(null);
  const months = useMemo(() => monthsBetween(safeMin, safeMax), [safeMin, safeMax]);

  // Re-seed the draft from the applied range each time the picker opens.
  useEffect(() => {
    if (open) { setDFrom(fromKey ?? safeMin); setDTo(toKey ?? safeMax); setHoverKey(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selecting = dTo == null;
  // Visual + stat range: while selecting, preview against the hovered day.
  let lo = dFrom;
  let hi = dTo;
  if (selecting) {
    if (hoverKey != null) { lo = Math.min(dFrom, hoverKey); hi = Math.max(dFrom, hoverKey); }
    else { lo = dFrom; hi = dFrom; }
  }

  // Push a COMPLETE range up so the conversation filters; skip while selecting.
  useEffect(() => {
    if (dTo != null) onChange(keyToDateInput(dFrom), keyToDateInput(dTo));
  }, [dFrom, dTo, onChange]);

  // Click 1 starts a new range (start day, end pending); click 2 closes it,
  // ordering the two days regardless of which was clicked first.
  const onPickDay = (key) => {
    if (dTo != null) { setDFrom(key); setDTo(null); return; }
    if (key < dFrom) { setDTo(dFrom); setDFrom(key); } else { setDTo(key); }
  };

  const stats = useMemo(
    () => countInRange(messages, railAll, dayResolver, lo, hi),
    [messages, railAll, dayResolver, lo, hi],
  );

  const active = lo > safeMin || hi < safeMax;
  const reset = () => { onReset(); setDFrom(safeMin); setDTo(safeMax); setHoverKey(null); };

  const value = { months, lo, hi, selecting, hoverKey, safeMin, safeMax, onPickDay, setHoverKey, stats, active, reset };
  return <DateRangeCtx.Provider value={value}>{children}</DateRangeCtx.Provider>;
}

// The picker content — replaces the messages body (the rail/sidebar isn't
// rendered while it's open, so it spans the full conversation width). Every
// month from the start of the file's history to the end fills + scrolls. The
// live in-range tally lives in the conversation footer (see DateRangeFooter).
function DateRangeCalendars({ closing = false, onExited, onClose }) {
  const c = useContext(DateRangeCtx);
  if (!c) return null;
  return (
    <div
      className={`dv-daterange-calwrap${closing ? ' is-closing' : ''}`}
      // Click on the backdrop (the overlay itself, not its calendar/footer
      // children) dismisses the picker.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
      onAnimationEnd={(e) => {
        if (closing && e.target === e.currentTarget) onExited?.();
      }}
    >
      <div
        className="dv-daterange-calscroll"
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      >
        {c.months.map((m) => (
          <MonthGrid
            key={`${m.y}-${m.mo}`}
            view={m}
            fromKey={c.lo}
            toKey={c.hi}
            minKey={c.safeMin}
            maxKey={c.safeMax}
            onPickDay={c.onPickDay}
            onHoverDay={c.selecting ? c.setHoverKey : undefined}
          />
        ))}
      </div>
      {/* In-range tally sits under the calendars, inside the picker overlay. */}
      <DateRangeFooter />
      {/* Actions under the tally — close (dismiss), reset (clear the range),
          select (keep the live-applied range and close). */}
      <div className="dv-daterange-actions">
        <button type="button" className="dv-daterange-btn" onClick={onClose}>Close</button>
        <button type="button" className="dv-daterange-btn" onClick={c.reset} disabled={!c.active}>Reset</button>
        <button type="button" className="dv-daterange-btn is-primary" onClick={onClose}>Select</button>
      </div>
    </div>
  );
}

// In-range tally rendered into the conversation footer (replacing the normal
// "messages · media · …" tallies while the picker is open). Styled like the old
// modal — a card surface with big bold counts — laid out as a horizontal bar.
function DateRangeFooter() {
  const c = useContext(DateRangeCtx);
  if (!c) return null;
  return (
    <footer className="dv-daterange-footer">
      <ul className="dv-daterange-stats-list">
        {c.stats.map((s) => (
          <li key={s.key} className={`dv-daterange-stat${s.n === 0 ? ' is-zero' : ''}`}>
            <span className="dv-daterange-stat-n">{s.n.toLocaleString()}</span>
            <span className="dv-daterange-stat-label">{s.n === 1 ? s.one : s.many}</span>
          </li>
        ))}
      </ul>
    </footer>
  );
}

// The trigger that replaces the inline From/To inputs: one button showing the
// selected range as "from — to" (a connecting line between the two dates).
function DateRangeButton({ from, to, active, open, onClick }) {
  return (
    <button type="button" className={`dv-wa-daterange${active ? ' is-active' : ''}${open ? ' is-open' : ''}`} onClick={onClick} aria-haspopup="dialog" aria-expanded={open || undefined}>
      <span className="dv-wa-daterange-icon">{CalendarGlyph}</span>
      <span className="dv-wa-daterange-date">{formatDateLabel(from)}</span>
      <span className="dv-wa-daterange-line" aria-hidden="true" />
      <span className="dv-wa-daterange-date">{formatDateLabel(to)}</span>
    </button>
  );
}

function classify(mime, name) {
  const m = (mime || '').toLowerCase();
  const e = extOf(name);
  if (m === 'application/pdf' || e === 'pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (e === 'docx' || m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return { kind: 'docx', mime: m };
  // Legacy binary Word (.doc / .dot): can't render in-browser — extract text.
  if (e === 'doc' || e === 'dot' || m === 'application/msword') return { kind: 'doc', mime: 'application/msword' };
  // Spreadsheets (Excel / CSV) — rendered as a styled table via SheetJS. Checked
  // before the text branch so a .csv (often text/csv or text/plain) lands here.
  if (e === 'xlsx' || e === 'xls' || e === 'csv'
    || m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || m === 'application/vnd.ms-excel'
    || m === 'text/csv') {
    return { kind: 'sheet', mime: m };
  }
  // PowerPoint (OOXML only — legacy binary .ppt can't be unzipped, falls through
  // to 'other'). Previewed as slide cards by parsing the pptx zip.
  if (e === 'pptx' || m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
    return { kind: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  }
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic', 'avif'].includes(e)) {
    return { kind: 'image', mime: m.startsWith('image/') ? m : 'image/png' };
  }
  if (m.startsWith('video/') || ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(e)) {
    return { kind: 'video', mime: m.startsWith('video/') ? m : 'video/mp4' };
  }
  if (m.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'wma', 'weba', 'aif', 'aiff'].includes(e)) {
    return { kind: 'audio', mime: m.startsWith('audio/') ? m : (AUDIO_MIME_BY_EXT[e] || 'audio/mpeg') };
  }
  if (m.startsWith('text/') || ['txt', 'md', 'rtf', 'log', 'json', 'xml', 'html', 'htm'].includes(e)) {
    return { kind: 'text', mime: e === 'md' ? 'text/markdown' : 'text/plain' };
  }
  return { kind: 'other', mime: m };
}

// Deterministic colour per chat participant (djb2 → vivid HSL), matching the
// avatar-hash pattern used elsewhere — gives each sender a stable name colour.
function senderColor(name) {
  let h = 0;
  for (let i = 0; i < (name || '').length; i += 1) { h = ((h << 5) - h) + name.charCodeAt(i); h |= 0; }
  return `hsl(${Math.abs(h) % 360} 65% 45%)`;
}

// Split a file path into its directory + the separator in use, so we can
// resolve a chat's media siblings (they live in the same export folder as
// `_chat.txt`). Handles both Windows (\) and POSIX (/) paths.
function dirAndSep(filePath) {
  const p = String(filePath || '');
  const bi = p.lastIndexOf('\\');
  const fi = p.lastIndexOf('/');
  const i = Math.max(bi, fi);
  if (i < 0) return { dir: '', sep: '\\' };
  return { dir: p.slice(0, i), sep: bi > fi ? '\\' : '/' };
}

function mediaKindOf(name) {
  const e = extOf(name);
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'tif', 'tiff'].includes(e)) return 'image';
  if (['mp4', 'mov', 'mkv', 'webm', 'm4v', '3gp', 'avi'].includes(e)) return 'video';
  if (['opus', 'ogg', 'oga', 'mp3', 'm4a', 'aac', 'wav'].includes(e)) return 'audio';
  return 'file';
}

// WhatsApp stickers are .webp files exported as "STICKER-…webp" (or the older
// "STK-…"). Detect them so the rail can list them apart from photos.
function isSticker(name) {
  return extOf(name) === 'webp' && /sticker|(^|[^a-z])stk[-_]/i.test(String(name || ''));
}

// The end-to-end-encryption notice WhatsApp injects at the top of a chat. Shown
// as its own lock banner (not a plain system pill). Matches every wording
// variant via the shared key phrase.
function isEncryptionNotice(text) {
  return /end-to-end encrypted/i.test(String(text || ''));
}

const PaperclipGlyph = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21.44 11.05l-8.49 8.49a6 6 0 0 1-8.49-8.49l8.49-8.49a4 4 0 0 1 5.66 5.66l-8.49 8.49a2 2 0 0 1-2.83-2.83l7.78-7.78" />
  </svg>
);
const LockGlyph = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 1.8a4.7 4.7 0 0 0-4.7 4.7V9H6.2A1.7 1.7 0 0 0 4.5 10.7v9A1.7 1.7 0 0 0 6.2 21.4h11.6a1.7 1.7 0 0 0 1.7-1.7v-9A1.7 1.7 0 0 0 17.8 9h-1.1V6.5A4.7 4.7 0 0 0 12 1.8zm0 1.9a2.8 2.8 0 0 1 2.8 2.8V9H9.2V6.5A2.8 2.8 0 0 1 12 3.7z" />
  </svg>
);

const PersonGlyph = (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
    <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.42 0-8 2.69-8 6v2h16v-2c0-3.31-3.58-6-8-6z" />
  </svg>
);

// A document icon coloured + labelled by file type (PDF / DOC / XLS / …). The
// page + folded corner is drawn in the type colour (currentColor, set by the
// `is-*` class) with a solid ribbon carrying the extension label. Used in the
// Docs rail and the in-chat document chip.
function docTypeGlyph(label) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
      <path d="M7 2.5h6.5L18 7v12.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z" fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M13.5 2.5V7H18" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <rect x="3" y="12.2" width="13" height="6.2" rx="1.3" fill="currentColor" stroke="none" />
      <text x="9.5" y="16.8" textAnchor="middle" fontSize="4.4" fontWeight="700" letterSpacing="0.2" fill="#fff" stroke="none">{label}</text>
    </svg>
  );
}
const DOC_TYPES = {
  pdf: { label: 'PDF', cls: 'is-pdf' },
  doc: { label: 'DOC', cls: 'is-word' }, docx: { label: 'DOC', cls: 'is-word' },
  rtf: { label: 'RTF', cls: 'is-word' }, odt: { label: 'ODT', cls: 'is-word' }, pages: { label: 'PAGE', cls: 'is-word' },
  xls: { label: 'XLS', cls: 'is-excel' }, xlsx: { label: 'XLS', cls: 'is-excel' },
  csv: { label: 'CSV', cls: 'is-excel' }, ods: { label: 'ODS', cls: 'is-excel' }, numbers: { label: 'NUM', cls: 'is-excel' },
  ppt: { label: 'PPT', cls: 'is-ppt' }, pptx: { label: 'PPT', cls: 'is-ppt' }, odp: { label: 'ODP', cls: 'is-ppt' }, key: { label: 'KEY', cls: 'is-ppt' },
  zip: { label: 'ZIP', cls: 'is-zip' }, rar: { label: 'RAR', cls: 'is-zip' }, '7z': { label: '7Z', cls: 'is-zip' }, gz: { label: 'GZ', cls: 'is-zip' }, tar: { label: 'TAR', cls: 'is-zip' },
  txt: { label: 'TXT', cls: 'is-text' }, log: { label: 'LOG', cls: 'is-text' }, md: { label: 'MD', cls: 'is-text' }, json: { label: 'JSON', cls: 'is-text' }, xml: { label: 'XML', cls: 'is-text' },
};
function docIconFor(name) {
  const e = extOf(name);
  const t = DOC_TYPES[e];
  const label = t ? t.label : (e ? e.slice(0, 4).toUpperCase() : 'FILE');
  return <span className={`dv-doc-ic ${t ? t.cls : 'is-generic'}`}>{docTypeGlyph(label)}</span>;
}

// Parse the bits of a vCard (.vcf) we surface on a contact card: the formatted
// name (FN), a fallback structured name (N), the first phone (TEL), and how
// many contacts the card holds (a shared multi-contact card has several FN).
function parseVcard(text) {
  const lines = String(text || '').split(/\r?\n/);
  let fn = ''; let n = ''; let tel = ''; let count = 0;
  for (const line of lines) {
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    const key = line.slice(0, ci).split(';')[0].toUpperCase();
    const val = line.slice(ci + 1).trim();
    if (key === 'FN') { count += 1; if (!fn) fn = val; }
    else if (key === 'N' && !n) n = val.replace(/;/g, ' ').replace(/\s+/g, ' ').trim();
    else if (key === 'TEL' && !tel) tel = val;
  }
  return { name: fn || n, tel, count };
}

// WhatsApp-style shared-contact card: grey avatar + name (and phone / "& N
// others"), then a divider and a "View contact" action that opens the .vcf in
// the OS. The vCard is fetched lazily; until it resolves (or if the file is
// missing) the name falls back to the filename.
function ContactCard({ name, fullPath, url, time }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    if (!url) return undefined;
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => { if (!cancelled && t) setInfo(parseVcard(t)); })
      .catch(() => { /* keep the filename fallback */ });
    return () => { cancelled = true; };
  }, [url]);

  const display = (info && info.name) || name.replace(/\.vcf$/i, '');
  const others = info && info.count > 1 ? info.count - 1 : 0;
  const sub = others > 0 ? `& ${others} other contact${others > 1 ? 's' : ''}` : (info && info.tel) || '';

  return (
    <div className="dv-wa-contact">
      <div className="dv-wa-contact-head">
        <span className="dv-wa-contact-avatar">{PersonGlyph}</span>
        <span className="dv-wa-contact-meta">
          <Tooltip content={display}><span className="dv-wa-contact-name">{display}</span></Tooltip>
          {sub && <span className="dv-wa-contact-sub">{sub}</span>}
        </span>
        {time && <span className="dv-wa-contact-time">{time}</span>}
      </div>
      <button
        type="button"
        className="dv-wa-contact-action"
        onClick={() => { if (fullPath) localFolderApi.openPath(fullPath); }}
        disabled={!fullPath}
      >
        View contact
      </button>
    </div>
  );
}

// A plain-text e-mail address surfaced in the Contacts rail. Mirrors the
// shared-contact card layout but with a "Send e-mail" action (mailto).
function EmailContactCard({ email }) {
  return (
    <div className="dv-wa-contact">
      <div className="dv-wa-contact-head">
        <span className="dv-wa-contact-avatar">{PersonGlyph}</span>
        <span className="dv-wa-contact-meta">
          <Tooltip content={email}><span className="dv-wa-contact-name">{email}</span></Tooltip>
          <span className="dv-wa-contact-sub">E-mail address</span>
        </span>
      </div>
      <button
        type="button"
        className="dv-wa-contact-action"
        onClick={() => openExternal(`mailto:${email}`)}
      >
        Send e-mail
      </button>
    </div>
  );
}

// A document attachment (PDF / Word / Excel / PowerPoint / OpenDocument / zip)
// inside a chat bubble — rendered as a rich card: an OS-generated page preview
// on top (Windows Shell / macOS QuickLook via the localfile `?thumb=` handler;
// absent for archives or where no provider exists), a meta row (type icon,
// filename, "TYPE · size", timestamp), and an Open / Save-as action footer.
const DOC_THUMB_EXTS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf']);
function DocAttachment({ name, fullPath, time, caption, pages }) {
  const [noThumb, setNoThumb] = useState(false);
  const [size, setSize] = useState(null);
  const [pdfPages, setPdfPages] = useState(null);
  const [pdfThumb, setPdfThumb] = useState(null);
  // Prefer WhatsApp's own page count (works for every doc type); fall back to
  // the count pdf.js derives when rendering a PDF's thumbnail.
  const pageCount = pages != null ? pages : pdfPages;
  const ext = extOf(name);
  const fileUrl = fullPath ? localUrlFor(fullPath) : null;
  // PDFs use a pdf.js-rendered first-page image (reliable everywhere); other
  // doc types fall back to the OS thumbnailer via the localfile `?thumb=` route.
  const thumbUrl = ext === 'pdf'
    ? pdfThumb
    : ((fullPath && DOC_THUMB_EXTS.has(ext)) ? localUrlFor(fullPath, 480) : null);
  const showThumb = Boolean(thumbUrl) && !noThumb;
  // Drop WhatsApp's export-id prefix ("00000939-…") from the shown name; the
  // real `name`/`fullPath` (with prefix) is still used to open/resolve the file.
  const displayName = String(name || '').replace(/^\d{4,}-/, '');

  // File size via a 1-byte Range request — the localfile handler answers with
  // `content-range: bytes 0-0/<total>`, so we learn the size without shipping
  // the whole file or adding an IPC round-trip.
  useEffect(() => {
    if (!fileUrl) return undefined;
    let cancelled = false;
    fetch(fileUrl, { headers: { Range: 'bytes=0-0' } })
      .then((r) => {
        const cr = r.headers.get('content-range');
        const m = cr && /\/(\d+)\s*$/.exec(cr);
        const cl = r.headers.get('content-length');
        const n = m ? parseInt(m[1], 10) : (cl ? parseInt(cl, 10) : NaN);
        if (!cancelled && Number.isFinite(n)) setSize(n);
      })
      .catch(() => { /* size is cosmetic — just omit it */ });
    return () => { cancelled = true; };
  }, [fileUrl]);

  // PDFs (reliable via pdf.js, no OS dependency): page count + a real first-page
  // thumbnail rendered to a canvas. The parsed doc is cached so opening the file
  // later reuses it. Other formats don't carry a portable page count.
  useEffect(() => {
    if (ext !== 'pdf' || !fileUrl) return undefined;
    let cancelled = false;
    let objUrl = null;
    (async () => {
      try {
        const doc = await getCachedPdf(fullPath, fileUrl);
        if (cancelled) return;
        if (doc?.numPages) setPdfPages(doc.numPages);
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(2, 480 / base.width) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        if (cancelled) return;
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
        if (cancelled || !blob) return;
        objUrl = URL.createObjectURL(blob);
        setPdfThumb(objUrl);
      } catch { /* thumbnail + page count are cosmetic */ }
    })();
    return () => { cancelled = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [ext, fileUrl, fullPath]);

  const typeLabel = DOC_TYPES[ext]?.label || (ext ? ext.toUpperCase() : 'FILE');
  const sub = [
    pageCount != null ? `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` : null,
    typeLabel,
    size != null ? formatBytes(size) : null,
  ].filter(Boolean).join(' · ');
  const open = () => localFolderApi.openPath(fullPath);

  return (
    <div className={`dv-wa-doccard${showThumb ? ' has-thumb' : ''}`}>
      {showThumb && (
        <button type="button" className="dv-wa-doccard-preview" onClick={open} aria-label={`Open ${displayName}`}>
          <img src={thumbUrl} alt={displayName} loading="lazy" decoding="async" onError={() => setNoThumb(true)} />
        </button>
      )}
      <button type="button" className="dv-wa-doccard-meta" onClick={open}>
        {docIconFor(name)}
        <span className="dv-wa-doccard-info">
          <Tooltip content={displayName}><span className="dv-wa-doccard-name">{displayName}</span></Tooltip>
          <span className="dv-wa-doccard-sub">{sub}</span>
        </span>
        {time && <span className="dv-wa-doccard-time">{time}</span>}
      </button>
      {caption}
      <div className="dv-wa-doccard-actions">
        <button type="button" className="dv-wa-doccard-btn" onClick={open}>Open</button>
      </div>
    </div>
  );
}

// Inline image attachment. On load we measure the photo's intrinsic ratio and
// size the bubble to match it: the display width is the height-capped width
// (so a landscape photo is wide, a portrait one narrow), floored by a minimum
// so tall/narrow photos don't squeeze the bubble to a sliver. The width is
// published as `--media-w` on the enclosing bubble; CSS clamps the caption to
// it so the caption text can't stretch the bubble wider than the image.
const IMG_MAX_W = 330;
const IMG_MAX_H = 420;
const IMG_MIN_W = 170;
function ImageAttachment({ url, name, fullPath, onError }) {
  const onLoad = (e) => {
    const img = e.currentTarget;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) return;
    const w = Math.round(Math.max(IMG_MIN_W, Math.min(IMG_MAX_W, IMG_MAX_H * (nw / nh))));
    img.style.width = `${w}px`;
    img.style.aspectRatio = `${nw} / ${nh}`;
    const bubble = img.closest('.dv-wa-bubble');
    if (bubble) bubble.style.setProperty('--media-w', `${w}px`);
  };
  return (
    <Tooltip content={name}>
      <img
        className="dv-wa-media"
        src={url}
        alt={name}
        loading="lazy"
        decoding="async"
        onLoad={onLoad}
        onError={onError}
        onClick={() => localFolderApi.openPath(fullPath)}
      />
    </Tooltip>
  );
}

// One media attachment inside a chat bubble. Resolves the referenced filename
// against the export folder (same dir as _chat.txt) and renders it inline:
// image / video / <audio> for voice notes, or a clickable chip for documents
// and anything that fails to load (e.g. the file wasn't included in the export).
function ChatAttachment({ name, dir, sep, time, caption, pages }) {
  const [failed, setFailed] = useState(false);
  // The attachment name comes from attacker-authorable transcript text. Only a
  // plain in-folder filename may be resolved to a path — a name containing a
  // path separator or `..` would escape the export folder (arbitrary file read
  // via localfile://), so we treat it as unresolvable and show the absent-media
  // placeholder instead. (main.js also enforces realpath containment as backstop.)
  const safeName = typeof name === 'string' && name.length > 0
    && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..';
  const fullPath = (dir && safeName) ? `${dir}${sep}${name}` : null;
  const kind = mediaKindOf(name);
  // Bubble images render at ~320 CSS px — a 640px thumb covers 2x densities.
  const url = fullPath ? localUrlFor(fullPath, kind === 'image' ? 640 : undefined) : null;

  // Shared contact (.vcf) → a WhatsApp-style contact card (renders from the
  // filename even when the file itself wasn't included in the export).
  if (extOf(name) === 'vcf') {
    return <ContactCard name={name} fullPath={url ? fullPath : null} url={url} time={time} />;
  }

  if (url && !failed && kind === 'image') {
    return <ImageAttachment url={url} name={name} fullPath={fullPath} onError={() => setFailed(true)} />;
  }
  if (url && !failed && kind === 'video') {
    // The OS-thumb poster paints instantly; when the handler can't generate
    // one it answers 415, the poster is simply dropped, and the element falls
    // back to its own metadata first-frame.
    return <video className="dv-wa-media" src={url} poster={localUrlFor(fullPath, 640)} controls preload="metadata" onError={() => setFailed(true)} />;
  }
  if (url && !failed && kind === 'audio') {
    return <VoiceNote src={url} onError={() => setFailed(true)} />;
  }
  // Referenced but absent from the export folder → the same "not included in
  // this export" placeholder WhatsApp's own <Media omitted> markers get, rather
  // than a broken-looking filename chip. (WhatsApp caps the media it bundles,
  // so most of a long chat's photos/videos/voice notes simply aren't there.)
  const missing = failed || !url;
  if (missing) {
    const label = MEDIA_MISSING_LABEL[isSticker(name) ? 'sticker' : kind] || 'Attachment';
    return (
      <Tooltip content={`${name} — not included in this export`}>
        <span className="dv-wa-omitted">{PaperclipGlyph}{label} — not included in this export</span>
      </Tooltip>
    );
  }
  // Present document / archive / unknown → a rich card (thumbnail + meta + the
  // caption above a full-width Open button), opening the file in the OS app.
  return <DocAttachment name={name} fullPath={fullPath} time={time} caption={caption} pages={pages} />;
}

// Friendly label for an "exported without media" placeholder.
const OMITTED_LABEL = {
  image: 'Photo', photo: 'Photo', video: 'Video', audio: 'Audio',
  'voice message': 'Voice message', gif: 'GIF', sticker: 'Sticker',
  document: 'Document', 'contact card': 'Contact card', media: 'Media',
};
// Label for a media file that's REFERENCED in the transcript but isn't in the
// export folder — WhatsApp's "Attach Media" only bundles the most recent media
// up to a size cap, so most of a long chat's photos/videos/voice notes simply
// aren't included. Keyed by mediaKindOf (+ a sticker special-case).
const MEDIA_MISSING_LABEL = {
  image: 'Photo', video: 'Video', audio: 'Voice message', sticker: 'Sticker', file: 'Document',
};

// Wrap every occurrence of the (lowercased) search query `q` in <mark> so it
// reads like Windows Explorer's highlighted matches. Returns the original
// string untouched when there's no match.
function markMatches(str, q, kp) {
  if (!q) return str;
  const lower = str.toLowerCase();
  const out = [];
  let i = 0; let idx; let n = 0;
  while ((idx = lower.indexOf(q, i)) !== -1) {
    if (idx > i) out.push(str.slice(i, idx));
    out.push(<mark key={`${kp}-${n}`} className="dv-wa-hl">{str.slice(idx, idx + q.length)}</mark>);
    n += 1;
    i = idx + q.length;
  }
  if (n === 0) return str;
  if (i < str.length) out.push(str.slice(i));
  return out;
}

// Linkify a chat message the way WhatsApp does: URLs and e-mail addresses turn
// into underlined links (opened in the system browser / mail client), IBANs are
// highlighted (click to copy) and @mentions are underlined too; everything else
// stays plain text. When a search query is passed, plain-text runs also get
// their matches wrapped in <mark>. Returns the original string when there's
// nothing to mark up, otherwise an array of strings + <a>/<span> nodes.
const CHAT_LINK_RE = /(https?:\/\/[^\s<]+|www\.[^\s<]+|[^\s<@]+@[^\s<@]+\.[A-Za-z]{2,}|@\w[\w.]*|[A-Z]{2}\d{2}[A-Z0-9]{12,30})/g;
const TRAIL_PUNCT_RE = /[.,!?;:'")\]}]+$/;

function linkifyChat(text, query) {
  const str = String(text ?? '');
  if (!str) return str;
  const q = query || '';
  CHAT_LINK_RE.lastIndex = 0;
  if (!CHAT_LINK_RE.test(str)) return q ? markMatches(str, q, 'h') : str;
  CHAT_LINK_RE.lastIndex = 0;
  const nodes = [];
  let last = 0;
  let m;
  const pushPlain = (s, kp) => {
    if (!s) return;
    const r = q ? markMatches(s, q, kp) : s;
    if (Array.isArray(r)) nodes.push(...r); else nodes.push(r);
  };
  while ((m = CHAT_LINK_RE.exec(str)) !== null) {
    const raw = m[0];
    const start = m.index;
    if (start > last) pushPlain(str.slice(last, start), `p${start}`);
    if (raw[0] === '@') {
      nodes.push(<span key={start} className="dv-wa-mention">{raw}</span>);
      last = start + raw.length;
      continue;
    }
    // Keep trailing sentence punctuation out of the link's target and text.
    const trail = TRAIL_PUNCT_RE.exec(raw);
    const token = trail ? raw.slice(0, raw.length - trail[0].length) : raw;
    if (IBAN_FULL_RE.test(token)) {
      nodes.push(
        <Tooltip key={start} content="Copy IBAN">
          <span
            className="dv-wa-iban"
            role="button"
            tabIndex={0}
            onClick={() => copyText(token)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyText(token); } }}
          >
            {token}
          </span>
        </Tooltip>,
      );
      if (trail) pushPlain(trail[0], `t${start}`);
      last = start + raw.length;
      continue;
    }
    const isEmail = token.indexOf('@') !== -1 && !/^(https?:\/\/|www\.)/i.test(token);
    const href = isEmail ? `mailto:${token}` : /^www\./i.test(token) ? `https://${token}` : token;
    nodes.push(
      <a
        key={start}
        className="dv-wa-link-a"
        href={href}
        onClick={(e) => { e.preventDefault(); openExternal(href); }}
      >
        {token}
      </a>,
    );
    if (trail) pushPlain(trail[0], `t${start}`);
    last = start + raw.length;
  }
  if (last < str.length) pushPlain(str.slice(last), `e${last}`);
  return nodes;
}

// WhatsApp appends "<This message was edited>" to a message it has edited.
// Render the body normally (linkified) and the marker as a small muted tag,
// like WhatsApp's inline "Edited" label, instead of literal angle-bracket text.
const EDITED_RE = /\s*<this message was edited>\s*$/i;
function renderMessageText(text, query) {
  const str = String(text ?? '');
  const m = EDITED_RE.exec(str);
  if (!m) return linkifyChat(str, query);
  const body = str.slice(0, m.index);
  return (
    <>
      {linkifyChat(body, query)}
      <span className="dv-wa-edited">Edited</span>
    </>
  );
}

// Does a message / render-row match the live search query (sender, body,
// attachment name or caption)? Used to filter the chat like Explorer's search.
function messageMatchesQuery(m, q) {
  if (!q) return true;
  if (m.sender && m.sender.toLowerCase().includes(q)) return true;
  if (m.text && m.text.toLowerCase().includes(q)) return true;
  if (m.attachment) {
    if (m.attachment.name && m.attachment.name.toLowerCase().includes(q)) return true;
    if (m.attachment.caption && m.attachment.caption.toLowerCase().includes(q)) return true;
  }
  return false;
}
function rowMatchesQuery(row, q) {
  if (!q) return true;
  if (row.kind === 'album') {
    return (row.sender && row.sender.toLowerCase().includes(q)) || row.items.some((it) => messageMatchesQuery(it.msg, q));
  }
  return messageMatchesQuery(row.msg, q);
}

// ── WhatsApp conversation view ─────────────────────────────────────────
// Renders parsed messages as WhatsApp-style bubbles. The participant who sent
// the most messages is treated as "me" (right side, green); everyone else sits
// on the left. Day dividers are grouped by the raw date label so we don't have
// to parse locale-specific date formats.
function isImageAttachment(m) {
  return Boolean(m && !m.system && m.attachment && mediaKindOf(m.attachment.name) === 'image');
}

// Collapse a burst of photos shared at the same instant (same sender + exact
// timestamp) into a single album row — the way WhatsApp groups them. Everything
// else stays a one-message row; system notices pass through untouched.
function buildRenderRows(messages) {
  const rows = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (isImageAttachment(m)) {
      const items = [{ msg: m, index: i }];
      let j = i + 1;
      while (j < messages.length && isImageAttachment(messages[j])
        && messages[j].sender === m.sender && messages[j].time === m.time) {
        items.push({ msg: messages[j], index: j });
        j += 1;
      }
      if (items.length >= 2) {
        rows.push({ kind: 'album', items, sender: m.sender, time: m.time });
        i = j;
        continue;
      }
    }
    rows.push({ kind: m.system ? 'system' : 'message', msg: m, index: i });
    i += 1;
  }
  return rows;
}

// Large-export windowing: only the newest rows are mounted when the
// conversation opens (WhatsApp-style — you land on the latest messages); a
// "Show earlier" pill at the top pages further back. Keeps a 100k-message
// export from mounting 100k bubbles (plus their media elements) at once;
// the rows that ARE mounted additionally skip offscreen layout/paint via
// content-visibility in DocViewer.css.
const WA_INITIAL_ROWS = 400;
const WA_EARLIER_CHUNK = 1200;

// Memoized: every prop is referentially stable across a rail resize / other
// DocTextPane-local state commits, so the (large) conversation subtree only
// re-renders when something it actually shows changes.
const WhatsAppChat = React.memo(function WhatsAppChat({ variant = 'whatsapp', messages, dir, sep, highlight, query, rawQuery, onQueryChange, dateFrom, dateTo, onOpenDates, datesOpen, rangeActive, timeInRange, railOpen, onToggleRail, headerSlot = null }) {
  // `query` is the deferred copy (drives the expensive filtering); `rawQuery`
  // is what the header's search input shows so typing never lags behind.
  // `rangeActive`/`timeInRange` come from DocTextPane (shared with the rail).
  const q = (query || '').trim().toLowerCase();
  const meSender = useMemo(() => {
    const counts = new Map();
    for (const m of messages) if (!m.system && m.sender) counts.set(m.sender, (counts.get(m.sender) || 0) + 1);
    let best = null; let bestN = -1;
    for (const [name, n] of counts) if (n > bestN) { best = name; bestN = n; }
    return best;
  }, [messages]);
  // Names only adorn incoming bubbles, and only in a multi-party chat (WhatsApp
  // hides the name in a 1:1).
  const showNames = useMemo(() => {
    const s = new Set(messages.filter((m) => !m.system && m.sender).map((m) => m.sender));
    return s.size > 2;
  }, [messages]);

  const rows = useMemo(() => buildRenderRows(messages), [messages]);
  // Live search filters the conversation to matching rows (Explorer-style),
  // while meSender / showNames stay derived from the full transcript so sides
  // and name visibility don't flip mid-search.
  const visibleRows = useMemo(() => {
    if (!q && !rangeActive) return rows;
    return rows.filter((r) => {
      if (rangeActive && !timeInRange(r.kind === 'album' ? r.time : r.msg.time)) return false;
      return !q || rowMatchesQuery(r, q);
    });
  }, [rows, q, rangeActive, timeInRange]);

  // Render window over visibleRows: null = the default tail of the list;
  // "Show earlier" and find-in-chat pull it back. Reset when the conversation
  // or the search changes so a stale window doesn't hide fresh results.
  const [startOverride, setStartOverride] = useState(null);
  useEffect(() => { setStartOverride(null); }, [messages, q, timeInRange]);
  const renderStart = startOverride != null
    ? Math.max(0, Math.min(startOverride, visibleRows.length))
    : Math.max(0, visibleRows.length - WA_INITIAL_ROWS);
  const renderRows = renderStart > 0 ? visibleRows.slice(renderStart) : visibleRows;

  // Land on the newest messages when a conversation first renders (matches
  // WhatsApp). Keyed per messages identity so tab switches re-anchor but
  // search keystrokes / window growth don't. Layout effect so the jump
  // happens before paint — no flash of the conversation's top.
  const endRef = useRef(null);
  const anchoredRef = useRef(null);
  useLayoutEffect(() => {
    if (anchoredRef.current === messages) return;
    anchoredRef.current = messages;
    endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages]);

  // Map every message index → its rendered row element so "Find in chat" can
  // scroll to (and briefly highlight) it. Album rows register all their indices.
  const rowRefs = useRef(new Map());
  const setRowRef = (indices) => (el) => {
    for (const idx of indices) { if (el) rowRefs.current.set(idx, el); else rowRefs.current.delete(idx); }
  };
  // Each find request is handled once (tracked by its bump counter `n`) —
  // the effect also re-fires on window growth so a target that sat behind
  // "Show earlier" can be scrolled to after the expanded window commits,
  // without re-jumping on every later expansion.
  const handledFindRef = useRef(0);
  useEffect(() => {
    if (!highlight || handledFindRef.current === highlight.n) return undefined;
    const el = rowRefs.current.get(highlight.index);
    if (!el) {
      // Not mounted — the row is behind the render window. Pull the window
      // back to include it; this effect re-runs once the rows commit.
      const pos = visibleRows.findIndex((r) => (r.kind === 'album'
        ? r.items.some((it) => it.index === highlight.index)
        : r.index === highlight.index));
      if (pos >= 0 && pos < renderStart) setStartOverride(Math.max(0, pos - 10));
      return undefined;
    }
    handledFindRef.current = highlight.n;
    // Jump straight to the match (no smooth animation) — "find in chat" should
    // teleport, not glide past every message in between.
    el.scrollIntoView({ behavior: 'auto', block: 'center' });
    el.classList.add('is-found');
    const t = setTimeout(() => el.classList.remove('is-found'), 2200);
    return () => clearTimeout(t);
  }, [highlight, renderStart, visibleRows]);

  // ── Header search (find controls) ─────────────────────────────────────
  // While a query is live every visible row IS a match, so Enter / Shift+
  // Enter walk the filtered list (VS-Code's find loop, like the AI chat
  // tab). `nav` carries a bump counter so re-triggering the same position
  // (single match) still re-scrolls.
  const findInputRef = useRef(null);
  const [nav, setNav] = useState(null); // { pos, n }
  useEffect(() => { setNav(null); }, [q, messages, timeInRange]);
  const goMatch = (dirn) => {
    const n = visibleRows.length;
    if (!q || !n) return;
    setNav((prev) => {
      const pos = prev == null ? (dirn > 0 ? 0 : n - 1) : (prev.pos + dirn + n) % n;
      return { pos, n: (prev?.n || 0) + 1 };
    });
  };
  useEffect(() => {
    if (!nav) return undefined;
    const row = visibleRows[nav.pos];
    if (!row) return undefined;
    const idx = row.kind === 'album' ? row.items[0].index : row.index;
    const el = rowRefs.current.get(idx);
    if (!el) {
      // Behind the render window — widen it; this effect re-runs on commit.
      if (nav.pos < renderStart) setStartOverride(Math.max(0, nav.pos - 10));
      return undefined;
    }
    el.scrollIntoView({ behavior: 'auto', block: 'center' });
    el.classList.add('is-found');
    const t = setTimeout(() => el.classList.remove('is-found'), 1400);
    return () => clearTimeout(t);
  }, [nav, renderStart, visibleRows]);

  // Ctrl/⌘+F focuses the header search (matches the AI chat tab). The doc
  // viewer keeps every open tab mounted, so gate on this instance actually
  // being visible (offsetParent is null under a display:none tab).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        const input = findInputRef.current;
        if (!input || input.offsetParent === null) return;
        e.preventDefault();
        input.focus();
        input.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Album cells are small crops — a 480px thumb is plenty at 2x density.
  const imgUrl = (name) => (dir ? localUrlFor(`${dir}${sep}${name}`, 480) : null);
  const openImg = (name) => { if (dir) localFolderApi.openPath(`${dir}${sep}${name}`); };

  let lastDate = null;
  const dividerFor = (time) => {
    const { date } = splitTimestamp(time);
    const d = date && date !== lastDate ? date : null;
    if (date) lastDate = date;
    return d;
  };

  // Docvex skin: incoming messages get a colour-hashed initial avatar to the
  // left of the bubble (own messages have none), mirroring the Team chat tab.
  // Only in GROUP chats though — a 1:1 has a single other party, so the circles
  // are noise there (same `showNames` rule WhatsApp uses to hide sender names).
  // Returns null in the WhatsApp skin, for own messages, in 1:1s, or no sender.
  const docvex = variant === 'docvex';
  const avatarFor = (sender, mine) => (docvex && !mine && sender && showNames)
    ? <span className="dv-wa-avatar" style={{ background: senderColor(sender) }} aria-hidden="true">{(sender.trim()[0] || '?').toUpperCase()}</span>
    : null;

  // A call rendered as a WhatsApp-style call bubble (left = incoming, right =
  // outgoing when we know the caller; system call lines default to incoming).
  const callBubble = (call, mine, clock, index, sender) => (
    <div className={`dv-wa-row ${mine ? 'is-out' : 'is-in'}`} ref={setRowRef([index])}>
      {avatarFor(sender, mine)}
      <div className={`dv-wa-bubble dv-wa-call-bubble${call.missed ? ' is-missed' : call.duration ? ' is-answered' : ''}`}>
        <span className="dv-wa-call-bubble-icon">{call.type === 'video' ? VideoGlyph : PhoneGlyph}</span>
        <span className="dv-wa-call-bubble-text">
          <span className="dv-wa-call-bubble-label">{call.label}</span>
          {(call.callback || call.duration) && (
            <span className="dv-wa-call-bubble-sub">{call.callback ? 'Tap to call back' : call.duration}</span>
          )}
        </span>
        {clock && <span className="dv-wa-time">{clock}</span>}
      </div>
    </div>
  );
  // The search + date-range controls portal into the header slot above the
  // tab bars (see controlsNode below).
  return (
    <div className={`dv-wa${docvex ? ' is-docvex' : ''}`}>
      <div className="dv-wa-inner">
        {(q || rangeActive) && visibleRows.length === 0 && (
          <div className="dv-wa-noresults">
            {q ? <>No messages match “{query.trim()}”{rangeActive ? ' in this date range' : ''}.</> : 'No messages in this date range.'}
          </div>
        )}
        {renderStart > 0 && (
          <button
            type="button"
            className="dv-wa-earlier"
            onClick={() => setStartOverride(Math.max(0, renderStart - WA_EARLIER_CHUNK))}
          >
            Show earlier messages ({renderStart.toLocaleString()} more)
          </button>
        )}
        {renderRows.map((row, rri) => {
          // Keys are absolute positions in visibleRows so already-mounted rows
          // keep their identity when "Show earlier" prepends a chunk.
          const ri = renderStart + rri;
          // System notice — or a styled call entry (missed/answered call).
          if (row.kind === 'system') {
            const dayDivider = dividerFor(row.msg.time);
            const call = detectCall(row.msg.text);
            const { clock } = splitTimestamp(row.msg.time);
            return (
              <React.Fragment key={ri}>
                {dayDivider && <div className="dv-wa-day"><span>{dayDivider}</span></div>}
                {call ? callBubble(call, false, clock, row.index)
                  : isEncryptionNotice(row.msg.text) ? (
                    <div className="dv-wa-encryption" ref={setRowRef([row.index])}>
                      <span className="dv-wa-encryption-icon">{LockGlyph}</span>
                      {q ? markMatches(row.msg.text, q, 'sys') : row.msg.text}
                    </div>
                  ) : (
                    <div className="dv-wa-system" ref={setRowRef([row.index])}><span>{q ? markMatches(row.msg.text, q, 'sys') : row.msg.text}</span></div>
                  )}
              </React.Fragment>
            );
          }
          // Album — a burst of photos shared at the same instant.
          if (row.kind === 'album') {
            const dayDivider = dividerFor(row.time);
            const mine = row.sender === meSender;
            const { clock } = splitTimestamp(row.time);
            const caption = row.items.map((it) => it.msg.attachment?.caption).find(Boolean) || '';
            return (
              <React.Fragment key={ri}>
                {dayDivider && <div className="dv-wa-day"><span>{dayDivider}</span></div>}
                <div className={`dv-wa-row ${mine ? 'is-out' : 'is-in'}`} ref={setRowRef(row.items.map((it) => it.index))}>
                  {avatarFor(row.sender, mine)}
                  <div className="dv-wa-bubble has-media dv-wa-album">
                    {!mine && showNames && (
                      <span className="dv-wa-name" style={{ color: senderColor(row.sender) }}>{q ? markMatches(row.sender, q, 'an') : row.sender}</span>
                    )}
                    <div className="dv-wa-album-grid" data-count={Math.min(row.items.length, 4)}>
                      {row.items.map((it, k) => (
                        <Tooltip key={k} content={it.msg.attachment.name}>
                          <button type="button" className="dv-wa-album-cell" onClick={() => openImg(it.msg.attachment.name)}>
                            <img src={imgUrl(it.msg.attachment.name)} alt={it.msg.attachment.name} loading="lazy" decoding="async" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                          </button>
                        </Tooltip>
                      ))}
                    </div>
                    {caption && <span className="dv-wa-text dv-wa-caption">{linkifyChat(caption, q)}</span>}
                    {clock && <span className="dv-wa-time">{clock}</span>}
                  </div>
                </div>
              </React.Fragment>
            );
          }
          // Single message.
          const m = row.msg;
          const dayDivider = dividerFor(m.time);
          const { clock } = splitTimestamp(m.time);
          const mine = m.sender === meSender;
          // A call written as a normal message (group chats carry the caller as
          // the sender) renders as a call bubble, aligned by direction.
          const msgCall = !m.attachment ? detectCall(m.text) : null;
          if (msgCall) {
            return (
              <React.Fragment key={ri}>
                {dayDivider && <div className="dv-wa-day"><span>{dayDivider}</span></div>}
                {callBubble(msgCall, mine, clock, row.index, m.sender)}
              </React.Fragment>
            );
          }
          const caption = m.attachment ? m.attachment.caption : '';
          const hasMedia = Boolean(m.attachment) || Boolean(m.omitted);
          // A shared-contact card carries its own timestamp inside the head (so
          // the "View contact" button can run flush to the bubble's bottom),
          // so suppress the generic floated time for those.
          const isContact = Boolean(m.attachment) && extOf(m.attachment.name) === 'vcf';
          // Document / archive attachments render as a self-contained card that
          // carries its own timestamp — suppress the bubble's floated clock so
          // it isn't shown twice.
          const isDoc = Boolean(m.attachment) && !isContact && mediaKindOf(m.attachment.name) === 'file';
          return (
            <React.Fragment key={ri}>
              {dayDivider && <div className="dv-wa-day"><span>{dayDivider}</span></div>}
              <div className={`dv-wa-row ${mine ? 'is-out' : 'is-in'}`} ref={setRowRef([row.index])}>
                {avatarFor(m.sender, mine)}
                <div className={`dv-wa-bubble${hasMedia ? ' has-media' : ''}${isContact ? ' is-contact' : ''}`}>
                  {!mine && showNames && (
                    <span className="dv-wa-name" style={{ color: senderColor(m.sender) }}>{q ? markMatches(m.sender, q, 'sn') : m.sender}</span>
                  )}
                  {m.attachment ? (
                    <>
                      <ChatAttachment
                        name={m.attachment.name}
                        dir={dir}
                        sep={sep}
                        time={(isContact || isDoc) ? clock : null}
                        pages={m.attachment.pages}
                        caption={isDoc && caption ? <span className="dv-wa-text dv-wa-caption">{linkifyChat(caption, q)}</span> : null}
                      />
                      {/* Media (image/video/audio) keep the caption below the
                          thumbnail; for the document card it's embedded inside
                          (above the Open button) instead. */}
                      {caption && !isDoc && <span className="dv-wa-text dv-wa-caption">{linkifyChat(caption, q)}</span>}
                    </>
                  ) : m.omitted ? (
                    <span className="dv-wa-omitted">{PaperclipGlyph}{OMITTED_LABEL[m.omitted] || 'Attachment'} — not included in this export</span>
                  ) : (
                    <span className="dv-wa-text">{renderMessageText(m.text, q)}</span>
                  )}
                  {clock && !isContact && !isDoc && <span className="dv-wa-time">{clock}</span>}
                </div>
              </div>
            </React.Fragment>
          );
        })}
        <div ref={endRef} aria-hidden="true" />
      </div>
      {meSender && (() => {
        const controlsNode = (
        <div className="dv-wa-controls">
          <div className="dv-wa-header-controls">
            {/* Search pill — reuses the Files tab's .fx-search styling (its CSS
                is loaded here via the embedded Files browser) so it's identical.
                Enter / Shift+Enter walk the matches; count chip + Ctrl/⌘+F hint. */}
            <div className={`fx-search${(rawQuery || '').trim() ? ' is-active' : ''}`}>
              <span className="fx-search-glyph">{SearchGlyph}</span>
              <input
                ref={findInputRef}
                type="text"
                value={rawQuery || ''}
                onChange={(e) => onQueryChange?.(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && (rawQuery || '')) { e.stopPropagation(); onQueryChange?.(''); return; }
                  if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) goMatch(-1); else goMatch(1); }
                }}
                placeholder="Search this chat"
                aria-label="Search messages in this chat"
              />
              {q ? (
                <span className={`dv-wa-find-count${visibleRows.length === 0 ? ' is-empty' : ''}`} aria-live="polite">
                  {visibleRows.length ? `${(nav ? nav.pos : 0) + 1}/${visibleRows.length}` : 'No results'}
                </span>
              ) : null}
              {(rawQuery || '') ? (
                <button type="button" className="fx-search-clear" onClick={() => { onQueryChange?.(''); findInputRef.current?.focus(); }} aria-label="Clear search">
                  {ClearGlyph}
                </button>
              ) : (
                <span className="fx-search-kbd" aria-hidden="true">
                  <kbd>{/mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'}</kbd>
                  <span className="fx-search-kbd-plus">+</span>
                  <kbd>F</kbd>
                </span>
              )}
            </div>
            {/* Date-range trigger — one button showing "from — to"; clicking
                opens the calendar modal over the conversation (state lives in
                DocTextPane, which also owns the From → To filter). */}
            <DateRangeButton from={dateFrom} to={dateTo} active={rangeActive} open={datesOpen} onClick={() => onOpenDates?.()} />
          </div>
          {/* Burger — shows/hides the Media, links & docs rail. Hidden in the
              Docvex skin, where the rail is pinned open beside the chat. */}
          {!docvex && (
            <Tooltip content={railOpen ? 'Hide media, links & docs' : 'Show media, links & docs'}>
              <button
                type="button"
                className={`dv-wa-burger${railOpen ? ' is-active' : ''}`}
                onClick={() => onToggleRail?.()}
                aria-pressed={Boolean(railOpen)}
                aria-label="Toggle media, links and docs panel"
              >
                {BurgerGlyph}
              </button>
            </Tooltip>
          )}
        </div>
        );
        // Controls portal up above the tab bars. (The stats footer that used
        // to span the pane below the split was removed.)
        return headerSlot ? createPortal(controlsNode, headerSlot) : controlsNode;
      })()}
    </div>
  );
});

// ── Media / links / docs / contacts rail ───────────────────────────────
// WhatsApp's "Media, links, and docs" panel: a right rail beside the chat that
// aggregates every shared photo/video, link, document and contact across the
// whole transcript.
const PlayGlyph = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.78-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z" />
  </svg>
);
const PhoneGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);
const VideoGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
  </svg>
);
const PauseGlyph = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" />
  </svg>
);
const MusicNoteGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
  </svg>
);
const VolumeHighGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
);
const VolumeMuteGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
  </svg>
);
const CaptionsGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="5" width="20" height="14" rx="2" /><path d="M7 12.5a1.5 1.5 0 0 1-1.5 1.5h-.5a1.5 1.5 0 0 1-1.5-1.5v-1a1.5 1.5 0 0 1 1.5-1.5h.5A1.5 1.5 0 0 1 7 11.5" /><path d="M15.5 12.5a1.5 1.5 0 0 1-1.5 1.5h-.5a1.5 1.5 0 0 1-1.5-1.5v-1a1.5 1.5 0 0 1 1.5-1.5h.5a1.5 1.5 0 0 1 1.5 1.5" />
  </svg>
);

// WhatsApp-style voice-note / audio player for an audio attachment (opus / ogg /
// mp3 / m4a / wav). A play-pause button, a scrubbable progress bar and the
// elapsed-or-total time. The hidden <audio> is the engine; seeking + duration
// rely on the localfile handler's Range support (added in main.js).
// ── Voice-note waveform (WhatsApp's volume bars) ────────────────────────
// The amplitude envelope is decoded from the real audio via Web Audio,
// LAZILY: only once a player has scrolled into view (an export can hold
// hundreds of notes — decoding them all up front would undo the rail's
// preload="none"). Results are cached by src for the window's lifetime.
// Until (or in case) the decode lands, a deterministic filename-seeded
// pattern keeps the layout identical so nothing jumps.
const WAVE_BARS = 36;
const waveCache = new Map();
const waveInflight = new Map();
let waveCtx = null;

function seededWave(seedStr, bars = WAVE_BARS) {
  let h = 5381;
  const s = String(seedStr || '');
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  const out = [];
  for (let i = 0; i < bars; i += 1) {
    h = (h * 1103515245 + 12345) | 0;
    out.push(0.22 + ((Math.abs(h) % 1000) / 1000) * 0.55);
  }
  return out;
}

async function computeWaveform(src, bars = WAVE_BARS) {
  const key = `${src}:${bars}`;
  if (waveCache.has(key)) return waveCache.get(key);
  if (waveInflight.has(key)) return waveInflight.get(key);
  const p = (async () => {
    try {
      const res = await fetch(src);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      // Low sample rate: we only need a coarse envelope, and it cuts the
      // decode cost of long notes substantially. decodeAudioData works on a
      // suspended context, so no user-gesture requirement applies.
      if (!waveCtx) waveCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const audio = await waveCtx.decodeAudioData(buf);
      const ch = audio.getChannelData(0);
      const bucket = Math.max(1, Math.floor(ch.length / bars));
      const peaks = new Array(bars).fill(0);
      for (let b = 0; b < bars; b += 1) {
        const start = b * bucket;
        const end = Math.min(ch.length, start + bucket);
        const step = Math.max(1, Math.floor((end - start) / 64)); // sparse RMS sample
        let sum = 0; let n = 0;
        for (let i = start; i < end; i += step) { sum += ch[i] * ch[i]; n += 1; }
        peaks[b] = Math.sqrt(sum / Math.max(1, n));
      }
      const max = Math.max(...peaks, 0.0001);
      const wave = peaks.map((v) => Math.max(0.12, Math.min(1, v / max)));
      waveCache.set(key, wave);
      return wave;
    } catch {
      return null;
    } finally {
      waveInflight.delete(key);
    }
  })();
  waveInflight.set(key, p);
  return p;
}

// `preload` defaults to metadata (duration shows up front). The rail's Voice
// tab passes "none" — it mounts EVERY note at once, and a metadata request
// per <audio> would hammer the localfile handler on a big export; durations
// there resolve on first play instead.
function VoiceNote({ src, onError, preload = 'metadata' }) {
  const audioRef = useRef(null);
  const rootRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);

  // Real amplitude bars, decoded once the player scrolls into view.
  const [wave, setWave] = useState(() => waveCache.get(`${src}:${WAVE_BARS}`) || null);
  useEffect(() => {
    if (!src || wave) return undefined;
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    let cancelled = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((en) => en.isIntersecting)) return;
      io.disconnect();
      computeWaveform(src).then((w) => { if (!cancelled && w) setWave(w); });
    }, { rootMargin: '120px' });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [src, wave]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {}); else a.pause();
  };
  const seek = (e) => {
    const a = audioRef.current;
    if (!a || !dur || !Number.isFinite(dur)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    a.currentTime = ratio * dur;
    setCur(a.currentTime);
  };
  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${mm}:${String(ss).padStart(2, '0')}`;
  };
  const pct = dur && Number.isFinite(dur) ? Math.min(100, (cur / dur) * 100) : 0;
  const bars = wave || seededWave(src);
  const playedBars = Math.round((pct / 100) * bars.length);

  return (
    <div className="dv-wa-voice" ref={rootRef}>
      <audio
        ref={audioRef}
        src={src}
        preload={preload}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCur(0); }}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onDurationChange={(e) => setDur(e.currentTarget.duration)}
        onError={onError}
      />
      <button type="button" className="dv-wa-voice-btn" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? PauseGlyph : PlayGlyph}
      </button>
      <div className={`dv-wa-voice-wave${wave ? '' : ' is-estimate'}`} onClick={seek}>
        {bars.map((v, i) => (
          <span
            key={i}
            className={`dv-wa-voice-tick${i < playedBars ? ' is-played' : ''}`}
            style={{ height: `${Math.round(v * 100)}%` }}
          />
        ))}
        <span className="dv-wa-voice-knob" style={{ left: `${pct}%` }} />
      </div>
      <span className="dv-wa-voice-time">{(playing || cur > 0) ? fmt(cur) : fmt(dur)}</span>
    </div>
  );
}

// Feather-style stroke icons for the rail's section tabs.
const RAIL_ICONS = {
  media: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" />
    </svg>
  ),
  stickers: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7z" /><path d="M14 21v-5a2 2 0 0 1 2-2h5" /><path d="M8.5 13.5s1 1.5 3.5 1.5" /><circle cx="9" cy="9.5" r="0.6" fill="currentColor" /><circle cx="14" cy="9.5" r="0.6" fill="currentColor" />
    </svg>
  ),
  voice: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  ),
  links: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  docs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  ),
  contacts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
    </svg>
  ),
  calls: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  ),
};

const SearchGlyph = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);
const ClearGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);
const BurgerGlyph = (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" />
  </svg>
);

// Wrap every case-insensitive occurrence of `q` in `text` with a <mark>, for the
// plain-text view's search highlight. Returns the raw string when q is empty.
function highlightPlain(text, q) {
  if (!q) return text;
  const out = [];
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0; let k = 0;
  for (;;) {
    const idx = lower.indexOf(ql, i);
    if (idx === -1) { out.push(text.slice(i)); break; }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(<mark key={k} className="dv-text-mark">{text.slice(idx, idx + q.length)}</mark>);
    k += 1;
    i = idx + q.length;
  }
  return out;
}

// Hover / right-click chrome for one rail entry — the same morph pill the
// file grids use: hovering shows the cursor-following name pill, and a
// right-click FLIP-morphs that pill into the Open / Find-in-chat menu
// (replaces the old detached dropdown, which just popped in from nowhere).
// Render-prop because rail entries are different elements (buttons, anchors,
// list rows, card wrappers): spread the provided props on the interactive
// element; the portal node renders as its sibling.
function RailItemMorph({ label, items, render }) {
  const morph = useMorphPill({ hoverContent: label, menuItems: items });
  return (
    <>
      {render({
        onMouseMove: morph.handleMouseMove,
        onMouseLeave: morph.handleMouseLeave,
        onContextMenu: (e) => { e.stopPropagation(); morph.handleContextMenu(e); },
      })}
      {morph.node}
    </>
  );
}

// http(s)/www links, trimming trailing punctuation that usually isn't part of
// the URL. (RegExp literal is module-level so it isn't recompiled per render.)
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,!?;:'"]/gi;
function collectLinks(text, into, seen, msgIndex) {
  const matches = String(text || '').match(URL_RE);
  if (!matches) return;
  for (const raw of matches) {
    const url = /^www\./i.test(raw) ? `https://${raw}` : raw;
    if (seen.has(url)) continue;
    seen.add(url);
    into.push({ url, label: raw, msgIndex });
  }
}

// E-mail addresses mentioned in a message — surfaced in the Contacts rail
// alongside shared .vcf cards so the address book also covers people written
// out in plain text.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function collectEmails(text, contacts, seen, msgIndex) {
  const matches = String(text || '').match(EMAIL_RE);
  if (!matches) return;
  for (const raw of matches) {
    const email = raw.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    contacts.push({ kind: 'email', email, msgIndex });
  }
}

// IBANs (e.g. the Romanian "RO61BTRLRONCRT0PA2570501") — country code + 2 check
// digits + up to 30 alphanumerics. Surfaced in the Links rail and highlighted
// inline; clicking copies the number (there's nothing to navigate to).
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{12,30}\b/g;
const IBAN_FULL_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{12,30}$/;
function copyText(text) {
  try { navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ }
}
function collectIbans(text, into, seen, msgIndex) {
  const matches = String(text || '').match(IBAN_RE);
  if (!matches) return;
  for (const raw of matches) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    into.push({ kind: 'iban', value: raw, label: raw, msgIndex });
  }
}

// WhatsApp call entries (missed / answered voice or video calls) export as a
// line whose whole body is the call phrase, e.g. "Missed voice call",
// "Silenced missed video call", "Voice call", and the newer
// "Missed voice call. Tap to call back". Detect them so the chat can style them
// and the Calls rail can list every one. Returns { type, missed, callback,
// label } or null.
// The tail after "call" is optional: ". Tap to call back" (missed) or a
// duration like ". 29 sec." / ". 5 min" / ". 1 hr 3 min" (answered).
const CALL_RE = /^(silenced\s+)?(missed\s+)?(voice|video)\s+call\b\s*\.?\s*(tap to call back\.?|(?:\d+\s*(?:hr|hrs|hours?|min|mins|minutes?|sec|secs|seconds?)\b\.?\s*)+)?$/i;
function detectCall(text) {
  const t = String(text || '').trim();
  const m = CALL_RE.exec(t);
  if (!m) return null;
  const type = m[3].toLowerCase();
  const missed = Boolean(m[2]);
  const silenced = Boolean(m[1]);
  const tail = (m[4] || '').trim();
  const callback = /tap to call back/i.test(tail);
  const duration = callback ? '' : tail.replace(/\.+$/, '').trim();
  let label = `${type === 'video' ? 'Video' : 'Voice'} call`;
  if (missed) label = `Missed ${label.toLowerCase()}`;
  if (silenced) label = `Silenced ${label.toLowerCase()}`;
  return { type, missed, callback, duration: duration || null, label };
}

// Walk the parsed messages once and bucket everything the rail surfaces. Each
// item carries the index of its source message so "Find in chat" can scroll to it.
function buildRailContent(messages) {
  const media = []; const docs = []; const contacts = []; const links = []; const calls = [];
  const stickers = []; const voice = [];
  const seenLinks = new Set(); const seenEmails = new Set(); const seenIbans = new Set();
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m.attachment) {
      const call = detectCall(m.text);
      if (call) calls.push({ ...call, time: m.time, sender: m.sender || null, msgIndex: i });
    }
    if (m.system) continue;
    if (m.attachment) {
      const name = m.attachment.name;
      const e = extOf(name);
      if (e === 'vcf') contacts.push({ kind: 'vcf', name, msgIndex: i });
      else if (isSticker(name)) stickers.push({ name, msgIndex: i });
      else {
        const k = mediaKindOf(name);
        if (k === 'image' || k === 'video') media.push({ name, kind: k, msgIndex: i });
        else if (k === 'audio') voice.push({ name, msgIndex: i });
        else docs.push({ name, kind: k, msgIndex: i });
      }
      if (m.attachment.caption) {
        collectLinks(m.attachment.caption, links, seenLinks, i);
        collectEmails(m.attachment.caption, contacts, seenEmails, i);
        collectIbans(m.attachment.caption, links, seenIbans, i);
      }
    } else if (m.text) {
      collectLinks(m.text, links, seenLinks, i);
      collectEmails(m.text, contacts, seenEmails, i);
      collectIbans(m.text, links, seenIbans, i);
    }
  }
  return { media, stickers, voice, docs, contacts, links, calls };
}

function WhatsAppRail({ messages, dir, sep, onFindInChat, width, rangeActive, timeInRange, query }) {
  const railAll = useMemo(() => buildRailContent(messages), [messages]);
  // The chat's date-range filter AND the search query propagate here: every
  // entry is tied to its source message (msgIndex), so each section — and its
  // tab count — narrows to the same From → To window the conversation shows,
  // and the search matches against each entry's own text (filename, URL,
  // e-mail, call label, …) plus its sender. Entries that can't be dated (no
  // msgIndex) stay visible under the date filter rather than silently
  // vanishing.
  const q = (query || '').trim().toLowerCase();
  const { media, stickers, voice, docs, contacts, links, calls } = useMemo(() => {
    if (!rangeActive && !q) return railAll;
    const inRange = (it) => !rangeActive || it.msgIndex == null || timeInRange(messages[it.msgIndex]?.time);
    const matchesQ = (it) => {
      if (!q) return true;
      const src = it.msgIndex != null ? messages[it.msgIndex] : null;
      return [it.name, it.email, it.url, it.label, it.value, it.sender, src?.sender]
        .some((s) => s && String(s).toLowerCase().includes(q));
    };
    const keep = (it) => inRange(it) && matchesQ(it);
    return {
      media: railAll.media.filter(keep),
      stickers: railAll.stickers.filter(keep),
      voice: railAll.voice.filter(keep),
      docs: railAll.docs.filter(keep),
      contacts: railAll.contacts.filter(keep),
      links: railAll.links.filter(keep),
      calls: railAll.calls.filter(keep),
    };
  }, [railAll, rangeActive, timeInRange, messages, q]);
  const tabs = [
    { id: 'media', label: 'Media', count: media.length, icon: RAIL_ICONS.media },
    { id: 'stickers', label: 'Stickers', count: stickers.length, icon: RAIL_ICONS.stickers },
    { id: 'voice', label: 'Voice notes', count: voice.length, icon: RAIL_ICONS.voice },
    { id: 'links', label: 'Links', count: links.length, icon: RAIL_ICONS.links },
    { id: 'docs', label: 'Docs', count: docs.length, icon: RAIL_ICONS.docs },
    { id: 'contacts', label: 'Contacts', count: contacts.length, icon: RAIL_ICONS.contacts },
    { id: 'calls', label: 'Calls', count: calls.length, icon: RAIL_ICONS.calls },
  ];
  const [tab, setTab] = useState(() => tabs.find((t) => t.count > 0)?.id || 'media');

  const urlFor = (name) => (dir ? localUrlFor(`${dir}${sep}${name}`) : null);
  // Grid tiles are ~108px — a 256px thumb covers 2x density. Stickers ask
  // too, but webp ignores the param (keeps animation/alpha) — harmless.
  const thumbFor = (name) => (dir ? localUrlFor(`${dir}${sep}${name}`, 256) : null);
  const pathFor = (name) => (dir ? `${dir}${sep}${name}` : name);
  const openOnDisk = (name) => { if (dir) localFolderApi.openPath(pathFor(name)); };

  // Files-tab interaction model: a single click SELECTS an entry (accent ring,
  // like .fx-tile.is-selected), a double click performs its open action.
  // Keys are `${section}:${msgIndex}` — one rail entry per source message, so
  // selection survives the search/date filters reordering the lists.
  const [selKey, setSelKey] = useState(null);
  const isSel = (key) => selKey === key;
  const selProps = (key, onOpen) => ({
    onClick: () => setSelKey(key),
    onDoubleClick: onOpen,
  });

  // Right-click morph-menu entries shared by every section: an open action
  // (label varies — Copy for IBANs) + "Find in chat".
  const railMenuItems = ({ onOpen, openDisabled, msgIndex, openLabel = 'Open' }) => [
    { key: 'open', label: openLabel, onClick: onOpen, disabled: Boolean(openDisabled) },
    { key: 'find', label: 'Find in chat', onClick: () => onFindInChat?.(msgIndex), disabled: msgIndex == null },
  ];

  return (
    <aside className="dv-wa-rail" style={width ? { width: `${width}px`, flex: 'none' } : undefined}>
      {/* No section title — the tabs sit flush at the top, in line with the
          AI-advisor tab strip on other file types. */}
      <div className="dv-wa-rail-tabs" role="tablist">
        {tabs.map((t) => (
          <Tooltip key={t.id} content={t.label}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`dv-wa-rail-tab${tab === t.id ? ' is-active' : ''}`}
              onClick={() => { setTab(t.id); setSelKey(null); }}
            >
              {t.icon}
              <span className="dv-wa-rail-tab-label">{t.label}</span>
              {t.count > 0 && <span className="dv-wa-rail-count">{t.count}</span>}
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="dv-wa-rail-body">
        {tab === 'media' && (media.length ? (
          <div className="dv-wa-rail-grid">
            {media.map((it, i) => (
              <RailItemMorph
                key={i}
                label={it.name}
                items={railMenuItems({ onOpen: () => openOnDisk(it.name), openDisabled: !dir, msgIndex: it.msgIndex })}
                render={(morphProps) => (
                  <button
                    type="button"
                    className={`dv-wa-rail-tile${isSel(`media:${it.msgIndex}`) ? ' is-selected' : ''}`}
                    {...selProps(`media:${it.msgIndex}`, () => openOnDisk(it.name))}
                    {...morphProps}
                  >
                    {it.kind === 'image' ? (
                      <img src={thumbFor(it.name)} alt={it.name} loading="lazy" decoding="async" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                    ) : (
                      // Video: OS-generated poster frame with a play badge on
                      // top. The gradient glyph sits behind as the fallback —
                      // when no poster can be generated the handler streams
                      // video bytes, the <img> errors out and hides itself,
                      // and the gradient shows through.
                      <>
                        <span className="dv-wa-rail-vid">{PlayGlyph}</span>
                        <img className="dv-wa-rail-vidposter" src={thumbFor(it.name)} alt={it.name} loading="lazy" decoding="async" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                        <span className="dv-wa-rail-vidplay" aria-hidden="true">{PlayGlyph}</span>
                      </>
                    )}
                  </button>
                )}
              />
            ))}
          </div>
        ) : <div className="dv-wa-rail-empty">No photos or videos</div>)}

        {tab === 'stickers' && (stickers.length ? (
          <div className="dv-wa-rail-stickers">
            {stickers.map((it, i) => (
              <RailItemMorph
                key={i}
                label={it.name}
                items={railMenuItems({ onOpen: () => openOnDisk(it.name), openDisabled: !dir, msgIndex: it.msgIndex })}
                render={(morphProps) => (
                  <button
                    type="button"
                    className={`dv-wa-rail-sticker${isSel(`sticker:${it.msgIndex}`) ? ' is-selected' : ''}`}
                    {...selProps(`sticker:${it.msgIndex}`, () => openOnDisk(it.name))}
                    {...morphProps}
                  >
                    <img src={thumbFor(it.name)} alt={it.name} loading="lazy" decoding="async" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                  </button>
                )}
              />
            ))}
          </div>
        ) : <div className="dv-wa-rail-empty">No stickers</div>)}

        {tab === 'voice' && (voice.length ? (
          <ul className="dv-wa-rail-list">
            {voice.map((v, i) => (
              <RailItemMorph
                key={i}
                label={v.name}
                items={railMenuItems({ onOpen: () => onFindInChat?.(v.msgIndex), openDisabled: v.msgIndex == null, msgIndex: v.msgIndex })}
                render={(morphProps) => (
                  <li
                    className={`dv-wa-rail-voice${isSel(`voice:${v.msgIndex}`) ? ' is-selected' : ''}`}
                    {...selProps(`voice:${v.msgIndex}`, () => onFindInChat?.(v.msgIndex))}
                    {...morphProps}
                  >
                    {dir && <VoiceNote src={urlFor(v.name)} preload="none" />}
                    <span className="dv-wa-rail-voice-name">{v.name}</span>
                  </li>
                )}
              />
            ))}
          </ul>
        ) : <div className="dv-wa-rail-empty">No voice notes</div>)}

        {tab === 'links' && (links.length ? (
          <div className="dv-wa-rail-groups">
            {[
              { key: 'web', title: 'Links', items: links.filter((l) => l.kind !== 'iban') },
              { key: 'iban', title: 'IBANs', items: links.filter((l) => l.kind === 'iban') },
            ].filter((g) => g.items.length).map((g) => (
              <div key={g.key}>
                <div className="dv-wa-rail-divider">{g.title}</div>
                <ul className="dv-wa-rail-list">
                  {g.items.map((l, i) => (
                    <li key={i}>
                      {l.kind === 'iban' ? (
                        <RailItemMorph
                          label="Copy IBAN"
                          items={railMenuItems({ onOpen: () => copyText(l.value), msgIndex: l.msgIndex, openLabel: 'Copy IBAN' })}
                          render={(morphProps) => (
                            <button
                              type="button"
                              className={`dv-wa-rail-link dv-wa-rail-iban${isSel(`iban:${l.msgIndex}:${l.value}`) ? ' is-selected' : ''}`}
                              {...selProps(`iban:${l.msgIndex}:${l.value}`, () => copyText(l.value))}
                              {...morphProps}
                            >
                              {l.label}
                            </button>
                          )}
                        />
                      ) : (
                        <RailItemMorph
                          label={l.url}
                          items={railMenuItems({ onOpen: () => openExternal(l.url), msgIndex: l.msgIndex })}
                          render={(morphProps) => (
                            <a
                              className={`dv-wa-rail-link${isSel(`link:${l.msgIndex}:${l.url}`) ? ' is-selected' : ''}`}
                              href={l.url}
                              onClick={(e) => { e.preventDefault(); setSelKey(`link:${l.msgIndex}:${l.url}`); }}
                              onDoubleClick={() => openExternal(l.url)}
                              {...morphProps}
                            >
                              {l.label}
                            </a>
                          )}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : <div className="dv-wa-rail-empty">No links</div>)}

        {tab === 'docs' && (docs.length ? (
          <div className="dv-wa-rail-docs">
            {docs.map((d, i) => (
              <RailItemMorph
                key={i}
                label={d.name}
                items={railMenuItems({ onOpen: () => openOnDisk(d.name), openDisabled: !dir, msgIndex: d.msgIndex })}
                render={(morphProps) => (
                  <button
                    type="button"
                    className={`dv-wa-rail-doc${isSel(`doc:${d.msgIndex}`) ? ' is-selected' : ''}`}
                    {...selProps(`doc:${d.msgIndex}`, () => openOnDisk(d.name))}
                    disabled={!dir}
                    {...morphProps}
                  >
                    <span className="dv-wa-rail-doc-icon">{docIconFor(d.name)}</span>
                    <span className="dv-wa-rail-doc-name">{d.name}</span>
                  </button>
                )}
              />
            ))}
          </div>
        ) : <div className="dv-wa-rail-empty">No documents</div>)}

        {tab === 'contacts' && (contacts.length ? (
          <div className="dv-wa-rail-contacts">
            {contacts.map((c, i) => (c.kind === 'email' ? (
              <RailItemMorph
                key={i}
                label={c.email}
                items={railMenuItems({ onOpen: () => openExternal(`mailto:${c.email}`), msgIndex: c.msgIndex })}
                render={(morphProps) => (
                  <div
                    className={`dv-wa-rail-contactwrap${isSel(`contact:${c.msgIndex}:${c.email}`) ? ' is-selected' : ''}`}
                    {...selProps(`contact:${c.msgIndex}:${c.email}`, () => openExternal(`mailto:${c.email}`))}
                    {...morphProps}
                  >
                    <EmailContactCard email={c.email} />
                  </div>
                )}
              />
            ) : (
              <RailItemMorph
                key={i}
                label={c.name}
                items={railMenuItems({ onOpen: () => openOnDisk(c.name), openDisabled: !dir, msgIndex: c.msgIndex })}
                render={(morphProps) => (
                  <div
                    className={`dv-wa-rail-contactwrap${isSel(`contact:${c.msgIndex}`) ? ' is-selected' : ''}`}
                    {...selProps(`contact:${c.msgIndex}`, () => openOnDisk(c.name))}
                    {...morphProps}
                  >
                    <ContactCard name={c.name} fullPath={dir ? pathFor(c.name) : null} url={urlFor(c.name)} />
                  </div>
                )}
              />
            )))}
          </div>
        ) : <div className="dv-wa-rail-empty">No contacts</div>)}

        {tab === 'calls' && (calls.length ? (
          <ul className="dv-wa-rail-list">
            {calls.map((c, i) => (
              <li key={i}>
                <RailItemMorph
                  label={c.label}
                  items={railMenuItems({ onOpen: () => onFindInChat?.(c.msgIndex), openDisabled: c.msgIndex == null, msgIndex: c.msgIndex })}
                  render={(morphProps) => (
                <button
                  type="button"
                  className={`dv-wa-rail-call${isSel(`call:${c.msgIndex}`) ? ' is-selected' : ''}`}
                  {...selProps(`call:${c.msgIndex}`, () => onFindInChat?.(c.msgIndex))}
                  {...morphProps}
                >
                  <span className={`dv-wa-call-icon${c.missed ? ' is-missed' : c.duration ? ' is-answered' : ''}`}>
                    {c.type === 'video' ? VideoGlyph : PhoneGlyph}
                  </span>
                  <span className="dv-wa-call-meta">
                    <span className="dv-wa-call-label">{c.label}</span>
                    {(c.sender || c.duration || c.time) && (
                      <span className="dv-wa-call-sub">{[c.sender, c.duration, c.time].filter(Boolean).join(' · ')}</span>
                    )}
                  </span>
                </button>
                  )}
                />
              </li>
            ))}
          </ul>
        ) : <div className="dv-wa-rail-empty">No calls</div>)}
      </div>
    </aside>
  );
}

// ── Text pane (plain / markdown / WhatsApp) ────────────────────────────
// Fetches the file body and renders it. A `.txt` that parses as a WhatsApp
// export gets a top-left toggle between the styled conversation and raw text;
// markdown renders through ReactMarkdown; everything else is a <pre>.
// Read cap for text files. Generous because WhatsApp exports of long group
// chats run tens of MB — the conversation view stays fast on those (windowed
// rows + content-visibility), so truncating at a few MB would silently drop
// most of the history. The PLAIN <pre> / markdown view keeps a smaller cap:
// one multi-MB text node is where Chromium's line layout actually chokes.
const TEXT_MAX_BYTES = 32 * 1024 * 1024;
const PRE_MAX_CHARS = 4 * 1024 * 1024;

function DocTextPane({ file, url, dir, sep, onWhatsAppDetected }) {
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);
  // Default to the Docvex skin for recognised WhatsApp convos (the user can
  // switch to the Plain-text view). Only matters once the content parses as a
  // chat — plain text always renders below.
  const [mode, setMode] = useState('docvex'); // 'docvex' | 'plain'
  const [query, setQuery] = useState('');
  // "Find in chat" target — { index, n }. The bumped `n` makes the chat's
  // scroll effect re-fire even when the same message is requested twice.
  const [findReq, setFindReq] = useState(null);
  const findInChat = useCallback((index) => {
    if (index == null) return;
    setFindReq((prev) => ({ index, n: (prev?.n || 0) + 1 }));
  }, []);

  // Drag-to-resize the media/links/docs rail. The handle sits on the rail's
  // RIGHT edge (the split's last child), so dragging right grows the rail
  // OUTWARD: the split widens into the pane's free space (it defaults to
  // half the pane) and the conversation column keeps its width. Once the
  // split hits the pane edge, further growth comes out of the conversation.
  // Both widths stay null until the first drag (CSS defaults apply).
  // Column widths (layout px). The conversation is FIXED at a readable
  // 640px (not resizable); only the rail is user-draggable. Its minimum is
  // derived from the Media grid so dragging can never drop below 4 tiles
  // per row: 4 tiles × 108px + 3 × 4px gaps + 2 × 12px body padding + 2px
  // of borders + 10px for the body's scrollbar and subpixel rounding under
  // the app zoom (an exact-to-the-pixel fit lets the scrollbar steal a
  // column).
  const CHAT_BASE = 640;
  const RAIL_MIN = 4 * 108 + 3 * 4 + 2 * 12 + 2 + 10;
  const RAIL_BASE = RAIL_MIN;
  const [railWidth, setRailWidth] = useState(null);
  // Docvex skin only: the conversation column is a fixed, draggable width (the
  // media rail fills the rest). Persisted across files so the chat ↔ media split
  // is remembered the next time a conversation is opened. null → 50/50 default.
  const CHAT_COL_MIN = 360;
  const [chatW, setChatW] = useState(() => {
    const w = readDvLayout().chatW;
    return typeof w === 'number' ? w : null;
  });
  // Burger toggle (chat header, right edge). CLOSED by default — opening
  // adds the rail as its own section BESIDE the conversation (the split
  // widens by the rail's width, the conversation keeps its size).
  const [railOpen, setRailOpen] = useState(false);
  const toggleRail = useCallback(() => setRailOpen((v) => !v), []);
  const splitRef = useRef(null);
  // The chat column's inner scroller — wrapped so a custom overlay scrollbar can
  // sit OUTSIDE it (the native bar is hidden), keeping the sticky tab strip and
  // footer full-width instead of being narrowed by the gutter.
  const chatScrollRef = useRef(null);
  // Slot ABOVE the tab bars that the search + date-range controls portal into,
  // so they sit at the very top of the conversation section.
  const [headerSlot, setHeaderSlot] = useState(null);
  // Both drags write widths STRAIGHT to the DOM (rAF-coalesced) and commit
  // React state once on mouseup. Routing every mousemove through setState
  // re-rendered the whole split — hundreds of chat rows plus every rail
  // entry (the Voice tab alone re-reconciled ~15k waveform ticks) — which
  // is what dropped the frame rate while resizing.
  // Shared scaffolding: cursor/selection lock + rAF coalescing + the
  // one-commit mouseup.
  const dragHorizontal = (e, onDx, onDone) => {
    e.preventDefault();
    const startX = e.clientX;
    let frame = null;
    let pendingDx = 0;
    const onMove = (ev) => {
      pendingDx = toLayoutPx(ev.clientX - startX);
      if (frame == null) {
        frame = requestAnimationFrame(() => { frame = null; onDx(pendingDx); });
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (frame != null) cancelAnimationFrame(frame);
      onDx(pendingDx); // land on the final cursor position
      onDone();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // Handle on the rail's RIGHT edge — resizes the rail outward; the
  // conversation keeps its (fixed) width. Floored at RAIL_MIN so the media
  // tiles never shrink — narrower just means fewer per row, down to 3.
  const startRailResize = (e) => {
    const split = splitRef.current;
    const railEl = split?.querySelector('.dv-wa-rail');
    if (!split || !railEl) return;
    const startRail = railWidth ?? RAIL_BASE;
    const paneW = split.parentElement ? toLayoutPx(split.parentElement.getBoundingClientRect().width) : Infinity;
    let lastRail = startRail;
    dragHorizontal(e, (dx) => {
      lastRail = Math.max(RAIL_MIN, Math.min(Math.max(RAIL_MIN, paneW - CHAT_BASE), startRail + dx));
      railEl.style.width = `${lastRail}px`;
      railEl.style.flex = 'none';
      split.style.width = `${CHAT_BASE + lastRail}px`;
    }, () => setRailWidth(lastRail));
  };

  // Docvex skin: handle between the conversation and the media rail. Resizes the
  // chat column (fixed width); the rail flexes to fill the rest. Persisted.
  const startChatColResize = (e) => {
    const split = splitRef.current;
    const chatEl = split?.querySelector('.dv-wa-chatcol');
    if (!split || !chatEl) return;
    const startW = toLayoutPx(chatEl.getBoundingClientRect().width);
    const paneW = toLayoutPx(split.getBoundingClientRect().width);
    let last = startW;
    dragHorizontal(e, (dx) => {
      const maxChat = Math.max(CHAT_COL_MIN, paneW - RAIL_MIN - 6);
      last = Math.max(CHAT_COL_MIN, Math.min(maxChat, startW + dx));
      chatEl.style.flex = 'none';
      chatEl.style.width = `${last}px`;
    }, () => { setChatW(last); writeDvLayout({ chatW: last }); });
  };

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = (await res.text()).slice(0, TEXT_MAX_BYTES);
        if (!cancelled) setContent(text);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load text');
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  const isMarkdown = file.mime_type === 'text/markdown' || /\.md$/i.test(file.name);
  const chat = useMemo(
    () => (content != null && !isMarkdown ? parseWhatsAppChat(content) : { messages: [], isWhatsApp: false }),
    [content, isMarkdown],
  );

  // Tell the shell this tab is a WhatsApp conversation (content-parsed, not
  // name-based) so its sidebar tile shows the WhatsApp mark.
  useEffect(() => {
    if (chat.isWhatsApp) onWhatsAppDetected?.();
  }, [chat.isWhatsApp, onWhatsAppDetected]);

  // Date-range filter (the From/To controls under the chat's search bar).
  // Owned here — not by the chat — because the rail filters by the same
  // range: every Media/Links/Docs/… entry hides with its message.
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  // Calendar modal (the From → To picker) open state.
  const [dateModalOpen, setDateModalOpen] = useState(false);
  const dayResolver = useMemo(() => buildDayResolver(chat.messages), [chat.messages]);
  // The conversation's own date span (first → last parseable message). The
  // From/To inputs default to these so the user sees the real range and narrows
  // inward, rather than starting from blank fields.
  const dateBounds = useMemo(() => {
    let min = null; let max = null;
    for (const m of chat.messages) {
      const k = dayResolver(m.time);
      if (k == null) continue;
      if (min == null || k < min) min = k;
      if (max == null || k > max) max = k;
    }
    return { minKey: min, maxKey: max, from: keyToDateInput(min), to: keyToDateInput(max) };
  }, [chat.messages, dayResolver]);
  // Seed (and re-seed on a new conversation) the inputs to the full span.
  useEffect(() => {
    setDateFrom(dateBounds.from);
    setDateTo(dateBounds.to);
  }, [dateBounds.from, dateBounds.to]);
  const fromKey = dateInputKey(dateFrom);
  const toKey = dateInputKey(dateTo);
  // "Active" only once the user narrows INSIDE the conversation's own span —
  // the default (full span) shows everything, exactly as an empty filter did,
  // so unparseable-timestamp lines aren't hidden just because defaults are set.
  const rangeActive = (fromKey != null && (dateBounds.minKey == null || fromKey > dateBounds.minKey))
    || (toKey != null && (dateBounds.maxKey == null || toKey < dateBounds.maxKey));
  const timeInRange = useCallback((time) => {
    if (!rangeActive) return true;
    const k = dayResolver(time);
    if (k == null) return false; // unparseable timestamp — hide while filtering
    if (fromKey != null && k < fromKey) return false;
    if (toKey != null && k > toKey) return false;
    return true;
  }, [dayResolver, fromKey, toKey, rangeActive]);
  // Clear/reset returns the inputs to the full conversation span (not blank).
  const resetDates = useCallback(() => {
    setDateFrom(dateBounds.from);
    setDateTo(dateBounds.to);
  }, [dateBounds.from, dateBounds.to]);
  // Stable apply for the calendar modal's live draft (from/to are date inputs).
  const applyDates = useCallback((from, to) => {
    setDateFrom(from);
    setDateTo(to);
  }, []);

  // The search input (in the chat's POV header) stays controlled by `query`,
  // but everything expensive (filtering + re-rendering thousands of rows)
  // keys off the deferred copy, so typing stays responsive on huge
  // conversations — React catches the list up between keystrokes.
  const deferredQuery = useDeferredValue(query);

  // Plain-text view honours the same search + date range as the chat view. With
  // no filter active it shows the RAW export verbatim (fidelity); once a query
  // or a date range is set it falls back to a reconstructed, filtered listing
  // (one line per message) so search + From/To actually do something here too.
  const plainQuery = (deferredQuery || '').trim();
  const plainText = useMemo(() => {
    if (!chat.isWhatsApp) return content;
    const ql = plainQuery.toLowerCase();
    if (!ql && !rangeActive) return content;
    const out = [];
    for (const m of chat.messages) {
      if (rangeActive && !timeInRange(m.time)) continue;
      const body = m.attachment ? m.attachment.name : (m.omitted ? '<media omitted>' : (m.text || ''));
      const line = m.system
        ? `${m.time ? `[${m.time}] ` : ''}${m.text || ''}`
        : `[${m.time}] ${m.sender || ''}: ${body}`;
      if (ql && !line.toLowerCase().includes(ql)) continue;
      out.push(line);
    }
    return out.join('\n');
  }, [chat, content, plainQuery, rangeActive, timeInRange]);
  const plainMatchCount = useMemo(() => {
    const q = plainQuery.toLowerCase();
    if (!q) return 0;
    const t = plainText.toLowerCase();
    let n = 0; let i = 0;
    while ((i = t.indexOf(q, i)) !== -1) { n += 1; i += q.length; }
    return n;
  }, [plainText, plainQuery]);

  // The date picker is open AND this is a chat — its content replaces the
  // message + file bodies in place (tab strips stay).
  const pickerOpen = dateModalOpen && chat.isWhatsApp;
  // Keep the calendar screen mounted while it fades out, so the close is
  // animated rather than an instant unmount. `pickerClosing` drives the
  // fade-out keyframe; onAnimationEnd unmounts. (Declared before the early
  // returns below so the Hook order stays stable.)
  const [pickerMounted, setPickerMounted] = useState(false);
  const [pickerClosing, setPickerClosing] = useState(false);
  useEffect(() => {
    if (pickerOpen) {
      setPickerMounted(true);
      setPickerClosing(false);
    } else if (pickerMounted) {
      setPickerClosing(true);
    }
  }, [pickerOpen, pickerMounted]);

  if (error) return <div className="dv-noview"><p className="dv-noview-title">Couldn't read the file</p><p className="dv-noview-sub">{error}</p></div>;
  if (content == null) return <div className="dv-loading">Loading text…</div>;

  const showChat = chat.isWhatsApp && mode === 'docvex';
  // Docvex skin pins the media rail open beside the conversation and splits the
  // space up to the extraction panel 50/50 (no fixed width, no resize handle).
  const docvex = mode === 'docvex';
  const railShown = docvex || railOpen;

  // Display-mode toggle (WhatsApp / Docvex / Plain text). Lives in the chat's
  // footer next to the search + date controls (and in a footer of its own in
  // plain-text mode so you can always switch back).
  const modeToggle = chat.isWhatsApp ? (
    <div className="dv-text-toggle" role="group" aria-label="Display mode">
      <button
        type="button"
        className={`dv-text-toggle-btn${mode === 'docvex' ? ' is-active' : ''}`}
        onClick={() => setMode('docvex')}
        aria-pressed={mode === 'docvex'}
      >
        {DocvexGlyph}
        Docvex
      </button>
      <button
        type="button"
        className={`dv-text-toggle-btn${mode === 'plain' ? ' is-active' : ''}`}
        onClick={() => setMode('plain')}
        aria-pressed={mode === 'plain'}
      >
        Plain text
      </button>
    </div>
  ) : null;

  return (
    <div className="dv-text-pane">
      {showChat ? (
        <div className="dv-wa-card">
        {/* Full-width slot ABOVE the tab bars — the search + date controls
            portal in here so they top the whole conversation section, as the
            rounded card's top bar. */}
        <div className="dv-wa-headerslot" ref={setHeaderSlot} />
        <DateRangeProvider
          open={pickerOpen}
          messages={chat.messages}
          dayResolver={dayResolver}
          fromKey={fromKey}
          toKey={toKey}
          minKey={dateBounds.minKey}
          maxKey={dateBounds.maxKey}
          onChange={applyDates}
          onReset={resetDates}
        >
        <div
          className={`dv-wa-split${docvex ? ' is-fluid' : ''}`}
          ref={splitRef}
          // WhatsApp skin: derived width — the conversation's width plus the
          // rail's when the burger opens it (the resize handles contribute no
          // layout width; max-width:100% caps it at the pane edge). Docvex skin
          // (is-fluid): no inline width — the split fills the pane up to the
          // extraction panel and chat + rail share it 50/50 via CSS.
          style={docvex ? undefined : { width: `${CHAT_BASE + (railOpen ? Math.round(railWidth ?? RAIL_BASE) : 0)}px` }}
        >
          <div
            className="dv-wa-chatcol"
            // Docvex: fixed, draggable width once the user has resized it (else
            // 50/50 via CSS). WhatsApp skin keeps its own fixed CHAT_BASE width.
            // While the picker is open the rail is hidden, so the column spans
            // the full width (ignore any saved fixed width).
            style={docvex && chatW != null ? { flex: 'none', width: `${chatW}px` } : undefined}
          >
            {/* View-mode tabs (Docvex / Plain text) — a tab strip at the top-left
                of the conversation section, styled like the media rail's tabbar
                and in line with it. Outside the scroller so the scrollbar gutter
                never narrows it. */}
            {modeToggle}
            {/* The date picker is an overlay (rendered below over the whole
                split), so the messages body stays mounted and visible behind
                it — the WhatsAppChat header controls keep portalling normally. */}
            <div className="dv-wa-chatscroll-wrap">
              <div className="dv-wa-chatscroll" ref={chatScrollRef}>
                <WhatsAppChat
                  variant={mode}
                  messages={chat.messages}
                  dir={dir}
                  sep={sep}
                  highlight={findReq}
                  query={deferredQuery}
                  rawQuery={query}
                  onQueryChange={setQuery}
                  dateFrom={dateFrom}
                  dateTo={dateTo}
                  onOpenDates={() => setDateModalOpen((v) => !v)}
                  datesOpen={pickerOpen}
                  rangeActive={rangeActive}
                  timeInRange={timeInRange}
                  railOpen={railOpen}
                  onToggleRail={toggleRail}
                  headerSlot={headerSlot}
                />
              </div>
              <SidebarScrollbar scrollRef={chatScrollRef} refreshKey={chat.messages} />
            </div>
          </div>
          {/* Docvex: draggable divider between the conversation and the media rail. */}
          {docvex && railShown && (
            <Tooltip content="Drag to resize the conversation"><div className="dv-wa-resizer" onMouseDown={startChatColResize} role="separator" aria-orientation="vertical" /></Tooltip>
          )}
          {railShown && (
            <>
              <WhatsAppRail
                messages={chat.messages}
                dir={dir}
                sep={sep}
                onFindInChat={findInChat}
                width={docvex ? null : (railWidth ?? RAIL_BASE)}
                rangeActive={rangeActive}
                timeInRange={timeInRange}
                query={deferredQuery}
              />
              {!docvex && <Tooltip content="Drag to resize the panel"><div className="dv-wa-resizer" onMouseDown={startRailResize} role="separator" aria-orientation="vertical" /></Tooltip>}
            </>
          )}
          {/* Date picker — overlays the whole split (messages + media rail)
              rather than replacing them; messages/media stay visible behind. */}
          {pickerMounted && (
            <DateRangeCalendars
              closing={pickerClosing}
              onClose={() => setDateModalOpen(false)}
              onExited={() => {
                setPickerMounted(false);
                setPickerClosing(false);
              }}
            />
          )}
        </div>
        </DateRangeProvider>
        </div>
      ) : (
        <>
          {/* Search + From → To bar (same controls as the chat view), so the
              plain-text view can be searched and date-filtered too. WhatsApp
              chats only — a plain non-chat file has no message dates. */}
          {chat.isWhatsApp && (
            <div className="dv-wa-controls">
              <div className="dv-wa-header-controls">
                <div className={`fx-search${(query || '').trim() ? ' is-active' : ''}`}>
                  <span className="fx-search-glyph">{SearchGlyph}</span>
                  <input
                    type="text"
                    value={query || ''}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape' && (query || '')) { e.stopPropagation(); setQuery(''); } }}
                    placeholder="Search this text"
                    aria-label="Search the plain text"
                  />
                  {plainQuery ? (
                    <span className={`dv-wa-find-count${plainMatchCount === 0 ? ' is-empty' : ''}`} aria-live="polite">
                      {plainMatchCount ? plainMatchCount.toLocaleString() : 'No results'}
                    </span>
                  ) : null}
                  {(query || '') ? (
                    <button type="button" className="fx-search-clear" onClick={() => setQuery('')} aria-label="Clear search">
                      {ClearGlyph}
                    </button>
                  ) : (
                    <span className="fx-search-kbd" aria-hidden="true">
                      <kbd>{/mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'}</kbd>
                      <span className="fx-search-kbd-plus">+</span>
                      <kbd>F</kbd>
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
          {/* Same view-mode tab strip pinned at the top-left in plain-text mode,
              so you can always switch back to the Docvex view. */}
          {modeToggle}
          <div className="dv-text-scroll">
            {!chat.isWhatsApp && content.length > PRE_MAX_CHARS && (
              <div className="dv-text-truncated">
                Showing the first {Math.round(PRE_MAX_CHARS / (1024 * 1024))} MB — switch to the Docvex view for the full conversation.
              </div>
            )}
            {isMarkdown ? (
              <div className="dv-text-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content.slice(0, PRE_MAX_CHARS)}</ReactMarkdown></div>
            ) : (
              <pre className="dv-text-pre">{highlightPlain(plainText.slice(0, PRE_MAX_CHARS), plainQuery)}</pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const WhatsAppGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
    <path d="M12 2a10 10 0 0 0-8.6 15l-1.3 4.8 4.9-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-2.9.8.8-2.8-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.6-6.1c-.3-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-2-1.2 7.4 7.4 0 0 1-1.4-1.7c-.1-.3 0-.4.1-.5l.4-.5.3-.4v-.4l-.8-1.9c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 2.9 2.9 0 0 0-.9 2.2 5 5 0 0 0 1.1 2.7 11.5 11.5 0 0 0 4.4 3.9c2.6 1 2.6.7 3.1.6a2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .1-1.2c-.1-.1-.3-.2-.5-.3z" />
  </svg>
);
// Speech-bubble mark for the Docvex (Team-chat-styled) view toggle.
const DocvexGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
  </svg>
);

// ── Photo / video pane with the text-extraction (OCR) tool ─────────────
const ScanTextGlyph = (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7V5a2 2 0 0 1 2-2h2" />
    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
    <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    <path d="M7 9h10" />
    <path d="M7 13h7" />
    <path d="M7 17h4" />
  </svg>
);

// "Extract text" selection-tool icons for the tool-picker pill.
const HighlightToolGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="12" r="7" />
  </svg>
);
const CircleToolGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="12" cy="12" r="8" />
  </svg>
);
const SquareToolGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </svg>
);
const LassoToolGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3c4.5 0 8 2.4 8 6.2 0 2.8-1.9 4.4-4.2 5.3-1 .4-1.3 1-1 1.9.3 1 .9 2.3-1 3-2.4.9-9.8-.8-9.8-6.4C4 7.8 7.5 3 12 3z" strokeDasharray="2.4 2.2" />
  </svg>
);
const ChevronGlyph = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6l4 4 4-4" />
  </svg>
);

// ── Custom video player glyphs ───────────────────────────────────
// PlayGlyph, PauseGlyph, VolumeHighGlyph, VolumeMuteGlyph are already
// declared above (shared with the WhatsApp media player).

// Document glyph — the AI-document version cards in the advisor thread.
const DocCardGlyph = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <polyline points="14 3 14 8 19 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
);

// Per-doc-type glyphs for the version card (a page outline + a type-specific
// mark): Word = text lines, PowerPoint = bar chart, Excel = grid, PDF = label.
const DocPageBase = (<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><polyline points="14 3 14 8 19 8" /></>);
const VerWordGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {DocPageBase}
    <line x1="8.5" y1="12.5" x2="15.5" y2="12.5" /><line x1="8.5" y1="15.5" x2="15.5" y2="15.5" /><line x1="8.5" y1="18" x2="12.5" y2="18" />
  </svg>
);
const VerSlidesGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {DocPageBase}
    <line x1="9" y1="18.5" x2="9" y2="14.5" /><line x1="12" y1="18.5" x2="12" y2="12.5" /><line x1="15" y1="18.5" x2="15" y2="16" />
  </svg>
);
const VerSheetGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {DocPageBase}
    <line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="16.5" x2="16" y2="16.5" /><line x1="12" y1="11.5" x2="12" y2="18.5" />
  </svg>
);
const VerPdfGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {DocPageBase}
    <text x="11.5" y="18.4" textAnchor="middle" fontSize="6.2" fontWeight="700" fill="currentColor" stroke="none">PDF</text>
  </svg>
);
// ext → [color class suffix, glyph]
const VERSION_ICON = {
  docx: ['doc', VerWordGlyph], doc: ['doc', VerWordGlyph],
  pptx: ['ppt', VerSlidesGlyph], ppt: ['ppt', VerSlidesGlyph],
  xlsx: ['xls', VerSheetGlyph], xls: ['xls', VerSheetGlyph],
  pdf: ['pdf', VerPdfGlyph],
};

// Crosshair / re-centre glyph — the "Center video" button under Extract text.
const CenterGlyph = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2v3.4M12 18.6V22M2 12h3.4M18.6 12H22" />
  </svg>
);

// Selection tools for "Extract text": Highlight (default) paints a brush
// stroke like a highlighter marker; Circle/Square drag a shape outward from
// the click point; Custom traces a freeform Photoshop-lasso outline. The
// shape tools share one size (OCR_CIRCLE_MIN..MAX), adjustable via scroll.
const OCR_TOOLS = [
  {
    id: 'highlight',
    label: 'Highlight',
    icon: HighlightToolGlyph,
    hint: 'Click and drag like a highlighter to paint over the text, then release to read it. Scroll to change the brush size.',
  },
  {
    id: 'square',
    label: 'Square',
    icon: SquareToolGlyph,
    hint: 'Click and drag from the top-left corner to define the selection area, then release to read it.',
  },
  {
    id: 'lasso',
    label: 'Custom',
    icon: LassoToolGlyph,
    hint: 'Click and drag to trace a freeform outline around the area, then release to read it.',
  },
];

// Downscale a cropped canvas to a small PNG for the history thumbnail — PNG
// (vs. JPEG) keeps the circular crop's transparent corners so the card's
// background shows through; keeps localStorage entries compact regardless
// of the OCR crop's resolution.
const HISTORY_THUMB_MAX_EDGE = 220;
function canvasToThumbDataUrl(source, maxEdge = HISTORY_THUMB_MAX_EDGE) {
  const { width, height } = source;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale === 1) return source.toDataURL('image/png');
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width * scale));
  c.height = Math.max(1, Math.round(height * scale));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function formatVideoTime(s) {
  if (!s || !isFinite(s)) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// Sidebar-style hover: feed the cursor position into --item-spot-x/y so the
// radial accent gradient brightens at the pointer (same recipe as
// .nav-item:hover in Sidebar.css). Percentages are ratios of two viewport
// values, so no toLayoutPx conversion is needed.
function trackItemSpot(e) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.setProperty('--item-spot-x', `${((e.clientX - r.left) / r.width) * 100}%`);
  el.style.setProperty('--item-spot-y', `${((e.clientY - r.top) / r.height) * 100}%`);
}

// One snippet card in the Extract panel's grid. Own component so each card
// gets its own morph pill (hooks can't live in the render loop): hovering
// shows the cursor-following tooltip, right-click morphs it into a dropdown
// (Find → focus the selection on the media; Delete → morphs again into the
// main-app confirm panel before removing). Clicking the card toggles the
// locate highlight; the text stops propagation so copying by selection
// doesn't toggle it.
function SnipEntryCard({ entry, kind, active, onToggle, onFind, onDelete }) {
  const morph = useMorphPill({
    hoverContent: entry.region
      ? (active ? 'Hide selection' : (kind === 'video' ? 'Jump to this moment & show the selection' : 'Show this selection on the image'))
      : 'Extracted snippet',
    menuItems: [
      entry.region && { label: 'Find', key: 'find', onClick: onFind },
      {
        label: 'Delete',
        key: 'delete',
        danger: true,
        onClick: onDelete,
        confirm: {
          title: 'Delete this snippet?',
          message: 'The extracted text and its selection are removed from this file’s history.',
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
        },
      },
    ],
  });
  return (
    <div
      className={`dv-snip-entry${entry.region ? ' is-locatable' : ''}${active ? ' is-active' : ''}`}
      onMouseMove={(e) => { trackItemSpot(e); morph.handleMouseMove(e); }}
      onMouseLeave={morph.handleMouseLeave}
      onContextMenu={morph.handleContextMenu}
    >
      {/* The THUMBNAIL is the click-to-focus target; the hover/selected
          styling still paints across the whole card. */}
      {entry.region ? (
        <button type="button" className="dv-snip-entry-thumb" onClick={onToggle}>
          <img src={entry.thumb} alt="" draggable={false} />
        </button>
      ) : (
        <div className="dv-snip-entry-thumb">
          <img src={entry.thumb} alt="" draggable={false} />
        </div>
      )}
      <p className={`dv-snip-entry-text${entry.text ? '' : ' is-empty'}`}>
        {entry.text || 'No text found in this selection.'}
      </p>
      {morph.node}
    </div>
  );
}

// "Jun 13" / "14:32" — split so the history timeline rail can stack them.
function formatHistoryTimestamp(ms) {
  const d = new Date(ms);
  return {
    date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }),
  };
}

// Renders a photo or video full-pane with an "Extract text" tool. Arming it
// shows a tool-picker pill (Highlight / Circle / Square / Custom) at the top
// of the stage; the active tool's brush/shape follows the cursor and a
// click-drag paints or draws the selection — release to run OCR (lib/ocr) on
// it. Videos auto-pause when the tool is armed — extraction always reads the
// still frame on screen — and playing again disarms it.
//
// Coordinate spaces: all pointer positions live in viewport px relative to
// the stage (clientX / getBoundingClientRect agree there), converted to
// layout px only when rendered as SVG (the app's root zoom — see
// lib/appZoom). The crop maps each shape to natural-resolution pixels via the
// media element's box, so the zoom cancels out.
const OCR_CIRCLE_MIN = 16;
const OCR_CIRCLE_MAX = 300;
const OCR_CIRCLE_DEFAULT = 60;
const OCR_CIRCLE_STEP = 0.15; // viewport px of brush radius per wheel-delta unit

// Builds an SVG path string ("M x y L x y ... Z") from points in
// stage-viewport px, converting to layout px for rendering.
function pathD(points) {
  return `${points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toLayoutPx(p.x)} ${toLayoutPx(p.y)}`).join(' ')} Z`;
}

// Renders a selection shape's geometry as SVG element(s) in stage-viewport
// px (converted to layout px) — used for the outline preview (with a
// className), inside a <clipPath>, or inside a <mask> (with svgProps={fill:'black'}).
function shapeElements(shape, className, svgProps) {
  switch (shape.kind) {
    case 'circle':
      return <circle {...svgProps} className={className} cx={toLayoutPx(shape.cx)} cy={toLayoutPx(shape.cy)} r={toLayoutPx(shape.r)} />;
    case 'rect': {
      const x = toLayoutPx(Math.min(shape.x1, shape.x2));
      const y = toLayoutPx(Math.min(shape.y1, shape.y2));
      const w = toLayoutPx(Math.abs(shape.x2 - shape.x1));
      const h = toLayoutPx(Math.abs(shape.y2 - shape.y1));
      return <rect {...svgProps} className={className} x={x} y={y} width={w} height={h} />;
    }
    case 'union':
      return shape.points.map((p, i) => (
        <circle key={i} {...svgProps} className={className} cx={toLayoutPx(p.x)} cy={toLayoutPx(p.y)} r={toLayoutPx(shape.r)} />
      ));
    case 'path':
      return <path {...svgProps} className={className} d={pathD(shape.points)} />;
    default:
      return null;
  }
}

// Inverse of runOcr's `toNat`: maps a stored selection region (natural-
// resolution px) back to stage-viewport px for the "locate selection" overlay.
// `toStage` converts a natural-px point to stage px; `scale` is the live
// natural→display ratio (for the highlight brush radius).
function regionToStageShape(region, toStage, scale) {
  if (!region) return null;
  switch (region.kind) {
    case 'rect': {
      const a = toStage({ x: region.x1, y: region.y1 });
      const b = toStage({ x: region.x2, y: region.y2 });
      return { kind: 'rect', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
    case 'union':
      return { kind: 'union', points: region.points.map(toStage), r: region.r * scale };
    case 'path':
      return { kind: 'path', points: region.points.map(toStage) };
    default:
      return null;
  }
}

// Width bounds (layout px) for the resizable "Extracted text" panel.
const HISTORY_MIN_WIDTH = 240;
// Zoom bounds and step for the media viewer.
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.3;
const HISTORY_MAX_WIDTH = 960;
// One default width for the side panel across ALL file types (it's the same
// panel everywhere). Defaults to the max so the panel opens at full width;
// still resizable down to HISTORY_MIN_WIDTH.
const HISTORY_DEFAULT_WIDTH = HISTORY_MAX_WIDTH;

// Persisted doc-viewer column layout (px). Shared across files so resizing the
// chat / media / advisor columns in one WhatsApp conversation is remembered the
// next time any conversation (or document) is opened.
//   chatW    — width of the conversation column (chat ↔ media split)
//   advisorW — width of the side panel (AI advisor / extracted-text)
const DV_LAYOUT_KEY = 'docvex:doc-viewer:layout:v1';
function readDvLayout() {
  try { const v = JSON.parse(localStorage.getItem(DV_LAYOUT_KEY)); if (v && typeof v === 'object') return v; } catch { /* ignore */ }
  return {};
}
function writeDvLayout(patch) {
  try { localStorage.setItem(DV_LAYOUT_KEY, JSON.stringify({ ...readDvLayout(), ...patch })); } catch { /* ignore */ }
}

// Side-panel tab labels. Which tabs a file type shows is decided by
// sideTabsForKind: Text extraction is for images + video, AI captions for
// audio + video, and the AI advisor is available for every file type. All three
// live in ONE tabbed side panel (the "AI advisor" panel) beside the document.
const SIDE_TAB_LABELS = { extract: 'Extract text', captions: 'Captions', advisor: 'Generate', metadata: 'Metadata' };
// The Multitool always shows all three tools; each pane renders a graceful empty
// state for a tool that doesn't apply to its file type. Metadata is last and
// applies to everything — every file has facts to report.
function sideTabsForKind() {
  return ['extract', 'captions', 'advisor', 'metadata'];
}

// Tab bar shared by every file type's side panel. `tabs` is the ordered list of
// tab ids the host wants shown (see sideTabsForKind).
function SidePanelTabs({ tabs = ['extract', 'captions'], active, onChange, slot = null }) {
  const el = (
    <div className="dv-side-tabs">
      {tabs.map((id) => (
        <button
          key={id}
          type="button"
          className={`dv-side-tab${active === id ? ' is-active' : ''}`}
          onClick={() => onChange(id)}
        >
          {SIDE_TAB_LABELS[id]}
        </button>
      ))}
    </div>
  );
  // When a slot is given (the Multitool topbar), render the tabs there instead
  // of inline above the panel content.
  return slot ? createPortal(el, slot) : el;
}
// ── Metadata panel ─────────────────────────────────────────────────────────
// The side panel's "Metadata" tab: one button that reads everything the file
// can tell us about itself — the filesystem's dates/size/permissions, the
// format's own properties (EXIF, the PDF info dictionary, Word/Excel document
// properties, media duration), and a SHA-256 of the bytes. Nothing runs until
// the button is pressed: hashing and decoding cost real time on big files, and
// a tab switch shouldn't spend it.
const MetaGlyph = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h4" />
  </svg>
);

function MetadataPanel({ file }) {
  const [status, setStatus] = useState('idle');   // idle | working | done
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  // A different file in the same panel starts over — metadata is per-file —
  // but a file we've already read comes straight back from the cache, so the
  // button only has to be pressed once per file. Extraction re-reads the whole
  // file (SHA-256 over every byte, a ZIP walk, a pdf.js parse), which is slow
  // enough on a large file to be worth never repeating unnecessarily.
  // A cheap stat() guards it: a file edited since the snapshot was taken
  // invalidates it rather than showing metadata that no longer describes it.
  useEffect(() => {
    let alive = true;
    setStatus('idle');
    setData(null);
    setError(null);
    const path = file.storage_path;
    if (!path) return undefined;
    (async () => {
      let stamp = null;
      try {
        const st = await localFolderApi.stat(path);
        if (st && !st.error) stamp = { size: st.sizeBytes, mtime: st.mtimeIso };
      } catch { /* no stat — fall back to whatever was cached */ }
      const cached = loadMetadata(path, stamp);
      if (!alive || !cached) return;
      setData(cached);
      setStatus('done');
    })();
    return () => { alive = false; };
  }, [file.storage_path]);

  const run = useCallback(async () => {
    setStatus('working');
    setError(null);
    try {
      const result = await extractFileMetadata({
        name: file.name,
        path: file.storage_path,
        mimeType: file.mime_type,
      });
      setData(result);
      setStatus('done');
      // Stamp the snapshot with the file's current size/mtime so the next open
      // can tell whether it still applies.
      let stamp = null;
      try {
        const st = await localFolderApi.stat(file.storage_path);
        if (st && !st.error) stamp = { size: st.sizeBytes, mtime: st.mtimeIso };
      } catch { /* store it unstamped — better cached than not */ }
      saveMetadata(file.storage_path, result, stamp);
    } catch (e) {
      setError(String(e?.message || e));
      setStatus('idle');
    }
  }, [file.name, file.storage_path, file.mime_type]);

  const copyAll = async () => {
    if (!data) return;
    const text = data.groups
      .map((g) => `${g.title}\n${g.rows.map((r) => `  ${r.label}: ${r.value}`).join('\n')}`)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(`${file.name}\n\n${text}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const rowCount = data ? data.groups.reduce((n, g) => n + g.rows.length, 0) : 0;

  return (
    <div className="dv-ocr-history-scroll">
      <header className="dv-ocr-history-head">
        <div className="dv-ocr-history-eyebrow">
          <span>Metadata</span>
          <span className="dv-ocr-history-eyebrow-muted">· from this file</span>
        </div>
        <h2 className="dv-ocr-history-title">File metadata</h2>
        <div className="dv-ocr-history-meta">
          <span className="dv-ocr-history-count">
            {status === 'done'
              ? <><strong>{rowCount}</strong> {rowCount === 1 ? 'property' : 'properties'}</>
              : 'Not extracted yet'}
          </span>
          {status === 'done' && (
            <button type="button" className="dv-ocr-history-clear" onClick={copyAll}>
              {copied ? 'Copied' : 'Copy all'}
            </button>
          )}
        </div>
      </header>

      <div className="dv-meta-actions">
        <button type="button" className="dv-doc-extract-btn" onClick={run} disabled={status === 'working'}>
          {MetaGlyph}
          <span>
            {status === 'working' ? 'Reading file…' : status === 'done' ? 'Re-extract metadata' : 'Extract metadata'}
          </span>
        </button>
      </div>

      {error && <p className="dv-meta-error" role="alert">{error}</p>}

      {status === 'idle' && !error && (
        <p className="dv-ocr-history-empty">
          Reads the file’s dates, size and permissions, whatever properties the format itself
          carries (camera EXIF, PDF and Office document properties, media duration), and a
          SHA-256 fingerprint of the bytes.
        </p>
      )}

      {data && (
        <div className="dv-meta-groups">
          {data.groups.map((g) => (
            <section className="dv-meta-group" key={g.id}>
              <h3 className="dv-meta-group-title">{g.title}</h3>
              <dl className="dv-meta-rows">
                {g.rows.map((r) => (
                  <div className="dv-meta-row" key={`${g.id}:${r.label}`}>
                    <dt>{r.label}</dt>
                    <dd>
                      <span className={`dv-meta-value${String(r.value).length > 40 ? ' is-long' : ''}`}>{String(r.value)}</span>
                      {r.hint && <span className="dv-meta-hint">{r.hint}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {data.warnings?.length > 0 && (
            <section className="dv-meta-group">
              <h3 className="dv-meta-group-title">Couldn’t read</h3>
              <ul className="dv-meta-warnings">
                {data.warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

// Paper-plane send glyph for the advisor composer (mirrors the main app's
// AI-tab composer send button).
const AdvisorSendGlyph = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4z" />
  </svg>
);
// Stop glyph — a filled square, shown in place of send while the AI is thinking.
const AdvisorStopGlyph = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

// Small glyphs for the per-answer Copy / Retry actions (match the main app's).
const AdvCopyGlyph = (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>);
const AdvCheckGlyph = (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>);
const AdvRetryGlyph = (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8" /><path d="M3 3v5h5" /></svg>);
const AdvSparkGlyph = (<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" /></svg>);
const AdvBranchGlyph = (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>);

// ── Chat presentation (copied from the main app's AI advisor so the Generate
//    tab reads identically) ──────────────────────────────────────────────────
// Typewriter — reveals an AI answer character-by-character through Markdown.
function AdvTypewriter({ text, onDone, onTick }) {
  const [n, setN] = useState(0);
  const doneRef = useRef(onDone); const tickRef = useRef(onTick);
  doneRef.current = onDone; tickRef.current = onTick;
  useEffect(() => {
    const total = text.length;
    if (!total) { doneRef.current && doneRef.current(); return undefined; }
    let raf = 0; let start = 0;
    const dur = Math.min(Math.max(total / 90, 0.4), 6) * 1000;
    const step = (ts) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 2);
      setN(Math.floor(eased * total));
      tickRef.current && tickRef.current();
      if (p < 1) raf = requestAnimationFrame(step);
      else { setN(total); doneRef.current && doneRef.current(); }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text]);
  return (
    <div className="aichat-md aichat-typing">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text.slice(0, n)}</ReactMarkdown>
      <span className="aichat-caret" aria-hidden="true" />
    </div>
  );
}

const ADV_THINKING_SETS = {
  write: ['Drafting', 'Composing', 'Choosing the words', 'Polishing'],
  legal: ['Reviewing', 'Checking the clauses', 'Weighing the details', 'Consulting the rules'],
  files: ['Reading the file', 'Scanning the document', 'Gathering context', 'Looking things up'],
  general: ['Thinking', 'Working on it', 'Reasoning', 'Putting it together'],
};
function advPickThinking(text) {
  const t = (text || '').toLowerCase();
  if (/(write|draft|compose|letter|contract|report|essay|rewrite|rephrase|generate|create|presentation|slide|spreadsheet)/.test(t)) return 'write';
  if (/(legal|\blaw\b|clause|statute|regulation|complian|liabilit|court|\bcase\b|tax)/.test(t)) return 'legal';
  if (/(file|document|summar|read|explain|key points)/.test(t)) return 'files';
  return 'general';
}
function AdvThinkingStatus({ query }) {
  const set = useMemo(() => ADV_THINKING_SETS[advPickThinking(query)], [query]);
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(0);
    const id = window.setInterval(() => setI((n) => (n + 1) % set.length), 2000);
    return () => window.clearInterval(id);
  }, [set]);
  return (
    <span className="aichat-thinking" role="status" aria-label="DocVex AI is working">
      <img className="aichat-thinking-gavel" src={gavelLoader} alt="" aria-hidden="true" />
      <span className="aichat-thinking-text" key={i}>{set[i]}</span>
      <span className="aichat-thinking-dots" aria-hidden="true"><span /><span /><span /></span>
    </span>
  );
}

// Pull the structured blocks out of an assistant reply:
//   • <docvex:document kind="…">…</docvex:document> — the FULL document, emitted
//     only when the user asks to create/edit it.
//   • <docvex:questions>… one per line …</docvex:questions> — clarifying
//     questions the model needs answered first (rendered in the document pane).
// A normal answer has neither, so we don't touch the file. Returns
// { chat, document, kind, questions }.
function parseAdvisorReply(text) {
  let rest = String(text || '');
  const linesOf = (block) => block
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
  let questions = null;
  const qm = /<docvex:questions>([\s\S]*?)<\/docvex:questions>/i.exec(rest);
  if (qm) {
    questions = linesOf(qm[1]);
    rest = `${rest.slice(0, qm.index)}${rest.slice(qm.index + qm[0].length)}`;
    if (!questions.length) questions = null;
  }
  let options = null;
  const om = /<docvex:options>([\s\S]*?)<\/docvex:options>/i.exec(rest);
  if (om) {
    options = linesOf(om[1]);
    rest = `${rest.slice(0, om.index)}${rest.slice(om.index + om[0].length)}`;
    if (!options.length) options = null;
  }
  let document = null;
  let kind = null;
  const dm = /<docvex:document(?:\s+kind="?([a-z]+)"?)?\s*>([\s\S]*?)<\/docvex:document>/i.exec(rest);
  if (dm) {
    kind = (dm[1] || '').toLowerCase() || null;
    document = (dm[2] || '').trim();
    rest = `${rest.slice(0, dm.index)}${rest.slice(dm.index + dm[0].length)}`;
  }
  const chat = rest.replace(/\n{3,}/g, '\n\n').trim();
  return { chat, document, kind, questions, options };
}

// The model sometimes writes the WHOLE document as plain chat text, forgetting
// the <docvex:document> wrapper — so no real file gets produced. Detect that
// (a long reply that reads like a document: a shouty title, several markdown
// headings, multiple numbered clauses, or CSV-ish rows) so we can force a
// wrapped retry. A sentence or two of normal conversation never trips this.
function looksLikeUnwrappedDoc(text) {
  const t = String(text || '');
  if (t.length < 400) return false;
  const headings = (t.match(/^#{1,3}\s+\S/gm) || []).length;
  const numbered = (t.match(/^\s*\d+\.\s+\S/gm) || []).length;
  const capsTitle = /^[A-Z][A-Z0-9 ,'&.\-]{8,}$/m.test(t);
  const csvish = (t.match(/^[^\n,]+,[^\n,]+,/gm) || []).length >= 3;
  return headings >= 2 || numbered >= 3 || csvish || (capsTitle && t.length > 600);
}

// Did the model drift back to vanilla-assistant behaviour — refusing to make the
// file, or dumping a plain outline / "paste into PowerPoint" instructions —
// instead of emitting the document block? These are the exact phrasings that
// signal a protocol break, so we force a corrective retry.
const DRIFT_RE = /(can'?t (?:actually )?(?:create|generate|export|produce|make|build|modify|edit)|i'?m (?:unable|not able)|only (?:provide|give you|output)(?: the)? (?:text|content|outline)|paste (?:it |this |the )?(?:above |outline )?into|outline view|copy[- ]?paste|copy each|python(?:-pptx)? script|ready to (?:drop|paste) into|import (?:slides|into) (?:powerpoint|google)|i can only (?:provide|give|produce)|turn the outline)/i;
function looksLikeDrift(t) { return DRIFT_RE.test(String(t || '')); }

// Collapse consecutive same-role string turns into one (keeps the API history
// valid when, e.g., an assistant note and a "saved version" marker land back to
// back). All generate-mode history is plain strings — the document content rides
// in the seed turn + the live write_document tool call, never inline tags.
function mergeStringTurns(seq) {
  const out = [];
  for (const m of seq) {
    const last = out[out.length - 1];
    if (last && last.role === m.role && typeof last.content === 'string' && typeof m.content === 'string') {
      last.content = `${last.content}\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

// Build the API conversation for generate-mode. The document-builder PERSONA +
// protocol now live in the Edge function's system prompt (docTools mode), so this
// only supplies: (1) a seed turn carrying the CURRENT on-disk document (the active
// version) so edits are full rewrites of it, and (2) the visible thread as plain
// strings. The model produces/updates the file through the `write_document` tool,
// not inline tags — so there's nothing to parse and nothing to drift.
function buildGenMessages(displayed, file, versions, activeVersion) {
  // Seed with the version that's actually on disk right now (the user may have
  // re-selected an earlier one), falling back to the most recent.
  const active = versions.find((v) => v.n === activeVersion)
    || (versions.length ? versions[versions.length - 1] : null);
  const seq = [];
  if (active?.text) {
    seq.push({
      role: 'user',
      content:
        `Here is the CURRENT content of the document you are building ("${file?.name || 'document'}"). ` +
        `When I ask for a change, take THIS and save the complete updated version with write_document:\n\n` +
        `<<<CURRENT DOCUMENT>>>\n${active.text}\n<<<END>>>`,
    });
    seq.push({
      role: 'assistant',
      content: 'Understood — I have the current document and will save a complete new version with write_document whenever you ask for a change.',
    });
  }
  for (const m of displayed) {
    if (m.role === 'user' || m.role === 'assistant') {
      seq.push({ role: m.role, content: m.apiText || m.content });
    } else if (m.role === 'artifact') {
      // A past generation: record it as a brief marker. The full text of the
      // CURRENT version is already in the seed turn above, so we don't need to
      // replay every historical version's body.
      seq.push({ role: 'assistant', content: `(Saved Version ${m.version}${m.instructions ? ` — ${String(m.instructions).slice(0, 200)}` : ''}.)` });
    }
  }
  return mergeStringTurns(seq);
}

// Per-file AI advisor state, lifted to the Multitool card so its composer can be
// a SINGLE footer shared across all three tabs (Text extraction / AI captions /
// AI advisor) while the message thread lives in the AI-advisor tab. Provided at
// the DocViewer level: portals keep the React tree intact, so the advisor thread
// (portalled into the Multitool slot) still sees this context. Backed by the
// project-ai Edge Function (askProjectAi); resets when the active file changes.
const MultitoolAdvisorContext = React.createContext(null);
function useMultitoolAdvisor() { return useContext(MultitoolAdvisorContext); }

function MultitoolAdvisorProvider({ file, footSlot = null, generateMode = false, onDocWritten, onRenameFile, children }) {
  const { notify } = useNotifications();
  const [messages, setMessages] = useState([]); // [{ role, content } | { role:'artifact', version, instructions }]
  // Split-conversation branches. Splitting from a message keeps the ORIGINAL
  // thread intact and starts a new branch; nav pills under the header switch
  // between them. branchStoreRef holds every branch's messages; the active
  // branch's also live in `messages` (kept in sync below).
  const [branches, setBranches] = useState([{ id: 'main', label: 'Main' }]);
  const [activeBranchId, setActiveBranchId] = useState('main');
  const branchStoreRef = useRef({ main: [] });
  const branchSeqRef = useRef(0);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // Report AI busy/idle to the main app so its "Open files" sidebar can mark
  // this window's row as "AI working". Flag back to idle when the window unmounts.
  useEffect(() => {
    setDocViewerAiStatus(busy);
    return () => setDocViewerAiStatus(false);
  }, [busy]);
  // Re-selecting / opening a saved version writes it to disk — a quick file op
  // that should NOT show the chat's thinking bubble (it jitters the thread).
  // The preview pane shows a spinner off this flag instead.
  const [switching, setSwitching] = useState(false);
  // Dev-only ask_user preview, driven from the debug tray above the tab bar.
  const [debugAsk, setDebugAsk] = useState(null);
  const [error, setError] = useState(null);
  // Bumped to invalidate an in-flight turn's result when the user hits Stop.
  const turnSeqRef = useRef(0);
  // Every generated iteration of the document — Claude-style: each shows as a
  // version card in the thread and can be re-selected to preview it.
  const [versions, setVersions] = useState([]); // [{ n, text, instructions }]
  const [activeVersion, setActiveVersion] = useState(null);
  const versionCountRef = useRef(0);
  // Clarifying questions the model asked before it can write the document — shown
  // as an interactive Q&A panel over the document pane (not in the chat). Each is
  // { q, a }. Empty when nothing is pending.
  const [questions, setQuestions] = useState([]);
  // Discrete decision choices the model offered — shown as clickable buttons
  // above the composer; clicking one sends it as the user's reply.
  const [options, setOptions] = useState([]);
  // Running input+output token total for this advisor session (shown when the
  // "Show token usage" setting is on).
  const { prefs: appPrefs } = useAppPrefs();
  const [tokens, setTokens] = useState(0);
  const addUsage = useCallback((u) => { if (u) setTokens((t) => t + (u.input_tokens || 0) + (u.output_tokens || 0)); }, []);
  // A pending ask_user tool call in the NON-generate "ask about this file" advisor
  // (genMode keeps its own document-clarification protocol). Null when none.
  // { id, input, assistantContent, base } — `base` is the api messages to resume from.
  const [pendingAsk, setPendingAsk] = useState(null);
  // A passage the user highlighted in the document preview (with the cursor) to
  // point the AI at — "change THIS part". Shown as a chip in the composer and
  // appended to the next message's API text. Null when nothing is targeted.
  const [selection, setSelection] = useState(null); // string | null
  const addSelection = useCallback((text) => {
    const t = String(text || '').trim();
    if (t) setSelection(t);
  }, []);
  const clearSelection = useCallback(() => setSelection(null), []);
  // Which document engine builds the file: 'skills' (Anthropic Agent Skills —
  // high-fidelity, = claude.ai) or 'local' (instant themed local builder).
  // Persisted so the choice sticks across files/sessions.
  const [engine, setEngineState] = useState(() => {
    try { return localStorage.getItem('docvex:doc-engine') === 'local' ? 'local' : 'skills'; }
    catch { return 'skills'; }
  });
  const setEngine = useCallback((e) => {
    const v = e === 'local' ? 'local' : 'skills';
    setEngineState(v);
    try { localStorage.setItem('docvex:doc-engine', v); } catch { /* noop */ }
  }, []);
  // Which Claude model answers in chat AND builds documents. Persisted; coerced
  // to a known id so a stale value can't break the request.
  const [model, setModelState] = useState(() => {
    try { return coerceModel(localStorage.getItem('docvex:ai-model') || DEFAULT_AI_MODEL); }
    catch { return DEFAULT_AI_MODEL; }
  });
  const setModel = useCallback((id) => {
    const v = coerceModel(id);
    setModelState(v);
    try { localStorage.setItem('docvex:ai-model', v); } catch { /* noop */ }
  }, []);

  // In generate-mode this file is the advisor-driven document. A freshly-created
  // file is a "wildcard" (no extension) — we DON'T assume docx; the kind is
  // resolved from what the user describes (inferDocKind) at generation time, and
  // the file is renamed to carry the resulting extension. Once it has a
  // recognised extension, that locks the kind.
  const genMode = !!generateMode;

  // Load any saved thread + versions for this file (persisted per file path), or
  // reset to empty when the active file changes. Keyed on the tab id (NOT the
  // path) so a generate-time rename — which changes the path but keeps the id —
  // doesn't wipe the in-progress thread.
  useEffect(() => {
    setInput(''); setError(null); setBusy(false); setQuestions([]); setOptions([]);
    const saved = file?.path ? loadConversation(file.path) : null;
    const vers = saved?.versions || [];
    // Restore the branch set if present; otherwise wrap the saved/empty thread in
    // a single "Main" branch.
    const savedBranches = Array.isArray(saved?.branches) && saved.branches.length ? saved.branches : null;
    if (savedBranches) {
      const store = {};
      savedBranches.forEach((b) => { store[b.id] = b.messages || []; });
      branchStoreRef.current = store;
      setBranches(savedBranches.map((b) => ({ id: b.id, label: b.label, splits: b.splits || [] })));
      const active = saved.activeBranchId && store[saved.activeBranchId] ? saved.activeBranchId : savedBranches[0].id;
      setActiveBranchId(active);
      setMessages(store[active] || []);
      branchSeqRef.current = savedBranches.filter((b) => b.id !== 'main').length;
    } else {
      const msgs = saved?.messages || [];
      branchStoreRef.current = { main: msgs };
      setBranches([{ id: 'main', label: 'Main' }]);
      setActiveBranchId('main');
      setMessages(msgs);
      branchSeqRef.current = 0;
    }
    setVersions(vers);
    versionCountRef.current = vers.reduce((mx, v) => Math.max(mx, v.n || 0), 0);
    // The last generated iteration is what's currently on disk.
    setActiveVersion(vers.length ? vers[vers.length - 1].n : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  // Keep the active branch's messages mirrored into the store so a branch switch
  // (or persist) always sees the latest thread.
  useEffect(() => { branchStoreRef.current[activeBranchId] = messages; }, [messages, activeBranchId]);

  // Persist the thread + versions + every branch whenever they change so
  // reopening the file restores all split conversations.
  useEffect(() => {
    if (!file?.path) return;
    const branchRecords = branches.map((b) => ({
      id: b.id, label: b.label, splits: b.splits || [],
      messages: b.id === activeBranchId ? messages : (branchStoreRef.current[b.id] || []),
    }));
    saveConversation(file.path, { messages, versions, branches: branchRecords, activeBranchId });
  }, [file?.path, messages, versions, branches, activeBranchId]);

  // Build `text` into `kind`, write it to disk, and reload the preview. If the
  // file's current name doesn't already carry `kind`'s extension (a wildcard, or
  // a kind change), rename it first — preserving the sidecar id — and tell the
  // parent so the tab re-labels. Shared by a fresh generation and re-selecting a
  // past version.
  const writeDoc = useCallback(async (text, kindArg) => {
    const p = String(file?.path || '');
    const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    const dir = cut >= 0 ? p.slice(0, cut) : '';
    const curName = cut >= 0 ? p.slice(cut + 1) : p;
    const kind = kindArg || docKindFromName(curName) || 'docx';
    const targetName = withKindExtension(curName, kind);
    // Build with the selected engine: 'skills' prefers Anthropic's Office Skills
    // (high-fidelity, auto-falls back to the local builder if unavailable),
    // 'local' goes straight to the themed local builder.
    const blob = await buildDocumentBlobSmart(kind, text, { engine, model });
    if (targetName !== curName) {
      // Rename the wildcard/placeholder to its real extension before filling it.
      await localFolderApi.renameFile({ dir, fromName: curName, toName: targetName });
    }
    const wr = await localFolderApi.writeFiles({ dir, files: [{ filename: targetName, blob }] });
    if (wr?.error || !wr?.results?.[0]?.ok) throw new Error(wr?.error || wr?.results?.[0]?.error || 'write_failed');
    notifyFilesChanged();
    // Record the AI write in the activity feed/log (silent — the version card
    // in the thread is the in-window feedback).
    notify({
      category: 'file',
      variant: 'success',
      icon: 'sparkles',
      title: 'Document generated',
      body: `“${targetName}” was written by the AI advisor.`,
      silent: true,
      payload: { activity: { action: 'generate-doc', fileName: targetName, filePath: dir ? `${dir}/${targetName}` : targetName } },
    });
    if (targetName !== curName) {
      // The thread now lives under the NEW path (the save effect re-keys on
      // file.path); drop the stale old-path entry so a future same-named new
      // file (another "Untitled") can't inherit this conversation.
      clearConversation(p);
      onRenameFile?.(targetName, mimeForKind(kind));
    }
    onDocWritten?.();
  }, [file?.path, onDocWritten, onRenameFile, engine, model, notify]);

  // Apply one generate-mode model result: build a new document version
  // (write_document), pause for a clarifying question (ask_user), or just show a
  // plain reply. Shared by runTurn and the ask_user resume so both continue into a
  // saved version identically. `baseMsgs` is what to resume from if it asks.
  const applyGenResult = useCallback(async (res, lastUserText, baseMsgs) => {
    if (res.tool === 'write_document' && res.toolUse?.input) {
      const input = res.toolUse.input;
      // Lock to the file's real extension once it has one; else honour the kind
      // the model chose, falling back to inference from the request + content.
      const lockedKind = docKindFromName(file?.name || '');
      const askedKind = ['docx', 'pptx', 'xlsx', 'pdf'].includes(input.kind) ? input.kind : null;
      const kind = lockedKind || askedKind || inferDocKind(`${lastUserText}\n${input.content || ''}`);
      const note = (res.text && res.text.trim())
        || (input.summary && String(input.summary).trim())
        || (versionCountRef.current ? 'Here’s an updated version.' : 'Here’s your document.');
      setMessages((m) => [...m, { role: 'assistant', content: note, at: Date.now() }]);
      try {
        await writeDoc(String(input.content || ''), kind);
        const n = versionCountRef.current + 1;
        versionCountRef.current = n;
        setVersions((v) => [...v, { n, text: String(input.content || ''), instructions: lastUserText, kind }]);
        setActiveVersion(n);
        setMessages((m) => [...m, { role: 'artifact', version: n, instructions: lastUserText, at: Date.now() }]);
      } catch (e) {
        setError('Couldn’t save the document.');
      }
      return;
    }
    if (res.tool === 'ask_user' && res.askUser) {
      setMessages((m) => [...m, { role: 'assistant', content: res.text || 'A couple of quick questions first.', at: Date.now() }]);
      setPendingAsk({ id: res.askUser.id, input: res.askUser.input, assistantContent: res.assistantContent, base: baseMsgs, gen: true });
      return;
    }
    // A pure conversational answer (a question that doesn't change the document).
    setMessages((m) => [...m, { role: 'assistant', content: res.text || '', at: Date.now() }]);
  }, [file, writeDoc]);

  // One assistant turn. In generate-mode the model drives the file through the
  // `write_document` tool: every create/change request saves a NEW version, and
  // the user can iterate without limit. We pin tool_choice to write_document when
  // the request clearly wants a document, so it can never refuse or drift to prose.
  // `convo` is the visible thread up to and including the latest user message.
  const runTurn = useCallback(async (convo, lastUserText) => {
    const seq = ++turnSeqRef.current;
    const stopped = () => turnSeqRef.current !== seq;
    if (genMode) {
      const baseMsgs = buildGenMessages(convo, file, versions, activeVersion);
      const k = docKindFromName(file?.name || '') || '';
      // No forced documents. The model always has BOTH tools (write_document +
      // ask_user) and decides for itself: write a new version when I clearly want
      // to create/change the file, answer in text when I'm only asking about it,
      // and — crucially — when it can't tell whether I want a new version (or the
      // info to build one is missing), ask_user FIRST instead of guessing. A steer
      // note on the latest turn makes that policy explicit.
      const steer = '[Meta: You have two tools — write_document (save a new version of this file) and ask_user (ask me questions in a modal). Choose based on what I want: if I clearly want to create or change the document, use write_document; if I am only asking about it or chatting, just answer; if I ask you to question me / gather details / fill in placeholders, OR if you are UNSURE whether I want a new version or are missing information to write one, call ask_user first. Never silently write a version when you are unsure.]';
      const askMsgs = baseMsgs.map((m, i) => (
        i === baseMsgs.length - 1 && m.role === 'user' && typeof m.content === 'string'
          ? { ...m, content: `${m.content}\n\n${steer}` }
          : m
      ));
      const res = await askProjectAi({ messages: askMsgs, fileNames: [], model, docTools: true, docKind: k || undefined });
      if (res.error) {
        setError(res.error.message === 'ai_not_configured' ? 'The AI isn’t configured to generate documents.' : 'Couldn’t reach the AI right now.');
        return;
      }
      addUsage(res.usage);
      if (stopped()) return;
      // Resume from exactly what the model saw (askMsgs carries the steer note) so
      // an ask_user follow-up replays coherently.
      await applyGenResult(res, lastUserText, askMsgs);
      return;
    }
    // Non-generate "ask about this file" mode — prepend a Claude-like persona so
    // it's warm, direct and doesn't pile on disclaimers/refusals.
    const persona = 'You are DocVex AI — behave like Claude on the web: a capable, friendly, direct assistant. Just help with what is asked. Do not add unnecessary disclaimers, hedges, or "consult a professional" boilerplate, and do not refuse reasonable requests.';
    const apiMsgs = [
      { role: 'user', content: persona },
      { role: 'assistant', content: 'Understood — I’ll be direct and genuinely helpful.' },
      ...convo.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.apiText || m.content })),
    ];
    const res = await askProjectAi({ messages: apiMsgs, fileNames: [file?.name], model });
    if (stopped()) return;
    if (res.error) { setError('The AI advisor is unavailable right now.'); return; }
    addUsage(res.usage);
    // The model asked an interactive question via the ask_user tool — surface it
    // above the composer and pause until the user answers.
    if (res.stopReason === 'tool_use' && res.askUser) {
      setMessages((m) => [...m, { role: 'assistant', content: res.text || 'I have a quick question.', at: Date.now() }]);
      setPendingAsk({ id: res.askUser.id, input: res.askUser.input, assistantContent: res.assistantContent, base: apiMsgs });
      return;
    }
    setMessages((m) => [...m, { role: 'assistant', content: res.text, at: Date.now() }]);
  }, [genMode, file, versions, activeVersion, model, addUsage, applyGenResult]);

  // Stop the in-flight turn: invalidate its result (so nothing lands in the
  // thread when the request returns) and drop the thinking state immediately.
  const stop = useCallback(() => {
    turnSeqRef.current += 1;
    setBusy(false);
  }, []);

  // Resolve a pending ask_user question. The non-generate advisor just continues
  // the conversation; in generate mode (pa.gen) the answers feed back with the doc
  // tool available and the model decides whether to write a version or just reply.
  const resolveAsk = useCallback(async (opts = {}) => {
    if (!pendingAsk || busy) return;
    const questions = pendingAsk.input?.questions || [];
    const answers = opts.dismissed
      ? makeAskAnswers([], {}, { dismissed: true })
      : opts.typedText != null
        ? { answers: questions.map((qq) => ({ question_id: qq.id, response_type: 'free_text', text: opts.typedText })) }
        : makeAskAnswers(questions, opts.perQuestion || {});
    setMessages((m) => [...m, { role: 'user', content: opts.dismissed ? 'Skipped.' : (opts.typedText || 'Answered.'), at: Date.now() }]);
    const pa = pendingAsk;
    setPendingAsk(null);
    setBusy(true); setError(null);
    const apiMsgs = [
      ...pa.base,
      { role: 'assistant', content: pa.assistantContent || [{ type: 'tool_use', id: pa.id, name: 'ask_user', input: pa.input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: pa.id, content: JSON.stringify(answers) }] },
    ];
    if (pa.gen) {
      // Generate mode: continue with the doc tool available and let the user's
      // answer drive it — the model writes a new version if the answer calls for
      // it, or simply replies if it doesn't. (No forcing.)
      const k = docKindFromName(file?.name || '') || '';
      const res = await askProjectAi({ messages: apiMsgs, fileNames: [], model, docTools: true, docKind: k || undefined });
      setBusy(false);
      if (res.error) { setError('Couldn’t reach the AI right now.'); return; }
      addUsage(res.usage);
      await applyGenResult(res, opts.typedText || pa.input?.questions?.[0]?.prompt || 'the answers above', apiMsgs);
      return;
    }
    const res = await askProjectAi({ messages: apiMsgs, fileNames: [file?.name], model });
    setBusy(false);
    if (res.error) { setError('The AI advisor is unavailable right now.'); return; }
    addUsage(res.usage);
    if (res.stopReason === 'tool_use' && res.askUser) {
      setMessages((m) => [...m, { role: 'assistant', content: res.text || 'I have a quick question.', at: Date.now() }]);
      setPendingAsk({ id: res.askUser.id, input: res.askUser.input, assistantContent: res.assistantContent, base: apiMsgs });
      return;
    }
    setMessages((m) => [...m, { role: 'assistant', content: res.text, at: Date.now() }]);
  }, [pendingAsk, busy, file, model, addUsage, applyGenResult]);

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || busy) return;
    // While a question is pending, a typed message answers it (free-text).
    if (pendingAsk) { setInput(''); resolveAsk({ typedText: q }); return; }
    // If the user pointed at a passage in the document, append it to the API text
    // (not the visible bubble) so the model knows exactly which part to change.
    const apiText = selection
      ? `${q}\n\nThe user selected this exact passage from the document and wants the request applied to it. Change only what's needed here; leave the rest of the document unchanged unless asked otherwise:\n"""\n${selection}\n"""`
      : undefined;
    const userMsg = { role: 'user', content: q, ...(apiText ? { apiText } : {}), at: Date.now() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setSelection(null);
    setBusy(true);
    setError(null);
    setOptions([]);
    await runTurn(next, q);
    setBusy(false);
  }, [input, busy, messages, runTurn, pendingAsk, resolveAsk, selection]);

  // Click a decision button: send that choice as the user's reply.
  const chooseOption = useCallback(async (optionText) => {
    if (busy || !optionText) return;
    setOptions([]);
    const next = [...messages, { role: 'user', content: optionText, at: Date.now() }];
    setMessages(next);
    setBusy(true); setError(null);
    await runTurn(next, optionText);
    setBusy(false);
  }, [busy, messages, runTurn]);

  // Retry an assistant answer: drop it (and anything after) and re-run the turn
  // from the conversation up to that point — matches the main app's Retry.
  const regenerate = useCallback(async (index) => {
    if (busy) return;
    const convo = messages.slice(0, index);
    const lastUser = [...convo].reverse().find((m) => m.role === 'user');
    setMessages(convo);
    setBusy(true); setError(null);
    await runTurn(convo, lastUser?.content || '');
    setBusy(false);
  }, [busy, messages, runTurn]);

  // Branch a new conversation from a given message: keep the history up to (and
  // including) that message and drop everything after, so the thread continues
  // in a new direction from that point. Clears any pending question/options.
  const branchFrom = useCallback((index) => {
    if (busy) return;
    setOptions([]);
    setPendingAsk(null);
    // Snapshot the current (original) branch so it stays navigable via its pill,
    // then start a NEW branch with the thread sliced up to `index`.
    branchStoreRef.current[activeBranchId] = messages;
    const sliced = messages.slice(0, index + 1);
    const n = (branchSeqRef.current += 1);
    const newId = `b${n}`;
    const label = `Split ${n}`;
    branchStoreRef.current[newId] = sliced;
    setBranches((bs) => [
      // Record the split on the PARENT branch so a marker shows at that point.
      ...bs.map((b) => (b.id === activeBranchId
        ? { ...b, splits: [...(b.splits || []), { afterIndex: index, branchId: newId, label }] }
        : b)),
      { id: newId, label },
    ]);
    setActiveBranchId(newId);
    setMessages(sliced);
  }, [busy, messages, activeBranchId]);

  // Switch the visible thread to another branch (nav pills). Saves the current
  // branch first so nothing is lost.
  const switchBranch = useCallback((id) => {
    if (busy || id === activeBranchId) return;
    branchStoreRef.current[activeBranchId] = messages;
    setOptions([]);
    setPendingAsk(null);
    setActiveBranchId(id);
    setMessages(branchStoreRef.current[id] || []);
  }, [busy, activeBranchId, messages]);

  // Re-select a past iteration: rewrite the file to that version's text + kind
  // (which may re-extension the file) and reload.
  const selectVersion = useCallback(async (n) => {
    if (busy || switching) return;
    const v = versions.find((x) => x.n === n);
    if (!v) return;
    setSwitching(true); setError(null);
    try { await writeDoc(v.text, v.kind || docKindFromName(file?.name || '')); setActiveVersion(n); }
    catch (e) { setError('Couldn’t load that version.'); }
    setSwitching(false);
  }, [busy, switching, versions, writeDoc, file?.name]);

  // Make a version the on-disk file, then open it in its designated OS app
  // (Word / PowerPoint / Excel / the default PDF viewer).
  const openVersion = useCallback(async (n) => {
    if (busy || switching) return;
    const v = versions.find((x) => x.n === n);
    if (!v) return;
    setSwitching(true); setError(null);
    try {
      const kind = v.kind || docKindFromName(file?.name || '') || 'docx';
      await writeDoc(v.text, kind);
      setActiveVersion(n);
      // Resolve the on-disk path (writeDoc may have renamed to the real extension).
      const p = String(file?.path || '');
      const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
      const dir = cut >= 0 ? p.slice(0, cut) : '';
      const curName = cut >= 0 ? p.slice(cut + 1) : p;
      const targetName = withKindExtension(curName, kind);
      const sep = p.includes('\\') ? '\\' : '/';
      await localFolderApi.openPath(dir ? `${dir}${sep}${targetName}` : targetName);
    } catch (e) { setError('Couldn’t open that version.'); }
    setSwitching(false);
  }, [busy, switching, versions, writeDoc, file?.path, file?.name]);

  // Answer the pending clarifying questions: clear the panel, record the Q&A as a
  // turn (compact bubble; full detail goes to the model), and continue.
  const submitQuestions = useCallback(async (answered) => {
    if (busy) return;
    const rows = (answered || []).filter((x) => x?.q);
    setQuestions([]);
    const detail = rows.map((x) => `- ${x.q}\n  ${x.a?.trim() ? x.a.trim() : '(no preference — use your best judgement)'}`).join('\n');
    const summary = `Here are my answers:\n${detail}\n\nGo ahead and create the document.`;
    const answeredCount = rows.filter((x) => x.a?.trim()).length;
    const userMsg = { role: 'user', content: `Answered ${answeredCount}/${rows.length} question${rows.length === 1 ? '' : 's'}.`, apiText: summary, at: Date.now() };
    const next = [...messages, userMsg];
    setMessages(next);
    setBusy(true); setError(null);
    await runTurn(next, summary);
    setBusy(false);
  }, [busy, messages, runTurn]);

  // Dismiss the questions and let the model proceed with sensible defaults.
  const skipQuestions = useCallback(async () => {
    if (busy) return;
    setQuestions([]);
    const summary = 'Go ahead with sensible defaults — no extra details to add.';
    const next = [...messages, { role: 'user', content: 'Use sensible defaults.', apiText: summary, at: Date.now() }];
    setMessages(next);
    setBusy(true); setError(null);
    await runTurn(next, summary);
    setBusy(false);
  }, [busy, messages, runTurn]);

  const value = useMemo(
    () => ({ messages, input, setInput, busy, switching, error, setError, send, stop, regenerate, branchFrom, branches, activeBranchId, switchBranch, fileName: file?.name, footSlot, genMode, versions, activeVersion, selectVersion, openVersion, questions, submitQuestions, skipQuestions, options, chooseOption, engine, setEngine, model, setModel, tokens, showTokenUsage: appPrefs.showTokenUsage, pendingAsk, resolveAsk, debugAsk, setDebugAsk, selection, addSelection, clearSelection }),
    [messages, input, busy, switching, error, send, stop, regenerate, branchFrom, branches, activeBranchId, switchBranch, file?.name, footSlot, genMode, versions, activeVersion, selectVersion, openVersion, questions, submitQuestions, skipQuestions, options, chooseOption, engine, setEngine, model, setModel, tokens, appPrefs.showTokenUsage, pendingAsk, resolveAsk, debugAsk, selection, addSelection, clearSelection],
  );
  return <MultitoolAdvisorContext.Provider value={value}>{children}</MultitoolAdvisorContext.Provider>;
}

// Portal helper: render a tab's footer action into the single shared Multitool
// footer slot. No-op until the slot exists. Used by each active tab's panel so
// the footer always shows the action relevant to the current tab.
function MultitoolFooter({ children }) {
  const adv = useMultitoolAdvisor();
  if (!adv?.footSlot) return null;
  return createPortal(children, adv.footSlot);
}

// Model picker — a compact popover in the composer toolbar. Lets the user pick
// which Claude model answers in chat AND builds documents, with a one-line
// "best for" note per model so the choice is informed. Applies to every tab.
function ModelPicker() {
  const adv = useMultitoolAdvisor();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  if (!adv?.setModel) return null;
  const current = AI_MODELS.find((m) => m.id === adv.model) || AI_MODELS[0];
  return (
    <div className="dv-model-picker" ref={ref}>
      <Tooltip content="Choose the AI model">
        <button
          type="button"
          className="dv-model-trigger"
          onClick={() => setOpen((o) => !o)}
          disabled={adv.busy}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className="dv-model-trigger-dot" aria-hidden="true" />
          <span className="dv-model-trigger-label">{current.label}</span>
          <svg className="dv-model-trigger-chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      </Tooltip>
      {open && (
        <div className="dv-model-menu" role="listbox" aria-label="AI model">
          <div className="dv-model-menu-head">Model</div>
          {AI_MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={m.id === adv.model}
              className={`dv-model-opt${m.id === adv.model ? ' is-active' : ''}`}
              onClick={() => { adv.setModel(m.id); setOpen(false); }}
            >
              <span className="dv-model-opt-top">
                <span className="dv-model-opt-name">{m.label}</span>
                <span className="dv-model-opt-tag">{m.tagline}</span>
                {m.id === adv.model && (
                  <svg className="dv-model-opt-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true"><path d="M5 13l4 4L19 7" /></svg>
                )}
              </span>
              <span className="dv-model-opt-best">{m.best}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Shared Multitool footer — the advisor composer, rendered once at the card
// level so it's the SAME footer under every tab. Drives the lifted advisor
// state; the reply shows in the AI-advisor tab's thread.
// Dev-only sample ask_user payloads — preview how each response_type renders in
// the shared AskUserPanel (the same UI the model drives via the ask_user tool),
// without waiting for the model to actually call it.
const DEBUG_ASKS = {
  choice: [{
    id: 'fmt', prompt: 'Which format should the summary take?', response_type: 'single_select',
    options: [
      { id: 'bullets', label: 'Bullet points', description: 'Short, scannable lines' },
      { id: 'prose', label: 'Narrative', description: 'Flowing paragraphs' },
      { id: 'table', label: 'Comparison table' },
    ],
  }],
  multi: [{
    id: 'secs', prompt: 'Which sections should I include?', response_type: 'multi_select',
    options: [
      { id: 'intro', label: 'Introduction' },
      { id: 'risk', label: 'Risk analysis', description: 'Flags + likelihood' },
      { id: 'timeline', label: 'Timeline' },
      { id: 'budget', label: 'Budget' },
    ],
  }],
  confirm: [{
    id: 'ovr', prompt: 'This replaces the current version. Proceed?', response_type: 'confirm',
    options: [{ id: 'yes', label: 'Overwrite' }, { id: 'no', label: 'Keep current' }],
  }],
  prompt: [{ id: 'title', prompt: 'What should the document be titled?', response_type: 'free_text' }],
  multiQ: [
    { id: 'tone', prompt: 'What tone should it strike?', response_type: 'single_select', options: [{ id: 'formal', label: 'Formal' }, { id: 'plain', label: 'Plain English' }] },
    { id: 'len', prompt: 'Roughly how long?', response_type: 'free_text' },
  ],
};

// Dev-only ask_user preview tray — rendered as its own section ABOVE the side
// panel's tab bar (Extract text / Captions / Generate). Drives the shared
// `debugAsk` state in context; the preview panel itself renders in the composer.
function MultitoolDebugTray() {
  const adv = useMultitoolAdvisor();
  if (!import.meta.env.DEV || !adv) return null;
  const { debugAsk, setDebugAsk } = adv;
  return (
    <div className="dv-ask-debug-section">
      <div className="dv-ask-debug" role="group" aria-label="Preview ask_user rendering">
        <span className="dv-ask-debug-label">ask_user preview</span>
        <button type="button" onClick={() => setDebugAsk(DEBUG_ASKS.choice)}>Choice</button>
        <button type="button" onClick={() => setDebugAsk(DEBUG_ASKS.multi)}>Multi-select</button>
        <button type="button" onClick={() => setDebugAsk(DEBUG_ASKS.confirm)}>Confirm</button>
        <button type="button" onClick={() => setDebugAsk(DEBUG_ASKS.prompt)}>Prompt</button>
        <button type="button" onClick={() => setDebugAsk(DEBUG_ASKS.multiQ)}>2 questions</button>
        {debugAsk && <button type="button" className="dv-ask-debug-clear" onClick={() => setDebugAsk(null)}>Clear</button>}
      </div>
    </div>
  );
}

function MultitoolComposer() {
  const adv = useMultitoolAdvisor();
  const [askSlot, setAskSlot] = useState(null);
  // Keep the panel mounted briefly after it's dismissed so the exit animation
  // (collapse + fade) can play before it unmounts.
  const advQuestions = adv?.questions || [];
  const wantPanels = !!(adv && (adv.debugAsk || adv.pendingAsk
    || (adv.genMode && advQuestions.length > 0) || (adv.options?.length > 0)));
  const [panelMounted, setPanelMounted] = useState(wantPanels);
  const [panelExiting, setPanelExiting] = useState(false);
  const lastPanelsRef = useRef(null);
  useEffect(() => {
    if (wantPanels) { setPanelMounted(true); setPanelExiting(false); return undefined; }
    if (!panelMounted) return undefined;
    setPanelExiting(true);
    const t = window.setTimeout(() => { setPanelMounted(false); setPanelExiting(false); }, 480);
    return () => window.clearTimeout(t);
  }, [wantPanels, panelMounted]);
  if (!adv) return null;
  const {
    input, setInput, busy, send, stop, genMode, options = [], chooseOption, engine = 'skills', setEngine,
    questions = [], submitQuestions, skipQuestions, pendingAsk, resolveAsk, debugAsk, setDebugAsk,
  } = adv;
  // genMode clarifying questions, shaped for the shared AskUserPanel (free-text).
  const genQuestions = questions.map((p, i) => ({ id: String(i), prompt: p.q, response_type: 'free_text' }));
  // While an ask_user is active (or exiting) the composer becomes its answer
  // surface: the model picker / token pill / engine toggle hide and the send
  // button is replaced by the panel's Submit/Skip (portalled via askSlot).
  const activeAskQs = debugAsk || pendingAsk?.input?.questions || (genMode && genQuestions.length ? genQuestions : null);
  const asking = panelMounted;
  // The live panels content (captured so the exit animation can keep showing it
  // after the underlying ask state clears).
  const panelsInner = wantPanels ? (
    <>
            {debugAsk && (
              <AskUserPanel
                questions={debugAsk}
                actionsSlot={askSlot}
                onSubmit={(perQuestion) => { try { console.log('[ask_user preview] answers:', perQuestion); } catch { /* noop */ } setDebugAsk(null); }}
                onDismiss={() => setDebugAsk(null)}
              />
            )}
            {/* Interactive ask_user panel (non-generate advisor). */}
            {pendingAsk && (
              <AskUserPanel
                questions={pendingAsk.input?.questions || []}
                actionsSlot={askSlot}
                onSubmit={(perQuestion) => resolveAsk?.({ perQuestion })}
                onDismiss={() => resolveAsk?.({ dismissed: true })}
              />
            )}
            {/* generate-mode clarifying questions. */}
            {genMode && genQuestions.length > 0 && (
              <AskUserPanel
                questions={genQuestions}
                actionsSlot={askSlot}
                onSubmit={(perQuestion) => submitQuestions?.(questions.map((p, i) => ({ q: p.q, a: perQuestion[String(i)] || '' })))}
                onDismiss={() => skipQuestions?.()}
              />
            )}
            {/* Decision buttons offered by the AI — clicking one sends it as the reply. */}
            {options.length > 0 && (
              <div className="dv-advisor-options" role="group" aria-label="Choose an option">
                {options.map((opt, i) => (
                  <button
                    key={i}
                    type="button"
                    className="dv-advisor-option"
                    onClick={() => chooseOption?.(opt)}
                    disabled={busy}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
    </>
  ) : null;
  if (panelsInner) lastPanelsRef.current = panelsInner;

  return (
    <div className="dv-advisor-compose">
      {/* ask_user / clarifying questions / decision options — their OWN section
          above the composer, kept mounted through the exit animation. */}
      {panelMounted && (
        <div className={`dv-advisor-inpanels${panelExiting ? ' is-exiting' : ''}`}>
          {wantPanels ? panelsInner : lastPanelsRef.current}
        </div>
      )}
      {/* Frosted composer card (.dvx-composer style): textarea + send button. */}
      <div
        className="dv-advisor-composer"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          // Layout-space vars (see the advisor-card handler) — divide by zoom.
          e.currentTarget.style.setProperty('--spot-x', `${toLayoutPx(e.clientX - r.left)}px`);
          e.currentTarget.style.setProperty('--spot-y', `${toLayoutPx(e.clientY - r.top)}px`);
        }}
      >
        {/* Targeted passage chip — the section the user highlighted in the doc
            preview. The next message is applied to THIS part. */}
        {adv.selection && (
          <Tooltip content={adv.selection}>
          <div className="dv-advisor-selchip">
            <span className="dv-advisor-selchip-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7h11M4 12h16M4 17h9" />
              </svg>
            </span>
            <span className="dv-advisor-selchip-label">Editing selection</span>
            <span className="dv-advisor-selchip-text">“{adv.selection}”</span>
            <button
              type="button"
              className="dv-advisor-selchip-x"
              onClick={() => adv.clearSelection?.()}
              aria-label="Clear selected section"
            >
              {ClearGlyph}
            </button>
          </div>
          </Tooltip>
        )}
        <textarea
          className="dv-advisor-composer-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={genMode ? 'Message DocVex AI…' : 'Ask about this file…'}
          rows={1}
        />
        <div className="dv-advisor-composer-toolbar">
          {/* The model picker / token pill / engine toggle are hidden while an
              ask_user is active (the composer is the answer surface then). */}
          {!asking && (
            <>
              {/* Model picker — applies to chat answers AND document generation. */}
              <ModelPicker />
              {adv.showTokenUsage && <TokenUsagePill tokens={adv.tokens || 0} />}
              {/* Engine toggle (generate mode only): pick which builder makes the
                  file. "Designer" = Anthropic Agent Skills (high-fidelity, = claude.ai,
                  slower); "Instant" = themed local builder (offline, immediate). */}
              {genMode && setEngine && (
                <Tooltip content="Designer: high-fidelity styling via Claude (slower). Instant: themed local builder (immediate).">
                <div
                  className="dv-engine-toggle"
                  role="radiogroup"
                  aria-label="Document engine"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={engine === 'skills'}
                    className={`dv-engine-opt${engine === 'skills' ? ' is-active' : ''}`}
                    onClick={() => setEngine('skills')}
                    disabled={busy}
                  >
                    Designer
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={engine === 'local'}
                    className={`dv-engine-opt${engine === 'local' ? ' is-active' : ''}`}
                    onClick={() => setEngine('local')}
                    disabled={busy}
                  >
                    Instant
                  </button>
                </div>
                </Tooltip>
              )}
            </>
          )}
          <div className="dv-advisor-composer-spacer" />
          {asking ? (
            // The active ask panel portals its Submit/Skip into this slot.
            <div className="dv-advisor-ask-actions" ref={setAskSlot} />
          ) : busy ? (
            // While the AI is thinking, the send button becomes a Stop button.
            <Tooltip content="Stop">
              <button
                type="button"
                className="dv-advisor-composer-stop"
                onClick={() => stop?.()}
                aria-label="Stop"
              >
                {AdvisorStopGlyph}
              </button>
            </Tooltip>
          ) : (
            <button
              type="button"
              className="dv-advisor-composer-send"
              onClick={send}
              disabled={!input.trim()}
              aria-label="Send"
            >
              {AdvisorSendGlyph}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Claude-artifacts-style version card — one per generated iteration. Clicking
// it rewrites the file to that version and refreshes the preview on the right.
const OpenInAppGlyph = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h6v6" /><path d="M20 4l-9 9" />
    <path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
  </svg>
);

// Software a given extension opens in, for the right-click "Open in …" label.
const SOFTWARE_FOR_EXT = { docx: 'Word', doc: 'Word', pptx: 'PowerPoint', ppt: 'PowerPoint', xlsx: 'Excel', xls: 'Excel', pdf: 'PDF viewer' };

function DocVersionCard({ fileName, version, instructions, active, onSelect, onOpenInApp, disabled }) {
  const ext = ((/\.([a-z0-9]+)$/i.exec(fileName || '') || [])[1] || '').toLowerCase();
  const format = ext ? ext.toUpperCase() : 'FILE';
  const software = SOFTWARE_FOR_EXT[ext] || 'default app';
  const [iconKind, iconGlyph] = VERSION_ICON[ext] || ['', DocCardGlyph];
  const [menu, setMenu] = useState(null); // { x, y } | null while right-click menu is open

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onKey = (e) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  return (
    <>
      <Tooltip content={instructions || (active ? 'Showing this version' : 'Preview this version')}>
        <button
          type="button"
          className={`dv-doc-version${active ? ' is-active' : ''}`}
          onClick={onSelect}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ x: toLayoutPx(e.clientX), y: toLayoutPx(e.clientY) }); }}
          disabled={disabled}
        >
          <span className={`dv-doc-version-icon${iconKind ? ` is-${iconKind}` : ''}`}>{iconGlyph}</span>
          <span className="dv-doc-version-body">
            <span className="dv-doc-version-name">Version {version}</span>
            <span className="dv-doc-version-format">{format}</span>
            <span className="dv-doc-version-hint">
              {active ? 'Current final version' : 'Click to set as the final version'}
            </span>
          </span>
          {active && <span className="dv-doc-version-dot" aria-hidden="true" />}
        </button>
      </Tooltip>
      {menu && createPortal(
        <div
          className="dv-ver-menu"
          role="menu"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="dv-ver-menu-item"
            role="menuitem"
            onClick={() => { setMenu(null); onOpenInApp?.(); }}
            disabled={disabled}
          >
            {OpenInAppGlyph}
            <span>Open in {software}</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

// Clarifying-questions panel — when the advisor needs more detail before writing
// the document, the questions surface HERE (over the document pane, where the
// file will render) as an interactive Q&A form, styled like a Claude artifact.
// Answers feed back into the conversation; the model then drafts the document.
function DocQuestionsPanel() {
  const adv = useMultitoolAdvisor();
  const pending = adv?.questions || [];
  const busy = adv?.busy || false;
  const [answers, setAnswers] = useState([]);
  // Re-seed local answers whenever a fresh set of questions arrives.
  useEffect(() => { setAnswers((adv?.questions || []).map((p) => p.a || '')); }, [adv?.questions]);

  if (!adv?.genMode || !pending.length) return null;

  const setA = (i, v) => setAnswers((a) => a.map((x, k) => (k === i ? v : x)));
  const submit = () => {
    if (busy) return;
    adv.submitQuestions(pending.map((p, i) => ({ q: p.q, a: answers[i] || '' })));
  };

  return (
    <div className="dv-doc-qa-overlay">
      <div className="dv-doc-qa" role="form" aria-label="Questions about this document">
        <header className="dv-doc-qa-head">
          <span className="dv-doc-qa-eyebrow">{AdvSparkGlyph}<span>A few details</span></span>
          <h2 className="dv-doc-qa-title">Answer these and I’ll draft it</h2>
          <p className="dv-doc-qa-sub">Leave anything blank to let the AI decide.</p>
        </header>
        <div className="dv-doc-qa-list">
          {pending.map((p, i) => (
            <label className="dv-doc-qa-item" key={i}>
              <span className="dv-doc-qa-num">{i + 1}</span>
              <span className="dv-doc-qa-body">
                <span className="dv-doc-qa-q">{p.q}</span>
                <textarea
                  className="dv-doc-qa-input"
                  rows={1}
                  value={answers[i] || ''}
                  onChange={(e) => { setA(i, e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
                  placeholder="Your answer…"
                  disabled={busy}
                />
              </span>
            </label>
          ))}
        </div>
        <div className="dv-doc-qa-actions">
          <button type="button" className="dv-doc-qa-skip" onClick={() => adv.skipQuestions?.()} disabled={busy}>Skip</button>
          <button type="button" className="dv-doc-qa-submit" onClick={submit} disabled={busy}>
            {busy ? 'Working…' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Scroll position remembered per file path ACROSS AdvisorPanel remounts.
// Selecting a version writes the doc → bumps regenTick → remounts DocPane (and
// this panel), which would otherwise reset the scroll and jump to the bottom.
// Persisting here lets the panel restore exactly where the user was.
const advisorScrollPos = new Map(); // filePath -> { top, atBottom }

// Per-file AI advisor thread — the AI-advisor tab's content. The composer now
// lives in the shared Multitool footer (MultitoolComposer); this just renders
// the conversation, reading the lifted advisor state from context.
function AdvisorPanel({ file }) {
  const adv = useMultitoolAdvisor();
  const messages = adv?.messages || [];
  const busy = adv?.busy || false;
  const switching = adv?.switching || false;
  const error = adv?.error || null;
  const genMode = adv?.genMode || false;
  const branches = adv?.branches || [];
  const activeBranchId = adv?.activeBranchId;
  const activeSplits = branches.find((b) => b.id === activeBranchId)?.splits || [];
  // The model is waiting on an interactive answer — blur the thread behind the
  // ask_user panel so focus lands on the question.
  const asking = !!adv?.pendingAsk || (genMode && (adv?.questions?.length > 0));
  const scrollRef = useRef(null);
  // Seed stick-to-bottom from the remembered state for this file so a remount
  // (e.g. from selecting a version) doesn't reset it to "stuck" and jump down.
  const stickRef = useRef(advisorScrollPos.get(file?.path)?.atBottom ?? true);
  // Custom scrollbar — the native one is hidden; this thumb is rendered in the
  // gutter to the right of the chat section and synced to the scroll metrics.
  const sbTrackRef = useRef(null);
  const sbThumbRef = useRef(null);
  const syncScrollbar = useCallback(() => {
    const el = scrollRef.current, track = sbTrackRef.current, thumb = sbThumbRef.current;
    if (!el || !track || !thumb) return;
    const { scrollHeight, clientHeight, scrollTop } = el;
    const trackH = track.clientHeight;
    if (scrollHeight <= clientHeight + 1 || trackH <= 0) { track.style.opacity = '0'; return; }
    track.style.opacity = '';
    const thumbH = Math.max(28, (clientHeight / scrollHeight) * trackH);
    const maxTop = trackH - thumbH;
    const top = maxTop * (scrollTop / (scrollHeight - clientHeight));
    thumb.style.height = `${thumbH}px`;
    thumb.style.transform = `translateY(${top}px)`;
  }, []);
  // Keep the thumb in sync as the thread grows (content reflow / typewriter) or
  // the pane resizes — observe both the viewport and the growing chat content.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    syncScrollbar();
    const ro = new ResizeObserver(syncScrollbar);
    ro.observe(el);
    const content = el.querySelector('.dv-advisor-chat');
    if (content) ro.observe(content);
    return () => ro.disconnect();
  }, [syncScrollbar, messages.length, busy]);
  const onThumbDown = useCallback((e) => {
    e.preventDefault();
    const el = scrollRef.current, track = sbTrackRef.current, thumb = sbThumbRef.current;
    if (!el || !track || !thumb) return;
    const startY = e.clientY;
    const startScroll = el.scrollTop;
    const maxTop = track.clientHeight - thumb.clientHeight;
    const scrollable = el.scrollHeight - el.clientHeight;
    document.body.classList.add('dv-advisor-sb-dragging');
    const onMove = (ev) => {
      if (maxTop <= 0) return;
      el.scrollTop = startScroll + (toLayoutPx(ev.clientY - startY) / maxTop) * scrollable;
    };
    const onUp = () => {
      document.body.classList.remove('dv-advisor-sb-dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);
  // The full masthead scrolls with the thread; a compact header fades in once it
  // scrolls out of view (mirrors the Versions page compact-header-on-scroll).
  const [scrolled, setScrolled] = useState(false);
  const prevLenRef = useRef(messages.length);
  const [typing, setTyping] = useState(null);   // index of the AI msg being revealed
  const [copiedIdx, setCopiedIdx] = useState(null);

  // The "Split from here" pill is rendered OUTSIDE the scroll (portalled to
  // <body>) so it can overflow past the sidebar's right edge into the gutter —
  // a child of the scroll would be clipped by overflow:auto. We track which seam
  // is hovered + where to place the floating pill (viewport coords; left edge at
  // the scrollbar's right edge). A short hide-delay bridges the gap between the
  // in-scroll hover strip and the pill that sits just outside it.
  const [branchHover, setBranchHover] = useState(null); // { index, top, left }
  const [pillHover, setPillHover] = useState(false);    // pointer is on the pill
  const branchClearRef = useRef(null);
  const cancelBranchHide = () => { if (branchClearRef.current) { clearTimeout(branchClearRef.current); branchClearRef.current = null; } };
  const hideBranchSoon = () => { cancelBranchHide(); branchClearRef.current = window.setTimeout(() => setBranchHover(null), 150); };
  const showBranch = (index, anchorEl) => {
    cancelBranchHide();
    // Center the pill (and its connector) on the divider LINE's vertical center,
    // not the anchor's top edge, so the connector lines up exactly with the line.
    const lineEl = anchorEl.querySelector('.dv-branch-line');
    const lr = (lineEl || anchorEl).getBoundingClientRect();
    const centerY = lr.top + lr.height / 2;
    const sc = scrollRef.current?.getBoundingClientRect();
    const rightEdge = sc ? sc.right : lr.right;
    // left edge flush with the scrollbar's right edge (scrollbar inset 3px).
    setBranchHover({ index, top: toLayoutPx(centerY), left: toLayoutPx(rightEdge - 3) });
  };

  const scrollToBottom = useCallback((force) => {
    const el = scrollRef.current;
    if (!el) return;
    if (!force && !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, []);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    // Remember the position so a remount (version select) can restore it.
    if (file?.path) advisorScrollPos.set(file.path, { top: el.scrollTop, atBottom: stickRef.current });
    setScrolled((s) => (el.scrollTop > 44 ? (s ? s : true) : (s ? false : s)));
    setBranchHover(null); // a seam pill's position would be stale after scrolling
    syncScrollbar();
  };
  // On (re)mount, restore the remembered scroll position when the user was NOT
  // pinned to the bottom — so selecting a version keeps the thread put instead of
  // jumping to the latest message. (When they were at the bottom, the normal
  // stick-to-bottom takes over.) useLayoutEffect runs before paint = no flicker.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const saved = file?.path ? advisorScrollPos.get(file.path) : null;
    if (el && saved && !saved.atBottom) { el.scrollTop = saved.top; stickRef.current = false; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reveal the freshly-arrived assistant message with the typewriter effect
  // (matches the main app); errors / artifacts appear at once.
  useEffect(() => {
    const prev = prevLenRef.current;
    prevLenRef.current = messages.length;
    // Only a single freshly-appended message animates — a bulk jump (restoring a
    // saved thread on open) renders at once, no replayed typewriter.
    if (messages.length === prev + 1) {
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') setTyping(messages.length - 1);
      stickRef.current = true;
      scrollToBottom(true);
    } else if (messages.length !== prev) {
      scrollToBottom(true);
    }
  }, [messages, scrollToBottom]);
  useEffect(() => { scrollToBottom(false); }, [busy, scrollToBottom]);

  const copyMessage = async (text, index) => {
    try { await navigator.clipboard.writeText(text || ''); } catch { /* clipboard blocked */ }
    setCopiedIdx(index);
    window.setTimeout(() => setCopiedIdx((c) => (c === index ? null : c)), 1600);
  };

  const lastUserText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

  return (
    <div className="dv-advisor">
      {/* Compact header — fades in once the full masthead scrolls out of view. */}
      <div className={`dv-advisor-minihead${scrolled ? ' is-visible' : ''}`} aria-hidden={!scrolled}>
        <span className="dv-advisor-minihead-title">Generate</span>
        <span className="dv-advisor-minihead-dot" aria-hidden="true">·</span>
        <span className="dv-advisor-minihead-eyebrow">Document AI</span>
      </div>
      <div className={`dv-advisor-scroll${asking ? ' is-asking' : ''}`} ref={scrollRef} onScroll={onScroll}>
        {/* iOS-style mini masthead (mirrors the Settings / Newsletter header) —
            lives at the TOP OF THE SCROLL so it scrolls away with the thread. */}
        <header className="dv-advisor-head">
          <div className="dv-advisor-head-eyebrow">
            <span>Document AI</span>
            <span className="dv-advisor-head-muted">· this file</span>
          </div>
          <h2 className="dv-advisor-head-title">Generate.</h2>
          <p className="dv-advisor-head-sub">Draft and refine this document with AI — each version appears below.</p>
        </header>
        {/* Branch nav — one pill per split conversation. The original ("Main")
            stays so you can navigate back after splitting. Only shown once at
            least one split exists. */}
        {branches.length > 1 && (
          <div className="dv-branch-nav" role="tablist" aria-label="Conversations">
            {branches.map((b) => (
              <button
                key={b.id}
                type="button"
                role="tab"
                aria-selected={b.id === activeBranchId}
                className={`dv-branch-nav-pill${b.id === activeBranchId ? ' is-active' : ''}`}
                onClick={() => adv?.switchBranch?.(b.id)}
                disabled={busy}
              >
                {b.label}
              </button>
            ))}
          </div>
        )}
        {/* .ai-hub / .ai-chat-page scope the main app's bubble + markdown styles
            so this thread reads identically (width neutralised in DocViewer.css). */}
        <div className="dv-advisor-chat ai-hub ai-chat-page">
          {messages.length === 0 && !busy ? null : (
            <div className="chat">
              {messages.map((m, i) => {
                const inner = m.role === 'artifact' ? (
                  <DocVersionCard
                    fileName={file.name}
                    version={m.version}
                    instructions={m.instructions}
                    active={adv?.activeVersion === m.version}
                    onSelect={() => adv?.selectVersion?.(m.version)}
                    onOpenInApp={() => adv?.openVersion?.(m.version)}
                    disabled={busy || switching}
                  />
                ) : (
                  <div className={`bubble ${m.role === 'user' ? 'me' : ''}`}>
                    <div className="bubble-c">
                      <div className="bubble-msg">
                        {m.role === 'user'
                          ? m.content
                          : typing === i
                            ? <AdvTypewriter text={m.content || ''} onTick={() => scrollToBottom(false)} onDone={() => setTyping((t) => (t === i ? null : t))} />
                            : <div className="aichat-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content || ''}</ReactMarkdown></div>}
                      </div>
                    </div>
                  </div>
                );
                // A hover control to the right of an AI turn (except the last)
                // splits a new conversation from that point. It shows after an AI
                // text reply, or — when that reply produced a file — after the
                // generated file card, never between the note and its document.
                const aiText = m.role === 'assistant' && messages[i + 1]?.role !== 'artifact';
                const fileCard = m.role === 'artifact';
                const canBranch = (aiText || fileCard) && i < messages.length - 1 && !busy;
                // Persistent marker(s) for any branches split off at this point.
                const splitsHere = activeSplits.filter((s) => s.afterIndex === i);
                return (
                  <React.Fragment key={i}>
                    {inner}
                    {splitsHere.map((s) => (
                      <Tooltip key={s.branchId} content={`You split a new conversation (${s.label}) from here — click to open it`}>
                        <button
                          type="button"
                          className="dv-split-marker"
                          onClick={() => adv?.switchBranch?.(s.branchId)}
                        >
                          <span className="dv-split-marker-line" />
                          <span className="dv-split-marker-tag">{AdvBranchGlyph}Split from here → {s.label}</span>
                        </button>
                      </Tooltip>
                    ))}
                    {canBranch && (
                      <div
                        className={`dv-branch-anchor${branchHover?.index === i ? ' is-active' : ''}${branchHover?.index === i && pillHover ? ' is-pill-hover' : ''}`}
                        onMouseEnter={(e) => showBranch(i, e.currentTarget)}
                        onMouseLeave={hideBranchSoon}
                      >
                        <span className="dv-branch-line" />
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
              {busy && (
                <div className="bubble">
                  <div className="bubble-c">
                    <div className="bubble-msg"><AdvThinkingStatus query={lastUserText} /></div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        {error && (
          <div className="dv-ocr-error" role="alert">
            <span>{error}</span>
            <button type="button" aria-label="Dismiss" onClick={() => adv?.setError?.(null)}>×</button>
          </div>
        )}
      </div>
      {/* Custom scrollbar — sits in the gutter outside the chat section's right
          edge; native scrollbar is hidden. Synced to the scroll metrics above. */}
      <div className="dv-advisor-sb" ref={sbTrackRef} aria-hidden="true">
        <div className="dv-advisor-sb-thumb" ref={sbThumbRef} onMouseDown={onThumbDown} />
      </div>
      {/* Floating "Split from here" pill — portalled to <body> so it can overflow
          past the sidebar edge (a child of the scroll would be clipped). Placed
          at the hovered seam, left edge flush with the scrollbar's right edge. */}
      {branchHover && createPortal(
        <Tooltip content="Split a new conversation from here — keeps everything up to this message">
          <button
            type="button"
            className="dv-branch dv-branch--float"
            style={{ top: `${branchHover.top}px`, left: `${branchHover.left}px` }}
            onMouseEnter={() => { cancelBranchHide(); setPillHover(true); }}
            onMouseLeave={() => { hideBranchSoon(); setPillHover(false); }}
            onClick={() => { adv?.branchFrom?.(branchHover.index); setBranchHover(null); }}
          >
            {AdvBranchGlyph}<span>Split from here</span>
          </button>
        </Tooltip>,
        document.body,
      )}
      {/* The composer is the advisor tab's footer action — rendered into the
          single shared Multitool footer slot. */}
      <MultitoolFooter><MultitoolComposer /></MultitoolFooter>
    </div>
  );
}

// Caption snap layout (px within the video stage):
//  • CAP_PAD      — edge inset for the top / left / right snap targets
//  • CAP_BOTTOM   — keep the caption clear of the timeline + controls bar
//  • CAP_TOPRIGHT — top-right target drops below the zoom pill + Extract-text
//                   button (both now live in the stage's top-right corner)
//  • CAP_SNAP     — snap when the caption centre is within this distance
const CAP_PAD = 16;
const CAP_BOTTOM = 118;
const CAP_TOPRIGHT = 108;
const CAP_SNAP = 46;
// Fixed nominal half-size used ONLY to place the snap dots, so they sit in the
// same spot regardless of the current caption's width/height (the snap-target
// centres still use the real half-size so the box lands fully inside the stage).
const CAP_DOT_HALFW = 80;
const CAP_DOT_HALFH = 18;

function MediaOcrPane({ file, url, kind, sidePanelSlot = null, sideTabsSlot = null }) {
  const { notify } = useNotifications();
  const stageRef = useRef(null);
  const mediaRef = useRef(null);
  const clipIdRef = useRef(`dvocr-${Math.random().toString(36).slice(2)}`);
  const [armed, setArmed] = useState(false);
  const [tool, setTool] = useState('highlight');
  // Hover position — viewport px relative to the stage, null until the
  // cursor enters the overlay.
  const [cursorPos, setCursorPos] = useState(null);
  // Brush/shape size shared by Highlight, Circle and Square (Custom ignores
  // it); viewport px.
  const [brushRadius, setBrushRadius] = useState(OCR_CIRCLE_DEFAULT);
  const brushRadiusRef = useRef(brushRadius);
  useEffect(() => { brushRadiusRef.current = brushRadius; }, [brushRadius]);
  // Active mouse-down stroke: { tool, start: {x,y}, points: [{x,y}, ...] }.
  const [drag, setDrag] = useState(null);
  // Finalized shape awaiting/under OCR — stays visible so the loading
  // gradient has something to paint over.
  const [selection, setSelection] = useState(null);
  const [working, setWorking] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [failed, setFailed] = useState(false);
  // Persisted snippet history for this file — newest first; rendered oldest
  // first so the newest snippet lands at the bottom of the list.
  const [history, setHistory] = useState(() => loadOcrHistory(file.path));
  const [historyWidth, setHistoryWidth] = useState(HISTORY_DEFAULT_WIDTH);
  const jobIdRef = useRef(0);
  const historyListRef = useRef(null);
  // Compact-header-on-scroll (mirrors the Versions page): show the mini header
  // once the masthead has scrolled away. Hysteresis avoids edge flicker.
  const [historyScrolled, setHistoryScrolled] = useState(false);
  useEffect(() => {
    const el = historyListRef.current;
    if (!el) return undefined;
    const onScroll = () => setHistoryScrolled((s) => (s ? el.scrollTop > 8 : el.scrollTop > 28));
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // "Locate selection": clicking a snippet thumbnail highlights where it was
  // taken from, back on the picture/video. `highlightId` is the entry being
  // shown; `highlightShape` is its region mapped to current stage-viewport px.
  const [highlightId, setHighlightId] = useState(null);
  const [highlightShape, setHighlightShape] = useState(null);
  // Full-frame JPEG overlay shown while the video seeks to the right timestamp.
  // Gives an instant "correct frame" appearance; cleared once seeked fires.
  const [frameSnapOverlay, setFrameSnapOverlay] = useState(null);
  // True while seeking between highlighted items — blanks the stage.
  const [seekLoading, setSeekLoading] = useState(false);
  // Latest value for the stable pan handler (a plain stage click dismisses it).
  const highlightIdRef = useRef(null);
  useEffect(() => { highlightIdRef.current = highlightId; }, [highlightId]);
  // Re-map the stored region (natural px) to stage px every frame while a
  // highlight is shown, so it stays glued through zoom/pan transitions and
  // window resizes. The loop only runs while something is highlighted.
  useEffect(() => {
    if (!highlightId) { setHighlightShape(null); setFrameSnapOverlay(null); setSeekLoading(false); return undefined; }
    const entry = history.find((e) => e.id === highlightId);
    const el = mediaRef.current;
    const stage = stageRef.current;
    if (!entry?.region || !el || !stage) { setHighlightShape(null); setFrameSnapOverlay(null); setSeekLoading(false); return undefined; }

    let raf = 0;
    let dead = false;
    let snapSeekListener = null;
    let prevKey = '';

    // Compute the selection outline in current stage-viewport px.
    const computeShape = () => {
      const sr = stage.getBoundingClientRect();
      const mr = el.getBoundingClientRect();
      const natW = kind === 'video' ? el.videoWidth : el.naturalWidth;
      if (!mr.width || !natW) return null;
      const scale = mr.width / natW;
      const ox = mr.left - sr.left;
      const oy = mr.top - sr.top;
      const toStage = (p) => ({ x: p.x * scale + ox, y: p.y * scale + oy });
      return regionToStageShape(entry.region, toStage, scale);
    };

    // rAF loop keeps the outline glued through zoom/pan/resize.
    const tick = () => {
      if (dead) return;
      const shape = computeShape();
      const key = JSON.stringify(shape);
      if (key !== prevKey) { prevKey = key; setHighlightShape(shape); }
      raf = requestAnimationFrame(tick);
    };

    if (kind === 'video' && typeof entry.videoTime === 'number') {
      try { el.pause(); } catch { /* noop */ }
      const needsSeek = Math.abs((el.currentTime || 0) - entry.videoTime) >= 0.05;

      if (!needsSeek) {
        // Already on the right frame — show everything immediately.
        setSeekLoading(false);
        setFrameSnapOverlay(null);
        setHighlightShape(computeShape());
      } else {
        // Seeking needed. Show blank loading state immediately, then reveal
        // both the correct frame and selection outline together on `seeked`.
        // If a frameSnap was captured at extraction time, show it under the
        // loading overlay so the transition is less abrupt.
        setSeekLoading(true);
        setHighlightShape(null);
        if (entry.frameSnap) {
          const mr = el.getBoundingClientRect();
          const sr = stage.getBoundingClientRect();
          setFrameSnapOverlay({
            url: entry.frameSnap,
            left: mr.left - sr.left,
            top: mr.top - sr.top,
            width: mr.width,
            height: mr.height,
          });
        } else {
          setFrameSnapOverlay(null);
        }

        const onSeeked = () => {
          if (dead) return;
          setSeekLoading(false);
          setFrameSnapOverlay(null);
          const shape = computeShape();
          prevKey = JSON.stringify(shape);
          setHighlightShape(shape);
          raf = requestAnimationFrame(tick);
        };
        snapSeekListener = onSeeked;
        el.addEventListener('seeked', snapSeekListener, { once: true });
        try {
          if (el.fastSeek) el.fastSeek(entry.videoTime);
          else el.currentTime = entry.videoTime;
        } catch {
          el.removeEventListener('seeked', snapSeekListener);
          snapSeekListener = null;
          setSeekLoading(false);
          setFrameSnapOverlay(null);
          setHighlightShape(computeShape());
          raf = requestAnimationFrame(tick);
        }
        return () => {
          dead = true;
          cancelAnimationFrame(raf);
          if (snapSeekListener) el.removeEventListener('seeked', snapSeekListener);
        };
      }
    } else {
      setSeekLoading(false);
      setFrameSnapOverlay(null);
      setHighlightShape(computeShape());
    }

    // Start the rAF loop after the initial sync set.
    prevKey = JSON.stringify(computeShape());
    raf = requestAnimationFrame(tick);

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      if (snapSeekListener) el.removeEventListener('seeked', snapSeekListener);
    };
  }, [highlightId, history, kind]);

  // Esc clears an active highlight (matches the tool's Esc-to-cancel).
  useEffect(() => {
    if (!highlightId) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setHighlightId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [highlightId]);

  // ── Zoom / pan ───────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const panStateRef = useRef({ x: 0, y: 0 });

  // ── Video player ─────────────────────────────────────────────────
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Right sidebar tab (video only): 'extract' (OCR snippets) | 'captions'.
  const [rightTab, setRightTab] = useState('extract');
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [controlsShown, setControlsShown] = useState(true);
  const controlsTimerRef = useRef(null);
  // YouTube-style play/pause flash: { type: 'play'|'pause', seq: number }
  // `seq` is incremented on each trigger so the element remounts and the
  // animation restarts even if the user clicks the same action twice fast.
  const [playbackFlash, setPlaybackFlash] = useState(null);
  const flashSeqRef = useRef(0);

  const disarm = useCallback(() => {
    setArmed(false); setCursorPos(null); setDrag(null); setSelection(null);
    setWorking(false); setErrorMsg(null); setHighlightId(null);
  }, []);

  const bumpControls = useCallback(() => {
    setControlsShown(true);
    clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setControlsShown(false), 2500);
  }, []);
  const triggerPlaybackFlash = useCallback((type) => {
    flashSeqRef.current += 1;
    setPlaybackFlash({ type, seq: flashSeqRef.current });
  }, []);
  const togglePlay = useCallback(() => {
    const v = mediaRef.current;
    if (!v) return;
    if (v.paused) { v.play(); triggerPlaybackFlash('play'); }
    else { v.pause(); triggerPlaybackFlash('pause'); }
  }, [triggerPlaybackFlash]);
  const seekTo = useCallback((val) => {
    const v = mediaRef.current;
    if (v) v.currentTime = val;
  }, []);
  const setVol = useCallback((val) => {
    const v = mediaRef.current;
    if (!v) return;
    v.volume = val;
    v.muted = val === 0;
  }, []);
  const toggleMute = useCallback(() => {
    const v = mediaRef.current;
    if (v) v.muted = !v.muted;
  }, []);

  useEffect(() => {
    if (!playing) { clearTimeout(controlsTimerRef.current); setControlsShown(true); }
  }, [playing]);
  useEffect(() => () => clearTimeout(controlsTimerRef.current), []);

  // ── Live AI captions (video) ─────────────────────────────────────
  // Mirror the generated transcript (pushed up from the side CaptionsPanel and
  // seeded from the per-file cache) so the line at the current time can show as
  // a subtitle over the decibel line. null until captions exist.
  const [captions, setCaptions] = useState(() => captionsFromCache(file.storage_path));
  useEffect(() => { setCaptions(captionsFromCache(file.storage_path)); }, [file.storage_path]);
  const activeCaption = useMemo(() => {
    if (kind !== 'video' || captions?.state !== 'done') return null;
    const seg = captions.segments.find((s) => currentTime >= s.start && currentTime < s.end);
    return seg?.text?.trim() || null;
  }, [kind, captions, currentTime]);

  // ── Movable caption (YouTube-style) ──────────────────────────────
  // `captionSettings` = { x, y, enabled }: x/y are the caption centre as a %
  // of the stage, loaded from a GLOBAL store so the placement (and on/off
  // state) is shared across files and survives app restarts. Dragging updates
  // it live and persists on drop.
  const captionRef = useRef(null);
  const [captionSettings, setCaptionSettings] = useState(loadCaptionSettings);
  const [draggingCaption, setDraggingCaption] = useState(false);
  // Snap targets shown while dragging (caption-centre px within the stage) +
  // the id of the one currently engaged.
  const [snapAnchors, setSnapAnchors] = useState(null);
  const [activeSnap, setActiveSnap] = useState(null);

  const toggleCaptions = useCallback(() => {
    setCaptionSettings((s) => {
      const next = { ...s, enabled: !s.enabled };
      saveCaptionSettings({ enabled: next.enabled });
      return next;
    });
  }, []);

  // The 9 snap targets (corners + edge-centres + middle) as caption-centre px,
  // each carrying the text alignment to apply when snapped there. Left column →
  // left-aligned, right column → right-aligned, centre column → centred. The
  // top-right target sits under the zoom pill + Extract-text button; the bottom
  // row stays above the timeline/controls.
  const captionSnapAnchors = useCallback((sr, halfW, halfH) => {
    // The snap grid spans from the FLOATING SIDE PANEL's right edge (8px
    // inset + --dv-advisor-w + 8px gutter) to the window's right edge, not
    // the full stage — read the panel width live off the inherited var.
    const varW = parseFloat(getComputedStyle(stageRef.current || document.body).getPropertyValue('--dv-advisor-w'));
    const offX = (Number.isFinite(varW) ? varW : 296) + 24;
    // Snap-target CENTRES (x/y) — the caption box's centre when snapped here.
    // They use the REAL half-size so the box pins its edge at CAP_PAD and stays
    // fully inside the stage. These are viewport px, tested against the cursor.
    const leftX = offX + CAP_PAD + halfW;
    const centreX = offX + (sr.width - offX) / 2;
    const rightX = sr.width - CAP_PAD - halfW;
    const topY = CAP_PAD + halfH;
    const midY = sr.height / 2;
    const bottomY = sr.height - CAP_BOTTOM - halfH;
    const topRightY = CAP_TOPRIGHT + halfH;
    // DOT positions (dx/dy) — where the snap dot is DRAWN. They use a FIXED
    // nominal half-size so the dots stay in the same place no matter how wide /
    // tall the current caption is (xPct/yPct are stage-relative %, since CSS px
    // ≠ viewport px under the app's CSS-zoom).
    const dLeftX = offX + CAP_PAD + CAP_DOT_HALFW;
    const dRightX = sr.width - CAP_PAD - CAP_DOT_HALFW;
    const dTopY = CAP_PAD + CAP_DOT_HALFH;
    const dBottomY = sr.height - CAP_BOTTOM - CAP_DOT_HALFH;
    const dTopRightY = CAP_TOPRIGHT + CAP_DOT_HALFH;
    return [
      { id: 'tl', x: leftX, y: topY, dx: dLeftX, dy: dTopY, align: 'left' },
      { id: 'tc', x: centreX, y: topY, dx: centreX, dy: dTopY, align: 'center' },
      { id: 'tr', x: rightX, y: topRightY, dx: dRightX, dy: dTopRightY, align: 'right' },
      { id: 'ml', x: leftX, y: midY, dx: dLeftX, dy: midY, align: 'left' },
      { id: 'mc', x: centreX, y: midY, dx: centreX, dy: midY, align: 'center' },
      { id: 'mr', x: rightX, y: midY, dx: dRightX, dy: midY, align: 'right' },
      { id: 'bl', x: leftX, y: bottomY, dx: dLeftX, dy: dBottomY, align: 'left' },
      { id: 'bc', x: centreX, y: bottomY, dx: centreX, dy: dBottomY, align: 'center' },
      { id: 'br', x: rightX, y: bottomY, dx: dRightX, dy: dBottomY, align: 'right' },
    ].map((a) => ({ ...a, xPct: (a.dx / sr.width) * 100, yPct: (a.dy / sr.height) * 100 }));
  }, []);

  // Keep the caption clear of the timeline/controls whenever the stage resizes
  // (window resize, Files footer opening) — never raises a higher placement.
  useEffect(() => {
    if (kind !== 'video' || typeof ResizeObserver === 'undefined') return undefined;
    const stage = stageRef.current;
    if (!stage) return undefined;
    const clamp = () => {
      const sr = stage.getBoundingClientRect();
      if (!sr.height) return;
      const capEl = captionRef.current;
      const halfH = capEl ? capEl.getBoundingClientRect().height / 2 : 18;
      const maxYpct = ((sr.height - CAP_BOTTOM - halfH) / sr.height) * 100;
      setCaptionSettings((s) => (s.y > maxYpct ? { ...s, y: Math.max(0, maxYpct) } : s));
    };
    const ro = new ResizeObserver(clamp);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [kind]);

  const onCaptionMouseDown = useCallback((e) => {
    // Don't fight the OCR lasso or start a stage pan when grabbing the caption.
    if (armed) return;
    e.preventDefault();
    e.stopPropagation();
    const stage = stageRef.current;
    const capEl = captionRef.current;
    if (!stage || !capEl) return;
    const sr = stage.getBoundingClientRect();
    const cr = capEl.getBoundingClientRect();
    // Keep the grab point under the cursor (no jump to centre on grab).
    const grabDx = e.clientX - (cr.left + cr.width / 2);
    const grabDy = e.clientY - (cr.top + cr.height / 2);
    const halfW = cr.width / 2;
    const halfH = cr.height / 2;
    const anchors = captionSnapAnchors(sr, halfW, halfH);
    // Never let the caption drop under the timeline/controls.
    const maxY = sr.height - CAP_BOTTOM - halfH;
    setSnapAnchors(anchors);
    setDraggingCaption(true);
    let latest = null;
    const onMove = (ev) => {
      let cx = ev.clientX - grabDx - sr.left;
      let cy = ev.clientY - grabDy - sr.top;
      cx = Math.max(halfW, Math.min(sr.width - halfW, cx));
      cy = Math.max(halfH, Math.min(maxY, cy));
      // Snap to the nearest target within range; otherwise align by column.
      let best = null; let bestDist = CAP_SNAP;
      for (const a of anchors) {
        const d = Math.hypot(cx - a.x, cy - a.y);
        if (d < bestDist) { bestDist = d; best = a; }
      }
      let align;
      if (best) { cx = best.x; cy = best.y; align = best.align; setActiveSnap(best.id); }
      else { align = cx / sr.width <= 0.34 ? 'left' : cx / sr.width >= 0.66 ? 'right' : 'center'; setActiveSnap(null); }
      // Store the alignment-relevant EDGE (left edge for left, right edge for
      // right, centre for centre) so the caption pins to that side: text-align
      // reads naturally and the box stays put as the line length changes.
      const anchorX = align === 'left' ? cx - halfW : align === 'right' ? cx + halfW : cx;
      latest = { x: (anchorX / sr.width) * 100, y: (cy / sr.height) * 100, align };
      setCaptionSettings((s) => ({ ...s, ...latest }));
    };
    const onUp = () => {
      setDraggingCaption(false);
      setSnapAnchors(null);
      setActiveSnap(null);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (latest) saveCaptionSettings(latest);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [armed, captionSnapAnchors]);

  // ── Zoom / pan ───────────────────────────────────────────────────
  // Reset on file change.
  useEffect(() => { setZoom(1); setPanX(0); setPanY(0); }, [file.path]);
  // Keep panStateRef current so the drag closure reads the latest value.
  useEffect(() => { panStateRef.current = { x: panX, y: panY }; }, [panX, panY]);

  // Current zoom, readable synchronously — wheel bursts fire faster than
  // re-renders, and zoom math must chain off the latest value, not the one
  // from the last committed render.
  const zoomRef = useRef(1);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  // Step the zoom and scale the pan by the same factor so the point at the
  // stage centre stays put — zooming happens around the current view centre
  // (the panned-to spot) rather than the image's own centre.
  //
  // IMPORTANT: the factor is computed OUTSIDE the state updaters. The old
  // code called setPanX from inside setZoom's updater; React (StrictMode)
  // invokes updaters twice, so the pan got re-scaled twice per step and the
  // view jumped sideways after any pan + zoom combination.
  const applyZoom = useCallback((dir) => {
    const z = zoomRef.current;
    // Zooming OUT while a snippet is focused ends the focus — the selection
    // deselects and its highlight clears.
    if (dir === 'out' && highlightIdRef.current) setHighlightId(null);
    const raw = dir === 'in' ? z * ZOOM_STEP : z / ZOOM_STEP;
    if (dir === 'out' && raw <= 1) {
      zoomRef.current = 1;
      setZoom(1);
      setPanX(0);
      setPanY(0);
      return;
    }
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, +raw.toFixed(3)));
    const factor = next / z;
    zoomRef.current = next;
    setZoom(next);
    setPanX((px) => px * factor);
    setPanY((py) => py * factor);
  }, []);

  const zoomIn = useCallback(() => applyZoom('in'), [applyZoom]);
  const zoomOut = useCallback(() => applyZoom('out'), [applyZoom]);

  // Resizing the side panel changes the stage's padding-left (--dv-advisor-w),
  // which re-centres the media and would drag a zoomed-in view sideways.
  // Watch the media's untransformed layout centre (offsetLeft/Top ignore the
  // pan/zoom transform) and cancel any shift through the pan, so the pixels
  // the user is looking at stay put while the panel is dragged.
  useEffect(() => {
    const stage = stageRef.current;
    const el = mediaRef.current;
    if (!stage || !el || typeof ResizeObserver === 'undefined') return undefined;
    let last = {
      x: el.offsetLeft + el.offsetWidth / 2,
      y: el.offsetTop + el.offsetHeight / 2,
    };
    const ro = new ResizeObserver(() => {
      const cur = {
        x: el.offsetLeft + el.offsetWidth / 2,
        y: el.offsetTop + el.offsetHeight / 2,
      };
      if (zoomRef.current > 1) {
        const dx = cur.x - last.x;
        const dy = cur.y - last.y;
        if (dx) setPanX((px) => px - dx);
        if (dy) setPanY((py) => py - dy);
      }
      last = cur;
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, [url]);

  // "Focus" a saved selection: zoom + pan so its region sits centred in the
  // media area at a comfortable size (~55% of the stage). Pan maths mirror
  // the transform (`translate(pan) scale(zoom)`, origin = element centre):
  // pan is in screen px, so a natural-px offset from the media centre maps
  // through baseScale (layout px per natural px) × zoom.
  const focusRegion = useCallback((entry) => {
    const el = mediaRef.current;
    const stage = stageRef.current;
    const reg = entry?.region;
    if (!el || !stage || !reg) return;
    const natW = kind === 'video' ? el.videoWidth : el.naturalWidth;
    const natH = kind === 'video' ? el.videoHeight : el.naturalHeight;
    if (!natW || !natH) return;
    // Region bbox in natural px.
    let minX;
    let minY;
    let maxX;
    let maxY;
    if (reg.kind === 'rect') {
      minX = Math.min(reg.x1, reg.x2);
      maxX = Math.max(reg.x1, reg.x2);
      minY = Math.min(reg.y1, reg.y2);
      maxY = Math.max(reg.y1, reg.y2);
    } else if (Array.isArray(reg.points) && reg.points.length) {
      const r = reg.kind === 'union' ? (reg.r || 0) : 0;
      minX = Math.min(...reg.points.map((p) => p.x - r));
      maxX = Math.max(...reg.points.map((p) => p.x + r));
      minY = Math.min(...reg.points.map((p) => p.y - r));
      maxY = Math.max(...reg.points.map((p) => p.y + r));
    } else {
      return;
    }
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    // offsetWidth is the untransformed layout size (getBoundingClientRect
    // would bake the current zoom in).
    const baseScale = el.offsetWidth / natW;
    const sr = stage.getBoundingClientRect();
    const FILL = 0.55;
    const fit = Math.min((sr.width * FILL) / (bw * baseScale), (sr.height * FILL) / (bh * baseScale));
    const z = Math.max(1, Math.min(ZOOM_MAX, +fit.toFixed(3)));
    zoomRef.current = z;
    setZoom(z);
    setPanX(-((minX + maxX) / 2 - natW / 2) * baseScale * z);
    setPanY(-((minY + maxY) / 2 - natH / 2) * baseScale * z);
  }, [kind]);
  const zoomReset = useCallback(() => {
    // Resetting the view also ends a snippet focus.
    if (highlightIdRef.current) setHighlightId(null);
    zoomRef.current = 1;
    setZoom(1);
    setPanX(0);
    setPanY(0);
  }, []);
  // Re-centre the media in the stage without changing the zoom level (brings a
  // panned-away video/image back to the middle).
  const recenter = useCallback(() => { setPanX(0); setPanY(0); }, []);

  // Non-passive wheel listener for scroll-to-zoom (passive: false required for preventDefault).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheel = (e) => {
      if (armed) return;
      e.preventDefault();
      applyZoom(e.deltaY < 0 ? 'in' : 'out');
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [armed, applyZoom]);

  // Stage mousedown: pan when zoomed, or click-to-play for video (replaces dv-player-click).
  const onStageMouseDown = useCallback((e) => {
    if (armed || e.button !== 0) return;
    if (e.target.closest('.dv-player-controls, .dv-stage-tools, .dv-zoom-controls')) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const { x: startPanX, y: startPanY } = panStateRef.current;
    // Only pan when actually zoomed IN — at fit (zoom 1) the media already
    // fills the stage, so a drag must not accumulate a pan offset (a bogus
    // offset here would get multiplied by reanchorPan on the next zoom and make
    // the zoom jump). Captured at mousedown; zoom can't change mid-drag.
    const canPan = zoom > 1;
    let moved = false;
    setIsDragging(true);
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      if (!canPan) return;
      document.body.classList.add('dv-media-panning');
      setPanX(startPanX + dx);
      setPanY(startPanY + dy);
    };
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('dv-media-panning');
      setIsDragging(false);
      if (moved) return;
      // A plain click dismisses an active "locate selection" highlight;
      // otherwise it falls through to the video's click-to-play.
      if (highlightIdRef.current) setHighlightId(null);
      else if (kind === 'video') togglePlay();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [armed, kind, togglePlay, zoom]);

  // Keyboard shortcuts: +/= zoom in, - zoom out, 0 reset.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomIn(); }
      else if (e.key === '-') { e.preventDefault(); zoomOut(); }
      else if (e.key === '0') { e.preventDefault(); zoomReset(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomIn, zoomOut, zoomReset]);

  // Reopening the file restores its history; edits to the list persist back.
  useEffect(() => { saveOcrHistory(file.path, history); }, [file.path, history]);

  // Esc cancels the tool and any in-flight selection/error.
  useEffect(() => {
    if (!armed) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') disarm(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armed, disarm]);

  // Auto-dismiss the error pill.
  useEffect(() => {
    if (!errorMsg) return undefined;
    const t = setTimeout(() => setErrorMsg(null), 4000);
    return () => clearTimeout(t);
  }, [errorMsg]);

  // shape: { kind: 'circle' | 'rect' | 'union' | 'path', ... } in
  // stage-viewport px. Maps it to natural-resolution pixels via the media
  // element's box, clips the crop to its outline (Photoshop-lasso style),
  // and sends it to lib/ocr.
  const runOcr = useCallback(async (shape, stageRect) => {
    const el = mediaRef.current;
    if (!el) return;
    const natW = kind === 'video' ? el.videoWidth : el.naturalWidth;
    const natH = kind === 'video' ? el.videoHeight : el.naturalHeight;
    if (!natW || !natH) return;
    // For video, remember the exact moment OCR read the frame so clicking the
    // snippet later can teleport the player back to it. Also capture a full-
    // frame JPEG snapshot so the "jump to moment" button can show the correct
    // frame instantly while the video seeks in the background.
    const videoTime = kind === 'video' ? (el.currentTime || 0) : undefined;
    let frameSnap;
    if (kind === 'video') {
      try {
        const fc = document.createElement('canvas');
        const fscale = Math.min(1, 720 / Math.max(natW, natH));
        fc.width = Math.round(natW * fscale);
        fc.height = Math.round(natH * fscale);
        fc.getContext('2d').drawImage(el, 0, 0, fc.width, fc.height);
        frameSnap = fc.toDataURL('image/jpeg', 0.82);
      } catch { /* cross-origin or canvas taint — skip */ }
    }
    const mr = el.getBoundingClientRect();
    if (!mr.width || !mr.height) { setSelection(null); return; }
    const mrRelLeft = mr.left - stageRect.left;
    const mrRelTop = mr.top - stageRect.top;

    // object-fit: contain keeps the element's box aspect ratio equal to the
    // image's, so one scale factor covers both axes.
    const mapScale = mr.width / natW;
    const toNat = (p) => ({ x: (p.x - mrRelLeft) / mapScale, y: (p.y - mrRelTop) / mapScale });

    let bbox;
    if (shape.kind === 'rect') {
      const p1 = toNat({ x: shape.x1, y: shape.y1 });
      const p2 = toNat({ x: shape.x2, y: shape.y2 });
      bbox = { minX: Math.min(p1.x, p2.x), minY: Math.min(p1.y, p2.y), maxX: Math.max(p1.x, p2.x), maxY: Math.max(p1.y, p2.y) };
    } else if (shape.kind === 'union') {
      const r = shape.r / mapScale;
      const pts = shape.points.map(toNat);
      bbox = {
        minX: Math.min(...pts.map((p) => p.x - r)), minY: Math.min(...pts.map((p) => p.y - r)),
        maxX: Math.max(...pts.map((p) => p.x + r)), maxY: Math.max(...pts.map((p) => p.y + r)),
      };
    } else {
      const pts = shape.points.map(toNat);
      bbox = {
        minX: Math.min(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)),
        maxX: Math.max(...pts.map((p) => p.x)), maxY: Math.max(...pts.map((p) => p.y)),
      };
    }

    // Selection geometry in natural-resolution px — stored with the entry so
    // clicking its thumbnail can re-draw the selection back onto the media at
    // any zoom/size (see the "locate selection" highlight overlay below).
    let region = null;
    if (shape.kind === 'rect') {
      const a = toNat({ x: shape.x1, y: shape.y1 });
      const b = toNat({ x: shape.x2, y: shape.y2 });
      region = { kind: 'rect', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    } else if (shape.kind === 'union') {
      region = { kind: 'union', points: shape.points.map(toNat), r: shape.r / mapScale };
    } else if (shape.kind === 'path') {
      region = { kind: 'path', points: shape.points.map(toNat) };
    }

    const minX = Math.max(0, bbox.minX);
    const minY = Math.max(0, bbox.minY);
    const maxX = Math.min(natW, bbox.maxX);
    const maxY = Math.min(natH, bbox.maxY);
    const sw = maxX - minX;
    const sh = maxY - minY;
    if (sw < 4 || sh < 4) { setSelection(null); return; }
    // Claude downsizes anything over OCR_MAX_EDGE on the long side — cap the
    // crop there (never upscale; extra pixels only slow the upload).
    const cropScale = Math.min(1, OCR_MAX_EDGE / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * cropScale));
    canvas.height = Math.max(1, Math.round(sh * cropScale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const toCanvas = (p) => { const n = toNat(p); return { x: (n.x - minX) * cropScale, y: (n.y - minY) * cropScale }; };
    const rScale = cropScale / mapScale;

    // Clip to the selection's outline before drawing — pixels outside it
    // stay transparent rather than reading as part of the snippet.
    ctx.beginPath();
    if (shape.kind === 'rect') {
      const p1 = toCanvas({ x: shape.x1, y: shape.y1 });
      const p2 = toCanvas({ x: shape.x2, y: shape.y2 });
      ctx.rect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
    } else if (shape.kind === 'union') {
      const r = shape.r * rScale;
      shape.points.forEach((p) => {
        const c = toCanvas(p);
        ctx.moveTo(c.x + r, c.y);
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      });
    } else {
      shape.points.forEach((p, i) => {
        const c = toCanvas(p);
        if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y);
      });
      ctx.closePath();
    }
    ctx.clip();
    try {
      ctx.drawImage(el, minX, minY, sw, sh, 0, 0, canvas.width, canvas.height);
    } catch {
      setSelection(null);
      setWorking(false);
      setErrorMsg("Couldn't read pixels from this file.");
      return;
    }

    jobIdRef.current += 1;
    const id = jobIdRef.current;
    setWorking(true);
    try {
      const text = await recognizeCanvas(canvas);
      if (jobIdRef.current === id) {
        const entry = { id: `${Date.now()}-${id}`, thumb: canvasToThumbDataUrl(canvas), text, createdAt: Date.now(), region, natW, natH, videoTime, frameSnap };
        setHistory((prev) => [entry, ...prev]);
        notify({
          category: 'file',
          variant: 'success',
          icon: 'sparkles',
          title: 'Text extracted',
          body: `New extract from “${file.name}”.`,
          silent: true,
          payload: { activity: { action: 'extract-text', fileName: file.name, filePath: file.path } },
        });
        setSelection(null);
        setWorking(false);
        requestAnimationFrame(() => {
          const listEl = historyListRef.current;
          if (listEl) listEl.scrollTop = listEl.scrollHeight;
        });
      }
    } catch (e) {
      if (jobIdRef.current === id) {
        setWorking(false);
        setSelection(null);
        setErrorMsg(String(e?.message || 'Text recognition failed.'));
      }
    }
  }, [kind, notify, file.name, file.path]);

  // Builds the finalized shape for a finished drag, applying tool-specific
  // minimum sizes — a plain click without dragging falls back to the brush
  // size, like the previous click-to-extract behaviour.
  const finalizeDrag = useCallback((d, stageRect) => {
    const cur = d.points[d.points.length - 1];
    let shape;
    if (d.tool === 'square') {
      const trivial = Math.abs(cur.x - d.start.x) < 4 && Math.abs(cur.y - d.start.y) < 4;
      const r = brushRadiusRef.current;
      shape = trivial
        ? { kind: 'rect', x1: d.start.x - r, y1: d.start.y - r, x2: d.start.x + r, y2: d.start.y + r }
        : { kind: 'rect', x1: d.start.x, y1: d.start.y, x2: cur.x, y2: cur.y };
    } else if (d.tool === 'lasso') {
      shape = d.points.length < 3
        ? { kind: 'rect', x1: d.start.x - brushRadiusRef.current, y1: d.start.y - brushRadiusRef.current, x2: d.start.x + brushRadiusRef.current, y2: d.start.y + brushRadiusRef.current }
        : { kind: 'path', points: d.points };
    } else {
      shape = { kind: 'union', points: d.points, r: brushRadiusRef.current };
    }
    setSelection(shape);
    runOcr(shape, stageRect);
  }, [runOcr]);

  // Tracks the cursor for the idle brush/shape preview. State stays in
  // viewport px; toLayoutPx only at render time.
  const onOverlayMouseMove = (e) => {
    if (drag) return;
    const stageRect = stageRef.current.getBoundingClientRect();
    setCursorPos({ x: e.clientX - stageRect.left, y: e.clientY - stageRect.top });
  };

  // Scroll resizes the active tool's brush/shape size (Custom ignores it).
  const onOverlayWheel = (e) => {
    e.preventDefault();
    if (tool === 'lasso') return;
    setBrushRadius((r) => Math.min(OCR_CIRCLE_MAX, Math.max(OCR_CIRCLE_MIN, r - e.deltaY * OCR_CIRCLE_STEP)));
  };

  // Click-and-drag paints (Highlight/Custom) or draws (Circle/Square) the
  // selection; release runs OCR on it.
  const onOverlayMouseDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const stageEl = stageRef.current;
    const stageRect0 = stageEl.getBoundingClientRect();
    const start = { x: e.clientX - stageRect0.left, y: e.clientY - stageRect0.top };
    setErrorMsg(null);
    setDrag({ tool, start, points: [start] });
    const onMove = (ev) => {
      const r = stageEl.getBoundingClientRect();
      const p = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      setCursorPos(p);
      setDrag((d) => {
        if (!d) return d;
        if (d.tool === 'highlight' || d.tool === 'lasso') {
          const last = d.points[d.points.length - 1];
          const minDist = d.tool === 'highlight' ? Math.max(4, brushRadiusRef.current * 0.35) : 3;
          if (Math.hypot(p.x - last.x, p.y - last.y) < minDist) return d;
          return { ...d, points: [...d.points, p] };
        }
        return { ...d, points: [d.start, p] };
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const r = stageEl.getBoundingClientRect();
      setDrag((d) => {
        if (d) finalizeDrag(d, r);
        return null;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Drag handle resizing the "Extracted text" panel. clientX deltas are
  // viewport px; the panel's width is a layout-px CSS length (see lib/appZoom).
  const beginHistoryResize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = historyWidth;
    document.body.classList.add('dv-ocr-resizing');
    const onMove = (ev) => {
      const delta = toLayoutPx(startX - ev.clientX);
      setHistoryWidth(Math.min(HISTORY_MAX_WIDTH, Math.max(HISTORY_MIN_WIDTH, startW + delta)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('dv-ocr-resizing');
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Picking a selection tool in the stage pill also ARMS extraction mode
  // right away (no separate "Extract text" click needed).
  const pickTool = (id) => {
    setTool(id);
    if (!armed) {
      setHighlightId(null);
      if (kind === 'video') { try { mediaRef.current?.pause(); } catch { /* noop */ } }
      setArmed(true);
    }
  };

  const removeHistoryEntry = (entryId) => {
    if (highlightId === entryId) setHighlightId(null);
    setHistory((prev) => prev.filter((e) => e.id !== entryId));
  };

  const clearHistory = () => { setHighlightId(null); setHistory([]); };

  // The shape shown to the user: the active drag in progress, or the idle
  // brush/shape preview that follows the cursor before any drag starts.
  const previewShape = useMemo(() => {
    if (drag) {
      const cur = drag.points[drag.points.length - 1];
      if (drag.tool === 'square') {
        return { kind: 'rect', x1: drag.start.x, y1: drag.start.y, x2: cur.x, y2: cur.y };
      }
      if (drag.tool === 'lasso') return { kind: 'path', points: drag.points };
      return { kind: 'union', points: drag.points, r: brushRadius };
    }
    if (!cursorPos) return null;
    // Square: no idle preview — the rectangle only appears while the mouse
    // button is held (the drag branch above); until then just a small dot
    // marks the anchor point, like the lasso.
    if (tool === 'square') return { kind: 'circle', cx: cursorPos.x, cy: cursorPos.y, r: 4 };
    if (tool === 'lasso') return { kind: 'circle', cx: cursorPos.x, cy: cursorPos.y, r: 4 };
    return { kind: 'circle', cx: cursorPos.x, cy: cursorPos.y, r: brushRadius };
  }, [drag, cursorPos, tool, brushRadius]);

  const clipBase = clipIdRef.current;

  if (failed) {
    return (
      <div className="dv-noview">
        <p className="dv-noview-title">Couldn't display this {kind}</p>
        <p className="dv-noview-sub">{file.name}</p>
        <button type="button" className="dv-chip" onClick={() => localFolderApi.openPath(file.path || file.storage_path)}>
          Open in default app
        </button>
      </div>
    );
  }

  return (
    <>
    <div
      ref={stageRef}
      className={`dv-media-stage${kind === 'video' ? ' is-floating' : ''}`}
      onMouseMove={kind === 'video' ? bumpControls : undefined}
      onMouseLeave={kind === 'video' && playing ? () => setControlsShown(false) : undefined}
      onMouseDown={onStageMouseDown}
      style={{
        cursor: armed ? undefined
          : kind === 'video' && playing && !controlsShown ? 'none'
          : zoom > 1 ? 'grab'
          : undefined,
      }}
    >
      {kind === 'video' ? (
        <video
          ref={mediaRef}
          className="dv-media-el"
          src={url}
          // CORS-mode load (the localfile handler sends ACAO) — without it
          // drawing the frame to the OCR canvas taints it and export throws.
          crossOrigin="anonymous"
          preload="metadata"
          onPlay={() => { setPlaying(true); disarm(); bumpControls(); }}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={() => setCurrentTime(mediaRef.current?.currentTime || 0)}
          onDurationChange={() => setDuration(mediaRef.current?.duration || 0)}
          onVolumeChange={() => { const v = mediaRef.current; if (v) { setMuted(v.muted); setVolume(v.volume); } }}
          onError={() => setFailed(true)}
          style={{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})`, transition: isDragging ? 'none' : 'transform 120ms ease' }}
        />
      ) : (
        <img
          ref={mediaRef} className="dv-media-el" src={url} alt={file.name}
          crossOrigin="anonymous" onError={() => setFailed(true)}
          style={{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})`, transition: isDragging ? 'none' : 'transform 120ms ease' }}
        />
      )}

      {frameSnapOverlay && (
        <img
          className="dv-frame-snap"
          src={frameSnapOverlay.url}
          alt=""
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: frameSnapOverlay.left,
            top: frameSnapOverlay.top,
            width: frameSnapOverlay.width,
            height: frameSnapOverlay.height,
            objectFit: 'fill',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        />
      )}

      {armed && (
        <div
          className="dv-ocr-overlay"
          style={tool === 'square' ? { cursor: 'crosshair' } : undefined}
          onMouseMove={onOverlayMouseMove}
          onMouseLeave={() => { if (!drag) setCursorPos(null); }}
          onWheel={onOverlayWheel}
          onMouseDown={onOverlayMouseDown}
        >
          {/* SVG layer: scrim (dark overlay with selection punched out),
              clipPath defs, and shape outlines. */}
          <svg className="dv-ocr-lasso" aria-hidden="true">
            <defs>
              {/* Scrim mask — white everywhere except inside the active
                  selection (black = hole → image shows at full brightness). */}
              <mask id={`${clipBase}-m`}>
                <rect width="100%" height="100%" fill="white" />
                {previewShape && shapeElements(previewShape, undefined, { fill: 'black' })}
                {selection && working && shapeElements(selection, undefined, { fill: 'black' })}
              </mask>
              {previewShape && (
                <clipPath id={`${clipBase}-p`} clipPathUnits="userSpaceOnUse">
                  {shapeElements(previewShape)}
                </clipPath>
              )}
              {selection && working && (
                <clipPath id={`${clipBase}-s`} clipPathUnits="userSpaceOnUse">
                  {shapeElements(selection)}
                </clipPath>
              )}
            </defs>
            {/* Dark scrim, cut out around the active selection. */}
            <rect className="dv-ocr-lasso-scrim" width="100%" height="100%" mask={`url(#${clipBase}-m)`} />
            {/* Outline for rect / lasso-path shapes; union (highlight brush)
                and the lasso cursor dot rely on fills only. */}
            {previewShape && previewShape.kind !== 'union' && previewShape.kind !== 'circle' && shapeElements(previewShape, 'dv-ocr-lasso-outline')}
          </svg>
          {/* Flat accent-tint fill clipped to the live preview shape. */}
          {previewShape && (
            <div className="dv-ocr-livefill" style={{ clipPath: `url("#${clipBase}-p")` }} />
          )}
          {/* Apple-Intelligence-style animated gradient while OCR runs. */}
          {selection && working && (
            <div className="dv-ocr-loading" style={{ clipPath: `url("#${clipBase}-s")` }} />
          )}
        </div>
      )}

      {/* "Locate selection" highlight — clicking a snippet thumbnail dims the
          media and spotlights where that snippet was read from. Non-interactive
          (pointer-events: none) so pan/zoom keep working; dismissed via Esc, a
          plain stage click, or re-clicking the thumbnail. */}
      {highlightShape && !armed && (
        <div className="dv-ocr-highlight">
          <svg className="dv-ocr-lasso" aria-hidden="true">
            <defs>
              <mask id={`${clipBase}-hl`}>
                <rect width="100%" height="100%" fill="white" />
                {shapeElements(highlightShape, undefined, { fill: 'black' })}
              </mask>
              {/* One uniform accent fill clipped to the selection — every
                  shape kind renders like the Highlight brush (flat tint, no
                  outline/glow), so located selections match highlight mode. */}
              <clipPath id={`${clipBase}-hlc`} clipPathUnits="userSpaceOnUse">
                {shapeElements(highlightShape)}
              </clipPath>
            </defs>
            <rect className="dv-ocr-lasso-scrim dv-ocr-highlight-scrim" width="100%" height="100%" mask={`url(#${clipBase}-hl)`} />
            <rect className="dv-ocr-highlight-union" width="100%" height="100%" clipPath={`url(#${clipBase}-hlc)`} />
          </svg>
        </div>
      )}

      {seekLoading && (
        <div className="dv-seek-loading" aria-hidden="true">
          <div className="dv-seek-loading-dots">
            <span /><span /><span />
          </div>
        </div>
      )}

      {/* Zoom controls — floating pill top-right, always visible. */}
      <div className="dv-zoom-controls">
        <button type="button" className="dv-zoom-btn" onClick={zoomOut} aria-label="Zoom out">−</button>
        <Tooltip content="Reset zoom"><button type="button" className="dv-zoom-pct" onClick={zoomReset}>{Math.round(zoom * 100)}%</button></Tooltip>
        <button type="button" className="dv-zoom-btn" onClick={zoomIn} aria-label="Zoom in">+</button>
      </div>

      {/* Selection-tool pill — top-centre over the media, Extract Tool style
          (replaces the old sidebar tool row + footer "Extract text" button).
          Only while the Extract-text side tab is active. Clicking a tool arms
          it; clicking the armed tool again cancels the selection mode. */}
      {rightTab === 'extract' && (
        <div className="dv-tool-pill-wrap">
          <div className="dv-tool-pill" onMouseDown={(e) => e.stopPropagation()}>
            {OCR_TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`dv-tool-pill-btn${armed && tool === t.id ? ' is-active' : ''}`}
                aria-pressed={armed && tool === t.id}
                onClick={() => { if (armed && tool === t.id) disarm(); else pickTool(t.id); }}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
            <span className="dv-tool-pill-sep" />
            <span className="dv-tool-pill-hint">
              {armed ? 'Drag over the text to read it' : 'Pick a tool to extract text'}
            </span>
          </div>
        </div>
      )}

      {/* Custom video player — auto-hiding controls bar. */}
      {kind === 'video' && playbackFlash && (
        <div
          key={playbackFlash.seq}
          className="dv-playback-flash"
          aria-hidden="true"
          onAnimationEnd={() => setPlaybackFlash(null)}
        >
          <div className="dv-playback-flash-circle">
            {playbackFlash.type === 'play' ? PlayGlyph : PauseGlyph}
          </div>
        </div>
      )}

      {kind === 'video' && (
        <>
          {/* Snap targets — shown while dragging the caption. Corners +
              edge-centres + middle; the engaged one lights up. */}
          {draggingCaption && snapAnchors && (
            <div className="dv-caption-snaps" aria-hidden="true">
              {snapAnchors.map((a) => (
                <span
                  key={a.id}
                  className={`dv-caption-snap${activeSnap === a.id ? ' is-active' : ''}`}
                  style={{ left: `${a.xPct}%`, top: `${a.yPct}%` }}
                />
              ))}
            </div>
          )}
          {/* Live AI caption — the active transcript line as a subtitle.
              Drag it anywhere over the video (YouTube-style); it snaps to the
              edges/corners and aligns its text to match. The spot is remembered
              globally and stays clear of the timeline. */}
          {captionSettings.enabled && activeCaption && (
            <Tooltip content="Drag to reposition">
            <div
              ref={captionRef}
              className={`dv-video-caption${draggingCaption ? ' is-dragging' : ''}${armed ? ' is-locked' : ''}`}
              style={{
                left: `${captionSettings.x}%`,
                top: `${captionSettings.y}%`,
                // Pin the edge that matches the alignment (left edge / centre /
                // right edge) so x is that edge's position.
                transform: `translate(${captionSettings.align === 'left' ? '0%' : captionSettings.align === 'right' ? '-100%' : '-50%'}, -50%)`,
                textAlign: captionSettings.align,
              }}
              onMouseDown={onCaptionMouseDown}
            >
              {activeCaption}
            </div>
            </Tooltip>
          )}
          <div className={`dv-player${!playing || controlsShown ? ' is-visible' : ''}`}>
            <div className="dv-player-scrim" />
            <div className="dv-player-controls">
              <MediaScope
                mediaRef={mediaRef}
                url={url}
                currentTime={currentTime}
                duration={duration}
                playing={playing}
                onSeek={seekTo}
                className="dv-player-scope"
                label="Seek through video"
              />
              <div className="dv-player-row">
                <button type="button" className="dv-player-btn" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
                  {playing ? PauseGlyph : PlayGlyph}
                </button>
                <span className="dv-player-time">{formatVideoTime(currentTime)} / {formatVideoTime(duration)}</span>
                <div className="dv-player-spacer" />
                <div className="dv-player-vol-wrap">
                  <button type="button" className="dv-player-btn" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
                    {muted || volume === 0 ? VolumeMuteGlyph : VolumeHighGlyph}
                  </button>
                  <input
                    type="range"
                    className="dv-player-vol"
                    min="0" max="1" step="0.01"
                    value={muted ? 0 : volume}
                    onChange={(e) => setVol(parseFloat(e.target.value))}
                    style={{ '--pct': `${(muted ? 0 : volume) * 100}%` }}
                    aria-label="Volume"
                  />
                </div>
                {captions?.state === 'done' && (
                  <button
                    type="button"
                    className={`dv-player-btn dv-player-cc${captionSettings.enabled ? ' is-active' : ''}`}
                    onClick={toggleCaptions}
                    aria-label={captionSettings.enabled ? 'Hide captions' : 'Show captions'}
                    aria-pressed={captionSettings.enabled}
                  >
                    {CaptionsGlyph}
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Top-left stage tools — re-centre button. (The Extract-text pill +
          tool dropdown moved into the sidebar's Extract-text tab; arming
          happens via the Multitool footer button.) */}
      {/* Center — only rendered when the media is actually panned away, i.e.
          when re-centring would do something. */}
      {(panX !== 0 || panY !== 0) && (
        <div className="dv-stage-tools">
          <button type="button" className="dv-center-btn" onClick={recenter}>
            {CenterGlyph}
            <span>Center</span>
          </button>
        </div>
      )}

      {/* (The old armed-only "Selection mode" pill was replaced by the
          always-visible tool pill above — it shows the armed tool itself.) */}

      {/* Error pill — replaces the old bottom-of-stage status modal. */}
      {errorMsg && (
        <div className="dv-ocr-error" role="alert">
          <span>{errorMsg}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setErrorMsg(null)}>×</button>
        </div>
      )}
    </div>

    {(() => {
    const sidePanel = (
    <aside className={`dv-ocr-history${sidePanelSlot ? ' dv-side-portal' : ''}`} style={sidePanelSlot ? undefined : { width: `${historyWidth}px` }}>
      {/* Tab strip portals into the Multitool topbar when slotted, else inline. */}
      <SidePanelTabs tabs={sideTabsForKind(kind)} active={rightTab} onChange={setRightTab} slot={sideTabsSlot} />
      {rightTab === 'advisor' ? (
        <AdvisorPanel file={file} />
      ) : rightTab === 'metadata' ? (
        <MetadataPanel file={file} />
      ) : rightTab === 'captions' ? (
        <CaptionsPanel file={file} url={url} currentTime={currentTime} onSeek={seekTo} onCaptionsChange={setCaptions} />
      ) : (
      <>
      {/* No footer action — arming/tool choice moved to the floating pill
          over the media stage (shown while this tab is active). */}
      <div className="dv-ocr-history-scroll" ref={historyListRef}>
        {/* Masthead — accent eyebrow + display title + meta (Versions style). */}
        <header className="dv-ocr-history-head">
          <div className="dv-ocr-history-eyebrow">
            <span>Snippets</span>
            <span className="dv-ocr-history-eyebrow-muted">· from this file</span>
          </div>
          <h2 className="dv-ocr-history-title">Extracted text</h2>
          <div className="dv-ocr-history-meta">
            <span className="dv-ocr-history-count">
              {history.length > 0
                ? <><strong>{history.length}</strong> {history.length === 1 ? 'snippet' : 'snippets'}</>
                : 'No snippets yet'}
            </span>
            {history.length > 0 && (
              <button type="button" className="dv-ocr-history-clear" onClick={clearHistory}>Clear all</button>
            )}
          </div>
        </header>
        {/* Selection cards — same shape as the Extract Tool overlay's sidebar
            (numbered badge · thumbnail · text · copy), oldest first so the
            numbers match the order the selections were made. */}
        {history.length === 0 ? null : (
        <div className="dv-ocr-history-list">
          {[...history].reverse().map((entry) => (
            <SnipEntryCard
              key={entry.id}
              entry={entry}
              kind={kind}
              active={highlightId === entry.id}
              onToggle={() => {
                if (highlightId === entry.id) { setHighlightId(null); return; }
                setHighlightId(entry.id);
                focusRegion(entry);
              }}
              onFind={() => {
                setHighlightId(entry.id);
                focusRegion(entry);
              }}
              onDelete={() => removeHistoryEntry(entry.id)}
            />
          ))}
        </div>
      )}
      </div>
      </>
      )}
    </aside>
    );
    return sidePanelSlot
      ? createPortal(sidePanel, sidePanelSlot)
      : (<><div className="dv-ocr-resize" onMouseDown={beginHistoryResize} role="separator" aria-orientation="vertical" aria-label="Resize extracted text panel" />{sidePanel}</>);
    })()}
    </>
  );
}

// ── Audio player pane ────────────────────────────────────────────────
// Full-pane player for .mp3 / .wav / .ogg / etc opened from the Files page:
// play/pause + volume, with the file's loudness "decibel line" along the
// bottom doubling as the seek scrubber.

// "Decibel line": a loudness envelope decoded from the file (RMS per
// 1/AUDIO_SCOPE_HZ second, peak-normalised to 0..1). It's drawn full-width as a
// static waveform with a playhead, and click/drag on it seeks. We decode the
// envelope rather than tap the <audio> element through a MediaElementSource
// because routing a cross-origin localfile:// element through Web Audio outputs
// silence — it would mute playback. Cached per src so re-opens are instant.
const AUDIO_SCOPE_HZ = 120;
const envelopeCache = new Map();
let scopeDecodeCtx = null;
async function computeEnvelope(src, hz) {
  const key = `${src}:${hz}`;
  if (envelopeCache.has(key)) return envelopeCache.get(key);
  // Persistent cache: paints instantly on reopen instead of re-decoding.
  const stored = loadEnvelope(key);
  if (stored) { envelopeCache.set(key, stored); return stored; }
  try {
    const res = await fetch(src);
    const buf = await res.arrayBuffer();
    if (!scopeDecodeCtx) scopeDecodeCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const audio = await scopeDecodeCtx.decodeAudioData(buf);
    const ch = audio.getChannelData(0);
    const total = Math.max(1, Math.round(audio.duration * hz));
    const per = Math.max(1, Math.floor(ch.length / total));
    const env = new Float32Array(total);
    let peak = 0;
    for (let i = 0; i < total; i += 1) {
      const start = i * per;
      const end = Math.min(ch.length, start + per);
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += ch[j] * ch[j];
      const rms = Math.sqrt(sum / Math.max(1, end - start));
      env[i] = rms;
      if (rms > peak) peak = rms;
    }
    if (peak > 0) for (let i = 0; i < total; i += 1) env[i] = Math.min(1, env[i] / peak);
    envelopeCache.set(key, env);
    saveEnvelope(key, env);
    return env;
  } catch {
    return null;
  }
}

// Resizable captions panel bounds (mirrors the OCR "Extracted text" panel).
// The side panel is the same across every file type, so the audio captions
// aside shares the media panel's width bounds + default exactly.
const CAPTIONS_MIN_WIDTH = HISTORY_MIN_WIDTH;
const CAPTIONS_MAX_WIDTH = HISTORY_MAX_WIDTH;
const CAPTIONS_DEFAULT_WIDTH = HISTORY_DEFAULT_WIDTH;

// Rebuild a done-state captions object from the per-file cache, or null.
function captionsFromCache(path) {
  const c = loadCaptions(path);
  return c
    ? { state: 'done', text: c.text, segments: c.segments || [], language: c.language || null, createdAt: c.createdAt, original: c.original || null }
    : null;
}

// Pencil / check glyphs for the per-caption edit toggle.
const CaptionEditGlyph = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);
const CaptionDoneGlyph = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

// Clock mm:ss for caption timestamps.
function fmtClock(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

// Auto-growing textarea for correcting a caption line — sizes to its content so
// long lines wrap without an inner scrollbar.
function CaptionEditor({ value, onChange, ariaLabel, onCommit, onCancel }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  // Autofocus with the caret at the end when the editor mounts.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <textarea
      ref={ref}
      className="dv-caption-edit"
      value={value}
      rows={1}
      aria-label={ariaLabel}
      placeholder="(no speech — type to add)"
      onChange={(e) => onChange(e.target.value)}
      /* Enter applies (Shift+Enter still inserts a newline); Esc cancels. */
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onCommit?.(); }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel?.(); }
      }}
    />
  );
}

// Shared AI-captions transcript panel — used by the audio player aside AND the
// video pane's "AI captions" tab. Owns its own transcription state + per-file
// cache; `currentTime`/`onSeek` come from whichever media element is playing.
// Renders the `.dv-ocr-history-*` chrome (same as the OCR "Extracted text"
// panel). `onCaptionsChange` (optional) lets a parent mirror the transcript —
// the audio pane uses it to drive its now-playing karaoke lyrics.
function CaptionsPanel({ file, url, currentTime, onSeek, onCaptionsChange }) {
  const { notify } = useNotifications();
  const [captions, setCaptions] = useState(() => captionsFromCache(file.storage_path));
  const [copied, setCopied] = useState(false);
  // Index of the caption currently being edited inline (null = none) — each
  // row carries its own edit button on the right.
  const [editingIdx, setEditingIdx] = useState(null);
  // The segment's text as it was when editing began — Esc restores it.
  const editStartTextRef = useRef('');
  const listRef = useRef(null);

  useEffect(() => {
    setCaptions(captionsFromCache(file.storage_path));
    setCopied(false);
    setEditingIdx(null);
  }, [url, file.storage_path]);

  // Mirror the transcript out to any parent that wants it (audio-pane lyrics).
  useEffect(() => { onCaptionsChange?.(captions); }, [captions, onCaptionsChange]);

  const generate = useCallback(async () => {
    setCaptions({ state: 'working' });
    try {
      const result = await transcribeAudio(url, file.mime_type, file.name);
      const createdAt = Date.now();
      // Keep the untouched AI transcript alongside — "Revert to original"
      // restores it after manual edits.
      const original = { text: result.text, segments: result.segments };
      // Cache the transcript per file so reopening it never re-spends tokens.
      saveCaptions(file.storage_path, {
        text: result.text, segments: result.segments, language: result.language, createdAt, original,
      });
      setCaptions({ state: 'done', text: result.text, segments: result.segments, language: result.language, createdAt, original });
      notify({
        category: 'file',
        variant: 'success',
        icon: 'sparkles',
        title: 'Captions generated',
        body: `AI transcript created for “${file.name}”.`,
        silent: true,
        payload: { activity: { action: 'captions', fileName: file.name, filePath: file.storage_path } },
      });
    } catch (e) {
      setCaptions({ state: 'error', message: String(e?.message || e) });
    }
  }, [url, file.mime_type, file.name, file.storage_path, notify]);

  const regenerate = useCallback(() => {
    clearCaptions(file.storage_path);
    setCopied(false);
    generate();
  }, [file.storage_path, generate]);

  const copyTranscript = async () => {
    if (captions?.state !== 'done') return;
    try {
      await navigator.clipboard.writeText(captions.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  // ── Manual edits (correct the AI's transcription) ───────────────────
  // Persist on every change so an edit survives reopening the file, just like a
  // freshly generated transcript. The onCaptionsChange effect mirrors edits to
  // the now-playing lyrics.
  const persistCaptions = useCallback((next) => {
    setCaptions(next);
    if (next?.state === 'done') {
      saveCaptions(file.storage_path, {
        text: next.text, segments: next.segments, language: next.language, createdAt: next.createdAt,
        original: next.original || null,
      });
    }
  }, [file.storage_path]);

  const editSegment = (i, value) => {
    if (captions?.state !== 'done') return;
    // Transcripts cached before originals existed: snapshot the pre-edit
    // state as the original on the first edit.
    const original = captions.original || { text: captions.text, segments: captions.segments };
    const segments = captions.segments.map((s, idx) => (idx === i ? { ...s, text: value } : s));
    const text = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
    persistCaptions({ ...captions, original, segments, text });
  };

  // True once the transcript differs from the AI's untouched original.
  const isEdited = useMemo(() => (
    captions?.state === 'done' && !!captions.original
    && JSON.stringify(captions.segments) !== JSON.stringify(captions.original.segments)
  ), [captions]);

  const revertToOriginal = () => {
    if (captions?.state !== 'done' || !captions.original) return;
    setEditingIdx(null);
    persistCaptions({
      ...captions,
      text: captions.original.text,
      segments: captions.original.segments,
    });
  };

  // Active caption line follows playback; auto-scrolled into view.
  const activeSegIndex = useMemo(() => {
    if (captions?.state !== 'done') return -1;
    return captions.segments.findIndex((s) => currentTime >= s.start && currentTime < s.end);
  }, [captions, currentTime]);

  useEffect(() => {
    if (activeSegIndex < 0) return;
    const line = listRef.current?.children?.[activeSegIndex];
    line?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeSegIndex]);

  return (
    <>
    <div className="dv-ocr-history-scroll">
      <header className="dv-ocr-history-head">
        <div className="dv-ocr-history-eyebrow">
          <span>Transcript</span>
          <span className="dv-ocr-history-eyebrow-muted">· from this file</span>
        </div>
        <h2 className="dv-ocr-history-title">AI captions</h2>
        <div className="dv-ocr-history-meta">
          <span className="dv-ocr-history-count">
            {captions?.state === 'done'
              ? (captions.segments.length > 0
                  ? <><strong>{captions.segments.length}</strong> {captions.segments.length === 1 ? 'line' : 'lines'}{captions.language ? ` · ${captions.language}` : ''}</>
                  : 'Transcript ready')
              : 'Not generated yet'}
          </span>
          {isEdited && (
            <button type="button" className="dv-ocr-history-clear" onClick={revertToOriginal}>
              Revert to original
            </button>
          )}
        </div>
      </header>

      {!captions ? (
        <div className="dv-audio-captions-empty">
          <p className="dv-ocr-history-empty">
            Transcribe the audio in this file with AI — use <strong>Generate captions</strong> in the footer below. The result is saved to this file, so reopening it won’t spend tokens again.
          </p>
        </div>
      ) : captions.state === 'working' ? (
        <div className="dv-audio-captions-status">
          <span className="dv-audio-captions-spinner" />
          Transcribing…
        </div>
      ) : captions.state === 'error' ? (
        <div className="dv-audio-captions-status is-error">
          <span>{captions.message}</span>
          <button type="button" className="dv-chip" onClick={generate}>Try again</button>
        </div>
      ) : captions.segments.length > 0 ? (
        <div className="dv-ocr-history-list" ref={listRef}>
          {captions.segments.map((seg, i) => (
            editingIdx === i ? (
              <div
                key={i}
                className={`dv-ocr-history-item dv-audio-caption-row is-editing${i === activeSegIndex ? ' is-active' : ''}`}
              >
                <span className="dv-ocr-history-node" />
                <div className="dv-ocr-history-rail">
                  <div className="dv-ocr-history-date">
                    <Tooltip content="Jump to this moment">
                      <button
                        type="button"
                        className="dv-ocr-history-date-d dv-caption-seek"
                        onClick={() => onSeek(seg.start)}
                      >
                        {fmtClock(seg.start)}
                      </button>
                    </Tooltip>
                  </div>
                </div>
                <div className="dv-ocr-history-content">
                  <CaptionEditor
                    value={seg.text}
                    onChange={(v) => editSegment(i, v)}
                    ariaLabel={`Caption at ${fmtClock(seg.start)}`}
                    /* Enter applies the edit (it persists live anyway) and
                       closes the editor; Esc restores the pre-edit text. */
                    onCommit={() => setEditingIdx(null)}
                    onCancel={() => { editSegment(i, editStartTextRef.current); setEditingIdx(null); }}
                  />
                </div>
                <Tooltip content="Done editing">
                  <button
                    type="button"
                    className="dv-caption-editbtn is-done"
                    aria-label="Done editing"
                    onClick={() => setEditingIdx(null)}
                  >
                    {CaptionDoneGlyph}
                  </button>
                </Tooltip>
              </div>
            ) : (
              <div
                key={i}
                role="button"
                tabIndex={0}
                className={`dv-ocr-history-item dv-audio-caption-row${i === activeSegIndex ? ' is-active' : ''}`}
                onClick={() => onSeek(seg.start)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSeek(seg.start); }
                }}
              >
                <span className="dv-ocr-history-node" />
                <div className="dv-ocr-history-rail">
                  <div className="dv-ocr-history-date">
                    <span className="dv-ocr-history-date-d">{fmtClock(seg.start)}</span>
                  </div>
                </div>
                <div className="dv-ocr-history-content">
                  <div className="dv-ocr-history-card">
                    <p className={`dv-ocr-history-text${seg.text ? '' : ' is-empty'}`}>{seg.text || ' '}</p>
                  </div>
                </div>
                <Tooltip content="Edit caption">
                  <button
                    type="button"
                    className="dv-caption-editbtn"
                    aria-label="Edit caption"
                    onClick={(e) => {
                      e.stopPropagation();
                      editStartTextRef.current = seg.text ?? '';
                      setEditingIdx(i);
                    }}
                  >
                    {CaptionEditGlyph}
                  </button>
                </Tooltip>
              </div>
            )
          ))}
        </div>
      ) : (
        <p className="dv-ocr-history-empty">{captions.text || 'No speech detected in this file.'}</p>
      )}
    </div>
    {/* "Generate captions" lives in the shared Multitool footer. */}
    <MultitoolFooter>
      <div className="dv-doc-extract-bar">
        <button
          type="button"
          className="dv-doc-extract-btn"
          onClick={captions?.state === 'done' ? regenerate : generate}
          disabled={captions?.state === 'working'}
        >
          {CaptionsGlyph}
          <span>{captions?.state === 'working' ? 'Transcribing…' : captions?.state === 'done' ? 'Regenerate captions' : 'Generate captions'}</span>
        </button>
      </div>
    </MultitoolFooter>
    </>
  );
}

// ── Shared loudness "decibel line" scrubber ──────────────────────────
// The video overlay renders this to match the audio pane's seek line: it
// decodes the media's loudness envelope (computeEnvelope demuxes the audio
// track of audio AND video URLs alike), paints it across the canvas as a
// mirrored waveform with the played portion in accent + a glowing playhead, and
// doubles as a seek control (click / drag / arrow keys). The parent owns the
// <audio>/<video> element and playback state; MediaScope only visualises and
// seeks via onSeek. Colours come from CSS — `color` is the played/playhead
// accent, `--text-muted` the unplayed base — so each host (.dv-audio-scope /
// .dv-player-scope) themes it. Mirrors AudioPlayerPane's inline scope.
// Seek-knob radius: resting size, and the expanded size on hover / scrubbing.
const KNOB_MIN = 4.5;
const KNOB_MAX = 8;

function MediaScope({ mediaRef, url, currentTime, duration, playing, onSeek, className = '', label = 'Seek' }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const envRef = useRef(null);   // Float32Array loudness envelope | null
  const ampCacheRef = useRef({ env: null, w: 0, amp: null }); // per-column peaks
  const draggingRef = useRef(false);
  const hoveringRef = useRef(false);
  // YouTube-style seek knob that grows on hover / while scrubbing. The radius is
  // eased on its own rAF (knobAnimRef) so it animates even while paused.
  const knobRRef = useRef(KNOB_MIN);
  const expandRef = useRef(false);
  const knobAnimRef = useRef(0);
  const playingRef = useRef(playing);
  const [envReady, setEnvReady] = useState(false);
  useEffect(() => { playingRef.current = playing; }, [playing]);

  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${mm}:${String(ss).padStart(2, '0')}`;
  };

  // Decode the loudness envelope the waveform reads from.
  useEffect(() => {
    envRef.current = null;
    ampCacheRef.current = { env: null, w: 0, amp: null };
    setEnvReady(false);
    if (!url) return undefined;
    let cancelled = false;
    computeEnvelope(url, AUDIO_SCOPE_HZ).then((env) => {
      if (cancelled) return;
      envRef.current = env;
      setEnvReady(true);
    });
    return () => { cancelled = true; };
  }, [url]);

  const effectiveDuration = () => {
    const m = mediaRef.current;
    if (m && Number.isFinite(m.duration) && m.duration > 0) return m.duration;
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  };

  const drawScope = useCallback((overrideRatio) => {
    const canvas = canvasRef.current;
    const ctx2d = canvas?.getContext('2d');
    if (!canvas || !ctx2d) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 1;
    const hgt = canvas.clientHeight || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, hgt);

    const cs = getComputedStyle(canvas);
    const accent = cs.color || '#888';
    const baseCol = (cs.getPropertyValue('--text-muted') || '').trim() || accent;

    const env = envRef.current;
    const media = mediaRef.current;
    const dur2 = (media && Number.isFinite(media.duration) && media.duration > 0)
      ? media.duration
      : (Number.isFinite(duration) && duration > 0 ? duration : 0);
    let ratio;
    if (overrideRatio != null) ratio = Math.min(1, Math.max(0, overrideRatio));
    else if (media && dur2) ratio = Math.min(1, Math.max(0, (media.currentTime || 0) / dur2));
    else ratio = 0;
    const playheadX = ratio * w;

    const mid = hgt / 2;
    const maxAmp = hgt / 2 - 4;
    const cols = Math.max(2, Math.round(w));

    let amp = ampCacheRef.current.amp;
    if (!amp || ampCacheRef.current.env !== env || ampCacheRef.current.w !== w) {
      amp = new Array(cols + 1);
      for (let c = 0; c <= cols; c += 1) {
        if (!env || env.length === 0) { amp[c] = 0.03; continue; }
        const a0 = Math.floor((c / cols) * env.length);
        const a1 = Math.max(a0 + 1, Math.floor(((c + 1) / cols) * env.length));
        let peak = 0;
        for (let k = a0; k < a1 && k < env.length; k += 1) if (env[k] > peak) peak = env[k];
        amp[c] = Math.max(0.03, peak);
      }
      ampCacheRef.current = { env, w, amp };
    }

    const buildPath = () => {
      ctx2d.beginPath();
      for (let c = 0; c <= cols; c += 1) ctx2d.lineTo((c / cols) * w, mid - amp[c] * maxAmp);
      for (let c = cols; c >= 0; c -= 1) ctx2d.lineTo((c / cols) * w, mid + amp[c] * maxAmp);
      ctx2d.closePath();
    };

    buildPath();
    ctx2d.fillStyle = baseCol;
    ctx2d.globalAlpha = 0.3;
    ctx2d.fill();

    if (playheadX > 0) {
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.rect(0, 0, playheadX, hgt);
      ctx2d.clip();
      buildPath();
      ctx2d.fillStyle = accent;
      ctx2d.globalAlpha = 0.9;
      ctx2d.fill();
      ctx2d.restore();
    }
    ctx2d.globalAlpha = 1;

    if (dur2) {
      // Playhead line — no glow (flat accent line marking the current time).
      ctx2d.strokeStyle = accent;
      ctx2d.lineWidth = 2;
      ctx2d.lineCap = 'round';
      ctx2d.shadowBlur = 0;
      ctx2d.beginPath();
      ctx2d.moveTo(playheadX, 5);
      ctx2d.lineTo(playheadX, hgt - 5);
      ctx2d.stroke();
      // Playhead knob — grows on hover / scrub (radius eased in knobRRef), with
      // a soft glow once enlarged.
      const knobR = knobRRef.current;
      ctx2d.fillStyle = accent;
      ctx2d.shadowColor = accent;
      ctx2d.shadowBlur = knobR > KNOB_MIN + 0.4 ? 10 : 0;
      ctx2d.beginPath();
      ctx2d.arc(playheadX, mid, knobR, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.shadowBlur = 0;
    }
  }, [duration, playing, mediaRef]);

  // Ease the knob radius toward its target on its own rAF — repaints itself
  // while paused; the play loop already repaints each frame while playing.
  const animateKnob = useCallback(() => {
    cancelAnimationFrame(knobAnimRef.current);
    const step = () => {
      const target = expandRef.current ? KNOB_MAX : KNOB_MIN;
      const cur = knobRRef.current;
      const next = cur + (target - cur) * 0.3;
      knobRRef.current = Math.abs(target - next) < 0.15 ? target : next;
      if (!playingRef.current) drawScope();
      if (knobRRef.current !== target) knobAnimRef.current = requestAnimationFrame(step);
    };
    knobAnimRef.current = requestAnimationFrame(step);
  }, [drawScope]);
  const setKnobExpanded = useCallback((on) => {
    if (expandRef.current === on) return;
    expandRef.current = on;
    animateKnob();
  }, [animateKnob]);

  const ratioFromClientX = (clientX) => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };
  const seekToRatio = (ratio) => {
    const d = effectiveDuration();
    if (!d) return;
    onSeek?.(ratio * d);
    drawScope(ratio); // immediate feedback even while paused
  };
  const onPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    canvasRef.current?.focus();
    draggingRef.current = true;
    setKnobExpanded(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    seekToRatio(ratioFromClientX(e.clientX));
  };
  const onPointerMove = (e) => {
    if (!draggingRef.current) return;
    seekToRatio(ratioFromClientX(e.clientX));
  };
  const endDrag = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    // Stay big only if the pointer is still hovering the scrubber.
    setKnobExpanded(hoveringRef.current);
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* unsupported */ }
  };
  const onPointerEnter = () => { hoveringRef.current = true; setKnobExpanded(true); };
  const onPointerLeave = () => { hoveringRef.current = false; if (!draggingRef.current) setKnobExpanded(false); };
  const onKeyDown = (e) => {
    const d = effectiveDuration();
    if (!d) return;
    const m = mediaRef.current;
    let t = m ? (m.currentTime || 0) : currentTime;
    if (e.key === 'ArrowRight') t = Math.min(d, t + 5);
    else if (e.key === 'ArrowLeft') t = Math.max(0, t - 5);
    else if (e.key === 'Home') t = 0;
    else if (e.key === 'End') t = d;
    else return;
    e.preventDefault();
    onSeek?.(t);
    drawScope(t / d);
  };

  // rAF loop while playing.
  useEffect(() => {
    if (!playing) return undefined;
    const tick = () => { drawScope(); rafRef.current = requestAnimationFrame(tick); };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, drawScope]);

  // Resting repaint on source / envelope / time / size change (the rAF loop
  // owns the canvas while playing).
  useEffect(() => {
    if (playing) return undefined;
    const id = requestAnimationFrame(() => drawScope());
    return () => cancelAnimationFrame(id);
  }, [url, envReady, currentTime, duration, playing, drawScope]);

  // Repaint when the canvas is resized (e.g. window / pane resize).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { if (!playing) drawScope(); });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [playing, drawScope]);

  useEffect(() => () => { cancelAnimationFrame(rafRef.current); cancelAnimationFrame(knobAnimRef.current); }, []);

  return (
    <Tooltip content="Click or drag to seek">
    <canvas
      ref={canvasRef}
      className={`dv-scope ${className}`.trim()}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Number.isFinite(duration) ? Math.round(duration) : 0}
      aria-valuenow={Math.round(currentTime)}
      aria-valuetext={`${fmt(currentTime)} of ${fmt(duration)}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    />
    </Tooltip>
  );
}

function AudioPlayerPane({ file, url, sidePanelSlot = null, sideTabsSlot = null }) {
  const audioRef = useRef(null);
  const scopeCanvasRef = useRef(null);
  const scopeRafRef = useRef(0);
  const lyricsRef = useRef(null); // karaoke lyric list (auto-scroll target)
  const envRef = useRef(null);   // Float32Array loudness envelope | null
  const ampCacheRef = useRef({ env: null, w: 0, amp: null }); // per-column peaks (recomputed on env/width change)
  const scopeDraggingRef = useRef(false); // pointer-drag scrubbing on the decibel line
  const [envReady, setEnvReady] = useState(false); // re-renders the resting waveform once decoded
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  // YouTube-style play/pause flash — mirrors the video pane: `seq` remounts
  // the element so the animation restarts on rapid toggles.
  const [playbackFlash, setPlaybackFlash] = useState(null);
  const flashSeqRef = useRef(0);
  const [dur, setDur] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [captionsWidth, setCaptionsWidth] = useState(CAPTIONS_DEFAULT_WIDTH);
  // Shared side-panel tabs — audio supports AI captions, not text extraction.
  const [rightTab, setRightTab] = useState('captions');
  // Transcript mirrored from the side CaptionsPanel — drives the now-playing
  // karaoke lyrics over the controls. null until generated.
  const [lyrics, setLyrics] = useState(() => captionsFromCache(file.storage_path));

  useEffect(() => {
    setFailed(false);
    setPlaying(false);
    setCur(0);
    setDur(0);
    setLyrics(captionsFromCache(file.storage_path));
    cancelAnimationFrame(scopeRafRef.current);
    scopeRafRef.current = 0;
  }, [url, file.storage_path]);

  // Decode the loudness envelope that the "decibel line" waveform reads from.
  useEffect(() => {
    envRef.current = null;
    ampCacheRef.current = { env: null, w: 0, amp: null };
    setEnvReady(false);
    if (!url) return undefined;
    let cancelled = false;
    computeEnvelope(url, AUDIO_SCOPE_HZ).then((env) => {
      if (cancelled) return;
      envRef.current = env;
      setEnvReady(true);
    });
    return () => { cancelled = true; };
  }, [url]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    flashSeqRef.current += 1;
    if (a.paused) {
      a.play().catch(() => {});
      setPlaybackFlash({ type: 'play', seq: flashSeqRef.current });
    } else {
      a.pause();
      setPlaybackFlash({ type: 'pause', seq: flashSeqRef.current });
    }
  };
  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${mm}:${String(ss).padStart(2, '0')}`;
  };
  const toggleMute = () => {
    const a = audioRef.current;
    if (!a) return;
    a.muted = !a.muted;
    setMuted(a.muted);
  };
  const changeVolume = (e) => {
    const v = Number(e.target.value);
    setVolume(v);
    setMuted(v === 0);
    const a = audioRef.current;
    if (a) { a.muted = false; a.volume = v; }
  };
  const seekTo = (t) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = t;
    setCur(t);
  };

  // ── Decibel-line seeking ────────────────────────────────────────────
  // The loudness waveform doubles as a scrubber: click/drag anywhere to jump
  // to that point in the file (x position → time), with arrow-key fine control.
  const effectiveDuration = () => {
    const a = audioRef.current;
    if (a && Number.isFinite(a.duration) && a.duration > 0) return a.duration;
    return Number.isFinite(dur) && dur > 0 ? dur : 0;
  };
  const ratioFromClientX = (clientX) => {
    const canvas = scopeCanvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };
  const scopeSeekToRatio = (ratio) => {
    const duration = effectiveDuration();
    if (!duration) return;
    const t = ratio * duration;
    const a = audioRef.current;
    if (a) a.currentTime = t;
    setCur(t);
    drawScope(ratio); // immediate feedback even while paused
  };
  const onScopePointerDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    scopeCanvasRef.current?.focus();
    scopeDraggingRef.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    scopeSeekToRatio(ratioFromClientX(e.clientX));
  };
  const onScopePointerMove = (e) => {
    if (!scopeDraggingRef.current) return;
    scopeSeekToRatio(ratioFromClientX(e.clientX));
  };
  const endScopeDrag = (e) => {
    if (!scopeDraggingRef.current) return;
    scopeDraggingRef.current = false;
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* unsupported */ }
  };
  const onScopeKeyDown = (e) => {
    const duration = effectiveDuration();
    if (!duration) return;
    const a = audioRef.current;
    let t = a ? (a.currentTime || 0) : cur;
    if (e.key === 'ArrowRight') t = Math.min(duration, t + 5);
    else if (e.key === 'ArrowLeft') t = Math.max(0, t - 5);
    else if (e.key === 'Home') t = 0;
    else if (e.key === 'End') t = duration;
    else return;
    e.preventDefault();
    if (a) a.currentTime = t;
    setCur(t);
    drawScope(t / duration);
  };

  // Drag handle resizing the captions panel (raw clientX deltas, 1:1).
  const beginCaptionsResize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = captionsWidth;
    document.body.classList.add('dv-ocr-resizing');
    const onMove = (ev) => {
      const delta = startX - ev.clientX;
      setCaptionsWidth(Math.min(CAPTIONS_MAX_WIDTH, Math.max(CAPTIONS_MIN_WIDTH, startW + delta)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('dv-ocr-resizing');
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── "Decibel line" waveform + scrubber ──────────────────────────────
  // Renders the whole file's loudness envelope as a static mirrored waveform
  // across the canvas width, with the played portion in accent and a playhead
  // marker at the current time. Doubles as a seek control (see the pointer/key
  // handlers above). `overrideRatio` lets the scrubber paint the new position
  // instantly while paused, before state/audio catch up.
  const drawScope = useCallback((overrideRatio) => {
    const canvas = scopeCanvasRef.current;
    const ctx2d = canvas?.getContext('2d');
    if (!canvas || !ctx2d) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 1;
    const hgt = canvas.clientHeight || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, hgt);

    const cs = getComputedStyle(canvas);
    const accent = cs.color || '#888';
    const baseCol = (cs.getPropertyValue('--text-muted') || '').trim() || accent;

    const env = envRef.current;
    const audio = audioRef.current;
    const duration = (audio && Number.isFinite(audio.duration) && audio.duration > 0)
      ? audio.duration
      : (Number.isFinite(dur) && dur > 0 ? dur : 0);
    let ratio;
    if (overrideRatio != null) ratio = Math.min(1, Math.max(0, overrideRatio));
    else if (audio && duration) ratio = Math.min(1, Math.max(0, (audio.currentTime || 0) / duration));
    else ratio = 0;
    const playheadX = ratio * w;

    const mid = hgt / 2;
    const maxAmp = hgt / 2 - 4;
    const cols = Math.max(2, Math.round(w));

    // Per-column peak over the envelope range each pixel covers. Cached so a
    // playing track (60 fps) doesn't re-scan the whole envelope every frame —
    // only env identity or a width change invalidates it.
    let amp = ampCacheRef.current.amp;
    if (!amp || ampCacheRef.current.env !== env || ampCacheRef.current.w !== w) {
      amp = new Array(cols + 1);
      for (let c = 0; c <= cols; c += 1) {
        if (!env || env.length === 0) { amp[c] = 0.03; continue; }
        const a0 = Math.floor((c / cols) * env.length);
        const a1 = Math.max(a0 + 1, Math.floor(((c + 1) / cols) * env.length));
        let peak = 0;
        for (let k = a0; k < a1 && k < env.length; k += 1) if (env[k] > peak) peak = env[k];
        amp[c] = Math.max(0.03, peak); // floor so silence still draws a hairline
      }
      ampCacheRef.current = { env, w, amp };
    }

    const buildPath = () => {
      ctx2d.beginPath();
      for (let c = 0; c <= cols; c += 1) ctx2d.lineTo((c / cols) * w, mid - amp[c] * maxAmp);
      for (let c = cols; c >= 0; c -= 1) ctx2d.lineTo((c / cols) * w, mid + amp[c] * maxAmp);
      ctx2d.closePath();
    };

    // Full waveform (unplayed) in a muted tone.
    buildPath();
    ctx2d.fillStyle = baseCol;
    ctx2d.globalAlpha = 0.3;
    ctx2d.fill();

    // Played portion in accent, clipped to the left of the playhead.
    if (playheadX > 0) {
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.rect(0, 0, playheadX, hgt);
      ctx2d.clip();
      buildPath();
      ctx2d.fillStyle = accent;
      ctx2d.globalAlpha = 0.9;
      ctx2d.fill();
      ctx2d.restore();
    }
    ctx2d.globalAlpha = 1;

    // Playhead line + knob (glows while playing).
    if (duration) {
      ctx2d.strokeStyle = accent;
      ctx2d.lineWidth = 2;
      ctx2d.lineCap = 'round';
      ctx2d.shadowColor = accent;
      ctx2d.shadowBlur = playing ? 12 : 0;
      ctx2d.beginPath();
      ctx2d.moveTo(playheadX, 5);
      ctx2d.lineTo(playheadX, hgt - 5);
      ctx2d.stroke();
      ctx2d.shadowBlur = 0;
      ctx2d.fillStyle = accent;
      ctx2d.beginPath();
      ctx2d.arc(playheadX, mid, 4.5, 0, Math.PI * 2);
      ctx2d.fill();
    }
  }, [dur, playing]);

  const startScope = useCallback(() => {
    cancelAnimationFrame(scopeRafRef.current);
    const tick = () => {
      drawScope();
      scopeRafRef.current = requestAnimationFrame(tick);
    };
    scopeRafRef.current = requestAnimationFrame(tick);
  }, [drawScope]);

  const stopScope = useCallback(() => {
    cancelAnimationFrame(scopeRafRef.current);
    scopeRafRef.current = 0;
    drawScope(); // final paint at the paused position
  }, [drawScope]);

  // Repaint the resting waveform on track change / seek / resize / envelope
  // arrival. Skipped while playing — the rAF loop owns the canvas then.
  useEffect(() => {
    if (playing) return undefined;
    const id = requestAnimationFrame(() => drawScope());
    return () => cancelAnimationFrame(id);
  }, [url, envReady, cur, dur, captionsWidth, playing, drawScope]);

  useEffect(() => () => cancelAnimationFrame(scopeRafRef.current), []);

  // ── Now-playing karaoke lyrics ──────────────────────────────────────
  const hasLyrics = lyrics?.state === 'done' && lyrics.segments.length > 0;
  const activeLyricIndex = useMemo(() => {
    if (!hasLyrics) return -1;
    return lyrics.segments.findIndex((s) => cur >= s.start && cur < s.end);
  }, [hasLyrics, lyrics, cur]);

  // Keep the active line pinned to the pane's vertical centre as playback
  // advances (mirrors the YT-Music lyrics view) — the other lines scroll around
  // it. Rect math (vs scrollIntoView) so it lands dead-centre regardless of the
  // mask / padding.
  useEffect(() => {
    if (activeLyricIndex < 0) return;
    const container = lyricsRef.current;
    const el = container?.children?.[activeLyricIndex];
    if (!container || !el) return;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const delta = (eRect.top + eRect.height / 2) - (cRect.top + cRect.height / 2);
    container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' });
  }, [activeLyricIndex]);

  if (failed) {
    return (
      <div className="dv-noview">
        <p className="dv-noview-title">Couldn't play this audio file</p>
        <p className="dv-noview-sub">{file.name}</p>
        <button type="button" className="dv-chip" onClick={() => localFolderApi.openPath(file.storage_path)}>
          Open in default app
        </button>
      </div>
    );
  }

  return (
    <div className="dv-audio-layout">
      <div
        className={`dv-audio-pane${hasLyrics ? ' has-lyrics' : ''}`}
        /* Clicking the pane background toggles play/pause (like the video
           stage); clicks on the lyrics, controls or scrubber are theirs. */
        onClick={(e) => {
          if (e.target.closest('button, input, canvas, a')) return;
          toggle();
        }}
      >
        {/* Play/pause flash — the video pane's pop circle, centred here. */}
        {playbackFlash && (
          <div
            key={playbackFlash.seq}
            className="dv-audio-flash"
            aria-hidden="true"
            onAnimationEnd={() => setPlaybackFlash(null)}
          >
            <div className="dv-playback-flash-circle">
              {playbackFlash.type === 'play' ? PlayGlyph : PauseGlyph}
            </div>
          </div>
        )}
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => { setPlaying(true); startScope(); }}
          onPause={() => { setPlaying(false); stopScope(); }}
          onEnded={() => { setPlaying(false); setCur(0); stopScope(); }}
          onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => { setDur(e.currentTarget.duration); e.currentTarget.volume = volume; }}
          onDurationChange={(e) => setDur(e.currentTarget.duration)}
          onError={() => setFailed(true)}
        />
        {hasLyrics && (
          <div className="dv-audio-lyrics" ref={lyricsRef}>
            {/* Display-only karaoke lines — no seek-on-click, no tooltip.
                (Seeking lives on the scrubber and the captions side panel.) */}
            {lyrics.segments.map((seg, i) => (
              <div
                key={i}
                className={`dv-lyric-line${seg.text ? '' : ' is-empty'}${i === activeLyricIndex ? ' is-active' : ''}${i < activeLyricIndex ? ' is-past' : ''}`}
              >
                {seg.text || '♪'}
              </div>
            ))}
          </div>
        )}
        {/* Bottom deck — same layout as the video player (.dv-player-controls):
            the waveform scrubber ON TOP, the controls row (play/pause + time +
            spacer + mute/volume) underneath, docked at the pane's bottom. */}
        <div className="dv-audio-deck">
          <Tooltip content="Click or drag to seek">
            <canvas
              ref={scopeCanvasRef}
              className="dv-audio-scope"
              role="slider"
              tabIndex={0}
              aria-label="Seek through audio"
              aria-valuemin={0}
              aria-valuemax={Number.isFinite(dur) ? Math.round(dur) : 0}
              aria-valuenow={Math.round(cur)}
              aria-valuetext={`${fmt(cur)} of ${fmt(dur)}`}
              onPointerDown={onScopePointerDown}
              onPointerMove={onScopePointerMove}
              onPointerUp={endScopeDrag}
              onPointerCancel={endScopeDrag}
              onKeyDown={onScopeKeyDown}
            />
          </Tooltip>
          <div className="dv-audio-controls">
            <button type="button" className="dv-player-btn" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? PauseGlyph : PlayGlyph}
            </button>
            <span className="dv-player-time">{fmt(cur)} / {fmt(dur)}</span>
            <div className="dv-player-spacer" />
            <div className="dv-player-vol-wrap">
              <button type="button" className="dv-player-btn" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
                {muted || volume === 0 ? VolumeMuteGlyph : VolumeHighGlyph}
              </button>
              <input
                type="range"
                className="dv-player-vol"
                min="0" max="1" step="0.01"
                value={muted ? 0 : volume}
                onChange={changeVolume}
                style={{ '--pct': `${(muted ? 0 : volume) * 100}%` }}
                aria-label="Volume"
              />
            </div>
          </div>
        </div>
      </div>

      {(() => {
      const sidePanel = (
      <aside className={`dv-ocr-history dv-audio-captions-aside${sidePanelSlot ? ' dv-side-portal' : ''}`} style={sidePanelSlot ? undefined : { width: `${captionsWidth}px` }}>
        {/* Audio gets AI captions + AI advisor (no text extraction). */}
        <SidePanelTabs tabs={sideTabsForKind('audio')} active={rightTab} onChange={setRightTab} slot={sideTabsSlot} />
        {rightTab === 'advisor' ? (
          <AdvisorPanel file={file} />
        ) : rightTab === 'metadata' ? (
          <MetadataPanel file={file} />
        ) : rightTab === 'extract' ? (
          <div className="dv-ocr-history-scroll"><p className="dv-ocr-history-empty">Text extraction isn’t available for audio files.</p></div>
        ) : (
          <CaptionsPanel file={file} url={url} currentTime={cur} onSeek={seekTo} onCaptionsChange={setLyrics} />
        )}
      </aside>
      );
      return sidePanelSlot
        ? createPortal(sidePanel, sidePanelSlot)
        : (<><div className="dv-ocr-resize" onMouseDown={beginCaptionsResize} role="separator" aria-orientation="vertical" aria-label="Resize captions panel" />{sidePanel}</>);
      })()}
    </div>
  );
}

// Excel-style column label for a 0-based index (0 → A, 25 → Z, 26 → AA…).
function colLabel(n) {
  let s = '';
  let i = n + 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

// Cap on rendered rows — a huge sheet would otherwise build a multi-thousand-row
// DOM table and stall the viewer. The rest stays in the file (open externally).
const SHEET_MAX_ROWS = 2000;

// Spreadsheet pane — renders .xlsx / .xls / .csv as a styled, scrollable table
// with sticky A/B/C column headers + 1/2/3 row numbers (and a tab strip when the
// workbook has multiple sheets). SheetJS is lazy-imported so its weight isn't
// paid until a spreadsheet is opened (mirrors docx-preview for .docx).
function SpreadsheetPane({ file, url, onExportPdf }) {
  const [state, setState] = useState({ status: 'loading', sheets: [], error: null });
  const [active, setActive] = useState(0);
  const tableRef = useRef(null);

  useEffect(() => {
    setState({ status: 'loading', sheets: [], error: null });
    setActive(0);
    if (!url) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const buf = await (await fetch(url)).arrayBuffer();
        const XLSX = await import('xlsx');
        if (cancelled) return;
        const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
        const sheets = wb.SheetNames.map((name) => {
          // header:1 → rows of cell arrays; raw:false → number/date formats applied.
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '', raw: false });
          return { name, rows };
        });
        setState({ status: sheets.length ? 'ready' : 'empty', sheets, error: null });
      } catch (e) {
        if (!cancelled) setState({ status: 'error', sheets: [], error: String(e?.message || e) });
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  if (state.status === 'loading') return <div className="dv-loading">Reading spreadsheet…</div>;
  if (state.status === 'error') {
    return (
      <div className="dv-noview">
        <p className="dv-noview-title">Couldn't read this spreadsheet</p>
        <p className="dv-noview-sub">{file.name}</p>
        <button type="button" className="dv-chip" onClick={() => localFolderApi.openPath(file.storage_path)}>
          Open in default app
        </button>
      </div>
    );
  }
  if (state.status === 'empty') {
    return (
      <div className="dv-noview">
        <p className="dv-noview-title">This spreadsheet is empty</p>
        <p className="dv-noview-sub">{file.name}</p>
      </div>
    );
  }

  const sheet = state.sheets[active] || state.sheets[0];
  const allRows = sheet.rows;
  const rows = allRows.slice(0, SHEET_MAX_ROWS);
  const truncated = allRows.length - rows.length;
  const colCount = rows.reduce((mx, r) => Math.max(mx, r.length), 0);
  const cols = Array.from({ length: colCount });

  return (
    <div className="dv-sheet">
      {(state.sheets.length > 1 || onExportPdf) && (
        <div className="dv-sheet-bar">
          {state.sheets.length > 1 ? (
            <div className="dv-sheet-tabs" role="tablist">
              {state.sheets.map((s, i) => (
                <button
                  key={`${s.name}-${i}`}
                  type="button"
                  role="tab"
                  className={`dv-sheet-tab${i === active ? ' is-active' : ''}`}
                  aria-selected={i === active}
                  onClick={() => setActive(i)}
                >
                  {s.name || `Sheet ${i + 1}`}
                </button>
              ))}
            </div>
          ) : <span className="dv-sheet-bar-spacer" />}
          <ReconPill />
          {onExportPdf && <ExportPdfButton getRoot={() => tableRef.current} kind="xlsx" onExport={onExportPdf} />}
        </div>
      )}
      <div className="dv-sheet-scroll">
        <table className="dv-sheet-table" ref={tableRef}>
          <thead>
            <tr>
              <th className="dv-sheet-corner" />
              {cols.map((_, c) => <th key={c} className="dv-sheet-colhead">{colLabel(c)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                <th className="dv-sheet-rowhead">{r + 1}</th>
                {cols.map((_, c) => {
                  const v = row[c];
                  return <td key={c}>{v == null ? '' : String(v)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated > 0 && (
        <div className="dv-sheet-note">
          Showing the first {SHEET_MAX_ROWS.toLocaleString()} rows of {allRows.length.toLocaleString()} — open the file in its app to see the rest.
        </div>
      )}
    </div>
  );
}

// Shared right-hand panel for document file types (PDF / Word / Excel / text /
// legacy .doc / other). Same chrome as the photo/video OCR panel, but instead
// of a lasso it offers a one-click whole-document text extraction
// (lib/extractFileText, or the main-process parser for legacy .doc) saved into
// the SAME per-file history store — so every file type has a consistent panel.
function DocExtractPanel({ file, url, kind, width, fill = false, sideTabsSlot = null }) {
  const { notify } = useNotifications();
  const [history, setHistory] = useState(() => loadOcrHistory(file.storage_path));
  const [working, setWorking] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  // Documents only get the AI advisor (text extraction is images/video only).
  const [rightTab, setRightTab] = useState('advisor');

  useEffect(() => { setHistory(loadOcrHistory(file.storage_path)); }, [file.storage_path]);
  useEffect(() => { saveOcrHistory(file.storage_path, history); }, [file.storage_path, history]);

  const extractable = kind !== 'other';

  const runExtract = useCallback(async () => {
    setWorking(true);
    setErrorMsg(null);
    try {
      let text = '';
      if (kind === 'doc') {
        const res = await extractDocText(file.storage_path);
        if (res?.error) throw new Error(res.error === 'unsupported' ? 'This file type can’t be read as text.' : res.error);
        text = res?.text || '';
      } else {
        const blob = await (await fetch(url)).blob();
        const res = await extractFileText(blob, file.name);
        if (res?.error) {
          throw new Error(res.error === 'unsupported'
            ? 'This file type can’t be read as text.'
            : res.error === 'empty' ? 'No readable text found in this file.' : res.error);
        }
        text = res.text || '';
      }
      if (!text.trim()) { setErrorMsg('No readable text found in this file.'); return; }
      const entry = { id: `doc-${Date.now()}-${Math.round(Math.random() * 1e6)}`, text: text.trim(), createdAt: Date.now() };
      setHistory((h) => [entry, ...h]);
      notify({
        category: 'file',
        variant: 'success',
        icon: 'sparkles',
        title: 'Text extracted',
        body: `New extract from “${file.name}”.`,
        silent: true,
        payload: { activity: { action: 'extract-text', fileName: file.name, filePath: file.storage_path } },
      });
    } catch (e) {
      setErrorMsg(String(e?.message || e));
    } finally {
      setWorking(false);
    }
  }, [kind, url, file.name, file.storage_path, notify]);

  const copyEntry = async (entry) => {
    try {
      await navigator.clipboard.writeText(entry.text || '');
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId((c) => (c === entry.id ? null : c)), 1500);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <aside className={`dv-ocr-history dv-doc-extract${fill ? ' dv-side-portal' : ''}`} style={fill ? undefined : { width: `${width}px` }}>
      {/* Documents get two panes: the Generate (AI) advisor and Metadata.
          Text extraction lives in the Multitool footer, not a tab. */}
      <SidePanelTabs tabs={['advisor', 'metadata']} active={rightTab} onChange={setRightTab} slot={sideTabsSlot} />
      {rightTab === 'metadata' ? <MetadataPanel file={file} /> : <AdvisorPanel file={file} />}
      {false && (
      <>
      {/* "Extract text" lives in the shared Multitool footer. */}
      <MultitoolFooter>
        <div className="dv-doc-extract-bar">
          <button type="button" className="dv-doc-extract-btn" onClick={runExtract} disabled={working || !extractable}>
            {ScanTextGlyph}
            <span>{working ? 'Extracting…' : 'Extract text'}</span>
          </button>
        </div>
      </MultitoolFooter>
      {errorMsg && (
        <div className="dv-ocr-error dv-doc-extract-error" role="alert">
          <span>{errorMsg}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setErrorMsg(null)}>×</button>
        </div>
      )}
      <div className="dv-ocr-history-scroll">
        <header className="dv-ocr-history-head">
          <div className="dv-ocr-history-eyebrow">
            <span>Snippets</span>
            <span className="dv-ocr-history-eyebrow-muted">· from this file</span>
          </div>
          <h2 className="dv-ocr-history-title">Extracted text</h2>
          <div className="dv-ocr-history-meta">
            <span className="dv-ocr-history-count">
              {history.length > 0
                ? <><strong>{history.length}</strong> {history.length === 1 ? 'snippet' : 'snippets'}</>
                : 'No snippets yet'}
            </span>
            {history.length > 0 && (
              <button type="button" className="dv-ocr-history-clear" onClick={() => setHistory([])}>Clear all</button>
            )}
          </div>
        </header>
        {history.length === 0 ? (
          <p className="dv-ocr-history-empty">
            {extractable
              ? 'Click “Extract text” to read this document’s text. It’s saved here for next time you open the file.'
              : 'This file type can’t be read as text.'}
          </p>
        ) : (
          <div className="dv-ocr-history-list">
            {[...history].reverse().map((entry) => {
              const { date, time } = formatHistoryTimestamp(entry.createdAt);
              return (
                <div key={entry.id} className="dv-ocr-history-item">
                  <div className="dv-ocr-history-rail">
                    <span className="dv-ocr-history-node" />
                    <div className="dv-ocr-history-date">
                      <span className="dv-ocr-history-date-d">{date}</span>
                      <span className="dv-ocr-history-date-t">{time}</span>
                    </div>
                  </div>
                  <div className="dv-ocr-history-content">
                    <div className="dv-ocr-history-card">
                      <p className={`dv-ocr-history-text${entry.text ? '' : ' is-empty'}`}>
                        {entry.text || 'No text found.'}
                      </p>
                      <div className="dv-ocr-history-actions">
                        {entry.text && (
                          <button type="button" className="dv-ocr-history-act" onClick={() => copyEntry(entry)}>
                            {copiedId === entry.id ? 'Copied' : 'Copy'}
                          </button>
                        )}
                        <button type="button" className="dv-ocr-history-remove" aria-label="Remove" onClick={() => setHistory((prev) => prev.filter((e) => e.id !== entry.id))}>×</button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </>
      )}
    </aside>
  );
}

// Lays out a document preview. Its side panel (just the AI advisor for plain
// documents — extraction/captions are media-only) portals into the right card.
function DocumentWithPanel({ file, url, kind, mainClass = '', sidePanelSlot = null, sideTabsSlot = null, children }) {
  return (
    <>
      <div className={`dv-doc-main ${mainClass}`.trim()}>{children}</div>
      {sidePanelSlot && createPortal(
        <DocExtractPanel file={file} url={url} kind={kind} sideTabsSlot={sideTabsSlot} fill />,
        sidePanelSlot,
      )}
    </>
  );
}

// Word-style pagination. docx-preview renders the document as continuous flow
// (one `section.docx` per Word section) and does NOT reflow content onto new
// pages the way Word does — a long document would be one tall sheet. We measure
// the rendered flow and slice it into fixed-size page sheets, each the section's
// real page dimensions, breaking before any block that would overflow the page.
// Returns the natural page width (px) so the caller can fit it to the pane.
function paginateDocx(host) {
  const wrapper = host?.querySelector('.docx-wrapper');
  if (!wrapper) return 0;
  const sections = Array.from(wrapper.querySelectorAll(':scope > section.docx'));
  if (!sections.length) return 0;
  let pageWidth = 0;
  const allPages = []; // every page sheet across all sections, for numbering

  for (const section of sections) {
    const cs = getComputedStyle(section);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const width = section.offsetWidth;
    if (width > pageWidth) pageWidth = width;
    // Page height: docx-preview sets the section's min-height to the page height.
    // Fall back to an A4 ratio of the width if it isn't set.
    let pageH = parseFloat(cs.minHeight);
    if (!pageH || pageH < 200) pageH = Math.round(width * 1.4142);
    const contentH = Math.max(120, pageH - padTop - padBottom);

    // docx-preview nests flow content as `section.docx > article > blocks`
    // (the article carries any column layout). Gather the blocks across all of
    // the section's articles in order, then re-distribute them across pages.
    const articles = Array.from(section.querySelectorAll(':scope > article'));
    if (!articles.length) continue;
    const articleTemplate = articles[0];
    const blocks = [];
    for (const a of articles) for (const c of Array.from(a.children)) blocks.push(c);
    if (!blocks.length) continue;

    // Each page is a shallow clone of the section (keeps its exact width /
    // padding / background / classes so docx-preview's `.docx` rules still
    // apply), locked to one page tall, holding a clone of the article wrapper.
    const makePage = () => {
      const pg = section.cloneNode(false);
      pg.classList.add('dv-docx-page');
      pg.style.minHeight = `${pageH}px`;
      pg.style.height = `${pageH}px`;
      const art = articleTemplate.cloneNode(false);
      pg.appendChild(art);
      return { pg, art };
    };

    const pages = [];
    let cur = makePage();
    let used = 0;
    for (const block of blocks) {
      // Measure BEFORE moving it (still laid out at full page width here).
      const ccs = getComputedStyle(block);
      const mt = parseFloat(ccs.marginTop) || 0;
      const mb = parseFloat(ccs.marginBottom) || 0;
      const h = block.offsetHeight + mt + mb;
      if (used > 0 && used + h > contentH) {
        pages.push(cur);
        cur = makePage();
        used = 0;
      }
      cur.art.appendChild(block); // moves the node out of its original article
      used += h;
    }
    pages.push(cur);
    for (const { pg } of pages) { wrapper.insertBefore(pg, section); allPages.push(pg); }
    section.remove();
  }

  // Stamp each page with its number (toggled visible via the host's
  // `show-pagenums` class). Sits in the bottom margin like a Word footer.
  allPages.forEach((pg, i) => {
    const label = host.ownerDocument.createElement('div');
    label.className = 'dv-docx-pagenum';
    label.textContent = `${i + 1} / ${allPages.length}`;
    pg.appendChild(label);
  });
  return pageWidth;
}

// Renders a .docx with a Render / Plain text toggle (the same two views Claude
// "Convert to PDF" / "Export PDF" — captures the live rendered preview (`getRoot`)
// to a PDF and hands the Blob to `onExport` (which saves it next to the original).
// Shown on every office preview's toolbar. Reports working / done / failed inline.
function ExportPdfButton({ getRoot, kind, onExport, label = 'Convert to PDF' }) {
  const [state, setState] = useState('idle'); // idle | working | done | error
  const run = async () => {
    if (state === 'working') return;
    const root = getRoot?.();
    if (!root) { setState('error'); window.setTimeout(() => setState('idle'), 2200); return; }
    setState('working');
    try {
      const blob = await renderedOfficeToPdfBlob(root, kind);
      await onExport?.(blob);
      setState('done');
      window.setTimeout(() => setState((s) => (s === 'done' ? 'idle' : s)), 2200);
    } catch {
      setState('error');
      window.setTimeout(() => setState((s) => (s === 'error' ? 'idle' : s)), 2600);
    }
  };
  return (
    <Tooltip content="Save this document as a PDF next to the original">
      <button
        type="button"
        className={`dv-pdf-export is-${state}`}
        onClick={run}
        disabled={state === 'working'}
      >
        <span className="dv-pdf-export-dot" aria-hidden="true" />
        {state === 'working' ? 'Converting…' : state === 'done' ? 'Saved PDF ✓' : state === 'error' ? 'Couldn’t convert' : label}
      </button>
    </Tooltip>
  );
}

// Track the current page/slide as the preview scrolls: counts `pageSelector`
// elements inside the scroller and finds which one straddles the viewport middle.
// Returns { current, total }. `deps` re-measures after the pages (re)render.
function usePageScrollCounter(scrollRef, pageSelector, deps = []) {
  const [info, setInfo] = useState({ current: 1, total: 0 });
  const recompute = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const pages = sc.querySelectorAll(pageSelector);
    const total = pages.length;
    if (!total) { setInfo((p) => (p.total === 0 ? p : { current: 1, total: 0 })); return; }
    const midY = sc.getBoundingClientRect().top + sc.clientHeight / 2;
    let current = 1;
    pages.forEach((pg, i) => { if (pg.getBoundingClientRect().top <= midY) current = i + 1; });
    setInfo((p) => (p.current === current && p.total === total ? p : { current, total }));
  }, [scrollRef, pageSelector]);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return undefined;
    recompute();
    sc.addEventListener('scroll', recompute, { passive: true });
    let ro;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(recompute); ro.observe(sc); }
    return () => { sc.removeEventListener('scroll', recompute); ro?.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recompute, ...deps]);
  return info;
}

// In-app pagination chip — pinned to the bottom-right of the preview, black
// background + white text ("3 / 12"). Only shows once there's more than one page.
function PageCounter({ info, show, label = 'pages' }) {
  if (!show || !info || info.total <= 1) return null;
  return (
    <div className="dv-page-counter" role="status" aria-label={`Page ${info.current} of ${info.total}`}>
      {info.current} <span className="dv-page-counter-sep">/</span> {info.total}
      <span className="dv-page-counter-unit">{label}</span>
    </div>
  );
}

// A centered pill noting the preview is an in-app reconstruction (docx-preview /
// our OOXML + SheetJS renderers), so it may differ from the file opened in the
// real Office app. Sits at the top-centre of each office preview toolbar.
function ReconPill() {
  // Render centred in the window title bar (portal into TitleBar's #tb-docview-
  // center slot) when it exists; fall back to inline (web, where there's no
  // custom title bar). Tied to the reconstruction pane, so it auto-hides for
  // non-office files.
  const [slot, setSlot] = useState(null);
  useEffect(() => { setSlot(document.getElementById('tb-docview-center')); }, []);
  const pill = (
    <Tooltip content="This is an in-app reconstruction of the file. It may not look exactly the same as when opened in Word / PowerPoint / Excel.">
      <span className={`dv-recon-pill${slot ? ' dv-recon-pill--titlebar' : ''}`}>
        Reconstruction — may differ from the Office app
      </span>
    </Tooltip>
  );
  return slot ? createPortal(pill, slot) : pill;
}

// Renders a .docx as the formatted final product via docx-preview, re-paginated
// into Word-like page sheets. Toolbar carries the reconstruction notice, a
// per-page page-number toggle, and Convert-to-PDF.
function DocxRenderPane({ url, onExportPdf }) {
  const hostRef = useRef(null);
  const pageWidthRef = useRef(0);
  const [showPageNumbers, setShowPageNumbers] = useState(true);

  // Cursor selection → AI target. When the user highlights text in the rendered
  // document, a small floating button lets them hand that exact passage to the
  // advisor ("change THIS part"). selTip carries the highlighted text + a viewport
  // anchor for the button.
  const adv = useMultitoolAdvisor();
  const canTarget = !!adv?.addSelection;
  const [selTip, setSelTip] = useState(null); // { text, x, y } | null
  useEffect(() => {
    if (!canTarget) return undefined;
    const host = hostRef.current;
    if (!host) return undefined;
    const readSelection = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { setSelTip(null); return; }
      const range = sel.getRangeAt(0);
      if (!host.contains(range.commonAncestorContainer)) { setSelTip(null); return; }
      const text = sel.toString().trim();
      if (text.length < 2) { setSelTip(null); return; }
      const rect = range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) { setSelTip(null); return; }
      setSelTip({ text, x: rect.left + rect.width / 2, y: rect.top });
    };
    // Defer so the browser has finalized the selection before we read it.
    const onUp = () => window.setTimeout(readSelection, 0);
    const onDown = (e) => { if (!e.target.closest?.('.dv-docx-seltip')) setSelTip(null); };
    const onScroll = () => setSelTip(null);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [canTarget]);
  const targetSelection = useCallback(() => {
    if (!selTip) return;
    adv?.addSelection?.(selTip.text);
    setSelTip(null);
    window.getSelection()?.removeAllRanges();
  }, [adv, selTip]);

  // Scale the page stack down to fit the pane width (Word's "fit to width"), so
  // an 8.5"/A4 sheet is readable without horizontal scrolling on a narrow pane.
  const fitWidth = useCallback(() => {
    const host = hostRef.current;
    const wrapper = host?.querySelector('.docx-wrapper');
    if (!host || !wrapper || !pageWidthRef.current) return;
    const avail = host.clientWidth - 44; // wrapper h-padding (36) + breathing room
    if (avail <= 0) return;
    const z = Math.max(0.35, Math.min(1, avail / pageWidthRef.current));
    wrapper.style.zoom = String(z);
  }, []);

  useEffect(() => {
    if (!url) return undefined;
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return undefined;
    pageWidthRef.current = 0;
    (async () => {
      try {
        const blob = await (await fetch(url, { cache: 'no-store' })).blob();
        const { renderAsync } = await import('docx-preview');
        if (cancelled) return;
        host.innerHTML = '';
        // breakPages:false → continuous flow we paginate ourselves (docx-preview's
        // own breakPages only splits on explicit breaks, not on content overflow).
        await renderAsync(blob, host, undefined, {
          className: 'docx', inWrapper: true, breakPages: false,
          ignoreLastRenderedPageBreak: true, experimental: true, useBase64URL: true,
          // We re-paginate the flow ourselves; per-page headers/footers would be
          // dropped with the original section and skew the page-height math, so
          // keep the content area clean (page text area = page minus margins).
          renderHeaders: false, renderFooters: false,
        });
        if (cancelled) return;
        // Wait for fonts so block heights are final before we slice into pages.
        try { await document.fonts.ready; } catch { /* ignore */ }
        if (cancelled) return;
        pageWidthRef.current = paginateDocx(host);
        fitWidth();
      } catch {
        if (!cancelled && host) host.innerHTML = `<p class="dv-docx-error">Couldn't display the document.</p>`;
      }
    })();
    return () => { cancelled = true; };
  }, [url, fitWidth]);

  // Re-fit on pane resize.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => fitWidth());
    ro.observe(host);
    return () => ro.disconnect();
  }, [fitWidth]);

  return (
    <div className="dv-docview">
      <div className="dv-docview-topbar">
        <ReconPill />
      </div>
      <div className="dv-docview-body">
        <div ref={hostRef} className={`dv-docx${showPageNumbers ? ' show-pagenums' : ''}`} />
      </div>
      {/* Floating "hand this passage to the AI" button, anchored above the
          current text selection (viewport-fixed; dismissed on scroll / click). */}
      {selTip && (
        <button
          type="button"
          className="dv-docx-seltip"
          style={{ position: 'fixed', left: `${selTip.x}px`, top: `${selTip.y}px` }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={targetSelection}
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v4M12 3 9 6M12 3l3 3" /><rect x="4" y="9" width="16" height="11" rx="2" /><path d="M8 13h8M8 16.5h5" />
          </svg>
          Edit this with AI
        </button>
      )}
      {/* Page-numbers toggle + Convert-to-PDF docked at the bottom of the pane. */}
      <div className="dv-docview-toolbar dv-docview-toolbar--foot">
        <button
          type="button"
          className={`dv-docview-pgtoggle${showPageNumbers ? ' is-active' : ''}`}
          onClick={() => setShowPageNumbers((v) => !v)}
          aria-pressed={showPageNumbers}
        >
          <span className="dv-pgtoggle-hash" aria-hidden="true">#</span>
          Page numbers
        </button>
        {onExportPdf && (
          <>
            <div className="dv-docview-spacer" />
            <ExportPdfButton getRoot={() => hostRef.current} kind="docx" onExport={onExportPdf} />
          </>
        )}
      </div>
    </div>
  );
}

// ── Faithful .pptx renderer ─────────────────────────────────────────────
// We parse the OOXML zip and reproduce each slide's ACTUAL styling — slide /
// shape fills, text run colours, sizes, weights and fonts, absolute positions,
// and images — rather than re-flowing plain text. This makes the in-app preview
// match the real file (the styled decks the Designer/Instant engines produce).
const EMU_PER_PT = 12700;

const pptxSlideNo = (name) => Number((/slide(\d+)\.xml$/i.exec(name) || [])[1] || 0);
const directChild = (el, tag) => (el ? Array.from(el.children).find((c) => c.nodeName === tag) || null : null);
const emuPct = (v, total) => (total ? (Number(v) / total) * 100 : 0);

// Clamp + hex helpers for colour modifiers (lumMod/lumOff/shade/tint).
const clamp01 = (n) => Math.max(0, Math.min(1, n));
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex([r, g, b]) {
  const c = (n) => Math.round(clamp01(n / 255) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
// Apply the common OOXML colour transforms found on accent variants.
function applyMods(hex, el) {
  let rgb = hexToRgb(hex);
  const get = (tag) => { const m = directChild(el, tag); return m ? Number(m.getAttribute('val')) / 1000 : null; };
  const lumMod = get('a:lumMod'); const lumOff = get('a:lumOff');
  const shade = get('a:shade'); const tint = get('a:tint');
  if (lumMod != null) rgb = rgb.map((c) => c * lumMod);
  if (lumOff != null) rgb = rgb.map((c) => c + lumOff * 255);
  if (shade != null) rgb = rgb.map((c) => c * shade);
  if (tint != null) rgb = rgb.map((c) => c * tint + 255 * (1 - tint));
  return rgbToHex(rgb);
}
const SCHEME_ALIAS = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };
// Resolve a colour-bearing element (<a:srgbClr>/<a:schemeClr>/<a:sysClr>) → hex.
function colorOfNode(node, theme) {
  if (!node) return null;
  const name = node.nodeName;
  if (name === 'a:srgbClr') return applyMods(`#${node.getAttribute('val')}`, node);
  if (name === 'a:sysClr') return `#${node.getAttribute('lastClr') || '000000'}`;
  if (name === 'a:schemeClr') {
    const key = SCHEME_ALIAS[node.getAttribute('val')] || node.getAttribute('val');
    const base = theme[key];
    return base ? applyMods(base, node) : null;
  }
  return null;
}
// First fill colour declared directly on a container (solidFill, or the first
// gradient stop). Returns css colour or null (noFill / inherit).
function fillOf(container, theme) {
  if (!container) return null;
  const solid = directChild(container, 'a:solidFill');
  if (solid) return colorOfNode(solid.firstElementChild, theme);
  const grad = directChild(container, 'a:gradFill');
  if (grad) {
    const gs = grad.getElementsByTagName('a:gs')[0];
    if (gs) return colorOfNode(gs.firstElementChild, theme);
  }
  return null;
}
function bgFillFromXml(xml, theme) {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const bg = doc.getElementsByTagName('p:bg')[0];
    if (!bg) return null;
    const bgPr = directChild(bg, 'p:bgPr');
    return fillOf(bgPr, theme);
  } catch { return null; }
}
function parseThemeColors(xml) {
  const map = {};
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const scheme = doc.getElementsByTagName('a:clrScheme')[0];
    if (scheme) {
      for (const child of Array.from(scheme.children)) {
        const name = child.nodeName.replace(/^a:/, '');
        map[name] = colorOfNode(child.firstElementChild, {}) || null;
      }
    }
  } catch { /* noop */ }
  return map;
}
// Relative luminance → pick a readable default text colour for unstyled runs.
function readableOn(bg) {
  try {
    const [r, g, b] = hexToRgb(bg);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55 ? '#1E293B' : '#F5F2EA';
  } catch { return '#1E293B'; }
}

const MEDIA_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp', emf: 'image/emf', wmf: 'image/wmf' };
// Resolve a slide's _rels into { rId: targetPathWithinZip }.
async function loadRels(zip, slideName) {
  const rels = {};
  const relPath = slideName.replace(/slides\/(slide\d+\.xml)$/i, 'slides/_rels/$1.rels');
  const f = zip.files[relPath];
  if (!f) return { rels, layout: null };
  try {
    const xml = await f.async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    let layout = null;
    for (const r of Array.from(doc.getElementsByTagName('Relationship'))) {
      const id = r.getAttribute('Id');
      const target = r.getAttribute('Target') || '';
      const abs = target.startsWith('/') ? target.slice(1) : `ppt/${target.replace(/^\.\.\//, '')}`;
      rels[id] = abs;
      if ((r.getAttribute('Type') || '').endsWith('/slideLayout')) layout = abs;
    }
    return { rels, layout };
  } catch { return { rels, layout: null }; }
}
// Resolve the background by walking slide → layout → master.
async function resolveBg(zip, slideXml, slideName, theme, cache) {
  const own = bgFillFromXml(slideXml, theme);
  if (own) return own;
  const { layout } = await loadRels(zip, slideName);
  if (layout && zip.files[layout]) {
    const lx = cache[layout] || (cache[layout] = await zip.files[layout].async('string'));
    const lb = bgFillFromXml(lx, theme);
    if (lb) return lb;
    // layout → master
    const lrelPath = layout.replace(/slideLayouts\/(slideLayout\d+\.xml)$/i, 'slideLayouts/_rels/$1.rels');
    if (zip.files[lrelPath]) {
      try {
        const rx = await zip.files[lrelPath].async('string');
        const rdoc = new DOMParser().parseFromString(rx, 'application/xml');
        const masterRel = Array.from(rdoc.getElementsByTagName('Relationship'))
          .find((r) => (r.getAttribute('Type') || '').endsWith('/slideMaster'));
        if (masterRel) {
          const mt = masterRel.getAttribute('Target') || '';
          const mAbs = mt.startsWith('/') ? mt.slice(1) : `ppt/${mt.replace(/^\.\.\//, '')}`;
          if (zip.files[mAbs]) {
            const mx = cache[mAbs] || (cache[mAbs] = await zip.files[mAbs].async('string'));
            const mb = bgFillFromXml(mx, theme);
            if (mb) return mb;
          }
        }
      } catch { /* noop */ }
    }
  }
  return null;
}

// Parse one slide's shapes (text boxes + pictures) with geometry + styling.
function parseSlideShapes(xml, theme, rels, mediaUrls) {
  const out = [];
  let title = '';
  const bullets = [];
  let doc;
  try { doc = new DOMParser().parseFromString(xml, 'application/xml'); } catch { return { shapes: out, title, bullets }; }
  if (doc.getElementsByTagName('parsererror').length) return { shapes: out, title, bullets };
  const tree = doc.getElementsByTagName('p:spTree')[0];
  if (!tree) return { shapes: out, title, bullets };

  const xfrmOf = (spPr) => {
    const xf = spPr && (directChild(spPr, 'a:xfrm'));
    if (!xf) return null;
    const off = directChild(xf, 'a:off'); const ext = directChild(xf, 'a:ext');
    if (!off || !ext) return null;
    return { x: +off.getAttribute('x'), y: +off.getAttribute('y'), w: +ext.getAttribute('cx'), h: +ext.getAttribute('cy') };
  };

  for (const node of Array.from(tree.children)) {
    if (node.nodeName === 'p:sp') {
      const spPr = directChild(node, 'p:spPr');
      const geo = xfrmOf(spPr);
      const fill = fillOf(spPr, theme);
      const txBody = directChild(node, 'p:txBody');
      const ph = node.getElementsByTagName('p:ph')[0];
      const phType = ph ? (ph.getAttribute('type') || '') : '';
      const isTitle = phType === 'title' || phType === 'ctrTitle';
      const bodyPr = txBody ? directChild(txBody, 'a:bodyPr') : null;
      const anchor = bodyPr ? (bodyPr.getAttribute('anchor') || 't') : 't';
      const paras = [];
      if (txBody) {
        for (const p of Array.from(txBody.children)) {
          if (p.nodeName !== 'a:p') continue;
          const pPr = directChild(p, 'a:pPr');
          const algn = pPr ? (pPr.getAttribute('algn') || '') : '';
          const level = pPr ? Number(pPr.getAttribute('lvl') || 0) : 0;
          const buChar = pPr ? directChild(pPr, 'a:buChar') : null;
          const bullet = buChar ? (buChar.getAttribute('char') || '') : '';
          const runs = [];
          let lineText = '';
          for (const r of Array.from(p.children)) {
            if (r.nodeName === 'a:br') { runs.push({ br: true }); continue; }
            if (r.nodeName !== 'a:r') continue;
            const rPr = directChild(r, 'a:rPr');
            const t = directChild(r, 'a:t');
            const text = t ? (t.textContent || '') : '';
            lineText += text;
            const sz = rPr && rPr.getAttribute('sz') ? Number(rPr.getAttribute('sz')) / 100 : null;
            const color = rPr ? fillOf(rPr, theme) : null;
            const latin = rPr ? directChild(rPr, 'a:latin') : null;
            runs.push({
              text,
              szPt: sz,
              bold: rPr ? rPr.getAttribute('b') === '1' : false,
              italic: rPr ? rPr.getAttribute('i') === '1' : false,
              color,
              font: latin ? latin.getAttribute('typeface') : null,
            });
          }
          if (runs.length || bullet) paras.push({ algn, level, bullet, runs });
          if (lineText.trim()) { if (isTitle && !title) title = lineText.trim(); else bullets.push({ text: lineText.trim(), level }); }
        }
      }
      out.push({ type: 'text', geo, fill, anchor, paras, role: isTitle ? 'title' : 'body' });
    } else if (node.nodeName === 'p:pic') {
      const spPr = directChild(node, 'p:spPr');
      const geo = xfrmOf(spPr);
      const blip = node.getElementsByTagName('a:blip')[0];
      const embed = blip ? (blip.getAttribute('r:embed') || blip.getAttribute('embed')) : null;
      const src = embed ? mediaUrls[rels[embed]] : null;
      if (geo) out.push({ type: 'pic', geo, src });
    }
  }
  return { shapes: out, title, bullets };
}

// Renders a .pptx as a vertical stack of true-to-file slide cards, with a
// Slides / Outline toggle. Styling (fills, fonts, colours, layout, images) is
// reproduced from the OOXML; only exotic features (gradients beyond the first
// stop, charts, SmartArt) are approximated.
function PptxRenderPane({ url, onExportPdf }) {
  const [deck, setDeck] = useState(null); // { w, h, slides } | null while loading
  const [mode, setMode] = useState('render');
  const [failed, setFailed] = useState(false);
  const pptxRef = useRef(null);
  const bodyRef = useRef(null);
  const slideInfo = usePageScrollCounter(bodyRef, '.dv-ppx-slide', [deck, mode]);

  useEffect(() => {
    if (!url) return undefined;
    let cancelled = false;
    setDeck(null); setFailed(false);
    (async () => {
      try {
        const buf = await (await fetch(url, { cache: 'no-store' })).arrayBuffer();
        const JSZip = (await import('jszip')).default;
        if (cancelled) return;
        const zip = await JSZip.loadAsync(buf);

        // Slide size (default 16:9 widescreen).
        let w = 12192000; let h = 6858000;
        if (zip.files['ppt/presentation.xml']) {
          const px = await zip.files['ppt/presentation.xml'].async('string');
          const m = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(px);
          if (m) { w = +m[1]; h = +m[2]; }
        }
        // Theme colours (first theme is enough for our decks).
        let theme = {};
        const themeName = Object.keys(zip.files).find((n) => /^ppt\/theme\/theme\d+\.xml$/i.test(n));
        if (themeName) theme = parseThemeColors(await zip.files[themeName].async('string'));

        const names = Object.keys(zip.files)
          .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
          .sort((a, b) => pptxSlideNo(a) - pptxSlideNo(b));

        const bgCache = {};
        const slides = [];
        for (const n of names) {
          /* eslint-disable no-await-in-loop */
          const xml = await zip.files[n].async('string');
          const { rels } = await loadRels(zip, n);
          // Resolve referenced media to data URLs.
          const mediaUrls = {};
          for (const [, target] of Object.entries(rels)) {
            if (!/\.(png|jpe?g|gif|bmp|svg|webp)$/i.test(target) || mediaUrls[target] || !zip.files[target]) continue;
            const ext = target.split('.').pop().toLowerCase();
            const b64 = await zip.files[target].async('base64');
            mediaUrls[target] = `data:${MEDIA_MIME[ext] || 'image/png'};base64,${b64}`;
          }
          const bg = await resolveBg(zip, xml, n, theme, bgCache);
          const { shapes, title, bullets } = parseSlideShapes(xml, theme, rels, mediaUrls);
          slides.push({ bg: bg || '#ffffff', shapes, title, bullets });
          /* eslint-enable no-await-in-loop */
        }
        if (!cancelled) setDeck({ w, h, slides });
      } catch {
        if (!cancelled) { setFailed(true); setDeck({ w: 1, h: 1, slides: [] }); }
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  const plain = useMemo(() => {
    if (!deck) return '';
    return deck.slides.map((s, i) => {
      const head = `Slide ${i + 1}${s.title ? ` — ${s.title}` : ''}`;
      const body = s.bullets.map((b) => `${'  '.repeat(b.level)}• ${b.text}`).join('\n');
      return body ? `${head}\n${body}` : head;
    }).join('\n\n');
  }, [deck]);

  const slideHpt = deck ? deck.h / EMU_PER_PT : 540;
  const renderRun = (run, ri, fg) => {
    if (run.br) return <br key={ri} />;
    const style = {};
    if (run.color || fg) style.color = run.color || fg;
    if (run.szPt) style.fontSize = `${(run.szPt / slideHpt) * 100}cqh`;
    if (run.bold) style.fontWeight = 700;
    if (run.italic) style.fontStyle = 'italic';
    if (run.font) style.fontFamily = `"${run.font}", Georgia, "Segoe UI", sans-serif`;
    return <span key={ri} style={style}>{run.text}</span>;
  };

  return (
    <div className="dv-docview">
      <div className="dv-docview-toolbar">
        <div className="dv-docview-seg" role="group" aria-label="Presentation view mode">
          <button type="button" className={`dv-docview-toggle${mode === 'render' ? ' is-active' : ''}`} onClick={() => setMode('render')} aria-pressed={mode === 'render'}>Slides</button>
          <button type="button" className={`dv-docview-toggle${mode === 'plain' ? ' is-active' : ''}`} onClick={() => setMode('plain')} aria-pressed={mode === 'plain'}>Outline</button>
        </div>
        {mode === 'render' && deck && deck.slides.length > 0 && <ReconPill />}
        {deck && deck.slides.length > 0 && (
          <span className="dv-pptx-count">{deck.slides.length} slide{deck.slides.length === 1 ? '' : 's'}</span>
        )}
        {mode === 'render' && onExportPdf && deck && deck.slides.length > 0 && (
          <>
            <div className="dv-docview-spacer" />
            <ExportPdfButton getRoot={() => pptxRef.current} kind="pptx" onExport={onExportPdf} />
          </>
        )}
      </div>
      <div className="dv-docview-body" ref={bodyRef}>
        {deck === null ? (
          <div className="dv-loading">Reading presentation…</div>
        ) : failed ? (
          <p className="dv-docx-error">Couldn’t read the presentation.</p>
        ) : mode === 'plain' ? (
          <pre className="dv-docview-plain">{plain || 'This presentation is empty.'}</pre>
        ) : deck.slides.length === 0 ? (
          <p className="dv-docx-error">This presentation has no slides.</p>
        ) : (
          <div className="dv-ppx" ref={pptxRef}>
            {deck.slides.map((s, i) => {
              const fg = readableOn(s.bg);
              return (
                <div className="dv-ppx-slide" key={i} style={{ aspectRatio: `${deck.w} / ${deck.h}`, background: s.bg, color: fg }}>
                  {s.shapes.map((sh, k) => {
                    // Explicit geometry when present; otherwise a sensible
                    // fallback box by role (placeholders that inherit their
                    // position from the layout carry no xfrm in the slide XML).
                    let box;
                    if (sh.geo) {
                      box = {
                        left: `${emuPct(sh.geo.x, deck.w)}%`,
                        top: `${emuPct(sh.geo.y, deck.h)}%`,
                        width: `${emuPct(sh.geo.w, deck.w)}%`,
                        height: `${emuPct(sh.geo.h, deck.h)}%`,
                      };
                    } else if (sh.type === 'text') {
                      box = sh.role === 'title'
                        ? { left: '6%', top: '6%', width: '88%', height: '22%' }
                        : { left: '7%', top: '31%', width: '86%', height: '63%' };
                    } else {
                      return null;
                    }
                    if (sh.type === 'pic') {
                      return (
                        <div className="dv-ppx-shape" key={k} style={box}>
                          {sh.src && <img src={sh.src} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
                        </div>
                      );
                    }
                    const justify = sh.anchor === 'ctr' ? 'center' : sh.anchor === 'b' ? 'flex-end' : 'flex-start';
                    return (
                      <div className="dv-ppx-shape dv-ppx-text" key={k} style={{ ...box, background: sh.fill || undefined, justifyContent: justify }}>
                        {sh.paras.map((p, pi) => (
                          <p
                            key={pi}
                            className="dv-ppx-p"
                            style={{ textAlign: p.algn === 'ctr' ? 'center' : p.algn === 'r' ? 'right' : p.algn === 'just' ? 'justify' : 'left', paddingLeft: p.bullet ? `${1 + p.level}em` : undefined, textIndent: p.bullet ? '-1em' : undefined }}
                          >
                            {p.bullet && <span className="dv-ppx-bu" style={{ color: fg }}>{p.bullet} </span>}
                            {p.runs.map((r, ri) => renderRun(r, ri, fg))}
                          </p>
                        ))}
                      </div>
                    );
                  })}
                  <span className="dv-ppx-num" aria-hidden="true">{i + 1}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <PageCounter info={slideInfo} show={mode === 'render'} label="slides" />
    </div>
  );
}

function DocPane({ file, onWhatsAppDetected, sidePanelSlot = null, sideTabsSlot = null, regenTick = 0 }) {
  const { notify } = useNotifications();
  const { kind, mime } = useMemo(() => classify(file.mime, file.name), [file.mime, file.name]);
  // Every pane (image/video OCR, audio player, PDF/text/docx preview) reads
  // this one URL. Electron: the streaming localfile:// scheme. Web: no such
  // scheme — connect the folder backend for this tab, read the bytes from
  // the (OPFS) handle, and hand out an object URL instead.
  const electronUrl = useMemo(() => (isElectron ? localUrlFor(file.path) : null), [file.path]);
  const { selectedProjectId } = useSelectedProject();
  const [webUrl, setWebUrl] = useState(null);
  useEffect(() => {
    if (isElectron || !selectedProjectId) return undefined;
    let objectUrl = null;
    let cancelled = false;
    (async () => {
      try {
        await ensureWebFolder(selectedProjectId);
        const blob = await readLocalBlob(file.path);
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setWebUrl(objectUrl);
      } catch { /* url stays null — panes render their no-preview state */ }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.path, selectedProjectId]);
  const url = isElectron ? electronUrl : webUrl;
  // While a saved version is being written to disk, show a spinner over the
  // preview (the chat stays calm — no thinking bubble there).
  const switchingVersion = !!useMultitoolAdvisor()?.switching;
  // Folder holding this file — a WhatsApp export's media siblings live here.
  const { dir, sep } = useMemo(() => dirAndSep(file.path), [file.path]);
  // Legacy .doc extracted text: null = loading, string = body, '' = empty.
  const [docText, setDocText] = useState(null);
  const [docErr, setDocErr] = useState(null);

  const previewFile = useMemo(
    () => ({ name: file.name, mime_type: mime, storage_path: file.path, size_bytes: 0 }),
    [file.name, mime, file.path],
  );

  // "Convert to PDF" — write the captured PDF next to the original (report.docx →
  // report.pdf), overwriting a prior export. Throws on failure so the button can
  // surface it. The new file shows up via notifyFilesChanged.
  const exportPdfNextTo = useCallback(async (blob) => {
    const base = String(file.name || 'document').replace(/\.[^./\\]+$/, '');
    const target = `${base}.pdf`;
    const wr = await localFolderApi.writeFiles({ dir, files: [{ filename: target, blob }] });
    if (wr?.error || !wr?.results?.[0]?.ok) throw new Error(wr?.error || wr?.results?.[0]?.error || 'write_failed');
    notifyFilesChanged();
    notify({
      category: 'file',
      variant: 'success',
      icon: 'file',
      title: 'PDF exported',
      body: `“${target}” written next to the original.`,
      silent: true,
      payload: { activity: { action: 'export-pdf', fileName: target, filePath: `${dir}${sep}${target}` } },
    });
  }, [file.name, dir, sep, notify]);

  // Extract text from a legacy .doc (binary parsed in the main process).
  useEffect(() => {
    if (kind !== 'doc') return undefined;
    let cancelled = false;
    setDocText(null);
    setDocErr(null);
    extractDocText(file.path)
      .then((res) => { if (!cancelled) { if (res?.error) setDocErr(res.error); else setDocText(res?.text || ''); } })
      .catch((e) => { if (!cancelled) setDocErr(String(e?.message || e)); });
    return () => { cancelled = true; };
  }, [kind, file.path]);

  // image/video keep their integrated OCR pane; audio keeps its captions pane.
  // Every OTHER type renders inside the shared split (preview + Extract-text
  // panel) so the right panel is consistent and present for all file types.
  const isMedia = kind === 'image' || kind === 'video';
  const isAudio = kind === 'audio';
  const isSplit = !isMedia && !isAudio;

  const bodyClass = isMedia ? 'dv-doc-body is-media'
    : isAudio ? 'dv-doc-body is-audio'
    : 'dv-doc-body is-split';

  // Flush (fills, no padding) for the panes that manage their own scroll;
  // padded block for the document renderers (matches the old body padding).
  const mainClass = kind === 'text' || kind === 'sheet' ? 'is-flush' : '';

  let content;
  if (kind === 'docx') {
    content = <DocxRenderPane url={url} onExportPdf={exportPdfNextTo} />;
  } else if (kind === 'pptx') {
    content = <PptxRenderPane url={url} onExportPdf={exportPdfNextTo} />;
  } else if (kind === 'doc') {
    content = (docErr || docText === '') ? (
      <div className="dv-noview">
        <p className="dv-noview-title">{docErr ? "Couldn't read the .doc document" : 'The document has no text'}</p>
        <p className="dv-noview-sub">{file.name}</p>
        <button type="button" className="dv-chip" onClick={() => localFolderApi.openPath(file.path)}>Open in default app</button>
      </div>
    ) : docText === null ? (
      <div className="dv-loading">Reading document…</div>
    ) : (
      <div className="dv-text-doc">
        {docText.split(/\n/).map((line, i) => <p key={i}>{line || ' '}</p>)}
      </div>
    );
  } else if (kind === 'sheet') {
    content = <SpreadsheetPane file={previewFile} url={url} onExportPdf={exportPdfNextTo} />;
  } else if (kind === 'text') {
    content = <DocTextPane file={previewFile} url={url} dir={dir} sep={sep} onWhatsAppDetected={onWhatsAppDetected} />;
  } else if (kind === 'other') {
    content = (
      <div className="dv-noview">
        <p className="dv-noview-title">This file type can't be previewed</p>
        <p className="dv-noview-sub">{file.name}</p>
        <button type="button" className="dv-chip" onClick={() => localFolderApi.openPath(file.path)}>Open in default app</button>
      </div>
    );
  } else {
    content = <FilePreview file={previewFile} signedUrl={url} onOpen={null} />;
  }

  // Re-key ONLY the preview by regenTick so saving a new version re-reads the
  // file from disk (the localfile:// url is stable, so the preview must remount
  // to refetch) — without remounting the side panel / chat, which would refresh
  // and jump it. The advisor (in DocumentWithPanel's side slot) stays put.
  if (content) content = React.cloneElement(content, { key: `pv-${regenTick}` });

  return (
    <div className={bodyClass}>
      {switchingVersion && (
        <div className="dv-preview-loading" role="status" aria-label="Loading version">
          <span className="dv-preview-spinner" aria-hidden="true" />
        </div>
      )}
      {isMedia ? (
        <MediaOcrPane file={{ ...previewFile, path: file.path }} url={url} kind={kind} sidePanelSlot={sidePanelSlot} sideTabsSlot={sideTabsSlot} />
      ) : isAudio ? (
        <AudioPlayerPane file={previewFile} url={url} sidePanelSlot={sidePanelSlot} sideTabsSlot={sideTabsSlot} />
      ) : (
        <DocumentWithPanel file={previewFile} url={url} kind={kind} mainClass={mainClass} sidePanelSlot={sidePanelSlot} sideTabsSlot={sideTabsSlot}>
          {content}
        </DocumentWithPanel>
      )}
    </div>
  );
}

// Custom vertical scrollbar for the tabs sidebar — lives OUTSIDE the scroll
// view (a sibling overlaid in the right gutter) so the native bar can be
// hidden. Tracks the scroller's metrics and drives scrollTop on drag / track
// click. `refreshKey` recomputes the thumb when the tab list changes height.
function SidebarScrollbar({ scrollRef, refreshKey }) {
  const [thumb, setThumb] = useState(null); // { top, height } in %, or null when no overflow

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight + 1) { setThumb(null); return; }
    setThumb({
      top: (scrollTop / scrollHeight) * 100,
      height: (clientHeight / scrollHeight) * 100,
    });
  }, [scrollRef]);

  useLayoutEffect(() => { recompute(); }, [recompute, refreshKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    el.addEventListener('scroll', recompute, { passive: true });
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(recompute);
      ro.observe(el);
      // Also watch the content child so the thumb updates when the scrollHeight
      // grows (e.g. chat "Show earlier") — observing only `el` misses that, since
      // the scroller's own box size doesn't change.
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    }
    return () => { el.removeEventListener('scroll', recompute); ro?.disconnect(); };
  }, [recompute, scrollRef]);

  // Drag the thumb → scroll proportionally (thumb travel maps to scroll range).
  const onThumbDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = scrollRef.current;
    const track = e.currentTarget.parentElement;
    if (!el || !track) return;
    const startY = e.clientY;
    const startScroll = el.scrollTop;
    const trackH = track.clientHeight;
    const thumbH = (el.clientHeight / el.scrollHeight) * trackH;
    const maxTravel = Math.max(1, trackH - thumbH);
    const maxScroll = el.scrollHeight - el.clientHeight;
    const ratio = maxScroll / maxTravel;
    const onMove = (ev) => { el.scrollTop = startScroll + (ev.clientY - startY) * ratio; };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Click the track (not the thumb) → page the view so the thumb centres there.
  const onTrackDown = (e) => {
    const el = scrollRef.current;
    if (!el || e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    const target = ratio * el.scrollHeight - el.clientHeight / 2;
    el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, target));
  };

  if (!thumb) return null;
  return (
    <div className="dv-tabbar-scroll" onMouseDown={onTrackDown}>
      <div
        className="dv-tabbar-thumb"
        style={{ top: `${thumb.top}%`, height: `${thumb.height}%` }}
        onMouseDown={onThumbDown}
      />
    </div>
  );
}

// Small / large square markers flanking the Open-files icon-size slider.
const SmallTileGlyph = (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="8" y="8" width="8" height="8" rx="1.5" /></svg>
);
const LargeTileGlyph = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
);
// ── Document viewer window ───────────────────────────────────────────────
// (The left rail — "Back to app" + "Opened files" — was removed; the window
// now dedicates its full width to the Multitool panel + document card.)

export default function DocViewer() {
  const [params] = useSearchParams();
  // Opened from Files' "New file": the document is empty and the advisor should
  // generate its content. `regenTick` re-keys the pane after each generation so
  // the (now-filled) file is re-read from disk.
  // State rather than a plain read: a pre-warmed window (?warm=1) receives its
  // file — and this flag — over IPC after mount. See the adoption effect below.
  const [wantsGenerate, setWantsGenerate] = useState(() => params.get('generate') === '1');
  const [regenTick, setRegenTick] = useState(0);

  // The right card is a slot: each file's pane portals its tabbed side panel
  // (Text extraction / AI captions / AI advisor) into it. Width persisted.
  const [sidePanelSlot, setSidePanelSlot] = useState(null);
  // Slot inside the Multitool topbar where the active pane portals its side-panel
  // tab strip (Text extraction / AI captions / AI advisor).
  const [sideTabsSlot, setSideTabsSlot] = useState(null);
  // Single Multitool footer slot — the active tab portals its primary action
  // (Extract text / Generate captions / advisor composer) here.
  const [footSlot, setFootSlot] = useState(null);
  const ADVISOR_MIN = 240;
  const ADVISOR_MAX = 960;
  const [advisorW, setAdvisorW] = useState(() => {
    const w = readDvLayout().advisorW;
    return typeof w === 'number' ? Math.min(ADVISOR_MAX, Math.max(ADVISOR_MIN, w)) : 360;
  });
  const beginAdvisorResize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = advisorW;
    let lastW = startW;
    document.body.classList.add('dv-ocr-resizing');
    const onMove = (ev) => {
      // Panel sits on the LEFT — dragging the gutter rightward widens it.
      lastW = Math.min(ADVISOR_MAX, Math.max(ADVISOR_MIN, startW + toLayoutPx(ev.clientX - startX)));
      setAdvisorW(lastW);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('dv-ocr-resizing');
      writeDvLayout({ advisorW: lastW });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // This window shows exactly one file (each opened file gets its own window).
  // It's still modelled as a one-entry `tabs` list so the rename / file-removed
  // handlers below can keep operating on it by path.
  const [tabs, setTabs] = useState(() => {
    const path = params.get('path');
    if (!path) return [];
    return [{ id: path, path, name: params.get('name') || 'Document', mime: params.get('mime') || '' }];
  });
  const [activeId, setActiveId] = useState(() => params.get('path') || null);

  // ── Instant open: adopting a file into a pre-warmed window ───────────────
  // This window may have been booted empty and hidden (?warm=1) purely so a
  // later double-click doesn't have to pay for a window + bundle + provider
  // boot. When main hands it a file, swap the state in place — the React tree,
  // the lazy /doc-viewer chunk, pdf.js and the AI panel are already loaded, so
  // this is a re-render rather than a cold start. Main shows the window only
  // after the ack below, so the user never sees the empty shell.
  const isWarmWindow = params.get('warm') === '1';
  useEffect(() => onDocViewerOpenFile((file) => {
    if (!file?.path) return;
    setTabs([{ id: file.path, path: file.path, name: file.name || 'Document', mime: file.mime || '' }]);
    setActiveId(file.path);
    setWantsGenerate(file.generate === true || file.generate === '1');
    // The window title is normally derived from the launch query, which a warm
    // window doesn't have.
    try { document.title = `DocVex — ${file.name || 'Document'}`; } catch { /* non-fatal */ }
  }), []);

  // Tell main this warm window is mounted and can take a file. One shot.
  useEffect(() => {
    if (isWarmWindow) notifyDocViewerWarmReady();
  }, [isWarmWindow]);

  // While the warm window sits idle, pull in the modules a document open would
  // otherwise dynamic-import on the critical path: pdf.js (module + worker),
  // docx-preview and SheetJS. Parsing and evaluating these is most of the jank
  // in the first seconds after a file opens, and here it costs nothing — the
  // window is hidden and the user isn't waiting on anything.
  useEffect(() => {
    if (!isWarmWindow) return undefined;
    let cancelled = false;
    const warm = () => {
      if (cancelled) return;
      import('../lib/pdfWorker')
        .then((m) => m.loadPdfModule?.())
        .catch(() => { /* the real open will load it */ });
      import('docx-preview').catch(() => {});
      import('xlsx').catch(() => {});
    };
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(warm, { timeout: 4000 })
      : setTimeout(warm, 1500);
    return () => {
      cancelled = true;
      if (window.cancelIdleCallback && window.requestIdleCallback) window.cancelIdleCallback(idle);
      else clearTimeout(idle);
    };
  }, [isWarmWindow]);

  // …and, once the document is actually on screen, that it's safe to show the
  // window. TWO frames: the first commit only mounts the viewer chrome and the
  // document pane; the pane's own first paint lands on the frame after. Acking
  // on a single rAF showed the window mid-layout, which is what read as "the
  // viewer lags for a second or two after it opens".
  const paintedFor = useRef(null);
  useEffect(() => {
    if (!isWarmWindow || !activeId || paintedFor.current === activeId) return undefined;
    paintedFor.current = activeId;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => notifyDocViewerFilePainted());
    });
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [isWarmWindow, activeId]);

  // A Files tab just trashed/deleted file(s) — close any tab showing one. A
  // folder delete arrives as the folder path, so also close tabs inside it.
  // Closing the last surviving tab closes the window (matches closeTab).
  useEffect(() => onFilesRemoved((paths) => {
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const removed = (Array.isArray(paths) ? paths : [paths]).map(norm).filter(Boolean);
    if (removed.length === 0) return;
    const isGone = (p) => { const t = norm(p); return removed.some((r) => t === r || t.startsWith(`${r}/`)); };
    setTabs((prev) => {
      const next = prev.filter((t) => !isGone(t.path));
      if (next.length === prev.length) return prev;
      if (next.length === 0) {
        setTimeout(() => { try { window.close(); } catch { /* noop */ } }, 0);
        return next;
      }
      setActiveId((cur) => (next.some((t) => t.id === cur) ? cur : next[next.length - 1].id));
      return next;
    });
  }), []);

  // Rename the file behind a tab on disk, then re-key the tab to its new path
  // (the tab id IS the path). Keeps the old name on failure (silent — the
  // inline input simply reverts to the existing name).
  const renameTab = useCallback(async (tab, newName) => {
    const { dir, sep } = dirAndSep(tab.path);
    if (!dir || !newName || newName === tab.name) return;
    const res = await localFolderApi.renameFile({ dir, fromName: tab.name, toName: newName });
    if (!res || res.error) return;
    const newPath = `${dir}${sep}${newName}`;
    setTabs((prev) => prev.map((t) => (t.id === tab.id
      ? { ...t, id: newPath, path: newPath, name: newName }
      : t)));
    setActiveId((cur) => (cur === tab.id ? newPath : cur));
    // Propagate the rename to every Files tab (the doc-viewer's own embedded
    // one + the main window) so their listings show the new name.
    notifyFilesChanged();
  }, []);

  // A generate-time rename (wildcard → real extension). Unlike renameTab, the
  // rename already happened on disk (the advisor did it) AND we keep the tab id
  // stable — only the path / name / mime change — so the advisor's in-progress
  // conversation (keyed on the tab id) survives the re-extension.
  const applyGeneratedRename = useCallback((tabId, newName, newMime) => {
    setTabs((prev) => prev.map((t) => {
      if (t.id !== tabId) return t;
      const { dir, sep } = dirAndSep(t.path);
      return { ...t, path: `${dir}${sep}${newName}`, name: newName, mime: newMime || t.mime };
    }));
    notifyFilesChanged();
  }, []);

  const closeTab = (id) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        // Closing the last tab closes the window.
        setTimeout(() => { try { window.close(); } catch { /* noop */ } }, 0);
        return next;
      }
      if (id === activeId) {
        const fallback = next[Math.min(idx, next.length - 1)];
        setActiveId(fallback.id);
      }
      return next;
    });
  };

  // Tabs whose content parsed as a WhatsApp conversation (reported by the
  // text pane) — their sidebar tiles show the WhatsApp mark.
  const [waTabs, setWaTabs] = useState(() => new Set());
  const markActiveWhatsApp = useCallback((id) => {
    setWaTabs((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  // Both cards (Documents / Multitool) are shown at once, but exactly ONE is
  // "selected" (focused) — like the main app's split-view panes. The cards look
  // identical regardless; the only effect of selection is that ONLY the selected
  // card shows its footer (advisor composer). See the `.is-selected` footer-
  // gating rules in DocViewer.css.
  const [selectedWindow, setSelectedWindow] = useState('documents');
  // Selection is wired via a NATIVE capture-phase listener on the page (not a
  // React onMouseDown) because each window's interactive content is PORTALLED
  // into it — React synthetic events follow the React tree, so a click on the
  // Multitool's portalled side panel would never reach a React handler on the
  // card. Native DOM events follow the real DOM tree, where the portalled nodes
  // DO live inside their window's root (tagged with data-dvwin).
  const pageRef = useRef(null);
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return undefined;
    const onDown = (e) => {
      const root = e.target?.closest?.('[data-dvwin]');
      if (root) setSelectedWindow(root.getAttribute('data-dvwin'));
    };
    el.addEventListener('mousedown', onDown, true);
    return () => el.removeEventListener('mousedown', onDown, true);
  }, []);

  // Advisor-card cursor spotlight. A CALLBACK ref (not a useRef + [] effect): the
  // aside only mounts once a file is active (there's an early `return` above for
  // the empty state) and it can remount when the file changes, so an effect that
  // reads the ref once on mount would attach to a null node and never re-try —
  // leaving the glow frozen at its 50%/50% default. The callback re-runs on every
  // mount/unmount, so the listener tracks the live node.
  // It MUST be a NATIVE listener: the side panel is createPortal'd into
  // .dv-advisor-slot, so React synthetic events bubble along the *React* tree
  // (where the portalled content's parent is the panel, NOT this <aside>) and
  // never reach a synthetic handler here — the cursor would only register on the
  // card's own border. Native events follow the real DOM tree, where the portal
  // nodes are genuine descendants of the aside, so this fires everywhere inside.
  const advisorSpotCleanup = useRef(null);
  const advisorCardRef = useCallback((node) => {
    if (advisorSpotCleanup.current) { advisorSpotCleanup.current(); advisorSpotCleanup.current = null; }
    if (!node) return;
    const onMove = (e) => {
      const r = node.getBoundingClientRect();
      // Layout-space CSS lengths (identity at base zoom 1; toLayoutPx compensates
      // the web display-scale).
      node.style.setProperty('--spot-x', `${toLayoutPx(e.clientX - r.left)}px`);
      node.style.setProperty('--spot-y', `${toLayoutPx(e.clientY - r.top)}px`);
    };
    node.addEventListener('mousemove', onMove);
    advisorSpotCleanup.current = () => node.removeEventListener('mousemove', onMove);
  }, []);

  const active = tabs.find((t) => t.id === activeId) || tabs[0] || null;

  // A pre-warmed window is now SHOWN before it has been handed a file (main no
  // longer waits for the document to paint — see adoptWarmDocViewer), so this
  // branch is what the user sees for the first frames of every instant open.
  // It has to read as "opening…", not as "there's nothing here".
  if (!active) {
    return isWarmWindow ? (
      <div className="dv-page dv-page-empty">
        <span className="dv-boot-spinner" aria-label="Opening document" />
      </div>
    ) : (
      <div className="dv-page dv-page-empty">No file to display.</div>
    );
  }

  // Arm the AI Generate flow when it was opened with ?generate=1, when the active
  // file is an extensionless "wildcard" (a freshly-created file whose real type is
  // decided by which version you pick in the chat), OR when the file is a document
  // the generator can (re)build — Word / PowerPoint / Excel / PDF / text — so the
  // Generate sidebar (engine toggle + version cards) shows for those too.
  const GENERATABLE_DOC_KINDS = new Set(['docx', 'doc', 'pptx', 'sheet', 'pdf', 'text']);
  const generateArmed = wantsGenerate
    || extOf(active.name) === ''
    || GENERATABLE_DOC_KINDS.has(classify(active.mime, active.name).kind);

  // Audio drops the document card's rounded-corner frame so the player +
  // lyrics read as an open section rather than a boxed card.
  const isAudioDoc = classify(active.mime, active.name).kind === 'audio';

  return (
    <MultitoolAdvisorProvider
      file={active}
      footSlot={footSlot}
      generateMode={generateArmed}
      onDocWritten={() => setRegenTick((t) => t + 1)}
      onRenameFile={(newName, newMime) => applyGeneratedRename(active.id, newName, newMime)}
    >
    <div className="dv-page" ref={pageRef}>
      <CursorSpotlight contain className="dv-cursor-spotlight" />

      {/* Body: a column holding the Documents + Multitool cards. */}
      <div className="dv-body-row">
        {/* Right column — Documents + Multitool. */}
        <div className="dv-right-col">
          {/* Main row: the document card fills the whole area; the Multitool
              panel FLOATS above its left side (absolute, see CSS). The var
              feeds the resize gutter's position. */}
          <div className="dv-main-row" style={{ '--dv-advisor-w': `${advisorW}px` }}>
            {/* Multitool panel — hosts the active file's tabbed side panel,
                portalled into the slot below by its pane. No chrome header. */}
            <aside
              ref={advisorCardRef}
              className={`dv-advisor-card${selectedWindow === 'multitool' ? ' is-selected' : ''}`}
              style={{ width: `${advisorW}px` }}
              data-dvwin="multitool"
            >
              <div className="dv-advisor-slot" ref={setSidePanelSlot} />
              {/* Single footer shared across all Multitool tabs — each active
                  tab portals its action (Extract text / Generate captions /
                  advisor composer) into this slot. */}
              <div className="dv-advisor-footerslot" ref={setFootSlot} />
            </aside>

            {/* Draggable gutter between the side panel and the document. */}
            <div
              className="dv-advisor-resize"
              onMouseDown={beginAdvisorResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize side panel"
            />

            {/* Document card — the active file's body. No chrome header. */}
            <div
              className={`dv-doc-card${selectedWindow === 'documents' ? ' is-selected' : ''}${isAudioDoc ? ' is-audio-doc' : ''}`}
              data-dvwin="documents"
            >
              <div className="dv-section-body">
                <div className="dv-section-pane dv-doc">
                  {/* Keyed by the file id only (NOT regenTick) so writing a new
                      version doesn't remount the whole pane — that would refresh
                      and jump the chat. regenTick is passed down so only the
                      PREVIEW re-reads the file from disk. */}
                  <DocPane key={active.id} regenTick={regenTick} file={active} sidePanelSlot={sidePanelSlot} sideTabsSlot={sideTabsSlot} onWhatsAppDetected={() => markActiveWhatsApp(active.id)} />
                </div>
                {/* Clarifying questions now render in the shared AskUserPanel
                    directly above the composer (see MultitoolComposer), not as an
                    overlay over the document area. */}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </MultitoolAdvisorProvider>
  );
}

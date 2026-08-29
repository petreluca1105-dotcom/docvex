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
import { withStyleSteer } from '../lib/writingStyle';
import { isElectron, extractDocText, openExternal, onFilesRemoved, notifyFilesChanged, openDocViewerWindow, setDocViewerAiStatus, onDocViewerOpenFile, notifyDocViewerWarmReady, notifyDocViewerFilePainted } from '../lib/platform';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useAuth } from '../context/AuthContext';
import { readProjectsDir } from '../lib/projectsDir';
import { extractFileText } from '../lib/extractFileText';
import { readIdentityFromImage } from '../lib/identityExtract';
import { ItemThumbnail, FolderOrBinGlyph, Icon as FxIcon } from '../components/FilesWorkspace';
import { describeLocalFile } from '../lib/thumbnailDescriptor';
import { useChatFind } from '../lib/useChatFind';
import { DOC_TEMPLATES, templatePrompt, customPrompt } from '../lib/docTemplates';
import {
  IDENTITY_KINDS, IDENTITY_ROLES, IDENTITY_ORIGINS, IDENTITY_ID_TYPES, IDENTITY_LEGAL_FORMS,
  fieldsFor, parseIdentity, saveIdentityAt, isIdentityFile,
  identityMrz, identityInitials, identityNameParts, looksLikeIdentityJson, isInIdentityFolder,
  listProjectIdentities, resolveIdentityFields, identityValueForField, classifyCounty,
  APARTMENT_ONLY_FIELDS, addressIsApartment, applyGenderToText, IDENTITY_GENDERS,
  addressHasSectors, applyLocalityToText,
} from '../lib/identities';
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

function classify(mime, name, path) {
  const m = (mime || '').toLowerCase();
  const e = extOf(name);
  // DocVex's own record format — a party to the case. Checked FIRST: the bytes
  // are JSON, so the text branch below would otherwise claim it and show the
  // raw record instead of the form. `.json` counts too when the file sits in the
  // Identities folder; one that doesn't is caught by the content sniff in
  // DocPane, which is the only other way a record can be named.
  if (e === 'dvx' || isIdentityFile(name) || (e === 'json' && isInIdentityFolder(path))) {
    return { kind: 'identity', mime: 'application/json' };
  }
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
const SIDE_TAB_LABELS = { extract: 'Extract text', captions: 'Captions', advisor: 'Advisor', metadata: 'Metadata' };
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
      if (!alive) return;
      if (cached) { setData(cached); setStatus('done'); return; }
      // Nothing cached for this file (or the snapshot no longer describes it):
      // read it now rather than waiting to be asked. There was a button here
      // whose only answer was "yes" — opening the Metadata tab IS the request,
      // and the work is a local read of a file already on disk.
      runRef.current?.();
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

  // The open effect fires before `run` exists in that render's scope; a ref is
  // how it reaches the current one.
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);

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

      {/* Only Re-extract. The first read happens on open — a button whose one
          answer was always "yes" is a question not worth asking — and this
          remains for the case that isn't automatic: a file changed on disk
          since the snapshot was taken. */}
      {status !== 'idle' && (
        <div className="dv-meta-actions">
          <button type="button" className="dv-doc-extract-btn" onClick={run} disabled={status === 'working'}>
            {MetaGlyph}
            <span>{status === 'working' ? 'Reading file…' : 'Re-extract metadata'}</span>
          </button>
        </div>
      )}

      {error && <p className="dv-meta-error" role="alert">{error}</p>}

      {status === 'working' && !error && (
        <p className="dv-ocr-history-empty">
          Reading the file’s dates, size and permissions, whatever properties the format itself
          carries (camera EXIF, PDF and Office document properties, media duration), and a
          SHA-256 fingerprint of the bytes.
        </p>
      )}
      {/* Only reachable when the read failed and left nothing behind — the
          button above is the way back. */}
      {status === 'idle' && !error && data === null && (
        <p className="dv-ocr-history-empty">Nothing read from this file yet.</p>
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
// Apply a manual paragraph edit to a document version's SOURCE text.
//
// The preview is rendered from the real .docx, but a version is stored as the
// markdown-ish source the model wrote and the builder turns into a file — so a
// paragraph edited in the preview has to be found in that source and replaced
// there, not in the rendered DOM. Matching is on normalised text (markdown
// markers, entities and runs of whitespace removed) because the rendered
// paragraph has already lost its `**` and `#` decoration.
//
// Returns the patched source, or null when the paragraph can't be located —
// the caller surfaces that rather than writing a document that silently
// dropped the user's edit.
function patchVersionParagraph(src, before, after) {
  const norm = (t) => String(t || '')
    .replace(/[*_`~]/g, '')
    .replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const target = norm(before);
  if (!target) return null;
  const lines = String(src || '').split('\n');
  let idx = lines.findIndex((l) => norm(l) === target);
  // A long paragraph may have been split or lightly reflowed by the renderer;
  // fall back to containment, but only when the text is distinctive enough that
  // a partial match can't hit the wrong line.
  if (idx < 0 && target.length > 24) idx = lines.findIndex((l) => norm(l).includes(target));
  if (idx < 0) return null;
  // Keep whatever marker opened the line (heading hashes, bullet, numbering) so
  // an edited list item stays a list item.
  const marker = /^(\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)?)/.exec(lines[idx]);
  lines[idx] = `${marker ? marker[1] : ''}${String(after || '').trim()}`;
  return lines.join('\n');
}

const MultitoolAdvisorContext = React.createContext(null);
function useMultitoolAdvisor() { return useContext(MultitoolAdvisorContext); }

function MultitoolAdvisorProvider({ file, footSlot = null, generateMode = false, onDocWritten, onRenameFile, completing = false, setCompleting, children }) {
  const { notify } = useNotifications();
  const { session } = useAuth();
  const { selectedProject } = useSelectedProject();
  const [messages, setMessages] = useState([]); // [{ role, content } | { role:'artifact', version, instructions }]
  // Split-conversation branches. Splitting from a message keeps the ORIGINAL
  // thread intact and starts a new branch; nav pills under the header switch
  // between them. branchStoreRef holds every branch's messages; the active
  // branch's also live in `messages` (kept in sync below).
  const [branches, setBranches] = useState([{ id: 'main', label: 'Main' }]);
  const [activeBranchId, setActiveBranchId] = useState('main');
  const branchStoreRef = useRef({ main: [] });
  const branchSeqRef = useRef(0);

  // ── The picked paragraph, and which conversation it opens ──────────────
  // Declared at the top of the provider because everything downstream reads it:
  // the thread mirror, `switchScope`, the persist effect, and `send` (which
  // decides from the scope what a prompt is aimed at).
  const [paraPicked, setParaPicked] = useState(false);
  // The picked paragraph's text, published by the document pane, so the
  // composer can aim a prompt at it without reaching into the document's DOM.
  const [paraText, setParaText] = useState('');
  // WHICH paragraph it is — its document-order index (or the joined indices of a
  // multi-paragraph pick). This is what a paragraph's conversation is filed
  // under, and it survives both a re-render and a new version of the file.
  const [paraKey, setParaKey] = useState('');
  const paraScope = paraKey ? `para:${paraKey}` : '';

  // 'document' is the thread about the file as a whole — the one that carries
  // the split branches. A `para:<indices>` scope is a thread about ONE
  // paragraph, isolated from the document's and from every other paragraph's:
  // asking "shorten this" in paragraph 7 must not drag paragraph 3's argument
  // along, and must not bury the document-level conversation either.
  //
  // Version cards need no special handling — they are messages, so a version
  // produced from a paragraph's thread lands in that paragraph's thread.
  const [threadScope, setThreadScope] = useState('document');
  const paraThreadsRef = useRef({});   // 'para:<indices>' → messages[]

  const threadScopeRef = useRef('document');
  useEffect(() => { threadScopeRef.current = threadScope; }, [threadScope]);
  const paraTextRef = useRef('');
  useEffect(() => { paraTextRef.current = paraText; }, [paraText]);

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
    paraThreadsRef.current = saved?.paraThreads ? { ...saved.paraThreads } : {};
    setThreadScope('document');
    setVersions(vers);
    versionCountRef.current = vers.reduce((mx, v) => Math.max(mx, v.n || 0), 0);
    // The last generated iteration is what's currently on disk.
    setActiveVersion(vers.length ? vers[vers.length - 1].n : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  // Keep the live thread mirrored into whichever store owns the current scope,
  // so a switch (branch OR paragraph) and every persist see the latest.
  useEffect(() => {
    if (threadScope === 'document') branchStoreRef.current[activeBranchId] = messages;
    else paraThreadsRef.current[threadScope] = messages;
  }, [messages, activeBranchId, threadScope]);

  // Move the conversation to another scope. The mirror above already stashed the
  // outgoing thread, so this only has to swap in the incoming one.
  const switchScope = useCallback((next) => {
    if (busy || !next || next === threadScope) return;
    setOptions([]);
    setPendingAsk(null);
    setThreadScope(next);
    setMessages(next === 'document'
      ? (branchStoreRef.current[activeBranchId] || [])
      : (paraThreadsRef.current[next] || []));
  }, [busy, threadScope, activeBranchId]);

  // Picking a paragraph moves the conversation to that paragraph's thread —
  // that is what the click meant. Dropping the pick returns to the document's.
  const switchScopeRef = useRef(switchScope);
  useEffect(() => { switchScopeRef.current = switchScope; }, [switchScope]);
  useEffect(() => {
    switchScopeRef.current?.(paraScope || 'document');
  }, [paraScope]);

  // Persist the thread + versions + every branch whenever they change so
  // reopening the file restores all split conversations.
  useEffect(() => {
    if (!file?.path) return;
    // While a paragraph thread is on screen, `messages` is NOT the active
    // branch's — read every branch from the store instead.
    const onDoc = threadScope === 'document';
    const branchRecords = branches.map((b) => ({
      id: b.id, label: b.label, splits: b.splits || [],
      messages: (onDoc && b.id === activeBranchId) ? messages : (branchStoreRef.current[b.id] || []),
    }));
    saveConversation(file.path, {
      messages, versions, branches: branchRecords, activeBranchId,
      paraThreads: paraThreadsRef.current,
    });
  }, [file?.path, messages, versions, branches, activeBranchId, threadScope]);

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
      setMessages((m) => [...m, { role: 'assistant', content: note, at: Date.now(), usage: res.usage }]);
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
      setMessages((m) => [...m, { role: 'assistant', content: res.text || 'A couple of quick questions first.', at: Date.now(), usage: res.usage }]);
      setPendingAsk({ id: res.askUser.id, input: res.askUser.input, assistantContent: res.assistantContent, base: baseMsgs, gen: true });
      return;
    }
    // A pure conversational answer (a question that doesn't change the document).
    setMessages((m) => [...m, { role: 'assistant', content: res.text || '', at: Date.now(), usage: res.usage }]);
  }, [file, writeDoc]);

  // Commit manual paragraph edits made directly in the document preview.
  //
  // Each edit is `{ before, after }` — the paragraph's text as the AI wrote it
  // and as the user has since typed it. They're patched into the ACTIVE
  // version's source, the file is rebuilt from that source, and the result is
  // saved as a new version with its own card in the thread, exactly like an AI
  // revision. Edits whose paragraph can't be located in the source are reported
  // back rather than dropped.
  const applyManualEdit = useCallback(async (edits) => {
    const list = (edits || []).filter((e) => e && e.before && e.after !== e.before);
    if (!list.length) return { error: 'no_edits' };
    const active = versions.find((v) => v.n === activeVersion)
      || (versions.length ? versions[versions.length - 1] : null);
    // Without a version there's no source to patch: the file on disk was not
    // written by the AI, and rebuilding it from the rendered preview would
    // flatten formatting the reconstruction never captured.
    if (!active) return { error: 'no_version' };

    let text = active.text;
    let applied = 0;
    const missed = [];
    for (const e of list) {
      const next = patchVersionParagraph(text, e.before, e.after);
      if (next == null) { missed.push(e.before); continue; }
      text = next;
      applied += 1;
    }
    if (!applied) return { error: 'not_found', missed };

    const kind = active.kind || docKindFromName(file?.name || '') || 'docx';
    try {
      await writeDoc(text, kind);
    } catch {
      return { error: 'write_failed' };
    }
    const n = versionCountRef.current + 1;
    versionCountRef.current = n;
    const label = applied === 1 ? 'Your edit to one paragraph' : `Your edits to ${applied} paragraphs`;
    setVersions((v) => [...v, { n, text, instructions: label, kind, manual: true }]);
    setActiveVersion(n);
    setMessages((m) => [...m, { role: 'artifact', version: n, instructions: label, at: Date.now(), manual: true }]);
    return { ok: true, version: n, applied, missed };
  }, [versions, activeVersion, file?.name, writeDoc]);

  // One assistant turn. In generate-mode the model drives the file through the
  // `write_document` tool: every create/change request saves a NEW version, and
  // the user can iterate without limit. We pin tool_choice to write_document when
  // the request clearly wants a document, so it can never refuse or drift to prose.
  // `convo` is the visible thread up to and including the latest user message.
  // ── The project's other files ──────────────────────────────────────────
  // The advisor is looking at ONE document, but the answer often lives in
  // another file in the same project ("does this match the signed contract?").
  // So every turn carries an inventory of what is in the Files tab, and any file
  // the user NAMES has its text pulled in whole.
  //
  // Both ride transiently on the request and are never written onto the stored
  // message: the folder changes, and a file's text baked into the thread would
  // be replayed on every later turn and persisted to localStorage with it.
  const projectListRef = useRef({ at: 0, files: [] });
  const listProjectFiles = useCallback(async () => {
    const cached = projectListRef.current;
    if (cached.at && Date.now() - cached.at < PROJECT_LIST_TTL_MS) return cached;
    try {
      const projectId = selectedProject?.id;
      if (!projectId) return { at: Date.now(), files: [] };
      const baseDir = readProjectsDir(session?.user?.id || '_anonymous') || undefined;
      const { path } = await localFolderApi.projectDir(projectId, selectedProject?.name, baseDir);
      const { files: list } = await localFolderApi.listAll(path || undefined);
      const files = (list || [])
        .filter((f) => f?.name && !f.name.startsWith('.'))
        .map((f) => ({ name: f.name, folder: f.folderPath || '', path: f.path || f.name }));
      const next = { at: Date.now(), files };
      projectListRef.current = next;
      return next;
    } catch {
      // No folder connected, or it went away — say nothing rather than claiming
      // the project is empty.
      return cached;
    }
  }, [selectedProject?.id, selectedProject?.name, session?.user?.id]);

  // The project's identity records, for the fields panel's "fill every blank
  // about this party at once". Cached like the folder listing: adding a record
  // in the Files tab is rare next to how often the panel re-renders.
  const identitiesRef = useRef({ at: 0, list: [] });
  const loadIdentities = useCallback(async () => {
    const cached = identitiesRef.current;
    if (cached.at && Date.now() - cached.at < IDENTITY_LIST_TTL_MS) return cached.list;
    try {
      const projectId = selectedProject?.id;
      if (!projectId) return [];
      const baseDir = readProjectsDir(session?.user?.id || '_anonymous') || undefined;
      const { path } = await localFolderApi.projectDir(projectId, selectedProject?.name, baseDir);
      const list = await listProjectIdentities(path || undefined);
      identitiesRef.current = { at: Date.now(), list };
      return list;
    } catch {
      return cached.list;
    }
  }, [selectedProject?.id, selectedProject?.name, session?.user?.id]);

  const buildProjectFilesNote = useCallback(async (userText) => {
    const { files } = await listProjectFiles();
    const others = files.filter((f) => f.name !== file?.name);
    if (!others.length) return '';
    const shown = others.slice(0, PROJECT_FILE_LIST_MAX);
    const inventory = shown
      .map((f) => (f.folder ? `${f.folder}/${f.name}` : f.name))
      .join('\n');
    const parts = [
      `[Project files — the other files in this project's Files tab (${others.length} in total`
      + `${others.length > shown.length ? `, ${shown.length} listed` : ''}):\n${inventory}\n\n`
      + 'You can read any of these: name the one you need and its text will be included with the next message. '
      + 'Never invent what a file you have not been shown contains.]',
    ];
    // Which of them did the user actually name? Match the whole filename, or the
    // bare stem when it is long enough that a chance word will not match it.
    const hay = String(userText || '').toLowerCase();
    const named = others.filter((f) => {
      const n = f.name.toLowerCase();
      if (hay.includes(n)) return true;
      const stem = n.replace(/\.[^.]+$/, '');
      return stem.length >= 4 && hay.includes(stem);
    }).slice(0, PROJECT_FILE_READ_MAX);
    for (const f of named) {
      try {
        const blob = await readLocalBlob(f.path);
        if (!blob) continue;
        const res = await extractFileText(blob, f.name);
        const text = (res?.text || '').trim();
        if (!text) continue;
        const cut = text.length > REF_FILE_CHARS;
        parts.push(`[Contents of "${f.name}"${cut ? ' (truncated)' : ''}:\n${text.slice(0, REF_FILE_CHARS)}\n]`);
      } catch { /* unreadable (an image, a locked file) — the inventory still names it */ }
    }
    return parts.join('\n\n');
  }, [file?.name, listProjectFiles]);

  const runTurn = useCallback(async (convo, lastUserText) => {
    const seq = ++turnSeqRef.current;
    const stopped = () => turnSeqRef.current !== seq;
    // What the Files tab holds, plus the full text of anything the user named.
    // Attached to the OUTGOING copy of the last user message only — see
    // buildProjectFilesNote for why it must not touch the stored thread.
    const filesNote = await buildProjectFilesNote(lastUserText);
    const withFiles = (msgs) => (filesNote
      ? msgs.map((m, i) => (
        i === msgs.length - 1 && m.role === 'user' && typeof m.content === 'string'
          ? { ...m, content: `${m.content}\n\n${filesNote}` }
          : m
      ))
      : msgs);
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
      // …and the user's own writing style on top of it, learned from the
      // documents they imported in the Playbook. This is the path that WRITES
      // the file, so it is the one that most has to sound like them.
      const sentMsgs = await withStyleSteer(withFiles(askMsgs));
      const res = await askProjectAi({ messages: sentMsgs, fileNames: [], model, docTools: true, docKind: k || undefined });
      if (res.error) {
        setError(res.error.message === 'ai_not_configured' ? 'The AI isn’t configured to generate documents.' : 'Couldn’t reach the AI right now.');
        return;
      }
      addUsage(res.usage);
      if (stopped()) return;
      // Resume from exactly what the model saw (askMsgs carries the steer note) so
      // an ask_user follow-up replays coherently.
      await applyGenResult(res, lastUserText, sentMsgs);
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
    const res = await askProjectAi({ messages: withFiles(apiMsgs), fileNames: [file?.name], model });
    if (stopped()) return;
    if (res.error) { setError('The AI advisor is unavailable right now.'); return; }
    addUsage(res.usage);
    // The model asked an interactive question via the ask_user tool — surface it
    // above the composer and pause until the user answers.
    if (res.stopReason === 'tool_use' && res.askUser) {
      setMessages((m) => [...m, { role: 'assistant', content: res.text || 'I have a quick question.', at: Date.now(), usage: res.usage }]);
      setPendingAsk({ id: res.askUser.id, input: res.askUser.input, assistantContent: res.assistantContent, base: apiMsgs });
      return;
    }
    setMessages((m) => [...m, { role: 'assistant', content: res.text, at: Date.now(), usage: res.usage }]);
  }, [genMode, file, versions, activeVersion, model, addUsage, applyGenResult, buildProjectFilesNote]);

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
    // Pair each question with what was answered, so the thread shows WHAT was
    // asked above the reply instead of a bare "Answered." — once the panel
    // collapses, the questions are otherwise gone from the conversation.
    const qa = opts.dismissed
      ? []
      : questions.map((qq, qi) => ({ prompt: qq.prompt, answer: askAnswerText(qq, answers.answers?.[qi]) }));
    setMessages((m) => [...m, {
      role: 'user',
      // Flattened for anything that reads message text (history rebuilds, the
      // resumed thread); the bubble renders `qa` structurally instead.
      content: opts.dismissed
        ? 'Skipped.'
        : (qa.map((x) => `${x.prompt}\n${x.answer}`).join('\n\n') || opts.typedText || 'Answered.'),
      qa,
      at: Date.now(),
    }]);
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
      setMessages((m) => [...m, { role: 'assistant', content: res.text || 'I have a quick question.', at: Date.now(), usage: res.usage }]);
      setPendingAsk({ id: res.askUser.id, input: res.askUser.input, assistantContent: res.assistantContent, base: apiMsgs });
      return;
    }
    setMessages((m) => [...m, { role: 'assistant', content: res.text, at: Date.now(), usage: res.usage }]);
  }, [pendingAsk, busy, file, model, addUsage, applyGenResult]);

  // `send()` with no arguments sends whatever is in the composer — that's the
  // composer's own binding (it's also used as an onClick handler, so a click
  // event landing in the first slot is ignored). The document preview calls it
  // with an explicit prompt AND the passage it applies to, straight from the bar
  // over the selection: passing both in avoids a round-trip through `input` /
  // `selection` state, which this closure couldn't read until the next render.
  // `opts.apiText` lets a caller show one thing and send another — the template
  // chooser puts "Make a Contract NDA." in the thread while the model receives
  // the whole section outline. Without it the reader's first bubble would be a
  // wall of instructions they never wrote.
  const send = useCallback(async (overrideText, overridePassage, opts = {}) => {
    const q = (typeof overrideText === 'string' ? overrideText : input).trim();
    if (!q || busy) return;
    // While a question is pending, a typed message answers it (free-text).
    if (pendingAsk) { setInput(''); resolveAsk({ typedText: q }); return; }
    // If the user pointed at a passage in the document, append it to the API text
    // (not the visible bubble) so the model knows exactly which part to change.
    // Most specific wins: an explicit passage from a caller, then a passage the
    // user highlighted by hand, then — failing both — the paragraph whose
    // thread this is. The document thread has no passage, which is what the
    // model already reads as "the whole thing".
    const scopePassage = (threadScopeRef.current !== 'document' && paraTextRef.current.trim())
      ? paraTextRef.current.trim()
      : null;
    const passage = (typeof overridePassage === 'string' && overridePassage.trim())
      ? overridePassage.trim()
      : (selection || scopePassage);
    const explicitApi = typeof opts.apiText === 'string' && opts.apiText.trim() ? opts.apiText.trim() : null;
    const apiText = explicitApi || (passage
      ? `${q}\n\nThe user selected this exact passage from the document and wants the request applied to it. Change only what's needed here; leave the rest of the document unchanged unless asked otherwise:\n"""\n${passage}\n"""`
      : undefined);
    // `passage` is kept on the message purely so the thread can show, under the
    // bubble, which part of the document the request was aimed at. The model
    // reads it through `apiText`; this copy is for the reader.
    const userMsg = {
      role: 'user',
      content: q,
      ...(apiText ? { apiText } : {}),
      ...(passage ? { passage } : {}),
      at: Date.now(),
    };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setSelection(null);
    setBusy(true);
    setError(null);
    setOptions([]);
    await runTurn(next, explicitApi || q);
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
    // Splits are a document-thread feature: a paragraph's conversation is
    // already the narrow one, and its store has no branch dimension.
    if (threadScopeRef.current !== 'document') return;
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

  // ── "Complete data" ────────────────────────────────────────────────────
  // The document pane owns the blanks (they're spans in DOM it renders), so it
  // registers a small API here and publishes what it found. The side panel and
  // the version card both drive the mode through this context, which is the
  // only thing the two of them share.
  // The side panel's "Selected paragraph" tab hands back the node to draw the
  // pick's controls into; the document pane portals its bar there. (The pick
  // state itself is declared above `send`, which needs it.)
  const [paraSlot, setParaSlot] = useState(null);

  // Which blank the pointer is over, wherever the pointer happens to be. The
  // document publishes it when you hover a marked gap; the fields panel
  // publishes it when you hover a card. Both sides then highlight the same
  // blank, so the two views are always pointing at each other.
  const [hoverField, setHoverField] = useState(null);

  const fieldsApiRef = useRef(null);
  const [fields, setFields] = useState([]);
  // Identifies WHICH document the current blanks came from, so a new version
  // invalidates the answers while merely closing and reopening the panel does
  // not. Set alongside the field list by the pane that found them.
  const [fieldsSig, setFieldsSig] = useState('');
  // Every blank in the document, as opposed to `fields` (only the ones in the
  // paragraph you picked). Suggestions are always asked for the WHOLE document
  // in one call — asking per paragraph would re-read the project folder and pay
  // for a round trip on every click.
  const [allFields, setAllFields] = useState([]);
  const registerFieldsApi = useCallback((api) => { fieldsApiRef.current = api; }, []);
  const publishFields = useCallback((list, sig, all) => {
    setFields(list || []);
    setFieldsSig(sig || '');
    if (Array.isArray(all)) setAllFields(all);
  }, []);
  const setFieldValue = useCallback((id, v) => fieldsApiRef.current?.setValue?.(id, v), []);
  const focusField = useCallback((id) => fieldsApiRef.current?.focus?.(id), []);
  const applyFields = useCallback(() => fieldsApiRef.current?.apply?.(), []);
  // Hover-preview of a party's details, straight into the document's blanks.
  const dropFields = useCallback((ids) => fieldsApiRef.current?.dropFields?.(ids), []);
  const applyGender = useCallback((g) => fieldsApiRef.current?.applyGender?.(g), []);
  const applyLocality = useCallback((h) => fieldsApiRef.current?.applyLocality?.(h), []);
  const previewFields = useCallback((map, opts) => fieldsApiRef.current?.previewValues?.(map, opts), []);
  const endFieldPreview = useCallback((commit) => fieldsApiRef.current?.endPreview?.(commit), []);
  // Closing the panel means dropping the paragraph that opened it — the panel
  // has no existence of its own any more.
  const clearPick = useCallback(() => fieldsApiRef.current?.clearPick?.(), []);
  const getDocumentText = useCallback(() => fieldsApiRef.current?.documentText?.() || '', []);

  // Text of the project's OTHER files. Reading a folder of PDFs is slow, so it
  // happens once and is then reused for the life of the window — re-extracted
  // only when the folder's contents actually change. The folder LISTING is
  // cheap and always re-read; its signature (name + size + modified time of
  // each candidate) is what decides whether the expensive part runs again.
  const refFilesRef = useRef({ sig: null, files: [] });
  const refFilesRunRef = useRef(null);
  const loadReferenceFiles = useCallback(async () => {
    // Single-flight: the background warm-up and a user opening the panel can
    // both ask at once, and neither should start a second folder walk.
    if (refFilesRunRef.current) return refFilesRunRef.current;
    const run = (async () => {
      const cached = refFilesRef.current;
      try {
        const projectId = selectedProject?.id;
        if (!projectId) return { sig: '', files: [] };
        const baseDir = readProjectsDir(session?.user?.id || '_anonymous') || undefined;
        const { path } = await localFolderApi.projectDir(projectId, selectedProject?.name, baseDir);
        const { files: list } = await localFolderApi.listAll(path || undefined);
        // Newest first (listAll already sorts that way), skipping the document
        // being completed and anything hidden.
        const candidates = (list || [])
          .filter((f) => f?.name && f.name !== file?.name && !f.name.startsWith('.'))
          .slice(0, REF_FILE_LIMIT);
        const sig = candidates
          .map((f) => `${f.folderPath || ''}/${f.name}:${f.sizeBytes ?? ''}:${f.mtimeIso || ''}`)
          .join('|');
        if (sig === cached.sig) return cached;   // folder untouched — reuse the text
        const out = [];
        for (const f of candidates) {
          try {
            const blob = await readLocalBlob(f.path || f.name);
            if (!blob) continue;
            const res = await extractFileText(blob, f.name);
            const text = (res?.text || '').trim();
            if (text) out.push({ name: f.name, text: text.slice(0, REF_FILE_CHARS) });
          } catch { /* unreadable file — the others still count */ }
        }
        return { sig, files: out };
      } catch {
        // No folder connected, or it went away: keep whatever we already had
        // rather than losing a good extraction to a transient failure.
        return cached.sig != null ? cached : { sig: '', files: [] };
      }
    })();
    refFilesRunRef.current = run;
    try {
      const res = await run;
      refFilesRef.current = res;
      return res;
    } finally {
      if (refFilesRunRef.current === run) refFilesRunRef.current = null;
    }
  }, [file?.name, selectedProject?.id, selectedProject?.name, session?.user?.id]);

  // Suggested values, held here rather than in the panel so they survive the
  // panel being closed and reopened. `key` is the document plus the folder it
  // was answered against: same key means the cached answers still stand.
  const [fieldSuggestions, setFieldSuggestions] = useState({ key: null, map: {}, loading: false, error: null });
  const suggestionsRef = useRef(fieldSuggestions);
  useEffect(() => { suggestionsRef.current = fieldSuggestions; }, [fieldSuggestions]);
  const suggestRunRef = useRef({ key: null, promise: null });

  // Ask the model to propose values for every blank at once, tagging each
  // suggestion with WHERE it came from: the document and this conversation
  // ("context"), or a specific file in the project folder ("file").
  //
  // Returns immediately when the answers for this exact document + folder are
  // already in hand, so opening the panel a second time costs nothing. The
  // document pane calls this in the background as soon as a draft with blanks
  // finishes rendering, which is what makes the panel fill in instantly.
  const ensureFieldSuggestions = useCallback(async (list, documentText, sig, { force = false } = {}) => {
    const wanted = (list || []).filter((f) => f?.id);
    if (!wanted.length) return null;
    const refs = await loadReferenceFiles();
    const key = `${sig || ''}|${refs.sig || ''}`;
    if (!force) {
      const inflight = suggestRunRef.current;
      if (inflight.key === key && inflight.promise) return inflight.promise;
      if (suggestionsRef.current.key === key && !suggestionsRef.current.error) return suggestionsRef.current;
    }
    setFieldSuggestions((prev) => ({ key, map: prev.key === key ? prev.map : {}, loading: true, error: null }));

    const run = (async () => {
      const refBlock = refs.files.length
        ? refs.files.map((r) => `--- FILE: ${r.name} ---\n${r.text}`).join('\n\n')
        : '(no other readable files in this project)';
      const fieldList = wanted
        .map((f) => `${f.id} | placeholder: ${f.raw} | reads as: ${f.label} | in sentence: ${f.context}`)
        .join('\n');
      const prompt = [
        'You are completing the blanks in a document. Propose values for each blank.',
        '',
        'THE DOCUMENT (blanks appear exactly as written):',
        (documentText || '').slice(0, 12000),
        '',
        'THE BLANKS TO FILL (one per line):',
        fieldList,
        '',
        'REFERENCE FILES the user uploaded to this project:',
        refBlock,
        '',
        'Rules:',
        '- Give at most 3 suggestions per blank, best first.',
        '- source "file" ONLY when the value actually appears in one of the reference files above; then set "file" to that exact file name and quote the value as it appears there.',
        '- source "context" when the value follows from the document itself or from what we have discussed.',
        '- Never invent a fact that is nowhere in the document or the files. If you have nothing, return an empty suggestions array for that blank.',
        '- "value" is the finished text that will be pasted into the document — no brackets, no commentary.',
        '- "why" is at most 12 words saying where it came from.',
        '',
        'Reply with JSON ONLY, no prose, in exactly this shape:',
        '{"fields":[{"id":"f1","suggestions":[{"value":"...","source":"context","why":"..."},{"value":"...","source":"file","file":"contract.pdf","why":"..."}]}]}',
      ].join('\n');

      const res = await askProjectAi({
        messages: [{ role: 'user', content: prompt }],
        fileNames: refs.files.map((r) => r.name),
        model,
        tools: false,
        usageProject: selectedProject?.id,
        usageAction: 'complete-data',
      });
      if (res.error) {
        const message = res.error.message === 'ai_not_configured'
          ? 'The AI isn’t configured, so there are no suggestions — you can still fill these in yourself.'
          : 'Couldn’t reach the AI for suggestions. You can still fill these in yourself.';
        const failed = { key, map: {}, loading: false, error: message };
        setFieldSuggestions(failed);
        return failed;
      }
      addUsage(res.usage);
      const map = {};
      for (const f of parseFieldSuggestions(res.text || '')) map[f.id] = f.suggestions;
      const done = { key, map, loading: false, error: null };
      setFieldSuggestions(done);
      return done;
    })();

    suggestRunRef.current = { key, promise: run };
    try {
      return await run;
    } finally {
      if (suggestRunRef.current.promise === run) suggestRunRef.current = { key: null, promise: null };
    }
  }, [addUsage, loadReferenceFiles, model, selectedProject?.id]);

  const value = useMemo(
    () => ({ messages, input, setInput, busy, switching, error, setError, send, stop, regenerate, branchFrom, branches, activeBranchId, switchBranch, fileName: file?.name, footSlot, genMode, versions, activeVersion, selectVersion, openVersion, questions, submitQuestions, skipQuestions, options, chooseOption, engine, setEngine, model, setModel, tokens, showTokenUsage: appPrefs.showTokenUsage, pendingAsk, resolveAsk, debugAsk, setDebugAsk, selection, addSelection, clearSelection, applyManualEdit, completing, setCompleting, paraPicked, setParaPicked, paraText, setParaText, paraKey, setParaKey, paraScope, threadScope, switchScope, paraSlot, setParaSlot, hoverField, setHoverField, loadIdentities, fields, allFields, fieldsSig, registerFieldsApi, publishFields, setFieldValue, focusField, applyFields, previewFields, endFieldPreview, dropFields, applyGender, applyLocality, clearPick, getDocumentText, fieldSuggestions, ensureFieldSuggestions }),
    [messages, input, busy, switching, error, send, stop, regenerate, branchFrom, branches, activeBranchId, switchBranch, file?.name, footSlot, genMode, versions, activeVersion, selectVersion, openVersion, questions, submitQuestions, skipQuestions, options, chooseOption, engine, setEngine, model, setModel, tokens, appPrefs.showTokenUsage, pendingAsk, resolveAsk, debugAsk, selection, addSelection, clearSelection, applyManualEdit, completing, setCompleting, paraPicked, paraText, paraKey, paraScope, threadScope, switchScope, paraSlot, hoverField, loadIdentities, fields, allFields, fieldsSig, registerFieldsApi, publishFields, setFieldValue, focusField, applyFields, previewFields, endFieldPreview, dropFields, applyGender, applyLocality, clearPick, getDocumentText, fieldSuggestions, ensureFieldSuggestions],
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

// ── Document / Paragraph sub-tabs ───────────────────────────────────────
// A second row under the panel's tab strip, present only while a paragraph is
// picked — with nothing picked there is only the document to talk about.
//
// The two are separate CONVERSATIONS, not two views of one: a paragraph's
// thread starts empty, keeps only what was said about that paragraph, and the
// version cards produced from it stay there too. Switching back to Document
// finds the file-level conversation exactly as it was left.
function AdvisorScopeTabs() {
  const adv = useMultitoolAdvisor();
  if (!adv?.paraPicked || !adv?.paraScope) return null;
  const onDoc = (adv.threadScope || 'document') === 'document';
  const quote = (adv.paraText || '').replace(/\s+/g, ' ').trim();
  return (
    <div className="dv-advisor-subtabs" role="tablist" aria-label="Conversation">
      <button
        type="button"
        role="tab"
        aria-selected={onDoc}
        className={`dv-advisor-subtab${onDoc ? ' is-active' : ''}`}
        onClick={() => adv.switchScope?.('document')}
      >
        Document
      </button>
      <Tooltip content={quote || 'The paragraph you picked'}>
        <button
          type="button"
          role="tab"
          aria-selected={!onDoc}
          className={`dv-advisor-subtab${onDoc ? '' : ' is-active'}`}
          onClick={() => adv.switchScope?.(adv.paraScope)}
        >
          Paragraph
        </button>
      </Tooltip>
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
      {/* A container rather than one big <button>: the footer holds its own
          buttons, and a button inside a button is invalid HTML (browsers drop
          the nesting and the inner control stops working). The main area keeps
          the button semantics via role + keyboard handling. */}
      <div className={`dv-doc-version${active ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`}>
        <Tooltip content="Select to preview it">
          <div
            className="dv-doc-version-main"
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-disabled={disabled || undefined}
            onClick={() => { if (!disabled) onSelect?.(); }}
            onKeyDown={(e) => {
              if (disabled) return;
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(); }
            }}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: toLayoutPx(e.clientX), y: toLayoutPx(e.clientY) }); }}
          >
            <span className={`dv-doc-version-icon${iconKind ? ` is-${iconKind}` : ''}`}>{iconGlyph}</span>
            <span className="dv-doc-version-body">
              <span className="dv-doc-version-name">Version {version}</span>
              <span className="dv-doc-version-format">{format}</span>
            </span>
            {active && <span className="dv-doc-version-dot" aria-hidden="true" />}
          </div>
        </Tooltip>
        {/* Footer actions. Named after the real application the file belongs to
            (Word / PowerPoint / Excel) rather than a generic "open", so it is
            obvious what is about to launch. */}
        <div className="dv-doc-version-actions">
          <button
            type="button"
            className="dv-doc-version-action"
            onClick={onOpenInApp}
            disabled={disabled}
          >
            {OpenInAppGlyph}
            <span>Open in {software}</span>
          </button>
        </div>
      </div>
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

// What one assistant turn cost, shown under its bubble. Input tokens are what
// the model READ for this turn (the thread so far, the document, any attached
// file), output tokens what it WROTE — worth splitting out, because a long
// conversation gets expensive through the input side even when the replies are
// short. Gated on the same "Show token usage" preference as the per-chat pill.
function MessageTokens({ usage }) {
  const input = usage?.input_tokens || 0;
  const output = usage?.output_tokens || 0;
  if (!input && !output) return null;
  const total = input + output;
  return (
    <Tooltip content={`${input.toLocaleString()} in + ${output.toLocaleString()} out`}>
      <div className="dv-bubble-tokens">
        <span className="dv-bubble-tokens-n">{total.toLocaleString()}</span>
        <span className="dv-bubble-tokens-label">tokens</span>
      </div>
    </Tooltip>
  );
}

// One ask_user answer as a readable line, mirroring the shapes makeAskAnswers
// produces: a confirm is yes/no, a free-text is its text, a select is its
// option LABELS (never the raw ids, which mean nothing to the reader).
function askAnswerText(q, a) {
  if (!a) return '';
  if (a.response_type === 'confirm') return a.approved ? 'Yes' : 'No';
  if (a.response_type === 'free_text') return String(a.text || '').trim() || 'Left blank';
  const labels = (a.label || []).filter(Boolean);
  if (labels.length) return labels.join(', ');
  const ids = (a.selected || []).filter(Boolean);
  return ids.length ? ids.join(', ') : 'Left blank';
}

// Scroll position remembered per file path ACROSS AdvisorPanel remounts.
// Selecting a version writes the doc → bumps regenTick → remounts DocPane (and
// this panel), which would otherwise reset the scroll and jump to the bottom.
// Persisting here lets the panel restore exactly where the user was.
const advisorScrollPos = new Map(); // filePath -> { top, atBottom }

// Per-file AI advisor thread — the AI-advisor tab's content. The composer now
// lives in the shared Multitool footer (MultitoolComposer); this just renders
// the conversation, reading the lifted advisor state from context.
// How long the empty state takes to leave. Long enough to be seen going, short
// enough that the first reply is not waiting on it.
const ADVISOR_EMPTY_EXIT_MS = 260;

// What the thread says before it is a thread. Not decoration: an empty pane
// gives no clue what this thing can be asked, and "type here" is the one thing
// the composer below already says. So it names the two useful facts — that the
// assistant is looking at THIS file (or this paragraph), and the kinds of
// question that get a good answer out of it.
//
// It stays mounted through its exit, and is positioned OUT of flow, so sending
// the first message does not make the reply appear where the heading was
// standing — the words fade and lift, the thread arrives underneath.
function AdvisorEmpty({ show, paragraph }) {
  const [mounted, setMounted] = useState(show);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (show) { setMounted(true); setLeaving(false); return undefined; }
    if (!mounted) return undefined;
    setLeaving(true);
    const t = window.setTimeout(() => { setMounted(false); setLeaving(false); }, ADVISOR_EMPTY_EXIT_MS);
    return () => window.clearTimeout(t);
  }, [show, mounted]);
  if (!mounted) return null;
  return (
    <div className={`dv-advisor-empty${leaving ? ' is-leaving' : ''}`} aria-hidden={leaving || undefined}>
      <span className="dv-advisor-empty-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H14l6 6v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z" />
          <path d="M14 4v6h6" />
          <path d="M8 13.5h7M8 16.5h4.5" />
        </svg>
      </span>
      <p className="dv-advisor-empty-title">
        {paragraph ? 'Ask about this paragraph' : 'Ask about this document'}
      </p>
      <p className="dv-advisor-empty-sub">
        {paragraph
          ? 'This thread belongs to the paragraph you picked. Have it rewritten, tightened or translated — or ask what it actually commits you to.'
          : 'It has the file open in front of it. Ask for a summary, what to watch out for, a clause in plain words, or a draft to work from.'}
      </p>
    </div>
  );
}

function AdvisorPanel({ file }) {
  const adv = useMultitoolAdvisor();
  const messages = adv?.messages || [];
  const busy = adv?.busy || false;
  const switching = adv?.switching || false;
  const error = adv?.error || null;
  const genMode = adv?.genMode || false;
  const showTokenUsage = !!adv?.showTokenUsage;
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
  const prevLenRef = useRef(messages.length);
  const [typing, setTyping] = useState(null);   // index of the AI msg being revealed
  const [copiedIdx, setCopiedIdx] = useState(null);

  // The "Split from here" pill is rendered OUTSIDE the scroll (portalled to
  // <body>) so it can overflow past the sidebar's right edge into the gutter —
  // a child of the scroll would be clipped by overflow:auto. We track which seam
  // is hovered + where to place the floating pill (viewport coords; left edge at
  // the scrollbar's right edge). A short hide-delay bridges the gap between the
  // in-scroll hover strip and the pill that sits just outside it.
  // Two stages, so sweeping the pointer through the thread doesn't fling panels
  // open behind it:
  //   1. HOVER  — the seam under the pointer draws its divider, nothing else.
  //               Moving on (or moving within the seam) just moves the line.
  //   2. DWELL  — hold still for DWELL_MS and the seam opens: the gap above and
  //               below the divider grows, and a Split button fades in centred
  //               on the line, ready to click.
  // Any movement inside the seam re-arms the dwell timer, so "holding still" is
  // what opens it, not merely "being there".
  const [branchHover, setBranchHover] = useState(null); // index whose divider is drawn
  const [branchOpen, setBranchOpen] = useState(null);   // index that has opened up
  const branchClearRef = useRef(null);
  const branchDwellRef = useRef(null);
  const DWELL_MS = 360;
  const cancelBranchHide = () => { if (branchClearRef.current) { clearTimeout(branchClearRef.current); branchClearRef.current = null; } };
  const cancelDwell = () => { if (branchDwellRef.current) { clearTimeout(branchDwellRef.current); branchDwellRef.current = null; } };
  // Re-armed on every mousemove over the seam: the callback only runs once the
  // pointer has been still for the whole delay.
  const armDwell = (index) => {
    cancelDwell();
    branchDwellRef.current = window.setTimeout(() => setBranchOpen(index), DWELL_MS);
  };
  const enterBranch = (index) => {
    cancelBranchHide();
    setBranchHover(index);
    armDwell(index);
  };
  const moveBranch = (index) => {
    cancelBranchHide();
    // Already open: leave it be. Re-arming here would make the panel flicker
    // shut and back open as the pointer travels toward the button.
    if (branchOpen === index) return;
    armDwell(index);
  };
  const hideBranchSoon = () => {
    cancelDwell();
    cancelBranchHide();
    branchClearRef.current = window.setTimeout(() => { setBranchHover(null); setBranchOpen(null); }, 150);
  };
  // Timers must not outlive the panel.
  useEffect(() => () => { cancelDwell(); cancelBranchHide(); }, []);

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
      {/* No masthead and no compact-on-scroll bar: the side panel's tab strip
          already names this pane, so a title inside it was a second label for
          the same thing, eating the height the thread wants. */}
      {/* Outside the scroller on purpose — which conversation you are in has to
          stay visible while you read back through it. */}
      <AdvisorScopeTabs />
      {/* The picked paragraph's Save-as-new-version action heads its own thread.
          The document pane renders it into this node — it owns the pick and the
          edit tracking behind it. Mounted only on the Paragraph sub-tab, and
          only while there are unsaved edits, so the two sub-tabs are otherwise
          identical: same thread shape, same footer. */}
      {adv?.paraPicked && (adv.threadScope || 'document') !== 'document' && (
        <div className="dv-para-panel" ref={adv.setParaSlot} />
      )}
      <div className={`dv-advisor-scroll${asking ? ' is-asking' : ''}`} ref={scrollRef} onScroll={onScroll}>
        {/* Branch nav — one pill per split conversation. The original ("Main")
            stays so you can navigate back after splitting. Only shown once at
            least one split exists. */}
        {branches.length > 1 && (adv?.threadScope || 'document') === 'document' && (
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
        {/* A direct child of the SCROLLER, not of the chat block — it centres
            itself against the pane, and the chat block is only as tall as its
            (absent) messages. */}
        <AdvisorEmpty
          show={messages.length === 0 && !busy}
          paragraph={(adv?.threadScope || 'document') !== 'document'}
        />
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
                          ? (m.qa?.length
                            ? (
                              <div className="dv-bubble-qa">
                                {m.qa.map((qa, qi) => (
                                  <div className="dv-bubble-qa-item" key={qi}>
                                    <div className="dv-bubble-qa-q">{qa.prompt}</div>
                                    <div className="dv-bubble-qa-a">{qa.answer}</div>
                                  </div>
                                ))}
                              </div>
                            )
                            : m.content)
                          : typing === i
                            ? <AdvTypewriter text={m.content || ''} onTick={() => scrollToBottom(false)} onDone={() => setTyping((t) => (t === i ? null : t))} />
                            : <div className="aichat-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content || ''}</ReactMarkdown></div>}
                      </div>
                      {/* What this turn cost, under its own bubble. Same
                          "Show token usage" setting as the per-chat pill in the
                          composer, so both indicators appear together or not at
                          all. Older messages from a saved thread have no usage
                          recorded and simply show nothing. */}
                      {showTokenUsage && m.role === 'assistant' && m.usage && (
                        <MessageTokens usage={m.usage} />
                      )}
                      {/* What this message was pointed at — the passage picked in
                          the document preview. Sits under the bubble so the ask
                          and its target read as one thing. */}
                      {m.passage && (
                        <Tooltip content={m.passage}>
                          <div className="dv-bubble-selchip">
                            <span className="dv-bubble-selchip-ico" aria-hidden="true">
                              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M4 7h11M4 12h16M4 17h9" />
                              </svg>
                            </span>
                            <span className="dv-bubble-selchip-label">Selected passage</span>
                            <span className="dv-bubble-selchip-text">“{m.passage}”</span>
                          </div>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                );
                // A hover control to the right of an AI turn (except the last)
                // splits a new conversation from that point. It shows after an AI
                // text reply, or — when that reply produced a file — after the
                // generated file card, never between the note and its document.
                const aiText = m.role === 'assistant' && messages[i + 1]?.role !== 'artifact';
                const fileCard = m.role === 'artifact';
                // No split seams on a paragraph's thread — branches are a
                // document-conversation feature (see branchFrom).
                const canBranch = (aiText || fileCard) && i < messages.length - 1 && !busy
                  && (adv?.threadScope || 'document') === 'document';
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
                        className={`dv-branch-anchor${branchHover === i ? ' is-active' : ''}${branchOpen === i ? ' is-open' : ''}`}
                        onMouseEnter={() => enterBranch(i)}
                        onMouseMove={() => moveBranch(i)}
                        onMouseLeave={hideBranchSoon}
                      >
                        <span className="dv-branch-line" />
                        {/* Only mounted once the seam has opened, so a fast
                            sweep never leaves buttons in its wake. */}
                        {branchOpen === i && (
                          <Tooltip content="Split a new conversation from here — keeps everything up to this message">
                            <button
                              type="button"
                              className="dv-branch-split"
                              onClick={() => {
                                adv?.branchFrom?.(i);
                                setBranchHover(null);
                                setBranchOpen(null);
                              }}
                            >
                              {AdvBranchGlyph}<span>Split from here</span>
                            </button>
                          </Tooltip>
                        )}
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
function SpreadsheetPane({ file, url, onExportPdf, onOpenNative }) {
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
          <OpenNativeButton onOpen={onOpenNative} kind="xlsx" />
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
  // A picked paragraph no longer gets a tab of its own here — it opens a
  // Document / Paragraph sub-tab row INSIDE the advisor, because what it really
  // selects is which conversation you are in. Landing on Metadata when you
  // clicked a paragraph would be the wrong answer, so pull focus back.
  const paraPicked = !!useMultitoolAdvisor()?.paraPicked;
  useEffect(() => {
    if (paraPicked) setRightTab((cur) => (cur === 'metadata' ? 'advisor' : cur));
  }, [paraPicked]);

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
      {/* Documents get two panes: the Generate (AI) advisor and Metadata. Text
          extraction lives in the Multitool footer, not a tab. */}
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
// Rendered blocks that count as an editable "paragraph". docx-preview emits
// Word paragraphs as <p> (list items too — they're <p style="display:list-item">)
// and headings as <h1>-<h6>. Tables, images and drawings are deliberately out:
// a whole table isn't a paragraph, and making one editable would let a stray
// keystroke rewrite its markup.
// ── "Complete data": empty-field detection ───────────────────────────────
// A drafted document arrives with blanks where the facts go — bracket fields
// ("[Client name]"), mail-merge braces, angle tags, or the run of underscores
// that stands in for a signature line. "Complete data" finds every one of them,
// marks it in the preview, and fills it from the side panel.
//
// Deliberately conservative about what counts as a blank: three dots is an
// ellipsis in ordinary prose and "[3]" is a footnote marker, so neither is
// treated as a field. A miss is harmless; a false positive would offer to
// rewrite real text.
// How much of the project folder a suggestion run is allowed to read. Extracting
// text from PDFs and Word files is slow, so this is a budget, not a limit on
// what the user may keep in the folder: the newest files are the ones a draft is
// usually being completed from.
const REF_FILE_LIMIT = 8;
const REF_FILE_CHARS = 5000;

// How much of the Files tab the ADVISOR carries per turn. The inventory is just
// names, so it is nearly free and can be generous; reading a file costs a text
// extraction, so only the ones the user actually named get read, and only a few.
const PROJECT_FILE_LIST_MAX = 80;
const PROJECT_FILE_READ_MAX = 3;
// The folder listing is re-read at most this often — a chat turn takes longer
// than this anyway, so it only collapses the bursts (send, retry, ask_user
// resume) that would otherwise walk the folder three times in a row.
const PROJECT_LIST_TTL_MS = 15000;
// Identity records change far less often than the folder does.
const IDENTITY_LIST_TTL_MS = 60000;

// Pull the suggestions object out of a model reply. It is asked for bare JSON,
// but a fenced block or a sentence of preamble is the usual failure mode, so
// fall back to the outermost braces before giving up.
function parseFieldSuggestions(text) {
  const tryParse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text || '');
  const candidates = [text, fenced?.[1]];
  const first = (text || '').indexOf('{');
  const last = (text || '').lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    const obj = c ? tryParse(c.trim()) : null;
    const list = Array.isArray(obj?.fields) ? obj.fields : Array.isArray(obj) ? obj : null;
    if (!list) continue;
    return list
      .filter((f) => f && typeof f.id === 'string')
      .map((f) => ({
        id: f.id,
        suggestions: (Array.isArray(f.suggestions) ? f.suggestions : [])
          .filter((sg) => sg && typeof sg.value === 'string' && sg.value.trim())
          .slice(0, 3)
          .map((sg) => ({
            value: sg.value.trim(),
            source: sg.source === 'file' && sg.file ? 'file' : 'context',
            file: sg.source === 'file' ? String(sg.file || '') : '',
            why: typeof sg.why === 'string' ? sg.why.trim().slice(0, 90) : '',
          })),
      }));
  }
  return [];
}

const FIELD_PATTERNS = [
  // DocVex's OWN placeholder shape, and the one every generated document is
  // told to use: doubled square brackets around a description of what goes in
  // the gap. It exists because single brackets are ambiguous — "[3]" is a
  // footnote, "[sic]" is an editorial note — so a single-bracket blank has to
  // be judged by what is inside it (see looksLikeField), and judgement is where
  // a blank gets missed. Nothing else in a legal document is written "[[…]]",
  // so this shape needs no judgement at all: it is always a field.
  /\[\[[^\]\n]{1,120}\]\]/g,   // [[the seller's full name]]
  /\[[^\][\n]{0,80}\]/g,      // [Client name] — and the bare "[...]" rule
  /\{\{[^{}\n]{1,80}\}\}/g,   // {{client_name}}
  /\{[^{}\n]{1,80}\}/g,       // {client_name}
  /<[^<>\n]{1,80}>/g,         // <client name>
  /_{3,}/g,                   // ________ (signature / fill-in rule)
  /\.{4,}/g,                  // ......... (dotted rule, NOT an ellipsis)
  /…{2,}/g,              // …… (repeated ellipsis characters)
];

// A blank rule (underscores / dots) always counts. A delimited placeholder only
// counts when what's inside it reads like a label — at least one letter, so
// citation and footnote markers such as "[3]" or "[2020]" are left alone.
function looksLikeField(raw) {
  // Ours by construction — no test to fail.
  if (/^\[\[[\s\S]*\]\]$/.test(raw)) return true;
  if (/^[_.…]+$/.test(raw)) return true;
  // A bracketed rule — "[...]", "[…]", "[___]", "[ ]". Romanian formulas write
  // whole identification clauses this way, labelling each gap in the prose
  // BEFORE it ("str. [...], nr. [...]") rather than inside it. Nothing but
  // filler between the brackets, so a citation marker like "[3]" — which has a
  // digit — is still excluded.
  if (/^[[{<][\s._…-]*[\]}>]$/.test(raw)) return true;
  const inner = raw.replace(/^[[{<]+/, '').replace(/[\]}>]+$/, '').trim();
  if (!inner || inner.length > 80) return false;
  // A brace group holding declarations is a CSS rule, not a blank — no
  // placeholder a person writes contains a semicolon or a property colon.
  // (The <style> element is skipped outright above; this catches stylesheet
  // text that reached the flow some other way.)
  if (/^[{<]/.test(raw) && /[;:]/.test(inner)) return false;
  return /[A-Za-zÀ-ɏ]/.test(inner);
}

// Human-readable name for a blank, used as the panel's field heading.
function fieldLabel(raw, hint) {
  const inner = raw
    .replace(/^[[{<]+/, '').replace(/[\]}>]+$/, '')
    .replace(/[_.…]{3,}/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // "[...]" and "________" say nothing about themselves. In a Romanian
  // identification clause the label is the prose immediately before the gap —
  // "str. [...]", "CNP [...]" — so that is what names the field.
  if (!/[A-Za-zÀ-ɏ]/.test(inner)) return String(hint || '').trim() || inner || 'Blank space';
  return inner;
}

// The words that introduce a blank: everything since the previous blank, cut
// back to the last separator so a whole sentence doesn't become the label.
function labelHintBefore(text) {
  const tail = String(text || '').slice(-120);
  const cut = Math.max(tail.lastIndexOf(','), tail.lastIndexOf(';'), tail.lastIndexOf('\n'));
  return (cut >= 0 ? tail.slice(cut + 1) : tail).replace(/\s+/g, ' ').trim().slice(-60);
}

// Every placeholder in one string, left to right, without overlaps. Patterns
// are run independently and merged, so the longest match wins where two shapes
// start at the same spot (e.g. "{{x}}" beats the inner "{x}").
function matchFields(text) {
  const hits = [];
  for (const re of FIELD_PATTERNS) {
    re.lastIndex = 0;
    let m = re.exec(text);
    while (m) {
      if (looksLikeField(m[0])) hits.push({ start: m.index, raw: m[0] });
      m = re.exec(text);
    }
  }
  hits.sort((a, b) => a.start - b.start || b.raw.length - a.raw.length);
  const out = [];
  let end = -1;
  for (const h of hits) {
    if (h.start < end) continue;
    out.push(h);
    end = h.start + h.raw.length;
  }
  return out;
}

// Make sure a paragraph holding a blank is tracked like any other editable
// block. paginateDocx only tags the direct children of each page's article, so
// anything nested — above all a Word TABLE, which is where fill-in forms
// normally put their blanks — arrives untagged, and a value typed into it would
// be invisible to the edit tracking and silently dropped on save.
function tagFieldBlock(host, block) {
  if (!block || !host?.contains(block)) return block || null;
  if (block.classList.contains('dv-docx-para')) return block;
  block.classList.add('dv-docx-para');
  if (block.dataset.paraIndex == null) {
    const used = Array.from(host.querySelectorAll('[data-para-index]'))
      .map((n) => Number(n.dataset.paraIndex))
      .filter((n) => Number.isFinite(n));
    block.dataset.paraIndex = String(used.length ? Math.max(...used) + 1 : 0);
  }
  return block;
}

// Find every blank in the rendered document, optionally wrapping each one in a
// marker span. Both modes walk the same nodes in the same order, so the ids they
// hand out line up: the pane can survey a freshly rendered document WITHOUT
// touching it (to warm the suggestions in the background), then wrap for real
// when the mode is actually entered, and the two agree on what f3 refers to.
//
// Each field remembers the paragraph it lives in (so a filled value can be
// saved back through the ordinary manual-edit path) and the sentence around it
// (so the AI has something to reason from when suggesting values). When
// wrapping, the paragraph's pre-fill state is captured in exactly the shape
// applyEditable uses, so filling a blank shows up as a normal edit.
// Where in the joined text a position falls, as a (node, offset) pair.
function locateInSegments(segs, pos) {
  for (const sg of segs) {
    if (pos >= sg.start && pos <= sg.end) return { node: sg.node, offset: pos - sg.start };
  }
  return null;
}

// Replace one placeholder — however many text nodes it is spread over — with a
// single marker span. A DOM Range does the work, so a blank whose opening
// bracket sits in one run and whose closing bracket sits in the next is wrapped
// as one field rather than missed.
//
// Collapsing the range's original runs into one span means a placeholder split
// mid-word by a formatting change comes out uniformly styled, which is what it
// should have been.
function wrapFieldRange(segs, hit, id) {
  const from = locateInSegments(segs, hit.start);
  const to = locateInSegments(segs, hit.start + hit.raw.length);
  if (!from || !to) return false;
  try {
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    const span = document.createElement('span');
    span.className = 'dv-field';
    span.dataset.dvfield = id;
    span.dataset.dvfieldRaw = hit.raw;
    span.textContent = hit.raw;
    range.deleteContents();
    range.insertNode(span);
    return true;
  } catch {
    // A range that can't be built (a node detached between the walk and here)
    // costs one blank, not the whole scan.
    return false;
  }
}

const FIELD_BLOCK_SEL = '.dv-docx-para, p, h1, h2, h3, h4, h5, h6, li, td, th';

function walkDocFields(host, { wrap }) {
  if (!host) return [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = n.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // docx-preview injects the document's OWN stylesheet as a <style> element
      // inside the host, and a CSS rule body ("{ margin: 0 }") matches the
      // brace-placeholder pattern perfectly — that is how stylesheet text ended
      // up listed as blanks to fill in. Skip anything that isn't visible prose,
      // and skip the page-number chips pagination adds.
      if (parent.closest('style, script, template, head')) return NodeFilter.FILTER_REJECT;
      if (parent.closest('.dv-docx-pagenum')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  // Group the text nodes by the BLOCK they belong to, and scan each block's
  // text as one string. Scanning node by node used to miss any placeholder Word
  // had split across runs — which it does at every formatting change, and often
  // for no visible reason at all — so a document could show a blank the panel
  // never listed. Joining first means the shape is matched against the text the
  // reader actually sees.
  const byBlock = new Map();
  let cur = walker.nextNode();
  while (cur) {
    const block = cur.parentElement?.closest(FIELD_BLOCK_SEL) || cur.parentElement;
    if (block) {
      if (!byBlock.has(block)) byBlock.set(block, []);
      byBlock.get(block).push(cur);
    }
    cur = walker.nextNode();
  }

  const out = [];
  let seq = 0;
  for (const [blockEl, nodes] of byBlock) {
    const segs = [];
    let joined = '';
    for (const n of nodes) {
      segs.push({ node: n, start: joined.length, end: joined.length + n.nodeValue.length });
      joined += n.nodeValue;
    }
    const hits = matchFields(joined);
    if (!hits.length) continue;

    let block = blockEl.matches(FIELD_BLOCK_SEL) ? blockEl : (blockEl.closest(FIELD_BLOCK_SEL) || null);
    const context = (block?.textContent || joined).trim().slice(0, 400);
    if (wrap) {
      block = tagFieldBlock(host, block);
      // Remember the paragraph as it was drafted — Revert restores the HTML,
      // and a save is diffed against the markdown. Captured BEFORE any wrapping
      // so the marker spans aren't part of "as drafted".
      if (block && block.dataset.originalText == null) {
        block.dataset.originalText = block.textContent.trim();
        block.dataset.originalHtml = block.innerHTML;
        block.dataset.originalMd = serializeParagraphMarkdown(block);
      }
    }

    // Ids run in document order; the wrapping runs BACK TO FRONT, so each edit
    // leaves the offsets of everything before it untouched.
    const ids = hits.map(() => `f${(seq += 1)}`);
    if (wrap) {
      for (let i = hits.length - 1; i >= 0; i -= 1) wrapFieldRange(segs, hits[i], ids[i]);
    }
    let prevEnd = 0;
    hits.forEach((h, i) => {
      const hint = labelHintBefore(joined.slice(prevEnd, h.start));
      prevEnd = h.start + h.raw.length;
      out.push({
        id: ids[i],
        raw: h.raw,
        label: fieldLabel(h.raw, hint),
        context,
        paraIndex: block?.dataset.paraIndex != null ? Number(block.dataset.paraIndex) : null,
      });
    });
  }
  return out;
}

// Cheap stable fingerprint of the document's text — tells "a new version was
// written" apart from "the panel was closed and reopened", which is the whole
// difference between re-asking the AI and reusing the answers already given.
function docSignature(text) {
  const str = text || '';
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return `${str.length}:${h.toString(36)}`;
}

// Survey the document without touching it — used to warm suggestions in the
// background, before the user has asked for anything.
function collectDocFields(host) {
  return walkDocFields(host, { wrap: false });
}

// Mark up the document for real, ready to be filled in.
function scanDocFields(host) {
  clearDocFields(host);
  return walkDocFields(host, { wrap: true });
}

// Unwrap the markers, keeping whatever text each one currently shows (so values
// already filled in survive leaving the mode). The paragraphs are normalised
// afterwards, because the split text nodes would otherwise confuse the markdown
// serializer the save path runs.
function clearDocFields(host) {
  if (!host) return;
  host.querySelectorAll('.dv-field').forEach((el) => {
    el.replaceWith(document.createTextNode(el.textContent || ''));
  });
  try { host.normalize(); } catch { /* detached node — nothing to clean up */ }
}

const PARA_BLOCK_TAGS = /^(P|H[1-6]|LI)$/;

function paginateDocx(host) {
  const wrapper = host?.querySelector('.docx-wrapper');
  if (!wrapper) return 0;
  const sections = Array.from(wrapper.querySelectorAll(':scope > section.docx'));
  if (!sections.length) return 0;
  let pageWidth = 0;
  const allPages = []; // every page sheet across all sections, for numbering
  let paraIndex = 0;   // document-order index stamped on each selectable block

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
      // Paragraph-level affordance: every block that actually carries text gets
      // a document-order index so the pane can hover-highlight it and toggle it
      // into a selection. Empty spacer paragraphs stay inert (Word documents are
      // full of them and highlighting blank strips reads as noise).
      if (PARA_BLOCK_TAGS.test(block.tagName) && block.textContent.trim()) {
        block.classList.add('dv-docx-para');
        block.dataset.paraIndex = String(paraIndex++);
        // Word list items hang their bullet / number to the LEFT of the text
        // box (docx-preview renders them as `display:list-item` with a negative
        // text-indent), so a highlight painted on the box alone leaves the dot
        // stranded outside it. Grow the box leftwards by exactly the overhang
        // and pull the margin back by the same amount: the content box width —
        // and therefore the line wrapping and the measured height — is
        // unchanged, but the marker is now inside the paint area.
        const pcs = getComputedStyle(block);
        const overhang = -(parseFloat(pcs.textIndent) || 0);
        if (overhang > 0) {
          block.style.paddingLeft = `${(parseFloat(pcs.paddingLeft) || 0) + overhang}px`;
          block.style.marginLeft = `${(parseFloat(pcs.marginLeft) || 0) - overhang}px`;
        }
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
// "Open in Word / PowerPoint / Excel" — hands the file to the OS default app
// for its type. The in-app preview is a reconstruction of the file; this is
// the escape hatch to the real thing. Electron only — `openPath` is a no-op
// success on web, so the button is hidden there rather than lying.
const NATIVE_APP_LABEL = { docx: 'Word', pptx: 'PowerPoint', xlsx: 'Excel', pdf: 'the PDF viewer' };

function OpenNativeButton({ onOpen, kind }) {
  const app = NATIVE_APP_LABEL[kind] || 'the default app';
  if (!onOpen || !isElectron) return null;
  return (
    <Tooltip content={`Open this file in ${app} on your computer`}>
      <button type="button" className="dv-open-native" onClick={onOpen}>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 4h6v6M20 4l-8.5 8.5" />
          <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
        </svg>
        Open in {app}
      </button>
    </Tooltip>
  );
}

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

// Serialize a rendered paragraph's inline formatting back to markdown.
//
// A version is stored as markdown source, so saving an edited paragraph means
// turning what's on screen back into that shape — otherwise every save flattens
// the paragraph to plain text and the document loses its bold and italics. Runs
// are read from COMPUTED style (docx-preview renders Word runs as styled spans,
// and execCommand adds <b>/<i>), with the paragraph's own style as the baseline
// so a heading that is bold throughout doesn't come back wrapped in `**`.
function serializeParagraphMarkdown(el) {
  if (!el) return '';
  const base = getComputedStyle(el);
  const baseBold = (parseInt(base.fontWeight, 10) || 400) >= 600;
  const baseItalic = base.fontStyle === 'italic' || base.fontStyle === 'oblique';
  const runs = [];
  const walk = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walk.nextNode())) {
    const text = node.nodeValue;
    if (!text) continue;
    const cs = getComputedStyle(node.parentElement || el);
    const bold = ((parseInt(cs.fontWeight, 10) || 400) >= 600) !== baseBold;
    const italic = (cs.fontStyle === 'italic' || cs.fontStyle === 'oblique') !== baseItalic;
    const prev = runs[runs.length - 1];
    if (prev && prev.bold === bold && prev.italic === italic) prev.text += text;
    else runs.push({ text, bold, italic });
  }
  let out = '';
  for (const r of runs) {
    // Markers must hug the text — `** bold **` isn't emphasis in markdown — so
    // any edge whitespace is lifted outside the wrapper.
    const lead = (/^\s*/.exec(r.text) || [''])[0];
    const tail = (/\s*$/.exec(r.text) || [''])[0];
    const core = r.text.slice(lead.length, r.text.length - tail.length);
    if (!core) { out += r.text; continue; }
    const mark = r.bold && r.italic ? '***' : r.bold ? '**' : r.italic ? '*' : '';
    out += `${lead}${mark}${core}${mark}${tail}`;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// Renders a .docx as the formatted final product via docx-preview, re-paginated
// into Word-like page sheets. Toolbar carries the reconstruction notice, a
// per-page page-number toggle, Open-in-Word and Convert-to-PDF.
function DocxRenderPane({ url, onExportPdf, onOpenNative }) {
  const hostRef = useRef(null);
  const pageWidthRef = useRef(0);
  const [showPageNumbers, setShowPageNumbers] = useState(true);
  const adv = useMultitoolAdvisor();

  // ── Picking, editing and selecting ───────────────────────────────────────
  // Every text block rendered by paginateDocx carries `.dv-docx-para` + a
  // document-order index. Clicking one picks it AND turns it into an editable
  // region: the document can be corrected in place, formatted like in Word, or
  // handed to the AI with a prompt — all from the bar at the bottom of the pane.
  //
  // The nodes belong to docx-preview, not React, so state lives on the DOM
  // (classes + data attributes) and only what the bar renders is mirrored into
  // React. Each paragraph remembers the HTML *and* the markdown it had when it
  // first became editable: the HTML is what Revert restores (so undo keeps the
  // rich text), the markdown is what a save is diffed against.
  const [paras, setParas] = useState([]);   // picked: [{ index, text }]
  const [edits, setEdits] = useState([]);   // changed: [{ index, before, after }]
  const [saveState, setSaveState] = useState(null); // null | 'saving' | error string
  const [prompt, setPrompt] = useState('');
  const lastParaRef = useRef(null);  // anchor index for shift-click ranges
  // Why the last render attempt failed, as { title, detail } — or null. Kept in
  // React (rather than written into the host as raw HTML) so the failure can
  // offer the same escape hatches the rest of the pane has.
  const [renderErr, setRenderErr] = useState(null);
  // Bumped once every time the document finishes rendering — the blanks scan
  // keys off it so a new version is re-scanned rather than left stale.
  const [renderTick, setRenderTick] = useState(0);
  // Bumped to re-run the render effect: by the automatic retry below and by the
  // user's "Try again". `attemptRef` counts retries PER URL, so switching files
  // always starts from a clean budget without racing a reset effect.
  const [reloadKey, setReloadKey] = useState(0);
  const attemptRef = useRef({ url: null, n: 0 });
  const retryRender = useCallback(() => {
    attemptRef.current = { url: null, n: 0 };
    setRenderErr(null);
    setReloadKey((k) => k + 1);
  }, []);

  const paraNodes = useCallback(
    () => Array.from(hostRef.current?.querySelectorAll('.dv-docx-para') || []),
    [],
  );

  // Resolve the text block a node sits in, and make sure it is tagged.
  //
  // paginateDocx normally stamps `.dv-docx-para` + a document-order index on
  // every text block as it slices the flow into pages. But picking and editing
  // must not be hostage to that: if pagination was skipped or bailed part-way,
  // the class is simply absent and every gesture here silently found nothing to
  // act on. So fall back to the underlying block element and tag it on the spot
  // — from that point it behaves exactly like a block pagination tagged.
  const blockAt = useCallback((node) => {
    const host = hostRef.current;
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el || !host?.contains(el)) return null;
    const block = el.closest?.('.dv-docx-para')
      || el.closest?.('p, h1, h2, h3, h4, h5, h6, li');
    if (!block || !host.contains(block) || !block.textContent.trim()) return null;
    if (!block.classList.contains('dv-docx-para')) {
      block.classList.add('dv-docx-para');
      // Index after everything already tagged, so ordering stays sane for
      // shift-click ranges even when blocks get tagged out of order.
      if (block.dataset.paraIndex == null) {
        const used = Array.from(host.querySelectorAll('[data-para-index]'))
          .map((n) => Number(n.dataset.paraIndex))
          .filter((n) => Number.isFinite(n));
        block.dataset.paraIndex = String(used.length ? Math.max(...used) + 1 : 0);
      }
    }
    return block;
  }, []);

  const syncParas = useCallback(() => {
    setParas(
      paraNodes()
        .filter((el) => el.classList.contains('is-selected'))
        .map((el) => ({ index: Number(el.dataset.paraIndex), text: el.textContent.trim() }))
        .sort((a, b) => a.index - b.index),
    );
  }, [paraNodes]);

  const syncEdits = useCallback(() => {
    const list = [];
    paraNodes().forEach((el) => {
      const before = el.dataset.originalText;
      if (before == null) return;
      const after = serializeParagraphMarkdown(el);
      const changed = after !== el.dataset.originalMd;
      el.classList.toggle('is-edited', changed);
      if (changed) list.push({ index: Number(el.dataset.paraIndex), before, after });
    });
    setEdits(list);
  }, [paraNodes]);

  const applyEditable = useCallback(() => {
    paraNodes().forEach((el) => {
      const picked = el.classList.contains('is-selected');
      if (!picked) { el.removeAttribute('contenteditable'); return; }
      if (el.getAttribute('contenteditable') === 'true') return;
      // Remember the paragraph exactly as the AI wrote it: the HTML is what
      // Revert restores (so undo keeps the rich text), the markdown is what a
      // save is diffed against.
      if (el.dataset.originalText == null) {
        el.dataset.originalText = el.textContent.trim();
        el.dataset.originalHtml = el.innerHTML;
        el.dataset.originalMd = serializeParagraphMarkdown(el);
      }
      el.setAttribute('contenteditable', 'true');
      el.setAttribute('spellcheck', 'true');
    });
  }, [paraNodes]);

  const clearParas = useCallback(() => {
    paraNodes().forEach((el) => {
      el.classList.remove('is-selected');
      el.removeAttribute('contenteditable');
    });
    // The blank the fields panel had marked is marked no longer: dropping the
    // pick closes that panel, so the ring it left on the span in the document
    // would otherwise sit there with nothing pointing at it.
    hostRef.current?.querySelectorAll('.dv-field.is-active, .dv-field.is-flash')
      .forEach((el) => el.classList.remove('is-active', 'is-flash'));
    lastParaRef.current = null;
    setParas([]);
  }, [paraNodes]);

  // Commit the manual edits: the advisor patches them into the active version's
  // source, rebuilds the file, and drops a version card in the thread. The
  // preview re-reads from disk once the file lands, which resets the edit state.
  const saveEdits = useCallback(async () => {
    if (!adv?.applyManualEdit || !edits.length || saveState === 'saving') return;
    setSaveState('saving');
    const res = await adv.applyManualEdit(edits);
    if (res?.ok) { setSaveState(null); return; }
    setSaveState(
      res?.error === 'no_version'
        ? 'Nothing to save into — the AI hasn’t written a version of this document yet.'
        : res?.error === 'not_found'
          ? 'Couldn’t place that paragraph back in the document source.'
          : 'Couldn’t save the edit.',
    );
    window.setTimeout(() => setSaveState((v) => (v === 'saving' ? v : null)), 5000);
  }, [adv, edits, saveState]);
  // Enter-to-save is bound inside a DOM listener that must not be re-registered
  // on every keystroke, so it reads the latest handler through a ref.
  const saveRef = useRef(saveEdits);
  useEffect(() => { saveRef.current = saveEdits; }, [saveEdits]);

  // Same reason: the registered API is built once and must reach the latest
  // handler without being rebuilt on every render.
  // What the blanks read before a party preview started, so leaving the chip
  // puts them back. Null when no preview is running.
  // ── Trimming what doesn't apply ───────────────────────────────────
  // A house has no block, stair, floor or flat. Those blanks are not gaps
  // left empty — they are clauses the document should not be carrying at
  // all, so each one goes together with the words that introduce it and the
  // comma that separates it: ", bl. [...]" disappears whole, leaving
  // "…nr. 12, București" rather than "…nr. 12, bl. , sc. , București".
  const dropFieldsIn = useCallback((ids, { silent } = {}) => {
    const host = hostRef.current;
    if (!host || !ids?.length) return;
    // Back to front, so each deletion leaves the offsets before it valid.
    const spans = ids
      .map((id) => host.querySelector(`[data-dvfield="${id}"]`))
      .filter(Boolean)
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1))
      .reverse();
    for (const span of spans) {
      const block = span.closest('.dv-docx-para') || span.parentElement;
      if (!block) continue;
      // Every text node in the block, including the spans' own, so an
      // offset in the joined text maps back to a (node, offset) pair.
      const segs = [];
      let joined = '';
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let n = walker.nextNode();
      let spanStart = -1;
      while (n) {
        if (spanStart < 0 && span.contains(n)) spanStart = joined.length;
        segs.push({ node: n, start: joined.length, end: joined.length + n.nodeValue.length });
        joined += n.nodeValue;
        n = walker.nextNode();
      }
      if (spanStart < 0) continue;
      const spanEnd = spanStart + span.textContent.length;
      const before = joined.slice(0, spanStart);
      // Cut from the separator that introduced this clause — or, with none,
      // from the start of the label immediately before the gap.
      const cut = Math.max(before.lastIndexOf(','), before.lastIndexOf(';'));
      const from = cut >= 0 ? cut : spanStart;
      const at = (pos) => {
        for (const sg of segs) if (pos >= sg.start && pos <= sg.end) return { node: sg.node, offset: pos - sg.start };
        return null;
      };
      const a = at(from);
      const b = at(spanEnd);
      if (!a || !b) continue;
      try {
        const range = document.createRange();
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
        range.deleteContents();
      } catch { /* one clause left in place is better than a broken paragraph */ }
      // deleteContents empties the marker but leaves the element behind.
      if (!span.textContent) span.remove();
    }
    try { host.normalize(); } catch { /* detached */ }
    if (!silent) syncEdits();
  }, [syncEdits]);
  // Resolve the clause's gendered forms for this party — "domiciliat(ă)"
  // and "Domnul/Doamna" have one right answer once you know who it is.
  // Applied per TEXT NODE, and never inside a marker span, so the values
  // just filled in are untouched.
  // Rewrite the picked paragraph's PROSE — never a marker span's contents, which
  // hold the values just filled in. `transform` gets one text node's string and
  // returns what it should say.
  const rewritePickedText = useCallback((transform, { silent } = {}) => {
    const host = hostRef.current;
    if (!host || !transform) return;
    host.querySelectorAll('.dv-docx-para.is-selected').forEach((block) => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement?.closest('.dv-field')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      const nodes = [];
      let n = walker.nextNode();
      while (n) { nodes.push(n); n = walker.nextNode(); }
      for (const node of nodes) {
        const next = transform(node.nodeValue);
        if (next !== node.nodeValue) node.nodeValue = next;
      }
    });
    if (!silent) syncEdits();
  }, [syncEdits]);

  const applyGenderIn = useCallback((gender, opts) => {
    if (!gender) return;
    rewritePickedText((t) => applyGenderToText(t, gender), opts);
  }, [rewritePickedText]);

  // "județul/sectorul" — only București has sectors, so once the party's city is
  // known one half of that formula is not redundant but wrong.
  const applyLocalityIn = useCallback((hasSectors, opts) => {
    if (hasSectors == null) return;
    rewritePickedText((t) => applyLocalityToText(t, hasSectors), opts);
  }, [rewritePickedText]);

  const previewSnapRef = useRef(null);
  const clearParasRef = useRef(clearParas);
  useEffect(() => { clearParasRef.current = clearParas; }, [clearParas]);

  // ── "Complete data" ────────────────────────────────────────────────────
  // While the mode is on, every blank in the rendered document is wrapped in a
  // marker span and reported to the side panel, which is where values are
  // chosen. Filling one rewrites that span in place, so the change flows into
  // the ordinary edit tracking and saves as a new version like any other edit.
  const publishFields = adv?.publishFields;
  const registerFieldsApi = adv?.registerFieldsApi;
  const ensureFieldSuggestions = adv?.ensureFieldSuggestions;
  const setCompleting = adv?.setCompleting;

  // Fingerprint of the document AS RENDERED, computed once per render and
  // reused. It must not follow the text as blanks get filled in — otherwise
  // typing an answer would look like a different document and throw away the
  // suggestions already paid for.
  const docSigRef = useRef({ tick: -1, sig: '' });
  const documentSignature = useCallback(() => {
    if (docSigRef.current.tick === renderTick) return docSigRef.current.sig;
    const sig = docSignature((hostRef.current?.innerText || '').trim());
    docSigRef.current = { tick: renderTick, sig };
    return sig;
  }, [renderTick]);

  // Hover, both directions. Pointing at a marked gap tells the fields panel
  // which card to light; the panel pointing at a card comes back as
  // `hoverField` and lights the gap. One state, two publishers, so the pair can
  // never disagree about what is lit.
  const setHoverField = adv?.setHoverField;
  const hoverField = adv?.hoverField || null;
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !setHoverField) return undefined;
    const idAt = (node) => (node?.nodeType === 1 ? node : node?.parentElement)
      ?.closest?.('.dv-field')?.dataset?.dvfield || null;
    // `mouseover`/`mouseout` bubble (unlike enter/leave), so one pair of
    // listeners on the host covers every gap, including ones added by a
    // re-render.
    const onOver = (e) => { const id = idAt(e.target); if (id) setHoverField(id); };
    const onOut = (e) => {
      // Ignore moves WITHIN one gap (between its own text nodes) — only a move
      // that actually leaves it counts.
      if (idAt(e.target) && idAt(e.relatedTarget) === idAt(e.target)) return;
      if (idAt(e.target)) setHoverField(null);
    };
    host.addEventListener('mouseover', onOver);
    host.addEventListener('mouseout', onOut);
    return () => {
      host.removeEventListener('mouseover', onOver);
      host.removeEventListener('mouseout', onOut);
    };
  }, [setHoverField, renderTick]);
  // Paint whatever is hovered, from whichever side it was hovered on.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const el = hoverField ? host.querySelector(`[data-dvfield="${hoverField}"]`) : null;
    host.querySelectorAll('.dv-field.is-active').forEach((n) => {
      if (n !== el) n.classList.remove('is-active');
    });
    if (!el) return undefined;
    el.classList.add('is-active');
    return () => el.classList.remove('is-active');
  }, [hoverField, renderTick]);

  // Tell the side panel whether anything is picked — that is what makes the
  // "Selected paragraph" tab exist, and where its controls end up.
  const setParaPicked = adv?.setParaPicked;
  const setParaTextOut = adv?.setParaText;
  const setParaKeyOut = adv?.setParaKey;
  const paraSlot = adv?.paraSlot || null;
  const hasPick = paras.length > 0 || edits.length > 0;
  const pickedText = paras.map((pp) => pp.text).join('\n\n');
  // Document-order indices identify the pick. They survive a re-render and a
  // new version of the file (which re-paginates but keeps the structure), so a
  // paragraph's conversation is still there after you save a change to it.
  const pickedKey = paras.map((pp) => pp.index).join(',');
  useEffect(() => { setParaPicked?.(hasPick); }, [hasPick, setParaPicked]);
  // What the composer aims at while a paragraph's thread is open.
  useEffect(() => { setParaTextOut?.(pickedText); }, [pickedText, setParaTextOut]);
  // Which thread that is.
  useEffect(() => { setParaKeyOut?.(pickedKey); }, [pickedKey, setParaKeyOut]);
  // Leaving the fill-in menu saves. There is no Save button any more: filling
  // the blanks IS the task, and finishing a task shouldn't need a second
  // gesture to keep it. "Left" means the pick moved to another paragraph or was
  // dropped — closing the panel, pressing Escape and clicking the page margin
  // all do the latter, so one watcher covers every exit.
  //
  // saveEdits no-ops when there is nothing changed and refuses to re-enter
  // while a save is in flight, so the reload it triggers can't loop back here.
  const lastPickRef = useRef('');
  useEffect(() => {
    const was = lastPickRef.current;
    lastPickRef.current = pickedKey;
    if (was && was !== pickedKey) saveRef.current?.();
  }, [pickedKey]);
  useEffect(() => () => { setParaKeyOut?.(''); setParaTextOut?.(''); }, [setParaKeyOut, setParaTextOut]);
  // Leaving the document (a new file, a version switch) takes the tab with it —
  // otherwise it would outlive the pick it was showing.
  useEffect(() => () => setParaPicked?.(false), [setParaPicked]);

  // ── Blanks ─────────────────────────────────────────────────────────────
  // Every blank in the document is marked up as soon as it renders, so you can
  // SEE which paragraphs still have something to fill in without having to ask.
  // That marking is the affordance: pick a paragraph that carries one and its
  // fields appear in the side panel.
  //
  // The suggestions are warmed for the WHOLE document in one call, even though
  // the panel only ever lists one paragraph's worth. Asking per paragraph would
  // mean re-reading the project folder and paying for a round trip on every
  // click; asking once covers every paragraph you will visit.
  const allFieldsRef = useRef([]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !publishFields) return undefined;
    let cancelled = false;
    // After the render settles, so the walk sees the paginated DOM.
    const id = window.setTimeout(() => {
      if (cancelled) return;
      const sig = documentSignature();
      const found = scanDocFields(host);
      allFieldsRef.current = found;
      publishFields([], sig, found);
      if (found.length) ensureFieldSuggestions?.(found, (host.innerText || '').trim(), sig);
    }, 0);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [renderTick, publishFields, ensureFieldSuggestions, documentSignature]);

  // The markup belongs to one rendered document: drop it when a new version
  // replaces it, and when the pane goes away.
  useEffect(() => {
    const host = hostRef.current;
    return () => { if (host) clearDocFields(host); };
  }, [renderTick]);

  // What the side panel lists: the blanks in the paragraphs you have picked,
  // never the whole document. Picking a paragraph with no blanks in it leaves
  // the panel closed — a click on ordinary prose should not throw the layout
  // around.
  useEffect(() => {
    if (!publishFields) return;
    const picked = new Set(paras.map((pp) => pp.index));
    const list = picked.size
      ? allFieldsRef.current.filter((f) => f.paraIndex != null && picked.has(f.paraIndex))
      : [];
    publishFields(list, documentSignature());
    setCompleting?.(list.length > 0);
  }, [paras, publishFields, setCompleting, documentSignature]);

  // The panel drives the document through this — it has no access to the DOM
  // docx-preview renders.
  useEffect(() => {
    if (!registerFieldsApi) return undefined;
    const api = {
      // Write a value into one blank (an empty value restores the placeholder),
      // then let the edit tracking notice the paragraph changed.
      setValue: (id, v) => {
        const el = hostRef.current?.querySelector(`[data-dvfield="${id}"]`);
        if (!el) return;
        const value = (v || '').trim();
        el.textContent = value || el.dataset.dvfieldRaw || '';
        el.classList.toggle('is-filled', !!value);
        syncEdits();
      },
      // Go to one blank: scroll it into view and flash it once. Only the CLICK
      // path calls this — what marks a blank while you merely point at its card
      // is `hoverField`, which paints and unpaints on its own and doesn't move
      // the page.
      focus: (id) => {
        const host = hostRef.current;
        if (!host) return;
        const el = id ? host.querySelector(`[data-dvfield="${id}"]`) : null;
        if (!el) return;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.remove('is-flash');
        // Reflow between the two writes, or the class never leaves the frame
        // and the animation doesn't restart on a repeat click.
        void el.offsetWidth;
        el.classList.add('is-flash');
        window.setTimeout(() => el.classList.remove('is-flash'), 1200);
      },
      dropFields: (ids) => dropFieldsIn(ids),
      applyGender: (gender) => applyGenderIn(gender),
      applyLocality: (hasSectors) => applyLocalityIn(hasSectors),
      // ── Previewing ─────────────────────────────────────────────────────
      // Hovering a suggestion, or a party chip, writes the outcome into the
      // document so it can be READ IN PLACE — that is the whole question when
      // choosing between two values or two parties: how does the clause come
      // out. So a preview runs the FULL commit, not just the values: the
      // block/flat lines a house address removes, and the agreement a gender
      // settles, are exactly the parts you cannot picture from a side panel.
      //
      // The undo is a snapshot of each picked paragraph's markup, taken the
      // first time a preview starts and put back verbatim when it ends. Field
      // text alone would not do it — dropping a clause deletes nodes, and
      // nothing short of the original markup brings those back.
      //
      // Nothing here is committed: the edit tracking is not run (`silent`), so
      // a preview can never turn into a saved version on its own.
      previewValues: (map, opts = {}) => {
        const host = hostRef.current;
        if (!host) return;
        if (!previewSnapRef.current) {
          previewSnapRef.current = Array.from(host.querySelectorAll('.dv-docx-para.is-selected'))
            .map((el) => ({ el, html: el.innerHTML }));
        }
        Object.entries(map || {}).forEach(([id, v]) => {
          const el = host.querySelector(`[data-dvfield="${id}"]`);
          if (!el || !v) return;
          el.textContent = v;
          el.classList.add('is-preview');
        });
        if (opts.drop?.length) dropFieldsIn(opts.drop, { silent: true });
        if (opts.gender) applyGenderIn(opts.gender, { silent: true });
        if (opts.hasSectors != null) applyLocalityIn(opts.hasSectors, { silent: true });
      },
      // commit=true drops the snapshot without restoring: the click that
      // committed this has already written it for real, and putting the
      // paragraph back as it was would undo it.
      endPreview: (commit) => {
        const snap = previewSnapRef.current;
        previewSnapRef.current = null;
        if (!commit && snap) {
          for (const { el, html } of snap) {
            if (el.isConnected && el.innerHTML !== html) el.innerHTML = html;
          }
        }
        hostRef.current?.querySelectorAll('.dv-field.is-preview')
          .forEach((el) => el.classList.remove('is-preview'));
      },
      // Save every filled blank as a new version, through the same path the
      // paragraph editor uses.
      apply: () => saveRef.current?.(),
      // Drop the pick, which is what closes the panel.
      clearPick: () => clearParasRef.current?.(),
      // The document as it currently reads — what the AI is asked to suggest
      // values from.
      documentText: () => (hostRef.current?.innerText || '').trim(),
    };
    registerFieldsApi(api);
    return () => registerFieldsApi(null);
  }, [registerFieldsApi, syncEdits, dropFieldsIn, applyGenderIn, applyLocalityIn]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const onClick = (e) => {
      const para = blockAt(e.target);
      // A click that lands with text still highlighted is the tail of a drag-
      // select, not a paragraph pick — that's the selection gesture, handled on
      // mouseup below.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      if (!para) { clearParas(); return; } // clicking the page margin drops the pick
      // Already editable: a PLAIN click is the user aiming the caret inside
      // their own text — toggling here would deselect it mid-sentence. Modifier
      // clicks still mean "change the pick".
      const plainClick = !e.shiftKey && !e.metaKey && !e.ctrlKey;
      if (plainClick && para.getAttribute('contenteditable') === 'true') return;
        const index = Number(para.dataset.paraIndex);
      const nodes = paraNodes();
      if (e.shiftKey && lastParaRef.current != null) {
        const [lo, hi] = [lastParaRef.current, index].sort((a, b) => a - b);
        nodes.forEach((el) => {
          const i = Number(el.dataset.paraIndex);
          if (i >= lo && i <= hi) el.classList.add('is-selected');
        });
      } else if (e.metaKey || e.ctrlKey) {
        para.classList.toggle('is-selected');
        lastParaRef.current = index;
      } else {
        const wasOnlyPick = para.classList.contains('is-selected')
          && nodes.filter((el) => el.classList.contains('is-selected')).length === 1;
        nodes.forEach((el) => el.classList.remove('is-selected'));
        if (!wasOnlyPick) { para.classList.add('is-selected'); lastParaRef.current = index; }
        else lastParaRef.current = null;
      }
      syncParas();
      applyEditable();
        // Drop the caret exactly where the click landed, so picking a paragraph
      // and typing behaves like clicking into an input rather than dumping the
      // caret at the start of the block.
      if (para.getAttribute('contenteditable') === 'true') {
        para.focus({ preventScroll: true });
        const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
        if (range) {
          const sel2 = window.getSelection();
          sel2?.removeAllRanges();
          sel2?.addRange(range);
        }
      }
    };

    // Shift-click natively *extends the text selection*, which would leave a
    // non-collapsed selection and make the click above bail out — so suppress
    // the native gesture and let it mean "extend the paragraph range" instead.
    // Any other press clears the previous range wrapper before a new drag.
    // Shift-click natively EXTENDS the text selection, which would leave a
    // non-collapsed selection and make the click handler bail out — suppress the
    // native gesture so it means "extend the paragraph range" instead.
    const onDown = (e) => {
      if (e.shiftKey && blockAt(e.target)) {
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
      }
    };

    const onInput = () => { syncEdits(); syncParas(); };

    // Rich paste would drop foreign markup (and foreign fonts) into a paragraph
    // whose formatting we re-read from computed style — paste the text only.
    const onPaste = (e) => {
      if (!e.target.closest?.('[contenteditable]')) return;
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain') || '';
      if (text) document.execCommand('insertText', false, text.replace(/\s*\n\s*/g, ' '));
    };

    const onEditKey = (e) => {
      if (!e.target.closest?.('[contenteditable]')) return;
      // Enter commits the edits (Shift+Enter is left alone for a soft break —
      // a paragraph is one block, so it's suppressed too).
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!e.shiftKey) saveRef.current?.();
      }
    };

    const onKey = (e) => { if (e.key === 'Escape') clearParas(); };

    host.addEventListener('mousedown', onDown);
    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    host.addEventListener('paste', onPaste);
    host.addEventListener('keydown', onEditKey);
    window.addEventListener('keydown', onKey);
    return () => {
      host.removeEventListener('mousedown', onDown);
      host.removeEventListener('click', onClick);
      host.removeEventListener('input', onInput);
      host.removeEventListener('paste', onPaste);
      host.removeEventListener('keydown', onEditKey);
      window.removeEventListener('keydown', onKey);
    };
  }, [applyEditable, blockAt, clearParas, paraNodes, syncEdits, syncParas]);

  // What the bar acts on: the selected words if there are any, else the whole
  // picked paragraph(s).
  // One place, chosen per render: the panel's slot when its tab is open, the
  // page otherwise.
  const renderParaBar = useCallback(
    (node) => (paraSlot ? createPortal(node, paraSlot) : node),
    [paraSlot],
  );

  const targetText = pickedText;

  // Send the bar's prompt to the AI advisor with the picked passage attached, so
  // "make this shorter" means this paragraph, not the whole document.
  // Sending hands the passage off to the advisor, so the pick has done its job:
  // drop it (and the bar with it) and let the answer arrive in the thread. An
  // unsaved edit keeps the bar up on its own — the Save button must not vanish
  // out from under work that hasn't landed in a version yet.
  const askAi = useCallback(() => {
    const q = prompt.trim();
    if (!q || !adv?.send || adv.busy) return;
    adv.send(q, targetText);
    setPrompt('');
    clearParas();
  }, [adv, prompt, targetText, clearParas]);

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
    let retryTimer = null;
    (async () => {
      try {
        const resp = await fetch(url, { cache: 'no-store' });
        // A localfile:// read can be REFUSED (403 — the file sits outside the
        // folders the app has opened) or the file can be gone (404). Without
        // this check the error page's BODY was handed to docx-preview, which
        // then failed with a generic "not a zip" — the wrong story to tell.
        if (!resp.ok) throw new Error(`http_${resp.status}`);
        const blob = await resp.blob();
        // A zero-byte file is a document that hasn't finished being written (or
        // a failed build). Distinguished from corruption because it's the one
        // case worth retrying.
        if (!blob.size) throw new Error('empty');
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
        // Pagination is presentation, not content: if it throws, the document
        // is already rendered as a continuous flow, and keeping that beats
        // replacing a readable document with an error screen.
        try {
          pageWidthRef.current = paginateDocx(host);
        } catch (err) {
          console.error('[doc-viewer] could not paginate the document', err);
        }
        lastParaRef.current = null;
        setParas([]);
        // Fresh DOM: any unsaved edit belonged to the previous render (and a
        // SAVED one is already baked into the file we just re-read).
        setEdits([]);
        setSaveState(null);
        setRenderErr(null);
        attemptRef.current = { url, n: 0 };
        fitWidth();
        // Tells the "Complete data" scan that there is fresh DOM to look at —
        // every new version replaces the whole document, blanks included.
        setRenderTick((t) => t + 1);
      } catch (err) {
        if (cancelled) return;
        console.error('[doc-viewer] could not render the document', err);
        const code = String(err?.message || '');
        // A file read while it was still being written renders fine a moment
        // later — the AI writes a new version and the watcher relists in the
        // same breath — so a transient failure gets two quick retries before
        // the pane gives up and says so.
        const a = attemptRef.current;
        if (a.url !== url) { a.url = url; a.n = 0; }
        const transient = code === 'empty' || code === 'http_404' || code.startsWith('http_5');
        if (transient && a.n < 2) {
          a.n += 1;
          retryTimer = window.setTimeout(() => setReloadKey((k) => k + 1), 400 * a.n);
          return;
        }
        if (host) host.innerHTML = '';
        setRenderErr(
          code === 'http_403'
            ? { title: 'This file can’t be read from here',
                detail: 'It sits outside the folders DocVex has open. Open its folder in the Files tab, or open it in Word.' }
            : code === 'http_404'
              ? { title: 'This file is no longer on disk',
                  detail: 'It was moved or deleted after this tab was opened.' }
              : code === 'empty'
                ? { title: 'This document is empty',
                    detail: 'The file has no contents yet — if the AI is still building it, this will fill in on its own.' }
                : { title: 'Couldn’t display this document',
                    detail: 'It may not be a valid Word file, or it may be damaged. It still opens in Word.' },
        );
      }
    })();
    return () => { cancelled = true; if (retryTimer) window.clearTimeout(retryTimer); };
  }, [url, fitWidth, reloadKey]);

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
      <div className="dv-docview-body">
        <div
          ref={hostRef}
          className={`dv-docx${showPageNumbers ? ' show-pagenums' : ''}${paras.length ? ' has-pick' : ''}`}
        />
        {/* The host stays mounted (the render effect needs its ref) — it is just
            empty behind this. */}
        {renderErr && (
          <div className="dv-docx-error" role="alert">
            <p className="dv-docx-error-title">{renderErr.title}</p>
            <p className="dv-docx-error-sub">{renderErr.detail}</p>
            <div className="dv-docx-error-actions">
              <button type="button" className="dv-chip" onClick={retryRender}>Try again</button>
              {onOpenNative && (
                <button type="button" className="dv-chip" onClick={onOpenNative}>Open in Word</button>
              )}
            </div>
          </div>
        )}
      </div>
      {/* What's left of the pick's action bar: saving the edits you typed into
          the paragraph, and — only while it FLOATS over the page — a prompt
          field. Docked in the Paragraph sub-tab it renders nothing but Save,
          because that tab already has the advisor's composer under it and the
          document's own footer is the one place to type.

          Undo / Copy / Clear are gone: the paragraph is a normal contenteditable
          (so ⌘Z and ⌘C are the system's), and the pick is dropped by pressing
          Escape or clicking the page margin. Rendered only when it would hold
          something, so an untouched pick doesn't leave an empty box above the
          thread. */}
      {hasPick && adv?.send && !paraSlot && renderParaBar(
        <div className={`dv-docx-parabar${paraSlot ? ' is-docked' : ''}`} role="group" aria-label="Selected text actions">
          {/* Prompt the AI about exactly this passage. Only while the bar is
              FLOATING — docked in the panel it sits directly above the shared
              composer, and two inputs for one job is one too many. */}
          {adv?.send && !paraSlot && (
            <span className="dv-docx-parabar-ask">
              <input
                type="text"
                className="dv-docx-parabar-input"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); askAi(); }
                  e.stopPropagation(); // Escape here shouldn't drop the pick
                }}
                placeholder="Ask the AI to change this paragraph…"
                aria-label="Ask the AI about the selection"
                disabled={adv?.busy}
              />
              <Tooltip content="Send to the AI advisor">
                <button
                  type="button"
                  className="dv-docx-parabar-send"
                  onClick={askAi}
                  disabled={!prompt.trim() || adv?.busy}
                  aria-label="Send"
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 12h14M13 6l6 6-6 6" />
                  </svg>
                </button>
              </Tooltip>
            </span>
          )}

        </div>,
      )}
      {/* Why a save didn't go through — sits under the bar rather than as a
          toast, because it's about the paragraph you're looking at, so it
          follows the bar into the panel. */}
      {saveState && saveState !== 'saving' && renderParaBar(
        <div className={`dv-docx-parabar-err${paraSlot ? ' is-docked' : ''}`} role="alert">{saveState}</div>,
      )}
      {/* Page-numbers toggle, Complete data + Convert-to-PDF docked at the
          bottom of the pane. */}
      {/* Whole-document actions — page numbers, Open in Word, Convert to PDF.
          They go away while a paragraph is picked: none of them is about the
          paragraph, and offering "convert the whole file to PDF" next to a
          passage you are mid-edit on is an invitation to lose the edit. They
          come back the moment the pick is dropped. */}
      {!hasPick && (
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
              <OpenNativeButton onOpen={onOpenNative} kind="docx" />
              <ExportPdfButton getRoot={() => hostRef.current} kind="docx" onExport={onExportPdf} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Above this, a document is assumed to have content: extracting text from it
// just to find out would cost more than the answer is worth, and a file this
// size is not one that was created empty a moment ago.
const BLANK_PROBE_MAX_BYTES = 256 * 1024;

// ── "What do you want to make?" ─────────────────────────────────────────
// A brand-new document opens HERE, not on an empty page beside an advisor
// waiting to be told something. Neither the preview nor the side panel is
// mounted yet: there is nothing to preview and nothing to discuss until the
// document is something.
//
// Picking a template hands the drafter a ready-made outline (see
// lib/docTemplates) instead of asking it to invent one — the reason templates
// exist at all is that the structure ships with the app rather than being paid
// for in tokens on every draft. "Something else" is the same door with the
// description typed instead of picked.
function DocTemplateChooser({ onChosen }) {
  const adv = useMultitoolAdvisor();
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);

  // `shown` is what goes in the thread, `prompt` is what the model reads.
  const start = useCallback((shown, prompt) => {
    if (!prompt || busy) return;
    setBusy(true);
    // The layout swaps to the document + advisor immediately, and the first
    // turn is already in flight behind it — the thread should be alive when
    // it appears, not empty and waiting.
    onChosen?.();
    adv?.send?.(shown, undefined, { apiText: prompt });
  }, [adv, busy, onChosen]);

  return (
    <div className="dvt-root">
      <div className="dvt-inner">
        <h1 className="dvt-title">What do you want to make?</h1>
        <p className="dvt-sub">
          Pick a template and the draft is written from a ready-made structure —
          or describe anything else.
        </p>

        <div className="dvt-grid">
          {DOC_TEMPLATES.map((t) => (
            <button
              type="button"
              key={t.id}
              className="dvt-card"
              disabled={busy}
              onClick={() => start(`Make a ${t.label}.`, templatePrompt(t))}
            >
              <span className="dvt-card-ico" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <path d="M14 3v5h5" /><path d="M9 13h6" /><path d="M9 17h4" />
                </svg>
              </span>
              <span className="dvt-card-label">{t.label}</span>
              <span className="dvt-card-blurb">{t.blurb}</span>
            </button>
          ))}

          {/* Anything the templates don't cover. Same card shape so it reads as
              one more choice rather than a fallback. */}
          <div className={`dvt-card dvt-card-other${busy ? ' is-busy' : ''}`}>
            <span className="dvt-card-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" /><path d="M5 12h14" />
              </svg>
            </span>
            <span className="dvt-card-label">Something else</span>
            <span className="dvt-card-blurb">Describe the document you need.</span>
            <div className="dvt-other-row">
              <input
                className="dvt-other-input"
                value={custom}
                disabled={busy}
                placeholder="A power of attorney for…"
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && custom.trim()) { e.preventDefault(); start(custom.trim(), customPrompt(custom)); }
                }}
              />
              <button
                type="button"
                className="dvt-other-go"
                disabled={busy || !custom.trim()}
                onClick={() => start(custom.trim(), customPrompt(custom))}
                aria-label="Start writing this"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h13" /><path d="M12 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// How long typing has to stop before a record is written. Long enough that a
// burst of typing is one save, short enough that "Saved" appears while the user
// is still looking at the field — and, since a name change renames the FILE,
// long enough not to churn the folder through every prefix of a name.
const IDENTITY_AUTOSAVE_MS = 900;

// The address parts a clause can ask for, in the order the read-out lists them.
const ADDRESS_PART_LABELS = [
  ['addressStreet', 'Str.'],
  ['addressNumber', 'nr.'],
  ['addressBlock', 'bl.'],
  ['addressStair', 'sc.'],
  ['addressFloor', 'et.'],
  ['addressApartment', 'ap.'],
  ['addressLocality', 'loc.'],
  // The sector has no chip of its own: it belongs to its city, and a sector
  // without one says almost nothing. `addressLocality` renders the pair — see
  // the read-out below.
  ['addressCounty', 'jud.'],
  ['addressPostalCode', 'cod'],
];

// ── Autofill picker ─────────────────────────────────────────────────────
// The project's Files tab, in a modal over the viewer, so a record can be
// filled from a photograph of the document it came from — an ID card, a
// passport page, a company certificate.
//
// It shows the WHOLE folder rather than just the pictures, because that is what
// the Files tab shows and hiding half of it would leave the user wondering
// where their file went. Only an image can actually be read, so everything else
// is present but dimmed and says why.
const AUTOFILL_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'gif', 'avif']);
const extOfName = (name) => String(name || '').slice(String(name || '').lastIndexOf('.') + 1).toLowerCase();
// Pictures sort first — they are the only ones that can be read.
const imageRank = (name) => (AUTOFILL_IMAGE_EXTS.has(extOfName(name)) ? 0 : 1);
// Where the recycle bin lives inside a project folder (see localFolder.js).
const TRASH_DIR = '.docvex-trash';

// What went wrong, in the user's terms — each with a different thing to do
// about it. A blanket "try a sharper photo" was wrong for every case but one.
const AUTOFILL_ERRORS = {
  no_image: 'That file couldn’t be opened.',
  decode_failed: 'This picture can’t be opened here — try a JPEG or PNG.',
  no_text: 'No text was found in that picture. Make sure the document fills the frame and is in focus.',
  ocr_failed: 'The AI service couldn’t be reached. Check you’re signed in and online.',
  ai_failed: 'The AI service couldn’t be reached. Check you’re signed in and online.',
  unreadable: 'The text was read, but nothing in it looked like an identity document.',
};

// How long the picker's exit animation runs. The unmount waits exactly this
// long, so the number is shared with the `.is-closing` rules in the stylesheet
// — change one and change the other.
const MODAL_EXIT_MS = 180;

// One tile in the picker, rendered exactly as the Files tab renders one:
// `ItemThumbnail` (the real poster, falling back to the type glyph), the
// `.fx-tile` shell, and `useMorphPill` for the cursor-following name pill that
// morphs into a right-click menu. Imported rather than reimplemented — a
// lookalike would drift from the real thing on the first change to either.
function AutofillTile({
  item, disabled, selected, inTrash,
  onPick, onOpen, onOpenFolder, onShowInFolder, onDelete, onRestore,
}) {
  const isFolder = item.kind === 'folder';
  const readable = item.readable;
  // The Files tab's own menu for this item, with the picker's reason for
  // existing put first. Same labels, same order, same danger styling and the
  // same confirm copy as itemMenuItems in FilesWorkspace.jsx — a menu that
  // looks like that one but reads differently is worse than no menu.
  const subject = isFolder ? `“${item.name}” and everything inside it` : `“${item.name}”`;
  const menuItems = item.binEntry
    ? [{ label: 'Open', onClick: () => onOpenFolder?.(item) }]
    : inTrash
      ? [
        readable && { key: 'scan', label: 'Select for scan', onClick: () => onPick?.(item) },
        { key: 'open', label: 'Open', onClick: () => onOpen?.(item) },
        { key: 'restore', label: 'Restore', onClick: () => onRestore?.(item) },
        {
          key: 'delete', label: 'Delete forever', danger: true, onClick: () => onDelete?.(item),
          confirm: {
            count: 1,
            subtitle: 'Permanent · can’t be undone',
            title: 'Permanently delete this file?',
            message: `${subject} will be permanently deleted from your computer. This can’t be undone.`,
            confirmLabel: 'Delete forever',
            cancelLabel: 'Cancel',
          },
        },
      ]
      : isFolder
        ? [
          { key: 'open', label: 'Open', onClick: () => onOpenFolder?.(item) },
          { key: 'loc', label: 'Open file location', onClick: () => onShowInFolder?.(item) },
          {
            key: 'delete', label: 'Delete folder', danger: true, onClick: () => onDelete?.(item),
            confirm: {
              count: 1,
              subtitle: 'Removed from your computer',
              title: 'Delete this folder?',
              message: `${subject} will be deleted from your computer.`,
              confirmLabel: 'Delete',
              cancelLabel: 'Cancel',
            },
          },
        ]
        : [
          readable
            ? { key: 'scan', label: 'Select for scan', onClick: () => onPick?.(item) }
            : {
              key: 'scan',
              label: item.ext
                ? `A ${String(item.ext).toUpperCase()} has no picture to read`
                : 'Only a picture can be read',
              disabled: true,
            },
          { key: 'open', label: 'Open', onClick: () => onOpen?.(item) },
          { key: 'loc', label: 'Open file location', onClick: () => onShowInFolder?.(item) },
          {
            key: 'delete', label: 'Delete', danger: true, onClick: () => onDelete?.(item),
            confirm: {
              count: 1,
              subtitle: 'Recoverable for 30 days',
              title: 'Delete this file?',
              message: `${subject} will be moved to the Trash. It stays recoverable for 30 days.`,
              confirmLabel: 'Delete',
              cancelLabel: 'Cancel',
            },
          },
        ];
  const morph = useMorphPill({
    // A file that can't be read says so ON HOVER, not only in its right-click
    // menu — dimming a tile tells you something is off but not what, and "why
    // can't I click this" should not need a second gesture to answer.
    hoverContent: (isFolder || readable) ? item.name : (
      <span className="fx-hover-rich dvi-hover-why">
        <span className="fx-hover-name">{item.name}</span>
        <span className="dvi-hover-note">
          {item.ext ? `${String(item.ext).toUpperCase()} — ` : ''}
          can’t be scanned — double-click to open it
        </span>
      </span>
    ),
    menuItems: menuItems.filter(Boolean),
  });
  return (
    <>
      <button
        type="button"
        className={`fx-tile${isFolder ? ' is-folder' : ''}${(item.busy || selected) ? ' is-selected' : ''}${!isFolder && !readable ? ' is-unreadable' : ''}`}
        aria-pressed={!isFolder && readable ? !!selected : undefined}
        // One click CHOOSES; the Scan button reads. Reading costs money and a
        // few seconds, so it should be an act of its own rather than something
        // a mis-click can start. Double-click OPENS — the gesture means the
        // same thing here as it does in the Files tab, and checking a picture
        // is the right thing to be able to do before spending a scan on it.
        // Every file opens, not only the readable ones: nothing is being asked
        // of the picture, so nothing about it can be unsuitable.
        onClick={() => { if (isFolder) onOpenFolder?.(item); else if (readable) onPick?.(item); }}
        onDoubleClick={() => { if (!isFolder) onOpen?.(item); }}
        // `disabled` only while ANOTHER tile is being read. An unreadable file
        // is marked aria-disabled and left enabled on purpose: a disabled
        // <button> fires no pointer events in Chromium, which would kill the
        // hover pill — and that pill is the only thing that says WHY the tile
        // can't be used. The click is a no-op either way.
        disabled={disabled}
        aria-disabled={!isFolder && !readable ? true : undefined}
        onMouseMove={morph.handleMouseMove}
        onMouseLeave={morph.handleMouseLeave}
        onContextMenu={(e) => { e.stopPropagation(); morph.handleContextMenu(e); }}
      >
        <span className="fx-tile-thumb">
          {/* The Files tab's own split: folders get the folder glyph (filled
              when they hold something), files get their thumbnail with the type
              glyph behind it. `item.glyph` is the one exception — the Trash
              tile, which is a folder but wears the bin. */}
          {item.glyph
            || (isFolder ? <FolderOrBinGlyph item={item} /> : <ItemThumbnail item={item} />)}
        </span>
        <span>
          <span className="fx-tile-name">
            {item.name}
            {/* How many are inside, inline beside the label — the Files tab's
                own treatment for the bin. */}
            {item.binEntry && item.binCount > 0 && (
              <span className="fx-bin-count is-inline">{item.binCount}</span>
            )}
          </span>
        </span>
      </button>
      {morph.node}
    </>
  );
}

function IdentityAutofillModal({ open, onClose, record, onFilled }) {
  const { selectedProject } = useSelectedProject();
  const { session } = useAuth();
  const [root, setRoot] = useState('');        // the project folder's own path
  const [cwd, setCwd] = useState('');          // the folder being shown
  const [hist, setHist] = useState({ stack: [], at: -1 });  // back / forward
  const [listing, setListing] = useState(null); // { files, dirs } | null while reading
  const [trash, setTrash] = useState([]);
  const [inTrash, setInTrash] = useState(false);
  const [query, setQuery] = useState('');
  const [busyPath, setBusyPath] = useState(null);
  // The picture chosen but not yet read: { name, path, blob? }. `blob` is set
  // only for one imported from the computer, which is never in the grid.
  const [picked, setPicked] = useState(null);
  const [note, setNote] = useState(null);      // { tone, text }
  // Bumped after anything that changes the folder, so the listing and the bin
  // are re-read. The picker is a live view of the project, not a snapshot.
  const [tick, setTick] = useState(0);
  const searchRef = useRef(null);
  const importRef = useRef(null);
  const scanRef = useRef(null);
  // Stay mounted through the exit animation. Closing is a state change, and a
  // panel that simply vanishes on one reads as a glitch — the eye needs to see
  // where it went. `open` is already false throughout, so every effect below
  // has cleaned up and nothing is fetched or listened to on the way out.
  const [mounted, setMounted] = useState(open);
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (open) { setMounted(true); setExiting(false); return undefined; }
    if (!mounted) return undefined;
    setExiting(true);
    const t = window.setTimeout(() => { setMounted(false); setExiting(false); }, MODAL_EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open, mounted]);

  // Navigate, remembering where we came from. Back and forward walk the same
  // stack a file manager's arrows do; opening a folder from anywhere but the
  // end of it drops whatever was ahead, which is what "forward" means.
  const goTo = useCallback((dir, { trash: toTrash = false } = {}) => {
    setInTrash(toTrash);
    setCwd(dir);
    setQuery('');
    // A chosen file that is no longer on screen is a Scan button pointing at
    // something invisible. Leaving the folder un-chooses it.
    setPicked(null);
    setNote(null);
    setHist((h) => {
      const stack = h.stack.slice(0, h.at + 1);
      stack.push({ dir, trash: toTrash });
      return { stack, at: stack.length - 1 };
    });
  }, []);
  const step = useCallback((delta) => {
    setHist((h) => {
      const at = h.at + delta;
      const entry = h.stack[at];
      if (!entry) return h;
      setCwd(entry.dir); setInTrash(entry.trash); setQuery('');
      setPicked(null); setNote(null);
      return { ...h, at };
    });
  }, []);

  // Open on the project root, and re-read it each time — a photo taken a
  // minute ago is exactly the one being reached for.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setListing(null); setTrash([]); setNote(null); setQuery(''); setPicked(null);
    (async () => {
      try {
        const projectId = selectedProject?.id;
        if (!projectId) { if (!cancelled) setListing({ files: [], dirs: [] }); return; }
        const baseDir = readProjectsDir(session?.user?.id || '_anonymous') || undefined;
        const { path } = await localFolderApi.projectDir(projectId, selectedProject?.name, baseDir);
        if (cancelled) return;
        setRoot(path || '');
        setCwd(path || '');
        setInTrash(false);
        setHist({ stack: [{ dir: path || '', trash: false }], at: 0 });
        const { items } = await localFolderApi.listTrash(path || undefined);
        if (!cancelled) setTrash(items || []);
      } catch {
        if (!cancelled) setListing({ files: [], dirs: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [open, selectedProject?.id, selectedProject?.name, session?.user?.id]);

  // List whatever folder is current.
  useEffect(() => {
    if (!open || !cwd || inTrash) return undefined;
    let cancelled = false;
    setListing(null);
    localFolderApi.list(cwd)
      .then(({ files, dirs }) => { if (!cancelled) setListing({ files: files || [], dirs: dirs || [] }); })
      .catch(() => { if (!cancelled) setListing({ files: [], dirs: [] }); });
    return () => { cancelled = true; };
  }, [open, cwd, inTrash, tick]);

  // The bin, re-read alongside it — deleting a file here has to show up there.
  useEffect(() => {
    if (!open || !root || !tick) return undefined;
    let cancelled = false;
    localFolderApi.listTrash(root)
      .then(({ items }) => { if (!cancelled) setTrash(items || []); })
      .catch(() => { /* an unreadable bin is an empty one */ });
    return () => { cancelled = true; };
  }, [open, root, tick]);

  // Escape closes — unless it is clearing a search, which is the nearer
  // meaning when there is one. ⌘/Ctrl+F focuses the field, as in Files.
  // Enter reads whatever is chosen; through a ref so the key handler below
  // stays bound to `open` rather than re-binding on every click in the grid.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault(); e.stopPropagation();
        searchRef.current?.focus(); searchRef.current?.select();
        return;
      }
      if (e.key === 'Enter' && !/^(INPUT|TEXTAREA)$/.test(e.target?.tagName || '')) {
        e.preventDefault(); scanRef.current?.();
        return;
      }
      if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // `blobOverride` is set when the picture came from the computer rather than
  // the project — everything after reading the bytes is identical.
  const runOn = useCallback(async (file, blobOverride) => {
    const path = file.path || file.name;
    setBusyPath(path); setNote(null);
    try {
      const blob = blobOverride || await readLocalBlob(path);
      if (!blob) throw new Error('unreadable');
      const res = await readIdentityFromImage(blob, record, {
        jurisdiction: record?.jurisdiction,
        projectId: selectedProject?.id,
      });
      if (res.error) {
        // Say which step failed. One message for every failure sent people off
        // sharpening photographs when the AI key was not configured, or when
        // the browser could not decode the file at all.
        // The OCR layer raises messages already written for a person ("The AI
        // key isn't configured on the server."); prefer those over the generic
        // line, since they name the actual fix.
        setNote({
          tone: 'error',
          text: (res.error === 'ocr_failed' && res.detail) || AUTOFILL_ERRORS[res.error] || AUTOFILL_ERRORS.ocr_failed,
        });
        return;
      }
      // Only what would actually change something. A reading that matches what
      // is already in the record is correct and worth nothing to show.
      const fresh = Object.fromEntries(
        Object.entries(res.fields || {})
          .filter(([k, v]) => String(record?.[k] ?? '').trim() !== v),
      );
      if (!Object.keys(fresh).length) {
        // Not a failure: it read the picture and everything on it is already in
        // the record. Saying so beats a silent no-op — and the picker stays
        // open, because there is nothing behind it to go and look at.
        setNote({ tone: 'ok', text: 'Nothing new — everything it read is already in the record.' });
        return;
      }
      // Hand the readings back and get out of the way. They are shown under the
      // fields they belong to, in the record itself, which is where they have to
      // be judged: a value is right or wrong next to the rest of the record, not
      // in a list floating over it.
      setPicked(null);
      onFilled?.(fresh, file.name);
    } catch {
      setNote({ tone: 'error', text: 'Couldn’t open that file.' });
    } finally {
      setBusyPath(null);
    }
  }, [record, onFilled, selectedProject?.id]);

  const scan = useCallback(() => {
    if (picked && !busyPath) runOn(picked, picked.blob);
  }, [picked, busyPath, runOn]);

  // Open a file in this window, as the Files tab does — it adds a tab rather
  // than opening a second viewer. Checking what a picture actually is before
  // spending a scan on it is exactly what double-click should be for.
  const openInViewer = useCallback((f) => {
    openDocViewerWindow({ path: f.path, name: f.name, mime: f.mimeType || '' });
  }, []);

  // The Files tab's own destructive actions, over the same API. A picker that
  // shows the project's files but cannot act on them makes people leave, do the
  // thing next door, and come back — so the menu that looks like the Files
  // tab's does what it does.
  const removeItem = useCallback(async (f) => {
    const res = f.kind === 'folder'
      ? await localFolderApi.trashFolder({ dir: root, path: f.path })
      : await localFolderApi.trashFile({ dir: root, path: f.path });
    if (res?.error) { setNote({ tone: 'error', text: 'Couldn’t delete that — it may be open somewhere.' }); return; }
    setPicked((cur) => (cur?.path === f.path ? null : cur));
    setTick((n) => n + 1);
    notifyFilesChanged();
  }, [root]);
  const restoreItem = useCallback(async (f) => {
    const res = await localFolderApi.restoreFromTrash({ dir: root, stored: f.stored });
    if (res?.error) { setNote({ tone: 'error', text: 'Couldn’t restore that file.' }); return; }
    setPicked((cur) => (cur?.path === f.path ? null : cur));
    setTick((n) => n + 1);
    notifyFilesChanged();
  }, [root]);
  const purgeItem = useCallback(async (f) => {
    const res = await localFolderApi.deleteFromTrash({ dir: root, stored: f.stored });
    if (res?.error) { setNote({ tone: 'error', text: 'Couldn’t delete that file.' }); return; }
    setPicked((cur) => (cur?.path === f.path ? null : cur));
    setTick((n) => n + 1);
  }, [root]);
  useEffect(() => { scanRef.current = scan; }, [scan]);

  if (!mounted) return null;

  const sep = root.includes('\\') ? '\\' : '/';
  // Tiles in the Files tab's own shape: a descriptor for the real thumbnail, an
  // `ext` for the type glyph it falls back to.
  const fileItem = (f, { virtual = false } = {}) => ({
    id: f.path || f.name,
    kind: 'file',
    name: f.name,
    path: f.path || f.name,
    ext: extOfName(f.name),
    readable: AUTOFILL_IMAGE_EXTS.has(extOfName(f.name)),
    mimeType: f.mimeType || '',
    busy: busyPath === (f.path || f.name),
    virtual,
    descriptor: virtual ? null : describeLocalFile({ localFile: f }),
  });

  const trashItems = trash.map((t) => ({
    ...fileItem({
      name: t.originalName || t.stored,
      path: root ? `${root}${sep}${TRASH_DIR}${sep}${t.stored}` : t.stored,
      mimeType: t.mimeType,
    }),
    // What restore and delete-forever are addressed by — the name on disk in
    // the bin, not the one the file used to have.
    stored: t.stored,
  }));

  const folders = inTrash ? [] : (listing?.dirs || []).map((d) => ({
    id: `dir:${d.path}`, kind: 'folder', name: d.name, path: d.path, empty: d.empty,
  }));
  const files = inTrash ? trashItems : (listing?.files || []).map((f) => fileItem(f));
  // Pictures first — they are the only ones that can be read, and the reason
  // the picker was open.
  files.sort((a, b) => imageRank(a.name) - imageRank(b.name));

  const q = query.trim().toLowerCase();
  const match = (x) => !q || x.name.toLowerCase().includes(q);
  const shownFolders = folders.filter(match);
  const shownFiles = files.filter(match);
  const reading = !inTrash && listing === null;
  // The bin's own tile: shown at the project root, always — an empty one still
  // has to be reachable, or "where did my deleted photo go" has nowhere to lead.
  const showsBin = !inTrash && !q && cwd === root && !!root;

  // Breadcrumbs from the project root down to here.
  const rel = !inTrash && cwd.startsWith(root) ? cwd.slice(root.length).replace(/^[\\/]+/, '') : '';
  const segs = rel ? rel.split(/[\\/]+/).filter(Boolean) : [];

  return createPortal((
    <div
      className={`dvi-modal-scrim${exiting ? ' is-closing' : ''}`}
      role="presentation"
      // Nothing to dismiss while it is already leaving.
      onMouseDown={(e) => { if (!exiting && e.target === e.currentTarget) onClose?.(); }}
    >
      {/* `data-theme="ink"` paints this subtree in the dark palette whatever the
          app is set to — the mechanism the theme system already provides for a
          component that declares its own theme (see tokens.css / ThemePicker).
          That is what makes the Files tiles inside come out dark too: they read
          the same semantic tokens, so they follow without a single override. */}
      <div className="dvi-modal" data-theme="ink" role="dialog" aria-modal="true" aria-label="Fill from a picture">
        <header className="dvi-modal-head">
          <div className="dvi-modal-head-text">
            <span className="dvi-modal-eyebrow">Fill from a picture</span>
            <h2 className="dvi-modal-title">{selectedProject?.name || 'Project'} · Files</h2>
          </div>
          <Tooltip content="Close">
            <button type="button" className="dvi-modal-close" onClick={onClose} aria-label="Close">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </Tooltip>
        </header>

        {/* The Files tab's path bar: back/forward and where you are on the
            left, the folder search on the right. */}
        <div className="dvi-modal-bar">
          {/* The Files tab's own nav cluster — same classes, same glyph set. */}
          <div className="fx-pathbar-nav">
            <Tooltip content="Back">
              <button type="button" onClick={() => step(-1)} disabled={hist.at <= 0} aria-label="Back">
                <FxIcon name="chev-left" size={14} />
              </button>
            </Tooltip>
            <Tooltip content="Forward">
              <button type="button" onClick={() => step(1)} disabled={hist.at >= hist.stack.length - 1} aria-label="Forward">
                <FxIcon name="chev-right" size={14} />
              </button>
            </Tooltip>
            <Tooltip content="Up one folder">
              <button
                type="button"
                onClick={() => (inTrash ? goTo(root) : goTo(cwd.slice(0, cwd.lastIndexOf(sep))))}
                disabled={inTrash ? false : (!cwd || cwd === root)}
                aria-label="Up one folder"
              >
                <FxIcon name="chev-up" size={14} />
              </button>
            </Tooltip>
          </div>

          {/* Crumbs, likewise: .fx-crumbs / .fx-crumb, a filled folder glyph on
              each and the bin's own on Trash — the same reading as the Files
              tab's path, because it is the same path. */}
          <nav className="fx-crumbs" aria-label="Folder path">
            <Tooltip content={selectedProject?.name || 'Home'}>
              <button
                type="button"
                className={`fx-crumb is-root${!inTrash && segs.length === 0 ? ' is-current' : ''}`}
                onClick={() => goTo(root)}
              >
                <FxIcon name="folder" size={16} className="fx-crumb-icon" filled />
                <span className="fx-crumb-label">Home</span>
              </button>
            </Tooltip>
            {segs.map((name, i) => (
              <React.Fragment key={`${name}-${i}`}>
                <FxIcon name="chev-right" size={12} className="fx-crumb-sep" />
                <Tooltip content={name}>
                  <button
                    type="button"
                    className={`fx-crumb${i === segs.length - 1 ? ' is-current' : ''}`}
                    onClick={i === segs.length - 1 ? undefined : () => goTo([root, ...segs.slice(0, i + 1)].join(sep))}
                  >
                    <FxIcon name="folder" size={14} className="fx-crumb-icon" filled />
                    <span className="fx-crumb-label">{name}</span>
                  </button>
                </Tooltip>
              </React.Fragment>
            ))}
            {inTrash && (
              <>
                <FxIcon name="chev-right" size={12} className="fx-crumb-sep" />
                <span className="fx-crumb is-current">
                  <FxIcon name="trash" size={14} className="fx-crumb-icon is-trash" filled />
                  <span className="fx-crumb-label">Trash</span>
                </span>
              </>
            )}
          </nav>

          <div className="dvi-modal-bar-tools">
            {/* A picture that is not in the project yet — a photo just taken, a
                scan in Downloads. It is READ, not copied: filling a record is
                not a reason to put a file in someone's project folder. */}
            <input
              ref={importRef}
              type="file"
              accept="image/*"
              className="dvi-modal-file"
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                // Reset first, so choosing the same file twice fires again.
                e.target.value = '';
                // Chosen, not read — the Scan button is the one thing that
                // starts a read, wherever the picture came from.
                if (chosen) {
                  setNote(null);
                  setPicked({ name: chosen.name, path: `import:${chosen.name}`, blob: chosen, imported: true });
                }
              }}
            />
            <Tooltip content="Read a picture from this computer — it is not added to the project">
              <button
                type="button"
                className="dvi-modal-import"
                onClick={() => importRef.current?.click()}
                disabled={!!busyPath}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 15V3" /><path d="m8 7 4-4 4 4" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                </svg>
                From computer
              </button>
            </Tooltip>
            <div className={`dvi-modal-search${query ? ' is-active' : ''}`}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="dvi-modal-search-glyph" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                placeholder="Search this folder"
                aria-label="Search this folder"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }}
              />
              {query ? (
                <Tooltip content="Clear search">
                  <button
                    type="button"
                    className="dvi-modal-search-clear"
                    aria-label="Clear search"
                    onClick={() => { setQuery(''); searchRef.current?.focus(); }}
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </Tooltip>
              ) : (
                <span className="dvi-modal-search-kbd">
                  <kbd>{/mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'}</kbd>
                  <span className="dvi-modal-search-plus">+</span>
                  <kbd>F</kbd>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="dvi-modal-body">
          {reading && <p className="dvi-modal-empty">Reading the folder…</p>}
          {!reading && !showsBin && shownFolders.length === 0 && shownFiles.length === 0 && (
            <p className="dvi-modal-empty">
              {query
                ? `Nothing here matches “${query.trim()}”.`
                : inTrash ? 'The trash is empty.' : 'This folder is empty.'}
            </p>
          )}
          {!reading && (shownFolders.length > 0 || shownFiles.length > 0 || showsBin) && (
            <div className={`fx-grid dvi-modal-grid${busyPath ? ' is-busy' : ''}`}>
              {shownFolders.map((f) => (
                <AutofillTile
                  key={f.id}
                  item={f}
                  disabled={!!busyPath}
                  onOpenFolder={() => goTo(f.path)}
                  onShowInFolder={() => localFolderApi.showInFolder(f.path)}
                  onDelete={() => removeItem(f)}
                />
              ))}
              {/* Trash sits in the grid as a folder does in the Files tab — a
                  picture deleted by mistake is still a picture, and this is the
                  first place anyone looks for a file that isn't in the list. */}
              {!inTrash && !q && cwd === root && (
                <AutofillTile
                  item={{
                    id: '__trash', kind: 'folder', name: 'Trash', virtual: true,
                    binEntry: true, binCount: trash.length,
                  }}
                  disabled={!!busyPath}
                  onOpenFolder={() => goTo(root, { trash: true })}
                />
              )}
              {shownFiles.map((f) => (
                <AutofillTile
                  key={f.id}
                  item={f}
                  disabled={!!busyPath}
                  inTrash={inTrash}
                  selected={picked?.path === f.path}
                  onPick={() => { setNote(null); setPicked({ name: f.name, path: f.path }); }}
                  onOpen={() => openInViewer(f)}
                  onShowInFolder={() => localFolderApi.showInFolder(f.path)}
                  onRestore={() => restoreItem(f)}
                  onDelete={() => (inTrash ? purgeItem(f) : removeItem(f))}
                />
              ))}
            </div>
          )}
        </div>

        {/* Choosing and reading are two acts. The grid chooses; this reads.
            Bottom-RIGHT, where the button that commits a dialog belongs — what
            it will act on is stated to its left, so the row reads as one
            sentence: this picture → Scan. Inert until there is something to
            point it at, so the modal always says whether it is ready. */}
        <footer className="dvi-modal-foot">
          <span className="dvi-modal-foot-status">
            {picked && !busyPath && (
              <span className="dvi-modal-picked">
                <span className="dvi-modal-picked-name">{picked.name}</span>
                {picked.imported && <span className="dvi-modal-picked-tag">from this computer</span>}
              </span>
            )}
            {!picked && !busyPath && !note && (
              <span className="dvi-modal-foot-hint">Choose a picture above.</span>
            )}
            {note && (
              <p className={`dvi-modal-note is-${note.tone}`} role={note.tone === 'error' ? 'alert' : 'status'}>
                {note.text}
              </p>
            )}
          </span>
          <button
            type="button"
            className="dvi-modal-scan"
            onClick={scan}
            disabled={!picked || !!busyPath}
          >
            {busyPath ? (
              <span className="dvi-modal-scan-spin" aria-hidden="true" />
            ) : (
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 8V6a2 2 0 0 1 2-2h2M17 4h2a2 2 0 0 1 2 2v2M21 16v2a2 2 0 0 1-2 2h-2M7 20H5a2 2 0 0 1-2-2v-2" />
                <path d="M3 12h18" />
              </svg>
            )}
            {busyPath ? 'Reading…' : 'Scan'}
          </button>
        </footer>
      </div>
    </div>
  ), document.body);
}

// ── Identity record (.dvx) ──────────────────────────────────────────────
// A party to the case — a person or a company — rendered as the form it is
// rather than as the JSON it is stored as. Same fields the Files tab collects;
// this is where they are read and corrected.
//
// Saves in place, and repoints the window's tab when the party is renamed (the
// filename follows the name), exactly as the AI document generator does.
function IdentityPane({ file, onRenamed }) {
  const [record, setRecord] = useState(null);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  // What is on disk, so "unsaved changes" is a real comparison rather than a
  // flag that every keystroke sets and nothing ever clears.
  const cleanRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    setRecord(null); setErr(null);
    (async () => {
      try {
        const resp = await fetch(file.url || '', { cache: 'no-store' });
        if (!resp.ok) throw new Error(`http_${resp.status}`);
        const parsed = parseIdentity(await resp.text());
        if (cancelled) return;
        if (!parsed) { setErr('This file isn’t a valid identity record.'); return; }
        cleanRef.current = JSON.stringify(parsed);
        setRecord(parsed);
      } catch (e) {
        if (!cancelled) setErr('Couldn’t read this identity record.');
      }
    })();
    return () => { cancelled = true; };
  }, [file.url]);

  // Fill-from-a-picture drawer.
  const [autofillOpen, setAutofillOpen] = useState(false);
  // What the picture said, waiting to be judged: { fields, source }. NOT applied
  // — a record is evidence about a person, and a machine reading of a photograph
  // is a claim about it. The claim is shown under the field it concerns, in the
  // record's own form, and the person decides. That is also why the picker
  // closes the moment it has something: the answer is behind it.
  const [suggest, setSuggest] = useState(null);
  const receiveAutofill = useCallback((fields, source) => {
    setSuggest({ fields, source });
    setAutofillOpen(false);
  }, []);
  // Taking one reading, or putting it aside. Dropping the last one drops the
  // whole banner with it — an empty "read 0 details" strip is just clutter.
  const dropSuggestion = useCallback((key) => {
    setSuggest((sg) => {
      if (!sg) return sg;
      const rest = { ...sg.fields };
      delete rest[key];
      return Object.keys(rest).length ? { ...sg, fields: rest } : null;
    });
  }, []);
  const useSuggestion = useCallback((key, value) => {
    setRecord((r) => (r ? { ...r, [key]: value } : r));
    dropSuggestion(key);
  }, [dropSuggestion]);
  const useAllSuggestions = useCallback((fields) => {
    setRecord((r) => (r ? { ...r, ...fields } : r));
    setSuggest(null);
  }, []);

  // "Saved" is worth a moment's confirmation, not a permanent label — so it
  // clears itself, while an error waits to be dealt with.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!savedAt) return undefined;
    setSettled(false);
    const t = window.setTimeout(() => setSettled(true), 2200);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  const rows = useMemo(() => fieldsFor(record?.kind || 'person'), [record?.kind]);
  // What the card prints, in the order a real document prints it — a short,
  // fixed set, unlike the form's full field list. Blank ones still get their
  // line (an ID card with a missing field shows the missing field).
  const cardRows = useMemo(() => {
    if (!record) return [];
    if (record.kind === 'org') {
      return [
        ['Legal name', record.legalName || record.name],
        ['Legal form', record.legalForm],
        ['CUI / VAT', record.taxId],
        ['Trade register', record.regNo],
        ['Represented by', record.representative],
        ['Contact', [record.email, record.phone].filter(Boolean).join(' · ')],
      ];
    }
    const { surname, given } = identityNameParts(record);
    return [
      ['Surname', surname],
      ['Given names', given],
      ['CNP', record.nationalId],
      ['Date of birth', record.dateOfBirth],
      ['Nationality', record.nationality],
      ['ID document', identityValueForField(record, 'idDocument')],
      ['Contact', [record.email, record.phone].filter(Boolean).join(' · ')],
    ];
  }, [record]);
  const set = (key, v) => setRecord((r) => ({ ...r, [key]: v }));
  const dirty = record ? JSON.stringify(record) !== cleanRef.current : false;
  const saveState = err ? { tone: 'error', text: err }
    : saving ? { tone: 'busy', text: 'Saving…' }
      : dirty ? { tone: 'busy', text: 'Saving shortly…' }
        : (savedAt && !settled) ? { tone: 'ok', text: 'Saved' }
          : null;

  const save = useCallback(async () => {
    if (!record || saving) return;
    setSaving(true);
    const res = await saveIdentityAt(file.path, record);
    setSaving(false);
    if (res.error) { setErr('Couldn’t save this identity record.'); return; }
    cleanRef.current = JSON.stringify(res.identity);
    setRecord(res.identity);
    setSavedAt(Date.now());
    setErr(null);
    notifyFilesChanged();
    if (res.renamed) onRenamed?.(res.filename);
  }, [file.path, record, saving, onRenamed]);

  // ⌘/Ctrl+S still works — it just flushes the autosave early rather than being
  // the only way to keep an edit.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  // Autosave. There is no Save button: a record is a form over a small JSON
  // file, and "did I keep that?" is not a question worth making anyone hold.
  // Debounced, so a burst of typing is one write rather than one per keystroke.
  useEffect(() => {
    if (!record || saving || !dirty) return undefined;
    const t = window.setTimeout(() => { save(); }, IDENTITY_AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [record, saving, dirty, save]);

  // Closing the window inside the debounce window must not lose the last edit.
  // Refs, because the cleanup runs with the values from its own render.
  const saveRef = useRef(save);
  const dirtyRef = useRef(dirty);
  useEffect(() => { saveRef.current = save; dirtyRef.current = dirty; }, [save, dirty]);
  useEffect(() => () => { if (dirtyRef.current) saveRef.current?.(); }, []);

  if (err && !record) {
    return (
      <div className="dv-noview">
        <p className="dv-noview-title">{err}</p>
        <p className="dv-noview-sub">{file.name}</p>
        <button type="button" className="dv-chip" onClick={() => localFolderApi.openPath(file.path)}>Open in default app</button>
      </div>
    );
  }
  if (!record) return <div className="dv-loading">Reading record…</div>;

  // What the picture said about ONE field, printed under that field. Shown only
  // where it would change something — a reading that matches what is already
  // there is correct and worth nothing. Where it disagrees, it says so: that is
  // the case a person actually has to look at, and the one an auto-fill that
  // "never overwrites" used to swallow in silence.
  const suggestionFor = (key, render) => {
    const value = suggest?.fields?.[key];
    if (value == null || value === '') return null;
    const current = String(record[key] ?? '').trim();
    if (current === value) return null;
    return (
      <span className={`dvi-sugg${current ? ' is-conflict' : ''}`}>
        <span className="dvi-sugg-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9V7a2 2 0 0 1 2-2h2M17 5h2a2 2 0 0 1 2 2v2M21 15v2a2 2 0 0 1-2 2h-2M7 19H5a2 2 0 0 1-2-2v-2" />
            <path d="M7 12h10" />
          </svg>
        </span>
        <span className="dvi-sugg-body">
          <span className="dvi-sugg-value">{render ? render(value) : value}</span>
          {current && <span className="dvi-sugg-note">replaces “{current}”</span>}
        </span>
        <button type="button" className="dvi-sugg-use" onClick={() => useSuggestion(key, value)}>Use</button>
        <Tooltip content="Not this one">
          <button type="button" className="dvi-sugg-drop" aria-label="Dismiss this reading" onClick={() => dropSuggestion(key)}>
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </Tooltip>
      </span>
    );
  };
  // Only the readings that still differ decide whether the banner has anything
  // left to say — accepting them one at a time has to end with it gone.
  const suggestKeys = Object.keys(suggest?.fields || {})
    .filter((k) => String(record[k] ?? '').trim() !== suggest.fields[k]);

  return (
    <div className="dvi-pane">
      {/* The card sits OUTSIDE the scroller: it is the record's identity, so it
          should stay put while the form under it is worked through, and being a
          flex item in the scroller was letting it be squeezed below its own
          content height and clipped by its rounded frame. */}
      <div className="dvi-cardwrap">
        {/* The record as a document rather than a heading: a data page in the
            shape of an ID card / passport, showing the fields that identify the
            party at a glance. It is a READ-OUT of the form below — every value
            comes straight from `record`, so typing in the form updates the card
            live and there is no second source of truth. */}
        <section className={`dvi-card${record.kind === 'org' ? ' is-org' : ''}`}>
          <div className="dvi-card-guilloche" aria-hidden="true" />
          <header className="dvi-card-band">
            <span className="dvi-card-issuer">DocVex · Case file</span>
            <span className="dvi-card-doc">{record.kind === 'org' ? 'Entity record' : 'Identity record'}</span>
            {record.origin === 'timeline' && <span className="dvi-card-origin">From the timeline</span>}
          </header>

          <div className="dvi-card-body">
            {/* No portrait panel. A monogram in a photo-shaped frame was
                standing in for a photograph the record does not have and cannot
                get — it reserved the space a picture would take to say nothing,
                and the width is better spent on the data. */}
            <div className="dvi-card-main">
              <div className="dvi-card-heading">
                <h1 className="dvi-card-name">{record.name || 'Unnamed'}</h1>
                {record.role && <span className="dvi-card-role">{record.role}</span>}
              </div>

              <dl className="dvi-card-data">
                {cardRows.map(([label, value]) => (
                  <div className="dvi-card-datum" key={label}>
                    <dt>{label}</dt>
                    <dd className={value ? undefined : 'is-blank'}>{value || '—'}</dd>
                  </div>
                ))}
                {record.address && (
                  <div className="dvi-card-datum is-wide">
                    <dt>{record.kind === 'org' ? 'Registered office' : 'Address'}</dt>
                    <dd>{record.address}</dd>
                  </div>
                )}
              </dl>
            </div>
          </div>

          {/* The strip a passport's data page ends on. Generated from the
              fields above on every render, so it can never disagree with them;
              hidden from assistive tech, which already read the real values. */}
          <footer className="dvi-card-mrz" aria-hidden="true">
            {identityMrz(record).map((line, i) => <span key={i}>{line}</span>)}
          </footer>

          {/* Bottom-left of the card, over the machine strip: the details on
              this record are already written on a document somewhere, and
              typing them again is work a computer should be doing. */}
          <Tooltip content="Read the details off a photo of the ID or certificate">
            <button
              type="button"
              className={`dvi-card-action${autofillOpen ? ' is-on' : ''}`}
              onClick={() => setAutofillOpen((v) => !v)}
              aria-expanded={autofillOpen}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
                <circle cx="12" cy="12" r="3.2" />
              </svg>
              Auto-complete
            </button>
          </Tooltip>
        </section>
      </div>

      {/* Everything that is edited, scrolling under the card. */}
      <div className="dvi-sheet">
        {/* The picture has been read and the picker is gone; this is what it
            found. Nothing is in the record yet — each reading sits under its own
            field below, and this is the shortcut for when they are all right. */}
        {suggestKeys.length > 0 && (
          <div className="dvi-suggbar" role="status">
            <span className="dvi-suggbar-text">
              <strong>{suggestKeys.length}</strong>
              {suggestKeys.length === 1 ? ' detail read from ' : ' details read from '}
              <span className="dvi-suggbar-src">{suggest.source || 'the picture'}</span>
              {' — each one is waiting under its field.'}
            </span>
            <button
              type="button"
              className="dvi-suggbar-all"
              onClick={() => useAllSuggestions(Object.fromEntries(suggestKeys.map((k) => [k, suggest.fields[k]])))}
            >
              Use all
            </button>
            <Tooltip content="Discard everything it read">
              <button type="button" className="dvi-suggbar-drop" onClick={() => setSuggest(null)} aria-label="Discard all readings">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </Tooltip>
          </div>
        )}

        <div className="dvi-kinds" role="radiogroup" aria-label="Kind of party">
          {IDENTITY_KINDS.map((k) => (
            <button
              type="button"
              key={k.id}
              role="radio"
              aria-checked={record.kind === k.id}
              className={`dvi-kind${record.kind === k.id ? ' is-on' : ''}`}
              onClick={() => set('kind', k.id)}
            >
              <span className="dvi-kind-label">{k.label}</span>
              <span className="dvi-kind-hint">{k.hint}</span>
            </button>
          ))}
        </div>

        <label className="dvi-field">
          <span className="dvi-label">Name</span>
          <input
            className="dvi-input"
            value={record.name}
            placeholder={record.kind === 'org' ? 'Acme SRL' : 'Ionescu Maria'}
            onChange={(e) => set('name', e.target.value)}
          />
          <span className="dvi-hint">Renaming the party renames this file too, once you stop typing.</span>
        </label>

        <label className="dvi-field">
          <span className="dvi-label">Role in the case</span>
          <input
            className="dvi-input"
            list="dvi-roles"
            value={record.role}
            placeholder="Client, opposing party, witness…"
            onChange={(e) => set('role', e.target.value)}
          />
          <datalist id="dvi-roles">
            {IDENTITY_ROLES.map((r) => <option value={r} key={r} />)}
          </datalist>
        </label>

        {/* Origin — which country's format this record follows. Everything the
            app knows is listed, but only Romania can be picked: the field set
            below, the address and ID splitters, and the Romanian clause
            transforms are all built to that practice. Greying the rest out is
            the honest version of "not yet"; hiding them would suggest the
            question had never been asked. */}
        <label className="dvi-field">
          <span className="dvi-label">Origin</span>
          <select
            className="dvi-input dvi-select"
            value={record.jurisdiction || 'RO'}
            onChange={(e) => set('jurisdiction', e.target.value)}
          >
            {IDENTITY_ORIGINS.map((o) => (
              <option key={o.code} value={o.code} disabled={!o.available}>
                {o.flag} {o.name}{o.available ? '' : ' — not supported yet'}
              </option>
            ))}
          </select>
          <span className="dvi-hint">
            Romanian format: CNP and act of identity for a person, CUI and Trade
            Register number for a company.
          </span>
        </label>

        <div className="dvi-grid">
          {rows.map((f) => (
            f.choices === 'gender' ? (
              /* Three states, all of them short — buttons say what the options
                 ARE, where a text field would have made the user guess and
                 typed answers would never have matched. */
              <div className="dvi-field" key={f.key}>
                <span className="dvi-label">{f.label}</span>
                <div className="dvi-choice" role="radiogroup" aria-label={f.label}>
                  {IDENTITY_GENDERS.filter((g) => g.id).map((g) => {
                    const on = (record[f.key] || '') === g.id;
                    return (
                      <button
                        type="button"
                        key={g.id}
                        role="radio"
                        aria-checked={on}
                        className={`dvi-choice-opt${on ? ' is-on' : ''}`}
                        // Clicking the chosen one again clears it: "not
                        // specified" has to be reachable, and a fourth button
                        // for it would read as a fourth kind of person.
                        onClick={() => set(f.key, on ? '' : g.id)}
                      >
                        {g.label}
                      </button>
                    );
                  })}
                </div>
                {suggestionFor(f.key, (v) => IDENTITY_GENDERS.find((g) => g.id === v)?.label || v)}
                {f.hint && <span className="dvi-hint">{f.hint}</span>}
              </div>
            ) : (
            <label className={`dvi-field${f.multiline ? ' is-wide' : ''}`} key={f.key}>
              <span className="dvi-label">{f.label}</span>
              {f.choices === 'idType' || f.choices === 'legalForm' ? (
                /* The common answers offered, but still an input: a form or an
                   act type nobody listed has to remain typeable. */
                <>
                  <input
                    className="dvi-input"
                    list={`dvi-choices-${f.key}`}
                    value={record[f.key] || ''}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                  <datalist id={`dvi-choices-${f.key}`}>
                    {(f.choices === 'idType' ? IDENTITY_ID_TYPES : IDENTITY_LEGAL_FORMS)
                      .map((c) => <option value={c} key={c} />)}
                  </datalist>
                </>
              ) : f.multiline ? (
                <textarea className="dvi-input dvi-textarea" rows={2} value={record[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} />
              ) : (
                <input className="dvi-input" value={record[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} />
              )}
              {suggestionFor(f.key)}
              {/* What the parse understood, part by part. The address is one
                  field, but a clause asks for it five blanks at a time — so the
                  split has to be visible, or a line it reads wrongly quietly
                  mis-fills the document. Shown only once something is typed. */}
              {/* Which of the two the typed value turned out to be. It decides
                  how the document reads — "județul X" everywhere in the country,
                  "sectorul N" in București alone — so it is shown rather than
                  assumed. "Not recognised" is a real answer: the clause then
                  keeps its both-form rather than being made to pick a half. */}
              {f.parsed === 'county' && (record[f.key] || '').trim() && (() => {
                const seen = classifyCounty(record[f.key], record.city);
                return (
                  <span className="dvi-parsed">
                    <span className={`dvi-parsed-bit${seen.kind ? '' : ' is-unknown'}`}>
                      <span className="dvi-parsed-key">{seen.kind ? 'Read as' : '?'}</span>
                      {seen.kind ? `${seen.label} · ${seen.value}` : 'Not a Romanian county or sector'}
                    </span>
                  </span>
                );
              })()}
              {f.parsed === 'address' && (record[f.key] || '').trim() && (
                <span className="dvi-parsed">
                  {ADDRESS_PART_LABELS.map(([key, label]) => {
                    let value = identityValueForField(record, key);
                    if (key === 'addressLocality') {
                      // A sector is read as part of its city, not beside it:
                      // "Sector 2" alone could be any of six in one town, and
                      // the two are always written together in an address.
                      const sector = identityValueForField(record, 'addressSector');
                      const tidy = sector ? classifyCounty(sector, value).value || sector : '';
                      if (tidy) value = value ? `${value} · ${tidy}` : tidy;
                    }
                    if (!value) return null;
                    return (
                      <span className="dvi-parsed-bit" key={key}>
                        <span className="dvi-parsed-key">{label}</span>
                        {value}
                      </span>
                    );
                  })}
                </span>
              )}
              {f.hint && <span className="dvi-hint">{f.hint}</span>}
            </label>
            )
          ))}
        </div>

        <label className="dvi-field">
          <span className="dvi-label">Notes</span>
          <textarea
            className="dvi-input dvi-textarea"
            rows={4}
            value={record.notes || ''}
            placeholder="Anything worth remembering about this party."
            onChange={(e) => set('notes', e.target.value)}
          />
        </label>

        {/* Where each detail was read from, so a disputed one can be traced
            back to the document it came out of. */}
        {record.sources?.length > 0 && (
          <div className="dvi-field">
            <span className="dvi-label">Taken from</span>
            <div className="dvi-sources">
              {record.sources.map((sname) => <span className="dvi-source" key={sname}>{sname}</span>)}
            </div>
          </div>
        )}
      </div>

      {/* The record saves itself, so the footer shelf that used to hold a Save
          button has nothing left to be. What remains is a pill that floats over
          the corner of the sheet and says where the write got to — kept because
          a write to disk that leaves no trace is indistinguishable from one that
          failed. It fades out once a save has settled; an error stays. */}
      <IdentityAutofillModal
        open={autofillOpen}
        onClose={() => setAutofillOpen(false)}
        record={record}
        onFilled={receiveAutofill}
      />

      {saveState && (
        <div
          className={`dvi-pill is-${saveState.tone}`}
          role={saveState.tone === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          <span className="dvi-pill-dot" aria-hidden="true" />
          <span className="dvi-pill-text">{saveState.text}</span>
        </div>
      )}
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
function PptxRenderPane({ url, onExportPdf, onOpenNative }) {
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
        {deck && deck.slides.length > 0 && (
          <span className="dv-pptx-count">{deck.slides.length} slide{deck.slides.length === 1 ? '' : 's'}</span>
        )}
        {mode === 'render' && onExportPdf && deck && deck.slides.length > 0 && (
          <>
            <div className="dv-docview-spacer" />
            <OpenNativeButton onOpen={onOpenNative} kind="pptx" />
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

function DocPane({ file, onWhatsAppDetected, onRenamed, sidePanelSlot = null, sideTabsSlot = null, regenTick = 0 }) {
  const { notify } = useNotifications();
  const { kind: baseKind, mime } = useMemo(
    () => classify(file.mime, file.name, file.path),
    [file.mime, file.name, file.path],
  );
  // A record saved as plain `.json` OUTSIDE the Identities folder can only be
  // recognised by reading it. Records are tiny, and this runs for `.json` files
  // alone, so the read costs nothing worth avoiding — and showing somebody's
  // party as raw JSON is the thing actually worth avoiding.
  const [jsonIsRecord, setJsonIsRecord] = useState(false);
  useEffect(() => {
    setJsonIsRecord(false);
    if (baseKind === 'identity' || extOf(file.name) !== 'json') return undefined;
    let cancelled = false;
    (async () => {
      try {
        // readLocalBlob, not the localfile:// URL — this has to work on the web
        // build too, where there is no such scheme.
        const blob = await readLocalBlob(file.path || file.name);
        if (!blob || cancelled) return;
        const text = await blob.text();
        if (!cancelled && looksLikeIdentityJson(text)) setJsonIsRecord(true);
      } catch { /* unreadable — leave it as the text file it looks like */ }
    })();
    return () => { cancelled = true; };
  }, [baseKind, file.name, file.path]);
  const kind = jsonIsRecord ? 'identity' : baseKind;
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
  const adv = useMultitoolAdvisor();
  const switchingVersion = !!adv?.switching;
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
  const mainClass = kind === 'text' || kind === 'sheet' || kind === 'identity' ? 'is-flush' : '';

  // The preview is an in-app reconstruction; this opens the actual file in
  // whatever app the OS associates with it (Word, PowerPoint, Excel…).
  const openNative = () => localFolderApi.openPath(file.path);

  let content;
  if (kind === 'docx') {
    content = <DocxRenderPane url={url} onExportPdf={exportPdfNextTo} onOpenNative={openNative} />;
  } else if (kind === 'pptx') {
    content = <PptxRenderPane url={url} onExportPdf={exportPdfNextTo} onOpenNative={openNative} />;
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
    content = <SpreadsheetPane file={previewFile} url={url} onExportPdf={exportPdfNextTo} onOpenNative={openNative} />;
  } else if (kind === 'identity') {
    content = <IdentityPane file={{ ...file, url }} onRenamed={onRenamed} />;
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
        <DocumentWithPanel
          file={previewFile}
          url={url}
          kind={kind}
          mainClass={mainClass}
          sidePanelSlot={sidePanelSlot}
          sideTabsSlot={sideTabsSlot}
        >
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

// ── Complete-data panel ────────────────────────────────────────────────────
// Slides in on the right while "Complete data" is on, one card per blank found
// in the document. Suggestions arrive already sorted into where they came from:
// what the document and this conversation imply, and what was actually read out
// of the files in the project folder. Every card also takes a typed answer, so a
// blank the AI has nothing for is still one field away from being filled.
// Does this record say where the party is at all? Without a city, a county or an
// address there is nothing to decide "județul/sectorul" from, and the both-form
// is still the correct wording — so it is left alone.
// Does the record say anything about the street at all? House-vs-flat is only
// decidable when it does — with no address, "bl. […] sc. […] ap. […]" might yet
// be right, so the clause keeps them.
const addressKnown = (rec) => !!String(
  rec?.address || rec?.addressStreet || rec?.addressNumber || rec?.addressBlock || '',
).trim();

const locationKnown = (rec) => !!String(
  rec?.city || rec?.county || rec?.address || rec?.addressStreet || rec?.addressLocality || '',
).trim();

function DocFieldsPanel() {
  const adv = useMultitoolAdvisor();
  const fields = adv?.fields || [];
  const completing = !!adv?.completing;

  const [values, setValues] = useState({});      // fieldId → chosen/typed value
  const [saving, setSaving] = useState(false);

  // Suggestions live in the advisor context, keyed by the document they were
  // answered for, so closing and reopening this panel shows what was already
  // fetched instead of starting over.
  const { map: suggestions, loading, error } = adv?.fieldSuggestions || {};
  const fieldsSig = adv?.fieldsSig || '';
  // Stable across renders (both are useCallback in the provider), so effects
  // below key off these rather than the whole context value — which changes on
  // every chat message and would re-run them constantly.
  const ensureFieldSuggestions = adv?.ensureFieldSuggestions;
  const getDocumentText = adv?.getDocumentText;
  // Suggestions cover the whole document even though this panel lists one
  // paragraph — see the provider's `allFields`.
  const allFields = adv?.allFields || [];

  // Typed and chosen answers belong to one document — a new version clears
  // them, reopening the panel does not.
  const sigRef = useRef(fieldsSig);
  useEffect(() => {
    if (sigRef.current === fieldsSig) return;
    sigRef.current = fieldsSig;
    setValues({});
  }, [fieldsSig]);

  // Normally a no-op: the pane warms this the moment the document renders. It
  // matters when the warm-up was skipped or failed, or when the folder changed
  // while the panel was closed.
  useEffect(() => {
    if (!completing || !allFields.length) return;
    ensureFieldSuggestions?.(allFields, getDocumentText?.() || '', fieldsSig);
  }, [completing, allFields, fieldsSig, ensureFieldSuggestions, getDocumentText]);

  const runSuggest = useCallback(() => {
    if (!allFields.length) return;
    ensureFieldSuggestions?.(allFields, getDocumentText?.() || '', fieldsSig, { force: true });
  }, [ensureFieldSuggestions, getDocumentText, allFields, fieldsSig]);

  // Which blank is lit, on BOTH sides at once. There is no selection any more:
  // pointing at a card marks its gap in the document, pointing at a gap in the
  // document marks its card, and moving away from either drops it. Nothing has
  // to be clicked to see where a field lands, and nothing stays marked
  // afterwards.
  const setHoverField = adv?.setHoverField;
  const hoverField = adv?.hoverField || null;
  const hoverCard = useCallback((id) => { setHoverField?.(id); }, [setHoverField]);
  // Leaving the panel entirely (or the panel unmounting) must not leave a gap
  // lit in the document with nothing pointing at it.
  useEffect(() => () => setHoverField?.(null), [setHoverField]);
  // A new document has different blanks — none of the old ids mean anything.
  useEffect(() => { setHoverField?.(null); }, [fieldsSig, setHoverField]);

  const choose = useCallback((id, v) => {
    // Hand any running preview over rather than ending it: the mouseleave that
    // follows the click would otherwise restore the placeholder over the value
    // it just committed. Same reasoning as fillFromIdentity.
    adv?.endFieldPreview?.(true);
    setValues((m) => ({ ...m, [id]: v }));
    adv?.setFieldValue?.(id, v);
  }, [adv]);


  // ── Fill every blank about one party at once ──────────────────────────
  // A picked paragraph is usually asking for ONE person's details spread over
  // four or five blanks — name, CNP, address, ID series. Every one of them is
  // already on a record in the Files tab, so offer the record instead of making
  // the user retype what the project knows.
  //
  // The per-field inputs stay exactly as they were: this fills what it
  // recognises and leaves the rest (and anything it got wrong) to be typed or
  // picked by hand, which is why the rules can afford to be conservative.
  const [identities, setIdentities] = useState([]);
  const loadIdentities = adv?.loadIdentities;
  // Which of this paragraph's blanks are asking for identity details at all.
  // Resolved as a SEQUENCE, not one at a time: an identification clause labels
  // its gaps in the prose before them, so two blanks can carry the same word and
  // mean different things — the "nr." after a street is a house number, the one
  // after a series is a document number. Reading them in order settles it.
  const identityTargets = useMemo(() => {
    const resolved = resolveIdentityFields(fields.map((f) => f.label));
    return fields
      .map((f, i) => ({ id: f.id, key: resolved[i]?.key || null, role: resolved[i]?.role || null }))
      .filter((t) => t.key);
  }, [fields]);

  // Blanks grouped by the party they name. A generated clause tags them
  // ([[seller.legalName]], [[buyer.nationalId]]), and a clause naming two
  // people has to be fillable from two different records — so each party gets
  // its own row of chips rather than one row that fills everything at once.
  // Untagged blanks (an older document, a hand-written one) form a single
  // unnamed group, which is the behaviour there has always been.
  const targetGroups = useMemo(() => {
    const byRole = new Map();
    for (const t of identityTargets) {
      const role = t.role || '';
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push(t);
    }
    return Array.from(byRole, ([role, targets]) => ({ role, targets }));
  }, [identityTargets]);
  useEffect(() => {
    if (!identityTargets.length || !loadIdentities) { setIdentities([]); return undefined; }
    let cancelled = false;
    (async () => {
      const list = await loadIdentities();
      if (!cancelled) setIdentities(list || []);
    })();
    return () => { cancelled = true; };
  }, [identityTargets.length, loadIdentities, fieldsSig]);

  // How many of this paragraph's blanks a given record can actually answer —
  // shown on its chip, so picking between two parties isn't guesswork.
  const fillCountFor = useCallback(
    (rec, targets) => targets.filter((t) => identityValueForField(rec, t.key)).length,
    [],
  );
  // Blanks this record answers by REMOVING them — the block/stair/flat lines of
  // a clause being filled with a house address.
  const dropCountFor = useCallback((rec, targets) => (
    (addressKnown(rec) && !addressIsApartment(rec))
      ? targets.filter((t) => APARTMENT_ONLY_FIELDS.includes(t.key)).length
      : 0
  ), []);

  // What a record would put in each blank — the one computation behind both
  // the hover preview and the click that commits it.
  const valuesFromIdentity = useCallback((rec, targets) => {
    const next = {};
    for (const t of targets) {
      const v = identityValueForField(rec, t.key);
      if (v) next[t.id] = v;
    }
    return next;
  }, []);

  // Hovering a chip writes that party into the document's blanks so the
  // paragraph can be READ with them in it — choosing between two parties is a
  // question about how the sentence comes out, which a column of values in a
  // side panel can't answer. Nothing is committed and nothing is marked edited;
  // leaving puts back whatever was there.
  const previewIdentity = useCallback((rec, targets) => {
    // Everything the click would do — values, the block/flat lines a house
    // address removes, the agreement its gender settles — so what you see on
    // hover is what you get.
    const drop = (addressKnown(rec) && !addressIsApartment(rec))
      ? targets.filter((t) => APARTMENT_ONLY_FIELDS.includes(t.key)).map((t) => t.id)
      : [];
    adv?.previewFields?.(valuesFromIdentity(rec, targets), {
      drop,
      gender: rec.gender || '',
      hasSectors: locationKnown(rec) ? addressHasSectors(rec) : null,
    });
  }, [adv, valuesFromIdentity]);
  const endPreview = useCallback(() => { adv?.endFieldPreview?.(false); }, [adv]);

  // The same preview for ONE blank: hovering a suggestion drops it into the gap
  // in the document so the sentence can be read with it in place. Choosing
  // between "S.C. ACME S.R.L." and "ACME SRL" is a question about how the
  // clause reads, and the card can't answer it.
  const previewSuggestion = useCallback((fieldId, value) => {
    if (!value) return;
    adv?.previewFields?.({ [fieldId]: value });
  }, [adv]);

  // Filling OVERWRITES: naming a party is an explicit instruction, and picking
  // the wrong record first has to be undoable by picking the right one. Blanks
  // the record has nothing for are left alone rather than being blanked out.
  const fillFromIdentity = useCallback((rec, targets) => {
    const next = valuesFromIdentity(rec, targets);
    // Hand the preview over BEFORE writing: the mouseleave that follows the
    // click would otherwise restore the placeholders over the values it just
    // committed.
    adv?.endFieldPreview?.(true);
    for (const [id, v] of Object.entries(next)) adv?.setFieldValue?.(id, v);
    // A house has no block, stair, floor or flat — take those clauses out
    // rather than leaving a row of empty gaps behind. Only when the record
    // actually HAS an address: with nothing to go on, leave the draft alone.
    if (addressKnown(rec) && !addressIsApartment(rec)) {
      const drop = targets
        .filter((t) => APARTMENT_ONLY_FIELDS.includes(t.key))
        .map((t) => t.id);
      if (drop.length) adv?.dropFields?.(drop);
    }
    // …and settle the two agreements the formula left open: who the party is,
    // and whether their city is the one with sectors.
    if (rec.gender) adv?.applyGender?.(rec.gender);
    if (locationKnown(rec)) adv?.applyLocality?.(addressHasSectors(rec));
    if (Object.keys(next).length) setValues((m) => ({ ...m, ...next }));
  }, [adv, valuesFromIdentity]);

  // A pick dropped, or the panel closed, while a preview was showing.
  useEffect(() => () => { adv?.endFieldPreview?.(false); }, [adv]);


  const filled = fields.filter((f) => (values[f.id] || '').trim()).length;

  const save = useCallback(async () => {
    setSaving(true);
    await adv?.applyFields?.();
    setSaving(false);
  }, [adv]);

  return (
    <aside className="dv-fields-card" aria-label="Complete data" aria-hidden={!completing}>
      <header className="dv-fields-head">
        <div className="dv-fields-head-text">
          <span className="dv-fields-eyebrow">This paragraph</span>
          <h2 className="dv-fields-title">
            {fields.length === 0 ? 'Nothing to fill in' : `${filled} of ${fields.length} filled`}
          </h2>
        </div>
        <Tooltip content="Close — drops the paragraph you picked">
          <button
            type="button"
            className="dv-fields-close"
            onClick={() => adv?.clearPick?.()}
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </Tooltip>
      </header>

      <div className="dv-fields-body">
        {targetGroups.length > 0 && identities.length > 0 && (
          <div className="dv-fields-parties">
            <span className="dv-fields-parties-label">
              Fill from a party
              <span className="dv-fields-parties-hint">
                {identityTargets.length} of {fields.length} {fields.length === 1 ? 'blank' : 'blanks'} recognised
              </span>
            </span>
            {targetGroups.map(({ role, targets }) => {
              // Only the records that can answer something in THIS party's
              // blanks; a chip that would fill nothing is noise.
              const usable = identities.filter((r) => fillCountFor(r, targets) > 0 || dropCountFor(r, targets) > 0);
              if (!usable.length) return null;
              return (
                <div className="dv-fields-party-group" key={role || '_'}>
                  {/* Named only when the document named it — an untagged
                      paragraph has one implicit party and needs no label. */}
                  {role && <span className="dv-fields-party-role">{role}</span>}
                  <div className="dv-fields-parties-list">
                    {usable.map((rec) => {
                      const fills = fillCountFor(rec, targets);
                      const drops = dropCountFor(rec, targets);
                      return (
                        <Tooltip
                          key={(rec._path || rec.id || rec.name) + role}
                          content={
                            `Fill ${fills} of ${role ? `the ${role}'s` : "this paragraph's"} blanks from ${rec.name || 'this record'}`
                            + (drops > 0 ? ` — and remove the ${drops} block/flat lines, since this address is a house` : '')
                            + (rec.gender ? ', settling the Romanian agreement for this party' : '')
                          }
                        >
                          <button
                            type="button"
                            className="dv-fields-party"
                            onClick={() => fillFromIdentity(rec, targets)}
                            onMouseEnter={() => previewIdentity(rec, targets)}
                            onMouseLeave={endPreview}
                            onFocus={() => previewIdentity(rec, targets)}
                            onBlur={endPreview}
                          >
                            <span className="dv-fields-party-mono" aria-hidden="true">{identityInitials(rec)}</span>
                            <span className="dv-fields-party-text">
                              <span className="dv-fields-party-name">{rec.name || 'Unnamed'}</span>
                              <span className="dv-fields-party-meta">
                                {rec.role ? `${rec.role} \u00b7 ` : ''}
                                fills {fills}
                                {drops > 0 ? `, drops ${drops}` : ''}
                              </span>
                            </span>
                          </button>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {fields.length === 0 && (
          <p className="dv-fields-empty">
            The paragraph you picked has no blanks in it. Pick one with a marked
            gap to fill it in here.
          </p>
        )}

        {loading && (
          <div className="dv-fields-loading">
            <span className="dv-fields-spinner" aria-hidden="true" />
            <span>Reading the document and your project files…</span>
          </div>
        )}
        {error && <p className="dv-fields-error">{error}</p>}

        {fields.map((f) => {
          const all = suggestions?.[f.id] || [];
          const fromContext = all.filter((sg) => sg.source === 'context');
          const fromFiles = all.filter((sg) => sg.source === 'file');
          const value = values[f.id] || '';
          return (
            <section
              className={`dv-field-card${value.trim() ? ' is-filled' : ''}${hoverField === f.id ? ' is-active' : ''}`}
              key={f.id}
              // Pointing at the card lights its gap in the document. Keyboard
              // users get the same link from focus, which is the pointer's
              // equivalent for them.
              onMouseEnter={() => hoverCard(f.id)}
              onMouseLeave={() => hoverCard(null)}
              onFocusCapture={() => hoverCard(f.id)}
              onBlurCapture={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) hoverCard(null);
              }}
            >
              <button
                type="button"
                className="dv-field-label"
                // Clicking still SCROLLS to the gap — hovering only marks it,
                // because a page that jumped under the pointer every time it
                // crossed a card would be unusable.
                onClick={() => adv?.focusField?.(f.id)}
                title="Show where this sits in the document"
              >
                <span className="dv-field-label-text">{f.label}</span>
              </button>

              {fromContext.length > 0 && (
                <div className="dv-field-group">
                  <div className="dv-field-group-head">
                    <span className="dv-field-group-dot is-context" aria-hidden="true" />
                    <span>From this document</span>
                  </div>
                  {fromContext.map((sg, i) => (
                    <button
                      type="button"
                      key={`c${i}`}
                      className={`dv-field-sugg${value === sg.value ? ' is-picked' : ''}`}
                      onClick={() => choose(f.id, sg.value)}
                      onMouseEnter={() => previewSuggestion(f.id, sg.value)}
                      onMouseLeave={endPreview}
                      onFocus={() => previewSuggestion(f.id, sg.value)}
                      onBlur={endPreview}
                    >
                      <span className="dv-field-sugg-val">{sg.value}</span>
                      {sg.why && <span className="dv-field-sugg-why">{sg.why}</span>}
                    </button>
                  ))}
                </div>
              )}

              {fromFiles.length > 0 && (
                <div className="dv-field-group">
                  <div className="dv-field-group-head">
                    <span className="dv-field-group-dot is-file" aria-hidden="true" />
                    <span>From your project files</span>
                  </div>
                  {fromFiles.map((sg, i) => (
                    <button
                      type="button"
                      key={`f${i}`}
                      className={`dv-field-sugg${value === sg.value ? ' is-picked' : ''}`}
                      onClick={() => choose(f.id, sg.value)}
                      onMouseEnter={() => previewSuggestion(f.id, sg.value)}
                      onMouseLeave={endPreview}
                      onFocus={() => previewSuggestion(f.id, sg.value)}
                      onBlur={endPreview}
                    >
                      <span className="dv-field-sugg-val">{sg.value}</span>
                      <span className="dv-field-sugg-src">{sg.file}</span>
                      {sg.why && <span className="dv-field-sugg-why">{sg.why}</span>}
                    </button>
                  ))}
                </div>
              )}

              <input
                className="dv-field-input"
                type="text"
                value={value}
                placeholder="Or write your own…"
                onChange={(e) => choose(f.id, e.target.value)}
              />
            </section>
          );
        })}
      </div>

      <footer className="dv-fields-foot">
        <button
          type="button"
          className="dv-fields-btn"
          onClick={runSuggest}
          disabled={loading || !fields.length}
        >
          {loading ? 'Suggesting…' : 'Suggest again'}
        </button>
      </footer>
    </aside>
  );
}

// ── Find in this document ───────────────────────────────────────────────
// Windows-style find, pinned to the top-left of the document area: typing
// highlights EVERY match at once, Enter walks them (Shift+Enter walks back),
// and the chip says which one you are on out of how many.
//
// It reuses the team chat's `useChatFind`, which paints through the CSS Custom
// Highlight API rather than by wrapping matches in elements. That matters more
// here than it does in a chat: this same DOM carries the blank markers, the
// paragraph pick, the contenteditable edit tracking and the hover previews, and
// a find that inserted <mark> tags into it would corrupt every one of them. The
// API points Ranges at the text nodes already there and styles them from CSS —
// the document is never touched.
const FIND_GLYPH = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.6-3.6" />
  </svg>
);

function DocFindBar({ containerRef }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);
  const find = useChatFind({ containerRef, query, name: 'docfind' });

  // ⌘/Ctrl+F focuses the bar instead of opening the browser's own find, which
  // would search the app's chrome as well and can't see the document's scroll.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`dv-find${query ? ' is-active' : ''}`} role="search">
      <span className="dv-find-glyph" aria-hidden="true">{FIND_GLYPH}</span>
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder="Search this document"
        aria-label="Search this document"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Escape in here clears the search. It must NOT reach the document's
          // window handler, which reads Escape as "drop the picked paragraph".
          e.stopPropagation();
          if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); return; }
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) find.goPrev(); else find.goNext();
          }
        }}
      />
      {/* One slot, two states — the keyboard hint until there is a query, then
          the match position and the controls for walking it. Same swap the
          Files search does with its hint and clear button. */}
      {query ? (
        <>
          <span
            className={`dv-find-count${find.total === 0 ? ' is-empty' : ''}`}
            aria-live="polite"
          >
            {find.total ? `${find.current}/${find.total}` : 'No results'}
          </span>
          <Tooltip content="Previous match (Shift+Enter)">
            <button type="button" className="dv-find-btn" onClick={find.goPrev} disabled={!find.total} aria-label="Previous match">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m18 15-6-6-6 6" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip content="Next match (Enter)">
            <button type="button" className="dv-find-btn" onClick={find.goNext} disabled={!find.total} aria-label="Next match">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip content="Clear search">
            <button
              type="button"
              className="dv-find-btn"
              aria-label="Clear search"
              onClick={() => { setQuery(''); inputRef.current?.focus(); }}
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </Tooltip>
        </>
      ) : (
        <span className="dv-find-kbd">
          <kbd>{/mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'}</kbd>
          <span className="dv-find-kbd-plus">+</span>
          <kbd>F</kbd>
        </span>
      )}
    </div>
  );
}

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
  // The document's rendered body — what the find bar searches inside.
  const docPaneRef = useRef(null);
  // Is the active document still BLANK — nothing written in it yet? A blank
  // document opens on the template chooser instead of on an empty preview
  // beside an idle advisor. `null` while unknown, so nothing flashes before
  // the answer is in.
  const [docIsBlank, setDocIsBlank] = useState(null);
  // Set once the user answers "what do you want to make?", which is what
  // brings the preview and the side panel in. Kept separate from docIsBlank:
  // the document stays blank for the seconds it takes the AI to write it, and
  // the chooser must not come back in the meantime.
  const [templateChosen, setTemplateChosen] = useState(false);

  // "Complete data" mode: the advisor slides off to the left, the preview takes
  // its space, and the blanks panel comes in on the right. Lives here rather
  // than in the advisor context because it drives THIS component's layout, and
  // the provider it is handed down to is rendered below.
  const [completing, setCompleting] = useState(false);
  // Animate the preview's shift only while the mode is actually toggling —
  // otherwise dragging the advisor's resize gutter would fight a 340ms
  // transition on the same padding and feel rubbery.
  const [shifting, setShifting] = useState(false);
  const shiftTimerRef = useRef(null);
  const toggleCompleting = useCallback((next) => {
    setCompleting((cur) => (typeof next === 'function' ? next(cur) : next));
    setShifting(true);
    if (shiftTimerRef.current) window.clearTimeout(shiftTimerRef.current);
    shiftTimerRef.current = window.setTimeout(() => setShifting(false), 420);
  }, []);
  useEffect(() => () => { if (shiftTimerRef.current) window.clearTimeout(shiftTimerRef.current); }, []);
  const ADVISOR_MIN = 240;
  const ADVISOR_MAX = 960;
  const FIELDS_W = 380;
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
  // A different file has different blanks — never carry the mode across.
  useEffect(() => { setCompleting(false); }, [active?.id]);

  // Decide once per file whether it is still blank.
  //
  // Not just "zero bytes": a file created as a Word document is a valid, empty
  // .docx of a few kilobytes, and that is the common way to arrive here. So the
  // bytes are read and the TEXT is checked — bounded by a size cap, because a
  // document that large plainly has something in it and is not worth extracting
  // to find out. Keyed on the file id alone (never regenTick), so a document the
  // AI has just written doesn't get re-tested and bounce back to the chooser.
  useEffect(() => {
    setDocIsBlank(null);
    setTemplateChosen(false);
    const path = active?.path;
    const name = active?.name;
    if (!path) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const blob = await readLocalBlob(path);
        if (cancelled) return;
        if (!blob || blob.size === 0) { setDocIsBlank(true); return; }
        if (blob.size > BLANK_PROBE_MAX_BYTES) { setDocIsBlank(false); return; }
        const res = await extractFileText(blob, name);
        if (cancelled) return;
        // extractFileText reports a blank document as an ERROR ('empty'), not
        // as empty text — and a blank Word document is exactly the case this
        // whole check exists for, so it must not be lumped in with the real
        // failures. 'unsupported' (an image, a binary, a legacy .doc) means we
        // cannot tell, which is not the same as blank.
        if (res?.error) { setDocIsBlank(res.error === 'empty'); return; }
        setDocIsBlank(!(res.text || '').trim());
      } catch (err) {
        console.error('[doc-viewer] could not check whether the document is blank', err);
        if (!cancelled) setDocIsBlank(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

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
    || GENERATABLE_DOC_KINDS.has(classify(active.mime, active.name, active.path).kind);

  // The chooser stands in for the whole workspace while the document is still
  // blank AND the AI is armed to write it. `docIsBlank === true` (not truthy):
  // while the probe is in flight the answer is null and neither surface should
  // paint, or the chooser flashes over a document that turns out to have
  // content.
  const showTemplateChooser = generateArmed && docIsBlank === true && !templateChosen;

  // Audio drops the document card's rounded-corner frame so the player +
  // lyrics read as an open section rather than a boxed card.
  const activeKind = classify(active.mime, active.name, active.path).kind;
  const isAudioDoc = activeKind === 'audio';
  // Media has no text nodes to search. PDFs do now — the preview renders
  // pdf.js's text layer over the canvas — so they get the bar like Word,
  // PowerPoint and the rest. An identity record is excluded for a different
  // reason: it is a form, and every value in it is already on screen in a
  // labelled field, so there is nothing a find bar could reveal.
  const searchable = !['audio', 'video', 'image', 'other', 'identity'].includes(activeKind);

  return (
    <MultitoolAdvisorProvider
      file={active}
      footSlot={footSlot}
      generateMode={generateArmed}
      onDocWritten={() => setRegenTick((t) => t + 1)}
      onRenameFile={(newName, newMime) => applyGeneratedRename(active.id, newName, newMime)}
      completing={completing}
      setCompleting={toggleCompleting}
    >
    <div className="dv-page" ref={pageRef}>
      <CursorSpotlight contain className="dv-cursor-spotlight" />

      {/* A blank document has nothing to preview and nothing to discuss — it
          opens on the chooser, with neither the side panel nor the preview
          mounted, until it is something. */}
      {showTemplateChooser ? (
        <DocTemplateChooser onChosen={() => setTemplateChosen(true)} />
      ) : (
      <>
      {/* Body: a column holding the Documents + Multitool cards. */}
      <div className="dv-body-row">
        {/* Right column — Documents + Multitool. */}
        <div className="dv-right-col">
          {/* Main row: the document card fills the whole area; the Multitool
              panel FLOATS above its left side (absolute, see CSS). The var
              feeds the resize gutter's position. */}
          <div
            className={`dv-main-row${completing ? ' is-completing' : ''}${shifting ? ' is-shifting' : ''}`}
            style={{
              // The advisor keeps its strip; the blanks panel reserves its own
              // on the opposite side, so the preview narrows rather than
              // sliding sideways under a vanishing sidebar.
              '--dv-advisor-w': `${advisorW}px`,
              '--dv-fields-w': `${FIELDS_W}px`,
              '--dv-fields-pad': completing ? `calc(${FIELDS_W}px + 24px)` : '0px',
            }}
          >
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
                {/* Top-left of the document area, just inside the side panel's
                    edge — the corner a find bar is expected in. */}
                {searchable && <DocFindBar containerRef={docPaneRef} />}
                <div className="dv-section-pane dv-doc" ref={docPaneRef}>
                  {/* Keyed by the file id only (NOT regenTick) so writing a new
                      version doesn't remount the whole pane — that would refresh
                      and jump the chat. regenTick is passed down so only the
                      PREVIEW re-reads the file from disk. */}
                  <DocPane key={active.id} regenTick={regenTick} file={active} sidePanelSlot={sidePanelSlot} sideTabsSlot={sideTabsSlot} onWhatsAppDetected={() => markActiveWhatsApp(active.id)} onRenamed={(newName) => applyGeneratedRename(active.id, newName, 'application/json')} />
                </div>
                {/* Clarifying questions now render in the shared AskUserPanel
                    directly above the composer (see MultitoolComposer), not as an
                    overlay over the document area. */}
              </div>
            </div>

            {/* Blanks panel — mirrors the advisor on the opposite edge. Always
                mounted so it can fade rather than pop, and so a suggestion run
                already in flight isn't thrown away by a stray toggle. */}
            <DocFieldsPanel />
          </div>
        </div>
      </div>
      </>
      )}
    </div>
    </MultitoolAdvisorProvider>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import { withStyleSteer } from '../../lib/writingStyle';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
// Cursor deltas are viewport px; CSS lengths are layout px — the two differ
// under the web display-scale zoom (see lib/appZoom).
import { toLayoutPx } from '../../lib/appZoom';
import { miniHeaderSpot } from '../../lib/miniHeaderSpot';
import { useAuth } from '../../context/AuthContext';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { ICONS as I } from './aiHub';
import { askProjectAi, makeAskAnswers } from '../../lib/projectAi';
import { buildDocumentBlobSmart, withKindExtension, inferDocKind, docKindFromName, mimeForKind } from '../../lib/documentGen';
import { notifyFilesChanged, openDocViewerWindow } from '../../lib/platform';
import { describeLocalFile } from '../../lib/thumbnailDescriptor';
import FileThumbnail from '../../components/FileThumbnail';
import { useNotifications } from '../../context/NotificationsContext';
import AskUserPanel from '../../components/AskUserPanel';
import { readLocalBlob, localFolderApi } from '../../lib/localFolder';
import { readProjectsDir } from '../../lib/projectsDir';
import { extractFileText } from '../../lib/extractFileText';
import { buildProjectDigest } from '../../lib/aiProjectContext';
import { getDraggedFiles } from '../../lib/fileDragBus';
import { useChatFind } from '../../lib/useChatFind';
import Tooltip from '../../components/Tooltip';
import gavelLoader from '../../gavel-loader.svg';
import '../../lib/useChatFind.css'; // the search box's "N chats" count chip
import './ProjectScoped.css';
import './ProjectAI.css';
import './ProjectChatVariantB.css';
import './ProjectAIChat.css';

// AI — the project's AI chat. Laid out like the Chat tab (ProjectChat): a big
// Files-style masthead (.dvx-mh) that scrolls away, a sticky tools/tabs bar
// (.dvx-toolbar) that pins as the mini header, the thread flowing in the page
// scroll (.dvx-scroll-area), and the composer docked in the window footer.
// Two tabs: Chat (the assistant, with a left rail of saved conversations) and
// Debug (intentionally empty for now). Conversations persist per user+project
// in localStorage. The assistant reads the files in the project's Files tab:
// their names ground every answer, and any file the user attaches (paperclip /
// drag from Files) or mentions by name gets its text extracted and inlined.

const STORAGE_PREFIX = 'docvex.aichat.v3.';

// Steer note appended (transiently) to each turn: the model may CREATE real
// files in the project's Files tab via write_document, must ask_user when
// unsure, and otherwise just answers. Mirrors the Doc Viewer generate steer.
const FILE_STEER = '[Meta: You can CREATE real files in this project\'s Files tab with the write_document tool (kinds: docx, pptx, xlsx, pdf) — give it the COMPLETE document content. Use it when the user clearly asks you to create, draft, generate or export a document/file. '
  + 'The FIRST line of the tool\'s `summary` field MUST be a header of the exact form `[file: <filename> | folder: <folder>]`. Use the exact file name and the exact folder the user asked for; when the user did not specify a name, choose a short descriptive filename that reflects the document\'s content; when they did not specify a location, use `home` (the project\'s root Files directory). Folders are relative paths inside the project (e.g. `contracts/2026`) — never absolute paths. After that header line, write a one-sentence summary of the document. '
  + 'If you are UNSURE whether they want a file created — or which kind, or what should go in it — call ask_user FIRST instead of guessing. If they are just chatting or asking questions, answer normally in text. Never silently create a file when you are unsure.]';

// Conversation-rail width bounds (px) for the drag resizer on its divider.
const RAIL_WIDTH_KEY = 'docvex.aichat.railWidth';
// Whether the rail is hidden altogether (the toolbar's panel toggle). Kept
// separate from the width so hiding and re-showing restores the width the user
// dragged to, rather than resetting it.
const RAIL_HIDDEN_KEY = 'docvex.aichat.railHidden';
// The divider band's width (.aichat-resizer's flex-basis) — the hide slide has
// to travel the rail AND its divider to clear the shell's left edge.
const RAIL_DIVIDER_W = 9.6;
const RAIL_MIN = 168;
const RAIL_MAX = 384;
const RAIL_DEFAULT = 216;

function uid() {
  try { return crypto.randomUUID(); } catch { return `t_${Date.now()}_${Math.round(Math.random() * 1e9)}`; }
}

function makeThread() {
  const now = Date.now();
  return { id: uid(), title: 'Unnamed chat', messages: [], createdAt: now, updatedAt: now };
}

// Map UI messages to the Anthropic role/content shape. Error placeholders
// never go back to the model. `apiText` (the message + any attached-file
// context) is preferred over the displayed `text` so file context carries
// across turns without cluttering the bubble.
function toApiMessages(list) {
  return list
    .filter((m) => !m.isError && !m.interrupted)
    .map((m) => ({ role: m.who === 'me' ? 'user' : 'assistant', content: m.apiText || m.text || '' }));
}

// Read a set of project files and build a context preamble for the model.
// Text / PDF / Word / Excel contents are extracted and inlined (capped);
// anything unreadable is noted by name so the model knows what it's missing.
async function buildContextBlock(atts, intro) {
  const parts = [];
  for (const a of atts) {
    try {
      // Picked-via-button attachments carry the File blob directly; files from
      // the project folder resolve by path (Electron) or name (web).
      const blob = a.file || await readLocalBlob(a.path || a.name);
      const res = await extractFileText(blob, a.name);
      if (res.text) {
        parts.push(`File: ${a.name}\n"""\n${res.text}${res.truncated ? '\n…[content truncated]' : ''}\n"""`);
      } else {
        parts.push(`File: ${a.name} — its contents could not be read as text (${res.error || 'unsupported type'}); only the file name is available.`);
      }
    } catch {
      parts.push(`File: ${a.name} (could not be read)`);
    }
  }
  return parts.length ? `${intro}\n\n${parts.join('\n\n')}` : '';
}

// Files from the project folder the user's message refers to BY NAME — those
// get read + inlined automatically, so "summarise contract.pdf" just works
// without attaching anything. Full name or the name without its extension
// (min 4 chars, so short generic names don't false-positive); capped at 3.
function findMentionedFiles(text, files, excludeNames) {
  const t = (text || '').toLowerCase();
  const out = [];
  for (const f of files) {
    if (!f?.name || excludeNames.has(f.name)) continue;
    const full = f.name.toLowerCase();
    const base = full.replace(/\.[^.]+$/, '');
    if ((full.length >= 4 && t.includes(full)) || (base.length >= 4 && t.includes(base))) {
      out.push(f);
      if (out.length >= 3) break;
    }
  }
  return out;
}

// Highlight the matched substring of a rail item's title (Windows-Explorer-
// style search feedback). Tooltips keep the plain title.
function highlightMatch(text, q) {
  const t = String(text || '');
  if (!q) return t;
  const i = t.toLowerCase().indexOf(q);
  if (i === -1) return t;
  return (
    <>
      {t.slice(0, i)}
      <mark>{t.slice(i, i + q.length)}</mark>
      {t.slice(i + q.length)}
    </>
  );
}

// Short clock label (e.g. "14:05") for the message time mark.
function formatHM(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

// Date-grouping helpers (mirror the team/private chat).
function sameLocalDay(a, b) {
  if (!a || !b) return false;
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}
function formatDayLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (sameLocalDay(d, now)) return 'Today';
  if (sameLocalDay(d, yest)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

// Typewriter — reveals an AI answer character-by-character, rendered through
// Markdown as it grows so formatting appears live. `onTick` keeps the thread
// scrolled to the bottom while the text grows.
function Typewriter({ text, onDone, onTick }) {
  const [n, setN] = React.useState(0);
  const doneRef = React.useRef(onDone);
  const tickRef = React.useRef(onTick);
  doneRef.current = onDone;
  tickRef.current = onTick;
  React.useEffect(() => {
    const total = text.length;
    if (!total) { doneRef.current && doneRef.current(); return undefined; }
    let raf = 0;
    let start = 0;
    const dur = Math.min(Math.max(total / 90, 0.4), 6) * 1000; // ~90 chars/s, 0.4–6s
    const step = (ts) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 2);
      setN(Math.floor(eased * total));
      tickRef.current && tickRef.current();
      if (p < 1) { raf = requestAnimationFrame(step); }
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

// Contextual "thinking" status — cycles through short status words picked from
// a set matching what the user asked for (math, writing, files, code, …).
const THINKING_SETS = {
  math: ['Calculating', 'Crunching the numbers', 'Working through the math', 'Checking the figures'],
  write: ['Drafting', 'Composing', 'Choosing the words', 'Polishing'],
  legal: ['Reviewing', 'Checking the clauses', 'Weighing the details', 'Consulting the rules'],
  files: ['Reading your files', 'Scanning the documents', 'Gathering context', 'Looking things up'],
  code: ['Writing code', 'Reasoning about the logic', 'Tracing the flow', 'Working it out'],
  summary: ['Reading', 'Summarising', 'Distilling the key points', 'Pulling it together'],
  general: ['Thinking', 'Working on it', 'Reasoning', 'Putting it together'],
};

function pickThinkingSet(text) {
  const t = (text || '').toLowerCase();
  if (/(calcul|\bsum\b|total|\bmath|number|average|percent|\bcost|price|budget|amount|equation|formula|multipl|divid|add up|how much)/.test(t)) return 'math';
  if (/(write|draft|compose|email|letter|essay|paragraph|rewrite|rephrase|\bmessage\b|reply)/.test(t)) return 'write';
  if (/(legal|\blaw\b|clause|contract|statute|regulation|complian|gdpr|liabilit|court|\bcase\b|tax)/.test(t)) return 'legal';
  if (/(file|document|folder|search|\bfind\b|look up|\bpdf\b|\bdoc\b|spreadsheet|attach)/.test(t)) return 'files';
  if (/(\bcode\b|function|\bbug\b|script|\bapi\b|json|\bcss\b|html|javascript|python|\bsql\b|\berror\b|program)/.test(t)) return 'code';
  if (/(summar|tl;?dr|overview|recap|key points|\bbrief\b|explain)/.test(t)) return 'summary';
  return 'general';
}

function ThinkingStatus({ query }) {
  const set = React.useMemo(() => THINKING_SETS[pickThinkingSet(query)], [query]);
  const [i, setI] = React.useState(0);
  React.useEffect(() => {
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

export default function ProjectAI() {
  const { session } = useAuth();
  const { selectedProject, loading } = useSelectedProject();
  const user = session?.user;
  const userKey = user?.id || '_anonymous';
  const projectId = selectedProject?.id || null;

  const [tab, setTab] = useState('chat'); // 'chat' | 'debug'
  const [threads, setThreads] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [val, setVal] = useState('');
  const [streaming, setStreaming] = useState(false);
  // WHICH conversation the in-flight turn belongs to — switching chats/tabs
  // never cancels a turn; the thinking bubble only shows in that thread, and
  // a reply landing in a non-open thread marks it unread (rail + sidebar dot).
  const [streamingThread, setStreamingThread] = useState(null);
  // The AI message being revealed with the typewriter: { threadId, index }.
  const [typing, setTyping] = useState(null);
  const [copiedIdx, setCopiedIdx] = useState(null);
  const [attachments, setAttachments] = useState([]); // [{ name, path, file? }]
  const [dropActive, setDropActive] = useState(false);
  // A paused ask_user turn — the model asked clarifying questions (e.g. before
  // creating a file) and waits for answers. { id, input, assistantContent,
  // base (the exact api messages sent), threadId }.
  const [pendingAsk, setPendingAsk] = useState(null);
  // Selected created-file card (message index) — Files-tab-style selection.
  const [selectedFileCard, setSelectedFileCard] = useState(null);
  const { notify } = useNotifications();
  // Toolbar search — filters the conversation rail like the Windows Explorer
  // search box: type and the list narrows to chats whose title, messages or
  // attachment names contain the query.
  const [chatSearch, setChatSearch] = useState('');
  // Conversation-rail width — drag its right divider to resize (clamped,
  // persisted). Mirrors the team chat's rail splitter.
  const [railWidth, setRailWidth] = useState(() => {
    const n = Number(localStorage.getItem(RAIL_WIDTH_KEY));
    return Number.isFinite(n) && n >= RAIL_MIN && n <= RAIL_MAX ? n : RAIL_DEFAULT;
  });
  const [railResizing, setRailResizing] = useState(false);
  // Hidden rail: the whole conversation column slides out to the left and the
  // thread takes the space. Implemented as a negative margin rather than a
  // collapsing width so nothing INSIDE the rail reflows while it travels — the
  // list keeps its layout width the whole way out and the thread column, which
  // simply follows it, reads as being pushed across.
  const [railHidden, setRailHidden] = useState(() => {
    try { return localStorage.getItem(RAIL_HIDDEN_KEY) === '1'; } catch { return false; }
  });
  const toggleRail = () => {
    setRailHidden((v) => {
      const next = !v;
      try { localStorage.setItem(RAIL_HIDDEN_KEY, next ? '1' : '0'); } catch { /* quota */ }
      return next;
    });
  };
  const startRailResize = (e) => {
    e.preventDefault();
    setRailResizing(true);
    const startX = e.clientX;
    const startW = railWidth;
    let latest = startW;
    const onMove = (ev) => {
      // The rail sits on the LEFT — dragging the divider right widens it.
      latest = Math.max(RAIL_MIN, Math.min(RAIL_MAX, startW + toLayoutPx(ev.clientX - startX)));
      setRailWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setRailResizing(false);
      try { localStorage.setItem(RAIL_WIDTH_KEY, String(Math.round(latest))); } catch { /* quota */ }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // ── Chat-list scrollbar on the divider ─────────────────────────────────
  // The native list scrollbar is hidden; this thumb rides the resizer band,
  // vertically spanning the LIST's portion of the divider. Dragging the thumb
  // scrolls the list; dragging anywhere else on the band resizes the rail.
  const measureRailThumb = () => {
    const list = listRef.current;
    const rz = resizerRef.current;
    const thumb = sbThumbRef.current;
    if (!list || !rz || !thumb) return;
    const { scrollTop, scrollHeight, clientHeight } = list;
    if (scrollHeight <= clientHeight + 1) {
      setRailSb((s) => (s.enabled ? { ...s, enabled: false } : s));
      fadeRailItems(); // clears any leftover per-row fade
      return;
    }
    const listRect = list.getBoundingClientRect();
    const rzRect = rz.getBoundingClientRect();
    // Track = the list's vertical span, offset to where it starts within the
    // (taller) divider band. Rect px are viewport px → toLayoutPx for CSS.
    const track = toLayoutPx(listRect.height);
    const offsetTop = toLayoutPx(listRect.top - rzRect.top);
    const h = Math.max(28, (clientHeight / scrollHeight) * track);
    const maxY = track - h;
    const y = offsetTop + (scrollTop / (scrollHeight - clientHeight)) * maxY;
    thumb.style.height = `${h}px`;
    thumb.style.transform = `translateY(${y}px)`;
    setRailSb((s) => (s.enabled ? s : { ...s, enabled: true }));
    fadeRailItems();
  };
  const flashRailThumb = () => {
    setRailSb((s) => (s.enabled && !s.show ? { ...s, show: true } : s));
    if (sbHideTimer.current) clearTimeout(sbHideTimer.current);
    sbHideTimer.current = setTimeout(() => setRailSb((s) => ({ ...s, show: false })), 1100);
  };
  const onListScroll = () => {
    if (listScrollRaf.current == null) {
      listScrollRaf.current = requestAnimationFrame(() => {
        listScrollRaf.current = null;
        measureRailThumb();
        flashRailThumb();
      });
    }
  };
  // Re-measure whenever the list's size/content changes (filtering, rail
  // resize, new/deleted chats).
  useEffect(() => {
    measureRailThumb();
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => measureRailThumb());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads.length, chatSearch, tab, railWidth]);
  useEffect(() => () => { if (sbHideTimer.current) clearTimeout(sbHideTimer.current); }, []);
  const showRailSb = () => setRailSb((s) => (s.enabled ? { ...s, show: true } : s));
  const hideRailSb = () => setRailSb((s) => ({ ...s, show: false }));

  // Edge-fade the chat ITEMS (not the rail's background) by distance from the
  // list's viewport edges — JS opacity per row, so the app's dotted/spotlight
  // background never dims and the SELECTED row stays fully solid.
  const fadeRailItems = () => {
    const list = listRef.current;
    if (!list) return;
    const lr = list.getBoundingClientRect();
    const scrollable = list.scrollHeight > list.clientHeight + 1;
    list.querySelectorAll('.aichat-item').forEach((el) => {
      if (!scrollable || el.classList.contains('is-active')) { el.style.opacity = ''; return; }
      const r = el.getBoundingClientRect();
      const c = (r.top + r.bottom) / 2;
      const o = Math.min(1, (c - lr.top) / 28, (lr.bottom - c) / 40);
      el.style.opacity = String(Math.max(0, Math.min(1, o)));
    });
  };

  // ── Thread scrollbar (custom overlay beside the masked scroller) ───────
  const measureMsgThumb = () => {
    const el = scrollRef.current;
    const thumb = msgThumbRef.current;
    if (!el || !thumb) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight + 1) {
      setMsgSb((s) => (s.enabled ? { ...s, enabled: false } : s));
      return;
    }
    const track = toLayoutPx(el.getBoundingClientRect().height);
    const h = Math.max(28, (clientHeight / scrollHeight) * track);
    const maxY = track - h;
    const y = (scrollTop / (scrollHeight - clientHeight)) * maxY;
    thumb.style.height = `${h}px`;
    thumb.style.transform = `translateY(${y}px)`;
    setMsgSb((s) => (s.enabled ? s : { ...s, enabled: true }));
  };
  const flashMsgThumb = () => {
    setMsgSb((s) => (s.enabled && !s.show ? { ...s, show: true } : s));
    if (msgSbHideTimer.current) clearTimeout(msgSbHideTimer.current);
    msgSbHideTimer.current = setTimeout(() => { if (!msgSbDragRef.current) setMsgSb((s) => ({ ...s, show: false })); }, 1100);
  };
  const onMsgThumbDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = scrollRef.current;
    if (!el) return;
    msgSbDragRef.current = { startY: e.clientY, startScroll: el.scrollTop };
    setMsgSb((s) => ({ ...s, show: true }));
    const onMove = (ev) => {
      const d = msgSbDragRef.current;
      const el2 = scrollRef.current;
      if (!d || !el2) return;
      const track = toLayoutPx(el2.getBoundingClientRect().height);
      const h = Math.max(28, (el2.clientHeight / el2.scrollHeight) * track);
      const maxY = track - h;
      const perPx = maxY > 0 ? (el2.scrollHeight - el2.clientHeight) / maxY : 0;
      el2.scrollTop = d.startScroll + toLayoutPx(ev.clientY - d.startY) * perPx;
    };
    const onUp = () => {
      msgSbDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      flashMsgThumb();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const showMsgSb = () => setMsgSb((s) => (s.enabled ? { ...s, show: true } : s));
  const hideMsgSb = () => { if (!msgSbDragRef.current) setMsgSb((s) => ({ ...s, show: false })); };
  // Re-measure the thread thumb when the conversation / its size changes.
  useEffect(() => {
    measureMsgThumb();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => measureMsgThumb());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, activeId, tab, streaming]);
  useEffect(() => () => { if (msgSbHideTimer.current) clearTimeout(msgSbHideTimer.current); }, []);
  // Files in the project's local folder. Names ground every answer; contents
  // are read on demand (attachments + name mentions); the full facts feed the
  // project digest. Ref-only — nothing renders from it.
  const contextFilesRef = useRef([]);
  // The project's resolved local-folder path (Electron) — where the advisor
  // writes files it creates. Null on web / before the folder resolves.
  const projectDirRef = useRef(null);

  const scrollRef = useRef(null);   // the thread scroller (.aichat-main) — the
                                    // ONLY thing that scrolls on this page
  const taRef = useRef(null);       // composer textarea
  const searchRef = useRef(null);   // toolbar chat-search input (Ctrl/⌘+F)
  const fileInputRef = useRef(null);
  const stickRef = useRef(true);    // follow-the-bottom flag
  // Bumped to invalidate the in-flight turn (the Stop button): when the
  // request returns, a stale sequence number means "discard the result".
  const turnSeqRef = useRef(0);
  // Chat-list scrollbar — a custom thumb that rides ON the rail's drag-handle
  // divider (the native list scrollbar is hidden). Thumb geometry is written
  // straight to the DOM (no per-scroll re-render); state only tracks
  // enabled/shown.
  const listRef = useRef(null);      // the .aichat-list scroller
  const resizerRef = useRef(null);   // the divider band the thumb lives in
  const sbThumbRef = useRef(null);
  const sbHideTimer = useRef(null);
  const listScrollRaf = useRef(null);
  const [railSb, setRailSb] = useState({ enabled: false, show: false });
  // Thread scrollbar — a custom overlay OUTSIDE the masked bubbles scroller
  // (the edge fades are a mask on the scroller, which would wash a native
  // scrollbar; this one floats beside it, fully crisp, and is draggable).
  const msgThumbRef = useRef(null);
  const msgSbHideTimer = useRef(null);
  const msgSbDragRef = useRef(null);
  const msgScrollRaf = useRef(null);
  const [msgSb, setMsgSb] = useState({ enabled: false, show: false });
  const pendingScrollRef = useRef(false); // one-shot: force scroll on send
  const loadedFor = useRef(null);
  // Latest activeId for async callbacks (their closures hold a stale one).
  const activeIdRef = useRef(null);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  // Opening a conversation clears its "done thinking" (unread) marker.
  useEffect(() => {
    if (!activeId) return;
    setThreads((ts) => (ts.some((t) => t.id === activeId && t.unreadAt)
      ? ts.map((t) => (t.id === activeId ? { ...t, unreadAt: null } : t))
      : ts));
  }, [activeId, threads]);
  // Surface advisor activity on the sidebar's Advisor item: busy while a turn
  // runs anywhere, unread once a reply landed in a non-open conversation.
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('docvex:advisor-activity', {
        detail: { busy: streaming, unread: threads.some((t) => t.unreadAt) },
      }));
    } catch { /* no-op */ }
  }, [streaming, threads]);
  // Leaving the page: the turn dies with it, so drop the busy dot (a landed
  // unread marker persists in the threads and re-reports on next mount).
  useEffect(() => () => {
    try { window.dispatchEvent(new CustomEvent('docvex:advisor-activity', { detail: { busy: false } })); } catch { /* no-op */ }
  }, []);

  // ── Persistence — one thread list per user+project ────────────────────
  const storageKey = STORAGE_PREFIX + userKey + '.' + (projectId || '_none');
  useEffect(() => {
    if (!projectId || loadedFor.current === storageKey) return;
    loadedFor.current = storageKey;
    let saved = null;
    try {
      const raw = localStorage.getItem(storageKey);
      saved = raw ? JSON.parse(raw) : null;
    } catch { saved = null; }
    if (Array.isArray(saved) && saved.length) {
      setThreads(saved);
      setActiveId(saved[0].id);
    } else {
      setThreads([]);
      setActiveId(null);
    }
  }, [storageKey, projectId]);
  useEffect(() => {
    if (!projectId || loadedFor.current !== storageKey) return;
    try { localStorage.setItem(storageKey, JSON.stringify(threads)); } catch { /* quota */ }
  }, [threads, storageKey, projectId]);

  // ── Project file context ───────────────────────────────────────────────
  // List the selected project's local folder (the Files tab's folder) so the
  // AI knows what files exist and can read the ones the user points at.
  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const baseDir = readProjectsDir(userKey) || undefined;
        const { path } = await localFolderApi.projectDir(projectId, selectedProject?.name, baseDir);
        // Electron resolves the fixed project dir; web lists the connected
        // folder handle (path null) — listAll handles both.
        if (!cancelled) projectDirRef.current = path || null;
        const { files } = await localFolderApi.listAll(path || undefined);
        if (cancelled) return;
        // Keep the full facts — the project digest reports folder, size and
        // modified date, and the AI file-index cache keys off size+mtime.
        const list = (files || []).filter((f) => f?.name).map((f) => ({
          name: f.name,
          path: f.path || null,
          folderPath: f.folderPath || '',
          sizeBytes: f.sizeBytes ?? null,
          mtimeIso: f.mtimeIso || null,
        }));
        contextFilesRef.current = list;
      } catch {
        if (!cancelled) contextFilesRef.current = [];
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, userKey]);

  // ── Full-project context digest ─────────────────────────────────────────
  // Everything the app knows about the project (files, team chat, timeline,
  // OCR snippets, captions, metadata, members) compacted into one text block
  // that rides on the CURRENT turn only — it's never persisted into the
  // conversation, so it stays fresh and the history stays clean. Cached ~60s
  // so rapid back-and-forth doesn't refetch chat/members every message.
  const digestCache = useRef({ key: null, at: 0, text: '' });
  const getProjectDigest = async () => {
    const key = projectId;
    const c = digestCache.current;
    if (c.key === key && Date.now() - c.at < 60_000) return c.text;
    let text = '';
    try {
      text = await buildProjectDigest({ project: selectedProject, files: contextFilesRef.current });
    } catch { text = ''; }
    digestCache.current = { key, at: Date.now(), text };
    return text;
  };
  // Wrap the outgoing turn: prepend the digest to the LAST user message so the
  // model always answers with the whole project in view.
  const withProjectContext = (apiMessages, digest) => {
    if (!digest || !apiMessages.length) return apiMessages;
    const last = apiMessages[apiMessages.length - 1];
    if (last.role !== 'user' || typeof last.content !== 'string') return apiMessages;
    return [
      ...apiMessages.slice(0, -1),
      {
        ...last,
        content: `<project_context>\nA live snapshot of everything in this project — details, members, files, team chat, case timeline, OCR text snippets, audio/video captions and file metadata. Use it to answer. If you need a file's full contents that aren't included, ask the user to attach or name the file.\n\n${digest}\n</project_context>\n\n${last.content}`,
      },
    ];
  };

  const activeThread = threads.find((t) => t.id === activeId) || threads[0];
  const messages = activeThread?.messages || [];
  const hasThreads = threads.length > 0;
  const ordered = [...threads].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  // Explorer-style filter: the rail shows only the chats that match the search
  // (by title, any message's text, or an attached file's name); no query → all.
  const searchQ = chatSearch.trim().toLowerCase();
  const visibleThreads = !searchQ ? ordered : ordered.filter((t) => (
    (t.title || '').toLowerCase().includes(searchQ)
    || (t.messages || []).some((m) => (m.text || '').toLowerCase().includes(searchQ)
      || (m.attachments || []).some((n) => (n || '').toLowerCase().includes(searchQ)))
  ));

  // Highlight EVERY occurrence of the search inside the open conversation's
  // bubbles (CSS Custom Highlight API — no DOM mutation), VS-Code/Explorer
  // style: all matches tinted, Enter / Shift+Enter cycles the active one.
  const find = useChatFind({ containerRef: scrollRef, query: chatSearch, name: 'aichat', scope: '.bubble-msg' });

  // Ctrl/⌘+F focuses the chat search (matches the Chat tab).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        if (tab !== 'chat' || !threads.length) return;
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, threads.length]);

  // ── Thread scroll: stick-to-bottom tracking. Only the bubbles column
  // scrolls — the masthead, toolbar and rail stay put. ──────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      // Track + flash the custom thread scrollbar (rAF-throttled).
      if (msgScrollRaf.current == null) {
        msgScrollRaf.current = requestAnimationFrame(() => {
          msgScrollRaf.current = null;
          measureMsgThumb();
          flashMsgThumb();
        });
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [tab, hasThreads, projectId]);

  const scrollToBottom = (force = false) => {
    const el = scrollRef.current;
    if (!el) return;
    if (force !== true && !stickRef.current) return;
    if (force === true) stickRef.current = true;
    el.scrollTop = el.scrollHeight;
  };
  // Switching chats always jumps to the latest message.
  useEffect(() => { scrollToBottom(true); }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps
  // New messages / streaming stick to the bottom only if the user is there —
  // except right after sending, where we always jump to the new message.
  useEffect(() => {
    scrollToBottom(pendingScrollRef.current);
    pendingScrollRef.current = false;
  }, [messages, streaming]); // eslint-disable-line react-hooks/exhaustive-deps
  // Stop the typewriter (and drop any pending question / card selection) when
  // switching threads.
  useEffect(() => { setTyping(null); setPendingAsk(null); setSelectedFileCard(null); }, [activeId]);

  // Open a created file in the Doc Viewer (double-click on its card — same
  // action as the Files tab).
  const openCreatedFile = (cf) => {
    if (!cf?.path) return;
    try { openDocViewerWindow({ path: cf.path, name: cf.name, mime: cf.mime || '' }); } catch { /* no-op */ }
  };

  // Auto-grow the composer with its content, up to a 4-line ceiling.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 22;
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const maxH = Math.round(lh * 4 + padY);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
  }, [val]);

  // Keep the thread's bottom padding in sync with the floating composer's
  // height (it grows with the textarea, attachment chips and the ask panel)
  // so the last message can always scroll clear of it.
  useEffect(() => {
    const footer = taRef.current?.closest('.vb-composer-wrap');
    const main = scrollRef.current;
    if (!footer || !main) return undefined;
    const apply = () => {
      const h = footer.getBoundingClientRect().height;
      main.style.paddingBottom = `${Math.max(Math.round(h) + 24, 88)}px`;
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(footer);
    return () => ro.disconnect();
  }, [activeId, tab, hasThreads]);

  // ── Title generation (fire-and-forget) ─────────────────────────────────
  const generateTitle = async (threadId, firstQuestion) => {
    try {
      const prompt =
        'Write a concise 3 to 6 word title in Title Case for a chat that begins with the ' +
        `following user message. No quotes, no ending punctuation, no preamble — reply with ONLY the title.\n\n"${firstQuestion.slice(0, 600)}"`;
      const { text, error } = await askProjectAi({ messages: [{ role: 'user', content: prompt }], projectName: '', fileNames: [], tools: false, usageAction: 'chat' });
      if (error) return;
      const title = (text || '').split('\n')[0].trim().replace(/^["'“”\s]+|["'“”.\s]+$/g, '').slice(0, 48);
      if (title) setThreads((ts) => ts.map((t) => (t.id === threadId ? { ...t, title } : t)));
    } catch { /* keep placeholder title */ }
  };

  // ── File creation (write_document → the Files tab) ─────────────────────
  // Build a real Office file from the model's write_document call and save it
  // into the project's local folder, so it appears in the Files tab.
  // `opts.wantName` / `opts.wantFolder` come from the summary's
  // `[file: … | folder: …]` header (the user's exact wishes, relayed by the
  // model); with no name the fallback hint (summary/request) names it, and
  // with no folder it lands in the Files home directory. Returns
  // { ok, name, relPath, fullPath } | { ok: false, error }.
  const createProjectFile = async (kind, text, opts = {}) => {
    const home = projectDirRef.current;
    if (!home) {
      return { ok: false, error: 'I can only create files when the project folder is connected in the desktop app — open the Files tab once, then ask me again.' };
    }
    const sanitizeName = (s) => String(s || '')
      .replace(/[#*`"'“”[\]]/g, '')
      .replace(/[\\/:*?<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60)
      .trim();
    // Target folder — a sanitised relative path under the project root
    // ('home'/'root'/'.' or empty → the home directory itself).
    const rawFolder = String(opts.wantFolder || '').trim();
    const folder = /^(home|root|\.|\/|\\)?$/i.test(rawFolder)
      ? ''
      : rawFolder
        .replace(/\\/g, '/')
        .split('/')
        .map((s) => s.replace(/[:*?"<>|]/g, '').trim())
        .filter((s) => s && s !== '.' && s !== '..')
        .join('/');
    const dir = folder ? `${home}/${folder}` : home;
    // Filename — the user's exact name when given (its extension may also pin
    // the kind upstream), else derived from the summary/request.
    const base = sanitizeName(String(opts.wantName || '').replace(/\.(docx|pptx|xlsx|pdf)$/i, ''))
      || sanitizeName(String(opts.fallbackHint || '').split('\n')[0])
      || 'AI document';
    // De-dupe within the TARGET folder only.
    const norm = (p) => String(p || '').replace(/\\/g, '/');
    const taken = new Set(contextFilesRef.current
      .filter((f) => norm(f.folderPath) === folder)
      .map((f) => f.name.toLowerCase()));
    let name = withKindExtension(base, kind);
    for (let i = 2; taken.has(name.toLowerCase()); i += 1) name = withKindExtension(`${base} (${i})`, kind);
    try {
      // 'skills' prefers Anthropic's Office Skills builder (high fidelity) and
      // auto-falls back to the local docx/pptx/xlsx/pdf builders.
      const blob = await buildDocumentBlobSmart(kind, text, { engine: 'skills' });
      const wr = await localFolderApi.writeFiles({ dir, files: [{ filename: name, blob }] });
      if (wr?.error || !wr?.results?.[0]?.ok) throw new Error(wr?.error || wr?.results?.[0]?.error || 'write_failed');
      notifyFilesChanged(); // other windows (the Files tab) refresh their listings
      // Refresh the file inventory + digest so the advisor immediately knows
      // about the file it just made.
      try {
        const { files } = await localFolderApi.listAll(dir);
        contextFilesRef.current = (files || []).filter((f) => f?.name).map((f) => ({
          name: f.name, path: f.path || null, folderPath: f.folderPath || '', sizeBytes: f.sizeBytes ?? null, mtimeIso: f.mtimeIso || null,
        }));
      } catch { /* keep the stale listing */ }
      digestCache.current = { key: null, at: 0, text: '' };
      notify({
        category: 'file',
        variant: 'success',
        icon: 'sparkles',
        title: 'Document created',
        body: `“${name}” was written to your project files by the advisor.`,
        silent: true,
        payload: { activity: { action: 'generate-doc', fileName: name } },
      });
      const sep = home.includes('\\') ? '\\' : '/';
      const fullPath = `${dir}${sep}${name}`.replace(/\//g, sep === '\\' ? '\\' : '/');
      return {
        ok: true,
        name,
        relPath: folder ? `${folder}/${name}` : name,
        fullPath,
        mime: mimeForKind(kind),
      };
    } catch {
      return { ok: false, error: 'Couldn’t create the file. Please try again in a moment.' };
    }
  };

  // Streaming state helpers — track which thread the turn belongs to.
  const beginStreaming = (threadId) => { setStreaming(true); setStreamingThread(threadId); };
  const endStreaming = () => { setStreaming(false); setStreamingThread(null); };

  // Append one AI message to a thread (shared by every result path). A reply
  // landing in a thread the user ISN'T looking at marks it unread — the rail
  // row and the sidebar's Advisor item show a "done thinking" dot until the
  // conversation is opened.
  const appendAiMessage = (threadId, msg) => {
    const away = activeIdRef.current !== threadId;
    setThreads((ts) => ts.map((t) => (t.id === threadId
      ? { ...t, updatedAt: Date.now(), ...(away ? { unreadAt: Date.now() } : {}), messages: [...t.messages, msg] }
      : t)));
  };

  // Apply one model result: create a file (write_document), pause on a
  // clarifying question (ask_user), or show a plain answer. `baseMsgs` is the
  // exact api payload sent (replayed on an ask_user resume); `convoLen` is the
  // visible message count BEFORE the AI reply (the typewriter index). Owns
  // dropping the thinking state: the file build can take a while (the Office
  // Skills engine runs remotely), so `streaming` stays ON until the file is
  // actually written — otherwise the page looks dead during the build. `seq`
  // lets a Stop pressed mid-build discard the outcome.
  const applyAiResult = async (res, threadId, lastUserText, baseMsgs, convoLen, seq) => {
    if (res.tool === 'write_document' && res.toolUse?.input) {
      const input = res.toolUse.input;
      // The summary's first line carries the user's exact wishes as a
      // `[file: <name> | folder: <path>]` header (see FILE_STEER).
      const rawSummary = String(input.summary || '');
      const hdr = rawSummary.match(/^\s*\[\s*file\s*:\s*([^\]|]*)(?:\|\s*folder\s*:\s*([^\]]*))?\]\s*/i);
      const wantName = hdr ? (hdr[1] || '').trim() : '';
      const wantFolder = hdr ? (hdr[2] || '').trim() : '';
      const cleanSummary = (hdr ? rawSummary.slice(hdr[0].length) : rawSummary).trim();
      // Kind precedence: an extension on the requested filename wins, then
      // the tool's declared kind, then inference from the request/content.
      const kind = docKindFromName(wantName)
        || (['docx', 'pptx', 'xlsx', 'pdf'].includes(input.kind) ? input.kind : null)
        || inferDocKind(`${lastUserText}\n${input.content || ''}`);
      const created = await createProjectFile(kind, String(input.content || ''), {
        wantName,
        wantFolder,
        fallbackHint: cleanSummary || lastUserText,
      });
      if (seq != null && turnSeqRef.current !== seq) return; // stopped mid-build
      endStreaming();
      if (!created.ok) {
        appendAiMessage(threadId, { who: 'ai', isError: true, text: created.error, at: Date.now() });
        return;
      }
      const note = (res.text && res.text.trim())
        || cleanSummary
        || 'Here’s your document — I’ve added it to the Files tab.';
      appendAiMessage(threadId, {
        who: 'ai',
        text: note,
        at: Date.now(),
        createdFile: { name: created.name, relPath: created.relPath, path: created.fullPath, mime: created.mime },
      });
      setTyping({ threadId, index: convoLen });
      return;
    }
    endStreaming();
    if (res.tool === 'ask_user' && res.askUser) {
      appendAiMessage(threadId, { who: 'ai', text: res.text || 'A couple of quick questions first.', at: Date.now() });
      setPendingAsk({ id: res.askUser.id, input: res.askUser.input, assistantContent: res.assistantContent, base: baseMsgs, threadId });
      return;
    }
    // Guard: never render an invisible empty bubble (e.g. a truncated tool
    // call that produced neither text nor a usable tool_use).
    if (!res.text || !String(res.text).trim()) {
      appendAiMessage(threadId, { who: 'ai', isError: true, text: 'I didn’t get a usable answer back. Please try again.', at: Date.now() });
      return;
    }
    appendAiMessage(threadId, { who: 'ai', text: res.text, at: Date.now() });
    setTyping({ threadId, index: convoLen });
  };

  // Stop the in-flight turn: invalidate its result (nothing lands in the
  // thread when the request eventually returns), drop the thinking state and
  // leave an "Interrupted" marker in the thread (à la Claude Code).
  const stopTurn = () => {
    turnSeqRef.current += 1;
    endStreaming();
    if (activeId) {
      appendAiMessage(activeId, { who: 'ai', interrupted: true, text: 'Interrupted by user', at: Date.now() });
    }
  };

  // Append the file-creation steer to the last user message of an api payload,
  // then the user's own writing style from the Playbook on top of it. Both land
  // on the same turn and neither needs to know about the other.
  const withSteer = async (apiMessages) => {
    if (!apiMessages.length) return apiMessages;
    const last = apiMessages[apiMessages.length - 1];
    if (last.role !== 'user' || typeof last.content !== 'string') return apiMessages;
    const withFile = [...apiMessages.slice(0, -1), { ...last, content: `${last.content}\n\n${FILE_STEER}` }];
    return withStyleSteer(withFile);
  };

  // ── Send a turn ────────────────────────────────────────────────────────
  const send = async (q) => {
    const text = (q != null ? String(q) : val).trim();
    if (!text || streaming || !activeId) return;
    setVal('');
    // While a question is pending, a typed message answers it (free-text).
    if (pendingAsk) { resolveAsk({ typedText: text }); return; }
    const atts = attachments;
    setAttachments([]);
    // Context for this turn: explicitly attached files + any project files the
    // message names — both read + inlined so the model answers from contents.
    const attachedNames = new Set(atts.map((a) => a.name));
    const mentioned = findMentionedFiles(text, contextFilesRef.current, attachedNames);
    const blocks = [];
    if (atts.length) {
      blocks.push(await buildContextBlock(atts,
        'The user attached the following file(s). Their full text contents are included below — read them and use them directly to answer.'));
    }
    if (mentioned.length) {
      blocks.push(await buildContextBlock(mentioned,
        'The user\'s message refers to the following project file(s) by name. Their text contents are included below — use them to answer.'));
    }
    const contextBlock = blocks.filter(Boolean).join('\n\n');
    const apiText = contextBlock ? `${contextBlock}\n\n---\n\n${text}` : text;
    const shownAtts = [...atts.map((a) => a.name), ...mentioned.map((f) => f.name)];
    const userMsg = {
      who: 'me',
      text,
      at: Date.now(),
      ...(contextBlock ? { apiText } : {}),
      ...(shownAtts.length ? { attachments: shownAtts } : {}),
    };
    const threadId = activeId;
    const current = threads.find((t) => t.id === threadId);
    const convo = [...(current?.messages || []), userMsg];
    const isFirstUser = !(current?.messages || []).some((m) => m.who === 'me');
    pendingScrollRef.current = true;
    setThreads((ts) => ts.map((t) => (t.id === threadId
      ? { ...t, messages: convo, title: isFirstUser ? (text.slice(0, 48) || 'Unnamed chat') : t.title, updatedAt: Date.now() }
      : t)));
    beginStreaming(threadId);
    const seq = ++turnSeqRef.current;
    // Ground the answer in the FULL project: the live digest (files, chat,
    // timeline, snippets, captions, metadata) rides on this turn, plus the
    // file-name grounding the edge function already understands. Doc tools are
    // on: the model can create files (write_document) or pause to clarify
    // (ask_user) — the steer note tells it when to do which.
    const digest = await getProjectDigest();
    const apiMsgs = await withSteer(withProjectContext(toApiMessages(convo), digest));
    const res = await askProjectAi({
      messages: apiMsgs,
      projectName: selectedProject?.name || '',
      fileNames: contextFilesRef.current.map((f) => f.name),
      docTools: true,
      usageAction: 'chat',
    });
    if (turnSeqRef.current !== seq) return; // stopped — discard the result
    if (res.error) {
      endStreaming();
      appendAiMessage(threadId, {
        who: 'ai',
        isError: true,
        text: res.error.message === 'ai_not_configured'
          ? 'The AI assistant is not configured (the AI key is missing). Contact your administrator.'
          : 'Couldn’t get an answer right now. Please try again in a moment.',
        at: Date.now(),
      });
      return;
    }
    // applyAiResult owns dropping `streaming` — a file build keeps the
    // thinking indicator up until the document is actually written.
    await applyAiResult(res, threadId, text, apiMsgs, convo.length, seq);
    if (isFirstUser) generateTitle(threadId, text);
  };

  // Resolve a pending ask_user question: replay the exact turn the model saw
  // plus its tool_use and our tool_result, with the doc tools still available —
  // the answers drive whether it writes the file or just replies.
  const resolveAsk = async (opts = {}) => {
    if (!pendingAsk || streaming) return;
    const pa = pendingAsk;
    setPendingAsk(null);
    const questions = pa.input?.questions || [];
    const answers = opts.dismissed
      ? makeAskAnswers([], {}, { dismissed: true })
      : opts.typedText != null
        ? { answers: questions.map((qq) => ({ question_id: qq.id, response_type: 'free_text', text: opts.typedText })) }
        : makeAskAnswers(questions, opts.perQuestion || {});
    const threadId = pa.threadId;
    const current = threads.find((t) => t.id === threadId);
    const userMsg = { who: 'me', text: opts.dismissed ? 'Skipped.' : (opts.typedText || 'Answered.'), at: Date.now() };
    const convoLen = (current?.messages || []).length + 1;
    pendingScrollRef.current = true;
    setThreads((ts) => ts.map((t) => (t.id === threadId
      ? { ...t, updatedAt: Date.now(), messages: [...t.messages, userMsg] }
      : t)));
    beginStreaming(threadId);
    const seq = ++turnSeqRef.current;
    const apiMsgs = [
      ...pa.base,
      { role: 'assistant', content: pa.assistantContent || [{ type: 'tool_use', id: pa.id, name: 'ask_user', input: pa.input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: pa.id, content: JSON.stringify(answers) }] },
    ];
    const res = await askProjectAi({
      messages: apiMsgs,
      projectName: selectedProject?.name || '',
      fileNames: contextFilesRef.current.map((f) => f.name),
      docTools: true,
      usageAction: 'chat',
    });
    if (turnSeqRef.current !== seq) return; // stopped — discard the result
    if (res.error) {
      endStreaming();
      appendAiMessage(threadId, { who: 'ai', isError: true, text: 'Couldn’t get an answer right now. Please try again in a moment.', at: Date.now() });
      return;
    }
    await applyAiResult(res, threadId, opts.typedText || 'the answers above', apiMsgs, convoLen, seq);
  };

  // ── Per-response actions ────────────────────────────────────────────────
  const copyMessage = async (text, index) => {
    try { await navigator.clipboard.writeText(text || ''); } catch { /* clipboard blocked */ }
    setCopiedIdx(index);
    window.setTimeout(() => setCopiedIdx((cur) => (cur === index ? null : cur)), 1600);
  };
  // Regenerate the AI message at `index`: drop it (and anything after) and
  // re-ask with the conversation up to that point.
  const regenerate = async (index) => {
    if (streaming || pendingAsk) return;
    const threadId = activeId;
    const current = threads.find((t) => t.id === threadId);
    const convo = (current?.messages || []).slice(0, index);
    if (!convo.length) return;
    setThreads((ts) => ts.map((t) => (t.id === threadId ? { ...t, messages: convo } : t)));
    beginStreaming(threadId);
    const seq = ++turnSeqRef.current;
    const digest = await getProjectDigest();
    const apiMsgs = await withSteer(withProjectContext(toApiMessages(convo), digest));
    const res = await askProjectAi({
      messages: apiMsgs,
      projectName: selectedProject?.name || '',
      fileNames: contextFilesRef.current.map((f) => f.name),
      docTools: true,
      usageAction: 'chat',
    });
    if (turnSeqRef.current !== seq) return; // stopped — discard the result
    if (res.error) {
      endStreaming();
      appendAiMessage(threadId, { who: 'ai', isError: true, text: 'Couldn’t get an answer right now. Please try again in a moment.', at: Date.now() });
      return;
    }
    const lastUser = [...convo].reverse().find((m) => m.who === 'me');
    await applyAiResult(res, threadId, lastUser?.text || '', apiMsgs, convo.length, seq);
  };

  // ── Conversation list actions ──────────────────────────────────────────
  const newChat = () => {
    const t = makeThread();
    setThreads((ts) => [t, ...ts]);
    setActiveId(t.id);
    setVal('');
    setAttachments([]);
    requestAnimationFrame(() => taRef.current?.focus());
  };
  const selectThread = (id) => {
    if (id === activeId) return;
    setActiveId(id);
    setVal('');
  };
  const deleteThread = (id) => {
    const next = threads.filter((t) => t.id !== id);
    setThreads(next);
    if (id === activeId) setActiveId(next[0]?.id ?? null);
  };

  // ── Attachments (paperclip picker + drag from the Files tab) ───────────
  const addAttachments = (incoming) => {
    if (!incoming.length) return;
    setAttachments((cur) => {
      const seen = new Set(cur.map((a) => a.path || a.name));
      return [...cur, ...incoming.filter((a) => (a.path || a.name) && !seen.has(a.path || a.name))];
    });
  };
  const removeAttachment = (key) => setAttachments((cur) => cur.filter((a) => (a.path || a.name) !== key));
  const onPickFiles = (e) => {
    const files = Array.from(e.target.files || []);
    addAttachments(files.map((file, i) => ({
      name: file.name,
      path: `picked:${file.name}:${file.size}:${file.lastModified}:${i}`,
      file,
    })));
    e.target.value = '';
  };
  // Files dragged from the Files tab carry a docvex payload.
  const acceptsFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('application/x-docvex-files');
  const readDropPayload = (e) => {
    let data = null;
    try { data = JSON.parse(e.dataTransfer.getData('application/x-docvex-files')); } catch { /* malformed */ }
    let incoming = (data?.items || []).filter((d) => d?.path && d.kind !== 'folder').map((d) => ({ name: d.name, path: d.path }));
    if (!incoming.length) incoming = (getDraggedFiles() || []).filter((f) => f.kind !== 'folder' && f.path).map((f) => ({ name: f.name, path: f.path }));
    return incoming;
  };
  const onComposerDragOver = (e) => {
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropActive) setDropActive(true);
  };
  const onComposerDragLeave = (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropActive(false); };
  const onComposerDrop = (e) => {
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    setDropActive(false);
    addAttachments(readDropPayload(e));
    requestAnimationFrame(() => taRef.current?.focus());
  };
  // Dropping anywhere on the page attaches too (not just the composer).
  const onPageDragOver = (e) => { if (acceptsFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
  const onPageDrop = (e) => {
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    setDropActive(false);
    addAttachments(readDropPayload(e));
  };

  // ── Guards (after hooks) ───────────────────────────────────────────────
  if (loading && !selectedProject) return null;
  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to use the AI tools.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  // ── Composer (portalled into the window footer, like the Chat tab) ─────
  const composer = (
    <div
      className={`vb-composer-wrap${dropActive ? ' aichat-dropping' : ''}`}
      onDragOver={onComposerDragOver}
      onDragLeave={onComposerDragLeave}
      onDrop={onComposerDrop}
    >
      {/* The model's clarifying questions (ask_user) — e.g. before it creates
          a file — float with the composer, just above the input box. */}
      {pendingAsk && !streaming && (
        <div className="aichat-askpanel">
          <AskUserPanel
            questions={pendingAsk.input?.questions || []}
            onSubmit={(perQuestion) => resolveAsk({ perQuestion })}
            onDismiss={() => resolveAsk({ dismissed: true })}
          />
        </div>
      )}
      {attachments.length > 0 && (
        <div className="aichat-attachments">
          {attachments.map((a) => (
            <span className="aichat-attach-chip" key={a.path || a.name}>
              {I.file({ width: 13, height: 13 })}
              <Tooltip content={a.name}><span className="aichat-attach-name">{a.name}</span></Tooltip>
              <button type="button" className="aichat-attach-x" onClick={() => removeAttachment(a.path || a.name)} aria-label={`Remove ${a.name}`}>{I.x({ width: 12, height: 12 })}</button>
            </span>
          ))}
        </div>
      )}
      <div className="dvx-composer">
        <textarea
          ref={taRef}
          className="dvx-composer-textarea"
          rows={1}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={pendingAsk ? 'Type an answer…' : 'Message DocVex AI…'}
          maxLength={4000}
        />
        <div className="dvx-composer-toolbar">
          <Tooltip content="Attach files"><button type="button" className="dvx-composer-btn" aria-label="Attach files" onClick={() => fileInputRef.current?.click()}>{I.paperclip({ width: 16, height: 16 })}</button></Tooltip>
          <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={onPickFiles} />
          <div className="dvx-composer-toolbar-spacer" />
          {streaming ? (
            <Tooltip content="Stop"><button type="button" className="dvx-composer-btn dvx-composer-send" onClick={stopTurn} aria-label="Stop generating">{I.stop({ width: 16, height: 16 })}</button></Tooltip>
          ) : (
            <Tooltip content="Send"><button type="button" className="dvx-composer-btn dvx-composer-send" onClick={() => send()} disabled={!val.trim()} aria-label="Send">{I.arrowUp({ width: 16, height: 16 })}</button></Tooltip>
          )}
        </div>
      </div>
    </div>
  );

  // ── Masthead + tabs bar (mirrors the Chat tab's chatHeader) ────────────
  const convoCount = `${threads.length} ${threads.length === 1 ? 'conversation' : 'conversations'}`;
  const header = (
    <>
      <header className="dvx-mh">
        <div className="dvx-mh-eyebrow">
          <span>Project AI</span>
          <span className="dvx-mh-muted">· Powered by Claude</span>
        </div>
        <h1 className="dvx-mh-title">Advisor</h1>
        <p className="dvx-mh-kicker">
          {`${selectedProject.name} · ${convoCount} · Sees the whole project — files, chat, timeline, extractions & captions`}
        </p>
      </header>
      {/* Static tools/tabs bar — the page itself never scrolls (only the
          bubbles column does), so there's no pinned/mini-header state. */}
      <div className="dvx-toolbar mini-glow" onMouseMove={miniHeaderSpot}>
        {/* Hide / show the conversation rail. Sits at the far left of the bar,
            over the rail it controls, and stays mounted while the rail is
            hidden — it is the only way back. */}
        {tab === 'chat' && hasThreads && (
          <Tooltip content={railHidden ? 'Show conversations' : 'Hide conversations'}>
            <button
              type="button"
              className={`aichat-railtoggle${railHidden ? ' is-off' : ''}`}
              aria-label={railHidden ? 'Show conversations' : 'Hide conversations'}
              aria-expanded={!railHidden}
              onClick={toggleRail}
            >
              {I.panelLeft({ width: 16, height: 16 })}
            </button>
          </Tooltip>
        )}
        <div className="dvx-tabs vb-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'chat'}
            className={`dvx-tab${tab === 'chat' ? ' is-active' : ''}`}
            onClick={() => setTab('chat')}
          >
            {I.spark({ width: 16, height: 16 })}Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'debug'}
            className={`dvx-tab${tab === 'debug' ? ' is-active' : ''}`}
            onClick={() => setTab('debug')}
          >
            {I.bolt({ width: 16, height: 16 })}Debug
          </button>
        </div>
        {/* Chat search — the Chat tab's search box (same .dvx-chrome-search
            shell), in line with the tabs. Filters the conversation rail like
            the Windows Explorer search box. */}
        {tab === 'chat' && hasThreads && (
          <div className="dvx-chrome-tools">
            <div className={`dvx-chrome-search${chatSearch ? ' is-active' : ''}`}>
              {I.search({ width: 15, height: 15, className: 'dvx-chrome-search-glyph' })}
              <input
                ref={searchRef}
                type="text"
                placeholder="Search chats…"
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && chatSearch) { e.stopPropagation(); setChatSearch(''); return; }
                  // Enter → next highlighted match in the open chat,
                  // Shift+Enter → previous (VS Code's find loop).
                  if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) find.goPrev(); else find.goNext(); }
                }}
                aria-label="Search all conversations"
              />
              {chatSearch ? (
                <>
                  {/* In-thread match position when the open chat has hits;
                      otherwise how many chats in the rail still match. */}
                  <span className={`chat-find-count${(find.total === 0 && visibleThreads.length === 0) ? ' is-empty' : ''}`} aria-live="polite">
                    {find.supported && find.total
                      ? `${find.current}/${find.total}`
                      : visibleThreads.length
                        ? `${visibleThreads.length} ${visibleThreads.length === 1 ? 'chat' : 'chats'}`
                        : 'No results'}
                  </span>
                  <Tooltip content="Clear search">
                    <button
                      type="button"
                      className="dvx-chrome-search-clear"
                      aria-label="Clear search"
                      onClick={() => { setChatSearch(''); searchRef.current?.focus(); }}
                    >
                      {I.x({ width: 13, height: 13 })}
                    </button>
                  </Tooltip>
                </>
              ) : (
                <span className="dvx-chrome-search-kbd">
                  <kbd>{/mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'}</kbd>
                  <span className="dvx-chrome-search-plus">+</span>
                  <kbd>F</kbd>
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );

  // ───── Render ──────────────────────────────────────────────────────────
  return (
    <div className="ai-hub ai-chat-page" onDragOver={onPageDragOver} onDrop={onPageDrop}>
      {/* Fixed column (masthead → toolbar → shell); scrolling happens ONLY
          inside the thread (.aichat-main). The .dvx-scroll-area class stays
          for its shared width-cap rules; its overflow is disabled in CSS. */}
      <div className="dvx-scroll-area">
        {header}

        {tab === 'debug' ? (
          // Debug tab — intentionally left empty for now.
          <div className="aichat-debug aichat-fill" />
        ) : !hasThreads ? (
          // No conversations yet → centred empty state; the New-chat button is
          // the only entry point.
          <div className="aichat-empty aichat-fill">
            <div className="aichat-empty-card">
              <span className="aichat-empty-glyph">{I.chat({ width: 30, height: 30 })}</span>
              <div className="aichat-empty-title">No chats yet</div>
              <div className="aichat-empty-sub">You don’t have any conversations in {selectedProject.name}. Start a new chat to talk with DocVex AI about this project and its files.</div>
              <button type="button" className="aichat-empty-btn" onClick={newChat}>
                {I.plus({ width: 16, height: 16 })}
                <span>New chat</span>
              </button>
            </div>
          </div>
        ) : (
          <div className={`aichat-shell aichat-fill${railHidden ? ' rail-hidden' : ''}${railResizing ? ' is-resizing' : ''}`}>
            {/* Conversation rail — every saved AI conversation + New chat.
                Width is user-resizable via the divider next to it. */}
            <aside
              className="aichat-rail"
              aria-hidden={railHidden}
              /* Hidden: pull the rail (and its divider) off the shell's left
                 edge. The width is untouched, so re-showing lands back on
                 exactly the width the user dragged to. */
              style={{
                flexBasis: railWidth,
                marginLeft: railHidden ? `${-(railWidth + RAIL_DIVIDER_W)}px` : 0,
              }}
              inert={railHidden || undefined}
            >
              {/* New chat — OUTSIDE the scroller, so the items scroll under
                  it. Shaped like a chat item row; its resting look borrows the
                  sidebar's selected-tab style (accent tint + ring + text). */}
              <div className="aichat-list-head">
                <button type="button" className="aichat-newchat-item" onClick={newChat}>
                  {I.plus({ width: 15, height: 15 })}
                  <span>New chat</span>
                </button>
              </div>
              <div className="aichat-list-wrap" onMouseEnter={showRailSb} onMouseLeave={hideRailSb}>
              <div className="aichat-list" ref={listRef} onScroll={onListScroll}>
                {visibleThreads.map((t) => (
                  <div
                    key={t.id}
                    className={`aichat-item${t.id === activeId ? ' is-active' : ''}`}
                    onClick={() => selectThread(t.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') selectThread(t.id); }}
                  >
                    <span className="aichat-item-ico">{I.chat({ width: 15, height: 15 })}</span>
                    <Tooltip content={t.title}><span className="aichat-item-title">{highlightMatch(t.title, searchQ)}</span></Tooltip>
                    {/* Thinking / done-thinking indicator: pulsing while this
                        conversation's turn runs, solid accent once its reply
                        landed while another chat was open. */}
                    {(streaming && streamingThread === t.id) ? (
                      <Tooltip content="Thinking…"><span className="aichat-item-dot is-busy" /></Tooltip>
                    ) : t.unreadAt ? (
                      <Tooltip content="New reply"><span className="aichat-item-dot" /></Tooltip>
                    ) : null}
                    <span className="aichat-item-actions">
                      <Tooltip content="Delete"><button type="button" aria-label="Delete chat" onClick={(e) => { e.stopPropagation(); deleteThread(t.id); }}>{I.x({ width: 14, height: 14 })}</button></Tooltip>
                    </span>
                  </div>
                ))}
                {searchQ && visibleThreads.length === 0 && (
                  <div className="aichat-rail-noresults">No chats match “{chatSearch.trim()}”.</div>
                )}
              </div>
              </div>
            </aside>

            {/* The rail's divider — a drag handle that resizes the chat list
                (the hairline paints in its centre). */}
            <div
              ref={resizerRef}
              className={`aichat-resizer${railResizing ? ' is-active' : ''}`}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize chat list"
              onMouseDown={startRailResize}
              onDoubleClick={() => { setRailWidth(RAIL_DEFAULT); try { localStorage.setItem(RAIL_WIDTH_KEY, String(RAIL_DEFAULT)); } catch { /* quota */ } }}
              onMouseEnter={showRailSb}
              onMouseLeave={hideRailSb}
            >
              {/* The chat list's scroll INDICATOR rides ON the divider —
                  display-only (no pointer interaction); the whole band
                  resizes the rail. */}
              <div
                ref={sbThumbRef}
                className={`aichat-resizer-thumb${railSb.enabled && railSb.show ? ' is-visible' : ''}`}
                aria-hidden="true"
              />
            </div>

            {/* Thread column: the scrolling bubbles list with the composer
                docked in-flow at its bottom (inside the column, not in the
                window footer). */}
            <div className="aichat-thread-col" onMouseEnter={showMsgSb} onMouseLeave={hideMsgSb}>
            {/* Active conversation — the ONLY scroll container on the page:
                the bubbles scroll here while masthead/toolbar/rail stay put. */}
            <div className="aichat-main" ref={scrollRef}>
              {messages.length === 0 && !streaming && (
                <div className="aichat-convo-empty">
                  <div className="aichat-convo-empty-title">How can I help?</div>
                  <div className="aichat-convo-empty-sub">Ask about {selectedProject.name}, or mention / attach any file from the Files tab and I’ll read it.</div>
                </div>
              )}
              <div className="chat">
                {messages.map((m, i) => {
                  let prevAt = null;
                  for (let j = i - 1; j >= 0; j--) {
                    if (messages[j].at) { prevAt = messages[j].at; break; }
                  }
                  const showDay = m.at && (!prevAt || !sameLocalDay(prevAt, m.at));
                  return (
                    <React.Fragment key={i}>
                      {showDay && (
                        <div className="aichat-day-divider" role="separator">
                          <span className="aichat-day-divider-label">{formatDayLabel(m.at)}</span>
                        </div>
                      )}
                      {m.interrupted ? (
                        /* Stop marker (à la Claude Code) — a quiet line, not a bubble. */
                        <div className="aichat-interrupted" role="status">
                          <span className="aichat-interrupted-elbow" aria-hidden="true">⎿</span>
                          <span>{m.text || 'Interrupted by user'}</span>
                        </div>
                      ) : (
                      <div className={`bubble ${m.who === 'me' ? 'me' : ''}`}>
                        <div className="bubble-c">
                          <div className="bubble-msg">
                            {m.who === 'me'
                              ? m.text
                              : (typing && typing.threadId === activeId && typing.index === i)
                                ? (
                                  <Typewriter
                                    text={m.text || ''}
                                    onTick={scrollToBottom}
                                    onDone={() => setTyping(null)}
                                  />
                                )
                                : (
                                  <div className="aichat-md">
                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text || ''}</ReactMarkdown>
                                  </div>
                                )}
                          </div>
                          {m.who === 'me' && (m.attachments || []).length > 0 && (
                            <div className="aichat-msg-attachments">
                              {m.attachments.map((n, k) => (
                                <span className="aichat-attach-chip is-static" key={k}>{I.file({ width: 12, height: 12 })}<Tooltip content={n}><span className="aichat-attach-name">{n}</span></Tooltip></span>
                              ))}
                            </div>
                          )}
                          {/* A file the advisor created in the Files tab — a
                              Files-style card under the message: click selects,
                              double-click opens it in the Doc Viewer. */}
                          {m.who !== 'me' && m.createdFile
                            && !(typing && typing.threadId === activeId && typing.index === i) && (() => {
                            const cf = typeof m.createdFile === 'string'
                              ? { name: m.createdFile, relPath: m.createdFile, path: null, mime: '' }
                              : m.createdFile;
                            return (
                              <div className="aichat-created-file">
                                <div
                                  className={`aichat-file-card${selectedFileCard === i ? ' is-selected' : ''}`}
                                  role="button"
                                  tabIndex={0}
                                  onClick={() => setSelectedFileCard((cur) => (cur === i ? null : i))}
                                  onDoubleClick={() => openCreatedFile(cf)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') openCreatedFile(cf); }}
                                  aria-label={`Open ${cf.name}`}
                                >
                                  <div className="aichat-file-card-thumb">
                                    <FileThumbnail
                                      descriptor={cf.path ? describeLocalFile({ localFile: { name: cf.name, path: cf.path, mimeType: cf.mime } }) : null}
                                      glyph={I.file({ width: 26, height: 26 })}
                                    />
                                  </div>
                                  <Tooltip content={cf.relPath || cf.name}>
                                    <div className="aichat-file-card-name">{cf.name}</div>
                                  </Tooltip>
                                </div>
                              </div>
                            );
                          })()}
                          {m.who === 'me' && m.at && (
                            <span className="aichat-time">{formatHM(m.at)}</span>
                          )}
                          {m.who !== 'me' && !m.isError
                            && !(typing && typing.threadId === activeId && typing.index === i) && (
                            <div className="aichat-msg-actions">
                              <Tooltip content="Copy">
                                <button
                                  type="button"
                                  className="aichat-msg-action"
                                  aria-label="Copy message"
                                  onClick={() => copyMessage(m.text || '', i)}
                                >
                                  {copiedIdx === i ? I.check({ width: 14, height: 14 }) : I.copy({ width: 14, height: 14 })}
                                  <span>{copiedIdx === i ? 'Copied' : 'Copy'}</span>
                                </button>
                              </Tooltip>
                              <Tooltip content="Retry">
                                <button
                                  type="button"
                                  className="aichat-msg-action"
                                  aria-label="Regenerate response"
                                  onClick={() => regenerate(i)}
                                  disabled={streaming}
                                >
                                  {I.refresh({ width: 14, height: 14 })}
                                  <span>Retry</span>
                                </button>
                              </Tooltip>
                            </div>
                          )}
                        </div>
                      </div>
                      )}
                    </React.Fragment>
                  );
                })}
                {streaming && streamingThread === activeId && (
                  <div className="bubble">
                    <div className="bubble-c">
                      <div className="bubble-msg"><ThinkingStatus query={messages.length ? messages[messages.length - 1]?.text : ''} /></div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Thread scrollbar — floats beside the masked scroller so the
                edge fades never touch it. */}
            <div className={`aichat-msg-scrollbar${msgSb.enabled && msgSb.show ? ' is-visible' : ''}`} aria-hidden="true">
              <div ref={msgThumbRef} className="aichat-msg-scrollbar-thumb" onMouseDown={onMsgThumbDown} />
            </div>

            {/* Composer — floats over the bottom of the bubbles column (text
                scrolls behind its frost). Hidden on the Debug tab and while
                there are no chats (the empty state's button is the only entry
                point). */}
            {composer}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

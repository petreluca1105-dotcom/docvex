import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { useAuth } from '../../context/AuthContext';
import { glyphForFile } from '../../components/fileGlyph';
import FileThumbnail from '../../components/FileThumbnail';
import { useMorphPill } from '../../components/useMorphPill';
import Tooltip from '../../components/Tooltip';
import { extractFileText } from '../../lib/extractFileText';
import { recognizeCanvas, OCR_MAX_EDGE } from '../../lib/ocr';
import { transcribeAudio } from '../../lib/transcribe';
import { runTimelineCouncil, refineTimelineWithClarifications, draftFlagAsks, DISPUTE_OPTIONS } from '../../lib/timelineCouncil';
import { toLayoutPx } from '../../lib/appZoom';
import { openDocViewerWindow, pathForFile, allowLocalFile, notifyFilesChanged } from '../../lib/platform';
import { loadCaseTimeline, saveCaseTimeline } from '../../lib/caseTimeline';
import { extractIdentities, saveExtractedIdentities } from '../../lib/identityExtract';
import { localFolderApi } from '../../lib/localFolder';
import { readProjectsDir } from '../../lib/projectsDir';
import { loadExtract, saveExtract } from '../../lib/scanExtractCache';
import { loadCaptions, saveCaptions } from '../../lib/captionsHistory';
import { loadOcrHistory, saveOcrHistory } from '../../lib/extractionHistory';
import CouncilSphere, { SPHERE_PACKET_COLORS } from '../../components/CouncilSphere';
import './ProjectScoped.css';
import './ProjectEvents.css';
// The council backdrop reuses the Files tab's fx-grid / fx-tile styling —
// imported here so the classes exist even before the Files page ever loads.
import '../../components/FilesWorkspace.css';

// Case Timeline — onboarding tab (Claude Design "Case Timeline Onboarding",
// option 1b with option 1a's masthead header + horizontal step rail). The
// flow walks the attorney through Upload → Scanning → Timeline → Review:
// upload/scanning/review render option 1a's step bodies; the Timeline step
// renders option 1b's "narrative dossier" (editorial drop-cap lede, date
// gutter + rail, AI flags as margin annotations).
//
// Everything below is STATIC SAMPLE DATA for the demo matter (Aedificia
// Construct SRL v. Veridian Logistics SA) — per the design-handoff
// convention: placeholder content, not omission.

// ── Icons (inline JSX per app convention — stroke: currentColor) ──────────
const IcoCheck = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M20 6 9 17l-5-5" /></svg>
);
const IcoX = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M18 6 6 18M6 6l12 12" /></svg>
);
const IcoUpload = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg>
);
const IcoDoc = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
);
const IcoArrow = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
const IcoAlert = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
);
const IcoPlay = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...props}><polygon points="5 3 19 12 5 21 5 3" /></svg>
);
// Council-chamber glyphs (Claude Design "AI Council" bundle).
const IcoUser = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5c1.4-3.4 4.2-5 7.5-5s6.1 1.6 7.5 5" /></svg>
);
const IcoEllipsis = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M5 12h.01M12 12h.01M19 12h.01" /></svg>
);
const IcoDown = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="m6 9 6 6 6-6" /></svg>
);
const IcoGridView = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
);
const IcoListView = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>
);
const IcoGavel = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="m14 13-7.5 7.5a2.12 2.12 0 0 1-3-3L11 10" /><path d="m16 16 6-6" /><path d="m8 8 6-6" /><path d="m9 7 8 8" /><path d="m21 11-8-8" /></svg>
);
const IcoPen = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
);
const IcoChat = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
);
const IcoAsk = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
);
const IcoInfo = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...props}><circle cx="12" cy="12" r="10" /><path d="M12 16v-5M12 8h.01" /></svg>
);
const IcoSearch = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...props}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
);
// ── Sample data (verbatim from the design bundle) ─────────────────────────
const STEPS = [
  { id: 'upload', n: '1', label: 'Upload files' },
  { id: 'scan', n: '2', label: 'Scanning' },
  { id: 'timeline', n: '3', label: 'Timeline' },
];

// Masthead copy per step. (When the timeline is built, the Timeline step swaps
// in its own story header.)
const STEP_HEADERS = {
  upload: {
    title: 'Upload files',
    kicker: 'Drop in every document, email and recording tied to the matter. DocVex reads, transcribes and cross-checks them, then assembles a chronological story — flagging gaps and contradictions for you to resolve.',
  },
  scan: {
    title: 'Scanning',
    kicker: 'The AI council is reading your sources — three analysts draft independent chronologies in parallel while the chair cross-checks and merges them. Anything they are unsure about is put to you here, as it comes up.',
  },
  timeline: {
    title: 'Timeline',
    kicker: 'Drop in every document, email and recording tied to the matter. DocVex reads, transcribes and cross-checks them, then assembles a chronological story — flagging gaps and contradictions for you to resolve.',
  },
};

// ── Council chamber (Scanning step) — Claude Design "AI Council" ──────────
// The Scanning step renders the council LIVE: files reading in on the left,
// the four members around the ring (Chair presiding, three analysts), the
// task rail on the right, a decision log below, and a real "the council needs
// your input" panel when the analysts' drafts disagree. Every bubble, stat
// and log entry is driven by real pipeline events (lib/timelineCouncil's
// onEvent stream) — no scripted theatre outside the debug simulator.

// Task rail — real pipeline milestones (statuses: queued / working / done).
const COUNCIL_TASKS = [
  { id: 'read', label: 'Read source files' },
  { id: 'extract', label: 'Extract key facts' },
  { id: 'draft', label: 'Analysts draft chronologies' },
  { id: 'vote', label: 'Debate & vote on beats' },
  { id: 'dispute', label: 'Cross-check disagreements' },
  { id: 'merge', label: 'Chair merges the story' },
  { id: 'save', label: 'Save & hand off' },
];

// Council identities + colours (fixed identities like the avatar palette —
// not theme tokens on purpose; each member keys to one colour across
// bubbles, fact lines and log dots, matching SPHERE_MEMBERS in
// components/CouncilSphere, where the on-canvas seats now live).
const COUNCIL_UI = [
  // The Chair wears the brand palette's yellow (sand); the analysts get
  // neon-leaning identities — cyan / pink / lime — picked to be instantly
  // distinguishable from each other, the chair, and the packet colours.
  { id: 'chair', name: 'The Chair', role: 'Presiding', color: '#DCC9A3' },
  { id: 'chronologist', name: 'Chronologist', role: 'Dates & record', color: '#06B6D4' },
  { id: 'narrator', name: 'Narrator', role: 'Causal story', color: '#EC4899' },
  { id: 'auditor', name: 'Auditor', role: 'Contradictions', color: '#84CC16' },
];
const COUNCIL_COLORS = Object.fromEntries(COUNCIL_UI.map((m) => [m.id, m.color]));
const MEMBER_BY_COLOR = Object.fromEntries(COUNCIL_UI.map((m) => [m.color, m.id]));
const COUNCIL_BY_ID = Object.fromEntries(COUNCIL_UI.map((m) => [m.id, m]));
// Member glyph — the presiding chair wears the gavel, analysts the person
// icon. Used everywhere a member marker renders (chamber avatar, decision
// log, proposal badges) so the chair reads the same across surfaces.
const memberIcon = (id) => (id === 'chair' ? IcoGavel : IcoUser);

// Every shape the "We have a question…" modal supports — mirrors the Doc
// Viewer ask_user panel's response types (single select, multi select,
// confirm, free text). The debug "ask variations" button cycles these.
const ASK_VARIATIONS = [
  {
    kind: 'single',
    question: 'The analysts disagree on the record.',
    context: 'Chronologist drafted 12 events (1 flag) · Narrator drafted 8 events (0 flags) · Auditor drafted 13 events (4 flags). How should the Chair weigh the drafts?',
    options: DISPUTE_OPTIONS,
  },
  {
    kind: 'multi',
    question: 'Which sources should the council lean on?',
    context: 'Pick every source the story may treat as authoritative — the rest stay corroborating material only.',
    options: [
      { id: 'contract', label: 'The framework agreement', desc: 'Signed 14 Mar 2023 · €120k scope.' },
      { id: 'emails', label: 'The email thread', desc: 'Tone shift and the 9 Jun escalation.' },
      { id: 'ledger', label: 'The invoice ledger', desc: 'Payment stops and invoice #204.' },
      { id: 'notes', label: 'The site notes', desc: 'Dated delay entries from 12 May.' },
    ],
  },
  {
    kind: 'confirm',
    question: 'Cut the unverified June beat from the story?',
    context: 'The Auditor could not reconcile the 9 Jun email against the ledger. The chair can cut the beat or keep it flagged.',
    options: [
      { id: 'yes', label: 'Yes, cut it', desc: 'The beat leaves the story until verified.' },
      { id: 'no', label: 'No, keep it flagged', desc: 'It stays, marked as unverified.' },
    ],
  },
  {
    kind: 'text',
    question: 'Anything the council should know before the merge?',
    context: 'Free direction — the chair reads your note verbatim while assembling the final cut.',
  },
];

// Legend for the mesh travellers — rendered as a vertical key to the right
// of the council graph.
const PACKET_LEGEND = [
  { icon: 'doc', label: 'Source material', desc: 'the brief or file pages handed out by the chair' },
  { icon: 'pen', label: 'Draft pages', desc: 'an analyst’s work riding back to the chair' },
  { icon: 'fact', label: 'Extracted fact', desc: 'a finding pulled out of a source file' },
  { icon: 'chat', label: 'Discussion', desc: 'direction, chatter and clarifications' },
  { icon: 'flag', label: 'Raised flag', desc: 'a gap or contradiction spotted in the record' },
  { icon: 'ask', label: 'Open question', desc: 'the council needs a call' },
  { icon: 'ok', label: 'Approved', desc: 'a draft or beat accepted' },
  { icon: 'no', label: 'Declined', desc: 'an objection or rejection' },
];

// SVG twins of the canvas packet glyphs (CouncilSphere's drawGlyph) — the key
// chips wear the same icon the packet carries in flight and on landing.
const PACKET_GLYPHS = {
  doc: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6.5" y="4.5" width="11" height="15" rx="1.5" />
      <path d="M9.5 9.5h5M9.5 12h5M9.5 14.5h5" />
    </svg>
  ),
  pen: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M6.5 17.5L16 8" />
      <circle cx="16.8" cy="7.2" r="1.8" fill="currentColor" stroke="none" />
    </svg>
  ),
  fact: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="4.6" />
      <path d="M14 14l4.5 4.5" />
    </svg>
  ),
  chat: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="6.4" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="17.6" cy="12" r="1.8" />
    </svg>
  ),
  flag: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7.5 20V4.5" />
      <path d="M7.5 5l9 3-9 3z" fill="currentColor" stroke="none" />
    </svg>
  ),
  ask: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M8.8 9.3a3.2 3.2 0 1 1 4.6 2.9c-1 .5-1.4 1.1-1.4 2.2" />
      <circle cx="12" cy="17.6" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  ),
  ok: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 12.5l4.2 4L18.5 7.5" />
    </svg>
  ),
  no: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
      <path d="M7 7l10 10M17 7L7 17" />
    </svg>
  ),
};

// Packet identity colours come from the AI Thinking Sphere design bundle
// (SPHERE_PACKET_COLORS in components/CouncilSphere) — shared by the canvas
// flights, the legend dots and the file-rail fact lines so they never drift.

// What each analyst "says" while their draft call is in flight.
const MEMBER_WORKING_LINE = {
  chronologist: 'Scanning the record for anchor dates…',
  narrator: 'Reading for tone and turning points…',
  auditor: 'Cross-checking amounts, dates and gaps…',
};
// Neutral log-dot colours (member entries use the member's own colour).
const LOG_INFO = '#64748B';
const LOG_OK = '#15803D';
const LOG_BAD = '#B91C1C';
const LOG_WARN = '#B45309';
const LOG_STEER = '#8B5E3C';

// Debug-scan fallback when nothing was uploaded — enough items (15) to
// spill past two grid rows and demo the multi-row layout.
const FALLBACK_SCAN_FILES = [
  'Framework agreement.pdf',
  'Annex 2 — delivery schedule.pdf',
  'Notice of default.docx',
  'Technical expert report.pdf',
  'Statement of defence — Veridian.pdf',
  'E-mail correspondence 2024.pdf',
  'Site_inspection_09122023.mp4',
  'Invoice AV-0442.pdf',
  'Acceptance report Lot 1.pdf',
  'Meeting minutes 2023-11-02.docx',
  'Penalty calculation.xlsx',
  'Photo_Lot2_cracks_01.jpg',
  'Photo_Lot2_cracks_02.jpg',
  'Witness statement — M. Radu.docx',
  'Call recording 2024-01-12.m4a',
].map((name) => ({ name, mime: '', url: '' }));

// Minimal extension → MIME guess so glyphForFile can pick the right icon for
// items that don't carry a real MIME (the debug fallback set). DOCX / XLSX /
// PPTX / audio are already extension-matched inside glyphForFile itself.
function guessMimeFromName(name) {
  const lc = (name || '').toLowerCase();
  if (lc.endsWith('.pdf')) return 'application/pdf';
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lc)) return 'image/*';
  if (/\.(mp4|mov|mkv|webm|avi)$/.test(lc)) return 'video/*';
  if (/\.(txt|md|csv)$/.test(lc)) return 'text/plain';
  return '';
}

// ── Real timeline pipeline ─────────────────────────────────────────────────
// Upload → per-file understanding (drives the scan grid):
//   documents  — text extraction (lib/extractFileText)
//   photos     — Claude vision reads the image (lib/ocr → doc-ai `ocr`)
//   videos     — the audio track is extracted in-renderer and captioned by
//                Whisper (lib/transcribe), then sampled into timestamped KEY
//                SECTIONS for the council
//   audio      — Whisper captions with timestamps
// → the AI COUNCIL (lib/timelineCouncil): three analysts draft independent
// chronologies in parallel, a chair merges them into one strict-JSON timeline
// (draft disagreements become Contradiction flags) → normalised + persisted
// per project. Media the AI can't understand (no key configured, no speech,
// unsupported codec) falls back to filename-as-context with a warning.

// Saved-timeline storage (one entry per project) lives in lib/caseTimeline.js
// — shared with the Files tab's virtual "Timeline" folder.

// Total character budget across every file excerpt sent to each council
// analyst (the chair reads the drafts, not the files).
const TOTAL_EXCERPT_CHARS = 60000;

// ── AI media understanding ─────────────────────────────────────────────────

// Photo → downscaled canvas → Claude vision (doc-ai `ocr`). Returns the AI's
// reading of the image (text content and/or description).
async function imageToAiText(file) {
  const url = objectUrlFor(file);
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('the image could not be decoded'));
    el.src = url;
  });
  const scale = Math.min(1, OCR_MAX_EDGE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
  canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return recognizeCanvas(canvas);
}

// Whisper transcript → timestamped KEY SECTIONS: caption lines sampled
// evenly across the runtime so long recordings stay within budget.
function segmentsToKeySections(tr) {
  const segs = tr.segments || [];
  if (segs.length === 0) return (tr.text || '').trim();
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const MAX_LINES = 40;
  const step = Math.max(1, Math.ceil(segs.length / MAX_LINES));
  return segs
    .filter((_, i) => i % step === 0)
    .map((sg) => `[${fmt(sg.start || 0)}] ${String(sg.text || '').trim()}`)
    .filter((line) => line.length > 8)
    .join('\n');
}

// One entry point for every media kind — returns { kind, text, segments }.
// `raw` (images) / `transcript` (audio+video: full timed segments +
// language) carry the untrimmed AI result so it can be shared with the Doc
// Viewer's own caches, not just the council's excerpt.
async function mediaToAiText(file, mime) {
  if (mime.startsWith('image/')) {
    const text = await imageToAiText(file);
    return { kind: 'image', text: text ? `AI reading of this image:\n${text}` : '', raw: text || '', segments: 0 };
  }
  const tr = await transcribeAudio(objectUrlFor(file), mime, file.name);
  const sections = segmentsToKeySections(tr);
  return {
    kind: mime.startsWith('video/') ? 'video' : 'audio',
    text: sections ? `AI captions (timestamped key sections):\n${sections}` : '',
    segments: (tr.segments || []).length,
    transcript: { text: tr.text || '', segments: tr.segments || [], language: tr.language || null },
  };
}

// ── Cross-surface cache bridge ─────────────────────────────────────────────
// What the council gathers is shared with the Doc Viewer's own path-keyed
// caches (lib/captionsHistory, lib/extractionHistory) — so opening a video
// the council already transcribed shows its captions without pressing
// Generate, and an image the council read seeds the Extract-text history.
// The reverse also holds: captions generated in the Doc Viewer are reused
// by the scan (see analyzeFiles).

// Small JPEG thumb of an image pick — the OCR-history entry pairs a
// thumbnail with the text, so the seeded entry needs one to render.
async function tinyImageThumb(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = 96 / Math.max(bmp.width, bmp.height, 1);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return c.toDataURL('image/jpeg', 0.6);
  } catch {
    return null;
  }
}

function seedDocViewerCaches(file, res) {
  const fpath = pathForFile(file);
  if (!fpath || !res?.text || !res.media) return;
  const tr = res.media.transcript;
  if (tr && Array.isArray(tr.segments) && (tr.text || tr.segments.length)) {
    // Audio/video → the Doc Viewer captions cache (skip if the viewer
    // already has a — possibly hand-edited — transcript).
    if (!loadCaptions(fpath)) {
      const text = tr.text || tr.segments.map((s) => String(s.text || '').trim()).filter(Boolean).join(' ');
      saveCaptions(fpath, {
        text,
        segments: tr.segments,
        language: tr.language || null,
        original: { text, segments: tr.segments },
      });
    }
  } else if (res.media.kind === 'image' && res.media.raw) {
    // Image → one Extract-text history entry with a whole-image thumb.
    if (loadOcrHistory(fpath).length === 0) {
      tinyImageThumb(file).then((thumb) => {
        if (!thumb) return;
        saveOcrHistory(fpath, [{ id: `scan-${Date.now()}`, thumb, text: res.media.raw, createdAt: Date.now() }]);
      });
    }
  }
}

// Event tags map to the notification category palette (--cat-*).
const EVENT_CATS = new Set(['project', 'file', 'update', 'member', 'role', 'system']);

// Clamp + validate the model's output into the shape the steps render.
// Returns null when there's nothing usable (caller surfaces an error).
function normalizeTimeline(parsed, fileCount) {
  if (!parsed || !Array.isArray(parsed.events)) return null;
  const events = parsed.events.slice(0, 40).map((e) => ({
    d: String(e?.date || '').slice(0, 12),
    y: String(e?.year || '').slice(0, 8),
    cat: EVENT_CATS.has(e?.cat) ? e.cat : 'file',
    kind: String(e?.kind || 'Document').slice(0, 28),
    title: String(e?.title || '').slice(0, 160),
    body: String(e?.body || '').slice(0, 500),
    // Filenames this event is based on. Legacy shape fallback: split the old
    // "source" string on the · separator and keep tokens that look like
    // filenames.
    files: Array.isArray(e?.files)
      ? e.files.map((n) => String(n).slice(0, 120)).filter(Boolean).slice(0, 4)
      : String(e?.source || '').split('·').map((s) => s.trim()).filter((s) => s.includes('.')).slice(0, 4),
    isVideo: !!e?.isVideo,
    flag: e?.flag && e.flag.text
      ? {
          sev: e.flag.sev === 'danger' ? 'danger' : 'warning',
          label: String(e.flag.label || 'Flag:').slice(0, 40),
          text: String(e.flag.text).slice(0, 300),
        }
      : null,
  })).filter((e) => e.title);
  if (events.length === 0) return null;
  const SEV_TONE = {
    High: { tone: 'danger', bars: 3 },
    Medium: { tone: 'warning', bars: 2 },
    Low: { tone: 'success', bars: 1 },
  };
  const flags = (Array.isArray(parsed.flags) ? parsed.flags : []).slice(0, 12).map((fl) => {
    const sev = ['High', 'Medium', 'Low'].includes(fl?.sev) ? fl.sev : 'Medium';
    return {
      type: String(fl?.type || 'Flag').slice(0, 40),
      sev,
      ...SEV_TONE[sev],
      title: String(fl?.title || '').slice(0, 160),
      detail: String(fl?.detail || '').slice(0, 500),
      sources: String(fl?.sources || '').slice(0, 120),
    };
  }).filter((fl) => fl.title);
  return {
    lede: String(parsed.lede || '').slice(0, 900),
    events,
    flags,
    meta: { fileCount, generatedAt: Date.now() },
  };
}

// ── Step bodies ────────────────────────────────────────────────────────────

// One object URL per picked File, shared by the Upload list and the Scanning
// grid so FileThumbnail resolves the same preview on both surfaces (and the
// resolver's contentKey-based cache actually hits). Revoked on file removal.
const _objectUrls = new WeakMap();
function objectUrlFor(file) {
  let url = _objectUrls.get(file);
  if (!url) {
    url = URL.createObjectURL(file);
    _objectUrls.set(file, url);
  }
  return url;
}

// Human-readable pick size for the list view's trailing column.
const fmtBytes = (n) => (n >= 1024 * 1024
  ? `${(n / (1024 * 1024)).toFixed(1)} MB`
  : `${Math.max(1, Math.round(n / 1024))} KB`);

// ⌘ vs Ctrl in the search box's shortcut hint.
const IS_MAC = /mac/i.test(navigator.platform || '');

// Picked-file entry on the Upload step — a real Files-tab tile (fx-tile:
// thumbnail well + name underneath), or a compact list row when the view
// toggle is on 'list'. Both carry the Files tab's interaction model: click
// selects (is-selected ring, cleared on blur), double click opens the file
// in the Doc Viewer, and the hover pill morphs into the right-click menu
// (Open / Remove). The hover × removes the pick.
function UploadFileTile({ file, onRemove, view = 'grid', selected, onSelect }) {
  const mime = file.type || guessMimeFromName(file.name);
  const path = pathForFile(file);
  const openFile = () => path && openDocViewerWindow({ path, name: file.name, mime });
  const morphPill = useMorphPill({
    hoverContent: file.name,
    menuItems: [
      { key: 'open', label: 'Open', onClick: openFile, disabled: !path },
      { key: 'remove', label: 'Remove', danger: true, onClick: () => onRemove(file) },
    ],
  });
  const interact = {
    role: 'button',
    tabIndex: 0,
    onClick: () => onSelect(selected ? null : file),
    onDoubleClick: openFile,
    onBlur: () => selected && onSelect(null),
    onMouseMove: morphPill.handleMouseMove,
    onMouseLeave: morphPill.handleMouseLeave,
    onContextMenu: morphPill.handleContextMenu,
  };
  const removeBtn = (
    <button
      type="button"
      className="cto-tile-remove"
      aria-label={`Remove ${file.name}`}
      onClick={(e) => { e.stopPropagation(); onRemove(file); }}
    >
      ×
    </button>
  );
  const thumb = (
    <FileThumbnail
      mimeType={mime}
      name={file.name}
      sourceUrl={objectUrlFor(file)}
      glyph={glyphForFile(mime, file.name)}
    />
  );
  if (view === 'list') {
    return (
      <div className={`cto-upload-row${selected ? ' is-selected' : ''}`} {...interact}>
        <span className="cto-upload-row-thumb">{thumb}</span>
        <span className="cto-upload-row-name">{file.name}</span>
        <span className="cto-upload-row-size">{fmtBytes(file.size)}</span>
        {removeBtn}
        {morphPill.node}
      </div>
    );
  }
  return (
    <div className={`fx-tile cto-upload-tile${selected ? ' is-selected' : ''}`} {...interact}>
      <span className="fx-tile-thumb">{thumb}</span>
      <span className="fx-tile-name">{file.name}</span>
      {removeBtn}
      {morphPill.node}
    </div>
  );
}

// Tile-zoom bounds for the upload picks — mirrors the Files tab's slider
// (FX_MIN_TILE / FX_MAX_TILE / FX_LIST_THRESHOLD in FilesWorkspace): below
// the threshold the grid gives way to the list view.
const UP_MIN_TILE = 70;
const UP_MAX_TILE = 320;
const UP_LIST_THRESHOLD = 100;
const UP_DEFAULT_TILE = 134;

// Files state lives in the page (ProjectEvents) so the Scanning step can
// build its progress grid from the same picks.
function UploadStep({ files, addFiles, removeFile, onAnalyze, analyzing }) {
  const [dragOver, setDragOver] = useState(false);
  // Icon-size / view state — same semantics as the Files tab: the slider
  // drives the tile size; dropping below the threshold flips to list view.
  const [tileSize, setTileSize] = useState(UP_DEFAULT_TILE);
  const view = tileSize < UP_LIST_THRESHOLD ? 'list' : 'grid';
  const inputRef = useRef(null);
  // Search + single selection (lifted here so the keyboard shortcuts can
  // act on the selected pick).
  const searchRef = useRef(null);
  const [query, setQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const q = query.trim().toLowerCase();
  const shown = q ? files.filter((f) => f.name.toLowerCase().includes(q)) : files;

  // Keyboard shortcuts (Files-tab language): Ctrl/Cmd+F focuses search from
  // anywhere on the step; with a pick selected, Enter opens it, Delete /
  // Backspace removes it, Escape clears the selection. Keys typed into
  // inputs (search box, etc.) are left alone.
  // Ctrl+scroll over the drop zone zooms the picks — same gesture (and step)
  // as the Files tab's canvas; a native non-passive listener so
  // preventDefault can stop the page/app zoom.
  const zoneRef = useRef(null);
  useEffect(() => {
    const el = zoneRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey || !e.deltaY) return;
      e.preventDefault();
      setTileSize((prev) => {
        const next = prev - Math.sign(e.deltaY) * 14;
        return Math.max(UP_MIN_TILE, Math.min(UP_MAX_TILE, next));
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!selectedFile) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeFile(selectedFile);
        setSelectedFile(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const p = pathForFile(selectedFile);
        if (p) {
          openDocViewerWindow({
            path: p,
            name: selectedFile.name,
            mime: selectedFile.type || guessMimeFromName(selectedFile.name),
          });
        }
      } else if (e.key === 'Escape') {
        setSelectedFile(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedFile, removeFile]);

  return (
    <div>
      <div
        ref={zoneRef}
        className={`cto-dropzone${dragOver ? ' is-dragover' : ''}${files.length > 0 ? ' is-compact' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer?.files);
        }}
      >
        <span className="cto-drop-ico"><IcoUpload width="26" height="26" /></span>
        {/* display:contents while expanded (layout identical to before);
            becomes a stacked text column in the compact row. */}
        <div className="cto-drop-copy">
          <div className="cto-drop-title">Drop case files here</div>
          <div className="cto-drop-sub">
            {files.length > 0
              ? 'Any file type — read securely on your machine.'
              : 'Any file type. DocVex reads documents, runs OCR on scans and transcribes recordings automatically — files it can’t read still anchor the story by name. Nothing leaves your machine unencrypted.'}
          </div>
        </div>
        <button type="button" className="cto-btn-accent" onClick={() => inputRef.current?.click()}>
          Import
        </button>
        {/* No `accept` filter — every file type is pickable (matching the
            drop path). The scan pipeline handles unknown formats honestly:
            unreadable files fall back to filename-as-context. */}
        <input
          ref={inputRef}
          type="file"
          multiple
          className="cto-file-input"
          onChange={(e) => {
            addFiles(e.target.files);
            // Reset so re-picking the same file fires onChange again.
            e.target.value = '';
          }}
        />
        {/* Content-render controls (Files-tab language) — icon-size slider +
            grid ⇄ list toggle, right-aligned under the zone's header row. */}
        {files.length > 0 && (
          <div className="cto-upload-controls">
            <Tooltip content="Icon size">
              <div className="fx-size-slider">
                <span className="fx-size-dot fx-size-dot-sm" aria-hidden="true" />
                <input
                  type="range"
                  className="fx-size-range"
                  min={UP_MIN_TILE}
                  max={UP_MAX_TILE}
                  step={2}
                  value={tileSize}
                  onChange={(e) => setTileSize(Number(e.target.value))}
                  aria-label="Icon size"
                />
                <span className="fx-size-dot fx-size-dot-lg" aria-hidden="true" />
              </div>
            </Tooltip>
            <Tooltip content={view === 'list' ? 'Switch to grid view' : 'Switch to list view'}>
              <button
                type="button"
                className="fx-cat-btn"
                aria-label={view === 'list' ? 'Switch to grid view' : 'Switch to list view'}
                onClick={() => setTileSize(view === 'list' ? UP_DEFAULT_TILE : UP_MIN_TILE)}
              >
                {view === 'list'
                  ? <IcoListView width="14" height="14" />
                  : <IcoGridView width="14" height="14" />}
              </button>
            </Tooltip>
            {/* Search — same fx-search chrome as the Files tab, with the
                Ctrl/⌘+F hint while empty. */}
            <div className={`fx-search${query ? ' is-active' : ''}`}>
              <IcoSearch width="15" height="15" className="fx-search-glyph" />
              <input
                ref={searchRef}
                placeholder="Search picks"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Escape exits search mode entirely — clears the query and
                  // drops focus out of the field.
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setQuery('');
                    e.currentTarget.blur();
                  }
                }}
              />
              {query ? (
                <Tooltip content="Clear search">
                  <button
                    type="button"
                    className="fx-search-clear"
                    aria-label="Clear search"
                    onClick={() => { setQuery(''); searchRef.current?.focus(); }}
                  >
                    <IcoX width="13" height="13" />
                  </button>
                </Tooltip>
              ) : (
                <span className="fx-search-kbd">
                  <kbd>{IS_MAC ? '⌘' : 'Ctrl'}</kbd>
                  <span className="fx-search-kbd-plus">+</span>
                  <kbd>F</kbd>
                </span>
              )}
            </div>
          </div>
        )}
        {/* Files-tab rendering of the picks (fx-grid / fx-tile, or list
            rows), living INSIDE the drop zone under its header + controls.
            The scroll wrapper clamps the zone's height — content scrolls
            beneath the header, fading out at the section's top and bottom
            edges. */}
        {files.length > 0 && (
          <div className="cto-upload-scroll">
            {shown.length === 0 && (
              <p className="cto-upload-nomatch">No picks match “{query.trim()}”.</p>
            )}
            {view === 'grid' ? (
              <div className="fx-grid cto-upload-grid" style={{ '--fx-tile': `${tileSize}px` }}>
                {shown.map((f) => (
                  <UploadFileTile
                    key={`${f.name} ${f.size}`}
                    file={f}
                    onRemove={removeFile}
                    selected={selectedFile === f}
                    onSelect={setSelectedFile}
                  />
                ))}
              </div>
            ) : (
              <div className="cto-upload-list">
                {shown.map((f) => (
                  <UploadFileTile
                    key={`${f.name} ${f.size}`}
                    file={f}
                    onRemove={removeFile}
                    view="list"
                    selected={selectedFile === f}
                    onSelect={setSelectedFile}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Ready-count + the real "Analyze with AI" trigger — under the drop
          zone. */}
      {files.length > 0 && (
        <div className="cto-upload-bar">
          <div className="cto-upload-bar-copy">
            <div className="cto-upload-bar-num">{files.length}</div>
            <div className="cto-upload-bar-text">
              <div className="cto-upload-bar-title">
                {files.length === 1 ? 'file ready' : 'files ready'}
              </div>
              <div className="cto-upload-bar-sub">
                DocVex will read them and reconstruct the case timeline.
              </div>
            </div>
          </div>
          <button type="button" className="cto-btn-tab" onClick={onAnalyze} disabled={analyzing}>
            {analyzing ? 'Analyzing…' : 'Analyze with AI'}
          </button>
        </div>
      )}
    </div>
  );
}

// Scanning step — the AI Thinking Sphere (Claude Design bundle). The packet
// key sits on the left, the canvas renders the council as a growing
// dot-sphere (CouncilSphere). Everything is driven by real pipeline events:
// the council state machine's packet stream is bridged into canvas flights,
// the per-file `progress` births the sphere's file nodes, and the endStage
// flags run the constellation finale + "It is decided!" card. `onAnswer`
// resolves the dispute panel; the story card hands off to the Timeline step.
function CouncilStep({ items, progress, council, paused, user, error, onAnswer, onPacketDone, onReadStory, storyCta, onRedo }) {
  // Answer choreography: the clicked option wears the selected style for a
  // beat, then the modal fades out, and only then does the answer resolve.
  const [picked, setPicked] = useState(null);
  const [askLeaving, setAskLeaving] = useState(false);
  // multi_select / free_text working state (Doc Viewer ask_user shapes).
  const [multiSel, setMultiSel] = useState([]);
  const [textVal, setTextVal] = useState('');
  const answerTimers = useRef([]);
  useEffect(() => () => answerTimers.current.forEach(clearTimeout), []);
  useEffect(() => {
    // A new question resets the choreography state.
    setPicked(null);
    setAskLeaving(false);
    setMultiSel([]);
    setTextVal('');
  }, [council?.ask]);
  const pickOption = (o) => {
    if (picked) return;
    setPicked(o.id);
    answerTimers.current.push(setTimeout(() => {
      setAskLeaving(true);
      answerTimers.current.push(setTimeout(() => onAnswer(o), 320));
    }, 500));
  };

  // Bridge the council's packet stream into the sphere: every new packet id
  // becomes one canvas flight, and the id is retired after the flight so the
  // end-sequence "wait for the last packet" gate keeps working.
  const sphereRef = useRef(null);
  const seenPacketsRef = useRef(new Set());
  useEffect(() => {
    (council?.packets || []).forEach((p) => {
      if (seenPacketsRef.current.has(p.id)) return;
      seenPacketsRef.current.add(p.id);
      sphereRef.current?.spawnPacket(p.from, p.to, p.icon || 'doc');
      answerTimers.current.push(setTimeout(() => onPacketDone(p.id), p.dur || 1600));
    });
  }, [council?.packets, onPacketDone]);

  if (!council || items.length === 0) {
    return (
      <p className="cto-scan-empty">
        Nothing scanned yet — pick files in the Upload step and press
        “Analyze with AI”.
      </p>
    );
  }
  const ending = council.endStage === 'gavel' || council.endStage === 'story';
  const asking = !!council.ask && !ending;
  const hidden = ending || asking;
  // The debate web starts wiring once the analysts begin filing/voting.
  const debate = ['working', 'done'].includes(council.tasks?.vote)
    || ['working', 'done'].includes(council.tasks?.dispute);

  return (
    <div>
      <div className={`cc-card is-sphere${paused ? ' is-paused' : ''}`}>
        <div className={`cc-stage csx-stage${ending ? ' is-ending' : ''}${asking ? ' is-asking' : ''}`}>
          {/* Packet key — what each traveller through the sphere means. It
              sits where the source manifest used to; while the ask panel or
              the end sequence needs the room it fades out in place, then its
              width glides closed so the sphere carries to the left edge. */}
          <div
            className={`cc-legend csx-keycol${ending ? ' is-out' : ''}${asking ? ' is-aside' : ''}`}
            aria-hidden={hidden || undefined}
          >
            <div className="cc-log-kicker">Packet key</div>
            <div className="cc-legend-list">
              {PACKET_LEGEND.map((l) => {
                const c = SPHERE_PACKET_COLORS[l.icon] || '#DCC9A3';
                return (
                  <div key={l.icon} className="cc-legend-row">
                    <span
                      className="csx-legend-ico"
                      style={{ background: c, boxShadow: `0 0 8px ${c}66` }}
                      aria-hidden="true"
                    >
                      {PACKET_GLYPHS[l.icon] || PACKET_GLYPHS.doc}
                    </span>
                    <span className="cc-legend-main">
                      <span className="cc-legend-label">{l.label}</span>
                      <span className="cc-legend-desc">{l.desc}</span>
                    </span>
                  </div>
                );
              })}
            </div>
            {/* Board members — the council roster in a 2-wide grid, each
                wearing their glyph badge (gavel for the chair) in their
                cluster colour; the desc line carries the member's live stat
                once one lands. */}
            <div className="cc-log-kicker csx-members-kicker">Board members</div>
            <div className="csx-members-grid">
              {COUNCIL_UI.map((m) => {
                const st = council.members[m.id] || {};
                const MIcon = memberIcon(m.id);
                return (
                  <div key={m.id} className={`csx-member-cell${st.active ? ' is-active' : ''}`}>
                    <span className="cc-log-ico" style={{ color: m.color }} aria-hidden="true">
                      <MIcon width="14.4" height="14.4" />
                    </span>
                    <span className="cc-legend-main">
                      <span className="cc-legend-label">{m.name}</span>
                      <span className="cc-legend-desc">{st.stats || m.role}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* The AI Thinking Sphere — the council as a living dot-sphere.
              Remounts (fresh random seats) whenever a new run starts. */}
          <CouncilSphere
            key={council.startedAt || 0}
            ref={sphereRef}
            files={items}
            progress={progress}
            members={council.members}
            phase={!hidden && council.phase !== 'Story complete' ? council.phase : ''}
            debate={debate}
            agitated={asking || !!council.askMark}
            prompted={asking}
            merging={council.tasks?.merge === 'working'}
            contracting={ending}
            storyOn={council.endStage === 'story'}
            storyEyebrow={`Council ruling · ${council.ruling}`}
            storyLede={council.lede}
            storyCta={storyCta}
            onReadStory={onReadStory}
            onRedo={onRedo}
            // The sim keeps its ambient wave motion while a question is up
            // (the engine's prompted state already eases it to a slow idle);
            // NEW packets are suppressed at the source instead — see the
            // sendPacket guard.
            paused={paused}
          />

          {/* Real dispute panel — beside the sphere while open; the picked
              option's rule steers the chair's merge. */}
          {council.ask && !ending && (
            <div className={`cc-ask${askLeaving ? ' is-leaving' : ''}`}>
              <div className="cc-ask-head">
                <span>We have a question…</span>
              </div>
              <p className="cc-ask-q">{council.ask.question}</p>
              <p className="cc-ask-ctx">{council.ask.context}</p>
              {/* single_select / confirm — one click answers. */}
              {council.ask.kind !== 'multi' && council.ask.kind !== 'text' && (
                <div className="cc-ask-opts">
                  {(council.ask.options || []).map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      className={`cc-ask-opt${picked === o.id ? ' is-picked' : ''}`}
                      onClick={() => pickOption(o)}
                    >
                      <span className="cc-ask-opt-label">{o.label}</span>
                      <span className="cc-ask-opt-desc">{o.desc}</span>
                    </button>
                  ))}
                </div>
              )}
              {/* multi_select — toggle any, then submit. */}
              {council.ask.kind === 'multi' && (
                <>
                  <div className="cc-ask-opts">
                    {(council.ask.options || []).map((o) => {
                      const on = multiSel.includes(o.id);
                      return (
                        <button
                          key={o.id}
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          className={`cc-ask-opt${on ? ' is-picked' : ''}`}
                          onClick={() => !picked && setMultiSel((prev) => (on ? prev.filter((x) => x !== o.id) : [...prev, o.id]))}
                        >
                          <span className="cc-ask-opt-label">{o.label}</span>
                          <span className="cc-ask-opt-desc">{o.desc}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="cc-ask-submit"
                    disabled={multiSel.length === 0 || !!picked}
                    onClick={() => pickOption({
                      id: 'multi',
                      label: (council.ask.options || []).filter((o) => multiSel.includes(o.id)).map((o) => o.label).join(' · '),
                    })}
                  >
                    Submit
                  </button>
                </>
              )}
              {/* free_text — typed answer + submit. Flag questions add the
                  "Dismiss" (not-an-issue) action on the same row, with
                  Submit pushed to the right edge. */}
              {council.ask.kind === 'text' && (
                <>
                  <textarea
                    className="cc-ask-text"
                    rows={3}
                    placeholder="Type your answer…"
                    value={textVal}
                    disabled={!!picked}
                    onChange={(e) => setTextVal(e.target.value)}
                  />
                  {council.ask.flag ? (
                    <div className="cc-ask-actions">
                      <button
                        type="button"
                        className="cc-ask-dismiss"
                        disabled={!!picked}
                        onClick={() => pickOption({ id: 'flag-dismiss', label: 'Not an issue', dismissed: true })}
                      >
                        Dismiss
                      </button>
                      <button
                        type="button"
                        className="cc-ask-submit"
                        disabled={!textVal.trim() || !!picked}
                        onClick={() => pickOption({ id: 'text', label: textVal.trim().slice(0, 140) })}
                      >
                        Submit
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="cc-ask-submit"
                      disabled={!textVal.trim() || !!picked}
                      onClick={() => pickOption({ id: 'text', label: textVal.trim().slice(0, 140) })}
                    >
                      Submit
                    </button>
                  )}
                </>
              )}
              {/* Flag questions with options ALSO take a custom answer —
                  the suggested picks above are shortcuts, not the only way.
                  Dismiss (left) + Submit (right) share one action row. */}
              {council.ask.flag && council.ask.kind === 'options' && (
                <>
                  <textarea
                    className="cc-ask-text"
                    rows={2}
                    placeholder="Or type your own answer…"
                    value={textVal}
                    disabled={!!picked}
                    onChange={(e) => setTextVal(e.target.value)}
                  />
                  <div className="cc-ask-actions">
                    <button
                      type="button"
                      className="cc-ask-dismiss"
                      disabled={!!picked}
                      onClick={() => pickOption({ id: 'flag-dismiss', label: 'Not an issue', dismissed: true })}
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      className="cc-ask-submit"
                      disabled={!textVal.trim() || !!picked}
                      onClick={() => pickOption({ id: 'text', label: textVal.trim().slice(0, 140) })}
                    >
                      Submit
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Standing proposal — the latest filed draft's actual reading of
            the story (its lede), drawn from its most-cited source; objection
            chips land when the drafts disagree, the chair's ruling when the
            merge completes. */}
        {council.prop && !ending && (() => {
          const by = COUNCIL_BY_ID[council.prop.by] || {};
          const r = council.prop.ruling;
          return (
            <div className="cc-prop">
              <div className="cc-log-kicker">Standing proposal</div>
              <div className="cc-prop-head">
                <span className="cc-prop-by" style={{ color: by.color }}>
                  {(() => { const ByIcon = memberIcon(by.id); return (
                    <span className="cc-log-ico cc-prop-member-ico" aria-hidden="true"><ByIcon /></span>
                  ); })()}
                  {by.name}
                </span>
                <span className="cc-prop-lead">proposes · drawn from</span>
                <span className="cc-prop-source">{council.prop.source}</span>
              </div>
              <div className="cc-prop-text">“{council.prop.text}”</div>
              {council.prop.votes.length > 0 && (
                <div className="cc-prop-votes">
                  {council.prop.votes.map((v) => {
                    const vm = COUNCIL_BY_ID[v.by] || {};
                    const VmIcon = memberIcon(vm.id);
                    return (
                      <span key={v.by} className="cc-prop-vote">
                        <span className="cc-log-ico cc-prop-member-ico" style={{ color: vm.color }} aria-hidden="true"><VmIcon /></span>
                        {vm.name} <span className="cc-prop-verb" data-ok={v.verb === 'agrees' || undefined}>{v.verb}</span>
                        {v.conf != null && <span className="cc-prop-conf">{v.conf}%</span>}
                      </span>
                    );
                  })}
                </div>
              )}
              {r && (
                <div className="cc-prop-ruling" data-ok={r.accepted || undefined}>
                  <strong>
                    {r.accepted ? <IcoCheck width="10" height="10" /> : <IcoX width="10" height="10" />}
                    {r.accepted ? ' Accepted by the Chair' : ' Rejected by the Chair'}
                  </strong> — {r.reason}
                </div>
              )}
            </div>
          );
        })()}

        {/* Under the sphere — decision log (left) + task rail (right),
            sharing the same kicker header, spacing and row rhythm. */}
        <div className="cc-below">
          <div className="cc-log">
            <div className="cc-log-kicker">Decision log</div>
            <div className="cc-log-list">
              {council.decisions.length === 0 && (
                <div className="cc-log-empty">Every ruling, vote and steer lands here.</div>
              )}
              {council.decisions.map((d) => (
                <div key={d.id} className="cc-log-row">
                  {/* Row marker — the signed-in user's avatar on "You
                      decided" rows, the board-member glyph in the member's
                      colour on their entries, and a semantic status icon
                      (✓ / ✕ / ⚠ / ? / i) everywhere else. */}
                  {(() => {
                    if (d.dot === 'user') {
                      return user?.avatarUrl ? (
                        <img className="cc-log-avatar" src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="cc-log-avatar cc-log-avatar-fallback" aria-hidden="true">{user?.initial || '?'}</span>
                      );
                    }
                    const member = COUNCIL_BY_ID[d.dot];
                    const Icon = member ? memberIcon(member.id)
                      : d.dot === LOG_OK ? IcoCheck
                      : d.dot === LOG_BAD ? IcoX
                      : d.dot === LOG_WARN ? IcoAlert
                      : d.dot === LOG_STEER ? IcoAsk
                      : IcoInfo;
                    return (
                      <span className="cc-log-ico" style={{ color: member ? member.color : d.dot }} aria-hidden="true">
                        <Icon width="14.4" height="14.4" />
                      </span>
                    );
                  })()}
                  <div className="cc-log-main">
                    <span><strong>{d.head}</strong> {d.text}</span>
                    {d.chips.length > 0 && (
                      <div className="cc-log-chips">
                        {d.chips.map((ch) => <span key={ch} className="cc-log-chip">{ch}</span>)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="cc-tasks">
            <div className="cc-log-kicker">Tasks</div>
            <div className="cc-tasks-list">
              {COUNCIL_TASKS.map((t) => {
                const state = council.tasks[t.id] || 'queued';
                return (
                  <div key={t.id} className="cc-task" data-state={state}>
                    <span className="cc-task-dot" aria-hidden="true">
                      {state === 'done' ? <IcoCheck width="14.4" height="14.4" /> : null}
                    </span>
                    <span className="cc-task-label">{t.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <p className="cto-scan-error">
          The analysis failed: {error} — go back to the Upload step and try again.
        </p>
      )}
    </div>
  );
}

// localfile:// URL for a stored path — same scheme the Files tab and the
// sidebar's open-file tabs use for previews.
function localFileUrl(path) {
  return path ? `localfile://local/${encodeURIComponent(path)}` : null;
}

// Register every source-file path of a timeline with the localfile://
// containment layer, resolving once main has them all — callers await this
// BEFORE mounting the tiles so the first thumbnail fetch is already inside
// the allowed roots.
function allowTimelinePaths(tl) {
  const refs = Object.values(tl?.fileRefs || {});
  return Promise.all(refs.map((r) => (r?.path ? allowLocalFile(r.path) : null))).catch(() => {});
}

// Source-file tile on a timeline event — a real Files-tab tile (fx-tile:
// thumbnail well with the name underneath) with the Files tab's interaction
// model: single click selects (is-selected ring, cleared on blur), double
// click opens the file in the Doc Viewer when we know its on-disk path
// (Electron). Tiles without a path render inert.
function EventFileChip({ name, fileRef }) {
  const [selected, setSelected] = useState(false);
  const mime = fileRef?.mime || guessMimeFromName(name);
  const openable = !!fileRef?.path;
  const openFile = () => openable && openDocViewerWindow({ path: fileRef.path, name, mime });
  // Files-tab hover pill: cursor-following filename tooltip morphing into
  // the right-click menu (Open) via the shared FLIP recipe.
  const morphPill = useMorphPill({
    hoverContent: name,
    menuItems: [
      { key: 'open', label: 'Open', onClick: openFile, disabled: !openable },
    ],
  });
  return (
    <button
      type="button"
      className={`cto-ev-file fx-tile${selected ? ' is-selected' : ''}`}
      disabled={!openable}
      onClick={() => setSelected((s) => !s)}
      onDoubleClick={openFile}
      onBlur={() => setSelected(false)}
      onMouseMove={morphPill.handleMouseMove}
      onMouseLeave={morphPill.handleMouseLeave}
      onContextMenu={morphPill.handleContextMenu}
    >
      <span className="fx-tile-thumb">
        <FileThumbnail
          mimeType={mime}
          name={name}
          sourceUrl={localFileUrl(fileRef?.path) || undefined}
          glyph={glyphForFile(mime, name)}
        />
      </span>
      <span className="fx-tile-name">{name}</span>
      {morphPill.node}
    </button>
  );
}

// Option 1b's narrative dossier — editorial brief with the timeline as a
// margin rail and the AI flags as review annotations in the right gutter.
// Renders the AI-reconstructed `timeline`; empty state until one is built.
// (The lede renders in the page masthead, not here.)
function TimelineStep({ timeline, draftPending, goReview, onRegenerate, projectDir }) {
  // Open one of the files the run produced. They live in the project's
  // Identities/ folder, so the path is assembled from the project dir rather
  // than from fileRefs (which only maps the SOURCE files the story cites).
  const openMadeFile = (name) => {
    if (!projectDir) return;
    const sep = projectDir.includes('\\') ? '\\' : '/';
    const path = `${projectDir}${sep}Identities${sep}${name}`;
    allowLocalFile(path).finally(() => {
      openDocViewerWindow({ path, name, mime: 'application/json' });
    });
  };
  // Anchors for the regenerate section and the very end of its bottom
  // clearance — the floating jump button scrolls to the END marker so the
  // section lands in view WITH its breathing room below.
  const regenRef = useRef(null);
  const regenEndRef = useRef(null);
  // The floating pill lines up with the step rail's Review tab: measure the
  // tab's centre (viewport px → layout px, per the zoom convention) on mount
  // and resize. Falls back to the CSS 75vw guide until measured.
  const [jumpLeft, setJumpLeft] = useState(null);
  useEffect(() => {
    const measure = () => {
      const el = document.querySelector('.cto-steps .cto-step-cell:last-child .cto-step');
      if (!el) return;
      const r = el.getBoundingClientRect();
      setJumpLeft(toLayoutPx(r.left + r.width / 2));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  // The pill fades away while the regenerate section itself is on screen —
  // a jump cue is noise once its destination is visible.
  const [regenInView, setRegenInView] = useState(false);
  useEffect(() => {
    const el = regenRef.current;
    if (!el) return undefined;
    const obs = new IntersectionObserver(
      ([entry]) => setRegenInView(entry.isIntersecting),
      { threshold: 0.2 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [timeline]);
  if (!timeline) {
    // A story still being assembled is NOT shown here — a half-merged draft
    // reads as a finished chronology that is missing events.
    if (draftPending) {
      return (
        <div className="cto-timeline-pending">
          <p className="cto-scan-empty">
            The council is still folding your answers into the story — the
            timeline appears once the chair has ruled.
          </p>
          <button type="button" className="cto-btn-ink" onClick={goReview}>
            Back to the council
            <IcoArrow width="13" height="13" />
          </button>
        </div>
      );
    }
    return (
      <p className="cto-scan-empty">
        No timeline yet — upload the case files and press “Analyze with AI”
        to reconstruct the story.
      </p>
    );
  }
  // Kind labels are free text from the model ("Correspondence", "Evidence",
  // "Filing"…), so several labels can share one data-cat and would all paint
  // the same. Colour by LABEL instead: each distinct kind gets the next hue
  // from the category palette in order of first appearance — stable within a
  // timeline, and distinct until the palette runs out.
  // Ordered for maximum hue separation between CONSECUTIVE picks (indigo →
  // amber → emerald → pink → cyan → cognac → violet), so the first few tags
  // — the common case — are unmistakably different at a glance.
  const KIND_COLORS = [
    'var(--cat-project)', 'var(--cat-file)', 'var(--cat-auth)', 'var(--cat-role)',
    'var(--cat-member)', 'var(--cat-support)', 'var(--cat-update)', 'var(--cat-system)',
  ];
  const kindColors = new Map();
  timeline.events.forEach((e) => {
    if (!kindColors.has(e.kind)) kindColors.set(e.kind, KIND_COLORS[kindColors.size % KIND_COLORS.length]);
  });
  return (
    <div className="cto-dossier">
      <div className="cto-events">
        {timeline.events.map((e) => (
          <div key={`${e.d} ${e.y} ${e.title}`} className="cto-event">
            <div className="cto-ev-date">
              <div className="cto-ev-d">{e.d}</div>
              <div className="cto-ev-y">{e.y}</div>
            </div>
            <div className="cto-ev-body">
              {/* Rail node wears the same colour as the event's kind pill. */}
              <span className="cto-ev-node" style={{ background: kindColors.get(e.kind) }} aria-hidden="true" />
              <div className="cto-ev-row">
                <div className="cto-ev-main">
                  <div className="cto-ev-tags">
                    <span className="cto-ev-kind" style={{ color: kindColors.get(e.kind) }}>{e.kind}</span>
                    {e.isVideo && (
                      <span className="cto-ev-ai"><IcoPlay width="8" height="8" />AI caption</span>
                    )}
                  </div>
                  <div className="cto-ev-title">{e.title}</div>
                  <p className="cto-ev-text">{e.body}</p>
                </div>
                {e.files?.length > 0 && (
                  <div className="cto-ev-files">
                    {/* What these tiles are — the sources this event was
                        reconstructed from. */}
                    <div className="cto-ev-files-head">Source files</div>
                    {e.files.map((name) => (
                      <EventFileChip key={name} name={name} fileRef={timeline.fileRefs?.[name]} />
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="cto-ev-margin">
              {e.flag && (
                <div className="cto-annot" data-sev={e.flag.sev}>
                  <div className="cto-annot-head"><IcoAlert width="10" height="10" strokeWidth="2.4" />{e.flag.label}</div>
                  <div className="cto-annot-text">{e.flag.text}</div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* What the run PRODUCED, at the foot of the story: the identity records
          the council wrote for every party it found, and the source files it
          copied into the project folder. Both are real files in the Files tab —
          this is the receipt, and the way into them. */}
      {(timeline.meta?.aiFiles?.length > 0 || timeline.meta?.imported?.length > 0) && (
        <section className="cto-made">
          <div className="cto-made-head">
            <h2 className="cto-made-title">Filed with this story</h2>
            <p className="cto-made-sub">
              Everything below is in this project’s Files tab.
            </p>
          </div>

          {timeline.meta?.aiFiles?.length > 0 && (
            <div className="cto-made-group">
              <div className="cto-made-label">
                Created by the council · {timeline.meta.aiFiles.length}
              </div>
              <div className="cto-made-list">
                {timeline.meta.aiFiles.map((f) => (
                  <button
                    type="button"
                    key={f.name}
                    className="cto-made-card"
                    onClick={() => openMadeFile(f.name)}
                  >
                    <span className="cto-made-ico" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="8" r="3.2" />
                        <path d="M5.8 19a6.2 6.2 0 0 1 12.4 0" />
                      </svg>
                    </span>
                    <span className="cto-made-text">
                      <span className="cto-made-name">{f.party || f.name}</span>
                      <span className="cto-made-kind">Identity record</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {timeline.meta?.imported?.length > 0 && (
            <div className="cto-made-group">
              <div className="cto-made-label">
                Sources copied into the project · {timeline.meta.imported.length}
              </div>
              <div className="cto-made-list">
                {timeline.meta.imported.map((name) => (
                  <EventFileChip key={name} name={name} fileRef={timeline.fileRefs?.[name]} />
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Under all the content — the "not the story you wanted?" section.
          The council re-reads the sources and drafts a fresh story. */}
      <div className="cto-regen" ref={regenRef}>
        <div className="cto-regen-copy">
          <div className="cto-regen-title">Not the story you expected?</div>
          <p className="cto-regen-sub">
            The council can take another pass — re-reading every source,
            redrafting the chronologies and merging a fresh story. The current
            timeline is replaced once the new run completes.
          </p>
        </div>
        <button type="button" className="cto-btn-tab" onClick={onRegenerate}>
          Regenerate story
        </button>
      </div>
      {/* End-of-clearance marker — the jump scrolls this into view so the
          section shows with its full breathing room. */}
      <div ref={regenEndRef} aria-hidden="true" />

      {/* Floating jump — pinned in place in the viewport (in line with the
          step rail's Review tab), takes the reader down to the regenerate
          section. Portalled to <body> so the shell's bottom content-fade
          overlay (.sv-single-body::after) can never wash it out, and faded
          away while the section itself is on screen. */}
      {createPortal(
        <button
          type="button"
          className={`cto-regen-jump${regenInView ? ' is-hidden' : ''}`}
          style={jumpLeft != null ? { left: `${jumpLeft}px` } : undefined}
          onClick={() => regenEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })}
        >
          Regenerate
          <IcoDown width="12" height="12" />
        </button>,
        document.body,
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function ProjectEvents() {
  const { selectedProject, loading } = useSelectedProject();
  const { session } = useAuth();
  const [step, setStep] = useState('upload');
  // Signed-in identity for the decision log's "You decided" rows — Google
  // avatar when present, first-letter circle fallback (app convention).
  const logUser = {
    avatarUrl: session?.user?.user_metadata?.avatar_url || null,
    initial: (session?.user?.email || '?').charAt(0).toUpperCase(),
  };

  // Picked case files (File objects) — shared by the Upload list and the
  // Scanning grid. Held in memory only; the real pipeline isn't wired yet.
  const [files, setFiles] = useState([]);
  // This run's file excerpts, kept so the identity pass can reuse them once the
  // story is final (see runPostScanFiling).
  const excerptsRef = useRef([]);
  // One identity pass per story — the two paths to a final story (a clean run
  // and a run the author clarified) both call it, and only the first should
  // spend the tokens.
  const identityPassRef = useRef(null);

  // ── After the scan: file everything the run produced ───────────────────
  // Two things happen once the chair has ruled, in this order:
  //
  //   1. The SOURCE files land in the project folder. They were uploaded into
  //      this page and lived only in memory — the story cited documents the
  //      Files tab had never heard of. Now the matter's files are the matter's
  //      files, wherever you look at them from.
  //   2. The PARTIES are written as identity records. The council has just read
  //      every file, so it knows exactly who is in the story; that knowledge
  //      used to evaporate with the run.
  //
  // Everything here is a side-effect of the story and can only ever fail
  // quietly: a missing project folder, an AI that is not configured, or a run
  // that finds nobody all end the same way. The timeline stands regardless.
  const postScanRef = useRef(null);
  // The project's folder on disk. Resolved once per project — the filing below
  // writes into it, and the timeline's "Filed with this story" cards build
  // their paths from it (so they still work on a story restored from a
  // previous session, which never ran the filing).
  const [projectDir, setProjectDir] = useState('');
  useEffect(() => {
    const projectId = selectedProject?.id;
    if (!projectId) { setProjectDir(''); return undefined; }
    let alive = true;
    (async () => {
      try {
        const baseDir = readProjectsDir(session?.user?.id || '_anonymous') || undefined;
        const res = await localFolderApi.projectDir(projectId, selectedProject?.name, baseDir);
        if (alive) setProjectDir(res?.path || '');
      } catch { if (alive) setProjectDir(''); }
    })();
    return () => { alive = false; };
  }, [selectedProject?.id, selectedProject?.name, session?.user?.id]);

  const runPostScanFiling = useCallback(async (built) => {
    const projectId = selectedProject?.id;
    if (!projectId || !built) return;
    // One pass per story — both routes to a final story call this, and only
    // the first should do the work.
    const stamp = `${projectId}:${built.events?.length || 0}:${(built.lede || '').slice(0, 120)}`;
    if (postScanRef.current === stamp) return;
    postScanRef.current = stamp;

    let dir = projectDir;
    if (!dir) {
      // The resolver above may not have landed yet on a fast run.
      try {
        const baseDir = readProjectsDir(session?.user?.id || '_anonymous') || undefined;
        const res = await localFolderApi.projectDir(projectId, selectedProject?.name, baseDir);
        dir = res?.path || '';
        if (dir) setProjectDir(dir);
      } catch { /* no folder resolver — nothing to file into */ }
    }
    if (!dir) return;

    // ── 1. Source files into the project folder ──
    const imported = [];
    try {
      // Skip anything already living inside the project folder (a file dragged
      // in from the Files tab itself) — copying it back over itself is at best
      // pointless and at worst a truncated write of a file we are reading.
      const incoming = files.filter((f) => {
        const p = pathForFile(f);
        return !(p && p.startsWith(dir));
      });
      if (incoming.length) {
        const { results } = await localFolderApi.writeFiles({
          dir,
          files: incoming.map((f) => ({ filename: f.name, blob: f })),
        });
        (results || []).forEach((r, i) => { if (r?.ok) imported.push(incoming[i].name); });
        if (imported.length) {
          addDecision(
            LOG_INFO,
            'Sources filed',
            `— ${imported.length} ${imported.length === 1 ? 'file' : 'files'} copied into the project folder.`,
          );
        }
      }
    } catch { /* the story does not depend on this */ }

    // ── 2. Parties as identity records ──
    const created = [];
    try {
      const res = await extractIdentities({
        projectName: selectedProject?.name,
        timeline: built,
        excerpts: excerptsRef.current,
        jurisdiction: selectedProject?.jurisdiction,
        usageProject: projectId,
      });
      if (res.identities.length) {
        const saved = await saveExtractedIdentities(dir, res.identities);
        if (saved.added || saved.updated) {
          saved.names.forEach((n) => created.push({ name: `${n}.dvx`, kind: 'identity', party: n }));
          const parts = [
            saved.added ? `${saved.added} new` : '',
            saved.updated ? `${saved.updated} updated` : '',
          ].filter(Boolean).join(', ');
          addDecision(LOG_OK, 'Parties filed', `— ${parts} in the project's Identities folder.`, saved.names.slice(0, 4));
        }
      }
    } catch { /* a story is worth more than its cast list */ }

    // Record what the run produced ON the story, so the timeline can show it
    // at the foot of the page and a reload still knows about it.
    if (imported.length || created.length) {
      const withFiles = {
        ...built,
        meta: { ...built.meta, imported, aiFiles: created },
      };
      setTimeline(withFiles);
      saveCaseTimeline(projectId, withFiles);
      notifyFilesChanged();   // the Files tab relists and shows everything
    }
  }, [files, projectDir, selectedProject?.id, selectedProject?.name, selectedProject?.jurisdiction, session?.user?.id]);

  const addFiles = (list) => {
    const incoming = Array.from(list || []);
    if (incoming.length === 0) return;
    setFiles((prev) => {
      // De-dupe re-picks of the same file (same name + size).
      const seen = new Set(prev.map((f) => `${f.name} ${f.size}`));
      return [...prev, ...incoming.filter((f) => !seen.has(`${f.name} ${f.size}`))];
    });
  };
  const removeFile = (file) => {
    const url = _objectUrls.get(file);
    if (url) {
      URL.revokeObjectURL(url);
      _objectUrls.delete(file);
    }
    setFiles((prev) => prev.filter((x) => x !== file));
  };

  // Scan-grid state — shared by the real pipeline and the debug simulator.
  // `scanning` covers the whole run (extraction AND the AI call: bars pin at
  // 100 while the model works, which the action log reads as the final
  // cross-checking phase). `debugRun` marks simulator runs so the fake
  // interval below never touches a real analysis.
  const [scanItems, setScanItems] = useState([]);
  const [scanProgress, setScanProgress] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [debugRun, setDebugRun] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);

  // ── Council-chamber state (Scanning step) — everything the chamber UI
  // renders: phase pill, task rail, per-member bubbles/stats/glows, the
  // decision log, the dispute panel and the gavel/story end sequence.
  const [council, setCouncil] = useState(null);
  // Pending resolveDispute() — resolved when the user picks an option.
  const askResolverRef = useRef(null);
  // End-sequence + debug-script timers, and the per-analyst packet shuttles.
  // Timers are entry objects ({ fn, remaining, startedAt, id }) rather than
  // bare timeout ids so the debug pause button can freeze them mid-flight
  // and resume with the leftover delay.
  const timersRef = useRef([]);
  const decisionSeq = useRef(0);
  const shuttleRef = useRef({});
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  // Which analysts had a live shuttle when the pause hit, so resume can
  // restart exactly those.
  const pausedShuttlesRef = useRef([]);
  // Simulator fact pills wait here (keyed by file index) until that file's
  // bar starts filling — the pill lands as its file starts loading.
  const pendingFactsRef = useRef({});
  // Remaining debug ask variations — answering one advances to the next.
  const askQueueRef = useRef([]);
  // Whether a question panel is CURRENTLY showing. Kept as a ref updated
  // synchronously, so concurrent question designers can't both decide the
  // panel is free and stomp each other's question.
  const askOpenRef = useRef(false);
  // Which variation the ask-variations button is currently showing.
  const askVarIdxRef = useRef(0);
  const clearTimers = () => {
    timersRef.current.forEach((t) => clearTimeout(t.id));
    timersRef.current = [];
    Object.values(shuttleRef.current).forEach(clearInterval);
    shuttleRef.current = {};
  };
  useEffect(() => clearTimers, []);
  const fireTimer = (entry) => {
    timersRef.current = timersRef.current.filter((t) => t !== entry);
    entry.fn();
  };
  const schedule = (ms, fn) => {
    const entry = { fn, remaining: ms, startedAt: Date.now(), id: null };
    if (!pausedRef.current) entry.id = setTimeout(() => fireTimer(entry), ms);
    timersRef.current.push(entry);
  };
  const resetCouncilPause = () => {
    pausedRef.current = false;
    pausedShuttlesRef.current = [];
    setPaused(false);
  };
  const freshCouncil = () => ({
    // Remount key for the sphere — a fresh run gets fresh random seats.
    startedAt: Date.now(),
    phase: 'Convening',
    tasks: Object.fromEntries(COUNCIL_TASKS.map((t) => [t.id, 'queued'])),
    members: Object.fromEntries(COUNCIL_UI.map((m) => [m.id, { active: false, bubble: '', stats: '' }])),
    decisions: [],
    packets: [],
    // Per-file fact pills (design bundle's `f.facts`) — filename → array of
    // { text, color }, rendered beside that file's tile in the rail.
    facts: {},
    prop: null,
    ask: null,
    // A single pulsing ?-mark at the mesh crossing — the council's open
    // question, shown for a beat before the ask panel takes over.
    askMark: false,
    endStage: '',
    lede: '',
    ruling: 'unanimous',
  });
  const patchCouncil = (patch) => setCouncil((c) => {
    const base = c || freshCouncil();
    return { ...base, ...(typeof patch === 'function' ? patch(base) : patch) };
  });
  const setPhase = (phase) => patchCouncil({ phase });
  const setTask = (id, st) => patchCouncil((c) => ({ tasks: { ...c.tasks, [id]: st } }));
  const say = (id, bubble, stats) => patchCouncil((c) => ({
    members: { ...c.members, [id]: { ...c.members[id], bubble, ...(stats !== undefined ? { stats } : {}) } },
  }));
  const setActive = (id, active) => patchCouncil((c) => ({
    members: { ...c.members, [id]: { ...c.members[id], active } },
  }));
  // Fact pill on a file tile — capped at 3 per file so the stack stays short.
  const addFact = (name, text, color) => patchCouncil((c) => ({
    facts: {
      ...(c.facts || {}),
      [name]: [...((c.facts || {})[name] || []).slice(-2), { text, color }],
    },
  }));
  const addDecision = (dot, head, text, chips) => patchCouncil((c) => ({
    decisions: [
      { id: (decisionSeq.current += 1), dot, head, text, chips: chips || [] },
      ...c.decisions,
    ].slice(0, 40),
  }));
  // Files/thoughts in transit along the mesh (rendered as .cc-packet).
  // Capped so a stuck animation can't grow the array unbounded.
  const packetSeq = useRef(0);
  // Bump a member's reaction counter — 'ping' fires the sender's ring burst,
  // 'pong' pulses the receiver's whole circle (counters key the animated
  // elements, restarting the animation each time).
  const pingMember = (id, field = 'ping') => patchCouncil((c) => ({
    members: { ...c.members, [id]: { ...c.members[id], [field]: (c.members[id]?.[field] || 0) + 1 } },
  }));
  const sendPacket = (from, to, icon = 'doc', dur = 1900) => {
    // No new packets while a question is up — the sphere holds still until
    // the author answers (real-run events that arrive mid-question simply
    // skip their packet theatre; the log still records them).
    if (councilStateRef.current?.ask) return;
    patchCouncil((c) => ({
      packets: [...(c.packets || []).slice(-11), { id: (packetSeq.current += 1), from, to, icon, dur }],
      // The sender reacts as the packet departs…
      members: { ...c.members, [from]: { ...c.members[from], ping: (c.members[from]?.ping || 0) + 1 } },
    }));
    // …and the receiver's whole circle pulses the moment the packet lands.
    schedule(dur, () => pingMember(to, 'pong'));
  };
  const removePacket = (id) => patchCouncil((c) => ({
    packets: (c.packets || []).filter((p) => p.id !== id),
  }));
  // While an analyst's draft call is genuinely in flight, material shuttles
  // between the chair and that analyst — brief pages out, notes back.
  const stopShuttle = (id) => { clearInterval(shuttleRef.current[id]); delete shuttleRef.current[id]; };
  const stopAllShuttles = () => { Object.keys(shuttleRef.current).forEach(stopShuttle); };
  const startShuttle = (id) => {
    stopShuttle(id);
    sendPacket('chair', id, 'doc');
    let back = false;
    shuttleRef.current[id] = setInterval(() => {
      back = !back;
      sendPacket(back ? id : 'chair', back ? 'chair' : id, back ? 'pen' : 'doc');
    }, 2800);
  };

  // ── Debug pause (the second button under the header) — freezes the council
  // process in place: pending step/end-sequence timers keep their leftover
  // delay, shuttles stop (and restart on resume), the fake progress interval
  // and extraction bar-creep hold via pausedRef, and CSS pauses every chamber
  // animation (.cc-card.is-paused). On a real run the in-flight AI calls
  // themselves can't be suspended — their results simply land while the
  // chamber stands still.
  const toggleCouncilPause = () => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (next) {
      timersRef.current.forEach((t) => {
        if (t.id == null) return;
        clearTimeout(t.id);
        t.id = null;
        t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt));
      });
      pausedShuttlesRef.current = Object.keys(shuttleRef.current);
      stopAllShuttles();
    } else {
      timersRef.current.forEach((t) => {
        if (t.id != null) return;
        t.startedAt = Date.now();
        t.id = setTimeout(() => fireTimer(t), t.remaining);
      });
      pausedShuttlesRef.current.forEach((id) => startShuttle(id));
      pausedShuttlesRef.current = [];
    }
  };

  // ── Ask hold (debug sim) — the scripted session BLOCKS while the "We have
  // a question…" panel is open instead of auto-dismissing it: pending script
  // timers freeze (same mechanics as the pause toggle, without the visual
  // paused state or stopping shuttles), and answering/dismissing releases
  // them. Real runs never hold — the pipeline itself awaits the dispute
  // resolver, and flags notices are informational while the AI keeps going.
  const askHoldRef = useRef(false);
  const holdForAsk = () => {
    if (askHoldRef.current || pausedRef.current) return;
    askHoldRef.current = true;
    timersRef.current.forEach((t) => {
      if (t.id == null) return;
      clearTimeout(t.id);
      t.id = null;
      t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt));
    });
  };
  const releaseAskHold = () => {
    if (!askHoldRef.current) return;
    askHoldRef.current = false;
    if (pausedRef.current) return; // manual pause owns the timers now
    timersRef.current.forEach((t) => {
      if (t.id != null) return;
      t.startedAt = Date.now();
      t.id = setTimeout(() => fireTimer(t), t.remaining);
    });
  };

  // ── Early flag answers — what the author resolves in the flags notice
  // ("We hit a problem…") DURING the run, keyed by flag title. The Review
  // round seeds its answer slots from this map (best-effort title match), so
  // a flag answered in the chamber arrives at Review already addressed.
  // Cleared at the start of every run.
  const earlyFlagAnswersRef = useRef({});
  const answerFlagEarly = (flag, ans) => {
    if (!flag?.title) return;
    earlyFlagAnswersRef.current[flag.title] = ans;
    addDecision('user', 'You decided', ans.dismissed
      ? `— dismissed “${flag.title}” as a non-issue.`
      : `— answered “${flag.title}”.`);
  };
  // Hold until the author has cleared every question that is open or queued.
  // The questions are raised mid-scan, so the merge can finish while one is
  // still on screen — ruling before the answer lands would waste the asking.
  // Polled rather than promise-chained because a question can be ADDED while
  // we wait (a slower designer landing), and a fixed list would miss it.
  const waitForOpenAsks = () => new Promise((resolve) => {
    const tick = () => {
      if (!askOpenRef.current && askQueueRef.current.length === 0) { resolve(); return; }
      window.setTimeout(tick, 250);
    };
    tick();
  });

  // The answers gathered during the scan, in the shape the chair's refinement
  // call expects. A flag the author never got to is passed through unanswered
  // rather than dropped — the chair is told it is still open.
  const clarificationsFromEarlyAnswers = (tl) => (tl?.flags || []).map((fl) => {
    const ans = earlyFlagAnswersRef.current[fl.title];
    return {
      flag: { type: fl.type, sev: fl.sev, title: fl.title, detail: fl.detail, sources: fl.sources },
      text: (ans?.text || '').trim(),
      dismissed: !!ans?.dismissed,
    };
  });

  // Turn a raised flag into a STANDARD ask (the same panel + styling as the
  // dispute question): before the AI's designed question arrives it's a
  // free-text ask carrying the flag's title/detail; once draftFlagAsks
  // returns, the panel upgrades to the designed question + tappable options.
  // The `flag` tag routes the answer to answerFlagEarly instead of the
  // dispute resolver.
  const flagAskFrom = (fl, designed) => ({
    // Any designed options → the tappable-options shape (a flag question
    // always also offers the custom-answer field — see the panel markup);
    // no options → plain free text.
    kind: (designed?.options || []).length > 0 ? 'options' : 'text',
    question: designed?.question || fl.title,
    context: `${fl.sev} · ${fl.type} — ${fl.detail || ''}${fl.sources ? ` (${fl.sources})` : ''}`,
    options: (designed?.options || []).map((o, i) => ({ id: `fl${i}`, label: o.label, desc: o.desc })),
    flag: fl,
  });
  // Latest council state, readable from event callbacks whose closures are
  // stale (the pipeline captures handleCouncilEvent once at run start).
  const councilStateRef = useRef(null);
  useEffect(() => { councilStateRef.current = council; }, [council]);

  // Map the council pipeline's event stream onto chamber state.
  const handleCouncilEvent = (e) => {
    switch (e.type) {
      case 'convene':
        setPhase('Deliberating');
        setTask('draft', 'working');
        say('chair', 'Drafts, please — each analyst reads the record through their own lens.');
        addDecision(LOG_INFO, 'Deliberation opened', '— the chair hands the brief to every analyst.');
        // The brief physically rides out to each seat.
        COUNCIL_UI.slice(1).forEach((m, i) => {
          schedule(250 + i * 350, () => sendPacket('chair', m.id, 'doc', 1800));
        });
        break;
      case 'member-start':
        setActive(e.member.id, true);
        say(e.member.id, MEMBER_WORKING_LINE[e.member.id] || 'Drafting…');
        addDecision(e.member.id, `${e.member.name} began drafting`, '— reading the record through their lens.');
        startShuttle(e.member.id);
        break;
      case 'member-done': {
        setActive(e.member.id, false);
        stopShuttle(e.member.id);
        // A filed draft opens the debate — the vote milestone lights up.
        setTask('vote', 'working');
        sendPacket(e.member.id, 'chair', 'pen', 1600);
        say(
          e.member.id,
          `Draft ready — ${e.events} events, ${e.flags} ${e.flags === 1 ? 'flag' : 'flags'}.`,
          `${e.events} events · ${e.flags} flags`,
        );
        {
          // Real citation counts — the analyst's most-cited source rides
          // along in the log entry and anchors their proposal card.
          const top = Object.entries(e.citations || {}).sort((a, b) => b[1] - a[1])[0];
          // The analyst's most-cited source earns a fact pill on its tile,
          // and the finding rides the mesh as a fact packet; drafts that
          // carry flags fire an amber ⚠ packet at the chair too.
          if (top) {
            addFact(top[0], `${e.member.name}: ${top[1]} ${top[1] === 1 ? 'citation' : 'citations'} in draft`, COUNCIL_COLORS[e.member.id]);
            schedule(500, () => sendPacket(e.member.id, 'chair', 'fact', 1800));
          }
          if (e.flags > 0) {
            schedule(1000, () => sendPacket(e.member.id, 'chair', 'flag', 2000));
          }
          // Surface the flags AS THEY OCCUR — each one opens mid-scan as a
          // standard "We have a question…" ask, one at a time, with its
          // AI-suggested answers already displaying.
          //
          // Each flag's question is designed on its OWN call, not as a batch:
          // the first to come back opens immediately instead of every question
          // waiting on the slowest one in the set. The rest queue behind the
          // open panel and follow as they land, so you answer them one by one
          // while the council is still reading.
          if (e.flags > 0 && Array.isArray(e.flagDetails) && e.flagDetails.length > 0) {
            const present = (fl, designed) => {
              const ask = flagAskFrom(fl, designed);
              // askOpenRef, not the council state: two designers can resolve in
              // the same tick, and councilStateRef only catches up after a
              // render — both would think the panel was free and the second
              // would replace the first question unanswered.
              if (askOpenRef.current) { askQueueRef.current.push(ask); return; }
              askOpenRef.current = true;
              patchCouncil({ ask });
            };
            e.flagDetails.forEach((fl) => {
              draftFlagAsks({ projectName: selectedProject?.name, timeline: { flags: [fl] } })
                .then((designed) => present(fl, Array.isArray(designed) ? designed[0] : null))
                // The designer failing costs the suggested answers, not the
                // question — it opens as plain free text.
                .catch(() => present(fl, null));
            });
          }
          addDecision(
            e.member.id,
            `${e.member.name} filed a draft`,
            `— ${e.events} events, ${e.flags} ${e.flags === 1 ? 'flag' : 'flags'}${top ? `; leans on ${top[0]} (${top[1]} ${top[1] === 1 ? 'citation' : 'citations'})` : ''}.`,
          );
          // Proposal card — the analyst's actual reading of the story (the
          // draft's lede), drawn from their most-cited source.
          patchCouncil({
            prop: {
              by: e.member.id,
              text: e.lede || `${e.events} datable events reconstructed from the record.`,
              source: top ? top[0] : 'the case files',
              votes: [],
              ruling: null,
            },
          });
        }
        break;
      }
      case 'member-error':
        setActive(e.member.id, false);
        stopShuttle(e.member.id);
        say(e.member.id, 'Could not complete a draft.', 'no draft');
        // A failed draft rides to the chair as a red ✕ decision packet.
        sendPacket(e.member.id, 'chair', 'no', 2000);
        addDecision(LOG_BAD, `${e.member.name} failed`, `— ${e.message}.`);
        break;
      case 'dispute': {
        setTask('draft', 'done');
        setTask('dispute', 'working');
        setActive('chair', true);
        say('chair', 'The council is split. I need direction from the author.');
        addDecision(LOG_STEER, 'The drafts disagree', `— ${e.drafts.map((d) => `${d.name}: ${d.events} ev, ${d.flags} fl`).join(' · ')}.`);
        // Decision packets: each objecting analyst fires a red ✕ at the
        // chair, then ONE big ?-mark pulses at the mesh crossing until the
        // ask panel opens — plus real objection chips on the proposal.
        // Votes and ✕ packets share one patch so both read the same prop.by.
        const ids = e.drafts.map((d) => d.id);
        patchCouncil((c) => {
          const objectors = c.prop ? ids.filter((id) => id !== c.prop.by) : ids;
          return {
            prop: c.prop && {
              ...c.prop,
              votes: objectors.map((id) => ({ by: id, verb: 'objects' })),
            },
            packets: [
              ...(c.packets || []).slice(-9),
              ...objectors.map((id) => ({ id: (packetSeq.current += 1), from: id, to: 'chair', icon: 'no', dur: 2200 })),
            ],
          };
        });
        askOpenRef.current = true;   // the dispute owns the panel until answered
        schedule(1400, () => patchCouncil({ askMark: true }));
        break;
      }
      case 'steer':
        askOpenRef.current = false;
        patchCouncil({ ask: null });
        setTask('dispute', 'done');
        addDecision('user', 'You decided', `— “${e.option.label}”.`);
        // The chair relays your approved direction as green ✓ packets.
        COUNCIL_UI.slice(1).forEach((m) => sendPacket('chair', m.id, 'ok', 1800));
        break;
      case 'chair-start':
        stopAllShuttles();
        // The merge begins — every analyst's draft rides back to the chair.
        COUNCIL_UI.slice(1).forEach((m) => sendPacket(m.id, 'chair', 'pen', 1600));
        patchCouncil((c) => ({
          tasks: { ...c.tasks, extract: 'done', draft: 'done', vote: 'done', dispute: 'done', merge: 'working' },
        }));
        setPhase('Final assembly');
        setActive('chair', true);
        say('chair', `Merging ${e.drafts} drafts into the final cut…`);
        addDecision(LOG_INFO, 'Merge begun', `— the chair weighs ${e.drafts} ${e.drafts === 1 ? 'draft' : 'drafts'} against each other.`);
        // Clarification chatter while the merge call is in flight.
        schedule(2000, () => COUNCIL_UI.slice(1).forEach((m, i) => {
          schedule(i * 600, () => sendPacket('chair', m.id, 'chat', 1800));
        }));
        break;
      case 'chair-done':
        setActive('chair', false);
        setTask('merge', 'done');
        setTask('save', 'working');
        // The accepted merge rides out to every analyst as a green ✓.
        COUNCIL_UI.slice(1).forEach((m) => sendPacket('chair', m.id, 'ok', 1800));
        addDecision(LOG_OK, 'Merged by the Chair', `— ${e.events} events kept, ${e.flags} ${e.flags === 1 ? 'flag' : 'flags'} raised.`);
        patchCouncil((c) => (c.prop
          ? { prop: { ...c.prop, ruling: { accepted: true, reason: `merged into the final story — ${e.events} events kept.` } } }
          : {}));
        break;
      case 'chair-skip':
        stopAllShuttles();
        patchCouncil((c) => ({
          tasks: { ...c.tasks, extract: 'done', draft: 'done', vote: 'done', dispute: 'done', merge: 'done', save: 'working' },
        }));
        addDecision(LOG_WARN, 'Merge skipped', '— a single draft survived; it stands as the record.');
        break;
      case 'chair-fallback':
        stopAllShuttles();
        setActive('chair', false);
        setTask('merge', 'done');
        setTask('save', 'working');
        addDecision(LOG_WARN, 'Chair unavailable', '— the richest draft stands in for the merge.');
        break;
      default:
        break;
    }
  };

  // Dispute panel resolution — resolves the pipeline's awaited promise on a
  // real run; on debug runs just logs the steer locally.
  const answerCouncil = (option) => {
    const ask = council?.ask;
    askOpenRef.current = false;
    patchCouncil({ ask: null });
    // A held debug script (see holdForAsk) resumes the moment the panel is
    // answered or dismissed.
    releaseAskHold();
    if (option?.silent) return;
    // Flag question (see flagAskFrom) — record the author's early answer
    // (it pre-fills the Review round) and surface the next queued flag
    // question, if any.
    if (ask?.flag) {
      answerFlagEarly(ask.flag, option?.dismissed ? { dismissed: true } : { text: option.label });
      const next = askQueueRef.current.shift();
      if (next) {
        askOpenRef.current = true;   // claimed now, so a designer landing during
        schedule(700, () => {        // the beat below queues instead of stomping
          patchCouncil({ ask: next });
          if (debugRun) holdForAsk();
        });
      }
      return;
    }
    const resolve = askResolverRef.current;
    if (resolve) {
      askResolverRef.current = null;
      resolve(option);
    } else {
      setTask('dispute', 'done');
      addDecision('user', 'You decided', `— “${option.label}”.`);
      // Debug ask-variations mode: the next question in the queue follows.
      const next = askQueueRef.current.shift();
      if (next) {
        askVarIdxRef.current += 1;
        schedule(700, () => {
          setTask('dispute', 'working');
          patchCouncil({ ask: next });
        });
      }
    }
  };

  // ── End-sequence gating ──
  // 'wait' holds the finale until the LAST travelling packet lands (packets
  // remove themselves onAnimationEnd); the gavel then slams, and the story
  // card follows at the slam's half mark.
  useEffect(() => {
    if (council?.endStage !== 'wait' || (council.packets || []).length > 0) return;
    schedule(250, () => patchCouncil((c) => (c.endStage === 'wait' ? { endStage: 'gavel' } : {})));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [council?.endStage, council?.packets?.length]);
  useEffect(() => {
    if (council?.endStage !== 'gavel') return;
    schedule(1050, () => patchCouncil((c) => (c.endStage === 'gavel' ? { endStage: 'story' } : {})));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [council?.endStage]);

  // The reconstructed story — { lede, events, flags, meta } — persisted per
  // project so reopening the tab lands straight on the built timeline.
  const [timeline, setTimeline] = useState(null);
  useEffect(() => {
    const pid = selectedProject?.id;
    if (!pid) return;
    const saved = loadCaseTimeline(pid);
    let alive = true;
    // Surface every source-file path with the localfile:// containment layer
    // BEFORE the timeline mounts. A restored timeline's folders may never
    // have been opened this session — without this, the event tiles'
    // thumbnail requests fall outside the allowed roots and 403 (and the
    // one-shot retry re-resolves the same URL, so they'd stay broken).
    allowTimelinePaths(saved).then(() => {
      if (!alive) return;
      setTimeline(saved);
      // Questions are put during the scan now, so there is no round to resume
      // INTO: a saved story lands on the timeline, and an unfinished draft
      // shows the timeline's empty state with its "run it again" button.
      setStep(!saved ? 'upload' : 'timeline');
      setScanError(null);
    });
    return () => { alive = false; };
  }, [selectedProject?.id]);

  // ── AI-designed Review asks ──────────────────────────────────────────────
  // ── Final pass — the Review round's clarifications → chair refinement ────
  // One chair call folds the author's answers into the story, drops the
  // resolved/dismissed flags, and the finalised timeline replaces the draft
  // (persisted like any other build). The tab flips BACK to the chamber for
  // the duration — packets flying while the chair redrafts — and the run
  // closes with the gavel + "It is decided" panel (its button opens the
  // Timeline). On failure the review face returns with the error shown.
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState(null);
  // `tl` is the story being finalised. Passed EXPLICITLY because the scan
  // calls this in the same tick it set the timeline state — reading `timeline`
  // from the closure there would finalise the previous run's story.
  const finalizeStory = async (clarifications, tl = timeline) => {
    if (!tl || finalizing) return;
    setFinalizing(true);
    setFinalizeError(null);
    // ── Chamber theatre while the refinement call is in flight ──
    clearTimers();
    resetCouncilPause();
    // Sessions that resumed straight into Review never ran a scan this
    // session — seed the file rail from the saved story's refs so the
    // chamber has tiles to show.
    if (scanItems.length === 0) {
      const seeded = Object.keys(tl.fileRefs || {}).map((name) => ({
        name,
        mime: tl.fileRefs[name]?.mime || '',
        url: '',
        path: tl.fileRefs[name]?.path,
      }));
      const items = seeded.length > 0 ? seeded : FALLBACK_SCAN_FILES;
      setScanItems(items);
      setScanProgress(items.map(() => 100));
    }
    setStep('scan');
    const answered = clarifications.filter((c) => !c.dismissed && c.text).length;
    const dismissed = clarifications.length - answered;
    setCouncil((c) => ({
      ...(c || freshCouncil()),
      ask: null,
      askMark: false,
      prop: null,
      endStage: '',
      phase: 'Final deliberation',
      tasks: { ...Object.fromEntries(COUNCIL_TASKS.map((t) => [t.id, 'done'])), save: 'working' },
    }));
    setActive('chair', true);
    say('chair', 'Answers in hand. Folding your clarifications into the final story…');
    addDecision(LOG_STEER, 'You answered the council', `— ${answered} ${answered === 1 ? 'clarification' : 'clarifications'}${dismissed > 0 ? `, ${dismissed} dismissed` : ''} handed to the chair.`);
    // The answers ride out to every analyst, and each seat keeps material
    // shuttling with the chair for however long the redraft takes.
    COUNCIL_UI.slice(1).forEach((m, i) => {
      schedule(350 + i * 450, () => {
        setActive(m.id, true);
        say(m.id, 'Re-checking my beats against your answers…');
        startShuttle(m.id);
      });
    });
    try {
      const parsed = await refineTimelineWithClarifications({
        projectName: selectedProject?.name,
        timeline: tl,
        clarifications,
      });
      const built = normalizeTimeline(parsed, tl.meta?.fileCount ?? 0);
      if (!built) throw new Error('the refined story came back empty');
      // Carry the run's identity forward: council credit, source-file refs,
      // and mark the story as finalised with the author's input.
      built.meta = {
        ...built.meta,
        council: tl.meta?.council,
        fileCount: tl.meta?.fileCount ?? built.meta.fileCount,
        final: true,
        clarified: answered,
      };
      built.fileRefs = tl.fileRefs;
      await allowTimelinePaths(built);
      setTimeline(built);
      saveCaseTimeline(selectedProject.id, built);
      // The story is final — file the sources and the cast list alongside it.
      runPostScanFiling(built);
      // ── End sequence: verdict packets home, gavel, "It is decided". ──
      // clearTimers also kills any still-pending shuttle starts so a late
      // packet can't hold the 'wait' stage open.
      clearTimers();
      COUNCIL_UI.slice(1).forEach((m, i) => {
        setActive(m.id, false);
        schedule(200 + i * 300, () => sendPacket(m.id, 'chair', 'ok', 1600));
      });
      setActive('chair', false);
      setTask('save', 'done');
      setPhase('Story complete');
      say('chair', 'It is decided — the story stands, your answers folded in.');
      addDecision(LOG_OK, 'Final story approved', `— ${built.events.length} events; ${built.flags.length === 0 ? 'every flag resolved' : `${built.flags.length} ${built.flags.length === 1 ? 'flag' : 'flags'} still open`}.`, [
        'refined with your answers',
        ...(dismissed > 0 ? [`${dismissed} dismissed`] : []),
      ]);
      patchCouncil({ ruling: 'unanimous', lede: built.lede });
      schedule(600, () => patchCouncil({ endStage: 'wait' }));
      schedule(5200, () => patchCouncil((c) => (c.endStage === 'wait' ? { endStage: 'gavel' } : {})));
    } catch (err) {
      // Refinement failed — adjourn the theatre and return to the questions
      // with the error shown (the answers are still in hand).
      clearTimers();
      setFinalizeError(String(err?.message || err));
      patchCouncil({ phase: 'Adjourned', endStage: '' });
      addDecision(LOG_BAD, 'Refinement failed', `— ${String(err?.message || err)}`);
    } finally {
      setFinalizing(false);
    }
  };

  // ── Real pipeline: extract text per file (the reading rail), then the AI
  // council (three analysts in parallel + the chair's merge) — every chamber
  // element updates from real pipeline events. Per-file bars ease while THAT
  // file's extraction is in flight (asymptotic toward 90, snap to 100 on
  // finish).
  const analyzeFiles = async () => {
    if (analyzing || files.length === 0) return;
    setAnalyzing(true);
    setDebugRun(false);
    setScanError(null);
    clearTimers();
    resetCouncilPause();
    pendingFactsRef.current = {};
    askQueueRef.current = [];
    askOpenRef.current = false;
    askResolverRef.current = null;
    askHoldRef.current = false;
    earlyFlagAnswersRef.current = {};
    const items = files.map((f) => ({ name: f.name, mime: f.type || '', url: objectUrlFor(f), path: pathForFile(f) }));
    setScanItems(items);
    setScanProgress(items.map(() => 0));
    setScanning(true);
    setStep('scan');
    decisionSeq.current = 0;
    setCouncil({ ...freshCouncil(), phase: 'Reading sources' });
    setTask('read', 'working');
    setTask('extract', 'working');
    setActive('chair', true);    say('chair', `Council convened. ${files.length === 1 ? 'One source' : `${files.length} sources`} on the table — read, then we draft.`);
    addDecision(LOG_INFO, 'Session opened', `— ${files.length} file${files.length === 1 ? '' : 's'} handed to the council.`);
    try {
      // Split the excerpt budget across the files (each also hard-capped by
      // extractFileText's own 16k limit).
      const perFileCap = Math.max(3000, Math.floor(TOTAL_EXCERPT_CHARS / files.length));
      const excerpts = [];
      for (let i = 0; i < files.length; i += 1) {
        // Ease this file's bar toward 90 while its extraction runs — an
        // honest in-flight indicator (extraction exposes no byte progress).
        const creep = setInterval(() => {
          if (pausedRef.current) return;
          setScanProgress((prev) => prev.map((p, j) => (j === i && p < 90 ? p + (90 - p) * 0.16 : p)));
        }, 120);
        const mime = files[i].type || guessMimeFromName(files[i].name);
        const isMedia = /^(image|video|audio)\//.test(mime);
        // Cache first — a file scanned before (same name/size/mtime) recalls
        // what the AI gathered last time instead of re-paying for
        // vision/transcription/extraction.
        const cached = loadExtract(files[i]);
        let res;
        // Captions the user already generated in the Doc Viewer for this
        // exact file are reused instead of re-transcribing.
        const viewerCap = !cached && isMedia && !mime.startsWith('image/')
          ? loadCaptions(pathForFile(files[i]))
          : null;
        if (cached) {
          res = cached;
          say('chair', `${files[i].name} — recalling my notes from the last reading.`);
          clearInterval(creep);
        } else if (viewerCap && (viewerCap.text || viewerCap.segments.length > 0)) {
          const sections = segmentsToKeySections({ text: viewerCap.text, segments: viewerCap.segments });
          res = {
            text: sections ? `AI captions (timestamped key sections):\n${sections}` : '',
            media: {
              kind: mime.startsWith('video/') ? 'video' : 'audio',
              segments: viewerCap.segments.length,
              transcript: { text: viewerCap.text, segments: viewerCap.segments, language: viewerCap.language },
            },
          };
          if (!res.text) res = { error: 'no speech found' };
          say('chair', `${files[i].name} — using the captions already generated in the viewer.`);
          clearInterval(creep);
          saveExtract(files[i], res);
        } else {
        try {
          // Sequential on purpose — keeps memory bounded and the rail readable.
          if (isMedia) {
            // Photos → AI vision; videos → key-section captions from the
            // extracted audio track; audio → Whisper captions.
            say('chair', mime.startsWith('image/')
              ? `Studying ${files[i].name} with AI vision…`
              : mime.startsWith('video/')
                ? `Watching ${files[i].name} — extracting key sections…`
                : `Listening to ${files[i].name}…`);
            // eslint-disable-next-line no-await-in-loop
            const m = await mediaToAiText(files[i], mime);
            res = m.text
              ? { text: m.text, media: m }
              : { error: m.kind === 'image' ? 'the AI found no readable content in the image' : 'no speech found' };
          } else {
            // eslint-disable-next-line no-await-in-loop
            res = await extractFileText(files[i], files[i].name);
          }
        } catch (mediaErr) {
          res = { error: String(mediaErr?.message ?? mediaErr) };
        } finally {
          clearInterval(creep);
        }
        // Remember what the AI gathered so the next scan of this exact file
        // starts from here (successful reads only).
        saveExtract(files[i], res);
        }
        // Share the gathering with the Doc Viewer's own caches — captions
        // for audio/video, an Extract-text entry for images — so opening
        // the file there needs no Generate press.
        if (res.text) seedDocViewerCaches(files[i], res);
        excerpts.push(res.text
          ? { name: files[i].name, text: res.text.slice(0, perFileCap) }
          : { name: files[i].name, error: res.error || 'unreadable' });
        setScanProgress((prev) => prev.map((p, j) => (j === i ? 100 : p)));
        // Each finished file makes a visible hand-off — the chair passes it
        // around the table, one analyst at a time — and lands in the log
        // with what the AI made of it.
        const analyst = COUNCIL_UI[1 + (i % (COUNCIL_UI.length - 1))].id;
        sendPacket('chair', analyst, 'doc', 1800);
        if (cached) {
          addDecision(LOG_INFO, files[i].name, `— recalled from the previous scan (cached${res.media ? `, ${res.media.kind === 'image' ? 'AI vision' : 'AI captions'}` : ''}).`);
          addFact(files[i].name, 'Recalled from the last scan', SPHERE_PACKET_COLORS.fact);
        } else if (res.text && res.media) {
          const m = res.media;
          addDecision(LOG_INFO, files[i].name, m.kind === 'image'
            ? `— image understood with AI vision (${(res.text.length / 1000).toFixed(1)}k characters).`
            : `— AI captions generated (${m.segments} timed ${m.segments === 1 ? 'segment' : 'segments'})${m.kind === 'video' ? '; key sections extracted' : ''}.`);
          addFact(files[i].name, m.kind === 'image'
            ? 'Understood with AI vision'
            : m.kind === 'video' ? 'Key sections captioned by AI' : 'Captions generated by AI', SPHERE_PACKET_COLORS.fact);
          // The finding rides back to the chair as a fact packet.
          schedule(900, () => sendPacket(analyst, 'chair', 'fact', 1800));
        } else if (res.text) {
          addDecision(LOG_INFO, files[i].name, `— read; ${(res.text.length / 1000).toFixed(1)}k characters extracted.`);
        } else {
          // Unreadable files still surface honestly — log + fact pill.
          addDecision(LOG_WARN, files[i].name, `— ${res.error || 'not readable in-app'}; filename used as context.`);
          addFact(files[i].name, 'Not readable — filename used as context', LOG_WARN);
        }
      }
      // Kept for the identity pass, which runs once the story is FINAL — that
      // can be several rounds later (the author's clarifications), by which
      // point this run's local `excerpts` is long out of scope.
      excerptsRef.current = excerpts;
      const readable = excerpts.filter((e) => e.text).length;
      setTask('read', 'done');
      setTask('extract', 'done');
      setActive('chair', false);
      addDecision(LOG_INFO, 'Intake complete', `— ${readable} of ${files.length} ${files.length === 1 ? 'file' : 'files'} readable as text.`);
      if (readable === 0) {
        throw new Error('none of the files could be understood — documents were unreadable and the AI couldn’t read the media (vision/transcription unavailable or no content found)');
      }

      const result = await runTimelineCouncil({
        projectName: selectedProject?.name,
        fileNames: files.map((f) => f.name),
        excerpts,
        onEvent: handleCouncilEvent,
        // Real dispute round — the chamber's ask panel resolves this promise;
        // the picked option's rule goes verbatim into the chair prompt.
        resolveDispute: (dispute) => new Promise((resolve) => {
          askResolverRef.current = resolve;
          // Let the objection ✕ packets and the pulsing ?-mark play on the
          // mesh before the ask panel fades the chamber out.
          schedule(2600, () => patchCouncil({
            askMark: false,
            ask: {
              question: 'The analysts disagree on the record.',
              context: `${dispute.drafts.map((d) => `${d.name} drafted ${d.events} events (${d.flags} ${d.flags === 1 ? 'flag' : 'flags'})`).join(' · ')}. How should the Chair weigh the drafts?`,
              options: dispute.options,
            },
          }));
        }),
      });
      const built = normalizeTimeline(result.parsed, files.length);
      if (!built) throw new Error('no datable events could be reconstructed from these files');
      // Council metadata rides along with the story (masthead credit line +
      // future surfaces).
      built.meta.council = result.council;
      // Filename → on-disk ref, so the timeline's file chips can open the
      // Doc Viewer (and paint real thumbnails) — persisted with the story.
      built.fileRefs = {};
      files.forEach((f) => {
        built.fileRefs[f.name] = { path: pathForFile(f), mime: f.type || '' };
      });
      // Containment first, tiles second — see allowTimelinePaths.
      await allowTimelinePaths(built);
      // The timeline is only CREATED once the author answers the review
      // questions (finalizeStory builds the story from those answers).
      // With open flags, this run yields an in-memory DRAFT the Review round
      // works from — nothing is saved yet. A clean, flag-free run has no
      // questions to ask, so it stands as the story immediately.
      const clean = built.flags.length === 0;
      if (clean) built.meta.final = true;
      setTimeline(built);
      if (clean) saveCaseTimeline(selectedProject.id, built);
      // A clean run IS the final story; a flagged one files from the refine
      // path above, once the chair has folded in the answers.
      if (clean) runPostScanFiling(built);
      setScanning(false);
      const councilChips = [
        result.council.merged ? 'merged by the chair' : 'best draft stands',
        `${result.council.size} of ${COUNCIL_UI.length - 1} analysts filed`,
        ...(result.council.steer ? ['steered by you'] : []),
      ];
      if (clean) {
        // Clean record — straight to the end sequence: gavel, then the
        // ruling card whose button opens the Timeline.
        setTask('save', 'done');
        addDecision(LOG_INFO, 'Story saved', '— the reconstructed timeline is stored with this project.');
        setPhase('Story complete');
        say('chair', 'We have our story — every beat sourced and merged.');
        addDecision(LOG_OK, 'Final story approved', `— ${built.events.length} events, no open flags.`, councilChips);
        patchCouncil({
          ruling: result.council.merged && !result.council.degraded ? 'unanimous' : 'majority',
          lede: built.lede,
        });
        // Hold the finale until every travelling packet lands (the 'wait'
        // stage — see the end-sequence gating effects), with a fallback in
        // case a packet animation never finishes.
        schedule(400, () => patchCouncil({ endStage: 'wait' }));
        schedule(5000, () => patchCouncil((c) => (c.endStage === 'wait' ? { endStage: 'gavel' } : {})));
      } else {
        // Open flags. There is no separate review round any more — every
        // question was put to the author DURING the scan, one at a time, as
        // its analyst raised it. So the chair folds those answers straight in
        // and rules; the run never leaves the chamber.
        //
        // A question still on screen (or queued behind one) is waited for
        // first: the whole point of asking mid-scan is that the answer lands
        // before the merge is final.
        setTask('save', 'working');
        setActive('chair', true);
        const pending = askOpenRef.current || askQueueRef.current.length > 0;
        // Be honest about which of the two we are doing: still waiting on the
        // author, or already folding in what they said.
        setPhase(pending ? 'Waiting on you' : 'Folding in your answers');
        say('chair', pending
          ? 'One more answer from you and I can rule.'
          : `${built.flags.length} ${built.flags.length === 1 ? 'question' : 'questions'} answered — folding them into the record.`);
        addDecision(LOG_STEER, 'Answers in hand', `— ${built.flags.length} ${built.flags.length === 1 ? 'flag' : 'flags'} raised while we read; the chair rules on what you told us.`, councilChips);
        await waitForOpenAsks();
        setPhase('Folding in your answers');
        finalizeStory(clarificationsFromEarlyAnswers(built), built);
      }
    } catch (err) {
      // Clears shuttles AND any scheduled dispute/ask timers, so a delayed
      // ask panel can't reopen over an adjourned session.
      clearTimers();
      setScanning(false);
      setScanError(String(err?.message ?? err));
      patchCouncil({ phase: 'Adjourned', ask: null, askMark: false });
      addDecision(LOG_BAD, 'Session adjourned', `— ${String(err?.message ?? err)}`);
    } finally {
      setAnalyzing(false);
    }
  };

  // ── Debug simulator (the button under the header): fake bar progress on an
  // interval (files fill in waves) plus a scripted council session — same
  // event vocabulary as a real run, so the chamber can be demoed without
  // burning AI calls. Clearly fake data; never touches the saved timeline.
  const startDebugScan = () => {
    if (analyzing) return;
    clearTimers();
    resetCouncilPause();
    pendingFactsRef.current = {};
    askQueueRef.current = [];
    askOpenRef.current = false;
    askResolverRef.current = null;
    askHoldRef.current = false;
    earlyFlagAnswersRef.current = {};
    const items = files.length > 0
      ? files.map((f) => ({ name: f.name, mime: f.type || '', url: objectUrlFor(f), path: pathForFile(f) }))
      : FALLBACK_SCAN_FILES;
    setScanItems(items);
    setScanProgress(items.map(() => 0));
    setScanning(true);
    setDebugRun(true);
    setScanError(null);
    setStep('scan');
    decisionSeq.current = 0;
    setCouncil({ ...freshCouncil(), phase: 'Reading sources' });
    // The maximal path, in one scripted session: an intake showing every
    // per-file shape (plain reads, a cached recall, AI vision, audio
    // captions, video key sections, an unreadable file), three draft
    // filings with the flags notice, two proposal rounds (one accepted, one
    // rejected), objection ✕ / ? / ✓ packets, the dispute ask panel, a
    // contradiction re-check, the merge and the full end sequence.
    const fname = (i) => items[i % items.length].name;
    const vote = (by, verb, conf, packet) => {
      sendPacket(by, packet, verb === 'agrees' ? 'ok' : 'no', 1800);
      patchCouncil((c) => ({
        prop: c.prop && { ...c.prop, votes: [...c.prop.votes, { by, verb, conf }] },
      }));
      addDecision(by, `${COUNCIL_BY_ID[by].name} ${verb}`, `— confidence ${conf}%.`);
    };
    // Shared end-of-session beat: hold the finale until the packets land,
    // then the gavel (with the stuck-packet fallback).
    const gavelEnd = [700, () => {
      patchCouncil({ endStage: 'wait' });
      schedule(4300, () => patchCouncil((c) => (c.endStage === 'wait' ? { endStage: 'gavel' } : {})));
    }];
    const intake = [
      [400, () => {
        setTask('read', 'working');
        setTask('extract', 'working');
        setActive('chair', true);
        say('chair', `Council convened. ${items.length} sources on the table — read, then we draft.`);
        addDecision(LOG_INFO, 'Session opened', `— ${items.length} files handed to the council.`);
        // Read hand-offs — the chair passes finished files around the table
        // while the rail's bars fill — with per-file log entries recording
        // how much text each yielded.
        COUNCIL_UI.slice(1).forEach((m, i) => {
          schedule(1100 + i * 1400, () => sendPacket('chair', m.id, 'doc', 1800));
        });
        ['4.2', '1.8', '3.5'].forEach((kb, i) => {
          schedule(1500 + i * 1300, () => addDecision(LOG_INFO, fname(i), `— read; ${kb}k characters extracted.`));
        });
        // Fact pills for every file — queued per index and released the
        // moment THAT file's bar starts filling (see the release effect
        // below), so each finding lands as its file starts loading. Files
        // 0–3 carry the design bundle's verbatim facts, 4 the warning
        // path, the rest a rotating pool.
        const queueFact = (idx, text, color) => {
          const key = idx % items.length;
          (pendingFactsRef.current[key] = pendingFactsRef.current[key] || []).push({ text, color });
        };
        [
          [0, 'chronologist', 'Signed 14 Mar 2023 · €120k scope'],
          [0, 'auditor', 'Clause 9 sets late-payment penalties'],
          [1, 'narrator', 'Tone shifts sharply after 2 Jun'],
          [1, 'narrator', '9 Jun: escalation email sent'],
          [2, 'chronologist', 'Payments stop after 30 May'],
          [2, 'auditor', 'Invoice #204 unanswered'],
          [3, 'chronologist', 'Delays logged from 12 May'],
          [3, 'narrator', 'Client asked for a scope change'],
        ].forEach(([idx, member, text]) => queueFact(idx, text, COUNCIL_COLORS[member]));
        queueFact(4, 'Not readable — filename used as context', LOG_WARN);
        schedule(4400, () => {
          addDecision(LOG_WARN, fname(4), '— not readable in-app; filename used as context.');
        });
        const EXTRA_FACTS = [
          ['chronologist', 'Dated entries anchor the sequence'],
          ['narrator', 'Adds context to the June escalation'],
          ['auditor', 'Amounts reconcile with the ledger'],
          ['chronologist', 'Confirms the delivery window'],
          ['narrator', 'Names the counterparty’s signatory'],
          ['auditor', 'Flags a missing annex reference'],
        ];
        for (let i = 5; i < items.length; i += 1) {
          const [member, text] = EXTRA_FACTS[i % EXTRA_FACTS.length];
          queueFact(i, text, COUNCIL_COLORS[member]);
        }
        // Media + cache intake outcomes — one of each real-run shape, so the
        // log shows every decision/fact the intake loop can produce: a cached
        // recall, an AI-vision image, audio captions, and a video's
        // key-section captions (each finding riding back as a fact packet).
        schedule(3000, () => say('chair', `Studying ${fname(5)} with AI vision…`));
        schedule(3300, () => {
          addDecision(LOG_INFO, fname(1), '— recalled from the previous scan (cached, AI captions).');
          addFact(fname(1), 'Recalled from the last scan', SPHERE_PACKET_COLORS.fact);
        });
        schedule(3900, () => {
          addDecision(LOG_INFO, fname(5), '— image understood with AI vision (2.4k characters).');
          addFact(fname(5), 'Understood with AI vision', SPHERE_PACKET_COLORS.fact);
          sendPacket('narrator', 'chair', 'fact', 1800);
        });
        schedule(4700, () => say('chair', `Listening to ${fname(6)}…`));
        schedule(5400, () => {
          addDecision(LOG_INFO, fname(6), '— AI captions generated (14 timed segments).');
          addFact(fname(6), 'Captions generated by AI', SPHERE_PACKET_COLORS.fact);
          sendPacket('chronologist', 'chair', 'fact', 1800);
        });
        schedule(5900, () => say('chair', `Watching ${fname(7)} — extracting key sections…`));
        schedule(6600, () => {
          addDecision(LOG_INFO, fname(7), '— AI captions generated (9 timed segments); key sections extracted.');
          addFact(fname(7), 'Key sections captioned by AI', SPHERE_PACKET_COLORS.fact);
          sendPacket('auditor', 'chair', 'fact', 1800);
        });
      }],
      [7600, () => {
        setTask('read', 'done');
        setTask('extract', 'done');
        setActive('chair', false);
        addDecision(LOG_INFO, 'Intake complete', `— ${Math.max(items.length - 1, 1)} of ${items.length} files readable as text.`);
        addDecision(LOG_INFO, 'Deliberation opened', '— the chair hands the brief to every analyst.');
        setPhase('Deliberating');
        setTask('draft', 'working');
        COUNCIL_UI.slice(1).forEach((m, i) => {
          setActive(m.id, true);
          say(m.id, MEMBER_WORKING_LINE[m.id]);
          startShuttle(m.id);
          schedule(300 + i * 250, () => addDecision(m.id, `${m.name} began drafting`, '— reading the record through their lens.'));
        });
      }],
    ];

    // ── 'full' — the maximal dispute path (the original script).
    const fullTail = [
      // ── Round 1: Chronologist's opening proposal — ACCEPTED unanimously.
      [2600, () => {
        setActive('chronologist', false);
        stopShuttle('chronologist');
        sendPacket('chronologist', 'chair', 'pen', 1600);
        say('chronologist', 'Draft ready — 12 events, 1 flag.', '12 events · 1 flag');
        schedule(600, () => sendPacket('chronologist', 'chair', 'flag', 2000));
        // The flag question — same as a real member-done with flagDetails:
        // the flag opens as a standard "We have a question…" ask as it
        // occurs, and the script HOLDS until it's answered or dismissed.
        // The flag title matches the seeded Review flag so an answer given
        // here arrives at the Review round already filled in.
        schedule(1400, () => {
          // Opens fully formed — designed question + suggested answers
          // already in place, exactly like a real run (which waits for
          // draftFlagAsks before opening the panel).
          patchCouncil({
            ask: flagAskFrom({
              sev: 'High',
              type: 'Contradiction',
              title: 'Transfer date conflict: 14 Oct (WhatsApp) vs 15 Oct (bank screenshot)',
              detail: 'The WhatsApp thread reads as if the transfer happened on 14 Oct, but the bank screenshot shows a value date of 15 Oct.',
              sources: `${fname(1)} · ${fname(2)}`,
            }, {
              kind: 'options',
              question: 'Which transfer date should the story carry?',
              options: [
                { label: '14 Oct — WhatsApp', desc: 'The money left when the chat says it did' },
                { label: '15 Oct — bank record', desc: 'The value date on the statement governs' },
                { label: 'Both are right', desc: 'Sent on the 14th, settled on the 15th' },
              ],
            }),
          });
          holdForAsk();
        });
        setTask('vote', 'working');
        addDecision('chronologist', 'Chronologist filed a draft', `— 12 events, 1 flag; leans on ${fname(0)} (5 citations).`);
        patchCouncil({
          prop: {
            by: 'chronologist',
            text: 'Open at the framework agreement — 14 Mar 2023, €120k scope.',
            source: fname(0),
            votes: [],
            ruling: null,
          },
        });
      }],
      [1400, () => {
        say('auditor', 'Dates check out against the ledger. I agree.');
        vote('auditor', 'agrees', 84, 'chronologist');
      }],
      [1200, () => {
        say('narrator', 'A clean opening beat. Agreed.');
        vote('narrator', 'agrees', 76, 'chronologist');
      }],
      [1400, () => {
        say('chair', 'Accepted. Strong documentary anchor; both peers concur.');
        sendPacket('chair', 'chronologist', 'ok', 1800);
        addDecision(LOG_OK, 'Accepted by the Chair', '— strong documentary anchor; both peers concur.', ['proposed by Chronologist', `source: ${fname(0)}`, '2 agree · 0 object']);
        patchCouncil((c) => ({
          prop: c.prop && { ...c.prop, ruling: { accepted: true, reason: 'strong documentary anchor; both peers concur.' } },
        }));
      }],
      // ── Round 2: Narrator's turning point — objections, dispute, REJECTED.
      [1800, () => {
        setActive('narrator', false);
        stopShuttle('narrator');
        sendPacket('narrator', 'chair', 'pen', 1600);
        say('narrator', 'Draft ready — 8 events, 0 flags.', '8 events · 0 flags');
        addDecision('narrator', 'Narrator filed a draft', `— 8 events, 0 flags; leans on ${fname(1)} (3 citations).`);
        patchCouncil({
          prop: {
            by: 'narrator',
            text: 'Frame the June emails as the turning point of the story.',
            source: fname(1),
            votes: [],
            ruling: null,
          },
        });
      }],
      [1400, () => {
        say('auditor', 'Hold on — the email dates conflict with the invoice log.');
        vote('auditor', 'objects', 68, 'narrator');
      }],
      [1200, () => {
        say('chronologist', 'The 9 Jun email predates the payment stop? Sequence unclear.');
        vote('chronologist', 'objects', 55, 'narrator');
      }],
      [1400, () => {
        setActive('auditor', false);
        stopShuttle('auditor');
        sendPacket('auditor', 'chair', 'pen', 1600);
        say('auditor', 'Draft ready — 13 events, 4 flags.', '13 events · 4 flags');
        schedule(600, () => sendPacket('auditor', 'chair', 'flag', 2000));
        addDecision('auditor', 'Auditor filed a draft', '— 13 events, 4 flags.');
        setTask('draft', 'done');
        setTask('dispute', 'working');
        setActive('chair', true);
        say('chair', 'The council is split. I need direction from the author.');
        addDecision(LOG_STEER, 'The drafts disagree', '— Chronologist: 12 ev, 1 fl · Narrator: 8 ev, 0 fl · Auditor: 13 ev, 4 fl.');
        // The objectors fire red ✕ decision packets at the chair, then ONE
        // big ?-mark pulses at the mesh crossing; the ask panel waits so
        // both get their moment before the chamber fades.
        sendPacket('auditor', 'chair', 'no', 2200);
        sendPacket('chronologist', 'chair', 'no', 2200);
        schedule(1300, () => patchCouncil({ askMark: true }));
        schedule(2600, () => {
          patchCouncil({
            askMark: false,
            ask: {
              question: 'The analysts disagree on the record.',
              context: 'Chronologist drafted 12 events (1 flag) · Narrator drafted 8 events (0 flags) · Auditor drafted 13 events (4 flags). How should the Chair weigh the drafts?',
              options: DISPUTE_OPTIONS,
            },
          });
          // The script HOLDS here — the session only proceeds once the
          // author answers (answerCouncil releases the hold).
          holdForAsk();
        });
      }],
      [6200, () => {
        setTask('dispute', 'done');
        say('chair', 'Rejected for now — the dates get verified before this beat lands.');
        sendPacket('chair', 'narrator', 'no', 1800);
        addDecision(LOG_BAD, 'Rejected by the Chair', '— held until the Auditor reconciles the ledger dates.', ['proposed by Narrator', '0 agree · 2 object']);
        patchCouncil((c) => ({
          prop: c.prop && { ...c.prop, ruling: { accepted: false, reason: 'held until the ledger dates are reconciled.' } },
        }));
      }],
      // ── Contradiction re-check: the Auditor clears the mismatch.
      [1800, () => {
        setActive('auditor', true);
        say('auditor', 'Re-reading invoice #204 against the 9 Jun email…');
        startShuttle('auditor');
      }],
      [2400, () => {
        setActive('auditor', false);
        stopShuttle('auditor');
        say('auditor', 'Resolved: the ledger posting lagged. Narrator’s date stands.');
        sendPacket('auditor', 'chair', 'fact', 1800);
        addFact(fname(2), 'Ledger posting lagged — 9 Jun holds', COUNCIL_COLORS.auditor);
        addDecision(LOG_INFO, 'Contradiction resolved', '— invoice ledger posting lag explained the mismatch.');
      }],
      // ── Round 3: the beat returns verified — ACCEPTED.
      [1400, () => {
        sendPacket('narrator', 'chair', 'pen', 1600);
        say('narrator', 'Turning point: the 9 Jun escalation email — now cross-checked.');
        patchCouncil({
          prop: {
            by: 'narrator',
            text: 'Turning point: the 9 Jun escalation email — now cross-checked.',
            source: fname(1),
            votes: [],
            ruling: null,
          },
        });
      }],
      [1200, () => {
        say('auditor', 'Verified this round. Agreed.');
        vote('auditor', 'agrees', 88, 'narrator');
      }],
      [1000, () => vote('chronologist', 'agrees', 83, 'narrator')],
      [1300, () => {
        say('chair', 'Accepted. Second reading holds; the contradiction is cleared.');
        sendPacket('chair', 'narrator', 'ok', 1800);
        addDecision(LOG_OK, 'Accepted by the Chair', '— second reading holds; the contradiction is cleared.', ['proposed by Narrator', `source: ${fname(1)}`, '2 agree · 0 object', 'avg confidence 86%']);
        patchCouncil((c) => ({
          prop: c.prop && { ...c.prop, ruling: { accepted: true, reason: 'second reading holds; the contradiction is cleared.' } },
        }));
      }],
      // ── Merge + save + end sequence.
      [1800, () => {
        stopAllShuttles();
        setPhase('Final assembly');
        setTask('vote', 'done');
        setTask('merge', 'working');
        say('chair', 'Merging 3 drafts into the final cut…');
        addDecision(LOG_INFO, 'Merge begun', '— the chair weighs 3 drafts against each other.');
        // The merge begins — every analyst's draft rides back to the chair,
        // and clarification chatter flows while the cut is assembled.
        COUNCIL_UI.slice(1).forEach((m, i) => {
          sendPacket(m.id, 'chair', 'pen', 1600);
          schedule(1400 + i * 600, () => sendPacket('chair', m.id, 'chat', 1800));
        });
      }],
      [2000, () => {
        setActive('chair', false);
        setTask('merge', 'done');
        setTask('save', 'working');
        COUNCIL_UI.slice(1).forEach((m) => sendPacket('chair', m.id, 'ok', 1800));
        addDecision(LOG_OK, 'Merged by the Chair', '— 14 events kept, 4 flags raised.');
      }],
      [700, () => {
        setTask('save', 'done');
        setPhase('Story complete');
        addDecision(LOG_INFO, 'Story saved', '— the reconstructed timeline is stored with this project.');
        say('chair', 'We have our story — every beat sourced and voted on.');
        addDecision(LOG_OK, 'Final story approved', '— 14 events, 4 open flags.', ['merged by the chair', '3 of 3 analysts filed', '2 beats accepted · 1 held']);
        patchCouncil({
          ruling: 'majority',
          lede: 'A €120k framework deal signed in March 2023 unravels when payments stop and invoice #204 goes unanswered; a June escalation turns delay into dispute — until a scope change closes the loop in a revised deal.',
        });
      }],
      // The gavel waits for the last packet to land ('wait' stage + gating
      // effects), with a stuck-packet fallback; the story follows the slam's
      // half mark automatically.
      gavelEnd,
    ];
    const script = [...intake, ...fullTail];
    let at = 0;
    script.forEach(([d, fn]) => { at += d; schedule(at, fn); });
  };

  const startDebugAsks = () => {
    if (analyzing) return;
    // Already showing a question in debug mode? Each press CYCLES to the
    // next shape (wrapping), without resetting the chamber.
    if (debugRun && council?.ask) {
      askVarIdxRef.current = (askVarIdxRef.current + 1) % ASK_VARIATIONS.length;
      askQueueRef.current = ASK_VARIATIONS.slice(askVarIdxRef.current + 1);
      askOpenRef.current = true;
      patchCouncil({ ask: ASK_VARIATIONS[askVarIdxRef.current] });
      return;
    }
    clearTimers();
    resetCouncilPause();
    pendingFactsRef.current = {};
    askQueueRef.current = [];
    askOpenRef.current = false;
    askResolverRef.current = null;
    askHoldRef.current = false;
    earlyFlagAnswersRef.current = {};
    const items = files.length > 0
      ? files.map((f) => ({ name: f.name, mime: f.type || '', url: objectUrlFor(f), path: pathForFile(f) }))
      : FALLBACK_SCAN_FILES;
    setScanItems(items);
    setScanProgress(items.map(() => 100));
    setScanning(false);
    setDebugRun(true);
    setScanError(null);
    setStep('scan');
    decisionSeq.current = 0;
    askVarIdxRef.current = 0;
    askQueueRef.current = ASK_VARIATIONS.slice(1);
    setCouncil({
      ...freshCouncil(),
      phase: 'Deliberating',
      tasks: {
        ...Object.fromEntries(COUNCIL_TASKS.map((t) => [t.id, 'done'])),
        dispute: 'working',
        merge: 'queued',
        save: 'queued',
      },
      ask: ASK_VARIATIONS[0],
    });
  };

  // Release queued simulator facts the moment their file starts loading —
  // each pill appears as its file's bar begins to fill (slightly staggered
  // when a file carries several).
  useEffect(() => {
    if (!debugRun) return;
    scanProgress.forEach((p, i) => {
      const queued = p > 0 && pendingFactsRef.current[i];
      if (!queued) return;
      delete pendingFactsRef.current[i];
      const name = scanItems[i]?.name;
      if (!name) return;
      queued.forEach((f, j) => schedule(150 + j * 450, () => {
        addFact(name, f.text, f.color);
        // The first finding of each file also rides the mesh: a fact packet
        // from its analyst (or an amber flag from the chair for warnings).
        if (j === 0) {
          const member = MEMBER_BY_COLOR[f.color];
          if (member) sendPacket(member, 'chair', 'fact', 1800);
          else sendPacket('chair', 'auditor', 'flag', 2000);
        }
      }));
    });
  }, [scanProgress, debugRun]);

  useEffect(() => {
    if (!scanning || !debugRun) return undefined;
    const id = setInterval(() => {
      if (pausedRef.current) return;
      setScanProgress((prev) => prev.map((p, i) => {
        if (p >= 100) return 100;
        if (i > 0 && prev[i - 1] < 45) return p;
        return Math.min(100, p + 1.2 + Math.random() * 2.8);
      }));
    }, 90);
    return () => clearInterval(id);
  }, [scanning, debugRun]);

  // Park the simulator once every file has finished (real runs end when the
  // AI response lands instead).
  useEffect(() => {
    if (scanning && debugRun && scanProgress.length > 0 && scanProgress.every((p) => p >= 100)) {
      setScanning(false);
    }
  }, [scanning, debugRun, scanProgress]);

  if (loading && !selectedProject) return null;

  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to build its case timeline.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  const stepIdx = STEPS.findIndex((s) => s.id === step);

  // Step-switch enter animation (the Activity tab's feed treatment): the
  // body below the step rail fades/slides in from the side the rail just
  // travelled toward; the keyed remount replays it on every switch.
  const prevStepIdxRef = useRef(stepIdx);
  const stepEnterDir = stepIdx >= prevStepIdxRef.current ? 'right' : 'left';
  useEffect(() => { prevStepIdxRef.current = stepIdx; }, [stepIdx]);

  return (
    <div className="cto-root">
      {/* ── Masthead (option 1a) — eyebrow + editorial title + description.
          Once the timeline is built, the header switches to describe the
          reconstructed story instead of the upload prompt. */}
      <header className="cto-masthead">
        <div className="cto-mh-main">
          <div className="cto-mh-eyebrow">
            <span>Case chronology</span>
            <span className="cto-mh-ref">· built from your files</span>
          </div>
          {step === 'timeline' && timeline?.meta?.final ? (
            <>
              <h1 className="cto-mh-title">The story, reconstructed</h1>
              <p className="cto-mh-kicker">
                {timeline.lede
                  || 'DocVex read every file and assembled the events into a single chronological narrative.'}
              </p>
              <div className="cto-story-meta">
                Reconstructed by {timeline.meta?.council
                  ? `a DocVex AI council (${timeline.meta.council.merged
                    ? `${timeline.meta.council.size} analysts + chair`
                    : `${timeline.meta.council.size} analyst${timeline.meta.council.size === 1 ? '' : 's'}`})`
                  : 'DocVex'} from {timeline.meta?.fileCount ?? timeline.events.length}{' '}
                {(timeline.meta?.fileCount ?? 0) === 1 ? 'file' : 'files'} ·{' '}
                {timeline.events.length} {timeline.events.length === 1 ? 'event' : 'events'} ·{' '}
                <span className="cto-story-flags">
                  {timeline.flags.length} open {timeline.flags.length === 1 ? 'flag' : 'flags'}
                </span>
                {timeline.meta?.final ? ' · finalised with your clarifications' : ''}
              </div>
            </>
          ) : (() => {
            const head = STEP_HEADERS[step] || STEP_HEADERS.timeline;
            return (
              <>
                <h1 className="cto-mh-title">{head.title}</h1>
                <p className="cto-mh-kicker">{head.kicker}</p>
              </>
            );
          })()}
        </div>
        {/* Dev affordances — the simulator seeds the Scanning grid from the
            uploaded files (or the fallback sample set) and animates their
            progress; the pause toggle freezes the council process in place.
            Sit to the RIGHT of the Scanning header, on that tab only. */}
        {step === 'scan' && (
          <div className="cto-debug-row">
            <button type="button" className="cto-debug-btn" onClick={startDebugScan}>
              Debug · simulate scan
            </button>
            <button
              type="button"
              className={`cto-debug-btn${paused ? ' is-on' : ''}`}
              onClick={toggleCouncilPause}
            >
              {paused ? 'Debug · resume council' : 'Debug · pause council'}
            </button>
            <button type="button" className="cto-debug-btn" onClick={startDebugAsks}>
              Debug · ask variations
            </button>
          </div>
        )}
      </header>

      {/* ── Step rail — numbered circles + connector lines. A PROGRESS
          indicator, not navigation: the run moves itself from upload to scan
          to timeline, and clicking a step used to drop the user out of a live
          council with no way back into it. */}
      <ol className="cto-steps" aria-label="Progress">
        {STEPS.map((s, i) => {
          const state = i === stepIdx ? 'active' : i < stepIdx ? 'done' : 'todo';
          return (
            <li key={s.id} className="cto-step-cell">
              <span className="cto-step" aria-current={state === 'active' ? 'step' : undefined}>
                <span className="cto-step-dot" data-state={state}>
                  {state === 'done' ? <IcoCheck width="14" height="14" /> : s.n}
                </span>
                <span className="cto-step-label">{s.label}</span>
              </span>
              {i < STEPS.length - 1 && <span className="cto-step-line" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>

      <div key={step} className={`cto-step-body is-enter-${stepEnterDir}`}>
      {step === 'upload' && (
        <UploadStep
          files={files}
          addFiles={addFiles}
          removeFile={removeFile}
          onAnalyze={analyzeFiles}
          analyzing={analyzing}
        />
      )}
      {step === 'scan' && (
        <CouncilStep
          items={scanItems}
          progress={scanProgress}
          council={council}
          paused={paused}
          user={logUser}
          error={scanError}
          onAnswer={answerCouncil}
          onPacketDone={removePacket}
          // The ruling card only appears once the story is final — every
          // question was already answered in the chamber, so there is no
          // separate round standing between the merge and the gavel.
          onReadStory={() => setStep('timeline')}
          storyCta="Read the whole story"
          // Redo — re-run the same kind of session that just finished: the
          // simulator for debug runs, the real analysis when files are in
          // hand (falls back to the Upload step otherwise).
          onRedo={() => {
            if (debugRun) startDebugScan();
            else if (files.length > 0) analyzeFiles();
            else setStep('upload');
          }}
        />
      )}
      {step === 'timeline' && (
        <TimelineStep
          // The timeline EXISTS only once the chair has ruled — a draft still
          // being folded together shows the empty state, not a half-story.
          timeline={timeline?.meta?.final ? timeline : null}
          draftPending={!!(timeline && !timeline.meta?.final)}
          projectDir={projectDir}
          goReview={() => setStep('scan')}
          // Re-run the council when the picks are still in hand; otherwise
          // bounce to Upload so the user can re-provide the sources.
          onRegenerate={() => {
            if (files.length > 0) analyzeFiles();
            else setStep('upload');
          }}
        />
      )}
      </div>
    </div>
  );
}

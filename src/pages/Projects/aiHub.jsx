import React from 'react';

// Lucide-style stroke icons, ported from the Claude Design AI-tab handoff.
// The app convention is inline JSX icon constants; here a tiny factory keeps
// the set compact since the AI hub uses ~30 glyphs. Each entry is a function
// `(props) => <svg>` so call sites can pass size overrides, e.g. ICONS.spark({ width: 13 }).
const mk = (paths) => (props = {}) => React.createElement(
  'svg',
  {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, ...props,
  },
  paths.map((d, i) => (typeof d === 'string'
    ? React.createElement('path', { key: i, d })
    : React.createElement(d.t, { key: i, ...d.p }))),
);

export const ICONS = {
  // The app's standard AI sparkle glyph — the same stroke icon the sidebar /
  // pane nav use for the AI destination. (The former animated AiSphere
  // "thinking sphere" component was removed.)
  spark: mk(['M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z', 'M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z']),
  pen: mk(['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z']),
  shield: mk(['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z']),
  scale: mk(['m16 16 3-8 3 8c-2 1.5-4 1.5-6 0', 'm2 16 3-8 3 8c-2 1.5-4 1.5-6 0', 'M7 21h10', 'M12 3v18', 'M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2']),
  chat: mk(['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z']),
  book: mk(['M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20']),
  bolt: mk([{ t: 'polygon', p: { points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2' } }]),
  grid: mk([{ t: 'rect', p: { x: 3, y: 3, width: 7, height: 9 } }, { t: 'rect', p: { x: 14, y: 3, width: 7, height: 5 } }, { t: 'rect', p: { x: 14, y: 12, width: 7, height: 9 } }, { t: 'rect', p: { x: 3, y: 16, width: 7, height: 5 } }]),
  file: mk(['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', { t: 'polyline', p: { points: '14 2 14 8 20 8' } }]),
  files: mk(['M15 2H6a2 2 0 0 0-2 2v14', 'M9 18h9a2 2 0 0 0 2-2V8l-5-5H9a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2z']),
  send: mk(['m22 2-7 20-4-9-9-4Z', 'M22 2 11 13']),
  arrowUp: mk(['M12 19V5', 'm5 12 7-7 7 7']),
  stop: mk([{ t: 'rect', p: { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2 } }]),
  plus: mk(['M12 5v14', 'M5 12h14']),
  search: mk([{ t: 'circle', p: { cx: 11, cy: 11, r: 8 } }, 'm21 21-4.3-4.3']),
  copy: mk([{ t: 'rect', p: { x: 9, y: 9, width: 13, height: 13, rx: 2 } }, 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1']),
  quote: mk(['M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z', 'M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z']),
  download: mk(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3']),
  check: mk(['M20 6 9 17l-5-5']),
  refresh: mk(['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5']),
  alert: mk(['M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01']),
  x: mk(['M18 6 6 18', 'M6 6l12 12']),
  caret: mk([{ t: 'polyline', p: { points: '6 9 12 15 18 9' } }]),
  panelLeft: mk([{ t: 'rect', p: { x: 3, y: 3, width: 18, height: 18, rx: 2 } }, 'M9 3v18']),
  paperclip: mk(['m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48']),
  clock: mk([{ t: 'circle', p: { cx: 12, cy: 12, r: 10 } }, { t: 'polyline', p: { points: '12 6 12 12 16 14' } }]),
  tag: mk(['M12 2H2v10l9.29 9.29a1 1 0 0 0 1.42 0l8.58-8.58a1 1 0 0 0 0-1.42z', 'M7 7h.01']),
  route: mk([{ t: 'circle', p: { cx: 6, cy: 19, r: 3 } }, 'M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15', { t: 'circle', p: { cx: 18, cy: 5, r: 3 } }]),
  bell: mk(['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.73 21a2 2 0 0 1-3.46 0']),
  inbox: mk(['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z']),
  briefcase: mk([{ t: 'rect', p: { x: 2, y: 7, width: 20, height: 14, rx: 2 } }, 'M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16']),
  list: mk(['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01']),
  users: mk(['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', { t: 'circle', p: { cx: 9, cy: 7, r: 4 } }, 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75']),
  calendar: mk([{ t: 'rect', p: { x: 3, y: 4, width: 18, height: 18, rx: 2 } }, 'M16 2v4', 'M8 2v4', 'M3 10h18']),
  target: mk([{ t: 'circle', p: { cx: 12, cy: 12, r: 10 } }, { t: 'circle', p: { cx: 12, cy: 12, r: 6 } }, { t: 'circle', p: { cx: 12, cy: 12, r: 2 } }]),
  gavel: mk(['m14.5 12.5-8 8a2.12 2.12 0 1 1-3-3l8-8', 'm16 16 6-6', 'm8 8 6-6', 'm9 7 8 8', 'm21 11-8-8']),
};

// Mock matter context. There is no real backend for these AI features yet,
// so this is the prototype's simulated commercial-litigation matter, kept as
// a static placeholder (per the design-handoff fidelity rule).
export const MATTER = {
  matter: {
    name: 'Aedificia Construct SRL v. Veridian Logistics SA',
    code: 'LIT-2024-0188',
    type: 'Commercial litigation · Breach of contract',
    court: 'Bucharest Tribunal — 6th Civil Division',
    client: 'Aedificia Construct SRL',
    opposing: 'Veridian Logistics SA',
    value: '€ 1.84M',
  },

  files: [
    { id: 'F1', name: 'Framework Agreement Aedificia–Veridian.pdf', kind: 'Contract', pages: 34 },
    { id: 'F2', name: 'Schedule 2 — Delivery timeline.pdf', kind: 'Annex', pages: 6 },
    { id: 'F3', name: 'Notice of default.docx', kind: 'Correspondence', pages: 3 },
    { id: 'F4', name: 'Technical expert report.pdf', kind: 'Evidence', pages: 41 },
    { id: 'F5', name: 'Statement of defence — Veridian.pdf', kind: 'Pleading', pages: 18 },
    { id: 'F6', name: 'Email correspondence 2024.pdf', kind: 'Correspondence', pages: 52 },
    { id: 'F7', name: 'Pro forma invoices, series AV.pdf', kind: 'Financial', pages: 12 },
  ],

  actions: [
    { tone: 'generate', tab: 'generate', icon: 'pen', t: 'Draft a document', d: 'Claims, defences, written submissions, notices and contracts drafted from the matter context.', tag: '14 templates' },
    { tone: 'review', tab: 'review', icon: 'shield', t: 'Review a contract', d: 'Flag risky clauses, obligations and deadlines, with concrete redline suggestions.', tag: '3 major risks' },
    { tone: 'research', tab: 'research', icon: 'scale', t: 'Legal research', d: 'Romanian legislation, EU directives and relevant case law for the dispute.', tag: 'legislatie.just.ro' },
    { tone: 'automate', tab: 'automate', icon: 'bolt', t: 'Automations', d: 'Auto-tagging, deadline alerts, document routing and client intake.', tag: '4 active' },
    { tone: 'compliance', tab: 'compliance', icon: 'shield', t: 'Compliance check', d: 'GDPR and conflict-of-interest scanning for the matter and its clients.', tag: 'Score 86' },
  ],

  recent: [
    { icon: 'pen', tone: 'generate', t: 'Generated <b>Written submissions</b> — 4 pages', m: '12 min ago', status: 'done', sl: 'Done' },
    { icon: 'shield', tone: 'review', t: 'Reviewed <b>Framework Agreement</b> — 11 clauses flagged', m: '1 hour ago', status: 'flag', sl: '3 major' },
    { icon: 'bolt', tone: 'automate', t: 'Automation <b>Deadline alert</b> notified the team', m: '5 hours ago', status: 'run', sl: 'Active' },
    { icon: 'scale', tone: 'research', t: 'Researched: <b>art. 1530 Civil Code — damages</b>', m: 'yesterday', status: 'done', sl: '8 sources' },
  ],

  stats: [
    { n: '142', l: 'Documents generated', d: '+18 this month' },
    { n: '36', sm: 'h', l: 'Est. time saved', d: 'this month' },
    { n: '4', l: 'Active automations', d: 'no errors' },
    { n: '86', l: 'Compliance score', d: 'GDPR + conflicts' },
  ],
};

// Maps a tool "tone" to its notification-category color token, so card / feed
// icon tints stay consistent with the rest of the app's category palette.
export const TONE_CAT = {
  generate: 'project',
  review: 'file',
  ask: 'member',
  research: 'update',
  automate: 'auth',
  compliance: 'role',
};

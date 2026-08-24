// Full-project context for the AI advisor (/ai) — gathers EVERYTHING the app
// knows about a project into one compact text digest the model can read:
//
//   • the project card (name, description, admin AI notes from ai_context)
//   • members + roles                     (Supabase)
//   • the local-folder file inventory     (names, folders, sizes, dates)
//   • cached per-file AI descriptions     (lib/aiFileIndex)
//   • the team chat                       (chat_messages; DMs stay private)
//   • the case timeline                   (lib/caseTimeline)
//   • OCR text snippets                   (lib/extractionHistory)
//   • audio/video captions (transcripts)  (lib/captionsHistory)
//   • extracted file metadata             (lib/metadataHistory)
//
// Everything is size-capped per section and overall, so the digest stays a
// bounded prefix on the model turn rather than an unbounded dump. Sources
// that fail (offline, RLS, quota) are skipped silently — the digest is
// best-effort by design.

import { listChatMessages } from './chat';
import { listMembers } from './projects';
import { loadCaseTimeline } from './caseTimeline';
import { listOcrHistories } from './extractionHistory';
import { loadCaptions } from './captionsHistory';
import { loadMetadata } from './metadataHistory';
import { describedText } from './aiFileIndex';

// Per-section character budgets (≈ tokens ÷ 4). Generous but bounded.
const CAP = {
  files: 5000,
  chat: 6000,
  timeline: 5000,
  snippets: 4000,
  captions: 6000,
  metadata: 3000,
  total: 28000,
};

const clip = (s, n) => {
  const t = String(s || '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const day = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return ''; }
};
const dayTime = (iso) => {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch { return ''; }
};
const fmtBytes = (b) => {
  const n = Number(b) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};
const profileName = (p) => p?.full_name || p?.name || p?.email || null;

// Build one "# Heading" section, truncated to its budget. Returns '' when the
// body is empty so absent sources vanish instead of leaving hollow headings.
function section(title, body, cap) {
  const text = String(body || '').trim();
  if (!text) return '';
  const cut = text.length > cap;
  return `# ${title}\n${cut ? `${text.slice(0, cap)}\n…[section truncated]` : text}`;
}

function filesSection(files) {
  if (!files?.length) return '';
  const lines = files.map((f) => {
    const loc = f.folderPath ? `${f.folderPath}/` : '';
    const desc = describedText(f);
    const bits = [fmtBytes(f.sizeBytes), f.mtimeIso ? `modified ${day(f.mtimeIso)}` : null].filter(Boolean).join(', ');
    return `- ${loc}${f.name} (${bits})${desc ? ` — ${clip(desc, 200)}` : ''}`;
  });
  return `${files.length} file(s) in the project's local folder:\n${lines.join('\n')}`;
}

function membersSection(members) {
  if (!members?.length) return '';
  return members
    .map((m) => `- ${profileName(m.profile) || m.user_id} — ${m.role}`)
    .join('\n');
}

function chatSection(messages, nameById) {
  const live = (messages || []).filter((m) => !m.deleted_at && (m.body || '').trim());
  if (!live.length) return '';
  const lines = live.map((m) => {
    const who = nameById.get(m.author_id) || 'Member';
    const pin = m.pinned_at ? ' [pinned]' : '';
    return `[${dayTime(m.created_at)}] ${who}${pin}: ${clip(m.body, 280)}`;
  });
  return `Last ${live.length} team-chat message(s), oldest first (private DMs are not shared):\n${lines.join('\n')}`;
}

function timelineSection(timeline) {
  if (!timeline?.events?.length) return '';
  const out = [];
  if (timeline.lede) out.push(clip(timeline.lede, 400));
  for (const ev of timeline.events.slice(0, 40)) {
    const when = [ev.d, ev.y].filter(Boolean).join(' ');
    const files = Array.isArray(ev.files) && ev.files.length ? ` (files: ${ev.files.slice(0, 4).join(', ')})` : '';
    out.push(`- ${when ? `[${when}] ` : ''}${ev.title || ''}${ev.body ? ` — ${clip(ev.body, 220)}` : ''}${files}`);
  }
  return out.join('\n');
}

function snippetsSection(projectFiles) {
  // OCR histories are keyed by full file path — keep only this project's.
  const byPath = new Set(projectFiles.map((f) => f.path).filter(Boolean));
  const byName = new Set(projectFiles.map((f) => f.name));
  const all = listOcrHistories().filter((h) => byPath.has(h.filePath) || byName.has(h.fileName));
  if (!all.length) return '';
  const out = [];
  for (const h of all.slice(0, 12)) {
    out.push(`## ${h.fileName}`);
    for (const e of h.entries.slice(0, 4)) out.push(`- "${clip(e.text, 400)}"`);
  }
  return `Text the user extracted from files with the OCR tool:\n${out.join('\n')}`;
}

function captionsSection(projectFiles) {
  const out = [];
  for (const f of projectFiles) {
    if (!f.path) continue;
    const cap = loadCaptions(f.path);
    if (!cap?.text) continue;
    out.push(`## ${f.name}${cap.language ? ` (${cap.language})` : ''}\n${clip(cap.text, 1800)}`);
    if (out.length >= 8) break;
  }
  return out.length ? `AI transcripts (captions) of the project's audio/video files:\n${out.join('\n')}` : '';
}

function metadataSection(projectFiles) {
  const out = [];
  for (const f of projectFiles) {
    if (!f.path) continue;
    const meta = loadMetadata(f.path);
    if (!meta?.groups?.length) continue;
    const facts = [];
    for (const g of meta.groups) {
      for (const r of (g.rows || [])) {
        if (r?.label && r.value != null && r.value !== '') facts.push(`${r.label}: ${clip(r.value, 80)}`);
        if (facts.length >= 12) break;
      }
      if (facts.length >= 12) break;
    }
    if (facts.length) out.push(`## ${f.name}\n${facts.join(' · ')}`);
    if (out.length >= 15) break;
  }
  return out.length ? `Extracted file metadata:\n${out.join('\n')}` : '';
}

// Build the digest. `project` is the selected project row; `files` is the
// recursive local-folder listing ({ name, path, folderPath, sizeBytes,
// mtimeIso }). Network sources load in parallel; every source is optional.
export async function buildProjectDigest({ project, files = [] }) {
  if (!project?.id) return '';
  const [membersRes, chatRes] = await Promise.all([
    listMembers(project.id).catch(() => ({ data: [] })),
    listChatMessages(project.id, { limit: 60 }).catch(() => ({ data: [] })),
  ]);
  const members = membersRes?.data || [];
  const nameById = new Map(members.map((m) => [m.user_id, profileName(m.profile)]));

  const projectCard = [
    `Name: ${project.name || 'Untitled'}`,
    project.description ? `Description: ${clip(project.description, 600)}` : null,
    project.created_at ? `Created: ${day(project.created_at)}` : null,
    project.ai_context ? `Admin notes for the AI:\n${clip(project.ai_context, 1500)}` : null,
  ].filter(Boolean).join('\n');

  const sections = [
    section('Project', projectCard, 2500),
    section('Members', membersSection(members), 1500),
    section('Files', filesSection(files), CAP.files),
    section('Team chat', chatSection(chatRes?.data, nameById), CAP.chat),
    section('Case timeline', timelineSection(loadCaseTimeline(project.id)), CAP.timeline),
    section('Extracted text snippets (OCR)', snippetsSection(files), CAP.snippets),
    section('Audio/video captions', captionsSection(files), CAP.captions),
    section('File metadata', metadataSection(files), CAP.metadata),
  ].filter(Boolean);

  const body = sections.join('\n\n');
  return body.length > CAP.total ? `${body.slice(0, CAP.total)}\n…[context truncated]` : body;
}

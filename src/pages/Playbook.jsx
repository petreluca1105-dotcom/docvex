import React, { useCallback, useEffect, useRef, useState } from 'react';
import PageMasthead from '../components/PageMasthead';
import Tooltip from '../components/Tooltip';
import { useAuth } from '../context/AuthContext';
import { extractFileText } from '../lib/extractFileText';
import {
  listSamples, addSample, removeSample,
  loadProfile, rebuildProfile, setStyleEnabled,
} from '../lib/writingStyle';
import './Playbook.css';

// Playbook — the user's own documents, and the writing voice the AI learns from
// them.
//
// A draft that is correct but does not sound like the person sending it still
// has to be rewritten, so the time it saved is spent again. The fix is not a
// better prompt: it is showing the model how THIS person writes. So they import
// documents they wrote by hand, one pass distils those into a description of
// their drafting habits, and that description rides along with every request
// that writes or edits a document — in this project and every other.
//
// It hangs off the ACCOUNT, not a project: how someone writes follows them.

const ACCEPT = '.docx,.pdf,.txt,.md,.rtf,.csv,.xlsx';
const MAX_BYTES = 25 * 1024 * 1024;

const IconUpload = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 16V4" /><path d="m7 9 5-5 5 5" />
    <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" />
  </svg>
);
const IconDoc = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H14l5 5v11.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5z" />
    <path d="M14 3v5h5" /><path d="M8.5 13h7M8.5 16h4.5" />
  </svg>
);
const IconX = (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

function bytesLabel(chars) {
  if (!chars) return '';
  if (chars < 1000) return `${chars} characters`;
  return `${Math.round(chars / 1000)}k characters`;
}
function whenLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function Playbook() {
  const { session } = useAuth();
  const signedIn = !!session?.user?.id;

  const [samples, setSamples] = useState([]);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [learning, setLearning] = useState(false);
  const [note, setNote] = useState(null);       // { tone, text }
  const [dragging, setDragging] = useState(false);
  // Filename → why it was skipped, while a batch is being read.
  const [importing, setImporting] = useState([]);
  const fileRef = useRef(null);
  const dragDepth = useRef(0);

  const refresh = useCallback(async () => {
    if (!signedIn) { setLoading(false); return; }
    setLoading(true);
    const [s, p] = await Promise.all([listSamples(), loadProfile()]);
    if (!s.error) setSamples(s.samples);
    if (!p.error) setProfile(p.profile);
    setLoading(false);
  }, [signedIn]);
  useEffect(() => { refresh(); }, [refresh]);

  // Learn from whatever is currently imported. Run automatically after an
  // import or a removal — the profile is a claim about the documents on this
  // page, so it must not be allowed to disagree with them.
  const learn = useCallback(async () => {
    setLearning(true);
    const res = await rebuildProfile();
    setLearning(false);
    if (res.error) {
      setNote({
        tone: 'error',
        text: res.error.message === 'ai_not_configured'
          ? 'The AI isn’t configured on the server yet, so it can’t read these documents.'
          : 'Couldn’t reach the AI to read those documents. Try again in a moment.',
      });
      return;
    }
    setProfile(res.profile);
    setNote(res.profile.text
      ? { tone: 'ok', text: 'Learned. New documents will be written in your voice.' }
      : null);
  }, []);

  const ingest = useCallback(async (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setNote(null);
    setImporting(list.map((f) => f.name));
    const skipped = [];
    let added = 0;
    for (const f of list) {
      if (f.size > MAX_BYTES) { skipped.push(`${f.name} — too large`); continue; }
      // eslint-disable-next-line no-await-in-loop
      const ex = await extractFileText(f, f.name);
      const text = ex?.text || '';
      if (!text.trim()) {
        skipped.push(`${f.name} — no text could be read from it`);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const res = await addSample({ name: f.name, mimeType: f.type || '', text });
      if (res.error) skipped.push(`${f.name} — couldn’t be saved`);
      else added += 1;
    }
    setImporting([]);
    const s = await listSamples();
    if (!s.error) setSamples(s.samples);
    if (skipped.length) {
      setNote({ tone: added ? 'warn' : 'error', text: `Skipped ${skipped.length}: ${skipped.join('; ')}.` });
    }
    if (added) await learn();
  }, [learn]);

  const drop = async (id) => {
    const res = await removeSample(id);
    if (res.error) { setNote({ tone: 'error', text: 'Couldn’t remove that document.' }); return; }
    const next = samples.filter((s) => s.id !== id);
    setSamples(next);
    await learn();
  };

  const toggle = async (on) => {
    setProfile((p) => (p ? { ...p, enabled: on } : p));
    const res = await setStyleEnabled(on);
    if (res.error) { setProfile((p) => (p ? { ...p, enabled: !on } : p)); }
  };

  const onDrop = (e) => {
    e.preventDefault();
    dragDepth.current = 0; setDragging(false);
    ingest(e.dataTransfer?.files);
  };

  const hasStyle = !!profile?.text;
  const busy = learning || importing.length > 0;

  return (
    <div className="page-frame">
      <PageMasthead
        eyebrow="DocVex"
        eyebrowMuted="Your writing"
        title="Playbook"
      >
        Import documents you wrote yourself and the AI learns how you draft —
        your structure, your phrasing, your tone. From then on everything it
        writes or edits for you comes out in your voice instead of its own.
      </PageMasthead>

      {!signedIn ? (
        <p className="pbk-signedout">Sign in to teach the AI how you write.</p>
      ) : (
        <div className="pbk">
          {/* ── What it learned ───────────────────────────────────────── */}
          <section className={`pbk-profile${hasStyle ? '' : ' is-empty'}`}>
            <header className="pbk-profile-head">
              <div className="pbk-profile-title">
                <h2>Your writing voice</h2>
                <p>
                  {hasStyle
                    ? `Read from ${profile.sampleCount} ${profile.sampleCount === 1 ? 'document' : 'documents'}${profile.generatedAt ? ` on ${whenLabel(profile.generatedAt)}` : ''}.`
                    : 'Nothing learned yet — import a document below and this fills itself in.'}
                </p>
              </div>
              {hasStyle && (
                <div className="pbk-profile-tools">
                  {/* Off without forgetting: a one-off piece that has to read
                      neutrally shouldn't cost someone everything they taught it. */}
                  <Tooltip content={profile.enabled ? 'Stop writing in your voice — nothing is forgotten' : 'Write in your voice again'}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!!profile.enabled}
                      className={`pbk-switch${profile.enabled ? ' is-on' : ''}`}
                      onClick={() => toggle(!profile.enabled)}
                    >
                      <span className="pbk-switch-track"><span className="pbk-switch-knob" /></span>
                      <span className="pbk-switch-label">{profile.enabled ? 'In use' : 'Paused'}</span>
                    </button>
                  </Tooltip>
                  <Tooltip content="Read your documents again and rewrite this">
                    <button type="button" className="pbk-relearn" onClick={learn} disabled={busy}>
                      {learning ? 'Reading…' : 'Learn again'}
                    </button>
                  </Tooltip>
                </div>
              )}
            </header>
            {hasStyle ? (
              <div className={`pbk-profile-body${profile.enabled ? '' : ' is-paused'}`}>
                {profile.text.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}
              </div>
            ) : (
              <p className="pbk-profile-blank">
                This is where the AI writes down what it noticed about your
                drafting — how you open and close, how you build a clause, the
                phrases you reach for. You can read it, and correct it by
                importing better examples.
              </p>
            )}
          </section>

          {/* ── The documents it learned from ─────────────────────────── */}
          <section className="pbk-samples">
            <header className="pbk-samples-head">
              <h2>Documents you wrote</h2>
              <p>
                Word, PDF or plain text. Pick the ones that read most like you —
                a handful of good examples teaches more than a folder of
                everything.
              </p>
            </header>

            <div
              className={`pbk-drop${dragging ? ' is-over' : ''}${busy ? ' is-busy' : ''}`}
              onDragEnter={(e) => { e.preventDefault(); dragDepth.current += 1; setDragging(true); }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => { dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
              onDrop={onDrop}
            >
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={ACCEPT}
                className="pbk-file"
                onChange={(e) => { const f = e.target.files; e.target.value = ''; ingest(f); }}
              />
              <span className="pbk-drop-mark" aria-hidden="true">{IconUpload}</span>
              <p className="pbk-drop-title">Drop documents here</p>
              <p className="pbk-drop-sub">or <button type="button" className="pbk-drop-browse" onClick={() => fileRef.current?.click()}>choose files</button></p>
              {/* Said plainly, before anything is uploaded rather than in a
                  policy nobody opens. These are the user's own documents and
                  some of them are privileged. */}
              <p className="pbk-drop-fine">
                Only the text is kept, and only the first pages of it — enough to
                read your style from. The files stay on your computer.
              </p>
            </div>

            {note && (
              <p className={`pbk-note is-${note.tone}`} role={note.tone === 'error' ? 'alert' : 'status'}>
                {note.text}
              </p>
            )}

            {importing.length > 0 && (
              <ul className="pbk-list">
                {importing.map((n) => (
                  <li className="pbk-item is-reading" key={`reading-${n}`}>
                    <span className="pbk-item-mark" aria-hidden="true">{IconDoc}</span>
                    <span className="pbk-item-text"><span className="pbk-item-name">{n}</span><span className="pbk-item-meta">Reading…</span></span>
                  </li>
                ))}
              </ul>
            )}

            {loading ? (
              <p className="pbk-empty">Loading…</p>
            ) : samples.length === 0 && importing.length === 0 ? (
              <p className="pbk-empty">No documents yet.</p>
            ) : (
              <ul className="pbk-list">
                {samples.map((s) => (
                  <li className="pbk-item" key={s.id}>
                    <span className="pbk-item-mark" aria-hidden="true">{IconDoc}</span>
                    <span className="pbk-item-text">
                      <span className="pbk-item-name">{s.name}</span>
                      <span className="pbk-item-meta">
                        {[bytesLabel(s.char_count), whenLabel(s.created_at)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <Tooltip content="Remove — the AI relearns without it">
                      <button type="button" className="pbk-item-drop" onClick={() => drop(s.id)} disabled={busy} aria-label={`Remove ${s.name}`}>
                        {IconX}
                      </button>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

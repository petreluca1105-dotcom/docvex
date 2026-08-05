import React, { useEffect } from 'react';
import { openExternal } from '../lib/platform';
import './SecurityInfoModal.css';

// "How your data is handled" — the answer a firm has to be able to give its
// clients, in one place. Opened from the ⓘ item at the bottom of the rail.
//
// Everything in here is a statement about the SHIPPED app, so it has to track
// the code. When a provider, model or storage location changes, this is the
// second file to edit (the first being the thing that changed) — a stale
// privacy notice in a legal product is worse than none.
// Cross-check against: the AI-providers table in CLAUDE.md, the model
// constants in supabase/functions/*/index.ts, and AI_MODELS in lib/projectAi.js.

const TERMS_URL = 'https://docvex.ro/terms.html';
const PRIVACY_URL = 'https://docvex.ro/privacy.html';
const GDPR_URL = 'https://docvex.ro/gdpr.html';
const DPA_URL = 'https://docvex.ro/dpa.html';
const SECURITY_URL = 'https://docvex.ro/security.html';

// Every model that can see user content, and what reaches it. Keep in step
// with the edge functions' *_MODEL env defaults.
const MODELS = [
  {
    name: 'Claude Opus 4.7',
    by: 'Anthropic',
    used: 'Project AI, the document advisor, the legal newsfeed and the Word add-in',
    sees: 'Document text and your questions',
  },
  {
    name: 'Claude Sonnet 4.6',
    by: 'Anthropic',
    used: 'Building Word, PowerPoint and Excel files',
    sees: 'Your instructions and the document being built',
  },
  {
    name: 'Claude Haiku 4.5',
    by: 'Anthropic',
    used: 'Reading text out of photos and screenshots',
    sees: 'The part of the image you select',
  },
  {
    name: 'Whisper',
    by: 'OpenAI',
    used: 'Turning recordings into captions',
    sees: 'The audio you ask it to transcribe',
  },
  {
    name: 'Nova-2',
    by: 'Deepgram',
    used: 'Labelling who speaks when — off unless your administrator turns it on',
    sees: 'The same audio, only if enabled',
    optional: true,
  },
];

export default function SecurityInfoModal({ onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="sec-scrim"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="sec-modal" role="dialog" aria-modal="true" aria-labelledby="sec-title">
        <header className="sec-head">
          <div>
            <p className="sec-eyebrow">Privacy &amp; security</p>
            <h2 id="sec-title" className="sec-title">How DocVex handles your files</h2>
          </div>
          <button type="button" className="sec-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <section className="sec-section">
          <h3 className="sec-h3">Your files stay on your computer</h3>
          <ul className="sec-list">
            <li>Project files live in a folder you choose. DocVex has <strong>no cloud file store</strong> — nothing is uploaded when you open, edit or organise them.</li>
            <li>Deleting a file moves it to a local recycle bin for 30 days, on your disk.</li>
            <li>The app can only read the folders you opened. Paths are resolved through their real location, so a shortcut can’t be used to reach the rest of your drive.</li>
            <li>Links open in your normal browser, and only ever <code>http</code> / <code>https</code>.</li>
          </ul>
        </section>

        <section className="sec-section">
          <h3 className="sec-h3">What is stored on our servers</h3>
          <ul className="sec-list">
            <li>Your account, your projects and who is in them, chat messages, and notifications — held in the EU (Supabase, eu-west-1).</li>
            <li>Access is enforced per row in the database, so one firm can never read another’s data.</li>
            <li>If you connect a mailbox, its access tokens are encrypted before being stored.</li>
            <li>You can erase your data or delete your account outright from the Account page. Signing out revokes the session on every device.</li>
          </ul>
        </section>

        <section className="sec-section">
          <h3 className="sec-h3">When AI is used — and what it sees</h3>
          <p className="sec-note">
            AI runs only when you ask it to. A file you never open in an AI tool is never sent
            anywhere. What does get sent goes to the providers’ <strong>business APIs</strong>, whose
            terms exclude your data from training their models; it is held roughly 30 days for abuse
            monitoring and then deleted.
          </p>
          <div className="sec-models">
            {MODELS.map((m) => (
              <div className={`sec-model${m.optional ? ' is-optional' : ''}`} key={m.name}>
                <div className="sec-model-head">
                  <span className="sec-model-name">{m.name}</span>
                  <span className="sec-model-by">{m.by}</span>
                  {m.optional && <span className="sec-model-tag">Off by default</span>}
                </div>
                <p className="sec-model-used">{m.used}</p>
                <p className="sec-model-sees">Sees: {m.sees}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="sec-section">
          <h3 className="sec-h3">GDPR</h3>
          <ul className="sec-list">
            <li>Data is processed in the EU, and you decide what leaves your machine.</li>
            <li>Access, correction, export and erasure are all available from the Account page.</li>
            <li>A Data Processing Agreement is available for firms that need one on file.</li>
          </ul>
        </section>

        <div className="sec-actions">
          <button type="button" className="sec-link" onClick={() => openExternal(TERMS_URL)}>Terms of Service</button>
          <button type="button" className="sec-link" onClick={() => openExternal(PRIVACY_URL)}>Privacy Policy</button>
          <button type="button" className="sec-link" onClick={() => openExternal(GDPR_URL)}>GDPR</button>
          <button type="button" className="sec-link" onClick={() => openExternal(DPA_URL)}>DPA</button>
          <button type="button" className="sec-link" onClick={() => openExternal(SECURITY_URL)}>Security</button>
        </div>
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { askProjectAi } from '../lib/projectAi';
import { isElectron } from '../lib/platform';
import { miniHeaderSpot } from '../lib/miniHeaderSpot';
import MiniHeaderFade from '../components/MiniHeaderFade';
import {
  getMailStatus, beginMailOAuth, completeMailOAuth, listMail, sendMail, disconnectMail,
} from '../lib/mail';
import Tooltip from '../components/Tooltip';
import { MAIL_PROVIDERS, PROVIDER_LABELS, hueForSender } from './mailData';
import './Mail.css';

// Mail — the personal Mail tab (sits next to Debug in the top app-nav). The user
// connects a real Gmail / Outlook mailbox; DocVex fetches the live inbox and
// drafts an AI reply to each message in their voice. Every draft has the two
// primary actions from the design — Send and Regenerate — plus inline edit,
// tone/length controls, the AI's reasoning, and Archive (local dismiss).
//
// Real data path: lib/mail.js → the mail-sync edge function → Gmail / Microsoft
// Graph. AI drafting → askProjectAi (the project-ai edge function / Claude).

/* ── Icons ─────────────────────────────────────────────────────────────── */
const IcSparkle = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" /></svg>);
const IcSend = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" /></svg>);
const IcRefresh = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>);
const IcArchive = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" /><path d="M10 12h4" /></svg>);
const IcCheck = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="20 6 9 17 4 12" /></svg>);
const IcChevron = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="6 9 12 15 18 9" /></svg>);
const IcShield = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>);

/* ── Helpers ───────────────────────────────────────────────────────────── */
function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function initialsFor(name, email) {
  const src = (name || email || '?').trim();
  const parts = src.split(/[\s.@]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}
function replySubject(subject) {
  const s = (subject || '').trim();
  return /^re:/i.test(s) ? s : `Re: ${s || '(no subject)'}`;
}

const TONES = ['Formal', 'Friendly', 'Concise'];
const LENGTHS = ['Shorter', 'Standard', 'Longer'];

// Generate a reply (and the AI's "read" of the message) via live Claude. Returns
// { reasoning: string[], draft: string }. Asks for strict JSON so we get both in
// one call; falls back to treating the whole response as the draft.
async function generateReply({ email, tone, length, signature }) {
  const lenHint = {
    Shorter: 'Keep it short — 2 to 3 sentences, no filler.',
    Standard: 'Use a normal email length — a short paragraph or two.',
    Longer: 'You may be a little more thorough — cover each point explicitly.',
  }[length];
  const toneHint = {
    Formal: 'Professional and measured; no contractions where it reads cleaner without them.',
    Friendly: 'Warm and personable while still professional.',
    Concise: 'Direct and efficient; lead with the answer.',
  }[tone];

  const prompt =
`You are drafting an email reply on behalf of ${signature}. Reply to the email below.

Return ONLY a JSON object, no prose, no code fences, of the exact shape:
{"reasoning": ["<short bullet of what the sender wants / asks / deadlines>", "..."], "draft": "<the full reply body>"}

Rules for "draft": write ONLY the reply body — no subject line, no surrounding quotes. Tone: ${tone}. ${toneHint} Length: ${length}. ${lenHint} Sign off as ${signature}. Address every concrete ask. Do not invent specific facts, prices, or legal advice; keep commitments general where details aren't given.
Rules for "reasoning": 2 to 3 short bullets summarising what you picked up from the email.

--- EMAIL FROM ${email.from.name} <${email.from.email}> ---
Subject: ${email.subject}

${(email.body || email.snippet || '').slice(0, 6000)}
--- END EMAIL ---`;

  // usageProject: null — Mail is a personal tab, so its drafting tokens don't
  // belong on whatever project happens to be selected.
  const { text, error } = await askProjectAi({ messages: [{ role: 'user', content: prompt }], projectName: '', fileNames: [], usageProject: null });
  if (error) return { reasoning: [], draft: '', error };

  let raw = (text || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) raw = raw.slice(start, end + 1);
  try {
    const obj = JSON.parse(raw);
    const reasoning = Array.isArray(obj.reasoning) ? obj.reasoning.map((s) => String(s)).filter(Boolean).slice(0, 4) : [];
    const draft = String(obj.draft || '').trim();
    if (draft) return { reasoning, draft };
  } catch { /* not JSON — fall through */ }
  return { reasoning: [], draft: (text || '').trim() };
}

/* ── Segmented control ─────────────────────────────────────────────────── */
function Segmented({ options, value, onChange, disabled }) {
  return (
    <div className="mx-seg" role="group">
      {options.map((o) => (
        <button key={o} type="button" className={`mx-seg-btn${value === o ? ' is-on' : ''}`} onClick={() => onChange(o)} disabled={disabled}>{o}</button>
      ))}
    </div>
  );
}

/* ── Auto-growing draft textarea ───────────────────────────────────────── */
function DraftEditor({ value, onChange, disabled }) {
  const ref = useRef(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useEffect(() => { fit(); }, [value, fit]);
  return (
    <textarea ref={ref} className="mx-draft-text" value={value} disabled={disabled} spellCheck={false}
      onChange={(e) => { onChange(e.target.value); fit(); }} onInput={fit} />
  );
}

/* ── AI draft block ────────────────────────────────────────────────────── */
function DraftBlock({ email, status, onSend, onArchive, onUndo, signature }) {
  const [tone, setTone] = useState('Friendly');
  const [length, setLength] = useState('Standard');
  const [text, setText] = useState('');
  const [reasoning, setReasoning] = useState([]);
  const [busy, setBusy] = useState(true);
  const [genError, setGenError] = useState(false);
  const [edited, setEdited] = useState(false);
  const [sending, setSending] = useState(false);
  const [showWhy, setShowWhy] = useState(true);
  const reqId = useRef(0);

  const regenerate = useCallback(async (nextTone, nextLength) => {
    const id = ++reqId.current;
    setBusy(true); setGenError(false);
    const { reasoning: r, draft, error } = await generateReply({
      email, tone: nextTone ?? tone, length: nextLength ?? length, signature,
    });
    if (id !== reqId.current) return;
    if (error || !draft) { setGenError(true); setBusy(false); return; }
    setReasoning(r); setText(draft); setEdited(false); setBusy(false);
  }, [email, tone, length, signature]);

  // Draft once when the row first appears (real emails have no seed draft).
  useEffect(() => {
    if (status === 'pending') regenerate();
    else setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickTone = (t) => { setTone(t); regenerate(t, length); };
  const pickLength = (l) => { setLength(l); regenerate(tone, l); };

  const doSend = async () => {
    setSending(true);
    const ok = await onSend(text, tone);
    setSending(false);
    if (!ok) setGenError(true);
  };

  if (status === 'sent') {
    return (
      <div className="mx-sent">
        <span className="mx-sent-badge"><IcCheck width="13" height="13" /> Sent</span>
        <span className="mx-sent-text">Reply delivered to {email.from.name} · {tone.toLowerCase()} tone</span>
        <button type="button" className="mx-linkbtn" onClick={onUndo}>Undo</button>
      </div>
    );
  }
  if (status === 'archived') {
    return (
      <div className="mx-sent is-archived">
        <span className="mx-sent-badge is-muted"><IcArchive width="13" height="13" /> Archived</span>
        <span className="mx-sent-text">No reply drafted</span>
        <button type="button" className="mx-linkbtn" onClick={onUndo}>Undo</button>
      </div>
    );
  }

  const working = busy || sending;
  return (
    <div className="mx-draft mx-draft-card">
      <div className="mx-card-head">
        <div className="mx-ai-byline">
          <span className="mx-ai-chip"><IcSparkle width="12" height="12" /> AI draft</span>
          {edited && <span className="mx-edited-flag">· edited by you</span>}
        </div>
        {reasoning.length > 0 && (
          <div className={`mx-why${showWhy ? ' is-open' : ''}`}>
            <button type="button" className="mx-why-toggle" onClick={() => setShowWhy((v) => !v)}>
              <IcChevron width="13" height="13" className="mx-why-caret" />
              What the AI picked up
            </button>
            {showWhy && <ul className="mx-why-list">{reasoning.map((r, i) => <li key={i}>{r}</li>)}</ul>}
          </div>
        )}
      </div>

      {genError && !busy ? (
        <div className="mx-draft-error">
          Couldn’t draft a reply right now.
          <button type="button" className="mx-linkbtn" onClick={() => regenerate()}>Try again</button>
        </div>
      ) : (
        <div className="mx-draft-editor-wrap">
          {working && (
            <div className="mx-draft-loading">
              <span className="mx-spark-pulse"><IcSparkle width="15" height="15" /></span>
              {sending ? 'Sending…' : `Drafting a ${tone.toLowerCase()} reply…`}
            </div>
          )}
          <DraftEditor value={text} disabled={working} onChange={(v) => { setText(v); setEdited(true); }} />
        </div>
      )}

      <div className="mx-card-foot">
        <div className="mx-controls">
          <div className="mx-control-grp">
            <span className="mx-control-label">Tone</span>
            <Segmented options={TONES} value={tone} onChange={pickTone} disabled={working} />
          </div>
          <div className="mx-control-grp">
            <span className="mx-control-label">Length</span>
            <Segmented options={LENGTHS} value={length} onChange={pickLength} disabled={working} />
          </div>
        </div>
        <div className="mx-actions">
          <button type="button" className="mx-btn mx-btn-primary" onClick={doSend} disabled={working || !text.trim()}>
            <IcSend width="15" height="15" /> Send reply
          </button>
          <button type="button" className="mx-btn mx-btn-ghost" onClick={() => regenerate()} disabled={working}>
            <IcRefresh width="15" height="15" /> Regenerate
          </button>
          <button type="button" className="mx-btn mx-btn-quiet" onClick={onArchive} disabled={working}>
            <IcArchive width="15" height="15" /> Archive
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Inbox row ─────────────────────────────────────────────────────────── */
function MailRow({ email, status, onSetStatus, signature, onSend }) {
  const hue = hueForSender((email.from.email || '').split('@')[1] || email.from.email);
  const isDone = status === 'sent' || status === 'archived';
  const lines = (email.body || email.snippet || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <li className={`mx-row${isDone ? ' is-done' : ''}`}>
      <div className="mx-body">
        <div className="mx-sender">
          <span className="mx-avatar" style={{ background: hue }}>{initialsFor(email.from.name, email.from.email)}</span>
          <span className="mx-sender-name">{email.from.name || email.from.email}</span>
          <span className="mx-sender-email">{email.from.email}</span>
          {email.unread && status === 'pending' && <span className="mx-rail-prio">Needs reply</span>}
          <span className="mx-rail-time">{timeAgo(email.receivedAt)}</span>
        </div>
        <h2 className="mx-subject">{email.subject}</h2>
        <div className="mx-incoming">
          {lines.slice(0, 3).map((p, i) => <p key={i}>{p}</p>)}
          {lines.length > 3 && <span className="mx-incoming-more">…</span>}
        </div>
        <DraftBlock
          email={email}
          status={status}
          signature={signature}
          onSend={(text, tone) => onSend(email, text, tone)}
          onArchive={() => onSetStatus(email.id, 'archived')}
          onUndo={() => onSetStatus(email.id, 'pending')}
        />
      </div>
    </li>
  );
}

/* ── Connect screen ────────────────────────────────────────────────────── */
function ConnectScreen({ connecting, error, onConnect }) {
  return (
    <div className="mx-connect">
      <div className="mx-connect-eyebrow">
        <span>DocVex Mail</span>
        <span className="mx-connect-eyebrow-muted">· Beta</span>
      </div>
      <h1 className="mx-connect-title">Mail</h1>
      <p className="mx-connect-lead">
        Connect a mailbox and DocVex reads incoming mail, drafts a reply for each one in your
        voice, and waits. Every draft has two buttons: <strong>Send</strong> or <strong>Regenerate</strong>.
        Nothing leaves your account until you say so.
      </p>
      {error && <div className="mx-connect-error">{error}</div>}
      <div className="mx-providers">
        {MAIL_PROVIDERS.map((p) => (
          <Tooltip key={p.id} content={p.enabled ? '' : 'Coming soon'}>
            <button type="button"
              className={`mx-provider${connecting === p.id ? ' is-connecting' : ''}`}
              onClick={() => p.enabled && onConnect(p)}
              disabled={!p.enabled || !!connecting}
            >
              <span className="mx-provider-glyph">{p.glyph}</span>
              <span className="mx-provider-text">
                <span className="mx-provider-name">{connecting === p.id ? `Connecting to ${p.name}…` : `Connect ${p.name}`}</span>
                <span className="mx-provider-sub">{p.sub}</span>
              </span>
              {connecting === p.id ? <span className="mx-provider-spin" /> : <IcChevron width="16" height="16" className="mx-provider-arrow" />}
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="mx-connect-note">
        <IcShield width="15" height="15" />
        <span>DocVex requests read + send access so it can draft replies. Drafts are generated on demand and never sent automatically — you press Send. Disconnect any time.</span>
      </div>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Needs reply' },
  { id: 'sent', label: 'Sent' },
  { id: 'archived', label: 'Archived' },
];

export default function Mail() {
  const { session } = useAuth();
  const user = session?.user;
  const signature = (user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || 'me').split(' ')[0];

  const [statusLoading, setStatusLoading] = useState(true);
  const [conn, setConn] = useState({ connected: false, provider: null, email: null });
  const [connecting, setConnecting] = useState(null);
  const [connectError, setConnectError] = useState('');

  const [messages, setMessages] = useState([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxError, setInboxError] = useState('');

  const [statuses, setStatuses] = useState({}); // id → pending|sent|archived
  const setStatus = (id, st) => setStatuses((s) => ({ ...s, [id]: st }));
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');

  const refreshInbox = useCallback(async () => {
    setInboxLoading(true); setInboxError('');
    const { messages: msgs, error } = await listMail();
    if (error) {
      // The mailbox grant was revoked/expired — the server dropped the dead
      // connection, so fall back to the connect screen instead of looping.
      if (error.message === 'reauth_required') {
        setConn({ connected: false, provider: null, email: null });
        setConnectError('Your mailbox session expired — please reconnect.');
        setMessages([]);
        setInboxLoading(false);
        return;
      }
      if (error.message !== 'not_connected') setInboxError('Couldn’t load your inbox. Try refreshing.');
    }
    setMessages(msgs || []);
    setInboxLoading(false);
  }, []);

  // Initial connection status (then load the inbox if connected).
  useEffect(() => {
    let alive = true;
    (async () => {
      setStatusLoading(true);
      const s = await getMailStatus();
      if (!alive) return;
      setConn({ connected: s.connected, provider: s.provider, email: s.email });
      setStatusLoading(false);
      if (s.connected) refreshInbox();
    })();
    return () => { alive = false; };
  }, [refreshInbox]);

  // Complete the OAuth round-trip when the code comes back.
  const handleCode = useCallback(async (provider, code, nonce) => {
    const { ok, email, provider: prov, error } = await completeMailOAuth({ provider, code, nonce });
    setConnecting(null);
    if (!ok) {
      const c = error?.message;
      setConnectError(
        c === 'provider_not_configured' ? 'That provider isn’t configured yet.'
          : c === 'invalid_state' ? 'That sign-in link expired. Please try connecting again.'
            : 'Couldn’t finish connecting. Please try again.',
      );
      return;
    }
    setConnectError('');
    setConn({ connected: true, provider: prov || provider, email });
    refreshInbox();
  }, [refreshInbox]);

  // Electron: AuthContext re-broadcasts docvex://mail/callback as a window event.
  useEffect(() => {
    if (!isElectron) return undefined;
    const onCallback = (e) => {
      let parsed; try { parsed = new URL(e.detail); } catch { return; }
      const code = parsed.searchParams.get('code');
      const err = parsed.searchParams.get('error');
      const nonce = parsed.searchParams.get('nonce') || '';
      const provider = parsed.searchParams.get('provider') || sessionStorage.getItem('docvex.mail.pendingProvider') || 'gmail';
      if (err || !code) { setConnecting(null); setConnectError('Authorization was cancelled.'); return; }
      handleCode(provider, code, nonce);
    };
    window.addEventListener('docvex:mail-callback', onCallback);
    return () => window.removeEventListener('docvex:mail-callback', onCallback);
  }, [handleCode]);

  // Web: the callback bridge lands us back at /mail?mailcode=…&provider=…&nonce=….
  useEffect(() => {
    if (isElectron) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('mailcode');
    if (!code) return;
    const provider = params.get('provider') || sessionStorage.getItem('docvex.mail.pendingProvider') || 'gmail';
    const nonce = params.get('nonce') || '';
    // Strip the query so a refresh doesn't re-run the exchange.
    const clean = window.location.pathname + window.location.hash;
    window.history.replaceState({}, '', clean);
    handleCode(provider, code, nonce);
  }, [handleCode]);

  const startConnect = async (provider) => {
    setConnecting(provider.id); setConnectError('');
    const { error, code } = await beginMailOAuth(provider.id);
    if (error) {
      setConnecting(null);
      setConnectError(code === 'provider_not_configured'
        ? `${provider.name} isn’t configured yet — add the OAuth credentials in Supabase.`
        : 'Couldn’t start the connection. Please try again.');
    }
  };

  const disconnect = async () => {
    await disconnectMail();
    setConn({ connected: false, provider: null, email: null });
    setMessages([]); setStatuses({});
  };

  // Send a reply through the connected provider, then collapse the row.
  const sendReply = async (email, text) => {
    const { ok } = await sendMail({
      to: email.from.email,
      subject: replySubject(email.subject),
      body: text,
      threadId: email.threadId,
    });
    if (ok) setStatus(email.id, 'sent');
    return ok;
  };

  const pendingCount = messages.filter((m) => (statuses[m.id] || 'pending') === 'pending').length;
  const sentCount = messages.filter((m) => statuses[m.id] === 'sent').length;

  const visible = useMemo(() => messages.filter((m) => {
    const st = statuses[m.id] || 'pending';
    if (filter === 'pending' && st !== 'pending') return false;
    if (filter === 'sent' && st !== 'sent') return false;
    if (filter === 'archived' && st !== 'archived') return false;
    if (query.trim()) {
      const q = query.toLowerCase();
      const hay = `${m.from.name} ${m.from.email} ${m.subject} ${m.body || m.snippet}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [messages, statuses, filter, query]);

  // Compact sticky header — fades/slides in once the big "Mail" title scrolls
  // away (mirrors the Versions tab). Listen on the single-pane scroller; rebind
  // when the connected view (re)mounts so pageRef points at the live root.
  const pageRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const scroller = pageRef.current?.closest('.sv-single-scroll, .main-content');
    if (!scroller) return undefined;
    const onScroll = () => {
      const top = scroller.scrollTop;
      setScrolled((s) => (s ? top > 8 : top > 32));
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [conn.connected, statusLoading]);
  const scrollToTop = () => {
    const scroller = pageRef.current?.closest('.sv-single-scroll, .main-content');
    scroller?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (!session) {
    return (
      <div className="mx-page"><div className="mx-empty">
        <div className="mx-empty-title">Sign in to use Mail</div>
        <div className="mx-empty-sub"><Link to="/auth" className="mx-linkbtn">Go to sign in</Link></div>
      </div></div>
    );
  }

  if (statusLoading) {
    return <div className="mx-page"><div className="mx-empty"><div className="mx-empty-sub">Checking your mailbox…</div></div></div>;
  }

  if (!conn.connected) {
    return (
      <div className="mx-page">
        <ConnectScreen connecting={connecting} error={connectError} onConnect={startConnect} />
        {/* Dev-only: skip the OAuth gate so the Mail UI is reachable without a
            linked mailbox (empty inbox). Not built in packaged/web releases. */}
        {import.meta.env.DEV && (
          <div style={{ textAlign: 'center', paddingBottom: 32 }}>
            <button
              type="button"
              onClick={() => setConn({ connected: true, provider: 'gmail', email: 'debug@local' })}
              style={{
                font: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)',
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '6px 12px', cursor: 'pointer',
              }}
            >
              Debug: open Mail without linking
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-page" ref={pageRef}>
      {/* Compact header — fades/slides in once the big "Mail" title scrolls
          away, mirroring the Versions tab. Fixed to the content area. */}
      <MiniHeaderFade visible={scrolled} />
      <div className={`mx-compact mini-glow${scrolled ? ' is-visible' : ''}`} aria-hidden={!scrolled} onMouseMove={miniHeaderSpot}>
        <span className="mini-head-text">
          <span className="mx-compact-title">Mail</span>
          <span className="mx-compact-sep" aria-hidden="true">·</span>
          <span className="mx-compact-eyebrow">AI inbox</span>
        </span>
        <Tooltip content="Back to top">
          <button
            type="button"
            className={`mx-compact-status mini-head-status${pendingCount > 0 ? ' is-pending' : ''}`}
            onClick={scrollToTop}
          >
            <span className="mx-compact-dot" aria-hidden="true" />
            {pendingCount > 0 ? `${pendingCount} awaiting` : 'All caught up'}
          </button>
        </Tooltip>
      </div>
      <header className="mx-mast">
        <div className="mx-mast-left">
          <div className="mx-mast-eyebrow">
            <span>DocVex Mail</span>
            <span className="mx-mast-muted">· {PROVIDER_LABELS[conn.provider] || 'Mailbox'} · {conn.email}</span>
          </div>
          <h1 className="mx-mast-title">Mail</h1>
          <p className="mx-mast-kicker">
            AI-drafted replies for your connected mailbox — <strong>{PROVIDER_LABELS[conn.provider] || 'Mailbox'}</strong>
            {pendingCount > 0
              ? <>. <strong>{pendingCount} {pendingCount === 1 ? 'message' : 'messages'}</strong> awaiting your review.</>
              : <>. You're all caught up.</>}
          </p>
        </div>
        <div className="mx-mast-meta">
          <div><div className="mx-mast-num">{pendingCount}</div><div>Awaiting</div></div>
          <span className="mx-mast-sep" />
          <div><div className="mx-mast-num">{sentCount}</div><div>Sent</div></div>
          <span className="mx-mast-sep" />
          <div className="mx-mast-tools">
            <Tooltip content="Refresh inbox">
              <button type="button" className="mx-tool-btn" onClick={refreshInbox} disabled={inboxLoading} aria-label="Refresh inbox">
                <IcRefresh width="15" height="15" />
              </button>
            </Tooltip>
            <Tooltip content="Disconnect mailbox">
              <button type="button" className="mx-tool-btn mx-tool-danger" onClick={disconnect}>Disconnect</button>
            </Tooltip>
          </div>
        </div>
      </header>

      <p className="mx-weekly">
        <span className="mx-weekly-mark">AI inbox</span>
        <span>
          {pendingCount > 0
            ? <>DocVex drafts a reply in your voice for each message — read it, then <strong>Send</strong> or <strong>Regenerate</strong>, adjusting tone and length inline.</>
            : <>You're all caught up — every message has been handled. Refresh to pull new mail.</>}
        </span>
      </p>

      <div className="mx-filters">
        <div className="mx-filter-group">
          <span className="mx-filter-label">Show</span>
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={`mx-filter-btn${filter === f.id ? ' is-active' : ''}`} onClick={() => setFilter(f.id)}>
              {f.label}
              {f.id === 'pending' && pendingCount > 0 && <span className="mx-filter-count">·{pendingCount}</span>}
            </button>
          ))}
        </div>
        <div className="mx-search">
          <input type="text" placeholder="Search mail…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search mail" />
        </div>
      </div>

      {inboxError && <div className="mx-connect-error">{inboxError}</div>}

      {inboxLoading && messages.length === 0 ? (
        <div className="mx-empty"><div className="mx-empty-sub">Loading your inbox…</div></div>
      ) : visible.length === 0 ? (
        <div className="mx-empty">
          <div className="mx-empty-title">Nothing here</div>
          <div className="mx-empty-sub">{query ? 'No mail matches your search.' : 'No messages in this view.'}</div>
        </div>
      ) : (
        <section className="mx-section">
          <header className="mx-section-head">
            <h2 className="mx-section-title">{filter === 'all' ? 'Inbox' : FILTERS.find((f) => f.id === filter).label}</h2>
            <span className="mx-section-rule" />
            <span className="mx-section-meta">{visible.length} {visible.length === 1 ? 'message' : 'messages'}</span>
          </header>
          <ul className="mx-list">
            {visible.map((m) => (
              <MailRow key={m.id} email={m} status={statuses[m.id] || 'pending'} onSetStatus={setStatus} signature={signature} onSend={sendReply} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

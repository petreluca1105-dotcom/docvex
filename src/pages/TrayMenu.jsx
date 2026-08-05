import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { getRecentMap } from '../lib/recentProjects';
import { formatRelativeTime } from '../lib/notifications';
import './TrayMenu.css';

// The system-tray menu (Windows notification area / macOS menu bar), drawn by
// the app instead of the OS. A native `Menu.buildFromTemplate` can't carry the
// theme tokens, the status header, or the recent-projects flyout — this rides
// in a small transparent always-on-top window (?trayMenu=1 → /tray-menu) that
// main.js anchors to the tray icon and hides on blur.
//
// Every row hands its action to main over `tray:action`; main runs it (raise
// the window, open a route, snip, relaunch, quit) and hides this window. The
// menu itself owns no app state beyond what it shows.
//
// Layout mirrors the OS convention: a status header, then grouped rows split
// by hairlines, each row = icon · label · optional accelerator / flyout arrow.

const DOCS_URL = 'https://docvex.ro/';
const MAX_RECENTS = 5;
// The window is ALWAYS card + flyout wide. Resizing it when the submenu opens
// (which is what the first version did) repaints a transparent always-on-top
// window on every hover — it reads as flicker/tearing. So the extra width is
// permanent, invisible apron; a click on it dismisses, like clicking outside a
// menu. Only the height is reported, and only when the row count changes.
// Keep in sync with .tm-card / .tm-flyout in TrayMenu.css.
const CARD_W = 244;
const FLYOUT_W = 186;
const FLYOUT_GAP = 5;
const WINDOW_W = CARD_W + FLYOUT_W + FLYOUT_GAP;

// Inline stroke icons (app convention — no icon library). 16px box, drawn at
// the row's currentColor so they inherit hover / disabled states.
const ico = (paths) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths}
  </svg>
);
const IconWindow = ico(<><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 9h18" /></>);
const IconUser = ico(<><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.7-3.6 3.5-5.5 7-5.5s6.3 1.9 7 5.5" /></>);
const IconClock = ico(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.2V12l3.2 2" /></>);
// Same "scan text" glyph the Doc Viewer + snip launcher use for Extract text.
const IconScan = ico(<><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 9h10" /><path d="M7 13h7" /><path d="M7 17h4" /></>);
const IconGear = ico(<><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>);
const IconFlag = ico(<><path d="M5 21V4.5" /><path d="M5 5.2h11l-1.7 3.4L16 12H5" /></>);
const IconBook = ico(<><path d="M2.5 4h5a3.5 3.5 0 0 1 3.5 3.5V20a2.5 2.5 0 0 0-2.5-2.5h-6z" /><path d="M21.5 4h-5A3.5 3.5 0 0 0 13 7.5V20a2.5 2.5 0 0 1 2.5-2.5h6z" /></>);
const IconInfo = ico(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5" /><circle cx="12" cy="8" r="0.6" fill="currentColor" /></>);
const IconDownload = ico(<><path d="M12 4v10" /><path d="m8 11 4 4 4-4" /><path d="M5 19h14" /></>);
const IconRestart = ico(<><path d="M20 5.5v5h-5" /><path d="M19.4 13a7.5 7.5 0 1 1-1.6-6.4L20 9" /></>);
const IconPower = ico(<><path d="M12 3.5v8" /><path d="M17.5 6.8a7.5 7.5 0 1 1-11 0" /></>);
const IconFolder = ico(<><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.4h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17z" /></>);
const IconChevron = (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 5 7 7-7 7" />
  </svg>
);

function displayNameOf(user) {
  const meta = user?.user_metadata;
  return meta?.full_name || meta?.name || user?.email || '';
}

export default function TrayMenu() {
  const { session } = useAuth();
  const api = typeof window !== 'undefined' ? window.electronAPI : null;

  // App facts main owns (version, packaged, updater state) + which edge the
  // tray sits on, so the card can animate from the right corner.
  const [info, setInfo] = useState({ version: '', isPackaged: false, updateState: 'idle', anchor: 'bottom' });
  // Bumped on every re-open so the recent list re-reads and the card replays
  // its entrance animation (the window is reused, not recreated).
  const [openCount, setOpenCount] = useState(0);
  const [flyOpen, setFlyOpen] = useState(false);
  const [flyTop, setFlyTop] = useState(8);
  // Keyboard cursor over the flattened row list (-1 = mouse-only, no ring).
  const [cursor, setCursor] = useState(-1);

  const cardRef = useRef(null);
  const flyRef = useRef(null);

  const close = useCallback(() => { api?.trayMenuClose?.(); }, [api]);
  const act = useCallback((action, payload) => {
    api?.trayMenuAction?.(action, payload);
  }, [api]);

  // Pull state on mount and again each time the tray re-opens the window.
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const next = await api?.getTrayMenuState?.();
        if (alive && next) setInfo((prev) => ({ ...prev, ...next }));
      } catch { /* main not ready — the card just shows fewer facts */ }
    };
    pull();
    const off = api?.onTrayMenuOpened?.((payload) => {
      setFlyOpen(false);
      setCursor(-1);
      if (payload?.anchor) setInfo((prev) => ({ ...prev, anchor: payload.anchor }));
      // Force the next measurement to be SENT even if the card came out the
      // same height. Main keeps the window hidden until a size arrives, so a
      // suppressed "nothing changed" report would stall the open until the
      // fallback timer — and resizing after the window is already visible is
      // what made the menu look like it faded in twice.
      lastSent.current = 0;
      setOpenCount((n) => n + 1);
      pull();
    });
    return () => { alive = false; off?.(); };
  }, [api]);

  const userId = session?.user?.id || null;
  const recents = useMemo(() => {
    if (!userId) return [];
    const map = getRecentMap(userId);
    return Object.entries(map)
      .filter(([, e]) => e?.name)
      .sort((a, b) => (a[1].ts > b[1].ts ? -1 : a[1].ts < b[1].ts ? 1 : 0))
      .slice(0, MAX_RECENTS)
      .map(([id, e]) => ({ id, name: e.name, when: formatRelativeTime(e.ts) }));
  }, [userId, openCount]);

  // ── Row model ───────────────────────────────────────────────────────────
  // Groups render as hairline-separated sections; the flattened list drives
  // arrow-key navigation.
  const updateReady = info.updateState === 'downloaded';
  const groups = useMemo(() => [
    [
      { key: 'open', icon: IconWindow, label: 'Open DocVex', run: () => act('open') },
      session
        ? { key: 'account', icon: IconUser, label: 'Account', sub: displayNameOf(session.user), run: () => act('navigate', '/account') }
        : { key: 'signin', icon: IconUser, label: 'Sign in / Sign up', run: () => act('navigate', '/auth') },
      {
        key: 'recents',
        icon: IconClock,
        label: 'Recent projects',
        flyout: true,
        disabled: recents.length === 0,
      },
    ],
    [
      { key: 'extract', icon: IconScan, label: 'Extract text', run: () => act('extract') },
      { key: 'settings', icon: IconGear, label: 'Settings', hint: 'Ctrl+,', run: () => act('navigate', '/settings') },
      { key: 'report', icon: IconFlag, label: 'Report a problem', run: () => act('navigate', '@report') },
      { key: 'docs', icon: IconBook, label: 'Documentation', run: () => act('external', DOCS_URL) },
      { key: 'about', icon: IconInfo, label: 'About DocVex', run: () => act('navigate', '/versions') },
    ],
    [
      updateReady
        ? { key: 'install', icon: IconDownload, label: 'Restart & install update', accent: true, run: () => act('install-update') }
        : { key: 'check', icon: IconDownload, label: 'Check for updates', run: () => act('check-updates') },
      { key: 'restart', icon: IconRestart, label: 'Restart', run: () => act('restart') },
      { key: 'quit', icon: IconPower, label: 'Quit DocVex', danger: true, run: () => act('quit') },
    ],
  ], [act, session, recents.length, updateReady]);

  const flat = useMemo(() => groups.flat().filter((r) => !r.disabled), [groups]);

  // ── Window sizing ───────────────────────────────────────────────────────
  // The card measures itself and main resizes + re-anchors the window to it,
  // so the menu is exactly as tall as its rows. Width is constant (see
  // WINDOW_W) — a window resize while the pointer is inside the menu causes a
  // visible repaint, so the flyout must never trigger one. Measurements are
  // CSS px; the Settings display-scale applies webFrame zoom, so convert to
  // DIP for setBounds. Main holds the first paint until this arrives, which is
  // what stops the menu appearing clipped before it's been measured.
  const lastSent = useRef(0);
  const reportSize = useCallback(() => {
    const el = cardRef.current;
    if (!el || !api?.trayMenuResize) return;
    const z = api.getZoomFactor?.() || 1;
    const cardH = el.getBoundingClientRect().height;
    // +2 absorbs sub-pixel rounding: one pixel short and the card's top edge
    // is clipped, because it's anchored to the bottom of the window.
    const height = Math.ceil(cardH * z) + 2;
    // Re-send even at an unchanged height when the window is still too short
    // for the card — that's the self-heal for a setBounds that didn't take.
    const stillClipped = window.innerHeight + 1 < cardH;
    if (!height || (Math.abs(height - lastSent.current) < 1 && !stillClipped)) return;
    lastSent.current = height;
    api.trayMenuResize({ width: Math.ceil(WINDOW_W * z), height });
  }, [api]);

  useLayoutEffect(() => {
    reportSize();
    const el = cardRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(reportSize);
    ro.observe(el);
    // The window resizing is the signal to check whether it ended up big
    // enough; combined with `stillClipped` above this converges in one round
    // trip instead of leaving the menu clipped.
    window.addEventListener('resize', reportSize);
    // Web fonts land after first paint and change the card's height — measure
    // again once they're ready so the window isn't sized to the fallback font.
    document.fonts?.ready?.then(reportSize).catch(() => { /* no font API */ });
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', reportSize);
    };
  }, [reportSize, openCount]);

  // Keep the flyout inside the card's height — it opens at its row, then
  // slides up if it would hang off the bottom (the window is only as tall as
  // the card, so anything past that edge would be clipped away).
  useLayoutEffect(() => {
    if (!flyOpen) return;
    const card = cardRef.current;
    const fly = flyRef.current;
    if (!card || !fly) return;
    const maxTop = Math.max(8, card.getBoundingClientRect().height - fly.getBoundingClientRect().height - 8);
    setFlyTop((t) => Math.min(t, maxTop));
  }, [flyOpen, recents.length]);

  const openFlyoutAt = (e) => {
    const row = e.currentTarget;
    setFlyTop(Math.max(8, row.offsetTop - 6));
    setFlyOpen(true);
  };

  // ── Keys ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (flyOpen) { setFlyOpen(false); return; }
        close();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setCursor((c) => {
          const next = (c + step + flat.length) % (flat.length || 1);
          return Number.isFinite(next) ? next : 0;
        });
        return;
      }
      const row = flat[cursor];
      if (e.key === 'ArrowRight' && row?.flyout) { e.preventDefault(); setFlyOpen(true); return; }
      if (e.key === 'ArrowLeft' && flyOpen) { e.preventDefault(); setFlyOpen(false); return; }
      if (e.key === 'Enter' || e.key === ' ') {
        if (!row) return;
        e.preventDefault();
        if (row.flyout) setFlyOpen(true);
        else row.run?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flat, cursor, flyOpen, close]);

  // ── Status header ───────────────────────────────────────────────────────
  const status = info.updateState === 'downloaded'
    ? { tone: 'warn', text: 'Update ready — restart to install' }
    : info.updateState === 'downloading'
      ? { tone: 'busy', text: 'Downloading update…' }
      : session
        ? { tone: 'ok', text: 'DocVex is running' }
        : { tone: 'idle', text: 'Not signed in' };

  let flatIndex = -1;

  return (
    // The window is a little wider than the card while the flyout is open —
    // a click on that empty apron dismisses, like clicking outside a menu.
    <div className="tm-root" data-anchor={info.anchor} onMouseDown={close}>
      <div className="tm-shell" onMouseDown={(e) => e.stopPropagation()}>
        {/* No key={openCount} remount: re-creating the card replayed its
            entrance on every open, on top of the OS's own window animation. */}
        <div className="tm-card" ref={cardRef} role="menu" aria-label="DocVex tray menu">
          <div className={`tm-head tone-${status.tone}`}>
            <span className="tm-dot" aria-hidden="true" />
            <span className="tm-head-text">{status.text}</span>
            {info.version && <span className="tm-version">v{info.version}</span>}
          </div>

          {groups.map((rows, gi) => (
            <div className="tm-group" key={gi}>
              {rows.map((row) => {
                if (!row.disabled) flatIndex += 1;
                const idx = row.disabled ? -1 : flatIndex;
                const cls = [
                  'tm-item',
                  row.danger ? 'is-danger' : '',
                  row.accent ? 'is-accent' : '',
                  row.disabled ? 'is-disabled' : '',
                  row.flyout && flyOpen ? 'is-open' : '',
                  idx >= 0 && idx === cursor ? 'is-cursor' : '',
                ].filter(Boolean).join(' ');
                return (
                  <button
                    key={row.key}
                    type="button"
                    role="menuitem"
                    className={cls}
                    disabled={row.disabled}
                    aria-haspopup={row.flyout ? 'menu' : undefined}
                    aria-expanded={row.flyout ? flyOpen : undefined}
                    onMouseEnter={(e) => {
                      setCursor(idx);
                      if (row.flyout && !row.disabled) openFlyoutAt(e);
                      else setFlyOpen(false);
                    }}
                    onClick={(e) => { if (row.flyout) openFlyoutAt(e); else row.run?.(); }}
                  >
                    <span className="tm-ico">{row.icon}</span>
                    <span className="tm-label">
                      {row.label}
                      {row.sub && <span className="tm-sub">{row.sub}</span>}
                    </span>
                    {row.hint && <span className="tm-hint">{row.hint}</span>}
                    {row.flyout && <span className="tm-arrow">{IconChevron}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {flyOpen && recents.length > 0 && (
          <div className="tm-flyout" ref={flyRef} style={{ top: flyTop }} role="menu" aria-label="Recent projects">
            {recents.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                className="tm-item"
                onClick={() => act('navigate', `/projects/${p.id}`)}
              >
                <span className="tm-ico">{IconFolder}</span>
                <span className="tm-label">
                  {p.name}
                  {p.when && <span className="tm-sub">{p.when}</span>}
                </span>
              </button>
            ))}
            <div className="tm-group">
              <button type="button" role="menuitem" className="tm-item" onClick={() => act('navigate', '/projects')}>
                <span className="tm-ico">{IconWindow}</span>
                <span className="tm-label">All projects…</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

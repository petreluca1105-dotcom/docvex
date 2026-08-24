import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { PaneChromeProvider, usePaneChromeSlotValue, usePaneChromePortalRef, usePaneChromeFooterRef } from '../context/PaneChromeContext';
import Tooltip from './Tooltip';
import './SplitView.css';

// Single-pane content shell for the main window. (The former multi-pane
// split-view system — vertical / horizontal / "T" / quad layouts plus the
// user-saved "custom layouts" presets — was removed; the app now always renders
// ONE pane.) Navigation lives in the app's vertical sidebar; this shell keeps
// the in-content chrome the pages rely on: a header bar that pages portal their
// description/toolbar into (PaneChrome + PaneChromeContext), and a footer
// (PaneFooter) for things like the chat composer.

function RefreshIcon() {
  return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>;
}

// Side-rail icons — stroke style matches the DocVex hub's sidebar nav icons
// (currentColor stroke, 18px, so they inherit hover/active colour).
const Svg = (p) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p} />;
const NAV_ICONS = {
  dashboard: <Svg><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></Svg>,
  files: <Svg><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Svg>,
  chat: <Svg><path d="M21 11.5a8.38 8.38 0 0 1-9 8.5 9 9 0 0 1-4-1L3 21l1.5-4a8.5 8.5 0 0 1 4-11.5 8.38 8.38 0 0 1 12.5 6z" /></Svg>,
  events: <Svg><circle cx="6" cy="19" r="3" /><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" /><circle cx="18" cy="5" r="3" /></Svg>,
  ai: <Svg><path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z" /><path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z" /></Svg>,
  activity: <Svg><path d="M3 12h4l3 8 4-16 3 8h4" /></Svg>,
  projects: <Svg><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M3 11h18" /></Svg>,
  versions: <Svg><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></Svg>,
  newsletter: <Svg><path d="M4 4h13a1 1 0 0 1 1 1v13a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2z" /><line x1="8" y1="8" x2="14" y2="8" /><line x1="8" y1="12" x2="14" y2="12" /><line x1="8" y1="16" x2="11" y2="16" /></Svg>,
  account: <Svg><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>,
};

// Destinations the in-pane navigation offers. Mirrors ONLY the sidebar's
// Projects-section navigation (the selected project's pages) when a project is
// selected; with none selected it falls back to the top-level destinations.
// Shared by the chrome's label resolution and the single-window side nav.
function paneDestinations(selectedProject) {
  return selectedProject?.id
    ? [
        { label: 'Files', to: '/files', icon: NAV_ICONS.files },
        { label: 'Chat', to: '/chat', icon: NAV_ICONS.chat },
        { label: 'Timeline', to: '/events', icon: NAV_ICONS.events },
        { label: 'Advisor', to: '/ai', icon: NAV_ICONS.ai },
        { label: 'Updates', to: '/versions', icon: NAV_ICONS.versions },
      ]
    : [
        { label: 'Activity', to: '/', icon: NAV_ICONS.activity },
        { label: 'Projects', to: '/projects', icon: NAV_ICONS.projects },
        { label: 'Versions', to: '/versions', icon: NAV_ICONS.versions },
        { label: 'Newsletter', to: '/newsletter', icon: NAV_ICONS.newsletter },
        { label: 'Account', to: '/account', icon: NAV_ICONS.account },
      ];
}

function PaneChrome({ onRefresh }) {
  const { pathname } = useLocation();
  const { selectedProject } = useSelectedProject();
  const slot = usePaneChromeSlotValue();
  const setPortalEl = usePaneChromePortalRef();

  const dests = paneDestinations(selectedProject);

  // Friendly label for the header. Prefer an exact match against the
  // destinations list, then resolve a bare /projects/:id (and its subroutes)
  // to the project NAME rather than showing the raw UUID. Falls back to the
  // path for anything unrecognised.
  const currentPath = pathname || '/';
  const projectMatch = currentPath.match(/^\/projects\/([^/]+)(\/.*)?$/);
  let destLabel = dests.find((d) => d.to === currentPath)?.label;
  if (!destLabel && projectMatch) {
    const [, idSeg, sub] = projectMatch;
    if (idSeg === 'new') {
      destLabel = 'New project';
    } else {
      const name = selectedProject?.id === idSeg ? selectedProject.name : 'Project';
      destLabel = !sub || sub === '/'
        ? name
        : `${name} · ${sub.replace(/^\//, '').replace(/\//g, ' · ')}`;
    }
  }
  if (!destLabel) destLabel = currentPath;

  // Short description for the current destination, shown after the title.
  const DEST_DESC = {
    '/': 'Activity & notifications',
    '/projects': 'All your projects',
    '/versions': 'Release history',
    '/newsletter': 'Legal newsfeed',
    '/account': 'Profile & settings',
    '/admin': 'Developer console',
    '/files': 'Project files & folders',
    '/chat': 'Team & private chat',
    '/events': 'Case timeline',
    '/ai': 'Project advisor',
    '/todos': 'Project to-dos',
    '/mail': 'AI-drafted replies',
    '/debug': 'Developer tools',
  };
  let destDesc = DEST_DESC[currentPath];
  if (!destDesc && projectMatch) {
    const sub = projectMatch[2];
    destDesc = !sub || sub === '/' ? 'Project overview' : sub === '/dashboard' ? 'Project dashboard' : 'Project';
  }
  // The routed page can publish a LIVE description + a search box into its
  // chrome via usePaneChromeSlot; prefer those over the static fallbacks.
  const description = slot?.description ?? destDesc;

  return (
    <div className="sv-chrome">
      {/* Row 1 — refresh + header. */}
      <div className="sv-chrome-row">
        {/* Refresh this window (top-left); also bound to F5. */}
        <Tooltip content="Refresh this window (F5)">
          <button
            type="button"
            className="sv-chrome-refresh"
            onClick={onRefresh}
            aria-label="Refresh this window"
          >
            <RefreshIcon />
          </button>
        </Tooltip>
        <div className="sv-chrome-head">
          <span className="sv-chrome-title">{destLabel}</span>
          {description && <span className="sv-chrome-dot" aria-hidden="true">·</span>}
          {description && <span className="sv-chrome-desc">{description}</span>}
        </div>
      </div>
      {/* Row 2 — portal target where the routed page renders its toolbar (folder
          nav + breadcrumb + search on Files); stays collapsed when empty. */}
      <div className="sv-chrome-row2" ref={setPortalEl} />
    </div>
  );
}

// Window footer — symmetric to PaneChrome but at the BOTTOM of the pane. The
// routed page portals content into it via usePaneChromeFooterEl (e.g. the chat
// composer). The element collapses (CSS `:empty`) when the page publishes
// nothing.
function PaneFooter() {
  const setFooterEl = usePaneChromeFooterRef();
  return <div className="sv-footer" ref={setFooterEl} />;
}

// Routes that render WITHOUT the in-content chrome bar — the personal
// destinations plus the Hub (/projects) and Account (/account). They each carry
// their own page masthead, so the chrome's title would just duplicate it.
const CHROMELESS_FULLSCREEN_ROUTES = new Set(['/', '/newsletter', '/versions', '/settings', '/debug', '/mail', '/admin', '/projects', '/account', '/files', '/chat', '/events', '/ai']);

// The project Overview / settings page (/projects/:id, no further segment) is
// also chromeless — it carries its own Versions-style masthead + compact
// on-scroll header, so the in-pane chrome bar (title + refresh) would just
// duplicate it. /projects, /projects/new, and deeper subroutes
// (/projects/:id/dashboard) are excluded.
function isProjectOverviewRoute(pathname) {
  const m = pathname.match(/^\/projects\/([^/]+)\/?$/);
  return !!m && m[1] !== 'new';
}

export default function ContentShell({ primary, fadeIn = false, onFadeInEnd, hubFadeIn = false, onHubFadeInEnd }) {
  const { pathname } = useLocation();
  // Bumping the nonce remounts the routed content (chrome refresh button + F5),
  // re-running the page's mount effects — i.e. a refresh.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const refresh = () => setRefreshNonce((n) => n + 1);

  // F5 refreshes the window content (and never the whole Electron app — we
  // swallow the key so the webContents doesn't hard-reload).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'F5' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        refresh();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Some fullscreen destinations carry their own page header, so the chrome bar
  // (title + refresh) is redundant noise there — suppress it. The app sidebar
  // still drives navigation.
  const chromeless = CHROMELESS_FULLSCREEN_ROUTES.has(pathname) || isProjectOverviewRoute(pathname);
  return (
    <div
      className={`sv-single${chromeless ? ' is-chromeless' : ''}${fadeIn ? ' is-switch-fade-in' : ''}${hubFadeIn ? ' is-hub-fade-in' : ''}`}
      onAnimationEnd={(fadeIn || hubFadeIn) ? (e) => {
        // Only react to OUR fade-in keyframes — child animations bubble here too.
        if (e.target !== e.currentTarget) return;
        if (e.animationName === 'svSwitchFadeIn') onFadeInEnd?.();
        if (e.animationName === 'svHubFadeIn') onHubFadeInEnd?.();
      } : undefined}
    >
      <div className="sv-single-body">
        <PaneChromeProvider>
          {!chromeless && <PaneChrome onRefresh={refresh} />}
          <div className="sv-single-scroll">
            <React.Fragment key={refreshNonce}>{primary}</React.Fragment>
          </div>
          <PaneFooter />
        </PaneChromeProvider>
      </div>
    </div>
  );
}

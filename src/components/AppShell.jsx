import React, { startTransition, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Outlet, useLocation, Navigate, useNavigate } from 'react-router-dom';
import { RouteFallback, preloadProjectList } from '../AppRoutes';
import { prefetchProjects } from '../lib/projectListPrefetch';
import Sidebar from './Sidebar';
import UpdateProgressBar from './UpdateProgressBar';
import UpdateRestartModal from './UpdateRestartModal';
import SwitchProjectLoader from './SwitchProjectLoader';
import ContentShell from './SplitView';
import CursorSpotlight from './CursorSpotlight';
import { useAuth } from '../context/AuthContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { isElectron } from '../lib/platform';
import { toLayoutPx } from '../lib/appZoom';
import './AppShell.css';

// Routes that operate on the currently-selected project. The banner shows on
// these so the user always sees which project they're working in. /projects
// (the browser list) and /projects/new are intentionally excluded — they're
// project-picker surfaces, not project-scoped views. The Project Overview
// (/projects/:id exact) is also excluded: that page already shows the
// project name as its <h1>, so a redundant "working in <name>" pill above it
// reads as noise. Sub-routes like /projects/:id/dashboard still get the pill
// because their <h1> is generic ("Dashboard") — the pill anchors which
// project the generic page is about.
export function isProjectScopedRoute(pathname) {
  if (pathname === '/files' || pathname.startsWith('/files/')) return true;
  if (pathname === '/clients' || pathname.startsWith('/clients/')) return true;
  if (pathname === '/todos' || pathname.startsWith('/todos/')) return true;
  if (pathname === '/chat' || pathname.startsWith('/chat/')) return true;
  if (pathname === '/events' || pathname.startsWith('/events/')) return true;
  if (pathname === '/generate' || pathname.startsWith('/generate/')) return true;
  if (pathname === '/automate' || pathname.startsWith('/automate/')) return true;
  if (pathname === '/ai' || pathname.startsWith('/ai/')) return true;
  if (pathname === '/projects' || pathname === '/projects/') return false;
  if (pathname === '/projects/new') return false;
  if (pathname.startsWith('/projects/')) {
    // Strip trailing slash, then check whether there's anything past the id.
    const rest = pathname.slice('/projects/'.length).replace(/\/$/, '');
    // Exact /projects/:id (no further segment) → Overview → no pill.
    if (rest && !rest.includes('/')) return false;
    return true;
  }
  return false;
}

// The sidebar's "Personal" section tabs (Activity / Newsletter / Versions).
// These all render their content full-bleed — no chrome frame (border / rounded
// corners / shadow) and no gaps around the content section — so they read as one
// consistent editorial surface. Keep in sync with Sidebar's personalItems.
// '/projects' (the Hub) is here too: it's a full-screen launcher with the rail
// slid out, so a rounded card frame around it read as a floating panel inside
// an empty window rather than the surface filling it.
const FLUSH_CONTENT_ROUTES = new Set(['/', '/newsletter', '/roadmap', '/playbook', '/versions', '/mail', '/admin', '/settings', '/debug', '/files', '/chat', '/events', '/ai', '/projects']);

// The project Overview / settings page (/projects/:id, no further segment)
// also renders full-bleed — it carries its own Versions-style masthead, so it
// gets the same borderless, flush content frame. /projects, /projects/new, and
// deeper subroutes are excluded.
function isProjectOverviewRoute(pathname) {
  const m = pathname.match(/^\/projects\/([^/]+)\/?$/);
  return !!m && m[1] !== 'new';
}

// Collapsed-rail width — just wide enough for the centered nav icons. Matches
// the value the collapse CSS is tuned against (icon column + sidebar padding +
// border). Keep in sync with the .app-shell.sidebar-collapsed rule.
const COLLAPSED_SIDEBAR_WIDTH = '60px';
const SIDEBAR_COLLAPSED_KEY = 'docvex.sidebarCollapsed';
// Expanded rail width. The default is the natural design width and doubles as
// the FLOOR — dragging can widen the rail but never narrow it past the layout
// the labels were built for (minimising is what the collapse toggle is for).
// The ceiling is twice that, so a drag can't swallow the content area.
const SIDEBAR_WIDTH_DEFAULT = 192;
const SIDEBAR_WIDTH_MAX = SIDEBAR_WIDTH_DEFAULT * 2;
const SIDEBAR_WIDTH_KEY = 'docvex.sidebarWidth';

// How long the outgoing tab gets to fade before the Hub route swaps in. Must
// match the `.app-shell.hub-leaving .sv-single` transition in AppShell.css —
// shorter and the swap cuts the fade off mid-dissolve, longer and the window
// sits blank at the end of it.
const HUB_LEAVE_MS = 150;
const clampSidebarWidth = (px) => Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_DEFAULT, Math.round(px)));

export default function AppShell() {
  const { pathname } = useLocation();
  const { session, loading: authLoading } = useAuth();
  // Sidebar minimize state — persisted per device (not per user; it's a layout
  // preference). Drives both the rail's own width and the --sidebar-width var
  // the rest of the chrome offsets against, so the whole layout animates in
  // lock-step (see the @property-registered --sidebar-width transition).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const toggleSidebar = () => {
    setSidebarCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  // Drag-to-resize the expanded rail. The width is remembered across collapse /
  // expand (and across sessions) — collapsing parks the rail at the collapsed
  // width without touching this, so re-expanding returns to the width the user
  // set rather than the default.
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
      return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : SIDEBAR_WIDTH_DEFAULT;
    } catch { return SIDEBAR_WIDTH_DEFAULT; }
  });
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const startSidebarResize = (e) => {
    if (sidebarCollapsed || e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    setResizingSidebar(true);
    // Pointer capture on the handle would be lost the moment React re-rendered
    // it, so track on the window instead — that also keeps the drag alive when
    // the cursor outruns the handle.
    const onMove = (ev) => {
      // clientX is viewport px and the width we write is a CSS length; the
      // DELTA still has to be converted under the display-scale zoom.
      setSidebarWidth(clampSidebarWidth(startWidth + toLayoutPx(ev.clientX - startX)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setResizingSidebar(false);
      // Read the committed value out of state on the next tick rather than
      // threading it through — onMove has already clamped it.
      setSidebarWidth((w) => {
        try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w)); } catch { /* ignore */ }
        return w;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  // While switching/loading a project we drop the tab content (and its chrome)
  // and show ONLY the spinner over the ambient dot-grid + cursor spotlight.
  const { switching } = useSelectedProject();
  // When a switch ends (switching: true → false) we re-mount the content and
  // fade it in once the loader has finished dissolving. This flag drives that
  // entrance animation and clears itself when it completes (or on the next
  // switch). It's gated on a real switch so first-load / plain navigation
  // don't animate.
  const [fadeInAfterSwitch, setFadeInAfterSwitch] = useState(false);
  const wasSwitching = useRef(false);
  useEffect(() => {
    if (switching) {
      wasSwitching.current = true;
    } else if (wasSwitching.current) {
      wasSwitching.current = false;
      setFadeInAfterSwitch(true);
    }
  }, [switching]);
  const showBanner = isProjectScopedRoute(pathname);
  const flushContent = FLUSH_CONTENT_ROUTES.has(pathname) || isProjectOverviewRoute(pathname);
  // The Hub (/projects) is a full-screen launcher: the sidebar's "Projects"
  // item navigates here and the rail slides OUT of the window so the launcher
  // fills it. The rail stays MOUNTED throughout — the `on-hub` shell class
  // snaps its layout slot to zero and rides the rail out on a transform (see
  // AppShell.css).
  const onHub = pathname === '/projects' || pathname === '/projects/';
  const navigate = useNavigate();
  // Entrance fade for content crossing the hub boundary. Distinct from
  // fadeInAfterSwitch: the switch fade carries a 220ms delay (it waits for
  // the loader to dissolve), which here would read as a blank flicker.
  const [hubFadeIn, setHubFadeIn] = useState(false);
  // Optimistic "we're on our way to the Hub". Set URGENTLY on click so the
  // rail starts sliding on the very frame the user pressed, while the route
  // swap itself runs as a transition (below). Without it the slide couldn't
  // begin until the route committed, which is what made the click feel dead.
  const [hubPending, setHubPending] = useState(false);
  // The rail is off-window for both — the class is identical, so there is
  // exactly ONE transition across the whole navigation instead of one per
  // state flip (the old `hub-leaving` → `on-hub` handoff restarted it).
  //
  // Note this is NOT what collapses the rail's layout slot: that's driven by
  // `onHub` alone (the `hub-collapsed` class), so the content column keeps its
  // geometry while the outgoing tab fades and only re-flows once the tab it
  // would have jolted is gone. See the slot rules in AppShell.css.
  const railOffstage = onHub || hubPending;
  // The gap between the click and the route committing: the outgoing tab's
  // content fades out while the rail slides. Gated on `!onHub` so the flag is
  // already gone by the frame the Hub paints — the incoming entrance keyframe
  // owns opacity from there, and the two never fight over it.
  const hubLeaving = hubPending && !onHub;
  const hubNavTimer = useRef(null);
  const goToHub = () => {
    if (onHub || hubPending) return;
    // Warm the route chunk + the project rows. Usually already done by the
    // sidebar's hover prefetch; this covers keyboard activation and a click
    // that beats the hover warm-up.
    preloadProjectList();
    prefetchProjects();
    // Urgent, so the rail starts sliding and the outgoing tab starts fading on
    // the very frame of the click.
    setHubPending(true);
    // The route swap waits out the fade. This delay is NOT dead time being
    // added back: navigating immediately means React commits the urgent flag
    // and the route swap in the same task, so the browser never paints a frame
    // with the old content still up — the fade-out had nothing to play on and
    // was invisible. Holding the swap for exactly the fade's length is what
    // makes the outgoing content visible long enough to dissolve.
    //
    // It also keeps the two off each other's backs: mounting the Hub is the
    // heaviest main-thread work in this navigation, and deferring it past the
    // fade means it doesn't land in the middle of the rail's ride.
    //
    // Still a transition, so if the chunk ISN'T warm React holds the current
    // page rather than unmounting the shell behind the route Suspense fallback
    // — which blanked the window and restarted the rail's CSS transition (the
    // "slides out twice" bug).
    //
    // Note what is NOT here: the entrance-fade flag. Under a transition the
    // route commit is decoupled from this click, so arming the fade now plays
    // it on the OUTGOING page and — if the chunk takes longer than the 280ms
    // keyframe — lets it finish and re-arm on arrival. That was the Hub
    // appearing twice. The crossing effect below owns the flag instead.
    hubNavTimer.current = setTimeout(() => {
      startTransition(() => { navigate('/projects'); });
    }, HUB_LEAVE_MS);
  };
  useEffect(() => () => clearTimeout(hubNavTimer.current), []);
  // Drop the optimistic flag once a route has actually committed: on the Hub
  // `onHub` takes over, anywhere else the rail slides back in.
  useEffect(() => { setHubPending(false); }, [pathname]);
  // The single owner of the hub-boundary entrance fade — it arms on the commit
  // that actually crosses the boundary, in either direction, so the animation
  // plays exactly once and on the content it belongs to.
  //
  // useLayoutEffect, not useEffect: a passive effect runs AFTER paint, so the
  // Hub would show one full-opacity frame before the class landed and the
  // keyframe yanked it back to zero — a visible flicker. A layout effect
  // commits the class in the same frame the new route first paints.
  //
  // Skipped while switching — the content shell is unmounted then and re-enters
  // via fadeInAfterSwitch; stacking both animations would double-flash.
  const prevOnHub = useRef(onHub);
  useLayoutEffect(() => {
    if (prevOnHub.current !== onHub) {
      prevOnHub.current = onHub;
      if (!switching) setHubFadeIn(true);
    }
  }, [onHub, switching]);
  // The live, sidebar-driven view. ContentShell wraps it as one pane with the
  // in-pane nav chrome (left rail + header) pinned above a scroll area.
  const primary = showBanner ? (
    <div className="project-page-frame">
      <Outlet />
    </div>
  ) : (
    <Outlet />
  );

  // Electron: force signed-out users to the auth screen — the app shell is
  // only for authenticated sessions. AuthPage pins the window to its default
  // size + disables resizing ('locked'), so this is also what gives the
  // sign-in screen its fixed scale. The invite-accept route stays reachable
  // while signed out: it stashes its token and routes through /auth itself
  // (see InviteAccept.jsx). While auth is still hydrating we hold on a
  // spinner instead of flashing the shell.
  //
  // Web: NO auth wall — signed-out visitors get the shell and explore the
  // Demo Workspace (lib/demoWorkspace; SelectedProjectContext selects it).
  const isInviteRoute = pathname.startsWith('/invite/');
  if (authLoading) return <RouteFallback />;
  if (isElectron && !session && !isInviteRoute) return <Navigate to="/auth" replace />;

  return (
      <div
        className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}${resizingSidebar ? ' sidebar-resizing' : ''}${railOffstage ? ' on-hub' : ''}${hubLeaving ? ' hub-leaving' : ''}${onHub ? ' hub-collapsed' : ''}`}
        style={{ '--sidebar-width': sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : `${sidebarWidth}px` }}
      >
        {/* App chrome — a single bordered, rounded frame that wraps the vertical
            sidebar AND the content area so they read as one window-in-window
            surface, inset from the frameless window edges (the ambient dot grid
            shows around it). */}
        {/* The Hub launcher moved INTO the sidebar — it's the "All projects"
            nav item at the top of the rail (see Sidebar.jsx). On /projects the
            rail stays MOUNTED but slides off-window (offstage) so the move
            animates both ways instead of popping in/out of the DOM. */}
        <div className="app-chrome">
          {/* The rail lives in a SLOT that owns the layout width. On the Hub
              the slot snaps to zero (one reflow, not one per frame) while the
              rail itself — absolutely positioned inside it — slides out on a
              pure transform. Animating the rail's own margin used to re-lay-out
              the entire content column on every frame of the ride. */}
          <div className="sidebar-slot">
            <Sidebar
              collapsed={sidebarCollapsed}
              onToggleCollapse={toggleSidebar}
              offstage={railOffstage}
              onHubNav={goToHub}
            />
          </div>
          {/* Drag handle on the rail's right edge. Rendered by the SHELL, not
              the rail: the rail scrolls its own content, so a handle inside it
              would scroll away with the nav list. Hidden while collapsed (the
              collapsed width is fixed) and while the rail is offstage on the
              Hub. */}
          {!sidebarCollapsed && !railOffstage && (
            <div
              className="sidebar-resize-handle"
              onPointerDown={startSidebarResize}
              onDoubleClick={() => {
                setSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
                try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(SIDEBAR_WIDTH_DEFAULT)); } catch { /* ignore */ }
              }}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
            />
          )}
          <main className={`main-content main-content--single${flushContent ? ' main-content--flush' : ''}`}>
            {/* Cursor-following spotlight that brightens the ambient dot grid.
                A real element moved by a direct transform write (not a CSS-var
                `::after`) to avoid a document-wide style recalc on every move. */}
            <CursorSpotlight />
            {/* On project-scoped routes the page content is wrapped in a rounded
                "sheet" panel. ContentShell renders it as a single pane with the
                in-pane nav chrome (left rail + header). Dropped while switching
                so only the spinner + ambient background show. */}
            {!switching && (
              <ContentShell
                primary={primary}
                fadeIn={fadeInAfterSwitch}
                onFadeInEnd={() => setFadeInAfterSwitch(false)}
                hubFadeIn={hubFadeIn}
                onHubFadeInEnd={() => setHubFadeIn(false)}
              />
            )}
            {/* Project-switch spinner — scoped to the content section (this
                positioned <main>). Transparent panel, so the cursor spotlight +
                dot grid stay visible behind the spinner; the sidebar is untouched. */}
            <SwitchProjectLoader />
          </main>
        </div>
        {/* Project picking now lives in the Hub tab (/projects) — the old
            slide-out picker panel was removed. */}
        {/* Fixed-bottom indeterminate progress strip; renders only while an
            update is checking/downloading. Lives at the shell level so the
            user keeps the feedback even after navigating away from /updates. */}
        <UpdateProgressBar />
        {/* Once the update finishes downloading + staging ('downloaded'),
            prompt for the restart that actually applies it. Shell-level so
            it appears wherever the user is, not only on /versions. */}
        <UpdateRestartModal />
      </div>
  );
}

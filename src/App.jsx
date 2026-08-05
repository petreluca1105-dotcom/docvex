import React, { useEffect, useRef, useState } from 'react';
import { Outlet, useMatch, useNavigate } from 'react-router-dom';
import { ProjectProvider, useProject } from './context/ProjectContext';
import { useSelectedProject } from './context/SelectedProjectContext';
import { useAuth } from './context/AuthContext';
import { isElectron, isAuxWindow, isLocalhostWeb, notifyFilesChanged } from './lib/platform';
import { localFolderApi } from './lib/localFolder';
import { DEMO_PROJECT_ID } from './lib/demoWorkspace';
import { prefetchProjectFiles } from './lib/projectFilesPrefetch';
import AppShell from './components/AppShell';
import TitleBar from './components/TitleBar';
import ReportProblemModal from './components/ReportProblemModal';
import { ReportProblemProvider, useReportProblem } from './context/ReportProblemContext';
import AppRoutes from './AppRoutes';

// Mirrors `useProject().project.id` into SelectedProjectContext when the
// user is on the /dashboard sub-route — the "working in this project"
// surface. Browsing a project's Overview (/projects/:id) is intentionally
// non-mutating: it's read-only management, so it shouldn't hijack the
// sidebar's selection. The Hub (/projects) sets the selection explicitly
// before navigating to /dashboard, so the Hub → dashboard flow still works
// without relying on the auto-select here. Deep-links
// and refreshes directly to /dashboard still resolve correctly because
// this effect fires on that route.
//
// Two timing races we defend against:
//   1. "Select no project" → picker calls clearSelection() then navigate('/').
//      The state change and URL change batch together, but the effect can
//      re-run with the new selectedProjectId=null while useMatch / the
//      ProjectShell unmount haven't caught up, which would re-select the
//      project right after the user explicitly cleared it. prevSelectedRef
//      below detects the "had-a-selection → null" transition and bails.
//   2. Switching projects (abc → def) via the picker: ProjectProvider's
//      `project` state doesn't reset on projectId change — it stays at the
//      old abc-row until getProject(def) resolves. Acting on that stale
//      project.id would briefly flip selectedProjectId back to 'abc'. We
//      gate on projectLoading so the auto-select waits for the fetch to
//      settle before reading project.id.
function ProjectAutoSelect() {
  const { project, loading: projectLoading } = useProject();
  const { selectedProjectId, selectProject } = useSelectedProject();
  const onDashboard = useMatch('/projects/:projectId/dashboard');
  const prevSelectedRef = useRef(selectedProjectId);
  useEffect(() => {
    const prev = prevSelectedRef.current;
    prevSelectedRef.current = selectedProjectId;
    if (!onDashboard) return;
    if (projectLoading) return;       // wait for the in-flight fetch (race 2)
    if (prev && !selectedProjectId) return; // user just deselected (race 1)
    if (project?.id && project.id !== selectedProjectId) {
      selectProject(project.id);
    }
  }, [onDashboard, projectLoading, project?.id, selectedProjectId, selectProject]);
  return null;
}

// Mounts ProjectProvider once for the /projects/:projectId subtree so the
// nested routes (Overview, Dashboard) all share one fetch + Realtime channel.
function ProjectShell() {
  return (
    <ProjectProvider>
      <ProjectAutoSelect />
      <Outlet />
    </ProjectProvider>
  );
}

// Sets the OS window title so each DocVex window is distinguishable in the
// macOS dock / Window menu (and the taskbar on Windows). Electron mirrors
// document.title onto the BrowserWindow title (page-title-updated), so the
// per-window React tree is the right place to drive it. Two window roles
// remain (the launch hub + per-project windows were removed):
//   • Main window — titled after the working project, else plain "DocVex"
//   • Doc-viewer  — ?docViewer=1 (+ name) → "DocVex — <file name>"
function WindowTitle() {
  const { selectedProject } = useSelectedProject();
  useEffect(() => {
    if (!isElectron) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('docViewer') === '1') {
      document.title = `DocVex — ${params.get('name') || 'Document Viewer'}`;
    } else {
      document.title = selectedProject?.name ? `DocVex — ${selectedProject.name}` : 'DocVex';
    }
  }, [selectedProject?.name]);
  return null;
}

// Background warm-up for the Files page. The app boots on the Hub (/projects);
// while the user is there, this prefetches the on-disk folder + listings +
// sidecar for the selected (most-recently-worked-on) project into a module
// cache, so the first "Project" tab open (→ /files) paints the grid on the
// first frame instead of resolving the folder + listing live. Electron-only;
// prefetchProjectFiles no-ops on web (no ambient per-project folder). Headless.
function ProjectPrefetch() {
  const { selectedProjectId, selectedProject } = useSelectedProject();
  const { session } = useAuth();
  const userId = session?.user?.id || null;
  useEffect(() => {
    // Main window only — a Doc Viewer / snip window will never open the Files
    // page, so paying the recursive folder scan + sidecar read per window
    // (times every open viewer) is pure waste.
    if (!isElectron || isAuxWindow || !selectedProjectId) return;
    prefetchProjectFiles({
      projectId: selectedProjectId,
      projectName: selectedProject?.name || null,
      userId,
    });
  }, [selectedProjectId, selectedProject?.name, userId]);
  return null;
}

// Localhost-only (web build): floating debug control that uploads "starter
// files" for the demo. Two writes per picked file:
//   1. POST to the dev server's /__seed-demo-files endpoint (see
//      scripts/seed-demo-middleware.mjs), which stages the file into
//      landing/home/demo-files/ IN THE REPO and regenerates its manifest —
//      so the next `npm run web:deploy` + push ships it and EVERY visitor's
//      demo workspace seeds it (lib/demoWorkspace.js fetches the manifest).
//   2. Into this browser's OPFS demo folder, so the local Files tab shows
//      it immediately without waiting for a re-seed.
// Dev tool, not a product surface — never rendered off localhost or in
// Electron; the endpoint only exists on the Vite dev servers.
function DemoSeedFiles() {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const onPick = async (e) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = '';
    if (picked.length === 0) return;
    setBusy(true);
    try {
      // 1. Stage into the repo via the dev-server endpoint.
      let staged = 0;
      for (const f of picked) {
        try {
          const res = await fetch(`/__seed-demo-files?name=${encodeURIComponent(f.name)}`, {
            method: 'POST',
            body: f,
          });
          if (res.ok) staged += 1;
        } catch { /* endpoint not running (static host) — local write below still happens */ }
      }
      // 2. Drop into this browser's demo folder so the grid updates now.
      await localFolderApi.restorePersistedHandle(DEMO_PROJECT_ID);
      await localFolderApi.writeFiles({
        dir: 'demo',
        files: picked.map((f) => ({ filename: f.name, blob: f })),
      });
      notifyFilesChanged();
      setStatus(staged > 0
        ? `${staged} staged for deploy`
        : 'added locally only — seed endpoint not running');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 10000, display: 'flex', alignItems: 'center', gap: 8 }}>
      {status && !busy && (
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{status}</span>
      )}
      <input ref={inputRef} type="file" multiple hidden onChange={onPick} />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        style={{
          padding: '9px 15px',
          borderRadius: 999,
          border: '1px solid var(--border-strong)',
          background: 'var(--bg-elevated)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-body)',
          fontSize: 12,
          fontWeight: 600,
          cursor: busy ? 'default' : 'pointer',
          boxShadow: 'var(--shadow-elev)',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? 'Adding…' : 'Seed demo files'}
      </button>
    </div>
  );
}

// Tray-menu → main-window bridge (Electron, main window only). The system-tray
// menu (src/pages/TrayMenu.jsx) has no router of its own: it sends an action to
// main, main raises this window and forwards the destination here.
//   '/settings', '/projects/:id', … — plain routes
//   '@report'                       — open the Report-a-problem modal
// Also owns the Ctrl+, accelerator the menu advertises for Settings (the app
// runs with no native menu on Windows, so the shortcut lives here).
function TrayNavigation() {
  const navigate = useNavigate();
  const { captureAndOpen } = useReportProblem();
  useEffect(() => {
    if (!isElectron || isAuxWindow) return undefined;
    const go = (dest) => {
      if (typeof dest !== 'string' || !dest) return;
      if (dest === '@report') { captureAndOpen(); return; }
      navigate(dest);
    };
    const off = window.electronAPI?.onAppNavigate?.(go);
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === ',') {
        e.preventDefault();
        navigate('/settings');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      off?.();
      window.removeEventListener('keydown', onKey);
    };
  }, [navigate, captureAndOpen]);
  return null;
}

export default function App() {
  // Guard against the window navigating to a file when an OS file drag is
  // dropped anywhere OUTSIDE an explicit drop target (the Files canvas calls
  // preventDefault itself). Without this, a stray drop loads file:// in the
  // window and breaks the app. Targets that DO accept drops still work — they
  // preventDefault on their own elements before this bubbles up.
  useEffect(() => {
    const prevent = (e) => {
      // Only files; let in-app element drags (text, etc.) behave normally.
      if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  // Electron runs frameless — the custom title bar (with window controls + the
  // Theme / split-view actions) renders above the routes. The document's
  // `.with-titlebar` class (set in renderer.jsx) makes the layout reserve
  // --titlebar-h for it. Web keeps the browser chrome.
  // ReportProblemProvider wraps both the TitleBar (which hosts the "Report a
  // problem" trigger) and the routed content + the modal, so the trigger and
  // the modal share one context instance.
  return (
    <ReportProblemProvider>
      <WindowTitle />
      <ProjectPrefetch />
      {/* The tray "Extract text" windows are chromeless — the overlay's
          (?snip=1) frozen screenshot must fill the display edge-to-edge, the
          launcher panel (?snipPanel=1) draws its own mini title bar, and the
          delayed-capture countdown badge (?snipCountdown=1) is a transparent
          click-through circle. */}
      {isElectron
        && !['snip', 'snipPanel', 'snipCountdown', 'trayMenu'].some(
          (k) => new URLSearchParams(window.location.search).get(k) === '1',
        )
        && <TitleBar />}
      <TrayNavigation />
      <AppRoutes Shell={AppShell} ProjectShell={ProjectShell} />
      {isLocalhostWeb && <DemoSeedFiles />}
      <ReportProblemModal />
    </ReportProblemProvider>
  );
}

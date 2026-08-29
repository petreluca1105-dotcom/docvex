import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { isElectron, isLocalhostWeb } from './lib/platform';

// The app's route tree. The "/" layout `Shell` and the /projects/:id
// `ProjectShell` wrapper are passed in as props by App.jsx (the main window
// shell, with the sidebar) so the route definitions live in one place.

const AuthPage = lazy(() => import('./components/AuthPage'));
const Activity = lazy(() => import('./pages/Activity'));
const Account = lazy(() => import('./pages/Account'));
const Settings = lazy(() => import('./pages/Settings'));
const Updates = lazy(() => import('./pages/Updates'));
const Newsletter = lazy(() => import('./pages/Newsletter'));
const Roadmap = lazy(() => import('./pages/Roadmap'));
const Playbook = lazy(() => import('./pages/Playbook'));
const Admin = lazy(() => import('./pages/Admin'));
const Debug = lazy(() => import('./pages/Debug'));
// The Hub is the one lazy route we deliberately pre-warm: it's reached by a
// single sidebar click that also plays a rail-slide animation, and a Suspense
// fallback mid-slide blanks the whole shell and restarts the transition. The
// import factory is hoisted so `preloadProjectList()` can start (and the
// bundler can de-dupe) the exact same chunk request React would make.
const importProjectList = () => import('./pages/Projects/ProjectList');
const ProjectList = lazy(importProjectList);
export function preloadProjectList() {
  return importProjectList().catch(() => { /* the route will retry on render */ });
}
const ProjectCreate = lazy(() => import('./pages/Projects/ProjectCreate'));
const ProjectOverview = lazy(() => import('./pages/Projects/ProjectOverview'));
const ProjectDashboard = lazy(() => import('./pages/Projects/ProjectDashboard'));
const ProjectFiles = lazy(() => import('./pages/Projects/ProjectFiles'));
const ProjectClients = lazy(() => import('./pages/Projects/ProjectClients'));
const ProjectTodos = lazy(() => import('./pages/Projects/ProjectTodos'));
const ProjectChat = lazy(() => import('./pages/Projects/ProjectChat'));
const ProjectEvents = lazy(() => import('./pages/Projects/ProjectEvents'));
const ProjectGenerate = lazy(() => import('./pages/Projects/ProjectGenerate'));
const ProjectAutomate = lazy(() => import('./pages/Projects/ProjectAutomate'));
const ProjectAI = lazy(() => import('./pages/Projects/ProjectAI'));
const Mail = lazy(() => import('./pages/Mail'));
const InviteAccept = lazy(() => import('./pages/Projects/InviteAccept'));
const DocViewer = lazy(() => import('./pages/DocViewer'));
const SnipOverlay = lazy(() => import('./pages/SnipOverlay'));
const SnipPanel = lazy(() => import('./pages/SnipPanel'));
const SnipCountdown = lazy(() => import('./pages/SnipCountdown'));
const TrayMenu = lazy(() => import('./pages/TrayMenu'));

// Shared full-screen spinner — reuses the `.spinner` class from Sidebar.css.
export function RouteFallback() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <div className="spinner" />
    </div>
  );
}

function ProtectedRoute() {
  const { session, loading } = useAuth();
  if (loading) return <RouteFallback />;
  // Web build: no auth wall — signed-out visitors explore the Demo Workspace
  // (lib/demoWorkspace). Only Electron gates these routes on a session.
  if (!isElectron) return <Outlet />;
  return session ? <Outlet /> : <Navigate to="/auth" replace />;
}

// Renders the full route tree. `Shell` is the "/" layout element (sidebar
// shell in the main window, sidebar-less shell in a pane); `ProjectShell`
// wraps the /projects/:id subtree (the full version mirrors the project into
// SelectedProjectContext, the pane version does not — see App.jsx / SplitView.jsx).
export default function AppRoutes({ Shell, ProjectShell }) {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        {/* Full-screen document viewer window (file preview + Legal AI panel),
            opened from the Files page. Sits outside the sidebar shell. */}
        <Route path="/doc-viewer" element={<DocViewer />} />
        {/* Full-screen "extract text from screen" overlay — opened from the
            system tray over a frozen screenshot of the desktop. */}
        <Route path="/snip" element={<SnipOverlay />} />
        {/* Snipping-Tool-style launcher bar (tray → "Extract text") — small
            transparent always-on-top window; "New" starts the /snip capture. */}
        <Route path="/snip-panel" element={<SnipPanel />} />
        {/* Delayed-capture countdown badge — click-through transparent window
            centred on each target display while the snip delay ticks down. */}
        <Route path="/snip-countdown" element={<SnipCountdown />} />
        {/* The app-drawn system-tray menu — a transparent always-on-top
            window main.js anchors to the tray icon (see main.js's tray
            section) and hides on blur. */}
        <Route path="/tray-menu" element={<TrayMenu />} />
        <Route path="/" element={<Shell />}>
          <Route index element={<Activity />} />
          <Route path="versions" element={<Updates />} />
          {/* Legacy alias — old links / stored notifications used /updates. */}
          <Route path="updates" element={<Navigate to="/versions" replace />} />
          <Route path="newsletter" element={<Newsletter />} />
          {(import.meta.env.DEV || isLocalhostWeb) && <Route path="debug" element={<Debug />} />}
          <Route path="notifications" element={<Navigate to="/" replace />} />
          <Route path="invite/:token" element={<InviteAccept />} />
          <Route element={<ProtectedRoute />}>
            {/* Protected: the Playbook holds the user's own documents and the
                writing profile learned from them, all keyed to their account. */}
            <Route path="playbook" element={<Playbook />} />
            <Route path="account" element={<Account />} />
            <Route path="settings" element={<Settings />} />
            <Route path="admin" element={<Admin />} />
            <Route path="projects" element={<ProjectList />} />
            <Route path="projects/new" element={<ProjectCreate />} />
            <Route path="projects/:projectId" element={<ProjectShell />}>
              <Route index element={<ProjectOverview />} />
              <Route path="dashboard" element={<ProjectDashboard />} />
            </Route>
            <Route path="files" element={<ProjectFiles />} />
            <Route path="clients" element={<ProjectClients />} />
            <Route path="todos" element={<ProjectTodos />} />
            <Route path="chat" element={<ProjectChat />} />
            <Route path="events" element={<ProjectEvents />} />
            <Route path="generate" element={<ProjectGenerate />} />
            <Route path="automate" element={<ProjectAutomate />} />
            <Route path="ai" element={<ProjectAI />} />
            <Route path="roadmap" element={<Roadmap />} />
            <Route path="mail" element={<Mail />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}

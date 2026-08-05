import './index.css';
import './styles/tokens.css';
import './styles/miniHeader.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { AppPrefsProvider } from './context/AppPrefsContext';
import { UpdatesProvider } from './context/UpdatesContext';
import { NotificationsProvider } from './context/NotificationsContext';
import { SelectedProjectProvider } from './context/SelectedProjectContext';
import { ChatUnreadProvider } from './context/ChatUnreadContext';
import NotificationCenter from './components/NotificationCenter';
import App from './App';

// Web entry. Parallel to src/renderer.jsx (the Electron renderer entry).
// The two differ in exactly one place: this file uses BrowserRouter with
// basename="/demo" so the deployed app lives under docvex.ro/demo, while the
// Electron build uses MemoryRouter because Electron renderers run from
// file:// with no real URL bar.
//
// Provider order matches renderer.jsx exactly:
//   AuthProvider             — session
//   SelectedProjectProvider  — needs AuthContext (per-user storage key + auto-clear)
//   UpdatesProvider          — independent
//   NotificationsProvider    — needs Auth + Updates via its source hooks
//
// NotificationCenter is a sibling of <App /> so toasts persist across route
// transitions; route-level visibility (hide on /auth) is handled inside the
// component via useLocation.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename="/demo">
      <AuthProvider>
        <ThemeProvider>
          <AppPrefsProvider>
            <SelectedProjectProvider>
              <UpdatesProvider>
                <NotificationsProvider>
                  <ChatUnreadProvider>
                    <App />
                  </ChatUnreadProvider>
                  <NotificationCenter />
                </NotificationsProvider>
              </UpdatesProvider>
            </SelectedProjectProvider>
          </AppPrefsProvider>
        </ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);

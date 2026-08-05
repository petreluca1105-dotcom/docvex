import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from './AuthContext';
import { isElectron } from '../lib/platform';

// Per-user color theme — backed by localStorage, scoped per user_id so two
// accounts on the same machine don't see each other's theme. Applies the
// chosen theme by setting `data-theme="…"` on <html>; src/styles/tokens.css
// reads that attribute and swaps the entire palette in one declarative
// re-paint.
//
// Same persistence + hydrate pattern as SelectedProjectContext:
//   - Key: `docvex.theme.<userId>` (or `docvex.theme._anonymous` signed-out).
//   - Hydrate on mount + on auth user change.
//   - Default when nothing is stored: 'cream' (the brand default).
//
// Signed-out fallback: every pick is ALSO mirrored to a machine-wide
// `docvex.theme.last` key. When signed out with no explicit anonymous pick,
// hydration falls back to that key so the auth / sign-out screen keeps the
// theme the user last selected (while signed in) instead of snapping back to
// the brand default.
//
// The DOM attribute is applied synchronously on every change so CSS swaps in
// the same paint. We also write before React mounts (during the first
// hydration effect) to keep FOUC to a single frame at most.

const STORAGE_KEY_PREFIX = 'docvex.theme.';
// Machine-wide "last theme the user picked", regardless of which account. Used
// only as the signed-out fallback (see hydration below). The `last` segment
// can't collide with a real user id (uuid) or the `_anonymous` key.
const LAST_THEME_KEY = `${STORAGE_KEY_PREFIX}last`;
// The marketing website's theme key (see landing/home). On the web build the
// site and the app share one origin — and one theme: hydration prefers this
// key so /app always matches the page the visitor came from, and app-side
// picks are mirrored back so the site follows along.
const SITE_THEME_KEY = 'docvex.site.theme';

// The themes shipped today. Order in this array drives the picker layout
// left-to-right. Adding a third theme is two lines here + a new
// :root[data-theme="…"] block in src/styles/tokens.css.
//
// `swatchOrder` is intentionally identical across themes — the picker
// strip always renders the brand palette in the same canonical order
// (Ink · Slate · Sand · Cream · Cognac) so users learn it as the palette
// identity, not the theme identity.
const SWATCH_ORDER = Object.freeze(['ink', 'slate', 'sand', 'cream', 'cognac']);

export const THEMES = Object.freeze([
  {
    id: 'cream',
    label: 'Cream',
    description: 'Light, brand default. Cream surface, ink text, cognac accents.',
    swatchOrder: SWATCH_ORDER,
  },
  {
    id: 'ink',
    label: 'Ink',
    description: 'Dark variant. Ink surface, cream text, sand accents.',
    swatchOrder: SWATCH_ORDER,
  },
]);

const DEFAULT_THEME = 'cream';
const VALID_THEMES = new Set(THEMES.map((t) => t.id));

// A "preference" is what the user actually picked and what we persist. It's a
// superset of the concrete themes: the two real themes plus the special
// 'system' value, which means "follow the OS light/dark setting". `theme`
// (the value consumers read + the data-theme attribute) is always a concrete
// theme — 'system' is RESOLVED to cream/ink and re-resolved live when the OS
// preference flips.
const DEFAULT_PREF = 'cream';
const VALID_PREFS = new Set([...VALID_THEMES, 'system']);

const ThemeContext = createContext(null);

function storageKey(userId) {
  return STORAGE_KEY_PREFIX + (userId || '_anonymous');
}

// Concrete theme implied by the OS dark-mode setting. Falls back to the brand
// default when matchMedia isn't available.
function systemTheme() {
  if (typeof window === 'undefined' || !window.matchMedia) return DEFAULT_THEME;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'ink' : 'cream';
}

// Resolve a preference to a concrete theme. 'system' → live OS value; an
// explicit theme passes through.
function resolvePref(pref) {
  return pref === 'system' ? systemTheme() : pref;
}

// Apply the data-theme attribute to <html>. Pulled out so it runs in both
// the initial hydration effect AND the setTheme path without duplication.
function applyThemeAttribute(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
}

export function ThemeProvider({ children }) {
  const { session, loading: authLoading } = useAuth();
  const userId = session?.user?.id || null;

  const [theme, _setTheme] = useState(DEFAULT_THEME);
  // The user's stored preference (cream | ink | system). Distinct from `theme`:
  // when this is 'system', `theme` is the resolved cream/ink value.
  const [themePreference, _setPref] = useState(DEFAULT_PREF);

  // Tracks the user-id we last hydrated for. Prevents a re-mount from
  // clobbering the user's pick when only the auth-loading flag flickered.
  const hydratedForUserRef = useRef(null);

  // Hydrate from localStorage whenever the auth user changes. Default to
  // Cream if nothing is stored OR the stored value is unknown (e.g. a
  // value from a future theme the codebase no longer ships).
  useEffect(() => {
    if (authLoading) return;
    if (hydratedForUserRef.current === userId) return;
    hydratedForUserRef.current = userId;

    let nextPref = DEFAULT_PREF;
    try {
      // Web build: the website's theme wins (shared origin, shared look).
      const site = !isElectron ? localStorage.getItem(SITE_THEME_KEY) : null;
      const stored = localStorage.getItem(storageKey(userId));
      if (site && VALID_THEMES.has(site)) {
        nextPref = site;
      } else if (stored && VALID_PREFS.has(stored)) {
        nextPref = stored;
      } else if (!userId) {
        // Signed out with no explicit anonymous pick → fall back to the last
        // theme selected on this machine so the sign-out screen stays in the
        // user's last-chosen look rather than the brand default.
        const last = localStorage.getItem(LAST_THEME_KEY);
        if (last && VALID_PREFS.has(last)) nextPref = last;
      }
    } catch {
      // private mode / quota — non-fatal; we keep the default
    }
    _setPref(nextPref);
    const resolved = resolvePref(nextPref);
    _setTheme(resolved);
    applyThemeAttribute(resolved);
  }, [userId, authLoading]);

  // Public setter — accepts a preference (cream | ink | system), writes it to
  // localStorage, resolves it to a concrete theme, and applies the attribute.
  // Skips gracefully on an unknown value so a typo can't break the app.
  const setTheme = useCallback((pref) => {
    if (!VALID_PREFS.has(pref)) return;
    _setPref(pref);
    const resolved = resolvePref(pref);
    _setTheme(resolved);
    applyThemeAttribute(resolved);
    try {
      localStorage.setItem(storageKey(userId), pref);
      // Mirror to the machine-wide key so the signed-out screen can recall it.
      localStorage.setItem(LAST_THEME_KEY, pref);
      // Web build: mirror the resolved theme to the website's key so the
      // marketing pages follow the pick (the site only knows cream/ink).
      if (!isElectron) localStorage.setItem(SITE_THEME_KEY, resolved);
    } catch {
      /* private mode / quota — non-fatal */
    }
  }, [userId]);

  // While the preference is 'system', track OS dark-mode changes live so the
  // app re-paints when the user flips their system theme without reopening the
  // picker. Listener only attaches while following the system.
  useEffect(() => {
    if (themePreference !== 'system') return;
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const resolved = mq.matches ? 'ink' : 'cream';
      _setTheme(resolved);
      applyThemeAttribute(resolved);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [themePreference]);

  const value = useMemo(() => ({
    theme,
    themePreference,
    setTheme,
    themes: THEMES,
  }), [theme, themePreference, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

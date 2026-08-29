// Which country's law a project is worked under.
//
// The AI stack used to assume Romania everywhere (it's hard-coded in the
// `project-ai` / `doc-ai` / `legal-ai` system prompts). A firm handling a German
// contract or an EU-law question needs the model citing the right legislation,
// the right courts, and answering in the right language — that's what this
// catalog drives. The project's choice lives in `projects.jurisdiction`
// (migration 033) and is stamped onto every AI request.
//
// KEEP IN SYNC with supabase/functions/_shared/jurisdictions.ts — the Edge
// Functions re-resolve the code server-side rather than trusting text from the
// client, so a code that exists here but not there silently falls back to the
// default. The server copy is the security boundary; this one is the picker.
//
// Fields per entry:
//   code      ISO 3166-1 alpha-2 (plus the supranational 'EU')
//   name      the jurisdiction as the AI should name it
//   adjective "Romanian law", "German courts" — the prompt's natural form
//   language  what the AI answers in by default for this jurisdiction
//   system    'civil' | 'common' | 'mixed' — shapes how the AI reasons
//   eu        EU member (so EU regulations/directives apply directly)
//   flag      picker garnish only

export const JURISDICTIONS = [
  { code: 'RO', name: 'Romania',        adjective: 'Romanian',       language: 'Romanian',   system: 'civil',  eu: true,  flag: '🇷🇴' },
  { code: 'EU', name: 'European Union', adjective: 'EU',             language: 'English',    system: 'civil',  eu: true,  flag: '🇪🇺' },
  { code: 'MD', name: 'Moldova',        adjective: 'Moldovan',       language: 'Romanian',   system: 'civil',  eu: false, flag: '🇲🇩' },
  { code: 'AT', name: 'Austria',        adjective: 'Austrian',       language: 'German',     system: 'civil',  eu: true,  flag: '🇦🇹' },
  { code: 'BE', name: 'Belgium',        adjective: 'Belgian',        language: 'Dutch',      system: 'civil',  eu: true,  flag: '🇧🇪' },
  { code: 'BG', name: 'Bulgaria',       adjective: 'Bulgarian',      language: 'Bulgarian',  system: 'civil',  eu: true,  flag: '🇧🇬' },
  { code: 'CH', name: 'Switzerland',    adjective: 'Swiss',          language: 'German',     system: 'civil',  eu: false, flag: '🇨🇭' },
  { code: 'CY', name: 'Cyprus',         adjective: 'Cypriot',        language: 'Greek',      system: 'mixed',  eu: true,  flag: '🇨🇾' },
  { code: 'CZ', name: 'Czechia',        adjective: 'Czech',          language: 'Czech',      system: 'civil',  eu: true,  flag: '🇨🇿' },
  { code: 'DE', name: 'Germany',        adjective: 'German',         language: 'German',     system: 'civil',  eu: true,  flag: '🇩🇪' },
  { code: 'DK', name: 'Denmark',        adjective: 'Danish',         language: 'Danish',     system: 'civil',  eu: true,  flag: '🇩🇰' },
  { code: 'ES', name: 'Spain',          adjective: 'Spanish',        language: 'Spanish',    system: 'civil',  eu: true,  flag: '🇪🇸' },
  { code: 'FI', name: 'Finland',        adjective: 'Finnish',        language: 'Finnish',    system: 'civil',  eu: true,  flag: '🇫🇮' },
  { code: 'FR', name: 'France',         adjective: 'French',         language: 'French',     system: 'civil',  eu: true,  flag: '🇫🇷' },
  { code: 'GB', name: 'United Kingdom', adjective: 'English (England & Wales)', language: 'English', system: 'common', eu: false, flag: '🇬🇧' },
  { code: 'GR', name: 'Greece',         adjective: 'Greek',          language: 'Greek',      system: 'civil',  eu: true,  flag: '🇬🇷' },
  { code: 'HU', name: 'Hungary',        adjective: 'Hungarian',      language: 'Hungarian',  system: 'civil',  eu: true,  flag: '🇭🇺' },
  { code: 'IE', name: 'Ireland',        adjective: 'Irish',          language: 'English',    system: 'common', eu: true,  flag: '🇮🇪' },
  { code: 'IT', name: 'Italy',          adjective: 'Italian',        language: 'Italian',    system: 'civil',  eu: true,  flag: '🇮🇹' },
  { code: 'LU', name: 'Luxembourg',     adjective: 'Luxembourgish',  language: 'French',     system: 'civil',  eu: true,  flag: '🇱🇺' },
  { code: 'NL', name: 'Netherlands',    adjective: 'Dutch',          language: 'Dutch',      system: 'civil',  eu: true,  flag: '🇳🇱' },
  { code: 'PL', name: 'Poland',         adjective: 'Polish',         language: 'Polish',     system: 'civil',  eu: true,  flag: '🇵🇱' },
  { code: 'PT', name: 'Portugal',       adjective: 'Portuguese',     language: 'Portuguese', system: 'civil',  eu: true,  flag: '🇵🇹' },
  { code: 'SE', name: 'Sweden',         adjective: 'Swedish',        language: 'Swedish',    system: 'civil',  eu: true,  flag: '🇸🇪' },
  { code: 'SK', name: 'Slovakia',       adjective: 'Slovak',         language: 'Slovak',     system: 'civil',  eu: true,  flag: '🇸🇰' },
  { code: 'TR', name: 'Türkiye',        adjective: 'Turkish',        language: 'Turkish',    system: 'civil',  eu: false, flag: '🇹🇷' },
  { code: 'US', name: 'United States',  adjective: 'US federal',     language: 'English',    system: 'common', eu: false, flag: '🇺🇸' },
];

// What a project falls back to when it has never chosen — the app was built
// Romania-first, so an untouched project behaves exactly as it always has.
export const DEFAULT_JURISDICTION = 'RO';

const BY_CODE = new Map(JURISDICTIONS.map((j) => [j.code, j]));

// Resolve a code to its entry, falling back to the default for null / unknown
// values (a project saved before migration 033, or a code retired from the list).
export function getJurisdiction(code) {
  return BY_CODE.get(String(code || '').toUpperCase()) || BY_CODE.get(DEFAULT_JURISDICTION);
}

// Normalise a code for storage: a known code, or null meaning "not set".
export function coerceJurisdictionCode(code) {
  const c = String(code || '').toUpperCase();
  return BY_CODE.has(c) ? c : null;
}

// ── Ambient jurisdiction ────────────────────────────────────────────────────
// Same pattern as lib/aiTokenMeter's ambient project: SelectedProjectContext
// keeps this in sync with whatever project is open, so every AI helper in the
// app stamps the right jurisdiction without threading it through each call.
//
// Also mirrored to localStorage because the Doc Viewer is a SEPARATE window —
// its own context re-resolves the project a beat after the window opens, and a
// request fired in that gap would otherwise silently use the default. The
// mirror lets the read be synchronous and correct from the first frame.

const AMBIENT_KEY = 'docvex.ai.jurisdiction';
let ambientCode = null;

export function setActiveJurisdiction(code) {
  ambientCode = coerceJurisdictionCode(code);
  try {
    if (ambientCode) localStorage.setItem(AMBIENT_KEY, ambientCode);
    else localStorage.removeItem(AMBIENT_KEY);
  } catch { /* quota / non-browser */ }
}

// The code to stamp on an AI request: the live value, else the last one this
// device saw, else null (the Edge Function then applies its own default).
export function getActiveJurisdiction() {
  if (ambientCode) return ambientCode;
  try { return coerceJurisdictionCode(localStorage.getItem(AMBIENT_KEY)); } catch { return null; }
}

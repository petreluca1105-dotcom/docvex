import React from 'react';
import { openExternal } from '../../lib/platform';
import woodHSrc from './assets/wood-h.svg';

// The public legal pages on the marketing site. Opened in a new browser tab
// from web, and in the user's default browser from the desktop app — either
// way the signup form the user is filling in stays exactly as it was.
export const TERMS_URL = 'https://docvex.ro/terms.html';
export const PRIVACY_URL = 'https://docvex.ro/privacy.html';

// Account creation happens on the website (same Supabase project, same
// account), so "Create an account" leaves the app for the site's sign-up tab —
// the site can also finish the flows the desktop app can't host, e.g. the
// email-confirmation and password-recovery landings.
export const SIGNUP_URL = 'https://docvex.ro/auth.html?mode=signup';

export const woodH = woodHSrc;

// Google's brand glyph — the exact four-path mark from the design.
export const GoogleIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4" />
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853" />
    <path d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" fill="#FBBC05" />
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335" />
  </svg>
);

export const CheckIcon = ({ size = 14, stroke = 'currentColor', width = 3 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke}
    strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

// Full-width Google sign-in / sign-up button.
export function GoogleButton({ onClick, label = 'Continue with Google' }) {
  return (
    <button type="button" onClick={onClick} className="auv-google">
      <GoogleIcon size={18} />
      {label}
    </button>
  );
}

// Labelled text input. `rightSlot` hosts the "Forgot?" link beside the label.
export function Field({ label, type = 'text', value, onChange, placeholder, autoFocus, autoComplete, rightSlot }) {
  return (
    <div className="auv-field">
      <div className="auv-label-row">
        <label className="auv-label">{label}</label>
        {rightSlot}
      </div>
      <input
        className="auv-input"
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
      />
    </div>
  );
}

// Three-segment password-strength meter + label.
export function Strength({ strength, label }) {
  return (
    <div className="auv-strength-wrap">
      <div className="auv-strength">
        <span className={strength >= 1 ? 'is-on' : ''} />
        <span className={strength >= 2 ? 'is-on' : ''} />
        <span className={strength >= 3 ? 'is-on' : ''} />
      </div>
      <p className="auv-strength-label">{label}</p>
    </div>
  );
}

// Terms acceptance + newsletter opt-in checkboxes (shared confirm step).
// The two legal links open the real pages in a new tab. They're inside a
// <label>, so a plain click would toggle the checkbox as well — stopPropagation
// keeps "read the terms" from silently accepting them. openExternal handles the
// Electron/web split (system browser vs. window.open).
export function Agreements({ agree, news, onAgree, onNews }) {
  const openLegal = (url) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    openExternal(url);
  };
  return (
    <>
      <label className="auv-check">
        <input type="checkbox" checked={agree} onChange={onAgree} />
        <span>
          I agree to the{' '}
          <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" onClick={openLegal(TERMS_URL)}>
            Terms of Service
          </a>{' '}
          and{' '}
          <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" onClick={openLegal(PRIVACY_URL)}>
            Privacy Policy
          </a>.
        </span>
      </label>
      <label className="auv-check" style={{ marginTop: 13 }}>
        <input type="checkbox" checked={news} onChange={onNews} />
        <span>
          Send me the <strong>Legal Newsfeed</strong> — a weekly briefing on Romanian legislation.
        </span>
      </label>
    </>
  );
}

// Read-only "review your details" card on the confirm step.
export function ReviewSummary({ rows }) {
  return (
    <div className="auv-summary">
      {rows.map((r, i) => (
        <React.Fragment key={r.k}>
          {i > 0 && <div className="auv-summary-rule" />}
          <div className="auv-summary-row"><span>{r.k}</span><strong>{r.v}</strong></div>
        </React.Fragment>
      ))}
    </div>
  );
}

// Error (or positive notice) line shared by every form view.
export function FormMsg({ error, notice }) {
  if (error) return <p className="auv-err">{error}</p>;
  if (notice) return <p className="auv-notice">{notice}</p>;
  return null;
}


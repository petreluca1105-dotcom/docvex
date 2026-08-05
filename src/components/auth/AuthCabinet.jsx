import React from 'react';
import {
  GoogleButton, Field, Strength, Agreements, ReviewSummary,
  FormMsg, CheckIcon, woodH, SIGNUP_URL,
} from './authBits';
import { openExternal } from '../../lib/platform';
import CursorSpotlight from '../CursorSpotlight';
import brandLockup from '../../big_logo.png';

const PANEL_FEATURES = [
  ['Drafting.', 'From your templates.'],
  ['Privacy.', 'GDPR by design.'],
  ['Workflows.', 'Intake to close.'],
  ['Insight.', 'Across every matter.'],
];

// A · The Cabinet — split brand panel (deep ink, left) beside a cream form
// (right); signup walks a numbered top stepper Account → Profile → Confirm.
export default function AuthCabinet({ flow }) {
  const f = flow;
  const stepDotClass = (i) => `auv-cab-dot ${f.step > i ? 'is-done' : f.step === i ? 'is-active' : ''}`;

  return (
    <div className="auv-root auv-cabinet">
      {/* ── Left: brand panel ── */}
      <aside className="auv-cab-brand">
        {/* Cursor spotlight (light dots on ink) — clipped to this panel. */}
        <CursorSpotlight className="auv-cab-brand-spot" contain />
        <img className="auv-cab-lockup" src={brandLockup} alt="DocVex — Intelligent Legal Workflows" draggable={false} />

        <div className="auv-cab-pitch">
          <h2 className="auv-cab-h2">Documents.<br /><span>Solved.</span></h2>
          <div className="auv-cab-grid">
            {PANEL_FEATURES.map(([t, d]) => (
              <div key={t}>
                <div className="auv-cab-grid-t">{t}</div>
                <div className="auv-cab-grid-d">{d}</div>
              </div>
            ))}
          </div>
        </div>

        <span className="auv-wood-edge" aria-hidden="true" style={{ backgroundImage: `url(${woodH})` }} />
      </aside>

      {/* ── Right: form panel ── */}
      <section className="auv-cab-form">
        <div className="auv-cab-form-inner">
          {f.done ? (
            <Done flow={f} />
          ) : f.mode === 'signin' ? (
            <SignIn flow={f} />
          ) : (
            <SignUp flow={f} stepDotClass={stepDotClass} />
          )}
        </div>
      </section>
    </div>
  );
}

function SignIn({ flow: f }) {
  return (
    <div className="auv-fade">
      <h3 className="auv-h3">Welcome</h3>
      <p className="auv-sub">Sign in to your DocVex workspace.</p>
      <Field label="Email" type="email" value={f.email} onChange={f.onEmail}
        placeholder="you@firm.law" autoComplete="email" autoFocus={!f.email} />
      <Field label="Password" type="password" value={f.password} onChange={f.onPassword}
        placeholder="••••••••" autoComplete="current-password"
        rightSlot={<button type="button" className="auv-link" onClick={f.forgot}>Forgot?</button>} />
      <FormMsg error={f.error} notice={f.notice} />
      <button className="auv-btn auv-btn--cognac" onClick={f.doSignin} disabled={f.busy}>
        {f.busy ? 'Signing in…' : 'Sign in'}
      </button>
      <div className="auv-or"><span>or</span></div>
      <GoogleButton onClick={f.google} />
      {/* Sign-up lives on the website — same Supabase project, so the account
          created there signs in here. Opens in the default browser (or a new
          tab on web) so the half-typed sign-in form survives. This is the only
          entry point to the in-app <SignUp/> wizard, so that wizard is now
          dormant; it's kept intact (and still driven by useAuthFlow) so
          onboarding can be pulled back in-app by restoring `f.toSignup` here. */}
      <p className="auv-foot">New to DocVex? <button type="button" className="auv-link" onClick={() => openExternal(SIGNUP_URL)}>Create an account</button></p>
    </div>
  );
}

function SignUp({ flow: f, stepDotClass }) {
  return (
    <div className="auv-fade">
      <div className="auv-cab-stepper">
        {['Account', 'Profile', 'Confirm'].map((label, i) => (
          <React.Fragment key={label}>
            {i > 0 && <span className="auv-cab-stepline" />}
            <div className="auv-cab-step">
              <span className={stepDotClass(i)}>{f.step > i ? <CheckIcon size={14} stroke="#fff" /> : i + 1}</span>
              <span className="auv-cab-step-label">{label}</span>
            </div>
          </React.Fragment>
        ))}
      </div>

      {f.step === 0 && (
        <div className="auv-fade">
          <h3 className="auv-h3 sm">Create your account</h3>
          <p className="auv-sub">Start with your work email.</p>
          <Field label="Email" type="email" value={f.email} onChange={f.onEmail}
            placeholder="you@firm.law" autoComplete="email" autoFocus={!f.email} />
          <Field label="Password" type="password" value={f.password} onChange={f.onPassword}
            placeholder="At least 8 characters" autoComplete="new-password" />
          <Strength strength={f.strength} label={f.strengthLabel} />
          <FormMsg error={f.error} notice={f.notice} />
          <button className="auv-btn auv-btn--cognac" onClick={f.next}>Continue</button>
          <div className="auv-or"><span>or</span></div>
          <GoogleButton onClick={f.google} label="Sign up with Google" />
          <p className="auv-foot">Already a member? <button type="button" className="auv-link" onClick={f.toSignin}>Sign in</button></p>
        </div>
      )}

      {f.step === 1 && (
        <div className="auv-fade">
          <h3 className="auv-h3 sm">Tell us about you</h3>
          <p className="auv-sub">This personalises your workspace.</p>
          <Field label="Full name" value={f.name} onChange={f.onName} placeholder="Ana Popescu" autoFocus />
          <Field label="Firm / organization" value={f.firm} onChange={f.onFirm} placeholder="Popescu & Asociații" />
          <FormMsg error={f.error} />
          <div className="auv-btn-row">
            <button className="auv-btn auv-btn--ghost" onClick={f.back}>Back</button>
            <button className="auv-btn auv-btn--cognac is-grow" onClick={f.next}>Continue</button>
          </div>
        </div>
      )}

      {f.step === 2 && (
        <div className="auv-fade">
          <h3 className="auv-h3 sm">Almost there</h3>
          <p className="auv-sub">Review and accept to finish.</p>
          <ReviewSummary rows={[
            { k: 'Name', v: f.name || '—' },
            { k: 'Firm', v: f.firm || '—' },
            { k: 'Email', v: f.email || 'your email' },
          ]} />
          <Agreements agree={f.agree} news={f.news} onAgree={f.onAgree} onNews={f.onNews} />
          <FormMsg error={f.error} />
          <div className="auv-btn-row">
            <button className="auv-btn auv-btn--ghost" onClick={f.back}>Back</button>
            <button className="auv-btn auv-btn--cognac is-grow" onClick={f.finish} disabled={f.busy}>
              {f.busy ? 'Creating…' : 'Create account'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Done({ flow: f }) {
  return (
    <div className="auv-done auv-fade">
      <div className="auv-done-mark auv-done-mark--cognac"><CheckIcon size={30} stroke="#fff" width={2.5} /></div>
      {f.confirmEmail ? (
        <>
          <h3 className="auv-h3">Confirm your email</h3>
          <p className="auv-sub center">We've sent a confirmation link to <strong>{f.confirmEmail}</strong>. Open it to enter your workspace.</p>
          <FormMsg error={f.error} notice={f.notice} />
          <button className="auv-btn auv-btn--cognac is-auto" onClick={f.toSignin}>Back to sign in</button>
          <p className="auv-foot">
            Didn't get it?{' '}
            <button type="button" className="auv-link" onClick={f.resendConfirm} disabled={f.resent}>
              {f.resent ? 'Sent again' : 'Resend email'}
            </button>
          </p>
        </>
      ) : (
        <>
          <h3 className="auv-h3">You're all set, {f.firstName}</h3>
          <p className="auv-sub center">Your DocVex workspace is ready. Let's get to work.</p>
          <button className="auv-btn auv-btn--cognac is-auto" onClick={f.reset}>Enter workspace</button>
        </>
      )}
    </div>
  );
}

# CLAUDE.md — Marketing website (`landing/`)

This file documents the **Docvex marketing website** (the public site at
**docvex.ro**). It is a **separate codebase** from the Docvex application — the
Electron desktop app + its `/app` web variant are documented in the repo-root
[`../CLAUDE.md`](../CLAUDE.md). Don't conflate them.

> **History note (2026-07):** the previous Vite + React marketing site (served
> under `/old/`) and its `landing` npm workspace were **deleted**. The static
> site in `landing/home/` is now the only marketing surface. If you see
> references to `landing/src`, `landing/dist`, `docs/old/`, `landing:dev`,
> `landing:build`, `landing:deploy`, or `newhome:dev`, they are stale.

## The site (`landing/home/`)

Plain hand-written HTML/CSS/JS, **no build step** — files are deployed verbatim
to the `docs/` root (GitHub Pages). Multi-page (each `.html` is a real page, no
router):

- `index.html` — homepage, implemented from the "DocVex Home" Claude Design
  (dark editorial layout: hero + video panel, Who We Are, Services, Process,
  marquees, workspace showcase, stats, testimonial, legal-updates cards, big
  CTA, watermark footer). Fully self-contained (inline styles + one `<style>`
  block + inline scripts):
  - **Theming.** The design's dark palette is the **Ink** default; a **Cream**
    light variant exists. All colors go through CSS vars (`--bg-page`,
    `--bg-panel`, `--bg-card`, `--bg-footer`, `--tx-1/2/3`, `--br` (border RGB
    triplet used as `rgba(var(--br), a)`), `--acc` (fill accent, tan in both
    themes), `--acc-tx` (accent-as-text: tan on Ink, cognac on Cream), `--hdr`,
    `--scrim`, `--scrim2`, `--wm`, `--dot`), defined on
    `:root, [data-theme="ink"]` and `[data-theme="cream"]`. The nav has a
    sun/moon toggle; the choice persists in the `docvex.site.theme`
    localStorage key **shared with the sub-pages**, applied pre-paint by an
    inline `<head>` script (default `ink`).
  - **Background.** Fixed ambient dot-grid + vignette layer plus the
    cursor-following `.cursor-spotlight` (brighter dot copy masked to a 215px
    circle, transform moved per pointer frame with counter-shifted
    `background-position`) — ported from the app's CursorSpotlight.
  - **Image slots.** The design's 13 image drop-slots render as static
    `.dv-slot` placeholder panels (label + dot texture) until real
    photos/screenshots exist.
  - **Auth chip.** Signed-in users get an avatar/name chip (dropdown: Account /
    Sign out) in place of Sign in + Get Started, reading the shared Supabase
    session; the footer Newsletter form writes to the `enrollments` table
    (type `newsletter`, degrading to a tagged `waitlist` row).
- Sub-pages: `company.html`, `legal.html` (+ `terms/privacy/cookies/gdpr/
  security/dpa.html`), `installers.html` (Download), `enroll.html` (waitlist /
  `?mode=demo` — a *sales* demo request form, unrelated to the removed
  in-browser demo), `auth.html`, `account.html` (signed-in profile).
  **`auth.html`** is **the desktop app's own sign-in screen, ported to the
  web** — "The Cabinet" (split ink brand panel + cream form), a verbatim copy of
  `src/components/auth/authCabinet.css` + `AuthCabinet.jsx` with the React flow
  (`useAuthFlow.js`) rewritten in vanilla JS against `supabase.js`. **Keep the
  two in sync when either changes.** The page itself wears the normal site
  chrome (`chrome.js` navbar + footer + ambient grid/spotlight) and follows the
  Cream/Ink theme; the **cabinet does not** — it's the app's fixed branded
  surface, so it sits on top as a self-contained card with its own cream
  interior (the form panel paints the cream + dot grid the app gets from
  `.auth-page::before`). The app locks its window to 1104×640 for this screen,
  so the card keeps those exact proportions, offset below the 108px fixed
  navbar. It carries the same 3-step sign-up wizard (Account → Profile →
  Confirm), the contained cursor spotlight on the brand panel, Google OAuth,
  and:
  - `?next=<relative-page>` (default `index.html`, validated against open
    redirects) so signing in returns the visitor where they started —
    `account.html` links in with `?next=account.html`;
  - **the bare URL opens on create-account** (the site's job is onboarding new
    firms; existing users sign in from the app). `?mode=signin` opens the
    sign-in step instead — that's what the navbar's "Sign in" link and
    `account.html`'s signed-out bounce use, and what the OAuth / confirmation /
    recovery `redirectTo`s carry so a failed exchange lands somewhere sensible.
    `?mode=signup` is still honoured explicitly (the navbar's **Get Started**
    pill and the app's "Create an account" link — `SIGNUP_URL` in
    `src/components/auth/authBits.jsx`);
  - the **password-recovery landing**: `type=recovery` suppresses the
    signed-in auto-redirect and shows a set-a-new-password panel. The desktop
    app can't host this (a `docvex://` redirect can't carry Supabase's recovery
    token), which is why `useAuthFlow`'s "Forgot?" sends people here.

  Other sub-page **navbars are the homepage's navbar** (see below); page bodies
  + footer still use the older Cream/Ink chrome styling.
- `chrome.js` — shared site chrome injected into the **sub-pages** (the
  homepage has its own inline copy of the same navbar). `navbarHTML()` emits
  the homepage navbar (round logo + DOCVEX wordmark; links Home / Company /
  Services / Updates / Download / Contact — section anchors resolve to
  `index.html#…`; round theme toggle; Sign in → `auth.html?mode=signin`, tan
  "Get Started" pill → `auth.html?mode=signup`), wires the theme toggle, marks
  the active nav link, and renders the **account chip** from the Supabase
  session. Keep the two navbars in sync when editing either. A page can opt out
  of the injected navbar (keeping the footer + theme) with
  `<html data-dvx-no-navbar>` — no page currently does. All classes are
  `dvx`-prefixed.
- `chrome.css` — styles for that chrome. `legal.css` / `legal.js` — shared
  frame for the legal document pages.
- `supabase.js` — **standalone Supabase client** (`@supabase/supabase-js` from
  `esm.sh`, no bundler). **Same project as the app** (`pntxlvhkqfryyyxlqytr`),
  PKCE, `detectSessionInUrl: true`, default `sb-<ref>-auth-token` storage key —
  so an account created on the site is the **same account** used in the app,
  and the session is shared when both are served from the same origin. The anon
  (publishable) key is committed on purpose: it only grants what RLS allows.
- **Theme:** Cream / Ink via the `docvex.site.theme` localStorage key +
  `data-theme` on `<html>`; an inline `<script>` in each page's `<head>`
  applies the saved theme before paint. The homepage defaults to **Ink**, the
  sub-pages to **Cream** — same key either way, so a toggle anywhere follows
  the visitor across pages.
- All pages use `<base href="/">` — serve the folder at a root, don't open the
  files directly.

> **Removed (2026-07-27): the in-browser demo.** The web build of the app used
> to be published inside the site at `/demo/` (nav "Demo" tab, and `auth.html`
> redirected into its sign-in screen). It is **gone from the website**: the nav
> link and the SPA are removed, `landing-deploy` actively clears `docs/demo`,
> and the release lifecycle no longer builds it. The web-build source and the
> `web:*` scripts still exist in the repo — they just don't publish anywhere.
> `auth.html` is now the site's **own** sign-in page (see below).

## Commands (run from the repo ROOT)

```
npm run site:dev      # serve landing/home with Vite → http://localhost:5175
npm run site:deploy   # copy landing/home → docs/ (the GitHub Pages root)
```

There is no build for the site — files are copied verbatim.

`site:deploy` runs `scripts/landing-deploy.mjs`: it wipes the non-protected
top-level entries of `docs/` and re-copies `landing/home/` into the root,
never touching the PROTECTED set (`CNAME`, `.nojekyll`, `invite.html`,
`404.html`, `favicon.ico`), and never copying `demo` / `demo-files` even if a
local web build recreates them. Then `git add docs`. Pushing the result
publishes it at docvex.ro.

## `docs/` layout

| Path | Built by | What |
| --- | --- | --- |
| `docs/` (root) | `npm run site:deploy`, from `landing/home/` | the marketing site |

`docs/404.html` simply redirects to `/` — with the demo SPA gone there is no
client-side router to bootstrap.

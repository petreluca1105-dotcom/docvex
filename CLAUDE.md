# CLAUDE.md — Docvex application

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Scope:** This file documents the **Docvex application** — the Electron
> desktop app and its web-app variant served under `/app`. The separate
> **marketing website** (docvex.ro, source in `landing/`) has its own guide:
> [`landing/CLAUDE.md`](landing/CLAUDE.md). Don't conflate the two — the "Web
> build vs Electron build" section below is the *app's* browser variant, NOT the
> marketing site. They share only the GitHub Pages `docs/` folder (the site at
> the root, the app SPA under `docs/app/`).

> **Note (2026-06):** Migration 031 removed the cloud file store and the
> GitHub-style branching/change-request system described in older versions of
> this doc. Files are now local-only per project (`lib/localFolder.js` +
> `.docvex.json` sidecar via `lib/localBranchMeta.js`). The provider stack,
> routing, and Supabase schema below reflect the post-pivot state. Newer
> surfaces — Hub (project list at `/projects`; the standalone `/launch` hub was
> removed), Doc Viewer (`/doc-viewer`, incl. the AI "Generate" advisor), Admin,
> Settings, Mail, the Project AI hub — exist but aren't documented in
> depth here; read the source directly.

Docvex is a team-collaboration desktop + web app for projects (chat, AI
tools, legal newsfeed) on top of Supabase (auth, Postgres + RLS, Realtime,
Edge Functions). Project files live in a local folder per project — there is
no cloud file store. The Electron build is the primary surface; the web build
(`/app/` on GitHub Pages) is a thin variant of the same renderer.

## Commands

```powershell
npm start                 # electron-forge start (dev + Vite HMR + DevTools open)
npm run start:multi       # launch several dev instances in parallel (scripts/run-many.mjs;
                          # sets DOCVEX_ALLOW_MULTI=1 to skip the single-instance lock)
npm run package           # build app folder in out/ (no installer)
npm run make              # build platform installers (Squirrel.exe on Windows)
npm run publish           # make + upload artifacts to GitHub Releases as a draft
                          # — requires GITHUB_TOKEN env var with public_repo scope

# Web build (GitHub Pages target under docs/app/):
npm run web:dev           # Vite dev server with web entry (src/web.jsx)
npm run web:build         # vite build → dist-web/
npm run web:deploy        # build + copy into landing/home/demo/ (gitignored).
                          # NOTE: the website no longer publishes the web build —
                          # the in-browser demo was removed from docvex.ro on
                          # 2026-07-27, and landing-deploy now clears docs/demo.
                          # The build still works for local/manual use.

# Marketing site (static HTML in landing/home/, no build — see landing/CLAUDE.md):
npm run site:dev          # serve landing/home with Vite → http://localhost:5175
npm run site:deploy       # scripts/landing-deploy.mjs → copy landing/home into docs/

# Release workflow (uses npm-version lifecycle hooks defined in package.json):
npm run release:patch     # bump x.x.(x+1), commit, tag, push, publish, regenerate web
npm run release:minor     # bump x.(x+1).0
npm run release:major     # bump (x+1).0.0
npm run release:status    # show working-tree status + last commit

# release:* run preversion (fail if dirty), `version` (sync README + rebuild
# web bundle into docs/app/), then postversion → scripts/post-release.mjs,
# which runs each step independently (a failure in one doesn't skip the rest):
#   1. git push --follow-tags
#   2. electron-forge publish   — Win Setup.exe + nupkg → draft GitHub release
#   3. publish-mac-zips         — packages + signs both darwin .app bundles, uploads zips
#   4. generate-release-notes   — `claude` CLI summarises commits, PATCHes release body (best-effort)
#   5. finalize-release         — draft=false + rebinds tag_name to v<version> so
#                                  /releases/download/v<x>/* and update.electronjs.org
#                                  start serving it. Needs GITHUB_TOKEN; publish the
#                                  draft manually on github.com as a fallback.

# Repair an existing release's macOS assets (must run ON A MAC):
npm run fix:mac           # rebuild + ad-hoc re-sign + re-zip + replace the
                          # darwin .zip assets on the latest release
npm run fix:mac -- v7.2.5 # ...on a specific tag. Needs GITHUB_TOKEN.
```

> **macOS code-signing — read before cutting a release.** Two mutually
> exclusive paths, chosen by whether `APPLE_SIGNING_IDENTITY` is set:
>
> - **Developer ID + notarization (preferred).** Set `APPLE_SIGNING_IDENTITY`
>   to a `Developer ID Application: … (TEAMID)` cert in the login keychain,
>   plus notarization creds — either `APPLE_API_KEY` / `APPLE_API_KEY_ID` /
>   `APPLE_API_ISSUER` (App Store Connect API key, preferred for CI) **or**
>   `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`. Then
>   `forge.config.js` has electron-packager sign with the Hardened Runtime +
>   `build/entitlements.mac.plist`, notarize, and staple the ticket, so the
>   build launches with **no Gatekeeper "Apple could not verify …" block**.
>   `make-mac-zips.mjs` then verifies + zips as-is (it must NOT re-sign, which
>   would strip the notarization). Because the FusesPlugin flips fuse bytes in
>   `packageAfterCopy` (before packager's signing step), the signature covers
>   the flipped bytes and stays valid — so `resetAdHocDarwinSignature` is
>   turned OFF on this path. Still Mac-only (codesign/notarytool are macOS).
> - **Ad-hoc (fallback, when the identity is unset).** The build is ad-hoc
>   signed only, so Gatekeeper shows "Apple could not verify …" and users must
>   "Open Anyway" once. electron-forge's FusesPlugin flips fuse bytes AFTER the
>   ad-hoc sign, invalidating the Electron Framework signature — on Apple
>   Silicon the app gets SIGKILLed at launch (`Code Signature Invalid`). The
>   fix is a full `codesign --deep` re-sign in `make-mac-zips.mjs`, which
>   **only works on macOS**, so darwin artifacts MUST be built/signed on a Mac
>   (`npm run fix:mac` to repair an existing release). Two gotchas the scripts
>   already handle: sign in a `/tmp` copy (an iCloud-synced folder keeps
>   re-applying the `com.apple.FinderInfo` xattr that codesign rejects), and
>   stamp the rebuilt bundle with `DOCVEX_APP_VERSION` or the updater re-prompts
>   forever. The in-app self-updater also re-signs each download on the user's
>   Mac as a safety net.
>
> `npm run fix:mac` honours the same env vars — set them and it repairs an
> existing release's darwin zips as notarized builds. Notarization is a
> Developer ID feature ($99/yr Apple Developer Program); without the cert only
> the ad-hoc path is available. (The `.dmg` from `maker-dmg` isn't separately
> notarized, but the `.app` inside it carries its own stapled ticket, so it
> still launches clean.)

No tests, no linter (`npm run lint` is a stub).

## Tech stack

- **Electron 42** + **Electron Forge 7** (Vite plugin orchestrates main / preload / renderer Vite builds)
- **React 19** + **react-router-dom 7** (MemoryRouter on Electron, BrowserRouter with `basename=/app` on web)
- **Supabase JS 2** — auth, Postgres + RLS, Realtime, Edge Functions
- **pdf.js 5** for in-app PDF preview (`pdfjs-dist`), **html2canvas** for the Report-a-Problem screenshot capture
- **docx-preview** for rendering `.docx` files (Doc Viewer / `lib/openDocxWindow.js`); lazy-imported so its weight isn't paid until a Word doc is opened
- **Document generation/export** (lazy-imported): **docx** + **pptxgenjs** + **xlsx** (SheetJS) + **jspdf** build real Office files in `lib/documentGen.js` (the AI "Generate" feature — Anthropic Skills sandbox path with a local-builder fallback); **jspdf + html2canvas** power `lib/exportPdf.js` (the office-preview "Convert to PDF"). **word-extractor** (main process) reads legacy `.doc`.
- **react-markdown + remark-gfm** for rendered release notes
- **update-electron-app** → `update.electronjs.org` feed for packaged auto-updates
- **`doc-ai` Edge Function** — Claude (OCR) + OpenAI Whisper (audio transcription) powering the Doc Viewer's "Extract text" and captions tools

## High-level architecture

`forge.config.js` runs three Vite configs (main, preload, renderer). The Vite plugin injects `MAIN_WINDOW_VITE_DEV_SERVER_URL` / `MAIN_WINDOW_VITE_NAME` globals into the main process — `src/main.js` reads them to decide dev-server vs file-loaded bundle.

`src/renderer.jsx` is the Electron entry; `src/web.jsx` is the web entry. They mount the same `<App />` but differ in router type, basename, and which platform shims load. The provider stack (renderer.jsx) is:

```
MemoryRouter
  AuthProvider
    ThemeProvider            — needs auth (per-user theme key); outermost so
                              data-theme is on <html> before first paint
    AppPrefsProvider
      SelectedProjectProvider — per-user storage; auto-clears on access loss
        UpdatesProvider
          NotificationsProvider — source hooks need auth + updates
            ChatUnreadProvider
              <App />
            <NotificationCenter />  — sibling of <App />, toasts at z 9999
```

`web.jsx` uses the identical provider order, differing only in router
(`BrowserRouter basename='/app'`). The former `SplitViewProvider` was removed —
SplitView is now a single-pane shell (`components/SplitView.jsx`) that publishes
its header/footer chrome through `PaneChromeContext` (per-pane, in-memory)
rather than a global multi-pane context.

### Routing

`src/AppRoutes.jsx` defines the full route tree, extracted so it can be rendered both by the main window shell (with the sidebar) and by each SplitView pane (sidebar-less, own MemoryRouter) — `Shell` / `ProjectShell` are passed in as props so the two surfaces can't drift. All page modules are `React.lazy`-imported.

- `/auth` — full-screen, no shell. (The standalone `/launch` hub was removed; the project list at `/projects` is the in-app hub.)
- `/doc-viewer` — full-screen Doc Viewer window (file preview + Legal AI panel), opened from the Files page.
- `/` — wraps everything in `Shell`.
  - Public: `/` (Activity feed), `/versions` (release history; `/updates` redirects here), `/newsletter`, `/notifications` (redirects to `/`), `/invite/:token`.
  - Dev-only: `/debug`.
  - `ProtectedRoute`: `/account`, `/settings`, `/admin`, all `/projects/*`, and project-scoped tools (`/files`, `/clients`, `/todos`, `/chat`, `/generate`, `/automate`, `/ai`, `/mail`) which read the active project from `SelectedProjectContext` rather than a URL param.
  - `/projects/:projectId` wraps `Overview` + `Dashboard` in `ProjectShell`, sharing one fetch and one Realtime channel.

### Main ↔ Renderer IPC contract

`src/preload.js` is the only bridge — exposes `window.electronAPI` via `contextBridge`. Adding any main capability requires editing both files.

- **OAuth / deep-links:** `oauth:open-external` (send), `oauth:callback-url` (receive); `app:get-startup-deep-link` (one-shot pull of a `docvex://` URL captured from `process.argv` at cold start).
- **Updates:** `app:get-version`, `app:is-packaged`, `app:get-platform-info` (`{ platform, arch }`), `update:check`, `update:install`, `update:status` (main → renderer lifecycle events), `update:download-and-install` (macOS self-updater — downloads + extracts + re-signs the arch zip).
- **Window controls (frameless):** `window:minimize / toggle-maximize / close / is-maximized / maximized-changed / is-fullscreen / fullscreen-changed`, and `window:auth-state` (`'locked' | 'app' | 'unlock'` — drives the title-bar chrome before auth). Backs the custom React `TitleBar`. `setZoomFactor` / `getZoomFactor` wrap webFrame zoom (Settings display-scale).
- **In-app file windows / Doc Viewer:** `app:open-file-window`, `app:open-html-window`, `app:open-docx` (Word fallback chain), `window:open-doc-viewer`; the Doc Viewer multi-tab bus is `doc-viewer:add-file / list / focus / close / tabs`.
- **Cross-window file sync:** `files:removed` (paths) and `files:changed` broadcast so other windows refresh their listings.
- **Legacy-format extraction (main-process):** `doc:extract-text` (legacy `.doc` via word-extractor), `whatsapp:prepare-zip / prepare-folder / detect` (WhatsApp export ingest).
- **Dev menus:** `account:switch-to` (dev-only Account menu), `debug:clear-cache`, `debug:send-test-notifications`, `debug:send-email-previews`.
- **External URLs:** `app:open-external` is filtered to `http(s)` only — preserve that filter when adding sibling channels.
- **Local folder (Files page), `local-folder:*`:** `pick / project-dir / list / list-recursive / download / write-files / delete-files / rename-file / create-folder / delete-folder / move / open-path / save-as / extract-archive / show-in-folder / watch / unwatch / changed / read-sidecar / write-sidecar`, plus a recycle-bin set writing a `.docvex-trash/` folder: `trash-file / trash-folder / list-trash / restore-from-trash / delete-from-trash / purge-trash` (sweeps entries > 30 days). The watcher is debounced ~200 ms; only the active folder is watched.

### Custom protocol `docvex://`

Supabase Google OAuth round-trips through Supabase's hosted callback then redirects to `docvex://auth/callback?code=...`. The OS routes it back:

- **Windows:** single-instance lock + `app.on('second-instance', argv => …)` finds the URL in `argv`.
- **macOS:** `app.on('open-url', ...)`.
- **Cold-start race:** if the app wasn't running, `second-instance` never fires — main scans its own `argv` once at startup and exposes it via `app:get-startup-deep-link`, which the renderer pulls once during AuthContext mount.

Critical dev-mode detail: when `process.defaultApp` is true (under `electron-forge start`), `setAsDefaultProtocolClient` MUST be called with the explicit electron exe + app path, otherwise Windows tries to run `electron.exe "docvex://..."` and treats the URL as a path. See the registration block in `src/main.js`.

### Supabase auth flow

`src/lib/supabaseClient.js` sets `flowType: 'pkce'` and `detectSessionInUrl: false`. PKCE → `?code=...` query (parseable via `URLSearchParams`) instead of `#access_token=...` fragment which is awkward in a custom-scheme callback. Disabling `detectSessionInUrl` prevents supabase-js from poking at `window.location`, which is meaningless under MemoryRouter.

`AuthContext` listens for `oauth:callback-url` and calls `supabase.auth.exchangeCodeForSession(code)` itself.

`eraseData()` (distinct from `signOut()`) calls `signOut({ scope: 'global' })` to revoke refresh tokens server-side across all devices, then defensively clears `sb-*` / `supabase.*` keys from `localStorage`. `deleteAccount()` calls the `delete-user` Edge Function with the user's JWT.

### Custom `localfile://` protocol

Registered with privileges `standard | secure | supportFetchAPI | stream | bypassCSP | corsEnabled` so `<img src>`, `<video src>`, AND `fetch()` from the Vite dev origin all work. The renderer URL-encodes the full path as one segment; `protocol.handle('localfile', …)` decodes it, streams via `fs.createReadStream` wrapped in a `Response` (so `<video>` byte-range works without buffering whole videos in memory). A `?thumb=N` query returns an OS-downscaled thumbnail (cached, bounded) for image/doc tiles; HTTP Range requests are honoured (206) for media seeking.

### Auto-update pipeline

Two layers running in parallel — don't confuse them:

1. **`update-electron-app` in `src/main.js`** (packaged builds only) — polls `update.electronjs.org` every 10 min, which reads GitHub Releases for `petreluca1105-dotcom/docvex`. Squirrel.Windows downloads in background, installs on next launch.
2. **`UpdatesContext` in renderer** — fetches `https://api.github.com/repos/petreluca1105-dotcom/docvex/releases` (cached in `sessionStorage` under `docvex:releases-cache:v1`, 1 h TTL) and subscribes to `update:status` events from main. Drives the sidebar badge + the Updates page banner.

Layer 1 is the source of truth for "is an installer downloaded and ready?" → `update-downloaded` → `update:status { state: 'downloaded' }` → renderer shows "Restart & install". Layer 2 shows release notes + version-mismatch. Works in dev too (no Squirrel needed). Web returns `state: 'web'`.

**Windows-only Squirrel.** Layer 1 is gated on `AUTO_UPDATE_SUPPORTED` (`process.platform === 'win32'`) — the macOS build isn't Developer-ID signed, so Squirrel.Mac can't apply updates. `update:check` returns `{ state: 'unsupported' }` on macOS/Linux.

**macOS self-updater.** `update:download-and-install` (main) downloads the arch-correct release zip (`installerAssetFor` in `UpdatesContext`), extracts with `ditto`, strips xattrs + ad-hoc re-signs (`xattr -cr` then `codesign --force --deep --sign -`) to repair the fuse-invalidated signature, then a detached script swaps the `.app` and relaunches (with rollback). Progress flows back as `update:status { state: 'downloading', percent }` → `'installing'`. On failure it falls back to a browser download (`downloadUpdate`); Linux always uses that fallback.

Semver compare is a tiny inline `semverGT()` in `UpdatesContext.jsx` — `major.minor.patch` only, strips `v` prefix and pre-release suffix.

## Theme system

`src/styles/tokens.css` defines all colour tokens. Two themes: **Cream** (default) and **Ink** (dark variant). Selectors are scoped via `[data-theme="…"]` on `<html>`, set by `ThemeContext`. Brand constants live on bare `:root`, semantic aliases live on `:root[data-theme="cream|ink"]`.

The unsuffixed `:root` block also paints in Cream so the first frame before React mounts isn't a flash. The bare `[data-theme="…"]` selector (without `:root`) lets ANY element declare its own subtree theme — `ThemePicker.jsx` uses this so each preview card paints in its own theme regardless of the app's active theme.

**Brand palette:** `--color-ink`, `--color-slate`, `--color-sand`, `--color-cream`, `--color-cognac`.

**Semantic tokens** (every component reads via `var(...)` — no hex literals):

```
--bg-page / --bg-card / --bg-elevated / --bg-sidebar / --bg-input
--border / --border-strong
--text-primary / --text-secondary / --text-muted / --text-on-accent
--accent / --accent-hover / --accent-soft / --accent-tint
--danger / --danger-soft / --danger-text
--success / --success-soft
--warning / --warning-soft
--info / --info-soft
--shadow-card / --shadow-elev
--overlay-scrim / --scrollbar-thumb
```

**Notification category palette:** `--cat-auth / project / member / file / role / update / support / system` (darker on Cream, lighter on Ink so each category reads at a glance in the toast stack + history view).

**Typography:** `--font-body` = Inter; `--font-display` = Plus Jakarta Sans. Loaded via `<link>` in `index.html` / `index.web.html`.

Adding a third theme = 30-line addition (new `:root[data-theme="…"]` block + entry in `ThemeContext`'s themes list).

## Context layer

All under `src/context/`. Every hook returns plain objects; no Redux / Zustand. Persistence keys all share the `docvex.*` prefix. `SplitViewContext` was removed (see the provider-stack note above); `PaneChromeContext` is in-memory and per-pane (publishes a pane's header/footer chrome into the SplitView shell via `usePaneChromeSlot`).

| Context | Exported shape (via `useXxx()`) | Persistence |
| --- | --- | --- |
| **AuthContext** | `{ session, loading, lastAuthEvent, signInWithEmail, signUpWithEmail, signInWithGoogle, linkGoogle, setPassword, signOut, logout, eraseData, deleteAccount }` | Supabase-js native (`sb-*` keys); `lastAuthEvent.at` timestamps repeated events so downstream effects can distinguish back-to-back TOKEN_REFRESHED firings. |
| **AppPrefsContext** | `{ prefs: { textSize, thumbnails, reduceMotion, fileView, language, showTokenUsage }, setPref(key, value), resetPrefs }` | `docvex.appPrefs.<userId>` (JSON). Side-effects on change: `data-reduce-motion` on `<html>`, display-scale via `appScale`/`platform.setAppZoom`. |
| **ChatUnreadContext** | `{ unreadCount, markRead() }` | `docvex.chat.lastRead.<userId>.<projectId>` (ISO ts); Realtime sub on `chat_messages` per project. |
| **PaneChromeContext** | `usePaneChromeSlot({description})` (publish), `usePaneChromePortalEl()` / `usePaneChromeFooterEl()` (chrome targets) | None — in-memory, one provider per SplitView pane. |
| **ThemeContext** | `{ theme (resolved `cream`/`ink`), themePreference (`cream`/`ink`/`system`), setTheme, themes: [{ id, label, description, swatchOrder }] }` | `docvex.theme.<userId>` (+ `docvex.theme.last` signed-out fallback). `system` tracks the OS via `matchMedia`. |
| **SelectedProjectContext** | `{ selectedProjectId, selectedProject, loading, selectProject(id, prefetched?), clearSelection, patchSelectedProject(patch), pickerOpen, openPicker, closePicker, togglePicker, switching, switchingToName, beginSwitch(name) }` | `docvex.selectedProject.<userId>` |
| **ProjectContext** (URL-scoped) | `{ project, role, members, customRoles, loading, error, refresh, refreshCustomRoles, removeMemberLocal, setMemberRoleLocal, removeCustomRoleLocal }` | None — Realtime subs + optimistic local mutations |
| **NotificationsContext** | `{ notifications, activeToasts, unreadCount, notify(payload), dismissToast(id), markRead(id), markAllRead, remove(id), clearAll }` | `docvex.notifications.v1.<userId|_anonymous>` (debounced). `HISTORY_CAP = 100`, `MAX_ACTIVE_TOASTS = 3`. |
| **UpdatesContext** | `{ currentVersion, latestVersion, isPackaged, releases, loading, error, hasUpdate, installerState, checkNow, installUpdate }` | `sessionStorage` `docvex:releases-cache:v1` |
| **ReportProblemContext** | `{ open, capturing, screenshot: { blob, dataUrl } | null, captureAndOpen, close, removeScreenshot }` | None; html2canvas is lazy-imported so the first render doesn't pay the cost. |

**Provider-order constraints** to remember:
- ThemeProvider above everything else that renders so `data-theme` is set before first paint.
- AppPrefsProvider sits below ThemeProvider, above SelectedProjectProvider.
- ChatUnreadProvider wraps `<App />` inside NotificationsProvider (chat unread badges). `NotificationCenter` is a sibling of `<App />`, not nested.
- `NotificationCenter` mounts as a sibling of `<App />` so its toasts (z 9999) render above any modal.

## Library layer (`src/lib/`)

| File | Purpose |
| --- | --- |
| `supabaseClient.js` | Singleton supabase-js client (PKCE, no auto-detect-in-URL). |
| `projects.js` | Project CRUD + member listings + auth-user profile upsert. |
| `thumbnails.js` | Byte-level thumbnail generators (canvas / pdf.js / PPTX preview / DOCX render). Only the *fallback* path — see `thumbnailEngine.js`. |
| `thumbnailEngine.js` | The thumbnail system. Turns a file into an ordered list of candidate URLs (OS thumbnail via `localfile://…?thumb=N` → original bytes → renderer-generated blob) that `FileThumbnail` walks on error. Owns the bounded generation queue, single-flight, refcounted blob cache, and failure memo. |
| `pdfCache.js` | Module-level cache of parsed pdf.js documents, keyed by content hash. Evicted from the "Debug → Clear all cached data" menu. |
| `pdfWorker.js` | pdf.js worker entry point used by pdfCache. |
| `localBranchMeta.js` | Per-(project, folder) `.docvex.json` sidecar — gives each local file a stable id that survives renames. `loadSidecar`, `saveSidecar`, `addEntry`, `removeEntry`, `removeByFilename`, `renameEntry`, `reconcileWithFilesystem`, `fileIdForFilename`, `entryForFileId`. |
| `localFolder.js` | Unified electron/web folder API (`localFolderApi.pick / list / download / writeFiles / deleteFiles / renameFile / openPath / showInFolder / watch / unwatch / onChange / readSidecar / writeSidecar / persistPickedHandle / restorePersistedHandle / reconnectHandle / forgetPersistedHandle`). Web backend uses `showDirectoryPicker`, persists the `FileSystemDirectoryHandle` in IndexedDB (`docvex-fs-handles` / `handles` store, key = projectId), 3 s poll for change detection. `readLocalBlob(pathOrName)` returns a Blob via `localfile://` (Electron) or the cached file handle (web). |
| `notifications.js` | Pure helpers: `NOTIFICATION_CATEGORIES / VARIANTS / PRIORITIES`, `buildNotification`, `resolveDedupeStrategy`, `formatRelativeTime`, `storageKeyForUser`. |
| `notificationsRepo.js` | Supabase IO for the `notifications` table: `fetchRecent`, `insertOne(row, { ignoreDuplicates })` (upsert on `(user_id, dedupe_key)`), `deleteByDedupeKey`, `markRead`, `markAllRead`, `deleteOne`, `deleteAllForUser`, `subscribeForUser`. |
| `customRoles.js` | `listCustomRoles(projectId)`, `subscribeForProjectRoles`. Custom role = `base_role` + `custom_role_capabilities` overrides; resolution happens server-side via `has_capability()`. |
| `userStatus.js` | User status enum (online / away / dnd / offline) + `getStatusForUser`. |
| `recentProjects.js` | localStorage map of `projectId → lastAccessedAt` per `userId`. `markProjectAccessed`, `getMostRecentProjectId`, `getRecentMap`, `sortProjectsByRecent`. |
| `support.js` | `sendSupportReport({ category, title, body, screenshot? })` — fire-and-forget to `send-support-report` Edge Function. |
| `sendWelcome.js` | Fire-and-forget `send-welcome` Edge Function; no-op when already sent. |
| `plan.js` | `PLAN = { tier: 'Free', features: [...] }` placeholder — read in Account page AND Sidebar footer pill; update both when wiring real plans. |
| `platform.js` | Electron / web adapter: `isElectron`, `getAppVersion`, `isPackaged`, `showInFolder`, `openPath`, `onDeepLink`, `onAccountSwitch`, `openOAuthUrl`, `checkForUpdates`, `installUpdate`, `onUpdateStatus`, `showOSNotification`. Web stubs out anything that can't work in a browser. |
| `legalFeed.js` | Legal Newsfeed (Newsletter) data layer. `listLegalUpdates()` (embeds the user's `legal_update_states`), `setUpdateRead`/`setUpdatePinned`/`setUpdateSaved`, `getWeeklyDigest()` (invokes `legal-ai`'s `digest` action, cached 1 h in `sessionStorage`). |
| `ocr.js` / `transcribe.js` | Doc Viewer "Extract text" (Claude OCR) and audio/video captions (Whisper) — both call the `doc-ai` Edge Function. `transcribe.js` ships only the audio: for **video** it extracts the audio track in-renderer (Web Audio `decodeAudioData` → downmix + resample to 16 kHz mono → 16-bit PCM WAV; **no ffmpeg dep**) so the upload stays under Whisper's 25 MB cap (~13 min of speech). |
| `extractionHistory.js` | Per-file localStorage history of OCR snippets for the Doc Viewer (a *list* per file). |
| `captionsHistory.js` | Per-file localStorage cache of the audio pane's AI transcript — *one* result per file (text + timed segments + language), so reopening a file restores captions instantly instead of re-paying for Whisper. Key prefix `docvex:doc-viewer:captions:`. |

Other notable `lib/` modules (read source for depth):

| File | Purpose |
| --- | --- |
| `projectAi.js` | Client wrapper for the `project-ai` Edge Function + the `AI_MODELS` picker catalog. Backs the AI hub. |
| `documentGen.js` | AI document generation — builds `.docx`/`.pptx`/`.xlsx`/`.pdf` via the Anthropic Skills sandbox (Path A) with local builders (docx / pptxgenjs / SheetJS / jsPDF) as the offline fallback (Path B). |
| `exportPdf.js` | Office-preview → PDF (lazy `html2canvas` + `jspdf`), one page per rendered element. |
| `conversationHistory.js` | Per-file localStorage cache of the Doc Viewer AI-advisor thread + generated-doc iterations (`docvex:doc-viewer:conversation:<path>`). |
| `mail.js` | Gmail/Outlook OAuth client for the Mail tab (`mail-sync` / `mail-callback`), three-leg PKCE-style flow. |
| `admin.js` | `get_admin_stats` aggregates + admin-allowlist CRUD (`app_admins`). |
| `appZoom.js` / `appScale.js` | `appZoom.js`: base-zoom constant (now **1**) + `toLayoutPx` viewport→layout-px helper. `appScale.js`: normalises the Settings display-scale preference (70–125%, 5% steps). |
| `audioEnvelopeCache.js` / `captionPosition.js` | Doc Viewer audio: cached waveform envelope (LRU, base64 in localStorage) and the persisted caption-overlay position. |
| `chat.js` / `privateMessages.js` | Supabase IO for `chat_messages` (+ reactions, threads, pins) and `private_messages` (DMs). |
| `extractFileText.js` | Best-effort text extraction (txt/PDF/DOCX/XLSX) for AI attachments. |
| `useChatFind.js` | Find-in-conversation via the CSS Custom Highlight API (no DOM mutation). |
| `fileDragBus.js` / `folderColors.js` / `projectsDir.js` / `projectFilesPrefetch.js` | Files-page support: rich drag-preview bus; per-folder colour tags; per-user "projects folder" pref; background Files warm-cache (Electron-only). |
| `thumbnailDescriptor.js` | Descriptor builders (`describeLocalFile` / `describeLooseFile`) feeding `thumbnailEngine.js`. |
| `whatsappChat.js` | WhatsApp `.txt` export parser/detector (Android + iOS layouts). |
| `aiFileIndex.js` | One-time per-file AI description (Haiku, batched 8 text / 4 images), cached in `localStorage` (`docvex:ai-file-index:v1`) against size+mtime. Makes AI search cheap: a photo is decoded and uploaded once in its life, not once per search. |
| `aiSearchCache.js` | AI-search answer cache — `(folder signature, normalised query) → hits` in `docvex:ai-search-answers:v1`. A repeat search costs nothing; any add/delete/rename/edit changes the signature and invalidates the folder's answers. |
| `metadataPrefetch.js` | Background sweep that extracts + caches file metadata (`metadataHistory.js`) as files appear in a folder, so the Doc Viewer's Metadata tab is pre-filled. One file at a time, on idle, size-capped, cancelled by the next listing. |
| `activityMetrics.js` | Personal Activity-page metrics (heatmap, streak, breakdown). |

## Supabase data model

Project ID `pntxlvhkqfryyyxlqytr` (eu-west-1, organization `docvex.ro`). Modify via the `claude_ai_Supabase` MCP tools (`list_tables`, `apply_migration`, etc.). **No cloud file store** — the `drop_branching_and_cloud_files` migration (2026-06-02, "migration 031") dropped the tables `project_files`, `change_requests`, `change_request_items`, `branch_changes`, `project_member_branches`, the `projects.main_version` column, and the branching RPCs. The `projects` / `projects-pending` **storage buckets still physically exist** in the project but are orphaned — the app no longer reads or writes them (files are local-only). They're a cleanup candidate, not a live dependency.

Migrations continued **after** the branching drop (it is NOT the latest): the admin stack (`admin_stats_rpc`, `app_admins_table_and_rpcs`, `app_services_inventory`), the Mail stack (`create_user_mail_connections`, `create_mail_oauth_states`), and `create_enrollments` (the current latest, 2026-06-17). Use `list_migrations` for the authoritative order.

### Tables (current)

| Table | Notable columns | Notes |
| --- | --- | --- |
| `projects` | `id, name, description, created_by, created_at, updated_at, ai_context?, ai_context_updated_at?` | `add_creator_as_owner` trigger inserts owner row. `ai_context*` (migration 030) feeds the Project AI tab — admin-writable. |
| `project_members` | PK `(project_id, user_id)`, `role` enum (`owner/admin/member/viewer`), `custom_role_id?`, `added_at` | RLS via `has_project_role` / `has_capability`. |
| `project_invitations` | `id, project_id, email, role, custom_role_id?, token unique, invited_by, created_at, expires_at (+7d), accepted_at?` | Unique on `(project_id, lower(email))` WHERE `accepted_at IS NULL`. Consumed by `accept-invite` Edge Function → `accept_invitation` RPC. |
| `custom_roles` | `id, project_id, name, description, base_role` (`admin/member/viewer`, owner excluded) | Migration 008. |
| `custom_role_capabilities` | PK `(custom_role_id, capability)`, `granted bool` | `project_capability` enum: `files.view/upload/delete_any/delete_own`, `members.invite/remove/change_role`. Row absence = inherit from base tier. |
| `project_ai_usage` | `id, project_id, user_id?, action, model, input_tokens, output_tokens, session_id?, created_at` | Migration 030. Backs the Project AI usage panel via `get_project_ai_usage`. |
| `notifications` | `id, user_id, category, variant, priority, title, body, icon?, payload jsonb, created_at, read_at?, dedupe_key?` | Unique `(user_id, dedupe_key)`. Index `(user_id, created_at DESC)`. |
| `chat_messages` | `id, project_id, author_id, body, mentions uuid[], attached_file_ids uuid[], created_at, edited_at?, deleted_at?, parent_id?, pinned_at?, pinned_by?` | Soft-delete via `deleted_at`. `parent_id` / pin columns + `chat_message_reactions` table from migration 026. |
| `private_messages` | — | DM messages; see `lib/privateMessages.js`. |
| `legal_updates` | `id, slug unique, category, impact (low/medium/high), title, source?, citations?, summary?, areas text[], raw_content?, ai_status, published_at, created_at, updated_at` | Global Legal Newsfeed, not project-scoped. Migration 029. Public read (`for select using (true)`); written only by `legal-ai` Edge Function (service role) or seed. |
| `legal_update_states` | PK `(user_id, update_id)`, `read_at?, pinned_at?, saved_at?, updated_at` | Per-user read/pin/save flags. Migration 029. RLS: `user_id = auth.uid()`. |
| `chat_message_reactions` | `(message_id, user_id, emoji)` | Emoji reactions on `chat_messages` (migration 026). Toggled via `lib/chat.js`. |
| `app_admins` | app-admin allowlist | Backs `is_app_admin` / the Admin page gate. Not project-scoped. |
| `app_services` | service-inventory rows | Powers the Admin "Developer Console" service tracker (Supabase/Anthropic/Resend/domains). |
| `user_mail_connections` | per-user mailbox tokens (encrypted at rest) | Gmail/Outlook OAuth connections for the Mail tab; tokens AES-GCM-encrypted by `mail-sync` (`MAIL_TOKEN_KEY`). |
| `mail_oauth_states` | OAuth nonce/state rows | Short-lived CSRF/state records for the Mail OAuth round-trip (`mail-callback`). |
| `enrollments` | — | Present but unused (0 rows) — future feature; no live code path. |

### RPCs

| RPC | Purpose |
| --- | --- |
| `has_project_role(project_id, min_role)` | STABLE tier-check used by RLS. |
| `has_capability(project_id, capability)` | SECURITY DEFINER, custom-role-aware capability check (migration 008); supersedes `has_project_role` for files/members RLS. |
| `accept_invitation(token, user_id)` | SECURITY DEFINER. Atomically inserts `project_members` (propagating `custom_role_id`) + marks `accepted_at`. |
| `create_custom_role` / `update_custom_role` | SECURITY INVOKER. Atomically write a custom role + replace its capability overrides. |
| `get_member_profiles` / `get_member_profiles_status` | `(p_project_id uuid)` — joins `project_members` with auth user metadata (+ status). |
| `get_project_ai_usage(project_id, since?)` | SECURITY INVOKER, defaults `since` to start of current month. Monthly usage aggregate for the Project AI tab. |
| `get_admin_stats` | SECURITY DEFINER, email-allowlisted. Admin-page live metrics — see `lib/admin.js`. |
| `is_app_admin` | SECURITY DEFINER. True when the caller is in the `app_admins` allowlist — gates the Admin page + admin RPCs. |
| `current_user_has_password` | Whether the signed-in user has a password set (vs. OAuth-only) — drives the Account "set/change password" affordance. |
| `set_chat_message_pin` | Pin/unpin a chat message (migration 026). |

**Dropped in migration 031 — do not use:** `approve_change_request`, `approve_change_requests`, `_apply_change_request_items`, `reject_change_request`, `reject_change_request_item`.

### RLS patterns

- Project-scoped reads/writes call `has_project_role(...)` or `has_capability(...)`; deletes typically require admin/owner.
- Personal rows (`notifications`, `legal_update_states`) gate on `user_id = auth.uid()`.
- `accept_invitation` and `delete-user` (Edge Function) bypass RLS via SECURITY DEFINER.

### Storage

Project files are local-only (`lib/localFolder.js`, `.docvex.json` sidecar via `lib/localBranchMeta.js`) — the app reads/writes no Supabase Storage bucket. The legacy `projects` / `projects-pending` buckets still exist in the project but are orphaned (see the data-model note above); the only live bucket is `email-assets` (public), used by the email Edge Functions.

### AI providers + training posture

Docvex handles privileged legal material, so **no provider in this stack may
train on what users send.** That is a property of the *contract and endpoint*,
not of the model id — there is no "trains" vs "doesn't train" variant of a
model to switch between, and changing `claude-opus-4-7` to something else does
nothing for it. What matters is which company receives the bytes and under
which terms. The full list of third parties that ever see user content:

| Endpoint | Reached from | Sees | Training posture |
| --- | --- | --- | --- |
| `api.anthropic.com/v1/messages` | `project-ai`, `doc-ai`, `legal-ai`, `legal-assist` | document text, chat, OCR images, AI-search file stills | Commercial API terms: inputs/outputs **not** used for training. ~30-day retention for trust & safety; ZDR negotiable. |
| `api.anthropic.com/v1/files` + code-execution container | `project-ai` `office` action | generated Office files | Same commercial terms. |
| `api.openai.com/v1/audio/transcriptions` | `doc-ai` `transcribe` | recorded audio / video audio tracks | API traffic **not** used for training by default (since 2023-03); 30-day retention. |
| `api.deepgram.com/v1/listen` | `doc-ai` diarization | the same audio | **Weakest of the three.** Standard (non-Enterprise) terms allow using data to improve their models. Gated behind `DOC_AI_ALLOW_DEEPGRAM=1` on top of the key — see below. |

Rules for anything added later:

- **API endpoints only, never a consumer surface.** Consumer tiers (claude.ai,
  chatgpt.com) *do* train on conversations. Everything here is `api.*` with a
  server-held key, and it must stay that way.
- **Deepgram needs two opt-ins.** `DEEPGRAM_API_KEY` alone no longer enables
  diarization; `DOC_AI_ALLOW_DEEPGRAM=1` must be set too. A key sitting in the
  environment must not be enough to start shipping client and witness audio to
  the one provider whose default terms permit learning from it — that flag is
  the operator confirming their Deepgram contract forbids training.
- **New provider ⇒ check its default, not its marketing.** If the default is
  "we may train unless you opt out", either don't use it or gate it the same
  way Deepgram is gated, and add a row to the table above.
- Zero-Data-Retention is the remaining upgrade for Anthropic + OpenAI: both
  keep API payloads ~30 days for abuse monitoring unless a ZDR agreement is in
  place. Not the same thing as training, but it's the next thing a firm's
  security review will ask about.

### Edge Functions (`supabase/functions/`)

`accept-invite`, `send-invite`, `revoke-invite`, `send-welcome`, `send-support-report`, `delete-user` — shared HTML email templates in `_shared/emailTemplates.ts`; SMTP via Supabase, fire-and-forget from the client.

`legal-ai` — Claude-powered Legal Newsfeed AI. Raw REST to the Anthropic Messages API, model `claude-opus-4-7` (override via `LEGAL_AI_MODEL`). `{ action: 'digest' }` returns a weekly briefing (`{ ok, summary, highImpactCount, total, generatedAt }`, or `{ ok:false, error:'ai_not_configured' }` at 200 so the client falls back); `{ action: 'ingest', items: [...] }` classifies + summarises raw legal text into `legal_updates` (service role, gated on `x-ingest-secret` matching `LEGAL_INGEST_SECRET`). Needs `ANTHROPIC_API_KEY`.

`doc-ai` — Doc Viewer AI. Actions: `ask / summary / risks / romanian / draft / review` (Claude, `claude-opus-4-7`, override `DOC_AI_MODEL`), `ocr` (Claude, `claude-haiku-4-5`, `lib/ocr.js`), `transcribe` (OpenAI `whisper-1`, `lib/transcribe.js`; optional `DEEPGRAM_API_KEY` for speaker diarization). Needs `ANTHROPIC_API_KEY` (+ `OPENAI_API_KEY` for transcribe).

`mail-sync` / `mail-callback` — Gmail/Outlook OAuth sync for the Mail tab. `mail-sync` (JWT-gated) proxies the OAuth exchange and encrypts tokens at rest (`MAIL_TOKEN_KEY`); `mail-callback` is **public** (`verify_jwt = false`) — it bridges the provider redirect back to `docvex://` (or web `/mail`) via the `state` nonce. Needs `GOOGLE_CLIENT_ID/SECRET` and/or `MS_CLIENT_ID/SECRET`.

`project-ai` — backs the AI hub (`/ai`) and `project_ai_usage` logging. Actions `ask / suggest / generate / office`; model `claude-opus-4-7` (override `PROJECT_AI_MODEL`), with `office`/code-execution defaulting to `claude-sonnet-4-6` (`OFFICE_MODEL`). The model-picker catalog (`AI_MODELS` in `lib/projectAi.js`) now also offers `claude-opus-4-8`. Deployed as a neutral Claude.ai-style assistant (not a legal advisor); supports the real `ask_user` tool. Needs `ANTHROPIC_API_KEY`.

`legal-assist` — **deployed-only, no source under `supabase/functions/`** (it lives with the Word add-in in `docs/word-addin/`). Claude backend for the **DocVex Legal AI Microsoft Word add-in** (Office.js taskpane); JWT-gated, tasks `summary / risks / romanian / ask`; model `claude-opus-4-7` (override `LEGAL_ASSIST_MODEL` / `LEGAL_AI_MODEL`). Needs `ANTHROPIC_API_KEY`. This is a separate product surface from the in-app Doc Viewer — don't confuse it with `doc-ai`.

## Local project files

Each project's files live in a folder on the user's machine, picked via `localFolderApi` (`lib/localFolder.js`). `lib/localBranchMeta.js` maintains a `.docvex.json` sidecar in that folder — `{ version: 1, projectId, entries: { [fileId]: { filename, contentHash, mtime } } }` — giving each file a stable id that survives renames, syncs via Dropbox/iCloud, and re-attaches without prompting when the folder is re-picked. `ProjectFiles.jsx` (presentation: `components/FilesWorkspace`) owns folder nav, hashing, and sidecar reconciliation.

## Notification system

Three layers:

1. **Source hooks** (`src/notifications/sources/use*NotificationSource.js`)
   - `useAuthNotificationSource(notify, { ready })` — SIGNED_IN welcome, SIGNED_OUT goodbye.
   - `useUpdateNotificationSource(notify, { ready })` — installer state transitions (downloading / downloaded / restart).
   - `useSocialNotificationSource(notify, userId, { ready })` — placeholder hook for future @-mentions / DMs.
2. **Context** — `notify(payload)` accepts `{ category, variant, title, body, icon?, priority?, duration?, persistent?, dedupeKey?, osLevel? }`. Resolves dedupe strategy (`coalesce` / `replace` / `insert`), enforces the 3-toast cap, mirrors writes to Supabase + localStorage. Returns the notification id (existing id on coalesce).
3. **Action registry** (`src/notifications/actionRegistry.js`) — maps notification types to icons / actions / titles for the history view + test menu.

UI: `NotificationToast` auto-dismisses after `duration` (5 s default; `persistent: true` opts out), `NotificationCenter` is both the floating toast stack AND the `/notifications` page with category / priority filters. Icons live in `src/notifications/icons.jsx`; the dev "Send all test notifications" menu fires every entry in `src/notifications/testNotifications.js`.

**Realtime flow.** notify() mutates local state immediately, then asyncly mirrors to Supabase + localStorage. Realtime INSERT events from other devices dedupe by `id` (no re-toast). UPDATEs sync `read_at` across devices; DELETEs remove rows.

## Pages

### Root pages (`src/pages/`)

| Page | Purpose |
| --- | --- |
| `Activity` (`/`) | Signed-in landing — merged feed of activity + the old notifications inbox. Reads `NotificationsContext`; renders category-tinted activity cards with category **filter tabs** + a **Day / Category** group toggle + Mark-all-read / Clear-all. `/notifications` `Navigate`-redirects here. |
| `Account` | Profile, link Google, plan info (`lib/plan.js`), `eraseData` and `deleteAccount` actions. |
| `Updates` (`/versions`) | Release history, current vs latest, "Check now", installer state badge. |
| `Newsletter` (`/newsletter`) | Legal Newsfeed — Romanian legislation/compliance briefing. Typographically-led feed (masthead, AI-weekly line, Section/Impact/Search filters, day-grouped `ed-article` rows with category eyebrow + impact mark, AI-brief lead, "Affects …" meta line, per-item read/pin/mark/save). Data is real (`legal_updates` + `legal_update_states` via `lib/legalFeed.js`); AI weekly line from `legal-ai`'s `digest` action, cached 1 h (`docvex:legal-digest:v1`), with a local fallback when the AI key isn't configured. Public personal route (not behind `ProtectedRoute`), reached from the **Personal** sidebar section. Styles `ed-`-prefixed in `Newsletter.css`. |

Other root pages (read source for depth):
- `Admin` (`/admin`) — "Developer Console": `app_services` inventory tracker, mailbox-intelligence panel, live platform metrics (`get_admin_stats`), destructive-ops danger zone. App-admin-gated (`app_admins` allowlist / `is_app_admin`).
- `Settings` (`/settings`) — app preferences (theme, display scale, thumbnails, file view, reduce motion, token-usage indicator, language) + the Electron "projects folder" picker.
- `Mail` (`/mail`) — personal inbox with real Gmail/Outlook OAuth sync (`mail-sync` / `mail-callback`); AI-drafts replies in the user's voice with tone/length controls.
- `Debug` (`/debug`, dev-only), `DocViewer` (`/doc-viewer`).

### Project-scoped (`src/pages/Projects/`)

| Page | Purpose |
| --- | --- |
| `ProjectList` | "Editorial Dossier" layout — documents-masthead header (accent eyebrow + big display "Projects." title), a **Recently opened** featured-card tier (last-7-days from `recentProjects.js`) and **All projects** (full list). Member avatar stacks from `get_member_profiles`, per-project accent derived from the id hash. All `pjx-`-prefixed CSS in `ProjectList.css`. |
| `ProjectCreate` | New-project form. |
| `ProjectOverview` | `/projects/:id` landing — `pjd-`-prefixed "Dossier" shell: back-link, hero (serif name + description), a 4-cell meta strip (Files / Members / Joined / Last activity), tab bar **Overview · Members · Roles · AI · Settings**. **Overview**: usage gauges + real Team list + placeholder activity timeline. **AI**: project-context textarea (`projects.ai_context`, admin-writable) + usage stats backed by `project_ai_usage` / `get_project_ai_usage` (real, but zero until AI features log requests). **Members / Settings**: real member management + invites, rename/description + danger zone. **Roles**: `RolesDossier` — role-catalog cards with per-role headcounts + a capability-matrix table wired to `lib/customRoles` (tri-state inherit/grant/revoke, optimistic overlay + debounced persist), `CustomRoleEditor` for create/delete. Chrome + Roles styles in `ProjectDossier.css`. |
| `ProjectDashboard` | Tabbed project dashboard (Members via `TeamTree`, Activity). Tab persistence via `useSearchParams ?tab=`. The former "Pending edits" / version-control tab (change-request review) was removed with the branching system (migration 031). |
| `ProjectFiles` | Local-files page — folder picker, listing, hashing, sidecar reconciliation (`lib/localBranchMeta.js`), search/nav, every action handler. Presentation via `components/FilesWorkspace`. |
| `ProjectChat` | Team + Private (DM) chat — split-pane layout. **Team**: message thread + collapsible right rail (**Pinned / Threads / Mentions / Files** sub-tabs). **Private**: 3-column DM pane (member list · thread · shared-files rail). Bubbled messages with @mention chips, day dividers, attachment cards, typing dots; per-message hover actions (react / reply-in-thread / pin, + edit/delete on own); reactions strip, thread pill, header search, inline edit, scroll-to-latest pill. Data: `chat_messages` (+ `parent_id`, `pinned_at`/`pinned_by`, `chat_message_reactions` from migration 026; pinning via `set_chat_message_pin`). Lib: `src/lib/chat.js` (`listThreadReplies`, `listProjectReplies`, `sendThreadReply`, `setChatMessagePin`, `listReactionsForProject`, `toggleReaction`, `subscribeReactions`) + `src/lib/privateMessages.js`. Styles in `ProjectChatVariantB.css` (`dvx-`/`vb-`-prefixed), full-height via `.project-page-frame:has(.dvx-chat.vb-chat)`. Renders **chromeless + flush** like Files (`/chat` is in both `CHROMELESS_FULLSCREEN_ROUTES` and `FLUSH_CONTENT_ROUTES`): a big `.dvx-mh` masthead + a sticky single-row `.dvx-toolbar` mini-header (tabs + chrome tools), the composer portalled into the SplitView footer (`usePaneChromeFooterEl`), and an internal `.dvx-scroll-area` block scroll container (the sticky toolbar must be a *direct* child of the scroller, not a flex item, or it won't pin). The toolbar gets `.is-pinned` (rect-based detection: bar.top − scroller.top ≤ 8) which paints the `--bg-sidebar` background only while actually stuck at the top. |
| `ProjectGenerate / ProjectAutomate / ProjectClients` | Stubs for future features. |
| `ProjectTodos` | To-do list stub. |
| `TeamTree` | Org-chart view of project members + roles. |
| `InviteAccept` | Token-driven invite acceptance; public so unauthenticated invitees can land here and bounce through `/auth`. |

Newer project-scoped page (read source for depth): `ProjectAI` (`/ai`) — the project **AI chat**, backed by the `project-ai` Edge Function's `ask` action (+ `project_ai_usage` logging). Laid out exactly like the Chat tab (same `.dvx-mh` masthead / sticky `.dvx-toolbar` mini header / `.dvx-scroll-area` page scroller / footer-docked `.dvx-composer`): two tabs — **Chat** (a left rail of saved conversations with create/delete, per user+project in localStorage `docvex.aichat.v3.*`, plus the thread + composer) and **Debug** (intentionally empty). Labelled **Advisor** in the sidebar / pane nav / masthead. The assistant sees the whole project: `lib/aiProjectContext.js` builds a size-capped digest (project card + `ai_context`, members, the local-folder file inventory with cached `aiFileIndex` descriptions, the last team-chat messages — DMs excluded, the case timeline, OCR snippets, captions and file metadata) that rides transiently on each turn's last user message (never persisted into the thread, cached ~60 s). On top of that, attached (paperclip / drag-from-Files) or name-mentioned files get their full text extracted (`lib/extractFileText`) and inlined. The advisor can also CREATE files in the Files tab (Doc-Viewer-generate-style): turns run with `docTools: true`, `write_document` results build a real docx/pptx/xlsx/pdf via `buildDocumentBlobSmart` and save into the project folder (`localFolderApi.writeFiles` + `notifyFilesChanged`), and `ask_user` pauses into an inline `AskUserPanel` above the composer when the model is unsure whether/what to create (steer note in `FILE_STEER`). Styles in `ProjectAIChat.css` (+ the `.ai-hub` bubbles in `ProjectAI.css`); icons in `Projects/aiHub.jsx`. (The former AI hub with its five tools was removed; `ProjectAITools.jsx` remains on disk, orphaned. `components/ExtractionsPanel` and `lib/extractionHistory.js` still exist but are no longer mounted by any page.)

Shared layout: `ProjectScoped.css` provides the standard project page frame (sticky header, content container).

## Component patterns

All components live in `src/components/` with a sibling `.css` file.

### Modals

`ConfirmModal` is the base shape (title / body / confirm + cancel). Domain modals (`DeleteProjectModal`, `DeleteAccountModal`, `InviteMemberModal`, `ChangeMemberRoleModal`, `RemoveMemberModal`, `ReportProblemModal`) follow the same z-index conventions and overlay scrim (`var(--overlay-scrim)`). Toasts render at `z 9999` so they pop over any modal.

### Role gating

`RoleGate` renders children only when the user's role meets `minRole` (integer rank: viewer 0 → owner 3).
`RoleLocked` is the alternative pattern requested in user feedback: keep the feature rendered for everyone and overlay a "[role] only" mask for users who lack the role, so the layout is consistent and discoverable rather than disappearing.
`RoleBadge` is a coloured pill of the role name. `CustomRoleEditor` drives create/edit of custom roles; `RolesDossier` is the current capability-matrix surface on ProjectOverview (the older grid-based `RoleCapabilityMatrix` stays on disk, unused there).

### Tooltip + morph-pill

`Tooltip` is a cursor-following pill — fixed-position, `transform: translate(x, y)` updated on `mousemove`, animated via `transition: transform 45ms ease-out` (re-targets per move, no queue). Trigger wrapper uses `display: contents` so it doesn't add a layout box. It opens on hover and on **`:focus-visible` only** — `onFocus` early-returns unless `target.matches(':focus-visible')`, so a mouse/programmatic focus doesn't pop the pill at a stale screen location. A window `pointermove` safety net (gated on a `shown` flag) hides it when the pointer leaves the trigger node (`node.contains(under)`), covering missed `mouseleave`s.

**Use `<Tooltip>`, not native `title=`.** Hover hints throughout the app go through this component (DocViewer, FilesWorkspace, AppShell, AskUserPanel, Sidebar, SplitView, TokenUsagePill, TitleBar). The only remaining `title=` usages are component *props* (PageMasthead/ConfirmModal/DangerRow/SettingCard/StreamDoc), not native HTML tooltips — don't reintroduce a raw `title=` attribute.

**Morph-pill FLIP recipe** (`useMorphPill.jsx`, used by FilesWorkspace tiles and elsewhere). Same DOM node serves as hover tooltip and right-click menu; the menu state adds an `.is-menu` modifier and a FLIP animation morphs between sizes. The CSS `transition: transform` is intentionally suppressed (`.is-menu { transition: none; }`) so a JS-set inline `transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1)` can drive the morph without racing.

Recipe per right-click:
1. Snapshot the pre-menu rect (`oldPillRectRef = pillRef.current.getBoundingClientRect()`).
2. Toggle `menuMode = true`; React commits the larger menu layout.
3. `useLayoutEffect`: compute `sx = oldRect.width / newRect.width`, `sy = oldRect.height / newRect.height`. Snap `translate(x, y) scale(sx, sy)` with no transition. Force reflow.
4. Add `transition: transform 220ms`; set `translate(x, y) scale(1, 1)` — GPU-composable.

Dismissal: Escape, scroll (capture), outside `mousedown`, or mouseleave on the menu when `pointer-events: auto` is in effect.

### FilesWorkspace

`FilesWorkspace.jsx` + `.css` — presentation layer for the local Files page: file-explorer-style chrome, tile/list canvas (Ctrl+scroll zoom), `useMorphPill` hover/right-click menus per tile/row. Driven entirely by props from `ProjectFiles.jsx`; holds only local UI state (view mode/zoom, search, selection, menu/properties open). All `fx-`-prefixed CSS. Currently being reworked alongside the migration-031 local-files pivot — read directly for the current tab/action structure.

### Status + theme

- **StatusBadge / StatusPicker** — user status enum (`online / away / dnd / offline`).
- **ThemePicker** — mock cards painted via `[data-theme="…"]` on each card so they preview in their own theme regardless of the app's active theme.

### Layout

- **AppShell** — wraps Sidebar + content; mounts the global ReportProblem modal, the `CursorSpotlight`, the `UpdateProgressBar`, and the `SplitView` content shell.
- **Flush-left layout + route sets.** `.app-chrome` uses `gap: 0` so page content sits **flush against the sidebar** (no gap); the window-edge inset (top/right/bottom) still comes from `.app-shell` padding, and right-side padding is kept so content doesn't hug the scrollbar. Two route sets drive per-route chrome:
  - `CHROMELESS_FULLSCREEN_ROUTES` (`SplitView.jsx`) — render WITHOUT the in-content chrome bar (page carries its own masthead): `/`, `/newsletter`, `/versions`, `/settings`, `/debug`, `/mail`, `/projects`, `/account`, `/files`, `/chat` (+ the exact `/projects/:id` overview).
  - `FLUSH_CONTENT_ROUTES` (`AppShell.jsx`) — full-bleed editorial surface (no rounded frame, negative margins to the window edges, flush to the rail): `/`, `/newsletter`, `/versions`, `/files`, `/chat` (+ the exact `/projects/:id` overview). Non-flush "card" pages get a flattened left edge (`border-left:none`, no left radius) so they still sit flush against the rail.
- **Unified mini-headers.** Every tab's compact sticky header is the same shape: a rounded `--bg-sidebar` section (matches the window top bar), `height: 40px`, `border-radius: 9.6px`, `top` offset by `--chrome-inset` (so it doesn't tuck behind the sidebar), right gap = the tab's content width, with `padding` matching Files. Per-surface class names: `pmh-compact` (PageMasthead — Activity/Versions/Newsletter/Settings/Debug), `pjd-compact` (ProjectOverview), `dc-compact` (Admin), `fx-pathbar` (Files), `dvx-toolbar` (Chat). Each gets `.is-pinned`/`is-pinned` only when actually stuck at the top (rect-based detection), painting the bg then and staying transparent while scrolling under the masthead.
- **Sidebar** — 60 px collapsed, 220 px expanded on `:hover` / `.locked`. `.label` elements fade via opacity. Anything interactive that should respond when expanded needs `pointer-events: auto` in the `:hover` / `.locked` rule (see `.lock-btn`). Auth-aware footer swaps between Account NavLink + avatar / username / tier and a "Sign in" CTA. Has a cursor-following spotlight glow (see the zoom/native-event Conventions notes).
- **TitleBar** — custom frameless title bar (Electron): window controls + Documentation/Theme/Updates/Account, driven by the `window:*` IPC. Layout reserves `--titlebar-h`. (`ProjectPickerPanel` was removed.)
- **SplitView** — single-pane content shell; portals a pane's header/footer chrome into fixed slots via `PaneChromeContext` (it replaced the old multi-pane SplitView + its context).
- **ProjectBanner** — small **fixed-position pill** at top-centre of the viewport ("Working in <project>"), border-radius 999 px, shadow `0 8px 24px rgba(0,0,0,0.32)`. Not in-flow — `.project-page-frame` resets its `margin-top` accordingly.
- **Other shared components:** `CursorSpotlight` (cursor-tracked radial glow), `AskUserPanel` (interactive `ask_user`-tool controls above a composer), `GavelThinking` (AI loading indicator), `TokenUsagePill` (per-chat token total, gated on the `showTokenUsage` pref), `PageMasthead` (shared eyebrow/title/description header), `SwitchProjectLoader`, `ActivityMetrics`, `DangerZone`, `fileGlyph`.

### File previews

`FileThumbnail` resolves a poster URL (cached thumbnail or MIME glyph). `FilePreview` renders PDF (pdf.js) / image / video / text inline. Double-clicking a file in the Files page opens it in the **Doc Viewer** (`/doc-viewer`, `src/pages/DocViewer.jsx`) — a dedicated window with a `classify(mime, name)` dispatcher per mime type: photo/video get an "Extract text" OCR **lasso** tool (freeform Photoshop-style selection, clipped canvas → `lib/ocr.js`) with a persisted, resizable extraction-history panel (`lib/extractionHistory.js`); audio/video get a custom player whose **loudness-envelope canvas doubles as the seek control** (the full-file waveform is the scrubber — click / drag / arrow-key to seek; `role="slider"`), **YouTube-Music-style karaoke lyrics** in the player pane (the active timed segment highlights + auto-scrolls to centre), and a side AI-captions panel with **inline editing** of the generated transcript (fix mistranscriptions, recompute joined text). Captions come from `lib/transcribe.js` (Whisper) and are cached per file via `lib/captionsHistory.js`; the panel pushes edits/regenerations back to the player's lyrics live via an `onCaptionsChange` callback. `.docx` renders via `docx-preview` (lazy-imported, `lib/openDocxWindow.js`).

## Conventions

- **Styling:** plain CSS files alongside components (`Foo.jsx` + `Foo.css`); zero CSS-in-JS / Tailwind. Use only `var(--…)` from `tokens.css`. Adding a hard-coded hex is a smell — there's a semantic token for almost everything.
- **SVG icons:** inline JSX constants at the top of the file that uses them — no icon library. Stroke icons use `currentColor` so they inherit hover / active states.
- **`display: contents` wrappers** for synthetic event hosts that shouldn't add a layout box (e.g. Tooltip's `.tooltip-trigger-wrap`).
- **App base zoom is `1`** (`:root { zoom: 1 }` in `index.css`; `BASE_APP_ZOOM = 1` in `lib/appZoom.js`). The former 20% downscale (`zoom: 0.8`) was removed. The Settings "Display scale" preference still composes on top — webFrame zoom on Electron, inline CSS `zoom` on `<html>` on web (`platform.setAppZoom`). Any code that writes a **viewport** coordinate (`clientX`, a `getBoundingClientRect()` value) into a **CSS length** (a `style.left`/`transform`, an SVG coord, a `--spot-x`-style gradient var) must still pass it through `toLayoutPx()` — it's an identity at base zoom 1 but compensates the web display-scale (also CSS zoom). Ratios of two viewport values (percent splitters, seek bars) cancel the zoom and need no conversion.
- **Spotlight / cursor-tracked glows over portalled content** must use a **native** `addEventListener('mousemove')` on the host node, not React's `onMouseMove`. React synthetic events bubble along the React tree, so a handler on an ancestor whose visual children are `createPortal`'d elsewhere (e.g. the Doc Viewer advisor card, whose side panel portals into `.dv-advisor-slot`) never fires over that content — only on the host's own border/padding. Native listeners follow the real DOM tree where the portal nodes actually live.
- **FPS-independent cursor-chase easing.** Any rAF loop that eases a glow/spotlight toward the cursor must compute its lerp factor from the frame's timestamp delta, not a fixed per-frame constant, or the chase speed varies with refresh rate. Recipe: `factor = 1 - Math.pow(1 - EASE, dt / FRAME_60)` with `FRAME_60 = 1000/60` and `dt = clamp(ts - lastTs, …, 100)` (used by the Sidebar rail glow; `CursorSpotlight` instead snaps the box directly to the cursor each move).
- **5-stop animated gradient pill** (`.updates-banner-uptodate` and similar status pills): `linear-gradient(120deg, 5% / 16% / 18% / 16% / 5%)`, `background-size: 300% 100%`, 8 s shimmer keyframe; centred dot with `box-shadow: 0 0 0 6px ...` halo. Reusing this shape keeps "status pill" semantically consistent across the app.
- **Auth-derived display:** display name resolution is `user_metadata.full_name || user_metadata.name || user.email`. Avatar is `user_metadata.avatar_url` (Google) with a deterministic first-letter circle fallback (palette of 12 colours, djb2 hash on the id). Helper is duplicated across a few components (`Account.jsx`, `Sidebar.jsx`, ...) — keep them in sync if you change one.
- **Notification dedupe keys** are mandatory for anything that can fire repeatedly (uploads, downloads, errors). The notify() resolver coalesces / replaces / inserts based on category + dedupeKey, so a bad key spams the user.
- **Realtime subs** belong in a `useEffect` keyed on the resource id (projectId / userId), with a cleanup that unsubscribes. Don't open subs in render. Don't share a sub across providers — channel state is per-mount.
- **Fire-and-forget** is the default for non-critical writes (analytics, send-welcome, saveSidecar) — they return promises but call sites don't await. Errors are swallowed and the next operation retries naturally.
- **No tests, no lint.** Verify renderer changes via `npx esbuild --bundle --format=esm --platform=browser --loader:.jsx=jsx --loader:.js=jsx --loader:.css=empty --loader:.ico=empty --loader:.png=empty --loader:.jpg=empty --loader:.svg=empty --jsx=automatic --outfile=/tmp/check.js src/renderer.jsx` before claiming a change works.

## Web build vs Electron build

| Aspect | Electron | Web |
| --- | --- | --- |
| Entry | `src/renderer.jsx` | `src/web.jsx` |
| Router | `MemoryRouter` (`initialEntries=['/']`) | `BrowserRouter basename='/app'` |
| HTML | `index.html` | `index.web.html` (Vite plugin renames to `index.html` on build) |
| `localFolder` backend | `fs.watch` + `fsp` + `shell` via IPC | File System Access API + IDB-persisted directory handle + 3 s poll |
| Folder persistence | path string in localStorage | `FileSystemDirectoryHandle` in IndexedDB; permission re-granted via "Reconnect" each session |
| OAuth callback | `docvex://auth/callback` custom protocol | Supabase redirect to web origin |
| Version | `platform.getAppVersion()` IPC | `VITE_APP_VERSION` (package.json at build time) |
| Update lifecycle | `autoUpdater` + IPC events | `state: 'web'` (no installer) |
| `showInFolder` / `openPath` | `shell.showItemInFolder` / `shell.openPath` | no-op success |
| Deploy | electron-forge publisher → GitHub Releases | `scripts/web-deploy.mjs` → `docs/app/` (GitHub Pages, `404.html` SPA fallback) |

## Configuration outside source

- `.env` — `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (Vite inlines at build time). Gitignored.
- **Supabase project `pntxlvhkqfryyyxlqytr`** (eu-west-1, organization `docvex.ro`). Modify schema via `claude_ai_Supabase` MCP tools.
- **Supabase dashboard, not in code:** Google OAuth provider config (client id / secret), `docvex://auth/callback` and the web origin registered as redirect URLs, the SMTP for email Edge Functions.
- **Edge Function secrets (Supabase dashboard → Edge Functions → Secrets), not in code:** `RESEND_API_KEY` (email functions); `ANTHROPIC_API_KEY` (`legal-ai` + `doc-ai` OCR — without it the Newsletter AI line falls back to a computed line, ingest 500s, and OCR fails); `OPENAI_API_KEY` (`doc-ai` Whisper transcription — **not yet configured**); `DOC_AI_ALLOW_DEEPGRAM` (must be `1` before `DEEPGRAM_API_KEY` does anything — see the training-posture table); `LEGAL_INGEST_SECRET` (optional — guards `legal-ai`'s `ingest` action; while unset, ingest returns 403); `LEGAL_AI_MODEL` (optional — overrides the default `claude-opus-4-7`, e.g. `claude-haiku-4-5` to cut digest cost).
- **Google Cloud Console:** OAuth consent screen must be User Type **External** (Internal blocks `@gmail.com` testers with `org_internal` 403). Authorized redirect URI = `https://pntxlvhkqfryyyxlqytr.supabase.co/auth/v1/callback`.
- **macOS signing env (release-time, not in code):** `APPLE_SIGNING_IDENTITY`
  (a `Developer ID Application: … (TEAMID)` cert in the login keychain) enables
  the Developer ID + notarization path in `forge.config.js`; pair it with notary
  creds — `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` **or**
  `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`. Unset ⇒ ad-hoc
  fallback (Gatekeeper-blocked). See the code-signing note above.
- **GitHub:** `GITHUB_TOKEN` (PAT, `public_repo` scope) required for `npm run publish` — set via `[Environment]::SetEnvironmentVariable("GITHUB_TOKEN", ..., "User")` or per-session `$env:GITHUB_TOKEN = ...`. VSCode integrated terminals cache env vars from launch; restart the whole VSCode window after setting persistently.

## Scripts (`scripts/`)

| Script | Purpose |
| --- | --- |
| `sync-readme-version.mjs` | Bumps the version string in README.md to match package.json. Runs in the `version` lifecycle. |
| `web-deploy.mjs` | Copies `dist-web/` → `docs/app/`, renames `index.web.html` → `index.html`, writes `404.html` SPA fallback for GitHub Pages. Also runs in `version`. |
| `post-release.mjs` | Runs after `npm version`: `git push --follow-tags`, `electron-forge publish`, `generate-release-notes.mjs`. |
| `generate-release-notes.mjs` | Summarises commits since the previous tag via the `claude` CLI and PATCHes the draft GitHub release body. Best-effort, never fails the release. |
| `make-mac-zips.mjs` | Zips the packaged `.app` bundles, preserving framework symlinks (archiver, not cross-zip). **On macOS** it first copies to a non-iCloud temp dir, `xattr -cr`, `codesign --force --deep --sign -`, and `--verify --strict` (fails the build if invalid). `MAC_ZIP_VERSION` overrides the filename version. Non-Mac hosts can't sign → those zips crash on Apple Silicon. |
| `publish-mac-zips.mjs` | Release-time companion: packages both darwin arches, runs make-mac-zips, uploads the two zips to the draft release (deletes same-named assets first for idempotency). Called from `post-release.mjs`. |
| `fix-mac-release.mjs` (`npm run fix:mac`) | One-shot repair for an existing release's macOS assets — **must run on a Mac.** Resolves the target tag (default: latest), rebuilds both arches stamped with the release version (`DOCVEX_APP_VERSION`), re-signs + verifies + zips (`MAC_ZIP_VERSION`), and replaces the release's darwin zips. Needs `GITHUB_TOKEN`. |

## Release notes style (user preference)

Four sections (`Added` / `Changed` / `Removed` / `Misc`), no emojis, plain English understandable to non-programmers. This overrides the auto-generator's default format — adjust the prompt in `generate-release-notes.mjs` if the template drifts.

## Product & business context

Reference docs live at `C:\Users\Luca\Desktop\docvex\`:

- `Docvex_AI.pdf` — product vision and feature spec
- `text1.txt`, `text2.txt` — business strategy and target market notes (Romanian)
- WhatsApp images — logo variants and brand direction

Read these when reasoning about features, product decisions, positioning, or anything related to "why" we're building something. Code lives in this repo; "why" lives in that folder.

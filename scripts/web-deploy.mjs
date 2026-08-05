#!/usr/bin/env node
// scripts/web-deploy.mjs
//
// Runs after `vite build --config vite.web.config.mjs` produces dist-web/.
// Copies that output into landing/home/demo/ — the web app lives INSIDE the
// marketing-site directory, so scripts/landing-deploy.mjs publishes site and
// app together into docs/ (GitHub Pages serves it at docvex.ro/demo/), and a
// local preview of landing/home includes /app/. landing/home/demo is
// gitignored (an intermediate artifact); docs/demo is the committed deploy.
// The web build's Vite config emits index.html at the root of dist-web, so
// the destination layout is landing/home/demo/index.html, …/assets/…, etc.
//
// SPA fallback: GitHub Pages serves 404.html for any path that doesn't
// match a file. We copy index.html → 404.html inside docs/demo/ so any
// /demo/<unknown> path gets served the SPA shell, and BrowserRouter
// (basename="/demo") takes over the routing client-side. No redirector
// script needed — the SPA reads the actual URL from window.location.

import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile, rm, mkdir, cp, copyFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const SRC = join(root, 'dist-web');
const DEST = join(root, 'landing', 'home', 'demo');
const PREFIX = '[web-deploy]';

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function main() {
  if (!(await exists(SRC))) {
    console.error(`${PREFIX} ${SRC} does not exist — did the vite build step run?`);
    process.exit(1);
  }

  // Clear stale docs/demo/ contents so removed files don't linger from a
  // previous build. We replace the whole directory rather than rm-then-mkdir
  // so a concurrent reader (rare here, but cheap to handle) sees one of the
  // two consistent states.
  console.log(`${PREFIX} clearing ${DEST}`);
  await rm(DEST, { recursive: true, force: true });
  await mkdir(DEST, { recursive: true });

  // node 16.7+ recursive cp works on Windows + POSIX.
  console.log(`${PREFIX} copying ${SRC} → ${DEST}`);
  await cp(SRC, DEST, { recursive: true });

  // SPA fallback for GitHub Pages — see file header.
  const indexHtml = join(DEST, 'index.html');
  const fallback404 = join(DEST, '404.html');
  if (await exists(indexHtml)) {
    console.log(`${PREFIX} writing SPA fallback ${fallback404}`);
    await copyFile(indexHtml, fallback404);

    // Static /demo/auth/ entry — the marketing site's "Sign in" buttons link
    // here. A real directory index works on ANY static server (vite site
    // preview, http-server, GH Pages) without SPA-fallback support; the
    // shell's <base href="/demo/"> + BrowserRouter (basename /demo) then mount
    // the /auth route.
    const authDir = join(DEST, 'auth');
    await mkdir(authDir, { recursive: true });
    await copyFile(indexHtml, join(authDir, 'index.html'));
    console.log(`${PREFIX} writing static auth entry ${join(authDir, 'index.html')}`);
  } else {
    console.warn(`${PREFIX} no index.html in dist-web — SPA fallback skipped`);
  }

  // Copy the favicon. Electron's renderer build has its own Forge-side
  // plugin (vite.main.config.mjs's copyMainIcon) that handles the icon
  // for the main process; the web Vite config has no equivalent, so the
  // built dist-web/ doesn't include favicon.ico. The HTML entry
  // (index.web.html) references /demo/favicon.ico — copying it here
  // satisfies that reference so the deployed site shows the app icon
  // in the browser tab instead of the host's default.
  const faviconSrc = join(root, 'src', 'favicon.ico');
  const faviconDest = join(DEST, 'favicon.ico');
  if (await exists(faviconSrc)) {
    console.log(`${PREFIX} copying favicon ${faviconSrc} → ${faviconDest}`);
    await copyFile(faviconSrc, faviconDest);
  } else {
    console.warn(`${PREFIX} no src/favicon.ico — favicon will 404 on the deployed site`);
  }

  // Root-level GitHub Pages SPA fallback. Pages only serves `404.html`
  // at the served-folder root (here: docs/404.html). A per-subdirectory
  // 404.html like docs/demo/404.html is NOT consulted, so deep links
  // like /demo/projects or /demo/invite/<token> hit the default Pages
  // 404 page unless we put a fallback at the root.
  //
  // The fallback IS the SPA shell, prepended with a tiny guard script:
  //   - For /demo/* URLs: fall through so the SPA loads. Assets resolve
  //     via the existing `<base href="/demo/">` + absolute /demo/assets/…
  //     URLs in the bundle, so they load correctly regardless of the
  //     request path. React Router (basename="/demo") reads the URL and
  //     mounts the right route.
  //   - For any other path: redirect to the marketing root. This avoids
  //     serving the SPA shell for typos like /marketing-typo where it
  //     would render no useful route.
  const rootFallback = join(root, 'docs', '404.html');
  if (await exists(indexHtml)) {
    console.log(`${PREFIX} writing root SPA fallback ${rootFallback}`);
    const shell = await readFile(indexHtml, 'utf8');
    const guardScript =
      '<script>(function(){if(!window.location.pathname.startsWith("/demo/")){window.location.replace("/");}})();</script>';
    // Insert the guard right after the opening <head> tag so it runs
    // before any other script. Case-insensitive replace because
    // Vite-emitted HTML may use either <head> or <HEAD> depending on
    // the upstream HTML processor.
    const patched = shell.replace(/<head>/i, (match) => `${match}${guardScript}`);
    await writeFile(rootFallback, patched, 'utf8');
  } else {
    console.warn(`${PREFIX} no landing/home/demo/index.html — root SPA fallback skipped`);
  }

  // Stage the root SPA fallback (docs/404.html is written directly above;
  // docs/demo itself is staged by landing-deploy when it publishes the site).
  // Non-fatal — if this is run in a non-git context (preview, CI), just log.
  const addResult = spawnSync('git', ['add', 'docs/404.html'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (addResult.status !== 0) {
    console.warn(`${PREFIX} git add docs/404.html exited with code ${addResult.status} — stage manually if needed`);
  }

  // Sanity print — what we shipped.
  const files = await readdir(DEST);
  console.log(`${PREFIX} done — ${files.length} top-level entries in landing/home/demo/`);
  console.log(`${PREFIX} run \`npm run site:deploy\` to publish site + app into docs/`);
}

main().catch((err) => {
  console.error(`${PREFIX} fatal:`, err);
  process.exit(1);
});

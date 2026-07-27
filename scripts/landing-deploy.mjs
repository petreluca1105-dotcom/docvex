#!/usr/bin/env node
// scripts/landing-deploy.mjs
//
// Deploys the marketing website — the static site in landing/home/ — into
// docs/, the GitHub Pages root that serves docvex.ro. Plain HTML/CSS/JS, no
// build step: files are copied verbatim.
//
// docs/ also hosts things this script must never touch:
//   • CNAME, .nojekyll, 404.html, invite.html, favicon.ico
//
// The in-browser DEMO of the app (docs/demo, built by scripts/web-deploy.mjs)
// was removed from the website — this script now actively clears it so a stale
// copy can't keep being served.
//
// Strategy: wipe the non-protected top-level entries and repopulate the root
// from landing/home/. (The old React site that lived at docs/old/ was removed —
// it is intentionally NOT protected, so a deploy clears any stale copy.)

import { spawnSync } from 'node:child_process';
import { readdir, rm, cp, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const HOME_SRC = join(root, 'landing', 'home');   // → docs/ (root)
const DEST = join(root, 'docs');
const PREFIX = '[landing-deploy]';

// Top-level docs/ entries owned by something other than the homepage.
// Never removed, never overwritten by the copy step.
const PROTECTED = new Set([
  'CNAME',          // GitHub Pages custom domain
  '.nojekyll',      // lets underscore files be served
  'invite.html',    // standalone invite-accept page
  '404.html',       // root SPA fallback (routes /app/* to the SPA, else → /)
  'favicon.ico',    // shared favicon (invite.html references it)
]);

// Never copy these from the source into docs/. The protected files would be
// clobbered; `demo` / `demo-files` are leftovers of the removed in-browser demo
// and must not be republished even if a local build recreates them.
const SKIP_FROM_SRC = new Set(['404.html', 'CNAME', '.nojekyll', '.DS_Store', 'demo', 'demo-files']);

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function copyTree(src, dest) {
  const entries = await readdir(src);
  let copied = 0;
  for (const name of entries) {
    if (SKIP_FROM_SRC.has(name)) continue;
    await cp(join(src, name), join(dest, name), { recursive: true });
    copied += 1;
  }
  return copied;
}

async function main() {
  if (!(await exists(HOME_SRC))) {
    console.error(`${PREFIX} ${HOME_SRC} does not exist.`);
    process.exit(1);
  }

  // Wipe non-protected top-level entries, then repopulate from landing/home/.
  const current = await readdir(DEST);
  for (const name of current) {
    if (PROTECTED.has(name)) continue;
    console.log(`${PREFIX} removing stale ${name}`);
    await rm(join(DEST, name), { recursive: true, force: true });
  }
  const homeCopied = await copyTree(HOME_SRC, DEST);
  console.log(`${PREFIX} copied ${homeCopied} entries → docs/ (root)`);

  // Safety net: docs/ MUST keep these for the site to work at all.
  for (const must of ['CNAME', '.nojekyll', 'index.html']) {
    if (!(await exists(join(DEST, must)))) {
      console.warn(`${PREFIX} WARNING: docs/${must} is missing after deploy!`);
    }
  }

  // Stage so a subsequent commit picks up the artifacts. Non-fatal.
  const addResult = spawnSync('git', ['add', 'docs'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (addResult.status !== 0) {
    console.warn(`${PREFIX} git add docs exited with code ${addResult.status} — stage manually if needed`);
  }

  console.log(`${PREFIX} done.`);
}

main().catch((err) => {
  console.error(`${PREFIX} fatal:`, err);
  process.exit(1);
});

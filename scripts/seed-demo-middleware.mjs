// Vite dev-server plugin: POST /__seed-demo-files?name=<filename> with the
// raw file bytes as the body writes the file into landing/home/demo-files/
// and regenerates its manifest.json. This is what the web app's localhost-only
// "Seed demo files" debug button talks to — files staged here are REAL repo
// files, so the next `npm run web:deploy` (or site:deploy) ships them and
// every visitor's demo workspace seeds from them (see lib/demoWorkspace.js).
//
// Dev-only by construction: the plugin registers a middleware, which only
// exists on the dev server — production builds/GitHub Pages never expose it.
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_FILES_DIR = resolve(__dirname, '..', 'landing', 'home', 'demo-files');

// Same character policy as the app's sanitizeFilename — plus no dotfiles,
// so a crafted name can't escape the folder or shadow the manifest.
function sanitizeName(name) {
  const clean = String(name || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 240);
  if (!clean || clean.startsWith('.') || clean === 'manifest.json') return null;
  return clean;
}

async function regenerateManifest() {
  const names = (await readdir(DEMO_FILES_DIR))
    .filter((n) => n !== 'manifest.json' && !n.startsWith('.'))
    .sort();
  await writeFile(
    join(DEMO_FILES_DIR, 'manifest.json'),
    `${JSON.stringify({ version: new Date().toISOString(), files: names }, null, 2)}\n`,
    'utf8',
  );
  return names;
}

export function seedDemoFilesEndpoint() {
  return {
    name: 'dvx-seed-demo-files',
    configureServer(server) {
      server.middlewares.use('/__seed-demo-files', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end('POST only');
            return;
          }
          // connect strips the mount path from req.url — recover the query
          // from originalUrl, which keeps it.
          const url = new URL(req.originalUrl || req.url, 'http://localhost');
          const name = sanitizeName(url.searchParams.get('name'));
          if (!name) {
            res.statusCode = 400;
            res.end('bad name');
            return;
          }
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          await mkdir(DEMO_FILES_DIR, { recursive: true });
          await writeFile(join(DEMO_FILES_DIR, name), Buffer.concat(chunks));
          const names = await regenerateManifest();
          console.log(`[seed-demo-files] staged "${name}" (${names.length} files in landing/home/demo-files)`);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, name, total: names.length }));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err?.message || err));
        }
      });
    },
  };
}

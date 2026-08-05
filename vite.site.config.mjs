import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { seedDemoFilesEndpoint } from './scripts/seed-demo-middleware.mjs';

// Dev-server config for the static marketing site (`npm run site:dev`).
// The site has no build — this only serves landing/home/ and registers the
// /__seed-demo-files endpoint the app's localhost debug button posts to.
// (The in-browser demo of the app that used to live under /demo/ was removed
// from the site; the web build itself still exists, it just isn't published.)

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(__dirname, 'landing', 'home'),
  server: {
    port: 5175,
    strictPort: true,
  },
  plugins: [seedDemoFilesEndpoint()],
});

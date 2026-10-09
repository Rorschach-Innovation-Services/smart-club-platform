import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * The same suite on an ISOLATED stack (API :3433, vite :3301, dynalite :4767, stub medicoach
 * :4899) so it can run while another stack holds the default ports (3333/3201/4567/4799).
 *
 *   npx playwright test -c playwright.altports.config.ts [spec]
 *
 * The fixed ports in src/local/server.ts, vite.config.ts and e2e/helpers.ts are left alone:
 * e2e/support/port-remap.mjs (a test-only Node preload, inherited via NODE_OPTIONS by the
 * stack AND by the Playwright runner + workers) remaps listen/connect on loopback. The guard
 * below refuses to run at all if the preload is not active in THIS process — otherwise the
 * specs' API calls would land on the default-port stack.
 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(ROOT, 'e2e/support/port-remap.mjs');
if (!(globalThis as { __SMART_CLUB_PORT_REMAP__?: boolean }).__SMART_CLUB_PORT_REMAP__) {
  throw new Error(
    `playwright.altports.config.ts needs the port-remap preload in this process: run it as\n` +
      `  NODE_OPTIONS="--import ${PRELOAD}" npx playwright test -c playwright.altports.config.ts`,
  );
}

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: 'http://localhost:3301' },
  webServer: {
    command: 'npm run dev:local:demo',
    url: 'http://localhost:3301',
    // Never adopt someone else's stack: this config always boots its own.
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      ...(process.env as Record<string, string>),
      NODE_OPTIONS: `--import ${PRELOAD}`,
      VITE_API_URL: 'http://localhost:3433',
      // Remapped by the preload (4799 → 4899) on both sides, so the base value is kept.
      MEDICOACH_SYNC_URL: 'http://127.0.0.1:4799',
      MEDICOACH_SYNC_SECRET: 'e2e-medicoach-sync-secret',
      LOCAL_UPLOADS_DIR: path.join(ROOT, 'test-results', 'altports-uploads'),
    },
  },
});

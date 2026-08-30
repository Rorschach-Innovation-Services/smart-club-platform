import { defineConfig } from '@playwright/test';

/**
 * Browser-driven E2E for the admin console. The specs seed their own data through the
 * REAL local API (dynalite in-memory DB) and drive the REAL vite app — no mocks.
 *
 * The suite shares ONE in-memory DB, so it must run serially: workers:1 + fullyParallel:
 * false. `webServer` boots `dev:local:demo` (API :3333 + vite :3201, SEED_DEMO=1) and, when
 * a stack is already listening on :3201, reuses it rather than starting a second.
 *
 * Kept OUT of the root vitest glob (vite.config.ts collects only `src/**`) via testDir:'e2e'
 * and the `*.e2e.ts` suffix, and out of the type-check gate (tsconfig.app.json includes only
 * `src`), so `npm test` and `tsc -p tsconfig.app.json` are unaffected.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  // Fail fast when `reuseExistingServer` would reuse a stack NOT booted as the demo one.
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  // A generous per-test budget: each test boots nothing itself but does several real API
  // round-trips plus page loads. CI machines are slower than a dev laptop.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3201',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev:local:demo',
    url: 'http://localhost:3201',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

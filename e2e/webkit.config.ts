import { defineConfig } from '@playwright/test';
import base from '../playwright.config';

/**
 * The same suite on WebKit (Safari's engine): `npx playwright test --config e2e/webkit.config.ts
 * <spec>`. Paths are re-anchored at the repo root (this file lives in e2e/); webServer and its
 * reuse of a running stack are inherited unchanged.
 */
export default defineConfig({
  ...base,
  testDir: '.',
  globalSetup: './global-setup.ts',
  projects: [{ name: 'webkit', use: { browserName: 'webkit' } }],
});

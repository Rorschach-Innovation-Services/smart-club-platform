import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';

export default defineConfig({
  // 'hidden' emits source maps for Sentry upload without referencing them from the
  // shipped JS (no `//# sourceMappingURL`), so the maps don't leak via the browser.
  build: { sourcemap: 'hidden' },
  plugins: [
    react(),
    // Uploads source maps to Sentry so production stack traces are de-minified, and
    // deletes the .map files afterwards so they're never published to S3/CloudFront.
    // Must come AFTER react(). The auth token is read from process.env.SENTRY_AUTH_TOKEN
    // or ./.env.sentry-build-plugin (auto-loaded). With no token the plugin warns and
    // skips upload — the build still succeeds (e.g. plain local `npm run build`).
    sentryVitePlugin({
      org: 'medicoach-ap',
      // 'dolphins-web' is the platform-wide Sentry project for ALL tenants (legacy
      // name; member tokens can't create projects). Tenant is an event tag, not a
      // per-tenant project.
      project: 'dolphins-web',
      url: 'https://de.sentry.io/', // EU region — keep ingest in the EU
      release: { name: process.env.VITE_SENTRY_RELEASE },
      sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
    }),
  ],
  server: {
    port: 3201,
    host: true,
  },
  preview: {
    port: 3201,
    host: true,
  },
  test: {
    // Frontend (src/) only. The API package owns its own node:test suite
    // (packages/api: `npm test`), which uses a different runner — excluded here
    // so root vitest doesn't try to collect it.
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    exclude: ['**/node_modules/**', 'packages/**'],
  },
});

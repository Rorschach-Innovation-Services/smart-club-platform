import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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

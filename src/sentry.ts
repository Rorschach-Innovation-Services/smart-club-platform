/**
 * Sentry initialisation for the SPA.
 *
 * Imported FIRST by main.tsx so the global `onerror` / `unhandledrejection`
 * handlers are installed before the app renders. Errors-only: no performance
 * tracing, no Session Replay.
 *
 * Guarded on VITE_SENTRY_DSN, so local dev (no DSN baked into the build) is a
 * complete no-op. The DSN/environment/release are injected at build time by SST
 * (StaticSite `environment`) and exposed via import.meta.env.
 */
import * as Sentry from '@sentry/react';

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? 'unknown',
    release: import.meta.env.VITE_SENTRY_RELEASE,
    sendDefaultPii: true,
    tracesSampleRate: 0, // errors only
    integrations: [], // no tracing / no replay integrations
    // AbortError is the browser cancelling in-flight work — a fetch abandoned on
    // navigation/unmount, or a media load interrupted (seen on /tutorials in prod).
    // Deliberate cancellation, not a defect; never worth an alert.
    ignoreErrors: [/^AbortError\b/, /The operation was aborted/i],
  });
}

export { Sentry };

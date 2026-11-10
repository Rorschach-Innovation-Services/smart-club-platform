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

/**
 * Link tokens are bearer capabilities: replace them with `[token]` anywhere an event or
 * breadcrumb carries them (page URL, fetch breadcrumbs, the `api_path` tag, messages). Covers
 * the path forms (`/r/`, `/captains-report-link/`, `/sq/`, `/squad-link/`, `/d/`,
 * `/doc-request-link/`) and `t=` query values (club `/signup`, player `/register/:clubId`,
 * official `/officials/register` and `/official-signup`): `?t=` / `&t=` in a URL, a bare query
 * string starting `t=`, and Sentry's pair form `["t","…"]`. Mirrors the API's scrubber
 * (packages/api/src/instrument.ts). Exported for tests.
 */
export function scrubReportTokens(value: string): string {
  return value
    .replace(
      /(\/(?:captains-report-link|r|squad-link|sq|doc-request-link|d)\/)[^/?#\s"']+/g,
      '$1[token]',
    )
    .replace(/(["?&]t=)[^&#\s"'\\]+/g, '$1[token]')
    .replace(/(\["t",\s*")[^"]*/g, '$1[token]');
}

function scrub<T>(value: T): T {
  const json = JSON.stringify(value);
  const scrubbed = scrubReportTokens(json);
  return scrubbed === json ? value : (JSON.parse(scrubbed) as T);
}

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
    beforeSend: (event) => scrub(event),
    beforeBreadcrumb: (crumb) => scrub(crumb),
  });
}

export { Sentry };

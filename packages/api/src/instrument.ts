/**
 * Sentry initialisation for the API Lambda.
 *
 * Imported FIRST (before Hono / AWS SDK) by index.ts so init runs at module load,
 * before any client is constructed. Errors-only: no performance tracing, no OTEL
 * auto-instrumentation, so the `--import` preload AWS-Lambda needs for tracing is
 * not required here.
 *
 * Guarded on SENTRY_DSN presence, so local dev / tests (no DSN) are a complete
 * no-op — nothing is sent. `STAGE !== 'local'` is a second belt: the local dev
 * server sets STAGE=local.
 */
import * as Sentry from '@sentry/aws-serverless';

/**
 * A captain's-report or scorecard-confirmation link token is a bearer capability (ADR 0016): it
 * must never reach Sentry. Replaces the token in `/captains-report-link/<token>`, `/r/<token>`,
 * `/scorecard-confirm-link/<token>` and `/sc/<token>` paths with `[token]`. Exported for tests.
 */
export function scrubReportTokens(value: string): string {
  return value.replace(
    /(\/(?:captains-report-link|r|scorecard-confirm-link|sc)\/)[^/?#\s"']+/g,
    '$1[token]',
  );
}

/** Scrub every place an event carries a URL or message (request, transaction, tags, extra). */
export function scrubEvent<T extends Record<string, unknown>>(event: T): T {
  const json = JSON.stringify(event);
  const scrubbed = scrubReportTokens(json);
  return scrubbed === json ? event : (JSON.parse(scrubbed) as T);
}

if (process.env.SENTRY_DSN && process.env.STAGE !== 'local') {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.STAGE ?? 'unknown',
    release: process.env.SENTRY_RELEASE,
    sendDefaultPii: true,
    tracesSampleRate: 0, // errors only — no transactions
    // Minimal POPIA hardening even with sendDefaultPii on: Sentry redacts the
    // Authorization header but NOT custom ones. Drop the dev identity header so
    // base64-encoded identity never lands in the EU store. Request bodies are not
    // captured by default — keep it that way (don't add body capture).
    beforeSend(event) {
      const headers = event.request?.headers;
      if (headers) {
        delete headers['x-dev-auth'];
        delete headers['X-Dev-Auth'];
      }
      return scrubEvent(event as unknown as Record<string, unknown>) as unknown as typeof event;
    },
    // Breadcrumbs (outgoing/incoming HTTP) carry URLs — scrub the report token there too.
    beforeBreadcrumb(crumb) {
      return scrubEvent(crumb as unknown as Record<string, unknown>) as unknown as typeof crumb;
    },
  });
}

export { Sentry };

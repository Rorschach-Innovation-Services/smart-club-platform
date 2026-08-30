import { API_BASE, adminAuthHeader, apiHeaders } from './helpers';

const WEB_BASE = 'http://localhost:3201';

/**
 * Guards `reuseExistingServer` (playwright.config.ts) against silently reusing a stack that
 * was NOT started with `npm run dev:local:demo` (SEED_DEMO=1). Such a stack is missing the
 * demo clubs the specs seed against, which surfaces as confusing mid-suite failures rather
 * than a clear "wrong stack" message.
 *
 * Runs before Playwright's webServer. Playwright only checks the WEB port (:3201) when
 * deciding to reuse, so that is what we key on: if nothing is listening there, do nothing
 * and let webServer boot the demo stack. If vite IS up, the API on :3333 must answer 200 for
 * a known demo club (`ukzn`) with the admin dev-auth + x-tenant headers — anything else
 * (no API at all, or a non-demo seed) fails fast with a clear message.
 */
export default async function globalSetup(): Promise<void> {
  if (!(await isListening(WEB_BASE))) return;

  const probeUrl = `${API_BASE}/clubs/ukzn`;
  let status: number | 'unreachable';
  try {
    status = (await fetch(probeUrl, { headers: apiHeaders(adminAuthHeader()) })).status;
  } catch (err) {
    if (!isConnectionRefused(err)) throw err;
    status = 'unreachable';
  }
  if (status !== 200) {
    throw new Error(
      `A web stack is running on ${WEB_BASE} but the API probe failed (GET ${probeUrl} → ${status}). ` +
        'Either no API is listening on :3333, or the stack was not started with ' +
        '`npm run dev:local:demo` (demo clubs missing). Stop it and re-run so the suite boots ' +
        'its own demo stack, or start it with `npm run dev:local:demo`.',
    );
  }
}

async function isListening(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: 'HEAD' });
    return true;
  } catch (err) {
    if (isConnectionRefused(err)) return false;
    throw err;
  }
}

function isConnectionRefused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
  return cause?.code === 'ECONNREFUSED';
}

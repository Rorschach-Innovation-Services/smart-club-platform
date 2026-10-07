import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_BASE, adminAuthHeader, apiHeaders } from './helpers';

/** This checkout's root — the stack under test must have been started from it. */
const REPO_ROOT = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));

const WEB_BASE = 'http://localhost:3201';
// Matches playwright.config.ts webServer.timeout — the API (dynalite + demo seed) is the slow part.
const API_BOOT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

/**
 * Guards `reuseExistingServer` (playwright.config.ts) against silently reusing a stack that
 * was NOT started with `npm run dev:local:demo` (SEED_DEMO=1). Such a stack is missing the
 * demo clubs the specs seed against, which surfaces as confusing mid-suite failures rather
 * than a clear "wrong stack" message.
 *
 * Ordering matters: Playwright launches `webServer` BEFORE globalSetup, and vite answers on
 * :3201 well before the API finishes booting dynalite + seed on :3333. So "web up, API
 * refusing" is the normal boot-in-progress state, not a wrong stack — we poll the API until
 * it listens (bounded), THEN probe a known demo club (`ukzn`) with the admin dev-auth +
 * x-tenant headers. Non-200 (e.g. 404 from a plain `dev:local` seed) fails fast with a clear
 * message. If nothing is listening on :3201 at all, do nothing — webServer boots the stack.
 */
export default async function globalSetup(): Promise<void> {
  if (!(await isListening(WEB_BASE))) return;

  const probeUrl = `${API_BASE}/clubs/ukzn`;
  const status = await waitForApi(probeUrl, API_BOOT_TIMEOUT_MS);
  await assertOwnStack();
  if (status !== 200) {
    throw new Error(
      `A web stack is running on ${WEB_BASE} but the API probe failed (GET ${probeUrl} → ${status}). ` +
        'Either no API came up on :3333, or the stack was not started with ' +
        '`npm run dev:local:demo` (demo clubs missing). Stop it and re-run so the suite boots ' +
        'its own demo stack, or start it with `npm run dev:local:demo`.',
    );
  }
}

/** Poll until the API accepts connections (boot in progress), then return the probe status. */
async function waitForApi(url: string, timeoutMs: number): Promise<number | 'unreachable'> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      return (await fetch(url, { headers: apiHeaders(adminAuthHeader()) })).status;
    } catch (err) {
      if (!isConnectionRefused(err)) throw err;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  } while (Date.now() < deadline);
  return 'unreachable';
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

/**
 * The ports are fixed, so a stack another worktree (or another agent) started would be reused
 * silently and the suite would test THAT code and write into ITS database. The local API
 * answers `GET /__local/stack` with the checkout it runs from; anything else fails fast.
 */
async function assertOwnStack(): Promise<void> {
  let root: string | undefined;
  try {
    const res = await fetch(`${API_BASE}/__local/stack`);
    if (res.ok) root = ((await res.json()) as { root?: string }).root;
  } catch {
    /* reported below */
  }
  if (root && path.resolve(root) === REPO_ROOT) return; // both sides are realpath'd
  throw new Error(
    `The stack on :3201/:3333 was not started from this checkout (${REPO_ROOT}); it reports ` +
      `${root ? `"${root}"` : 'no /__local/stack marker (an older or foreign build)'}. ` +
      'Stop it (or wait for the other run to finish) and re-run, so the suite boots its own stack.',
  );
}

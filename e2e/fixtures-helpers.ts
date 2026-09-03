import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { API_BASE, adminAuthHeader, apiHeaders, repAuthHeader, RUN } from './helpers';

/**
 * Helpers for the in-season venue-clash-gate E2E. Everything talks to the REAL local
 * stack: the API at :3333 (series are seeded and asserted through Playwright's `request`
 * fixture) and the vite app at :3201 (driven in the browser).
 *
 * Seeding strategy (see the spec): a series is always born a DRAFT (POST /series forces
 * `released:false`), so a released subject is made by POST then an approve+release PATCH.
 * Grounds are RUN-unique CUSTOM names (`E2E … <RUN> <n>`) written as `venueOverride`; a
 * custom name is a strict capacity-1 ground in the ledger, so two fixtures sharing one on
 * the same date/time clash and nothing collides with the demo grounds or other tests.
 * Dates live in 2027 (far from the demo series) and each test uses its own so the
 * tenant-wide gate only ever sees the clash a test intends.
 */

/** Demo club id → display name (packages/api/seed-data/dolphins.json). The clash payload
 * resolves a legacy `home`/`away` clubId to the club NAME, so tests assert on these. */
export const CLUB_NAME: Record<string, string> = {
  ukzn: 'UKZN CC',
  clares: 'Clares CC',
  chatsworth: 'Chatsworth Sporting CC',
  umlazi: 'Umlazi CC',
  crusaders: 'Crusaders CC',
  berea: 'Berea Rovers CC',
  rhythm: 'Rhythm DHSOB CC',
  warriors: 'African Warriors CC',
  phoenix: 'Phoenix CC',
  verulam: 'Verulam CC',
  harlequins: 'Harlequins CC',
  spartan: 'Spartan Sporting CC',
  ilembe: 'Ilembe CC',
  tongaat: 'Tongaat CC',
};

export interface E2EFixture {
  id: string;
  round: number;
  date: string;
  home: string; // demo club id (legacy fixture shape)
  away: string; // demo club id
  venueOverride?: string; // a RUN-unique custom ground name
  time?: string; // 'HH:MM'; omit for an untimed fixture that owns the whole ground-day
  status?: string;
}

export interface SeededSeries {
  id: string;
  name: string;
  version: number;
  released: boolean;
  releasedAt: string | null;
  fixtures: E2EFixture[];
  withheld?: { venue?: true; time?: true };
  revealedAt?: { venue?: string; time?: string };
}

let seq = 0;
function nextSuffix(): string {
  seq += 1;
  return `${RUN}-${seq}`;
}

/** A RUN-unique custom ground name. Reuse ONE returned value across the series that must
 * share (and therefore contest) a ground; call again for an independent free ground. */
export function ground(label: string): string {
  return `E2E ${label} ${RUN} ${(seq += 1)}`;
}

/** A legacy-shape fixture with sensible defaults; override any field. */
export function fixture(over: Partial<E2EFixture> & { id: string }): E2EFixture {
  return {
    round: 1,
    date: '2027-03-01',
    home: 'ukzn',
    away: 'clares',
    time: '09:00',
    ...over,
  };
}

/** Create a DRAFT series through the real API (POST /series forces the draft state). */
export async function createSeries(
  request: APIRequestContext,
  opts: {
    name?: string;
    teams?: string[];
    fixtures: E2EFixture[];
    startDate?: string;
    leagueKey?: string;
  },
): Promise<SeededSeries> {
  const suffix = nextSuffix();
  const id = `e2e-${suffix}`;
  const name = opts.name ?? `E2E Series ${suffix}`;
  const teams = opts.teams ?? Array.from(new Set(opts.fixtures.flatMap((f) => [f.home, f.away])));
  const body = {
    id,
    name,
    kind: 'series',
    leagueKey: opts.leagueKey ?? 'premier',
    seriesType: 'league',
    maxOvers: 50,
    startDate: opts.startDate ?? opts.fixtures[0]?.date ?? '2027-03-01',
    teams,
    fixtures: opts.fixtures,
    version: 1,
  };
  const res = await request.post(`${API_BASE}/series`, {
    headers: apiHeaders(adminAuthHeader()),
    data: body,
  });
  expect(res.ok(), `POST /series → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as SeededSeries;
}

/** Admin view of one series (drafts + real venues), read back from GET /series. */
export async function getSeries(request: APIRequestContext, id: string): Promise<SeededSeries> {
  const res = await request.get(`${API_BASE}/series`, {
    headers: apiHeaders(adminAuthHeader()),
  });
  expect(res.ok(), `GET /series → ${res.status()}`).toBeTruthy();
  const all = (await res.json()) as SeededSeries[];
  const found = all.find((s) => s.id === id);
  expect(found, `series ${id} should be in the admin list`).toBeTruthy();
  return found!;
}

/** Approve + release a draft in one PATCH (both gates run on the real venues). Reads the
 * current version first, so callers don't have to thread it. Fails if the release is
 * gated — seed non-clashing venues when a clean release is intended. */
export async function approveAndRelease(
  request: APIRequestContext,
  id: string,
  withheld?: { venue?: true; time?: true },
): Promise<SeededSeries> {
  const cur = await getSeries(request, id);
  const res = await request.patch(`${API_BASE}/series/${id}`, {
    headers: apiHeaders(adminAuthHeader()),
    data: {
      approved: true,
      released: true,
      version: cur.version,
      ...(withheld ? { withheld } : {}),
    },
  });
  expect(res.ok(), `release ${id} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as SeededSeries;
}

/** Seed a series already RELEASED on the given fixtures (create → approve+release). */
export async function createReleased(
  request: APIRequestContext,
  opts: Parameters<typeof createSeries>[1] & { withheld?: { venue?: true; time?: true } },
): Promise<SeededSeries> {
  const s = await createSeries(request, opts);
  await approveAndRelease(request, s.id, opts.withheld);
  return getSeries(request, s.id);
}

/** Raw PATCH /series/:id — returns the response so a test can assert status + body. */
export function patchSeries(
  request: APIRequestContext,
  id: string,
  body: Record<string, unknown>,
  auth: string = adminAuthHeader(),
) {
  return request.patch(`${API_BASE}/series/${id}`, {
    headers: apiHeaders(auth),
    data: body,
  });
}

/** Raw POST /series/:id/clash-check — returns the response. */
export function clashCheck(
  request: APIRequestContext,
  id: string,
  candidates: unknown,
  auth: string = adminAuthHeader(),
) {
  return request.post(`${API_BASE}/series/${id}/clash-check`, {
    headers: apiHeaders(auth),
    data: { candidates },
  });
}

/** The club-facing projection a rep sees for one series, or undefined if hidden. */
export async function repGetSeries(
  request: APIRequestContext,
  clubId: string,
  id: string,
): Promise<(SeededSeries & { fixtures: Array<Record<string, unknown>> }) | undefined> {
  const res = await request.get(`${API_BASE}/series`, {
    headers: apiHeaders(repAuthHeader(clubId)),
  });
  expect(res.ok(), `rep GET /series → ${res.status()}`).toBeTruthy();
  const all = (await res.json()) as Array<
    SeededSeries & { fixtures: Array<Record<string, unknown>> }
  >;
  return all.find((s) => s.id === id);
}

// ── Browser helpers ────────────────────────────────────────────────────────

/** Open /admin/fixtures and select the series card with the given (unique) name. Returns
 * the card locator. Assumes an admin is already signed in on `page`. */
export async function openAdminSeries(page: Page, name: string) {
  await page.goto('/admin/fixtures');
  const card = page.locator('.series-card', { hasText: name });
  await expect(card).toBeVisible();
  await card.click();
  await expect(card).toHaveClass(/active/);
  return card;
}

/**
 * Sign in as a club rep in a FRESH browser context, so the admin identity in the `page`
 * fixture's localStorage never interferes, and land on the club's fixtures page. The
 * onboarding walkthrough (`.ob-backdrop`) can auto-open ~350ms after the portal mounts —
 * dismiss it defensively before returning. Returns the rep page (close its context via
 * `repPage.context().close()` when done).
 */
export async function signInAsRep(browser: Browser, clubId: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  const role = page.locator('select.field-select').first();
  await expect(role).toBeVisible();
  await role.selectOption('rep');
  await page.locator('input.field-input').first().fill(clubId);
  await page.getByRole('button', { name: 'Enter as rep' }).click();
  await gotoClubFixtures(page, clubId);
  return page;
}

/** Navigate the rep page to its fixtures view and dismiss any onboarding overlay. */
export async function gotoClubFixtures(page: Page, clubId: string): Promise<void> {
  await page.goto(`/club/${clubId}/fixtures`);
  await dismissOnboarding(page);
}

/** Close the onboarding walkthrough if it is (or becomes) visible; harmless if it never
 * opens. The overlay opens on a 350ms timer, so give it a beat before giving up. */
export async function dismissOnboarding(page: Page): Promise<void> {
  const backdrop = page.locator('.ob-backdrop');
  try {
    await backdrop.waitFor({ state: 'visible', timeout: 1200 });
  } catch {
    return; // never appeared — nothing to close
  }
  await page.locator('.ob-close').first().click();
  await expect(backdrop).toHaveCount(0);
}

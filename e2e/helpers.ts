import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Shared helpers for the admin-clearances E2E. Everything here talks to the REAL local
 * stack: the API at :3333 (for seeding via Playwright's `request` fixture) and the vite
 * app at :3201 (driven in the browser).
 */

export const API_BASE = 'http://localhost:3333';
export const TENANT = 'dolphins';

type Membership = { tenantId: string; role: string; clubIds: string[] };

/** base64(JSON) identity for the `x-dev-auth` header the local API trusts. */
function devAuth(memberships: Membership[], sub: string, email: string): string {
  return Buffer.from(JSON.stringify({ sub, email, memberships })).toString('base64');
}

export function adminAuthHeader(): string {
  return devAuth(
    [{ tenantId: TENANT, role: 'admin', clubIds: [] }],
    'dev-admin',
    'admin@dolphins.local',
  );
}

export function repAuthHeader(clubId: string): string {
  return devAuth(
    [{ tenantId: TENANT, role: 'rep', clubIds: [clubId] }],
    'dev-rep',
    'rep@dolphins.local',
  );
}

export function apiHeaders(auth: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-tenant': TENANT, 'x-dev-auth': auth };
}

/**
 * Sign in through the dev role picker as an administrator. The picker defaults to the
 * admin role, so we just submit the form; then wait for the console to render.
 */
export async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto('/');
  // The dev login renders a "Local sign-in" card with a role <select> defaulting to admin.
  const role = page.locator('select.field-select').first();
  await expect(role).toBeVisible();
  await role.selectOption('admin');
  // The submit button label tracks the picked role ("Enter as admin").
  await page.getByRole('button', { name: 'Enter as admin' }).click();
}

/** A per-run token so seeded names/IDs are unique even when the stack (and its DB) is reused. */
export const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

let seq = 0;
/** Unique-per-seed suffix, stable within a run. */
function nextSuffix(): string {
  seq += 1;
  return `${RUN}-${seq}`;
}

export interface SeededClearance {
  id: string;
  version: number;
  fromClubId: string;
  toClubId: string;
  playerNaturalKey: string;
  playerName: string;
  idNumber: string;
  status: string;
  // How the clearance was created ('request' rep-initiated vs 'registration' self-serve) and,
  // once rejected, where the player ended up. Present on the admin-list view; optional here
  // because seedPendingClearance's rep-initiated clearances read them back post-reject only.
  origin?: string;
  rejectOutcome?: string;
}

async function getAllClearances(request: APIRequestContext): Promise<SeededClearance[]> {
  const res = await request.get(`${API_BASE}/admin/clearances`, {
    headers: apiHeaders(adminAuthHeader()),
  });
  expect(res.ok(), `GET /admin/clearances → ${res.status()}`).toBeTruthy();
  return (await res.json()) as SeededClearance[];
}

/**
 * Seed one PENDING, rep-initiated clearance end-to-end through the real API:
 *   1. create a player at the SOURCE club (as admin),
 *   2. the DESTINATION club's rep requests the clearance,
 *   3. read it back from GET /admin/clearances.
 *
 * `name` is used verbatim as the player's last name so the admin search can target the
 * card by a unique string. Returns the admin-list view of the clearance.
 */
export async function seedPendingClearance(
  request: APIRequestContext,
  opts: { from: string; to: string; name: string; team?: string },
): Promise<SeededClearance> {
  const suffix = nextSuffix();
  // A passport identity sidesteps RSA-ID checksum math: dob is supplied directly.
  const idNumber = `E2E${suffix.toUpperCase().replace(/-/g, '')}`;
  const firstName = 'Test';
  const lastName = opts.name;
  const team = opts.team ?? 'premier';

  const playerRes = await request.post(`${API_BASE}/clubs/${opts.from}/players`, {
    headers: apiHeaders(adminAuthHeader()),
    data: {
      firstName,
      lastName,
      idType: 'passport',
      idNumber,
      dob: '1995-06-15',
      race: 'African',
      gender: 'Male',
      nationality: 'Zimbabwean',
      cell: '0821234567',
      team,
      district: 'Durban Central',
    },
  });
  expect(
    playerRes.ok(),
    `POST /clubs/${opts.from}/players → ${playerRes.status()} ${await playerRes.text()}`,
  ).toBeTruthy();
  const player = (await playerRes.json()) as { naturalKey: string };

  const clrRes = await request.post(`${API_BASE}/clubs/${opts.to}/clearances`, {
    headers: apiHeaders(repAuthHeader(opts.to)),
    data: { fromClubId: opts.from, playerNaturalKey: player.naturalKey },
  });
  expect(
    clrRes.ok(),
    `POST /clubs/${opts.to}/clearances → ${clrRes.status()} ${await clrRes.text()}`,
  ).toBeTruthy();
  const created = (await clrRes.json()) as { id: string };

  const all = await getAllClearances(request);
  const found = all.find((c) => c.id === created.id);
  expect(found, 'seeded clearance should appear in GET /admin/clearances').toBeTruthy();
  return found!;
}

/**
 * Seed a REGISTRATION-ORIGIN, case-C clearance end-to-end through the PUBLIC self-registration
 * route. The player registers into `linkClub` and declares `prevClub` as their previous club;
 * `prevClub` is an on-system demo club that holds NO roster row for this uniquely-named player,
 * so a Union reject would MOVE the registration there (case C — "source club exists, no row").
 *
 * Because every test searches by a run-unique player name, whatever a case-C test leaves behind
 * (after its closing reopen: a `clearance-pending` row at `linkClub` and a pending clearance in
 * `prevClub`'s queue) is harmless to other tests — say so at the call site.
 *
 * Steps:
 *   1. mint the link club's player reg-link token (admin) — this rotates the demo club's token,
 *      which is fine for the e2e stack;
 *   2. POST the public registration with a `local/…` ID-doc objectKey — assertOwnObjectKey returns
 *      early for `local/` keys, so no presigned upload (and thus no UPLOADS_BUCKET)
 *      is needed, unlike the id-doc upload route;
 *   3. read the clearance back from GET /admin/clearances by the unique player name.
 *
 * Returns the admin-list view plus the ID-doc `objectKey` the registration carried, so a test can
 * assert the moved row keeps byte-identical ID-doc metadata.
 */
export async function seedRegistrationClearance(
  request: APIRequestContext,
  opts: { linkClub: string; prevClub: string; name: string; team?: string },
): Promise<SeededClearance & { idDocObjectKey: string }> {
  const suffix = nextSuffix();
  // A passport identity sidesteps RSA-ID checksum math: dob is supplied directly (idType passport).
  const idNumber = `E2E${suffix.toUpperCase().replace(/-/g, '')}`;
  const objectKey = `local/${TENANT}/${opts.linkClub}/reg-e2e-${suffix}.png`;

  const linkRes = await request.post(`${API_BASE}/clubs/${opts.linkClub}/reg-link`, {
    headers: apiHeaders(adminAuthHeader()),
  });
  expect(
    linkRes.ok(),
    `POST /clubs/${opts.linkClub}/reg-link → ${linkRes.status()} ${await linkRes.text()}`,
  ).toBeTruthy();
  const { playerRegLink } = (await linkRes.json()) as { playerRegLink: { token: string } };

  const regRes = await request.post(
    `${API_BASE}/register/${opts.linkClub}?t=${encodeURIComponent(playerRegLink.token)}`,
    {
      // The public register route is UNAUTHENTICATED — the token in the query authorizes it,
      // so no x-dev-auth header. The tenant is resolved from the token, not the x-tenant header.
      headers: { 'content-type': 'application/json', 'x-tenant': TENANT },
      data: {
        firstName: 'Test',
        lastName: opts.name,
        idType: 'passport',
        idNumber,
        dob: '1995-06-15',
        race: 'African',
        gender: 'Male',
        nationality: 'Zimbabwean',
        cell: '0821234567',
        team: opts.team ?? 'premier',
        district: 'Durban Central',
        lastClubId: opts.prevClub,
        idDocMeta: { objectKey, size: 100, contentType: 'image/png' },
      },
    },
  );
  expect(
    regRes.ok(),
    `POST /register/${opts.linkClub} → ${regRes.status()} ${await regRes.text()}`,
  ).toBeTruthy();

  const playerName = `Test ${opts.name}`;
  const all = await getAllClearances(request);
  const found = all.find((c) => c.playerName === playerName && c.fromClubId === opts.prevClub);
  expect(
    found,
    'seeded registration clearance should appear in GET /admin/clearances',
  ).toBeTruthy();
  return { ...found!, idDocObjectKey: objectKey };
}

/** A roster row as returned by GET /clubs/:id/players — only the fields the specs assert on. */
export interface SeededPlayer {
  naturalKey: string;
  firstName: string;
  lastName: string;
  status: string;
  idDocMeta?: { objectKey?: string };
}

/** List a club's roster (admin) — used to assert where a rejected/reopened player lives. */
export async function listPlayers(
  request: APIRequestContext,
  clubId: string,
): Promise<SeededPlayer[]> {
  const res = await request.get(`${API_BASE}/clubs/${clubId}/players`, {
    headers: apiHeaders(adminAuthHeader()),
  });
  expect(res.ok(), `GET /clubs/${clubId}/players → ${res.status()}`).toBeTruthy();
  return (await res.json()) as SeededPlayer[];
}

/** Reject a clearance directly via the API (used to pre-resolve state a test needs). */
export async function rejectViaApi(
  request: APIRequestContext,
  clr: SeededClearance,
  reason?: string,
): Promise<void> {
  const res = await request.post(`${API_BASE}/admin/clearances/${clr.id}/reject`, {
    headers: apiHeaders(adminAuthHeader()),
    data: { fromClubId: clr.fromClubId, version: clr.version, reason },
  });
  expect(res.ok(), `reject via API → ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Override-approve a clearance directly via the API (used for the stale-card race). */
export async function overrideViaApi(
  request: APIRequestContext,
  clr: SeededClearance,
  reason?: string,
): Promise<void> {
  const res = await request.post(`${API_BASE}/admin/clearances/${clr.id}/override`, {
    headers: apiHeaders(adminAuthHeader()),
    data: { fromClubId: clr.fromClubId, version: clr.version, reason },
  });
  expect(res.ok(), `override via API → ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Re-read a single clearance's admin-list view (for outcome assertions). */
export async function fetchClearance(
  request: APIRequestContext,
  id: string,
): Promise<(SeededClearance & { rejectReason?: string; overrideReason?: string }) | undefined> {
  const all = (await getAllClearances(request)) as Array<
    SeededClearance & { rejectReason?: string; overrideReason?: string }
  >;
  return all.find((c) => c.id === id);
}

/**
 * Open the admin clearances page and narrow the list to a single seeded card by typing its
 * unique player name into the search box. Returns the search-box locator. Because the page's
 * status pills count the SEARCHED set, this makes the pill counts assertable in isolation
 * from every other clearance in the shared DB.
 */
export async function openClearancesFilteredTo(page: Page, uniqueName: string) {
  await page.goto('/admin/clearances');
  const search = page.getByLabel('Search clearances');
  await expect(search).toBeVisible();
  await search.fill(uniqueName);
  return search;
}

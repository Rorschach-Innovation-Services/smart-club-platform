import { test, expect } from '@playwright/test';
import { RUN, repAuthHeader } from './helpers';
import {
  CLUB_NAME,
  clashCheck,
  createReleased,
  createSeries,
  fixture,
  getSeries,
  ground,
  patchSeries,
  repGetSeries,
} from './fixtures-helpers';

/**
 * API-level coverage of the in-season venue-clash gate and the admin clash-check
 * pre-check, exercised through the REAL local API (Playwright's `request` fixture). These
 * assert on HTTP status + response body only — never on internal DB state. The parallel
 * browser flows live in admin-fixture-venue-clash.browser.e2e.ts.
 *
 * Every series is seeded fresh with RUN-unique custom grounds and 2027 dates, so the
 * tenant-wide gate only ever sees the clash the test intends. Runs serially against the
 * one shared demo DB (playwright.config.ts).
 */

test('a released edit onto another released series’ ground is refused (409, structured); store unchanged', async ({
  request,
}) => {
  const G = ground('kingsmead');
  const gB = ground('sahara');
  const D = '2027-03-02';
  const A = await createReleased(request, {
    name: `E2E Clash A ${RUN}`,
    fixtures: [
      fixture({ id: 'f1', home: 'ukzn', away: 'clares', date: D, time: '09:00', venueOverride: G }),
    ],
  });
  const B = await createReleased(request, {
    name: `E2E Clash B ${RUN}`,
    fixtures: [
      fixture({
        id: 'f1',
        home: 'harlequins',
        away: 'berea',
        date: D,
        time: '09:00',
        venueOverride: gB,
      }),
    ],
  });

  const before = await getSeries(request, B.id);
  const res = await patchSeries(request, B.id, {
    version: before.version,
    fixtures: [
      fixture({
        id: 'f1',
        home: 'harlequins',
        away: 'berea',
        date: D,
        time: '09:00',
        venueOverride: G,
      }),
    ],
  });

  expect(res.status()).toBe(409);
  const body = (await res.json()) as {
    error: string;
    code: string;
    clashes: Array<{
      fixtureId: string;
      ground: string;
      date: string;
      time?: string;
      with: {
        seriesId: string;
        seriesName?: string;
        fixtureId: string;
        home?: string;
        away?: string;
      };
    }>;
  };
  expect(body.error).toMatch(/^Change blocked/);
  expect(body.code).toBe('venue_clash');
  expect(body.clashes.length).toBe(1);
  const c = body.clashes[0];
  expect(c.fixtureId).toBe('f1');
  expect(c.ground).toBe(G);
  expect(c.date).toBe(D);
  expect(c.time).toBe('09:00');
  expect(c.with.seriesId).toBe(A.id);
  expect(c.with.seriesName).toBe(A.name);
  expect(c.with.fixtureId).toBe('f1');
  expect(c.with.home).toBe(CLUB_NAME.ukzn);
  expect(c.with.away).toBe(CLUB_NAME.clares);

  // The store is untouched: venue and version unchanged.
  const after = await getSeries(request, B.id);
  expect(after.fixtures[0].venueOverride).toBe(gB);
  expect(after.version).toBe(before.version);
});

test('a stale version wins over the clash gate: plain "series changed; refetch", no code', async ({
  request,
}) => {
  const G = ground('stale');
  const D = '2027-03-03';
  await createReleased(request, {
    fixtures: [fixture({ id: 'f1', home: 'ukzn', away: 'clares', date: D, venueOverride: G })],
  });
  const B = await createReleased(request, {
    fixtures: [
      fixture({
        id: 'f1',
        home: 'harlequins',
        away: 'berea',
        date: D,
        venueOverride: ground('staleB'),
      }),
    ],
  });
  const cur = await getSeries(request, B.id);
  // The edit would move B onto A's ground (a clash), but the version is one behind — the
  // concurrency 409 must win so the admin refetches rather than seeing a venue-clash error.
  const res = await patchSeries(request, B.id, {
    version: cur.version - 1,
    fixtures: [fixture({ id: 'f1', home: 'harlequins', away: 'berea', date: D, venueOverride: G })],
  });
  expect(res.status()).toBe(409);
  const body = (await res.json()) as { error: string; code?: string };
  expect(body.error).toBe('series changed; refetch');
  expect(body.code).toBeUndefined();
});

test('the same clashing edit on a DRAFT saves (no gate on drafts); releasing it is then blocked', async ({
  request,
}) => {
  const G = ground('chats');
  const D = '2027-03-04';
  await createReleased(request, {
    fixtures: [fixture({ id: 'f1', home: 'ukzn', away: 'clares', date: D, venueOverride: G })],
  });
  const B = await createSeries(request, {
    fixtures: [
      fixture({
        id: 'f1',
        home: 'harlequins',
        away: 'berea',
        date: D,
        venueOverride: ground('draftB'),
      }),
    ],
  });

  const cur = await getSeries(request, B.id);
  const edit = await patchSeries(request, B.id, {
    version: cur.version,
    fixtures: [fixture({ id: 'f1', home: 'harlequins', away: 'berea', date: D, venueOverride: G })],
  });
  expect(edit.status()).toBe(200);

  // The release gate still applies at the false→true transition.
  const cur2 = await getSeries(request, B.id);
  const rel = await patchSeries(request, B.id, {
    approved: true,
    released: true,
    version: cur2.version,
  });
  expect(rel.status()).toBe(409);
  const body = (await rel.json()) as { error: string; code: string };
  expect(body.error).toMatch(/^Release blocked/);
  expect(body.code).toBe('venue_clash');
});

test('a released edit to a free ground saves; releasedAt unchanged, version +1, rep sees the new venue', async ({
  request,
}) => {
  const g1 = ground('freeA');
  const g2 = ground('freeB');
  const D = '2027-03-05';
  const B = await createReleased(request, {
    fixtures: [fixture({ id: 'f1', home: 'ukzn', away: 'clares', date: D, venueOverride: g1 })],
  });
  const before = await getSeries(request, B.id);
  const res = await patchSeries(request, B.id, {
    version: before.version,
    fixtures: [fixture({ id: 'f1', home: 'ukzn', away: 'clares', date: D, venueOverride: g2 })],
  });
  expect(res.status()).toBe(200);

  const after = await getSeries(request, B.id);
  expect(after.fixtures[0].venueOverride).toBe(g2);
  expect(after.releasedAt).toBe(before.releasedAt);
  expect(after.version).toBe(before.version + 1);

  const repView = await repGetSeries(request, 'ukzn', B.id);
  expect(repView?.fixtures[0].venueOverride).toBe(g2);
});

test('a regenerate-shaped PATCH (all-new fixture ids) is gated: clash → 409, clean → 200', async ({
  request,
}) => {
  const G = ground('regenG');
  const D = '2027-03-06';
  await createReleased(request, {
    fixtures: [fixture({ id: 'f1', home: 'ukzn', away: 'clares', date: D, venueOverride: G })],
  });

  // New ids that reintroduce the ground double-booking are refused.
  const sClash = await createReleased(request, {
    fixtures: [
      fixture({
        id: 'f1',
        home: 'harlequins',
        away: 'berea',
        date: D,
        venueOverride: ground('regenS1'),
      }),
    ],
  });
  const curClash = await getSeries(request, sClash.id);
  const r409 = await patchSeries(request, sClash.id, {
    version: curClash.version,
    fixtures: [fixture({ id: 'r1', home: 'harlequins', away: 'berea', date: D, venueOverride: G })],
  });
  expect(r409.status()).toBe(409);
  expect((await r409.json()).code).toBe('venue_clash');

  // New ids onto a free ground introduce no clash and save.
  const sClean = await createReleased(request, {
    fixtures: [
      fixture({
        id: 'f1',
        home: 'spartan',
        away: 'tongaat',
        date: D,
        venueOverride: ground('regenS2'),
      }),
    ],
  });
  const curClean = await getSeries(request, sClean.id);
  const r200 = await patchSeries(request, sClean.id, {
    version: curClean.version,
    fixtures: [
      fixture({
        id: 'r9',
        home: 'spartan',
        away: 'tongaat',
        date: D,
        venueOverride: ground('regenFree'),
      }),
    ],
  });
  expect(r200.status()).toBe(200);
});

test('clash-check: aligned results, rep 403, malformed 400s, unknown series 404', async ({
  request,
}) => {
  const G = ground('ccG');
  const D = '2027-03-07';
  await createReleased(request, {
    fixtures: [fixture({ id: 'f1', home: 'ukzn', away: 'clares', date: D, venueOverride: G })],
  });
  const S = await createReleased(request, {
    fixtures: [
      fixture({
        id: 'sf1',
        home: 'harlequins',
        away: 'berea',
        date: D,
        venueOverride: ground('ccS'),
      }),
    ],
  });
  const gFree = ground('ccFree');

  const res = await clashCheck(request, S.id, [
    fixture({ id: 'sf1', home: 'harlequins', away: 'berea', date: D, venueOverride: G }), // clashes with A
    fixture({ id: 'sf1', home: 'harlequins', away: 'berea', date: D, venueOverride: gFree }), // clean
  ]);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    results: Array<{ clashes: unknown[]; introduced: unknown[] }>;
  };
  expect(body.results.length).toBe(2);
  expect(body.results[0].introduced.length).toBe(1);
  expect(body.results[1].introduced.length).toBe(0);
  expect(body.results[1].clashes.length).toBe(0);

  // A rep is forbidden.
  expect(
    (await clashCheck(request, S.id, [fixture({ id: 'sf1' })], repAuthHeader('ukzn'))).status(),
  ).toBe(403);

  // Malformed bodies.
  expect((await clashCheck(request, S.id, [])).status()).toBe(400);
  expect((await clashCheck(request, S.id, [{}])).status()).toBe(400);
  expect(
    (
      await clashCheck(
        request,
        S.id,
        new Array(21).fill(0).map((_, i) => ({ id: `f${i}` })),
      )
    ).status(),
  ).toBe(400);

  // Unknown series.
  expect(
    (await clashCheck(request, `no-such-series-${RUN}`, [fixture({ id: 'x' })])).status(),
  ).toBe(404);
});

test('recall (released:false) carrying a clashing fixtures array is never gated', async ({
  request,
}) => {
  const G = ground('recallG');
  const D = '2027-03-08';
  await createReleased(request, {
    fixtures: [fixture({ id: 'f1', home: 'ukzn', away: 'clares', date: D, venueOverride: G })],
  });
  const B = await createReleased(request, {
    fixtures: [
      fixture({
        id: 'f1',
        home: 'harlequins',
        away: 'berea',
        date: D,
        venueOverride: ground('recallB'),
      }),
    ],
  });
  const cur = await getSeries(request, B.id);
  const res = await patchSeries(request, B.id, {
    version: cur.version,
    released: false,
    fixtures: [fixture({ id: 'f1', home: 'harlequins', away: 'berea', date: D, venueOverride: G })],
  });
  expect(res.status()).toBe(200);
  const after = await getSeries(request, B.id);
  expect(after.released).toBe(false);
});

test('rep authorization: PATCH 403; drafts hidden; a withheld-venue series exposes no venue keys', async ({
  request,
}) => {
  // A rep cannot write a series.
  const B = await createReleased(request, {
    fixtures: [
      fixture({
        id: 'f1',
        home: 'ukzn',
        away: 'clares',
        date: '2027-03-10',
        venueOverride: ground('authB'),
      }),
    ],
  });
  const cur = await getSeries(request, B.id);
  const r = await patchSeries(
    request,
    B.id,
    { version: cur.version, fixtures: B.fixtures },
    repAuthHeader('ukzn'),
  );
  expect(r.status()).toBe(403);

  // A rep's GET never includes an unreleased series.
  const draft = await createSeries(request, {
    fixtures: [fixture({ id: 'f1', home: 'ukzn', away: 'clares', date: '2027-03-11' })],
  });
  expect(await repGetSeries(request, 'ukzn', draft.id)).toBeUndefined();

  // A released series with venues withheld hides every fixture venue key but keeps the flag.
  const W = await createReleased(request, {
    fixtures: [
      fixture({
        id: 'f1',
        home: 'ukzn',
        away: 'clares',
        date: '2027-03-12',
        venueOverride: ground('authWh'),
      }),
    ],
    withheld: { venue: true },
  });
  const repView = await repGetSeries(request, 'ukzn', W.id);
  expect(repView).toBeTruthy();
  expect(repView!.withheld?.venue).toBe(true);
  expect(repView!.fixtures[0].venueOverride).toBeUndefined();
  expect(repView!.fixtures[0].venueName).toBeUndefined();
});

test('withheld flow: a clean venue edit stays hidden; reveal exposes the EDITED venue', async ({
  request,
}) => {
  const D = '2027-03-13';
  const W = await createReleased(request, {
    fixtures: [
      fixture({ id: 'f1', home: 'ukzn', away: 'clares', date: D, venueOverride: ground('whInit') }),
    ],
    withheld: { venue: true },
  });
  const gNew = ground('whNew');

  const cur = await getSeries(request, W.id);
  const res = await patchSeries(request, W.id, {
    version: cur.version,
    fixtures: [fixture({ id: 'f1', home: 'ukzn', away: 'clares', date: D, venueOverride: gNew })],
  });
  expect(res.status()).toBe(200);

  // The rep still sees no venue keys after the edit.
  let repView = await repGetSeries(request, 'ukzn', W.id);
  expect(repView!.fixtures[0].venueOverride).toBeUndefined();
  expect(repView!.withheld?.venue).toBe(true);

  // Revealing exposes the EDITED venue (the store held the real value throughout).
  const cur2 = await getSeries(request, W.id);
  const rev = await patchSeries(request, W.id, { reveal: ['venue'], version: cur2.version });
  expect(rev.status()).toBe(200);

  repView = await repGetSeries(request, 'ukzn', W.id);
  expect(repView!.fixtures[0].venueOverride).toBe(gNew);
  expect(repView!.revealedAt?.venue).toBeTruthy();
});

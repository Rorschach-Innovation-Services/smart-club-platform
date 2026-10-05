/**
 * LOCAL DEMO ONLY: a realistic match week for the admin "Fixtures & Venues" page.
 *
 *   1. Start the local stack pointed at the stand-in medicoach this script runs:
 *        MEDICOACH_SYNC_URL=http://localhost:4799 MEDICOACH_SYNC_SECRET=local-demo-secret \
 *          NOTIFY_DRY_RUN=1 npm run dev:local:demo
 *   2. npx tsx packages/api/scripts/demo-fixtures-week.ts
 *
 * It grounds every club (venues from the club records), releases the two EMCU series with one
 * round per Saturday around TODAY (two played weekends, this weekend, then the rest), appoints
 * umpires to most of the played and upcoming games (leaving a few gaps), and then serves a
 * signed medicoach `/changes` page with results for the played games, the way medicoach would:
 * one played game is left without a result, one is a no-result. "Sync now" pulls them through
 * the real puller, so the results land on the fixtures exactly as they will in production.
 *
 * Notices stay dry runs locally (no provider credentials; NOTIFY_DRY_RUN=1 to be sure).
 */
import { createServer } from 'node:http';
import { verifySignature } from '../src/medicoach-sync-contract.js';

const API = process.env.DEMO_API ?? 'http://localhost:3333';
const PORT = Number(process.env.DEMO_STUB_PORT ?? 4799);
const SECRET = process.env.MEDICOACH_SYNC_SECRET ?? 'local-demo-secret';
const TENANT = 'dolphins';
const DAY = 86_400_000;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const OPERATOR = b64({
  sub: 'dev-operator',
  email: 'operator@platform.local',
  memberships: [{ tenantId: '*', role: 'operator', clubIds: [] }],
});
const ADMIN = b64({
  sub: 'dev-admin',
  email: 'admin@local',
  memberships: [{ tenantId: TENANT, role: 'admin', clubIds: [] }],
});
async function api<T = unknown>(path: string, init: RequestInit & { auth?: string } = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'x-tenant': TENANT,
      'x-dev-auth': init.auth ?? ADMIN,
      'content-type': 'application/json',
    },
  });
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface Fixture {
  id: string;
  round?: number;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  status?: string;
}
interface Series {
  id: string;
  name: string;
  version: number;
  maxOvers?: number;
  leagueKey?: string;
  fixtures: Fixture[];
}
interface Club {
  id: string;
  name: string;
  ground?: { venue?: string; suburb?: string; lat?: number; lon?: number };
}

/** SAST calendar date of `ms`. */
const sastDate = (ms: number) => new Date(ms + 2 * 3_600_000).toISOString().slice(0, 10);
/** The Saturday on or before today (SAST). */
function lastSaturday(): number {
  const today = Date.parse(`${sastDate(Date.now())}T00:00:00Z`);
  const dow = new Date(today).getUTCDay();
  return today - ((dow + 1) % 7) * DAY;
}

function rng(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const results = new Map<string, unknown>();

async function seed() {
  // Sync on (results reach smart club only through it).
  const cfg = await api<{ features?: Record<string, boolean> }>(`/platform/tenants/${TENANT}`, {
    auth: OPERATOR,
  });
  await api(`/platform/tenants/${TENANT}`, {
    method: 'PUT',
    auth: OPERATOR,
    body: JSON.stringify({ features: { ...(cfg.features ?? {}), medicoachSync: true } }),
  });

  // Grounds from the club records (what "Sync from club records" does).
  const clubs = await api<Club[]>('/clubs');
  const have = new Set((await api<Array<{ id: string }>>('/venues')).map((v) => v.id));
  for (const c of clubs) {
    if (!c.ground?.venue) continue;
    const id = `v-${c.id}`;
    if (have.has(id)) continue;
    await api(`/venues/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        id,
        name: c.ground.venue,
        suburb: c.ground.suburb,
        lat: c.ground.lat,
        lon: c.ground.lon,
        homeClubIds: [c.id],
        surfaces: 1,
      }),
    });
  }
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));

  // One round per Saturday: rounds 1–2 played, round 3 this coming Saturday, then weekly.
  const sat0 = lastSaturday();
  const thisSat = sastDate(Date.now()) === sastDate(sat0) ? sat0 : sat0 + 7 * DAY;
  const all = await api<Series[]>('/series');
  const played: Array<{ s: Series; f: Fixture }> = [];
  for (const s of all.filter((x) => x.id.startsWith('s-emcu-'))) {
    const fixtures = s.fixtures.map((f, i) => {
      const round = f.round ?? 1;
      const day = thisSat + (round - 3) * 7 * DAY;
      const next: Fixture = {
        ...f,
        date: sastDate(day),
        time: i % 2 ? '13:00' : '10:00',
        status: 'scheduled',
      };
      // One game of this weekend is postponed (a wet ground).
      if (round === 3 && i === s.fixtures.findIndex((x) => (x.round ?? 1) === 3))
        next.status = 'postponed';
      if (round <= 2) played.push({ s, f: next });
      return next;
    });
    await api(`/series/${s.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fixtures, approved: true, released: true, version: s.version }),
    });
  }

  // Umpires: a small panel, appointed to most games of the played weekends and this weekend.
  const names = [
    'Sipho Mkhize',
    'Riaan Botes',
    'Yusuf Desai',
    'Anele Zungu',
    'Grant Coetzer',
    'Thabo Radebe',
  ];
  const existing =
    await api<Array<{ id: string; displayName?: string; name?: string }>>('/umpires');
  const umpires = [...existing];
  for (const n of names)
    if (!existing.some((u) => (u.displayName ?? u.name) === n))
      umpires.push(
        await api('/umpires', { method: 'POST', body: JSON.stringify({ displayName: n }) }),
      );
  const series = await api<Series[]>('/series');
  let k = 0;
  for (const s of series.filter((x) => x.id.startsWith('s-emcu-')))
    for (const f of s.fixtures) {
      if ((f.round ?? 1) > 3) continue;
      k++;
      if (k % 5 === 0) continue; // leave a gap to find
      const two =
        k % 4 === 0
          ? [umpires[k % umpires.length]]
          : [umpires[k % umpires.length], umpires[(k + 2) % umpires.length]];
      await api(`/series/${s.id}/fixtures/${f.id}/officials`, {
        method: 'PUT',
        body: JSON.stringify({ umpires: two.map((u) => ({ umpireId: u.id })) }),
      });
    }

  // Results for the played games, as medicoach would report them.
  played.forEach(({ s, f }, i) => {
    if (i === 3) return; // one played game has no result yet
    const r = rng(`${s.id}:${f.id}`);
    const overs = s.maxOvers ?? 50;
    const ref = `smartclub:${TENANT}:fixture:${s.id}:${f.id}`;
    const recordedAt = new Date(Date.parse(`${f.date}T17:30:00+02:00`)).toISOString();
    const base = {
      ref,
      syncStamp: recordedAt,
      schedule: {
        scheduledTime: `${f.date}T${f.time}:00+02:00`,
        timeTbc: false,
        dateTbc: false,
        venue: null,
        postponed: false,
        cancelled: false,
        changedAt: '1970-01-01T00:00:00.000Z',
      },
      teams: { homeRef: null, awayRef: null },
      resultClearedAt: null,
    };
    if (i === 6) {
      results.set(ref, {
        ...base,
        result: {
          homeScore: '87/3 (19.2)',
          awayScore: null,
          summary: 'No result — rain',
          winner: 'none',
          method: 'no-result',
          noResult: true,
          source: 'live',
          recordedAt,
          scoringSide: 'home',
          captainRef: null,
          medicoachMatchUrl: `https://live.medicoach.co.za/match/demo-${f.id}`,
        },
      });
      return;
    }
    const first = 150 + Math.floor(r() * 140);
    const w1 = 3 + Math.floor(r() * 8);
    const chaseWins = r() < 0.5;
    const second = chaseWins ? first + 1 + Math.floor(r() * 6) : first - 1 - Math.floor(r() * 60);
    const w2 = chaseWins ? 2 + Math.floor(r() * 6) : 6 + Math.floor(r() * 5);
    const homeBatFirst = r() < 0.5;
    const o2 = chaseWins ? `${overs - 1 - Math.floor(r() * 6)}.${Math.floor(r() * 6)}` : `${overs}`;
    const firstLine = `${first}/${w1} (${overs})`;
    const secondLine = `${second}/${w2} (${o2})`;
    const batFirst = homeBatFirst ? f.home! : f.away!;
    const batSecond = homeBatFirst ? f.away! : f.home!;
    const winner = chaseWins ? batSecond : batFirst;
    results.set(ref, {
      ...base,
      result: {
        homeScore: homeBatFirst ? firstLine : secondLine,
        awayScore: homeBatFirst ? secondLine : firstLine,
        summary: chaseWins
          ? `${clubName.get(winner) ?? winner} won by ${10 - w2} wickets`
          : `${clubName.get(winner) ?? winner} won by ${first - second} runs`,
        winner: winner === f.home ? 'home' : 'away',
        method: 'normal',
        noResult: false,
        source: i % 3 === 2 ? 'manual' : 'live',
        recordedAt,
        scoringSide: 'home',
        captainRef: null,
        medicoachMatchUrl: `https://live.medicoach.co.za/match/demo-${f.id}`,
      },
    });
  });
  console.log(
    `· ${clubs.length} clubs grounded · rounds placed around ${sastDate(thisSat)} · ` +
      `${played.length} played, ${results.size} results ready`,
  );
}

/* ── The signed medicoach endpoints the puller calls ── */
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const check = verifySignature({
      secret: SECRET,
      method: req.method ?? 'GET',
      pathAndQuery: req.url ?? '',
      body: raw,
      timestampHeader: req.headers['x-sync-timestamp'] as string | undefined,
      signatureHeader: req.headers['x-sync-signature'] as string | undefined,
    });
    if (!check.ok) return send(401, { error: 'bad signature' });
    const url = new URL(req.url ?? '/', 'http://stub');
    if (url.pathname === '/integrations/smartclub/changes')
      return send(200, {
        version: 1,
        tenant: TENANT,
        nextCursor: new Date(Date.now() - 120_000).toISOString(),
        hasMore: false,
        fixtures: [...results.values()],
      });
    if (url.pathname === '/integrations/smartclub/schedule' && req.method === 'POST') {
      const body = JSON.parse(raw) as { changes: Array<{ ref: string }> };
      return send(200, {
        version: 1,
        results: body.changes.map((c) => ({ ref: c.ref, status: 'applied' })),
      });
    }
    send(404, { error: 'not found' });
  });
});

server.listen(PORT, async () => {
  try {
    await seed();
    const run = await api<{ status: string; counts?: Record<string, number> }>(
      '/integrations/medicoach/sync-now',
      { method: 'POST' },
    );
    console.log(`· sync: ${run.status} · ${JSON.stringify(run.counts ?? {})}`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

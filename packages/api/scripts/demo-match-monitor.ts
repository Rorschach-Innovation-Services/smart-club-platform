/**
 * LOCAL DEMO ONLY: a stand-in medicoach for the admin "Match monitor".
 *
 *   1. Start the local stack pointed at it:
 *        MEDICOACH_SYNC_URL=http://localhost:4799 MEDICOACH_SYNC_SECRET=local-demo-secret \
 *          npm run dev:local:demo
 *   2. npx tsx packages/api/scripts/demo-match-monitor.ts
 *
 * It switches the sync on for `dolphins`, moves ten EMCU fixtures onto times around NOW
 * (finished, live, between innings, a silent scorer, late, not started, upcoming, plus one
 * postponed), and then answers the signed contract-v1 endpoints the way medicoach would:
 * `GET /integrations/smartclub/live` with simulated T20 ball-by-ball timings (seeded per
 * fixture, so a refresh moves the same game forward rather than inventing a new one),
 * `GET /changes` with nothing new, and `POST /schedule` accepting everything.
 *
 * Re-run it to re-centre the games on the current time. A game that started before midnight
 * keeps yesterday's date, as a real evening game would.
 */
import { createServer } from 'node:http';
import { verifySignature } from '../src/medicoach-sync-contract.js';

const API = process.env.DEMO_API ?? 'http://localhost:3333';
const PORT = Number(process.env.DEMO_STUB_PORT ?? 4799);
const SECRET = process.env.MEDICOACH_SYNC_SECRET ?? 'local-demo-secret';
const TENANT = 'dolphins';
const MIN = 60_000;
const SAST = 2 * 60 * MIN;
/** When the demo started: a silent scorer's last ball is pinned relative to this. */
const BOOT = Date.now();

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
const api = async (path: string, init: RequestInit & { auth?: string } = {}) => {
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
  return res.json();
};

/* ── Scenarios: minutes from now to the scheduled start, and how the game goes ── */
interface Scenario {
  label: string;
  startIn: number;
  /** Minutes from the scheduled start to the first ball. */
  delay?: number;
  /** No live match in medicoach at all. */
  none?: boolean;
  breakMin?: number;
  /** Unexplained gaps: [innings, legal balls bowled before the delayed ball, minutes]. */
  gaps?: Array<[number, number, number]>;
  /** The scorer stopped inputting this many minutes ago (game still in progress). */
  quietFor?: number;
  postponed?: boolean;
  /** Times the scorer pressed undo. */
  undo?: number;
  /** Team-sheet problems to plant (see `teamSheets`). */
  sheet?: Array<'added-unregistered' | 'added-registered' | 'other-club' | 'sheet-unregistered'>;
}
const SCENARIOS: Scenario[] = [
  { label: 'finished, on time', startIn: -245, delay: 3, breakMin: 24, undo: 1 },
  {
    label: 'finished, late start + long break',
    startIn: -275,
    delay: 28,
    breakMin: 38,
    gaps: [[2, 61, 7]],
    undo: 3,
    sheet: ['other-club'],
  },
  {
    label: '2nd innings, delays between balls',
    startIn: -165,
    delay: 6,
    breakMin: 22,
    gaps: [
      [1, 44, 6],
      [2, 20, 9],
    ],
    undo: 2,
    sheet: ['added-unregistered'],
  },
  { label: 'innings break, heavy undo', startIn: -105, delay: 2, breakMin: 30, undo: 7 },
  {
    label: 'scorer silent, unregistered on the sheet',
    startIn: -55,
    delay: 4,
    quietFor: 14,
    undo: 11,
    sheet: ['sheet-unregistered'],
  },
  {
    label: '1st innings, a registered player added',
    startIn: -35,
    delay: 1,
    sheet: ['added-registered'],
  },
  { label: 'awaiting first ball', startIn: -25, delay: 60 },
  { label: 'no live scoring', startIn: -40, none: true },
  { label: 'upcoming', startIn: 45 },
  { label: 'upcoming later', startIn: 130 },
  { label: 'postponed', startIn: 60, postponed: true },
];

const scenarioByRef = new Map<string, Scenario>();

/* ── Rosters: fictional registered players for every demo club (local only) ── */
const FIRST = [
  'Ayanda',
  'Bongani',
  'Caleb',
  'Dylan',
  'Ethan',
  'Faraaz',
  'Gareth',
  'Hlumelo',
  'Imraan',
  'Jason',
  'Kagiso',
  'Luthando',
  'Mpho',
  'Nabeel',
  'Owethu',
  'Pieter',
];
const LAST = [
  'Dlamini',
  'Naidoo',
  'Botha',
  'Khumalo',
  'Pillay',
  'van Wyk',
  'Mthembu',
  'Govender',
  'Smit',
  'Zulu',
  'Moodley',
  'Ngcobo',
  'Pretorius',
  'Maharaj',
  'Cele',
  'Fourie',
];

/** A valid-format (Luhn) RSA ID for a fictional adult: born 1990–1999, SA citizen. */
function demoIdNumber(seq: number): string {
  const yy = String(90 + (seq % 10));
  const mm = String(1 + (seq % 12)).padStart(2, '0');
  const dd = String(1 + (seq % 28)).padStart(2, '0');
  const body = `${yy}${mm}${dd}${String(5000 + seq).padStart(4, '0')}08`;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    let d = Number(body[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

interface RosterRow {
  naturalKey: string;
  firstName: string;
  lastName: string;
  status?: string;
}
const rosters = new Map<string, RosterRow[]>();

async function seedRosters(clubIds: string[]) {
  let seq = 0;
  for (const clubId of clubIds) {
    let rows = (await api(`/clubs/${clubId}/players`)) as RosterRow[];
    const base = clubIds.indexOf(clubId) * 16;
    for (let i = rows.length; i < 14; i++) {
      seq = base + i;
      await api(`/clubs/${clubId}/players`, {
        method: 'POST',
        body: JSON.stringify({
          firstName: FIRST[(seq * 7) % FIRST.length],
          lastName: LAST[(seq * 5 + clubIds.indexOf(clubId)) % LAST.length],
          idNumber: demoIdNumber(seq),
          race: 'Prefer not to say',
          gender: 'Male',
          nationality: 'South African',
          cell: `0600000${String(seq).padStart(3, '0')}`,
          team: 'premier',
          district: 'Demo',
        }),
      }).catch((err) =>
        console.warn(`  (roster ${clubId}: ${(err as Error).message.slice(0, 80)})`),
      );
    }
    rows = (await api(`/clubs/${clubId}/players`)) as RosterRow[];
    rosters.set(clubId, rows);
  }
}

/* ── Seed: switch the sync on, put the fixtures around now ── */
function slot(nowMs: number, startIn: number) {
  const t = Math.round((nowMs + startIn * MIN) / (5 * MIN)) * 5 * MIN + SAST;
  const d = new Date(t);
  return {
    date: d.toISOString().slice(0, 10),
    time: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
  };
}

async function seed() {
  const cfg = (await api(`/platform/tenants/${TENANT}`, { auth: OPERATOR })) as {
    features?: Record<string, boolean>;
  };
  await api(`/platform/tenants/${TENANT}`, {
    method: 'PUT',
    auth: OPERATOR,
    body: JSON.stringify({ features: { ...(cfg.features ?? {}), medicoachSync: true } }),
  });
  const all = (await api('/series')) as Array<{
    id: string;
    version: number;
    fixtures: Array<Record<string, unknown>>;
  }>;
  const now = Date.now();
  const plan: Array<[string, number]> = [
    ['s-emcu-d1-26-27', 7],
    ['s-emcu-d2-26-27', 4],
  ];
  let k = 0;
  for (const [id, n] of plan) {
    const s = all.find((x) => x.id === id);
    if (!s)
      throw new Error(`demo series ${id} missing — start the stack with npm run dev:local:demo`);
    const fixtures = s.fixtures.map((f, i) => {
      if (i >= n || k >= SCENARIOS.length) return f;
      const sc = SCENARIOS[k++];
      scenarioByRef.set(`smartclub:${TENANT}:fixture:${id}:${f.id}`, sc);
      const { date, time } = slot(now, sc.startIn);
      return { ...f, date, time, status: sc.postponed ? 'postponed' : 'scheduled' };
    });
    await api(`/series/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fixtures, approved: true, released: true, version: s.version }),
    });
  }
  const clubIds = new Set<string>();
  for (const s of (await api('/series')) as Array<{
    fixtures: Array<{ home?: string; away?: string }>;
  }>)
    for (const f of s.fixtures) for (const c of [f.home, f.away]) if (c) clubIds.add(c);
  await seedRosters([...clubIds]);
  console.log(`· rosters ready for ${rosters.size} clubs (fictional players)`);
  console.log(`· ${scenarioByRef.size} fixtures placed around ${slot(now, 0).time} SAST, sync on`);
}

/* ── Simulated live scoring ── */
function rng(seedText: string) {
  let h = 2166136261;
  for (const ch of seedText) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

interface Ball {
  t: number;
  legalBefore: number;
  gapSec: number;
  reason: 'drinks' | null;
  /** The innings score after this ball. */
  after: { runs: number; wkts: number; legal: number };
}
interface Inn {
  balls: Ball[];
  runs: number;
  wkts: number;
  legal: number;
  end: number;
}

function playInnings(
  r: () => number,
  inn: number,
  start: number,
  sc: Scenario,
  target?: number,
): Inn {
  const balls: Ball[] = [];
  let t = start;
  let runs = 0;
  let wkts = 0;
  let legal = 0;
  let drinksDone = false;
  while (legal < 120 && wkts < 10 && !(target !== undefined && runs > target)) {
    let gapSec = balls.length ? Math.round(26 + r() * 22 + (legal % 6 === 0 ? 35 : 0)) : 0;
    let reason: Ball['reason'] = null;
    if (!drinksDone && legal >= 60 && legal % 6 === 0) {
      gapSec = 300 + Math.round(r() * 80);
      reason = 'drinks';
      drinksDone = true;
    }
    const injected = sc.gaps?.find(([i, at]) => i === inn && at === legal);
    if (injected && balls.length && !balls.some((b) => b.legalBefore === legal && b.gapSec >= 120))
      gapSec = injected[2] * 60 + Math.round(r() * 40);
    t += gapSec * 1000;
    const legalBefore = legal;
    if (r() < 0.05)
      runs += 1; // wide / no-ball: not a legal ball
    else {
      legal++;
      const x = r();
      if (x < 0.045) wkts++;
      else runs += x < 0.36 ? 0 : x < 0.7 ? 1 : x < 0.8 ? 2 : x < 0.82 ? 3 : x < 0.94 ? 4 : 6;
    }
    balls.push({ t, legalBefore, gapSec, reason, after: { runs, wkts, legal } });
  }
  return { balls, runs, wkts, legal, end: t };
}

const overs = (legal: number) => `${Math.floor(legal / 6)}.${legal % 6}`;
const label = (legalBefore: number) => `${Math.floor(legalBefore / 6)}.${(legalBefore % 6) + 1}`;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Each side's eleven from its club roster (with smart club refs, as imported players carry),
 * plus the scenario's planted problems: a player added mid-match who isn't registered, one
 * added by name who is, a registered player from another club, an unknown name on the sheet.
 */
function teamSheets(
  homeClub: string,
  awayClub: string,
  sc: Scenario,
  first: number,
  started: boolean,
) {
  const refOf = (r: RosterRow) => `smartclub:${TENANT}:player:${r.naturalKey}`;
  const eleven = (clubId: string, side: 'home' | 'away') =>
    (rosters.get(clubId) ?? []).slice(0, 11).map((r) => ({
      side,
      name: `${r.firstName} ${r.lastName}`,
      ref: refOf(r) as string | null,
      addedDuringMatch: false,
      addedAt: null as string | null,
    }));
  const players = [...eleven(homeClub, 'home'), ...eleven(awayClub, 'away')];
  const at = (min: number) => (started ? iso(first + min * MIN) : null);
  for (const kind of sc.sheet ?? []) {
    if (kind === 'other-club') {
      const other = [...rosters.entries()].find(
        ([c]) => c !== homeClub && c !== awayClub,
      )?.[1]?.[12];
      if (other)
        players[3] = {
          ...players[3],
          name: `${other.firstName} ${other.lastName}`,
          ref: refOf(other),
        };
    } else if (kind === 'sheet-unregistered') {
      players[16] = { ...players[16], name: 'Tumelo Sithebe', ref: null };
    } else if (!started) continue;
    else if (kind === 'added-unregistered')
      players.push({
        side: 'away',
        name: 'Ricky Mabuza',
        ref: null,
        addedDuringMatch: true,
        addedAt: at(38),
      });
    else if (kind === 'added-registered') {
      const r = (rosters.get(homeClub) ?? [])[12];
      if (r)
        players.push({
          side: 'home',
          name: `${r.firstName} ${r.lastName}`,
          ref: null,
          addedDuringMatch: true,
          addedAt: at(9),
        });
    }
  }
  return players;
}

function liveFor(
  ref: string,
  sc: Scenario,
  scheduled: number,
  now: number,
  clubs: { home: string; away: string },
) {
  const r = rng(ref);
  const homeBats = r() < 0.5;
  const first = scheduled + (sc.delay ?? 0) * MIN;
  const base = {
    ref,
    oversPerSide: 20,
    medicoachMatchUrl: `https://live.medicoach.co.za/match/demo-${encodeURIComponent(ref.split(':').pop()!)}`,
  };
  if (now < first)
    return {
      ...base,
      status: 'not_started',
      startedAt: null,
      endedAt: null,
      lastInputAt: null,
      innings: [],
      deliveries: 0,
      medianGapSec: null,
      longGaps: [],
      undoCount: 0,
      players: teamSheets(clubs.home, clubs.away, sc, first, false),
    };
  const i1 = playInnings(r, 1, first, sc);
  const i2Start = i1.end + (sc.breakMin ?? 25) * MIN;
  const i2 = playInnings(r, 2, i2Start, sc, i1.runs);
  const cutoff = sc.quietFor ? Math.min(now, BOOT - sc.quietFor * MIN) : now;
  const seen = (inn: Inn) => inn.balls.filter((b) => b.t <= cutoff);
  const b1 = seen(i1);
  const b2 = seen(i2);
  const zero = { runs: 0, wkts: 0, legal: 0 };
  const scoreOf = (seenBalls: Ball[]) => seenBalls[seenBalls.length - 1]?.after ?? zero;
  const s1 = scoreOf(b1);
  const i1Done = b1.length === i1.balls.length;
  const i2Begun = b2.length > 0;
  const s2 = i2Begun ? scoreOf(b2) : null;
  const i2Done = b2.length === i2.balls.length;
  const innings = [
    {
      number: 1,
      battingSide: homeBats ? 'home' : 'away',
      runs: s1.runs,
      wickets: s1.wkts,
      overs: overs(s1.legal),
      startedAt: iso(first),
      endedAt: i1Done ? iso(i1.end) : null,
    },
    ...(s2
      ? [
          {
            number: 2,
            battingSide: homeBats ? 'away' : 'home',
            runs: s2.runs,
            wickets: s2.wkts,
            overs: overs(s2.legal),
            startedAt: iso(i2Start),
            endedAt: i2Done ? iso(i2.end) : null,
          },
        ]
      : []),
  ];
  const all = [...b1.map((b) => ({ ...b, inn: 1 })), ...b2.map((b) => ({ ...b, inn: 2 }))];
  const within = all
    .filter((b) => b.gapSec > 0)
    .map((b) => b.gapSec)
    .sort((a, b) => a - b);
  const status = i2Done
    ? 'completed'
    : i2Begun
      ? 'in_progress'
      : i1Done
        ? 'innings_break'
        : 'in_progress';
  const last = all.length ? all[all.length - 1].t : first;
  return {
    ...base,
    status,
    startedAt: iso(first),
    endedAt: i2Done ? iso(i2.end) : null,
    lastInputAt: iso(last),
    innings,
    deliveries: all.length,
    medianGapSec: within.length ? within[Math.floor(within.length / 2)] : null,
    longGaps: all
      .filter((b) => b.gapSec >= 120)
      .sort((a, b) => b.gapSec - a.gapSec)
      .slice(0, 50)
      .map((b) => ({
        innings: b.inn,
        over: label(b.legalBefore),
        at: iso(b.t),
        gapSec: b.gapSec,
        reason: b.reason,
      })),
    undoCount: sc.undo ?? 0,
    players: teamSheets(clubs.home, clubs.away, sc, first, true),
  };
}

async function liveDay(date: string) {
  const all = (await api('/series')) as Array<{
    id: string;
    fixtures: Array<{ id: string; date?: string; time?: string }>;
  }>;
  const now = Date.now();
  const matches = [];
  for (const s of all)
    for (const f of s.fixtures ?? []) {
      const ref = `smartclub:${TENANT}:fixture:${s.id}:${f.id}`;
      const sc = scenarioByRef.get(ref);
      if (!sc || sc.none || sc.postponed || f.date !== date || !f.time) continue;
      const scheduled = Date.parse(`${f.date}T${f.time}:00+02:00`);
      matches.push(
        liveFor(ref, sc, scheduled, now, {
          home: (f as { home?: string }).home ?? '',
          away: (f as { away?: string }).away ?? '',
        }),
      );
    }
  return { version: 1, tenant: TENANT, date, generatedAt: new Date(now).toISOString(), matches };
}

/* ── The signed endpoints ── */
createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
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
    try {
      if (url.pathname === '/integrations/smartclub/live')
        return send(200, await liveDay(url.searchParams.get('date') ?? ''));
      if (url.pathname === '/integrations/smartclub/changes')
        return send(200, {
          version: 1,
          tenant: TENANT,
          nextCursor: new Date(Date.now() - 2 * MIN).toISOString(),
          hasMore: false,
          fixtures: [],
        });
      if (url.pathname === '/integrations/smartclub/schedule' && req.method === 'POST') {
        const body = JSON.parse(raw) as { changes: Array<{ ref: string }> };
        return send(200, {
          version: 1,
          results: body.changes.map((c) => ({ ref: c.ref, status: 'applied' })),
        });
      }
      send(404, { error: 'not found' });
    } catch (err) {
      console.error(err);
      send(500, { error: 'stub failed' });
    }
  });
}).listen(PORT, async () => {
  console.log(`· demo medicoach on http://localhost:${PORT}`);
  await seed();
  for (const [ref, sc] of scenarioByRef)
    console.log(`  ${ref.split(':').slice(-2).join('/')}: ${sc.label}`);
});

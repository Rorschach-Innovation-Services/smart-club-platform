/**
 * Leagues and tournaments created straight from Fixtures & Venues (ADR 0018). Pure: no
 * repo, no clock, no randomness other than the seed the caller passes.
 *
 * A competition is one or more series sharing a `competition` block:
 *   - league            → one series, a round robin over one or two legs;
 *   - knockout cup      → one series, a seeded bracket (`win:fN` / `lose:fN` slots);
 *   - groups → knockout → one series per group (`<id>-g1`, `-g2`, …, round robins) and a
 *                         knockout series (`<id>-ko`) whose first round is seeded from the
 *                         group tables (`pos:<groupSeriesId>:<rank>`), cross-group.
 *
 * Draws come from the engine's existing generators (circle method `roundRobinRounds`,
 * `knockoutRounds`, `crossPoolRounds`) — the same algorithms the season engine uses and the
 * union's fixtures_template.xlsm encodes. Dates are simple on purpose: round 1 on the start
 * date, then every `everyDays`, an excluded date pushing that round one interval later. Start
 * times cycle across a round's fixtures. "Randomise draw" is a seeded shuffle of the team
 * order, so a preview and the create that follows it produce the identical draw.
 */
import { crossPoolRounds, groupPositionOf, knockoutRounds, roundRobinRounds } from './formats.js';
import { fixturesFromDates, type GeneratedFixture, type Pairing } from './fixtures.js';
import type { TeamParticipant } from './leagues.js';
import { DEFAULT_CRICKET_POINTS, type PointsRules } from './standings.js';
import type { IsoDate, IsoTime, Series } from './types.js';

export type CompetitionType = 'league' | 'tournament';

export type CompetitionFormat =
  | { kind: 'round-robin'; legs: 1 | 2 }
  | { kind: 'knockout'; thirdPlace?: boolean }
  | {
      kind: 'groups-knockout';
      groups: number;
      /** Teams per group into the knockout: the winner, or the top two. */
      qualifiers: 1 | 2;
      legs: 1 | 2;
      thirdPlace?: boolean;
    };

export interface CompetitionSchedule {
  startDate: IsoDate;
  /** Days between rounds: 7 = weekly. */
  everyDays: number;
  /** Start times, cycled across a round's fixtures; empty ⇒ untimed. */
  times: IsoTime[];
  /** Dates no round may land on (a round there moves one interval later). */
  excludeDates?: IsoDate[];
}

export interface CompetitionSpec {
  id: string;
  type: CompetitionType;
  name: string;
  /** The league catalogue entry it belongs to, when there is one. */
  leagueKey?: string;
  overs: number;
  teams: TeamParticipant[];
  format: CompetitionFormat;
  schedule: CompetitionSchedule;
  points?: PointsRules;
  /** Randomise the draw: same seed ⇒ same draw. Absent ⇒ teams in the order given. */
  seed?: number;
}

/** Stored on every series of a competition (the competition is the set sharing `id`). */
export interface CompetitionMeta {
  id: string;
  type: CompetitionType;
  name: string;
  format: CompetitionFormat;
  schedule: CompetitionSchedule;
  points: PointsRules;
  seed?: number;
  /** What this series is within the competition. */
  role: 'league' | 'group' | 'knockout';
  /** "Group A" for a group series. */
  groupLabel?: string;
}

export type CompetitionSeries = Series & {
  competition: CompetitionMeta;
  leagueKey?: string;
  seriesType: string;
  maxOvers: number;
  kind: 'series';
};

export interface CompetitionPlan {
  ok: true;
  series: CompetitionSeries[];
  summary: { rounds: number; fixtures: number; firstDate: IsoDate; lastDate: IsoDate };
  warnings: string[];
}
export interface CompetitionRefusal {
  ok: false;
  problems: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = 86_400_000;
const addDays = (d: IsoDate, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const GROUP_LETTERS = 'ABCDEFGH';

/** mulberry32: a small, well-mixed seeded generator — enough for shuffling a draw. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates with the seeded generator. */
export function shuffleWithSeed<T>(items: T[], seed: number): T[] {
  const out = [...items];
  const rnd = seeded(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Everything wrong with a spec, in the office's words; empty ⇒ it can be generated. */
export function competitionProblems(spec: CompetitionSpec): string[] {
  const p: string[] = [];
  if (!spec.id || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(spec.id))
    p.push('The competition id is invalid.');
  if (!spec.name?.trim()) p.push('Give it a name.');
  else if (spec.name.trim().length > 80) p.push('The name is too long (80 characters at most).');
  if (spec.type !== 'league' && spec.type !== 'tournament') p.push('Pick league or tournament.');
  if (!Number.isInteger(spec.overs) || spec.overs < 1 || spec.overs > 200)
    p.push('Overs must be a whole number from 1 to 200.');
  const teams = spec.teams ?? [];
  const ids = teams.map((t) => t.teamId);
  if (teams.length < 2) p.push('Pick at least two teams.');
  if (new Set(ids).size !== ids.length) p.push('A team is in the list twice.');
  if (teams.some((t) => !t.teamId || !t.name)) p.push('Every team needs an id and a name.');
  const f = spec.format;
  if (!f || !['round-robin', 'knockout', 'groups-knockout'].includes(f.kind))
    p.push('Pick a format.');
  else if (f.kind === 'round-robin' || f.kind === 'groups-knockout') {
    if (f.legs !== 1 && f.legs !== 2) p.push('Play each other once or twice.');
  }
  if (f?.kind === 'groups-knockout') {
    if (!Number.isInteger(f.groups) || f.groups < 2 || f.groups > 8) p.push('Use 2 to 8 groups.');
    else if (teams.length < f.groups * 2)
      p.push(`${f.groups} groups need at least ${f.groups * 2} teams (two per group).`);
    if (f.qualifiers !== 1 && f.qualifiers !== 2)
      p.push('Take the winner or the top two from each group.');
    else if (Number.isInteger(f.groups) && teams.length < f.groups * (f.qualifiers + 1))
      p.push('Each group needs more teams than it sends through.');
  }
  const s = spec.schedule;
  if (!s || !DATE_RE.test(s.startDate ?? '') || !Number.isFinite(Date.parse(s.startDate)))
    p.push('Pick a start date.');
  if (!s || !Number.isInteger(s.everyDays) || s.everyDays < 1 || s.everyDays > 28)
    p.push('Rounds must be 1 to 28 days apart.');
  if (s && (!Array.isArray(s.times) || s.times.length > 4 || s.times.some((t) => !TIME_RE.test(t))))
    p.push('Start times must be HH:MM (up to four).');
  if (
    s?.excludeDates &&
    (!Array.isArray(s.excludeDates) || s.excludeDates.some((d) => !DATE_RE.test(d)))
  )
    p.push('Excluded dates must be YYYY-MM-DD.');
  const pts = spec.points;
  if (
    pts &&
    (['win', 'tie', 'noResult', 'loss'] as const).some(
      (k) => !Number.isInteger(pts[k]) || pts[k] < 0 || pts[k] > 20,
    )
  )
    p.push('Points must be whole numbers from 0 to 20.');
  if (spec.seed !== undefined && !Number.isInteger(spec.seed))
    p.push('The draw seed must be a whole number.');
  return p;
}

/** One date per round: start, then every interval; an excluded date pushes the round on. */
function roundDates(rounds: number, s: CompetitionSchedule, from: IsoDate): IsoDate[] {
  const skip = new Set(s.excludeDates ?? []);
  const out: IsoDate[] = [];
  let d = from;
  for (let r = 0; r < rounds; r++) {
    let guard = 0;
    while (skip.has(d) && guard++ < 100) d = addDays(d, s.everyDays);
    out.push(d);
    d = addDays(d, s.everyDays);
  }
  return out;
}

const slotsOf = (times: IsoTime[]) => times.map((t) => ({ label: '', start: t }));

/** Fixtures from pairings, with the competition's dates and times; ids f1… across the series. */
function dated(rounds: Pairing[][], s: CompetitionSchedule, from: IsoDate): GeneratedFixture[] {
  return fixturesFromDates(rounds, roundDates(rounds.length, s, from), slotsOf(s.times)).map(
    ({ slot: _slot, ...f }) => f,
  );
}

/** Split into groups by snake order (1-2-3-3-2-1…), keeping groups within one of each other. */
function snake<T>(items: T[], groups: number): T[][] {
  const out: T[][] = Array.from({ length: groups }, () => []);
  items.forEach((x, i) => {
    const lap = Math.floor(i / groups);
    const g = lap % 2 === 0 ? i % groups : groups - 1 - (i % groups);
    out[g].push(x);
  });
  return out;
}

export function planCompetition(spec: CompetitionSpec): CompetitionPlan | CompetitionRefusal {
  const problems = competitionProblems(spec);
  if (problems.length) return { ok: false, problems };
  const warnings: string[] = [];
  const points = spec.points ?? DEFAULT_CRICKET_POINTS;
  const order = spec.seed !== undefined ? shuffleWithSeed(spec.teams, spec.seed) : [...spec.teams];
  const name = spec.name.trim();
  const meta = (role: CompetitionMeta['role'], groupLabel?: string): CompetitionMeta => ({
    id: spec.id,
    type: spec.type,
    name,
    format: spec.format,
    schedule: spec.schedule,
    points,
    ...(spec.seed !== undefined ? { seed: spec.seed } : {}),
    role,
    ...(groupLabel ? { groupLabel } : {}),
  });
  const typeLabel = (role: CompetitionMeta['role']) =>
    role === 'knockout' ? 'Knockout' : role === 'group' ? 'Group stage' : 'League';
  const build = (
    id: string,
    seriesName: string,
    teams: TeamParticipant[],
    fixtures: GeneratedFixture[],
    m: CompetitionMeta,
  ): CompetitionSeries => ({
    id,
    name: seriesName,
    startDate: fixtures[0]?.date ?? spec.schedule.startDate,
    ...(fixtures.length ? { endDate: fixtures[fixtures.length - 1].date } : {}),
    teams: teams.map((t) => t.teamId),
    participants: teams.map((t) => ({ ...t })),
    fixtures: fixtures.map((f) => ({ ...f, status: 'scheduled' })),
    kind: 'series',
    seriesType: `${typeLabel(m.role)} · ${spec.overs} overs`,
    maxOvers: spec.overs,
    ...(spec.leagueKey ? { leagueKey: spec.leagueKey } : {}),
    competition: m,
    released: false,
    releasedAt: null,
    approved: false,
    approvedAt: null,
    version: 1,
  });

  const series: CompetitionSeries[] = [];
  const f = spec.format;
  if (f.kind === 'round-robin') {
    const rounds = roundRobinRounds(
      order.map((t) => t.teamId),
      f.legs,
    );
    series.push(
      build(
        spec.id,
        name,
        order,
        dated(rounds, spec.schedule, spec.schedule.startDate),
        meta('league'),
      ),
    );
  } else if (f.kind === 'knockout') {
    const rounds = knockoutRounds(
      order.map((t) => t.teamId),
      { thirdPlace: f.thirdPlace },
    );
    if (order.length > 2 && (order.length & (order.length - 1)) !== 0)
      warnings.push(
        `${order.length} teams don't fill a bracket: the lowest seeds play a preliminary round first.`,
      );
    series.push(
      build(
        spec.id,
        name,
        order,
        dated(rounds, spec.schedule, spec.schedule.startDate),
        meta('knockout'),
      ),
    );
  } else {
    const groups = snake(order, f.groups);
    let lastGroupDate = spec.schedule.startDate;
    groups.forEach((g, i) => {
      const label = `Group ${GROUP_LETTERS[i]}`;
      const rounds = roundRobinRounds(
        g.map((t) => t.teamId),
        f.legs,
      );
      const fixtures = dated(rounds, spec.schedule, spec.schedule.startDate);
      const last = fixtures[fixtures.length - 1]?.date;
      if (last && last > lastGroupDate) lastGroupDate = last;
      series.push(
        build(`${spec.id}-g${i + 1}`, `${name} · ${label}`, g, fixtures, meta('group', label)),
      );
    });
    const qualifiers = groups.map((_, i) =>
      Array.from({ length: f.qualifiers }, (_x, r) =>
        groupPositionOf(`${spec.id}-g${i + 1}`, r + 1),
      ),
    );
    let rounds = crossPoolRounds(qualifiers, { thirdPlace: f.thirdPlace });
    if (!rounds.length) {
      rounds = knockoutRounds(qualifiers.flat(), { thirdPlace: f.thirdPlace });
      warnings.push(
        'This many groups and qualifiers can’t be paired cross-group, so the knockout is seeded instead.',
      );
    }
    const koStart = addDays(lastGroupDate, spec.schedule.everyDays);
    series.push(
      build(
        `${spec.id}-ko`,
        `${name} · Knockout`,
        order,
        dated(rounds, spec.schedule, koStart),
        meta('knockout'),
      ),
    );
  }

  const all = series.flatMap((s) => s.fixtures as GeneratedFixture[]);
  const dates = [...new Set(all.map((x) => x.date))].sort();
  return {
    ok: true,
    series,
    summary: {
      // Playing dates: group rounds share dates, and the knockout follows on.
      rounds: dates.length,
      fixtures: all.length,
      firstDate: dates[0] ?? spec.schedule.startDate,
      lastDate: dates[dates.length - 1] ?? spec.schedule.startDate,
    },
    warnings,
  };
}

/* ─── Advancing a knockout from the group tables and its own results ─── */

export interface AdvanceFixture {
  id: string;
  home?: string;
  away?: string;
  status?: string;
  /** The placeholders a side held before it was filled (kept to show and to undo). */
  slots?: { home?: string; away?: string };
  result?: { winner?: 'home' | 'away' | 'tie' | 'none' | null } | null;
}

export interface AdvanceResult<F extends AdvanceFixture> {
  fixtures: F[];
  /** Sides filled by this call. */
  filled: number;
  /** Slots still waiting, with why ("Group A isn't finished", "Semi-final 1 has no winner"). */
  waiting: string[];
}

/**
 * Fill a knockout's slots: `pos:<group>:<rank>` from that group's final table (only once
 * every group game is played or cancelled, unless `allowIncomplete`), and `win:fN` /
 * `lose:fN` from the result of fixture N in the same knockout (a tie or no result waits —
 * the union decides those). Already-filled sides are left alone. Pure.
 */
export function advanceKnockout<F extends AdvanceFixture>(
  knockout: F[],
  groups: Map<string, { complete: boolean; order: string[] }>,
  opts: { allowIncomplete?: boolean } = {},
): AdvanceResult<F> {
  const waiting: string[] = [];
  let filled = 0;
  const byId = new Map(knockout.map((f) => [f.id, f]));
  const fixtures = knockout.map((f) => ({ ...f, slots: f.slots ? { ...f.slots } : undefined }));
  const resolve = (ref: string): string | null => {
    if (ref.startsWith('pos:')) {
      const m = /^pos:(.+):(\d+)$/.exec(ref);
      const g = m ? groups.get(m[1]) : undefined;
      if (!m || !g) return (waiting.push(`${ref}: unknown group`), null);
      if (!g.complete && !opts.allowIncomplete)
        return (waiting.push(`${m[1]} isn't finished`), null);
      return g.order[Number(m[2]) - 1] ?? (waiting.push(`${m[1]} has no team ${m[2]}`), null);
    }
    const m = /^(win|lose):(.+)$/.exec(ref);
    if (!m) return null;
    const src = byId.get(m[2]);
    const w = src?.result?.winner;
    if (!src || (w !== 'home' && w !== 'away'))
      return (waiting.push(`${m[2]} has no winner yet`), null);
    const winner = w === 'home' ? src.home : src.away;
    const loser = w === 'home' ? src.away : src.home;
    const team = m[1] === 'win' ? winner : loser;
    return team && !/^(pos|win|lose):/.test(team)
      ? team
      : (waiting.push(`${m[2]} isn't decided`), null);
  };
  // One pass: a slot is filled only from a result that is already in, so a semi filled
  // here can't feed the final until its own result arrives — each call advances the
  // bracket as far as the results allow.
  for (const f of fixtures) {
    for (const side of ['home', 'away'] as const) {
      const v = f[side];
      if (!v || !/^(pos|win|lose):/.test(v)) continue;
      const team = resolve(v);
      if (!team) continue;
      f.slots = { ...(f.slots ?? {}), [side]: v };
      f[side] = team;
      filled++;
    }
  }
  return { fixtures: fixtures as F[], filled, waiting: [...new Set(waiting)] };
}

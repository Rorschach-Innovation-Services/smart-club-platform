/**
 * One-off (dolphins, 21 Nov 2026 play-offs): add the two Veterans Promotion T20 semi-finals to
 * the recipe knockout series `s-mc-ko-veterans-promotion-t20` and re-point its final at the
 * semi winners. DRY-RUN by default; `--confirm` writes. Run from packages/api:
 *
 *   npx sst shell --stage prod -- npx tsx src/vets-promotion-t20-semis.ts --tenant dolphins \
 *     --overrule-series EMCU            # dry run
 *   … append --confirm to write
 *
 * Why: the union's reminder sheet for Sat 21 Nov 2026 changed the format from a single final
 * (G1 1st v G2 2nd) to crossed semis at Toti (G1 1st v G2 2nd on Toti 1, G2 1st v G1 2nd on
 * Toti 2, both 09:00) and a final between the semi winners (Toti 2, 13:00). The tenant recipe
 * is updated in the same change (medicoach-recipes/dolphins.ts).
 *
 * Writes (one conditional `repo.updateSeries` on the read version):
 *   - f2 "Semi-final 1" / f3 "Semi-final 2" with the recipe syncRefs `…:t20:sf1` / `…:t20:sf2`
 *     (the ids medicoach holds — a SEPARATE medicoach script, run first, creates them there);
 *   - f1 Final: sides `win:f2` / `win:f3`, `slots` DELETED (the puller fills from
 *     `slots[side] ?? side` and never clears, so the stale `pos:` slots must go), `dateTbc`
 *     dropped, real date/time/venue, round 2; syncRef + stage kept;
 *   - venue fields shaped like the group-stage fixtures (registry id/name/coords, locked,
 *     neutral, a reason line); startDate/endDate (→ gsi1sk) = 21 Nov; maxFixtureIdEver = 3;
 *   - progressive release (ADR 0011): any withheld key is removed and `revealedAt[key]` is
 *     stamped exactly as the PATCH `reveal` action does; `revealedAt.venue` is stamped even
 *     when nothing was withheld, so the club portal shows "venues confirmed …" like the group
 *     series.
 *
 * Deliberately NOT done:
 *   - no medicoach outbox rows (no `recordScheduleDiff`, no `requeueRevealedSeries`): creates
 *     for a recipe knockout series are refused by design, and medicoach already holds the same
 *     fixtures/values from the medicoach-side script. An upsert for f1 would only echo them
 *     back, and not stamping `schedule.changedAt` keeps medicoach the newer side for any later
 *     correction made there;
 *   - no audit-trail rows: ADR 0023 keeps command-line scripts out of scope. The local backup
 *     JSON (stored series + every overruled clash pair key) is the record;
 *   - the clashing EMCU fixture is not touched.
 *
 * Clash rule: the season-wide `findClashes` runs on the would-be state of every tenant series;
 * a clash not present before (same `clashKey` subset rule as the in-season gate) refuses the
 * write. `--overrule-series <substring>` (precedent: shift-fixture-dates, 7 Nov 2026) accepts
 * ONLY an introduced clash between THIS series and a series whose name contains the substring
 * (case-insensitive); anything else still refuses. Team double-booking (same team, same date
 * and slot, released series) is checked with `findTeamBusy` and always refuses.
 *
 * Idempotent: an already-applied series is reported as a no-op. Any other unexpected shape
 * (extra fixtures, a burned f2/f3 id, a stored result, other placeholders) refuses.
 */
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { groupPositionOf, isSlotRef, winnerOf } from '../../engine/src/formats.js';
import { refs } from './medicoach-bundle.js';
import { findTeamBusy } from './team-busy.js';
import {
  clashKey,
  clashPairKey,
  findClashes,
  formatClashForHumans,
  type Clash,
} from './venue-clash.js';
import type { Club, Series, StoredFixtureResult, Venue } from './types.js';

// `./repo.js` (AWS SDK) is imported dynamically in `main()` so the pure planner and its test
// load without it.

export const TENANT = 'dolphins';
export const SERIES_ID = 's-mc-ko-veterans-promotion-t20';
export const LEAGUE_KEY = 'veterans-promotion';
const STREAM = 't20';
const GROUP_1 = 's-planb-veterans-promotion-t20-1';
const GROUP_2 = 's-planb-veterans-promotion-t20-2';

export const TEAMS = {
  chatsworthB: 'tm_hollywoodbets-chatsworth-sporting_veterans-promotion_1',
  saintsB: 'tm_saints-cricket-club_veterans-promotion_1',
  tongaat: 'tongaat-cricket-association',
  hillaryMalvern: 'hillary-malvern-cricket-club',
} as const;

export const PLAY_DATE = '2026-11-21';
export const VENUE_REASON = 'Union reminder fixtures 21 & 22 Nov 2026 — exact venue';
const syncRefOf = (slotId: string) => refs.recipeFixture(TENANT, LEAGUE_KEY, STREAM, slotId);

interface TargetFixture {
  id: string;
  slotId: string;
  round: number;
  stage: string;
  home: string;
  away: string;
  time: string;
  venueId: string;
}

/** The three fixtures as the union's reminder sheet sets them. */
export const TARGET: readonly TargetFixture[] = [
  {
    id: 'f1',
    slotId: 'final',
    round: 2,
    stage: 'Final',
    home: winnerOf('f2'),
    away: winnerOf('f3'),
    time: '13:00',
    venueId: 'v-toti-2',
  },
  {
    id: 'f2',
    slotId: 'sf1',
    round: 1,
    stage: 'Semi-final 1',
    home: TEAMS.chatsworthB,
    away: TEAMS.saintsB,
    time: '09:00',
    venueId: 'v-toti-1',
  },
  {
    id: 'f3',
    slotId: 'sf2',
    round: 1,
    stage: 'Semi-final 2',
    home: TEAMS.tongaat,
    away: TEAMS.hillaryMalvern,
    time: '09:00',
    venueId: 'v-toti-2',
  },
];

/** The final's stored placeholders before this change (recipe: G1 1st v G2 2nd). */
const OLD_FINAL_SLOTS = { home: groupPositionOf(GROUP_1, 1), away: groupPositionOf(GROUP_2, 2) };

type Fixture = Record<string, unknown> & {
  id?: string;
  round?: number;
  stage?: string;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  status?: string;
  syncRef?: string;
  venueId?: string;
  slots?: { home?: string; away?: string };
  slotsManual?: { home?: boolean; away?: boolean };
};

/** A fixture side's placeholder as the puller reads it: `slots[side] ?? side`. */
const placeholderOf = (f: Fixture, side: 'home' | 'away') => f.slots?.[side] ?? f[side];

export interface TaggedClash {
  clash: Clash;
  subjectSeriesId: string;
  subjectSeriesName: string;
  /** `clashPairKey` — the unordered pair-on-ground identity the amendments override acks. */
  pairKey: string;
  verdict: 'overruled' | 'blocking';
}

export interface TeamBusyFinding {
  fixtureId: string;
  side: 'home' | 'away';
  teamId: string;
  with: { seriesId: string; seriesName?: string; fixtureId: string; date: string; time?: string };
}

export interface SemisPlan {
  /** `refuse`: the stored state is not the one this script was written for. */
  status: 'apply' | 'noop' | 'refuse';
  reasons: string[];
  /** The fields `repo.updateSeries` writes (without `version`). Only for `apply`. */
  patch?: Pick<
    Series,
    'fixtures' | 'startDate' | 'endDate' | 'maxFixtureIdEver' | 'withheld' | 'revealedAt'
  >;
  /** Withheld keys this write reveals (empty when nothing was withheld). */
  revealed: Array<'venue' | 'time'>;
  introduced: TaggedClash[];
  preExisting: Clash[];
  teamBusy: TeamBusyFinding[];
  /** True when the write may go ahead (apply, nothing blocking). */
  writable: boolean;
}

export interface PlanInput {
  series: Series | null | undefined;
  allSeries: Series[];
  clubs: Club[];
  venues: Venue[];
  aliases?: Record<string, string>;
  /** Stored medicoach results for f1/f2/f3 (null/absent = none). */
  results: Partial<Record<string, StoredFixtureResult | null>>;
  overruleSeries?: string;
  /** ISO instant stamped into `revealedAt`. */
  now: string;
}

function venueFields(v: Venue): Record<string, unknown> {
  return {
    venueId: v.id,
    venueName: v.name,
    ...(typeof v.lat === 'number' ? { venueLat: v.lat } : {}),
    ...(typeof v.lon === 'number' ? { venueLon: v.lon } : {}),
    venueLocked: true,
    venueReason: VENUE_REASON,
    venueStatus: 'neutral',
  };
}

/** True when `f` already carries `t` (sides read as the puller reads placeholders for f1). */
function matchesTarget(f: Fixture | undefined, t: TargetFixture): boolean {
  if (!f) return false;
  const sidesOk =
    t.id === 'f1'
      ? placeholderOf(f, 'home') === t.home && placeholderOf(f, 'away') === t.away
      : f.home === t.home && f.away === t.away;
  return (
    sidesOk &&
    f.syncRef === syncRefOf(t.slotId) &&
    f.date === PLAY_DATE &&
    f.time === t.time &&
    f.venueId === t.venueId &&
    f.round === t.round &&
    f.stage === t.stage &&
    f.dateTbc !== true
  );
}

function isApplied(series: Series): boolean {
  const fx = (series.fixtures ?? []) as Fixture[];
  if (fx.length !== TARGET.length) return false;
  const byId = new Map(fx.map((f) => [f.id, f]));
  return (
    TARGET.every((t) => matchesTarget(byId.get(t.id), t)) &&
    !series.withheld?.venue &&
    !series.withheld?.time &&
    !!series.revealedAt?.venue &&
    series.startDate === PLAY_DATE &&
    series.endDate === PLAY_DATE
  );
}

/** Every reason the stored series is not the pre-change state this script expects. */
function preStateProblems(
  series: Series,
  results: PlanInput['results'],
  venues: Venue[],
): string[] {
  const out: string[] = [];
  if (series.kind !== undefined && series.kind !== 'series')
    out.push(`kind is "${String(series.kind)}", expected "series"`);
  if (series.leagueKey !== LEAGUE_KEY)
    out.push(`leagueKey is "${String(series.leagueKey)}", expected "${LEAGUE_KEY}"`);
  if (series.released !== true) out.push('series is not released');
  if (typeof series.version !== 'number') out.push('series has no numeric version');
  const hw = series.maxFixtureIdEver;
  if (typeof hw === 'number' && hw > 1)
    out.push(`maxFixtureIdEver is ${hw}: f2/f3 were used before — refusing to reuse those ids`);
  const teams = new Set(series.teams ?? []);
  for (const id of Object.values(TEAMS))
    if (!teams.has(id)) out.push(`team ${id} is not in the series' teams`);

  const fx = (series.fixtures ?? []) as Fixture[];
  const ids = fx.map((f) => f.id ?? '(no id)');
  if (fx.length !== 1 || ids[0] !== 'f1')
    out.push(`expected exactly one fixture f1, found [${ids.join(', ')}]`);
  const f1 = fx.find((f) => f.id === 'f1');
  if (f1) {
    if (f1.stage !== 'Final') out.push(`f1 stage is "${String(f1.stage)}", expected "Final"`);
    if (f1.syncRef !== syncRefOf('final'))
      out.push(`f1 syncRef is "${String(f1.syncRef)}", expected "${syncRefOf('final')}"`);
    for (const side of ['home', 'away'] as const) {
      const ph = placeholderOf(f1, side);
      if (ph !== OLD_FINAL_SLOTS[side])
        out.push(`f1 ${side} placeholder is "${String(ph)}", expected "${OLD_FINAL_SLOTS[side]}"`);
    }
    if (f1.slotsManual) out.push('f1 has a manual slot fill (slotsManual)');
    if (f1.status !== undefined && f1.status !== 'scheduled')
      out.push(`f1 status is "${String(f1.status)}"`);
  }
  for (const id of ['f1', 'f2', 'f3']) {
    const r = results[id];
    if (r && !r.cleared)
      out.push(`a stored result exists for ${id} (${r.summary ?? r.winner ?? 'result'})`);
  }
  for (const t of TARGET)
    if (!venues.some((v) => v.id === t.venueId))
      out.push(`venue ${t.venueId} is not in the tenant's venue registry`);
  return out;
}

/** The series as it will be stored: f1 re-pointed, f2/f3 added, release fields revealed. */
function buildNext(
  series: Series,
  venues: Venue[],
  now: string,
): { patch: NonNullable<SemisPlan['patch']>; revealed: Array<'venue' | 'time'> } {
  const venueById = new Map(venues.map((v) => [v.id, v]));
  const storedF1 = (series.fixtures as Fixture[]).find((f) => f.id === 'f1')!;
  const fixtures = TARGET.map((t) => {
    const base: Fixture =
      t.id === 'f1'
        ? (() => {
            // Keep any other stored key (e.g. a schedule stamp); drop what must not survive.
            const {
              slots: _slots,
              slotsManual: _slotsManual,
              dateTbc: _dateTbc,
              venueOverride: _venueOverride,
              slot: _slot,
              ...rest
            } = storedF1;
            return rest;
          })()
        : {};
    return {
      ...base,
      id: t.id,
      round: t.round,
      stage: t.stage,
      date: PLAY_DATE,
      time: t.time,
      home: t.home,
      away: t.away,
      ...venueFields(venueById.get(t.venueId)!),
      syncRef: syncRefOf(t.slotId),
    };
  });

  const withheld = { ...(series.withheld ?? {}) };
  const revealedAt = { ...(series.revealedAt ?? {}) };
  const revealed: Array<'venue' | 'time'> = [];
  for (const k of ['venue', 'time'] as const) {
    if (withheld[k]) {
      delete withheld[k];
      revealedAt[k] = now;
      revealed.push(k);
    }
  }
  revealedAt.venue ??= now;
  return {
    patch: {
      fixtures,
      startDate: PLAY_DATE,
      endDate: PLAY_DATE,
      maxFixtureIdEver: 3,
      withheld: Object.keys(withheld).length ? withheld : undefined,
      revealedAt,
    },
    revealed,
  };
}

/** True when `substring` (case-insensitive) is in `name`. Empty substring never matches. */
const nameMatches = (name: string | undefined, substring: string) =>
  !!substring &&
  String(name ?? '')
    .toLowerCase()
    .includes(substring.toLowerCase());

/**
 * Introduced clashes on the would-be calendar (the in-season gate's subset rule over the whole
 * tenant), each classified. Overruled ONLY when the double-booking is between THIS series and
 * a series named with the overrule substring — seen from either side.
 */
export function classifyClashes(
  all: Series[],
  next: Series,
  clubs: Club[],
  venues: Venue[],
  aliases: Record<string, string> | undefined,
  overruleSeries: string | undefined,
): { introduced: TaggedClash[]; preExisting: Clash[] } {
  const key = (c: Clash) => clashKey(c, aliases);
  const before = new Set<string>();
  for (const s of all)
    for (const c of findClashes(s, all, clubs, venues, aliases)) before.add(key(c));
  const modified = all.map((s) => (String(s.id) === String(next.id) ? next : s));
  // `clashKey` is directional (each double-booking is found once from each side); the report
  // lists each one once, by its unordered pair key.
  const seen = new Set<string>();
  const introduced: TaggedClash[] = [];
  const preExisting: Clash[] = [];
  for (const s of modified) {
    for (const c of findClashes(s, modified, clubs, venues, aliases)) {
      const subjectSeriesId = String(s.id);
      const subjectSeriesName = String(s.name ?? '');
      const pairKey = clashPairKey({ ...c, subjectSeriesId }, aliases);
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      if (before.has(key(c))) {
        preExisting.push(c);
        continue;
      }
      const sub = overruleSeries ?? '';
      const overruled =
        (subjectSeriesId === SERIES_ID && nameMatches(c.with.seriesName, sub)) ||
        (c.with.seriesId === SERIES_ID && nameMatches(subjectSeriesName, sub));
      introduced.push({
        clash: c,
        subjectSeriesId,
        subjectSeriesName,
        pairKey,
        verdict: overruled ? 'overruled' : 'blocking',
      });
    }
  }
  return { introduced, preExisting };
}

/** Same-team double-bookings the new semis would carry (released series, same day + slot). */
function teamBusyFindings(all: Series[], next: Series): TeamBusyFinding[] {
  const modified = all.map((s) => (String(s.id) === String(next.id) ? next : s));
  const released = modified.filter((s) => s.released === true);
  const nameOf = new Map(all.map((s) => [String(s.id), s.name as string | undefined]));
  const out: TeamBusyFinding[] = [];
  for (const f of next.fixtures as Fixture[]) {
    if (!f.id || !f.date) continue;
    const busy = findTeamBusy(
      released,
      { seriesId: SERIES_ID, fixtureId: f.id, home: f.home, away: f.away },
      f.date,
      f.time,
    );
    for (const side of ['home', 'away'] as const) {
      const hit = busy[side];
      if (!hit) continue;
      out.push({
        fixtureId: f.id,
        side,
        teamId: hit.teamId,
        with: {
          seriesId: hit.seriesId,
          seriesName: nameOf.get(hit.seriesId),
          fixtureId: hit.fixtureId,
          date: hit.date,
          time: hit.time,
        },
      });
    }
  }
  return out;
}

/** Pure planner: what the write would be, every clash and how it is treated. No I/O. */
export function planVetsSemis(input: PlanInput): SemisPlan {
  const empty = {
    revealed: [],
    introduced: [],
    preExisting: [],
    teamBusy: [],
    writable: false,
  };
  const { series } = input;
  if (!series) return { status: 'refuse', reasons: [`series ${SERIES_ID} not found`], ...empty };
  if (isApplied(series))
    return { status: 'noop', reasons: ['already applied — nothing to do'], ...empty };
  const problems = preStateProblems(series, input.results, input.venues);
  if (problems.length) return { status: 'refuse', reasons: problems, ...empty };

  const { patch, revealed } = buildNext(series, input.venues, input.now);
  const next = { ...series, ...patch } as Series;
  const { introduced, preExisting } = classifyClashes(
    input.allSeries,
    next,
    input.clubs,
    input.venues,
    input.aliases,
    input.overruleSeries,
  );
  const teamBusy = teamBusyFindings(input.allSeries, next);
  const blocking = introduced.filter((t) => t.verdict === 'blocking');
  const reasons: string[] = [];
  if (blocking.length) reasons.push(`${blocking.length} introduced clash(es) not overruled`);
  if (teamBusy.length) reasons.push(`${teamBusy.length} team double-booking(s)`);
  return {
    status: 'apply',
    reasons,
    patch,
    revealed,
    introduced,
    preExisting,
    teamBusy,
    writable: !blocking.length && !teamBusy.length,
  };
}

// ─────────────────────────────── CLI ───────────────────────────────

interface Args {
  tenant: string;
  confirm: boolean;
  overruleSeries?: string;
}

const USAGE =
  'usage: vets-promotion-t20-semis --tenant dolphins [--overrule-series <substring>] [--confirm]';

export function parseArgs(argv: string[]): Args {
  const args: Args = { tenant: '', confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') args.tenant = argv[++i] ?? '';
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--overrule-series') {
      const v = (argv[++i] ?? '').trim();
      if (!v) throw new Error(`--overrule-series needs a substring\n${USAGE}`);
      args.overruleSeries = v;
    } else throw new Error(`unknown flag ${a}\n${USAGE}`);
  }
  if (args.tenant !== TENANT) throw new Error(`--tenant must be "${TENANT}"\n${USAGE}`);
  return args;
}

function describeFixture(f: Fixture, series: Series): string {
  const name = (ref?: string) =>
    ref && !isSlotRef(ref)
      ? (series.participants?.find((p) => p.teamId === ref)?.name ?? ref)
      : String(ref);
  return (
    `${f.id}  R${f.round}  ${f.stage}  ${name(f.home)} v ${name(f.away)}  ` +
    `${f.date} ${f.time ?? '(no time)'}  ${String(f.venueName ?? '(no venue)')}  ${f.syncRef}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = await import('./repo.js');
  const { venueAliasesFor } = await import('./venue-clash.js');
  const [allSeries, clubs, venues, config, ...results] = await Promise.all([
    repo.listSeries(args.tenant),
    repo.listClubs(args.tenant),
    repo.listVenues(args.tenant),
    repo.getTenantConfig(args.tenant),
    ...['f1', 'f2', 'f3'].map((id) => repo.getFixtureResult(args.tenant, SERIES_ID, id)),
  ]);
  const series = allSeries.find((s) => String(s.id) === SERIES_ID);
  const plan = planVetsSemis({
    series,
    allSeries,
    clubs,
    venues,
    aliases: venueAliasesFor(config),
    results: { f1: results[0], f2: results[1], f3: results[2] },
    overruleSeries: args.overruleSeries,
    now: new Date().toISOString(),
  });

  console.log(
    `vets-promotion-t20-semis (${args.tenant}) — ${args.confirm ? 'CONFIRM (write)' : 'DRY-RUN'}` +
      (args.overruleSeries ? ` — overrule series matching "${args.overruleSeries}"` : '') +
      '\n',
  );
  if (plan.status === 'noop') {
    console.log(`${SERIES_ID}: already applied (version ${series?.version}). Nothing to do.`);
    return;
  }
  if (plan.status === 'refuse') {
    console.log(`REFUSING — ${SERIES_ID} is not in the expected state:`);
    for (const r of plan.reasons) console.log(`   - ${r}`);
    process.exitCode = 1;
    return;
  }

  const s = series!;
  console.log(`── ${SERIES_ID}  (${s.name}) — stored version ${s.version}`);
  console.log('   before:');
  for (const f of s.fixtures as Fixture[]) console.log(`     ${describeFixture(f, s)}`);
  console.log('   after:');
  const next = { ...s, ...plan.patch } as Series;
  for (const f of next.fixtures as Fixture[]) console.log(`     ${describeFixture(f, next)}`);
  console.log(
    `   startDate/endDate ${s.startDate}/${s.endDate} → ${PLAY_DATE}; maxFixtureIdEver ` +
      `${s.maxFixtureIdEver ?? '(unset)'} → 3; withheld ${JSON.stringify(s.withheld ?? null)} → ` +
      `${JSON.stringify(plan.patch!.withheld ?? null)}; revealedAt → ${JSON.stringify(plan.patch!.revealedAt)}`,
  );
  console.log(
    plan.revealed.length
      ? `   reveals withheld: ${plan.revealed.join(', ')}`
      : '   nothing was withheld; revealedAt.venue stamped for the club portal line',
  );

  console.log(
    `\nClash check on the resulting calendar: ${plan.introduced.length} introduced, ` +
      `${plan.preExisting.length} pre-existing (not caused by this change).`,
  );
  for (const t of plan.introduced)
    console.log(
      `   ${t.verdict === 'overruled' ? 'OVERRULED' : 'BLOCKING '}  ${formatClashForHumans(t.clash)}` +
        `  [pair ${t.pairKey}]`,
    );
  for (const c of plan.preExisting) console.log(`   pre-existing  ${formatClashForHumans(c)}`);
  const overruled = plan.introduced.filter((t) => t.verdict === 'overruled');
  const strayOverrules = overruled.filter(
    (t) =>
      !(
        (t.subjectSeriesId === SERIES_ID && t.clash.fixtureId === 'f1') ||
        (t.clash.with.seriesId === SERIES_ID && t.clash.with.fixtureId === 'f1')
      ),
  );
  if (strayOverrules.length)
    console.log(
      `   ⚠ ${strayOverrules.length} overruled clash(es) involve a SEMI, not the final — ` +
        'the union decision covered the final only. Check before --confirm.',
    );
  console.log(`\nTeam double-booking (released series): ${plan.teamBusy.length} found.`);
  for (const b of plan.teamBusy)
    console.log(
      `   BLOCKING  ${b.fixtureId} ${b.side} ${b.teamId} already plays ${b.with.seriesName ?? b.with.seriesId}/` +
        `${b.with.fixtureId} on ${b.with.date}${b.with.time ? ' ' + b.with.time : ''}`,
    );

  if (!plan.writable) {
    console.log(`\nRefusing to write: ${plan.reasons.join('; ')}.`);
    process.exitCode = 1;
    return;
  }
  if (!args.confirm) {
    console.log('\n[dry-run] nothing written. Re-run with --confirm to apply.');
    return;
  }

  const path = `./vets-promotion-t20-semis-${args.tenant}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(
    path,
    JSON.stringify(
      {
        series: s,
        overruledClashes: overruled.map((t) => ({
          pairKey: t.pairKey,
          line: formatClashForHumans(t.clash),
          overruleSeries: args.overruleSeries,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nBackup written: ${path}`);
  try {
    await repo.updateSeries(args.tenant, SERIES_ID, { ...plan.patch, version: s.version });
  } catch (err) {
    if (err instanceof repo.VersionConflictError) {
      console.log('Series changed since it was read (version conflict) — nothing written. Re-run.');
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const after = await repo.getSeries(args.tenant, SERIES_ID);
  const verify = planVetsSemis({
    series: after,
    allSeries: [],
    clubs: [],
    venues,
    results: {},
    now: new Date().toISOString(),
  });
  console.log(
    `updated ${SERIES_ID} → version ${after?.version}; re-read ${verify.status === 'noop' ? 'confirms the change' : 'DOES NOT match — investigate'}.`,
  );
  if (verify.status !== 'noop') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}

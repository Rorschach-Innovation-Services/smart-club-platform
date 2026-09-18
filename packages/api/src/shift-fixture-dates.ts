/**
 * Bulk-shift fixture dates for one or more series, with domino cascade — DRY-RUN by
 * default (dolphins tenant, item 4 of the 17 Sep 2026 batch):
 *
 *   npx sst shell --stage prod -- npm --prefix packages/api run shift-fixture-dates -- \
 *     --tenant dolphins \
 *     --series s-planb-premier-men-50ov-top6,s-planb-premier-men-50ov-bottom6,s-planb-veterans-promotion-30ov \
 *     --from-date 2026-12-12,2026-12-13 --to-date 2027-01-16,2027-01-17
 *   … append --confirm to write (see the ON-HOLD note below — DO NOT for the dolphins case)
 *
 * Why this exists: the KZNCU client asked to move the 12/13 Dec fixtures to 16/17 Jan.
 * The admin fixture editor moves one fixture at a time and 16/17 Jan is already used, so a
 * later-round cascade is needed. This tool computes the whole calendar so the union can see
 * the result before deciding. It NEVER runs against AWS on its own — a human runs the sst
 * shell — and the dolphins move is ON HOLD, so run it WITHOUT `--confirm` only.
 *
 * From/to dates pair positionally (a weekend maps Sat→Sat, Sun→Sun). Within one series only
 * the from-date that side actually plays matches; that round's fixtures move to the paired
 * to-date. `time`, venue fields and fixture ids are preserved.
 *
 * Cascade after the move:
 *   slot  (default) — while the moved date lands on an existing later playing date, that
 *                     later round shifts to the NEXT existing playing date in the series
 *                     (gaps in the calendar are preserved); the last displaced round gets
 *                     (old last date + 7 days).
 *   weeks           — every fixture dated ≥ the earliest to-date (and not itself moved)
 *                     shifts +7 days (the whole tail slides a week, keeping its gaps).
 *   none            — only the targeted fixtures move; a resulting same-day collision is
 *                     left as-is.
 *
 * Before any write it runs the season-wide `findClashes` on the WOULD-BE state of every
 * tenant series and prints them. If the change INTRODUCES a clash (a pair-on-ground not
 * present before, by the same clashKey subset rule the in-season gate uses) it refuses to
 * write even with `--confirm`. On write it backs up the touched series to JSON first, then
 * `repo.updateSeries` with the read `version` (OCC).
 */
import { writeFile } from 'node:fs/promises';
import { findClashes, clashKey, formatClashForHumans } from './venue-clash.js';
import type { Club, Series, Venue } from './types.js';

// `./repo.js` (and its AWS SDK deps) is imported dynamically inside `main()` so that the
// pure core (planDateShift/computeShift) and its unit test load without the SDK present.

export type CascadeMode = 'slot' | 'weeks' | 'none';

export interface ShiftOpts {
  /** Dates whose fixtures move (ISO YYYY-MM-DD). */
  fromDates: string[];
  /** Paired target dates. Same length as `fromDates` (positional), or a single date whose
   * day-offset from the first from-date is applied to all from-dates. */
  toDates: string[];
  cascade: CascadeMode;
}

export interface FixtureMove {
  fixtureId: string;
  round?: number;
  from?: string;
  to: string;
}

export interface RoundChange {
  round?: number;
  oldDate?: string;
  newDate: string;
}

export interface ShiftPlan {
  moves: FixtureMove[];
  byRound: RoundChange[];
  /** Non-fatal notices — e.g. a round that is scheduled across more than one playing date. */
  warnings: string[];
}

interface StoredFixtureLike {
  id?: string;
  round?: number;
  date?: string;
  time?: string;
  [key: string]: unknown;
}

const DAY_MS = 86_400_000;

function parseISO(d: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new Error(`expected an ISO date YYYY-MM-DD, got "${d}"`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fmtISO(ms: number): string {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const da = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

function addDays(d: string, n: number): string {
  return fmtISO(parseISO(d) + n * DAY_MS);
}

/** Map each from-date to its target. Equal-length lists pair positionally; a single
 * to-date applies its day-offset (to − first-from) to every from-date. */
export function buildPairMap(fromDates: string[], toDates: string[]): Map<string, string> {
  const pm = new Map<string, string>();
  if (!fromDates.length) throw new Error('at least one --from-date is required');
  if (!toDates.length) throw new Error('at least one --to-date is required');
  fromDates.forEach((d) => parseISO(d));
  toDates.forEach((d) => parseISO(d));
  if (toDates.length === fromDates.length) {
    fromDates.forEach((f, i) => pm.set(f, toDates[i]));
  } else if (toDates.length === 1) {
    const offset = (parseISO(toDates[0]) - parseISO(fromDates[0])) / DAY_MS;
    fromDates.forEach((f) => pm.set(f, addDays(f, offset)));
  } else {
    throw new Error(
      `--to-date count (${toDates.length}) must equal --from-date count (${fromDates.length}) or be a single date`,
    );
  }
  return pm;
}

interface ComputedShift extends ShiftPlan {
  /** The series with shifted fixture dates applied. */
  next: Series;
}

/** Core, pure. Given a series and the shift options, work out the new date for every
 * affected fixture without mutating the input. The cascade is keyed by DISTINCT PLAYING
 * DATE (each date is its own slot), so a round scheduled across more than one date has each
 * of its dates cascaded independently — that case is also surfaced as a warning. */
export function computeShift(series: Series, opts: ShiftOpts): ComputedShift {
  const pm = buildPairMap(opts.fromDates, opts.toDates);
  const fromSet = new Set(opts.fromDates);
  const fixtures = ((series.fixtures ?? []) as StoredFixtureLike[]) ?? [];

  // A round SHOULD play on a single date; when it spans more than one we can't collapse it to a
  // single slot, so we WARN and let the date-keyed cascade below treat each date as its own slot.
  const warnings: string[] = [];
  const datesByRound = new Map<number, Set<string>>();
  for (const f of fixtures) {
    if (f.round == null || !f.date) continue;
    let set = datesByRound.get(f.round);
    if (!set) datesByRound.set(f.round, (set = new Set()));
    set.add(f.date);
  }
  for (const [r, set] of [...datesByRound.entries()].sort((a, b) => a[0] - b[0])) {
    if (set.size > 1)
      warnings.push(
        `round ${r} spans ${set.size} playing dates (${[...set].sort().join(', ')}) — ` +
          'each is treated as its own cascade slot',
      );
  }

  // The series' distinct playing dates (sorted) and the last one — the cascade run-off anchor.
  const allDates = [...new Set(fixtures.map((f) => f.date).filter(Boolean) as string[])].sort();
  const lastDate = allDates.length ? allDates[allDates.length - 1] : undefined;

  // Moved targets (each from-date's fixtures move to its paired to-date) and the non-moved
  // distinct playing dates — the slots the cascade may push.
  const movedTargets = opts.fromDates.filter((d) => allDates.includes(d));
  const targets = movedTargets.map((d) => pm.get(d)!);
  const nonMovedDates = allDates.filter((d) => !fromSet.has(d));

  // Cascade decisions keyed by each non-moved slot's pre-move DATE.
  const dateNewDate = new Map<string, string>();
  if (opts.cascade === 'weeks') {
    const earliestTo = [...targets].sort()[0];
    if (earliestTo) {
      for (const d of nonMovedDates) if (d >= earliestTo) dateNewDate.set(d, addDays(d, 7));
    }
  } else if (opts.cascade === 'slot') {
    const nonMovedSet = new Set(nonMovedDates);
    // A cascade triggers only where a moved date lands exactly on an existing later date.
    const collisions = targets.filter((d) => nonMovedSet.has(d)).sort();
    const trigger = collisions[0];
    if (trigger && lastDate) {
      const pushed = nonMovedDates.filter((d) => d >= trigger).sort();
      pushed.forEach((d, i) => {
        // Each pushed slot takes the NEXT existing playing date; the last runs off the end and
        // gets old-last + 7 days.
        dateNewDate.set(d, i < pushed.length - 1 ? pushed[i + 1] : addDays(lastDate, 7));
      });
    }
  }

  // Apply per fixture BY DATE: a from-date fixture takes its paired target; otherwise a
  // non-moved date with a cascade decision takes that; everything else is untouched.
  // Keyed on date, not round, so a fixture with a date but no `round` (a hand-added
  // one-off) still moves with the playing day it sits on.
  const moves: FixtureMove[] = [];
  const nextFixtures = fixtures.map((f) => {
    let nd = f.date;
    if (f.date && fromSet.has(f.date)) nd = pm.get(f.date)!;
    else if (f.date && dateNewDate.has(f.date)) nd = dateNewDate.get(f.date)!;
    if (nd && nd !== f.date) {
      moves.push({ fixtureId: f.id ?? '', round: f.round, from: f.date, to: nd });
      return { ...f, date: nd };
    }
    return f;
  });

  // One RoundChange per (round, old date), so a multi-date round surfaces each slot's move.
  const byRound: RoundChange[] = [];
  const seen = new Set<string>();
  for (const m of moves) {
    const key = `${m.round ?? '?'}|${m.from ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    byRound.push({ round: m.round, oldDate: m.from, newDate: m.to });
  }
  byRound.sort(
    (a, b) => (a.round ?? 0) - (b.round ?? 0) || (a.oldDate ?? '').localeCompare(b.oldDate ?? ''),
  );

  const next: Series = { ...series, fixtures: nextFixtures };
  return { moves, byRound, warnings, next };
}

/** Public core for tests: the moves and the per-round date table, no side effects. */
export function planDateShift(series: Series, opts: ShiftOpts): ShiftPlan {
  const { moves, byRound, warnings } = computeShift(series, opts);
  return { moves, byRound, warnings };
}

// ─────────────────────────────── CLI ───────────────────────────────

function splitList(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

interface CliArgs {
  tenant: string;
  series: string[];
  fromDates: string[];
  toDates: string[];
  cascade: CascadeMode;
  confirm: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    tenant: '',
    series: [],
    fromDates: [],
    toDates: [],
    cascade: 'slot',
    confirm: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') args.confirm = true;
    else if (a === '--tenant') args.tenant = argv[++i] ?? '';
    else if (a === '--series') args.series.push(...splitList(argv[++i] ?? ''));
    else if (a === '--from-date') args.fromDates.push(...splitList(argv[++i] ?? ''));
    else if (a === '--to-date') args.toDates.push(...splitList(argv[++i] ?? ''));
    else if (a === '--cascade') {
      const v = argv[++i] ?? '';
      if (v !== 'slot' && v !== 'weeks' && v !== 'none')
        throw new Error(`--cascade must be slot|weeks|none, got "${v}"`);
      args.cascade = v;
    } else throw new Error(`unknown flag ${a}`);
  }
  if (!args.tenant) throw new Error('--tenant <slug> is required');
  if (!args.series.length) throw new Error('--series <id,…> is required');
  if (!args.fromDates.length) throw new Error('--from-date is required');
  if (!args.toDates.length) throw new Error('--to-date is required');
  // Validate the pairing early so bad input fails before any read.
  buildPairMap(args.fromDates, args.toDates);
  return args;
}

/** Every season-wide clash, keyed by the date/time-free clashKey used by the in-season
 * gate, gathered by treating each series as the subject in turn. */
function allClashKeys(all: Series[], clubs: Club[], venues: Venue[]): Set<string> {
  const keys = new Set<string>();
  for (const s of all) for (const c of findClashes(s, all, clubs, venues)) keys.add(clashKey(c));
  return keys;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { tenant } = args;

  const repo = await import('./repo.js');
  const [all, clubs, venues] = await Promise.all([
    repo.listSeries(tenant),
    repo.listClubs(tenant),
    repo.listVenues(tenant),
  ]);
  const byId = new Map(all.map((s) => [String(s.id), s]));

  const missing = args.series.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`series not found in ${tenant}: ${missing.join(', ')}`);

  console.log(
    `Shift-fixture-dates (${tenant}) — cascade=${args.cascade} — ${args.confirm ? 'CONFIRM (write)' : 'DRY-RUN'}\n` +
      `from ${args.fromDates.join(', ')} → to ${args.toDates.join(', ')}\n`,
  );

  // Compute the plan for each target series and stage the modified copies.
  const modifiedById = new Map<string, Series>();
  let touched = 0;
  for (const id of args.series) {
    const series = byId.get(id)!;
    const { moves, byRound, warnings, next } = computeShift(series, args);
    console.log(`── ${id}  (${series.name})`);
    for (const w of warnings) console.log(`   ⚠ WARNING: ${w}`);
    if (!byRound.length) {
      console.log('   no fixtures on the from-date(s) — unchanged\n');
      continue;
    }
    for (const r of byRound)
      console.log(`   R${r.round ?? '?'}  ${r.oldDate ?? '(none)'} → ${r.newDate}`);
    console.log(`   ${moves.length} fixture(s) touched\n`);
    touched += moves.length;
    modifiedById.set(id, next);
  }

  if (!modifiedById.size) {
    console.log('Nothing to move — no fixtures matched the from-date(s).');
    return;
  }

  // Clash check on the would-be state of the whole tenant.
  const before = allClashKeys(all, clubs, venues);
  const modifiedAll = all.map((s) => modifiedById.get(String(s.id)) ?? s);
  const afterClashes = modifiedAll.flatMap((s) => findClashes(s, modifiedAll, clubs, venues));
  const seenKeys = new Set<string>();
  const uniqueAfter = afterClashes.filter((c) => {
    const k = clashKey(c);
    if (seenKeys.has(k)) return false;
    seenKeys.add(k);
    return true;
  });
  const introduced = uniqueAfter.filter((c) => !before.has(clashKey(c)));

  console.log(
    `Clash check on the resulting calendar: ${uniqueAfter.length} clash(es) total, ${introduced.length} NEWLY introduced.`,
  );
  for (const c of introduced) console.log(`   NEW  ${formatClashForHumans(c)}`);
  const preExisting = uniqueAfter.filter((c) => before.has(clashKey(c)));
  for (const c of preExisting) console.log(`   pre-existing  ${formatClashForHumans(c)}`);
  console.log('');

  if (introduced.length) {
    console.log(
      `Refusing to write: the change would introduce ${introduced.length} new venue clash(es). ` +
        'Adjust the dates or cascade mode and re-run.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`${touched} fixture(s) across ${modifiedById.size} series would move.`);
  if (!args.confirm) {
    console.log('[dry-run] nothing written. Re-run with --confirm to apply.');
    return;
  }

  // Backup the touched series before writing.
  const backup = args.series.map((id) => byId.get(id)!);
  const path = `./shift-fixture-dates-${tenant}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(path, JSON.stringify(backup, null, 2));
  console.log(`Backup written: ${path} (${backup.length} series)`);

  for (const id of args.series) {
    const next = modifiedById.get(id);
    if (!next) continue;
    await repo.updateSeries(tenant, id, { fixtures: next.fixtures, version: next.version });
    console.log(`updated ${id}`);
  }
  console.log('Done.');
}

// Run only as a script, not when imported by the test.
if (process.argv[1] && /shift-fixture-dates\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

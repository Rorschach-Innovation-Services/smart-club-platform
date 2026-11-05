/**
 * Tuskers (KZNICU) 2026-27 fixture import — the Mens workbook's two visible Premier League
 * sheets (T20 + 50 Overs) and the standalone Veterans workbook → `s-tuskers-*` Series rows on
 * the `tuskers` tenant, as DRAFTS, reversibly; plus a SILENT release mode.
 *
 *   npx tsx src/import-tuskers-fixtures.ts --parse-only [--report-out <md>] [--today <iso>]   # no AWS
 *   npx sst shell --stage dev -- npx tsx src/import-tuskers-fixtures.ts             # dry-run
 *   … [--only <seriesId|slug>[,…]]                                                 # restrict the run
 *   … --confirm [--backup-dir <dir>]                                               # write drafts (backup first)
 *   … --revert [--include-released] [--confirm]                                    # delete the imported series
 *   … --release [--confirm]                                                        # silent release (gate preview → write)
 *   … --map-club <clubMapId>=<tenantClubId>                                        # a club stored under another id (prod Lancashire)
 *
 * Inputs default to ~/Downloads (override with --file-mens / --file-vets).
 *
 * Shape (lions/emcu participant pattern): one side per club per league ⇒ teamId === clubId.
 * Fixture ids are STABLE across re-imports (fixture-identity.ts), mandatory for the later
 * medicoach sync. Every series write goes through `writeSeriesFromSnapshot` (version-pinned
 * to the copy this run read). Venues resolve to the tenant registry (`venueLocked`); a miss is
 * written as a `venueOverride` and listed (zero expected after the prereqs bootstrap). TBC
 * venues are written venue-less (`venueStatus: 'unresolved'`).
 *
 * Fail-closed: a sheet off its measured count, an unparseable row, an unknown team or ground,
 * a club the tenant lacks, an existing RELEASED series, or ANY venue clash aborts the write.
 * There is NO --allow-clashes (standing rule).
 *
 * --release is SILENT by construction: release sends nothing server-side (the console's
 * `applySeriesPatch` fires no notice either), and this file imports nothing from `notify/`. It
 * re-reads every `s-tuskers-*` series, re-runs the console's release clash gate per series
 * (`findClashes` against every tenant series, tenant aliases — fail-closed parity), and writes
 * `approved/released: true` + timestamps through `writeSeriesFromSnapshot`. It REFUSES when the
 * tenant has `fixtureReminders.enabled` or `features.medicoachSync` on: a CLI release skips the
 * console's medicoach requeue, so it is valid only while the bundle carry owns the initial load.
 */
import ExcelJS from 'exceljs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WrittenFixture } from './import-planb-fixtures.js';
import { findClashes, formatClash, venueAliasesFor, type Clash } from './venue-clash.js';
import { SYNC_OWNED_FIXTURE_FIELDS, stabiliseAgainstStored } from './fixture-identity.js';
import { writeSeriesFromSnapshot } from './medicoach-sync/cli-write.js';
import { deleteSeriesWithSync, pendingOnce } from './medicoach-sync/schedule.js';
import { hasFeature } from './features.js';
import { CLUB_MAP, effectiveClubId, parseMapClubArgs } from './tuskers-import-map.js';
import {
  TUSKERS_TENANT,
  TUSKERS_SERIES_PREFIX,
  TUSKERS_GATE_ALIASES,
  TUSKERS_HOME_VENUES,
  TUSKERS_LEAGUE_KEYS,
  TUSKERS_LEAGUE_LABELS,
  TUSKERS_TEAMS,
  TUSKERS_VENUE_ALIASES,
  TUSKERS_VENUE_SPELLINGS,
  EXPECTED_TOTAL_FIXTURES,
  WRITABLE_SERIES_IDS,
  T20_KO_SERIES_ID,
  parseTuskersWorkbooks,
  seriesNameFor,
  tuskersGroundKey,
  type ParsedTuskersSheet,
  type TuskersRawFixture,
  type TuskersWorkbook,
} from './tuskers-fixture-map.js';
import type { Club, Series, TenantConfig, Venue, VenueStatus } from './types.js';

type RepoModule = typeof import('./repo.js');
type SeriesParticipant = NonNullable<Series['participants']>[number];

export const DEFAULT_PATHS: Record<TuskersWorkbook, string> = {
  mens: join(homedir(), 'Downloads', 'Mens Club League Fixtures Season 2026_2027.xlsx'),
  vets: join(homedir(), 'Downloads', 'Copy of Veterans_Fixtures_2026_2027.xlsx'),
};

// ───────────────────────── Args ─────────────────────────

export interface Args {
  mode: 'import' | 'revert' | 'release';
  files: Record<TuskersWorkbook, string>;
  parseOnly: boolean;
  confirm: boolean;
  only: string[];
  reportOut: string;
  backupDir: string;
  today: string;
  includeReleased: boolean;
  mapClub: string[];
}

/** `--only` accepts a full series id or the slug after `s-tuskers-`. */
export function normaliseOnly(v: string): string {
  return v.startsWith(TUSKERS_SERIES_PREFIX) ? v : `${TUSKERS_SERIES_PREFIX}${v}`;
}

export function parseArgs(argv: string[], now: Date = new Date()): Args {
  const args: Args = {
    mode: 'import',
    files: { ...DEFAULT_PATHS },
    parseOnly: false,
    confirm: false,
    only: [],
    reportOut: '',
    backupDir: '.',
    today: now.toISOString().slice(0, 10),
    includeReleased: false,
    mapClub: [],
  };
  const need = (i: number, flag: string) => {
    const v = argv[i];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file-mens') args.files.mens = need(++i, a);
    else if (a === '--file-vets') args.files.vets = need(++i, a);
    else if (a === '--report-out') args.reportOut = need(++i, a);
    else if (a === '--backup-dir') args.backupDir = need(++i, a);
    else if (a === '--today') args.today = need(++i, a);
    else if (a === '--map-club') args.mapClub.push(need(++i, a));
    else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--revert') args.mode = 'revert';
    else if (a === '--release') args.mode = 'release';
    else if (a === '--include-released') args.includeReleased = true;
    else if (a === '--allow-clashes')
      throw new Error('--allow-clashes does not exist (standing rule): resolve the clash instead');
    else if (a === '--only')
      args.only = need(++i, a)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(normaliseOnly);
    else throw new Error(`unknown flag ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.today)) throw new Error('--today expects YYYY-MM-DD');
  if (args.parseOnly && args.confirm)
    throw new Error('--parse-only and --confirm are mutually exclusive');
  if (args.parseOnly && args.mode !== 'import')
    throw new Error('--parse-only is an import flag (not --revert / --release)');
  if (args.includeReleased && args.mode !== 'revert')
    throw new Error('--include-released is a --revert flag');
  if (args.reportOut && !args.parseOnly && args.mode !== 'import')
    throw new Error('--report-out is an import flag');
  for (const id of args.only)
    if (!WRITABLE_SERIES_IDS.includes(id))
      throw new Error(`--only: unknown series "${id}" (known: ${WRITABLE_SERIES_IDS.join(', ')})`);
  parseMapClubArgs(
    args.mapClub,
    CLUB_MAP.map((c) => c.id),
  ); // validate early
  return args;
}

// ───────────────────────── Build ─────────────────────────

export interface BuildContext {
  clubs: Club[];
  venues: Venue[];
  leagueLabel: (key: string) => string;
  stored?: Series[];
  /** CLUB_MAP id → tenant club id (`--map-club`). */
  mapping?: Map<string, string>;
}

export interface BuildOutcome {
  series: Series[];
  missingClubs: string[];
  locked: number;
  registryMisses: Map<string, number>;
  tbc: Array<{ seriesId: string; fixtureId: string; date: string; home: string; away: string }>;
  /** Stored fixtures no incoming row matched (re-import), per series. */
  removed: Array<{ seriesId: string; fixtures: string[] }>;
  errors: string[];
}

function deriveStatus(
  venue: Venue | undefined,
  homeClubId: string,
  awayClubId: string,
): VenueStatus {
  const ids = venue?.homeClubIds ?? [];
  if (ids.includes(homeClubId)) return 'home';
  if (ids.includes(awayClubId)) return 'alternative';
  return 'neutral';
}

/** Club ids this tenant uses for a parsed club id (`--map-club` applied). */
export function tenantClubId(id: string, mapping: Map<string, string> = new Map()): string {
  return effectiveClubId(id, mapping);
}

/**
 * Build every Series (league series + the veterans playoff). Pure — the caller decides what is
 * fatal from the outcome.
 */
export function buildTuskersSeries(sheets: ParsedTuskersSheet[], ctx: BuildContext): BuildOutcome {
  const mapping = ctx.mapping ?? new Map<string, string>();
  const clubsById = new Map(ctx.clubs.map((c) => [c.id, c]));
  const registry = new Map<string, Venue>();
  for (const v of ctx.venues) registry.set(tuskersGroundKey(v.name), v);
  const out: BuildOutcome = {
    series: [],
    missingClubs: [],
    locked: 0,
    registryMisses: new Map(),
    tbc: [],
    removed: [],
    errors: [],
  };
  const storedById = new Map((ctx.stored ?? []).map((s) => [String(s.id), s]));

  for (const sheet of sheets) {
    const { spec } = sheet;
    const participants: SeriesParticipant[] = [];
    const teamIds: string[] = [];
    const side = (parsedId: string): string => {
      const id = tenantClubId(parsedId, mapping);
      const club = clubsById.get(id);
      if (!club && !out.missingClubs.includes(id)) out.missingClubs.push(id);
      if (!teamIds.includes(id)) {
        teamIds.push(id);
        const g = club?.ground ?? {};
        participants.push({
          teamId: id,
          clubId: id,
          name: club?.name ?? TUSKERS_TEAMS.find((t) => t.id === parsedId)?.name ?? id,
          ...(g.venue ? { venue: g.venue } : {}),
          ...(Number.isFinite(g.lat) ? { lat: g.lat as number } : {}),
          ...(Number.isFinite(g.lon) ? { lon: g.lon as number } : {}),
        });
      }
      return id;
    };
    // Participants in team-list order (stable across runs).
    for (const t of sheet.teamList) side(t);
    const dates = [...new Set(sheet.fixtures.map((f) => f.date))].sort();
    const fixtures: Array<WrittenFixture & { timeSource: string }> = sheet.fixtures.map((f, i) =>
      writtenFixture(f, i, dates, side, registry, out),
    );
    const stored = storedById.get(spec.seriesId);
    const renames = stabiliseAgainstStored(fixtures, stored);
    for (const t of out.tbc)
      if (t.seriesId === spec.seriesId && renames.has(t.fixtureId))
        t.fixtureId = renames.get(t.fixtureId)!;
    if (stored) {
      const finalIds = new Set(fixtures.map((f) => f.id));
      const gone = ((stored.fixtures as WrittenFixture[] | undefined) ?? [])
        .filter((f) => !finalIds.has(f.id))
        .map((f) => `${f.id} ${f.date} ${f.home} v ${f.away}`);
      if (gone.length) out.removed.push({ seriesId: spec.seriesId, fixtures: gone });
    }
    const series = {
      id: spec.seriesId,
      name: seriesNameFor(spec, ctx.leagueLabel),
      leagueKey: spec.leagueKey,
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      dateMode: 'reference',
      teams: teamIds,
      participants,
      fixtures,
      maxOvers: spec.maxOvers,
      seriesType: spec.seriesType,
      kind: 'series',
      approved: false,
      released: false,
      releasedAt: null,
      version: 1,
    } as unknown as Series;
    out.series.push(series);

    if (spec.koSeriesId && sheet.ko.length) {
      const ko: KoFixture[] = sheet.ko.map((k, i) => ({
        id: k.fixtureId,
        round: i + 1,
        date: k.date,
        time: k.time,
        timeSource: 'sheet',
        home: k.home,
        away: k.away,
        stage: k.stage,
        venueStatus: 'unresolved',
        venueReason: `KZNICU veterans workbook — venue "${k.rawVenue}"`,
      }));
      const koStored = storedById.get(spec.koSeriesId);
      const r = stabiliseKoFixtures(ko, koStored);
      if (r.removed.length) out.removed.push({ seriesId: spec.koSeriesId, fixtures: r.removed });
      const koDates = ko.map((f) => f.date).sort();
      out.series.push({
        id: spec.koSeriesId,
        name: `${seriesNameFor({ leagueKey: spec.leagueKey, part: '' }, ctx.leagueLabel)} · Playoff`,
        leagueKey: spec.leagueKey,
        startDate: koDates[0],
        endDate: koDates[koDates.length - 1],
        dateMode: 'reference',
        teams: [...teamIds],
        participants: [...participants],
        fixtures: ko,
        maxOvers: spec.maxOvers,
        seriesType: spec.seriesType,
        kind: 'series',
        approved: false,
        released: false,
        releasedAt: null,
        version: 1,
      } as unknown as Series);
    }
  }
  return out;
}

function writtenFixture(
  f: TuskersRawFixture,
  i: number,
  dates: string[],
  side: (id: string) => string,
  registry: Map<string, Venue>,
  out: BuildOutcome,
): WrittenFixture & { timeSource: string } {
  const home = side(f.home);
  const away = side(f.away);
  const wf: WrittenFixture & { timeSource: string } = {
    id: `f${i + 1}`,
    round: dates.indexOf(f.date) + 1,
    date: f.date,
    time: f.time,
    timeSource: f.timeSource,
    home,
    away,
  };
  const source = `KZNICU 2026-27 ${f.sheet} row ${f.row}${f.rescheduledFrom ? ' (side-table reschedule)' : ''}`;
  if (f.venue == null) {
    wf.venueStatus = 'unresolved';
    wf.venueReason = `${source} — venue TBC`;
    out.tbc.push({ seriesId: f.seriesId, fixtureId: wf.id, date: f.date, home, away });
    return wf;
  }
  const venue = registry.get(tuskersGroundKey(f.venue));
  wf.venueReason = `${source} — exact venue`;
  wf.venueStatus = deriveStatus(venue, home, away);
  if (venue) {
    wf.venueId = venue.id;
    wf.venueName = venue.name;
    if (Number.isFinite(venue.lat)) wf.venueLat = venue.lat;
    if (Number.isFinite(venue.lon)) wf.venueLon = venue.lon;
    wf.venueLocked = true;
    out.locked++;
  } else {
    wf.venueOverride = f.venue;
    wf.venueName = f.venue;
    out.registryMisses.set(f.venue, (out.registryMisses.get(f.venue) ?? 0) + 1);
  }
  return wf;
}

// ───────────────────────── Knockout ids ─────────────────────────

export type KoFixture = WrittenFixture & {
  timeSource: string;
  stage: string;
  slots?: { home?: string; away?: string };
};

/**
 * Stable ids for the veterans playoff, whose Final points at the Eliminator (`win:f1`). A
 * `win:`/`lose:` ref names a fixture by id, so matching on it would miss whenever the stored
 * ids differ from the sheet's; both sides are therefore matched with every such ref anchored to
 * the referenced fixture's DATE instead, and stored sides by placeholder (`slots[side] ?? side`,
 * so a side an admin already set still matches). Afterwards the incoming refs are rewritten
 * from the sheet ids to the final ids. Mutates `incoming`.
 */
export function stabiliseKoFixtures(
  incoming: KoFixture[],
  stored: Series | undefined,
): { removed: string[]; renames: Map<string, string> } {
  if (!stored) return { removed: [], renames: new Map() };
  type Slotted = WrittenFixture & { slots?: { home?: string; away?: string } };
  const anchor = <T extends Slotted>(fixtures: T[], placeholders: boolean): T[] => {
    const dateOf = new Map(fixtures.map((f) => [f.id, f.date]));
    const a = (ref: string) => {
      const m = /^(win|lose):(f\d+)$/.exec(ref);
      return m ? `${m[1]}:@${dateOf.get(m[2]) ?? m[2]}` : ref;
    };
    return fixtures.map((f) => ({
      ...f,
      home: a(placeholders ? (f.slots?.home ?? f.home) : f.home),
      away: a(placeholders ? (f.slots?.away ?? f.away) : f.away),
    }));
  };
  const storedFx = (stored.fixtures as Slotted[] | undefined) ?? [];
  const keyed = anchor(incoming, false);
  const sheetIds = incoming.map((f) => f.id);
  const renames = stabiliseAgainstStored(keyed, { ...stored, fixtures: anchor(storedFx, true) });
  const finalOf = new Map(sheetIds.map((id, i) => [id, keyed[i].id]));
  const remap = (ref: string | undefined) => {
    const m = ref ? /^(win|lose):(f\d+)$/.exec(ref) : null;
    return m && finalOf.has(m[2]) ? `${m[1]}:${finalOf.get(m[2])}` : ref;
  };
  const storedById = new Map(storedFx.map((f) => [f.id, f]));
  incoming.forEach((f, i) => {
    const k = keyed[i];
    f.id = k.id;
    // stabiliseAgainstStored carried the stored sync-owned fields onto the keyed copy.
    const from = k as unknown as Record<string, unknown>;
    const to = f as unknown as Record<string, unknown>;
    for (const field of SYNC_OWNED_FIXTURE_FIELDS)
      if (from[field] !== undefined) to[field] = from[field];
    f.home = remap(f.home)!;
    f.away = remap(f.away)!;
    // A side an admin already set (Set team: the placeholder kept in `slots`) stays set.
    const st = storedById.get(f.id);
    if (st?.slots) {
      f.slots = { ...st.slots };
      for (const side of ['home', 'away'] as const)
        if (st.slots[side] && remap(st.slots[side]) === f[side]) f[side] = st[side];
    }
  });
  const ids = new Set(incoming.map((f) => f.id));
  const removed = storedFx
    .filter((f) => !ids.has(f.id))
    .map((f) => `${f.id} ${f.date} ${f.home} v ${f.away}`);
  return { removed, renames };
}

// ───────────────────────── Would-be registry ─────────────────────────

/** Deterministic registry id for a canonical ground name (the lions/titans `v-*` rule). */
export function venueIdFor(name: string): string {
  return `v-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')}`;
}

/** One registry row per canonical ground the sheets use, surfaces 1, `homeClubIds` from the
 * 50-overs header block (`--map-club` applied). */
export function wouldBeRegistry(mapping: Map<string, string> = new Map()): Venue[] {
  return TUSKERS_VENUE_SPELLINGS.map((v) => ({
    id: venueIdFor(v.name),
    name: v.name,
    surfaces: 1,
    homeClubIds: Object.entries(TUSKERS_HOME_VENUES)
      .filter(([, g]) => g === v.name)
      .map(([id]) => tenantClubId(id, mapping)),
  })) as Venue[];
}

/** Skeletal Club records for --parse-only (the 8 compliance clubs + the 3 new vets clubs). */
export function clubsFromMap(): Club[] {
  return TUSKERS_TEAMS.map(
    (t) =>
      ({
        id: t.id,
        name: t.name,
        ground: TUSKERS_HOME_VENUES[t.id] ? { venue: TUSKERS_HOME_VENUES[t.id] } : {},
      }) as unknown as Club,
  );
}

// ───────────────────────── Clash scan ─────────────────────────

export interface ScanClash extends Clash {
  seriesId: string;
  seriesName: string;
}

function withoutTbc(s: Series): Series {
  return {
    ...s,
    fixtures: ((s.fixtures as WrittenFixture[]) ?? []).filter(
      (f) => f.venueOverride || f.venueName,
    ),
  };
}

/** Release-gate semantics; every double-booking reported once. TBC excluded unless asked. */
export function scanClashes(
  built: Series[],
  existingOther: Series[],
  clubs: Club[],
  venues: Venue[],
  opts: { includeTbc?: boolean; aliases?: Record<string, string> } = {},
): ScanClash[] {
  const subjects = opts.includeTbc ? built : built.map(withoutTbc);
  const out: ScanClash[] = [];
  for (let i = 0; i < subjects.length; i++) {
    const subject = subjects[i];
    for (const c of findClashes(
      subject,
      [...existingOther, ...subjects.slice(0, i)],
      clubs,
      venues,
      opts.aliases ?? TUSKERS_GATE_ALIASES,
    ))
      out.push({ ...c, seriesId: String(subject.id), seriesName: subject.name });
  }
  return out;
}

// ───────────────────────── Silent release ─────────────────────────

/** Why the tenant must not be CLI-released right now (empty ⇒ allowed). */
export function releasePreambleBlockers(config: TenantConfig | null): string[] {
  const out: string[] = [];
  if (!config) return [`no tenant config for "${TUSKERS_TENANT}"`];
  if (config.fixtureReminders?.enabled)
    out.push(
      'fixtureReminders.enabled is ON — released fixtures would enter the reminder cron; disable it first',
    );
  if (hasFeature(config, 'medicoachSync'))
    out.push(
      'features.medicoachSync is ON — a CLI release skips the console requeue; release only while sync is off (bundle carry owns the initial load)',
    );
  return out;
}

export interface ReleasePlan {
  release: Array<{ current: Series; next: Series }>;
  held: Array<{ series: Series; clashes: Clash[] }>;
  already: Series[];
  empty: Series[];
}

/**
 * The console's release gate, per series (applySeriesPatch's `released: true && !current.released`
 * branch): `findClashes(subject, allSeries, clubs, venues, tenantAliases)` — any clash holds that
 * series. Releasing changes no fixture, so the order of releases cannot change a verdict. Pure.
 */
export function planRelease(
  mine: Series[],
  allSeries: Series[],
  clubs: Club[],
  venues: Venue[],
  aliases: Record<string, string>,
  nowIso: string,
): ReleasePlan {
  const plan: ReleasePlan = { release: [], held: [], already: [], empty: [] };
  for (const current of mine) {
    if (current.released) {
      plan.already.push(current);
      continue;
    }
    if (!((current.fixtures as unknown[] | undefined) ?? []).length) {
      plan.empty.push(current);
      continue;
    }
    const next = {
      ...current,
      approved: true,
      approvedAt: current.approved ? (current.approvedAt ?? nowIso) : nowIso,
      released: true,
      releasedAt: nowIso,
    } as Series;
    // A CLI release withholds nothing (planTitansRelease parity).
    delete (next as { withheld?: unknown }).withheld;
    delete (next as { revealedAt?: unknown }).revealedAt;
    const clashes = findClashes(next, allSeries, clubs, venues, aliases);
    if (clashes.length) plan.held.push({ series: current, clashes });
    else plan.release.push({ current, next });
  }
  return plan;
}

// ───────────────────────── Report ─────────────────────────

export function renderReportMarkdown(args: {
  sheets: ParsedTuskersSheet[];
  built: Series[];
  outcome: BuildOutcome;
  clashes: ScanClash[];
  today: string;
  generatedAt: string;
}): string {
  const { sheets, built, outcome, clashes, today } = args;
  const L: string[] = [];
  L.push('# KZNICU 2026-27 fixtures — import report');
  L.push('');
  L.push(`Generated ${args.generatedAt}; "past" means dated before ${today}.`);
  L.push('');
  L.push('## Series');
  L.push('');
  L.push('| Series | Fixtures | Time source |');
  L.push('|---|---:|---|');
  for (const s of built) {
    const fx = s.fixtures as Array<{ timeSource?: string }>;
    const src = new Map<string, number>();
    for (const f of fx)
      src.set(f.timeSource ?? 'sheet', (src.get(f.timeSource ?? 'sheet') ?? 0) + 1);
    L.push(
      `| ${s.id} (${s.name}) | ${fx.length} | ${[...src].map(([k, n]) => `${k} ×${n}`).join(', ')} |`,
    );
  }
  L.push('');
  L.push(
    '_Provisional times_: Prem 50 Overs rows carry no start time → 09:30; Prem T20 "Sunday AM/PM" → 09:00 / 13:30. Confirm with KZNICU.',
  );
  L.push('');
  L.push('## Rows not imported');
  L.push('');
  for (const s of sheets)
    for (const e of s.excluded)
      L.push(`- **${e.kind}** ${e.sheet} row ${e.row} (\`${e.text}\`): ${e.reason}`);
  L.push(
    `- The ${T20_KO_SERIES_ID} series is NOT written: its Eliminator/Final rows are held back above.`,
  );
  L.push('');
  L.push('## Overrides applied');
  L.push('');
  for (const s of sheets) {
    for (const r of s.reschedules)
      L.push(
        `- ${s.spec.sheet} row ${r.appliedTo}: ${r.home} v ${r.away} → ${r.date} ${r.time} @ ${r.venue} (side table)`,
      );
    for (const f of s.cellFixes)
      L.push(`- ${f.sheet} row ${f.row}: team "${f.raw}" read as "${f.team}" — ${f.reason}`);
  }
  L.push('');
  L.push('## Playoff (veterans)');
  L.push('');
  for (const s of sheets)
    for (const k of s.ko)
      L.push(
        `- ${k.koSeriesId} ${k.fixtureId} ${k.stage}: ${k.date} ${k.time} ${k.home} v ${k.away} (venue TBC)`,
      );
  L.push('');
  const past = built.flatMap((s) =>
    ((s.fixtures as WrittenFixture[]) ?? [])
      .filter((f) => f.date < today)
      .map((f) => `${s.id} ${f.id} ${f.date} ${f.time ?? ''} ${f.home} v ${f.away}`),
  );
  L.push(`## Past-dated fixtures (${past.length}) — imported normally`);
  L.push('');
  for (const p of past) L.push(`- ${p}`);
  L.push('');
  L.push(`## Venue TBC (${outcome.tbc.length})`);
  L.push('');
  for (const t of outcome.tbc)
    L.push(`- ${t.seriesId} ${t.fixtureId} ${t.date} ${t.home} v ${t.away}`);
  L.push('');
  const notHome = built.flatMap((s) =>
    ((s.fixtures as WrittenFixture[]) ?? [])
      .filter((f) => f.venueStatus && f.venueStatus !== 'home' && f.venueStatus !== 'unresolved')
      .map(
        (f) =>
          `${s.id} ${f.id} ${f.date} ${f.home} v ${f.away} @ ${f.venueName} (${f.venueStatus})`,
      ),
  );
  L.push(`## Fixtures not at the first-named team's home ground (${notHome.length})`);
  L.push('');
  for (const n of notHome) L.push(`- ${n}`);
  L.push('');
  L.push(`## Clash scan: ${clashes.length ? `${clashes.length} clash(es)` : 'clean'}`);
  L.push('');
  for (const c of clashes) L.push(`- ${c.seriesId}: ${formatClash(c)}`);
  L.push('');
  return L.join('\n');
}

// ───────────────────────── CLI ─────────────────────────

async function readWb(path: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

export async function parseFiles(files: Record<TuskersWorkbook, string>) {
  const books = { mens: await readWb(files.mens), vets: await readWb(files.vets) };
  return parseTuskersWorkbooks(books);
}

function printParse(sheets: ParsedTuskersSheet[], files: Record<TuskersWorkbook, string>) {
  console.log(`Mens workbook: ${files.mens}\nVets workbook: ${files.vets}`);
  for (const s of sheets) {
    const mark = s.fixtures.length === s.spec.expected ? '✓' : '✗';
    const tbc = s.fixtures.filter((f) => f.venue == null).length;
    console.log(
      `  ${mark} [${s.spec.workbook}] ${s.spec.sheet.padEnd(24)} → ${s.spec.seriesId}: ${s.fixtures.length}/${s.spec.expected} fixtures, ${new Set(s.teamList).size} teams` +
        (s.ko.length ? `, ${s.ko.length} playoff row(s) → ${s.spec.koSeriesId}` : '') +
        (tbc ? `, ${tbc} TBC venue(s)` : ''),
    );
    for (const e of s.excluded) console.log(`      − row ${e.row} ${e.kind}: ${e.reason}`);
    for (const r of s.reschedules)
      console.log(
        `      ↻ row ${r.appliedTo}: ${r.home} v ${r.away} → ${r.date} ${r.time} @ ${r.venue} (side table)`,
      );
    for (const f of s.cellFixes) console.log(`      ✎ row ${f.row}: "${f.raw}" → ${f.team}`);
    for (const w of s.warnings) console.log(`      ⚠ ${w}`);
  }
  const total = sheets.reduce((n, s) => n + s.fixtures.length, 0);
  console.log(`  total: ${total} league fixtures (expected ${EXPECTED_TOTAL_FIXTURES})`);
}

function printClashes(title: string, clashes: ScanClash[]) {
  console.log(`\n── ${title}`);
  if (!clashes.length) {
    console.log('  ✓ no clashes');
    return;
  }
  console.log(`  ✗ ${clashes.length} clash(es):`);
  for (const c of clashes) console.log(`    ${c.seriesId}: ${formatClash(c)}`);
}

function inScope(args: Args) {
  return (id: string) => !args.only.length || args.only.includes(id);
}

async function backup(series: Series[], dir: string): Promise<string> {
  const path = join(
    dir,
    `tuskers-fixtures-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await writeFile(path, JSON.stringify(series, null, 2));
  console.log(`Backup written: ${path} (${series.length} series)`);
  return path;
}

export async function runImport(args: Args) {
  const { sheets, errors } = await parseFiles(args.files);
  printParse(sheets, args.files);
  if (errors.length) {
    console.error(`\n✗ Refusing to continue — ${errors.length} parse problem(s):`);
    for (const e of errors) console.error(`   ${e}`);
    process.exitCode = 1;
    return;
  }
  const mapping = parseMapClubArgs(
    args.mapClub,
    CLUB_MAP.map((c) => c.id),
  );

  let repo: RepoModule | null = null;
  let config: TenantConfig | null = null;
  let clubs: Club[];
  let venues: Venue[];
  let existing: Series[] = [];
  let aliases = TUSKERS_GATE_ALIASES;
  let leagueLabel = (k: string) => TUSKERS_LEAGUE_LABELS[k] ?? k;
  if (args.parseOnly) {
    clubs = clubsFromMap();
    venues = wouldBeRegistry();
  } else {
    repo = await import('./repo.js');
    config = await repo.getTenantConfig(TUSKERS_TENANT);
    if (!config) throw new Error(`no tenant config for "${TUSKERS_TENANT}"`);
    // Single-partition reads (Query on the tenant's partition), never a table scan.
    [clubs, venues, existing] = await Promise.all([
      repo.listClubs(TUSKERS_TENANT),
      repo.listVenues(TUSKERS_TENANT),
      repo.listSeries(TUSKERS_TENANT),
    ]);
    aliases = { ...venueAliasesFor(config), ...TUSKERS_VENUE_ALIASES };
    const labels = new Map((config.leagues ?? []).map((l) => [l.key, l.label]));
    leagueLabel = (k) => labels.get(k) ?? TUSKERS_LEAGUE_LABELS[k] ?? k;
    console.log(
      `\nTenant "${TUSKERS_TENANT}": ${clubs.length} club(s), ${venues.length} registry venue(s), ${existing.length} series`,
    );
    console.log(
      `  fixtureReminders.enabled: ${config.fixtureReminders?.enabled ? 'ON' : 'off'} · features.medicoachSync: ${hasFeature(config, 'medicoachSync') ? 'ON' : 'off'}`,
    );
  }

  const outcome = buildTuskersSeries(sheets, {
    clubs,
    venues,
    leagueLabel,
    stored: existing,
    mapping,
  });
  const wanted = inScope(args);
  const built = outcome.series.filter((s) => wanted(String(s.id)));
  const builtIds = new Set(built.map((s) => String(s.id)));
  const total = built.reduce((n, s) => n + (s.fixtures as unknown[]).length, 0);
  const misses = [...outcome.registryMisses.values()].reduce((n, c) => n + c, 0);
  console.log(
    `\n── ${built.length} series, ${total} fixtures → ${outcome.locked} registry-locked, ${misses} venueOverride, ${outcome.tbc.length} TBC`,
  );
  for (const [name, n] of outcome.registryMisses) console.log(`    registry miss "${name}" ×${n}`);
  for (const t of outcome.tbc)
    console.log(`    TBC ${t.seriesId} ${t.fixtureId} ${t.date} ${t.home} v ${t.away}`);
  const past = built.flatMap((s) =>
    ((s.fixtures as WrittenFixture[]) ?? []).filter((f) => f.date < args.today),
  ).length;
  console.log(
    `  ${past} fixture(s) dated before ${args.today} — imported normally (listed in the report)`,
  );
  for (const r of outcome.removed)
    console.log(
      `  ⚠ ${r.seriesId}: stored fixture(s) the sheet no longer has: ${r.fixtures.join('; ')}`,
    );

  const existingOther = existing.filter((s) => !builtIds.has(String(s.id)));
  const clashes = scanClashes(built, existingOther, clubs, venues, { aliases });
  printClashes(
    `Season-wide clash scan (${args.parseOnly ? 'would-be registry, ' : ''}release-gate semantics; TBC excluded)`,
    clashes,
  );
  if (!args.parseOnly) {
    const strict = new Set(
      clashes.map((c) => `${c.seriesId}/${c.fixtureId}|${c.with.seriesId}/${c.with.fixtureId}`),
    );
    const gateOnly = scanClashes(built, existingOther, clubs, venues, {
      aliases,
      includeTbc: true,
    }).filter(
      (c) => !strict.has(`${c.seriesId}/${c.fixtureId}|${c.with.seriesId}/${c.with.fixtureId}`),
    );
    if (gateOnly.length)
      printClashes(
        'Release-gate preview — TBC fixtures placed at the home ground (blocks --release)',
        gateOnly,
      );
  }

  if (args.reportOut) {
    // --only: the report covers just the in-scope series (sheets carry exclusions/overrides).
    const reportSheets = sheets.filter(
      (s) => wanted(s.spec.seriesId) || (s.spec.koSeriesId != null && wanted(s.spec.koSeriesId)),
    );
    await writeFile(
      args.reportOut,
      renderReportMarkdown({
        sheets: reportSheets,
        built,
        outcome: { ...outcome, tbc: outcome.tbc.filter((t) => wanted(t.seriesId)) },
        clashes,
        today: args.today,
        generatedAt: new Date().toISOString().slice(0, 10),
      }),
    );
    console.log(`\nReport written: ${args.reportOut}`);
  }

  const fatal: string[] = [];
  if (clashes.length)
    fatal.push(
      `${clashes.length} venue clash(es) — no --allow-clashes exists; resolve with KZNICU`,
    );
  if (!args.parseOnly) {
    for (const c of outcome.missingClubs)
      fatal.push(
        `club "${c}" is not on the tenant — run bootstrap-tuskers-fixture-prereqs (or pass --map-club)`,
      );
    const have = new Set((config!.leagues ?? []).map((l) => l.key));
    for (const k of TUSKERS_LEAGUE_KEYS)
      if (!have.has(k)) fatal.push(`league key "${k}" is not configured on the tenant`);
    if (args.confirm && misses)
      fatal.push(
        `${misses} fixture(s) miss the venue registry — run bootstrap-tuskers-fixture-prereqs --confirm`,
      );
    for (const s of existing)
      if (builtIds.has(String(s.id)) && s.released)
        fatal.push(
          `${s.id} is already RELEASED — refusing to overwrite (--revert --include-released first)`,
        );
  }
  if (fatal.length) {
    console.error(
      `\n✗ Refusing to ${args.parseOnly ? 'pass parse-only' : 'write'} — ${fatal.length} blocker(s):`,
    );
    for (const f of fatal) console.error(`   ${f}`);
    process.exitCode = 1;
    return;
  }
  if (args.parseOnly) {
    console.log('\n[parse-only] clean — nothing touched AWS.');
    return;
  }
  if (!args.confirm) {
    console.log(
      `\n[dry-run] ${built.length} series would be written as DRAFTS. Re-run with --confirm.`,
    );
    return;
  }

  const storedById = new Map(existing.map((s) => [String(s.id), s]));
  const backupPath = await backup(
    existing.filter((s) => String(s.id).startsWith(TUSKERS_SERIES_PREFIX)),
    args.backupDir,
  );
  const drifted: string[] = [];
  let written = 0;
  try {
    for (const s of built) {
      const st = storedById.get(String(s.id)) ?? null;
      if (st) {
        // Keep an admin's approval of a draft; never released (refused above).
        (s as { approved?: boolean }).approved = st.approved ?? false;
        (s as { approvedAt?: unknown }).approvedAt = st.approvedAt ?? null;
      }
      const r = await writeSeriesFromSnapshot(repo!, TUSKERS_TENANT, st, s);
      if (r === 'drifted') drifted.push(String(s.id));
      else {
        written++;
        console.log(
          `wrote ${s.id} v${s.version} (${(s.fixtures as unknown[]).length} fixtures)${st ? ' (replaced draft)' : ''}`,
        );
      }
    }
  } catch (err) {
    console.error(
      `\n✗ ABORTED after ${written} of ${built.length} series — RE-RUN REQUIRED (stable ids). Backup: ${backupPath}`,
    );
    throw err;
  }
  if (drifted.length) {
    process.exitCode = 1;
    console.error(
      `\n✗ ${drifted.length} series changed since read and were NOT written: ${drifted.join(', ')} — re-run`,
    );
  }
  console.log(
    `\nDone. ${written} draft series written. Backup: ${backupPath}.\nNext: sync-club-leagues-from-series ${TUSKERS_TENANT} --include-drafts --confirm, then --release.`,
  );
}

export async function runRevert(args: Args) {
  const repo = await import('./repo.js');
  const config = await repo.getTenantConfig(TUSKERS_TENANT);
  const all = await repo.listSeries(TUSKERS_TENANT);
  const wanted = inScope(args);
  const mine = all.filter(
    (s) => WRITABLE_SERIES_IDS.includes(String(s.id)) && wanted(String(s.id)),
  );
  if (!mine.length) {
    console.log('Nothing to revert.');
    return;
  }
  if (hasFeature(config, 'medicoachSync')) {
    // A plain delete does not propagate to medicoach (titans "Known gaps"): refuse outright.
    console.error(
      '✗ Refusing to revert — features.medicoachSync is ON and this CLI does not propagate deletes to medicoach. Delete from the console instead.',
    );
    process.exitCode = 1;
    return;
  }
  const released = mine.filter((s) => s.released);
  if (released.length && !args.includeReleased) {
    const msg = `${released.length} RELEASED series in scope: ${released.map((s) => s.id).join(', ')}`;
    if (args.confirm) {
      console.error(
        `\n✗ Refusing to revert — ${msg}. Recall them first, or pass --include-released.`,
      );
      process.exitCode = 1;
      return;
    }
    console.warn(`⚠ ${msg} — --confirm will refuse unless --include-released is passed.`);
  }
  if (args.confirm) await backup(mine, args.backupDir);
  const pending = pendingOnce(repo, TUSKERS_TENANT);
  for (const s of mine) {
    const status = s.released ? 'RELEASED' : s.approved ? 'approved' : 'draft';
    console.log(
      `${args.confirm ? 'delete' : '[dry-run] would delete'}  ${s.id}  (${s.name} · ${status})`,
    );
    // DELETE /series parity (series → officials → sync state → mc-await). Sync is off here
    // (refused above), so no delete rows are built.
    if (args.confirm)
      await deleteSeriesWithSync(repo, TUSKERS_TENANT, String(s.id), {
        config,
        pending,
        origin: 'cli',
      });
  }
  console.log(
    args.confirm
      ? `Reverted ${mine.length} series. NOT reverted: bootstrap clubs/aliases/venues and club-sync league keys.`
      : `Re-run with --confirm to delete these ${mine.length} series.`,
  );
}

export async function runRelease(args: Args) {
  const repo = await import('./repo.js');
  const config = await repo.getTenantConfig(TUSKERS_TENANT);
  console.log(
    `Tenant "${TUSKERS_TENANT}": fixtureReminders.enabled = ${config?.fixtureReminders?.enabled ? 'ON' : 'off'} · features.medicoachSync = ${hasFeature(config, 'medicoachSync') ? 'ON' : 'off'}`,
  );
  const blockers = releasePreambleBlockers(config);
  if (blockers.length) {
    console.error(`\n✗ Refusing to release — ${blockers.length} blocker(s):`);
    for (const b of blockers) console.error(`   ${b}`);
    process.exitCode = 1;
    return;
  }
  // Fresh reads — the gate's own inputs (applySeriesPatch's loadClashInputs).
  const [allSeries, clubs, venues] = await Promise.all([
    repo.listSeries(TUSKERS_TENANT),
    repo.listClubs(TUSKERS_TENANT),
    repo.listVenues(TUSKERS_TENANT),
  ]);
  const wanted = inScope(args);
  const mine = allSeries.filter(
    (s) => String(s.id).startsWith(TUSKERS_SERIES_PREFIX) && wanted(String(s.id)),
  );
  const plan = planRelease(
    mine,
    allSeries,
    clubs,
    venues,
    venueAliasesFor(config),
    new Date().toISOString(),
  );
  for (const s of plan.already) console.log(`  already released  ${s.id}`);
  for (const s of plan.empty) console.log(`  skipped (no fixtures)  ${s.id}`);
  for (const h of plan.held) {
    console.log(`  ✗ HELD  ${h.series.id} — ${h.clashes.length} clash(es):`);
    for (const c of h.clashes) console.log(`      ${formatClash(c)}`);
  }
  for (const r of plan.release)
    console.log(
      `  ${args.confirm ? 'release' : '[dry-run] would release'}  ${r.current.id}  (${(r.current.fixtures as unknown[]).length} fixtures)`,
    );
  if (!args.confirm) {
    console.log(
      `\n[dry-run] ${plan.release.length} to release, ${plan.held.length} held. Re-run with --confirm.`,
    );
    if (plan.held.length) process.exitCode = 1;
    return;
  }
  if (plan.release.length)
    await backup(
      plan.release.map((r) => r.current),
      args.backupDir,
    );
  const drifted: string[] = [];
  for (const r of plan.release) {
    const out = await writeSeriesFromSnapshot(repo, TUSKERS_TENANT, r.current, r.next);
    if (out === 'drifted') drifted.push(String(r.current.id));
    else console.log(`released ${r.next.id} v${r.next.version}`);
  }
  if (drifted.length || plan.held.length) process.exitCode = 1;
  console.log(
    `\nDone. ${plan.release.length - drifted.length} released silently, ${plan.held.length} held (clash), ${drifted.length} changed mid-run (re-run).`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'revert') return runRevert(args);
  if (args.mode === 'release') return runRelease(args);
  return runImport(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}

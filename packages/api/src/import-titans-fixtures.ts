/**
 * Titans 2026-27 fixture import — the 36-sheet union workbook (1,398 fixtures) → `s-titans-*`
 * Series rows on the `titans` tenant, as DRAFTS.
 *
 *   npx tsx src/import-titans-fixtures.ts --parse-only [--report-out <path>]   # no AWS at all
 *
 * STEP A0 (the gate) implements --parse-only only: parse every sheet, resolve every team name
 * to a CLUB_MAP club, build the series in memory with provisional side ids, and run the
 * season-wide clash scan against the WOULD-BE venue registry (canonical ground names, one
 * pitch each, the misspellings-only alias table). The tenant dry-run, `--confirm`, `--only`
 * and `--revert` arrive with the write path (A3); until then any other mode refuses to run.
 *
 * The optional `--structure` workbook (the August league-structure sheet) supplies each club's
 * `ground.venue` exactly as the compliance import wrote it, so the release-gate preview can
 * place TBC-venue fixtures at the home club's ground the way the API gate does.
 *
 * Fail-closed: a sheet off its measured count, an unparseable row, a team name that resolves to
 * no club, a stale HELD_BACK entry or any residual clash fails the gate. There is NO
 * --allow-clashes (standing rule).
 */
import ExcelJS from 'exceljs';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WrittenFixture } from './import-planb-fixtures.js';
import { findClashes, normaliseName, DEFAULT_VENUE_ALIASES, type Clash } from './venue-clash.js';
import { venueIdFor } from './lions-fixture-map.js';
import {
  AMBIGUOUS_VENUES,
  EXPECTED_TOTAL_FIXTURES,
  HELD_BACK,
  TITANS_GATE_ALIASES,
  TITANS_VENUE_SPELLINGS,
  canonicalVenueName,
  cleanVenue,
  isHeldBack,
  isTbcVenue,
  parseTitansWorkbook,
  provisionalSideId,
  resolveTeamClub,
  titansGroundKey,
  type HeldBackFixture,
  type KoRow,
  type ParsedTitansSheet,
  type TimeSource,
  type TitansRawFixture,
} from './titans-fixture-map.js';
import { CLUB_MAP, parseStructureWorkbook, summarizeByClub } from './titans-import-map.js';
import type { Club, Series, Venue } from './types.js';

type SeriesParticipant = NonNullable<Series['participants']>[number];

export const DEFAULT_PATHS = {
  file: join(
    homedir(),
    'Downloads',
    '2026 Titans Club Cricket 2026-2027 Fixtures - 1st Half Final Final Draft.xlsx',
  ),
  structure: join(
    homedir(),
    'Downloads',
    'Titans Club Cricket 2026-2027 PROMOTION RELEGATION.xlsx',
  ),
};

// ───────────────────────── Series builder ─────────────────────────

export interface TitansFixture extends WrittenFixture {
  timeSource: TimeSource;
}

export interface BuiltTitansSeries {
  series: Series;
  /** Fixtures that would be written (held-back ones removed; ids stay reserved). */
  fixtures: TitansFixture[];
  /** Every parsed fixture, held-back included, index-aligned with `allFixtures`. */
  raw: TitansRawFixture[];
  allFixtures: TitansFixture[];
  junior: boolean;
  sheet: string;
}

export interface TitansBuildOutcome {
  built: BuiltTitansSeries[];
  /** Name-resolution sign-off: leagueKey::canonical → club. */
  resolutions: Map<
    string,
    { name: string; leagueKey: string; clubId: string; clubName: string; teamId: string }
  >;
  unresolvedNames: string[];
  held: Array<{
    entry: HeldBackFixture;
    seriesId: string;
    fixtureId: string;
    raw: TitansRawFixture;
  }>;
  /** HELD_BACK entries that matched no parsed fixture, or more than one (fatal). */
  heldProblems: string[];
  tbc: Array<{
    seriesId: string;
    fixtureId: string;
    date: string;
    time: string;
    home: string;
    away: string;
  }>;
}

/**
 * Build every Series (planb/lions shape: participants snapshot, team-id home/away, `f<n>` ids,
 * dateMode 'reference', drafts). Ids are assigned over ALL parsed fixtures of a series in row
 * order BEFORE held-back fixtures are removed, so adding one back later keeps every id stable.
 * Round = rank of the fixture's date among the series' distinct dates. Pure.
 */
export function buildTitansSeries(
  sheets: ParsedTitansSheet[],
  venues: Venue[],
  heldBack: HeldBackFixture[] = HELD_BACK,
): TitansBuildOutcome {
  const registry = new Map<string, Venue>();
  for (const v of venues) registry.set(titansGroundKey(v.name), v);
  const clubsById = new Map(CLUB_MAP.map((c) => [c.id, c]));
  const outcome: TitansBuildOutcome = {
    built: [],
    resolutions: new Map(),
    unresolvedNames: [],
    held: [],
    heldProblems: [],
    tbc: [],
  };
  const heldHits = new Map<HeldBackFixture, number>();

  for (const sheet of sheets) {
    for (const spec of sheet.spec.series) {
      const raw = sheet.fixtures.filter((f) => f.seriesId === spec.seriesId);
      const leagueKey = spec.leagueKey;
      const participants: SeriesParticipant[] = [];
      const teamIds: string[] = [];
      const side = (name: string): string => {
        const club = resolveTeamClub(name);
        if (!club) {
          const u = `${sheet.spec.sheet}: "${name}"`;
          if (!outcome.unresolvedNames.includes(u)) outcome.unresolvedNames.push(u);
          return name;
        }
        const teamId = provisionalSideId(leagueKey, name);
        const key = `${leagueKey}::${name}`;
        if (!outcome.resolutions.has(key))
          outcome.resolutions.set(key, {
            name,
            leagueKey,
            clubId: club.id,
            clubName: clubsById.get(club.id)?.name ?? club.name,
            teamId,
          });
        if (!teamIds.includes(teamId)) {
          teamIds.push(teamId);
          participants.push({ teamId, clubId: club.id, name });
        }
        return teamId;
      };
      const dates = [...new Set(raw.map((f) => f.date))].sort();
      const all: TitansFixture[] = raw.map((f, i) => {
        const wf: TitansFixture = {
          id: `f${i + 1}`,
          round: dates.indexOf(f.date) + 1,
          date: f.date,
          time: f.time,
          timeSource: f.timeSource,
          home: side(f.home),
          away: side(f.away),
        };
        if (f.venue == null) {
          wf.venueStatus = 'unresolved';
          wf.venueReason = 'Titans 2026-27 fixtures workbook — venue TBC';
          return wf;
        }
        wf.venueReason = 'Titans 2026-27 fixtures workbook — exact venue';
        const v = registry.get(titansGroundKey(f.venue));
        if (v) {
          wf.venueId = v.id;
          wf.venueName = v.name;
          wf.venueLocked = true;
        } else {
          wf.venueOverride = f.venue;
          wf.venueName = f.venue;
        }
        return wf;
      });
      const kept: TitansFixture[] = [];
      all.forEach((wf, i) => {
        const h = isHeldBack(raw[i], heldBack);
        if (h) {
          heldHits.set(h, (heldHits.get(h) ?? 0) + 1);
          outcome.held.push({ entry: h, seriesId: spec.seriesId, fixtureId: wf.id, raw: raw[i] });
          return;
        }
        kept.push(wf);
        if (raw[i].venue == null)
          outcome.tbc.push({
            seriesId: spec.seriesId,
            fixtureId: wf.id,
            date: wf.date,
            time: wf.time ?? '',
            home: raw[i].home,
            away: raw[i].away,
          });
      });
      const keptDates = kept.map((f) => f.date).sort();
      const series = {
        id: spec.seriesId,
        name: spec.seriesName,
        leagueKey,
        startDate: keptDates[0],
        endDate: keptDates[keptDates.length - 1],
        dateMode: 'reference',
        teams: teamIds,
        participants,
        fixtures: kept,
        ...(sheet.spec.layout === 't20' ? { seriesType: 'T20', maxOvers: 20 } : {}),
        kind: 'series',
        // Drafts on purpose: the admin approves + releases from the console.
        approved: false,
        released: false,
        releasedAt: null,
        version: 1,
      } as unknown as Series;
      outcome.built.push({
        series,
        fixtures: kept,
        raw,
        allFixtures: all,
        junior: sheet.spec.junior,
        sheet: sheet.spec.sheet,
      });
    }
  }
  for (const h of heldBack) {
    const n = heldHits.get(h) ?? 0;
    if (n !== 1)
      outcome.heldProblems.push(
        `HELD_BACK ${h.sheet} ${h.date} ${h.home} v ${h.away} @ ${h.venue} matched ${n} parsed fixture(s), expected exactly 1`,
      );
  }
  return outcome;
}

// ───────────────────────── Would-be registry ─────────────────────────

/** One registry row per canonical ground name (fixture venues + club grounds), one pitch each
 * (capacity unknown until the union answers), homeClubIds from the club grounds. */
export function wouldBeRegistry(sheets: ParsedTitansSheet[], clubs: Club[]): Venue[] {
  const byKey = new Map<string, Venue>();
  const add = (rawName: string, clubId?: string) => {
    const name = canonicalVenueName(rawName);
    const k = titansGroundKey(name);
    let v = byKey.get(k);
    if (!v) {
      v = { id: venueIdFor(name), name, homeClubIds: [], surfaces: 1 };
      byKey.set(k, v);
    }
    if (clubId && !v.homeClubIds!.includes(clubId)) v.homeClubIds!.push(clubId);
  };
  for (const s of sheets) for (const f of s.fixtures) if (f.venue) add(f.venue);
  for (const c of clubs)
    if (c.ground?.venue && !isTbcVenue(c.ground.venue)) add(c.ground.venue, c.id);
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** CLUB_MAP as skeletal Club records, with `ground.venue` from the structure workbook when given
 * (what the August compliance import wrote to each club). */
export function clubsFromMap(groundByClub: Map<string, string> = new Map()): Club[] {
  return CLUB_MAP.map(
    (c) =>
      ({
        id: c.id,
        name: c.name,
        ground: groundByClub.has(c.id) ? { venue: groundByClub.get(c.id) } : {},
      }) as unknown as Club,
  );
}

// ───────────────────────── Clash scan ─────────────────────────

export type ClashTag = string;

export interface TaggedClash extends Clash {
  seriesId: string;
  seriesName: string;
  /** Time sources of the two fixtures, sorted: `sheet-vs-provisional` etc. */
  tag: ClashTag;
}

function withoutTbc(s: Series): Series {
  return {
    ...s,
    fixtures: (s.fixtures as WrittenFixture[]).filter((f) => f.venueOverride || f.venueName),
  };
}

/**
 * Season-wide clash scan with release-gate semantics (venue-clash.ts `findClashes`, the gate's
 * alias map, registry surfaces as capacity). Each series is checked against the series before
 * it, so every double-booking is reported exactly once. TBC fixtures are excluded unless
 * `includeTbc` (the release-gate preview: the gate places them at the home club's ground).
 */
export function scanTitansClashes(
  built: Series[],
  clubs: Club[],
  venues: Venue[],
  opts: { includeTbc?: boolean } = {},
): TaggedClash[] {
  const sourceOf = new Map<string, TimeSource>();
  for (const s of built)
    for (const f of s.fixtures as TitansFixture[]) sourceOf.set(`${s.id}/${f.id}`, f.timeSource);
  const subjects = opts.includeTbc ? built : built.map(withoutTbc);
  const out: TaggedClash[] = [];
  for (let i = 0; i < subjects.length; i++) {
    const subject = subjects[i];
    for (const c of findClashes(
      subject,
      subjects.slice(0, i),
      clubs,
      venues,
      TITANS_GATE_ALIASES,
    )) {
      const a = sourceOf.get(`${subject.id}/${c.fixtureId}`) ?? 'unknown';
      const b = sourceOf.get(`${c.with.seriesId}/${c.with.fixtureId}`) ?? 'unknown';
      out.push({
        ...c,
        seriesId: String(subject.id),
        seriesName: subject.name,
        tag: [a, b].sort().join('-vs-'),
      });
    }
  }
  return out;
}

/** The built series with their held-back fixtures put back (the "before HELD_BACK" scan). */
function withHeldBack(built: BuiltTitansSeries[]): Series[] {
  return built.map((b) => ({ ...b.series, fixtures: b.allFixtures }) as unknown as Series);
}

// ───────────────────────── Report helpers ─────────────────────────

export interface SharedGroundDay {
  date: string;
  ground: string;
  junior: string[];
  senior: string[];
}

/** Ground-days where a junior fixture on its provisional 08:30 and a senior fixture on its
 * provisional 13:00 share a ground. Not clashes (different start times), but the "junior game
 * is over by 13:00" assumption is the union's to confirm (risk R1). */
export function sharedGroundDays(built: BuiltTitansSeries[]): SharedGroundDay[] {
  const byDay = new Map<string, SharedGroundDay>();
  for (const b of built) {
    const names = new Map((b.series.participants ?? []).map((p) => [p.teamId, p.name]));
    for (const f of b.fixtures) {
      const ground = f.venueOverride || f.venueName;
      if (!ground || f.timeSource !== 'provisional') continue;
      const k = `${f.date}|${titansGroundKey(ground)}`;
      const e = byDay.get(k) ?? { date: f.date, ground, junior: [], senior: [] };
      const label = `${f.time} ${b.series.name}: ${names.get(f.home) ?? f.home} v ${names.get(f.away) ?? f.away}`;
      (b.junior ? e.junior : e.senior).push(label);
      byDay.set(k, e);
    }
  }
  return [...byDay.values()]
    .filter((e) => e.junior.length && e.senior.length)
    .sort((a, b) => a.date.localeCompare(b.date) || a.ground.localeCompare(b.ground));
}

/** Every OTHER ground-day where a fixture on a provisional time shares the ground with a
 * fixture at a different start time (e.g. a sheet-timed veterans game, a T20 session, or two
 * senior leagues on one complex) — the same "does the earlier game finish in time" question,
 * outside the junior-08:30/senior-13:00 pattern. */
export function otherProvisionalOverlapDays(
  built: BuiltTitansSeries[],
): Array<{ date: string; ground: string; entries: string[] }> {
  const junSen = new Set(
    sharedGroundDays(built).map((d) => `${d.date}|${titansGroundKey(d.ground)}`),
  );
  const byDay = new Map<
    string,
    {
      date: string;
      ground: string;
      items: Array<{ time: string; source: TimeSource; label: string }>;
    }
  >();
  for (const b of built) {
    const names = new Map((b.series.participants ?? []).map((p) => [p.teamId, p.name]));
    for (const f of b.fixtures) {
      const ground = f.venueOverride || f.venueName;
      if (!ground) continue;
      const k = `${f.date}|${titansGroundKey(ground)}`;
      const e = byDay.get(k) ?? { date: f.date, ground, items: [] };
      e.items.push({
        time: f.time ?? '',
        source: f.timeSource,
        label: `${f.time} (${f.timeSource}) ${b.series.name}: ${names.get(f.home) ?? f.home} v ${names.get(f.away) ?? f.away}`,
      });
      byDay.set(k, e);
    }
  }
  const out: Array<{ date: string; ground: string; entries: string[] }> = [];
  for (const [k, e] of byDay) {
    if (junSen.has(k)) continue;
    const times = new Set(e.items.map((i) => i.time));
    if (times.size > 1 && e.items.some((i) => i.source === 'provisional'))
      out.push({ date: e.date, ground: e.ground, entries: e.items.map((i) => i.label).sort() });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.ground.localeCompare(b.ground));
}

/** Raw venue spellings that resolved onto a different canonical ground name, with counts. */
export function aliasesApplied(
  sheets: ParsedTitansSheet[],
): Array<{ raw: string; canonical: string; count: number }> {
  const m = new Map<string, { raw: string; canonical: string; count: number }>();
  for (const s of sheets)
    for (const f of s.fixtures) {
      if (!f.venue) continue;
      const raw = cleanVenue(f.rawVenue);
      if (raw === f.venue) continue;
      const e = m.get(raw) ?? { raw, canonical: f.venue, count: 0 };
      e.count++;
      m.set(raw, e);
    }
  return [...m.values()].sort((a, b) => a.raw.localeCompare(b.raw));
}

/** DEFAULT_VENUE_ALIASES (dolphins) keys a titans spelling would hit — expected none. */
export function defaultAliasHits(sheets: ParsedTitansSheet[]): string[] {
  const hits = new Set<string>();
  for (const s of sheets)
    for (const f of s.fixtures)
      if (
        f.venue &&
        Object.prototype.hasOwnProperty.call(DEFAULT_VENUE_ALIASES, normaliseName(f.venue))
      )
        hits.add(f.venue);
  return [...hits];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function clashLine(c: TaggedClash): string {
  return `${c.date} ${c.time ?? ''} ${c.ground}: ${c.seriesName} R${c.round} ${c.home} v ${c.away} ⟷ ${c.with.seriesName ?? c.with.seriesId} R${c.with.round} ${c.with.home} v ${c.with.away} [${c.tag}]`;
}

function tagCounts(clashes: TaggedClash[]): string {
  const m = new Map<string, number>();
  for (const c of clashes) m.set(c.tag, (m.get(c.tag) ?? 0) + 1);
  return [...m].map(([t, n]) => `${t} ×${n}`).join(', ') || 'none';
}

function koLine(k: KoRow): string {
  const slot = (p: KoRow['home']) => `"${p.raw}" → ${p.ref}${p.note ? ` (${p.note})` : ''}`;
  return `${k.koSeriesId} ${k.fixtureId}${k.tag ? ` [${k.tag}]` : ''} row ${k.row}: ${k.date} ${k.time} (${k.timeSource}) ${slot(k.home)} v ${slot(k.away)} @ "${k.rawVenue}"`;
}

// ───────────────────────── Union report ─────────────────────────

export interface UnionReport {
  generatedAt: string;
  today: string;
  workbook: string;
  totals: {
    fixtures: number;
    expected: number;
    written: number;
    heldBack: number;
    byes: number;
    koRows: number;
  };
  sheets: Array<{
    sheet: string;
    series: Array<{ seriesId: string; name: string; parsed: number; expected: number }>;
    byes: number;
    koRows: number;
    banners: string[];
    splitRounds: number;
    timeSources: Record<string, number>;
  }>;
  provisionalTimes: Array<{
    seriesId: string;
    name: string;
    provisional: number;
    time: string;
    total: number;
  }>;
  sharedGroundDays: SharedGroundDay[];
  otherOverlapDays: Array<{ date: string; ground: string; entries: string[] }>;
  heldBack: Array<{
    sheet: string;
    seriesId: string;
    fixtureId: string;
    date: string;
    time: string;
    home: string;
    away: string;
    venue: string | null;
    reason: string;
  }>;
  ambiguousVenues: Array<{
    names: string[];
    question: string;
    inWorkbook: Array<{ name: string; fixtures: number }>;
  }>;
  venueAliasesApplied: Array<{ raw: string; canonical: string; count: number }>;
  venueSpellings: Array<{ name: string; aliases: string[]; note: string }>;
  knockouts: KoRow[];
  splitRounds: Array<{ sheet: string; date: string; rows: number }>;
  tbcVenues: TitansBuildOutcome['tbc'];
  pastFixtures: Array<{
    seriesId: string;
    fixtureId: string;
    date: string;
    time: string;
    home: string;
    away: string;
    venue: string | null;
  }>;
  dateCorrections: string[];
  clashes: {
    beforeHeldBack: TaggedClash[];
    afterHeldBack: TaggedClash[];
    gatePreview: TaggedClash[] | null;
  };
  womensLeagueTeams: Array<{ name: string; clubId: string; clubName: string }>;
  todo: string[];
}

export function renderUnionMarkdown(r: UnionReport): string {
  const L: string[] = [];
  L.push('# Titans 2026-27 fixtures: questions for the union');
  L.push('');
  L.push(
    `Prepared ${r.generatedAt} from "${r.workbook.split('/').pop()}" (36 sheets, ${r.totals.fixtures} fixtures) before the fixtures are loaded onto the Smart Club platform. Nothing has been published.`,
  );
  L.push('');
  L.push('## 1. Start times we had to assume');
  L.push('');
  L.push(
    'Most sheets give no start time. Until you confirm, we have loaded **junior** fixtures (U9–U15 and the Women\'s Junior League) at **08:30** and **senior, women\'s and veterans** fixtures at **13:00**. T20 "AM" games are loaded at 09:00 and "PM" games at 13:30. Fixtures with a time on the sheet keep it.',
  );
  L.push('');
  L.push('| Competition | Fixtures with an assumed time | Assumed time | Total |');
  L.push('|---|---:|---|---:|');
  for (const p of r.provisionalTimes.filter((x) => x.provisional))
    L.push(`| ${p.name} | ${p.provisional} | ${p.time} | ${p.total} |`);
  L.push('');
  L.push('## 2. Junior morning games and senior afternoon games on the same ground');
  L.push('');
  L.push(
    `On **${r.sharedGroundDays.length}** ground-days a junior fixture (assumed 08:30) and a senior fixture (assumed 13:00) are at the same ground. We treat these as fine **only if the junior game is finished before 13:00**. Please confirm, or tell us which days need a different start time or ground.`,
  );
  L.push('');
  for (const d of r.sharedGroundDays) {
    L.push(`- **${d.ground}, ${longDate(d.date)}**`);
    for (const e of [...d.junior, ...d.senior]) L.push(`  - ${e}`);
  }
  L.push('');
  L.push(
    `Separately, on **${r.otherOverlapDays.length}** other ground-days a fixture with an assumed time shares the ground with a fixture at a different start time (a timed veterans or T20 game, or two senior competitions). The same question applies:`,
  );
  L.push('');
  for (const d of r.otherOverlapDays) {
    L.push(`- **${d.ground}, ${longDate(d.date)}**`);
    for (const e of d.entries) L.push(`  - ${e}`);
  }
  L.push('');
  L.push('## 3. Double-bookings we have held back');
  L.push('');
  if (!r.heldBack.length) L.push('None.');
  else {
    L.push(
      'These fixtures share a ground, date and start time with another fixture. We have **not loaded either fixture of each pair**. Please tell us which one moves (and where or when); we will add both once you reply.',
    );
    L.push('');
    L.push('| Competition | Date | Time | Fixture | Ground |');
    L.push('|---|---|---|---|---|');
    for (const h of r.heldBack)
      L.push(
        `| ${h.sheet} | ${longDate(h.date)} | ${h.time} | ${h.home} v ${h.away} | ${h.venue ?? 'TBC'} |`,
      );
  }
  L.push('');
  L.push('## 4. Ground names we were not sure about');
  L.push('');
  L.push(
    'We have kept each of these as a separate ground. Please tell us if any are the same field.',
  );
  L.push('');
  for (const a of r.ambiguousVenues) {
    const used =
      a.inWorkbook.map((u) => `${u.name} (${u.fixtures})`).join(', ') ||
      'not used in this workbook';
    L.push(`- ${a.question} — fixtures: ${used}`);
  }
  L.push('');
  L.push('## 5. Spellings we have treated as the same ground (please confirm)');
  L.push('');
  for (const a of r.venueAliasesApplied)
    L.push(`- "${a.raw}" read as **${a.canonical}** (${a.count} fixture(s))`);
  L.push('');
  L.push('## 6. Knockout fixtures');
  L.push('');
  L.push(
    'These are loaded later as placeholders that fill in as the groups finish. Please check how we have read each slot.',
  );
  L.push('');
  L.push('| Competition | Date | Time | Home slot | Away slot | Ground |');
  L.push('|---|---|---|---|---|---|');
  for (const k of r.knockouts)
    L.push(
      `| ${k.sheet}${k.tag ? ` (${k.tag})` : ''} | ${longDate(k.date)} | ${k.time} | ${k.rawHome} → \`${k.home.ref}\` | ${k.rawAway} → \`${k.away.ref}\` | ${k.rawVenue} |`,
    );
  L.push('');
  L.push("## 7. Women's League Top 6 / Bottom 6 rounds");
  L.push('');
  L.push(
    'The sheet dates these rounds but names no fixtures yet, so nothing is loaded for them. Please send the fixtures once the split is known.',
  );
  L.push('');
  for (const s of r.splitRounds) L.push(`- ${longDate(s.date)}: ${s.rows} fixture row(s)`);
  L.push('');
  L.push('## 8. Fixtures with no ground yet (TBC)');
  L.push('');
  if (!r.tbcVenues.length) L.push('None.');
  else {
    L.push(
      "These are loaded without a ground. When a fixture is published without a ground, the platform places it at the home club's ground, so please send the ground for each.",
    );
    L.push('');
    for (const t of r.tbcVenues)
      L.push(`- ${t.seriesId}: ${longDate(t.date)} ${t.time} ${t.home} v ${t.away}`);
    const gate = r.clashes.gatePreview ?? [];
    if (gate.length) {
      L.push('');
      L.push(
        `At the home club's ground, **${gate.length}** of them would clash with another fixture at the same start time:`,
      );
      L.push('');
      for (const c of gate)
        L.push(
          `- ${c.ground}, ${longDate(c.date)} ${c.time ?? ''}: ${c.seriesName} ${c.home} v ${c.away} and ${c.with.seriesName ?? c.with.seriesId} ${c.with.home} v ${c.with.away}`,
        );
    }
  }
  L.push('');
  L.push(`## 9. Fixtures dated before ${longDate(r.today)}`);
  L.push('');
  L.push(
    `**${r.pastFixtures.length}** fixtures are dated in the past. They will be loaded as unreleased drafts; nothing is sent to clubs for them. Please send results if you want them recorded.`,
  );
  L.push('');
  for (const p of r.pastFixtures)
    L.push(
      `- ${p.seriesId}: ${longDate(p.date)} ${p.time} ${p.home} v ${p.away} @ ${p.venue ?? 'TBC'}`,
    );
  L.push('');
  L.push('## 10. Dates we corrected');
  L.push('');
  if (!r.dateCorrections.length) L.push('None.');
  else for (const d of r.dateCorrections) L.push(`- ${d}`);
  L.push('');
  return L.join('\n');
}

// ───────────────────────── CLI ─────────────────────────

export interface Args {
  file: string;
  structure: string;
  parseOnly: boolean;
  reportOut: string;
  today: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    ...DEFAULT_PATHS,
    parseOnly: false,
    reportOut: '',
    today: new Date().toISOString().slice(0, 10),
  };
  const need = (i: number, flag: string) => {
    const v = argv[i];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = need(++i, a);
    else if (a === '--structure') args.structure = need(++i, a);
    else if (a === '--report-out') args.reportOut = need(++i, a);
    else if (a === '--today') args.today = need(++i, a);
    else if (a === '--parse-only') args.parseOnly = true;
    else if (['--confirm', '--revert', '--only', '--all', '--no-club-sync'].includes(a))
      throw new Error(
        `${a} is not implemented in A0 — only --parse-only runs (the write path lands in A3)`,
      );
    else throw new Error(`unknown flag ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.today)) throw new Error('--today needs YYYY-MM-DD');
  if (!args.parseOnly)
    throw new Error(
      'not implemented in A0: the tenant dry-run and --confirm write path land in A3 — run with --parse-only',
    );
  return args;
}

async function readWb(path: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

async function structureGrounds(path: string): Promise<Map<string, string> | null> {
  if (!existsSync(path)) return null;
  const summary = summarizeByClub(parseStructureWorkbook(await readWb(path)));
  const out = new Map<string, string>();
  for (const s of summary.values()) if (s.firstTeamVenue) out.set(s.club.id, s.firstTeamVenue);
  return out;
}

function printClashes(title: string, clashes: TaggedClash[]) {
  console.log(`\n── ${title}`);
  if (!clashes.length) {
    console.log('  ✓ no clashes');
    return;
  }
  console.log(`  ✗ ${clashes.length} clash(es) — ${tagCounts(clashes)}`);
  for (const c of clashes) console.log(`    ${clashLine(c)}`);
}

async function runParseOnly(args: Args) {
  const { sheets, errors } = parseTitansWorkbook(await readWb(args.file));
  console.log(`Titans fixtures workbook: ${args.file}`);
  console.log('\n── Per-sheet counts (parsed / expected)');
  let total = 0;
  let byes = 0;
  let koRows = 0;
  for (const s of sheets) {
    for (const spec of s.spec.series) {
      const n = s.fixtures.filter((f) => f.seriesId === spec.seriesId).length;
      total += n;
      console.log(
        `  ${n === spec.expected ? '✓' : '✗'} ${s.spec.sheet.padEnd(26)} → ${spec.seriesId.padEnd(40)} ${String(n).padStart(3)}/${spec.expected}`,
      );
    }
    byes += s.byes.length;
    koRows += s.ko.length;
    const extras = [
      s.byes.length ? `${s.byes.length} BYE` : '',
      s.ko.length ? `${s.ko.length} KO row(s)` : '',
      s.splitRounds.length ? `${s.splitRounds.length} Top6/Bottom6 row(s)` : '',
      s.banners.length ? `banners: ${s.banners.map((b) => `"${b.text}"`).join(', ')}` : '',
      s.timeRows.length
        ? `time row(s): ${s.timeRows.map((t) => `row ${t.row} ${t.time} → row ${t.appliedTo}`).join(', ')}`
        : '',
    ].filter(Boolean);
    if (extras.length) console.log(`      ${extras.join(' · ')}`);
    for (const d of s.dateCorrections) console.log(`      ⚠ date corrected: ${d}`);
    for (const i of s.sideInferences)
      console.log(`      ⚠ un-numbered "${i.from}" read as "${i.to}"`);
    for (const w of s.warnings) console.log(`      ⚠ ${w}`);
  }
  console.log(
    `  total: ${total} fixtures (expected ${EXPECTED_TOTAL_FIXTURES}), ${byes} BYE rows skipped, ${koRows} KO rows`,
  );
  const inferences = sheets.flatMap((s) => s.sideInferences);
  console.log(`  un-numbered side inferences: ${inferences.length}`);

  if (errors.length) {
    console.error(`\n✗ Refusing to continue — ${errors.length} parse problem(s):`);
    for (const e of errors) console.error(`   ${e}`);
    process.exitCode = 1;
    return;
  }

  // ── Would-be registry + clubs ──
  const grounds = await structureGrounds(args.structure);
  const clubs = clubsFromMap(grounds ?? new Map());
  const venues = wouldBeRegistry(sheets, clubs);
  console.log(
    `\nWould-be venue registry: ${venues.length} ground(s), one pitch each` +
      (grounds
        ? `; club grounds from ${args.structure} (${grounds.size} club(s))`
        : `; ⚠ structure workbook not found (${args.structure}) — TBC fixtures cannot be placed at a club ground`),
  );

  // ── Build ──
  const outcome = buildTitansSeries(sheets, venues);
  console.log(`\n── Name resolution (${outcome.resolutions.size} league side(s))`);
  const byClub = new Map<string, Set<string>>();
  for (const r of outcome.resolutions.values())
    byClub.set(r.clubName, (byClub.get(r.clubName) ?? new Set()).add(r.name));
  for (const [club, names] of [...byClub].sort((a, b) => a[0].localeCompare(b[0])))
    console.log(`  ${club}: ${[...names].sort().join(', ')}`);
  console.log(
    outcome.unresolvedNames.length
      ? `  ✗ ${outcome.unresolvedNames.length} unresolved name(s): ${outcome.unresolvedNames.join('; ')}`
      : '  ✓ unresolved names: 0',
  );

  // ── Venues ──
  const applied = aliasesApplied(sheets);
  console.log(`\n── Venue spellings merged (misspellings only): ${applied.length}`);
  for (const a of applied) console.log(`    "${a.raw}" → ${a.canonical} ×${a.count}`);
  const defaultHits = defaultAliasHits(sheets);
  if (defaultHits.length)
    console.log(`  ⚠ dolphins default aliases would rewrite: ${defaultHits.join(', ')}`);
  const venueUse = new Map<string, number>();
  for (const s of sheets)
    for (const f of s.fixtures)
      if (f.venue) venueUse.set(f.venue, (venueUse.get(f.venue) ?? 0) + 1);
  const ambiguous = AMBIGUOUS_VENUES.map((a) => ({
    ...a,
    inWorkbook: a.names
      .filter((n) => venueUse.has(canonicalVenueName(n)))
      .map((n) => ({
        name: canonicalVenueName(n),
        fixtures: venueUse.get(canonicalVenueName(n))!,
      })),
  }));
  console.log(`\n── Ambiguous venues (kept separate, listed for the union): ${ambiguous.length}`);
  for (const a of ambiguous)
    console.log(
      `    ${a.names.join(' / ')} — in workbook: ${a.inWorkbook.map((u) => `${u.name} ×${u.fixtures}`).join(', ') || 'none'}`,
    );
  if (outcome.tbc.length) {
    console.log(
      `\n── TBC venues (${outcome.tbc.length}) — excluded from the strict scan, placed at the club ground in the gate preview`,
    );
    for (const t of outcome.tbc)
      console.log(`    ${t.seriesId} ${t.fixtureId}: ${t.date} ${t.time} ${t.home} v ${t.away}`);
  }

  // ── Held back ──
  console.log(`\n── Held back (${outcome.held.length}) — parsed, never written`);
  for (const h of outcome.held)
    console.log(
      `    ${h.seriesId} ${h.fixtureId}: ${h.raw.date} ${h.raw.time} (${h.raw.timeSource}) ${h.raw.home} v ${h.raw.away} @ ${h.raw.venue}`,
    );
  for (const p of outcome.heldProblems) console.log(`    ✗ ${p}`);

  // ── Knockouts ──
  const ko = sheets.flatMap((s) => s.ko);
  console.log(`\n── Knockout rows (${ko.length}) — proposed slot refs, not written in A0`);
  for (const k of ko) console.log(`    ${koLine(k)}`);
  const splitRounds = sheets.flatMap((s) =>
    [...new Set(s.splitRounds.map((x) => x.date))].map((date) => ({
      sheet: s.spec.sheet,
      date,
      rows: s.splitRounds.filter((x) => x.date === date).length,
    })),
  );
  console.log(
    `\n── Skipped split rounds (Women's League Top 6 / Bottom 6): ${splitRounds.length} date(s)`,
  );
  for (const s of splitRounds) console.log(`    ${s.sheet} ${s.date}: ${s.rows} row(s)`);

  // ── Clash scan ──
  const builtSeries = outcome.built.map((b) => b.series);
  const before = scanTitansClashes(withHeldBack(outcome.built), clubs, venues);
  const after = scanTitansClashes(builtSeries, clubs, venues);
  const gatePreview = grounds
    ? scanTitansClashes(builtSeries, clubs, venues, { includeTbc: true })
    : null;
  printClashes(
    'CLASH SCAN before HELD_BACK (would-be registry, 1 pitch each, TBC excluded)',
    before,
  );
  printClashes('CLASH SCAN after HELD_BACK (residual — the gate)', after);
  if (gatePreview)
    printClashes(
      'Release-gate preview after HELD_BACK — TBC fixtures at the home club ground (NON-blocking for drafts; give them a venue before release)',
      gatePreview,
    );

  // ── Shared ground-days / provisional times / past fixtures ──
  const shared = sharedGroundDays(outcome.built);
  console.log(
    `\n── Shared ground-days, junior 08:30 + senior 13:00 (both provisional): ${shared.length} — union report`,
  );
  const otherOverlap = otherProvisionalOverlapDays(outcome.built);
  console.log(
    `── Other ground-days where a provisional time shares the ground with a different start time: ${otherOverlap.length}`,
  );
  const provisionalTimes = outcome.built.map((b) => ({
    seriesId: String(b.series.id),
    name: b.series.name,
    provisional: b.fixtures.filter((f) => f.timeSource === 'provisional').length,
    time: b.junior ? '08:30' : '13:00',
    total: b.fixtures.length,
  }));
  const sourceTotals = new Map<string, number>();
  for (const b of outcome.built)
    for (const f of b.fixtures)
      sourceTotals.set(f.timeSource, (sourceTotals.get(f.timeSource) ?? 0) + 1);
  console.log(
    `── Time sources (written fixtures): ${[...sourceTotals].map(([s, n]) => `${s} ${n}`).join(', ')}`,
  );
  const pastFixtures = outcome.built.flatMap((b) => {
    const names = new Map((b.series.participants ?? []).map((p) => [p.teamId, p.name]));
    return b.fixtures
      .filter((f) => f.date < args.today)
      .map((f) => ({
        seriesId: String(b.series.id),
        fixtureId: f.id,
        date: f.date,
        time: f.time ?? '',
        home: names.get(f.home) ?? f.home,
        away: names.get(f.away) ?? f.away,
        venue: f.venueName ?? null,
      }));
  });
  console.log(`── Fixtures dated before ${args.today}: ${pastFixtures.length}`);
  const pastBySeries = new Map<string, number>();
  for (const p of pastFixtures)
    pastBySeries.set(p.seriesId, (pastBySeries.get(p.seriesId) ?? 0) + 1);
  for (const [s, n] of pastBySeries) console.log(`    ${s}: ${n}`);

  // ── Women's League placement ──
  const womens = [...outcome.resolutions.values()]
    .filter((r) => r.leagueKey === 'womens-premier-league')
    .map((r) => ({ name: r.name, clubId: r.clubId, clubName: r.clubName }))
    .sort((a, b) => a.name.localeCompare(b.name));
  console.log(`\n── WOMENS LEAGUE teams (${womens.length}) → womens-premier-league`);
  for (const w of womens) console.log(`    ${w.name} → ${w.clubName}`);
  const todo = [
    "Women's placement: check each WOMENS LEAGUE club's live premier/promotion women's roster before any write (risk R6) — needs the tenant read in the dry-run step.",
  ];
  for (const t of todo) console.log(`  TODO (later step): ${t}`);

  const dateCorrections = sheets.flatMap((s) => s.dateCorrections);
  if (args.reportOut) {
    const report: UnionReport = {
      generatedAt: new Date().toISOString().slice(0, 10),
      today: args.today,
      workbook: args.file,
      totals: {
        fixtures: total,
        expected: EXPECTED_TOTAL_FIXTURES,
        written: outcome.built.reduce((n, b) => n + b.fixtures.length, 0),
        heldBack: outcome.held.length,
        byes,
        koRows,
      },
      sheets: sheets.map((s) => {
        const ts: Record<string, number> = {};
        for (const f of s.fixtures) ts[f.timeSource] = (ts[f.timeSource] ?? 0) + 1;
        return {
          sheet: s.spec.sheet,
          series: s.spec.series.map((x) => ({
            seriesId: x.seriesId,
            name: x.seriesName,
            parsed: s.fixtures.filter((f) => f.seriesId === x.seriesId).length,
            expected: x.expected,
          })),
          byes: s.byes.length,
          koRows: s.ko.length,
          banners: s.banners.map((b) => b.text),
          splitRounds: s.splitRounds.length,
          timeSources: ts,
        };
      }),
      provisionalTimes,
      sharedGroundDays: shared,
      otherOverlapDays: otherOverlap,
      heldBack: outcome.held.map((h) => ({
        sheet: h.entry.sheet,
        seriesId: h.seriesId,
        fixtureId: h.fixtureId,
        date: h.raw.date,
        time: h.raw.time,
        home: h.raw.home,
        away: h.raw.away,
        venue: h.raw.venue,
        reason: h.entry.reason,
      })),
      ambiguousVenues: ambiguous,
      venueAliasesApplied: applied,
      venueSpellings: TITANS_VENUE_SPELLINGS,
      knockouts: ko,
      splitRounds,
      tbcVenues: outcome.tbc,
      pastFixtures,
      dateCorrections,
      clashes: { beforeHeldBack: before, afterHeldBack: after, gatePreview },
      womensLeagueTeams: womens,
      todo,
    };
    const base = args.reportOut.replace(/\.(md|json)$/i, '');
    await writeFile(`${base}.json`, JSON.stringify(report, null, 2));
    await writeFile(`${base}.md`, renderUnionMarkdown(report));
    console.log(`\nUnion report written: ${base}.md + ${base}.json`);
  }

  // ── Gate ──
  const fatal: string[] = [];
  for (const n of outcome.unresolvedNames) fatal.push(`unresolved team name ${n}`);
  fatal.push(...outcome.heldProblems);
  if (after.length)
    fatal.push(
      `${after.length} residual venue clash(es) after HELD_BACK — no --allow-clashes exists`,
    );
  if (fatal.length) {
    console.error(`\n✗ Gate FAILED — ${fatal.length} blocker(s):`);
    for (const f of fatal) console.error(`   ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log('\n[parse-only] gate clean — nothing touched AWS.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  return runParseOnly(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}

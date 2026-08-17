/**
 * Plan B fixture import — load the union's hand-built fixture spreadsheets into a
 * tenant's Series rows, reversibly.
 *
 *   npx sst shell --stage prod -- npx tsx src/import-planb-fixtures.ts \
 *     --file "<Dolphins xlsx>" --t20 "<REVISED xlsx>" --parse-only        # parse only, no repo/DynamoDB touched
 *   … --file "<Dolphins xlsx>" --t20 "<REVISED xlsx>"                     # dry-run (resolves clubs, allocates venues)
 *   … --file "<Dolphins xlsx>" --t20 "<REVISED xlsx>" --confirm           # write
 *   … --prune                                                             # dry-run: list superseded series to delete
 *   … --prune --confirm                                                   # delete them (run AFTER replacements are released)
 *   … --revert                                                            # dry-run revert (keep-list excluded)
 *   … --revert --confirm                                                  # delete every imported series except the keep-list
 *   … --revert --all --confirm                                            # delete EVERYTHING including the keep-list
 *
 * WHY THIS EXISTS — the structured season machinery (ADR 0008) can generate all of
 * these fixtures, but the union supplied a finished schedule before there was time to
 * configure and test the structures on prod. This script loads that schedule as plain
 * Series rows so clubs see real fixtures now, while keeping the door open: every series
 * it writes has a deterministic `s-planb-*` id, so `--revert` removes exactly the
 * imported set and the season machinery can take over cleanly.
 *
 * TWO WORKBOOKS — the union sent a whole-season sheet (Dolphins file: every league,
 * with start times, no venues) and a separate Men's T20 sheet with exact per-fixture
 * venues (REVISED file). Men's Promotion T20 comes ENTIRELY from the REVISED file;
 * Men's Premier T20 keeps its matchups/dates/times from the Dolphins file and only
 * borrows venues from the REVISED file (matched by unordered team pair); everything
 * else is Dolphins-only and gets a venue from the allocation rules (home club's ground,
 * re-based where barred, from the REVISED file's Venue Allocations sheet).
 *
 * Fail-closed by design: a team name that doesn't resolve to a club, a section the
 * manifest doesn't recognise (0 fixtures parsed), a duplicate or asymmetric Premier T20
 * pair between the two files, a barred ground with no allocation, or an unresolved
 * season-wide venue clash all abort the write — a confidently wrong fixture list on
 * prod is worse than an incomplete one. Overwritten series keep their approved/released
 * state; brand-new series land as drafts, so the normal governance flow (admin approves
 * + releases from the console) is what puts them in front of clubs.
 */
import ExcelJS from 'exceljs';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Series, Venue, VenueStatus, Club } from './types.js';

type SeriesParticipant = NonNullable<Series['participants']>[number];
type RepoModule = typeof import('./repo.js');

const TENANT = 'dolphins';
const ID_PREFIX = 's-planb-';
/** Any fixture dated before this in Jan–Jun is a "26" typo for "27" — the season's
 * second half. Corrected with a printed report rather than imported as history. */
const SEASON_START = '2026-08-01';

/** Series this run never touches — Promotion 50-Over runs alongside the new T20
 * manifest and isn't part of either workbook. `--revert` excludes these by default. */
const KEEP_LIST = ['promotion-men-50ov-g1', 'promotion-men-50ov-g2'];

/** The exact set of series the OLD manifest wrote that the NEW one no longer produces
 * (T20 top6/bottom6 → numbered groups; T20 top4/bottom4 → groups + a real 30-over
 * split). Hard-coded and asserted against the computed stale set below — a regex drift
 * must never silently turn an intended DELETE into something else. */
const DELETE_SLUGS = [
  'premier-men-t20-top6',
  'premier-men-t20-bottom6',
  'premier-women-t20-top4',
  'premier-women-t20-bottom4',
];

// ───────────────────────── Name resolution ─────────────────────────

/** Sheet names that collapse to different clubs than plain normalisation reaches. */
const NAME_ALIASES: Record<string, string> = {
  chatsworthsporting: 'hollywoodbets-chatsworth-sporting',
  simplex: 'simplex-reservoir-hills-crimson',
  dut: 'durban-university-of-technology-dut',
  meadowridge: 'meadowridge-sporting-cricket-club',
  rhythmdhs: 'rhythm-dhsob-cricket-club',
};

/** Sheet TYPOS/variants that collapse to a DIFFERENT normal-form before the
 * byNorm/alias lookup runs. Kept separate from NAME_ALIASES (which maps straight to a
 * prod club id) so this script never hardcodes an unverifiable club id — the redirect
 * just corrects the spelling and lets the normal lookup do the rest. */
const NAME_REDIRECTS: Record<string, string> = {
  chatsworthhunited: 'chatsworthunited', // "Chatsworthh United" (double h)
  umazi: 'umlazi', // "Umazi A" typo for "Umlazi A"
  ilemebe: 'ilembe', // "ilemebe" typo
  illembe: 'ilembe', // "Illembe" (REVISED file) — same club as "ilembe"/"iLembe"
  // REVISED file spells out sponsor/suburb-qualified Premier names the Dolphins file
  // gives short ("Harlequins", "Crusaders", "Rhythm DHS") — collapse onto the same form
  // so the Premier T20 pair-map matches across both files.
  harlequinsdbn: 'harlequins', // "Harlequins CC DBN 1st XI"
  hollywoodbetscrusaders: 'crusaders', // "Hollywoodbets Crusaders 1st XI"
  rhythmdhsob: 'rhythmdhs', // "RHYTHM DHSOB 1st XI"
  // Prod has exactly one saints-like club (Saints Cricket Club); the T20/veterans
  // sheets call it "Silver Saints". Confirmed against the prod club list on the
  // 16 Aug 2026 dry run — union to give the final nod before --confirm.
  silversaints: 'saints',
  simplexrhcc: 'simplex', // "Simplex RHCC" (REVISED) = Simplex Reservoir Hills CC
  // The sheets' "FAM" is prod's fam-kwamakhutha (ground "Harlequins", Cato Manor 1) —
  // surfaced by the 16 Aug venue-registry sync, after an earlier run had already
  // created a skeletal fam-cricket-club; the bootstrap script erases that duplicate.
  fam: 'famkwamakhutha',
};

/** Ground naming (aliases, normal forms, ledger) is shared with the API's release
 * gate — one source of truth in venue-clash.ts. Re-exported here because the tests
 * and bootstrap-fixture-prereqs import them from this module. Ground aliasing is
 * deliberately a SEPARATE namespace from club resolution: "Ilembe" is both a club
 * and a barred GROUND name, and the two must never be looked up in the same map. */
import { normaliseName, groundKey, GroundLedger, JUNK_GROUND } from './venue-clash.js';
export { groundKey, GroundLedger };

/** Lowercase, strip punctuation, drop generic suffix/roster words. Keeps distinguishing
 * words ("sporting", "united") — Chatsworth Sporting must not collide with Chatsworth
 * United, and Spartan Sporting must stay distinct. '1st'/'2nd'/'xi' let the REVISED
 * file's "Amanzimtoti CC 1st XI" collapse onto the Dolphins file's "Amanzimtoti".
 * (The shared implementation — identical rules apply to clubs and grounds.) */
export const normalise = normaliseName;

/** Ground names don't carry club-only stopwords, so reusing `normalise` verbatim is
 * safe — kept as a separate name so the two namespaces (clubs vs. grounds) are never
 * confused at a call site. */
const normaliseGround = normalise;

export function redirectedNormalise(name: string): string {
  const n = normalise(name);
  return NAME_REDIRECTS[n] ?? n;
}

function buildClubIndex(clubs: Club[]): Map<string, Club> {
  const byNorm = new Map<string, Club>();
  for (const c of clubs) {
    byNorm.set(normalise(c.name), c);
    byNorm.set(normalise(c.id), c);
  }
  return byNorm;
}

function resolveClub(name: string, clubs: Club[], byNorm: Map<string, Club>): Club | undefined {
  const n = redirectedNormalise(name);
  const aliased = NAME_ALIASES[n];
  if (aliased) return clubs.find((c) => c.id === aliased);
  return byNorm.get(n);
}

/** Reserved teamId namespace for synthesised multi-team sides — mirrors
 * `clubTeamsForLeague`'s deterministic pattern (src/leagues.ts:93-94) so a club that
 * later gets a real roster in the admin console converges onto the SAME ids. */
const TEAM_ID_PREFIX = 'tm_';

/** "Simplex A/B/C", "Rhythm DHS B/C", "Meadowridge A/B", "Umlazi A/B" — a trailing
 * A/B/C on a name miss means a multi-team club side, not a fresh club. */
function stripLetterSuffix(name: string): { base: string; letter: string } | null {
  const m = name.trim().match(/^(.*\S)\s+([A-C])$/);
  return m ? { base: m[1], letter: m[2] } : null;
}

/** Tracks, per league, which clubs appeared as a plain (unsuffixed) team and which
 * appeared as a lettered side — printed as a warning for any club in both sets (the
 * suffixed/unsuffixed mixing check runs per LEAGUE, not per section). */
interface SuffixUsage {
  suffixed: Set<string>;
  unsuffixed: Set<string>;
}

/** One row of the name-resolution sign-off table: what the sheet called a team, and
 * what it resolved to. `teamId` is only shown separately from `clubId` when it's a
 * synthesised multi-team id — the operator reviews every alias/redirect outcome here
 * before `--confirm`. Keyed `leagueKey::rawName`, deduplicated across fixtures. */
interface ResolutionEntry {
  raw: string;
  leagueKey: string;
  clubName: string;
  clubId: string;
  teamId: string;
}
type ResolutionLog = Map<string, ResolutionEntry>;

function recordResolution(
  log: ResolutionLog,
  leagueKey: string,
  raw: string,
  club: Club,
  teamId: string,
) {
  const key = `${leagueKey}::${raw}`;
  if (log.has(key)) return;
  log.set(key, { raw, leagueKey, clubName: club.name, clubId: club.id, teamId });
}

function resolveParticipant(
  rawName: string,
  leagueKey: string,
  clubs: Club[],
  byNorm: Map<string, Club>,
  usage: SuffixUsage,
  resolutions: ResolutionLog,
): SeriesParticipant | undefined {
  const direct = resolveClub(rawName, clubs, byNorm);
  if (direct) {
    usage.unsuffixed.add(`${leagueKey}::${direct.id}`);
    recordResolution(resolutions, leagueKey, rawName, direct, direct.id);
    const g = direct.ground ?? {};
    return {
      teamId: direct.id,
      clubId: direct.id,
      name: direct.name,
      ...(g.venue ? { venue: g.venue } : {}),
      ...(Number.isFinite(g.lat) ? { lat: g.lat as number } : {}),
      ...(Number.isFinite(g.lon) ? { lon: g.lon as number } : {}),
    };
  }
  const suffix = stripLetterSuffix(rawName);
  if (!suffix) return undefined;
  const club = resolveClub(suffix.base, clubs, byNorm);
  if (!club) return undefined;
  usage.suffixed.add(`${leagueKey}::${club.id}`);
  const index = suffix.letter.charCodeAt(0) - 'A'.charCodeAt(0);
  const teamId = `${TEAM_ID_PREFIX}${club.id}_${leagueKey}_${index}`;
  recordResolution(resolutions, leagueKey, rawName, club, teamId);
  const g = club.ground ?? {};
  return {
    teamId,
    clubId: club.id,
    name: `${club.name} ${suffix.letter}`,
    ...(g.venue ? { venue: g.venue } : {}),
    ...(Number.isFinite(g.lat) ? { lat: g.lat as number } : {}),
    ...(Number.isFinite(g.lon) ? { lon: g.lon as number } : {}),
  };
}

function reportSuffixMixing(usage: SuffixUsage): string[] {
  const notes: string[] = [];
  for (const key of usage.suffixed) {
    if (usage.unsuffixed.has(key)) {
      const [leagueKey, clubId] = key.split('::');
      notes.push(
        `${clubId} appears both as a plain team and a lettered side in league "${leagueKey}"`,
      );
    }
  }
  return notes;
}

// ───────────────────────── Cell helpers ─────────────────────────

/** exceljs hands back a real Date for a date cell (UTC midnight) or a 1899-epoch Date
 * for a time-only cell (Excel serialises both from "days since 1899-12-30", and a bare
 * time is < 1 day ⇒ lands on 1899-12-30). The year guard is how the two are told apart
 * — get it backwards and every date row stamps 00:00 as the running time. */
export function isoDate(v: unknown): string | null {
  if (v instanceof Date) {
    if (v.getUTCFullYear() < 1970) return null; // a time cell, not a date
    return v.toISOString().slice(0, 10);
  }
  // The sheet's week dates are mostly FORMULAS ("=E2+7"); exceljs wraps those as
  // { formula, result } — the date we want is the result.
  if (v && typeof v === 'object' && 'result' in (v as object))
    return isoDate((v as { result: unknown }).result);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) return v.trim().slice(0, 10);
  // Raw excel date serial (days since 1899-12-30), in case a cell lost its date format.
  if (typeof v === 'number' && v > 40000 && v < 60000) {
    const ms = Date.UTC(1899, 11, 30) + v * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}

/** Mirror guard of isoDate: a time cell is a 1899-epoch Date, a fraction-of-day number,
 * or (REVISED file) a plain "HH:MM" text cell. */
export function isoTime(v: unknown): string | null {
  if (v instanceof Date) {
    if (v.getUTCFullYear() >= 1970) return null; // a date cell, not a time
    return `${String(v.getUTCHours()).padStart(2, '0')}:${String(v.getUTCMinutes()).padStart(2, '0')}`;
  }
  if (v && typeof v === 'object' && 'result' in (v as object))
    return isoTime((v as { result: unknown }).result);
  if (typeof v === 'number' && v > 0 && v < 1) {
    const totalMinutes = Math.round(v * 24 * 60);
    return `${String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
  }
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  }
  return null;
}

function cellText(v: unknown): string {
  if (v == null || v instanceof Date) return '';
  if (typeof v === 'object' && 'richText' in (v as object))
    return (v as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join('');
  return String(v).trim();
}

// ───────────────────────── Dolphins workbook (section-scan) parser ─────────────────────────

/** Shared shape for the Series this script writes — used both for the Dolphins-file
 * sections and the REVISED-file Group 1-4 promotion sections. */
interface SeriesSpec {
  slug: string;
  label: string;
  leagueKey: string;
  seriesType: string;
  maxOvers: number;
  /** Verified fixture count for this section — mismatches are printed loudly. */
  expected: number;
}

interface SectionSpec extends SeriesSpec {
  /** Matches the section-header cell, case-insensitive. */
  match: RegExp;
}

/** One entry per section header, keyed by the sheet's TRIMMED name (several sheet
 * names carry trailing spaces). Regexes tolerate the doubled/trailing internal spaces
 * seen in the real workbook. */
const SECTIONS: Record<string, SectionSpec[]> = {
  'Premier Men': [
    {
      match: /^t20\s+premier\s+men\s+1$/i,
      slug: 'premier-men-t20-1',
      label: 'T20 · Group 1',
      leagueKey: 'premier',
      seriesType: 'Twenty20 (16-25 overs)',
      maxOvers: 20,
      expected: 15,
    },
    {
      match: /^t20\s+premier\s+men\s+2$/i,
      slug: 'premier-men-t20-2',
      label: 'T20 · Group 2',
      leagueKey: 'premier',
      seriesType: 'Twenty20 (16-25 overs)',
      maxOvers: 20,
      expected: 15,
    },
    {
      match: /^50\s+over\s+top\s+6$/i,
      slug: 'premier-men-50ov-top6',
      label: '50 Over · Top 6',
      leagueKey: 'premier',
      seriesType: 'One-Day (40-50 overs)',
      maxOvers: 50,
      expected: 30,
    },
    {
      match: /^50\s+over\s+bottom\s+6$/i,
      slug: 'premier-men-50ov-bottom6',
      label: '50 Over · Bottom 6',
      leagueKey: 'premier',
      seriesType: 'One-Day (40-50 overs)',
      maxOvers: 50,
      expected: 30,
    },
  ],
  'Promotion Men': [
    {
      match: /^30\s+over\s+promotion\s+top\s+10$/i,
      slug: 'promotion-men-30ov-top10',
      label: '30 Over · Top 10',
      leagueKey: 'promotion',
      seriesType: 'One-Day (40-50 overs)',
      maxOvers: 30,
      expected: 45,
    },
    {
      match: /^30\s+over\s+promotion\s+bottom\s+10$/i,
      slug: 'promotion-men-30ov-bottom10',
      label: '30 Over · Bottom 10',
      leagueKey: 'promotion',
      seriesType: 'One-Day (40-50 overs)',
      maxOvers: 30,
      expected: 45,
    },
  ],
  'Premier Women': [
    {
      match: /^t20\s+premier\s+women\s+group\s+1$/i,
      slug: 'premier-women-t20-g1',
      label: 'T20 · Group 1',
      leagueKey: 'premierWomen',
      seriesType: 'Twenty20 (16-25 overs)',
      maxOvers: 20,
      expected: 5,
    },
    {
      match: /^t20\s+womens\s+premier\s+women\s+group\s+2$/i,
      slug: 'premier-women-t20-g2',
      label: 'T20 · Group 2',
      leagueKey: 'premierWomen',
      seriesType: 'Twenty20 (16-25 overs)',
      maxOvers: 20,
      expected: 5,
    },
    {
      match: /^30\s+over\s+top\s+4$/i,
      slug: 'premier-women-30ov-top4',
      label: '30 Over · Top 4',
      leagueKey: 'premierWomen',
      seriesType: 'One-Day (40-50 overs)',
      maxOvers: 30,
      expected: 10,
    },
    {
      match: /^30\s+over\s+bottom\s+4$/i,
      slug: 'premier-women-30ov-bottom4',
      label: '30 Over · Bottom 4',
      leagueKey: 'premierWomen',
      seriesType: 'One-Day (40-50 overs)',
      maxOvers: 30,
      expected: 10,
    },
  ],
  'Promotion Women': [
    {
      match: /group\s+a$/i,
      slug: 'promotion-women-t20-ga',
      label: 'T20 · Group A',
      leagueKey: 'promotion-women-s-league',
      seriesType: 'Twenty20 (16-25 overs)',
      maxOvers: 20,
      expected: 12,
    },
    {
      match: /group\s+b$/i,
      slug: 'promotion-women-t20-gb',
      label: 'T20 · Group B',
      leagueKey: 'promotion-women-s-league',
      seriesType: 'Twenty20 (16-25 overs)',
      maxOvers: 20,
      expected: 12,
    },
    {
      match: /group\s+c$/i,
      slug: 'promotion-women-t20-gc',
      label: 'T20 · Group C',
      leagueKey: 'promotion-women-s-league',
      seriesType: 'Twenty20 (16-25 overs)',
      maxOvers: 20,
      expected: 12,
    },
  ],
  'Veterans Premier': [
    {
      match: /^veterans\s+premier\s+t20\s+1$/i,
      slug: 'veterans-premier-t20-1',
      label: 'T20 · Group 1',
      leagueKey: 'veterans-premier',
      seriesType: 'Twenty20 (16-25 overs)',
      maxOvers: 20,
      expected: 15,
    },
    {
      match: /^veterans\s+premier\s+t20\s+2$/i,
      slug: 'veterans-premier-t20-2',
      label: 'T20 · Group 2',
      leagueKey: 'veterans-premier',
      seriesType: 'Twenty20 (16-25 overs)',
      maxOvers: 20,
      expected: 15,
    },
    {
      match: /^30\s+over\s+veterans\s+premier\s+league$/i,
      slug: 'veterans-premier-30ov',
      label: '30 Over',
      leagueKey: 'veterans-premier',
      seriesType: 'One-Day (40-50 overs)',
      maxOvers: 30,
      expected: 66,
    },
  ],
  'Veterans Promotion': [
    {
      match: /^veterans\s+promotion\s+t20\s+1$/i,
      slug: 'veterans-promotion-t20-1',
      label: 'T20 · Group 1',
      leagueKey: 'veterans-promotion',
      seriesType: 'Twenty20 (16-25 overs)',
      maxOvers: 20,
      expected: 21,
    },
    {
      match: /^veterans\s+promotion\s+t20\s+2$/i,
      slug: 'veterans-promotion-t20-2',
      label: 'T20 · Group 2',
      leagueKey: 'veterans-promotion',
      seriesType: 'Twenty20 (16-25 overs)',
      maxOvers: 20,
      expected: 28,
    },
    {
      match: /^veterans\s+promotion\s+30\s+over$/i,
      slug: 'veterans-promotion-30ov',
      label: '30 Over',
      leagueKey: 'veterans-promotion',
      seriesType: 'One-Day (40-50 overs)',
      maxOvers: 30,
      expected: 105,
    },
  ],
};

interface ParsedFixture {
  round: number;
  date: string;
  time?: string;
  homeName: string;
  awayName: string;
}
interface ParsedSection {
  spec: SectionSpec;
  fixtures: ParsedFixture[];
  skippedRows: string[];
  dateCorrections: string[];
}

function parseWorkbook(wb: ExcelJS.Workbook): { sections: ParsedSection[]; orphans: string[] } {
  const out: ParsedSection[] = [];
  const orphans: string[] = [];
  for (const [sheetName, specs] of Object.entries(SECTIONS)) {
    const ws = wb.worksheets.find((w) => w.name.trim() === sheetName);
    if (!ws) throw new Error(`sheet "${sheetName}" not found in the workbook`);
    let current: ParsedSection | null = null;
    let round = 0;
    let date: string | null = null;
    let time: string | null = null;

    ws.eachRow((row) => {
      const values: unknown[] = [];
      for (let c = 1; c <= 6; c++) values.push(row.getCell(c).value);
      const a = cellText(values[0]);
      const isFixtureRow = cellText(values[2]).toLowerCase() === 'v';

      // A matched header starts a section. Any OTHER non-week, non-series, non-fixture
      // header text ends the current one — without this, rows under a header the
      // manifest doesn't know about silently leak into the previous section.
      const spec = specs.find((s) => s.match.test(a));
      if (spec) {
        current = { spec, fixtures: [], skippedRows: [], dateCorrections: [] };
        out.push(current);
        round = 0;
        date = null;
        time = null;
        return;
      }
      if (a && !isFixtureRow && !/^week/i.test(a) && !/^series/i.test(a)) {
        current = null;
        return;
      }
      // A fixture row with no live section is a manifest gap — fail closed, loudly.
      if (isFixtureRow && !current && !/semi|final/i.test(a)) {
        orphans.push(`${sheetName}: ${a} v ${cellText(values[3]) || cellText(values[4])}`);
        return;
      }

      // The running date/time: any date or time cell in any column updates it. A row
      // carrying a date but NO time resets the running time to null — otherwise a
      // Saturday 13:30 leaks onto Sunday's fixtures in the interleaved Promotion Women
      // layout, where every sheet restates the time after a date change.
      let rowHasDate = false;
      for (const v of values) {
        const d = isoDate(v);
        if (d) {
          date = d;
          rowHasDate = true;
        }
      }
      let rowHasTime = false;
      for (const v of values) {
        const t = isoTime(v);
        if (t) {
          time = t;
          rowHasTime = true;
        }
      }
      if (rowHasDate && !rowHasTime) time = null;

      const roundMatch = a.match(/^(?:week|series)\s+(\d+)/i);
      if (roundMatch) {
        round = Number(roundMatch[1]);
        return;
      }
      if (!current) return;
      if (!isFixtureRow) return;

      // Fixture rows read "Home | | v | Away?" with away in column D or E.
      const away = cellText(values[3]) || cellText(values[4]);
      const placeholder = /semi|final/i.test(a) || /semi|final/i.test(away);
      if (placeholder || !a || !away || !date || !round) {
        current.skippedRows.push(`${a || '—'} v ${away || '—'} (${date ?? 'no date'})`);
        return;
      }
      let fixed = date;
      if (fixed < SEASON_START) {
        const bumped = `${Number(fixed.slice(0, 4)) + 1}${fixed.slice(4)}`;
        current.dateCorrections.push(`${fixed} → ${bumped} (${a} v ${away})`);
        fixed = bumped;
        date = bumped; // later rows in the same week inherit the corrected date
      }
      current.fixtures.push({
        round,
        date: fixed,
        ...(time ? { time } : {}),
        homeName: a,
        awayName: away,
      });
    });
  }
  return { sections: out, orphans };
}

/** Mirrors buildPairMap's fail-closed duplicate handling on the REVISED side — a
 * repeated unordered pair within the Dolphins Premier T20 sections is a data problem,
 * not something to silently overwrite in the map. */
function dolphinsPremierPairs(sections: ParsedSection[]): {
  pairs: Map<string, { homeName: string; awayName: string }>;
  duplicates: string[];
} {
  const pairs = new Map<string, { homeName: string; awayName: string }>();
  const duplicates: string[] = [];
  for (const s of sections) {
    if (s.spec.slug !== 'premier-men-t20-1' && s.spec.slug !== 'premier-men-t20-2') continue;
    for (const f of s.fixtures) {
      const key = pairKey(f.homeName, f.awayName);
      if (pairs.has(key)) {
        duplicates.push(
          `${f.homeName} v ${f.awayName} (${s.spec.slug}) duplicates an earlier Dolphins Premier T20 pair`,
        );
        continue;
      }
      pairs.set(key, f);
    }
  }
  return { pairs, duplicates };
}

export function pairKey(a: string, b: string): string {
  return [redirectedNormalise(a), redirectedNormalise(b)].sort().join('|');
}

// ───────────────────────── REVISED workbook (flat-table) parser ─────────────────────────

interface FlatFixtureRow {
  matchNo: number;
  date: string;
  time: string | null;
  stage: string;
  group: string;
  homeName: string;
  awayName: string;
  venue: string;
  venueStatusRaw: string;
}

interface PairMapEntry {
  venue: string;
  venueStatusRaw: string;
  matchNo: number;
  homeName: string;
  awayName: string;
}

interface VenueAllocationRow {
  league: string;
  clubName: string;
  groundOnSheet: string;
  allocatedGround: string;
  reason: string;
}

interface FlatT20Result {
  premierPairs: Map<string, PairMapEntry>;
  promotionByGroup: Map<number, FlatFixtureRow[]>;
  venueAllocations: VenueAllocationRow[];
  bannerRowsSkipped: number;
  placeholderRowsSkipped: number;
  duplicatePairErrors: string[];
}

function locateHeaderRow(
  ws: ExcelJS.Worksheet,
  mustContain: string[],
): { rowNumber: number; colOf: Map<string, number> } {
  let found: { rowNumber: number; colOf: Map<string, number> } | null = null;
  ws.eachRow((row, rowNumber) => {
    if (found) return;
    const colOf = new Map<string, number>();
    for (let c = 1; c <= 12; c++) {
      const t = cellText(row.getCell(c).value).toLowerCase();
      if (t) colOf.set(t, c);
    }
    if (mustContain.every((h) => colOf.has(h))) found = { rowNumber, colOf };
  });
  if (!found)
    throw new Error(`header row (${mustContain.join(', ')}) not found in sheet "${ws.name}"`);
  return found;
}

function parseFixtureSheet(ws: ExcelJS.Worksheet): {
  rows: FlatFixtureRow[];
  bannerSkipped: number;
  placeholderSkipped: number;
} {
  const { rowNumber: headerRow, colOf } = locateHeaderRow(ws, [
    'match no',
    'date',
    'start',
    'stage',
    'group',
    'home team',
    'away team',
    'venue',
  ]);
  const col = (name: string) => colOf.get(name)!;
  const rows: FlatFixtureRow[] = [];
  let bannerSkipped = 0;
  let placeholderSkipped = 0;
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const matchNoRaw = row.getCell(col('match no')).value;
    const matchNo = typeof matchNoRaw === 'number' ? matchNoRaw : Number(cellText(matchNoRaw));
    // Banner rows ("SUNDAY 27 SEPTEMBER 2026", "RESERVE / CONTINGENCY SUNDAYS…", the
    // trailing footnote) have no numeric Match No — the cleanest, most robust signal.
    if (!Number.isFinite(matchNo) || matchNo <= 0) {
      bannerSkipped++;
      return;
    }
    const stage = cellText(row.getCell(col('stage')).value);
    if (/semi|final/i.test(stage)) {
      placeholderSkipped++;
      return;
    }
    const date = isoDate(row.getCell(col('date')).value);
    const time = isoTime(row.getCell(col('start')).value);
    const group = cellText(row.getCell(col('group')).value);
    const homeName = cellText(row.getCell(col('home team')).value);
    const awayName = cellText(row.getCell(col('away team')).value);
    const venue = cellText(row.getCell(col('venue')).value);
    const venueStatusRaw = colOf.has('venue status')
      ? cellText(row.getCell(col('venue status')).value)
      : '';
    if (!date || !homeName || !awayName) {
      bannerSkipped++;
      return;
    }
    rows.push({ matchNo, date, time, stage, group, homeName, awayName, venue, venueStatusRaw });
  });
  return { rows, bannerSkipped, placeholderSkipped };
}

/** Builds an unordered-pair map, failing closed (via the returned `duplicates` list) on
 * a repeated pair — used both for the real Premier pair-map and as a pure duplicate
 * check over the Promotion rows (whose pairs are attached directly to fixtures, not
 * looked up later). */
function buildPairMap(rows: FlatFixtureRow[]): {
  pairs: Map<string, PairMapEntry>;
  duplicates: string[];
} {
  const pairs = new Map<string, PairMapEntry>();
  const duplicates: string[] = [];
  for (const r of rows) {
    const key = pairKey(r.homeName, r.awayName);
    if (pairs.has(key)) {
      duplicates.push(
        `${r.homeName} v ${r.awayName} (match ${r.matchNo}) duplicates an earlier pair`,
      );
      continue;
    }
    pairs.set(key, {
      venue: r.venue,
      venueStatusRaw: r.venueStatusRaw,
      matchNo: r.matchNo,
      homeName: r.homeName,
      awayName: r.awayName,
    });
  }
  return { pairs, duplicates };
}

function groupPromotionFixtures(rows: FlatFixtureRow[]): Map<number, FlatFixtureRow[]> {
  const byGroup = new Map<number, FlatFixtureRow[]>();
  for (const r of rows) {
    const m = r.group.match(/(\d+)/);
    const g = m ? Number(m[1]) : 0;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(r);
  }
  return byGroup;
}

function parseVenueAllocations(ws: ExcelJS.Worksheet): VenueAllocationRow[] {
  const { rowNumber: headerRow, colOf } = locateHeaderRow(ws, [
    'league',
    'club',
    'ground on your sheet',
    'allocated home ground',
    'reason',
  ]);
  const col = (name: string) => colOf.get(name)!;
  const out: VenueAllocationRow[] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const league = cellText(row.getCell(col('league')).value);
    // Title/rule-note rows repeat one string across every column — restricting to the
    // two real league values is the simplest, most robust "is this a data row" check.
    if (league !== 'Premier' && league !== 'Promotion') return;
    out.push({
      league,
      clubName: cellText(row.getCell(col('club')).value),
      groundOnSheet: cellText(row.getCell(col('ground on your sheet')).value),
      allocatedGround: cellText(row.getCell(col('allocated home ground')).value),
      reason: cellText(row.getCell(col('reason')).value),
    });
  });
  return out;
}

function parseFlatT20(wb: ExcelJS.Workbook): FlatT20Result {
  const premierWs = wb.worksheets.find((w) => w.name.trim() === 'Premier T20 Fixtures');
  const promotionWs = wb.worksheets.find((w) => w.name.trim() === 'Promotion T20 Fixtures');
  const venueWs = wb.worksheets.find((w) => w.name.trim() === 'Venue Allocations');
  if (!premierWs || !promotionWs || !venueWs)
    throw new Error(
      'REVISED workbook is missing one of: "Premier T20 Fixtures", "Promotion T20 Fixtures", "Venue Allocations"',
    );

  const premier = parseFixtureSheet(premierWs);
  const promotion = parseFixtureSheet(promotionWs);
  const { pairs: premierPairs, duplicates: premierDup } = buildPairMap(premier.rows);
  const { duplicates: promotionDup } = buildPairMap(promotion.rows);
  const promotionByGroup = groupPromotionFixtures(promotion.rows);
  const venueAllocations = parseVenueAllocations(venueWs);

  return {
    premierPairs,
    promotionByGroup,
    venueAllocations,
    bannerRowsSkipped: premier.bannerSkipped + promotion.bannerSkipped,
    placeholderRowsSkipped: premier.placeholderSkipped + promotion.placeholderSkipped,
    duplicatePairErrors: [...premierDup, ...promotionDup],
  };
}

function comparePairSets(
  dolphins: Map<string, { homeName: string; awayName: string }>,
  revised: Map<string, PairMapEntry>,
): { missingVenue: string[]; unusedRevised: string[] } {
  const missingVenue: string[] = [];
  for (const [key, v] of dolphins)
    if (!revised.has(key)) missingVenue.push(`${v.homeName} v ${v.awayName}`);
  const unusedRevised: string[] = [];
  for (const [key, v] of revised)
    if (!dolphins.has(key))
      unusedRevised.push(`${v.homeName} v ${v.awayName} (match ${v.matchNo})`);
  return { missingVenue, unusedRevised };
}

// ───────────────────────── Building Series from parsed fixtures ─────────────────────────

/** Mirrors `AllocatedFixture` (src/competition/venues.ts) without importing frontend
 * code — same field names so the admin/club UIs (which already render these) work
 * unchanged. `home`/`away` are participant TEAM ids, not club ids (a multi-team club
 * fields several sides), which is what `ClubFixturesView`'s `s.teams.includes(teamId)`
 * filter (src/club.tsx:4211-4216) requires. */
interface WrittenFixture {
  id: string;
  round: number;
  date: string;
  time?: string;
  home: string;
  away: string;
  venueId?: string;
  venueName?: string;
  venueLat?: number;
  venueLon?: number;
  venueLocked?: boolean;
  venueOverride?: string;
  venueStatus?: VenueStatus;
  venueReason?: string;
}

interface BuiltSeries {
  series: Series;
  fixtures: WrittenFixture[];
  /** The parsed input, index-aligned with `fixtures` — lets venue-assignment code look
   * back at the ORIGINAL sheet names (for pair-map keys) without re-deriving them from
   * resolved club names. */
  raw: ParsedFixture[];
}

function buildSeries(
  spec: SeriesSpec,
  raw: ParsedFixture[],
  clubs: Club[],
  byNorm: Map<string, Club>,
  usage: SuffixUsage,
  unmatched: Set<string>,
  leagueLabel: (key: string) => string,
  resolutions: ResolutionLog,
): BuiltSeries | null {
  if (raw.length === 0) return null;
  const teamIds: string[] = [];
  const participants: SeriesParticipant[] = [];
  const seen = new Set<string>();
  const add = (p: SeriesParticipant) => {
    if (seen.has(p.teamId)) return;
    seen.add(p.teamId);
    teamIds.push(p.teamId);
    participants.push(p);
  };

  const fixtures: WrittenFixture[] = raw.map((f, i) => {
    const home = resolveParticipant(f.homeName, spec.leagueKey, clubs, byNorm, usage, resolutions);
    const away = resolveParticipant(f.awayName, spec.leagueKey, clubs, byNorm, usage, resolutions);
    if (!home) unmatched.add(f.homeName);
    if (!away) unmatched.add(f.awayName);
    if (home) add(home);
    if (away) add(away);
    return {
      id: `f${i + 1}`,
      round: f.round,
      date: f.date,
      ...(f.time ? { time: f.time } : {}),
      home: home?.teamId ?? f.homeName,
      away: away?.teamId ?? f.awayName,
    };
  });

  const dates = fixtures.map((f) => f.date).sort();
  const series: Series = {
    id: `${ID_PREFIX}${spec.slug}`,
    name: `${leagueLabel(spec.leagueKey)} · ${spec.label}`,
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
    // Drafts on purpose for brand-new series: the admin approves and releases from the
    // console. Overwrites of an existing id preserve the real lifecycle later.
    approved: false,
    released: false,
    releasedAt: null,
    version: 1,
  } as Series;

  return { series, fixtures, raw };
}

// ───────────────────────── Venue writing (1f) ─────────────────────────

function buildVenueIndex(venues: Venue[]): Map<string, Venue> {
  const byNorm = new Map<string, Venue>();
  // Keyed by groundKey (not the bare normalised name) so this index matches
  // venue-clash.ts's registryResolver — an aliased venue name must resolve to the same
  // registry row here as it does in the clash-pass ledger.
  for (const v of venues) byNorm.set(groundKey(v.name), v);
  return byNorm;
}

function resolveVenue(name: string, byNormVenue: Map<string, Venue>): Venue | undefined {
  // groundKey applies the shared alias table over the normal form; an unaliased name
  // falls through to its own normal form, matching buildVenueIndex's keys.
  return byNormVenue.get(groundKey(name));
}

/** A club's ground for allocation purposes: the Venue Allocations re-base if it has
 * one, else its own registered ground. */
function allocatedGroundName(
  clubId: string,
  clubsById: Map<string, Club>,
  reBaseMap: Map<string, string>,
): string | undefined {
  const rebased = reBaseMap.get(clubId);
  if (rebased) return rebased;
  const own = clubsById.get(clubId)?.ground?.venue?.trim();
  return own && !JUNK_GROUND.test(own) ? own : undefined;
}

function deriveVenueStatus(
  chosenName: string,
  homeAllocated: string | undefined,
  awayAllocated: string | undefined,
): VenueStatus {
  const chosen = normaliseGround(chosenName);
  if (homeAllocated && normaliseGround(homeAllocated) === chosen) return 'home';
  if (awayAllocated && normaliseGround(awayAllocated) === chosen) return 'alternative';
  return 'neutral';
}

/** Registry-first: a match sets venueId/venueName/coords and LOCKS the fixture (never a
 * differing venueName — travel costing depends on venueName being the trusted label,
 * src/competition/venues.ts:225-245). No match falls back to venueOverride plus an
 * EQUAL venueName (same string, so the override-vs-name divergence guard in
 * fixtureVenueCoords never fires) with no id/coords/lock. */
function setVenue(
  f: WrittenFixture,
  groundName: string,
  status: VenueStatus,
  reason: string,
  byNormVenue: Map<string, Venue>,
  registryMiss: Set<string>,
) {
  const venue = resolveVenue(groundName, byNormVenue);
  f.venueStatus = status;
  f.venueReason = reason;
  if (venue) {
    f.venueId = venue.id;
    f.venueName = venue.name;
    f.venueLat = Number.isFinite(venue.lat) ? venue.lat : undefined;
    f.venueLon = Number.isFinite(venue.lon) ? venue.lon : undefined;
    f.venueOverride = undefined;
    f.venueLocked = true;
  } else {
    f.venueId = undefined;
    f.venueLat = undefined;
    f.venueLon = undefined;
    f.venueLocked = undefined;
    f.venueOverride = groundName;
    f.venueName = groundName;
    registryMiss.add(groundName);
  }
}

function applyExplicitVenue(
  f: WrittenFixture,
  groundName: string,
  homeAllocated: string | undefined,
  awayAllocated: string | undefined,
  byNormVenue: Map<string, Venue>,
  reason: string,
  registryMiss: Set<string>,
) {
  setVenue(
    f,
    groundName,
    deriveVenueStatus(groundName, homeAllocated, awayAllocated),
    reason,
    byNormVenue,
    registryMiss,
  );
}

/** Venue Allocations sheet → clubId → allocated ground name. Fails closed (via the
 * returned `unresolved` list) on a club name the prod registry doesn't know. */
function buildReBaseMap(
  rows: VenueAllocationRow[],
  clubs: Club[],
  byNorm: Map<string, Club>,
): { reBaseMap: Map<string, string>; unresolved: string[] } {
  const reBaseMap = new Map<string, string>();
  const unresolved: string[] = [];
  for (const r of rows) {
    const club = resolveClub(r.clubName, clubs, byNorm);
    if (!club) {
      unresolved.push(r.clubName);
      continue;
    }
    reBaseMap.set(club.id, r.allocatedGround);
  }
  return { reBaseMap, unresolved };
}

function buildBarredGrounds(rows: VenueAllocationRow[]): Set<string> {
  return new Set(
    rows
      .map((r) => r.groundOnSheet)
      .filter((g) => g && !/none listed/i.test(g))
      .map(normaliseGround),
  );
}

// ───────────────────────── Season-wide clash ledger (1f) ─────────────────────────
// GroundLedger + slot semantics live in venue-clash.ts, shared with the API's
// release gate — one implementation, one set of unit tests.

interface StoredFixture {
  id?: string;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  status?: string;
  venueOverride?: string;
  venueName?: string;
  venueId?: string;
  venueLocked?: boolean;
  venueReason?: string;
}

/** The id every stored series carries a slug from, or undefined for a foreign id
 * (never one this script wrote). Centralises the `startsWith(ID_PREFIX)` guard so a
 * bare `.slice()` never silently mangles an unrelated id (finding #9). */
function seriesSlug(id: unknown): string | undefined {
  const s = String(id);
  return s.startsWith(ID_PREFIX) ? s.slice(ID_PREFIX.length) : undefined;
}

/** Effective ground for an INCOMING (about-to-be-written) fixture: explicit venue
 * fields if set, else the home side's allocated ground (registry/re-base aware) via
 * its series participant snapshot. */
function effectiveGroundIncoming(
  series: Series,
  f: WrittenFixture,
  clubsById: Map<string, Club>,
  reBaseMap: Map<string, string>,
): string | undefined {
  const explicit = f.venueOverride || f.venueName;
  if (explicit) return explicit;
  const teamToClub = new Map((series.participants ?? []).map((p) => [p.teamId, p.clubId]));
  const homeClubId = f.home ? teamToClub.get(f.home) : undefined;
  return homeClubId ? allocatedGroundName(homeClubId, clubsById, reBaseMap) : undefined;
}

/** Effective ground for an EXISTING (already-in-the-tenant) fixture: explicit venue
 * fields if present, else resolve `home` to a clubId — via the series' `participants`
 * snapshot when present, or directly (legacy series: `home` IS a clubId) — and use
 * that club's allocated/re-based ground. */
function effectiveGroundExisting(
  s: Series,
  f: StoredFixture,
  clubsById: Map<string, Club>,
  reBaseMap: Map<string, string>,
): string | undefined {
  const explicit = f.venueOverride || f.venueName;
  if (explicit) return explicit;
  if (!f.home) return undefined;
  const participants = s.participants as SeriesParticipant[] | undefined;
  const homeClubId = participants ? participants.find((p) => p.teamId === f.home)?.clubId : f.home;
  return homeClubId ? allocatedGroundName(homeClubId, clubsById, reBaseMap) : undefined;
}

function runClashPass(
  built: BuiltSeries[],
  existingOtherSeries: Series[],
  clubsById: Map<string, Club>,
  reBaseMap: Map<string, string>,
  allowClashes: boolean,
  byNormVenue: Map<string, Venue>,
  registryMiss: Set<string>,
  barredGrounds: Set<string>,
): { unresolved: string[]; autoMoves: string[]; skippedUndeterminable: number } {
  // Registry-resolved grounds share a ledger row by venue id and book against the
  // venue's real surface count; unresolved names stay strict at one surface.
  const ledger = new GroundLedger((ground) => {
    const venue = resolveVenue(ground, byNormVenue);
    return venue
      ? { key: `v:${venue.id}`, capacity: Math.max(1, Number(venue.surfaces) || 1) }
      : { key: `g:${normaliseGround(ground)}`, capacity: 1 };
  });
  let skippedUndeterminable = 0;

  // Seed with every fixture NOT part of this run's writes (kept + non-planb series) —
  // excluding the DELETE_SLUGS series, which are about to be pruned and would phantom-
  // clash with their replacements otherwise.
  for (const s of existingOtherSeries) {
    const slug = seriesSlug(s.id);
    if (slug && DELETE_SLUGS.includes(slug)) continue;
    for (const raw of (s.fixtures as StoredFixture[]) ?? []) {
      if (!raw.date) continue;
      const ground = effectiveGroundExisting(s, raw, clubsById, reBaseMap);
      if (!ground) {
        skippedUndeterminable++;
        continue;
      }
      ledger.book(ground, raw.date, raw.time, {
        seriesId: String(s.id),
        fixtureId: raw.id ?? '',
        date: raw.date,
        time: raw.time,
      });
    }
  }

  const unresolved: string[] = [];
  const autoMoves: string[] = [];

  // The union's permitted-fields list ("facility updated" sheet, 17 Aug 2026) lives on
  // the registry as homeClubIds — every venue a club may use when its first choice is
  // taken. Loaded here so clash resolution can walk a club's own permitted pool.
  const permittedByClub = new Map<string, Venue[]>();
  for (const v of new Set(byNormVenue.values())) {
    for (const cid of v.homeClubIds ?? []) {
      const list = permittedByClub.get(cid) ?? [];
      list.push(v);
      permittedByClub.set(cid, list);
    }
  }
  for (const list of permittedByClub.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  // Two phases: union-authored venues (explicit venue fields from the REVISED sheet /
  // pair-map / re-bases) book FIRST, then venue-less fixtures fill around them. Dry run
  // #3 showed why order matters: a women's fixture auto-moved onto Lahee Park before
  // the Promotion T20 fixture whose union-fixed venue IS Lahee Park had booked it.
  // Explicit-vs-explicit clashes move ONLY within the union's own permitted-fields
  // list — that sheet is the union's stated answer to "where do clubs play when there
  // is a conflict", so it outranks even a sheet-fixed venue; anything it can't place
  // stays a human decision.
  for (const explicitPhase of [true, false]) {
    for (const { series, fixtures } of built) {
      const teamToClub = new Map((series.participants ?? []).map((p) => [p.teamId, p.clubId]));
      for (const f of fixtures) {
        const isExplicit = Boolean(f.venueOverride || f.venueName);
        if (isExplicit !== explicitPhase) continue;
        const ground = effectiveGroundIncoming(series, f, clubsById, reBaseMap);
        if (!ground) {
          skippedUndeterminable++;
          continue;
        }
        const clash = ledger.check(ground, f.date, f.time);
        if (!clash) {
          ledger.book(ground, f.date, f.time, {
            seriesId: String(series.id),
            fixtureId: f.id,
            date: f.date,
            time: f.time,
          });
          continue;
        }
        // Auto-move candidates, tried in the order a scheduler would. All registry-first
        // via setVenue, never a barred ground, never the ground we are already clashing
        // on, deduped by ledger key (so "Toti Oval" and "Toti 1" count as one option).
        const homeClubId = teamToClub.get(f.home);
        const awayClubId = teamToClub.get(f.away);
        const secondary = (clubId: string | undefined) => {
          const s = clubId ? clubsById.get(clubId)?.ground?.secondaryVenue?.trim() : undefined;
          return s && !JUNK_GROUND.test(s) ? s : undefined;
        };
        const candidates: Array<{ ground: string; label: string }> = [];
        const addCandidate = (g: string | undefined, label: string) => {
          if (!g) return;
          if (groundKey(g) === groundKey(ground)) return;
          if (candidates.some((c) => groundKey(c.ground) === groundKey(g))) return;
          if (barredGrounds.has(normaliseGround(g))) return;
          candidates.push({ ground: g, label });
        };
        const addPermitted = (clubId: string | undefined, label: string) => {
          for (const v of clubId ? (permittedByClub.get(clubId) ?? []) : [])
            addCandidate(v.name, label);
        };
        if (!explicitPhase) {
          // Union Rule 4 first, then the clubs' registered secondaries.
          addCandidate(
            awayClubId ? allocatedGroundName(awayClubId, clubsById, reBaseMap) : undefined,
            "away side's allocated ground",
          );
          addCandidate(secondary(homeClubId), "home club's secondary ground");
          addCandidate(secondary(awayClubId), "away club's secondary ground");
        }
        // The union's permitted-fields list applies in BOTH phases — for a
        // union-authored venue it is the only sanctioned escape.
        addPermitted(homeClubId, "home club's permitted field (union facility list)");
        addPermitted(awayClubId, "away club's permitted field (union facility list)");
        const target = candidates.find((c) => !ledger.check(c.ground, f.date, f.time));
        if (target) {
          setVenue(
            f,
            target.ground,
            'alternative',
            `Moved to avoid ground clash — ${target.label}`,
            byNormVenue,
            registryMiss,
          );
          ledger.book(target.ground, f.date, f.time, {
            seriesId: String(series.id),
            fixtureId: f.id,
            date: f.date,
            time: f.time,
          });
          autoMoves.push(
            `${series.id} ${f.id}: ${ground} → ${target.ground} [${target.label}] on ${f.date}${f.time ? ' ' + f.time : ''} (clashed with ${clash.seriesId}/${clash.fixtureId})`,
          );
        } else {
          unresolved.push(
            `${series.id} ${f.id}: ${ground} on ${f.date}${f.time ? ' ' + f.time : ''} clashes with ${clash.seriesId}/${clash.fixtureId}${candidates.length ? ` (tried: ${candidates.map((c) => c.ground).join(', ')})` : ' (no alternative ground available)'}${explicitPhase ? ' [union-authored venue — decide in the console]' : ''}`,
          );
          if (allowClashes) {
            ledger.book(ground, f.date, f.time, {
              seriesId: String(series.id),
              fixtureId: f.id,
              date: f.date,
              time: f.time,
            });
          }
        }
      }
    }
  }
  return { unresolved, autoMoves, skippedUndeterminable };
}

// ───────────────────────── Reconciliation safety rails (1g) ─────────────────────────

/** The computed stale set must be a SUBSET of DELETE_SLUGS (empty is fine — that's the
 * normal post-`--prune` re-run case, once the superseded series are already gone).
 * Abort only when a stale slug falls OUTSIDE the expected set — that's a real surprise
 * (a slug this run doesn't know about going stale), not the routine subset shrinkage. */
export function assertDeleteSet(existingIds: string[], writtenSlugs: Set<string>): string[] {
  const stale = existingIds
    .filter((id) => id.startsWith(ID_PREFIX))
    .map((id) => id.slice(ID_PREFIX.length))
    .filter((slug) => !writtenSlugs.has(slug) && !KEEP_LIST.includes(slug))
    .sort();
  const expected = new Set(DELETE_SLUGS);
  const foreign = stale.filter((slug) => !expected.has(slug));
  if (foreign.length) {
    throw new Error(
      `DELETE set contains slug(s) outside the expected superseded set [${DELETE_SLUGS.join(', ')}]: ${foreign.join(', ')}. Refusing to continue.`,
    );
  }
  return stale;
}

/** venueReason prefixes this script itself authors (see setVenue/applyExplicitVenue
 * call sites) — a venue carrying one of these is the IMPORT's own prior write, not an
 * admin edit, and must never gate `--discard-edits`. */
const IMPORT_AUTHORED_REASON_PREFIXES = [
  'Union T20 schedule',
  'Allocated ground —',
  'Moved to avoid',
];

function isImportAuthoredReason(reason: string | undefined): boolean {
  return !!reason && IMPORT_AUTHORED_REASON_PREFIXES.some((p) => reason.startsWith(p));
}

/** Splits the diff between an existing series and its incoming replacement into what
 * actually gates `--discard-edits` (GENUINE admin edits: a fixture no longer
 * 'scheduled', a hand-set venue whose reason isn't one the import itself authors, or a
 * fixture that only exists on prod/hand-added) vs. what's purely INFORMATIONAL.
 *
 * Date/time is informational-only, never genuine: this import deliberately amends
 * dates and adds times across the whole sheet, and fixture ids (`f1..fN`) are
 * regenerated from row order every run — an id-based date comparison has no way to
 * distinguish "this import corrected the date" from "an admin corrected the date", so
 * it can't safely gate a write. Surface it for the operator to read, not to block on. */
function diffAdminEdits(
  existing: Series,
  incoming: Series,
): { genuine: string[]; informational: string[] } {
  const genuine: string[] = [];
  const informational: string[] = [];
  const existingFixtures = (existing.fixtures as StoredFixture[]) ?? [];
  const incomingFixtures = (incoming.fixtures as StoredFixture[]) ?? [];
  const incomingById = new Map(incomingFixtures.map((f) => [f.id, f]));
  for (const f of existingFixtures) {
    if (f.status && f.status !== 'scheduled')
      genuine.push(`${existing.id}: fixture ${f.id} has status "${f.status}"`);
    const handSetVenue = f.venueOverride || f.venueId || f.venueLocked;
    if (handSetVenue && !isImportAuthoredReason(f.venueReason))
      genuine.push(
        `${existing.id}: fixture ${f.id} has a hand-set venue (reason: ${f.venueReason ?? 'none recorded'})`,
      );
    const inc = f.id ? incomingById.get(f.id) : undefined;
    if (inc) {
      if (inc.date !== f.date || inc.time !== f.time)
        informational.push(
          `${existing.id}: fixture ${f.id} date/time differs (prod ${f.date} ${f.time ?? ''} vs sheet ${inc.date} ${inc.time ?? ''})`,
        );
    } else {
      genuine.push(`${existing.id}: fixture ${f.id} exists on prod only (hand-added)`);
    }
  }
  return { genuine, informational };
}

async function backupExistingSeries(repo: RepoModule): Promise<string> {
  const all = await repo.listSeries(TENANT);
  const mine = all.filter((s) => String(s.id).startsWith(ID_PREFIX));
  const path = `./planb-backup-${TENANT}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(path, JSON.stringify(mine, null, 2));
  console.log(`Backup written: ${path} (${mine.length} series)`);
  return path;
}

// ───────────────────────── CLI ─────────────────────────

interface Args {
  mode: 'import' | 'prune' | 'revert';
  file: string;
  t20: string;
  confirm: boolean;
  discardEdits: boolean;
  allowClashes: boolean;
  allowCountMismatch: boolean;
  parseOnly: boolean;
  all: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'import',
    file: '',
    t20: '',
    confirm: false,
    discardEdits: false,
    allowClashes: false,
    allowCountMismatch: false,
    parseOnly: false,
    all: false,
  };
  let prune = false;
  let revert = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i] ?? '';
    else if (a === '--t20') args.t20 = argv[++i] ?? '';
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--discard-edits') args.discardEdits = true;
    else if (a === '--allow-clashes') args.allowClashes = true;
    else if (a === '--allow-count-mismatch') args.allowCountMismatch = true;
    else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--prune') prune = true;
    else if (a === '--revert') revert = true;
    else if (a === '--all') args.all = true;
    else throw new Error(`unknown flag ${a}`);
  }
  if (prune && revert) throw new Error('--prune and --revert are mutually exclusive');
  if (prune) {
    if (args.file || args.t20) throw new Error('--prune takes no --file/--t20');
    args.mode = 'prune';
    return args;
  }
  if (revert) {
    if (args.file || args.t20) throw new Error('--revert takes no --file/--t20');
    args.mode = 'revert';
    return args;
  }
  if (!args.file || !args.t20)
    throw new Error('import mode requires both --file <Dolphins xlsx> and --t20 <REVISED xlsx>');
  return args;
}

// ───────────────────────── Reporting ─────────────────────────

function printSection(section: ParsedSection, leagueLabel: (k: string) => string) {
  const { spec } = section;
  console.log(`\n── ${spec.slug}  (${leagueLabel(spec.leagueKey)} · ${spec.label})`);
  for (const c of section.dateCorrections) console.log(`  date corrected: ${c}`);
  for (const r of section.skippedRows) console.log(`  row skipped: ${r}`);
  if (section.fixtures.length === 0) {
    console.log('  ✗ 0 fixtures parsed — this section will ABORT the run');
    return;
  }
  for (const f of section.fixtures)
    console.log(
      `  R${f.round}  ${f.date}${f.time ? ' · ' + f.time : ''}  ${f.homeName} v ${f.awayName}`,
    );
  const mark = section.fixtures.length === spec.expected ? '✓' : '✗ MISMATCH';
  console.log(`  ${mark} ${section.fixtures.length} fixtures (expected ${spec.expected})`);
}

function printPromotionGroups(byGroup: Map<number, FlatFixtureRow[]>): {
  allExpected: boolean;
  mismatches: string[];
} {
  let allExpected = true;
  const mismatches: string[] = [];
  for (let g = 1; g <= 4; g++) {
    const rows = (byGroup.get(g) ?? []).slice().sort((a, b) => a.matchNo - b.matchNo);
    console.log(`\n── promotion-men-t20-g${g}  (promotion · T20 · Group ${g}, from REVISED)`);
    for (const r of rows)
      console.log(
        `  match ${r.matchNo}  ${r.date}${r.time ? ' · ' + r.time : ''}  ${r.homeName} v ${r.awayName}  [${r.venue}]`,
      );
    const mark = rows.length === 10 ? '✓' : '✗ MISMATCH';
    if (rows.length !== 10) {
      allExpected = false;
      mismatches.push(
        `REVISED Promotion T20 Group ${g} parsed ${rows.length} fixtures (expected 10)`,
      );
    }
    console.log(`  ${mark} ${rows.length} fixtures (expected 10)`);
  }
  return { allExpected, mismatches };
}

function printPairMap(
  dolphins: Map<string, { homeName: string; awayName: string }>,
  revised: Map<string, PairMapEntry>,
  cmp: { missingVenue: string[]; unusedRevised: string[] },
) {
  console.log(`\n── Premier T20 venue pair-map`);
  console.log(`  Dolphins pairs: ${dolphins.size}, REVISED pairs: ${revised.size}`);
  for (const [key, d] of dolphins) {
    const pm = revised.get(key);
    console.log(
      `  ${d.homeName} v ${d.awayName} → ${pm ? `${pm.venue} (${pm.venueStatusRaw}, match ${pm.matchNo})` : '✗ NO VENUE FOUND'}`,
    );
  }
  if (cmp.missingVenue.length)
    console.log(
      `  ✗ ${cmp.missingVenue.length} Dolphins pair(s) with no REVISED venue:\n${cmp.missingVenue.map((x) => `     ${x}`).join('\n')}`,
    );
  if (cmp.unusedRevised.length)
    console.log(
      `  ✗ ${cmp.unusedRevised.length} REVISED pair(s) unused by the Dolphins file:\n${cmp.unusedRevised.map((x) => `     ${x}`).join('\n')}`,
    );
  if (!cmp.missingVenue.length && !cmp.unusedRevised.length)
    console.log(`  ✓ pair sets match exactly, no asymmetry`);
}

/** Deduplicated per-league table of every "raw sheet name" → resolved club (plus a
 * synthesised teamId when one was created) — printed before every abort gate, in both
 * dry-run and confirm, so the operator can review every alias/redirect outcome. */
function printResolutionLog(log: ResolutionLog, leagueLabel: (key: string) => string) {
  console.log(`\n── Name resolution sign-off (${log.size} name(s))`);
  const byLeague = new Map<string, ResolutionEntry[]>();
  for (const e of log.values()) {
    if (!byLeague.has(e.leagueKey)) byLeague.set(e.leagueKey, []);
    byLeague.get(e.leagueKey)!.push(e);
  }
  for (const [leagueKey, entries] of [...byLeague.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    console.log(`  [${leagueLabel(leagueKey)}]`);
    for (const e of entries.sort((a, b) => a.raw.localeCompare(b.raw))) {
      const teamPart = e.teamId !== e.clubId ? ` [${e.teamId}]` : '';
      console.log(`    "${e.raw}" → ${e.clubName} (${e.clubId})${teamPart}`);
    }
  }
}

function printVenueAllocations(rows: VenueAllocationRow[]) {
  console.log(`\n── Venue Allocations (${rows.length} rows)`);
  for (const r of rows)
    console.log(
      `  [${r.league}] ${r.clubName}: ${r.groundOnSheet} → ${r.allocatedGround}  (${r.reason})`,
    );
}

// ───────────────────────── Modes ─────────────────────────

async function runRevert(repo: RepoModule, all: boolean, confirm: boolean) {
  const list = await repo.listSeries(TENANT);
  let mine = list.filter((s) => String(s.id).startsWith(ID_PREFIX));
  if (!all) {
    const before = mine.length;
    mine = mine.filter((s) => !KEEP_LIST.includes(String(s.id).slice(ID_PREFIX.length)));
    const kept = before - mine.length;
    if (kept > 0)
      console.log(
        `Keeping ${kept} series on the keep-list (${KEEP_LIST.join(', ')}) — pass --all to include them.`,
      );
  }
  if (mine.length === 0) {
    console.log('Nothing to revert.');
    return;
  }
  for (const s of mine) {
    const status = s.released ? 'RELEASED' : s.approved ? 'approved' : 'draft';
    console.log(
      `${confirm ? 'delete' : '[dry-run] would delete'}  ${s.id}  (${s.name} · ${status})`,
    );
    if (confirm) await repo.deleteSeries(TENANT, String(s.id));
  }
  console.log(
    confirm
      ? `Reverted ${mine.length} imported series.`
      : `Re-run with --confirm to delete these ${mine.length} series.`,
  );
}

async function runPrune(repo: RepoModule, confirm: boolean) {
  const all = await repo.listSeries(TENANT);
  const stale = all.filter(
    (s) =>
      String(s.id).startsWith(ID_PREFIX) &&
      DELETE_SLUGS.includes(String(s.id).slice(ID_PREFIX.length)),
  );
  if (stale.length === 0) {
    console.log('Nothing to prune — none of the superseded series exist.');
    return;
  }
  for (const s of stale) {
    const status = s.released ? 'RELEASED' : s.approved ? 'approved' : 'draft';
    console.log(
      `${confirm ? 'delete' : '[dry-run] would delete'}  ${s.id}  (${s.name} · ${status})`,
    );
    if (s.released)
      console.warn(`  ⚠ ${s.id} is RELEASED — pruning removes it from club portals immediately.`);
    if (confirm) await repo.deleteSeries(TENANT, String(s.id));
  }
  console.log(
    confirm
      ? `Pruned ${stale.length} superseded series.`
      : `Re-run with --confirm to delete these ${stale.length} series.`,
  );
}

async function runImport(args: Args) {
  const dolphinsWb = new ExcelJS.Workbook();
  await dolphinsWb.xlsx.readFile(args.file);
  const t20Wb = new ExcelJS.Workbook();
  await t20Wb.xlsx.readFile(args.t20);

  const leagueLabelFallback = (key: string) => key;
  const { sections, orphans } = parseWorkbook(dolphinsWb);
  const flat = parseFlatT20(t20Wb);
  const { pairs: dolphinsPairs, duplicates: dolphinsDuplicatePairErrors } =
    dolphinsPremierPairs(sections);
  const pairCmp = comparePairSets(dolphinsPairs, flat.premierPairs);

  for (const s of sections) printSection(s, leagueLabelFallback);
  const { allExpected: promotionCountsOk, mismatches: promotionMismatches } = printPromotionGroups(
    flat.promotionByGroup,
  );
  printPairMap(dolphinsPairs, flat.premierPairs, pairCmp);
  printVenueAllocations(flat.venueAllocations);
  console.log(
    `\nREVISED file: ${flat.bannerRowsSkipped} banner row(s) skipped, ${flat.placeholderRowsSkipped} semi/final placeholder row(s) skipped.`,
  );
  if (!promotionCountsOk)
    console.log('  (mismatches above are printed for review — see "MISMATCH" markers)');

  const hardFailures: string[] = [];
  if (orphans.length) hardFailures.push(`${orphans.length} orphan fixture row(s) — see above`);
  for (const s of sections)
    if (s.fixtures.length === 0) hardFailures.push(`section "${s.spec.slug}" parsed 0 fixtures`);
  if (flat.duplicatePairErrors.length)
    hardFailures.push(
      `${flat.duplicatePairErrors.length} duplicate Premier/Promotion T20 pair(s) in the REVISED file`,
    );
  if (dolphinsDuplicatePairErrors.length)
    hardFailures.push(
      `${dolphinsDuplicatePairErrors.length} duplicate Dolphins Premier T20 pair(s) — see above`,
    );
  if (pairCmp.missingVenue.length || pairCmp.unusedRevised.length)
    hardFailures.push('Premier T20 pair-set asymmetry between the two files');
  for (let g = 1; g <= 4; g++)
    if ((flat.promotionByGroup.get(g) ?? []).length === 0)
      hardFailures.push(`REVISED Promotion T20 Group ${g} parsed 0 fixtures`);
  // Expected-count mismatches (Dolphins sections + REVISED Promotion groups) abort by
  // default — a sheet revision that silently drops rows must never pass as clean.
  // --allow-count-mismatch is the escape hatch for a deliberate future sheet revision.
  if (!args.allowCountMismatch) {
    // The 0-fixture case is already a separate, always-fail-closed rule above; only
    // add the nonzero-but-wrong-count case here so it isn't reported twice.
    for (const s of sections)
      if (s.fixtures.length !== 0 && s.fixtures.length !== s.spec.expected)
        hardFailures.push(
          `section "${s.spec.slug}" parsed ${s.fixtures.length} fixtures (expected ${s.spec.expected})`,
        );
    hardFailures.push(...promotionMismatches.filter((m) => !/parsed 0 fixtures/.test(m)));
  }

  if (hardFailures.length) {
    console.error(`\n✗ Refusing to continue:\n${hardFailures.map((f) => `   ${f}`).join('\n')}`);
    if (!args.allowCountMismatch)
      console.error(
        '   (pass --allow-count-mismatch to write anyway if this is a deliberate sheet revision)',
      );
    process.exitCode = 1;
    return;
  }

  if (args.parseOnly) {
    console.log(
      '\n[parse-only] Parsing clean — nothing touched DynamoDB. Re-run without --parse-only to resolve clubs, allocate venues, and (with --confirm) write.',
    );
    return;
  }

  const repo = await import('./repo.js');
  const [clubs, config, venues, existingSeries] = await Promise.all([
    repo.listClubs(TENANT),
    repo.getTenantConfig(TENANT),
    repo.listVenues(TENANT),
    repo.listSeries(TENANT),
  ]);
  const byNorm = buildClubIndex(clubs);
  const clubsById = new Map(clubs.map((c) => [c.id, c]));
  const byNormVenue = buildVenueIndex(venues);
  const usage: SuffixUsage = { suffixed: new Set(), unsuffixed: new Set() };
  const unmatched = new Set<string>();
  const registryMiss = new Set<string>();
  const implicitGroundReport: string[] = [];
  const leagueLabel = (key: string) =>
    (config?.leagues ?? []).find((l) => l.key === key)?.label ?? key;

  const wantedLeagueKeys = new Set(
    Object.values(SECTIONS)
      .flat()
      .map((s) => s.leagueKey),
  );
  const configuredLeagueKeys = new Set((config?.leagues ?? []).map((l) => l.key));
  const missingLeagueKeys = [...wantedLeagueKeys].filter((k) => !configuredLeagueKeys.has(k));
  console.log(`\nTenant leagues: ${[...configuredLeagueKeys].join(', ') || '(none configured)'}`);
  for (const k of missingLeagueKeys)
    console.warn(`  ⚠ league key "${k}" is not configured on this tenant yet`);

  const { reBaseMap, unresolved: unresolvedAllocationClubs } = buildReBaseMap(
    flat.venueAllocations,
    clubs,
    byNorm,
  );
  if (unresolvedAllocationClubs.length) {
    console.error(
      `\n✗ Venue Allocations sheet has club name(s) that don't resolve to a prod club:\n${unresolvedAllocationClubs.map((n) => `   "${n}"`).join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }
  const barredGrounds = buildBarredGrounds(flat.venueAllocations);
  const resolutions: ResolutionLog = new Map();

  // ── Build every Series ──
  const built: BuiltSeries[] = [];
  for (const section of sections) {
    const b = buildSeries(
      section.spec,
      section.fixtures,
      clubs,
      byNorm,
      usage,
      unmatched,
      leagueLabel,
      resolutions,
    );
    if (b) built.push(b);
  }
  let stageRoundFailure = false;
  for (let g = 1; g <= 4; g++) {
    const rows = (flat.promotionByGroup.get(g) ?? []).slice().sort((a, b) => a.matchNo - b.matchNo);
    const spec: SeriesSpec = {
      slug: `promotion-men-t20-g${g}`,
      label: `T20 · Group ${g}`,
      leagueKey: 'promotion',
      seriesType: 'Twenty20 (16-25 overs)',
      maxOvers: 20,
      expected: 10,
    };
    const raw: ParsedFixture[] = rows.map((r) => {
      const m = r.stage.match(/(\d+)/);
      if (!m) {
        console.error(
          `✗ REVISED Promotion T20 Group ${g} match ${r.matchNo}: stage "${r.stage}" has no round digit.`,
        );
        stageRoundFailure = true;
      }
      return {
        round: m ? Number(m[1]) : 0,
        date: r.date,
        ...(r.time ? { time: r.time } : {}),
        homeName: r.homeName,
        awayName: r.awayName,
      };
    });
    const b = buildSeries(spec, raw, clubs, byNorm, usage, unmatched, leagueLabel, resolutions);
    if (!b) continue;
    b.fixtures.forEach((f, i) => {
      const teamToClub = new Map(b.series.participants!.map((p) => [p.teamId, p.clubId]));
      const homeClubId = teamToClub.get(f.home);
      const awayClubId = teamToClub.get(f.away);
      const homeAllocated = homeClubId
        ? allocatedGroundName(homeClubId, clubsById, reBaseMap)
        : undefined;
      const awayAllocated = awayClubId
        ? allocatedGroundName(awayClubId, clubsById, reBaseMap)
        : undefined;
      applyExplicitVenue(
        f,
        rows[i].venue,
        homeAllocated,
        awayAllocated,
        byNormVenue,
        'Union T20 schedule — exact venue',
        registryMiss,
      );
    });
    built.push(b);
  }

  // Printed before every abort gate below — the operator reviews every alias/redirect
  // outcome regardless of whether this run goes on to write.
  printResolutionLog(resolutions, leagueLabel);

  if (stageRoundFailure) {
    console.error('\n✗ refusing to continue — see stage/round errors above.');
    process.exitCode = 1;
    return;
  }

  if (unmatched.size) {
    console.error(
      `\n✗ ${unmatched.size} team name(s) did not resolve to a club — refusing to write:`,
    );
    for (const n of unmatched) console.error(`   "${n}"`);
    process.exitCode = 1;
    return;
  }

  // ── Venues: Premier T20 pair-map ──
  for (const b of built) {
    if (
      b.series.id !== `${ID_PREFIX}premier-men-t20-1` &&
      b.series.id !== `${ID_PREFIX}premier-men-t20-2`
    )
      continue;
    const teamToClub = new Map(b.series.participants!.map((p) => [p.teamId, p.clubId]));
    b.fixtures.forEach((f, i) => {
      const rawFixture = b.raw[i];
      const key = pairKey(rawFixture.homeName, rawFixture.awayName);
      const pm = flat.premierPairs.get(key);
      if (!pm) {
        console.error(
          `✗ no REVISED venue found for ${rawFixture.homeName} v ${rawFixture.awayName} (should be impossible after the symmetry check)`,
        );
        process.exitCode = 1;
        return;
      }
      const homeClubId = teamToClub.get(f.home);
      const awayClubId = teamToClub.get(f.away);
      const homeAllocated = homeClubId
        ? allocatedGroundName(homeClubId, clubsById, reBaseMap)
        : undefined;
      const awayAllocated = awayClubId
        ? allocatedGroundName(awayClubId, clubsById, reBaseMap)
        : undefined;
      applyExplicitVenue(
        f,
        pm.venue,
        homeAllocated,
        awayAllocated,
        byNormVenue,
        'Union T20 schedule — pair-map venue',
        registryMiss,
      );
    });
  }
  if (process.exitCode) return;

  // ── Venues: everything else — re-based clubs get an explicit venue, others stay
  // implicit (the UI falls back to the home team's ground), and a barred implicit
  // ground fails closed. ──
  for (const b of built) {
    const slug = b.series.id.slice(ID_PREFIX.length);
    if (
      slug === 'premier-men-t20-1' ||
      slug === 'premier-men-t20-2' ||
      slug.startsWith('promotion-men-t20-g')
    )
      continue;
    const teamToClub = new Map(b.series.participants!.map((p) => [p.teamId, p.clubId]));
    for (const f of b.fixtures) {
      const homeClubId = teamToClub.get(f.home);
      const homeClub = homeClubId ? clubsById.get(homeClubId) : undefined;
      if (!homeClub) continue;
      const rebased = reBaseMap.get(homeClub.id);
      if (rebased) {
        // Status is 'alternative', not 'home': the re-based ground is the club's
        // ALLOCATED season ground but not its registered one, and the admin console
        // only surfaces venueReason (the "why") when the status isn't 'home'.
        setVenue(
          f,
          rebased,
          'alternative',
          `Allocated ground — ${homeClub.ground?.venue ?? 'unlisted'} barred/unlisted`,
          byNormVenue,
          registryMiss,
        );
      } else {
        const own = homeClub.ground?.venue;
        if (own && barredGrounds.has(normaliseGround(own))) {
          console.error(
            `✗ ${b.series.id} fixture ${f.id}: home club "${homeClub.name}"'s ground "${own}" is barred with no allocation on the Venue Allocations sheet.`,
          );
          process.exitCode = 1;
        } else {
          implicitGroundReport.push(
            `${b.series.id} ${f.id}: ${homeClub.name}${own ? ` (${own})` : ' (no ground set)'}`,
          );
        }
      }
    }
  }
  if (process.exitCode) return;

  console.log(
    `\n── Implicit-venue fixtures (home ground, no explicit venue written): ${implicitGroundReport.length}`,
  );
  for (const line of implicitGroundReport.slice(0, 20)) console.log(`  ${line}`);
  if (implicitGroundReport.length > 20)
    console.log(`  … and ${implicitGroundReport.length - 20} more`);

  if (registryMiss.size) {
    console.log(
      `\n── Venue registry misses (${registryMiss.size}) — written as venueOverride, not locked:`,
    );
    for (const g of registryMiss) console.log(`  "${g}"`);
    // The full registry, so VENUE_ALIASES can be authored straight from this report —
    // a miss is usually the sheet's short name for a ground the registry stores under
    // the club record's fuller spelling.
    console.log(`\n── Venue registry (${venues.length} ground(s)) — alias misses onto these:`);
    for (const v of [...venues].sort((a, b) => a.name.localeCompare(b.name))) {
      const pinned = Number.isFinite(v.lat) && Number.isFinite(v.lon) ? 'pinned' : 'no pin';
      console.log(
        `  ${v.name}  (${v.id} · ${Math.max(1, Number(v.surfaces) || 1)} surface(s) · ${pinned})`,
      );
    }
  }

  const suffixNotes = reportSuffixMixing(usage);
  if (suffixNotes.length) {
    console.log(`\n── Suffixed/unsuffixed usage warnings (${suffixNotes.length}):`);
    for (const n of suffixNotes) console.log(`  ⚠ ${n}`);
  }

  // ── Season-wide clash pass ── existingOther excludes both this run's own writes AND
  // the DELETE_SLUGS series (about to be pruned — see runClashPass) — and only strips
  // ID_PREFIX for ids that actually carry it (finding #9: a foreign id's raw string
  // must never be mistaken for a stale planb slug).
  const writtenSlugs = new Set(built.map((b) => b.series.id.slice(ID_PREFIX.length)));
  const existingOther = existingSeries.filter((s) => {
    const slug = seriesSlug(s.id);
    return !slug || !writtenSlugs.has(slug);
  });
  const {
    unresolved: clashes,
    autoMoves,
    skippedUndeterminable,
  } = runClashPass(
    built,
    existingOther,
    clubsById,
    reBaseMap,
    args.allowClashes,
    byNormVenue,
    registryMiss,
    barredGrounds,
  );
  console.log(`\n── Season-wide venue clash pass`);
  if (autoMoves.length) {
    console.log(`  ${autoMoves.length} auto-move(s) (moved to the other side's allocated ground):`);
    for (const m of autoMoves) console.log(`    ${m}`);
  }
  if (clashes.length) {
    console.log(`  ✗ ${clashes.length} unresolved clash(es):`);
    for (const c of clashes) console.log(`    ${c}`);
  } else {
    console.log('  ✓ no unresolved clashes');
  }
  console.log(`  skipped, ground undeterminable: ${skippedUndeterminable}`);

  // ── Reconciliation safety rails ──
  let deleteSet: string[];
  try {
    deleteSet = assertDeleteSet(
      existingSeries.map((s) => String(s.id)),
      writtenSlugs,
    );
  } catch (err) {
    console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\n── DELETE set (run --prune after releasing): ${deleteSet.map((s) => `${ID_PREFIX}${s}`).join(', ')}`,
  );

  const editNotes: string[] = [];
  const dateTimeInfoNotes: string[] = [];
  for (const b of built) {
    const existing = existingSeries.find((s) => s.id === b.series.id);
    if (existing) {
      const { genuine, informational } = diffAdminEdits(existing, b.series);
      editNotes.push(...genuine);
      dateTimeInfoNotes.push(...informational);
    }
  }
  if (editNotes.length) {
    console.log(
      `\n── Admin-edit diff — GENUINE edits (${editNotes.length} note(s), gates --discard-edits):`,
    );
    for (const n of editNotes) console.log(`  ${n}`);
  }
  if (dateTimeInfoNotes.length) {
    // Informational only — never gates the write. See diffAdminEdits' doc comment for
    // why an id-based date/time diff can't distinguish an import amendment from an
    // admin correction.
    console.log(
      `\n── Date/time differences — INFORMATIONAL only (${dateTimeInfoNotes.length} note(s)):`,
    );
    for (const n of dateTimeInfoNotes) console.log(`  ${n}`);
  }

  let abort = false;
  if (suffixNotes.length) {
    // A club appearing both plain and lettered in one league is ambiguous — it is
    // undecidable whether the plain name means the A side, so a confidently wrong
    // roster would be written. Fail closed; fix the sheet (or the manifest) instead.
    console.error(
      '\n✗ suffixed/unsuffixed team ambiguity (see warnings above) — refusing to write.',
    );
    abort = true;
  }
  if (clashes.length && !args.allowClashes) {
    console.error(
      '\n✗ unresolved venue clashes — refusing to write (pass --allow-clashes to write anyway and fix in the console).',
    );
    abort = true;
  }
  if (missingLeagueKeys.length && args.confirm) {
    console.error(
      `\n✗ league key(s) not configured on the tenant: ${missingLeagueKeys.join(', ')} — create them first.`,
    );
    abort = true;
  }
  if (editNotes.length && !args.discardEdits) {
    console.error(
      '\n✗ existing series carry admin edits — refusing to overwrite (pass --discard-edits to overwrite anyway).',
    );
    abort = true;
  }
  if (abort) {
    process.exitCode = 1;
    return;
  }

  console.log(`\n${built.length} series to write.`);
  if (!args.confirm) {
    console.log('[dry-run] nothing written. Re-run with --confirm to import.');
    return;
  }

  const backupPath = await backupExistingSeries(repo);
  for (const b of built) {
    const s = b.series;
    const existing = await repo.getSeries(TENANT, s.id);
    if (existing) {
      s.approved = existing.approved ?? s.approved;
      s.approvedAt = existing.approvedAt ?? null;
      s.released = existing.released ?? false;
      s.releasedAt = existing.releasedAt ?? null;
      s.version = (Number(existing.version) || 1) + 1;
    }
    await repo.putSeries(TENANT, s);
    console.log(
      `wrote ${s.id}  v${s.version}${existing ? ' (overwrote, lifecycle preserved)' : ''}`,
    );
  }
  console.log(
    `Done. Backup: ${backupPath}. New series are DRAFTS — approve and release from the admin console. Run --prune --confirm AFTER releasing to remove the superseded series.`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'import') return runImport(args);
  const repo = await import('./repo.js');
  if (args.mode === 'prune') return runPrune(repo, args.confirm);
  return runRevert(repo, args.all, args.confirm);
}

// Guard the entry point so importing this module (e.g. from a test file, to reach the
// pure helpers) never runs main() as a side effect of module load.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}

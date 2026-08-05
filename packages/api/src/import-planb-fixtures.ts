/**
 * Plan B fixture import — load the union's hand-built fixture spreadsheet into a
 * tenant's Series rows, reversibly.
 *
 *   npx sst shell --stage prod -- npx tsx src/import-planb-fixtures.ts --file "<xlsx>"            # dry-run
 *   npx sst shell --stage prod -- npx tsx src/import-planb-fixtures.ts --file "<xlsx>" --confirm  # write
 *   npx sst shell --stage prod -- npx tsx src/import-planb-fixtures.ts --revert                   # dry-run revert
 *   npx sst shell --stage prod -- npx tsx src/import-planb-fixtures.ts --revert --confirm         # delete imports
 *
 * WHY THIS EXISTS — the structured season machinery (ADR 0008) can generate all of
 * these fixtures, but the union supplied a finished schedule before there was time to
 * configure and test the structures on prod. This script loads that schedule as plain
 * Series rows so clubs see real fixtures now, while keeping the door open: every series
 * it writes has a deterministic `s-planb-*` id, so `--revert` removes exactly the
 * imported set and the season machinery can take over cleanly.
 *
 * Fail-closed by design: a team name that doesn't resolve to a club, or a section the
 * sheet marks as unresolved ("Clarity"), aborts the write — a confidently wrong fixture
 * list on prod is worse than an incomplete one. Imported series land UNRELEASED: the
 * admin approves and releases them from the console, so the normal governance flow (and
 * nothing else — direct writes never email anyone) is what makes them visible.
 */
import ExcelJS from 'exceljs';
import * as repo from './repo.js';
import type { Series } from './types.js';

type SeriesParticipant = NonNullable<Series['participants']>[number];

const TENANT = 'dolphins';
const ID_PREFIX = 's-planb-';
/** Any fixture dated before this in Jan–Jun is a "26" typo for "27" — the season's
 * second half. Corrected with a printed report rather than imported as history. */
const SEASON_START = '2026-08-01';

interface SectionSpec {
  /** Matches the section-header cell, case-insensitive. */
  match: RegExp;
  slug: string;
  label: string;
  leagueKey: string;
  seriesType: string;
  maxOvers: number;
  /** Present ⇒ the sheet itself says this section isn't settled; rows are skipped. */
  skip?: string;
}

/** One entry per section header in the workbook. Order within a sheet matters only for
 * reporting; headers are matched wherever they appear. */
const SECTIONS: Record<string, SectionSpec[]> = {
  'Premier Men': [
    { match: /^top 6: ?t20/i, slug: 'premier-men-t20-top6', label: 'T20 · Top 6', leagueKey: 'premier', seriesType: 'Twenty20 (16-25 overs)', maxOvers: 20 },
    { match: /^bottom 6: ?t20/i, slug: 'premier-men-t20-bottom6', label: 'T20 · Bottom 6', leagueKey: 'premier', seriesType: 'Twenty20 (16-25 overs)', maxOvers: 20 },
    { match: /^top 6: ?50 over/i, slug: 'premier-men-50ov-top6', label: '50 Over · Top 6', leagueKey: 'premier', seriesType: 'One-Day (40-50 overs)', maxOvers: 50 },
    { match: /^bottom 6: ?50 over/i, slug: 'premier-men-50ov-bottom6', label: '50 Over · Bottom 6', leagueKey: 'premier', seriesType: 'One-Day (40-50 overs)', maxOvers: 50 },
  ],
  'Promotion Men': [
    { match: /^group 1 t20/i, slug: 'promotion-men-t20-g1', label: 'T20 · Group 1', leagueKey: 'promotion', seriesType: 'Twenty20 (16-25 overs)', maxOvers: 20 },
    { match: /^group 2 t20/i, slug: 'promotion-men-t20-g2', label: 'T20 · Group 2', leagueKey: 'promotion', seriesType: 'Twenty20 (16-25 overs)', maxOvers: 20 },
    { match: /^group 3 t20/i, slug: 'promotion-men-t20-g3', label: 'T20 · Group 3', leagueKey: 'promotion', seriesType: 'Twenty20 (16-25 overs)', maxOvers: 20 },
    { match: /^group 4 t20/i, slug: 'promotion-men-t20-g4', label: 'T20 · Group 4', leagueKey: 'promotion', seriesType: 'Twenty20 (16-25 overs)', maxOvers: 20 },
    { match: /^30 over ?: ?top 10/i, slug: 'promotion-men-30ov-top10', label: '30 Over · Top 10', leagueKey: 'promotion', seriesType: 'One-Day (40-50 overs)', maxOvers: 30 },
    { match: /^30 over ?: ?bottom 10/i, slug: 'promotion-men-30ov-bottom10', label: '30 Over · Bottom 10', leagueKey: 'promotion', seriesType: 'One-Day (40-50 overs)', maxOvers: 30 },
    { match: /^50 over ?: ?group 1/i, slug: 'promotion-men-50ov-g1', label: '50 Over · Group 1', leagueKey: 'promotion', seriesType: 'One-Day (40-50 overs)', maxOvers: 50 },
    { match: /^50 over group 2/i, slug: 'promotion-men-50ov-g2', label: '50 Over · Group 2', leagueKey: 'promotion', seriesType: 'One-Day (40-50 overs)', maxOvers: 50 },
    { match: /kingsmead cup/i, slug: 'promotion-men-kingsmead', label: 'Kingsmead Cup', leagueKey: 'promotion', seriesType: 'One-Day (40-50 overs)', maxOvers: 50, skip: 'sheet marks it "(Clarity)"' },
  ],
  'Premier Women ': [
    { match: /^t20 premier women top 4/i, slug: 'premier-women-t20-top4', label: 'T20 · Top 4', leagueKey: 'premierWomen', seriesType: 'Twenty20 (16-25 overs)', maxOvers: 20 },
    { match: /^t20 premier women bottom 4/i, slug: 'premier-women-t20-bottom4', label: 'T20 · Bottom 4', leagueKey: 'premierWomen', seriesType: 'Twenty20 (16-25 overs)', maxOvers: 20 },
    { match: /^30 over league top 4/i, slug: 'premier-women-30ov-top4', label: '30 Over · Top 4', leagueKey: 'premierWomen', seriesType: 'One-Day (40-50 overs)', maxOvers: 30 },
    { match: /^30 over bottom 4/i, slug: 'premier-women-30ov-bottom4', label: '30 Over · Bottom 4', leagueKey: 'premierWomen', seriesType: 'One-Day (40-50 overs)', maxOvers: 30 },
  ],
  // 'Promotion Womens' and 'Veterans' sheets are empty in the source — nothing to match.
};

/** Sheet names that collapse to different clubs than plain normalisation reaches. */
const NAME_ALIASES: Record<string, string> = {
  chatsworthsporting: 'hollywoodbets-chatsworth-sporting',
  simplex: 'simplex-reservoir-hills-crimson',
  dut: 'durban-university-of-technology-dut',
  meadowridge: 'meadowridge-sporting-cricket-club',
  rhythmdhs: 'rhythm-dhsob-cricket-club',
};

/** Lowercase, strip punctuation, drop the generic cricket-club suffix words. Keeps
 * distinguishing words ("sporting", "united") — Chatsworth Sporting must not collide
 * with Chatsworth United, and Spartan Sporting must stay distinct. */
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !['cricket', 'club', 'clube', 'cc', 'association'].includes(w))
    .join('');
}

function isoDate(v: unknown): string | null {
  if (v instanceof Date) {
    // exceljs hands back UTC-midnight Date objects for date cells.
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

function cellText(v: unknown): string {
  if (v == null || v instanceof Date) return '';
  if (typeof v === 'object' && 'richText' in (v as object))
    return (v as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join('');
  return String(v).trim();
}

interface ParsedFixture {
  round: number;
  date: string;
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
    const ws = wb.getWorksheet(sheetName);
    if (!ws) throw new Error(`sheet "${sheetName}" not found in the workbook`);
    let current: ParsedSection | null = null;
    let round = 0;
    let date: string | null = null;

    ws.eachRow((row) => {
      const values: unknown[] = [];
      for (let c = 1; c <= 6; c++) values.push(row.getCell(c).value);
      const a = cellText(values[0]);
      const isFixtureRow = cellText(values[2]).toLowerCase() === 'v';

      // A matched header starts a section. Any OTHER non-week, non-fixture header text
      // ("Finals", an unknown new section…) ENDS the current one — without this, rows
      // under a header the manifest doesn't know about silently leak into the previous
      // section (exactly how "30 Over: Top 10" first vanished into T20 Group 4).
      const spec = specs.find((s) => s.match.test(a));
      if (spec) {
        current = { spec, fixtures: [], skippedRows: [], dateCorrections: [] };
        out.push(current);
        round = 0;
        date = null;
        return;
      }
      if (a && !isFixtureRow && !/^week/i.test(a)) {
        current = null;
        return;
      }
      // A fixture row with no live section is a manifest gap — fail closed, loudly.
      if (isFixtureRow && !current && !/semi|final/i.test(a)) {
        orphans.push(`${sheetName}: ${a} v ${cellText(values[3]) || cellText(values[4])}`);
        return;
      }

      // The sheet's merged cells scatter the week date: usually column E on the "Week N"
      // row, but sometimes on the FIRST FIXTURE row below it. Any date cell in any
      // column updates the running date for subsequent fixtures.
      for (const v of values) {
        const d = isoDate(v);
        if (d) date = d;
      }

      const week = a.match(/^week\s+(\d+)/i);
      if (week) {
        round = Number(week[1]);
        return;
      }
      if (!current) return;

      // Fixture rows read "Home | | v | Away?" with away in column D or E.
      if (!isFixtureRow || !current) return;
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
      current.fixtures.push({ round, date: fixed, homeName: a, awayName: away });
    });
  }
  return { sections: out, orphans };
}

function parseArgs(argv: string[]) {
  const args = { file: '', confirm: false, revert: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i] ?? '';
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--revert') args.revert = true;
    else throw new Error(`unknown flag ${a}`);
  }
  if (!args.revert && !args.file) throw new Error('--file <xlsx> is required (or --revert)');
  return args;
}

async function revert(confirm: boolean) {
  const all = await repo.listSeries(TENANT);
  const mine = all.filter((s) => String(s.id).startsWith(ID_PREFIX));
  if (mine.length === 0) {
    console.log('Nothing to revert — no s-planb-* series found.');
    return;
  }
  for (const s of mine) {
    const status = s.released ? 'RELEASED' : s.approved ? 'approved' : 'draft';
    console.log(`${confirm ? 'delete' : '[dry-run] would delete'}  ${s.id}  (${s.name} · ${status})`);
    if (confirm) await repo.deleteSeries(TENANT, String(s.id));
  }
  console.log(
    confirm
      ? `Reverted ${mine.length} imported series.`
      : `Re-run with --confirm to delete these ${mine.length} series.`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.revert) return revert(args.confirm);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(args.file);
  const { sections, orphans } = parseWorkbook(wb);
  if (orphans.length) {
    console.error(`✗ ${orphans.length} fixture row(s) fall under section headers the manifest doesn't know — refusing to continue:`);
    for (const o of orphans) console.error(`   ${o}`);
    process.exitCode = 1;
    return;
  }

  const clubs = await repo.listClubs(TENANT);
  const config = await repo.getTenantConfig(TENANT);
  const leagueLabel = (key: string) =>
    (config?.leagues ?? []).find((l) => l.key === key)?.label ?? key;
  const byNorm = new Map<string, (typeof clubs)[number]>();
  for (const c of clubs) {
    byNorm.set(normalise(c.name), c);
    byNorm.set(normalise(c.id), c);
  }
  const resolve = (name: string) => {
    const n = normalise(name);
    const aliased = NAME_ALIASES[n];
    return aliased ? clubs.find((c) => c.id === aliased) : byNorm.get(n);
  };

  const unmatched = new Set<string>();
  let totalFixtures = 0;
  const writes: Series[] = [];

  for (const section of sections) {
    const { spec } = section;
    console.log(`\n── ${spec.slug}  (${leagueLabel(spec.leagueKey)} · ${spec.label})`);
    if (spec.skip) {
      console.log(`  SKIPPED — ${spec.skip}`);
      continue;
    }
    for (const c of section.dateCorrections) console.log(`  date corrected: ${c}`);
    for (const r of section.skippedRows) console.log(`  row skipped: ${r}`);
    if (section.fixtures.length === 0) {
      console.log('  no concrete fixtures — nothing to import');
      continue;
    }

    const clubIds: string[] = [];
    const participants: SeriesParticipant[] = [];
    const fixtures = section.fixtures.map((f, i) => {
      const home = resolve(f.homeName);
      const away = resolve(f.awayName);
      if (!home) unmatched.add(f.homeName);
      if (!away) unmatched.add(f.awayName);
      for (const c of [home, away]) {
        if (c && !clubIds.includes(c.id)) {
          clubIds.push(c.id);
          const ground = (c as { ground?: { venue?: string; lat?: number; lon?: number } }).ground ?? {};
          // Single side per club, teamId === clubId — the legacy convention
          // clubTeamsForLeague uses for clubs without per-league team rosters.
          participants.push({
            teamId: c.id,
            clubId: c.id,
            name: c.name,
            ...(ground.venue ? { venue: ground.venue } : {}),
            ...(Number.isFinite(ground.lat) ? { lat: ground.lat as number } : {}),
            ...(Number.isFinite(ground.lon) ? { lon: ground.lon as number } : {}),
          });
        }
      }
      return { id: `f${i + 1}`, round: f.round, date: f.date, home: home?.id ?? f.homeName, away: away?.id ?? f.awayName };
    });

    const dates = fixtures.map((f) => f.date).sort();
    totalFixtures += fixtures.length;
    console.log(`  ${fixtures.length} fixtures · ${clubIds.length} sides · ${dates[0]} → ${dates[dates.length - 1]}`);

    writes.push({
      id: `${ID_PREFIX}${spec.slug}`,
      name: `${leagueLabel(spec.leagueKey)} · ${spec.label}`,
      leagueKey: spec.leagueKey,
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      dateMode: 'reference',
      teams: clubIds,
      participants,
      fixtures,
      maxOvers: spec.maxOvers,
      seriesType: spec.seriesType,
      kind: 'series',
      // Drafts on purpose: the admin approves and releases from the console, so the
      // normal governance flow is what puts these in front of clubs.
      approved: false,
      released: false,
      releasedAt: null,
      version: 1,
    } as Series);
  }

  if (unmatched.size) {
    console.error(`\n✗ ${unmatched.size} team name(s) did not resolve to a club — refusing to write:`);
    for (const n of unmatched) console.error(`   "${n}"`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n${writes.length} series · ${totalFixtures} fixtures total.`);
  if (!args.confirm) {
    console.log('[dry-run] nothing written. Re-run with --confirm to import.');
    return;
  }
  for (const s of writes) {
    // Overwrites are re-imports of the same deterministic id. Preserve the release
    // lifecycle the admin may have advanced, and keep version monotonic so the app's
    // conditional updates never see it go backwards.
    const existing = await repo.getSeries(TENANT, String(s.id));
    if (existing) {
      s.approved = existing.approved ?? s.approved;
      s.approvedAt = existing.approvedAt ?? null;
      s.released = existing.released;
      s.releasedAt = existing.releasedAt;
      s.version = (Number(existing.version) || 1) + 1;
    }
    await repo.putSeries(TENANT, s);
    console.log(`wrote ${s.id}  v${s.version}${existing ? ' (overwrote, lifecycle preserved)' : ''}`);
  }
  console.log('Done. Series are DRAFTS — approve and release them from the admin console.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

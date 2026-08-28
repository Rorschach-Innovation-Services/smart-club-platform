/**
 * READ-ONLY comparison tool — diffs the KZNCU fixture spreadsheets against a LOCAL JSON
 * export of the prod platform's Plan B series. Touches no AWS/DynamoDB: both the sheets
 * and the platform state come from files on disk.
 *
 *   npx tsx src/compare-planb-fixtures.ts \
 *     --file "<Dolphins xlsx>" --t20 "<REVISED xlsx>" \
 *     --series-json <prod-series Query JSON> --clubs-json <prod-clubs Query JSON>
 *
 * The JSON inputs are raw DynamoDB Query output ({"Items":[{attr:{S:…}}…]}), unmarshalled
 * here. The incoming (sheet) series are built EXACTLY the way import-planb-fixtures.ts's
 * main() builds them — reusing that module's parsing/resolution machinery — but nothing
 * aborts: this is a report, not a write gate. Exit code is always 0.
 */
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
  parseWorkbook,
  parseFlatT20,
  buildSeries,
  buildClubIndex,
  pairKey,
  type ParsedFixture,
  type SeriesSpec,
  type BuiltSeries,
  type WrittenFixture,
  type SuffixUsage,
  type ResolutionLog,
} from './import-planb-fixtures.js';
import type { Club, Series } from './types.js';

const ID_PREFIX = 's-planb-';
const KEEP_LIST = ['promotion-men-50ov-g1', 'promotion-men-50ov-g2'];
/** Slugs whose sheet venues we can compare (Premier T20 via pair-map, Promotion T20 by
 * index). Every other series carries no sheet venue, so venue comparison is skipped. */
const T20_VENUE_SLUGS = new Set([
  'premier-men-t20-1',
  'premier-men-t20-2',
  'promotion-men-t20-g1',
  'promotion-men-t20-g2',
  'promotion-men-t20-g3',
  'promotion-men-t20-g4',
]);

// ───────────────────────── Args ─────────────────────────

interface Args {
  file: string;
  t20: string;
  seriesJson: string;
  clubsJson: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const file = get('--file');
  const t20 = get('--t20');
  const seriesJson = get('--series-json');
  const clubsJson = get('--clubs-json');
  if (!file || !t20 || !seriesJson || !clubsJson) {
    throw new Error(
      'usage: --file <Dolphins xlsx> --t20 <REVISED xlsx> --series-json <path> --clubs-json <path>',
    );
  }
  return { file, t20, seriesJson, clubsJson };
}

// ───────────────────────── Local export loading ─────────────────────────

/** DynamoDB Query output → plain objects, with the storage keys stripped. */
function loadItems(path: string): Record<string, unknown>[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { Items?: unknown[] };
  const items = Array.isArray(raw.Items) ? raw.Items : [];
  return items.map((it) => {
    const obj = unmarshall(it as Parameters<typeof unmarshall>[0]);
    delete obj.pk;
    delete obj.sk;
    delete obj.gsi1pk;
    delete obj.gsi1sk;
    return obj;
  });
}

// ───────────────────────── Prod fixture shape ─────────────────────────

interface ProdFixture {
  id?: string;
  round?: number;
  date?: string;
  time?: string;
  home: string;
  away: string;
  venueName?: string;
  venueOverride?: string;
  venueReason?: string;
  venueStatus?: string;
  status?: string;
  [k: string]: unknown;
}

type ParticipantName = (teamId: string) => string;

function nameLookup(series: {
  participants?: Array<{ teamId: string; name: string }>;
}): ParticipantName {
  const m = new Map<string, string>();
  for (const p of series.participants ?? []) m.set(p.teamId, p.name);
  return (teamId: string) => m.get(teamId) ?? teamId;
}

const AUTO_MOVE_PREFIXES = ['Union T20 schedule', 'Allocated ground —', 'Moved to avoid'];
function isAutoMove(reason: string | undefined): boolean {
  return !!reason && AUTO_MOVE_PREFIXES.some((p) => reason.startsWith(p));
}

const prodVenue = (f: ProdFixture): string => (f.venueOverride || f.venueName || '').trim();

// ───────────────────────── Fixture pairing ─────────────────────────

/** Sort a fixture list by (round, date, time) so double-round-robin pairs zip-align
 * deterministically on both sides. */
function sortFixtures<T extends { round?: number; date?: string; time?: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const r = (a.round ?? 0) - (b.round ?? 0);
    if (r) return r;
    const d = (a.date ?? '').localeCompare(b.date ?? '');
    if (d) return d;
    return (a.time ?? '').localeCompare(b.time ?? '');
  });
}

function groupByPair<T extends { home: string; away: string }>(list: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const f of list) {
    const k = pairKey(f.home, f.away);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(f);
  }
  return m;
}

// ───────────────────────── Report accumulator ─────────────────────────

interface SlugCounts {
  onlySheet: number;
  onlyPlatform: number;
  changed: number;
  venueDiffs: number;
}

const out: string[] = [];
const log = (s = '') => out.push(s);

// ───────────────────────── Diff one series ─────────────────────────

function diffSeries(
  slug: string,
  incoming: BuiltSeries,
  prod: Series,
  sheetVenueOf: Map<WrittenFixture, string>,
  rawOf: Map<WrittenFixture, ParsedFixture>,
): SlugCounts {
  const counts: SlugCounts = { onlySheet: 0, onlyPlatform: 0, changed: 0, venueDiffs: 0 };
  const lines: string[] = [];

  const inName = nameLookup(incoming.series);
  const prodName = nameLookup(
    prod as unknown as { participants?: Array<{ teamId: string; name: string }> },
  );
  const compareVenue = T20_VENUE_SLUGS.has(slug);

  // ── Team sets ──
  const inTeams = new Set(incoming.series.teams);
  const prodTeams = new Set((prod.teams ?? []) as string[]);
  const added = [...inTeams].filter((t) => !prodTeams.has(t));
  const removed = [...prodTeams].filter((t) => !inTeams.has(t));
  if (added.length)
    lines.push(
      `  teams added (sheet, not on platform): ${added.map((t) => `${inName(t)} [${t}]`).join(', ')}`,
    );
  if (removed.length)
    lines.push(
      `  teams removed (platform, not on sheet): ${removed.map((t) => `${prodName(t)} [${t}]`).join(', ')}`,
    );

  // ── Fixtures ──
  const prodFixtures = (prod.fixtures ?? []) as ProdFixture[];
  const inByPair = groupByPair(incoming.fixtures);
  const prodByPair = groupByPair(prodFixtures);
  const allKeys = new Set([...inByPair.keys(), ...prodByPair.keys()]);

  for (const key of allKeys) {
    const inList = sortFixtures(inByPair.get(key) ?? []);
    const prList = sortFixtures(prodByPair.get(key) ?? []);
    const n = Math.min(inList.length, prList.length);
    for (let i = 0; i < n; i++) {
      const a = inList[i];
      const b = prList[i];
      const label = `${inName(a.home)} v ${inName(a.away)}`;
      const diffs: string[] = [];
      if ((a.date ?? '') !== (b.date ?? '')) diffs.push(`date ${b.date ?? '—'} → ${a.date ?? '—'}`);
      if ((a.time ?? '') !== (b.time ?? '')) diffs.push(`time ${b.time ?? '—'} → ${a.time ?? '—'}`);
      if ((a.round ?? 0) !== (b.round ?? 0))
        diffs.push(`round ${b.round ?? '—'} → ${a.round ?? '—'}`);
      if (a.home === b.away && a.away === b.home && a.home !== b.home)
        diffs.push(
          `home/away orientation swapped (platform ${prodName(b.home)} v ${prodName(b.away)})`,
        );

      let venueDiff = false;
      if (compareVenue) {
        const sheetV = (sheetVenueOf.get(a) ?? '').trim();
        const pV = prodVenue(b);
        if (sheetV && sheetV !== pV) {
          venueDiff = true;
          const reason = b.venueReason;
          const tag = isAutoMove(reason) ? ' [import-authored auto-move]' : '';
          diffs.push(
            `venue "${pV || '—'}" → sheet "${sheetV}"${reason ? ` (platform reason: "${reason}"${tag})` : ''}`,
          );
        }
      }

      if (b.status && b.status !== 'scheduled')
        diffs.push(
          `⚠ platform fixture has status="${b.status}" (captured result — matters if moved/removed)`,
        );

      if (diffs.length) {
        lines.push(`  ~ ${label}: ${diffs.join('; ')}`);
        counts.changed++;
        if (venueDiff) counts.venueDiffs++;
      }
    }
    // Leftovers
    for (let i = n; i < inList.length; i++) {
      const a = inList[i];
      const raw = rawOf.get(a);
      const disp = raw
        ? `${raw.homeName} v ${raw.awayName}`
        : `${inName(a.home)} v ${inName(a.away)}`;
      lines.push(`  + only-in-sheet: R${a.round} ${a.date}${a.time ? ` ${a.time}` : ''}  ${disp}`);
      counts.onlySheet++;
    }
    for (let i = n; i < prList.length; i++) {
      const b = prList[i];
      lines.push(
        `  - only-on-platform: R${b.round ?? '—'} ${b.date ?? '—'}${b.time ? ` ${b.time}` : ''}  ${prodName(b.home)} v ${prodName(b.away)}`,
      );
      counts.onlyPlatform++;
    }
  }

  log(`── ${slug}`);
  if (lines.length === 0) log('  ✓ matches');
  else for (const l of lines) log(l);
  log();
  return counts;
}

// ───────────────────────── Main ─────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const dolphinsWb = new ExcelJS.Workbook();
  await dolphinsWb.xlsx.readFile(args.file);
  const t20Wb = new ExcelJS.Workbook();
  await t20Wb.xlsx.readFile(args.t20);

  const { sections, orphans } = parseWorkbook(dolphinsWb);
  const flat = parseFlatT20(t20Wb);

  const clubs = loadItems(args.clubsJson) as unknown as Club[];
  const prodSeriesList = loadItems(args.seriesJson) as unknown as Series[];
  const prodById = new Map<string, Series>();
  for (const s of prodSeriesList) prodById.set(String(s.id), s);

  const byNorm = buildClubIndex(clubs);
  const usage: SuffixUsage = { suffixed: new Set(), unsuffixed: new Set() };
  const unmatched = new Set<string>();
  const resolutions: ResolutionLog = new Map();
  const leagueLabel = (key: string) => key;

  // ── Build every incoming Series exactly as import-planb-fixtures.ts main() does ──
  const built: BuiltSeries[] = [];
  const sheetVenueOf = new Map<WrittenFixture, string>();
  const rawOf = new Map<WrittenFixture, ParsedFixture>();

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
    if (!b) continue;
    b.fixtures.forEach((f, i) => rawOf.set(f, b.raw[i]));
    built.push(b);
    // Premier Men T20 sheet venues come from the REVISED pair-map (unordered RAW pair).
    const slug = b.series.id.slice(ID_PREFIX.length);
    if (slug === 'premier-men-t20-1' || slug === 'premier-men-t20-2') {
      b.fixtures.forEach((f, i) => {
        const rawF = b.raw[i];
        const pm = flat.premierPairs.get(pairKey(rawF.homeName, rawF.awayName));
        if (pm?.venue) sheetVenueOf.set(f, pm.venue);
      });
    }
  }

  // Promotion Men T20 groups 1-4 come ENTIRELY from the REVISED file (index-aligned).
  for (let g = 1; g <= 4; g++) {
    const rows = (flat.promotionByGroup.get(g) ?? []).slice().sort((a, b) => a.matchNo - b.matchNo);
    if (rows.length === 0) continue;
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
      rawOf.set(f, b.raw[i]);
      if (rows[i]?.venue) sheetVenueOf.set(f, rows[i].venue);
    });
    built.push(b);
  }

  // ── Diff each sheet slug against its platform counterpart ──
  const perSlug: Array<{ slug: string; counts: SlugCounts }> = [];
  const sheetSlugs = new Set<string>();
  for (const b of built) {
    const slug = b.series.id.slice(ID_PREFIX.length);
    sheetSlugs.add(slug);
    const prod = prodById.get(`${ID_PREFIX}${slug}`);
    if (!prod) {
      log(`── ${slug}`);
      log('  ⚠ sheet-only series — no matching platform series');
      log();
      perSlug.push({
        slug,
        counts: { onlySheet: b.fixtures.length, onlyPlatform: 0, changed: 0, venueDiffs: 0 },
      });
      continue;
    }
    perSlug.push({ slug, counts: diffSeries(slug, b, prod, sheetVenueOf, rawOf) });
  }

  // ── Platform-only series ──
  log('── Platform-only series (no sheet counterpart)');
  let anyPlatformOnly = false;
  for (const s of prodSeriesList) {
    const id = String(s.id);
    const slug = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
    if (sheetSlugs.has(slug)) continue;
    anyPlatformOnly = true;
    const note = KEEP_LIST.includes(slug) ? ' (expected: keep-list)' : '';
    log(`  ${id}${note}`);
  }
  if (!anyPlatformOnly) log('  (none)');
  log();

  // ── Orphan rows & unresolved names ──
  log(`── Orphan sheet fixture rows (matched no section): ${orphans.length}`);
  for (const o of orphans) log(`  ${o}`);
  log();
  const unresolvedNames = [...unmatched].sort();
  log(`── Unresolved team names (no club match): ${unresolvedNames.length}`);
  for (const n of unresolvedNames) log(`  "${n}"`);
  log();

  // ── Summary table ──
  log('── Summary (per-slug difference counts)');
  const pad = (s: string, n: number) => s.padEnd(n);
  const padL = (s: string | number, n: number) => String(s).padStart(n);
  log(
    `  ${pad('slug', 30)} ${padL('only-sheet', 10)} ${padL('only-plat', 10)} ${padL('changed', 8)} ${padL('venue-diff', 11)}`,
  );
  const totals: SlugCounts = { onlySheet: 0, onlyPlatform: 0, changed: 0, venueDiffs: 0 };
  for (const { slug, counts } of perSlug) {
    totals.onlySheet += counts.onlySheet;
    totals.onlyPlatform += counts.onlyPlatform;
    totals.changed += counts.changed;
    totals.venueDiffs += counts.venueDiffs;
    log(
      `  ${pad(slug, 30)} ${padL(counts.onlySheet, 10)} ${padL(counts.onlyPlatform, 10)} ${padL(counts.changed, 8)} ${padL(counts.venueDiffs, 11)}`,
    );
  }
  log(
    `  ${pad('TOTAL', 30)} ${padL(totals.onlySheet, 10)} ${padL(totals.onlyPlatform, 10)} ${padL(totals.changed, 8)} ${padL(totals.venueDiffs, 11)}`,
  );
  log();
  log(`  orphan rows: ${orphans.length}   unresolved names: ${unresolvedNames.length}`);

  console.log(out.join('\n'));
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exitCode = 0; // report tool — never fail the shell
  });

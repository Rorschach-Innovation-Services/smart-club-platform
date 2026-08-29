/**
 * Read-only cohort export — dump a tenant's full club cohort (affiliation form data,
 * chair/exco details, coaches, CQI submissions) to a formatted .xlsx for analysis.
 *
 *   npx sst shell --stage prod -- npm --prefix packages/api run export-cohort -- dolphins
 *   … -- dolphins --out /tmp/dolphins.xlsx
 *
 * See docs/runbooks/export-cohort.md.
 *
 * Read-only: a single gsi1 query (`repo.listClubs`) + one config get, no DynamoDB writes.
 * `repo.listClubs` projects full Club items, so this needs no per-club fetch.
 *
 * WHY IT LIVES IN packages/api BUT IMPORTS FROM THE FRONTEND TREE: the CQI question
 * catalogue and the derive/score helpers (src/data.ts, src/cqiScore.ts) are the single
 * source of truth for scoring — reimplementing them here would drift. scoreCQI/cqiBand
 * were extracted out of atoms.tsx (React) into src/cqiScore.ts precisely so a Node CLI can
 * import them. Like seed-cohort.ts, this file is EXCLUDED from the strict api tsconfig and
 * type-checked under tsconfig.seed.json instead (that frontend tree is `strict: false`).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import * as repo from './repo.js';
import type { Club, TenantConfig } from './types.js';

// Scoring + catalogue from the frontend tree (pure TS — no React, no DOM). Same import
// mechanism seed-cohort.ts uses for src/competition/*.
import { CQI_STRUCTURE, effectiveAnswers } from '../../../src/data.js';
import { scoreCQI, cqiBand } from '../../../src/cqiScore.js';

/* ─────────────────────────── Safe accessors ───────────────────────────
   exco and coaches are untyped (Record<string, unknown> / unknown[]) and every
   affiliation field is optional, so nothing below assumes a shape. */

type Dict = Record<string, unknown>;
type Cell = string | number | null;

function asDict(v: unknown): Dict {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {};
}

/** Stringify for a cell — null/undefined become '', so blanks never render "undefined". */
function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(str).join(', ');
  return String(v);
}

/** A finite number, else '' — keeps non-numeric junk out of numeric columns. */
function numCell(v: unknown): Cell {
  if (v == null || v === '') return '';
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : '';
}

/** Round to one decimal (CQI scores are proportioned floats). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Whole years between a birthdate and today. */
function ageFrom(birth: Date, today: Date): number {
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

/**
 * Derive date of birth + age from a 13-digit South African ID number. The first 6
 * digits are YYMMDD; the century is inferred so the age lands in [16, 100], preferring
 * the 1900s when both centuries are plausible (club chairs are adults). Returns null
 * for anything that isn't a valid 13-digit ID resolving to a real, non-future date.
 */
export function dobFromRsaId(id: unknown): { dob: string; age: number } | null {
  const digits = String(id ?? '').replace(/\D/g, '');
  if (digits.length !== 13) return null;
  const yy = Number(digits.slice(0, 2));
  const mm = Number(digits.slice(2, 4));
  const dd = Number(digits.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  const today = new Date();
  // Candidates ordered 1900s then 2000s, so the first in-range hit prefers the 1900s.
  const candidates: Array<{ dob: string; age: number }> = [];
  for (const century of [1900, 2000]) {
    const year = century + yy;
    const birth = new Date(year, mm - 1, dd);
    // Date round-trip rejects impossible days (e.g. 30 Feb rolls into March).
    if (birth.getFullYear() !== year || birth.getMonth() !== mm - 1 || birth.getDate() !== dd) {
      continue;
    }
    if (birth.getTime() > today.getTime()) continue; // future birthdate
    const dob = `${String(year).padStart(4, '0')}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
    candidates.push({ dob, age: ageFrom(birth, today) });
  }
  return candidates.find((c) => c.age >= 16 && c.age <= 100) ?? null;
}

/** Chair's stated reason(s) for involvement — CQI `involvementReasons` (comma-joined),
 *  falling back to the exco chair's free-text `reasonForInvolvement`. Shared by the CQI
 *  Scores and Chair & Exco sheets so the two can't drift. */
function involvementReason(club: Club): string {
  const answers = asDict(club.cqiAnswers);
  const reasons = Array.isArray(answers.involvementReasons)
    ? answers.involvementReasons.map(str).filter(Boolean)
    : [];
  if (reasons.length) return reasons.join(', ');
  const chair = asDict(asDict(club.exco).chair);
  return str(chair.reasonForInvolvement);
}

/** league key → display label, from the tenant catalogue; falls back to the raw key. */
function leagueLabeler(config: TenantConfig | null): (key: string) => string {
  const labels = new Map<string, string>();
  for (const l of config?.leagues ?? []) labels.set(l.key, l.label);
  return (key: string) => labels.get(key) ?? key;
}

/* ─────────────────────────── Sheet writer ─────────────────────────── */

interface SheetSpec {
  name: string;
  headers: string[];
  rows: Cell[][];
}

function addSheet(wb: ExcelJS.Workbook, spec: SheetSpec): void {
  const ws = wb.addWorksheet(spec.name);
  ws.addRow(spec.headers);
  for (const r of spec.rows) ws.addRow(r);

  // Bold, frozen header row.
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // Filter dropdowns across the whole header.
  if (spec.headers.length > 0) {
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: spec.headers.length },
    };
  }

  // Auto-size each column by its longest cell, capped so a stray long address can't blow
  // the layout out to hundreds of characters wide.
  spec.headers.forEach((h, i) => {
    let maxLen = String(h).length;
    for (const r of spec.rows) {
      const v = r[i];
      const len = v == null ? 0 : String(v).length;
      if (len > maxLen) maxLen = len;
    }
    ws.getColumn(i + 1).width = Math.min(50, Math.max(10, maxLen + 2));
  });
}

/* ─────────────────────────── Answer formatting ─────────────────────────── */

/** Render a raw CQI answer for the answers sheet: yn → Yes/No, arrays joined, else as-is. */
function answerCell(v: unknown): Cell {
  if (v == null || v === '') return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return v.map(str).join(', ');
  return str(v);
}

/** A club counts as having a CQI submission if it stored any raw answers. Governance
 *  answers are DERIVED for every club, so scoring off effectiveAnswers alone would give a
 *  non-zero score to a club that never submitted — those rows must read blank, not 0. */
function hasCqiSubmission(club: Club): boolean {
  return Object.keys(asDict(club.cqiAnswers)).length > 0;
}

/* ─────────────────────────── Workbook builder ───────────────────────────
   Pure — no DynamoDB, no env. Exported so it can be smoke-tested with fabricated Club
   fixtures without standing up a table. */

export interface SheetCounts {
  clubs: number;
  exco: number;
  coaches: number;
  teams: number;
  cqiScores: number;
  cqiAnswers: number;
}

export function buildWorkbook(
  clubs: Club[],
  config: TenantConfig | null,
): { workbook: ExcelJS.Workbook; counts: SheetCounts } {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'export-cohort';
  wb.created = new Date();

  const label = leagueLabeler(config);

  // ── 1. Clubs & Affiliation ──
  const clubRows: Cell[][] = clubs.map((club) => {
    const ground = asDict(club.ground);
    const leagues = Array.isArray(club.leagues) ? club.leagues : [];
    const leagueTeams = asDict(club.leagueTeams);
    const teamsPerLeague = leagues
      .map((k) => {
        const count = Math.max(1, Number(leagueTeams[k]) || 1);
        return `${label(k)} ×${count}`;
      })
      .join(', ');
    return [
      str(club.name),
      str(club.district),
      str(club.affiliation),
      str(club.chair),
      str(club.sub),
      numCell(club.playerCount ?? club.players),
      numCell(club.teams),
      numCell(club.women),
      numCell(club.juniors),
      leagues.map((k) => label(k)).join(', '),
      teamsPerLeague,
      str(ground.venue),
      str(ground.address),
      str(ground.suburb),
      numCell(ground.lat),
      numCell(ground.lon),
      str(ground.secondaryVenue),
      str(ground.secondaryAddress),
      str(club.onboardedVia),
      str(club.onboardedAt),
    ];
  });
  addSheet(wb, {
    name: 'Clubs & Affiliation',
    headers: [
      'Club',
      'District',
      'Affiliation status',
      'Chair name',
      'Sub-union',
      'Players',
      'Senior teams',
      "Women's teams",
      'Junior teams',
      'Leagues',
      'Teams per league',
      'Ground venue',
      'Ground address',
      'Suburb',
      'Lat',
      'Lon',
      'Secondary venue',
      'Secondary address',
      'Onboarded via',
      'Onboarded at',
    ],
    rows: clubRows,
  });

  // ── 2. Chair & Exco ──
  // Named office-bearers plus any additional members, one row each. The last three
  // columns are chair-only governance fields; blank for everyone else.
  const OFFICE_ROLES: Array<[string, string]> = [
    ['chair', 'Chairperson'],
    ['sec', 'Secretary'],
    ['tre', 'Treasurer'],
    ['vc', 'Vice-chair'],
  ];
  const excoRows: Cell[][] = [];
  for (const club of clubs) {
    const exco = asDict(club.exco);
    const bearers: Array<{ role: string; isChair: boolean; m: Dict }> = [];
    for (const [key, role] of OFFICE_ROLES) {
      const raw = exco[key];
      if (raw && typeof raw === 'object') {
        bearers.push({ role, isChair: key === 'chair', m: asDict(raw) });
      }
    }
    const additional = Array.isArray(exco.additionalMembers) ? exco.additionalMembers : [];
    for (const raw of additional) {
      if (raw && typeof raw === 'object') {
        bearers.push({ role: 'Additional member', isChair: false, m: asDict(raw) });
      }
    }
    for (const { role, isChair, m } of bearers) {
      const dob = isChair ? dobFromRsaId(m.idNumber) : null;
      excoRows.push([
        str(club.name),
        role,
        str(m.name),
        str(m.cell),
        str(m.email),
        str(m.gender),
        str(m.race),
        isChair ? str(m.idNumber) : '',
        isChair ? str(m.termStart) : '',
        isChair ? str(m.termEnd) : '',
        dob ? dob.dob : '',
        dob ? dob.age : '',
        isChair ? involvementReason(club) : '',
      ]);
    }
  }
  addSheet(wb, {
    name: 'Chair & Exco',
    headers: [
      'Club',
      'Role',
      'Name',
      'Cell',
      'Email',
      'Gender',
      'Race',
      'ID number',
      'Term start',
      'Term end',
      'Date of birth',
      'Age',
      'Reason for involvement',
    ],
    rows: excoRows,
  });

  // ── 3. Coaches ──
  const coachRows: Cell[][] = [];
  for (const club of clubs) {
    const coaches = Array.isArray(club.coaches) ? club.coaches : [];
    for (const raw of coaches) {
      const c = asDict(raw);
      const teams = Array.isArray(c.teams) ? c.teams.map((t) => label(String(t))).join(', ') : '';
      coachRows.push([
        str(club.name),
        str(c.name),
        str(c.body),
        str(c.level),
        str(c.status),
        str(c.cell),
        str(c.email),
        str(c.idNumber),
        str(c.yearStarted),
        str(c.yearsExperience),
        teams,
      ]);
    }
  }
  addSheet(wb, {
    name: 'Coaches',
    headers: [
      'Club',
      'Name',
      'Accreditation body',
      'Level',
      'Status',
      'Cell',
      'Email',
      'ID number',
      'Year started',
      'Years experience',
      'Teams',
    ],
    rows: coachRows,
  });

  // ── 4. Teams & Rosters ──
  const teamRows: Cell[][] = [];
  for (const club of clubs) {
    const rosters = asDict(club.teamRosters);
    for (const [leagueKey, roster] of Object.entries(rosters)) {
      if (!Array.isArray(roster)) continue;
      for (const raw of roster) {
        const t = asDict(raw);
        teamRows.push([
          str(club.name),
          label(leagueKey),
          str(t.name),
          str(t.venue),
          str(t.address),
          numCell(t.lat),
          numCell(t.lon),
        ]);
      }
    }
  }
  addSheet(wb, {
    name: 'Teams & Rosters',
    headers: ['Club', 'League', 'Team name', 'Venue', 'Address', 'Lat', 'Lon'],
    rows: teamRows,
  });

  // ── 5. CQI Scores ──
  const cqiScoreHeaders = ['Club', 'Chair', 'Stored score', 'Recomputed total', 'Band'];
  for (const cat of CQI_STRUCTURE) {
    cqiScoreHeaders.push(`${cat.title} earned`, `${cat.title} possible`);
  }
  cqiScoreHeaders.push('Involvement reasons');

  const cqiScoreRows: Cell[][] = clubs.map((club) => {
    const submitted = hasCqiSubmission(club);
    const involvement = involvementReason(club);

    const row: Cell[] = [str(club.name), str(club.chair)];
    if (submitted) {
      const score = scoreCQI(effectiveAnswers(club as never));
      row.push(numCell(club.cqi), round1(score.total), cqiBand(score.total).label);
      for (const cat of CQI_STRUCTURE) {
        const cell = score.byCat[cat.key];
        row.push(cell ? round1(cell.earned) : '', cell ? round1(cell.possible) : '');
      }
    } else {
      // No submission → blank score columns (not 0), matching the "Pending" band the UI shows.
      row.push('', '', '');
      for (let i = 0; i < CQI_STRUCTURE.length; i++) row.push('', '');
    }
    row.push(involvement);
    return row;
  });
  addSheet(wb, { name: 'CQI Scores', headers: cqiScoreHeaders, rows: cqiScoreRows });

  // ── 6. CQI Answers (raw) ──
  // One column per question across every category; clubs with no submission are blank rows.
  const questionCols: Array<{ header: string; key: string }> = [];
  for (const cat of CQI_STRUCTURE) {
    for (const q of cat.questions) {
      questionCols.push({ header: `${cat.title}: ${q.label}`, key: q.key });
    }
  }
  const answerRows: Cell[][] = clubs.map((club) => {
    const row: Cell[] = [str(club.name)];
    if (!hasCqiSubmission(club)) {
      for (let i = 0; i < questionCols.length; i++) row.push('');
      return row;
    }
    const eff = effectiveAnswers(club as never);
    for (const col of questionCols) row.push(answerCell(eff[col.key]));
    return row;
  });
  addSheet(wb, {
    name: 'CQI Answers (raw)',
    headers: ['Club', ...questionCols.map((c) => c.header)],
    rows: answerRows,
  });

  return {
    workbook: wb,
    counts: {
      clubs: clubRows.length,
      exco: excoRows.length,
      coaches: coachRows.length,
      teams: teamRows.length,
      cqiScores: cqiScoreRows.length,
      cqiAnswers: answerRows.length,
    },
  };
}

/* ─────────────────────────── CLI ─────────────────────────── */

interface Args {
  tenant: string;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const [tenant, ...rest] = argv;
  if (!tenant || tenant.startsWith('--')) {
    throw new Error('usage: export-cohort <tenant> [--out <path>]');
  }
  const args: Args = { tenant };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--out') {
      const val = rest[++i];
      if (!val) throw new Error('--out needs a path');
      args.out = val;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const [clubs, config] = await Promise.all([
    repo.listClubs(args.tenant),
    repo.getTenantConfig(args.tenant),
  ]);
  const sorted = [...clubs].sort((a, b) => str(a.name).localeCompare(str(b.name)));

  const { workbook, counts } = buildWorkbook(sorted, config);

  const date = new Date().toISOString().slice(0, 10);
  const outPath = args.out
    ? path.resolve(args.out)
    : path.resolve(process.cwd(), `cohort-export-${args.tenant}-${date}.xlsx`);
  await workbook.xlsx.writeFile(outPath);

  console.log(`✓ exported ${counts.clubs} clubs from tenant "${args.tenant}"`);
  console.log(`  Clubs & Affiliation : ${counts.clubs} rows`);
  console.log(`  Chair & Exco        : ${counts.exco} rows`);
  console.log(`  Coaches             : ${counts.coaches} rows`);
  console.log(`  Teams & Rosters     : ${counts.teams} rows`);
  console.log(`  CQI Scores          : ${counts.cqiScores} rows`);
  console.log(`  CQI Answers (raw)   : ${counts.cqiAnswers} rows`);
  console.log(`  → ${outPath}`);
}

// Only run as a CLI — the smoke test imports buildWorkbook directly, and an unguarded
// main() would parse the test runner's argv. Same guard as seed-cohort.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

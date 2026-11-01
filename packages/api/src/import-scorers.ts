/**
 * Scorer register import — load the union's "Digital scorers Database" workbook into the
 * tenant's SCORER# register (name, SA ID, phone, emergency contact, home address).
 * DRY-RUN by default:
 *
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run import-scorers -- \
 *     --tenant dolphins --file "<scorers>.xlsx"              # dry run: plan + report
 *   … --tenant dolphins --file "<scorers>.xlsx" --confirm    # write
 *
 * Sheet layout: a title row, then a header row (`No | Name | <surname> | ID Number |
 * Contact Number | Emergency contact number | Home address`) found by its "ID Number" cell;
 * columns are positional from there. Rows with no name are skipped (the sheet carries many
 * trailing empty rows).
 *
 * Matching: an ACTIVE scorer with the same name (findScorerNameClash) is never duplicated —
 * only its blank fields are filled; a non-blank value is never overwritten (a difference is
 * reported). A new scorer gets scorerIdFor(name), with a -2/-3… suffix on an id collision.
 * Idempotent: a re-run plans zero writes. Sends no notifications.
 *
 * The workbook holds PII (ID numbers, addresses): never commit it or fixtures derived from it.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';
import type { Scorer } from './types.js';
import { applyScorerInput, findScorerNameClash, scorerIdFor, type ScorerInput } from './scorers.js';

export interface ScorerRow {
  /** 1-based sheet row number, for the report. */
  line: number;
  displayName: string;
  idNumber?: string;
  phone?: string;
  emergencyPhone?: string;
  address?: string;
  flags: string[];
}

export type Cell = string | number | boolean | null | undefined;

const text = (v: Cell) => (v === null || v === undefined ? '' : String(v).trim());

/** "sphesihle  MCHUNU" → "Sphesihle Mchunu" (hyphen/apostrophe parts capitalised too). */
export function titleCase(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** SA ID check digit (Luhn over all 13 digits). */
export function isValidSaId(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    let d = Number(id[12 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Clean an ID cell; `flag` is set when it isn't a valid 13-digit SA ID. */
export function normaliseIdNumber(v: Cell): { value?: string; flag?: string } {
  let id = (typeof v === 'number' ? v.toFixed(0) : text(v)).replace(/[^A-Za-z0-9]/g, '');
  if (!id) return {};
  id = id.toUpperCase();
  if (/^\d{12}$/.test(id)) id = '0' + id;
  if (/^\d{13}$/.test(id))
    return isValidSaId(id) ? { value: id } : { value: id, flag: 'ID fails SA check digit' };
  return { value: id, flag: /^\d+$/.test(id) ? 'ID is not 13 digits' : 'ID is not an SA ID' };
}

/** "061 156 5533" → "+27611565533"; undefined when blank or implausible (flagged). */
export function normalisePhone(v: Cell): { value?: string; flag?: string } {
  const raw = typeof v === 'number' ? v.toFixed(0) : text(v);
  if (!raw) return {};
  let d = raw.replace(/\D+/g, '');
  if (d.length === 9 && /^[6-8]/.test(d)) d = '0' + d; // Excel dropped the leading 0
  if (d.startsWith('0')) d = '27' + d.slice(1);
  if (d.length !== 11 || !d.startsWith('27')) return { value: raw, flag: `odd phone "${raw}"` };
  return { value: `+${d}` };
}

/** Parse the sheet's rows (2-D array, as XLSX.utils.sheet_to_json(header: 1) returns). */
export function parseScorerRows(rows: Cell[][], firstLine = 1): ScorerRow[] {
  const headerIdx = rows.findIndex((r) => r.some((c) => /^id\s*number$/i.test(text(c))));
  if (headerIdx < 0) throw new Error('header row with an "ID Number" column not found');
  const header = rows[headerIdx];
  const idCol = header.findIndex((c) => /^id\s*number$/i.test(text(c)));
  const nameCol = idCol - 2;
  if (nameCol < 0) throw new Error('expected first name + surname columns before "ID Number"');
  const out: ScorerRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const first = text(r[nameCol]);
    const last = text(r[nameCol + 1]);
    if (!first && !last) continue;
    const flags: string[] = [];
    const row: ScorerRow = {
      line: firstLine + i,
      displayName: titleCase(`${first} ${last}`),
      flags,
    };
    const id = normaliseIdNumber(r[idCol]);
    const phone = normalisePhone(r[idCol + 1]);
    const emergency = normalisePhone(r[idCol + 2]);
    const address = text(r[idCol + 3]).replace(/\s+/g, ' ');
    if (id.value) row.idNumber = id.value;
    else flags.push('no ID');
    if (id.flag) flags.push(id.flag);
    if (phone.value) row.phone = phone.value;
    if (phone.flag) flags.push(phone.flag);
    if (emergency.value) row.emergencyPhone = emergency.value;
    if (emergency.flag) flags.push(`emergency: ${emergency.flag}`);
    if (address) row.address = address;
    out.push(row);
  }
  // Informational: emergency numbers / addresses shared between rows.
  for (const key of ['emergencyPhone', 'address'] as const) {
    const groups = new Map<string, ScorerRow[]>();
    for (const r of out) {
      const v = r[key];
      if (!v) continue;
      const k = v.toLowerCase().replace(/[^a-z0-9]+/g, '');
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    for (const g of groups.values())
      if (g.length > 1)
        for (const r of g)
          r.flags.push(
            `${key === 'address' ? 'address' : 'emergency no.'} shared with row ${g
              .filter((x) => x !== r)
              .map((x) => x.line)
              .join('/')}`,
          );
  }
  return out;
}

const FIELDS = ['fullName', 'phone', 'idNumber', 'emergencyPhone', 'address'] as const;

export interface PlanEntry {
  row: ScorerRow;
  action: 'create' | 'update' | 'noop';
  scorer: Scorer;
  /** Fields filled on an existing scorer. */
  filled: string[];
  /** Fields where the existing non-blank value differs (kept, reported). */
  conflicts: string[];
}

/** Plan creates/fills against the current register. Pure. */
export function planScorerImport(rows: ScorerRow[], existing: Scorer[], at: string): PlanEntry[] {
  const register = [...existing];
  const taken = new Set(existing.map((x) => x.id));
  const plan: PlanEntry[] = [];
  for (const row of rows) {
    const values: Record<(typeof FIELDS)[number], string | undefined> = {
      fullName: row.displayName,
      phone: row.phone,
      idNumber: row.idNumber,
      emergencyPhone: row.emergencyPhone,
      address: row.address,
    };
    const match = findScorerNameClash(row.displayName, register);
    if (match) {
      const input: ScorerInput = {};
      const filled: string[] = [];
      const conflicts: string[] = [];
      for (const k of FIELDS) {
        const v = values[k];
        if (!v) continue;
        if (!match[k]) {
          input[k] = v;
          filled.push(k);
        } else if (match[k] !== v) conflicts.push(k);
      }
      const scorer = filled.length ? applyScorerInput(match, input, match.id, at) : match;
      if (filled.length) register[register.indexOf(match)] = scorer;
      plan.push({ row, action: filled.length ? 'update' : 'noop', scorer, filled, conflicts });
      continue;
    }
    const stem = scorerIdFor(row.displayName);
    let id = stem;
    for (let n = 2; taken.has(id); n++) id = `${stem}-${n}`;
    taken.add(id);
    const input: ScorerInput = { displayName: row.displayName };
    for (const k of FIELDS) if (values[k]) input[k] = values[k];
    const scorer = applyScorerInput(undefined, input, id, at);
    register.push(scorer);
    plan.push({ row, action: 'create', scorer, filled: [], conflicts: [] });
  }
  return plan;
}

interface Args {
  tenant: string;
  file: string;
  confirm: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { tenant: '', file: '', confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') args.tenant = (argv[++i] ?? '').trim();
    else if (a === '--file') args.file = argv[++i] ?? '';
    else if (a === '--confirm') args.confirm = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.tenant) throw new Error('--tenant <slug> is required');
  if (!args.file) throw new Error('--file <xlsx> is required');
  return args;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wb = XLSX.read(await readFile(args.file));
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
  const rows = XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, defval: null, raw: true });
  const parsed = parseScorerRows(rows, range.s.r + 1);

  const repo = await import('./repo.js');
  const existing = await repo.listScorers(args.tenant);
  const plan = planScorerImport(parsed, existing, new Date().toISOString());

  console.log(
    `Tenant ${args.tenant}: ${existing.length} scorer(s) in the register; ${parsed.length} sheet row(s)\n`,
  );
  console.log(`${pad('row', 5)}${pad('action', 8)}${pad('name', 28)}${pad('id', 34)}notes`);
  for (const p of plan) {
    const notes = [
      ...(p.filled.length ? [`fills ${p.filled.join(',')}`] : []),
      ...(p.conflicts.length ? [`kept existing ${p.conflicts.join(',')} (differs)`] : []),
      ...p.row.flags,
    ];
    console.log(
      `${pad(String(p.row.line), 5)}${pad(p.action, 8)}${pad(p.row.displayName, 28)}${pad(p.scorer.id, 34)}${notes.join('; ')}`,
    );
  }
  const count = (a: PlanEntry['action']) => plan.filter((p) => p.action === a).length;
  console.log(
    `\nSummary: ${count('create')} create · ${count('update')} update · ${count('noop')} unchanged · ` +
      `${plan.filter((p) => p.row.flags.length).length} row(s) flagged`,
  );

  if (!args.confirm) {
    console.log('\nDry run — nothing written. Re-run with --confirm to write.');
    return;
  }
  let written = 0;
  for (const p of plan) {
    if (p.action === 'create') await repo.createScorer(args.tenant, p.scorer);
    else if (p.action === 'update') await repo.putScorer(args.tenant, p.scorer);
    else continue;
    written++;
  }
  console.log(`\nWrote ${written} scorer(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

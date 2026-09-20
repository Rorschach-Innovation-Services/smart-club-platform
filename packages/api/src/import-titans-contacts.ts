/**
 * Titans club-contact import — office bearers + coaches + portal invites, from the union's
 * "CLUB CHAIRMANS CONTACT LIST" workbook.
 *
 *   npx tsx src/import-titans-contacts.ts --file "<contacts>.xlsx" --parse-only
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run import-titans-contacts -- \
 *     --file "<contacts>.xlsx"                                                    # dry-run
 *   … --confirm                                                                   # write
 *   … --channels email,whatsapp                                                   # add WhatsApp
 *   … --data-only                                                                 # exco/coach only, no accounts/sends
 *   … --club "ADELAAR"            # one section only
 *   … --skip-club "TITANS SCORERS ASSOCIATION"   # (repeatable) drop a section; the ONLY way an unmatched section stops blocking
 *   … --revert [--manifest <path>]
 *
 * See docs/runbooks/titans-contact-import.md.
 *
 * WHY a dedicated CLI (not the operator console's per-person rep-invite modal): there is no
 * bulk path in the UI, and the union has 22 clubs with no office bearers recorded and no one
 * invited. This mirrors import-titans-compliance.ts's shape exactly — dry-run by default, a
 * `--confirm` write gate, and a revert manifest — because a confidently-wrong write to prod
 * (a mis-mapped chair, a stripped membership) is worse than an incomplete one.
 *
 * Fail-closed by design: an unmatched club section, an exco-slot conflict (an occupied slot
 * or two sheet rows claiming the same slot), a titans-admin collision, or a missing canonical
 * origin when sends are requested all abort the run with a printed BLOCKERS report. `--confirm`
 * refuses to run while any blocker stands (no override flag) — `--skip-club` is the only
 * escape hatch, and only for a section deliberately excluded.
 *
 * NEVER hand-writes USER# items: account grants go through grantClubRep and reverts through
 * restoreMembership (tenant-admin.ts), so the last-admin transactional guard always applies.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import {
  parseContactsWorkbook,
  mapDesignation,
  resolveClubs,
  type ParsedContacts,
  type ResolvedClubs,
  type ExcoKey,
  type DesignationMapping,
} from './titans-contacts-parse.js';
import { isLegacyXlsBuffer } from './committee-parse.js';
import { CLUB_MAP } from './titans-import-map.js';
import { canonicalWebOrigin } from './origins.js';
import { toE164 } from './notify/whatsapp.js';
import type { Channel, ClubCommEvent, Membership } from './types.js';

type RepoModule = typeof import('./repo.js');

const TENANT = 'titans';
/** Stable manifest path (not timestamped) so `--revert` finds the last confirm's writes by
 * default; a timestamped backup of the pre-run club state is written separately on --confirm. */
const MANIFEST_PATH = './titans-contacts-import-manifest.json';
/** Kept identical to the API/notify EMAIL_RE so a value that passed the sheet parse (already
 * lowercased) is judged the same way the send path would judge it. */
const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;
/** Deterministic per-person idempotency key: a re-run replays (reports `sent-previously`)
 * rather than re-billing a Meta conversation / re-sending an email. */
const idempotencyKeyFor = (email: string): string => `staff-import-${email}`;
/** Tags every coach entry this import appends, so `--revert` can find and remove exactly the
 * entries this import wrote (matched on email + this source) and never a coach added by others. */
const COACH_SOURCE = 'import:titans-contacts';

const EXCO_LABEL: Record<ExcoKey, string> = {
  chair: 'Chairperson',
  vc: 'Vice-chair',
  tre: 'Treasurer',
  sec: 'Secretary',
};

// ───────────────────────── Plan types (pure) ─────────────────────────

type ExcoSlotAction = 'set' | 'keep' | 'CONFLICT' | 'DUPLICATE-SLOT';
type AccountAction = 'create' | 'pending-exists' | 'active' | 'admin-elsewhere';

export interface ClubRolePlan {
  clubId: string;
  clubName: string;
  section: string;
  designation: string;
  mapping: DesignationMapping;
  /** The exco slot this role claims and what would happen to it (undefined ⇒ no exco slot). */
  exco?: { slot: ExcoKey; action: ExcoSlotAction; existingEmail?: string };
  /** Coach action: `set` appends a new coach entry; `keep` when the club already lists this
   * email as a coach, or a within-run duplicate row already claimed it (undefined ⇒ not a coach). */
  coach?: 'set' | 'keep';
}

export interface ChannelPlan {
  channel: Channel;
  status: 'send' | 'skip';
  to?: string;
  reason?: string;
}

export interface PersonPlan {
  email: string;
  name: string;
  cell: string;
  /** Club ids resolved from the person's sheet sections (attachment set for exco + comm-log). */
  sheetClubIds: string[];
  /** Existing titans-membership clubIds (empty when the user has no titans membership). */
  existingClubIds: string[];
  /** sheet ∪ existing — the clubIds grantClubRep must receive (it REPLACES membership wholesale). */
  unionClubIds: string[];
  account: AccountAction;
  roles: ClubRolePlan[];
  channels: ChannelPlan[];
  /** Whether an account grant + invite send would happen (false under --data-only, for an
   * already-active user, or an admin collision). */
  invite: boolean;
  /** The club whose INVITE# keyspace carries this person's single send marker (first resolved club). */
  sendMarkerClubId?: string;
  /** This person's own blockers (also rolled into the run-level list). */
  blockers: string[];
}

export interface ContactPlan {
  people: PersonPlan[];
  /** Sections that resolved to no club and were NOT skipped (hard blockers). */
  unmatchedSections: string[];
  /** Sections excluded via --skip-club (reported, never blocking). */
  skippedSections: string[];
  /** System clubs absent from the sheet (informational). */
  clubsWithoutSection: Array<{ id: string; name: string }>;
  origin: string | null;
  channels: Channel[];
  dataOnly: boolean;
  /** Run-level blockers — non-empty ⇒ exit non-zero and refuse --confirm. */
  blockers: string[];
}

/** The existing-user facts the plan-builder needs, resolved read-only by the caller (a fake
 * map in tests). Absent from the map ⇒ no titans account/membership at all. */
export interface ExistingUser {
  /** True when the user has signed in (lastLoginAt present) — an active user is not re-invited. */
  active: boolean;
  /** The user's role in the titans tenant, or null when they have no titans membership. */
  role: 'admin' | 'rep' | null;
  /** The user's existing titans-membership clubIds. */
  clubIds: string[];
}

export interface BuildPlanInputs {
  parsed: ParsedContacts;
  resolved: ResolvedClubs;
  /** Live club exco state, keyed by clubId — for set/keep/CONFLICT detection. */
  clubExco: Map<string, Record<string, unknown> | undefined>;
  /** Live club coach lists, keyed by clubId — for coach set/keep (dedupe) detection. */
  clubCoaches: Map<string, unknown[] | undefined>;
  /** Existing titans users keyed by lowercased email. */
  userByEmail: Map<string, ExistingUser>;
  origin: string | null;
  channels: Channel[];
  dataOnly: boolean;
  /** Section headers (as typed on --skip-club) to exclude; compared case-insensitively. */
  skipSections: string[];
  /** Optional single-section filter (--club); compared case-insensitively. */
  onlySection?: string;
}

// ───────────────────────── Landline heuristic ─────────────────────────

/**
 * True for a South African number that is almost certainly NOT a mobile — its subscriber
 * part doesn't start 06/07/08. `toE164` happily accepts a landline (e.g. the TUT `012` number
 * on the sheet), so without this a WhatsApp `--confirm` would bill a Meta conversation to a
 * landline that can never receive it. Such numbers ride email only.
 */
export function isLikelyLandline(cell: string): boolean {
  const digits = cell.replace(/\D+/g, '');
  if (!digits) return false; // no number at all is "no cell", not a landline
  let local = digits;
  if (local.startsWith('27')) local = `0${local.slice(2)}`;
  if (!local.startsWith('0') || local.length < 2) return false; // not ZA-shaped — leave to toE164
  const lead = local[1];
  return lead !== '6' && lead !== '7' && lead !== '8';
}

// ───────────────────────── Plan builder (pure) ─────────────────────────

const eq = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The email currently stored in an exco slot (lowercased), or undefined when empty. */
function slotEmail(exco: Record<string, unknown> | undefined, slot: ExcoKey): string | undefined {
  const v = exco?.[slot] as { email?: unknown } | undefined;
  const email = typeof v?.email === 'string' ? v.email.trim().toLowerCase() : '';
  return email || undefined;
}

/** True when `coaches` already lists an entry whose email matches (case-insensitively). */
function coachEmailPresent(coaches: unknown[] | undefined, email: string): boolean {
  if (!Array.isArray(coaches)) return false;
  const want = email.trim().toLowerCase();
  return coaches.some((c) => {
    const e = (c as { email?: unknown } | undefined)?.email;
    return typeof e === 'string' && e.trim().toLowerCase() === want;
  });
}

/**
 * Build the full per-person plan. PURE — every dependency (parsed sheet, resolved clubs,
 * live exco state, existing users, origin) arrives as data, so the same builder serves the
 * dry-run and --confirm paths and is unit-tested with fakes. The unit of account work is the
 * EMAIL, not the row: one person may chair two clubs, so rows are grouped by lowercased email
 * and a single invite is planned per person (comm-log entries still land on every club).
 */
export function buildPlan(inputs: BuildPlanInputs): ContactPlan {
  const { parsed, resolved, clubExco, clubCoaches, userByEmail, origin, channels, dataOnly } =
    inputs;

  const skipSections = inputs.skipSections ?? [];
  const isSkipped = (section: string): boolean => skipSections.some((s) => eq(s, section));
  const isIncluded = (section: string): boolean =>
    !isSkipped(section) && (!inputs.onlySection || eq(inputs.onlySection, section));

  const clubBySection = new Map(resolved.matched.map((m) => [m.section, m]));

  const skippedSections = parsed.sections.filter(isSkipped);
  const unmatchedSections = resolved.unmatchedSections.filter(isIncluded);

  const blockers: string[] = [];
  for (const s of unmatchedSections) {
    blockers.push(
      `unmatched section "${s}" — no system club (skip it with --skip-club, or add the club first)`,
    );
  }
  for (const r of parsed.strayRows) {
    blockers.push(`unexplained sheet row ${r.rowNumber}: ${r.text}`);
  }
  // A --club that resolves to no section would otherwise produce a silent empty plan.
  if (inputs.onlySection && !parsed.sections.some((s) => eq(inputs.onlySection!, s))) {
    blockers.push(`--club "${inputs.onlySection}" matched no section in the workbook`);
  }

  // Group people by lowercased email, preserving first-seen order. A row with no usable
  // email cannot anchor an account grant or a contact record — grouping such rows by '' would
  // collapse distinct people into one pseudo-person and later drive an AdminGetUser on an empty
  // username — so each is a fail-closed blocker instead of a plan entry.
  const groups = new Map<string, ParsedContacts['people']>();
  for (const p of parsed.people) {
    if (!isIncluded(p.section)) continue;
    if (!EMAIL_RE.test(p.email)) {
      blockers.push(
        `row ${p.rowNumber}: ${p.fullName || '(no name)'} has no usable email — cannot grant an account or record contact`,
      );
      continue;
    }
    const list = groups.get(p.email) ?? [];
    list.push(p);
    groups.set(p.email, list);
  }

  // First pass: collect every empty-slot claim per (clubId, slot) so a DUPLICATE-SLOT
  // (two DIFFERENT people claiming the same empty slot in one club) can be detected.
  const emptySlotClaimants = new Map<string, Set<string>>(); // `${clubId}::${slot}` -> emails
  for (const [email, rows] of groups) {
    for (const row of rows) {
      const club = clubBySection.get(row.section);
      if (!club) continue;
      const m = mapDesignation(row.designation);
      if (!m.excoKey) continue;
      if (slotEmail(clubExco.get(club.clubId), m.excoKey)) continue; // occupied → handled as keep/CONFLICT
      const key = `${club.clubId}::${m.excoKey}`;
      const set = emptySlotClaimants.get(key) ?? new Set<string>();
      set.add(email);
      emptySlotClaimants.set(key, set);
    }
  }

  const people: PersonPlan[] = [];
  for (const [email, rows] of groups) {
    const name = rows.find((r) => r.fullName)?.fullName ?? '';
    const cell = rows.find((r) => r.cell)?.cell ?? '';
    const existing = userByEmail.get(email);
    const personBlockers: string[] = [];

    const roles: ClubRolePlan[] = [];
    const sheetClubIds = new Set<string>();
    // Clubs this person has already been given a coach `set` for in THIS run — a second
    // sheet row for the same person+club must not append a duplicate coach entry.
    const coachSetClubs = new Set<string>();
    for (const row of rows) {
      const club = clubBySection.get(row.section);
      if (!club) continue; // unmatched — already a run-level blocker
      sheetClubIds.add(club.clubId);
      const mapping = mapDesignation(row.designation);
      const role: ClubRolePlan = {
        clubId: club.clubId,
        clubName: club.clubName,
        section: row.section,
        designation: row.designation,
        mapping,
      };
      if (mapping.excoKey) {
        const occupied = slotEmail(clubExco.get(club.clubId), mapping.excoKey);
        let action: ExcoSlotAction;
        if (occupied) {
          action = eq(occupied, email) ? 'keep' : 'CONFLICT';
        } else if ((emptySlotClaimants.get(`${club.clubId}::${mapping.excoKey}`)?.size ?? 0) > 1) {
          action = 'DUPLICATE-SLOT';
        } else {
          action = 'set';
        }
        role.exco = {
          slot: mapping.excoKey,
          action,
          ...(occupied ? { existingEmail: occupied } : {}),
        };
        if (action === 'CONFLICT') {
          personBlockers.push(
            `${club.clubName}: exco slot "${EXCO_LABEL[mapping.excoKey]}" already held by ${occupied} (sheet wants ${email})`,
          );
        } else if (action === 'DUPLICATE-SLOT') {
          personBlockers.push(
            `${club.clubName}: two sheet rows both map to exco slot "${EXCO_LABEL[mapping.excoKey]}"`,
          );
        }
      }
      if (mapping.coach) {
        // Dedupe: a coach already on the club (from a prior run or the affiliation form),
        // or a second row for this same person+club in this run, is a `keep` (no write).
        if (
          coachEmailPresent(clubCoaches.get(club.clubId), email) ||
          coachSetClubs.has(club.clubId)
        )
          role.coach = 'keep';
        else {
          role.coach = 'set';
          coachSetClubs.add(club.clubId);
        }
      }
      roles.push(role);
    }

    // Account action from the (read-only) existing-user lookup.
    let account: AccountAction;
    if (existing?.role === 'admin') account = 'admin-elsewhere';
    else if (existing?.active) account = 'active';
    else if (existing) account = 'pending-exists';
    else account = 'create';
    if (account === 'admin-elsewhere') {
      personBlockers.push(
        `${email} is a titans ADMIN — granting rep would demote them; remove them from the sheet or manage in Team & Access`,
      );
    }

    const existingClubIds = existing?.clubIds ?? [];
    const unionClubIds = [...new Set([...sheetClubIds, ...existingClubIds])];
    const invite = !dataOnly && (account === 'create' || account === 'pending-exists');

    const channelPlans: ChannelPlan[] = [];
    if (invite) {
      for (const channel of channels) {
        if (channel === 'email') {
          channelPlans.push(
            EMAIL_RE.test(email)
              ? { channel, status: 'send', to: email }
              : { channel, status: 'skip', reason: 'no valid email' },
          );
        } else {
          const e164 = toE164(cell);
          if (!e164) channelPlans.push({ channel, status: 'skip', reason: 'no cell' });
          else if (isLikelyLandline(cell))
            channelPlans.push({ channel, status: 'skip', to: e164, reason: 'landline?' });
          else channelPlans.push({ channel, status: 'send', to: e164 });
        }
      }
    }

    const sendMarkerClubId = [...sheetClubIds][0];
    people.push({
      email,
      name,
      cell,
      sheetClubIds: [...sheetClubIds],
      existingClubIds,
      unionClubIds,
      account,
      roles,
      channels: channelPlans,
      invite,
      ...(sendMarkerClubId ? { sendMarkerClubId } : {}),
      blockers: personBlockers,
    });
    blockers.push(...personBlockers);
  }

  // Missing-origin is a blocker only when a real send would otherwise go out.
  const anyWouldSend = people.some((p) => p.channels.some((c) => c.status === 'send'));
  if (anyWouldSend && !origin) {
    blockers.push(
      'no canonical web origin for titans — the invite link would be empty; a CLI never falls back to localhost',
    );
  }

  return {
    people,
    unmatchedSections,
    skippedSections,
    clubsWithoutSection: resolved.clubsWithoutSection,
    origin,
    channels,
    dataOnly,
    blockers,
  };
}

// ───────────────────────── CLI args ─────────────────────────

interface Args {
  file: string;
  parseOnly: boolean;
  confirm: boolean;
  club?: string;
  skipClubs: string[];
  channels: Channel[];
  dataOnly: boolean;
  revert: boolean;
  manifest: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    file: '',
    parseOnly: false,
    confirm: false,
    skipClubs: [],
    channels: ['email'],
    dataOnly: false,
    revert: false,
    manifest: MANIFEST_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i] ?? '';
    else if (a === '--parse-only') args.parseOnly = true;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--club') args.club = argv[++i];
    else if (a === '--skip-club') {
      const v = argv[++i];
      if (v) args.skipClubs.push(v);
    } else if (a === '--channels') args.channels = parseChannels(argv[++i] ?? '');
    else if (a === '--data-only') args.dataOnly = true;
    else if (a === '--revert') args.revert = true;
    else if (a === '--manifest') args.manifest = argv[++i] ?? MANIFEST_PATH;
    else throw new Error(`unknown flag ${a}`);
  }
  if (args.revert) return args;
  if (!args.file) throw new Error('requires --file "<contacts>.xlsx" (or --revert)');
  return args;
}

function parseChannels(raw: string): Channel[] {
  const out: Channel[] = [];
  for (const part of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (part !== 'email' && part !== 'whatsapp') throw new Error(`unknown channel "${part}"`);
    if (!out.includes(part)) out.push(part);
  }
  if (out.length === 0) throw new Error('--channels needs at least one of email,whatsapp');
  return out;
}

// ───────────────────────── Workbook loading ─────────────────────────

async function loadWorkbook(file: string): Promise<ExcelJS.Workbook> {
  const bytes = await readFile(file);
  if (isLegacyXlsBuffer(bytes)) {
    throw new Error(
      `"${file}" is a legacy .xls (Excel 97-2003) workbook, which this importer cannot read. ` +
        'Open it in Excel/LibreOffice and Save As .xlsx, then re-run with the converted file. ' +
        '(Keep the converted copy OUTSIDE the repo — it contains personal contact details.)',
    );
  }
  const wb = new ExcelJS.Workbook();
  // exceljs's bundled `Buffer` type lags the fs NonSharedBuffer shape; the value is a real
  // Node Buffer, so cast to the method's own expected arg type (same load(bytes) pattern the
  // routes use in index.ts) rather than reaching for `any`.
  await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

// ───────────────────────── Reporting ─────────────────────────

function describeMapping(m: DesignationMapping): string {
  const parts: string[] = [];
  if (m.excoKey) parts.push(EXCO_LABEL[m.excoKey]);
  if (m.coach) parts.push('Coach');
  if (m.unmapped) parts.push('unmapped (invite only)');
  if (!parts.length) parts.push('invite only');
  if (m.extraRoles?.length) parts.push(`[+${m.extraRoles.join(', ')}]`);
  return parts.join(', ');
}

/** `--parse-only`: no AWS. Parse + designation mapping + club resolution against the known
 * CLUB_MAP (prod may have one extra club — only the live dry-run can confirm that). */
function runParseOnly(parsed: ParsedContacts): void {
  const knownClubs = CLUB_MAP.map((c) => ({ id: c.id, name: c.name }));
  const resolved = resolveClubs(parsed.sections, knownClubs);
  const clubBySection = new Map(resolved.matched.map((m) => [m.section, m]));

  console.log(`\n── Contact sheet "${parsed.sheetName}"`);
  console.log(`  ${parsed.sections.length} section(s), ${parsed.people.length} person(s)\n`);

  for (const section of parsed.sections) {
    const club = clubBySection.get(section);
    const people = parsed.people.filter((p) => p.section === section);
    console.log(
      `  [${section}] → ${club ? `${club.clubName} (${club.clubId})` : 'UNMATCHED (no known club)'} : ${people.length} person(s)`,
    );
    for (const p of people) {
      const m = mapDesignation(p.designation);
      console.log(
        `      · ${p.fullName || '(no name)'} — "${p.designation}" → ${describeMapping(m)}` +
          `${p.cell ? '' : '  [no cell]'}${isLikelyLandline(p.cell) ? '  [landline?]' : ''}`,
      );
    }
  }

  if (resolved.unmatchedSections.length) {
    console.log(
      `\n  ⚠ ${resolved.unmatchedSections.length} unmatched section(s) (no club in the import map):`,
    );
    for (const s of resolved.unmatchedSections) console.log(`     ${s}`);
    console.log(
      '     (the union scorers/umpires associations are expected here; a live dry-run resolves against prod, which may carry one extra club)',
    );
  }
  if (resolved.clubsWithoutSection.length) {
    console.log(
      `\n  · ${resolved.clubsWithoutSection.length} known club(s) with no section in the sheet (informational):`,
    );
    for (const c of resolved.clubsWithoutSection) console.log(`     ${c.name}`);
  }
  if (parsed.strayRows.length) {
    console.log(`\n  ✗ ${parsed.strayRows.length} unexplained row(s):`);
    for (const r of parsed.strayRows) console.log(`     row ${r.rowNumber}: ${r.text}`);
  }

  const unmapped = parsed.people.filter((p) => mapDesignation(p.designation).unmapped);
  console.log(
    `\n  Designation summary: ${parsed.people.length - unmapped.length} mapped to a role/coach/known-office, ${unmapped.length} unmapped (still invited).`,
  );
  if (parsed.strayRows.length) {
    console.error('\n✗ Unexplained rows present — see above.');
    process.exitCode = 1;
    return;
  }
  console.log(
    '\n[parse-only] Parse clean — nothing touched Cognito/DynamoDB. Re-run without --parse-only (under sst shell) for the account/exco/send plan.',
  );
}

function printPlan(plan: ContactPlan): void {
  console.log(`\n── Plan (${plan.people.length} person(s), origin ${plan.origin ?? 'NONE'})`);
  for (const p of plan.people) {
    const clubs = p.roles.map((r) => {
      const bits = [r.clubName];
      if (r.exco) bits.push(`${EXCO_LABEL[r.exco.slot]}:${r.exco.action}`);
      if (r.coach) bits.push(`coach:${r.coach}`);
      return bits.join(' ');
    });
    console.log(`  ${p.name || '(no name)'} <${p.email}>  account=${p.account}`);
    console.log(`      clubs: ${clubs.join('; ') || '(none)'}`);
    // The union grant only happens when this person is actually invited/granted; never
    // print it for an active user (no grant runs, so the sheet clubs are NOT added).
    if (p.invite && p.unionClubIds.length !== p.sheetClubIds.length) {
      console.log(
        `      grant clubIds (union with existing membership): ${p.unionClubIds.join(', ')}`,
      );
    }
    if (p.invite) {
      const chans = p.channels.map(
        (c) => `${c.channel}:${c.status}${c.reason ? `(${c.reason})` : ''}`,
      );
      console.log(
        `      invite: ${chans.join(', ')}  marker-club=${p.sendMarkerClubId ?? '(none)'}`,
      );
    } else if (p.account === 'active') {
      console.log(
        '      invite: none (active — membership untouched; sheet clubs NOT added to scope)',
      );
    } else {
      console.log(`      invite: none (${plan.dataOnly ? '--data-only' : p.account})`);
    }
  }

  const byAccount = new Map<AccountAction, number>();
  for (const p of plan.people) byAccount.set(p.account, (byAccount.get(p.account) ?? 0) + 1);
  console.log('\n── Summary');
  for (const [action, n] of byAccount) console.log(`  ${action}: ${n}`);
  if (plan.skippedSections.length)
    console.log(`  skipped section(s): ${plan.skippedSections.join(', ')}`);

  if (plan.blockers.length) {
    console.log(`\n✗ ${plan.blockers.length} BLOCKER(S) — --confirm refuses while any stand:`);
    for (const b of plan.blockers) console.log(`   ${b}`);
  } else {
    console.log('\n✓ No blockers.');
  }
}

// ───────────────────────── Read-only inputs (dry-run + confirm share) ─────────────────────────

/** Resolve the live inputs the plan-builder needs from the stage, READ-ONLY. Aborts cleanly
 * when the tenant has no clubs on this stage (dev may carry no titans cohort). */
async function gatherInputs(
  repo: RepoModule,
  cognito: import('@aws-sdk/client-cognito-identity-provider').CognitoIdentityProviderClient,
  pool: string,
  parsed: ParsedContacts,
  args: Args,
): Promise<BuildPlanInputs> {
  const clubs = await repo.listClubs(TENANT);
  if (clubs.length === 0) {
    throw new Error(
      `tenant "${TENANT}" has no clubs on this stage — nothing to resolve sections against. ` +
        '(Dev may not carry a titans cohort; run the dry-run against a stage that does.)',
    );
  }
  const resolved = resolveClubs(
    parsed.sections,
    clubs.map((c) => ({ id: c.id, name: c.name })),
  );
  const clubExco = new Map(clubs.map((c) => [c.id, c.exco]));
  const clubCoaches = new Map(clubs.map((c) => [c.id, c.coaches]));

  const { getUserSubByEmail } = await import('./cognito-users.js');
  const userByEmail = new Map<string, ExistingUser>();
  // Only valid emails reach Cognito — an empty/invalid one is a buildPlan blocker, and
  // AdminGetUser with an empty username throws a raw AWS error on a live dry-run.
  const emails = [...new Set(parsed.people.map((p) => p.email).filter((e) => EMAIL_RE.test(e)))];
  for (const email of emails) {
    const sub = await getUserSubByEmail(cognito, pool, email);
    if (!sub) continue; // no account → 'create'
    const profile = await repo.getUser(sub);
    const membership = profile?.memberships.find((m) => m.tenantId === TENANT);
    userByEmail.set(email, {
      active: !!profile?.lastLoginAt,
      role: membership ? (membership.role === 'admin' ? 'admin' : 'rep') : null,
      clubIds: membership?.clubIds ?? [],
    });
  }

  return {
    parsed,
    resolved,
    clubExco,
    clubCoaches,
    userByEmail,
    origin: canonicalWebOrigin(TENANT),
    channels: args.channels,
    dataOnly: args.dataOnly,
    skipSections: args.skipClubs,
    onlySection: args.club,
  };
}

// ───────────────────────── Manifest ─────────────────────────

interface ExcoWrite {
  clubId: string;
  slot: ExcoKey;
  /** The exco slot's value BEFORE this run wrote it (for a drift-guarded restore). */
  priorValue: unknown;
}

export interface ManifestEntry {
  email: string;
  sub: string;
  /** True when this run created the user record (no titans USER# existed before). */
  createdUser: boolean;
  /** True ONLY when grantClubRep actually ran this run (an account grant landed). Revert
   * restores membership from `priorMembership` ONLY when this is true — so an active user or
   * a --data-only run (where no membership was ever written) is never clobbered by revert. */
  granted: boolean;
  /** Full pre-image of the person's titans membership (null when they had none). */
  priorMembership: Membership | null;
  excoWrites: ExcoWrite[];
  /** Clubs this run appended a coach entry to (tagged COACH_SOURCE). Revert removes the
   * entries matching this person's email + that source, leaving others' entries intact.
   * Optional so a manifest written before this field still reverts (treated as empty). */
  coachWrites?: string[];
  /** Audit-only record of the comm-log events this run appended. Revert NEVER uses it
   * (messages cannot be unsent, and a comm-log entry is a historical fact); it exists so the
   * manifest is a complete account of what the run wrote. */
  commLog: Array<{ clubId: string; eventId: string }>;
  idempotencyKey: string;
  sendMarkerClubId: string | null;
}

async function writeManifest(entries: ManifestEntry[], path: string): Promise<void> {
  await writeFile(path, JSON.stringify(entries, null, 2));
}

/**
 * Merge a run's fresh entries into whatever the manifest already holds, keyed by email.
 * The pre-image fields (`priorMembership`, and each exco slot's `priorValue`) must record
 * the state BEFORE THE FIRST run touched them, so a `--revert` after several runs restores
 * to the ORIGINAL state, not to run-1's output. So for a re-seen email: keep the EARLIEST
 * `priorMembership` (the existing entry's, since it was captured first) and, per exco slot,
 * keep the earliest `priorValue`; union the other data (exco writes for new slots, comm-log
 * entries, the latest sub/granted/createdUser). Mirrors import-titans-compliance.ts's
 * write-through-existing-manifest guard: a present-but-unparseable manifest ABORTS (never
 * silently overwritten), because starting fresh would discard every prior run's pre-images.
 */
export function mergeManifestEntry(prior: ManifestEntry, next: ManifestEntry): ManifestEntry {
  // Union exco writes by slot+clubId, keeping the EARLIEST priorValue (prior wins).
  const bySlot = new Map<string, ExcoWrite>();
  for (const w of next.excoWrites) bySlot.set(`${w.clubId}::${w.slot}`, w);
  for (const w of prior.excoWrites) bySlot.set(`${w.clubId}::${w.slot}`, w); // earliest pre-image wins
  // Union comm-log entries by eventId (audit-only; dedupe on replay).
  const commById = new Map<string, { clubId: string; eventId: string }>();
  for (const c of [...prior.commLog, ...next.commLog]) commById.set(c.eventId, c);
  return {
    email: prior.email,
    // The account facts reflect the latest write; the pre-image stays the earliest.
    sub: next.sub || prior.sub,
    createdUser: prior.createdUser, // whether the FIRST run created the user
    granted: prior.granted || next.granted,
    priorMembership: prior.priorMembership, // earliest pre-image — never overwritten
    excoWrites: [...bySlot.values()],
    coachWrites: [...new Set([...(prior.coachWrites ?? []), ...(next.coachWrites ?? [])])],
    commLog: [...commById.values()],
    idempotencyKey: next.idempotencyKey || prior.idempotencyKey,
    sendMarkerClubId: next.sendMarkerClubId ?? prior.sendMarkerClubId,
  };
}

type ManifestReadResult =
  | { kind: 'absent' }
  | { kind: 'corrupt'; detail: string }
  | { kind: 'ok'; entries: ManifestEntry[] };

/** Read the manifest for a MERGE (the confirm path). Distinguishes absent (safe to start
 * empty) from corrupt (must abort — see mergeManifestEntry). */
async function readManifestForMerge(path: string): Promise<ManifestReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'corrupt', detail: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    return {
      kind: 'corrupt',
      detail: `invalid JSON — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(parsed))
    return { kind: 'corrupt', detail: 'expected a JSON array of entries' };
  return { kind: 'ok', entries: parsed as ManifestEntry[] };
}

async function readManifest(path: string): Promise<ManifestEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `manifest not found at ${path} — pass --manifest <path> to the file a --confirm run wrote`,
      );
    }
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`manifest ${path} is not a JSON array`);
  return parsed as ManifestEntry[];
}

// ───────────────────────── Confirm ─────────────────────────

/** Build the exco value written into a slot — name/email/cell only (the affiliation-form
 * governance fields idNumber/termStart/termEnd aren't in a contact list). */
function excoValue(person: PersonPlan): Record<string, string> {
  return { name: person.name, email: person.email, ...(person.cell ? { cell: person.cell } : {}) };
}

/**
 * The channels a person's invite ACTUALLY sends on at confirm time — only those the plan
 * judged `send` (a landline whatsapp:skip or a no-valid-email email:skip is dropped, never
 * sent). The `cell` is blanked unless WhatsApp is among them, so the sender never reaches for
 * a number the plan already ruled out. An empty `channels` ⇒ the caller skips the send.
 */
export function effectiveInviteChannels(person: PersonPlan): { channels: Channel[]; cell: string } {
  const channels = person.channels.filter((c) => c.status === 'send').map((c) => c.channel);
  return { channels, cell: channels.includes('whatsapp') ? person.cell : '' };
}

interface ClubWrites {
  nextExco: Record<string, unknown>;
  excoWrites: ExcoWrite[];
  nextCoaches: unknown[];
  coachesChanged: boolean;
}

/**
 * Compute the exco/coach merge for one club against a FRESHLY-READ club record — pure given
 * the read, so it can be re-run against a re-read on a version-conflict retry. Only `set`
 * exco actions and `set` coach actions write; a `keep` exco slot is left ENTIRELY untouched
 * (it would otherwise clobber governance fields — idNumber/termStart/termEnd/gender/race —
 * an affiliation-form save added after a first run). A drifted exco slot is skipped + warned.
 */
export function computeClubWrites(
  club: { id: string; exco?: Record<string, unknown>; coaches?: unknown[] },
  roles: ClubRolePlan[],
  person: PersonPlan,
): ClubWrites {
  const nextExco: Record<string, unknown> = { ...(club.exco ?? {}) };
  const excoWrites: ExcoWrite[] = [];
  const nextCoaches = [...(club.coaches ?? [])];
  let coachesChanged = false;
  for (const role of roles) {
    if (role.exco && role.exco.action === 'set') {
      // Drift guard: the slot must still be empty (a `set` planned against an empty slot).
      const nowEmail = slotEmail(club.exco, role.exco.slot);
      const plannedEmail = role.exco.existingEmail;
      const drifted = (nowEmail ?? undefined) !== (plannedEmail ?? undefined);
      if (drifted) {
        console.warn(
          `  ⚠ ${person.email}: exco slot "${EXCO_LABEL[role.exco.slot]}" on ${club.id} drifted since planning (now ${nowEmail ?? 'empty'}) — skipping this slot`,
        );
        continue;
      }
      excoWrites.push({
        clubId: club.id,
        slot: role.exco.slot,
        priorValue: club.exco?.[role.exco.slot] ?? null,
      });
      nextExco[role.exco.slot] = excoValue(person);
    }
    if (role.coach === 'set') {
      // Drift guard (mirrors the exco one): the version-conflict retry re-runs this against a
      // re-read club, whose coaches may meanwhile include this person — never append twice.
      if (coachEmailPresent(club.coaches, person.email)) {
        console.warn(
          `  ⚠ ${person.email}: already listed as a coach on ${club.id} (added since planning) — skipping append`,
        );
        continue;
      }
      nextCoaches.push({
        name: person.name,
        email: person.email,
        ...(person.cell ? { cell: person.cell } : {}),
        source: COACH_SOURCE,
      });
      coachesChanged = true;
    }
  }
  return { nextExco, excoWrites, nextCoaches, coachesChanged };
}

/** The side-effecting collaborators runConfirm needs. Defaulted from the real modules; a test
 * injects fakes (no AWS) to assert the confirm ASSEMBLY — channel plan, version, marker. */
export interface ConfirmDeps {
  grantClubRep: typeof import('./tenant-admin.js').grantClubRep;
  getUserSubByEmail: typeof import('./cognito-users.js').getUserSubByEmail;
  sendStaffInvite: typeof import('./notify/index.js').sendStaffInvite;
  orgCopy: typeof import('./branding.js').orgCopy;
}

async function loadConfirmDeps(): Promise<ConfirmDeps> {
  const [{ grantClubRep }, { getUserSubByEmail }, { sendStaffInvite }, { orgCopy }] =
    await Promise.all([
      import('./tenant-admin.js'),
      import('./cognito-users.js'),
      import('./notify/index.js'),
      import('./branding.js'),
    ]);
  return { grantClubRep, getUserSubByEmail, sendStaffInvite, orgCopy };
}

export async function runConfirm(
  repo: RepoModule,
  cognito: import('@aws-sdk/client-cognito-identity-provider').CognitoIdentityProviderClient,
  pool: string,
  plan: ContactPlan,
  args: Args,
  deps?: ConfirmDeps,
): Promise<void> {
  const { grantClubRep, getUserSubByEmail, sendStaffInvite, orgCopy } =
    deps ?? (await loadConfirmDeps());

  // Backup lands next to the manifest (its directory), not in the process CWD — so a test
  // pointing --manifest at a tmp dir keeps the backup there too, without chdir'ing the
  // shared runner. For a real run --manifest defaults to './…', so the backup stays in CWD.
  const backupPath = join(
    dirname(args.manifest),
    `titans-contacts-import-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  const clubs = await repo.listClubs(TENANT);
  await writeFile(backupPath, JSON.stringify(clubs, null, 2));
  console.log(`Backup written: ${backupPath} (${clubs.length} titans club(s))`);

  const cfg = await repo.getTenantConfig(TENANT);
  const orgName = orgCopy(cfg ?? { tenant: TENANT }).name;
  const link = plan.origin!; // a null origin with sends selected is a blocker (never reached here)
  const invitedBy = 'import:titans-contacts';

  // Merge into any existing manifest so pre-images survive across re-runs (a later --revert
  // must restore to the ORIGINAL state, not to a prior run's output). A present-but-corrupt
  // manifest ABORTS — silently starting fresh would discard every prior run's pre-images.
  const existingManifest = await readManifestForMerge(args.manifest);
  if (existingManifest.kind === 'corrupt') {
    throw new Error(
      `${args.manifest} exists but is unreadable/malformed (${existingManifest.detail}) — refusing ` +
        'to continue: writing through it now would discard every pre-image a prior run recorded. ' +
        'Fix the file by hand or move it aside (and pass --manifest) before re-running --confirm.',
    );
  }
  const manifestByEmail = new Map<string, ManifestEntry>();
  if (existingManifest.kind === 'ok')
    for (const e of existingManifest.entries) manifestByEmail.set(e.email, e);
  const persist = async (e: ManifestEntry): Promise<void> => {
    const prior = manifestByEmail.get(e.email);
    manifestByEmail.set(e.email, prior ? mergeManifestEntry(prior, e) : e);
    await writeManifest([...manifestByEmail.values()], args.manifest);
  };

  const failures: string[] = [];
  let granted = 0;
  let sent = 0;
  let sentPreviously = 0;
  let noChannels = 0;
  let writesWithoutSend = 0;

  for (const person of plan.people) {
    // An admin collision / active user was already surfaced; skip them entirely (grant would
    // demote an admin, and an active user keeps their access + isn't re-invited).
    if (person.account === 'admin-elsewhere') continue;

    // Capture the pre-image BEFORE any write, so revert has the exact snapshot.
    const priorSub = await getUserSubByEmail(cognito, pool, person.email);
    const priorProfile = priorSub ? await repo.getUser(priorSub) : null;
    const priorMembership = priorProfile?.memberships.find((m) => m.tenantId === TENANT) ?? null;
    const entry: ManifestEntry = {
      email: person.email,
      sub: priorSub ?? '',
      createdUser: priorProfile === null,
      granted: false,
      priorMembership,
      excoWrites: [],
      coachWrites: [],
      commLog: [],
      idempotencyKey: idempotencyKeyFor(person.email),
      sendMarkerClubId: person.sendMarkerClubId ?? null,
    };

    let claimedFor: string | null = null; // the marker-club we hold an unclaimed send for
    try {
      // 1. Exco + coach merge writes, per club, re-reading immediately before each write and
      //    merging ONLY the planned slots into the CURRENT club (POST /clubs/:id/exco is a
      //    whole-object replace, and a rep may have saved concurrently). The write carries the
      //    version from OUR re-read so the conditional write rejects a concurrent save rather
      //    than silently overwriting it; a version conflict re-reads + re-merges once.
      const rolesByClub = new Map<string, ClubRolePlan[]>();
      for (const role of person.roles) {
        rolesByClub.set(role.clubId, [...(rolesByClub.get(role.clubId) ?? []), role]);
      }
      for (const [clubId, roles] of rolesByClub) {
        let club = await repo.getClub(TENANT, clubId);
        if (!club) {
          console.warn(
            `  ⚠ ${person.email}: club ${clubId} not found at write time — skipping its exco/coach`,
          );
          continue;
        }
        for (let attempt = 0; ; attempt++) {
          const writes = computeClubWrites(club, roles, person);
          if (!writes.excoWrites.length && !writes.coachesChanged) break; // nothing to write
          try {
            await repo.updateClub(
              TENANT,
              clubId,
              {
                exco: writes.nextExco,
                ...(writes.coachesChanged ? { coaches: writes.nextCoaches } : {}),
                version: club.version,
              },
              invitedBy,
              new Date().toISOString(),
            );
            entry.excoWrites.push(...writes.excoWrites);
            if (writes.coachesChanged) entry.coachWrites!.push(clubId);
            if (person.account === 'active' || plan.dataOnly) writesWithoutSend++;
            break;
          } catch (err: unknown) {
            // A lost race with a concurrent rep save: re-read + re-merge and try once more,
            // then give up (recorded as a per-person failure by the outer catch).
            if (err instanceof Error && err.name === 'VersionConflictError' && attempt === 0) {
              console.warn(
                `  ⚠ ${person.email}: ${club.name} changed concurrently — re-reading + retrying its exco/coach once`,
              );
              const reread = await repo.getClub(TENANT, clubId);
              if (!reread) {
                console.warn(`  ⚠ ${person.email}: club ${clubId} gone on re-read — skipping`);
                break;
              }
              club = reread;
              continue;
            }
            throw err;
          }
        }
      }

      // 2. Account grant + invite send — skipped under --data-only and for active users.
      if (person.invite) {
        const { sub } = await grantClubRep(
          cognito,
          pool,
          TENANT,
          person.email,
          person.unionClubIds,
          {
            invitedBy,
          },
        );
        entry.sub = sub;
        entry.granted = true; // gates the revert restore — only a real grant is undone
        granted++;

        const markerClub = person.sendMarkerClubId;
        if (markerClub) {
          const key = entry.idempotencyKey;
          // Honor the per-person channel PLAN: only channels the dry-run judged `send` go out
          // (a landline the plan marked whatsapp:skip must never be billed a Meta send), and
          // the marker records those EFFECTIVE channels, not the raw --channels request.
          const { channels: effectiveChannels, cell: sendCell } = effectiveInviteChannels(person);
          if (effectiveChannels.length === 0) {
            noChannels++;
            console.log(
              `  · ${person.email}: no channels to send (all planned channels skipped) — account granted, no invite sent`,
            );
          } else {
            const replay = await repo.claimInviteSend(
              TENANT,
              markerClub,
              key,
              effectiveChannels,
              'staff-invite',
            );
            if (replay) {
              sentPreviously++;
              console.log(`  · ${person.email}: send already recorded (replay) — skipped`);
            } else {
              claimedFor = markerClub;
              const { results } = await sendStaffInvite({
                email: person.email,
                name: person.name,
                cell: sendCell,
                orgName,
                channels: effectiveChannels,
                link,
              });
              const anySent = results.some((r) => r.status === 'sent');
              if (anySent) {
                await repo.completeInviteSend(TENANT, markerClub, key, results);
                sent++;
              } else {
                // Every requested channel failed (e.g. WhatsApp rejected on a not-yet-Active template):
                // release the claim so a fixed re-run isn't blocked for the 72h TTL, and record
                // the failure. Completing here would mark the person sent-previously and swallow
                // the resend.
                await repo.releaseInviteClaim(TENANT, markerClub, key);
                const detail = results.map((r) => `${r.channel}:${r.status}`).join(', ');
                failures.push(`${person.email}: all channels failed (${detail})`);
                console.error(
                  `  ✗ ${person.email}: all channels failed (${detail}) — claim released for re-run`,
                );
              }
              claimedFor = null;

              // 3. Comm-log to every club the person is attached to (per-channel results —
              //    including a failed channel; the log records what actually happened).
              const now = new Date().toISOString();
              for (const clubId of person.sheetClubIds) {
                const events: ClubCommEvent[] = results.map((r) => ({
                  id: randomUUID(),
                  channel: r.channel,
                  ...(r.to ? { to: r.to } : {}),
                  status: r.status,
                  ...(r.messageId ? { messageId: r.messageId } : {}),
                  ...(r.error ? { error: r.error } : {}),
                  at: now,
                  by: invitedBy,
                  idempotencyKey: key,
                  kind: 'staff-invite',
                }));
                await repo.appendClubCommEvents(TENANT, clubId, events);
                for (const e of events) entry.commLog.push({ clubId, eventId: e.id });
              }
            }
          }
        }
      } else if (plan.dataOnly) {
        // exco/coach already written above; nothing else.
      }

      await persist(entry); // merge + write as writes land
    } catch (err: unknown) {
      // Per-person isolation: record the failure with context, release a still-held claim so
      // the person isn't blocked for the 72h TTL, and continue with the rest.
      if (claimedFor) {
        try {
          await repo.releaseInviteClaim(TENANT, claimedFor, entry.idempotencyKey);
        } catch (releaseErr) {
          console.warn(`  ⚠ ${person.email}: failed to release invite claim:`, releaseErr);
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${person.email}: ${message}`);
      console.error(`  ✗ ${person.email}: ${message}`);
      // Still persist what landed for this person (exco writes may have committed).
      await persist(entry);
    }
  }

  console.log(
    `\n· granted ${granted} rep account(s), ${sent} invite(s) sent, ${sentPreviously} already-sent (replay), ${noChannels} granted-without-channels, ${writesWithoutSend} exco/coach write(s) without a send.`,
  );
  console.log(`· manifest: ${args.manifest} (${manifestByEmail.size} person entr(y/ies))`);
  if (failures.length) {
    console.error(`\n✗ ${failures.length} per-person failure(s):`);
    for (const f of failures) console.error(`   ${f}`);
    process.exitCode = 1;
  }
}

// ───────────────────────── Revert ─────────────────────────

/** restoreMembership is defaulted from tenant-admin; a test injects a fake (no AWS) to assert
 * the granted-gate — that a non-granted entry is never restored. */
export interface RevertDeps {
  restoreMembership: typeof import('./tenant-admin.js').restoreMembership;
}

export async function runRevert(repo: RepoModule, args: Args, deps?: RevertDeps): Promise<void> {
  const { restoreMembership } = deps ?? (await import('./tenant-admin.js'));
  const entries = await readManifest(args.manifest);
  console.log(`Reverting ${entries.length} person entr(y/ies) from ${args.manifest}`);
  console.log(
    '(Cognito accounts are left in place — a dormant passwordless OTP user with no membership ' +
      'has no access and is harmless. Sent messages cannot be unsent.)',
  );

  const failures: string[] = [];
  let restored = 0;
  let excoRestored = 0;
  let coachesRemoved = 0;
  for (const entry of entries) {
    try {
      // 1. Exco + coaches: re-read each club this run wrote to and undo ONLY what it wrote — an
      //    exco slot still holding this person (skip + warn on drift), and coach entries matching
      //    this person's email + COACH_SOURCE (entries added/edited by others are left intact).
      const emailLc = entry.email.trim().toLowerCase();
      const excoByClub = new Map<string, ExcoWrite[]>();
      for (const w of entry.excoWrites)
        excoByClub.set(w.clubId, [...(excoByClub.get(w.clubId) ?? []), w]);
      const coachClubs = new Set(entry.coachWrites ?? []);
      for (const clubId of new Set<string>([...excoByClub.keys(), ...coachClubs])) {
        const excoWrites = excoByClub.get(clubId) ?? [];
        const removeCoaches = coachClubs.has(clubId);
        let club = await repo.getClub(TENANT, clubId);
        if (!club) {
          console.warn(`  ⚠ ${entry.email}: club ${clubId} gone — cannot restore its exco/coaches`);
          continue;
        }
        // Re-read → drift-check → restore, carrying OUR read's version so a concurrent save
        // rejects the write (rather than clobbering it); a conflict re-reads + retries once.
        for (let attempt = 0; ; attempt++) {
          const nextExco = { ...(club.exco ?? {}) };
          let excoChanged = false;
          for (const w of excoWrites) {
            const current = nextExco[w.slot] as { email?: unknown } | undefined;
            const currentEmail =
              typeof current?.email === 'string' ? current.email.trim().toLowerCase() : '';
            if (currentEmail !== emailLc) {
              console.warn(
                `  ⚠ ${entry.email}: exco slot "${w.slot}" on ${club.name} changed since import — leaving as-is`,
              );
              continue;
            }
            if (w.priorValue == null) delete nextExco[w.slot];
            else nextExco[w.slot] = w.priorValue;
            excoChanged = true;
          }
          // Coaches: drop only this run's own appends (email + source). A drifted/edited or
          // already-removed entry no longer matches and is left as-is (not an error).
          const beforeCoaches = Array.isArray(club.coaches) ? club.coaches : [];
          const nextCoaches = removeCoaches
            ? beforeCoaches.filter((c) => {
                const rec = c as { email?: unknown; source?: unknown };
                return !(
                  typeof rec.email === 'string' &&
                  rec.email.trim().toLowerCase() === emailLc &&
                  rec.source === COACH_SOURCE
                );
              })
            : beforeCoaches;
          const coachesChanged = nextCoaches.length !== beforeCoaches.length;
          if (!excoChanged && !coachesChanged) break;
          try {
            await repo.updateClub(
              TENANT,
              clubId,
              {
                ...(excoChanged ? { exco: nextExco } : {}),
                ...(coachesChanged ? { coaches: nextCoaches } : {}),
                version: club.version,
              },
              'import:titans-contacts:revert',
              new Date().toISOString(),
            );
            if (excoChanged) excoRestored++;
            if (coachesChanged) coachesRemoved++;
            break;
          } catch (err: unknown) {
            if (err instanceof Error && err.name === 'VersionConflictError' && attempt === 0) {
              console.warn(
                `  ⚠ ${entry.email}: ${club.name} changed concurrently during revert — re-reading + retrying once`,
              );
              const reread = await repo.getClub(TENANT, clubId);
              if (!reread) {
                console.warn(`  ⚠ ${entry.email}: club ${clubId} gone on re-read — skipping`);
                break;
              }
              club = reread;
              continue;
            }
            throw err;
          }
        }
      }

      // 2. Membership: restore the exact pre-image snapshot (null ⇒ remove; last membership ⇒
      //    full offboard) through the guarded helper — never a hand-written USER# item. Only a
      //    person this run actually GRANTED is restored: an active user or a --data-only run
      //    never had its membership written, so `granted:false` leaves it untouched.
      if (entry.granted && entry.sub) {
        const result = await restoreMembership(entry.sub, TENANT, entry.priorMembership);
        if (result.offboarded)
          console.log(
            `  · ${entry.email}: membership removed (user had no other memberships — offboarded)`,
          );
        else if (entry.priorMembership)
          console.log(`  · ${entry.email}: membership restored to its pre-import snapshot`);
        else console.log(`  · ${entry.email}: import membership removed`);
        restored++;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${entry.email}: ${message}`);
      console.error(`  ✗ ${entry.email}: ${message}`);
    }
  }

  console.log(
    `\n· reverted ${restored} membership(s), ${excoRestored} club exco write(s), ${coachesRemoved} coach append(s).`,
  );
  if (failures.length) {
    console.error(`\n✗ ${failures.length} revert failure(s):`);
    for (const f of failures) console.error(`   ${f}`);
    process.exitCode = 1;
  }
}

// ───────────────────────── Main ─────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.revert) {
    const repo = await import('./repo.js');
    await runRevert(repo, args);
    return;
  }

  const wb = await loadWorkbook(args.file);
  const parsed = parseContactsWorkbook(wb);

  if (args.parseOnly) {
    runParseOnly(parsed);
    return;
  }

  // Dry-run / confirm need the stage (read-only for the plan; writes only under --confirm).
  const repo = await import('./repo.js');
  const { CognitoIdentityProviderClient } =
    await import('@aws-sdk/client-cognito-identity-provider');
  const { userPoolId } = await import('./env.js');
  const cognito = new CognitoIdentityProviderClient({});
  const pool = process.env.LOCAL_AUTH === '1' ? 'local-pool' : userPoolId();

  const inputs = await gatherInputs(repo, cognito, pool, parsed, args);
  const plan = buildPlan(inputs);
  printPlan(plan);

  if (plan.blockers.length) {
    console.error('\n✗ Refusing to continue while blockers stand.');
    process.exitCode = 1;
    return;
  }
  if (!args.confirm) {
    console.log('\nRe-run with --confirm to write (accounts + exco + sends).');
    return;
  }
  await runConfirm(repo, cognito, pool, plan, args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

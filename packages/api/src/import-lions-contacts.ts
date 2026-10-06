/**
 * Lions (CGL) club-contact import — chairman + secretary portal accounts and invites, from the
 * CGL 2026/27 affiliation Google-Form export (the same workbook import-lions-affiliation.ts
 * reads, parsed by the same lions-affiliation-parse.ts).
 *
 *   npx tsx src/import-lions-contacts.ts --parse-only [--file <affiliation>.xlsx]
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run import-lions-contacts -- \
 *     [--file <affiliation>.xlsx]                                                 # dry-run
 *   … --data-only --confirm       # memberships + officer slots, NO sends (fixtures cutover)
 *   … --confirm                   # memberships + officer slots + email invites
 *   … --channels email,whatsapp   # add WhatsApp
 *   … --club "<club id or name>"  # one club only
 *   … --skip-club "<club id or name>"   # (repeatable) drop a club; the ONLY way its blocker stops blocking
 *   … --confirm --resend          # re-send to EVERYONE matched, ignoring completed send markers
 *   … --confirm --allow-dry-run-sends   # deliberate test: let a dry-run channel "send" (nothing real goes out)
 *   … --revert [--manifest <path>]
 *
 * Adapted from import-titans-contacts.ts (the proven send machinery, kept as close to verbatim
 * as the different source allows — see that file's header for the 29 Sep 2026 dry-run-send
 * incident the --confirm guard exists for). What differs:
 *   - Source: the affiliation form, one record per club (latest submission wins), exactly two
 *     officers per club — chairman → exco `chair`, secretary → exco `sec`. No designation
 *     mapping, no coaches, no sectioned sheet.
 *   - `--data-only` GRANTS memberships (grantClubRep — Cognito user created with the welcome
 *     message SUPPRESSED) and fills officer slots, but sends nothing. Titans' `--data-only`
 *     skipped the grant; here it runs in the fixtures cutover so the officers' portal accounts
 *     exist before the invites go out the following week. A later send run sees them as
 *     `pending-exists` (never signed in) and re-grants idempotently + sends.
 *   - Officer slots are normally ALREADY filled by import-lions-affiliation (same parser, same
 *     normalised email), so the usual slot action is `keep` (no write). A slot holding a
 *     DIFFERENT email is a CONFLICT blocker — never overwritten.
 *   - Known form data-quality cases are handled, not crashed on: a cell with several emails
 *     (first used — parser warning), a landline-looking number (email-only), the chairman and
 *     secretary sharing ONE email (one account holding both slots), the chairman and secretary
 *     sharing one cell with different emails (both accounts, but the secretary's WhatsApp is
 *     suppressed so one phone never gets two invites), a blank officer (slot left empty,
 *     reported) and an officer with details but no usable email (BLOCKER — cannot anchor an
 *     account).
 *
 * Fail-closed: a rejected/unresolved form row, an affiliated club missing from the stage, an
 * exco-slot conflict, a lions-admin collision, an officer with no usable email, or a missing
 * canonical origin when sends are requested all abort with a printed BLOCKERS report.
 * `--confirm` refuses while any stand — `--skip-club` is the only escape hatch.
 *
 * NEVER hand-writes USER# items: account grants go through grantClubRep and reverts through
 * restoreMembership (tenant-admin.ts), so the last-admin transactional guard always applies.
 *
 * See docs/runbooks/lions-contact-import.md.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import {
  parseAffiliationWorkbook,
  type AffiliationContact,
  type ParsedAffiliation,
} from './lions-affiliation-parse.js';
import { CLUB_MAP } from './lions-import-map.js';
import { canonicalWebOrigin } from './origins.js';
// The tenant-neutral, already-tested pieces of the Titans contacts CLI. Importing that module
// never loads notify/email.ts or notify/whatsapp.ts (its own load-order test guards this), so
// bootstrapNotifyEnvFromSst still runs before either sender freezes its dry-run flag.
import {
  bootstrapNotifyEnvFromSst,
  isLikelyLandline,
  mergeManifestEntry,
  type ManifestEntry,
} from './import-titans-contacts.js';
// NOT './notify/whatsapp.js': loading that module freezes WHATSAPP_DRY_RUN from process.env,
// which must only happen AFTER bootstrapNotifyEnvFromSst() (see main()).
import { toE164 } from './notify/e164.js';
import type { Channel, ClubCommEvent } from './types.js';

export type { ManifestEntry };

type RepoModule = typeof import('./repo.js');

const TENANT = 'lions';
const DEFAULT_FILE = '/Users/carlton/Downloads/Lions/CGL Affiliation 2026_27 (Responses) (2).xlsx';
/** Updates actor, membership invitedBy and comm-log `by`. */
const IMPORT_ACTOR = 'import:lions-contacts';
/** Legacy (no stage resolvable) manifest path; normally stage-scoped — see manifestPathFor. */
const LEGACY_MANIFEST_PATH = './lions-contacts-import-manifest.json';
/** Kept identical to the Titans CLI / notify EMAIL_RE. */
const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;
/** Same key shape as the Titans import (`staff-import-<email>`); the INVITE# marker keyspace is
 * tenant-scoped, so the two tenants never collide. */
const idempotencyKeyFor = (email: string): string => `staff-import-${email}`;
/** The key a `--resend` run claims instead (see import-titans-contacts.ts). */
export const resendIdempotencyKeyFor = (email: string): string =>
  `${idempotencyKeyFor(email)}#resend`;

export type OfficerRole = 'chairman' | 'secretary';
export type ExcoKey = 'chair' | 'sec';
/** The affiliation form has exactly two officers per club: chairman → chair, secretary → sec. */
export const SLOT_OF: Record<OfficerRole, ExcoKey> = { chairman: 'chair', secretary: 'sec' };
const EXCO_LABEL: Record<ExcoKey, string> = { chair: 'Chairperson', sec: 'Secretary' };

/**
 * The manifest path when no --manifest is given: stage-scoped (SST_STAGE, else
 * SST_RESOURCE_App's stage) so a dev run's manifest can never be reverted against prod —
 * the same resolution import-lions-affiliation.ts uses. No stage ⇒ the legacy unsuffixed name.
 */
export function manifestPathFor(env: NodeJS.ProcessEnv = process.env): string {
  let stage = env.SST_STAGE?.trim();
  if (!stage && env.SST_RESOURCE_App) {
    try {
      const app = JSON.parse(env.SST_RESOURCE_App) as { stage?: unknown };
      if (typeof app.stage === 'string') stage = app.stage.trim();
    } catch {
      throw new Error('SST_RESOURCE_App is set but is not valid JSON — cannot resolve the stage');
    }
  }
  if (!stage) return LEGACY_MANIFEST_PATH;
  if (!/^[A-Za-z0-9_-]+$/.test(stage)) throw new Error(`unsafe stage name "${stage}"`);
  return `./lions-contacts-import-manifest.${stage}.json`;
}

// ───────────────────────── Invitee extraction (pure) ─────────────────────────

export interface Invitee {
  clubId: string;
  clubName: string;
  role: OfficerRole;
  slot: ExcoKey;
  /** The kept form row (for the operator cross-check). */
  rowNumber: number;
  name: string;
  /** Lowercased; first address when the cell held several. */
  email: string;
  /** ZA local "0XXXXXXXXX", or '' when absent/unusable. */
  cell: string;
  /** When set, the club's other officer (this email) has the SAME cell under a different
   * email: this invitee's WhatsApp is suppressed so one phone never receives two invites. */
  cellSharedWith?: string;
}

export type IssueKind =
  | 'blank-officer'
  | 'no-email'
  | 'landline'
  | 'no-cell'
  | 'shared-email'
  | 'shared-cell'
  | 'extra-cells'
  | 'form-warning';

export interface ContactIssue {
  clubId: string;
  clubName: string;
  kind: IssueKind;
  detail: string;
  /** True ⇒ also a run-level blocker. */
  blocking: boolean;
}

const ROLE_LABEL: Record<OfficerRole, string> = { chairman: 'chairman', secretary: 'secretary' };

/**
 * Turn the parsed form into one invitee per (club, officer) plus the data-quality issues.
 * PURE. A blank officer (no name, email or cell) is reported and skipped — the slot is left
 * empty. An officer with details but no usable email is a BLOCKER (an account is keyed by
 * email). Sharing detection is within one club only: a shared email collapses later (people
 * are grouped by email); a shared cell under different emails flags the secretary.
 */
export function extractInvitees(parsed: ParsedAffiliation): {
  invitees: Invitee[];
  issues: ContactIssue[];
} {
  const invitees: Invitee[] = [];
  const issues: ContactIssue[] = [];
  for (const r of parsed.records) {
    const clubId = r.club.id;
    const clubName = r.club.name;
    const issue = (kind: IssueKind, detail: string, blocking = false) =>
      issues.push({ clubId, clubName, kind, detail, blocking });

    // The parser's own contact warnings (multi-email cells, unusable numbers, invalid emails).
    for (const w of r.warnings) {
      if (/^(chairman|secretary) (cell|email):/.test(w)) issue('form-warning', w);
    }

    const officers: Array<[OfficerRole, AffiliationContact]> = [
      ['chairman', r.chairman],
      ['secretary', r.secretary],
    ];
    const clubInvitees: Invitee[] = [];
    for (const [role, c] of officers) {
      if (!c.name && !c.email && !c.cell.cell) {
        issue('blank-officer', `no ${ROLE_LABEL[role]} on the form — slot left empty`);
        continue;
      }
      if (!EMAIL_RE.test(c.email)) {
        issue(
          'no-email',
          `${ROLE_LABEL[role]} ${c.name || '(no name)'} has no usable email — cannot grant an account`,
          true,
        );
        continue;
      }
      if (c.cell.cell && isLikelyLandline(c.cell.cell)) {
        issue(
          'landline',
          `${ROLE_LABEL[role]} ${c.name}: number looks like a landline — email only`,
        );
      } else if (!c.cell.cell) {
        issue('no-cell', `${ROLE_LABEL[role]} ${c.name}: no usable cell — email only`);
      }
      if (c.cell.extra.length) {
        issue(
          'extra-cells',
          `${ROLE_LABEL[role]} ${c.name}: ${c.cell.extra.length} further number(s) in the cell ignored (first used)`,
        );
      }
      clubInvitees.push({
        clubId,
        clubName,
        role,
        slot: SLOT_OF[role],
        rowNumber: r.rowNumber,
        name: c.name,
        email: c.email,
        cell: c.cell.cell,
      });
    }

    const [chair, sec] = [
      clubInvitees.find((i) => i.role === 'chairman'),
      clubInvitees.find((i) => i.role === 'secretary'),
    ];
    if (chair && sec) {
      if (chair.email === sec.email) {
        issue(
          'shared-email',
          `chairman ${chair.name} and secretary ${sec.name} share one email — ONE account holds both slots`,
        );
      } else if (chair.cell && chair.cell === sec.cell) {
        sec.cellSharedWith = chair.email;
        issue(
          'shared-cell',
          `chairman ${chair.name} and secretary ${sec.name} share one cell under different emails — ` +
            'likely one person; both accounts granted, secretary invited by email only',
        );
      }
    }
    invitees.push(...clubInvitees);
  }
  return { invitees, issues };
}

/**
 * Which of a person's rows is the email's actual owner, when one email was given for two
 * differently-named officers (chairman + secretary sharing a club address). Prefers the row
 * whose name appears in the email's local part ("mikephillips961@" → Michael Phillips), else
 * the first row with a name, else 0. The invite's name AND WhatsApp cell both come from this
 * row, so a message is never addressed to one officer on the other officer's phone. PURE.
 */
export function pickPrimaryIndex(email: string, rows: Array<{ name: string }>): number {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  const hit = rows.findIndex((r) =>
    r.name
      .toLowerCase()
      .split(/[^a-z]+/)
      .some((tok) => tok.length >= 3 && local.includes(tok)),
  );
  if (hit >= 0) return hit;
  return Math.max(
    0,
    rows.findIndex((r) => r.name),
  );
}

// ───────────────────────── Plan types (pure) ─────────────────────────

type ExcoSlotAction = 'set' | 'keep' | 'CONFLICT';
type AccountAction = 'create' | 'pending-exists' | 'active' | 'admin-elsewhere';

export interface ClubRolePlan {
  clubId: string;
  clubName: string;
  role: OfficerRole;
  /** The form's own name/email/cell for THIS slot (written on `set`). */
  contact: { name: string; email: string; cell: string };
  exco: { slot: ExcoKey; action: ExcoSlotAction; existingEmail?: string };
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
  /** Club ids this person is an officer of on the form. */
  sheetClubIds: string[];
  /** Existing lions-membership clubIds (empty when the user has no lions membership). */
  existingClubIds: string[];
  /** sheet ∪ existing — what grantClubRep must receive (it REPLACES membership wholesale). */
  unionClubIds: string[];
  account: AccountAction;
  roles: ClubRolePlan[];
  channels: ChannelPlan[];
  /** Whether grantClubRep runs (create / pending-exists — INCLUDING under --data-only). */
  grant: boolean;
  /** Whether an invite send would happen (grant && !--data-only). */
  invite: boolean;
  /** The club whose INVITE# keyspace carries this person's single send marker. */
  sendMarkerClubId?: string;
  blockers: string[];
}

export interface ContactPlan {
  people: PersonPlan[];
  issues: ContactIssue[];
  /** Affiliated clubs whose id is not on the stage (blockers — run import-lions-affiliation). */
  missingClubs: Array<{ id: string; name: string }>;
  /** Clubs excluded via --skip-club (reported, never blocking). */
  skippedClubs: string[];
  /** Clubs with no affiliation response → no officers to invite (informational). */
  clubsWithoutContacts: Array<{ id: string; name: string }>;
  origin: string | null;
  channels: Channel[];
  dataOnly: boolean;
  blockers: string[];
}

/** Existing-user facts resolved read-only by the caller (a fake map in tests). */
export interface ExistingUser {
  active: boolean;
  role: 'admin' | 'rep' | null;
  clubIds: string[];
}

export interface LiveClub {
  id: string;
  name: string;
  exco?: Record<string, unknown>;
}

export interface BuildPlanInputs {
  parsed: ParsedAffiliation;
  /** The tenant's clubs on the stage (CLUB_MAP stand-ins under --parse-only). */
  liveClubs: LiveClub[];
  userByEmail: Map<string, ExistingUser>;
  origin: string | null;
  channels: Channel[];
  dataOnly: boolean;
  /** Club ids or names (case-insensitive) to exclude. */
  skipClubs: string[];
  /** Optional single-club filter (id or name, case-insensitive). */
  onlyClub?: string;
}

// ───────────────────────── Plan builder (pure) ─────────────────────────

const eq = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function slotEmail(exco: Record<string, unknown> | undefined, slot: ExcoKey): string | undefined {
  const v = exco?.[slot] as { email?: unknown } | undefined;
  const email = typeof v?.email === 'string' ? v.email.trim().toLowerCase() : '';
  return email || undefined;
}

/**
 * Build the per-person plan. PURE — the dry-run and --confirm paths share it, and tests drive
 * it with fakes. The unit of account work is the EMAIL: invitees are grouped by email, so an
 * officer of two clubs (or one email given for both chairman and secretary) is ONE person,
 * one grant and one invite, holding every slot.
 */
export function buildPlan(inputs: BuildPlanInputs): ContactPlan {
  const { parsed, liveClubs, userByEmail, origin, channels, dataOnly } = inputs;
  const matchesClub = (needle: string, id: string, name: string) =>
    eq(needle, id) || eq(needle, name);
  const isSkipped = (id: string, name: string) =>
    inputs.skipClubs.some((s) => matchesClub(s, id, name));
  const isIncluded = (id: string, name: string) =>
    !isSkipped(id, name) && (!inputs.onlyClub || matchesClub(inputs.onlyClub, id, name));

  const blockers: string[] = [];
  for (const r of parsed.rejected) {
    blockers.push(
      `form row ${r.rowNumber} ("${r.rawClubName}") rejected by the parser: ${r.reason}`,
    );
  }
  const recordClubs = parsed.records.map((r) => r.club);
  if (
    inputs.onlyClub &&
    !recordClubs.some((c) => matchesClub(inputs.onlyClub!, c.id, c.name)) &&
    !CLUB_MAP.some((c) => matchesClub(inputs.onlyClub!, c.id, c.name))
  ) {
    blockers.push(`--club "${inputs.onlyClub}" matched no club`);
  }
  for (const s of inputs.skipClubs) {
    if (!CLUB_MAP.some((c) => matchesClub(s, c.id, c.name)))
      blockers.push(`--skip-club "${s}" matched no club (typo?)`);
  }

  const skippedClubs = recordClubs.filter((c) => isSkipped(c.id, c.name)).map((c) => c.name);
  const liveById = new Map(liveClubs.map((c) => [c.id, c]));
  const missingClubs = recordClubs
    .filter((c) => isIncluded(c.id, c.name) && !liveById.has(c.id))
    .map((c) => ({ id: c.id, name: c.name }));
  for (const c of missingClubs) {
    blockers.push(
      `club "${c.name}" (${c.id}) is not on this stage — run import-lions-affiliation first (or --skip-club it)`,
    );
  }

  const withRecord = new Set(recordClubs.map((c) => c.id));
  const clubsWithoutContacts = CLUB_MAP.filter(
    (c) => !withRecord.has(c.id) && isIncluded(c.id, c.name),
  ).map((c) => ({ id: c.id, name: c.name }));

  const extracted = extractInvitees(parsed);
  const issues = extracted.issues.filter((i) => isIncluded(i.clubId, i.clubName));
  for (const i of issues) if (i.blocking) blockers.push(`${i.clubName}: ${i.detail}`);

  // Group invitees by email (first-seen order); drop clubs not on the stage (already blockers).
  const groups = new Map<string, Invitee[]>();
  for (const inv of extracted.invitees) {
    if (!isIncluded(inv.clubId, inv.clubName) || !liveById.has(inv.clubId)) continue;
    groups.set(inv.email, [...(groups.get(inv.email) ?? []), inv]);
  }

  const people: PersonPlan[] = [];
  for (const [email, rows] of groups) {
    const primary = rows[pickPrimaryIndex(email, rows)];
    const name = primary.name || (rows.find((r) => r.name)?.name ?? '');
    // The cell travels with the primary row; another row's cell only when it has none.
    const cellRow = primary.cell ? primary : rows.find((r) => r.cell);
    const cell = cellRow?.cell ?? '';
    const existing = userByEmail.get(email);
    const personBlockers: string[] = [];

    const roles: ClubRolePlan[] = [];
    const sheetClubIds = new Set<string>();
    for (const row of rows) {
      sheetClubIds.add(row.clubId);
      const occupied = slotEmail(liveById.get(row.clubId)?.exco, row.slot);
      const action: ExcoSlotAction = occupied ? (eq(occupied, email) ? 'keep' : 'CONFLICT') : 'set';
      roles.push({
        clubId: row.clubId,
        clubName: row.clubName,
        role: row.role,
        contact: { name: row.name, email, cell: row.cell },
        exco: { slot: row.slot, action, ...(occupied ? { existingEmail: occupied } : {}) },
      });
      if (action === 'CONFLICT') {
        personBlockers.push(
          `${row.clubName}: exco slot "${EXCO_LABEL[row.slot]}" already held by ${occupied} (form wants ${email})`,
        );
      }
    }

    let account: AccountAction;
    if (existing?.role === 'admin') account = 'admin-elsewhere';
    else if (existing?.active) account = 'active';
    else if (existing) account = 'pending-exists';
    else account = 'create';
    if (account === 'admin-elsewhere') {
      personBlockers.push(
        `${email} is a lions ADMIN — granting rep would demote them; --skip-club the club or manage in Team & Access`,
      );
    }

    const existingClubIds = existing?.clubIds ?? [];
    const unionClubIds = [...new Set([...sheetClubIds, ...existingClubIds])];
    const grant = account === 'create' || account === 'pending-exists';
    const invite = grant && !dataOnly;

    // WhatsApp is suppressed when the row this cell came from shares it with the club's other
    // officer under a different email (the secretary half of a shared-cell pair).
    const sharedWith = cellRow?.cellSharedWith;
    const channelPlans: ChannelPlan[] = [];
    if (invite) {
      for (const channel of channels) {
        if (channel === 'email') {
          channelPlans.push({ channel, status: 'send', to: email });
        } else {
          const e164 = toE164(cell);
          if (!e164) channelPlans.push({ channel, status: 'skip', reason: 'no cell' });
          else if (isLikelyLandline(cell))
            channelPlans.push({ channel, status: 'skip', to: e164, reason: 'landline?' });
          else if (sharedWith)
            channelPlans.push({
              channel,
              status: 'skip',
              to: e164,
              reason: `cell shared with ${sharedWith}`,
            });
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
      grant,
      invite,
      ...(sendMarkerClubId ? { sendMarkerClubId } : {}),
      blockers: personBlockers,
    });
    blockers.push(...personBlockers);
  }

  const anyWouldSend = people.some((p) => p.channels.some((c) => c.status === 'send'));
  if (anyWouldSend && !origin) {
    blockers.push(
      'no canonical web origin for lions — the invite link would be empty; a CLI never falls back to localhost',
    );
  }

  return {
    people,
    issues,
    missingClubs,
    skippedClubs,
    clubsWithoutContacts,
    origin,
    channels,
    dataOnly,
    blockers,
  };
}

/** Whole-run counts for the report (and the test of the real-data shape). PURE. */
export function summarizePlan(plan: ContactPlan): {
  clubs: number;
  officers: number;
  people: number;
  emailOnly: number;
  whatsapp: number;
  blockers: number;
} {
  const clubs = new Set(plan.people.flatMap((p) => p.sheetClubIds)).size;
  const officers = plan.people.reduce((n, p) => n + p.roles.length, 0);
  const wa = (p: PersonPlan) => p.channels.find((c) => c.channel === 'whatsapp')?.status === 'send';
  return {
    clubs,
    officers,
    people: plan.people.length,
    whatsapp: plan.people.filter(wa).length,
    emailOnly: plan.people.filter((p) => p.invite && !wa(p)).length,
    blockers: plan.blockers.length,
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
  resend: boolean;
  allowDryRunSends: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    file: DEFAULT_FILE,
    parseOnly: false,
    confirm: false,
    skipClubs: [],
    channels: ['email'],
    dataOnly: false,
    revert: false,
    manifest: '',
    resend: false,
    allowDryRunSends: false,
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
    else if (a === '--manifest') args.manifest = argv[++i] ?? '';
    else if (a === '--resend') args.resend = true;
    else if (a === '--allow-dry-run-sends') args.allowDryRunSends = true;
    else throw new Error(`unknown flag ${a}`);
  }
  if (!args.manifest) args.manifest = manifestPathFor();
  if (args.dataOnly && args.resend) throw new Error('--resend has no meaning with --data-only');
  if (args.revert) return args;
  if (!args.file) throw new Error('requires --file "<affiliation>.xlsx" (or --revert)');
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

async function loadWorkbook(file: string): Promise<ExcelJS.Workbook> {
  const bytes = await readFile(file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

// ───────────────────────── Reporting ─────────────────────────

function printIssues(plan: ContactPlan): void {
  const byKind = new Map<IssueKind, ContactIssue[]>();
  for (const i of plan.issues) byKind.set(i.kind, [...(byKind.get(i.kind) ?? []), i]);
  if (!plan.issues.length) return;
  console.log('\n── Data-quality notes');
  for (const [kind, list] of byKind) {
    console.log(`  ${kind} (${list.length}):`);
    for (const i of list) console.log(`     ${i.blocking ? '✗' : '·'} ${i.clubName}: ${i.detail}`);
  }
}

function printPlan(plan: ContactPlan): void {
  console.log(
    `\n── Plan (${plan.people.length} person(s), origin ${plan.origin ?? 'NONE'}${plan.dataOnly ? ', --data-only: NO sends' : ''})`,
  );
  for (const p of plan.people) {
    const clubs = p.roles.map((r) => `${r.clubName} ${EXCO_LABEL[r.exco.slot]}:${r.exco.action}`);
    console.log(`  ${p.name || '(no name)'} <${p.email}>  account=${p.account}`);
    console.log(`      clubs: ${clubs.join('; ') || '(none)'}`);
    if (p.grant && p.unionClubIds.length !== p.sheetClubIds.length) {
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
      console.log('      invite: none (active — membership untouched; form clubs NOT added)');
    } else if (p.grant) {
      console.log('      membership grant only (--data-only — no send)');
    } else {
      console.log(`      invite: none (${p.account})`);
    }
  }

  printIssues(plan);
  if (plan.clubsWithoutContacts.length) {
    console.log(
      `\n  · ${plan.clubsWithoutContacts.length} club(s) with no affiliation response — no officers to invite:`,
    );
    for (const c of plan.clubsWithoutContacts) console.log(`     ${c.name}`);
  }
  if (plan.skippedClubs.length) console.log(`  · skipped: ${plan.skippedClubs.join(', ')}`);

  const s = summarizePlan(plan);
  const byAccount = new Map<AccountAction, number>();
  for (const p of plan.people) byAccount.set(p.account, (byAccount.get(p.account) ?? 0) + 1);
  console.log('\n── Summary');
  console.log(
    `  ${s.clubs} club(s), ${s.officers} officer slot(s), ${s.people} person(s); ` +
      `whatsapp-send ${s.whatsapp}, email-only ${s.emailOnly}`,
  );
  for (const [action, n] of byAccount) console.log(`  ${action}: ${n}`);

  if (plan.blockers.length) {
    console.log(`\n✗ ${plan.blockers.length} BLOCKER(S) — --confirm refuses while any stand:`);
    for (const b of plan.blockers) console.log(`   ${b}`);
  } else {
    console.log('\n✓ No blockers.');
  }
}

/** `--parse-only`: no AWS. Plans against CLUB_MAP stand-ins with no live exco/users, so every
 * slot reads `set` and every account `create` — the live dry-run shows the real actions. */
function runParseOnly(parsed: ParsedAffiliation, args: Args): void {
  console.log(
    `\n── Affiliation sheet "${parsed.sheetName}": ${parsed.responseCount} response(s) → ${parsed.records.length} club record(s)`,
  );
  for (const d of parsed.duplicates) {
    console.log(
      `  · ${d.clubId}: kept row ${d.kept.rowNumber}, discarded ${d.discarded.map((x) => `row ${x.rowNumber}`).join(', ')} (older submission)`,
    );
  }
  const plan = buildPlan({
    parsed,
    liveClubs: CLUB_MAP.map((c) => ({ id: c.id, name: c.name })),
    userByEmail: new Map(),
    // The real origin is resolved under sst shell; a placeholder keeps parse-only AWS-free.
    origin: canonicalWebOrigin(TENANT) ?? '(resolved under sst shell)',
    channels: ['email', 'whatsapp'],
    dataOnly: false,
    skipClubs: args.skipClubs,
    onlyClub: args.club,
  });
  printPlan(plan);
  if (plan.blockers.length) {
    process.exitCode = 1;
    return;
  }
  console.log(
    '\n[parse-only] Nothing touched Cognito/DynamoDB. Channels shown for email,whatsapp; re-run under sst shell for the live plan.',
  );
}

// ───────────────────────── Read-only inputs ─────────────────────────

async function gatherInputs(
  repo: RepoModule,
  cognito: import('@aws-sdk/client-cognito-identity-provider').CognitoIdentityProviderClient,
  pool: string,
  parsed: ParsedAffiliation,
  args: Args,
): Promise<BuildPlanInputs> {
  const clubs = await repo.listClubs(TENANT);
  if (clubs.length === 0) {
    throw new Error(
      `tenant "${TENANT}" has no clubs on this stage — run import-lions-affiliation --confirm first`,
    );
  }
  const { getUserSubByEmail } = await import('./cognito-users.js');
  const userByEmail = new Map<string, ExistingUser>();
  const { invitees } = extractInvitees(parsed);
  for (const email of [...new Set(invitees.map((i) => i.email))]) {
    const sub = await getUserSubByEmail(cognito, pool, email);
    if (!sub) continue;
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
    liveClubs: clubs.map((c) => ({ id: c.id, name: c.name, exco: c.exco })),
    userByEmail,
    origin: canonicalWebOrigin(TENANT),
    channels: args.channels,
    dataOnly: args.dataOnly,
    skipClubs: args.skipClubs,
    onlyClub: args.club,
  };
}

// ───────────────────────── Manifest ─────────────────────────

type ExcoWrite = ManifestEntry['excoWrites'][number];

async function writeManifest(entries: ManifestEntry[], path: string): Promise<void> {
  await writeFile(path, JSON.stringify(entries, null, 2));
}

type ManifestReadResult =
  | { kind: 'absent' }
  | { kind: 'corrupt'; detail: string }
  | { kind: 'ok'; entries: ManifestEntry[] };

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

/** The channels a person's invite ACTUALLY sends on (only planned `send`s); the cell is
 * blanked unless WhatsApp is among them. Same rule as the Titans CLI. */
export function effectiveInviteChannels(person: PersonPlan): { channels: Channel[]; cell: string } {
  const channels = person.channels.filter((c) => c.status === 'send').map((c) => c.channel);
  return { channels, cell: channels.includes('whatsapp') ? person.cell : '' };
}

/** Where runConfirm/runRevert write progress. Defaults to the console (the CLI); tests pass a
 * no-op so production logging never reaches the node:test runner's IPC pipe. */
export interface ImportLog {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const CONSOLE_LOG: ImportLog = {
  log: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

/**
 * Exco merge for one club against a FRESHLY-READ record. Only `set` slots write (a `keep`
 * slot is left entirely untouched — it may carry governance fields); a slot that is no
 * longer empty is skipped + warned (drift). PURE given the read.
 */
export function computeClubWrites(
  club: { id: string; exco?: Record<string, unknown> },
  roles: ClubRolePlan[],
  warn: (line: string) => void = console.warn,
): { nextExco: Record<string, unknown>; excoWrites: ExcoWrite[] } {
  const nextExco: Record<string, unknown> = { ...(club.exco ?? {}) };
  const excoWrites: ExcoWrite[] = [];
  for (const role of roles) {
    if (role.exco.action !== 'set') continue;
    const nowEmail = slotEmail(club.exco, role.exco.slot);
    if (nowEmail) {
      warn(
        `  ⚠ ${role.contact.email}: exco slot "${EXCO_LABEL[role.exco.slot]}" on ${club.id} filled since planning (now ${nowEmail}) — skipping this slot`,
      );
      continue;
    }
    excoWrites.push({
      clubId: club.id,
      // ManifestEntry's slot type is the Titans ExcoKey union, a superset of ours.
      slot: role.exco.slot,
      priorValue: club.exco?.[role.exco.slot] ?? null,
    });
    const { name, email, cell } = role.contact;
    nextExco[role.exco.slot] = { name, email, ...(cell ? { cell } : {}) };
  }
  return { nextExco, excoWrites };
}

export interface ConfirmDeps {
  grantClubRep: typeof import('./tenant-admin.js').grantClubRep;
  getUserSubByEmail: typeof import('./cognito-users.js').getUserSubByEmail;
  sendStaffInvite: typeof import('./notify/index.js').sendStaffInvite;
  orgCopy: typeof import('./branding.js').orgCopy;
  dryRun: Record<Channel, boolean>;
}

async function loadConfirmDeps(): Promise<ConfirmDeps> {
  const [
    { grantClubRep },
    { getUserSubByEmail },
    { sendStaffInvite },
    { orgCopy },
    { EMAIL_DRY_RUN },
    { WHATSAPP_DRY_RUN },
  ] = await Promise.all([
    import('./tenant-admin.js'),
    import('./cognito-users.js'),
    import('./notify/index.js'),
    import('./branding.js'),
    import('./notify/email.js'),
    import('./notify/whatsapp.js'),
  ]);
  return {
    grantClubRep,
    getUserSubByEmail,
    sendStaffInvite,
    orgCopy,
    dryRun: { email: EMAIL_DRY_RUN, whatsapp: WHATSAPP_DRY_RUN },
  };
}

function dryRunReason(channel: Channel, env: NodeJS.ProcessEnv = process.env): string {
  if (env.NOTIFY_DRY_RUN === '1') return 'NOTIFY_DRY_RUN=1';
  const names =
    channel === 'email' ? ['FROM_EMAIL'] : ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'];
  const missing = names.filter((n) => !env[n]);
  return missing.length
    ? `${missing.join(' + ')} unset`
    : 'notify module loaded before env was set';
}

/** The --confirm dry-run send guard (the 29 Sep 2026 incident — see the Titans CLI). Empty ⇒
 * proceed. Nothing fires under --data-only (no send planned). PURE. */
export function dryRunSendRefusals(
  plan: ContactPlan,
  dryRun: Record<Channel, boolean>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const anySendPlanned = plan.people.some(
    (p) =>
      p.invite && p.account !== 'admin-elsewhere' && p.channels.some((c) => c.status === 'send'),
  );
  if (!anySendPlanned) return [];
  return plan.channels
    .filter((ch) => dryRun[ch])
    .map(
      (ch) =>
        `${ch} channel is in notify dry-run (${dryRunReason(ch, env)}) — refusing --confirm; ` +
        'sends would be silently skipped and their markers completed',
    );
}

export async function runConfirm(
  repo: RepoModule,
  cognito: import('@aws-sdk/client-cognito-identity-provider').CognitoIdentityProviderClient,
  pool: string,
  plan: ContactPlan,
  args: Args,
  deps?: ConfirmDeps,
  log: ImportLog = CONSOLE_LOG,
): Promise<void> {
  const { grantClubRep, getUserSubByEmail, sendStaffInvite, orgCopy, dryRun } =
    deps ?? (await loadConfirmDeps());

  const refusals = dryRunSendRefusals(plan, dryRun);
  if (refusals.length && !args.allowDryRunSends) {
    throw new Error(
      `${refusals.join('\n')}\n` +
        'Run under `npx sst shell --stage <stage>` with the FromEmail / WhatsappAccessToken / ' +
        'WhatsappPhoneNumberId secrets set (or export the env names above), or pass ' +
        '--allow-dry-run-sends for a deliberate no-real-send test.',
    );
  }
  if (refusals.length) {
    log.warn(
      '\n' +
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' +
        '!! --allow-dry-run-sends: NO REAL INVITES WILL GO OUT on the channel(s) below.\n' +
        '!! Their send markers WILL be completed — a later real send needs --resend.\n' +
        refusals.map((r) => `!!   ${r}\n`).join('') +
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n',
    );
  }
  if (args.resend) {
    log.log(
      '· --resend: claiming fresh send keys (…#resend) — every invite-planned person is re-sent, ' +
        'ignoring completed markers from earlier runs.',
    );
  }

  const backupPath = join(
    dirname(args.manifest),
    `lions-contacts-import-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  const clubs = await repo.listClubs(TENANT);
  await writeFile(backupPath, JSON.stringify(clubs, null, 2));
  log.log(`Backup written: ${backupPath} (${clubs.length} lions club(s))`);

  const cfg = await repo.getTenantConfig(TENANT);
  const orgName = orgCopy(cfg ?? { tenant: TENANT }).name;
  const link = plan.origin ?? ''; // a null origin with sends planned is a blocker (never reached)

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
  let excoWritten = 0;

  for (const person of plan.people) {
    if (person.account === 'admin-elsewhere') continue;

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
      commLog: [],
      idempotencyKey: args.resend
        ? resendIdempotencyKeyFor(person.email)
        : idempotencyKeyFor(person.email),
      sendMarkerClubId: person.sendMarkerClubId ?? null,
    };

    let claimedFor: string | null = null;
    try {
      // 1. Exco slot writes, per club: re-read, merge ONLY the planned `set` slots, write with
      //    OUR read's version (a concurrent save rejects); a version conflict retries once.
      const rolesByClub = new Map<string, ClubRolePlan[]>();
      for (const role of person.roles) {
        rolesByClub.set(role.clubId, [...(rolesByClub.get(role.clubId) ?? []), role]);
      }
      for (const [clubId, roles] of rolesByClub) {
        if (!roles.some((r) => r.exco.action === 'set')) continue;
        let club = await repo.getClub(TENANT, clubId);
        if (!club) {
          log.warn(`  ⚠ ${person.email}: club ${clubId} not found at write time — skipping`);
          continue;
        }
        for (let attempt = 0; ; attempt++) {
          const writes = computeClubWrites(club, roles, log.warn);
          if (!writes.excoWrites.length) break;
          try {
            await repo.updateClub(
              TENANT,
              clubId,
              { exco: writes.nextExco, version: club.version },
              IMPORT_ACTOR,
              new Date().toISOString(),
            );
            entry.excoWrites.push(...writes.excoWrites);
            excoWritten += writes.excoWrites.length;
            break;
          } catch (err: unknown) {
            if (err instanceof Error && err.name === 'VersionConflictError' && attempt === 0) {
              log.warn(
                `  ⚠ ${person.email}: ${club.name} changed concurrently — re-reading + retrying once`,
              );
              const reread = await repo.getClub(TENANT, clubId);
              if (!reread) {
                log.warn(`  ⚠ ${person.email}: club ${clubId} gone on re-read — skipping`);
                break;
              }
              club = reread;
              continue;
            }
            throw err;
          }
        }
      }

      // 2. Account grant (also under --data-only; Cognito's own welcome message is suppressed).
      if (person.grant) {
        const { sub } = await grantClubRep(
          cognito,
          pool,
          TENANT,
          person.email,
          person.unionClubIds,
          { invitedBy: IMPORT_ACTOR },
        );
        entry.sub = sub;
        entry.granted = true; // gates the revert restore — only a real grant is undone
        granted++;
      }

      // 3. Invite send — never under --data-only, never for an active user.
      const markerClub = person.sendMarkerClubId;
      if (person.invite && markerClub) {
        const key = entry.idempotencyKey;
        const { channels: effectiveChannels, cell: sendCell } = effectiveInviteChannels(person);
        if (effectiveChannels.length === 0) {
          noChannels++;
          log.log(
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
            log.log(`  · ${person.email}: send already recorded (replay) — skipped`);
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
            if (results.some((r) => r.status === 'sent')) {
              await repo.completeInviteSend(TENANT, markerClub, key, results);
              sent++;
            } else {
              await repo.releaseInviteClaim(TENANT, markerClub, key);
              const detail = results.map((r) => `${r.channel}:${r.status}`).join(', ');
              failures.push(`${person.email}: all channels failed (${detail})`);
              log.error(
                `  ✗ ${person.email}: all channels failed (${detail}) — claim released for re-run`,
              );
            }
            claimedFor = null;

            // 4. Comm-log to every club the person is an officer of.
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
                by: IMPORT_ACTOR,
                idempotencyKey: key,
                kind: 'staff-invite',
              }));
              await repo.appendClubCommEvents(TENANT, clubId, events);
              for (const e of events) entry.commLog.push({ clubId, eventId: e.id });
            }
          }
        }
      }

      await persist(entry);
    } catch (err: unknown) {
      if (claimedFor) {
        try {
          await repo.releaseInviteClaim(TENANT, claimedFor, entry.idempotencyKey);
        } catch (releaseErr) {
          log.warn(`  ⚠ ${person.email}: failed to release invite claim:`, releaseErr);
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${person.email}: ${message}`);
      log.error(`  ✗ ${person.email}: ${message}`);
      await persist(entry);
    }
  }

  log.log(
    `\n· granted ${granted} rep account(s), ${excoWritten} exco slot write(s), ${sent} invite(s) sent, ` +
      `${sentPreviously} already-sent (replay), ${noChannels} granted-without-channels` +
      `${plan.dataOnly ? ' (--data-only: no sends attempted)' : ''}.`,
  );
  log.log(`· manifest: ${args.manifest} (${manifestByEmail.size} person entr(y/ies))`);
  if (failures.length) {
    log.error(`\n✗ ${failures.length} per-person failure(s):`);
    for (const f of failures) log.error(`   ${f}`);
    process.exitCode = 1;
  }
}

// ───────────────────────── Revert ─────────────────────────

export interface RevertDeps {
  restoreMembership: typeof import('./tenant-admin.js').restoreMembership;
}

export async function runRevert(
  repo: RepoModule,
  args: Args,
  deps?: RevertDeps,
  log: ImportLog = CONSOLE_LOG,
): Promise<void> {
  const { restoreMembership } = deps ?? (await import('./tenant-admin.js'));
  const entries = await readManifest(args.manifest);
  log.log(`Reverting ${entries.length} person entr(y/ies) from ${args.manifest}`);
  log.log(
    '(Cognito accounts are left in place — a dormant passwordless OTP user with no membership ' +
      'has no access and is harmless. Sent messages cannot be unsent.)',
  );

  const failures: string[] = [];
  let restored = 0;
  let excoRestored = 0;
  for (const entry of entries) {
    try {
      // 1. Exco: undo ONLY slots this run wrote that still hold this person (drift ⇒ leave).
      const emailLc = entry.email.trim().toLowerCase();
      const excoByClub = new Map<string, ExcoWrite[]>();
      for (const w of entry.excoWrites)
        excoByClub.set(w.clubId, [...(excoByClub.get(w.clubId) ?? []), w]);
      for (const [clubId, excoWrites] of excoByClub) {
        let club = await repo.getClub(TENANT, clubId);
        if (!club) {
          log.warn(`  ⚠ ${entry.email}: club ${clubId} gone — cannot restore its exco`);
          continue;
        }
        for (let attempt = 0; ; attempt++) {
          const nextExco: Record<string, unknown> = { ...(club.exco ?? {}) };
          let changed = false;
          for (const w of excoWrites) {
            const current = nextExco[w.slot] as { email?: unknown } | undefined;
            const currentEmail =
              typeof current?.email === 'string' ? current.email.trim().toLowerCase() : '';
            if (currentEmail !== emailLc) {
              log.warn(
                `  ⚠ ${entry.email}: exco slot "${w.slot}" on ${club.name} changed since import — leaving as-is`,
              );
              continue;
            }
            if (w.priorValue == null) delete nextExco[w.slot];
            else nextExco[w.slot] = w.priorValue;
            changed = true;
          }
          if (!changed) break;
          try {
            await repo.updateClub(
              TENANT,
              clubId,
              { exco: nextExco, version: club.version },
              `${IMPORT_ACTOR}:revert`,
              new Date().toISOString(),
            );
            excoRestored++;
            break;
          } catch (err: unknown) {
            if (err instanceof Error && err.name === 'VersionConflictError' && attempt === 0) {
              log.warn(
                `  ⚠ ${entry.email}: ${club.name} changed concurrently during revert — re-reading + retrying once`,
              );
              const reread = await repo.getClub(TENANT, clubId);
              if (!reread) {
                log.warn(`  ⚠ ${entry.email}: club ${clubId} gone on re-read — skipping`);
                break;
              }
              club = reread;
              continue;
            }
            throw err;
          }
        }
      }

      // 2. Membership: restore the exact pre-image through the guarded helper — never a
      //    hand-written USER# item — and ONLY for a person this import actually granted.
      if (entry.granted && entry.sub) {
        const result = await restoreMembership(entry.sub, TENANT, entry.priorMembership);
        if (result.offboarded)
          log.log(
            `  · ${entry.email}: membership removed (user had no other memberships — offboarded)`,
          );
        else if (entry.priorMembership)
          log.log(`  · ${entry.email}: membership restored to its pre-import snapshot`);
        else log.log(`  · ${entry.email}: import membership removed`);
        restored++;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${entry.email}: ${message}`);
      log.error(`  ✗ ${entry.email}: ${message}`);
    }
  }

  log.log(`\n· reverted ${restored} membership(s), ${excoRestored} club exco write(s).`);
  if (failures.length) {
    log.error(`\n✗ ${failures.length} revert failure(s):`);
    for (const f of failures) log.error(`   ${f}`);
    process.exitCode = 1;
  }
}

// ───────────────────────── Main ─────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // FIRST, before any dynamic import below (see import-titans-contacts.ts main()).
  const filled = bootstrapNotifyEnvFromSst();
  if (filled.length) console.log(`· notify config from SST linked secrets: ${filled.join(', ')}`);

  if (args.revert) {
    const repo = await import('./repo.js');
    await runRevert(repo, args);
    return;
  }

  const parsed = parseAffiliationWorkbook(await loadWorkbook(args.file));

  if (args.parseOnly) {
    runParseOnly(parsed, args);
    return;
  }

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
    console.log(
      `\nRe-run with --confirm to write (${args.dataOnly ? 'memberships + exco, NO sends' : 'memberships + exco + sends'}).`,
    );
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

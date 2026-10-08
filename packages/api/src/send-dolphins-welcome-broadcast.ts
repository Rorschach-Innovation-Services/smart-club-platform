/**
 * Dolphins welcome broadcast — a one-off email + WhatsApp send to everyone registered on the
 * `dolphins` tenant, announcing the Dolphins Pipeline / Scouting Program with Medicoach.
 *
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run broadcast:dolphins-welcome -- \
 *     --staff-video-url <https://…> --player-video-url <https://…> \
 *     --staff-video-file <staff.mp4> --player-video-file <player.mp4>      # dry-run (default)
 *   … --only <email-or-cell>        # restrict the audience to one person (pre-flight smoke test)
 *   … --channels email              # email only (e.g. while the WhatsApp templates await Meta)
 *   … --confirm                     # REAL sends
 *   … --confirm --resend            # re-send to everyone, ignoring completed send markers
 *   … --confirm --allow-dry-run-sends   # deliberate test: a dry-run channel "sends" (nothing real)
 *   … --include-operators           # keep platform operators (excluded by default — see below)
 *
 * Who gets what:
 *   - PLAYERS (every non-inactive, non-placeholder player row; minors on the registered contact,
 *     typically the guardian's): 1 email + 1 WhatsApp (`dolphins_player_welcome`), first name.
 *   - STAFF (club exco office-bearers, coaches, portal users — anyone not only a player): 1
 *     combined email (staff message + the player message as FYI) + 2 WhatsApps
 *     (`dolphins_staff_welcome`, then `dolphins_player_fyi`), addressed by their actual name.
 *   - One send per PERSON: contacts are deduped by normalised email + E.164 cell across the whole
 *     audience; staff treatment wins over player (their bundle already contains the player
 *     message); staff on several clubs are sent once.
 *   - Platform OPERATORS (repo.listOperators — auto-granted admin on every tenant) are excluded
 *     by default and reported as `operator` skips; `--include-operators` keeps them.
 *
 * Videos: the EMAILS link the hosted S3 URLs (--*-video-url). The WHATSAPP video headers use
 * Meta-hosted media — on --confirm each local file (--*-video-file, ≤ 16 MB) is uploaded to Meta
 * once (uploadWhatsAppMedia) and every send references the returned media id, which renders
 * inline reliably where an external link did not. An upload failure aborts before any claim.
 *
 * Send machinery follows import-lions-contacts.ts: bootstrapNotifyEnvFromSst() runs BEFORE any
 * notify module loads (they freeze their dry-run flags from process.env at import time), and
 * --confirm refuses while a requested channel would silently dry-run (the 29 Sep 2026 incident).
 * Each person's sends are guarded by an INVITE# marker (kind 'broadcast', key
 * `welcome-broadcast-<email|cell>`) so a re-run never double-sends; the marker's 72 h TTL means
 * the timestamped JSON manifest (`dolphins-welcome-broadcast-<ts>.json`) is the durable record.
 * Only real provider message ids (never `dry-run-*`) count as delivered.
 * Each real WhatsApp message also gets a delivery row (`<tenant>#BCAST#<runId>` / `WA#<wamid>`)
 * and a `WAMSG#<wamid>` lookup of kind 'broadcast', so the WhatsApp status webhook records
 * Meta's delivered/read/failed statuses — the deployed API must include that webhook support
 * BEFORE the run. report-dolphins-welcome-broadcast.ts turns manifest + rows into HTML/PDF.
 *
 * Read-only against DynamoDB apart from the INVITE# markers. Prod --confirm is user-run.
 */
import { statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
// Importing this module never loads notify/email.ts or notify/whatsapp.ts (its own load-order
// test guards this), so bootstrapNotifyEnvFromSst still runs before either freezes its flag.
import { bootstrapNotifyEnvFromSst, isLikelyLandline } from './import-titans-contacts.js';
import { chairContactOf } from './club-contacts.js';
// NOT './notify/whatsapp.js' — see above. e164.ts and whatsapp-templates.ts are pure.
import { toE164 } from './notify/e164.js';
import {
  WHATSAPP_TEMPLATES,
  type WhatsAppTemplateDefinition,
} from './notify/whatsapp-templates.js';
import type { Channel, Club, PlayerStatus, SendResult } from './types.js';

type RepoModule = typeof import('./repo.js');

const TENANT = 'dolphins';
/** Kept identical to the contacts CLIs / notify EMAIL_RE. */
const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;
/** Office-bearer exco keys (cricket vertical labels, as export-cohort.ts). */
const EXCO_ROLES: Array<[string, string]> = [
  ['chair', 'Chairperson'],
  ['sec', 'Secretary'],
  ['tre', 'Treasurer'],
  ['vc', 'Vice-chair'],
];
const STAFF_FALLBACK_NAME = 'Club Representative';

export const idempotencyKeyFor = (contact: string): string => `welcome-broadcast-${contact}`;
export const resendIdempotencyKeyFor = (contact: string): string =>
  `${idempotencyKeyFor(contact)}#resend`;

// ───────────────────────── Audience assembly (pure) ─────────────────────────

export type Cohort = 'staff' | 'player';

export interface AudienceClub {
  id: string;
  name: string;
  /** Flat chair name (chairContactOf's fallback). */
  chair?: string;
  exco?: Record<string, unknown>;
  coaches?: unknown[];
}

export interface AudiencePlayer {
  firstName: string;
  lastName: string;
  email?: string;
  cell?: string;
  status?: PlayerStatus;
  placeholder?: true;
  isMinor?: boolean;
}

export interface AudienceInput {
  clubs: AudienceClub[];
  /** Player rows per club id. */
  playersByClub: Map<string, AudiencePlayer[]>;
  /** Tenant portal users (email + role only — names are joined from exco/coaches/players). */
  tenantUsers: Array<{ sub?: string; email: string; role: string }>;
  /**
   * Platform operators (repo.listOperators — the PLATFORM#OPERATORS marker the operator
   * auto-admin feature reads). Operators are auto-granted admin on every tenant, so they show
   * up in `tenantUsers`; they are excluded (skip reason `operator`) unless `includeOperators`.
   */
  operators?: Array<{ sub: string; email: string }>;
  /** `--include-operators`: keep operators in the audience. */
  includeOperators?: boolean;
}

export interface Recipient {
  cohort: Cohort;
  /** Staff: full name. Player: first name. '' ⇒ the generic greeting. */
  name: string;
  /** Normalised (lowercased, validated) email, or ''. */
  email: string;
  /** E.164 digits (no +), or ''. */
  cell: string;
  /** Human-readable role lines, e.g. "Chairperson @ Umhlali CC", "Player @ Umhlali CC (minor)". */
  roles: string[];
  clubIds: string[];
  /** Staff with no name anywhere — greeted as "Club Representative" (reported). */
  genericGreeting: boolean;
  /** At least one of the merged player rows is a minor (the contact is likely the guardian's). */
  minor: boolean;
}

export type AudienceSkipReason = 'inactive' | 'placeholder' | 'no-contact' | 'deduped' | 'operator';

export interface AudienceSkip {
  reason: AudienceSkipReason;
  detail: string;
}

interface Contact {
  cohort: Cohort;
  name: string;
  /** Full name for filling a staff recipient's missing name from a player row. */
  fullName: string;
  email: string;
  cell: string;
  role: string;
  clubId?: string;
  minor: boolean;
}

const normEmail = (raw: unknown): string => {
  const e = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return EMAIL_RE.test(e) ? e : '';
};
const normCell = (raw: unknown): string => (typeof raw === 'string' ? toE164(raw) : null) ?? '';
const str = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

/**
 * Build the broadcast audience. PURE — the dry-run and --confirm paths share it, and tests drive
 * it with plain objects. Staff contacts (exco, coaches, then portal users) are collected before
 * players, so a person appearing as both is merged into their STAFF recipient. Two contacts are
 * one person when they share a normalised email OR an E.164 cell. A player row merged into an
 * existing recipient is reported as a `deduped` skip. Platform operators are excluded by default:
 * their portal row (matched by sub or email) and any other contact carrying an operator's email
 * are reported as `operator` skips.
 */
export function buildAudience(input: AudienceInput): {
  recipients: Recipient[];
  skips: AudienceSkip[];
} {
  const skips: AudienceSkip[] = [];
  const contacts: Contact[] = [];
  const staff = (c: Omit<Contact, 'cohort' | 'fullName' | 'minor'>) =>
    contacts.push({ ...c, cohort: 'staff', fullName: c.name, minor: false });
  const excludeOps = !input.includeOperators;
  const operatorSubs = new Set((input.operators ?? []).map((o) => o.sub).filter(Boolean));
  const operatorEmails = new Set(
    (input.operators ?? []).map((o) => normEmail(o.email)).filter(Boolean),
  );

  for (const club of input.clubs) {
    const chair = chairContactOf(club as Club);
    staff({
      name: str(chair.name),
      email: normEmail(chair.email),
      cell: normCell(chair.cell),
      role: `Chairperson @ ${club.name}`,
      clubId: club.id,
    });
    const exco = club.exco ?? {};
    for (const [key, label] of EXCO_ROLES) {
      if (key === 'chair') continue; // chairContactOf above
      const m = exco[key] as Record<string, unknown> | undefined;
      if (!m || typeof m !== 'object') continue;
      staff({
        name: str(m.name),
        email: normEmail(m.email),
        cell: normCell(m.cell),
        role: `${label} @ ${club.name}`,
        clubId: club.id,
      });
    }
    const additional = Array.isArray(exco.additionalMembers) ? exco.additionalMembers : [];
    for (const raw of additional) {
      if (!raw || typeof raw !== 'object') continue;
      const m = raw as Record<string, unknown>;
      staff({
        name: str(m.name),
        email: normEmail(m.email),
        cell: normCell(m.cell),
        role: `Exco member @ ${club.name}`,
        clubId: club.id,
      });
    }
    for (const raw of Array.isArray(club.coaches) ? club.coaches : []) {
      if (!raw || typeof raw !== 'object') continue;
      const c = raw as Record<string, unknown>;
      staff({
        name: str(c.name),
        email: normEmail(c.email),
        cell: normCell(c.cell),
        role: `Coach @ ${club.name}`,
        clubId: club.id,
      });
    }
  }
  for (const u of input.tenantUsers) {
    const email = normEmail(u.email);
    if (
      excludeOps &&
      ((u.sub && operatorSubs.has(u.sub)) || (email && operatorEmails.has(email)))
    ) {
      skips.push({ reason: 'operator', detail: `${email || u.email} — Portal ${u.role}` });
      continue;
    }
    staff({ name: '', email, cell: '', role: `Portal ${u.role}` });
  }
  for (const club of input.clubs) {
    for (const p of input.playersByClub.get(club.id) ?? []) {
      const fullName = `${str(p.firstName)} ${str(p.lastName)}`.trim();
      const label = `${fullName || '(no name)'} @ ${club.name}`;
      if (p.placeholder === true) {
        skips.push({ reason: 'placeholder', detail: label });
        continue;
      }
      if (p.status === 'inactive') {
        skips.push({ reason: 'inactive', detail: label });
        continue;
      }
      contacts.push({
        cohort: 'player',
        name: str(p.firstName),
        fullName,
        email: normEmail(p.email),
        cell: normCell(p.cell),
        role: `Player @ ${club.name}${p.isMinor ? ' (minor)' : ''}`,
        clubId: club.id,
        minor: !!p.isMinor,
      });
    }
  }

  // Union-find over contacts: two contacts are one person when they share an email or a cell,
  // transitively (chair of club A by email, of club B by cell, of club C by both ⇒ one person).
  const usable: Contact[] = [];
  for (const c of contacts) {
    if (excludeOps && c.email && operatorEmails.has(c.email)) {
      skips.push({ reason: 'operator', detail: `${c.email} — ${c.role}` });
      continue;
    }
    if (c.email || c.cell) usable.push(c);
    // A staff slot with no usable contact is common (blank exco rows) — report players only,
    // plus staff that at least carry a name.
    else if (c.cohort === 'player' || c.name) {
      skips.push({ reason: 'no-contact', detail: `${c.fullName || '(no name)'} — ${c.role}` });
    }
  }
  const parent = usable.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const firstByKey = new Map<string, number>();
  usable.forEach((c, i) => {
    for (const key of [c.email && `e:${c.email}`, c.cell && `c:${c.cell}`]) {
      if (!key) continue;
      const j = firstByKey.get(key);
      if (j === undefined) firstByKey.set(key, i);
      else {
        // Keep the EARLIER contact as root, so a group's order and staff-first precedence hold.
        const [a, b] = [find(i), find(j)];
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  });
  const groups = new Map<number, Contact[]>();
  usable.forEach((c, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), c]);
  });

  const recipients: Recipient[] = [];
  for (const root of [...groups.keys()].sort((a, b) => a - b)) {
    const members = groups.get(root)!;
    const cohort: Cohort = members.some((m) => m.cohort === 'staff') ? 'staff' : 'player';
    // Staff: the first staff name, else a player row's full name. Player: the first first name.
    const name =
      cohort === 'staff'
        ? members.find((m) => m.cohort === 'staff' && m.name)?.name ||
          members.find((m) => m.fullName)?.fullName ||
          ''
        : members.find((m) => m.name)?.name || '';
    const r: Recipient = {
      cohort,
      name,
      email: members.find((m) => m.email)?.email ?? '',
      cell: members.find((m) => m.cell)?.cell ?? '',
      roles: [...new Set(members.map((m) => m.role))],
      clubIds: [...new Set(members.flatMap((m) => (m.clubId ? [m.clubId] : [])))],
      genericGreeting: cohort === 'staff' && !name,
      minor: members.some((m) => m.minor),
    };
    recipients.push(r);
    // Every player row beyond the group's first contact is reported as merged away.
    for (const m of members.slice(1)) {
      if (m.cohort !== 'player') continue;
      skips.push({
        reason: 'deduped',
        detail:
          `${m.role.replace(/^Player/, m.fullName || '(no name)')} shares a contact with ` +
          `${r.name || r.email || r.cell} — ` +
          (cohort === 'staff' ? 'staff message only' : 'one player message'),
      });
    }
  }
  return { recipients, skips };
}

/** Does `--only <email-or-cell>` select this recipient? PURE. */
export function matchesOnly(r: Recipient, only: string): boolean {
  const email = normEmail(only);
  if (email) return r.email === email;
  const cell = normCell(only);
  return !!cell && r.cell === cell;
}

// ───────────────────────── Message planning (pure) ─────────────────────────

export type MessageKind =
  | 'staff-email'
  | 'player-email'
  | 'dolphins_staff_welcome'
  | 'dolphins_player_fyi'
  | 'dolphins_player_welcome';

export interface PlannedMessage {
  kind: MessageKind;
  channel: Channel;
  status: 'send' | 'skip';
  to?: string;
  reason?: string;
}

/**
 * The messages one recipient gets on the requested channels, in send order. Player: email +
 * `dolphins_player_welcome`. Staff: combined email + `dolphins_staff_welcome` +
 * `dolphins_player_fyi`. A missing email/cell (or a landline-looking number) skips that channel.
 */
export function planMessages(r: Recipient, channels: Channel[]): PlannedMessage[] {
  const out: PlannedMessage[] = [];
  if (channels.includes('email')) {
    const kind: MessageKind = r.cohort === 'staff' ? 'staff-email' : 'player-email';
    out.push(
      r.email
        ? { kind, channel: 'email', status: 'send', to: r.email }
        : { kind, channel: 'email', status: 'skip', reason: 'no-email' },
    );
  }
  if (channels.includes('whatsapp')) {
    const kinds: MessageKind[] =
      r.cohort === 'staff'
        ? ['dolphins_staff_welcome', 'dolphins_player_fyi']
        : ['dolphins_player_welcome'];
    for (const kind of kinds) {
      if (!r.cell) out.push({ kind, channel: 'whatsapp', status: 'skip', reason: 'no-cell' });
      else if (isLikelyLandline(r.cell))
        out.push({ kind, channel: 'whatsapp', status: 'skip', to: r.cell, reason: 'landline?' });
      else out.push({ kind, channel: 'whatsapp', status: 'send', to: r.cell });
    }
  }
  return out;
}

/** The three broadcast templates that are not yet `registered` in the code registry. PURE. */
export function pendingBroadcastTemplates(
  templates: Record<string, WhatsAppTemplateDefinition> = WHATSAPP_TEMPLATES,
): string[] {
  return ['dolphinsStaffWelcome', 'dolphinsPlayerWelcome', 'dolphinsPlayerFyi']
    .map((k) => templates[k])
    .filter((d): d is WhatsAppTemplateDefinition => !!d && d.status !== 'registered')
    .map((d) => d.name);
}

// ───────────────────────── CLI args ─────────────────────────

interface Args {
  confirm: boolean;
  channels: Channel[];
  resend: boolean;
  only?: string;
  allowDryRunSends: boolean;
  includeOperators: boolean;
  staffVideoUrl?: string;
  playerVideoUrl?: string;
  staffVideoFile?: string;
  playerVideoFile?: string;
}

/** Meta's cap on WhatsApp video media. */
export const WHATSAPP_VIDEO_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Blockers for the WhatsApp video files: with the whatsapp channel requested, both
 * --staff-video-file and --player-video-file are required, must exist, and must be ≤ 16 MB.
 * `sizeOf` returns the file's size in bytes, or null when it does not exist (fs in the CLI,
 * a fake in tests). PURE given `sizeOf`. No whatsapp channel ⇒ no blockers.
 */
export function videoFileBlockers(
  channels: Channel[],
  files: { staffVideoFile?: string; playerVideoFile?: string },
  sizeOf: (path: string) => number | null,
): string[] {
  if (!channels.includes('whatsapp')) return [];
  const out: string[] = [];
  for (const [flag, path] of [
    ['--staff-video-file', files.staffVideoFile],
    ['--player-video-file', files.playerVideoFile],
  ] as const) {
    if (!path) {
      out.push(`${flag} is required with the whatsapp channel (the video is uploaded to Meta)`);
      continue;
    }
    const size = sizeOf(path);
    if (size === null) out.push(`${flag} ${path}: file not found`);
    else if (size > WHATSAPP_VIDEO_MAX_BYTES) {
      out.push(
        `${flag} ${path}: ${(size / 1024 / 1024).toFixed(1)} MB exceeds Meta's 16 MB video cap — re-encode it`,
      );
    }
  }
  return out;
}

/** File size in bytes, or null when the path is missing / not a regular file. */
function fileSize(path: string): number | null {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
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

function parseArgs(argv: string[]): Args {
  const args: Args = {
    confirm: false,
    channels: ['email', 'whatsapp'],
    resend: false,
    allowDryRunSends: false,
    includeOperators: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') args.confirm = true;
    else if (a === '--channels') args.channels = parseChannels(argv[++i] ?? '');
    else if (a === '--resend') args.resend = true;
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--allow-dry-run-sends') args.allowDryRunSends = true;
    else if (a === '--include-operators') args.includeOperators = true;
    else if (a === '--staff-video-url') args.staffVideoUrl = argv[++i];
    else if (a === '--player-video-url') args.playerVideoUrl = argv[++i];
    else if (a === '--staff-video-file') args.staffVideoFile = argv[++i];
    else if (a === '--player-video-file') args.playerVideoFile = argv[++i];
    else throw new Error(`unknown flag ${a}`);
  }
  if (args.only !== undefined && !normEmail(args.only) && !normCell(args.only)) {
    throw new Error(`--only "${args.only ?? ''}" is neither a valid email nor a cell number`);
  }
  for (const [flag, v] of [
    ['--staff-video-url', args.staffVideoUrl],
    ['--player-video-url', args.playerVideoUrl],
  ] as const) {
    if (v !== undefined && !/^https:\/\/\S+$/.test(v))
      throw new Error(`${flag} must be an https URL`);
  }
  return args;
}

// ───────────────────────── Dry-run guard ─────────────────────────

function dryRunReason(channel: Channel, env: NodeJS.ProcessEnv = process.env): string {
  if (env.NOTIFY_DRY_RUN === '1') return 'NOTIFY_DRY_RUN=1';
  const names =
    channel === 'email' ? ['FROM_EMAIL'] : ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'];
  const missing = names.filter((n) => !env[n]);
  return missing.length
    ? `${missing.join(' + ')} unset`
    : 'notify module loaded before env was set';
}

/** The --confirm dry-run send guard (as import-lions-contacts.ts). Empty ⇒ proceed. PURE. */
export function dryRunSendRefusals(
  plans: PlannedMessage[][],
  channels: Channel[],
  dryRun: Record<Channel, boolean>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!plans.some((p) => p.some((m) => m.status === 'send'))) return [];
  return channels
    .filter((ch) => dryRun[ch])
    .map(
      (ch) =>
        `${ch} channel is in notify dry-run (${dryRunReason(ch, env)}) — refusing --confirm; ` +
        'sends would be silently skipped and their markers completed',
    );
}

// ───────────────────────── Reporting ─────────────────────────

const STAFF_VIDEO_PLACEHOLDER = '<staff video URL — pass --staff-video-url>';
const PLAYER_VIDEO_PLACEHOLDER = '<player video URL — pass --player-video-url>';

function describeMessages(plan: PlannedMessage[]): string {
  return plan.map((m) => `${m.kind}:${m.status}${m.reason ? `(${m.reason})` : ''}`).join(', ');
}

function printAudience(
  recipients: Recipient[],
  skips: AudienceSkip[],
  plans: Map<Recipient, PlannedMessage[]>,
): void {
  for (const cohort of ['staff', 'player'] as const) {
    const list = recipients.filter((r) => r.cohort === cohort);
    console.log(`\n── ${cohort === 'staff' ? 'Staff' : 'Players'} (${list.length})`);
    for (const r of list) {
      const name = r.genericGreeting
        ? `(no name → "${STAFF_FALLBACK_NAME}")`
        : r.name || '(no name)';
      console.log(
        `  ${name} <${r.email || 'no email'}> ${r.cell ? `+${r.cell}` : 'no cell'}${r.minor ? '  [minor contact]' : ''}`,
      );
      console.log(`      ${r.roles.join('; ')}`);
      console.log(`      → ${describeMessages(plans.get(r) ?? [])}`);
    }
  }
  const byReason = new Map<AudienceSkipReason, AudienceSkip[]>();
  for (const s of skips) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s]);
  if (skips.length) console.log('\n── Skipped rows');
  for (const [reason, list] of byReason) {
    console.log(`  ${reason} (${list.length}):`);
    for (const s of list) console.log(`     · ${s.detail}`);
  }
}

function summarise(recipients: Recipient[], plans: Map<Recipient, PlannedMessage[]>) {
  const all = [...plans.values()].flat();
  const count = (pred: (m: PlannedMessage) => boolean) => all.filter(pred).length;
  return {
    staff: recipients.filter((r) => r.cohort === 'staff').length,
    players: recipients.filter((r) => r.cohort === 'player').length,
    genericGreeting: recipients.filter((r) => r.genericGreeting).length,
    emailsToSend: count((m) => m.channel === 'email' && m.status === 'send'),
    whatsappsToSend: count((m) => m.channel === 'whatsapp' && m.status === 'send'),
    noEmail: count((m) => m.reason === 'no-email'),
    noCell: count((m) => m.reason === 'no-cell'),
    landline: count((m) => m.reason === 'landline?'),
  };
}

type NotifyEmail = typeof import('./notify/email.js');

function printSamples(
  recipients: Recipient[],
  email: NotifyEmail,
  staffVideoUrl: string,
  playerVideoUrl: string,
  /** What the WhatsApp headers carry (the local files uploaded to Meta). */
  waVideo: { staff: string; player: string },
): void {
  const fill = (body: string, name: string) => body.replace('{{1}}', name);
  const staff = recipients.find((r) => r.cohort === 'staff');
  const player = recipients.find((r) => r.cohort === 'player');
  if (staff) {
    const name = staff.name || STAFF_FALLBACK_NAME;
    const e = email.staffWelcomeEmailContent({ name, staffVideoUrl, playerVideoUrl });
    console.log(`\n══ Sample STAFF email (to ${staff.email || '—'}) — subject: ${e.subject}\n`);
    console.log(e.text);
    console.log(
      `\n══ Sample STAFF WhatsApp 1 (${WHATSAPP_TEMPLATES.dolphinsStaffWelcome.name}, video: ${waVideo.staff})\n`,
    );
    console.log(fill(WHATSAPP_TEMPLATES.dolphinsStaffWelcome.bodyText, name));
    console.log(
      `\n══ Sample STAFF WhatsApp 2 (${WHATSAPP_TEMPLATES.dolphinsPlayerFyi.name}, video: ${waVideo.player})\n`,
    );
    console.log(WHATSAPP_TEMPLATES.dolphinsPlayerFyi.bodyText);
  }
  if (player) {
    const firstName = player.name || 'player';
    const e = email.playerWelcomeEmailContent({ firstName, playerVideoUrl });
    console.log(`\n══ Sample PLAYER email (to ${player.email || '—'}) — subject: ${e.subject}\n`);
    console.log(e.text);
    console.log(
      `\n══ Sample PLAYER WhatsApp (${WHATSAPP_TEMPLATES.dolphinsPlayerWelcome.name}, video: ${waVideo.player})\n`,
    );
    console.log(fill(WHATSAPP_TEMPLATES.dolphinsPlayerWelcome.bodyText, firstName));
  }
}

// ───────────────────────── Manifest ─────────────────────────

export interface MessageOutcome {
  kind: MessageKind;
  channel: Channel;
  to?: string;
  status: 'sent' | 'failed' | 'skipped';
  messageId?: string;
  /** True only for a real provider id (never `dry-run-*`). */
  delivered: boolean;
  error?: string;
  /** When the send was attempted (ISO). */
  at?: string;
  /** Set when the WhatsApp delivery record / WAMSG lookup could not be written. */
  deliveryRecordError?: string;
}

export interface ManifestRecipient {
  cohort: Cohort;
  name: string;
  email: string;
  cell: string;
  roles: string[];
  /** Club names (sorted) the person is attached to — the report sorts by these. */
  clubs: string[];
  genericGreeting: boolean;
  planned: PlannedMessage[];
  idempotencyKey?: string;
  markerClubId?: string;
  outcome?: 'sent' | 'all-failed' | 'replay' | 'nothing-to-send' | 'error';
  messages?: MessageOutcome[];
  error?: string;
}

export interface Manifest {
  tenant: string;
  mode: 'dry-run' | 'confirm';
  /** Keys the run's delivery records (`<tenant>#BCAST#<runId>`) — see report-dolphins-welcome-broadcast.ts. */
  runId: string;
  /** The SST stage the run targeted, when resolvable. */
  stage: string | null;
  startedAt: string;
  finishedAt?: string;
  args: {
    channels: Channel[];
    resend: boolean;
    only?: string;
    includeOperators: boolean;
    staffVideoUrl: string;
    playerVideoUrl: string;
    staffVideoFile?: string;
    playerVideoFile?: string;
    /** Meta media ids from the --confirm uploads (WhatsApp headers). */
    staffMediaId?: string;
    playerMediaId?: string;
  };
  summary: ReturnType<typeof summarise>;
  recipients: ManifestRecipient[];
  skips: AudienceSkip[];
}

/** A run's id: its start timestamp as a filename/key-safe slug. PURE. */
export const broadcastRunId = (startedAt: string): string => startedAt.replace(/[:.]/g, '-');

const manifestPath = (runId: string): string => `./dolphins-welcome-broadcast-${runId}.json`;

/** SST_STAGE, else SST_RESOURCE_App's stage, else null (as import-lions-contacts.ts). */
function stageFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.SST_STAGE?.trim()) return env.SST_STAGE.trim();
  try {
    const app = JSON.parse(env.SST_RESOURCE_App ?? '{}') as { stage?: unknown };
    return typeof app.stage === 'string' ? app.stage : null;
  } catch {
    return null;
  }
}

/**
 * The delivery record for one sent WhatsApp message (written after the send so the status
 * webhook can track it), or null for anything else — an email, a skip/failure, or a dry-run id
 * (no real message to track). PURE.
 */
export function broadcastDeliveryFor(
  runId: string,
  recipient: Pick<Recipient, 'name' | 'email' | 'cell'>,
  outcome: MessageOutcome,
): import('./repo.js').BroadcastDelivery | null {
  if (outcome.channel !== 'whatsapp' || outcome.status !== 'sent' || !outcome.delivered)
    return null;
  if (!outcome.messageId || !outcome.to) return null;
  return {
    runId,
    wamid: outcome.messageId,
    to: outcome.to,
    messageKind: outcome.kind,
    recipientName: recipient.name,
    recipientContact: recipient.email || recipient.cell,
    providerStatus: 'sent',
    sentAt: outcome.at ?? new Date().toISOString(),
  };
}

// ───────────────────────── Main ─────────────────────────

async function gather(repo: RepoModule, includeOperators: boolean): Promise<AudienceInput> {
  const clubs = (await repo.listClubs(TENANT)).sort((a, b) => a.name.localeCompare(b.name));
  if (clubs.length === 0) throw new Error(`tenant "${TENANT}" has no clubs on this stage`);
  const playersByClub = new Map<string, AudiencePlayer[]>();
  for (const club of clubs) playersByClub.set(club.id, await repo.listPlayers(TENANT, club.id));
  const tenantUsers = await repo.listTenantUsers(TENANT);
  const operators = await repo.listOperators();
  return { clubs, playersByClub, tenantUsers, operators, includeOperators };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // FIRST, before any dynamic import of a notify module (see import-titans-contacts.ts main()).
  const filled = bootstrapNotifyEnvFromSst();
  if (filled.length) console.log(`· notify config from SST linked secrets: ${filled.join(', ')}`);

  const repo = await import('./repo.js');
  const [email, whatsapp] = await Promise.all([
    import('./notify/email.js'),
    import('./notify/whatsapp.js'),
  ]);

  const audienceInput = await gather(repo, args.includeOperators);
  const clubName = new Map(audienceInput.clubs.map((c) => [c.id, c.name]));
  const { recipients: everyone, skips } = buildAudience(audienceInput);
  const recipients = args.only ? everyone.filter((r) => matchesOnly(r, args.only!)) : everyone;

  const plans = new Map<Recipient, PlannedMessage[]>();
  for (const r of recipients) plans.set(r, planMessages(r, args.channels));

  printAudience(recipients, args.only ? [] : skips, plans);
  const staffVideoUrl = args.staffVideoUrl ?? STAFF_VIDEO_PLACEHOLDER;
  const playerVideoUrl = args.playerVideoUrl ?? PLAYER_VIDEO_PLACEHOLDER;
  const waVideo = {
    staff: `Meta upload of ${args.staffVideoFile ?? '<--staff-video-file missing>'}`,
    player: `Meta upload of ${args.playerVideoFile ?? '<--player-video-file missing>'}`,
  };
  printSamples(recipients, email, staffVideoUrl, playerVideoUrl, waVideo);
  if (args.channels.includes('whatsapp')) {
    console.log(
      `\n· WhatsApp videos will be uploaded to Meta on --confirm (media ids, not links): ` +
        `staff ${args.staffVideoFile ?? '(missing --staff-video-file)'}, ` +
        `player ${args.playerVideoFile ?? '(missing --player-video-file)'}. Emails link the S3 URLs.`,
    );
  }

  const summary = summarise(recipients, plans);
  console.log('\n── Summary');
  console.log(
    `  ${summary.staff} staff + ${summary.players} player recipient(s)` +
      `${args.only ? ` (--only ${args.only}; ${everyone.length} in the full audience)` : ''}`,
  );
  console.log(
    `  emails to send ${summary.emailsToSend}, WhatsApps to send ${summary.whatsappsToSend}; ` +
      `skipped: no-email ${summary.noEmail}, no-cell ${summary.noCell}, landline ${summary.landline}`,
  );
  if (summary.genericGreeting) {
    console.log(
      `  ${summary.genericGreeting} staff with no name anywhere → "Dear ${STAFF_FALLBACK_NAME}"`,
    );
  }
  if (!args.only) {
    const n = (r: AudienceSkipReason) => skips.filter((s) => s.reason === r).length;
    console.log(
      `  rows skipped: inactive ${n('inactive')}, placeholder ${n('placeholder')}, ` +
        `no-contact ${n('no-contact')}, deduped ${n('deduped')}, operator ${n('operator')}` +
        (args.includeOperators ? ' (--include-operators: operators kept)' : ''),
    );
  }

  const blockers: string[] = [];
  if (args.only && recipients.length === 0) blockers.push(`--only "${args.only}" matched nobody`);
  if (!args.staffVideoUrl) blockers.push('--staff-video-url is required to send');
  if (!args.playerVideoUrl) blockers.push('--player-video-url is required to send');
  blockers.push(...videoFileBlockers(args.channels, args, fileSize));
  const pending = args.channels.includes('whatsapp') ? pendingBroadcastTemplates() : [];
  if (pending.length) {
    blockers.push(
      `WhatsApp template(s) not yet registered: ${pending.join(', ')} — approve in Meta and flip ` +
        'their registry status, or run with --channels email',
    );
  }
  if (blockers.length) {
    console.log(
      `\n${args.confirm ? '✗' : '⚠'} ${blockers.length} issue(s) — --confirm refuses while any stand:`,
    );
    for (const b of blockers) console.log(`   ${b}`);
  }

  const startedAt = new Date().toISOString();
  const runId = broadcastRunId(startedAt);
  const path = manifestPath(runId);
  const manifest: Manifest = {
    tenant: TENANT,
    mode: args.confirm ? 'confirm' : 'dry-run',
    runId,
    stage: stageFromEnv(),
    startedAt,
    args: {
      channels: args.channels,
      resend: args.resend,
      ...(args.only ? { only: args.only } : {}),
      includeOperators: args.includeOperators,
      staffVideoUrl,
      playerVideoUrl,
      ...(args.staffVideoFile ? { staffVideoFile: args.staffVideoFile } : {}),
      ...(args.playerVideoFile ? { playerVideoFile: args.playerVideoFile } : {}),
    },
    summary,
    recipients: recipients.map((r) => ({
      cohort: r.cohort,
      name: r.name,
      email: r.email,
      cell: r.cell,
      roles: r.roles,
      clubs: r.clubIds.map((id) => clubName.get(id) ?? id).sort((a, b) => a.localeCompare(b)),
      genericGreeting: r.genericGreeting,
      planned: plans.get(r) ?? [],
    })),
    skips: args.only ? [] : skips,
  };
  const save = () => writeFile(path, JSON.stringify(manifest, null, 2));

  if (!args.confirm) {
    await save();
    console.log(`\n· dry-run manifest: ${path}`);
    console.log('Re-run with --confirm to send.');
    return;
  }
  if (blockers.length) {
    console.error('\n✗ Refusing --confirm while issues stand.');
    process.exitCode = 1;
    return;
  }

  const refusals = dryRunSendRefusals([...plans.values()], args.channels, {
    email: email.EMAIL_DRY_RUN,
    whatsapp: whatsapp.WHATSAPP_DRY_RUN,
  });
  if (refusals.length && !args.allowDryRunSends) {
    throw new Error(
      `${refusals.join('\n')}\n` +
        'Run under `npx sst shell --stage <stage>` with the FromEmail / WhatsappAccessToken / ' +
        'WhatsappPhoneNumberId secrets set, or pass --allow-dry-run-sends for a deliberate ' +
        'no-real-send test.',
    );
  }
  if (refusals.length) {
    console.warn(
      '\n!! --allow-dry-run-sends: NO REAL MESSAGES WILL GO OUT on the channel(s) below.\n' +
        '!! Their send markers WILL be completed — a later real send needs --resend.\n' +
        refusals.map((r) => `!!   ${r}\n`).join(''),
    );
  }

  // WhatsApp headers carry Meta-hosted media: upload each file ONCE, before any claim is made —
  // an upload failure throws here and aborts the run with nothing claimed or sent.
  let staffVideoRef: import('./notify/whatsapp.js').VideoRef | undefined;
  let playerVideoRef: import('./notify/whatsapp.js').VideoRef | undefined;
  const anyWhatsApp = [...plans.values()].some((p) =>
    p.some((m) => m.channel === 'whatsapp' && m.status === 'send'),
  );
  if (anyWhatsApp) {
    const staffUpload = await whatsapp.uploadWhatsAppMedia(args.staffVideoFile!);
    console.log(`· staff video ${args.staffVideoFile} → Meta media id ${staffUpload.mediaId}`);
    const playerUpload = await whatsapp.uploadWhatsAppMedia(args.playerVideoFile!);
    console.log(`· player video ${args.playerVideoFile} → Meta media id ${playerUpload.mediaId}`);
    staffVideoRef = { id: staffUpload.mediaId };
    playerVideoRef = { id: playerUpload.mediaId };
    manifest.args.staffMediaId = staffUpload.mediaId;
    manifest.args.playerMediaId = playerUpload.mediaId;
  }

  // Marker anchor for recipients with no club (portal admins): the first club by id.
  const allClubIds = (await repo.listClubs(TENANT)).map((c) => c.id).sort();
  const anchorClubId = allClubIds[0]!;

  const send = async (r: Recipient, m: PlannedMessage): Promise<{ messageId: string }> => {
    const to = m.to!;
    switch (m.kind) {
      case 'staff-email':
        return email.sendStaffWelcomeEmail({
          to,
          name: r.name,
          staffVideoUrl: args.staffVideoUrl!,
          playerVideoUrl: args.playerVideoUrl!,
        });
      case 'player-email':
        return email.sendPlayerWelcomeEmail({
          to,
          firstName: r.name,
          playerVideoUrl: args.playerVideoUrl!,
        });
      case 'dolphins_staff_welcome':
        return whatsapp.sendDolphinsStaffWelcomeWhatsApp(to, r.name, staffVideoRef!);
      case 'dolphins_player_fyi':
        return whatsapp.sendDolphinsPlayerFyiWhatsApp(to, playerVideoRef!);
      case 'dolphins_player_welcome':
        return whatsapp.sendDolphinsPlayerWelcomeWhatsApp(to, r.name, playerVideoRef!);
    }
  };

  let delivered = 0;
  let replays = 0;
  const failures: string[] = [];
  try {
    for (const [i, r] of recipients.entries()) {
      const entry = manifest.recipients[i]!;
      const plan = plans.get(r) ?? [];
      const who = `${r.name || '(no name)'} <${r.email || `+${r.cell}`}>`;
      const toSend = plan.filter((m) => m.status === 'send');
      if (toSend.length === 0) {
        entry.outcome = 'nothing-to-send';
        console.log(`  · ${who}: nothing to send (${describeMessages(plan)})`);
        continue;
      }
      const contact = r.email || r.cell;
      const key = args.resend ? resendIdempotencyKeyFor(contact) : idempotencyKeyFor(contact);
      const markerClubId = [...r.clubIds].sort()[0] ?? anchorClubId;
      entry.idempotencyKey = key;
      entry.markerClubId = markerClubId;
      const channels = [...new Set(toSend.map((m) => m.channel))];

      let claimed = false;
      try {
        const replay = await repo.claimInviteSend(TENANT, markerClubId, key, channels, 'broadcast');
        if (replay) {
          replays++;
          entry.outcome = 'replay';
          console.log(
            `  · ${who}: already sent (replay${replay.pending ? ', still pending' : ''}) — skipped`,
          );
          continue;
        }
        claimed = true;
        const outcomes: MessageOutcome[] = [];
        for (const m of plan) {
          if (m.status === 'skip') {
            outcomes.push({
              kind: m.kind,
              channel: m.channel,
              ...(m.to ? { to: m.to } : {}),
              status: 'skipped',
              delivered: false,
              error: m.reason,
            });
            continue;
          }
          const at = new Date().toISOString();
          try {
            const { messageId } = await send(r, m);
            const outcome: MessageOutcome = {
              kind: m.kind,
              channel: m.channel,
              to: m.to,
              status: 'sent',
              messageId,
              delivered: !!messageId && !messageId.startsWith('dry-run-'),
              at,
            };
            outcomes.push(outcome);
            // Track Meta's delivery statuses: a delivery row + WAMSG# lookup per real WhatsApp
            // message. A write failure never fails the (already sent) message.
            const record = broadcastDeliveryFor(runId, r, outcome);
            if (record) {
              try {
                await repo.putBroadcastDelivery(TENANT, record);
              } catch (recErr: unknown) {
                outcome.deliveryRecordError =
                  recErr instanceof Error ? recErr.message : String(recErr);
                console.warn(
                  `  ⚠ ${who}: ${m.kind} sent (${messageId}) but its delivery record failed: ${outcome.deliveryRecordError}`,
                );
              }
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            const pendingTemplate =
              err instanceof Error && err.name === 'WhatsAppTemplatePendingError';
            outcomes.push({
              kind: m.kind,
              channel: m.channel,
              to: m.to,
              status: pendingTemplate ? 'skipped' : 'failed',
              delivered: false,
              error: message,
              at,
            });
          }
        }
        entry.messages = outcomes;
        const results: SendResult[] = outcomes.map((o) => ({
          channel: o.channel,
          status: o.status,
          ...(o.to ? { to: o.to } : {}),
          ...(o.messageId ? { messageId: o.messageId } : {}),
          ...(o.error ? { error: `${o.kind}: ${o.error}` } : {}),
        }));
        const line = outcomes
          .map(
            (o) =>
              `${o.kind}:${o.status}${o.delivered ? '' : o.status === 'sent' ? '(dry-run)' : ''}`,
          )
          .join(', ');
        if (outcomes.some((o) => o.status === 'sent')) {
          await repo.completeInviteSend(TENANT, markerClubId, key, results);
          entry.outcome = 'sent';
          delivered += outcomes.filter((o) => o.delivered).length;
          const failed = outcomes.filter((o) => o.status === 'failed');
          if (failed.length)
            failures.push(`${who}: ${failed.map((o) => `${o.kind} (${o.error})`).join('; ')}`);
          console.log(`  ${failed.length ? '⚠' : '✓'} ${who}: ${line}`);
        } else {
          await repo.releaseInviteClaim(TENANT, markerClubId, key);
          entry.outcome = 'all-failed';
          failures.push(`${who}: all messages failed (${line})`);
          console.error(`  ✗ ${who}: all messages failed (${line}) — claim released for re-run`);
        }
        claimed = false;
      } catch (err: unknown) {
        if (claimed) {
          try {
            await repo.releaseInviteClaim(TENANT, markerClubId, key);
          } catch (releaseErr) {
            console.warn(`  ⚠ ${who}: failed to release send claim:`, releaseErr);
          }
        }
        const message = err instanceof Error ? err.message : String(err);
        entry.outcome = 'error';
        entry.error = message;
        failures.push(`${who}: ${message}`);
        console.error(`  ✗ ${who}: ${message}`);
      }
      if (i % 25 === 24) await save();
    }
  } finally {
    manifest.finishedAt = new Date().toISOString();
    await save();
  }

  const sentPeople = manifest.recipients.filter((e) => e.outcome === 'sent').length;
  console.log(
    `\n· ${sentPeople} recipient(s) sent, ${delivered} message(s) delivered to a provider ` +
      `(real ids only), ${replays} already-sent (replay).`,
  );
  console.log(`· manifest: ${path}`);
  console.log(
    `· run id ${runId} — report: npm --prefix packages/api run report:dolphins-welcome -- --manifest ${path}`,
  );
  if (failures.length) {
    console.error(`\n✗ ${failures.length} per-recipient failure(s):`);
    for (const f of failures) console.error(`   ${f}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

/**
 * EMCU scorer broadcast — a one-off email + WhatsApp send on the `dolphins` tenant, in two
 * audiences, run in this order:
 *
 *   1. CHAIRS (`--audience chairs --credentials <file>`): each EMCU club's chairperson gets their
 *      club's MediCoach scorer logins BY EMAIL ONLY (Scorer 1..n: sign-in email + password), then
 *      a WhatsApp notice (`emcu_scorer_accounts_notice`) saying the logins were emailed to them.
 *      No credentials ever ride on WhatsApp.
 *   2. PLAYERS (`--audience players`), only after chair delivery is confirmed: every EMCU club's
 *      players get an email + WhatsApp (`emcu_player_scoring`) saying their matches are scored on
 *      MediCoach by the club's appointed scorers.
 *
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run broadcast:emcu-scorers -- \
 *     --audience chairs --credentials ~/secure/emcu-scorer-credentials.json \
 *     --staff-video-url <https://…> --video-file <staff.mp4>          # dry-run (default)
 *   … --channels email                # chairs: email first (recommended split run)
 *   … --channels whatsapp             # chairs: the WhatsApp notice once the emails are out
 *   … --only <email-or-cell>          # restrict to one person (pre-flight smoke test)
 *   … --exclude-club <clubId>         # leave a club out (repeatable; reported as a skip)
 *   … --welcome-manifest <path>       # chairs: flag chairs whose 8 Oct welcome failed/skipped
 *   … --codes <path>                  # club-code table (default: src/emcu-club-codes.json)
 *   … --include-operators             # keep platform operators (excluded by default)
 *   … --confirm [--resend] [--allow-dry-run-sends]
 *
 * Audience:
 *   - EMCU clubs = the workbook's EMCU_TEAM_MAP club ids ∪ clubs whose `leagues` include an EMCU
 *     league key. The dry run cross-checks that set against `district === EMCU_DISTRICT`.
 *   - Chairs: one recipient per (chair, club) via chairContactOf — a chair of two clubs gets two
 *     messages (each with that club's logins). A club with no chair email, no club code, no
 *     `created` credentials, a credentials mismatch, or `--exclude-club` is a reported SKIP, never
 *     run-blocking. The WhatsApp notice's copy says "4 scorer accounts", so a club with a
 *     different count has its WhatsApp leg skipped (`accounts≠4`); its email states the real count.
 *   - Players: the welcome broadcast's buildAudience player branch over the EMCU clubs (inactive /
 *     placeholder rows skipped, contacts deduped, minors on the registered contact). A player who
 *     is also an EMCU club chair is left out (`chair` skip) — chairs get the chair message only.
 *
 * Credentials (`--credentials`, written by the MediCoach create-emcu-scorers script; kept outside
 * both repos, mode 0600): entries {clubId, code, email, password, state}; only `created` entries
 * count. Passwords live in memory only — they are NEVER printed (dry-run samples show •••), never
 * written to the manifest or delivery rows, and stripped from any error message.
 *
 * Send machinery is the welcome broadcast's (send-dolphins-welcome-broadcast.ts): the INVITE#
 * claim per recipient (kind 'broadcast'; keys `emcu-scorers-<clubId>-<contact>#<channels>` and
 * `emcu-player-scoring-<contact>#<channels>`, `#resend` appended on --resend), the --confirm
 * dry-run refusal, retryable-failure halt (claim released, re-run the same command later), a
 * delivery row + WAMSG# lookup per real WhatsApp message, and a timestamped manifest
 * (`emcu-scorer-broadcast-<audience>-<runId>.json`, PII — gitignored). The WhatsApp video header
 * is Meta-hosted: `--video-file` (≤ 16 MB) is uploaded once on --confirm. Report:
 * `npm run report:emcu-scorers -- --manifest <file>`.
 *
 * Marketing cap: both templates were approved as MARKETING (10 Oct 2026), so Meta can refuse a
 * WhatsApp send under its per-user marketing frequency cap (error 131049). Such a message is
 * recorded as `marketing-cap` (status skipped, `marketingCap: true`) — not a failure, not
 * retryable; the claim completes (outcome `marketing-capped` when nothing else sent) and the run
 * summary + manifest (`marketingCap`) count who got the email only.
 *
 * Read-only against DynamoDB apart from the INVITE# markers and delivery rows. Prod --confirm is
 * user-run.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
// Importing these never loads notify/email.ts or notify/whatsapp.ts (see the welcome CLI and
// this CLI's load-order test), so bootstrapNotifyEnvFromSst still runs before either freezes.
import { bootstrapNotifyEnvFromSst, isLikelyLandline } from './import-titans-contacts.js';
import { chairContactOf } from './club-contacts.js';
import {
  WHATSAPP_VIDEO_MAX_BYTES,
  broadcastDeliveryFor,
  broadcastRunId,
  buildAudience,
  claimActionFor,
  dryRunSendRefusals,
  fileSize,
  isRetryableSendError,
  normCell,
  normEmail,
  parseChannels,
  stageFromEnv,
  type AudienceClub,
  type AudiencePlayer,
  type MessageOutcome,
  type PlannedMessage,
} from './send-dolphins-welcome-broadcast.js';
import { DEFAULT_CLUB_CODES_PATH, loadClubCodes, validateClubCodes } from './emcu-club-codes.js';
import { EMCU_DISTRICT, EMCU_LEAGUE_KEYS, EMCU_TEAM_MAP, EMCU_TENANT } from './emcu-fixture-map.js';
// NOT './notify/whatsapp.js' / './notify/email.js' — see above. whatsapp-templates.ts is pure.
import {
  WHATSAPP_TEMPLATES,
  type WhatsAppTemplateDefinition,
} from './notify/whatsapp-templates.js';
import type { Channel, Club, SendResult } from './types.js';

type RepoModule = typeof import('./repo.js');
type NotifyEmail = typeof import('./notify/email.js');
type ScorerAccount = import('./notify/email.js').ScorerAccount;

const TENANT = EMCU_TENANT;
/** The WhatsApp notice's FIXED copy says "4 scorer accounts". */
export const NOTICE_ACCOUNT_COUNT = 4;
const REDACTED = '•••';

export type EmcuAudience = 'chairs' | 'players';
export type EmcuMessageKind =
  | 'emcu-chair-email'
  | 'emcu-player-email'
  | 'emcu_scorer_accounts_notice'
  | 'emcu_player_scoring';
export type EmcuPlannedMessage = PlannedMessage<EmcuMessageKind>;
/**
 * A message outcome; `marketingCap` marks a WhatsApp send Meta refused under its per-user
 * marketing frequency cap (error 131049) — a `skipped`, never a failure (see isMarketingCapError).
 */
export type EmcuOutcome = MessageOutcome<EmcuMessageKind> & { marketingCap?: true };

// ───────────────────────── Marketing cap (pure) ─────────────────────────

/**
 * Meta error 131049: "healthy ecosystem" per-user cap on MARKETING template messages. Both EMCU
 * templates were approved as Marketing (10 Oct 2026), so a send can be refused for a recipient
 * who already got too many marketing messages. Final for this run — not retryable (the shared
 * isRetryableSendError is deliberately unchanged), not a failure: the person is email-only.
 */
export const MARKETING_CAP_CODE = 131049;

export function isMarketingCapError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === 'WhatsAppError' &&
    (err as Error & { code?: unknown }).code === MARKETING_CAP_CODE
  );
}

/**
 * claimActionFor, plus: a bundle whose only "result" is a marketing-capped WhatsApp still
 * COMPLETES its claim (a re-run must not retry it as if nothing happened). PURE.
 */
export function emcuClaimAction(
  outcomes: Array<Pick<EmcuOutcome, 'status' | 'retryable' | 'marketingCap'>>,
): 'complete' | 'release-retryable' | 'release-none-sent' {
  const base = claimActionFor(outcomes);
  return base === 'release-none-sent' && outcomes.some((o) => o.marketingCap) ? 'complete' : base;
}

/**
 * Marketing-cap tally over manifest rows: `capped` = recipients with a capped WhatsApp;
 * `emailOnly` = of those, how many still got their email. PURE.
 */
export function marketingCapStats(recipients: Array<Pick<EmcuManifestRecipient, 'messages'>>): {
  capped: number;
  emailOnly: number;
} {
  let capped = 0;
  let emailOnly = 0;
  for (const r of recipients) {
    const msgs = r.messages ?? [];
    if (!msgs.some((m) => m.marketingCap)) continue;
    capped++;
    if (msgs.some((m) => m.channel === 'email' && m.status === 'sent')) emailOnly++;
  }
  return { capped, emailOnly };
}

// ───────────────────────── Claim keys (pure) ─────────────────────────

const channelSet = (channels: Channel[]): string => [...new Set(channels)].sort().join('+');

/** Per-(chair, club) claim key: a chair of two clubs is claimed once per club. PURE. */
export const chairClaimKey = (
  clubId: string,
  contact: string,
  channels: Channel[],
  resend = false,
): string => `emcu-scorers-${clubId}-${contact}#${channelSet(channels)}${resend ? '#resend' : ''}`;

/** Per-person player claim key. PURE. */
export const playerClaimKey = (contact: string, channels: Channel[], resend = false): string =>
  `emcu-player-scoring-${contact}#${channelSet(channels)}${resend ? '#resend' : ''}`;

// ───────────────────────── Secrets (pure) ─────────────────────────

/** Replace every occurrence of each (non-empty) secret in `text` with •••. PURE. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join(REDACTED);
  }
  return out;
}

/** The same accounts with every password replaced by ••• (dry-run samples). PURE. */
export const redactAccounts = (accounts: ScorerAccount[]): ScorerAccount[] =>
  accounts.map((a) => ({ email: a.email, password: REDACTED }));

// ───────────────────────── Credentials (pure) ─────────────────────────

export interface CredentialEntry {
  clubId: string;
  code: string;
  email: string;
  password: string;
  state: string;
}

/**
 * Parse the MediCoach script's credentials JSON: a top-level array of entries, or an object
 * with an `entries` array. Problems never quote a password. PURE.
 */
export function parseCredentials(raw: unknown): { entries: CredentialEntry[]; problems: string[] } {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries)
      ? (raw as { entries: unknown[] }).entries
      : null;
  if (!list) {
    return {
      entries: [],
      problems: ['credentials file must be a JSON array of entries (or { "entries": [...] })'],
    };
  }
  const entries: CredentialEntry[] = [];
  const problems: string[] = [];
  list.forEach((e, i) => {
    const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    const field = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
    const entry: CredentialEntry = {
      clubId: field('clubId'),
      code: field('code'),
      email: field('email').toLowerCase(),
      // Never trimmed or echoed — used verbatim.
      password: typeof o.password === 'string' ? o.password : '',
      state: field('state'),
    };
    const missing: string[] = (['clubId', 'code', 'email', 'state'] as const).filter(
      (k) => !entry[k],
    );
    if (!entry.password) missing.push('password');
    if (missing.length) {
      problems.push(`entry ${i + 1} (${entry.email || 'no email'}): missing ${missing.join(', ')}`);
      return;
    }
    entries.push(entry);
  });
  return { entries, problems };
}

export interface ClubCredentials {
  /** `created` accounts, ordered by scorer number. */
  accounts: ScorerAccount[];
  /** Entries for the club in any other state (pending/failed) — ignored. */
  notCreated: number;
  /** Per-club problems (code / email-format / duplicate) — the club is skipped. No passwords. */
  problems: string[];
}

const scorerEmailRe = (code: string) =>
  new RegExp(`^scorer(\\d+)\\.${code.replace(/[^a-z0-9]/g, '')}@medicoach\\.co\\.za$`);

/**
 * Group credential entries per club, checking each against the club-code table: the entry's code
 * must be the club's code and its email `scorer<n>.<code>@medicoach.co.za`. PURE.
 */
export function credentialsByClub(
  entries: CredentialEntry[],
  codes: Record<string, string>,
): Map<string, ClubCredentials> {
  const out = new Map<string, ClubCredentials>();
  const seen = new Set<string>();
  const ordered = new Map<string, Array<{ n: number; account: ScorerAccount }>>();
  for (const e of entries) {
    const c = out.get(e.clubId) ?? { accounts: [], notCreated: 0, problems: [] };
    out.set(e.clubId, c);
    if (seen.has(e.email)) {
      c.problems.push(`${e.email} appears more than once`);
      continue;
    }
    seen.add(e.email);
    const code = codes[e.clubId];
    if (!code) {
      c.problems.push(`no club code for ${e.clubId}`);
      continue;
    }
    if (e.code !== code) {
      c.problems.push(`${e.email}: entry code "${e.code}" ≠ club code "${code}"`);
      continue;
    }
    const m = scorerEmailRe(code).exec(e.email);
    if (!m) {
      c.problems.push(`${e.email} is not scorer<n>.${code}@medicoach.co.za`);
      continue;
    }
    if (e.state !== 'created') {
      c.notCreated++;
      continue;
    }
    ordered.set(e.clubId, [
      ...(ordered.get(e.clubId) ?? []),
      { n: Number(m[1]), account: { email: e.email, password: e.password } },
    ]);
  }
  for (const [clubId, list] of ordered) {
    out.get(clubId)!.accounts = list.sort((a, b) => a.n - b.n).map((x) => x.account);
  }
  return out;
}

// ───────────────────────── Club selection (pure) ─────────────────────────

export type EmcuClub = AudienceClub & { leagues?: string[]; district?: string };

/**
 * The EMCU clubs: the workbook's team-map club ids ∪ clubs carrying an EMCU league key. Also
 * returns the map ids the tenant lacks and the cross-check against the EMCU district. PURE.
 */
export function selectEmcuClubs<C extends EmcuClub>(
  clubs: C[],
  teamMapClubIds: readonly string[] = Object.values(EMCU_TEAM_MAP).map((e) => e.clubId),
  leagueKeys: readonly string[] = EMCU_LEAGUE_KEYS,
  district: string = EMCU_DISTRICT,
): {
  clubs: C[];
  missingFromTenant: string[];
  notInDistrict: string[];
  districtOnly: string[];
} {
  const mapIds = new Set(teamMapClubIds);
  const keys = new Set(leagueKeys);
  const isEmcu = (c: C) => mapIds.has(c.id) || (c.leagues ?? []).some((k) => keys.has(k));
  const selected = clubs.filter(isEmcu).sort((a, b) => a.name.localeCompare(b.name));
  const have = new Set(clubs.map((c) => c.id));
  return {
    clubs: selected,
    missingFromTenant: [...mapIds].filter((id) => !have.has(id)).sort(),
    notInDistrict: selected.filter((c) => c.district !== district).map((c) => c.id),
    districtOnly: clubs
      .filter((c) => c.district === district && !isEmcu(c))
      .map((c) => c.id)
      .sort(),
  };
}

// ───────────────────────── Audiences (pure) ─────────────────────────

export type EmcuSkipReason =
  | 'excluded'
  | 'no-chair-email'
  | 'no-code'
  | 'no-credentials'
  | 'credential-problem'
  | 'operator'
  | 'chair'
  | 'inactive'
  | 'placeholder'
  | 'no-contact'
  | 'deduped';

export interface EmcuSkip {
  reason: EmcuSkipReason;
  detail: string;
}

export interface ChairRecipient {
  clubId: string;
  clubName: string;
  code: string;
  /** The chair's name ('' ⇒ "Chairperson"). */
  name: string;
  email: string;
  /** E.164 digits (no +), or ''. */
  cell: string;
  /** SECRET-bearing: never serialise. */
  accounts: ScorerAccount[];
}

/**
 * One recipient per EMCU club with a chair email, a club code and ≥1 `created` credential; every
 * other club is a reported skip. Operators are skipped unless `includeOperators`. PURE.
 */
export function buildChairAudience(input: {
  clubs: EmcuClub[];
  codes: Record<string, string>;
  credentials: Map<string, ClubCredentials>;
  excludeClubIds?: ReadonlySet<string>;
  operators?: Array<{ email: string }>;
  includeOperators?: boolean;
}): { recipients: ChairRecipient[]; skips: EmcuSkip[] } {
  const recipients: ChairRecipient[] = [];
  const skips: EmcuSkip[] = [];
  const operatorEmails = new Set((input.operators ?? []).map((o) => normEmail(o.email)));
  for (const club of input.clubs) {
    const label = `${club.name} (${club.id})`;
    if (input.excludeClubIds?.has(club.id)) {
      skips.push({ reason: 'excluded', detail: `${label} — --exclude-club` });
      continue;
    }
    const chair = chairContactOf(club as Club);
    const email = normEmail(chair.email);
    const cell = normCell(chair.cell);
    if (!email) {
      skips.push({
        reason: 'no-chair-email',
        detail: `${label} — chair ${chair.name || '(no name)'} has no usable email${cell ? ` (cell +${cell} on file)` : ''}; the logins go by email only`,
      });
      continue;
    }
    if (!input.includeOperators && operatorEmails.has(email)) {
      skips.push({
        reason: 'operator',
        detail: `${label} — chair ${email} is a platform operator`,
      });
      continue;
    }
    const code = input.codes[club.id];
    if (!code) {
      skips.push({ reason: 'no-code', detail: `${label} — no club code in the code table` });
      continue;
    }
    const creds = input.credentials.get(club.id);
    if (creds?.problems.length) {
      skips.push({
        reason: 'credential-problem',
        detail: `${label} — ${creds.problems.join('; ')}`,
      });
      continue;
    }
    if (!creds || creds.accounts.length === 0) {
      skips.push({
        reason: 'no-credentials',
        detail: `${label} — no 'created' scorer accounts in the credentials file${creds?.notCreated ? ` (${creds.notCreated} not created)` : ''}`,
      });
      continue;
    }
    recipients.push({
      clubId: club.id,
      clubName: club.name,
      code,
      name: (chair.name ?? '').trim(),
      email,
      cell,
      accounts: creds.accounts,
    });
  }
  return { recipients, skips };
}

export interface PlayerRecipient {
  /** First name ('' ⇒ "player"). */
  name: string;
  email: string;
  cell: string;
  roles: string[];
  clubIds: string[];
  /** The {{2}} club: the recipient's first EMCU club. */
  clubName: string;
  minor: boolean;
}

/**
 * EMCU clubs' players via the welcome broadcast's buildAudience player branch (clubs passed
 * WITHOUT exco/coaches and no portal users, so only player rows contribute). A player sharing an
 * email or cell with an EMCU club chair is dropped (`chair` skip): chairs get the chair message
 * only. Excluded clubs contribute neither players nor chairs. PURE.
 */
export function buildPlayerAudience(input: {
  clubs: EmcuClub[];
  playersByClub: Map<string, AudiencePlayer[]>;
  excludeClubIds?: ReadonlySet<string>;
  operators?: Array<{ sub: string; email: string }>;
  includeOperators?: boolean;
}): { recipients: PlayerRecipient[]; skips: EmcuSkip[] } {
  const clubs = input.clubs.filter((c) => !input.excludeClubIds?.has(c.id));
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const audience = buildAudience({
    clubs: clubs.map((c) => ({ id: c.id, name: c.name })),
    playersByClub: input.playersByClub,
    tenantUsers: [],
    operators: input.operators ?? [],
    includeOperators: !!input.includeOperators,
  });
  const skips: EmcuSkip[] = input.clubs
    .filter((c) => input.excludeClubIds?.has(c.id))
    .map((c) => ({ reason: 'excluded' as const, detail: `${c.name} (${c.id}) — --exclude-club` }));
  skips.push(...audience.skips);
  const chairEmails = new Set<string>();
  const chairCells = new Set<string>();
  for (const c of clubs) {
    const chair = chairContactOf(c as Club);
    const e = normEmail(chair.email);
    const n = normCell(chair.cell);
    if (e) chairEmails.add(e);
    if (n) chairCells.add(n);
  }
  const recipients: PlayerRecipient[] = [];
  for (const r of audience.recipients) {
    if ((r.email && chairEmails.has(r.email)) || (r.cell && chairCells.has(r.cell))) {
      skips.push({
        reason: 'chair',
        detail: `${r.name || '(no name)'} <${r.email || `+${r.cell}`}> is an EMCU club chair — chair message only`,
      });
      continue;
    }
    recipients.push({
      name: r.name,
      email: r.email,
      cell: r.cell,
      roles: r.roles,
      clubIds: r.clubIds,
      clubName: clubName.get(r.clubIds[0] ?? '') ?? '',
      minor: r.minor,
    });
  }
  return { recipients, skips };
}

/** Does `--only <email-or-cell>` select this contact? PURE. */
export function matchesOnlyContact(r: { email: string; cell: string }, only: string): boolean {
  const email = normEmail(only);
  if (email) return r.email === email;
  const cell = normCell(only);
  return !!cell && r.cell === cell;
}

// ───────────────────────── Message planning (pure) ─────────────────────────

function whatsappLeg(kind: EmcuMessageKind, cell: string, blocked?: string): EmcuPlannedMessage {
  if (!cell) return { kind, channel: 'whatsapp', status: 'skip', reason: 'no-cell' };
  if (isLikelyLandline(cell))
    return { kind, channel: 'whatsapp', status: 'skip', to: cell, reason: 'landline?' };
  if (blocked) return { kind, channel: 'whatsapp', status: 'skip', to: cell, reason: blocked };
  return { kind, channel: 'whatsapp', status: 'send', to: cell };
}

/**
 * A chair's messages: the credentials email, then the WhatsApp notice — skipped (`accounts≠4`)
 * when the club does not hold exactly NOTICE_ACCOUNT_COUNT accounts, since the notice's fixed
 * copy says "4 scorer accounts". PURE.
 */
export function planChairMessages(r: ChairRecipient, channels: Channel[]): EmcuPlannedMessage[] {
  const out: EmcuPlannedMessage[] = [];
  if (channels.includes('email')) {
    out.push({ kind: 'emcu-chair-email', channel: 'email', status: 'send', to: r.email });
  }
  if (channels.includes('whatsapp')) {
    const n = r.accounts.length;
    out.push(
      whatsappLeg(
        'emcu_scorer_accounts_notice',
        r.cell,
        n === NOTICE_ACCOUNT_COUNT ? undefined : `accounts≠${NOTICE_ACCOUNT_COUNT} (${n})`,
      ),
    );
  }
  return out;
}

/** A player's messages: email + `emcu_player_scoring`. PURE. */
export function planPlayerMessages(r: PlayerRecipient, channels: Channel[]): EmcuPlannedMessage[] {
  const out: EmcuPlannedMessage[] = [];
  if (channels.includes('email')) {
    out.push(
      r.email
        ? { kind: 'emcu-player-email', channel: 'email', status: 'send', to: r.email }
        : { kind: 'emcu-player-email', channel: 'email', status: 'skip', reason: 'no-email' },
    );
  }
  if (channels.includes('whatsapp')) out.push(whatsappLeg('emcu_player_scoring', r.cell));
  return out;
}

/** The audience's WhatsApp template when it is not yet `registered` (a --confirm blocker). PURE. */
export function pendingTemplateFor(
  audience: EmcuAudience,
  templates: Record<string, WhatsAppTemplateDefinition> = WHATSAPP_TEMPLATES,
): string | null {
  const def = templates[audience === 'chairs' ? 'emcuScorerAccountsNotice' : 'emcuPlayerScoring'];
  return def && def.status !== 'registered' ? def.name : null;
}

/** With the whatsapp channel, --video-file is required, must exist and be ≤ 16 MB. PURE given sizeOf. */
export function videoFileBlocker(
  channels: Channel[],
  videoFile: string | undefined,
  sizeOf: (path: string) => number | null,
): string | null {
  if (!channels.includes('whatsapp')) return null;
  if (!videoFile) return '--video-file is required with the whatsapp channel (uploaded to Meta)';
  const size = sizeOf(videoFile);
  if (size === null) return `--video-file ${videoFile}: file not found`;
  if (size > WHATSAPP_VIDEO_MAX_BYTES) {
    return `--video-file ${videoFile}: ${(size / 1024 / 1024).toFixed(1)} MB exceeds Meta's 16 MB video cap — re-encode it`;
  }
  return null;
}

// ───────────────────────── 8 Oct welcome cross-check (pure) ─────────────────────────

export interface WelcomeManifestLike {
  recipients: Array<{
    email?: string;
    cell?: string;
    outcome?: string;
    messages?: Array<{ kind: string; status: string }>;
  }>;
}

/**
 * Chairs whose 8 Oct welcome delivery failed, was skipped or is missing — they need manual
 * confirmation (is this still the right person/contact?) before credentials go out. PURE.
 */
export function welcomeChairFlags(
  welcome: WelcomeManifestLike,
  chairs: ChairRecipient[],
): Array<{ clubId: string; chair: string; detail: string }> {
  const out: Array<{ clubId: string; chair: string; detail: string }> = [];
  for (const c of chairs) {
    const w = welcome.recipients.find(
      (r) => (c.email && normEmail(r.email) === c.email) || (c.cell && normCell(r.cell) === c.cell),
    );
    const chair = `${c.name || '(no name)'} <${c.email}> — ${c.clubName}`;
    if (!w) {
      out.push({ clubId: c.clubId, chair, detail: 'not in the welcome manifest' });
      continue;
    }
    if (w.outcome !== 'sent' && w.outcome !== 'replay') {
      out.push({
        clubId: c.clubId,
        chair,
        detail: `welcome outcome ${w.outcome ?? 'not attempted'}`,
      });
      continue;
    }
    const bad = (w.messages ?? []).filter((m) => m.status !== 'sent');
    if (bad.length) {
      out.push({
        clubId: c.clubId,
        chair,
        detail: `welcome ${bad.map((m) => `${m.kind} ${m.status}`).join(', ')}`,
      });
    }
  }
  return out;
}

// ───────────────────────── Manifest (pure) ─────────────────────────

/**
 * One manifest row. Shaped like the welcome manifest's rows (cohort 'staff' = chair) so the
 * welcome report renders it. NEVER carries credentials — only `scorerAccounts`, a count.
 */
export interface EmcuManifestRecipient {
  cohort: 'staff' | 'player';
  name: string;
  email: string;
  cell: string;
  roles: string[];
  clubs: string[];
  genericGreeting: boolean;
  planned: EmcuPlannedMessage[];
  scorerAccounts?: number;
  idempotencyKey?: string;
  markerClubId?: string;
  outcome?:
    | 'sent'
    | 'marketing-capped'
    | 'all-failed'
    | 'retry-later'
    | 'replay'
    | 'nothing-to-send'
    | 'error';
  messages?: EmcuOutcome[];
  error?: string;
}

export interface EmcuManifest {
  broadcast: 'emcu-scorers';
  audience: EmcuAudience;
  tenant: string;
  mode: 'dry-run' | 'confirm';
  runId: string;
  stage: string | null;
  startedAt: string;
  finishedAt?: string;
  args: {
    channels: Channel[];
    resend: boolean;
    only?: string;
    includeOperators: boolean;
    excludeClubs: string[];
    staffVideoUrl: string;
    videoFile?: string;
    mediaId?: string;
    codesFile: string;
    credentialsFile?: string;
    welcomeManifest?: string;
  };
  summary: ReturnType<typeof summarise>;
  recipients: EmcuManifestRecipient[];
  skips: EmcuSkip[];
  warnings: string[];
  /** Set on --confirm: Meta marketing-cap (131049) refusals — see marketingCapStats. */
  marketingCap?: { capped: number; emailOnly: number };
}

export function chairManifestRecipient(
  r: ChairRecipient,
  planned: EmcuPlannedMessage[],
): EmcuManifestRecipient {
  return {
    cohort: 'staff',
    name: r.name,
    email: r.email,
    cell: r.cell,
    roles: [`Chairperson @ ${r.clubName}`],
    clubs: [r.clubName],
    genericGreeting: !r.name,
    planned,
    scorerAccounts: r.accounts.length,
  };
}

export function playerManifestRecipient(
  r: PlayerRecipient,
  planned: EmcuPlannedMessage[],
  clubNames: string[],
): EmcuManifestRecipient {
  return {
    cohort: 'player',
    name: r.name,
    email: r.email,
    cell: r.cell,
    roles: r.roles,
    clubs: [...clubNames].sort((a, b) => a.localeCompare(b)),
    genericGreeting: false,
    planned,
  };
}

export function summarise(plans: EmcuPlannedMessage[][]) {
  const all = plans.flat();
  const count = (pred: (m: EmcuPlannedMessage) => boolean) => all.filter(pred).length;
  return {
    recipients: plans.length,
    emailsToSend: count((m) => m.channel === 'email' && m.status === 'send'),
    whatsappsToSend: count((m) => m.channel === 'whatsapp' && m.status === 'send'),
    noEmail: count((m) => m.reason === 'no-email'),
    noCell: count((m) => m.reason === 'no-cell'),
    landline: count((m) => m.reason === 'landline?'),
    accountCountBlocked: count((m) => !!m.reason?.startsWith('accounts≠')),
  };
}

const manifestPath = (audience: EmcuAudience, runId: string): string =>
  `./emcu-scorer-broadcast-${audience}-${runId}.json`;

// ───────────────────────── Samples (pure) ─────────────────────────

const fill = (body: string, params: string[]): string =>
  params.reduce((b, p, i) => b.split(`{{${i + 1}}}`).join(p), body);

/** The dry-run chair sample: the email with every password as •••, then the WhatsApp body. PURE. */
export function chairSampleText(
  r: ChairRecipient,
  content: NotifyEmail['emcuChairScorerEmailContent'],
  staffVideoUrl: string,
  waVideo: string,
): string {
  const e = content({
    name: r.name,
    clubName: r.clubName,
    accounts: redactAccounts(r.accounts),
    staffVideoUrl,
  });
  const def = WHATSAPP_TEMPLATES.emcuScorerAccountsNotice;
  return (
    `══ Sample CHAIR email (to ${r.email}) — subject: ${e.subject} [passwords redacted]\n\n` +
    `${e.text}\n\n` +
    `══ Sample CHAIR WhatsApp (${def.name}, video: ${waVideo})\n\n` +
    fill(def.bodyText, [r.name || 'Chairperson', r.clubName, r.email])
  );
}

/** The dry-run player sample. PURE. */
export function playerSampleText(
  r: PlayerRecipient,
  content: NotifyEmail['emcuPlayerScoringEmailContent'],
  staffVideoUrl: string,
  waVideo: string,
): string {
  const e = content({ firstName: r.name, clubName: r.clubName, staffVideoUrl });
  const def = WHATSAPP_TEMPLATES.emcuPlayerScoring;
  return (
    `══ Sample PLAYER email (to ${r.email || '—'}) — subject: ${e.subject}\n\n` +
    `${e.text}\n\n` +
    `══ Sample PLAYER WhatsApp (${def.name}, video: ${waVideo})\n\n` +
    fill(def.bodyText, [r.name || 'player', r.clubName])
  );
}

// ───────────────────────── CLI args ─────────────────────────

export interface Args {
  audience: EmcuAudience;
  credentials?: string;
  codes: string;
  channels: Channel[];
  confirm: boolean;
  resend: boolean;
  only?: string;
  includeOperators: boolean;
  excludeClubs: string[];
  staffVideoUrl?: string;
  videoFile?: string;
  welcomeManifest?: string;
  allowDryRunSends: boolean;
}

/** Parse the CLI flags (throws on a bad flag/value). PURE. */
export function parseArgs(argv: string[]): Args {
  const args: Args = {
    audience: undefined as unknown as EmcuAudience,
    codes: DEFAULT_CLUB_CODES_PATH,
    channels: ['email', 'whatsapp'],
    confirm: false,
    resend: false,
    includeOperators: false,
    excludeClubs: [],
    allowDryRunSends: false,
  };
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--audience') {
      const v = value(++i, a);
      if (v !== 'chairs' && v !== 'players')
        throw new Error('--audience must be chairs or players');
      args.audience = v;
    } else if (a === '--credentials') args.credentials = value(++i, a);
    else if (a === '--codes') args.codes = value(++i, a);
    else if (a === '--channels') args.channels = parseChannels(value(++i, a));
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--resend') args.resend = true;
    else if (a === '--only') args.only = value(++i, a);
    else if (a === '--include-operators') args.includeOperators = true;
    else if (a === '--exclude-club') args.excludeClubs.push(value(++i, a));
    else if (a === '--staff-video-url') args.staffVideoUrl = value(++i, a);
    else if (a === '--video-file') args.videoFile = value(++i, a);
    else if (a === '--welcome-manifest') args.welcomeManifest = value(++i, a);
    else if (a === '--allow-dry-run-sends') args.allowDryRunSends = true;
    else throw new Error(`unknown flag ${a}`);
  }
  if (!args.audience) throw new Error('--audience chairs|players is required');
  if (args.audience === 'chairs' && !args.credentials) {
    throw new Error('--credentials <path> is required with --audience chairs');
  }
  if (args.audience === 'players' && args.credentials) {
    throw new Error('--credentials is for --audience chairs only (players get no logins)');
  }
  if (args.only !== undefined && !normEmail(args.only) && !normCell(args.only)) {
    throw new Error(`--only "${args.only}" is neither a valid email nor a cell number`);
  }
  if (args.staffVideoUrl !== undefined && !/^https:\/\/\S+$/.test(args.staffVideoUrl)) {
    throw new Error('--staff-video-url must be an https URL');
  }
  return args;
}

// ───────────────────────── Main ─────────────────────────

const STAFF_VIDEO_PLACEHOLDER = '<staff video URL — pass --staff-video-url>';

const describePlan = (plan: EmcuPlannedMessage[]): string =>
  plan.map((m) => `${m.kind}:${m.status}${m.reason ? `(${m.reason})` : ''}`).join(', ');

/** One recipient as the send loop sees it (both audiences). */
interface SendTarget {
  who: string;
  name: string;
  email: string;
  cell: string;
  claimKey: string;
  markerClubId: string;
  plan: EmcuPlannedMessage[];
  /** Strings to strip from any error text (the chair's passwords). */
  secrets: string[];
  send: (m: EmcuPlannedMessage) => Promise<{ messageId: string }>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // FIRST, before any dynamic import of a notify module (see import-titans-contacts.ts main()).
  const filled = bootstrapNotifyEnvFromSst();
  if (filled.length) console.log(`· notify config from SST linked secrets: ${filled.join(', ')}`);

  const repo: RepoModule = await import('./repo.js');
  const [email, whatsapp] = await Promise.all([
    import('./notify/email.js'),
    import('./notify/whatsapp.js'),
  ]);

  const blockers: string[] = [];
  const warnings: string[] = [];

  // Club codes.
  const codes = await loadClubCodes(args.codes);
  const teamMapIds = [...new Set(Object.values(EMCU_TEAM_MAP).map((e) => e.clubId))];
  const codeProblems = validateClubCodes(codes, teamMapIds);
  if (codeProblems.length && args.audience === 'chairs') {
    blockers.push(...codeProblems.map((p) => `club codes (${args.codes}): ${p}`));
  }

  // EMCU clubs.
  const allClubs = await repo.listClubs(TENANT);
  const sel = selectEmcuClubs(allClubs);
  console.log(`── EMCU clubs: ${sel.clubs.length} (team map ∪ EMCU league keys)`);
  if (sel.missingFromTenant.length) {
    warnings.push(`team-map club(s) not on this stage: ${sel.missingFromTenant.join(', ')}`);
  }
  console.log(
    `  cross-check vs district "${EMCU_DISTRICT}": ` +
      `${sel.notInDistrict.length} selected but filed elsewhere` +
      `${sel.notInDistrict.length ? ` (${sel.notInDistrict.join(', ')})` : ''}; ` +
      `${sel.districtOnly.length} in the district but not selected` +
      `${sel.districtOnly.length ? ` (${sel.districtOnly.join(', ')})` : ''}`,
  );
  const unknownExcludes = args.excludeClubs.filter((id) => !sel.clubs.some((c) => c.id === id));
  if (unknownExcludes.length) {
    blockers.push(`--exclude-club not an EMCU club: ${unknownExcludes.join(', ')}`);
  }
  const excludeClubIds = new Set(args.excludeClubs);
  const operators = await repo.listOperators();
  const clubNameById = new Map(allClubs.map((c) => [c.id, c.name]));

  const staffVideoUrl = args.staffVideoUrl ?? STAFF_VIDEO_PLACEHOLDER;
  const waVideo = `Meta upload of ${args.videoFile ?? '<--video-file missing>'}`;

  let rows: Array<{ entry: EmcuManifestRecipient; target: Omit<SendTarget, 'send'> }> = [];
  let skips: EmcuSkip[] = [];
  let sendFor: (i: number) => SendTarget['send'];
  let staffVideoRef: import('./notify/whatsapp.js').VideoRef | undefined;
  const videoRef = () => staffVideoRef!;

  if (args.audience === 'chairs') {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(args.credentials!, 'utf8')) as unknown;
    } catch {
      // Never surface the parser's message: V8 quotes a snippet of the input (a password).
      throw new Error(`--credentials ${args.credentials}: unreadable or not valid JSON`);
    }
    const parsed = parseCredentials(raw);
    blockers.push(...parsed.problems.map((p) => `credentials: ${p}`));
    const creds = credentialsByClub(parsed.entries, codes);
    const emcuIds = new Set(sel.clubs.map((c) => c.id));
    for (const [clubId, c] of creds) {
      if (!emcuIds.has(clubId)) warnings.push(`credentials for non-EMCU club ${clubId} — ignored`);
      else if (c.notCreated) {
        warnings.push(`${clubId}: ${c.notCreated} credential entr(ies) not 'created' — ignored`);
      }
    }
    const audience = buildChairAudience({
      clubs: sel.clubs,
      codes,
      credentials: creds,
      excludeClubIds,
      operators,
      includeOperators: args.includeOperators,
    });
    skips = audience.skips;
    let chairs = audience.recipients;
    if (args.only) chairs = chairs.filter((r) => matchesOnlyContact(r, args.only!));

    if (args.welcomeManifest) {
      const welcome = JSON.parse(
        await readFile(args.welcomeManifest, 'utf8'),
      ) as WelcomeManifestLike;
      const flags = welcomeChairFlags(welcome, chairs);
      console.log(`\n── Chairs needing manual confirmation (8 Oct welcome): ${flags.length}`);
      for (const f of flags) console.log(`  ⚠ ${f.chair}: ${f.detail}`);
      warnings.push(...flags.map((f) => `welcome check — ${f.chair}: ${f.detail}`));
    }

    console.log(`\n── Chairs (${chairs.length})`);
    rows = chairs.map((r) => {
      const plan = planChairMessages(r, args.channels);
      console.log(
        `  ${r.clubName} [${r.code}] — ${r.name || '(no name → "Chairperson")'} <${r.email}> ` +
          `${r.cell ? `+${r.cell}` : 'no cell'} — ${r.accounts.length} scorer account(s)`,
      );
      console.log(`      → ${describePlan(plan)}`);
      return {
        entry: chairManifestRecipient(r, plan),
        target: {
          who: `${r.name || '(no name)'} <${r.email}> — ${r.clubName}`,
          name: r.name,
          email: r.email,
          cell: r.cell,
          claimKey: chairClaimKey(r.clubId, r.email, args.channels, args.resend),
          markerClubId: r.clubId,
          plan,
          secrets: r.accounts.map((a) => a.password),
        },
      };
    });
    const blockedWa = chairs.filter((r) => r.accounts.length !== NOTICE_ACCOUNT_COUNT);
    if (blockedWa.length && args.channels.includes('whatsapp')) {
      warnings.push(
        `WhatsApp notice BLOCKED (copy says ${NOTICE_ACCOUNT_COUNT} accounts) for: ` +
          blockedWa.map((r) => `${r.clubName} (${r.accounts.length})`).join(', ') +
          ' — their email states the real count',
      );
    }
    if (chairs[0]) {
      console.log(
        `\n${chairSampleText(chairs[0], email.emcuChairScorerEmailContent, staffVideoUrl, waVideo)}`,
      );
    }
    sendFor = (i) => {
      const r = chairs[i]!;
      return (m) =>
        m.kind === 'emcu-chair-email'
          ? email.sendEmcuChairScorerEmail({
              to: m.to!,
              name: r.name,
              clubName: r.clubName,
              accounts: r.accounts,
              staffVideoUrl: args.staffVideoUrl!,
            })
          : whatsapp.sendEmcuScorerAccountsNoticeWhatsApp(
              m.to!,
              { chairName: r.name, clubName: r.clubName, chairEmail: r.email },
              videoRef(),
            );
    };
  } else {
    const playersByClub = new Map<string, AudiencePlayer[]>();
    for (const c of sel.clubs) {
      if (!excludeClubIds.has(c.id)) playersByClub.set(c.id, await repo.listPlayers(TENANT, c.id));
    }
    const audience = buildPlayerAudience({
      clubs: sel.clubs,
      playersByClub,
      excludeClubIds,
      operators,
      includeOperators: args.includeOperators,
    });
    skips = audience.skips;
    let players = audience.recipients;
    if (args.only) players = players.filter((r) => matchesOnlyContact(r, args.only!));
    console.log(`\n── Players (${players.length})`);
    rows = players.map((r) => {
      const plan = planPlayerMessages(r, args.channels);
      console.log(
        `  ${r.name || '(no name)'} <${r.email || 'no email'}> ${r.cell ? `+${r.cell}` : 'no cell'}` +
          `${r.minor ? '  [minor contact]' : ''} — ${r.clubName}`,
      );
      console.log(`      → ${describePlan(plan)}`);
      const contact = r.email || r.cell;
      return {
        entry: playerManifestRecipient(
          r,
          plan,
          r.clubIds.map((id) => clubNameById.get(id) ?? id),
        ),
        target: {
          who: `${r.name || '(no name)'} <${r.email || `+${r.cell}`}>`,
          name: r.name,
          email: r.email,
          cell: r.cell,
          claimKey: playerClaimKey(contact, args.channels, args.resend),
          markerClubId: [...r.clubIds].sort()[0]!,
          plan,
          secrets: [],
        },
      };
    });
    if (players[0]) {
      console.log(
        `\n${playerSampleText(players[0], email.emcuPlayerScoringEmailContent, staffVideoUrl, waVideo)}`,
      );
    }
    sendFor = (i) => {
      const r = players[i]!;
      return (m) =>
        m.kind === 'emcu-player-email'
          ? email.sendEmcuPlayerScoringEmail({
              to: m.to!,
              firstName: r.name,
              clubName: r.clubName,
              staffVideoUrl: args.staffVideoUrl!,
            })
          : whatsapp.sendEmcuPlayerScoringWhatsApp(
              m.to!,
              { firstName: r.name, clubName: r.clubName },
              videoRef(),
            );
    };
  }

  if (!args.only && skips.length) {
    console.log('\n── Skipped');
    const byReason = new Map<string, EmcuSkip[]>();
    for (const s of skips) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s]);
    for (const [reason, list] of byReason) {
      console.log(`  ${reason} (${list.length}):`);
      for (const s of list) console.log(`     · ${s.detail}`);
    }
  }

  const summary = summarise(rows.map((r) => r.target.plan));
  console.log('\n── Summary');
  console.log(
    `  ${summary.recipients} ${args.audience === 'chairs' ? 'chair (per club)' : 'player'} recipient(s)` +
      `${args.only ? ` (--only ${args.only})` : ''}; emails to send ${summary.emailsToSend}, ` +
      `WhatsApps to send ${summary.whatsappsToSend}; skipped: no-email ${summary.noEmail}, ` +
      `no-cell ${summary.noCell}, landline ${summary.landline}, accounts≠${NOTICE_ACCOUNT_COUNT} ${summary.accountCountBlocked}`,
  );
  if (warnings.length) {
    console.log(`\n⚠ ${warnings.length} warning(s) (not run-blocking):`);
    for (const w of warnings) console.log(`   ${w}`);
  }

  if (args.only && rows.length === 0) blockers.push(`--only "${args.only}" matched nobody`);
  if (args.channels.includes('email') && !args.staffVideoUrl) {
    blockers.push('--staff-video-url is required to send email');
  }
  const videoBlocker = videoFileBlocker(args.channels, args.videoFile, fileSize);
  if (videoBlocker) blockers.push(videoBlocker);
  const pending = args.channels.includes('whatsapp') ? pendingTemplateFor(args.audience) : null;
  if (pending) {
    blockers.push(
      `WhatsApp template not yet registered: ${pending} — approve in Meta and flip its registry ` +
        'status, or run with --channels email',
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
  const path = manifestPath(args.audience, runId);
  const manifest: EmcuManifest = {
    broadcast: 'emcu-scorers',
    audience: args.audience,
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
      excludeClubs: args.excludeClubs,
      staffVideoUrl,
      ...(args.videoFile ? { videoFile: args.videoFile } : {}),
      codesFile: args.codes,
      ...(args.credentials ? { credentialsFile: args.credentials } : {}),
      ...(args.welcomeManifest ? { welcomeManifest: args.welcomeManifest } : {}),
    },
    summary,
    recipients: rows.map((r) => r.entry),
    skips: args.only ? [] : skips,
    warnings,
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

  const refusals = dryRunSendRefusals(
    rows.map((r) => r.target.plan),
    args.channels,
    { email: email.EMAIL_DRY_RUN, whatsapp: whatsapp.WHATSAPP_DRY_RUN },
  );
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

  // Upload the WhatsApp header video ONCE, before any claim (a failure aborts with nothing sent).
  if (
    rows.some((r) => r.target.plan.some((m) => m.channel === 'whatsapp' && m.status === 'send'))
  ) {
    const upload = await whatsapp.uploadWhatsAppMedia(args.videoFile!);
    console.log(`· staff video ${args.videoFile} → Meta media id ${upload.mediaId}`);
    staffVideoRef = { id: upload.mediaId };
    manifest.args.mediaId = upload.mediaId;
  }

  const allSecrets = rows.flatMap((r) => r.target.secrets);
  const clean = (err: unknown): string =>
    redactSecrets(err instanceof Error ? err.message : String(err), allSecrets);

  let delivered = 0;
  let replays = 0;
  let releasedForRetry = 0;
  let halted = false;
  const failures: string[] = [];
  try {
    for (const [i, { entry, target }] of rows.entries()) {
      if (halted) break;
      const { who, plan, claimKey: key, markerClubId } = target;
      const toSend = plan.filter((m) => m.status === 'send');
      if (toSend.length === 0) {
        entry.outcome = 'nothing-to-send';
        console.log(`  · ${who}: nothing to send (${describePlan(plan)})`);
        continue;
      }
      entry.idempotencyKey = key;
      entry.markerClubId = markerClubId;
      const channels = [...new Set(toSend.map((m) => m.channel))];
      const send = sendFor(i);

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
        const outcomes: EmcuOutcome[] = [];
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
            const { messageId } = await send(m);
            const outcome: EmcuOutcome = {
              kind: m.kind,
              channel: m.channel,
              to: m.to,
              status: 'sent',
              messageId,
              delivered: !!messageId && !messageId.startsWith('dry-run-'),
              at,
            };
            outcomes.push(outcome);
            const record = broadcastDeliveryFor(runId, target, outcome);
            if (record) {
              try {
                await repo.putBroadcastDelivery(TENANT, record);
              } catch (recErr: unknown) {
                outcome.deliveryRecordError = clean(recErr);
                console.warn(
                  `  ⚠ ${who}: ${m.kind} sent (${messageId}) but its delivery record failed: ${outcome.deliveryRecordError}`,
                );
              }
            }
          } catch (err: unknown) {
            if (isMarketingCapError(err)) {
              outcomes.push({
                kind: m.kind,
                channel: m.channel,
                to: m.to,
                status: 'skipped',
                delivered: false,
                error: `marketing-cap (${MARKETING_CAP_CODE}): ${clean(err)}`,
                at,
                marketingCap: true,
              });
              continue;
            }
            const pendingTemplate =
              err instanceof Error && err.name === 'WhatsAppTemplatePendingError';
            outcomes.push({
              kind: m.kind,
              channel: m.channel,
              to: m.to,
              status: pendingTemplate ? 'skipped' : 'failed',
              delivered: false,
              error: clean(err),
              at,
              ...(pendingTemplate ? {} : { retryable: isRetryableSendError(err) }),
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
              `${o.kind}:${o.marketingCap ? 'marketing-cap' : o.status}${o.delivered ? '' : o.status === 'sent' ? '(dry-run)' : ''}`,
          )
          .join(', ');
        const action = emcuClaimAction(outcomes);
        if (action === 'release-retryable') {
          await repo.releaseInviteClaim(TENANT, markerClubId, key);
          entry.outcome = 'retry-later';
          delivered += outcomes.filter((o) => o.delivered).length;
          releasedForRetry++;
          const sentKinds = outcomes.filter((o) => o.status === 'sent').map((o) => o.kind);
          console.warn(
            `  ↻ ${who}: ${line} — retryable failure (rate cap / transport); claim released for ` +
              `the next run${sentKinds.length ? ` (${sentKinds.join(', ')} already sent — will repeat on retry)` : ''}`,
          );
          halted = true;
        } else if (action === 'complete') {
          await repo.completeInviteSend(TENANT, markerClubId, key, results);
          const anySent = outcomes.some((o) => o.status === 'sent');
          entry.outcome = anySent ? 'sent' : 'marketing-capped';
          delivered += outcomes.filter((o) => o.delivered).length;
          const failed = outcomes.filter((o) => o.status === 'failed');
          if (failed.length)
            failures.push(`${who}: ${failed.map((o) => `${o.kind} (${o.error})`).join('; ')}`);
          const capped = outcomes.some((o) => o.marketingCap);
          console.log(`  ${failed.length || capped ? '⚠' : '✓'} ${who}: ${line}`);
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
            console.warn(`  ⚠ ${who}: failed to release send claim: ${clean(releaseErr)}`);
          }
        }
        const message = clean(err);
        entry.outcome = 'error';
        entry.error = message;
        failures.push(`${who}: ${message}`);
        console.error(`  ✗ ${who}: ${message}`);
      }
      if (i % 25 === 24) await save();
    }
  } finally {
    manifest.finishedAt = new Date().toISOString();
    manifest.marketingCap = marketingCapStats(manifest.recipients);
    await save();
  }

  const cap = manifest.marketingCap ?? { capped: 0, emailOnly: 0 };
  if (cap.capped) {
    console.warn(
      `\n⚠ Meta marketing cap (${MARKETING_CAP_CODE}): WhatsApp refused for ${cap.capped} ` +
        `recipient(s) — ${cap.emailOnly} got the email only. Not retried (final for this run).`,
    );
  }
  const sentPeople = manifest.recipients.filter((e) => e.outcome === 'sent').length;
  console.log(
    `\n· ${sentPeople} recipient(s) sent, ${delivered} message(s) delivered to a provider ` +
      `(real ids only), ${replays} already-sent (replay).`,
  );
  console.log(`· manifest: ${path}`);
  console.log(
    `· run id ${runId} — report: npm --prefix packages/api run report:emcu-scorers -- --manifest ${path}`,
  );
  if (failures.length) {
    console.error(`\n✗ ${failures.length} per-recipient failure(s):`);
    for (const f of failures) console.error(`   ${f}`);
    process.exitCode = 1;
  }
  if (halted) {
    const notAttempted = manifest.recipients.filter((e) => e.outcome === undefined).length;
    console.warn(
      `\n↻ RATE CAP / TRANSPORT FAILURE — run halted. ${releasedForRetry} recipient(s) released ` +
        `for retry, ${notAttempted} not attempted yet (no claim made).\n` +
        '  Re-run the SAME command (same --channels, no --resend) after ~24h. Completed ' +
        'recipients replay as already-sent; only the remainder sends.',
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

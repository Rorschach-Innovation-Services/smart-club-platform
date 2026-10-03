/**
 * Medicoach ↔ smart club fixture sync — wire contract v1 (ADR 0016).
 *
 * The source of truth is the shared CONTRACT.md; this module is its smart-club half, and
 * medicoach mirrors it in `packages/types/src/smartclub-sync.ts`. The JSON examples in
 * `docs/integrations/medicoach-sync-examples/` are copied byte-for-byte into BOTH repos and
 * each repo's test parses every one with its own schema, so drift fails CI on either side.
 *
 * Direction: smart club is always the CALLER (it pulls `GET /integrations/smartclub/changes`
 * and, from Slice 4, pushes `POST /integrations/smartclub/schedule`); medicoach never calls
 * smart club. Requests are HMAC-SHA256 signed with one shared secret (smart club SST secret
 * `MedicoachSyncSecret` == medicoach `SmartClubSyncSecret`).
 *
 * PII: a player ref (`smartclub:<t>:player:<naturalKey>`) is an unsalted hash of the
 * person's ID number. Never log one, never put one on a public route.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const MEDICOACH_SYNC_VERSION = 1;

/** Reject a request whose timestamp is further than this from the receiver's clock. */
export const MAX_CLOCK_SKEW_MS = 300_000;

export const SYNC_TIMESTAMP_HEADER = 'X-Sync-Timestamp';
export const SYNC_SIGNATURE_HEADER = 'X-Sync-Signature';

export const CHANGES_PATH = '/integrations/smartclub/changes';
export const SCHEDULE_PATH = '/integrations/smartclub/schedule';

/** Page size bounds for the changes endpoint. */
export const CHANGES_LIMIT_DEFAULT = 200;
export const CHANGES_LIMIT_MAX = 500;
/** Max schedule changes per push request. */
export const SCHEDULE_PUSH_MAX = 100;

/* ─────────────────────────── Schemas ─────────────────────────── */

/** ISO-8601 UTC instant, e.g. 2026-10-04T14:32:10.123Z. */
const isoUtc = z.string().datetime();

/**
 * An instant in ONE canonical spelling (`YYYY-MM-DDTHH:mm:ss.sssZ`). The contract accepts any
 * precision (`…58Z`, `…58.5Z`), and smart club orders by plain string comparison in
 * DynamoDB conditions (`orderAt < :o`, `changedAt < :c`), where `…58Z` sorts AFTER `…58.5Z`.
 * Every stored or compared sync timestamp goes through this first.
 */
export function isoInstant(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}
/** ISO-8601 instant with an explicit offset, e.g. 2026-10-04T09:00:00+02:00. */
const isoWithOffset = z.string().datetime({ offset: true });
const ref = z.string().min(1);

export const SyncScheduleSchema = z.object({
  scheduledTime: isoWithOffset.nullable(),
  timeTbc: z.boolean(),
  dateTbc: z.boolean(),
  venue: z.string().nullable(),
  postponed: z.boolean(),
  cancelled: z.boolean(),
  /** Last schedule write in medicoach (pull) / in smart club (push), any origin. */
  changedAt: isoUtc,
});

export const SyncTeamsSchema = z.object({
  homeRef: ref.nullable(),
  awayRef: ref.nullable(),
});

/**
 * A link a page may render as `href`: http(s) only. Anything else (`javascript:`, `data:`,
 * `vbscript:` — all valid URLs to zod) would run script in the console when clicked.
 */
export function httpUrlOrNull(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

export const SyncResultSchema = z.object({
  homeScore: z.string().nullable(),
  awayScore: z.string().nullable(),
  summary: z.string().nullable(),
  winner: z.enum(['home', 'away', 'tie', 'none']).nullable(),
  method: z
    .enum(['normal', 'run-rate', 'dls', 'no-result', 'abandoned', 'tie', 'forfeit'])
    .nullable(),
  noResult: z.boolean(),
  /** `import` = migration/backfill/service principal → never opens captain's reports. */
  source: z.enum(['live', 'manual', 'import']),
  recordedAt: isoUtc,
  scoringSide: z.enum(['home', 'away']).nullable(),
  /** PERSONAL DATA (hashed ID number) — never log. */
  captainRef: ref.nullable(),
  /** A non-http(s) link is dropped to null rather than failing the page. */
  medicoachMatchUrl: z.string().url().nullable().transform(httpUrlOrNull),
});

export const FixtureChangeSchema = z.object({
  ref,
  syncStamp: isoUtc,
  schedule: SyncScheduleSchema,
  teams: SyncTeamsSchema,
  result: SyncResultSchema.nullable(),
  resultClearedAt: isoUtc.nullable(),
});

export const ChangesResponseSchema = z.object({
  version: z.literal(MEDICOACH_SYNC_VERSION),
  tenant: z.string().min(1),
  nextCursor: z.string(),
  hasMore: z.boolean(),
  fixtures: z.array(FixtureChangeSchema),
});

export const SchedulePushRequestSchema = z.object({
  version: z.literal(MEDICOACH_SYNC_VERSION),
  tenant: z.string().min(1),
  changes: z.array(z.object({ ref, schedule: SyncScheduleSchema })).max(SCHEDULE_PUSH_MAX),
});

export const SchedulePushResponseSchema = z.object({
  version: z.literal(MEDICOACH_SYNC_VERSION),
  results: z.array(
    z.object({
      ref,
      status: z.enum(['applied', 'stale', 'unchanged', 'unmapped', 'error']),
      message: z.string().optional(),
    }),
  ),
});

export type SyncSchedule = z.infer<typeof SyncScheduleSchema>;
export type SyncTeams = z.infer<typeof SyncTeamsSchema>;
export type SyncResult = z.infer<typeof SyncResultSchema>;
export type FixtureChange = z.infer<typeof FixtureChangeSchema>;
export type ChangesResponse = z.infer<typeof ChangesResponseSchema>;
export type SchedulePushRequest = z.infer<typeof SchedulePushRequestSchema>;
export type SchedulePushResponse = z.infer<typeof SchedulePushResponseSchema>;

/* ─────────────────────────── Request paths ─────────────────────────── */

/**
 * The exact path + query the puller sends (and signs). `since` omitted ⇒ a full resync.
 * Built once and used for both the URL and the signature, so the two can never differ.
 */
export function changesPathAndQuery(tenant: string, since?: string, limit?: number): string {
  const q = new URLSearchParams({ tenant });
  if (since && since !== '0') q.set('since', since);
  if (limit !== undefined) q.set('limit', String(limit));
  return `${CHANGES_PATH}?${q.toString()}`;
}

/* ─────────────────────────── Signing ─────────────────────────── */

/** The exact string both sides HMAC: `${timestamp}.${METHOD}.${pathAndQuery}.${rawBody}`. */
export function signingString(
  timestamp: string,
  method: string,
  pathAndQuery: string,
  rawBody: string,
): string {
  return `${timestamp}.${method.toUpperCase()}.${pathAndQuery}.${rawBody}`;
}

/** `sha256=<lowercase hex HMAC-SHA256(secret, signingString)>`. */
export function computeSignature(secret: string, payload: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload, 'utf8').digest('hex')}`;
}

export interface SignInput {
  secret: string;
  method: string;
  /** Request path + `?` + query exactly as sent, no host. */
  pathAndQuery: string;
  /** Raw request body; empty string for a GET. */
  body?: string;
  /** Epoch ms; defaults to now. */
  timestamp?: number;
}

/** The two auth headers for a request. */
export function signRequest(input: SignInput): Record<string, string> {
  const timestamp = String(input.timestamp ?? Date.now());
  return {
    [SYNC_TIMESTAMP_HEADER]: timestamp,
    [SYNC_SIGNATURE_HEADER]: computeSignature(
      input.secret,
      signingString(timestamp, input.method, input.pathAndQuery, input.body ?? ''),
    ),
  };
}

export interface VerifyInput {
  secret: string;
  method: string;
  pathAndQuery: string;
  body?: string;
  timestampHeader: string | null | undefined;
  signatureHeader: string | null | undefined;
  /** Epoch ms; defaults to now. */
  now?: number;
}

export type VerifyOutcome = { ok: true } | { ok: false; reason: 'malformed' | 'skew' | 'mismatch' };

/**
 * Check a signed request: timestamp within ±5 min, signature equal in constant time.
 * Every failure is a 401 to the caller; `reason` is for the receiver's own log only.
 */
export function verifySignature(input: VerifyInput): VerifyOutcome {
  const ts = input.timestampHeader ?? '';
  const sig = input.signatureHeader ?? '';
  if (!/^\d+$/.test(ts) || !/^sha256=[0-9a-f]{64}$/.test(sig) || !input.secret)
    return { ok: false, reason: 'malformed' };
  if (Math.abs((input.now ?? Date.now()) - Number(ts)) > MAX_CLOCK_SKEW_MS)
    return { ok: false, reason: 'skew' };
  const expected = computeSignature(
    input.secret,
    signingString(ts, input.method, input.pathAndQuery, input.body ?? ''),
  );
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: 'mismatch' };
}

/* ─────────────────────────── Refs ─────────────────────────── */

export type ParsedFixtureRef =
  | { tenant: string; kind: 'series'; seriesId: string; fixtureId: string }
  | { tenant: string; kind: 'recipe'; leagueKey: string; stream: string; slotId: string };

/**
 * `smartclub:<t>:fixture:<seriesId>:<fixtureId>` or the recipe form
 * `smartclub:<t>:fixture:recipe:<leagueKey>:<stream>:<slotId>`; null for anything else.
 */
export function parseFixtureRef(value: string): ParsedFixtureRef | null {
  const parts = String(value).split(':');
  if (parts[0] !== 'smartclub' || parts[2] !== 'fixture' || !parts[1]) return null;
  if (parts[3] === 'recipe' && parts.length === 7 && parts.slice(4).every(Boolean))
    return {
      tenant: parts[1],
      kind: 'recipe',
      leagueKey: parts[4],
      stream: parts[5],
      slotId: parts[6],
    };
  if (parts.length === 5 && parts[3] && parts[4])
    return { tenant: parts[1], kind: 'series', seriesId: parts[3], fixtureId: parts[4] };
  return null;
}

/** `smartclub:<t>:team:<leagueKey>:<teamId>` → its parts; null for anything else. */
export function parseTeamRef(
  value: string,
): { tenant: string; leagueKey: string; teamId: string } | null {
  const parts = String(value).split(':');
  if (parts.length !== 5 || parts[0] !== 'smartclub' || parts[2] !== 'team') return null;
  if (!parts[1] || !parts[3] || !parts[4]) return null;
  return { tenant: parts[1], leagueKey: parts[3], teamId: parts[4] };
}

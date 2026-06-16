/** Domain types shared across the API. Mirrors the frontend's data shapes. */

export type Role = 'admin' | 'rep';

export interface Membership {
  tenantId: string;
  role: Role;
  /** Clubs a rep is scoped to. Ignored for admins (who see the whole tenant). */
  clubIds: string[];
  /** When this membership was created via an admin invite (ISO). */
  invitedAt?: string;
  /** Email of the admin who issued the invite. */
  invitedBy?: string;
}

export interface UserProfile {
  sub: string;
  email: string;
  memberships: Membership[];
  onboardingSeen: Record<string, boolean>;
  /**
   * First-ever sign-in timestamp (ISO), stamped once per user lifetime by the
   * PreTokenGen trigger. Absent ⇒ the user has been invited but never signed in
   * (status 'pending'). Drives the Team & Access "Active / Not signed in" pill.
   */
  lastLoginAt?: string;
}

/**
 * An admin-defined competition a club can register for during affiliation. Lives
 * inside TenantConfig (low-cardinality, admin-managed setup data — not cohort data).
 * `key` is the stable, immutable matching token stored in `Club.leagues`.
 */
export interface League {
  key: string;
  label: string;
  group: string;
  /** A DISTRICTS value, or the 'All districts' sentinel for overarching leagues. */
  district: string;
  note?: string;
}

export interface TenantConfig {
  tenant: string;
  branding: {
    name: string;
    /** Human title for <title> and headers, e.g. "Dolphins Pipeline". */
    title: string;
    logoUrl: string;
    /** CSS color tokens injected at the edge, e.g. { '--navy': '#1B2A4A' }. */
    colors: Record<string, string>;
    /** Org copy strings keyed by slot (welcome, eyebrow, office, footer, support). */
    copy: Record<string, string>;
  };
  submissionDeadline: string;
  knownClubs: unknown[];
  /**
   * Pointer to the tenant-wide club self-signup token (TOKEN# item, kind 'club-signup').
   * Single active link per tenant; regenerating revokes the prior token. Written ONLY via
   * repo.updateClubSignupLink (targeted update) — PUT /tenant/config strips it from patches
   * so a concurrent Settings save can't resurrect a revoked link.
   */
  clubSignupLink?: { token: string; createdAt: string };
  /** Admin-managed league catalogue clubs opt into. Empty for a fresh tenant. */
  leagues?: League[];
  /** Optional per-tenant required-docs override; falls back to shared default. */
  requiredDocs?: unknown[];
  /**
   * Authoritative count of admins for this tenant, maintained transactionally on
   * the CONFIG item so the last-admin lockout guard is race-free (no TOCTOU on a
   * point-in-time list). Absent on legacy tenants → lazily backfilled by
   * repo.recountAdmins from authoritative memberships before the guard runs.
   */
  adminCount?: number;
}

/** Stored club record. Catalogue-derived fields stay client-side. */
export interface Club {
  id: string;
  name: string;
  district: string;
  sub: string;
  chair: string;
  affiliation: 'not_started' | 'in_progress' | 'complete';
  cqi: number;
  cqiAnswers?: Record<string, unknown>;
  docs: Record<string, boolean>;
  /**
   * Per-doc upload metadata, keyed by doc key. Single-file docs store one
   * `{ objectKey, size, contentType?, uploadedAt }` object (or an admin
   * `{ markedCompliant, at }` sentinel). Safeguarding is multi-file and stores
   * `{ files: [...entries], markedCompliant?, at? }` — see safeguardingMeta.
   */
  docMeta?: Record<string, unknown>;
  /** Surfaced as `players` on read; derived from registrations. */
  players: number;
  /** Denormalized registration count, bumped atomically on each registration. */
  playerCount?: number;
  teams: number;
  women: number;
  juniors: number;
  color: string;
  ground: {
    venue?: string;
    address?: string;
    suburb?: string;
    lat?: number;
    lon?: number;
    /** Optional second home venue (input only — no map/coords). Used for fixture venue selection. */
    secondaryVenue?: string;
    secondaryAddress?: string;
  };
  leagues: string[];
  /**
   * Office bearers. `exco.chair` carries the chair's contact plus governance
   * fields `idNumber`, `termStart`, `termEnd` (ISO dates) captured on the
   * affiliation form; other roles carry name/cell/email/gender/race.
   */
  exco?: Record<string, unknown>;
  /**
   * Coaches by league. Each entry additionally carries `idNumber`, `yearStarted`
   * (year as number/string) and `yearsExperience` ('0-3' | '4-10' | '10+').
   */
  coaches?: unknown[];
  /**
   * Set when a rep edits an already-complete affiliation form (corrections);
   * cleared by an admin re-confirming. The form is no longer hard-locked.
   */
  amendmentPending?: boolean;
  /** Admin communication-log notes, appended newest-last via list_append. */
  notes?: { id: string; text: string; author: string; at: string }[];
  /** Real onboarding-invite send events (email/WhatsApp), appended via list_append. */
  commLog?: ClubCommEvent[];
  /** Whether the chair opted into deadline reminders during onboarding (no cron yet). */
  remindersOptIn?: boolean;
  playerRegLink?: { token: string; createdAt: string };
  /** Marks a club loaded from the demo snapshot; gates illustrative-only UI (e.g. seeded comm-log events). */
  demo?: boolean;
  onboardedAt?: string;
  /** Provenance: set when the club was created via the public signup link, not by an admin. */
  onboardedVia?: 'self-signup';
  /** When the signing-up rep ticked the POPIA consent line (ISO). Only on self-signups. */
  signupConsentAt?: string;
  /** Optimistic-concurrency version + audit trail. */
  version: number;
  changedBy?: string;
  changedAt?: string;
}

/** Outbound invite channels. */
export type Channel = 'email' | 'whatsapp';

/** Per-channel outcome of an invite send (returned to the client + stored on the marker). */
export interface SendResult {
  channel: Channel;
  status: 'sent' | 'failed' | 'skipped';
  /** Recipient the send targeted (email / E.164 cell). Omitted on a skip with no value on file. */
  to?: string;
  messageId?: string;
  /** Reason a send did not succeed (validation skip or provider error). Never set on success. */
  error?: string;
  /** Aggregate, human-readable outcome for a broadcast summary row (e.g. "8 sent · 2 skipped"). */
  summary?: string;
}

/** One real outbound send (onboarding invite or fixtures broadcast), recorded in the club's comm log. */
export interface ClubCommEvent {
  id: string;
  channel: 'email' | 'whatsapp';
  /** Recipient the send targeted (email / E.164 cell). Omitted on a skip with no value on file, and on broadcast summaries (which never name an individual). */
  to?: string;
  status: 'sent' | 'failed' | 'skipped';
  /** Provider message id when sent (SES MessageId / Meta message id). */
  messageId?: string;
  /** Reason when not sent (validation skip or provider error). */
  error?: string;
  at: string;
  by: string;
  /** Ties the event back to the idempotency-keyed send attempt. */
  idempotencyKey: string;
  /**
   * What was sent. Absent ⇒ 'invite' (back-compat with pre-existing rows). A 'fixtures'
   * broadcast is recorded as one PII-free summary event per channel, not one row per player.
   */
  kind?: 'invite' | 'fixtures' | 'reglink';
  /** Aggregate, PII-free outcome for a broadcast send, e.g. "8 sent · 2 skipped" (sent · skipped · failed; zero parts omitted). */
  summary?: string;
}

/** Onboard payload: a Club plus the flat chair contact fields the admin form sends. */
export type ClubSpec = Partial<Club> & {
  chairEmail?: string;
  chairCell?: string;
};

export interface Series {
  id: string;
  name: string;
  startDate: string;
  endDate?: string; // optional; when set, may drive scheduling (see dateMode)
  dateMode?: 'spread' | 'reference'; // how endDate is used: spread rounds vs display only
  teams: string[];
  fixtures: unknown[];
  /** Admin sign-off gate: a series can only be released once approved. Editing a fixture clears it. */
  approved?: boolean;
  approvedAt?: string | null;
  released: boolean;
  releasedAt: string | null;
  version: number;
  [key: string]: unknown;
}

/** Stored object metadata for a player's uploaded ID document (parallels club docMeta). */
export interface PlayerIdDocMeta {
  objectKey: string;
  size: number;
  uploadedAt: string;
  /** MIME type the file was signed/stored as (ID docs allow image/* or PDF). */
  contentType?: string;
}

export type PlayerStatus = 'active' | 'clearance-pending' | 'inactive';

export interface PlayerRegistration {
  naturalKey: string;
  clubId: string;
  firstName: string;
  lastName: string;
  dob: string;
  cell?: string;
  email?: string;
  isMinor: boolean;
  guardianName?: string;
  consentAt: string;
  createdAt: string;
  // ── Official Union registration fields ──
  // All optional: absent on legacy rows and on public-link self-registrations,
  // which collect only the minimal POPIA-consent set. The in-portal chair form
  // (POST /clubs/:id/players) populates them.
  /** 13-digit RSA ID. `dob` is derived from it on the portal path. */
  idNumber?: string;
  race?: string;
  gender?: string;
  postalAddress?: string;
  postalCode?: string;
  /** League key the player is registered for (e.g. a 'Premier Men' catalogue key). */
  team?: string;
  district?: string;
  /** Club the player was last registered for ('—' if first registration). */
  lastClub?: string;
  battingHand?: 'Right' | 'Left';
  bowlingHand?: 'Right' | 'Left';
  battingType?: string;
  /** Empty string ⇒ not a bowler. */
  bowlerType?: string;
  isAllRounder?: boolean;
  isWk?: boolean;
  idDocMeta?: PlayerIdDocMeta;
  /** Roster lifecycle. Absent ⇒ treated as 'active'. */
  status?: PlayerStatus;
  /** Email of the chair/admin who registered the player via the portal. */
  registeredBy?: string;
  /** Which path created the row. Absent ⇒ 'link' (back-compat with pre-existing rows). */
  registeredVia?: 'link' | 'portal';
  /**
   * Optimistic-concurrency version for portal/admin edits and the clearance move.
   * Absent on legacy rows → treated as 0 (same convention as Club.version).
   */
  version?: number;
}

export type ClearanceStatus = 'pending' | 'approved' | 'admin-override';

/**
 * An inter-club transfer/clearance request. Stored as TWO items written together:
 * the canonical item under the SOURCE club (sk `CLEARANCE#<id>`, carries the gsi1
 * entry so admins list every request in one query) and a mirror under the
 * DESTINATION club (sk `INBOUND_CLEARANCE#<id>`, no gsi1) so each club reads only
 * its own partition — never a tenant-wide scan. The source club confirms fees +
 * misconduct (no time limit); the union office may override and approve any pending
 * request on the source club's behalf.
 */
export interface PlayerClearance {
  id: string;
  playerNaturalKey: string;
  /** Denormalized "First Last" for display + audit (survives the player move). */
  playerName: string;
  idNumber?: string;
  team?: string;
  fromClubId: string;
  toClubId: string;
  fromClubName: string;
  toClubName: string;
  requestedAt: string;
  /** Email of the destination-club rep who initiated the request. */
  requestedBy?: string;
  note?: string;
  feesCleared: boolean;
  misconductCleared: boolean;
  status: ClearanceStatus;
  clubApprovedAt?: string | null;
  adminOverrideAt?: string | null;
  version: number;
}

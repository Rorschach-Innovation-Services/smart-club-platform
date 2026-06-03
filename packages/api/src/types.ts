/** Domain types shared across the API. Mirrors the frontend's data shapes. */

export type Role = 'admin' | 'rep';

export interface Membership {
  tenantId: string;
  role: Role;
  /** Clubs a rep is scoped to. Ignored for admins (who see the whole tenant). */
  clubIds: string[];
}

export interface UserProfile {
  sub: string;
  email: string;
  memberships: Membership[];
  onboardingSeen: Record<string, boolean>;
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
  /** Admin-managed league catalogue clubs opt into. Empty for a fresh tenant. */
  leagues?: League[];
  /** Optional per-tenant required-docs override; falls back to shared default. */
  requiredDocs?: unknown[];
}

/** Stored club record. Catalogue-derived fields stay client-side. */
export interface Club {
  id: string;
  name: string;
  district: string;
  sub: string;
  chair: string;
  affiliation: 'not_started' | 'in_progress' | 'complete';
  paid: boolean;
  /**
   * Per-club journey gate. 'submission' (default): the journey advances once the
   * affiliation form is submitted. 'payment': Fixtures stay locked until an admin
   * also marks the club paid. Display of "submitted" status is unaffected by this.
   */
  progressionMode?: 'submission' | 'payment';
  cqi: number;
  cqiAnswers?: Record<string, unknown>;
  docs: Record<string, boolean>;
  /** Per-doc upload metadata (objectKey, size, uploadedAt), keyed by doc key. */
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
  };
  leagues: string[];
  exco?: Record<string, unknown>;
  coaches?: unknown[];
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
  kind?: 'invite' | 'fixtures';
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
  released: boolean;
  releasedAt: string | null;
  version: number;
  [key: string]: unknown;
}

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
}

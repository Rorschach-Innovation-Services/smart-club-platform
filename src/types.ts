/**
 * Frontend domain types.
 *
 * CANONICAL SOURCE: packages/api/src/types.ts — the backend owns these shapes.
 * This is a deliberate hand-port (the repo is not an npm workspace and the api
 * package has no build output, so a cross-package `import type` isn't viable).
 * Keep this file in sync when the API contract changes. Future consolidation:
 * extract a `packages/shared` both sides depend on (see migration plan).
 *
 * DELIBERATE DIVERGENCE from the backend: fields the server authoritatively
 * produces but the client doesn't always have on hand (e.g. demo SAMPLE_CLUBS
 * literals, optimistic-concurrency `version`) are marked OPTIONAL here even where
 * the backend requires them. Such fields are annotated `// server-authoritative`.
 */

export type Role = 'admin' | 'rep';

export interface Membership {
  tenantId: string;
  role: Role;
  /** Clubs a rep is scoped to. Ignored for admins (who see the whole tenant). */
  clubIds: string[];
  invitedAt?: string;
  invitedBy?: string;
}

export interface UserProfile {
  sub: string;
  email: string;
  memberships: Membership[];
  onboardingSeen: Record<string, boolean>;
  /** First-ever sign-in (ISO). Absent ⇒ invited but never signed in ('pending'). */
  lastLoginAt?: string;
}

/** An admin-defined competition a club can register for during affiliation. */
export interface League {
  key: string;
  label: string;
  group: string;
  /** A DISTRICTS value, or the 'All districts' sentinel for overarching leagues. */
  district: string;
  note?: string;
}

/** A short how-to-use-the-app tutorial video, surfaced on the public /tutorials page. */
export interface TutorialVideo {
  title: string;
  url: string;
  poster?: string;
}

export interface TenantConfig {
  tenant: string;
  branding: {
    name: string;
    title: string;
    logoUrl: string;
    /** CSS color tokens injected at the edge, e.g. { '--navy': '#1B2A4A' }. */
    colors: Record<string, string>;
    /** Org copy strings keyed by slot (welcome, eyebrow, office, footer, support). */
    copy: Record<string, string>;
  };
  submissionDeadline: string;
  knownClubs: unknown[];
  clubSignupLink?: { token: string; createdAt: string };
  leagues?: League[];
  requiredDocs?: unknown[];
  adminCount?: number;
  tutorials?: TutorialVideo[];
}

/** A club's home/secondary ground. */
export interface ClubGround {
  venue?: string;
  address?: string;
  suburb?: string;
  lat?: number;
  lon?: number;
  secondaryVenue?: string;
  secondaryAddress?: string;
}

/** A note appended to a club's admin communication log. */
export interface ClubNote {
  id: string;
  text: string;
  author: string;
  at: string;
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
  /** Per-doc upload metadata, keyed by doc key (single-file object or multi-file `{ files }`). */
  docMeta?: Record<string, unknown>;
  players: number;
  playerCount?: number; // server-authoritative (denormalized count)
  teams: number;
  women: number;
  juniors: number;
  color: string;
  ground: ClubGround;
  leagues?: string[]; // server-authoritative (omitted by demo SAMPLE_CLUBS)
  /** Office bearers; `exco.chair` carries chair contact + governance fields. */
  exco?: Record<string, unknown>;
  /** Coaches by league; entries carry idNumber/yearStarted/yearsExperience. */
  coaches?: unknown[];
  amendmentPending?: boolean;
  notes?: ClubNote[];
  commLog?: ClubCommEvent[];
  remindersOptIn?: boolean;
  playerRegLink?: { token: string; createdAt: string };
  /** Marks a club loaded from the demo snapshot; gates illustrative-only UI. */
  demo?: boolean;
  onboardedAt?: string;
  onboardedVia?: 'self-signup';
  signupConsentAt?: string;
  version?: number; // server-authoritative (optimistic-concurrency)
  changedBy?: string;
  changedAt?: string;
}

/** Onboard payload: a Club plus the flat chair contact fields the admin form sends. */
export type ClubSpec = Partial<Club> & {
  chairEmail?: string;
  chairCell?: string;
};

/** Outbound invite channels. */
export type Channel = 'email' | 'whatsapp';

/** Per-channel outcome of an invite send (returned to the client + stored on the marker). */
export interface SendResult {
  channel: Channel;
  status: 'sent' | 'failed' | 'skipped';
  to?: string;
  messageId?: string;
  error?: string;
  summary?: string;
}

/** One real outbound send (onboarding invite or fixtures broadcast). */
export interface ClubCommEvent {
  id: string;
  channel: Channel;
  to?: string;
  status: 'sent' | 'failed' | 'skipped';
  messageId?: string;
  error?: string;
  at: string;
  by: string;
  idempotencyKey: string;
  kind?: 'invite' | 'fixtures' | 'reglink';
  summary?: string;
}

export interface Series {
  id: string;
  name: string;
  startDate: string;
  endDate?: string;
  dateMode?: 'spread' | 'reference';
  teams: string[];
  fixtures: unknown[];
  approved?: boolean;
  approvedAt?: string | null;
  released: boolean;
  releasedAt: string | null;
  version: number;
  [key: string]: unknown;
}

/** Stored object metadata for a player's uploaded ID document. */
export interface PlayerIdDocMeta {
  objectKey: string;
  size: number;
  uploadedAt: string;
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
  // Official Union registration fields — all optional (absent on legacy rows and
  // public-link self-registrations; populated by the in-portal chair form).
  idNumber?: string;
  race?: string;
  gender?: string;
  postalAddress?: string;
  postalCode?: string;
  team?: string;
  district?: string;
  lastClub?: string;
  battingHand?: 'Right' | 'Left';
  bowlingHand?: 'Right' | 'Left';
  battingType?: string;
  bowlerType?: string;
  isAllRounder?: boolean;
  isWk?: boolean;
  idDocMeta?: PlayerIdDocMeta;
  status?: PlayerStatus;
  registeredBy?: string;
  registeredVia?: 'link' | 'portal';
  version?: number;
}

export type ClearanceStatus = 'pending' | 'approved' | 'admin-override';

/** An inter-club transfer/clearance request. */
export interface PlayerClearance {
  id: string;
  playerNaturalKey: string;
  playerName: string;
  idNumber?: string;
  team?: string;
  fromClubId: string;
  toClubId: string;
  fromClubName: string;
  toClubName: string;
  requestedAt: string;
  requestedBy?: string;
  note?: string;
  feesCleared: boolean;
  misconductCleared: boolean;
  status: ClearanceStatus;
  clubApprovedAt?: string | null;
  adminOverrideAt?: string | null;
  version: number;
}

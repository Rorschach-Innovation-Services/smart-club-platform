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
 * produces but the client doesn't always have on hand (e.g. optimistic-concurrency
 * `version`) are marked OPTIONAL here even where the backend requires them. Such
 * fields are annotated `// server-authoritative`.
 */

export type Role = 'admin' | 'rep' | 'operator';

/**
 * Sentinel tenantId for the platform-operator membership `{tenantId: '*',
 * role: 'operator'}` — grants the cross-tenant /platform/* portal, never a
 * tenant console. Mirrors PLATFORM_TENANT in packages/api/src/types.ts.
 */
export const PLATFORM_TENANT = '*';

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

/**
 * Org copy strings keyed by slot. All optional — resolveCopy (src/branding.ts)
 * supplies the fallback chain. Stays a string map on disk (index signature) so
 * legacy `branding.copy.support`-style access keeps working.
 */
export interface BrandingCopy {
  welcome?: string;
  eyebrow?: string;
  office?: string;
  admin?: string;
  support?: string;
  footer?: string;
  orgShort?: string;
  cohortName?: string;
  heroTitle?: string;
  heroBlurb?: string;
  crumbRoot?: string;
  [slot: string]: string | undefined;
}

export interface TenantBranding {
  name: string;
  title: string;
  logoUrl: string;
  /** Favicon override; applyTheme falls back to logoUrl when absent. */
  faviconUrl?: string;
  /**
   * CSS theme tokens injected at runtime. Canonical keys are the semantic ROLE tokens
   * (--brand-primary, --brand-accent, --hero-image …, see src/platform-theme.ts); legacy
   * value-named keys (--green …) still render via the alias layer in index.html.
   */
  colors: Record<string, string>;
  /** Optional per-tenant typeface; applyTheme sets --brand-font and injects the web font. */
  font?: { family: string; url?: string };
  copy: BrandingCopy;
}

export interface TenantConfig {
  tenant: string;
  branding: TenantBranding;
  /** Per-tenant feature flags (e.g. whatsappInvites). Absent key ⇒ caller default. */
  features?: Record<string, boolean>;
  submissionDeadline: string;
  knownClubs: unknown[];
  clubSignupLink?: { token: string; createdAt: string };
  leagues?: League[];
  /**
   * Operator-managed district list. Absent ⇒ frontend falls back to the shared
   * DISTRICTS constant (data.ts); [] ⇒ new client awaiting operator setup.
   */
  districts?: string[];
  requiredDocs?: unknown[];
  adminCount?: number;
  tutorials?: TutorialVideo[];
  /** Operator "setup complete" milestone (D6). Present ⇒ setup marked done. */
  setupCompletedAt?: string;
  setupCompletedBy?: string;
}

/** One row of GET /platform/tenants — a registry projection, not the full config. */
export interface TenantSummary {
  tenant: string;
  name: string;
  title: string;
  logoUrl: string;
  submissionDeadline: string;
  adminCount: number;
  features: Record<string, boolean>;
  /** Present ⇒ operator marked setup done; absent ⇒ still in setup. Drives the list chip. */
  setupCompletedAt?: string;
  /** Fleet rollup counts. Optional: react-query rows cached before the rollup shipped lack them. */
  clubCount?: number;
  teamCount?: number;
  playerCount?: number;
}

/**
 * Cross-tenant-safe club projection served by GET /platform/tenants/:slug/overview.
 * A deliberate allowlist — no exco/chair contacts, coach ID numbers, notes, comm log,
 * doc metadata, CQI answers, or live registration tokens ever cross the operator
 * surface. The full admin Club satisfies this shape structurally, so InsightsBreakdown
 * (src/insights.tsx) accepts both.
 */
export interface InsightsClub {
  id: string;
  name: string;
  district: string;
  affiliation: 'not_started' | 'in_progress' | 'complete';
  cqi: number;
  docs: Record<string, boolean>;
  /** Denormalized registered-player count. */
  players: number;
  leagues?: string[];
  leagueTeams?: Record<string, number>;
}

/** GET /platform/tenants/:slug/overview — exactly what the operator breakdown renders. */
export interface TenantOverview {
  tenant: string;
  name: string;
  leagues: League[];
  districts: string[];
  clubs: InsightsClub[];
  clearances: Array<{ status: ClearanceStatus }>;
}

/** Presigned-POST grant from POST /platform/tenants/:slug/logo-upload. */
export interface LogoUploadPost {
  url: string;
  fields: Record<string, string>;
  objectKey: string;
  publicUrl: string;
}

/** GET /platform/tenants/:slug/dns — the vanity-domain go-live instruction sheet. */
export interface DnsRecord {
  type: 'CNAME';
  host: string;
  target: string;
}
export interface DnsStep {
  key: string;
  title: string;
  detail: string;
  records?: DnsRecord[];
}
export interface DnsSheet {
  tenant: string;
  /** Where the client is already reachable (wildcard host, or vanity origin). */
  liveUrl: string | null;
  note: string;
  steps: DnsStep[];
  /** The one shared API host every tenant uses (informational). */
  sharedApiHost?: string;
  sharedApiTarget?: string;
}

/**
 * A named side a club fields in a league when it enters >1 team there
 * (`leagueTeams[key] >= 2`). `id` uses the reserved `tm_` prefix so the teamId
 * namespace never collides with a bare clubId. Single-team leagues have no roster
 * (the club is the team; `teamId === clubId`).
 */
export interface ClubTeam {
  id: string; // `tm_${shortId}`
  name: string; // "Glenwood A", 1–80 chars
  venue?: string; // optional home-ground override; absent ⇒ club ground
  address?: string;
  lat?: number;
  lon?: number;
}

/** Reserved prefix every generated team id carries (clubIds never have it). */
export const TEAM_ID_PREFIX = 'tm_';

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
  leagues?: string[]; // server-authoritative (may be absent on legacy client records)
  /** Teams entered per league key (a club may field >1 side in a league); absent ⇒ 1. */
  leagueTeams?: Record<string, number>;
  /**
   * Named sides per league key, present ONLY for leagues with `leagueTeams[key] >= 2`.
   * Roster length tracks the count; ids are stable (`tm_…`). A count-1 league has no
   * entry — the club is its own single team.
   */
  teamRosters?: Record<string, ClubTeam[]>;
  /** Office bearers; `exco.chair` carries chair contact + governance fields. */
  exco?: Record<string, unknown>;
  /** Coaches by league; entries carry idNumber/yearStarted/yearsExperience. */
  coaches?: unknown[];
  amendmentPending?: boolean;
  /** Set when a rep renames the club (change applies live, flagged for admin review). */
  nameChangePending?: boolean;
  /** Name prior to a flagged rep rename — drives the admin "Renamed from …" pill. */
  previousName?: string;
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

export type PlayerStatus = 'active' | 'clearance-pending' | 'inactive' | 'clearance-rejected';

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
  // SA citizens give a 13-digit RSA ID (dob derived from it); non-SA citizens give a
  // passport/visa number + a manually-entered dob. `idType` defaults to 'sa-id'.
  idType?: 'sa-id' | 'passport';
  idNumber?: string;
  /** Player nationality (demonym, e.g. 'South African'); defaults to 'South African' for SA-ID registrants. */
  nationality?: string;
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
  /** Previous club's vetted ID doc, carried over when a registration-origin clearance is approved. */
  previousIdDocMeta?: PlayerIdDocMeta;
  status?: PlayerStatus;
  /** Set when a registration-origin clearance was rejected; meaningful only while status is 'clearance-rejected'. */
  clearanceRejectedAt?: string;
  clearanceRejectedReason?: string;
  registeredBy?: string;
  registeredVia?: 'link' | 'portal';
  version?: number;
}

export type ClearanceStatus = 'pending' | 'approved' | 'admin-override' | 'rejected';

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
  /** 'registration' ⇒ opened by the public registration page; absent ⇒ rep-initiated request. */
  origin?: 'registration' | 'request';
  feesCleared: boolean;
  misconductCleared: boolean;
  status: ClearanceStatus;
  clubApprovedAt?: string | null;
  adminOverrideAt?: string | null;
  rejectedAt?: string | null;
  rejectedBy?: string;
  rejectReason?: string;
  version: number;
}

export type RegistrationReviewKind = 'off-system-alert' | 'cross-club-hold';
export type RegistrationReviewStatus = 'open' | 'resolved';
export type RegistrationReviewResolution = 'acknowledged' | 'accepted' | 'declined';

/**
 * A self-registration needing a human look. `off-system-alert` = admin-only FYI that a
 * player named an off-system previous club (row already active). `cross-club-hold` = a
 * registration that chose a different club than the link, parked (no row yet) for the
 * destination chair to accept/decline. Mirror of the backend type.
 */
export interface RegistrationReview {
  id: string;
  kind: RegistrationReviewKind;
  playerNaturalKey: string;
  playerName: string;
  idNumber?: string;
  destClubId: string;
  destClubName: string;
  linkClubId: string;
  linkClubName: string;
  typedPreviousClub?: string;
  previousClubName?: string;
  /** Present only on open cross-club holds (self-asserted; the chair needs it to decide). */
  pendingPlayer?: PlayerRegistration;
  pendingLastClubId?: string;
  createdAt: string;
  status: RegistrationReviewStatus;
  resolution?: RegistrationReviewResolution;
  resolvedAt?: string;
  resolvedBy?: string;
  version: number;
}

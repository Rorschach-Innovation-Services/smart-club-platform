/** Domain types shared across the API. Mirrors the frontend's data shapes. */

export type Role = 'admin' | 'rep' | 'operator';

/**
 * Sentinel tenantId for the PLATFORM membership `{tenantId: '*', role: 'operator'}`.
 * It can never collide with tenant access: resolveTenant never yields '*',
 * requireTenantMembership matches an exact tenantId, and the repo layer skips
 * TENANT# markers for it (see reconcileUserMarkers) so an operator is never
 * listable inside any tenant's roster.
 */
export const PLATFORM_TENANT = '*';

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

/**
 * A named side a club fields in a league when it enters more than one team there
 * (`Club.leagueTeams[key] >= 2`). Each carries a stable, generated `id` so coach
 * links and fixture references survive renames/reorders within the form.
 *
 * `id` MUST use the reserved `tm_` prefix so the teamId namespace can never collide
 * with a bare `clubId` slug (e.g. 'ukzn'). A single-team league has NO roster: the
 * club itself is the team and `teamId === clubId`.
 */
export interface ClubTeam {
  /** `tm_${shortId}` — reserved prefix, never equal to a clubId. */
  id: string;
  /** Display name, e.g. "Glenwood A". 1–80 chars. */
  name: string;
  /** Optional home-ground override; absent ⇒ the club ground. */
  venue?: string;
  address?: string;
  /** Optional pin; absent ⇒ club ground coords are used for travel cost. */
  lat?: number;
  lon?: number;
}

/** The reserved prefix every generated team id carries (clubIds never have it). */
export const TEAM_ID_PREFIX = 'tm_';

/**
 * A short how-to-use-the-app tutorial video, surfaced on the public /tutorials page
 * and linked from the chair's onboarding email. `url` may be a site-relative path
 * (e.g. '/tutorials/01-getting-started.mp4', served by the StaticSite CDN) or an
 * absolute URL; link builders resolve relative paths against the tenant host.
 */
export interface TutorialVideo {
  title: string;
  url: string;
  /** Optional poster image shown before play. */
  poster?: string;
}

/**
 * Named org-copy slots on `branding.copy`. All optional — resolution falls back
 * through `orgCopy()` (branding.ts), so a tenant row never needs every slot. Kept
 * as a string map on disk (`BrandingCopy & Record<string, string>`) so ad-hoc
 * slots survive round-trips without a shape migration.
 */
export interface BrandingCopy {
  welcome?: string;
  eyebrow?: string;
  office?: string;
  admin?: string;
  support?: string;
  footer?: string;
  /** Short org handle for compound copy, e.g. "Dolphins" → "Dolphins office". */
  orgShort?: string;
  /** Full cohort label, e.g. "Dolphins Pipeline cohort". */
  cohortName?: string;
  heroTitle?: string;
  heroBlurb?: string;
  /** Breadcrumb root, e.g. "Dolphins" in "Dolphins · Admin Console / …". */
  crumbRoot?: string;
}

/** An entry in the operator-managed club directory (TenantConfig.knownClubs). */
export interface DirectoryClub {
  /** Stable slug (clubIdFromName) — doubles as a clearance source partition. */
  id: string;
  name: string;
}

export interface TenantConfig {
  tenant: string;
  branding: {
    name: string;
    /** Human title for <title> and headers, e.g. "Dolphins Pipeline". */
    title: string;
    logoUrl: string;
    /** Browser-tab icon; absent ⇒ the frontend falls back to logoUrl. */
    faviconUrl?: string;
    /** CSS color tokens injected at the edge, e.g. { '--navy': '#1B2A4A' }. */
    colors: Record<string, string>;
    /** Org copy strings keyed by slot — named slots typed, extras allowed. */
    copy: BrandingCopy & Record<string, string>;
  };
  submissionDeadline: string;
  /**
   * Operator-managed directory of real-world clubs not yet registered on the
   * system. Merged (deduped, real club wins) into the previous-club dropdown on
   * public player registration; a directory pick opens a real pending clearance
   * from `id` (see PlayerClearance.fromClubDirectory). `id` is derived
   * server-side from the name at save time and persisted so a later rename can
   * never orphan a pending clearance's partition. Operator-only: PUT
   * /tenant/config strips it (ADR 0006), only PUT /platform/tenants/:slug
   * writes it. Legacy rows hold [].
   */
  knownClubs: DirectoryClub[];
  /**
   * Pointer to the tenant-wide club self-signup token (TOKEN# item, kind 'club-signup').
   * Single active link per tenant; regenerating revokes the prior token. Written ONLY via
   * repo.updateClubSignupLink (targeted update) — PUT /tenant/config strips it from patches
   * so a concurrent Settings save can't resurrect a revoked link.
   */
  clubSignupLink?: { token: string; createdAt: string };
  /** Admin-managed league catalogue clubs opt into. Empty for a fresh tenant. */
  leagues?: League[];
  /**
   * Operator-managed district list clubs pick during signup/affiliation and leagues
   * are filed under. Absent ⇒ DEFAULT_DISTRICTS fallback at read time (legacy tenants,
   * no backfill); [] ⇒ freshly created client — club signup is blocked until the
   * operator configures districts. Operator-only: PUT /tenant/config strips it
   * (ADR 0006), only PUT /platform/tenants/:slug writes it.
   */
  districts?: string[];
  /** Optional per-tenant required-docs override; falls back to shared default. */
  requiredDocs?: unknown[];
  /**
   * Authoritative count of admins for this tenant, maintained transactionally on
   * the CONFIG item so the last-admin lockout guard is race-free (no TOCTOU on a
   * point-in-time list). Absent on legacy tenants → lazily backfilled by
   * repo.recountAdmins from authoritative memberships before the guard runs.
   */
  adminCount?: number;
  /**
   * Per-tenant how-to-use-the-app tutorial videos, shown on the public /tutorials
   * page and linked in the chair onboarding email. Absent ⇒ the shared
   * DEFAULT_TUTORIALS fallback is used (so existing rows need no migration).
   */
  tutorials?: TutorialVideo[];
  /**
   * Per-tenant feature flags, read via hasFeature() (features.ts) so each flag
   * carries its own default. Known flags: 'whatsappInvites' (default TRUE —
   * shared WABA templates are dolphins-flavored, so new clients launch
   * email-only), 'selfServeBranding' (reserved, default false).
   */
  features?: Record<string, boolean>;
  /**
   * Operator "setup complete" milestone (D6) — informational only (the client is
   * publicly live from creation and every setting stays editable). Present ⇒ an
   * operator marked setup done; absent ⇒ still in setup. Stamped/cleared ONLY via
   * POST/DELETE /platform/tenants/:slug/setup-complete, never the config merge-patch.
   */
  setupCompletedAt?: string;
  setupCompletedBy?: string;
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
  /** Teams entered per league key (a club may field >1 side in a league); absent ⇒ 1. */
  leagueTeams?: Record<string, number>;
  /**
   * Named sides per league key, present ONLY for leagues with `leagueTeams[key] >= 2`.
   * Roster length tracks the count; ids are stable (`tm_…`). A count-1 league has no
   * entry here — the club is its own single team. Drives fixture participants and
   * per-team coach assignment.
   */
  teamRosters?: Record<string, ClubTeam[]>;
  /**
   * Office bearers. `exco.chair` carries the chair's contact plus governance
   * fields `idNumber`, `termStart`, `termEnd` (ISO dates) captured on the affiliation
   * form; other roles carry name/cell/email/gender/race. `reasonForInvolvement` is
   * legacy — chairperson motivation is now a multi-select captured on the CQI form as
   * `cqiAnswers.involvementReasons: string[]` (one or more of INVOLVEMENT_REASONS).
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
  /**
   * Set when a rep renames the club (the change applies immediately but is flagged
   * for admin review); cleared by an admin acknowledging. Admin renames never set it.
   */
  nameChangePending?: boolean;
  /** The club name prior to a flagged rep rename — drives the admin "Renamed from …" pill. */
  previousName?: string;
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
  /** When the rep submitted the self-signup (implied POPIA consent, ISO). Only on self-signups. */
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

/**
 * One admin export of the cross-club player register. A best-effort, tenant-scoped
 * record of the event (who / when / how many rows / which scope) — NOT an authoritative
 * PII-access trail: the .xlsx is built in the browser from rosters already fetched, and the
 * client reports this after the fact, so the counts are client-asserted and the write is
 * bypassable. It is a compliance intent-signal, not proof of access. The register fetch
 * itself is the server-observed access boundary if a definitive trail is ever required.
 */
export interface ExportLogEntry {
  id: string;
  kind: 'player-export';
  /** Human-readable actor (caller email), mirroring notes[].author / commLog[].by. */
  by: string;
  /** Stable Cognito sub of the actor. */
  sub?: string;
  at: string;
  rowCount: number;
  /** Whether the admin exported the whole register or the current filtered selection. */
  scope: 'all' | 'filtered';
  /**
   * Number of club rosters that failed to load at export time (>0 ⇒ the file may be partial —
   * some rosters were missing when the rows were gathered; applies to filtered exports too, as
   * both draw from the same cross-club set). Recorded so the trail never reads a truncated
   * register as a clean export.
   */
  erroredClubs?: number;
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
  /**
   * Participant ids. A participant is a *team*, not a club: for a single-team club
   * `teamId === clubId` (legacy-compatible); for a multi-team club these are `tm_…`
   * ids. Fixtures' `home`/`away` reference these. Resolve back to a club via
   * `participants`.
   */
  teams: string[];
  /**
   * Self-contained snapshot mapping each `teams[]` id → its club, display name and
   * travel coords, captured at series-creation time. Authoritative for rendering and
   * cost so a later roster edit (rename/shrink/league removal) never orphans a live
   * series. Absent ⇒ legacy series where every `teams[]` id is a clubId.
   */
  participants?: Array<{
    teamId: string;
    clubId: string;
    name: string;
    /** Resolved home-venue label at creation (team override or club ground). */
    venue?: string;
    lat?: number;
    lon?: number;
  }>;
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
  // ── Official Union registration fields ──
  // All optional: absent on legacy rows and on public-link self-registrations,
  // which collect only the minimal POPIA-consent set. The in-portal chair form
  // (POST /clubs/:id/players) populates them.
  /**
   * SA citizens: a 13-digit RSA ID, with `dob` derived from it server-side. Non-SA
   * citizens: `idType: 'passport'` and a passport/visa number, with `dob` taken from
   * the client (no oracle exists to derive it). `idType` defaults to 'sa-id'.
   */
  idType?: 'sa-id' | 'passport';
  idNumber?: string;
  /** Player nationality (demonym); defaults to 'South African' for SA-ID registrants. */
  nationality?: string;
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
  /**
   * The vetted ID document from the player's PREVIOUS club, carried onto the
   * destination record when a registration-origin clearance is approved. The
   * fresh registration's own `idDocMeta` is self-asserted; this preserves the
   * source club's evidence of the original identity.
   */
  previousIdDocMeta?: PlayerIdDocMeta;
  /** Roster lifecycle. Absent ⇒ treated as 'active'. */
  status?: PlayerStatus;
  /**
   * Set when a registration-origin clearance was REJECTED: the player stays on this
   * (current) club's roster flagged 'clearance-rejected' instead of reverting to the
   * previous club. Meaningful ONLY while status === 'clearance-rejected' — cleared on
   * any later activation (see resolveClearance). `lastClub` holds the previous club name.
   */
  clearanceRejectedAt?: string;
  clearanceRejectedReason?: string;
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

export type ClearanceStatus = 'pending' | 'approved' | 'admin-override' | 'rejected';

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
  /**
   * How the clearance came to exist. 'registration' ⇒ opened automatically by the
   * public registration page (the destination player row already exists, status
   * 'clearance-pending', with self-asserted data). Absent ⇒ 'request'
   * (destination-rep initiated; the destination row is created on approval).
   */
  origin?: 'registration' | 'request';
  /**
   * True ⇔ the source is a tenant-directory (off-system) club: no source player
   * row or club META existed when the clearance was opened. Listing/UX + route
   * guards only — resolve/reject branch on the ACTUAL source row's existence,
   * not this flag, because a club may later sign up under the same slug and
   * roster the player. Cleared by the admin reassign route, which moves the
   * clearance to a real club and backfills a placeholder source row.
   */
  fromClubDirectory?: boolean;
  feesCleared: boolean;
  misconductCleared: boolean;
  status: ClearanceStatus;
  clubApprovedAt?: string | null;
  adminOverrideAt?: string | null;
  rejectedAt?: string | null;
  /** Email of the union admin who rejected on the clubs' behalf. */
  rejectedBy?: string;
  rejectReason?: string;
  version: number;
}

export type RegistrationReviewKind = 'off-system-alert' | 'cross-club-hold';
export type RegistrationReviewStatus = 'open' | 'resolved';
export type RegistrationReviewResolution = 'acknowledged' | 'accepted' | 'declined';

/**
 * A self-registration that needs a human look before it's fully trusted. Two kinds,
 * distinguished by audience + action:
 *
 *  - `off-system-alert` — the player registered into their OWN link club but named an
 *    "Other" (off-system) previous club, so no clearance could be opened. The player row
 *    is already active; this is an admin-only FYI carrying the typed club name.
 *  - `cross-club-hold` — the player used one club's link but chose a DIFFERENT current
 *    club (`currentClubId`). Because a per-club link must not silently write onto another
 *    club's active roster, NO player row exists yet: the fully-validated registration is
 *    parked in `pendingPlayer` until the destination club's chair accepts (→ the row, and
 *    any previous-club clearance, are materialized) or declines (→ discarded, ID doc purged).
 *
 * Stored as ONE canonical item under the DESTINATION club (sk `REGREVIEW#<id>`, gsi1 for
 * the admin cohort-wide listing) — the same own-partition-only read model as clearances.
 */
export interface RegistrationReview {
  id: string;
  kind: RegistrationReviewKind;
  playerNaturalKey: string;
  /** Denormalized "First Last" for display + audit. */
  playerName: string;
  idNumber?: string;
  /** The club the player registered INTO — partition owner + who actions a hold. */
  destClubId: string;
  destClubName: string;
  /** The club whose public link/token was used (may equal destClubId for off-system alerts). */
  linkClubId: string;
  linkClubName: string;
  /** Free-text off-system previous club, when the player picked "Other". */
  typedPreviousClub?: string;
  /** On-system previous club name, when the player named a real club (cross-club holds). */
  previousClubName?: string;
  /**
   * Fully-validated player payload awaiting the destination chair's acceptance
   * (cross-club-hold only; `status` omitted). Materialized into a PLAYER# row on accept,
   * discarded (ID doc purged) on decline. Absent on off-system alerts (row already active).
   */
  pendingPlayer?: PlayerRegistration;
  /**
   * The on-system previous club id the player selected, if any — re-resolved at accept
   * time to decide whether the materialized row opens a clearance to that club.
   */
  pendingLastClubId?: string;
  createdAt: string;
  status: RegistrationReviewStatus;
  resolution?: RegistrationReviewResolution;
  resolvedAt?: string;
  resolvedBy?: string;
  version: number;
}

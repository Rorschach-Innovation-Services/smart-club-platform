/**
 * Smart Club Platform API — Hono on Lambda.
 *
 * One app behind the API Gateway $default route. Public routes (/tenant,
 * /register) need no token; everything else runs through authenticate +
 * requireTenantMembership so the caller is scoped to one tenant. Admin-only
 * routes add requireAdmin; club routes assert per-club access for reps.
 *
 * All persistence goes through ./repo (tenant-scoped keys). Computation
 * (dashboards, scoring, fixtures) stays in the browser — this layer is thin CRUD.
 * See docs/architecture/0004 and docs/api/.
 */
import './instrument.js'; // MUST be first — inits Sentry before any client is built
import { Sentry } from './instrument.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { handle } from 'hono/aws-lambda';
import dayjs from 'dayjs';
import dayjsUtc from 'dayjs/plugin/utc.js';
import dayjsCustomParseFormat from 'dayjs/plugin/customParseFormat.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import {
  ensurePasswordlessUser,
  adminUpdateCognitoUserEmail,
  adminGlobalSignOut,
  adminDeleteCognitoUser,
  cognitoUserExists,
} from './cognito-users.js';
import { reconcileTenantAdmins } from './reconcile.js';
import {
  authenticate,
  requireTenantMembership,
  requireAdmin,
  requirePlatformOperator,
  assertClubAccess,
  resolveTenant,
  HttpError,
  type HonoEnv,
} from './auth.js';
import * as repo from './repo.js';
import { VersionConflictError, LastAdminError } from './repo.js';
import { clubIdFromName } from './club-id.js';
import { findReleaseClashes } from './venue-clash.js';
import {
  validateCalendars,
  validateStructures,
  validateCompetitions,
  assertValidCadence,
  assertValidTimeSlots,
} from './config-validation.js';
import { demographicsByLeague, summarizeDemographics } from './demographics.js';
import {
  validateClubPatch,
  resolveDistricts,
  OVERARCHING_DISTRICT,
  DOC_KEYS,
  DOC_CONTENT_TYPES,
  MIN_SAFEGUARDING_FILES,
  MAX_SAFEGUARDING_FILES,
} from './catalogue.js';
import {
  sendClubFixtures,
  sendStaffInvite,
  sendChairOnboarding,
  sendClearanceNotice,
  type Channel,
  type SendResult,
} from './notify/index.js';
import type {
  Club,
  ClubCommEvent,
  ClubSpec,
  DirectoryClub,
  League,
  Membership,
  SeasonRun,
  StageRun,
  Series,
  SeriesSchedule,
  Venue,
  TenantConfig,
  TutorialVideo,
  UserProfile,
  PlayerRegistration,
  PlayerClearance,
  AdminClearanceView,
} from './types.js';
import { teamIdsForClub, resolveTeam } from './teams.js';
import { orgCopy } from './branding.js';
import { hasFeature } from './features.js';
import { buildTenantConfig, type TenantBrandingInput } from './seed-core.js';
import { validateTenantSlug } from './tenant-validation.js';
import { grantTenantAdmin, addAdminMembership } from './tenant-admin.js';
import { originAllowed, originAllowedForTenant, canonicalWebOrigin } from './origins.js';

// Strict date-only parsing for calendar validation — dayjs's lenient default would roll
// '2026-02-31' into March and store a date the operator never entered.
dayjs.extend(dayjsUtc);
dayjs.extend(dayjsCustomParseFormat);

/**
 * The union's wall-clock offset from UTC (SAST, +02:00).
 *
 * Lambda runs in UTC, so anything that asks "what day is it" on behalf of a human here
 * has to add this or it stays on yesterday until 02:00 local. The region has no DST, so
 * a fixed offset is exact rather than an approximation — see ADR 0008 on why times are
 * wall-clock and never converted.
 */
const TENANT_UTC_OFFSET_MINUTES = 120;

const s3 = new S3Client({});

/**
 * Shared fallback set of how-to-use-the-app tutorial videos, used when a tenant has
 * no `tutorials` override on its config (so existing tenant rows need no migration).
 * `url`s are absolute public-S3 links built from TUTORIALS_BASE_URL (the TutorialAssets
 * bucket's HTTPS REST endpoint, set in sst.config) — the matching MP4s live under the
 * `tutorials/` key prefix, uploaded out-of-band (see docs/guides/tutorial-videos.md),
 * NOT shipped in the web build. Surfaced on the public /tutorials page and linked in the
 * chair onboarding email; `absUrl` passes these absolute URLs through unchanged. Order =
 * the on-screen numbering ({i+1}.).
 */
const TUTORIALS_BASE_URL = process.env.TUTORIALS_BASE_URL ?? '';
const tutorialUrl = (file: string) => `${TUTORIALS_BASE_URL}/tutorials/${file}`;
const DEFAULT_TUTORIALS: TutorialVideo[] = [
  { title: 'Creating your account', url: tutorialUrl('01-creating-account.mp4') },
  { title: 'Completing the affiliation form', url: tutorialUrl('02-affiliation.mp4') },
  { title: 'Uploading compliance forms', url: tutorialUrl('03-compliance-forms.mp4') },
  { title: 'Completing the CQI', url: tutorialUrl('04-cqi.mp4') },
  { title: 'Onboarding players', url: tutorialUrl('05-onboarding-players.mp4') },
  { title: 'Player clearances', url: tutorialUrl('06-clearances.mp4') },
  { title: 'Full walkthrough (all six steps)', url: tutorialUrl('00-full-walkthrough.mp4') },
];

/**
 * A tenant's tutorial videos. Falls back to the shared default set UNLESS the
 * tenant opted out via `tutorialsNoFallback` (see TenantConfig), in which case an
 * empty/absent override serves NO videos instead.
 */
const tutorialsFor = (config: TenantConfig | null): TutorialVideo[] =>
  config?.tutorials?.length
    ? config.tutorials
    : config?.tutorialsNoFallback
      ? []
      : DEFAULT_TUTORIALS;
const cognito = new CognitoIdentityProviderClient({});
const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET!;
// Public TutorialAssets bucket (also hosts tenant logos under branding/<slug>/ —
// the login page shows logos unauthenticated, so the private Uploads bucket is
// wrong for them). Set in sst.config.ts; '' offline (logo upload is cloud-only).
const TUTORIALS_BUCKET = process.env.TUTORIALS_BUCKET ?? '';
const USER_POOL_ID = process.env.USER_POOL_ID!;
const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB

// Wildcard platform (scheme 1) — real CNAME targets for the operator DNS sheet, and
// the shared API host. Empty until the wildcard is armed (see infra/tenants.ts).
const WILDCARD_ENABLED = process.env.WILDCARD_ENABLED === '1';
const SHARED_API_HOST = process.env.SHARED_API_HOST ?? '';
const WEB_CNAME_TARGET = process.env.WEB_CNAME_TARGET ?? '';
const SHARED_API_CNAME_TARGET = process.env.SHARED_API_CNAME_TARGET ?? '';

/**
 * Provision a passwordless invite/signup user, translating Cognito's email-format
 * rejection into a clean 400. The pool is `usernames:['email']`, so AdminCreateUser
 * requires an email-format Username; an address that passes EMAIL_RE but Cognito rejects
 * (e.g. leading/trailing/double dots) throws InvalidParameterException — which must read
 * as "fix the address", not surface as an opaque 500 (see Sentry DOLPHINS-API-1 / -WEB-1).
 */
async function provisionInviteUser(email: string): Promise<string> {
  try {
    return await ensurePasswordlessUser(cognito, USER_POOL_ID, email);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'InvalidParameterException')
      throw new HttpError(400, 'enter a valid email address');
    throw err;
  }
}

/** Reject unknown/retired compliance-doc keys before any S3 or record work. */
function assertDocKey(key: string): void {
  if (!DOC_KEYS.has(key)) throw new HttpError(400, `unknown document key "${key}"`);
}

/**
 * A recorded objectKey must live under this club's own S3 prefix. view-url and
 * the safeguarding DELETE presign/delete whatever is on record, so record
 * integrity IS their security gate — without this check a rep could record a
 * foreign club's key and then read (or S3-delete) that club's PII through their
 * own record. `local/` is the no-S3 local-dev sentinel.
 */
function assertOwnObjectKey(tenant: string, clubId: string, objectKey: string): void {
  if (objectKey.startsWith('local/')) return;
  if (!objectKey.startsWith(`${tenant}/${clubId}/`)) {
    throw new HttpError(400, 'objectKey does not belong to this club');
  }
}

/** Apply assertOwnObjectKey to every file reference inside a docMeta patch. */
function assertDocMetaObjectKeys(
  tenant: string,
  clubId: string,
  docMeta: Record<string, unknown>,
): void {
  for (const value of Object.values(docMeta)) {
    const m = value as { objectKey?: unknown; files?: unknown } | null;
    if (typeof m?.objectKey === 'string') assertOwnObjectKey(tenant, clubId, m.objectKey);
    if (Array.isArray(m?.files)) {
      for (const f of m.files as { objectKey?: unknown }[]) {
        if (typeof f?.objectKey === 'string') assertOwnObjectKey(tenant, clubId, f.objectKey);
      }
    }
  }
}

/** One stored compliance-document file (safeguarding holds an array of these). */
interface DocFileEntry {
  objectKey: string;
  size: number;
  contentType?: string;
  uploadedAt: string;
}

/**
 * Mirror of `safeguardingMeta` in the frontend's data.jsx — normalizes every
 * historical docMeta.safeguarding shape to `{ files, markedCompliant, at }`:
 * the `{ files: [...] }` wrapper as-is, a legacy single upload `{ objectKey }`
 * as a one-entry array, and the admin `{ markedCompliant }` sentinel as an
 * empty array with the flag set.
 */
function safeguardingMeta(meta: unknown): {
  files: DocFileEntry[];
  markedCompliant: boolean;
  courseBooked: boolean;
  courseDate: string;
  at?: string;
} {
  const m = (meta ?? {}) as Record<string, unknown>;
  const courseBooked = !!m.courseBooked;
  const courseDate = (m.courseDate as string | undefined) || '';
  if (Array.isArray(m.files)) {
    return {
      files: m.files as DocFileEntry[],
      markedCompliant: !!m.markedCompliant,
      courseBooked,
      courseDate,
      at: m.at as string | undefined,
    };
  }
  if (m.objectKey) {
    return {
      files: [m as unknown as DocFileEntry],
      markedCompliant: !!m.markedCompliant,
      courseBooked,
      courseDate,
    };
  }
  return {
    files: [],
    markedCompliant: !!m.markedCompliant,
    courseBooked,
    courseDate,
    at: m.at as string | undefined,
  };
}

/**
 * Re-wrap normalized safeguarding state as the stored docMeta value. `extra` carries the
 * club-set "course booked" flag + date so a generic merge or append/delete recompute can't
 * strip it; both ride through only when truthy (the canonical course-booked shape is
 * `{ files, courseBooked: true, courseDate, at }`).
 */
function safeguardingValue(
  files: DocFileEntry[],
  markedCompliant: boolean,
  at?: string,
  extra?: { courseBooked?: boolean; courseDate?: string },
) {
  const value: Record<string, unknown> = markedCompliant
    ? { files, markedCompliant: true, at }
    : { files };
  if (extra?.courseBooked) value.courseBooked = true;
  if (extra?.courseDate) value.courseDate = extra.courseDate;
  return value;
}

const app = new Hono<HonoEnv>();

// CORS trust (localhost, *.cloudfront.net, enumerated vanity hosts, and the wildcard
// suffix once armed) lives in ./origins. Link/anti-phishing validation uses the
// stricter originAllowedForTenant there — see docs/architecture/0007.
app.use(
  '*',
  cors({
    origin: (origin) => (origin && originAllowed(origin) ? origin : undefined),
    // x-dev-auth is the local-dev identity header; harmless in cloud (the API only
    // trusts it when LOCAL_AUTH=1 — see auth.ts), required for the offline stack.
    allowHeaders: ['content-type', 'authorization', 'x-tenant', 'x-dev-auth'],
  }),
);

const now = () => new Date().toISOString();

/** Surface the club's denormalized player count as `players` (no N+1 COUNT). */
function withPlayerCount(club: Club): Club {
  return { ...club, players: (club as { playerCount?: number }).playerCount ?? 0 };
}

// ───────────────────────── Public routes ─────────────────────────

/** Tenant branding by host (or ?tenant= / x-tenant in dev). No auth. */
app.get('/tenant', async (c) => {
  const tenant = resolveTenant(c) ?? c.req.query('tenant') ?? null;
  if (!tenant) throw new HttpError(400, 'unknown tenant');
  const config = await repo.getTenantConfig(tenant);
  if (!config) throw new HttpError(404, 'tenant not found');
  // Only branding + deadline + the league catalogue are public; knownClubs/requiredDocs
  // gate behind auth. Leagues are non-sensitive (names only) and the affiliation picker
  // needs them, so they ride the already-fetched tenant payload.
  return c.json({
    tenant: config.tenant,
    branding: config.branding,
    submissionDeadline: config.submissionDeadline,
    leagues: config.leagues ?? [],
    // District names are as public as league names — signup/affiliation pickers
    // need them. Legacy rows without the field resolve to the shared defaults.
    districts: resolveDistricts(config),
    // How-to-use-the-app videos for the public /tutorials page (non-sensitive; falls
    // back to the shared default set when the tenant has no override).
    tutorials: tutorialsFor(config),
    // Per-tenant feature flags (boolean map; defaults resolve client/server-side
    // via hasFeature/useFeature, so an empty map is a valid "all defaults" state).
    features: config.features ?? {},
    // Season calendars (ADR 0008). As public as league and district names — they are
    // the union's published playing dates, carry no personal data, and the admin
    // create-series form reads them off this already-fetched payload. Operator-only to
    // WRITE (stripped from PUT /tenant/config); public to read.
    calendars: config.calendars ?? [],
    // Structures are deliberately NOT here. They are only needed by the authenticated
    // "Start a season" flow, and GET /tenant is unauthenticated and hit on every public
    // page load — serving up to 50 structures × 20 stages of competition configuration
    // anonymously is payload nobody on that path reads. The admin console fetches them
    // from GET /tenant/config instead.
  });
});

/**
 * The tenant's club directory with malformed entries dropped. The field is typed
 * DirectoryClub[] but rows can predate the feature or be hand-edited, so readers
 * never trust the shape.
 */
function directoryClubs(cfg: TenantConfig | null | undefined): DirectoryClub[] {
  if (!cfg || !Array.isArray(cfg.knownClubs)) return [];
  return cfg.knownClubs.filter(
    (e): e is DirectoryClub =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as DirectoryClub).id === 'string' &&
      // The id becomes a clearance partition-key component — constrain stored values to
      // clubIdFromName's exact output alphabet so a hand-edited row can't inject key
      // structure (e.g. a '#' delimiter).
      /^[a-z0-9-]+$/.test((e as DirectoryClub).id) &&
      typeof (e as DirectoryClub).name === 'string' &&
      !!(e as DirectoryClub).name.trim(),
  );
}

/** Validate a registration link → returns the club name. Token self-describes tenant. */
app.get('/register/:clubId', async (c) => {
  const token = c.req.query('t');
  if (!token) throw new HttpError(400, 'missing token');
  const clubId = c.req.param('clubId');
  const resolved = await repo.getToken(token);
  // A club-signup token has no clubId, so it fails this match — reg links only.
  if (!resolved || resolved.clubId !== clubId) {
    throw new HttpError(404, 'invalid registration link');
  }
  const club = await repo.getClub(resolved.tenant, clubId);
  if (!club) throw new HttpError(404, 'club not found');
  // The tenant league catalogue rides along so the public Team dropdown can populate and
  // the POST handler can validate the chosen team against real keys (names only — same
  // non-sensitive set already exposed on /tenant).
  const cfg = await repo.getTenantConfig(resolved.tenant);
  // Sibling clubs for the "club for which last registered" dropdown, merged with
  // the operator-managed club directory (clubs that exist in the real world but
  // aren't on the system yet). Dedup by slug AND normalized name against ALL real
  // clubs — including the link club, which is its own dropdown option — so a
  // directory entry vanishes the moment the real club signs up. Public
  // (token-gated) exposure of id+name ONLY — the same projection reps get from
  // /clubs/directory; club names are non-sensitive here.
  const realClubs = await repo.listClubs(resolved.tenant);
  const takenIds = new Set(realClubs.map((cl) => cl.id));
  const takenNames = new Set(realClubs.map((cl) => cl.name.trim().toLowerCase()));
  const directory = directoryClubs(cfg).filter(
    (e) => !takenIds.has(e.id) && !takenNames.has(e.name.trim().toLowerCase()),
  );
  return c.json({
    tenant: resolved.tenant,
    clubId: club.id,
    clubName: club.name,
    leagues: cfg?.leagues ?? [],
    // District picker for the public registration form — same non-sensitive set
    // already exposed on /tenant.
    districts: resolveDistricts(cfg),
    clubs: [
      ...realClubs.filter((cl) => cl.id !== club.id).map((cl) => ({ id: cl.id, name: cl.name })),
      ...directory.map((e) => ({ id: e.id, name: e.name, directory: true as const })),
    ].sort((a, b) => a.name.localeCompare(b.name)),
  });
});

/** Submit a player registration. No auth; dedup + POPIA consent enforced. */
app.post('/register/:clubId', async (c) => {
  const token = c.req.query('t');
  if (!token) throw new HttpError(400, 'missing token');
  const clubId = c.req.param('clubId');
  const resolved = await repo.getToken(token);
  if (!resolved || resolved.clubId !== clubId) {
    throw new HttpError(404, 'invalid registration link');
  }
  // Same per-token cap as the presign route (shared counter). The submit is unauthenticated
  // and the previous-club path below is a write primitive aimed at a club the caller names:
  // it reveals whether an ID number is registered there, flips that player to
  // 'clearance-pending', and — since a DECLARED previous club now opens a clearance whether or
  // not it rosters the player — can put a pending item in ANY on-system club's queue for an
  // identity that club has never seen. None of that may be unthrottled.
  //
  // Three caps stack on this route: this per-token one, CLUB_INBOUND_PER_HOUR on the
  // DESTINATION club, and bumpClubSourceCounter on a named on-system PREVIOUS club (below) —
  // the last because naming a club now queues a clearance in its portal regardless of whether
  // it has ever rostered the player.
  const allowed = await repo.bumpSignupTokenCounter(token, now(), REGISTRATIONS_PER_HOUR);
  if (!allowed) throw new HttpError(429, 'too many registrations — please try again later');
  // cfg feeds the team/league validation below; the club read is the 404 check.
  const cfg = await repo.getTenantConfig(resolved.tenant);
  const regClub = await repo.getClub(resolved.tenant, clubId);
  if (!regClub) throw new HttpError(404, 'club not found');
  const body = await c.req.json<
    Partial<PlayerRegistration> & { lastClubId?: string; currentClubId?: string }
  >();
  // Full parity with the in-portal chair form (POST /clubs/:id/players): the public link
  // now captures the same Union field set, including an ID-document upload. `dob` is
  // derived server-side from the RSA ID, never trusted from the client.
  const required: Array<keyof PlayerRegistration> = [
    'firstName',
    'lastName',
    'idNumber',
    'race',
    'gender',
    'nationality',
    'cell',
    'team',
    'district',
  ];
  // Treat present-but-blank (whitespace-only) values as missing: a blank idNumber
  // would otherwise pass this gate and silently fall through to the name+dob key.
  const missing = required.filter((k) => {
    const v = body[k];
    return v == null || String(v).trim() === '';
  });
  if (missing.length) throw new HttpError(400, `missing required fields: ${missing.join(', ')}`);
  // SA citizens derive dob from the RSA ID; non-SA (passport) supply it directly.
  const dob = resolvePlayerDob(body);
  if (!dob) {
    throw new HttpError(
      400,
      'provide a valid 13-digit RSA ID, or a passport/visa number with date of birth',
    );
  }
  // Team must be a real league key in the tenant catalogue.
  const leagueKeys = new Set((cfg?.leagues ?? []).map((l) => l.key));
  if (leagueKeys.size && !leagueKeys.has(body.team!)) {
    throw new HttpError(400, 'unknown team/league');
  }
  const isMinor = computeIsMinor(dob);
  if (isMinor && !body.guardianName) {
    throw new HttpError(400, 'guardianName required for minors (POPIA)');
  }
  // The ID document is REQUIRED on the public path (full parity with the chair form, which
  // makes it mandatory client-side). Unlike the portal path there is no later authed step to
  // attach it, so it must ride on the submit. Validate it the same way the authed id-doc
  // record route does, and confirm the presigned objectKey was minted for this tenant/club.
  const idDocMeta = body.idDocMeta;
  if (!idDocMeta || !idDocMeta.objectKey) throw new HttpError(400, 'an ID document is required');
  if (
    typeof idDocMeta.size !== 'number' ||
    idDocMeta.size <= 0 ||
    idDocMeta.size > MAX_ID_DOC_BYTES
  ) {
    throw new HttpError(400, 'ID document must be a non-empty image/PDF under 5 MB');
  }
  if (idDocMeta.contentType && !ID_DOC_TYPES.has(idDocMeta.contentType)) {
    throw new HttpError(400, 'ID document must be an image or PDF');
  }
  // assertOwnObjectKey stays against the LINK club (`clubId`): that's where the presign
  // minted the objectKey, and the token authorizes writes under its prefix. The stored
  // idDocMeta.objectKey therefore lives under the link club's S3 prefix even when the
  // player lands on a DIFFERENT club below — safe because every delete/purge path keys
  // off the stored objectKey, never the club prefix, but non-obvious.
  assertOwnObjectKey(resolved.tenant, clubId, idDocMeta.objectKey);
  // Editable current/destination club: the player may register into a club OTHER than the
  // one whose public link they used. The link club (`clubId`) still owns the token, the
  // rate-limit counter, and the presigned ID-doc key; `destClubId` is only the roster the
  // player lands on. Registering into a different club needs no consent from that club — it
  // is the same registration path as the link club, just rate-limited per destination below.
  const currentClubId = typeof body.currentClubId === 'string' ? body.currentClubId.trim() : '';
  let destClubId = clubId;
  let destClub = regClub;
  if (currentClubId && currentClubId !== clubId) {
    const picked = await repo.getClub(resolved.tenant, currentClubId);
    if (!picked) throw new HttpError(400, 'unknown current club');
    destClubId = currentClubId;
    destClub = picked;
  }
  // Names are unauthenticated free text that later rides into outbound messages (the
  // clearance chairman notice) — collapse whitespace runs and bound the length so a
  // hostile value can't carry payloads or break a WhatsApp template parameter.
  body.firstName = body.firstName!.replace(/\s+/g, ' ').trim().slice(0, 60);
  body.lastName = body.lastName!.replace(/\s+/g, ' ').trim().slice(0, 60);
  const naturalKey = playerNaturalKey({ ...body, dob });
  const player: PlayerRegistration = {
    naturalKey,
    clubId: destClubId,
    firstName: body.firstName,
    lastName: body.lastName,
    dob,
    cell: body.cell,
    email: body.email,
    isMinor,
    guardianName: body.guardianName,
    idType: body.idType ?? 'sa-id',
    idNumber: normalizeId(body.idNumber),
    nationality: body.nationality,
    race: body.race,
    gender: body.gender,
    postalAddress: body.postalAddress,
    postalCode: body.postalCode,
    team: body.team,
    district: body.district,
    lastClub: body.lastClub,
    battingHand: body.battingHand,
    bowlingHand: body.bowlingHand,
    battingType: body.battingType,
    bowlerType: body.bowlerType,
    isAllRounder: body.isAllRounder ?? false,
    isWk: body.isWk ?? false,
    idDocMeta: {
      objectKey: idDocMeta.objectKey,
      size: idDocMeta.size,
      contentType: idDocMeta.contentType,
      uploadedAt: now(),
    },
    status: 'active',
    registeredVia: 'link',
    version: 0,
    consentAt: now(),
    createdAt: now(),
  };

  let lastClubId = typeof body.lastClubId === 'string' ? body.lastClubId.trim() : '';
  // An EXACT on-system club name typed into "Other" is the same declaration as picking that
  // club from the list, and must take the same path — resolved HERE, before anything keys on
  // lastClubId, so the previous==current guard, the source-club cap, and the clearance
  // decision all see one flow. Left as free text it would register as a fresh signing with no
  // clearance AND no off-system alert (exact matches deliberately don't alert), which was the
  // one way a declared transfer could still slip through silently. Same normalised-name idiom
  // as the signup collision check; near-name variants stay free text and alert as before.
  if (!lastClubId && typeof body.lastClub === 'string') {
    const typed = body.lastClub.trim();
    if (typed && typed !== '—') {
      const nameKey = typed.toLowerCase();
      const match = (await repo.listClubs(resolved.tenant)).find(
        (cl) => cl.name.trim().toLowerCase() === nameKey,
      );
      if (match) lastClubId = match.id;
    }
  }
  // The previous club can't be the current club — a transfer to the club you're leaving is
  // meaningless — UNLESS both are the LINK club, which is a legitimate re-registration at the
  // same club (handled without a clearance in createSelfRegistration). So only reject
  // previous == current when the current club isn't the link club.
  if (lastClubId && lastClubId === destClubId && destClubId !== clubId) {
    throw new HttpError(400, 'previous club cannot be your current club');
  }

  // Anti-spam: bound INBOUND self-registrations per destination club when the player picked a
  // club OTHER than the one whose link they used. A per-club link MAY register a player onto a
  // different club's roster — the joining club's consent is not required — so this cap is the
  // guard against a leaked link piling registrations onto a victim club, regardless of how many
  // links an attacker holds. (Same-club registrations go via their own link and skip this cap.)
  if (destClubId !== clubId) {
    const ok = await repo.bumpClubInboundCounter(
      resolved.tenant,
      destClubId,
      now(),
      CLUB_INBOUND_PER_HOUR,
    );
    if (!ok) {
      throw new HttpError(
        429,
        'that club is receiving too many registrations right now — please try again later',
      );
    }
  }

  // Anti-spam, the other direction: bound registrations that NAME a club as the previous one.
  // Since a declared previous club opens a clearance whether or not it rosters the player, this
  // is a write primitive pointed at a third party — an attacker with one link can queue junk
  // clearances in any on-system club's portal under fabricated identities, and the union's only
  // disposal is a manual two-step per item. The inbound cap above does not cover it: that one is
  // keyed on the DESTINATION and is skipped entirely when the player registers into the link
  // club's own roster, which is the cheapest way to run this attack. Only the on-system case is
  // capped — a directory slug has no club item to hold a counter, and no rep to spam.
  //
  // CHECK here, CHARGE only once a clearance is actually opened (below). Charging on attempt
  // would hand out a cheaper attack than the one being prevented: replaying one fabricated
  // identity 409s after the first, and if every replay spent a slot then ~CLUB_SOURCE_PER_HOUR
  // requests would exhaust the quota and start refusing GENUINE players naming that club.
  const namedSourceOnSystem =
    !!lastClubId &&
    lastClubId !== destClubId &&
    !!(await repo.getClub(resolved.tenant, lastClubId));
  if (
    namedSourceOnSystem &&
    (await repo.isClubSourceCapped(resolved.tenant, lastClubId, now(), CLUB_SOURCE_PER_HOUR))
  ) {
    throw new HttpError(
      429,
      'that previous club is receiving too many clearance requests right now — please try again later',
    );
  }

  // ── Register into the chosen club ── (the link club, or a DIFFERENT joining club the player
  // picked on the form). Opens a registration-origin clearance to the previous club when the
  // player is found there; otherwise a plain active row on the chosen club's roster.
  try {
    const { clearanceFromName } = await createSelfRegistration(
      resolved.tenant,
      player,
      destClub,
      lastClubId,
      directoryClubs(cfg),
      cfg,
    );
    if (clearanceFromName) {
      // CHARGE the source club's quota only now, having actually put a clearance in its queue.
      // Best-effort: the clearance is already committed, so a counter failure must not turn a
      // successful registration into an error — worst case the cap is briefly under-counted.
      if (namedSourceOnSystem) {
        await repo
          .bumpClubSourceCounter(resolved.tenant, lastClubId, now(), CLUB_SOURCE_PER_HOUR)
          .catch((err) => console.error('source-club counter bump failed', err));
      }
      return c.json({ ok: true, clearance: { fromClubName: clearanceFromName } }, 201);
    }
  } catch (err: unknown) {
    // Deliberately ONE message for every conflict shape: an anonymous caller must not be
    // able to distinguish "registered at the destination" from "mid-clearance at the
    // source" and use this endpoint as a status oracle.
    if (
      err instanceof repo.PlayerExistsAtDestinationError ||
      err instanceof repo.DuplicatePendingClearanceError ||
      (err as { name?: string }).name === 'ConditionalCheckFailedException'
    ) {
      throw new HttpError(409, 'already registered or a transfer is already in progress');
    }
    if (err instanceof repo.DestinationClubGoneError) throw new HttpError(409, err.message);
    throw err;
  }

  // Off-system previous club: the player named a club not on the system ("Other" free
  // text), so no clearance could be opened. The row is already active on the JOINING club's
  // roster (the link club, or a different club the player picked); flag it (best-effort) so
  // admins can see which club was typed. Excludes the '—' first-registration sentinel so clean
  // first registrations never raise an alert.
  //
  // No on-system re-check here: an exact on-system name was already promoted to lastClubId
  // before registration (and took the clearance path above), so surviving free text is by
  // construction NOT an exact match — a genuinely off-system club, or a near-name variant of
  // an on-system one, and both deserve the alert.
  const typedOther =
    !lastClubId && body.lastClub && body.lastClub.trim() && body.lastClub.trim() !== '—'
      ? body.lastClub.trim()
      : undefined;
  if (typedOther) {
    try {
      await repo.createRegistrationReview(resolved.tenant, {
        id: randomUUID(),
        kind: 'off-system-alert',
        playerNaturalKey: naturalKey,
        playerName: `${player.firstName} ${player.lastName}`,
        idNumber: player.idNumber,
        destClubId,
        destClubName: destClub.name,
        linkClubId: clubId,
        linkClubName: regClub.name,
        typedPreviousClub: typedOther,
        createdAt: now(),
        status: 'open',
        version: 0,
      });
    } catch (err) {
      console.warn('failed to create off-system registration alert', err);
    }
  }
  return c.json({ ok: true }, 201);
});

// Per-reg-token hourly cap shared by the presign AND submit handlers (one counter per
// token — a normal registration spends two: presign + submit). High enough for a club's
// full roster to self-register in one onboarding window, low enough to bound anonymous
// probing/state-flipping via the previous-club path on the submit route.
const REGISTRATIONS_PER_HOUR = 240;

// Per-destination-club hourly cap on INBOUND self-registrations that chose a club OTHER than
// the one whose link was used (link club ≠ current club). Deliberately far tighter than the
// per-link cap: registering onto another club's roster needs no consent from that club, so
// this bounds how fast a leaked link can pile registrations onto any one victim club
// regardless of how many links the attacker holds.
const CLUB_INBOUND_PER_HOUR = 30;

// Per-SOURCE-club hourly cap on registrations NAMING a club as the previous one. A separate
// constant from the inbound cap, not a reuse: the two bound different distributions. Inbound is
// "how many people join THIS club" — naturally small. Source is "how many people leave it",
// summed across every destination in the union, and a real end-of-season exodus concentrates
// hard (the 29 Jul backfill found 9 players moving Harlequins → Forest Hills alone). Sized so a
// genuine cluster never trips it while an attacker still cannot bury one club's queue.
const CLUB_SOURCE_PER_HOUR = 60;

/**
 * Mint a presigned PUT for a self-registering player's ID document (image or PDF). Token-
 * scoped + unauthenticated like the other /register/:clubId handlers — the `t` token must
 * resolve to this club. The objectKey lands under the tenant/club prefix so the submit
 * handler's own-object-key check accepts it.
 */
app.post('/register/:clubId/id-doc/upload-url', async (c) => {
  const token = c.req.query('t');
  if (!token) throw new HttpError(400, 'missing token');
  const clubId = c.req.param('clubId');
  const resolved = await repo.getToken(token);
  if (!resolved || resolved.clubId !== clubId) {
    throw new HttpError(404, 'invalid registration link');
  }
  // Rate-limit the presigned-PUT minting per reg token: the link is shared + long-lived, and
  // this endpoint is unauthenticated, so cap it to bound S3 write/cost amplification from a
  // leaked link. Generous enough for a club's whole roster to register in an onboarding window.
  const allowed = await repo.bumpSignupTokenCounter(token, now(), REGISTRATIONS_PER_HOUR);
  if (!allowed) throw new HttpError(429, 'too many registration uploads — please try again later');
  const { contentType } = await c.req
    .json<{ contentType?: string }>()
    .catch(() => ({ contentType: undefined }));
  const ct = contentType && ID_DOC_TYPES.has(contentType) ? contentType : 'application/pdf';
  const ext = ct === 'image/jpeg' ? 'jpg' : ct === 'image/png' ? 'png' : 'pdf';
  const objectKey = `${resolved.tenant}/${clubId}/reg-${randomUUID()}-id.${ext}`;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: UPLOADS_BUCKET, Key: objectKey, ContentType: ct }),
    { expiresIn: 300 },
  );
  return c.json({ uploadUrl: url, objectKey, contentType: ct });
});

// ───────────────────── Club self-registration (public) ─────────────────────

const SIGNUPS_PER_HOUR = 30;
const SIGNUP_NAME_MAX = 80;
const SIGNUP_CELL_MAX = 20;

/**
 * Normalize a South African cell number to the canonical stored form `0XXXXXXXXX`
 * (what the admin contact modal and the WhatsApp `toE164` conversion expect), or
 * null when it isn't one. Kept identical to src/api.js (the form validates with
 * the same rule before submitting — EMAIL_RE precedent). The `[6-8]` range is a
 * deliberate permissive SUPERSET of real mobile prefixes (it admits 080x/086/087
 * non-cell ranges) — don't "tighten" it: WhatsApp sends already skip undeliverable
 * numbers, and a false reject here locks a real chair out of signup.
 */
function normalizeZaCell(raw: string): string | null {
  const digits = raw.replace(/[\s\-().]/g, '');
  const m = /^(?:\+?27|0)([6-8]\d{8})$/.exec(digits);
  return m ? `0${m[1]}` : null;
}

/**
 * Resolve a club-signup token to its tenant config, or 404. Requires
 * `kind === 'club-signup'` (a player reg-link token never opens signup), a live
 * config — an erased tenant's signup token must die with it even if the TOKEN#
 * item somehow survived erasure — AND that the token matches the config's
 * `clubSignupLink` pointer. The pointer match makes the pointer the single
 * source of validity: a TOKEN# item orphaned by a partial rotation/revoke
 * failure (put succeeded, pointer write didn't) is inert rather than a live,
 * invisible, irrevocable signup credential.
 */
async function resolveSignupTenant(token: string | undefined): Promise<TenantConfig> {
  if (!token) throw new HttpError(400, 'missing token');
  const resolved = await repo.getToken(token);
  if (!resolved || resolved.kind !== 'club-signup') {
    throw new HttpError(404, 'invalid signup link');
  }
  const cfg = await repo.getTenantConfig(resolved.tenant);
  if (!cfg || cfg.clubSignupLink?.token !== token) {
    throw new HttpError(404, 'invalid signup link');
  }
  return cfg;
}

/** Validate a club signup link → org name + the district choices for the form. */
app.get('/club-signup', async (c) => {
  const cfg = await resolveSignupTenant(c.req.query('t'));
  return c.json({
    tenant: cfg.tenant,
    // resolveSignupTenant already fetched this config — resolve locally, no second read.
    orgName: orgCopy(cfg).name,
    // Per-tenant list; a freshly created client (districts: []) renders no options
    // and ClubSignupPage shows its "signup isn't open yet" notice.
    districts: resolveDistricts(cfg),
  });
});

/**
 * Club self-registration: one POST creates the club AND the rep's login account
 * (they then sign in via the normal email OTP). The unguessable, admin-revocable
 * token is the primary abuse gate; the hourly cap on the token item is a cheap
 * backstop for a leaked link. Validation (and the name/slug pre-check) runs
 * BEFORE ensurePasswordlessUser so junk-name spam never mints Cognito accounts.
 */
app.post('/club-signup', async (c) => {
  const token = c.req.query('t');
  const cfg = await resolveSignupTenant(token);
  const tenant = cfg.tenant;

  const body = await c.req
    .json<{
      clubName?: string;
      district?: string;
      repName?: string;
      repEmail?: string;
      repCell?: string;
    }>()
    .catch(() => null);
  if (!body) throw new HttpError(400, 'invalid request body');
  const clubName = (body.clubName ?? '').trim();
  const repName = (body.repName ?? '').trim();
  const repCell = (body.repCell ?? '').trim();
  const district = body.district ?? '';
  const email = (body.repEmail ?? '').trim().toLowerCase();
  if (!clubName || !district || !repName || !email) {
    throw new HttpError(400, 'clubName, district, repName and repEmail are required');
  }
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'valid repEmail required');
  if (!resolveDistricts(cfg).includes(district))
    throw new HttpError(400, `unknown district: ${district}`);
  if (clubName.length > SIGNUP_NAME_MAX || repName.length > SIGNUP_NAME_MAX) {
    throw new HttpError(400, `names must be ${SIGNUP_NAME_MAX} characters or fewer`);
  }
  if (repCell.length > SIGNUP_CELL_MAX) throw new HttpError(400, 'repCell too long');
  // Optional field, but a present cell must normalize: the stored chair cell feeds
  // WhatsApp sends and the admin contact modal, which expect the 0XXXXXXXXX form.
  const repCellNorm = repCell ? normalizeZaCell(repCell) : undefined;
  if (repCell && !repCellNorm) {
    throw new HttpError(400, 'repCell must be a valid South African cell number');
  }
  // The slug becomes the club id; a name like "!!!" slugs to '' and must not fall
  // through to buildClubFromSpec's defaults (public input never gets fallbacks).
  const slug = clubIdFromName(clubName);
  if (!slug) throw new HttpError(400, 'club name must contain letters or numbers');

  const allowed = await repo.bumpSignupTokenCounter(token!, now(), SIGNUPS_PER_HOUR);
  if (!allowed) throw new HttpError(429, 'too many signups — please try again later');

  // Name AND slug collision pre-check: "Kingsmead-CC" vs "Kingsmead CC" differ as
  // names but collide on id, so a name check alone would die on createClub's guard.
  const existing = await repo.listClubs(tenant);
  const nameKey = clubName.toLowerCase();
  const colliding = existing.find(
    (cl) => cl.id === slug || cl.name.trim().toLowerCase() === nameKey,
  );
  if (colliding) return signupReplayOr409(c, tenant, colliding, email);

  const sub = await provisionInviteUser(email);
  const club = buildClubFromSpec({
    name: clubName,
    district,
    chair: repName,
    chairEmail: email,
    chairCell: repCellNorm ?? undefined,
  });
  club.onboardedVia = 'self-signup';
  // Implied POPIA consent: submitting the self-signup form (which carries a notice that
  // the union stores these details to administer affiliation) records consent at submit.
  club.signupConsentAt = now();
  club.changedBy = email;
  try {
    await repo.createClub(tenant, club);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // A concurrent signup won the id between our pre-check and this put — re-run
      // the replay heuristic against the club that actually landed at that id.
      const winner = await repo.getClub(tenant, club.id);
      if (winner) return signupReplayOr409(c, tenant, winner, email);
      throw err;
    }
    throw err;
  }
  await ensureSignupMembership(tenant, sub, email, club.id);
  return c.json({ clubId: club.id, clubName: club.name, email }, 201);
});

/**
 * Replay vs name-taken. A resubmit by the SAME chair (the colliding club's
 * exco.chair.email matches the submitted email) is a replay of their own signup —
 * return 200 with the existing clubId and re-ensure the membership idempotently,
 * so a lost-response retry converges instead of erroring. Anyone else gets a 409
 * carrying `code: 'name_taken'`, which the SPA branches on to show "choose a
 * different name" inline (never the sign-in route). The chair-email oracle this
 * implies is mild, token-gated, and accepted.
 */
async function signupReplayOr409(
  c: Context<HonoEnv>,
  tenant: string,
  club: Club,
  email: string,
): Promise<Response> {
  const exco = (club.exco ?? {}) as { chair?: { email?: string } };
  const chairEmail = (exco.chair?.email ?? '').trim().toLowerCase();
  if (chairEmail && chairEmail === email) {
    const sub = await provisionInviteUser(email);
    await ensureSignupMembership(tenant, sub, email, club.id);
    return c.json({ clubId: club.id, replayed: true });
  }
  return c.json(
    {
      error: 'a club with that name is already registered — choose a different name',
      code: 'name_taken',
    },
    409,
  );
}

/**
 * Idempotently ensure the signing-up rep can see their club: an existing admin
 * membership in the tenant is left untouched (admins see every club), an existing
 * rep membership gains the clubId only if absent, and a brand-new user gets a rep
 * membership stamped 'self-signup'. Filter-then-reattach so memberships in OTHER
 * tenants are preserved (same rule as the admin user-management routes).
 *
 * Read-modify-write with no version guard, like those admin routes: two
 * concurrent signups by one email (or a racing Team & Access edit) can drop a
 * clubIds append. Accepted — the loser's rep just resubmits and the replay path
 * re-ensures the membership.
 */
async function ensureSignupMembership(
  tenant: string,
  sub: string,
  email: string,
  clubId: string,
): Promise<void> {
  const existing = await repo.getUser(sub);
  const current = existing?.memberships.find((m) => m.tenantId === tenant);
  if (current?.role === 'admin') return;
  if (current?.clubIds.includes(clubId)) return;
  const others = (existing?.memberships ?? []).filter((m) => m.tenantId !== tenant);
  const membership: Membership = current
    ? { ...current, clubIds: [...current.clubIds, clubId] }
    : {
        tenantId: tenant,
        role: 'rep',
        clubIds: [clubId],
        invitedAt: now(),
        invitedBy: 'self-signup',
      };
  const next: UserProfile = {
    sub,
    email: existing?.email ?? email,
    memberships: [...others, membership],
    onboardingSeen: existing?.onboardingSeen ?? {},
    ...(existing?.lastLoginAt ? { lastLoginAt: existing.lastLoginAt } : {}),
  };
  await writeUserGuarded(tenant, next, 0);
}

function computeIsMinor(dob: string): boolean {
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return false;
  const eighteen = new Date(born);
  eighteen.setFullYear(eighteen.getFullYear() + 18);
  return eighteen.getTime() > Date.now();
}

/**
 * Idempotent dedup key for a person within a club. SHARED by the public-link path
 * and the in-portal chair form so the same person can't be registered twice (once
 * per path). Keys on the player's OWN identity — their ID number — NOT on contact
 * fields: a parent/guardian legitimately reuses one email/cell across siblings, so
 * keying on contact collapsed distinct children into one identity and blocked the
 * 2nd+ child (the transfer flow already resolves players by idNumber, so this aligns).
 * The identity is namespaced by idType + nationality because passport numbers are
 * unique only within an issuing country; a bare passport number would false-collide
 * two different foreign players. RSA IDs are nationally unique, scoped under `sa-id`.
 * Caveat: nationality is free text (not enum-validated), so a passport holder who
 * re-registers with a different spelling ("Zimbabwean" vs "Zimbabwe") escapes dedup —
 * best-effort, same class of gap the prior email-vs-cell key had.
 * Falls back to name+dob only when no idNumber is present (should not happen — it is
 * required on both paths), so the identity is never derived from an empty string.
 *
 * The result is a sha256 hash of that identity, NOT the plaintext: this key is both the
 * DynamoDB sk and the `:nk` URL segment in the id-doc endpoints, so hashing keeps the raw
 * national ID out of id-doc URLs, API access logs, and Sentry (POPIA data-minimisation).
 * Hashing is deterministic, so dedup and the cross-path guarantee are unchanged; the
 * plaintext idNumber lives only in the item's `idNumber` attribute (transfers match on it).
 */
function playerNaturalKey(body: Partial<PlayerRegistration>): string {
  const id = normalizeId(body.idNumber);
  const identity = id
    ? (body.idType ?? 'sa-id') === 'passport'
      ? `passport-${normalizeId(body.nationality)}-${id}`
      : `sa-id-${id}`
    : `${body.firstName}-${body.lastName}-${body.dob}`;
  return createHash('sha256').update(identity.toLowerCase()).digest('hex');
}

/**
 * Derive an ISO date of birth from a 13-digit RSA ID (YYMMDD…). The century digit is
 * absent, so we pivot year-relative (not on a frozen constant): assume the 2000s, and
 * fall back to the 1900s only if that lands in the future. This self-updates each year,
 * so it never silently rots. Returns null if the digits don't form a real date.
 */
function dobFromSaId(idNumber: string): string | null {
  if (!/^\d{13}$/.test(idNumber)) return null;
  const yy = Number(idNumber.slice(0, 2));
  const mm = Number(idNumber.slice(2, 4));
  const dd = Number(idNumber.slice(4, 6));
  const currentYear = new Date().getFullYear();
  const year = 2000 + yy <= currentYear ? 2000 + yy : 1900 + yy;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const iso = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getTime() > Date.now()) return null;
  // Guard against rollover (e.g. 0230 → Mar 02): the parsed date must match the inputs.
  if (d.getUTCMonth() + 1 !== mm || d.getUTCDate() !== dd) return null;
  return iso;
}

const MAX_ID_DOC_BYTES = 5 * 1024 * 1024; // 5 MB — ID photos/scans
const ID_DOC_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);

/** Plausibility floor for a self-asserted passport DOB (rejects obviously-bogus dates). */
const MIN_DOB = '1920-01-01';
/**
 * Resolve a player's date of birth. SA citizens (default) derive it from the forgery-
 * resistant 13-digit RSA ID. Non-SA citizens (`idType: 'passport'`) supply it directly —
 * there is no oracle to derive it from a passport, so the client value is trusted, bounded
 * only by a future-date and plausibility-floor check. Returns null if it can't be resolved.
 */
function resolvePlayerDob(body: Partial<PlayerRegistration>): string | null {
  if (body.idType === 'passport') {
    if (!body.dob) return null;
    const d = new Date(body.dob);
    if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() || body.dob < MIN_DOB) return null;
    return body.dob;
  }
  return dobFromSaId(body.idNumber!);
}
/** Normalise an ID for storage/matching — trims and upper-cases (passports are alphanumeric). */
function normalizeId(idNumber: string | undefined): string {
  return (idNumber || '').trim().toUpperCase();
}

/**
 * Find a club's player by normalized ID number (no GSI on idNumber — a linear scan of
 * that one club's roster, same matching the clearance-request route uses). Passports
 * are alphanumeric and prone to case/space variance, so both sides normalise.
 */
async function findPlayerByIdNumber(
  tenant: string,
  clubId: string,
  idNumber: string | undefined,
): Promise<PlayerRegistration | null> {
  const roster = await repo.listPlayers(tenant, clubId);
  const wanted = normalizeId(idNumber);
  return roster.find((p) => normalizeId(p.idNumber) === wanted) ?? null;
}

const CLEARANCE_NOTICES_PER_DAY = 3;
/**
 * Best-effort heads-up to the FROM-club chairman that a clearance now awaits the club's
 * decision. Never throws — a notify fault must not fail the clearance write that already
 * committed. Capped per source club per (UTC) day because the public register route can
 * open clearances anonymously: past the cap both channels are recorded as `skipped`, so
 * the comm log still shows the clearance arrived silently (authenticated admin reassigns
 * bypass the cap — they are deliberate union action, not the abuse the cap exists for).
 * There is deliberately no claim/idempotency machinery here — every creation site 409s a
 * duplicate pending clearance before a second notice could exist, and the clearance id is
 * minted fresh per request so it could never key a retry dedupe anyway.
 */
async function notifyClearanceOpened(
  tenant: string,
  tenantConfig: TenantConfig | null,
  fromClub: Club,
  clearance: PlayerClearance,
  by: string,
  opts: { bypassCap?: boolean } = {},
): Promise<void> {
  try {
    const chair = (
      fromClub.exco as Record<string, { email?: string; cell?: string; name?: string }> | undefined
    )?.chair;
    const channels: Channel[] = hasFeature(tenantConfig, 'whatsappInvites', true)
      ? ['email', 'whatsapp']
      : ['email'];
    // Email is attempted on every notice, so counting today's email rows counts notices —
    // including capped ones, which keeps the gate shut for the rest of the day. Read-then-
    // append with no transaction: parallel creates can briefly overshoot the cap. Fine for
    // an anti-abuse bound; this is not a hard quota.
    const today = now().slice(0, 10);
    const noticesToday = (fromClub.commLog ?? []).filter(
      (e) => e.kind === 'clearance' && e.channel === 'email' && e.at.slice(0, 10) === today,
    ).length;
    const results: SendResult[] =
      !opts.bypassCap && noticesToday >= CLEARANCE_NOTICES_PER_DAY
        ? channels.map((channel) => ({
            channel,
            status: 'skipped' as const,
            error: 'daily clearance-notice cap reached',
          }))
        : (
            await sendClearanceNotice({
              chair: {
                name: chair?.name || fromClub.chair || '',
                email: chair?.email,
                cell: chair?.cell,
              },
              fromClubName: fromClub.name,
              playerName: clearance.playerName,
              toClubName: clearance.toClubName,
              channels,
            })
          ).results;
    await repo.appendClubCommEvents(
      tenant,
      fromClub.id,
      results.map((r) => ({
        id: randomUUID(),
        channel: r.channel,
        ...(r.to ? { to: r.to } : {}),
        status: r.status,
        ...(r.messageId ? { messageId: r.messageId } : {}),
        ...(r.error ? { error: r.error } : {}),
        at: now(),
        by,
        idempotencyKey: `clearance-${clearance.id}-${r.channel}`,
        kind: 'clearance' as const,
      })),
    );
  } catch (err) {
    console.error('clearance notice failed', err);
  }
}

/**
 * Materialize a self-registration onto the destination roster (`player.clubId` must already be
 * the destination). Before creating anything it looks up where this exact person is ALREADY
 * registered across the union (by naturalKey), so a transfer routes to their REAL current club —
 * not merely the club they typed — and the same person can never be active at two clubs at once:
 *
 *  - Active elsewhere → create the row 'clearance-pending' + a registration-origin clearance FROM
 *    that club (which — or the union office — must approve before the player goes active). If the
 *    club they NAMED isn't where they're actually registered, the clearance is still routed to the
 *    real club, with a `note` recording the mismatch for whoever reviews it.
 *  - Mid-transfer elsewhere (already 'clearance-pending') → DuplicatePendingClearanceError, so the
 *    caller returns the collapsed 409 rather than opening a competing clearance.
 *  - Not registered anywhere else, named an on-system club → 'clearance-pending' row + a
 *    registration-origin clearance from that club, even though it has no roster record of them:
 *    a club still digitising its squad is indistinguishable from one the player never played for,
 *    and the clearance is what settles fees/misconduct either way. That club approves in its own
 *    portal, or the union office overrides.
 *  - Not registered anywhere else, named a DIRECTORY club (operator-entered `knownClubs`, not on
 *    the system) → the same, additionally flagged fromClubDirectory. The union office
 *    override-approves it or reallocates it to the real club once that club registers.
 *  - Not registered anywhere else, no previous club → a plain active row (first registration).
 *
 * Used by the public register route whether the player registers into the link club or a different
 * joining club. Repo errors (dedup/dest conflicts) propagate to the caller, which maps them.
 * Returns the opened clearance's source-club name, if any.
 */
async function createSelfRegistration(
  tenant: string,
  player: PlayerRegistration,
  destClub: Club,
  lastClubId: string,
  directory: DirectoryClub[],
  tenantConfig: TenantConfig | null,
): Promise<{ clearanceFromName?: string }> {
  // Re-registration at the SAME club (previous == the club being joined): record the history name;
  // there is nothing to transfer. Falls through to a plain active row (or the guards below).
  if (lastClubId && lastClubId === player.clubId) {
    player.lastClub = destClub.name;
  }

  // Where is this exact person already registered elsewhere in the union? This — not the
  // self-typed previous club — decides the transfer, so a wrong/duplicate/deleted pick can't
  // mis-route the clearance or leave the player active at two clubs.
  const elsewhere = await repo.findPlayerAcrossClubs(tenant, player.naturalKey, player.clubId);
  const activeSources = elsewhere.filter((e) => e.status === 'active');

  // Mid-transfer check runs FIRST, before the active-source branch: a person can be BOTH
  // clearance-pending at one club and active at another (their previous club rosters them
  // while a transfer is open, which is routine while clubs are still digitising). Letting the
  // active branch win there opens a SECOND clearance from the same source club, and both can
  // then resolve — the first deletes the source row, the second finds it already gone and,
  // being registration-origin, activates its destination anyway. That lands one person active
  // at two clubs. Refusing the registration outright is what this function already documents.
  if (elsewhere.some((e) => e.status === 'clearance-pending')) {
    // Already mid-transfer under this identity — don't open a competing clearance or a second row.
    throw new repo.DuplicatePendingClearanceError();
  }

  if (activeSources.length > 0) {
    // Route to the club they NAMED only if that's genuinely where they are; otherwise auto-route
    // to their real current club and flag the mismatch on the clearance note.
    const named = activeSources.find((s) => s.clubId === lastClubId);
    const source = named ?? activeSources[0];
    player.lastClub = source.clubName;
    let note: string | undefined;
    if (!named) {
      const namedClub = lastClubId ? await repo.getClub(tenant, lastClubId) : null;
      const namedDirectory = namedClub ? undefined : directory.find((e) => e.id === lastClubId);
      note = lastClubId
        ? namedClub
          ? `Auto-routed: player named "${namedClub.name}" as previous club, but is registered at ${source.clubName}.`
          : namedDirectory
            ? `Auto-routed: player named "${namedDirectory.name}" (not yet on the system) as previous club, but is registered at ${source.clubName}.`
            : `Auto-routed: the named previous club is not on the system; player is registered at ${source.clubName}.`
        : `Auto-routed to ${source.clubName}, where the player is registered (no previous club was named).`;
    }
    player.status = 'clearance-pending';
    const clearance: PlayerClearance = {
      id: randomUUID(),
      playerNaturalKey: player.naturalKey,
      playerName: `${player.firstName} ${player.lastName}`,
      idNumber: player.idNumber,
      team: player.team,
      fromClubId: source.clubId,
      toClubId: player.clubId,
      fromClubName: source.clubName,
      toClubName: destClub.name,
      // requestedAt feeds the admin-list gsi1 sort key — required even though no rep initiated
      // this (requestedBy stays absent; origin says who did).
      requestedAt: now(),
      origin: 'registration',
      note,
      feesCleared: false,
      misconductCleared: false,
      status: 'pending',
      clubApprovedAt: null,
      adminOverrideAt: null,
      version: 0,
    };
    await repo.createPlayerWithClearance(tenant, player, clearance);
    // Best-effort chairman heads-up (never throws). The source club record isn't loaded on
    // this branch — findPlayerAcrossClubs returns roster rows — so fetch it just for the
    // notice; a read fault only costs the notice, never the committed registration.
    const sourceClub = await repo.getClub(tenant, source.clubId).catch(() => null);
    if (sourceClub) {
      await notifyClearanceOpened(tenant, tenantConfig, sourceClub, clearance, 'registration');
    }
    return { clearanceFromName: source.clubName };
  }

  // Not registered anywhere else, but the player DECLARED a previous club: open a pending
  // clearance to it regardless of whether that club has them on its roster here. Roster
  // absence is not evidence the transfer isn't real — a club still digitising its squad
  // looks identical to one the player never played for, and the fees/misconduct obligation
  // the clearance exists to settle is owed in the real world either way. Two source shapes,
  // both sourceless (no player row to flip):
  //   - a real ON-SYSTEM club → it approves in its own portal, or the Union office overrides;
  //   - a DIRECTORY club (operator-entered, not on the system) → flagged fromClubDirectory so
  //     the Union office can approve it or reallocate it once the club registers.
  // The real-club lookup runs FIRST so a club that claimed a directory slug between the
  // form's GET and this POST is treated as the on-system club it now is.
  if (lastClubId && lastClubId !== player.clubId) {
    const sourceClub = await repo.getClub(tenant, lastClubId);
    const dirEntry = sourceClub ? undefined : directory.find((e) => e.id === lastClubId);
    if (!sourceClub && !dirEntry) {
      // The entry vanished (operator removed/renamed it) between GET and POST. The
      // player has already uploaded an ID document at this point — guide, don't baffle.
      throw new HttpError(400, 'that previous club is no longer listed — please re-select it');
    }
    const fromClubName = sourceClub ? sourceClub.name : dirEntry!.name;
    player.status = 'clearance-pending';
    player.lastClub = fromClubName;
    const clearance: PlayerClearance = {
      id: randomUUID(),
      playerNaturalKey: player.naturalKey,
      playerName: `${player.firstName} ${player.lastName}`,
      idNumber: player.idNumber,
      team: player.team,
      fromClubId: lastClubId,
      toClubId: player.clubId,
      fromClubName,
      toClubName: destClub.name,
      requestedAt: now(),
      origin: 'registration',
      ...(sourceClub ? {} : { fromClubDirectory: true }),
      note: sourceClub
        ? `${fromClubName} has no roster record of this player. If they did play there, ${fromClubName} can approve the clearance as usual. If they did not, the Union office can reallocate it to the club they actually left — declining is deliberately not an option, since it would permanently flag a legitimately registered player.`
        : `"${fromClubName}" is not yet on the system — the Union office can approve this clearance, or reallocate it once the club registers.`,
      feesCleared: false,
      misconductCleared: false,
      status: 'pending',
      clubApprovedAt: null,
      adminOverrideAt: null,
      version: 0,
    };
    await repo.createPlayerWithSourcelessClearance(tenant, player, clearance);
    // Chairman heads-up only for an ON-SYSTEM source: a directory entry has no club
    // record and no chairman on file — the union office resolves those.
    if (sourceClub) {
      await notifyClearanceOpened(tenant, tenantConfig, sourceClub, clearance, 'registration');
    }
    return { clearanceFromName: fromClubName };
  }
  player.status = 'active';
  await repo.createPlayer(tenant, player);
  return {};
}

// ───────────────────── Authenticated routes ─────────────────────

app.use('/me', authenticate);
app.get('/me', async (c) => {
  const auth = c.get('auth')!;
  const user = await repo.getUser(auth.sub);
  return c.json(
    user ?? { sub: auth.sub, email: auth.email, memberships: auth.memberships, onboardingSeen: {} },
  );
});
app.patch('/me', async (c) => {
  const auth = c.get('auth')!;
  const body = await c.req.json<{ onboardingSeen?: Record<string, boolean> }>();
  const existing = await repo.getUser(auth.sub);
  const user = existing ?? {
    sub: auth.sub,
    email: auth.email,
    memberships: auth.memberships,
    onboardingSeen: {},
  };
  user.onboardingSeen = { ...user.onboardingSeen, ...(body.onboardingSeen ?? {}) };
  await repo.putUser(user);
  return c.json(user);
});

// All /clubs, /series, /season-runs, /tenant/config, /admin routes require a tenant
// membership. Both the bare path and the wildcard are registered for each: Hono's `/x/*`
// does NOT match `/x`, so omitting the bare form leaves the collection route
// unauthenticated (and then 403ing on the missing requestAuth) — the exact bug the
// season-run integration tests caught.
app.use('/clubs/*', authenticate, requireTenantMembership);
app.use('/clubs', authenticate, requireTenantMembership);
app.use('/series/*', authenticate, requireTenantMembership);
app.use('/series', authenticate, requireTenantMembership);
app.use('/season-runs/*', authenticate, requireTenantMembership);
app.use('/season-runs', authenticate, requireTenantMembership);
app.use('/venues/*', authenticate, requireTenantMembership);
app.use('/venues', authenticate, requireTenantMembership);
app.use('/tenant/config', authenticate, requireTenantMembership);
app.use('/tenant/support', authenticate, requireTenantMembership);
app.use('/admin/*', authenticate, requireTenantMembership, requireAdmin);
// Platform operator portal — tenant-INDEPENDENT (no requireTenantMembership /
// host resolution): the '*'/operator membership itself is the authorization.
app.use('/platform/*', authenticate, requirePlatformOperator);

// ───────────────────────── Clubs ─────────────────────────

/** List all clubs in the tenant (admin) — with derived player counts. */
app.get('/clubs', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const clubs = await repo.listClubs(tenant);
  const withCounts = clubs.map((club) => withPlayerCount(club));
  return c.json(withCounts);
});

/** Get one club (rep may only read their own). */
/**
 * Lightweight club directory for reps — {id, name} only. Reps need a list of sibling
 * clubs (for clearance from/to selection) but must NOT see the full Club record
 * (chair contact, cqi, docs). Admin-only `GET /clubs` returns everything; this is the
 * rep-safe projection. Registered before `/clubs/:id` so the static path wins.
 */
app.get('/clubs/directory', async (c) => {
  const ra = c.get('requestAuth')!;
  const clubs = await repo.listClubs(ra.tenant);
  return c.json(clubs.map((cl) => ({ id: cl.id, name: cl.name })));
});

app.get('/clubs/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertClubAccess(ra, id);
  const club = await repo.getClub(ra.tenant, id);
  if (!club) throw new HttpError(404, 'club not found');
  return c.json(withPlayerCount(club));
});

/** Patch a club (affiliation, cqi+cqiAnswers, ground incl. lat/lon, leagues, coaches). */
app.patch('/clubs/:id', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertClubAccess(ra, id);
  const patch = await c.req.json<Partial<Club>>();
  // The player counter is server-owned and must never be written from a client patch.
  // `playerCount` is maintained only by the atomic registration/delete bumps
  // (repo.createPlayer / deletePlayer); `players` is derived on read by withPlayerCount.
  // Because updateClub PUTs the WHOLE club item, a stale `playerCount` round-tripped from
  // the client's last load (it's returned alongside `players`) would otherwise overwrite the
  // live counter and stick forever. Strip both before validation/merge. Drift from the
  // narrower read-to-PUT race is healed out-of-band by backfill-player-counts.
  // NOTE: this is the ONLY route that spreads a raw client body into updateClub — the other
  // applyClubPatch callers build their patch server-side. Any future route added over
  // updateClub that forwards a client body must repeat this strip.
  delete (patch as { playerCount?: unknown }).playerCount;
  delete (patch as { players?: unknown }).players;
  const current = await repo.getClub(ra.tenant, id);
  if (!current) throw new HttpError(404, 'club not found');
  // Rename handling: normalise, drop no-ops, and enforce the SAME name/slug uniqueness
  // the signup path guards — two clubs must never share a display name or collide on id
  // (length/emptiness is checked later by validateClubPatch). Applies to admin and rep.
  let renamed = false;
  if (patch.name !== undefined) {
    patch.name = patch.name.trim();
    if (patch.name === current.name) {
      delete patch.name; // no-op rename — don't flag, note, or write a spurious change
    } else {
      renamed = true;
    }
  }
  if (renamed) {
    const slug = clubIdFromName(patch.name!);
    // A name with no alphanumerics slugs to '' — reject it as signup does (index.ts ~540);
    // an empty slug is meaningless and would seed an empty-slug collision magnet.
    if (!slug) throw new HttpError(400, 'club name must contain letters or numbers');
    const nameKey = patch.name!.toLowerCase();
    const clash = (await repo.listClubs(ra.tenant)).find(
      (cl) => cl.id !== id && (cl.id === slug || cl.name.trim().toLowerCase() === nameKey),
    );
    if (clash) throw new HttpError(400, 'a club with this name already exists');
  }
  // The affiliation form is no longer hard-locked. A rep may correct an already-
  // submitted form, but any such edit re-flags the club for admin re-confirmation.
  // Only an admin may write `amendmentPending` (the re-confirm action sets it false);
  // a rep's own value is dropped first so it can't self-dismiss the flag with a bare
  // patch, then forced true when the rep actually touches affiliation fields. The
  // rename flag (`nameChangePending`/`previousName`) follows the same shape: a rep
  // rename applies live but is flagged for review; an admin rename is authoritative
  // and clears any pending flag it supersedes.
  if (ra.membership.role !== 'admin') {
    delete patch.amendmentPending;
    delete patch.nameChangePending;
    delete patch.previousName;
    if (current.affiliation === 'complete' && affiliationFieldsTouched(patch)) {
      patch.amendmentPending = true;
    }
    if (renamed) {
      patch.nameChangePending = true;
      patch.previousName = current.name;
    }
  } else if (renamed) {
    patch.nameChangePending = false;
    patch.previousName = '';
  }
  // Valid league keys = the tenant's catalogue plus keys already on the club (so an
  // admin can still remove a league that was later deleted from the catalogue).
  const cfg = await repo.getTenantConfig(ra.tenant);
  const validLeagueKeys = new Set([
    ...(cfg?.leagues ?? []).map((l) => l.key),
    ...(current.leagues ?? []),
  ]);
  // Same union for doc keys: a patch may carry/clear a retired key already on the
  // club (pre-cleanup state) but can never introduce one — e.g. a stale pre-deploy
  // admin tab's "mark all compliant" must not repopulate keys after cleanup.
  const validDocKeys = new Set([
    ...DOC_KEYS,
    ...Object.keys(current.docs ?? {}),
    ...Object.keys(current.docMeta ?? {}),
  ]);
  // Same union for districts: the tenant's resolved list plus the club's current
  // district, so a club whose district was since removed can still be saved
  // without changing it — but can never move to another unknown one.
  const validDistricts = new Set([
    ...resolveDistricts(cfg),
    ...(current.district ? [current.district] : []),
  ]);
  const invalid = validateClubPatch(patch, validLeagueKeys, validDocKeys, validDistricts);
  if (invalid) throw new HttpError(400, invalid);
  if (patch.docMeta) assertDocMetaObjectKeys(ra.tenant, id, patch.docMeta);
  // Stale-client guard: docMeta is replaced wholesale (see repo.updateClub), so a
  // pre-multi-file client's "mark compliant" (bare sentinel) or revert (key omitted)
  // would erase the safeguarding files array — uploaded certificates must survive
  // any generic patch that touches docMeta. Merge the stored files back in and keep
  // the docs flag consistent with the preserved minimum.
  if (patch.docMeta) {
    const incoming = safeguardingMeta((patch.docMeta as Record<string, unknown>).safeguarding);
    // A client can also hand-craft an oversized files array straight into the
    // generic patch — the append route's cap must hold here too.
    if (incoming.files.length > MAX_SAFEGUARDING_FILES) {
      throw new HttpError(400, `no more than ${MAX_SAFEGUARDING_FILES} safeguarding certificates`);
    }
    const stored = safeguardingMeta(current.docMeta?.safeguarding);
    if (stored.files.length) {
      const have = new Set(incoming.files.map((f) => f.objectKey));
      const files = [...incoming.files, ...stored.files.filter((f) => !have.has(f.objectKey))];
      // Carry the course-booked flag/date from the INCOMING patch (not `stored`): this
      // generic PATCH is the channel a client uses to both set AND clear a booking, so it
      // carries the full intended safeguarding state — preferring stored here would make a
      // clear impossible. (Append/delete derive from stored because they mutate one file,
      // not the booking.) All clients spread existing docMeta, so an unrelated patch keeps
      // the booking; re-deriving from files only is what would silently strip it.
      (patch.docMeta as Record<string, unknown>).safeguarding = safeguardingValue(
        files,
        incoming.markedCompliant,
        incoming.at,
        { courseBooked: incoming.courseBooked, courseDate: incoming.courseDate },
      );
      const docs = patch.docs as Record<string, boolean> | undefined;
      // The doc stays satisfied at the file minimum OR when a course is booked — don't
      // let the merge downgrade a course-booked club below the count threshold.
      if (
        docs &&
        docs.safeguarding === false &&
        (incoming.courseBooked || files.length >= MIN_SAFEGUARDING_FILES)
      ) {
        docs.safeguarding = true;
      }
      // The merge is read-modify-write off `current`: without pinning that version,
      // a safeguarding append landing between this read and the repo's own re-read
      // would be silently overwritten by the merged (stale) docMeta — the very loss
      // this guard exists to prevent. Pin so the race 409s and the client retries.
      patch.version ??= current.version;
    }
  }
  // A club that saves affiliation-form data (exco/leagues/coaches/ground) without
  // explicitly submitting never reaches 'complete' — but it's no longer truly
  // 'not_started' either. Promote the first such save to 'in_progress' so the admin can
  // tell a draft-in-progress club apart from one that never started. Never overrides an
  // explicit affiliation in the patch (submit sends 'complete'), and only fires from
  // 'not_started', so 'complete' is never downgraded on a post-submission edit.
  if (
    current.affiliation === 'not_started' &&
    !('affiliation' in patch) &&
    affiliationFieldsTouched(patch)
  ) {
    patch.affiliation = 'in_progress';
  }
  let updated = await applyClubPatch(ra.tenant, id, patch, ra.email);
  // On the not-complete → complete edge ONLY (the client re-sends affiliation:'complete'
  // on every post-submission edit), mint a player-registration link if absent and deliver
  // the chair onboarding bundle (reg link + tutorials). Gated on the edge so corrections
  // never re-mint (which would revoke a shared token); the send itself is gated on a
  // fresh mint so re-confirmations don't re-blast (and re-bill) WhatsApp/email.
  const becameComplete = current.affiliation !== 'complete' && patch.affiliation === 'complete';
  if (becameComplete) {
    updated = await mintAndDeliverOnboarding(c, ra.tenant, ra.email, updated);
  }
  if (renamed) {
    // Durable audit of every rename (admin or rep) — survives multi-hop renames the
    // single `previousName` field can't. Genuinely best-effort: the rename is already
    // committed, so a note-append failure must not fail the request (mirrors the
    // onboarding comm-event append at ~1016) — log and return the renamed club as-is.
    try {
      updated = await repo.appendClubNote(ra.tenant, id, {
        id: randomUUID(),
        text: `Renamed "${current.name}" → "${updated.name}"`,
        author: ra.email,
        at: now(),
      });
    } catch (noteErr) {
      console.error('rename audit-note append failed (rename still applied)', noteErr);
    }
  }
  return c.json(withPlayerCount(updated));
});

/**
 * The app base URL safe to put in an outbound (emailed/WhatsApped) link. Reuses
 * `resolveLoginUrl`'s trusted-origin logic, but refuses its `localhost` dev fallback in a
 * deployed stage — a dead `localhost` link in an approved WhatsApp template would hurt the
 * WABA's quality rating (and is useless to the chair). Returns null when no real host is
 * resolvable so the caller skips the auto-send (the chair can still be sent the link
 * manually from the shared modal). In local dev (STAGE 'local') a localhost base is fine.
 */
function deliverableBaseUrl(c: Context<HonoEnv>, tenant: string): string | null {
  const base = resolveLoginUrl(c, tenant);
  try {
    if (new URL(base).hostname === 'localhost' && process.env.STAGE !== 'local') return null;
  } catch {
    return null;
  }
  return base;
}

/**
 * Mint the club's player-registration link (only if it has none) and deliver the chair
 * onboarding bundle — reg link + how-to-use-the-app tutorials — over email + WhatsApp.
 *
 * The send is gated on a FRESH mint (the link didn't exist before this call): on later
 * re-confirmations the chair already holds the link, so we don't re-blast (or re-bill) the
 * channels — manual resend lives on the shared RegLinkModal. Best-effort: a failed
 * send/append is logged + recorded, never failing the affiliation write. Returns the
 * latest club (with the link, if minted).
 */
async function mintAndDeliverOnboarding(
  c: Context<HonoEnv>,
  tenant: string,
  by: string,
  club: Club,
): Promise<Club> {
  let current = club;
  let justMinted = false;
  if (!current.playerRegLink) {
    const token = randomUUID();
    const createdAt = now();
    try {
      await repo.putToken(token, tenant, current.id, createdAt);
      current = await applyClubPatch(
        tenant,
        current.id,
        { playerRegLink: { token, createdAt } },
        by,
      );
      justMinted = true;
    } catch (err) {
      console.error('reg-link mint failed on affiliation complete', err);
      return current;
    }
  }
  // Only auto-send on the first completion (fresh mint) — re-confirmations skip the blast.
  if (!justMinted || !current.playerRegLink) return current;

  const base = deliverableBaseUrl(c, tenant);
  if (!base) {
    console.warn('onboarding send skipped: no deliverable host (localhost in a deployed stage)');
    return current;
  }

  const chair = (
    current.exco as Record<string, { email?: string; cell?: string; name?: string }> | undefined
  )?.chair;
  const token = current.playerRegLink.token;
  const regLink = `${base}/register/${current.id}?t=${token}`;
  // Best-effort like the rest of this path: a tenant-config read fault must not fail the
  // affiliation write (the mint already succeeded). Degrade to the default tutorial set.
  const tenantConfig = await repo.getTenantConfig(tenant).catch((err) => {
    console.error('onboarding: tenant-config read failed, using default tutorials', err);
    return null;
  });
  const tutorialsConfig = tutorialsFor(tenantConfig);
  const absUrl = (u: string) =>
    /^https?:\/\//i.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`;
  const tutorials = {
    pageUrl: `${base}/tutorials`,
    videos: tutorialsConfig.map((v) => ({ title: v.title, url: absUrl(v.url) })),
  };
  const season = seasonLabel(new Date().getFullYear());

  const { results } = await sendChairOnboarding({
    chair: { name: chair?.name || current.chair || '', email: chair?.email, cell: chair?.cell },
    clubName: current.name,
    // WhatsApp rides a shared, dolphins-flavored WABA template — flag-gated (default
    // ON for existing tenants) so a new client can launch email-only.
    channels: hasFeature(tenantConfig, 'whatsappInvites', true)
      ? (['email', 'whatsapp'] as Channel[])
      : (['email'] as Channel[]),
    org: orgCopy(tenantConfig ?? { tenant }),
    regLink,
    tutorials,
    season,
  });

  // Record each channel outcome truthfully. One auditable row per channel, keyed so a
  // future retry of the same token's send replaces rather than duplicates.
  try {
    await repo.appendClubCommEvents(
      tenant,
      current.id,
      results.map((r) => ({
        id: randomUUID(),
        channel: r.channel,
        ...(r.to ? { to: r.to } : {}),
        status: r.status,
        ...(r.messageId ? { messageId: r.messageId } : {}),
        ...(r.error ? { error: r.error } : {}),
        at: now(),
        by,
        idempotencyKey: `reglink-${token}-${r.channel}`,
        kind: 'reglink' as const,
      })),
    );
  } catch (logErr) {
    console.error('onboarding comm-event append failed', logErr);
  }
  return current;
}

/**
 * DELETE /clubs/:id — admin-only club deletion (junk/abandoned signups, POPIA
 * erasure of the club's player data).
 *
 * The membership sweep runs BEFORE the data cascade so a crash leaves the club
 * intact and re-deletable (the sweep itself is idempotent), never a half-erased
 * club whose reps still hold access. It's a bounded N+1 over the tenant roster
 * (team-sized, same shape as GET /admin/users) because the markers don't carry
 * clubIds. Only rep memberships can reference a club (admins force clubIds: []),
 * so the last-admin guard never applies here. Re-delete (or unknown id) is a 404.
 */
app.delete('/clubs/:id', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const club = await repo.getClub(ra.tenant, id);
  if (!club) throw new HttpError(404, 'club not found');

  let users = 0;
  for (const entry of await repo.listTenantUsers(ra.tenant)) {
    const profile = await repo.getUser(entry.sub);
    const membership = profile?.memberships.find((m) => m.tenantId === ra.tenant);
    if (!profile || !membership || membership.role !== 'rep') continue;
    if (!membership.clubIds.includes(id)) continue;
    users++;

    const clubIds = membership.clubIds.filter((cid) => cid !== id);
    const others = profile.memberships.filter((m) => m.tenantId !== ra.tenant);
    if (clubIds.length > 0) {
      // Mere rescope: the rep keeps other clubs in this tenant. No sign-out — same as
      // a PATCH /admin/users scope edit (narrowing clubIds isn't a role change; the
      // next token refresh picks it up).
      await repo.putUser({ ...profile, memberships: [...others, { ...membership, clubIds }] });
      continue;
    }
    // Empty clubIds would violate the rep-≥1-club invariant — the membership goes.
    if (others.length === 0) {
      // Full offboard: same pieces as DELETE /admin/users/:sub. The sign-out AFTER the
      // Cognito delete is a guaranteed swallowed UserNotFoundException — kept in that
      // order so the refresh-token revoke still runs when the (best-effort, logged-not-
      // thrown) delete itself failed and the account survived.
      await repo.deleteUser(entry.sub);
      await adminDeleteCognitoUser(cognito, USER_POOL_ID, profile.email);
      await adminGlobalSignOut(cognito, USER_POOL_ID, profile.email);
    } else {
      // Memberships in OTHER tenants remain: keep the account, drop this tenant's
      // membership, and revoke refresh tokens so the removed access can't be re-minted.
      await repo.putUser({ ...profile, memberships: others });
      await adminGlobalSignOut(cognito, USER_POOL_ID, profile.email);
    }
  }

  const removed = await repo.eraseClubData(ra.tenant, club);
  return c.json({ ok: true, removed: { ...removed, users } });
});

/** List a club's player registrations (rep: own only; admin: any in tenant). */
app.get('/clubs/:id/players', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertClubAccess(ra, id);
  return c.json(await repo.listPlayers(ra.tenant, id));
});

/**
 * Register a player directly from the club portal (chair-filled Union form). Unlike the
 * public token link, this is authenticated + club-scoped. Shares the naturalKey dedup with
 * the public path so a person can't be registered twice. Required fields mirror the Union
 * form; `dob` is derived from the 13-digit RSA ID.
 */
app.post('/clubs/:id/players', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertClubAccess(ra, id);
  // cfg feeds the league-key validation below; the club read is the 404 check.
  const cfg = await repo.getTenantConfig(ra.tenant);
  const club = await repo.getClub(ra.tenant, id);
  if (!club) throw new HttpError(404, 'club not found');
  const body = await c.req.json<Partial<PlayerRegistration>>();
  const required: Array<keyof PlayerRegistration> = [
    'firstName',
    'lastName',
    'idNumber',
    'race',
    'gender',
    'nationality',
    'cell',
    'team',
    'district',
  ];
  // Treat present-but-blank (whitespace-only) values as missing: a blank idNumber
  // would otherwise pass this gate and silently fall through to the name+dob key.
  const missing = required.filter((k) => {
    const v = body[k];
    return v == null || String(v).trim() === '';
  });
  if (missing.length) throw new HttpError(400, `missing required fields: ${missing.join(', ')}`);
  // SA citizens derive dob from the RSA ID; non-SA (passport) supply it directly.
  const dob = resolvePlayerDob(body);
  if (!dob) {
    throw new HttpError(
      400,
      'provide a valid 13-digit RSA ID, or a passport/visa number with date of birth',
    );
  }
  // Team must be a real league key in the tenant catalogue.
  const leagueKeys = new Set((cfg?.leagues ?? []).map((l) => l.key));
  if (leagueKeys.size && !leagueKeys.has(body.team!)) {
    throw new HttpError(400, 'unknown team/league');
  }
  const isMinor = computeIsMinor(dob);
  if (isMinor && !body.guardianName) {
    throw new HttpError(400, 'guardianName required for minors (POPIA)');
  }
  const naturalKey = playerNaturalKey({ ...body, dob });
  const player: PlayerRegistration = {
    naturalKey,
    clubId: id,
    firstName: body.firstName!,
    lastName: body.lastName!,
    dob,
    cell: body.cell,
    email: body.email,
    isMinor,
    guardianName: body.guardianName,
    idType: body.idType ?? 'sa-id',
    idNumber: normalizeId(body.idNumber),
    nationality: body.nationality,
    race: body.race,
    gender: body.gender,
    postalAddress: body.postalAddress,
    postalCode: body.postalCode,
    team: body.team,
    district: body.district,
    lastClub: body.lastClub,
    battingHand: body.battingHand,
    bowlingHand: body.bowlingHand,
    battingType: body.battingType,
    bowlerType: body.bowlerType,
    isAllRounder: body.isAllRounder ?? false,
    isWk: body.isWk ?? false,
    status: 'active',
    registeredBy: ra.email,
    registeredVia: 'portal',
    version: 0,
    consentAt: now(),
    createdAt: now(),
  };
  try {
    await repo.createPlayer(ra.tenant, player);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new HttpError(409, 'a player with these details is already registered for this club');
    }
    throw err;
  }
  return c.json(player, 201);
});

/** Mint a presigned PUT for a player's ID document (image or PDF). */
app.post('/clubs/:id/players/:nk/id-doc/upload-url', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertClubAccess(ra, id);
  const { contentType } = await c.req
    .json<{ contentType?: string }>()
    .catch(() => ({ contentType: undefined }));
  const ct = contentType && ID_DOC_TYPES.has(contentType) ? contentType : 'application/pdf';
  const ext = ct === 'image/jpeg' ? 'jpg' : ct === 'image/png' ? 'png' : 'pdf';
  // POPIA data-minimisation: the object key must not embed the natural key (now the
  // player's ID number). A random token is enough — nothing parses nk back out of it.
  const objectKey = `${ra.tenant}/${id}/player-id-${randomUUID()}.${ext}`;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: UPLOADS_BUCKET, Key: objectKey, ContentType: ct }),
    { expiresIn: 300 },
  );
  return c.json({ uploadUrl: url, objectKey, contentType: ct });
});

/** Record an uploaded ID document on the player (stores idDocMeta). */
app.patch('/clubs/:id/players/:nk/id-doc', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const nk = c.req.param('nk');
  assertClubAccess(ra, id);
  const meta = await c.req.json<{ objectKey: string; size: number; contentType?: string }>();
  if (!meta.objectKey) throw new HttpError(400, 'objectKey required');
  if (typeof meta.size !== 'number' || meta.size <= 0 || meta.size > MAX_ID_DOC_BYTES) {
    throw new HttpError(400, 'file must be a non-empty image/PDF under 5 MB');
  }
  const current = await repo.getPlayer(ra.tenant, id, nk);
  if (!current) throw new HttpError(404, 'player not found');
  // Best-effort delete of a replaced object (POPIA data-minimisation), never blocking.
  const prevKey = current.idDocMeta?.objectKey;
  if (prevKey && prevKey !== meta.objectKey && !prevKey.startsWith('local/')) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: UPLOADS_BUCKET, Key: prevKey }));
    } catch (err) {
      console.warn(`id-doc replace: failed to delete prior object ${prevKey}`, err);
    }
  }
  try {
    const updated = await repo.updatePlayer(ra.tenant, id, nk, {
      idDocMeta: {
        objectKey: meta.objectKey,
        size: meta.size,
        contentType: meta.contentType,
        uploadedAt: now(),
      },
      version: current.version,
    });
    return c.json(updated);
  } catch (err) {
    if (err instanceof VersionConflictError) throw new HttpError(409, 'player changed; refetch');
    throw err;
  }
});

/** Mint a presigned GET so a rep or admin can preview a player's stored ID document. */
app.post('/clubs/:id/players/:nk/id-doc/view-url', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const nk = c.req.param('nk');
  assertClubAccess(ra, id);
  const player = await repo.getPlayer(ra.tenant, id, nk);
  const objectKey = player?.idDocMeta?.objectKey;
  if (!objectKey) throw new HttpError(404, 'no ID document on record');
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: UPLOADS_BUCKET,
      Key: objectKey,
      ResponseContentType: player!.idDocMeta?.contentType ?? 'application/pdf',
      ResponseContentDisposition: 'inline',
    }),
    { expiresIn: 900 },
  );
  return c.json({ viewUrl: url });
});

/**
 * Remove a player from the roster (chair-facing). Scoped by assertClubAccess so a rep can
 * only delete players in their own club. Blocks a player who is mid-transfer: the source
 * status is set atomically by createClearance, and there is no cancel-clearance endpoint, so
 * an open clearance must be resolved by a Union admin before the player can be deleted. The
 * repo delete is additionally conditional (see deletePlayer) to close the create-clearance
 * race — a lost race surfaces here as a 409.
 */
app.delete('/clubs/:id/players/:nk', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertClubAccess(ra, id);
  const player = await repo.getPlayer(ra.tenant, id, c.req.param('nk'));
  if (!player) throw new HttpError(404, 'player not found');
  if (player.status === 'clearance-pending') {
    throw new HttpError(
      409,
      'this player has an open clearance — it must be resolved by a Union admin first',
    );
  }
  try {
    await repo.deletePlayer(ra.tenant, player);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new HttpError(409, 'player is mid-transfer or already removed — refresh and try again');
    }
    throw err;
  }
  return c.json({ ok: true });
});

// ── Player clearances (inter-club transfers) ──

/**
 * Initiate a clearance request. The DESTINATION club initiates (it wants a player who
 * currently sits at another club). Because this is a deliberate cross-club write,
 * assertClubAccess(:id) alone is insufficient — it only proves the rep owns the path club.
 * We require the path club to be the destination and load the referenced player to confirm
 * it exists at fromClubId; we never read the rest of the source roster.
 */
app.post('/clubs/:id/clearances', async (c) => {
  const ra = c.get('requestAuth')!;
  const toClubId = c.req.param('id');
  assertClubAccess(ra, toClubId);
  const body = await c.req.json<{
    fromClubId?: string;
    playerNaturalKey?: string;
    idNumber?: string;
    note?: string;
  }>();
  // The destination rep identifies the player by ID number (they don't know the
  // source club's internal naturalKey); playerNaturalKey is also accepted directly.
  if (!body.fromClubId || (!body.playerNaturalKey && !body.idNumber)) {
    throw new HttpError(400, 'fromClubId and a player idNumber (or playerNaturalKey) are required');
  }
  if (body.fromClubId === toClubId)
    throw new HttpError(400, 'source and destination are the same club');
  const [fromClub, toClub] = await Promise.all([
    repo.getClub(ra.tenant, body.fromClubId),
    repo.getClub(ra.tenant, toClubId),
  ]);
  if (!fromClub || !toClub) throw new HttpError(404, 'club not found');
  // Resolve the player at the source club — by naturalKey if given, else by ID number.
  // Only the matched player is read; the rest of the source roster is never exposed.
  const player = body.playerNaturalKey
    ? await repo.getPlayer(ra.tenant, body.fromClubId, body.playerNaturalKey)
    : await findPlayerByIdNumber(ra.tenant, body.fromClubId, body.idNumber);
  if (!player) throw new HttpError(404, 'player not found at source club');
  // Reject a duplicate active request for the same player (already pending elsewhere).
  const existing = await repo.listClearancesForSource(ra.tenant, body.fromClubId);
  if (existing.some((x) => x.playerNaturalKey === player.naturalKey && x.status === 'pending')) {
    throw new HttpError(409, 'a clearance request for this player is already pending');
  }
  const clearance = {
    id: randomUUID(),
    playerNaturalKey: player.naturalKey,
    playerName: `${player.firstName} ${player.lastName}`,
    idNumber: player.idNumber,
    team: player.team,
    fromClubId: body.fromClubId,
    toClubId,
    fromClubName: fromClub.name,
    toClubName: toClub.name,
    requestedAt: now(),
    requestedBy: ra.email,
    note: body.note,
    feesCleared: false,
    misconductCleared: false,
    status: 'pending' as const,
    clubApprovedAt: null,
    adminOverrideAt: null,
    version: 0,
  };
  try {
    await repo.createClearance(ra.tenant, clearance);
  } catch (err) {
    // Race-safe backstop for the TOCTOU window above: two concurrent creates for the
    // same player both pass the listClearancesForSource check; the atomic guard rejects
    // the loser.
    if (err instanceof repo.DuplicatePendingClearanceError) throw new HttpError(409, err.message);
    // Same shape for the getClub pre-checks: an admin club delete landing between them
    // and the write fails the destination existence check instead of orphaning a mirror.
    if (err instanceof repo.DestinationClubGoneError) throw new HttpError(409, err.message);
    throw err;
  }
  // Best-effort chairman heads-up (never throws). This route doesn't otherwise need the
  // tenant config — it's read only for the whatsappInvites gate, and a read fault just
  // degrades to the flag's default inside notifyClearanceOpened.
  const tenantConfig = await repo.getTenantConfig(ra.tenant).catch(() => null);
  await notifyClearanceOpened(ra.tenant, tenantConfig, fromClub, clearance, ra.email);
  return c.json(clearance, 201);
});

/** A club's clearances: ones it must action (source) + ones moving to it (destination). */
app.get('/clubs/:id/clearances', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertClubAccess(ra, id);
  const [incoming, outbound] = await Promise.all([
    repo.listClearancesForSource(ra.tenant, id),
    repo.listInboundForDest(ra.tenant, id),
  ]);
  return c.json({ incoming, outbound });
});

/**
 * The source club acts on a clearance: toggle fees/misconduct, or (when both are
 * confirmed) issue it — which moves the player to the destination. Only the source
 * club may act. `action: 'issue'` requires both confirmations.
 */
app.patch('/clubs/:id/clearances/:cid', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const cid = c.req.param('cid');
  assertClubAccess(ra, id);
  const current = await repo.getClearance(ra.tenant, id, cid);
  if (!current) throw new HttpError(404, 'clearance not found');
  if (current.fromClubId !== id)
    throw new HttpError(403, 'only the source club may action this clearance');
  if (current.status !== 'pending') throw new HttpError(409, 'clearance already resolved');
  const body = await c.req.json<{
    feesCleared?: boolean;
    misconductCleared?: boolean;
    action?: 'issue';
    version?: number;
  }>();
  try {
    if (body.action === 'issue') {
      const fees = body.feesCleared ?? current.feesCleared;
      const misconduct = body.misconductCleared ?? current.misconductCleared;
      if (!fees || !misconduct)
        throw new HttpError(400, 'confirm fees and misconduct before issuing');
      const resolved = await repo.resolveClearance(ra.tenant, id, cid, {
        mode: 'club',
        at: now(),
        expectedVersion: body.version,
      });
      return c.json(resolved);
    }
    const updated = await repo.updateClearanceFlags(ra.tenant, id, cid, {
      feesCleared: body.feesCleared,
      misconductCleared: body.misconductCleared,
      expectedVersion: body.version,
    });
    return c.json(updated);
  } catch (err) {
    if (err instanceof VersionConflictError) throw new HttpError(409, 'clearance changed; refetch');
    if (err instanceof repo.PlayerExistsAtDestinationError) throw new HttpError(409, err.message);
    if (err instanceof repo.DestinationClubGoneError) throw new HttpError(409, err.message);
    throw err;
  }
});

/** Save the exec committee; also flips docs.exco true. */
app.post('/clubs/:id/exco', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertClubAccess(ra, id);
  const exco = await c.req.json<Record<string, unknown>>();
  const current = await repo.getClub(ra.tenant, id);
  if (!current) throw new HttpError(404, 'club not found');
  // Saving the exco is real affiliation-form progress: promote a not-yet-started club to
  // 'in_progress' (this path bypasses PATCH /clubs/:id, so it carries its own bump). Only
  // include the key when it changes — a 'complete' or already-'in_progress' club is left as-is.
  const updated = await applyClubPatch(
    ra.tenant,
    id,
    {
      exco,
      docs: { ...current.docs, exco: true },
      ...(current.affiliation === 'not_started' ? { affiliation: 'in_progress' as const } : {}),
    },
    ra.email,
  );
  return c.json(updated);
});

/** Mint a presigned PUT for a compliance document (rep or admin). */
app.post('/clubs/:id/docs/:key/upload-url', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const key = c.req.param('key');
  assertDocKey(key);
  assertClubAccess(ra, id);
  // PDF and Word are accepted (Google Docs exports as .docx/.pdf). A MISSING
  // contentType falls back to PDF (legacy no-body clients); a present-but-unknown
  // one must 400 here — silently signing it as PDF would let the upload through
  // only for the record PATCH to reject it, orphaning the object in S3. The
  // presign locks the upload to the echoed type, so the client must PUT with
  // exactly this Content-Type.
  const { contentType } = await c.req
    .json<{ contentType?: string }>()
    .catch(() => ({ contentType: undefined }));
  if (contentType !== undefined && !DOC_CONTENT_TYPES[contentType]) {
    throw new HttpError(400, 'contentType must be PDF or Word');
  }
  const ct = contentType ?? 'application/pdf';
  const objectKey = `${ra.tenant}/${id}/${key}-${randomUUID()}.${DOC_CONTENT_TYPES[ct]}`;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: UPLOADS_BUCKET,
      Key: objectKey,
      ContentType: ct,
    }),
    { expiresIn: 300 },
  );
  return c.json({ uploadUrl: url, objectKey, contentType: ct });
});

/** Mark a document uploaded with its stored object metadata. */
app.patch('/clubs/:id/docs/:key', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const key = c.req.param('key');
  assertDocKey(key);
  assertClubAccess(ra, id);
  const meta = await c.req.json<{ objectKey: string; size: number; contentType?: string }>();
  if (!meta.objectKey) throw new HttpError(400, 'objectKey required');
  assertOwnObjectKey(ra.tenant, id, meta.objectKey);
  if (typeof meta.size !== 'number' || meta.size <= 0 || meta.size > MAX_DOC_BYTES) {
    throw new HttpError(400, 'file must be a non-empty PDF or Word document under 10 MB');
  }
  if (meta.contentType !== undefined && !DOC_CONTENT_TYPES[meta.contentType]) {
    throw new HttpError(400, 'contentType must be PDF or Word');
  }
  const current = await repo.getClub(ra.tenant, id);
  if (!current) throw new HttpError(404, 'club not found');
  const docMeta = current.docMeta ?? {};
  if (key === 'safeguarding') {
    // Safeguarding certificates are per-person and APPEND — files coexist (no
    // delete-previous), and the doc only completes at the 2-person minimum.
    const norm = safeguardingMeta(docMeta[key]);
    const exists = norm.files.some((f) => f.objectKey === meta.objectKey);
    if (!exists && norm.files.length >= MAX_SAFEGUARDING_FILES) {
      throw new HttpError(400, `no more than ${MAX_SAFEGUARDING_FILES} safeguarding certificates`);
    }
    const files = exists
      ? norm.files
      : [
          ...norm.files,
          {
            objectKey: meta.objectKey,
            size: meta.size,
            contentType: meta.contentType,
            uploadedAt: now(),
          },
        ];
    const updated = await applyClubPatch(
      ra.tenant,
      id,
      {
        docs: {
          ...current.docs,
          // A booked course keeps the doc satisfied independently of the file count, so
          // appending a (sub-minimum) certificate must not undo a course-booked club.
          [key]:
            norm.markedCompliant || norm.courseBooked || files.length >= MIN_SAFEGUARDING_FILES,
        },
        // Preserve any course-booked flag/date — uploading a certificate must not strip it.
        docMeta: {
          ...docMeta,
          [key]: safeguardingValue(files, norm.markedCompliant, norm.at, {
            courseBooked: norm.courseBooked,
            courseDate: norm.courseDate,
          }),
        },
        // Append is read-modify-write: pin the version read above so a parallel
        // upload 409s (client retries) instead of silently dropping a file.
        version: current.version,
      },
      ra.email,
    );
    return c.json(updated);
  }
  // Replacing a wrongly-uploaded file: best-effort delete the previous S3 object so a
  // stale PDF (PII) isn't orphaned in the bucket (POPIA data-minimisation). A failed
  // delete must never fail the replace, and we skip non-S3 keys (e.g. local dev).
  const prev = docMeta[key] as { objectKey?: string } | undefined;
  const prevKey = prev?.objectKey;
  if (prevKey && prevKey !== meta.objectKey && !prevKey.startsWith('local/')) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: UPLOADS_BUCKET, Key: prevKey }));
    } catch (err) {
      // Orphaned object is recoverable via a bucket lifecycle rule; don't block the replace.
      // Log once so accumulation is observable rather than silent.
      console.warn(`docs replace: failed to delete prior object ${prevKey}`, err);
    }
  }
  const updated = await applyClubPatch(
    ra.tenant,
    id,
    {
      docs: { ...current.docs, [key]: true },
      docMeta: { ...docMeta, [key]: { ...meta, uploadedAt: now() } },
    },
    ra.email,
  );
  return c.json(updated);
});

/**
 * Remove one stored safeguarding certificate (the only multi-file doc). Recomputes
 * the docs flag from the remaining files; an admin override keeps the doc compliant.
 */
app.delete('/clubs/:id/docs/:key/file', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const key = c.req.param('key');
  assertDocKey(key);
  assertClubAccess(ra, id);
  if (key !== 'safeguarding') {
    throw new HttpError(400, 'per-file removal only applies to safeguarding');
  }
  const { objectKey } = await c.req.json<{ objectKey?: string }>().catch(() => ({}) as never);
  if (!objectKey) throw new HttpError(400, 'objectKey required');
  assertOwnObjectKey(ra.tenant, id, objectKey);
  const current = await repo.getClub(ra.tenant, id);
  if (!current) throw new HttpError(404, 'club not found');
  const docMeta = current.docMeta ?? {};
  const norm = safeguardingMeta(docMeta[key]);
  if (!norm.files.some((f) => f.objectKey === objectKey)) {
    throw new HttpError(404, 'no such file on record for this document');
  }
  // Best-effort S3 delete (PII minimisation); never block the record update.
  if (!objectKey.startsWith('local/')) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: UPLOADS_BUCKET, Key: objectKey }));
    } catch (err) {
      console.warn(`docs remove: failed to delete object ${objectKey}`, err);
    }
  }
  const files = norm.files.filter((f) => f.objectKey !== objectKey);
  const nextMeta = { ...docMeta };
  // Keep the record (and its course-booked flag/date) whenever any of files / override /
  // course-booked still holds — only a fully-empty state drops the key entirely.
  if (files.length || norm.markedCompliant || norm.courseBooked) {
    nextMeta[key] = safeguardingValue(files, norm.markedCompliant, norm.at, {
      courseBooked: norm.courseBooked,
      courseDate: norm.courseDate,
    });
  } else {
    delete nextMeta[key];
  }
  const updated = await applyClubPatch(
    ra.tenant,
    id,
    {
      docs: {
        ...current.docs,
        [key]: norm.markedCompliant || norm.courseBooked || files.length >= MIN_SAFEGUARDING_FILES,
      },
      docMeta: nextMeta,
      // Same read-modify-write pinning as the append path.
      version: current.version,
    },
    ra.email,
  );
  return c.json(updated);
});

/** Mint a presigned GET so a rep or admin can preview a stored compliance doc inline. */
app.post('/clubs/:id/docs/:key/view-url', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const key = c.req.param('key');
  assertDocKey(key);
  assertClubAccess(ra, id);
  const { objectKey: requested } = await c.req
    .json<{ objectKey?: string }>()
    .catch(() => ({}) as { objectKey?: string });
  const club = await repo.getClub(ra.tenant, id);
  if (!club) throw new HttpError(404, 'club not found');
  const docMeta = club.docMeta ?? {};
  // Resolve the target file. The requested objectKey must be ON RECORD for this
  // doc — that check is the security gate against presigning arbitrary bucket
  // keys. Safeguarding holds several files (default: first, for old clients);
  // single-file docs ignore a matching param and 404 a foreign one.
  let entry: { objectKey?: string; contentType?: string } | undefined;
  if (key === 'safeguarding') {
    const norm = safeguardingMeta(docMeta[key]);
    entry = requested ? norm.files.find((f) => f.objectKey === requested) : norm.files[0];
  } else {
    const meta = docMeta[key] as { objectKey?: string; contentType?: string } | undefined;
    // Only real uploads have an objectKey; admin "mark compliant" overrides do not.
    entry = meta?.objectKey && (!requested || requested === meta.objectKey) ? meta : undefined;
  }
  if (!entry?.objectKey) throw new HttpError(404, 'no file on record for this document');
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: UPLOADS_BUCKET,
      Key: entry.objectKey,
      ResponseContentType: entry.contentType ?? 'application/pdf',
      ResponseContentDisposition: 'inline',
    }),
    { expiresIn: 900 },
  );
  return c.json({ viewUrl: url });
});

/** Generate a fresh player-registration link (admin or rep). Server-side token. */
app.post('/clubs/:id/reg-link', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertClubAccess(ra, id);
  const current = await repo.getClub(ra.tenant, id);
  if (!current) throw new HttpError(404, 'club not found');
  const token = randomUUID();
  const createdAt = now();
  await repo.putToken(token, ra.tenant, id, createdAt);
  // Revoke the previous link so regenerating truly invalidates the old one.
  const oldToken = current.playerRegLink?.token;
  if (oldToken && oldToken !== token) await repo.deleteToken(oldToken);
  const updated = await applyClubPatch(
    ra.tenant,
    id,
    { playerRegLink: { token, createdAt } },
    ra.email,
  );
  return c.json({ playerRegLink: updated.playerRegLink });
});

/** Append a note to the club's communication log (admin only) — audited. */
app.post('/clubs/:id/notes', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const { text } = await c.req.json<{ text?: string }>();
  if (!text || !text.trim()) throw new HttpError(400, 'note text required');
  const note = { id: randomUUID(), text: text.trim(), author: ra.email, at: now() };
  try {
    // appendClubNote's ConditionExpression (attribute_exists) is the existence
    // check — no separate read, so there's no delete-race window.
    const updated = await repo.appendClubNote(ra.tenant, id, note);
    return c.json(withPlayerCount(updated));
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException')
      throw new HttpError(404, 'club not found');
    throw err;
  }
});

/**
 * Share the club's released fixtures with its registered players over email and/or
 * WhatsApp. Triggered by the club CHAIR (a rep), so guarded by assertClubAccess ONLY —
 * NOT requireAdmin, which would 403 the chair (its only user). Email carries the full
 * schedule (built server-side, never trusted from the client); WhatsApp sends a
 * pre-approved templated heads-up (no link — players aren't portal users and the portal
 * is auth-gated). Idempotency-keyed like send-invite. Minors are skipped (no guardian
 * contact on file). Per-recipient outcomes are summarized — the response and the comm
 * log carry PII-free aggregate counts only.
 */
app.post('/clubs/:id/send-fixtures', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertClubAccess(ra, id);
  const { channels, idempotencyKey } = await c.req.json<{
    channels?: Channel[];
    idempotencyKey?: string;
  }>();
  if (!Array.isArray(channels) || channels.length === 0)
    throw new HttpError(400, 'channels required');
  const unknown = channels.find((ch) => ch !== 'email' && ch !== 'whatsapp');
  if (unknown) throw new HttpError(400, `unknown channel: ${unknown}`);
  if (!idempotencyKey) throw new HttpError(400, 'idempotencyKey required');

  const club = await repo.getClub(ra.tenant, id);
  if (!club) throw new HttpError(404, 'club not found');

  // Claim the idempotency key FIRST so a lost-response retry replays the stored summary
  // even if the mutable state below has since changed (e.g. the admin un-released the
  // series). A prior/concurrent claim short-circuits before any re-derivation.
  const prior = await repo.claimInviteSend(ra.tenant, id, idempotencyKey, channels, 'fixtures');
  if (prior) return c.json({ results: prior.results, deduped: true, pending: prior.pending });

  // Build the schedule from THIS club's released series, server-side — never trust the
  // client for what gets broadcast. If there's nothing to share, release the just-claimed
  // marker so this 409 doesn't poison a legitimate retry once fixtures are released.
  const allSeries = await repo.listSeries(ra.tenant);
  // The TENANT's calendar day, not the Lambda's. Lambda runs UTC and the union is
  // UTC+2, so a plain `dayjs()` here is still on yesterday until 02:00 local — long
  // enough for the chair to see fixtures in the portal (which reads the browser's local
  // day) while the broadcast refuses to send them, on the one morning that matters.
  const today = dayjs().utcOffset(TENANT_UTC_OFFSET_MINUTES).format('YYYY-MM-DD');
  const releasedSeries = allSeries.filter((s) => {
    if (!s.released || !Array.isArray(s.teams)) return false;
    // Delayed activation (ADR 0008): a junior series is released up front but stays
    // invisible until `activateFrom`. This MIRRORS the club portal's read-side gate —
    // broadcasting a schedule the chair can't see in their own portal would be worse
    // than not sending it. Absent/malformed ⇒ visible, so legacy series are unaffected.
    if (s.activateFrom && s.activateFrom > today) return false;
    // A multi-team club participates under its `tm_…` ids, not its clubId — match
    // against the club's resolved team set so its fixtures aren't missed.
    const mine = new Set(teamIdsForClub(s, id));
    return s.teams.some((t) => mine.has(t));
  });
  if (releasedSeries.length === 0) {
    await repo.releaseInviteClaim(ra.tenant, id, idempotencyKey);
    throw new HttpError(409, 'no released fixtures to share');
  }
  const clubsById = new Map((await repo.listClubs(ra.tenant)).map((cl) => [cl.id, cl]));
  const { text: scheduleText, season } = buildClubSchedule(club, releasedSeries, clubsById);

  const players = await repo.listPlayers(ra.tenant, id);

  const { results } = await sendClubFixtures({ club, players, channels, scheduleText, season });
  // Summarize per-recipient results into ≤2 PII-free per-channel rows. Per-recipient
  // outcomes never leave the request (POPIA minimisation); the chair only needs counts.
  const { summaryResults, commEvents } = summarizeFixtures(
    results,
    channels,
    ra.email,
    idempotencyKey,
  );
  try {
    await repo.appendClubCommEvents(ra.tenant, id, commEvents);
  } catch (err) {
    console.error('comm-log append failed after fixtures send', err);
  }
  await repo.completeInviteSend(ra.tenant, id, idempotencyKey, summaryResults);
  return c.json({ results: summaryResults }, 201);
});

// ───────────────────────── Series ─────────────────────────

/**
 * `Series.schedule` shape guard (ADR 0008): the calendar binding a create/regenerate
 * confirmed, so a later regenerate reproduces the same dates. Unlike a competition's
 * binding (`validateCompetitions`), a series names a concrete BLOCK, not a position — it
 * is generated once against whatever calendar was current at the time, not resolved
 * through a structure. Checked against the tenant's OWN config, so a dangling
 * calendarId/blockId can never be written from either POST or PATCH.
 */
function validateSeriesSchedule(
  schedule: unknown,
  config: TenantConfig,
): asserts schedule is SeriesSchedule {
  const sched = schedule as Partial<SeriesSchedule> | undefined;
  if (!sched || typeof sched !== 'object')
    throw new HttpError(400, 'series schedule must be an object');
  if (typeof sched.calendarId !== 'string' || !sched.calendarId.trim())
    throw new HttpError(400, 'series schedule needs a calendarId');
  const calendar = (config.calendars ?? []).find((cal) => cal.id === sched.calendarId);
  if (!calendar)
    throw new HttpError(400, `series schedule points at a calendar that doesn't exist`);
  if (typeof sched.blockId !== 'string' || !sched.blockId.trim())
    throw new HttpError(400, 'series schedule needs a blockId');
  if (!calendar.blocks.some((b) => b.id === sched.blockId))
    throw new HttpError(
      400,
      `series schedule points at a block that doesn't exist on that calendar`,
    );
  assertValidCadence(sched.cadence, 'series schedule');
  if (sched.slots !== undefined) assertValidTimeSlots(sched.slots, 'series schedule');
  if (sched.roundsPerDay !== undefined && ![1, 2].includes(sched.roundsPerDay))
    throw new HttpError(400, 'series schedule roundsPerDay must be 1 or 2');
  if (sched.roundsPerDay === 2 && (sched.slots ?? []).length !== 2)
    throw new HttpError(400, 'series schedule needs exactly two slots for two rounds per day');
}

app.get('/series', async (c) => {
  const { tenant } = c.get('requestAuth')!;
  return c.json(await repo.listSeries(tenant));
});

app.post('/series', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const series = await c.req.json<Series>();
  // `startDate` is the gsi1 SORT KEY. An empty string is rejected outright by DynamoDB
  // for a key attribute — but dynalite accepts it, so this can only be caught here, and
  // a client that sent one would 500 mid-way through a multi-group generate having
  // already written the earlier series.
  if (typeof series?.startDate !== 'string' || !series.startDate.trim())
    throw new HttpError(400, 'a series needs a start date');
  // A POST must never overwrite an existing series. `putSeries` is an unconditional Put
  // and this body is built fresh with `released: false`, `releasedAt: null`, `version: 1`
  // — so a POST landing on a live id would recall a schedule clubs and players have
  // already been sent AND reset the optimistic-concurrency counter. Season-run generation
  // derives deterministic ids (`s-<run>-<stage>-<group>`), so a client working from a
  // stale series cache can pick the create branch for a series that already exists.
  // 409 rather than silent success: the caller refetches and PATCHes instead.
  if (await repo.getSeries(tenant, series.id))
    throw new HttpError(409, 'a series with that id already exists');
  // A schedule binding is optional (legacy series schedule from startDate/endDate), but
  // when present it must name a real calendarId/blockId on THIS tenant with a valid
  // cadence — regenerate trusts it blindly, so a dangling reference here would only
  // surface much later as a silent no-op. Unlike PATCH, `null` is NOT a special case
  // here — there is no stored binding on a brand-new series for it to clear, so it just
  // 400s through the same "must be an object" guard as any other non-object.
  if (series.schedule !== undefined) {
    const config = await repo.getTenantConfig(tenant);
    if (!config) throw new HttpError(404, 'tenant not found');
    validateSeriesSchedule(series.schedule, config);
  }
  // Fixtures are generated client-side and POSTed whole.
  series.version = 1;
  series.released = series.released ?? false;
  series.releasedAt = series.releasedAt ?? null;
  await repo.putSeries(tenant, series);
  return c.json(series, 201);
});

app.patch('/series/:id', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const patch = await c.req.json<Partial<Series>>();
  const current = await repo.getSeries(ra.tenant, id);
  if (!current) throw new HttpError(404, 'series not found');
  // Same gsi1-sort-key guard as POST. `updateSeries` rewrites `gsi1sk` from the patched
  // `startDate` on every write, so a blank one here is the identical DynamoDB failure,
  // with the identical property that dynalite won't catch it.
  if (
    patch.startDate !== undefined &&
    (typeof patch.startDate !== 'string' || !patch.startDate.trim())
  )
    throw new HttpError(400, 'a series needs a start date');
  // Same schedule-binding guard as POST — a PATCH can introduce or replace the
  // calendar/block a regenerate reproduces, so it needs the identical check. `null` is
  // the one exception: a PATCH (never POST — there is nothing to clear on a brand-new
  // series) may send it to CLEAR a stored binding, reverting the series to legacy
  // startDate/endDate scheduling. Anything else non-object still 400s via the guard.
  if (patch.schedule === null) {
    // Passed through as-is below; `updateSeries` spreads the patch over `current`, so
    // this null overwrites whatever binding was stored.
  } else if (patch.schedule !== undefined) {
    const config = await repo.getTenantConfig(ra.tenant);
    if (!config) throw new HttpError(404, 'tenant not found');
    validateSeriesSchedule(patch.schedule, config);
  }
  // Approval gate. Approve/unapprove stamps approvedAt server-side. Editing the
  // fixtures of a DRAFT series recalls any prior approval (must re-approve before
  // release); a live series keeps its state so in-season edits still reach clubs.
  if (typeof patch.approved === 'boolean') {
    patch.approvedAt = patch.approved ? now() : null;
  } else if (patch.fixtures !== undefined && !current.released) {
    patch.approved = false;
    patch.approvedAt = null;
  }
  // A series can only be released once approved (in this patch or already on record).
  if (patch.released === true) {
    const approved = patch.approved ?? current.approved ?? false;
    if (!approved) throw new HttpError(400, 'fixtures must be approved before release');
  }
  // Releasing publishes the schedule to clubs — a series carrying a known
  // ground/date/time double-booking must not go out. Checked against EVERY series in
  // the tenant (drafts included: a clash with a draft is still a double-booking the
  // season carries). 409 with the clash list so the console can show exactly what to
  // fix; recalls (released:false) are never blocked.
  //
  // Deliberately NO override flag. Product decision: a known double-booking must never
  // be released, full stop — there is no "release anyway" escape hatch here (contrast
  // the import script's --allow-clashes, which is a build-time authoring aid, not a
  // publish-time gate). This includes series that are themselves about to be
  // superseded: while the 4 old `s-planb-premier-*-t20-top6/-bottom6/top4/bottom4`
  // series still exist as unreleased drafts, their untimed fixtures still occupy whole
  // ground-days and will 409 a release of their replacements. That is correct — they
  // really do clash while both exist. The fix is operational (prune the superseded
  // series, or fix the clashing venues), never to bypass the gate; see the "Ordering
  // consequence" section of docs/runbooks/planb-fixtures-import.md.
  if (patch.released === true && !current.released) {
    const [allSeries, clubs, venues] = await Promise.all([
      repo.listSeries(ra.tenant),
      repo.listClubs(ra.tenant),
      repo.listVenues(ra.tenant),
    ]);
    const subject = { ...current, ...patch, id } as Series;
    const clashes = findReleaseClashes(subject, allSeries, clubs, venues);
    if (clashes.length) {
      const shown = clashes.slice(0, 3).join('; ');
      throw new HttpError(
        409,
        `Release blocked — ${clashes.length} venue clash(es): ${shown}${clashes.length > 3 ? ` … +${clashes.length - 3} more` : ''}. Fix the venues (or times), then release.`,
      );
    }
  }
  // Release/recall stamps releasedAt server-side for trustworthy timestamps.
  if (typeof patch.released === 'boolean') {
    patch.releasedAt = patch.released ? now() : null;
  }
  try {
    return c.json(await repo.updateSeries(ra.tenant, id, patch));
  } catch (err) {
    if (err instanceof VersionConflictError) throw new HttpError(409, 'series changed; refetch');
    throw err;
  }
});

app.delete('/series/:id', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  await repo.deleteSeries(tenant, c.req.param('id'));
  return c.json({ ok: true });
});

/* ─── Season runs (ADR 0008) ───
   A run orchestrates one competition's stages for one season; the fixtures still live on
   the Series each stage-group materialises into. Admin-only to write, reps read (their
   club's fixtures resolve through it). Same optimistic concurrency as series. */

app.get('/season-runs', async (c) => {
  const { tenant } = c.get('requestAuth')!;
  return c.json(await repo.listSeasonRuns(tenant));
});

app.post('/season-runs', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const run = await c.req.json<SeasonRun>();
  if (!run?.id?.trim()) throw new HttpError(400, 'season run needs an id');
  if (!run.leagueKey?.trim()) throw new HttpError(400, 'season run needs a league');
  // Typed, not just truthy: `.trim()` on a non-string TypeErrors into a 500 where the
  // caller deserves the 400 that says what is wrong.
  if (typeof run.seasonLabel !== 'string' || !run.seasonLabel.trim())
    throw new HttpError(400, 'season run needs a season label');
  // The snapshots are the whole point: a run must keep the structure and calendar it
  // STARTED with, so a later operator edit can never reshape a season in flight.
  if (!run.structureSnapshot?.stages?.length)
    throw new HttpError(400, 'season run needs a structure snapshot');
  if (!run.calendarSnapshot?.blocks?.length)
    throw new HttpError(400, 'season run needs a calendar snapshot');
  // The snapshots are client-supplied and then drive fixture materialisation for the
  // whole season. Re-use the operator-path guards rather than trusting them: a malformed
  // snapshot is exactly as damaging here, and it is frozen for the life of the run.
  validateStructures([run.structureSnapshot]);
  validateCalendars([run.calendarSnapshot]);
  if (!run.competitionId?.trim()) throw new HttpError(400, 'season run needs a competition');
  if (run.stages !== undefined && !Array.isArray(run.stages))
    throw new HttpError(400, 'season run stages must be an array');
  if ((run.stages?.length ?? 0) > 20)
    throw new HttpError(400, 'a season run is limited to 20 stages');
  if (await repo.getSeasonRun(tenant, run.id))
    throw new HttpError(409, 'a season run with that id already exists');
  run.version = 1;
  run.stages = Array.isArray(run.stages) ? run.stages : [];
  run.createdAt = now();
  run.createdBy = c.get('requestAuth')!.email ?? undefined;
  await repo.putSeasonRun(tenant, run);
  return c.json(run, 201);
});

app.get('/season-runs/:id', async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const run = await repo.getSeasonRun(tenant, c.req.param('id'));
  if (!run) throw new HttpError(404, 'season run not found');
  return c.json(run);
});

app.patch('/season-runs/:id', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const id = c.req.param('id');
  const patch = await c.req.json<Partial<SeasonRun>>();
  const current = await repo.getSeasonRun(tenant, id);
  if (!current) throw new HttpError(404, 'season run not found');
  // The snapshots are immutable for the life of the run — that is what makes them
  // snapshots. Strip rather than reject so an admin round-tripping a whole run object
  // (the obvious client implementation) doesn't get a confusing 400.
  delete (patch as { structureSnapshot?: unknown }).structureSnapshot;
  delete (patch as { calendarSnapshot?: unknown }).calendarSnapshot;
  delete (patch as { createdAt?: unknown }).createdAt;
  delete (patch as { createdBy?: unknown }).createdBy;
  // The audit trail is APPEND-ONLY, reconstructed here from the stored run rather than
  // taken from the request.
  //
  // The client resubmits the whole accumulated array (it has to — `stages` is a
  // whole-array replace), so stamping everything it sends would rewrite every earlier
  // entry with the current admin and the current time: after two confirmations the
  // trail would read as one person doing both at one instant. Relegation and the points
  // carry ride on who confirmed which entrants, so that is precisely the record this
  // exists to protect.
  //
  // Stored entries are therefore replayed verbatim and only the appended tail is
  // stamped. A client that echoes back a truncated or reordered history cannot shorten
  // it: the stored prefix always wins.
  const actor = c.get('requestAuth')!.email ?? 'unknown';
  const at = now();
  if (patch.stages !== undefined) {
    // POST's guards apply here too — a run can gain stages through a PATCH, so checking
    // them only on create leaves the same door open one route along.
    if (!Array.isArray(patch.stages))
      throw new HttpError(400, 'season run stages must be an array');
    if (patch.stages.length > 20) throw new HttpError(400, 'a season run is limited to 20 stages');
    for (const stage of patch.stages) {
      if (!stage) continue;
      // BOTH sides normalised to arrays. A stage arriving with a non-array `audit` and no
      // stored counterpart would otherwise be persisted raw, and the next PATCH would
      // read `prior.length` off a string (its character count) — silently dropping the
      // genuine entry and spreading the old value into single characters.
      const found = current.stages?.find((s: StageRun) => s.specId === stage.specId);
      const prior = Array.isArray(found?.audit) ? found.audit : [];
      const incoming = Array.isArray(stage.audit) ? stage.audit : [];
      const appended = incoming.slice(prior.length).map((entry) => ({ ...entry, by: actor, at }));
      stage.audit = [...prior, ...appended];
    }
  }
  // `seasonLabel` is the gsi1 sort key. Blanking it writes an empty `gsi1sk`, which real
  // DynamoDB rejects (dynalite accepts it, so no test would catch it) — and the run would
  // vanish from the listing even if it landed.
  if (
    patch.seasonLabel !== undefined &&
    (typeof patch.seasonLabel !== 'string' || !patch.seasonLabel.trim())
  )
    throw new HttpError(400, 'season run needs a season label');
  try {
    return c.json(await repo.updateSeasonRun(tenant, id, patch));
  } catch (err) {
    if (err instanceof VersionConflictError)
      throw new HttpError(409, 'season run changed; refetch');
    throw err;
  }
});

/**
 * Deleting a run does NOT delete the series its stages produced. Those are real,
 * possibly-released fixtures that clubs and players have already seen; orphaning the
 * back-pointer is recoverable, silently deleting a published schedule is not.
 */
app.delete('/season-runs/:id', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  await repo.deleteSeasonRun(tenant, c.req.param('id'));
  return c.json({ ok: true });
});

/* ─── Venues (ADR 0008 phase 2) ───
   The master ground list fixture allocation draws on. Admin-managed, not operator-only:
   ground availability changes week to week and the union office is who knows about it.
   Reps read (their club's fixtures name a venue). */

/** Shape guard. Coordinates are optional — there is no geocoder, they are hand-pinned. */
function validateVenue(v: unknown): asserts v is Venue {
  const venue = v as Venue | undefined;
  if (!venue || typeof venue !== 'object') throw new HttpError(400, 'venue must be an object');
  if (!venue.id?.trim()) throw new HttpError(400, 'venue needs an id');
  if (!venue.name?.trim()) throw new HttpError(400, 'venue needs a name');
  if (venue.name.trim().length > 120)
    throw new HttpError(400, 'venue names must be 120 characters or fewer');
  const coord = (n: unknown) => n === undefined || (typeof n === 'number' && Number.isFinite(n));
  if (!coord(venue.lat) || !coord(venue.lon))
    throw new HttpError(400, 'venue coordinates must be numbers');
  if (venue.lat !== undefined && (venue.lat < -90 || venue.lat > 90))
    throw new HttpError(400, 'latitude out of range');
  if (venue.lon !== undefined && (venue.lon < -180 || venue.lon > 180))
    throw new HttpError(400, 'longitude out of range');
  if (venue.surfaces !== undefined && (!Number.isInteger(venue.surfaces) || venue.surfaces < 1))
    throw new HttpError(400, 'a venue hosts at least one match a day');
  const isDate = (x: unknown): x is string =>
    typeof x === 'string' && dayjs.utc(x, 'YYYY-MM-DD', true).isValid();
  for (const w of venue.unavailable ?? []) {
    if (!w?.reason?.trim()) throw new HttpError(400, 'every unavailable window needs a reason');
    if (!isDate(w.start) || !isDate(w.end))
      throw new HttpError(400, `"${w.reason}" needs valid start and end dates`);
    if (w.end < w.start) throw new HttpError(400, `"${w.reason}" ends before it starts`);
  }
  for (const d of venue.unavailableWeekdays ?? []) {
    if (!Number.isInteger(d) || d < 0 || d > 6)
      throw new HttpError(400, 'unavailable weekdays must be 0-6');
  }
}

app.get('/venues', async (c) => {
  const { tenant } = c.get('requestAuth')!;
  return c.json(await repo.listVenues(tenant));
});

app.put('/venues/:id', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const id = c.req.param('id');
  const body = await c.req.json<Venue>();
  // The path owns the id — a body id is ignored so a crafted payload can't write to
  // another key.
  const venue = { ...body, id };
  validateVenue(venue);
  venue.name = venue.name.trim();
  return c.json(await repo.putVenue(tenant, venue));
});

/**
 * Deleting a venue does NOT rewrite the fixtures allocated to it. Those fixtures keep a
 * denormalised `venueName`, so a released schedule still reads correctly; re-allocating
 * is the admin's call, not a side effect of tidying the ground list.
 */
app.delete('/venues/:id', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  await repo.deleteVenue(tenant, c.req.param('id'));
  return c.json({ ok: true });
});

app.post('/series/:id/duplicate', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const orig = await repo.getSeries(tenant, c.req.param('id'));
  if (!orig) throw new HttpError(404, 'series not found');
  const copy: Series = {
    ...orig,
    id: `s-${randomUUID().slice(0, 8)}`,
    name: `${orig.name} · Copy`,
    released: false,
    releasedAt: null,
    version: 1,
  };
  await repo.putSeries(tenant, copy);
  return c.json(copy, 201);
});

// ───────────────────── Tenant config + users (admin) ─────────────────────

// Anchored + TLD-required: blocks whitespace/newlines, so the validated value is
// safe to splice into a mailto: link downstream. Kept identical to api.js EMAIL_RE.
const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;

/**
 * Strip-and-merge core of a tenant-config patch, shared by PUT /tenant/config
 * (tenant admin) and PUT /platform/tenants/:slug (operator). Reads the current
 * row, strips server-owned/retired fields, validates the league catalogue, and
 * whole-item-Puts the merged result. Throws HttpError (404/400/409); returns the
 * updated config.
 */
async function applyTenantConfigPatch(
  tenant: string,
  patch: Partial<TenantConfig>,
  opts: { preserveCompetitions?: boolean } = {},
): Promise<TenantConfig> {
  const current = await repo.getTenantConfig(tenant);
  if (!current) throw new HttpError(404, 'tenant not found');
  // clubSignupLink is server-owned and written only via its targeted routes — a stale
  // Settings tab's whole-config save must not resurrect a revoked link. registrationAccess
  // is retired; strip it too so an old client can't write it back onto the row.
  delete (patch as { clubSignupLink?: unknown }).clubSignupLink;
  delete (patch as { registrationAccess?: unknown }).registrationAccess;
  // The setup milestone is written ONLY via POST/DELETE /platform/tenants/:slug/setup-complete
  // (a direct, audited put). Strip it from EVERY merge-patch — the tenant-admin PUT
  // /tenant/config and the operator PUT /platform/tenants/:slug — so a club admin can't forge
  // their own Live chip or the setupCompletedBy audit field. See types.ts.
  delete (patch as { setupCompletedAt?: unknown }).setupCompletedAt;
  delete (patch as { setupCompletedBy?: unknown }).setupCompletedBy;
  // Table/index keys are derived at the repo write choke point — strip them here
  // too so a malicious patch can't even attempt to retarget another tenant's row
  // or corrupt the platform registry index.
  delete (patch as { pk?: unknown }).pk;
  delete (patch as { sk?: unknown }).sk;
  delete (patch as { gsi1pk?: unknown }).gsi1pk;
  delete (patch as { gsi1sk?: unknown }).gsi1sk;
  // Districts validate (and trim) before leagues so a combined patch checks its
  // leagues against the INCOMING district list, not the stored one.
  if (patch.districts !== undefined) {
    validateDistricts(patch.districts);
    patch.districts = patch.districts.map((d) => d.trim());
  }
  if (patch.leagues !== undefined) {
    // validateLeagues runs against the RAW incoming body, before preserveCompetitions
    // below discards whatever competitions data the client sent — so a tenant PUT can
    // still 400 (e.g. duplicate key) on a league whose competitions edit was never
    // going to be kept. Accepted: pre-stripping every incoming league's competitions
    // field before validating just to avoid that wasted 400 costs more than it saves.
    validateLeagues(
      patch.leagues,
      // A league's district must be real for the tenant — or the overarching
      // sentinel, or a district already on the stored catalogue (value-level
      // orphan tolerance: an untouched stale league keeps saving).
      new Set([
        ...resolveDistricts({ districts: patch.districts ?? current.districts }),
        OVERARCHING_DISTRICT,
        ...(current.leagues ?? []).map((l) => l.district),
      ]),
    );
    // Competition bindings (League.competitions) are operator-only (ADR 0008) — the
    // tenant-admin path can rename/reorder leagues but must never mint or drop a
    // binding. Overwrite each incoming league's competitions with whatever is
    // CURRENTLY STORED for that key, ignoring the patch's value entirely.
    if (opts.preserveCompetitions) {
      // A key with no stored counterpart (a brand-new league) sets `competitions:
      // undefined` explicitly rather than omitting the property — safe only because
      // the repo write marshals with removeUndefinedValues, so it never lands on the
      // row as a literal `null`/`undefined` attribute.
      const storedByKey = new Map((current.leagues ?? []).map((l) => [l.key, l.competitions]));
      patch.leagues = patch.leagues.map((l) => ({ ...l, competitions: storedByKey.get(l.key) }));
    }
  }
  const next = { ...current, ...patch, tenant };
  try {
    await repo.putTenantConfig(next);
  } catch (err) {
    // DynamoDB's 400KB item ceiling — the only real bound on catalogue size
    // (~2,000+ leagues; there is deliberately NO count limit on leagues/districts).
    // Surface it as an actionable 400 instead of an opaque 500. Copy stays
    // ceiling-neutral: the item also carries knownClubs/branding/tutorials, so
    // leagues may not be what filled it. Real DynamoDB and dynalite share the
    // "Item size has exceeded the maximum allowed size" phrasing; other
    // ValidationExceptions don't mention "item size" and keep 500ing unchanged.
    if (
      (err as { name?: string }).name === 'ValidationException' &&
      /item size/i.test((err as Error).message ?? '')
    ) {
      // As an HttpError this no longer Sentry-captures via app.onError — keep a
      // log breadcrumb for the rare tenant that ever hits the physical ceiling.
      console.warn(`tenant config for ${tenant} hit the DynamoDB item-size ceiling`);
      throw new HttpError(
        400,
        "This client's configuration has reached the platform storage ceiling — remove unused leagues/districts or contact support",
      );
    }
    throw err;
  }
  return next;
}

/**
 * District-list shape guard: non-blank unique strings, ≤80 chars, and never the
 * OVERARCHING_DISTRICT sentinel (reserved for leagues that span all districts).
 * An EMPTY array is valid — it is the deliberate starting state of a freshly
 * created client (club signup stays blocked until the operator sets districts).
 * The operator route also calls this BEFORE its referrer delete guard so a
 * malformed body gets its 400 instead of a misleading "still in use" 409.
 */
function validateDistricts(districts: unknown): asserts districts is string[] {
  if (!Array.isArray(districts)) throw new HttpError(400, 'districts must be an array');
  if (districts.some((d) => typeof d !== 'string' || !d.trim()))
    throw new HttpError(400, 'every district needs a name');
  if (districts.some((d) => d.trim().length > 80))
    throw new HttpError(400, 'district names must be 80 characters or fewer');
  // Compare trimmed — names are STORED trimmed, so ' All districts ' would
  // otherwise slip past here and then trip this very check on the next save.
  if (districts.some((d) => d.trim() === OVERARCHING_DISTRICT))
    throw new HttpError(400, `"${OVERARCHING_DISTRICT}" is reserved for overarching leagues`);
  if (new Set(districts.map((d) => d.trim())).size !== districts.length)
    throw new HttpError(409, 'duplicate district');
}

/**
 * Club-directory shape guard: every entry needs a non-blank name (≤80 chars) that
 * slugs to a non-empty id, and no two entries may share a slug — the slug doubles
 * as a clearance source partition, so "Kingsmead CC" and "Kingsmead-CC" are the
 * SAME directory club even though the names differ. Client-sent ids are ignored;
 * the operator route re-derives them server-side.
 */
function validateKnownClubs(entries: unknown): asserts entries is Array<{ name: string }> {
  if (!Array.isArray(entries)) throw new HttpError(400, 'knownClubs must be an array');
  // Well below the CONFIG item's 400KB physical ceiling, but failing here keeps the
  // error honest — the generic ceiling message blames leagues/districts.
  if (entries.length > 500)
    throw new HttpError(400, 'the club directory is limited to 500 entries');
  const names = entries.map((e) => (e as { name?: unknown } | undefined)?.name);
  if (names.some((n) => typeof n !== 'string' || !n.trim()))
    throw new HttpError(400, 'every directory club needs a name');
  if (names.some((n) => (n as string).trim().length > 80))
    throw new HttpError(400, 'directory club names must be 80 characters or fewer');
  const ids = names.map((n) => clubIdFromName((n as string).trim()));
  if (ids.some((id) => !id))
    throw new HttpError(400, 'directory club names need at least one letter or digit');
  if (new Set(ids).size !== ids.length) throw new HttpError(409, 'duplicate directory club');
}

/** True for a syntactically-valid absolute https:// URL. */
function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Per-tenant tutorial-video shape guard: bounded array, each entry a non-blank
 * title (≤200 chars) and an https `url`; `poster`, if present, must also be
 * https. TutorialVideo's `url`/`poster` doc comments allow relative paths for
 * the DEFAULT_TUTORIALS set — an operator-authored override is stricter (only
 * ever S3/CDN links from tutorial-upload), so this rejects anything else.
 */
function validateTutorials(tutorials: unknown): asserts tutorials is TutorialVideo[] {
  if (!Array.isArray(tutorials)) throw new HttpError(400, 'tutorials must be an array');
  if (tutorials.length > 50) throw new HttpError(400, 'no more than 50 tutorial videos');
  for (const t of tutorials as Array<Partial<TutorialVideo> | null | undefined>) {
    if (!t || typeof t !== 'object')
      throw new HttpError(400, 'every tutorial needs a title and url');
    if (typeof t.title !== 'string' || !t.title.trim())
      throw new HttpError(400, 'every tutorial needs a title');
    if (t.title.trim().length > 200)
      throw new HttpError(400, 'tutorial titles must be 200 characters or fewer');
    if (!isHttpsUrl(t.url)) throw new HttpError(400, `"${t.title}" needs a valid https url`);
    if (t.poster !== undefined && !isHttpsUrl(t.poster))
      throw new HttpError(400, `"${t.title}" poster must be a valid https url`);
  }
}

/**
 * Delete S3 objects for tutorial video/poster URLs dropped from an operator's tutorials
 * patch. Only touches objects whose URL sits under THIS tenant's own tutorials/<slug>/
 * prefix — shared-default clips (tutorials/<file>.mp4) and every other tenant's assets
 * are hard-excluded, so a slug mix-up or a leftover default entry can never delete
 * platform-shared media. Best-effort: one DeleteObjectsCommand batch (S3's cap is 1000
 * keys, comfortably above the 50-entry tutorials cap × 2 url/poster fields), and a
 * failure here must never fail the config save the tutorials patch already committed —
 * logged and swallowed. No-op when TUTORIALS_BUCKET is unset (offline dev). Same
 * accepted non-atomic window as the operator route header already documents for
 * leagues/branding: two concurrent operator PUTs can interleave such that this delete
 * removes an object the second save's patch has just re-referenced.
 */
async function cleanupOrphanTutorialAssets(
  slug: string,
  oldTutorials: TutorialVideo[],
  newTutorials: TutorialVideo[],
): Promise<void> {
  if (!TUTORIALS_BUCKET) return;
  const prefix = `${TUTORIALS_BASE_URL}/tutorials/${slug}/`;
  const kept = new Set(
    newTutorials.flatMap((t) => [t.url, t.poster].filter((v): v is string => !!v)),
  );
  const droppedKeys = [
    ...new Set(
      oldTutorials
        .flatMap((t) => [t.url, t.poster])
        .filter((v): v is string => !!v && v.startsWith(prefix) && !kept.has(v))
        .map((url) => url.slice(TUTORIALS_BASE_URL.length + 1)),
    ),
  ];
  if (droppedKeys.length === 0) return;
  try {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: TUTORIALS_BUCKET,
        Delete: { Objects: droppedKeys.map((Key) => ({ Key })) },
      }),
    );
  } catch (err) {
    console.error(`tutorial-asset cleanup failed for tenant ${slug}:`, err);
  }
}

/**
 * League-catalogue shape guard: keys are the matching token stored on clubs, so they
 * must be unique, present and strings. Rejects a malformed payload with a 400 rather
 * than letting a non-array/non-string key TypeError into a 500 or persist junk.
 * The operator route also calls this BEFORE its club-reference delete guard so a
 * malformed body gets its 400 instead of a misleading "clubs are registered" 409.
 */
function validateLeagues(
  leagues: unknown,
  validDistricts?: Set<string>,
): asserts leagues is League[] {
  if (!Array.isArray(leagues)) throw new HttpError(400, 'leagues must be an array');
  const keys = leagues.map((l) => (l as League | undefined)?.key);
  if (keys.some((k) => typeof k !== 'string' || !k.trim()))
    throw new HttpError(400, 'every league needs a key');
  if (leagues.some((l) => !(l as League).label?.trim()))
    throw new HttpError(400, 'every league needs a label');
  if (new Set(keys).size !== keys.length) throw new HttpError(409, 'duplicate league key');
  if (validDistricts) {
    const bad = (leagues as League[]).find((l) => !validDistricts.has(l.district));
    if (bad)
      throw new HttpError(400, `unknown district "${bad.district}" on league "${bad.label}"`);
  }
}

/**
 * GET /tenant/config — the tenant's own configuration, for signed-in users.
 *
 * Exists so admin-only setup data doesn't have to ride the UNAUTHENTICATED `GET /tenant`,
 * which is hit on every public page load. Structures in particular are only read by the
 * "Start a season" flow; serving them anonymously is payload nobody on that path needs.
 *
 * An explicit ALLOWLIST, deliberately — not "the row minus clubSignupLink". Any tenant
 * member can call this, reps included, and a denylist silently exposes every field added
 * to `TenantConfig` from then on. What is held back and why:
 *
 *   clubSignupLink   a live credential; it has its own route
 *   knownClubs       the operator's directory, reachable via /clubs/directory
 *   requiredDocs     compliance config, served with the club record that uses it
 *   adminCount       an internal counter for the last-admin guard
 *   setupCompletedBy an operator's email address — not tenant-facing at all
 */
app.get('/tenant/config', async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const config = await repo.getTenantConfig(tenant);
  if (!config) throw new HttpError(404, 'tenant not found');
  return c.json({
    tenant: config.tenant,
    branding: config.branding,
    submissionDeadline: config.submissionDeadline,
    leagues: config.leagues ?? [],
    districts: resolveDistricts(config),
    tutorials: tutorialsFor(config),
    features: config.features ?? {},
    calendars: config.calendars ?? [],
    // The reason this route exists.
    structures: config.structures ?? [],
    // The milestone itself is useful on the console; who stamped it is not.
    setupCompletedAt: config.setupCompletedAt,
  });
});

app.put('/tenant/config', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const patch = await c.req.json<Partial<TenantConfig>>();
  // Operator-only fields (ADR 0006): feature flags, tutorials, the admin count and
  // the district list are never writable by a tenant admin. Stripped here (not in
  // the shared applyTenantConfigPatch) because the operator route whitelists separately.
  delete (patch as { features?: unknown }).features;
  delete (patch as { tutorials?: unknown }).tutorials;
  delete (patch as { tutorialsNoFallback?: unknown }).tutorialsNoFallback;
  delete (patch as { adminCount?: unknown }).adminCount;
  delete (patch as { districts?: unknown }).districts;
  delete (patch as { knownClubs?: unknown }).knownClubs;
  delete (patch as { calendars?: unknown }).calendars;
  delete (patch as { structures?: unknown }).structures;
  const next = await applyTenantConfigPatch(tenant, patch, { preserveCompetitions: true });
  return c.json(next);
});

/**
 * Update the union support contact (admin only, like the rest of tenant config).
 * Validates name + email, recombines into the "Name · email" string the UI parses,
 * and writes only that one copy slot (repo.updateSupportCopy) so it can't clobber a
 * concurrent leagues/deadline write.
 */
app.put('/tenant/support', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const { name, email } = await c.req.json<{ name?: string; email?: string }>();
  const officeName = (name ?? '').trim().replace(/·/g, '').trim();
  const addr = (email ?? '').trim();
  if (!officeName) throw new HttpError(400, 'office name required');
  if (!EMAIL_RE.test(addr)) throw new HttpError(400, 'valid email required');
  const support = `${officeName} · ${addr}`;
  try {
    await repo.updateSupportCopy(tenant, support);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new HttpError(404, 'tenant not found');
    }
    throw err;
  }
  return c.json({ support });
});

// ───────────────────── Platform operator portal (/platform/*) ─────────────────────
// All routes below are gated by `authenticate + requirePlatformOperator` (see the
// middleware block) — tenant-independent, so :slug in the path names the target
// tenant explicitly instead of the request host.

/** Per-kind branding upload rules — content type → stored extension (the allowlist
 *  doubles as the gate). `logo` is the sign-in/header mark (small, SVG-friendly);
 *  `hero` is the backdrop photo (raster only — an SVG backdrop buys nothing). */
const BRANDING_UPLOAD_KINDS: Record<
  'logo' | 'hero',
  { types: Record<string, string>; maxBytes: number }
> = {
  logo: {
    types: { 'image/png': 'png', 'image/svg+xml': 'svg', 'image/webp': 'webp' },
    maxBytes: 1024 * 1024, // 1 MB
  },
  hero: {
    types: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
    maxBytes: 4 * 1024 * 1024, // 4 MB — the client downscales first; this is the backstop
  },
};
/** Branding object keys are UUID-suffixed (never rewritten), so cache forever. */
const BRANDING_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Per-kind tutorial-upload rules, same allowlist-doubles-as-gate shape as branding. */
const TUTORIAL_UPLOAD_KINDS: Record<
  'video' | 'poster',
  { types: Record<string, string>; maxBytes: number }
> = {
  video: {
    types: { 'video/mp4': 'mp4', 'video/webm': 'webm' },
    maxBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
  },
  poster: {
    types: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
    maxBytes: 4 * 1024 * 1024, // 4 MB
  },
};
/** Above this, a video upload goes multipart instead of a single presigned POST. */
const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100 MiB
/** Part size for a multipart upload (S3's minimum is 5 MiB; this comfortably clears it). */
const MULTIPART_PART_SIZE = 32 * 1024 * 1024; // 32 MiB
/** Tutorial object keys are UUID-suffixed (never rewritten), so cache forever. */
const TUTORIAL_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Sides a club fields in one league — absent map/key counts as 1 (legacy clubs). */
function clubTeamCount(club: Club): number {
  return (club.leagues ?? []).reduce(
    (sum, k) => sum + Math.max(1, Number(club.leagueTeams?.[k]) || 1),
    0,
  );
}

/**
 * Cross-tenant-safe club projection for the operator overview. A deliberate ALLOWLIST.
 * The operator league drill-down needs the chair's name/email/cell (team contact) and
 * the named-side ids/names, so those DO cross now — but `chairContact` is picked
 * field-by-field (NEVER spread: `exco.chair` also carries `idNumber` and governance
 * term dates) and rosters are stripped to {id,name} (no venue/address/coords).
 * Everything else stays out: exco ID numbers, coaches, notes, commLog, docMeta
 * (S3 keys), cqiAnswers, ground addresses and the LIVE playerRegLink token must never
 * cross the operator surface. Add fields here only after checking what they carry.
 */
function toInsightsClub(club: Club) {
  const excoChair = (club.exco?.chair ?? {}) as { name?: string; email?: string; cell?: string };
  return {
    id: club.id,
    name: club.name,
    district: club.district ?? '',
    affiliation: club.affiliation,
    cqi: club.cqi ?? 0,
    docs: club.docs ?? {},
    leagues: club.leagues ?? [],
    leagueTeams: club.leagueTeams ?? {},
    players: (club as { playerCount?: number }).playerCount ?? 0,
    chair: club.chair ?? '',
    chairContact: { name: excoChair.name, email: excoChair.email, cell: excoChair.cell },
    teamRosters: Object.fromEntries(
      Object.entries(club.teamRosters ?? {}).map(([key, roster]) => [
        key,
        roster.map((t) => ({ id: t.id, name: t.name })),
      ]),
    ),
  };
}

/**
 * GET /platform/tenants — registry listing (projection, not full configs) with fleet
 * rollup counts. The rollup fans out one listClubs per tenant (parallel gsi1 queries);
 * cost scales with the ITEM BYTES read (the gsi1 projects full club items), not just
 * the tenant count. Fine while the fleet is hand-created and small — revisit with
 * denormalized counters or a cache once it grows past a few dozen tenants or clubs
 * get heavy enough that the fan-out visibly drags the client list.
 */
app.get('/platform/tenants', async (c) => {
  const tenants = await repo.listTenants();
  // Per-tenant catch: the counts are decorative, so one throttled/failed club
  // partition must not 500 the whole registry listing — the row just ships without
  // counts and the client list renders '—' for them. Only the registry read itself
  // stays fail-fast.
  const clubLists = await Promise.all(
    tenants.map((t) =>
      repo.listClubs(t.tenant).catch((err) => {
        console.error(`fleet rollup: listClubs failed for ${t.tenant}`, err);
        return null;
      }),
    ),
  );
  return c.json(
    tenants.map((t, i) => {
      const clubs = clubLists[i];
      return {
        tenant: t.tenant,
        name: t.branding?.name ?? t.tenant,
        title: t.branding?.title ?? '',
        logoUrl: t.branding?.logoUrl ?? '',
        submissionDeadline: t.submissionDeadline,
        adminCount: t.adminCount ?? 0,
        features: t.features ?? {},
        // Setup milestone (D6): present = operator marked setup done. Drives the
        // "In setup" / "Live" chip on the client list.
        setupCompletedAt: t.setupCompletedAt,
        ...(clubs && {
          clubCount: clubs.length,
          teamCount: clubs.reduce((sum, cl) => sum + clubTeamCount(cl), 0),
          playerCount: clubs.reduce(
            (sum, cl) => sum + ((cl as { playerCount?: number }).playerCount ?? 0),
            0,
          ),
        }),
      };
    }),
  );
});

/**
 * POST /platform/tenants — create a tenant. Body {slug, branding, submissionDeadline,
 * features?}; branding needs at least a name (buildTenantConfig fills the defaults the
 * seed path uses, so portal-created and seeded tenants share one shape). The
 * `attribute_not_exists` create guard maps to 409 on a duplicate slug.
 */
app.post('/platform/tenants', async (c) => {
  const body = await c.req.json<{
    slug?: string;
    branding?: TenantBrandingInput;
    submissionDeadline?: string;
    features?: Record<string, boolean>;
  }>();
  const slug = (body.slug ?? '').trim().toLowerCase();
  const slugError = validateTenantSlug(slug);
  if (slugError) throw new HttpError(400, slugError);
  const name = body.branding?.name?.trim();
  if (!name) throw new HttpError(400, 'branding.name required');
  const deadline = (body.submissionDeadline ?? '').trim();
  if (!deadline || Number.isNaN(Date.parse(deadline)))
    throw new HttpError(400, 'valid submissionDeadline required (ISO date)');
  // Explicit empty leagues AND districts: a portal-created client starts with a
  // blank catalogue the operator fills in; districts:[] (vs field-absent) opts the
  // new client OUT of the legacy DEFAULT_DISTRICTS fallback.
  const config = buildTenantConfig(
    slug,
    { ...body.branding, name },
    deadline,
    body.features,
    [],
    [],
  );
  try {
    await repo.createTenantConfig(config);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException')
      throw new HttpError(409, `tenant "${slug}" already exists`);
    throw err;
  }
  const operatorAdmins = await grantAdminToOperators(slug);
  return c.json({ ...config, operatorAdmins }, 201);
});

/**
 * Give every platform operator tenant-admin on a newly created tenant.
 *
 * ⚠️ This is a DELIBERATE widening of the tenant boundary, applied on ALL stages
 * including prod: from creation, every operator can read that tenant's clubs, chair
 * contact details and player registrations. An operator membership alone grants none of
 * that (`requireTenantMembership` matches `tenantId === tenant`, and an operator's is the
 * `'*'` sentinel), so without this a new tenant is invisible to them until someone runs
 * `bootstrap-admin` by hand. Requested explicitly; see the POPIA note in
 * docs/runbooks/seeding-a-test-cohort.md before widening it further.
 *
 * The grants are ordinary, explicit memberships — visible on each USER# record, listed in
 * the tenant's Team & Access page, and individually revocable. Nothing is implicit.
 *
 * BEST-EFFORT: the tenant is already created by the time this runs, so a failure here
 * must not turn a successful creation into a 500 the operator would retry into a 409.
 * Failures are logged and reported in the response instead.
 */
async function grantAdminToOperators(
  tenant: string,
): Promise<{ granted: string[]; failed: string[] }> {
  const granted: string[] = [];
  const failed: string[] = [];
  try {
    const operators = await repo.listOperators();
    for (const op of operators) {
      try {
        // By SUB, not email: the operator index already carries their real sub, so
        // re-resolving it through Cognito would be a needless round-trip per operator per
        // tenant — and would write to the wrong record wherever email→sub resolution
        // differs from what is stored. Same membership shape and adminCount recount as a
        // hand-run bootstrap-admin.
        await addAdminMembership(op.sub, op.email, tenant);
        granted.push(op.email);
      } catch (err) {
        failed.push(op.email);
        console.warn(`auto-grant admin on "${tenant}" failed for ${op.email}:`, err);
      }
    }
  } catch (err) {
    // Could not even enumerate operators — log and continue; the tenant still exists.
    console.warn(`auto-grant admin on "${tenant}": could not list operators:`, err);
    Sentry.captureException(err);
  }
  if (granted.length)
    console.log(`tenant "${tenant}": auto-granted admin to ${granted.join(', ')}`);
  return { granted, failed };
}

/** GET /platform/tenants/:slug — the full config row (operator edit form). */
app.get('/platform/tenants/:slug', async (c) => {
  const config = await repo.getTenantConfig(c.req.param('slug'));
  if (!config) throw new HttpError(404, 'tenant not found');
  return c.json(config);
});

/**
 * GET /platform/tenants/:slug/overview — everything the operator per-client breakdown
 * renders, in one read-only payload (config context + sanitized clubs + clearance
 * pipeline), and NOTHING more: clubs ride through toInsightsClub (allowlist — see
 * above) and clearances carry only their status. The tightest cross-tenant projection
 * is the one that ships only what the page renders.
 */
app.get('/platform/tenants/:slug/overview', async (c) => {
  const slug = c.req.param('slug');
  const config = await repo.getTenantConfig(slug);
  if (!config) throw new HttpError(404, 'tenant not found');
  const [clubs, clearances] = await Promise.all([
    repo.listClubs(slug),
    repo.listAllClearances(slug),
  ]);
  // Anonymised demographics ride the same payload (histogram buckets only — the
  // repo read is projection-limited; no player rows cross the operator surface).
  const players = await repo.listPlayerDemographics(
    slug,
    clubs.map((cl) => cl.id),
  );
  const { perLeague, unattributed } = demographicsByLeague(
    players,
    clubs,
    (config.leagues ?? []).map((l) => l.key),
  );
  return c.json({
    tenant: slug,
    name: config.branding?.name ?? slug,
    leagues: config.leagues ?? [],
    districts: resolveDistricts(config),
    clubs: clubs.map(toInsightsClub),
    clearances: clearances.map((r) => ({ status: r.status })),
    demographics: { ...summarizeDemographics(players), perLeague, unattributed },
  });
});

/**
 * Deterministic deep-equality for plain JSON-shaped values: object keys compare
 * order-independent (two structures built by different code paths may key their fields
 * in different orders), arrays compare order-sensitive (stage order is meaningful).
 * Used only to detect whether an operator's structure edit actually changed anything, so
 * version numbers can stay server-owned (see the structures block in
 * `PUT /platform/tenants/:slug`) without false-positive bumps on a no-op resave.
 *
 * Not a true value-equality: `{a: undefined}` stringifies differently from `{}` (the key
 * still appears, JSON.stringify-style), while DynamoDB's removeUndefinedValues marshalling
 * stores both identically. So a round-trip through the two can mint a spurious version
 * bump for content the table considers unchanged. Accepted — narrower than the false
 * positives this exists to prevent, and no caller here constructs objects with explicit
 * `undefined` values by hand.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * PUT /platform/tenants/:slug — merge-patch branding / features / leagues /
 * districts / submissionDeadline (whitelisted: the operator portal edits nothing
 * else). Shares applyTenantConfigPatch with PUT /tenant/config, so the same
 * strip-and-merge + catalogue guards apply. The leagues/districts referrer guards
 * below are best-effort, not atomic: a concurrent tenant-admin league write can
 * land between the reads and the final Put (same accepted window as branding).
 */
app.put('/platform/tenants/:slug', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.json<Partial<TenantConfig>>();
  const patch: Partial<TenantConfig> = {};
  // Lazily fetched once, shared by the leagues and districts referrer guards.
  let currentCfg: TenantConfig | undefined;
  const getCurrent = async (): Promise<TenantConfig> => {
    if (!currentCfg) {
      const cfg = await repo.getTenantConfig(slug);
      if (!cfg) throw new HttpError(404, 'tenant not found');
      currentCfg = cfg;
    }
    return currentCfg;
  };
  let tenantClubs: Club[] | undefined;
  const getClubs = async (): Promise<Club[]> => (tenantClubs ??= await repo.listClubs(slug));
  // Informational only (never blocks the save) — populated by the calendars block below
  // when a block edit lands on a calendar series still reference.
  const warnings: string[] = [];
  if (body.branding !== undefined) patch.branding = body.branding;
  if (body.features !== undefined) patch.features = body.features;
  if (body.leagues !== undefined) {
    validateLeagues(body.leagues); // shape 400s must win over the guard's 409
    patch.leagues = body.leagues;
    // Operator-side delete guard: unlike the tenant admin console, the operator has
    // no view of club registrations, so a write that drops a league key clubs still
    // reference is rejected outright — an orphaned key breaks player registration.
    const current = await getCurrent();
    const nextKeys = new Set(body.leagues.map((l) => l.key));
    const removed = (current.leagues ?? []).filter((l) => !nextKeys.has(l.key));
    if (removed.length > 0) {
      const clubs = await getClubs();
      for (const league of removed) {
        const n = clubs.filter(
          (club) => Array.isArray(club.leagues) && club.leagues.includes(league.key),
        ).length;
        if (n > 0)
          throw new HttpError(
            409,
            `${n} club${n === 1 ? ' is' : 's are'} registered for "${league.label}" — it can only be deleted from the tenant admin console`,
          );
      }
    }
  }
  if (body.districts !== undefined) {
    // Shape 400s must win over the guard's 409. Re-validated in the shared patch
    // core (cheap) — do NOT "deduplicate" this call; the ordering guarantee lives here.
    validateDistricts(body.districts);
    patch.districts = body.districts;
    // Referrer delete guard, TWO referrer types: a removed district orphans clubs
    // (Club.district) and silently hides its leagues from every picker
    // (leagueOptionsForDistrict exact-matches League.district). Only REMOVED
    // districts are checked, so pre-existing orphan references never block
    // unrelated saves. For a legacy tenant with no districts field, removal is
    // computed against the DEFAULT_DISTRICTS fallback — the first explicit save
    // that drops a referenced default is correctly blocked. A body carrying both
    // an invalid league.district and a referenced removal gets this 409 before
    // applyTenantConfigPatch's league 400 — accepted precedence trade-off.
    const current = await getCurrent();
    const nextDistricts = new Set(body.districts.map((d) => d.trim()));
    const removed = resolveDistricts(current).filter((d) => !nextDistricts.has(d));
    if (removed.length > 0) {
      const clubs = await getClubs();
      // Post-patch league view: one PUT may drop a district AND its leagues together.
      const nextLeagues = body.leagues ?? current.leagues ?? [];
      for (const d of removed) {
        const clubRefs = clubs.filter((cl) => cl.district === d).length;
        const leagueRefs = nextLeagues.filter((l) => l.district === d).length;
        if (clubRefs + leagueRefs > 0)
          throw new HttpError(
            409,
            `"${d}" is still in use — ${clubRefs} club${clubRefs === 1 ? '' : 's'} and ${leagueRefs} league${leagueRefs === 1 ? '' : 's'} reference it; reassign them first`,
          );
      }
    }
  }
  if (body.submissionDeadline !== undefined) {
    const deadline = String(body.submissionDeadline).trim();
    if (!deadline || Number.isNaN(Date.parse(deadline)))
      throw new HttpError(400, 'valid submissionDeadline required (ISO date)');
    patch.submissionDeadline = body.submissionDeadline;
  }
  if (body.calendars !== undefined) {
    validateCalendars(body.calendars); // shape 400s must win over the guard's 409
    patch.calendars = body.calendars;
    // Referrer delete guard, mirroring the leagues/districts ones above. A series
    // stores `schedule.calendarId`; dropping the calendar out from under it would leave
    // regenerate unable to reproduce that series' dates. Only REMOVED calendars are
    // checked, so a pre-existing orphan never blocks an unrelated save.
    const current = await getCurrent();
    const nextIds = new Set(body.calendars.map((cal) => cal.id));
    const removed = (current.calendars ?? []).filter((cal) => !nextIds.has(cal.id));
    // Blocks-changed detection (dates and/or ids differ from what's stored) feeds the
    // informational warning below — only for a calendar that still exists post-patch;
    // a REMOVED calendar is handled by the delete guard, not a warning.
    const changed = body.calendars.filter((cal) => {
      const existing = (current.calendars ?? []).find((c) => c.id === cal.id);
      return (
        existing !== undefined && stableStringify(cal.blocks) !== stableStringify(existing.blocks)
      );
    });
    if (removed.length > 0 || changed.length > 0) {
      const allSeries = await repo.listSeries(slug);
      for (const cal of removed) {
        const n = allSeries.filter((s) => s.schedule?.calendarId === cal.id).length;
        if (n > 0)
          throw new HttpError(
            409,
            `${n} series ${n === 1 ? 'is' : 'are'} scheduled against "${cal.label}" — reschedule ${n === 1 ? 'it' : 'them'} before deleting the calendar`,
          );
      }
      // NOT a blocking guard — a live series' schedule stays a live reference to its
      // calendar on purpose (mid-season date edits flowing into regenerate is the
      // feature, ADR 0008 phase 1 gap 4). This just makes that fact visible to the
      // operator instead of leaving it a silent surprise at next regenerate.
      for (const cal of changed) {
        const n = allSeries.filter((s) => s.schedule?.calendarId === cal.id).length;
        if (n > 0)
          warnings.push(
            `${n} series ${n === 1 ? 'is' : 'are'} scheduled against '${cal.label}'; regenerating ${n === 1 ? 'it' : 'them'} will follow the new dates`,
          );
      }
    }
  }
  if (body.structures !== undefined) {
    validateStructures(body.structures); // shape 400s must win over the guard's 409
    const current = await getCurrent();
    // Version numbers are SERVER-OWNED, not client-minted (ADR 0008 phase 1): a client's
    // `version` is ignored outright. Content is deep-compared (excluding `version` itself)
    // against the stored structure of the same id — only a REAL change mints
    // `existing.version + 1`; a no-op resave keeps the existing number. An id with no
    // stored counterpart is a brand-new structure and starts at 1.
    //
    // Known race: two concurrent operator PUTs can both read the same `current` version
    // (e.g. 3) and each mint `existing.version + 1` (4) for DIFFERENT content — whichever
    // write lands second wins with no conflict signalled. No conditional write here yet;
    // same accepted-window spirit as the referrer guards above, recorded rather than fixed.
    const existingById = new Map((current.structures ?? []).map((st) => [st.id, st]));
    patch.structures = body.structures.map((st) => {
      const existing = existingById.get(st.id);
      if (!existing) return { ...st, version: 1 };
      const { version: _incomingVersion, ...incomingContent } = st;
      const { version: _existingVersion, ...existingContent } = existing;
      const changed = stableStringify(incomingContent) !== stableStringify(existingContent);
      return { ...st, version: changed ? existing.version + 1 : existing.version };
    });
    // Referrer delete guard, same basis as leagues/districts/calendars. A running season
    // snapshots its structure, so deleting one can't corrupt a season in flight — but a
    // LEAGUE still binding to it would be left pointing at nothing, and no new season
    // could be started from it.
    const nextIds = new Set(body.structures.map((st) => st.id));
    const removed = (current.structures ?? []).filter((st) => !nextIds.has(st.id));
    if (removed.length > 0) {
      const nextLeagues = body.leagues ?? current.leagues ?? [];
      for (const st of removed) {
        const refs = nextLeagues.flatMap((l) =>
          (l.competitions ?? []).filter((comp) => comp.structureId === st.id).map(() => l.label),
        );
        if (refs.length > 0)
          throw new HttpError(
            409,
            `"${st.name}" is still used by ${refs.length} competition${refs.length === 1 ? '' : 's'} (${[...new Set(refs)].join(', ')}) — unbind ${refs.length === 1 ? 'it' : 'them'} first`,
          );
      }
    }
  }
  if (body.knownClubs !== undefined) {
    validateKnownClubs(body.knownClubs);
    // Ids are re-derived server-side — a client-sent id is never trusted, so a
    // crafted entry can't point at an arbitrary clearance partition. No delete
    // guard: removing an entry only removes a dropdown option; existing
    // clearances keep their denormalized fromClubId/fromClubName and still work.
    patch.knownClubs = body.knownClubs.map((e) => {
      const name = e.name.trim();
      return { id: clubIdFromName(name), name };
    });
  }
  if (body.tutorials !== undefined) {
    validateTutorials(body.tutorials);
    patch.tutorials = body.tutorials;
    // Fetch the OLD config now (not after the save) so the orphan-cleanup diff below
    // compares against what was actually replaced, not the just-written row.
    await getCurrent();
  }
  if (body.tutorialsNoFallback !== undefined) {
    patch.tutorialsNoFallback = !!body.tutorialsNoFallback;
  }
  // Competitions bind leagues to structures and calendars, so they can only be checked
  // once all three are known — against the POST-patch view, so one PUT may legitimately
  // add a structure and the competition that uses it together.
  if (body.leagues !== undefined || body.structures !== undefined || body.calendars !== undefined) {
    const current = await getCurrent();
    validateCompetitions(
      patch.leagues ?? current.leagues ?? [],
      patch.structures ?? current.structures ?? [],
      patch.calendars ?? current.calendars ?? [],
    );
  }
  const next = await applyTenantConfigPatch(slug, patch);
  if (body.tutorials !== undefined) {
    await cleanupOrphanTutorialAssets(slug, currentCfg?.tutorials ?? [], body.tutorials);
  }
  // `warnings` is informational-only and additive — only present when non-empty, so an
  // unaffected save's response shape is byte-for-byte what it was before this existed.
  return c.json(warnings.length > 0 ? { ...next, warnings } : next);
});

/**
 * POST /platform/tenants/:slug/admins — grant (or re-grant) a tenant admin. Shares
 * grantTenantAdmin with the bootstrap-admin CLI: passwordless Cognito user + USER#
 * admin membership + adminCount recount. Idempotent per email.
 */
app.post('/platform/tenants/:slug/admins', async (c) => {
  const slug = c.req.param('slug');
  const config = await repo.getTenantConfig(slug);
  if (!config) throw new HttpError(404, 'tenant not found');
  const body = await c.req.json<{ email?: string }>();
  const email = (body.email ?? '').trim().toLowerCase();
  if (!email) throw new HttpError(400, 'email required');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'valid email required');
  try {
    const { sub, adminCount } = await grantTenantAdmin(cognito, USER_POOL_ID, slug, email);
    return c.json({ tenant: slug, email, sub, adminCount }, 201);
  } catch (err: unknown) {
    // Same mapping as provisionInviteUser: an address Cognito rejects is a 400, not a 500.
    if ((err as { name?: string }).name === 'InvalidParameterException')
      throw new HttpError(400, 'enter a valid email address');
    throw err;
  }
});

/**
 * POST /platform/tenants/:slug/logo-upload — presigned POST (not PUT: only a POST
 * policy can enforce content-length-range) to the PUBLIC TutorialAssets bucket, so
 * the login page can show the assets unauthenticated. Body {contentType, kind?}
 * where kind is 'logo' (default) or 'hero'; response {url, fields, objectKey,
 * publicUrl} — the client submits multipart form-data with `fields` + the file to
 * `url`, then saves `publicUrl` as branding.logoUrl (logo) or as a url('…') value
 * in the --hero-image colour token (hero).
 */
app.post('/platform/tenants/:slug/logo-upload', async (c) => {
  const slug = c.req.param('slug');
  const config = await repo.getTenantConfig(slug);
  if (!config) throw new HttpError(404, 'tenant not found');
  const body = await c.req
    .json<{ contentType?: string; kind?: string }>()
    .catch(() => ({}) as { contentType?: string; kind?: string });
  // An unknown kind must 400, not silently fall back to logo limits — a typo'd kind
  // would otherwise surface as a baffling type/size rejection. Literal comparison,
  // not `in`: prototype keys (kind:"toString") would pass an `in` check and 500.
  const kind = body.kind || 'logo';
  if (kind !== 'logo' && kind !== 'hero') throw new HttpError(400, 'kind must be "logo" or "hero"');
  const rules = BRANDING_UPLOAD_KINDS[kind];
  const contentType = body.contentType;
  const ext = contentType ? rules.types[contentType] : undefined;
  if (!contentType || !ext)
    throw new HttpError(400, `contentType must be ${Object.keys(rules.types).join(', ')}`);
  if (!TUTORIALS_BUCKET)
    throw new HttpError(
      501,
      'asset upload requires the cloud assets bucket (unavailable in offline dev)',
    );
  const objectKey = `branding/${slug}/${kind}-${randomUUID().slice(0, 8)}.${ext}`;
  const post = await createPresignedPost(s3, {
    Bucket: TUTORIALS_BUCKET,
    Key: objectKey,
    Conditions: [
      ['content-length-range', 0, rules.maxBytes],
      ['eq', '$Content-Type', contentType],
      ['eq', '$Cache-Control', BRANDING_CACHE_CONTROL],
    ],
    Fields: { 'Content-Type': contentType, 'Cache-Control': BRANDING_CACHE_CONTROL },
    Expires: 300,
  });
  return c.json({
    url: post.url,
    fields: post.fields,
    objectKey,
    publicUrl: `${TUTORIALS_BASE_URL}/${objectKey}`,
  });
});

/**
 * Build a tutorial-asset object key: `tutorials/<slug>/<kind>-<uuid8>[-<sanitized
 * fileName>].<ext>`. The optional filename fragment is purely cosmetic (a human
 * skimming the bucket can tell "video-a1b2c3d4-nets-drill.mp4" from a bare uuid) — the
 * uuid8 segment alone already guarantees uniqueness, so a missing/unsafe fileName just
 * degrades to omitting the fragment rather than failing the upload.
 */
function tutorialObjectKey(
  slug: string,
  kind: 'video' | 'poster',
  ext: string,
  fileName?: string,
): string {
  const basename = (fileName ?? '').split(/[/\\]/).pop() ?? '';
  const sanitized = basename
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40);
  const parts = [kind, randomUUID().slice(0, 8), sanitized].filter(Boolean);
  return `tutorials/${slug}/${parts.join('-')}.${ext}`;
}

/**
 * POST /platform/tenants/:slug/tutorial-upload — presign an upload of a per-tenant
 * tutorial video or poster into the PUBLIC TutorialAssets bucket, under
 * `tutorials/<slug>/` (the shared default clips live directly under `tutorials/`, one
 * level up — see cleanupOrphanTutorialAssets' hard-safety prefix check). Body
 * {kind: 'video'|'poster', contentType, sizeBytes, fileName?}. A poster, or a video at
 * or under MULTIPART_THRESHOLD, gets a single presigned POST (mode 'post') like the
 * branding logo route; a larger video gets a multipart upload instead (mode
 * 'multipart') — Lambda/API Gateway can't proxy a multi-GB body, so the browser PUTs
 * each part straight to S3 against its own presigned URL, then calls .../complete.
 */
app.post('/platform/tenants/:slug/tutorial-upload', async (c) => {
  const slug = c.req.param('slug');
  const config = await repo.getTenantConfig(slug);
  if (!config) throw new HttpError(404, 'tenant not found');
  const body = await c.req
    .json<{ kind?: string; contentType?: string; sizeBytes?: number; fileName?: string }>()
    .catch(
      () => ({}) as { kind?: string; contentType?: string; sizeBytes?: number; fileName?: string },
    );
  const kind = body.kind;
  if (kind !== 'video' && kind !== 'poster')
    throw new HttpError(400, 'kind must be "video" or "poster"');
  const rules = TUTORIAL_UPLOAD_KINDS[kind];
  const contentType = body.contentType;
  const ext = contentType ? rules.types[contentType] : undefined;
  if (!contentType || !ext)
    throw new HttpError(400, `contentType must be ${Object.keys(rules.types).join(', ')}`);
  const sizeBytes = body.sizeBytes;
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0)
    throw new HttpError(400, 'sizeBytes must be a positive number');
  if (sizeBytes > rules.maxBytes)
    throw new HttpError(
      400,
      `${kind} exceeds the ${Math.round(rules.maxBytes / (1024 * 1024))} MB limit`,
    );
  if (!TUTORIALS_BUCKET)
    throw new HttpError(
      501,
      'asset upload requires the cloud assets bucket (unavailable in offline dev)',
    );
  const objectKey = tutorialObjectKey(slug, kind, ext, body.fileName);
  const publicUrl = `${TUTORIALS_BASE_URL}/${objectKey}`;

  if (kind === 'poster' || sizeBytes <= MULTIPART_THRESHOLD) {
    // A single-POST video only ever gets here at or under MULTIPART_THRESHOLD (the
    // branch above routes anything bigger to multipart), so cap the grant there rather
    // than at rules.maxBytes (2 GiB) — poster's maxBytes is already well under the
    // threshold, so it's unaffected.
    const maxPostBytes =
      kind === 'video' ? Math.min(rules.maxBytes, MULTIPART_THRESHOLD) : rules.maxBytes;
    const post = await createPresignedPost(s3, {
      Bucket: TUTORIALS_BUCKET,
      Key: objectKey,
      Conditions: [
        ['content-length-range', 0, maxPostBytes],
        ['eq', '$Content-Type', contentType],
        ['eq', '$Cache-Control', TUTORIAL_CACHE_CONTROL],
      ],
      Fields: { 'Content-Type': contentType, 'Cache-Control': TUTORIAL_CACHE_CONTROL },
      Expires: 300,
    });
    return c.json({ mode: 'post', url: post.url, fields: post.fields, objectKey, publicUrl });
  }

  // Each presigned UploadPart URL below accepts up to S3's own 5 GiB per-part cap — S3
  // has no equivalent of content-length-range for multipart, so nothing server-side
  // enforces the 2 GiB video total across parts. That's the browser's job (it slices
  // the file into MULTIPART_PART_SIZE chunks itself); a client that ignored it and PUT
  // an oversized part would sail through. Acceptable here because this route is
  // operator-only, unlike public-facing presigned-POST uploads.
  const { UploadId } = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: TUTORIALS_BUCKET,
      Key: objectKey,
      ContentType: contentType,
      CacheControl: TUTORIAL_CACHE_CONTROL,
    }),
  );
  const partCount = Math.ceil(sizeBytes / MULTIPART_PART_SIZE);
  const partUrls = await Promise.all(
    Array.from({ length: partCount }, (_, i) => {
      const partNumber = i + 1;
      return getSignedUrl(
        s3,
        new UploadPartCommand({
          Bucket: TUTORIALS_BUCKET,
          Key: objectKey,
          UploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: 6 * 3600 },
      ).then((url) => ({ partNumber, url }));
    }),
  );
  return c.json({
    mode: 'multipart',
    uploadId: UploadId,
    objectKey,
    publicUrl,
    partSizeBytes: MULTIPART_PART_SIZE,
    partUrls,
  });
});

/**
 * POST /platform/tenants/:slug/tutorial-upload/complete — finish a multipart tutorial
 * upload once every part has been PUT (the browser collects each part's ETag response
 * header — hence the bucket CORS exposeHeaders: ['ETag']). objectKey must sit under
 * THIS tenant's tutorials/<slug>/ prefix — the same hard safety line as
 * cleanupOrphanTutorialAssets, here guarding against completing an upload into
 * another tenant's (or the shared default's) key space.
 */
app.post('/platform/tenants/:slug/tutorial-upload/complete', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req
    .json<{
      objectKey?: string;
      uploadId?: string;
      parts?: { partNumber?: number; etag?: string }[];
    }>()
    .catch(
      () =>
        ({}) as {
          objectKey?: string;
          uploadId?: string;
          parts?: { partNumber?: number; etag?: string }[];
        },
    );
  const objectKey = body.objectKey ?? '';
  if (!objectKey.startsWith(`tutorials/${slug}/`))
    throw new HttpError(400, 'objectKey does not belong to this tenant');
  // S3 keys are literal (a real ".." segment), but the derived publicUrl is a browser
  // URL that WOULD normalize "tutorials/<slug>/../<file>" up into the shared-default
  // namespace one level above — reject before that can happen.
  if (objectKey.includes('..'))
    throw new HttpError(400, 'objectKey does not belong to this tenant');
  if (!body.uploadId) throw new HttpError(400, 'uploadId required');
  if (!TUTORIALS_BUCKET)
    throw new HttpError(
      501,
      'asset upload requires the cloud assets bucket (unavailable in offline dev)',
    );
  const parts = [...(body.parts ?? [])].sort((a, b) => (a.partNumber ?? 0) - (b.partNumber ?? 0));
  if (parts.length === 0) throw new HttpError(400, 'parts required');
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: TUTORIALS_BUCKET,
      Key: objectKey,
      UploadId: body.uploadId,
      MultipartUpload: { Parts: parts.map((p) => ({ ETag: p.etag, PartNumber: p.partNumber })) },
    }),
  );
  return c.json({ publicUrl: `${TUTORIALS_BASE_URL}/${objectKey}` });
});

/**
 * POST /platform/tenants/:slug/tutorial-upload/abort — cancel a multipart tutorial
 * upload (the operator navigated away, or a part failed). Same prefix guard as
 * .../complete. Idempotent: an already-gone upload (NoSuchUpload — e.g. the 3-day
 * lifecycle rule beat this call to it) is swallowed, not surfaced as an error.
 */
app.post('/platform/tenants/:slug/tutorial-upload/abort', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req
    .json<{ objectKey?: string; uploadId?: string }>()
    .catch(() => ({}) as { objectKey?: string; uploadId?: string });
  const objectKey = body.objectKey ?? '';
  if (!objectKey.startsWith(`tutorials/${slug}/`))
    throw new HttpError(400, 'objectKey does not belong to this tenant');
  // Same ".." guard as .../complete — see the comment there.
  if (objectKey.includes('..'))
    throw new HttpError(400, 'objectKey does not belong to this tenant');
  if (!body.uploadId) throw new HttpError(400, 'uploadId required');
  if (!TUTORIALS_BUCKET)
    throw new HttpError(
      501,
      'asset upload requires the cloud assets bucket (unavailable in offline dev)',
    );
  try {
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: TUTORIALS_BUCKET,
        Key: objectKey,
        UploadId: body.uploadId,
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'NoSuchUpload') throw err;
  }
  return c.json({ ok: true });
});

/**
 * GET /platform/tenants/:slug/dns — the domain sheet as DATA (the portal renders it).
 * `liveUrl` is where the client is ALREADY reachable (wildcard host, or vanity origin
 * once configured). `steps` are the OPTIONAL vanity-domain upsell: with the shared API
 * host, that's now a single web-cert reissue + one VANITY entry + client CNAMEs — no
 * per-tenant API cert. Real CNAME targets come from the deploy envs; the web target is
 * only populated once WEB_CNAME_TARGET is filled in infra/tenants.ts.
 */
app.get('/platform/tenants/:slug/dns', async (c) => {
  const slug = c.req.param('slug');
  const config = await repo.getTenantConfig(slug);
  if (!config) throw new HttpError(404, 'tenant not found');
  const liveUrl = canonicalWebOrigin(slug);
  const webTarget =
    WEB_CNAME_TARGET || '<CloudFront distribution domain — aws cloudfront list-distributions>';
  const apiTarget =
    SHARED_API_CNAME_TARGET || '<shared API Gateway regional domain — sst deploy output>';
  return c.json({
    tenant: slug,
    liveUrl,
    note: WILDCARD_ENABLED
      ? `This client is already live at ${liveUrl} — nothing to do. The steps below are ` +
        'only needed if the client wants their OWN vanity domain instead of the shared ' +
        'club subdomain.'
      : 'Vanity go-live checklist. Placeholders in angle brackets are operator-filled: ' +
        'pick the client web host (e.g. clubs.<client-domain>) and read the CNAME targets ' +
        'from the `sst deploy --stage prod` outputs.',
    steps: [
      {
        key: 'web-certificate',
        title: 'Reissue the WEB ACM certificate with the new SANs',
        detail:
          'ACM cannot add SANs to an existing certificate. Request a NEW us-east-1 ' +
          '(CloudFront) certificate covering ALL existing web hosts PLUS <webHost> and ' +
          'www.<webHost> — `npm --prefix packages/api run request-cert -- --region ' +
          'us-east-1 --replace <WEB_CERT_ARN> --add <webHost> --add www.<webHost>` builds ' +
          'the superset so a live SAN is never dropped. Validate via DNS, then update ' +
          'WEB_CERT_ARN in infra/tenants.ts. (The client shares the platform API host, so ' +
          'NO af-south-1 API cert is needed unless they insist on their own apiHost.)',
      },
      {
        key: 'client-dns',
        title: "Client DNS CNAME records (at the client's DNS provider / cPanel)",
        detail:
          'Add the ACM validation CNAMEs from the certificate step, plus the records below. ' +
          `Never advertise www.<slug>${process.env.WILDCARD_WEB_SUFFIX ?? '.club.medicoach.co.za'} ` +
          'forms — the wildcard certificate covers a single label only.',
        records: [
          { type: 'CNAME', host: '<webHost>', target: webTarget },
          { type: 'CNAME', host: 'www.<webHost>', target: webTarget },
        ],
      },
      {
        key: 'registry',
        title: 'Add the VANITY entry to infra/tenants.ts',
        detail:
          `Append { slug: '${slug}', webHost: '<webHost>', www: true, enabled: true } to ` +
          'VANITY (leave apiHost unset so the client shares the platform API host). ' +
          'TENANT_HOST_MAP, ALLOWED_ORIGINS, WEB_ORIGIN_MAP, the web alias and the SPA ' +
          'web→API map are all derived from it.',
      },
      {
        key: 'deploy',
        title: 'Deploy',
        detail:
          'First check `aws cloudfront list-distributions` for alias conflicts in the shared ' +
          'account (`sst diff` does not catch CNAMEAlreadyExists), then run ' +
          '`npx sst deploy --stage prod`. The user runs deploys — see the runbook.',
      },
    ],
    // The one shared API host every tenant already uses (informational).
    sharedApiHost: SHARED_API_HOST,
    sharedApiTarget: apiTarget,
  });
});

/**
 * POST /platform/tenants/:slug/setup-complete — stamp the operator's "setup done"
 * milestone (informational only; the client is already publicly live and every setting
 * stays editable). Records who + when. DELETE reopens. Kept OUT of the PUT merge-patch
 * so it's an explicit, audited action.
 */
app.post('/platform/tenants/:slug/setup-complete', async (c) => {
  const auth = c.get('auth')!;
  const slug = c.req.param('slug');
  // Direct put (NOT applyTenantConfigPatch — that strips these fields as a forgery guard).
  const config = await repo.getTenantConfig(slug);
  if (!config) throw new HttpError(404, 'tenant not found');
  const next: TenantConfig = { ...config, setupCompletedAt: now(), setupCompletedBy: auth.email };
  await repo.putTenantConfig(next);
  return c.json(next);
});

app.delete('/platform/tenants/:slug/setup-complete', async (c) => {
  const slug = c.req.param('slug');
  const config = await repo.getTenantConfig(slug);
  if (!config) throw new HttpError(404, 'tenant not found');
  // Drop the fields to reopen setup (putTenantConfig marshals with removeUndefinedValues).
  const next = { ...config };
  delete next.setupCompletedAt;
  delete next.setupCompletedBy;
  await repo.putTenantConfig(next);
  return c.json(next);
});

/**
 * GET /admin/users — list every user in the tenant for the Team & Access roster.
 *
 * Lists from the marker GSI, then ENRICHES each via getUser: the markers carry only
 * {sub,email,role} and NOT clubIds, so a rep's club scope has no other source. This is
 * a bounded N+1 (team-sized N) and intentional. POPIA: first endpoint to bulk-return
 * member emails — admin-gated, consistent with the documented invite exception.
 *
 * Shape: [{ sub, email, role, clubIds, invitedAt, status }], status = lastLoginAt
 * ? 'active' : 'pending'.
 */
app.get('/admin/users', async (c) => {
  const ra = c.get('requestAuth')!;
  const roster = await repo.listTenantUsers(ra.tenant);
  const rows = await Promise.all(
    roster.map(async (entry) => {
      const profile = await repo.getUser(entry.sub);
      const membership = profile?.memberships.find((m) => m.tenantId === ra.tenant);
      return {
        sub: entry.sub,
        email: profile?.email ?? entry.email,
        // Authoritative role from memberships; fall back to the marker for a half-written user.
        role: membership?.role ?? (entry.role as 'admin' | 'rep'),
        clubIds: membership?.clubIds ?? [],
        invitedAt: membership?.invitedAt,
        status: profile?.lastLoginAt ? ('active' as const) : ('pending' as const),
      };
    }),
  );
  return c.json(rows);
});

/**
 * POST /admin/users — invite a user (admin): create the Cognito account + USER#
 * membership record, optionally send a staff invite, and return a copyable login link.
 *
 * Email is normalized server-side (trim + lowercase) so the stored email / gsi1sk can't
 * drift from the Cognito username (a casing mismatch would orphan the account on
 * offboard). A re-invite of an ALREADY-ACTIVE user (a membership for this tenant +
 * lastLoginAt set) is a 409, not a silent role/scope reset. Inviting an admin runs the
 * adminCount increment in the same transaction as the user write.
 */
app.post('/admin/users', async (c) => {
  const ra = c.get('requestAuth')!;
  const body = await c.req.json<{
    email?: string;
    role?: 'admin' | 'rep';
    clubIds?: string[];
    channels?: Channel[];
    link?: string;
  }>();
  const email = (body.email ?? '').trim().toLowerCase();
  if (!email) throw new HttpError(400, 'email required');
  // Validate format BEFORE Cognito: an address Cognito rejects ("Username should be an
  // email") would otherwise surface as an opaque 500 instead of a clear 400.
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'valid email required');
  const role: 'admin' | 'rep' = body.role === 'admin' ? 'admin' : 'rep';
  const clubIds = role === 'admin' ? [] : (body.clubIds ?? []);
  if (role === 'rep' && clubIds.length === 0)
    throw new HttpError(400, 'a rep must be scoped to at least one club');

  // Validate the optional invite link up front (so a bad link fails before provisioning).
  // Falls back to the request-derived app origin when no link is supplied.
  const loginUrl = resolveLoginUrl(c, ra.tenant, body.link);
  if (body.channels !== undefined) validateChannels(body.channels);

  // Create (or reuse, for a multi-union invite) a CONFIRMED passwordless user.
  const sub = await provisionInviteUser(email);
  const existing = await repo.getUser(sub);
  const others = (existing?.memberships ?? []).filter((m) => m.tenantId !== ra.tenant);
  const prior = (existing?.memberships ?? []).find((m) => m.tenantId === ra.tenant);
  // Re-invite of an already-active user must not silently reset their role/clubIds.
  if (prior && existing?.lastLoginAt)
    throw new HttpError(409, 'user already active — use resend or edit role');

  const membership: Membership = {
    tenantId: ra.tenant,
    role,
    clubIds,
    // Keep the original invite stamp on a re-invite of a still-pending user.
    invitedAt: prior?.invitedAt ?? now(),
    invitedBy: prior?.invitedBy ?? ra.email,
  };
  const next: UserProfile = {
    sub,
    email,
    memberships: [...others, membership],
    onboardingSeen: existing?.onboardingSeen ?? {},
    ...(existing?.lastLoginAt ? { lastLoginAt: existing.lastLoginAt } : {}),
  };

  // adminCount delta = the admin-tier transition for this tenant: +1 when becoming an
  // admin, -1 when a re-invite demotes a still-pending admin to rep (else 0). The -1 case
  // routes through the transactional guard in writeUserGuarded, so re-inviting the only
  // admin down to rep is correctly blocked (409) instead of silently drifting the counter.
  const wasAdmin = prior?.role === 'admin';
  const delta: -1 | 0 | 1 =
    role === 'admin' && !wasAdmin ? 1 : role !== 'admin' && wasAdmin ? -1 : 0;
  await writeUserGuarded(ra.tenant, next, delta);

  let results: SendResult[] | undefined;
  if (body.channels && body.channels.length > 0) {
    const orgName = await tenantOrgName(ra.tenant);
    ({ results } = await sendStaffInvite({
      email,
      orgName,
      channels: body.channels,
      link: loginUrl,
    }));
  }
  return c.json({ sub, email, loginUrl, ...(results ? { results } : {}) }, 201);
});

/**
 * PATCH /admin/users/:sub — change a user's role and/or club scope within THIS tenant.
 *
 * Filter-then-reattach (never replace the whole memberships array — that would strip the
 * user's access in OTHER tenants). Admins force clubIds:[]; reps must keep ≥1 club. A
 * demote (admin→rep) goes through the transactional last-admin guard and is followed by
 * a global sign-out so the just-demoted user can't reuse an elevated token. Returns the
 * updated tenant row.
 */
app.patch('/admin/users/:sub', async (c) => {
  const ra = c.get('requestAuth')!;
  const sub = c.req.param('sub');
  const body = await c.req.json<{ role?: 'admin' | 'rep'; clubIds?: string[] }>();

  const profile = await repo.getUser(sub);
  const current = profile?.memberships.find((m) => m.tenantId === ra.tenant);
  if (!profile || !current) throw new HttpError(404, 'user not found in this tenant');

  const role = body.role ?? current.role;
  if (role !== 'admin' && role !== 'rep') throw new HttpError(400, 'invalid role');
  const clubIds = role === 'admin' ? [] : (body.clubIds ?? current.clubIds);
  if (role === 'rep' && clubIds.length === 0)
    throw new HttpError(400, 'a rep must be scoped to at least one club');

  const others = profile.memberships.filter((m) => m.tenantId !== ra.tenant);
  const updated: Membership = { ...current, role, clubIds };
  const next: UserProfile = { ...profile, memberships: [...others, updated] };

  const demote = current.role === 'admin' && role === 'rep';
  const promote = current.role === 'rep' && role === 'admin';
  const delta: -1 | 0 | 1 = demote ? -1 : promote ? 1 : 0;
  await writeUserGuarded(ra.tenant, next, delta);

  // Kill refresh tokens after a demote so no NEW elevated token can be minted (the
  // current one stays valid until it expires — bounded ≤ pool TTL window).
  if (demote) await adminGlobalSignOut(cognito, USER_POOL_ID, profile.email);

  return c.json({
    sub,
    email: profile.email,
    role,
    clubIds,
    invitedAt: updated.invitedAt,
    status: profile.lastLoginAt ? 'active' : 'pending',
  });
});

/**
 * DELETE /admin/users/:sub — remove a user's access to THIS tenant only.
 *
 * Filter-then-reattach to drop just this tenant's membership (mirrors erase-tenant): if
 * the user has no memberships left, fully offboard (deleteUser + Cognito delete); else
 * putUser with the rest. Removing an admin goes through the transactional last-admin
 * guard (blocks removing the last admin, incl. yourself). Then global sign-out.
 */
app.delete('/admin/users/:sub', async (c) => {
  const ra = c.get('requestAuth')!;
  const sub = c.req.param('sub');

  const profile = await repo.getUser(sub);
  const current = profile?.memberships.find((m) => m.tenantId === ra.tenant);
  if (!profile || !current) throw new HttpError(404, 'user not found in this tenant');

  const remaining = profile.memberships.filter((m) => m.tenantId !== ra.tenant);
  const wasAdmin = current.role === 'admin';

  if (remaining.length === 0) {
    // Full offboard. Guard the admin count BEFORE deleting so the last admin can't be
    // removed; on success drop the META item and the Cognito account. Unlike the PATCH /
    // partial-removal path (writeUserWithAdminDelta is one transaction), this decrement and
    // the deleteUser are NOT atomic — if deleteUser failed after the decrement, adminCount
    // would drift LOW, which only makes the guard stricter (never enables a lockout), so the
    // asymmetry is the safe direction; recountAdmins repairs any drift.
    if (wasAdmin) await guardAdminDecrement(ra.tenant);
    await repo.deleteUser(sub);
    await adminDeleteCognitoUser(cognito, USER_POOL_ID, profile.email);
  } else {
    const next: UserProfile = { ...profile, memberships: remaining };
    await writeUserGuarded(ra.tenant, next, wasAdmin ? -1 : 0);
  }
  // Revoke refresh tokens so removed access can't be re-minted on the next refresh.
  await adminGlobalSignOut(cognito, USER_POOL_ID, profile.email);
  return c.json({ ok: true });
});

/**
 * POST /admin/users/:sub/resend — re-send the staff invite (always allowed, even for an
 * active user who wants a fresh link). Returns the per-channel send results.
 */
app.post('/admin/users/:sub/resend', async (c) => {
  const ra = c.get('requestAuth')!;
  const sub = c.req.param('sub');
  const body = await c.req
    .json<{ channels?: Channel[]; link?: string }>()
    .catch(() => ({}) as { channels?: Channel[]; link?: string });

  const profile = await repo.getUser(sub);
  const membership = profile?.memberships.find((m) => m.tenantId === ra.tenant);
  if (!profile || !membership) throw new HttpError(404, 'user not found in this tenant');

  const channels =
    body.channels && body.channels.length > 0 ? body.channels : (['email'] as Channel[]);
  validateChannels(channels);
  const loginUrl = resolveLoginUrl(c, ra.tenant, body.link);
  const orgName = await tenantOrgName(ra.tenant);
  const { results } = await sendStaffInvite({
    email: profile.email,
    orgName,
    channels,
    link: loginUrl,
  });
  return c.json({ results });
});

/**
 * PATCH /admin/users/:sub/email — correct a mistyped email for a member who hasn't signed
 * in yet, so the right person can log in. The pool uses email as a relocatable alias over
 * the immutable sub (see adminUpdateCognitoUserEmail), so this moves the sign-in identity
 * without touching any USER#{sub} key.
 *
 * Validate everything BEFORE mutating (mirrors POST /admin/users). Update Cognito BEFORE
 * DynamoDB so a DB-write failure still leaves the user able to log in under the new email.
 * Auto-resends the staff invite to the corrected address. Pending-only: an active user
 * already proved their address works (note: lastLoginAt is global to the sub, not per-tenant).
 */
app.patch('/admin/users/:sub/email', async (c) => {
  const ra = c.get('requestAuth')!;
  const sub = c.req.param('sub');
  const body = await c.req.json<{ email?: string; link?: string }>();

  const profile = await repo.getUser(sub);
  const membership = profile?.memberships.find((m) => m.tenantId === ra.tenant);
  if (!profile || !membership) throw new HttpError(404, 'user not found in this tenant');

  // Pending-only: an active user has already signed in, so their address works.
  if (profile.lastLoginAt)
    throw new HttpError(400, 'can only correct the address of a member who has not signed in yet');

  const email = (body.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'valid email required');
  if (email === profile.email) throw new HttpError(400, 'email unchanged');

  // Collision: the marker listing already carries email — no per-row getUser fan-out needed.
  const roster = await repo.listTenantUsers(ra.tenant);
  if (roster.some((u) => u.sub !== sub && u.email === email))
    throw new HttpError(409, 'that email is already in use by another member');

  // Resolve link + org name up front so a bad link 400s before any mutation.
  const loginUrl = resolveLoginUrl(c, ra.tenant, body.link);
  const orgName = await tenantOrgName(ra.tenant);

  // Relocate the Cognito sign-in alias (tries sub, falls back to the current email alias).
  // Map alias collision → 409, a still-bad address → 400, a missing account → 404.
  try {
    await adminUpdateCognitoUserEmail(cognito, USER_POOL_ID, sub, profile.email, email);
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === 'AliasExistsException')
      throw new HttpError(409, 'that email is already in use by another account');
    if (name === 'InvalidParameterException')
      throw new HttpError(400, 'enter a valid email address');
    if (name === 'UserNotFoundException')
      throw new HttpError(404, 'this member’s sign-in account is missing — remove and re-invite');
    throw err;
  }

  // Persist the new email; reconcileUserMarkers refreshes every tenant marker (gsi1sk + email).
  await repo.putUser({ ...profile, email });

  // Re-send the invite to the corrected address so they receive a working link.
  const { results } = await sendStaffInvite({
    email,
    orgName,
    channels: ['email'],
    link: loginUrl,
  });
  return c.json({ sub, email, status: 'pending', results });
});

// ───────────────── Admin: club self-registration link ─────────────────

/** The tenant's active club signup link, or null. SPA builds the /signup?t= URL. */
app.get('/admin/club-signup-link', async (c) => {
  const ra = c.get('requestAuth')!;
  const cfg = await repo.getTenantConfig(ra.tenant);
  if (!cfg) throw new HttpError(404, 'tenant not found');
  return c.json({ clubSignupLink: cfg.clubSignupLink ?? null });
});

/**
 * Mint a fresh club signup link. Single active link per tenant: the prior token
 * is revoked once the new one is stored, and the CONFIG pointer is written via a
 * targeted update so a concurrent Settings save can't clobber or resurrect it.
 */
app.post('/admin/club-signup-link', async (c) => {
  const ra = c.get('requestAuth')!;
  const cfg = await repo.getTenantConfig(ra.tenant);
  if (!cfg) throw new HttpError(404, 'tenant not found');
  const token = randomUUID();
  const createdAt = now();
  await repo.putSignupToken(token, ra.tenant, createdAt);
  const oldToken = cfg.clubSignupLink?.token;
  if (oldToken && oldToken !== token) await repo.deleteToken(oldToken);
  await repo.updateClubSignupLink(ra.tenant, { token, createdAt });
  return c.json({ clubSignupLink: { token, createdAt } });
});

/** Revoke the club signup link (token + pointer). Idempotent. */
app.delete('/admin/club-signup-link', async (c) => {
  const ra = c.get('requestAuth')!;
  const cfg = await repo.getTenantConfig(ra.tenant);
  if (!cfg) throw new HttpError(404, 'tenant not found');
  if (cfg.clubSignupLink?.token) await repo.deleteToken(cfg.clubSignupLink.token);
  await repo.updateClubSignupLink(ra.tenant, null);
  return c.json({ ok: true });
});

// ───────────────────── Admin: player clearances ─────────────────────

/** Every clearance in the tenant (cohort-wide), for the admin console. */
/**
 * Audit a player-register export. The .xlsx is generated client-side from rosters already
 * fetched, so this records only the client-reported event (actor / time / row count / scope)
 * — a best-effort compliance signal, NOT an authoritative or tamper-proof access trail (see
 * ExportLogEntry). Admin-only via the /admin/* middleware. The body is coerced, never
 * rejected: a malformed payload must still produce a record rather than 400 and lose the
 * audit event entirely.
 */
app.post('/admin/export-log', async (c) => {
  const ra = c.get('requestAuth')!;
  const { rowCount, scope, erroredClubs } = await c.req.json<{
    rowCount?: number;
    scope?: string;
    erroredClubs?: number;
  }>();
  await repo.putExportLog(ra.tenant, {
    id: randomUUID(),
    kind: 'player-export',
    by: ra.email,
    sub: ra.sub,
    at: now(),
    rowCount: Number(rowCount) || 0,
    scope: scope === 'filtered' ? 'filtered' : 'all',
    erroredClubs: Number(erroredClubs) || 0,
  });
  return c.json({ ok: true });
});

/**
 * GET /admin/insights/demographics — anonymised cohort histograms (age / gender /
 * race) for the Season Insights dashboard, plus the exact per-league split and the
 * unattributed remainder. Buckets only — no player rows leave the API (the repo
 * read is already projection-limited to the five fields the histograms need).
 * Admin-only via the /admin/* middleware chain. The shape is additive: the
 * top-level fields are a bare DemographicsSummary, so a consumer that ignores
 * perLeague/unattributed still works (no deploy-order break).
 * `unattributed.totalPlayers` is the direct materiality measurement for the
 * backfill-player-team decision (see docs/runbooks/backfill-player-team.md).
 */
app.get('/admin/insights/demographics', async (c) => {
  const ra = c.get('requestAuth')!;
  const [config, clubs] = await Promise.all([
    repo.getTenantConfig(ra.tenant),
    repo.listClubs(ra.tenant),
  ]);
  const players = await repo.listPlayerDemographics(
    ra.tenant,
    clubs.map((cl) => cl.id),
  );
  const leagueKeys = (config?.leagues ?? []).map((l) => l.key);
  const { perLeague, unattributed } = demographicsByLeague(players, clubs, leagueKeys);
  return c.json({ ...summarizeDemographics(players), perLeague, unattributed });
});

app.get('/admin/clearances', async (c) => {
  const ra = c.get('requestAuth')!;
  const list = await repo.listAllClearances(ra.tenant);
  // `sourceRostered` is derived for the console, never stored: it says whether the source club
  // actually holds this player. Reject and reassign both key on it server-side, so the console
  // must be able to disable the one and offer the other rather than failing the admin after a
  // confirmation dialog. Only a PENDING REGISTRATION-origin clearance can be sourceless, so
  // that slice is all we ask about — see repo.filterExistingPlayers for the read shape.
  //
  // Three outcomes per clearance, and the third is not optional: rostered, not rostered, or NOT
  // ANSWERED. An unanswered pair must arrive at the console as an ABSENT field, never as
  // `false` — `false` is the confident state that disables Reject and asserts in copy that the
  // source club has no record of this player.
  const pending = list.filter((x) => x.status === 'pending' && x.origin === 'registration');
  let found = new Set<string>();
  let unresolved = new Set<string>();
  let derived = true;
  try {
    ({ found, unresolved } = await repo.filterExistingPlayers(
      ra.tenant,
      pending.map((x) => ({ clubId: x.fromClubId, naturalKey: x.playerNaturalKey })),
    ));
  } catch (err) {
    // An optional affordance hint must never take down the list it decorates. Omitting the
    // field is safe: the console fails CLOSED on absence (Reject stays disabled) and the
    // reject/reassign routes re-derive it themselves before mutating anything.
    derived = false;
    console.error('admin/clearances: sourceRostered derivation failed, omitting', err);
  }
  const view: AdminClearanceView[] = list.map((x) => {
    if (!derived || x.status !== 'pending' || x.origin !== 'registration') return x;
    const key = `${x.fromClubId}#${x.playerNaturalKey}`;
    return unresolved.has(key) ? x : { ...x, sourceRostered: found.has(key) };
  });
  return c.json(view);
});

/**
 * Union override: approve a clearance the source club has left unactioned, issuing it
 * on their behalf. Admin-only (the /admin/* middleware enforces it). There is no longer
 * a time window — any still-pending clearance can be overridden.
 *
 * The optional `reason` exists because override is doing double duty. It is also the only exit
 * for a clearance that should never have existed — a junk registration from a leaked link, or
 * a player who named a club they never played for — since reject is refused for sourceless
 * clearances and deletion is blocked while pending. (Disposal is: override, then DELETE the
 * now-active player, which also purges their ID docs from S3.) Without a note the resolved
 * record reads as "the Union approved this transfer" for a transfer that never happened, and
 * this history is read for disputes. The note is how it says otherwise.
 */
app.post('/admin/clearances/:cid/override', async (c) => {
  const ra = c.get('requestAuth')!;
  const cid = c.req.param('cid');
  const body = await c.req.json<{ fromClubId?: string; version?: number; reason?: string }>();
  if (!body.fromClubId) throw new HttpError(400, 'fromClubId required');
  if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500)) {
    throw new HttpError(400, 'reason must be a string of at most 500 characters');
  }
  const current = await repo.getClearance(ra.tenant, body.fromClubId, cid);
  if (!current) throw new HttpError(404, 'clearance not found');
  if (current.status !== 'pending') throw new HttpError(409, 'clearance already resolved');
  try {
    const resolved = await repo.resolveClearance(ra.tenant, body.fromClubId, cid, {
      mode: 'admin',
      at: now(),
      by: ra.email,
      reason: body.reason?.trim() || undefined,
      expectedVersion: body.version,
    });
    return c.json(resolved);
  } catch (err) {
    if (err instanceof VersionConflictError) throw new HttpError(409, 'clearance changed; refetch');
    if (err instanceof repo.PlayerExistsAtDestinationError) throw new HttpError(409, err.message);
    if (err instanceof repo.DestinationClubGoneError) throw new HttpError(409, err.message);
    throw err;
  }
});

/**
 * Union reallocation: move a SOURCELESS pending clearance to the club the player actually
 * left. Admin-only. Two shapes qualify, and the test is the same for both — the current
 * source club holds no row for this player:
 *   - a directory entry, for a club that has since registered (possibly under a name that
 *     slugs differently from the entry);
 *   - a real on-system club the player named but never played for — a mis-picked club, or
 *     one whose roster the player was never on.
 * After the move the clearance is a normal registration-origin one — the new club's rep sees
 * it in their portal and approves/rejects via the usual flow.
 *
 * Refused once the source club holds the player: the clearance is then genuinely in that
 * club's queue (it may be mid-review) and yanking it out from under them would be wrong.
 * That guard also makes the move safe mechanically — reassignClearanceSource writes a
 * placeholder at the NEW source and never touches the old partition, so a source row left
 * behind would be stranded 'clearance-pending' forever.
 */
app.post('/admin/clearances/:cid/reassign', async (c) => {
  const ra = c.get('requestAuth')!;
  const cid = c.req.param('cid');
  const body = await c.req.json<{
    fromClubId?: string;
    newFromClubId?: string;
    version?: number;
  }>();
  if (!body.fromClubId || !body.newFromClubId) {
    throw new HttpError(400, 'fromClubId and newFromClubId required');
  }
  if (body.newFromClubId === body.fromClubId) {
    throw new HttpError(400, 'the clearance is already assigned to that club');
  }
  const current = await repo.getClearance(ra.tenant, body.fromClubId, cid);
  if (!current) throw new HttpError(404, 'clearance not found');
  if (current.status !== 'pending') throw new HttpError(409, 'clearance already resolved');
  if (current.origin !== 'registration') {
    throw new HttpError(400, 'only registration-origin clearances can be reallocated');
  }
  if (body.newFromClubId === current.toClubId) {
    throw new HttpError(400, 'source cannot be the destination club');
  }
  // A directory entry whose slug a real club has since claimed under the SAME name is almost
  // certainly the club the player meant: the clearance is in that club's queue now (it may be
  // mid-review) and an admin must not yank it out from under them.
  if (current.fromClubDirectory && (await repo.getClub(ra.tenant, current.fromClubId))) {
    throw new HttpError(409, 'that club is now on the system — its rep must action the clearance');
  }
  // Otherwise reallocation is safe exactly when the clearance is SOURCELESS — the current
  // source club holds no row for this player — because reassignClearanceSource writes a
  // placeholder at the NEW source and never touches the old partition, so a source row left
  // behind would be stranded 'clearance-pending' forever. Sourceless also means that club
  // cannot action the clearance on an informed basis, which is what makes reallocation the
  // right tool rather than a yank away from a rep who could have decided.
  if (await repo.getPlayer(ra.tenant, current.fromClubId, current.playerNaturalKey)) {
    throw new HttpError(
      409,
      'that club holds this player on its roster — its rep must action the clearance',
    );
  }
  const newFromClub = await repo.getClub(ra.tenant, body.newFromClubId);
  if (!newFromClub) throw new HttpError(404, 'target club not found');
  try {
    const reassigned = await repo.reassignClearanceSource(
      ra.tenant,
      body.fromClubId,
      cid,
      newFromClub,
      {
        expectedVersion: body.version,
      },
    );
    // The clearance just landed in a NEW club's queue — often a directory clearance
    // finally reaching a real club — so its chairman gets the same heads-up a freshly
    // created clearance would have produced. Best-effort; never fails the reassign.
    const tenantConfig = await repo.getTenantConfig(ra.tenant).catch(() => null);
    await notifyClearanceOpened(ra.tenant, tenantConfig, newFromClub, reassigned, ra.email, {
      bypassCap: true,
    });
    return c.json(reassigned);
  } catch (err) {
    if (err instanceof VersionConflictError) throw new HttpError(409, 'clearance changed; refetch');
    if (err instanceof repo.PlayerExistsAtSourceError) {
      throw new HttpError(
        409,
        'the player already has a record at that club — use the normal clearance flow or override instead',
      );
    }
    if (err instanceof repo.DestinationClubGoneError) throw new HttpError(409, err.message);
    throw err;
  }
});

/**
 * Union reject: decline a pending clearance on the clubs' behalf. Admin-only (the
 * /admin/* middleware enforces it). For a rep-initiated clearance the source player returns
 * to 'active'. For a REGISTRATION-origin clearance the player STAYS on the destination
 * (current) club's roster flagged 'clearance-rejected' (reason copied onto the row) and is
 * removed from the source (previous) club. Same 404/409 semantics as the override route.
 *
 * TWO guards 409 before any of that, both because rejection is irreversible — there is no
 * reactivation endpoint, and for a registration-origin clearance the destination row is the
 * player's only surviving record:
 *   1. a directory source with no real club behind the slug — nobody exists to reject;
 *   2. a source club holding NO row for this player — nothing exists to reject ON.
 * Both route the admin to override & approve, or to reallocate. See the runbook at
 * docs/runbooks/backfill-declared-club-clearance.md.
 */
app.post('/admin/clearances/:cid/reject', async (c) => {
  const ra = c.get('requestAuth')!;
  const cid = c.req.param('cid');
  const body = await c.req.json<{ fromClubId?: string; version?: number; reason?: string }>();
  if (!body.fromClubId) throw new HttpError(400, 'fromClubId required');
  if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500)) {
    throw new HttpError(400, 'reason must be a string of at most 500 characters');
  }
  const current = await repo.getClearance(ra.tenant, body.fromClubId, cid);
  if (!current) throw new HttpError(404, 'clearance not found');
  if (current.status !== 'pending') throw new HttpError(409, 'clearance already resolved');
  // A directory-sourced clearance has no club rep who could ever legitimately reject, and
  // rejection is irreversible (no reactivation endpoint) — server-enforced, not UI copy.
  // The club-existence check re-permits reject once a real club owns the slug: the
  // decision is genuinely that club's then.
  if (current.fromClubDirectory && !(await repo.getClub(ra.tenant, current.fromClubId))) {
    throw new HttpError(
      409,
      'the previous club is not on the system — override & approve or reallocate instead',
    );
  }
  // Same irreversibility, different reason: a registration-origin clearance whose source club
  // holds NO row for this player gives its rep nothing to reject ON. That club is real and has
  // a rep, but "we have no record of them" is the EXPECTED answer — it is what a roster still
  // being digitised looks like — not a finding that the transfer is bogus. Acting on it would
  // flag a legitimately active player 'clearance-rejected', which is terminal and would be
  // their only surviving record. Override & approve or reallocate to the right club instead.
  if (
    current.origin === 'registration' &&
    !(await repo.getPlayer(ra.tenant, current.fromClubId, current.playerNaturalKey))
  ) {
    throw new HttpError(
      409,
      'the previous club has no record of this player — override & approve, or reallocate to the club they actually left',
    );
  }
  try {
    const rejected = await repo.rejectClearance(ra.tenant, body.fromClubId, cid, {
      at: now(),
      by: ra.email,
      reason: body.reason?.trim() || undefined,
      expectedVersion: body.version,
    });
    return c.json(rejected);
  } catch (err) {
    if (err instanceof VersionConflictError) throw new HttpError(409, 'clearance changed; refetch');
    throw err;
  }
});

// ───────────────────── Admin: registration reviews ─────────────────────

/** Every registration review in the tenant — off-system alerts (plus any legacy holds). */
app.get('/admin/registration-reviews', async (c) => {
  const ra = c.get('requestAuth')!;
  return c.json(await repo.listAllReviews(ra.tenant));
});

/**
 * Acknowledge an off-system alert (the player named a club not on the system). Admin-only.
 * Guarded to off-system alerts only. Carries destClubId (like the clearance override route
 * carries fromClubId) to rebuild the canonical key.
 */
app.post('/admin/registration-reviews/:rid/ack', async (c) => {
  const ra = c.get('requestAuth')!;
  const rid = c.req.param('rid');
  const body = await c.req.json<{ destClubId?: string; version?: number }>();
  if (!body.destClubId) throw new HttpError(400, 'destClubId required');
  const current = await repo.getRegistrationReview(ra.tenant, body.destClubId, rid);
  if (!current) throw new HttpError(404, 'registration review not found');
  if (current.kind !== 'off-system-alert')
    throw new HttpError(400, 'only off-system alerts can be acknowledged here');
  if (current.status !== 'open') throw new HttpError(409, 'registration review already resolved');
  try {
    const resolved = await repo.resolveReview(ra.tenant, body.destClubId, rid, {
      resolution: 'acknowledged',
      at: now(),
      by: ra.email,
      expectedVersion: body.version,
    });
    return c.json(resolved);
  } catch (err) {
    if (err instanceof VersionConflictError) throw new HttpError(409, 'review changed; refetch');
    throw err;
  }
});

// ───────────────────── User-management helpers ─────────────────────

/** Reject a channels array that's empty or carries an unknown channel (400). */
function validateChannels(channels: Channel[]): void {
  if (!Array.isArray(channels) || channels.length === 0)
    throw new HttpError(400, 'channels required');
  const bad = channels.find((ch) => ch !== 'email' && ch !== 'whatsapp');
  if (bad) throw new HttpError(400, `unknown channel: ${bad}`);
}

/**
 * Resolve the sign-in URL an invite should carry, for a given tenant. A client-supplied
 * `link` is validated STRICTLY against THIS tenant's own origins (originAllowedForTenant)
 * — never another tenant's host or a bare *.cloudfront.net — so an admin can't aim an
 * invite at a phishing clone. With no link, prefers the tenant's canonical origin (its
 * vanity host, else its wildcard host) so links are deterministic and single-host;
 * falls back to the request Origin or a localhost dev default only in the dormant
 * pre-wildcard state for a tenant with no vanity host.
 */
function resolveLoginUrl(c: Context<HonoEnv>, tenant: string, link?: string): string {
  if (link) {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new HttpError(400, 'valid link required');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new HttpError(400, 'valid link required');
    // Strict per-tenant validation the moment the tenant HAS a canonical origin (vanity
    // or wildcard) — that closes the phishing hole. A dormant tenant (no vanity, wildcard
    // off) has no origin to enforce against, so fall back to the broad app-origin check to
    // preserve today's behavior (localhost/CloudFront/enumerated).
    const ok = canonicalWebOrigin(tenant)
      ? originAllowedForTenant(url.origin, tenant)
      : originAllowed(url.origin);
    if (!ok) throw new HttpError(400, 'link host not allowed');
    return url.href;
  }
  const canonical = canonicalWebOrigin(tenant);
  if (canonical) return canonical;
  const origin = c.req.header('origin') ?? '';
  if (origin && originAllowed(origin)) return origin;
  // No usable origin (e.g. a server-to-server call) — return a harmless localhost
  // default so the response always carries a copyable link; the admin can correct it.
  return 'http://localhost:5173';
}

/**
 * The tenant's display name for invite copy, falling back to the slug. Thin
 * fetch-then-resolve wrapper over orgCopy (branding.ts) — the single fallback chain.
 */
async function tenantOrgName(tenant: string): Promise<string> {
  const cfg = await repo.getTenantConfig(tenant);
  return orgCopy(cfg ?? { tenant }).name;
}

/**
 * Write a user with an adminCount delta, lazily backfilling CONFIG.adminCount from
 * authoritative memberships when it's absent (legacy tenant) so the transactional
 * guard's `adminCount > 1` condition has a real value to compare. Maps the typed
 * last-admin rejection to a 409.
 */
async function writeUserGuarded(
  tenant: string,
  user: UserProfile,
  delta: -1 | 0 | 1,
): Promise<void> {
  if (delta !== 0) await ensureAdminCount(tenant);
  // Before a guarded decrement, prune phantom admins (membership but no Cognito user) so
  // the floor compares against REAL admins — an orphan must not mask the last-admin guard.
  if (delta === -1) await reconcileTenantAdmins(tenant, adminExists);
  try {
    await repo.writeUserWithAdminDelta(user, tenant, delta);
  } catch (err) {
    if (err instanceof LastAdminError) throw new HttpError(409, 'cannot remove the last admin');
    throw err;
  }
}

/**
 * Guard a standalone admin decrement (used on full-offboard DELETE, where there's no
 * user-item write to bundle into the transaction). Backfills adminCount if absent,
 * reconciles phantom admins, then conditionally decrements; a floor hit is the 409.
 */
async function guardAdminDecrement(tenant: string): Promise<void> {
  await ensureAdminCount(tenant);
  await reconcileTenantAdmins(tenant, adminExists);
  try {
    await repo.decrementAdminCount(tenant);
  } catch (err) {
    if (err instanceof LastAdminError) throw new HttpError(409, 'cannot remove the last admin');
    throw err;
  }
}

/** Bound Cognito existence check passed into reconcile (stubbed offline via LOCAL_AUTH). */
const adminExists = (email: string): Promise<boolean> =>
  cognitoUserExists(cognito, USER_POOL_ID, email);

/** Backfill CONFIG.adminCount from authoritative memberships when it's not yet set. */
async function ensureAdminCount(tenant: string): Promise<void> {
  const cfg = await repo.getTenantConfig(tenant);
  if (cfg && typeof cfg.adminCount !== 'number') await repo.recountAdmins(tenant);
}

// ───────────────────────── Helpers ─────────────────────────

async function applyClubPatch(
  tenant: string,
  id: string,
  patch: Partial<Club>,
  changedBy: string,
): Promise<Club> {
  try {
    return await repo.updateClub(tenant, id, patch, changedBy, now());
  } catch (err) {
    if (err instanceof VersionConflictError) throw new HttpError(409, 'club changed; refetch');
    throw err;
  }
}

/** Minimal view of an embedded fixture (the rest of the series payload is opaque here). */
interface FixtureLite {
  home?: string;
  away?: string;
  date?: string;
  round?: number;
  time?: string;
}

type LatLon = { lat?: number; lon?: number } | undefined;

/** Great-circle distance in km (mirrors the frontend `haversineKm`); 0 when coords are missing. */
function haversineKm(a: LatLon, b: LatLon): number {
  // Finiteness, not null-ness — parity with the web twin (src/data.ts), where an object
  // check let NaN through for a side with no coordinates and printed "NaN km".
  const finite = (p: LatLon): p is { lat: number; lon: number } =>
    !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon);
  if (!finite(a) || !finite(b)) return 0;
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

const seasonLabel = (year: number) => `${year}/${String((year + 1) % 100).padStart(2, '0')}`;

/**
 * Resolve the season label dynamically so it scales every year with no code change:
 * prefer a "YYYY/YY" token embedded in a series name (what the UI shows), else derive
 * it from the earliest start date, else the current year. Never returns '' — an empty
 * label would break the email copy and (worse) be rejected as an empty WhatsApp
 * template parameter.
 */
function seasonFromSeries(series: Series[]): string {
  for (const s of series) {
    const m = /\b(\d{4}\/\d{2})\b/.exec(typeof s.name === 'string' ? s.name : '');
    if (m) return m[1];
  }
  const starts = series
    .map((s) => s.startDate)
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .sort();
  if (starts[0]) {
    const y = new Date(starts[0]).getUTCFullYear();
    if (!Number.isNaN(y)) return seasonLabel(y);
  }
  return seasonLabel(new Date().getUTCFullYear());
}

function fmtFixtureDate(iso?: string): string {
  if (!iso) return 'Date TBA';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Build the plain-text schedule for a club across its released series, mirroring the
 * frontend's ClubFixturesView (round, date, H/A, opponent, venue, away round-trip km).
 * Returns the dynamic season alongside.
 */
export function buildClubSchedule(
  club: Club,
  releasedSeries: Series[],
  clubsById: Map<string, Club>,
): { text: string; season: string } {
  const season = seasonFromSeries(releasedSeries);
  const blocks: string[] = [];
  for (const s of releasedSeries) {
    // Match fixtures against the club's resolved team set (its `tm_…` ids for a
    // multi-team club, else its clubId). A same-club derby (both sides ours) lists
    // once from the home side's view, naming the other side as the opponent.
    const mine = new Set(teamIdsForClub(s, club.id));
    const fixtures = ((s.fixtures as FixtureLite[]) ?? [])
      .filter((f) => (f.home != null && mine.has(f.home)) || (f.away != null && mine.has(f.away)))
      .sort((a, b) => (a.round ?? 0) - (b.round ?? 0));
    if (fixtures.length === 0) continue;
    const lines = [String(s.name ?? 'Series')];
    for (const f of fixtures) {
      const isHome = f.home != null && mine.has(f.home);
      const me = resolveTeam(s, (isHome ? f.home : f.away) ?? '', clubsById);
      const opp = resolveTeam(s, (isHome ? f.away : f.home) ?? '', clubsById);
      // Same precedence as every screen: a HAND-SET ground first, then the allocated
      // one, then the home side's.
      //
      // `venueOverride` is what the fixture editor writes — for the "Secondary ground"
      // pick as much as for "Other" — without touching `venueName`. Reading only the
      // allocated name texted players a different ground from the one the portal was
      // showing them, for the single most common manual venue change there is.
      const override = (f as { venueOverride?: string }).venueOverride?.trim();
      const allocated = (f as { venueName?: string }).venueName;
      const venue =
        override ||
        allocated ||
        (isHome
          ? me.venue || club.ground?.venue || 'Home ground TBA'
          : opp.venue || 'Opponent ground TBA');
      let line = `  R${f.round ?? '?'} · ${fmtFixtureDate(f.date)}${f.time ? ` · ${f.time}` : ''} · ${isHome ? 'Home' : 'Away'} vs ${opp.name} · ${venue}`;
      // Distance to where the match is actually played; falls back to the opponent's
      // ground for a series that has never been through allocation.
      const vLat = (f as { venueLat?: number }).venueLat;
      const vLon = (f as { venueLon?: number }).venueLon;
      // Coordinates are only trustworthy when they describe the ground we just NAMED. An
      // override typed after the last allocation leaves the old ground's coordinates
      // behind, and quoting a round trip to a ground nobody is going to is worse than
      // quoting none.
      const coordsMatchVenue = !override || override === allocated;
      const pinnedVenue = coordsMatchVenue && Number.isFinite(vLat) && Number.isFinite(vLon);
      if (!isHome || pinnedVenue) {
        const to = pinnedVenue ? { lat: vLat, lon: vLon } : { lat: opp.lat, lon: opp.lon };
        const km = Math.round(haversineKm(to, club.ground) * 2);
        if (km > 0) line += ` · ${km.toLocaleString()} km round-trip`;
      }
      lines.push(line);
    }
    blocks.push(lines.join('\n'));
  }
  return { text: blocks.join('\n\n'), season };
}

/**
 * Collapse per-recipient fixtures results into <=2 PII-free per-channel rows: one
 * `SendResult` (returned to the chair + stored on the idempotency marker for replay,
 * carrying the count in its dedicated `summary` field — never in `error`) and one
 * matching `ClubCommEvent` (kind: 'fixtures', no recipient `to`). Keeps the
 * marker/comm-log small and free of player PII. The summary counts only — it omits a
 * total denominator so a roster of mostly-minors (all legitimately skipped) doesn't
 * read as a partial failure.
 */
function summarizeFixtures(
  results: SendResult[],
  channels: Channel[],
  by: string,
  idempotencyKey: string,
): { summaryResults: SendResult[]; commEvents: ClubCommEvent[] } {
  const at = now();
  const summaryResults: SendResult[] = [];
  const commEvents: ClubCommEvent[] = [];
  for (const channel of channels) {
    const forCh = results.filter((r) => r.channel === channel);
    const sent = forCh.filter((r) => r.status === 'sent').length;
    const failed = forCh.filter((r) => r.status === 'failed').length;
    const skipped = forCh.filter((r) => r.status === 'skipped').length;
    const status: SendResult['status'] = sent > 0 ? 'sent' : failed > 0 ? 'failed' : 'skipped';
    const parts = [`${sent} sent`];
    if (skipped) parts.push(`${skipped} skipped`);
    if (failed) parts.push(`${failed} failed`);
    const summary = parts.join(' · ');
    summaryResults.push({ channel, status, summary });
    commEvents.push({
      id: randomUUID(),
      channel,
      status,
      at,
      by,
      idempotencyKey,
      kind: 'fixtures',
      summary,
    });
  }
  return { summaryResults, commEvents };
}

function affiliationFieldsTouched(patch: Partial<Club>): boolean {
  return ['affiliation', 'exco', 'coaches', 'ground', 'leagues'].some((k) => k in patch);
}

const COLORS = ['#1B2A4A', '#1D9E75', '#C8A84B', '#D85A30', '#2E4070', '#243356', '#8A6E1C'];

/**
 * Build the initial `exco.chair` from the flat chair contact fields the admin onboard
 * form sends. Returns undefined when no chair fields are present so genuinely-empty
 * creates don't get an empty chair record. Shape matches what the affiliation form
 * reads/writes (`exco.chair = { name, cell, email, ... }`).
 */
function buildInitialExco(spec: ClubSpec): Record<string, unknown> | undefined {
  const name = spec.chair?.trim();
  const email = spec.chairEmail?.trim();
  const cell = spec.chairCell?.trim();
  if (!name && !email && !cell) return undefined;
  return { chair: { name: name ?? '', email: email ?? '', cell: cell ?? '' } };
}

function buildClubFromSpec(spec: ClubSpec): Club {
  const id = spec.id ?? clubIdFromName(spec.name ?? 'club');
  return {
    id,
    name: spec.name ?? 'New Club',
    district: spec.district ?? '',
    sub: spec.sub ?? '',
    chair: spec.chair ?? '',
    affiliation: 'not_started',
    cqi: 0,
    docs: {
      constitution: false,
      agm: false,
      financials: false,
      exco: false,
      codeOfConduct: false,
      safeguarding: false,
    },
    players: 0,
    teams: 0,
    women: 0,
    juniors: 0,
    color: COLORS[Math.abs(hashCode(id)) % COLORS.length],
    ground: {},
    leagues: [],
    exco: spec.exco ?? buildInitialExco(spec),
    onboardedAt: now(),
    version: 1,
  };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}

// ───────────────────────── Error handling ─────────────────────────

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  // A body that isn't JSON throws SyntaxError out of `c.req.json()`. That is the caller's
  // mistake, not ours: answering 500 blames the server for it AND pages Sentry every time
  // a script sends a truncated payload. Nothing else in a request throws SyntaxError.
  if (err instanceof SyntaxError) return c.json({ error: 'body must be valid JSON' }, 400);
  // Unexpected (non-HttpError) → report. Tenant/user/role were tagged in authenticate.
  // No-op when Sentry was not initialised (no DSN). 4xx HttpErrors are intentionally
  // excluded above so expected validation/auth failures don't create noise.
  Sentry.captureException(err);
  console.error('unhandled error', err);
  return c.json({ error: 'internal error' }, 500);
});

// wrapHandler is the OUTER wrapper: it flushes queued events (incl. the onError
// capture above) before the Lambda returns, and catches anything that escapes Hono
// entirely (init failures, timeouts — best-effort). No double-capture: onError
// returns a 500 response, so route errors never propagate out to wrapHandler.
export const handler = Sentry.wrapHandler(handle(app));
// Exported so the local dev server (src/local/server.ts) can serve the same app.
export { app };

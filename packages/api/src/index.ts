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
import { createHash, randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
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
import {
  validateClubPatch,
  VALID_DISTRICTS,
  DOC_KEYS,
  DOC_CONTENT_TYPES,
  MIN_SAFEGUARDING_FILES,
  MAX_SAFEGUARDING_FILES,
} from './catalogue.js';
import {
  sendClubFixtures,
  sendStaffInvite,
  sendChairOnboarding,
  type Channel,
  type SendResult,
} from './notify/index.js';
import type {
  Club,
  ClubCommEvent,
  ClubSpec,
  Membership,
  Series,
  TenantConfig,
  TutorialVideo,
  UserProfile,
  PlayerRegistration,
  PlayerClearance,
} from './types.js';
import { teamIdsForClub, resolveTeam } from './teams.js';
import { orgCopy } from './branding.js';
import { hasFeature } from './features.js';
import { buildTenantConfig, type TenantBrandingInput } from './seed-core.js';
import { validateTenantSlug } from './tenant-validation.js';
import { grantTenantAdmin } from './tenant-admin.js';

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

/** A tenant's tutorial videos, falling back to the shared default set. */
const tutorialsFor = (config: TenantConfig | null): TutorialVideo[] =>
  config?.tutorials?.length ? config.tutorials : DEFAULT_TUTORIALS;
const cognito = new CognitoIdentityProviderClient({});
const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET!;
// Public TutorialAssets bucket (also hosts tenant logos under branding/<slug>/ —
// the login page shows logos unauthenticated, so the private Uploads bucket is
// wrong for them). Set in sst.config.ts; '' offline (logo upload is cloud-only).
const TUTORIALS_BUCKET = process.env.TUTORIALS_BUCKET ?? '';
const USER_POOL_ID = process.env.USER_POOL_ID!;
const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB

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

// CORS: allow localhost (dev), *.cloudfront.net, and any host in ALLOWED_ORIGINS.
// A wildcard origin alongside bearer tokens + the x-tenant header is too open.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * True if `origin` (scheme://host[:port]) is a trusted app origin: localhost (dev),
 * any *.cloudfront.net, or an explicit ALLOWED_ORIGINS entry (custom tenant domains).
 * Shared by CORS and the invite-link host check so an admin can't send an invite
 * pointing at an arbitrary/phishing domain.
 */
function originAllowed(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname.endsWith('.cloudfront.net');
  } catch {
    return false;
  }
}

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
    // How-to-use-the-app videos for the public /tutorials page (non-sensitive; falls
    // back to the shared default set when the tenant has no override).
    tutorials: tutorialsFor(config),
    // Per-tenant feature flags (boolean map; defaults resolve client/server-side
    // via hasFeature/useFeature, so an empty map is a valid "all defaults" state).
    features: config.features ?? {},
  });
});

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
  return c.json({
    tenant: resolved.tenant,
    clubId: club.id,
    clubName: club.name,
    leagues: cfg?.leagues ?? [],
    // Sibling clubs for the "club for which last registered" dropdown. Public
    // (token-gated) exposure of id+name ONLY — the same projection reps get from
    // /clubs/directory; club names are non-sensitive here.
    clubs: (await repo.listClubs(resolved.tenant))
      .filter((cl) => cl.id !== club.id)
      .map((cl) => ({ id: cl.id, name: cl.name })),
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
  // Same per-token cap as the presign route (shared counter). The submit is
  // unauthenticated, and the previous-club path below both reveals whether an ID
  // number is registered at a named club and flips that player to
  // 'clearance-pending' — neither may be an unthrottled anonymous primitive.
  const allowed = await repo.bumpSignupTokenCounter(token, now(), REGISTRATIONS_PER_HOUR);
  if (!allowed) throw new HttpError(429, 'too many registrations — please try again later');
  // cfg feeds the team/league validation below; the club read is the 404 check.
  const cfg = await repo.getTenantConfig(resolved.tenant);
  const regClub = await repo.getClub(resolved.tenant, clubId);
  if (!regClub) throw new HttpError(404, 'club not found');
  const body = await c.req.json<Partial<PlayerRegistration> & { lastClubId?: string }>();
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
  assertOwnObjectKey(resolved.tenant, clubId, idDocMeta.objectKey);
  const naturalKey = playerNaturalKey({ ...body, dob });
  const player: PlayerRegistration = {
    naturalKey,
    clubId,
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

  // Previous-club path: the form sent a real club id (dropdown pick) instead of free
  // text. If the player has a matching registration there, this becomes a transfer —
  // the row is created here as 'clearance-pending' together with a clearance the
  // source club (or the union office) must resolve before the player goes active.
  const lastClubId = typeof body.lastClubId === 'string' ? body.lastClubId.trim() : '';
  if (lastClubId) {
    if (lastClubId === clubId) {
      throw new HttpError(400, 'previous club cannot be the club you are registering for');
    }
    const sourceClub = await repo.getClub(resolved.tenant, lastClubId);
    if (!sourceClub) throw new HttpError(400, 'unknown previous club');
    // The selected club's name is the stored lastClub text whether or not a
    // matching registration is found there.
    player.lastClub = sourceClub.name;
    const sourcePlayer = await findPlayerByIdNumber(resolved.tenant, lastClubId, body.idNumber);
    // The clearance machinery addresses BOTH rows by one playerNaturalKey, so the
    // source row's key must equal this registration's (a passport nationality
    // respelling can diverge them). On mismatch — or no match at all — fall back to
    // a plain registration rather than opening an unresolvable clearance.
    if (sourcePlayer && sourcePlayer.naturalKey === naturalKey) {
      player.status = 'clearance-pending';
      const clearance: PlayerClearance = {
        id: randomUUID(),
        playerNaturalKey: naturalKey,
        playerName: `${player.firstName} ${player.lastName}`,
        idNumber: player.idNumber,
        team: player.team,
        fromClubId: lastClubId,
        toClubId: clubId,
        fromClubName: sourceClub.name,
        toClubName: regClub.name,
        // requestedAt feeds the admin-list gsi1 sort key — required even though no
        // rep initiated this (requestedBy stays absent; origin says who did).
        requestedAt: now(),
        origin: 'registration',
        feesCleared: false,
        misconductCleared: false,
        status: 'pending',
        clubApprovedAt: null,
        adminOverrideAt: null,
        version: 0,
      };
      try {
        await repo.createPlayerWithClearance(resolved.tenant, player, clearance);
      } catch (err: unknown) {
        // Deliberately ONE message for both conflict shapes: an anonymous caller
        // must not be able to distinguish "registered at the destination" from
        // "mid-clearance at the source" and use this endpoint as a status oracle.
        if (
          err instanceof repo.PlayerExistsAtDestinationError ||
          err instanceof repo.DuplicatePendingClearanceError
        ) {
          throw new HttpError(409, 'already registered or a transfer is already in progress');
        }
        if (err instanceof repo.DestinationClubGoneError) throw new HttpError(409, err.message);
        throw err;
      }
      return c.json({ ok: true, clearance: { fromClubName: sourceClub.name } }, 201);
    }
  }

  try {
    await repo.createPlayer(resolved.tenant, player);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Same wording as the clearance-path conflicts (see above) — the pair must be
      // indistinguishable to an anonymous caller.
      throw new HttpError(409, 'already registered or a transfer is already in progress');
    }
    throw err;
  }
  return c.json({ ok: true }, 201);
});

// Per-reg-token hourly cap shared by the presign AND submit handlers (one counter per
// token — a normal registration spends two: presign + submit). High enough for a club's
// full roster to self-register in one onboarding window, low enough to bound anonymous
// probing/state-flipping via the previous-club path on the submit route.
const REGISTRATIONS_PER_HOUR = 240;

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
    districts: [...VALID_DISTRICTS],
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
  if (!VALID_DISTRICTS.has(district)) throw new HttpError(400, `unknown district: ${district}`);
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

// All /clubs, /series, /tenant/config, /admin routes require a tenant membership.
app.use('/clubs/*', authenticate, requireTenantMembership);
app.use('/clubs', authenticate, requireTenantMembership);
app.use('/series/*', authenticate, requireTenantMembership);
app.use('/series', authenticate, requireTenantMembership);
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
  const invalid = validateClubPatch(patch, validLeagueKeys, validDocKeys);
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
function deliverableBaseUrl(c: Context<HonoEnv>): string | null {
  const base = resolveLoginUrl(c);
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

  const base = deliverableBaseUrl(c);
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
  const releasedSeries = allSeries.filter((s) => {
    if (!s.released || !Array.isArray(s.teams)) return false;
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

app.get('/series', async (c) => {
  const { tenant } = c.get('requestAuth')!;
  return c.json(await repo.listSeries(tenant));
});

app.post('/series', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const series = await c.req.json<Series>();
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
): Promise<TenantConfig> {
  const current = await repo.getTenantConfig(tenant);
  if (!current) throw new HttpError(404, 'tenant not found');
  // clubSignupLink is server-owned and written only via its targeted routes — a stale
  // Settings tab's whole-config save must not resurrect a revoked link. registrationAccess
  // is retired; strip it too so an old client can't write it back onto the row.
  delete (patch as { clubSignupLink?: unknown }).clubSignupLink;
  delete (patch as { registrationAccess?: unknown }).registrationAccess;
  // Table/index keys are derived at the repo write choke point — strip them here
  // too so a malicious patch can't even attempt to retarget another tenant's row
  // or corrupt the platform registry index.
  delete (patch as { pk?: unknown }).pk;
  delete (patch as { sk?: unknown }).sk;
  delete (patch as { gsi1pk?: unknown }).gsi1pk;
  delete (patch as { gsi1sk?: unknown }).gsi1sk;
  // Guard the league catalogue: keys are the matching token stored on clubs, so they
  // must be unique and present. Reject a patch that would introduce a duplicate/blank key.
  if (patch.leagues !== undefined) {
    const keys = patch.leagues.map((l) => l.key);
    if (keys.some((k) => !k)) throw new HttpError(400, 'every league needs a key');
    if (patch.leagues.some((l) => !l.label?.trim()))
      throw new HttpError(400, 'every league needs a label');
    if (new Set(keys).size !== keys.length) throw new HttpError(409, 'duplicate league key');
  }
  const next = { ...current, ...patch, tenant };
  await repo.putTenantConfig(next);
  return next;
}

app.put('/tenant/config', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const patch = await c.req.json<Partial<TenantConfig>>();
  // Operator-only fields (ADR 0006): feature flags, tutorials and the admin count
  // are never writable by a tenant admin. Stripped here (not in the shared
  // applyTenantConfigPatch) because the operator route whitelists separately.
  delete (patch as { features?: unknown }).features;
  delete (patch as { tutorials?: unknown }).tutorials;
  delete (patch as { adminCount?: unknown }).adminCount;
  const next = await applyTenantConfigPatch(tenant, patch);
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

/** Allowed logo upload types → stored extension (allowlist doubles as the gate). */
const LOGO_CONTENT_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};
const MAX_LOGO_BYTES = 1024 * 1024; // 1 MB

/** GET /platform/tenants — registry listing (projection, not full configs). */
app.get('/platform/tenants', async (c) => {
  const tenants = await repo.listTenants();
  return c.json(
    tenants.map((t) => ({
      tenant: t.tenant,
      name: t.branding?.name ?? t.tenant,
      title: t.branding?.title ?? '',
      logoUrl: t.branding?.logoUrl ?? '',
      submissionDeadline: t.submissionDeadline,
      adminCount: t.adminCount ?? 0,
      features: t.features ?? {},
    })),
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
  const config = buildTenantConfig(slug, { ...body.branding, name }, deadline, body.features);
  try {
    await repo.createTenantConfig(config);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException')
      throw new HttpError(409, `tenant "${slug}" already exists`);
    throw err;
  }
  return c.json(config, 201);
});

/** GET /platform/tenants/:slug — the full config row (operator edit form). */
app.get('/platform/tenants/:slug', async (c) => {
  const config = await repo.getTenantConfig(c.req.param('slug'));
  if (!config) throw new HttpError(404, 'tenant not found');
  return c.json(config);
});

/**
 * PUT /platform/tenants/:slug — merge-patch branding / features / submissionDeadline
 * (whitelisted: the operator portal edits nothing else). Shares applyTenantConfigPatch
 * with PUT /tenant/config, so the same strip-and-merge + league guards apply.
 */
app.put('/platform/tenants/:slug', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.json<Partial<TenantConfig>>();
  const patch: Partial<TenantConfig> = {};
  if (body.branding !== undefined) patch.branding = body.branding;
  if (body.features !== undefined) patch.features = body.features;
  if (body.submissionDeadline !== undefined) {
    const deadline = String(body.submissionDeadline).trim();
    if (!deadline || Number.isNaN(Date.parse(deadline)))
      throw new HttpError(400, 'valid submissionDeadline required (ISO date)');
    patch.submissionDeadline = body.submissionDeadline;
  }
  const next = await applyTenantConfigPatch(slug, patch);
  return c.json(next);
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
 * the login page can show the logo unauthenticated. Body {contentType}; response
 * {url, fields, objectKey, publicUrl} — the client submits multipart form-data with
 * `fields` + the file to `url`, then saves `publicUrl` as branding.logoUrl.
 */
app.post('/platform/tenants/:slug/logo-upload', async (c) => {
  const slug = c.req.param('slug');
  const config = await repo.getTenantConfig(slug);
  if (!config) throw new HttpError(404, 'tenant not found');
  const { contentType } = await c.req
    .json<{ contentType?: string }>()
    .catch(() => ({ contentType: undefined }));
  const ext = contentType ? LOGO_CONTENT_TYPES[contentType] : undefined;
  if (!contentType || !ext)
    throw new HttpError(400, 'contentType must be image/png, image/svg+xml or image/webp');
  if (!TUTORIALS_BUCKET)
    throw new HttpError(
      501,
      'logo upload requires the cloud assets bucket (unavailable in offline dev)',
    );
  const objectKey = `branding/${slug}/logo-${randomUUID().slice(0, 8)}.${ext}`;
  const post = await createPresignedPost(s3, {
    Bucket: TUTORIALS_BUCKET,
    Key: objectKey,
    Conditions: [
      ['content-length-range', 0, MAX_LOGO_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
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
 * GET /platform/tenants/:slug/dns — the vanity-domain go-live instruction sheet as
 * DATA (the portal renders it): cert-SAN reissue, client CNAMEs (operator fills the
 * targets from `sst deploy` outputs), the infra/tenants.ts VANITY entry, deploy.
 */
app.get('/platform/tenants/:slug/dns', async (c) => {
  const slug = c.req.param('slug');
  const config = await repo.getTenantConfig(slug);
  if (!config) throw new HttpError(404, 'tenant not found');
  return c.json({
    tenant: slug,
    note:
      'Vanity go-live checklist. Placeholders in angle brackets are operator-filled: ' +
      'pick the client hosts (e.g. clubs.<client-domain> / api.clubs.<client-domain>) ' +
      'and read the CNAME targets from the `sst deploy --stage prod` outputs.',
    steps: [
      {
        key: 'certificates',
        title: 'Reissue ACM certificates with the new SANs',
        detail:
          'ACM cannot add SANs to an existing certificate. Request NEW certificates — ' +
          'us-east-1 for CloudFront (web) and af-south-1 for API Gateway — covering ALL ' +
          'existing tenant hosts PLUS <webHost>, www.<webHost> and <apiHost>. Validate via ' +
          'DNS, then update WEB_CERT_ARN / API_CERT_ARN in infra/tenants.ts. This must ' +
          'COMPLETE before the deploy that adds the new aliases.',
      },
      {
        key: 'client-dns',
        title: "Client DNS CNAME records (at the client's DNS provider / cPanel)",
        detail:
          'Add the ACM validation CNAMEs from the certificate step, plus the records below. ' +
          'Targets come from the current deploy outputs (CloudFront distribution domain for ' +
          'web; API Gateway regional custom-domain target for api).',
        records: [
          {
            type: 'CNAME',
            host: '<webHost>',
            target: '<CloudFront distribution domain — sst deploy output>',
          },
          {
            type: 'CNAME',
            host: 'www.<webHost>',
            target: '<same CloudFront distribution domain>',
          },
          {
            type: 'CNAME',
            host: '<apiHost>',
            target: '<API Gateway regional domain — sst deploy output>',
          },
        ],
      },
      {
        key: 'registry',
        title: 'Add the VANITY entry to infra/tenants.ts',
        detail:
          `Append { slug: '${slug}', webHost: '<webHost>', www: true, apiHost: '<apiHost>', ` +
          `enabled: true } to VANITY so TENANT_HOST_MAP, ALLOWED_ORIGINS, the web aliases ` +
          `and the API domain mapping are all derived for this tenant.`,
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
  });
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
  const loginUrl = resolveLoginUrl(c, body.link);
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
  const loginUrl = resolveLoginUrl(c, body.link);
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
  const loginUrl = resolveLoginUrl(c, body.link);
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
app.get('/admin/clearances', async (c) => {
  const ra = c.get('requestAuth')!;
  return c.json(await repo.listAllClearances(ra.tenant));
});

/**
 * Union override: approve a clearance the source club has left unactioned, issuing it
 * on their behalf. Admin-only (the /admin/* middleware enforces it). There is no longer
 * a time window — any still-pending clearance can be overridden.
 */
app.post('/admin/clearances/:cid/override', async (c) => {
  const ra = c.get('requestAuth')!;
  const cid = c.req.param('cid');
  const body = await c.req.json<{ fromClubId?: string; version?: number }>();
  if (!body.fromClubId) throw new HttpError(400, 'fromClubId required');
  const current = await repo.getClearance(ra.tenant, body.fromClubId, cid);
  if (!current) throw new HttpError(404, 'clearance not found');
  if (current.status !== 'pending') throw new HttpError(409, 'clearance already resolved');
  try {
    const resolved = await repo.resolveClearance(ra.tenant, body.fromClubId, cid, {
      mode: 'admin',
      at: now(),
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
 * Union reject: decline a pending clearance on the clubs' behalf. Admin-only (the
 * /admin/* middleware enforces it). The source player returns to 'active'; a
 * registration-origin clearance's pre-created destination row is removed. Same
 * 404/409 semantics as the override route.
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

// ───────────────────── User-management helpers ─────────────────────

/** Reject a channels array that's empty or carries an unknown channel (400). */
function validateChannels(channels: Channel[]): void {
  if (!Array.isArray(channels) || channels.length === 0)
    throw new HttpError(400, 'channels required');
  const bad = channels.find((ch) => ch !== 'email' && ch !== 'whatsapp');
  if (bad) throw new HttpError(400, `unknown channel: ${bad}`);
}

/**
 * Resolve the sign-in URL an invite should carry. Prefers a client-supplied `link`
 * (so it rides the tenant's own custom domain), validated to be http(s) on a TRUSTED
 * app origin — so an admin can't aim an invite at a phishing domain. Falls back to the
 * request's own Origin (or a localhost dev default) when no link is supplied.
 */
function resolveLoginUrl(c: Context<HonoEnv>, link?: string): string {
  if (link) {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new HttpError(400, 'valid link required');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new HttpError(400, 'valid link required');
    if (!originAllowed(url.origin)) throw new HttpError(400, 'link host not allowed');
    return url.href;
  }
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
}

type LatLon = { lat?: number; lon?: number } | undefined;

/** Great-circle distance in km (mirrors the frontend `haversineKm`); 0 when coords are missing. */
function haversineKm(a: LatLon, b: LatLon): number {
  if (!a || !b || a.lat == null || a.lon == null || b.lat == null || b.lon == null) return 0;
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
function buildClubSchedule(
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
      const venue = isHome
        ? me.venue || club.ground?.venue || 'Home ground TBA'
        : opp.venue || 'Opponent ground TBA';
      let line = `  R${f.round ?? '?'} · ${fmtFixtureDate(f.date)} · ${isHome ? 'Home' : 'Away'} vs ${opp.name} · ${venue}`;
      if (!isHome) {
        const km = Math.round(haversineKm({ lat: opp.lat, lon: opp.lon }, club.ground) * 2);
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

/**
 * Canonical club id from a name. Shared by buildClubFromSpec and the public
 * signup's collision pre-check, which MUST slug exactly the way the id is built
 * ("Kingsmead-CC" and "Kingsmead CC" are distinct names but the same id).
 */
function clubIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
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

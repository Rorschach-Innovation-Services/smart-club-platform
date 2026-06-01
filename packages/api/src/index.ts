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
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { handle } from 'hono/aws-lambda';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { ensurePasswordlessUser } from './cognito-users.js';
import {
  authenticate,
  requireTenantMembership,
  requireAdmin,
  assertClubAccess,
  resolveTenant,
  HttpError,
  type HonoEnv,
} from './auth.js';
import * as repo from './repo.js';
import { VersionConflictError } from './repo.js';
import { validateClubPatch } from './catalogue.js';
import type { Club, Series, TenantConfig, PlayerRegistration } from './types.js';

const s3 = new S3Client({});
const cognito = new CognitoIdentityProviderClient({});
const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB

const app = new Hono<HonoEnv>();

// CORS: allow localhost (dev), *.cloudfront.net, and any host in ALLOWED_ORIGINS.
// A wildcard origin alongside bearer tokens + the x-tenant header is too open.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return undefined;
      if (ALLOWED_ORIGINS.includes(origin)) return origin;
      try {
        const { hostname } = new URL(origin);
        if (hostname === 'localhost' || hostname.endsWith('.cloudfront.net')) return origin;
      } catch {
        /* malformed origin */
      }
      return undefined;
    },
    allowHeaders: ['content-type', 'authorization', 'x-tenant'],
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
  // Only branding + deadline are public; knownClubs/requiredDocs gate behind auth.
  return c.json({
    tenant: config.tenant,
    branding: config.branding,
    submissionDeadline: config.submissionDeadline,
  });
});

/** Validate a registration link → returns the club name. Token self-describes tenant. */
app.get('/register/:clubId', async (c) => {
  const token = c.req.query('t');
  if (!token) throw new HttpError(400, 'missing token');
  const resolved = await repo.getToken(token);
  if (!resolved || resolved.clubId !== c.req.param('clubId')) {
    throw new HttpError(404, 'invalid registration link');
  }
  const club = await repo.getClub(resolved.tenant, resolved.clubId);
  if (!club) throw new HttpError(404, 'club not found');
  return c.json({ tenant: resolved.tenant, clubId: club.id, clubName: club.name });
});

/** Submit a player registration. No auth; dedup + POPIA consent enforced. */
app.post('/register/:clubId', async (c) => {
  const token = c.req.query('t');
  if (!token) throw new HttpError(400, 'missing token');
  const resolved = await repo.getToken(token);
  if (!resolved || resolved.clubId !== c.req.param('clubId')) {
    throw new HttpError(404, 'invalid registration link');
  }
  const body = await c.req.json<Partial<PlayerRegistration>>();
  if (!body.firstName || !body.lastName || !body.dob) {
    throw new HttpError(400, 'firstName, lastName and dob are required');
  }
  const isMinor = computeIsMinor(body.dob);
  if (isMinor && !body.guardianName) {
    throw new HttpError(400, 'guardianName required for minors (POPIA)');
  }
  // naturalKey gives idempotent dedup: a person can register once per club.
  const naturalKey = (body.email || body.cell || `${body.firstName}-${body.lastName}-${body.dob}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const player: PlayerRegistration = {
    naturalKey,
    clubId: resolved.clubId,
    firstName: body.firstName,
    lastName: body.lastName,
    dob: body.dob,
    cell: body.cell,
    email: body.email,
    isMinor,
    guardianName: body.guardianName,
    consentAt: now(),
    createdAt: now(),
  };
  try {
    await repo.createPlayer(resolved.tenant, player);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new HttpError(409, 'already registered');
    }
    throw err;
  }
  return c.json({ ok: true }, 201);
});

function computeIsMinor(dob: string): boolean {
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return false;
  const eighteen = new Date(born);
  eighteen.setFullYear(eighteen.getFullYear() + 18);
  return eighteen.getTime() > Date.now();
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
app.use('/admin/*', authenticate, requireTenantMembership, requireAdmin);

// ───────────────────────── Clubs ─────────────────────────

/** List all clubs in the tenant (admin) — with derived player counts. */
app.get('/clubs', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const clubs = await repo.listClubs(tenant);
  const withCounts = clubs.map((club) => withPlayerCount(club));
  return c.json(withCounts);
});

/** Onboard a new club (admin). Rejects a duplicate name within the tenant. */
app.post('/clubs', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const spec = await c.req.json<Partial<Club>>();
  const existing = await repo.listClubs(tenant);
  if (nameTaken(existing, spec.name))
    throw new HttpError(409, `a club named "${spec.name}" already exists`);
  const club = buildClubFromSpec(spec);
  await repo.createClub(tenant, club);
  return c.json(club, 201);
});

/**
 * Bulk onboard (admin). Per-spec so one duplicate/failure doesn't abort the rest
 * or misreport success: returns { created, skipped } instead of throwing midway.
 */
app.post('/clubs/bulk', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const specs = await c.req.json<Partial<Club>[]>();
  const existing = await repo.listClubs(tenant);
  const names = new Set(existing.map((cl) => cl.name.trim().toLowerCase()));
  const created: Club[] = [];
  const skipped: Array<{ name?: string; reason: string }> = [];
  for (const spec of specs) {
    const key = (spec.name ?? '').trim().toLowerCase();
    if (!key || names.has(key)) {
      skipped.push({ name: spec.name, reason: 'duplicate or missing name' });
      continue;
    }
    try {
      const club = buildClubFromSpec(spec);
      await repo.createClub(tenant, club);
      created.push(club);
      names.add(key);
    } catch {
      skipped.push({ name: spec.name, reason: 'could not create' });
    }
  }
  return c.json({ created, skipped }, 201);
});

/** Get one club (rep may only read their own). */
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
  // The affiliation form locks once complete; reps cannot reopen it.
  const current = await repo.getClub(ra.tenant, id);
  if (!current) throw new HttpError(404, 'club not found');
  if (
    ra.membership.role !== 'admin' &&
    current.affiliation === 'complete' &&
    affiliationFieldsTouched(patch)
  ) {
    throw new HttpError(403, 'affiliation is locked');
  }
  const invalid = validateClubPatch(patch);
  if (invalid) throw new HttpError(400, invalid);
  // `paid` is admin-only (its own route); strip it from general patches.
  delete (patch as { paid?: boolean }).paid;
  const updated = await applyClubPatch(ra.tenant, id, patch, ra.email);
  return c.json(withPlayerCount(updated));
});

/** List a club's player registrations (rep: own only; admin: any in tenant). */
app.get('/clubs/:id/players', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertClubAccess(ra, id);
  return c.json(await repo.listPlayers(ra.tenant, id));
});

/** Save the exec committee; also flips docs.exco true. */
app.post('/clubs/:id/exco', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertClubAccess(ra, id);
  const exco = await c.req.json<Record<string, unknown>>();
  const current = await repo.getClub(ra.tenant, id);
  if (!current) throw new HttpError(404, 'club not found');
  const updated = await applyClubPatch(
    ra.tenant,
    id,
    { exco, docs: { ...current.docs, exco: true } },
    ra.email,
  );
  return c.json(updated);
});

/** Mint a presigned PUT for a compliance document (rep or admin). */
app.post('/clubs/:id/docs/:key/upload-url', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const key = c.req.param('key');
  assertClubAccess(ra, id);
  const objectKey = `${ra.tenant}/${id}/${key}-${randomUUID()}.pdf`;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: UPLOADS_BUCKET,
      Key: objectKey,
      ContentType: 'application/pdf',
    }),
    { expiresIn: 300 },
  );
  return c.json({ uploadUrl: url, objectKey });
});

/** Mark a document uploaded with its stored object metadata. */
app.patch('/clubs/:id/docs/:key', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const key = c.req.param('key');
  assertClubAccess(ra, id);
  const meta = await c.req.json<{ objectKey: string; size: number }>();
  if (!meta.objectKey) throw new HttpError(400, 'objectKey required');
  if (typeof meta.size !== 'number' || meta.size <= 0 || meta.size > MAX_DOC_BYTES) {
    throw new HttpError(400, 'file must be a non-empty PDF under 10 MB');
  }
  const current = await repo.getClub(ra.tenant, id);
  if (!current) throw new HttpError(404, 'club not found');
  const docMeta = (current as { docMeta?: Record<string, unknown> }).docMeta ?? {};
  const updated = await applyClubPatch(
    ra.tenant,
    id,
    {
      docs: { ...current.docs, [key]: true },
      ...({ docMeta: { ...docMeta, [key]: { ...meta, uploadedAt: now() } } } as Partial<Club>),
    },
    ra.email,
  );
  return c.json(updated);
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

/** Toggle paid (admin only) — audited. */
app.patch('/clubs/:id/paid', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const { paid } = await c.req.json<{ paid: boolean }>();
  const updated = await applyClubPatch(ra.tenant, id, { paid }, ra.email);
  return c.json(withPlayerCount(updated));
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

app.put('/tenant/config', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const patch = await c.req.json<Partial<TenantConfig>>();
  const current = await repo.getTenantConfig(tenant);
  if (!current) throw new HttpError(404, 'tenant not found');
  const next = { ...current, ...patch, tenant };
  await repo.putTenantConfig(next);
  return c.json(next);
});

/** Invite a user (admin): create the Cognito account + USER# membership record. */
app.post('/admin/users', async (c) => {
  const ra = c.get('requestAuth')!;
  const body = await c.req.json<{ email: string; role: 'admin' | 'rep'; clubIds?: string[] }>();
  if (!body.email) throw new HttpError(400, 'email required');
  // Create (or reuse, for a multi-union invite) a CONFIRMED passwordless user.
  const sub = await ensurePasswordlessUser(cognito, USER_POOL_ID, body.email);
  const existing = await repo.getUser(sub);
  const memberships = existing?.memberships ?? [];
  // Add/replace this tenant's membership.
  const filtered = memberships.filter((m) => m.tenantId !== ra.tenant);
  filtered.push({ tenantId: ra.tenant, role: body.role, clubIds: body.clubIds ?? [] });
  await repo.putUser({
    sub,
    email: body.email,
    memberships: filtered,
    onboardingSeen: existing?.onboardingSeen ?? {},
  });
  return c.json({ sub, email: body.email }, 201);
});

// ───────────────────────── Helpers ─────────────────────────

/** Case-insensitive per-tenant club-name collision check. */
function nameTaken(existing: Club[], name?: string): boolean {
  const key = (name ?? '').trim().toLowerCase();
  return !!key && existing.some((cl) => cl.name.trim().toLowerCase() === key);
}

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

function affiliationFieldsTouched(patch: Partial<Club>): boolean {
  return ['affiliation', 'exco', 'coaches', 'ground', 'leagues'].some((k) => k in patch);
}

const COLORS = ['#1B2A4A', '#1D9E75', '#C8A84B', '#D85A30', '#2E4070', '#243356', '#8A6E1C'];

function buildClubFromSpec(spec: Partial<Club>): Club {
  const id =
    spec.id ??
    (spec.name ?? 'club')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return {
    id,
    name: spec.name ?? 'New Club',
    district: spec.district ?? '',
    sub: spec.sub ?? '',
    chair: spec.chair ?? '',
    affiliation: 'not_started',
    paid: false,
    cqi: 0,
    docs: { constitution: false, agm: false, financials: false, exco: false },
    players: 0,
    teams: 0,
    women: 0,
    juniors: 0,
    color: COLORS[Math.abs(hashCode(id)) % COLORS.length],
    ground: {},
    leagues: [],
    exco: spec.exco,
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
  console.error('unhandled error', err);
  return c.json({ error: 'internal error' }, 500);
});

export const handler = handle(app);

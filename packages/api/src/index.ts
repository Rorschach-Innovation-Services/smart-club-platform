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
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
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
import { sendClubInvite, type Channel, type SendResult } from './notify/index.js';
import type {
  Club,
  ClubCommEvent,
  ClubSpec,
  Series,
  TenantConfig,
  PlayerRegistration,
} from './types.js';

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
app.use('/tenant/support', authenticate, requireTenantMembership);
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
  const spec = await c.req.json<ClubSpec>();
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
  const specs = await c.req.json<ClubSpec[]>();
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
  // Valid league keys = the tenant's catalogue plus keys already on the club (so an
  // admin can still remove a league that was later deleted from the catalogue).
  const cfg = await repo.getTenantConfig(ra.tenant);
  const validLeagueKeys = new Set([
    ...(cfg?.leagues ?? []).map((l) => l.key),
    ...(current.leagues ?? []),
  ]);
  const invalid = validateClubPatch(patch, validLeagueKeys);
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
      ...({ docMeta: { ...docMeta, [key]: { ...meta, uploadedAt: now() } } } as Partial<Club>),
    },
    ra.email,
  );
  return c.json(updated);
});

/** Mint a presigned GET so a rep or admin can preview a stored compliance PDF inline. */
app.post('/clubs/:id/docs/:key/view-url', async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const key = c.req.param('key');
  assertClubAccess(ra, id);
  const club = await repo.getClub(ra.tenant, id);
  if (!club) throw new HttpError(404, 'club not found');
  const docMeta = (club as { docMeta?: Record<string, unknown> }).docMeta ?? {};
  const meta = docMeta[key] as { objectKey?: string } | undefined;
  // Only real uploads have an objectKey; admin "mark compliant" overrides do not.
  if (!meta?.objectKey) throw new HttpError(404, 'no file on record for this document');
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: UPLOADS_BUCKET,
      Key: meta.objectKey,
      ResponseContentType: 'application/pdf',
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

/** Toggle paid (admin only) — audited. */
app.patch('/clubs/:id/paid', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  const { paid } = await c.req.json<{ paid: boolean }>();
  const updated = await applyClubPatch(ra.tenant, id, { paid }, ra.email);
  return c.json(withPlayerCount(updated));
});

/** Set per-club progression mode (admin only) — audited. */
app.patch('/clubs/:id/progression', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  // A malformed/empty body parses to null and falls into the same 400 below,
  // rather than surfacing as an unhandled 500.
  const body = await c.req.json<{ progressionMode?: 'submission' | 'payment' }>().catch(() => null);
  const progressionMode = body?.progressionMode;
  if (progressionMode !== 'submission' && progressionMode !== 'payment')
    throw new HttpError(400, 'invalid progressionMode');
  const updated = await applyClubPatch(ra.tenant, id, { progressionMode }, ra.email);
  return c.json(withPlayerCount(updated));
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
 * Send the onboarding invite to the club's chair over email and/or WhatsApp (admin).
 * The link is built client-side from the tenant's own origin and passed in, so this
 * stays correct for multi-tenant custom domains. Idempotency-keyed so a lost-response
 * retry replays the prior outcome instead of double-sending. Per-channel results are
 * recorded in the comm log and returned verbatim so the UI toast tells the truth.
 */
app.post('/clubs/:id/send-invite', requireAdmin, async (c) => {
  const ra = c.get('requestAuth')!;
  const id = c.req.param('id');
  assertClubAccess(ra, id);
  const { channels, link, idempotencyKey } = await c.req.json<{
    channels?: Channel[];
    link?: string;
    idempotencyKey?: string;
  }>();
  if (!Array.isArray(channels) || channels.length === 0)
    throw new HttpError(400, 'channels required');
  const unknown = channels.find((ch) => ch !== 'email' && ch !== 'whatsapp');
  if (unknown) throw new HttpError(400, `unknown channel: ${unknown}`);
  // The link is client-supplied (so it carries the tenant's own origin). Validate it
  // parses as http(s), points at a trusted app origin, and targets THIS club's
  // onboarding path — so an admin can't have the invite carry an arbitrary URL.
  let linkUrl: URL;
  try {
    linkUrl = new URL(link ?? '');
  } catch {
    throw new HttpError(400, 'valid link required');
  }
  if (linkUrl.protocol !== 'http:' && linkUrl.protocol !== 'https:')
    throw new HttpError(400, 'valid link required');
  if (!originAllowed(linkUrl.origin)) throw new HttpError(400, 'link host not allowed');
  if (linkUrl.pathname !== `/club/${id}`) throw new HttpError(400, 'link must target this club');
  if (!idempotencyKey) throw new HttpError(400, 'idempotencyKey required');

  const club = await repo.getClub(ra.tenant, id);
  if (!club) throw new HttpError(404, 'club not found');

  // Claim the idempotency key before sending; a prior/concurrent claim replays.
  // `pending` distinguishes "first attempt still in flight" (no results yet) from a
  // completed replay, so the UI can show "already sending" instead of a silent no-op.
  const prior = await repo.claimInviteSend(ra.tenant, id, idempotencyKey, channels);
  if (prior) return c.json({ results: prior.results, deduped: true, pending: prior.pending });

  const { results } = await sendClubInvite({ club, channels, link: linkUrl.href });
  try {
    await repo.appendClubCommEvents(
      ra.tenant,
      id,
      results.map((r) => buildCommEvent(r, ra.email, idempotencyKey)),
    );
  } catch (err) {
    // The messages already went out — a comm-log write failure must not fail the
    // request (that would invite a double-send on retry). Log and move on.
    console.error('comm-log append failed after invite send', err);
  }
  await repo.completeInviteSend(ra.tenant, id, idempotencyKey, results);
  return c.json({ results }, 201);
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

// Anchored + TLD-required: blocks whitespace/newlines, so the validated value is
// safe to splice into a mailto: link downstream. Kept identical to api.js EMAIL_RE.
const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;

app.put('/tenant/config', requireAdmin, async (c) => {
  const { tenant } = c.get('requestAuth')!;
  const patch = await c.req.json<Partial<TenantConfig>>();
  const current = await repo.getTenantConfig(tenant);
  if (!current) throw new HttpError(404, 'tenant not found');
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

/** Map a per-channel send outcome into a comm-log event row (omitting empty fields). */
function buildCommEvent(r: SendResult, by: string, idempotencyKey: string): ClubCommEvent {
  return {
    id: randomUUID(),
    channel: r.channel,
    status: r.status,
    ...(r.to ? { to: r.to } : {}),
    ...(r.messageId ? { messageId: r.messageId } : {}),
    ...(r.error ? { error: r.error } : {}),
    at: now(),
    by,
    idempotencyKey,
  };
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
    progressionMode: 'submission',
    cqi: 0,
    docs: { constitution: false, agm: false, financials: false, exco: false },
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
  console.error('unhandled error', err);
  return c.json({ error: 'internal error' }, 500);
});

export const handler = handle(app);
// Exported so the local dev server (src/local/server.ts) can serve the same app.
export { app };

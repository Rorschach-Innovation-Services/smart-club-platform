/**
 * Platform audit trail — the route registry (plan: audit-trail Phase 1, ADR 0023).
 *
 * One key per route registered in `index.ts`, `'METHOD /pattern'` exactly as Hono stores it.
 * Every mutating route (POST / PUT / PATCH / DELETE) MUST appear, either audited or with an
 * explicit `skip` reason; GET routes appear only when they are audited (link copies).
 * `test/audit-coverage.test.ts` walks `app.routes` and fails on a missing or stale key, so a
 * new route cannot ship unaudited.
 *
 * The middleware (`audit-middleware.ts`) uses a spec to name the action, derive a default
 * target from path params, pick the tenant and visibility, and decide whether to write a
 * "started" headline before the handler (`bulk`). Path params are only ever used as record
 * ids; raw paths, query strings and `redactParams` are never stored.
 */

/** Record types an entry may name (entity pointers, cohort clear and erasure match on these). */
export const AUDIT_ENTITY_TYPES = [
  'club',
  'player',
  'clearance',
  'registration-review',
  'club-invite',
  'veterans-affiliation',
  'veterans-request',
  'postponement',
  'series',
  'fixture',
  'season-run',
  'fixture-result',
  'scorecard',
  'fixture-officials',
  'captains-report',
  'squad-request',
  'doc-request',
  'umpire',
  'scorer',
  'user',
  'tenant-config',
  'venue',
  'competition',
  'signup-link',
  'tenant',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * The default target a route names. `param` is a path param (an array joins several with `#`,
 * e.g. series + fixture → `s1#f1`); `'@tenant'` is the request's tenant; `id` is a literal.
 */
export interface AuditEntitySpec {
  type: AuditEntityType;
  param?: string | string[];
  id?: string;
}

export interface AuditedRouteSpec {
  /** Dotted action name, e.g. `umpire.update`. A handler may refine it with auditSet. */
  action: string;
  entity?: AuditEntitySpec;
  /** Path param holding the club id (sets the target's clubId, or names the club itself). */
  club?: string;
  /**
   * Where the tenant comes from: `auth` (the caller's membership — the default), `param:slug`
   * (operator portal), or `handler` (a public link route: the resolver calls auditSet).
   */
  tenant?: 'auth' | 'param:slug' | 'handler';
  /** Long or destructive: a "started" headline is written before the handler. */
  bulk?: true;
  /**
   * The route erases records of this type. Its own entry is flushed after the scrub, so the
   * middleware strips that type's labels, change values and mention labels from it (and, for
   * a player, the id: a natural key is derived from the ID number).
   */
  erases?: 'umpire' | 'scorer' | 'club' | 'player';
  /** Path params never used as ids (bearer tokens, a natural key under erasure). */
  redactParams?: readonly string[];
  /** `operator` hides the entry from tenant admins (the operator portal's settings). */
  visibility?: 'operator';
}

export interface SkippedRouteSpec {
  skip: string;
}

export type AuditRouteSpec = AuditedRouteSpec | SkippedRouteSpec;

export const isSkipped = (s: AuditRouteSpec): s is SkippedRouteSpec => 'skip' in s;

const PRESIGN = 'presigns an upload; the commit that uses it is audited';
const VIEW = 'presigns a view of a stored document (document views are out of scope)';
const PARSE = 'parses or previews; writes nothing';
const HINTS = 'computes clash hints; writes nothing';
const CERT_VIEW = `${VIEW}; a lazy first issue records clearance.certificate.issue itself`;

const club = (param = 'id'): AuditEntitySpec => ({ type: 'club', param });
const player: AuditEntitySpec = { type: 'player', param: 'nk' };
const token = { tenant: 'handler', redactParams: ['token'] } as const;
const platform = { tenant: 'param:slug', visibility: 'operator' } as const;

/** `'METHOD /pattern'` → spec. Keep grouped as in index.ts. */
export const AUDIT_ROUTES: Record<string, AuditRouteSpec> = {
  // ── Local dev + public ──
  'PUT /local-uploads/local/*': { skip: 'dev-only local upload sink (404 outside dev:local)' },
  'POST /register/:clubId': { action: 'player.register', club: 'clubId', tenant: 'handler' },
  'POST /register/:clubId/id-doc/upload-url': { skip: PRESIGN },
  'POST /official-signup': { action: 'official.signup', tenant: 'handler' },
  'POST /club-signup': { action: 'club.signup', tenant: 'handler' },
  'POST /integrations/whatsapp/status': { skip: 'machine webhook (delivery statuses)' },
  'PATCH /me': { skip: "the caller's own onboarding flags" },

  // ── Clubs, players, rosters ──
  'PATCH /clubs/:id': { action: 'club.update', entity: club() },
  'DELETE /clubs/:id': { action: 'club.delete', entity: club(), bulk: true, erases: 'club' },
  'POST /clubs/:id/players': { action: 'player.create', entity: club() },
  'POST /clubs/:id/players/batch': { action: 'player.batch-create', entity: club(), bulk: true },
  'POST /clubs/:id/roster/parse': { skip: PARSE },
  'POST /clubs/:id/roster/commit': { action: 'roster.commit', entity: club(), bulk: true },
  'POST /clubs/:id/players/:nk/id-doc/upload-url': { skip: PRESIGN },
  'PATCH /clubs/:id/players/:nk/id-doc': {
    action: 'player.id-doc.update',
    entity: player,
    club: 'id',
  },
  'POST /clubs/:id/players/:nk/id-doc/view-url': { skip: VIEW },
  'DELETE /clubs/:id/players/:nk': { action: 'player.remove', entity: player, club: 'id' },
  'PUT /clubs/:id/players/:nk/veterans-club': {
    action: 'veterans-affiliation.set',
    entity: player,
    club: 'id',
  },
  'DELETE /clubs/:id/players/:nk/veterans-club': {
    action: 'veterans-affiliation.remove',
    entity: player,
    club: 'id',
  },
  'POST /clubs/:id/veterans-requests': { action: 'veterans-request.create', entity: club() },
  'POST /clubs/:id/veterans-requests/:rid/accept': {
    action: 'veterans-request.accept',
    entity: { type: 'veterans-request', param: 'rid' },
    club: 'id',
  },
  'POST /clubs/:id/veterans-requests/:rid/decline': {
    action: 'veterans-request.decline',
    entity: { type: 'veterans-request', param: 'rid' },
    club: 'id',
  },
  'POST /clubs/:id/veterans-requests/:rid/withdraw': {
    action: 'veterans-request.withdraw',
    entity: { type: 'veterans-request', param: 'rid' },
    club: 'id',
  },
  'POST /clubs/:id/clearances': { action: 'clearance.create', entity: club() },
  'PATCH /clubs/:id/clearances/:cid': {
    action: 'clearance.update',
    entity: { type: 'clearance', param: 'cid' },
    club: 'id',
  },
  'POST /clubs/:id/clearances/:cid/certificate/view-url': { skip: CERT_VIEW },
  'POST /clubs/:id/exco': { action: 'club.exco.update', entity: club() },
  'POST /clubs/:id/docs/:key/upload-url': { skip: PRESIGN },
  'PATCH /clubs/:id/docs/:key': { action: 'club.doc.update', entity: club() },
  'DELETE /clubs/:id/docs/:key/file': { action: 'club.doc.delete-file', entity: club() },
  'POST /clubs/:id/docs/:key/view-url': { skip: VIEW },
  'POST /clubs/:id/reg-link': { action: 'link.mint', entity: club() },
  'POST /clubs/:id/notes': { action: 'club.note.add', entity: club() },
  'POST /clubs/:id/send-fixtures': { action: 'message.send-fixtures', entity: club() },
  'PUT /clubs/:id/teams/:teamId/captain': { action: 'club.team-captain.set', entity: club() },

  // ── Series, fixtures, competitions, season runs, venues ──
  'POST /series': { action: 'series.create' },
  'PATCH /series/:id': { action: 'series.patch', entity: { type: 'series', param: 'id' } },
  'POST /series/:id/clash-check': { skip: HINTS },
  'DELETE /series/:id': {
    action: 'series.delete',
    entity: { type: 'series', param: 'id' },
    bulk: true,
  },
  'POST /series/:id/duplicate': {
    action: 'series.duplicate',
    entity: { type: 'series', param: 'id' },
  },
  'PUT /series/:id/fixtures/:fixtureId/officials': {
    action: 'fixture-officials.set',
    entity: { type: 'fixture-officials', param: ['id', 'fixtureId'] },
  },
  'POST /series/:id/fixtures/:fixtureId/result/confirm': {
    action: 'fixture-result.confirm',
    entity: { type: 'fixture-result', param: ['id', 'fixtureId'] },
  },
  'DELETE /series/:id/fixtures/:fixtureId/result/confirm': {
    action: 'fixture-result.unconfirm',
    entity: { type: 'fixture-result', param: ['id', 'fixtureId'] },
  },
  'POST /clubs/:id/clash-hints': { skip: HINTS },
  'POST /competitions/preview': { skip: PARSE },
  'POST /competitions': { action: 'competition.create' },
  'PATCH /competitions/:id': {
    action: 'competition.update',
    entity: { type: 'competition', param: 'id' },
  },
  'POST /competitions/:id/regenerate': {
    action: 'competition.regenerate',
    entity: { type: 'competition', param: 'id' },
    bulk: true,
  },
  'DELETE /competitions/:id': {
    action: 'competition.delete',
    entity: { type: 'competition', param: 'id' },
    bulk: true,
  },
  'POST /competitions/:id/advance': {
    action: 'competition.advance',
    entity: { type: 'competition', param: 'id' },
  },
  'POST /season-runs': { action: 'season-run.create' },
  'PATCH /season-runs/:id': {
    action: 'season-run.update',
    entity: { type: 'season-run', param: 'id' },
  },
  'POST /season-runs/:id/stages/:specId/generate': {
    action: 'season-run.generate',
    entity: { type: 'season-run', param: 'id' },
    bulk: true,
  },
  'POST /season-runs/:id/rebase': {
    action: 'season-run.rebase',
    entity: { type: 'season-run', param: 'id' },
    bulk: true,
  },
  'DELETE /season-runs/:id': {
    action: 'season-run.delete',
    entity: { type: 'season-run', param: 'id' },
  },
  'PUT /venues/:id': { action: 'venue.save', entity: { type: 'venue', param: 'id' } },
  'DELETE /venues/:id': { action: 'venue.delete', entity: { type: 'venue', param: 'id' } },

  // ── Postponements ──
  'POST /clubs/:id/postponements': { action: 'postponement.create', entity: club() },
  'POST /clubs/:id/postponements/:reqId/counter': {
    action: 'postponement.counter',
    entity: { type: 'postponement', param: 'reqId' },
    club: 'id',
  },
  'POST /clubs/:id/postponements/:reqId/accept': {
    action: 'postponement.accept',
    entity: { type: 'postponement', param: 'reqId' },
    club: 'id',
  },
  'POST /clubs/:id/postponements/:reqId/withdraw': {
    action: 'postponement.withdraw',
    entity: { type: 'postponement', param: 'reqId' },
    club: 'id',
  },
  'POST /clubs/:id/postponements/:reqId/decline': {
    action: 'postponement.decline',
    entity: { type: 'postponement', param: 'reqId' },
    club: 'id',
  },
  'POST /clubs/:id/postponements/:reqId/acknowledge': {
    action: 'postponement.acknowledge',
    entity: { type: 'postponement', param: 'reqId' },
    club: 'id',
  },
  'POST /admin/postponements/:reqId/override': {
    action: 'postponement.override',
    entity: { type: 'postponement', param: 'reqId' },
  },

  // ── Medicoach integration (admin console) ──
  // The sync code never calls the audit helpers: this records who triggered it, not what the
  // sync then changed.
  'POST /integrations/medicoach/sync-now': { action: 'medicoach.sync-trigger' },
  'POST /integrations/medicoach/conflicts/apply': { action: 'medicoach.conflicts.apply' },
  'POST /integrations/medicoach/conflicts/discard': { action: 'medicoach.conflicts.discard' },
  'POST /integrations/medicoach/outbox/retry': { action: 'medicoach.outbox.retry' },
  'POST /integrations/medicoach/outbox/drop': { action: 'medicoach.outbox.drop' },
  'POST /integrations/medicoach/players/retry': { action: 'medicoach.players.retry' },
  'POST /integrations/medicoach/player-reviews/:nk/resolve': {
    action: 'medicoach.player-review.resolve',
    entity: player,
  },

  // ── Officials ──
  'POST /umpires': { action: 'umpire.create' },
  'PATCH /umpires/:id': { action: 'umpire.update', entity: { type: 'umpire', param: 'id' } },
  'POST /umpires/:id/approve': {
    action: 'umpire.approve',
    entity: { type: 'umpire', param: 'id' },
  },
  'POST /umpires/:id/merge': {
    action: 'umpire.merge',
    entity: { type: 'umpire', param: 'id' },
    bulk: true,
  },
  'DELETE /umpires/:id': {
    action: 'umpire.delete',
    entity: { type: 'umpire', param: 'id' },
    bulk: true,
    erases: 'umpire',
  },
  'POST /umpires/appointments/preview': { skip: PARSE },
  'POST /umpires/appointments/confirm': { action: 'umpire.appointments.confirm', bulk: true },
  'POST /scorers': { action: 'scorer.create' },
  'PATCH /scorers/:id': { action: 'scorer.update', entity: { type: 'scorer', param: 'id' } },
  'POST /scorers/:id/approve': {
    action: 'scorer.approve',
    entity: { type: 'scorer', param: 'id' },
  },
  'POST /scorers/:id/merge': {
    action: 'scorer.merge',
    entity: { type: 'scorer', param: 'id' },
    bulk: true,
  },
  'DELETE /scorers/:id': {
    action: 'scorer.delete',
    entity: { type: 'scorer', param: 'id' },
    bulk: true,
    erases: 'scorer',
  },

  // ── Captain's reports + squads (portal) ──
  'POST /club/captains-reports': { action: 'captains-report.create' },
  'POST /club/captains-reports/unlisted': { action: 'captains-report.create-unlisted' },
  'PUT /club/captains-reports/:id': {
    action: 'captains-report.save',
    entity: { type: 'captains-report', param: 'id' },
  },
  'POST /club/captains-reports/:id/forward': {
    action: 'captains-report.forward',
    entity: { type: 'captains-report', param: 'id' },
  },
  'POST /captains-reports/:id/umpires/:index/attribute': {
    action: 'captains-report.attribute-umpire',
    entity: { type: 'captains-report', param: 'id' },
  },
  'GET /captains-reports/:id/link': {
    action: 'link.copy',
    entity: { type: 'captains-report', param: 'id' },
  },
  'POST /admin/squad-requests/:id/resend': {
    action: 'squad-request.resend',
    entity: { type: 'squad-request', param: 'id' },
  },
  'POST /admin/squad-requests/:id/void': {
    action: 'squad-request.void',
    entity: { type: 'squad-request', param: 'id' },
  },
  'GET /admin/squad-requests/:id/link': {
    action: 'link.copy',
    entity: { type: 'squad-request', param: 'id' },
  },

  // ── Public links (the token is the capability; the resolver names tenant + actor) ──
  'POST /captains-report-link/:token/forward': { action: 'captains-report.forward', ...token },
  'PUT /captains-report-link/:token': { action: 'captains-report.save', ...token },
  'PUT /squad-link/:token': { action: 'squad-request.save', ...token },
  'POST /squad-link/:token/forward': { action: 'squad-request.forward', ...token },
  'POST /doc-request-link/:token/upload-url': { skip: PRESIGN },
  'POST /doc-request-link/:token/complete': { action: 'doc-request.complete', ...token },

  // ── Tenant settings ──
  'PUT /tenant/config': {
    action: 'tenant-config.update',
    entity: { type: 'tenant-config', param: '@tenant' },
  },
  'PUT /tenant/support': {
    action: 'tenant-config.support.update',
    entity: { type: 'tenant-config', param: '@tenant' },
  },

  // ── Operator portal (operator-only entries; tenant from :slug) ──
  'POST /platform/tenants': { action: 'tenant.create', visibility: 'operator' },
  'PUT /platform/tenants/:slug': {
    action: 'tenant.update',
    entity: { type: 'tenant-config', param: 'slug' },
    ...platform,
  },
  'POST /platform/tenants/:slug/medicoach/reconcile': {
    action: 'medicoach.reconcile',
    bulk: true,
    ...platform,
  },
  'POST /platform/tenants/:slug/admins': { action: 'user.invite-admin', ...platform },
  'POST /platform/tenants/:slug/logo-upload': { skip: PRESIGN },
  'POST /platform/tenants/:slug/tutorial-upload': { skip: PRESIGN },
  'POST /platform/tenants/:slug/tutorial-upload/complete': {
    action: 'tutorial.upload',
    ...platform,
  },
  'POST /platform/tenants/:slug/tutorial-upload/abort': {
    skip: 'aborts an unfinished multipart upload; nothing is stored',
  },
  'POST /platform/tenants/:slug/doc-intake/presign': { skip: PRESIGN },
  'POST /platform/tenants/:slug/doc-intake/commit': {
    action: 'doc-intake.commit',
    bulk: true,
    ...platform,
  },
  'POST /platform/tenants/:slug/roster-intake/parse': { skip: PARSE },
  'POST /platform/tenants/:slug/roster-intake/commit': {
    action: 'roster-intake.commit',
    bulk: true,
    ...platform,
  },
  'POST /platform/tenants/:slug/structure-intake/parse': { skip: PARSE },
  'POST /platform/tenants/:slug/structure-intake/commit': {
    action: 'structure-intake.commit',
    bulk: true,
    ...platform,
  },
  'POST /platform/tenants/:slug/reps': { action: 'user.invite-rep', ...platform },
  'POST /platform/tenants/:slug/clubs/:clubId/committee-extract': {
    skip: 'extracts invite candidates from a stored document; writes nothing',
  },
  'POST /platform/tenants/:slug/clubs/:clubId/docs/:key/view-url': { skip: VIEW },
  'POST /platform/tenants/:slug/clubs': { action: 'club.create', ...platform },
  'POST /platform/tenants/:slug/setup-complete': {
    action: 'tenant.setup-complete',
    entity: { type: 'tenant', param: 'slug' },
    ...platform,
  },
  'DELETE /platform/tenants/:slug/setup-complete': {
    action: 'tenant.setup-reopen',
    entity: { type: 'tenant', param: 'slug' },
    ...platform,
  },
  'POST /platform/tenants/:slug/fixture-amendments/preview': { skip: PARSE },
  'POST /platform/tenants/:slug/fixture-amendments/confirm': {
    action: 'fixture-amendments.confirm',
    bulk: true,
    ...platform,
  },

  // ── Team & access ──
  'POST /admin/users': { action: 'user.invite' },
  'PATCH /admin/users/:sub': { action: 'user.update', entity: { type: 'user', param: 'sub' } },
  'DELETE /admin/users/:sub': { action: 'user.delete', entity: { type: 'user', param: 'sub' } },
  'POST /admin/users/:sub/resend': {
    action: 'user.invite-resend',
    entity: { type: 'user', param: 'sub' },
  },
  'PATCH /admin/users/:sub/email': {
    action: 'user.email-change',
    entity: { type: 'user', param: 'sub' },
  },

  // ── Signup links ──
  'POST /admin/club-signup-link': {
    action: 'link.mint',
    entity: { type: 'signup-link', id: 'club' },
  },
  'DELETE /admin/club-signup-link': {
    action: 'link.revoke',
    entity: { type: 'signup-link', id: 'club' },
  },
  'POST /admin/official-signup-link/:role': {
    action: 'link.mint',
    entity: { type: 'signup-link', param: 'role' },
  },
  'DELETE /admin/official-signup-link/:role': {
    action: 'link.revoke',
    entity: { type: 'signup-link', param: 'role' },
  },

  // ── Admin: exports, erasure, clearances, doc requests, reviews, veterans ──
  'POST /admin/export-log': { skip: 'exports are out of scope (EXPORT# rows record them)' },
  'DELETE /admin/players/:nk': {
    action: 'player.erase',
    bulk: true,
    redactParams: ['nk'],
    erases: 'player',
  },
  'POST /admin/clearances/:cid/override': {
    action: 'clearance.override',
    entity: { type: 'clearance', param: 'cid' },
  },
  'POST /admin/clearances/:cid/certificate/view-url': { skip: CERT_VIEW },
  'POST /admin/clearances/:cid/certificate/revoke': {
    action: 'clearance.certificate.revoke',
    entity: { type: 'clearance', param: 'cid' },
  },
  'POST /admin/clearances/:cid/reassign': {
    action: 'clearance.reassign',
    entity: { type: 'clearance', param: 'cid' },
  },
  'POST /admin/clearances/:cid/reject': {
    action: 'clearance.reject',
    entity: { type: 'clearance', param: 'cid' },
  },
  'POST /admin/clearances/:cid/reopen': {
    action: 'clearance.reopen',
    entity: { type: 'clearance', param: 'cid' },
  },
  'POST /admin/clearances/:cid/remind': {
    action: 'clearance.remind',
    entity: { type: 'clearance', param: 'cid' },
  },
  'POST /admin/doc-requests': { action: 'doc-request.send' },
  'POST /admin/doc-requests/link': { action: 'link.copy' },
  'POST /admin/registration-reviews/:rid/ack': {
    action: 'registration-review.ack',
    entity: { type: 'registration-review', param: 'rid' },
  },
  'POST /admin/veterans-requests/:rid/accept': {
    action: 'veterans-request.accept',
    entity: { type: 'veterans-request', param: 'rid' },
  },
  'POST /admin/veterans-requests/:rid/decline': {
    action: 'veterans-request.decline',
    entity: { type: 'veterans-request', param: 'rid' },
  },
};

export const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const auditRouteKey = (method: string, pattern: string) => `${method} ${pattern}`;

export const auditRouteSpec = (method: string, pattern: string): AuditRouteSpec | undefined =>
  AUDIT_ROUTES[auditRouteKey(method, pattern)];

/**
 * Path params of `path` under the Hono `pattern` (`:name` segments; a trailing `*` matches the
 * rest). Independent of Hono's per-handler route index, so it works before the handler ran.
 */
export function auditPathParams(pattern: string, path: string): Record<string, string> {
  const ps = pattern.split('/');
  const xs = path.split('/');
  const out: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p === '*') break;
    if (!p.startsWith(':') || xs[i] === undefined) continue;
    const name = p
      .slice(1)
      .replace(/\{.*\}$/, '')
      .replace(/\?$/, '');
    try {
      out[name] = decodeURIComponent(xs[i]);
    } catch {
      out[name] = xs[i];
    }
  }
  return out;
}

/**
 * Umpire registry + fixture officials — the request validation and read-path join the
 * routes in index.ts use. Pure: no repo, no Hono context, no clock.
 *
 * Officials live in their own FIXOFFICIALS# items (see keys.ts), joined onto each fixture
 * as `officials` only when `GET /series` is read. Writes strip that key back off, so a
 * client echoing a series it read can never persist the join into the Series item.
 */
import { HttpError } from './auth.js';
import {
  MAX_UMPIRES_PER_FIXTURE,
  normaliseUmpireAlias,
  umpireAliasSet,
} from '../../engine/src/umpires.js';
import type { FixtureOfficials, FixtureOfficialsRecord, Series, Umpire } from './types.js';

export { MAX_UMPIRES_PER_FIXTURE, normaliseUmpireAlias, umpireAliasSet };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The writable fields of an umpire, as validated off a request body. */
export interface UmpireInput {
  displayName?: string;
  fullName?: string | null;
  aliases?: string[];
  phone?: string | null;
  email?: string | null;
  active?: boolean;
}

function optionalText(body: Record<string, unknown>, key: string, max: number) {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new HttpError(400, `${key} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${key} is too long`);
  return t || null;
}

/**
 * Validate a POST (`create`) or PATCH (`patch`) body. Create needs a display name; a patch
 * may carry any subset. `null`/'' clears an optional field. Unknown keys are ignored.
 */
export function parseUmpireInput(raw: unknown, mode: 'create' | 'patch'): UmpireInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HttpError(400, 'body must be an object');
  const body = raw as Record<string, unknown>;
  const out: UmpireInput = {};
  if (body.displayName !== undefined || mode === 'create') {
    if (typeof body.displayName !== 'string' || !body.displayName.trim())
      throw new HttpError(400, 'displayName is required');
    const name = body.displayName.trim().replace(/\s+/g, ' ');
    if (name.length > 80) throw new HttpError(400, 'displayName is too long');
    if (!normaliseUmpireAlias(name))
      throw new HttpError(400, 'displayName needs at least one letter or digit');
    out.displayName = name;
  }
  const fullName = optionalText(body, 'fullName', 120);
  if (fullName !== undefined) out.fullName = fullName;
  const phone = optionalText(body, 'phone', 30);
  if (phone !== undefined) out.phone = phone;
  const email = optionalText(body, 'email', 254);
  if (email !== undefined) {
    if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'email is not valid');
    out.email = email;
  }
  if (body.aliases !== undefined) {
    if (!Array.isArray(body.aliases) || body.aliases.length > 20)
      throw new HttpError(400, 'aliases must be an array of at most 20 names');
    for (const a of body.aliases)
      if (typeof a !== 'string' || a.length > 80)
        throw new HttpError(400, 'each alias must be a name of at most 80 characters');
    out.aliases = body.aliases as string[];
  }
  if (body.active !== undefined) {
    if (mode === 'create') throw new HttpError(400, 'a new umpire is always active');
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'active must be a boolean');
    out.active = body.active;
  }
  return out;
}

/** Deterministic id stem for a new umpire: `u-` + a slug of the display name. */
export function umpireIdFor(displayName: string): string {
  const slug = displayName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `u-${slug || 'umpire'}`;
}

/**
 * The ACTIVE umpire (other than `selfId`) that already answers to one of `aliases`, if any.
 * Alias resolution must stay unambiguous — the weekly importer maps sheet names through it.
 */
export function findAliasConflict(
  aliases: string[],
  umpires: Umpire[],
  selfId?: string,
): Umpire | undefined {
  const wanted = new Set(aliases);
  return umpires.find(
    (u) => u.active && u.id !== selfId && (u.aliases ?? []).some((a) => wanted.has(a)),
  );
}

/** Apply a validated input to a record (create: `base` is undefined). */
export function applyUmpireInput(
  base: Umpire | undefined,
  input: UmpireInput,
  id: string,
  at: string,
): Umpire {
  const next: Umpire = {
    ...(base ?? { id, displayName: '', aliases: [], active: true, createdAt: at }),
    id,
    updatedAt: at,
  };
  if (input.displayName !== undefined) next.displayName = input.displayName;
  for (const k of ['fullName', 'phone', 'email'] as const) {
    const v = input[k];
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  if (input.active !== undefined) next.active = input.active;
  // The alias set always covers the current display/full name. A patch that sends
  // `aliases` replaces the extra ones; otherwise the old set is kept, so a renamed umpire
  // still answers to the spelling the union's sheet uses.
  next.aliases = umpireAliasSet({
    displayName: next.displayName,
    fullName: next.fullName,
    aliases: input.aliases ?? base?.aliases ?? [],
  });
  return next;
}

/** A validated `PUT …/officials` body: registry ids, in slot order. */
export interface OfficialsInput {
  umpireIds: string[];
  refereeId?: string;
}

const refId = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.trim() || undefined;
  if (v && typeof v === 'object' && typeof (v as { umpireId?: unknown }).umpireId === 'string')
    return ((v as { umpireId: string }).umpireId || '').trim() || undefined;
  return undefined;
};

/**
 * Validate the officials body: `{ umpires: [{umpireId} | "id"], referee?: {umpireId} | null }`.
 * At most two umpires, no repeats, and the referee can't also stand as an umpire. Whether
 * each id exists in the registry is the route's job (it needs the repo).
 */
export function parseOfficialsInput(raw: unknown): OfficialsInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HttpError(400, 'body must be an object');
  const body = raw as Record<string, unknown>;
  const list = body.umpires ?? [];
  if (!Array.isArray(list)) throw new HttpError(400, 'umpires must be an array');
  if (list.length > MAX_UMPIRES_PER_FIXTURE)
    throw new HttpError(400, `a fixture takes at most ${MAX_UMPIRES_PER_FIXTURE} umpires`);
  const umpireIds = list.map((u) => {
    const id = refId(u);
    if (!id) throw new HttpError(400, 'each umpire needs an umpireId');
    return id;
  });
  if (new Set(umpireIds).size !== umpireIds.length)
    throw new HttpError(400, 'the same umpire is appointed twice');
  let refereeId: string | undefined;
  if (body.referee != null) {
    refereeId = refId(body.referee);
    if (!refereeId) throw new HttpError(400, 'referee needs an umpireId');
    if (umpireIds.includes(refereeId))
      throw new HttpError(400, 'the referee cannot also stand as an umpire');
  }
  return { umpireIds, ...(refereeId ? { refereeId } : {}) };
}

/** Drop the read-only `officials` join from fixtures on their way into a write. */
export function stripJoinedOfficials<T>(fixtures: T): T {
  if (!Array.isArray(fixtures)) return fixtures;
  return fixtures.map((f) => {
    if (f && typeof f === 'object' && 'officials' in f) {
      const { officials: _o, ...rest } = f as Record<string, unknown>;
      return rest;
    }
    return f;
  }) as T;
}

/** Group officials rows by series id → fixture id. */
export function indexOfficials(
  rows: FixtureOfficialsRecord[],
): Map<string, Map<string, FixtureOfficialsRecord>> {
  const out = new Map<string, Map<string, FixtureOfficialsRecord>>();
  for (const r of rows) {
    let m = out.get(r.seriesId);
    if (!m) out.set(r.seriesId, (m = new Map()));
    m.set(r.fixtureId, r);
  }
  return out;
}

/** The club ids behind a fixture's two sides (participants snapshot, else the id itself). */
export function fixtureClubIds(series: Series, fixture: { home?: unknown; away?: unknown }) {
  const byTeam = new Map((series.participants ?? []).map((p) => [p.teamId, p.clubId]));
  const out: string[] = [];
  for (const side of [fixture.home, fixture.away]) {
    if (typeof side !== 'string' || !side) continue;
    out.push(byTeam.get(side) ?? side);
  }
  return out;
}

/**
 * Join officials onto a series' fixtures. `include` decides per fixture whether the caller
 * may see them (admins: always; club reps: own fixtures with a visible venue). Names are
 * refreshed from the registry so a rename or merge shows at once. The audit fields
 * (`updatedBy`) are only returned when `audit` is set (admins).
 */
export function joinOfficials(
  series: Series,
  bySeries: Map<string, Map<string, FixtureOfficialsRecord>>,
  namesById: Map<string, string>,
  opts: { include: (fixture: Record<string, unknown>) => boolean; audit: boolean },
): Series {
  const rows = bySeries.get(series.id);
  if (!rows || !Array.isArray(series.fixtures)) return series;
  const name = (r: { umpireId: string; name: string }) => ({
    umpireId: r.umpireId,
    name: namesById.get(r.umpireId) ?? r.name,
  });
  let touched = false;
  const fixtures = series.fixtures.map((f) => {
    const fx = f as Record<string, unknown>;
    const row = typeof fx.id === 'string' ? rows.get(fx.id) : undefined;
    if (!row || !opts.include(fx)) return f;
    touched = true;
    const officials: FixtureOfficials = {
      umpires: (row.umpires ?? []).map(name),
      ...(row.referee ? { referee: name(row.referee) } : {}),
      ...(opts.audit && row.updatedAt ? { updatedAt: row.updatedAt } : {}),
      ...(opts.audit && row.updatedBy ? { updatedBy: row.updatedBy } : {}),
    };
    return { ...fx, officials };
  });
  return touched ? { ...series, fixtures } : series;
}

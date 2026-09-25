/**
 * Veterans squad-selection helpers (ADR 0013) — league detection, the finder gate, and the
 * candidate-handle HMAC.
 *
 * KEEP IN SYNC with `packages/engine/src/leagues.ts` (`isVeteransLeague` / `clubPlaysVeterans`): the frontend
 * uses the SAME key/label regexes to decide nav visibility. If the patterns drift, a club could
 * see the "Veterans squad" nav (client predicate) but 403 on the finder (this server predicate),
 * or vice-versa. The server predicate here is the authoritative gate; the client one is cosmetic.
 */
import { createHmac } from 'node:crypto';
import type { League, Series } from './types.js';
import * as repo from './repo.js';
import { candidateHandleSecret } from './env.js';

/**
 * A league key is "veterans" when it BEGINS with `veterans` (so `veterans`, `veterans-premier`,
 * `veterans-promotion` all match — `-` is a word boundary). The label check catches a catalogue
 * entry keyed differently but labelled "Veterans" / "Vets".
 */
const VETERANS_KEY_RE = /^veterans\b/i;
const VETERANS_LABEL_RE = /\bveterans?\b|\bvets\b/i;

/** True when a catalogue league is a veterans league (matched on key OR label). */
export function isVeteransLeague(
  league: { key?: string; label?: string } | null | undefined,
): boolean {
  if (!league) return false;
  return (
    VETERANS_KEY_RE.test(String(league.key || '')) ||
    VETERANS_LABEL_RE.test(String(league.label || ''))
  );
}

/**
 * True when a league KEY resolves to a veterans league in the tenant catalogue. Resolves the key
 * against `leagues` and checks the entry's key+label; for an orphan key (a series whose league was
 * removed from the catalogue) falls back to the key pattern alone so a live series is still gated.
 */
export function isVeteransLeagueKey(key: string, leagues: League[]): boolean {
  if (!key) return false;
  const lg = (leagues || []).find((l) => l.key === key);
  if (lg) return isVeteransLeague(lg);
  return VETERANS_KEY_RE.test(key);
}

/**
 * The finder GATE (ADR 0013): a club may search the tenant-wide roster ONLY if the union has
 * actually fixtured it into veterans cricket — i.e. it is a `participants[].clubId` of a RELEASED
 * series whose `leagueKey` is a veterans league. Deliberately NOT gated on `club.leagues`, which
 * any rep can set on the affiliation form (server accepts any catalogue key) — that would make a
 * tenant-wide name search self-grantable. `Series.leagueKey` is loosely typed (the interface has
 * an index signature) but every real series carries it (import-planb-fixtures / season runs).
 */
export async function veteransLeagueKeysForClub(
  tenant: string,
  clubId: string,
): Promise<Set<string>> {
  const [config, series] = await Promise.all([
    repo.getTenantConfig(tenant).catch(() => null),
    repo.listSeries(tenant),
  ]);
  const leagues = config?.leagues ?? [];
  const keys = new Set<string>();
  for (const s of series as Series[]) {
    if (s.released !== true) continue;
    const key = String((s as { leagueKey?: unknown }).leagueKey ?? '');
    if (!isVeteransLeagueKey(key, leagues)) continue;
    if ((s.participants ?? []).some((p) => p.clubId === clubId)) keys.add(key);
  }
  return keys;
}

export async function clubFixturedInVeterans(tenant: string, clubId: string): Promise<boolean> {
  return (await veteransLeagueKeysForClub(tenant, clubId)).size > 0;
}

/**
 * The opaque handle the finder returns instead of a player's natural key:
 * `HMAC-SHA256(secret, tenant|primaryClubId|naturalKey)`. Irreversible, and bound to the
 * (tenant, primary club, player) triple so it can only be redeemed against that club's rows.
 * The secret is resolved via `candidateHandleSecret()` — fails closed off-local when unset.
 */
export function candidateHandle(tenant: string, primaryClubId: string, naturalKey: string): string {
  return createHmac('sha256', candidateHandleSecret())
    .update(`${tenant}|${primaryClubId}|${naturalKey}`)
    .digest('hex');
}

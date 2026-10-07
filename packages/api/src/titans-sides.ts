/**
 * Titans fixtures: sheet side → live team id, and the `--append-sides` plan. Pure — no repo,
 * no AWS; import-titans-fixtures.ts reads the clubs and writes the patches.
 *
 * A sheet side ("TUKS 2", "PHSOB VETERANS 1", "ADELAAR B") resolves against the club's live
 * `teamRosters[leagueKey]` by its SIDE SUFFIX ("2", "VETERANS 1", "B"), read off the roster
 * name after the club's name or sheet token — so both the August structure labels ("TUKS 2")
 * and generated names ("TUT Cricket Club A") match. Ids are never derived from the sheet digit:
 *
 *   - a roster entry with the same suffix → its id;
 *   - no roster and exactly one sheet side in the league → the bare club id (the club's single
 *     side, what `clubTeamsForLeague` returns for a count-1 league);
 *   - otherwise the side is MISSING and only `--append-sides` may add it: the next free
 *     `tm_<clubId>_<key>_<i>` id (bumped past every id the club already uses), the sheet name
 *     verbatim. Growing a no-roster league from 1 to 2+ sides first SEEDS roster[0] with
 *     `{ id: clubId, name: <first sheet side> }`, so the club's existing single side keeps the
 *     id every earlier series and coach assignment used.
 *
 * Women's competitions are never appended: a women's side the club does not already have is
 * a decision for the union (risk R6), listed as fatal. Any change to an existing roster id is
 * fatal by construction.
 */
import type { Club, ClubTeam } from './types.js';
import { CLUB_MAP, type ClubMapEntry } from './titans-import-map.js';
import { canonicalTeamName, resolveTeamClub } from './titans-fixture-map.js';
import { deriveTeamPlanCounts } from './team-plan.js';

/** Women's competitions: never auto-appended (risk R6). */
export const WOMENS_NO_APPEND_KEYS = new Set([
  'womens-premier-league',
  'womens-t20',
  'womens-junior-league',
]);

/** Women's league keys the placement table reads (incl. the legacy `women-s-*` spellings
 * some tenants carry). */
const WOMENS_PREMIER_KEYS = ['womens-premier-league', 'women-s-premier-league'];
const WOMENS_PROMOTION_KEYS = ['womens-promotion-league', 'women-s-promotion-league'];

const CLUB_BY_ID = new Map(CLUB_MAP.map((c) => [c.id, c]));

/**
 * The side suffix of a team name for one club: what follows the club's display name or one of
 * its sheet tokens ("TUT Cricket Club A" → "A", "PHSOB VETERANS 1" → "VETERANS 1"), '' for the
 * bare club, or null when the name starts with neither.
 */
export function sideSuffixFor(
  name: string,
  club: Pick<ClubMapEntry, 'name' | 'sheetTokens'>,
): string | null {
  const c = canonicalTeamName(name);
  const prefixes = [club.name.toUpperCase(), ...club.sheetTokens].sort(
    (a, b) => b.length - a.length,
  );
  for (const p of prefixes) {
    if (c === p) return '';
    if (c.startsWith(`${p} `)) return c.slice(p.length + 1).trim();
  }
  return null;
}

/** Order sides "1" < "2" < "10", "A" < "B", "VETERANS 1" < "VETERANS 2". */
function suffixOrder(a: string, b: string): number {
  const na = /(\d+)$/.exec(a);
  const nb = /(\d+)$/.exec(b);
  if (na && nb && a.slice(0, na.index) === b.slice(0, nb.index))
    return Number(na[1]) - Number(nb[1]);
  return a.localeCompare(b);
}

export interface SideNeed {
  leagueKey: string;
  /** Canonical sheet name. */
  name: string;
}

export interface ResolvedSide {
  teamId: string;
  clubId: string;
  /** The roster name (or the club name for a bare single side). */
  name: string;
  venue?: string;
  how: 'roster' | 'bare' | 'seed' | 'append';
}

export interface ClubPatchPlan {
  clubId: string;
  clubName: string;
  version: number | undefined;
  leagues: string[];
  leagueTeams: Record<string, number>;
  teamRosters: Record<string, ClubTeam[]>;
  teams: number;
  women: number;
  juniors: number;
  /** Human lines: every seed, every new id, every counter change. */
  changes: string[];
}

export interface WomensPlacementRow {
  clubId: string;
  clubName: string;
  sheetSides: string[];
  premier: string;
  promotion: string;
  verdict: 'ok' | 'DECISION';
  note?: string;
}

export interface SidePlan {
  /** `${leagueKey}::${canonical name}` → the side. */
  resolve: Map<string, ResolvedSide>;
  patches: ClubPatchPlan[];
  womens: WomensPlacementRow[];
  /** Missing clubs, women's decisions, inconsistent rosters, id changes — each blocks. */
  fatal: string[];
  /** Sides that need `--append-sides` (fatal for the import itself; the append mode's work). */
  needsAppend: string[];
  warnings: string[];
}

export const sideKey = (leagueKey: string, name: string) =>
  `${leagueKey}::${canonicalTeamName(name)}`;

/**
 * Plan every side the sheets name against the live clubs. With `allowAppend` the missing
 * (non-women's) sides are planned as roster appends and listed in `patches`; without it they
 * are listed in `needsAppend` (the import refuses until `--append-sides --confirm` has run).
 * `fixturesOnlyKeys` (T20 cups) are left out of the teams/women/juniors counters — a cup
 * side is a club's existing XI, not an extra team.
 */
export function planSides(
  needs: SideNeed[],
  clubs: Club[],
  opts: { allowAppend: boolean; fixturesOnlyKeys?: Set<string> },
): SidePlan {
  const plan: SidePlan = {
    resolve: new Map(),
    patches: [],
    womens: [],
    fatal: [],
    needsAppend: [],
    warnings: [],
  };
  const clubsById = new Map(clubs.map((c) => [c.id, c]));
  // club → league → canonical names
  const want = new Map<string, Map<string, Set<string>>>();
  for (const n of needs) {
    const entry = resolveTeamClub(n.name);
    if (!entry) {
      plan.fatal.push(`"${n.name}" (${n.leagueKey}) resolves to no club`);
      continue;
    }
    const byLeague = want.get(entry.id) ?? new Map<string, Set<string>>();
    byLeague.set(
      n.leagueKey,
      (byLeague.get(n.leagueKey) ?? new Set()).add(canonicalTeamName(n.name)),
    );
    want.set(entry.id, byLeague);
  }

  for (const [clubId, byLeague] of want) {
    const entry = CLUB_BY_ID.get(clubId)!;
    const club = clubsById.get(clubId);
    if (!club) {
      plan.fatal.push(`club "${clubId}" (${entry.name}) is not on the tenant`);
      continue;
    }
    const leagues = [...(club.leagues ?? [])];
    const leagueTeams: Record<string, number> = { ...(club.leagueTeams ?? {}) };
    const teamRosters: Record<string, ClubTeam[]> = { ...(club.teamRosters ?? {}) };
    const used = new Set<string>([
      club.id,
      ...Object.values(club.teamRosters ?? {}).flatMap((r) =>
        Array.isArray(r) ? r.map((t) => t.id) : [],
      ),
    ]);
    const changes: string[] = [];
    const ground = club.ground?.venue;

    for (const [leagueKey, nameSet] of byLeague) {
      const names = [...nameSet].sort((a, b) =>
        suffixOrder(sideSuffixFor(a, entry) ?? a, sideSuffixFor(b, entry) ?? b),
      );
      const where = `${club.name} / ${leagueKey}`;
      const roster: ClubTeam[] = Array.isArray(club.teamRosters?.[leagueKey])
        ? (club.teamRosters![leagueKey] as ClubTeam[])
        : [];
      const inLeague = leagues.includes(leagueKey);
      const count = Number(club.leagueTeams?.[leagueKey]) || (inLeague ? 1 : 0);
      const women = WOMENS_NO_APPEND_KEYS.has(leagueKey);
      const bySuffix = new Map<string, ClubTeam>();
      for (const t of roster) {
        const s = sideSuffixFor(t.name ?? '', entry);
        if (s == null)
          plan.warnings.push(
            `${where}: roster entry "${t.name}" (${t.id}) names no side of the club`,
          );
        else if (bySuffix.has(s))
          plan.warnings.push(`${where}: two roster entries share side "${s}"`);
        else bySuffix.set(s, t);
      }
      const resolved = (name: string, side: ResolvedSide) =>
        plan.resolve.set(sideKey(leagueKey, name), side);
      const missing: string[] = [];

      if (roster.length) {
        if (count !== roster.length)
          plan.warnings.push(
            `${where}: leagueTeams says ${count} but the roster lists ${roster.length}`,
          );
        for (const n of names) {
          const t = bySuffix.get(sideSuffixFor(n, entry) ?? '\u0000');
          if (t)
            resolved(n, {
              teamId: t.id,
              clubId,
              name: t.name,
              ...(t.venue || ground ? { venue: t.venue || ground } : {}),
              how: 'roster',
            });
          else missing.push(n);
        }
      } else if (count >= 2) {
        plan.fatal.push(
          `${where}: leagueTeams says ${count} but there is no roster — the side ids are undefined; needs a decision`,
        );
        continue;
      } else if (names.length === 1) {
        if (leagueKey === 'womens-premier-league' && !inLeague) missing.push(names[0]);
        else
          resolved(names[0], {
            teamId: clubId,
            clubId,
            name: club.name,
            ...(ground ? { venue: ground } : {}),
            how: 'bare',
          });
      } else missing.push(...names);

      if (!missing.length) continue;
      if (women) {
        plan.fatal.push(
          `${where}: women's side(s) ${missing.join(', ')} not on the club — never auto-appended; needs a union/admin decision`,
        );
        continue;
      }
      if (!opts.allowAppend) {
        plan.needsAppend.push(`${where}: ${missing.join(', ')}`);
        continue;
      }
      // Grow the roster. A no-roster league seeds roster[0] with the club id first.
      const next = [...roster];
      if (!roster.length) {
        const seedName = missing.shift()!;
        next.push({ id: clubId, name: seedName });
        resolved(seedName, {
          teamId: clubId,
          clubId,
          name: seedName,
          ...(ground ? { venue: ground } : {}),
          how: 'seed',
        });
        changes.push(
          `${leagueKey}: SEED roster[0] = { id: ${clubId}, name: "${seedName}" } (existing single side keeps the club id)`,
        );
      }
      let i = next.length;
      for (const n of missing) {
        let id = `tm_${clubId}_${leagueKey}_${i++}`;
        while (used.has(id)) id = `tm_${clubId}_${leagueKey}_${i++}`;
        used.add(id);
        next.push({ id, name: n });
        resolved(n, {
          teamId: id,
          clubId,
          name: n,
          ...(ground ? { venue: ground } : {}),
          how: 'append',
        });
        changes.push(`${leagueKey}: + ${id} "${n}"`);
      }
      // Existing roster ids must survive unchanged, in place.
      roster.forEach((t, idx) => {
        if (next[idx]?.id !== t.id)
          plan.fatal.push(`${where}: roster id ${t.id} would change — refusing`);
      });
      teamRosters[leagueKey] = next;
      const before = Number(club.leagueTeams?.[leagueKey]) || (inLeague ? 1 : 0);
      leagueTeams[leagueKey] = next.length;
      changes.push(`${leagueKey}: leagueTeams ${before} → ${next.length}`);
      if (!inLeague) {
        leagues.push(leagueKey);
        changes.push(`${leagueKey}: + league key`);
      }
    }

    if (changes.length) {
      const counters = (lt: Record<string, number>, ls: string[]) => {
        const filled: Record<string, number> = {};
        for (const k of ls) if (!opts.fixturesOnlyKeys?.has(k)) filled[k] = lt[k] ?? 1;
        return deriveTeamPlanCounts(filled);
      };
      const now = counters(leagueTeams, leagues);
      const was = { teams: club.teams, women: club.women, juniors: club.juniors };
      if (was.teams !== now.teams || was.women !== now.women || was.juniors !== now.juniors)
        changes.push(
          `counters teams ${was.teams ?? '—'}→${now.teams}, women ${was.women ?? '—'}→${now.women}, juniors ${was.juniors ?? '—'}→${now.juniors}`,
        );
      plan.patches.push({
        clubId,
        clubName: club.name,
        version: club.version,
        leagues,
        leagueTeams,
        teamRosters,
        ...now,
        changes,
      });
    }
  }

  // Women's League placement table: premier / promotion sides per club, against the sheet.
  for (const [clubId, byLeague] of want) {
    const names = byLeague.get('womens-premier-league');
    if (!names) continue;
    const club = clubsById.get(clubId);
    const describe = (keys: string[]) =>
      keys
        .filter((k) => club?.leagues?.includes(k) || club?.leagueTeams?.[k])
        .map((k) => {
          const r = club?.teamRosters?.[k];
          return Array.isArray(r) && r.length
            ? `${k}: ${r.map((t) => t.name).join(', ')}`
            : `${k}: ${Number(club?.leagueTeams?.[k]) || 1} side`;
        })
        .join('; ') || '—';
    const ok = [...names].every((n) => plan.resolve.has(sideKey('womens-premier-league', n)));
    plan.womens.push({
      clubId,
      clubName: club?.name ?? CLUB_BY_ID.get(clubId)?.name ?? clubId,
      sheetSides: [...names].sort(),
      premier: club ? describe(WOMENS_PREMIER_KEYS) : 'club not on tenant',
      promotion: club ? describe(WOMENS_PROMOTION_KEYS) : '—',
      verdict: ok ? 'ok' : 'DECISION',
    });
  }
  plan.womens.sort((a, b) => a.clubName.localeCompare(b.clubName));
  return plan;
}

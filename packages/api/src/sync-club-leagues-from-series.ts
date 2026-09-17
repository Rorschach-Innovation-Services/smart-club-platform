/**
 * Backfill each club's `leagues` (and, for multi-side clubs, `leagueTeams` /
 * `teamRosters`) from the SERIES it actually participates in.
 *
 * The Plan B fixture importer writes Series rows only — it never patched the
 * clubs — so a club fielding a side in, say, `veterans-premier` carries no
 * `veterans-premier` key on its record. Season Insights counts `club.leagues`,
 * so those leagues render "0 clubs / 0 teams" even though the fixtures exist.
 * This script reads `series.participants[]`, groups them by club, and writes the
 * missing league keys back onto the clubs — the same answer the union already
 * expressed by fixturing the series, made durable on the club records.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/src/sync-club-leagues-from-series.ts <tenant>                    (dry-run)
 *   sst shell --stage <stage> -- npx tsx packages/api/src/sync-club-leagues-from-series.ts <tenant> [--only s1,s2] [--include-drafts] --confirm
 *
 * Rules (mirroring the review notes — never a guess, never a clobber):
 *   • RELEASED series only by default. `--include-drafts` widens to every series
 *     (the importer passes it for the ids it just wrote, which are still drafts).
 *   • Merge, never remove: a key is only ADDED to `club.leagues`; nothing is
 *     dropped. `leagueTeams` / `teamRosters` are always spread from the club's
 *     current maps before mutation — `repo.updateClub` REPLACES a top-level key
 *     wholesale, so a bare `{ [key]: … }` would wipe every sibling league's data.
 *   • A league with ≥2 sides for a club writes `leagueTeams[key] = count` and a
 *     `teamRosters[key]` built from the series participants, so
 *     `clubTeamsForLeague` reproduces exactly the ids the series snapshotted. The
 *     club ground venue is NOT copied onto a side (only a real override is), so a
 *     later ground edit still propagates.
 *   • Exactly one side that is a `tm_` id (e.g. a club with only its B side in a
 *     league) leaves `leagueTeams` at 1 and logs a NOTE: future series generation
 *     for that league will use `teamId === clubId`. The released series keeps its
 *     own participant snapshot, so there is no runtime impact.
 *   • Key already present with a STORED roster whose ids differ from the series
 *     ids → CONFLICT: log and skip. Coach `teamIds` may point at the stored ids;
 *     the script never rewrites them. Only an absent-roster count is UPGRADEd.
 *   • Series whose `leagueKey` is not in the tenant catalogue are logged ORPHAN
 *     and skipped. Every patch is run through `validateClubPatch` (the same guard
 *     the rep PATCH /clubs/:id uses) before writing; `amendmentPending` is never
 *     touched. Dry-run default; idempotent (a second run writes nothing).
 *
 * Runbook: docs/runbooks/sync-club-leagues-from-series.md
 */
import { pathToFileURL } from 'node:url';
import * as repo from './repo.js';
import { validateClubPatch, resolveRequiredDocs, resolveDistricts } from './catalogue.js';
import type { Club, ClubTeam, Series } from './types.js';

type SeriesParticipant = NonNullable<Series['participants']>[number];

export interface ClubLeagueSyncResult {
  /** Series inspected after the released/only filters. */
  seriesConsidered: number;
  /** Series skipped because their `leagueKey` is not in the tenant catalogue. */
  orphanSeries: number;
  /** Distinct clubs that participate in at least one considered series. */
  clubsWithParticipation: number;
  /** Clubs whose record needs at least one change (== `patched` after --confirm). */
  wouldPatch: number;
  /** Clubs actually written (always 0 on dry-run). */
  patched: number;
  /** Leagues whose team count was raised from an absent-roster 1 to the side count. */
  upgrades: number;
  /** (club, league) pairs skipped because a stored roster's ids differ from the series. */
  conflicts: number;
  /** Single-side `tm_` participations left at count 1 (NOTE logged). */
  singleSideNotes: number;
  /** Clubs whose version-guarded write lost a race (left untouched, safe to re-run). */
  raced: number;
}

/** True when two id collections describe the same set (order-independent). */
function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** A series participant → a `ClubTeam` roster entry, copying a venue override only. */
function toClubTeam(p: SeriesParticipant, groundVenue?: string): ClubTeam {
  const team: ClubTeam = { id: p.teamId, name: p.name };
  // Only a genuine venue OVERRIDE is stored; matching the club ground is left
  // implicit so a later ground edit still flows through clubTeamsForLeague.
  const venue = typeof p.venue === 'string' ? p.venue.trim() : '';
  if (venue && venue !== (groundVenue ?? '')) {
    team.venue = venue;
    if (Number.isFinite(p.lat)) team.lat = p.lat;
    if (Number.isFinite(p.lon)) team.lon = p.lon;
  }
  return team;
}

/**
 * The script's core, exported so the dynalite integration test and the importer
 * drive the real write path. Logs progress via `log` (console.log from the CLI).
 */
export async function syncClubLeaguesFromSeries(
  tenant: string,
  opts: {
    confirm?: boolean;
    /** Restrict to these series ids (the importer passes the ids it just wrote). */
    only?: string[];
    /** Include unreleased (draft) series too; default is released-only. */
    includeDrafts?: boolean;
    log?: (line: string) => void;
  } = {},
): Promise<ClubLeagueSyncResult> {
  const confirm = opts.confirm ?? false;
  const includeDrafts = opts.includeDrafts ?? false;
  const log = opts.log ?? console.log;
  const onlyIds = opts.only && opts.only.length ? new Set(opts.only) : null;

  const cfg = await repo.getTenantConfig(tenant);
  const validKeys = new Set((cfg?.leagues ?? []).map((l) => l.key));

  const result: ClubLeagueSyncResult = {
    seriesConsidered: 0,
    orphanSeries: 0,
    clubsWithParticipation: 0,
    wouldPatch: 0,
    patched: 0,
    upgrades: 0,
    conflicts: 0,
    singleSideNotes: 0,
    raced: 0,
  };

  // Group participants by club → league → teamId (dedupes ids seen across series
  // sharing a leagueKey, and keeps one representative participant per side).
  const byClub = new Map<string, Map<string, Map<string, SeriesParticipant>>>();
  const allSeries = await repo.listSeries(tenant);
  for (const s of allSeries) {
    if (onlyIds && !onlyIds.has(String(s.id))) continue;
    const leagueKey = typeof s.leagueKey === 'string' ? s.leagueKey : '';
    const participants = Array.isArray(s.participants) ? s.participants : [];
    if (!leagueKey || !participants.length) continue;
    if (!includeDrafts && !s.released) continue;
    result.seriesConsidered++;
    if (!validKeys.has(leagueKey)) {
      log(`ORPHAN ${s.id}: leagueKey "${leagueKey}" not in the tenant catalogue — skipped`);
      result.orphanSeries++;
      continue;
    }
    for (const p of participants) {
      if (!p || typeof p.clubId !== 'string' || typeof p.teamId !== 'string') continue;
      let byLeague = byClub.get(p.clubId);
      if (!byLeague) byClub.set(p.clubId, (byLeague = new Map()));
      let sides = byLeague.get(leagueKey);
      if (!sides) byLeague.set(leagueKey, (sides = new Map()));
      if (!sides.has(p.teamId)) sides.set(p.teamId, p);
    }
  }

  result.clubsWithParticipation = byClub.size;

  for (const [clubId, byLeague] of byClub) {
    const club = await repo.getClub(tenant, clubId);
    if (!club) {
      log(`MISSING club "${clubId}" referenced by a series participant — skipped`);
      continue;
    }
    const beforeLeagueCount = (club.leagues ?? []).length;
    const leagues = [...(club.leagues ?? [])];
    const leaguesSet = new Set(leagues);
    // Spread the sibling maps up front — updateClub replaces the whole key.
    const leagueTeams: Record<string, number> = { ...(club.leagueTeams ?? {}) };
    const teamRosters: Record<string, ClubTeam[]> = { ...(club.teamRosters ?? {}) };
    const groundVenue = club.ground?.venue;
    let changed = false;
    const added: string[] = [];

    for (const [leagueKey, sidesMap] of byLeague) {
      const sides = [...sidesMap.values()];
      const sideCount = sides.length;
      const hasKey = leaguesSet.has(leagueKey);
      const storedRoster = Array.isArray(club.teamRosters?.[leagueKey])
        ? (club.teamRosters![leagueKey] as ClubTeam[])
        : undefined;
      const storedCount = Number(club.leagueTeams?.[leagueKey]) || 1;

      if (sideCount >= 2) {
        const seriesIds = sides.map((s) => s.teamId);
        if (storedRoster && storedRoster.length) {
          if (
            !sameIdSet(
              storedRoster.map((t) => t.id),
              seriesIds,
            )
          ) {
            // A stored roster whose ids differ is authoritative (coach teamIds may
            // point at it) — never rewrite it.
            log(
              `CONFLICT ${clubId} / ${leagueKey}: stored roster ids differ from the series ` +
                `(stored [${storedRoster.map((t) => t.id).join(', ')}] vs series [${seriesIds.join(', ')}]) — skipped`,
            );
            result.conflicts++;
            // Still surface participation if the league key itself is missing.
            if (!hasKey) {
              leagues.push(leagueKey);
              leaguesSet.add(leagueKey);
              added.push(leagueKey);
              changed = true;
            }
            continue;
          }
          // Stored roster already matches the series; only close a count gap.
          if (storedCount < sideCount) {
            leagueTeams[leagueKey] = sideCount;
            result.upgrades++;
            changed = true;
          }
          if (!hasKey) {
            leagues.push(leagueKey);
            leaguesSet.add(leagueKey);
            added.push(leagueKey);
            changed = true;
          }
        } else {
          // No stored roster: write one from the series so clubTeamsForLeague
          // reproduces the exact snapshotted ids.
          if (!hasKey) {
            leagues.push(leagueKey);
            leaguesSet.add(leagueKey);
            added.push(leagueKey);
          } else if (storedCount < sideCount) {
            result.upgrades++;
          }
          leagueTeams[leagueKey] = sideCount;
          teamRosters[leagueKey] = sides.map((p) => toClubTeam(p, groundVenue));
          changed = true;
        }
      } else {
        // Exactly one side. Only a missing key is added; count stays 1.
        if (!hasKey) {
          leagues.push(leagueKey);
          leaguesSet.add(leagueKey);
          added.push(leagueKey);
          changed = true;
          const [only] = sides;
          if (only.teamId !== clubId) {
            log(
              `NOTE ${clubId} / ${leagueKey}: single side "${only.teamId}" — leaving count at 1; ` +
                `future series generation will use teamId === clubId (released snapshot keeps its own).`,
            );
            result.singleSideNotes++;
          }
        }
      }
    }

    if (!changed) continue;
    result.wouldPatch++;

    const patch: Partial<Club> = {
      version: club.version,
      leagues,
      leagueTeams,
      teamRosters,
    };

    // Same gate as the rep PATCH /clubs/:id path — a bad shape must never write.
    const requiredDocs = resolveRequiredDocs(cfg);
    const validLeagueKeys = new Set([...validKeys, ...(club.leagues ?? [])]);
    const validDocKeys = new Set([
      ...requiredDocs.map((d) => d.key),
      ...Object.keys(club.docs ?? {}),
      ...Object.keys(club.docMeta ?? {}),
    ]);
    const validDistricts = new Set([
      ...resolveDistricts(cfg),
      ...(club.district ? [club.district] : []),
    ]);
    const invalid = validateClubPatch(
      patch,
      validLeagueKeys,
      validDocKeys,
      validDistricts,
      requiredDocs,
      club.docMeta,
    );
    if (invalid) {
      log(`VALIDATION ${clubId}: ${invalid} — skipped (no write)`);
      result.wouldPatch--;
      continue;
    }

    const summary =
      `${clubId} (${club.name}): +[${added.join(', ') || 'none'}]` +
      ` → ${leagues.length} league(s)` +
      (beforeLeagueCount <= 1 && leagues.length >= 2
        ? ' [now multi-league — its team-less players stop resolving to a single fallback league;' +
          ' expect the dashboard\'s "unattributed" figure to rise]'
        : '');

    if (!confirm) {
      log(`[dry-run] ${summary}`);
      continue;
    }
    try {
      await repo.updateClub(
        tenant,
        clubId,
        patch,
        'sync-club-leagues-from-series',
        new Date().toISOString(),
      );
      result.patched++;
      log(summary);
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'VersionConflictError') {
        result.raced++;
        log(`RACED ${clubId}: version changed mid-pass — left untouched (safe to re-run)`);
      } else {
        throw err;
      }
    }
  }

  if (!confirm) {
    log(
      `dry-run complete: ${result.wouldPatch} club(s) would change across ` +
        `${result.seriesConsidered} series (${result.orphanSeries} orphan, ${result.conflicts} conflict, ` +
        `${result.upgrades} upgrade, ${result.singleSideNotes} single-side note(s)). Re-run with --confirm.`,
    );
  } else {
    log(
      `sync complete: ${result.patched} club(s) patched` +
        (result.raced ? ` (${result.raced} raced, untouched)` : '') +
        ` — ${result.conflicts} conflict, ${result.upgrades} upgrade, ${result.orphanSeries} orphan series.`,
    );
  }
  return result;
}

interface CliArgs {
  tenant: string;
  confirm: boolean;
  includeDrafts: boolean;
  only: string[];
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { tenant: '', confirm: false, includeDrafts: false, only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') args.confirm = true;
    else if (a === '--include-drafts') args.includeDrafts = true;
    else if (a === '--only')
      args.only = (argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else if (!args.tenant) args.tenant = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return args;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : err}`);
    console.error(
      'usage: sync-club-leagues-from-series <tenant> [--only s1,s2] [--include-drafts] [--confirm]',
    );
    process.exit(1);
    return;
  }
  if (!args.tenant) {
    console.error(
      'usage: sync-club-leagues-from-series <tenant> [--only s1,s2] [--include-drafts] [--confirm]',
    );
    process.exit(1);
    return;
  }
  const config = await repo.getTenantConfig(args.tenant);
  if (!config) {
    console.error(`tenant "${args.tenant}" not found`);
    process.exit(1);
    return;
  }
  await syncClubLeaguesFromSeries(args.tenant, {
    confirm: args.confirm,
    includeDrafts: args.includeDrafts,
    only: args.only,
  });
}

// Only run as a CLI — the integration test and the importer import the core directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

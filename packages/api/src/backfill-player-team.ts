/**
 * One-off / on-demand backfill: make legacy players' league attribution durable.
 *
 * `PlayerRegistration.team` (a catalogue league key) is required on both modern
 * registration paths, but legacy rows predate the field. The demographics
 * runtime fallback (demographics.ts, ladder step 3) already attributes a
 * no-team player at a single-league club to that league — this script only
 * writes that same answer onto the rows so it survives the club later entering
 * a second league. Run it when the dashboard's unattributed figure is material.
 *
 * Rules (mirroring the runtime ladder — never guessing):
 *   • Only clubs entered in EXACTLY one league are touched; multi-league (and
 *     zero-league) clubs are skipped — attribution there would be a guess.
 *   • Only players with NO `team` attribute at all are written, guarded by
 *     `attribute_not_exists(team)` (repo.setPlayerTeamIfAbsent) so a stored
 *     value can never be overwritten. Orphaned `team` values (league deleted
 *     after registration) are registration-time source data and stay untouched
 *     — they remain honestly Unattributed; re-attributing them would be a
 *     separate, explicitly-consented migration.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/src/backfill-player-team.ts <tenant>            (dry-run)
 *   sst shell --stage <stage> -- npx tsx packages/api/src/backfill-player-team.ts <tenant> --confirm
 *
 * Idempotent: a second pass finds no team-less rows at eligible clubs and
 * writes nothing. Safe to re-run — a registration landing mid-pass either
 * already carries its own `team` (modern paths require it) or is picked up by
 * the next run. Runbook: docs/runbooks/backfill-player-team.md
 */
import { pathToFileURL } from 'node:url';
import * as repo from './repo.js';

export interface PlayerTeamBackfillResult {
  /** Clubs scanned (all clubs in the tenant). */
  clubs: number;
  /** Clubs skipped because they entered zero or 2+ leagues. */
  skippedClubs: number;
  /** Players with no `team` attribute at eligible clubs (would-write on dry-run). */
  candidates: number;
  /** Rows actually written (always 0 on dry-run). */
  filled: number;
  /** Candidates whose conditional write lost (row gained a team / vanished mid-pass). */
  raced: number;
}

/**
 * The script's core, exported so the dynalite integration test drives the real
 * write path. Logs per-club counts via `log` (console.log from the CLI).
 */
export async function backfillPlayerTeam(
  tenant: string,
  opts: { confirm?: boolean; log?: (line: string) => void } = {},
): Promise<PlayerTeamBackfillResult> {
  const confirm = opts.confirm ?? false;
  const log = opts.log ?? console.log;

  const clubs = await repo.listClubs(tenant);
  const result: PlayerTeamBackfillResult = {
    clubs: clubs.length,
    skippedClubs: 0,
    candidates: 0,
    filled: 0,
    raced: 0,
  };

  for (const club of clubs) {
    const leagues = club.leagues ?? [];
    if (leagues.length !== 1) {
      result.skippedClubs++;
      if (leagues.length > 1) {
        log(`skip ${club.id} (${club.name}): ${leagues.length} leagues — ambiguous`);
      }
      continue;
    }
    const [league] = leagues;
    // `team == null` mirrors the attribute_not_exists guard; a stored value —
    // orphaned or not — makes the row a non-candidate.
    const players = await repo.listPlayers(tenant, club.id);
    const candidates = players.filter((p) => p.team == null);
    result.candidates += candidates.length;
    if (!candidates.length) continue;

    if (!confirm) {
      log(
        `[dry-run] ${club.id} (${club.name}): ${candidates.length} of ${players.length} player(s) → team "${league}"`,
      );
      continue;
    }

    let filled = 0;
    for (const p of candidates) {
      // Conditional write is the authority — the filter above is just a cheap
      // pre-pass, so a row that gained a team since the list read is skipped.
      if (await repo.setPlayerTeamIfAbsent(tenant, club.id, p.naturalKey, league)) filled++;
      else result.raced++;
    }
    result.filled += filled;
    log(`${club.id} (${club.name}): ${filled} of ${players.length} player(s) → team "${league}"`);
  }

  if (!confirm) {
    log(`dry-run complete: ${result.candidates} player(s) would change. Re-run with --confirm.`);
  } else {
    log(
      `backfill complete: ${result.filled} player(s) filled across ${result.clubs} club(s)` +
        (result.raced ? ` (${result.raced} raced, untouched)` : ''),
    );
  }
  return result;
}

async function main(): Promise<void> {
  const [tenant, flag] = process.argv.slice(2);
  if (!tenant) {
    console.error('usage: backfill-player-team <tenant> [--confirm]');
    process.exit(1);
  }
  // A misspelled flag ("--comfirm") must not silently run as a dry-run.
  if (flag && flag !== '--confirm') {
    console.error(`unknown flag "${flag}" — usage: backfill-player-team <tenant> [--confirm]`);
    process.exit(1);
  }
  const config = await repo.getTenantConfig(tenant);
  if (!config) {
    console.error(`tenant "${tenant}" not found`);
    process.exit(1);
  }
  await backfillPlayerTeam(tenant, { confirm: flag === '--confirm' });
}

// Only run as a CLI — the integration test imports backfillPlayerTeam directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

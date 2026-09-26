/**
 * Shared harness for the integration tests that start a season through `POST /season-runs`.
 *
 * The route no longer accepts client snapshots: it resolves `leagueKey` → `competitionId`
 * against LIVE tenant config and freezes that competition's structure + calendar. So a test
 * that wants a run on a given structure/calendar binds them in config first
 * (`bindCompetition`), then POSTs a body naming only the binding (`startRunBody`).
 *
 * Not a `*.test.ts` file, so the runner's `test/*.test.ts` glob never executes it alone.
 */
import type {
  Competition,
  CompetitionStructure,
  League,
  SeasonCalendar,
  TenantConfig,
} from '../src/types.js';

type Repo = typeof import('../src/repo.js');

const upsert = <T extends { id: string }>(list: T[] | undefined, item: T): T[] => [
  ...(list ?? []).filter((x) => x.id !== item.id),
  item,
];

/**
 * Write `structure` and `calendar` into the tenant's config and bind them to
 * `competitionId` on `leagueKey` (creating the league if the seed lacks it). Written
 * straight through the repo — no operator validators — so a test can seed a deliberately
 * malformed structure and prove the POST still rejects it.
 */
export async function bindCompetition(
  repo: Repo,
  tenant: string,
  opts: {
    leagueKey: string;
    competitionId: string;
    structure: CompetitionStructure;
    calendar: SeasonCalendar;
  },
): Promise<TenantConfig> {
  const cfg = await repo.getTenantConfig(tenant);
  if (!cfg) throw new Error(`tenant ${tenant} is not seeded`);
  const competition: Competition = {
    id: opts.competitionId,
    label: opts.competitionId,
    structureId: opts.structure.id,
    calendarId: opts.calendar.id,
  };
  const leagues: League[] = [...(cfg.leagues ?? [])];
  const at = leagues.findIndex((l) => l.key === opts.leagueKey);
  const league: League =
    at >= 0
      ? leagues[at]!
      : { key: opts.leagueKey, label: opts.leagueKey, group: 'Test', district: 'All districts' };
  const bound: League = {
    ...league,
    competitions: [
      ...(league.competitions ?? []).filter((c) => c.id !== competition.id),
      competition,
    ],
  };
  if (at >= 0) leagues[at] = bound;
  else leagues.push(bound);
  const next: TenantConfig = {
    ...cfg,
    leagues,
    structures: upsert(cfg.structures, opts.structure),
    calendars: upsert(cfg.calendars, opts.calendar),
  };
  await repo.putTenantConfig(next);
  return next;
}

/** The body the console now sends: the binding and the label — no snapshots, no stages. */
export const startRunBody = (over: Record<string, unknown> = {}) => ({
  id: 'sr-1',
  leagueKey: 'premier-men',
  competitionId: 'comp-1',
  seasonLabel: '2026/27',
  version: 1,
  ...over,
});

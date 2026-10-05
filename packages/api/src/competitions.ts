/**
 * Leagues and tournaments created from Fixtures & Venues (ADR 0018) — request parsing and the
 * read-side helpers the /competitions routes in index.ts use. The draw itself is the engine's
 * `planCompetition`; results are the medicoach FIXRESULT# items (ADR 0016).
 *
 * A competition is the set of series sharing `series.competition.id`. Nothing new is stored
 * beyond that block on each series: the series stay ordinary series, so release, the clash
 * gates, venue allocation, officials, results and the medicoach sync all apply unchanged.
 */
import { randomUUID } from 'node:crypto';
import { HttpError } from './auth.js';
import {
  advanceKnockout,
  type CompetitionMeta,
  type CompetitionSpec,
} from '../../engine/src/competition.js';
import { computeStandings, type StandingRow } from '../../engine/src/standings.js';
import { isSlotRef } from '../../engine/src/formats.js';
import { toResultView } from './medicoach-sync/series-results.js';
import type { Club, Series, StoredFixtureResult } from './types.js';

export type CompetitionSeries = Series & { competition?: CompetitionMeta; maxOvers?: number };

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** A fresh competition id: `c-<slug>-<6 hex>`. */
export const newCompetitionId = (name: string) =>
  `c-${slug(name) || 'competition'}-${randomUUID().slice(0, 6)}`;

/**
 * The request body as a spec. Shapes are checked by the engine (`competitionProblems`); this
 * only makes sure it is an object, mints an id when none is given, and checks every team is
 * one of the tenant's clubs (a team id is the club id, or a `tm_<club>_…` team of it).
 */
export function parseCompetitionBody(raw: unknown, clubs: Club[]): CompetitionSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HttpError(400, 'body must be a competition');
  const body = raw as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name : '';
  const spec = {
    ...body,
    id: typeof body.id === 'string' && body.id ? body.id : newCompetitionId(name),
    name,
    teams: Array.isArray(body.teams) ? body.teams : [],
  } as CompetitionSpec;
  const clubIds = new Set(clubs.map((c) => c.id));
  const unknown = spec.teams
    .filter(
      (t) => !t || typeof t !== 'object' || !clubIds.has((t as { clubId?: string }).clubId ?? ''),
    )
    .map((t) => (t as { name?: string })?.name ?? '?');
  if (unknown.length)
    throw new HttpError(400, `not one of this union's clubs: ${unknown.slice(0, 5).join(', ')}`, {
      code: 'unknown_team',
    });
  return spec;
}

/** Every series of a competition, groups first (in order) then the knockout. */
export function seriesOfCompetition(all: Series[], id: string): CompetitionSeries[] {
  const rank = (s: CompetitionSeries) => (s.competition?.role === 'knockout' ? 1 : 0);
  return (all as CompetitionSeries[])
    .filter((s) => s.competition?.id === id)
    .sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id)));
}

type Fixture = {
  id: string;
  home?: string;
  away?: string;
  status?: string;
  round?: number;
  date?: string;
};

/** The series' fixtures with their CURRENT results joined (cleared ones dropped). */
export function withResults(
  s: Series,
  results: StoredFixtureResult[],
): Array<Fixture & { result: ReturnType<typeof toResultView> }> {
  const mine = new Map(
    results.filter((r) => r.seriesId === s.id).map((r) => [r.fixtureId, toResultView(r)]),
  );
  return ((s.fixtures as Fixture[]) ?? []).map((f) => ({ ...f, result: mine.get(f.id) ?? null }));
}

export interface SeriesTable {
  seriesId: string;
  label: string;
  /** Every fixture between real teams is played (or cancelled). */
  complete: boolean;
  played: number;
  total: number;
  rows: StandingRow[];
}

/** The league table of one series, by its competition's points (cricket default otherwise). */
export function seriesTable(s: CompetitionSeries, results: StoredFixtureResult[]): SeriesTable {
  const fixtures = withResults(s, results).sort(
    (a, b) => (a.round ?? 0) - (b.round ?? 0) || (a.date ?? '').localeCompare(b.date ?? ''),
  );
  const real = fixtures.filter(
    (f) => f.home && f.away && !isSlotRef(f.home) && !isSlotRef(f.away) && f.status !== 'cancelled',
  );
  const played = real.filter((f) => f.result).length;
  const teams = (
    s.participants?.length
      ? s.participants.map((p) => ({ teamId: p.teamId, name: p.name }))
      : (s.teams ?? []).map((t) => ({ teamId: t, name: t }))
  ) as Array<{ teamId: string; name: string }>;
  return {
    seriesId: String(s.id),
    label: s.competition?.groupLabel ?? String(s.name),
    complete: real.length > 0 && played === real.length,
    played,
    total: real.length,
    rows: computeStandings({
      teams,
      fixtures: fixtures.map((f) => ({ ...f, result: f.result ?? null })),
      points: s.competition?.points,
      maxOvers: typeof s.maxOvers === 'number' ? s.maxOvers : undefined,
    }),
  };
}

/** Fill a competition's knockout from its group tables and its own results (engine). */
export function advanceCompetition(
  series: CompetitionSeries[],
  results: StoredFixtureResult[],
  opts: { allowIncomplete?: boolean } = {},
) {
  const ko = series.find((s) => s.competition?.role === 'knockout');
  if (!ko) throw new HttpError(409, 'this competition has no knockout', { code: 'no_knockout' });
  const groups = new Map<string, { complete: boolean; order: string[] }>();
  for (const s of series.filter((x) => x.competition?.role === 'group')) {
    const t = seriesTable(s, results);
    groups.set(String(s.id), { complete: t.complete, order: t.rows.map((r) => r.teamId) });
  }
  return { ko, ...advanceKnockout(withResults(ko, results), groups, opts) };
}

/** "Group A" / "Knockout" / the name — how a series reads within its competition. */
export const competitionSeriesName = (name: string, meta: CompetitionMeta) =>
  meta.role === 'group' && meta.groupLabel
    ? `${name} · ${meta.groupLabel}`
    : meta.role === 'knockout' && meta.format.kind === 'groups-knockout'
      ? `${name} · Knockout`
      : name;

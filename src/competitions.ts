/**
 * Leagues & tournaments as the office sees them (ADR 0018). Pure.
 *
 * Every series belongs to one row of the competitions table:
 *   - a league/tournament created here  → all series sharing `competition.id`;
 *   - a season run set up by the operator → all series sharing `seasonRunId`;
 *   - anything else (an imported schedule, a stand-alone series) → the series on its own.
 * Plus the views of one series: the league table (engine `computeStandings`, the same
 * function the API's standings route uses), the results matrix and the home/away matrix.
 */
import type { CompetitionMeta } from '../packages/engine/src/competition';
import { isSlotRef, slotRefLabel } from '../packages/engine/src/formats';
import { computeStandings, type StandingRow } from '../packages/engine/src/standings';
import { seriesOrigin } from './season-run';
import type { Series } from './types';

export interface CmpFixture {
  id: string;
  round?: number;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  status?: string;
  dateTbc?: boolean;
  slots?: { home?: string; away?: string };
  result?: {
    homeScore?: string | null;
    awayScore?: string | null;
    winner?: 'home' | 'away' | 'tie' | 'none' | null;
    method?: string | null;
    noResult?: boolean;
    summary?: string | null;
  } | null;
}

export interface CmpSeries {
  id: string;
  name: string;
  startDate?: string;
  endDate?: string;
  teams?: string[];
  participants?: Array<{ teamId: string; clubId?: string; name: string; venue?: string }>;
  fixtures: unknown[];
  released?: boolean;
  approved?: boolean;
  maxOvers?: unknown;
  seriesType?: unknown;
  leagueKey?: unknown;
  seasonRunId?: string;
  schedule?: unknown;
  competition?: CompetitionMeta;
}

export interface CmpRun {
  id: string;
  leagueKey: string;
  seasonLabel: string;
}

export type CompetitionKind = 'competition' | 'season' | 'series';

export interface CompetitionGroup {
  key: string;
  kind: CompetitionKind;
  name: string;
  /** "League", "Tournament", "Season", "Imported schedule", "Stand-alone series". */
  typeLabel: string;
  formatLabel: string;
  meta?: CompetitionMeta;
  series: CmpSeries[];
  teams: number;
  fixtures: number;
  played: number;
  firstDate?: string;
  lastDate?: string;
  status: 'Draft' | 'Approved' | 'Released' | 'Partly released';
}

const fxOf = (s: CmpSeries) => (s.fixtures as CmpFixture[]) ?? [];
const real = (f: CmpFixture) => !!f.home && !!f.away && !isSlotRef(f.home) && !isSlotRef(f.away);

export function formatLabel(meta: CompetitionMeta | undefined, s: CmpSeries): string {
  const overs = typeof s.maxOvers === 'number' ? ` · ${s.maxOvers} overs` : '';
  if (!meta) return `${typeof s.seriesType === 'string' ? s.seriesType : 'Series'}`;
  const f = meta.format;
  if (f.kind === 'round-robin')
    return `Round robin${f.legs === 2 ? ', home and away' : ''}${overs}`;
  if (f.kind === 'knockout') return `Knockout${f.thirdPlace ? ' + 3rd place' : ''}${overs}`;
  return `${f.groups} groups → knockout (top ${f.qualifiers})${overs}`;
}

export function groupCompetitions(
  all: CmpSeries[],
  runs: CmpRun[] = [],
  leagueLabel: (key: string) => string = (k) => k,
): CompetitionGroup[] {
  const groups = new Map<string, CompetitionGroup>();
  const add = (
    key: string,
    init: () => Omit<CompetitionGroup, 'series' | 'teams' | 'fixtures' | 'played' | 'status'>,
    s: CmpSeries,
  ) => {
    const g =
      groups.get(key) ??
      ({
        ...init(),
        series: [],
        teams: 0,
        fixtures: 0,
        played: 0,
        status: 'Draft',
      } as CompetitionGroup);
    g.series.push(s);
    groups.set(key, g);
  };
  for (const s of all) {
    if (s.competition?.id) {
      const m = s.competition;
      add(
        `c:${m.id}`,
        () => ({
          key: `c:${m.id}`,
          kind: 'competition',
          name: m.name,
          typeLabel: m.type === 'tournament' ? 'Tournament' : 'League',
          formatLabel: formatLabel(m, s),
          meta: m,
        }),
        s,
      );
    } else if (s.seasonRunId) {
      const run = runs.find((r) => r.id === s.seasonRunId);
      add(
        `r:${s.seasonRunId}`,
        () => ({
          key: `r:${s.seasonRunId}`,
          kind: 'season',
          name: run ? `${leagueLabel(run.leagueKey)} · ${run.seasonLabel}` : s.name,
          typeLabel: 'Season',
          formatLabel: formatLabel(undefined, s),
        }),
        s,
      );
    } else
      add(
        `s:${s.id}`,
        () => ({
          key: `s:${s.id}`,
          kind: 'series',
          name: s.name,
          // The same rule as the series origin pill (season-run.tsx).
          typeLabel:
            seriesOrigin(s as unknown as Series) === 'imported'
              ? 'Imported schedule'
              : 'Stand-alone series',
          formatLabel: formatLabel(undefined, s),
        }),
        s,
      );
  }
  for (const g of groups.values()) {
    const teams = new Set<string>();
    const dates: string[] = [];
    for (const s of g.series) {
      for (const t of s.teams ?? []) if (!isSlotRef(t)) teams.add(t);
      for (const f of fxOf(s)) {
        g.fixtures++;
        if (f.result) g.played++;
        if (f.date && !f.dateTbc) dates.push(f.date);
      }
    }
    dates.sort();
    g.teams = teams.size;
    g.firstDate = dates[0];
    g.lastDate = dates[dates.length - 1];
    const rel = g.series.filter((s) => s.released).length;
    g.status =
      rel === g.series.length
        ? 'Released'
        : rel > 0
          ? 'Partly released'
          : g.series.every((s) => s.approved)
            ? 'Approved'
            : 'Draft';
    // Groups first, then the knockout.
    g.series.sort(
      (a, b) =>
        (a.competition?.role === 'knockout' ? 1 : 0) -
          (b.competition?.role === 'knockout' ? 1 : 0) || a.id.localeCompare(b.id),
    );
  }
  const order: Record<CompetitionKind, number> = { competition: 0, season: 1, series: 2 };
  return [...groups.values()].sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      (b.firstDate ?? '').localeCompare(a.firstDate ?? '') ||
      a.name.localeCompare(b.name),
  );
}

/** Team id → name for a series (participants, else the clubs). */
export function teamNames(s: CmpSeries, clubName: (id: string) => string | undefined) {
  const m = new Map<string, string>();
  for (const p of s.participants ?? []) m.set(p.teamId, p.name);
  for (const t of s.teams ?? []) if (!m.has(t)) m.set(t, clubName(t) ?? t);
  return m;
}

/** A side's display name: the team, or the slot it waits on ("Group A – 1st"). */
export function sideName(
  id: string | undefined,
  names: Map<string, string>,
  fixtures: CmpFixture[],
) {
  if (!id) return 'To be decided';
  if (isSlotRef(id))
    return slotRefLabel(id, fixtures as Array<{ id: string; round: number }>) ?? 'To be decided';
  return names.get(id) ?? id;
}

/** The league table of one series, from its joined results. */
export function seriesStandings(s: CmpSeries, names: Map<string, string>): StandingRow[] {
  const fixtures = [...fxOf(s)].sort(
    (a, b) => (a.round ?? 0) - (b.round ?? 0) || (a.date ?? '').localeCompare(b.date ?? ''),
  );
  const teams = [...names]
    .filter(([id]) => !isSlotRef(id))
    .map(([teamId, name]) => ({ teamId, name }));
  return computeStandings({
    teams,
    fixtures: fixtures.map((f) => ({ ...f, id: f.id, result: f.result ?? null })),
    points: s.competition?.points,
    maxOvers: typeof s.maxOvers === 'number' ? s.maxOvers : undefined,
  });
}

export interface MatrixCell {
  fixture: CmpFixture;
  /** "160/5 v 120/9", "No result", or "R3 · 17 Oct". */
  label: string;
  /** Who won, from the row (home) team's side. */
  outcome: 'won' | 'lost' | 'tie' | 'nr' | 'upcoming' | 'off';
}

/**
 * Results matrix: row = home team, column = away team, cell = the result (or when it's
 * scheduled). Two legs ⇒ each ordered pair is its own cell. Only real teams.
 */
export function resultsMatrix(s: CmpSeries, names: Map<string, string>) {
  const ids = [...names.keys()].filter((id) => !isSlotRef(id));
  const cells = new Map<string, MatrixCell>();
  const shortDate = (d?: string) =>
    d
      ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        })
      : 'TBC';
  for (const f of fxOf(s)) {
    if (!real(f)) continue;
    const r = f.result;
    let label: string;
    let outcome: MatrixCell['outcome'];
    if (f.status === 'cancelled' || f.status === 'postponed') {
      label = f.status === 'cancelled' ? 'Cancelled' : 'Postponed';
      outcome = 'off';
    } else if (!r) {
      label = `R${f.round ?? '?'} · ${shortDate(f.date)}`;
      outcome = 'upcoming';
    } else if (r.noResult || r.winner === 'none') {
      label = 'No result';
      outcome = 'nr';
    } else {
      label = `${r.homeScore ?? '–'} v ${r.awayScore ?? '–'}`;
      outcome = r.winner === 'home' ? 'won' : r.winner === 'away' ? 'lost' : 'tie';
    }
    cells.set(`${f.home}|${f.away}`, { fixture: f, label, outcome });
  }
  return { ids, cells };
}

/** Home/away balance: per team, games at home, away, and the difference. */
export function homeAwayBalance(s: CmpSeries, names: Map<string, string>) {
  const rows = new Map<string, { teamId: string; name: string; home: number; away: number }>();
  for (const [teamId, name] of names)
    if (!isSlotRef(teamId)) rows.set(teamId, { teamId, name, home: 0, away: 0 });
  for (const f of fxOf(s)) {
    if (!real(f) || f.status === 'cancelled') continue;
    const h = rows.get(f.home!);
    const a = rows.get(f.away!);
    if (h) h.home++;
    if (a) a.away++;
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

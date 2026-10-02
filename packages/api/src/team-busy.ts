/**
 * Same-day team-busy detection — the server-side twin of the allocator ledger's `teamBusy`
 * (packages/engine/src/venues.ts `buildLedger`). Used by the fixture-postponement accept path
 * and the rep-safe clash hints (ADR 0015), beside the ground-clash engine in venue-clash.ts,
 * which only knows about grounds.
 *
 * Semantics mirror `buildLedger().teamBusy` exactly:
 *  - a side is identified by its series team id — a clubId for a single-team club (legacy series
 *    and modern single-team participants alike), a `tm_…` id for one of a multi-team club's
 *    sides. Team ids are stable across series (they come from the club's own team roster), so the
 *    same side in two competitions shares one ledger row; two different sides of a multi-team
 *    club do not;
 *  - a timed booking occupies its slot; an untimed one owns the whole day. A timed question is
 *    busy on the same slot or any untimed booking; an untimed question is busy on any booking;
 *  - knockout forward references (`win:f3`) are not sides and never book or report busy.
 * One deliberate difference: a `cancelled` fixture books nothing (as in `findClashes`), since a
 * cancelled match does not occupy anyone. A `postponed` fixture books its (rescheduled) date.
 */
import type { Series } from './types.js';
import { isSlotRef } from '../../engine/src/formats.js';

interface LedgerFixture {
  id?: string;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  status?: string;
}

/** The booking a busy side already holds that day — what the accept path reports back. */
export interface TeamBusyHit {
  teamId: string;
  seriesId: string;
  fixtureId: string;
  date: string;
  time?: string;
}

/** A fixture to leave out of the ledger — the one being moved must not block itself. */
export interface FixtureRef {
  seriesId: string;
  fixtureId: string;
}

export class TeamLedger {
  private byTeamDate = new Map<string, TeamBusyHit[]>();

  constructor(series: Series[], opts: { exclude?: FixtureRef } = {}) {
    for (const s of series) {
      for (const f of (s.fixtures as LedgerFixture[]) ?? []) {
        if (!f?.date || f.status === 'cancelled') continue;
        if (
          opts.exclude &&
          String(s.id) === opts.exclude.seriesId &&
          f.id === opts.exclude.fixtureId
        )
          continue;
        for (const side of [f.home, f.away]) {
          if (!side || isSlotRef(side)) continue;
          const key = `${side}|${f.date}`;
          const list = this.byTeamDate.get(key) ?? [];
          list.push({
            teamId: side,
            seriesId: String(s.id),
            fixtureId: f.id ?? '',
            date: f.date,
            ...(f.time ? { time: f.time } : {}),
          });
          this.byTeamDate.set(key, list);
        }
      }
    }
  }

  /** The booking that makes `teamId` busy on `date` (at `time`, if given), or undefined. */
  busy(teamId: string | undefined, date: string, time?: string): TeamBusyHit | undefined {
    if (!teamId || isSlotRef(teamId)) return undefined;
    const entries = this.byTeamDate.get(`${teamId}|${date}`);
    if (!entries || entries.length === 0) return undefined;
    if (!time) return entries[0];
    return entries.find((e) => !e.time || e.time === time);
  }
}

/**
 * Would moving a fixture to `date`/`time` put either side on a day (and slot) it already plays?
 * `series` is the set to check against (the caller picks it — e.g. released series only); the
 * moved fixture itself is excluded. Returns the hit per side (undefined when free).
 */
export function findTeamBusy(
  series: Series[],
  moved: FixtureRef & { home?: string; away?: string },
  date: string,
  time?: string,
): { home?: TeamBusyHit; away?: TeamBusyHit } {
  const ledger = new TeamLedger(series, {
    exclude: { seriesId: moved.seriesId, fixtureId: moved.fixtureId },
  });
  const home = ledger.busy(moved.home, date, time);
  const away = ledger.busy(moved.away, date, time);
  return { ...(home ? { home } : {}), ...(away ? { away } : {}) };
}

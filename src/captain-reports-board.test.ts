import { describe, it, expect } from 'vitest';
import { umpireAvg, umpireSummary } from './captain-reports-board';
import type { CaptainReport } from './types';

const r = (v: number) => ({
  decisions: v,
  pressure: v,
  behaviour: v,
  communication: v,
  regulations: v,
});

const report = (id: string, a: [string, number, string[]], b: [string, number, string[]]) =>
  ({
    id,
    ref: `CR-2026-${id}`,
    clubId: 'c1',
    clubName: 'Club One',
    date: '2026-09-27',
    side: 'Home',
    opponent: 'Club Two',
    captain: 'Sam Captain',
    umpires: [a, b].map(([name, v, concerns]) => ({ name, ratings: r(v), concerns })),
    submittedAt: '2026-09-27T18:00:00.000Z',
    submittedBy: 'rep@test',
  }) as CaptainReport;

describe("captain's reports board", () => {
  it('averages the five criteria for an umpire', () => {
    expect(umpireAvg({ name: 'X', ratings: { ...r(4), decisions: 2 }, concerns: [] })).toBe(3.6);
  });

  it('rolls reports up per umpire (names matched case-insensitively)', () => {
    const rows = umpireSummary([
      report('1', ['Ann Umpire', 4, ['lbw']], ['Ben Umpire', 2, ['noBallWide', 'lbw']]),
      report('2', ['ann umpire', 2, ['lbw']], ['Cal Umpire', 5, []]),
    ]);
    const ann = rows.find((x) => x.name.toLowerCase() === 'ann umpire')!;
    expect(ann.reports).toBe(2);
    expect(ann.avg).toBe(3);
    expect(ann.crit.decisions).toBe(3);
    expect(ann.concerns[0]).toEqual(['lbw', 2]);
    // Most-reported first; ties broken by the lower average.
    expect(rows.map((x) => x.reports)).toEqual([2, 1, 1]);
    expect(rows[1].name).toBe('Ben Umpire');
  });
});

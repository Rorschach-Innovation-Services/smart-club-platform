import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  applyRosterDecision,
  buildClubSummaries,
  committableCounts,
  detectCrossClubDuplicates,
  isDuplicateGroupResolved,
  rosterRowKey,
  type ClubParseState,
  type CrossClubDuplicateGroup,
  type DuplicateCandidateRow,
  type RosterCommittableRow,
  type RosterDecisions,
} from './roster-review';
import type { RosterIntakeParseResponse } from './types';

describe('buildClubSummaries', () => {
  const parseableStandard: RosterIntakeParseResponse = {
    parseable: true,
    sheets: [
      {
        name: 'Seniors',
        skipped: false,
        hasIdColumn: true,
        totalDataRows: 3,
        rows: [
          { rowNumber: 2, firstName: 'A', lastName: 'B', dob: '2000-01-01', missingId: false },
          { rowNumber: 3, firstName: 'C', lastName: 'D', dob: '2001-01-01', missingId: false },
        ],
        exceptions: [{ rowNumber: 4, sheet: 'Seniors', reason: 'bad-checksum' }],
        unknownGenderRaw: ['?'],
        unknownRaceRaw: [],
      },
    ],
    dobOnlyCount: 0,
    juniorLeagueKeys: ['u9'],
    ageGroupRaws: [],
  };

  const parseableDobVariant: RosterIntakeParseResponse = {
    parseable: true,
    sheets: [
      {
        name: 'Juniors',
        skipped: false,
        hasIdColumn: false,
        totalDataRows: 2,
        rows: [{ rowNumber: 2, firstName: 'E', lastName: 'F', dob: '2010-01-01', missingId: true }],
        exceptions: [{ rowNumber: 3, sheet: 'Juniors', reason: 'missing-id' }],
        unknownGenderRaw: [],
        unknownRaceRaw: ['other'],
      },
    ],
    dobOnlyCount: 1,
    juniorLeagueKeys: ['u9'],
    ageGroupRaws: [{ raw: 'U9', leagueKey: 'u9' }],
  };

  it('summarizes a not-yet-parsed club as unparseable with reason not-parsed-yet', () => {
    const clubs: ClubParseState[] = [{ clubId: 'c1', clubName: 'Club One', allowMissingId: false }];
    const [summary] = buildClubSummaries(clubs);
    expect(summary.parseable).toBe(false);
    expect(summary.reason).toBe('not-parsed-yet');
    expect(summary.template).toBe('standard');
  });

  it('surfaces the server unparseable reason (e.g. a PDF/scan)', () => {
    const clubs: ClubParseState[] = [
      {
        clubId: 'c1',
        clubName: 'Club One',
        allowMissingId: false,
        parse: { parseable: false, reason: 'unsupported-format' },
      },
    ];
    const [summary] = buildClubSummaries(clubs);
    expect(summary.parseable).toBe(false);
    expect(summary.reason).toBe('unsupported-format');
  });

  it('classifies a club with an ID column as the standard template', () => {
    const clubs: ClubParseState[] = [
      { clubId: 'c1', clubName: 'Club One', allowMissingId: false, parse: parseableStandard },
    ];
    const [summary] = buildClubSummaries(clubs);
    expect(summary.template).toBe('standard');
    expect(summary.totalDataRows).toBe(3);
    expect(summary.validRowCount).toBe(2);
    expect(summary.exceptionsByReason).toEqual({ 'bad-checksum': 1 });
    expect(summary.totalExceptions).toBe(1);
    expect(summary.unknownGenderRaw).toEqual(['?']);
    expect(summary.recoverableIdExceptionCount).toBe(0);
  });

  it('classifies a club whose sheets all lack an ID column as dob-variant, counting missing-id AND bad-id rows as recoverable', () => {
    const clubs: ClubParseState[] = [
      { clubId: 'c2', clubName: 'Club Two', allowMissingId: true, parse: parseableDobVariant },
    ];
    const [summary] = buildClubSummaries(clubs);
    expect(summary.template).toBe('dob-variant');
    expect(summary.dobOnlyCount).toBe(1);
    // parseableDobVariant carries one 'missing-id' exception; bad-id-only clubs (an ID
    // column present but this row's cell is unusable while a dob is present) are covered
    // by the dedicated recoverable-count test below.
    expect(summary.recoverableIdExceptionCount).toBe(1);
    expect(summary.unknownRaceRaw).toEqual(['other']);
    expect(summary.allowMissingId).toBe(true);
  });

  it('counts bad-id exceptions toward the recoverable count, not just missing-id (round-2 E2E: Adelaar read "0 missing-id rows" beside 103 bad-id rows)', () => {
    const parse: RosterIntakeParseResponse = {
      parseable: true,
      sheets: [
        {
          name: 'Seniors',
          skipped: false,
          hasIdColumn: true,
          totalDataRows: 2,
          rows: [],
          exceptions: [
            { rowNumber: 2, sheet: 'Seniors', reason: 'bad-id' },
            { rowNumber: 3, sheet: 'Seniors', reason: 'bad-id' },
          ],
          unknownGenderRaw: [],
          unknownRaceRaw: [],
        },
      ],
      dobOnlyCount: 0,
      juniorLeagueKeys: [],
      ageGroupRaws: [],
    };
    const clubs: ClubParseState[] = [
      { clubId: 'c4', clubName: 'Adelaar', allowMissingId: false, parse },
    ];
    const [summary] = buildClubSummaries(clubs);
    expect(summary.recoverableIdExceptionCount).toBe(2);
  });

  it('flags parsed junior-sheet rows with no team as an informational count, keyed on the sheet name reading as junior', () => {
    const parse: RosterIntakeParseResponse = {
      parseable: true,
      sheets: [
        {
          name: 'Junior Leagues',
          skipped: false,
          hasIdColumn: true,
          totalDataRows: 2,
          rows: [
            { rowNumber: 2, firstName: 'A', lastName: 'B', dob: '2010-01-01', missingId: false },
            { rowNumber: 3, firstName: 'C', lastName: 'D', dob: '2011-01-01', missingId: false },
          ],
          exceptions: [],
          unknownGenderRaw: [],
          unknownRaceRaw: [],
        },
        {
          name: 'Seniors',
          skipped: false,
          hasIdColumn: true,
          totalDataRows: 1,
          rows: [
            { rowNumber: 2, firstName: 'E', lastName: 'F', dob: '1990-01-01', missingId: false },
          ],
          exceptions: [],
          unknownGenderRaw: [],
          unknownRaceRaw: [],
        },
      ],
      dobOnlyCount: 0,
      juniorLeagueKeys: [],
      ageGroupRaws: [],
    };
    const clubs: ClubParseState[] = [
      { clubId: 'c5', clubName: 'Adelaar', allowMissingId: false, parse },
    ];
    const [summary] = buildClubSummaries(clubs);
    // Both Junior Leagues rows have no team (no age-band column at all); the Seniors
    // sheet's team-less row is NOT counted — it isn't a junior-named sheet.
    expect(summary.juniorRowsWithoutTeamCount).toBe(2);
  });

  it('does not classify a club with only skipped/empty sheets as dob-variant', () => {
    const clubs: ClubParseState[] = [
      {
        clubId: 'c3',
        clubName: 'Club Three',
        allowMissingId: false,
        parse: {
          parseable: true,
          sheets: [
            {
              name: 'Empty',
              skipped: true,
              hasIdColumn: false,
              totalDataRows: 0,
              rows: [],
              exceptions: [],
              unknownGenderRaw: [],
              unknownRaceRaw: [],
            },
          ],
          dobOnlyCount: 0,
          juniorLeagueKeys: [],
          ageGroupRaws: [],
        },
      },
    ];
    const [summary] = buildClubSummaries(clubs);
    expect(summary.template).toBe('standard');
  });
});

describe('detectCrossClubDuplicates', () => {
  it('groups rows sharing an id-based identity across clubs, ignores single-club repeats', () => {
    const rows: DuplicateCandidateRow[] = [
      {
        clubId: 'a',
        clubName: 'A',
        firstName: 'Sipho',
        lastName: 'Dlamini',
        dob: '1998-03-14',
        idNumber: '9803145012083',
      },
      {
        clubId: 'b',
        clubName: 'B',
        firstName: 'Sipho',
        lastName: 'Dlamini',
        dob: '1998-03-14',
        idNumber: '9803145012083',
      },
      {
        clubId: 'a',
        clubName: 'A',
        firstName: 'Thabo',
        lastName: 'Nkosi',
        dob: '2001-11-23',
        idNumber: '0111235398086',
      },
      {
        clubId: 'a',
        clubName: 'A',
        firstName: 'Thabo',
        lastName: 'Nkosi',
        dob: '2001-11-23',
        idNumber: '0111235398086',
      },
    ];
    const groups = detectCrossClubDuplicates(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[0].rows.map((r) => r.clubId).sort()).toEqual(['a', 'b']);
  });

  it('never pairs an id-based identity with a dob-only identity for the same name+dob', () => {
    const rows: DuplicateCandidateRow[] = [
      {
        clubId: 'a',
        clubName: 'A',
        firstName: 'Naledi',
        lastName: 'Sithole',
        dob: '2009-05-18',
        idNumber: '0905180634082',
      },
      { clubId: 'b', clubName: 'B', firstName: 'Naledi', lastName: 'Sithole', dob: '2009-05-18' },
    ];
    expect(detectCrossClubDuplicates(rows)).toHaveLength(0);
  });

  it('groups a dob-only identity shared across clubs', () => {
    const rows: DuplicateCandidateRow[] = [
      { clubId: 'a', clubName: 'A', firstName: 'Lerato', lastName: 'Mokoena', dob: '2011-07-02' },
      { clubId: 'c', clubName: 'C', firstName: 'Lerato', lastName: 'Mokoena', dob: '2011-07-02' },
    ];
    const groups = detectCrossClubDuplicates(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(2);
  });

  it('supports N-way conflicts (three clubs claiming one identity)', () => {
    const rows: DuplicateCandidateRow[] = [
      {
        clubId: 'a',
        clubName: 'A',
        firstName: 'Zanele',
        lastName: 'Mahlangu',
        dob: '1997-12-05',
        idNumber: '9712050487088',
      },
      {
        clubId: 'b',
        clubName: 'B',
        firstName: 'Zanele',
        lastName: 'Mahlangu',
        dob: '1997-12-05',
        idNumber: '9712050487088',
      },
      {
        clubId: 'c',
        clubName: 'C',
        firstName: 'Zanele',
        lastName: 'Mahlangu',
        dob: '1997-12-05',
        idNumber: '9712050487088',
      },
    ];
    const groups = detectCrossClubDuplicates(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(3);
  });

  /**
   * Parity fixture (shared-fixtures/cross-club-duplicates.json): the server suite
   * (packages/api/src/roster-parse.test.ts or equivalent) MUST assert the exact
   * same expectedConflictGroups against findCrossClubDuplicates. Any divergence
   * between the two hand-ported implementations fails one of the two suites.
   */
  it('matches the shared parity fixture exactly', () => {
    const fixturePath = fileURLToPath(
      new URL('../shared-fixtures/cross-club-duplicates.json', import.meta.url),
    );
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      rows: DuplicateCandidateRow[];
      expectedConflictGroups: number[][];
    };
    const indexed = fixture.rows.map((r, idx) => ({ ...r, idx }));
    const groups = detectCrossClubDuplicates(indexed);
    const actual = groups.map((g) => g.rows.map((r) => r.idx).sort((a, b) => a - b));
    const expected = fixture.expectedConflictGroups.map((g) => [...g].sort((a, b) => a - b));

    // Order-independent set-of-groups comparison.
    const norm = (gs: number[][]) => gs.map((g) => JSON.stringify(g)).sort();
    expect(norm(actual)).toEqual(norm(expected));
  });
});

describe('applyRosterDecision', () => {
  it('records an explicit include/exclude for one row', () => {
    let state: RosterDecisions = {};
    state = applyRosterDecision(state, { type: 'exclude', key: 'k1' });
    expect(state.k1).toBe('exclude');
    state = applyRosterDecision(state, { type: 'include', key: 'k1' });
    expect(state.k1).toBe('include');
  });

  it('keep-only keeps exactly one row of a group and excludes the rest', () => {
    let state: RosterDecisions = {};
    state = applyRosterDecision(state, {
      type: 'keep-only',
      groupKeys: ['a', 'b', 'c'],
      keep: 'b',
    });
    expect(state).toEqual({ a: 'exclude', b: 'include', c: 'exclude' });
  });

  it('exclude-group excludes every row in the group', () => {
    let state: RosterDecisions = {};
    state = applyRosterDecision(state, { type: 'exclude-group', groupKeys: ['a', 'b'] });
    expect(state).toEqual({ a: 'exclude', b: 'exclude' });
  });

  it('never mutates the input map', () => {
    const state: RosterDecisions = { a: 'include' };
    const next = applyRosterDecision(state, { type: 'exclude', key: 'a' });
    expect(state.a).toBe('include');
    expect(next.a).toBe('exclude');
    expect(next).not.toBe(state);
  });
});

describe('isDuplicateGroupResolved / committableCounts', () => {
  type Row = RosterCommittableRow & DuplicateCandidateRow;
  const rowA: Row = {
    clubId: 'a',
    sheet: 'S',
    rowNumber: 1,
    clubName: 'A',
    firstName: 'X',
    lastName: 'Y',
    dob: '2000-01-01',
    idNumber: '1',
  };
  const rowB: Row = {
    clubId: 'b',
    sheet: 'S',
    rowNumber: 1,
    clubName: 'B',
    firstName: 'X',
    lastName: 'Y',
    dob: '2000-01-01',
    idNumber: '1',
  };
  const group: CrossClubDuplicateGroup<Row> = { identityKey: 'id:1', rows: [rowA, rowB] };

  it('a group with no decisions recorded is unresolved even though rows default to included', () => {
    expect(isDuplicateGroupResolved(group, {})).toBe(false);
  });

  it('a group is resolved once every row has an explicit decision', () => {
    const decisions: RosterDecisions = {
      [rosterRowKey('a', 'S', 1)]: 'include',
      [rosterRowKey('b', 'S', 1)]: 'exclude',
    };
    expect(isDuplicateGroupResolved(group, decisions)).toBe(true);
  });

  it('committableCounts zeroes committable while any duplicate group is unresolved', () => {
    const rows: RosterCommittableRow[] = [rowA, rowB];
    const counts = committableCounts(rows, {}, [group]);
    expect(counts.totalRows).toBe(2);
    expect(counts.includedRows).toBe(2); // both default to included
    expect(counts.unresolvedDuplicateGroups).toBe(1);
    expect(counts.committable).toBe(0);
  });

  it('committableCounts counts committable once the group is resolved', () => {
    const rows: RosterCommittableRow[] = [rowA, rowB];
    const decisions = applyRosterDecision(
      {},
      {
        type: 'keep-only',
        groupKeys: [rosterRowKey('a', 'S', 1), rosterRowKey('b', 'S', 1)],
        keep: rosterRowKey('a', 'S', 1),
      },
    );
    const counts = committableCounts(rows, decisions, [group]);
    expect(counts.unresolvedDuplicateGroups).toBe(0);
    expect(counts.includedRows).toBe(1);
    expect(counts.committable).toBe(1);
  });

  it('excluded rows via plain include/exclude are reflected without any duplicate group', () => {
    const rows: RosterCommittableRow[] = [
      { clubId: 'a', sheet: 'S', rowNumber: 1 },
      { clubId: 'a', sheet: 'S', rowNumber: 2 },
    ];
    const decisions: RosterDecisions = { [rosterRowKey('a', 'S', 2)]: 'exclude' };
    const counts = committableCounts(rows, decisions, []);
    expect(counts.includedRows).toBe(1);
    expect(counts.excludedRows).toBe(1);
    expect(counts.committable).toBe(1);
  });
});

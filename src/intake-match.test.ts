import { describe, it, expect } from 'vitest';
import type { RequiredDoc } from './types';
import {
  normalise,
  baseStem,
  isJunkFile,
  buildClubIndex,
  matchClub,
  matchDoc,
  findDuplicates,
  findConflicts,
  flagExistingDocs,
  buildRows,
  committableRows,
  MAX_INTAKE_BYTES,
  type IntakeFile,
  type IntakeRow,
} from './intake-match';

// A Titans-shaped pack: folder-per-club, messy real-world file names.
const CLUBS = [
  { id: 'pretoria-cricket-club', name: 'Pretoria Cricket Club' },
  { id: 'pretoria-east-cricket-club', name: 'Pretoria East Cricket Club' },
  { id: 'phsob-cricket-club', name: 'PHSOB Cricket Club' },
  { id: 'hammanskraal-cricket-club', name: 'Hammanskraal Cricket Club' },
  { id: 'differently-abled-cricket-club', name: 'Differently Abled Cricket Club' },
];

const DOCS: RequiredDoc[] = [
  {
    key: 'leagueEntry',
    name: 'Club League Entry',
    accepts: ['pdf', 'xls', 'xlsx'],
    matchHints: ['league entry'],
  },
  { key: 'healthTracker', name: 'Club Health Tracker', matchHints: ['health tracker'] },
  { key: 'memberDatabase', name: 'Member Database', matchHints: ['database', 'databse'] },
  {
    key: 'facilityAgreement',
    name: 'Facility Agreements',
    multiFile: true,
    minFiles: 1,
    matchHints: ['lease', 'mou', 'facility', 'field agreement'],
  },
  { key: 'committee', name: 'Club Committee', matchHints: ['committee'] },
  { key: 'retired', name: 'Retired Thing', archived: true, matchHints: ['retired'] },
  { key: 'exco', name: 'Exco Reps', kind: 'form' },
];

const index = buildClubIndex(CLUBS);

const file = (segments: string[], name: string, size = 1000): IntakeFile => ({
  id: `${segments.join('/')}/${name}`,
  segments,
  name,
  size,
  mime: 'application/pdf',
});

describe('normalise / baseStem', () => {
  it('drops generic club words but keeps distinguishing ones', () => {
    expect(normalise('Pretoria Cricket Club')).toBe('pretoria');
    // "East" is what separates two real clubs — it must survive.
    expect(normalise('Pretoria East Cricket Club')).toBe('pretoriaeast');
    expect(normalise('CBC Old Boys (CBCOB)')).toBe('cbcoldboyscbcob');
  });

  it('strips copy markers and extensions from a stem', () => {
    expect(baseStem('MOU IVCC and Southdowns (1).pdf')).toBe('MOU IVCC and Southdowns');
    expect(baseStem('2026-27 Club League Entry - Copy.xls')).toBe('2026-27 Club League Entry');
    expect(baseStem('Club Health Tracker 2026-2027.xlsx')).toBe('Club Health Tracker 2026-2027');
  });

  it('recognises archive/OS junk anywhere in the path', () => {
    expect(isJunkFile({ name: '.DS_Store' })).toBe(true);
    expect(isJunkFile({ name: 'a.pdf', segments: ['__MACOSX', 'TUKS'] })).toBe(true);
    expect(isJunkFile({ name: 'Constitution.pdf', segments: ['TUKS'] })).toBe(false);
  });
});

describe('matchClub', () => {
  it('matches an exact normalised name', () => {
    const { club, confidence } = matchClub('Pretoria Cricket Club', index);
    expect(club?.id).toBe('pretoria-cricket-club');
    expect(confidence).toBe(1);
  });

  it('does not collapse a longer club onto a shorter one', () => {
    // The bug this guards: "Pretoria East" folder landing on Pretoria CC.
    expect(matchClub('Pretoria East', index).club?.id).toBe('pretoria-east-cricket-club');
    expect(matchClub('Pretoria', index).club?.id).toBe('pretoria-cricket-club');
  });

  it('matches a bare acronym folder against the full club name', () => {
    expect(matchClub('PHSOB', index).club?.id).toBe('phsob-cricket-club');
  });

  it('rescues a one- or two-character misspelling', () => {
    // Real typo from the Titans league sheet.
    const { club, confidence } = matchClub('HAMMNASKRAAL', index);
    expect(club?.id).toBe('hammanskraal-cricket-club');
    expect(confidence).toBeLessThan(1);
  });

  it('returns unmatched for an alias only a human could know', () => {
    // "DACC" → Differently Abled Cricket Club is knowledge, not string distance:
    // the matcher must decline rather than guess.
    expect(matchClub('DACC', index).club).toBeNull();
    expect(matchClub('', index).club).toBeNull();
  });
});

describe('matchDoc', () => {
  it('classifies on the catalogue matchHints', () => {
    expect(matchDoc('2026-27 Club League Entry.xls', DOCS).doc?.key).toBe('leagueEntry');
    expect(matchDoc('Club Health Tracker 2026-2027.xlsx', DOCS).doc?.key).toBe('healthTracker');
    // Clients misspell consistently; the hint list is where that lives.
    expect(matchDoc('Clubs Databse sosh26.xlsx', DOCS).doc?.key).toBe('memberDatabase');
    expect(matchDoc('PHSOB Field Agreement - AvW.pdf', DOCS).doc?.key).toBe('facilityAgreement');
  });

  it('falls back to the doc name when no hints are configured', () => {
    const bare: RequiredDoc[] = [{ key: 'constitution', name: 'Club Constitution' }];
    expect(matchDoc('Adelaar Cricket Club Constitution.doc', bare).doc?.key).toBe('constitution');
  });

  it('never proposes a form or archived doc', () => {
    expect(matchDoc('Exco Reps list.pdf', DOCS).doc).toBeNull();
    expect(matchDoc('Retired Thing 2026.pdf', DOCS).doc).toBeNull();
  });

  it('returns unmatched for a file that matches nothing', () => {
    expect(matchDoc('IMG_4821.pdf', DOCS).doc).toBeNull();
  });
});

describe('duplicate and conflict detection', () => {
  const row = (over: Partial<IntakeRow>): IntakeRow => ({
    file: file(['X'], 'f.pdf'),
    clubId: 'phsob-cricket-club',
    clubConfidence: 1,
    docKey: 'facilityAgreement',
    docConfidence: 1,
    status: 'ready',
    ...over,
  });

  it('flags a "(1)" copy of the same file, keeping the first', () => {
    const rows = findDuplicates([
      row({ file: file(['X'], 'MOU Southdowns.pdf', 500) }),
      row({ file: file(['X'], 'MOU Southdowns (1).pdf', 500) }),
    ]);
    expect(rows[0].status).toBe('ready');
    expect(rows[1].status).toBe('duplicate');
  });

  it('does not collapse two genuinely different agreements', () => {
    const rows = findDuplicates([
      row({ file: file(['X'], 'MOU Southdowns.pdf', 500) }),
      row({ file: file(['X'], 'MOU Doringkloof.pdf', 900) }),
    ]);
    expect(rows.every((r) => r.status === 'ready')).toBe(true);
  });

  it('flags two files competing for one single-file doc', () => {
    const rows = findConflicts(
      [
        row({ docKey: 'healthTracker', file: file(['X'], 'Health Tracker.xlsx', 10) }),
        row({ docKey: 'healthTracker', file: file(['X'], 'QCC Health Tracker.pdf', 20) }),
      ],
      DOCS,
    );
    expect(rows[0].status).toBe('ready');
    expect(rows[1].status).toBe('conflict');
  });

  it('leaves a multi-file doc alone — many files is the point', () => {
    const rows = findConflicts(
      [
        row({ file: file(['X'], 'Lease A.pdf', 10) }),
        row({ file: file(['X'], 'Lease B.pdf', 20) }),
      ],
      DOCS,
    );
    expect(rows.every((r) => r.status === 'ready')).toBe(true);
  });
});

describe('flagExistingDocs', () => {
  const row = (over: Partial<IntakeRow>): IntakeRow => ({
    file: file(['X'], 'f.pdf'),
    clubId: 'phsob-cricket-club',
    clubConfidence: 1,
    docKey: 'healthTracker',
    docConfidence: 1,
    status: 'ready',
    ...over,
  });

  it('flags a single-file doc the club already has on record', () => {
    const hasExisting = (clubId: string, docKey: string) =>
      clubId === 'phsob-cricket-club' && docKey === 'healthTracker';
    const [r] = flagExistingDocs([row({})], DOCS, hasExisting);
    expect(r.replacesExisting).toBe(true);
    expect(r.status).toBe('ready'); // the match is fine — it's a policy flag, not a failure
    expect(r.note).toMatch(/already uploaded/i);
  });

  it('leaves a club with no existing doc alone', () => {
    const [r] = flagExistingDocs([row({})], DOCS, () => false);
    expect(r.replacesExisting).toBeFalsy();
  });

  it('never flags a multi-file doc — those accumulate, they do not get replaced', () => {
    const [r] = flagExistingDocs([row({ docKey: 'facilityAgreement' })], DOCS, () => true);
    expect(r.replacesExisting).toBeFalsy();
  });

  it('leaves unmatched/duplicate/conflict rows alone — only ready rows are candidates', () => {
    const [r] = flagExistingDocs(
      [row({ status: 'unmatched-club', clubId: null })],
      DOCS,
      () => true,
    );
    expect(r.replacesExisting).toBeFalsy();
  });

  it('clears a stale flag when re-run against a row that no longer collides', () => {
    const flagged = flagExistingDocs([row({})], DOCS, () => true);
    const cleared = flagExistingDocs(flagged, DOCS, () => false);
    expect(cleared[0].replacesExisting).toBe(false);
  });
});

describe('strategies', () => {
  const pack = [
    file(['PHSOB'], '2026-27 PHSOB Club League Entry.xls'),
    file(['PHSOB'], 'PHSOB Field Agreement - AvW.pdf'),
    file(['Pretoria East'], 'Club Health Tracker 2026-2027.xlsx'),
    file(['__MACOSX'], 'junk.pdf'),
    file(['DACC'], 'Clubs Databse.xlsx'),
  ];

  it('folder-per-club maps the folder to the club and the name to the doc', () => {
    const rows = buildRows(pack, index, DOCS, 'folder-per-club');
    expect(rows).toHaveLength(4); // junk dropped
    const entry = rows.find((r) => r.file.name.includes('League Entry'))!;
    expect(entry.clubId).toBe('phsob-cricket-club');
    expect(entry.docKey).toBe('leagueEntry');
    expect(entry.status).toBe('ready');
    // The alias-only folder needs a human.
    const dacc = rows.find((r) => r.file.segments[0] === 'DACC')!;
    expect(dacc.status).toBe('unmatched-club');
  });

  it('reads the deepest matching segment, so nesting needs no new strategy', () => {
    const nested = [file(['Tshwane Region', 'PHSOB'], 'Club Health Tracker.xlsx')];
    const [r] = buildRows(nested, index, DOCS, 'folder-per-club');
    expect(r.clubId).toBe('phsob-cricket-club');
    expect(r.status).toBe('ready');
  });

  it('flat matches the club out of the file name', () => {
    const flatPack = [file([], 'PHSOB Club Health Tracker 2026.xlsx')];
    const [r] = buildRows(flatPack, index, DOCS, 'flat');
    expect(r.clubId).toBe('phsob-cricket-club');
    expect(r.docKey).toBe('healthTracker');
  });

  it('gates oversize files before anything else', () => {
    const big = [file(['PHSOB'], 'Club Health Tracker.xlsx', MAX_INTAKE_BYTES + 1)];
    expect(buildRows(big, index, DOCS, 'folder-per-club')[0].status).toBe('too-large');
  });

  it('committableRows keeps only fully-resolved rows', () => {
    const rows = buildRows(pack, index, DOCS, 'folder-per-club');
    const ok = committableRows(rows);
    expect(ok.every((r) => r.clubId && r.docKey && r.status === 'ready')).toBe(true);
    expect(ok.length).toBeLessThan(rows.length);
  });
});

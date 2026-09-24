/**
 * Per-tenant compliance-doc behaviours that used to assume the default catalogue:
 * optional records, the affiliation-submit exco flag, the club's "unavailable"
 * declaration under mark/revert, catalogue-aware governance scoring, and the multi-file
 * cap. Pure data.ts / cqiScore.ts — the DOM surfaces have their own suites.
 */
import { describe, it, expect } from 'vitest';
import type { RequiredDoc } from './types';
import { scoreCQI } from './cqiScore';
import {
  DEFAULT_REQUIRED_DOCS,
  activeDocs,
  completionDocs,
  docsUploadedCount,
  docsAllComplete,
  docCompletion,
  cohortStats,
  overallProgress,
  affiliationSubmitDocs,
  excoIsFormDoc,
  computeMarkCompliance,
  computeRevertCompliance,
  computeDocUnavailable,
  deriveGovernance,
  effectiveAnswers,
  governanceOverrides,
  governanceSkipKeys,
  docMaxFiles,
} from './data';

// A tuskers-shaped catalogue: no exco, agmMinutes instead of agm, a memberDatabase role
// but no committee, and optional archive records.
const TUSKERS_LIKE: RequiredDoc[] = [
  { key: 'constitution', name: 'Club constitution' },
  { key: 'agmMinutes', name: 'AGM minutes', multiFile: true, minFiles: 1, maxFiles: 6 },
  { key: 'financials', name: 'Financials', allowUnavailable: true },
  { key: 'nominalRoll', name: 'Nominal roll', role: 'memberDatabase' },
  { key: 'disciplinaryRecords', name: 'Disciplinary records', optional: true },
  { key: 'clubRecords', name: 'Club records', optional: true, multiFile: true, minFiles: 1 },
];

describe('optional records', () => {
  const club = {
    docs: { constitution: true, agmMinutes: true, financials: false, nominalRoll: false },
  };

  it('stay active (listed + uploadable) but never count towards completion', () => {
    expect(activeDocs(TUSKERS_LIKE).map((d) => d.key)).toContain('disciplinaryRecords');
    expect(completionDocs(TUSKERS_LIKE).map((d) => d.key)).toEqual([
      'constitution',
      'agmMinutes',
      'financials',
      'nominalRoll',
    ]);
    expect(docsUploadedCount(club, TUSKERS_LIKE)).toBe(2);
    expect(docCompletion(club, TUSKERS_LIKE)).toBe(50);
  });

  it('a held optional record does not inflate the count; a missing one does not block', () => {
    const complete = {
      docs: {
        constitution: true,
        agmMinutes: true,
        financials: true,
        nominalRoll: true,
        disciplinaryRecords: false,
        clubRecords: true,
      },
    };
    expect(docsUploadedCount(complete, TUSKERS_LIKE)).toBe(4);
    expect(docsAllComplete(complete, TUSKERS_LIKE)).toBe(true);
    expect(docCompletion(complete, TUSKERS_LIKE)).toBe(100);
    expect(cohortStats([complete, club], TUSKERS_LIKE).docsComplete).toBe(1);
  });

  it('a catalogue of only optional records is trivially complete', () => {
    const onlyOptional: RequiredDoc[] = [{ key: 'records', name: 'Records', optional: true }];
    expect(docCompletion({ docs: {} }, onlyOptional)).toBe(100);
    expect(docsAllComplete({ docs: {} }, onlyOptional)).toBe(true);
  });

  it('overallProgress reads the optional-aware completion', () => {
    const c = { docs: club.docs, affiliation: 'not_started', players: 0, cqi: 0 };
    // p5 = 50 (2 of 4 counted docs) → (0+0+0+0+50)/5 = 10
    expect(overallProgress(c, TUSKERS_LIKE)).toBe(10);
  });

  it('default catalogue completion is unchanged (no optional docs)', () => {
    expect(completionDocs(DEFAULT_REQUIRED_DOCS)).toEqual(activeDocs(DEFAULT_REQUIRED_DOCS));
  });
});

describe('affiliation submit — docs.exco only when the catalogue has an exco form doc', () => {
  it('default catalogue: flips exco true, keeping every other doc flag', () => {
    expect(excoIsFormDoc(DEFAULT_REQUIRED_DOCS)).toBe(true);
    expect(
      affiliationSubmitDocs({ constitution: true, exco: false }, DEFAULT_REQUIRED_DOCS),
    ).toEqual({ constitution: true, exco: true });
  });

  it('a catalogue without exco: no docs in the patch at all (the server 400s unknown keys)', () => {
    expect(excoIsFormDoc(TUSKERS_LIKE)).toBe(false);
    expect(affiliationSubmitDocs({ constitution: true }, TUSKERS_LIKE)).toBeUndefined();
  });

  it('an exco that is a FILE doc, or archived, does not count as the form', () => {
    expect(affiliationSubmitDocs({}, [{ key: 'exco', name: 'Exco list' }])).toBeUndefined();
    expect(
      affiliationSubmitDocs({}, [{ key: 'exco', name: 'Exco', kind: 'form', archived: true }]),
    ).toBeUndefined();
  });
});

describe('club "unavailable" declaration vs admin mark/revert', () => {
  const at = '2026-06-15T00:00:00.000Z';
  const cat: RequiredDoc[] = [
    { key: 'financials', name: 'Financials', allowUnavailable: true },
    { key: 'fees', name: 'Fees', multiFile: true, minFiles: 2, allowUnavailable: true },
    { key: 'logo', name: 'Logo' }, // hatch withdrawn — any stored sentinel is stale
  ];

  it('revert never deletes a single-file unavailable declaration', () => {
    const club = computeDocUnavailable({ docs: {}, docMeta: {} }, 'financials', true, at, cat);
    const r = computeRevertCompliance(club, ['financials'], cat);
    expect(r.reverted).toEqual([]);
    expect(r.docs.financials).toBe(true);
    expect(r.docMeta.financials).toEqual({ unavailable: true, at });
  });

  it('revert never deletes a multi-file unavailable declaration (the pre-fix bug)', () => {
    const club = computeDocUnavailable({ docs: {}, docMeta: {} }, 'fees', true, at, cat);
    const r = computeRevertCompliance(club, ['fees'], cat);
    expect(r.reverted).toEqual([]);
    expect(r.docs.fees).toBe(true);
    expect(r.docMeta.fees).toEqual({ files: [], unavailable: true, at });
  });

  it('mark-compliant leaves a declared doc alone, so there is nothing to revert later', () => {
    const club = computeDocUnavailable({ docs: {}, docMeta: {} }, 'fees', true, at, cat);
    const m = computeMarkCompliance(club, ['fees', 'financials'], at, cat);
    expect(m.flipped).toEqual(['financials']);
    expect(m.docMeta.fees).toEqual({ files: [], unavailable: true, at });
  });

  it('revert peels only an admin markedCompliant stamped beside the declaration', () => {
    const club = {
      docs: { financials: true },
      docMeta: { financials: { unavailable: true, markedCompliant: true, at } },
    };
    const r = computeRevertCompliance(club, ['financials'], cat);
    expect(r.reverted).toEqual(['financials']);
    expect(r.docs.financials).toBe(true);
    expect(r.docMeta.financials).toEqual({ unavailable: true, at });
  });

  it('a stale sentinel (hatch withdrawn) is cleaned up by revert — back to Missing', () => {
    const club = { docs: { logo: true }, docMeta: { logo: { unavailable: true, at } } };
    const r = computeRevertCompliance(club, ['logo'], cat);
    expect(r.reverted).toEqual(['logo']);
    expect(r.docs.logo).toBe(false);
    expect(r.docMeta.logo).toBeUndefined();
  });

  it('a stale sentinel beside a real upload keeps the upload and stays complete', () => {
    const upload = { objectKey: 'c/logo.png', size: 1, uploadedAt: at };
    const club = { docs: { logo: true }, docMeta: { logo: { ...upload, unavailable: true, at } } };
    const r = computeRevertCompliance(club, ['logo'], cat);
    expect(r.docs.logo).toBe(true);
    expect(r.docMeta.logo).toEqual(upload);
  });
});

describe('governance — catalogue-aware', () => {
  const answersFor = (club, docs?: RequiredDoc[]) => effectiveAnswers(club, docs);

  it('default catalogue is byte-identical to the legacy (no-catalogue) derivation', () => {
    const clubs = [
      { docs: {}, players: 0 },
      { docs: { constitution: true, agm: true, exco: true, codeOfConduct: true }, players: 12 },
      { docs: { agm: true }, players: 3 },
      { docs: { exco: true, codeOfConduct: true }, playerCount: 1 },
    ];
    for (const c of clubs) {
      expect(deriveGovernance(c, DEFAULT_REQUIRED_DOCS)).toEqual(deriveGovernance(c));
      const a = { ...answersFor(c), vision: true, sponsors: 4 };
      expect(scoreCQI(a, governanceSkipKeys(DEFAULT_REQUIRED_DOCS))).toEqual(scoreCQI(a));
    }
    expect([...governanceSkipKeys(DEFAULT_REQUIRED_DOCS)]).toEqual([]);
    expect([...governanceSkipKeys()]).toEqual([]);
  });

  it('agmMinutes backs the AGM checks; exco-less + committee-less drops officers', () => {
    const club = { docs: { constitution: true, agmMinutes: true }, players: 5 };
    const g = deriveGovernance(club, TUSKERS_LIKE);
    expect(g.agmConducted).toBe(true);
    expect(g.agmMinutes).toBe(true);
    expect([...governanceSkipKeys(TUSKERS_LIKE)].sort()).toEqual(['codeOfConduct', 'officers']);
  });

  it('a committee-role file doc backs officers when there is no exco form', () => {
    const docs: RequiredDoc[] = [{ key: 'committeeList', name: 'Committee', role: 'committee' }];
    expect(governanceSkipKeys(docs).has('officers')).toBe(false);
    expect(deriveGovernance({ docs: { committeeList: true } }, docs).officers).toBe(true);
  });

  it('unbacked checks leave numerator AND denominator — a fully-evidenced club scores 10/10', () => {
    const club = { docs: { constitution: true, agmMinutes: true }, players: 5 };
    const skip = governanceSkipKeys(TUSKERS_LIKE);
    const gov = scoreCQI(answersFor(club, TUSKERS_LIKE), skip).byCat.governance;
    // Without renormalising, the missing codeOfConduct (1) + officers (2) would cap it at 7.
    expect(gov.earned).toBeCloseTo(10);
    expect(scoreCQI(answersFor(club, TUSKERS_LIKE)).byCat.governance.earned).toBeCloseTo(7);
  });

  it('manual overrides are preserved and still win over the derivation', () => {
    const club = {
      docs: { constitution: true, agmMinutes: true },
      cqiAnswers: { constitution: false },
    };
    expect(answersFor(club, TUSKERS_LIKE).constitution).toBe(false);
    const stored = governanceOverrides({ ...answersFor(club, TUSKERS_LIKE) }, club, TUSKERS_LIKE);
    expect(stored.constitution).toBe(false); // genuine override kept
    expect('agmMinutes' in stored).toBe(false); // equals the derivation → not persisted
  });
});

describe('docMaxFiles', () => {
  it('reads maxFiles, defaulting to the server cap of 10', () => {
    expect(docMaxFiles({ key: 'a', name: 'A', multiFile: true, maxFiles: 6 })).toBe(6);
    expect(docMaxFiles({ key: 'a', name: 'A', multiFile: true })).toBe(10);
  });
});

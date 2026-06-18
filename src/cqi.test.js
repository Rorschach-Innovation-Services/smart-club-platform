import { describe, it, expect } from 'vitest';
import { scoreCQI } from './atoms.jsx';
import {
  REQUIRED_DOCS,
  docsUploadedCount,
  docsAllComplete,
  docCompletion,
  CQI_STRUCTURE,
} from './data.jsx';

// The 'admin' section was repurposed to "Club Mandate and Objectives": all 7 old
// governance questions removed (redundant with affiliation + compliance), replaced
// by 6 forward-looking questions, three of which use a new 1–5 'rating' kind.
describe('CQI · Club Mandate and Objectives section', () => {
  const admin = CQI_STRUCTURE.find((c) => c.key === 'admin');

  it('is renamed and holds exactly the 6 new questions', () => {
    expect(admin.title).toBe('Club Mandate and Objectives');
    expect(admin.questions.map((q) => q.key)).toEqual([
      'vision',
      'ambition',
      'pathway',
      'retention',
      'accredAim',
      'coachDev',
    ]);
  });

  it('dropped every redundant legacy question', () => {
    const keys = admin.questions.map((q) => q.key);
    for (const old of [
      'constitution',
      'conduct',
      'inventory',
      'agm',
      'officers',
      'minutes',
      'playerdb',
    ])
      expect(keys).not.toContain(old);
  });

  it('scores rating questions proportionally (rating ÷ 5) and ignores orphan legacy keys', () => {
    // All three ratings at 5/5 and all three yes/no true → full section (weight 20).
    const full = scoreCQI({
      vision: true,
      pathway: true,
      accredAim: true,
      ambition: 5,
      retention: 5,
      coachDev: 5,
      // a stale answer from the old structure must not crash or contribute
      constitution: true,
    }).byCat.admin.earned;
    expect(full).toBeCloseTo(20, 5);

    // A single rating at 3/5 (pts 4) with everything else unanswered: earned within
    // the section = (3/5)*4 = 2.4 of possible 21 → (2.4/21)*20.
    const partial = scoreCQI({ ambition: 3 }).byCat.admin.earned;
    expect(partial).toBeCloseTo((2.4 / 21) * 20, 4);
  });
});

// Representation moved from percentages to raw head-counts (now an uncapped number
// input — no per-race limit). Scoring derives each race's SHARE of the counted total
// and keeps the Black African 1.5× weight. These tests pin that re-baselined
// behaviour so future changes are intentional rather than accidental.
describe('scoreCQI · representation by head-count', () => {
  const repOf = (answers) => scoreCQI(answers).byCat.representation.earned;

  it('scores each race in proportion to its share of the counted total', () => {
    // counts 7/9/5/2 → total 23. earned =
    //   min(4, 7/23·4·1.5) + min(2, 9/23·2) + min(2, 5/23·2) + min(2, 2/23·2)
    //   = 1.8261 + 0.7826 + 0.4348 + 0.1739 ≈ 3.217 (section weight 10, possible 10)
    const earned = repOf({ pctBA: 7, pctIN: 9, pctCO: 5, pctWH: 2 });
    expect(earned).toBeCloseTo(3.217, 2);
  });

  it('weights Black African 1.5× — equal counts do NOT earn equal points', () => {
    // 5/5/5/5 → share 0.25 each. BA: min(4,0.25·4·1.5)=1.5; others 0.25·2=0.5 each.
    // earned = 1.5 + 0.5·3 = 3.0
    expect(repOf({ pctBA: 5, pctIN: 5, pctCO: 5, pctWH: 5 })).toBeCloseTo(3.0, 5);
  });

  it('earns zero when no players are counted (no divide-by-zero)', () => {
    expect(repOf({})).toBe(0);
    expect(repOf({ pctBA: 0, pctIN: 0, pctCO: 0, pctWH: 0 })).toBe(0);
  });

  it('accepts counts above the old 15 cap and scores on the uncapped share', () => {
    // 50/10/0/0 → total 60. earned =
    //   min(4, 50/60·4·1.5=5.0)=4  +  min(2, 10/60·2)=0.3333  = 4.3333
    // A 15-cap would have given total 25 → 4.4, so this pins the UNCAPPED value.
    expect(repOf({ pctBA: 50, pctIN: 10, pctCO: 0, pctWH: 0 })).toBeCloseTo(4.3333, 3);
  });
});

// Doc completion is now driven entirely by REQUIRED_DOCS so the count can't drift
// across call sites and tolerates clubs whose `docs` predate a newly-added key.
describe('compliance-doc helpers · REQUIRED_DOCS-driven', () => {
  const allTrue = Object.fromEntries(REQUIRED_DOCS.map((d) => [d.key, true]));
  const total = REQUIRED_DOCS.length;

  it('counts a fully-compliant club as complete', () => {
    const club = { docs: allTrue };
    expect(docsUploadedCount(club)).toBe(total);
    expect(docsAllComplete(club)).toBe(true);
    expect(docCompletion(club)).toBe(100);
  });

  it('computes a correct fraction for a partial club', () => {
    const docs = { ...allTrue, [REQUIRED_DOCS[0].key]: false };
    const club = { docs };
    expect(docsUploadedCount(club)).toBe(total - 1);
    expect(docsAllComplete(club)).toBe(false);
    expect(docCompletion(club)).toBe(Math.round(((total - 1) / total) * 100));
  });

  it('treats an empty docs object as zero/incomplete (was vacuously true before)', () => {
    const club = { docs: {} };
    expect(docsUploadedCount(club)).toBe(0);
    expect(docsAllComplete(club)).toBe(false);
    expect(docCompletion(club)).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { scoreCQI } from './atoms';
import {
  REQUIRED_DOCS,
  docsUploadedCount,
  docsAllComplete,
  docCompletion,
  CQI_STRUCTURE,
  deriveGovernance,
  effectiveAnswers,
  governanceOverrides,
  genuineCqiAnswers,
  GOVERNANCE_KEYS,
} from './data';

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
    // All three ratings at 5/5 and all three yes/no true → full section (weight 18 after
    // the governance rebalance). `constitution` is now a real governance key but lives in
    // a different category, so it must not contribute to the admin section here.
    const full = scoreCQI({
      vision: true,
      pathway: true,
      accredAim: true,
      ambition: 5,
      retention: 5,
      coachDev: 5,
      constitution: true,
    }).byCat.admin.earned;
    expect(full).toBeCloseTo(18, 5);

    // A single rating at 3/5 (pts 4) with everything else unanswered: earned within
    // the section = (3/5)*4 = 2.4 of possible 21 → (2.4/21)*18.
    const partial = scoreCQI({ ambition: 3 }).byCat.admin.earned;
    expect(partial).toBeCloseTo((2.4 / 21) * 18, 4);
  });
});

// Representation moved from percentages to raw head-counts (now an uncapped number
// input — no per-race limit). Scoring derives each race's SHARE of the counted total
// and keeps the Black African 1.5× weight. These tests pin that re-baselined
// behaviour so future changes are intentional rather than accidental.
describe('scoreCQI · representation by head-count', () => {
  const repOf = (answers) => scoreCQI(answers).byCat.representation.earned;

  it('scores each race in proportion to its share of the counted total', () => {
    // counts 7/9/5/2 → total 23. raw share-points (possible 10) =
    //   min(4, 7/23·4·1.5) + min(2, 9/23·2) + min(2, 5/23·2) + min(2, 2/23·2)
    //   = 1.8261 + 0.7826 + 0.4348 + 0.1739 ≈ 3.2174
    // section earned = (3.2174 / 10) · weight 9 ≈ 2.896
    const earned = repOf({ pctBA: 7, pctIN: 9, pctCO: 5, pctWH: 2 });
    expect(earned).toBeCloseTo(2.896, 2);
  });

  it('weights Black African 1.5× — equal counts do NOT earn equal points', () => {
    // 5/5/5/5 → share 0.25 each. BA: min(4,0.25·4·1.5)=1.5; others 0.25·2=0.5 each.
    // raw = 1.5 + 0.5·3 = 3.0 → section earned = (3.0 / 10) · weight 9 = 2.7
    expect(repOf({ pctBA: 5, pctIN: 5, pctCO: 5, pctWH: 5 })).toBeCloseTo(2.7, 5);
  });

  it('earns zero when no players are counted (no divide-by-zero)', () => {
    expect(repOf({})).toBe(0);
    expect(repOf({ pctBA: 0, pctIN: 0, pctCO: 0, pctWH: 0 })).toBe(0);
  });

  it('accepts counts above the old 15 cap and scores on the uncapped share', () => {
    // 50/10/0/0 → total 60. raw (possible 10) =
    //   min(4, 50/60·4·1.5=5.0)=4  +  min(2, 10/60·2)=0.3333  = 4.3333
    // section earned = (4.3333 / 10) · weight 9 = 3.9. A 15-cap would have given a
    // higher raw, so this pins the UNCAPPED value.
    expect(repOf({ pctBA: 50, pctIN: 10, pctCO: 0, pctWH: 0 })).toBeCloseTo(3.9, 3);
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

// Governance & Compliance — a scored category auto-filled from compliance documents and club
// records, kept editable. Persisting only genuine overrides keeps the auto-fill tracking the
// documents live, and every score/display consumer must read effectiveAnswers, not raw answers.
describe('CQI · Governance & Compliance auto-fill', () => {
  const gov = CQI_STRUCTURE.find((c) => c.key === 'governance');

  it('keeps all seven category weights summing to 100', () => {
    const sum = CQI_STRUCTURE.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBe(100);
    expect(gov.weight).toBe(10);
  });

  it('deriveGovernance maps docs + player count to the seven booleans', () => {
    const club = {
      docs: { constitution: true, codeOfConduct: false, agm: true, exco: true },
      players: 12,
    };
    expect(deriveGovernance(club)).toEqual({
      constitution: true,
      codeOfConduct: false,
      inventory: true, // maintained on-platform — always in place unless overridden
      agmConducted: true, // docs.agm (uploaded OR booked meeting)
      officers: true, // docs.exco
      agmMinutes: true, // docs.agm
      playerdb: true, // players > 0
    });
  });

  it('playerdb derives from players ?? playerCount, false when zero/absent', () => {
    expect(deriveGovernance({ docs: {}, players: 0 }).playerdb).toBe(false);
    expect(deriveGovernance({ docs: {} }).playerdb).toBe(false);
    expect(deriveGovernance({ docs: {}, playerCount: 3 }).playerdb).toBe(true);
  });

  it('scores full governance credit when every derived answer is true', () => {
    const club = {
      docs: {
        constitution: true,
        codeOfConduct: true,
        agm: true,
        exco: true,
      },
      players: 30,
    };
    const earned = scoreCQI(effectiveAnswers(club)).byCat.governance.earned;
    expect(earned).toBeCloseTo(gov.weight, 5);
  });

  it('admin breakdown scores governance from docs even when cqiAnswers holds no governance keys', () => {
    // A club submits capability answers only — governance was auto-filled, so no overrides
    // were persisted. effectiveAnswers must still recover the governance score from docs.
    const club = {
      docs: { constitution: true, codeOfConduct: true, agm: true, exco: true },
      players: 5,
      cqiAnswers: { vision: true }, // a non-governance answer; no governance keys
    };
    const raw = scoreCQI(club.cqiAnswers).byCat.governance.earned;
    const eff = scoreCQI(effectiveAnswers(club)).byCat.governance.earned;
    expect(raw).toBe(0); // raw answers under-score governance
    expect(eff).toBeCloseTo(gov.weight, 5); // merged view recovers it
  });

  it('governanceOverrides stores nothing when answers equal the derived values', () => {
    const club = { docs: { constitution: true, agm: true, exco: true }, players: 4 };
    const answers = { ...deriveGovernance(club), vision: true, senior: 3 };
    const stored = governanceOverrides(answers, club);
    for (const k of GOVERNANCE_KEYS) expect(k in stored).toBe(false);
    // non-governance answers are untouched
    expect(stored).toEqual({ vision: true, senior: 3 });
  });

  it('governanceOverrides keeps only the genuinely toggled governance key', () => {
    const club = { docs: { constitution: true, agm: true, exco: true }, players: 4 };
    // Club disagrees: marks constitution false even though docs say true.
    const answers = { ...deriveGovernance(club), constitution: false };
    const stored = governanceOverrides(answers, club);
    expect(stored.constitution).toBe(false);
    expect('agmConducted' in stored).toBe(false);
  });

  it('effectiveAnswers lets a stored override win over the derived value', () => {
    const club = {
      docs: { constitution: true },
      cqiAnswers: { constitution: false },
    };
    expect(effectiveAnswers(club).constitution).toBe(false);
  });

  it('does not let stale legacy approximation answers freeze governance', () => {
    // A club that submitted under the pre-governance schema persisted an approximation block
    // carrying orphan legacy keys (minutes/conduct/agm) plus governance-ish keys. Those
    // governance keys are NOT genuine overrides: they must re-derive from the documents.
    const club = {
      docs: { constitution: false, exco: false },
      players: 0,
      cqiAnswers: {
        minutes: true, // orphan legacy marker → flags a legacy submission
        constitution: true, // stale: docs now say false
        officers: true, // stale: docs.exco now false
        playerdb: true, // stale: no players
        vision: true, // a genuine capability answer — must survive
      },
    };
    // Genuine answers drop the colliding governance keys but keep real ones.
    const genuine = genuineCqiAnswers(club);
    expect('constitution' in genuine).toBe(false);
    expect('officers' in genuine).toBe(false);
    expect('playerdb' in genuine).toBe(false);
    expect(genuine.vision).toBe(true);
    expect(genuine.minutes).toBe(true); // orphan key is harmless (scoreCQI ignores it)
    // effectiveAnswers re-derives the stale governance values from the documents.
    const eff = effectiveAnswers(club);
    expect(eff.constitution).toBe(false);
    expect(eff.officers).toBe(false);
    expect(eff.playerdb).toBe(false);
  });

  it('a non-legacy submission keeps its genuine governance overrides', () => {
    // No orphan legacy key → cqiAnswers governance values are real overrides and survive.
    const club = {
      docs: { constitution: true },
      cqiAnswers: { constitution: false, senior: 2 },
    };
    expect(genuineCqiAnswers(club).constitution).toBe(false);
    expect(effectiveAnswers(club).constitution).toBe(false);
  });
});

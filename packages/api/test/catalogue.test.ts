/**
 * Unit tests for the pure affiliation-patch validators in catalogue.ts — the only
 * server gate over the new exco/coach governance fields. No DynamoDB/Hono needed.
 *
 * Run with the API package's test runner (tsx --test), which resolves the NodeNext
 * ".js" import specifiers to their ".ts" sources.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateClubPatch,
  isValidSaId,
  COACH_EXPERIENCE,
  hasAffiliationDraft,
} from '../src/catalogue.js';

const leagueKeys = new Set<string>(['premier']);
const docKeys = new Set<string>(['constitution', 'financials']);
const districts = new Set<string>(['KCCD']);
const ok = (patch: Parameters<typeof validateClubPatch>[0]) =>
  validateClubPatch(patch, leagueKeys, docKeys, districts);

describe('isValidSaId', () => {
  test('accepts a 13-digit ID with a real YYMMDD', () => {
    assert.equal(isValidSaId('9001015800086'), true);
  });
  test('rejects wrong length / non-digits / impossible date', () => {
    assert.equal(isValidSaId('123'), false);
    assert.equal(isValidSaId('90010158000ab'), false);
    assert.equal(isValidSaId('9013015800086'), false); // month 13
    assert.equal(isValidSaId('9001325800086'), false); // day 32
  });
});

describe('validateClubPatch · chair governance', () => {
  test('passes a valid chair ID + term dates', () => {
    assert.equal(
      ok({
        exco: {
          chair: { idNumber: '9001015800086', termStart: '2026-01-01', termEnd: '2029-01-01' },
        },
      }),
      null,
    );
  });
  test('rejects a malformed chair ID', () => {
    assert.match(String(ok({ exco: { chair: { idNumber: '123' } } })), /chair idNumber/);
  });
  test('rejects an unparseable term date', () => {
    assert.match(String(ok({ exco: { chair: { termEnd: 'not-a-date' } } })), /term end/);
  });
  test('ignores chair fields when absent', () => {
    assert.equal(ok({ exco: { chair: { name: 'Mo' } } }), null);
  });
});

describe('validateClubPatch · district (caller-supplied union, per-tenant)', () => {
  test('passes a district in the supplied set', () => {
    assert.equal(ok({ district: 'KCCD' }), null);
  });
  test('rejects a district outside the set', () => {
    assert.match(String(ok({ district: 'Gotham' })), /unknown district/);
  });
  test('ignores an absent district', () => {
    assert.equal(ok({ name: 'Some CC' }), null);
  });
});

describe('validateClubPatch · coach governance', () => {
  test('accepts every valid experience bucket', () => {
    for (const x of COACH_EXPERIENCE) {
      assert.equal(ok({ coaches: [{ name: 'C', yearsExperience: x }] }), null);
    }
  });
  test('rejects an out-of-enum experience bucket', () => {
    assert.match(
      String(ok({ coaches: [{ name: 'C', yearsExperience: '11+' }] })),
      /experience bucket/,
    );
  });
  test('rejects a malformed coach ID and a bad year', () => {
    assert.match(String(ok({ coaches: [{ idNumber: 'abc' }] })), /coach idNumber/);
    assert.match(String(ok({ coaches: [{ yearStarted: '19' }] })), /yearStarted/);
  });
});

describe('validateClubPatch · team rosters', () => {
  const roster2 = {
    leagues: ['premier'],
    leagueTeams: { premier: 2 },
    teamRosters: {
      premier: [
        { id: 'tm_a', name: 'Glenwood A' },
        { id: 'tm_b', name: 'Glenwood B' },
      ],
    },
  };

  test('accepts a well-formed 2-side roster', () => {
    assert.equal(ok(roster2), null);
  });

  test('rejects a roster key not among the leagues entered', () => {
    assert.match(
      String(ok({ leagues: ['premier'], teamRosters: { other: [{ id: 'tm_x', name: 'X' }] } })),
      /teamRosters has keys not in leagues/,
    );
  });

  test('rejects a team id missing the tm_ prefix', () => {
    assert.match(
      String(
        ok({
          leagues: ['premier'],
          leagueTeams: { premier: 2 },
          teamRosters: {
            premier: [
              { id: 'a', name: 'A' },
              { id: 'tm_b', name: 'B' },
            ],
          },
        }),
      ),
      /tm_ id/,
    );
  });

  test('rejects duplicate team ids across rosters', () => {
    assert.match(
      String(
        ok({
          leagues: ['premier'],
          leagueTeams: { premier: 2 },
          teamRosters: {
            premier: [
              { id: 'tm_a', name: 'A' },
              { id: 'tm_a', name: 'B' },
            ],
          },
        }),
      ),
      /duplicate team id/,
    );
  });

  test('rejects an empty or over-long team name', () => {
    assert.match(
      String(
        ok({
          leagues: ['premier'],
          leagueTeams: { premier: 2 },
          teamRosters: {
            premier: [
              { id: 'tm_a', name: '  ' },
              { id: 'tm_b', name: 'B' },
            ],
          },
        }),
      ),
      /team name cannot be empty/,
    );
    assert.match(
      String(
        ok({
          leagues: ['premier'],
          leagueTeams: { premier: 2 },
          teamRosters: {
            premier: [
              { id: 'tm_a', name: 'x'.repeat(81) },
              { id: 'tm_b', name: 'B' },
            ],
          },
        }),
      ),
      /80 characters or fewer/,
    );
  });

  test('rejects a roster whose length does not match the team count', () => {
    assert.match(
      String(
        ok({
          leagues: ['premier'],
          leagueTeams: { premier: 3 },
          teamRosters: {
            premier: [
              { id: 'tm_a', name: 'A' },
              { id: 'tm_b', name: 'B' },
            ],
          },
        }),
      ),
      /length must match the team count/,
    );
  });

  test('rejects a roster for a league fielding fewer than 2 sides', () => {
    assert.match(
      String(
        ok({
          leagues: ['premier'],
          leagueTeams: { premier: 1 },
          teamRosters: {
            premier: [
              { id: 'tm_a', name: 'A' },
              { id: 'tm_b', name: 'B' },
            ],
          },
        }),
      ),
      /fewer than 2 teams/,
    );
  });
});

describe('validateClubPatch · coach team assignment', () => {
  const base = {
    leagues: ['premier'],
    leagueTeams: { premier: 2 },
    teamRosters: {
      premier: [
        { id: 'tm_a', name: 'A' },
        { id: 'tm_b', name: 'B' },
      ],
    },
  };

  test('accepts a coach assigned to a real roster side', () => {
    assert.equal(
      ok({ ...base, coaches: [{ name: 'C', teams: ['premier'], teamIds: ['tm_a'] }] }),
      null,
    );
  });

  test('rejects a coach assigned to an unknown side', () => {
    assert.match(
      String(ok({ ...base, coaches: [{ name: 'C', teamIds: ['tm_ghost'] }] })),
      /unknown team/,
    );
  });

  test('ignores coach.teamIds when the patch carries no rosters (draft)', () => {
    // A draft that omits rosters but keeps coaches must still pass.
    assert.equal(ok({ coaches: [{ name: 'C', teamIds: ['tm_a'] }] }), null);
  });
});

describe('validateClubPatch · cqi score and answers', () => {
  test('accepts a realistic submission (mixed value types + involvementReasons)', () => {
    assert.equal(
      ok({
        cqi: 62.4,
        cqiAnswers: {
          vision: true, // yn
          ambition: 4, // rating
          pctBA: 12, // count
          subsFee: '250', // money atoms emit strings
          constitution: false, // governance override
          involvementReasons: ['Giving back to the cricket community'],
        },
      }),
      null,
    );
  });

  test('accepts cqi 0 and the [0,100] bounds', () => {
    assert.equal(ok({ cqi: 0 }), null);
    assert.equal(ok({ cqi: 100 }), null);
  });

  test('rejects an out-of-range or non-numeric cqi', () => {
    assert.match(String(ok({ cqi: 150 })), /between 0 and 100/);
    assert.match(String(ok({ cqi: -1 })), /between 0 and 100/);
    assert.match(String(ok({ cqi: 'high' as unknown })), /must be a number/);
    assert.match(String(ok({ cqi: NaN })), /must be a number/);
  });

  test('treats an explicit null cqiAnswers as absent (legacy patch contract)', () => {
    assert.equal(ok({ cqiAnswers: null }), null);
  });

  test('allows null answer values (legacy blanks must stay correctable)', () => {
    assert.equal(ok({ cqiAnswers: { vision: null, ambition: 3 } }), null);
  });

  test('rejects a non-object cqiAnswers and non-scalar answer values', () => {
    assert.match(
      String(ok({ cqiAnswers: [] as unknown as Record<string, unknown> })),
      /must be an object/,
    );
    assert.match(String(ok({ cqiAnswers: { vision: { nested: true } } })), /values must be/);
  });

  test('rejects an oversized answers object', () => {
    const big = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`k${i}`, 1]));
    assert.match(String(ok({ cqiAnswers: big })), /too many keys/);
  });

  test('rejects an oversized string value (would otherwise 500 at the DynamoDB item limit)', () => {
    assert.match(String(ok({ cqiAnswers: { subsFee: 'x'.repeat(201) } })), /characters or fewer/);
    assert.equal(ok({ cqiAnswers: { subsFee: 'x'.repeat(200) } }), null);
  });

  test('still rejects unknown involvementReasons inside an otherwise-valid patch', () => {
    assert.match(
      String(ok({ cqi: 50, cqiAnswers: { involvementReasons: ['Money'] } })),
      /invalid involvementReasons/,
    );
  });
});

describe('hasAffiliationDraft', () => {
  test('false for a bare signup club (chair-only seed: name/email/cell)', () => {
    // buildInitialExco seeds exactly this; it must NOT count as a draft.
    assert.equal(
      hasAffiliationDraft({
        exco: { chair: { name: 'Lauryn Thole', email: 'a@b.com', cell: '0837301194' } },
        leagues: [],
        ground: {},
      }),
      false,
    );
  });

  test('false for an admin "Mark as compliant" exco override (no form data)', () => {
    // The override sets docs.exco:true with no exco content — the predicate ignores
    // docs entirely, so a never-started club stays not_started.
    assert.equal(hasAffiliationDraft({ exco: undefined, leagues: [], ground: {} }), false);
  });

  test('true when a non-chair officer is named (sec/tre/vc are form-only)', () => {
    assert.equal(
      hasAffiliationDraft({ exco: { chair: { name: 'A' }, sec: { name: 'Debbie Dennill' } } }),
      true,
    );
  });

  test('true with additional committee members', () => {
    assert.equal(
      hasAffiliationDraft({ exco: { additionalMembers: [{ name: 'Member One' }] } }),
      true,
    );
  });

  test('true when the chair carries a form-only governance field', () => {
    assert.equal(
      hasAffiliationDraft({ exco: { chair: { name: 'A', idNumber: '9001015800086' } } }),
      true,
    );
    assert.equal(hasAffiliationDraft({ exco: { chair: { name: 'A', gender: 'Female' } } }), true);
  });

  test('true with leagues, coaches, or a populated ground', () => {
    assert.equal(hasAffiliationDraft({ leagues: ['premier'] }), true);
    assert.equal(hasAffiliationDraft({ coaches: [{ name: 'Coach' }] }), true);
    assert.equal(hasAffiliationDraft({ ground: { venue: 'Kingsmead' } }), true);
  });

  test('false for a completely empty club', () => {
    assert.equal(hasAffiliationDraft({}), false);
  });
});

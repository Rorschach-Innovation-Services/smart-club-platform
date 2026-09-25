/**
 * validateStructures — the pool-knockout additions: `within-pool` pairing, the counted
 * `qualifiersPerGroup`, and `startAfter` chaining within a block.
 *
 * The back-compat half matters as much as the new rejections: `POST /season-runs`
 * re-validates every structure snapshot a client starts a season from, so a structure
 * that validated before these fields existed must still validate now.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateStructures } from '../src/config-validation.js';
import { HttpError } from '../src/auth.js';
import type { CompetitionStructure, StageSpec } from '../src/types.js';

const pools = (over: Partial<StageSpec> = {}): StageSpec => ({
  id: 'pools',
  name: 'Pools',
  format: { kind: 'round-robin', legs: 1 },
  entrants: { kind: 'seeded-split', groups: { kind: 'even', count: 2 }, method: 'snake' },
  schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
  ...over,
});

const knockout = (
  pairing: string,
  qualifiersPerGroup?: unknown,
  over: Partial<StageSpec> = {},
): StageSpec =>
  ({
    id: 'ko',
    name: 'Knockout',
    format: { kind: 'knockout', pairing, thirdPlace: false },
    entrants: {
      kind: 'manual',
      derivedFrom: {
        rule: 'from-standings',
        fromStage: 'pools',
        detail: 'Top two per group',
        ...(qualifiersPerGroup === undefined ? {} : { qualifiersPerGroup }),
      },
    },
    schedule: { blockIndex: 1, cadence: { kind: 'weekly' } },
    ...over,
  }) as StageSpec;

const structure = (stages: StageSpec[]): CompetitionStructure => ({
  id: 'st',
  name: 'Pools to knockout',
  version: 1,
  stages,
});

const accepts = (stages: StageSpec[], why: string) =>
  assert.doesNotThrow(() => validateStructures([structure(stages)]), why);

const rejects = (stages: StageSpec[], why: string, message?: RegExp) =>
  assert.throws(
    () => validateStructures([structure(stages)]),
    (err: unknown) =>
      err instanceof HttpError &&
      err.status === 400 &&
      (message === undefined || message.test(err.message)),
    why,
  );

describe('within-pool pairing', () => {
  test('2 groups × 2 qualifiers is accepted', () =>
    accepts([pools(), knockout('within-pool', 2)], 'the original shape'));

  const groupsOf = (count: number) =>
    pools({
      entrants: { kind: 'seeded-split', groups: { kind: 'even', count }, method: 'snake' },
    });

  // Widened to the engine's real rule (ADR 0014): `withinPoolRounds` draws any
  // power-of-two number of groups each sending the same power-of-two number of sides.
  test('4 groups × 2 qualifiers is accepted', () =>
    accepts([groupsOf(4), knockout('within-pool', 2)], '4×2'));

  test('2 groups × 4 qualifiers and 8 groups × 2 are accepted', () => {
    accepts([groupsOf(2), knockout('within-pool', 4)], '2×4');
    accepts([groupsOf(8), knockout('within-pool', 2)], '8×2');
  });

  test('3 groups × 2 qualifiers is rejected', () =>
    rejects(
      [groupsOf(3), knockout('within-pool', 2)],
      '3×2',
      /power-of-two number of groups \(2, 4, 8\) each sending the same power-of-two number of sides \(2, 4\)/,
    ));

  test('2 groups × 3 qualifiers is rejected', () =>
    rejects([groupsOf(2), knockout('within-pool', 3)], '2×3', /power-of-two/));

  test('a sizes plan with exactly two groups counts as two groups', () =>
    accepts(
      [
        pools({
          entrants: {
            kind: 'seeded-split',
            groups: { kind: 'sizes', sizes: [5, 5] },
            method: 'blocks',
          },
        }),
        knockout('within-pool', 2),
      ],
      'sizes [5,5]',
    ));

  test('no qualifier count is rejected with the within-group message', () =>
    rejects(
      [pools(), knockout('within-pool')],
      'missing qualifiersPerGroup',
      /within-group semi-finals need a power-of-two number of groups/,
    ));

  test('a count that is not a power of two of at least 2 is rejected', () => {
    rejects([pools(), knockout('within-pool', 1)], 'q=1');
    rejects([pools(), knockout('within-pool', 3)], 'q=3');
    rejects([pools(), knockout('within-pool', 6)], 'q=6');
  });

  test('a source stage with three groups is rejected', () =>
    rejects(
      [
        pools({
          entrants: { kind: 'seeded-split', groups: { kind: 'even', count: 3 }, method: 'snake' },
        }),
        knockout('within-pool', 2),
      ],
      '3 pools',
      /power-of-two number of groups/,
    ));

  test('a source stage with no group plan (one group) is rejected', () =>
    rejects(
      [pools({ entrants: { kind: 'all-registered' } }), knockout('within-pool', 2)],
      'single group',
    ));

  test('within-pool with no derivation note at all is rejected', () =>
    rejects(
      [pools(), knockout('within-pool', 2, { entrants: { kind: 'manual' } })],
      'no derivedFrom',
    ));

  test('an unknown pairing is still rejected', () =>
    rejects([pools(), knockout('best-v-worst')], 'unknown pairing', /unknown knockout pairing/));
});

describe('qualifiersPerGroup', () => {
  test('whole numbers 1–8 are accepted on a seeded knockout', () => {
    for (const q of [1, 4, 8]) accepts([pools(), knockout('seeded', q)], `q=${q}`);
  });

  test('out-of-range and non-integer counts are rejected', () => {
    for (const q of [0, 9, 1.5, '2', -1])
      rejects([pools(), knockout('seeded', q)], `q=${String(q)}`, /qualifiers per group/);
  });

  test('cross-pool accepts up to 2 per group', () => {
    accepts([pools(), knockout('cross-pool', 1)], 'cross-pool q=1');
    accepts([pools(), knockout('cross-pool', 2)], 'cross-pool q=2');
  });

  test('cross-pool rejects 3 per group — no expressible cross-group opponent', () =>
    rejects([pools(), knockout('cross-pool', 3)], 'cross-pool q=3', /at most 2 qualifiers/));
});

describe('startAfter', () => {
  const chained = (startAfter: unknown, blockIndex = 0) =>
    knockout('seeded', undefined, {
      schedule: { blockIndex, cadence: { kind: 'weekly' }, startAfter } as StageSpec['schedule'],
    });

  test('chaining onto an earlier stage in the same block is accepted', () =>
    accepts([pools(), chained('previous-stage', 0)], 'same block'));

  test('chaining with no earlier stage in the block is rejected', () =>
    rejects(
      [pools(), chained('previous-stage', 1)],
      'different block',
      /no earlier stage plays in block 2/,
    ));

  test('the first stage cannot chain onto anything', () =>
    rejects(
      [
        pools({
          schedule: { blockIndex: 0, cadence: { kind: 'weekly' }, startAfter: 'previous-stage' },
        }),
      ],
      'first stage',
    ));

  test('a LATER stage in the same block does not count — the walk is strictly earlier', () =>
    rejects(
      [
        pools({
          schedule: { blockIndex: 0, cadence: { kind: 'weekly' }, startAfter: 'previous-stage' },
        }),
        knockout('seeded', undefined, { schedule: { blockIndex: 0, cadence: { kind: 'weekly' } } }),
      ],
      'forward reference',
    ));

  test('an unknown start rule is rejected', () =>
    rejects([pools(), chained('block-end', 0)], 'unknown start rule', /unknown start rule/));
});

describe('back-compat: structures saved before these fields existed', () => {
  test('a cross-pool knockout with no qualifier count still validates', () =>
    accepts([pools(), knockout('cross-pool')], 'legacy cross-pool'));

  test('a seeded knockout with no count and no startAfter still validates', () =>
    accepts([pools(), knockout('seeded')], 'legacy seeded'));

  test('a knockout sharing a block with no startAfter still validates', () =>
    accepts(
      [
        pools(),
        knockout('cross-pool', undefined, {
          schedule: { blockIndex: 0, cadence: { kind: 'weekly' } },
        }),
      ],
      'two stages sharing a block without chaining — the old overlap is still expressible',
    ));
});

describe('source (provenance)', () => {
  test('each known source is accepted, and absent still validates', () => {
    for (const source of ['operator', 'quick-start', 'migration'] as const)
      assert.doesNotThrow(() => validateStructures([{ ...structure([pools()]), source }]));
    accepts([pools()], 'no source ⇒ operator, the pre-existing meaning');
  });
  test('an unknown source is rejected', () =>
    assert.throws(
      () =>
        validateStructures([{ ...structure([pools()]), source: 'admin' as unknown as 'operator' }]),
      (err: unknown) => err instanceof HttpError && /unknown source/.test(err.message),
    ));
});

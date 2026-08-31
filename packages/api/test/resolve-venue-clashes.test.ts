/**
 * Unit tests for the pure "which fixture moves" chooser in resolve-venue-clashes.ts.
 * Pure — no repo, no DynamoDB. Covers the four deterministic selection rules.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chooseFixtureToMove, type ClashParticipant } from '../src/resolve-venue-clashes.js';

const side = (over: Partial<ClashParticipant>): ClashParticipant => ({
  seriesId: 's-planb-premier-men-1',
  seriesSlug: 'premier-men-1',
  fixtureId: 'f1',
  atHomeGround: false,
  ...over,
});

describe('chooseFixtureToMove', () => {
  test('rule 1 — the fixture NOT at its home ground moves', () => {
    const home = side({ seriesId: 's-planb-premier-men-1', fixtureId: 'f10', atHomeGround: true });
    const away = side({ seriesId: 's-planb-premier-men-2', fixtureId: 'f20', atHomeGround: false });
    const d1 = chooseFixtureToMove(home, away);
    assert.equal(d1.move, away);
    assert.equal(d1.keep, home);
    // Symmetric in argument order.
    const d2 = chooseFixtureToMove(away, home);
    assert.equal(d2.move, away);
  });

  test('rule 2 — Promotion yields to Premier (different series, neither at home)', () => {
    const prem = side({
      seriesId: 's-planb-premier-men-1',
      seriesSlug: 'premier-men-1',
      fixtureId: 'f5',
    });
    const prom = side({
      seriesId: 's-planb-promotion-men-30ov-top10',
      seriesSlug: 'promotion-men-30ov-top10',
      fixtureId: 'f3',
    });
    const d1 = chooseFixtureToMove(prem, prom);
    assert.equal(d1.move, prom);
    assert.equal(d1.reason, 'Promotion yields to Premier');
    const d2 = chooseFixtureToMove(prom, prem);
    assert.equal(d2.move, prom);
  });

  test('rule 3 — higher-numbered group moves (Gledhow 50-over g2 = Ilembe)', () => {
    const g1 = side({
      seriesId: 's-planb-promotion-men-50ov-g1',
      seriesSlug: 'promotion-men-50ov-g1',
      fixtureId: 'f7',
    });
    const g2 = side({
      seriesId: 's-planb-promotion-men-50ov-g2',
      seriesSlug: 'promotion-men-50ov-g2',
      fixtureId: 'f4',
    });
    const d1 = chooseFixtureToMove(g1, g2);
    assert.equal(d1.move, g2);
    assert.match(d1.reason, /g2/);
    const d2 = chooseFixtureToMove(g2, g1);
    assert.equal(d2.move, g2);

    // Bare trailing number (…-2 vs …-1) works too.
    const n1 = side({ seriesId: 's-planb-x-1', seriesSlug: 'x-1', fixtureId: 'f1' });
    const n2 = side({ seriesId: 's-planb-x-2', seriesSlug: 'x-2', fixtureId: 'f9' });
    assert.equal(chooseFixtureToMove(n1, n2).move, n2);
  });

  test('rule 4 — later fixture id in the same series moves (f37 vs f40 → f40)', () => {
    const f37 = side({
      seriesId: 's-planb-premier-men-1',
      seriesSlug: 'premier-men-1',
      fixtureId: 'f37',
    });
    const f40 = side({
      seriesId: 's-planb-premier-men-1',
      seriesSlug: 'premier-men-1',
      fixtureId: 'f40',
    });
    const d1 = chooseFixtureToMove(f37, f40);
    assert.equal(d1.move, f40);
    assert.match(d1.reason, /f40/);
    const d2 = chooseFixtureToMove(f40, f37);
    assert.equal(d2.move, f40);
  });
});

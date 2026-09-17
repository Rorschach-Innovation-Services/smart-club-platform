/**
 * Unit tests for the veterans squad-selection helpers (ADR 0013): league detection, the candidate
 * HMAC handle, and the fail-closed secret resolution. Pure — no dynalite, no network. repo.ts
 * reads TABLE_NAME at module load (veterans.ts imports it), so the env is set before importing.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

process.env.TABLE_NAME = 'SmartClubTest';
process.env.DYNAMO_ENDPOINT = 'http://localhost:4637';
process.env.LOCAL_AUTH = '1';
process.env.AWS_REGION ??= 'localhost';

const { isVeteransLeague, isVeteransLeagueKey, candidateHandle } =
  await import('../src/veterans.js');
const { candidateHandleSecret } = await import('../src/env.js');
import type { League } from '../src/types.js';

const league = (key: string, label: string): League => ({
  key,
  label,
  group: 'Overarching Leagues',
  district: 'All districts',
});

describe('isVeteransLeague / isVeteransLeagueKey', () => {
  test('matches by key prefix (veterans, veterans-premier, veterans-promotion)', () => {
    assert.equal(isVeteransLeague(league('veterans', 'Veterans League')), true);
    assert.equal(isVeteransLeague(league('veterans-premier', 'Vets Premier')), true);
    assert.equal(isVeteransLeague(league('veterans-promotion', 'Over 40s')), true);
  });

  test('matches by label (Veterans / Vets) even with a non-veterans key', () => {
    assert.equal(isVeteransLeague(league('over40', 'Veterans League')), true);
    assert.equal(isVeteransLeague(league('masters', 'Masters Vets')), true);
  });

  test('does not match ordinary leagues', () => {
    assert.equal(isVeteransLeague(league('premier', 'Premier Men')), false);
    assert.equal(isVeteransLeague(league('premierWomen', "Women's Premier")), false);
    assert.equal(isVeteransLeague(null), false);
    assert.equal(isVeteransLeague(undefined), false);
  });

  test('isVeteransLeagueKey resolves against the catalogue, falls back to key regex for orphans', () => {
    const catalogue = [league('veterans', 'Veterans League'), league('premier', 'Premier Men')];
    assert.equal(isVeteransLeagueKey('veterans', catalogue), true);
    assert.equal(isVeteransLeagueKey('premier', catalogue), false);
    // Orphan key (removed from the catalogue) still gated by the key pattern.
    assert.equal(isVeteransLeagueKey('veterans-premier', catalogue), true);
    assert.equal(isVeteransLeagueKey('emcuU11', catalogue), false);
    assert.equal(isVeteransLeagueKey('', catalogue), false);
  });
});

describe('candidateHandle (HMAC)', () => {
  const tenant = 'dolphins';
  const club = 'primary-cc';
  const nk = 'a'.repeat(64); // a sha256-shaped natural key

  test('is an HMAC, NOT the natural key and NOT a plain sha256 of the same triple', () => {
    const handle = candidateHandle(tenant, club, nk);
    const plainSha = createHash('sha256').update(`${tenant}|${club}|${nk}`).digest('hex');
    assert.notEqual(handle, nk);
    assert.notEqual(handle, plainSha);
    // It IS the HMAC with the local dev secret.
    const expected = createHmac('sha256', 'local-dev-candidate-handle-secret')
      .update(`${tenant}|${club}|${nk}`)
      .digest('hex');
    assert.equal(handle, expected);
  });

  test('is deterministic and bound to (tenant, club, key)', () => {
    assert.equal(candidateHandle(tenant, club, nk), candidateHandle(tenant, club, nk));
    assert.notEqual(candidateHandle(tenant, club, nk), candidateHandle('other', club, nk));
    assert.notEqual(candidateHandle(tenant, club, nk), candidateHandle(tenant, 'other-cc', nk));
    assert.notEqual(
      candidateHandle(tenant, club, nk),
      candidateHandle(tenant, club, 'b'.repeat(64)),
    );
  });
});

describe('candidateHandleSecret · fail-closed', () => {
  test('a set secret is trusted; empty/unset fails closed off-local; LOCAL_AUTH falls back', () => {
    const savedSecret = process.env.CANDIDATE_HANDLE_SECRET;
    const savedLocal = process.env.LOCAL_AUTH;
    try {
      // A real, non-empty value is trusted regardless of stage.
      process.env.CANDIDATE_HANDLE_SECRET = 'real-secret-value';
      delete process.env.LOCAL_AUTH;
      assert.equal(candidateHandleSecret(), 'real-secret-value');

      // Empty string (the sst.Secret default) off-local → FAIL CLOSED (throws).
      process.env.CANDIDATE_HANDLE_SECRET = '';
      assert.throws(() => candidateHandleSecret(), /CANDIDATE_HANDLE_SECRET not set/);

      // Unset off-local → also throws.
      delete process.env.CANDIDATE_HANDLE_SECRET;
      assert.throws(() => candidateHandleSecret(), /CANDIDATE_HANDLE_SECRET not set/);

      // Offline/local stack falls back to the dev constant.
      process.env.LOCAL_AUTH = '1';
      assert.equal(candidateHandleSecret(), 'local-dev-candidate-handle-secret');
    } finally {
      if (savedSecret === undefined) delete process.env.CANDIDATE_HANDLE_SECRET;
      else process.env.CANDIDATE_HANDLE_SECRET = savedSecret;
      if (savedLocal === undefined) delete process.env.LOCAL_AUTH;
      else process.env.LOCAL_AUTH = savedLocal;
    }
  });
});

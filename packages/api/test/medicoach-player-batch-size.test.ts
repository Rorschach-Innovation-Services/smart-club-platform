/**
 * `MEDICOACH_SYNC_BATCH_SIZE`: the per-POST player batch is env-tunable, clamped to
 * 1..PLAYER_PUSH_MAX, and defaults to the contract cap when unset or malformed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER_PUSH_MAX } from '../src/medicoach-sync-contract.js';
import { playerPushBatchSize } from '../src/medicoach-sync/players.js';

const size = (v?: string) =>
  playerPushBatchSize(v === undefined ? {} : { MEDICOACH_SYNC_BATCH_SIZE: v });

test('unset, empty or malformed ⇒ the contract cap (unchanged default)', () => {
  for (const v of [undefined, '', '  ', 'ten', '10.5', '1e1']) assert.equal(size(v), PLAYER_PUSH_MAX);
});

test('an in-range integer is used as is', () => {
  assert.equal(size('10'), 10);
  assert.equal(size(' 1 '), 1);
  assert.equal(size(String(PLAYER_PUSH_MAX)), PLAYER_PUSH_MAX);
});

test('clamped to 1..PLAYER_PUSH_MAX', () => {
  assert.equal(size('0'), 1);
  assert.equal(size('-5'), 1);
  assert.equal(size(String(PLAYER_PUSH_MAX + 1)), PLAYER_PUSH_MAX);
  assert.equal(size('100000'), PLAYER_PUSH_MAX);
});

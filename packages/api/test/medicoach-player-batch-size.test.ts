/**
 * `MEDICOACH_SYNC_BATCH_SIZE`: the per-POST player batch is env-tunable, clamped to
 * 1..PLAYER_PUSH_MAX, and defaults to the contract cap when unset or malformed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER_PUSH_MAX } from '../src/medicoach-sync-contract.js';
import {
  PLAYER_FLUSH_MAX_MANUAL,
  PLAYER_FLUSH_MAX_PER_RUN,
  playerFlushCap,
  playerPushBatchSize,
} from '../src/medicoach-sync/players.js';

const size = (v?: string) =>
  playerPushBatchSize(v === undefined ? {} : { MEDICOACH_SYNC_BATCH_SIZE: v });

test('unset, empty or malformed ⇒ the contract cap (unchanged default)', () => {
  for (const v of [undefined, '', '  ', 'ten', '10.5', '1e1'])
    assert.equal(size(v), PLAYER_PUSH_MAX);
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

test('manual "Sync now" is one POST: capped at min(PLAYER_FLUSH_MAX_MANUAL, batch size); cron unchanged', () => {
  const env = (v?: string) => (v === undefined ? {} : { MEDICOACH_SYNC_BATCH_SIZE: v });
  assert.equal(playerFlushCap('manual', env()), PLAYER_FLUSH_MAX_MANUAL);
  assert.equal(playerFlushCap('manual', env('10')), 10);
  assert.equal(playerFlushCap('manual', env('0')), 1);
  assert.equal(playerFlushCap('manual', env('500')), PLAYER_FLUSH_MAX_MANUAL);
  for (const v of [undefined, '10', '1'])
    for (const t of ['cron', 'cli'] as const)
      assert.equal(playerFlushCap(t, env(v)), PLAYER_FLUSH_MAX_PER_RUN);
});

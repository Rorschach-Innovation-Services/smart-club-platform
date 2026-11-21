/**
 * Pins how createTenantConfig and setTenantPublicSlug (ADR 0024) map a cancelled
 * TransactWriteItems to their errors: which item index means what, the precedence when several
 * items fail, a `TransactionConflict` (a race) and an unrelated error passing through.
 *
 * The transactional branch only runs against real DynamoDB (dynalite has no TransactWriteItems,
 * so every int test takes repo's offline fallback). This file leaves DYNAMO_ENDPOINT unset so
 * repo takes the real branch, and stubs the document client's `send` — the AWS boundary — to
 * answer GetItems from a fixture and reject the TransactWrite with a TransactionCanceledException
 * carrying the given CancellationReasons. Runs in its own process (node --test isolates files).
 */
import { test, describe, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { TenantConfig } from '../src/types.js';

delete process.env.DYNAMO_ENDPOINT;
process.env.TABLE_NAME = 'PublicAddressTxTest';
process.env.AWS_REGION = 'af-south-1';

let repo: typeof import('../src/repo.js');

/** GetItem answers keyed by `${pk}|${sk}`; anything absent reads as no item. */
let items: Map<string, Record<string, unknown>>;
/** The CancellationReasons codes the next TransactWrite is rejected with (or a raw error). */
let txFailure: { codes: string[] } | { error: Error };
/** The TransactItems of every TransactWrite sent. */
let sentTx: unknown[][];

const keyOf = (k: { pk: string; sk: string }) => `${k.pk}|${k.sk}`;

function cancelled(codes: string[]): Error {
  return Object.assign(new Error('Transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

before(async () => {
  repo = await import('../src/repo.js');
});

beforeEach(() => {
  items = new Map();
  txFailure = { codes: [] };
  sentTx = [];
  mock.method(DynamoDBDocumentClient.prototype, 'send', async (cmd: unknown) => {
    if (cmd instanceof GetCommand) {
      const item = items.get(keyOf(cmd.input.Key as { pk: string; sk: string }));
      return { Item: item };
    }
    if (cmd instanceof TransactWriteCommand) {
      sentTx.push(cmd.input.TransactItems ?? []);
      if ('error' in txFailure) throw txFailure.error;
      throw cancelled(txFailure.codes);
    }
    throw new Error(`unexpected command ${(cmd as object).constructor.name}`);
  });
});

afterEach(() => {
  mock.restoreAll();
});

const config = (tenant: string) =>
  ({
    tenant,
    branding: { name: tenant, title: tenant, logoUrl: '', colors: {}, copy: {} },
    submissionDeadline: '2026-01-01',
  }) as unknown as TenantConfig;

describe('createTenantConfig: cancellation mapping (CONFIG Put, PUBLICADDR check)', () => {
  const run = async (codes: string[]) => {
    txFailure = { codes };
    return repo.createTenantConfig(config('newclub')).then(
      () => assert.fail('expected a throw'),
      (err: unknown) => err,
    );
  };
  const assertUnavailable = (err: unknown, reason: 'exists' | 'address-in-use') => {
    assert.ok(err instanceof repo.TenantSlugUnavailableError, String(err));
    assert.equal(err.reason, reason);
    // The name callers match on (POST /platform/tenants, seed-core) is unchanged.
    assert.equal(err.name, 'ConditionalCheckFailedException');
  };

  test('sends the two-item transaction', async () => {
    await run(['ConditionalCheckFailed', 'None']);
    assert.equal(sentTx.length, 1);
    assert.equal(sentTx[0].length, 2);
  });

  test('index 0 failed ⇒ exists', async () => {
    assertUnavailable(await run(['ConditionalCheckFailed', 'None']), 'exists');
  });

  test('index 1 failed ⇒ address-in-use', async () => {
    assertUnavailable(await run(['None', 'ConditionalCheckFailed']), 'address-in-use');
  });

  test('both failed ⇒ exists wins', async () => {
    assertUnavailable(await run(['ConditionalCheckFailed', 'ConditionalCheckFailed']), 'exists');
  });

  test('a failed condition beats a TransactionConflict on the other item', async () => {
    assertUnavailable(await run(['ConditionalCheckFailed', 'TransactionConflict']), 'exists');
    assertUnavailable(
      await run(['TransactionConflict', 'ConditionalCheckFailed']),
      'address-in-use',
    );
  });

  test('TransactionConflict ⇒ retryable TenantCreateConflictError (not "exists")', async () => {
    for (const codes of [
      ['TransactionConflict', 'None'],
      ['None', 'TransactionConflict'],
    ]) {
      const err = await run(codes);
      assert.ok(err instanceof repo.TenantCreateConflictError, String(err));
      assert.notEqual((err as Error).name, 'ConditionalCheckFailedException');
    }
  });

  test('an unrelated error passes through unchanged', async () => {
    const boom = Object.assign(new Error('slow down'), {
      name: 'ProvisionedThroughputExceededException',
    });
    txFailure = { error: boom };
    await assert.rejects(repo.createTenantConfig(config('newclub')), (err) => err === boom);
  });

  test('a cancellation with no mapped code passes through unchanged', async () => {
    const err = await run(['None', 'ThrottlingError']);
    assert.equal((err as Error).name, 'TransactionCanceledException');
  });
});

describe('setTenantPublicSlug: cancellation mapping', () => {
  const TENANT = 'acmecricket';

  const seedAddress = (publicSlug: string) =>
    items.set(keyOf({ pk: `TENANT#${TENANT}`, sk: 'PUBLICADDR' }), {
      pk: `TENANT#${TENANT}`,
      sk: 'PUBLICADDR',
      publicSlug,
      history: [TENANT],
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
  const seedLabel = (label: string, status: 'active' | 'retired', tenant = 'otherclub') =>
    items.set(keyOf({ pk: `PUBLICADDR#${label}`, sk: 'PUBLICADDR' }), {
      pk: `PUBLICADDR#${label}`,
      sk: 'PUBLICADDR',
      label,
      tenant,
      status,
      claimedAt: '2026-10-01T00:00:00.000Z',
    });

  const run = async (next: string, expectedCurrent: string, codes: string[]) => {
    txFailure = { codes };
    return repo.setTenantPublicSlug(TENANT, next, expectedCurrent).then(
      () => assert.fail('expected a throw'),
      (err: unknown) => err,
    );
  };
  const assertCode = (err: unknown, code: string) => {
    assert.ok(err instanceof repo.PublicAddressConflictError, String(err));
    assert.equal(err.code, code);
  };

  describe('4-item shape (claim, not-a-tenant-ID check, address, retire)', () => {
    // On its own slug (no address record), moving to a fresh label.
    const move = (codes: string[]) => run('cobras', TENANT, codes);

    test('sends four items', async () => {
      await move(['None', 'None', 'ConditionalCheckFailed', 'None']);
      assert.equal(sentTx[0].length, 4);
    });

    test('index 0 failed ⇒ label-active or label-retired from the label record', async () => {
      seedLabel('cobras', 'active');
      assertCode(await move(['ConditionalCheckFailed', 'None', 'None', 'None']), 'label-active');
      seedLabel('cobras', 'retired');
      assertCode(await move(['ConditionalCheckFailed', 'None', 'None', 'None']), 'label-retired');
    });

    test('index 1 failed ⇒ label-is-tenant', async () => {
      assertCode(await move(['None', 'ConditionalCheckFailed', 'None', 'None']), 'label-is-tenant');
    });

    test('index 2 failed ⇒ stale', async () => {
      assertCode(await move(['None', 'None', 'ConditionalCheckFailed', 'None']), 'stale');
    });

    test('precedence: claim, then tenant ID, then address', async () => {
      seedLabel('cobras', 'active');
      assertCode(
        await move([
          'ConditionalCheckFailed',
          'ConditionalCheckFailed',
          'ConditionalCheckFailed',
          'None',
        ]),
        'label-active',
      );
      assertCode(
        await move(['None', 'ConditionalCheckFailed', 'ConditionalCheckFailed', 'None']),
        'label-is-tenant',
      );
      assertCode(
        await move(['None', 'TransactionConflict', 'ConditionalCheckFailed', 'None']),
        'stale',
      );
    });

    test('a failed condition beats a TransactionConflict', async () => {
      assertCode(
        await move(['TransactionConflict', 'ConditionalCheckFailed', 'None', 'None']),
        'label-is-tenant',
      );
    });

    test('TransactionConflict on any item ⇒ stale', async () => {
      for (let i = 0; i < 4; i++) {
        const codes = ['None', 'None', 'None', 'None'];
        codes[i] = 'TransactionConflict';
        assertCode(await move(codes), 'stale');
      }
    });

    test('index 3 (retire) failed ⇒ the raw cancellation (integrity fault)', async () => {
      const err = await move(['None', 'None', 'None', 'ConditionalCheckFailed']);
      assert.equal((err as Error).name, 'TransactionCanceledException');
    });

    test('an unrelated error passes through unchanged', async () => {
      const boom = Object.assign(new Error('slow down'), {
        name: 'ProvisionedThroughputExceededException',
      });
      txFailure = { error: boom };
      await assert.rejects(repo.setTenantPublicSlug(TENANT, 'cobras', TENANT), (e) => e === boom);
    });
  });

  describe('3-item shape (reclaiming the own slug: claim, address, retire)', () => {
    // Renamed to "cobras" earlier; moving back onto the tenant's own slug skips the CONFIG check.
    const reclaim = (codes: string[]) => {
      seedAddress('cobras');
      return run(TENANT, 'cobras', codes);
    };

    test('sends three items', async () => {
      await reclaim(['None', 'ConditionalCheckFailed', 'None']);
      assert.equal(sentTx[0].length, 3);
    });

    test('index 0 failed ⇒ label-active or label-retired from the label record', async () => {
      seedLabel(TENANT, 'active');
      assertCode(await reclaim(['ConditionalCheckFailed', 'None', 'None']), 'label-active');
      seedLabel(TENANT, 'retired');
      assertCode(await reclaim(['ConditionalCheckFailed', 'None', 'None']), 'label-retired');
    });

    test('index 1 failed ⇒ stale (the address item, not a tenant-ID check)', async () => {
      assertCode(await reclaim(['None', 'ConditionalCheckFailed', 'None']), 'stale');
    });

    test('precedence: claim before address', async () => {
      seedLabel(TENANT, 'active');
      assertCode(
        await reclaim(['ConditionalCheckFailed', 'ConditionalCheckFailed', 'None']),
        'label-active',
      );
    });

    test('TransactionConflict on any item ⇒ stale', async () => {
      for (let i = 0; i < 3; i++) {
        const codes = ['None', 'None', 'None'];
        codes[i] = 'TransactionConflict';
        assertCode(await reclaim(codes), 'stale');
      }
    });

    test('index 2 (retire) failed ⇒ the raw cancellation (integrity fault)', async () => {
      const err = await reclaim(['None', 'None', 'ConditionalCheckFailed']);
      assert.equal((err as Error).name, 'TransactionCanceledException');
    });

    test('an unrelated error passes through unchanged', async () => {
      seedAddress('cobras');
      const boom = Object.assign(new Error('slow down'), {
        name: 'ProvisionedThroughputExceededException',
      });
      txFailure = { error: boom };
      await assert.rejects(repo.setTenantPublicSlug(TENANT, TENANT, 'cobras'), (e) => e === boom);
    });
  });
});

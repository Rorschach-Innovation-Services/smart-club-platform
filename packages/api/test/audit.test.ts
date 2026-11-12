/**
 * Audit capture helpers (src/audit.ts): request scope, enrichment helpers, field diffs, masking,
 * caps and the rows buildEntry produces. Pure — no DB. Run with tsx --test.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_CAPS,
  auditMention,
  auditSet,
  auditTarget,
  buildEntry,
  currentAuditScope,
  diffFields,
  auditEntryNamesCohort,
  headlineOnly,
  isCohortAuditEntry,
  newAuditScope,
  redactAuditClub,
  redactScopeFor,
  runAudited,
  scrubAuditCohort,
  scrubAuditEntity,
} from '../src/audit.js';
import {
  AUDIT_KEY_ID_MAX_BYTES,
  auditEntityPointerKey,
  auditEntityPointerPrefix,
} from '../src/keys.js';
import type { AuditActor, AuditDetail, AuditEntry } from '../src/types.js';

const ADMIN: AuditActor = {
  kind: 'user',
  key: 'sub-admin',
  sub: 'sub-admin',
  email: 'admin@union.test',
  role: 'admin',
  via: 'console',
};
const AT = '2026-11-12T08:00:00.000Z';

const scoped = async <T>(fn: () => Promise<T> | T, init = {}) => {
  const scope = newAuditScope({ at: AT, tenant: 'dolphins', actor: ADMIN, ...init });
  const out = await runAudited(scope, fn);
  return { scope, out };
};

describe('request scope', () => {
  test('helpers are a safe no-op outside a scope', () => {
    assert.equal(currentAuditScope(), undefined);
    assert.doesNotThrow(() => {
      auditSet({ action: 'x', counts: { n: 1 } });
      auditTarget({ type: 'umpire', id: 'u-1', op: 'update' });
      auditMention({ type: 'umpire', id: 'u-2' });
    });
    // diffFields still works outside a scope (pure).
    assert.equal(diffFields({ a: 1 }, { a: 2 }).length, 1);
  });

  test('records from deep in the call stack, across awaits', async () => {
    const seam = async () => {
      await new Promise((r) => setTimeout(r, 1));
      auditTarget({ type: 'umpire', id: 'u-a-dende', label: 'A. Dende', op: 'update' });
    };
    const { scope } = await scoped(async () => {
      await seam();
      auditSet({ action: 'umpire.update' });
    });
    assert.equal(scope.action, 'umpire.update');
    assert.deepEqual(
      scope.targets.map((t) => t.id),
      ['u-a-dende'],
    );
    assert.equal(scope.recorded, true);
  });

  test('tenant / actor / visibility do not mark the request as recorded; counts do', async () => {
    const { scope } = await scoped(() =>
      auditSet({ tenant: 't2', actor: ADMIN, visibility: 'operator' }),
    );
    assert.equal(scope.recorded, false);
    assert.equal(scope.tenant, 't2');
    assert.equal(scope.visibility, 'operator');
    const { scope: s2 } = await scoped(() => auditSet({ counts: { imported: 3 } }));
    assert.equal(s2.recorded, true);
  });

  test('a repeated target merges: label and op update, changes append', async () => {
    const { scope } = await scoped(() => {
      auditTarget({ type: 'fixture', id: 's1#f1', op: 'update', changes: [{ field: 'a', to: 1 }] });
      auditTarget({
        type: 'fixture',
        id: 's1#f1',
        label: 'Home v Away',
        op: 'update',
        changes: [{ field: 'b', to: 2 }],
      });
    });
    assert.equal(scope.targets.length, 1);
    assert.equal(scope.targets[0].label, 'Home v Away');
    assert.deepEqual(
      scope.targets[0].changes.map((c) => c.field),
      ['a', 'b'],
    );
  });
});

describe('diffFields', () => {
  test('only changed fields; key order and bookkeeping fields are not changes', () => {
    const before = {
      name: 'A. Dende',
      phone: '1',
      meta: { x: 1, y: 2 },
      version: 3,
      updatedAt: 'a',
    };
    const after = {
      name: 'M. Jooma',
      phone: '1',
      meta: { y: 2, x: 1 },
      version: 4,
      updatedAt: 'b',
    };
    assert.deepEqual(diffFields(before, after), [
      { field: 'name', from: 'A. Dende', to: 'M. Jooma' },
    ]);
  });

  test('create and delete', () => {
    assert.deepEqual(diffFields(null, { name: 'X' }), [{ field: 'name', to: 'X' }]);
    assert.deepEqual(diffFields({ name: 'X' }, null), [{ field: 'name', from: 'X' }]);
  });

  test('fields / ignore narrow the comparison', () => {
    const b = { a: 1, b: 1, c: 1 };
    const a = { a: 2, b: 2, c: 2 };
    assert.deepEqual(
      diffFields(b, a, { fields: ['a', 'b'], ignore: ['b'] }).map((c) => c.field),
      ['a'],
    );
  });

  test('masked fields record a change without values', () => {
    const b = {
      idNumber: '8001015009087',
      address: '1 Road',
      dob: '1980-01-01',
      emergencyPhone: '+27820000003',
      idDocMeta: { objectKey: 'k1' },
      notes: 'Called A. Dende',
      custom: 'secret',
    };
    const a = {
      idNumber: '9001015009087',
      address: '2 Road',
      dob: '1990-01-01',
      emergencyPhone: '+27820000004',
      idDocMeta: { objectKey: 'k2' },
      notes: 'Called M. Jooma',
      custom: 'other',
    };
    const changes = diffFields(b, a, { mask: ['custom'] });
    assert.equal(changes.length, 7);
    for (const c of changes) {
      assert.equal(c.masked, true, c.field);
      assert.ok(!('from' in c) && !('to' in c), c.field);
    }
    const text = JSON.stringify(changes);
    for (const v of ['8001015009087', '1 Road', 'k1', 'Dende', 'secret'])
      assert.ok(!text.includes(v));
  });

  test('ref fields carry the referenced record (and fromRef when the person changed)', () => {
    const [byType] = diffFields(
      { umpireId: 'u-a-dende' },
      { umpireId: 'u-m-jooma' },
      {
        refs: { umpireId: 'umpire' },
      },
    );
    assert.deepEqual(byType.ref, { type: 'umpire', id: 'u-m-jooma' });
    assert.deepEqual(byType.fromRef, { type: 'umpire', id: 'u-a-dende' });
    const [resolved] = diffFields({ umpire: { umpireId: 'u-a', name: 'A' } }, null, {
      refs: { umpire: (v) => ({ type: 'umpire', id: (v as { umpireId: string }).umpireId }) },
    });
    assert.deepEqual(resolved.ref, { type: 'umpire', id: 'u-a' });
    assert.equal(resolved.fromRef, undefined);
  });

  test('values are capped: 200 characters, 20 array items, objects as text', () => {
    const long = 'x'.repeat(500);
    const [c] = diffFields({ a: long }, { a: 'y' });
    assert.equal((c.from as string).length, AUDIT_CAPS.valueChars);
    const [arr] = diffFields({ a: [] }, { a: Array.from({ length: 30 }, (_, i) => i) });
    assert.equal((arr.to as unknown[]).length, AUDIT_CAPS.arrayItems);
    const [obj] = diffFields({ a: { k: 1 } }, { a: { k: 2 } });
    assert.equal(obj.to, '{"k":2}');
  });

  test('inside a scope, shortened values count toward truncated', async () => {
    const { scope } = await scoped(() => {
      auditTarget({
        type: 't',
        id: '1',
        op: 'update',
        changes: diffFields({ a: 'x'.repeat(300) }, { a: 'y' }),
      });
    });
    assert.equal(scope.truncated.values, 1);
  });
});

describe('caps on the scope', () => {
  test('26th target, 41st change and 41st mention are counted, not stored', async () => {
    const { scope } = await scoped(() => {
      for (let i = 0; i < 26; i++) auditTarget({ type: 'player', id: `p${i}`, op: 'delete' });
      auditTarget({
        type: 'player',
        id: 'p0',
        op: 'delete',
        changes: Array.from({ length: 41 }, (_, i) => ({ field: `f${i}`, to: i })),
      });
      for (let i = 0; i < 41; i++) auditMention({ type: 'umpire', id: `u${i}` });
    });
    assert.equal(scope.targets.length, 25);
    assert.equal(scope.targets[0].changes.length, 40);
    assert.equal(scope.mentions.length, 40);
    assert.deepEqual(scope.truncated, { targets: 1, changes: 1, mentions: 1 });
  });
});

/** Every pointer-bearing item in the entry has its E#/C# pointer in the same row set. */
function assertPointerInvariant(
  rows: Array<{ sk: string }>,
  entry: AuditEntry,
  detail: AuditDetail | null,
) {
  const sks = rows.map((r) => r.sk);
  const enc = (s: string) => s.replace(/%/g, '%25').replace(/#/g, '%23');
  const hasE = (type: string, id: string) =>
    sks.some((sk) => sk.startsWith(`E#${enc(type)}#${enc(id)}#`));
  for (const t of entry.targets) {
    assert.ok(hasE(t.type, t.id), `target pointer ${t.type}/${t.id}`);
    if (t.clubId) assert.ok(sks.some((sk) => sk.startsWith(`C#${enc(t.clubId!)}#`)));
  }
  for (const m of detail?.mentions ?? []) assert.ok(hasE(m.type, m.id), `mention ${m.id}`);
  for (const t of detail?.targets ?? [])
    for (const c of t.changes) {
      if (c.from === undefined && c.to === undefined) continue;
      for (const r of [c.ref, c.fromRef]) if (r) assert.ok(hasE(r.type, r.id), `ref ${r.id}`);
    }
}

describe('buildEntry', () => {
  test('rows: pointers, detail, headline; expiry two years on; outcome from status', async () => {
    const { scope } = await scoped(() => {
      auditSet({ action: 'umpire.update' });
      auditTarget({
        type: 'fixture',
        id: 's1#f1',
        label: 'Home v Away',
        op: 'update',
        clubId: 'home-club',
        changes: diffFields(
          { umpireId: 'u-a' },
          { umpireId: 'u-b' },
          { refs: { umpireId: 'umpire' } },
        ),
      });
    });
    const { entry, detail, rows } = buildEntry(scope, {
      status: 200,
      requestId: 'req-1',
      route: { method: 'PUT', pattern: '/series/:id' },
    });
    assert.equal(entry.outcome, 'ok');
    assert.equal(entry.action, 'umpire.update');
    assert.equal(entry.expiresAt, Date.parse(AT) / 1000 + 730 * 86400);
    assert.equal(entry.targets[0].changeCount, 1);
    assert.ok(detail);
    const sks = rows.map((r) => r.sk);
    assert.equal(rows[rows.length - 1].sk, `A#${AT}#${scope.id}`, 'headline last');
    assert.ok(sks.includes(`D#${AT}#${scope.id}`));
    assert.ok(sks.includes(`E#fixture#s1%23f1#${AT}#${scope.id}`), 'ids with # are escaped');
    assert.ok(sks.includes(`E#umpire#u-a#${AT}#${scope.id}`));
    assert.ok(sks.includes(`E#umpire#u-b#${AT}#${scope.id}`));
    assert.ok(sks.includes(`C#home-club#${AT}#${scope.id}`));
    assert.ok(sks.includes(`U#sub-admin#${AT}#${scope.id}`));
    for (const r of rows) {
      assert.equal(r.pk, 'TENANT#dolphins#AUDIT#2026-11');
      assert.equal(r.expiresAt, entry.expiresAt);
      assert.equal(r.entryId, scope.id);
    }
    assertPointerInvariant(rows, entry, detail);
    assert.equal(buildEntry(scope, { status: 409 }).entry.outcome, 'failed');
    assert.equal(buildEntry(scope, { status: 500 }).entry.outcome, 'failed');
    assert.equal(buildEntry(scope, { status: 0, outcome: 'started' }).entry.outcome, 'started');
  });

  test('no detail row without values; empty email dropped; platform partition', () => {
    const scope = newAuditScope({
      at: AT,
      actor: { ...ADMIN, email: '' },
      visibility: 'operator',
    });
    const { entry, detail, rows } = buildEntry(scope, { status: 201, action: 'tenant.create' });
    assert.equal(detail, null);
    assert.equal(entry.actor.email, undefined);
    assert.equal(entry.action, 'tenant.create', 'falls back to the registry action');
    assert.equal(entry.tenant, '*');
    assert.ok(rows.every((r) => r.pk === 'PLATFORM#AUDIT#2026-11'));
    assert.deepEqual(
      rows.map((r) => r.sk[0]),
      ['U', 'A'],
    );
  });

  test('an entry at every cap stays within 100 rows and 100 KB, and never stores a value without its pointer', async () => {
    const { scope } = await scoped(() => {
      for (let t = 0; t < 25; t++)
        auditTarget({
          type: 'fixture',
          id: `s#f${t}`,
          label: 'L'.repeat(300),
          op: 'update',
          clubId: `club-${t}`,
          changes: Array.from({ length: 40 }, (_, c) => ({
            field: `f${c}`,
            from: 'a'.repeat(250),
            to: 'b'.repeat(250),
            // One person per target: 25 refs compete with 40 mentions for the row budget.
            ...(c === 0 ? { ref: { type: 'umpire', id: `u-${t}` } } : {}),
          })),
        });
      for (let m = 0; m < 40; m++)
        auditMention({ type: 'scorer', id: `sc-${m}`, label: `Scorer ${m}` });
    });
    const { entry, detail, rows } = buildEntry(scope, { status: 200 });
    assert.ok(rows.length <= AUDIT_CAPS.rows, `${rows.length} rows`);
    assert.equal(new Set(rows.map((r) => `${r.pk}|${r.sk}`)).size, rows.length, 'unique keys');
    assert.equal(entry.targets.length, 25);
    assert.ok(entry.targets.every((t) => (t.label ?? '').length <= AUDIT_CAPS.valueChars));
    assert.ok((entry.truncated?.rows ?? 0) > 0, 'refs beyond the row budget lost their values');
    assert.ok((entry.truncated?.detail ?? 0) > 0, 'detail trimmed to its byte budget');
    assert.ok((entry.truncated?.values ?? 0) > 0);
    const detailRow = rows.find((r) => r.sk.startsWith('D#'))!;
    assert.ok(
      new TextEncoder().encode(JSON.stringify(detailRow)).length <= AUDIT_CAPS.detailBytes + 1024,
    );
    assertPointerInvariant(rows, entry, detail);
    const stored = detail!.targets.flatMap((t) => t.changes).length;
    assert.equal(
      entry.targets.reduce((n, t) => n + t.changeCount, 0),
      stored,
      'changeCount matches what was stored',
    );
  });
});

describe('erasure rewrites', () => {
  const entry = (targets: AuditEntry['targets']): AuditEntry => ({
    id: 'e1',
    at: AT,
    tenant: 'dolphins',
    actor: ADMIN,
    action: 'x',
    status: 200,
    outcome: 'ok',
    visibility: 'tenant',
    targets,
    expiresAt: 1,
  });

  test('scrubAuditEntity strips the record and every change naming it; blankIds blanks the id', () => {
    const e = entry([
      { type: 'player', id: 'nk-1', label: 'Sipho Erase', op: 'update', changeCount: 1 },
      { type: 'fixture', id: 'f', label: 'H v A', op: 'update', changeCount: 1 },
    ]);
    const d: AuditDetail = {
      targets: [
        { type: 'player', id: 'nk-1', changes: [{ field: 'lastName', from: 'Erase', to: 'Gone' }] },
        {
          type: 'fixture',
          id: 'f',
          changes: [
            { field: 'captain', from: 'X', to: 'Sipho', ref: { type: 'player', id: 'nk-1' } },
          ],
        },
      ],
      mentions: [{ type: 'player', id: 'nk-1', label: 'Sipho Erase' }],
    };
    const out = scrubAuditEntity(e, d, 'player', new Set(['nk-1']), {
      placeholder: '[removed]',
      blankIds: true,
    });
    assert.equal(out.changed, true);
    const text = JSON.stringify([out.entry, out.detail]);
    for (const v of ['nk-1', 'Sipho', 'Erase']) assert.ok(!text.includes(v), v);
    assert.equal(out.entry.targets[1].label, 'H v A', 'other targets keep their label');
    assert.equal(out.detail!.mentions[0].label, '[removed]');
    assert.equal(
      scrubAuditEntity(out.entry, out.detail, 'player', new Set(['nk-1']), {
        placeholder: '[removed]',
      }).changed,
      false,
      'idempotent',
    );
  });

  test('redactAuditClub keeps the surviving club side of a two-club entry', () => {
    const e = entry([
      {
        type: 'clearance',
        id: 'c1',
        label: 'Gone CC → Survivor CC',
        op: 'create',
        clubId: 'gone',
        changeCount: 1,
      },
      { type: 'club', id: 'survivor', label: 'Survivor CC', op: 'update', changeCount: 1 },
    ]);
    const d: AuditDetail = {
      targets: [
        { type: 'clearance', id: 'c1', changes: [{ field: 'fromClub', to: 'Gone CC' }] },
        {
          type: 'club',
          id: 'survivor',
          changes: [{ field: 'name', from: 'S', to: 'Survivor CC' }],
        },
      ],
      mentions: [{ type: 'club', id: 'gone', label: 'Gone CC' }],
    };
    const out = redactAuditClub(e, d, 'gone', { placeholder: '[removed]' });
    assert.ok(!JSON.stringify([out.entry, out.detail]).includes('Gone CC'));
    assert.equal(out.entry.targets[1].label, 'Survivor CC');
    assert.equal(out.detail!.targets[1].changes[0].to, 'Survivor CC');
  });

  test('isCohortAuditEntry: cohort-only entries go; user, config and link entries stay', () => {
    const t = (type: string) => ({ type, id: 'x', op: 'update', changeCount: 0 });
    assert.equal(isCohortAuditEntry({ action: 'player.update', targets: [t('player')] }), true);
    assert.equal(
      isCohortAuditEntry({ action: 'user.invite', targets: [t('user'), t('club')] }),
      false,
    );
    assert.equal(isCohortAuditEntry({ action: 'link.copy', targets: [t('club')] }), false);
    assert.equal(isCohortAuditEntry({ action: 'settings.update', targets: [] }), false);
  });
});

describe('review fixes', () => {
  test('a pinned scope ignores later tenant/actor changes but still takes the action', async () => {
    const { scope } = await scoped(() => {
      currentAuditScope()!.pinned = true;
      auditSet({
        tenant: 'elsewhere',
        actor: { kind: 'user', key: 'sub-late', via: 'console' },
        action: 'umpire.delete',
      });
    });
    assert.equal(scope.tenant, 'dolphins');
    assert.equal(scope.actor?.key, 'sub-admin');
    assert.equal(scope.action, 'umpire.delete');
  });

  test('redactScopeFor strips the erased type; a player id is blanked and gets no pointer', async () => {
    const { scope } = await scoped(() => {
      auditTarget({
        type: 'player',
        id: 'nk-1',
        label: 'Sipho',
        op: 'erase',
        changes: [{ field: 'firstName', from: 'Sipho' }],
      });
      auditTarget({
        type: 'squad-request',
        id: 'sq-1',
        label: 'Alpha 1st XI',
        op: 'update',
        changes: [{ field: 'captain', to: 'Sipho', ref: { type: 'player', id: 'nk-1' } }],
      });
      auditMention({ type: 'player', id: 'nk-1', label: 'Sipho' });
    });
    redactScopeFor(scope, 'player', { blankIds: true });
    const set = buildEntry(scope, { status: 200 });
    const text = JSON.stringify(set.rows);
    assert.ok(!text.includes('Sipho') && !text.includes('nk-1'), text);
    assert.ok(text.includes('Alpha 1st XI'), 'another record keeps its label');
    assert.ok(!set.rows.some((r) => r.sk.startsWith('E#player#')), 'no pointer for a blank id');
  });

  test('headlineOnly keeps who/when/what and nothing naming a record', async () => {
    const { scope } = await scoped(() => {
      auditSet({ action: 'venue.save', counts: { n: 1 } });
      auditTarget({ type: 'venue', id: 'v1', label: 'Kingsmead', op: 'save' });
      auditMention({ type: 'umpire', id: 'u1', label: 'Ump' });
    });
    const set = headlineOnly(buildEntry(scope, { status: 200 }));
    assert.equal(set.rows.length, 1);
    assert.ok(set.rows[0].sk.startsWith('A#'));
    assert.equal(set.entry.action, 'venue.save');
    assert.deepEqual(set.entry.counts, { n: 1 });
    assert.deepEqual(set.entry.targets, []);
    assert.equal(set.entry.truncated?.rows, 2);
    assert.ok(!JSON.stringify(set.rows).includes('Kingsmead'));
  });

  test('an over-long id is hashed in pointer keys, deterministically, and stays distinct', () => {
    const long = 'x'.repeat(1000);
    const k = auditEntityPointerKey('dolphins', 'venue', long, AT, 'e1');
    assert.ok(Buffer.byteLength(k.sk) < 400, k.sk);
    assert.ok(k.sk.startsWith(auditEntityPointerPrefix('venue', long)));
    assert.equal(auditEntityPointerPrefix('venue', long), auditEntityPointerPrefix('venue', long));
    assert.notEqual(
      auditEntityPointerPrefix('venue', long),
      auditEntityPointerPrefix('venue', `${long}y`),
    );
    const short = 'y'.repeat(AUDIT_KEY_ID_MAX_BYTES);
    assert.equal(auditEntityPointerPrefix('venue', short), `E#venue#${short}#`, 'kept verbatim');
  });

  test('cohort clear: an entry that stays but names a cohort record has it scrubbed', () => {
    const entry = {
      targets: [
        { type: 'user', id: 'sub-y', label: 'y@test', op: 'update', changeCount: 1 },
        { type: 'club', id: 'cc', label: 'Cohort CC', op: 'update', changeCount: 0 },
      ],
      action: 'user.update',
    } as unknown as AuditEntry;
    const detail: AuditDetail = {
      targets: [
        {
          type: 'user',
          id: 'sub-y',
          changes: [{ field: 'captain', to: 'Cohort Player', ref: { type: 'player', id: 'nk' } }],
        },
      ],
      mentions: [{ type: 'player', id: 'nk', label: 'Cohort Player' }],
    };
    assert.equal(isCohortAuditEntry(entry), false, 'stays');
    assert.equal(auditEntryNamesCohort(entry, detail), true);
    const out = scrubAuditCohort(entry, detail, { placeholder: '[removed]' });
    assert.ok(out.changed);
    const text = JSON.stringify(out);
    assert.ok(!text.includes('Cohort Player') && !text.includes('Cohort CC'), text);
    assert.equal(out.entry.targets[0].label, 'y@test');
    assert.equal(
      auditEntryNamesCohort(
        { targets: [{ type: 'user', id: 'u', op: 'x', changeCount: 0 }] },
        { targets: [], mentions: [{ type: 'umpire', id: 'u1' }] },
      ),
      false,
    );
  });
});

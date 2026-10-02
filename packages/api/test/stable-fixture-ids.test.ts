/**
 * Stable fixture ids across re-imports (fixture-identity.ts + the importer's
 * stabiliseFixtureIds). A fixture id is half of its medicoach sync ref, so a re-import of
 * the same sheet with a row inserted mid-section must keep every existing id.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Series } from '../src/types.js';
import {
  reconcileFixtureIds,
  fixtureSyncRef,
  type IdentityFixture,
} from '../src/fixture-identity.js';

const { stabiliseFixtureIds, parseArgs } = await import('../src/import-planb-fixtures.js');

const row = (date: string, home: string, away: string, time?: string): IdentityFixture => ({
  date,
  home,
  away,
  ...(time ? { time } : {}),
});

/** What the importer's buildSeries produces: provisional row-order ids. */
const built = (rows: IdentityFixture[]) => rows.map((r, i) => ({ ...r, id: `f${i + 1}` }));

describe('reconcileFixtureIds', () => {
  const sheet = [
    row('2026-10-04', 'a', 'b', '09:00'),
    row('2026-10-04', 'c', 'd', '09:00'),
    row('2026-10-11', 'b', 'c', '13:30'),
    row('2026-10-11', 'd', 'a', '13:30'),
  ];

  test('a row inserted mid-section keeps every existing id; the new row gets max+1', () => {
    const stored = built(sheet);
    const amended = built([
      sheet[0],
      sheet[1],
      row('2026-10-05', 'a', 'c', '10:00'),
      ...sheet.slice(2),
    ]);
    const r = reconcileFixtureIds(stored, amended);
    assert.deepEqual(
      r.fixtures.map((f) => `${f.id} ${f.date} ${f.home}v${f.away}`),
      [
        'f1 2026-10-04 avb',
        'f2 2026-10-04 cvd',
        'f5 2026-10-05 avc',
        'f3 2026-10-11 bvc',
        'f4 2026-10-11 dva',
      ],
    );
    assert.equal(r.matched, 4);
    assert.deepEqual(r.added, ['f5']);
    assert.deepEqual(r.removed, []);
  });

  test('home/away swapped on the sheet still matches (unordered pair)', () => {
    const stored = built(sheet);
    const swapped = built([row('2026-10-04', 'b', 'a', '09:00'), ...sheet.slice(1)]);
    const r = reconcileFixtureIds(stored, swapped);
    assert.equal(r.fixtures[0].id, 'f1');
    assert.equal(r.added.length, 0);
  });

  test('a pair meeting twice on one day is told apart by kick-off time', () => {
    const stored = [
      { id: 'f1', ...row('2026-10-04', 'a', 'b', '09:00') },
      { id: 'f2', ...row('2026-10-04', 'a', 'b', '14:00') },
    ];
    const incoming = built([
      row('2026-10-04', 'a', 'b', '14:00'),
      row('2026-10-04', 'a', 'b', '09:00'),
    ]);
    const r = reconcileFixtureIds(stored, incoming);
    assert.deepEqual(
      r.fixtures.map((f) => `${f.id}@${f.time}`),
      ['f2@14:00', 'f1@09:00'],
    );
  });

  test('a removed row is reported, and its id is never reused for a new row', () => {
    const stored = built(sheet);
    const incoming = built([sheet[0], sheet[1], sheet[3], row('2026-10-18', 'a', 'b')]);
    const r = reconcileFixtureIds(stored, incoming);
    assert.deepEqual(
      r.removed.map((f) => f.id),
      ['f3'],
    );
    assert.deepEqual(
      r.fixtures.map((f) => f.id),
      ['f1', 'f2', 'f4', 'f5'],
    );
  });

  test('sync-owned fields ride over to the matched incoming row', () => {
    const stored = [
      {
        id: 'f7',
        ...row('2026-10-04', 'a', 'b'),
        syncRef: 'smartclub:dolphins:fixture:recipe:premier:t20:sf1',
        schedule: { changedAt: '2026-10-01T10:00:00.000Z' },
      },
    ];
    const r = reconcileFixtureIds(stored, built([row('2026-10-04', 'a', 'b')]));
    assert.equal(r.fixtures[0].id, 'f7');
    assert.equal(r.fixtures[0].syncRef, 'smartclub:dolphins:fixture:recipe:premier:t20:sf1');
    assert.deepEqual(r.fixtures[0].schedule, { changedAt: '2026-10-01T10:00:00.000Z' });
  });

  test('a first import (nothing stored) writes f1..fN', () => {
    const r = reconcileFixtureIds([], built(sheet));
    assert.deepEqual(
      r.fixtures.map((f) => f.id),
      ['f1', 'f2', 'f3', 'f4'],
    );
    assert.deepEqual(r.added, []);
  });
});

describe('stabiliseFixtureIds (importer)', () => {
  test('re-import with one row inserted: existing ids unchanged, removed rows reported with refs', () => {
    const series = (fixtures: IdentityFixture[]) =>
      ({ id: 's-planb-premier-men-t20-g1', fixtures }) as unknown as Series;
    const stored = series(
      built([
        row('2026-10-04', 'a', 'b', '09:00'),
        row('2026-10-11', 'c', 'd', '09:00'),
        row('2026-10-18', 'a', 'd', '09:00'),
      ]),
    );
    const incomingFixtures = built([
      row('2026-10-04', 'a', 'b', '09:00'),
      row('2026-10-05', 'b', 'c', '09:00'), // inserted
      row('2026-10-11', 'c', 'd', '09:00'),
    ]) as Array<
      IdentityFixture & { id: string; round: number; date: string; home: string; away: string }
    >;
    const b = { series: series(incomingFixtures), fixtures: incomingFixtures };
    const out = stabiliseFixtureIds('dolphins', [b as never], [stored]);
    assert.deepEqual(
      incomingFixtures.map((f) => f.id),
      ['f1', 'f4', 'f2'],
    );
    assert.equal(out.matched, 2);
    assert.equal(out.added, 1);
    assert.deepEqual(out.removedRefs, ['smartclub:dolphins:fixture:s-planb-premier-men-t20-g1:f3']);
    assert.equal(
      fixtureSyncRef('dolphins', 's-x', { id: 'f1', syncRef: 'r' }),
      'r',
      'an explicit syncRef wins over the derived ref',
    );
  });

  test('--allow-sync-break parses', () => {
    assert.equal(parseArgs(['--revert', '--allow-sync-break']).allowSyncBreak, true);
    assert.equal(parseArgs(['--revert']).allowSyncBreak, false);
  });
});

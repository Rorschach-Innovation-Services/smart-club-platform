/**
 * seed-cohort — block-id reconciliation on a re-seed.
 *
 * The seed namespaces block ids by calendar (`cal-2026-27-block-1`) so two seeded seasons
 * in one tenant stay distinguishable. But a calendar is merged BY ID, so a re-seed
 * replaces its blocks in place — and carrying new ids there would dangle everything
 * already pointing at the old ones, none of it loudly:
 *
 *   - `Series.schedule.blockId` is persisted per series, and `addFixture` (src/admin.tsx)
 *     reads it back to date the next round. A miss silently falls through to the legacy
 *     "+7 days" path, straight into the mid-season break season calendars exist to remove.
 *   - An operator-authored structure bound to that calendar starts failing
 *     `validateCompetitions`, which runs on every `PUT /platform/tenants/:slug` — taking
 *     down the re-seed and leaving the tenant unsaveable from the console.
 *
 * So the rule is: namespace on CREATE, never rename on re-seed. This is that rule.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { CompetitionStructure, SeasonCalendar } from '../src/types.js';

// Env before import — `seed-cohort` pulls in `repo`, which reads TABLE_NAME at module
// load. Nothing here touches the table; the function under test is pure.
process.env.TABLE_NAME = 'SmartClubSeedCohortTest';
process.env.AWS_REGION ??= 'localhost';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

let keepExistingBlockIds: (typeof import('../src/seed-cohort.js'))['keepExistingBlockIds'];
before(async () => {
  ({ keepExistingBlockIds } = await import('../src/seed-cohort.js'));
});

const cal = (id: string, blockIds: string[], startYear = 2026): SeasonCalendar =>
  ({
    id,
    label: `${startYear}/${(startYear + 1) % 100} season`,
    timezone: 'Africa/Johannesburg',
    blocks: blockIds.map((b, i) => ({
      id: b,
      label: i === 0 ? 'First half' : 'Second half',
      start: `${startYear + i}-08-01`,
      end: `${startYear + i}-12-19`,
    })),
    breaks: [],
    excludeDates: [],
  }) as SeasonCalendar;

const structure = (blockIds: string[]): CompetitionStructure =>
  ({
    id: 'st-split',
    name: 'Split league',
    version: 1,
    calendarId: 'cal-2026-27',
    stages: blockIds.map((b, i) => ({
      id: `s${i + 1}`,
      name: `Stage ${i + 1}`,
      format: { kind: 'round-robin', legs: 1 },
      entrants: { kind: 'all-registered' },
      schedule: { blockId: b, cadence: { kind: 'weekly' } },
    })),
  }) as CompetitionStructure;

describe('re-seeding keeps the block ids a tenant already has', () => {
  const existing = cal('cal-2026-27', ['block-1', 'block-2']);
  const incoming = cal('cal-2026-27', ['cal-2026-27-block-1', 'cal-2026-27-block-2']);

  it('keeps the stored block ids rather than renaming them', () => {
    const out = keepExistingBlockIds(existing, incoming, [
      structure(['cal-2026-27-block-1', 'cal-2026-27-block-2']),
    ]);
    assert.deepEqual(
      out.calendar.blocks.map((b) => b.id),
      ['block-1', 'block-2'],
    );
  });

  it('still takes the incoming dates and labels — only the ids are pinned', () => {
    const out = keepExistingBlockIds(existing, incoming, []);
    assert.equal(out.calendar.blocks[0].start, incoming.blocks[0].start);
    assert.equal(out.calendar.blocks[0].label, incoming.blocks[0].label);
  });

  it('repoints the incoming structures at the kept ids', () => {
    // Without this the structures written in the same run would name blocks the stored
    // calendar doesn't have — `validateCompetitions` would reject the whole re-seed.
    const out = keepExistingBlockIds(existing, incoming, [
      structure(['cal-2026-27-block-1', 'cal-2026-27-block-2']),
    ]);
    assert.deepEqual(
      out.structures[0].stages.map((s) => s.schedule.blockId),
      ['block-1', 'block-2'],
    );
  });

  it('leaves a blockId it does not recognise alone', () => {
    // An operator-authored stage pointing somewhere else is not this function's business.
    const out = keepExistingBlockIds(existing, incoming, [structure(['somewhere-else'])]);
    assert.equal(out.structures[0].stages[0].schedule.blockId, 'somewhere-else');
  });

  it('gives a genuinely new block its namespaced id', () => {
    // Nothing can be pointing at a block the tenant never had, so there is nothing to
    // protect — and it should get the unique id a fresh calendar would.
    const threeBlocks = cal('cal-2026-27', ['a', 'b', 'cal-2026-27-block-3']);
    const out = keepExistingBlockIds(existing, threeBlocks, []);
    assert.deepEqual(
      out.calendar.blocks.map((b) => b.id),
      ['block-1', 'block-2', 'cal-2026-27-block-3'],
    );
  });

  it('follows the LABEL when an operator has reordered the stored blocks', () => {
    // The hazard positional matching creates. `block-2` is the id every persisted
    // Series knows as the January window; matched by index against a reordered
    // calendar it comes back carrying August dates, and `addFixture` starts
    // scheduling a January competition in August with nothing reported anywhere.
    const reordered = {
      ...existing,
      blocks: [existing.blocks[1], existing.blocks[0]], // Second half first
    } as SeasonCalendar;
    const out = keepExistingBlockIds(reordered, incoming, [
      structure(['cal-2026-27-block-1', 'cal-2026-27-block-2']),
    ]);
    const byId = new Map(out.calendar.blocks.map((b) => [b.id, b]));
    assert.equal(byId.get('block-1')!.label, 'First half');
    assert.equal(byId.get('block-1')!.start, incoming.blocks[0].start);
    assert.equal(byId.get('block-2')!.label, 'Second half');
    assert.equal(byId.get('block-2')!.start, incoming.blocks[1].start);
  });

  it('does not let an unmatched block steal an id another block already claimed', () => {
    // Operator deleted "First half". Matching Second half → block-2 by label must
    // consume it, so the incoming First half falls through to its own new id rather
    // than positionally grabbing block-2 and relocating the January window.
    const reduced = { ...existing, blocks: [existing.blocks[1]] } as SeasonCalendar;
    const out = keepExistingBlockIds(reduced, incoming, [
      structure(['cal-2026-27-block-1', 'cal-2026-27-block-2']),
    ]);
    assert.deepEqual(
      out.calendar.blocks.map((b) => `${b.label}=${b.id}`),
      ['First half=cal-2026-27-block-1', 'Second half=block-2'],
    );
  });

  it('falls back to position when labels match nothing', () => {
    // An operator who renamed the blocks gets best-effort, which is what the old
    // behaviour always was — and still no collisions.
    const renamed = {
      ...existing,
      blocks: existing.blocks.map((b, i) => ({ ...b, label: `Term ${i + 1}` })),
    } as SeasonCalendar;
    const out = keepExistingBlockIds(renamed, incoming, []);
    assert.deepEqual(
      out.calendar.blocks.map((b) => b.id),
      ['block-1', 'block-2'],
    );
  });

  it('is idempotent — a second re-seed changes nothing', () => {
    const once = keepExistingBlockIds(existing, incoming, [
      structure(['cal-2026-27-block-1', 'cal-2026-27-block-2']),
    ]);
    const twice = keepExistingBlockIds(once.calendar, once.calendar, once.structures);
    assert.deepEqual(
      twice.calendar.blocks.map((b) => b.id),
      once.calendar.blocks.map((b) => b.id),
    );
    assert.deepEqual(
      twice.structures[0].stages.map((s) => s.schedule.blockId),
      once.structures[0].stages.map((s) => s.schedule.blockId),
    );
  });
});

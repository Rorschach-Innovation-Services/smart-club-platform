import { describe, it, expect } from 'vitest';
import { ApiError } from './api';
import { seasonConflictMessage } from './generate-feedback';
import type { Clash } from './types';

const clash = (round: number, ground: string, seriesName?: string): Clash => ({
  fixtureId: `f${round}`,
  round,
  ground,
  date: '2026-10-03',
  home: 'Home XI',
  away: 'Away XI',
  with: { seriesId: `s-${round}`, seriesName, fixtureId: `x${round}` },
});

describe('seasonConflictMessage', () => {
  it('lists up to three venue clashes and says where to fix them', () => {
    const err = new ApiError(409, 'Change blocked — 4 venue clashes', 'venue_clash', {
      clashes: [
        clash(3, 'Kingsmead', 'Premier T20'),
        clash(4, 'Chatsworth'),
        clash(5, 'Pietermaritzburg Oval', 'Women 50 Over'),
        clash(6, 'Kingsmead', 'Premier T20'),
      ],
    });
    expect(seasonConflictMessage(err)).toBe(
      'Round 3 · Kingsmead · Home XI v Away XI clashes with Premier T20; ' +
        'Round 4 · Chatsworth · Home XI v Away XI clashes with s-4; ' +
        'Round 5 · Pietermaritzburg Oval · Home XI v Away XI clashes with Women 50 Over' +
        ' (and 1 more). Fix these in the fixtures list',
    );
  });

  it('explains a released-overwrite refusal', () => {
    const err = new ApiError(
      409,
      '1 of this stage’s series has been released',
      'released_overwrite',
      {
        seriesIds: ['s-1'],
      },
    );
    expect(seasonConflictMessage(err)).toBe(
      "Some of this stage's fixtures are released; the console will ask before replacing them",
    );
  });

  it('says to confirm entrants when the stage is still waiting on them', () => {
    const err = new ApiError(409, 'stage is awaiting entrants', 'awaiting_entrants', {
      reason: 'no confirmed groups',
    });
    expect(seasonConflictMessage(err)).toBe(
      "This stage's teams haven't been confirmed yet. Open the stage and Confirm entrants first.",
    );
  });

  it('quotes the fit summary once, without doubling the engine advice', () => {
    const withAdvice = new ApiError(
      409,
      "Pools · Group A: 9 rounds · every Saturday — Block 1 fits 6 at this cadence; 3 rounds don't fit. Shorten the cadence, start earlier, or extend Block 1.",
      'does_not_fit',
    );
    expect(seasonConflictMessage(withAdvice)).toBe(
      "The fixtures don't fit the playing block: Pools · Group A: 9 rounds · every Saturday — Block 1 fits 6 at this cadence; 3 rounds don't fit. Shorten the cadence, start earlier, or extend Block 1.",
    );
    const bare = new ApiError(409, 'Final · Group 1: no dates left', 'does_not_fit');
    expect(seasonConflictMessage(bare)).toBe(
      "The fixtures don't fit the playing block: Final · Group 1: no dates left. Shorten the cadence, reduce rounds, or extend the block in the season calendar.",
    );
  });

  it('sends a missing block to the operator, naming the setting to fix', () => {
    const err = new ApiError(
      409,
      'Final points at a playing block that no longer exists on this calendar',
      'no_block',
    );
    expect(seasonConflictMessage(err)).toBe(
      'This stage points at a playing block that no longer exists on the calendar. Ask your operator to fix the structure\'s "Plays in" setting.',
    );
  });

  it('explains an unbound competition and the two ways out', () => {
    const err = new ApiError(
      409,
      'competition no longer bound to this league',
      'competition_unbound',
    );
    expect(seasonConflictMessage(err)).toBe(
      "This league's competition was removed from the operator console. Quick-start a new season, or ask your operator to re-bind one.",
    );
  });

  it('never shows a code to the admin', () => {
    for (const code of ['awaiting_entrants', 'does_not_fit', 'no_block', 'competition_unbound']) {
      const msg = seasonConflictMessage(new ApiError(409, 'x', code)) ?? '';
      expect(msg).not.toContain(code);
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it('leaves any other 409, and non-409s, to the generic copy', () => {
    expect(seasonConflictMessage(new ApiError(409, 'season run changed; refetch'))).toBeNull();
    expect(seasonConflictMessage(new ApiError(400, 'bad', 'venue_clash'))).toBeNull();
    expect(seasonConflictMessage(new Error('boom'))).toBeNull();
  });

  it('names the series already replaced when a refusal lands part-way through', () => {
    const err = new ApiError(409, 'Change blocked — 1 venue clash', 'venue_clash', {
      clashes: [clash(3, 'Kingsmead', 'Premier T20')],
      written: ['s-run-pools-g1', 's-run-pools-g2'],
      releasedOverwritten: ['s-run-pools-g1'],
    });
    expect(seasonConflictMessage(err)).toBe(
      'Round 3 · Kingsmead · Home XI v Away XI clashes with Premier T20. Fix these in the fixtures list. ' +
        '2 series were already replaced: s-run-pools-g1, s-run-pools-g2',
    );
    // Any refusal carrying `written` says so, even one without its own copy.
    const other = new ApiError(409, 'series changed; refetch', undefined, { written: ['s-1'] });
    expect(seasonConflictMessage(other)).toBe(
      'series changed; refetch. 1 series was already replaced: s-1',
    );
  });

  it('does not double the full stop when a sentence-ending refusal also names what was written', () => {
    const err = new ApiError(409, 'x', 'awaiting_entrants', { written: ['s-1'] });
    expect(seasonConflictMessage(err)).toBe(
      "This stage's teams haven't been confirmed yet. Open the stage and Confirm entrants first. 1 series was already replaced: s-1",
    );
  });
});

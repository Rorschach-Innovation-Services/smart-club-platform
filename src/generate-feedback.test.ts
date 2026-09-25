import { describe, it, expect } from 'vitest';
import { ApiError } from './api';
import { generateConflictMessage } from './generate-feedback';
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

describe('generateConflictMessage', () => {
  it('lists up to three venue clashes and says where to fix them', () => {
    const err = new ApiError(409, 'Change blocked — 4 venue clashes', 'venue_clash', {
      clashes: [
        clash(3, 'Kingsmead', 'Premier T20'),
        clash(4, 'Chatsworth'),
        clash(5, 'Pietermaritzburg Oval', 'Women 50 Over'),
        clash(6, 'Kingsmead', 'Premier T20'),
      ],
    });
    expect(generateConflictMessage(err)).toBe(
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
    expect(generateConflictMessage(err)).toBe(
      "Some of this stage's fixtures are released; the console will ask before replacing them",
    );
  });

  it('leaves any other 409, and non-409s, to the generic copy', () => {
    expect(generateConflictMessage(new ApiError(409, 'season run changed; refetch'))).toBeNull();
    expect(
      generateConflictMessage(new ApiError(409, 'stage is awaiting entrants', 'awaiting_entrants')),
    ).toBeNull();
    expect(generateConflictMessage(new ApiError(400, 'bad', 'venue_clash'))).toBeNull();
    expect(generateConflictMessage(new Error('boom'))).toBeNull();
  });

  it('names the series already replaced when a refusal lands part-way through', () => {
    const err = new ApiError(409, 'Change blocked — 1 venue clash', 'venue_clash', {
      clashes: [clash(3, 'Kingsmead', 'Premier T20')],
      written: ['s-run-pools-g1', 's-run-pools-g2'],
      releasedOverwritten: ['s-run-pools-g1'],
    });
    expect(generateConflictMessage(err)).toBe(
      'Round 3 · Kingsmead · Home XI v Away XI clashes with Premier T20. Fix these in the fixtures list. ' +
        '2 series were already replaced: s-run-pools-g1, s-run-pools-g2',
    );
    // Any refusal carrying `written` says so, even one without its own copy.
    const other = new ApiError(409, 'series changed; refetch', undefined, { written: ['s-1'] });
    expect(generateConflictMessage(other)).toBe(
      'series changed; refetch. 1 series was already replaced: s-1',
    );
  });
});

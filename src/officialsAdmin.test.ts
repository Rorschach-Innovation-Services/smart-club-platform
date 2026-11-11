import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { toastCopy } from './error-copy';
import { officialNameTakenMessage } from './officialsAdmin';

describe('officialNameTakenMessage', () => {
  const taken = new ApiError(409, 'A.Ngubane already answers to that name', 'umpire_alias_taken', {
    umpireId: 'u-a-ngubane',
    displayName: 'A.Ngubane',
  });

  it('names the existing entry when an add is refused', () => {
    const copy = toastCopy(taken, 'Could not add the umpire', {
      errorMessage: (e) => officialNameTakenMessage('umpire', e, 'add'),
      rawConflict: true,
    });
    expect(copy).toContain('“A.Ngubane” is already on the register');
    expect(copy).not.toContain('Someone else changed this');
  });

  it('points an edit at a different name or a merge', () => {
    expect(officialNameTakenMessage('scorer', taken, 'edit')).toContain('Merge…');
  });

  it('still reads sensibly when the server sends no name', () => {
    const bare = new ApiError(409, 'x is already in the register', 'scorer_name_taken');
    expect(officialNameTakenMessage('scorer', bare, 'add')).toMatch(/^Another scorer is already/);
  });

  it('leaves other errors to the generic copy', () => {
    expect(
      officialNameTakenMessage('umpire', new ApiError(409, 'series changed; refetch'), 'add'),
    ).toBeNull();
  });
});

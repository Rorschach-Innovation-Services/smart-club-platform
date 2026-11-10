import { describe, it, expect } from 'vitest';
import {
  comparablePhone,
  findPossibleMatches,
  initialAndSurname,
  umpireSheetName,
  type MatchableOfficial,
} from './officialMatches';

const rec = (over: Partial<MatchableOfficial> & { id: string }): MatchableOfficial => ({
  displayName: over.id,
  active: true,
  ...over,
});

describe('officialMatches', () => {
  it('normalises names and phones', () => {
    expect(umpireSheetName(' andile thabo ', 'Ngubane')).toBe('A.Ngubane');
    expect(initialAndSurname('A.Ngubane')).toEqual({ initial: 'a', surname: 'ngubane' });
    expect(initialAndSurname('Andile Ngubane')).toEqual({ initial: 'a', surname: 'ngubane' });
    expect(initialAndSurname('Ngubane')).toBeNull();
    expect(comparablePhone('+27 82 123 4567')).toBe('0821234567');
    expect(comparablePhone('082-123-4567')).toBe('0821234567');
  });

  it('ranks phone > name > surname-initial and matches A.Ngubane to Andile Ngubane', () => {
    const subject = {
      id: 'p',
      displayName: 'A.Ngubane',
      fullName: 'Andile Ngubane',
      phone: '0821234567',
    };
    const register = [
      rec({ id: 'u-sheet', displayName: 'A.Ngubane', aliases: ['angubane'] }),
      rec({ id: 'u-full', displayName: 'Ayanda Ngubane' }),
      rec({ id: 'u-phone', displayName: 'Z.Other', phone: '+27821234567' }),
      rec({ id: 'u-none', displayName: 'B.Ngubane' }),
    ];
    expect(findPossibleMatches(subject, register)).toEqual([
      { id: 'u-phone', displayName: 'Z.Other', reason: 'phone' },
      { id: 'u-sheet', displayName: 'A.Ngubane', reason: 'name' },
      { id: 'u-full', displayName: 'Ayanda Ngubane', reason: 'surname-initial' },
    ]);
  });

  it('matches an alias exactly and a scorer full-name variant by surname + initial', () => {
    const umpire = findPossibleMatches({ id: 'p', displayName: 'S.Naidoo' }, [
      rec({ id: 'u1', displayName: 'Sam N', aliases: ['snaidoo'] }),
    ]);
    expect(umpire.map((m) => m.reason)).toEqual(['name']);
    const scorer = findPossibleMatches({ id: 'p', displayName: 'Priya Govender' }, [
      rec({ id: 's1', displayName: 'P Govender' }),
    ]);
    expect(scorer.map((m) => m.reason)).toEqual(['surname-initial']);
  });

  it('never offers inactive, merged, erased, pending or self records; caps at 5', () => {
    const subject = { id: 'p', displayName: 'A.Ngubane' };
    const register = [
      rec({ id: 'p', displayName: 'A.Ngubane' }),
      rec({ id: 'off', displayName: 'A.Ngubane', active: false }),
      rec({ id: 'merged', displayName: 'A.Ngubane', mergedInto: 'x' }),
      rec({ id: 'erased', displayName: 'A.Ngubane', erasedAt: 'now' }),
      rec({ id: 'pend', displayName: 'A.Ngubane', pending: true }),
      ...[1, 2, 3, 4, 5, 6].map((n) => rec({ id: `ok${n}`, displayName: `A.Ngubane` })),
    ];
    const out = findPossibleMatches(subject, register);
    expect(out).toHaveLength(5);
    expect(out.every((m) => m.id.startsWith('ok'))).toBe(true);
  });
});

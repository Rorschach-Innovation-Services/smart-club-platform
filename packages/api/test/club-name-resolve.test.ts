/**
 * The shared club-name resolver (fixture + umpire-appointment importers): generic suffixes
 * ("CC", "Cricket Club") never stop a sheet name from reaching its club, and a code alias
 * whose target club id does not exist in this tenant falls back to the plain name lookup.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildClubIndex, resolveClub } from '../src/club-name-resolve.js';
import type { Club } from '../src/types.js';

const club = (id: string, name: string) => ({ id, name }) as Club;

describe('resolveClub', () => {
  test('"Chatsworth Sporting" reaches "Chatsworth Sporting CC" (alias target absent here)', () => {
    const clubs = [club('chatsworth-sporting-cc', 'Chatsworth Sporting CC')];
    const byNorm = buildClubIndex(clubs);
    assert.equal(resolveClub('Chatsworth Sporting', clubs, byNorm)?.id, 'chatsworth-sporting-cc');
    assert.equal(
      resolveClub('Chatsworth Sporting Cricket Club', clubs, byNorm)?.id,
      'chatsworth-sporting-cc',
    );
  });

  test('the code alias still wins where its target exists', () => {
    const clubs = [
      club('hollywoodbets-chatsworth-sporting', 'Hollywoodbets Chatsworth Sporting'),
      club('chatsworth-sporting-cc', 'Chatsworth Sporting CC'),
    ];
    const byNorm = buildClubIndex(clubs);
    assert.equal(
      resolveClub('Chatsworth Sporting', clubs, byNorm)?.id,
      'hollywoodbets-chatsworth-sporting',
    );
  });

  test('a trailing CC on the sheet side is tolerated too', () => {
    const clubs = [club('umzinto', 'Umzinto')];
    assert.equal(resolveClub('Umzinto CC', clubs, buildClubIndex(clubs))?.id, 'umzinto');
  });

  test('distinguishing words still keep clubs apart', () => {
    const clubs = [club('chatsworth-united', 'Chatsworth United CC')];
    assert.equal(resolveClub('Chatsworth Sporting', clubs, buildClubIndex(clubs)), undefined);
  });
});

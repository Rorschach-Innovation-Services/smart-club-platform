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

  test('a redirected name still reaches the prod club id where it exists (unchanged)', () => {
    const clubs = [
      club('rhythm-dhsob-cricket-club', 'Rhythm DHSOB Cricket Club'),
      club('rhythm-dhsob-cc', 'Rhythm DHSOB CC'),
    ];
    const byNorm = buildClubIndex(clubs);
    assert.equal(resolveClub('Rhythm DHSOB', clubs, byNorm)?.id, 'rhythm-dhsob-cricket-club');
    assert.equal(
      resolveClub('RHYTHM DHSOB 1st XI', clubs, byNorm)?.id,
      'rhythm-dhsob-cricket-club',
    );
    assert.equal(resolveClub('Rhythm DHS', clubs, byNorm)?.id, 'rhythm-dhsob-cricket-club');
  });

  test('without the redirect target, the sheet spelling matches a club under that name', () => {
    const clubs = [club('rhythm-dhsob-cc', 'Rhythm DHSOB CC')];
    const byNorm = buildClubIndex(clubs);
    assert.equal(resolveClub('Rhythm DHSOB', clubs, byNorm)?.id, 'rhythm-dhsob-cc');
    assert.equal(resolveClub('Rhythm DHSOB CC', clubs, byNorm)?.id, 'rhythm-dhsob-cc');
  });

  test('every redirect falls back to the original spelling the same way', () => {
    // Redirects with no alias behind them ("Silver Saints" → saints) and ones that chain
    // into an alias ("Simplex RHCC" → simplex → a prod id) alike.
    const cases: Array<[sheet: string, id: string, name: string]> = [
      ['Silver Saints', 'silver-saints', 'Silver Saints CC'],
      ['Simplex RHCC', 'simplex-rhcc', 'Simplex RHCC'],
      ['Harlequins DBN', 'harlequins-dbn', 'Harlequins DBN'],
      ['FAM', 'fam-cc', 'FAM CC'],
    ];
    for (const [sheet, id, name] of cases) {
      const clubs = [club(id, name)];
      assert.equal(resolveClub(sheet, clubs, buildClubIndex(clubs))?.id, id, sheet);
    }
    // The redirect target still wins over an original-spelling club when both exist.
    const both = [club('saints', 'Saints Cricket Club'), club('silver-saints', 'Silver Saints')];
    assert.equal(resolveClub('Silver Saints', both, buildClubIndex(both))?.id, 'saints');
  });

  test('distinguishing words still keep clubs apart', () => {
    const clubs = [club('chatsworth-united', 'Chatsworth United CC')];
    assert.equal(resolveClub('Chatsworth Sporting', clubs, buildClubIndex(clubs)), undefined);
  });
});

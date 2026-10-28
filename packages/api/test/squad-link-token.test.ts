/**
 * Squad-link tokens are domain-separated from captain's-report tokens: both are signed with
 * the same `captainsReportLinkSecret()`, so without the `squad-link.v1.` prefix a report token
 * could be replayed against the squad routes (or vice versa).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const squad = await import('../src/squad-requests.js');
const reports = await import('../src/captains-reports.js');
const { scrubReportTokens } = await import('../src/instrument.js');

const SECRET = 'shared-link-secret';
const NOW = Date.parse('2026-10-27T18:00:00Z');
const EXP = Math.floor(NOW / 1000) + 3600;

describe('squad link token', () => {
  test('a squad token verifies as a squad token', () => {
    const tok = squad.signSquadLinkToken({ t: 'dolphins', r: 'm1', q: 's~f~t', e: EXP }, SECRET);
    const check = squad.verifySquadLinkToken(tok, SECRET, NOW);
    assert.equal(check.ok, true);
    if (check.ok) assert.deepEqual(check.payload, { t: 'dolphins', r: 'm1', q: 's~f~t', e: EXP });
  });

  test("a captain's-report token never verifies as a squad token", () => {
    const tok = reports.signReportLinkToken({ t: 'dolphins', r: 's~f~c', m: 'm1', e: EXP }, SECRET);
    assert.deepEqual(squad.verifySquadLinkToken(tok, SECRET, NOW), {
      ok: false,
      reason: 'invalid',
    });
  });

  test("a squad token never verifies as a captain's-report token", () => {
    const tok = squad.signSquadLinkToken({ t: 'dolphins', r: 'm1', q: 's~f~t', e: EXP }, SECRET);
    assert.deepEqual(reports.verifyReportLinkToken(tok, SECRET, NOW), {
      ok: false,
      reason: 'invalid',
    });
  });

  test('expired → expired; tampered / wrong secret → invalid', () => {
    const tok = squad.signSquadLinkToken({ t: 'd', r: 'm', q: 'q', e: EXP }, SECRET);
    assert.deepEqual(squad.verifySquadLinkToken(tok, SECRET, (EXP + 1) * 1000), {
      ok: false,
      reason: 'expired',
    });
    assert.equal(squad.verifySquadLinkToken(tok, 'other', NOW).ok, false);
    assert.equal(squad.verifySquadLinkToken(`${tok}x`, SECRET, NOW).ok, false);
  });

  test('the link expires 23:59:59 SAST on match day', () => {
    assert.equal(
      new Date(squad.squadLinkExpiry('2026-10-28') * 1000).toISOString(),
      '2026-10-28T21:59:59.000Z',
    );
  });

  test('request ids round-trip; a part with `~` or other unsafe characters is refused', () => {
    const id = squad.squadRequestId('s-1', 'f2', 'tm_umzinto_premier_0');
    assert.deepEqual(squad.parseSquadRequestId(id), {
      seriesId: 's-1',
      fixtureId: 'f2',
      teamId: 'tm_umzinto_premier_0',
    });
    assert.equal(squad.parseSquadRequestId('a~b~c~d'), null);
    assert.equal(squad.isSafeIdPart('a~b'), false);
  });

  test('/sq/ and /squad-link/ tokens are scrubbed for Sentry', () => {
    assert.equal(
      scrubReportTokens('https://x.test/sq/abc.def?x=1'),
      'https://x.test/sq/[token]?x=1',
    );
    assert.equal(scrubReportTokens('/squad-link/abc.def/forward'), '/squad-link/[token]/forward');
  });
});

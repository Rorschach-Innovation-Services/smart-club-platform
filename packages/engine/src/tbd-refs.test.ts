/**
 * Named placeholder sides (`tbd:<label>`, ADR 0018): a knockout slot the union describes in
 * words ("Best 3rd place", "Runner-up 2", "Community Cup winner") that no `pos:`/`win:` rule
 * can compute. It must label like a slot and never count as a team.
 */
import { describe, it, expect } from 'vitest';
import { isSlotRef, slotRefLabel, slotSource, tbdLabel, tbdOf, TBD_PREFIX } from './formats';
import { buildLedger, homeAwayBalance, travelPerTeam } from './venues';

describe('tbd: slot refs', () => {
  it('encodes the label into one opaque token and decodes it back', () => {
    const id = tbdOf('Best 3rd place');
    expect(id).toBe('tbd:Best%203rd%20place');
    expect(id.startsWith(TBD_PREFIX)).toBe(true);
    expect(tbdLabel(id)).toBe('Best 3rd place');
  });

  it('normalises whitespace so the same words always give the same id', () => {
    expect(tbdOf('  Runner-up   2 ')).toBe(tbdOf('Runner-up 2'));
  });

  it('survives labels with reserved characters (colons, slashes, ampersands)', () => {
    const label = 'Winner: Pool A/B & C';
    expect(tbdLabel(tbdOf(label))).toBe(label);
  });

  it('is a slot ref but never a fixture forward-reference', () => {
    const id = tbdOf('Community Cup winner');
    expect(isSlotRef(id)).toBe(true);
    expect(slotSource(id)).toBeNull();
    expect(isSlotRef('tm_abc')).toBe(false);
    expect(isSlotRef('irene-cc')).toBe(false);
  });

  it('labels as the decoded words', () => {
    expect(slotRefLabel(tbdOf('Best 3rd place'))).toBe('Best 3rd place');
    expect(slotRefLabel(tbdOf('Runner-up 2'))).toBe('Runner-up 2');
    expect(slotRefLabel(tbdOf('Community Cup winner'), [{ id: 'f1', round: 1 }])).toBe(
      'Community Cup winner',
    );
  });

  it('tolerates hand-written or malformed ids instead of throwing in a render', () => {
    expect(slotRefLabel('tbd:Best 3rd place')).toBe('Best 3rd place'); // unencoded
    expect(slotRefLabel('tbd:%E0%A4%A')).toBe('%E0%A4%A'); // broken escape
    expect(slotRefLabel('tbd:')).toBe('To be decided');
    expect(tbdLabel('pos:s-x-g-a:1')).toBeNull();
  });
});

describe('tbd: sides are never booked or counted as teams', () => {
  const ko = {
    id: 's-ko',
    fixtures: [
      {
        id: 'f1',
        date: '2027-02-14',
        time: '09:00',
        home: 'pos:s-g-a:1',
        away: tbdOf('Best 3rd place'),
        venueId: 'v1',
      },
      {
        id: 'f2',
        date: '2027-02-14',
        time: '09:00',
        home: 'pos:s-g-b:1',
        away: tbdOf('Best 3rd place'),
        venueId: 'v2',
      },
    ],
  };

  it('the team ledger ignores a tbd: side (two fixtures sharing one label are not a clash)', () => {
    const ledger = buildLedger([ko] as never);
    expect(ledger.teamBusy(tbdOf('Best 3rd place'), '2027-02-14', '09:00')).toBe(false);
    expect(ledger.venueLoad('v1', '2027-02-14', '09:00')).toBe(1);
  });

  it('home/away balance and travel reports have no row for a tbd: side', () => {
    const fixtures = ko.fixtures as never;
    const everywhere = () => ({ venueId: 'v9', lat: -25.8, lon: 28.2 });
    expect(homeAwayBalance(fixtures, everywhere)).toEqual([]);
    const venues = [{ id: 'v1', name: 'Oval', lat: -25.7, lon: 28.3 }] as never;
    expect(travelPerTeam(fixtures, venues, everywhere)).toEqual([]);
  });
});

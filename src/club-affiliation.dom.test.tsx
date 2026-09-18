/**
 * AffiliationForm — the club-portal affiliation form must not silently drop leagues the
 * union entered from another district (the admin "Leagues from other districts" picker).
 *
 * The rep's league picker only shows their OWN district's catalogue, so an admin-added
 * cross-district league (e.g. an EMCU junior league on an Ilembe-district club) is carried
 * through as a read-only "Entered by the union" group and unioned back into every save —
 * including across a district change, which otherwise re-seeds the picker.
 *
 * A `.dom.` suite because `club.tsx` imports leaflet (reads `window` at module load).
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AffiliationForm } from './club';
import { renderWithProviders } from './test-utils';

const ALL_LEAGUES = [
  { key: 'premier', label: 'Premier League', group: 'Seniors', district: 'All districts' },
  {
    key: 'ilembeD1',
    label: 'Ilembe Division 1',
    group: 'Seniors',
    district: 'Ilembe Cricket Union',
  },
  {
    key: 'ilembeD2',
    label: 'Ilembe Division 2',
    group: 'Seniors',
    district: 'Ilembe Cricket Union',
  },
  {
    key: 'emcuU11',
    label: 'Under 11',
    group: 'Juniors',
    district: 'Ethekwini Metro Cricket Union',
  },
];

const DISTRICTS = [
  'Ilembe Cricket Union',
  'Umkhanyakude Cricket District',
  'Ethekwini Metro Cricket Union',
];

// A draft (not-yet-submitted) Ilembe club the union has also entered into an EMCU junior
// league (emcuU11) it cannot see in its own district picker.
const club = {
  id: 'dawnheights',
  name: 'Dawnheights Cricket Club',
  district: 'Ilembe Cricket Union',
  leagues: ['ilembeD1', 'emcuU11'],
};

// A saved Ilembe club with TWO in-district picks (A,B = ilembeD1/ilembeD2) plus the same
// union-entered EMCU key (U = emcuU11). Ground venue/address make the form `valid` so a test
// can step through to the leagues page (step 3) and read the "Entered by the union" group.
const clubTwoInDistrict = {
  id: 'dawnheights',
  name: 'Dawnheights Cricket Club',
  district: 'Ilembe Cricket Union',
  leagues: ['ilembeD1', 'ilembeD2', 'emcuU11'],
  ground: { venue: 'Dawnheights Oval', address: '1 Oval Road, Ilembe' },
};

function renderForm(
  onSaveDraft: ReturnType<typeof vi.fn>,
  clubProp: Record<string, unknown> = club,
) {
  return renderWithProviders(
    <AffiliationForm
      club={clubProp}
      goto={vi.fn()}
      toast={vi.fn()}
      onSubmit={vi.fn().mockResolvedValue(undefined)}
      onSaveDraft={onSaveDraft}
      allLeagues={ALL_LEAGUES}
      districts={DISTRICTS}
    />,
  );
}

describe('AffiliationForm — cross-district (union-entered) leagues', () => {
  it('carries the union-entered league through a plain re-save', async () => {
    const user = userEvent.setup();
    const onSaveDraft = vi.fn().mockResolvedValue(undefined);
    renderForm(onSaveDraft);

    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(onSaveDraft).toHaveBeenCalledTimes(1);
    const payload = onSaveDraft.mock.calls[0][0];
    expect(payload.leagues).toEqual(expect.arrayContaining(['ilembeD1', 'emcuU11']));
  });

  it('preserves the union-entered league across a district change', async () => {
    const user = userEvent.setup();
    const onSaveDraft = vi.fn().mockResolvedValue(undefined);
    renderForm(onSaveDraft);

    // Changing district re-seeds the rep's own picker but must keep the union's key.
    await user.selectOptions(screen.getByRole('combobox'), 'Umkhanyakude Cricket District');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    const payload = onSaveDraft.mock.calls[0][0];
    expect(payload.district).toBe('Umkhanyakude Cricket District');
    expect(payload.leagues).toContain('emcuU11');
  });

  it('drops the rep’s former in-district picks and keeps only the true union key on a district change', async () => {
    const user = userEvent.setup();
    const onSaveDraft = vi.fn().mockResolvedValue(undefined);
    renderForm(onSaveDraft, clubTwoInDistrict);

    // Step 1: switch Ilembe → Umkhanyakude, which re-seeds the rep's own picker.
    await user.selectOptions(screen.getByRole('combobox'), 'Umkhanyakude Cricket District');

    // Walk to the leagues step (step 3), where the "Entered by the union" group renders.
    await user.click(screen.getByRole('button', { name: /Continue/ })); // 1 → 2
    await user.click(screen.getByRole('button', { name: /Continue/ })); // 2 → 3

    // The union group shows ONLY the cross-district EMCU key — the former Ilembe picks (A,B) are
    // gone, NOT relabelled as read-only union keys the rep can never remove.
    const unionGroup = screen.getByText('Entered by the union').parentElement as HTMLElement;
    expect(within(unionGroup).getByText(/Under 11/)).toBeTruthy();
    expect(within(unionGroup).queryByText(/Ilembe Division 1/)).toBeNull();
    expect(within(unionGroup).queryByText(/Ilembe Division 2/)).toBeNull();

    // Save: the payload keeps U but drops A/B (they're re-pickable, not locked).
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    const payload = onSaveDraft.mock.calls[0][0];
    expect(payload.district).toBe('Umkhanyakude Cricket District');
    expect(payload.leagues).toContain('emcuU11');
    expect(payload.leagues).not.toContain('ilembeD1');
    expect(payload.leagues).not.toContain('ilembeD2');
  });
});

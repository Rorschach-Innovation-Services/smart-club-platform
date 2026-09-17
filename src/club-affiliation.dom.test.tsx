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
import { screen } from '@testing-library/react';
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

function renderForm(onSaveDraft: ReturnType<typeof vi.fn>) {
  return renderWithProviders(
    <AffiliationForm
      club={club}
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
});

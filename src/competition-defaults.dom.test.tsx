/**
 * CompetitionDefaultsCard (ADR 0014) — the tenant's formats, days, start times, travel cost
 * and venue aliases. Pins: an edit builds the PUT body from the LATEST config (refetched),
 * touching only the sections edited here; a cleared list goes back to the built-in value;
 * "Import from code defaults" fills the alias table; the admin's view keeps aliases
 * read-only.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CompetitionDefaultsCard } from './competition-defaults';
import { DEFAULT_VENUE_ALIASES } from '../packages/engine/src/venue-aliases';
import type { CompetitionDefaults, TenantConfig } from './types';

const cfg = (competitionDefaults?: CompetitionDefaults) =>
  ({ tenant: 'acme', competitionDefaults }) as unknown as TenantConfig;

function setup(
  stored?: CompetitionDefaults,
  opts: { latest?: CompetitionDefaults; aliasesReadOnly?: boolean } = {},
) {
  const save = vi.fn().mockResolvedValue({});
  const fetchLatest = vi.fn().mockResolvedValue(cfg(opts.latest ?? stored));
  const toast = vi.fn();
  const user = userEvent.setup();
  render(
    <CompetitionDefaultsCard
      config={cfg(stored)}
      fetchLatest={fetchLatest}
      save={save}
      toast={toast}
      aliasesReadOnly={opts.aliasesReadOnly}
    />,
  );
  return { user, save, fetchLatest, toast };
}

const saveBtn = () => screen.getByRole('button', { name: /save defaults/i });

describe('CompetitionDefaultsCard', () => {
  it('opens on the built-in values for a tenant that set none, with nothing to save', () => {
    setup();
    expect(screen.getByLabelText('Format 1 label')).toHaveValue('Twenty20 (16-25 overs)');
    expect(screen.getByRole('button', { name: 'Saturday' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Start time 1')).toHaveValue('08:00');
    expect(screen.getByLabelText('Cost per km')).toHaveValue(4.5);
    expect(saveBtn()).toBeDisabled();
  });

  it('builds the PUT body from the refetched config, replacing only the sections edited', async () => {
    const { user, save, fetchLatest } = setup(
      { matchDays: [6] },
      // Someone else set travel in another tab since this page loaded.
      { latest: { matchDays: [6], travel: { costPerKm: 7, carsPerAwayTrip: 2 } } },
    );

    // Formats: rename the first, set its overs and ball, drop the rest.
    await user.clear(screen.getByLabelText('Format 1 label'));
    await user.type(screen.getByLabelText('Format 1 label'), '50 Over (Red Ball)');
    await user.clear(screen.getByLabelText('Format 1 overs'));
    await user.type(screen.getByLabelText('Format 1 overs'), '50');
    await user.type(screen.getByLabelText('Format 1 ball type'), 'Red');
    for (let i = 4; i >= 2; i--)
      await user.click(screen.getByRole('button', { name: `Remove format ${i}` }));
    // Days: add Sunday.
    await user.click(screen.getByRole('button', { name: 'Sunday' }));

    await user.click(saveBtn());

    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      competitionDefaults: {
        matchFormats: [{ label: '50 Over (Red Ball)', overs: 50, ballType: 'Red' }],
        matchDays: [0, 6],
        // Untouched here, so the concurrent edit survives.
        travel: { costPerKm: 7, carsPerAwayTrip: 2 },
      },
    });
    expect(saveBtn()).toBeDisabled();
  });

  it('a cleared list goes back to the built-in value (the key is dropped)', async () => {
    const { user, save } = setup({ timeSlots: [{ label: 'Only', start: '10:00' }] });
    await user.click(screen.getByRole('button', { name: 'Remove start time 1' }));
    await user.click(saveBtn());
    const sent = save.mock.calls[0][0].competitionDefaults;
    expect(sent.timeSlots).toBeUndefined();
  });

  it('refuses an out-of-range value before it reaches the server', async () => {
    const { user } = setup();
    await user.clear(screen.getByLabelText('Format 1 overs'));
    await user.type(screen.getByLabelText('Format 1 overs'), '500');
    expect(screen.getByText(/overs must be a whole number from 1 to 200/)).toBeVisible();
    expect(saveBtn()).toBeDisabled();
  });

  it('imports the code-default venue aliases and saves them with the travel cost', async () => {
    const { user, save } = setup();
    await user.click(screen.getByRole('button', { name: /import from code defaults/i }));
    expect(screen.getByLabelText('Alias 1 ground name')).toHaveValue(
      Object.keys(DEFAULT_VENUE_ALIASES)[0],
    );
    await user.clear(screen.getByLabelText('Cars per away trip'));
    await user.type(screen.getByLabelText('Cars per away trip'), '2');
    await user.click(saveBtn());
    const sent = save.mock.calls[0][0].competitionDefaults;
    expect(sent.venueAliases).toEqual(DEFAULT_VENUE_ALIASES);
    expect(sent.travel).toEqual({ costPerKm: 4.5, carsPerAwayTrip: 2 });
  });

  it('shows aliases read-only to a tenant admin', () => {
    setup({ venueAliases: { totioval: 'toti1' } }, { aliasesReadOnly: true });
    expect(screen.getByText('totioval')).toBeVisible();
    expect(screen.queryByLabelText('Alias 1 ground name')).toBeNull();
    expect(screen.queryByRole('button', { name: /import from code defaults/i })).toBeNull();
  });
});

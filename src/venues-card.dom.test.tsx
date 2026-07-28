/**
 * VenuesCard — the ground registry the allocator runs against.
 *
 * Two behaviours here are load-bearing and neither is visible to the type checker:
 *
 * 1. A FAILED FETCH must not look like an empty registry. They render identically, and
 *    the consequences diverge sharply: on an empty list every club ground looks new, so
 *    the sync CTA would mint a duplicate of every existing ground and hand the allocator
 *    twice the real capacity.
 * 2. There is NO GEOCODER in this product. Coordinates are hand-typed here or they do
 *    not exist, so the field has to survive a partially-typed southern-hemisphere
 *    latitude ("-", "-29.") without rewriting itself.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VenuesCard } from './venues-card';
import type { Club, Venue } from './types';

const clubs = [
  {
    id: 'berea',
    name: 'Berea CC',
    ground: { venue: 'Berea Park', suburb: 'Berea', lat: -29.85, lon: 31.0 },
  },
  { id: 'ukzn', name: 'UKZN CC', ground: { venue: 'UKZN Oval', suburb: 'Westville' } },
] as unknown as Club[];

const pinned = (over: Partial<Venue> = {}): Venue =>
  ({
    id: 'v-kingsmead',
    name: 'Kingsmead',
    suburb: 'Durban',
    lat: -29.8493,
    lon: 31.0294,
    surfaces: 1,
    homeClubIds: [],
    unavailable: [],
    ...over,
  }) as Venue;

const setup = (props: Partial<Parameters<typeof VenuesCard>[0]> = {}) => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn();
  const toast = vi.fn();
  const user = userEvent.setup();
  render(
    <VenuesCard
      clubs={clubs}
      venues={[]}
      onSave={onSave}
      onDelete={onDelete}
      toast={toast}
      {...props}
    />,
  );
  return { user, onSave, onDelete, toast };
};

describe('VenuesCard — a failed fetch is not an empty registry', () => {
  it('offers the sync CTA when the registry is genuinely empty', () => {
    setup({ venues: [] });
    expect(screen.getByRole('button', { name: /sync 2 from club records/i })).toBeVisible();
  });

  it('offers NOTHING that would add grounds when the fetch failed', () => {
    setup({ venues: [], loadFailed: true });

    expect(screen.getByText(/couldn’t load the ground list/i)).toBeVisible();
    // The whole point: no sync, no add. Either would duplicate the real registry.
    expect(screen.queryByRole('button', { name: /sync/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /add a ground/i })).toBeNull();
  });

  it('says it is a loading problem, so nobody re-enters grounds that already exist', () => {
    setup({ venues: [], loadFailed: true });
    expect(screen.getByText(/still safely stored/i)).toBeVisible();
  });
});

describe('VenuesCard — the geo-coverage gate', () => {
  it('warns when too few grounds are pinned to rank by distance', () => {
    // 1 of 3 pinned = 33%, under the 60% threshold the allocator needs.
    setup({
      venues: [
        pinned(),
        pinned({ id: 'v-b', name: 'B', lat: undefined, lon: undefined }),
        pinned({ id: 'v-c', name: 'C', lat: undefined, lon: undefined }),
      ],
    });

    const warning = screen.getByText(/allocation ignores travel distance/i);
    expect(warning).toBeVisible();
    expect(warning).toHaveTextContent('33%');
  });

  it('stays quiet once enough grounds are pinned', () => {
    setup({ venues: [pinned(), pinned({ id: 'v-b', name: 'B' })] });
    expect(screen.queryByText(/allocation ignores travel distance/i)).toBeNull();
  });

  it('does not warn about coverage on an empty registry', () => {
    // 0/0 is not "0% pinned" — there is nothing to pin, and the empty state says so.
    setup({ venues: [] });
    expect(screen.queryByText(/allocation ignores travel distance/i)).toBeNull();
  });
});

describe('VenuesCard — hand-pinning a ground', () => {
  const openForm = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: /add a ground/i }));
  };
  const latBox = () => screen.getByLabelText(/latitude/i);
  const lonBox = () => screen.getByLabelText(/longitude/i);

  it('survives a partially typed southern-hemisphere latitude', async () => {
    const { user } = setup();
    await openForm(user);

    // Parsing per keystroke: Number('-') is NaN and NaN survives `?? ''`, so the box
    // would fill with the literal text "NaN" on the very first character.
    await user.type(latBox(), '-');
    expect(latBox()).toHaveValue('-');

    // Number('-29.') is -29, so a per-keystroke round-trip eats the decimal point.
    await user.type(latBox(), '29.');
    expect(latBox()).toHaveValue('-29.');

    await user.type(latBox(), '85');
    expect(latBox()).toHaveValue('-29.85');
  });

  it('saves the typed coordinates as numbers', async () => {
    const { user, onSave } = setup();
    await openForm(user);

    await user.type(screen.getByLabelText(/ground name/i), 'Kingsmead');
    await user.type(latBox(), '-29.8493');
    await user.type(lonBox(), '31.0294');
    await user.click(screen.getByRole('button', { name: /save|add ground/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({
      name: 'Kingsmead',
      lat: -29.8493,
      lon: 31.0294,
    });
  });

  it('refuses half a pin', async () => {
    const { user, onSave } = setup();
    await openForm(user);

    await user.type(screen.getByLabelText(/ground name/i), 'Half Pinned');
    await user.type(latBox(), '-29.85');

    expect(screen.getByText(/needs both a latitude and a longitude/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /save|add ground/i }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('refuses coordinates outside the globe', async () => {
    const { user, onSave } = setup();
    await openForm(user);

    await user.type(screen.getByLabelText(/ground name/i), 'Nowhere');
    await user.type(latBox(), '-129.85');
    await user.type(lonBox(), '31.03');

    expect(screen.getByText(/latitude must be between -90 and 90/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /save|add ground/i }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('sends undefined for a cleared coordinate, so unpinning actually unpins', async () => {
    const { user, onSave } = setup({ venues: [pinned()] });

    await user.click(within(screen.getByRole('row', { name: /kingsmead/i })).getByText(/edit/i));
    await user.clear(latBox());
    await user.clear(lonBox());
    await user.click(screen.getByRole('button', { name: /save/i }));

    const saved = onSave.mock.calls[0][0];
    expect(saved.lat).toBeUndefined();
    expect(saved.lon).toBeUndefined();
  });

  it('refuses a name-only ground with no name', async () => {
    const { user, onSave } = setup();
    await openForm(user);

    await user.click(screen.getByRole('button', { name: /save|add ground/i }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/give the ground a name/i)).toBeVisible();
  });
});

describe('VenuesCard — the ground list', () => {
  it('names the clubs a ground is home to, and marks the rest neutral', () => {
    setup({
      venues: [
        pinned({ homeClubIds: ['berea', 'ukzn'] }),
        pinned({ id: 'v-neutral', name: 'City Oval', homeClubIds: [] }),
      ],
    });

    expect(
      within(screen.getByRole('row', { name: /kingsmead/i })).getByText(/berea cc/i),
    ).toBeVisible();
    expect(
      within(screen.getByRole('row', { name: /city oval/i })).getByText(/neutral/i),
    ).toBeVisible();
  });
});

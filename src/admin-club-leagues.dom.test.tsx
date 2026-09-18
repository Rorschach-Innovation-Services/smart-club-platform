/**
 * ClubLeaguesEditor — the admin picker that assigns a club's leagues.
 *
 * The picker defaults to the club's OWN district catalogue, but the union can also enter a
 * league from another district (e.g. an EMCU junior league for an Ilembe-district club — the
 * server accepts any catalogue key). A collapsed "Leagues from other districts" disclosure
 * exposes those, and any already-selected cross-district key stays visible (with a district
 * suffix) so it never reads as an orphaned/deleted key. This suite guards that behaviour and
 * that the saved selection carries the cross-district key through.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClubLeaguesEditor, ChairContactModal, nextChairContact } from './admin';
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
  {
    key: 'emcuU13',
    label: 'Under 13',
    group: 'Juniors',
    district: 'Ethekwini Metro Cricket Union',
  },
];

const club = (over: Record<string, unknown> = {}) => ({
  id: 'dawnheights',
  name: 'Dawnheights Cricket Club',
  district: 'Ilembe Cricket Union',
  leagues: ['ilembeD1'],
  ...over,
});

describe('ClubLeaguesEditor — leagues from other districts', () => {
  it('lists other-district leagues under a collapsed disclosure and can tick one into the save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ClubLeaguesEditor club={club()} allLeagues={ALL_LEAGUES} onSave={onSave} />,
    );

    // Collapsed: the disclosure counts the two EMCU leagues; the chips are not yet rendered.
    const disclosure = screen.getByRole('button', { name: /Leagues from other districts \(2\)/ });
    expect(screen.queryByRole('button', { name: 'Under 11' })).toBeNull();
    // Collapsed disclosure is wired for assistive tech: not expanded, and it owns its panel.
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(disclosure).toHaveAttribute('aria-controls', 'admin-other-districts-panel');

    await user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('admin-other-districts-panel')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Under 11' }));
    await user.click(screen.getByRole('button', { name: /Save leagues/ }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toEqual(expect.arrayContaining(['ilembeD1', 'emcuU11']));
  });

  it('shows an already-saved cross-district league as a selected chip, not an orphan', () => {
    renderWithProviders(
      <ClubLeaguesEditor
        club={club({ leagues: ['ilembeD1', 'emcuU11'] })}
        allLeagues={ALL_LEAGUES}
        onSave={vi.fn()}
      />,
    );
    // Rendered with its district suffix so it never looks like a deleted-key orphan (no "✕").
    const chip = screen.getByRole('button', {
      name: 'Under 11 · Ethekwini Metro Cricket Union',
    });
    expect(chip).toBeTruthy();
    expect(screen.queryByText(/emcuU11 ✕/)).toBeNull();
  });
});

/**
 * ChairContactModal + nextChairContact — replacing a club's chairperson.
 *
 * A CHANGED name is a new person: the modal warns that the previous chair's term dates / ID
 * details will be cleared, and nextChairContact drops those governance fields. A same-name
 * edit is a contact correction that preserves them. onUpdateChair (main.tsx) uses the helper.
 */
const CHAIR = {
  name: 'Seelan Naidoo',
  email: 'seelan@saints.co.za',
  cell: '0831112222',
  idNumber: '7001015800088',
  termStart: '2024-01-01',
  termEnd: '2026-12-31',
  gender: 'M',
  race: 'Indian',
};

describe('nextChairContact — payload shape', () => {
  it('drops the previous chair governance fields when the name changes', () => {
    const next = nextChairContact(CHAIR, {
      name: 'Vinothan Govender',
      email: 'vino@saints.co.za',
      cell: '0834445555',
    });
    expect(next).toEqual({
      name: 'Vinothan Govender',
      email: 'vino@saints.co.za',
      cell: '0834445555',
    });
    expect(next).not.toHaveProperty('idNumber');
    expect(next).not.toHaveProperty('termStart');
  });

  it('keeps the governance fields when only contact details change (same name)', () => {
    const next = nextChairContact(CHAIR, {
      name: 'Seelan Naidoo',
      email: 'new@saints.co.za',
      cell: '0831112222',
    });
    expect(next.idNumber).toBe('7001015800088');
    expect(next.termEnd).toBe('2026-12-31');
    expect(next.email).toBe('new@saints.co.za');
  });
});

describe('ChairContactModal — name-change note', () => {
  const club = { id: 'saints', name: 'Saints Cricket Club', exco: { chair: CHAIR } };
  const note = /Term dates and ID details of the previous chairperson will be cleared/;

  it('warns and forwards name/email/cell when the name changes', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ChairContactModal club={club} onClose={vi.fn()} onSave={onSave} toast={vi.fn()} />,
    );
    expect(screen.queryByText(note)).toBeNull();

    const name = screen.getByPlaceholderText('Chairperson name');
    await user.clear(name);
    await user.type(name, 'Vinothan Govender');
    expect(screen.getByText(note)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Save chairperson/ }));
    expect(onSave).toHaveBeenCalledWith({
      name: 'Vinothan Govender',
      email: 'seelan@saints.co.za',
      cell: '0831112222',
    });
  });

  it('shows no note for a contact-detail correction (name unchanged)', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ChairContactModal club={club} onClose={vi.fn()} onSave={vi.fn()} toast={vi.fn()} />,
    );
    const email = screen.getByPlaceholderText('chair@club.co.za');
    await user.clear(email);
    await user.type(email, 'seelan.new@saints.co.za');
    expect(screen.queryByText(note)).toBeNull();
  });
});

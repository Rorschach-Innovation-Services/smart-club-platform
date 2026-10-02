/**
 * Captain's report form — the umpire cards follow the appointment snapshotted on the report:
 * none → two registry pickers; one → one autofilled card; two → each card limited to the
 * pair (never the same umpire twice); "A different umpire stood" → registry or free text.
 * Rendered for real through the app's providers; only the save/submit callbacks are stubs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-utils';
import { CaptainsReportForm, type ReportShell } from './CaptainsReport';
import { ownRoster } from './captainsReportRoster';

const NGUBANE = { umpireId: 'u-ngubane', name: 'A.Ngubane' };
const DLAMINI = { umpireId: 'u-dlamini', name: 'S.Dlamini' };
const REGISTRY = [
  { id: 'u-ngubane', displayName: 'A.Ngubane' },
  { id: 'u-dlamini', displayName: 'S.Dlamini' },
  { id: 'u-sub', displayName: 'B.Sub' },
];

let seq = 0;
const shell = (appointed: Array<{ umpireId: string; name: string }>): ReportShell => ({
  id: `s1~f${++seq}~umzinto`,
  matchDate: '2026-10-04',
  deadline: '2026-10-07T16:00:00.000Z',
  side: 'home',
  clubName: 'Umzinto CC',
  opponentName: 'African Warriors',
  competition: 'Premier T20',
  venue: 'Kingsmead Oval',
  resultSummary: 'Umzinto won by 23 runs',
  umpiresSnapshot: appointed,
  captainName: '',
  umpires: [],
  general: '',
  declaration: false,
  late: false,
});

const render = (appointed: Array<{ umpireId: string; name: string }>) => {
  const onSubmit = vi.fn(async () => {});
  renderWithProviders(
    <CaptainsReportForm report={shell(appointed)} registry={REGISTRY} onSubmit={onSubmit} />,
  );
  return { onSubmit };
};

const optionsOf = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((o) => o.textContent);

beforeEach(() => localStorage.clear());

describe('umpire cards from the appointment', () => {
  it('no appointment → two registry pickers', () => {
    render([]);
    expect(screen.getByTestId('umpire-card-1')).toBeInTheDocument();
    expect(screen.getByTestId('umpire-card-2')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Umpire 1' })).toHaveValue('');
    expect(screen.queryByRole('option', { name: /appointed/ })).toBeNull();
  });

  it('one appointed → one card, autofilled', () => {
    render([NGUBANE]);
    expect(screen.queryByTestId('umpire-card-2')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Umpire 1' })).toHaveValue('u-ngubane');
  });

  it('two appointed → each card offers only the umpire the other card does not hold', async () => {
    render([NGUBANE, DLAMINI]);
    const one = screen.getByRole('combobox', { name: 'Umpire 1' });
    const two = screen.getByRole('combobox', { name: 'Umpire 2' });
    expect(one).toHaveValue('u-ngubane');
    expect(two).toHaveValue('u-dlamini');
    expect(optionsOf(one)).toEqual(['A.Ngubane (appointed)', 'A different umpire stood']);
    expect(optionsOf(two)).toEqual(['S.Dlamini (appointed)', 'A different umpire stood']);
    // Card 2 becomes a substitute → card 1 may now pick either appointed umpire.
    await userEvent.selectOptions(two, '__substitute');
    expect(optionsOf(one)).toEqual([
      'A.Ngubane (appointed)',
      'S.Dlamini (appointed)',
      'A different umpire stood',
    ]);
  });

  it('"A different umpire stood" takes a registry pick or free text', async () => {
    render([NGUBANE]);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Umpire 1' }),
      '__substitute',
    );
    const who = screen.getByRole('combobox', { name: 'Umpire 1 who stood' });
    await userEvent.type(who, 'Club umpire');
    expect(who).toHaveValue('Club umpire');
  });
});

describe('submitting', () => {
  it('stays disabled until every criterion, the captain and the declaration are in', async () => {
    const { onSubmit } = render([NGUBANE]);
    const submit = screen.getAllByRole('button', { name: 'Submit report' })[0];
    expect(submit).toBeDisabled();
    const card = screen.getByTestId('umpire-card-1');
    for (const group of within(card).getAllByRole('radiogroup'))
      await userEvent.click(within(group).getByRole('radio', { name: '4' }));
    await userEvent.type(screen.getByRole('combobox', { name: "Captain's name" }), 'S. Mthembu');
    await userEvent.click(screen.getByRole('checkbox'));
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        captainName: 'S. Mthembu',
        declaration: true,
        umpires: [expect.objectContaining({ umpireId: 'u-ngubane', name: 'A.Ngubane' })],
      }),
    );
  });
});

describe('captain suggestions', () => {
  it('come from the club’s own registrations only', () => {
    const r = ownRoster({ id: 'ukzn' }, [
      { firstName: 'Zane', lastName: 'Adams' },
      { firstName: 'Ayanda', lastName: 'Cele' },
    ]);
    expect(r.players.map((p) => p.name)).toEqual(['Ayanda Cele', 'Zane Adams']);
  });
});

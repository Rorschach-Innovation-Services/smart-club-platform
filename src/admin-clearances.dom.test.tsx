/**
 * AdminClearances — the union office's oversight of player movement between clubs.
 *
 * Three things make this worth pinning down. It decides where a player is registered, so
 * a wrong action moves a real person's eligibility. Every action is irreversible from this
 * screen. And the off-system case is a genuine trap: a clearance whose source club has no
 * record on the platform can never be answered by a rep, so offering Reject there would
 * reject a transfer on behalf of a club that was never asked.
 *
 * That last rule is why prod's backfilled clearances are approve/override-only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminClearances } from './admin';
import { renderWithProviders } from './test-utils';

const leagues = [
  { key: 'premier', label: 'Premier League', group: 'S', district: 'All districts' },
];
const clubs = [
  { id: 'berea', name: 'Berea CC' },
  { id: 'ukzn', name: 'UKZN CC' },
];

const request = (over: Record<string, unknown> = {}) => ({
  id: 'clr-1',
  status: 'pending',
  playerName: 'Sipho Ndlovu',
  idNumber: '0101015800088',
  team: 'premier',
  requestedAt: '2026-07-01T09:00:00.000Z',
  fromClubId: 'berea',
  fromClubName: 'Berea CC',
  toClubId: 'ukzn',
  toClubName: 'UKZN CC',
  origin: 'transfer',
  ...over,
});

const setup = (clearances: Array<Record<string, unknown>>, busyId?: string) => {
  const onOverride = vi.fn();
  const onReject = vi.fn();
  const onReassign = vi.fn();
  const user = userEvent.setup();
  renderWithProviders(
    <AdminClearances
      clearances={clearances as never[]}
      leagues={leagues as never[]}
      clubs={clubs as never[]}
      onOverride={onOverride}
      onReject={onReject}
      onReassign={onReassign}
      busyId={busyId}
    />,
  );
  return { user, onOverride, onReject, onReassign };
};

const card = (name = /sipho/i) => screen.getByText(name).closest('.clr-card') as HTMLElement;

beforeEach(() => vi.clearAllMocks());

describe('a clearance whose previous club is not on the system', () => {
  const offSystem = () =>
    request({ fromClubId: 'oldtown', fromClubName: 'Old Town CC', fromClubDirectory: true });

  it('cannot be rejected — no rep was ever able to answer it', () => {
    const { onReject } = setup([offSystem()]);

    const reject = within(card()).getByRole('button', { name: /^reject$/i });
    expect(reject).toBeDisabled();
    expect(onReject).not.toHaveBeenCalled();
  });

  it('says why, rather than leaving a dead control', () => {
    setup([offSystem()]);
    expect(within(card()).getByTitle(/not on the system and cannot respond/i)).toBeInTheDocument();
  });

  it('marks the source club so the reason is visible at a glance', () => {
    setup([offSystem()]);
    expect(within(card()).getByText(/not on system/i)).toBeVisible();
  });

  it('offers reallocation, for a club that has since registered', async () => {
    const { user, onReassign } = setup([offSystem()]);

    await user.click(within(card()).getByRole('button', { name: /reallocate source/i }));
    expect(screen.getByText(/has no record on the system/i)).toBeVisible();
    expect(onReassign).not.toHaveBeenCalled();
  });

  it('still allows an override — that is the intended way out', () => {
    setup([offSystem()]);
    expect(within(card()).getByRole('button', { name: /override & approve/i })).toBeEnabled();
  });

  it('drops the flag once a club registers under that id', () => {
    // The cross-check ages the flag out; without it a clearance stays un-rejectable
    // forever even after the club signs up.
    setup([request({ fromClubId: 'berea', fromClubDirectory: true })]);

    expect(within(card()).getByRole('button', { name: /^reject$/i })).toBeEnabled();
    expect(within(card()).queryByText(/not on system/i)).toBeNull();
  });
});

describe('an ordinary clearance', () => {
  it('confirms before issuing on the union’s authority', async () => {
    const { user, onOverride } = setup([request()]);

    await user.click(within(card()).getByRole('button', { name: /override & approve/i }));
    expect(screen.getByText(/on the Union's authority, on Berea CC's behalf/i)).toBeVisible();
    expect(onOverride).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /yes, issue clearance/i }));
    expect(onOverride).toHaveBeenCalledTimes(1);
  });

  it('carries the override reason the admin typed', async () => {
    // Override doubles as the disposal path, so the reason is the only thing distinguishing
    // "the Union approved this transfer" from "this should never have existed". It has to
    // reach the handler intact — and the textarea is shared with the reject confirmation,
    // which is exactly the kind of coupling that regresses silently.
    const { user, onOverride } = setup([request()]);

    await user.click(within(card()).getByRole('button', { name: /override & approve/i }));
    await user.type(screen.getByRole('textbox'), '  not a real registration, removing  ');
    await user.click(screen.getByRole('button', { name: /yes, issue clearance/i }));

    expect(onOverride).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'clr-1' }),
      'not a real registration, removing',
    );
  });

  it('shows the override reason and who signed off on a resolved card', async () => {
    // The whole reason it is captured: a disposal must not read as an approved transfer.
    setup([
      request({
        status: 'admin-override',
        overrideReason: 'not a real registration, removing',
        overriddenBy: 'union@dolphins.test',
      }),
    ]);

    expect(within(card()).getByText(/not a real registration, removing/i)).toBeVisible();
    expect(within(card()).getByText(/union@dolphins\.test/i)).toBeVisible();
  });

  it('confirms before rejecting, and names what happens to the player', async () => {
    const { user, onReject } = setup([request()]);

    await user.click(within(card()).getByRole('button', { name: /^reject$/i }));
    expect(screen.getByText(/They stay registered at Berea CC/i)).toBeVisible();
    expect(onReject).not.toHaveBeenCalled();
  });

  it('describes a registration-origin rejection differently, and says it is permanent', async () => {
    // A transfer bounces the player back; a registration-origin rejection leaves them at
    // the NEW club flagged, and removes them from the old one. Saying the wrong one
    // misinforms the decision. Permanence is the load-bearing part: there is no reactivation
    // endpoint, so this flag is the player's final state and the copy has to say so.
    // `sourceRostered: true` — the source club DOES hold this player, which is what makes
    // rejection a legitimately available (and informed) decision here.
    const { user } = setup([request({ origin: 'registration', sourceRostered: true })]);

    await user.click(within(card()).getByRole('button', { name: /^reject$/i }));
    // Scoped to phrasing unique to the confirmation body — the card summary above it also
    // mentions the flag, so a bare /clearance-rejected/ matches twice.
    expect(
      screen.getByText(
        /flagged clearance-rejected — which is permanent.*only registration record.*Any record of them at Berea CC is removed/i,
      ),
    ).toBeVisible();
  });

  it('blocks rejection when the source club has no record of the player', async () => {
    // The source cannot decide on an informed basis, so Reject would flag a legitimately
    // registered player permanently. Reallocation is offered in its place.
    setup([request({ origin: 'registration', sourceRostered: false })]);

    expect(within(card()).getByRole('button', { name: /^reject$/i })).toBeDisabled();
    expect(within(card()).getByRole('button', { name: /reallocate source/i })).toBeVisible();
  });

  it('blocks rejection when the API did not say whether the source holds the player', async () => {
    // Web and API deploy separately, so `sourceRostered` can be absent — and a partial read can
    // leave it absent for individual clearances too. Unknown must fail CLOSED on the
    // irreversible action, WITHOUT asserting the sourceless story or offering the action the
    // server would refuse. Folding unknown back into `sourceless` is the specific regression
    // this pins.
    setup([request({ origin: 'registration' })]);

    expect(within(card()).getByRole('button', { name: /^reject$/i })).toBeDisabled();
    expect(within(card()).queryByRole('button', { name: /reallocate source/i })).toBeNull();
    expect(screen.getByText(/could not confirm whether Berea CC holds this player/i)).toBeVisible();
    expect(screen.queryByText(/has no record of this player on its roster/i)).toBeNull();
  });

  it('disables the actions while one is in flight', () => {
    setup([request()], 'clr-1');

    expect(within(card()).getByRole('button', { name: /issuing/i })).toBeDisabled();
    expect(within(card()).getByRole('button', { name: /^reject$/i })).toBeDisabled();
  });
});

describe('the request list', () => {
  it('shows no actions on an already-resolved request', () => {
    setup([request({ id: 'c2', status: 'approved' })]);

    expect(within(card()).queryByRole('button', { name: /override & approve/i })).toBeNull();
    expect(within(card()).queryByRole('button', { name: /^reject$/i })).toBeNull();
  });

  it('marks a union override distinctly from a club approval', () => {
    // It appears in the card eyebrow and again on the resolved bar; both are the point.
    setup([request({ status: 'admin-override' })]);
    expect(within(card()).getAllByText(/union override/i).length).toBeGreaterThan(0);
  });

  it('carries the rejection note the admin typed', async () => {
    // The note is shown to BOTH clubs, so it has to reach the handler intact.
    const { user, onReject } = setup([request()]);
    await user.click(within(card()).getByRole('button', { name: /^reject$/i }));
    await user.type(screen.getByRole('textbox'), '  Fees outstanding  ');
    await user.click(screen.getByRole('button', { name: /yes, reject clearance/i }));

    expect(onReject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'clr-1' }),
      'Fees outstanding',
    );
  });

  it('will not reallocate until a target club is chosen', async () => {
    const { user, onReassign } = setup([
      request({ fromClubId: 'oldtown', fromClubName: 'Old Town CC', fromClubDirectory: true }),
    ]);
    await user.click(within(card()).getByRole('button', { name: /reallocate source/i }));

    expect(screen.getByRole('button', { name: /reallocate clearance/i })).toBeDisabled();
    await user.selectOptions(screen.getByRole('combobox'), 'berea');
    await user.click(screen.getByRole('button', { name: /reallocate clearance/i }));

    expect(onReassign).toHaveBeenCalledWith(expect.objectContaining({ id: 'clr-1' }), 'berea');
  });

  it('never offers the club the clearance is already assigned to', async () => {
    // On-system sourceless clearances became reallocatable, so unlike the directory case the
    // current source IS in the club list — picking it would 400.
    const { user } = setup([
      request({ origin: 'registration', sourceRostered: false, fromClubId: 'berea' }),
    ]);
    await user.click(within(card()).getByRole('button', { name: /reallocate source/i }));

    const options = within(screen.getByRole('combobox'))
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(options).not.toContain('berea');
  });

  it('never offers the destination club as a reallocation target', async () => {
    // Reallocating to the club the player is moving TO would make it approve its own
    // incoming transfer.
    const { user } = setup([
      request({ fromClubId: 'oldtown', fromClubName: 'Old Town CC', fromClubDirectory: true }),
    ]);
    await user.click(within(card()).getByRole('button', { name: /reallocate source/i }));

    const options = within(screen.getByRole('combobox'))
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(options).not.toContain('ukzn');
    expect(options).toContain('berea');
  });

  it('counts every request across the cohort', () => {
    setup([
      request({ id: 'a' }),
      request({ id: 'b', status: 'approved' }),
      request({ id: 'c', status: 'rejected' }),
    ]);

    expect(screen.getByText('All requests').parentElement).toHaveTextContent('3');
  });

  it('does not advertise an export it cannot do', () => {
    // Disabled on purpose — the console should not offer capabilities it lacks.
    setup([request()]);
    expect(screen.getByRole('button', { name: /export/i })).toBeDisabled();
  });
});

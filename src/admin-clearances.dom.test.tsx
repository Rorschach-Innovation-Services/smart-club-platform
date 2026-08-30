/**
 * AdminClearances — the union office's oversight of player movement between clubs.
 *
 * Rejecting a clearance now CANCELS THE MOVE: the player ends up active at the source club,
 * however the clearance was created. What a reject actually does depends on the source club's
 * real roster state, which the API works out and returns as `predictedRejectCase` — the console
 * never infers it from a boolean. Reject is disabled ONLY when that prediction is ABSENT (fail
 * closed), because a reject can create or replace a row at another club (cases C / B-placeholder)
 * and the admin must see the right consequence before confirming. Every reject is reversible from
 * this screen via Reopen, so nothing here is terminal any more.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
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
  // A rep-initiated transfer is case A — the server predicts it. Reject is enabled by default;
  // individual tests override `predictedRejectCase` (incl. to `undefined` for the deploy-skew
  // fail-closed path).
  predictedRejectCase: 'A',
  ...over,
});

const setup = (
  clearances: Array<Record<string, unknown>>,
  busyId?: string,
  busyAction?: 'reject' | 'override' | 'reassign' | 'reopen',
) => {
  // The handlers resolve to a tri-state in production ('ok' | 'conflict' | 'failed'; the
  // dialog closes unless the result is 'failed'); default them to 'ok' so an ordinary
  // confirm click closes the dialog.
  const onOverride = vi.fn().mockResolvedValue('ok');
  const onReject = vi.fn().mockResolvedValue('ok');
  const onReassign = vi.fn().mockResolvedValue('ok');
  const onReopen = vi.fn().mockResolvedValue('ok');
  const user = userEvent.setup();
  renderWithProviders(
    <AdminClearances
      clearances={clearances as never[]}
      leagues={leagues as never[]}
      clubs={clubs as never[]}
      onOverride={onOverride}
      onReject={onReject}
      onReassign={onReassign}
      onReopen={onReopen}
      busyId={busyId}
      busyAction={busyAction}
    />,
  );
  return { user, onOverride, onReject, onReassign, onReopen };
};

const card = (name: RegExp = /sipho/i) =>
  screen.getByText(name).closest('.clr-card') as HTMLElement;

beforeEach(() => vi.clearAllMocks());

describe('a clearance whose previous club is not on the system', () => {
  const offSystem = (over: Record<string, unknown> = {}) =>
    request({
      fromClubId: 'oldtown',
      fromClubName: 'Old Town CC',
      fromClubDirectory: true,
      // No club record for the source ⇒ the server predicts case D (dest-activated): a reject
      // leaves the player registered and active at the destination.
      predictedRejectCase: 'D',
      ...over,
    });

  it('rejects in place — the player simply stays at the destination', async () => {
    // Case D. Reject is available (it is reversible and non-destructive here), and the confirm
    // says exactly what happens: nothing moves, they stay at the destination club.
    const { user, onReject } = setup([offSystem()]);

    const reject = within(card()).getByRole('button', { name: /^reject$/i });
    expect(reject).toBeEnabled();

    await user.click(reject);
    expect(screen.getByText(/they stay registered and active at UKZN CC/i)).toBeVisible();
    expect(onReject).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /yes, reject clearance/i }));
    expect(onReject).toHaveBeenCalledTimes(1);
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
});

describe('the reject confirmation names the predicted case', () => {
  // Every reject cancels the move; the copy has to describe the case the SERVER predicted, so an
  // admin sees whether a row is being created, replaced or simply left where it is.
  it('case A — a rep-initiated transfer returns the player to active at the source', async () => {
    const { user } = setup([request({ predictedRejectCase: 'A' })]);
    await user.click(within(card()).getByRole('button', { name: /^reject$/i }));
    expect(
      screen.getByText(/the move is cancelled and they return to active at Berea CC/i),
    ).toBeVisible();
  });

  it('case B — the source row reactivates and the pending destination row is removed', async () => {
    const { user } = setup([request({ origin: 'registration', predictedRejectCase: 'B' })]);
    await user.click(within(card()).getByRole('button', { name: /^reject$/i }));
    expect(
      screen.getByText(
        /return to active at Berea CC, and their pending registration at UKZN CC is removed/i,
      ),
    ).toBeVisible();
  });

  it('case B-placeholder — the full registration replaces the placeholder at the source', async () => {
    const { user } = setup([
      request({ origin: 'registration', predictedRejectCase: 'B-placeholder' }),
    ]);
    await user.click(within(card()).getByRole('button', { name: /^reject$/i }));
    // Names the placeholder, the replacement at the source, and the junk-disposal alternative.
    expect(
      screen.getByText(
        /holds only a placeholder for this player, so their full registration.*is moved to Berea CC, replacing the placeholder/i,
      ),
    ).toBeVisible();
    expect(screen.getByText(/If this registration is junk, use Override & approve/i)).toBeVisible();
  });

  it('case B-active — the player is already active at the source', async () => {
    const { user } = setup([request({ origin: 'registration', predictedRejectCase: 'B-active' })]);
    await user.click(within(card()).getByRole('button', { name: /^reject$/i }));
    // Scope to the confirm-body prefix — the pending sub-text repeats the same clause.
    expect(
      screen.getByText(
        /on the Union's authority\. They are already active at Berea CC; rejecting removes their pending registration at UKZN CC/i,
      ),
    ).toBeVisible();
  });

  it('case C — the registration is moved to the source, which becomes its owner', async () => {
    const { user } = setup([request({ origin: 'registration', predictedRejectCase: 'C' })]);
    await user.click(within(card()).getByRole('button', { name: /^reject$/i }));
    expect(
      screen.getByText(
        /Berea CC has no record of this player, so rejecting moves the registration.*becomes Berea CC's to manage/i,
      ),
    ).toBeVisible();
    expect(screen.getByText(/If this registration is junk, use Override & approve/i)).toBeVisible();
  });

  it('unknown — Reject is disabled when the API could not predict the case', () => {
    // Web and API deploy separately, so `predictedRejectCase` can be absent — and a partial read
    // can leave it absent for individual clearances. Unknown fails CLOSED on the irreversible-
    // looking control, with copy that tells the admin to refresh.
    setup([request({ predictedRejectCase: undefined })]);

    expect(within(card()).getByRole('button', { name: /^reject$/i })).toBeDisabled();
    expect(
      within(card()).getByTitle(/could not work out where this player's record is/i),
    ).toBeInTheDocument();
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
    await user.type(
      screen.getByPlaceholderText(/reason/i),
      '  not a real registration, removing  ',
    );
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

  it('confirms before rejecting, and says the move is cancelled', async () => {
    const { user, onReject } = setup([request()]);

    await user.click(within(card()).getByRole('button', { name: /^reject$/i }));
    expect(
      screen.getByText(/the move is cancelled and they return to active at Berea CC/i),
    ).toBeVisible();
    expect(onReject).not.toHaveBeenCalled();
  });

  it('labels the in-flight action so a reject never reads as an approval', () => {
    // The screenshot bug: while a REJECT was in flight the Override button read "Issuing…"
    // and Reject just greyed out, so a rejection looked like an approval. The busy label
    // must follow the action actually running.
    setup([request()], 'clr-1', 'reject');

    expect(within(card()).getByRole('button', { name: /rejecting/i })).toBeDisabled();
    // Override keeps its normal label — it is not the action in flight.
    expect(within(card()).getByRole('button', { name: /override & approve/i })).toBeDisabled();
    expect(within(card()).queryByRole('button', { name: /issuing/i })).toBeNull();
  });

  it('labels an override in flight without touching the reject label', () => {
    setup([request()], 'clr-1', 'override');

    expect(within(card()).getByRole('button', { name: /issuing/i })).toBeDisabled();
    expect(within(card()).getByRole('button', { name: /^reject$/i })).toBeDisabled();
    expect(within(card()).queryByRole('button', { name: /rejecting/i })).toBeNull();
  });
});

describe('a rejected clearance can be reopened', () => {
  const rejected = (over: Record<string, unknown> = {}) =>
    request({
      status: 'rejected',
      rejectedBy: 'union@dolphins.test',
      rejectReason: 'sent in error',
      rejectOutcome: 'source-reactivated',
      version: 3,
      ...over,
    });

  it('shows Reopen only on a rejected clearance that carries an outcome', () => {
    setup([rejected(), request({ id: 'p', status: 'pending', playerName: 'Ava Pending' })]);

    expect(within(card(/sipho/i)).getByRole('button', { name: /^reopen$/i })).toBeVisible();
    // A pending card offers no Reopen — there is nothing to reopen.
    expect(within(card(/ava pending/i)).queryByRole('button', { name: /^reopen$/i })).toBeNull();
  });

  it('offers no Reopen on a legacy reject (no snapshot), saying so instead', () => {
    // A reject done before reopen was supported has no snapshot to restore, so a Reopen would
    // always 409 — show why rather than a button that can't work.
    setup([rejected({ rejectOutcome: undefined })]);

    expect(within(card()).queryByRole('button', { name: /^reopen$/i })).toBeNull();
    expect(within(card()).getByText(/rejected before reopen was supported/i)).toBeVisible();
  });

  it('confirms, then calls onReopen', async () => {
    const { user, onReopen } = setup([rejected()]);

    await user.click(within(card()).getByRole('button', { name: /^reopen$/i }));
    expect(screen.getByText(/goes back to how it was before the rejection/i)).toBeVisible();
    expect(onReopen).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /yes, reopen clearance/i }));
    expect(onReopen).toHaveBeenCalledWith(expect.objectContaining({ id: 'clr-1' }));
  });

  it('labels the reopen while it is in flight', () => {
    setup([rejected()], 'clr-1', 'reopen');
    expect(within(card()).getByRole('button', { name: /reopening/i })).toBeDisabled();
  });

  it('shows a "Reopened" eyebrow on a pending clearance that was reopened', () => {
    setup([
      request({
        reopenedAt: '2026-08-20T09:00:00.000Z',
        reopenedBy: 'union@dolphins.test',
      }),
    ]);
    expect(within(card()).getByText(/reopened/i)).toBeVisible();
    expect(within(card()).getByText(/union@dolphins\.test/i)).toBeVisible();
  });
});

describe('a resolved rejection reads truthfully', () => {
  it('shows the player was moved to the source club', () => {
    setup([request({ status: 'rejected', rejectOutcome: 'moved-to-source' })]);
    expect(within(card()).getByText(/moved to Berea CC/i)).toBeVisible();
  });

  it('shows the player stays at the destination when the source is off-system', () => {
    setup([request({ status: 'rejected', rejectOutcome: 'stays-at-destination' })]);
    expect(within(card()).getByText(/stays at UKZN CC/i)).toBeVisible();
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
    await user.type(screen.getByPlaceholderText(/reason/i), '  Fees outstanding  ');
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

describe('searching the clearance list', () => {
  // A pending transfer and a resolved rejection with distinct player, club and id, so a
  // search on any one field can be told apart from the other card.
  const cohort = () => [
    request(),
    request({
      id: 'clr-2',
      status: 'rejected',
      playerName: 'Thabo Mokoena',
      idNumber: '9202025900011',
      fromClubName: 'Glenwood CC',
      toClubName: 'Durban CC',
      rejectedBy: 'union@dolphins.test',
    }),
  ];
  const search = () => screen.getByRole('textbox', { name: /search clearances/i });
  const allPill = () => screen.getByRole('button', { name: /^all\b/i });

  it('narrows across every status by player name', async () => {
    const { user } = setup(cohort());

    await user.type(search(), 'Thabo');
    expect(screen.getByText(/thabo mokoena/i)).toBeVisible();
    expect(screen.queryByText(/sipho ndlovu/i)).toBeNull();
    // The All pill counts the searched set, not the cohort.
    expect(allPill()).toHaveTextContent(/all\s*1/i);
    expect(screen.getByText(/showing 1 of 2 clearances/i)).toBeVisible();
  });

  it('matches on club name and on ID number', async () => {
    const { user } = setup(cohort());

    await user.type(search(), 'glenwood');
    expect(screen.getByText(/thabo mokoena/i)).toBeVisible();
    expect(screen.queryByText(/sipho ndlovu/i)).toBeNull();

    await user.clear(search());
    await user.type(search(), '0101015');
    expect(screen.getByText(/sipho ndlovu/i)).toBeVisible();
    expect(screen.queryByText(/thabo mokoena/i)).toBeNull();
  });

  it('reflects the search in the status pill counts, cohort totals aside', async () => {
    const { user } = setup(cohort());

    await user.type(search(), 'Thabo');
    // Thabo is rejected: the search leaves Rejected at 1, Pending at 0, All at 1…
    expect(screen.getByRole('button', { name: /^rejected\b/i })).toHaveTextContent(/rejected\s*1/i);
    expect(screen.getByRole('button', { name: /^pending\b/i })).toHaveTextContent(/pending\s*0/i);
    // …while the four stat cards stay cohort totals (1 pending, 1 rejected across the cohort).
    // Scope to the stat label — "Pending"/"Rejected" also head the pill buttons.
    expect(
      screen.getByText('Pending', { selector: '.players-stat-l' }).parentElement,
    ).toHaveTextContent('1');
    expect(
      screen.getByText('Rejected', { selector: '.players-stat-l' }).parentElement,
    ).toHaveTextContent('1');
  });

  it('restores the full list when the search is cleared', async () => {
    const { user } = setup(cohort());

    await user.type(search(), 'Thabo');
    expect(screen.queryByText(/sipho ndlovu/i)).toBeNull();

    await user.clear(search());
    expect(screen.getByText(/sipho ndlovu/i)).toBeVisible();
    expect(screen.getByText(/thabo mokoena/i)).toBeVisible();
    expect(allPill()).toHaveTextContent(/all\s*2/i);
    // The result-count line only shows while a search is active.
    expect(screen.queryByText(/showing .* of .* clearances/i)).toBeNull();
  });

  it('tells the admin when nothing matches, quoting the query', async () => {
    const { user } = setup(cohort());
    await user.type(search(), 'Nonesuch');
    expect(screen.getByText(/no clearances match "Nonesuch"/i)).toBeVisible();
  });
});

describe('the confirm dialog waits for the request to settle', () => {
  it('stays open while the reject is in flight and closes only on success', async () => {
    const { user, onReject } = setup([request()]);
    let resolveReject!: (outcome: 'ok' | 'conflict' | 'failed') => void;
    onReject.mockReturnValue(
      new Promise<'ok' | 'conflict' | 'failed'>((res) => (resolveReject = res)),
    );

    await user.click(within(card()).getByRole('button', { name: /^reject$/i }));
    await user.click(screen.getByRole('button', { name: /yes, reject clearance/i }));

    // The request is pending — the dialog must not have closed yet.
    expect(screen.getByText(/reject this clearance/i)).toBeVisible();

    resolveReject('ok');
    await waitFor(() => expect(screen.queryByText(/reject this clearance/i)).toBeNull());
  });

  it('stays open when the reject fails, so the toast is visible and the admin can retry', async () => {
    const { user, onReject } = setup([request()]);
    onReject.mockResolvedValue('failed');

    await user.click(within(card()).getByRole('button', { name: /^reject$/i }));
    await user.click(screen.getByRole('button', { name: /yes, reject clearance/i }));

    expect(onReject).toHaveBeenCalledTimes(1);
    // The handler resolved 'failed' → the dialog stays mounted for a retry.
    expect(screen.getByText(/reject this clearance/i)).toBeVisible();
  });

  it('closes on a 409 conflict — the list has already refetched, so a retry would only 409 again', async () => {
    const { user, onReject } = setup([request()]);
    onReject.mockResolvedValue('conflict');

    await user.click(within(card()).getByRole('button', { name: /^reject$/i }));
    await user.click(screen.getByRole('button', { name: /yes, reject clearance/i }));

    expect(onReject).toHaveBeenCalledTimes(1);
    // The handler resolved 'conflict' → the dialog closes (the toast already told the admin).
    await waitFor(() => expect(screen.queryByText(/reject this clearance/i)).toBeNull());
  });
});

describe('the reopen dialog waits for the request to settle', () => {
  const rejected = () =>
    request({ status: 'rejected', rejectOutcome: 'source-reactivated', version: 3 });

  it('stays open while the reopen is in flight and closes only on success', async () => {
    const { user, onReopen } = setup([rejected()]);
    let resolveReopen!: (outcome: 'ok' | 'conflict' | 'failed') => void;
    onReopen.mockReturnValue(
      new Promise<'ok' | 'conflict' | 'failed'>((res) => (resolveReopen = res)),
    );

    await user.click(within(card()).getByRole('button', { name: /^reopen$/i }));
    await user.click(screen.getByRole('button', { name: /yes, reopen clearance/i }));

    expect(screen.getByText(/reopen this clearance/i)).toBeVisible();

    resolveReopen('ok');
    await waitFor(() => expect(screen.queryByText(/reopen this clearance/i)).toBeNull());
  });

  it('stays open when the reopen fails, so the admin can retry', async () => {
    const { user, onReopen } = setup([rejected()]);
    onReopen.mockResolvedValue('failed');

    await user.click(within(card()).getByRole('button', { name: /^reopen$/i }));
    await user.click(screen.getByRole('button', { name: /yes, reopen clearance/i }));

    expect(onReopen).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/reopen this clearance/i)).toBeVisible();
  });

  it('closes on a 409 conflict — the list has already refetched', async () => {
    const { user, onReopen } = setup([rejected()]);
    onReopen.mockResolvedValue('conflict');

    await user.click(within(card()).getByRole('button', { name: /^reopen$/i }));
    await user.click(screen.getByRole('button', { name: /yes, reopen clearance/i }));

    expect(onReopen).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText(/reopen this clearance/i)).toBeNull());
  });
});

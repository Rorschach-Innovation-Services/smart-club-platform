/**
 * The public pre-match squad page (/sq/<token>): roster-first selection, the guest guard
 * (only reachable when the search finds nobody, behind a confirm step), draft/submit with the
 * `expectedModified` CAS, a submitted squad that stays EDITABLE, the 409 stale reload, and the
 * closed / invalid link states. Rendered for real through the app's providers; only the HTTP
 * client is stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    getLinkedSquadRequest: vi.fn(),
    putLinkedSquadRequest: vi.fn(),
    getSquadForwardCandidates: vi.fn(),
    forwardLinkedSquadRequest: vi.fn(),
  };
});

import * as api from './api';
import { ApiError } from './api';
import { SquadSelectionLinkPage } from './SquadSelection';
import { renderWithProviders } from './test-utils';
import type { LinkedSquadRequest, SquadRequestView } from './types';

const ROSTER = [
  { id: 'r-ayanda', name: 'Ayanda Mkhize' },
  { id: 'r-keshav', name: 'Keshav Pillay' },
  { id: 'r-sipho', name: 'Sipho Ndlovu' },
];

const request = (over: Partial<SquadRequestView> = {}): SquadRequestView => ({
  id: 's1~f1~ukzn',
  seriesId: 's1',
  fixtureId: 'f1',
  teamId: 'ukzn',
  clubId: 'ukzn',
  status: 'pending',
  fixtureRef: 'smartclub:dolphins:fixture:s1:f1',
  matchDate: '2026-10-28',
  side: 'home',
  clubName: 'UKZN',
  teamName: 'UKZN',
  opponentName: 'Crusaders',
  competition: 'Premier League',
  recipient: { kind: 'captain', name: 'Ayanda Mkhize' },
  linkExpiresAt: '2026-10-28T21:59:59.000Z',
  modified: 'm1',
  createdAt: '2026-10-27T16:00:00.000Z',
  updatedAt: '2026-10-27T16:00:00.000Z',
  ...over,
});

const payload = (
  over: Partial<SquadRequestView> = {},
  extra: Partial<LinkedSquadRequest> = {},
): LinkedSquadRequest => ({
  request: request(over),
  roster: ROSTER,
  canForward: false,
  forwardsRemaining: 3,
  maxPlayers: 60,
  tenantBranding: { name: 'Dolphins Cricket', logoUrl: '', colors: {} },
  ...extra,
});

function renderPage() {
  return renderWithProviders(
    <MemoryRouter initialEntries={['/sq/tok.sig']}>
      <Routes>
        <Route path="/sq/:token" element={<SquadSelectionLinkPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const search = () => screen.getByRole('searchbox', { name: 'Search players' });

beforeEach(() => {
  vi.mocked(api.getLinkedSquadRequest).mockReset();
  vi.mocked(api.putLinkedSquadRequest).mockReset();
  vi.mocked(api.getSquadForwardCandidates).mockReset();
  vi.mocked(api.forwardLinkedSquadRequest).mockReset();
});

describe('the guest guard', () => {
  it('is not reachable while the search matches a roster player', async () => {
    vi.mocked(api.getLinkedSquadRequest).mockResolvedValue(payload());
    renderPage();
    await screen.findByText('UKZN / Squad selection');
    expect(screen.queryByRole('button', { name: /Add as guest/ })).toBeNull();
    await userEvent.type(search(), 'Keshav');
    expect(screen.getByRole('checkbox', { name: 'Keshav Pillay' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Ayanda Mkhize' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add as guest/ })).toBeNull();
    // A partial match still matches: no guest path.
    await userEvent.clear(search());
    await userEvent.type(search(), 'pil');
    expect(screen.queryByRole('button', { name: /Add as guest/ })).toBeNull();
  });

  it('opens only when nobody matches, and asks before adding', async () => {
    vi.mocked(api.getLinkedSquadRequest).mockResolvedValue(payload());
    renderPage();
    await screen.findByText('UKZN / Squad selection');
    await userEvent.type(search(), 'Thabo Zulu');
    await userEvent.click(screen.getByRole('button', { name: 'Not finding them? Add as guest' }));
    const ask = screen.getByRole('alertdialog', { name: 'Add Thabo Zulu as a guest' });
    expect(ask).toHaveTextContent("Guests aren't linked to player records");
    // Cancel leaves the squad untouched.
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('Nobody selected yet.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Not finding them? Add as guest' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add guest' }));
    const squad = screen.getByLabelText('Selected squad');
    expect(within(squad).getByText('Thabo Zulu')).toBeInTheDocument();
    expect(within(squad).getByText('(guest)')).toBeInTheDocument();
    // The search is cleared back to the full roster.
    expect(search()).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Ayanda Mkhize' })).toBeInTheDocument();
    // Guests are removable.
    await userEvent.click(within(squad).getByRole('button', { name: 'Remove guest Thabo Zulu' }));
    expect(within(squad).queryByText('Thabo Zulu')).toBeNull();
  });
});

describe('selecting and submitting', () => {
  it('submits the ticked players, the guest and the captain with the rendered CAS token', async () => {
    vi.mocked(api.getLinkedSquadRequest).mockResolvedValue(payload());
    vi.mocked(api.putLinkedSquadRequest).mockImplementation(async (_t, body) =>
      payload({
        status: 'submitted',
        modified: 'm2',
        submittedAt: '2026-10-27T17:00:00.000Z',
        selection: {
          players: body.players.map((id) => ({
            id,
            name: ROSTER.find((r) => r.id === id)!.name,
          })),
          guests: body.guests,
          captainId: body.captainId ?? undefined,
          captainName: 'Keshav Pillay',
        },
      }),
    );
    renderPage();
    await screen.findByText('UKZN / Squad selection');
    const submit = screen.getByRole('button', { name: 'Submit squad' });
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Ayanda Mkhize' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Keshav Pillay' }));
    await userEvent.type(search(), 'Guest Person');
    await userEvent.click(screen.getByRole('button', { name: 'Not finding them? Add as guest' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add guest' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Captain' }), 'r-keshav');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    await waitFor(() => expect(api.putLinkedSquadRequest).toHaveBeenCalledTimes(1));
    expect(api.putLinkedSquadRequest).toHaveBeenCalledWith('tok.sig', {
      players: ['r-ayanda', 'r-keshav'],
      guests: [{ name: 'Guest Person' }],
      captainId: 'r-keshav',
      submit: true,
      expectedModified: 'm1',
    });
    const done = await screen.findByLabelText('Submitted squad');
    expect(within(done).getByText('Squad submitted')).toBeInTheDocument();
    expect(within(done).getByText('Keshav Pillay (captain)')).toBeInTheDocument();
    expect(within(done).getByText('Guest Person (guest)')).toBeInTheDocument();
  });

  it('saves a draft without submitting', async () => {
    vi.mocked(api.getLinkedSquadRequest).mockResolvedValue(payload());
    vi.mocked(api.putLinkedSquadRequest).mockResolvedValue(
      payload({ modified: 'm2', selection: { players: [ROSTER[2]], guests: [] } }),
    );
    renderPage();
    await screen.findByText('UKZN / Squad selection');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Sipho Ndlovu' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(vi.mocked(api.putLinkedSquadRequest).mock.calls[0][1]).toMatchObject({
      players: ['r-sipho'],
      submit: false,
      expectedModified: 'm1',
    });
    // Still the editable form, reseeded from the saved copy.
    expect(screen.getByRole('checkbox', { name: 'Sipho Ndlovu' })).toBeChecked();
  });
});

describe('a submitted squad', () => {
  it('stays editable: "Edit squad" reopens the form seeded with the submitted selection', async () => {
    vi.mocked(api.getLinkedSquadRequest).mockResolvedValue(
      payload({
        status: 'submitted',
        submittedAt: '2026-10-27T17:00:00.000Z',
        selection: {
          players: [ROSTER[0], ROSTER[1]],
          guests: [{ name: 'Old Guest' }],
          captainId: 'r-ayanda',
          captainName: 'Ayanda Mkhize',
        },
      }),
    );
    vi.mocked(api.putLinkedSquadRequest).mockResolvedValue(
      payload({
        status: 'submitted',
        modified: 'm2',
        selection: { players: [ROSTER[0]], guests: [] },
      }),
    );
    renderPage();
    const done = await screen.findByLabelText('Submitted squad');
    expect(within(done).getByText('Ayanda Mkhize (captain)')).toBeInTheDocument();
    expect(screen.queryByText('This squad link is closed')).toBeNull();
    await userEvent.click(within(done).getByRole('button', { name: 'Edit squad' }));

    expect(screen.getByRole('checkbox', { name: 'Ayanda Mkhize' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Keshav Pillay' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Captain' })).toHaveValue('r-ayanda');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Keshav Pillay' }));
    await userEvent.click(
      within(screen.getByLabelText('Selected squad')).getByRole('button', {
        name: 'Remove guest Old Guest',
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Submit squad' }));
    await waitFor(() =>
      expect(api.putLinkedSquadRequest).toHaveBeenCalledWith('tok.sig', {
        players: ['r-ayanda'],
        guests: [],
        captainId: 'r-ayanda',
        submit: true,
        expectedModified: 'm1',
      }),
    );
    expect(await screen.findByLabelText('Submitted squad')).toBeInTheDocument();
  });
});

describe('a stale view (409)', () => {
  it('reloads the latest squad and says the view was out of date', async () => {
    vi.mocked(api.getLinkedSquadRequest)
      .mockResolvedValueOnce(payload())
      .mockResolvedValue(
        payload({ modified: 'm9', selection: { players: [ROSTER[2]], guests: [] } }),
      );
    vi.mocked(api.putLinkedSquadRequest).mockRejectedValueOnce(
      new ApiError(409, 'the squad was changed elsewhere — reload and try again', 'stale'),
    );
    renderPage();
    await screen.findByText('UKZN / Squad selection');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Ayanda Mkhize' }));
    await userEvent.click(screen.getByRole('button', { name: 'Submit squad' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('your view was out of date');
    await waitFor(() => expect(api.getLinkedSquadRequest).toHaveBeenCalledTimes(2));
    // The form now shows the server's copy, and the next save carries its token.
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Sipho Ndlovu' })).toBeChecked(),
    );
    expect(screen.getByRole('checkbox', { name: 'Ayanda Mkhize' })).not.toBeChecked();
    vi.mocked(api.putLinkedSquadRequest).mockResolvedValue(payload({ modified: 'm10' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(vi.mocked(api.putLinkedSquadRequest).mock.calls[1][1]).toMatchObject({
        players: ['r-sipho'],
        expectedModified: 'm9',
      }),
    );
  });
});

describe('closed and invalid links', () => {
  it('410: reads as closed, with the API reason', async () => {
    vi.mocked(api.getLinkedSquadRequest).mockRejectedValue(
      new ApiError(410, 'fixture changed — this squad link is no longer valid'),
    );
    renderPage();
    expect(await screen.findByText('This squad link is closed')).toBeInTheDocument();
    expect(
      screen.getByText('Fixture changed — this squad link is no longer valid.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('410 on expiry', async () => {
    vi.mocked(api.getLinkedSquadRequest).mockRejectedValue(
      new ApiError(410, 'This squad link has expired.'),
    );
    renderPage();
    expect(await screen.findByText('This link has expired')).toBeInTheDocument();
    expect(screen.queryByText('This squad link is closed')).toBeNull();
    expect(screen.getByText('This squad link has expired.')).toBeInTheDocument();
    // A dead link offers no retry.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('kind wins over the message: kind=transient on generic copy offers "Try again"', async () => {
    vi.mocked(api.getLinkedSquadRequest).mockRejectedValue(
      new ApiError(410, 'unavailable', undefined, { kind: 'transient' }),
    );
    renderPage();
    expect(await screen.findByText('This link is temporarily unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('kind wins over the message: kind=expired reads as expired', async () => {
    vi.mocked(api.getLinkedSquadRequest).mockRejectedValue(
      new ApiError(410, 'gone', undefined, { kind: 'expired' }),
    );
    renderPage();
    expect(await screen.findByText('This link has expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('kind=closed overrides a message that would regex-match transient', async () => {
    vi.mocked(api.getLinkedSquadRequest).mockRejectedValue(
      new ApiError(410, 'temporarily unavailable, expired', undefined, { kind: 'closed' }),
    );
    renderPage();
    expect(await screen.findByText('This squad link is closed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(api.getLinkedSquadRequest).toHaveBeenCalledTimes(1);
  });

  it('a non-transient 410 offers no retry and never refetches', async () => {
    vi.mocked(api.getLinkedSquadRequest).mockRejectedValue(
      new ApiError(410, 'fixture changed — this squad link is no longer valid'),
    );
    renderPage();
    await screen.findByText('This squad link is closed');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(api.getLinkedSquadRequest).toHaveBeenCalledTimes(1);
  });

  it('a transient 410 offers "Try again"; a successful retry lands the loaded page', async () => {
    vi.mocked(api.getLinkedSquadRequest)
      .mockRejectedValueOnce(
        new ApiError(410, 'this link is temporarily unavailable — try again shortly'),
      )
      .mockResolvedValue(payload());
    renderPage();
    expect(await screen.findByText('This link is temporarily unavailable')).toBeInTheDocument();
    expect(screen.queryByText('This squad link is closed')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('UKZN / Squad selection')).toBeInTheDocument();
    expect(screen.queryByText('This link is temporarily unavailable')).toBeNull();
  });

  it('a transient 410 auto-retries on a backoff until the link comes back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(api.getLinkedSquadRequest)
        .mockRejectedValueOnce(new ApiError(410, 'this link is temporarily unavailable'))
        .mockRejectedValueOnce(new ApiError(410, 'this link is temporarily unavailable'))
        .mockResolvedValue(payload());
      renderPage();
      await screen.findByText('This link is temporarily unavailable');
      expect(api.getLinkedSquadRequest).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      await waitFor(() => expect(api.getLinkedSquadRequest).toHaveBeenCalledTimes(2));
      expect(screen.getByText('This link is temporarily unavailable')).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await screen.findByText('UKZN / Squad selection')).toBeInTheDocument();
      expect(api.getLinkedSquadRequest).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('404: the link is not valid', async () => {
    vi.mocked(api.getLinkedSquadRequest).mockRejectedValue(new ApiError(404, 'not found'));
    renderPage();
    expect(await screen.findByText("This link isn't valid")).toBeInTheDocument();
  });

  it('a 410 on save (the link closed meanwhile) shows the closed state', async () => {
    vi.mocked(api.getLinkedSquadRequest)
      .mockResolvedValueOnce(payload())
      .mockRejectedValue(new ApiError(410, 'this link is no longer valid'));
    vi.mocked(api.putLinkedSquadRequest).mockRejectedValue(
      new ApiError(410, 'this link is no longer valid'),
    );
    renderPage();
    await screen.findByText('UKZN / Squad selection');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Ayanda Mkhize' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('This squad link is closed')).toBeInTheDocument();
  });
});

describe("the chair's link", () => {
  it('can send the squad link on to a player', async () => {
    vi.mocked(api.getLinkedSquadRequest).mockResolvedValue(
      payload({ recipient: { kind: 'chair', name: 'Club Chair' } }, { canForward: true }),
    );
    vi.mocked(api.getSquadForwardCandidates).mockResolvedValue({
      candidates: [{ id: 'c1', name: 'Keshav Pillay' }],
      remaining: 3,
    });
    vi.mocked(api.forwardLinkedSquadRequest).mockResolvedValue(
      payload(
        {
          recipient: {
            kind: 'captain',
            name: 'Keshav Pillay',
            forwardedBy: { name: 'Club Chair', via: 'link', at: '2026-10-27T17:00:00.000Z' },
          },
          modified: 'm2',
        },
        { canForward: true },
      ),
    );
    renderPage();
    await screen.findByText('UKZN / Squad selection');
    await userEvent.click(screen.getByRole('button', { name: 'Send to captain' }));
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Send to player' }),
      'c1',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(
      await screen.findByText('Sent to Keshav Pillay. They will get their own link.'),
    ).toBeInTheDocument();
    expect(api.forwardLinkedSquadRequest).toHaveBeenCalledWith('tok.sig', 'c1');
  });

  it('is not offered on a captain link', async () => {
    vi.mocked(api.getLinkedSquadRequest).mockResolvedValue(payload());
    renderPage();
    await screen.findByText('UKZN / Squad selection');
    expect(screen.queryByRole('button', { name: 'Send to captain' })).toBeNull();
  });
});

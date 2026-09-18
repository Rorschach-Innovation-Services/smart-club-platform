/**
 * Veterans squad-selection UI (ADR 0013, Task F2).
 *
 * Two surfaces:
 *  - `ClubVeteransSquadView` — the veterans club's finder + pending/recent tables. The finder is
 *    a debounced tenant-wide search, so these tests drive the real component (no hook mocking)
 *    through `renderWithProviders`, mocking only the HTTP boundary (`./api`) — the finder issues a
 *    real `useQuery`, and jsdom has no backend to answer it.
 *  - `VeteransRequestsInbox` — the primary club's Accept/Decline inbox, a pure props component.
 *
 * A `.dom.` suite because `club.tsx` imports leaflet, which reads `window` at module load (the
 * same reason `club-clearances.dom.test.tsx` carries the suffix).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from './test-utils';

// Mock only the HTTP client. `searchVeteransCandidates` (the finder), `getVeteransAffiliates`
// (the foot card) and `getClubDirectory` (the players view's veterans-club picker) are the only
// network calls these views make; everything else club.tsx imports from './api' stays real via
// importActual.
vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    searchVeteransCandidates: vi.fn(),
    getVeteransAffiliates: vi.fn(async () => []),
    getClubDirectory: vi.fn(async () => []),
  };
});

import { ClubVeteransSquadView, VeteransRequestsInbox, ClubPlayersView } from './club';
import { searchVeteransCandidates, getVeteransAffiliates, getClubDirectory } from './api';

const club = { id: 'vets-club', name: 'Old Boys CC', leagues: ['veterans-premier'] };

function req(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    candidateId: 'cand-1',
    playerName: 'Sipho Ndlovu',
    primaryClubId: 'alpha',
    primaryClubName: 'Alpha CC',
    veteransClubId: 'vets-club',
    veteransClubName: 'Old Boys CC',
    requestedAt: '2026-08-01T09:00:00.000Z',
    status: 'pending',
    version: 0,
    ...over,
  };
}

function renderSquad(
  props: {
    requests?: { inbound?: unknown[]; outbound?: unknown[] };
    onRequest?: (b: unknown) => void | Promise<unknown>;
    onWithdraw?: (r: unknown) => void | Promise<unknown>;
  } = {},
) {
  return renderWithProviders(
    <ClubVeteransSquadView
      club={club as never}
      allLeagues={[]}
      requests={
        {
          inbound: props.requests?.inbound ?? [],
          outbound: props.requests?.outbound ?? [],
        } as never
      }
      onRequest={props.onRequest ?? vi.fn()}
      onWithdraw={props.onWithdraw ?? vi.fn()}
    />,
  );
}

describe('ClubVeteransSquadView — finder', () => {
  beforeEach(() => {
    vi.mocked(searchVeteransCandidates).mockReset();
    vi.mocked(getVeteransAffiliates).mockReset().mockResolvedValue([]);
  });

  it('does not search below 3 characters and shows the minimum-length hint', async () => {
    const { getByLabelText, getByText, queryByText } = renderSquad();
    // Drive the 300 ms debounce deterministically instead of sleeping on a real clock.
    vi.useFakeTimers();
    try {
      fireEvent.change(getByLabelText('Find a player'), { target: { value: 'ab' } });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(getByText('Type at least 3 characters to search.')).toBeTruthy();
      expect(queryByText('Request')).toBeNull();
      expect(searchVeteransCandidates).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders candidate rows once 3+ characters are typed, with a Requested pill for a pending outbound request', async () => {
    vi.mocked(searchVeteransCandidates).mockResolvedValue({
      candidates: [
        {
          candidateId: 'cand-1',
          playerName: 'Sipho Ndlovu',
          primaryClubId: 'alpha',
          primaryClubName: 'Alpha CC',
        },
        {
          candidateId: 'cand-2',
          playerName: 'Thabo Mokoena',
          primaryClubId: 'beta',
          primaryClubName: 'Beta CC',
        },
      ],
      truncated: false,
    });
    // cand-1 already has a pending outbound request → its row shows "Requested", not "Request".
    const { getByLabelText, getByText, queryByText, getAllByText } = renderSquad({
      requests: { outbound: [req({ id: 'r-out', candidateId: 'cand-1' })] },
    });
    fireEvent.change(getByLabelText('Find a player'), { target: { value: 'Sip' } });

    await waitFor(() => expect(getByText('Thabo Mokoena')).toBeTruthy());
    expect(searchVeteransCandidates).toHaveBeenCalledWith('vets-club', 'Sip');
    // cand-1 appears in BOTH the finder row and the pending table; assert the finder shows the pill.
    expect(getAllByText('Requested').length).toBeGreaterThan(0);
    // cand-2 (no pending request) offers the Request button.
    expect(getByText('Request')).toBeTruthy();
    expect(queryByText('Beta CC')).toBeTruthy();
  });

  it('shows the truncated hint when the finder caps the result set', async () => {
    vi.mocked(searchVeteransCandidates).mockResolvedValue({
      candidates: [
        {
          candidateId: 'c',
          playerName: 'Many Player',
          primaryClubId: 'a',
          primaryClubName: 'A CC',
        },
      ],
      truncated: true,
    });
    const { getByLabelText, getByText } = renderSquad();
    fireEvent.change(getByLabelText('Find a player'), { target: { value: 'Man' } });
    await waitFor(() => expect(getByText('Showing first 20 — refine your search.')).toBeTruthy());
  });

  it('Request calls the handler with the primary club + candidate id', async () => {
    vi.mocked(searchVeteransCandidates).mockResolvedValue({
      candidates: [
        {
          candidateId: 'cand-9',
          playerName: 'Neo Player',
          primaryClubId: 'gamma',
          primaryClubName: 'Gamma CC',
        },
      ],
      truncated: false,
    });
    const onRequest = vi.fn().mockResolvedValue(undefined);
    const { getByLabelText, getByText } = renderSquad({ onRequest });
    fireEvent.change(getByLabelText('Find a player'), { target: { value: 'Neo' } });
    await waitFor(() => expect(getByText('Request')).toBeTruthy());
    fireEvent.click(getByText('Request'));
    expect(onRequest).toHaveBeenCalledWith({ primaryClubId: 'gamma', candidateId: 'cand-9' });
  });

  it('renders the calm not-fixtured notice on a 403 from the finder', async () => {
    const err = Object.assign(new Error('forbidden'), { status: 403 });
    vi.mocked(searchVeteransCandidates).mockRejectedValue(err);
    const { getByLabelText, getByText } = renderSquad();
    fireEvent.change(getByLabelText('Find a player'), { target: { value: 'Any' } });
    await waitFor(() => expect(getByText(/isn't fixtured in a veterans league yet/)).toBeTruthy());
  });

  it('surfaces a non-403 finder error instead of the empty "No players match" state', async () => {
    // The 500 raised when CANDIDATE_HANDLE_SECRET is unset must NOT masquerade as an empty search.
    const err = Object.assign(new Error('candidate handle secret not configured'), { status: 500 });
    vi.mocked(searchVeteransCandidates).mockRejectedValue(err);
    const { getByLabelText, getByText, queryByText } = renderSquad();
    fireEvent.change(getByLabelText('Find a player'), { target: { value: 'Any' } });
    await waitFor(() =>
      expect(getByText(/Search failed: candidate handle secret not configured/)).toBeTruthy(),
    );
    expect(getByText(/contact the union/)).toBeTruthy();
    // The misleading empty-state copy must NOT render for a real server fault.
    expect(queryByText(/No players match/)).toBeNull();
  });
});

describe('ClubVeteransSquadView — pending requests', () => {
  beforeEach(() => {
    vi.mocked(searchVeteransCandidates).mockReset();
    vi.mocked(getVeteransAffiliates).mockReset().mockResolvedValue([]);
  });

  it('Withdraw calls the handler with the request', () => {
    const onWithdraw = vi.fn().mockResolvedValue(undefined);
    const request = req({ id: 'r-out', candidateId: 'cand-1' });
    const { getByText } = renderSquad({ requests: { outbound: [request] }, onWithdraw });
    // The pending table renders a Withdraw button for the outbound request.
    fireEvent.click(getByText('Withdraw'));
    expect(onWithdraw).toHaveBeenCalledWith(request);
  });

  it('lists a resolved outbound request under Recent outcomes', () => {
    const { getByText } = renderSquad({
      requests: { outbound: [req({ id: 'r-done', status: 'accepted' })] },
    });
    expect(getByText('Recent outcomes')).toBeTruthy();
    expect(getByText('Accepted')).toBeTruthy();
  });
});

describe('VeteransRequestsInbox', () => {
  it('Accept calls the handler with the request', () => {
    const onAccept = vi.fn();
    const request = req();
    const { getByText } = renderWithProviders(
      <VeteransRequestsInbox
        requests={[request as never]}
        onAccept={onAccept}
        onDecline={vi.fn()}
      />,
    );
    // The banner names the veterans club and the player.
    expect(getByText(/asks to register/)).toBeTruthy();
    fireEvent.click(getByText('Accept'));
    expect(onAccept).toHaveBeenCalledWith(request);
  });

  it('Decline reveals an inline reason and Confirm decline passes it to the handler', () => {
    const onDecline = vi.fn();
    const request = req();
    const { getByText, getByPlaceholderText } = renderWithProviders(
      <VeteransRequestsInbox
        requests={[request as never]}
        onAccept={vi.fn()}
        onDecline={onDecline}
      />,
    );
    fireEvent.click(getByText('Decline'));
    fireEvent.change(getByPlaceholderText(/Reason \(optional\)/), {
      target: { value: 'Not eligible' },
    });
    fireEvent.click(getByText('Confirm decline'));
    expect(onDecline).toHaveBeenCalledWith(request, 'Not eligible');
  });
});

describe('ClubPlayersView — veterans request pill', () => {
  beforeEach(() => {
    vi.mocked(getVeteransAffiliates).mockReset().mockResolvedValue([]);
    vi.mocked(getClubDirectory).mockReset().mockResolvedValue([]);
  });

  function renderPlayers(over: { players?: unknown[]; inbound?: unknown[] }) {
    return renderWithProviders(
      <ClubPlayersView
        club={{ id: 'alpha', name: 'Alpha CC' } as never}
        players={(over.players ?? []) as never}
        clearances={{ incoming: [], outbound: [] } as never}
        leagues={[] as never}
        onGenerateLink={vi.fn()}
        onDeletePlayer={vi.fn()}
        toast={vi.fn()}
        veteransRequests={{ inbound: over.inbound ?? [], outbound: [] } as never}
        onAcceptVeteransRequest={vi.fn()}
        onDeclineVeteransRequest={vi.fn()}
        busyVeteransId={undefined}
      />,
    );
  }

  // Two roster rows share the display name; the inbound request carries the matching naturalKey,
  // so only that row is tagged — the homonym must NOT be cross-tagged.
  it('tags only the roster row whose naturalKey matches an inbound request', () => {
    const { getAllByText } = renderPlayers({
      players: [
        { naturalKey: 'nk-1', firstName: 'Sipho', lastName: 'Ndlovu', idNumber: 'ID-1' },
        { naturalKey: 'nk-2', firstName: 'Sipho', lastName: 'Ndlovu', idNumber: 'ID-2' },
      ],
      inbound: [req({ playerName: 'Sipho Ndlovu', playerNaturalKey: 'nk-2' })],
    });
    const pills = getAllByText('Veterans request');
    expect(pills).toHaveLength(1);
    const row = pills[0].closest('tr');
    expect(row?.textContent).toContain('ID-2');
    expect(row?.textContent).not.toContain('ID-1');
  });

  // Older API (no playerNaturalKey on the request) → fall back to the display-name match.
  it('falls back to a display-name match when the request has no naturalKey', () => {
    const { getAllByText } = renderPlayers({
      players: [{ naturalKey: 'nk-1', firstName: 'Sipho', lastName: 'Ndlovu', idNumber: 'ID-1' }],
      inbound: [req({ playerName: 'Sipho Ndlovu' })],
    });
    const pills = getAllByText('Veterans request');
    expect(pills).toHaveLength(1);
    expect(pills[0].closest('tr')?.textContent).toContain('ID-1');
  });
});

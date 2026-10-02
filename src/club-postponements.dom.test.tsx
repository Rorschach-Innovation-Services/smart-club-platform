/**
 * Fixture postponements (ADR 0015) — club portal and admin console.
 *
 * Drives the real components through `renderWithProviders`; only the HTTP client (`./api`) is
 * mocked. A `.dom.` suite because `club.tsx` (ClubFixturesView) imports leaflet, which reads
 * `window` at module load.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from './test-utils';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    createPostponement: vi.fn(),
    counterPostponement: vi.fn(),
    acceptPostponement: vi.fn(),
    withdrawPostponement: vi.fn(),
    declinePostponement: vi.fn(),
    acknowledgePostponement: vi.fn(),
    getClashHints: vi.fn(async () => ({
      results: [{ groundBusy: false, homeTeamBusy: false, awayTeamBusy: false }],
    })),
    getClubDirectory: vi.fn(async () => [
      { id: 'home-club', name: 'Home CC' },
      { id: 'away-club', name: 'Away CC' },
    ]),
    getAllPostponements: vi.fn(),
    overridePostponement: vi.fn(),
    getVenues: vi.fn(async () => [{ id: 'v1', name: 'Kingsmead' }]),
  };
});

import {
  AdminPostponements,
  PostponementsPanel,
  RequestPostponementModal,
  needsAttention,
  postponementAttentionCount,
} from './club-postponements';
import { ClubFixturesView } from './club';
import {
  ApiError,
  acceptPostponement,
  acknowledgePostponement,
  counterPostponement,
  createPostponement,
  declinePostponement,
  getAllPostponements,
  getClashHints,
  overridePostponement,
  withdrawPostponement,
} from './api';
import { qk } from './query';

const home = { id: 'home-club', name: 'Home CC', players: 3 };
const away = { id: 'away-club', name: 'Away CC' };
const seed: Array<[readonly unknown[], unknown]> = [[qk.tenant(), {}]];

function series(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    name: 'Premier League',
    startDate: '2027-03-01',
    teams: ['home-club', 'away-club'],
    maxOvers: 50,
    seriesType: 'League',
    released: true,
    releasedAt: '2027-02-20T09:00:00.000Z',
    version: 1,
    fixtures: [
      {
        id: 'f1',
        home: 'home-club',
        away: 'away-club',
        round: 1,
        date: '2027-03-14',
        time: '10:00',
      },
      {
        id: 'f2',
        home: 'away-club',
        away: 'home-club',
        round: 2,
        date: '2027-03-28',
        status: 'postponed',
        originalDate: '2027-03-21',
      },
    ],
    ...over,
  };
}

function req(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    seriesId: 's1',
    fixtureId: 'f1',
    requestingClubId: 'away-club',
    opposingClubId: 'home-club',
    originalDate: '2027-03-14',
    originalTime: '10:00',
    reason: 'Ground under water',
    proposals: [
      { by: 'requesting', date: '2027-03-20', at: '2027-03-01T08:00:00.000Z', byUser: 'a@x' },
    ],
    awaiting: 'opposing',
    status: 'open',
    requestedAt: '2027-03-01T08:00:00.000Z',
    requestedBy: 'a@x',
    version: 3,
    ...over,
  } as never;
}

describe('needsAttention / postponementAttentionCount', () => {
  it('counts open requests awaiting this side and unacknowledged union rulings', () => {
    expect(needsAttention(req(), 'home-club')).toBe(true);
    expect(needsAttention(req(), 'away-club')).toBe(false);
    const ruled = req({ status: 'admin-final', awaiting: 'none' });
    expect(needsAttention(ruled, 'away-club')).toBe(true);
    expect(
      needsAttention(
        req({
          status: 'admin-final',
          acknowledgements: { 'away-club': { at: 'x', byUser: 'y' } },
        }),
        'away-club',
      ),
    ).toBe(false);
    expect(needsAttention(req({ status: 'applied' }), 'home-club')).toBe(false);
    expect(
      postponementAttentionCount(
        { inbound: [req(), req({ id: 'p2', status: 'declined' })], outbound: [ruled] },
        'home-club',
      ),
    ).toBe(2);
    expect(postponementAttentionCount(undefined, 'home-club')).toBe(0);
  });
});

describe('RequestPostponementModal', () => {
  beforeEach(() => {
    vi.mocked(createPostponement).mockReset();
    vi.mocked(getClashHints).mockClear();
  });

  function renderModal(s = series()) {
    const props = { toast: vi.fn(), onClose: vi.fn() };
    const r = renderWithProviders(
      <RequestPostponementModal
        club={home}
        series={s}
        fixture={s.fixtures[0]}
        homeName="Home CC"
        awayName="Away CC"
        opponentName="Away CC"
        {...props}
      />,
      { seed },
    );
    return { ...r, ...props };
  }

  it('sends the new date, kick-off and reason, then tells the chair who must agree', async () => {
    vi.mocked(createPostponement).mockResolvedValue(req() as never);
    const r = renderModal();
    fireEvent.change(r.getByLabelText('New date'), { target: { value: '2027-03-20' } });
    fireEvent.change(r.getByLabelText('Kick-off'), { target: { value: '13:30' } });
    fireEvent.change(r.getByLabelText('Reason'), { target: { value: 'Ground under water' } });
    expect(await r.findByText('No clashes found for that date.')).toBeInTheDocument();
    fireEvent.click(r.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(r.onClose).toHaveBeenCalled());
    expect(createPostponement).toHaveBeenCalledWith('home-club', {
      seriesId: 's1',
      fixtureId: 'f1',
      proposedDate: '2027-03-20',
      proposedTime: '13:30',
      reason: 'Ground under water',
    });
    expect(r.toast).toHaveBeenCalledWith(expect.stringMatching(/Away CC has been asked to agree/));
  });

  it('shows the busy hints for a clashing date', async () => {
    vi.mocked(getClashHints).mockResolvedValueOnce({
      results: [{ groundBusy: true, homeTeamBusy: false, awayTeamBusy: true }],
    });
    const r = renderModal();
    fireEvent.change(r.getByLabelText('New date'), { target: { value: '2027-03-21' } });
    expect(await r.findByText('The ground is already booked at that time.')).toBeInTheDocument();
    expect(r.getByText('Away CC already plays that day.')).toBeInTheDocument();
    expect(r.queryByText('Home CC already plays that day.')).toBeNull();
    expect(getClashHints).toHaveBeenCalledWith('home-club', [
      { seriesId: 's1', fixtureId: 'f1', date: '2027-03-21', time: '10:00' },
    ]);
  });

  it('offers a date only while kick-off times are withheld', async () => {
    vi.mocked(createPostponement).mockResolvedValue(req() as never);
    const r = renderModal(series({ withheld: { time: true } }));
    expect(r.queryByLabelText('Kick-off')).toBeNull();
    expect(r.getByText(/propose a date only/)).toBeInTheDocument();
    fireEvent.change(r.getByLabelText('New date'), { target: { value: '2027-03-20' } });
    fireEvent.click(r.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(createPostponement).toHaveBeenCalled());
    expect(vi.mocked(createPostponement).mock.calls[0][1]).not.toHaveProperty('proposedTime');
  });

  it('keeps the modal open with the server’s message on a 409', async () => {
    vi.mocked(createPostponement).mockRejectedValue(
      new ApiError(
        409,
        'a postponement request for this fixture is already open',
        'postponement_exists',
      ),
    );
    const r = renderModal();
    fireEvent.change(r.getByLabelText('New date'), { target: { value: '2027-03-20' } });
    fireEvent.click(r.getByRole('button', { name: 'Send request' }));
    expect(await r.findByRole('alert')).toHaveTextContent(/already open/);
    expect(r.onClose).not.toHaveBeenCalled();
  });
});

describe('PostponementsPanel', () => {
  beforeEach(() => {
    for (const fn of [
      acceptPostponement,
      counterPostponement,
      declinePostponement,
      withdrawPostponement,
      acknowledgePostponement,
    ])
      vi.mocked(fn).mockReset();
  });

  function renderPanel(
    data: { inbound?: unknown[]; outbound?: unknown[] },
    club: { id: string; name: string } = home,
  ) {
    const toast = vi.fn();
    const r = renderWithProviders(
      <PostponementsPanel
        club={club}
        postponements={{ inbound: data.inbound ?? [], outbound: data.outbound ?? [] } as never}
        allSeries={[series()]}
        clubs={[club]}
        toast={toast}
      />,
      { seed },
    );
    return { ...r, toast };
  }

  it('shows whose turn it is with the fixture, original date and history', async () => {
    const r = renderPanel({ inbound: [req()] });
    expect(r.getByText('Your turn to respond')).toBeInTheDocument();
    expect(r.getByText('“Ground under water”')).toBeInTheDocument();
    expect(await r.findByText(/requested by Away CC/)).toBeInTheDocument();
    expect(r.getByRole('button', { name: /^Accept / })).toBeInTheDocument();
    expect(r.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(r.queryByRole('button', { name: 'Withdraw request' })).toBeNull();
  });

  it('accepts the current proposal pinned to the version it showed', async () => {
    vi.mocked(acceptPostponement).mockResolvedValue(req({ status: 'applied' }) as never);
    const r = renderPanel({ inbound: [req()] });
    fireEvent.click(r.getByRole('button', { name: /^Accept / }));
    await waitFor(() => expect(r.toast).toHaveBeenCalledWith(expect.stringMatching(/^Agreed/)));
    expect(acceptPostponement).toHaveBeenCalledWith('home-club', 'p1', 3);
  });

  it('keeps the request open and lists the clash when accept is refused', async () => {
    vi.mocked(acceptPostponement).mockRejectedValue(
      new ApiError(409, 'that date clashes with another fixture', 'venue_clash', {
        clashes: [
          {
            fixtureId: 'f1',
            date: '2027-03-20',
            ground: 'Kingsmead',
            with: { seriesId: 's9', fixtureId: 'x', home: 'Gamma', away: 'Delta' },
          },
        ],
        teamBusy: [{ side: 'away', team: 'Away CC', date: '2027-03-20' }],
      }),
    );
    const r = renderPanel({ inbound: [req()] });
    fireEvent.click(r.getByRole('button', { name: /^Accept / }));
    const alert = await r.findByRole('alert');
    expect(alert).toHaveTextContent(/that date clashes/);
    expect(alert).toHaveTextContent(/Kingsmead is already booked on .*\(Gamma v Delta\)/);
    expect(alert).toHaveTextContent(/Away CC already plays on/);
    expect(r.getByRole('button', { name: /^Accept / })).toBeInTheDocument();
  });

  it('sends a counter-proposal with its note and version', async () => {
    vi.mocked(counterPostponement).mockResolvedValue(req() as never);
    const r = renderPanel({ inbound: [req()] });
    fireEvent.click(r.getByRole('button', { name: 'Propose another date' }));
    fireEvent.change(r.getByLabelText('Counter date'), { target: { value: '2027-03-27' } });
    fireEvent.change(r.getByLabelText('Note'), { target: { value: 'Saturday suits us' } });
    fireEvent.click(r.getByRole('button', { name: 'Send counter-proposal' }));
    await waitFor(() => expect(counterPostponement).toHaveBeenCalled());
    expect(counterPostponement).toHaveBeenCalledWith('home-club', 'p1', {
      proposedDate: '2027-03-27',
      note: 'Saturday suits us',
      version: 3,
    });
  });

  it('declines with a reason', async () => {
    vi.mocked(declinePostponement).mockResolvedValue(req({ status: 'declined' }) as never);
    const r = renderPanel({ inbound: [req()] });
    fireEvent.click(r.getByRole('button', { name: 'Decline' }));
    fireEvent.change(r.getByLabelText('Decline reason'), { target: { value: 'No ground' } });
    fireEvent.click(r.getByRole('button', { name: 'Confirm decline' }));
    await waitFor(() =>
      expect(declinePostponement).toHaveBeenCalledWith('home-club', 'p1', {
        declineReason: 'No ground',
        version: 3,
      }),
    );
  });

  it('lets the requesting club withdraw while it waits', async () => {
    vi.mocked(withdrawPostponement).mockResolvedValue(req({ status: 'withdrawn' }) as never);
    const r = renderPanel({ outbound: [req()] }, away);
    expect(await r.findByText('Waiting for Home CC')).toBeInTheDocument();
    expect(r.queryByRole('button', { name: /^Accept / })).toBeNull();
    fireEvent.click(r.getByRole('button', { name: 'Withdraw request' }));
    await waitFor(() => expect(withdrawPostponement).toHaveBeenCalledWith('away-club', 'p1', 3));
  });

  it('asks each club to acknowledge a union ruling once', async () => {
    vi.mocked(acknowledgePostponement).mockResolvedValue(req() as never);
    const ruling = req({
      status: 'admin-final',
      awaiting: 'none',
      proposals: [
        { by: 'requesting', date: '2027-03-20', at: '2027-03-01T08:00:00.000Z', byUser: 'a@x' },
        {
          by: 'admin',
          date: '2027-04-03',
          venueName: 'Kingsmead',
          at: '2027-03-02T08:00:00.000Z',
          byUser: 'admin@x',
        },
      ],
    });
    const r = renderPanel({ inbound: [ruling] });
    expect(r.getByText('Union ruling')).toBeInTheDocument();
    expect(r.getAllByText(/Kingsmead/).length).toBeGreaterThan(0);
    fireEvent.click(r.getByRole('button', { name: 'Acknowledge ruling' }));
    await waitFor(() => expect(acknowledgePostponement).toHaveBeenCalledWith('home-club', 'p1', 3));
  });

  it('tucks closed requests under a history toggle', () => {
    const r = renderPanel({ inbound: [req({ status: 'declined', declineReason: 'No' })] });
    expect(r.getByText('No postponements in progress.')).toBeInTheDocument();
    fireEvent.click(r.getByRole('button', { name: /Show past requests \(1\)/ }));
    expect(r.getByText('Declined')).toBeInTheDocument();
  });
});

describe('ClubFixturesView — postponement wiring', () => {
  function renderFixtures(postponements?: unknown) {
    return renderWithProviders(
      <ClubFixturesView
        club={home}
        allSeries={[series()]}
        clubs={[home, away]}
        toast={vi.fn()}
        onSendFixtures={vi.fn()}
        postponements={postponements as never}
      />,
      { seed },
    );
  }

  it('marks a postponed fixture and strikes its original date, wired or not', () => {
    const r = renderFixtures();
    expect(r.getByText('Postponed')).toBeInTheDocument();
    expect(r.getByText('was')).toBeInTheDocument();
    expect(r.queryByRole('button', { name: 'Postpone' })).toBeNull();
  });

  it('offers Postpone per upcoming fixture and opens the request modal', async () => {
    const r = renderFixtures({ inbound: [], outbound: [] });
    const buttons = r.getAllByRole('button', { name: 'Postpone' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    const dialog = await r.findByRole('dialog');
    expect(within(dialog).getByLabelText('New date')).toBeInTheDocument();
    expect(within(dialog).getByText(/Away CC is asked to agree/)).toBeInTheDocument();
  });

  it('shows an open request instead of a second Postpone button', () => {
    const r = renderFixtures({ inbound: [req()], outbound: [] });
    expect(r.getAllByText('Postponement open').length).toBe(1);
    expect(r.getAllByRole('button', { name: 'Postpone' })).toHaveLength(1);
    expect(r.getByRole('region', { name: 'Postponements' })).toBeInTheDocument();
  });
});

describe('AdminPostponements', () => {
  beforeEach(() => {
    vi.mocked(getAllPostponements).mockReset();
    vi.mocked(overridePostponement).mockReset();
  });

  function renderAdmin() {
    const toast = vi.fn();
    const r = renderWithProviders(
      <AdminPostponements allSeries={[series()]} clubs={[home, away]} toast={toast} />,
      { seed },
    );
    return { ...r, toast };
  }

  it('lists open requests by default with the clubs and whose turn it is', async () => {
    vi.mocked(getAllPostponements).mockResolvedValue([
      req(),
      req({ id: 'p2', status: 'withdrawn' }),
    ] as never);
    const r = renderAdmin();
    expect(await r.findByText('Waiting for Home CC')).toBeInTheDocument();
    expect(r.getByText('Premier League · R1')).toBeInTheDocument();
    expect(r.getAllByRole('button', { name: 'Set final date' })).toHaveLength(1);
    fireEvent.click(r.getByRole('button', { name: /Withdrawn/ }));
    expect(r.queryByRole('button', { name: 'Set final date' })).toBeNull();
  });

  it('sets a final date with a ground from the list', async () => {
    vi.mocked(getAllPostponements).mockResolvedValue([req()] as never);
    vi.mocked(overridePostponement).mockResolvedValue(req({ status: 'admin-final' }) as never);
    const r = renderAdmin();
    fireEvent.click(await r.findByRole('button', { name: 'Set final date' }));
    const dialog = await r.findByRole('dialog');
    expect(within(dialog).getByLabelText('Final date')).toHaveValue('2027-03-20');
    fireEvent.change(within(dialog).getByLabelText('Final date'), {
      target: { value: '2027-04-03' },
    });
    await within(dialog).findByRole('option', { name: 'Kingsmead' });
    fireEvent.change(within(dialog).getByLabelText('Venue'), { target: { value: 'v1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set final date' }));
    await waitFor(() => expect(r.toast).toHaveBeenCalledWith(expect.stringMatching(/notified/)));
    expect(overridePostponement).toHaveBeenCalledWith('p1', {
      date: '2027-04-03',
      time: '10:00',
      venueId: 'v1',
      version: 3,
    });
  });

  it('shows the clash gate’s refusal through the ClashPanel', async () => {
    vi.mocked(getAllPostponements).mockResolvedValue([req()] as never);
    vi.mocked(overridePostponement).mockRejectedValue(
      new ApiError(409, 'Change blocked', 'venue_clash', {
        clashes: [
          {
            fixtureId: 'f1',
            ground: 'Kingsmead',
            date: '2027-04-03',
            with: { seriesId: 's9', seriesName: 'Div 2', fixtureId: 'x', home: 'G', away: 'D' },
          },
        ],
      }),
    );
    const r = renderAdmin();
    fireEvent.click(await r.findByRole('button', { name: 'Set final date' }));
    const dialog = await r.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set final date' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('That date clashes');
    expect(alert).toHaveTextContent(/Kingsmead on .* is already booked by Div 2 · G v D/);
  });
});

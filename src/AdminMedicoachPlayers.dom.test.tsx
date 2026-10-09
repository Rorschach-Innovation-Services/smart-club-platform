/**
 * The "Players" panel on the admin Medicoach sync page (ADR 0019): counts, parked/stuck retry,
 * and the review list with its four decisions. Rendered for real through the app's providers;
 * only the HTTP client is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    getMedicoachSyncStatus: vi.fn(),
    getMedicoachPlayerReviews: vi.fn(),
    resolveMedicoachPlayerReview: vi.fn(),
    retryMedicoachPlayers: vi.fn(),
  };
});

import * as api from './api';
import { AdminMedicoachSyncView, resolveToast, syncNowToast } from './AdminMedicoachSync';
import { renderWithProviders } from './test-utils';

const status = (players: api.MedicoachPlayerSyncStatus): api.MedicoachSyncStatus => ({
  enabled: true,
  dryRun: false,
  cursor: null,
  health: { lastSuccessAt: '2026-10-03T08:00:00.000Z' },
  logs: [],
  outbox: { count: 0, held: [], failures: [] },
  conflicts: [],
  pendingReports: 0,
  noticesFailed: 0,
  players,
});

const on = (over: Partial<Extract<api.MedicoachPlayerSyncStatus, { enabled: true }>> = {}) =>
  ({
    enabled: true as const,
    pending: 3,
    parked: 0,
    stuck: 0,
    reviews: 0,
    missingTeamRefs: [],
    ...over,
  }) satisfies api.MedicoachPlayerSyncStatus;

const MEDICOACH_REVIEW: api.MedicoachPlayerReview = {
  naturalKey: 'nk-a',
  reason: 'medicoach-needs-review',
  message: 'name+dob match at a different institution',
  detectedAt: '2026-10-07T08:00:00.000Z',
  playerName: 'Sipho Dlamini',
  dob: '2008-03-14',
  clubName: 'Crusaders CC',
  candidates: [
    { playerId: 'pl_1', name: 'Sipho Dlamini', dob: '2008-03-14', institutionName: 'Umzinto CC' },
    { playerId: 'pl_2', name: 'S. Dlamini', dob: null, institutionName: null },
  ],
};
const DUPLICATE_REVIEW: api.MedicoachPlayerReview = {
  naturalKey: 'nk-b',
  reason: 'smartclub-possible-duplicate',
  detectedAt: '2026-10-07T08:00:00.000Z',
  playerName: 'Thabo Nkosi',
  dob: '2004-04-04',
  clubName: 'Savages CC',
  candidates: [{ name: 'Thabo Nkosi', dob: '2004-04-04', institutionName: 'Kloof CC' }],
};

function renderPage(s: api.MedicoachSyncStatus, reviews: api.MedicoachPlayerReview[] = []) {
  vi.mocked(api.getMedicoachSyncStatus).mockResolvedValue(s);
  vi.mocked(api.getMedicoachPlayerReviews).mockResolvedValue(reviews);
  vi.mocked(api.resolveMedicoachPlayerReview).mockResolvedValue({ status: 'queued' });
  vi.mocked(api.retryMedicoachPlayers).mockResolvedValue({ requeued: 2 });
  const onToast = vi.fn();
  renderWithProviders(
    <AdminMedicoachSyncView allSeries={[]} onEditFixture={vi.fn()} onToast={onToast} />,
  );
  return { onToast };
}

beforeEach(() => vi.clearAllMocks());

describe('Players panel', () => {
  it('is absent while the player sync is off', async () => {
    renderPage(status({ enabled: false }));
    await screen.findByTestId('mcs-health');
    expect(screen.queryByTestId('mcs-players')).not.toBeInTheDocument();
    expect(api.getMedicoachPlayerReviews).not.toHaveBeenCalled();
  });

  it('shows waiting, parked and review counts', async () => {
    renderPage(status(on({ pending: 3, parked: 1, reviews: 2 })));
    const panel = await screen.findByTestId('mcs-players');
    expect(within(panel).getByText('Waiting to send').nextSibling).toHaveTextContent('3');
    expect(within(panel).getByText('Waiting for a team').nextSibling).toHaveTextContent('1');
    expect(within(panel).getByText('For your review').nextSibling).toHaveTextContent('2');
  });

  it('parked players: explains the top-up and retries them', async () => {
    const { onToast } = renderPage(
      status(on({ parked: 2, missingTeamRefs: ['smartclub:d:team:premier:x'] })),
    );
    const panel = await screen.findByTestId('mcs-players');
    expect(within(panel).getByText(/wait for a team medicoach doesn.t have/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Retry waiting players' }));
    expect(api.retryMedicoachPlayers).toHaveBeenCalledWith('parked');
    expect(onToast).toHaveBeenCalledWith('2 player(s) will be sent on the next sync');
  });

  it('medicoach review: link to a candidate, or create new acknowledging every candidate', async () => {
    renderPage(status(on({ reviews: 1 })), [MEDICOACH_REVIEW]);
    const list = await screen.findByTestId('mcs-player-reviews');
    expect(within(list).getByText('medicoach found a possible match')).toBeInTheDocument();
    expect(within(list).getByText('Umzinto CC · 2008-03-14')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'They are different people' })).toBeNull();

    await userEvent.click(within(list).getAllByRole('button', { name: 'Link to this player' })[0]);
    expect(api.resolveMedicoachPlayerReview).toHaveBeenCalledWith('nk-a', {
      action: 'link',
      medicoachPlayerId: 'pl_1',
    });
    await userEvent.click(
      await within(list).findByRole('button', { name: 'None of these — create new' }),
    );
    expect(api.resolveMedicoachPlayerReview).toHaveBeenLastCalledWith('nk-a', {
      action: 'create',
      acknowledgedCandidates: ['pl_1', 'pl_2'],
    });
  });

  it('possible duplicate: confirm different people, or dismiss', async () => {
    renderPage(status(on({ reviews: 1 })), [DUPLICATE_REVIEW]);
    const list = await screen.findByTestId('mcs-player-reviews');
    expect(
      within(list).getByText('Same name and date of birth under another ID here'),
    ).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Link to this player' })).toBeNull();
    await userEvent.click(within(list).getByRole('button', { name: 'They are different people' }));
    expect(api.resolveMedicoachPlayerReview).toHaveBeenCalledWith('nk-b', { action: 'distinct' });
    await userEvent.click(await within(list).findByRole('button', { name: 'Dismiss' }));
    expect(api.resolveMedicoachPlayerReview).toHaveBeenLastCalledWith('nk-b', {
      action: 'dismiss',
    });
  });

  it('a review with no candidates shows medicoach’s message and only Dismiss', async () => {
    renderPage(status(on({ reviews: 1 })), [
      { ...MEDICOACH_REVIEW, message: 'out-of-tenant-identity-conflict', candidates: [] },
    ]);
    const list = await screen.findByTestId('mcs-player-reviews');
    expect(within(list).getByRole('note')).toHaveTextContent('out-of-tenant-identity-conflict');
    expect(within(list).queryByRole('button', { name: /create new/ })).toBeNull();
    expect(within(list).queryByRole('button', { name: 'Link to this player' })).toBeNull();
    await userEvent.click(within(list).getByRole('button', { name: 'Dismiss' }));
    expect(api.resolveMedicoachPlayerReview).toHaveBeenCalledWith('nk-a', { action: 'dismiss' });
  });

  it('a decision says whether it was sent, queued or needs review', async () => {
    const { onToast } = renderPage(status(on({ reviews: 1 })), [MEDICOACH_REVIEW]);
    const list = await screen.findByTestId('mcs-player-reviews');
    await userEvent.click(within(list).getAllByRole('button', { name: 'Link to this player' })[0]);
    expect(onToast).toHaveBeenCalledWith('Linked — queued, will send on the next sync');
    expect(resolveToast('Linked', { status: 'sent' })).toEqual(['Linked — sent to medicoach']);
    expect(resolveToast('New player', { status: 'review' })[1]).toBe('warn');
    expect(resolveToast('Dismissed', { status: 'dismissed' })).toEqual([
      'Dismissed — nothing was sent',
    ]);
  });

  it('players an admin re-queued stay visible as queued', async () => {
    renderPage(status(on({ pending: 2, queued: 2 })));
    const queued = await screen.findByTestId('mcs-players-queued');
    expect(queued).toHaveTextContent('Queued');
    expect(queued).toHaveTextContent('2 player(s) you retried or decided on are queued');
    expect(within(screen.getByTestId('mcs-players')).getByText(/2 queued by you/)).toBeVisible();
  });

  it('says how many players are not sent at their request — a count, nothing to act on', async () => {
    renderPage(status(on({ optedOut: 1 })));
    const note = await screen.findByTestId('mcs-players-opted-out');
    expect(note).toHaveTextContent('1 player(s) are not sent to the Match Centre at their request');
    expect(note).toHaveTextContent('Their registration here is unchanged');
    expect(within(note).queryByRole('button')).toBeNull();
  });

  it('shows no opted-out note when nobody opted out', async () => {
    renderPage(status(on({})));
    await screen.findByTestId('mcs-players');
    expect(screen.queryByTestId('mcs-players-opted-out')).toBeNull();
  });

  it('the page header counts player reviews with the schedule changes', async () => {
    renderPage({
      ...status(on({ reviews: 2, parked: 1 })),
      attention: { conflicts: 0, playerReviews: 2, playersParked: 1, total: 3 },
    });
    const stats = await screen.findByTestId('mcs-stats');
    expect(within(stats).getByText('For your review').nextSibling).toHaveTextContent('2');
    expect(stats).toHaveTextContent('2 player(s) · 1 waiting for a team');
  });

  it('a push that never reached medicoach says so — not "not accepted"', async () => {
    renderPage({
      ...status(on()),
      logs: [
        {
          id: 'l2',
          at: '2026-10-07T08:00:00.000Z',
          trigger: 'cron',
          kind: 'player-push',
          outcome: 'error',
          pages: 0,
          fixtures: 0,
          counts: {},
          playerPush: { sent: 4, unreached: 4, errors: 0 },
        },
        {
          id: 'l3',
          at: '2026-10-07T07:00:00.000Z',
          trigger: 'cron',
          kind: 'player-push',
          outcome: 'error',
          pages: 0,
          fixtures: 0,
          counts: {},
          playerPush: { sent: 3, created: 1, errors: 1, unreached: 1 },
        },
      ],
    });
    expect(
      await screen.findByText("Couldn't reach medicoach — 4 player(s) still queued."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Sent 2 player(s) to medicoach: 1 added, 1 not accepted. Couldn't reach medicoach — 1 player(s) still queued.",
      ),
    ).toBeInTheDocument();
  });

  it('warns that linking a candidate at another club moves them off that club’s team', async () => {
    renderPage(status(on({ reviews: 1 })), [
      {
        ...MEDICOACH_REVIEW,
        clubName: 'Crusaders CC',
        candidates: [
          { playerId: 'pl_1', name: 'Sipho Dlamini', dob: null, institutionName: 'Umzinto CC' },
          { playerId: 'pl_2', name: 'Sipho Dlamini', dob: null, institutionName: 'crusaders  cc' },
        ],
      },
    ]);
    const list = await screen.findByTestId('mcs-player-reviews');
    const notes = within(list).getAllByRole('note');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent(/they will leave Umzinto CC.s synced team/);
  });

  it('"Sync now" on a large backlog says how many remain for the next sync', () => {
    expect(
      syncNowToast({
        status: 'ok',
        playerPush: { status: 'ok', deferred: 450, counts: { sent: 50 } },
      }),
    ).toEqual([
      'Sync finished — sent 50 player(s), 450 remaining; the next sync continues automatically',
    ]);
    expect(syncNowToast({ status: 'ok', playerPush: { status: 'ok', deferred: 0 } })).toEqual([
      'Sync finished',
    ]);
    expect(syncNowToast({ status: 'dry-run' })[0]).toMatch(/^Dry run/);
  });

  it('summarises a player push in recent activity', async () => {
    renderPage({
      ...status(on()),
      logs: [
        {
          id: 'l1',
          at: '2026-10-07T08:00:00.000Z',
          trigger: 'cron',
          kind: 'player-push',
          outcome: 'ok',
          pages: 0,
          fixtures: 0,
          counts: {},
          playerPush: { sent: 3, created: 2, parked: 1 },
        },
      ],
    });
    expect(
      await screen.findByText('Sent 3 player(s) to medicoach: 2 added, 1 waiting for a team.'),
    ).toBeInTheDocument();
  });
});

/**
 * The admin "Medicoach sync" page: what the union office is told about the 15-minute sync.
 * Rendered for real through the app's providers; only the HTTP client is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    getMedicoachSyncStatus: vi.fn(),
    retryMedicoachOutbox: vi.fn(),
    dropMedicoachOutbox: vi.fn(),
    applyMedicoachConflict: vi.fn(),
    discardMedicoachConflict: vi.fn(),
    getMatchMonitor: vi.fn(),
  };
});

import * as api from './api';
import { AdminMedicoachSyncView } from './AdminMedicoachSync';
import { renderWithProviders } from './test-utils';
import type { Series } from './types';

const SERIES = [
  {
    id: 's1',
    name: 'Premier T20',
    participants: [
      { teamId: 'a', clubId: 'a', name: 'UKZN CC' },
      { teamId: 'b', clubId: 'b', name: 'Crusaders CC' },
    ],
    fixtures: [{ id: 'f1', date: '2026-10-16', time: '13:30', home: 'a', away: 'b' }],
  },
  { id: 's-draft', name: 'Promotion T20 draft', participants: [], fixtures: [] },
] as unknown as Series[];

const baseStatus = (over: Partial<api.MedicoachSyncStatus> = {}): api.MedicoachSyncStatus => ({
  enabled: true,
  dryRun: false,
  cursor: { cursor: 'c-2', updatedAt: '2026-10-03T08:00:00.000Z' },
  health: { lastSuccessAt: '2026-10-03T08:00:00.000Z', lastAttemptAt: '2026-10-03T08:00:00.000Z' },
  logs: [],
  outbox: { count: 0, held: [], failures: [] },
  conflicts: [],
  pendingReports: 0,
  noticesFailed: 0,
  ...over,
});

function renderPage(status: api.MedicoachSyncStatus) {
  vi.mocked(api.getMedicoachSyncStatus).mockResolvedValue(status);
  const onOpenSeries = vi.fn();
  const onToast = vi.fn();
  renderWithProviders(
    <AdminMedicoachSyncView
      allSeries={SERIES}
      onEditFixture={vi.fn()}
      onOpenSeries={onOpenSeries}
      onToast={onToast}
    />,
  );
  return { onOpenSeries, onToast };
}

beforeEach(() => {
  vi.clearAllMocks();
  // These suites are about the "Sync health" tab; the page remembers the last tab chosen.
  localStorage.setItem('smartclub.medicoachSync.tab', 'sync');
});

describe('health', () => {
  it('shows the last successful sync prominently', async () => {
    renderPage(baseStatus());
    const card = await screen.findByTestId('mcs-health');
    expect(within(card).getByText('Last successful sync')).toBeInTheDocument();
    expect(within(card).getByText(/3 Oct, 10:00/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains a failed last run in plain language, technical detail behind Details', async () => {
    renderPage(
      baseStatus({
        health: {
          lastSuccessAt: '2026-10-03T08:00:00.000Z',
          lastErrorAt: '2026-10-03T08:15:00.000Z',
          lastError: 'medicoach answered HTTP 401',
          lastErrorText:
            'medicoach rejected our credentials — check the MedicoachSyncSecret matches on both sides.',
        },
      }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/medicoach rejected our credentials/);
    const details = within(alert).getByText('Details');
    expect(within(alert).getByText('medicoach answered HTTP 401')).not.toBeVisible();
    await userEvent.click(details);
    expect(within(alert).getByText('medicoach answered HTTP 401')).toBeVisible();
  });

  it('says when nothing has run yet', async () => {
    renderPage(baseStatus({ health: null, cursor: null }));
    expect(await screen.findByText(/No successful sync yet/)).toBeInTheDocument();
    expect(screen.getByText(/No sync activity yet/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing to review/)).toBeInTheDocument();
  });
});

describe('conflict inbox', () => {
  const conflict: api.MedicoachSyncConflict = {
    ref: 'smartclub:dolphins:fixture:s1:f1',
    seriesId: 's1',
    fixtureId: 'f1',
    seriesName: 'Premier T20',
    matchLine: 'UKZN CC v Crusaders CC',
    current: { date: '2026-10-16', time: '09:00', venue: 'Crusaders Park', status: 'scheduled' },
    proposed: {
      scheduledTime: '2026-10-16T13:30:00+02:00',
      timeTbc: false,
      dateTbc: false,
      venue: 'Howard College Oval',
      postponed: false,
      cancelled: false,
      changedAt: '2026-10-03T07:00:00.000Z',
    },
    proposedText: '2026-10-16 13:30 · Howard College Oval',
    proposedParts: {
      date: '2026-10-16',
      time: '13:30',
      venue: 'Howard College Oval',
      status: 'scheduled',
    },
    fields: ['time', 'venue'],
    reason: 'clash',
    detail: ['R1 Clares v Chatsworth: Howard College Oval on 2026-10-16 13:30 is already booked'],
    detectedAt: '2026-10-03T07:05:00.000Z',
  };

  it('shows both versions side by side, the reason and the plain actions', async () => {
    renderPage(baseStatus({ conflicts: [conflict] }));
    const card = await screen.findByRole('article', { name: /UKZN CC v Crusaders CC/ });
    const table = within(card).getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Smart club now' })).toBeInTheDocument();
    expect(
      within(table).getByRole('columnheader', { name: 'medicoach wants' }),
    ).toBeInTheDocument();
    const time = within(table).getByRole('row', { name: /Time/ });
    expect(time).toHaveTextContent('09:00');
    expect(time).toHaveTextContent('13:30');
    expect(within(card).getByText(/already booked/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: "Accept medicoach's change" })).toBeVisible();
    expect(within(card).getByRole('button', { name: "Keep smart club's version" })).toBeVisible();
    expect(within(card).getByText(/sends smart club's version back to medicoach/)).toBeVisible();
  });

  it('names an unrecognised venue', async () => {
    renderPage(
      baseStatus({
        conflicts: [
          {
            ...conflict,
            reason: 'venue-unresolved',
            detail: ['"Glenwood Lower" does not match any ground in the venue list'],
          },
        ],
      }),
    );
    const card = await screen.findByRole('article', { name: /UKZN CC v Crusaders CC/ });
    expect(within(card).getByText('Venue not recognised')).toBeInTheDocument();
  });
});

describe('outbox', () => {
  const stuck = {
    ref: 'smartclub:dolphins:fixture:s1:f1',
    seriesId: 's1',
    fixtureId: 'f1',
    attempts: 5,
    stuck: true,
    lastError: 'fixture locked',
    lastErrorText: "medicoach couldn't apply this change: fixture locked.",
    lastAttemptAt: '2026-10-03T08:00:00.000Z',
    enqueuedAt: '2026-10-03T07:00:00.000Z',
    proposed: '2026-10-16 13:30 · Howard College Oval',
  };

  it('a stuck row names the fixture, explains the error and offers Retry and Drop', async () => {
    vi.mocked(api.retryMedicoachOutbox).mockResolvedValue({ status: 'sent' });
    const { onToast } = renderPage(
      baseStatus({ outbox: { count: 1, held: [], failures: [stuck] } }),
    );
    const row = await screen.findByRole('article', { name: /UKZN CC v Crusaders CC/ });
    expect(within(row).getByText(/Stuck/)).toBeInTheDocument();
    expect(within(row).getByText(/couldn't apply this change: fixture locked/)).toBeVisible();
    await userEvent.click(within(row).getByRole('button', { name: 'Retry now' }));
    expect(api.retryMedicoachOutbox).toHaveBeenCalledWith(stuck.ref);
    expect(onToast).toHaveBeenCalledWith(expect.stringMatching(/sent to medicoach/i));
  });

  it('Drop asks first, then drops', async () => {
    vi.mocked(api.dropMedicoachOutbox).mockResolvedValue({ status: 'dropped' });
    renderPage(baseStatus({ outbox: { count: 1, held: [], failures: [stuck] } }));
    const row = await screen.findByRole('article', { name: /UKZN CC v Crusaders CC/ });
    await userEvent.click(within(row).getByRole('button', { name: 'Drop…' }));
    const dialog = screen.getByRole('dialog', { name: /Drop this change/ });
    expect(api.dropMedicoachOutbox).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Drop the change' }));
    expect(api.dropMedicoachOutbox).toHaveBeenCalledWith(stuck.ref);
  });

  it('held rows explain why and link to their series', async () => {
    const { onOpenSeries } = renderPage(
      baseStatus({
        outbox: {
          count: 1,
          failures: [],
          held: [
            {
              ref: 'smartclub:dolphins:fixture:s-draft:f1',
              seriesId: 's-draft',
              fixtureId: 'f1',
              enqueuedAt: '2026-10-03T07:00:00.000Z',
              proposed: '2026-10-16 10:30',
            },
          ],
        },
      }),
    );
    expect(
      await screen.findByText(
        "medicoach's match centre is public, so changes to draft or withheld series are held and go out when you release or reveal.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: /Promotion T20 draft/ }));
    expect(onOpenSeries).toHaveBeenCalledWith('s-draft');
  });
});

describe('match monitor tab', () => {
  const today = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
  const monitor = (over: Partial<api.MatchMonitorResponse> = {}): api.MatchMonitorResponse => ({
    date: today,
    generatedAt: new Date().toISOString(),
    dryRun: false,
    reachable: true,
    unmatched: 0,
    matches: [
      {
        ref: 'smartclub:dolphins:fixture:s1:f1',
        seriesId: 's1',
        seriesName: 'Premier T20',
        fixtureId: 'f1',
        home: 'UKZN CC',
        away: 'Crusaders CC',
        venue: 'Howard College Oval',
        date: today,
        time: '00:00',
        fixtureStatus: 'scheduled',
        live: null,
      },
    ],
    ...over,
  });

  beforeEach(() => localStorage.removeItem('smartclub.medicoachSync.tab'));

  it('opens on the monitor, lists the day and flags a start with no live scoring', async () => {
    vi.mocked(api.getMatchMonitor).mockResolvedValue(monitor());
    renderPage(baseStatus());
    expect(
      await screen.findByRole('tab', { name: 'Match monitor', selected: true }),
    ).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Games' });
    expect(within(table).getByText('UKZN CC v Crusaders CC')).toBeInTheDocument();
    expect(vi.mocked(api.getMatchMonitor)).toHaveBeenCalledWith(today);
    // The demo fixture "started" at 00:00 SAST today: past the 15-minute grace unless it is
    // just after midnight, when it is still awaiting its start.
    const flag = within(table).queryByText(/No live scoring/);
    if (Date.now() + 2 * 3_600_000 - Date.parse(`${today}T00:15:00Z`) >= 0)
      expect(flag).toBeInTheDocument();
  });

  it('says plainly when medicoach is unreachable, and keeps the fixtures', async () => {
    vi.mocked(api.getMatchMonitor).mockResolvedValue(
      monitor({
        reachable: false,
        error: 'Couldn’t reach medicoach — timed out.',
        technical: 'medicoach unreachable: TimeoutError',
      }),
    );
    renderPage(baseStatus());
    expect(await screen.findByText(/Live scoring unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/timed out/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Games' })).toBeInTheDocument();
  });

  it('switches to Sync health and remembers it', async () => {
    vi.mocked(api.getMatchMonitor).mockResolvedValue(monitor());
    renderPage(baseStatus());
    await userEvent.click(await screen.findByRole('tab', { name: 'Sync health' }));
    expect(await screen.findByTestId('mcs-health')).toBeInTheDocument();
    expect(localStorage.getItem('smartclub.medicoachSync.tab')).toBe('sync');
  });
});

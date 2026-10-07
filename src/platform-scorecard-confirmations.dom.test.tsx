/**
 * Operator console "Scorecard confirmations": both clubs' answers per fixture, the correction
 * text on demand, the digests' notice chips, week stepping and "Run now". Plus the per-tenant
 * switch on the client settings page. Rendered for real; only the HTTP client is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    listPlatformScorecardConfirmations: vi.fn(),
    runScorecardConfirmations: vi.fn(),
  };
});

import * as api from './api';
import {
  ScorecardConfirmationsCard,
  ScorecardConfirmationsPage,
} from './platform-scorecard-confirmations';
import { lastCompletedWeekKey, shiftWeek } from './scorecardConfirmHelpers';
import { renderWithProviders } from './test-utils';
import type { PlatformScorecardWeek, TenantConfig } from './types';

const LATEST = lastCompletedWeekKey();
const PREV = shiftWeek(LATEST, -1);

const week = (weekKey = LATEST): PlatformScorecardWeek => ({
  weekKey,
  weekLabel: `Week ending ${weekKey}`,
  tenants: [
    {
      tenant: 'dolphins',
      tenantName: 'Dolphins Cricket',
      weekKey,
      enabled: true,
      fixtures: [
        {
          seriesId: 's1',
          fixtureId: 'f1',
          fixtureDate: '2026-10-03',
          competition: 'Premier T20',
          homeTeamName: 'UKZN CC',
          awayTeamName: 'Crusaders CC',
          sides: [
            {
              clubId: 'ukzn',
              clubName: 'UKZN CC',
              ref: 'SC-2026-0001',
              status: 'confirmed',
              submittedAt: '2026-10-05T08:00:00.000Z',
              staleConfirmation: true,
              deliveries: [],
            },
            {
              clubId: 'crusaders',
              clubName: 'Crusaders CC',
              ref: 'SC-2026-0002',
              status: 'correction',
              feedback: 'Pillay took 3 wickets, not 2.',
              submittedAt: '2026-10-05T09:00:00.000Z',
              deliveries: [],
            },
          ],
        },
      ],
      records: [
        {
          clubId: 'ukzn',
          clubName: 'UKZN CC',
          ref: 'SC-2026-0001',
          createdAt: '2026-10-05T05:00:00.000Z',
          linkExpiresAt: '2026-10-19T21:59:59.000Z',
          notifiedAt: '2026-10-05T05:00:02.000Z',
          deliveries: [
            {
              channel: 'email',
              status: 'sent',
              at: '2026-10-05T05:00:02.000Z',
              purpose: 'opened',
              recipientKind: 'chair',
            },
            {
              channel: 'whatsapp',
              status: 'skipped',
              reason: 'template-pending',
              at: '2026-10-05T05:00:02.000Z',
              purpose: 'opened',
              recipientKind: 'chair',
            },
          ],
          counts: { pending: 0, confirmed: 1, correction: 0, void: 0 },
        },
        {
          clubId: 'crusaders',
          clubName: 'Crusaders CC',
          ref: 'SC-2026-0002',
          createdAt: '2026-10-05T05:00:00.000Z',
          linkExpiresAt: '2026-10-19T21:59:59.000Z',
          deliveries: [
            {
              channel: 'email',
              status: 'skipped',
              reason: 'no-contact',
              at: '2026-10-05T05:00:02.000Z',
              purpose: 'opened',
              recipientKind: 'chair',
            },
          ],
          counts: { pending: 1, confirmed: 0, correction: 1, void: 0 },
        },
      ],
    },
    {
      tenant: 'titans',
      tenantName: 'Titans Cricket',
      weekKey,
      enabled: false,
      fixtures: [],
      records: [],
    },
  ],
});

const list = () => vi.mocked(api.listPlatformScorecardConfirmations);
const run = () => vi.mocked(api.runScorecardConfirmations);

beforeEach(() => {
  list().mockReset();
  run().mockReset();
});

describe('ScorecardConfirmationsPage', () => {
  it('pairs both clubs per fixture, home first, with status chips and the stale flag', async () => {
    list().mockResolvedValue(week());
    renderWithProviders(<ScorecardConfirmationsPage toast={vi.fn()} />);
    const row = await screen.findByTestId('scc-fixture-dolphins-s1-f1');
    expect(list()).toHaveBeenCalledWith(undefined);
    expect(within(row).getByText('UKZN CC vs Crusaders CC')).toBeInTheDocument();
    const [home, away] = within(row).getAllByTestId(/^scc-side-/);
    expect(home).toHaveTextContent('UKZN CC');
    expect(within(home).getByText('Confirmed')).toBeInTheDocument();
    expect(within(home).getByRole('img', { name: /older scorecard/ })).toBeInTheDocument();
    expect(away).toHaveTextContent('Crusaders CC');
    expect(within(away).getByText('Correction requested')).toBeInTheDocument();
    expect(within(away).queryByRole('img')).toBeNull();

    // Tenant badges: enabled vs off.
    expect(screen.getByText('Dolphins Cricket').parentElement).toHaveTextContent('Enabled');
    expect(screen.getByText('Titans Cricket').parentElement).toHaveTextContent('Off');
  });

  it('expands and collapses the correction text', async () => {
    const user = userEvent.setup();
    list().mockResolvedValue(week());
    renderWithProviders(<ScorecardConfirmationsPage toast={vi.fn()} />);
    const row = await screen.findByTestId('scc-fixture-dolphins-s1-f1');
    expect(within(row).queryByText(/Pillay took 3 wickets/)).toBeNull();
    const toggle = within(row).getByRole('button', { name: 'Show Crusaders CC feedback' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(within(row).getByLabelText('Crusaders CC feedback')).toHaveTextContent(
      'Pillay took 3 wickets, not 2.',
    );
    await user.click(within(row).getByRole('button', { name: 'Hide Crusaders CC feedback' }));
    expect(within(row).queryByText(/Pillay took 3 wickets/)).toBeNull();
  });

  it('lists each digest with its counts and notice chips', async () => {
    list().mockResolvedValue(week());
    renderWithProviders(<ScorecardConfirmationsPage toast={vi.fn()} />);
    const ukzn = await screen.findByRole('row', { name: /SC-2026-0001/ });
    expect(ukzn).toHaveTextContent('1 confirmed');
    expect(within(ukzn).getByText('Email sent')).toBeInTheDocument();
    expect(within(ukzn).getByText('WhatsApp: template pending')).toBeInTheDocument();
    const crusaders = screen.getByRole('row', { name: /SC-2026-0002/ });
    expect(crusaders).toHaveTextContent('1 correction requested · 1 awaiting answer');
    expect(within(crusaders).getByText('Not sent — no contact on file')).toBeInTheDocument();
  });

  it('steps back a week and cannot step past the latest completed week', async () => {
    const user = userEvent.setup();
    list().mockImplementation(async (w?: string) => week(w ?? LATEST));
    renderWithProviders(<ScorecardConfirmationsPage toast={vi.fn()} />);
    expect(await screen.findByText(`Week ending ${LATEST}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next week' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(await screen.findByText(`Week ending ${PREV}`)).toBeInTheDocument();
    expect(list()).toHaveBeenLastCalledWith(PREV);
    expect(screen.getByRole('button', { name: 'Next week' })).toBeEnabled();
  });

  it('runs now only after confirming, then shows the summary and reloads', async () => {
    const user = userEvent.setup();
    const toast = vi.fn();
    list().mockResolvedValue(week());
    run().mockResolvedValue({
      weekKey: LATEST,
      tenants: 1,
      clubsProcessed: 3,
      created: 2,
      toppedUp: 1,
      sent: 2,
      skipped: 1,
      errors: 0,
      dryRun: true,
    });
    renderWithProviders(<ScorecardConfirmationsPage toast={toast} />);
    await user.click(await screen.findByRole('button', { name: 'Run now' }));
    const dialog = screen.getByRole('dialog', {
      name: `Run the digest for Week ending ${LATEST}?`,
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(run()).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Run now' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Run now' }));
    expect(run()).toHaveBeenCalledWith(LATEST);
    expect(
      await screen.findByText(
        /1 client, 3 clubs with matches: 2 created, 1 topped up, 2 sent, 1 skipped, 0 errors \(dry run/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toast).toHaveBeenCalledWith('Scorecard confirmations run complete');
    expect(list()).toHaveBeenCalledTimes(2);
  });

  it('keeps the dialog open with the error when the run fails', async () => {
    const user = userEvent.setup();
    list().mockResolvedValue(week());
    run().mockRejectedValue(new api.ApiError(400, 'week must not be in the future'));
    renderWithProviders(<ScorecardConfirmationsPage toast={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Run now' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Run now' }));
    expect(
      await within(screen.getByRole('dialog')).findByText('week must not be in the future'),
    ).toBeInTheDocument();
  });
});

describe('ScorecardConfirmationsCard', () => {
  it('saves the switch as the whole key, Save disabled until it changes', async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockResolvedValue({});
    const toast = vi.fn();
    const config = { tenant: 'acme' } as unknown as TenantConfig;
    render(<ScorecardConfirmationsCard config={config} save={save} toast={toast} />);
    const box = screen.getByLabelText('Send the Monday scorecard digest');
    expect(box).not.toBeChecked();
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn).toBeDisabled();
    await user.click(box);
    await user.click(btn);
    expect(save).toHaveBeenCalledWith({ scorecardConfirmations: { enabled: true } });
    expect(toast).toHaveBeenCalledWith('Scorecard confirmations switched on');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows the server error when the save is rejected', async () => {
    const user = userEvent.setup();
    const save = vi
      .fn()
      .mockRejectedValue(new api.ApiError(400, 'scorecardConfirmations.enabled must be a boolean'));
    const config = {
      tenant: 'acme',
      scorecardConfirmations: { enabled: true },
    } as unknown as TenantConfig;
    render(<ScorecardConfirmationsCard config={config} save={save} toast={vi.fn()} />);
    await user.click(screen.getByLabelText('Send the Monday scorecard digest'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/must be a boolean/)).toBeInTheDocument();
  });
});

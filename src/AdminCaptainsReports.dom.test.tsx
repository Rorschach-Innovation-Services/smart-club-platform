/**
 * Union office "Captain's reports" page: status chips (no late status — there is no due date), the
 * low-ratings filter, and the read-only report view.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-utils';
import { AdminCaptainsReportsView } from './AdminCaptainsReports';
import { qk } from './query';
import type { CaptainsReport } from './types';

const ratings = (n: number) => ({
  decisions: n,
  pressure: n,
  behaviour: n,
  communication: n,
  regulations: n,
});

const report = (over: Partial<CaptainsReport>): CaptainsReport => ({
  id: `s1~f1~${over.clubId ?? 'umzinto'}`,
  seriesId: 's1',
  fixtureId: 'f1',
  clubId: 'umzinto',
  status: 'pending',
  source: 'auto',
  matchDate: '2026-10-04',
  side: 'home',
  clubName: 'Umzinto CC',
  opponentName: 'African Warriors',
  competition: 'Premier T20',
  umpiresSnapshot: [{ umpireId: 'u-ngubane', name: 'A.Ngubane' }],
  recipient: { kind: 'captain', name: 'S. Mthembu' },
  captainName: '',
  umpires: [],
  general: '',
  createdAt: '2026-10-04T15:00:00.000Z',
  updatedAt: '2026-10-04T15:00:00.000Z',
  ...over,
});

const REPORTS = [
  report({
    clubId: 'umzinto',
    status: 'submitted',
    ref: 'CR-2026-0001',
    captainName: 'S. Mthembu',
    submittedAt: '2026-10-05T10:00:00.000Z',
    umpires: [
      {
        umpireId: 'u-ngubane',
        name: 'A.Ngubane',
        ratings: { ...ratings(4), decisions: 2 },
        concerns: { lbw: true },
        otherConcern: '',
        comments: 'Missed two LBWs',
      },
    ],
  }),
  report({
    clubId: 'african-warriors',
    side: 'away',
    clubName: 'African Warriors',
    opponentName: 'Umzinto CC',
    recipient: { kind: 'chair', name: 'Awa Chair' },
  }),
  report({
    clubId: 'c',
    clubName: 'C CC',
    status: 'void',
    recipient: { kind: 'chair', name: 'C' },
  }),
];

describe('AdminCaptainsReportsView', () => {
  it('filters by status chip and low ratings; there is no Late chip or due column', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminCaptainsReportsView reports={REPORTS} />);
    const rows = () => screen.getAllByRole('row').slice(1);
    expect(rows()).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /^Late/ })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Due' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Void/ }));
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]).getByText(/to the chair/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^All/ }));
    await user.click(screen.getByRole('button', { name: /low ratings/i }));
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]).getByText('CR-2026-0001')).toBeTruthy();
  });

  it('opens a submitted report read-only', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminCaptainsReportsView reports={REPORTS} />);
    await user.click(screen.getByRole('button', { name: 'View' }));
    expect(screen.getByText(/Umpire 1: A\.Ngubane/)).toBeTruthy();
    expect(screen.getByText('Missed two LBWs')).toBeTruthy();
    expect(screen.getByText(/Areas of concern: LBW decisions/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit report' })).toBeNull();
  });
});

const delivery = (over: Partial<NonNullable<CaptainsReport['deliveries']>[number]>) => ({
  channel: 'email' as const,
  status: 'sent' as const,
  at: '2026-10-04T15:00:00.000Z',
  purpose: 'opened' as const,
  recipientKind: 'chair' as const,
  ...over,
});

describe('AdminCaptainsReportsView · notices', () => {
  const NOTICES = [
    report({
      clubId: 'umzinto',
      recipient: { kind: 'chair', name: 'Uma Chair' },
      notifiedAt: '2026-10-04T15:00:00.000Z',
      deliveries: [
        delivery({ channel: 'email' }),
        delivery({ channel: 'whatsapp', providerStatus: 'read' }),
      ],
    }),
    report({
      clubId: 'african-warriors',
      clubName: 'African Warriors',
      recipient: { kind: 'chair', name: 'Awa Chair' },
      deliveries: [
        delivery({ channel: 'email', status: 'skipped', reason: 'no-contact' }),
        delivery({ channel: 'whatsapp', status: 'skipped', reason: 'no-contact' }),
      ],
    }),
    report({
      clubId: 'c',
      clubName: 'C CC',
      recipient: { kind: 'captain', name: 'Cap' },
      notifiedAt: '2026-10-04T15:00:00.000Z',
      deliveries: [
        delivery({ channel: 'email', recipientKind: 'captain' }),
        delivery({
          channel: 'whatsapp',
          recipientKind: 'captain',
          providerStatus: 'failed',
          providerError: 'Message undeliverable',
        }),
      ],
    }),
  ];

  it('shows per-channel chips instead of who it was sent to', () => {
    renderWithProviders(<AdminCaptainsReportsView reports={NOTICES} />);
    const rows = screen.getAllByRole('row').slice(1);
    const uma = rows.find((r) => within(r).queryByText('Umzinto CC'))!;
    expect(within(uma).getByText('Email sent')).toBeTruthy();
    expect(within(uma).getByText('WhatsApp read')).toBeTruthy();
    const aw = rows.find((r) => within(r).queryByText('African Warriors'))!;
    expect(within(aw).getByText('Not sent — no contact on file')).toBeTruthy();
    expect(within(aw).queryByText('Email sent')).toBeNull();
    const c = rows.find((r) => within(r).queryByText('C CC'))!;
    expect(within(c).getByText('WhatsApp failed (Message undeliverable)')).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Sent to' })).toBeNull();
  });

  it('filters to notices that were not delivered', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminCaptainsReportsView reports={NOTICES} />);
    await user.click(screen.getByRole('button', { name: /notice not delivered/i }));
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText('African Warriors')).toBeTruthy();
  });

  it('lists clubs with no chair contact, each with a link to edit the club', async () => {
    const user = userEvent.setup();
    const onOpenClub = vi.fn();
    renderWithProviders(<AdminCaptainsReportsView reports={NOTICES} onOpenClub={onOpenClub} />, {
      seed: [
        [
          qk.captainsReportContactGaps(),
          { enabled: true, clubs: [{ id: 'african-warriors', name: 'African Warriors' }] },
        ],
      ],
    });
    const banner = await screen.findByRole('note', { name: /no chair contact/i });
    await user.click(within(banner).getByRole('button', { name: /edit African Warriors/i }));
    expect(onOpenClub).toHaveBeenCalledWith('african-warriors');
  });

  it('badges a report for a match that is not in the fixture list', () => {
    renderWithProviders(
      <AdminCaptainsReportsView
        reports={[report({ source: 'manual-unlisted', status: 'submitted', ref: 'CR-2026-0009' })]}
      />,
    );
    expect(screen.getByText('Not in the fixture list')).toBeTruthy();
  });
});

describe('AdminCaptainsReportsView · free-text umpires', () => {
  const FREE = report({
    status: 'submitted',
    ref: 'CR-2026-0002',
    umpires: [
      {
        name: 'Sbu Dlamini',
        substitute: true,
        ratings: ratings(4),
        concerns: {},
        otherConcern: '',
        comments: '',
      },
    ],
  });
  const REGISTRY = [
    { id: 'u-dlamini', displayName: 'S.Dlamini', active: true },
    { id: 'u-ngubane', displayName: 'A.Ngubane', active: true },
  ];

  it('links a free-text umpire to an existing registry umpire', async () => {
    const user = userEvent.setup();
    const onAttribute = vi.fn(async () => FREE);
    renderWithProviders(
      <AdminCaptainsReportsView reports={[FREE]} umpires={REGISTRY} onAttribute={onAttribute} />,
    );
    await user.click(screen.getByRole('button', { name: 'View' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: /existing umpire/i }),
      'u-dlamini',
    );
    await user.click(screen.getByRole('button', { name: /^link$/i }));
    expect(onAttribute).toHaveBeenCalledWith(FREE.id, 0, 'u-dlamini', 'linked');
  });

  it('adds a free-text umpire to the registry, then attributes the ratings to it', async () => {
    const user = userEvent.setup();
    const onAttribute = vi.fn(async () => FREE);
    const onCreateUmpire = vi.fn(async () => ({ id: 'u-sbu', displayName: 'Sbu Dlamini' }));
    renderWithProviders(
      <AdminCaptainsReportsView
        reports={[FREE]}
        umpires={REGISTRY}
        onAttribute={onAttribute}
        onCreateUmpire={onCreateUmpire}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'View' }));
    await user.click(screen.getByRole('button', { name: /add to umpire registry/i }));
    expect(onCreateUmpire).toHaveBeenCalledWith('Sbu Dlamini');
    expect(onAttribute).toHaveBeenCalledWith(FREE.id, 0, 'u-sbu', 'registered');
  });
});

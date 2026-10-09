/**
 * Match Centre connection (ADR 0020 phase 1, read-only): the TenantEditPage card, the
 * per-client console page and the client-list badge. The /platform medicoach endpoints are
 * mocked at the api layer; everything else renders for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './query';
import { MedicoachConnectionCard } from './platform-medicoach';
import { MedicoachConsolePage } from './platform-medicoach-console';
import { PlatformPortal } from './platform';
import * as api from './api';
import { ApiError } from './api';
import type { MedicoachConnection, TenantConfig, TenantSummary } from './types';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    platformGetTenant: vi.fn(),
    platformListTenants: vi.fn(),
    platformMedicoachConnection: vi.fn(),
    platformMedicoachOverview: vi.fn(),
    platformMedicoachReconcile: vi.fn(),
  };
});

const AWAITING: MedicoachConnection = {
  stage: 'live',
  inferred: true,
  syncEnabled: true,
  playerSync: false,
  goLiveDate: '2026-09-01',
  dryRun: false,
  mcReachable: true,
  lastReconcileAt: '2026-10-08T06:00:00Z',
  health: { status: 'ok', lastSuccessAt: '2026-10-08T06:00:00Z', lastError: null },
  awaitingTotal: 620,
  awaiting: [
    {
      seriesId: 'S1',
      seriesName: 'EMCU Division 1',
      leagueKey: 'emcuD1',
      count: 400,
      firstSeen: '2026-10-06T08:00:00Z',
      lastSeen: '2026-10-08T06:00:00Z',
    },
    {
      seriesId: 'S2',
      seriesName: 'EMCU Division 2',
      leagueKey: 'emcuD2',
      count: 220,
      firstSeen: '2026-10-06T08:00:00Z',
      lastSeen: '2026-10-08T06:00:00Z',
    },
  ],
};
const CLEAR: MedicoachConnection = { ...AWAITING, awaitingTotal: 0, awaiting: [] };

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  vi.mocked(api.platformGetTenant).mockResolvedValue({
    tenant: 'acme',
    branding: { name: 'Acme Union' },
  } as unknown as TenantConfig);
});

/**
 * The Card titled `title`, to scope queries to it: in the real app the toast also carries
 * role="status", so an unscoped getByRole('status') would be ambiguous.
 */
async function cardTitled(title: string): Promise<HTMLElement> {
  const head = await screen.findByText(title, { selector: '.card-title' });
  return head.closest('.card') as HTMLElement;
}

function renderCard() {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/platform/tenants/acme']}>
        <Routes>
          <Route path="/platform/tenants/:slug" element={<MedicoachConnectionCard slug="acme" />} />
          <Route path="/platform/tenants/:slug/medicoach" element={<p>console page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderConsole() {
  const toast = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/platform/tenants/acme/medicoach']}>
        <Routes>
          <Route
            path="/platform/tenants/:slug/medicoach"
            element={<MedicoachConsolePage toast={toast} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { toast, user: userEvent.setup() };
}

describe('MedicoachConnectionCard', () => {
  it('shows the inferred stage and the awaiting-carry count', async () => {
    vi.mocked(api.platformMedicoachConnection).mockResolvedValue(AWAITING);
    renderCard();
    const card = await cardTitled('Match Centre');
    expect(await within(card).findByText('Live (inferred)')).toBeInTheDocument();
    expect(within(card).getByRole('status')).toHaveTextContent(
      '620 fixtures awaiting carry to Match Centre',
    );
    expect(within(card).getByText(/sync is healthy/i)).toBeInTheDocument();
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('warns when sync runs are silent dry-runs', async () => {
    vi.mocked(api.platformMedicoachConnection).mockResolvedValue({
      ...CLEAR,
      stage: 'not_connected',
      dryRun: true,
      health: { status: 'dry-run', lastSuccessAt: null, lastError: null },
    });
    renderCard();
    const card = await cardTitled('Match Centre');
    expect(await within(card).findByRole('alert')).toHaveTextContent(
      'Sync secrets not configured — all sync runs are silent dry-runs',
    );
    expect(within(card).getByText('Not connected (inferred)')).toBeInTheDocument();
  });

  it('opens the console', async () => {
    vi.mocked(api.platformMedicoachConnection).mockResolvedValue(CLEAR);
    renderCard();
    const card = await cardTitled('Match Centre');
    expect(await within(card).findByRole('status')).toHaveTextContent(/no fixtures awaiting carry/i);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open console' }));
    expect(await screen.findByText('console page')).toBeInTheDocument();
  });
});

describe('MedicoachConsolePage', () => {
  it('lists the series awaiting carry with the carry explanation', async () => {
    vi.mocked(api.platformMedicoachConnection).mockResolvedValue(AWAITING);
    renderConsole();
    await screen.findByRole('heading', { name: /match centre connection/i });
    const card = await cardTitled('Awaiting carry');
    expect(within(card).getByRole('status')).toHaveTextContent(
      '620 fixtures awaiting carry to Match Centre',
    );
    expect(
      within(card).getByText(/they need a one-off carry \(bundle top-up\)/),
    ).toBeInTheDocument();
    expect(within(card).queryByText(/sync is switched off/i)).not.toBeInTheDocument();
    const rows = within(card).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('EMCU Division 1')).toBeInTheDocument();
    expect(within(rows[0]).getByText('emcuD1')).toBeInTheDocument();
    expect(within(rows[0]).getByText('400')).toBeInTheDocument();
  });

  it('still lists awaiting rows for a sync-off client, with the sync-off context', async () => {
    vi.mocked(api.platformMedicoachConnection).mockResolvedValue({
      ...AWAITING,
      stage: 'not_connected',
      syncEnabled: false,
    });
    renderConsole();
    const card = await cardTitled('Awaiting carry');
    expect(within(card).getByRole('status')).toHaveTextContent(
      '620 fixtures awaiting carry to Match Centre',
    );
    expect(
      within(card).getByText(/sync is switched off for this client, so these are not flagged/i),
    ).toBeInTheDocument();
    expect(within(card).getAllByRole('row').slice(1)).toHaveLength(2);
    // The Connection card's health line carries the same context.
    const health = screen.getByText('The Match Centre sync is switched off for this client.');
    expect(health.closest('.card')).not.toBe(card);
  });

  it('shows the all-clear when nothing is awaiting', async () => {
    vi.mocked(api.platformMedicoachConnection).mockResolvedValue(CLEAR);
    renderConsole();
    const card = await cardTitled('Awaiting carry');
    expect(within(card).getByRole('status')).toHaveTextContent(/no fixtures awaiting carry/i);
    expect(within(card).queryByRole('table')).not.toBeInTheDocument();
  });

  it('"Check now" reconciles and shows the refreshed result', async () => {
    vi.mocked(api.platformMedicoachConnection).mockResolvedValue(CLEAR);
    vi.mocked(api.platformMedicoachReconcile).mockResolvedValue(AWAITING);
    const { user, toast } = renderConsole();
    const card = await cardTitled('Awaiting carry');
    expect(within(card).getByRole('status')).toHaveTextContent(/no fixtures awaiting carry/i);
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(api.platformMedicoachReconcile).toHaveBeenCalledWith('acme');
    expect(await within(card).findByText('EMCU Division 2')).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith('620 fixtures awaiting carry', 'warn');
  });

  it('"Check now" says so when the Match Centre was unreachable, not "all clear"', async () => {
    vi.mocked(api.platformMedicoachConnection).mockResolvedValue(CLEAR);
    vi.mocked(api.platformMedicoachReconcile).mockResolvedValue({ ...CLEAR, mcReachable: false });
    const { user, toast } = renderConsole();
    await cardTitled('Awaiting carry');
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Couldn't reach the Match Centre — showing the last known state.",
        'error',
      ),
    );
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalledWith('Checked — nothing awaiting carry', undefined);
  });

  it('"Check now" says no check was made on a dry-run', async () => {
    vi.mocked(api.platformMedicoachConnection).mockResolvedValue(CLEAR);
    vi.mocked(api.platformMedicoachReconcile).mockResolvedValue({
      ...CLEAR,
      dryRun: true,
      mcReachable: null,
    });
    const { user, toast } = renderConsole();
    await cardTitled('Awaiting carry');
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'Sync secrets are not configured — no check was made.',
        'warn',
      ),
    );
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('"Check now" toasts the server error', async () => {
    vi.mocked(api.platformMedicoachConnection).mockResolvedValue(CLEAR);
    vi.mocked(api.platformMedicoachReconcile).mockRejectedValue(
      new ApiError(502, 'the Match Centre did not answer'),
    );
    const { user, toast } = renderConsole();
    const card = await cardTitled('Awaiting carry');
    expect(within(card).getByRole('status')).toHaveTextContent(/no fixtures awaiting carry/i);
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith('the Match Centre did not answer', 'error'),
    );
    expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled();
  });
});

describe('Client list Match Centre flags', () => {
  const summary = (tenant: string, name: string): TenantSummary => ({
    tenant,
    name,
    title: '',
    logoUrl: '',
    submissionDeadline: '',
    adminCount: 1,
    features: {},
  });

  function renderPortal() {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/platform']}>
          <PlatformPortal
            userEmail="op@acme.test"
            signOutUser={vi.fn()}
            hasTenantConsole={false}
            hostSlug="acme"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
  }

  // dryRun is stage-wide (the sync secrets are per deployment), so every row shares one value.
  it('flags awaiting carry per client; nothing on a healthy or sync-off one', async () => {
    vi.mocked(api.platformListTenants).mockResolvedValue([
      summary('dolphins', 'Dolphins Pipeline'),
      summary('acme', 'Acme Union'),
      summary('lions', 'Lions Cricket'),
    ]);
    vi.mocked(api.platformMedicoachOverview).mockResolvedValue({
      tenants: [
        {
          tenant: 'dolphins',
          name: 'Dolphins Pipeline',
          syncEnabled: true,
          dryRun: false,
          healthStatus: 'ok',
          awaitingTotal: 620,
          lastReconcileAt: null,
        },
        {
          tenant: 'acme',
          name: 'Acme Union',
          syncEnabled: true,
          dryRun: false,
          healthStatus: 'ok',
          awaitingTotal: 0,
          lastReconcileAt: null,
        },
        {
          // Sync switched off with stale awaiting rows: the API still reports the count.
          tenant: 'lions',
          name: 'Lions Cricket',
          syncEnabled: false,
          dryRun: false,
          healthStatus: 'never',
          awaitingTotal: 49,
          lastReconcileAt: null,
        },
      ],
    });
    const row = renderPortal();
    expect(await screen.findByText('620 awaiting carry')).toBeInTheDocument();
    expect(row('Dolphins Pipeline')).toHaveTextContent('620 awaiting carry');
    expect(row('Dolphins Pipeline')).not.toHaveTextContent('Dry-run');
    expect(row('Acme Union')).not.toHaveTextContent(/awaiting carry|Dry-run/);
    expect(row('Lions Cricket')).not.toHaveTextContent(/awaiting carry/);
    expect(screen.queryByText('49 awaiting carry')).not.toBeInTheDocument();
  });

  it('flags dry-run only on sync-on clients; a sync-off one shows neither pill', async () => {
    vi.mocked(api.platformListTenants).mockResolvedValue([
      summary('titans', 'Titans Cricket'),
      summary('lions', 'Lions Cricket'),
    ]);
    vi.mocked(api.platformMedicoachOverview).mockResolvedValue({
      tenants: [
        {
          tenant: 'titans',
          name: 'Titans Cricket',
          syncEnabled: true,
          dryRun: true,
          healthStatus: 'dry-run',
          awaitingTotal: 0,
          lastReconcileAt: null,
        },
        {
          tenant: 'lions',
          name: 'Lions Cricket',
          syncEnabled: false,
          dryRun: true,
          healthStatus: 'dry-run',
          awaitingTotal: 49,
          lastReconcileAt: null,
        },
      ],
    });
    const row = renderPortal();
    expect(await screen.findByText('Dry-run')).toBeInTheDocument();
    expect(row('Titans Cricket')).toHaveTextContent('Dry-run');
    expect(row('Lions Cricket')).not.toHaveTextContent(/awaiting carry|Dry-run/);
    expect(screen.getAllByText('Dry-run')).toHaveLength(1);
  });
});

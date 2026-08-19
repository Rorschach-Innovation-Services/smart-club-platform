/**
 * OnboardingPage — step states, "Up next" highlight, and the role-gate on the
 * roster/reps steps, api layer mocked. Also pins the settings-page card swap
 * ("Client onboarding" replaces "Bulk document intake").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './query';
import { OnboardingPage } from './platform-onboarding';
import { PlatformPortal } from './platform';
import * as api from './api';
import type {
  DnsSheet,
  RequiredDoc,
  TenantConfig,
  TenantOverview,
  TenantRepsResponse,
} from './types';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    platformGetTenant: vi.fn(),
    platformTenantOverview: vi.fn(),
    platformTenantReps: vi.fn(),
    platformDnsSheet: vi.fn(),
  };
});

const BASE_CONFIG = {
  tenant: 'acme',
  branding: { name: 'Acme Union' },
  districts: ['Central'],
  leagues: [{ key: 'a-league', label: 'A League' }],
  requiredDocs: [] as RequiredDoc[],
} as unknown as TenantConfig;

const BASE_OVERVIEW = {
  tenant: 'acme',
  name: 'Acme Union',
  leagues: [{ key: 'a-league', label: 'A League' }],
  districts: ['Central'],
  clearances: [],
  clubs: [
    {
      id: 'phsob',
      name: 'PHSOB Cricket Club',
      district: 'Central',
      affiliation: 'not_started',
      cqi: 0,
      docs: {},
      players: 0,
      intake: { memberDatabase: 'absent', committee: 'absent' },
    },
    {
      id: 'riverside',
      name: 'Riverside CC',
      district: 'Central',
      affiliation: 'not_started',
      cqi: 0,
      docs: {},
      players: 12,
      leagueTeams: { 'a-league': 1 },
      intake: { memberDatabase: 'parseable', committee: 'unparseable' },
    },
  ],
} as unknown as TenantOverview;

const EMPTY_REPS: TenantRepsResponse = { reps: [], coverage: [] };

function renderPage() {
  const toast = vi.fn();
  queryClient.clear();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/platform/tenants/acme/onboarding']}>
        <Routes>
          <Route
            path="/platform/tenants/:slug/onboarding"
            element={<OnboardingPage toast={toast} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { toast };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OnboardingPage', () => {
  it('derives done/partial/todo states and highlights the first non-done step as Up next', async () => {
    vi.mocked(api.platformGetTenant).mockResolvedValue(BASE_CONFIG);
    vi.mocked(api.platformTenantOverview).mockResolvedValue(BASE_OVERVIEW);
    vi.mocked(api.platformTenantReps).mockResolvedValue(EMPTY_REPS);

    renderPage();

    await screen.findByRole('heading', { name: /client onboarding/i });

    // Catalogue: no docs at all -> todo, and it's the first step so it's Up next.
    const catalogueCard = screen.getByText('Document catalogue').closest('.card')!;
    expect(catalogueCard).toHaveTextContent('Up next');
    expect(catalogueCard).toHaveTextContent('Not started');

    // Documents in: 1 of 2 clubs has a member database -> partial, real fraction shown.
    const docsCard = screen.getByText('Documents in').closest('.card')!;
    expect(docsCard).toHaveTextContent('In progress');
    expect(docsCard).toHaveTextContent('1 of 2 clubs have a member database');

    // Rosters: honest denominator is DATABASE-HOLDING clubs (1), not all clubs (2) —
    // that one club has players, so this reads as done even though clubs overall don't.
    const rostersCard = screen.getByText('Rosters in').closest('.card')!;
    expect(rostersCard).toHaveTextContent('1 of 1 database-holding clubs have players');
    expect(rostersCard).toHaveTextContent('Done');
  });

  it('blocks the roster step but not reps when doc roles are unassigned (reps just needs clubs)', async () => {
    vi.mocked(api.platformGetTenant).mockResolvedValue(BASE_CONFIG);
    vi.mocked(api.platformTenantOverview).mockResolvedValue(BASE_OVERVIEW);
    vi.mocked(api.platformTenantReps).mockResolvedValue(EMPTY_REPS);

    renderPage();
    await screen.findByRole('heading', { name: /client onboarding/i });

    const catalogueCard = screen.getByText('Document catalogue').closest('.card')!;
    expect(catalogueCard).toHaveTextContent(
      'Nothing in the catalogue yet — add at least one document before assigning roles.',
    );

    // Rosters genuinely can't work without the member-database role — hard-locked.
    const rostersCard = screen.getByText('Rosters in').closest('.card')!;
    expect(rostersCard).toHaveTextContent(
      /Assign the member-database role in the catalogue step above first/,
    );
    expect(rostersCard.querySelector('button')).toBeDisabled();

    // Reps unlocks once clubs exist — the manual invite path works without the
    // committee role, so the button stays enabled with only a hint, not a lock.
    const repsCard = screen.getByText('Reps invited').closest('.card')!;
    expect(repsCard).toHaveTextContent(
      /Assign the committee role in the catalogue step to enable extraction/,
    );
    expect(repsCard.querySelector('button')).not.toBeDisabled();
  });

  it('unlocks rosters once the member-database role alone is assigned, and reps keeps its hint', async () => {
    const docs: RequiredDoc[] = [
      { key: 'member-db', name: 'Member database', role: 'memberDatabase' },
    ];
    vi.mocked(api.platformGetTenant).mockResolvedValue({
      ...BASE_CONFIG,
      requiredDocs: docs,
    });
    vi.mocked(api.platformTenantOverview).mockResolvedValue(BASE_OVERVIEW);
    vi.mocked(api.platformTenantReps).mockResolvedValue(EMPTY_REPS);

    renderPage();
    await screen.findByRole('heading', { name: /client onboarding/i });

    const catalogueCard = screen.getByText('Document catalogue').closest('.card')!;
    expect(catalogueCard).toHaveTextContent(
      'No document in the catalogue is marked as the committee document — assign the role in Required documents.',
    );

    // Roster gate reads the member-database role alone, not "both roles assigned".
    const rostersCard = screen.getByText('Rosters in').closest('.card')!;
    expect(rostersCard.querySelector('button')).not.toBeDisabled();

    const repsCard = screen.getByText('Reps invited').closest('.card')!;
    expect(repsCard).toHaveTextContent(
      /Assign the committee role in the catalogue step to enable extraction/,
    );
    expect(repsCard.querySelector('button')).not.toBeDisabled();
  });

  it('shows the shared-defaults copy on the catalogue step when requiredDocs is unset', async () => {
    const { requiredDocs: _drop, ...rest } = BASE_CONFIG;
    vi.mocked(api.platformGetTenant).mockResolvedValue(rest as unknown as TenantConfig);
    vi.mocked(api.platformTenantOverview).mockResolvedValue(BASE_OVERVIEW);
    vi.mocked(api.platformTenantReps).mockResolvedValue(EMPTY_REPS);

    renderPage();
    await screen.findByRole('heading', { name: /client onboarding/i });

    const catalogueCard = screen.getByText('Document catalogue').closest('.card')!;
    expect(catalogueCard).toHaveTextContent(
      'Shared defaults are in effect — save the catalogue (customising if needed) and assign ' +
        'the member-database and committee roles.',
    );
    expect(catalogueCard).not.toHaveTextContent(/Nothing in the catalogue yet/);
  });

  it('reads done end-to-end when every step is satisfied', async () => {
    vi.mocked(api.platformGetTenant).mockResolvedValue({
      ...BASE_CONFIG,
      requiredDocs: [
        { key: 'member-db', name: 'Member database', role: 'memberDatabase' },
        { key: 'committee-doc', name: 'Committee document', role: 'committee' },
      ],
      setupCompletedAt: '2026-08-01T00:00:00.000Z',
    });
    vi.mocked(api.platformTenantOverview).mockResolvedValue({
      ...BASE_OVERVIEW,
      clubs: [BASE_OVERVIEW.clubs[1]],
    });
    vi.mocked(api.platformTenantReps).mockResolvedValue({
      reps: [
        { sub: 'u1', email: 'chair@riverside.co.za', clubIds: ['riverside'], status: 'active' },
      ],
      coverage: [{ clubId: 'riverside', repCount: 1 }],
    });

    renderPage();
    await screen.findByRole('heading', { name: /client onboarding/i });

    for (const title of [
      'Document catalogue',
      'Districts & leagues',
      'Clubs exist',
      'Documents in',
      'Structure & teams in',
      'Rosters in',
      'Reps invited',
      'Setup complete',
    ]) {
      const card = screen.getByText(title).closest('.card')!;
      expect(card).toHaveTextContent('Done');
      expect(card).not.toHaveTextContent('Up next');
    }
  });
});

const EMPTY_DNS: DnsSheet = { tenant: 'acme', liveUrl: null, note: '', steps: [] };

describe('TenantEditPage card swap', () => {
  it('replaces "Bulk document intake" with a single "Client onboarding" card', async () => {
    vi.mocked(api.platformGetTenant).mockResolvedValue(BASE_CONFIG);
    vi.mocked(api.platformTenantOverview).mockResolvedValue(BASE_OVERVIEW);
    vi.mocked(api.platformTenantReps).mockResolvedValue(EMPTY_REPS);
    vi.mocked(api.platformDnsSheet).mockResolvedValue(EMPTY_DNS);
    queryClient.clear();

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/platform/tenants/acme']}>
          <PlatformPortal userEmail="op@acme.test" signOutUser={vi.fn()} hasTenantConsole={false} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText(/\d of \d+ steps done/);
    expect(screen.queryByText('Bulk document intake')).not.toBeInTheDocument();

    // Quick links + progress pill live on the card.
    const card = screen.getByText('Client onboarding').closest('.card') as HTMLElement;
    expect(card).toHaveTextContent(/\d of \d+ steps done/);
    expect(within(card).getByRole('button', { name: 'Documents' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Structure' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Rosters' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Reps' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Open checklist' })).toBeInTheDocument();
  });
});

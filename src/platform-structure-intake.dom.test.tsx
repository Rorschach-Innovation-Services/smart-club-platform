/**
 * StructureIntakeWizard — end-to-end behaviour through the browser-visible flow, with
 * the api layer mocked. Pins the plan's non-negotiables: the zero-sections dead end,
 * suggestions staying "Check" until confirmed, existing-plan rows excluded by default
 * with Include-anyway setting overwrite, and the guidance primitives (StepIntro/
 * InfoTip) actually rendering — the whole point of the self-serve suite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './query';
import { StructureIntakeWizard } from './platform-structure-intake';
import * as api from './api';
import type { League, StructureSection, TenantConfig, TenantOverview } from './types';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    platformGetTenant: vi.fn(),
    platformTenantOverview: vi.fn(),
    platformStructureIntakeParse: vi.fn(),
    platformStructureIntakeCommit: vi.fn(),
    platformCreateClub: vi.fn(),
  };
});

const LEAGUES: League[] = [
  {
    key: 'premier-league',
    label: 'Premier League',
    group: 'Overarching Leagues',
    district: 'All districts',
  },
];

const config = {
  tenant: 'acme',
  branding: { name: 'Acme Union' },
  districts: ['Central'],
  leagues: LEAGUES,
} as unknown as TenantConfig;

const baseOverview = {
  tenant: 'acme',
  name: 'Acme Union',
  leagues: LEAGUES,
  districts: ['Central'],
  clearances: [],
  clubs: [
    {
      id: 'tuks',
      name: 'TUKS Cricket Club',
      district: 'Central',
      affiliation: 'not_started',
      cqi: 0,
      docs: {},
      players: 0,
    },
  ],
} as unknown as TenantOverview;

function workbookFile(): File {
  return new File(['x'], 'structure.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

function renderWizard() {
  const toast = vi.fn();
  queryClient.clear();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/platform/tenants/acme/structure-intake']}>
        <Routes>
          <Route
            path="/platform/tenants/:slug/structure-intake"
            element={<StructureIntakeWizard toast={toast} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { toast };
}

async function uploadWorkbook() {
  await screen.findByRole('heading', { name: /league structure/i });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = workbookFile();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.platformGetTenant).mockResolvedValue(config);
  vi.mocked(api.platformTenantOverview).mockResolvedValue(baseOverview);
});

describe('StructureIntakeWizard', () => {
  it('renders the designed zero-sections dead end instead of an empty table', async () => {
    vi.mocked(api.platformStructureIntakeParse).mockResolvedValue({
      sections: [],
      sheetsScanned: 2,
      sheetsWithSections: 0,
    });
    renderWizard();
    await uploadWorkbook();

    await screen.findByText(/isn't supported yet/i);
    expect(screen.getByText(/send the pack to support/i)).toBeInTheDocument();
    // Every step opens with a StepIntro overview block.
    expect(
      screen.getByText(/nothing is written yet — this only reads the file/i),
    ).toBeInTheDocument();
  });

  it('prefills a suggested league with a "Check" pill until the operator confirms it', async () => {
    const sections: StructureSection[] = [
      { sheet: 'SENIORS', header: 'Premier League', rows: [{ raw: 'TUKS 1', venue: 'Buks Oval' }] },
    ];
    vi.mocked(api.platformStructureIntakeParse).mockResolvedValue({
      sections,
      sheetsScanned: 1,
      sheetsWithSections: 1,
    });
    const user = userEvent.setup();
    renderWizard();
    await uploadWorkbook();

    await screen.findByText('2. Sections');
    const row = screen.getByText('Premier League', { selector: 'div' }).closest('tr')!;
    // Prefilled, but flagged for a human look.
    expect(within(row).getByDisplayValue('Premier League')).toBeInTheDocument();
    expect(within(row).getByText('Check')).toBeInTheDocument();

    // Confirming (even re-picking the same league) clears the flag.
    await user.selectOptions(within(row).getByRole('combobox'), 'premier-league');
    await waitFor(() => expect(within(row).queryByText('Check')).not.toBeInTheDocument());

    // Sections-step guidance InfoTip is present.
    expect(within(row).getByLabelText(/what does ignore do/i)).toBeInTheDocument();
  });

  it('shows a bulk "Ignore all unassigned sections" button once 2+ sections are unassigned, and it clears them all', async () => {
    const sections: StructureSection[] = [
      { sheet: 'SENIORS', header: 'Under 9 Friendlies', rows: [{ raw: 'TUKS U9' }] },
      { sheet: 'SENIORS', header: 'Under 11 Friendlies', rows: [{ raw: 'TUKS U11' }] },
      { sheet: 'SENIORS', header: 'Premier League', rows: [{ raw: 'TUKS 1', venue: 'Buks Oval' }] },
    ];
    vi.mocked(api.platformStructureIntakeParse).mockResolvedValue({
      sections,
      sheetsScanned: 1,
      sheetsWithSections: 1,
    });
    const user = userEvent.setup();
    renderWizard();
    await uploadWorkbook();
    await screen.findByText('2. Sections');

    // Premier League auto-suggests and is assigned; the two "Friendlies" sections don't
    // match any league, so 2 sections are unassigned — the bulk button appears.
    const bulkBtn = screen.getByRole('button', { name: /ignore all unassigned sections \(2\)/i });

    await user.click(bulkBtn);

    // Both unassigned rows now show "Ignored"; the assigned Premier League row is untouched.
    expect(screen.getAllByText('Ignored')).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: /ignore all unassigned sections/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Premier League')).toBeInTheDocument();
  });

  it('prefills "Create league…" from the section header, stripped and title-cased', async () => {
    const sections: StructureSection[] = [
      { sheet: 'JUNIORS', header: 'U/9 PLATINUM A', rows: [{ raw: 'TUKS U9 A' }] },
    ];
    vi.mocked(api.platformStructureIntakeParse).mockResolvedValue({
      sections,
      sheetsScanned: 1,
      sheetsWithSections: 1,
    });
    const user = userEvent.setup();
    renderWizard();
    await uploadWorkbook();
    await screen.findByText('2. Sections');

    await user.click(screen.getByRole('button', { name: /create league…/i }));
    await screen.findByRole('dialog', { name: /create league/i });
    expect(screen.getByDisplayValue('U9 Platinum A')).toBeInTheDocument();
  });

  it('excludes a club with an existing plan by default; Include anyway sets overwrite:true on commit', async () => {
    const sections: StructureSection[] = [
      { sheet: 'SENIORS', header: 'Premier League', rows: [{ raw: 'TUKS 1', venue: 'Buks Oval' }] },
    ];
    vi.mocked(api.platformStructureIntakeParse).mockResolvedValue({
      sections,
      sheetsScanned: 1,
      sheetsWithSections: 1,
    });
    // TUKS already has a team plan on record.
    vi.mocked(api.platformTenantOverview).mockResolvedValue({
      ...baseOverview,
      clubs: [
        {
          ...baseOverview.clubs[0],
          leagues: ['premier-league'],
          leagueTeams: { 'premier-league': 1 },
        },
      ],
    } as unknown as TenantOverview);

    const user = userEvent.setup();
    renderWizard();
    await uploadWorkbook();

    await screen.findByText('2. Sections');
    await user.click(screen.getByRole('button', { name: /continue to teams/i }));

    await screen.findByText('3. Teams');
    // TUKS 1 auto-resolves to the seeded club.
    await screen.findByText(/matched — tuks cricket club/i);
    await user.click(screen.getByRole('button', { name: /continue to plan/i }));

    await screen.findByText('4. Plan preview');
    expect(screen.getByText(/excluded — has existing plan/i)).toBeInTheDocument();
    // The overwrite InfoTip is present on this row precisely because it has a plan.
    expect(screen.getByLabelText(/what does replacing mean/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue to commit/i })).toHaveTextContent(
      '0 clubs',
    );

    await user.click(screen.getByRole('button', { name: /include anyway/i }));
    await waitFor(() => expect(screen.getByText(/replaces existing plan/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /continue to commit/i })).toHaveTextContent('1 club');

    await user.click(screen.getByRole('button', { name: /continue to commit/i }));
    await screen.findByText('5. Commit');

    vi.mocked(api.platformStructureIntakeCommit).mockResolvedValue({
      batchId: 'b1',
      leaguesAppended: [],
      clubs: [{ clubId: 'tuks', ok: true, teams: 1, women: 0, juniors: 0 }],
    });
    await user.click(screen.getByRole('button', { name: /^commit \(1 club\)/i }));

    await screen.findByText(/1 committed/i);
    expect(api.platformStructureIntakeCommit).toHaveBeenCalledTimes(1);
    const [calledSlug, payload] = vi.mocked(api.platformStructureIntakeCommit).mock.calls[0];
    expect(calledSlug).toBe('acme');
    expect(payload.clubs).toEqual([
      {
        clubId: 'tuks',
        overwrite: true,
        plan: {
          leagues: ['premier-league'],
          leagueTeams: { 'premier-league': 1 },
          teamRosters: { 'premier-league': [{ name: 'TUKS 1', venue: 'Buks Oval' }] },
          firstTeamVenue: 'Buks Oval',
        },
      },
    ]);
  });

  it('still shows the committed club row after the post-commit overview refetch lands (root-cause regression)', async () => {
    // A committed club's plan lands on the refetched overview — exactly the moment
    // `clubHasExistingPlan` flips true for it. The results table must keep rendering
    // that row off the commit response, not re-derive it from that live-changed state.
    const sections: StructureSection[] = [
      { sheet: 'SENIORS', header: 'Premier League', rows: [{ raw: 'TUKS 1', venue: 'Buks Oval' }] },
    ];
    vi.mocked(api.platformStructureIntakeParse).mockResolvedValue({
      sections,
      sheetsScanned: 1,
      sheetsWithSections: 1,
    });
    vi.mocked(api.platformTenantOverview)
      .mockResolvedValueOnce(baseOverview)
      .mockResolvedValue({
        ...baseOverview,
        clubs: [
          {
            ...baseOverview.clubs[0],
            leagues: ['premier-league'],
            leagueTeams: { 'premier-league': 1 },
          },
        ],
      } as unknown as TenantOverview);
    vi.mocked(api.platformStructureIntakeCommit).mockResolvedValue({
      batchId: 'b2',
      leaguesAppended: [],
      clubs: [{ clubId: 'tuks', ok: true, teams: 1, women: 0, juniors: 0 }],
    });

    const user = userEvent.setup();
    renderWizard();
    await uploadWorkbook();

    await screen.findByText('2. Sections');
    await user.click(screen.getByRole('button', { name: /continue to teams/i }));
    await screen.findByText('3. Teams');
    await user.click(screen.getByRole('button', { name: /continue to plan/i }));
    await screen.findByText('4. Plan preview');
    await user.click(screen.getByRole('button', { name: /continue to commit/i }));
    await screen.findByText('5. Commit');
    await user.click(screen.getByRole('button', { name: /^commit \(1 club\)/i }));

    await screen.findByText(/1 committed/i);
    // The row survives — this is the assertion that fails without the fix.
    expect(screen.getByText('TUKS Cricket Club')).toBeInTheDocument();
    expect(screen.getByText('Committed')).toBeInTheDocument();
  });
});

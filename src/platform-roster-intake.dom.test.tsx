/**
 * RosterIntakeWizard — end-to-end behaviour through the browser-visible flow, with
 * api.ts mocked. Pins the DOM-visible contract the plan calls out: clubs-step gating
 * on the stored member database, allowMissingId default/auto-suggest/re-parse,
 * cross-club duplicate resolution blocking Continue, masked-ID reveal, unmapped
 * age-band flagging, commit results + prominent server conflicts, and the guidance
 * primitives (StepIntro/InfoTip) every step and high-stakes control carries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './query';
import { RosterIntakeWizard } from './platform-roster-intake';
import * as api from './api';
import type {
  InsightsClub,
  RequiredDoc,
  RosterIntakeParseResponse,
  TenantConfig,
  TenantOverview,
} from './types';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    platformGetTenant: vi.fn(),
    platformTenantOverview: vi.fn(),
    platformRosterIntakeParse: vi.fn(),
    platformRosterIntakeCommit: vi.fn(),
    platformDocIntakePresign: vi.fn(),
    platformDocIntakeCommit: vi.fn(),
    uploadToPresigned: vi.fn(),
  };
});

const DOCS: RequiredDoc[] = [
  { key: 'memberDb', name: 'Member Database', role: 'memberDatabase' },
  { key: 'committeeDoc', name: 'Committee Doc', role: 'committee' },
];

const config = {
  tenant: 'acme',
  branding: { name: 'Acme Union' },
  districts: ['Central'],
  requiredDocs: DOCS,
  leagues: [{ key: 'u9', name: 'Under 9' }],
} as unknown as TenantConfig;

function makeClub(overrides: Partial<InsightsClub>): InsightsClub {
  return {
    id: 'club-a',
    name: 'Alpha CC',
    district: 'Central',
    affiliation: 'not_started',
    cqi: 0,
    docs: {},
    players: 0,
    intake: { memberDatabase: 'parseable', committee: 'absent' },
    ...overrides,
  } as InsightsClub;
}

const overview = {
  tenant: 'acme',
  name: 'Acme Union',
  leagues: [{ key: 'u9', name: 'Under 9' }],
  districts: ['Central'],
  clearances: [],
  clubs: [
    makeClub({ id: 'club-a', name: 'Alpha CC' }),
    makeClub({
      id: 'club-b',
      name: 'Bravo CC',
      intake: { memberDatabase: 'absent', committee: 'absent' },
    }),
    makeClub({ id: 'club-c', name: 'Charlie CC' }),
  ],
} as unknown as TenantOverview;

function renderWizard() {
  const toast = vi.fn();
  queryClient.clear();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/platform/tenants/acme/roster-intake']}>
        <Routes>
          <Route
            path="/platform/tenants/:slug/roster-intake"
            element={<RosterIntakeWizard toast={toast} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { toast };
}

const standardParse: RosterIntakeParseResponse = {
  parseable: true,
  sheets: [
    {
      name: 'Seniors',
      skipped: false,
      hasIdColumn: true,
      totalDataRows: 1,
      rows: [
        {
          rowNumber: 2,
          firstName: 'Sipho',
          lastName: 'Dlamini',
          dob: '1998-03-14',
          idNumber: '9803145012083',
          missingId: false,
        },
      ],
      exceptions: [],
      unknownGenderRaw: [],
      unknownRaceRaw: [],
    },
  ],
  dobOnlyCount: 0,
  juniorLeagueKeys: ['u9'],
  ageGroupRaws: [],
};

const dobVariantParse: RosterIntakeParseResponse = {
  parseable: true,
  sheets: [
    {
      name: 'Juniors',
      skipped: false,
      hasIdColumn: false,
      totalDataRows: 1,
      rows: [
        {
          rowNumber: 2,
          firstName: 'Sipho',
          lastName: 'Dlamini',
          dob: '1998-03-14',
          missingId: true,
          team: undefined,
        },
      ],
      exceptions: [{ rowNumber: 3, sheet: 'Juniors', reason: 'bad-id' }],
      unknownGenderRaw: [],
      unknownRaceRaw: [],
    },
  ],
  dobOnlyCount: 1,
  juniorLeagueKeys: ['u9'],
  ageGroupRaws: [{ raw: 'U/10', leagueKey: null }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.platformGetTenant).mockResolvedValue(config);
  vi.mocked(api.platformTenantOverview).mockResolvedValue(overview);
});

describe('RosterIntakeWizard', () => {
  it('disables the checkbox for a club with no stored member database and shows the intake hint', async () => {
    renderWizard();
    await screen.findByRole('heading', { name: /roster/i });

    const row = screen.getByText('Bravo CC').closest('tr')!;
    const checkbox = within(row).getByRole('checkbox', { name: /select bravo cc/i });
    expect(checkbox).toBeDisabled();
    expect(within(row).getByText(/add it via document intake/i)).toBeInTheDocument();
  });

  it('renders a StepIntro on the clubs step and an InfoTip on the replace-database action', async () => {
    renderWizard();
    await screen.findByRole('heading', { name: /roster/i });
    expect(
      screen.getByText(/only clubs with a member database on file can be parsed/i),
    ).toBeInTheDocument();
    // Bravo CC (absent) surfaces the replace-database affordance with its InfoTip.
    const row = screen.getByText('Bravo CC').closest('tr')!;
    expect(within(row).getByLabelText(/about replacing the member database/i)).toBeInTheDocument();
  });

  it('defaults allowMissingId off, auto-suggests it on for a DOB-variant club, immediately re-parses with the flag, and re-parses again on a manual flip', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformRosterIntakeParse).mockImplementation(async (_slug, body) =>
      body.clubId === 'club-a' ? dobVariantParse : standardParse,
    );
    renderWizard();
    await screen.findByRole('heading', { name: /roster/i });

    const rowA = screen.getByText('Alpha CC').closest('tr')!;
    await user.click(within(rowA).getByRole('checkbox', { name: /select alpha cc/i }));
    await user.click(screen.getByRole('button', { name: /parse 1 club/i }));

    await screen.findByText(/no id column — dob variant/i);
    const toggle = screen.getByRole('checkbox', { name: /allow players without an id number/i });
    expect(toggle).toBeChecked(); // auto-suggested ON for the DOB-variant club

    // The auto-suggest fires an automatic follow-up parse WITH the flag — the checkbox
    // must never sit checked next to a stale strict-parse result (round-2 E2E: Adelaar
    // showed a checked box with the strict parse's 0-parsed/251-bad-id numbers until
    // manually toggled off/on).
    await waitFor(() => expect(api.platformRosterIntakeParse).toHaveBeenCalledTimes(2));
    const autoReparseCall = vi.mocked(api.platformRosterIntakeParse).mock.calls.at(-1)!;
    expect(autoReparseCall[1]).toEqual({
      clubId: 'club-a',
      allowMissingId: true,
      ageGroupMap: undefined,
    });

    await user.click(toggle); // flip off — re-parses again
    await waitFor(() => expect(api.platformRosterIntakeParse).toHaveBeenCalledTimes(3));
    const lastCall = vi.mocked(api.platformRosterIntakeParse).mock.calls.at(-1)!;
    expect(lastCall[1]).toEqual({
      clubId: 'club-a',
      allowMissingId: false,
      ageGroupMap: undefined,
    });
  });

  it('flags an unmapped junior age band in the confirm table', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformRosterIntakeParse).mockResolvedValue(dobVariantParse);
    renderWizard();
    await screen.findByRole('heading', { name: /roster/i });

    const rowA = screen.getByText('Alpha CC').closest('tr')!;
    await user.click(within(rowA).getByRole('checkbox', { name: /select alpha cc/i }));
    await user.click(screen.getByRole('button', { name: /parse 1 club/i }));

    await screen.findByText('U/10');
    expect(screen.getByText('Unmapped')).toBeInTheDocument();
  });

  it('masks IDs by default with a per-row reveal', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformRosterIntakeParse).mockResolvedValue(standardParse);
    renderWizard();
    await screen.findByRole('heading', { name: /roster/i });

    const rowA = screen.getByText('Alpha CC').closest('tr')!;
    await user.click(within(rowA).getByRole('checkbox', { name: /select alpha cc/i }));
    await user.click(screen.getByRole('button', { name: /parse 1 club/i }));

    await user.click(screen.getByRole('button', { name: /show detail/i }));
    expect(screen.queryByText('9803145012083')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /reveal/i }));
    expect(screen.getByText('9803145012083')).toBeInTheDocument();
  });

  it('blocks Continue while a cross-club duplicate is unresolved, unblocks once resolved', async () => {
    const user = userEvent.setup();
    const rowSipho = (clubName: string) => ({
      parseable: true as const,
      sheets: [
        {
          name: 'Seniors',
          skipped: false,
          hasIdColumn: true,
          totalDataRows: 1,
          rows: [
            {
              rowNumber: 2,
              firstName: 'Sipho',
              lastName: 'Dlamini',
              dob: '1998-03-14',
              idNumber: '9803145012083',
              missingId: false,
            },
          ],
          exceptions: [],
          unknownGenderRaw: [],
          unknownRaceRaw: [],
        },
      ],
      dobOnlyCount: 0,
      juniorLeagueKeys: ['u9'],
      ageGroupRaws: [],
    });
    vi.mocked(api.platformRosterIntakeParse).mockImplementation(async (_slug, body) =>
      rowSipho(body.clubId),
    );

    renderWizard();
    await screen.findByRole('heading', { name: /roster/i });

    const rowA = screen.getByText('Alpha CC').closest('tr')!;
    const rowC = screen.getByText('Charlie CC').closest('tr')!;
    await user.click(within(rowA).getByRole('checkbox', { name: /select alpha cc/i }));
    await user.click(within(rowC).getByRole('checkbox', { name: /select charlie cc/i }));
    await user.click(screen.getByRole('button', { name: /parse 2 clubs/i }));

    await screen.findByRole('button', { name: /^exclude both$/i });
    const continueBtn = screen.getByRole('button', { name: /continue to commit/i });
    expect(continueBtn).toBeDisabled();
    // The "not sure?" hint is an InfoTip popover — collapsed until opened.
    expect(screen.getByRole('button', { name: /not sure what to do\?/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /not sure what to do\?/i }));
    expect(screen.getByText(/not sure\? exclude both/i)).toBeInTheDocument();

    // Resolve by keeping one side — "exclude both" would leave zero committable rows,
    // which keeps Continue disabled for an unrelated reason (nothing left to commit).
    await user.click(screen.getByRole('button', { name: /keep in alpha cc/i }));
    await waitFor(() => expect(continueBtn).not.toBeDisabled());
  });

  it('commits per club and renders server-side crossClubConflicts prominently', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformRosterIntakeParse).mockResolvedValue(standardParse);
    vi.mocked(api.platformRosterIntakeCommit).mockResolvedValue({
      batchId: 'b1',
      created: 1,
      alreadyPresent: 0,
      crossClubConflicts: [
        {
          rowNumber: 2,
          clubId: 'club-a',
          playerNaturalKey: 'nk1',
          claimedBy: 'club-x',
          alreadyRegisteredAt: '2026-01-01',
        },
      ],
      playerCount: { 'club-a': 1 },
    });

    renderWizard();
    await screen.findByRole('heading', { name: /roster/i });
    const rowA = screen.getByText('Alpha CC').closest('tr')!;
    await user.click(within(rowA).getByRole('checkbox', { name: /select alpha cc/i }));
    await user.click(screen.getByRole('button', { name: /parse 1 club/i }));
    await screen.findByText(/1 parsed/i);

    await user.click(screen.getByRole('button', { name: /continue to commit/i }));
    await screen.findByText('3. Commit');
    await user.click(screen.getByRole('button', { name: /start commit/i }));

    await screen.findByText(/excluded — already registered elsewhere/i);
    expect(screen.getByText(/claimed by club-x/i)).toBeInTheDocument();
    expect(api.platformRosterIntakeCommit).toHaveBeenCalledTimes(1);
  });
});

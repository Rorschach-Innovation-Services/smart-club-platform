/**
 * RepsPage — coverage table + extract/invite flow, api layer mocked.
 *
 * Pins: zero-rep clubs render "None" and the needs-rep filter narrows to them;
 * committee-extract prefills the invite modal from a picked candidate; an
 * unparseable committee doc opens the same modal with "View document" + a blank
 * form instead of erroring; a successful invite shows a copyable login link (and
 * a warning when the server sends one); an admin-membership 409 renders the
 * server's guidance verbatim; the StepIntro and the high-stakes InfoTips render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './query';
import { RepsPage } from './platform-reps';
import { ApiError } from './api';
import * as api from './api';
import type { RequiredDoc, TenantConfig, TenantOverview, TenantRepsResponse } from './types';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    platformGetTenant: vi.fn(),
    platformTenantOverview: vi.fn(),
    platformTenantReps: vi.fn(),
    platformInviteRep: vi.fn(),
    platformCommitteeExtract: vi.fn(),
    platformDocViewUrl: vi.fn(),
  };
});

const DOCS: RequiredDoc[] = [
  { key: 'committee-doc', name: 'Committee document', role: 'committee' },
];

const config = {
  tenant: 'acme',
  branding: { name: 'Acme Union' },
  districts: ['Central'],
  requiredDocs: DOCS,
} as unknown as TenantConfig;

const overview = {
  tenant: 'acme',
  name: 'Acme Union',
  leagues: [],
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
      intake: { memberDatabase: 'absent', committee: 'parseable' },
    },
    {
      id: 'riverside',
      name: 'Riverside CC',
      district: 'Central',
      affiliation: 'not_started',
      cqi: 0,
      docs: {},
      players: 0,
      intake: { memberDatabase: 'absent', committee: 'unparseable' },
    },
    {
      id: 'oaklands',
      name: 'Oaklands CC',
      district: 'Central',
      affiliation: 'not_started',
      cqi: 0,
      docs: {},
      players: 0,
      intake: { memberDatabase: 'absent', committee: 'absent' },
    },
  ],
} as unknown as TenantOverview;

const repsNoneCovered: TenantRepsResponse = {
  reps: [],
  coverage: [
    { clubId: 'phsob', repCount: 0 },
    { clubId: 'riverside', repCount: 0 },
    { clubId: 'oaklands', repCount: 1 },
  ],
};

function renderPage() {
  const toast = vi.fn();
  queryClient.clear();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/platform/tenants/acme/reps']}>
        <Routes>
          <Route path="/platform/tenants/:slug/reps" element={<RepsPage toast={toast} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { toast };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.platformGetTenant).mockResolvedValue(config);
  vi.mocked(api.platformTenantOverview).mockResolvedValue(overview);
  vi.mocked(api.platformTenantReps).mockResolvedValue({
    reps: [
      {
        sub: 'u1',
        email: 'chair@oaklands.co.za',
        clubIds: ['oaklands'],
        status: 'active',
      },
    ],
    coverage: repsNoneCovered.coverage,
  });
});

describe('RepsPage', () => {
  it('shows None for zero-rep clubs and the needs-rep filter narrows the table', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { name: /rep invites/i });

    const phsobRow = screen.getByText('PHSOB Cricket Club').closest('tr')!;
    expect(within(phsobRow).getByText('None')).toBeInTheDocument();
    const oaklandsRow = screen.getByText('Oaklands CC').closest('tr')!;
    expect(within(oaklandsRow).getByText('Has rep')).toBeInTheDocument();

    await user.click(screen.getByLabelText(/needs-rep only/i));

    expect(screen.getByText('PHSOB Cricket Club')).toBeInTheDocument();
    expect(screen.getByText('Riverside CC')).toBeInTheDocument();
    expect(screen.queryByText('Oaklands CC')).not.toBeInTheDocument();
  });

  it('extract flow prefills the invite modal from a picked candidate', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformCommitteeExtract).mockResolvedValue({
      status: 'ok',
      candidates: [
        {
          name: 'Jane Chair',
          role: 'Chairperson',
          email: 'jane@phsob.co.za',
          confidence: 'high',
          sheet: 'Exco',
          rowNumber: 3,
        },
      ],
    });
    renderPage();
    await screen.findByRole('heading', { name: /rep invites/i });

    const phsobRow = screen.getByText('PHSOB Cricket Club').closest('tr')!;
    await user.click(within(phsobRow).getByRole('button', { name: /extract from committee doc/i }));

    await screen.findByText(/pick a/i);
    await user.click(screen.getByRole('button', { name: /use this contact/i }));

    await screen.findByText(/invite a/i);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByDisplayValue('jane@phsob.co.za')).toBeInTheDocument();
    expect(within(dialog).getByText('High confidence')).toBeInTheDocument();
  });

  it('unparseable committee doc opens the invite modal with View document + a blank form', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformCommitteeExtract).mockResolvedValue({
      status: 'unparseable',
      reason: 'Scanned image, no extractable text',
    });
    renderPage();
    await screen.findByRole('heading', { name: /rep invites/i });

    const riversideRow = screen.getByText('Riverside CC').closest('tr')!;
    await user.click(
      within(riversideRow).getByRole('button', { name: /extract from committee doc/i }),
    );

    await screen.findByText(/invite a/i);
    expect(screen.getByRole('button', { name: /view document/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toHaveValue('');
    // The server's own reason string is surfaced verbatim, not the generic hint.
    expect(screen.getByText('Scanned image, no extractable text')).toBeInTheDocument();
  });

  it('surfaces a legacy-.xls server reason verbatim in the unparseable-doc modal', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformCommitteeExtract).mockResolvedValue({
      status: 'unparseable',
      reason: 'legacy .xls workbook — save it as .xlsx and re-upload via document intake',
    });
    renderPage();
    await screen.findByRole('heading', { name: /rep invites/i });

    const riversideRow = screen.getByText('Riverside CC').closest('tr')!;
    await user.click(
      within(riversideRow).getByRole('button', { name: /extract from committee doc/i }),
    );

    await screen.findByText(/invite a/i);
    expect(
      screen.getByText('legacy .xls workbook — save it as .xlsx and re-upload via document intake'),
    ).toBeInTheDocument();
  });

  it('explains extraction is unavailable when no committee role is assigned in the catalogue', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformGetTenant).mockResolvedValue({
      ...config,
      requiredDocs: [{ key: 'constitution', name: 'Constitution' }],
    } as unknown as TenantConfig);
    renderPage();
    await screen.findByRole('heading', { name: /rep invites/i });

    const phsobRow = screen.getByText('PHSOB Cricket Club').closest('tr')!;
    await user.click(within(phsobRow).getByRole('button', { name: /^invite manually$/i }));

    await screen.findByText(/invite a/i);
    expect(screen.getByText(/no document in the catalogue is marked/i)).toBeInTheDocument();
  });

  it('shows a copyable login link on success, plus a warning when the server sends one', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformInviteRep).mockResolvedValue({
      sub: 'u2',
      email: 'newrep@phsob.co.za',
      loginUrl: 'https://phsob.example.com/?email=newrep%40phsob.co.za',
      results: [],
      warning: 'Tenant has no canonical web origin yet — using the request origin.',
    });
    renderPage();
    await screen.findByRole('heading', { name: /rep invites/i });

    const phsobRow = screen.getByText('PHSOB Cricket Club').closest('tr')!;
    await user.click(within(phsobRow).getByRole('button', { name: /^invite manually$/i }));

    await screen.findByText(/invite a/i);
    await user.type(screen.getByLabelText(/^email$/i), 'newrep@phsob.co.za');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() =>
      expect(
        screen.getByDisplayValue('https://phsob.example.com/?email=newrep%40phsob.co.za'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/no canonical web origin yet/i)).toBeInTheDocument();
  });

  it('Next club without a rep → shows the next club’s name and a blank form, not the previous result', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformInviteRep).mockResolvedValue({
      sub: 'u2',
      email: 'newrep@phsob.co.za',
      loginUrl: 'https://phsob.example.com/?email=newrep%40phsob.co.za',
      results: [],
    });
    renderPage();
    await screen.findByRole('heading', { name: /rep invites/i });

    const phsobRow = screen.getByText('PHSOB Cricket Club').closest('tr')!;
    await user.click(within(phsobRow).getByRole('button', { name: /^invite manually$/i }));

    await screen.findByText(/invite a/i);
    expect(screen.getByRole('dialog')).toHaveTextContent('PHSOB Cricket Club');
    await user.type(screen.getByLabelText(/^email$/i), 'newrep@phsob.co.za');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() =>
      expect(
        screen.getByDisplayValue('https://phsob.example.com/?email=newrep%40phsob.co.za'),
      ).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /next club without a rep/i }));

    // The next needs-rep club (alphabetically after PHSOB) is Riverside CC.
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Riverside CC'));
    expect(screen.queryByDisplayValue(/phsob\.example\.com/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText((_, el) => el?.textContent === 'Account created for newrep@phsob.co.za.'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toHaveValue('');
  });

  it('renders the server admin-membership 409 guidance verbatim', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformInviteRep).mockRejectedValue(
      new ApiError(409, 'This person is already an admin — manage them in Team & Access.'),
    );
    renderPage();
    await screen.findByRole('heading', { name: /rep invites/i });

    const phsobRow = screen.getByText('PHSOB Cricket Club').closest('tr')!;
    await user.click(within(phsobRow).getByRole('button', { name: /^invite manually$/i }));

    await screen.findByText(/invite a/i);
    await user.type(screen.getByLabelText(/^email$/i), 'admin@phsob.co.za');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await screen.findByText(/manage them in Team & Access/i);
  });

  it('renders the StepIntro and the high-stakes InfoTips', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformCommitteeExtract).mockResolvedValue({
      status: 'ok',
      candidates: [
        {
          name: 'Jane Chair',
          role: 'Chairperson',
          email: 'jane@phsob.co.za',
          confidence: 'high',
          sheet: 'Exco',
          rowNumber: 3,
        },
      ],
    });
    renderPage();
    await screen.findByRole('heading', { name: /rep invites/i });
    expect(screen.getByText(/every club needs at least one rep/i)).toBeInTheDocument();

    const phsobRow = screen.getByText('PHSOB Cricket Club').closest('tr')!;
    await user.click(within(phsobRow).getByRole('button', { name: /extract from committee doc/i }));
    await screen.findByText(/pick a/i);
    expect(screen.getByRole('button', { name: /about confidence/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /use this contact/i }));
    await screen.findByText(/invite a/i);
    expect(
      screen.getByRole('button', { name: /about notification channels/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText(/^email$/i));
    // Deselect both channels to surface the link-only InfoTip.
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'WhatsApp' }));
    expect(screen.getByRole('button', { name: /about link-only invites/i })).toBeInTheDocument();
  });
});

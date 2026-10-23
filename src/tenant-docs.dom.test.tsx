/**
 * Per-tenant compliance-doc rendering: the club portal's DocumentsView and the admin
 * club detail's doc rows, driven by a non-default catalogue (optional records, no exco,
 * a capped multi-file doc) and by the club's own "unavailable" declaration.
 *
 * A `.dom.` suite because club.tsx imports leaflet, which reads `window` at module load.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from './test-utils';
import { DocumentsView } from './club';
import { AdminClubDetail } from './admin';
import type { RequiredDoc } from './types';

const CATALOGUE: RequiredDoc[] = [
  { key: 'constitution', name: 'Club constitution', desc: 'Your adopted constitution' },
  {
    key: 'fees',
    name: 'Affiliation fees',
    desc: 'Invoice or proof of payment',
    multiFile: true,
    minFiles: 1,
    maxFiles: 2,
    allowUnavailable: true,
  },
  { key: 'financials', name: 'Financials', desc: 'Treasurer report', allowUnavailable: true },
  {
    key: 'records',
    name: 'Disciplinary records',
    desc: 'DC notices and outcomes',
    multiFile: true,
    minFiles: 1,
    optional: true,
  },
];

const file = (n: number) => ({
  objectKey: `t/club/fees-${n}.pdf`,
  size: 1000,
  contentType: 'application/pdf',
  uploadedAt: '2026-08-01T00:00:00.000Z',
});

const baseClub = (over: Record<string, unknown> = {}) => ({
  id: 'club1',
  name: 'Test CC',
  district: 'Test District',
  sub: '',
  chair: 'Pat Chair',
  affiliation: 'not_started',
  cqi: 0,
  players: 0,
  leagues: [],
  exco: { chair: { name: 'Pat Chair' } },
  docs: {},
  docMeta: {},
  version: 1,
  ...over,
});

function renderDocs(club: Record<string, unknown>) {
  return renderWithProviders(
    <DocumentsView
      club={club}
      goto={vi.fn()}
      toast={vi.fn()}
      requiredDocs={CATALOGUE}
      onUpload={vi.fn()}
      onRemoveFile={vi.fn()}
      onMarkUnavailable={vi.fn()}
      onSetCourseBooked={vi.fn()}
      onClearCourseBooked={vi.fn()}
      onSetMeetingBooked={vi.fn()}
      onClearMeetingBooked={vi.fn()}
      onSaveExco={vi.fn()}
      submissionDeadline="2026-12-31"
      unionEmail=""
    />,
  );
}

// A doc's name also appears in the "What we check" card, so resolve the doc-row one.
const docRow = (name: string) =>
  screen
    .getAllByText(name)
    .map((el) => el.closest('.doc-row'))
    .find(Boolean) as HTMLElement;

describe('DocumentsView — per-tenant catalogue', () => {
  it('counts only non-optional docs in the header and KPIs, with tenant-neutral copy', () => {
    renderDocs(baseClub({ docs: { constitution: true } }));
    expect(screen.getByText(/3 documents must be uploaded/)).toBeInTheDocument();
    expect(screen.getByText(/One optional record can also be kept on file/)).toBeInTheDocument();
    expect(screen.queryByText(/Cricket Services/)).toBeNull();
    expect(screen.getByText('of 3 required')).toBeInTheDocument();
  });

  it('badges optional records "Optional" and still offers an upload for them', () => {
    renderDocs(baseClub());
    const row = docRow('Disciplinary records');
    expect(within(row).getByText('Optional')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /add file/i })).toBeInTheDocument();
    expect(within(docRow('Club constitution')).queryByText('Optional')).toBeNull();
  });

  it('keeps the Unavailable affordance on a non-optional doc that allows it', () => {
    renderDocs(baseClub());
    expect(
      within(docRow('Affiliation fees')).getByRole('button', { name: 'Unavailable' }),
    ).toBeInTheDocument();
    // …and none on the optional record, which has no allowUnavailable.
    expect(
      within(docRow('Disciplinary records')).queryByRole('button', { name: 'Unavailable' }),
    ).toBeNull();
  });

  it('withdraws "Add file" once a multi-file doc reaches its maxFiles cap', () => {
    renderDocs(
      baseClub({ docs: { fees: true }, docMeta: { fees: { files: [file(1), file(2)] } } }),
    );
    const row = docRow('Affiliation fees');
    expect(within(row).queryByRole('button', { name: /add file/i })).toBeNull();
    expect(within(row).getByText(/Limit of 2 files reached/)).toBeInTheDocument();
  });

  it('offers "Add file" (not "Add certificate") below the cap', () => {
    renderDocs(baseClub({ docs: { fees: true }, docMeta: { fees: { files: [file(1)] } } }));
    const row = docRow('Affiliation fees');
    expect(within(row).getByRole('button', { name: /add file/i })).toBeInTheDocument();
    expect(screen.queryByText(/add certificate/i)).toBeNull();
  });

  it('renders "What we check" from the catalogue, not the default six', () => {
    renderDocs(baseClub());
    const card = screen.getByText('What we check').closest('.card') as HTMLElement;
    expect(within(card).getByText(/Treasurer report/)).toBeInTheDocument();
    expect(within(card).queryByText(/Disciplinary records/)).toBeNull(); // optional
    expect(within(card).queryByText(/Exco list includes/)).toBeNull();
  });
});

function renderAdmin(
  club: Record<string, unknown>,
  onRevertDoc = vi.fn(),
  extra: Record<string, unknown> = {},
) {
  // AdminClubDetail's props are untyped JS-era destructuring (every handler required by
  // inference); only the ones this surface touches matter here.
  const props = {
    club,
    gotoList: vi.fn(),
    toast: vi.fn(),
    requiredDocs: CATALOGUE,
    onRevertDoc,
    onMarkCompliant: vi.fn(),
    ...extra,
  } as unknown as Parameters<typeof AdminClubDetail>[0];
  renderWithProviders(<AdminClubDetail {...props} />);
  return screen.getByText('Compliance documents').closest('.card') as HTMLElement;
}

describe('AdminClubDetail — compliance doc rows', () => {
  it('shows an absent optional record as "Optional", never Required/Missing', () => {
    const card = renderAdmin(baseClub());
    const row = within(card).getByText('Disciplinary records').closest('.doc-row') as HTMLElement;
    expect(within(row).getByText('Optional')).toBeInTheDocument();
    expect(within(row).queryByText('Required')).toBeNull();
    expect(within(row).queryByText('Missing')).toBeNull();
    // A required doc still reads Required + Missing.
    const req = within(card).getByText('Club constitution').closest('.doc-row') as HTMLElement;
    expect(within(req).getByText('Required')).toBeInTheDocument();
    expect(within(req).getByText('Missing')).toBeInTheDocument();
  });

  it('renders the club’s unavailable declaration as its own state — no Override, no Revert', () => {
    const card = renderAdmin(
      baseClub({
        docs: { fees: true, financials: true },
        docMeta: {
          fees: { files: [], unavailable: true, at: '2026-08-01T00:00:00.000Z' },
          financials: { unavailable: true, at: '2026-08-01T00:00:00.000Z' },
        },
      }),
    );
    for (const name of ['Affiliation fees', 'Financials']) {
      const row = within(card).getByText(name).closest('.doc-row') as HTMLElement;
      expect(within(row).getByText(/Marked unavailable by club/)).toBeInTheDocument();
      expect(within(row).getByText('Unavailable')).toBeInTheDocument();
      expect(within(row).queryByText('Override')).toBeNull();
      expect(within(row).queryByRole('button', { name: 'Revert' })).toBeNull();
    }
  });

  it('uploads a missing single-file doc on the club’s behalf (local mode)', async () => {
    vi.stubEnv('VITE_LOCAL_AUTH', '1');
    try {
      const onUploadDoc = vi.fn().mockResolvedValue(undefined);
      const card = renderAdmin(baseClub(), vi.fn(), { onUploadDoc, onRemoveDocFile: vi.fn() });
      const row = within(card).getByText('Club constitution').closest('.doc-row') as HTMLElement;
      expect(within(row).getByRole('button', { name: /upload/i })).toBeInTheDocument();
      const input = row.querySelector('input[type="file"]') as HTMLInputElement;
      const pdf = new File(['%PDF'], 'c.pdf', { type: 'application/pdf' });
      fireEvent.change(input, { target: { files: [pdf] } });
      await waitFor(() => expect(onUploadDoc).toHaveBeenCalledTimes(1));
      const [key, meta] = onUploadDoc.mock.calls[0];
      expect(key).toBe('constitution');
      expect(meta).toMatchObject({ size: pdf.size, contentType: 'application/pdf' });
      expect(meta.objectKey).toMatch(/^local\/constitution-.+\.pdf$/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('offers Add file and a per-file Remove on a multi-file doc', () => {
    const onRemoveDocFile = vi.fn().mockResolvedValue(undefined);
    const card = renderAdmin(
      baseClub({ docs: { fees: true }, docMeta: { fees: { files: [file(1)] } } }),
      vi.fn(),
      { onUploadDoc: vi.fn(), onRemoveDocFile },
    );
    const row = within(card).getByText('Affiliation fees').closest('.doc-row') as HTMLElement;
    expect(within(row).getByRole('button', { name: /add file/i })).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    // Destructive: nothing happens until the confirm is accepted.
    expect(onRemoveDocFile).not.toHaveBeenCalled();
    const dialog = document.querySelector('.fix-confirm-box') as HTMLElement;
    expect(dialog).toHaveTextContent('Remove this file?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, remove' }));
    expect(onRemoveDocFile).toHaveBeenCalledWith('fees', 't/club/fees-1.pdf');
  });

  it('shows no upload or remove controls without the handlers', () => {
    const card = renderAdmin(
      baseClub({ docs: { fees: true }, docMeta: { fees: { files: [file(1)] } } }),
    );
    expect(within(card).queryByRole('button', { name: /upload|add file|replace/i })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('counts the documents KPI against non-optional docs only', () => {
    renderAdmin(baseClub({ docs: { constitution: true, records: true } }));
    expect(screen.getByText('1/3')).toBeInTheDocument();
  });
});

describe('Onboarding walkthrough — doc names come from the tenant catalogue', () => {
  it('names the tenant’s counted docs, notes optional records, and never the default six', async () => {
    const { Onboarding } = await import('./onboarding');
    const { fireEvent } = await import('@testing-library/react');
    renderWithProviders(
      <Onboarding
        club={baseClub()}
        onClose={vi.fn()}
        onComplete={vi.fn()}
        onStart={vi.fn()}
        submissionDeadline="2026-12-31"
        requiredDocs={CATALOGUE}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(
      screen.getByText(
        'Club constitution · Affiliation fees · Financials (max 10 MB each). Optional records can be kept on file too.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Safeguarding/)).toBeNull();
  });
});

describe('Operator overview — compliance card uses the payload catalogue', () => {
  it('labels "standard doc set" only when no catalogue arrived', async () => {
    const { InsightsBreakdown } = await import('./insights');
    const clubs = [
      {
        id: 'c1',
        name: 'C1',
        district: 'D',
        affiliation: 'complete',
        cqi: 0,
        docs: { fees: true },
        leagues: [],
        leagueTeams: {},
        players: 0,
        chair: '',
      },
    ];
    const props = {
      clubs,
      leagues: [],
      districts: ['D'],
      clearances: [],
      context: 'operator',
    } as unknown as Parameters<typeof InsightsBreakdown>[0];
    const { unmount } = renderWithProviders(
      <InsightsBreakdown {...props} requiredDocs={CATALOGUE} />,
    );
    expect(screen.queryByText(/standard doc set/)).toBeNull();
    expect(screen.getAllByText('Affiliation fees').length).toBeGreaterThan(0);
    unmount();
    renderWithProviders(<InsightsBreakdown {...props} />);
    expect(screen.getByText(/standard doc set/)).toBeInTheDocument();
  });
});

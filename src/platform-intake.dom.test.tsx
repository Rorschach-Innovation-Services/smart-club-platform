/**
 * DocIntakeWizard — end-to-end behaviour through the browser-visible flow: ingest a
 * folder pick, correct one row in review, then commit with the api layer mocked.
 *
 * Drives the folder-picker ingestion path (not the zip path) — jsdom has no worker
 * support for fflate's async `unzip`, and the folder picker exercises the exact same
 * downstream matching/review/commit code the zip path feeds into. What's zip-specific
 * (extraction, shared-root stripping) is plain data transformation with no DOM
 * dependency, so it isn't what this test needs to cover.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './query';
import { DocIntakeWizard } from './platform-intake';
import * as api from './api';
import type { RequiredDoc, TenantConfig, TenantOverview } from './types';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    platformGetTenant: vi.fn(),
    platformTenantOverview: vi.fn(),
    platformDocIntakePresign: vi.fn(),
    platformDocIntakeCommit: vi.fn(),
    platformCreateClub: vi.fn(),
    uploadToPresigned: vi.fn(),
  };
});

const DOCS: RequiredDoc[] = [
  { key: 'leagueEntry', name: 'Club League Entry', matchHints: ['league entry'] },
  { key: 'healthTracker', name: 'Club Health Tracker', matchHints: ['health tracker'] },
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
    },
  ],
} as unknown as TenantOverview;

/** A jsdom File with webkitRelativePath set — the folder picker reads that, not .name. */
function folderFile(relPath: string, content = 'x'): File {
  const f = new File([content], relPath.split('/').pop()!, { type: 'application/pdf' });
  Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
  return f;
}

function pickFolder(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

function renderWizard() {
  const toast = vi.fn();
  queryClient.clear();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/platform/tenants/acme/doc-intake']}>
        <Routes>
          <Route
            path="/platform/tenants/:slug/doc-intake"
            element={<DocIntakeWizard toast={toast} />}
          />
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
});

describe('DocIntakeWizard', () => {
  it('ingests a folder pick, matches a row automatically, and lets the operator fix an unmatched one', async () => {
    const user = userEvent.setup();
    renderWizard();

    await screen.findByRole('heading', { name: /bulk document/i });

    // Folder pick: PHSOB matches the seeded club by name; "Riverside" matches no club.
    const folderInput = document.querySelector('input[webkitdirectory]') as HTMLInputElement;
    pickFolder(folderInput, [
      folderFile('Pack/PHSOB/2026 Club League Entry.pdf'),
      folderFile('Pack/Riverside/Club Health Tracker.pdf'),
    ]);

    await screen.findByText(/2 files/i);
    await user.click(screen.getByRole('button', { name: /continue to matching/i }));

    // The PHSOB row resolved automatically.
    const readyRow = (await screen.findByText('2026 Club League Entry.pdf')).closest('tr')!;
    expect(within(readyRow).getByText('Ready')).toBeInTheDocument();
    expect(within(readyRow).getByDisplayValue('PHSOB Cricket Club')).toBeInTheDocument();

    // The Riverside row needs a human — no club with that name exists yet.
    const unmatchedRow = screen.getByText('Club Health Tracker.pdf').closest('tr')!;
    expect(within(unmatchedRow).getAllByText('Pick a club').length).toBeGreaterThan(0);

    // Fix it by hand: pick the only club in the tenant.
    const clubSelect = within(unmatchedRow).getAllByRole('combobox')[0];
    await user.selectOptions(clubSelect, 'PHSOB Cricket Club');
    await waitFor(() => expect(within(unmatchedRow).getByText('Ready')).toBeInTheDocument());

    // Both rows are now committable.
    const continueBtn = screen.getByRole('button', { name: /continue to upload/i });
    expect(continueBtn).toHaveTextContent('2 files');
    await user.click(continueBtn);

    // ── Commit ──
    vi.mocked(api.platformDocIntakePresign).mockResolvedValue({
      items: [
        { ok: true, uploadUrl: 'https://s3/1', objectKey: 'k1', contentType: 'application/pdf' },
        { ok: true, uploadUrl: 'https://s3/2', objectKey: 'k2', contentType: 'application/pdf' },
      ],
    });
    vi.mocked(api.uploadToPresigned).mockResolvedValue(undefined);
    vi.mocked(api.platformDocIntakeCommit).mockResolvedValue({
      clubs: [{ clubId: 'phsob', ok: true, docs: { leagueEntry: true, healthTracker: true } }],
    });

    await user.click(screen.getByRole('button', { name: /start upload/i }));

    await screen.findByRole('button', { name: /done — view overview/i });
    expect(api.uploadToPresigned).toHaveBeenCalledTimes(2);
    expect(api.platformDocIntakeCommit).toHaveBeenCalledTimes(1);
    const commitCall = vi.mocked(api.platformDocIntakeCommit).mock.calls[0];
    expect(commitCall[0]).toBe('acme');
    expect(commitCall[1]).toHaveLength(2);
    expect(commitCall[1].every((i) => i.clubId === 'phsob')).toBe(true);
  });

  it('surfaces a per-row upload failure with a retry action', async () => {
    const user = userEvent.setup();
    renderWizard();

    await screen.findByRole('heading', { name: /bulk document/i });
    const folderInput = document.querySelector('input[webkitdirectory]') as HTMLInputElement;
    pickFolder(folderInput, [folderFile('Pack/PHSOB/2026 Club League Entry.pdf')]);
    await screen.findByText(/1 file/i);
    await user.click(screen.getByRole('button', { name: /continue to matching/i }));
    await screen.findByText('Ready');
    await user.click(screen.getByRole('button', { name: /continue to upload/i }));

    vi.mocked(api.platformDocIntakePresign).mockResolvedValue({
      items: [
        { ok: true, uploadUrl: 'https://s3/1', objectKey: 'k1', contentType: 'application/pdf' },
      ],
    });
    vi.mocked(api.uploadToPresigned).mockRejectedValueOnce(new Error('network down'));

    await user.click(screen.getByRole('button', { name: /start upload/i }));

    await screen.findByRole('button', { name: /retry/i });
    expect(api.platformDocIntakeCommit).not.toHaveBeenCalled();
  });

  it('falls back to the default catalogue for a tenant that has never saved requiredDocs', async () => {
    // GET /platform/tenants/:slug returns the raw config row — no requiredDocs field at
    // all for a tenant (like every tenant today) that's never explicitly customized its
    // catalogue. Without a client-side fallback to DEFAULT_REQUIRED_DOCS, pickableDocs is
    // empty and every row is unmatched-doc with nothing to pick — the wizard is a dead end.
    const user = userEvent.setup();
    vi.mocked(api.platformGetTenant).mockResolvedValue({
      tenant: 'acme',
      branding: { name: 'Acme Union' },
      districts: ['Central'],
    } as unknown as TenantConfig);
    renderWizard();

    await screen.findByRole('heading', { name: /bulk document/i });
    const folderInput = document.querySelector('input[webkitdirectory]') as HTMLInputElement;
    // "Club Constitution" matches DEFAULT_REQUIRED_DOCS' `constitution` entry by doc name
    // (it carries no matchHints — the fallback name/key scoring is what has to work here).
    pickFolder(folderInput, [folderFile('Pack/PHSOB/Club Constitution.pdf')]);
    await screen.findByText(/1 file/i);
    await user.click(screen.getByRole('button', { name: /continue to matching/i }));

    const row = (await screen.findByText('Club Constitution.pdf')).closest('tr')!;
    expect(within(row).getByText('Ready')).toBeInTheDocument();
    expect(within(row).getByDisplayValue('Club Constitution')).toBeInTheDocument();
  });

  it('defaults a row to excluded, under "needs attention", when the club already has that single-file doc', async () => {
    const user = userEvent.setup();
    vi.mocked(api.platformTenantOverview).mockResolvedValue({
      ...overview,
      clubs: [{ ...overview.clubs[0], docs: { leagueEntry: true } }],
    } as unknown as TenantOverview);
    renderWizard();

    await screen.findByRole('heading', { name: /bulk document/i });
    const folderInput = document.querySelector('input[webkitdirectory]') as HTMLInputElement;
    pickFolder(folderInput, [folderFile('Pack/PHSOB/2026 Club League Entry.pdf')]);
    await screen.findByText(/1 file/i);
    await user.click(screen.getByRole('button', { name: /continue to matching/i }));

    // Matched fine, but PHSOB already has leagueEntry on file — committing would S3-delete
    // it, so the row must NOT be included (and thus not committable) by default.
    const row = (await screen.findByText('2026 Club League Entry.pdf')).closest('tr')!;
    expect(within(row).getByText(/already uploaded/i)).toBeInTheDocument();
    expect(within(row).getByText('Excluded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue to upload/i })).toHaveTextContent(
      '0 files',
    );

    // The operator can still consciously opt in.
    await user.click(within(row).getByRole('button', { name: /include anyway/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /continue to upload/i })).toHaveTextContent(
        '1 file',
      ),
    );
  });
});

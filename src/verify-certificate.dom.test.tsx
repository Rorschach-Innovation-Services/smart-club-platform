/**
 * VerifyCertificatePage — the public page behind a transfer certificate's QR code. The
 * registry answer drives one of three banners; a revoked certificate must show status and
 * dates only (the API returns no player/club data for it, and the page must not imply any).
 *
 * `fetch` is stubbed rather than the api module, so the real client path runs — including
 * that the call goes out unauthenticated.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { VerifyCertificatePage } from './VerifyCertificatePage';
import { renderWithProviders } from './test-utils';

const SERIAL = 'SC-TRF-AAAAA-BBBBB-CCCCC-DDDDD';

const stubFetch = (status: number, body: unknown) => {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const renderAt = (serial: string | null = SERIAL) =>
  renderWithProviders(
    <MemoryRouter initialEntries={[serial == null ? '/verify' : `/verify/${serial}`]}>
      <Routes>
        <Route path="/verify" element={<VerifyCertificatePage />} />
        <Route path="/verify/:serial" element={<VerifyCertificatePage />} />
      </Routes>
    </MemoryRouter>,
  );

const PDF_BYTES = '%PDF-1.7 issued certificate bytes';
const PDF_SHA256 = createHash('sha256').update(PDF_BYTES).digest('hex');

const validBody = (overrides: Record<string, unknown> = {}) => ({
  serial: SERIAL,
  status: 'valid',
  issuedAt: '2026-09-01T10:00:00.000Z',
  playerName: 'Sipho Ndlovu',
  idNumberMasked: '01********088',
  fromClubName: 'Berea CC',
  toClubName: 'UKZN CC',
  effectiveDate: '2026-09-01',
  orgName: 'KZN Cricket Union',
  tenantBranding: { name: 'KZN Cricket Union', logoUrl: '', colors: {} },
  signedPayload: 'x.y.z',
  publicKeyPem: '-----BEGIN PUBLIC KEY-----',
  sha256: PDF_SHA256,
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('VerifyCertificatePage', () => {
  it('shows VALID with the details checklist for a valid certificate', async () => {
    const fetchMock = stubFetch(200, validBody());
    renderAt();

    expect(await screen.findByText(/valid certificate/i)).toBeVisible();
    expect(screen.getByText(/confirm these details match the certificate/i)).toBeVisible();
    expect(screen.getByText('Sipho Ndlovu')).toBeVisible();
    expect(screen.getByText('01********088')).toBeVisible();
    expect(screen.getByText('Berea CC')).toBeVisible();
    expect(screen.getByText('UKZN CC')).toBeVisible();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/verify/${SERIAL}`);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-dev-auth']).toBeUndefined();
  });

  it('shows REVOKED with status and dates only', async () => {
    stubFetch(200, {
      serial: SERIAL,
      status: 'revoked',
      issuedAt: '2026-09-01T10:00:00.000Z',
      revokedAt: '2026-09-05T10:00:00.000Z',
    });
    renderAt();

    expect(await screen.findByText(/certificate revoked/i)).toBeVisible();
    expect(screen.getByText(/date revoked/i)).toBeVisible();
    expect(screen.queryByText(/confirm these details/i)).toBeNull();
  });

  it('shows NOT FOUND for an unknown serial', async () => {
    stubFetch(404, { error: 'not found' });
    renderAt('SC-TRF-NOPE');

    expect(await screen.findByText(/certificate not found/i)).toBeVisible();
    expect(screen.getByText('SC-TRF-NOPE')).toBeVisible();
    // The reference box is offered straight away, pre-filled with what was tried.
    expect(screen.getByLabelText('Certificate reference')).toHaveValue('SC-TRF-NOPE');
  });

  it('bare /verify asks for the reference and looks it up on submit', async () => {
    const fetchMock = stubFetch(200, validBody());
    renderAt(null);

    expect(screen.getByRole('heading', { name: 'Check a certificate' })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    const submit = screen.getByRole('button', { name: 'Check certificate' });
    expect(submit).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Certificate reference'), `  ${SERIAL} `);
    await user.click(submit);

    expect(await screen.findByText(/valid certificate/i)).toBeVisible();
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain(`/verify/${SERIAL}`);
    expect(screen.getByRole('link', { name: 'Check another certificate' })).toHaveAttribute(
      'href',
      '/verify',
    );
  });

  describe('Check the PDF file', () => {
    const pick = async (bytes: string, name = 'certificate.pdf') => {
      const user = userEvent.setup();
      const file = new File([bytes], name, { type: 'application/pdf' });
      await user.upload(screen.getByLabelText('Certificate PDF'), file);
    };

    it('confirms the exact issued file when the local SHA-256 matches', async () => {
      // Upper-case on the wire still matches: hex compare is case-insensitive.
      stubFetch(200, validBody({ sha256: PDF_SHA256.toUpperCase() }));
      renderAt();
      expect(await screen.findByRole('heading', { name: 'Check the PDF file' })).toBeVisible();
      expect(screen.getByText(/the file never leaves your device/i)).toBeVisible();

      await pick(PDF_BYTES);

      expect(await screen.findByText('Exact file we issued')).toBeVisible();
      expect(screen.queryByText('Not the issued file')).toBeNull();
    });

    it('flags a different file as not the issued one', async () => {
      stubFetch(200, validBody());
      renderAt();
      await screen.findByRole('heading', { name: 'Check the PDF file' });

      await pick(PDF_BYTES + ' (re-saved)', 'copy.pdf');

      expect(await screen.findByText('Not the issued file')).toBeVisible();
      expect(
        screen.getByText(/digital copies of the certificate should be byte-identical/i),
      ).toBeVisible();
      expect(screen.queryByText('Exact file we issued')).toBeNull();
    });

    it('is not offered when the registry returns no hash', async () => {
      stubFetch(200, validBody({ sha256: undefined }));
      renderAt();
      expect(await screen.findByText(/valid certificate/i)).toBeVisible();
      expect(screen.queryByRole('heading', { name: 'Check the PDF file' })).toBeNull();
    });
  });
});

/**
 * Public registration page under a closed transfer window: the SERVER-computed status (on the
 * tenant payload) drives a notice before submit, and a 201 carrying `transferWindow` shows the
 * "recorded, not registered" outcome instead of the clearance-pending one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderWithProviders } from './test-utils';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    getRegistration: vi.fn(),
    submitRegistration: vi.fn(),
    getRegistrationIdDocUploadUrl: vi.fn(),
    uploadToPresigned: vi.fn(),
  };
});

import { RegisterPage } from './RegisterPage';
import {
  getRegistration,
  submitRegistration,
  getRegistrationIdDocUploadUrl,
  uploadToPresigned,
} from './api';
import { qk } from './query';

const ID_A = '9501015009085';
const winter = { label: 'Winter', start: '2026-11-01', end: '2026-11-30' };

function renderPage(tenantPayload: Record<string, unknown>) {
  return renderWithProviders(
    <MemoryRouter initialEntries={['/register/alpha?t=tok']}>
      <Routes>
        <Route path="/register/:clubId" element={<RegisterPage />} />
      </Routes>
    </MemoryRouter>,
    { seed: [[qk.tenant(), tenantPayload]] },
  );
}

async function fillAndSubmit(r: ReturnType<typeof renderPage>) {
  const change = (label: RegExp, value: string) =>
    fireEvent.change(r.getByLabelText(label), { target: { value } });
  change(/^District/, 'North');
  change(/^Team/, 'premier');
  change(/^Surname/, 'Ndlovu');
  change(/^First name\(s\)/, 'Sipho');
  change(/^ID number/, ID_A);
  change(/^Race/, 'African');
  change(/^Gender/, 'Male');
  change(/^Phone/, '0821234567');
  change(/^Club for which last registered/, 'beta');
  const file = new File(['x'], 'id.pdf', { type: 'application/pdf' });
  fireEvent.change(r.container.querySelector('#reg-id-file')!, { target: { files: [file] } });
  fireEvent.click(r.getByRole('checkbox', { name: /I request to register/ }));
  fireEvent.click(r.getByRole('button', { name: 'Register' }));
}

describe('RegisterPage — transfer windows', () => {
  beforeEach(() => {
    vi.mocked(getRegistration)
      .mockReset()
      .mockResolvedValue({
        clubName: 'Alpha CC',
        leagues: [{ key: 'premier', label: 'Premier League', district: 'All districts' }],
        districts: ['North', 'South'],
        clubs: [{ id: 'beta', name: 'Beta CC' }],
      } as never);
    vi.mocked(getRegistrationIdDocUploadUrl)
      .mockReset()
      .mockResolvedValue({
        uploadUrl: 'https://s3/put',
        objectKey: 'k',
        contentType: 'application/pdf',
      } as never);
    vi.mocked(uploadToPresigned)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.mocked(submitRegistration).mockReset();
  });

  it('warns before submit when the server says transfers are closed', async () => {
    const r = renderPage({ transferWindowStatus: { open: false, next: winter } });
    await r.findByText(/Register as a player/);
    expect(r.getByText(/Transfers between clubs are currently closed/)).toHaveTextContent(
      'the next window opens 1 Nov 2026 (Winter)',
    );
  });

  it('shows no notice while open or when no windows are configured', async () => {
    const r = renderPage({ transferWindowStatus: { open: true, current: winter } });
    await r.findByText(/Register as a player/);
    expect(r.queryByText(/currently closed/)).toBeNull();
  });

  it('a 201 with transferWindow shows "recorded — transfers are closed", not clearance pending', async () => {
    vi.mocked(submitRegistration).mockResolvedValue({
      ok: true,
      transferWindow: { closed: true, nextWindow: winter },
    } as never);
    const r = renderPage({ transferWindowStatus: { open: false, next: winter } });
    await r.findByText(/Register as a player/);
    await fillAndSubmit(r);
    await waitFor(() =>
      expect(r.getByText('Registration recorded — transfers are closed')).toBeInTheDocument(),
    );
    expect(r.getByText(/you have not been registered with Alpha CC/)).toHaveTextContent(
      'until 1 Nov 2026 (Winter)',
    );
    expect(r.queryByText(/clearance pending/i)).toBeNull();
  });
});

/**
 * Public registration page under a closed registration window (ADR 0017, revised): the
 * SERVER-computed status (on the tenant payload) replaces the form with a closed page —
 * whatever the clearances module says — and a submit that races a window closing (the server's
 * structured 409) lands on the same honest page. Nothing is ever "recorded" while closed.
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
  ApiError,
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

  it('shows the closed page instead of the form, naming the next window', async () => {
    const r = renderPage({ transferWindowStatus: { open: false, next: winter } });
    await r.findByText('Player registration is closed');
    expect(r.queryByRole('button', { name: 'Register' })).toBeNull();
    expect(r.getByText(/next registration window/)).toHaveTextContent(
      'The next registration window, Winter, runs from 1 Nov 2026 to 30 Nov 2026.',
    );
    expect(r.getByText(/Nothing has been submitted or recorded/)).toBeInTheDocument();
    expect(r.queryByText(/recorded but|will be recorded|has been notified/)).toBeNull();
  });

  it('says so when no upcoming window is configured', async () => {
    const r = renderPage({ transferWindowStatus: { open: false } });
    await r.findByText('Player registration is closed');
    expect(r.getByText(/No upcoming registration window/)).toBeInTheDocument();
  });

  it('shows the closed page with the clearances module off too', async () => {
    const r = renderPage({
      features: { 'module.clearances': false },
      transferWindowStatus: { open: false, next: winter },
    });
    await r.findByText('Player registration is closed');
    expect(r.queryByRole('button', { name: 'Register' })).toBeNull();
  });

  it('shows the form while open or when no windows are configured', async () => {
    const r = renderPage({ transferWindowStatus: { open: true, current: winter } });
    await r.findByText(/Register as a player/);
    expect(r.queryByText('Player registration is closed')).toBeNull();
    const none = renderPage({});
    await none.findAllByText(/Register as a player/);
  });

  it('a submit that races a close (structured 409) lands on the closed page', async () => {
    vi.mocked(submitRegistration).mockRejectedValue(
      new ApiError(409, 'player registration is closed — next window: Winter', undefined, {
        transferWindow: { closed: true, nextWindow: winter },
      }),
    );
    const r = renderPage({ transferWindowStatus: { open: true, current: winter } });
    await r.findByText(/Register as a player/);
    await fillAndSubmit(r);
    await r.findByText('Player registration is closed');
    expect(r.getByText(/Nothing has been submitted or recorded/)).toHaveTextContent(
      'any document you attached was discarded',
    );
    expect(r.queryByText(/already registered/)).toBeNull();
  });
});

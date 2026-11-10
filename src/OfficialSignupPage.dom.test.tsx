/**
 * Public official self-registration (`/officials/register?t=…`): role-specific fields, the
 * client-side checks that mirror the server, the body sent, and the invalid / done / 429
 * screens. Only the HTTP client is mocked; the tenant payload is seeded into the real cache.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderWithProviders } from './test-utils';
import { qk } from './query';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    getTenant: vi.fn(async () => ({})),
    getOfficialSignup: vi.fn(),
    submitOfficialSignup: vi.fn(),
  };
});

import { OfficialSignupPage } from './OfficialSignupPage';
import { ApiError, getOfficialSignup, submitOfficialSignup } from './api';

function renderPage(url = '/officials/register?t=tok') {
  const user = userEvent.setup();
  renderWithProviders(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/officials/register" element={<OfficialSignupPage />} />
      </Routes>
    </MemoryRouter>,
    { seed: [[qk.tenant(), {}]] },
  );
  return { user };
}

const asRole = (role: 'umpire' | 'scorer') =>
  vi.mocked(getOfficialSignup).mockResolvedValue({ role, tenantName: 'KZN Dolphins' });

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/First names/), '  Andile  Sipho ');
  await user.type(screen.getByLabelText(/Surname/), 'Ngubane');
  await user.type(screen.getByLabelText(/Cell phone/), '082 123 4567');
}

describe('OfficialSignupPage', () => {
  beforeEach(() => {
    vi.mocked(getOfficialSignup).mockReset();
    vi.mocked(submitOfficialSignup).mockReset();
  });

  it('umpire link: umpire heading and the four umpire fields only', async () => {
    asRole('umpire');
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Umpire registration' })).toBeTruthy();
    expect(getOfficialSignup).toHaveBeenCalledWith('tok');
    for (const l of [/First names/, /Surname/, /Cell phone/, /^Email/])
      expect(screen.getByLabelText(l)).toBeTruthy();
    expect(screen.queryByLabelText('ID number')).toBeNull();
    expect(screen.queryByLabelText('Emergency contact number')).toBeNull();
    expect(screen.queryByLabelText('Home address')).toBeNull();
  });

  it('scorer link: adds ID number, emergency contact and home address, and sends them', async () => {
    asRole('scorer');
    vi.mocked(submitOfficialSignup).mockResolvedValue({ ok: true });
    const { user } = renderPage();
    expect(await screen.findByRole('heading', { name: 'Scorer registration' })).toBeTruthy();
    await fillRequired(user);
    await user.type(screen.getByLabelText(/^Email/), ' andile@example.org ');
    await user.type(screen.getByLabelText('ID number'), '9001015009087');
    await user.type(screen.getByLabelText('Emergency contact number'), '+27 83 555 0001');
    await user.type(screen.getByLabelText('Home address'), '1  Test Road, Durban');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Register' }));
    expect(submitOfficialSignup).toHaveBeenCalledWith('tok', {
      firstNames: 'Andile Sipho',
      surname: 'Ngubane',
      phone: '0821234567',
      email: 'andile@example.org',
      consent: true,
      idNumber: '9001015009087',
      emergencyPhone: '0835550001',
      address: '1 Test Road, Durban',
    });
  });

  it('requires names, a valid SA cell and consent before sending anything', async () => {
    asRole('umpire');
    const { user } = renderPage();
    await screen.findByRole('heading', { name: 'Umpire registration' });
    await user.click(screen.getByRole('button', { name: 'Register' }));
    expect(screen.getByText('Enter your first names.')).toBeTruthy();
    expect(screen.getByText('Enter your surname.')).toBeTruthy();
    expect(screen.getByText('Enter your cell number.')).toBeTruthy();
    expect(screen.getByText('Tick the consent box to continue.')).toBeTruthy();
    await user.type(screen.getByLabelText(/First names/), 'Andile');
    await user.type(screen.getByLabelText(/Surname/), 'Ngubane');
    await user.type(screen.getByLabelText(/Cell phone/), '12345');
    await user.click(screen.getByRole('button', { name: 'Register' }));
    expect(screen.getByText(/Enter a South African cell number/)).toBeTruthy();
    expect(screen.getByText('Tick the consent box to continue.')).toBeTruthy();
    expect(submitOfficialSignup).not.toHaveBeenCalled();
    // Names are capped at the server's 60 characters.
    expect(screen.getByLabelText(/First names/).getAttribute('maxlength')).toBe('60');
  });

  it('umpire submit sends only the umpire fields, then shows the review notice', async () => {
    asRole('umpire');
    vi.mocked(submitOfficialSignup).mockResolvedValue({ ok: true });
    const { user } = renderPage();
    await screen.findByRole('heading', { name: 'Umpire registration' });
    await fillRequired(user);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Register' }));
    expect(submitOfficialSignup).toHaveBeenCalledWith('tok', {
      firstNames: 'Andile Sipho',
      surname: 'Ngubane',
      phone: '0821234567',
      consent: true,
    });
    expect(await screen.findByRole('heading', { name: 'Registration received' })).toBeTruthy();
    expect(screen.getByText(/review them before you are appointed/)).toBeTruthy();
    expect(screen.queryByText(/already/i)).toBeNull();
  });

  it('a bad or revoked link shows the invalid screen with guidance', async () => {
    vi.mocked(getOfficialSignup).mockRejectedValue(new ApiError(404, 'invalid signup link'));
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Link not valid' })).toBeTruthy();
    expect(screen.getByText(/Ask the union office for the current link/)).toBeTruthy();
  });

  it('no token at all is invalid without a request', async () => {
    renderPage('/officials/register');
    expect(await screen.findByRole('heading', { name: 'Link not valid' })).toBeTruthy();
    expect(getOfficialSignup).not.toHaveBeenCalled();
  });

  it('429 asks them to try later; a server 400 message shows inline', async () => {
    asRole('umpire');
    vi.mocked(submitOfficialSignup)
      .mockRejectedValueOnce(new ApiError(429, 'too many'))
      .mockRejectedValueOnce(new ApiError(400, 'phone must be a South African cell number'));
    const { user } = renderPage();
    await screen.findByRole('heading', { name: 'Umpire registration' });
    await fillRequired(user);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Register' }));
    expect(await screen.findByText(/Too many submissions right now/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Register' }));
    expect(await screen.findByText('phone must be a South African cell number')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Registration received' })).toBeNull();
  });

  it('a network error or 5xx on load offers Retry instead of "Link not valid"', async () => {
    vi.mocked(getOfficialSignup)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new ApiError(503, 'unavailable'))
      .mockResolvedValueOnce({ role: 'umpire', tenantName: 'KZN Dolphins' });
    const { user } = renderPage();
    expect(await screen.findByText(/We couldn.t load this page/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Link not valid' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/We couldn.t load this page/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Umpire registration' })).toBeTruthy();
    expect(getOfficialSignup).toHaveBeenCalledTimes(3);
  });

  it('a 400 from the GET is an invalid link', async () => {
    vi.mocked(getOfficialSignup).mockRejectedValue(new ApiError(400, 'missing token'));
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Link not valid' })).toBeTruthy();
  });
});

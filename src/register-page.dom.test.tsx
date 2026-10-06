/**
 * Public registration page — the optional cricket playing profile. Nothing the player
 * didn't pick may be sent (an untouched form used to submit "Right / Right / Mid Order").
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

// Luhn-valid RSA ID, dob 1995-01-01 (an adult — no guardian needed).
const ID_A = '9501015009085';
const seed: Array<[readonly unknown[], unknown]> = [[qk.tenant(), {}]];

function renderPage() {
  return renderWithProviders(
    <MemoryRouter initialEntries={['/register/alpha?t=tok']}>
      <Routes>
        <Route path="/register/:clubId" element={<RegisterPage />} />
      </Routes>
    </MemoryRouter>,
    { seed },
  );
}

async function fillRequired(r: ReturnType<typeof renderPage>) {
  await r.findByText(/Register as a player/);
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
  const file = new File(['x'], 'id.pdf', { type: 'application/pdf' });
  fireEvent.change(r.container.querySelector('#reg-id-file')!, { target: { files: [file] } });
  fireEvent.click(r.getByRole('checkbox', { name: /I request to register/ }));
}

describe('RegisterPage — cricket playing profile', () => {
  beforeEach(() => {
    vi.mocked(getRegistration)
      .mockReset()
      .mockResolvedValue({
        clubName: 'Alpha CC',
        leagues: [{ key: 'premier', label: 'Premier League', district: 'All districts' }],
        districts: ['North', 'South'],
        clubs: [],
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
    vi.mocked(submitRegistration)
      .mockReset()
      .mockResolvedValue({} as never);
  });

  it('sends no batting/bowling profile the player left unset', async () => {
    const r = renderPage();
    await fillRequired(r);
    // Batting and bowling hand each start on "Not set", not on a pre-picked hand.
    const unset = r.getAllByRole('button', { name: '— Not set —' });
    expect(unset).toHaveLength(2);
    unset.forEach((b) => expect(b).toHaveClass('on'));
    fireEvent.click(r.getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(submitRegistration).toHaveBeenCalled());
    const body = vi.mocked(submitRegistration).mock.calls[0][2] as Record<string, unknown>;
    for (const k of ['battingHand', 'bowlingHand', 'battingType', 'bowlerType'])
      expect(body[k]).toBeUndefined();
    // The checkboxes are always answered, so they still send their value.
    expect(body).toMatchObject({ isAllRounder: false, isWk: false });
  });

  it('sends only the profile fields the player picked', async () => {
    const r = renderPage();
    await fillRequired(r);
    // The first "Left hander" is batting hand (bowling hand follows it).
    fireEvent.click(r.getAllByRole('button', { name: 'Left hander' })[0]);
    fireEvent.change(r.getByLabelText(/^Batting type/), { target: { value: 'Top Order' } });
    fireEvent.click(r.getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(submitRegistration).toHaveBeenCalled());
    const body = vi.mocked(submitRegistration).mock.calls[0][2] as Record<string, unknown>;
    expect(body).toMatchObject({ battingHand: 'Left', battingType: 'Top Order' });
    expect(body.bowlingHand).toBeUndefined();
  });
});

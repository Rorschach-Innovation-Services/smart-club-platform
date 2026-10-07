/**
 * Chair-led player registration (club portal): the single Register-player form and the
 * quick-add grid. Drives the real components through `renderWithProviders`, mocking only the
 * HTTP boundary (`./api`). A `.dom.` suite because club.tsx (mounted for the Players-page
 * entry-point test) imports leaflet, which reads `window` at module load.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from './test-utils';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    registerPlayer: vi.fn(),
    registerPlayersBatch: vi.fn(),
    getPlayerIdDocUploadUrl: vi.fn(),
    markPlayerIdDoc: vi.fn(),
    uploadToPresigned: vi.fn(),
    getClubDirectory: vi.fn(async () => [
      { id: 'alpha', name: 'Alpha CC' },
      { id: 'beta', name: 'Beta CC' },
    ]),
    getVeteransAffiliates: vi.fn(async () => []),
  };
});

import {
  RegisterPlayerForm,
  QuickAddPlayersGrid,
  saIdValid,
  gridRowProblem,
  registerOutcomeMessage,
  BulkOutcomePill,
} from './club-register';
import { ClubPlayersView } from './club';
import {
  registerPlayer,
  registerPlayersBatch,
  getPlayerIdDocUploadUrl,
  markPlayerIdDoc,
  uploadToPresigned,
  ApiError,
} from './api';
import { qk } from './query';

// Luhn-valid RSA IDs (dob 1995-01-01 / 2001-01-01 — the latter a minor only after 2019, so
// both read as adults today).
const ID_A = '9501015009085';
const ID_B = '0101015009083';
const club = { id: 'alpha', name: 'Alpha CC', district: 'North' };
const leagues = [
  { key: 'premier', label: 'Premier League', district: 'All districts' },
  { key: 'north-u13', label: 'North U13', district: 'North' },
];
const seed: Array<[readonly unknown[], unknown]> = [[qk.tenant(), {}]];

function renderForm(over: Record<string, unknown> = {}) {
  const props = {
    toast: vi.fn(),
    onDone: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  const r = renderWithProviders(
    <RegisterPlayerForm club={club} leagues={leagues} districts={['North', 'South']} {...props} />,
    { seed },
  );
  return { ...r, ...props };
}

function fillRequired(get: (label: string) => HTMLElement) {
  fireEvent.change(get('Team'), { target: { value: 'premier' } });
  fireEvent.change(get('First name(s)'), { target: { value: 'Sipho' } });
  fireEvent.change(get('Surname'), { target: { value: 'Ndlovu' } });
  fireEvent.change(get('ID number'), { target: { value: ID_A } });
  fireEvent.change(get('Race'), { target: { value: 'African' } });
  fireEvent.change(get('Gender'), { target: { value: 'Male' } });
  fireEvent.change(get('Cell'), { target: { value: '0821234567' } });
}

function player(over: Record<string, unknown> = {}) {
  return {
    naturalKey: 'nk-sipho',
    firstName: 'Sipho',
    lastName: 'Ndlovu',
    outcome: 'created',
    ...over,
  };
}

describe('saIdValid', () => {
  it('accepts a Luhn-valid ID with a real birth date', () => {
    expect(saIdValid(ID_A)).toBe(true);
    expect(saIdValid(ID_B)).toBe(true);
  });
  it('rejects a bad check digit, a short number and an impossible date', () => {
    expect(saIdValid('9501015009086')).toBe(false);
    expect(saIdValid('950101500908')).toBe(false);
    expect(saIdValid('9513015009085')).toBe(false);
  });
});

describe('registerOutcomeMessage', () => {
  it('names the source club for a clearance and the union office for a review', () => {
    expect(
      registerOutcomeMessage(
        player({
          outcome: 'clearance-opened',
          clearance: { id: 'c1', fromClubId: 'beta', fromClubName: 'Beta CC' },
        }) as never,
      ),
    ).toMatch(/clearance was opened from Beta CC/);
    expect(
      registerOutcomeMessage(player({ outcome: 'review-opened' }) as never, 'Old Boys'),
    ).toMatch(/Old Boys isn’t on the system.*union office/);
    expect(registerOutcomeMessage(player() as never)).toBe('Sipho Ndlovu registered.');
  });

  it('appends the soft possible-existing-registration warning', () => {
    expect(
      registerOutcomeMessage(player({ possibleExistingAt: ['Kloof CC', 'Savages CC'] }) as never),
    ).toBe(
      'Sipho Ndlovu registered. Possible existing registration at Kloof CC, Savages CC — check it isn’t the same person under another ID.',
    );
  });
});

describe('RegisterPlayerForm', () => {
  beforeEach(() => {
    vi.mocked(registerPlayer).mockReset();
    vi.mocked(getPlayerIdDocUploadUrl).mockReset();
    vi.mocked(markPlayerIdDoc).mockReset();
    vi.mocked(uploadToPresigned).mockReset();
  });

  it('keeps Register disabled until the required fields are filled', () => {
    const { getByRole, getByLabelText } = renderForm();
    const submit = getByRole('button', { name: /register player/i });
    expect(submit).toBeDisabled();
    fillRequired(getByLabelText);
    expect(submit).toBeEnabled();
  });

  it('flags an RSA ID that fails its check digit', () => {
    const { getByRole, getByLabelText, getByText } = renderForm();
    fillRequired(getByLabelText);
    fireEvent.change(getByLabelText('ID number'), { target: { value: '9501015009086' } });
    expect(getByText('Not a valid RSA ID number.')).toBeInTheDocument();
    expect(getByRole('button', { name: /register player/i })).toBeDisabled();
  });

  it('sends a picked previous club by id and toasts the clearance it opened', async () => {
    vi.mocked(registerPlayer).mockResolvedValue(
      player({
        outcome: 'clearance-opened',
        clearance: { id: 'c1', fromClubId: 'beta', fromClubName: 'Beta CC' },
      }) as never,
    );
    const { getByRole, getByLabelText, findByRole, toast, onDone } = renderForm();
    fillRequired(getByLabelText);
    // The directory loads async; Beta is offered, the chair's own club is not.
    const prev = getByLabelText('Club last registered for');
    await findByRole('option', { name: 'Beta CC' });
    expect(within(prev).queryByRole('option', { name: 'Alpha CC' })).toBeNull();
    fireEvent.change(prev, { target: { value: 'beta' } });
    fireEvent.click(getByRole('button', { name: /register player/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const body = vi.mocked(registerPlayer).mock.calls[0][1];
    expect(vi.mocked(registerPlayer).mock.calls[0][0]).toBe('alpha');
    expect(body).toMatchObject({
      firstName: 'Sipho',
      lastName: 'Ndlovu',
      idNumber: ID_A,
      team: 'premier',
      district: 'North',
      lastClubId: 'beta',
    });
    expect(body).not.toHaveProperty('lastClub');
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/clearance was opened from Beta CC/));
  });

  it('sends a typed off-system club and explains the union review', async () => {
    vi.mocked(registerPlayer).mockResolvedValue(player({ outcome: 'review-opened' }) as never);
    const { getByRole, getByLabelText, toast, onDone } = renderForm();
    fillRequired(getByLabelText);
    fireEvent.change(getByLabelText('Club last registered for'), {
      target: { value: '__other__' },
    });
    expect(getByRole('button', { name: /register player/i })).toBeDisabled();
    fireEvent.change(getByLabelText('Previous club name'), { target: { value: 'Old Boys' } });
    fireEvent.click(getByRole('button', { name: /register player/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(vi.mocked(registerPlayer).mock.calls[0][1]).toMatchObject({ lastClub: 'Old Boys' });
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/Old Boys isn’t on the system.*union office/),
    );
  });

  it('sends no cricket profile the chair did not fill in, and only what they picked', async () => {
    vi.mocked(registerPlayer).mockResolvedValue(player() as never);
    const first = renderForm();
    fillRequired(first.getByLabelText);
    fireEvent.click(first.getByRole('button', { name: /register player/i }));
    await waitFor(() => expect(first.onDone).toHaveBeenCalled());
    const untouched = vi.mocked(registerPlayer).mock.calls[0][1];
    for (const k of ['battingHand', 'bowlingHand', 'battingType', 'bowlerType'])
      expect(untouched).not.toHaveProperty(k);
    first.unmount();

    const second = renderForm();
    fillRequired(second.getByLabelText);
    fireEvent.change(second.getByLabelText('Batting hand'), { target: { value: 'Left' } });
    fireEvent.click(second.getByRole('button', { name: /register player/i }));
    await waitFor(() => expect(second.onDone).toHaveBeenCalled());
    const picked = vi.mocked(registerPlayer).mock.calls[1][1];
    expect(picked).toMatchObject({ battingHand: 'Left' });
    expect(picked).not.toHaveProperty('battingType');
  });

  it('shows a 409 inline and stays open', async () => {
    vi.mocked(registerPlayer).mockRejectedValue(
      new ApiError(409, 'a player with these details is already registered for this club'),
    );
    const { getByRole, getByLabelText, findByRole, onDone } = renderForm();
    fillRequired(getByLabelText);
    fireEvent.click(getByRole('button', { name: /register player/i }));
    expect(await findByRole('alert')).toHaveTextContent(/already registered for this club/);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('uploads the ID document after the create, against the new natural key', async () => {
    vi.mocked(registerPlayer).mockResolvedValue(player() as never);
    vi.mocked(getPlayerIdDocUploadUrl).mockResolvedValue({
      uploadUrl: 'https://s3/put',
      objectKey: 'k/obj.pdf',
      contentType: 'application/pdf',
    });
    vi.mocked(uploadToPresigned).mockResolvedValue(undefined as never);
    vi.mocked(markPlayerIdDoc).mockResolvedValue({} as never);
    const { getByRole, getByLabelText, onDone } = renderForm();
    fillRequired(getByLabelText);
    const file = new File(['%PDF'], 'id.pdf', { type: 'application/pdf' });
    fireEvent.change(getByLabelText('ID document'), { target: { files: [file] } });
    fireEvent.click(getByRole('button', { name: /register player/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(getPlayerIdDocUploadUrl).toHaveBeenCalledWith('alpha', 'nk-sipho', 'application/pdf');
    expect(uploadToPresigned).toHaveBeenCalledWith('https://s3/put', file, 'application/pdf');
    expect(markPlayerIdDoc).toHaveBeenCalledWith('alpha', 'nk-sipho', {
      objectKey: 'k/obj.pdf',
      size: file.size,
      contentType: 'application/pdf',
    });
  });

  it('asks for a guardian when the passport date of birth makes the player a minor', () => {
    const { getByLabelText, queryByLabelText } = renderForm();
    fireEvent.change(getByLabelText('ID type'), { target: { value: 'passport' } });
    expect(queryByLabelText('Parent / guardian name')).toBeNull();
    const year = new Date().getFullYear() - 10;
    fireEvent.change(getByLabelText('Date of birth'), { target: { value: `${year}-03-01` } });
    expect(getByLabelText('Parent / guardian name')).toBeInTheDocument();
  });
});

describe('gridRowProblem', () => {
  const row = (over: Record<string, unknown>) =>
    ({
      key: 1,
      firstName: 'A',
      lastName: 'B',
      idType: 'sa-id',
      idNumber: ID_A,
      dob: '',
      nationality: '',
      gender: '',
      team: '',
      ...over,
    }) as never;
  it('requires names, a valid SA ID, or passport + dob + nationality', () => {
    expect(gridRowProblem(row({}))).toBe('');
    expect(gridRowProblem(row({ lastName: ' ' }))).toMatch(/surname/);
    expect(gridRowProblem(row({ idNumber: '123' }))).toMatch(/RSA ID/);
    expect(gridRowProblem(row({ idType: 'passport', idNumber: 'P1' }))).toMatch(/date of birth/);
    expect(gridRowProblem(row({ idType: 'passport', idNumber: 'P1', dob: '1990-01-01' }))).toMatch(
      /nationality/,
    );
  });
});

describe('QuickAddPlayersGrid', () => {
  beforeEach(() => vi.mocked(registerPlayersBatch).mockReset());

  function renderGrid() {
    const props = { toast: vi.fn(), onDone: vi.fn(), onCancel: vi.fn() };
    const r = renderWithProviders(
      <QuickAddPlayersGrid club={club} leagues={leagues} {...props} />,
      {
        seed,
      },
    );
    return { ...r, ...props };
  }
  function fillRow(get: (l: string) => HTMLElement, n: number, first: string, id: string) {
    fireEvent.change(get(`Row ${n} first name`), { target: { value: first } });
    fireEvent.change(get(`Row ${n} surname`), { target: { value: 'Dube' } });
    fireEvent.change(get(`Row ${n} ID number`), { target: { value: id } });
  }

  it('blocks the batch while any filled row is invalid', () => {
    const { getByLabelText, getByRole, getByText } = renderGrid();
    fillRow(getByLabelText, 1, 'Ann', '9501015009086');
    expect(getByText('Not a valid RSA ID number.')).toBeInTheDocument();
    expect(getByRole('button', { name: /register 1 player$/i })).toBeDisabled();
  });

  it('sends only the filled rows and badges each with its outcome', async () => {
    vi.mocked(registerPlayersBatch).mockResolvedValue({
      results: [
        { index: 0, outcome: 'created', naturalKey: 'n1' },
        { index: 1, outcome: 'clearance-opened', naturalKey: 'n2', fromClubName: 'Beta CC' },
      ],
      summary: {
        created: 1,
        'clearance-opened': 1,
        'clearance-already-open': 0,
        'skipped-duplicate': 0,
        error: 0,
      },
      playerCount: 2,
    });
    const { getByLabelText, getByRole, findByText, toast } = renderGrid();
    fillRow(getByLabelText, 1, 'Ann', ID_A);
    fireEvent.change(getByLabelText('Row 1 team'), { target: { value: 'north-u13' } });
    fillRow(getByLabelText, 3, 'Ben', ID_B);
    fireEvent.click(getByRole('button', { name: 'Register 2 players' }));
    expect(await findByText('Clearance opened from Beta CC')).toBeInTheDocument();
    expect(await findByText('Registered')).toBeInTheDocument();
    expect(registerPlayersBatch).toHaveBeenCalledWith('alpha', [
      { firstName: 'Ann', lastName: 'Dube', idType: 'sa-id', idNumber: ID_A, team: 'north-u13' },
      { firstName: 'Ben', lastName: 'Dube', idType: 'sa-id', idNumber: ID_B },
    ]);
    expect(toast).toHaveBeenCalledWith('1 registered, 1 clearance opened', 'ok');
    // Settled rows are locked, so nothing is left to send.
    expect(getByLabelText('Row 1 first name')).toBeDisabled();
    expect(getByRole('button', { name: 'Register players' })).toBeDisabled();
    expect(getByRole('button', { name: 'Done' })).toBeEnabled();
  });

  it('keeps an errored row editable so it can be re-sent alone', async () => {
    vi.mocked(registerPlayersBatch)
      .mockResolvedValueOnce({
        results: [
          { index: 0, outcome: 'created', naturalKey: 'n1' },
          { index: 1, outcome: 'error', error: 'unknown team/league "x"' },
        ],
        summary: {
          created: 1,
          'clearance-opened': 0,
          'clearance-already-open': 0,
          'skipped-duplicate': 0,
          error: 1,
        },
        playerCount: 1,
      })
      .mockResolvedValueOnce({
        results: [{ index: 0, outcome: 'created', naturalKey: 'n2' }],
        summary: {
          created: 1,
          'clearance-opened': 0,
          'clearance-already-open': 0,
          'skipped-duplicate': 0,
          error: 0,
        },
        playerCount: 2,
      });
    const { getByLabelText, getByRole, findByText } = renderGrid();
    fillRow(getByLabelText, 1, 'Ann', ID_A);
    fillRow(getByLabelText, 2, 'Ben', ID_B);
    fireEvent.click(getByRole('button', { name: 'Register 2 players' }));
    expect(await findByText('unknown team/league "x"')).toBeInTheDocument();
    expect(getByLabelText('Row 2 first name')).toBeEnabled();
    fireEvent.click(getByRole('button', { name: 'Register 1 player' }));
    await waitFor(() => expect(registerPlayersBatch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(registerPlayersBatch).mock.calls[1][1]).toEqual([
      { firstName: 'Ben', lastName: 'Dube', idType: 'sa-id', idNumber: ID_B },
    ]);
  });
});

describe('ClubPlayersView — chair registration entry points', () => {
  it('opens the Register-player form, quick add and spreadsheet upload from the header', async () => {
    const { getByRole, findByRole, queryByRole } = renderWithProviders(
      <ClubPlayersView
        club={club as never}
        players={[] as never}
        clearances={{ incoming: [], outbound: [] } as never}
        leagues={leagues as never}
        onGenerateLink={vi.fn()}
        onDeletePlayer={vi.fn()}
        toast={vi.fn()}
        veteransRequests={undefined}
        onAcceptVeteransRequest={undefined}
        onDeclineVeteransRequest={undefined}
        busyVeteransId={undefined}
      />,
      { seed },
    );
    fireEvent.click(getByRole('button', { name: 'Register player' }));
    const dialog = await findByRole('dialog');
    expect(within(dialog).getByLabelText('First name(s)')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(queryByRole('dialog')).toBeNull());
    fireEvent.click(getByRole('button', { name: 'Quick add' }));
    expect(
      within(await findByRole('dialog')).getByLabelText('Row 1 first name'),
    ).toBeInTheDocument();
    fireEvent.click(within(getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(queryByRole('dialog')).toBeNull());
    fireEvent.click(getByRole('button', { name: 'Upload spreadsheet' }));
    expect(
      within(await findByRole('dialog')).getByRole('link', { name: /download template/i }),
    ).toHaveAttribute('href', '/roster-template.xlsx');
  });
});

describe('BulkOutcomePill — soft duplicate warning', () => {
  it('a registered row with a same-name+dob match elsewhere carries the note', () => {
    const { getByRole, getByText } = renderWithProviders(
      <BulkOutcomePill
        result={{ index: 0, outcome: 'created', possibleExistingAt: ['Kloof CC'] }}
      />,
    );
    expect(getByText('Registered')).toBeInTheDocument();
    expect(getByRole('note')).toHaveTextContent('Possible existing registration at Kloof CC');
  });

  it('no note without a match', () => {
    const { queryByRole } = renderWithProviders(
      <BulkOutcomePill result={{ index: 0, outcome: 'created' }} />,
    );
    expect(queryByRole('note')).toBeNull();
  });
});

/**
 * Platform → Match library: files are read and checked in the browser, the operator sees what
 * each will do (new, adds ball by ball, duplicate, doesn't add up) before anything is saved,
 * saves go in batches the API accepts, and a match is removed only after a second click.
 * Invented teams and players throughout.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from './api';
import { planImport, readFile, type LibraryMatch } from './match-import';
import { MatchLibraryPage, PLAN_SHORT, SAVE_BATCH } from './platform-match-library';
import { ballByBall, bat, card } from './pro-csv-fixtures';
import { renderWithProviders } from './test-utils';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    platformGetProMatches: vi.fn(),
    platformSaveProMatches: vi.fn(),
    platformDeleteProMatch: vi.fn(),
  };
});

const scorecard = (date: string, total: number) =>
  card({
    date,
    home: 'Highveld Hawks',
    away: 'Coastal Kestrels',
    innings: [
      {
        bat: 'Highveld Hawks',
        label: '1st innings',
        total,
        extras: ['0w, 0nb, 0b, 0lb, 0p', 0],
        batting: bat([['Ann Hawk', 'not out', total, 6, 0, 0, 0]]),
        bowling: `"Ben Kestrel","1","0","${total}","0","${total}.0","0","0","0"`,
        overs: '1',
        fow: '',
      },
    ],
  });
const balls = (date: string, total: number) =>
  ballByBall({
    id: `9/${date}`,
    competition: 'Invented Pro20',
    date,
    teams: ['Highveld Hawks', 'Coastal Kestrels'],
    balls: Array.from({ length: 6 }, (_, k) => [
      1,
      `0.${k + 1}`,
      String(k === 0 ? total : 0),
      'Ann Hawk',
      'Ben Kestrel',
    ]),
  });
const file = (name: string, text: string) => new File([text], name, { type: 'text/csv' });

const setup = (library: LibraryMatch[] = []) => {
  vi.mocked(api.platformGetProMatches).mockResolvedValue(library);
  vi.mocked(api.platformSaveProMatches).mockImplementation(async (ms) => ({
    saved: ms.map((m) => m.key),
  }));
  vi.mocked(api.platformDeleteProMatch).mockImplementation(async (key) => ({ deleted: key }));
  const toast = vi.fn();
  const user = userEvent.setup();
  renderWithProviders(<MatchLibraryPage toast={toast} />);
  return { toast, user };
};

beforeEach(() => vi.clearAllMocks());

describe('Match library', () => {
  it('shows what each file will do before saving, and saves only what is new', async () => {
    const existing = planImport([], [readFile('old.csv', scorecard('2025-10-05', 30))]).save;
    const { user, toast } = setup(existing);
    expect(await screen.findByText(/1 match, 0 with ball by ball/)).toBeTruthy();

    await user.upload(screen.getByLabelText('Choose match files'), [
      file('card-12.csv', scorecard('2025-10-12', 20)),
      file('balls-12.csv', balls('12 Oct 2025', 20)),
      file('again-05.csv', scorecard('2025-10-05', 30)),
      file('notes.txt', 'nothing'),
    ]);

    const plan = await screen.findByRole('table', { name: 'What each file will do' });
    const outcome = (name: string) =>
      within(within(plan).getByText(name).closest('tr')!).getAllByText(/./)[2].textContent;
    expect(outcome('card-12.csv')).toBe('New match');
    expect(outcome('balls-12.csv')).toBe('Adds ball by ball');
    expect(outcome('again-05.csv')).toBe('Duplicate · skipped');
    expect(screen.getByText(/1 file left out/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Save 1 match' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('1 match saved to the library'));
    const [saved] = vi.mocked(api.platformSaveProMatches).mock.calls[0][0];
    expect(saved.key).toBe('2025-10-12_hawks-v-kestrels_men');
    expect(saved.hasBalls).toBe(true);
    expect(saved.sources.map((s) => s.kind)).toEqual(['scorecard', 'ball-by-ball']);
    expect(screen.queryByRole('table', { name: 'What each file will do' })).toBeNull();
  });

  it('flags a ball by ball that doesn’t add up, and has nothing to save', async () => {
    const existing = planImport([], [readFile('card.csv', scorecard('2025-10-12', 160))]).save;
    const { user } = setup(existing);
    await screen.findByText(/1 match, 0 with ball by ball/);
    await user.upload(screen.getByLabelText('Choose match files'), [
      file('balls.csv', balls('12 Oct 2025', 20)),
    ]);
    expect(await screen.findByText(/doesn.t add up to the scorecard/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Nothing new to save' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('saves in batches the API accepts', async () => {
    const { user } = setup();
    await screen.findByText('No matches yet');
    const days = Array.from({ length: SAVE_BATCH + 5 }, (_, i) => {
      const d = new Date(Date.UTC(2025, 9, 1 + i)).toISOString().slice(0, 10);
      return file(`card-${d}.csv`, scorecard(d, 20 + i));
    });
    await user.upload(screen.getByLabelText('Choose match files'), days);
    await user.click(await screen.findByRole('button', { name: `Save ${SAVE_BATCH + 5} matches` }));
    await waitFor(() => expect(api.platformSaveProMatches).toHaveBeenCalledTimes(2));
    const sizes = vi.mocked(api.platformSaveProMatches).mock.calls.map((c) => c[0].length);
    expect(sizes).toEqual([SAVE_BATCH, 5]);
  });

  it('removes a match only after confirming', async () => {
    const existing = planImport([], [readFile('old.csv', scorecard('2025-10-05', 30))]).save;
    const { user } = setup(existing);
    const table = await screen.findByRole('table', { name: 'Matches in the library' });
    expect(within(table).getByText('Hawks v Kestrels')).toBeTruthy();
    expect(within(table).getByText('Scorecard')).toBeTruthy();
    await user.click(within(table).getByRole('button', { name: /^Remove 2025-10-05/ }));
    expect(api.platformDeleteProMatch).not.toHaveBeenCalled();
    await user.click(within(table).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(api.platformDeleteProMatch).toHaveBeenCalledWith(
        '2025-10-05_hawks-v-kestrels_men',
        expect.anything(),
      ),
    );
  });
});

describe('a big drop', () => {
  it('starts with only the files that need a look', async () => {
    const { user } = setup();
    await screen.findByText('No matches yet');
    const cards = Array.from({ length: PLAN_SHORT + 1 }, (_, i) => {
      const d = new Date(Date.UTC(2025, 9, 1 + i)).toISOString().slice(0, 10);
      return file(`card-${d}.csv`, scorecard(d, 20 + i));
    });
    await user.upload(screen.getByLabelText('Choose match files'), [
      ...cards,
      file('again.csv', scorecard('2025-10-01', 20)),
      file('odd.csv', 'name,club\nA,B'),
    ]);
    const plan = await screen.findByRole('table', { name: 'What each file will do' });
    expect(within(plan).getAllByRole('row')).toHaveLength(2); // header + the unreadable file
    expect(screen.getByText(/1 of 23 files need a look/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show all 23 files' }));
    expect(within(plan).getAllByRole('row')).toHaveLength(24);
  });
});

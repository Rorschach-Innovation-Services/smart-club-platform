/**
 * The chair's scorecard digest page (`/sc/<token>`): the embedded scorecard, the headline
 * fallback, confirm and correction answers, the locked outcomes and the closed-link screens.
 * Rendered for real through the app's providers and router; only the HTTP client is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    getScorecardConfirmLink: vi.fn(),
    submitScorecardConfirmEntry: vi.fn(),
  };
});

import * as api from './api';
import { ApiError } from './api';
import { ScorecardConfirmLinkPage } from './ScorecardConfirm';
import { renderWithProviders } from './test-utils';
import type { InningsScorecard, ScorecardConfirmEntry, ScorecardConfirmView } from './types';

const INNINGS: InningsScorecard = {
  battingTeamName: 'UKZN CC',
  totalRuns: 156,
  wickets: 7,
  overs: '20.0',
  extras: { byes: 1, legByes: 2, wides: 6, noBalls: 0, penalties: 0, total: 9 },
  batters: [
    {
      order: 2,
      name: 'K. Pillay',
      runs: 12,
      ballsFaced: 15,
      fours: 1,
      sixes: 0,
      strikeRate: 80,
      howOut: 'b Dlamini',
    },
    {
      order: 1,
      name: 'S. Naidoo',
      runs: 64,
      ballsFaced: 48,
      fours: 7,
      sixes: 2,
      strikeRate: 133.3333,
      howOut: 'c Moodley b Khumalo',
    },
  ],
  bowlers: [
    {
      order: 1,
      name: 'T. Khumalo',
      overs: '4.0',
      maidens: 1,
      runsConceded: 28,
      wickets: 3,
      economy: 7,
      wides: 2,
      noBalls: 0,
    },
  ],
  fallOfWickets: [{ wicket: 1, runs: 23, overs: '2.6', batterName: 'K. Pillay' }],
};

const entry = (over: Partial<ScorecardConfirmEntry> = {}): ScorecardConfirmEntry => ({
  entryKey: 's1#f1',
  seriesId: 's1',
  fixtureId: 'f1',
  homeTeamName: 'UKZN CC',
  awayTeamName: 'Crusaders CC',
  fixtureDate: '2026-10-03',
  competition: 'Premier T20',
  venue: 'Kingsmead Oval',
  status: 'pending',
  result: { homeScore: '156/7', awayScore: '149/9', summary: 'UKZN won by 7 runs' },
  scorecard: { innings: [INNINGS] },
  ...over,
});

const view = (entries: ScorecardConfirmEntry[]): ScorecardConfirmView => ({
  clubName: 'UKZN CC',
  weekKey: '2026-10-04',
  weekLabel: '28 Sep – 4 Oct 2026',
  ref: 'SC-2026-0007',
  linkExpiresAt: '2026-10-19T21:59:59.000Z',
  branding: { name: 'Dolphins Cricket', logoUrl: '', colors: {} },
  entries,
});

const getLink = () => vi.mocked(api.getScorecardConfirmLink);
const submit = () => vi.mocked(api.submitScorecardConfirmEntry);

function renderPage(token = 'tok.sig') {
  return renderWithProviders(
    <MemoryRouter initialEntries={[`/sc/${token}`]}>
      <Routes>
        <Route path="/sc/:token" element={<ScorecardConfirmLinkPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const card = (name = 'UKZN CC vs Crusaders CC') => screen.findByRole('region', { name });

beforeEach(() => {
  getLink().mockReset();
  submit().mockReset();
});

describe('the digest page', () => {
  it('shows the club, week, ref and the full scorecard', async () => {
    getLink().mockResolvedValue(view([entry()]));
    renderPage();
    const match = await card();
    expect(screen.getByText(/UKZN CC \/ Scorecards · SC-2026-0007/)).toBeInTheDocument();
    expect(screen.getByText(/28 Sep – 4 Oct 2026/)).toBeInTheDocument();
    expect(screen.getByText('Dolphins Cricket')).toBeInTheDocument();
    // Own club is marked on the matchup.
    expect(within(match).getByText('Home')).toBeInTheDocument();

    expect(within(match).getByRole('heading', { name: 'UKZN CC — 156/7 (20.0)' })).toBeVisible();
    const batting = within(match).getByRole('region', { name: 'UKZN CC batting' });
    const rows = within(batting).getAllByRole('row');
    // Header + batters in batting order.
    expect(rows[1]).toHaveTextContent('S. Naidoo');
    expect(rows[1]).toHaveTextContent('c Moodley b Khumalo');
    expect(rows[1]).toHaveTextContent('133.33');
    expect(rows[2]).toHaveTextContent('K. Pillay');
    const bowling = within(match).getByRole('region', { name: 'Bowling to UKZN CC' });
    expect(within(bowling).getByRole('row', { name: /T\. Khumalo/ })).toHaveTextContent(
      /T\. Khumalo\s*4\.0\s*1\s*28\s*3\s*7\.00\s*2\s*0/,
    );
    expect(within(match).getByText('Extras 9 (b 1, lb 2, w 6)')).toBeInTheDocument();
    expect(within(match).getByText(/1-23 \(K\. Pillay, 2\.6\)/)).toBeInTheDocument();
    expect(screen.getByText('0 of 1 match answered')).toBeInTheDocument();
  });

  it('falls back to the headline result and the medicoach link without a scorecard', async () => {
    getLink().mockResolvedValue(
      view([entry({ scorecard: undefined, medicoachMatchUrl: 'https://medicoach.example/m/1' })]),
    );
    renderPage();
    const match = await card();
    expect(within(match).getByText('UKZN CC 156/7 · Crusaders CC 149/9')).toBeInTheDocument();
    expect(within(match).getByText('UKZN won by 7 runs')).toBeInTheDocument();
    const link = within(match).getByRole('link', { name: /view full scorecard/i });
    expect(link).toHaveAttribute('href', 'https://medicoach.example/m/1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(within(match).queryByRole('table')).toBeNull();
    // Still answerable.
    expect(
      within(match).getByRole('button', { name: /confirm — stats are correct/i }),
    ).toBeVisible();
  });

  it('shows a withdrawn result muted, with nothing to answer', async () => {
    getLink().mockResolvedValue(view([entry({ status: 'void' })]));
    renderPage();
    const match = await card();
    expect(within(match).getByText('Result withdrawn')).toBeInTheDocument();
    expect(within(match).queryByRole('button')).toBeNull();
    expect(within(match).queryByRole('table')).toBeNull();
  });
});

describe('answering', () => {
  it('confirms a match and shows the server’s locked answer', async () => {
    const user = userEvent.setup();
    getLink().mockResolvedValue(view([entry()]));
    submit().mockResolvedValue(
      view([entry({ status: 'confirmed', submittedAt: '2026-10-05T08:00:00.000Z' })]),
    );
    renderPage('a.b');
    const match = await card();
    await user.click(within(match).getByRole('button', { name: /confirm — stats are correct/i }));

    expect(submit()).toHaveBeenCalledWith('a.b', 's1', 'f1', { action: 'confirm' });
    expect(
      await within(match).findByText('You confirmed these stats are correct.'),
    ).toBeInTheDocument();
    expect(within(match).getByText('Confirmed')).toBeInTheDocument();
    expect(within(match).queryByRole('button')).toBeNull();
    expect(screen.getByText(/All 1 match answered/)).toBeInTheDocument();
  });

  it('requires correction text, caps it at 2000 characters and sends it trimmed', async () => {
    const user = userEvent.setup();
    getLink().mockResolvedValue(view([entry()]));
    submit().mockResolvedValue(
      view([entry({ status: 'correction', feedback: 'Naidoo scored 46, not 64.' })]),
    );
    renderPage();
    const match = await card();
    await user.click(within(match).getByRole('button', { name: 'Request correction' }));
    await user.click(within(match).getByRole('button', { name: 'Send correction' }));
    expect(within(match).getByRole('alert')).toHaveTextContent('Tell us what needs correcting.');
    expect(submit()).not.toHaveBeenCalled();

    const box = within(match).getByRole('textbox', { name: /what needs correcting/i });
    expect(box).toHaveAttribute('maxLength', '2000');
    await user.click(box);
    await user.paste('x'.repeat(2100));
    expect((box as HTMLTextAreaElement).value).toHaveLength(2000);
    expect(within(match).getByText('2000 / 2000')).toBeInTheDocument();

    await user.clear(box);
    await user.type(box, '  Naidoo scored 46, not 64.  ');
    await user.click(within(match).getByRole('button', { name: 'Send correction' }));
    expect(submit()).toHaveBeenCalledWith('tok.sig', 's1', 'f1', {
      action: 'correction',
      feedback: 'Naidoo scored 46, not 64.',
    });
    expect(await within(match).findByText('You requested a correction.')).toBeInTheDocument();
    expect(within(match).getByLabelText('Your correction request')).toHaveTextContent(
      'Naidoo scored 46, not 64.',
    );
    expect(within(match).queryByRole('textbox')).toBeNull();
  });

  it('on 409 reloads the digest and says the match was already answered', async () => {
    const user = userEvent.setup();
    getLink()
      .mockResolvedValueOnce(view([entry()]))
      .mockResolvedValueOnce(view([entry({ status: 'confirmed' })]));
    submit().mockRejectedValue(new ApiError(409, 'already answered', 'entry_closed'));
    renderPage();
    const match = await card();
    await user.click(within(match).getByRole('button', { name: /confirm — stats are correct/i }));
    expect(
      await within(match).findByText('This match was already answered — showing the saved answer.'),
    ).toBeInTheDocument();
    expect(within(match).getByText('You confirmed these stats are correct.')).toBeInTheDocument();
    expect(getLink()).toHaveBeenCalledTimes(2);
  });

  it('shows a submit error on the match and keeps it answerable', async () => {
    const user = userEvent.setup();
    getLink().mockResolvedValue(view([entry()]));
    submit().mockRejectedValue(new ApiError(400, 'feedback is required for a correction'));
    renderPage();
    const match = await card();
    await user.click(within(match).getByRole('button', { name: /confirm — stats are correct/i }));
    expect(
      await within(match).findByText('feedback is required for a correction'),
    ).toBeInTheDocument();
    expect(
      within(match).getByRole('button', { name: /confirm — stats are correct/i }),
    ).toBeEnabled();
  });

  it('renders answered matches locked on load, beside one still open', async () => {
    getLink().mockResolvedValue(
      view([
        entry({ status: 'correction', feedback: 'Wrong toss winner.' }),
        entry({
          entryKey: 's1#f2',
          fixtureId: 'f2',
          homeTeamName: 'Berea Rovers CC',
          awayTeamName: 'UKZN CC',
        }),
      ]),
    );
    renderPage();
    const first = await card();
    expect(within(first).getByText('Wrong toss winner.')).toBeInTheDocument();
    expect(within(first).queryByRole('button')).toBeNull();
    const second = screen.getByRole('region', { name: 'Berea Rovers CC vs UKZN CC' });
    expect(within(second).getByText('Away')).toBeInTheDocument();
    expect(within(second).getByRole('button', { name: 'Request correction' })).toBeVisible();
    expect(screen.getByText('1 of 2 matches answered')).toBeInTheDocument();
  });
});

describe('closed links', () => {
  it('410 shows the expired screen', async () => {
    getLink().mockRejectedValue(new ApiError(410, 'This link has expired.'));
    renderPage();
    expect(await screen.findByText('This link has expired')).toBeInTheDocument();
    expect(screen.getByText(/contact the union office/i)).toBeInTheDocument();
  });

  it('404 says the link is not valid', async () => {
    getLink().mockRejectedValue(new ApiError(404, 'not found'));
    renderPage();
    expect(await screen.findByText("This link isn't valid")).toBeInTheDocument();
  });
});

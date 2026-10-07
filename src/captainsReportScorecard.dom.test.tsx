/**
 * The captain's report "Match scorecard" section: the innings with the club's own side
 * anchored, the required confirm-or-correct answer (checklist step, feedback rule, echoed card
 * version), the no-card fallback, draft memory, the locked outcome in the read-only report,
 * the portal feeding its form from the report DETAIL, and the card-appeared-mid-fill reveal.
 * Rendered for real through the app's providers; only the HTTP client and callbacks are stubs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return {
    ...actual,
    getClubCaptainsReports: vi.fn(),
    getClubCaptainsReport: vi.fn(),
    putClubCaptainsReport: vi.fn(),
    getLinkedCaptainsReport: vi.fn(),
    putLinkedCaptainsReport: vi.fn(),
  };
});

import * as api from './api';
import { ApiError } from './api';
import {
  CaptainsReportForm,
  CaptainsReportLinkPage,
  CaptainsReportReadOnly,
  CaptainsReportView,
  type ReportShell,
} from './CaptainsReport';
import { renderWithProviders } from './test-utils';
import type {
  CaptainsReport,
  CaptainsReportFields,
  InningsScorecard,
  LinkedCaptainsReport,
  ScorecardContext,
} from './types';

const NGUBANE = { umpireId: 'u-ngubane', name: 'A.Ngubane' };
const REGISTRY = [{ id: 'u-ngubane', displayName: 'A.Ngubane' }];
const FETCHED_AT = '2026-10-04T16:00:00.000Z';

const innings = (battingTeamName: string, totalRuns: number): InningsScorecard => ({
  battingTeamName,
  totalRuns,
  wickets: 6,
  overs: '20.0',
  extras: { byes: 0, legByes: 1, wides: 4, noBalls: 0, penalties: 0, total: 5 },
  batters: [
    {
      order: 1,
      name: 'S. Naidoo',
      runs: 64,
      ballsFaced: 41,
      fours: 6,
      sixes: 3,
      strikeRate: 156.1,
      howOut: 'not out',
    },
  ],
  bowlers: [
    {
      order: 1,
      name: 'T. Khumalo',
      overs: '4.0',
      maidens: 0,
      runsConceded: 31,
      wickets: 2,
      economy: 7.75,
      wides: 2,
      noBalls: 0,
    },
  ],
  fallOfWickets: [{ wicket: 1, runs: 22, overs: '2.6', batterName: 'K. Pillay' }],
});

const WITH_CARD: ScorecardContext = {
  scorecard: {
    matchState: 'Umzinto CC won by 23 runs',
    innings: [innings('Umzinto CC', 184), innings('African Warriors', 161)],
    fetchedAt: FETCHED_AT,
  },
  result: { homeScore: '184/6', awayScore: '161/9', summary: 'Umzinto CC won by 23 runs' },
};

let seq = 0;
const shell = (over: Partial<ReportShell> = {}): ReportShell => ({
  id: `s1~f${++seq}~umzinto`,
  matchDate: '2026-10-04',
  side: 'away',
  clubName: 'Umzinto CC',
  opponentName: 'African Warriors',
  competition: 'Premier T20',
  resultSummary: 'Umzinto CC won by 23 runs',
  umpiresSnapshot: [NGUBANE],
  captainName: '',
  umpires: [],
  general: '',
  declaration: false,
  ...over,
});

/** Everything but the scorecard: one rated umpire, the captain, the declaration. */
async function fillTheRest() {
  const card = screen.getByTestId('umpire-card-1');
  for (const group of within(card).getAllByRole('radiogroup'))
    await userEvent.click(within(group).getByRole('radio', { name: '4' }));
  await userEvent.type(screen.getByRole('combobox', { name: "Captain's name" }), 'S. Mthembu');
  await userEvent.click(screen.getByRole('checkbox'));
}

const submitButton = () => screen.getAllByRole('button', { name: 'Submit report' })[0];
const section = () => screen.getByTestId('report-scorecard');
const step = (label: string) => screen.getByText(label, { selector: '.cr-steps li' });

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.getClubCaptainsReports).mockReset();
  vi.mocked(api.getClubCaptainsReport).mockReset();
  vi.mocked(api.putClubCaptainsReport).mockReset();
  vi.mocked(api.getLinkedCaptainsReport).mockReset();
  vi.mocked(api.putLinkedCaptainsReport).mockReset();
});

describe('the match scorecard section', () => {
  it('shows every innings after the match details, own side anchored, before the umpires', () => {
    renderWithProviders(
      <CaptainsReportForm
        report={shell()}
        registry={REGISTRY}
        onSubmit={vi.fn()}
        scorecardContext={WITH_CARD}
      />,
    );
    const sc = section();
    // Sits between the match details and the first umpire card.
    const order = [screen.getByText('Match details'), sc, screen.getByTestId('umpire-card-1')];
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // The report's side anchors the matchup: an away report lists the opponent first.
    expect(within(sc).getByText('Away')).toBeInTheDocument();
    expect(within(sc).getByText('Umzinto CC', { selector: 'strong' })).toBeInTheDocument();
    expect(
      within(sc).getByRole('heading', { name: /^Umzinto CC — 184\/6 \(20 ov\)/ }),
    ).toHaveTextContent('Your innings');
    expect(
      within(sc).getByRole('heading', { name: /^African Warriors — 161\/6 \(20 ov\)/ }),
    ).not.toHaveTextContent('Your innings');
    // The summary carries a one-line hint: top score and best bowling.
    expect(within(sc).getByRole('button', { name: /^Umzinto CC — 184\/6/ })).toHaveTextContent(
      'Top score S. Naidoo 64* (41) · Best bowling T. Khumalo 2/31',
    );
    // Every table scrolls inside its own focusable region (phones).
    for (const name of ['Umzinto CC batting', 'Bowling to Umzinto CC'])
      expect(within(sc).getByRole('region', { name })).toHaveAttribute('tabindex', '0');
    expect(screen.getByText(/including the answer on the match scorecard/)).toBeInTheDocument();
    // The lead-in sets the expectation before the submit gate does.
    expect(sc).toHaveTextContent(
      "Please check the scorecard below — confirm the stats or flag anything that's wrong.",
    );
  });

  it('own innings first and open; the opponent’s closed until tapped', async () => {
    // A home report for African Warriors: its innings is second on the card, first here.
    renderWithProviders(
      <CaptainsReportForm
        report={shell({ side: 'home', clubName: 'African Warriors', opponentName: 'Umzinto CC' })}
        registry={REGISTRY}
        onSubmit={vi.fn()}
        scorecardContext={WITH_CARD}
      />,
    );
    const sc = section();
    const toggles = within(sc).getAllByRole('button', { name: / — \d+\/\d+/ });
    expect(toggles.map((t) => t.textContent)).toEqual([
      expect.stringMatching(/^African Warriors — 161\/6 \(20 ov\)Your innings/),
      expect.stringMatching(/^Umzinto CC — 184\/6 \(20 ov\)/),
    ]);
    const [own, theirs] = toggles;
    expect(own).toHaveAttribute('aria-expanded', 'true');
    expect(theirs).toHaveAttribute('aria-expanded', 'false');
    // Disclosure: the button controls a region labelled by it.
    const ownBody = document.getElementById(own.getAttribute('aria-controls')!)!;
    expect(ownBody).toHaveAttribute('role', 'region');
    expect(ownBody).toHaveAccessibleName(expect.stringMatching(/^African Warriors — 161\/6/));
    expect(within(sc).getByRole('region', { name: 'African Warriors batting' })).toBeVisible();
    expect(within(sc).queryByRole('region', { name: 'Umzinto CC batting' })).toBeNull();
    // Sub-headers, the extras line and the emphasised total.
    for (const h of ['Batting', 'Bowling', 'Fall of wickets'])
      expect(within(ownBody).getByRole('heading', { name: h })).toBeInTheDocument();
    expect(within(ownBody).getByRole('row', { name: /^Extras lb 1, w 4 5/ })).toBeInTheDocument();
    expect(within(ownBody).getByRole('row', { name: /^Total 6 wkts, 20 ov 161\/6/ })).toHaveClass(
      'sc-total-row',
    );

    await userEvent.click(theirs);
    expect(theirs).toHaveAttribute('aria-expanded', 'true');
    expect(within(sc).getByRole('region', { name: 'Umzinto CC batting' })).toBeVisible();
    await userEvent.click(own);
    expect(own).toHaveAttribute('aria-expanded', 'false');
    expect(within(sc).queryByRole('region', { name: 'African Warriors batting' })).toBeNull();
  });

  it('the answer never collapses: still there, right under the innings, with every innings shut', async () => {
    renderWithProviders(
      <CaptainsReportForm
        report={shell()}
        registry={REGISTRY}
        onSubmit={vi.fn()}
        scorecardContext={WITH_CARD}
      />,
    );
    const sc = section();
    await userEvent.click(within(sc).getByRole('button', { name: /^Umzinto CC — 184\/6/ }));
    for (const t of within(sc).getAllByRole('button', { name: / — \d+\/\d+/ }))
      expect(t).toHaveAttribute('aria-expanded', 'false');
    const group = within(sc).getByRole('radiogroup', { name: 'Are these stats correct?' });
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
    const lastInnings = within(sc)
      .getAllByRole('button', { name: / — \d+\/\d+/ })
      .at(-1)!;
    expect(
      lastInnings.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('the card names the side loosely ("African Warriors" for "African Warriors CC"): still ours, first and open', () => {
    renderWithProviders(
      <CaptainsReportForm
        report={shell({
          side: 'home',
          clubName: 'African Warriors CC',
          opponentName: 'Umzinto CC',
        })}
        registry={REGISTRY}
        onSubmit={vi.fn()}
        scorecardContext={WITH_CARD}
      />,
    );
    const [first, second] = within(section()).getAllByRole('button', { name: / — \d+\/\d+/ });
    expect(first).toHaveTextContent(/^African Warriors — 161\/6 \(20 ov\)Your innings/);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(second).not.toHaveTextContent('Your innings');
    expect(second).toHaveAttribute('aria-expanded', 'false');
  });

  it('no innings carries the club’s name: the first one opens', () => {
    renderWithProviders(
      <CaptainsReportForm
        report={shell({ clubName: 'Port Shepstone CC' })}
        registry={REGISTRY}
        onSubmit={vi.fn()}
        scorecardContext={WITH_CARD}
      />,
    );
    const [first, second] = within(section()).getAllByRole('button', { name: / — \d+\/\d+/ });
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(first).not.toHaveTextContent('Your innings');
    expect(second).toHaveAttribute('aria-expanded', 'false');
  });

  it('requires the answer: checklist step, problem, and the card version echoed on submit', async () => {
    const onSubmit = vi.fn(async () => {});
    renderWithProviders(
      <CaptainsReportForm
        report={shell()}
        registry={REGISTRY}
        onSubmit={onSubmit}
        scorecardContext={WITH_CARD}
      />,
    );
    await fillTheRest();
    expect(submitButton()).toBeDisabled();
    expect(step('Confirm the scorecard')).not.toHaveClass('done');
    expect(
      screen.getByText('Confirm the scorecard or request a correction.', {
        selector: '.rp-validation',
      }),
    ).toBeInTheDocument();

    await userEvent.click(
      within(section()).getByRole('radio', { name: /These stats are correct/ }),
    );
    expect(step('Confirm the scorecard')).toHaveClass('done');
    expect(submitButton()).toBeEnabled();
    await userEvent.click(submitButton());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        scorecard: { action: 'confirmed', againstFetchedAt: FETCHED_AT },
      }),
    );
  });

  it('a correction focuses its text, calls out a blank one, and sends the text', async () => {
    const onSubmit = vi.fn(async () => {});
    renderWithProviders(
      <CaptainsReportForm
        report={shell()}
        registry={REGISTRY}
        onSubmit={onSubmit}
        scorecardContext={WITH_CARD}
      />,
    );
    await fillTheRest();
    await userEvent.click(within(section()).getByRole('radio', { name: /Something's wrong/ }));
    const field = within(section()).getByRole('textbox', { name: /What's wrong/ });
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute(
      'placeholder',
      "Tell us what's wrong, e.g. 'Nkosi scored 45 not 54'",
    );
    expect(submitButton()).toBeDisabled();
    // Leaving it blank says why.
    await userEvent.type(field, '   ');
    await userEvent.tab();
    expect(within(section()).getByRole('alert')).toHaveTextContent(
      'Tell us what needs correcting.',
    );
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(/Tell us what needs correcting\./);
    await userEvent.clear(field);
    await userEvent.type(field, 'S. Naidoo scored 46');
    expect(within(section()).queryByRole('alert')).toBeNull();
    expect(within(section()).getByText('19 / 2000')).toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
    await userEvent.click(submitButton());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        scorecard: {
          action: 'correction',
          feedback: 'S. Naidoo scored 46',
          againstFetchedAt: FETCHED_AT,
        },
      }),
    );
  });

  it('the choice and its text survive leaving the form (draft memory)', async () => {
    const report = shell();
    const first = renderWithProviders(
      <CaptainsReportForm
        report={report}
        registry={REGISTRY}
        onSubmit={vi.fn()}
        scorecardContext={WITH_CARD}
      />,
    );
    await userEvent.click(within(section()).getByRole('radio', { name: /Something's wrong/ }));
    await userEvent.type(
      within(section()).getByRole('textbox', { name: /What's wrong/ }),
      'Extras are wrong',
    );
    first.unmount();
    renderWithProviders(
      <CaptainsReportForm
        report={report}
        registry={REGISTRY}
        onSubmit={vi.fn()}
        scorecardContext={WITH_CARD}
      />,
    );
    expect(within(section()).getByRole('radio', { name: /Something's wrong/ })).toBeChecked();
    expect(within(section()).getByRole('textbox', { name: /What's wrong/ })).toHaveValue(
      'Extras are wrong',
    );
  });

  it('a saved draft answer opens the form already chosen', () => {
    renderWithProviders(
      <CaptainsReportForm
        report={shell({ scorecard: { action: 'confirmed' } })}
        registry={REGISTRY}
        onSubmit={vi.fn()}
        scorecardContext={WITH_CARD}
      />,
    );
    expect(within(section()).getByRole('radio', { name: /These stats are correct/ })).toBeChecked();
  });

  it('no card yet: the headline result and medicoach link, nothing to answer, not required', async () => {
    const onSubmit = vi.fn(async (_fields: CaptainsReportFields) => {});
    renderWithProviders(
      <CaptainsReportForm
        report={shell()}
        registry={REGISTRY}
        onSubmit={onSubmit}
        scorecardContext={{
          result: WITH_CARD.result,
          medicoachMatchUrl: 'https://medicoach.example/matches/1',
        }}
      />,
    );
    const sc = section();
    expect(within(sc).getByText('African Warriors 184/6 · Umzinto CC 161/9')).toBeInTheDocument();
    expect(within(sc).getByRole('link', { name: /View full scorecard/ })).toHaveAttribute(
      'href',
      'https://medicoach.example/matches/1',
    );
    expect(within(sc).queryByRole('radio')).toBeNull();
    expect(screen.queryByText('Confirm the scorecard')).toBeNull();
    await fillTheRest();
    expect(submitButton()).toBeEnabled();
    await userEvent.click(submitButton());
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('scorecard');
  });

  it('no result at all (unlisted, by hand): no section', () => {
    renderWithProviders(
      <CaptainsReportForm report={shell()} registry={REGISTRY} onSubmit={vi.fn()} />,
    );
    expect(screen.queryByTestId('report-scorecard')).toBeNull();
    expect(screen.queryByText(/including the answer on the match scorecard/)).toBeNull();
  });
});

const stored = (over: Partial<CaptainsReport> = {}): CaptainsReport => ({
  ...shell(),
  id: 's1~f1~umzinto',
  seriesId: 's1',
  fixtureId: 'f1',
  clubId: 'umzinto',
  status: 'submitted',
  source: 'auto',
  recipient: { kind: 'chair', name: 'Uma Chair' },
  captainName: 'S. Mthembu',
  umpires: [
    {
      umpireId: 'u-ngubane',
      name: 'A.Ngubane',
      ratings: { decisions: 4, pressure: 4, behaviour: 4, communication: 4, regulations: 4 },
      concerns: {},
      otherConcern: '',
      comments: '',
    },
  ],
  declaration: true,
  ref: 'CR-2026-0001',
  submittedAt: '2026-10-05T08:00:00.000Z',
  createdAt: '2026-10-04T16:00:00.000Z',
  updatedAt: '2026-10-05T08:00:00.000Z',
  ...over,
});

describe('the read-only report', () => {
  it('locks a confirmation, attributed to the club', () => {
    renderWithProviders(
      <CaptainsReportReadOnly report={stored({ scorecard: { action: 'confirmed' } })} />,
    );
    const outcome = screen.getByTestId('report-scorecard-outcome');
    expect(outcome).toHaveTextContent(/Stats confirmed for Umzinto CC/);
    expect(outcome).not.toHaveTextContent(/by S\. Mthembu/);
  });

  it('locks a correction with its text, and says when the card changed since', () => {
    renderWithProviders(
      <CaptainsReportReadOnly
        report={stored({
          scorecard: { action: 'correction', feedback: 'Extras are wrong', stale: true },
        })}
      />,
    );
    const outcome = screen.getByTestId('report-scorecard-outcome');
    expect(outcome).toHaveTextContent(/Correction requested by Umzinto CC/);
    expect(within(outcome).getByLabelText('Correction request')).toHaveTextContent(
      'Extras are wrong',
    );
    expect(outcome).toHaveTextContent(/updated after this answer/);
  });

  it('shows nothing for a report filed without an answer', () => {
    renderWithProviders(<CaptainsReportReadOnly report={stored()} />);
    expect(screen.queryByTestId('report-scorecard-outcome')).toBeNull();
  });
});

describe('the club portal', () => {
  it('feeds the form from the report detail, which carries the scorecard', async () => {
    const pending = stored({
      status: 'pending',
      ref: undefined,
      submittedAt: undefined,
      captainName: '',
      umpires: [],
      declaration: false,
      source: 'manual',
    });
    vi.mocked(api.getClubCaptainsReports).mockResolvedValue([pending]);
    vi.mocked(api.getClubCaptainsReport).mockResolvedValue({
      ...pending,
      scorecardContext: WITH_CARD,
    });
    renderWithProviders(<CaptainsReportView club={{ id: 'umzinto', name: 'Umzinto CC' }} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /African Warriors v Umzinto CC/ }),
    );
    expect(await screen.findByTestId('report-scorecard')).toBeInTheDocument();
    expect(api.getClubCaptainsReport).toHaveBeenCalledWith('s1~f1~umzinto');
    expect(
      screen.getByText('Confirm the scorecard', { selector: '.cr-steps li' }),
    ).toBeInTheDocument();
  });
});

describe('a closed link', () => {
  it('reads as two sentences, the API reason capitalised', async () => {
    vi.mocked(api.getLinkedCaptainsReport).mockRejectedValue(
      new ApiError(410, 'this report has already been submitted'),
    );
    renderWithProviders(
      <MemoryRouter initialEntries={['/r/tok.sig']}>
        <Routes>
          <Route path="/r/:token" element={<CaptainsReportLinkPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('This report is closed')).toBeInTheDocument();
    expect(screen.getByText('This report has already been submitted.')).toBeInTheDocument();
  });
});

describe('a scorecard that arrives while the form is open', () => {
  it('the refused submit reveals the section, focused, with a one-line explanation', async () => {
    const report = stored({
      status: 'pending',
      ref: undefined,
      submittedAt: undefined,
      captainName: '',
      umpires: [],
      declaration: false,
    });
    const payload = (ctx: ScorecardContext): LinkedCaptainsReport => ({
      report,
      registry: REGISTRY,
      tenantBranding: { name: 'Dolphins Cricket', logoUrl: '', colors: {} },
      ...ctx,
    });
    vi.mocked(api.getLinkedCaptainsReport)
      .mockResolvedValueOnce(payload({}))
      .mockResolvedValue(payload(WITH_CARD));
    vi.mocked(api.putLinkedCaptainsReport).mockRejectedValue(
      new ApiError(400, 'Confirm the scorecard or request a correction.', 'scorecard_required'),
    );
    renderWithProviders(
      <MemoryRouter initialEntries={['/r/tok.sig']}>
        <Routes>
          <Route path="/r/:token" element={<CaptainsReportLinkPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Match details');
    expect(screen.queryByTestId('report-scorecard')).toBeNull();
    await fillTheRest();
    await userEvent.click(submitButton());

    const sc = await screen.findByTestId('report-scorecard');
    await waitFor(() => expect(sc).toHaveFocus());
    expect(within(sc).getByRole('alert')).toHaveTextContent(
      'The match scorecard has just come in. Confirm it or request a correction, then submit again.',
    );
    expect(api.getLinkedCaptainsReport).toHaveBeenCalledTimes(2);
    // No second banner for the same thing.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(submitButton()).toBeDisabled();
    await userEvent.click(within(sc).getByRole('radio', { name: /These stats are correct/ }));
    expect(within(sc).queryByRole('alert')).toBeNull();
    expect(submitButton()).toBeEnabled();
  });
});

describe('the success card', () => {
  it('after a correction, shows the submitted text under the scorecard answer', async () => {
    const report = stored({
      status: 'pending',
      ref: undefined,
      submittedAt: undefined,
      captainName: '',
      umpires: [],
      declaration: false,
    });
    vi.mocked(api.getLinkedCaptainsReport).mockResolvedValue({
      report,
      registry: REGISTRY,
      tenantBranding: { name: 'Dolphins Cricket', logoUrl: '', colors: {} },
      ...WITH_CARD,
    });
    vi.mocked(api.putLinkedCaptainsReport).mockResolvedValue({
      report: stored({
        scorecard: { action: 'correction', feedback: 'S. Naidoo scored 46' },
      }),
      registry: REGISTRY,
      tenantBranding: { name: 'Dolphins Cricket', logoUrl: '', colors: {} },
    } as never);
    renderWithProviders(
      <MemoryRouter initialEntries={['/r/tok.sig']}>
        <Routes>
          <Route path="/r/:token" element={<CaptainsReportLinkPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId('report-scorecard');
    await fillTheRest();
    await userEvent.click(within(section()).getByRole('radio', { name: /Something's wrong/ }));
    await userEvent.type(
      within(section()).getByRole('textbox', { name: /What's wrong/ }),
      'S. Naidoo scored 46',
    );
    await userEvent.click(submitButton());

    expect(await screen.findByText('Report submitted')).toBeInTheDocument();
    expect(screen.getByText('Correction requested')).toBeInTheDocument();
    expect(screen.getByLabelText('Submitted correction request')).toHaveTextContent(
      'S. Naidoo scored 46',
    );
  });
});

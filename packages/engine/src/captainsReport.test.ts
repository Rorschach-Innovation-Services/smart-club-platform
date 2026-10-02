import { describe, it, expect } from 'vitest';
import {
  appointedChoices,
  easterSunday,
  emptyUmpireEntry,
  initialUmpireCards,
  isReportLate,
  pickAppointed,
  pickSubstitute,
  reportDeadline,
  reportDeadlineDate,
  saPublicHolidays,
  submissionProblems,
  umpireCardMode,
  umpireRatingAverages,
  type ReportUmpireEntry,
} from './captainsReport';

const NGUBANE = { umpireId: 'u-ngubane', name: 'A.Ngubane' };
const DLAMINI = { umpireId: 'u-dlamini', name: 'S.Dlamini' };
const allFives = { decisions: 5, pressure: 5, behaviour: 5, communication: 5, regulations: 5 };

describe('SA public holidays', () => {
  it('computes Easter Sunday', () => {
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
  });

  it('includes Good Friday and Family Day, and moves a Sunday holiday to Monday', () => {
    const h = saPublicHolidays(2027);
    expect(h.has('2027-03-26')).toBe(true); // Good Friday
    expect(h.has('2027-03-29')).toBe(true); // Family Day
    expect(h.has('2027-03-21')).toBe(true); // Human Rights Day (a Sunday)
    expect(h.has('2027-03-22')).toBe(true); // …observed on the Monday
  });

  it('moves Christmas-on-a-Sunday past the Day of Goodwill (27 Dec 2022)', () => {
    const h = saPublicHolidays(2022);
    expect(h.has('2022-12-26')).toBe(true);
    expect(h.has('2022-12-27')).toBe(true);
  });
});

describe('reportDeadline — 18h00 on the 3rd business day after the match', () => {
  it('a Saturday or Sunday match is due on the Wednesday', () => {
    expect(reportDeadlineDate('2026-10-03')).toBe('2026-10-07');
    expect(reportDeadlineDate('2026-10-04')).toBe('2026-10-07');
  });

  it('is 18h00 SAST (16h00 UTC)', () => {
    expect(reportDeadline('2026-10-04')).toBe('2026-10-07T16:00:00.000Z');
  });

  it('skips the Day of Reconciliation (Wed 16 Dec 2026)', () => {
    expect(reportDeadlineDate('2026-12-12')).toBe('2026-12-17');
    expect(reportDeadlineDate('2026-12-14')).toBe('2026-12-18');
  });

  it('skips Christmas and the Day of Goodwill', () => {
    expect(reportDeadlineDate('2026-12-23')).toBe('2026-12-29');
  });

  it('skips the Easter weekend 2027 and the observed Human Rights Day', () => {
    // Sat 20 Mar: Mon 22 (observed holiday) is skipped → Tue 23, Wed 24, Thu 25.
    expect(reportDeadlineDate('2027-03-20')).toBe('2027-03-25');
    // Wed 24 Mar: Thu 25, then Good Friday, the weekend and Family Day → Tue 30, Wed 31.
    expect(reportDeadlineDate('2027-03-24')).toBe('2027-03-31');
  });

  it('is null without a valid date', () => {
    expect(reportDeadline('')).toBeNull();
    expect(reportDeadline(undefined)).toBeNull();
    expect(reportDeadline('04/10/2026')).toBeNull();
  });
});

describe('isReportLate (derived on read)', () => {
  const deadline = '2026-10-07T16:00:00.000Z';
  it('a pending report is late only after the deadline', () => {
    expect(isReportLate({ status: 'pending', deadline }, '2026-10-07T15:59:00.000Z')).toBe(false);
    expect(isReportLate({ status: 'pending', deadline }, '2026-10-07T16:01:00.000Z')).toBe(true);
  });
  it('a submitted report is late when it was submitted after the deadline', () => {
    const now = '2026-12-01T00:00:00.000Z';
    expect(
      isReportLate({ status: 'submitted', deadline, submittedAt: '2026-10-06T10:00:00Z' }, now),
    ).toBe(false);
    expect(
      isReportLate({ status: 'submitted', deadline, submittedAt: '2026-10-08T10:00:00Z' }, now),
    ).toBe(true);
  });
  it('a void report is never late', () => {
    expect(isReportLate({ status: 'void', deadline }, '2027-01-01T00:00:00.000Z')).toBe(false);
  });
});

describe('umpire cards from the appointment', () => {
  it('no appointment → two blank registry cards', () => {
    expect(umpireCardMode([])).toBe('registry');
    const cards = initialUmpireCards([]);
    expect(cards).toHaveLength(2);
    expect(cards.every((c) => !c.name && !c.umpireId)).toBe(true);
  });

  it('one appointed → one card, autofilled', () => {
    expect(umpireCardMode([NGUBANE])).toBe('single');
    const cards = initialUmpireCards([NGUBANE]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ umpireId: 'u-ngubane', name: 'A.Ngubane' });
    expect(cards[0].substitute).toBeUndefined();
  });

  it('two appointed → two cards limited to the pair, never the same umpire twice', () => {
    const appointed = [NGUBANE, DLAMINI];
    expect(umpireCardMode(appointed)).toBe('pair');
    const cards = initialUmpireCards(appointed);
    expect(cards.map((c) => c.umpireId)).toEqual(['u-ngubane', 'u-dlamini']);
    // Card 0 may only pick Ngubane while card 1 holds Dlamini.
    expect(appointedChoices(appointed, cards, 0)).toEqual([NGUBANE]);
    // Once card 1 is cleared, card 0 may pick either.
    const cleared = [cards[0], emptyUmpireEntry()];
    expect(appointedChoices(appointed, cleared, 0)).toEqual([NGUBANE, DLAMINI]);
    // Swapping a card to the other umpire resets its ratings.
    const rated: ReportUmpireEntry = { ...cards[0], ratings: { ...allFives } };
    expect(pickAppointed(rated, DLAMINI)).toMatchObject({ umpireId: 'u-dlamini', ratings: {} });
    expect(pickAppointed(rated, NGUBANE)).toBe(rated);
  });

  it('"Different umpire stood" → registry pick or free text, flagged substitute', () => {
    const [card] = initialUmpireCards([NGUBANE]);
    const reg = pickSubstitute(card, { umpireId: 'u-other', name: 'B.Other' });
    expect(reg).toMatchObject({ umpireId: 'u-other', name: 'B.Other', substitute: true });
    const free = pickSubstitute(card, { name: 'Club umpire' });
    expect(free.substitute).toBe(true);
    expect(free.umpireId).toBeUndefined();
    expect(free.name).toBe('Club umpire');
  });
});

describe('submissionProblems', () => {
  it('accepts a complete report', () => {
    expect(
      submissionProblems({
        captainName: 'S. Mthembu',
        declaration: true,
        umpires: [emptyUmpireEntry({ ...NGUBANE, ratings: allFives })],
      }),
    ).toEqual([]);
  });

  it('lists what is missing', () => {
    const problems = submissionProblems({
      captainName: '',
      declaration: false,
      umpires: [emptyUmpireEntry({ name: 'X', ratings: { decisions: 9 } })],
    });
    expect(problems).toContain("Enter the captain's name.");
    expect(problems).toContain('Confirm the declaration.');
    expect(problems.some((p) => p.includes('Correct decisions'))).toBe(true);
  });

  it('refuses the same registry umpire twice', () => {
    const u = emptyUmpireEntry({ ...NGUBANE, ratings: allFives });
    expect(
      submissionProblems({ captainName: 'C', declaration: true, umpires: [u, { ...u }] }),
    ).toContain('The same umpire is rated twice.');
  });
});

describe('umpireRatingAverages', () => {
  it('averages submitted reports per umpireId and counts low ratings', () => {
    const lows = { decisions: 2, pressure: 3, behaviour: 3, communication: 3, regulations: 4 };
    const out = umpireRatingAverages([
      { status: 'submitted', umpires: [emptyUmpireEntry({ ...NGUBANE, ratings: allFives })] },
      { status: 'submitted', umpires: [emptyUmpireEntry({ ...NGUBANE, ratings: lows })] },
      { status: 'pending', umpires: [emptyUmpireEntry({ ...NGUBANE, ratings: lows })] },
      { status: 'submitted', umpires: [emptyUmpireEntry({ name: 'Free text', ratings: lows })] },
    ]);
    expect([...out.keys()]).toEqual(['u-ngubane']);
    const s = out.get('u-ngubane')!;
    expect(s.reports).toBe(2);
    expect(s.average).toBeCloseTo((5 + 3) / 2);
    expect(s.byCriterion.decisions).toBeCloseTo(3.5);
    expect(s.lowReports).toBe(1);
  });
});

import { describe, it, expect } from 'vitest';
import {
  appointedChoices,
  emptyUmpireEntry,
  initialUmpireCards,
  pickAppointed,
  pickSubstitute,
  submissionProblems,
  umpireCardMode,
  umpireRatingAverages,
  type ReportUmpireEntry,
} from './captainsReport';

const NGUBANE = { umpireId: 'u-ngubane', name: 'A.Ngubane' };
const DLAMINI = { umpireId: 'u-dlamini', name: 'S.Dlamini' };
const allFives = { decisions: 5, pressure: 5, behaviour: 5, communication: 5, regulations: 5 };

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

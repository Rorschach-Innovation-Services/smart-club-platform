import { describe, it, expect } from 'vitest';
import { MEASURES, fitScore, ordinal, percentileOf, percentiles, weakest } from './pro-callups';

describe('call-ups on percentiles', () => {
  it('ranks within the population, the right way round', () => {
    expect(percentileOf(9, [5, 6, 7, 8, 9], 'high')).toBe(100);
    expect(percentileOf(5, [5, 6, 7, 8, 9], 'high')).toBe(20);
    expect(percentileOf(5, [5, 6, 7, 8, 9], 'low')).toBe(100); // economy: lowest is best
    expect(percentileOf(5, [], 'high')).toBeNull();
  });

  it('places a bowler on every measure and names the weakest skill (not the overall index)', () => {
    const pop = [
      { idx: 120, econ: 6, wpo: 0.4, dot: 50 },
      { idx: 100, econ: 7, wpo: 0.3, dot: 45 },
      { idx: 80, econ: 9, wpo: 0.35, dot: 30 },
    ];
    const me = { idx: 80, econ: 9, wpo: 0.35, dot: 30 };
    const p = percentiles(me, pop, MEASURES.bowl);
    expect(p).toEqual({ idx: 33, econ: 33, wpo: 67, dot: 33 });
    expect(weakest(p, MEASURES.bowl)?.key).toBe('econ'); // ties: the first skill listed
    expect(weakest({ idx: 5, sr: 80, avg: 60 }, MEASURES.bat)?.key).toBe('avg');
  });

  it('scores fit with the weakest measure counted twice, and only with two or more measures', () => {
    expect(fitScore({ idx: 90, sr: 30, avg: 60 }, MEASURES.bat, 'sr')).toBe(
      Math.round((90 + 60 + 60) / 4),
    );
    expect(fitScore({ idx: 90, sr: null, avg: null }, MEASURES.bat, 'sr')).toBeNull();
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(23)).toBe('23rd');
  });
});

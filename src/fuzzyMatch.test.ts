import { describe, it, expect } from 'vitest';
import { editDistance, fuzzyMatchName, normalizeText } from './fuzzyMatch';

describe('normalizeText', () => {
  it('strips accents, turns punctuation into token boundaries, lowercases, collapses whitespace', () => {
    expect(normalizeText("  José  O'Brien-Smith ")).toBe('jose o brien smith');
  });
});

describe('fuzzyMatchName', () => {
  it('ignores accents in either direction', () => {
    expect(fuzzyMatchName('jose', 'José Fernandes')).toBe('exact');
    expect(fuzzyMatchName('José', 'Jose Fernandes')).toBe('exact');
  });

  it('is order-independent', () => {
    expect(fuzzyMatchName('mbeki sipho', 'Sipho Mbeki')).toBe('exact');
  });

  it('matches token prefixes', () => {
    expect(fuzzyMatchName('sip mb', 'Sipho Mbeki')).toBe('exact');
  });

  it('allows 2 edits for tokens of 6+ chars', () => {
    expect(editDistance('pillai', 'pillay', 2)).toBe(1);
    expect(fuzzyMatchName('Pillai', 'Keshav Pillay')).toBe('fuzzy');
    expect(editDistance('naidoo', 'naiduu', 2)).toBe(2);
    expect(fuzzyMatchName('naidoo', 'Naiduu')).toBe('fuzzy');
  });

  it('allows only 1 edit for 4-5 char tokens', () => {
    expect(editDistance('naidu', 'naidoo', 2)).toBe(2);
    expect(fuzzyMatchName('Naidu', 'Kevin Naidoo')).toBeNull();
    expect(fuzzyMatchName('zuly', 'Anele Zulu')).toBe('fuzzy');
  });

  it('short tokens (<4) are prefix-only', () => {
    expect(fuzzyMatchName('zul', 'Anele Zulu')).toBe('exact');
    expect(fuzzyMatchName('zil', 'Anele Zulu')).toBeNull();
  });

  it('splits hyphenated surnames into tokens', () => {
    expect(fuzzyMatchName('pillay', 'K. Naidoo-Pillay')).toBe('exact');
  });

  it('matches infix fragments within a token and across tokens', () => {
    expect(fuzzyMatchName('ovu', 'Sipho Ndhlovu')).toBe('exact');
    expect(fuzzyMatchName('o nd', 'Sipho Ndhlovu')).toBe('exact');
  });

  it('an empty query matches everything', () => {
    expect(fuzzyMatchName('', 'Anyone')).toBe('exact');
    expect(fuzzyMatchName('   ', 'Anyone')).toBe('exact');
  });

  it('is fuzzy if any token needed a typo rescue, null if any token misses', () => {
    expect(fuzzyMatchName('sipho mbekk', 'Sipho Mbeki')).toBe('fuzzy');
    expect(fuzzyMatchName('sipho dlamini', 'Sipho Mbeki')).toBeNull();
  });
});

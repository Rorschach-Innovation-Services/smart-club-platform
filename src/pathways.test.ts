import { describe, it, expect } from 'vitest';
import {
  ageOf,
  calendar,
  clubName,
  competitionSummaries,
  coverage,
  filterMatches,
  formatOf,
  genderOf,
  isResultsExport,
  ladder,
  ladderSort,
  marginBands,
  outcomeFor,
  parseOvers,
  parseResults,
  parseScore,
  pipeline,
  pyramid,
  sideName,
  tierOf,
  weekOf,
} from './pathways';
import { buildSampleResults } from './pathways-sample';

const HEAD =
  'Site,Competition,Division,Match Type,Date,Team 1,Team 1 Score,Team 1 Overs,Team 2,Team 2 Score,Team 2 Overs,Result,Venue,Status,Match ID';
const row = (cells: string[]) => cells.map((c) => `"${c}"`).join(',');
const csv = (rows: string[][]) => [HEAD, ...rows.map(row)].join('\n');

// Invented sides throughout.
const EXPORT = csv([
  [
    'Club (X)',
    'Sunday One 25/26',
    '',
    'League',
    '2025-10-05',
    'Riverside CC SU1 2025',
    '181/5',
    '45/45',
    'Westvale CC SU1 2025',
    '88/5',
    '44/45',
    'Riverside CC SU1 2025 won by 93 Runs',
    'Riverside Ground',
    '',
    '101',
  ],
  [
    'Club (X)',
    'Sunday One 25/26',
    '',
    'League',
    '2025-10-12',
    'Westvale CC SU1 2025',
    '140/10',
    '38.2/45',
    'Riverside CC SU1 2025',
    '141/4',
    '30/45',
    'Riverside CC SU1 2025 won by 6 Wickets (D/L)',
    '',
    '',
    '102',
  ],
  [
    'Club (X)',
    'Sunday One 25/26',
    '',
    'League',
    '2025-10-19',
    'Riverside  CC SU1 2025',
    '150/8',
    '45/45',
    'Old Summit SU1 2025',
    '150/9',
    '45/45',
    'It is a Tie',
    '',
    '',
    '103',
  ],
  [
    'Club (X)',
    'Sunday One 25/26',
    '',
    'League',
    '2025-10-26',
    'Old Summit SU1 2025',
    '',
    '',
    'Westvale CC SU1 2025',
    '',
    '',
    'Abandoned.',
    '',
    '',
    '104',
  ],
  [
    'Club (X)',
    'Sunday One 25/26',
    '',
    'League',
    '2025-11-02',
    'Old Summit SU1 2025',
    '',
    '',
    'Riverside CC SU1 2025',
    '',
    '',
    'Forfeited. Winner: Riverside CC SU1 2025',
    '',
    '',
    '105',
  ],
  [
    'Club (X)',
    'Sunday One 25/26',
    '',
    'League',
    '2025-11-09',
    'Westvale CC SU1 2025',
    '160/7',
    '45',
    'Old Summit SU1 2025',
    '161/3',
    '40.1',
    'Old Summit SU1 2025 won by 7 Wickets',
    '',
    '',
    '106',
  ],
  [
    'Club (X)',
    'Highveld Pres A 25/26',
    '',
    'League',
    '2025-11-16',
    'Riverside Pres A 2025',
    '196/10 & 105/10',
    '61.3 & 42.2',
    'Westvale Pres A 2025',
    '240/8 & 62/1',
    '70 & 15',
    'Westvale Pres A 2025 won by 9 Wickets',
    '',
    '',
    '107',
  ],
  [
    'Schools (Y)',
    'Highveld Primary Schools 2026',
    'U13A 2026',
    'League',
    '2026-02-01',
    'Northgate Prep U13A 2026',
    '120/6',
    '35/35',
    'Lakeside Primary U13A 2026',
    '80/10',
    '28.4/35',
    'Northgate Prep U13A 2026 won by 40 Runs',
    'Northgate Oval',
    'Completed',
    '108',
  ],
  [
    'Schools (Y)',
    'Highveld High Schools 2026',
    '1st XI 2026 50 over',
    'Final',
    '2026-03-01',
    'Hillcrest College 1st XI 2026',
    '210/7',
    '50/50',
    'Valley High 1st XI 2026',
    '212/4',
    '47.3/50',
    'Valley High 1st XI 2026 won by 6 Wickets',
    '',
    'Completed',
    '109',
  ],
  [
    'Schools (Y)',
    'Highveld High Schools Trials 2025',
    'U15s Trials 2025',
    'Practice',
    '2025-11-01',
    'Highveld Red U15 2025',
    '150/5',
    '',
    'Highveld Blue U15 2025',
    '90/4',
    '',
    'Winner: Highveld Red U15 2025',
    '',
    '',
    '110',
  ],
  [
    'Schools (Y)',
    'Highveld High Schools 2026',
    'Girls 2026 T20',
    'League',
    '2026-02-08',
    'Valley High Girls 1st Team',
    '20/1',
    '4/20',
    'Ridgeway High Girls 1st Team',
    '',
    '',
    'Valley High Girls 1st Team: 20/1',
    '',
    'Ongoing',
    '111',
  ],
  [
    'Schools (Y)',
    'Highveld High Schools 2026',
    '1st XI 2026 50 over',
    'League',
    '2026-03-08',
    'Hillcrest College 1st XI 2026',
    '210/7',
    '50/50',
    'Valley High 1st XI 2026',
    '212/4',
    '47.3/50',
    'Valley High 1st XI 2026 won by 6 Wickets',
    '',
    'Completed',
    '109',
  ],
]);

describe('reading the export', () => {
  it('recognises the export and reads scores, overs and two-innings games', () => {
    expect(isResultsExport(EXPORT)).toBe(true);
    expect(isResultsExport('name,club\nA,B')).toBe(false);
    expect(parseScore('181/5')).toEqual([{ runs: 181, wkts: 5 }]);
    expect(parseScore('196/10 & 105/10')).toHaveLength(2);
    expect(parseScore('')).toEqual([]);
    expect(parseOvers('12.2/20')).toEqual({ balls: [74], allotted: 20 });
    expect(parseOvers('59')).toEqual({ balls: [354], allotted: null });
    expect(parseOvers('61.3 & 42.2').balls).toEqual([369, 254]);
  });

  it('reads every result wording, finds the winner, and drops a repeated match id', () => {
    const ms = parseResults(EXPORT);
    expect(ms).toHaveLength(11);
    const by = Object.fromEntries(ms.map((m) => [m.id, m]));
    expect(by['101'].result).toMatchObject({ kind: 'runs', winner: 0, margin: 93, dl: false });
    expect(by['102'].result).toMatchObject({ kind: 'wickets', winner: 1, margin: 6, dl: true });
    // Doubled spaces in a name don't lose the tie or the side.
    expect(by['103'].result.kind).toBe('tie');
    expect(by['103'].sides[0].side).toBe('Riverside CC SU1');
    expect(by['104'].result).toMatchObject({ kind: 'abandoned', winner: null });
    expect(by['105'].result).toMatchObject({ kind: 'forfeit', winner: 1 });
    expect(by['107'].sides[0]).toMatchObject({ runs: 301, wkts: 20, balls: 623 });
    expect(by['107'].format).toBe('time');
    expect(by['110'].result).toMatchObject({ kind: 'forfeit', winner: 0 });
    expect(by['111'].result.kind).toBe('ongoing');
    expect(by['111'].status).toBe('ongoing');
  });

  it('puts each match on the pyramid: tier, gender, age and format', () => {
    const ms = parseResults(EXPORT);
    const by = Object.fromEntries(ms.map((m) => [m.id, m]));
    expect(by['101']).toMatchObject({
      tier: 'club-league',
      gender: 'men',
      age: 'Open',
      format: 'long',
    });
    expect(by['107']).toMatchObject({ tier: 'presidents', format: 'time' });
    expect(by['108']).toMatchObject({
      tier: 'primary',
      age: 'U13',
      format: 'short',
      site: 'school',
    });
    expect(by['109']).toMatchObject({
      tier: 'high-school',
      age: 'Open',
      format: 'long',
      type: 'knockout',
    });
    expect(by['110']).toMatchObject({ tier: 'representative', age: 'U15', type: 'practice' });
    expect(by['111']).toMatchObject({ gender: 'women', format: 'T20' });
  });
});

describe('placing names', () => {
  it.each([
    ['club', 'U11 Club Junior Premier', '', 'club-junior'],
    ['club', 'Sunday Eight U15 35 overs 25/26', '', 'club-junior'],
    ['club', 'CGL Pres A 25/26', '', 'presidents'],
    ['club', 'TIME Enza Prem A 25/26', '', 'premier'],
    ['club', 'DP Womens Premier 25/26', '', 'premier'],
    ['club', 'CGL Womens Promotion 25/26', '', 'club-league'],
    ['club', 'Saturday Three 25/26', '', 'club-league'],
    ['club', 'Blind Cricket', '', 'other'],
    ['school', 'CGL Primary Schools 2026', 'CGL U11A 2026', 'primary'],
    ['school', 'Lions High Schools 2026', '1st XI U19A 2026 50 over', 'high-school'],
    ['school', 'Johnny Waite League 2025/2026', 'Section A U14 2025', 'high-school'],
    ['school', 'CSA U13 Provincial 2025', '', 'representative'],
    ['school', 'Lions High Schools Trials 2025', 'U16s Trials 2025', 'representative'],
    ['school', 'Primary Schools Area Week 2025', 'U11 T20 2025', 'representative'],
  ] as const)('%s · %s %s → %s', (site, comp, div, tier) => {
    expect(tierOf(site, comp, div)).toBe(tier);
  });

  it('reads gender, age and format from the words', () => {
    expect(genderOf('Girls 2026 T20')).toBe('women');
    expect(genderOf('Sunday One', 'Riverside CC Women')).toBe('women');
    expect(genderOf('Fernhill Old Boys')).toBe('men');
    expect(ageOf('U13A 2026')).toBe('U13');
    expect(ageOf('', 'Under 13 Girls')).toBe('U13');
    expect(ageOf('1st XI U19A 2026 50 over')).toBe('U19');
    expect(ageOf('Sunday One', 'Riverside CC SU1 2025')).toBe('Open');
    expect(formatOf(20, 1, null)).toBe('T20');
    expect(formatOf(35, 1, null)).toBe('short');
    expect(formatOf(50, 1, null)).toBe('long');
    expect(formatOf(100, 1, null)).toBe('hundred');
    expect(formatOf(null, 2, null)).toBe('time');
    expect(formatOf(null, 1, null, 'U11 T20 2025')).toBe('T20');
    expect(formatOf(null, 1, 40 * 6)).toBe('long');
    expect(formatOf(null, 1, 20 * 6)).toBe('T20');
    expect(formatOf(null, 1, 14 * 6)).toBe('unknown');
  });

  it.each([
    ['GM Old Summit U13 Prem 2025', 'GM Old Summit'],
    ['St Judes 3rd XI 2025', 'St Judes'],
    ['Riverside CC SU1 2025', 'Riverside'],
    ['University of Highveld Pres B 2025', 'University of Highveld'],
    ['Old Meadow 1 U9 Div 2 2025', 'Old Meadow'],
    ['Riverside (2) U13 Div 1 2025', 'Riverside'],
    ['Fernhill Old Boys', 'Fernhill Old Boys'],
    ['Hoerskool Westvale Girls2025', 'Hoerskool Westvale'],
    ['Granite City SA20 Girls 2025', 'Granite City'],
    ['Summit Noord 3de Xl', 'Summit Noord'],
    ['Brookfield Kestrel 4th Team', 'Brookfield Kestrel'],
    ['Lakeside OPENS U13A 2026', 'Lakeside'],
    ['Valley High School For Girls 1st', 'Valley High School'],
  ])('%s → %s', (name, club) => {
    expect(clubName(name)).toBe(club);
  });

  it('keeps the side but drops the season', () => {
    expect(sideName('Riverside CC SU1 2025')).toBe('Riverside CC SU1');
    expect(sideName('Fernhill SA5 25/26')).toBe('Fernhill SA5');
  });
});

describe('ladders and summaries', () => {
  const ms = parseResults(EXPORT);
  const sunday = ms.filter((m) => m.competition === 'Sunday One 25/26');

  it('counts results per side with net run rate and batting-first wins', () => {
    const rows = ladder(sunday).sort(ladderSort);
    const riverside = rows.find((r) => r.label === 'Riverside CC SU1')!;
    expect(riverside).toMatchObject({ played: 4, won: 3, lost: 0, tied: 1, nr: 0, winPct: 88 });
    // Forfeit wins count, but carry no runs or overs.
    expect(riverside.runsFor).toBe(181 + 141 + 150);
    expect(riverside.nrr).toBeGreaterThan(0);
    expect(riverside.batFirst).toEqual({ games: 2, won: 1 });
    expect(riverside.biggestWin).toMatch(/^93 Runs v Westvale CC SU1$/);
    const summit = rows.find((r) => r.label === 'Old Summit SU1')!;
    expect(summit).toMatchObject({ played: 3, won: 1, lost: 1, tied: 1, nr: 1 });
    expect(outcomeFor(ms.find((m) => m.id === '104')!, 0)).toBe('NR');
    expect(rows[0].label).toBe('Riverside CC SU1');
  });

  it('summarises a competition: close games, abandonments, batting first', () => {
    const c = competitionSummaries(sunday)[0];
    expect(c).toMatchObject({
      competition: 'Sunday One 25/26',
      tier: 'club-league',
      matches: 6,
      abandoned: 1,
    });
    expect(c.closePct).toBe(25); // the tie, of four decided games
    expect(c.batFirstWinPct).toBe(25);
    expect(c.teams).toBe(3);
    expect(c.avgFirstInnings).toBe(Math.round((181 + 140 + 150 + 160) / 4));
  });

  it('builds the pyramid, coverage, pipeline and calendar', () => {
    const p = pyramid(ms);
    expect(p.map((t) => t.tier)).toEqual([
      'primary',
      'high-school',
      'club-league',
      'presidents',
      'representative',
    ]);
    expect(p.find((t) => t.tier === 'club-league')!.matches).toBe(6);
    const cov = coverage(ms);
    expect(cov.cell('primary', 'U13')).toBe(1);
    expect(cov.cell('club-league', 'Open')).toBe(6);
    const pipe = pipeline(ms);
    const riverside = pipe.find((r) => r.club === 'Riverside')!;
    expect(riverside.tiers).toEqual(['presidents', 'club-league']);
    expect(riverside.topTier).toBe('presidents');
    const valley = pipe.find((r) => r.club === 'Valley High')!;
    expect(valley.site).toBe('school');
    expect(valley.genders.sort()).toEqual(['men', 'women']);
    const cal = calendar(sunday);
    expect(cal[0].week).toBe('2025-09-29');
    expect(cal).toHaveLength(6);
    expect(cal.map((w) => w.total)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(weekOf('2025-10-05')).toBe('2025-09-29');
    expect(marginBands(sunday)).toMatchObject({ ties: 1 });
    expect(marginBands(sunday).runs.find((b) => b.label === '61–100')!.n).toBe(1);
  });

  it('filters by site, tier, gender, dates, practice and a team search', () => {
    expect(filterMatches(ms, {})).toHaveLength(10); // practice left out
    expect(filterMatches(ms, { practice: true })).toHaveLength(11);
    expect(filterMatches(ms, { site: 'school' })).toHaveLength(3);
    expect(filterMatches(ms, { tier: 'presidents' })).toHaveLength(1);
    expect(filterMatches(ms, { gender: 'women' })).toHaveLength(1);
    expect(filterMatches(ms, { from: '2026-01-01' })).toHaveLength(3);
    expect(filterMatches(ms, { team: 'summit' })).toHaveLength(4);
    expect(filterMatches(ms, { format: 'time' })).toHaveLength(1);
  });
});

describe('the invented sample', () => {
  it('reads into every tier of the pathway and is the same every time', () => {
    const a = buildSampleResults();
    expect(a).toBe(buildSampleResults());
    const ms = parseResults(a);
    expect(ms.length).toBeGreaterThan(250);
    const tiers = new Set(ms.map((m) => m.tier));
    for (const t of [
      'primary',
      'club-junior',
      'high-school',
      'club-league',
      'presidents',
      'premier',
      'representative',
    ])
      expect(tiers.has(t as never)).toBe(true);
    expect(ms.some((m) => m.gender === 'women')).toBe(true);
    expect(ms.some((m) => m.result.kind === 'abandoned')).toBe(true);
    expect(ms.filter((m) => m.result.kind === 'unknown')).toHaveLength(0);
  });
});

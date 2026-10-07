/**
 * An invented results export for the Pathways view: a fictional union ("Highveld") with made-up
 * schools and clubs, written in the site export's own CSV layout so the real reader is what
 * runs in tests, CI and a fresh clone. Deterministic (a seeded generator), about 450 matches
 * from primary schools to the premier league and representative weeks.
 */

const SCHOOLS = [
  'Northgate Prep',
  'Lakeside Primary',
  'Hillcrest College',
  'Valley High',
  'Ridgeway High',
  'Summit College',
  'Brookfield Prep',
  'Stonebridge High',
];
const CLUBS = [
  'Highveld Hawks',
  'Coastal Kestrels',
  'Riverside',
  'Old Summit',
  'Westvale',
  'Meadow Park',
  'Granite City',
  'Fernhill',
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Comp {
  site: 'Club (Highveld)' | 'Schools (HighveldSchools)';
  competition: string;
  division: string;
  type: string;
  teams: string[];
  overs: number | null;
  /** Typical first-innings total and spread. */
  mean: number;
  spread: number;
  start: string;
  weeks: number;
  rounds: number;
}

const comps: Comp[] = [
  ...[
    ['U9A 2026', 9],
    ['U11A 2026', 11],
    ['U13A 2026', 13],
  ].map(
    ([div, age]): Comp => ({
      site: 'Schools (HighveldSchools)',
      competition: 'Highveld Primary Schools 2026',
      division: String(div),
      type: 'League',
      teams: SCHOOLS.slice(0, 6).map((s) => `${s} U${age}A 2026`),
      overs: age === 9 ? 20 : 35,
      mean: age === 9 ? 70 : age === 11 ? 110 : 140,
      spread: 35,
      start: '2026-01-20',
      weeks: 10,
      rounds: 1,
    }),
  ),
  {
    site: 'Schools (HighveldSchools)',
    competition: 'Highveld High Schools 2026',
    division: 'U15A 2026 T20',
    type: 'League',
    teams: SCHOOLS.slice(2, 8).map((s) => `${s} U15A 2026`),
    overs: 20,
    mean: 130,
    spread: 35,
    start: '2026-01-24',
    weeks: 8,
    rounds: 1,
  },
  {
    site: 'Schools (HighveldSchools)',
    competition: 'Highveld High Schools 2026',
    division: '1st XI 2026 50 over',
    type: 'League',
    teams: SCHOOLS.slice(2, 8).map((s) => `${s} 1st XI 2026`),
    overs: 50,
    mean: 190,
    spread: 50,
    start: '2026-01-31',
    weeks: 8,
    rounds: 1,
  },
  {
    site: 'Schools (HighveldSchools)',
    competition: 'Highveld Girls T20 2026',
    division: 'Girls 2026 T20',
    type: 'League',
    teams: SCHOOLS.slice(1, 6).map((s) => `${s} Girls 1st Team`),
    overs: 20,
    mean: 95,
    spread: 30,
    start: '2026-02-07',
    weeks: 6,
    rounds: 1,
  },
  {
    site: 'Club (Highveld)',
    competition: 'U11 Club Junior Premier',
    division: '',
    type: 'League',
    teams: CLUBS.slice(0, 6).map((c) => `${c} U11 Prem 2025`),
    overs: 30,
    mean: 100,
    spread: 30,
    start: '2025-10-04',
    weeks: 10,
    rounds: 1,
  },
  {
    site: 'Club (Highveld)',
    competition: 'U13 Club Junior Premier',
    division: '',
    type: 'League',
    teams: CLUBS.slice(0, 6).map((c) => `${c} U13 Prem 2025`),
    overs: 35,
    mean: 130,
    spread: 35,
    start: '2025-10-05',
    weeks: 10,
    rounds: 1,
  },
  {
    site: 'Club (Highveld)',
    competition: 'Sunday One 25/26',
    division: '',
    type: 'League',
    teams: CLUBS.map((c) => `${c} CC SU1 2025`),
    overs: null,
    mean: 170,
    spread: 50,
    start: '2025-09-14',
    weeks: 22,
    rounds: 2,
  },
  {
    site: 'Club (Highveld)',
    competition: 'Sunday Two 25/26',
    division: '',
    type: 'League',
    teams: CLUBS.map((c) => `${c} CC SU2 2025`),
    overs: null,
    mean: 150,
    spread: 50,
    start: '2025-09-14',
    weeks: 22,
    rounds: 2,
  },
  {
    site: 'Club (Highveld)',
    competition: 'Saturday One 25/26',
    division: '',
    type: 'League',
    teams: CLUBS.slice(0, 6).map((c) => `${c} SA1 2025`),
    overs: 20,
    mean: 140,
    spread: 40,
    start: '2025-09-13',
    weeks: 16,
    rounds: 1,
  },
  {
    site: 'Club (Highveld)',
    competition: 'Highveld Pres A 25/26',
    division: '',
    type: 'League',
    teams: CLUBS.slice(0, 6).map((c) => `${c} Pres A 2025`),
    overs: 50,
    mean: 210,
    spread: 55,
    start: '2025-09-20',
    weeks: 20,
    rounds: 1,
  },
  {
    site: 'Club (Highveld)',
    competition: 'Highveld Premier League 25/26',
    division: '',
    type: 'League',
    teams: CLUBS.slice(0, 4).map((c) => `${c} Prem A 2025`),
    overs: 50,
    mean: 230,
    spread: 50,
    start: '2025-10-11',
    weeks: 14,
    rounds: 2,
  },
  {
    site: 'Club (Highveld)',
    competition: "Highveld Women's Premier 25/26",
    division: '',
    type: 'League',
    teams: CLUBS.slice(2, 7).map((c) => `${c} CC Women`),
    overs: 40,
    mean: 150,
    spread: 45,
    start: '2025-10-12',
    weeks: 12,
    rounds: 1,
  },
  {
    site: 'Schools (HighveldSchools)',
    competition: 'Highveld High Schools Trials 2025',
    division: 'U15s Trials 2025',
    type: 'Practice',
    teams: ['Highveld Red U15 2025', 'Highveld Blue U15 2025', 'Highveld Gold U15 2025'],
    overs: 50,
    mean: 180,
    spread: 40,
    start: '2025-11-01',
    weeks: 2,
    rounds: 2,
  },
  {
    site: 'Schools (HighveldSchools)',
    competition: 'Primary Schools Area Week 2025',
    division: 'U13 50 Over 2025',
    type: 'League',
    teams: ['North U13 2025', 'South U13 2025', 'East U13 2025', 'West U13 2025'],
    overs: 50,
    mean: 160,
    spread: 40,
    start: '2025-12-06',
    weeks: 1,
    rounds: 1,
  },
  {
    site: 'Schools (HighveldSchools)',
    competition: 'Highveld Cup Primary Schools 2025',
    division: 'Highveld Cup U13 2025',
    type: 'Semi final',
    teams: SCHOOLS.slice(0, 4).map((s) => `${s} U13A 2025`),
    overs: 35,
    mean: 140,
    spread: 35,
    start: '2025-11-15',
    weeks: 1,
    rounds: 1,
  },
];

const VENUES = [
  'Northgate Oval',
  'Lakeside Main',
  'Hillcrest A Field',
  'Valley Park',
  'Riverside Ground',
  'Summit Oval',
  '',
];

const HEAD =
  'Site,Competition,Division,Match Type,Date,Team 1,Team 1 Score,Team 1 Overs,Team 2,Team 2 Score,Team 2 Overs,Result,Venue,Status,Match ID';
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const ov = (balls: number) => `${Math.floor(balls / 6)}${balls % 6 ? `.${balls % 6}` : ''}`;

export function buildSampleResults(seed = 7): string {
  const rand = rng(seed);
  const lines = [HEAD];
  let id = 5000;
  for (const c of comps) {
    // A strength per side, so ladders have a top and a bottom.
    const strength = new Map(c.teams.map((t) => [t, rand()]));
    const pairs: [string, string][] = [];
    for (let r = 0; r < c.rounds; r++)
      for (let i = 0; i < c.teams.length; i++)
        for (let j = i + 1; j < c.teams.length; j++)
          pairs.push(r % 2 ? [c.teams[j], c.teams[i]] : [c.teams[i], c.teams[j]]);
    pairs.forEach(([a, b], k) => {
      const d = new Date(`${c.start}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + Math.floor((k / pairs.length) * c.weeks) * 7 + (k % 2));
      const date = iso(d);
      const venue = VENUES[Math.floor(rand() * VENUES.length)];
      id++;
      const roll = rand();
      if (roll < 0.12) {
        lines.push(
          [
            c.site,
            c.competition,
            c.division,
            c.type,
            date,
            a,
            '',
            '',
            b,
            '',
            '',
            'Abandoned.',
            venue,
            '',
            String(id),
          ]
            .map(q)
            .join(','),
        );
        return;
      }
      const sa = strength.get(a)! - strength.get(b)!;
      const overs = c.overs ?? (c.competition.startsWith('Sunday') ? 45 : 50);
      const r1 = Math.max(40, Math.round(c.mean + sa * 40 + (rand() - 0.5) * c.spread));
      const w1 = Math.min(10, Math.floor(rand() * 7 + (sa < 0 ? 4 : 2)));
      const b1 = w1 === 10 ? Math.round(overs * 6 * (0.6 + rand() * 0.35)) : overs * 6;
      const chaseWins = rand() < 0.5 - sa * 0.6;
      let r2: number;
      let w2: number;
      let b2: number;
      let result: string;
      if (chaseWins) {
        r2 = r1 + 1 + Math.floor(rand() * 6);
        w2 = Math.min(9, Math.floor(rand() * 8));
        b2 = Math.round(overs * 6 * (0.55 + rand() * 0.44));
        result = `${b} won by ${10 - w2} Wickets`;
      } else {
        const tie = rand() < 0.03;
        r2 = tie ? r1 : Math.max(20, r1 - 1 - Math.floor(rand() * Math.max(8, r1 * 0.45)));
        w2 = tie ? 7 : rand() < 0.6 ? 10 : Math.floor(rand() * 9);
        b2 = w2 === 10 ? Math.round(overs * 6 * (0.5 + rand() * 0.45)) : overs * 6;
        result = tie ? 'It is a Tie' : `${a} won by ${r1 - r2} Runs`;
      }
      const o = (balls: number) => (c.overs ? `${ov(balls)}/${c.overs}` : ov(balls));
      lines.push(
        [
          c.site,
          c.competition,
          c.division,
          c.type,
          date,
          a,
          `${r1}/${w1}`,
          o(b1),
          b,
          `${r2}/${w2}`,
          o(b2),
          result,
          venue,
          c.site.startsWith('Schools') ? 'Completed' : '',
          String(id),
        ]
          .map(q)
          .join(','),
      );
    });
  }
  return lines.join('\n');
}

export const SAMPLE_RESULTS_CSV = buildSampleResults();

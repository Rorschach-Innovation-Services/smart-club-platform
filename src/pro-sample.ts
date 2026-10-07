/**
 * Fictional professional-team data for builds without the confidential files (CI, deploys, a
 * fresh clone): a made-up franchise, the "Highveld Hawks", men and women, two seasons of
 * scorecards against made-up opponents, plus a made-up scouting pool. Every name is invented.
 * Generated from a fixed seed so it never changes between builds.
 */
import type { ScoutBatRow, ScoutBowlRow, ScoutInnings } from './scouting-matches';
import { seasonOf, type Gender, type ProFormat, type ProMatch } from './pro-scorecards';
import type { PoolPlayer, ScoutPool } from './scout-pool';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_M = [
  'Aiden',
  'Bongani',
  'Caleb',
  'Dewald',
  'Ethan',
  'Faizel',
  'Gideon',
  'Hendrik',
  'Imraan',
  'Jabu',
  'Kian',
  'Lwazi',
  'Mpho',
  'Nathan',
  'Ockert',
  'Pieter',
  'Riyaad',
  'Sizwe',
  'Thabiso',
  'Uriel',
  'Vusi',
  'Wian',
];
const FIRST_W = [
  'Amahle',
  'Bianca',
  'Carla',
  'Dineo',
  'Elsabe',
  'Farah',
  'Gugu',
  'Hanna',
  'Iman',
  'Jodie',
  'Karabo',
  'Lerato',
  'Mia',
  'Nandi',
  'Olwethu',
  'Palesa',
  'Reabetswe',
  'Sune',
  'Thandi',
  'Zinhle',
];
const LAST = [
  'Achterberg',
  'Bekwa',
  'Cloete',
  'Dube',
  'Esterhuyse',
  'Fourie',
  'Gwala',
  'Hlongwa',
  'Isaacs',
  'Joubert',
  'Khumalo',
  'Liebenberg',
  'Mabaso',
  'Naidoo',
  'Olivier',
  'Pillai',
  'Rademeyer',
  'Sithole',
  'Theron',
  'Van Rooyen',
  'Wessels',
  'Zwane',
  'Moodley',
  'Botha',
  'Ndlela',
  'Kruger',
  'Mthembu',
  'Swart',
];
const OPPONENTS = [
  'Coastal Kestrels',
  'Karoo Jackals',
  'Bushveld Rhinos',
  'Cape Mariners',
  'Lowveld Leopards',
  'Midlands Owls',
];

function squadNames(r: () => number, first: string[], n: number, used: Set<string>) {
  const out: string[] = [];
  while (out.length < n) {
    const name = `${first[Math.floor(r() * first.length)]} ${LAST[Math.floor(r() * LAST.length)]}`;
    if (used.has(name)) continue;
    used.add(name);
    out.push(name);
  }
  return out;
}

interface Profile {
  name: string;
  /** Mean runs per innings and strike rate when batting in the top order. */
  bat: number;
  sr: number;
  bowl: boolean;
  econ: number;
  wkt: number;
}

function innings(
  r: () => number,
  bat: string,
  fld: string,
  batting: Profile[],
  bowling: Profile[],
  format: ProFormat,
  target: number | null,
): ScoutInnings {
  const maxBalls = format === 'T20' ? 120 : format === 'One-Day' ? 300 : 600;
  const fmtSR = format === 'T20' ? 1.35 : format === 'One-Day' ? 0.85 : 0.55;
  const rows: ScoutBatRow[] = [];
  const fow: ScoutInnings['fow'] = [];
  let balls = 0;
  let score = 0;
  let wkts = 0;
  const bowlers = bowling.filter((p) => p.bowl).slice(0, format === 'T20' ? 5 : 6);
  const dismissedBy: string[] = [];
  for (let i = 0; i < 11; i++) {
    const p = batting[i];
    if (wkts >= 10 || balls >= maxBalls || (target !== null && score > target)) break;
    const form = 0.4 + r() * 1.4;
    const sr = Math.max(30, p.sr * fmtSR * (0.7 + r() * 0.6));
    let faced = Math.round(((p.bat * form) / sr) * 100 * (format === 'Multi-day' ? 1.6 : 1));
    faced = Math.max(1, Math.min(faced, maxBalls - balls));
    let runs = Math.round((faced * sr) / 100);
    if (target !== null && score + runs > target) runs = target - score + 1 + Math.floor(r() * 4);
    balls += faced;
    score += runs;
    const out = balls < maxBalls && !(target !== null && score > target) && i < 10;
    const f6 = format === 'Multi-day' ? Math.floor(r() * 2) : Math.floor((runs / 30) * r() * 2);
    const f4 = Math.max(0, Math.floor(((runs - f6 * 6) / 4) * (0.3 + r() * 0.3)));
    const dots = Math.max(0, Math.round(faced * (0.3 + r() * 0.3)));
    let how = 'not out';
    if (out) {
      const bw = bowlers[Math.floor(r() * bowlers.length)];
      const k = r();
      const fielder = bowling[Math.floor(r() * bowling.length)].name;
      how =
        k < 0.55
          ? `c ${fielder} b ${bw.name}`
          : k < 0.75
            ? `b ${bw.name}`
            : k < 0.92
              ? `lbw b ${bw.name}`
              : `run out (${fielder})`;
      if (!how.startsWith('run out')) dismissedBy.push(bw.name);
      wkts++;
      fow.push({ wkt: wkts, score, batter: p.name, over: `${Math.floor(balls / 6)}.${balls % 6}` });
    }
    rows.push({
      n: p.name,
      pos: i + 1,
      r: runs,
      b: faced,
      f4,
      f6,
      out: how,
      dots: Math.min(dots, faced),
    });
  }
  const w = Math.floor(r() * (format === 'T20' ? 8 : 12));
  const nb = Math.floor(r() * 3);
  const lb = Math.floor(r() * 5);
  const extras = w + nb + lb;
  const total = score + extras;
  // Bowling: share the legal balls out in whole overs, runs in proportion to economy.
  const overs = Math.floor(balls / 6);
  const rem = balls % 6;
  const share = bowlers.map(() => 0);
  const cap = format === 'T20' ? 4 : format === 'One-Day' ? 10 : 99;
  for (let o = 0; o < overs; o++) {
    let k = o % bowlers.length;
    for (let t = 0; t < bowlers.length && share[k] >= cap; t++) k = (k + 1) % bowlers.length;
    share[k]++;
  }
  const weight = bowlers.map((b, i) => share[i] * b.econ);
  const W = weight.reduce((a, b) => a + b, 0) || 1;
  let left = total - lb;
  const figures: ScoutBowlRow[] = bowlers
    .map((b, i) => {
      const ov = share[i];
      const runs = i === bowlers.length - 1 ? left : Math.round(((total - lb) * weight[i]) / W);
      left -= runs;
      return {
        n: b.name,
        o: i === 0 && rem ? `${ov}.${rem}` : String(ov),
        m: format === 'T20' ? 0 : Math.floor(r() * 2),
        r: Math.max(0, runs),
        w: dismissedBy.filter((n) => n === b.name).length,
        wd: i === 0 ? w : 0,
        nb: i === 1 ? nb : 0,
        dots: Math.round(ov * 6 * (format === 'T20' ? 0.35 : 0.55) * (0.8 + r() * 0.4)),
      };
    })
    .filter((b) => b.o !== '0');
  const oversStr = `${overs}${rem ? `.${rem}` : ''}`;
  return {
    bat,
    fld,
    total,
    wkts,
    overs: oversStr,
    extras,
    exb: { w, nb, b: 0, lb },
    batting: rows,
    bowling: figures,
    fow,
    perOver: [],
  };
}

function squadProfiles(r: () => number, names: string[]): Profile[] {
  return names.map((name, i) => ({
    name,
    bat: i < 6 ? 22 + r() * 20 : i < 8 ? 14 + r() * 10 : 4 + r() * 6,
    sr: 90 + r() * 50,
    bowl: i >= 5,
    econ: 0.8 + r() * 0.5,
    wkt: r(),
  }));
}

function build(gender: Gender, seed: number): ProMatch[] {
  const r = rng(seed);
  const used = new Set<string>();
  const first = gender === 'men' ? FIRST_M : FIRST_W;
  const us = gender === 'men' ? 'Highveld Hawks' : 'Highveld Hawks Women';
  const pool = squadProfiles(r, squadNames(r, first, 15, used));
  const opps = OPPONENTS.map((o) => ({
    name: gender === 'men' ? o : `${o} Women`,
    players: squadProfiles(r, squadNames(r, first, 11, used)),
  }));
  const out: ProMatch[] = [];
  const formats: ProFormat[] =
    gender === 'men' ? ['T20', 'One-Day', 'Multi-day'] : ['T20', 'One-Day'];
  let day = Date.UTC(2024, 8, 20);
  for (let k = 0; k < (gender === 'men' ? 30 : 20); k++) {
    const format = formats[k % formats.length];
    const opp = opps[k % opps.length];
    // Pick an XI: the regulars plus a rotation, the way a coach does.
    const xi = [...pool.slice(0, 9), pool[9 + (k % 3)], pool[12 + (k % 3)]];
    day += (k % 6 === 5 ? 120 : 9) * 86_400_000;
    const date = new Date(day).toISOString().slice(0, 10);
    const weFirst = r() < 0.5;
    const a = weFirst ? { name: us, xi } : { name: opp.name, xi: opp.players };
    const b = weFirst ? { name: opp.name, xi: opp.players } : { name: us, xi };
    const inns: ScoutInnings[] = [];
    const i1 = innings(r, a.name, b.name, a.xi, b.xi, format, null);
    inns.push(i1);
    if (format === 'Multi-day') {
      const i2 = innings(r, b.name, a.name, b.xi, a.xi, format, null);
      const i3 = innings(r, a.name, b.name, a.xi, b.xi, format, null);
      const need = i1.total + i3.total - i2.total;
      inns.push(i2, i3, innings(r, b.name, a.name, b.xi, a.xi, format, need));
    } else inns.push(innings(r, b.name, a.name, b.xi, a.xi, format, i1.total));
    const tot = (t: string) => inns.filter((i) => i.bat === t).reduce((n, i) => n + i.total, 0);
    const last = inns[inns.length - 1];
    const lastSide = last.bat;
    const other = lastSide === a.name ? b.name : a.name;
    let winner: string | null = null;
    let result = 'Draw';
    let resultKind: ProMatch['resultKind'] = 'draw';
    if (tot(lastSide) > tot(other)) {
      winner = lastSide;
      result = `${lastSide} won by ${10 - last.wkts} wickets`;
      resultKind = 'wickets';
    } else if (last.wkts >= 10 || format !== 'Multi-day') {
      winner = other;
      result = `${other} won by ${tot(other) - tot(lastSide)} runs`;
      resultKind = 'runs';
    }
    out.push({
      id: `sample-${gender}-${k + 1}`,
      date,
      event: format,
      stage: '',
      overs: format === 'T20' ? 20 : format === 'One-Day' ? 50 : 0,
      venue: '',
      home: k % 2 ? us : opp.name,
      away: k % 2 ? opp.name : us,
      winner,
      result,
      innings: inns,
      format,
      gender,
      season: seasonOf(date),
      resultKind,
    });
  }
  return out;
}

export const SAMPLE_PRO_MATCHES: ProMatch[] = [...build('men', 7), ...build('women', 11)].sort(
  (x, y) => x.date.localeCompare(y.date),
);

function poolPlayers(): PoolPlayer[] {
  const r = rng(23);
  const used = new Set<string>();
  const unions = ['Highveld', 'Coastal', 'Inland', 'Western'];
  const clubs = [
    'Ridgeview CC',
    'Old Collegians',
    'Riverside',
    'Parkhurst Wanderers',
    'Hilltop CC',
    'Station XI',
  ];
  return squadNames(r, FIRST_M, 30, used).map((name, i): PoolPlayer => {
    const role = (['Batter', 'Bowler', 'All-rounder', 'Wicketkeeper'] as const)[i % 4];
    const bats = role !== 'Bowler';
    const bowls = role === 'Bowler' || role === 'All-rounder';
    const balls = 40 + Math.floor(r() * 120);
    const sr = 110 + Math.floor(r() * 90);
    const overs = 8 + Math.floor(r() * 12);
    const econ = Math.round((4 + r() * 4) * 10) / 10;
    return {
      name,
      club: clubs[i % clubs.length],
      union: unions[i % unions.length],
      role,
      games: 2 + Math.floor(r() * 4),
      bat: bats
        ? {
            runs: Math.round((balls * sr) / 100),
            balls,
            sr,
            batIdx: 100 + Math.floor(r() * 120),
            srIdx: 95 + Math.floor(r() * 70),
          }
        : undefined,
      bowl: bowls
        ? {
            overs: String(overs),
            runs: Math.round(overs * econ),
            wkts: 2 + Math.floor(r() * 8),
            econ,
            bowlIdx: 100 + Math.floor(r() * 90),
            dotPct: 40 + Math.floor(r() * 30),
          }
        : undefined,
      impact: 40 + Math.floor(r() * 40),
      lists: i < 10 ? ['Top 30 impact'] : [],
      note: i < 6 ? 'Sample player — invented for the demo build.' : undefined,
    };
  });
}

export const SAMPLE_POOL: ScoutPool = {
  id: 'sample-pool',
  name: 'Sample club T20 pool',
  gender: 'men',
  format: 'T20',
  source: 'Invented sample data',
  date: '2026-10-01',
  players: poolPlayers(),
};

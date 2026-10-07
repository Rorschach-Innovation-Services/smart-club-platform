/**
 * An invented set of player journeys, so the Pathways player views can be seen before the union's
 * own records are loaded. Every name, school, club and number here is made up; nothing is taken
 * from a real player. Deterministic (a seeded generator), so the pages and tests are stable.
 *
 * The invented world: eight schools and five clubs in the Highveld, one franchise (the Hawks),
 * eleven seasons (2016–2026), players born 1998–2016. Players are only recorded from 2016, so
 * the oldest cohorts appear mid-way up the ladder and the youngest only at the bottom — exactly
 * the shape real data has before it has run for a decade. Talent, a yearly growth rate (a few
 * late bloomers), and drop-out at the usual leaks (leaving school, the first club year) drive
 * who stays, who moves up, who reaches the franchise and who leaves.
 */
import type { JourneyPlayer, SeasonRow, Innings, Spell, Bracket, Format, Gender } from './journeys';

export const SAMPLE_SCHOOLS = [
  { name: 'Hawthorn College', weight: 1.6 },
  { name: "St Aldric's", weight: 1.5 },
  { name: 'Bluegum Ridge', weight: 1.1 },
  { name: 'Eastgate Academy', weight: 1 },
  { name: 'Marlow Park', weight: 1 },
  { name: 'Northvale College', weight: 0.9 },
  { name: 'Cedar Hill', weight: 0.7 },
  { name: 'Sunridge High', weight: 0.6 },
];
const CLUBS = ['Riverside CC', 'Highveld CC', 'Westend CC', 'Parkview CC', 'Lakeside CC'];
const FRANCHISE = 'Highveld Hawks';

const BOYS = [
  'Aiden',
  'Luca',
  'Kabelo',
  'Ryan',
  'Tumelo',
  'Ethan',
  'Bongani',
  'Caleb',
  'Neo',
  'Jaden',
  'Lwazi',
  'Dylan',
  'Katlego',
  'Mason',
  'Sizwe',
  'Oliver',
  'Themba',
  'Jayden',
  'Lethabo',
  'Noah',
  'Reuben',
  'Siya',
  'Connor',
  'Mpho',
  'Gareth',
  'Tshepo',
  'Ruben',
  'Andile',
  'Zane',
  'Kyle',
  'Lunga',
  'Declan',
  'Palesa-Jay',
  'Armand',
  'Nkosi',
  'Wesley',
  'Thando',
  'Hayden',
  'Musa',
  'Bryce',
];
const GIRLS = [
  'Amara',
  'Lerato',
  'Chloe',
  'Naledi',
  'Emma',
  'Zinhle',
  'Maya',
  'Boitumelo',
  'Ayesha',
  'Kayla',
  'Thandi',
  'Isabel',
  'Nomsa',
  'Hannah',
  'Refilwe',
  'Sienna',
  'Anele',
  'Tegan',
  'Khanyi',
  'Jade',
];
const SURNAMES = [
  'Abrams',
  'Bekker',
  'Cele',
  'Dlamini',
  'Engelbrecht',
  'Fourie',
  'Gumede',
  'Hlongwane',
  'Ismail',
  'Jordaan',
  'Khumalo',
  'Lombard',
  'Mahlangu',
  'Naicker',
  'Olivier',
  'Pillay',
  'Qwabe',
  'Radebe',
  'Steyn',
  'Tladi',
  'Uys',
  'Vilakazi',
  'Wessels',
  'Xaba',
  'Yende',
  'Zondi',
  'Basson',
  'Coetzee',
  'Dube',
  'Erasmus',
  'Fakude',
  'Gouws',
  'Hendricks',
  'Jacobs',
  'Kruger',
  'Letsoalo',
  'Malan',
  'Nkuna',
  'Oosthuizen',
  'Pretorius',
  'Rossouw',
  'Sibiya',
  'Terblanche',
  'Venter',
  'Weideman',
  'Mthembu',
  'Naidu',
  'Botha',
  'Cloete',
  'Mokwena',
];

export const SAMPLE_FIRST_SEASON = 2016;
export const SAMPLE_LATEST_SEASON = 2026;

/** Small seeded generator (mulberry32), so the sample never changes between runs. */
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

const bracketOfAge = (age: number): Bracket =>
  age <= 8
    ? 'U9'
    : age <= 10
      ? 'U11'
      : age <= 12
        ? 'U13'
        : age <= 14
          ? 'U15'
          : age <= 16
            ? 'U17'
            : age <= 18
              ? 'U19'
              : 'Senior';

/** Mean runs in an innings by bracket, and balls-per-100-runs (strike-rate) by bracket and format. */
const BASE_RUNS: Record<Bracket, number> = {
  U9: 11,
  U11: 14,
  U13: 17,
  U15: 20,
  U17: 23,
  U19: 26,
  Senior: 25,
  Pro: 27,
};
const BASE_SR: Record<Bracket, number> = {
  U9: 55,
  U11: 62,
  U13: 68,
  U15: 74,
  U17: 78,
  U19: 82,
  Senior: 80,
  Pro: 92,
};
const SPELL_CAP: Record<Bracket, number> = {
  U9: 2,
  U11: 3,
  U13: 4,
  U15: 5,
  U17: 6,
  U19: 7,
  Senior: 8,
  Pro: 4,
};
const BASE_ECO: Record<Bracket, number> = {
  U9: 6.6,
  U11: 6.3,
  U13: 5.9,
  U15: 5.6,
  U17: 5.3,
  U19: 5.2,
  Senior: 5.2,
  Pro: 7.4,
};

interface Talent {
  bat: number;
  bowl: number;
  growth: number;
  role: 'bat' | 'bowl' | 'all';
}

function build(): JourneyPlayer[] {
  const rand = rng(20260607);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const norm = () => {
    let s = 0;
    for (let i = 0; i < 6; i++) s += rand();
    return (s - 3) / 0.7071;
  };
  const expo = (mean: number) => -mean * Math.log(1 - rand());
  const poisson = (lam: number) => {
    const L = Math.exp(-lam);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= rand();
    } while (p > L && k < 20);
    return k - 1;
  };
  const weighted = () => {
    const total = SAMPLE_SCHOOLS.reduce((a, s) => a + s.weight, 0);
    let x = rand() * total;
    for (const s of SAMPLE_SCHOOLS) if ((x -= s.weight) <= 0) return s.name;
    return SAMPLE_SCHOOLS[0].name;
  };

  const used = new Set<string>();
  const nameFor = (g: Gender) => {
    for (;;) {
      const n = `${pick(g === 'men' ? BOYS : GIRLS)} ${pick(SURNAMES)}`;
      if (!used.has(n)) {
        used.add(n);
        return n;
      }
    }
  };

  const innings = (
    t: Talent,
    bracket: Bracket,
    fmt: Format,
    age0: number,
    age: number,
  ): Innings => {
    const s = Math.min(2.2, t.bat + t.growth * (age - age0));
    const mean =
      BASE_RUNS[bracket] *
      Math.exp(0.32 * s) *
      (t.role === 'bowl' ? 0.55 : 1) *
      (fmt === 'T20' ? 0.92 : 1);
    const failed = rand() < 0.2;
    const runs = failed ? Math.floor(rand() * 4) : Math.floor(expo(mean));
    const sr =
      BASE_SR[bracket] * Math.exp(0.1 * s) * (fmt === 'T20' ? 1.18 : 1) * (0.8 + rand() * 0.4);
    const cap = (fmt === 'T20' ? 20 : 40) * 6;
    const balls = Math.min(
      cap,
      Math.max(1, Math.round((runs / sr) * 100) + (rand() < 0.3 ? 1 : 0)),
    );
    return { r: runs, b: balls, out: rand() < (t.role === 'bowl' ? 0.9 : 0.8) };
  };
  const spell = (t: Talent, bracket: Bracket, fmt: Format, age0: number, age: number): Spell => {
    const s = Math.min(2.2, t.bowl + t.growth * (age - age0));
    const cap = Math.min(SPELL_CAP[bracket], fmt === 'T20' ? 4 : 99);
    const overs = 1 + Math.floor(rand() * cap);
    const eco =
      BASE_ECO[bracket] * Math.exp(-0.09 * s) + (fmt === 'T20' && bracket !== 'Pro' ? 1.4 : 0);
    const runs = Math.max(0, Math.round(eco * overs * (0.7 + rand() * 0.6)));
    const w = poisson(overs * 0.27 * Math.exp(0.25 * s) * (fmt === 'T20' ? 0.9 : 1));
    return { b: overs * 6, r: runs, w };
  };
  const team = (
    p: { id: string; rows: SeasonRow[] },
    t: Talent,
    base: {
      season: number;
      setting: SeasonRow['setting'];
      team: string;
      level: string;
      bracket: Bracket;
    },
    age0: number,
    age: number,
    games: number,
    fmts: Format[],
  ) => {
    fmts.forEach((format, k) => {
      const g = k === 0 ? Math.ceil(games * 0.55) : Math.floor(games * 0.45);
      if (!g) return;
      const bat: Innings[] = [];
      const bowl: Spell[] = [];
      for (let i = 0; i < g; i++) {
        if (rand() < (t.role === 'bowl' ? 0.55 : 0.88))
          bat.push(innings(t, base.bracket, format, age0, age));
        if (t.role !== 'bat' && rand() < (t.role === 'bowl' ? 0.92 : 0.7))
          bowl.push(spell(t, base.bracket, format, age0, age));
      }
      p.rows.push({ ...base, format, games: g, bat, bowl });
    });
  };

  const players: JourneyPlayer[] = [];
  let n = 0;
  for (let born = 1998; born <= 2016; born++) {
    for (let k = 0; k < 16; k++) {
      const gender: Gender = k >= 12 ? 'women' : 'men';
      if (gender === 'women' && born < 1999) continue;
      const id = `J${String(++n).padStart(3, '0')}`;
      const name = nameFor(gender);
      const role = (['bat', 'all', 'bowl', 'bat', 'all'] as const)[Math.floor(rand() * 5)];
      const tb = norm();
      const talent: Talent = {
        bat: tb,
        bowl: 0.3 * tb + 0.95 * norm(),
        growth: rand() < 0.1 ? 0.16 + rand() * 0.08 : norm() * 0.07,
        role,
      };
      const school = weighted();
      const club = pick(CLUBS);
      const entry =
        gender === 'men'
          ? rand() < 0.62
            ? 8
            : rand() < 0.6
              ? 11 + Math.floor(rand() * 3)
              : 15 + Math.floor(rand() * 2)
          : 10 + Math.floor(rand() * 5);
      const strength = Math.max(talent.bat, talent.bowl);
      const direct = rand() < 0.25;
      const proAge =
        strength + norm() * 0.5 > (gender === 'men' ? 1.45 : 1.5)
          ? direct
            ? 18 + Math.floor(rand() * 2)
            : 19 + Math.floor(rand() * 4)
          : null;
      const goesDirect = proAge !== null && direct;
      // A quarter of the franchise players went straight from school; one in ten players isn't at a
      // recorded school at all and comes through a club.
      const noSchool = rand() < 0.1;
      const clubJunior = !goesDirect && (noSchool || rand() < 0.45);
      const p: JourneyPlayer = { id, name, gender, rows: [] };
      let gone = false;
      for (let age = entry; age <= 34 && !gone; age++) {
        const season = born + age;
        if (season > SAMPLE_LATEST_SEASON) break;
        const hasPro = proAge !== null && age >= proAge;
        // Leaks: the usual drop-out ages, harder on the less talented. A franchise player stays.
        const leak =
          age <= 12
            ? 0.06
            : age <= 14
              ? 0.1
              : age <= 16
                ? 0.14
                : age <= 18
                  ? 0.12
                  : age === 19
                    ? 0.3
                    : 0.16;
        const girlsExtra = gender === 'women' && age >= 14 && age <= 18 ? 0.08 : 0;
        if (proAge === null && rand() < (leak + girlsExtra) * Math.exp(-0.45 * strength)) {
          gone = true;
          break;
        }
        const skip = proAge === null && rand() < 0.05;
        if (season < SAMPLE_FIRST_SEASON || skip) continue;
        const bracket = bracketOfAge(age);
        const a0 = Math.max(entry, SAMPLE_FIRST_SEASON - born);
        if (age <= 18) {
          if (!noSchool) {
            const level =
              bracket === 'U19'
                ? strength > 0
                  ? '1st XI'
                  : '2nd XI'
                : `${bracket} ${strength > 0.4 ? 'A' : 'B'}`;
            team(
              p,
              talent,
              { season, setting: 'school', team: school, level, bracket },
              a0,
              age,
              6 + Math.floor(rand() * 7),
              ['One-Day', 'T20'],
            );
          }
          if ((age >= 11 || noSchool) && clubJunior && (gender === 'men' || age >= 14))
            team(
              p,
              talent,
              { season, setting: 'club', team: club, level: `${bracket} league`, bracket },
              a0,
              age,
              5 + Math.floor(rand() * 5),
              ['One-Day', 'T20'],
            );
          if (age >= 12 && strength + norm() * 0.6 > 1.0)
            team(
              p,
              talent,
              {
                season,
                setting: 'rep',
                team: `Highveld ${bracket} week`,
                level: 'Provincial week',
                bracket,
              },
              a0,
              age,
              3 + Math.floor(rand() * 3),
              ['One-Day'],
            );
        }
        if (age >= 19 || (age === 18 && hasPro)) {
          if (!hasPro || (!goesDirect && rand() < 0.5))
            team(
              p,
              talent,
              { season, setting: 'club', team: club, level: 'Premier league', bracket: 'Senior' },
              a0,
              age,
              10 + Math.floor(rand() * 6),
              ['One-Day', 'T20'],
            );
          if (hasPro)
            team(
              p,
              talent,
              { season, setting: 'pro', team: FRANCHISE, level: 'Franchise', bracket: 'Pro' },
              a0,
              age,
              8 + Math.floor(rand() * 6),
              ['T20', 'One-Day'],
            );
        }
      }
      if (p.rows.length) players.push(p);
    }
  }
  return players;
}

let memo: JourneyPlayer[] | null = null;
/** The invented players (built once, then shared). */
export function samplePlayers(): JourneyPlayer[] {
  return (memo ??= build());
}

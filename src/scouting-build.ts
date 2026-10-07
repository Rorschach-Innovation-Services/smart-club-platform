/**
 * Build a scouting event — the shape Player scouting draws — from what a source gives:
 *   - `eventFromMatches`: scorecards (e.g. a WebSports export), with players, teams, totals and
 *     fixtures worked out from them;
 *   - `eventFromPool`: a scouting report's players (aggregates, no matches), e.g. a union's
 *     club players from the national report.
 * Pure. Teams get short codes from their names ("Hawks 1st XI" → "HAW1").
 */
import type { ScoutPool } from './scout-pool';
import type { HubCode, ScoutFixture, ScoutPlayer, ScoutTeam, ScoutingEvent } from './scouting-data';
import type { ScoutMatch } from './scouting-matches';

export interface EventMeta {
  id: string;
  name: string;
  ageGroup: string;
  venue?: string;
  source: string;
  /** The provincial union the event belongs to (for a union's own dashboard). */
  union?: string;
  /** Codes of the sides that belong to that union (others are opponents). */
  ourTeams?: HubCode[];
}

/** Short, unique codes for team names: initials, plus the side's number or age if any. */
export function teamCodes(names: string[]): Map<string, HubCode> {
  const out = new Map<string, HubCode>();
  const used = new Set<string>();
  for (const n of names) {
    if (out.has(n)) continue;
    const words = n
      .replace(/[^A-Za-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const tag = /\bU(\d{1,2})\b/i.exec(n)?.[1] ?? /\b(\d)(?:st|nd|rd|th)\b/i.exec(n)?.[1] ?? '';
    const kept = words.filter(
      (w) => /^[A-Za-z]/.test(w) && !/^(xi|u\d+|cc|club|cricket|the|of|and|a|b)$/i.test(w),
    );
    // Several words → initials ("Old Edwardians" → "OE"); one word → its first letters ("WAN").
    const letters = (kept.length > 1 ? kept.map((w) => w[0]).join('') : (kept[0] ?? '').slice(0, 3))
      .toUpperCase()
      .slice(0, 3);
    let code = `${letters || 'T'}${tag}`;
    for (let k = 2; used.has(code); k++) code = `${letters}${tag}${k}`;
    used.add(code);
    out.set(n, code);
  }
  return out;
}

const ballsOf = (o: string) => {
  const [a, b] = String(o).split('.');
  return (Number(a) || 0) * 6 + (Number(b) || 0);
};
const oversOf = (balls: number) => `${Math.floor(balls / 6)}${balls % 6 ? `.${balls % 6}` : ''}`;
const isOut = (out: string) => !!out && !/^not out|^retired/i.test(out);

/** Players, teams, totals and fixtures from scorecards. Innings teams are names; they become codes. */
export function eventFromMatches(meta: EventMeta, source: ScoutMatch[]): ScoutingEvent {
  const names = [...new Set(source.flatMap((m) => [m.home, m.away]).filter(Boolean))];
  const code = teamCodes(names);
  const c = (n: string) => code.get(n) ?? n;
  const matches: ScoutMatch[] = source.map((m) => ({
    ...m,
    home: c(m.home),
    away: c(m.away),
    winner: m.winner ? c(m.winner) : null,
    result: m.winner ? m.result.replace(m.winner, c(m.winner)) : m.result,
    innings: (m.innings ?? []).map((i) => ({ ...i, bat: c(i.bat), fld: c(i.fld) })),
  }));

  type Acc = ScoutPlayer & { outs: number; bestW: number; bestR: number; games: Set<string> };
  const players = new Map<string, Acc>();
  const get = (n: string, hub: string, game: string) => {
    const k = `${hub}|${n}`;
    const p =
      players.get(k) ??
      ({
        name: n,
        hub,
        m: 0,
        runs: 0,
        balls: 0,
        hs: null,
        avg: null,
        sr: null,
        fours: 0,
        sixes: 0,
        ballsBowled: 0,
        wkts: 0,
        runsConceded: 0,
        econ: null,
        best: null,
        ct: 0,
        st: 0,
        ro: 0,
        outs: 0,
        bestW: -1,
        bestR: 0,
        games: new Set<string>(),
      } as Acc);
    p.games.add(game);
    players.set(k, p);
    return p;
  };
  const teamAcc = new Map<
    string,
    {
      played: number;
      won: number;
      lost: number;
      rs: number;
      bf: number;
      rc: number;
      bb: number;
      wk: number;
      ex: number;
      legal: number;
      wd: number;
      nb: number;
    }
  >();
  const team = (t: string) =>
    teamAcc.get(t) ??
    (teamAcc.set(t, {
      played: 0,
      won: 0,
      lost: 0,
      rs: 0,
      bf: 0,
      rc: 0,
      bb: 0,
      wk: 0,
      ex: 0,
      legal: 0,
      wd: 0,
      nb: 0,
    }),
    teamAcc.get(t)!);

  let legalBalls = 0;
  let runs = 0;
  let wickets = 0;
  let extras = 0;
  let fours = 0;
  let sixes = 0;
  let dots = 0;
  for (const m of matches) {
    for (const t of [m.home, m.away]) {
      const a = team(t);
      a.played++;
      if (m.winner === t) a.won++;
      else if (m.winner) a.lost++;
    }
    for (const inn of m.innings ?? []) {
      const lb = ballsOf(inn.overs);
      legalBalls += lb;
      runs += inn.total;
      wickets += inn.wkts;
      extras += inn.extras;
      const bt = team(inn.bat);
      bt.rs += inn.total;
      bt.bf += lb;
      const fl = team(inn.fld);
      fl.rc += inn.total;
      fl.bb += lb;
      fl.wk += inn.wkts;
      fl.ex += inn.extras;
      fl.legal += lb;
      fl.wd += inn.exb.w;
      fl.nb += inn.exb.nb;
      for (const r of inn.batting) {
        const p = get(r.n, inn.bat, m.id);
        p.runs = (p.runs ?? 0) + r.r;
        p.balls = (p.balls ?? 0) + r.b;
        p.fours = (p.fours ?? 0) + r.f4;
        p.sixes = (p.sixes ?? 0) + r.f6;
        fours += r.f4;
        sixes += r.f6;
        if (isOut(r.out)) p.outs++;
        const hs = Number((p.hs ?? '-1').replace('*', ''));
        if (r.r > hs || (r.r === hs && !isOut(r.out))) p.hs = `${r.r}${isOut(r.out) ? '' : '*'}`;
        // Fielding credit from the dismissal.
        const f = /^(c|st) (.+?) b (.+)$/.exec(r.out) ?? null;
        const ro = /^run out \((.+?)\)/.exec(r.out);
        if (f && f[2] !== '?') {
          const who = f[2] === '&' ? f[3] : f[2];
          const fp = get(who, inn.fld, m.id);
          if (f[1] === 'st') fp.st = (fp.st ?? 0) + 1;
          else fp.ct = (fp.ct ?? 0) + 1;
        } else if (ro) {
          const fp = get(ro[1], inn.fld, m.id);
          fp.ro = (fp.ro ?? 0) + 1;
        }
      }
      for (const b of inn.bowling) {
        const p = get(b.n, inn.fld, m.id);
        p.ballsBowled = (p.ballsBowled ?? 0) + ballsOf(b.o);
        p.wkts = (p.wkts ?? 0) + b.w;
        p.runsConceded = (p.runsConceded ?? 0) + b.r;
        dots += b.dots;
        if (b.w > p.bestW || (b.w === p.bestW && b.r < p.bestR)) {
          p.bestW = b.w;
          p.bestR = b.r;
          p.best = `${b.w}/${b.r}`;
        }
      }
    }
  }
  const outPlayers: ScoutPlayer[] = [...players.values()].map(
    ({ outs, bestW: _w, bestR: _r, games, ...p }) => ({
      ...p,
      m: games.size,
      avg: outs ? Math.round(((p.runs ?? 0) / outs) * 100) / 100 : null,
      sr: p.balls ? Math.round(((p.runs ?? 0) / p.balls) * 1000) / 10 : null,
      econ: p.ballsBowled ? Math.round(((p.runsConceded ?? 0) / p.ballsBowled) * 600) / 100 : null,
      balls: p.balls || null,
      runs: p.balls || p.runs ? p.runs : null,
      ballsBowled: p.ballsBowled || null,
      wkts: p.ballsBowled ? p.wkts : null,
      runsConceded: p.ballsBowled ? p.runsConceded : null,
    }),
  );
  const teams: ScoutTeam[] = [...code.entries()].map(([name, cd]) => {
    const a = team(cd);
    return {
      code: cd,
      name,
      placing: '',
      played: a.played,
      won: a.won,
      lost: a.lost,
      runsScored: a.rs,
      runRate: a.bf ? Math.round((a.rs / a.bf) * 600) / 100 : 0,
      runsConceded: a.rc,
      concededRate: a.bb ? Math.round((a.rc / a.bb) * 600) / 100 : 0,
      wickets: a.wk,
      extrasConceded: a.ex,
      discipline: {
        legalBalls: a.legal,
        wides: a.wd,
        noBalls: a.nb,
        extras: a.ex,
        extrasPer10: a.legal ? Math.round((a.ex / a.legal) * 600) / 10 : 0,
      },
      results: matches
        .filter((m) => m.home === cd || m.away === cd)
        .map((m) => {
          const mine = (m.innings ?? []).find((i) => i.bat === cd);
          const theirs = (m.innings ?? []).find((i) => i.fld === cd);
          return {
            date: m.date,
            event: m.event,
            stage: m.stage,
            opp: m.home === cd ? m.away : m.home,
            overs: m.overs,
            batted: (m.innings ?? [])[0]?.bat === cd ? 'first' : 'second',
            scored: mine ? `${mine.total}/${mine.wkts}` : '—',
            conceded: theirs ? `${theirs.total}/${theirs.wkts}` : '—',
            result: m.winner === cd ? 'Won' : m.winner ? 'Lost' : m.result || 'No result',
          };
        }),
    };
  });
  const fixtures: ScoutFixture[] = matches.map((m) => ({
    date: m.date,
    event: m.event,
    stage: m.stage,
    overs: m.overs,
    venue: m.venue,
    battingFirst: (m.innings ?? [])[0]?.bat ?? m.home,
    chasing: (m.innings ?? [])[1]?.bat ?? m.away,
    result: m.result,
  }));
  const stages = [...new Set(matches.map((m) => m.stage))];
  const dates = matches
    .map((m) => m.date)
    .filter(Boolean)
    .sort();
  return {
    id: meta.id,
    kind: matches.length > 1 ? 'tournament' : 'league',
    name: meta.name,
    ageGroup: meta.ageGroup,
    competitions: stages,
    dates: { from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' },
    venue: meta.venue ?? [...new Set(matches.map((m) => m.venue).filter(Boolean))].join(', '),
    source: meta.source,
    union: meta.union,
    ourTeams: meta.ourTeams?.map((n) => code.get(n) ?? n),
    totals: {
      matches: matches.length,
      hubs: teams.length,
      players: outPlayers.length,
      legalBalls,
      overs: oversOf(legalBalls),
      runs,
      wickets,
      runRate: legalBalls ? Math.round((runs / legalBalls) * 600) / 100 : 0,
      extras,
      fours,
      sixes,
      dotPct: legalBalls ? Math.round((dots / legalBalls) * 100) : 0,
    },
    byCompetition: stages.map((s) => {
      const ms = matches.filter((m) => m.stage === s);
      const inns = ms.flatMap((m) => m.innings ?? []);
      const lb = inns.reduce((n, i) => n + ballsOf(i.overs), 0);
      const r = inns.reduce((n, i) => n + i.total, 0);
      return {
        label: s,
        matches: ms.length,
        players: new Set(
          inns.flatMap((i) => [...i.batting.map((b) => b.n), ...i.bowling.map((b) => b.n)]),
        ).size,
        runs: r,
        wickets: inns.reduce((n, i) => n + i.wkts, 0),
        runRate: lb ? Math.round((r / lb) * 600) / 100 : 0,
        dotPct: lb
          ? Math.round(
              (inns.reduce((n, i) => n + i.bowling.reduce((d, b) => d + b.dots, 0), 0) / lb) * 100,
            )
          : 0,
        extrasPct: r ? Math.round((inns.reduce((n, i) => n + i.extras, 0) / r) * 100) : 0,
      };
    }),
    champions: [],
    players: outPlayers,
    teams,
    fixtures,
    profiles: [],
    matches,
  };
}

/** A scouting report's players as an event: clubs are the teams, there are no matches. */
export function eventFromPool(
  pool: ScoutPool,
  meta: EventMeta,
  include: (p: ScoutPool['players'][number]) => boolean = () => true,
): ScoutingEvent {
  const ps = pool.players.filter(include);
  const code = teamCodes([...new Set(ps.map((p) => p.club))]);
  const players: ScoutPlayer[] = ps.map((p) => {
    const bb = p.bowl ? ballsOf(p.bowl.overs) : 0;
    return {
      name: p.name,
      hub: code.get(p.club)!,
      m: p.games ?? 0,
      runs: p.bat?.runs ?? null,
      balls: p.bat?.balls ?? null,
      hs: p.bat?.hs ?? null,
      avg: p.bat?.avg ?? null,
      sr: p.bat?.sr ?? null,
      fours: p.bat?.fours ?? null,
      sixes: p.bat?.sixes ?? null,
      ballsBowled: bb || null,
      wkts: p.bowl ? p.bowl.wkts : null,
      runsConceded: p.bowl ? p.bowl.runs : null,
      econ: p.bowl ? p.bowl.econ : null,
      best: p.bowl?.best ?? null,
      ct: p.fielding ?? null,
      st: null,
      ro: null,
    };
  });
  const sum = (f: (p: ScoutPlayer) => number | null) =>
    players.reduce((n, p) => n + (f(p) ?? 0), 0);
  const balls = sum((p) => p.balls);
  const runs = sum((p) => p.runs);
  const teams: ScoutTeam[] = [...code.entries()].map(([name, cd]) => {
    const mine = players.filter((p) => p.hub === cd);
    const r = mine.reduce((n, p) => n + (p.runs ?? 0), 0);
    const b = mine.reduce((n, p) => n + (p.balls ?? 0), 0);
    const rc = mine.reduce((n, p) => n + (p.runsConceded ?? 0), 0);
    const bb = mine.reduce((n, p) => n + (p.ballsBowled ?? 0), 0);
    return {
      code: cd,
      name,
      placing: '',
      played: 0,
      won: 0,
      lost: 0,
      runsScored: r,
      runRate: b ? Math.round((r / b) * 600) / 100 : 0,
      runsConceded: rc,
      concededRate: bb ? Math.round((rc / bb) * 600) / 100 : 0,
      wickets: mine.reduce((n, p) => n + (p.wkts ?? 0), 0),
      extrasConceded: 0,
      discipline: { legalBalls: bb, wides: 0, noBalls: 0, extras: 0, extrasPer10: 0 },
      results: [],
    };
  });
  const leagues = [...new Set(ps.map((p) => p.league).filter((l): l is string => !!l))];
  return {
    id: meta.id,
    kind: 'report',
    name: meta.name,
    ageGroup: meta.ageGroup,
    competitions: leagues.length ? leagues : [pool.name],
    dates: { from: pool.date, to: pool.date },
    venue: meta.venue ?? '',
    source: meta.source,
    union: meta.union,
    totals: {
      matches: 0,
      hubs: teams.length,
      players: players.length,
      legalBalls: balls,
      overs: oversOf(balls),
      runs,
      wickets: sum((p) => p.wkts),
      runRate: balls ? Math.round((runs / balls) * 600) / 100 : 0,
      extras: 0,
      fours: sum((p) => p.fours),
      sixes: sum((p) => p.sixes),
      dotPct: 0,
    },
    byCompetition: [],
    champions: [],
    players,
    teams,
    fixtures: [],
    profiles: [],
    matches: [],
  };
}

import { describe, it, expect } from 'vitest';
import { SAMPLE_TOURNAMENT } from './scouting-sample';
import {
  leaderboard,
  batterPoints,
  bowlerPoints,
  oversOf,
  roleOf,
  hubLeaders,
  median,
  MIN_BALLS_FACED,
} from './scouting';

const ev = SAMPLE_TOURNAMENT;

describe('sample tournament dataset', () => {
  it('has every player, team and fixture from the report', () => {
    expect(ev.players).toHaveLength(77);
    expect(ev.teams.map((t) => t.code).sort()).toEqual(['CEN', 'CST', 'EST', 'NTH', 'STH', 'WST']);
    expect(ev.fixtures).toHaveLength(15); // 14 recorded + the unscored 3rd-place play-off
    expect(ev.profiles).toHaveLength(10);
  });

  it('reconciles with the report headline totals', () => {
    const bowlerWkts = ev.players.reduce((n, p) => n + (p.wkts ?? 0), 0);
    const catches = ev.players.reduce((n, p) => n + (p.ct ?? 0), 0);
    const sixes = ev.players.reduce((n, p) => n + (p.sixes ?? 0), 0);
    expect(bowlerWkts).toBe(212 - 25); // all wickets minus run-outs
    expect(catches).toBe(72);
    expect(sixes).toBe(23);
    // Squad sizes per hub match the register headers.
    const squad = (c: string) => ev.players.filter((p) => p.hub === c).length;
    expect([squad('NTH'), squad('STH'), squad('CST')]).toEqual([12, 13, 16]);
  });

  it('every shortlisted player exists in the register', () => {
    ev.profiles.forEach((p) => {
      expect(ev.players.some((x) => x.name === p.name && x.hub === p.hub)).toBe(true);
    });
  });
});

describe('leaderboards', () => {
  it('matches the report leaders', () => {
    expect(leaderboard(ev.players, 'runs', '', 1)[0].player.name).toBe('Luca Nel');
    expect(leaderboard(ev.players, 'runs', '', 1)[0].value).toBe(163);
    expect(leaderboard(ev.players, 'wkts', '', 1)[0].player.name).toBe('Gabriel Dube');
    expect(leaderboard(ev.players, 'sr', '', 1)[0].player.name).toBe('Isaac Hadebe');
    expect(leaderboard(ev.players, 'econ', '', 1)[0].player.name).toBe('Gabriel Hadebe');
  });

  it('applies sample floors and the hub filter', () => {
    const sr = leaderboard(ev.players, 'sr', '', 50);
    expect(sr.every((r) => (r.player.balls ?? 0) >= MIN_BALLS_FACED)).toBe(true);
    const north = leaderboard(ev.players, 'runs', 'NTH', 50);
    expect(north.every((r) => r.player.hub === 'NTH')).toBe(true);
    expect(north[0].player.name).toBe('Gareth Ochse');
  });

  it('sorts economy ascending', () => {
    const e = leaderboard(ev.players, 'econ', '', 5).map((r) => r.value);
    expect([...e].sort((a, b) => a - b)).toEqual(e);
  });
});

describe('helpers', () => {
  it('formats overs from balls', () => {
    expect(oversOf(133)).toBe('22.1');
    expect(oversOf(48)).toBe('8');
    expect(oversOf(null)).toBe('–');
  });
  it('reads roles from the numbers', () => {
    const allRounder = ev.players.find((p) => p.name === 'Caleb Hadebe')!;
    const batOnly = ev.players.find((p) => p.name === 'Gareth Ochse')!;
    expect(roleOf(allRounder)).toBe('all-rounder');
    expect(roleOf(batOnly)).toBe('batter');
  });
  it('builds map points only for qualifying players', () => {
    expect(batterPoints(ev.players).length).toBeGreaterThan(20);
    expect(bowlerPoints(ev.players).every((p) => (p.player.wkts ?? 0) > 0)).toBe(true);
  });
  it('finds each hub’s leaders', () => {
    const south = hubLeaders(ev, 'STH');
    expect(south.topBat?.player.name).toBe('Luca Nel');
    expect(south.topBowl?.player.name).toBe('Gabriel Dube');
  });
  it('computes a median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

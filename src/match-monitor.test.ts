import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  monitorRow,
  sastClock,
  sastToday,
  scheduledStartMs,
  scoreLines,
  sortRows,
  totals,
} from './match-monitor';
import type { LiveMatch, MonitorMatch } from './api';

// 10:00 SAST on Sat 4 Oct 2026 = 08:00 UTC.
const at = (hhmm: string) => Date.parse(`2026-10-04T${hhmm}:00+02:00`);
const iso = (hhmm: string) => new Date(at(hhmm)).toISOString();

const fixture = (over: Partial<MonitorMatch> = {}): MonitorMatch => ({
  ref: 'smartclub:dolphins:fixture:s1:f1',
  seriesId: 's1',
  seriesName: 'Premier T20',
  fixtureId: 'f1',
  home: 'Crusaders',
  away: 'Umzinto',
  venue: 'Kingsmead',
  date: '2026-10-04',
  time: '10:00',
  fixtureStatus: 'scheduled',
  live: null,
  ...over,
});

const live = (over: Partial<LiveMatch> = {}): LiveMatch => ({
  ref: 'smartclub:dolphins:fixture:s1:f1',
  status: 'in_progress',
  startedAt: iso('10:05'),
  endedAt: null,
  lastInputAt: iso('11:00'),
  oversPerSide: 20,
  innings: [
    {
      number: 1,
      battingSide: 'home',
      runs: 84,
      wickets: 3,
      overs: '12.4',
      startedAt: iso('10:05'),
      endedAt: null,
    },
  ],
  deliveries: 80,
  medianGapSec: 38,
  longGaps: [],
  medicoachMatchUrl: null,
  ...over,
});

describe('match monitor', () => {
  it('reads a fixture start as SAST and formats SAST clocks host-independently', () => {
    expect(scheduledStartMs({ date: '2026-10-04', time: '10:00' })).toBe(at('10:00'));
    expect(scheduledStartMs({ date: '2026-10-04', time: undefined })).toBeNull();
    expect(sastClock(iso('13:07'))).toBe('13:07');
    expect(sastToday(Date.parse('2026-10-04T23:30:00Z'))).toBe('2026-10-05');
  });

  it('a game on time and scoring is live with no flags', () => {
    const r = monitorRow(fixture({ live: live() }), at('11:02'));
    expect(r.phase).toBe('live');
    expect(r.lateMin).toBe(5);
    expect(r.sinceInputMin).toBe(2);
    expect(r.flags).toEqual([]);
    expect(r.durationMin).toBe(57);
  });

  it('flags a late first ball, a quiet scorer and delays between balls', () => {
    const r = monitorRow(
      fixture({
        live: live({
          startedAt: iso('10:25'),
          lastInputAt: iso('11:00'),
          longGaps: [
            { innings: 1, over: '4.3', at: iso('10:40'), gapSec: 150, reason: null },
            { innings: 1, over: '9.1', at: iso('10:55'), gapSec: 420, reason: null },
            { innings: 1, over: '7.2', at: iso('10:50'), gapSec: 260, reason: null },
            { innings: 1, over: '10.1', at: iso('10:59'), gapSec: 600, reason: 'drinks' },
          ],
        }),
      }),
      at('11:12'),
    );
    expect(r.flags.map((f) => f.key)).toEqual(['late', 'quiet', 'delay']);
    expect(r.flags[0].label).toBe('Started 25 min late');
    // 150 s is under the 4-minute threshold; longest first.
    expect(r.delays.map((d) => d.over)).toEqual(['9.1', '7.2']);
    // A recorded drinks break is shown, never flagged as a delay.
    expect(r.breaks.map((d) => d.over)).toEqual(['10.1']);
    expect(r.flags[2].label).toBe('2 delays between balls · longest 7 min');
  });

  it('a start that has passed with no ball is an alert — with or without a live match', () => {
    const waiting = monitorRow(
      fixture({ live: live({ status: 'not_started', startedAt: null, innings: [] }) }),
      at('10:20'),
    );
    expect(waiting.phase).toBe('awaiting');
    expect(waiting.flags).toEqual([
      { key: 'not-started', label: 'Not started · 20 min past start', tone: 'alert' },
    ]);
    const none = monitorRow(fixture(), at('10:40'));
    expect(none.flags[0]).toMatchObject({ key: 'no-scoring', tone: 'alert' });
    // Inside the grace window nothing is flagged yet; before the start it is upcoming.
    expect(monitorRow(fixture(), at('10:10')).flags).toEqual([]);
    expect(monitorRow(fixture(), at('09:00')).phase).toBe('upcoming');
  });

  it('measures the innings break, flagging a long one, and the full game on completion', () => {
    const inns = [
      {
        number: 1,
        battingSide: 'home' as const,
        runs: 184,
        wickets: 6,
        overs: '20.0',
        startedAt: iso('10:00'),
        endedAt: iso('11:30'),
      },
      {
        number: 2,
        battingSide: 'away' as const,
        runs: 161,
        wickets: 9,
        overs: '20.0',
        startedAt: iso('12:05'),
        endedAt: iso('13:35'),
      },
    ];
    const done = monitorRow(
      fixture({
        live: live({
          status: 'completed',
          startedAt: iso('10:00'),
          endedAt: iso('13:35'),
          lastInputAt: iso('13:35'),
          innings: inns,
        }),
      }),
      at('15:00'),
    );
    expect(done.phase).toBe('done');
    expect(done.inningsBreak).toEqual({ from: iso('11:30'), to: iso('12:05'), minutes: 35 });
    expect(done.flags.map((f) => f.key)).toEqual(['long-break']);
    expect(done.durationMin).toBe(215);
    expect(scoreLines(done.match)).toEqual({
      current: 'Umzinto 161/9 (20.0)',
      earlier: ['Crusaders 184/6 (20.0)'],
    });

    const brk = monitorRow(
      fixture({
        live: live({ status: 'innings_break', startedAt: iso('10:00'), innings: [inns[0]] }),
      }),
      at('11:45'),
    );
    expect(brk.phase).toBe('break');
    expect(brk.inningsBreak).toEqual({ from: iso('11:30'), to: null, minutes: 15 });
    expect(brk.flags).toEqual([]); // the quiet-scorer flag is for live play only
  });

  it('postponed/cancelled fixtures are off and never flagged', () => {
    const r = monitorRow(fixture({ fixtureStatus: 'postponed' }), at('12:00'));
    expect(r.phase).toBe('off');
    expect(r.flags).toEqual([]);
  });

  it('honours the thresholds the admin picks', () => {
    const m = fixture({ live: live({ startedAt: iso('10:10') }) });
    expect(monitorRow(m, at('11:02')).flags).toEqual([]);
    expect(
      monitorRow(m, at('11:02'), { ...DEFAULT_THRESHOLDS, lateStartMin: 10 }).flags[0].key,
    ).toBe('late');
  });

  it('sorts alerts first, then warnings, then by phase and start, and totals the day', () => {
    const rows = [
      monitorRow(
        fixture({
          fixtureId: 'a',
          home: 'A',
          live: live({ status: 'completed', endedAt: iso('13:00') }),
        }),
        at('14:00'),
      ),
      monitorRow(fixture({ fixtureId: 'b', home: 'B', time: '13:00' }), at('14:00')), // no scoring → alert
      monitorRow(
        fixture({
          fixtureId: 'c',
          home: 'C',
          live: live({ startedAt: iso('10:30'), lastInputAt: iso('13:59') }),
        }),
        at('14:00'),
      ), // late → warn
      monitorRow(fixture({ fixtureId: 'd', home: 'D', time: '15:00' }), at('14:00')),
      monitorRow(fixture({ fixtureId: 'e', home: 'E', fixtureStatus: 'cancelled' }), at('14:00')),
    ];
    expect(sortRows(rows).map((r) => r.match.fixtureId)).toEqual(['b', 'c', 'd', 'a', 'e']);
    expect(totals(rows)).toEqual({
      matches: 4,
      live: 1,
      done: 1,
      late: 2,
      delayed: 0,
      attention: 1,
    });
  });
});

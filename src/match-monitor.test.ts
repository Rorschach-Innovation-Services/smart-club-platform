import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  ballLabel,
  boardFlags,
  monitorRow,
  plural,
  sastClock,
  sastWhen,
  timesText,
  sastHour,
  sastToday,
  scheduledStartMs,
  scoreLines,
  shortenedNote,
  sortRows,
  totals,
  undoText,
} from './match-monitor';
import type { LiveMatch, MonitorMatch, MonitorPlayer } from './api';

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
  undoCount: 0,
  undoCountExact: true,
  players: [],
  medicoachMatchUrl: null,
  ...over,
});

describe('match monitor', () => {
  it('reads a fixture start as SAST and formats SAST clocks host-independently', () => {
    expect(scheduledStartMs({ date: '2026-10-04', time: '10:00' })).toBe(at('10:00'));
    expect(scheduledStartMs({ date: '2026-10-04', time: undefined })).toBeNull();
    expect(sastClock(iso('13:07'))).toBe('13:07');
    expect(sastToday(Date.parse('2026-10-04T23:30:00Z'))).toBe('2026-10-05');
    expect(sastHour(Date.parse('2026-10-04T23:30:00Z'))).toBe(1);
    expect(sastHour(Date.parse('2026-10-04T08:59:00Z'))).toBe(10);
  });

  it('an abandoned game carries the scorer reason; any other phase never does', () => {
    const ab = monitorRow(
      fixture({
        live: live({ status: 'abandoned', endedAt: iso('11:00'), abandonReason: '  Rain  ' }),
      }),
      at('11:30'),
    );
    expect(ab.phase).toBe('abandoned');
    expect(ab.abandonReason).toBe('Rain');
    expect(
      monitorRow(fixture({ live: live({ abandonReason: 'Rain' }) }), at('11:02')).abandonReason,
    ).toBeNull();
    expect(
      monitorRow(fixture({ live: live({ status: 'abandoned', abandonReason: null }) }), at('11:30'))
        .abandonReason,
    ).toBeNull();
  });

  it('a shortened game notes rain or agreement; a correction, null or unknown shows nothing', () => {
    expect(shortenedNote('rain')).toBe('Shortened — rain / bad light');
    expect(shortenedNote('agreed')).toBe('Shortened by agreement');
    expect(shortenedNote('correction')).toBeNull();
    expect(shortenedNote(null)).toBeNull();
    expect(shortenedNote('hail')).toBeNull();
    const row = (oversChangeReason: LiveMatch['oversChangeReason']) =>
      monitorRow(fixture({ live: live({ oversChangeReason }) }), at('11:02')).shortenedNote;
    expect(row('rain')).toBe('Shortened — rain / bad light');
    expect(row('correction')).toBeNull();
    expect(monitorRow(fixture({ live: live() }), at('11:02')).shortenedNote).toBeNull();
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
    // Alerts first: the silent scorer outranks the late start and the delays.
    expect(r.flags.map((f) => f.key)).toEqual(['quiet', 'late', 'delay']);
    expect(r.flags[1].label).toBe('Started 25 min late');
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
    expect(waiting.flags).toMatchObject([
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
      games: 5,
      matches: 4,
      postponed: 1,
      live: 1,
      done: 1,
      late: 2,
      delayed: 0,
      attention: 1,
      unregistered: 0,
    });
  });

  const player = (over: Partial<MonitorPlayer>): MonitorPlayer => ({
    side: 'home',
    name: 'Sam Player',
    addedDuringMatch: false,
    addedAt: null,
    check: 'registered',
    ...over,
  });

  it('flags players the rosters cannot vouch for, and players added during the match', () => {
    const r = monitorRow(
      fixture({
        live: live({
          players: [
            player({ name: 'On Sheet' }),
            player({
              name: 'Ann Added',
              addedDuringMatch: true,
              addedAt: iso('10:40'),
              check: 'unregistered',
            }),
            player({
              name: 'Ben Elsewhere',
              side: 'away',
              check: 'other-club',
              otherClub: 'Clares CC',
            }),
            player({
              name: 'Cal Late',
              addedDuringMatch: true,
              addedAt: iso('10:50'),
              check: 'name-match',
            }),
            player({ name: 'Dee Pending', side: 'away', check: 'not-active' }),
          ],
        }),
      }),
      at('11:02'),
    );
    expect(r.flags.map((f) => [f.key, f.tone])).toEqual([
      ['unregistered', 'alert'],
      ['added', 'warn'],
    ]);
    const [unreg, added] = r.flags;
    expect(unreg.label).toBe('3 players not registered to play');
    expect(unreg.detail).toEqual([
      'Ann Added — not registered with Crusaders · added during the match at 10:40',
      'Ben Elsewhere — registered with Clares CC, not Umzinto',
      'Dee Pending — registration at Umzinto is inactive or awaiting a clearance',
    ]);
    // Ben and Dee have played since the first ball; Ann's later arrival doesn't hide that.
    expect(unreg.since).toBe(iso('10:05'));
    expect(added.label).toBe('2 players added during the match');
    expect(added.detail).toEqual([
      'Ann Added (Crusaders) at 10:40 — NOT registered',
      'Cal Late (Crusaders) at 10:50 — registered',
    ]);
    expect([r.playersAdded, r.ineligible]).toEqual([2, 3]);
  });

  it('flags heavy use of undo, and re-raises a seen flag only when it gets worse', () => {
    const at5 = monitorRow(fixture({ live: live({ undoCount: 5 }) }), at('11:02'));
    expect(at5.flags.map((f) => f.label)).toEqual(['Undo used 5 times']);
    expect(monitorRow(fixture({ live: live({ undoCount: 4 }) }), at('11:02')).flags).toEqual([]);
    const at9 = monitorRow(fixture({ live: live({ undoCount: 9 }) }), at('11:02'));
    const at10 = monitorRow(fixture({ live: live({ undoCount: 10 }) }), at('11:02'));
    expect(at9.flags[0].signature).toBe(at5.flags[0].signature);
    expect(at10.flags[0].signature).not.toBe(at5.flags[0].signature);
    // A scoring app that doesn't report undos is never flagged for them.
    expect(
      monitorRow(fixture({ live: live({ undoCount: null }) }), at('11:02')).undoCount,
    ).toBeNull();
    // Medicoach's server-side estimate reads "~N"; an exact count reads plainly.
    const approx = monitorRow(
      fixture({ live: live({ undoCount: 6, undoCountExact: false }) }),
      at('11:02'),
    );
    expect(approx.flags.map((f) => f.label)).toEqual(['Undo used ~6 times']);
    expect(undoText(approx)).toBe('~6');
    expect(undoText(at5)).toBe('5');
    // Exactness unreported (null) never overstates confidence: it reads as an estimate.
    const unknown = monitorRow(
      fixture({ live: live({ undoCount: 5, undoCountExact: null }) }),
      at('11:02'),
    );
    expect(unknown.flags.map((f) => f.label)).toEqual(['Undo used ~5 times']);
    expect(undoText(unknown)).toBe('~5');
  });

  it('puts every flag of the day on one board, alerts first, then by type and how long open', () => {
    const rows = [
      monitorRow(
        fixture({ fixtureId: 'a', live: live({ startedAt: iso('10:30'), undoCount: 7 }) }),
        at('11:02'),
      ),
      monitorRow(fixture({ fixtureId: 'b', time: '10:30' }), at('11:02')),
      monitorRow(
        fixture({ fixtureId: 'c', live: live({ players: [player({ check: 'unregistered' })] }) }),
        at('11:02'),
      ),
    ];
    expect(boardFlags(rows).map((b) => `${b.row.match.fixtureId}|${b.flag.key}`)).toEqual([
      'c|unregistered',
      'b|no-scoring',
      'a|late',
      'a|undo',
    ]);
  });

  it('fires a minute threshold at the threshold exactly, never 30 s early (F-022)', () => {
    const m = fixture({ time: '10:00' });
    const sec = (hhmmss: string) => Date.parse(`2026-10-04T${hhmmss}+02:00`);
    expect(monitorRow(m, sec('10:14:59')).flags).toEqual([]);
    expect(monitorRow(m, sec('10:15:00')).flags.map((f) => f.key)).toEqual(['no-scoring']);
    // Innings break: 29 min 42 s is under a 30-min threshold.
    const brk = live({
      status: 'innings_break',
      innings: [{ ...live().innings[0], endedAt: iso('11:00') }],
    });
    expect(monitorRow(fixture({ live: brk }), sec('11:29:42')).flags).toEqual([]);
    expect(monitorRow(fixture({ live: brk }), sec('11:30:00')).flags[0].key).toBe('long-break');
    // A quiet scorer at 9 min 50 s is not yet "10 min".
    expect(
      monitorRow(fixture({ live: live({ lastInputAt: iso('11:00') }) }), sec('11:09:50')).flags,
    ).toEqual([]);
  });

  it('while medicoach is unreachable nothing is flagged from missing data (F-042)', () => {
    // No known state: past its start the game is "unknown", not "no live scoring".
    const none = monitorRow(fixture(), at('11:00'), DEFAULT_THRESHOLDS, { stale: true });
    expect([none.phase, none.flags, none.stale]).toEqual(['unknown', [], true]);
    // Before its start it is simply upcoming.
    expect(monitorRow(fixture(), at('09:00'), DEFAULT_THRESHOLDS, { stale: true }).phase).toBe(
      'upcoming',
    );
    // The last known state: still live, but a silence that is only our outage is not flagged.
    const held = monitorRow(fixture({ live: live() }), at('11:30'), DEFAULT_THRESHOLDS, {
      stale: true,
    });
    expect(held.phase).toBe('live');
    expect(held.flags).toEqual([]);
    // What the last state did show still stands (a player not registered).
    const unreg = monitorRow(
      fixture({
        live: live({
          players: [
            {
              side: 'home',
              name: 'X',
              addedDuringMatch: false,
              addedAt: null,
              check: 'unregistered',
            },
          ],
        }),
      }),
      at('11:30'),
      DEFAULT_THRESHOLDS,
      { stale: true },
    );
    expect(unreg.flags.map((f) => f.key)).toEqual(['unregistered']);
  });

  it('a fixture medicoach does not have yet is not the scorer’s fault (F-049)', () => {
    const r = monitorRow(fixture({ notInMedicoach: true }), at('10:30'));
    expect(r.phase).toBe('awaiting');
    expect(r.flags.map((f) => [f.key, f.tone])).toEqual([['not-linked', 'warn']]);
    expect(r.flags[0].label).toBe('Not in medicoach yet · 30 min past start');
  });

  it('a finished or abandoned game’s flags are history; unregistered players count once (F-024)', () => {
    const walkOn = {
      side: 'home' as const,
      name: 'Walk On',
      addedDuringMatch: false,
      addedAt: null,
      check: 'unregistered' as const,
    };
    const rows = [
      monitorRow(
        fixture({
          fixtureId: 'a',
          live: live({ status: 'completed', endedAt: iso('13:00'), players: [walkOn] }),
        }),
        at('14:00'),
      ),
      monitorRow(
        fixture({ fixtureId: 'b', live: live({ lastInputAt: iso('13:59'), players: [walkOn] }) }),
        at('14:00'),
      ),
    ];
    expect(boardFlags(rows).map((b) => [b.row.match.fixtureId, b.flag.key, b.closed])).toEqual([
      ['a', 'unregistered', true],
      ['b', 'unregistered', false],
    ]);
    expect(totals(rows).unregistered).toBe(1);
  });

  it('labels balls cricket-style, pluralises, and dates times off the viewed day (F-020/F-012/F-047)', () => {
    expect(ballLabel('4.0')).toBe('3.6');
    expect(ballLabel('2.1')).toBe('2.1');
    expect(ballLabel('0.3')).toBe('0.3');
    expect([plural(1, 'game'), plural(2, 'game'), plural(0, 'undo')]).toEqual([
      '1 game',
      '2 games',
      '0 undos',
    ]);
    expect([timesText(1), timesText(2), timesText(1, true)]).toEqual([
      'once',
      '2 times',
      '~1 time',
    ]);
    expect(sastWhen(iso('10:07'), '2026-10-04')).toBe('10:07');
    expect(sastWhen(iso('10:07'), '2026-10-05')).toBe('Sun 4 Oct 10:07');
    const gaps = monitorRow(
      fixture({
        live: live({
          longGaps: [
            { innings: 1, over: '4.0', at: iso('10:40'), gapSec: 300, reason: null },
            { innings: 1, over: '1.4', at: iso('10:20'), gapSec: 219, reason: null },
          ],
        }),
      }),
      at('11:02'),
    );
    expect(gaps.flags[0].detail).toEqual(['Innings 1, before ball 3.6: 5 min (10:35–10:40)']);
    // The 3.6-min pause is under the threshold: not flagged, but kept for the detail (F-014).
    expect(gaps.minorGaps.map((g) => g.gapSec)).toEqual([219]);
    expect(
      monitorRow(fixture({ live: live({ undoCount: 1 }) }), at('11:02'), {
        ...DEFAULT_THRESHOLDS,
        undoMax: 1,
      }).flags[0].label,
    ).toBe('Undo used once');
  });
});

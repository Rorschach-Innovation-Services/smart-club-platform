/* ─── Union office: Medicoach sync → Match monitor ───
 *
 * Built around the FLAGS: the action board at the top lists every flag of the day, most
 * urgent first (players not registered, a start with no live scoring, a silent scorer, then
 * late starts, delays between balls, heavy use of undo, players added during the match, long
 * innings breaks). New flags are marked; the office marks a flag as seen and it comes back
 * only if it gets worse. Below it, every game: scheduled start against the first ball, the
 * score now, the scorer's last input, the innings change, the finish and the scorer's undos
 * and added players.
 *
 * Refreshed every 30 seconds while open on today (or yesterday, for evening games past
 * midnight). Thresholds and "seen" marks are this browser's own.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api';
import { Btn, Modal, Pill } from './atoms';
import { qk } from './query';
import {
  DEFAULT_THRESHOLDS,
  FLAG_TYPES,
  boardFlags,
  fmtDuration,
  monitorRow,
  sastClock,
  sastToday,
  scheduledStartMs,
  scoreLines,
  sortRows,
  totals,
  type BoardFlag,
  type FlagKey,
  type MonitorPhase,
  type MonitorRow,
  type MonitorThresholds,
} from './match-monitor';

const POLL_MS = 30_000;
const THRESHOLDS_KEY = 'smartclub.matchMonitor.thresholds';
const SEEN_KEY = (date: string) => `smartclub.matchMonitor.seen.${date}`;
/** A flag that appeared since the page opened stays marked "New" this long. */
const NEW_FOR_MS = 10 * 60_000;

const PHASE: Record<MonitorPhase, { label: string; tone: string }> = {
  upcoming: { label: 'Upcoming', tone: 'muted' },
  awaiting: { label: 'Awaiting start', tone: 'gold' },
  live: { label: 'Live', tone: 'teal' },
  break: { label: 'Innings break', tone: 'navy' },
  done: { label: 'Finished', tone: 'navy' },
  abandoned: { label: 'Abandoned', tone: 'muted' },
  off: { label: 'Postponed', tone: 'muted' },
};

const CHECK_LABEL: Record<api.PlayerCheck, { text: string; tone: 'ok' | 'bad' | 'muted' }> = {
  registered: { text: 'Registered', tone: 'ok' },
  'name-match': { text: 'Registered (name match)', tone: 'ok' },
  'not-active': { text: 'Inactive / clearance pending', tone: 'bad' },
  'other-club': { text: 'Registered at another club', tone: 'bad' },
  unregistered: { text: 'Not registered', tone: 'bad' },
  unchecked: { text: 'Not checked', tone: 'muted' },
};

type Filter = 'all' | 'live' | 'waiting' | 'done';
const FILTERS: Array<[Filter, string]> = [
  ['all', 'All games'],
  ['live', 'Live'],
  ['waiting', 'Not started'],
  ['done', 'Finished'],
];
const inFilter = (r: MonitorRow, f: Filter) =>
  f === 'all' ||
  (f === 'live' && (r.phase === 'live' || r.phase === 'break')) ||
  (f === 'waiting' && (r.phase === 'upcoming' || r.phase === 'awaiting')) ||
  (f === 'done' && (r.phase === 'done' || r.phase === 'abandoned'));

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* per-browser convenience only */
  }
}

const shiftDay = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const dayLabel = (date: string, today: string) => {
  const d = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  if (date === today) return `Today · ${d}`;
  if (date === shiftDay(today, -1)) return `Yesterday · ${d}`;
  if (date === shiftDay(today, 1)) return `Tomorrow · ${d}`;
  return d;
};

const sinceText = (min: number | null) =>
  min === null ? '' : min < 1 ? 'just now' : `${fmtDuration(min)} ago`;

const seenKeyOf = (b: BoardFlag) => `${b.id}#${b.flag.signature}`;

export function MatchMonitor() {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const today = sastToday(nowMs);
  const [date, setDate] = useState(today);
  const [filter, setFilter] = useState<Filter>('all');
  const [flagType, setFlagType] = useState<FlagKey | 'all'>('all');
  const [t, setT] = useState<MonitorThresholds>(() => ({
    ...DEFAULT_THRESHOLDS,
    ...readJson<Partial<MonitorThresholds>>(THRESHOLDS_KEY, {}),
  }));
  const [seen, setSeen] = useState<string[]>(() => readJson<string[]>(SEEN_KEY(date), []));
  const [open, setOpen] = useState<string | null>(null);
  const isToday = date === today;
  // Yesterday too: an evening game still running after midnight belongs to yesterday's date.
  const isLiveDay = isToday || date === shiftDay(today, -1);

  // A clock for "x min ago" and the flags, independent of the data refresh.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => setSeen(readJson<string[]>(SEEN_KEY(date), [])), [date]);

  const q = useQuery({
    queryKey: qk.matchMonitor(date),
    queryFn: () => api.getMatchMonitor(date),
    refetchInterval: isLiveDay ? POLL_MS : false,
    refetchOnWindowFocus: isLiveDay,
  });

  const setThreshold = (k: keyof MonitorThresholds, v: number) => {
    const next = { ...t, [k]: v };
    setT(next);
    writeJson(THRESHOLDS_KEY, next);
  };

  const rows = useMemo(
    () => sortRows((q.data?.matches ?? []).map((m) => monitorRow(m, nowMs, t))),
    [q.data, nowMs, t],
  );
  const flags = useMemo(() => boardFlags(rows), [rows]);

  // "New": a flag (or a worse version of one) first seen after the page's first load.
  const firstSeen = useRef<{ date: string; baseline: boolean; at: Map<string, number> }>({
    date,
    baseline: false,
    at: new Map(),
  });
  if (firstSeen.current.date !== date) firstSeen.current = { date, baseline: false, at: new Map() };
  if (q.data) {
    const fs = firstSeen.current;
    for (const b of flags)
      if (!fs.at.has(seenKeyOf(b))) fs.at.set(seenKeyOf(b), fs.baseline ? Date.now() : 0);
    fs.baseline = true;
  }
  const isNew = (b: BoardFlag) => {
    const at = firstSeen.current.at.get(seenKeyOf(b)) ?? 0;
    return at > 0 && nowMs - at < NEW_FOR_MS;
  };

  const seenSet = new Set(seen);
  const active = flags.filter((b) => !seenSet.has(seenKeyOf(b)));
  const done = flags.filter((b) => seenSet.has(seenKeyOf(b)));
  const shownFlags = active.filter((b) => flagType === 'all' || b.flag.key === flagType);
  const markSeen = (b: BoardFlag, on: boolean) => {
    const k = seenKeyOf(b);
    const next = on ? [...new Set([...seen, k])] : seen.filter((x) => x !== k);
    setSeen(next);
    writeJson(SEEN_KEY(date), next);
  };

  const sum = totals(rows);
  const alerts = active.filter((b) => b.flag.tone === 'alert').length;
  const shown = rows.filter((r) => inFilter(r, filter));
  const openRow = rows.find((r) => r.match.ref === open) ?? null;
  const updated = q.dataUpdatedAt
    ? Math.max(0, Math.round((nowMs - q.dataUpdatedAt) / 1000))
    : null;

  return (
    <div data-testid="match-monitor">
      <div className="mm-bar">
        <div className="mm-day" role="group" aria-label="Day">
          <Btn
            tone="outline"
            size="sm"
            aria-label="Previous day"
            onClick={() => setDate(shiftDay(date, -1))}
          >
            ‹
          </Btn>
          <label className="mm-date">
            <span className="sr-only">Day</span>
            <input
              type="date"
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
            <span aria-hidden="true">{dayLabel(date, today)}</span>
          </label>
          <Btn
            tone="outline"
            size="sm"
            aria-label="Next day"
            onClick={() => setDate(shiftDay(date, 1))}
          >
            ›
          </Btn>
          {!isToday && (
            <Btn tone="outline" size="sm" onClick={() => setDate(today)}>
              Today
            </Btn>
          )}
        </div>
        <div className="mm-refresh" aria-live="polite">
          {isLiveDay && (
            <span className={`mm-pulse${q.isFetching ? ' on' : ''}`} aria-hidden="true" />
          )}
          {q.isFetching
            ? 'Updating…'
            : updated === null
              ? ''
              : `Updated ${updated < 5 ? 'just now' : updated < 60 ? `${updated} s ago` : `${Math.round(updated / 60)} min ago`}${isLiveDay ? ' · refreshes every 30 s' : ''}`}
          <Btn tone="outline" size="sm" disabled={q.isFetching} onClick={() => q.refetch()}>
            Refresh
          </Btn>
        </div>
      </div>

      {q.data?.dryRun && (
        <div className="insights-callout warn" role="note" style={{ marginBottom: 12 }}>
          <strong>Dry run.</strong> The sync connection isn&apos;t configured, so there is no live
          scoring to show — only the day&apos;s fixtures.
        </div>
      )}
      {q.data && !q.data.dryRun && !q.data.reachable && (
        <div className="insights-callout alert mcs-alert" role="alert">
          <div>
            <strong>Live scoring unavailable.</strong> {q.data.error}
          </div>
          {q.data.technical && (
            <details className="mcs-details">
              <summary>Details</summary>
              <div className="mcs-details-body">
                <code>{q.data.technical}</code>
              </div>
            </details>
          )}
        </div>
      )}

      {q.isLoading ? (
        <div className="mcs-empty" role="status">
          Loading the day&apos;s games…
        </div>
      ) : q.isError ? (
        <div className="mcs-empty" role="alert">
          Couldn&apos;t load the match monitor.{' '}
          <Btn tone="outline" size="sm" onClick={() => q.refetch()}>
            Try again
          </Btn>
        </div>
      ) : (
        <>
          {/* ── Action board ── */}
          <section className="mm-board" aria-labelledby="mm-board-h" data-testid="mm-board">
            <div className="mm-board-head">
              <div>
                <h2 id="mm-board-h" className="mm-board-title">
                  Action board
                </h2>
                <div className="mm-board-sum">
                  {active.length === 0 ? (
                    'Nothing needs you right now.'
                  ) : (
                    <>
                      <strong className={alerts ? 'mm-alert-text' : ''}>
                        {alerts} need{alerts === 1 ? 's' : ''} you now
                      </strong>
                      {' · '}
                      {active.length - alerts} to keep an eye on
                    </>
                  )}
                </div>
              </div>
              <details className="mm-thresholds">
                <summary>Flag thresholds</summary>
                <div className="mm-th-grid">
                  <Threshold
                    label="Late start after"
                    unit="min"
                    value={t.lateStartMin}
                    options={[5, 10, 15, 20, 30]}
                    onChange={(v) => setThreshold('lateStartMin', v)}
                  />
                  <Threshold
                    label="Gap between balls over"
                    unit="min"
                    value={t.ballGapMin}
                    options={[2, 3, 4, 5, 6, 8, 10]}
                    onChange={(v) => setThreshold('ballGapMin', v)}
                  />
                  <Threshold
                    label="No scorer input for"
                    unit="min"
                    value={t.quietMin}
                    options={[5, 10, 15, 20]}
                    onChange={(v) => setThreshold('quietMin', v)}
                  />
                  <Threshold
                    label="Innings break over"
                    unit="min"
                    value={t.breakMin}
                    options={[20, 25, 30, 40, 45]}
                    onChange={(v) => setThreshold('breakMin', v)}
                  />
                  <Threshold
                    label="Undo used"
                    unit="times"
                    value={t.undoMax}
                    options={[3, 5, 8, 10, 15]}
                    onChange={(v) => setThreshold('undoMax', v)}
                  />
                </div>
              </details>
            </div>

            {active.length > 0 && (
              <div className="mm-filters" role="tablist" aria-label="Flag type">
                <button
                  role="tab"
                  aria-selected={flagType === 'all'}
                  className={`mm-chip${flagType === 'all' ? ' on' : ''}`}
                  onClick={() => setFlagType('all')}
                >
                  All flags <span className="mm-chip-n">{active.length}</span>
                </button>
                {FLAG_TYPES.map(({ key, name }) => {
                  const n = active.filter((b) => b.flag.key === key).length;
                  if (!n) return null;
                  const alert = active.some((b) => b.flag.key === key && b.flag.tone === 'alert');
                  return (
                    <button
                      key={key}
                      role="tab"
                      aria-selected={flagType === key}
                      className={`mm-chip${flagType === key ? ' on' : ''}${alert ? ' alert' : ''}`}
                      onClick={() => setFlagType(key)}
                    >
                      {name} <span className="mm-chip-n">{n}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {active.length === 0 ? (
              <div className="mm-allclear">
                <span aria-hidden="true">✓</span>
                {rows.length
                  ? 'Every game is on track — no flags.'
                  : 'No fixtures in a released series on this day.'}
              </div>
            ) : (
              <ul className="mm-flagcards" aria-label="Flags">
                {(shownFlags.length ? shownFlags : active).map((b) => (
                  <FlagCard
                    key={b.id}
                    b={b}
                    nowMs={nowMs}
                    isNew={isNew(b)}
                    onOpen={() => setOpen(b.row.match.ref)}
                    onSeen={() => markSeen(b, true)}
                  />
                ))}
              </ul>
            )}

            {done.length > 0 && (
              <details className="mm-seen">
                <summary>Seen ({done.length})</summary>
                <ul className="mcs-list">
                  {done.map((b) => (
                    <li key={b.id}>
                      <div>
                        <span className={`mm-flag ${b.flag.tone}`}>{b.flag.label}</span>
                        <div className="ump-sub">
                          {b.row.match.home} v {b.row.match.away}
                        </div>
                      </div>
                      <Btn tone="outline" size="sm" onClick={() => markSeen(b, false)}>
                        Put back
                      </Btn>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          {/* ── The day in one line ── */}
          <div className="mm-daystats" data-testid="mm-kpis">
            <span>
              <strong>{sum.matches}</strong> games
            </span>
            <span>
              <strong>{sum.live}</strong> live
            </span>
            <span>
              <strong>{sum.done}</strong> finished
            </span>
            <span className={sum.unregistered ? 'bad' : ''}>
              <strong>{sum.unregistered}</strong> unregistered player
              {sum.unregistered === 1 ? '' : 's'}
            </span>
            <span>
              <strong>{rows.reduce((n, r) => n + r.playersAdded, 0)}</strong> added during play
            </span>
            <span>
              <strong>{rows.reduce((n, r) => n + (r.undoCount ?? 0), 0)}</strong> undos
            </span>
            {rows.length - sum.matches > 0 && (
              <span>
                <strong>{rows.length - sum.matches}</strong> postponed
              </span>
            )}
          </div>

          {/* ── Every game ── */}
          {rows.length > 0 && (
            <>
              <div className="mm-tools">
                <h2 className="mcs-heading" style={{ margin: 0 }}>
                  Every game
                </h2>
                <div className="mm-filters" role="tablist" aria-label="Show">
                  {FILTERS.map(([k, label]) => {
                    const n = rows.filter((r) => inFilter(r, k)).length;
                    return (
                      <button
                        key={k}
                        role="tab"
                        aria-selected={filter === k}
                        className={`mm-chip${filter === k ? ' on' : ''}`}
                        onClick={() => setFilter(k)}
                      >
                        {label} <span className="mm-chip-n">{n}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              {!shown.length ? (
                <div className="mcs-empty">No games match this filter.</div>
              ) : (
                <div className="tbl-w">
                  <table className="tbl mm-tbl" aria-label="Games">
                    <thead>
                      <tr>
                        <th>Game</th>
                        <th>Start</th>
                        <th>Score now</th>
                        <th>Last input</th>
                        <th>Innings change</th>
                        <th>Finished</th>
                        <th>Scorer</th>
                        <th>Flags</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <GameRow key={r.match.ref} r={r} onOpen={() => setOpen(r.match.ref)} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {!!q.data?.unmatched && (
            <p className="mcs-note">
              medicoach is also scoring {q.data.unmatched} game(s) on this day that aren&apos;t a
              fixture here on this date — likely moved in one system and not the other.
            </p>
          )}
        </>
      )}

      {openRow && <GameDetail r={openRow} nowMs={nowMs} t={t} onClose={() => setOpen(null)} />}
    </div>
  );
}

function FlagCard({
  b,
  nowMs,
  isNew,
  onOpen,
  onSeen,
}: {
  b: BoardFlag;
  nowMs: number;
  isNew: boolean;
  onOpen: () => void;
  onSeen: () => void;
}) {
  const [more, setMore] = useState(false);
  const m = b.row.match;
  const type = FLAG_TYPES.find((f) => f.key === b.flag.key)!.name;
  const since = b.flag.since ? Date.parse(b.flag.since) : null;
  const detail = b.flag.detail ?? [];
  const visible = more ? detail : detail.slice(0, 3);
  return (
    <li className={`mm-flagcard ${b.flag.tone}`} data-flag={b.flag.key}>
      <div className="mm-fc-main">
        <div className="mm-fc-type">
          <span className={`mm-fc-dot ${b.flag.tone}`} aria-hidden="true" />
          {b.flag.tone === 'alert' ? 'Act now' : 'Watch'} · {type}
          {isNew && <span className="mm-new">New</span>}
        </div>
        <div className="mm-fc-title">{b.flag.label}</div>
        <div className="mm-fc-game">
          <strong>
            {m.home} v {m.away}
          </strong>
          <span className="ump-sub">
            {' '}
            · {m.seriesName}
            {m.venue ? ` · ${m.venue}` : ''}
            {since !== null &&
              ` · since ${sastClock(since)} (${fmtDuration((nowMs - since) / 60_000)})`}
          </span>
        </div>
        {visible.length > 0 && (
          <ul className="mm-fc-detail">
            {visible.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        )}
        {detail.length > 3 && (
          <button className="mm-more" onClick={() => setMore(!more)}>
            {more ? 'Show fewer' : `Show all ${detail.length}`}
          </button>
        )}
      </div>
      <div className="mm-fc-actions">
        <Btn tone="ink" size="sm" onClick={onOpen}>
          Open game
        </Btn>
        {m.live?.medicoachMatchUrl && (
          <a
            className="btn btn-outline btn-sm"
            href={m.live.medicoachMatchUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            medicoach ↗
          </a>
        )}
        <Btn tone="outline" size="sm" onClick={onSeen} aria-label={`Mark seen: ${b.flag.label}`}>
          Mark seen
        </Btn>
      </div>
    </li>
  );
}

function Threshold({
  label,
  unit,
  value,
  options,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  options: number[];
  onChange: (v: number) => void;
}) {
  return (
    <label className="ump-form-field">
      {label}
      <select
        className="mm-select"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {[...new Set([...options, value])]
          .sort((a, b) => a - b)
          .map((o) => (
            <option key={o} value={o}>
              {o} {unit}
            </option>
          ))}
      </select>
    </label>
  );
}

function GameRow({ r, onOpen }: { r: MonitorRow; onOpen: () => void }) {
  const m = r.match;
  const live = m.live;
  const score = scoreLines(m);
  const phase = PHASE[r.phase];
  const label = `${m.home} v ${m.away}`;
  return (
    <tr
      className={`mm-row${r.flags.some((f) => f.tone === 'alert') ? ' alert' : ''}`}
      onClick={onOpen}
    >
      <td data-label="Game">
        <button
          className="mm-game"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          aria-label={`${label}: open the match timeline`}
        >
          {label}
        </button>
        <div className="ump-sub">
          {m.seriesName}
          {m.venue ? ` · ${m.venue}` : ''}
        </div>
      </td>
      <td data-label="Start">
        <div className="mm-strong">{m.time ?? 'Time TBC'}</div>
        <div className="ump-sub">
          {live?.startedAt ? (
            <>
              First ball {sastClock(live.startedAt)}
              {r.lateMin !== null && r.lateMin > 0 && (
                <span className={r.flags.some((f) => f.key === 'late') ? 'mm-late' : ''}>
                  {' '}
                  · +{fmtDuration(r.lateMin)}
                </span>
              )}
            </>
          ) : (
            'No ball yet'
          )}
        </div>
      </td>
      <td data-label="Score now">
        <Pill tone={phase.tone} dot={r.phase === 'live'}>
          {phase.label}
        </Pill>
        {score.current && <div className="mm-score">{score.current}</div>}
        {score.earlier.map((e) => (
          <div key={e} className="ump-sub">
            {e}
          </div>
        ))}
      </td>
      <td data-label="Last input">
        {live?.lastInputAt ? (
          <>
            <div
              className={`mm-strong${r.flags.some((f) => f.key === 'quiet') ? ' mm-alert-text' : ''}`}
            >
              {sinceText(r.sinceInputMin)}
            </div>
            <div className="ump-sub">at {sastClock(live.lastInputAt)}</div>
          </>
        ) : (
          <span className="ump-sub">—</span>
        )}
      </td>
      <td data-label="Innings">
        {r.inningsBreak ? (
          <>
            <div className="mm-strong">
              {sastClock(r.inningsBreak.from)} →{' '}
              {r.inningsBreak.to ? sastClock(r.inningsBreak.to) : 'now'}
            </div>
            <div className="ump-sub">{fmtDuration(r.inningsBreak.minutes)} break</div>
          </>
        ) : (
          <span className="ump-sub">—</span>
        )}
      </td>
      <td data-label="Finished">
        {live?.endedAt ? (
          <>
            <div className="mm-strong">{sastClock(live.endedAt)}</div>
            <div className="ump-sub">{fmtDuration(r.durationMin)} game</div>
          </>
        ) : r.durationMin !== null ? (
          <span className="ump-sub">{fmtDuration(r.durationMin)} so far</span>
        ) : (
          <span className="ump-sub">—</span>
        )}
      </td>
      <td data-label="Scorer">
        {live ? (
          <>
            <div className={`mm-strong${r.flags.some((f) => f.key === 'undo') ? ' mm-late' : ''}`}>
              {r.undoCount === null
                ? 'Undo —'
                : `${r.undoCount} undo${r.undoCount === 1 ? '' : 's'}`}
            </div>
            <div className={`ump-sub${r.ineligible ? ' mm-alert-text' : ''}`}>
              {r.playersAdded} added
              {r.ineligible ? ` · ${r.ineligible} unregistered` : ''}
            </div>
          </>
        ) : (
          <span className="ump-sub">—</span>
        )}
      </td>
      <td data-label="Flags">
        {r.flags.length ? (
          <div className="mm-flags">
            {r.flags.map((f) => (
              <span key={f.key} className={`mm-flag ${f.tone}`}>
                {f.label}
              </span>
            ))}
          </div>
        ) : (
          <span className="ump-sub">
            {r.phase === 'upcoming' || r.phase === 'off' ? '—' : 'On track'}
          </span>
        )}
      </td>
    </tr>
  );
}

/** One game's day: flags, the timeline, delays, the scorer's corrections and the team sheets. */
function GameDetail({
  r,
  nowMs,
  t,
  onClose,
}: {
  r: MonitorRow;
  nowMs: number;
  t: MonitorThresholds;
  onClose: () => void;
}) {
  const m = r.match;
  const live = m.live;
  const score = scoreLines(m);
  const sched = scheduledStartMs(m);
  const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);
  const first = at(live?.startedAt);
  const end =
    at(live?.endedAt) ??
    (r.phase === 'live' || r.phase === 'break' ? nowMs : at(live?.lastInputAt));
  const from = Math.min(...[sched, first].filter((x): x is number => x !== null));
  const to = Math.max(...[end, first, sched].filter((x): x is number => x !== null));
  const span = to - from;
  const pct = (v: number) => `${Math.max(0, Math.min(100, ((v - from) / span) * 100))}%`;
  const width = (a: number, b: number) => `${Math.max(0.4, ((b - a) / span) * 100)}%`;
  const canDraw = Number.isFinite(from) && Number.isFinite(to) && span > 0 && first !== null;

  const events: Array<[string, string | null]> = [
    ['Scheduled start', sched !== null ? sastClock(sched) : 'Time TBC'],
    ['First ball', live?.startedAt ? sastClock(live.startedAt) : null],
    ...(live?.innings ?? []).flatMap(
      (i): Array<[string, string | null]> => [
        ...(i.number > 1
          ? [
              [`Innings ${i.number} starts`, i.startedAt ? sastClock(i.startedAt) : null] as [
                string,
                string | null,
              ],
            ]
          : []),
        [`Innings ${i.number} ends`, i.endedAt ? sastClock(i.endedAt) : null],
      ],
    ),
    [
      live?.status === 'abandoned' ? 'Abandoned' : 'Game ends',
      live?.endedAt ? sastClock(live.endedAt) : null,
    ],
  ];
  const players = live?.players ?? [];

  return (
    <Modal
      eyebrow={`${m.seriesName}${m.venue ? ` · ${m.venue}` : ''}`}
      title={`${m.home} v ${m.away}`}
      maxWidth={760}
      onClose={onClose}
    >
      <div className="mm-detail">
        <div className="mm-detail-head">
          <Pill tone={PHASE[r.phase].tone} dot={r.phase === 'live'}>
            {PHASE[r.phase].label}
          </Pill>
          {score.current && <span className="mm-score">{score.current}</span>}
          {score.earlier.map((e) => (
            <span key={e} className="ump-sub">
              {e}
            </span>
          ))}
        </div>
        {r.flags.length > 0 && (
          <ul className="mm-detail-flags">
            {r.flags.map((f) => (
              <li key={f.key} className={`mm-flagcard ${f.tone} compact`}>
                <div className="mm-fc-title">{f.label}</div>
                {f.detail && (
                  <ul className="mm-fc-detail">
                    {f.detail.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        {canDraw ? (
          <div className="mm-line" aria-hidden="true">
            {sched !== null && first !== null && first > sched && (
              <span
                className="mm-seg late"
                style={{ left: pct(sched), width: width(sched, first) }}
                title="Late start"
              />
            )}
            {(live?.innings ?? []).map((i) => {
              const a = at(i.startedAt);
              const b = at(i.endedAt) ?? (r.phase === 'live' ? nowMs : null);
              return a !== null && b !== null ? (
                <span
                  key={i.number}
                  className={`mm-seg inn i${i.number % 2}`}
                  style={{ left: pct(a), width: width(a, b) }}
                />
              ) : null;
            })}
            {r.inningsBreak && (
              <span
                className="mm-seg brk"
                style={{
                  left: pct(Date.parse(r.inningsBreak.from)),
                  width: width(
                    Date.parse(r.inningsBreak.from),
                    r.inningsBreak.to ? Date.parse(r.inningsBreak.to) : nowMs,
                  ),
                }}
              />
            )}
            {[...r.breaks, ...r.delays].map((g) => {
              const b = Date.parse(g.at);
              return (
                <span
                  key={`${g.innings}-${g.over}`}
                  className={`mm-seg ${g.reason ? 'rec' : 'gap'}`}
                  style={{ left: pct(b - g.gapSec * 1000), width: width(b - g.gapSec * 1000, b) }}
                />
              );
            })}
            {sched !== null && <span className="mm-tick" style={{ left: pct(sched) }} />}
          </div>
        ) : (
          <div className="mcs-empty">
            No balls scored yet — the timeline starts with the first ball.
          </div>
        )}
        {canDraw && (
          <div className="mm-axis" aria-hidden="true">
            <span>{sastClock(from)}</span>
            <span>{live?.endedAt ? sastClock(to) : `now ${sastClock(to)}`}</span>
          </div>
        )}
        {canDraw && (
          <div className="mm-legend">
            <span>
              <i className="late" /> Late start
            </span>
            <span>
              <i className="inn" /> Innings 1
            </span>
            <span>
              <i className="inn2" /> Innings 2
            </span>
            <span>
              <i className="brk" /> Innings break
            </span>
            <span>
              <i className="gap" /> Delay ({t.ballGapMin}+ min between balls)
            </span>
            <span>
              <i className="rec" /> Drinks / interruption (recorded)
            </span>
          </div>
        )}

        <div className="mm-detail-grid">
          <div>
            <h3 className="mcs-heading" style={{ marginTop: 16 }}>
              Timeline (SAST)
            </h3>
            <ul className="mcs-list mm-events">
              {events.map(([label, when]) => (
                <li key={label}>
                  <span>{label}</span>
                  <strong className={when ? '' : 'ump-sub'}>{when ?? '—'}</strong>
                </li>
              ))}
              <li>
                <span>Last scorer input</span>
                <strong>
                  {live?.lastInputAt
                    ? `${sastClock(live.lastInputAt)} · ${sinceText(r.sinceInputMin)}`
                    : '—'}
                </strong>
              </li>
              <li>
                <span>Undo pressed</span>
                <strong className={r.flags.some((f) => f.key === 'undo') ? 'mm-late' : ''}>
                  {r.undoCount === null ? 'not reported' : `${r.undoCount} times`}
                </strong>
              </li>
              <li>
                <span>Players added during play</span>
                <strong>{r.playersAdded}</strong>
              </li>
            </ul>
          </div>
          <div>
            <h3 className="mcs-heading" style={{ marginTop: 16 }}>
              Delays between balls
            </h3>
            {live ? (
              <>
                <p className="mcs-note">
                  {live.deliveries} balls scored
                  {live.medianGapSec !== null
                    ? ` · typical gap ${fmtDuration(live.medianGapSec / 60, live.medianGapSec)}`
                    : ''}
                  . Gaps of {t.ballGapMin} min or more:
                </p>
                {r.delays.length ? (
                  <ul className="mcs-list mm-events">
                    {r.delays.map((g) => (
                      <li key={`${g.innings}-${g.over}`}>
                        <span>
                          Innings {g.innings}, before ball {g.over}
                          <span className="ump-sub">
                            {' '}
                            · {sastClock(Date.parse(g.at) - g.gapSec * 1000)}–{sastClock(g.at)}
                          </span>
                        </span>
                        <strong>{fmtDuration(g.gapSec / 60)}</strong>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="mcs-empty">None.</div>
                )}
                {r.breaks.length > 0 && (
                  <>
                    <p className="mcs-note">Recorded by the scorer (not flagged):</p>
                    <ul className="mcs-list mm-events">
                      {r.breaks.map((g) => (
                        <li key={`${g.innings}-${g.over}`}>
                          <span>
                            {g.reason === 'drinks' ? 'Drinks' : 'Interruption'} · innings{' '}
                            {g.innings}, before ball {g.over}
                            <span className="ump-sub">
                              {' '}
                              · {sastClock(Date.parse(g.at) - g.gapSec * 1000)}–{sastClock(g.at)}
                            </span>
                          </span>
                          <strong>{fmtDuration(g.gapSec / 60)}</strong>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            ) : (
              <div className="mcs-empty">medicoach has no live scoring for this game.</div>
            )}
          </div>
        </div>

        {players.length > 0 && (
          <>
            <h3 className="mcs-heading" style={{ marginTop: 16 }}>
              Team sheets against the register
            </h3>
            <div className="mm-sheets">
              {(['home', 'away'] as const).map((side) => (
                <div key={side}>
                  <div className="mm-sheet-h">{side === 'home' ? m.home : m.away}</div>
                  <ul className="mcs-list mm-events">
                    {players
                      .filter((p) => p.side === side)
                      .sort(
                        (a, b) =>
                          Number(CHECK_LABEL[b.check].tone === 'bad') -
                            Number(CHECK_LABEL[a.check].tone === 'bad') ||
                          Number(b.addedDuringMatch) - Number(a.addedDuringMatch),
                      )
                      .map((p) => (
                        <li key={p.name}>
                          <span>
                            {p.name}
                            {p.addedDuringMatch && (
                              <span className="ump-sub">
                                {' '}
                                · added{p.addedAt ? ` ${sastClock(p.addedAt)}` : ''}
                              </span>
                            )}
                          </span>
                          <span className={`mm-check ${CHECK_LABEL[p.check].tone}`}>
                            {p.check === 'other-club' && p.otherClub
                              ? `At ${p.otherClub}`
                              : CHECK_LABEL[p.check].text}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </div>
          </>
        )}
        {live?.medicoachMatchUrl && (
          <p className="mcs-note">
            <a
              className="mcs-link"
              href={live.medicoachMatchUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open the match in medicoach →
            </a>
          </p>
        )}
      </div>
    </Modal>
  );
}

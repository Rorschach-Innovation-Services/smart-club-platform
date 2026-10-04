/* ─── Union office: Medicoach sync → Match monitor ───
 *
 * Every game of one day from medicoach's live scoring, refreshed every 30 seconds while the
 * page is open on today: scheduled start against the first ball, the score and over now,
 * time since the scorer's last input, the innings break, the finish, and long gaps between
 * balls. Games that need the office now (start passed with no ball, scorer silent) sort to
 * the top. Thresholds are the admin's own, kept in this browser.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import * as api from './api';
import { Btn, Modal, Pill } from './atoms';
import { qk } from './query';
import {
  DEFAULT_THRESHOLDS,
  fmtDuration,
  monitorRow,
  sastClock,
  sastToday,
  scheduledStartMs,
  scoreLines,
  sortRows,
  totals,
  type MonitorPhase,
  type MonitorRow,
  type MonitorThresholds,
} from './match-monitor';

const POLL_MS = 30_000;
const THRESHOLDS_KEY = 'smartclub.matchMonitor.thresholds';

const PHASE: Record<MonitorPhase, { label: string; tone: string }> = {
  upcoming: { label: 'Upcoming', tone: 'muted' },
  awaiting: { label: 'Awaiting start', tone: 'gold' },
  live: { label: 'Live', tone: 'teal' },
  break: { label: 'Innings break', tone: 'navy' },
  done: { label: 'Finished', tone: 'navy' },
  abandoned: { label: 'Abandoned', tone: 'muted' },
  off: { label: 'Postponed', tone: 'muted' },
};

type Filter = 'all' | 'attention' | 'live' | 'waiting' | 'done';
const FILTERS: Array<[Filter, string]> = [
  ['all', 'All games'],
  ['attention', 'Flagged'],
  ['live', 'Live'],
  ['waiting', 'Not started'],
  ['done', 'Finished'],
];
const inFilter = (r: MonitorRow, f: Filter) =>
  f === 'all' ||
  (f === 'attention' && r.flags.length > 0) ||
  (f === 'live' && (r.phase === 'live' || r.phase === 'break')) ||
  (f === 'waiting' && (r.phase === 'upcoming' || r.phase === 'awaiting')) ||
  (f === 'done' && (r.phase === 'done' || r.phase === 'abandoned'));

function loadThresholds(): MonitorThresholds {
  try {
    const raw = localStorage.getItem(THRESHOLDS_KEY);
    return raw ? { ...DEFAULT_THRESHOLDS, ...JSON.parse(raw) } : DEFAULT_THRESHOLDS;
  } catch {
    return DEFAULT_THRESHOLDS;
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

export function MatchMonitor() {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const today = sastToday(nowMs);
  const [date, setDate] = useState(today);
  const [filter, setFilter] = useState<Filter>('all');
  const [t, setT] = useState<MonitorThresholds>(loadThresholds);
  const [open, setOpen] = useState<string | null>(null);
  const isToday = date === today;
  // Yesterday too: an evening game still running after midnight belongs to yesterday's date.
  const isLiveDay = isToday || date === shiftDay(today, -1);

  // A clock for "x min ago" and the flags, independent of the data refresh.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const q = useQuery({
    queryKey: qk.matchMonitor(date),
    queryFn: () => api.getMatchMonitor(date),
    refetchInterval: isLiveDay ? POLL_MS : false,
    refetchOnWindowFocus: isLiveDay,
  });

  const setThreshold = (k: keyof MonitorThresholds, v: number) => {
    const next = { ...t, [k]: v };
    setT(next);
    try {
      localStorage.setItem(THRESHOLDS_KEY, JSON.stringify(next));
    } catch {
      /* per-browser convenience only */
    }
  };

  const rows = useMemo(
    () => sortRows((q.data?.matches ?? []).map((m) => monitorRow(m, nowMs, t))),
    [q.data, nowMs, t],
  );
  const sum = totals(rows);
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
          <div className="mm-kpis" data-testid="mm-kpis">
            <Kpi
              label="Games"
              value={sum.matches}
              sub={`${rows.length - sum.matches || 'none'} postponed`}
            />
            <Kpi label="Live now" value={sum.live} sub="in play or between innings" />
            <Kpi label="Finished" value={sum.done} sub={`of ${sum.matches}`} />
            <Kpi
              label="Late or not started"
              value={sum.late}
              sub={`${t.lateStartMin}+ min after the start`}
              tone={sum.late ? 'warn' : ''}
            />
            <Kpi
              label="Ball delays"
              value={sum.delayed}
              sub={`games with a ${t.ballGapMin}+ min gap`}
              tone={sum.delayed ? 'warn' : ''}
            />
            <Kpi
              label="Needs you now"
              value={sum.attention}
              sub="no ball yet, or scorer silent"
              tone={sum.attention ? 'alert' : ''}
            />
          </div>

          <div className="mm-tools">
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
              </div>
            </details>
          </div>

          {!rows.length ? (
            <div className="mcs-empty">No fixtures in a released series on this day.</div>
          ) : !shown.length ? (
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

function Kpi({
  label,
  value,
  sub,
  tone = '',
}: {
  label: string;
  value: number;
  sub: string;
  tone?: string;
}) {
  return (
    <div className={`mcs-stat mm-kpi ${tone}`}>
      <div className="mcs-stat-label">{label}</div>
      <div className="mcs-stat-value">{value}</div>
      <div className="ump-sub">{sub}</div>
    </div>
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
          onClick={onOpen}
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

/** One game's day on a line: the late start, each innings, the break and every long gap. */
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

  return (
    <Modal
      eyebrow={`${m.seriesName}${m.venue ? ` · ${m.venue}` : ''}`}
      title={`${m.home} v ${m.away}`}
      maxWidth={720}
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
          <div className="mm-flags" style={{ margin: '10px 0 4px' }}>
            {r.flags.map((f) => (
              <span key={f.key} className={`mm-flag ${f.tone}`}>
                {f.label}
              </span>
            ))}
          </div>
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

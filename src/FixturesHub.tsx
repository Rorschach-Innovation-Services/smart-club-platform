/* ─── Fixtures & Venues hub: This week · All fixtures · Results · grounds' schedule ───
 *
 * The finding-things half of Fixtures & Venues. Every series' fixtures are one list here
 * (fixture-index.ts), with the medicoach result on each played game, the umpires, the
 * ground, and the checks of the union's weekly cycle (Dolphins match-week SOP):
 *   Monday   — results confirmed, the week's fixtures complete (time, ground), no ground
 *              double-booked, postponements known;
 *   Thursday — umpires appointed to every game;
 *   weekend  — games and results as they come in.
 * Nothing here edits a fixture: "Edit" opens the series in Seasons & series, where the
 * existing editor, release bar and allocation tools live unchanged.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Btn } from './atoms';
import {
  ISSUES,
  addDays,
  filterRows,
  inWeek,
  resultLines,
  toCsv,
  weekChecks,
  weekStart,
  type FixtureFilter,
  type FixtureRow,
  type IssueKey,
} from './fixture-index';

const fmtDay = (d: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
const dayHeading = (d: string) => fmtDay(d, { weekday: 'long', day: 'numeric', month: 'long' });
const shortDay = (d?: string) =>
  d ? fmtDay(d, { weekday: 'short', day: 'numeric', month: 'short' }) : 'Date TBC';
const weekLabel = (monday: string) => {
  const sun = addDays(monday, 6);
  return `${fmtDay(monday, { day: 'numeric', month: 'short' })} – ${fmtDay(sun, { day: 'numeric', month: 'short', year: 'numeric' })}`;
};

const STATE_LABEL: Record<FixtureRow['state'], string> = {
  upcoming: 'Upcoming',
  today: 'Today',
  'awaiting-result': 'Result missing',
  result: 'Result in',
  'no-result': 'No result',
  postponed: 'Postponed',
  cancelled: 'Cancelled',
};

export interface HubProps {
  rows: FixtureRow[];
  today: string;
  /** Opens a series in Seasons & series (the editor). */
  onOpenSeries: (seriesId: string) => void;
  series: Array<{ id: string; name: string }>;
  clubs: Array<{ id: string; name: string }>;
}

/* ─── Shared pieces ─── */

function IssueChips({ issues, hideDraft }: { issues: IssueKey[]; hideDraft?: boolean }) {
  const shown = issues.filter((i) => !(hideDraft && i === 'draft'));
  if (!shown.length) return null;
  return (
    <span className="fh-chips">
      {shown.map((i) => (
        <span key={i} className={`fh-chip ${ISSUES[i].tone}`}>
          {ISSUES[i].label}
        </span>
      ))}
    </span>
  );
}

/** The two sides, with the result folded in: scores beside each side, the winner bold. */
export function Teams({ r, compact }: { r: FixtureRow; compact?: boolean }) {
  const res = resultLines(r);
  if (!res)
    return (
      <div className="fh-teams">
        <span className="fh-side">{r.home}</span>
        <span className="fh-v">v</span>
        <span className="fh-side">{r.away}</span>
      </div>
    );
  return (
    <div className={`fh-teams result${compact ? ' compact' : ''}`}>
      <span className={`fh-side${res.winner === 'home' ? ' won' : ''}`}>
        {r.home} <span className="fh-score">{res.home}</span>
      </span>
      <span className="fh-v">v</span>
      <span className={`fh-side${res.winner === 'away' ? ' won' : ''}`}>
        {r.away} <span className="fh-score">{res.away}</span>
      </span>
      {res.summary && <span className="fh-summary">{res.summary}</span>}
    </div>
  );
}

function RowActions({ r, onOpenSeries }: { r: FixtureRow; onOpenSeries: (id: string) => void }) {
  return (
    <span className="fh-actions">
      {r.result?.medicoachMatchUrl && (
        <a
          className="fh-link"
          href={r.result.medicoachMatchUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Scorecard ↗
        </a>
      )}
      <button
        className="fh-link"
        onClick={() => onOpenSeries(r.seriesId)}
        aria-label={`Edit ${r.home} v ${r.away} in ${r.seriesName}`}
      >
        Edit
      </button>
    </span>
  );
}

/** One fixture as a line: time · teams/result · ground · series/round · umpires · checks. */
function FixtureLine({
  r,
  onOpenSeries,
  showDate,
}: {
  r: FixtureRow;
  onOpenSeries: (id: string) => void;
  showDate?: boolean;
}) {
  return (
    <li className={`fh-line state-${r.state}`}>
      <div className="fh-when">
        {showDate && <div className="fh-date">{shortDay(r.date)}</div>}
        <div className="fh-time">{r.time ?? 'TBC'}</div>
      </div>
      <div className="fh-main">
        <Teams r={r} />
        <div className="fh-meta">
          <span>{r.venue ?? 'No ground'}</span>
          <span>
            {r.seriesName}
            {r.round !== undefined ? ` · R${r.round}` : ''}
          </span>
          <span>{r.umpires.length ? `Umpires: ${r.umpires.join(', ')}` : 'No umpires'}</span>
        </div>
      </div>
      <div className="fh-side-col">
        <span className={`fh-state state-${r.state}`}>{STATE_LABEL[r.state]}</span>
        {/* The state already says "Result missing". */}
        <IssueChips issues={r.issues.filter((i) => i !== 'awaiting-result')} />
        <RowActions r={r} onOpenSeries={onOpenSeries} />
      </div>
    </li>
  );
}

function WeekNav({
  monday,
  today,
  onChange,
}: {
  monday: string;
  today: string;
  onChange: (m: string) => void;
}) {
  const thisWeek = weekStart(today);
  return (
    <div className="fh-weeknav" role="group" aria-label="Week">
      <Btn
        tone="outline"
        size="sm"
        aria-label="Previous week"
        onClick={() => onChange(addDays(monday, -7))}
      >
        ‹
      </Btn>
      <div className="fh-weeklabel">
        <strong>
          {monday === thisWeek
            ? 'This week'
            : monday === addDays(thisWeek, -7)
              ? 'Last week'
              : monday === addDays(thisWeek, 7)
                ? 'Next week'
                : 'Week of'}
        </strong>
        <span>{weekLabel(monday)}</span>
      </div>
      <Btn
        tone="outline"
        size="sm"
        aria-label="Next week"
        onClick={() => onChange(addDays(monday, 7))}
      >
        ›
      </Btn>
      {monday !== thisWeek && (
        <Btn tone="outline" size="sm" onClick={() => onChange(thisWeek)}>
          This week
        </Btn>
      )}
    </div>
  );
}

/* ─── This week ─── */

type CheckKey = 'results' | 'complete' | 'grounds' | 'umpires' | 'postponed' | 'drafts';
const CHECK_ISSUES: Record<CheckKey, (r: FixtureRow) => boolean> = {
  results: (r) => r.issues.includes('awaiting-result'),
  complete: (r) => r.issues.includes('venue-tbc') || r.issues.includes('time-tbc'),
  grounds: (r) => r.issues.includes('venue-clash'),
  umpires: (r) => r.issues.includes('no-umpires') || r.issues.includes('one-umpire'),
  postponed: (r) => r.state === 'postponed',
  drafts: (r) => r.issues.includes('draft'),
};

export function WeekView({ rows, today, onOpenSeries }: HubProps) {
  const [monday, setMonday] = useState(() => {
    // Monday and Tuesday are for confirming the weekend just played; from Wednesday the
    // week ahead is what needs work. Either way the default week holds a weekend.
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    return dow === 1 || dow === 2 ? addDays(weekStart(today), -7) : weekStart(today);
  });
  const [check, setCheck] = useState<CheckKey | null>(null);
  const week = rows.filter((r) => inWeek(r, monday));
  const c = weekChecks(week);
  const shown = check ? week.filter(CHECK_ISSUES[check]) : week;
  const days = [...new Set(shown.map((r) => r.date!))];

  const tile = (
    key: CheckKey,
    when: string,
    title: string,
    value: ReactNode,
    sub: string,
    tone: 'ok' | 'alert' | 'warn' | 'muted',
  ) => (
    <button
      key={key}
      className={`fh-check ${tone}${check === key ? ' on' : ''}`}
      aria-pressed={check === key}
      onClick={() => setCheck(check === key ? null : key)}
    >
      <span className="fh-check-when">{when}</span>
      <span className="fh-check-title">{title}</span>
      <span className="fh-check-value">{value}</span>
      <span className="fh-check-sub">{sub}</span>
    </button>
  );

  return (
    <div>
      <div className="fh-toolbar">
        <WeekNav monday={monday} today={today} onChange={(m) => (setMonday(m), setCheck(null))} />
        <div className="fh-count">
          {c.games} game{c.games === 1 ? '' : 's'}
          {c.postponed ? ` · ${c.postponed} postponed` : ''}
        </div>
      </div>

      <div className="fh-checks" role="group" aria-label="Weekly checks">
        {tile(
          'results',
          'Monday',
          'Results confirmed',
          c.played ? `${c.resultsIn}/${c.played}` : '—',
          c.awaitingResult
            ? `${c.awaitingResult} played game${c.awaitingResult === 1 ? '' : 's'} without a result`
            : c.played
              ? 'every played game has a result'
              : 'nothing played yet this week',
          c.awaitingResult ? 'alert' : c.played ? 'ok' : 'muted',
        )}
        {tile(
          'complete',
          'Monday',
          'Fixtures complete',
          `${c.games - c.incomplete}/${c.games}`,
          c.incomplete ? `${c.incomplete} without a start time or ground` : 'time and ground set',
          c.incomplete ? 'warn' : 'ok',
        )}
        {tile(
          'grounds',
          'Monday',
          'Grounds clear',
          c.clashes ? c.clashes : '✓',
          c.clashes ? `${c.clashes} games on a double-booked ground` : 'no ground double-booked',
          c.clashes ? 'alert' : 'ok',
        )}
        {tile(
          'umpires',
          'Thursday',
          'Umpires appointed',
          `${c.games - c.umpiresShort}/${c.games}`,
          c.umpiresShort ? `${c.umpiresShort} short of two umpires` : 'two umpires on every game',
          c.umpiresShort ? 'warn' : 'ok',
        )}
        {c.postponed > 0 &&
          tile('postponed', 'Any day', 'Postponed', c.postponed, 'to re-date', 'warn')}
        {c.drafts > 0 &&
          tile(
            'drafts',
            'Before release',
            'Not released',
            c.drafts,
            'clubs and medicoach can’t see these',
            'muted',
          )}
      </div>

      {check && (
        <div className="fh-filtering">
          Showing {shown.length} game{shown.length === 1 ? '' : 's'} that need attention.{' '}
          <button className="fh-link" onClick={() => setCheck(null)}>
            Show the whole week
          </button>
        </div>
      )}

      {!week.length ? (
        <div className="fh-empty">No fixtures this week.</div>
      ) : !shown.length ? (
        <div className="fh-empty ok">✓ Nothing to do here this week.</div>
      ) : (
        days.map((d) => {
          const dayRows = shown.filter((r) => r.date === d);
          return (
            <section key={d} className="fh-day" aria-label={dayHeading(d)}>
              <h3 className="fh-day-h">
                {dayHeading(d)}
                {d === today && <span className="fh-today">Today</span>}
                <span className="fh-day-n">{dayRows.length}</span>
              </h3>
              <ul className="fh-lines">
                {dayRows.map((r) => (
                  <FixtureLine key={r.key} r={r} onOpenSeries={onOpenSeries} />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

/* ─── All fixtures ─── */

const PAGE = 100;

export function AllFixturesView({ rows, today, onOpenSeries, series, clubs }: HubProps) {
  const [f, setF] = useState<FixtureFilter>({ state: 'all' });
  const [limit, setLimit] = useState(PAGE);
  const venues = useMemo(
    () => [...new Set(rows.map((r) => r.venue).filter((v): v is string => !!v))].sort(),
    [rows],
  );
  const shown = filterRows(rows, f);
  const set = (patch: Partial<FixtureFilter>) => (setF({ ...f, ...patch }), setLimit(PAGE));
  const download = () => {
    const blob = new Blob([toCsv(shown)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fixtures-${today}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const active = Object.entries(f).filter(([k, v]) => v && !(k === 'state' && v === 'all')).length;

  return (
    <div>
      <div className="fh-filters">
        <label className="fh-search">
          <span className="sr-only">Search fixtures</span>
          <input
            type="search"
            placeholder="Search a team, ground, series, umpire or “round 3”"
            value={f.q ?? ''}
            onChange={(e) => set({ q: e.target.value })}
          />
        </label>
        <select
          aria-label="Series"
          value={f.seriesId ?? ''}
          onChange={(e) => set({ seriesId: e.target.value || undefined })}
        >
          <option value="">All series</option>
          {series.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Club"
          value={f.clubId ?? ''}
          onChange={(e) => set({ clubId: e.target.value || undefined })}
        >
          <option value="">All clubs</option>
          {clubs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Ground"
          value={f.venue ?? ''}
          onChange={(e) => set({ venue: e.target.value || undefined })}
        >
          <option value="">All grounds</option>
          {venues.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select
          aria-label="Status"
          value={f.state ?? 'all'}
          onChange={(e) => set({ state: e.target.value as FixtureFilter['state'] })}
        >
          <option value="all">Any status</option>
          <option value="upcoming">Upcoming</option>
          <option value="played">Played</option>
          <option value="awaiting-result">Result missing</option>
          <option value="off">Postponed / cancelled</option>
        </select>
        <select
          aria-label="Checks"
          value={f.issue ?? ''}
          onChange={(e) => set({ issue: (e.target.value || undefined) as FixtureFilter['issue'] })}
        >
          <option value="">Any checks</option>
          <option value="any">Needs attention</option>
          {(Object.keys(ISSUES) as IssueKey[]).map((k) => (
            <option key={k} value={k}>
              {ISSUES[k].label}
            </option>
          ))}
        </select>
        <span className="fh-range">
          <label>
            From{' '}
            <input
              type="date"
              value={f.from ?? ''}
              onChange={(e) => set({ from: e.target.value || undefined })}
            />
          </label>
          <label>
            To{' '}
            <input
              type="date"
              value={f.to ?? ''}
              onChange={(e) => set({ to: e.target.value || undefined })}
            />
          </label>
        </span>
      </div>
      <div className="fh-toolbar">
        <div className="fh-count" aria-live="polite">
          {shown.length} of {rows.length} fixtures
          {active > 0 && (
            <>
              {' · '}
              <button className="fh-link" onClick={() => (setF({ state: 'all' }), setLimit(PAGE))}>
                Clear filters
              </button>
            </>
          )}
        </div>
        <Btn tone="outline" size="sm" onClick={download} disabled={!shown.length}>
          Download CSV
        </Btn>
      </div>
      {!shown.length ? (
        <div className="fh-empty">No fixtures match.</div>
      ) : (
        <>
          <div className="tbl-w">
            <table className="tbl fh-tbl" aria-label="Fixtures">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Match and result</th>
                  <th>Ground</th>
                  <th>Series</th>
                  <th>Umpires</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, limit).map((r) => (
                  <tr key={r.key} className={`state-${r.state}`}>
                    <td data-label="Date">
                      <div className="fh-strong">{shortDay(r.date)}</div>
                      <div className="ump-sub">{r.time ?? 'Time TBC'}</div>
                    </td>
                    <td data-label="Match">
                      <Teams r={r} compact />
                    </td>
                    <td data-label="Ground">
                      {r.venue ?? <span className="ump-sub">No ground</span>}
                    </td>
                    <td data-label="Series">
                      {r.seriesName}
                      {r.round !== undefined && <div className="ump-sub">Round {r.round}</div>}
                    </td>
                    <td data-label="Umpires">
                      {r.umpires.length ? r.umpires.join(', ') : <span className="ump-sub">—</span>}
                    </td>
                    <td data-label="Status">
                      <span className={`fh-state state-${r.state}`}>{STATE_LABEL[r.state]}</span>
                      <IssueChips issues={r.issues.filter((i) => i !== 'awaiting-result')} />
                    </td>
                    <td data-label="">
                      <RowActions r={r} onOpenSeries={onOpenSeries} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length > limit && (
            <div className="fh-more">
              <Btn tone="outline" size="sm" onClick={() => setLimit(limit + PAGE)}>
                Show {Math.min(PAGE, shown.length - limit)} more
              </Btn>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ─── Results ─── */

const SOURCE: Record<string, string> = {
  live: 'Live scored',
  manual: 'Entered',
  import: 'Imported',
};

export function ResultsView({ rows, onOpenSeries, series }: HubProps) {
  const [seriesId, setSeriesId] = useState('');
  const [q, setQ] = useState('');
  const scoped = filterRows(rows, { seriesId: seriesId || undefined, q });
  const missing = scoped.filter((r) => r.state === 'awaiting-result').reverse();
  const done = scoped
    .filter((r) => r.state === 'result' || r.state === 'no-result')
    .sort(
      (a, b) =>
        (b.date ?? '').localeCompare(a.date ?? '') || (a.time ?? '').localeCompare(b.time ?? ''),
    );
  const days = [...new Set(done.map((r) => r.date!))];

  return (
    <div>
      <div className="fh-filters">
        <label className="fh-search">
          <span className="sr-only">Search results</span>
          <input
            type="search"
            placeholder="Search a team, ground or series"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <select aria-label="Series" value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
          <option value="">All series</option>
          {series.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <section className="fh-missing" aria-label="Played games without a result">
        <h3 className="fh-day-h">
          Result missing <span className="fh-day-n">{missing.length}</span>
        </h3>
        {missing.length ? (
          <>
            <p className="fh-note">
              Played but no result has come from medicoach. Confirm each one with the scorer, then
              record it in medicoach or enter it on the series.
            </p>
            <ul className="fh-lines">
              {missing.map((r) => (
                <FixtureLine key={r.key} r={r} onOpenSeries={onOpenSeries} showDate />
              ))}
            </ul>
          </>
        ) : (
          <div className="fh-empty ok">✓ Every played game has a result.</div>
        )}
      </section>

      {days.map((d) => (
        <section key={d} className="fh-day" aria-label={dayHeading(d)}>
          <h3 className="fh-day-h">
            {dayHeading(d)}
            <span className="fh-day-n">{done.filter((r) => r.date === d).length}</span>
          </h3>
          <ul className="fh-results">
            {done
              .filter((r) => r.date === d)
              .map((r) => (
                <li key={r.key} className="fh-result">
                  <Teams r={r} />
                  <div className="fh-meta">
                    <span>
                      {r.seriesName}
                      {r.round !== undefined ? ` · R${r.round}` : ''}
                    </span>
                    <span>{r.venue ?? 'No ground'}</span>
                    {r.result?.source && <span>{SOURCE[r.result.source] ?? r.result.source}</span>}
                  </div>
                  <RowActions r={r} onOpenSeries={onOpenSeries} />
                </li>
              ))}
          </ul>
        </section>
      ))}
      {!done.length && !missing.length && <div className="fh-empty">No results yet.</div>}
    </div>
  );
}

/* ─── Grounds: what's on where, one week at a time ─── */

export function GroundsWeek({ rows, today, onOpenSeries }: HubProps) {
  const [monday, setMonday] = useState(() => weekStart(today));
  const week = rows.filter((r) => inWeek(r, monday) && r.state !== 'cancelled');
  const grounds = [...new Set(week.map((r) => r.venue ?? 'No ground'))].sort((a, b) =>
    a === 'No ground' ? 1 : b === 'No ground' ? -1 : a.localeCompare(b),
  );
  return (
    <div className="fh-grounds">
      <div className="fh-toolbar">
        <div>
          <h2 className="fh-h2">What&apos;s on at each ground</h2>
          <div className="ump-sub">
            Every game of the week by ground. A ground hosting more games on a day than it has
            pitches is flagged.
          </div>
        </div>
        <WeekNav monday={monday} today={today} onChange={setMonday} />
      </div>
      {!grounds.length ? (
        <div className="fh-empty">No fixtures this week.</div>
      ) : (
        <div className="fh-ground-grid">
          {grounds.map((g) => {
            const games = week.filter((r) => (r.venue ?? 'No ground') === g);
            const clash = games.some((r) => r.issues.includes('venue-clash'));
            return (
              <article key={g} className={`fh-ground${clash ? ' clash' : ''}`}>
                <header>
                  <strong>{g}</strong>
                  <span className="fh-day-n">{games.length}</span>
                  {clash && <span className="fh-chip alert">Double-booked</span>}
                </header>
                <ul>
                  {games.map((r) => (
                    <li key={r.key}>
                      <span className="fh-strong">
                        {shortDay(r.date)} {r.time ?? ''}
                      </span>
                      <span>
                        {r.home} v {r.away}
                        {r.state === 'postponed' ? ' (postponed)' : ''}
                      </span>
                      <button className="fh-link" onClick={() => onOpenSeries(r.seriesId)}>
                        Edit
                      </button>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Fixtures & Venues hub: This week · All fixtures · Results · Venues ───
 *
 * Every series' fixtures as one list (fixture-index.ts), with the medicoach result on each
 * played game, the umpires and scorers, the ground, and the checks of the union's weekly
 * cycle (Dolphins match-week SOP):
 *   Monday   — results confirmed, the week's fixtures complete (time, ground), no ground
 *              double-booked, postponements known;
 *   Thursday — umpires and scorers appointed to every game;
 *   weekend  — games and results as they come in.
 * The office manages a fixture where it finds it — add, edit, remove, appoint umpires and
 * scorers, confirm the result — through the same server paths as the series editor
 * (FixtureManage.tsx). Seasons, stages, allocation and release stay in Seasons & series.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './api';
import { Btn } from './atoms';
import {
  FixtureEditDialog,
  OfficialsDialog,
  RemoveFixtureDialog,
  type ManageClub,
  type ManageSeries,
  type ManageVenue,
  type Person,
} from './FixtureManage';
import {
  HEAVY_WEEK_BALLS,
  HEAVY_WEEK_GAMES,
  ISSUES,
  RESTED_DAYS,
  addDays,
  filterRows,
  groundUsage,
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
const stamp = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Johannesburg',
  });
const hours = (mins: number) =>
  mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')}`;

const STATE_LABEL: Record<FixtureRow['state'], string> = {
  upcoming: 'Upcoming',
  today: 'Today',
  'awaiting-result': 'Result missing',
  result: 'Result in',
  'no-result': 'No result',
  postponed: 'Postponed',
  cancelled: 'Cancelled',
};

/** Everything the hub needs to manage fixtures; absent ⇒ read-only (finding only). */
export interface HubManage {
  series: ManageSeries[];
  clubs: ManageClub[];
  venues: ManageVenue[];
  umpires: Person[];
  scorers: Person[];
  onUpdateSeries: (id: string, updater: (s: ManageSeries) => ManageSeries) => Promise<unknown>;
  onSaveUmpires?: (seriesId: string, fixtureId: string, ids: string[]) => Promise<unknown>;
  onSaveScorers?: (seriesId: string, fixtureId: string, ids: string[]) => Promise<unknown>;
  onCreateUmpire?: (displayName: string) => Promise<Person>;
  onCreateScorer?: (displayName: string) => Promise<Person>;
  onConfirmResult?: (seriesId: string, fixtureId: string, recordedAt: string) => Promise<unknown>;
  onUnconfirmResult?: (seriesId: string, fixtureId: string) => Promise<unknown>;
  toast?: (message: string, tone?: string) => void;
}

export interface HubProps {
  rows: FixtureRow[];
  today: string;
  /** Opens a series in Seasons & series (the editor). */
  onOpenSeries: (seriesId: string) => void;
  series: Array<{ id: string; name: string }>;
  clubs: Array<{ id: string; name: string }>;
  manage?: HubManage;
}

/* ─── Shared pieces ─── */

function IssueChips({ issues }: { issues: IssueKey[] }) {
  if (!issues.length) return null;
  return (
    <span className="fh-chips">
      {issues.map((i) => (
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
      {(res.summary || r.result?.medicoachMatchUrl) && (
        <span className="fh-summary">
          {res.summary}
          {r.result?.medicoachMatchUrl && (
            <a
              className="fh-scorecard"
              href={r.result.medicoachMatchUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Scorecard: ${r.home} v ${r.away} (opens medicoach)`}
            >
              Scorecard ↗
            </a>
          )}
        </span>
      )}
    </div>
  );
}

type Dialog =
  | { kind: 'add'; seriesId?: string }
  | { kind: 'edit'; row: FixtureRow }
  | { kind: 'remove'; row: FixtureRow }
  | { kind: 'umpires' | 'scorers'; row: FixtureRow };

/** The dialogs a hub view opens, and the one that's open. */
function useDialogs(rows: FixtureRow[], manage?: HubManage) {
  const [open, setOpen] = useState<Dialog | null>(null);
  const close = () => setOpen(null);
  const saved = (m: string) => manage?.toast?.(m);
  let node: ReactNode = null;
  if (open && manage) {
    if (open.kind === 'add' || open.kind === 'edit')
      node = (
        <FixtureEditDialog
          mode={open.kind}
          series={manage.series}
          initialSeriesId={open.kind === 'edit' ? open.row.seriesId : open.seriesId}
          fixtureId={open.kind === 'edit' ? open.row.fixtureId : undefined}
          clubs={manage.clubs}
          venues={manage.venues}
          onUpdateSeries={manage.onUpdateSeries}
          onClose={close}
          onSaved={saved}
        />
      );
    else if (open.kind === 'remove')
      node = (
        <RemoveFixtureDialog
          row={open.row}
          onUpdateSeries={manage.onUpdateSeries}
          onClose={close}
          onSaved={saved}
        />
      );
    else {
      const r = open.row;
      const isUmp = open.kind === 'umpires';
      const sameDay = rows.filter((x) => x.date === r.date && x.key !== r.key);
      node = (
        <OfficialsDialog
          kind={open.kind}
          row={r}
          people={isUmp ? manage.umpires : manage.scorers}
          current={isUmp ? r.umpireIds : r.scorerIds}
          others={sameDay.map((x) => ({
            label: `${x.home} v ${x.away}`,
            time: x.time,
            ids: isUmp ? x.umpireIds : x.scorerIds,
          }))}
          onSave={(ids) =>
            (isUmp ? manage.onSaveUmpires : manage.onSaveScorers)!(r.seriesId, r.fixtureId, ids)
          }
          onCreate={isUmp ? manage.onCreateUmpire : manage.onCreateScorer}
          onClose={close}
          onSaved={saved}
        />
      );
    }
  }
  return { open: setOpen, node };
}

/** Confirm a result (or show who did). A newer result from medicoach is caught here. */
function ConfirmControl({ r, manage }: { r: FixtureRow; manage?: HubManage }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const res = r.result;
  if (!res || !manage?.onConfirmResult) return null;
  const conf = res.confirmation;
  if (conf)
    return (
      <span className="fh-confirmed" title={conf.note ?? undefined}>
        ✓ Confirmed by {conf.confirmedBy.split('@')[0]} · {stamp(conf.confirmedAt)}
        {manage.onUnconfirmResult && (
          <button
            className="fh-link"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await manage.onUnconfirmResult!(r.seriesId, r.fixtureId).catch(() => {});
              setBusy(false);
            }}
            aria-label={`Withdraw confirmation of ${r.home} v ${r.away}`}
          >
            Undo
          </button>
        )}
      </span>
    );
  return (
    <span className="fh-confirm-wrap">
      <Btn
        tone="ink"
        size="sm"
        disabled={busy || !res.recordedAt}
        aria-label={`Confirm the result of ${r.home} v ${r.away}`}
        onClick={async () => {
          setBusy(true);
          setNote(null);
          try {
            await manage.onConfirmResult!(r.seriesId, r.fixtureId, res.recordedAt!);
            manage.toast?.('Result confirmed');
          } catch (err) {
            setNote(
              err instanceof ApiError && err.code === 'result_changed'
                ? 'Medicoach sent a newer result — it is shown now. Check it, then confirm.'
                : err instanceof ApiError
                  ? err.message
                  : 'Could not confirm — check your connection.',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Confirming…' : res.changedSinceConfirmed ? 'Confirm again' : 'Confirm result'}
      </Btn>
      {note && (
        <span className="fh-confirm-note" role="alert">
          {note}
        </span>
      )}
    </span>
  );
}

/** "⋯" — the rarely used row actions, out of the way of the officials and the result. */
function MoreMenu({
  items,
  label,
}: {
  items: Array<[string, () => void, string?]>;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <span className="fh-more-menu" ref={ref}>
      <button
        className="fh-icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(!open)}
      >
        ⋯
      </button>
      {open && (
        <span className="fh-menu" role="menu">
          {items.map(([text, run, tone]) => (
            <button
              key={text}
              role="menuitem"
              className={tone ?? ''}
              onClick={() => {
                setOpen(false);
                run();
              }}
            >
              {text}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/** Edit (the common one) as a button, the rest behind "⋯". */
function RowActions({
  r,
  onOpenSeries,
  manage,
  onDialog,
}: {
  r: FixtureRow;
  onOpenSeries: (id: string) => void;
  manage?: HubManage;
  onDialog: (d: Dialog) => void;
}) {
  const label = `${r.home} v ${r.away}`;
  if (!manage)
    return (
      <span className="fh-actions">
        <button
          className="fh-btn-quiet"
          onClick={() => onOpenSeries(r.seriesId)}
          aria-label={`Edit ${label} in ${r.seriesName}`}
        >
          Edit
        </button>
      </span>
    );
  return (
    <span className="fh-actions">
      <button
        className="fh-btn-quiet"
        onClick={() => onDialog({ kind: 'edit', row: r })}
        aria-label={`Edit ${label} in ${r.seriesName}`}
      >
        Edit
      </button>
      <MoreMenu
        label={`More for ${label}`}
        items={[
          [`Open ${r.seriesName}`, () => onOpenSeries(r.seriesId)],
          [`Remove ${label}`, () => onDialog({ kind: 'remove', row: r }), 'danger'],
        ]}
      />
    </span>
  );
}

/**
 * Who's appointed, front and centre: each person as a chip (click to change), and a clear
 * "+ Add umpire" / "+ Add scorer" while a slot is empty — highlighted when the game needs it.
 */
function OfficialsRow({
  r,
  manage,
  onDialog,
}: {
  r: FixtureRow;
  manage?: HubManage;
  onDialog: (d: Dialog) => void;
}) {
  const label = `${r.home} v ${r.away}`;
  const off = r.state === 'postponed' || r.state === 'cancelled';
  const group = (
    kind: 'umpires' | 'scorers',
    names: string[],
    max: number,
    noun: string,
    canEdit: boolean,
    needed: boolean,
  ) => (
    <span
      className="fh-off-group"
      role="group"
      aria-label={kind === 'umpires' ? 'Umpires' : 'Scorers'}
    >
      <span className="fh-off-l">{kind === 'umpires' ? 'Umpires' : 'Scorers'}</span>
      {names.map((n) =>
        canEdit ? (
          <button
            key={n}
            className="fh-person"
            onClick={() => onDialog({ kind, row: r })}
            aria-label={`Change ${kind} for ${label} (${n})`}
          >
            {n}
          </button>
        ) : (
          <span key={n} className="fh-person ro">
            {n}
          </span>
        ),
      )}
      {canEdit && names.length < max && !off && (
        <button
          className={`fh-add${needed ? ' needed' : ''}`}
          onClick={() => onDialog({ kind, row: r })}
          aria-label={`Add ${noun} to ${label}`}
        >
          + Add {noun}
        </button>
      )}
      {!canEdit && !names.length && <span className="ump-sub">None</span>}
    </span>
  );
  // Before the game both are jobs (highlighted when short); after it, umpires can still be
  // recorded (who stood), scorers only show if someone was named.
  const toCome = r.state === 'upcoming' || r.state === 'today';
  return (
    <div className="fh-officials">
      {group(
        'umpires',
        r.umpires,
        2,
        'umpire',
        !!manage?.onSaveUmpires,
        toCome && r.umpires.length < 2,
      )}
      {(r.scorers.length > 0 || toCome) &&
        group(
          'scorers',
          r.scorers,
          2,
          r.scorers.length ? 'backup scorer' : 'scorer',
          !!manage?.onSaveScorers,
          toCome && !r.scorers.length,
        )}
    </div>
  );
}

/** One fixture as a line: time · teams/result · ground · officials · checks and actions. */
function FixtureLine({
  r,
  onOpenSeries,
  showDate,
  manage,
  onDialog,
}: {
  r: FixtureRow;
  onOpenSeries: (id: string) => void;
  showDate?: boolean;
  manage?: HubManage;
  onDialog: (d: Dialog) => void;
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
        </div>
        <OfficialsRow r={r} manage={manage} onDialog={onDialog} />
      </div>
      <div className="fh-side-col">
        <div className="fh-side-top">
          <span className={`fh-state state-${r.state}`}>{STATE_LABEL[r.state]}</span>
          <RowActions r={r} onOpenSeries={onOpenSeries} manage={manage} onDialog={onDialog} />
        </div>
        {/* The state already says "Result missing". */}
        <IssueChips
          issues={r.issues.filter(
            (i) => !['awaiting-result', 'no-umpires', 'one-umpire', 'no-scorer'].includes(i),
          )}
        />
        <ConfirmControl r={r} manage={manage} />
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

type CheckKey = 'results' | 'complete' | 'grounds' | 'umpires' | 'scorers' | 'postponed' | 'drafts';
const CHECK_ISSUES: Record<CheckKey, (r: FixtureRow) => boolean> = {
  results: (r) =>
    r.issues.includes('awaiting-result') ||
    r.issues.includes('unconfirmed') ||
    r.issues.includes('result-changed'),
  complete: (r) => r.issues.includes('venue-tbc') || r.issues.includes('time-tbc'),
  grounds: (r) => r.issues.includes('venue-clash'),
  umpires: (r) => r.issues.includes('no-umpires') || r.issues.includes('one-umpire'),
  scorers: (r) => r.issues.includes('no-scorer'),
  postponed: (r) => r.state === 'postponed',
  drafts: (r) => r.issues.includes('draft'),
};

export function WeekView({ rows, today, onOpenSeries, manage }: HubProps) {
  const [monday, setMonday] = useState(() => {
    // Monday and Tuesday are for confirming the weekend just played; from Wednesday the
    // week ahead is what needs work. Either way the default week holds a weekend.
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    return dow === 1 || dow === 2 ? addDays(weekStart(today), -7) : weekStart(today);
  });
  const [check, setCheck] = useState<CheckKey | null>(null);
  const dialogs = useDialogs(rows, manage);
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
        <div className="fh-toolbar-right">
          <span className="fh-count">
            {c.games} game{c.games === 1 ? '' : 's'}
            {c.postponed ? ` · ${c.postponed} postponed` : ''}
          </span>
          {manage && (
            <Btn tone="ink" size="sm" onClick={() => dialogs.open({ kind: 'add' })}>
              + Add fixture
            </Btn>
          )}
        </div>
      </div>

      <div className="fh-checks" role="group" aria-label="Weekly checks">
        {tile(
          'results',
          'Monday',
          'Results confirmed',
          c.played ? `${c.confirmed}/${c.played}` : '—',
          c.awaitingResult
            ? `${c.awaitingResult} without a result${c.toConfirm ? ` · ${c.toConfirm} to confirm` : ''}`
            : c.toConfirm
              ? `${c.toConfirm} result${c.toConfirm === 1 ? '' : 's'} to check and confirm`
              : c.played
                ? 'every result checked and confirmed'
                : 'nothing played yet this week',
          c.awaitingResult ? 'alert' : c.toConfirm ? 'warn' : c.played ? 'ok' : 'muted',
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
        {tile(
          'scorers',
          'Thursday',
          'Scorers appointed',
          c.scorersShort ? `${c.scorersShort} missing` : '✓',
          c.scorersShort
            ? `${c.scorersShort} game${c.scorersShort === 1 ? '' : 's'} to come without a scorer`
            : 'a scorer on every game to come',
          c.scorersShort ? 'warn' : 'ok',
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
                  <FixtureLine
                    key={r.key}
                    r={r}
                    onOpenSeries={onOpenSeries}
                    manage={manage}
                    onDialog={dialogs.open}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}
      {dialogs.node}
    </div>
  );
}

/* ─── All fixtures ─── */

const PAGE = 100;

export function AllFixturesView({ rows, today, onOpenSeries, series, clubs, manage }: HubProps) {
  const [f, setF] = useState<FixtureFilter>({ state: 'all' });
  const [limit, setLimit] = useState(PAGE);
  const dialogs = useDialogs(rows, manage);
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
            placeholder="Search a team, ground, series, umpire, scorer or “round 3”"
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
        <div className="fh-toolbar-right">
          <Btn tone="outline" size="sm" onClick={download} disabled={!shown.length}>
            Download CSV
          </Btn>
          {manage && (
            <Btn
              tone="ink"
              size="sm"
              onClick={() => dialogs.open({ kind: 'add', seriesId: f.seriesId })}
            >
              + Add fixture
            </Btn>
          )}
        </div>
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
                  <th>Officials</th>
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
                    <td data-label="Officials">
                      <div>
                        {r.umpires.length ? (
                          r.umpires.join(', ')
                        ) : (
                          <span className="ump-sub">No umpires</span>
                        )}
                      </div>
                      <div className="ump-sub">
                        {r.scorers.length ? `Scorer: ${r.scorers.join(', ')}` : 'No scorer'}
                      </div>
                    </td>
                    <td data-label="Status">
                      <span className={`fh-state state-${r.state}`}>{STATE_LABEL[r.state]}</span>
                      <IssueChips issues={r.issues.filter((i) => i !== 'awaiting-result')} />
                    </td>
                    <td data-label="">
                      <RowActions
                        r={r}
                        onOpenSeries={onOpenSeries}
                        manage={manage}
                        onDialog={dialogs.open}
                      />
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
      {dialogs.node}
    </div>
  );
}

/* ─── Results ─── */

const SOURCE: Record<string, string> = {
  live: 'Live scored',
  manual: 'Entered',
  import: 'Imported',
};

function ResultCard({
  r,
  onOpenSeries,
  manage,
  onDialog,
}: {
  r: FixtureRow;
  onOpenSeries: (id: string) => void;
  manage?: HubManage;
  onDialog: (d: Dialog) => void;
}) {
  const p = r.result?.play;
  const mins =
    p?.startedAt && p.endedAt
      ? Math.round((Date.parse(p.endedAt) - Date.parse(p.startedAt)) / 60_000)
      : null;
  return (
    <li className={`fh-result${r.result?.changedSinceConfirmed ? ' changed' : ''}`}>
      <div className="fh-result-main">
        <Teams r={r} />
        <div className="fh-meta">
          <span>
            {shortDay(r.date)} · {r.seriesName}
            {r.round !== undefined ? ` · R${r.round}` : ''}
          </span>
          <span>{r.venue ?? 'No ground'}</span>
          {r.result?.source && <span>{SOURCE[r.result.source] ?? r.result.source}</span>}
          {mins !== null && (
            <span>
              {hours(mins)} on the ground
              {p?.legalBalls != null ? ` · ${p.legalBalls} balls` : ''}
            </span>
          )}
        </div>
        {r.result?.changedSinceConfirmed && (
          <div className="fh-changed" role="note">
            Medicoach changed this result after it was confirmed — check it again.
          </div>
        )}
        <RowActions r={r} onOpenSeries={onOpenSeries} manage={manage} onDialog={onDialog} />
      </div>
      <div className="fh-result-side">
        <ConfirmControl r={r} manage={manage} />
      </div>
    </li>
  );
}

export function ResultsView({ rows, onOpenSeries, series, manage }: HubProps) {
  const [seriesId, setSeriesId] = useState('');
  const [q, setQ] = useState('');
  const [showConfirmed, setShowConfirmed] = useState(false);
  const dialogs = useDialogs(rows, manage);
  const scoped = filterRows(rows, { seriesId: seriesId || undefined, q });
  const missing = scoped.filter((r) => r.state === 'awaiting-result').reverse();
  const byNewest = (a: FixtureRow, b: FixtureRow) =>
    (b.date ?? '').localeCompare(a.date ?? '') || (a.time ?? '').localeCompare(b.time ?? '');
  const played = scoped
    .filter((r) => r.state === 'result' || r.state === 'no-result')
    .sort(byNewest);
  const toConfirm = played.filter((r) => !r.result?.confirmation);
  const confirmed = played.filter((r) => r.result?.confirmation);
  const days = [...new Set(confirmed.map((r) => r.date!))];

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
              have it recorded in medicoach — it arrives here on the next sync.
            </p>
            <ul className="fh-lines">
              {missing.map((r) => (
                <FixtureLine
                  key={r.key}
                  r={r}
                  onOpenSeries={onOpenSeries}
                  showDate
                  manage={manage}
                  onDialog={dialogs.open}
                />
              ))}
            </ul>
          </>
        ) : (
          <div className="fh-empty ok">✓ Every played game has a result.</div>
        )}
      </section>

      <section className="fh-missing" aria-label="Results to confirm">
        <h3 className="fh-day-h">
          To check and confirm <span className="fh-day-n">{toConfirm.length}</span>
        </h3>
        {toConfirm.length ? (
          <>
            <p className="fh-note">
              Check each score against the scorer&apos;s card (or the umpires&apos;), then confirm
              it. If medicoach later changes a confirmed result it comes back here.
            </p>
            <ul className="fh-results">
              {toConfirm.map((r) => (
                <ResultCard
                  key={r.key}
                  r={r}
                  onOpenSeries={onOpenSeries}
                  manage={manage}
                  onDialog={dialogs.open}
                />
              ))}
            </ul>
          </>
        ) : (
          <div className="fh-empty ok">✓ Every result is checked and confirmed.</div>
        )}
      </section>

      <section aria-label="Confirmed results">
        <h3 className="fh-day-h">
          Confirmed <span className="fh-day-n">{confirmed.length}</span>
          {confirmed.length > 0 && (
            <button className="fh-link" onClick={() => setShowConfirmed(!showConfirmed)}>
              {showConfirmed ? 'Hide' : 'Show'}
            </button>
          )}
        </h3>
        {showConfirmed &&
          days.map((d) => (
            <div key={d} className="fh-day">
              <div className="fh-day-sub">{dayHeading(d)}</div>
              <ul className="fh-results">
                {confirmed
                  .filter((r) => r.date === d)
                  .map((r) => (
                    <ResultCard
                      key={r.key}
                      r={r}
                      onOpenSeries={onOpenSeries}
                      manage={manage}
                      onDialog={dialogs.open}
                    />
                  ))}
              </ul>
            </div>
          ))}
      </section>
      {dialogs.node}
    </div>
  );
}

/* ─── Grounds: the week at each ground, and how hard each ground is worked ─── */

export function GroundsWeek({ rows, today, onOpenSeries, manage }: HubProps) {
  const [monday, setMonday] = useState(() => weekStart(today));
  const dialogs = useDialogs(rows, manage);
  const week = rows.filter((r) => inWeek(r, monday) && r.state !== 'cancelled');
  const grounds = [...new Set(week.map((r) => r.venue ?? 'No ground'))].sort((a, b) =>
    a === 'No ground' ? 1 : b === 'No ground' ? -1 : a.localeCompare(b),
  );
  const usage = useMemo(() => groundUsage(rows, today), [rows, today]);
  const maxWeek = Math.max(1, ...usage.flatMap((u) => u.weekly.map((w) => w.balls)));
  const played = usage.reduce((n, u) => n + u.played, 0);
  const withPlay = usage.reduce((n, u) => n + u.withPlay, 0);

  return (
    <div className="fh-grounds">
      <section aria-labelledby="fh-usage-h" className="fh-usage">
        <div className="fh-toolbar">
          <div>
            <h2 id="fh-usage-h" className="fh-h2">
              Ground use
            </h2>
            <div className="ump-sub">
              Time on the ground and balls bowled, from the scorecards — a guide to how hard each
              pitch is being worked. Heavy: {HEAVY_WEEK_GAMES}+ games or {HEAVY_WEEK_BALLS}+ balls
              in the last 7 days. Rested: no game for {RESTED_DAYS} days.
            </div>
          </div>
        </div>
        {played > 0 && withPlay < played && (
          <p className="fh-note">
            {withPlay} of {played} played games came with ground time and balls from the scorecard;
            the rest count as games only.
          </p>
        )}
        {!usage.length ? (
          <div className="fh-empty">No games on any ground yet.</div>
        ) : (
          <div className="tbl-w">
            <table className="tbl fh-tbl fh-usage-tbl" aria-label="Ground use">
              <thead>
                <tr>
                  <th>Ground</th>
                  <th>Load</th>
                  <th>Games played</th>
                  <th>On the ground</th>
                  <th>Balls bowled</th>
                  <th>Last 7 days</th>
                  <th>Last 6 weeks</th>
                  <th>Last used</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((u) => (
                  <tr key={u.venue}>
                    <td data-label="Ground">
                      <strong>{u.venue}</strong>
                      {u.upcoming > 0 && <div className="ump-sub">{u.upcoming} to come</div>}
                    </td>
                    <td data-label="Load">
                      <span className={`fh-load ${u.load}`}>
                        {
                          { heavy: 'Heavy', normal: 'Normal', rested: 'Rested', unused: 'Unused' }[
                            u.load
                          ]
                        }
                      </span>
                    </td>
                    <td data-label="Games played">
                      {u.played}
                      {u.played > u.withPlay && (
                        <span className="ump-sub"> ({u.withPlay} with scorecard)</span>
                      )}
                    </td>
                    <td data-label="On the ground">{u.minutes ? hours(u.minutes) : '—'}</td>
                    <td data-label="Balls bowled">
                      {u.legalBalls ? u.legalBalls.toLocaleString('en-GB') : '—'}
                    </td>
                    <td data-label="Last 7 days">
                      {u.weekGames} game{u.weekGames === 1 ? '' : 's'}
                      {u.weekBalls ? ` · ${u.weekBalls} balls` : ''}
                    </td>
                    <td data-label="Last 6 weeks">
                      <span
                        className="fh-spark"
                        role="img"
                        aria-label={`Balls per week: ${u.weekly.map((w) => w.balls).join(', ')}`}
                      >
                        {u.weekly.map((w) => (
                          <i
                            key={w.monday}
                            title={`Week of ${shortDay(w.monday)}: ${w.games} games, ${w.balls} balls`}
                            style={{
                              height: `${Math.max(w.games ? 12 : 4, Math.round((w.balls / maxWeek) * 100))}%`,
                            }}
                            className={w.games ? 'on' : ''}
                          />
                        ))}
                      </span>
                    </td>
                    <td data-label="Last used">{u.lastPlayed ? shortDay(u.lastPlayed) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="fh-toolbar" style={{ marginTop: 22 }}>
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
                      <button
                        className="fh-link"
                        onClick={() =>
                          manage ? dialogs.open({ kind: 'edit', row: r }) : onOpenSeries(r.seriesId)
                        }
                        aria-label={`Change the ground or time of ${r.home} v ${r.away}`}
                      >
                        Change
                      </button>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      )}
      {dialogs.node}
    </div>
  );
}

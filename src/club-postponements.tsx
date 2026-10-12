/**
 * Fixture postponements (ADR 0015) — the club and admin surfaces.
 *
 *  - `RequestPostponementModal`: a chair proposes a new date (and kick-off, while times are
 *    revealed) for one of its upcoming fixtures, with debounced rep-safe clash hints.
 *  - `PostponementsPanel`: the club's inbox on the Fixtures page — whose turn it is, the
 *    proposal history, and Accept / Counter / Decline / Withdraw / Acknowledge.
 *  - `AdminPostponements`: the union office's list with a "Set final date" override that shows
 *    the clash gate's refusal through the shared ClashPanel.
 *
 * Every component owns its own calls and invalidates the postponement + series caches; the
 * callers only mount them. Club-facing requests arrive already stripped of withheld time/venue
 * fields (ADR 0011), so nothing here has to hide them again.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  acceptPostponement,
  acknowledgePostponement,
  counterPostponement,
  createPostponement,
  declinePostponement,
  getAllPostponements,
  getClashHints,
  getClubDirectory,
  getVenues,
  overridePostponement,
  withdrawPostponement,
} from './api';
import type { ClubPostponements } from './api';
import type { Clash, PostponementProposal, PostponementRequest } from './types';
import { resolveTeam } from './data';
import { formatTime, formatWeekdayDay, formatStampDay } from './dates';
import { todayIso } from '../packages/engine/src/calendar';
import { Btn, Icon, Modal, Pill } from './atoms';
import { ClashPanel } from './ClashPanel';
import { qk } from './query';

type Toast = (msg: string, tone?: string) => void;
type Side = 'requesting' | 'opposing';
interface ClubRef {
  id: string;
  name: string;
}
// Series/fixtures are loosely typed across the app (fixtures are an untyped embedded array).
type SeriesLike = {
  id: string;
  name?: string;
  fixtures?: Array<Record<string, any>>;
  withheld?: { venue?: boolean; time?: boolean };
  [key: string]: any;
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Which side of a request `clubId` is on (the canonical lives under the opposing club). */
export function sideOf(req: PostponementRequest, clubId: string): Side {
  return req.opposingClubId === clubId ? 'opposing' : 'requesting';
}

/**
 * True when the club has something to do: an open request awaiting its answer, or an admin
 * ruling it hasn't acknowledged yet. Drives the Fixtures nav badge and the panel ordering.
 */
export function needsAttention(req: PostponementRequest, clubId: string): boolean {
  if (req.status === 'open') return req.awaiting === sideOf(req, clubId);
  if (req.status === 'admin-final') return !req.acknowledgements?.[clubId];
  return false;
}

export function postponementAttentionCount(
  data: ClubPostponements | undefined,
  clubId: string,
): number {
  if (!data) return 0;
  return [...data.inbound, ...data.outbound].filter((r) => needsAttention(r, clubId)).length;
}

/** The current (last) proposal on the table. */
export const currentProposal = (req: PostponementRequest): PostponementProposal | undefined =>
  req.proposals[req.proposals.length - 1];

/** "Sat 14 Mar · 10:00" — date plus kick-off when the request carries one. */
export function whenLabel(date?: string, time?: string): string {
  if (!date) return '—';
  const t = time ? formatTime(time) || time : '';
  return t ? `${formatWeekdayDay(date)} · ${t}` : formatWeekdayDay(date);
}

const tomorrowIso = () => {
  const d = new Date(`${todayIso()}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Short-lived echo of a value — the hint query waits until typing pauses. */
function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** The fixture a request refers to, resolved through its series snapshot when visible. */
export function describeFixture(
  req: Pick<PostponementRequest, 'seriesId' | 'fixtureId'>,
  allSeries: SeriesLike[],
  clubBy: (id: string) => unknown,
): { seriesName: string; round?: number; home: string; away: string; series?: SeriesLike } {
  const s = (allSeries || []).find((x) => x.id === req.seriesId);
  const f = s?.fixtures?.find((x) => x.id === req.fixtureId);
  if (!s || !f) return { seriesName: s?.name || 'Fixture', home: '', away: '', series: s };
  return {
    seriesName: s.name || 'Fixture',
    round: f.round,
    home: resolveTeam(s, f.home, clubBy).name,
    away: resolveTeam(s, f.away, clubBy).name,
    series: s,
  };
}

const STATUS_PILL: Record<PostponementRequest['status'], { tone: string; label: string }> = {
  open: { tone: 'gold', label: 'Open' },
  applied: { tone: 'teal', label: 'Agreed — applied' },
  // Decided and binding — the system's DONE tone (pill-navy reads as pending).
  'admin-final': { tone: 'teal', label: 'Union ruling' },
  declined: { tone: 'coral', label: 'Declined' },
  withdrawn: { tone: 'muted', label: 'Withdrawn' },
};

export function PostponementStatusPill({ status }: { status: PostponementRequest['status'] }) {
  const p = STATUS_PILL[status] ?? { tone: 'muted', label: status };
  return (
    <Pill tone={p.tone} dot>
      {p.label}
    </Pill>
  );
}

/* ─── Club: request a postponement ─── */

export function RequestPostponementModal({
  club,
  series,
  fixture,
  homeName,
  awayName,
  opponentName,
  toast,
  onClose,
}: {
  club: ClubRef;
  series: SeriesLike;
  fixture: Record<string, any>;
  homeName: string;
  awayName: string;
  opponentName: string;
  toast?: Toast;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const timeShown = !series.withheld?.time;
  const [date, setDate] = useState('');
  const [time, setTime] = useState(timeShown ? fixture.time || '' : '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const minDate = tomorrowIso();
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= minDate;
  const timeOk = !time || TIME_RE.test(time);
  const unchanged = date === fixture.date && (time || fixture.time || '') === (fixture.time || '');
  const hintKey = useDebounced(`${date}|${time}`);
  const [hDate, hTime] = hintKey.split('|');
  const hintsReady =
    /^\d{4}-\d{2}-\d{2}$/.test(hDate) && hDate >= minDate && TIME_RE.test(hTime || '00:00');
  const hints = useQuery({
    queryKey: qk.clashHints(club.id, series.id, fixture.id, hDate, hTime || ''),
    queryFn: () =>
      getClashHints(club.id, [
        {
          seriesId: series.id,
          fixtureId: fixture.id,
          date: hDate,
          ...(hTime ? { time: hTime } : {}),
        },
      ]),
    enabled: hintsReady,
    staleTime: 30_000,
  });
  const hint = hintsReady ? hints.data?.results?.[0] : undefined;
  const busyLines = hint
    ? [
        hint.groundBusy && 'The ground is already booked at that time.',
        hint.homeTeamBusy && `${homeName} already plays that day.`,
        hint.awayTeamBusy && `${awayName} already plays that day.`,
      ].filter(Boolean)
    : [];

  async function submit() {
    if (!dateOk || !timeOk || unchanged || busy) return;
    setBusy(true);
    setError('');
    try {
      await createPostponement(club.id, {
        seriesId: series.id,
        fixtureId: fixture.id,
        proposedDate: date,
        ...(timeShown && time ? { proposedTime: time } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      client.invalidateQueries({ queryKey: qk.postponements(club.id) });
      toast?.(`Postponement requested — ${opponentName} has been asked to agree the new date.`);
      onClose();
    } catch (err) {
      setError(errorText(err, 'Could not request the postponement.'));
      if (err instanceof ApiError && err.status === 409)
        client.invalidateQueries({ queryKey: qk.postponements(club.id) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      eyebrow={`${series.name || 'Fixture'} · Round ${fixture.round ?? '—'}`}
      title={
        <>
          Request a <em>postponement</em>
        </>
      }
      maxWidth={620}
      onClose={onClose}
    >
      <div className="rp-form">
        <p className="ph-desc" style={{ marginBottom: 12 }}>
          {homeName} vs {awayName} is scheduled for{' '}
          <strong>{whenLabel(fixture.date, timeShown ? fixture.time : undefined)}</strong>.{' '}
          {opponentName} is asked to agree a new date; once they accept it, the fixture moves
          straight away.
        </p>
        <div className="field-grid-2">
          <div>
            <label className="field-label">
              New date <span className="req">*</span>
            </label>
            <input
              className="field-input"
              type="date"
              aria-label="New date"
              min={minDate}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          {timeShown && (
            <div>
              <label className="field-label">Kick-off</label>
              <input
                className="field-input"
                type="time"
                aria-label="Kick-off"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          )}
        </div>
        {!timeShown && (
          <div className="rost-sub" style={{ marginTop: 6 }}>
            Kick-off times for this series haven’t been released yet — propose a date only.
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <label className="field-label">Reason (optional)</label>
          <textarea
            className="field-input"
            aria-label="Reason"
            rows={2}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>
        {hintsReady && (
          <div role="status" style={{ marginTop: 10 }}>
            {hints.isFetching && !hint ? (
              <span className="rost-sub">Checking that date…</span>
            ) : busyLines.length ? (
              <div className="field-error" style={{ whiteSpace: 'normal' }}>
                {busyLines.map((l) => (
                  <div key={l as string}>{l}</div>
                ))}
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>
                  The other club can’t accept a clashing date — try another day.
                </div>
              </div>
            ) : hint ? (
              <span className="rost-sub">No clashes found for that date.</span>
            ) : null}
          </div>
        )}
        {date && !dateOk && (
          <div className="rost-sub" style={{ color: 'var(--coral)', marginTop: 6 }}>
            Pick a date after today.
          </div>
        )}
        {dateOk && unchanged && (
          <div className="rost-sub" style={{ color: 'var(--coral)', marginTop: 6 }}>
            That is the fixture’s current date.
          </div>
        )}
        {error && (
          <div className="field-error" role="alert" style={{ marginTop: 8 }}>
            {error}
          </div>
        )}
        <div className="rp-actions">
          <Btn tone="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn
            tone="teal"
            icon={Icon.Arrow}
            disabled={!dateOk || !timeOk || unchanged || busy}
            onClick={submit}
          >
            {busy ? 'Sending…' : 'Send request'}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Club: inbox ─── */

/** Readable lines for an accept-time clash 409 (club-shaped details). */
export function clashDetailLines(details: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  const clashes = (details?.clashes as Array<Record<string, any>>) ?? [];
  for (const c of clashes) {
    const where = c.ground ? `${c.ground} ` : 'The ground ';
    const other = c.with?.home && c.with?.away ? ` (${c.with.home} v ${c.with.away})` : '';
    out.push(`${where}is already booked on ${whenLabel(c.date, c.time)}${other}.`);
  }
  const busy = (details?.teamBusy as Array<Record<string, any>>) ?? [];
  for (const b of busy) {
    const other = b.with?.home && b.with?.away ? ` (${b.with.home} v ${b.with.away})` : '';
    out.push(`${b.team || 'A side'} already plays on ${whenLabel(b.date)}${other}.`);
  }
  return out;
}

function ProposalTimeline({
  req,
  nameOfSide,
}: {
  req: PostponementRequest;
  nameOfSide: (by: PostponementProposal['by']) => string;
}) {
  return (
    <ol style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
      {req.proposals.map((p, i) => (
        <li key={`${p.at}-${i}`} style={{ marginBottom: 2 }}>
          <strong>{nameOfSide(p.by)}</strong>{' '}
          {p.by === 'admin' ? 'set' : i === 0 ? 'proposed' : 'countered with'}{' '}
          {whenLabel(p.date, p.time)}
          {p.venueName ? ` at ${p.venueName}` : ''}
          <span className="rost-sub"> · {formatStampDay(p.at)}</span>
          {p.note ? <div className="rost-sub">“{p.note}”</div> : null}
        </li>
      ))}
    </ol>
  );
}

function PostponementCard({
  club,
  req,
  allSeries,
  clubBy,
  nameOf,
  toast,
}: {
  club: ClubRef;
  req: PostponementRequest;
  allSeries: SeriesLike[];
  clubBy: (id: string) => unknown;
  nameOf: (clubId: string) => string;
  toast?: Toast;
}) {
  const client = useQueryClient();
  const side = sideOf(req, club.id);
  const otherId = side === 'opposing' ? req.requestingClubId : req.opposingClubId;
  const otherName = nameOf(otherId);
  const fx = describeFixture(req, allSeries, clubBy);
  const timeShown = !fx.series?.withheld?.time;
  const cur = currentProposal(req);
  const myTurn = req.status === 'open' && req.awaiting === side;
  const [mode, setMode] = useState<'idle' | 'counter' | 'decline'>('idle');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; lines: string[] } | null>(null);
  const minDate = tomorrowIso();
  const nameOfSide = (by: PostponementProposal['by']) =>
    by === 'admin'
      ? 'Union office'
      : by === side
        ? 'You'
        : by === 'requesting'
          ? nameOf(req.requestingClubId)
          : nameOf(req.opposingClubId);

  async function run(kind: string, call: () => Promise<unknown>, done: string) {
    setBusy(kind);
    setError(null);
    try {
      await call();
      client.invalidateQueries({ queryKey: qk.postponements(club.id) });
      if (kind === 'accept') client.invalidateQueries({ queryKey: qk.series() });
      setMode('idle');
      toast?.(done);
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      setError({
        message: errorText(err, 'That didn’t work — please try again.'),
        lines: e?.code === 'venue_clash' ? clashDetailLines(e.details) : [],
      });
      // Anything but a clash means our view is stale (turn moved, request closed, fixture
      // changed) — refetch so the card shows the truth. A clash keeps the request open as-is.
      if (e?.status === 409 && e.code !== 'venue_clash')
        client.invalidateQueries({ queryKey: qk.postponements(club.id) });
    } finally {
      setBusy(null);
    }
  }

  const counterOk =
    /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= minDate && (!time || TIME_RE.test(time));

  return (
    <div className={`clr-card ${needsAttention(req, club.id) ? 'incoming' : ''}`}>
      <div className="clr-card-head">
        <div>
          <div className="clr-eyebrow">
            Postponement · {fx.seriesName}
            {fx.round != null ? ` · Round ${fx.round}` : ''}
            {side === 'opposing' ? ` · requested by ${otherName}` : ` · with ${otherName}`}
          </div>
          <div className="clr-name">
            {fx.home && fx.away ? (
              <>
                <strong>{fx.home}</strong> vs <strong>{fx.away}</strong>
              </>
            ) : (
              'Fixture'
            )}
          </div>
          <div className="rost-sub">
            Originally <s>{whenLabel(req.originalDate, req.originalTime)}</s>
            {cur && (
              <>
                {' '}
                → <strong>{whenLabel(cur.date, cur.time)}</strong>
                {cur.venueName ? ` at ${cur.venueName}` : ''}
              </>
            )}
          </div>
          {req.reason && <div className="clr-note">“{req.reason}”</div>}
          {req.status === 'declined' && req.declineReason && (
            <div className="clr-note">Declined: “{req.declineReason}”</div>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          <PostponementStatusPill status={req.status} />
          {req.status === 'open' && (
            <div className="rost-sub" style={{ marginTop: 4 }}>
              {myTurn ? 'Your turn to respond' : `Waiting for ${otherName}`}
            </div>
          )}
        </div>
      </div>

      <ProposalTimeline req={req} nameOfSide={nameOfSide} />

      {error && (
        <div className="field-error" role="alert" style={{ marginTop: 8, whiteSpace: 'normal' }}>
          {error.message}
          {error.lines.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {error.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {mode === 'counter' && (
        <div style={{ marginTop: 10 }}>
          <div className="field-grid-2">
            <div>
              <label className="field-label">Your date</label>
              <input
                className="field-input"
                type="date"
                aria-label="Counter date"
                min={minDate}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            {timeShown && (
              <div>
                <label className="field-label">Kick-off</label>
                <input
                  className="field-input"
                  type="time"
                  aria-label="Counter kick-off"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </div>
            )}
          </div>
          <input
            className="field-input"
            aria-label="Note"
            placeholder="Note (optional)"
            maxLength={500}
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ marginTop: 8 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Btn
              tone="teal"
              size="sm"
              disabled={!counterOk || !!busy}
              onClick={() =>
                run(
                  'counter',
                  () =>
                    counterPostponement(club.id, req.id, {
                      proposedDate: date,
                      ...(timeShown && time ? { proposedTime: time } : {}),
                      ...(text.trim() ? { note: text.trim() } : {}),
                      version: req.version,
                    }),
                  `Counter-proposal sent to ${otherName}.`,
                )
              }
            >
              {busy === 'counter' ? 'Sending…' : 'Send counter-proposal'}
            </Btn>
            <Btn tone="ghost" size="sm" disabled={!!busy} onClick={() => setMode('idle')}>
              Cancel
            </Btn>
          </div>
        </div>
      )}

      {mode === 'decline' && (
        <div style={{ marginTop: 10 }}>
          <textarea
            className="field-input"
            aria-label="Decline reason"
            rows={2}
            maxLength={500}
            placeholder={`Reason (optional) — shared with ${otherName}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ width: '100%' }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Btn
              tone="ink"
              size="sm"
              disabled={!!busy}
              onClick={() =>
                run(
                  'decline',
                  () =>
                    declinePostponement(club.id, req.id, {
                      ...(text.trim() ? { declineReason: text.trim() } : {}),
                      version: req.version,
                    }),
                  'Postponement declined — the fixture keeps its date.',
                )
              }
            >
              {busy === 'decline' ? 'Declining…' : 'Confirm decline'}
            </Btn>
            <Btn tone="ghost" size="sm" disabled={!!busy} onClick={() => setMode('idle')}>
              Cancel
            </Btn>
          </div>
        </div>
      )}

      {mode === 'idle' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {myTurn && (
            <>
              <Btn
                tone="teal"
                size="sm"
                disabled={!!busy}
                onClick={() =>
                  run(
                    'accept',
                    () => acceptPostponement(club.id, req.id, req.version),
                    `Agreed — the fixture now plays on ${whenLabel(cur?.date, cur?.time)}.`,
                  )
                }
              >
                {busy === 'accept' ? 'Accepting…' : `Accept ${whenLabel(cur?.date, cur?.time)}`}
              </Btn>
              <Btn
                tone="outline"
                size="sm"
                disabled={!!busy}
                onClick={() => {
                  setMode('counter');
                  setDate('');
                  setTime('');
                  setText('');
                }}
              >
                Propose another date
              </Btn>
            </>
          )}
          {req.status === 'open' && side === 'opposing' && (
            <Btn
              tone="outline"
              size="sm"
              disabled={!!busy}
              onClick={() => {
                setMode('decline');
                setText('');
              }}
            >
              Decline
            </Btn>
          )}
          {req.status === 'open' && side === 'requesting' && (
            <Btn
              tone="ghost"
              size="sm"
              disabled={!!busy}
              onClick={() =>
                run(
                  'withdraw',
                  () => withdrawPostponement(club.id, req.id, req.version),
                  'Postponement request withdrawn.',
                )
              }
            >
              {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw request'}
            </Btn>
          )}
          {req.status === 'admin-final' && !req.acknowledgements?.[club.id] && (
            <Btn
              tone="teal"
              size="sm"
              disabled={!!busy}
              onClick={() =>
                run(
                  'ack',
                  () => acknowledgePostponement(club.id, req.id, req.version),
                  'Union ruling acknowledged.',
                )
              }
            >
              {busy === 'ack' ? 'Saving…' : 'Acknowledge ruling'}
            </Btn>
          )}
          {req.status === 'admin-final' && req.acknowledgements?.[club.id] && (
            <span className="rost-sub">Acknowledged</span>
          )}
        </div>
      )}
    </div>
  );
}

const HISTORY_LIMIT = 10;

export function PostponementsPanel({
  club,
  postponements,
  allSeries,
  clubs,
  toast,
}: {
  club: ClubRef;
  postponements: ClubPostponements;
  allSeries: SeriesLike[];
  clubs?: ClubRef[];
  toast?: Toast;
}) {
  const [showHistory, setShowHistory] = useState(false);
  // Rep-safe {id,name} directory names the other club (a rep's `clubs` holds only its own).
  const directory = useQuery({ queryKey: qk.clubDirectory(), queryFn: getClubDirectory });
  const nameOf = (id: string) =>
    (clubs || []).find((c) => c.id === id)?.name ||
    directory.data?.find((c) => c.id === id)?.name ||
    'the other club';
  const clubBy = (id: string) => (clubs || []).find((c) => c.id === id);
  const all = [...postponements.inbound, ...postponements.outbound].sort((a, b) =>
    (b.requestedAt || '').localeCompare(a.requestedAt || ''),
  );
  const active = all
    .filter((r) => r.status === 'open' || needsAttention(r, club.id))
    .sort((a, b) => Number(needsAttention(b, club.id)) - Number(needsAttention(a, club.id)));
  const history = all.filter((r) => !active.includes(r)).slice(0, HISTORY_LIMIT);
  if (!active.length && !history.length) return null;
  const card = (r: PostponementRequest) => (
    <PostponementCard
      key={r.id}
      club={club}
      req={r}
      allSeries={allSeries}
      clubBy={clubBy}
      nameOf={nameOf}
      toast={toast}
    />
  );
  return (
    <section aria-label="Postponements" style={{ marginTop: 14 }}>
      <div className="rp-section-eyebrow">Postponements</div>
      {active.length > 0 ? (
        <div className="clr-list" style={{ marginTop: 6 }}>
          {active.map(card)}
        </div>
      ) : (
        <p className="ph-desc" style={{ margin: '4px 0' }}>
          No postponements in progress.
        </p>
      )}
      {history.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <Btn tone="ghost" size="sm" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Hide' : 'Show'} past requests ({history.length})
          </Btn>
          {showHistory && <div className="clr-list">{history.map(card)}</div>}
        </div>
      )}
    </section>
  );
}

/** The open request (if any) for one fixture — the grid shows it instead of a Postpone button. */
export function openRequestFor(
  data: ClubPostponements | undefined,
  seriesId: string,
  fixtureId: string,
): PostponementRequest | undefined {
  if (!data) return undefined;
  return [...data.inbound, ...data.outbound].find(
    (r) => r.status === 'open' && r.seriesId === seriesId && r.fixtureId === fixtureId,
  );
}

/** Struck-through original date under a postponed fixture's new date (club + admin grids). */
export function PostponedNote({ fixture }: { fixture: Record<string, any> }): ReactNode {
  if (fixture.status !== 'postponed') return null;
  return (
    <div style={{ marginTop: 2 }}>
      <Pill tone="gold">Postponed</Pill>
      {fixture.originalDate && fixture.originalDate !== fixture.date && (
        <div className="rost-sub" style={{ fontSize: 10.5 }}>
          was <s>{formatWeekdayDay(fixture.originalDate)}</s>
        </div>
      )}
    </div>
  );
}

/* ─── Admin ─── */

const ADMIN_FILTERS: Array<{ k: PostponementRequest['status'] | 'all'; l: string }> = [
  { k: 'open', l: 'Open' },
  { k: 'applied', l: 'Agreed' },
  { k: 'admin-final', l: 'Union ruling' },
  { k: 'declined', l: 'Declined' },
  { k: 'withdrawn', l: 'Withdrawn' },
  { k: 'all', l: 'All' },
];

function OverrideModal({
  req,
  label,
  toast,
  onClose,
}: {
  req: PostponementRequest;
  label: string;
  toast?: Toast;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const cur = currentProposal(req);
  const venues = useQuery({ queryKey: qk.venues(), queryFn: getVenues });
  const [date, setDate] = useState(cur?.date || req.originalDate || '');
  const [time, setTime] = useState(cur?.time || req.originalTime || '');
  const [venueChoice, setVenueChoice] = useState(''); // '' keep | venue id | '__other__'
  const [venueName, setVenueName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [clashes, setClashes] = useState<Clash[]>([]);
  const ok =
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    (!time || TIME_RE.test(time)) &&
    (venueChoice !== '__other__' || venueName.trim().length > 0);

  async function submit() {
    if (!ok || busy) return;
    setBusy(true);
    setError('');
    setClashes([]);
    try {
      await overridePostponement(req.id, {
        date,
        ...(time ? { time } : {}),
        ...(venueChoice && venueChoice !== '__other__' ? { venueId: venueChoice } : {}),
        ...(venueChoice === '__other__' ? { venueName: venueName.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        version: req.version,
      });
      client.invalidateQueries({ queryKey: qk.allPostponements() });
      client.invalidateQueries({ queryKey: qk.series() });
      toast?.('Final date set — both clubs have been notified.');
      onClose();
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      const list = Array.isArray(e?.details?.clashes) ? (e!.details!.clashes as Clash[]) : [];
      if (list.length) setClashes(list);
      else setError(errorText(err, 'Could not set the final date.'));
      if (e?.status === 409 && !list.length)
        client.invalidateQueries({ queryKey: qk.allPostponements() });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      eyebrow={`Postponements · ${label}`}
      title={
        <>
          Set the <em>final date</em>
        </>
      }
      maxWidth={640}
      onClose={onClose}
    >
      <div className="rp-form">
        <p className="ph-desc" style={{ marginBottom: 12 }}>
          Your ruling moves the fixture now, overrides whatever the clubs agreed, and asks both
          chairs to acknowledge it. Originally {whenLabel(req.originalDate, req.originalTime)}.
        </p>
        <div className="field-grid-2">
          <div>
            <label className="field-label">
              Date <span className="req">*</span>
            </label>
            <input
              className="field-input"
              type="date"
              aria-label="Final date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label">Kick-off</label>
            <input
              className="field-input"
              type="time"
              aria-label="Final kick-off"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label">Venue</label>
            <select
              className="field-select"
              aria-label="Venue"
              value={venueChoice}
              onChange={(e) => {
                setVenueChoice(e.target.value);
                setVenueName('');
              }}
            >
              <option value="">Keep the current venue</option>
              {(venues.data ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
              <option value="__other__">Other (type the name)</option>
            </select>
          </div>
          {venueChoice === '__other__' && (
            <div>
              <label className="field-label">
                Venue name <span className="req">*</span>
              </label>
              <input
                className="field-input"
                aria-label="Venue name"
                maxLength={120}
                value={venueName}
                onChange={(e) => setVenueName(e.target.value)}
              />
            </div>
          )}
        </div>
        <div style={{ marginTop: 12 }}>
          <label className="field-label">Note to the clubs (optional)</label>
          <input
            className="field-input"
            aria-label="Note to the clubs"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {clashes.length > 0 && <ClashPanel heading="That date clashes" clashes={clashes} />}
        {error && (
          <div className="field-error" role="alert" style={{ marginTop: 8 }}>
            {error}
          </div>
        )}
        <div className="rp-actions">
          <Btn tone="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn tone="teal" icon={Icon.Check} disabled={!ok || busy} onClick={submit}>
            {busy ? 'Saving…' : 'Set final date'}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

export function AdminPostponements({
  allSeries,
  clubs,
  toast,
}: {
  allSeries: SeriesLike[];
  clubs: ClubRef[];
  toast?: Toast;
}) {
  const [filter, setFilter] = useState<PostponementRequest['status'] | 'all'>('open');
  const [ruling, setRuling] = useState<PostponementRequest | null>(null);
  const query = useQuery({
    queryKey: qk.allPostponements(),
    queryFn: () => getAllPostponements(),
  });
  const all = query.data ?? [];
  const nameOf = (id: string) => (clubs || []).find((c) => c.id === id)?.name || id;
  const clubBy = (id: string) => (clubs || []).find((c) => c.id === id);
  const countOf = (k: string) =>
    k === 'all' ? all.length : all.filter((r) => r.status === k).length;
  const list = filter === 'all' ? all : all.filter((r) => r.status === filter);
  const label = (r: PostponementRequest) => {
    const fx = describeFixture(r, allSeries, clubBy);
    return `${fx.seriesName}${fx.round != null ? ` · R${fx.round}` : ''}`;
  };

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Admin Console / Postponements</div>
          <h1 className="ph-title">
            Fixture <em>Postponements</em>
          </h1>
          <p className="ph-desc">
            Clubs negotiate new dates between themselves; an agreed date moves the fixture
            automatically. Step in with a final date when they can’t agree — or to correct one they
            did — and both chairs are asked to acknowledge your ruling.
          </p>
        </div>
      </div>

      <div className="filter-row" style={{ marginTop: 14 }}>
        {ADMIN_FILTERS.map((b) => (
          <button
            key={b.k}
            className={`filter-pill ${filter === b.k ? 'active' : ''}`}
            onClick={() => setFilter(b.k)}
          >
            {b.l} <span style={{ opacity: 0.7, marginLeft: 4 }}>{countOf(b.k)}</span>
          </button>
        ))}
      </div>

      {query.isError ? (
        <div className="field-error" role="alert" style={{ marginTop: 14 }}>
          {errorText(query.error, 'Could not load postponements.')}
        </div>
      ) : list.length === 0 ? (
        <div
          style={{
            marginTop: 14,
            padding: '40px 16px',
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 13,
            background: 'var(--white)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-lg)',
          }}
        >
          {query.isLoading ? 'Loading…' : 'No postponement requests match this filter.'}
        </div>
      ) : (
        <div className="tbl-w" style={{ marginTop: 14 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Fixture</th>
                <th>Requested by → asked</th>
                <th>Original</th>
                <th>Latest proposal</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const fx = describeFixture(r, allSeries, clubBy);
                const cur = currentProposal(r);
                const acks = Object.keys(r.acknowledgements ?? {}).length;
                return (
                  <tr key={r.id}>
                    <td>
                      <div className="rost-name">{label(r)}</div>
                      {fx.home && (
                        <div className="rost-sub">
                          {fx.home} vs {fx.away}
                        </div>
                      )}
                      {r.reason && <div className="rost-sub">“{r.reason}”</div>}
                    </td>
                    <td>
                      <div style={{ fontSize: 12.5 }}>
                        {nameOf(r.requestingClubId)}{' '}
                        <span style={{ color: 'var(--muted)' }}>→</span> {nameOf(r.opposingClubId)}
                      </div>
                      <div className="rost-sub">{formatStampDay(r.requestedAt)}</div>
                    </td>
                    <td>
                      <span className="rost-sub">{whenLabel(r.originalDate, r.originalTime)}</span>
                    </td>
                    <td>
                      <div style={{ fontSize: 12.5 }}>
                        {whenLabel(cur?.date, cur?.time)}
                        {cur?.venueName ? ` · ${cur.venueName}` : ''}
                      </div>
                      {cur && (
                        <div className="rost-sub">
                          by{' '}
                          {cur.by === 'admin'
                            ? 'union office'
                            : nameOf(
                                cur.by === 'requesting' ? r.requestingClubId : r.opposingClubId,
                              )}
                        </div>
                      )}
                    </td>
                    <td>
                      <PostponementStatusPill status={r.status} />
                      {r.status === 'open' && (
                        <div className="rost-sub">
                          Waiting for{' '}
                          {nameOf(
                            r.awaiting === 'requesting' ? r.requestingClubId : r.opposingClubId,
                          )}
                        </div>
                      )}
                      {r.status === 'admin-final' && (
                        <div className="rost-sub">Acknowledged {acks}/2</div>
                      )}
                      {r.status === 'declined' && r.declineReason && (
                        <div className="rost-sub">“{r.declineReason}”</div>
                      )}
                    </td>
                    <td>
                      {r.status !== 'withdrawn' ? (
                        <Btn tone="outline" size="sm" onClick={() => setRuling(r)}>
                          Set final date
                        </Btn>
                      ) : (
                        <span className="rost-sub">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {ruling && (
        <OverrideModal
          req={ruling}
          label={label(ruling)}
          toast={toast}
          onClose={() => setRuling(null)}
        />
      )}
    </div>
  );
}

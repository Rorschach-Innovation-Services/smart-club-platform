/* ─── Union office: Medicoach sync (ADR 0016) ───
 *
 * Shown only when the tenant has `features.medicoachSync`. One page for the admin to see what
 * the 15-minute sync is doing and to resolve what it could not:
 *   - health: when the sync last worked, and — when the last run failed — why, in plain
 *     language (the technical text stays behind "Details");
 *   - the conflict inbox (SYNCCONFLICT#): medicoach schedule changes held because the venue
 *     is not recognised or the change would double-book a ground. Both versions side by side;
 *     "Accept medicoach's change" re-runs the clash gate (refused while it still clashes),
 *     "Keep smart club's version" sends ours back to medicoach;
 *   - the outbox (PENDINGSYNC#): smart-club changes medicoach has not accepted yet. A row that
 *     failed 5+ times is "stuck" (still retried) and offers Retry now / Drop;
 *   - changes held until a draft or withheld series is released/revealed, each linked to it;
 *   - recent activity, and "Sync now": flush the outbox, then pull, right away.
 * A second tab, "Match monitor" (MatchMonitor.tsx), follows every game of a day live from
 * medicoach's scoring: start times, score now, last input, innings change, finish, delays.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import * as api from './api';
import { ApiError } from './api';
import { Btn, Modal, Pill } from './atoms';
import { MatchMonitor } from './MatchMonitor';
import { qk } from './query';
import type { Series } from './types';

const fmtWhen = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Africa/Johannesburg',
      })
    : '—';

/** "4 min ago", "2 h ago", "3 days ago" — beside the absolute time, never instead of it. */
function ago(iso?: string | null): string {
  if (!iso) return '';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins) || mins < 0) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const RUN_LABEL: Record<api.MedicoachSyncLog['trigger'], string> = {
  cron: 'Scheduled',
  manual: 'Sync now',
  write: 'Fixture edit',
  cli: 'Command-line tool',
};

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled',
  postponed: 'Postponed',
  cancelled: 'Cancelled',
};

function logSummary(l: api.MedicoachSyncLog): string {
  if (l.kind === 'new-fixtures')
    return `${l.fixtures} new fixture(s) not in medicoach yet — they need a bundle top-up from your operator.`;
  if (l.kind === 'push' && l.push) {
    const p = l.push;
    const bits = [
      p.applied ? `${p.applied} accepted` : '',
      p.unchanged ? `${p.unchanged} already up to date` : '',
      p.stale ? `${p.stale} overtaken by a newer medicoach edit` : '',
      p.unmapped ? `${p.unmapped} unknown to medicoach` : '',
      p.errors ? `${p.errors} not accepted` : '',
    ].filter(Boolean);
    return `Sent ${p.sent} change(s) to medicoach${bits.length ? `: ${bits.join(', ')}` : ''}.`;
  }
  const c = l.counts;
  const bits = [
    c.resultsStored ? `${c.resultsStored} result(s)` : '',
    c.resultsCleared ? `${c.resultsCleared} result(s) cleared` : '',
    c.scheduleApplied ? `${c.scheduleApplied} reschedule(s) applied` : '',
    c.scheduleConflicts ? `${c.scheduleConflicts} held for your review` : '',
    c.scheduleStale ? `${c.scheduleStale} older change(s) ignored` : '',
    c.slotsFilled ? `${c.slotsFilled} knockout side(s) filled` : '',
    c.unmapped ? `${c.unmapped} fixture(s) smart club doesn't know` : '',
  ].filter(Boolean);
  if (l.outcome === 'error' && !bits.length) return 'The run did not finish.';
  return bits.length
    ? `Received ${bits.join(', ')}.`
    : `Received ${l.fixtures} change(s), nothing to apply.`;
}

/** A fixture as clubs know it, from the series cache: "UKZN CC v Crusaders CC". */
function fixtureLabel(
  allSeries: Series[],
  seriesId: string,
  fixtureId: string,
): { match: string; when: string; seriesName: string } {
  const s = allSeries.find((x) => x.id === seriesId);
  const f = (s?.fixtures as Array<Record<string, string>> | undefined)?.find(
    (x) => x.id === fixtureId,
  );
  const name = (side?: string) =>
    s?.participants?.find((p) => p.teamId === side)?.name ?? side ?? '?';
  return {
    match: f ? `${name(f.home)} v ${name(f.away)}` : `Fixture ${fixtureId}`,
    when: f?.date ? `${f.date}${f.time ? ` ${f.time}` : ''}` : '',
    seriesName: s?.name ?? seriesId,
  };
}

/** Technical text, collapsed by default (native <details>: keyboard and screen-reader ready). */
function Details({ children }: { children: ReactNode }) {
  return (
    <details className="mcs-details">
      <summary>Details</summary>
      <div className="mcs-details-body">{children}</div>
    </details>
  );
}

type Parts = api.MedicoachSchedulePartsView;

function partText(p: Parts, key: 'date' | 'time' | 'venue' | 'status'): string {
  if (key === 'date') return p.dateTbc ? 'TBC' : (p.date ?? '—');
  if (key === 'time') return p.dateTbc ? '—' : (p.time ?? 'TBC');
  if (key === 'status') return STATUS_LABEL[p.status ?? 'scheduled'] ?? p.status ?? '—';
  return p.venue ?? '—';
}

function ConflictCard({
  c,
  busy,
  onAccept,
  onKeep,
  onOpen,
}: {
  c: api.MedicoachSyncConflict;
  busy: string | null;
  onAccept: () => void;
  onKeep: () => void;
  onOpen: () => void;
}) {
  const ours: Parts = { ...c.current };
  const theirs: Parts = c.proposedParts ?? {};
  const title = c.matchLine ?? `Fixture ${c.fixtureId}`;
  const headingId = `mcs-c-${c.ref.replace(/[^a-z0-9]/gi, '-')}`;
  return (
    <article className="mcs-card" aria-labelledby={headingId}>
      <div className="mcs-card-head">
        <div>
          <div className="mcs-card-title" id={headingId}>
            {title}
          </div>
          <div className="ump-sub">
            {c.seriesName ?? c.seriesId} · medicoach changed it {fmtWhen(c.proposed.changedAt)}
          </div>
        </div>
        <Pill tone={c.reason === 'clash' ? 'coral' : 'gold'}>
          {c.reason === 'clash' ? 'Would double-book a ground' : 'Venue not recognised'}
        </Pill>
      </div>
      <table className="mcs-compare">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Field</span>
            </th>
            <th scope="col">Smart club now</th>
            <th scope="col">medicoach wants</th>
          </tr>
        </thead>
        <tbody>
          {(['date', 'time', 'venue', 'status'] as const).map((k) => {
            const a = partText(ours, k);
            const b = partText(theirs, k);
            const differs = a !== b;
            return (
              <tr key={k} className={differs ? 'mcs-diff' : undefined}>
                <th scope="row">{k[0].toUpperCase() + k.slice(1)}</th>
                <td>{a}</td>
                <td>
                  {b}
                  {differs && <span className="sr-only"> (changed)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mcs-reason">
        {c.reason === 'clash' ? (
          <>
            <strong>Why it&apos;s held:</strong> medicoach&apos;s version would put two matches on
            the same ground at the same time.
            <ul>
              {c.detail.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <strong>Why it&apos;s held:</strong> medicoach named a venue that isn&apos;t in your
            ground list
            {theirs.venue ? <> (“{theirs.venue}”)</> : null}. Add it as a ground on Fixtures &amp;
            Venues, then accept — or keep smart club&apos;s version.
          </>
        )}
      </div>
      <div className="mcs-card-actions">
        <Btn tone="ink" size="sm" disabled={busy !== null} onClick={onAccept}>
          {busy === `apply:${c.ref}` ? 'Accepting…' : "Accept medicoach's change"}
        </Btn>
        <Btn tone="outline" size="sm" disabled={busy !== null} onClick={onKeep}>
          {busy === `discard:${c.ref}` ? 'Keeping…' : "Keep smart club's version"}
        </Btn>
        <Btn tone="ghost" size="sm" onClick={onOpen}>
          Open fixture
        </Btn>
      </div>
      <p className="mcs-note">
        Keeping your version sends smart club&apos;s version back to medicoach on the next sync, so
        both sides match again.
      </p>
    </article>
  );
}

type Failure = NonNullable<api.MedicoachSyncStatus['outbox']>['failures'][number];

function OutboxCard({
  f,
  label,
  busy,
  onRetry,
  onDrop,
  onOpenSeries,
}: {
  f: Failure;
  label: ReturnType<typeof fixtureLabel>;
  busy: string | null;
  onRetry: () => void;
  onDrop: () => void;
  onOpenSeries: () => void;
}) {
  const headingId = `mcs-o-${f.ref.replace(/[^a-z0-9]/gi, '-')}`;
  return (
    <article className="mcs-card" aria-labelledby={headingId}>
      <div className="mcs-card-head">
        <div>
          <div className="mcs-card-title" id={headingId}>
            {label.match}
          </div>
          <div className="ump-sub">
            <a
              href={`/admin/fixtures?series=${encodeURIComponent(f.seriesId)}`}
              onClick={(e) => {
                e.preventDefault();
                onOpenSeries();
              }}
            >
              {label.seriesName}
            </a>
            {label.when ? ` · ${label.when}` : ''}
          </div>
        </div>
        {f.stuck ? (
          <Pill tone="coral">Stuck · {f.attempts} tries</Pill>
        ) : (
          <Pill tone="navy">Retrying automatically</Pill>
        )}
      </div>
      <div className="mcs-kv">
        <span className="mcs-kv-l">Sending</span>
        <span className="mcs-wrap">{f.proposed}</span>
      </div>
      <p className="mcs-error-text">{f.lastErrorText || 'medicoach has not accepted it yet.'}</p>
      {f.stuck && (
        <p className="mcs-note">
          We keep trying every 15 minutes. Retry now once the problem is fixed, or drop the change
          if medicoach&apos;s version should stand.
        </p>
      )}
      <Details>
        <div>
          Last error: <code>{f.lastError ?? '—'}</code>
        </div>
        <div>
          Tries: {f.attempts} · last tried {fmtWhen(f.lastAttemptAt)} · queued{' '}
          {fmtWhen(f.enqueuedAt)}
        </div>
      </Details>
      {f.stuck && (
        <div className="mcs-card-actions">
          <Btn tone="ink" size="sm" disabled={busy !== null} onClick={onRetry}>
            {busy === `retry:${f.ref}` ? 'Retrying…' : 'Retry now'}
          </Btn>
          <Btn tone="outline" size="sm" disabled={busy !== null} onClick={onDrop}>
            Drop…
          </Btn>
        </div>
      )}
    </article>
  );
}

export function AdminMedicoachSyncView({
  allSeries = [],
  onEditFixture,
  onOpenSeries,
  onToast,
}: {
  /** The series cache — fixtures are named by their teams, not their ids. */
  allSeries?: Series[];
  onEditFixture: (seriesId: string, fixtureId: string) => void;
  /** Opens one series on Fixtures & Venues. */
  onOpenSeries?: (seriesId: string) => void;
  onToast: (message: string, tone?: string) => void;
}) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: qk.medicoachSync(), queryFn: api.getMedicoachSyncStatus });
  const [busy, setBusy] = useState<string | null>(null);
  const [dropping, setDropping] = useState<Failure | null>(null);
  const [tab, setTab] = useState<'monitor' | 'sync'>(() => {
    try {
      return localStorage.getItem('smartclub.medicoachSync.tab') === 'sync' ? 'sync' : 'monitor';
    } catch {
      return 'monitor';
    }
  });
  const pickTab = (next: 'monitor' | 'sync') => {
    setTab(next);
    try {
      localStorage.setItem('smartclub.medicoachSync.tab', next);
    } catch {
      /* per-browser convenience only */
    }
  };
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: qk.medicoachSync() });
    queryClient.invalidateQueries({ queryKey: qk.series() });
  };
  const openSeries = (id: string) => (onOpenSeries ?? ((sid) => onEditFixture(sid, '')))(id);

  async function run(
    key: string,
    fn: () => Promise<unknown>,
    ok: string | ((r: unknown) => [string, string?]),
    fail: string,
  ) {
    setBusy(key);
    try {
      const r = await fn();
      if (typeof ok === 'string') onToast(ok);
      else onToast(...ok(r));
    } catch (err) {
      onToast(err instanceof ApiError ? `${fail}: ${err.message}` : fail, 'warn');
    } finally {
      setBusy(null);
      refresh();
    }
  }

  const data = status.data;
  const health = data?.health ?? null;
  const conflicts = data?.conflicts ?? [];
  const failures = data?.outbox?.failures ?? [];
  const stuck = failures.filter((f) => f.stuck);
  const held = data?.outbox?.held ?? [];
  const lastFailed =
    !!health?.lastErrorAt &&
    (!health.lastSuccessAt || Date.parse(health.lastErrorAt) > Date.parse(health.lastSuccessAt));

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Union office / Medicoach sync</div>
          <h1 className="ph-title">
            Medicoach <em>sync</em>
          </h1>
          <p className="ph-desc">
            {tab === 'monitor' ? (
              <>
                Every game of the day as medicoach&apos;s live scoring sees it: start time, score
                now, the scorer&apos;s last input, innings change and finish, with late starts and
                delays between balls flagged.
              </>
            ) : (
              <>
                Results and reschedules come in from medicoach every 15 minutes, and fixture changes
                made here go out to medicoach on the same run. Changes that would double-book a
                ground, or name a ground we don&apos;t know, wait here for you.
              </>
            )}
          </p>
        </div>
        {tab === 'sync' && (
          <div className="ph-actions">
            <Btn
              tone="ink"
              size="sm"
              disabled={busy !== null || !data?.enabled}
              onClick={() =>
                run(
                  'sync',
                  api.medicoachSyncNow,
                  (r) =>
                    (r as { status?: string })?.status === 'dry-run'
                      ? ['Dry run — the sync connection isn’t configured, so nothing was sent.']
                      : ['Sync finished'],
                  'The sync did not finish',
                )
              }
            >
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </Btn>
          </div>
        )}
      </div>

      <div className="mm-tabs" role="tablist" aria-label="Medicoach sync">
        {(
          [
            ['monitor', 'Match monitor'],
            ['sync', 'Sync health'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={`mm-tab${tab === k ? ' on' : ''}`}
            onClick={() => pickTab(k)}
          >
            {label}
            {k === 'sync' && (status.data?.conflicts?.length ?? 0) > 0 && (
              <span className="mm-chip-n">{status.data!.conflicts!.length}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'monitor' ? (
        status.data && !status.data.enabled ? (
          <div className="mcs-empty">
            The medicoach sync isn&apos;t switched on for this union. Your platform operator turns
            it on.
          </div>
        ) : (
          <MatchMonitor />
        )
      ) : status.isLoading ? (
        <div className="mcs-empty" role="status">
          Loading the sync status…
        </div>
      ) : status.isError ? (
        <div className="mcs-empty" role="alert">
          Couldn&apos;t load the sync status.{' '}
          <Btn tone="outline" size="sm" onClick={() => status.refetch()}>
            Try again
          </Btn>
        </div>
      ) : !data?.enabled ? (
        <div className="mcs-empty">
          The medicoach sync isn&apos;t switched on for this union. Your platform operator turns it
          on.
        </div>
      ) : (
        <>
          {data.dryRun && (
            <div className="insights-callout warn" role="note" style={{ marginBottom: 12 }}>
              <strong>Dry run.</strong> The sync connection isn&apos;t configured yet, so nothing is
              sent to or fetched from medicoach.
            </div>
          )}

          <div className="mcs-health" data-testid="mcs-health">
            <div>
              <div className="mcs-stat-label">Last successful sync</div>
              {health?.lastSuccessAt ? (
                <div className="mcs-health-value">
                  {fmtWhen(health.lastSuccessAt)}
                  <span className="mcs-health-ago"> · {ago(health.lastSuccessAt)}</span>
                </div>
              ) : (
                <div className="mcs-health-value mcs-muted">No successful sync yet</div>
              )}
            </div>
            <Pill tone={lastFailed ? 'coral' : health?.lastSuccessAt ? 'teal' : 'muted'} dot>
              {lastFailed ? 'Last run failed' : health?.lastSuccessAt ? 'Working' : 'Waiting'}
            </Pill>
          </div>
          {lastFailed && (
            <div className="insights-callout alert mcs-alert" role="alert">
              <div>
                <strong>The last sync failed ({fmtWhen(health!.lastErrorAt)}).</strong>{' '}
                {health!.lastErrorText}
              </div>
              <Details>
                <code>{health!.lastError}</code>
              </Details>
            </div>
          )}

          <div className="mcs-stats" data-testid="mcs-stats">
            <div className="mcs-stat">
              <div className="mcs-stat-label">For your review</div>
              <div className="mcs-stat-value">{conflicts.length}</div>
              <div className="ump-sub">medicoach changes held</div>
            </div>
            <div className="mcs-stat">
              <div className="mcs-stat-label">Waiting to send</div>
              <div className="mcs-stat-value">{data.outbox?.count ?? 0}</div>
              <div className="ump-sub">
                {[
                  stuck.length ? `${stuck.length} stuck` : '',
                  failures.length - stuck.length
                    ? `${failures.length - stuck.length} retrying`
                    : '',
                  held.length ? `${held.length} held until release` : '',
                ]
                  .filter(Boolean)
                  .join(' · ') || 'nothing failing'}
              </div>
            </div>
            <div className="mcs-stat">
              <div className="mcs-stat-label">Reports to open</div>
              <div className="mcs-stat-value">{data.pendingReports ?? 0}</div>
              <div className="ump-sub">
                {data.noticesFailed
                  ? `${data.noticesFailed} notice(s) failed, retrying`
                  : data.pendingReports
                    ? "captain's reports retrying"
                    : "captain's reports all opened"}
              </div>
            </div>
          </div>

          <h2 className="mcs-heading">medicoach changes for your review</h2>
          {!conflicts.length ? (
            <div className="mcs-empty">Nothing to review — every medicoach change has applied.</div>
          ) : (
            <div className="mcs-cards" data-testid="mcs-conflicts">
              {conflicts.map((c) => (
                <ConflictCard
                  key={c.ref}
                  c={c}
                  busy={busy}
                  onOpen={() => onEditFixture(c.seriesId, c.fixtureId)}
                  onAccept={() =>
                    run(
                      `apply:${c.ref}`,
                      () => api.applyMedicoachConflict(c.ref),
                      "medicoach's change accepted",
                      'Not accepted',
                    )
                  }
                  onKeep={() =>
                    run(
                      `discard:${c.ref}`,
                      () => api.discardMedicoachConflict(c.ref),
                      "Kept smart club's version — it goes to medicoach on the next sync",
                      "Couldn't keep smart club's version",
                    )
                  }
                />
              ))}
            </div>
          )}

          {failures.length > 0 && (
            <>
              <h2 className="mcs-heading">Changes medicoach hasn&apos;t accepted yet</h2>
              <div className="mcs-cards" data-testid="mcs-outbox-failures">
                {failures.map((f) => (
                  <OutboxCard
                    key={f.ref}
                    f={f}
                    label={fixtureLabel(allSeries, f.seriesId, f.fixtureId)}
                    busy={busy}
                    onOpenSeries={() => openSeries(f.seriesId)}
                    onDrop={() => setDropping(f)}
                    onRetry={() =>
                      run(
                        `retry:${f.ref}`,
                        () => api.retryMedicoachOutbox(f.ref),
                        (r) => {
                          const res = r as { status: string; lastErrorText?: string };
                          if (res.status === 'sent') return ['Sent to medicoach'];
                          if (res.status === 'failed')
                            return [`Still not accepted: ${res.lastErrorText ?? ''}`, 'warn'];
                          if (res.status === 'held')
                            return ['Held until the series is released or revealed'];
                          if (res.status === 'dry-run')
                            return ['Dry run — the sync connection isn’t configured', 'warn'];
                          return ['Queued — it goes out on the next sync'];
                        },
                        "Couldn't retry",
                      )
                    }
                  />
                ))}
              </div>
            </>
          )}

          {held.length > 0 && (
            <>
              <h2 className="mcs-heading">Held until released or revealed</h2>
              <p className="mcs-note">
                medicoach&apos;s match centre is public, so changes to draft or withheld series are
                held and go out when you release or reveal.
              </p>
              <ul className="mcs-list" data-testid="mcs-outbox-held">
                {held.map((h) => {
                  const l = fixtureLabel(allSeries, h.seriesId, h.fixtureId);
                  return (
                    <li key={h.ref}>
                      <div>
                        <div className="mcs-card-title">{l.match}</div>
                        <div className="ump-sub mcs-wrap">
                          {h.proposed} · queued {fmtWhen(h.enqueuedAt)}
                        </div>
                      </div>
                      <a
                        className="mcs-link"
                        href={`/admin/fixtures?series=${encodeURIComponent(h.seriesId)}`}
                        onClick={(e) => {
                          e.preventDefault();
                          openSeries(h.seriesId);
                        }}
                      >
                        {l.seriesName} →
                      </a>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          <h2 className="mcs-heading">Recent activity</h2>
          {!data.logs?.length ? (
            <div className="mcs-empty">
              No sync activity yet. Runs that change nothing aren&apos;t listed here — the last
              successful sync above shows the sync is running.
            </div>
          ) : (
            <ul className="mcs-list mcs-log" data-testid="mcs-logs">
              {data.logs.map((l) => (
                <li key={l.id}>
                  <div className="mcs-log-when">
                    <div>{fmtWhen(l.at)}</div>
                    <div className="ump-sub">{RUN_LABEL[l.trigger] ?? 'Scheduled'}</div>
                  </div>
                  <div className="mcs-log-what">
                    {l.outcome === 'error' && <Pill tone="coral">Problem</Pill>} {logSummary(l)}
                    {l.message && <div className="mcs-error-text">{l.message}</div>}
                    {(l.error || l.newFixtureRefs?.length) && (
                      <Details>
                        {l.error && (
                          <div>
                            <code>{l.error}</code>
                          </div>
                        )}
                        {l.newFixtureRefs?.length ? (
                          <div className="mcs-wrap">
                            <code>{l.newFixtureRefs.join(', ')}</code>
                          </div>
                        ) : null}
                      </Details>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data.cursor && (
            <p className="mcs-note">
              Sync position <code>{data.cursor.cursor}</code>, moved{' '}
              {fmtWhen(data.cursor.updatedAt)}.
            </p>
          )}
        </>
      )}

      {dropping && (
        <Modal
          eyebrow="Medicoach sync"
          title="Drop this change?"
          maxWidth={480}
          onClose={() => setDropping(null)}
        >
          <p style={{ fontSize: 13, lineHeight: 1.6, margin: '0 0 10px' }}>
            {fixtureLabel(allSeries, dropping.seriesId, dropping.fixtureId).match}:{' '}
            <strong>{dropping.proposed}</strong> will never be sent. medicoach keeps its own version
            until the fixture is next edited here.
          </p>
          <div className="mcs-card-actions">
            <Btn tone="outline" size="sm" onClick={() => setDropping(null)}>
              Cancel
            </Btn>
            <Btn
              tone="ink"
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                const f = dropping;
                setDropping(null);
                run(
                  `drop:${f.ref}`,
                  () => api.dropMedicoachOutbox(f.ref),
                  'Dropped — medicoach keeps its version',
                  "Couldn't drop the change",
                );
              }}
            >
              Drop the change
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

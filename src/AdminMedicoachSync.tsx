/* ─── Union office: Medicoach sync (ADR 0016) ───
 *
 * Shown only when the tenant has `features.medicoachSync`. One page for the admin to see what
 * the 15-minute sync is doing and to resolve what it could not:
 *   - the last pull (newest SYNCLOG# row), the cursor, and recent pull/push counts;
 *   - the outbox (PENDINGSYNC#): how many smart-club schedule changes are waiting to reach
 *     medicoach, and any that failed with their last error;
 *   - the conflict inbox (SYNCCONFLICT#): medicoach schedule changes held because the venue
 *     did not resolve or the change would double-book a ground. Apply re-runs the clash gate
 *     (and refuses while it still clashes), Discard keeps smart club's schedule, and "Edit
 *     fixture" opens the fixtures page;
 *   - "Sync now": flush the outbox, then pull, right away.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import * as api from './api';
import { ApiError } from './api';
import { Btn, Pill } from './atoms';
import { qk } from './query';

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

const REASON: Record<api.MedicoachSyncConflict['reason'], string> = {
  clash: 'Would double-book a ground',
  'venue-unresolved': 'Venue not in the ground list',
};

function currentText(c: api.MedicoachSyncConflict): string {
  const x = c.current;
  const parts: string[] = [];
  if (x.dateTbc) parts.push('date TBC');
  else if (x.date) parts.push(x.time ? `${x.date} ${x.time}` : x.date);
  if (x.venue) parts.push(x.venue);
  if (x.status === 'cancelled' || x.status === 'postponed') parts.push(x.status);
  return parts.join(' · ') || '—';
}

function logSummary(l: api.MedicoachSyncLog): string {
  if (l.kind === 'push' && l.push) {
    const p = l.push;
    return `Pushed ${p.sent}: ${p.applied} applied, ${p.unchanged} unchanged, ${p.stale} stale, ${p.unmapped} unmapped, ${p.errors} failed`;
  }
  const c = l.counts;
  const bits = [
    c.resultsStored ? `${c.resultsStored} result(s)` : '',
    c.resultsCleared ? `${c.resultsCleared} cleared` : '',
    c.scheduleApplied ? `${c.scheduleApplied} reschedule(s) applied` : '',
    c.scheduleConflicts ? `${c.scheduleConflicts} held for review` : '',
    c.scheduleStale ? `${c.scheduleStale} older change(s) ignored` : '',
    c.slotsFilled ? `${c.slotsFilled} knockout side(s) filled` : '',
    c.unmapped ? `${c.unmapped} unknown fixture(s)` : '',
  ].filter(Boolean);
  return bits.length ? `Pulled ${bits.join(', ')}` : `Pulled ${l.fixtures} change(s)`;
}

export function AdminMedicoachSyncView({
  onEditFixture,
  onToast,
}: {
  onEditFixture: (seriesId: string, fixtureId: string) => void;
  onToast: (message: string, tone?: string) => void;
}) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: qk.medicoachSync(), queryFn: api.getMedicoachSyncStatus });
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: qk.medicoachSync() });
    queryClient.invalidateQueries({ queryKey: qk.series() });
  };

  async function run(key: string, fn: () => Promise<unknown>, ok: string, fail: string) {
    setBusy(key);
    try {
      await fn();
      onToast(ok);
    } catch (err) {
      onToast(err instanceof ApiError ? `${fail}: ${err.message}` : fail, 'warn');
    } finally {
      setBusy(null);
      refresh();
    }
  }

  const data = status.data;
  const lastPull = data?.logs?.find((l) => l.kind !== 'push');
  const conflicts = data?.conflicts ?? [];
  const failures = data?.outbox?.failures ?? [];
  const held = data?.outbox?.held ?? [];

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Union office / Medicoach sync</div>
          <h1 className="ph-title">
            Medicoach <em>sync</em>
          </h1>
          <p className="ph-desc">
            Results and reschedules come in from medicoach every 15 minutes, and fixture changes
            made here go out to medicoach on the same run. Changes that would double-book a ground,
            or name a ground we don't know, wait here for you.
          </p>
        </div>
        <div className="ph-actions">
          <Btn
            tone="ink"
            size="sm"
            disabled={busy !== null || !data?.enabled}
            onClick={() =>
              run('sync', api.medicoachSyncNow, 'Sync finished', 'The sync did not finish')
            }
          >
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </Btn>
        </div>
      </div>

      {status.isLoading ? (
        <div className="cr-section-sub">Loading…</div>
      ) : status.isError ? (
        <div className="cr-section-sub">Could not load the sync status. Refresh to retry.</div>
      ) : !data?.enabled ? (
        <div className="cr-section-sub">The medicoach sync is not switched on for this union.</div>
      ) : (
        <>
          {data.dryRun && (
            <div className="rp-validation" role="note" style={{ marginBottom: 12 }}>
              Dry run: the sync connection isn't configured yet, so nothing is sent or fetched.
            </div>
          )}
          <div className="mcs-stats" data-testid="mcs-stats">
            <div className="mcs-stat">
              <div className="mcs-stat-label">Last pull with changes</div>
              <div className="mcs-stat-value">{fmtWhen(lastPull?.at)}</div>
              <div className="ump-sub">{lastPull ? logSummary(lastPull) : 'None yet'}</div>
            </div>
            <div className="mcs-stat">
              <div className="mcs-stat-label">Cursor</div>
              <div className="mcs-stat-value mcs-mono">{data.cursor?.cursor ?? 'none yet'}</div>
              <div className="ump-sub">moved {fmtWhen(data.cursor?.updatedAt)}</div>
            </div>
            <div className="mcs-stat">
              <div className="mcs-stat-label">Waiting to send</div>
              <div className="mcs-stat-value">{data.outbox?.count ?? 0}</div>
              <div className="ump-sub">
                {[
                  failures.length ? `${failures.length} failed, retrying` : '',
                  held.length ? `${held.length} held until released/revealed` : '',
                ]
                  .filter(Boolean)
                  .join(' · ') || 'all healthy'}
              </div>
            </div>
            <div className="mcs-stat">
              <div className="mcs-stat-label">Held for review</div>
              <div className="mcs-stat-value">{conflicts.length}</div>
              <div className="ump-sub">
                {data.pendingReports
                  ? `${data.pendingReports} captain's report(s) retrying`
                  : 'medicoach changes'}
              </div>
            </div>
          </div>

          <h2 className="mcs-heading">Changes held for review</h2>
          {!conflicts.length ? (
            <div className="cr-section-sub" style={{ padding: '12px 0' }}>
              Nothing to review.
            </div>
          ) : (
            <div className="tbl-w" style={{ marginTop: 10 }}>
              <table className="tbl" data-testid="mcs-conflicts">
                <thead>
                  <tr>
                    <th>Fixture</th>
                    <th>Now</th>
                    <th>Medicoach wants</th>
                    <th>Why it's held</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {conflicts.map((c) => (
                    <tr key={c.ref}>
                      <td>
                        <div style={{ fontWeight: 700 }}>{c.matchLine ?? c.fixtureId}</div>
                        <div className="ump-sub">{c.seriesName ?? c.seriesId}</div>
                      </td>
                      <td>{currentText(c)}</td>
                      <td>
                        {c.proposedText}
                        <div className="ump-sub">changed {fmtWhen(c.proposed.changedAt)}</div>
                      </td>
                      <td>
                        <Pill tone={c.reason === 'clash' ? 'coral' : 'gold'}>
                          {REASON[c.reason]}
                        </Pill>
                        {c.detail.map((d) => (
                          <div className="ump-sub" key={d}>
                            {d}
                          </div>
                        ))}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <Btn
                          tone="ink"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() =>
                            run(
                              `apply:${c.ref}`,
                              () => api.applyMedicoachConflict(c.ref),
                              'Medicoach change applied',
                              'Not applied',
                            )
                          }
                        >
                          Apply
                        </Btn>{' '}
                        <Btn
                          tone="outline"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() =>
                            run(
                              `discard:${c.ref}`,
                              () => api.discardMedicoachConflict(c.ref),
                              'Discarded — our schedule will be sent to medicoach',
                              'Could not discard',
                            )
                          }
                        >
                          Discard
                        </Btn>{' '}
                        <Btn
                          tone="ghost"
                          size="sm"
                          onClick={() => onEditFixture(c.seriesId, c.fixtureId)}
                        >
                          Edit fixture
                        </Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {failures.length > 0 && (
            <>
              <h2 className="mcs-heading">Changes that haven't reached medicoach</h2>
              <div className="tbl-w" style={{ marginTop: 10 }}>
                <table className="tbl" data-testid="mcs-outbox-failures">
                  <thead>
                    <tr>
                      <th>Fixture</th>
                      <th>Schedule</th>
                      <th>Tries</th>
                      <th>Last error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failures.map((f) => (
                      <tr key={f.ref}>
                        <td>
                          {f.seriesId} · {f.fixtureId}
                        </td>
                        <td>{f.proposed}</td>
                        <td>{f.attempts}</td>
                        <td>
                          {f.lastError ?? '—'}
                          <div className="ump-sub">{fmtWhen(f.lastAttemptAt)}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {held.length > 0 && (
            <>
              <h2 className="mcs-heading">Held until released/revealed</h2>
              <div className="cr-section-sub">
                These series are still drafts, or still hide the venue or kick-off time from clubs,
                so their changes stay here until you release or reveal them. Medicoach's match
                centre is public.
              </div>
              <div className="tbl-w" style={{ marginTop: 10 }}>
                <table className="tbl" data-testid="mcs-outbox-held">
                  <thead>
                    <tr>
                      <th>Fixture</th>
                      <th>Schedule</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {held.map((h) => (
                      <tr key={h.ref}>
                        <td>
                          {h.seriesId} · {h.fixtureId}
                        </td>
                        <td>
                          {h.proposed}
                          <div className="ump-sub">queued {fmtWhen(h.enqueuedAt)}</div>
                        </td>
                        <td>
                          <Pill tone="gold">held until released/revealed</Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h2 className="mcs-heading">Recent activity</h2>
          {!data.logs?.length ? (
            <div className="cr-section-sub" style={{ padding: '12px 0' }}>
              No sync activity yet. Quiet runs leave no record.
            </div>
          ) : (
            <div className="tbl-w" style={{ marginTop: 10 }}>
              <table className="tbl" data-testid="mcs-logs">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Run</th>
                    <th>What happened</th>
                  </tr>
                </thead>
                <tbody>
                  {data.logs.map((l) => (
                    <tr key={l.id}>
                      <td>{fmtWhen(l.at)}</td>
                      <td>
                        {l.trigger === 'manual' ? 'Sync now' : 'Scheduled'}
                        {l.outcome === 'error' && (
                          <>
                            {' '}
                            <Pill tone="coral">Error</Pill>
                          </>
                        )}
                      </td>
                      <td>
                        {logSummary(l)}
                        {l.error && <div className="ump-sub">{l.error}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

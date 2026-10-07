/**
 * Operator console: chair scorecard confirmations.
 *
 * Every Monday the ScorecardConfirmations cron gives each club that played the previous Mon–Sun
 * week one digest link (`/sc/<token>`); the chair confirms each match's scorecard or requests
 * a correction. This page lists one week across every tenant: per fixture, BOTH clubs' answers
 * side by side (home first — a home "confirmed" next to an away "correction" is expected, not a
 * contradiction), the correction text on demand, and per digest its answer counts and how the
 * notice went out. "Run now" re-runs the cron for the shown week: idempotent (a chair who
 * already got the link is never messaged again) and it tops digests up with late results.
 *
 * Also here: ScorecardConfirmationsCard, the per-tenant switch on the client settings page
 * (`TenantConfig.scorecardConfirmations.enabled`, default off). Kept in its own file, like the
 * other platform-*.tsx cards, so platform.tsx does not grow.
 */
import { useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Btn, Card, EmptyState, Icon, Modal, ModalCancelBtn, Pill, ScrollX } from './atoms';
import { ApiError, listPlatformScorecardConfirmations, runScorecardConfirmations } from './api';
import { chipFor } from './AdminCaptainsReports';
import { formatStamp, formatWeekdayDay } from './dates';
import { qk } from './query';
import {
  STATUS_LABEL,
  STATUS_TONE,
  lastCompletedWeekKey,
  shiftWeek,
} from './scorecardConfirmHelpers';
import type {
  PlatformScorecardFixture,
  PlatformScorecardRecord,
  PlatformScorecardSide,
  PlatformScorecardTenant,
  ScorecardConfirmEntryStatus,
  ScorecardConfirmationsRunSummary,
  ScorecardDelivery,
  TenantConfig,
} from './types';

type Toast = (m: string, t?: string) => void;

const MUTED: CSSProperties = { color: 'var(--muted)', fontSize: 13 };
const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '8px 0 0' };

/* ─── Notice chips (the captain's-report pattern) ─── */

/** The latest delivery per channel — what the chair's notice finally did on each. */
export function latestDeliveries(deliveries: ScorecardDelivery[]): ScorecardDelivery[] {
  const out = new Map<string, ScorecardDelivery>();
  for (const d of deliveries) {
    const prev = out.get(d.channel);
    if (!prev || d.at >= prev.at) out.set(d.channel, d);
  }
  return [...out.values()].sort((a, b) => a.channel.localeCompare(b.channel));
}

function NoticeChips({ deliveries }: { deliveries: ScorecardDelivery[] }) {
  const latest = latestDeliveries(deliveries);
  if (!latest.length) return <span style={MUTED}>No notice yet</span>;
  const chips = latest.every((d) => d.status === 'skipped' && d.reason === 'no-contact')
    ? [{ label: 'Not sent — no contact on file', tone: 'coral' }]
    : latest.map(chipFor);
  return (
    <div className="cr-delivery">
      {chips.map((c) => (
        <Pill key={c.label} tone={c.tone}>
          {c.label}
        </Pill>
      ))}
    </div>
  );
}

/* ─── One fixture: both clubs' answers ─── */

const STALE_TITLE = 'Answered against an older scorecard — a newer one arrived afterwards.';

function SideAnswer({
  side,
  open,
  onToggle,
}: {
  side: PlatformScorecardSide;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <span className="scc-side" data-testid={`scc-side-${side.clubId}`}>
      <span>{side.clubName}</span>
      <Pill tone={STATUS_TONE[side.status]}>{STATUS_LABEL[side.status]}</Pill>
      {side.staleConfirmation && (
        <span role="img" aria-label={STALE_TITLE} title={STALE_TITLE}>
          ⚠
        </span>
      )}
      {side.feedback && (
        <button
          type="button"
          className="scc-link"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} ${side.clubName} feedback`}
          onClick={onToggle}
        >
          {open ? 'Hide feedback' : 'Show feedback'}
        </button>
      )}
    </span>
  );
}

function FixtureRow({ tenant, fixture }: { tenant: string; fixture: PlatformScorecardFixture }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const shown = fixture.sides.filter((s) => s.feedback && open[s.clubId]);
  return (
    <tr data-testid={`scc-fixture-${tenant}-${fixture.seriesId}-${fixture.fixtureId}`}>
      <td style={{ whiteSpace: 'nowrap' }}>{formatWeekdayDay(fixture.fixtureDate)}</td>
      <td>
        <strong>
          {fixture.homeTeamName} vs {fixture.awayTeamName}
        </strong>
        {fixture.competition && <div style={{ ...MUTED, fontSize: 12 }}>{fixture.competition}</div>}
      </td>
      <td>
        <div className="scc-sides">
          {fixture.sides.map((s) => (
            <SideAnswer
              key={s.clubId}
              side={s}
              open={!!open[s.clubId]}
              onToggle={() => setOpen((o) => ({ ...o, [s.clubId]: !o[s.clubId] }))}
            />
          ))}
        </div>
        {shown.map((s) => (
          <blockquote key={s.clubId} className="scc-feedback" aria-label={`${s.clubName} feedback`}>
            <strong>{s.clubName}:</strong> {s.feedback}
            {s.submittedAt && (
              <div style={{ ...MUTED, fontSize: 11.5, marginTop: 4 }}>
                {formatStamp(s.submittedAt)}
              </div>
            )}
          </blockquote>
        ))}
      </td>
    </tr>
  );
}

const COUNT_ORDER: ScorecardConfirmEntryStatus[] = ['confirmed', 'correction', 'pending', 'void'];

/** "2 confirmed · 1 correction requested" — zero counts left out. */
export function countsLine(counts: PlatformScorecardRecord['counts']): string {
  const parts = COUNT_ORDER.filter((k) => counts[k] > 0).map(
    (k) => `${counts[k]} ${STATUS_LABEL[k].toLowerCase()}`,
  );
  return parts.length ? parts.join(' · ') : 'No matches';
}

function TenantSection({ t }: { t: PlatformScorecardTenant }) {
  return (
    <Card
      title={
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          {t.tenantName}
          <Pill tone={t.enabled ? 'teal' : 'muted'}>{t.enabled ? 'Enabled' : 'Off'}</Pill>
        </span>
      }
      sub={`${t.fixtures.length} ${t.fixtures.length === 1 ? 'match' : 'matches'} · ${t.records.length} ${t.records.length === 1 ? 'digest' : 'digests'}`}
    >
      <section aria-label={`${t.tenantName} scorecard confirmations`}>
        {t.fixtures.length === 0 ? (
          <p style={MUTED}>No digests for this week.</p>
        ) : (
          <div className="tbl-w" style={{ marginBottom: 14 }}>
            <ScrollX label={`${t.tenantName} matches`}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Match</th>
                    <th>Answers (home first)</th>
                  </tr>
                </thead>
                <tbody>
                  {t.fixtures.map((f) => (
                    <FixtureRow
                      key={`${f.seriesId}#${f.fixtureId}`}
                      tenant={t.tenant}
                      fixture={f}
                    />
                  ))}
                </tbody>
              </table>
            </ScrollX>
          </div>
        )}
        {t.records.length > 0 && (
          <div className="tbl-w">
            <ScrollX label={`${t.tenantName} digests`}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Club</th>
                    <th>Ref</th>
                    <th>Answers</th>
                    <th>Notified</th>
                    <th>Notice</th>
                  </tr>
                </thead>
                <tbody>
                  {t.records.map((r) => (
                    <tr key={r.clubId}>
                      <td>{r.clubName}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.ref}</td>
                      <td style={{ fontSize: 12.5 }}>{countsLine(r.counts)}</td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>
                        {r.notifiedAt ? formatStamp(r.notifiedAt) : '—'}
                      </td>
                      <td className="scc-notice">
                        <NoticeChips deliveries={r.deliveries} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollX>
          </div>
        )}
      </section>
    </Card>
  );
}

/* ─── Run now ─── */

export function runSummaryLine(s: ScorecardConfirmationsRunSummary): string {
  const n = (v: number, one: string, many = `${one}s`) => `${v} ${v === 1 ? one : many}`;
  return (
    `${n(s.tenants, 'client')}, ${n(s.clubsProcessed, 'club')} with matches: ` +
    `${s.created} created, ${s.toppedUp} topped up, ${s.sent} sent, ${s.skipped} skipped, ` +
    `${n(s.errors, 'error')}${s.dryRun ? ' (dry run — nothing was really sent)' : ''}.`
  );
}

/** The last run's outcome — shown under the page head, so the controls never move. */
function RunSummary({
  summary,
  weekKey,
}: {
  summary: ScorecardConfirmationsRunSummary;
  weekKey: string;
}) {
  return (
    <div role="status" style={{ ...MUTED, fontSize: 12.5, margin: '-12px 0 16px' }}>
      Ran {summary.weekKey === weekKey ? 'this week' : `week ending ${summary.weekKey}`}:{' '}
      {runSummaryLine(summary)}
    </div>
  );
}

function RunNow({
  weekKey,
  weekLabel,
  toast,
  onRan,
}: {
  weekKey: string;
  weekLabel: string;
  toast: Toast;
  onRan: (summary: ScorecardConfirmationsRunSummary) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const qc = useQueryClient();

  async function run() {
    setBusy(true);
    setErr('');
    try {
      const res = await runScorecardConfirmations(weekKey);
      onRan(res);
      setAsking(false);
      toast('Scorecard confirmations run complete');
      await qc.invalidateQueries({ queryKey: ['platform-scorecard-confirmations'] });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'The run failed — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Btn tone="teal" size="sm" icon={Icon.Bell} onClick={() => setAsking(true)}>
        Run now
      </Btn>
      {asking && (
        <Modal
          eyebrow="Scorecard confirmations"
          title={`Run the digest for ${weekLabel}?`}
          maxWidth={520}
          onClose={() => !busy && setAsking(false)}
          footer={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <ModalCancelBtn tone="outline" size="sm" disabled={busy}>
                Cancel
              </ModalCancelBtn>
              <Btn tone="teal" size="sm" disabled={busy} onClick={() => void run()}>
                {busy ? 'Running…' : 'Run now'}
              </Btn>
            </div>
          }
        >
          <p style={{ fontSize: 13, margin: 0 }}>
            For every client with scorecard confirmations switched on: clubs that played this week
            and have no digest get one, and their chair gets the link. Existing digests gain any
            late results. A chair who already has this week&apos;s link is never messaged again.
          </p>
          {err && <div style={ERR}>{err}</div>}
        </Modal>
      )}
    </>
  );
}

/* ─── The page ─── */

export function ScorecardConfirmationsPage({ toast }: { toast: Toast }) {
  // '' = the server's default (the latest completed week); arrows set an explicit Sunday.
  const [week, setWeek] = useState('');
  const [summary, setSummary] = useState<ScorecardConfirmationsRunSummary | null>(null);
  const q = useQuery({
    queryKey: qk.platformScorecardConfirmations(week),
    queryFn: () => listPlatformScorecardConfirmations(week || undefined),
  });
  const data = q.data;
  const shown = data?.weekKey ?? week;
  const latest = lastCompletedWeekKey();
  const canNext = !!shown && shiftWeek(shown, 1) <= latest;

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Platform / Scorecard confirmations</div>
          <h1 className="ph-title">
            Scorecard <em>confirmations</em>
          </h1>
          <p className="ph-desc">
            Club chairs confirm each weekend match&apos;s scorecard or request a correction.
            Corrections are emailed to the operators; both clubs&apos; answers show side by side.
          </p>
        </div>
        <div className="ph-actions" style={{ flexWrap: 'wrap' }}>
          <div className="scc-week" role="group" aria-label="Week">
            <Btn
              tone="outline"
              size="sm"
              aria-label="Previous week"
              disabled={!shown}
              onClick={() => setWeek(shiftWeek(shown, -1))}
            >
              ←
            </Btn>
            <strong style={{ fontSize: 13 }} aria-live="polite">
              {data?.weekLabel ?? (week ? `Week ending ${week}` : 'Latest week')}
            </strong>
            <Btn
              tone="outline"
              size="sm"
              aria-label="Next week"
              disabled={!canNext}
              onClick={() => setWeek(shiftWeek(shown, 1))}
            >
              →
            </Btn>
          </div>
          {data && (
            <RunNow
              weekKey={data.weekKey}
              weekLabel={data.weekLabel}
              toast={toast}
              onRan={setSummary}
            />
          )}
        </div>
      </div>
      {summary && <RunSummary summary={summary} weekKey={shown} />}

      {q.isLoading ? (
        <p style={MUTED}>Loading confirmations…</p>
      ) : q.isError || !data ? (
        <p style={MUTED}>
          {q.error instanceof ApiError
            ? q.error.message
            : 'Could not load scorecard confirmations — refresh to retry.'}
        </p>
      ) : data.tenants.length === 0 ? (
        <EmptyState
          icon={Icon.Check}
          title="Nothing this week"
          sub="No client has scorecard confirmations switched on, and no digests went out this week."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {data.tenants.map((t) => (
            <TenantSection key={t.tenant} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── The per-tenant switch (client settings page) ─── */

export function ScorecardConfirmationsCard({
  config,
  save,
  toast,
}: {
  config: TenantConfig;
  save: (p: Partial<TenantConfig>) => Promise<TenantConfig>;
  toast: Toast;
}) {
  const initial = config.scorecardConfirmations?.enabled ?? false;
  const [enabled, setEnabled] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function saveIt() {
    setErr('');
    setBusy(true);
    try {
      await save({ scorecardConfirmations: { enabled } });
      setSaved(enabled);
      toast(`Scorecard confirmations ${enabled ? 'switched on' : 'switched off'}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Scorecard confirmations"
      sub="A Monday digest (07:00) to each club chair whose club played the week before: confirm each match's scorecard or request a correction."
    >
      <label
        style={{
          fontSize: 12.5,
          display: 'inline-flex',
          gap: 6,
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Send the Monday scorecard digest
      </label>
      <p style={HINT}>
        Needs the medicoach sync switched on with a go-live date — only synced results are included.
        Corrections are emailed to the platform operators, never the union admins.
      </p>
      {err && <div style={{ ...ERR, marginBottom: 8 }}>{err}</div>}
      <div style={{ marginTop: 12 }}>
        <Btn tone="teal" size="sm" onClick={saveIt} disabled={enabled === saved || busy}>
          {busy ? 'Saving…' : 'Save'}
        </Btn>
      </div>
    </Card>
  );
}

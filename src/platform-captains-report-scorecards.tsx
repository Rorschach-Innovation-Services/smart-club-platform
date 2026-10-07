/**
 * Operator console: scorecard answers in captains reports.
 *
 * Each side's captain's report asks its club to confirm the match scorecard or request a
 * correction (required whenever an available card is attached). This page lists the last
 * `days` of matches across every tenant: one row per fixture, the home side first and the away
 * side next to it — a home "Confirmed" beside an away "Correction" is expected, not a
 * contradiction. Correction text opens on demand; a stale answer (the card changed after it
 * was given, or the result was withdrawn) carries a ⚠ and is not re-asked — the chip is the
 * workflow.
 */
import { useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, EmptyState, Icon, Pill, ScrollX } from './atoms';
import { ApiError, listPlatformCaptainsReportScorecards } from './api';
import { formatStamp, formatWeekdayDay } from './dates';
import { qk } from './query';
import type {
  ScorecardConsoleCell,
  ScorecardConsoleFilter,
  ScorecardConsolePayload,
  ScorecardConsoleRow,
  ScorecardConsoleStatus,
} from './types';

const MUTED: CSSProperties = { color: 'var(--muted)', fontSize: 13 };

export const DAY_OPTIONS = [7, 14, 30, 60] as const;

export const STATUS_LABEL: Record<ScorecardConsoleStatus, string> = {
  'n/a': 'No scorecard',
  pending: 'Awaiting answer',
  'not-asked': 'Not asked',
  confirmed: 'Confirmed',
  correction: 'Correction requested',
  stale: 'Stale',
};

/** Pill tone per status (index.html .pill-*): done = teal, needs attention = coral. */
export const STATUS_TONE: Record<ScorecardConsoleStatus, string> = {
  'n/a': 'muted',
  pending: 'navy',
  'not-asked': 'muted',
  confirmed: 'teal',
  correction: 'coral',
  stale: 'gold',
};

const FILTERS: Array<{ key: ScorecardConsoleFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Awaiting answer' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'correction', label: 'Correction requested' },
  { key: 'stale', label: 'Stale' },
  { key: 'not-asked', label: 'Not asked' },
];

const REPORT_STATUS: Record<ScorecardConsoleCell['reportStatus'], string> = {
  pending: 'report open',
  submitted: 'report submitted',
  void: 'report void',
};

const staleTitle = (c: ScorecardConsoleCell) =>
  `Answered against an older scorecard — it changed afterwards, or the result was withdrawn` +
  (c.answeredAction
    ? ` (the answer was: ${c.answeredAction === 'correction' ? 'correction requested' : 'confirmed'}).`
    : '.');

function SideCell({
  side,
  cell,
  open,
  onToggle,
}: {
  side: 'Home' | 'Away';
  cell?: ScorecardConsoleCell;
  open: boolean;
  onToggle: () => void;
}) {
  if (!cell)
    return (
      <span className="scc-side" style={MUTED}>
        {side}: no report
      </span>
    );
  return (
    <span className="scc-side" data-testid={`scc-side-${cell.clubId}`}>
      <span>
        <span style={{ ...MUTED, fontSize: 11.5 }}>{side}</span> {cell.clubName}
      </span>
      <Pill tone={STATUS_TONE[cell.scorecardStatus]}>{STATUS_LABEL[cell.scorecardStatus]}</Pill>
      {cell.scorecardStatus === 'stale' && (
        <span role="img" aria-label={staleTitle(cell)} title={staleTitle(cell)}>
          ⚠
        </span>
      )}
      <span style={{ ...MUTED, fontSize: 11.5 }}>
        {cell.reportRef ? `${cell.reportRef} · ` : ''}
        {REPORT_STATUS[cell.reportStatus]}
      </span>
      {cell.feedback && (
        <button
          type="button"
          className="scc-link"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} ${cell.clubName} feedback`}
          onClick={onToggle}
        >
          {open ? 'Hide feedback' : 'Show feedback'}
        </button>
      )}
    </span>
  );
}

function FixtureRow({ tenant, row }: { tenant: string; row: ScorecardConsoleRow }) {
  const [open, setOpen] = useState<{ home?: boolean; away?: boolean }>({});
  const sides = (['home', 'away'] as const).filter((k) => row[k]?.feedback && open[k]);
  return (
    <tr data-testid={`scc-fixture-${tenant}-${row.seriesId}-${row.fixtureId}`}>
      <td style={{ whiteSpace: 'nowrap' }}>{formatWeekdayDay(row.matchDate)}</td>
      <td>
        <strong>
          {row.homeTeamName} vs {row.awayTeamName}
        </strong>
        {row.competition && <div style={{ ...MUTED, fontSize: 12 }}>{row.competition}</div>}
      </td>
      <td>
        <div className="scc-sides">
          {(['home', 'away'] as const).map((k) => (
            <SideCell
              key={k}
              side={k === 'home' ? 'Home' : 'Away'}
              cell={row[k]}
              open={!!open[k]}
              onToggle={() => setOpen((o) => ({ ...o, [k]: !o[k] }))}
            />
          ))}
        </div>
        {sides.map((k) => {
          const c = row[k]!;
          return (
            <blockquote key={k} className="scc-feedback" aria-label={`${c.clubName} feedback`}>
              <strong>{c.clubName}:</strong> {c.feedback}
              {c.submittedAt && (
                <div style={{ ...MUTED, fontSize: 11.5, marginTop: 4 }}>
                  {formatStamp(c.submittedAt)}
                </div>
              )}
            </blockquote>
          );
        })}
      </td>
    </tr>
  );
}

function TenantSection({ t }: { t: ScorecardConsolePayload['tenants'][number] }) {
  return (
    <Card
      title={t.tenantName}
      sub={`${t.rows.length} ${t.rows.length === 1 ? 'match' : 'matches'}`}
    >
      <section aria-label={`${t.tenantName} scorecard answers`}>
        <div className="tbl-w">
          <ScrollX label={`${t.tenantName} matches`}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Match</th>
                  <th>Scorecard answers (home first)</th>
                </tr>
              </thead>
              <tbody>
                {t.rows.map((r) => (
                  <FixtureRow key={`${r.seriesId}#${r.fixtureId}`} tenant={t.tenant} row={r} />
                ))}
              </tbody>
            </table>
          </ScrollX>
        </div>
      </section>
    </Card>
  );
}

export function CaptainsReportScorecardsPage() {
  const [days, setDays] = useState<number>(14);
  const [status, setStatus] = useState<ScorecardConsoleFilter>('all');
  const q = useQuery({
    queryKey: qk.platformCaptainsReportScorecards(days, status),
    queryFn: () => listPlatformCaptainsReportScorecards(days, status),
  });
  const data = q.data;

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Platform / Scorecard answers</div>
          <h1 className="ph-title">
            Scorecard <em>answers</em>
          </h1>
          <p className="ph-desc">
            Each club confirms the match scorecard or requests a correction in its captain&apos;s
            report. Corrections are emailed to the operators; both sides show side by side.
          </p>
        </div>
        <div className="ph-actions">
          <label style={{ fontSize: 12.5, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            Matches in the last
            <select
              className="field-input"
              aria-label="Days"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {DAY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="cr-filters" style={{ marginBottom: 16 }}>
        <div className="cr-chips" role="group" aria-label="Scorecard status">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`cr-chip ${status === f.key ? 'on' : ''}`}
              aria-pressed={status === f.key}
              onClick={() => setStatus(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {q.isLoading ? (
        <p style={MUTED}>Loading scorecard answers…</p>
      ) : q.isError || !data ? (
        <p style={MUTED}>
          {q.error instanceof ApiError
            ? q.error.message
            : 'Could not load the scorecard answers — refresh to retry.'}
        </p>
      ) : data.tenants.length === 0 ? (
        <EmptyState
          icon={Icon.Check}
          title="No matches"
          sub={
            status === 'all'
              ? `No captains reports for matches since ${formatWeekdayDay(data.since)}.`
              : `No match has a side with this status since ${formatWeekdayDay(data.since)}.`
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {data.truncated && (
            <p role="status" style={{ ...MUTED, fontSize: 12.5, margin: 0 }}>
              Showing the newest {data.tenants.reduce((n, t) => n + t.rows.length, 0)} of{' '}
              {data.total} matches — narrow the window or filter by status to see the rest.
            </p>
          )}
          {data.tenants.map((t) => (
            <TenantSection key={t.tenant} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

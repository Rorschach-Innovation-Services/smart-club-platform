/* ─── Union office: Captain's reports ───
 *
 * Every report in the tenant: status (pending / submitted / void), who it went to, the
 * appointed umpires, and a low-ratings filter (any criterion ≤ 2). There is no due date. A row opens the read-only, printable report.
 */
import { useMemo, useState } from 'react';
import { Btn, Icon, Pill } from './atoms';
import {
  CaptainsReportReadOnly,
  CaptainsReportStatusPill,
  fmtDate,
  matchLine,
} from './CaptainsReport';
import { avgRating, hasLowRating } from '../packages/engine/src/captainsReport';
import type { CaptainsReport } from './types';

type StatusFilter = 'all' | 'pending' | 'submitted' | 'void';

const STATUS_CHIPS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'void', label: 'Void' },
];

const matchesStatus = (r: CaptainsReport, f: StatusFilter) => (f === 'all' ? true : r.status === f);

const RECIPIENT_LABEL: Record<CaptainsReport['recipient']['kind'], string> = {
  captain: 'Captain',
  chair: 'Chair',
  portal: 'Club portal',
};

export function AdminCaptainsReportsView({
  reports,
  loading,
}: {
  reports: CaptainsReport[];
  loading?: boolean;
}) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [lowOnly, setLowOnly] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const inRange = useMemo(
    () => reports.filter((r) => (!from || r.matchDate >= from) && (!to || r.matchDate <= to)),
    [reports, from, to],
  );
  const list = inRange
    .filter((r) => matchesStatus(r, status))
    .filter((r) => !lowOnly || r.umpires.some(hasLowRating));
  const open = openId ? reports.find((r) => r.id === openId) : null;

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Union office / Captain's reports</div>
          <h1 className="ph-title">
            Captain's <em>reports</em>
          </h1>
          <p className="ph-desc">
            Umpire ratings from each side's captain. Reports open when medicoach reports a result;
            the emailed link works for 7 days after the match, and clubs can file from their portal
            at any time.
          </p>
        </div>
      </div>

      {open ? (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <Btn tone="ghost" size="sm" onClick={() => setOpenId(null)}>
              ← All reports
            </Btn>
            <Btn tone="outline" size="sm" icon={Icon.Download} onClick={() => window.print()}>
              Print
            </Btn>
          </div>
          {open.flagged && (
            <div className="rp-validation" role="note" style={{ marginBottom: 12 }}>
              The result behind this report was cleared in medicoach after it was submitted.
            </div>
          )}
          <CaptainsReportReadOnly report={open} />
        </div>
      ) : (
        <>
          <div className="cr-filters">
            <div className="cr-chips" role="group" aria-label="Status">
              {STATUS_CHIPS.map((c) => {
                const n = inRange.filter((r) => matchesStatus(r, c.key)).length;
                return (
                  <button
                    key={c.key}
                    type="button"
                    className={`cr-chip ${status === c.key ? 'on' : ''}`}
                    aria-pressed={status === c.key}
                    onClick={() => setStatus(c.key)}
                  >
                    {c.label} <span className="cr-chip-n">{n}</span>
                  </button>
                );
              })}
              <button
                type="button"
                className={`cr-chip ${lowOnly ? 'on' : ''}`}
                aria-pressed={lowOnly}
                onClick={() => setLowOnly((v) => !v)}
              >
                Low ratings (≤ 2)
              </button>
            </div>
            <div className="cr-range">
              <label>
                From{' '}
                <input
                  type="date"
                  className="field-input"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                To{' '}
                <input
                  type="date"
                  className="field-input"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </div>
          </div>

          {loading ? (
            <div className="cr-section-sub">Loading…</div>
          ) : !list.length ? (
            <div className="cr-section-sub" style={{ padding: '24px 0' }}>
              {reports.length ? 'No reports match these filters.' : 'No captain’s reports yet.'}
            </div>
          ) : (
            <div className="tbl-w" style={{ marginTop: 14 }}>
              <table className="tbl cr-admin-table">
                <thead>
                  <tr>
                    <th>Match</th>
                    <th>Report from</th>
                    <th>Sent to</th>
                    <th>Appointed umpires</th>
                    <th>Status</th>
                    <th>Ratings</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const avgs = r.umpires
                      .map((u) => avgRating(u))
                      .filter((x): x is number => x != null);
                    const low = r.umpires.some(hasLowRating);
                    return (
                      <tr key={r.id}>
                        <td>
                          <div style={{ fontWeight: 700 }}>{matchLine(r)}</div>
                          <div className="ump-sub">
                            {fmtDate(r.matchDate)} · {r.competition}
                          </div>
                        </td>
                        <td>{r.clubName}</td>
                        <td>{RECIPIENT_LABEL[r.recipient.kind]}</td>
                        <td>
                          {r.umpiresSnapshot.length ? (
                            r.umpiresSnapshot.map((u) => u.name).join(', ')
                          ) : (
                            <span className="ump-none">None appointed</span>
                          )}
                        </td>
                        <td>
                          <CaptainsReportStatusPill report={r} />
                          {r.ref && <div className="ump-sub">{r.ref}</div>}
                        </td>
                        <td>
                          {avgs.length ? avgs.map((a) => a.toFixed(1)).join(' · ') : '—'}{' '}
                          {low && <Pill tone="coral">Low</Pill>}
                        </td>
                        <td>
                          {r.status === 'submitted' && (
                            <Btn tone="outline" size="sm" onClick={() => setOpenId(r.id)}>
                              View
                            </Btn>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ─── Captain's reports board — the home dashboard's third view (admin: all clubs; club: own) ─── */

import { useMemo, useState } from 'react';
import { Icon, KPI, Pill, EmptyState, useEscapeClose } from './atoms';
import { RATING_CRITERIA, CONCERN_AREAS } from './CaptainsReport';
import type { CaptainReport, CaptainReportUmpire } from './types';

const fmtDate = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

const concernLabel = (k: string) => CONCERN_AREAS.find((c) => c.key === k)?.label ?? k;

/** Mean of an umpire's five criteria (each 1–5). */
export const umpireAvg = (u: CaptainReportUmpire) => {
  const vals = RATING_CRITERIA.map((c) => u.ratings[c.key]).filter((v) => Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
};

/** Per-umpire roll-up across reports: count, overall and per-criterion averages, concerns. */
export function umpireSummary(reports: CaptainReport[]) {
  const by = new Map<
    string,
    {
      name: string;
      n: number;
      sum: number;
      crit: Record<string, number>;
      concerns: Record<string, number>;
    }
  >();
  reports.forEach((r) =>
    r.umpires.forEach((u) => {
      const key = u.name.trim();
      const row = by.get(key.toLowerCase()) ?? { name: key, n: 0, sum: 0, crit: {}, concerns: {} };
      row.n++;
      row.sum += umpireAvg(u);
      RATING_CRITERIA.forEach(
        (c) => (row.crit[c.key] = (row.crit[c.key] ?? 0) + (u.ratings[c.key] ?? 0)),
      );
      u.concerns.forEach((k) => (row.concerns[k] = (row.concerns[k] ?? 0) + 1));
      by.set(key.toLowerCase(), row);
    }),
  );
  return [...by.values()]
    .map((r) => ({
      name: r.name,
      reports: r.n,
      avg: r.sum / r.n,
      crit: Object.fromEntries(Object.entries(r.crit).map(([k, v]) => [k, v / r.n])),
      concerns: Object.entries(r.concerns).sort((a, b) => b[1] - a[1]),
    }))
    .sort((a, b) => b.reports - a.reports || a.avg - b.avg || a.name.localeCompare(b.name));
}

const tone = (avg: number) => (avg <= 2.5 ? 'low' : avg < 3.5 ? 'mid' : 'high');

function Score({ v }: { v: number }) {
  return <span className={`crb-score ${tone(v)}`}>{v.toFixed(1)}</span>;
}

function ReportDetail({
  report,
  showClub,
  onClose,
}: {
  report: CaptainReport;
  showClub: boolean;
  onClose: () => void;
}) {
  useEscapeClose(onClose);
  return (
    <div className="sc-panel-scrim" onClick={onClose}>
      <aside
        className="sc-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Captain's report ${report.ref}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sc-panel-head">
          <div>
            <div className="sc-panel-eyebrow">
              Captain's report · {report.ref}
              {showClub ? ` · ${report.clubName}` : ''}
            </div>
            <div className="sc-panel-name">
              {report.side === 'Home' ? 'v' : '@'} {report.opponent}
            </div>
            <div className="crb-sub">
              {fmtDate(report.date)}
              {report.competition ? ` · ${report.competition}` : ''}
              {report.venue ? ` · ${report.venue}` : ''}
            </div>
          </div>
          <button type="button" className="sc-panel-close" onClick={onClose} aria-label="Close">
            <Icon.X />
          </button>
        </div>

        {report.umpires.map((u, i) => (
          <div key={i} className="crb-ump">
            <div className="crb-ump-head">
              <div>
                <span className="crb-ump-l">Umpire {i + 1}</span>
                <strong>{u.name}</strong>
              </div>
              <Score v={umpireAvg(u)} />
            </div>
            <div className="crb-crit">
              {RATING_CRITERIA.map((c) => (
                <div key={c.key} className="crb-crit-row">
                  <span>{c.label}</span>
                  <span className="crb-pips" aria-label={`${u.ratings[c.key]} of 5`}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <i
                        key={n}
                        className={
                          n <= (u.ratings[c.key] ?? 0) ? `on ${tone(u.ratings[c.key])}` : ''
                        }
                      />
                    ))}
                  </span>
                  <strong>{u.ratings[c.key]}</strong>
                </div>
              ))}
            </div>
            {u.concerns.length > 0 && (
              <div className="crb-concerns">
                {u.concerns.map((k) => (
                  <Pill key={k} tone="coral">
                    {k === 'other' && u.otherConcern ? u.otherConcern : concernLabel(k)}
                  </Pill>
                ))}
              </div>
            )}
            {u.comments && <p className="crb-comment">“{u.comments}”</p>}
          </div>
        ))}

        {report.general && (
          <>
            <div className="sc-panel-sec">General comments</div>
            <p className="crb-comment">“{report.general}”</p>
          </>
        )}

        <div className="sc-panel-sec">Filed</div>
        <div className="crb-sub">
          Captain {report.captain} · submitted{' '}
          {new Date(report.submittedAt).toLocaleString('en-GB', {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}{' '}
          by {report.submittedBy}
        </div>
      </aside>
    </div>
  );
}

export function CaptainReportsBoard({
  reports,
  scope,
  orgName,
  clubName,
  loading,
}: {
  reports: CaptainReport[];
  scope: 'admin' | 'club';
  orgName?: string;
  clubName?: string;
  loading?: boolean;
}) {
  const [club, setClub] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<CaptainReport | null>(null);
  const clubs = useMemo(
    () =>
      [...new Map(reports.map((r) => [r.clubId, r.clubName])).entries()].sort((a, b) =>
        a[1].localeCompare(b[1]),
      ),
    [reports],
  );
  const needle = q.trim().toLowerCase();
  const shown = reports
    .filter((r) => !club || r.clubId === club)
    .filter(
      (r) =>
        !needle ||
        [r.opponent, r.captain, r.clubName, ...r.umpires.map((u) => u.name)]
          .join(' ')
          .toLowerCase()
          .includes(needle),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || b.submittedAt.localeCompare(a.submittedAt));
  const ratedUmpires = shown.flatMap((r) => r.umpires);
  const avg = ratedUmpires.length
    ? ratedUmpires.reduce((n, u) => n + umpireAvg(u), 0) / ratedUmpires.length
    : 0;
  const low = ratedUmpires.filter((u) => umpireAvg(u) <= 2.5).length;
  const concerns = ratedUmpires.reduce((n, u) => n + u.concerns.length, 0);
  const umpires = umpireSummary(shown);
  const isAdmin = scope === 'admin';

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">
            {isAdmin ? `${orgName ?? 'Union'} · Season` : `Club Portal · ${clubName} / Season`}
          </div>
          <h1 className="ph-title">
            Captain's <em>Reports</em>
          </h1>
          <p className="ph-desc">
            {isAdmin
              ? "Every captain's report filed across the union — how each umpire is being rated, and where captains flag concerns."
              : "Your club's filed captain's reports and how you've rated the umpires this season."}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="ss-empty">Loading reports…</div>
      ) : !reports.length ? (
        <EmptyState
          icon={Icon.Whistle}
          title="No captain's reports yet"
          sub={
            isAdmin
              ? 'Reports appear here as soon as club captains file them after their matches.'
              : "File a captain's report after each match — it will show here and with the union office."
          }
        />
      ) : (
        <>
          <div className="kpi-strip ss-kpis">
            <KPI
              label="Reports filed"
              num={shown.length}
              sub={isAdmin ? `${clubs.length} clubs` : 'This season'}
              tone="teal"
            />
            <KPI label="Average rating" num={avg ? avg.toFixed(2) : '–'} sub="Umpires, out of 5" />
            <KPI
              label="Low ratings"
              num={low}
              sub="Umpire averages of 2.5 or less"
              tone={low ? 'warn' : 'good'}
            />
            <KPI label="Concerns flagged" num={concerns} sub="Areas ticked by captains" />
          </div>

          <div className="crb-filters">
            {isAdmin && (
              <select
                className="field-select sc-select"
                value={club}
                onChange={(e) => setClub(e.target.value)}
                aria-label="Club"
              >
                <option value="">All clubs</option>
                {clubs.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <input
              className="field-input sc-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search umpire, opponent or captain"
              aria-label="Search reports"
            />
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Reports</div>
                <div className="card-sub">
                  {shown.length} of {reports.length} · tap a report to read it
                </div>
              </div>
            </div>
            <div className="sc-scroll">
              <table className="sc-tbl">
                <thead>
                  <tr>
                    <th>Date</th>
                    {isAdmin && <th>Club</th>}
                    <th>Match</th>
                    <th>Umpires</th>
                    <th className="num">Concerns</th>
                    <th>Captain</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => setOpen(r)}>
                      <td className="nowrap">{fmtDate(r.date)}</td>
                      {isAdmin && (
                        <td>
                          <strong>{r.clubName}</strong>
                        </td>
                      )}
                      <td>
                        {r.side === 'Home' ? 'v' : '@'} {r.opponent}
                        {r.competition && <div className="sc-how">{r.competition}</div>}
                      </td>
                      <td>
                        {r.umpires.map((u, i) => (
                          <div key={i} className="crb-ump-line">
                            <span>{u.name}</span> <Score v={umpireAvg(u)} />
                          </div>
                        ))}
                      </td>
                      <td className="num">
                        {r.umpires.reduce((n, u) => n + u.concerns.length, 0) || '–'}
                      </td>
                      <td className="nowrap">{r.captain}</td>
                    </tr>
                  ))}
                  {!shown.length && (
                    <tr>
                      <td colSpan={isAdmin ? 6 : 5} className="sc-how" style={{ padding: 20 }}>
                        No reports match the filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Umpires</div>
                <div className="card-sub">
                  Average across {isAdmin ? "captains'" : 'your'} reports · lowest-rated first among
                  equals
                </div>
              </div>
            </div>
            <div className="sc-scroll">
              <table className="sc-tbl">
                <thead>
                  <tr>
                    <th>Umpire</th>
                    <th className="num">Reports</th>
                    <th className="num">Avg</th>
                    {RATING_CRITERIA.map((c) => (
                      <th key={c.key} className="num" title={c.label}>
                        {c.label.split(' ')[0]}
                      </th>
                    ))}
                    <th>Most flagged</th>
                  </tr>
                </thead>
                <tbody>
                  {umpires.map((u) => (
                    <tr key={u.name}>
                      <td>
                        <strong>{u.name}</strong>
                      </td>
                      <td className="num">{u.reports}</td>
                      <td className="num">
                        <Score v={u.avg} />
                      </td>
                      {RATING_CRITERIA.map((c) => (
                        <td key={c.key} className="num">
                          {u.crit[c.key]?.toFixed(1) ?? '–'}
                        </td>
                      ))}
                      <td className="sc-how">
                        {u.concerns.length
                          ? u.concerns
                              .slice(0, 2)
                              .map(([k, n]) => `${concernLabel(k)} (${n})`)
                              .join(', ')
                          : '–'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {open && <ReportDetail report={open} showClub={isAdmin} onClose={() => setOpen(null)} />}
    </div>
  );
}

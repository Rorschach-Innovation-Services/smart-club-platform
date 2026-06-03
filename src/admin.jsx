/* ─── Admin views ─── */

import { useState as useStateA, useMemo as useMemoA, useEffect as useEffectA } from 'react';
import { createPortal } from 'react-dom';
import {
  DISTRICTS,
  REQUIRED_DOCS,
  CQI_STRUCTURE,
  SUBMISSION_DEADLINE_DEFAULT,
  cohortStats,
  docCompletion,
  overallProgress,
  fixtureCost,
  generateRoundRobin,
  formatDeadlineLong,
  formatDeadlineShort,
  formatDeadlineMid,
  daysUntil,
} from './data.jsx';
import {
  leagueOptionsForDistrict,
  optionsGroupedByGroup,
  findByKey,
  slugifyLeagueKey,
  OVERARCHING_DISTRICT,
} from './leagues.js';
import { exportRowsToXlsx, exportSheetsToXlsx, clubExportRow } from './exportXlsx.js';
import { openBccReminder } from './mailto.js';
import { EMAIL_RE } from './api.js';
import { parseSupport } from './support.js';
import {
  Icon,
  Pill,
  Btn,
  Card,
  EmptyState,
  KPI,
  ProgressBar,
  ProgChip,
  ClubAvatar,
  ClubNameCell,
  YN,
  Choice,
  CountUp,
  statusFor,
  affPill,
  cqiBand,
  scoreCQI,
} from './atoms.jsx';

/* ─── AdminFixtures — series cards + drilldown fixture table with distance + travel-cost ─── */
export function AdminFixtures({
  clubs,
  allSeries,
  onCreateSeries,
  onUpdateSeries,
  onDeleteSeries,
  onDuplicateSeries,
  onSetReleased,
  toast,
}) {
  const [activeId, setActiveId] = useStateA(allSeries[0]?.id);
  const active = allSeries.find((s) => s.id === activeId) || allSeries[0];
  const [confirm, setConfirm] = useStateA(null); // shared confirmation modal state
  const clubBy = (id) => clubs.find((c) => c.id === id);

  // Aggregate distance + fuel per series
  const seriesAgg = (s) => {
    let totalKm = 0,
      totalCost = 0;
    s.fixtures.forEach((f) => {
      const home = clubBy(f.home),
        away = clubBy(f.away);
      if (!home || !away) return;
      const c = fixtureCost(home, away, s.costPerKm, s.carsPerAwayTrip);
      totalKm += c.roundTripKm;
      totalCost += c.fuelR;
    });
    return { totalKm, totalCost };
  };

  // Export the active series' fixtures to .xlsx. Clubs without geocoded grounds
  // can't have distance/travel computed (haversine returns 0) — emit '—' rather
  // than a misleading 0.
  function exportSchedule() {
    if (!active) return toast?.('No series to export');
    const rows = active.fixtures.map((f) => {
      const home = clubBy(f.home),
        away = clubBy(f.away);
      const hasGeo =
        home?.ground?.lat != null &&
        home?.ground?.lon != null &&
        away?.ground?.lat != null &&
        away?.ground?.lon != null;
      const cost =
        home && away ? fixtureCost(home, away, active.costPerKm, active.carsPerAwayTrip) : null;
      return {
        Round: f.round,
        Date: new Date(f.date).toLocaleDateString('en-GB', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }),
        Home: home?.name || 'TBD',
        Venue: f.venueOverride || home?.ground?.venue || '—',
        Suburb: home?.ground?.suburb || '',
        Away: away?.name || 'TBD',
        'Distance (km)': hasGeo && cost ? Number(cost.distanceKm.toFixed(1)) : '—',
        'Travel (R)': hasGeo && cost ? Math.round(cost.fuelR) : '—',
        Status: f.status || 'scheduled',
      };
    });
    const fname = `${active.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')}-schedule.xlsx`;
    exportRowsToXlsx(fname, 'Schedule', rows).catch(() => toast?.('Export failed — please retry'));
  }

  // Shared release/recall confirmation builders — used by header, card, and bottom bar
  function askRelease(s) {
    setConfirm({
      title: `Release ${s.fixtures.length} fixtures to the league?`,
      body: `This publishes the full ${s.name} schedule to all ${s.teams.length} affiliated clubs. They'll see it in their portals immediately and receive email + SMS notifications.`,
      onYes: () => {
        onSetReleased(s.id, true);
        setConfirm(null);
        toast?.(s.name + ' · released to ' + s.teams.length + ' clubs');
      },
    });
  }
  function askRecall(s) {
    setConfirm({
      title: 'Recall this release?',
      body: "All clubs will be notified that the schedule has been pulled back to draft. They won't see updates until you release again.",
      danger: true,
      onYes: () => {
        onSetReleased(s.id, false);
        setConfirm(null);
        toast?.(s.name + ' · recalled to draft');
      },
    });
  }

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Dolphins · Admin Console / Fixtures &amp; Venues</div>
          <h1 className="ph-title">
            Fixtures &amp; <em>Venues</em>
          </h1>
          <p className="ph-desc">
            Auto-generated round-robin schedules across each Cricket Services series. Home venues
            flow from the affiliation form. Travel distance and fuel cost are calculated for every
            away fixture.
          </p>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" icon={Icon.Download} size="sm" onClick={exportSchedule}>
            Export schedule
          </Btn>
          <Btn tone="outline" icon={Icon.Plus} size="sm" onClick={onCreateSeries}>
            Create series
          </Btn>
          {/* Primary CTA — always visible. State reflects the active series. */}
          {active &&
            (active.released ? (
              <Btn tone="outline" size="sm" onClick={() => askRecall(active)}>
                Recall release
              </Btn>
            ) : (
              <Btn tone="teal" size="sm" icon={Icon.Arrow} onClick={() => askRelease(active)}>
                Release to clubs
              </Btn>
            ))}
        </div>
      </div>

      {allSeries.length === 0 ? (
        <EmptyState
          icon={Icon.Field}
          title="No series yet"
          sub="Create your first fixture series to auto-generate round-robin schedules and calculate travel cost for every away fixture."
          action={
            <Btn tone="teal" icon={Icon.Plus} onClick={onCreateSeries}>
              Create your first series
            </Btn>
          }
        />
      ) : (
        <>
          {/* Series cards strip — each card has its own quick release/recall button */}
          <div className="series-strip">
            {allSeries.map((s) => {
              const agg = seriesAgg(s);
              return (
                <div
                  key={s.id}
                  className={`series-card ${s.id === activeId ? 'active' : ''}`}
                  onClick={() => setActiveId(s.id)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="series-card-head">
                    <div className="series-card-name">{s.name}</div>
                    {s.released ? (
                      <div className="series-card-released">Released</div>
                    ) : (
                      <div className="series-card-draft">Draft</div>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      fontWeight: 500,
                      fontFamily: "'Montserrat',sans-serif",
                    }}
                  >
                    {s.teams.length} teams · {s.fixtures.length} fixtures · {s.maxOvers} ov · start{' '}
                    {new Date(s.startDate).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </div>
                  <div className="series-card-meta">
                    <div className="series-card-stat">
                      <div className="series-card-stat-l">Total km</div>
                      <div className="series-card-stat-n">
                        {Math.round(agg.totalKm).toLocaleString()}
                      </div>
                    </div>
                    <div className="series-card-stat">
                      <div className="series-card-stat-l">Travel</div>
                      <div className="series-card-stat-n" style={{ color: 'var(--green)' }}>
                        R {Math.round(agg.totalCost).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  {/* Quick action — stops card click so it doesn't also switch tab */}
                  <div className="series-card-cta" onClick={(e) => e.stopPropagation()}>
                    {s.released ? (
                      <button className="series-card-btn recall" onClick={() => askRecall(s)}>
                        ↺ Recall draft
                      </button>
                    ) : (
                      <button className="series-card-btn release" onClick={() => askRelease(s)}>
                        Release to clubs →
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Active series drill-down */}
          {active && (
            <FixtureTable
              series={active}
              clubs={clubs}
              onUpdateSeries={onUpdateSeries}
              onDeleteSeries={onDeleteSeries}
              onDuplicateSeries={onDuplicateSeries}
              onSetReleased={onSetReleased}
              onAskRelease={askRelease}
              onAskRecall={askRecall}
              toast={toast}
            />
          )}
        </>
      )}

      {/* Shared confirmation modal — portaled to document.body so it escapes the
          .main containing block (which has a residual transform from .main > *
          fadeUp animation that otherwise breaks position:fixed centering). */}
      {confirm &&
        createPortal(
          <div
            className="fix-confirm"
            onClick={(e) => e.target === e.currentTarget && setConfirm(null)}
          >
            <div className="fix-confirm-box">
              <div className={`fix-confirm-icon ${confirm.danger ? 'danger' : 'go'}`}>
                {confirm.danger ? (
                  <svg viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 2L22 21H2L12 2z"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M12 9v5M12 17v.5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none">
                    <path
                      d="M4 12l5 5L20 6"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </div>
              <div className="fix-confirm-title">{confirm.title}</div>
              <div className="fix-confirm-body">{confirm.body}</div>
              <div className="fix-confirm-actions">
                <Btn tone="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Btn>
                <Btn
                  tone={confirm.danger ? 'ink' : 'teal'}
                  icon={confirm.danger ? undefined : Icon.Arrow}
                  onClick={confirm.onYes}
                >
                  {confirm.danger ? 'Yes, recall' : 'Release to clubs'}
                </Btn>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/* ─── FixtureTable with full human-in-the-loop editing ─── */
export function FixtureTable({
  series,
  clubs,
  onUpdateSeries,
  onDeleteSeries,
  onDuplicateSeries,
  onSetReleased,
  onAskRelease,
  onAskRecall,
  toast,
}) {
  const clubBy = (id) => clubs.find((c) => c.id === id);
  const [editingId, setEditingId] = useStateA(null);
  const [filter, setFilter] = useStateA('all');
  const [confirm, setConfirm] = useStateA(null); // {title, body, onYes} — for delete/regen only; release uses parent's modal

  // Helpers — operate on series.fixtures via onUpdateSeries
  function updateFixture(fixtureId, updates) {
    onUpdateSeries(series.id, (s) => ({
      ...s,
      fixtures: s.fixtures.map((f) => (f.id === fixtureId ? { ...f, ...updates } : f)),
    }));
  }
  function deleteFixture(fixtureId) {
    onUpdateSeries(series.id, (s) => ({
      ...s,
      fixtures: s.fixtures.filter((f) => f.id !== fixtureId),
    }));
  }
  function addFixture() {
    const newId = 'f' + Date.now();
    const last = series.fixtures[series.fixtures.length - 1];
    const nextRound = last ? last.round + 1 : 1;
    const baseDate = last ? new Date(last.date) : new Date(series.startDate);
    baseDate.setDate(baseDate.getDate() + 7);
    const newFix = {
      id: newId,
      round: nextRound,
      date: baseDate.toISOString().slice(0, 10),
      home: series.teams[0],
      away: series.teams[1] || series.teams[0],
      status: 'scheduled',
    };
    onUpdateSeries(series.id, (s) => ({ ...s, fixtures: [...s.fixtures, newFix] }));
    setEditingId(newId);
    toast?.('Fixture added — edit details');
  }
  function regenerate() {
    onUpdateSeries(series.id, (s) => ({
      ...s,
      fixtures: generateRoundRobin(s.teams, s.startDate),
    }));
    setConfirm(null);
    toast?.(`${series.name} · fixtures regenerated`);
  }

  // Build rows with computed cost
  const allRows = series.fixtures.map((f) => {
    const home = clubBy(f.home),
      away = clubBy(f.away);
    const c = fixtureCost(home, away, series.costPerKm, series.carsPerAwayTrip);
    return { f, home, away, c };
  });
  let totalKm = 0,
    totalCost = 0;
  allRows.forEach((r) => {
    totalKm += r.c.roundTripKm;
    totalCost += r.c.fuelR;
  });
  const rows =
    filter === 'all' ? allRows : allRows.filter((r) => (r.f.status || 'scheduled') === filter);

  const statusCounts = {
    all: allRows.length,
    scheduled: allRows.filter((r) => (r.f.status || 'scheduled') === 'scheduled').length,
    completed: allRows.filter((r) => r.f.status === 'completed').length,
    postponed: allRows.filter((r) => r.f.status === 'postponed').length,
    cancelled: allRows.filter((r) => r.f.status === 'cancelled').length,
  };

  return (
    <div>
      {/* Hero header */}
      <div className="fix-header">
        <div>
          <div className="fix-header-title">{series.name}</div>
          <div className="fix-header-sub">
            {series.seriesType} · {series.teams.length} teams · {series.fixtures.length} fixtures ·{' '}
            {series.maxOvers} overs · {series.category}
          </div>
        </div>
        <div className="fix-header-aggs">
          <div className="fix-header-agg">
            <div className="fix-header-agg-l">Season distance</div>
            <div className="fix-header-agg-n">
              <CountUp to={Math.round(totalKm)} />
              <span className="unit">km</span>
            </div>
          </div>
          <div className="fix-header-agg">
            <div className="fix-header-agg-l">Travel cost</div>
            <div className="fix-header-agg-n">
              R <CountUp to={Math.round(totalCost)} />
            </div>
          </div>
          <div className="fix-header-agg">
            <div className="fix-header-agg-l">@ R / km</div>
            <div className="fix-header-agg-n">
              R {series.costPerKm.toFixed(2)}
              <span className="unit">× {series.carsPerAwayTrip} cars</span>
            </div>
          </div>
        </div>
      </div>

      {/* Toolbar — filter + actions */}
      <div className="fix-toolbar">
        <div className="fix-toolbar-left">
          {[
            { k: 'all', label: 'All' },
            { k: 'scheduled', label: 'Scheduled' },
            { k: 'completed', label: 'Completed' },
            { k: 'postponed', label: 'Postponed' },
            { k: 'cancelled', label: 'Cancelled' },
          ].map((f) => (
            <button
              key={f.k}
              className={`filter-pill ${filter === f.k ? 'active' : ''}`}
              onClick={() => setFilter(f.k)}
            >
              {f.label}
              <span className="count">{statusCounts[f.k]}</span>
            </button>
          ))}
        </div>
        <div className="fix-toolbar-right">
          <Btn tone="outline" size="sm" icon={Icon.Plus} onClick={addFixture}>
            Add fixture
          </Btn>
          <Btn
            tone="outline"
            size="sm"
            onClick={() =>
              setConfirm({
                title: 'Regenerate all fixtures?',
                body: 'This will replace every fixture in this series with a fresh round-robin based on the current teams + start date. All manual edits, dates, and status changes will be lost. This cannot be undone.',
                onYes: regenerate,
                danger: true,
              })
            }
          >
            ↻ Regenerate
          </Btn>
          <Btn
            tone="outline"
            size="sm"
            onClick={() => {
              onDuplicateSeries(series.id);
              toast?.('Series duplicated');
            }}
          >
            Duplicate
          </Btn>
          <Btn
            tone="ghost"
            size="sm"
            onClick={() =>
              setConfirm({
                title: 'Delete this series?',
                body: `Permanently remove "${series.name}" along with all ${series.fixtures.length} fixtures. The Dolphins office cannot undo this.`,
                onYes: () => {
                  onDeleteSeries(series.id);
                  setConfirm(null);
                  toast?.('Series deleted');
                },
                danger: true,
              })
            }
          >
            Delete series
          </Btn>
        </div>
      </div>

      {/* Table */}
      <div className="fix-table-wrap">
        <table className="fix-table">
          <thead>
            <tr>
              <th style={{ width: 50 }}>Rd</th>
              <th style={{ width: 120 }}>Date</th>
              <th>Home (host)</th>
              <th>Venue · Suburb</th>
              <th>Away (visitors)</th>
              <th style={{ width: 90, textAlign: 'right' }}>Distance</th>
              <th style={{ width: 110, textAlign: 'right' }}>Travel</th>
              <th style={{ width: 110 }}>Status</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ f, home, away, c }) => {
              if (editingId === f.id) {
                return (
                  <EditFixtureRow
                    key={f.id}
                    fixture={f}
                    teams={series.teams.map(clubBy).filter(Boolean)}
                    onSave={(updates) => {
                      updateFixture(f.id, updates);
                      setEditingId(null);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                );
              }
              const status = f.status || 'scheduled';
              return (
                <tr
                  key={f.id}
                  className={
                    status === 'cancelled' || status === 'postponed' ? 'fix-muted-row' : ''
                  }
                >
                  <td>
                    <span className="fix-row-rd">R{f.round}</span>
                  </td>
                  <td>
                    <span className="fix-row-date">
                      {new Date(f.date).toLocaleDateString('en-GB', {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                      })}
                    </span>
                  </td>
                  <td>
                    <div className="fix-row-team">
                      {home && <ClubAvatar club={home} size={26} />}
                      <div>
                        <div className="fix-row-team-name">{home?.name || 'TBD'}</div>
                        <div className="fix-row-team-sub">{home?.sub}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="fix-row-venue">
                      <div className="fix-row-venue-name">
                        {f.venueOverride || home?.ground?.venue || '—'}
                      </div>
                      <div className="fix-row-venue-suburb">{home?.ground?.suburb || ''}</div>
                    </div>
                  </td>
                  <td>
                    <div className="fix-row-team">
                      {away && <ClubAvatar club={away} size={26} />}
                      <div>
                        <div className="fix-row-team-name">{away?.name || 'TBD'}</div>
                        <div className="fix-row-team-sub">{away?.sub}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="fix-row-dist">
                      {c.distanceKm.toFixed(1)}
                      <span className="unit">km</span>
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="fix-row-cost">
                      <span className="cur">R</span>
                      {Math.round(c.fuelR).toLocaleString()}
                    </span>
                  </td>
                  <td>
                    <span className={`fix-status ${status}`}>{status}</span>
                  </td>
                  <td>
                    <div className="fix-row-actions">
                      <button
                        className="fix-action-btn"
                        title="Edit fixture"
                        onClick={() => setEditingId(f.id)}
                      >
                        <svg viewBox="0 0 16 16" fill="none">
                          <path
                            d="M11 2l3 3-7.5 7.5L3 13l.5-3.5L11 2z"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                      <button
                        className="fix-action-btn danger"
                        title="Delete fixture"
                        onClick={() => deleteFixture(f.id)}
                      >
                        <svg viewBox="0 0 16 16" fill="none">
                          <path
                            d="M3 4h10M5 4l1-2h4l1 2M5 4v9a1 1 0 001 1h4a1 1 0 001-1V4"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan="9"
                  style={{
                    padding: '28px',
                    textAlign: 'center',
                    color: 'var(--muted)',
                    fontSize: 13,
                  }}
                >
                  No fixtures match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="fix-totals">
          <div className="fix-totals-item">
            <div className="fix-totals-l">Fixtures</div>
            <div className="fix-totals-n">{series.fixtures.length}</div>
          </div>
          <div className="fix-totals-item">
            <div className="fix-totals-l">Total km (round-trip)</div>
            <div className="fix-totals-n">{Math.round(totalKm).toLocaleString()} km</div>
          </div>
          <div className="fix-totals-item">
            <div className="fix-totals-l">Season fuel total</div>
            <div className="fix-totals-n green">R {Math.round(totalCost).toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Release bar — bottom-right CTA to publish the fixtures to clubs */}
      <div className={`fix-release-bar ${series.released ? 'released' : ''}`}>
        <div className="fix-release-text">
          {series.released ? (
            <>
              <div className="fix-release-eyebrow">✓ Live to clubs</div>
              <div className="fix-release-text-title">
                Fixtures released to all {series.teams.length} clubs
              </div>
              <div className="fix-release-text-sub">
                Published{' '}
                {new Date(series.releasedAt).toLocaleString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                · every club portal now shows their schedule + travel costs · email + SMS
                notifications sent
              </div>
            </>
          ) : (
            <>
              <div className="fix-release-eyebrow">Draft mode</div>
              <div className="fix-release-text-title">Visible only to the Dolphins office</div>
              <div className="fix-release-text-sub">
                Once released, every fixture goes live in every club portal, the Athlete Management
                System is notified, and email/SMS reminders go out to chairs &amp; captains.
              </div>
            </>
          )}
        </div>
        <div className="fix-release-actions">
          {series.released ? (
            <Btn tone="outline" onClick={() => onAskRecall?.(series)}>
              Recall draft
            </Btn>
          ) : (
            <Btn tone="teal" icon={Icon.Arrow} onClick={() => onAskRelease?.(series)}>
              Release to clubs →
            </Btn>
          )}
        </div>
      </div>

      {/* Confirmation modal — portaled to document.body to escape the residual transform
          on .main > * (same fix as the shared confirm modal above). */}
      {confirm &&
        createPortal(
          <div
            className="fix-confirm"
            onClick={(e) => e.target === e.currentTarget && setConfirm(null)}
          >
            <div className="fix-confirm-box">
              <div className="fix-confirm-icon">
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 2L22 21H2L12 2z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M12 9v5M12 17v.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <div className="fix-confirm-title">{confirm.title}</div>
              <div className="fix-confirm-body">{confirm.body}</div>
              <div className="fix-confirm-actions">
                <Btn tone="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Btn>
                <Btn tone="ink" onClick={confirm.onYes}>
                  Yes, continue
                </Btn>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/* Inline edit row */
function EditFixtureRow({ fixture, teams, onSave, onCancel }) {
  const [draft, setDraft] = useStateA({
    round: fixture.round,
    date: fixture.date,
    home: fixture.home,
    away: fixture.away,
    venueOverride: fixture.venueOverride || '',
    status: fixture.status || 'scheduled',
  });
  function u(k, v) {
    setDraft((prev) => ({ ...prev, [k]: v }));
  }
  return (
    <tr className="fix-edit-tr">
      <td colSpan="9">
        <div className="fix-edit-grid">
          <div className="fix-edit-field">
            <label>Round</label>
            <input
              type="number"
              min="1"
              value={draft.round}
              onChange={(e) => u('round', parseInt(e.target.value) || 1)}
            />
          </div>
          <div className="fix-edit-field">
            <label>Date</label>
            <input type="date" value={draft.date} onChange={(e) => u('date', e.target.value)} />
          </div>
          <div className="fix-edit-field">
            <label>Home (host)</label>
            <select value={draft.home} onChange={(e) => u('home', e.target.value)}>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="fix-edit-field">
            <label>Away (visitors)</label>
            <select value={draft.away} onChange={(e) => u('away', e.target.value)}>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="fix-edit-field" style={{ gridColumn: 'span 2' }}>
            <label>Venue override</label>
            <input
              type="text"
              placeholder="(use home club's ground)"
              value={draft.venueOverride}
              onChange={(e) => u('venueOverride', e.target.value)}
            />
          </div>
          <div className="fix-edit-field">
            <label>Status</label>
            <select value={draft.status} onChange={(e) => u('status', e.target.value)}>
              <option value="scheduled">Scheduled</option>
              <option value="completed">Completed</option>
              <option value="postponed">Postponed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div
            className="fix-edit-actions"
            style={{ gridColumn: 'span 6', justifyContent: 'flex-end', marginTop: 8 }}
          >
            <Btn tone="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Btn>
            <Btn tone="ink" size="sm" icon={Icon.Check} onClick={() => onSave(draft)}>
              Save changes
            </Btn>
          </div>
        </div>
      </td>
    </tr>
  );
}

/* ─── CreateSeriesForm — automated league flow + advanced overrides ─── */
export function CreateSeriesForm({ clubs, onCreate, onClose, allLeagues = [] }) {
  const [d, setD] = useStateA({
    leagueKey: '', // dropdown: pick a league → auto-fills name + teams
    name: '',
    startDate: '',
    kind: 'series', // "series" or "tournament"
    bulkSend: true, // tick to bulk-send fixtures to stakeholders on create
    divisions: false,
    groups: 1,
    maxOvers: 20,
    maxPlayers: 11,
    rosterLimit: 'No Limit',
    ballType: 'Hard Tennis Ball',
    seriesType: 'Twenty20 (16-25 overs)',
    powerPlay: false,
    category: 'Men',
    level: 'Club',
    winPoints: 2,
    bonusPoints: 0,
    lossPoints: 0,
    tiePoints: 1,
    abandonedPoints: 1,
    ballsPerOver: 0,
    maxBallsPerOver: 0,
    minLeagueMatches: 0,
    configureExtras: false,
    lockAfterLive: false,
    lockAfterManual: false,
    preventTeamSwitch: false,
    umpireReportsMandatory: false,
    captainReportsMandatory: false,
    sendReportEmails: false,
    rankCalculator: 'New',
    hideSeriesDetails: false,
    allowLockedRegistration: false,
    pointsTableOrder: ['Most Points', 'NRR', 'Head To Head', 'Number of Wins', 'Win Percentage'],
    tags: '',
    teams: [],
    costPerKm: 4.5,
    carsPerAwayTrip: 3,
  });
  const [showAdvanced, setShowAdvanced] = useStateA(false);

  function u(k, v) {
    setD((prev) => ({ ...prev, [k]: v }));
  }
  function toggleTeam(id) {
    setD((prev) => ({
      ...prev,
      teams: prev.teams.includes(id) ? prev.teams.filter((t) => t !== id) : [...prev.teams, id],
    }));
  }
  function moveOrder(idx, dir) {
    setD((prev) => {
      const arr = [...prev.pointsTableOrder];
      const j = idx + dir;
      if (j < 0 || j >= arr.length) return prev;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
      return { ...prev, pointsTableOrder: arr };
    });
  }

  // Teams eligible = paid clubs that registered for the selected league.
  // Falls back to "all paid clubs" until a league is picked.
  const teamsForLeague = d.leagueKey
    ? clubs.filter((c) => c.paid && Array.isArray(c.leagues) && c.leagues.includes(d.leagueKey))
    : [];
  const eligibleTeams = d.leagueKey ? teamsForLeague : clubs.filter((c) => c.paid);

  // When the admin picks a league, auto-fill the name and bulk-select all registered teams.
  function pickLeague(key) {
    const L = findByKey(allLeagues, key);
    const filtered = clubs.filter(
      (c) => c.paid && Array.isArray(c.leagues) && c.leagues.includes(key),
    );
    setD((prev) => ({
      ...prev,
      leagueKey: key,
      name: L ? `${L.label} · 2026/27` : prev.name,
      teams: filtered.map((c) => c.id),
      tags: L ? `${L.group}, ${L.label}` : prev.tags,
    }));
  }

  const canCreate = d.name && d.startDate && d.teams.length >= 2;

  function submit() {
    if (!canCreate) return;
    const series = {
      id: 's-' + Date.now(),
      ...d,
      tags: d.tags
        ? d.tags
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      fixtures: generateRoundRobin(d.teams, d.startDate),
    };
    onCreate(series);
    onClose();
  }

  return (
    <div className="cs-form">
      {/* ─── Streamlined basics — dropdown · date · toggle · auto-teams ─── */}
      <div className="cs-row">
        <div className="cs-row-label">
          Series Name<span className="req">*</span>
        </div>
        <div className="cs-row-input">
          <select
            className="field-select"
            value={d.leagueKey}
            onChange={(e) => pickLeague(e.target.value)}
            style={{ minWidth: 280 }}
          >
            <option value="">Select a league / division…</option>
            {(() => {
              const groups = optionsGroupedByGroup(allLeagues);
              return Object.entries(groups).map(([group, opts]) => (
                <optgroup key={group} label={group}>
                  {opts.map((L) => (
                    <option key={L.key} value={L.key}>
                      {L.label} · 2026/27
                    </option>
                  ))}
                </optgroup>
              ));
            })()}
          </select>
        </div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">
          Start Date<span className="req">*</span>
        </div>
        <div className="cs-row-input">
          <input type="date" value={d.startDate} onChange={(e) => u('startDate', e.target.value)} />
        </div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Format</div>
        <div className="cs-row-input">
          <Choice
            value={d.kind === 'series' ? 'Series' : 'Standalone tournament'}
            onChange={(v) => u('kind', v === 'Series' ? 'series' : 'tournament')}
            options={['Series', 'Standalone tournament']}
          />
        </div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Bulk-send to stakeholders</div>
        <div className="cs-row-input">
          <YN value={d.bulkSend} onChange={(v) => u('bulkSend', v)} />
          <span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 10 }}>
            Emails fixture list to chairpersons &amp; coaches once created.
          </span>
        </div>
      </div>

      {/* ─── Auto-populated teams — visible right under the basics ─── */}
      <div className="cs-section">
        <div className="cs-section-title">— Teams (auto-populated from registrations)</div>
      </div>
      {d.leagueKey ? (
        <div className="cs-row">
          <div className="cs-row-label">
            {teamsForLeague.length} club{teamsForLeague.length === 1 ? '' : 's'} registered for{' '}
            <strong>{findByKey(allLeagues, d.leagueKey)?.label ?? d.leagueKey}</strong>
          </div>
          <div className="cs-row-input">
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8 }}>
              All clubs that selected this league during affiliation are pre-included. Tap a chip to
              opt one out.
            </div>
            <div className="cs-teams-grid">
              {teamsForLeague.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  No registered clubs yet — once clubs affiliate for this league they'll appear here
                  automatically.
                </span>
              ) : (
                teamsForLeague.map((c) => {
                  const on = d.teams.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      className={`cs-team-chip ${on ? 'on' : ''}`}
                      onClick={() => toggleTeam(c.id)}
                    >
                      {on && <Icon.Check />}
                      {c.name}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="cs-row">
          <div className="cs-row-label">Pick a league above</div>
          <div className="cs-row-input">
            <div style={{ fontSize: 12, color: 'var(--muted)', padding: '10px 0' }}>
              Once a league is selected, every affiliated club that registered for it will be added
              automatically.
            </div>
          </div>
        </div>
      )}

      {/* ─── Advanced overrides (collapsed by default) ─── */}
      <div
        className="cs-section"
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
        onClick={() => setShowAdvanced((v) => !v)}
      >
        <div className="cs-section-title">— Advanced match &amp; scoring settings</div>
        <span
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            fontWeight: 700,
          }}
        >
          {showAdvanced ? 'Hide' : 'Defaults applied · click to edit'}
        </span>
      </div>
      {showAdvanced && (
        <>
          <div className="cs-row">
            <div className="cs-row-label">Series has Divisions?</div>
            <div className="cs-row-input">
              <YN value={d.divisions} onChange={(v) => u('divisions', v)} />
            </div>
          </div>
          <div className="cs-row">
            <div className="cs-row-label">Groups</div>
            <div className="cs-row-input">
              <input
                className="field-input"
                type="number"
                min="1"
                max="8"
                value={d.groups}
                onChange={(e) => u('groups', parseInt(e.target.value) || 1)}
                style={{ width: 90 }}
              />
            </div>
          </div>
          <div className="cs-row">
            <div className="cs-row-label">Maximum Overs</div>
            <div className="cs-row-input">
              <select
                className="field-select"
                value={d.maxOvers}
                onChange={(e) => u('maxOvers', parseInt(e.target.value))}
                style={{ width: 120 }}
              >
                {[10, 15, 20, 25, 30, 40, 45, 50].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="cs-row">
            <div className="cs-row-label">Max Players per Team in a Match</div>
            <div className="cs-row-input">
              <select
                className="field-select"
                value={d.maxPlayers}
                onChange={(e) => u('maxPlayers', parseInt(e.target.value))}
                style={{ width: 90 }}
              >
                {[7, 8, 9, 10, 11, 12, 13].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="cs-row">
            <div className="cs-row-label">Max Player Limit for Roster</div>
            <div className="cs-row-input">
              <select
                className="field-select"
                value={d.rosterLimit}
                onChange={(e) => u('rosterLimit', e.target.value)}
                style={{ width: 130 }}
              >
                <option>No Limit</option>
                <option>15</option>
                <option>18</option>
                <option>20</option>
                <option>25</option>
              </select>
            </div>
          </div>
          <div className="cs-row">
            <div className="cs-row-label">Ball Type</div>
            <div className="cs-row-input">
              <select
                className="field-select"
                value={d.ballType}
                onChange={(e) => u('ballType', e.target.value)}
                style={{ width: 200 }}
              >
                <option>Cricket Ball</option>
                <option>Hard Tennis Ball</option>
                <option>Tape Ball</option>
              </select>
            </div>
          </div>
          <div className="cs-row">
            <div className="cs-row-label">Series Type</div>
            <div className="cs-row-input">
              <select
                className="field-select"
                value={d.seriesType}
                onChange={(e) => u('seriesType', e.target.value)}
                style={{ width: 220 }}
              >
                <option>Twenty20 (16-25 overs)</option>
                <option>One-Day (40-50 overs)</option>
                <option>Multi-Day</option>
                <option>The Hundred</option>
              </select>
            </div>
          </div>
          <div className="cs-row">
            <div className="cs-row-label">Power Play Applicable?</div>
            <div className="cs-row-input">
              <YN value={d.powerPlay} onChange={(v) => u('powerPlay', v)} />
            </div>
          </div>
          <div className="cs-row">
            <div className="cs-row-label">Category</div>
            <div className="cs-row-input">
              <select
                className="field-select"
                value={d.category}
                onChange={(e) => u('category', e.target.value)}
                style={{ width: 120 }}
              >
                <option>Men</option>
                <option>Women</option>
                <option>Mixed</option>
                <option>U19</option>
              </select>
            </div>
          </div>
          <div className="cs-row">
            <div className="cs-row-label">Level</div>
            <div className="cs-row-input">
              <select
                className="field-select"
                value={d.level}
                onChange={(e) => u('level', e.target.value)}
                style={{ width: 140 }}
              >
                <option>Club</option>
                <option>School</option>
                <option>Veterans</option>
              </select>
            </div>
          </div>

          {/* Points */}
          <div className="cs-section">
            <div className="cs-section-title">— Points Awards</div>
          </div>
          <div className="cs-row">
            <div className="cs-row-label">
              Match outcomes<span className="req">*</span>
            </div>
            <div className="cs-row-input cs-row-multi">
              <div className="cs-row-multi-item">
                <label>Win</label>
                <input
                  type="number"
                  value={d.winPoints}
                  onChange={(e) => u('winPoints', parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="cs-row-multi-item">
                <label>Bonus</label>
                <input
                  type="number"
                  value={d.bonusPoints}
                  onChange={(e) => u('bonusPoints', parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="cs-row-multi-item">
                <label>Loss</label>
                <input
                  type="number"
                  value={d.lossPoints}
                  onChange={(e) => u('lossPoints', parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="cs-row-multi-item">
                <label>Tie</label>
                <input
                  type="number"
                  value={d.tiePoints}
                  onChange={(e) => u('tiePoints', parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="cs-row-multi-item">
                <label>Abandoned</label>
                <input
                  type="number"
                  value={d.abandonedPoints}
                  onChange={(e) => u('abandonedPoints', parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
          </div>
          <div className="cs-row">
            <div className="cs-row-label">Balls per over / Max</div>
            <div className="cs-row-input cs-row-multi">
              <div className="cs-row-multi-item">
                <label>Standard</label>
                <input
                  type="number"
                  value={d.ballsPerOver}
                  onChange={(e) => u('ballsPerOver', parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="cs-row-multi-item">
                <label>Max</label>
                <input
                  type="number"
                  value={d.maxBallsPerOver}
                  onChange={(e) => u('maxBallsPerOver', parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
          </div>
          <div className="cs-row">
            <div className="cs-row-label">Minimum league matches (player playoff eligibility)</div>
            <div className="cs-row-input">
              <input
                className="field-input"
                type="number"
                value={d.minLeagueMatches}
                onChange={(e) => u('minLeagueMatches', parseInt(e.target.value) || 0)}
                style={{ width: 90 }}
              />
            </div>
          </div>

          {/* Yes / No config */}
          <div className="cs-section">
            <div className="cs-section-title">— Match &amp; Scorecard Configuration</div>
          </div>
          {[
            ['configureExtras', 'Configure extras as good balls?'],
            ['lockAfterLive', 'Lock scorecard after live scoring?'],
            ['lockAfterManual', 'Lock scorecard after manual update?'],
            ['preventTeamSwitch', 'Prevent players switching teams after playing?'],
            ['umpireReportsMandatory', 'Umpire reports mandatory?'],
            ['captainReportsMandatory', 'Captain reports mandatory?'],
            ['sendReportEmails', 'Email captain/umpires for end-of-match reports?'],
            ['hideSeriesDetails', 'Hide series details?'],
            ['allowLockedRegistration', 'Allow player registration when team is locked?'],
          ].map(([key, label]) => (
            <div key={key} className="cs-row">
              <div className="cs-row-label">{label}</div>
              <div className="cs-row-input">
                <YN value={d[key]} onChange={(v) => u(key, v)} />
              </div>
            </div>
          ))}
          <div className="cs-row">
            <div className="cs-row-label">Rank Calculator</div>
            <div className="cs-row-input">
              <Choice
                value={d.rankCalculator}
                onChange={(v) => u('rankCalculator', v)}
                options={['Old', 'New']}
              />
            </div>
          </div>

          {/* Travel cost defaults */}
          <div className="cs-section">
            <div className="cs-section-title">— Travel &amp; Logistics</div>
          </div>
          <div className="cs-row">
            <div className="cs-row-label">Default cost per km / Cars per away trip</div>
            <div className="cs-row-input cs-row-multi">
              <div className="cs-row-multi-item">
                <label>R / km</label>
                <input
                  type="number"
                  step="0.10"
                  value={d.costPerKm}
                  onChange={(e) => u('costPerKm', parseFloat(e.target.value) || 0)}
                />
              </div>
              <div className="cs-row-multi-item">
                <label>Cars</label>
                <input
                  type="number"
                  value={d.carsPerAwayTrip}
                  onChange={(e) => u('carsPerAwayTrip', parseInt(e.target.value) || 1)}
                />
              </div>
            </div>
          </div>

          {/* Points Table Order */}
          <div className="cs-section">
            <div className="cs-section-title">— Points Table Order</div>
          </div>
          <div className="cs-row">
            <div className="cs-row-label">Tie-break sequence (top wins first)</div>
            <div className="cs-row-input">
              <div className="cs-points-list">
                {d.pointsTableOrder.map((rule, idx) => (
                  <div key={rule} className="cs-points-row">
                    <span className="order-num">{idx + 1}</span>
                    {rule}
                    <span className="cs-points-grip" style={{ display: 'flex', gap: 4 }}>
                      <button
                        onClick={() => moveOrder(idx, -1)}
                        disabled={idx === 0}
                        style={{
                          background: 'transparent',
                          border: 0,
                          color: 'var(--muted)',
                          cursor: idx === 0 ? 'not-allowed' : 'pointer',
                          padding: 2,
                        }}
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => moveOrder(idx, 1)}
                        disabled={idx === d.pointsTableOrder.length - 1}
                        style={{
                          background: 'transparent',
                          border: 0,
                          color: 'var(--muted)',
                          cursor: idx === d.pointsTableOrder.length - 1 ? 'not-allowed' : 'pointer',
                          padding: 2,
                        }}
                      >
                        ↓
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Tags */}
          <div className="cs-row">
            <div className="cs-row-label">
              Tags{' '}
              <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 4 }}>
                (comma-separated)
              </span>
            </div>
            <div className="cs-row-input">
              <input
                className="field-input"
                placeholder="Premier, Men, Round-robin"
                value={d.tags}
                onChange={(e) => u('tags', e.target.value)}
              />
            </div>
          </div>
        </>
      )}

      <div
        className="row"
        style={{ marginTop: 22, justifyContent: 'space-between', gap: 10, padding: '12px 0' }}
      >
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--muted)',
            fontFamily: "'Montserrat',sans-serif",
            fontWeight: 500,
          }}
        >
          {canCreate
            ? `Ready · ${d.kind === 'tournament' ? 'tournament' : 'series'} · ${(d.teams.length * (d.teams.length - 1)) / 2} round-robin fixtures from ${d.startDate}${d.bulkSend ? ' · fixtures will be bulk-sent to stakeholders' : ''}`
            : !d.leagueKey
              ? 'Pick a league / division to auto-populate teams'
              : !d.startDate
                ? 'Add a start date'
                : 'At least 2 registered teams are required'}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Btn tone="outline" onClick={onClose}>
            Cancel
          </Btn>
          <Btn tone="teal" icon={Icon.Check} disabled={!canCreate} onClick={submit}>
            {d.bulkSend ? `Create ${d.kind} & send` : `Create ${d.kind}`}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ─── Empty-cohort state — shown before any clubs are onboarded ─── */
function EmptyCohort({ onOnboard }) {
  return (
    <div style={{ padding: '8px 0' }}>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Admin Console</div>
          <h1 className="ph-title">Welcome — let&apos;s get your union set up</h1>
          <p className="ph-desc">
            No clubs yet. Onboard your affiliated clubs to start tracking affiliation, compliance
            and the Club Quality Index. Once clubs are in, your cohort dashboard fills in here.
          </p>
        </div>
      </div>
      <EmptyState
        icon={Icon.Clubs}
        title="No clubs onboarded yet"
        sub="Add your first club to begin. You can onboard them one at a time with the chairperson's contact details and share their portal link."
        action={
          <Btn tone="teal" icon={Icon.Plus} onClick={onOnboard}>
            Onboard your first club
          </Btn>
        }
      />
    </div>
  );
}

/* ─── AdminLeagues — manage the tenant league catalogue clubs opt into ─── */
export function AdminLeagues({ allLeagues, clubs, onCreate, onEdit, onDeleteLeague, toast }) {
  const [confirm, setConfirm] = useStateA(null);
  const countFor = (key) =>
    clubs.filter((c) => Array.isArray(c.leagues) && c.leagues.includes(key)).length;

  function askDelete(L) {
    const n = countFor(L.key);
    setConfirm({
      title: `Delete “${L.label}”?`,
      body:
        n > 0
          ? `${n} club${n === 1 ? ' is' : 's are'} registered for this league. Deleting it won't change their records, but it disappears from the affiliation picker and fixture filters.`
          : 'This league will be removed from the affiliation picker and fixture filters.',
      onYes: () => {
        onDeleteLeague(L.key);
        setConfirm(null);
        toast?.(`${L.label} · deleted`);
      },
    });
  }

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Dolphins · Admin Console / Leagues</div>
          <h1 className="ph-title">
            League <em>catalogue</em>
          </h1>
          <p className="ph-desc">
            Create the leagues &amp; divisions clubs opt into during affiliation — fixtures are then
            generated per league. Set these up before inviting clubs so they can register.
          </p>
        </div>
        <div className="ph-actions">
          <Btn tone="teal" icon={Icon.Plus} size="sm" onClick={onCreate}>
            Create league
          </Btn>
        </div>
      </div>

      {allLeagues.length === 0 ? (
        <EmptyState
          icon={Icon.Shield}
          title="No leagues yet"
          sub="Create your first league so clubs can register for it during affiliation and admins can build fixtures."
          action={
            <Btn tone="teal" icon={Icon.Plus} onClick={onCreate}>
              Create your first league
            </Btn>
          }
        />
      ) : (
        <div className="tbl-w">
          <table className="tbl">
            <thead>
              <tr>
                <th>League</th>
                <th>District</th>
                <th>Group</th>
                <th>Clubs registered</th>
                <th style={{ width: 130 }}></th>
              </tr>
            </thead>
            <tbody>
              {allLeagues.map((L) => (
                <tr key={L.key}>
                  <td>
                    <span style={{ fontWeight: 700 }}>{L.label}</span>
                  </td>
                  <td>
                    <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{L.district}</span>
                  </td>
                  <td>
                    <Pill tone="muted">{L.group}</Pill>
                  </td>
                  <td>
                    <span style={{ fontFamily: "'Montserrat',sans-serif", fontWeight: 700 }}>
                      {countFor(L.key)}
                    </span>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <Btn tone="outline" size="sm" onClick={() => onEdit(L)}>
                        Edit
                      </Btn>
                      <Btn tone="ghost" size="sm" onClick={() => askDelete(L)}>
                        Delete
                      </Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirm &&
        createPortal(
          <div
            className="fix-confirm"
            onClick={(e) => e.target === e.currentTarget && setConfirm(null)}
          >
            <div className="fix-confirm-box">
              <div className="fix-confirm-icon danger">
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 2L22 21H2L12 2z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M12 9v5M12 17v.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <div className="fix-confirm-title">{confirm.title}</div>
              <div className="fix-confirm-body">{confirm.body}</div>
              <div className="fix-confirm-actions">
                <Btn tone="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Btn>
                <Btn tone="ink" onClick={confirm.onYes}>
                  Yes, delete
                </Btn>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/* ─── LeagueForm — create/edit a league (rendered inside a TaskModal) ─── */
export function LeagueForm({ league, allLeagues, onCreate, onUpdate, onClose, toast }) {
  const editing = !!league;
  const [label, setLabel] = useStateA(league?.label || '');
  const [group, setGroup] = useStateA(league?.group || 'Overarching Leagues');
  const [district, setDistrict] = useStateA(league?.district || OVERARCHING_DISTRICT);
  const [note, setNote] = useStateA(league?.note || '');
  const [busy, setBusy] = useStateA(false);

  // Key is the immutable matching token. New leagues slug it from the name; edits keep it.
  const key = editing ? league.key : slugifyLeagueKey(label);
  const dupKey = !editing && !!key && allLeagues.some((l) => l.key === key);
  const canSave = label.trim() && group.trim() && key && !dupKey && !busy;

  function submit() {
    if (!canSave) return;
    setBusy(true);
    const patch = {
      label: label.trim(),
      group: group.trim(),
      district,
      note: note.trim() || undefined,
    };
    const p = editing ? onUpdate(league.key, patch) : onCreate({ key, ...patch });
    Promise.resolve(p)
      .then(() => {
        toast?.(editing ? `${label} · updated` : `${label} · created`);
        onClose();
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
        {editing
          ? 'Edit this league. Its key is fixed — clubs are matched to it by key.'
          : 'Name the league, choose the district it belongs to, and group it for the picker.'}
      </p>
      <div className="field">
        <div className="field-label">
          League name <span className="req">*</span>
        </div>
        <input
          className="field-input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. EMCU Division 1"
          autoFocus
        />
        {key && (
          <div
            style={{ fontSize: 11, color: dupKey ? 'var(--coral)' : 'var(--muted)', marginTop: 4 }}
          >
            {dupKey
              ? 'A league with this name already exists.'
              : `Key: ${key}${editing ? ' (fixed)' : ''}`}
          </div>
        )}
      </div>
      <div className="field-grid-2">
        <div className="field">
          <div className="field-label">
            District <span className="req">*</span>
          </div>
          <select
            className="field-select"
            value={district}
            onChange={(e) => setDistrict(e.target.value)}
          >
            <option value={OVERARCHING_DISTRICT}>{OVERARCHING_DISTRICT}</option>
            {DISTRICTS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <div className="field-label">
            Group <span className="req">*</span>
          </div>
          <input
            className="field-input"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="e.g. EMCU Divisions"
          />
        </div>
      </div>
      <div className="field">
        <div className="field-label">Note (optional)</div>
        <input
          className="field-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Shown under the league in the picker"
        />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <Btn tone="outline" onClick={onClose}>
          Cancel
        </Btn>
        <Btn tone="teal" icon={Icon.Check} disabled={!canSave} onClick={submit}>
          {busy ? 'Saving…' : editing ? 'Save league' : 'Create league'}
        </Btn>
      </div>
    </div>
  );
}

export function AdminDashboard({
  clubs,
  gotoClub,
  gotoList,
  gotoAdminView,
  toast,
  submissionDeadline,
  onUpdateDeadline,
  support,
  onUpdateSupport,
}) {
  const stats = cohortStats(clubs);
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  const notify = (m) => (toast ? toast(m, 'warn') : null);
  const [showEditDeadline, setShowEditDeadline] = useStateA(false);
  const [showEditSupport, setShowEditSupport] = useStateA(false);

  // Open a bcc mail draft to the chairs of every club still missing a submission
  // (unpaid, no CQI, or any compliance doc outstanding).
  function remindBulk() {
    const behind = (c) => !c.paid || c.cqi === 0 || !Object.values(c.docs).every(Boolean);
    openBccReminder({
      emails: clubs.filter(behind).map((c) => c.exco?.chair?.email),
      subject: 'Smart Club Integration — outstanding submissions',
      toast,
      emptyMessage: 'All clubs are up to date',
    });
  }

  // Blank tenant: show the onboarding empty state instead of a 0-of-0 dashboard.
  if (clubs.length === 0) return <EmptyCohort onOnboard={gotoList} />;

  const deadlineLong = formatDeadlineLong(submissionDeadline);
  const deadlineMid = formatDeadlineMid(submissionDeadline);
  const daysLeft = daysUntil(submissionDeadline);
  const daysLabel =
    daysLeft === 0
      ? 'Deadline today'
      : daysLeft === 1
        ? '1 day remaining'
        : `${daysLeft} days remaining`;

  // Sort by progress descending for "at risk" / "leaders"
  const ranked = [...clubs]
    .map((c) => ({ ...c, prog: overallProgress(c) }))
    .sort((a, b) => b.prog - a.prog);
  const leaders = ranked.slice(0, 5);
  const atRisk = [...ranked].sort((a, b) => a.prog - b.prog).slice(0, 5);

  // Phase completion roll-up — each card routes to its filtered cohort view
  const phases = [
    {
      num: '01',
      label: 'Affiliation',
      tone: 'navy',
      done: clubs.filter((c) => c.paid).length,
      view: 'affiliations',
    },
    {
      num: '02',
      label: 'League / Fixtures',
      tone: 'teal',
      done: clubs.filter((c) => c.affiliation === 'complete').length,
      view: 'fixtures',
    },
    {
      num: '03',
      label: 'Player Registration',
      tone: 'navy',
      done: clubs.filter((c) => c.players >= 30).length,
      view: 'clubs_list',
      future:
        'Direct player-registration links flow straight into the cohort next phase — clubs and roster metrics auto-update, no manual admin entry.',
    },
    { num: '04', label: 'Live Scoring / Talent ID', tone: 'teal', done: 0, view: null },
    {
      num: '05',
      label: 'Compliance Docs',
      tone: 'gold',
      done: clubs.filter((c) => Object.values(c.docs).every((v) => v)).length,
      view: 'documents',
    },
  ];
  const onPhaseClick = (p) =>
    p.view
      ? gotoAdminView
        ? gotoAdminView(p.view)
        : null
      : notify('Phase 04 dashboards coming soon');

  return (
    <div>
      {/* Aspirational hero banner */}
      <div
        className="hero-banner"
        style={{ backgroundImage: "url('/players/ackerman-green.jpg')", height: 170 }}
      >
        <div className="hero-content">
          <div className="hero-eyebrow">Hollywoodbets Dolphins · Cricket Services</div>
          <h2 className="hero-title">
            Building the next <em>generation</em>.
          </h2>
          <p className="hero-sub">
            Every club below is a feeder for our provincial squad. Track readiness, lift standards,
            identify talent.
          </p>
        </div>
        <div className="hero-attrib">
          <strong>Marques Ackerman</strong> · 78* (63)
        </div>
      </div>

      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Dolphins · Admin Console</div>
          <h1 className="ph-title">
            Club Integration <em>Cohort</em>
          </h1>
          <p className="ph-desc">
            {stats.total} affiliated clubs across the Dolphins Cricket Services districts. Track
            affiliation, document compliance, CQI scoring and franchise readiness for the 2026/27
            season.
          </p>
        </div>
        <div className="ph-actions">
          <Btn
            tone="outline"
            icon={Icon.Download}
            size="sm"
            onClick={() => {
              const rows = clubs.map((c) =>
                clubExportRow(c, { docCompletion, overallProgress, cqiBand }),
              );
              if (!rows.length) return notify('No clubs to export');
              exportRowsToXlsx('cohort-report.xlsx', 'Cohort', rows).catch(() =>
                notify('Export failed — please retry'),
              );
            }}
          >
            Export cohort report
          </Btn>
          <Btn tone="ink" icon={Icon.Mail} size="sm" onClick={remindBulk}>
            Send bulk reminder
          </Btn>
        </div>
      </div>

      {/* Deadline banner */}
      <div className="deadline">
        <div className="deadline-icon">
          <Icon.Clock />
        </div>
        <div className="deadline-text">
          <strong>Submission deadline · {deadlineLong}.</strong> Clubs must complete affiliation,
          upload required compliance documents, and submit the CQI form.{' '}
          <span className="days">{daysLabel}</span>.
        </div>
        <div className="deadline-cta" style={{ display: 'flex', gap: 8 }}>
          <Btn tone="outline" size="sm" icon={Icon.Mail} onClick={() => setShowEditSupport(true)}>
            Support contact
          </Btn>
          <Btn tone="outline" size="sm" icon={Icon.Form} onClick={() => setShowEditDeadline(true)}>
            Edit deadline
          </Btn>
        </div>
      </div>

      <div className="kpi-strip">
        <KPI label="Total clubs" num={<CountUp to={stats.total} />} sub="2026/27 season" />
        <KPI
          tone={statusFor(pct(stats.paid, stats.total))}
          label="Affiliated"
          num={<CountUp to={stats.paid} />}
          sub={`${pct(stats.paid, stats.total)}% of cohort`}
        />
        <KPI
          tone={statusFor(pct(stats.docsComplete, stats.total))}
          label="Docs compliant"
          num={<CountUp to={stats.docsComplete} />}
          sub={`${pct(stats.docsComplete, stats.total)}% complete`}
        />
        <KPI
          tone={statusFor(pct(stats.cqiSubmitted, stats.total))}
          label="CQI submitted"
          num={<CountUp to={stats.cqiSubmitted} />}
          sub={`${pct(stats.cqiSubmitted, stats.total)}% submitted`}
        />
        <KPI
          tone={statusFor(stats.avgCqi, 75, 60)}
          label="Avg CQI score"
          num={<CountUp to={stats.avgCqi} decimals={1} />}
          sub="raw score · cohort avg"
        />
      </div>

      {/* Phase roll-up */}
      <Card
        title="Integration phase roll-up"
        sub="Cohort progress through the 5-phase smart integration journey"
      >
        <div className="phase-track" style={{ borderRadius: 0, border: 'none' }}>
          {phases.map((p, i) => (
            <div
              key={i}
              className="phase-step"
              style={{
                padding: '14px 18px',
                borderRight: i < phases.length - 1 ? '1px solid var(--line)' : 'none',
              }}
              onClick={() => onPhaseClick(p)}
            >
              <div className="ps-n" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>PHASE {p.num}</span>
                {p.future && (
                  <span
                    style={{
                      fontSize: 8.5,
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                      fontWeight: 800,
                      padding: '1px 6px',
                      borderRadius: 999,
                      background: 'rgba(200,168,75,0.18)',
                      color: 'var(--gold-deep, #8a6e1c)',
                      border: '1px solid rgba(200,168,75,0.45)',
                    }}
                  >
                    Next phase
                  </span>
                )}
              </div>
              <div className="ps-t">{p.label}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                <div style={{ flex: 1 }}>
                  <ProgressBar value={pct(p.done, stats.total)} tone={p.tone} />
                </div>
                <div
                  style={{
                    fontFamily: "'Montserrat',sans-serif",
                    fontSize: 11,
                    color: 'var(--muted)',
                  }}
                >
                  {p.done}/{stats.total}
                </div>
              </div>
              {p.future && (
                <div
                  style={{
                    fontSize: 10.5,
                    color: 'var(--gold-deep, #8a6e1c)',
                    fontFamily: "'Montserrat',sans-serif",
                    marginTop: 8,
                    fontStyle: 'italic',
                    lineHeight: 1.4,
                  }}
                >
                  ↗ {p.future}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16, marginTop: 16 }}>
        <Card title="Recent activity" sub="Last 7 days · all districts">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              { who: 'Clares CC', what: 'submitted CQI form', when: '2h ago', tone: 'teal' },
              { who: 'Harlequins CC', what: 'uploaded AGM Minutes', when: '5h ago', tone: 'teal' },
              {
                who: 'UKZN CC',
                what: 'submitted 2026/27 affiliation form',
                when: '1d ago',
                tone: 'navy',
              },
              {
                who: 'Phoenix CC',
                what: 'viewed affiliation form but has not submitted',
                when: '2d ago',
                tone: 'gold',
              },
              {
                who: 'Berea Rovers CC',
                what: 'affiliation form in progress · awaiting submission',
                when: '3d ago',
                tone: 'gold',
              },
              {
                who: 'Tongaat CC',
                what: 'has not started — 2 reminders sent',
                when: '6d ago',
                tone: 'coral',
              },
            ].map((a, i) => (
              <div
                key={i}
                className="row"
                style={{
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: i % 2 ? 'var(--paper)' : 'transparent',
                }}
              >
                <span className={`sdot ${a.tone}`} />
                <span style={{ fontWeight: 500, color: 'var(--ink)', fontSize: 13 }}>{a.who}</span>
                <span style={{ flex: 1, fontSize: 13, color: 'var(--muted)' }}>{a.what}</span>
                <span
                  style={{
                    fontFamily: "'Montserrat',sans-serif",
                    fontSize: 10.5,
                    color: 'var(--muted-2)',
                  }}
                >
                  {a.when}
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Leaderboard"
          sub="Highest overall integration progress"
          action={
            <button className="btn btn-ghost btn-sm" onClick={gotoList}>
              View all <Icon.Arrow />
            </button>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {leaders.map((c, i) => (
              <button
                key={c.id}
                className="row"
                style={{ padding: '6px 4px', width: '100%', textAlign: 'left' }}
                onClick={() => gotoClub(c.id)}
              >
                <span
                  style={{
                    fontFamily: "'Montserrat',sans-serif",
                    fontSize: 11,
                    fontWeight: 800,
                    color: i === 0 ? '#076B36' : i < 3 ? 'var(--ink)' : 'var(--muted-2)',
                    width: 20,
                    textAlign: 'center',
                  }}
                >
                  0{i + 1}
                </span>
                <ClubAvatar club={c} size={26} />
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{c.name}</span>
                <ProgChip
                  value={c.prog}
                  tone={c.prog >= 80 ? 'teal' : c.prog >= 60 ? 'gold' : 'coral'}
                />
              </button>
            ))}
          </div>
          <div className="hr" />
          <div
            style={{
              fontFamily: "'Montserrat',sans-serif",
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--coral)',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              marginBottom: 10,
            }}
          >
            At risk · needs intervention
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {atRisk.map((c) => (
              <button
                key={c.id}
                className="row"
                style={{ padding: '6px 4px', width: '100%', textAlign: 'left' }}
                onClick={() => gotoClub(c.id)}
              >
                <ClubAvatar club={c} size={26} />
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{c.name}</span>
                <ProgChip value={c.prog} tone="coral" />
              </button>
            ))}
          </div>
        </Card>
      </div>

      {showEditDeadline && (
        <EditDeadlineModal
          currentISO={submissionDeadline}
          defaultISO={SUBMISSION_DEADLINE_DEFAULT}
          onClose={() => setShowEditDeadline(false)}
          onSave={(iso) => onUpdateDeadline && onUpdateDeadline(iso)}
          toast={toast}
        />
      )}
      {showEditSupport && (
        <EditSupportContactModal
          current={support}
          onClose={() => setShowEditSupport(false)}
          onSave={(c) => onUpdateSupport && onUpdateSupport(c)}
          toast={toast}
        />
      )}
    </div>
  );
}

/* ─── Cohort insights — visualises CQI bands, doc compliance, outstanding resources ─── */
function ClubInsights({ clubs, submissionDeadline }) {
  const deadlineShort = formatDeadlineShort(submissionDeadline);
  const deadlineMid = formatDeadlineMid(submissionDeadline);
  // CQI bands
  const bandTone = (key) =>
    key === 'C' ? 'warn' : key === 'D' ? 'danger' : key === 'P' ? 'pending' : '';
  const bands = [
    { key: 'A', label: 'A · 80+', count: clubs.filter((c) => c.cqi >= 80).length },
    { key: 'B', label: 'B · 65–80', count: clubs.filter((c) => c.cqi >= 65 && c.cqi < 80).length },
    { key: 'C', label: 'C · 50–65', count: clubs.filter((c) => c.cqi >= 50 && c.cqi < 65).length },
    { key: 'D', label: 'D · <50', count: clubs.filter((c) => c.cqi > 0 && c.cqi < 50).length },
    { key: 'P', label: 'Pending', count: clubs.filter((c) => c.cqi === 0).length },
  ];
  const maxBand = Math.max(...bands.map((b) => b.count), 1);
  const submitted = clubs.filter((c) => c.cqi > 0);
  const avgCqi = submitted.length ? submitted.reduce((s, c) => s + c.cqi, 0) / submitted.length : 0;

  // Doc compliance per required doc
  const docStats = REQUIRED_DOCS.map((d) => {
    const uploaded = clubs.filter((c) => c.docs[d.key]).length;
    const pct = clubs.length ? Math.round((uploaded / clubs.length) * 100) : 0;
    return { key: d.key, name: d.name, count: uploaded, total: clubs.length, pct };
  });
  const mostMissing = [...docStats].sort((a, b) => a.count - b.count)[0];
  const docTone = (pct) => (pct >= 70 ? '' : pct >= 40 ? 'warn' : 'danger');

  // Resources required
  const unpaid = clubs.filter((c) => !c.paid).length;
  const incompleteDocs = clubs.filter((c) => !Object.values(c.docs).every((v) => v)).length;
  const noCqi = clubs.filter((c) => c.cqi === 0).length;
  const totalReminders = unpaid + noCqi;

  return (
    <div className="insights-panel">
      {/* ─── CQI Score Distribution ─── */}
      <div className="insights-card">
        <div className="insights-card-head">
          <div className="insights-card-title">CQI Score Distribution</div>
          <div className="insights-card-meta">
            Avg <CountUp to={avgCqi} decimals={1} />
          </div>
        </div>
        {bands.map((b) => (
          <div key={b.key} className="insights-bar-row">
            <div className="insights-bar-label">{b.label}</div>
            <div className="insights-bar-track">
              <div
                className={`insights-bar-fill ${bandTone(b.key)}`}
                style={{ width: (b.count / maxBand) * 100 + '%' }}
              />
            </div>
            <div className="insights-bar-num">{b.count}</div>
          </div>
        ))}
        <div className="insights-callout good">
          <strong>{submitted.length}</strong> of {clubs.length} clubs submitted CQI · spread across{' '}
          {bands.filter((b) => b.count > 0 && b.key !== 'P').length} performance band
          {bands.filter((b) => b.count > 0 && b.key !== 'P').length === 1 ? '' : 's'}
        </div>
      </div>

      {/* ─── Document Compliance ─── */}
      <div className="insights-card">
        <div className="insights-card-head">
          <div className="insights-card-title">Document Compliance</div>
          <div className="insights-card-meta">of {clubs.length} clubs</div>
        </div>
        {docStats.map((d) => (
          <div key={d.key} className="insights-bar-row wide-label">
            <div className="insights-bar-label" title={d.name}>
              {d.name}
            </div>
            <div className="insights-bar-track">
              <div
                className={`insights-bar-fill ${docTone(d.pct)}`}
                style={{ width: d.pct + '%' }}
              />
            </div>
            <div className="insights-bar-num">
              {d.count}/{d.total}
            </div>
          </div>
        ))}
        <div className={`insights-callout ${mostMissing.pct < 40 ? 'alert' : 'warn'}`}>
          Most missing: <strong>{mostMissing.name}</strong> — only{' '}
          <strong>{mostMissing.count}</strong> of {mostMissing.total} clubs uploaded
        </div>
      </div>

      {/* ─── Resources Required ─── */}
      <div className="insights-card">
        <div className="insights-card-head">
          <div className="insights-card-title">Resources Required</div>
          <div className="insights-card-meta">{deadlineShort} deadline</div>
        </div>
        <div className="resource-list">
          <div className="resource-row">
            <span
              className={`resource-num ${unpaid > clubs.length * 0.3 ? 'danger' : unpaid > 0 ? 'warn' : 'good'}`}
            >
              <CountUp to={unpaid} />
            </span>
            <span className="resource-text">
              <strong>{unpaid === 1 ? 'club' : 'clubs'}</strong> haven't submitted the 2026/27
              affiliation form
            </span>
          </div>
          <div className="resource-row">
            <span
              className={`resource-num ${incompleteDocs > clubs.length * 0.3 ? 'danger' : incompleteDocs > 0 ? 'warn' : 'good'}`}
            >
              <CountUp to={incompleteDocs} />
            </span>
            <span className="resource-text">
              <strong>{incompleteDocs === 1 ? 'club' : 'clubs'}</strong> missing one or more
              compliance docs
            </span>
          </div>
          <div className="resource-row">
            <span
              className={`resource-num ${noCqi > clubs.length * 0.3 ? 'danger' : noCqi > 0 ? 'warn' : 'good'}`}
            >
              <CountUp to={noCqi} />
            </span>
            <span className="resource-text">
              <strong>{noCqi === 1 ? 'club' : 'clubs'}</strong> haven't submitted their CQI form
            </span>
          </div>
        </div>
        <div className="insights-callout alert">
          Send <strong>{totalReminders}</strong> reminder{totalReminders === 1 ? '' : 's'} before{' '}
          <strong>{deadlineMid}</strong> — target the at-risk clubs first.
        </div>
      </div>
    </div>
  );
}

export function AdminClubsList({
  clubs,
  gotoClub,
  toast,
  submissionDeadline,
  onOnboardClub,
  onBulkOnboardClubs,
  knownClubs = [],
}) {
  const [q, setQ] = useStateA('');
  const [filter, setFilter] = useStateA('all');
  const [showOnboard, setShowOnboard] = useStateA(false);

  const filtered = useMemoA(() => {
    let cs = clubs;
    if (q)
      cs = cs.filter(
        (c) =>
          c.name.toLowerCase().includes(q.toLowerCase()) ||
          c.chair.toLowerCase().includes(q.toLowerCase()),
      );
    if (filter === 'complete')
      cs = cs.filter(
        (c) => c.affiliation === 'complete' && Object.values(c.docs).every((v) => v) && c.cqi > 0,
      );
    if (filter === 'incomplete')
      cs = cs.filter(
        (c) =>
          !(c.affiliation === 'complete' && Object.values(c.docs).every((v) => v) && c.cqi > 0),
      );
    if (filter === 'not_paid') cs = cs.filter((c) => !c.paid);
    if (filter === 'no_cqi') cs = cs.filter((c) => c.cqi === 0);
    return cs;
  }, [clubs, q, filter]);

  const counts = useMemoA(
    () => ({
      all: clubs.length,
      complete: clubs.filter(
        (c) => c.affiliation === 'complete' && Object.values(c.docs).every((v) => v) && c.cqi > 0,
      ).length,
      incomplete: clubs.filter(
        (c) =>
          !(c.affiliation === 'complete' && Object.values(c.docs).every((v) => v) && c.cqi > 0),
      ).length,
      not_paid: clubs.filter((c) => !c.paid).length,
      no_cqi: clubs.filter((c) => c.cqi === 0).length,
    }),
    [clubs],
  );

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Dolphins · Admin Console / Clubs</div>
          <h1 className="ph-title">
            Club <em>directory</em>
          </h1>
          <p className="ph-desc">
            Filter, sort and drill into each affiliated club's submission status across all five
            phases of the smart integration programme.
          </p>
        </div>
        <div className="ph-actions">
          <Btn
            tone="outline"
            icon={Icon.Download}
            size="sm"
            onClick={() => {
              const rows = filtered.map((c) =>
                clubExportRow(c, { docCompletion, overallProgress, cqiBand }),
              );
              if (!rows.length) return toast?.('No clubs match — nothing to export', 'warn');
              exportRowsToXlsx('club-directory.xlsx', 'Clubs', rows).catch(() =>
                toast?.('Export failed — please retry', 'warn'),
              );
            }}
          >
            Export Excel
          </Btn>
          <Btn tone="ink" icon={Icon.Plus} size="sm" onClick={() => setShowOnboard(true)}>
            Onboard new club
          </Btn>
        </div>
      </div>

      {clubs.length === 0 ? (
        <EmptyCohort onOnboard={() => setShowOnboard(true)} />
      ) : (
        <>
          {/* Cohort insights panel — CQI distribution, document compliance, resources required */}
          <ClubInsights clubs={clubs} submissionDeadline={submissionDeadline} />

          <div className="filter-row">
            <input
              className="search-box"
              placeholder="Search by club name or chairperson…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {[
              { k: 'all', label: 'All clubs' },
              { k: 'complete', label: 'Fully integrated' },
              { k: 'incomplete', label: 'Incomplete' },
              { k: 'not_paid', label: 'Affiliation outstanding' },
              { k: 'no_cqi', label: 'CQI not submitted' },
            ].map((f) => (
              <button
                key={f.k}
                className={`filter-pill ${filter === f.k ? 'active' : ''}`}
                onClick={() => setFilter(f.k)}
              >
                {f.label}
                <span className="count">{counts[f.k]}</span>
              </button>
            ))}
          </div>

          <div className="tbl-w">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: '24%' }}>Club</th>
                  <th>Chairperson</th>
                  <th>Affiliation</th>
                  <th>Docs</th>
                  <th>CQI</th>
                  <th>Overall</th>
                  <th style={{ width: 60 }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const dc = docCompletion(c);
                  const op = overallProgress(c);
                  const band = cqiBand(c.cqi);
                  return (
                    <tr key={c.id} className="clickable" onClick={() => gotoClub(c.id)}>
                      <td>
                        <ClubNameCell club={c} />
                      </td>
                      <td>
                        <div style={{ fontSize: 12.5 }}>{c.chair}</div>
                        <div
                          style={{
                            fontSize: 10.5,
                            color: 'var(--muted-2)',
                            fontFamily: "'Montserrat',sans-serif",
                          }}
                        >
                          {c.sub}
                        </div>
                      </td>
                      <td>
                        {affPill(c.affiliation)}{' '}
                        {c.paid && (
                          <span
                            style={{
                              fontFamily: "'Montserrat',sans-serif",
                              fontSize: 10,
                              color: 'var(--teal-deep)',
                              marginLeft: 6,
                            }}
                          >
                            · SUBMITTED
                          </span>
                        )}
                      </td>
                      <td>
                        <ProgChip
                          value={dc}
                          tone={dc === 100 ? 'teal' : dc >= 50 ? 'gold' : 'coral'}
                        />
                      </td>
                      <td>
                        <Pill tone={band.tone}>{band.label}</Pill>
                      </td>
                      <td>
                        <ProgChip
                          value={op}
                          tone={op >= 80 ? 'teal' : op >= 50 ? 'gold' : 'coral'}
                        />
                      </td>
                      <td style={{ textAlign: 'right', paddingRight: 18 }}>
                        <Icon.Arrow />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {showOnboard && (
        <OnboardNewClubModal
          clubs={clubs}
          knownClubs={knownClubs}
          onClose={() => setShowOnboard(false)}
          onOnboard={onOnboardClub}
          onBulkOnboard={onBulkOnboardClubs}
          toast={toast}
        />
      )}
    </div>
  );
}

/* ─── OnboardNewClubModal — admin onboards a brand-new club + shares the link ───
   Step 1: search existing clubs by name; matches show inline so the admin can't
   accidentally double-onboard. No match → form (chair, email, cell, district).
   Step 2: switches to the share view with the deep link + Copy / Email / WhatsApp.
   The chair's email and cell are pre-filled into the share affordances. */
function OnboardNewClubModal({ clubs, knownClubs = [], onClose, onOnboard, onBulkOnboard, toast }) {
  const [query, setQuery] = useStateA('');
  const [chair, setChair] = useStateA('');
  const [chairEmail, setChairEmail] = useStateA('');
  const [chairCell, setChairCell] = useStateA('');
  const [district, setDistrict] = useStateA(DISTRICTS[0]);
  const [createdClub, setCreatedClub] = useStateA(null);
  const [bulkCreated, setBulkCreated] = useStateA(null); // array of created clubs after bulk onboard
  const [selectedKeys, setSelectedKeys] = useStateA(new Set()); // checkbox state, keyed by known-club name
  const [copied, setCopied] = useStateA(false);
  const [autoFilled, setAutoFilled] = useStateA(null); // null | club name auto-filled from

  function toggleSelect(name) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const trimmedQuery = query.trim();
  const matches =
    trimmedQuery.length >= 2
      ? clubs.filter((c) => c.name.toLowerCase().includes(trimmedQuery.toLowerCase()))
      : [];
  const exact = matches.find((c) => c.name.toLowerCase() === trimmedQuery.toLowerCase());
  const showForm = trimmedQuery.length >= 2 && !exact;

  // Known-clubs registry: filter against the cohort so already-onboarded clubs
  // disappear from the picker, and against the typed search.
  const onboardedNames = new Set(clubs.map((c) => c.name.toLowerCase()));
  // Onboarding suggestions come from the tenant's config (empty by default, so the
  // quick-pick is hidden and admins onboard manually).
  const remainingKnown = knownClubs.filter((k) => !onboardedNames.has(k.name.toLowerCase()));
  const filteredKnown =
    trimmedQuery.length >= 2
      ? remainingKnown.filter(
          (k) =>
            k.name.toLowerCase().includes(trimmedQuery.toLowerCase()) ||
            k.chair.toLowerCase().includes(trimmedQuery.toLowerCase()) ||
            k.chairEmail.toLowerCase().includes(trimmedQuery.toLowerCase()) ||
            k.chairCell.replace(/\s+/g, '').includes(trimmedQuery.replace(/\s+/g, '')),
        )
      : remainingKnown;

  function pickKnown(k) {
    setQuery(k.name);
    setChair(k.chair);
    setChairEmail(k.chairEmail);
    setChairCell(k.chairCell);
    setDistrict(k.district);
    setAutoFilled(k.name);
  }

  // Auto-fill from the tenant's known-clubs list (the `knownClubs` prop; empty by
  // default) when the admin types an email/cell that matches a suggestion.
  // Triggered on every email/cell change once they're long enough to be meaningful.
  function handleEmailChange(v) {
    setChairEmail(v);
    const lower = v.trim().toLowerCase();
    if (lower.length < 5) return;
    const k = remainingKnown.find((x) => x.chairEmail.toLowerCase() === lower);
    if (k && k.name !== autoFilled) {
      setQuery(k.name);
      setChair(k.chair);
      setChairCell(k.chairCell);
      setDistrict(k.district);
      setAutoFilled(k.name);
      toast && toast(`Matched ${k.name} from the records — pre-filled the rest`);
    }
  }
  function handleCellChange(v) {
    setChairCell(v);
    const digits = v.replace(/\D+/g, '');
    if (digits.length < 7) return;
    const k = remainingKnown.find((x) => x.chairCell.replace(/\D+/g, '') === digits);
    if (k && k.name !== autoFilled) {
      setQuery(k.name);
      setChair(k.chair);
      setChairEmail(k.chairEmail);
      setDistrict(k.district);
      setAutoFilled(k.name);
      toast && toast(`Matched ${k.name} from the records — pre-filled the rest`);
    }
  }

  const canSubmit =
    trimmedQuery.length >= 2 && chair.trim() && chairEmail.trim() && chairCell.trim() && !exact;

  async function handleOnboard() {
    if (!canSubmit) return;
    const club = await onOnboard({
      name: trimmedQuery,
      chair: chair.trim(),
      chairEmail: chairEmail.trim(),
      chairCell: chairCell.trim(),
      district,
    });
    if (!club) return; // onboarding failed (toast already shown)
    setCreatedClub(club);
    toast && toast(`${club.name} onboarded · ready to share the link`);
  }

  // Bulk onboard everything currently ticked in the known-clubs picker.
  async function handleBulkOnboard() {
    const specs = remainingKnown.filter((k) => selectedKeys.has(k.name));
    if (specs.length === 0) return;
    const created = await (onBulkOnboard
      ? onBulkOnboard(specs)
      : Promise.all(specs.map((s) => onOnboard(s))));
    if (!created || !created.length) return;
    setBulkCreated(created);
    setSelectedKeys(new Set());
    toast && toast(`${created.length} clubs onboarded · share the links`);
  }
  // Select-all toggle respects the current filtered list.
  const allVisibleSelected =
    filteredKnown.length > 0 && filteredKnown.every((k) => selectedKeys.has(k.name));
  function toggleSelectAll() {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) filteredKnown.forEach((k) => next.delete(k.name));
      else filteredKnown.forEach((k) => next.add(k.name));
      return next;
    });
  }
  const selectedCount = selectedKeys.size;

  // E.164-ish for wa.me: keep digits only, swap leading 0 for ZA country code 27.
  function waNumber(cell) {
    const digits = (cell || '').replace(/\D+/g, '');
    if (!digits) return '';
    if (digits.startsWith('0')) return '27' + digits.slice(1);
    if (digits.startsWith('27')) return digits;
    return digits;
  }

  // Share-state derived values (only used after a club has been created).
  const baseUrl = (typeof window !== 'undefined' && window.location.origin) || '';
  const url = createdClub ? `${baseUrl}/club/${createdClub.id}` : '';
  const emailBody = createdClub
    ? `Hi ${createdClub.chair || 'team'},\n\nWelcome to the 2026/27 Dolphins Cricket Services season.\n\nOpen this link to get started — affiliation form, compliance documents and the Club Quality Index self-assessment all live here:\n\n${url}\n\nIf any of the required documents are outstanding, reach out to the union office. The deadline for submissions is in the platform.\n\nWelcome aboard,\nThe Dolphins office`
    : '';
  const waText = createdClub
    ? `Welcome to Dolphins Pipeline · ${createdClub.name}. Open this link to start your 2026/27 affiliation: ${url}`
    : '';

  function doCopy() {
    if (!url) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
        toast && toast('Onboarding link copied');
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        toast && toast('Onboarding link copied');
      } catch {}
      ta.remove();
    }
    setTimeout(() => setCopied(false), 2000);
  }

  // ───────────── Step 2 (bulk): bulk share view ─────────────
  if (bulkCreated && bulkCreated.length > 0) {
    const baseUrl = (typeof window !== 'undefined' && window.location.origin) || '';
    const allEmails = bulkCreated
      .map((c) => c.exco?.chair?.email)
      .filter(Boolean)
      .join(',');
    const bulkBody =
      `Welcome to the 2026/27 Dolphins Cricket Services season.\n\nEach club has its own onboarding link below — open yours to start the affiliation flow:\n\n` +
      bulkCreated.map((c) => `• ${c.name} → ${baseUrl}/club/${c.id}`).join('\n') +
      `\n\nIf any documents are outstanding, reach out to the union office.\n\nThe Dolphins office`;
    const bulkMailto = `mailto:?bcc=${encodeURIComponent(allEmails)}&subject=${encodeURIComponent('Welcome to Dolphins Pipeline · 2026/27')}&body=${encodeURIComponent(bulkBody)}`;

    const emailAllAndWaEach = () => {
      // Open one WhatsApp tab per club; browser may rate-limit, but the first
      // few will land — admin sees the rest via the per-row buttons below.
      bulkCreated.forEach((c) => {
        const wa = waNumber(c.exco?.chair?.cell);
        if (!wa) return;
        const text = `Welcome to Dolphins Pipeline · ${c.name}. Start your 2026/27 affiliation here: ${baseUrl}/club/${c.id}`;
        try {
          window.open(
            `https://wa.me/${wa}?text=${encodeURIComponent(text)}`,
            '_blank',
            'noopener,noreferrer',
          );
        } catch {}
      });
      try {
        window.location.href = bulkMailto;
      } catch {}
      toast && toast(`Sent ${bulkCreated.length} welcome emails + opened WhatsApp tabs`);
    };

    return createPortal(
      <div
        className="task-modal-backdrop"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div className="task-modal narrow" style={{ maxWidth: 680 }}>
          <div className="task-modal-head">
            <div className="task-modal-head-text">
              <div className="task-modal-head-eyebrow">
                Bulk onboard · {bulkCreated.length} clubs
              </div>
              <div className="task-modal-head-title">
                Share the <em>onboarding links</em>
              </div>
            </div>
            <button className="task-modal-close" onClick={onClose} title="Close">
              <Icon.X />
            </button>
          </div>
          <div className="task-modal-body">
            <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
              {bulkCreated.length} clubs were added to the cohort. Email all chairs together below,
              or scroll the list and use a per-row send.
            </p>

            {/* Top-level bulk send */}
            <Btn
              tone="teal"
              icon={Icon.Mail}
              onClick={emailAllAndWaEach}
              style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
            >
              Send to all · Email + WhatsApp tabs
            </Btn>
            <a
              href={bulkMailto}
              className="btn btn-outline"
              style={{
                textDecoration: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                width: '100%',
                marginBottom: 14,
              }}
            >
              <Icon.Mail /> Email all chairs (one BCC'd message)
            </a>

            {/* Per-row share */}
            <div
              style={{
                fontSize: 10.5,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--muted-2)',
                fontFamily: "'Montserrat',sans-serif",
                fontWeight: 700,
                marginBottom: 6,
              }}
            >
              Onboarded clubs · {bulkCreated.length}
            </div>
            <div
              style={{
                maxHeight: 320,
                overflowY: 'auto',
                border: '1px solid var(--line)',
                borderRadius: 10,
                background: 'var(--white)',
              }}
            >
              {bulkCreated.map((c) => {
                const url = `${baseUrl}/club/${c.id}`;
                const wa = waNumber(c.exco?.chair?.cell);
                const mailto = `mailto:${c.exco?.chair?.email || ''}?subject=${encodeURIComponent(`Welcome to Dolphins Pipeline · ${c.name}`)}&body=${encodeURIComponent(`Hi ${c.chair || 'team'},\n\nWelcome aboard. Open this link to start your 2026/27 affiliation:\n\n${url}\n\nThe Dolphins office`)}`;
                const waUrl = wa
                  ? `https://wa.me/${wa}?text=${encodeURIComponent(`Welcome to Dolphins Pipeline · ${c.name}. Start your 2026/27 affiliation: ${url}`)}`
                  : `https://wa.me/?text=${encodeURIComponent(`Welcome to Dolphins Pipeline · ${c.name}. Start your 2026/27 affiliation: ${url}`)}`;
                return (
                  <div
                    key={c.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto',
                      gap: 10,
                      padding: '12px 14px',
                      borderBottom: '1px solid var(--line)',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontFamily: "'Montserrat',sans-serif",
                          fontSize: 13,
                          fontWeight: 700,
                          color: 'var(--ink)',
                        }}
                      >
                        {c.name}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                        {c.chair} · {c.exco?.chair?.email} · {c.exco?.chair?.cell}
                      </div>
                      <div
                        style={{
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          fontSize: 11,
                          color: 'var(--teal-deep)',
                          marginTop: 4,
                          wordBreak: 'break-all',
                        }}
                      >
                        {url}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <a
                        href={mailto}
                        className="btn btn-outline"
                        style={{
                          textDecoration: 'none',
                          padding: '6px 10px',
                          fontSize: 11,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <Icon.Mail /> Email
                      </a>
                      <a
                        href={waUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-outline"
                        style={{
                          textDecoration: 'none',
                          padding: '6px 10px',
                          fontSize: 11,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <Icon.Arrow /> WA
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>

            <div
              className="row"
              style={{
                justifyContent: 'flex-end',
                gap: 8,
                paddingTop: 14,
                marginTop: 14,
                borderTop: '1px solid var(--line)',
              }}
            >
              <Btn tone="ink" onClick={onClose}>
                Done
              </Btn>
            </div>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  // ───────────── Step 2 (single): share view ─────────────
  if (createdClub) {
    const wa = waNumber(createdClub.exco?.chair?.cell);
    const chairEmailValue = createdClub.exco?.chair?.email || '';
    const mailtoUrl = `mailto:${chairEmailValue}?subject=${encodeURIComponent(`Welcome to Dolphins Pipeline · ${createdClub.name}`)}&body=${encodeURIComponent(emailBody)}`;
    const waUrl = wa
      ? `https://wa.me/${wa}?text=${encodeURIComponent(waText)}`
      : `https://wa.me/?text=${encodeURIComponent(waText)}`;
    // One click fires both: hand the mail client the mailto AND open the wa.me tab.
    const sendBoth = () => {
      // wa.me first in a new tab so the popup doesn't get blocked behind the mailto handoff
      try {
        window.open(waUrl, '_blank', 'noopener,noreferrer');
      } catch {}
      // mailto follows — the OS hands this to the mail client without nuking the new tab
      try {
        window.location.href = mailtoUrl;
      } catch {}
      toast && toast(`Sent to ${createdClub.chair.split(' ')[0]} via email & WhatsApp`);
    };
    return createPortal(
      <div
        className="task-modal-backdrop"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div className="task-modal narrow" style={{ maxWidth: 620 }}>
          <div className="task-modal-head">
            <div className="task-modal-head-text">
              <div className="task-modal-head-eyebrow">Onboarded · {createdClub.district}</div>
              <div className="task-modal-head-title">
                Share the link · <em>{createdClub.name}</em>
              </div>
            </div>
            <button className="task-modal-close" onClick={onClose} title="Close">
              <Icon.X />
            </button>
          </div>
          <div className="task-modal-body">
            <div
              style={{
                background: 'var(--paper)',
                borderRadius: 10,
                padding: '14px 16px',
                marginBottom: 14,
                border: '1px solid var(--line)',
              }}
            >
              <div
                style={{
                  fontSize: 10.5,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--muted-2)',
                  fontFamily: "'Montserrat',sans-serif",
                  fontWeight: 700,
                  marginBottom: 6,
                }}
              >
                Onboarding link
              </div>
              <div
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 13,
                  color: 'var(--ink)',
                  wordBreak: 'break-all',
                  lineHeight: 1.45,
                  padding: '10px 12px',
                  background: 'var(--white)',
                  borderRadius: 8,
                  border: '1px solid var(--line)',
                }}
              >
                {url}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                Chair: <strong style={{ color: 'var(--ink)' }}>{createdClub.chair}</strong> ·{' '}
                {chairEmailValue} · {createdClub.exco?.chair?.cell}
              </div>
            </div>

            {/* Primary one-click send: fires email + WhatsApp together */}
            <Btn
              tone="teal"
              icon={Icon.Mail}
              onClick={sendBoth}
              style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
            >
              Send via Email + WhatsApp
            </Btn>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 8,
                marginBottom: 14,
              }}
            >
              <Btn
                tone={copied ? 'teal' : 'outline'}
                icon={copied ? Icon.Check : Icon.Form}
                onClick={doCopy}
              >
                {copied ? 'Copied' : 'Copy link'}
              </Btn>
              <a
                href={mailtoUrl}
                className="btn btn-outline"
                style={{
                  textDecoration: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                <Icon.Mail /> Email only
              </a>
              <a
                href={waUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-outline"
                style={{
                  textDecoration: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                <Icon.Arrow /> WhatsApp only
              </a>
            </div>

            <div
              style={{
                background: 'rgba(15,143,74,0.08)',
                border: '1px solid rgba(15,143,74,0.3)',
                borderRadius: 10,
                padding: '12px 14px',
                marginBottom: 14,
              }}
            >
              <div
                style={{
                  fontSize: 10.5,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--teal-deep)',
                  fontFamily: "'Montserrat',sans-serif",
                  fontWeight: 800,
                  marginBottom: 4,
                }}
              >
                What happens next
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink)', lineHeight: 1.5 }}>
                {createdClub.chair.split(' ')[0]} clicks the link, lands on the {createdClub.name}{' '}
                portal and is walked through onboarding → affiliation form → compliance documents →
                CQI self-assessment.
              </div>
            </div>

            <div
              className="row"
              style={{
                justifyContent: 'flex-end',
                gap: 8,
                paddingTop: 6,
                borderTop: '1px solid var(--line)',
              }}
            >
              <Btn tone="ink" onClick={onClose}>
                Done
              </Btn>
            </div>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  // ───────────── Step 1: search + form ─────────────
  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal narrow" style={{ maxWidth: 620 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Cohort · admin tool</div>
            <div className="task-modal-head-title">
              Onboard a <em>new club</em>
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            {remainingKnown.length > 0
              ? "Pick a known club from the list below for a one-click onboard, or type a new club name. If their email or cell is already on file we'll auto-fill the rest."
              : "Type the new club's name, then capture the chairperson's contact details below."}
          </p>

          <div className="field">
            <div className="field-label">
              Club name <span className="req">*</span>
            </div>
            <input
              className="field-input"
              placeholder={
                remainingKnown.length > 0
                  ? 'Search known clubs or type a new name…'
                  : 'Type the club name…'
              }
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (autoFilled && e.target.value !== autoFilled) setAutoFilled(null);
              }}
              autoFocus
            />
          </div>

          {/* Known clubs from past records — tick to bulk-onboard, or click "Use details" to single-pre-fill */}
          {remainingKnown.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 6,
                }}
              >
                <div
                  style={{
                    fontSize: 10.5,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: 'var(--muted-2)',
                    fontFamily: "'Montserrat',sans-serif",
                    fontWeight: 700,
                  }}
                >
                  Known clubs · {filteredKnown.length} of {remainingKnown.length} not yet onboarded
                </div>
                <button
                  type="button"
                  onClick={toggleSelectAll}
                  disabled={filteredKnown.length === 0}
                  style={{
                    fontSize: 11,
                    fontFamily: "'Montserrat',sans-serif",
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                    color: filteredKnown.length === 0 ? 'var(--muted-3)' : 'var(--teal-deep)',
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: filteredKnown.length === 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  {allVisibleSelected ? 'Clear selection' : `Select all (${filteredKnown.length})`}
                </button>
              </div>
              <div
                style={{
                  maxHeight: 240,
                  overflowY: 'auto',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  background: 'var(--paper)',
                }}
              >
                {filteredKnown.length === 0 ? (
                  <div
                    style={{
                      padding: '18px 14px',
                      fontSize: 12.5,
                      color: 'var(--muted)',
                      textAlign: 'center',
                    }}
                  >
                    No known clubs match — type the chair details below to add as a new club.
                  </div>
                ) : (
                  filteredKnown.map((k) => {
                    const isPicked = autoFilled === k.name;
                    const isChecked = selectedKeys.has(k.name);
                    return (
                      <div
                        key={k.name}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 10,
                          padding: '10px 14px',
                          borderBottom: '1px solid var(--line)',
                          background: isChecked
                            ? 'rgba(15,143,74,0.06)'
                            : isPicked
                              ? 'rgba(15,143,74,0.08)'
                              : 'var(--white)',
                          cursor: 'pointer',
                          font: 'inherit',
                        }}
                        onClick={() => toggleSelect(k.name)}
                        onMouseEnter={(e) => {
                          if (!isChecked && !isPicked)
                            e.currentTarget.style.background = 'var(--paper2)';
                        }}
                        onMouseLeave={(e) => {
                          if (!isChecked && !isPicked)
                            e.currentTarget.style.background = 'var(--white)';
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelect(k.name)}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            marginTop: 3,
                            width: 16,
                            height: 16,
                            cursor: 'pointer',
                            flexShrink: 0,
                            accentColor: 'var(--teal-deep)',
                          }}
                        />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div
                            style={{
                              fontFamily: "'Montserrat',sans-serif",
                              fontSize: 13,
                              fontWeight: 700,
                              color: 'var(--ink)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              flexWrap: 'wrap',
                            }}
                          >
                            {k.name}
                            {isPicked && (
                              <span
                                style={{
                                  fontSize: 9.5,
                                  letterSpacing: '0.08em',
                                  textTransform: 'uppercase',
                                  fontWeight: 800,
                                  padding: '1px 7px',
                                  borderRadius: 999,
                                  background: 'rgba(15,143,74,0.15)',
                                  color: 'var(--teal-deep)',
                                  border: '1px solid rgba(15,143,74,0.35)',
                                }}
                              >
                                Pre-filled
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                            {k.chair} · {k.chairEmail} · {k.chairCell}
                          </div>
                          <div
                            style={{
                              fontSize: 10.5,
                              color: 'var(--muted-2)',
                              marginTop: 2,
                              fontFamily: "'Montserrat',sans-serif",
                              letterSpacing: '0.04em',
                            }}
                          >
                            {k.district}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            pickKnown(k);
                          }}
                          style={{
                            fontSize: 11,
                            color: 'var(--teal-deep)',
                            whiteSpace: 'nowrap',
                            fontFamily: "'Montserrat',sans-serif",
                            fontWeight: 600,
                            background: 'transparent',
                            border: 'none',
                            padding: '2px 4px',
                            cursor: 'pointer',
                            flexShrink: 0,
                          }}
                        >
                          Use details →
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {trimmedQuery.length >= 2 && matches.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div
                style={{
                  fontSize: 10.5,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--muted-2)',
                  fontFamily: "'Montserrat',sans-serif",
                  fontWeight: 700,
                  marginBottom: 6,
                }}
              >
                {exact ? 'Already in the cohort' : `Matches in cohort (${matches.length})`}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {matches.slice(0, 5).map((c) => (
                  <div
                    key={c.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 12px',
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                      background:
                        c.name.toLowerCase() === trimmedQuery.toLowerCase()
                          ? 'rgba(216,90,48,0.06)'
                          : 'var(--paper)',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontFamily: "'Montserrat',sans-serif",
                          fontSize: 13,
                          fontWeight: 700,
                          color: 'var(--ink)',
                        }}
                      >
                        {c.name}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                        {c.district} · {c.chair} ·{' '}
                        {c.paid
                          ? 'Affiliated'
                          : c.affiliation === 'in_progress'
                            ? 'In progress'
                            : 'Not started'}
                      </div>
                    </div>
                    {c.name.toLowerCase() === trimmedQuery.toLowerCase() && (
                      <span
                        style={{
                          fontSize: 9.5,
                          letterSpacing: '0.1em',
                          textTransform: 'uppercase',
                          fontWeight: 800,
                          padding: '3px 8px',
                          borderRadius: 999,
                          background: 'rgba(216,90,48,0.12)',
                          color: 'var(--coral)',
                          border: '1px solid rgba(216,90,48,0.35)',
                        }}
                      >
                        Duplicate
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {exact && (
            <div
              style={{
                background: 'rgba(216,90,48,0.06)',
                border: '1px solid rgba(216,90,48,0.3)',
                borderRadius: 10,
                padding: '12px 14px',
                marginBottom: 14,
                fontSize: 12.5,
                color: 'var(--ink)',
                lineHeight: 1.5,
              }}
            >
              <strong>{exact.name}</strong> is already onboarded. Open their detail page to manage
              their existing record instead.
            </div>
          )}

          {showForm && (
            <>
              <div
                style={{
                  fontSize: 10.5,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--muted-2)',
                  fontFamily: "'Montserrat',sans-serif",
                  fontWeight: 700,
                  marginTop: 8,
                  marginBottom: 6,
                }}
              >
                New club details
              </div>
              <div className="field-grid-2">
                <div className="field">
                  <div className="field-label">
                    Chairperson name <span className="req">*</span>
                  </div>
                  <input
                    className="field-input"
                    placeholder="Name &amp; surname"
                    value={chair}
                    onChange={(e) => setChair(e.target.value)}
                  />
                </div>
                <div className="field">
                  <div className="field-label">
                    District <span className="req">*</span>
                  </div>
                  <select
                    className="field-select"
                    value={district}
                    onChange={(e) => setDistrict(e.target.value)}
                  >
                    {DISTRICTS.map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="field-grid-2">
                <div className="field">
                  <div className="field-label">
                    Chair email <span className="req">*</span>
                  </div>
                  <input
                    className="field-input"
                    type="email"
                    placeholder="chair@club.co.za"
                    value={chairEmail}
                    onChange={(e) => handleEmailChange(e.target.value)}
                  />
                </div>
                <div className="field">
                  <div className="field-label">
                    Chair cell <span className="req">*</span>
                  </div>
                  <input
                    className="field-input"
                    placeholder="0XX XXX XXXX"
                    value={chairCell}
                    onChange={(e) => handleCellChange(e.target.value)}
                  />
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, marginBottom: 14 }}>
                Email + cell are used to share the onboarding link on the next screen.
              </div>
            </>
          )}

          <div
            className="row"
            style={{
              justifyContent: 'space-between',
              gap: 10,
              paddingTop: 6,
              borderTop: '1px solid var(--line)',
            }}
          >
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--muted)',
                fontFamily: "'Montserrat',sans-serif",
                fontWeight: 500,
              }}
            >
              {selectedCount > 0
                ? `${selectedCount} club${selectedCount === 1 ? '' : 's'} ticked — bulk onboards them in one go`
                : !trimmedQuery
                  ? remainingKnown.length > 0
                    ? 'Tick clubs above for a bulk onboard, or type a name to add a new one'
                    : 'Type a club name to add it'
                  : exact
                    ? 'Already onboarded — cancel and open their record'
                    : showForm && !canSubmit
                      ? 'Chair contact details are required'
                      : 'Ready — adds the club and reveals the share screen'}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Btn tone="outline" onClick={onClose}>
                Cancel
              </Btn>
              {selectedCount > 0 ? (
                <Btn tone="teal" icon={Icon.Plus} onClick={handleBulkOnboard}>
                  Bulk onboard {selectedCount} club{selectedCount === 1 ? '' : 's'}
                </Btn>
              ) : (
                <Btn tone="teal" icon={Icon.Plus} disabled={!canSubmit} onClick={handleOnboard}>
                  Onboard club
                </Btn>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── EditDeadlineModal — admin edits the 2026/27 submission deadline ───
   Date picker defaults to the current deadline. Save commits the new ISO
   value to AppRoutes state and toasts a confirmation. Reset restores the
   default. The change is visible immediately across the entire UI. */
function EditDeadlineModal({ currentISO, defaultISO, onClose, onSave, toast }) {
  const [value, setValue] = useStateA(currentISO || defaultISO);
  const long = formatDeadlineLong(value);
  const days = daysUntil(value);
  const daysLine =
    days === 0
      ? 'Deadline falls today'
      : days === 1
        ? 'Deadline is 1 day away'
        : `Deadline is ${days} days away`;
  const isPast = (() => {
    if (!value) return false;
    const d = new Date(value + 'T00:00:00');
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return d < t;
  })();

  function save() {
    if (!value) return;
    onSave && onSave(value);
    toast && toast(`Deadline updated · ${long}`);
    onClose && onClose();
  }
  function resetToDefault() {
    setValue(defaultISO);
  }

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal narrow" style={{ maxWidth: 520 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Cohort settings</div>
            <div className="task-modal-head-title">
              Edit <em>submission deadline</em>
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            Change the 2026/27 affiliation, compliance and CQI submission cut-off. The new date will
            update across the homepage, club portal, onboarding flow and every reminder.
          </p>

          <div className="field">
            <div className="field-label">
              New deadline <span className="req">*</span>
            </div>
            <input
              type="date"
              className="field-input"
              value={value || ''}
              onChange={(e) => setValue(e.target.value)}
              style={{ maxWidth: 220 }}
              autoFocus
            />
          </div>

          <div
            style={{
              background: isPast ? 'rgba(216,90,48,0.08)' : 'var(--paper)',
              border: `1px solid ${isPast ? 'rgba(216,90,48,0.4)' : 'var(--line)'}`,
              borderRadius: 10,
              padding: '12px 14px',
              marginTop: 6,
              marginBottom: 18,
            }}
          >
            <div
              style={{
                fontSize: 10.5,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: isPast ? 'var(--coral)' : 'var(--muted-2)',
                fontFamily: "'Montserrat',sans-serif",
                fontWeight: 700,
                marginBottom: 4,
              }}
            >
              Preview
            </div>
            <div
              style={{
                fontFamily: "'Montserrat',sans-serif",
                fontSize: 15,
                fontWeight: 700,
                color: 'var(--ink)',
              }}
            >
              {long || '—'}
            </div>
            <div
              style={{
                fontSize: 12,
                color: isPast ? 'var(--coral)' : 'var(--muted)',
                marginTop: 2,
              }}
            >
              {isPast ? '⚠ This date is in the past — clubs will see “Deadline today”.' : daysLine}
            </div>
          </div>

          <div
            className="row"
            style={{
              justifyContent: 'space-between',
              gap: 10,
              paddingTop: 6,
              borderTop: '1px solid var(--line)',
            }}
          >
            <Btn tone="ghost" onClick={resetToDefault}>
              ↻ Reset to {formatDeadlineShort(defaultISO)}
            </Btn>
            <div className="row" style={{ gap: 8 }}>
              <Btn tone="outline" onClick={onClose}>
                Cancel
              </Btn>
              <Btn tone="teal" icon={Icon.Check} disabled={!value} onClick={save}>
                Save deadline
              </Btn>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── EditSupportContactModal — admin edits the union support contact ───
   Two fields (office name + email), recombined into the "Name · email" string
   on save. The change applies across the whole system (help modal + every
   "email the union" button) for both admin and club logins once /tenant
   refetches. Admin-only, like every other tenant-wide setting. */
function EditSupportContactModal({ current, onClose, onSave, toast }) {
  const init = parseSupport(current);
  const [name, setName] = useStateA(init.name === 'Union office' ? '' : init.name);
  const [email, setEmail] = useStateA(init.email);
  const [busy, setBusy] = useStateA(false);
  const cleanName = name.trim().replace(/·/g, '').trim();
  const cleanEmail = email.trim();
  const emailOk = EMAIL_RE.test(cleanEmail);
  const canSave = !!cleanName && emailOk && !busy;

  function save() {
    if (!canSave) return;
    setBusy(true);
    Promise.resolve(onSave && onSave({ name: cleanName, email: cleanEmail }))
      .then(() => {
        toast && toast(`Support contact updated · ${cleanEmail}`);
        onClose && onClose();
      })
      .catch(() => setBusy(false));
  }

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal narrow" style={{ maxWidth: 520 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Org settings</div>
            <div className="task-modal-head-title">
              Edit <em>support contact</em>
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            The union office name and email shown in the Need Help panel and behind every “Contact
            union” button. Updates apply across the whole portal for every club.
          </p>

          <div className="field">
            <div className="field-label">
              Office name <span className="req">*</span>
            </div>
            <input
              className="field-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Cricket Services"
              autoFocus
            />
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <div className="field-label">
              Support email <span className="req">*</span>
            </div>
            <input
              type="email"
              className="field-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="support@union.co.za"
            />
            {cleanEmail && !emailOk && (
              <div style={{ fontSize: 12, color: 'var(--coral)', marginTop: 6 }}>
                Enter a valid email address.
              </div>
            )}
          </div>

          <div
            style={{
              background: 'var(--paper)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: '12px 14px',
              marginTop: 14,
              marginBottom: 18,
            }}
          >
            <div
              style={{
                fontSize: 10.5,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--muted-2)',
                fontFamily: "'Montserrat',sans-serif",
                fontWeight: 700,
                marginBottom: 4,
              }}
            >
              Preview
            </div>
            <div
              style={{
                fontFamily: "'Montserrat',sans-serif",
                fontSize: 15,
                fontWeight: 700,
                color: 'var(--ink)',
              }}
            >
              {cleanName || '—'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {cleanEmail || 'support@…'}
            </div>
          </div>

          <div
            className="row"
            style={{
              justifyContent: 'flex-end',
              gap: 8,
              paddingTop: 6,
              borderTop: '1px solid var(--line)',
            }}
          >
            <Btn tone="outline" onClick={onClose}>
              Cancel
            </Btn>
            <Btn tone="teal" icon={Icon.Check} disabled={!canSave} onClick={save}>
              Save contact
            </Btn>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── ChairContactModal — admin sets/corrects a club's chairperson contact ───
   Writes name/email/cell into exco.chair (the single source every "email the
   chair" surface reads) and syncs the top-level club.chair string. Lets admins
   repair clubs onboarded before chair contact was persisted, and fix typos /
   chair changes later. Mirrors EditSupportContactModal's EMAIL_RE validation so
   an invalid address can't be saved into a broken mailto:. */
function ChairContactModal({ club, onClose, onSave, toast }) {
  const seed = club.exco?.chair || {};
  const [name, setName] = useStateA(seed.name || club.chair || '');
  const [email, setEmail] = useStateA(seed.email || '');
  const [cell, setCell] = useStateA(seed.cell || '');
  const [busy, setBusy] = useStateA(false);
  const cleanName = name.trim();
  const cleanEmail = email.trim();
  const cleanCell = cell.trim();
  const emailOk = EMAIL_RE.test(cleanEmail);
  const dirty =
    cleanName !== (seed.name || club.chair || '') ||
    cleanEmail !== (seed.email || '') ||
    cleanCell !== (seed.cell || '');
  // Cell is optional — matches buildInitialExco (server), so an admin who only has the
  // chair's email can still record it (the repair use-case is email-centric).
  const canSave = !!cleanName && emailOk && dirty && !busy;

  function save() {
    if (!canSave) return;
    setBusy(true);
    // Resolve(onSave) so a rejected save (e.g. a 409 version conflict surfaced by
    // the parent's withToast) keeps the modal open for retry rather than closing.
    Promise.resolve(onSave && onSave({ name: cleanName, email: cleanEmail, cell: cleanCell }))
      .then(() => {
        toast && toast(`Chairperson updated · ${cleanEmail}`);
        onClose && onClose();
      })
      .catch(() => setBusy(false));
  }

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal narrow" style={{ maxWidth: 520 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Club details</div>
            <div className="task-modal-head-title">
              Edit <em>chairperson</em> · {club.name}
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            The chairperson is this club's primary contact for deadline reminders, the affiliation
            link and "Email chairperson". Used across the portal once the club refetches.
          </p>

          <div className="field">
            <div className="field-label">
              Full name <span className="req">*</span>
            </div>
            <input
              className="field-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Chairperson name"
              autoFocus
            />
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <div className="field-label">
              Email <span className="req">*</span>
            </div>
            <input
              type="email"
              className="field-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="chair@club.co.za"
            />
            {cleanEmail && !emailOk && (
              <div style={{ fontSize: 12, color: 'var(--coral)', marginTop: 6 }}>
                Enter a valid email address.
              </div>
            )}
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <div className="field-label">Cell number</div>
            <input
              className="field-input"
              value={cell}
              onChange={(e) => setCell(e.target.value)}
              placeholder="083 000 0000"
            />
          </div>

          <div
            className="row"
            style={{
              justifyContent: 'flex-end',
              gap: 8,
              paddingTop: 16,
              marginTop: 18,
              borderTop: '1px solid var(--line)',
            }}
          >
            <Btn tone="outline" onClick={onClose}>
              Cancel
            </Btn>
            <Btn tone="teal" icon={Icon.Check} disabled={!canSave} onClick={save}>
              {busy ? 'Saving…' : 'Save chairperson'}
            </Btn>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── PlayerRegLinkModal — V3 future feature, brought forward ───
   Admin generates a per-club registration link, copies / shares it, or
   regenerates it (invalidating the previous token). When a player opens the
   link in the next phase, their data will flow into the cohort automatically. */
function PlayerRegLinkModal({ club, onClose, onRegenerate, toast }) {
  const baseUrl = (typeof window !== 'undefined' && window.location.origin) || '';
  const linkRecord = club.playerRegLink;
  const url = linkRecord ? `${baseUrl}/register/${club.id}?t=${linkRecord.token}` : '';
  const [copied, setCopied] = useStateA(false);

  function doCopy() {
    if (!url) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
        toast && toast('Registration link copied to clipboard');
      });
    } else {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        toast && toast('Registration link copied');
      } catch {}
      ta.remove();
    }
    setTimeout(() => setCopied(false), 2200);
  }

  function emailBody() {
    return `Hi ${club.chair || 'team'},\n\nPlease share this player-registration link with your members so they can register directly into ${club.name} for the 2026/27 season:\n\n${url}\n\nThe link is unique to your club — each registration flows straight into the Dolphins Pipeline cohort.\n\nThe Dolphins office`;
  }
  function whatsappText() {
    return `${club.name} player registration · 2026/27 season: ${url}`;
  }

  const createdLabel = linkRecord
    ? new Date(linkRecord.createdAt).toLocaleString('en-ZA', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  // Normalise the chair's cell into wa.me format (digits only, 0→27)
  function waNumber(cell) {
    const digits = (cell || '').replace(/\D+/g, '');
    if (!digits) return '';
    if (digits.startsWith('0')) return '27' + digits.slice(1);
    if (digits.startsWith('27')) return digits;
    return digits;
  }
  const chairEmailValue = club.exco?.chair?.email || '';
  const chairCellValue = club.exco?.chair?.cell || '';
  const wa = waNumber(chairCellValue);
  const mailtoUrl = `mailto:${chairEmailValue}?subject=${encodeURIComponent(`${club.name} · Player Registration Link`)}&body=${encodeURIComponent(emailBody())}`;
  const waUrl = wa
    ? `https://wa.me/${wa}?text=${encodeURIComponent(whatsappText())}`
    : `https://wa.me/?text=${encodeURIComponent(whatsappText())}`;
  function sendBoth() {
    try {
      window.open(waUrl, '_blank', 'noopener,noreferrer');
    } catch {}
    try {
      window.location.href = mailtoUrl;
    } catch {}
    toast && toast('Player link sent via email & WhatsApp');
  }

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal narrow" style={{ maxWidth: 620 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Phase 03 · Player Registration</div>
            <div className="task-modal-head-title">
              Generate <em>player link</em> · {club.name}
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          {!linkRecord ? (
            <div style={{ textAlign: 'center', padding: '32px 20px' }}>
              <div
                style={{
                  width: 54,
                  height: 54,
                  borderRadius: '50%',
                  margin: '0 auto 14px',
                  background: 'rgba(15,143,74,0.12)',
                  color: 'var(--teal-deep)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon.Form />
              </div>
              <div
                style={{
                  fontFamily: "'Montserrat',sans-serif",
                  fontSize: 14,
                  fontWeight: 700,
                  marginBottom: 6,
                }}
              >
                No registration link yet
              </div>
              <p
                style={{
                  fontSize: 12.5,
                  color: 'var(--muted)',
                  maxWidth: 420,
                  margin: '0 auto 18px',
                }}
              >
                Generate a unique link for{' '}
                <strong style={{ color: 'var(--ink)' }}>{club.name}</strong>. Players opening it
                will register directly into the cohort — their data flows into club statistics and
                roster metrics automatically.
              </p>
              <Btn tone="teal" icon={Icon.Plus} onClick={onRegenerate}>
                Generate link
              </Btn>
            </div>
          ) : (
            <>
              <div
                style={{
                  background: 'var(--paper)',
                  borderRadius: 10,
                  padding: '14px 16px',
                  marginBottom: 14,
                  border: '1px solid var(--line)',
                }}
              >
                <div
                  style={{
                    fontSize: 10.5,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: 'var(--muted-2)',
                    fontFamily: "'Montserrat',sans-serif",
                    fontWeight: 700,
                    marginBottom: 6,
                  }}
                >
                  Registration link
                </div>
                <div
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 13,
                    color: 'var(--ink)',
                    wordBreak: 'break-all',
                    lineHeight: 1.45,
                    padding: '10px 12px',
                    background: 'var(--white)',
                    borderRadius: 8,
                    border: '1px solid var(--line)',
                  }}
                >
                  {url}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                  Created {createdLabel} · token <code>{linkRecord.token}</code>
                </div>
              </div>

              {/* Primary one-click send: fires email + WhatsApp together */}
              <Btn
                tone="teal"
                icon={Icon.Mail}
                onClick={sendBoth}
                style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
              >
                Send via Email + WhatsApp
              </Btn>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 8,
                  marginBottom: 14,
                }}
              >
                <Btn
                  tone={copied ? 'teal' : 'outline'}
                  icon={copied ? Icon.Check : Icon.Form}
                  onClick={doCopy}
                >
                  {copied ? 'Copied' : 'Copy link'}
                </Btn>
                <a
                  href={mailtoUrl}
                  className="btn btn-outline"
                  style={{
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  <Icon.Mail /> Email only
                </a>
                <a
                  href={waUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-outline"
                  style={{
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  <Icon.Arrow /> WhatsApp only
                </a>
              </div>

              <div
                style={{
                  background: 'rgba(200,168,75,0.08)',
                  border: '1px solid rgba(200,168,75,0.35)',
                  borderRadius: 10,
                  padding: '12px 14px',
                  marginBottom: 14,
                }}
              >
                <div
                  style={{
                    fontSize: 10.5,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: 'var(--gold-deep, #8a6e1c)',
                    fontFamily: "'Montserrat',sans-serif",
                    fontWeight: 800,
                    marginBottom: 4,
                  }}
                >
                  Next phase — auto-populate
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink)', lineHeight: 1.5 }}>
                  Player submissions through this link will flow directly into the Dolphins Pipeline
                  cohort. Roster metrics, demographic splits and CQI inputs will update without
                  manual admin entry.
                </div>
              </div>

              <div
                className="row"
                style={{
                  justifyContent: 'space-between',
                  gap: 10,
                  paddingTop: 6,
                  borderTop: '1px solid var(--line)',
                }}
              >
                <Btn tone="ghost" onClick={onRegenerate}>
                  ↻ Regenerate (invalidates old link)
                </Btn>
                <Btn tone="ink" onClick={onClose}>
                  Done
                </Btn>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── ClubLeaguesEditor — admin assigns a club's leagues; one save, not one-per-toggle ─── */
function ClubLeaguesEditor({ club, allLeagues, onSave }) {
  const opts = leagueOptionsForDistrict(allLeagues, club.district);
  const initial = Array.isArray(club.leagues) ? club.leagues : [];
  const [sel, setSel] = useStateA(initial);
  const [busy, setBusy] = useStateA(false);
  // Re-sync local selection when the club's leagues change (e.g. after a save refetch).
  useEffectA(() => {
    setSel(Array.isArray(club.leagues) ? club.leagues : []);
  }, [club.leagues]);

  const orphans = sel.filter((k) => !opts.some((o) => o.key === k));
  const dirty = sel.length !== initial.length || sel.some((k) => !initial.includes(k));
  const toggle = (key) =>
    setSel((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
  const chip = (on, orphan) => ({
    padding: '7px 13px',
    borderRadius: 99,
    cursor: 'pointer',
    fontFamily: "'Montserrat',sans-serif",
    fontSize: 12,
    fontWeight: 600,
    transition: 'all .14s ease',
    border: orphan
      ? '1px dashed var(--muted-3)'
      : on
        ? '1px solid var(--green)'
        : '1px solid var(--line)',
    background: on ? 'var(--green-pale)' : 'var(--white)',
    color: orphan ? 'var(--muted)' : on ? 'var(--green)' : 'var(--ink)',
  });

  if (opts.length === 0 && orphans.length === 0)
    return (
      <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
        No leagues for {club.district} yet — create them on the Leagues page first.
      </div>
    );

  function save() {
    if (!dirty || busy) return;
    setBusy(true);
    Promise.resolve(onSave?.(sel)).finally(() => setBusy(false));
  }

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {opts.map((L) => (
          <button
            key={L.key}
            type="button"
            onClick={() => toggle(L.key)}
            style={chip(sel.includes(L.key), false)}
          >
            {L.label}
          </button>
        ))}
        {orphans.map((k) => (
          <button
            key={k}
            type="button"
            title="No longer in the catalogue — click to remove"
            onClick={() => toggle(k)}
            style={chip(false, true)}
          >
            {k} ✕
          </button>
        ))}
      </div>
      {dirty && (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Btn tone="ghost" size="sm" onClick={() => setSel(initial)} disabled={busy}>
            Reset
          </Btn>
          <Btn tone="teal" size="sm" icon={Icon.Check} onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save leagues'}
          </Btn>
        </div>
      )}
    </>
  );
}

export function AdminClubDetail({
  club,
  gotoList,
  onGenerateLink,
  onSetPaid,
  onInvite,
  toast,
  allLeagues = [],
  onSetLeagues,
  onMarkCompliant,
  onRevertDoc,
  onAddNote,
  onUpdateChair,
}) {
  // Hooks must run unconditionally — keep state before any early return.
  const [showLinkModal, setShowLinkModal] = useStateA(false);
  const [showInvite, setShowInvite] = useStateA(false);
  const [showCqi, setShowCqi] = useStateA(false);
  const [showCompliant, setShowCompliant] = useStateA(false);
  const [showChairEdit, setShowChairEdit] = useStateA(false);
  const [noteText, setNoteText] = useStateA('');
  const [noteBusy, setNoteBusy] = useStateA(false);
  if (!club) return null;
  const dc = docCompletion(club);
  const op = overallProgress(club);
  const band = cqiBand(club.cqi);

  async function handleGenerate() {
    const hadLink = !!club.playerRegLink;
    await (onGenerateLink && onGenerateLink());
    toast &&
      toast(
        hadLink
          ? 'New link issued · previous link is now invalid'
          : 'Registration link generated · ready to share',
      );
  }
  async function openModal() {
    // Await generation so the modal opens with the link present, not an empty
    // value that only fills in after the next refetch.
    if (!club.playerRegLink && onGenerateLink) await onGenerateLink();
    setShowLinkModal(true);
  }
  // Payment is a manual admin action now (payments deferred). Audited server-side.
  function togglePaid() {
    if (!onSetPaid) return;
    onSetPaid(club.id, !club.paid);
    toast && toast(club.paid ? 'Marked as unpaid' : 'Marked as paid');
  }
  function emailChair() {
    const e = club.exco?.chair?.email;
    // No email on file → open the editor so the admin can add it right away,
    // rather than dead-ending on a toast.
    if (!e) {
      toast?.('No chairperson email on file — add one to send mail');
      return setShowChairEdit(true);
    }
    window.location.href = `mailto:${e}?subject=${encodeURIComponent(
      `${club.name} — Smart Club Integration`,
    )}`;
  }
  // Export the persisted affiliation form as a multi-sheet .xlsx (no PDF).
  function downloadAffiliation() {
    const ex = club.exco || {};
    const roleRow = (label, m) =>
      m
        ? {
            Role: label,
            Name: m.name || '',
            Email: m.email || '',
            Cell: m.cell || '',
            Gender: m.gender || '',
            Race: m.race || '',
          }
        : null;
    const excoRows = [
      roleRow('Chairperson', ex.chair),
      roleRow('Secretary', ex.sec),
      roleRow('Treasurer', ex.tre),
      roleRow('Vice-chair', ex.vc),
      ...(Array.isArray(ex.additionalMembers)
        ? ex.additionalMembers.map((m) => roleRow('Member', m))
        : []),
    ].filter(Boolean);
    const leagueRows = (club.leagues || []).map((k) => ({
      Key: k,
      League: allLeagues.find((l) => l.key === k)?.label || k,
    }));
    const coachRows = (club.coaches || []).map((c) => ({
      Name: c.name || '',
      Email: c.email || '',
      Cell: c.cell || '',
      Level: c.level || '',
      Teams: Array.isArray(c.teams) ? c.teams.join(', ') : '',
    }));
    const slug =
      club.id ||
      club.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    exportSheetsToXlsx(`${slug}-affiliation.xlsx`, [
      {
        name: 'Club',
        rows: [
          {
            Name: club.name,
            District: club.district,
            'Sub-union': club.sub,
            Chairperson: club.chair,
            Paid: club.paid ? 'Yes' : 'No',
            Affiliation: club.affiliation,
          },
        ],
      },
      { name: 'Exco', rows: excoRows },
      { name: 'Leagues', rows: leagueRows },
      { name: 'Coaches', rows: coachRows },
      {
        name: 'Ground',
        rows: [
          {
            Venue: club.ground?.venue || '',
            Address: club.ground?.address || '',
            Suburb: club.ground?.suburb || '',
          },
        ],
      },
    ]).catch(() => toast?.('Export failed — please retry'));
  }
  function submitNote() {
    const t = noteText.trim();
    // Guard against double-submit (Enter + click, or rapid Enter): the backend
    // appends via list_append, so each duplicate POST lands as a separate note.
    if (!t || !onAddNote || noteBusy) return;
    setNoteBusy(true);
    onAddNote(t)
      .then(() => {
        setNoteText('');
        toast?.('Note added');
      })
      .catch(() => {})
      .finally(() => setNoteBusy(false));
  }

  const phases = [
    {
      n: '01',
      t: 'Affiliation',
      done: club.paid,
      val: club.paid ? 100 : club.affiliation === 'in_progress' ? 40 : 0,
      detail: club.paid ? 'Submitted · 12 May 2026' : 'Awaiting submission',
    },
    {
      n: '02',
      t: 'League & Fixtures',
      done: club.affiliation === 'complete',
      val: club.affiliation === 'complete' ? 100 : 0,
      detail:
        club.affiliation === 'complete'
          ? `Allocated to ${club.sub === 'EMCU' ? 'EMCU Division 1' : 'District Division'}`
          : 'Pending affiliation',
    },
    {
      n: '03',
      t: 'Player Registration',
      done: club.players >= 30,
      val: Math.min(100, ((club.players || 0) / 60) * 100),
      detail: `${club.players || 0} players registered`,
      future:
        'Auto-populates next phase: direct player-registration links will flow straight into the cohort — no manual admin entry.',
    },
    {
      n: '04',
      t: 'Live Scoring',
      done: false,
      val: club.cqi > 0 ? 25 : 0,
      detail: 'Begins round 1 · 02 Aug 2026',
    },
    {
      n: '05',
      t: 'Compliance',
      done: dc === 100,
      val: dc,
      detail: `${Object.values(club.docs).filter((v) => v).length} of 4 docs uploaded`,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">
            <a onClick={gotoList}>Clubs</a> &nbsp;/&nbsp; {club.name}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 4 }}>
            <ClubAvatar club={club} size={44} />
            <div>
              <h1 className="ph-title" style={{ margin: 0 }}>
                {club.name}
              </h1>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  fontFamily: "'Montserrat',sans-serif",
                  marginTop: 4,
                }}
              >
                {club.district} · {club.sub} · {club.chair}
              </div>
            </div>
          </div>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" icon={Icon.Form} size="sm" onClick={() => setShowChairEdit(true)}>
            Edit chairperson
          </Btn>
          <Btn tone="outline" icon={Icon.Mail} size="sm" onClick={emailChair}>
            Email chairperson
          </Btn>
          <Btn
            tone={club.paid ? 'outline' : 'teal'}
            icon={Icon.Check}
            size="sm"
            onClick={togglePaid}
          >
            {club.paid ? 'Mark unpaid' : 'Mark affiliation paid'}
          </Btn>
        </div>
      </div>

      <div className="kpi-strip">
        <KPI tone="navy" label="Overall progress" num={op + '%'} sub="all phases" />
        <KPI
          tone="teal"
          label="Affiliation"
          num={club.paid ? 'Submitted' : 'Pending'}
          sub={club.paid ? '12 May 2026' : 'Awaiting submission'}
        />
        <KPI
          tone="gold"
          label="Documents"
          num={`${Object.values(club.docs).filter((v) => v).length}/4`}
          sub="compliance docs"
        />
        <KPI
          tone={band.tone === 'coral' ? 'coral' : ''}
          label="CQI score"
          num={club.cqi.toFixed(1)}
          sub={band.label}
        />
        <KPI
          label="Players"
          num={club.players}
          sub={`${club.teams} teams · ${club.juniors} junior`}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
        <div className="stack">
          <Card title="Phase status" sub="Smart Club Integration · 5-phase journey">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {phases.map((p) => (
                <div
                  key={p.n}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '48px 1fr 180px 90px',
                    gap: 14,
                    alignItems: 'center',
                    padding: '10px 12px',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    background: p.done ? 'rgba(15,143,74,0.03)' : 'var(--white)',
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: '50%',
                      background: p.done ? 'var(--teal)' : 'var(--paper2)',
                      color: p.done ? '#fff' : 'var(--muted)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: "'Montserrat',sans-serif",
                      fontSize: 12,
                      fontWeight: 800,
                    }}
                  >
                    {p.done ? <Icon.Check /> : p.n}
                  </div>
                  <div>
                    <div
                      style={{
                        fontFamily: "'Montserrat',sans-serif",
                        fontSize: 13,
                        fontWeight: 700,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      {p.t}
                      {p.future && (
                        <span
                          style={{
                            fontSize: 9.5,
                            letterSpacing: '0.1em',
                            textTransform: 'uppercase',
                            fontWeight: 800,
                            padding: '2px 7px',
                            borderRadius: 999,
                            background: 'rgba(200,168,75,0.18)',
                            color: 'var(--gold-deep, #8a6e1c)',
                            border: '1px solid rgba(200,168,75,0.45)',
                          }}
                        >
                          Next phase
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--muted)',
                        fontFamily: "'Montserrat',sans-serif",
                        marginTop: 2,
                      }}
                    >
                      {p.detail}
                    </div>
                    {p.future && (
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--gold-deep, #8a6e1c)',
                          fontFamily: "'Montserrat',sans-serif",
                          marginTop: 4,
                          fontStyle: 'italic',
                          lineHeight: 1.4,
                        }}
                      >
                        ↗ {p.future}
                      </div>
                    )}
                    {/* Player Registration phase has a live action — generate the link admins share with clubs */}
                    {p.n === '03' && (
                      <div style={{ marginTop: 8 }}>
                        <Btn tone="teal" size="sm" icon={Icon.Plus} onClick={openModal}>
                          {club.playerRegLink
                            ? 'View / share registration link'
                            : 'Generate registration link'}
                        </Btn>
                        {club.playerRegLink && (
                          <span
                            style={{
                              marginLeft: 10,
                              fontSize: 10.5,
                              color: 'var(--teal-deep)',
                              fontFamily: "'Montserrat',sans-serif",
                              letterSpacing: '0.06em',
                              textTransform: 'uppercase',
                              fontWeight: 700,
                            }}
                          >
                            ● Link active
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <ProgressBar value={p.val} tone={p.done ? 'teal' : 'gold'} />
                  <div
                    style={{
                      textAlign: 'right',
                      fontFamily: "'Montserrat',sans-serif",
                      fontSize: 12,
                      color: 'var(--ink)',
                      fontWeight: 500,
                    }}
                  >
                    {Math.round(p.val)}%
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card
            title="Compliance documents"
            sub="Cricket Services 2026/27 club requirements upload"
          >
            {REQUIRED_DOCS.map((d) => {
              const up = club.docs[d.key];
              // Real uploads carry docMeta with an objectKey; an admin "Mark as
              // compliant" override sets the flag true with a markedCompliant
              // sentinel (no file). Never fabricate a filename for the latter.
              const meta = club.docMeta?.[d.key];
              const real = !!(meta && meta.objectKey);
              const override = up && !real;
              const fileName = real ? String(meta.objectKey).split('/').pop() : null;
              const uploadedDate =
                real && meta.uploadedAt
                  ? new Date(meta.uploadedAt).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })
                  : null;
              const sizeMB = real && meta.size ? `${(meta.size / 1e6).toFixed(1)} MB` : null;
              return (
                <div key={d.key} className={`doc-row ${up ? 'uploaded' : ''}`}>
                  <div className="doc-icon">
                    <Icon.Doc />
                  </div>
                  <div className="doc-info">
                    <div className="doc-name">
                      {d.name}
                      {!up && <span className="doc-required-tag">Required</span>}
                    </div>
                    <div className="doc-meta">
                      {real
                        ? [fileName, uploadedDate && `uploaded ${uploadedDate}`, sizeMB]
                            .filter(Boolean)
                            .join(' · ')
                        : override
                          ? 'Marked compliant — no file on record'
                          : 'Not yet uploaded · awaiting club'}
                    </div>
                  </div>
                  {up ? (
                    <div className="doc-row-actions">
                      <Pill tone={override ? 'gold' : 'teal'} dot>
                        {override ? 'Override' : 'Approved'}
                      </Pill>
                      {/* Override = compliant with no file on record; offer a
                          lossless revert back to Missing. Real uploads (Approved)
                          never show this — their file can't be reverted away. */}
                      {override && onRevertDoc && (
                        <Btn
                          tone="ghost"
                          size="sm"
                          onClick={() => onRevertDoc(d.key)}
                          title="Remove this override — sets the document back to Missing"
                        >
                          Revert
                        </Btn>
                      )}
                    </div>
                  ) : (
                    <Pill tone="coral" dot>
                      Missing
                    </Pill>
                  )}
                </div>
              );
            })}
          </Card>

          <Card title="CQI breakdown" sub="Per-category contribution to overall score">
            {club.cqi === 0 ? (
              <div
                style={{
                  textAlign: 'center',
                  padding: '28px 0',
                  color: 'var(--muted)',
                  fontSize: 13,
                }}
              >
                CQI form not yet submitted by this club.
              </div>
            ) : (
              <div className="score-grid" style={{ marginBottom: 0 }}>
                {CQI_STRUCTURE.map((cat) => {
                  // Real per-category score from the club's stored answers (falls
                  // back to a proportional estimate only for legacy clubs that have
                  // a score but no persisted answers).
                  const byCat = club.cqiAnswers ? scoreCQI(club.cqiAnswers).byCat : null;
                  const score = byCat
                    ? byCat[cat.key].earned
                    : Math.min(cat.weight, cat.weight * Math.min(1, club.cqi / 100));
                  return (
                    <div
                      key={cat.key}
                      className="score-card"
                      style={{ '--fill': (score / cat.weight) * 100 + '%', '--accent': cat.accent }}
                    >
                      <div>
                        <span className="sc-cat">{cat.title}</span>
                        <span className="sc-w">{cat.weight} pts</span>
                      </div>
                      <div className="sc-num">{score.toFixed(1)}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="Club details">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 18px' }}>
              {[
                ['District', club.district],
                ['Sub-union', club.sub],
                ['Chairperson', club.chair],
                ['Status', club.paid ? 'Active member' : 'Pending'],
                ['Senior teams', club.teams],
                ["Women's teams", club.women],
                ['Junior teams', club.juniors],
                ['Players', club.players],
              ].map(([k, v], i) => (
                <div key={i}>
                  <div
                    style={{
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: '0.1em',
                      color: 'var(--muted-2)',
                      marginBottom: 3,
                    }}
                  >
                    {k}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 500 }}>{v}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Leagues" sub="Competitions this club is registered for">
            <ClubLeaguesEditor club={club} allLeagues={allLeagues} onSave={onSetLeagues} />
          </Card>

          <Card title="Communication log">
            <div className="stack" style={{ gap: 8 }}>
              {(() => {
                // Real, user-inputted communication: admin-added notes (newest first).
                const notes = [...(club.notes || [])].reverse().map((n) => ({
                  tone: 'navy',
                  t: n.text,
                  d: `${new Date(n.at).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })} · ${n.author}`,
                }));
                // Seeded illustrative events are demo-only — real clubs show just their notes.
                const demoEvents = club.demo
                  ? [
                      {
                        tone: 'teal',
                        t: 'Affiliation invitation sent',
                        d: '03 May 2026 · auto-system',
                      },
                      { tone: 'navy', t: 'Login link emailed to chair', d: '05 May 2026' },
                      { tone: 'gold', t: 'Reminder — CQI form pending', d: '15 May 2026' },
                      {
                        tone: 'teal',
                        t: 'AGM document uploaded',
                        d: '18 May 2026 · by chair',
                        off: !club.docs.agm,
                      },
                    ].filter((x) => !x.off)
                  : [];
                const entries = [...notes, ...demoEvents];
                if (!entries.length)
                  return (
                    <div style={{ fontSize: 12.5, color: 'var(--muted-2)', padding: '8px 0' }}>
                      No communication logged yet. Add a note below to start the log.
                    </div>
                  );
                return entries.map((m, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'start',
                      gap: 10,
                      padding: '8px 0',
                      borderBottom: '1px solid var(--line2)',
                    }}
                  >
                    <span className={`sdot ${m.tone}`} style={{ marginTop: 6 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12.5, color: 'var(--ink)' }}>{m.t}</div>
                      <div
                        style={{
                          fontSize: 10.5,
                          color: 'var(--muted-2)',
                          fontFamily: "'Montserrat',sans-serif",
                          marginTop: 2,
                        }}
                      >
                        {m.d}
                      </div>
                    </div>
                  </div>
                ));
              })()}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <input
                className="field-input"
                placeholder="New note / reminder…"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitNote()}
                style={{ flex: 1, fontSize: 13 }}
              />
              <Btn
                tone="outline"
                size="sm"
                icon={Icon.Plus}
                onClick={submitNote}
                disabled={noteBusy || !noteText.trim()}
              >
                Add
              </Btn>
            </div>
          </Card>

          <Card title="Quick actions">
            <div className="stack" style={{ gap: 6 }}>
              <Btn tone="ink" icon={Icon.Mail} onClick={() => setShowInvite(true)}>
                Invite club rep
              </Btn>
              <Btn
                tone="outline"
                icon={Icon.Eye}
                onClick={() =>
                  club.cqi === 0 ? toast?.('No CQI form submitted yet') : setShowCqi(true)
                }
              >
                View submitted CQI form
              </Btn>
              <Btn tone="outline" icon={Icon.Download} onClick={downloadAffiliation}>
                Download affiliation form
              </Btn>
              <Btn tone="outline" icon={Icon.Shield} onClick={() => setShowCompliant(true)}>
                Mark as compliant
              </Btn>
            </div>
          </Card>
        </div>
      </div>

      {showLinkModal && (
        <PlayerRegLinkModal
          club={club}
          onClose={() => setShowLinkModal(false)}
          onRegenerate={handleGenerate}
          toast={toast}
        />
      )}
      {showInvite && (
        <InviteRepModal
          club={club}
          onClose={() => setShowInvite(false)}
          onInvite={onInvite}
          toast={toast}
        />
      )}
      {showCqi && <CqiViewModal club={club} onClose={() => setShowCqi(false)} />}
      {showCompliant && (
        <ConfirmModal
          title="Mark all documents compliant?"
          body="This overrides the four compliance documents as present for this club — without an uploaded file on record. Use only when you've verified compliance offline."
          confirmLabel="Mark compliant"
          onConfirm={() => {
            setShowCompliant(false);
            onMarkCompliant && onMarkCompliant();
          }}
          onClose={() => setShowCompliant(false)}
        />
      )}
      {showChairEdit && (
        <ChairContactModal
          club={club}
          toast={toast}
          onClose={() => setShowChairEdit(false)}
          onSave={(c) => Promise.resolve(onUpdateChair?.(c)).then(() => setShowChairEdit(false))}
        />
      )}
    </div>
  );
}

/* ─── ConfirmModal — lightweight confirm dialog matching the task-modal styling ─── */
function ConfirmModal({ title, body, confirmLabel = 'Confirm', onConfirm, onClose }) {
  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal narrow" style={{ maxWidth: 440 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-title">{title}</div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <p style={{ fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.55, margin: 0 }}>{body}</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
            <Btn tone="outline" size="sm" onClick={onClose}>
              Cancel
            </Btn>
            <Btn tone="ink" size="sm" onClick={onConfirm}>
              {confirmLabel}
            </Btn>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── CqiViewModal — read-only view of a club's submitted CQI self-assessment ─── */
function CqiViewModal({ club, onClose }) {
  const answers = club.cqiAnswers || {};
  const band = cqiBand(club.cqi);
  // Legacy/seeded clubs can carry a score with no itemised answers (answer capture
  // post-dates them). Show an honest empty state instead of a grid of dashes.
  const hasAnswers = Object.keys(answers).length > 0;
  // Render each answer by its question kind so booleans, counts, percentages,
  // choices and money all read correctly (iterate the structure, not the answers,
  // so nothing is orphaned).
  const fmt = (q) => {
    const v = answers[q.key];
    if (v == null || v === '') return '—';
    if (q.kind === 'yn') return v ? 'Yes' : 'No';
    if (q.kind === 'pct') return `${v}%`;
    if (q.kind === 'money') return `${q.currency || 'R'} ${Number(v).toLocaleString()}`;
    return String(v);
  };
  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal" style={{ maxWidth: 620 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Submitted CQI · {club.name}</div>
            <div className="task-modal-head-title">
              CQI <em>self-assessment</em> · {band.label}
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          {!hasAnswers ? (
            <div style={{ textAlign: 'center', padding: '28px 8px', color: 'var(--muted)' }}>
              <p style={{ fontSize: 14, color: 'var(--ink)', margin: 0 }}>
                Score on record: <strong>{band.label}</strong>
              </p>
              <p style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.5 }}>
                This club&apos;s CQI score was recorded before itemised answers were captured, so
                there are no per-question responses to display.
              </p>
            </div>
          ) : (
            <div className="stack" style={{ gap: 16 }}>
              {CQI_STRUCTURE.map((cat) => (
                <div key={cat.key}>
                  <div
                    style={{
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      color: 'var(--muted-2)',
                      marginBottom: 6,
                      fontWeight: 700,
                    }}
                  >
                    {cat.title}
                  </div>
                  <div className="stack" style={{ gap: 4 }}>
                    {cat.questions.map((q) => (
                      <div
                        key={q.key}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: 12,
                          fontSize: 12.5,
                          padding: '4px 0',
                          borderBottom: '1px solid var(--line2)',
                        }}
                      >
                        <span style={{ color: 'var(--muted)' }}>{q.label}</span>
                        <span
                          style={{ color: 'var(--ink)', fontWeight: 600, whiteSpace: 'nowrap' }}
                        >
                          {fmt(q)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── InviteRepModal — admin invites a rep/admin to this tenant ─── */
function InviteRepModal({ club, onClose, onInvite, toast }) {
  const [email, setEmail] = useStateA('');
  const [role, setRole] = useStateA('rep');
  const [busy, setBusy] = useStateA(false);
  const [done, setDone] = useStateA(false);

  async function submit() {
    if (!email.trim() || !onInvite) return;
    setBusy(true);
    try {
      // A rep is scoped to this club; an admin sees the whole tenant.
      await onInvite({
        email: email.trim().toLowerCase(),
        role,
        clubIds: role === 'rep' ? [club.id] : [],
      });
      setDone(true);
      toast && toast(`Invite sent to ${email.trim()}`);
    } catch {
      /* withToast already surfaced the error */
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal narrow" style={{ maxWidth: 480 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Invite · {club.name}</div>
            <div className="task-modal-head-title">
              Invite a <em>club rep</em>
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          {done ? (
            <div style={{ textAlign: 'center', padding: '18px 0' }}>
              <p style={{ fontSize: 14, color: 'var(--ink)' }}>
                Invite sent to <strong>{email}</strong>.
              </p>
              <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>
                They sign in with their email — a one-time code is sent on first login. No password
                needed.
              </p>
              <div style={{ marginTop: 16 }}>
                <Btn tone="ink" size="sm" onClick={onClose}>
                  Done
                </Btn>
              </div>
            </div>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              <label style={{ fontSize: 12, color: 'var(--muted)' }}>
                Email
                <input
                  className="field-input"
                  type="email"
                  autoFocus
                  placeholder="rep@club.co.za"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{ width: '100%', marginTop: 4, fontSize: 16 }}
                />
              </label>
              <label style={{ fontSize: 12, color: 'var(--muted)' }}>
                Role
                <select
                  className="field-select"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  style={{ width: '100%', marginTop: 4 }}
                >
                  <option value="rep">Club rep — {club.name} only</option>
                  <option value="admin">Administrator — whole union</option>
                </select>
              </label>
              <Btn tone="teal" icon={Icon.Mail} disabled={busy || !email.trim()} onClick={submit}>
                {busy ? 'Sending…' : 'Send invite'}
              </Btn>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

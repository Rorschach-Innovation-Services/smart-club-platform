/* ─── Admin views ─── */

import { useState as useStateA, useMemo as useMemoA, useEffect as useEffectA, useId } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useQueries } from '@tanstack/react-query';
import * as api from './api';
import { qk } from './query';
import { useCopy } from './branding';
import {
  PlayerFilterBar,
  FilterResultCount,
  filterPlayers,
  hasActiveFilters,
  emptyPlayerFilters,
} from './playerFilters';
import { filterClearances } from './clearanceFilters';
import {
  DISTRICTS,
  DEFAULT_REQUIRED_DOCS,
  activeDocs,
  docMinFiles,
  CQI_STRUCTURE,
  effectiveAnswers,
  genuineCqiAnswers,
  deriveGovernance,
  governanceOverrides,
  SUBMISSION_DEADLINE_DEFAULT,
  cohortStats,
  docFileMeta,
  safeguardingMeta,
  agmMeta,
  docCompletion,
  docsUploadedCount,
  docsAllComplete,
  overallProgress,
  affiliationSubmitted,
  fixtureCost,
  DEFAULT_COST_PER_KM,
  DEFAULT_CARS,
  generateRoundRobin,
  resolveSpread,
  resolveTeam,
  teamIdsForClub,
  distinctClubCount,
  formatDeadlineLong,
  formatDeadlineShort,
  formatDeadlineMid,
  daysUntil,
  daysAgo,
  relTimeAgo,
  buildRecentActivity,
  ageFromSaId,
  termRemaining,
} from './data';
import {
  leagueOptionsForDistrict,
  optionsGroupedByGroup,
  findByKey,
  slugifyLeagueKey,
  labelByKey,
  teamCounts,
  clubTeamsForLeague,
  OVERARCHING_DISTRICT,
} from './leagues';
import {
  CADENCE_LABELS,
  T20_SLOTS,
  WEEKDAY_LABELS,
  cadenceFromLabel,
  calendarSpan,
  describeCadence,
  formatIsoDate,
  isActivated,
  isValidIsoDate,
  planRoundDates,
  todayIso,
} from './competition/calendar';
import { fixturesFromPlan, legacyRoundDates, roundsForTeamCount } from './competition/fixtures';
import {
  fixtureVenueCoords as fixtureVenue,
  isLocked,
  VENUE_REASON_PREFIX,
} from './competition/venues';
import { DEFAULT_SERIES_OVERS, isSlotRef, SERIES_TYPES, slotRefLabel } from './competition/formats';
import type {
  AdminClearanceView,
  Cadence,
  Club,
  League,
  SeasonCalendar,
  SeasonRun,
  Series,
  TimeSlot,
  Venue,
  Weekday,
  WithheldField,
} from './types';
import { SeasonRunsPanel, GenerateFixturesLauncher } from './season-run';
import { VenuesCard } from './venues-card';
import { cqiBandTone, cqiBandRows, docComplianceRows, docTone } from './insights';
import {
  formatDay,
  formatDayYear,
  formatStamp,
  formatStampDay,
  formatTime,
  formatWeekdayDay,
  formatWeekdayDayYear,
} from './dates';
import { exportRowsToXlsx, exportSheetsToXlsx, clubExportRow, playerExportRow } from './exportXlsx';
import { Sentry } from './sentry';
import { openBccReminder } from './mailto';
import { EMAIL_RE } from './api';
import { parseSupport } from './support';
import { DocPreviewModal } from './DocPreviewModal';
import { PlayerDetailModal } from './PlayerDetailModal';
import { RegLinkModal } from './RegLinkModal';
import { ReleaseDialog } from './ReleaseDialog';
import { ClubNameModal } from './ClubNameModal';
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
  Rating,
  NumSlider,
  CountInput,
  MoneyInput,
  CountUp,
  statusFor,
  affPill,
  cqiBand,
  scoreCQI,
  useEscapeClose,
  playerStatusPill,
  InfoDot,
  ScrollX,
} from './atoms';

/* A compact marker for why a fixture is off its home ground. The full `venueReason`
   already reads in the suburb line; this is the at-a-glance pill (full reason on hover).
   Only the operator-facing moves get a pill — a plain allocated ground or a Union T20
   slot is the normal case and gets none. Prefixes match what the allocator/import write
   (see competition/venues.ts and packages/api/src/import-planb-fixtures.ts). */
function venueReasonPill(reason?: string, status?: string): string | null {
  if (!reason || status === 'home') return null;
  if (reason.startsWith(VENUE_REASON_PREFIX.movedToAvoid)) return 'moved';
  if (reason.startsWith(VENUE_REASON_PREFIX.unionDirective)) return 'directive';
  if (reason.startsWith(VENUE_REASON_PREFIX.homeNoGround)) return 'no ground';
  return null; // allocatedGround, unionT20, anything else → no pill
}

/* The at-a-glance pill for why a fixture is off its home ground (full reason on hover).
   The styles live in the `.fix-venue-reason` rule (index.html) so the row markup carries
   no per-row inline style object. */
function VenueReasonPill({ reason, status }: { reason?: string; status?: string }) {
  const pill = venueReasonPill(reason, status);
  if (!pill) return null;
  return (
    <span className="fix-venue-reason" title={reason}>
      {pill}
    </span>
  );
}

/* ─── AdminFixtures — series cards + drilldown fixture table with distance + travel-cost ─── */
interface AdminFixturesProps {
  clubs: Club[];
  // `Series.fixtures` is `unknown[]` (frontend strict ratchet, deferred) and this
  // long-standing function accesses fixture fields freely with no casts — typing this
  // `Series[]` cascades unrelated fallout across the whole file. Left loose, like the
  // rest of AdminFixtures' pre-existing untyped props; only the seam this change
  // actually touches (`onSubmitSeries`) is deliberately typed below.
  allSeries;
  /** The real POST handler (with toast) — the launcher's series step awaits this before
   *  closing, so a rejection leaves the embedded form open with inputs intact. Renamed
   *  (not just re-typed) from `onCreateSeries` so a stale call site still passing the old
   *  `(leagueKey) => void` routing shape fails to compile instead of silently no-oping. */
  onSubmitSeries: (series) => Promise<void>;
  onUpdateSeries;
  onDeleteSeries;
  onDuplicateSeries;
  onSetReleased;
  /** Reveal one or more withheld fields on a released series (ADR 0011). */
  onReveal?: (id: string, fields: WithheldField[]) => Promise<unknown> | void;
  onSetApproved;
  toast: (message: string, tone?: string) => void;
  allCalendars?: SeasonCalendar[];
  allSeasonRuns?: SeasonRun[];
  allVenues?: Venue[];
  venuesFailed?: boolean;
  structuresFailed?: boolean;
  seasonRunsFailed?: boolean;
  seasonSetupLoading?: boolean;
  onSaveVenue?;
  onDeleteVenue?;
  onAllocateVenues?;
  // Same reasoning as `allSeries` — the fallback literal at the launcher call site
  // (`{ structures: [], calendars: [] }`) is not a full TenantConfig, and never was.
  tenantConfig?;
  allLeagues?: League[];
  onCreateSeasonRun?;
  onPatchSeasonRun?;
  onDeleteSeasonRun?;
  onGenerateStageSeries?;
}

// Export row shape shared by the per-series and whole-season exports — the same
// columns the union's own fixture workbooks use, plus the venue note so relocated
// fixtures carry their "why" (allocator reason / clash move) into the spreadsheet.
// Clubs without geocoded grounds can't have distance/travel computed (haversine
// returns 0) — emit '—' rather than a misleading 0. Hoisted to module level so the
// on-platform SeasonViewer renders exactly the rows the xlsx export writes.
export function seriesScheduleRows(s: Series, clubs: Club[]) {
  const clubBy = (id) => clubs.find((c) => c.id === id);
  const fixtures = s.fixtures as any[];
  // "Time TBC" is only meaningful once the series has at least one timed fixture —
  // otherwise every series that never uses times (most of them) would export a
  // column full of noise instead of a clean blank.
  const seriesHasTimes = fixtures.some((f) => !!formatTime(f.time));
  return fixtures.map((f) => {
    const home = resolveTeam(s, f.home, clubBy),
      away = resolveTeam(s, f.away, clubBy);
    const hasGeo =
      home?.ground?.lat != null &&
      home?.ground?.lon != null &&
      away?.ground?.lat != null &&
      away?.ground?.lon != null;
    const cost =
      home && away
        ? fixtureCost(home, away, (s as any).costPerKm, (s as any).carsPerAwayTrip, fixtureVenue(f))
        : null;
    // The slot label ('Morning'/'Afternoon') alongside the raw kickoff time when the
    // series' schedule carries named slots — trivially available off `schedule.slots`,
    // so worth including, but the time itself is what matters and stands alone without it.
    const time = formatTime(f.time);
    const slotLabel = s.schedule?.slots?.find((sl) => sl.start === f.time)?.label;
    return {
      Round: f.round,
      Date: formatWeekdayDayYear(f.date),
      Time: time ? (slotLabel ? `${time} (${slotLabel})` : time) : seriesHasTimes ? 'Time TBC' : '',
      Home: home?.name || 'TBD',
      Venue: f.venueOverride || f.venueName || home?.ground?.venue || '—',
      'Venue note': f.venueStatus && f.venueStatus !== 'home' ? f.venueReason || '' : '',
      Suburb: home?.ground?.suburb || '',
      Away: away?.name || 'TBD',
      'Distance (km)': hasGeo && cost ? Number(cost.distanceKm.toFixed(1)) : '—',
      'Travel (R)': hasGeo && cost ? Math.round(cost.fuelR) : '—',
      Status: f.status || 'scheduled',
    };
  });
}

export const SCHEDULE_COLS = [
  'Round',
  'Date',
  'Time',
  'Home',
  'Venue',
  'Venue note',
  'Suburb',
  'Away',
  'Distance (km)',
  'Travel (R)',
  'Status',
] as const;

// Whole-season summary: one row per competition — the cover sheet of the season export
// and the summary table of the on-platform viewer. Row objects carry no series id, so
// callers that need to key rows zip them with `allSeries` by index.
export function seasonSummaryRows(allSeries: Series[]) {
  return allSeries.map((s) => {
    const dates = (s.fixtures as any[]).map((f) => f.date).sort();
    return {
      Competition: s.name,
      Fixtures: s.fixtures.length,
      Sides: s.teams?.length ?? '',
      From: dates.length ? formatWeekdayDayYear(dates[0]) : '',
      To: dates.length ? formatWeekdayDayYear(dates[dates.length - 1]) : '',
      Status: s.released ? 'Released' : s.approved ? 'Approved (draft)' : 'Draft',
    };
  });
}

export function AdminFixtures({
  clubs,
  allSeries,
  onSubmitSeries,
  onUpdateSeries,
  onDeleteSeries,
  onDuplicateSeries,
  onSetReleased,
  onReveal,
  onSetApproved,
  toast,
  allCalendars = [],
  allSeasonRuns = [],
  allVenues = [],
  venuesFailed = false,
  structuresFailed = false,
  seasonRunsFailed = false,
  seasonSetupLoading = false,
  onSaveVenue,
  onDeleteVenue,
  onAllocateVenues,
  tenantConfig,
  allLeagues = [],
  onCreateSeasonRun,
  onPatchSeasonRun,
  onDeleteSeasonRun,
  onGenerateStageSeries,
}: AdminFixturesProps) {
  const copy = useCopy();
  // The single "Generate fixtures" entry point — the league picked here decides whether
  // the admin lands in StartSeasonForm or the flat CreateSeriesForm. Owned here, not in
  // SeasonRunsPanel, so its own "Start a season" button and the header button can share it.
  const [launcherOpen, setLauncherOpen] = useStateA(false);
  const [viewerOpen, setViewerOpen] = useStateA(false);
  const [activeId, setActiveId] = useStateA(allSeries[0]?.id);
  const active = allSeries.find((s) => s.id === activeId) || allSeries[0];
  const [confirm, setConfirm] = useStateA(null); // shared confirmation modal state (recall/reveal)
  const [releaseFor, setReleaseFor] = useStateA(null); // series whose ReleaseDialog is open
  const clubBy = (id) => clubs.find((c) => c.id === id);
  // Resolve a fixture id → team (series participant). A single-team club resolves to
  // itself; a multi-team club's `tm_…` id resolves via the series snapshot.
  const teamBy = (s, id) => resolveTeam(s, id, clubBy);

  // Aggregate distance + fuel per series
  const seriesAgg = (s) => {
    let totalKm = 0,
      totalCost = 0;
    s.fixtures.forEach((f) => {
      const home = teamBy(s, f.home),
        away = teamBy(s, f.away);
      if (!home.clubId || !away.clubId) return;
      const c = fixtureCost(home, away, s.costPerKm, s.carsPerAwayTrip, fixtureVenue(f));
      totalKm += c.roundTripKm;
      totalCost += c.fuelR;
    });
    return { totalKm, totalCost };
  };

  function exportSchedule(s: Series) {
    if (!s) return toast?.('No series to export');
    const fname = `${s.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')}-schedule.xlsx`;
    exportRowsToXlsx(fname, 'Schedule', seriesScheduleRows(s, clubs)).catch(() =>
      toast?.('Export failed — please retry'),
    );
  }

  // Whole-season export: one workbook, a summary cover sheet plus one sheet per
  // competition — the same structure the union's own fixture workbooks use, so the
  // file can go straight to them (or to clubs) for review and sign-off.
  function exportSeason() {
    if (!allSeries.length) return toast?.('No series to export');
    // Excel: sheet names max 31 chars, no []:*?/\ — sanitise and dedupe. Seeded with the
    // cover sheet's own name so a competition literally called "Season summary" can't
    // collide with it.
    const used = new Set<string>(['Season summary']);
    const sheetName = (name: string) => {
      const base = name
        .replace(/[[\]:*?/\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 31);
      const stem = base || 'Series';
      let candidate = stem;
      let n = 2;
      while (used.has(candidate)) candidate = `${stem.slice(0, 28)} ${n++}`;
      used.add(candidate);
      return candidate;
    };
    const summary = seasonSummaryRows(allSeries);
    const sheets = [
      { name: 'Season summary', rows: summary },
      ...allSeries.map((s) => ({ name: sheetName(s.name), rows: seriesScheduleRows(s, clubs) })),
    ];
    exportSheetsToXlsx(
      `season-fixtures-${new Date().toISOString().slice(0, 10)}.xlsx`,
      sheets,
    ).catch(() => toast?.('Export failed — please retry'));
  }

  // Release opens the ReleaseDialog (where venues/times can be withheld); recall and
  // reveal use the shared .fix-confirm modal. Used by header, card, and bottom bar.
  function askRelease(s) {
    setReleaseFor(s);
  }
  function askRecall(s) {
    setConfirm({
      title: 'Recall this release?',
      body: 'Clubs will no longer see this schedule in their portals. No notification is sent. Any withheld venues or times are cleared — you choose again next time you release.',
      danger: true,
      yesLabel: 'Yes, recall',
      onYes: () => {
        // Mirror the release path: chain the "recalled" toast off success only. setReleased
        // (main.tsx) no longer swallows rejections, so a 409/5xx would otherwise fire a false
        // success toast and leave an unhandled rejection — withToast already surfaced the error.
        Promise.resolve(onSetReleased(s.id, false))
          .then(() => toast?.(s.name + ' · recalled to draft'))
          .catch(() => {});
        setConfirm(null);
      },
    });
  }
  // Reveal a withheld field (venue/time) to every club — whole series, irreversible
  // without recalling. Confirmed through the shared modal, then dispatched to the API.
  function reveal(s, field: 'venue' | 'time') {
    const noun = field === 'venue' ? 'venues' : 'times';
    setConfirm({
      title: `Reveal ${noun} to all clubs?`,
      body:
        field === 'venue'
          ? `Every club in ${s.name} will see the allocated grounds, distance and travel cost immediately. This can't be withdrawn without recalling the whole release.`
          : `Every club in ${s.name} will see the start times immediately. This can't be withdrawn without recalling the whole release.`,
      yesLabel: field === 'venue' ? 'Reveal venues' : 'Reveal times',
      onYes: () => {
        Promise.resolve(onReveal?.(s.id, [field]))
          .then(() => toast?.(s.name + ' · ' + noun + ' revealed'))
          .catch(() => {});
        setConfirm(null);
      },
    });
  }
  function approve(s) {
    onSetApproved?.(s.id, true)?.then?.(() => toast?.(s.name + ' · approved — ready to release'));
  }
  function unapprove(s) {
    onSetApproved?.(s.id, false)?.then?.(() => toast?.(s.name + ' · approval withdrawn'));
  }

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">{copy.crumbRoot} · Admin Console / Fixtures &amp; Venues</div>
          <h1 className="ph-title">
            Fixtures &amp; <em>Venues</em>
          </h1>
          <p className="ph-desc">
            Every league runs a season — structured stage by stage once your platform operator has
            bound a competition (operator console → Season setup, or the Structures card), a flat
            round robin otherwise — plus ad-hoc series for one-off fixtures. Home venues flow from
            the affiliation form. Travel distance and fuel cost are calculated for every away
            fixture.
          </p>
        </div>
        <div className="ph-actions">
          <InfoDot title="Fixture actions" align="end">
            <p>
              <strong>Generate fixtures</strong> — build a season’s schedule stage by stage, or a
              flat/ad-hoc series.
            </p>
            <p>
              <strong>Approve</strong> — sign the active series off internally. Nothing is published
              yet; this just unlocks Release.
            </p>
            <p>
              <strong>Release to clubs</strong> — publish it to every club’s portal. No email or
              WhatsApp is sent; each club chooses when to share fixtures with its players. You can
              withhold venues and/or start times at release and reveal them later.
            </p>
            <p>
              <strong>Recall / Withdraw</strong> — pull a released or approved series back. No
              notification is sent.
            </p>
            <p>
              <strong>View season</strong> — open every competition’s schedule on screen, with
              spreadsheet downloads inside the viewer.
            </p>
          </InfoDot>
          <Btn tone="outline" icon={Icon.Eye} size="sm" onClick={() => setViewerOpen(true)}>
            View season
          </Btn>
          <Btn tone="outline" icon={Icon.Plus} size="sm" onClick={() => setLauncherOpen(true)}>
            Generate fixtures
          </Btn>
          {/* Primary CTA — always visible. State reflects the active series.
              Release is gated on admin approval; approve first, then release. */}
          {active &&
            (active.released ? (
              <>
                {onReveal && active.withheld?.venue && (
                  <Btn tone="teal" size="sm" onClick={() => reveal(active, 'venue')}>
                    Reveal venues
                  </Btn>
                )}
                {onReveal && active.withheld?.time && (
                  <Btn tone="teal" size="sm" onClick={() => reveal(active, 'time')}>
                    Reveal times
                  </Btn>
                )}
                <Btn tone="outline" size="sm" onClick={() => askRecall(active)}>
                  Recall release
                </Btn>
              </>
            ) : active.approved ? (
              <>
                <Btn tone="outline" size="sm" onClick={() => unapprove(active)}>
                  Withdraw approval
                </Btn>
                <Btn tone="teal" size="sm" icon={Icon.Arrow} onClick={() => askRelease(active)}>
                  Release to clubs
                </Btn>
              </>
            ) : (
              <Btn tone="teal" size="sm" icon={Icon.Check} onClick={() => approve(active)}>
                Approve fixtures
              </Btn>
            ))}
        </div>
      </div>

      {/* Venues + seasons render regardless of series count: generating a season stage is
          what CREATES the first series, so a zero-series tenant needs the Start-a-season
          flow most of all. While the season-setup queries are in flight, hold the space
          with a plain card — an unloaded runs list rendered as "No season running" offers
          a Start CTA whose duplicate guard is checking a list that never arrived. */}
      {seasonSetupLoading ? (
        <div style={{ marginBottom: 18 }}>
          <Card
            title="Seasons"
            sub="Loading the season setup — venues, structures and any season already running."
          />
        </div>
      ) : (
        <>
          {onSaveVenue && (
            <div style={{ marginBottom: 18 }}>
              <VenuesCard
                clubs={clubs}
                venues={allVenues}
                loadFailed={venuesFailed}
                onSave={onSaveVenue}
                onDelete={onDeleteVenue}
                toast={toast}
              />
            </div>
          )}
          {/* Structured competitions run stage by stage here; the flat series strip below
              still covers ad-hoc series and everything a season has generated. */}
          {tenantConfig && onCreateSeasonRun && (
            <div style={{ marginBottom: 18 }}>
              <SeasonRunsPanel
                configFailed={structuresFailed || seasonRunsFailed}
                clubs={clubs}
                allLeagues={allLeagues}
                allSeries={allSeries}
                runs={allSeasonRuns}
                onOpenLauncher={() => setLauncherOpen(true)}
                onPatchRun={onPatchSeasonRun}
                onGenerate={onGenerateStageSeries}
                onDeleteRun={onDeleteSeasonRun}
              />
            </div>
          )}
        </>
      )}

      {allSeries.length === 0 ? (
        // The empty state's copy points "above" at the season setup panel — while that
        // panel is still loading, there's nothing there yet to point at, so render nothing.
        seasonSetupLoading ? null : (
          <EmptyState
            icon={Icon.Field}
            title="No series yet"
            sub="Generate fixtures to work through a structured competition stage by stage (bound by your platform operator via operator console → Season setup, or the Structures card), run a flat season for any other league, or create an ad-hoc series for a one-off."
            action={
              <Btn tone="teal" icon={Icon.Plus} onClick={() => setLauncherOpen(true)}>
                Generate fixtures
              </Btn>
            }
          />
        )
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
                    {/* A released-but-not-yet-active series (juniors) reads as "Released"
                        everywhere else while clubs still can't see it — say so plainly, or
                        an admin will report it as a bug. */}
                    {s.released && !isActivated(s.activateFrom, todayIso()) ? (
                      <div
                        className="series-card-draft"
                        title={`Released, but hidden from clubs until ${formatIsoDate(s.activateFrom)}`}
                      >
                        Hidden until {formatIsoDate(s.activateFrom)}
                      </div>
                    ) : s.released ? (
                      <div className="series-card-released">Released</div>
                    ) : (
                      <div className="series-card-draft">Draft</div>
                    )}
                    {/* Withheld-field badges — a released series can hold back venues and/or
                        times; both can coexist with the "Hidden until …" activation badge. */}
                    {s.released && s.withheld?.venue && <Pill tone="gold">Venues withheld</Pill>}
                    {s.released && s.withheld?.time && <Pill tone="gold">Times withheld</Pill>}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      fontWeight: 500,
                      fontFamily: "'Montserrat',sans-serif",
                    }}
                  >
                    {s.teams.length} teams · {s.fixtures.length} fixtures · {s.maxOvers} ov ·{' '}
                    {s.endDate ? '' : 'start '}
                    {formatDay(s.startDate)}
                    {s.endDate ? ` – ${formatDay(s.endDate)}` : ''}
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
                    ) : s.approved ? (
                      <button className="series-card-btn release" onClick={() => askRelease(s)}>
                        Release to clubs →
                      </button>
                    ) : (
                      <button className="series-card-btn release" onClick={() => approve(s)}>
                        Approve fixtures ✓
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
              onAskRelease={askRelease}
              onAskRecall={askRecall}
              onAskReveal={onReveal ? reveal : undefined}
              onApprove={approve}
              onUnapprove={unapprove}
              toast={toast}
              allCalendars={allCalendars}
              onAllocateVenues={onAllocateVenues}
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
                  {confirm.yesLabel ?? (confirm.danger ? 'Yes, recall' : 'Release to clubs')}
                </Btn>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {releaseFor && (
        <ReleaseDialog
          seriesName={releaseFor.name}
          clubCount={distinctClubCount(releaseFor)}
          onClose={() => setReleaseFor(null)}
          onConfirm={(withheld) => {
            const held = [withheld.venue && 'venues', withheld.time && 'times'].filter(Boolean);
            const msg =
              releaseFor.name +
              ' · released to ' +
              distinctClubCount(releaseFor) +
              ' clubs' +
              (held.length ? ' · ' + held.join(' & ') + ' withheld' : '');
            // Return the release promise so the dialog stays open while the PATCH is in
            // flight and closes itself on success. The single success toast fires only
            // once the PATCH resolves; a failure (clash gate, version race) rejects the
            // chain so the dialog can show the error inline (withToast has already
            // surfaced its own toast). The dialog owns closing — no setReleaseFor here.
            return Promise.resolve(onSetReleased(releaseFor.id, true, withheld)).then(() =>
              toast?.(msg),
            );
          }}
        />
      )}

      {launcherOpen && (
        <GenerateFixturesLauncher
          clubs={clubs}
          allLeagues={allLeagues}
          config={tenantConfig || { structures: [], calendars: [] }}
          existingRuns={allSeasonRuns}
          onCreateRun={
            onCreateSeasonRun ||
            (() => Promise.reject(new Error('season-run creation is not wired for this host')))
          }
          onGenerateStage={
            onGenerateStageSeries ||
            (() => Promise.reject(new Error('stage generation is not wired for this host')))
          }
          // No league prefill — every real league now starts a season (structured or
          // flat) through the launcher's own forms above. This embedded form is reached
          // ONLY via the ad-hoc option, where there is no league to prefill at all.
          renderSeriesForm={({ onBack }) => (
            <CreateSeriesForm
              clubs={clubs}
              allLeagues={allLeagues}
              allCalendars={allCalendars}
              onBack={onBack}
              onCreate={onSubmitSeries}
              onClose={() => setLauncherOpen(false)}
            />
          )}
          onClose={() => setLauncherOpen(false)}
          toast={toast}
        />
      )}

      {viewerOpen && (
        <SeasonViewer
          allSeries={allSeries}
          clubs={clubs}
          initialSeriesId={active?.id}
          onClose={() => setViewerOpen(false)}
          onDownloadSeason={exportSeason}
          onDownloadSchedule={exportSchedule}
        />
      )}
    </div>
  );
}

/* ─── SeasonViewer — read-only, on-platform view of the whole season: a summary table
   plus one tab per competition. The spreadsheet exports live inside it now, so the
   admin can see the same data before deciding to download it. ─── */
function SeasonViewer({
  allSeries,
  clubs,
  initialSeriesId,
  onClose,
  onDownloadSeason,
  onDownloadSchedule,
}: {
  allSeries: Series[];
  clubs: Club[];
  initialSeriesId?: string;
  onClose: () => void;
  onDownloadSeason: () => void;
  onDownloadSchedule: (s: Series) => void;
}) {
  useEscapeClose(onClose);
  const titleId = useId();
  const [tabId, setTabId] = useStateA(initialSeriesId ?? allSeries[0]?.id);
  const tab = allSeries.find((s) => s.id === tabId) || allSeries[0];
  const summary = seasonSummaryRows(allSeries);
  const scheduleRows = tab ? seriesScheduleRows(tab, clubs) : [];
  const statusTone = (label: string) =>
    label === 'Released' ? 'teal' : label === 'Approved (draft)' ? 'gold' : 'muted';

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="task-modal season-viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Fixtures · Venues</div>
            <div className="task-modal-head-title" id={titleId}>
              Season summary &amp; schedules
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Btn
              tone="outline"
              icon={Icon.Download}
              size="sm"
              onClick={onDownloadSeason}
              disabled={allSeries.length === 0}
            >
              Download season
            </Btn>
            <button className="task-modal-close" onClick={onClose} title="Close">
              <Icon.X />
            </button>
          </div>
        </div>
        <div className="task-modal-body">
          {allSeries.length === 0 ? (
            <EmptyState
              icon={Icon.Field}
              title="No series yet"
              sub="Generate fixtures first — a season summary and schedules appear here once you do."
            />
          ) : (
            <>
              <div className="tbl-w">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Competition</th>
                      <th>Fixtures</th>
                      <th>Sides</th>
                      <th>From</th>
                      <th>To</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.map((row, i) => (
                      <tr key={allSeries[i].id}>
                        <td>{row.Competition}</td>
                        <td>{row.Fixtures}</td>
                        <td>{row.Sides}</td>
                        <td>{row.From}</td>
                        <td>{row.To}</td>
                        <td>
                          <Pill tone={statusTone(row.Status)} dot>
                            {row.Status}
                          </Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="sv-tabs">
                {allSeries.map((s) => (
                  <button
                    key={s.id}
                    className={`filter-pill ${s.id === tab?.id ? 'active' : ''}`}
                    aria-pressed={s.id === tab?.id}
                    onClick={() => setTabId(s.id)}
                  >
                    {s.name}
                    <span className="count">{s.fixtures.length}</span>
                  </button>
                ))}
              </div>

              <div className="sv-toolbar">
                <Btn
                  tone="outline"
                  icon={Icon.Download}
                  size="sm"
                  onClick={() => tab && onDownloadSchedule(tab)}
                  disabled={scheduleRows.length === 0}
                >
                  Download schedule
                </Btn>
              </div>

              <div className="tbl-w">
                <ScrollX label="Schedule table">
                  <table className="tbl">
                    <thead>
                      <tr>
                        {SCHEDULE_COLS.map((col) => (
                          <th
                            key={col}
                            style={
                              col === 'Distance (km)' || col === 'Travel (R)'
                                ? { textAlign: 'right' }
                                : undefined
                            }
                          >
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tab && scheduleRows.length > 0 ? (
                        scheduleRows.map((row, i) => (
                          <tr key={(tab.fixtures as any[])[i].id}>
                            <td>{row.Round}</td>
                            <td>{row.Date}</td>
                            <td>{row.Time}</td>
                            <td>{row.Home}</td>
                            <td>{row.Venue}</td>
                            <td>{row['Venue note']}</td>
                            <td>{row.Suburb}</td>
                            <td>{row.Away}</td>
                            <td style={{ textAlign: 'right' }}>{row['Distance (km)']}</td>
                            <td style={{ textAlign: 'right' }}>{row['Travel (R)']}</td>
                            <td>
                              <span className={`fix-status ${row.Status}`}>{row.Status}</span>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td
                            colSpan={SCHEDULE_COLS.length}
                            style={{
                              padding: '28px',
                              textAlign: 'center',
                              color: 'var(--muted)',
                              fontSize: 13,
                            }}
                          >
                            No fixtures in this series yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </ScrollX>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── FixtureTable with full human-in-the-loop editing ─── */
export function FixtureTable({
  series,
  clubs,
  onUpdateSeries,
  onDeleteSeries,
  onDuplicateSeries,
  onAskRelease,
  onAskRecall,
  onAskReveal,
  onApprove,
  onUnapprove,
  toast,
  allCalendars = [] as SeasonCalendar[],
  onAllocateVenues,
}) {
  const copy = useCopy();
  const clubBy = (id) => clubs.find((c) => c.id === id);
  // Resolve a fixture id → team for this series (participant snapshot, else clubId).
  const teamBy = (id) => resolveTeam(series, id, clubBy);
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
    // Date the new round through the SERIES' OWN CALENDAR when it has one. The old
    // "+7 days from the last fixture" would step straight into the mid-season break —
    // the exact defect season calendars exist to remove — and it parsed with a lenient
    // `new Date()` in a module that otherwise went strict-dayjs everywhere.
    const calendar = allCalendars.find((c) => c.id === series.schedule?.calendarId);
    const planned =
      series.schedule && calendar
        ? planRoundDates({
            calendar,
            blockId: series.schedule.blockId,
            cadence: series.schedule.cadence,
            rounds: nextRound,
            roundsPerDay: series.schedule.roundsPerDay,
          }).dates[nextRound - 1]
        : undefined;
    // Default to two distinct teams so a fresh row isn't a team-vs-itself fixture
    // (matters for a 2-side derby series where teams[1] is the only alternative).
    const t = series.teams || [];
    // Legacy fallback for a series with no calendar binding — every series created
    // before ADR 0008. One week on from the last fixture, which is what this button
    // always did. Asking for `nextRound` dates ANCHORED AT the last fixture compounds
    // the two, so round 4 would land three weeks past where it belongs.
    const legacy = last?.date
      ? legacyRoundDates(2, last.date).at(-1)
      : legacyRoundDates(1, series.startDate).at(-1);
    // A double-header round shares ONE slot across the whole round — same rule
    // `fixturesFromDates` applies (`slots[round % slots.length]`, round 0-based there,
    // `nextRound` here is 1-based, hence the `- 1`) — so a fixture added by hand into a
    // round-per-day series still lands in the right AM/PM slot instead of carrying no
    // time at all.
    const slots = series.schedule?.slots;
    const roundSlot =
      series.schedule?.roundsPerDay === 2 && slots?.length
        ? slots[(nextRound - 1) % slots.length]
        : undefined;
    const newFix = {
      id: newId,
      round: nextRound,
      date: planned ?? legacy,
      home: t[0],
      away: t.find((x) => x !== t[0]) || t[1] || t[0],
      status: 'scheduled',
      ...(roundSlot ? { time: roundSlot.start, slot: roundSlot.label } : {}),
    };
    onUpdateSeries(series.id, (s) => ({ ...s, fixtures: [...s.fixtures, newFix] }));
    setEditingId(newId);
    toast?.('Fixture added — edit details');
  }
  /**
   * Rebuild fixtures from the series' own stored schedule.
   *
   * A calendar-scheduled series MUST regenerate through the calendar, not the legacy
   * weekly stepping — otherwise a regenerate would quietly move a whole league's fixtures
   * into the mid-season break, which is precisely the defect calendars exist to prevent.
   * A calendar deleted or re-blocked since creation makes the plan unfittable; we refuse
   * and say so rather than silently falling back to a different schedule.
   */
  function regenerate() {
    const sched = series.schedule;
    const calendar = sched && allCalendars.find((c) => c.id === sched.calendarId);
    if (sched && !calendar) {
      setConfirm(null);
      toast?.('That season calendar no longer exists — pick a new schedule first', 'warn');
      return;
    }
    if (sched && calendar) {
      // Regenerate only knows how to rebuild a SINGLE-LEG ROUND ROBIN. A season-run
      // series carries its schedule but not its format, so regenerating a double round
      // would silently halve it and regenerating a knockout would replace the bracket
      // with a league. Refuse rather than reshape someone's season.
      if (series.seasonRunId) {
        setConfirm(null);
        toast?.(
          'This series belongs to a season — regenerate it from the season stage so its format is preserved',
          'warn',
        );
        return;
      }
      const rounds = roundsForTeamCount(series.teams.length);
      if (rounds < 1) {
        setConfirm(null);
        toast?.('At least two teams are needed to regenerate fixtures', 'warn');
        return;
      }
      const plan = planRoundDates({
        calendar,
        blockId: sched.blockId,
        cadence: sched.cadence,
        rounds,
        startDate: series.startDate,
        roundsPerDay: sched.roundsPerDay,
      });
      // `fits` is trivially true for zero rounds, and `plan.dates[0]` would then be
      // undefined — which `removeUndefinedValues` strips, dropping the gsi1sk and making
      // the series vanish from listSeries permanently. Guarded above and again here.
      if (!plan.fits || !plan.dates.length) {
        setConfirm(null);
        toast?.(plan.summary, 'warn');
        return;
      }
      onUpdateSeries(series.id, (s) => ({
        ...s,
        startDate: plan.dates[0],
        fixtures: fixturesFromPlan(s.teams, plan.dates, sched.slots, {
          roundsPerDay: sched.roundsPerDay,
        }),
      }));
    } else {
      onUpdateSeries(series.id, (s) => ({
        ...s,
        fixtures: generateRoundRobin(s.teams, s.startDate, {
          endDateISO: s.endDate,
          spread: resolveSpread(s),
        }),
      }));
    }
    setConfirm(null);
    toast?.(`${series.name} · fixtures regenerated`);
  }

  // "Time TBC" is only meaningful once the series has at least one timed fixture —
  // computed once here rather than per row, and only shown on untimed rows when true,
  // so series that never use times (most of them) stay silent rather than noisy.
  const seriesHasTimes = series.fixtures.some((f) => !!formatTime(f.time));

  // Build rows with computed cost
  const allRows = series.fixtures.map((f) => {
    const home = teamBy(f.home),
      away = teamBy(f.away);
    const c = fixtureCost(home, away, series.costPerKm, series.carsPerAwayTrip, fixtureVenue(f));
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
            {[
              series.seriesType,
              `${series.teams.length} teams`,
              `${series.fixtures.length} fixtures`,
              `${series.maxOvers} overs`,
              // A season-generated series has no category — the competition already says
              // what it is. Joining on the present parts avoids a dangling separator.
              series.category,
            ]
              .filter(Boolean)
              .join(' · ')}
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
              R {(series.costPerKm ?? DEFAULT_COST_PER_KM).toFixed(2)}
              <span className="unit">× {series.carsPerAwayTrip ?? DEFAULT_CARS} cars</span>
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
          <InfoDot title="Series tools" align="end">
            <p>
              <strong>Add fixture</strong> — insert a single match into this series by hand.
            </p>
            <p>
              <strong>Regenerate</strong> — rebuild the whole series as a fresh round-robin.
              Replaces every fixture and loses manual edits.
            </p>
            <p>
              <strong>Allocate venues</strong> — assign a ground to every fixture. Ranks by travel
              distance where grounds are pinned, keeps home-ground preference, and respects per-day
              limits and closures. Hand-set venues marked 🔒 stay put.
            </p>
            <p>
              <strong>Duplicate</strong> — copy the series (e.g. to trial a change).{' '}
              <strong>Delete series</strong> — remove it and all its fixtures.
            </p>
          </InfoDot>
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
          {onAllocateVenues && (
            <Btn
              tone="outline"
              size="sm"
              onClick={() =>
                setConfirm({
                  title: 'Allocate venues for every fixture?',
                  body: series.released
                    ? `This series is RELEASED. Reallocating rewrites the ground for all ${series.fixtures.length} fixtures — clubs and players have already been sent the current ones, and there is no undo.`
                    : `Assigns a ground to all ${series.fixtures.length} fixtures, replacing any already set. Hand-picked venues are kept only where the fixture is locked.`,
                  onYes: () => onAllocateVenues(series),
                  danger: series.released,
                })
              }
            >
              ⌖ Allocate venues
            </Btn>
          )}
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
                body: `Permanently remove "${series.name}" along with all ${series.fixtures.length} fixtures. The ${copy.office} cannot undo this.`,
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
                    // The whole list, so a `win:fN` side can be named ("Winner of
                    // Semi-final 1") rather than rendered as a raw id.
                    fixtures={series.fixtures}
                    teams={series.teams.map((id) => {
                      const r = teamBy(id);
                      return { id, name: r.name, ground: r.ground, club: r.club };
                    })}
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
                    <span className="fix-row-date">{formatWeekdayDay(f.date)}</span>
                    {/* Shown only when the schedule set a start time (double-headers,
                        morning/afternoon slots) — most series have neither. "Time TBC"
                        below only appears when the series itself uses times elsewhere;
                        otherwise an untimed fixture renders nothing here, as before. */}
                    {(() => {
                      const time = formatTime(f.time);
                      if (time) {
                        return (
                          <div className="fix-row-time">
                            {time}
                            {f.slot ? ` · ${f.slot}` : ''}
                          </div>
                        );
                      }
                      return seriesHasTimes ? <div className="fix-row-time">Time TBC</div> : null;
                    })()}
                  </td>
                  <td>
                    <div className="fix-row-team">
                      {home.club && <ClubAvatar club={home.club} size={26} />}
                      <div>
                        {/* An id with no club behind it means the club was deleted —
                            say so instead of the pre-schedule 'TBD'. */}
                        <div className="fix-row-team-name">{f.home ? home.name : 'TBD'}</div>
                        <div className="fix-row-team-sub">{home.club?.sub}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="fix-row-venue">
                      <div className="fix-row-venue-name">
                        {f.venueOverride || f.venueName || home.ground?.venue || '—'}
                        {/* `isLocked`, not `venueLocked` — a hand-typed venueOverride is
                            what the editor actually writes, so those are precisely the
                            fixtures allocation won't move. */}
                        {isLocked(f) && (
                          <span title="Set by hand — allocation won't move it"> 🔒</span>
                        )}
                        <VenueReasonPill reason={f.venueReason} status={f.venueStatus} />
                      </div>
                      {/* The reason is the whole point of a greedy allocator over a solver:
                          an operator can argue with "home ground closed for maintenance",
                          not with an objective value. */}
                      <div className="fix-row-venue-suburb">
                        {f.venueReason && f.venueStatus !== 'home'
                          ? f.venueReason
                          : home.ground?.suburb || ''}
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="fix-row-team">
                      {away.club && <ClubAvatar club={away.club} size={26} />}
                      <div>
                        <div className="fix-row-team-name">{f.away ? away.name : 'TBD'}</div>
                        <div className="fix-row-team-sub">{away.club?.sub}</div>
                      </div>
                    </div>
                  </td>
                  {/* A knockout fixture whose sides are still `win:fN` has no journey to
                      cost yet, and neither does an ungeocoded ground — "—" says that,
                      where "0.0 km" reads as a real measurement of zero. */}
                  <td style={{ textAlign: 'right' }}>
                    {c.distanceKm > 0 ? (
                      <span className="fix-row-dist">
                        {c.distanceKm.toFixed(1)}
                        <span className="unit">km</span>
                      </span>
                    ) : (
                      <span className="fix-row-dist">—</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {c.distanceKm > 0 ? (
                      <span className="fix-row-cost">
                        <span className="cur">R</span>
                        {Math.round(c.fuelR).toLocaleString()}
                      </span>
                    ) : (
                      <span className="fix-row-cost">—</span>
                    )}
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
                  colSpan={9}
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
                Fixtures released to all {distinctClubCount(series)} clubs
              </div>
              <div className="fix-release-text-sub">
                Published {formatStamp(series.releasedAt)} · every club portal now shows their
                schedule{series.withheld?.venue ? '' : ' + travel costs'}. No email or WhatsApp is
                sent — each club shares fixtures with its players when it chooses.
              </div>
              {(series.withheld?.venue || series.withheld?.time) && (
                <div
                  className="fix-release-text-sub"
                  style={{ marginTop: 6, color: 'var(--gold-deep,var(--muted))' }}
                >
                  Withheld from clubs:{' '}
                  {[series.withheld?.venue && 'venues', series.withheld?.time && 'times']
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
            </>
          ) : series.approved ? (
            <>
              <div className="fix-release-eyebrow">✓ Approved — ready to release</div>
              <div className="fix-release-text-title">Approved by the {copy.office}</div>
              <div className="fix-release-text-sub">
                Fixtures are signed off. Release to push the schedule to every club portal. Editing
                a fixture will withdraw approval and require re-approval.
              </div>
            </>
          ) : (
            <>
              <div className="fix-release-eyebrow">Draft mode</div>
              <div className="fix-release-text-title">Approval required before release</div>
              <div className="fix-release-text-sub">
                Review the fixtures, then approve. Release only unlocks once the {copy.office} has
                approved the schedule.
              </div>
            </>
          )}
        </div>
        <div className="fix-release-actions">
          {series.released ? (
            <>
              {onAskReveal && series.withheld?.venue && (
                <Btn tone="teal" onClick={() => onAskReveal(series, 'venue')}>
                  Reveal venues
                </Btn>
              )}
              {onAskReveal && series.withheld?.time && (
                <Btn tone="teal" onClick={() => onAskReveal(series, 'time')}>
                  Reveal times
                </Btn>
              )}
              <Btn tone="outline" onClick={() => onAskRecall?.(series)}>
                Recall draft
              </Btn>
            </>
          ) : series.approved ? (
            <>
              <Btn tone="outline" onClick={() => onUnapprove?.(series)}>
                Withdraw approval
              </Btn>
              <Btn tone="teal" icon={Icon.Arrow} onClick={() => onAskRelease?.(series)}>
                Release to clubs →
              </Btn>
            </>
          ) : (
            <Btn tone="teal" icon={Icon.Check} onClick={() => onApprove?.(series)}>
              Approve fixtures
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
function EditFixtureRow({ fixture, fixtures, teams, onSave, onCancel }) {
  // Each label is bound to its control. These sit BESIDE their inputs, so without an id
  // pairing a screen reader announces a row of unnamed boxes — and several fixtures can
  // be open at once, so the ids have to be per-row rather than global.
  const uid = useId();
  const [draft, setDraft] = useStateA({
    round: fixture.round,
    date: fixture.date,
    // Optional HH:MM kickoff — blank means no set time. In the venue ledger an untimed
    // fixture owns its whole day (it clashes with every timed slot on that date), so
    // clearing this widens the booking rather than removing it.
    time: fixture.time || '',
    home: fixture.home,
    away: fixture.away,
    venueOverride: fixture.venueOverride || '',
    // Carried so the picker can CLEAR them — see the venue-mode note below. Without
    // these in the draft, "Primary" could never undo an allocation.
    venueName: fixture.venueName ?? '',
    venueLat: fixture.venueLat,
    venueLon: fixture.venueLon,
    status: fixture.status || 'scheduled',
  });
  function u(k, v) {
    setDraft((prev) => ({ ...prev, [k]: v }));
  }
  // Venue picker mode is UI-only state (so "Other" can hold an empty text box without
  // collapsing back to "primary"). The stored value is always draft.venueOverride.
  //
  // ALLOCATION is a fourth state. A fixture the allocator moved carries `venueName` with
  // no override, and the row above renders `venueOverride || venueName || home ground` —
  // so opening the picker on "Primary" contradicted the row, and choosing Primary wrote
  // an empty override while leaving `venueName`, meaning the fixture still displayed the
  // allocated ground. Putting an allocated fixture back on its home ground was not
  // reachable through this editor at all.
  const homeClub0 = teams.find((t) => t.id === fixture.home);
  const secondary0 = homeClub0?.ground?.secondaryVenue || '';
  const initialOv = fixture.venueOverride || '';
  const allocatedName = fixture.venueName || '';
  const [venueMode, setVenueMode] = useStateA(
    initialOv !== ''
      ? secondary0 && initialOv === secondary0
        ? 'secondary'
        : 'custom'
      : allocatedName
        ? 'allocated'
        : 'primary',
  );
  /**
   * Clearing the allocated ground means clearing EVERYTHING allocation denormalised onto
   * the fixture. `venueId` matters most: `buildLedger` counts a ground as booked from it
   * and `travelPerTeam` measures distance to it, so a stale id keeps the old venue booked
   * against a match that has moved and never books the one it moved to.
   */
  const clearAllocated = {
    venueId: undefined,
    venueName: '',
    venueLat: undefined,
    venueLon: undefined,
  };
  /**
   * …and the way back. Switching to Primary and changing your mind must restore the
   * allocation, not just stop overriding it: the option still reads "Allocated ·
   * Kingsmead" (it is built from the STORED fixture, not the draft), so without this it
   * offers a ground it then doesn't save, and the match silently reverts to home.
   */
  const restoreAllocated = {
    venueId: fixture.venueId,
    venueName: fixture.venueName ?? '',
    venueLat: fixture.venueLat,
    venueLon: fixture.venueLon,
  };
  // A "secondary" pick stored the *current* home club's secondary venue name; changing
  // Home would otherwise persist the previous club's venue. Reset that pick to primary
  // on a home change. A custom free-text override is club-agnostic, so it's preserved.
  function changeHome(newHome) {
    if (venueMode === 'secondary') {
      setVenueMode('primary');
      setDraft((prev) => ({ ...prev, home: newHome, venueOverride: '' }));
    } else {
      u('home', newHome);
    }
  }
  return (
    <tr className="fix-edit-tr">
      <td colSpan={9}>
        <div className="fix-edit-grid">
          <div className="fix-edit-field">
            <label htmlFor={`${uid}-round`}>Round</label>
            <input
              id={`${uid}-round`}
              type="number"
              min="1"
              value={draft.round}
              onChange={(e) => u('round', parseInt(e.target.value) || 1)}
            />
          </div>
          <div className="fix-edit-field">
            <label htmlFor={`${uid}-date`}>Date</label>
            <input
              id={`${uid}-date`}
              type="date"
              value={draft.date}
              onChange={(e) => u('date', e.target.value)}
            />
          </div>
          <div className="fix-edit-field">
            <label htmlFor={`${uid}-time`}>Time (optional)</label>
            <input
              id={`${uid}-time`}
              type="time"
              value={draft.time}
              onChange={(e) => u('time', e.target.value)}
            />
          </div>
          {/* A knockout side that is still a forward reference (`win:f3`) has no entry in
              `teams`, so the select would render blank and any touch would silently
              replace the bracket reference with a concrete club — breaking the link the
              rest of the round depends on. Show what it is, read-only, instead. */}
          <div className="fix-edit-field">
            <label htmlFor={`${uid}-home`}>Home (host)</label>
            {isSlotRef(draft.home) ? (
              <input
                id={`${uid}-home`}
                type="text"
                value={slotRefLabel(draft.home, fixtures) ?? draft.home}
                disabled
              />
            ) : (
              <select
                id={`${uid}-home`}
                value={draft.home}
                onChange={(e) => changeHome(e.target.value)}
              >
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="fix-edit-field">
            <label htmlFor={`${uid}-away`}>Away (visitors)</label>
            {isSlotRef(draft.away) ? (
              <input
                id={`${uid}-away`}
                type="text"
                value={slotRefLabel(draft.away, fixtures) ?? draft.away}
                disabled
              />
            ) : (
              <select
                id={`${uid}-away`}
                value={draft.away}
                onChange={(e) => u('away', e.target.value)}
              >
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {(() => {
            // Venue picker driven by the home club's two grounds. The chosen venue is
            // stored in venueOverride (empty ⇒ home club's primary ground), so display
            // and export stay derived/live — no persisted resolved venue to go stale.
            const homeClub = teams.find((t) => t.id === draft.home);
            const primary = homeClub?.ground?.venue || '';
            const secondary = homeClub?.ground?.secondaryVenue || '';
            return (
              <>
                <div className="fix-edit-field">
                  <label htmlFor={`${uid}-venue`}>
                    Venue
                    <InfoDot
                      title="Venue"
                      options={[
                        {
                          label: 'Allocated',
                          desc: 'Keep the ground the allocator chose for this fixture.',
                        },
                        {
                          label: 'Primary',
                          desc: 'The home club’s main ground.',
                        },
                        {
                          label: 'Secondary',
                          desc: 'The home club’s backup ground, if they recorded one.',
                          eg: 'a second pitch used when the main ground is booked',
                        },
                        {
                          label: 'Other',
                          desc: 'Type an off-site venue by hand. A hand-set venue is locked — the allocator won’t move it.',
                          eg: 'a neutral final venue',
                        },
                      ]}
                    />
                  </label>
                  <select
                    id={`${uid}-venue`}
                    value={venueMode}
                    onChange={(e) => {
                      const m = e.target.value;
                      setVenueMode(m);
                      // Every pick other than "keep the allocated ground" clears what
                      // allocation put on the fixture, so the display precedence
                      // (override → allocated → home) actually lands where the picker says.
                      if (m === 'allocated')
                        setDraft((p) => ({ ...p, ...restoreAllocated, venueOverride: '' }));
                      else if (m === 'secondary')
                        setDraft((p) => ({ ...p, ...clearAllocated, venueOverride: secondary }));
                      else setDraft((p) => ({ ...p, ...clearAllocated, venueOverride: '' }));
                    }}
                  >
                    {allocatedName && (
                      <option value="allocated">Allocated · {allocatedName}</option>
                    )}
                    <option value="primary">Primary{primary ? ` · ${primary}` : ' ground'}</option>
                    {secondary && <option value="secondary">Secondary · {secondary}</option>}
                    <option value="custom">Other (type below)</option>
                  </select>
                </div>
                <div className="fix-edit-field">
                  <label htmlFor={`${uid}-custom`}>Custom venue</label>
                  <input
                    id={`${uid}-custom`}
                    type="text"
                    placeholder="Only for an off-site venue"
                    disabled={venueMode !== 'custom'}
                    value={venueMode === 'custom' ? draft.venueOverride : ''}
                    onChange={(e) => u('venueOverride', e.target.value)}
                  />
                </div>
              </>
            );
          })()}
          <div className="fix-edit-field">
            <label htmlFor={`${uid}-status`}>Status</label>
            <select
              id={`${uid}-status`}
              value={draft.status}
              onChange={(e) => u('status', e.target.value)}
            >
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
interface CreateSeriesFormProps {
  clubs: Club[];
  // The submitted draft omits server-assigned fields (`released`, `version`…), so this is
  // deliberately left untyped rather than widened to `Series` — the seam this guards is
  // the CALLBACK SHAPE (one series argument, a Promise the busy idiom awaits), not the
  // draft's exact fields.
  onCreate: (series) => Promise<void>;
  onClose: () => void;
  allLeagues?: League[];
  allCalendars?: SeasonCalendar[];
  /** Present when embedded in the "Generate fixtures" launcher — Back returns to the
   *  league picker instead of closing the whole flow. */
  onBack?: () => void;
}

export function CreateSeriesForm({
  clubs,
  onCreate,
  onClose,
  allLeagues = [],
  allCalendars = [] as SeasonCalendar[],
  onBack,
}: CreateSeriesFormProps) {
  const [d, setD] = useStateA({
    leagueKey: '', // dropdown: pick a league → auto-fills name + teams
    name: '',
    startDate: '',
    endDate: '', // optional; blank keeps the original weekly schedule
    dateMode: '', // '' = smart default by kind · 'spread' | 'reference'
    // ─ Season-calendar scheduling (ADR 0008). Empty calendarId ⇒ the legacy
    //   start/end window above drives the dates, exactly as before.
    calendarId: '',
    blockId: '',
    // Annotated so the discriminated union survives useState's inference —
    // without it every cadence widens to `{ kind: string }`.
    cadence: { kind: 'weekly' } as Cadence,
    slots: [] as TimeSlot[],
    activateFrom: '', // delayed visibility (juniors); blank ⇒ visible on release
    kind: 'series', // "series" or "tournament"
    bulkSend: true, // tick to bulk-send fixtures to stakeholders on create
    divisions: false,
    groups: 1,
    maxOvers: DEFAULT_SERIES_OVERS,
    maxPlayers: 11,
    rosterLimit: 'No Limit',
    ballType: 'Hard Tennis Ball',
    seriesType: SERIES_TYPES[0],
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
  const [showScheduling, setShowScheduling] = useStateA(false);
  // Set on the first user-driven edit. Back only confirms once there is actual admin
  // work to lose.
  const [dirty, setDirty] = useStateA(false);
  const [busy, setBusy] = useStateA(false);

  function u(k, v) {
    setDirty(true);
    setD((prev) => ({ ...prev, [k]: v }));
  }
  function toggleTeam(id) {
    setDirty(true);
    setD((prev) => ({
      ...prev,
      teams: prev.teams.includes(id) ? prev.teams.filter((t) => t !== id) : [...prev.teams, id],
    }));
  }
  function moveOrder(idx, dir) {
    setDirty(true);
    setD((prev) => {
      const arr = [...prev.pointsTableOrder];
      const j = idx + dir;
      if (j < 0 || j >= arr.length) return prev;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
      return { ...prev, pointsTableOrder: arr };
    });
  }
  function handleBack() {
    if (dirty && !window.confirm('Discard this series setup and go back?')) return;
    onBack?.();
  }

  // Teams eligible = each club past the phase-1 gate that registered for the selected
  // league, expanded into its sides: a club fielding ≥2 teams contributes one
  // participant per named side (so two sides of one club can be drawn against each
  // other); otherwise the club is a single team (teamId === clubId).
  const registeredClubs = d.leagueKey
    ? clubs.filter(
        (c) =>
          affiliationSubmitted(c) && Array.isArray(c.leagues) && c.leagues.includes(d.leagueKey),
      )
    : [];
  const teamCandidates = registeredClubs.flatMap((c) =>
    clubTeamsForLeague(c, d.leagueKey).map((p) => ({ ...p, club: c })),
  );

  // When the admin picks a league, auto-fill the name and bulk-select all registered sides.
  function pickLeague(key) {
    const L = findByKey(allLeagues, key);
    const candidates = clubs
      .filter((c) => affiliationSubmitted(c) && Array.isArray(c.leagues) && c.leagues.includes(key))
      .flatMap((c) => clubTeamsForLeague(c, key));
    setD((prev) => ({
      ...prev,
      leagueKey: key,
      name: L ? `${L.label} · 2026/27` : prev.name,
      teams: candidates.map((p) => p.teamId),
      tags: L ? `${L.group}, ${L.label}` : prev.tags,
    }));
  }

  // End date is optional. When set, the admin picks whether it drives the
  // schedule ('spread') or is reference-only; with no explicit pick we default
  // by format (see resolveSpread — shared with regenerate so they never drift).
  const spread = resolveSpread(d);
  const roundsNeeded = roundsForTeamCount(d.teams.length);
  const windowDays = d.endDate
    ? Math.round((new Date(d.endDate).getTime() - new Date(d.startDate).getTime()) / 86400000)
    : null;
  const endBeforeStart = !!d.endDate && d.endDate < d.startDate;
  // Spreading needs at least one day per round after the first.
  const windowTooShort = !!d.endDate && spread && windowDays < roundsNeeded - 1;

  /* ─── Season-calendar scheduling (ADR 0008) ───
     Two mutually exclusive modes. Picking a calendar hands dating to the engine, which
     knows about blocks, breaks, excluded dates and cadence; with none picked (or none
     configured for the tenant) the legacy start/end window runs exactly as before.
     `plan` is recomputed on every keystroke so the preview and the create button always
     agree with what would actually be generated. */
  const calendar = allCalendars.find((c) => c.id === d.calendarId) || null;
  // Narrowed once here — `d.cadence.days` inside JSX doesn't narrow through the
  // property chain, and reading it unguarded is a runtime error on other cadences.
  const selectedDays: Weekday[] = d.cadence.kind === 'weekdays' ? d.cadence.days : [];
  const plan =
    calendar && roundsNeeded > 0
      ? planRoundDates({
          calendar,
          blockId: d.blockId,
          cadence: d.cadence,
          rounds: roundsNeeded,
          startDate: d.startDate || undefined,
        })
      : null;

  const canCreate =
    d.name &&
    d.teams.length >= 2 &&
    (calendar
      ? // The calendar owns the dates, so startDate isn't required — but a plan that
        // doesn't fit its block must never be generated into a silently short season.
        !!plan?.fits
      : d.startDate && !endBeforeStart && !windowTooShort);

  function submit() {
    if (!canCreate || busy) return;
    // Self-contained snapshot of the selected sides — authoritative for resolving
    // fixture names/coords, so a later roster edit never orphans this series.
    const participants = teamCandidates
      .filter((p) => d.teams.includes(p.teamId))
      .map((p) => ({
        teamId: p.teamId,
        clubId: p.clubId,
        name: p.name,
        ...(p.venue ? { venue: p.venue } : {}),
        ...(Number.isFinite(p.lat) ? { lat: p.lat } : {}),
        ...(Number.isFinite(p.lon) ? { lon: p.lon } : {}),
      }));
    const scheduled = !!(calendar && plan);
    // The form model's own scheduling fields are DROPPED here — `calendarId`, `blockId`,
    // `cadence` and `slots` are the inputs that produce `schedule` below, and spreading
    // them too stored the same binding twice on every calendar-scheduled series. Nothing
    // reads the strays today, which is exactly how a second source of truth survives
    // until something does.
    const { calendarId: _cid, blockId: _bid, cadence: _cad, slots: _slots, ...seriesFields } = d;
    const series = {
      id: 's-' + Date.now(),
      ...seriesFields,
      participants,
      // Persist the *resolved* mode (not the raw '' default) only when an end
      // date exists, so regenerate reproduces the schedule the admin confirmed.
      dateMode: d.endDate ? (spread ? 'spread' : 'reference') : undefined,
      // The calendar binding, so `regenerate` reproduces these dates rather than
      // falling back to legacy weekly stepping. Same parity guarantee as dateMode.
      schedule: scheduled
        ? {
            calendarId: calendar.id,
            blockId: d.blockId,
            cadence: d.cadence,
            ...(d.slots.length ? { slots: d.slots } : {}),
          }
        : undefined,
      // The generated first-round date becomes the series start, so every existing
      // consumer (list sort, gsi1sk, headers) keeps reading one field.
      startDate: scheduled ? plan.dates[0] : d.startDate,
      activateFrom: d.activateFrom || undefined,
      tags: d.tags
        ? d.tags
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      fixtures: scheduled
        ? fixturesFromPlan(d.teams, plan.dates, d.slots.length ? d.slots : undefined)
        : generateRoundRobin(d.teams, d.startDate, { endDateISO: d.endDate, spread }),
    };
    // Await the POST — closing only on success keeps a failed create from silently
    // discarding the admin's work (see StartSeasonForm's identical busy idiom).
    setBusy(true);
    onCreate(series)
      .then(onClose)
      .catch(() => setBusy(false));
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
            aria-label="League"
            value={d.leagueKey}
            onChange={(e) => {
              setDirty(true);
              pickLeague(e.target.value);
            }}
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
      {/* ─── Dates ───
          With a season calendar configured the operator's playing blocks and breaks
          drive the dates; without one this collapses to the original start/end window. */}
      {allCalendars.length > 0 && (
        <div className="cs-row">
          <div className="cs-row-label">Dates</div>
          <div className="cs-row-input">
            <select
              className="field-select"
              aria-label="Dates"
              value={d.calendarId}
              onChange={(e) => {
                const cal = allCalendars.find((c) => c.id === e.target.value);
                // Default to the first block so the preview has something to say
                // immediately rather than starting on an error.
                setD((prev) => ({
                  ...prev,
                  calendarId: e.target.value,
                  blockId: cal?.blocks?.[0]?.id || '',
                }));
              }}
              style={{ minWidth: 280 }}
            >
              <option value="">Custom dates — pick start / end</option>
              {allCalendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {`${c.label} season · ${calendarSpan(c)}`}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {calendar ? (
        <>
          {/* A single-block calendar has already auto-picked its only option — showing
              a one-item select would just be a decoy control. */}
          {calendar.blocks.length > 1 && (
            <div className="cs-row">
              <div className="cs-row-label">
                Playing block<span className="req">*</span>
              </div>
              <div className="cs-row-input">
                <select
                  className="field-select"
                  aria-label="Playing block"
                  value={d.blockId}
                  onChange={(e) => u('blockId', e.target.value)}
                  style={{ minWidth: 280 }}
                >
                  {calendar.blocks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label} · {formatIsoDate(b.start)} → {formatIsoDate(b.end)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          {/* The preview rail: what will actually be generated, recomputed live. This is
              where an overflowing block is caught, before anyone clicks create. */}
          {plan && (
            <div className="cs-row">
              <div className="cs-row-label" />
              <div className="cs-row-input">
                <div
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    border: '1px solid var(--line)',
                    background: plan.fits ? 'var(--paper)' : 'var(--coral-pale, #FDECEA)',
                    color: plan.fits ? 'var(--muted)' : 'var(--coral)',
                  }}
                >
                  <strong style={{ color: plan.fits ? 'var(--ink)' : 'var(--coral)' }}>
                    {plan.fits ? 'Ready' : 'Does not fit'}
                  </strong>{' '}
                  · {plan.summary}
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="cs-row">
            <div className="cs-row-label">
              Start Date<span className="req">*</span>
            </div>
            <div className="cs-row-input">
              <input
                type="date"
                value={d.startDate}
                onChange={(e) => u('startDate', e.target.value)}
              />
            </div>
          </div>
          <div className="cs-row">
            <div className="cs-row-label">End Date</div>
            <div className="cs-row-input">
              <input
                type="date"
                value={d.endDate}
                min={d.startDate}
                onChange={(e) => u('endDate', e.target.value)}
              />
              {d.endDate ? (
                <div style={{ marginTop: 8 }}>
                  <Choice
                    value={spread ? 'Spread fixtures across window' : 'Reference only'}
                    onChange={(v) =>
                      u('dateMode', v === 'Spread fixtures across window' ? 'spread' : 'reference')
                    }
                    options={['Spread fixtures across window', 'Reference only']}
                  />
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                    {spread
                      ? 'Rounds are distributed evenly between the start and end date — best for a tournament that runs over a fixed period.'
                      : 'Fixtures keep the weekly cadence; the end date is saved for display only.'}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </>
      )}
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
            {registeredClubs.length} club{registeredClubs.length === 1 ? '' : 's'} ·{' '}
            {teamCandidates.length} team{teamCandidates.length === 1 ? '' : 's'} registered for{' '}
            <strong>{findByKey(allLeagues, d.leagueKey)?.label ?? d.leagueKey}</strong>
          </div>
          <div className="cs-row-input">
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8 }}>
              Every side registered for this league is pre-included — clubs fielding more than one
              team show each side separately. Tap a chip to opt one out.
            </div>
            <div className="cs-teams-grid">
              {teamCandidates.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  No registered clubs yet — once clubs affiliate for this league they'll appear here
                  automatically.
                </span>
              ) : (
                teamCandidates.map((p) => {
                  const on = d.teams.includes(p.teamId);
                  return (
                    <button
                      key={p.teamId}
                      className={`cs-team-chip ${on ? 'on' : ''}`}
                      onClick={() => toggleTeam(p.teamId)}
                    >
                      {on && <Icon.Check />}
                      {p.name}
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

      {/* ─── Scheduling options (collapsed by default) ───
          Cadence, first round, time slots and activation are engine knobs with sane
          defaults — most admins never touch them, so they live behind a toggle
          rather than sprouting inline the moment a calendar is picked. */}
      <button
        type="button"
        className="cs-section"
        aria-label="Scheduling options"
        aria-expanded={showScheduling}
        style={{
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          textAlign: 'left',
          background: 'none',
          border: 'none',
          borderTop: '1px solid var(--line)',
          padding: 0,
          paddingTop: 14,
          marginTop: 16,
          font: 'inherit',
          color: 'inherit',
        }}
        onClick={() => setShowScheduling((v) => !v)}
      >
        <span className="cs-section-title">— Scheduling options</span>
        <span
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            fontWeight: 700,
          }}
        >
          {showScheduling ? 'Hide' : 'Defaults applied · click to edit'}
        </span>
      </button>
      {showScheduling && (
        <>
          {calendar && (
            <>
              <div className="cs-row">
                <div className="cs-row-label">Cadence</div>
                <div className="cs-row-input">
                  <Choice
                    value={CADENCE_LABELS[d.cadence.kind] || CADENCE_LABELS.weekly}
                    onChange={(v) => u('cadence', cadenceFromLabel(v))}
                    options={Object.values(CADENCE_LABELS)}
                  />
                  {d.cadence.kind === 'weekdays' && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                      {WEEKDAY_LABELS.map((label, day) => {
                        const on = selectedDays.includes(day as Weekday);
                        return (
                          <button
                            key={label}
                            type="button"
                            onClick={() =>
                              u('cadence', {
                                kind: 'weekdays',
                                days: on
                                  ? selectedDays.filter((x) => x !== day)
                                  : [...selectedDays, day as Weekday].sort((a, b) => a - b),
                              })
                            }
                            style={{
                              padding: '4px 10px',
                              borderRadius: 999,
                              fontSize: 11.5,
                              fontWeight: 700,
                              cursor: 'pointer',
                              border: '1px solid var(--line)',
                              background: on ? 'var(--green-pale)' : 'var(--paper)',
                              color: on ? 'var(--green)' : 'var(--muted-2)',
                            }}
                          >
                            {label.slice(0, 3)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div className="cs-row">
                <div className="cs-row-label">First round</div>
                <div className="cs-row-input">
                  <input
                    type="date"
                    aria-label="First round"
                    value={d.startDate}
                    min={calendar.blocks.find((b) => b.id === d.blockId)?.start}
                    max={calendar.blocks.find((b) => b.id === d.blockId)?.end}
                    onChange={(e) => u('startDate', e.target.value)}
                  />
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                    Optional — leave blank to start on the first day of the block.
                  </div>
                </div>
              </div>
              <div className="cs-row">
                <div className="cs-row-label">Time slots</div>
                <div className="cs-row-input">
                  <Choice
                    value={d.slots.length ? 'Morning & afternoon' : 'No set times'}
                    onChange={(v) => u('slots', v === 'No set times' ? [] : T20_SLOTS)}
                    options={['No set times', 'Morning & afternoon']}
                  />
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                    {d.slots.length
                      ? 'Fixtures in a round alternate between 08:00 and 13:30 starts.'
                      : 'Fixtures carry a date only; start times are set later.'}
                  </div>
                </div>
              </div>
              <div className="cs-row">
                <div className="cs-row-label">Activate from</div>
                <div className="cs-row-input">
                  <input
                    type="date"
                    aria-label="Activate from"
                    value={d.activateFrom}
                    onChange={(e) => u('activateFrom', e.target.value)}
                  />
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                    Optional — fixtures generate now but stay hidden from clubs until this date.
                    Used for junior leagues that only start in the second half of the season.
                  </div>
                </div>
              </div>
            </>
          )}
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
        </>
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
                {SERIES_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
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
            ? `Ready · ${d.kind === 'tournament' ? 'tournament' : 'series'} · ${(d.teams.length * (d.teams.length - 1)) / 2} round-robin fixtures · ${
                calendar && plan
                  ? // Calendar mode: report what was actually planned — cadence, real span,
                    // and any slots — rather than the old hardcoded "weekly from …".
                    `${describeCadence(d.cadence)} in ${
                      calendar.blocks.find((b) => b.id === d.blockId)?.label ?? 'the block'
                    } · ${formatIsoDate(plan.dates[0])} → ${formatIsoDate(
                      plan.dates[plan.dates.length - 1],
                    )}${d.slots.length ? ` · ${d.slots.length} time slots` : ''}${
                      d.activateFrom ? ` · hidden until ${formatIsoDate(d.activateFrom)}` : ''
                    }`
                  : d.endDate && spread
                    ? `spread from ${d.startDate} to ${d.endDate}`
                    : d.endDate
                      ? `weekly from ${d.startDate} · ends ${d.endDate}`
                      : `weekly from ${d.startDate}`
              }${d.bulkSend ? ' · fixtures will be bulk-sent to stakeholders' : ''}`
            : !d.leagueKey || !d.name
              ? 'Pick a league / division to auto-populate teams'
              : d.teams.length < 2
                ? 'At least 2 registered teams are required'
                : // In calendar mode the plan's own summary is the most specific thing we
                  // can say — it names the block, the shortfall and the way out.
                  calendar
                  ? (plan?.summary ?? 'Pick a playing block')
                  : !d.startDate
                    ? 'Add a start date'
                    : endBeforeStart
                      ? 'End date must be on or after the start date'
                      : windowTooShort
                        ? `Window too short — ${roundsNeeded} rounds need at least ${roundsNeeded - 1} days between start and end (your window is ${windowDays})`
                        : 'Complete the form to continue'}
        </div>
        <div className="row" style={{ gap: 8 }}>
          {onBack && (
            <Btn tone="ghost" onClick={handleBack} disabled={busy}>
              Back
            </Btn>
          )}
          <Btn tone="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn tone="teal" icon={Icon.Check} disabled={!canCreate || busy} onClick={submit}>
            {busy ? 'Creating…' : d.bulkSend ? `Create ${d.kind} & send` : `Create ${d.kind}`}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ─── Empty-cohort state — shown before any clubs have registered ─── */
function EmptyCohort({ onShareLink, onInviteAdmin }) {
  return (
    <div style={{ padding: '8px 0' }}>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Admin Console</div>
          <h1 className="ph-title">Welcome — let&apos;s get your union set up</h1>
          <p className="ph-desc">
            No clubs yet. Share your union&apos;s signup link with your affiliated clubs — they
            register themselves, and your cohort dashboard fills in here as they do.
          </p>
        </div>
      </div>
      <EmptyState
        icon={Icon.Clubs}
        title="No clubs registered yet"
        sub="Share your union's signup link — clubs register themselves and appear here as soon as they do."
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <Btn tone="teal" icon={Icon.Mail} onClick={onShareLink}>
              Invite clubs
            </Btn>
            {onInviteAdmin && (
              <Btn tone="outline" icon={Icon.Mail} onClick={onInviteAdmin}>
                Invite admin
              </Btn>
            )}
          </div>
        }
      />
    </div>
  );
}

/* ─── AdminLeagues — manage the tenant league catalogue clubs opt into ─── */
export function AdminLeagues({ allLeagues, clubs, onCreate, onEdit, onDeleteLeague, toast }) {
  const copy = useCopy();
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
          <div className="ph-crumb">{copy.crumbRoot} · Admin Console / Leagues</div>
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
// districts: the tenant-resolved list (operator-managed); the constant default
// keeps legacy callers working. The overarching sentinel is always offered first.
export function LeagueForm({
  league,
  allLeagues,
  onCreate,
  onUpdate,
  onClose,
  toast,
  districts = DISTRICTS,
}) {
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
            {/* A league can hold a since-removed district (server orphan tolerance) —
                surface it as a labelled option instead of a blank select. */}
            {league?.district &&
              league.district !== OVERARCHING_DISTRICT &&
              !districts.includes(league.district) && (
                <option value={league.district}>{league.district} (removed district)</option>
              )}
            {districts.map((d) => (
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
  onInviteAdmin,
  onShareLink,
  toast,
  submissionDeadline,
  onUpdateDeadline,
  support,
  onUpdateSupport,
  requiredDocs = DEFAULT_REQUIRED_DOCS,
}) {
  const copy = useCopy();
  const stats = cohortStats(clubs, requiredDocs);
  // Clubs a rep has renamed but no admin has acknowledged yet — surfaced as a worklist
  // tile so the flag is visible without opening each club.
  const renamedCount = clubs.filter((c) => c.nameChangePending).length;
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  const notify = (m) => (toast ? toast(m, 'warn') : null);
  const [showEditDeadline, setShowEditDeadline] = useStateA(false);
  const [showEditSupport, setShowEditSupport] = useStateA(false);

  // Open a bcc mail draft to the chairs of every club still missing a submission
  // (affiliation not submitted, no CQI, or any compliance doc outstanding).
  function remindBulk() {
    const behind = (c) =>
      !affiliationSubmitted(c) || c.cqi === 0 || !docsAllComplete(c, requiredDocs);
    openBccReminder({
      emails: clubs.filter(behind).map((c) => c.exco?.chair?.email),
      subject: 'Smart Club Integration — outstanding submissions',
      toast,
      emptyMessage: 'All clubs are up to date',
    });
  }

  // Blank tenant: show the invite-clubs empty state instead of a 0-of-0 dashboard.
  // onShareLink routes to the clubs list AND opens the share modal there.
  if (clubs.length === 0)
    return <EmptyCohort onShareLink={onShareLink ?? gotoList} onInviteAdmin={onInviteAdmin} />;

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
    .map((c) => ({ ...c, prog: overallProgress(c, requiredDocs) }))
    .sort((a, b) => b.prog - a.prog);
  const leaders = ranked.slice(0, 5);
  const atRisk = [...ranked].sort((a, b) => a.prog - b.prog).slice(0, 5);

  // Real cohort activity, derived from each club's timestamped comm/onboarding events
  // (PII-safe — see buildRecentActivity). Environment-specific by construction.
  const recentActivity = buildRecentActivity(clubs);

  // Phase completion roll-up — each card routes to its filtered cohort view
  const phases = [
    {
      num: '01',
      label: 'Affiliation',
      tone: 'navy',
      done: clubs.filter((c) => affiliationSubmitted(c)).length,
      view: 'affiliations',
    },
    {
      num: '02',
      label: 'League / Fixtures',
      tone: 'teal',
      done: clubs.filter((c) => affiliationSubmitted(c)).length,
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
      done: clubs.filter((c) => docsAllComplete(c, requiredDocs)).length,
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
      <div className="hero-banner" style={{ backgroundImage: 'var(--hero-image)', height: 170 }}>
        <div className="hero-content">
          <div className="hero-eyebrow">{copy.eyebrow}</div>
          <h2 className="hero-title">
            Building the next <em>generation</em>.
          </h2>
          <p className="hero-sub">
            Every club below is a feeder for our provincial squad. Track readiness, lift standards,
            identify talent.
          </p>
        </div>
      </div>

      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">{copy.crumbRoot} · Admin Console</div>
          <h1 className="ph-title">
            Club Integration <em>Cohort</em>
          </h1>
          <p className="ph-desc">
            {stats.total} affiliated clubs across the {copy.orgShort} districts. Track affiliation,
            document compliance, CQI scoring and franchise readiness for the 2026/27 season.
          </p>
        </div>
        <div className="ph-actions">
          <Btn
            tone="outline"
            icon={Icon.Download}
            size="sm"
            onClick={() => {
              const rows = clubs.map((c) =>
                clubExportRow(c, {
                  docCompletion: (club) => docCompletion(club, requiredDocs),
                  overallProgress: (club) => overallProgress(club, requiredDocs),
                  cqiBand,
                }),
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
          tone={statusFor(pct(stats.affComplete, stats.total))}
          label="Affiliated"
          num={<CountUp to={stats.affComplete} />}
          sub={`${pct(stats.affComplete, stats.total)}% of cohort`}
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
        {renamedCount > 0 && (
          <KPI tone="gold" label="Renamed" num={<CountUp to={renamedCount} />} sub="needs review" />
        )}
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
            {recentActivity.length === 0 ? (
              <div
                style={{
                  padding: '18px 10px',
                  fontSize: 13,
                  color: 'var(--muted)',
                  textAlign: 'center',
                }}
              >
                No activity in the last 7 days.
              </div>
            ) : (
              recentActivity.map((a, i) => (
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
                  <span style={{ fontWeight: 500, color: 'var(--ink)', fontSize: 13 }}>
                    {a.who}
                  </span>
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--muted)' }}>{a.what}</span>
                  <span
                    style={{
                      fontFamily: "'Montserrat',sans-serif",
                      fontSize: 10.5,
                      color: 'var(--muted-2)',
                    }}
                  >
                    {relTimeAgo(a.at)}
                  </span>
                </div>
              ))
            )}
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

/* ─── AdminSettingsView — consolidated workspace config: org, deadline, support, notifications ─── */
export function AdminSettingsView({
  orgName,
  submissionDeadline,
  support,
  onSaveOrg,
  onUpdateDeadline,
  onUpdateSupport,
  onManageTeam,
  signupLink,
  onGenerateSignupLink,
  onRevokeSignupLink,
  toast,
}) {
  const [name, setName] = useStateA(orgName || '');
  const [savingOrg, setSavingOrg] = useStateA(false);
  const [showEditDeadline, setShowEditDeadline] = useStateA(false);
  const [showEditSupport, setShowEditSupport] = useStateA(false);
  const [linkBusy, setLinkBusy] = useStateA(null); // null | 'generate' | 'revoke'
  const sup = parseSupport(support);
  const deadlineMid = formatDeadlineMid(submissionDeadline);
  const dirty = (name || '').trim() !== (orgName || '').trim();

  async function saveOrg() {
    if (!dirty || !name.trim()) return;
    setSavingOrg(true);
    try {
      await onSaveOrg?.(name.trim());
    } catch {
      /* onSaveOrg surfaces its own error toast */
    } finally {
      setSavingOrg(false);
    }
  }

  // Same generate/revoke handlers the share modal uses (threaded from main.jsx).
  const signupUrl = signupLink
    ? `${(typeof window !== 'undefined' && window.location.origin) || ''}/signup?t=${signupLink.token}`
    : '';
  async function runLink(kind, fn, doneMsg) {
    if (linkBusy || !fn) return;
    setLinkBusy(kind);
    try {
      await fn();
      toast?.(doneMsg);
    } catch {
      /* the handler's withToast already surfaced the error */
    } finally {
      setLinkBusy(null);
    }
  }
  function copySignupUrl() {
    if (!signupUrl) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(signupUrl).then(() => toast?.('Signup link copied'));
    } else {
      // Fallback for non-secure contexts (e.g. LAN-IP dev) — same as the share modal.
      const ta = document.createElement('textarea');
      ta.value = signupUrl;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        toast?.('Signup link copied');
      } catch {
        toast?.('Could not copy — copy it from the Invite clubs dialog', 'warn');
      }
      ta.remove();
    }
  }

  const rowStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  };
  const valStyle = { fontFamily: "'Montserrat',sans-serif", fontWeight: 700, fontSize: 14 };
  const chip = (on) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 12px',
    borderRadius: 999,
    fontSize: 11.5,
    fontWeight: 700,
    fontFamily: "'Montserrat',sans-serif",
    background: on ? 'var(--green-pale)' : 'var(--line2)',
    color: on ? 'var(--green)' : 'var(--muted-2)',
  });

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">{orgName} · Admin Console / Settings</div>
          <h1 className="ph-title">
            Workspace <em>Settings</em>
          </h1>
          <p className="ph-desc">
            Organisation details, the affiliation submission deadline, the union support contact,
            and how clubs and players are notified.
          </p>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <Card title="Organisation" sub="Shown across club portals, emails and the sign-in screen.">
          <div className="field">
            <div className="field-label">Organisation name</div>
            <input
              className="field-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Coastal Cricket Union"
            />
          </div>
          <Btn tone="teal" size="sm" onClick={saveOrg} disabled={!dirty || savingOrg}>
            {savingOrg ? 'Saving…' : 'Save name'}
          </Btn>
        </Card>

        <Card
          title="Affiliation deadline"
          sub="The date clubs must submit affiliation, documents and CQI by."
        >
          <div style={rowStyle}>
            <div style={valStyle}>{deadlineMid}</div>
            <Btn
              tone="outline"
              size="sm"
              icon={Icon.Form}
              onClick={() => setShowEditDeadline(true)}
            >
              Change deadline
            </Btn>
          </div>
        </Card>

        <Card
          title="Union support contact"
          sub="Surfaced to clubs as the office to reach for help."
        >
          <div style={rowStyle}>
            <div>
              <div style={valStyle}>{sup.name || 'Not set'}</div>
              {sup.email && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{sup.email}</div>}
            </div>
            <Btn tone="outline" size="sm" icon={Icon.Mail} onClick={() => setShowEditSupport(true)}>
              Edit contact
            </Btn>
          </div>
        </Card>

        <Card
          title="Access controls"
          sub="Invite admins and club reps, change roles and edit a rep's club scope."
        >
          <div style={rowStyle}>
            <div>
              <div style={valStyle}>Team &amp; Access</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                Manage who can sign in to this union.
              </div>
            </div>
            <Btn tone="outline" size="sm" icon={Icon.Users} onClick={() => onManageTeam?.()}>
              Manage team
            </Btn>
          </div>
        </Card>

        <Card
          title="Club self-registration"
          sub="One link for the whole union — clubs open it to register themselves."
        >
          <div style={{ ...rowStyle, marginBottom: 12 }}>
            <span style={chip(!!signupLink)}>{signupLink ? 'Link active' : 'No link'}</span>
            {signupLink && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                since {formatStampDay(signupLink.createdAt)}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {signupLink && (
              <Btn tone="outline" size="sm" icon={Icon.Form} onClick={copySignupUrl}>
                Copy link
              </Btn>
            )}
            <Btn
              tone={signupLink ? 'outline' : 'teal'}
              size="sm"
              icon={Icon.Plus}
              disabled={!!linkBusy}
              onClick={() =>
                runLink(
                  'generate',
                  onGenerateSignupLink,
                  signupLink
                    ? 'New signup link issued · the previous link no longer works'
                    : 'Signup link generated · ready to share',
                )
              }
            >
              {linkBusy === 'generate'
                ? 'Generating…'
                : signupLink
                  ? 'Regenerate'
                  : 'Generate link'}
            </Btn>
            {signupLink && (
              <Btn
                tone="ghost"
                size="sm"
                disabled={!!linkBusy}
                onClick={() =>
                  runLink(
                    'revoke',
                    onRevokeSignupLink,
                    'Signup link revoked — no one can register with it',
                  )
                }
              >
                {linkBusy === 'revoke' ? 'Revoking…' : 'Revoke'}
              </Btn>
            )}
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--muted-2)', margin: '10px 0 0' }}>
            Regenerating or revoking takes effect at once — the previous link stops working
            immediately.
          </p>
        </Card>

        <Card
          title="Notifications"
          sub="How clubs and players are reached. Managed by the platform."
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <span style={chip(true)}>Email</span>
            <span style={chip(true)}>WhatsApp</span>
            <span style={chip(false)}>SMS · not used</span>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6, margin: 0 }}>
            Staff invites and player broadcasts go out over email and WhatsApp. No SMS is sent.
          </p>
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
function ClubInsights({ clubs, submissionDeadline, requiredDocs = DEFAULT_REQUIRED_DOCS }) {
  const deadlineShort = formatDeadlineShort(submissionDeadline);
  const deadlineMid = formatDeadlineMid(submissionDeadline);
  // CQI bands + doc compliance — shared derivations (src/insights.tsx) so the
  // band/threshold definitions can't drift between this panel and the Insights page.
  const bandTone = cqiBandTone;
  const { bands, maxBand, submitted, avgCqi } = cqiBandRows(clubs);
  const { docStats, mostMissing } = docComplianceRows(clubs, requiredDocs);

  // Resources required — "behind" is keyed on the form fact.
  const notAffiliated = clubs.filter((c) => !affiliationSubmitted(c)).length;
  const incompleteDocs = clubs.filter((c) => !docsAllComplete(c, requiredDocs)).length;
  const noCqi = clubs.filter((c) => c.cqi === 0).length;
  const totalReminders = notAffiliated + noCqi;

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
              className={`resource-num ${notAffiliated > clubs.length * 0.3 ? 'danger' : notAffiliated > 0 ? 'warn' : 'good'}`}
            >
              <CountUp to={notAffiliated} />
            </span>
            <span className="resource-text">
              <strong>{notAffiliated === 1 ? 'club' : 'clubs'}</strong> haven't submitted the
              2026/27 affiliation form
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
  onInvite,
  signupLink,
  onGenerateSignupLink,
  onRevokeSignupLink,
  // Owned by Shell so the dashboard/tracker empty states can open the modal in
  // one click (set true + navigate here) instead of making the admin re-find it.
  showShareLink,
  setShowShareLink,
  requiredDocs = DEFAULT_REQUIRED_DOCS,
}) {
  const copy = useCopy();
  const [q, setQ] = useStateA('');
  const [filter, setFilter] = useStateA('all');
  const [showInviteAdmin, setShowInviteAdmin] = useStateA(false);

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
        (c) => c.affiliation === 'complete' && docsAllComplete(c, requiredDocs) && c.cqi > 0,
      );
    if (filter === 'incomplete')
      cs = cs.filter(
        (c) => !(c.affiliation === 'complete' && docsAllComplete(c, requiredDocs) && c.cqi > 0),
      );
    if (filter === 'affiliation_outstanding') cs = cs.filter((c) => !affiliationSubmitted(c));
    if (filter === 'no_cqi') cs = cs.filter((c) => c.cqi === 0);
    return cs;
  }, [clubs, q, filter, requiredDocs]);

  const counts = useMemoA(
    () => ({
      all: clubs.length,
      complete: clubs.filter(
        (c) => c.affiliation === 'complete' && docsAllComplete(c, requiredDocs) && c.cqi > 0,
      ).length,
      incomplete: clubs.filter(
        (c) => !(c.affiliation === 'complete' && docsAllComplete(c, requiredDocs) && c.cqi > 0),
      ).length,
      affiliation_outstanding: clubs.filter((c) => !affiliationSubmitted(c)).length,
      no_cqi: clubs.filter((c) => c.cqi === 0).length,
    }),
    [clubs, requiredDocs],
  );

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">{copy.crumbRoot} · Admin Console / Clubs</div>
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
                clubExportRow(c, {
                  docCompletion: (club) => docCompletion(club, requiredDocs),
                  overallProgress: (club) => overallProgress(club, requiredDocs),
                  cqiBand,
                }),
              );
              if (!rows.length) return toast?.('No clubs match — nothing to export', 'warn');
              exportRowsToXlsx('club-directory.xlsx', 'Clubs', rows).catch(() =>
                toast?.('Export failed — please retry', 'warn'),
              );
            }}
          >
            Export Excel
          </Btn>
          <Btn tone="ink" icon={Icon.Mail} size="sm" onClick={() => setShowShareLink(true)}>
            Invite clubs
          </Btn>
        </div>
      </div>

      {clubs.length === 0 ? (
        <EmptyCohort
          onShareLink={() => setShowShareLink(true)}
          onInviteAdmin={onInvite ? () => setShowInviteAdmin(true) : undefined}
        />
      ) : (
        <>
          {/* Cohort insights panel — CQI distribution, document compliance, resources required */}
          <ClubInsights
            clubs={clubs}
            submissionDeadline={submissionDeadline}
            requiredDocs={requiredDocs}
          />

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
              { k: 'affiliation_outstanding', label: 'Affiliation outstanding' },
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
                  const dc = docCompletion(c, requiredDocs);
                  const op = overallProgress(c, requiredDocs);
                  const band = cqiBand(c.cqi);
                  return (
                    <tr key={c.id} className="clickable" onClick={() => gotoClub(c.id)}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <ClubNameCell club={c} />
                          {c.nameChangePending && (
                            <span
                              style={{ whiteSpace: 'nowrap' }}
                              title={`Renamed from “${c.previousName || '—'}” — needs review`}
                            >
                              <Pill tone="gold" dot>
                                Renamed
                              </Pill>
                            </span>
                          )}
                        </div>
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
                      <td>{affPill(c.affiliation)}</td>
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

      {showShareLink && (
        <ShareSignupLinkModal
          signupLink={signupLink}
          onClose={() => setShowShareLink(false)}
          onGenerate={onGenerateSignupLink}
          onRevoke={onRevokeSignupLink}
          toast={toast}
        />
      )}
      {showInviteAdmin && (
        <InviteUserModal
          clubs={clubs}
          presetRole="admin"
          onClose={() => setShowInviteAdmin(false)}
          onInvite={onInvite}
          toast={toast}
        />
      )}
    </div>
  );
}

/* ─── ShareSignupLinkModal — the tenant-wide club self-registration link ───
   One link for the whole union: clubs open /signup?t=<token>, register
   themselves and appear in the cohort immediately. Generating a new link (or
   revoking) kills the previous token server-side at once. */
function ShareSignupLinkModal({ signupLink, onClose, onGenerate, onRevoke, toast }) {
  useEscapeClose(onClose);
  const baseUrl = (typeof window !== 'undefined' && window.location.origin) || '';
  const url = signupLink ? `${baseUrl}/signup?t=${signupLink.token}` : '';
  const [copied, setCopied] = useStateA(false);
  const [busy, setBusy] = useStateA(null); // null | 'generate' | 'revoke'

  const activeSince = signupLink ? formatStamp(signupLink.createdAt) : null;

  function doCopy() {
    if (!url) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
        toast && toast('Signup link copied');
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
        toast && toast('Signup link copied');
      } catch {}
      ta.remove();
    }
    setTimeout(() => setCopied(false), 2200);
  }

  // No recipient on either share — the link is union-wide, so the admin picks
  // who to send it to in their own client.
  const shareText = `Register your club for the season here: ${url}`;
  const mailtoUrl = `mailto:?subject=${encodeURIComponent('Register your club · 2026/27 season')}&body=${encodeURIComponent(shareText)}`;
  const waUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;

  async function run(kind, fn, doneMsg) {
    if (busy || !fn) return;
    setBusy(kind);
    try {
      await fn();
      toast && doneMsg && toast(doneMsg);
    } catch {
      /* the handler's withToast already surfaced the error */
    } finally {
      setBusy(null);
    }
  }
  const generate = () =>
    run(
      'generate',
      onGenerate,
      signupLink
        ? 'New signup link issued · the previous link no longer works'
        : 'Signup link generated · ready to share',
    );
  const revoke = () => run('revoke', onRevoke, 'Signup link revoked — no one can register with it');

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal narrow" style={{ maxWidth: 620 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Cohort · club self-registration</div>
            <div className="task-modal-head-title">
              Invite clubs · <em>share the signup link</em>
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          {!signupLink ? (
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
                No signup link yet
              </div>
              <p
                style={{
                  fontSize: 12.5,
                  color: 'var(--muted)',
                  maxWidth: 420,
                  margin: '0 auto 18px',
                }}
              >
                Generate one link for the whole union. Clubs open it, register themselves with their
                chairperson&apos;s details, and appear in your cohort immediately — no manual
                onboarding.
              </p>
              <Btn tone="teal" icon={Icon.Plus} onClick={generate} disabled={!!busy}>
                {busy === 'generate' ? 'Generating…' : 'Generate link'}
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
                  Club signup link
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
                  Active since {activeSince}
                </div>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 8,
                  marginBottom: 10,
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
                  <Icon.Mail /> Email
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
                  <Icon.Arrow /> WhatsApp
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
                  A club rep opens the link, registers the club and their own sign-in in one form,
                  then continues through affiliation → compliance documents → CQI. The club shows up
                  in your cohort the moment they submit.
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
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn tone="ghost" onClick={generate} disabled={!!busy}>
                    {busy === 'generate' ? 'Generating…' : '↻ Generate new link'}
                  </Btn>
                  <Btn tone="ghost" onClick={revoke} disabled={!!busy}>
                    {busy === 'revoke' ? 'Revoking…' : 'Revoke link'}
                  </Btn>
                </div>
                <Btn tone="ink" onClick={onClose}>
                  Done
                </Btn>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 8 }}>
                Generating a new link or revoking takes effect at once — the previous link stops
                working immediately.
              </div>
            </>
          )}
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

/* ─── ClubLeaguesEditor — admin assigns a club's leagues; one save, not one-per-toggle ─── */
function ClubLeaguesEditor({ club, allLeagues, onSave }) {
  const opts = leagueOptionsForDistrict(allLeagues, club.district);
  const initial = Array.isArray(club.leagues) ? club.leagues : [];
  const [sel, setSel] = useStateA(initial);
  const [busy, setBusy] = useStateA(false);
  // Re-sync local selection when the club's SAVED leagues actually change — keyed on
  // content, not array identity. The club record refetches constantly on this page
  // (phase status, comms log, sibling saves), and every refetch mints a new array with
  // the same keys; identity-keyed, that wiped in-progress chip toggles mid-edit and
  // made Save intermittently no-op (`dirty` flipped false under the click).
  const savedKey = initial.join('|');
  useEffectA(() => {
    setSel(Array.isArray(club.leagues) ? club.leagues : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

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
    // The rejection is already surfaced by the caller's toast — the catch here only
    // stops it becoming an unhandled rejection; busy must clear either way.
    Promise.resolve(onSave?.(sel))
      .catch(() => {})
      .finally(() => setBusy(false));
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
  onInvite,
  toast,
  allLeagues = [],
  requiredDocs = DEFAULT_REQUIRED_DOCS,
  onSetLeagues,
  onMarkCompliant,
  onRevertDoc,
  onAddNote,
  onUpdateChair,
  onSaveCqi,
  onRenameClub,
  onAcknowledgeRename,
  onDeleteClub,
  onReconfirmAffiliation,
  allSeries = [],
}) {
  // Hooks must run unconditionally — keep state before any early return.
  const [showLinkModal, setShowLinkModal] = useStateA(false);
  const [showInvite, setShowInvite] = useStateA(false);
  const [showCqi, setShowCqi] = useStateA(false);
  const [showCqiEdit, setShowCqiEdit] = useStateA(false);
  const [showAffiliation, setShowAffiliation] = useStateA(false);
  const [showDocPreview, setShowDocPreview] = useStateA(null);
  const [showCompliant, setShowCompliant] = useStateA(false);
  const [showChairEdit, setShowChairEdit] = useStateA(false);
  const [showNameEdit, setShowNameEdit] = useStateA(false);
  const [showRemove, setShowRemove] = useStateA(false);
  const [noteText, setNoteText] = useStateA('');
  const [noteBusy, setNoteBusy] = useStateA(false);
  if (!club) return null;
  const dc = docCompletion(club, requiredDocs);
  const op = overallProgress(club, requiredDocs);
  const band = cqiBand(club.cqi);
  // Team counts derive from the leagues entered on the affiliation form, summing the
  // per-league team counts (a club may field >1 side); club.teams/juniors are stale.
  const tc = teamCounts(club.leagues, allLeagues, club.leagueTeams);

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
      done: affiliationSubmitted(club),
      val: affiliationSubmitted(club) ? 100 : club.affiliation === 'in_progress' ? 40 : 0,
      detail: affiliationSubmitted(club)
        ? 'Submitted'
        : club.affiliation === 'in_progress'
          ? 'Draft saved · awaiting submission'
          : 'Awaiting submission',
    },
    {
      n: '02',
      t: 'League & Fixtures',
      done: affiliationSubmitted(club),
      val: affiliationSubmitted(club) ? 100 : 0,
      // Allocation is a fact once affiliated; only the done/progress track the gate.
      detail: affiliationSubmitted(club)
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
      detail: `${docsUploadedCount(club, requiredDocs)} of ${activeDocs(requiredDocs).length} docs uploaded`,
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
              {club.nameChangePending && (
                <div style={{ marginTop: 6 }}>
                  <Pill tone="gold" dot>
                    Renamed by club from “{club.previousName || '—'}”
                  </Pill>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="ph-actions">
          {club.nameChangePending && onAcknowledgeRename && (
            <Btn
              tone="teal"
              icon={Icon.Check}
              size="sm"
              onClick={async () => {
                await onAcknowledgeRename();
                toast && toast('Rename acknowledged');
              }}
            >
              Acknowledge rename
            </Btn>
          )}
          {club.amendmentPending && onReconfirmAffiliation && (
            <Btn
              tone="teal"
              icon={Icon.Check}
              size="sm"
              onClick={async () => {
                await onReconfirmAffiliation();
                toast && toast('Affiliation re-confirmed');
              }}
            >
              Re-confirm affiliation
            </Btn>
          )}
          <Btn tone="outline" icon={Icon.Form} size="sm" onClick={() => setShowNameEdit(true)}>
            Edit name
          </Btn>
          <Btn tone="outline" icon={Icon.Form} size="sm" onClick={() => setShowChairEdit(true)}>
            Edit chairperson
          </Btn>
          <Btn tone="outline" icon={Icon.Mail} size="sm" onClick={emailChair}>
            Email chairperson
          </Btn>
        </div>
      </div>

      <div className="kpi-strip">
        <KPI tone="navy" label="Overall progress" num={op + '%'} sub="all phases" />
        <KPI
          tone={club.amendmentPending || club.affiliation === 'in_progress' ? 'gold' : 'teal'}
          label="Affiliation"
          num={
            club.amendmentPending
              ? 'Amended'
              : affiliationSubmitted(club)
                ? 'Submitted'
                : club.affiliation === 'in_progress'
                  ? 'In progress'
                  : 'Pending'
          }
          sub={
            club.amendmentPending
              ? 'Edited — re-confirm'
              : affiliationSubmitted(club)
                ? 'Form complete'
                : club.affiliation === 'in_progress'
                  ? 'Draft saved · not submitted'
                  : 'Awaiting submission'
          }
        />
        <KPI
          tone="gold"
          label="Documents"
          num={`${docsUploadedCount(club, requiredDocs)}/${activeDocs(requiredDocs).length}`}
          sub="compliance docs"
        />
        <KPI
          tone={band.tone === 'coral' ? 'coral' : ''}
          label="CQI score"
          num={club.cqi.toFixed(1)}
          sub={band.label}
        />
        <KPI label="Players" num={club.players} sub={`${tc.senior} teams · ${tc.junior} junior`} />
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
            {activeDocs(requiredDocs).map((d) => {
              const up = club.docs[d.key];
              // Real uploads carry docMeta with an objectKey; an admin "Mark as
              // compliant" override sets the flag true with a markedCompliant
              // sentinel (no file). docFileMeta never fabricates a filename for the
              // latter. A multi-file doc (the safeguarding pattern) — render its
              // stored files as sub-rows.
              const meta = club.docMeta?.[d.key];
              const multi = !!d.multiFile;
              const sg = multi ? safeguardingMeta(meta) : null;
              const { real, metaText } = docFileMeta(meta);
              const sgSatisfied = sg ? sg.files.length >= docMinFiles(d) : false;
              // A booked meeting (the AGM pattern, single-file only) is a club
              // self-declaration (future meeting date), not an admin override — it must
              // render as its own state, never "Override", and is not revertable by the
              // admin (the club self-clears via Undo on its portal).
              const agm = !multi && d.allowMeetingBooked ? agmMeta(meta) : null;
              const agmBooked = !!agm?.meetingBooked;
              const agmDateLabel = agm?.meetingDate && formatDayYear(agm.meetingDate);
              // Multi-file "override" = any compliant flag the uploads don't
              // justify: explicit sentinel, legacy flag-only (no docMeta — the
              // seeded demo clubs), or a grandfathered single file. All revert.
              const override = sg ? up && !sgSatisfied : up && !real && !agmBooked;
              // A lingering sentinel on a club that later met the minimum on its
              // own shows Approved but must stay revertable.
              const canRevert = override || (sg ? up && sg.markedCompliant : false);
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
                      {sg ? (
                        sg.files.length ? (
                          <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {sg.files.map((f) => (
                              <span key={f.objectKey}>
                                {docFileMeta(f).metaText || 'Document'} ·{' '}
                                {/* Button, not <a onClick>: per-file actions must be
                                    keyboard-focusable. */}
                                <button
                                  type="button"
                                  onClick={() => setShowDocPreview({ key: d.key, entry: f })}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    padding: 0,
                                    font: 'inherit',
                                    color: 'var(--teal-deep)',
                                    cursor: 'pointer',
                                  }}
                                >
                                  View
                                </button>
                              </span>
                            ))}
                          </span>
                        ) : override ? (
                          'Marked compliant — no files on record'
                        ) : (
                          'Not yet uploaded · awaiting club'
                        )
                      ) : agmBooked ? (
                        `No minutes yet — AGM to be held on ${agmDateLabel}`
                      ) : real ? (
                        metaText
                      ) : override ? (
                        'Marked compliant — no file on record'
                      ) : (
                        'Not yet uploaded · awaiting club'
                      )}
                    </div>
                  </div>
                  {up || (sg && sg.files.length > 0) ? (
                    <div className="doc-row-actions">
                      <Pill tone={override || agmBooked || (sg && !up) ? 'gold' : 'teal'} dot>
                        {sg && !up
                          ? `${sg.files.length} of ${docMinFiles(d)} minimum`
                          : agmBooked
                            ? `Meeting booked · ${agmDateLabel}`
                            : override
                              ? 'Override'
                              : 'Approved'}
                      </Pill>
                      {/* Only real uploads (with a stored file) can be previewed;
                          overrides have no file on record. Safeguarding previews
                          per-file via the links above. */}
                      {!sg && real && (
                        <Btn
                          tone="ghost"
                          size="sm"
                          icon={Icon.Eye}
                          title={`View ${d.name}`}
                          onClick={() => setShowDocPreview({ key: d.key })}
                        />
                      )}
                      {/* Override = compliant via admin flag; offer a lossless revert.
                          Real uploads (Approved) never show this — their files can't
                          be reverted away (safeguarding keeps its files on revert). */}
                      {canRevert && onRevertDoc && (
                        <Btn
                          tone="ghost"
                          size="sm"
                          onClick={() => onRevertDoc(d.key)}
                          title="Remove this override — compliance re-derives from uploads"
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
                  // Real per-category score from the club's effective answers (governance is
                  // auto-filled from docs + stored overlays, so score the merged view, not raw
                  // cqiAnswers). Falls back to a proportional estimate only for legacy clubs
                  // that have a score but no persisted answers.
                  const byCat = club.cqiAnswers ? scoreCQI(effectiveAnswers(club)).byCat : null;
                  const score = byCat
                    ? byCat[cat.key].earned
                    : Math.min(cat.weight, cat.weight * Math.min(1, club.cqi / 100));
                  return (
                    <div
                      key={cat.key}
                      className="score-card"
                      style={
                        {
                          '--fill': (score / cat.weight) * 100 + '%',
                          '--accent': cat.accent,
                        } as CSSProperties
                      }
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
            {/* Governance & Compliance answers — auto-filled from this club's compliance
                documents and records, with any club override flagged. Lets admins see exactly
                what was declared without opening the club portal. */}
            {club.cqi > 0 &&
              (() => {
                const gov = CQI_STRUCTURE.find((c) => c.key === 'governance');
                if (!gov) return null;
                const eff = effectiveAnswers(club);
                // A genuine club override (not a legacy approximation) — drives the provenance tag.
                const genuine = genuineCqiAnswers(club);
                return (
                  <div style={{ marginTop: 16 }}>
                    <div
                      style={{
                        fontSize: 11,
                        textTransform: 'uppercase',
                        letterSpacing: '0.1em',
                        color: 'var(--muted-2)',
                        marginBottom: 8,
                      }}
                    >
                      Governance &amp; Compliance · auto-filled
                    </div>
                    <div className="stack" style={{ gap: 6 }}>
                      {gov.questions.map((q) => {
                        const yes = eff[q.key] === true;
                        const edited = q.key in genuine;
                        return (
                          <div
                            key={q.key}
                            className="row"
                            style={{ justifyContent: 'space-between', gap: 12 }}
                          >
                            <span style={{ fontSize: 13, color: 'var(--ink)' }}>{q.label}</span>
                            <span className="row" style={{ gap: 8 }}>
                              <span
                                style={{
                                  fontSize: 10,
                                  textTransform: 'uppercase',
                                  letterSpacing: '0.08em',
                                  color: 'var(--muted-2)',
                                }}
                              >
                                {edited ? 'Edited' : 'Auto'}
                              </span>
                              <Pill tone={yes ? 'teal' : 'gold'} dot>
                                {yes ? 'Yes' : 'No'}
                              </Pill>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            {/* Chairperson motivation — informational multi-select captured on the CQI form
                (cqiAnswers.involvementReasons). Shown whenever present, independent of whether
                a CQI score has been submitted, so drafts surface too. */}
            {(() => {
              const reasons = genuineCqiAnswers(club).involvementReasons;
              if (!Array.isArray(reasons) || !reasons.length) return null;
              return (
                <div style={{ marginTop: 16 }}>
                  <div
                    style={{
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: '0.1em',
                      color: 'var(--muted-2)',
                      marginBottom: 8,
                    }}
                  >
                    Chairperson · why involved in club cricket
                  </div>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                    {reasons.map((r) => (
                      <Pill key={String(r)} tone="teal">
                        {String(r)}
                      </Pill>
                    ))}
                  </div>
                </div>
              );
            })()}
          </Card>
        </div>

        <div className="stack">
          <Card title="Club details">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 18px' }}>
              {[
                // The affiliation form captures one "Municipal District / Sub-Union"
                // field, so a separate Sub-union row would just repeat District.
                ['District', club.district || club.sub],
                ['Chairperson', club.chair],
                [
                  'Status',
                  affiliationSubmitted(club)
                    ? 'Active member'
                    : club.affiliation === 'in_progress'
                      ? 'In progress'
                      : 'Pending',
                ],
                ['Senior teams', tc.senior],
                ["Women's teams", tc.women],
                ['Junior teams', tc.junior],
                ['Players', club.players],
                // Provenance: clubs created through the tenant-wide signup link
                // stamp onboardedVia server-side; admin-era clubs have no row.
                ...(club.onboardedVia === 'self-signup' ? [['Registered via', 'Signup link']] : []),
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
                // Comm-log entries are INSTANTS — render the local calendar day, or a
                // 01:00 SAST send shows as the previous date.
                const fmtDate = (iso) => formatStampDay(iso);
                // Real communication: admin-added notes + actual invite sends, merged
                // newest-first by timestamp.
                const noteItems = (club.notes || []).map((n) => ({
                  tone: 'navy',
                  t: n.text,
                  d: `${fmtDate(n.at)} · ${n.author}`,
                  _at: n.at,
                }));
                const commLabels = {
                  invite: 'Onboarding invite',
                  reglink: 'Registration link',
                  clearance: 'Clearance notice',
                  'clearance-approved': 'Clearance approved notice',
                  'clearance-rejected': 'Clearance rejected notice',
                  'clearance-reopened': 'Clearance reopened notice',
                  fixtures: 'Fixtures shared with players',
                };
                const sendItems = (club.commLog || []).map((e) => {
                  const isFixtures = e.kind === 'fixtures';
                  const label = commLabels[e.kind ?? 'invite'] ?? commLabels.invite;
                  // Fixtures broadcasts carry a PII-free count summary; invites name the recipient.
                  const detail = isFixtures
                    ? e.summary
                      ? ` · ${e.summary}`
                      : ''
                    : `${e.to ? ` → ${e.to}` : ''}${e.error ? ` (${e.error})` : ''}`;
                  return {
                    tone: e.status === 'sent' ? 'teal' : 'gold',
                    t: `${label} ${e.status} · ${e.channel === 'email' ? 'Email' : 'WhatsApp'}${detail}`,
                    d: `${fmtDate(e.at)} · ${e.by}`,
                    _at: e.at,
                  };
                });
                const notes = [...noteItems, ...sendItems].sort((a, b) =>
                  a._at < b._at ? 1 : a._at > b._at ? -1 : 0,
                );
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
                icon={club.cqi === 0 ? Icon.Form : Icon.Eye}
                onClick={() => setShowCqi(true)}
              >
                {club.cqi === 0 ? 'Record CQI form' : 'View submitted CQI form'}
              </Btn>
              {club.cqi > 0 && (
                <Btn tone="outline" icon={Icon.Form} onClick={() => setShowCqiEdit(true)}>
                  Edit CQI form
                </Btn>
              )}
              <Btn tone="outline" icon={Icon.Eye} onClick={() => setShowAffiliation(true)}>
                View affiliation form
              </Btn>
              <Btn tone="outline" icon={Icon.Shield} onClick={() => setShowCompliant(true)}>
                Mark as compliant
              </Btn>
              <Btn
                tone="outline"
                icon={Icon.X}
                onClick={() => setShowRemove(true)}
                style={{ color: 'var(--coral)', borderColor: 'var(--coral)' }}
              >
                Remove club
              </Btn>
            </div>
          </Card>
        </div>
      </div>

      {showLinkModal && (
        <RegLinkModal
          club={club}
          onClose={() => setShowLinkModal(false)}
          onRegenerate={handleGenerate}
          toast={toast}
        />
      )}
      {showInvite && (
        <InviteUserModal
          clubs={[club]}
          presetClubId={club.id}
          presetRole="rep"
          onClose={() => setShowInvite(false)}
          onInvite={onInvite}
          toast={toast}
        />
      )}
      {showCqi && (
        <CqiViewModal
          club={club}
          toast={toast}
          onSave={onSaveCqi}
          initialEditing={club.cqi === 0}
          onClose={() => setShowCqi(false)}
        />
      )}
      {showCqiEdit && (
        <CqiViewModal
          club={club}
          toast={toast}
          onSave={onSaveCqi}
          initialEditing={true}
          onClose={() => setShowCqiEdit(false)}
        />
      )}
      {showDocPreview && (
        <DocPreviewModal
          clubId={club.id}
          docKey={showDocPreview.key}
          docName={requiredDocs.find((d) => d.key === showDocPreview.key)?.name || 'Document'}
          clubName={club.name}
          // Safeguarding passes the selected file entry (the wrapper has no
          // objectKey of its own); single-file docs pass their stored meta.
          meta={showDocPreview.entry ?? club.docMeta?.[showDocPreview.key]}
          objectKey={showDocPreview.entry?.objectKey}
          onClose={() => setShowDocPreview(null)}
        />
      )}
      {showAffiliation && (
        <AffiliationViewModal
          club={club}
          allLeagues={allLeagues}
          onClose={() => setShowAffiliation(false)}
        />
      )}
      {showCompliant && (
        <ConfirmModal
          title="Mark all documents compliant?"
          body="This overrides the compliance documents as present for this club — without an uploaded file on record. Use only when you've verified compliance offline."
          confirmLabel="Mark compliant"
          onConfirm={() => {
            setShowCompliant(false);
            onMarkCompliant && onMarkCompliant();
          }}
          onClose={() => setShowCompliant(false)}
        />
      )}
      {showNameEdit && (
        <ClubNameModal
          club={club}
          toast={toast}
          onClose={() => setShowNameEdit(false)}
          onSave={(name) =>
            Promise.resolve(onRenameClub?.(name)).then(() => setShowNameEdit(false))
          }
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
      {showRemove && (
        <RemoveClubModal
          club={club}
          allSeries={allSeries}
          requiredDocs={requiredDocs}
          onClose={() => setShowRemove(false)}
          // Success navigates back to the clubs list (the parent handler owns
          // that), which unmounts this whole view — no need to close here.
          onConfirm={() => onDeleteClub?.(club.id)}
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

/* ─── RemoveClubModal — type-the-name confirm for the product's most destructive
   action (child ID-doc PII + Cognito accounts go with the club). A plain
   ConfirmModal is too easy to click through, so the confirm button stays
   disabled until the admin types the club's exact name. ─── */
function RemoveClubModal({
  club,
  allSeries = [],
  requiredDocs = DEFAULT_REQUIRED_DOCS,
  onClose,
  onConfirm,
}) {
  useEscapeClose(onClose);
  const [typed, setTyped] = useStateA('');
  const [busy, setBusy] = useStateA(false);
  // Exact match (trimmed, case-sensitive) — the friction is the point.
  const match = typed.trim() === club.name;
  // A multi-team club participates under its `tm_…` ids, so test the club's resolved
  // team set — not just its clubId — or the delete-safety friction would be skipped.
  const inReleased = allSeries.some(
    (s) =>
      s.released &&
      Array.isArray(s.teams) &&
      teamIdsForClub(s, club.id).some((tid) => s.teams.includes(tid)),
  );
  const playerCount = club.players || 0;
  const docCount = docsUploadedCount(club, requiredDocs);
  function confirm() {
    if (!match || busy) return;
    setBusy(true);
    // Success navigates away and unmounts the whole detail view; only failure
    // (already toasted by the parent's withToast) needs the button back.
    Promise.resolve(onConfirm()).catch(() => setBusy(false));
  }
  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal narrow" style={{ maxWidth: 460 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-title">Remove {club.name}?</div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <p style={{ fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.55, margin: 0 }}>
            This permanently deletes the club and everything stored under it:{' '}
            <strong>
              {playerCount} registered {playerCount === 1 ? 'player' : 'players'}
            </strong>{' '}
            (including ID documents) and{' '}
            <strong>
              {docCount} compliance {docCount === 1 ? 'document' : 'documents'}
            </strong>
            , plus any clearance history.
          </p>
          {inReleased && (
            <p style={{ fontSize: 12.5, color: 'var(--coral)', lineHeight: 1.5, marginTop: 10 }}>
              This club is named in released fixtures — published schedules will show &ldquo;Removed
              club&rdquo; in its place.
            </p>
          )}
          <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, marginTop: 10 }}>
            Reps whose only club this is lose sign-in access entirely. This can&apos;t be undone.
          </p>
          <label style={{ display: 'block', marginTop: 14 }}>
            <span className="reg-label">Type the club name to confirm</span>
            <input
              className="field-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && confirm()}
              placeholder={club.name}
              autoFocus
              style={{ width: '100%' }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
            <Btn tone="outline" size="sm" onClick={onClose}>
              Cancel
            </Btn>
            <Btn
              tone="ink"
              size="sm"
              onClick={confirm}
              disabled={!match || busy}
              style={{ background: 'var(--coral)', opacity: !match || busy ? 0.5 : 1 }}
            >
              {busy ? 'Removing…' : 'Remove club'}
            </Btn>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── CqiViewModal — view (and, for admins, correct) a club's CQI self-assessment ─── */
function CqiViewModal({ club, onClose, onSave, toast, initialEditing = false }) {
  // Seed once from effectiveAnswers so the auto-filled Governance & Compliance answers
  // render/edit (they're not persisted in cqiAnswers — only genuine overrides are), and so
  // the cache reseed a save triggers can't clobber in-progress edits. The empty-state gate
  // still keys off the raw stored answers, so a legacy club with a bare score isn't shown a
  // grid built purely from derived governance values.
  const [seed] = useStateA(() => effectiveAnswers(club));
  const [answers, setAnswers] = useStateA(seed);
  const [editing, setEditing] = useStateA(!!onSave && initialEditing);
  const [busy, setBusy] = useStateA(false);
  const hasAnswers = Object.keys(club.cqiAnswers || {}).length > 0;
  // Loose compare — money/count atoms emit numbers where stored values may be strings.
  const same = (a, b) => String(a ?? '') === String(b ?? '');
  const dirty = [...new Set([...Object.keys(seed), ...Object.keys(answers)])].some(
    (k) => !same(seed[k], answers[k]),
  );
  const recordMode = club.cqi === 0;
  // In record mode a club's complete draft is submittable untouched — the save still
  // materially changes state (cqi 0 → score, flipping the club to "submitted"). A blank
  // form still needs at least one answer entered before it can be recorded.
  const canSave = dirty || (recordMode && hasAnswers);
  // A stray Escape, backdrop click or header X must not discard a long-form edit —
  // dismissal while dirty requires the explicit Cancel/Save buttons.
  const guardedClose = () => {
    if (!(editing && dirty)) onClose();
  };
  useEscapeClose(guardedClose);
  const liveScore = scoreCQI(answers).total;
  const band = cqiBand(editing ? liveScore : club.cqi);
  const derived = deriveGovernance(club);
  const setA = (key, v) => setAnswers((a) => ({ ...a, [key]: v }));

  function save() {
    if (!canSave || busy) return;
    setBusy(true);
    // Resolve(onSave) so a rejected save (e.g. a 409 version conflict surfaced by the
    // parent's withToast) keeps the modal open for retry rather than closing.
    Promise.resolve(onSave({ cqi: liveScore, cqiAnswers: governanceOverrides(answers, club) }))
      .then(() => {
        toast && toast(`CQI ${recordMode ? 'recorded' : 'updated'} · ${cqiBand(liveScore).label}`);
        onClose();
      })
      .catch(() => setBusy(false));
  }

  // Render each answer by its question kind so booleans, counts, percentages,
  // choices and money all read correctly (iterate the structure, not the answers,
  // so nothing is orphaned).
  const fmt = (q) => {
    const v = answers[q.key];
    if (v == null || v === '') return '—';
    if (q.kind === 'yn') return v ? 'Yes' : 'No';
    if (q.kind === 'rating') return `${v} / 5`;
    if (q.kind === 'money') return `${q.currency || 'R'} ${Number(v).toLocaleString()}`;
    return String(v);
  };
  const input = (q) => {
    const v = answers[q.key];
    if (q.kind === 'yn') return <YN value={v} onChange={(x) => setA(q.key, x)} />;
    if (q.kind === 'rating') return <Rating value={v} onChange={(x) => setA(q.key, x)} />;
    if (q.kind === 'num')
      return <NumSlider value={v} onChange={(x) => setA(q.key, x)} max={q.max} />;
    if (q.kind === 'count')
      return <CountInput value={v} onChange={(x) => setA(q.key, x)} label={q.label} />;
    if (q.kind === 'choice')
      return <Choice value={v} onChange={(x) => setA(q.key, x)} options={q.options} />;
    if (q.kind === 'money')
      return (
        <MoneyInput
          value={v}
          onChange={(x) => setA(q.key, x)}
          currency={q.currency || 'R'}
          suffix="/ player"
        />
      );
    return null;
  };

  return createPortal(
    <div
      className="task-modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && guardedClose()}
    >
      <div className="task-modal" style={{ maxWidth: 620 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">
              {editing && recordMode ? 'Record CQI' : 'Submitted CQI'} · {club.name}
            </div>
            <div className="task-modal-head-title">
              CQI <em>self-assessment</em> · {band.label}
            </div>
          </div>
          <button className="task-modal-close" onClick={guardedClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          {editing && !hasAnswers && club.cqi > 0 && (
            <p
              style={{ margin: '0 0 14px', fontSize: 12.5, color: 'var(--coral)', lineHeight: 1.5 }}
            >
              This club&apos;s score of {club.cqi.toFixed(1)} predates itemised answers. Saving will
              replace it with the score computed from the answers entered below.
            </p>
          )}
          {editing && recordMode && hasAnswers && (
            <p
              style={{ margin: '0 0 14px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}
            >
              Draft answers on file — the pre-filled values below are the club&apos;s in-progress
              draft. Saving submits the form on the club&apos;s behalf.
            </p>
          )}
          {!hasAnswers && !editing ? (
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
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          gap: 12,
                          fontSize: 12.5,
                          padding: '4px 0',
                          borderBottom: '1px solid var(--line2)',
                        }}
                      >
                        <span style={{ color: 'var(--muted)', flex: '1 1 220px' }}>
                          {q.label}
                          {/* Governance provenance — untouched answers keep tracking the
                              documents live; only a real disagreement persists. */}
                          {editing && q.key in derived && (
                            <span
                              style={{
                                marginLeft: 8,
                                fontSize: 10,
                                textTransform: 'uppercase',
                                letterSpacing: '0.08em',
                                color: 'var(--muted-2)',
                              }}
                            >
                              {answers[q.key] === derived[q.key] ? 'Auto' : 'Edited'}
                            </span>
                          )}
                        </span>
                        {editing ? (
                          input(q)
                        ) : (
                          <span
                            style={{ color: 'var(--ink)', fontWeight: 600, whiteSpace: 'nowrap' }}
                          >
                            {fmt(q)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {onSave && (
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
              {editing ? (
                <>
                  <Btn
                    tone="outline"
                    onClick={() => {
                      // In record mode there's no meaningful read-only view to fall back to.
                      if (initialEditing) return onClose();
                      setAnswers(seed);
                      setEditing(false);
                    }}
                  >
                    Cancel
                  </Btn>
                  <Btn tone="teal" icon={Icon.Check} disabled={!canSave || busy} onClick={save}>
                    {busy ? 'Saving…' : recordMode ? 'Record CQI' : 'Save CQI'}
                  </Btn>
                </>
              ) : (
                <Btn tone="outline" icon={Icon.Form} onClick={() => setEditing(true)}>
                  Edit answers
                </Btn>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── AffiliationViewModal — read-only view of a club's affiliation form ─── */
function AffiliationViewModal({ club, allLeagues, onClose }) {
  const ex = club.exco || {};
  // Pull the four named office-bearers plus any additional members into one list,
  // dropping unset roles so an awaiting club doesn't show empty officer blocks.
  const members = [
    ['Chairperson', ex.chair],
    ['Secretary', ex.sec],
    ['Treasurer', ex.tre],
    ['Vice-chair', ex.vc],
    ...(Array.isArray(ex.additionalMembers) ? ex.additionalMembers.map((m) => ['Member', m]) : []),
  ].filter(([, m]) => m);
  const leagues = club.leagues || [];
  const coaches = club.coaches || [];
  // teamId → name across all rosters, for showing a coach's specific side assignments.
  const teamNameById = {};
  for (const roster of Object.values(club.teamRosters || {})) {
    if (Array.isArray(roster)) for (const t of roster) teamNameById[t.id] = t.name;
  }
  // Distinguish "form not yet submitted" from "submitted, but this club genuinely
  // registered none." Empty Leagues/Coaches under an "Affiliated" status is a real
  // answer, not a pending one — saying "Not yet submitted" there would contradict
  // the status pill above it.
  const submitted =
    members.length > 0 ||
    leagues.length > 0 ||
    coaches.length > 0 ||
    club.affiliation === 'complete' ||
    club.affiliation === 'in_progress';
  const emptyText = submitted ? 'None recorded' : 'Not yet submitted';

  const SectionTitle = ({ children }) => (
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
      {children}
    </div>
  );
  const Row = ({ label, value }) => (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        fontSize: 12.5,
        padding: '4px 0',
        borderBottom: '1px solid var(--line2)',
      }}
    >
      <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{label}</span>
      <span
        style={{
          color: 'var(--ink)',
          fontWeight: 600,
          textAlign: 'right',
          wordBreak: 'break-word',
          minWidth: 0,
        }}
      >
        {value == null || value === '' ? '—' : value}
      </span>
    </div>
  );
  // An empty collection renders one muted line; the wording reflects whether the
  // form has been submitted yet (see `emptyText` above).
  const Empty = () => (
    <div style={{ fontSize: 12.5, padding: '4px 0', color: 'var(--muted)' }}>{emptyText}</div>
  );

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal" style={{ maxWidth: 620 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Affiliation · {club.name}</div>
            <div className="task-modal-head-title">
              Affiliation <em>form</em>
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <div className="stack" style={{ gap: 16 }}>
            {/* Club */}
            <div>
              <SectionTitle>Club</SectionTitle>
              <div className="stack" style={{ gap: 4 }}>
                <Row label="Name" value={club.name} />
                <Row label="District" value={club.district} />
                <Row label="Sub-union" value={club.district || club.sub} />
                <Row label="Chairperson" value={club.chair} />
                <Row label="Status" value={affPill(club.affiliation)} />
              </div>
              {club.affiliation === 'in_progress' && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
                  Draft — saved by the club but <strong>not yet submitted</strong>. The details
                  below are work in progress and may still change.
                </div>
              )}
            </div>

            {/* Exco */}
            <div>
              <SectionTitle>Exco</SectionTitle>
              {members.length === 0 ? (
                <Empty />
              ) : (
                <div className="stack" style={{ gap: 12 }}>
                  {members.map(([role, m], i) => (
                    <div key={`${role}-${i}`}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: 'var(--ink)',
                          marginBottom: 2,
                        }}
                      >
                        {role}
                      </div>
                      <Row label="Name" value={m.name} />
                      <Row label="Email" value={m.email} />
                      <Row label="Cell" value={m.cell} />
                      <Row label="Gender" value={m.gender} />
                      <Row label="Race" value={m.race} />
                      {role === 'Chairperson' && (
                        <>
                          <Row label="ID number" value={m.idNumber} />
                          <Row
                            label="Age"
                            value={
                              ageFromSaId(m.idNumber) != null
                                ? `${ageFromSaId(m.idNumber)} yrs`
                                : ''
                            }
                          />
                          <Row label="Term start" value={m.termStart} />
                          <Row label="Term end" value={m.termEnd} />
                          <Row label="Term remaining" value={termRemaining(m.termEnd).label} />
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Leagues */}
            <div>
              <SectionTitle>Leagues</SectionTitle>
              {leagues.length === 0 ? (
                <Empty />
              ) : (
                <div className="stack" style={{ gap: 4 }}>
                  {leagues.map((k) => {
                    const count = Math.max(1, Number(club.leagueTeams?.[k]) || 1);
                    const roster = Array.isArray(club.teamRosters?.[k]) ? club.teamRosters[k] : [];
                    const value =
                      count >= 2
                        ? roster.length
                          ? roster.map((t) => t.name).join(', ')
                          : `${count} teams`
                        : 'Registered';
                    return (
                      <Row
                        key={k}
                        label={allLeagues.find((l) => l.key === k)?.label || k}
                        value={value}
                      />
                    );
                  })}
                </div>
              )}
            </div>

            {/* Coaches */}
            <div>
              <SectionTitle>Coaches</SectionTitle>
              {coaches.length === 0 ? (
                <Empty />
              ) : (
                <div className="stack" style={{ gap: 12 }}>
                  {coaches.map((c, i) => (
                    <div key={i}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: 'var(--ink)',
                          marginBottom: 2,
                        }}
                      >
                        {c.name || 'Coach'}
                      </div>
                      <Row label="Email" value={c.email} />
                      <Row label="Cell" value={c.cell} />
                      <Row label="Level" value={c.level} />
                      <Row label="ID number" value={c.idNumber} />
                      <Row label="Coaching since" value={c.yearStarted} />
                      <Row label="Experience" value={c.yearsExperience} />
                      <Row label="Teams" value={Array.isArray(c.teams) ? c.teams.join(', ') : ''} />
                      {Array.isArray(c.teamIds) && c.teamIds.length > 0 && (
                        <Row
                          label="Sides"
                          value={c.teamIds.map((id) => teamNameById[id] || id).join(', ')}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Ground */}
            <div>
              <SectionTitle>Ground</SectionTitle>
              <div className="stack" style={{ gap: 4 }}>
                <Row label="Venue" value={club.ground?.venue} />
                <Row label="Address" value={club.ground?.address} />
                <Row label="Suburb" value={club.ground?.suburb} />
                <Row label="Secondary venue" value={club.ground?.secondaryVenue} />
                <Row label="Secondary address" value={club.ground?.secondaryAddress} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── ClubMultiSelect — scrollable checkbox list of clubs (shared by invite / scope edit) ───
   `value` is a Set of selected club ids; `onChange` receives the next Set. */
function ClubMultiSelect({ clubs, value, onChange }) {
  function toggle(id) {
    const next = new Set(value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }
  if (!clubs || clubs.length === 0) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        No clubs to assign yet — a rep needs at least one club. Invite an administrator instead.
      </div>
    );
  }
  return (
    <div
      style={{
        maxHeight: 200,
        overflowY: 'auto',
        border: '1px solid var(--line)',
        borderRadius: 10,
        background: 'var(--white)',
      }}
    >
      {clubs.map((c, i) => {
        const checked = value.has(c.id);
        return (
          <label
            key={c.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              borderBottom: i < clubs.length - 1 ? '1px solid var(--line)' : 'none',
              background: checked ? 'rgba(15,143,74,0.06)' : 'var(--white)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggle(c.id)}
              style={{
                width: 16,
                height: 16,
                cursor: 'pointer',
                flexShrink: 0,
                accentColor: 'var(--teal-deep)',
              }}
            />
            <span
              style={{
                fontFamily: "'Montserrat',sans-serif",
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--ink)',
              }}
            >
              {c.name}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/* ─── ChannelToggles — email / WhatsApp send selection (defaults both on) ─── */
function ChannelToggles({ value, onChange }) {
  const opt = (key, label) => {
    const on = value[key];
    return (
      <button
        type="button"
        onClick={() => onChange({ ...value, [key]: !on })}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 700,
          fontFamily: "'Montserrat',sans-serif",
          cursor: 'pointer',
          border: '1px solid ' + (on ? 'var(--green)' : 'var(--line)'),
          background: on ? 'var(--green-pale)' : 'var(--white)',
          color: on ? 'var(--green)' : 'var(--muted-2)',
        }}
      >
        {on && <Icon.Check />}
        {label}
      </button>
    );
  };
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {opt('email', 'Email')}
      {opt('whatsapp', 'WhatsApp')}
    </div>
  );
}

const chLabel = (ch) => (ch === 'email' ? 'email' : 'WhatsApp');

/* ─── InviteUserModal — admin invites an admin/rep to this tenant ───
   Decoupled from a single club: `clubs` feeds the rep club multi-select; `presetClubId`
   pre-selects one club and `presetRole` seeds the role. On success it shows the real
   outcome — a copyable login link plus per-channel send results. */
interface InviteUserModalProps {
  clubs?: any[];
  presetClubId?: string;
  presetRole?: string;
  onClose: () => void;
  onInvite: (body: any) => Promise<any>;
  toast: (msg: string, tone?: string) => void;
}
function InviteUserModal({
  clubs = [],
  presetClubId,
  presetRole,
  onClose,
  onInvite,
  toast,
}: InviteUserModalProps) {
  const canRep = clubs.length > 0;
  const [email, setEmail] = useStateA('');
  const [role, setRole] = useStateA(canRep ? presetRole || 'rep' : 'admin');
  const [clubIds, setClubIds] = useStateA(() => new Set(presetClubId ? [presetClubId] : []));
  const [channels, setChannels] = useStateA({ email: true, whatsapp: true });
  const [busy, setBusy] = useStateA(false);
  const [copied, setCopied] = useStateA(false);
  // null until the account is created; then { loginUrl, results, email }.
  const [result, setResult] = useStateA(null);

  const emailValid = EMAIL_RE.test(email.trim().toLowerCase());
  const repNeedsClub = role === 'rep' && clubIds.size === 0;
  // No channel selected is allowed: the account is still created and the login link can be
  // copied/shared out-of-band (the server skips sending when `channels` is omitted).
  const canSubmit = !busy && emailValid && !repNeedsClub;
  const chansSelected = channels.email || channels.whatsapp;

  async function submit() {
    if (!canSubmit || !onInvite) return;
    setBusy(true);
    try {
      const chans = ['email', 'whatsapp'].filter((c) => channels[c]);
      const cleanEmail = email.trim().toLowerCase();
      const link = window.location.origin + '/?email=' + encodeURIComponent(cleanEmail);
      const res = await onInvite({
        email: cleanEmail,
        role,
        clubIds: role === 'rep' ? [...clubIds] : [],
        // Omit `channels` entirely when none are selected — the server rejects an explicit
        // empty array but skips sending (and just returns the login link) when it's absent.
        ...(chans.length ? { channels: chans } : {}),
        link,
      });
      setResult({
        loginUrl: res?.loginUrl || link,
        results: res?.results || [],
        email: cleanEmail,
      });
    } catch {
      /* withToast already surfaced the error */
    } finally {
      setBusy(false);
    }
  }

  function doCopy() {
    const url = result?.loginUrl;
    if (!url) return;
    const ok = () => {
      setCopied(true);
      toast && toast('Login link copied to clipboard');
      setTimeout(() => setCopied(false), 2200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(ok);
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        ok();
      } catch {
        /* clipboard unavailable */
      }
      ta.remove();
    }
  }

  const presetClub = presetClubId ? clubs.find((c) => c.id === presetClubId) : null;
  const eyebrow = presetClub ? `Invite · ${presetClub.name}` : 'Team & Access';

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal narrow" style={{ maxWidth: 480 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">{eyebrow}</div>
            <div className="task-modal-head-title">
              Invite an <em>admin or rep</em>
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          {result ? (
            <div className="stack" style={{ gap: 14 }}>
              <div>
                <p style={{ fontSize: 14, color: 'var(--ink)', margin: 0 }}>
                  Account created for <strong>{result.email}</strong>.
                </p>
                <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>
                  They sign in with their email — a one-time code is sent on first login. No
                  password needed.
                </p>
              </div>
              <div>
                <div className="field-label" style={{ marginBottom: 4 }}>
                  Login link
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="field-input"
                    readOnly
                    value={result.loginUrl}
                    onFocus={(e) => e.target.select()}
                    style={{ flex: 1, fontSize: 13 }}
                  />
                  <Btn tone="outline" size="sm" icon={Icon.Doc} onClick={doCopy}>
                    {copied ? 'Copied' : 'Copy'}
                  </Btn>
                </div>
              </div>
              {result.results.length > 0 ? (
                <div className="stack" style={{ gap: 6 }}>
                  {result.results.map((r) => (
                    <div
                      key={r.channel}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}
                    >
                      <Pill tone={r.status === 'sent' ? 'teal' : 'gold'} dot>
                        {chLabel(r.channel)} {r.status}
                      </Pill>
                      {(r.summary || r.error) && (
                        <span style={{ color: 'var(--muted)' }}>{r.summary || r.error}</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0 }}>
                  Share the link above to give them access.
                </p>
              )}
              <div>
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
                  placeholder="person@club.co.za"
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
                  <option value="rep" disabled={!canRep}>
                    Club rep — scoped to selected clubs
                  </option>
                  <option value="admin">Administrator — whole union</option>
                </select>
              </label>
              {!canRep && (
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                  Add a club to invite reps.
                </div>
              )}
              {role === 'rep' && (
                <div>
                  <div className="field-label" style={{ marginBottom: 4 }}>
                    Clubs <span style={{ color: 'var(--muted-2)' }}>· select at least one</span>
                  </div>
                  <ClubMultiSelect clubs={clubs} value={clubIds} onChange={setClubIds} />
                </div>
              )}
              <div>
                <div className="field-label" style={{ marginBottom: 4 }}>
                  Notify by
                </div>
                <ChannelToggles value={channels} onChange={setChannels} />
                {!channels.email && !channels.whatsapp && (
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                    No channel selected — you can still share the login link after creating the
                    account.
                  </div>
                )}
              </div>
              <Btn tone="teal" icon={Icon.Mail} disabled={!canSubmit} onClick={submit}>
                {busy
                  ? 'Creating…'
                  : chansSelected
                    ? 'Create account & send invite'
                    : 'Create account'}
              </Btn>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── RoleScopeModal — change a user's role, and (for reps) their club scope ───
   `mode` is 'role' or 'clubs'. Admins always carry clubIds:[]. */
function RoleScopeModal({ user, clubs = [], mode, lockRep, onClose, onSave, toast }) {
  const [role, setRole] = useStateA(user.role);
  const [clubIds, setClubIds] = useStateA(() => new Set(user.clubIds || []));
  const [busy, setBusy] = useStateA(false);
  const editingClubs = mode === 'clubs' || role === 'rep';
  const repNeedsClub = role === 'rep' && clubIds.size === 0;
  const noChange =
    mode === 'role'
      ? role === user.role && (role !== 'rep' || setEq(clubIds, new Set(user.clubIds || [])))
      : setEq(clubIds, new Set(user.clubIds || []));
  const canSave = !busy && !repNeedsClub && !noChange;

  async function save() {
    if (!canSave || !onSave) return;
    setBusy(true);
    try {
      const body =
        mode === 'role'
          ? { role, clubIds: role === 'rep' ? [...clubIds] : [] }
          : { clubIds: [...clubIds] };
      await onSave(user.sub, body);
      toast && toast(mode === 'role' ? 'Role updated' : 'Club access updated');
      onClose();
    } catch {
      /* withToast already surfaced the error */
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal narrow" style={{ maxWidth: 460 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">{user.email}</div>
            <div className="task-modal-head-title">
              {mode === 'role' ? (
                <>
                  Change <em>role</em>
                </>
              ) : (
                <>
                  Edit <em>club access</em>
                </>
              )}
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <div className="stack" style={{ gap: 12 }}>
            {mode === 'role' && (
              <label style={{ fontSize: 12, color: 'var(--muted)' }}>
                Role
                <select
                  className="field-select"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  style={{ width: '100%', marginTop: 4 }}
                >
                  {/* `lockRep` means "lock OUT rep": this is the only administrator, so
                      demoting them leaves the union with nobody who can invite one back.
                      The disable belongs on REP — it was on `admin`, which merely stopped
                      them re-picking the role they already held while leaving the
                      lockout one click away, directly contradicting the note below. The
                      API rejects it atomically either way; this is about saying so before
                      the request rather than through a 409. */}
                  <option value="rep" disabled={clubs.length === 0 || lockRep}>
                    Club rep — scoped to selected clubs
                  </option>
                  <option value="admin">Administrator — whole union</option>
                </select>
              </label>
            )}
            {mode === 'role' && lockRep && user.role === 'admin' && (
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                This is the only administrator — they can&apos;t be demoted until another admin
                exists.
              </div>
            )}
            {editingClubs && (
              <div>
                <div className="field-label" style={{ marginBottom: 4 }}>
                  Clubs <span style={{ color: 'var(--muted-2)' }}>· select at least one</span>
                </div>
                <ClubMultiSelect clubs={clubs} value={clubIds} onChange={setClubIds} />
              </div>
            )}
            <Btn tone="teal" icon={Icon.Check} disabled={!canSave} onClick={save}>
              {busy ? 'Saving…' : 'Save changes'}
            </Btn>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function setEq(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/* ─── EditEmailModal — correct a mistyped email for a not-yet-signed-in member ───
   Server relocates the Cognito sign-in alias, re-syncs markers, and auto-resends the
   invite to the new address, so the right person can sign in. Surfaces the resend
   outcome like the row-level resend helper. */
function EditEmailModal({ user, onClose, onSave, toast }) {
  const [email, setEmail] = useStateA(user.email || '');
  const [busy, setBusy] = useStateA(false);
  const clean = email.trim().toLowerCase();
  const valid = EMAIL_RE.test(clean);
  const changed = clean !== (user.email || '').trim().toLowerCase();
  const canSave = !busy && valid && changed;

  async function save() {
    if (!canSave || !onSave) return;
    setBusy(true);
    try {
      const res = await onSave(user.sub, clean);
      const results = (res && res.results) || [];
      const sent = results.filter((r) => r.status === 'sent');
      if (sent.length) toast && toast(`Email updated · invite re-sent to ${clean}`);
      else if (results.length)
        toast &&
          toast(
            `Email updated, but the invite didn't send (${results
              .map((r) => `${chLabel(r.channel)} ${r.status}`)
              .join('; ')}) — use Resend to try again`,
            'warn',
          );
      else toast && toast('Email updated');
      onClose();
    } catch {
      /* withToast already surfaced the error */
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal narrow" style={{ maxWidth: 460 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">{user.email}</div>
            <div className="task-modal-head-title">
              Correct <em>email</em>
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <div className="stack" style={{ gap: 12 }}>
            <label style={{ fontSize: 12, color: 'var(--muted)' }}>
              Email address
              <input
                className="field-input"
                type="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && save()}
                placeholder="name@club.co.za"
                style={{ width: '100%', marginTop: 4 }}
              />
            </label>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              A fresh invite is sent to the corrected address — they sign in with a one-time code,
              no password needed.
            </div>
            <Btn tone="teal" icon={Icon.Check} disabled={!canSave} onClick={save}>
              {busy ? 'Saving…' : 'Save & re-send invite'}
            </Btn>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── AdminTeamAccessView — tenant-level roster: invite, change role, edit scope, resend, remove ─── */
export function AdminTeamAccessView({
  users = [],
  clubs = [],
  onInvite,
  onPatchUser,
  onRemoveUser,
  onResend,
  onChangeEmail,
  currentUserEmail,
  toast,
}) {
  const [showInvite, setShowInvite] = useStateA(false);
  const [editing, setEditing] = useStateA(null); // { user, mode }
  const [editingEmail, setEditingEmail] = useStateA(null); // user being email-corrected
  const [confirm, setConfirm] = useStateA(null); // { title, body, danger, onYes }
  const [busySub, setBusySub] = useStateA(null);

  const clubName = (id) => clubs.find((c) => c.id === id)?.name || id;
  const adminCount = users.filter((u) => u.role === 'admin').length;
  const isLastAdmin = (u) => u.role === 'admin' && adminCount <= 1;
  const isSelf = (u) =>
    !!currentUserEmail && u.email?.toLowerCase() === currentUserEmail.toLowerCase();
  // invitedAt is an INSTANT, so the local calendar day is the honest reading.
  const fmtDate = (iso) => (iso ? formatStampDay(iso) : '—');

  async function resend(u) {
    if (!onResend) return;
    setBusySub(u.sub);
    try {
      const res = await onResend(u.sub);
      const results = (res && res.results) || [];
      const sent = results.filter((r) => r.status === 'sent');
      const notSent = results.filter((r) => r.status !== 'sent');
      if (sent.length)
        toast && toast(`Invite re-sent via ${sent.map((r) => chLabel(r.channel)).join(' & ')}`);
      if (notSent.length)
        toast &&
          toast(
            `Some channels failed — ${notSent
              .map((r) => `${chLabel(r.channel)} ${r.status}`)
              .join('; ')}`,
            'warn',
          );
      if (!results.length) toast && toast('Invite re-sent');
    } catch {
      /* withToast already surfaced the error */
    } finally {
      setBusySub(null);
    }
  }

  function askRemove(u) {
    setConfirm({
      title: 'Remove access?',
      body: `${u.email} will lose access to this union. This signs them out and can't be undone.`,
      danger: true,
      onYes: () => {
        onRemoveUser?.(u.sub)
          .then(() => toast && toast('Access removed'))
          .catch(() => {});
        setConfirm(null);
      },
    });
  }

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Admin Console / Team &amp; Access</div>
          <h1 className="ph-title">
            Team &amp; <em>Access</em>
          </h1>
          <p className="ph-desc">
            Invite administrators and club reps, manage roles and club scope, and see who
            hasn&apos;t signed in yet.
          </p>
        </div>
        <div className="ph-actions">
          <Btn tone="ink" size="sm" icon={Icon.Mail} onClick={() => setShowInvite(true)}>
            Invite admin / rep
          </Btn>
        </div>
      </div>

      {users.length === 0 ? (
        <EmptyState
          icon={Icon.Users}
          title="No team members yet"
          sub="Invite an administrator or a club rep to give them access to this union."
          action={
            <Btn tone="teal" icon={Icon.Mail} onClick={() => setShowInvite(true)}>
              Invite admin / rep
            </Btn>
          }
        />
      ) : (
        <div className="tbl-w">
          <table className="tbl">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Clubs</th>
                <th>Status</th>
                <th>Invited</th>
                <th style={{ width: 1 }}></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const last = isLastAdmin(u);
                const self = isSelf(u);
                return (
                  <tr key={u.sub}>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 12.5 }}>{u.email}</span>
                        {u.status === 'pending' && onChangeEmail && (
                          <button
                            className="icon-btn"
                            title="Correct email address"
                            aria-label={`Correct email for ${u.email}`}
                            onClick={() => setEditingEmail(u)}
                          >
                            <Icon.Form />
                          </button>
                        )}
                      </span>
                      {self && (
                        <Pill tone="navy">
                          <span style={{ marginLeft: 0 }}>You</span>
                        </Pill>
                      )}
                    </td>
                    <td>
                      <Pill tone={u.role === 'admin' ? 'gold' : 'teal'}>
                        {u.role === 'admin' ? 'Admin' : 'Club rep'}
                      </Pill>
                    </td>
                    <td>
                      {u.role === 'admin' ? (
                        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Whole union</span>
                      ) : (
                        <span style={{ fontSize: 12 }}>
                          {(u.clubIds || []).map(clubName).join(', ') || '—'}
                        </span>
                      )}
                    </td>
                    <td>
                      <Pill tone={u.status === 'active' ? 'teal' : 'gold'} dot>
                        {u.status === 'active' ? 'Active' : 'Not signed in'}
                      </Pill>
                    </td>
                    <td>
                      <span
                        style={{
                          fontSize: 11.5,
                          color: 'var(--muted)',
                          fontFamily: "'Montserrat',sans-serif",
                        }}
                      >
                        {fmtDate(u.invitedAt)}
                      </span>
                      {u.status === 'pending' &&
                        u.invitedAt &&
                        (() => {
                          const age = daysAgo(u.invitedAt);
                          if (age == null) return null;
                          const label =
                            age === 0
                              ? 'invited today'
                              : age === 1
                                ? 'invited 1 day ago'
                                : `invited ${age} days ago`;
                          return (
                            <div
                              style={{
                                fontSize: 10.5,
                                color: age > 14 ? 'var(--gold)' : 'var(--muted-2)',
                                marginTop: 2,
                              }}
                            >
                              {label}
                            </div>
                          );
                        })()}
                    </td>
                    <td style={{ textAlign: 'right', paddingRight: 14, whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Btn
                          tone="ghost"
                          size="sm"
                          onClick={() => setEditing({ user: u, mode: 'role' })}
                        >
                          Change role
                        </Btn>
                        {u.role === 'rep' && (
                          <Btn
                            tone="ghost"
                            size="sm"
                            onClick={() => setEditing({ user: u, mode: 'clubs' })}
                          >
                            Edit clubs
                          </Btn>
                        )}
                        {u.status === 'pending' && (
                          <Btn
                            tone="ghost"
                            size="sm"
                            disabled={busySub === u.sub}
                            onClick={() => resend(u)}
                          >
                            {busySub === u.sub ? 'Sending…' : 'Resend'}
                          </Btn>
                        )}
                        <Btn
                          tone="outline"
                          size="sm"
                          disabled={last}
                          title={last ? "Can't remove the only administrator" : undefined}
                          onClick={() => askRemove(u)}
                        >
                          Remove
                        </Btn>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showInvite && (
        <InviteUserModal
          clubs={clubs}
          onClose={() => setShowInvite(false)}
          onInvite={onInvite}
          toast={toast}
        />
      )}
      {editing && (
        <RoleScopeModal
          user={editing.user}
          clubs={clubs}
          mode={editing.mode}
          lockRep={isLastAdmin(editing.user)}
          onClose={() => setEditing(null)}
          onSave={onPatchUser}
          toast={toast}
        />
      )}
      {editingEmail && (
        <EditEmailModal
          user={editingEmail}
          onClose={() => setEditingEmail(null)}
          onSave={onChangeEmail}
          toast={toast}
        />
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
                  Remove access
                </Btn>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/* ─── AdminClearances — oversight of every clearance across the cohort ─── */
export function AdminClearances({
  clearances,
  leagues,
  clubs,
  onOverride,
  onReject,
  onReassign,
  onReopen,
  busyId,
  busyAction,
}) {
  const [confirm, setConfirm] = useStateA(null);
  // Optional note the admin attaches to a rejection (shown to both clubs).
  const [reason, setReason] = useStateA('');
  // Target club for a reallocation (the reassign confirm's picker).
  const [reassignTarget, setReassignTarget] = useStateA('');
  const [filter, setFilter] = useStateA('all');
  // Free-text search across every status; combines with the status pills below.
  const [q, setQ] = useStateA('');
  const teamLabel = labelByKey(leagues ?? []);
  // requestedAt is an INSTANT — the local calendar day, not the UTC one, or a request
  // logged at 01:00 SAST reads as the previous day.
  const fmtDay = (iso) => (iso ? formatStampDay(iso) : '');

  // The admin list carries the derived `sourceRostered` field (AdminClearanceView); the
  // props are still untyped, so annotate here to keep the derivation typed downstream.
  const all: AdminClearanceView[] = clearances ?? [];
  // Search first, then split into status buckets — so the pills (incl. All) count the
  // SEARCHED set, while the four stat cards keep the cohort totals from `all`.
  const searched = filterClearances(all, q, teamLabel);
  // `clearanceOverdue()` now always returns false, so there is no longer an
  // "overdue" bucket — every open request is simply pending.
  const pending = searched.filter((r) => r.status === 'pending');
  const rejected = searched.filter((r) => r.status === 'rejected');
  const resolved = searched.filter((r) => r.status === 'approved' || r.status === 'admin-override');
  // Cohort totals for the stat cards — always the whole set, independent of the search.
  const isResolved = (r) => r.status === 'approved' || r.status === 'admin-override';
  const totalPending = all.filter((r) => r.status === 'pending').length;
  const totalRejected = all.filter((r) => r.status === 'rejected').length;
  const totalResolved = all.filter(isResolved).length;

  const list =
    filter === 'pending'
      ? pending
      : filter === 'resolved'
        ? resolved
        : filter === 'rejected'
          ? rejected
          : searched;

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Admin Console / Clearances</div>
          <h1 className="ph-title">
            Player <em>Clearances</em>
          </h1>
          <p className="ph-desc">
            Every clearance request across the cohort. Source clubs confirm fees + misconduct, or
            the Union office can override and issue the clearance on the source club's behalf.
            Rejecting cancels the move and can be reopened.
          </p>
        </div>
        <div className="ph-actions">
          {/* Not yet wired to export / the SES reminder pipeline — disabled so the console
              doesn't advertise capabilities it doesn't have (follow-up). */}
          <Btn tone="outline" size="sm" icon={Icon.Download} disabled title="Coming soon">
            Export
          </Btn>
        </div>
      </div>

      <div className="players-stats">
        <div className="players-stat">
          <div className="players-stat-l">All requests</div>
          <div className="players-stat-n">{all.length}</div>
        </div>
        <div className="players-stat">
          <div className="players-stat-l">Pending</div>
          <div className="players-stat-n" style={{ color: 'var(--gold)' }}>
            {totalPending}
          </div>
        </div>
        <div className="players-stat">
          <div className="players-stat-l">Resolved</div>
          <div className="players-stat-n" style={{ color: 'var(--green)' }}>
            {totalResolved}
          </div>
        </div>
        <div className="players-stat">
          <div className="players-stat-l">Rejected</div>
          <div className="players-stat-n" style={{ color: 'var(--coral)' }}>
            {totalRejected}
          </div>
        </div>
      </div>

      <div className="filter-row" style={{ marginTop: 14 }}>
        <input
          className="search-box"
          aria-label="Search clearances"
          placeholder="Search by player, ID number or club…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {[
          { k: 'all', l: 'All', n: searched.length },
          { k: 'pending', l: 'Pending', n: pending.length },
          { k: 'resolved', l: 'Resolved', n: resolved.length },
          { k: 'rejected', l: 'Rejected', n: rejected.length },
        ].map((b) => (
          <button
            key={b.k}
            className={`filter-pill ${filter === b.k ? 'active' : ''}`}
            onClick={() => setFilter(b.k)}
          >
            {b.l} <span style={{ opacity: 0.7, marginLeft: 4 }}>{b.n}</span>
          </button>
        ))}
      </div>
      {q.trim() && (
        <div
          style={{
            marginTop: 12,
            fontSize: 11.5,
            color: 'var(--muted)',
            fontFamily: "'Montserrat',sans-serif",
          }}
        >
          Showing {searched.length} of {all.length} clearances
        </div>
      )}

      <div className="clr-list" style={{ marginTop: 14 }}>
        {list.length === 0 && (
          <div
            style={{
              padding: '40px 16px',
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 13,
              background: 'var(--white)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            {q.trim()
              ? `No clearances match "${q.trim()}".`
              : 'No clearance requests match this filter.'}
          </div>
        )}
        {list.map((req) => {
          const busy = busyId === req.id;
          // Directory-sourced clearance whose club is STILL not on the system: no rep can
          // ever action it, so the union office overrides — or reallocates it once the
          // club registers. The club-existence cross-check makes the flag age out when a
          // club later signs up under the directory entry's exact slug.
          const offSystem =
            req.fromClubDirectory === true && !(clubs ?? []).some((c) => c.id === req.fromClubId);
          // `sourceRostered` (API-derived, pending only) still drives the Reallocate offer:
          //   sourcelessKnown — the API said the source club holds no row for this player, so it
          //     cannot decide on an informed basis. Only this state (or an off-system source)
          //     offers Reallocate — the server 409s if it is claimed on a genuine transfer.
          const pendingRegistration = req.status === 'pending' && req.origin === 'registration';
          const sourcelessKnown = pendingRegistration && req.sourceRostered === false;
          // Reallocation mirrors the server rule: sourceless, but NOT a directory entry whose
          // slug a real club has since claimed — that clearance is genuinely in its rep's queue.
          // `offSystem` stays an independent trigger so an off-system clearance never loses its
          // only recovery control just because `sourceRostered` is absent.
          const canReallocate =
            (offSystem || sourcelessKnown) &&
            !(req.fromClubDirectory === true && (clubs ?? []).some((c) => c.id === req.fromClubId));
          // Which reject case applies is now decided SERVER-SIDE (predictedRejectCase), from the
          // same detection the reject uses, so the console never infers it from a boolean. It is
          // present only on pending clearances; ABSENT means the API could not work it out
          // (derivation failed / web-API deploy skew), in which case Reject fails CLOSED and is
          // disabled — a reject may create or replace a row at another club (cases C/B-placeholder)
          // and the admin must see the right consequence before confirming.
          const predicted = req.predictedRejectCase;
          const rejectDisabled = req.status === 'pending' && !predicted;
          // Per-case copy: the reject clause inside the pending sub-text, and the reject confirm
          // body. Keyed by predictedRejectCase; only read when `predicted` is set.
          const rejectClause = {
            A: `rejecting cancels the move and returns them to active at ${req.fromClubName}`,
            B: `rejecting cancels the move — they return to active at ${req.fromClubName} and their pending registration at ${req.toClubName} is removed`,
            'B-placeholder': `${req.fromClubName} holds only a placeholder for this player (from the union's backfill or a reallocation) — rejecting replaces it with their full registration, details and ID document, and removes them from ${req.toClubName}`,
            'B-active': `they are already active at ${req.fromClubName}; rejecting removes their pending registration at ${req.toClubName}`,
            C: `${req.fromClubName} has no record of this player — rejecting moves the registration (details and ID document) to ${req.fromClubName}, where they become active and the record becomes ${req.fromClubName}'s to manage; they are removed from ${req.toClubName}`,
            D: `${req.fromClubName} is not on the system — rejecting leaves them registered and active at ${req.toClubName}`,
          };
          const rejectNotified =
            " Both clubs' chairs will be notified by email where an address is on file. You can reopen this clearance later if needed.";
          const junkHint = ` If this registration is junk, use Override & approve and then delete the player instead.`;
          const rejectConfirmBody = {
            A: `This will reject ${req.playerName}'s transfer to ${req.toClubName} on the Union's authority. The move is cancelled and they return to active at ${req.fromClubName}.${rejectNotified}`,
            B: `This will reject ${req.playerName}'s clearance on the Union's authority. The move is cancelled — they return to active at ${req.fromClubName}, and their pending registration at ${req.toClubName} is removed.${rejectNotified}`,
            'B-placeholder': `This will reject ${req.playerName}'s clearance on the Union's authority. ${req.fromClubName} holds only a placeholder for this player, so their full registration — details and ID document — is moved to ${req.fromClubName}, replacing the placeholder, where they become active, and they are removed from ${req.toClubName}.${junkHint}${rejectNotified}`,
            'B-active': `This will reject ${req.playerName}'s clearance on the Union's authority. They are already active at ${req.fromClubName}; rejecting removes their pending registration at ${req.toClubName}.${rejectNotified}`,
            C: `This will reject ${req.playerName}'s clearance on the Union's authority. ${req.fromClubName} has no record of this player, so rejecting moves the registration — details and ID document — to ${req.fromClubName}, where they become active and the record becomes ${req.fromClubName}'s to manage; they are removed from ${req.toClubName}.${junkHint}${rejectNotified}`,
            D: `This will reject ${req.playerName}'s clearance on the Union's authority. ${req.fromClubName} is not on the system, so they stay registered and active at ${req.toClubName}.${rejectNotified}`,
          };
          return (
            <div
              key={req.id}
              className={`clr-card admin ${req.status !== 'pending' ? 'resolved' : ''}`}
            >
              <div className="clr-card-head">
                <div>
                  <div className="clr-eyebrow">
                    {req.status === 'admin-override'
                      ? '✓ Union override'
                      : req.status === 'approved'
                        ? `✓ Cleared by ${req.fromClubName}`
                        : req.status === 'rejected'
                          ? '✕ Rejected'
                          : req.reopenedAt
                            ? `Reopened ${fmtDay(req.reopenedAt)}${req.reopenedBy ? ` · ${req.reopenedBy}` : ''}`
                            : 'Pending'}
                  </div>
                  <div className="clr-name">
                    {req.playerName}
                    {req.origin === 'registration' && (
                      <span style={{ marginLeft: 8 }}>
                        <Pill tone="muted">Via registration</Pill>
                      </span>
                    )}
                  </div>
                  <div className="clr-meta">
                    ID {req.idNumber || '—'} · {teamLabel[req.team] || req.team || '—'} · Requested{' '}
                    {fmtDay(req.requestedAt)}
                  </div>
                </div>
                <div className="clr-route">
                  <div className="clr-route-from">
                    {req.fromClubName}
                    {offSystem && (
                      <div style={{ marginTop: 4 }}>
                        <Pill tone="gold">Not on system</Pill>
                      </div>
                    )}
                  </div>
                  <Icon.Arrow />
                  <div className="clr-route-to">{req.toClubName}</div>
                </div>
              </div>

              {req.note && <div className="clr-note">"{req.note}"</div>}

              <div className="clr-status-strip">
                <div className={`clr-status ${req.feesCleared ? 'on' : ''}`}>
                  <span className="clr-status-dot" />
                  Fees {req.feesCleared ? 'cleared' : 'pending'}
                </div>
                <div className={`clr-status ${req.misconductCleared ? 'on' : ''}`}>
                  <span className="clr-status-dot" />
                  Misconduct {req.misconductCleared ? 'cleared' : 'pending'}
                </div>
              </div>

              {req.status === 'pending' && (
                <div className="clr-override">
                  <div className="clr-override-text">
                    <div className="clr-override-title">
                      Act on this clearance on the clubs' behalf?
                    </div>
                    <div className="clr-override-sub">
                      {rejectDisabled
                        ? `The Union office can override ${req.fromClubName}'s approval and issue the clearance to ${req.toClubName}${canReallocate ? `, or reallocate it to the club they actually left` : ''}. Rejecting is unavailable: could not work out where this player's record is — refresh and try again.`
                        : `The Union office can override ${req.fromClubName}'s approval and issue the clearance to ${req.toClubName}, or reject it — ${rejectClause[predicted]}.${canReallocate ? ` If ${req.fromClubName} has since registered under a slightly different name, reallocate this clearance to it instead.` : ''}`}
                    </div>
                  </div>
                  {canReallocate && (
                    <Btn
                      tone="outline"
                      disabled={busy}
                      onClick={() => {
                        setReassignTarget('');
                        setConfirm({
                          kind: 'reassign',
                          title: 'Reallocate this clearance?',
                          body: `${req.fromClubName} has no record on the system. If the club has since registered (perhaps under a slightly different name), reallocate the clearance to it — its rep will then see, and can approve or reject, ${req.playerName}'s transfer to ${req.toClubName}.`,
                          req,
                          // Keep the dialog open until the request settles.
                          onYes: async (targetId) => {
                            const result = await onReassign(req, targetId);
                            // Close on success AND on 'conflict' — the toast already told the
                            // admin and the card has refetched, so a retry would only 409 again.
                            // Stay open only for a transient 'failed' so the admin can retry.
                            if (result !== 'failed') setConfirm(null);
                          },
                        });
                      }}
                    >
                      Reallocate source…
                    </Btn>
                  )}
                  <span
                    title={
                      rejectDisabled
                        ? "Could not work out where this player's record is — refresh and try again"
                        : undefined
                    }
                  >
                    <Btn
                      tone="outline"
                      disabled={busy || rejectDisabled}
                      onClick={() => {
                        setReason('');
                        setConfirm({
                          kind: 'reject',
                          title: 'Reject this clearance?',
                          req,
                          body: rejectConfirmBody[predicted],
                          // Keep the dialog open until the request settles. Close on success
                          // AND on 'conflict' — the toast already told the admin and the card
                          // has refetched, so a retry would only 409 again. Stay open only for
                          // a transient 'failed' so the admin can retry.
                          onYes: async (note) => {
                            const result = await onReject(req, note);
                            if (result !== 'failed') setConfirm(null);
                          },
                        });
                      }}
                    >
                      {busy && busyAction === 'reject' ? 'Rejecting…' : 'Reject'}
                    </Btn>
                  </span>
                  <Btn
                    tone="teal"
                    icon={Icon.Arrow}
                    disabled={busy}
                    onClick={() => {
                      setReason('');
                      setConfirm({
                        kind: 'override',
                        title: 'Issue this clearance?',
                        req,
                        body: sourcelessKnown
                          ? `This will issue ${req.playerName}'s clearance to ${req.toClubName} on the Union's authority, on ${req.fromClubName}'s behalf — even though ${req.fromClubName} has no record of them. If this registration should not exist at all, issue it and then remove the player from ${req.toClubName}'s roster (Clubs → ${req.toClubName} → Players). Say which you are doing: the reason is shown to both clubs, and recorded against your name for the union's record.`
                          : `This will issue ${req.playerName}'s clearance to ${req.toClubName} on the Union's authority, on ${req.fromClubName}'s behalf. Both clubs' chairs will be notified by email where an address is on file.`,
                        // Keep the dialog open until the request settles. Close on success AND
                        // on 'conflict' — the toast already told the admin and the card has
                        // refetched, so a retry would only 409 again. Stay open only for a
                        // transient 'failed' so the admin can retry.
                        onYes: async (note) => {
                          const result = await onOverride(req, note);
                          if (result !== 'failed') setConfirm(null);
                        },
                      });
                    }}
                  >
                    {busy && busyAction === 'override' ? 'Issuing…' : 'Override & approve'}
                  </Btn>
                </div>
              )}

              {req.status !== 'pending' && (
                <div className="clr-resolved-bar">
                  {req.status === 'rejected' ? (
                    <Pill tone="coral" dot>
                      Rejected{req.rejectedBy ? ` · ${req.rejectedBy}` : ''}
                    </Pill>
                  ) : (
                    <Pill tone="teal" dot>
                      {req.status === 'admin-override'
                        ? `Union override${req.overriddenBy ? ` · ${req.overriddenBy}` : ''}`
                        : 'Cleared by source club'}
                    </Pill>
                  )}
                  {/* Where the player ended up, so a rejected card reads truthfully at a glance
                      — a source-reactivated reject needs no hint (they simply stayed put). */}
                  {req.status === 'rejected' && req.rejectOutcome === 'moved-to-source' && (
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                      Moved to {req.fromClubName}
                    </span>
                  )}
                  {req.status === 'rejected' && req.rejectOutcome === 'stays-at-destination' && (
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                      Stays at {req.toClubName}
                    </span>
                  )}
                  {req.status === 'rejected' && req.rejectReason && (
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                      "{req.rejectReason}"
                    </span>
                  )}
                  {/* The whole point of capturing it: an override used to DISPOSE of a
                      clearance must not read as an approved transfer in the history. */}
                  {req.status === 'admin-override' && req.overrideReason && (
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                      "{req.overrideReason}"
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      fontFamily: "'Montserrat',sans-serif",
                    }}
                  >
                    {(() => {
                      const at = req.rejectedAt || req.clubApprovedAt || req.adminOverrideAt;
                      // Decision stamps are INSTANTS, not calendar days.
                      return at ? formatStampDay(at) : '';
                    })()}
                  </span>
                  {/* Reopen is offered only when a snapshot exists (rejectOutcome present). A
                      legacy reject — done before reopen was supported — has no snapshot to
                      restore, so it always 409s; say so instead of a button that can't work. */}
                  {req.status === 'rejected' && req.rejectOutcome && (
                    <Btn
                      tone="outline"
                      size="sm"
                      style={{ marginLeft: 'auto' }}
                      disabled={busy}
                      onClick={() => {
                        setConfirm({
                          kind: 'reopen',
                          title: 'Reopen this clearance?',
                          req,
                          body: `${req.playerName}'s registration goes back to how it was before the rejection, and ${req.fromClubName}'s chair is notified again. It can be rejected again afterwards.`,
                          // Keep the dialog open until the request settles; close on success and
                          // on 'conflict' (already refetched), stay open only on 'failed'.
                          onYes: async () => {
                            const result = await onReopen(req);
                            if (result !== 'failed') setConfirm(null);
                          },
                        });
                      }}
                    >
                      {busy && busyAction === 'reopen' ? 'Reopening…' : 'Reopen'}
                    </Btn>
                  )}
                  {req.status === 'rejected' && !req.rejectOutcome && (
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontSize: 11,
                        color: 'var(--muted)',
                        fontFamily: "'Montserrat',sans-serif",
                      }}
                    >
                      Rejected before reopen was supported
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {confirm &&
        createPortal(
          <div
            className="fix-confirm"
            onClick={(e) => e.target === e.currentTarget && setConfirm(null)}
          >
            <div className="fix-confirm-box">
              <div className={`fix-confirm-icon ${confirm.kind === 'reject' ? 'danger' : 'go'}`}>
                {confirm.kind === 'reject' ? (
                  <svg viewBox="0 0 24 24" fill="none">
                    <path
                      d="M6 6l12 12M18 6L6 18"
                      stroke="currentColor"
                      strokeWidth="2.2"
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
              {(confirm.kind === 'reject' || confirm.kind === 'override') && (
                <textarea
                  className="field-input"
                  rows={2}
                  maxLength={500}
                  placeholder={
                    confirm.kind === 'reject'
                      ? 'Reason (optional — shown to both clubs)'
                      : 'Reason (optional — shown to both clubs, recorded against your name)'
                  }
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  style={{ width: '100%', marginTop: 10, resize: 'vertical', fontSize: 13 }}
                />
              )}
              {confirm.kind === 'reassign' && (
                <select
                  className="field-input"
                  value={reassignTarget}
                  onChange={(e) => setReassignTarget(e.target.value)}
                  style={{ width: '100%', marginTop: 10, fontSize: 13 }}
                >
                  <option value="">Select the club…</option>
                  {(clubs ?? [])
                    // Never the destination (it would approve its own incoming transfer), and
                    // never the club it is already assigned to — since on-system sourceless
                    // clearances became reallocatable, the current source IS in this list, and
                    // picking it returns a raw 400.
                    .filter((c) => c.id !== confirm.req.toClubId && c.id !== confirm.req.fromClubId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              )}
              <div className="fix-confirm-actions">
                {/* Cancel stays enabled while the request is in flight (728eae4 convention);
                    only the confirm button is disabled + relabelled. */}
                <Btn tone="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Btn>
                {(() => {
                  // Busy only when THIS confirm's request is the one in flight.
                  const cbusy = !!confirm.req && busyId === confirm.req.id;
                  const busyLabel =
                    busyAction === 'reject'
                      ? 'Rejecting…'
                      : busyAction === 'reassign'
                        ? 'Reallocating…'
                        : busyAction === 'reopen'
                          ? 'Reopening…'
                          : 'Issuing…';
                  if (confirm.kind === 'reject')
                    return (
                      <Btn tone="ink" disabled={cbusy} onClick={() => confirm.onYes(reason.trim())}>
                        {cbusy ? busyLabel : 'Yes, reject clearance'}
                      </Btn>
                    );
                  if (confirm.kind === 'reopen')
                    return (
                      <Btn
                        tone="teal"
                        icon={Icon.Arrow}
                        disabled={cbusy}
                        onClick={() => confirm.onYes()}
                      >
                        {cbusy ? busyLabel : 'Yes, reopen clearance'}
                      </Btn>
                    );
                  if (confirm.kind === 'override')
                    return (
                      <Btn
                        tone="teal"
                        icon={Icon.Arrow}
                        disabled={cbusy}
                        onClick={() => confirm.onYes(reason.trim())}
                      >
                        {cbusy ? busyLabel : 'Yes, issue clearance'}
                      </Btn>
                    );
                  if (confirm.kind === 'reassign')
                    return (
                      <Btn
                        tone="teal"
                        icon={Icon.Arrow}
                        disabled={!reassignTarget || cbusy}
                        onClick={() => confirm.onYes(reassignTarget)}
                      >
                        {cbusy ? busyLabel : 'Reallocate clearance'}
                      </Btn>
                    );
                  return (
                    <Btn tone="teal" icon={Icon.Arrow} onClick={() => confirm.onYes()}>
                      Yes, issue clearance
                    </Btn>
                  );
                })()}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/* ─── AdminRegistrationReviews — off-system alerts + cross-club holds, cohort-wide ─── */

export function AdminRegistrationReviews({ reviews, onAck, busyId }) {
  const [filter, setFilter] = useStateA('open');
  // createdAt / resolvedAt are INSTANTS.
  const fmtDay = (iso) => (iso ? formatStampDay(iso) : '');
  // Newest-first — the gsi1 list arrives oldest-first (createdAt ascending).
  const all = [...(reviews ?? [])].sort((a, b) =>
    (b.createdAt || '').localeCompare(a.createdAt || ''),
  );
  const open = all.filter((r) => r.status === 'open');
  const resolved = all.filter((r) => r.status === 'resolved');
  const list = filter === 'open' ? open : filter === 'resolved' ? resolved : all;

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Admin Console / Registration Reviews</div>
          <h1 className="ph-title">
            Registration <em>Reviews</em>
          </h1>
          <p className="ph-desc">
            Registrations that named a previous club not on the system, so no clearance could be
            opened. Acknowledge an alert once you've noted the club. Cross-club transfers between
            clubs on the system open a clearance to the previous club — see Clearances.
          </p>
        </div>
      </div>

      <div className="players-stats">
        <div className="players-stat">
          <div className="players-stat-l">All reviews</div>
          <div className="players-stat-n">{all.length}</div>
        </div>
        <div className="players-stat">
          <div className="players-stat-l">Open</div>
          <div className="players-stat-n" style={{ color: 'var(--gold)' }}>
            {open.length}
          </div>
        </div>
        <div className="players-stat">
          <div className="players-stat-l">Resolved</div>
          <div className="players-stat-n">{resolved.length}</div>
        </div>
      </div>

      <div className="filter-row" style={{ marginTop: 14 }}>
        {[
          { k: 'open', l: 'Open', n: open.length },
          { k: 'resolved', l: 'Resolved', n: resolved.length },
          { k: 'all', l: 'All', n: all.length },
        ].map((b) => (
          <button
            key={b.k}
            className={`filter-pill ${filter === b.k ? 'active' : ''}`}
            onClick={() => setFilter(b.k)}
          >
            {b.l} <span style={{ opacity: 0.7, marginLeft: 4 }}>{b.n}</span>
          </button>
        ))}
      </div>

      <div className="clr-list" style={{ marginTop: 14 }}>
        {list.length === 0 && (
          <div
            style={{
              padding: '40px 16px',
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 13,
              background: 'var(--white)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            No registration reviews match this filter.
          </div>
        )}
        {list.map((r) => {
          const busy = busyId === r.id;
          return (
            <div key={r.id} className={`clr-card admin ${r.status !== 'open' ? 'resolved' : ''}`}>
              <div className="clr-card-head">
                <div>
                  <div className="clr-eyebrow">Off-system previous club</div>
                  <div className="clr-name">
                    {r.playerName}
                    <span style={{ marginLeft: 8 }}>
                      <Pill tone="muted">Alert</Pill>
                    </span>
                  </div>
                  <div className="clr-meta">
                    ID {r.idNumber || '—'} · Registered with {r.destClubName} ·{' '}
                    {fmtDay(r.createdAt)}
                  </div>
                </div>
              </div>

              {r.status === 'open' ? (
                <div className="clr-override">
                  <div className="clr-override-text">
                    <div className="clr-override-title">
                      Off-system club: "{r.typedPreviousClub}"
                    </div>
                    <div className="clr-override-sub">
                      {r.playerName} registered with {r.destClubName} and named a previous club that
                      isn't on the system, so no clearance was created. Note the club, then mark
                      this reviewed.
                    </div>
                  </div>
                  <Btn tone="teal" disabled={busy} onClick={() => onAck(r)}>
                    {busy ? 'Saving…' : 'Mark reviewed'}
                  </Btn>
                </div>
              ) : (
                <div className="clr-resolved-bar">
                  <Pill tone={r.resolution === 'declined' ? 'coral' : 'teal'} dot>
                    {r.resolution === 'acknowledged'
                      ? 'Reviewed'
                      : r.resolution === 'accepted'
                        ? 'Accepted'
                        : 'Declined'}
                    {r.resolvedBy ? ` · ${r.resolvedBy}` : ''}
                  </Pill>
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      fontFamily: "'Montserrat',sans-serif",
                    }}
                  >
                    {fmtDay(r.resolvedAt)}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── AdminPlayersView — cross-club player register, fanned out over every club ─── */

// Derive a single human-readable role label, mirroring the club-side roster.
function playerRoleLabel(p) {
  const bits = [];
  if (p.isWk) bits.push('WK');
  if (p.isAllRounder) bits.push('All-rounder');
  // A pure batter (no bowling) reads as "Batter"; otherwise lead with bowler type.
  if (!p.isAllRounder) {
    if (p.bowlerType) bits.push(p.bowlerType);
    else if (!p.isWk) bits.push('Batter');
  } else if (p.bowlerType) {
    bits.push(p.bowlerType);
  }
  return bits.join(' · ') || '—';
}

const PLAYERS_PER_PAGE = 25;

export function AdminPlayersView({ clubs, leagues, toast }) {
  const list = clubs ?? [];
  const teamLabel = labelByKey(leagues ?? []);

  // Fan out one players query per club. Partial failures stay isolated —
  // a single errored club contributes no rows but never blanks the table.
  const results = useQueries({
    queries: list.map((c) => ({
      queryKey: qk.players(c.id),
      queryFn: () => api.getPlayers(c.id),
    })),
  });

  const anyLoading = results.some((r) => r.isLoading);
  const erroredCount = results.filter((r) => r.isError).length;

  // Surface partial failures once, without blocking the rest of the list.
  useEffectA(() => {
    if (!anyLoading && erroredCount > 0) {
      toast?.(
        `${erroredCount} club${erroredCount === 1 ? "'s" : "s'"} roster failed to load`,
        'warn',
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyLoading, erroredCount]);

  const allPlayers = useMemoA(() => {
    const out = [];
    results.forEach((r, i) => {
      const club = list[i];
      if (!club || !Array.isArray(r.data)) return;
      r.data.forEach((p) =>
        out.push({ ...p, clubId: club.id, clubName: club.name || club.slug || '—' }),
      );
    });
    // Surname, then first name — stable alphabetical ordering.
    out.sort((a, b) => {
      const ln = (a.lastName || '').localeCompare(b.lastName || '', undefined, {
        sensitivity: 'base',
      });
      if (ln !== 0) return ln;
      return (a.firstName || '').localeCompare(b.firstName || '', undefined, {
        sensitivity: 'base',
      });
    });
    return out;
  }, [results, list]);

  const [filters, setFilters] = useStateA(emptyPlayerFilters);
  const [page, setPage] = useStateA(1);
  // Row-click opens a read-only detail modal; the row carries the full player + club.
  const [selectedPlayer, setSelectedPlayer] = useStateA(null);
  // Which export (by scope) is in flight, so the button the admin actually pressed shows
  // the busy label; null when idle. Both buttons disable while either runs.
  const [exportingScope, setExportingScope] = useStateA(null);

  // Any change to the query inputs resets pagination to the first page.
  const onFilters = (f) => {
    setFilters(f);
    setPage(1);
  };

  // Build the .xlsx client-side, then best-effort audit the export. The register carries
  // bulk PII, so every download is recorded — but the log must never fail the download.
  // Note this audit is a best-effort, client-reported signal (the PII already reached the
  // browser when the rosters loaded; the download is a local re-encoding), so a failed
  // write is reported to Sentry rather than swallowed — a silently-broken trail is the one
  // failure mode a compliance log can't afford.
  const runExport = async (rows, filename, scope) => {
    if (!rows.length) return toast?.('No players match — nothing to export', 'warn');
    // "Export all" while some club rosters failed to load yields a partial file; flag it in
    // both the toast and the audit record so the trail never reads as a clean full export.
    const incomplete = scope === 'all' && erroredCount > 0;
    setExportingScope(scope);
    try {
      const data = rows.map((p) => playerExportRow(p, (t) => teamLabel[t] || '', playerRoleLabel));
      await exportRowsToXlsx(filename, 'Players', data);
      if (incomplete)
        toast?.(
          `Exported ${rows.length} players, but ${erroredCount} club roster${
            erroredCount === 1 ? '' : 's'
          } failed to load — the file may be incomplete`,
          'warn',
        );
      api
        .logPlayerExport({ rowCount: rows.length, scope, erroredClubs: erroredCount })
        .catch((err) => Sentry.captureException(err, { tags: { audit: 'player-export' } }));
    } catch {
      toast?.('Export failed — please retry', 'warn');
    } finally {
      setExportingScope(null);
    }
  };

  // Club-scoped but otherwise-unfiltered — feeds the team/district facet
  // options so they narrow with the club select but not with other facets.
  const clubScoped = useMemoA(
    () =>
      filters.club === 'all' ? allPlayers : allPlayers.filter((p) => p.clubId === filters.club),
    [allPlayers, filters.club],
  );

  const filtered = useMemoA(() => filterPlayers(allPlayers, filters), [allPlayers, filters]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PLAYERS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PLAYERS_PER_PAGE, safePage * PLAYERS_PER_PAGE);

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Admin Console / Players</div>
          <h1 className="ph-title">
            Cross-club <em>players</em>
          </h1>
          <p className="ph-desc">
            Every registered player across the cohort in one register. Search by name or ID, or
            filter by club, status, team, role and more.
          </p>
        </div>
        <div className="ph-actions">
          {hasActiveFilters(filters) ? (
            <>
              <Btn
                tone="outline"
                icon={Icon.Download}
                size="sm"
                disabled={exportingScope !== null || anyLoading}
                onClick={() => runExport(filtered, 'players-filtered.xlsx', 'filtered')}
              >
                {exportingScope === 'filtered' ? 'Exporting…' : `Export ${filtered.length} shown`}
              </Btn>
              <Btn
                tone="ghost"
                icon={Icon.Download}
                size="sm"
                disabled={exportingScope !== null || anyLoading}
                onClick={() => runExport(allPlayers, 'players.xlsx', 'all')}
              >
                {exportingScope === 'all' ? 'Exporting…' : `Export all ${allPlayers.length}`}
              </Btn>
            </>
          ) : (
            <Btn
              tone="outline"
              icon={Icon.Download}
              size="sm"
              disabled={exportingScope !== null || anyLoading}
              onClick={() => runExport(allPlayers, 'players.xlsx', 'all')}
            >
              {exportingScope === 'all' ? 'Exporting…' : 'Export Excel'}
            </Btn>
          )}
          <KPI label="Players" num={allPlayers.length} />
        </div>
      </div>

      <PlayerFilterBar
        filters={filters}
        onChange={onFilters}
        players={clubScoped}
        teamLabel={teamLabel}
        clubs={list}
      />

      {anyLoading && allPlayers.length === 0 ? (
        <div
          style={{
            padding: '48px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          <span className="spinner" />
          Loading rosters…
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Icon.Users}
          title={allPlayers.length === 0 ? 'No players registered yet' : 'No players match'}
          sub={
            allPlayers.length === 0
              ? 'Players will appear here as clubs register their squads.'
              : 'Try adjusting your search or filters.'
          }
        />
      ) : (
        <>
          {hasActiveFilters(filters) && (
            <FilterResultCount shown={filtered.length} total={allPlayers.length} />
          )}
          <div className="tbl-w" style={{ marginTop: 14 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>ID number</th>
                  <th>Club</th>
                  <th>Team</th>
                  <th>Role</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((p) => (
                  <tr
                    key={`${p.clubId}:${p.naturalKey || p.idNumber}`}
                    onClick={() => setSelectedPlayer(p)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <div className="rost-name">
                        {p.firstName} {p.lastName}
                      </div>
                      <div className="rost-sub">
                        {p.district || '—'} · {p.gender || '—'} · {p.nationality || '—'}
                      </div>
                    </td>
                    <td>
                      <span className="rost-id">{p.idNumber || '—'}</span>
                    </td>
                    <td>
                      <div style={{ fontSize: 12.5 }}>{p.clubName}</div>
                    </td>
                    <td>
                      {p.team ? (
                        <Pill tone="navy">{teamLabel[p.team] || p.team}</Pill>
                      ) : (
                        <span className="rost-sub">—</span>
                      )}
                    </td>
                    <td>
                      <span className="rost-sub">{playerRoleLabel(p)}</span>
                    </td>
                    <td>{playerStatusPill(p.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 12,
                marginTop: 14,
              }}
            >
              <span
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  fontFamily: "'Montserrat',sans-serif",
                }}
              >
                Page {safePage} of {totalPages} · {filtered.length} players
              </span>
              <Btn
                tone="outline"
                size="sm"
                disabled={safePage <= 1}
                onClick={() => setPage(Math.max(1, safePage - 1))}
              >
                Prev
              </Btn>
              <Btn
                tone="outline"
                size="sm"
                icon={Icon.Arrow}
                disabled={safePage >= totalPages}
                onClick={() => setPage(Math.min(totalPages, safePage + 1))}
              >
                Next
              </Btn>
            </div>
          )}
        </>
      )}
      {selectedPlayer && (
        <PlayerDetailModal
          player={selectedPlayer}
          clubId={selectedPlayer.clubId}
          clubName={selectedPlayer.clubName}
          teamLabel={
            selectedPlayer.team ? teamLabel[selectedPlayer.team] || selectedPlayer.team : ''
          }
          onClose={() => setSelectedPlayer(null)}
        />
      )}
    </div>
  );
}

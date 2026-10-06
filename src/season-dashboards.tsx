/* ─── In-season home dashboards (union admin + club) and the pre/in-season switch ─── */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Icon, Btn, Pill, KPI, ProgressBar, EmptyState } from './atoms';
import { docCompletion, affiliationSubmitted } from './data';
import {
  releasedFixtures,
  clubFixtures,
  seasonStarted,
  seasonProgress,
  seriesProgress,
  weekWindow,
  daysBetween,
  localISO,
} from './season';
import { SCOUTING_EVENTS } from './scouting-data';
import type { CaptainsReport, Club, PlayerRegistration, RequiredDoc } from './types';
import { leaderboard } from './scouting';

export type SeasonMode = 'setup' | 'season' | 'reports';

/** The series fields these dashboards read (the wire shape carries much more). */
export interface SeriesLike {
  id: string;
  name: string;
  released?: boolean;
  fixtures?: unknown[];
}
type ClearanceLike = { status: string };

const fmtDay = (iso: string | null, opts: Intl.DateTimeFormatOptions = {}) =>
  iso
    ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        ...opts,
      })
    : '—';

function countdown(today: string, date: string) {
  const d = daysBetween(today, date);
  if (d <= 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  return `In ${d} days`;
}

// The chosen view sticks per portal (browser-local, best-effort). Until someone picks,
// the dashboard follows the calendar: in-season once the first fixture date arrives.
const modeKey = (scope: string) => `season-mode:${scope}`;
function storedMode(scope: string): SeasonMode | null {
  try {
    const v = localStorage.getItem(modeKey(scope));
    return v === 'setup' || v === 'season' || v === 'reports' ? v : null;
  } catch {
    return null;
  }
}

interface SeasonSwitchProps {
  scope: string;
  started: boolean;
  firstDate: string | null;
  setup: ReactNode;
  season: ReactNode;
  /** Optional third view — the captain's reports board (cricket tenants). */
  reports?: ReactNode;
}

/** Renders the pre-season or in-season home with a toggle bar above it. */
export function SeasonSwitch({
  scope,
  started,
  firstDate,
  setup,
  season,
  reports,
}: SeasonSwitchProps) {
  const [stored, setMode] = useState<SeasonMode>(
    () => storedMode(scope) ?? (started ? 'season' : 'setup'),
  );
  // A remembered 'reports' view falls back when the board isn't offered (e.g. football).
  const mode: SeasonMode = stored === 'reports' && !reports ? 'season' : stored;
  function pick(next: SeasonMode) {
    setMode(next);
    try {
      localStorage.setItem(modeKey(scope), next);
    } catch {
      /* storage unavailable — the toggle still works for this visit */
    }
  }
  return (
    <>
      <div className="season-bar">
        <div className="season-bar-status">
          {started ? (
            <>
              <span className="season-live-dot" aria-hidden="true" />
              <span>
                <strong>In season</strong>
                {firstDate && <> · since {fmtDay(firstDate, { weekday: undefined })}</>}
              </span>
            </>
          ) : (
            <span>
              <strong>Pre-season</strong>
              {firstDate ? (
                <> · first fixture {fmtDay(firstDate)}</>
              ) : (
                <> · no fixtures released yet</>
              )}
            </span>
          )}
        </div>
        <div className="season-toggle" role="tablist" aria-label="Dashboard view">
          {(
            [
              ['setup', 'Pre-season'],
              ['season', 'In season'],
              ...(reports ? ([['reports', "Captain's reports"]] as const) : []),
            ] as [SeasonMode, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={mode === k}
              className={mode === k ? 'on' : ''}
              onClick={() => pick(k)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {mode === 'reports' ? reports : mode === 'season' ? season : setup}
    </>
  );
}

/* ─── Union admin ─── */

interface AdminSeasonProps {
  orgName: string;
  clubs: Club[];
  allSeries: SeriesLike[];
  allClearances: ClearanceLike[];
  requiredDocs?: RequiredDoc[];
  complianceOn: boolean;
  clearancesOn: boolean;
  scoutingOn: boolean;
  gotoClub: (id: string) => void;
  gotoAdminView: (v: string) => void;
}

export function AdminSeasonDashboard({
  orgName,
  clubs,
  allSeries,
  allClearances,
  requiredDocs,
  complianceOn,
  clearancesOn,
  scoutingOn,
  gotoClub,
  gotoAdminView,
}: AdminSeasonProps) {
  const today = localISO(new Date());
  const clubBy = (id: string) => clubs.find((c) => c.id === id);
  const fixtures = releasedFixtures(allSeries, clubBy);
  const prog = seasonProgress(fixtures, today);
  const { upcoming, recent } = weekWindow(fixtures, today, 7);
  const series = seriesProgress(fixtures, today);

  // Clubs in action in the next 7 days, and which of them have admin gaps to chase.
  const playingIds = new Set(upcoming.flatMap((f) => [f.homeClubId, f.awayClubId]).filter(Boolean));
  const attention = clubs
    .filter((c) => playingIds.has(c.id))
    .map((c) => {
      const issues: string[] = [];
      if (!affiliationSubmitted(c)) issues.push('Affiliation incomplete');
      if (complianceOn) {
        const pct = docCompletion(c, requiredDocs);
        if (pct < 100) issues.push(`Documents ${pct}%`);
      }
      return { club: c, issues };
    })
    .filter((x) => x.issues.length);
  const pendingClearances = allClearances.filter((r) => r.status === 'pending').length;

  const event = SCOUTING_EVENTS[0];
  const topBat = event ? leaderboard(event.players, 'runs', '', 3) : [];
  const topBowl = event ? leaderboard(event.players, 'wkts', '', 3) : [];

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">{orgName} · Season</div>
          <h1 className="ph-title">
            Season <em>Dashboard</em>
          </h1>
          <p className="ph-desc">
            {!fixtures.length
              ? 'No released fixtures yet — release a series to bring this dashboard to life.'
              : prog.next
                ? `${prog.played} of ${prog.total} fixtures played across ${series.length} released series. This week, and what needs chasing before the weekend.`
                : `All ${prog.total} fixtures across ${series.length} released series have been played.`}
          </p>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" size="sm" icon={Icon.Field} onClick={() => gotoAdminView('fixtures')}>
            Fixtures & venues
          </Btn>
        </div>
      </div>

      <div className="kpi-strip ss-kpis">
        <KPI
          label="Season progress"
          num={`${prog.pct}%`}
          sub={`${prog.played} of ${prog.total} played`}
          tone="teal"
        />
        <KPI
          label="Next 7 days"
          num={upcoming.length}
          sub={`${playingIds.size} club${playingIds.size === 1 ? '' : 's'} in action`}
        />
        <KPI label="Last 7 days" num={recent.length} sub="Fixtures played" />
        {clearancesOn && (
          <KPI
            label="Clearances"
            num={pendingClearances}
            sub="Pending a decision"
            tone={pendingClearances ? 'warn' : ''}
          />
        )}
        <KPI
          label="Needs attention"
          num={attention.length}
          sub="Playing this week with gaps"
          tone={attention.length ? 'warn' : 'good'}
        />
      </div>

      <div className="ss-grid">
        <div className="ss-col">
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">This week</div>
                <div className="card-sub">
                  {fmtDay(today)} – {fmtDay(localISO(new Date(Date.now() + 6 * 86400000)))}
                </div>
              </div>
            </div>
            {upcoming.length ? (
              <div className="ss-fx-list">
                {upcoming.map((f) => (
                  <div key={f.key} className="ss-fx">
                    <div className="ss-fx-date">
                      <span>{fmtDay(f.date, { day: undefined, month: undefined })}</span>
                      <strong>{new Date(f.date + 'T00:00:00').getDate()}</strong>
                    </div>
                    <div className="ss-fx-main">
                      <div className="ss-fx-teams">
                        {f.homeName} <span>v</span> {f.awayName}
                      </div>
                      <div className="ss-fx-meta">
                        {f.series}
                        {f.venue && <> · {f.venue}</>}
                      </div>
                    </div>
                    {f.date === today && <Pill tone="teal">Today</Pill>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="ss-empty">
                {prog.next
                  ? `No fixtures in the next 7 days — next round ${fmtDay(prog.next)}.`
                  : 'No upcoming fixtures.'}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Just played</div>
                <div className="card-sub">Previous 7 days</div>
              </div>
            </div>
            {recent.length ? (
              <div className="ss-fx-list compact">
                {recent.map((f) => (
                  <div key={f.key} className="ss-fx">
                    <div className="ss-fx-main">
                      <div className="ss-fx-teams">
                        {f.homeName} <span>v</span> {f.awayName}
                      </div>
                      <div className="ss-fx-meta">
                        {fmtDay(f.date)} · {f.series}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="ss-empty">Nothing played in the last week.</div>
            )}
          </div>
        </div>

        <div className="ss-col">
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Series progress</div>
                <div className="card-sub">Released series</div>
              </div>
            </div>
            {series.length ? (
              <div className="ss-series">
                {series.map((s) => (
                  <div key={s.seriesId} className="ss-series-row">
                    <div className="ss-series-top">
                      <span className="ss-series-name">{s.series}</span>
                      <span className="ss-series-count">
                        {s.played}/{s.total}
                      </span>
                    </div>
                    <ProgressBar value={s.pct} tone="teal" />
                    <div className="ss-fx-meta">
                      {s.next ? `Next round ${fmtDay(s.next)}` : 'Complete'}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="ss-empty">No released series yet.</div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Needs attention</div>
                <div className="card-sub">Clubs playing this week with outstanding admin</div>
              </div>
            </div>
            {attention.length ? (
              <div className="ss-attn">
                {attention.map(({ club, issues }) => (
                  <button
                    key={club.id}
                    type="button"
                    className="ss-attn-row"
                    onClick={() => gotoClub(club.id)}
                  >
                    <span className="ss-attn-name">{club.name}</span>
                    <span className="ss-attn-issues">
                      {issues.map((i) => (
                        <Pill key={i} tone="gold">
                          {i}
                        </Pill>
                      ))}
                    </span>
                  </button>
                ))}
              </div>
            ) : playingIds.size ? (
              <div className="ss-empty ok">
                <Icon.Check /> Every club playing this week is affiliated
                {complianceOn ? ' and compliant' : ''}.
              </div>
            ) : (
              <div className="ss-empty">No clubs in action in the next 7 days.</div>
            )}
          </div>

          {scoutingOn && event && (
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Scouting snapshot</div>
                  <div className="card-sub">{event.name}</div>
                </div>
                <Btn tone="ghost" size="sm" onClick={() => gotoAdminView('scouting')}>
                  Open
                </Btn>
              </div>
              <div className="ss-scout">
                {(
                  [
                    ['Most runs', topBat],
                    ['Most wickets', topBowl],
                  ] as [string, typeof topBat][]
                ).map(([title, rows]) => (
                  <div key={title}>
                    <div className="ss-scout-title">{title}</div>
                    {rows.map((r, i) => (
                      <div key={r.player.name} className="ss-scout-row">
                        <span className="ss-scout-rank">{i + 1}</span>
                        <span className="ss-scout-name">
                          {r.player.name} <em>{r.player.hub}</em>
                        </span>
                        <strong>{r.value}</strong>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Club ─── */

interface ClubSeasonProps {
  club: Club;
  allSeries: SeriesLike[];
  clubs: Club[];
  directory: { id: string; name: string }[];
  players: PlayerRegistration[];
  clearances: { incoming?: ClearanceLike[]; outbound?: ClearanceLike[] };
  requiredDocs?: RequiredDoc[];
  complianceOn: boolean;
  clearancesOn: boolean;
  reportsOn: boolean;
  /** This club's captain's reports — a played fixture counts as filed once its report is submitted. */
  reports: CaptainsReport[];
  goto: (v: string) => void;
  onFileReport: (fixtureKey: string) => void;
}

export function ClubSeasonHome({
  club,
  allSeries,
  clubs,
  directory,
  players,
  clearances,
  requiredDocs,
  complianceOn,
  clearancesOn,
  reportsOn,
  reports,
  goto,
  onFileReport,
}: ClubSeasonProps) {
  const today = localISO(new Date());
  const clubBy = (id: string) =>
    clubs.find((c) => c.id === id) || directory.find((c) => c.id === id);
  const fixtures = clubFixtures(allSeries, club.id, clubBy); // newest first
  const asc = [...fixtures].reverse();
  const prog = seasonProgress(fixtures, today);
  const next = asc.find((f) => f.date >= today) ?? null;
  const later = asc.filter((f) => f.date >= today && f !== next).slice(0, 4);
  const played = fixtures.filter((f) => f.date < today);
  // A report names its fixture as seriesId + fixtureId; the dashboard keys fixtures the same way.
  const filed = new Set(
    reports.filter((r) => r.status === 'submitted').map((r) => `${r.seriesId}:${r.fixtureId}`),
  );
  const reportsDue = played.filter((f) => !filed.has(f.key)).length;
  const homeLeft = asc.filter((f) => f.date >= today && f.isHome).length;
  const awayLeft = asc.filter((f) => f.date >= today && !f.isHome).length;
  const pendingIn = (clearances?.incoming ?? []).filter((r) => r.status === 'pending').length;
  const docsPct = complianceOn ? docCompletion(club, requiredDocs) : null;

  if (!fixtures.length)
    return (
      <EmptyState
        icon={Icon.Field}
        title="No released fixtures yet"
        sub="The in-season dashboard fills in once the union releases your fixtures. Switch to Pre-season to finish setting up."
      />
    );

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Club Portal · {club.name} / Season</div>
          <h1 className="ph-title">
            Matchday <em>Hub</em>
          </h1>
          <p className="ph-desc">
            {prog.played} of {prog.total} matches played. Your next fixture, reports to file and
            squad admin in one place.
          </p>
        </div>
      </div>

      <div className="ss-hero">
        {next ? (
          <>
            <div className="ss-hero-main">
              <div className="ss-hero-eyebrow">Next match · {countdown(today, next.date)}</div>
              <div className="ss-hero-opp">
                <span>{next.isHome ? 'vs' : '@'}</span> {next.oppName}
              </div>
              <div className="ss-hero-meta">
                <span>
                  <Icon.Clock /> {fmtDay(next.date, { weekday: 'long', year: 'numeric' })}
                </span>
                {next.venue && (
                  <span>
                    <Icon.Field /> {next.venue}
                  </span>
                )}
                <span>{next.series}</span>
              </div>
            </div>
            <div className="ss-hero-side">
              <span className={`ss-ha ${next.isHome ? 'home' : 'away'}`}>
                {next.isHome ? 'Home' : 'Away'}
              </span>
              <Btn tone="outline" size="sm" onClick={() => goto('fixtures')}>
                All fixtures
              </Btn>
            </div>
          </>
        ) : (
          <div className="ss-hero-main">
            <div className="ss-hero-eyebrow">Season complete</div>
            <div className="ss-hero-opp">All {prog.total} matches played</div>
          </div>
        )}
      </div>

      <div className="kpi-strip ss-kpis">
        <KPI
          label="Played"
          num={`${prog.played}/${prog.total}`}
          sub={`${prog.pct}% of the season`}
          tone="teal"
        />
        <KPI
          label="Still to play"
          num={prog.remaining + prog.today}
          sub={`${homeLeft} home · ${awayLeft} away`}
        />
        {reportsOn && (
          <KPI
            label="Reports due"
            num={reportsDue}
            sub="Captain's reports to file"
            tone={reportsDue ? 'warn' : 'good'}
          />
        )}
        <KPI label="Registered players" num={players.length} sub="On your roster" />
      </div>

      <div className="ss-grid">
        <div className="ss-col">
          {reportsOn && (
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Captain's reports</div>
                  <div className="card-sub">Most recent matches</div>
                </div>
              </div>
              {played.length ? (
                <div className="ss-fx-list compact">
                  {played.slice(0, 4).map((f) => {
                    const done = filed.has(f.key);
                    return (
                      <div key={f.key} className="ss-fx">
                        <div className="ss-fx-main">
                          <div className="ss-fx-teams">
                            <span>{f.isHome ? 'vs' : '@'}</span> {f.oppName}
                          </div>
                          <div className="ss-fx-meta">
                            {fmtDay(f.date)} · {f.series}
                          </div>
                        </div>
                        {done ? (
                          <Pill tone="teal" dot>
                            Filed
                          </Pill>
                        ) : (
                          <Btn tone="ink" size="sm" onClick={() => onFileReport(f.key)}>
                            File report
                          </Btn>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="ss-empty">Reports open after your first match.</div>
              )}
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Coming up</div>
                <div className="card-sub">After the next match</div>
              </div>
            </div>
            {later.length ? (
              <div className="ss-fx-list compact">
                {later.map((f) => (
                  <div key={f.key} className="ss-fx">
                    <div className="ss-fx-main">
                      <div className="ss-fx-teams">
                        <span>{f.isHome ? 'vs' : '@'}</span> {f.oppName}
                      </div>
                      <div className="ss-fx-meta">
                        {fmtDay(f.date)}
                        {f.venue && <> · {f.venue}</>}
                      </div>
                    </div>
                    <span className={`ss-ha small ${f.isHome ? 'home' : 'away'}`}>
                      {f.isHome ? 'H' : 'A'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="ss-empty">Nothing else scheduled yet.</div>
            )}
          </div>
        </div>

        <div className="ss-col">
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Squad & admin</div>
                <div className="card-sub">Keep these clear so players stay eligible</div>
              </div>
            </div>
            <div className="ss-tiles">
              <button type="button" className="ss-tile" onClick={() => goto('players')}>
                <span className="ss-tile-l">Players</span>
                <strong>{players.length}</strong>
                <span className="ss-tile-s">registered</span>
              </button>
              {clearancesOn && (
                <button type="button" className="ss-tile" onClick={() => goto('clearances')}>
                  <span className="ss-tile-l">Clearances</span>
                  <strong>{pendingIn}</strong>
                  <span className="ss-tile-s">awaiting you</span>
                </button>
              )}
              {docsPct != null && (
                <button type="button" className="ss-tile" onClick={() => goto('documents')}>
                  <span className="ss-tile-l">Documents</span>
                  <strong>{docsPct}%</strong>
                  <span className="ss-tile-s">{docsPct === 100 ? 'compliant' : 'outstanding'}</span>
                </button>
              )}
              <button type="button" className="ss-tile" onClick={() => goto('affiliation')}>
                <span className="ss-tile-l">Affiliation</span>
                <strong>{affiliationSubmitted(club) ? 'Done' : 'Open'}</strong>
                <span className="ss-tile-s">2026/27</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Calendar check for the switch default — no hooks, cheap enough to run per render. */
export function seasonState(fixtures: { date: string }[]) {
  const today = localISO(new Date());
  const first = fixtures.map((f) => f.date).sort()[0] ?? null;
  return { started: seasonStarted(fixtures, today), firstDate: first };
}

/**
 * Cohort insights — the clubs/teams breakdown across leagues, districts and statuses.
 *
 * One presentational component serves two consoles: the tenant-admin "Insights" page
 * (fed by the Shell's existing clubs/leagues/districts/clearances data) and the
 * operator per-client overview (fed by GET /platform/tenants/:slug/overview). Both
 * satisfy the minimal InsightsClub shape, so the panels are guaranteed identical.
 *
 * The derivation helpers are pure and exported for tests, mirroring src/leagues.ts.
 */

import { useCopy } from './branding';
import { KPI, CountUp, EmptyState, Icon, Btn } from './atoms';
import { REQUIRED_DOCS } from './data';
import {
  teamCounts,
  optionsGroupedByGroup,
  leagueOptionsForDistrict,
  clubTeamsForLeague,
  findByKey,
} from './leagues';
import type {
  InsightsClub,
  League,
  ClearanceStatus,
  ChairContact,
  DemographicBucket,
  DemographicsSummary,
  DemographicsResponse,
} from './types';

/** Sides a club fields in one league — absent map/key counts as 1 (legacy clubs). */
const teamsIn = (club: InsightsClub, key: string) =>
  Math.max(1, Number(club.leagueTeams?.[key]) || 1);

/** Every side a club fields across all its leagues. */
const totalTeams = (club: InsightsClub) =>
  (club.leagues || []).reduce((s, k) => s + teamsIn(club, k), 0);

export interface LeagueRow {
  key: string;
  label: string;
  group: string;
  clubCount: number;
  teamCount: number;
}

/**
 * Per-league club/team counts ({rows, orphans} — not a bare array), plus the orphans:
 * league keys clubs still reference after the league was deleted from the catalogue.
 * teamCounts() counts orphan keys as senior teams, so the KPI teams total only
 * reconciles with the visible league rows when the orphan club/team counts are
 * surfaced alongside them.
 */
export function leagueBreakdown(clubs: InsightsClub[], leagues: League[]) {
  const rows: LeagueRow[] = (leagues || []).map((l) => {
    const entered = (clubs || []).filter((c) => (c.leagues || []).includes(l.key));
    return {
      key: l.key,
      label: l.label,
      group: l.group,
      clubCount: entered.length,
      teamCount: entered.reduce((s, c) => s + teamsIn(c, l.key), 0),
    };
  });
  const known = new Set((leagues || []).map((l) => l.key));
  const orphanKeys = new Set<string>();
  const orphanClubs = new Set<string>();
  let orphanTeams = 0;
  for (const c of clubs || []) {
    for (const k of c.leagues || []) {
      if (known.has(k)) continue;
      orphanKeys.add(k);
      orphanClubs.add(c.id);
      orphanTeams += teamsIn(c, k);
    }
  }
  return {
    rows,
    orphans: { keys: [...orphanKeys], clubCount: orphanClubs.size, teamCount: orphanTeams },
  };
}

export interface DistrictRow {
  name: string;
  clubCount: number;
  teamCount: number;
  leagueCount: number;
  /** True for the synthetic row collecting clubs whose district isn't in the list. */
  other?: boolean;
}

/**
 * Per-district club/team counts + how many leagues a club there could enter. An empty
 * district renders with zeros (a real signal, not noise); clubs whose district isn't
 * in the tenant list collect under a synthetic "Other / unassigned" row.
 */
export function districtRows(
  clubs: InsightsClub[],
  leagues: League[],
  districts: string[],
): DistrictRow[] {
  const list = Array.isArray(districts) ? districts : [];
  const rows: DistrictRow[] = list.map((d) => {
    const inD = (clubs || []).filter((c) => c.district === d);
    return {
      name: d,
      clubCount: inD.length,
      teamCount: inD.reduce((s, c) => s + totalTeams(c), 0),
      leagueCount: leagueOptionsForDistrict(leagues, d).length,
    };
  });
  const known = new Set(list);
  const stray = (clubs || []).filter((c) => !known.has(c.district));
  if (stray.length)
    rows.push({
      name: 'Other / unassigned',
      clubCount: stray.length,
      teamCount: stray.reduce((s, c) => s + totalTeams(c), 0),
      leagueCount: 0,
      other: true,
    });
  return rows;
}

/**
 * Clearance pipeline tallies. NOTE the wire value is the hyphenated
 * 'admin-override' (packages/api/src/types.ts) — camelCase is only the JS bucket.
 */
export function clearanceCounts(clearances: Array<{ status: ClearanceStatus }>) {
  const counts = { pending: 0, approved: 0, adminOverride: 0, rejected: 0 };
  for (const cl of clearances || []) {
    if (cl.status === 'pending') counts.pending++;
    else if (cl.status === 'approved') counts.approved++;
    else if (cl.status === 'admin-override') counts.adminOverride++;
    else if (cl.status === 'rejected') counts.rejected++;
  }
  return counts;
}

/** Affiliation status rows — the third bucket back-computes so legacy/absent values count. */
export function affiliationRows(clubs: InsightsClub[]) {
  const complete = (clubs || []).filter((c) => c.affiliation === 'complete').length;
  const inProgress = (clubs || []).filter((c) => c.affiliation === 'in_progress').length;
  return [
    { key: 'complete', label: 'Affiliated', count: complete, tone: '' },
    { key: 'in_progress', label: 'In progress', count: inProgress, tone: 'warn' },
    {
      key: 'not_started',
      label: 'Not started',
      count: (clubs || []).length - complete - inProgress,
      tone: 'pending',
    },
  ];
}

/* ── CQI-band + doc-compliance derivations, shared with ClubInsights (admin.tsx) so
      the band/threshold definitions can't drift between the two panels. ── */

export const cqiBandTone = (key: string) =>
  key === 'C' ? 'warn' : key === 'D' ? 'danger' : key === 'P' ? 'pending' : '';

export function cqiBandRows(clubs: InsightsClub[]) {
  const bands = [
    { key: 'A', label: 'A · 80+', count: clubs.filter((c) => c.cqi >= 80).length },
    { key: 'B', label: 'B · 65–80', count: clubs.filter((c) => c.cqi >= 65 && c.cqi < 80).length },
    { key: 'C', label: 'C · 50–65', count: clubs.filter((c) => c.cqi >= 50 && c.cqi < 65).length },
    { key: 'D', label: 'D · <50', count: clubs.filter((c) => c.cqi > 0 && c.cqi < 50).length },
    { key: 'P', label: 'Pending', count: clubs.filter((c) => c.cqi === 0).length },
  ];
  const submitted = clubs.filter((c) => c.cqi > 0);
  const avgCqi = submitted.length ? submitted.reduce((s, c) => s + c.cqi, 0) / submitted.length : 0;
  return { bands, maxBand: Math.max(...bands.map((b) => b.count), 1), submitted, avgCqi };
}

export const docTone = (pct: number) => (pct >= 70 ? '' : pct >= 40 ? 'warn' : 'danger');

export function docComplianceRows(clubs: InsightsClub[]) {
  const docStats = REQUIRED_DOCS.map((d) => {
    const uploaded = clubs.filter((c) => c.docs?.[d.key]).length;
    const pct = clubs.length ? Math.round((uploaded / clubs.length) * 100) : 0;
    return { key: d.key, name: d.name, count: uploaded, total: clubs.length, pct };
  });
  const mostMissing = [...docStats].sort((a, b) => a.count - b.count)[0];
  return { docStats, mostMissing };
}

/**
 * Share of total as a display string — one decimal, trailing-zero-free ("37.5%",
 * "100%", "33.3%"). Zero total guards to '0%'. Convention across the insights cards:
 * number column = percentage, tooltip = raw count; callout prose and the KPI strip
 * stay raw counts. Bucket percentages may not sum to exactly 100% (33.3 × 3) —
 * acceptable, since the tooltips carry the raw counts.
 */
export function pct(count: number, total: number): string {
  return `${pctNum(count, total)}%`;
}

/** Numeric twin of pct() for CountUp (which animates a number, not a string). */
export function pctNum(count: number, total: number): number {
  return total ? Math.round((count / total) * 1000) / 10 : 0;
}

/**
 * Resolve a club's chair contact from either wire shape: the operator projection's
 * picked `chairContact`, else the admin `exco.chair` blob; the display name falls
 * back to the flat `club.chair` field. Pure, tolerant of legacy/partial records.
 */
export function chairContactOf(club: InsightsClub): ChairContact {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const ex = (club.exco?.chair ?? {}) as Record<string, unknown>;
  return {
    name: str(club.chairContact?.name) ?? str(ex.name) ?? str(club.chair),
    email: str(club.chairContact?.email) ?? str(ex.email),
    cell: str(club.chairContact?.cell) ?? str(ex.cell),
  };
}

export interface LeagueTeamRow {
  teamId: string;
  teamName: string;
  clubId: string;
  clubName: string;
  chairName?: string;
  chairEmail?: string;
  chairCell?: string;
}

/**
 * Every team entered in one league, with its owning club and chair contact — the
 * drill-down directory. Reuses clubTeamsForLeague so named rosters, padded fallback
 * sides and the club-is-team single entry match the fixtures pool exactly. Sorted by
 * club name, then team name.
 */
export function leagueTeamDirectory(clubs: InsightsClub[], leagueKey: string): LeagueTeamRow[] {
  const rows: LeagueTeamRow[] = [];
  for (const c of clubs || []) {
    if (!(c.leagues || []).includes(leagueKey)) continue;
    const chair = chairContactOf(c);
    for (const t of clubTeamsForLeague(c, leagueKey)) {
      rows.push({
        teamId: t.teamId,
        teamName: t.name,
        clubId: c.id,
        clubName: c.name,
        chairName: chair.name,
        chairEmail: chair.email,
        chairCell: chair.cell,
      });
    }
  }
  rows.sort((a, b) => a.clubName.localeCompare(b.clubName) || a.teamName.localeCompare(b.teamName));
  return rows;
}

/* ─── The shared breakdown ─── */

/** Legend for dual-value rows — colour-pairs with DuoRow's bars and numbers. */
const DuoLegend = () => (
  <div className="insights-legend">
    <span>
      <i />
      clubs
    </span>
    <span>
      <i className="ghost" />
      teams
    </span>
  </div>
);

/**
 * One dual-value bar row: solid fill = clubs, tinted = teams, both on the card's
 * shared scale so rows compare against each other. Teams normally extend past clubs
 * (each entered club fields ≥1 side); when teams are FEWER — clubs with no league
 * entries yet — the teams bar renders as a pale inset over the solid bar instead,
 * so it never hides behind it. The number columns mirror the fill colours
 * (ink = clubs, muted = teams).
 *
 * NOTE the deliberately inverted percentage convention here: the number columns keep
 * RAW counts visible and the percentages live in the tooltip. Club% and team% use
 * different denominators (cohort clubs vs all teams) while the bars share one
 * per-card scale — percentages beside the bars would read contradictory in a row.
 *
 * `onOpen` makes the row a native <button> (keyboard access for free); the inner
 * cells switch to <span>s because a button's content model is phrasing content —
 * divs inside a button are invalid HTML. Without it the row renders exactly as
 * before, as plain divs.
 */
function DuoRow({
  label,
  title,
  clubCount,
  teamCount,
  max,
  onOpen,
}: {
  label: string;
  title?: string;
  clubCount: number;
  teamCount: number;
  max: number;
  onOpen?: () => void;
}) {
  // The ghost is absolutely positioned so it always paints over the solid bar:
  // green at low opacity is invisible where they overlap (the solid reads clean) and
  // tints only the extension beyond it. In the inset case it switches to a white
  // overlay, lightening the covered clubs segment — "tinted = teams" either way.
  const teamsInset = teamCount < clubCount;
  const Cell: 'span' | 'div' = onOpen ? 'span' : 'div';
  const cells = (
    <>
      <Cell className="insights-bar-label" title={title ?? label}>
        {label}
      </Cell>
      <Cell className="insights-bar-track">
        <Cell className="insights-bar-fill" style={{ width: (clubCount / max) * 100 + '%' }} />
        <Cell
          className={`insights-bar-fill ghost${teamsInset ? ' inset' : ''}`}
          style={{ width: (teamCount / max) * 100 + '%' }}
        />
      </Cell>
      <Cell className="insights-bar-num">{clubCount}</Cell>
      <Cell className="insights-bar-num sub">{teamCount}</Cell>
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className="insights-bar-row duo clickable"
      onClick={onOpen}
      // aria-label overrides the content-derived name, so it must carry BOTH the
      // counts sighted users see and the action the bare numbers don't announce.
      aria-label={`${label}: ${clubCount} clubs, ${teamCount} teams — view league team directory`}
    >
      {cells}
    </button>
  ) : (
    <div className="insights-bar-row duo">{cells}</div>
  );
}

interface InsightsBreakdownProps {
  clubs: InsightsClub[];
  leagues: League[];
  districts: string[];
  clearances: Array<{ status: ClearanceStatus }>;
  /** 'operator' notes the standard doc set on the compliance card. */
  context?: 'admin' | 'operator';
  /** When set, league rows become clickable and open the league drill-down. */
  onOpenLeague?: (key: string) => void;
  /** Anonymised demographics; the card is skipped while undefined (loading/old backend). */
  demographics?: DemographicsResponse;
}

export function InsightsBreakdown({
  clubs,
  leagues,
  districts,
  clearances,
  context = 'admin',
  onOpenLeague,
  demographics,
}: InsightsBreakdownProps) {
  if (!clubs.length)
    return (
      <EmptyState
        icon={Icon.Clubs}
        title="No clubs yet"
        sub="Breakdowns appear here once the first club is onboarded."
      />
    );

  // KPI totals — teamCounts includes orphan league keys (as senior), so the strip
  // reconciles with the league rows via the orphan callout below.
  const split = clubs.reduce(
    (acc, c) => {
      const t = teamCounts(c.leagues || [], leagues, c.leagueTeams);
      return {
        senior: acc.senior + t.senior,
        women: acc.women + t.women,
        junior: acc.junior + t.junior,
      };
    },
    { senior: 0, women: 0, junior: 0 },
  );
  const teamsTotal = split.senior + split.women + split.junior;
  // Denormalized sum of club.playerCount (drift documented at repo.ts:865), while
  // demographics.totalPlayers counts real player rows — brief drift between the two
  // is expected and self-heals; don't "fix" one against the other.
  const playersTotal = clubs.reduce((s, c) => s + (c.players || 0), 0);

  // Dual-bar scale: teams normally dominate, but a cohort with clubs and no league
  // entries (teams 0) must still scale to its club counts or the solid bar overflows.
  const duoMax = (rows: Array<{ clubCount: number; teamCount: number }>) =>
    Math.max(...rows.map((r) => Math.max(r.teamCount, r.clubCount)), 1);

  const { rows: lgRows, orphans } = leagueBreakdown(clubs, leagues);
  const lgMax = duoMax(lgRows);
  const grouped = optionsGroupedByGroup(leagues);
  const enteredLeagues = lgRows.filter((r) => r.clubCount > 0).length;

  const dRows = districtRows(clubs, leagues, districts);
  const dMax = duoMax(dRows);
  const noLeagueDistricts = dRows.filter((r) => !r.other && r.leagueCount === 0);
  const busiest = [...dRows].sort((a, b) => b.clubCount - a.clubCount)[0];

  const affRows = affiliationRows(clubs);
  const { bands, maxBand, submitted, avgCqi } = cqiBandRows(clubs);
  const { docStats, mostMissing } = docComplianceRows(clubs);
  const cc = clearanceCounts(clearances);
  const ccTotal = cc.pending + cc.approved + cc.adminOverride + cc.rejected;
  const ccApproved = cc.approved + cc.adminOverride;
  const pendingPct = pctNum(cc.pending, ccTotal);
  const approvedPct = pctNum(ccApproved, ccTotal);
  const rejectedPct = pctNum(cc.rejected, ccTotal);

  return (
    <div>
      <div className="kpi-strip">
        <KPI label="Clubs" num={<CountUp to={clubs.length} />} sub="in the cohort" />
        <KPI
          label="Teams entered"
          num={<CountUp to={teamsTotal} />}
          sub={`${split.senior} senior · ${split.women} women · ${split.junior} junior`}
        />
        <KPI label="Players" num={<CountUp to={playersTotal} />} sub="registered" />
        <KPI
          label="Leagues"
          num={<CountUp to={leagues.length} />}
          sub={`${enteredLeagues} with entries`}
        />
        <KPI
          label="Pending clearances"
          num={<CountUp to={cc.pending} />}
          sub="awaiting action"
          tone={cc.pending > 0 ? 'warn' : 'good'}
        />
      </div>

      <div className="insights-panel">
        {/* ─── Clubs & teams per league ─── */}
        <div className="insights-card">
          <div className="insights-card-head">
            <div className="insights-card-title">Clubs &amp; Teams per League</div>
            <DuoLegend />
          </div>
          <div className={lgRows.length > 8 ? 'insights-scroll' : undefined}>
            {Object.entries(grouped).map(([group, ls]) => (
              <div key={group}>
                <div className="insights-group-label">{group}</div>
                {(ls as League[]).map((l) => {
                  const r = lgRows.find((row) => row.key === l.key)!;
                  return (
                    <DuoRow
                      key={r.key}
                      label={r.label}
                      title={`${r.label} — ${r.clubCount} clubs (${pct(r.clubCount, clubs.length)} of cohort), ${r.teamCount} teams (${pct(r.teamCount, teamsTotal)} of all teams)`}
                      clubCount={r.clubCount}
                      teamCount={r.teamCount}
                      max={lgMax}
                      onOpen={onOpenLeague ? () => onOpenLeague(r.key) : undefined}
                    />
                  );
                })}
              </div>
            ))}
            {leagues.length === 0 && (
              <div className="insights-callout warn">
                No leagues in the catalogue yet — clubs can't enter competitions until leagues are
                created.
              </div>
            )}
          </div>
          {leagues.length > 0 && (
            <div className="insights-callout good">
              <strong>{split.senior}</strong> senior · <strong>{split.women}</strong> women's ·{' '}
              <strong>{split.junior}</strong> junior teams across {enteredLeagues} league
              {enteredLeagues === 1 ? '' : 's'} with entries
            </div>
          )}
          {orphans.keys.length > 0 && (
            <div className="insights-callout warn">
              <strong>{orphans.clubCount}</strong> club{orphans.clubCount === 1 ? '' : 's'} still
              reference{orphans.clubCount === 1 ? 's' : ''} <strong>{orphans.keys.length}</strong>{' '}
              removed league{orphans.keys.length === 1 ? '' : 's'} — those{' '}
              <strong>{orphans.teamCount}</strong> team{orphans.teamCount === 1 ? '' : 's'} count as
              senior in the totals above.
            </div>
          )}
        </div>

        {/* ─── Clubs per district ─── */}
        <div className="insights-card">
          <div className="insights-card-head">
            <div className="insights-card-title">Clubs per District</div>
            <DuoLegend />
          </div>
          <div className={dRows.length > 8 ? 'insights-scroll' : undefined}>
            {dRows.map((r) => (
              <DuoRow
                key={r.name}
                label={r.name}
                title={
                  r.other
                    ? `${r.name} — ${r.clubCount} clubs (${pct(r.clubCount, clubs.length)} of cohort), ${r.teamCount} teams (${pct(r.teamCount, teamsTotal)} of all teams)`
                    : `${r.name} — ${r.clubCount} clubs (${pct(r.clubCount, clubs.length)} of cohort), ${r.teamCount} teams (${pct(r.teamCount, teamsTotal)} of all teams), ${r.leagueCount} leagues available`
                }
                clubCount={r.clubCount}
                teamCount={r.teamCount}
                max={dMax}
              />
            ))}
          </div>
          {busiest && busiest.clubCount > 0 && (
            <div className="insights-callout good">
              Strongest district: <strong>{busiest.name}</strong> with{' '}
              <strong>{busiest.clubCount}</strong> club{busiest.clubCount === 1 ? '' : 's'} fielding{' '}
              <strong>{busiest.teamCount}</strong> team{busiest.teamCount === 1 ? '' : 's'}
            </div>
          )}
          {noLeagueDistricts.length > 0 && (
            <div className="insights-callout warn">
              <strong>{noLeagueDistricts.length}</strong> district
              {noLeagueDistricts.length === 1 ? ' has' : 's have'} no leagues available yet:{' '}
              {noLeagueDistricts.map((d) => d.name).join(', ')}
            </div>
          )}
        </div>

        {/* ─── Affiliation status ─── */}
        <div className="insights-card">
          <div className="insights-card-head">
            <div className="insights-card-title">Affiliation Status</div>
            <div className="insights-card-meta">of {clubs.length} clubs</div>
          </div>
          {affRows.map((r) => (
            <div key={r.key} className="insights-bar-row">
              <div className="insights-bar-label">{r.label}</div>
              <div className="insights-bar-track">
                <div
                  className={`insights-bar-fill ${r.tone}`}
                  style={{ width: (r.count / Math.max(1, clubs.length)) * 100 + '%' }}
                />
              </div>
              <div className="insights-bar-num" title={`${r.count} of ${clubs.length} clubs`}>
                {pct(r.count, clubs.length)}
              </div>
            </div>
          ))}
          <div
            className={`insights-callout ${affRows[0].count === clubs.length ? 'good' : 'warn'}`}
          >
            <strong>{affRows[0].count}</strong> of {clubs.length} clubs affiliated —{' '}
            <strong>{clubs.length - affRows[0].count}</strong> still to submit
          </div>
        </div>

        {/* ─── CQI score distribution ─── */}
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
                  className={`insights-bar-fill ${cqiBandTone(b.key)}`}
                  style={{ width: (b.count / maxBand) * 100 + '%' }}
                />
              </div>
              <div className="insights-bar-num" title={`${b.count} of ${clubs.length} clubs`}>
                {pct(b.count, clubs.length)}
              </div>
            </div>
          ))}
          <div className="insights-callout good">
            <strong>{submitted.length}</strong> of {clubs.length} clubs submitted CQI
          </div>
        </div>

        {/* ─── Document compliance ─── */}
        <div className="insights-card">
          <div className="insights-card-head">
            <div className="insights-card-title">Document Compliance</div>
            <div className="insights-card-meta">
              of {clubs.length} clubs{context === 'operator' ? ' · standard doc set' : ''}
            </div>
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
              <div className="insights-bar-num" title={`${d.count} of ${d.total} clubs`}>
                {pct(d.count, d.total)}
              </div>
            </div>
          ))}
          <div className={`insights-callout ${mostMissing.pct < 40 ? 'alert' : 'warn'}`}>
            Most missing: <strong>{mostMissing.name}</strong> — only{' '}
            <strong>{mostMissing.count}</strong> of {mostMissing.total} clubs uploaded
          </div>
        </div>

        {/* ─── Players & clearances ─── */}
        <div className="insights-card">
          <div className="insights-card-head">
            <div className="insights-card-title">Players &amp; Clearances</div>
            <div className="insights-card-meta">transfer pipeline</div>
          </div>
          <div className="resource-list">
            <div className="resource-row">
              <span className="resource-num good">
                <CountUp to={playersTotal} />
              </span>
              <span className="resource-text">
                <strong>players</strong> registered across the cohort
              </span>
            </div>
            <div className="resource-row">
              <span
                className={`resource-num ${cc.pending > 0 ? 'warn' : 'good'}`}
                title={`${cc.pending} of ${ccTotal} clearances`}
              >
                <CountUp
                  to={pendingPct}
                  decimals={Number.isInteger(pendingPct) ? 0 : 1}
                  suffix="%"
                />
              </span>
              <span className="resource-text">
                <strong>{cc.pending === 1 ? 'clearance' : 'clearances'}</strong> pending — awaiting
                a club or admin decision
              </span>
            </div>
            <div className="resource-row">
              <span className="resource-num good" title={`${ccApproved} of ${ccTotal} clearances`}>
                <CountUp
                  to={approvedPct}
                  decimals={Number.isInteger(approvedPct) ? 0 : 1}
                  suffix="%"
                />
              </span>
              <span className="resource-text">
                <strong>approved</strong>
                {cc.adminOverride > 0 ? ` (incl. ${cc.adminOverride} by admin override)` : ''}
              </span>
            </div>
            <div className="resource-row">
              <span
                className={`resource-num ${cc.rejected > 0 ? 'danger' : 'good'}`}
                title={`${cc.rejected} of ${ccTotal} clearances`}
              >
                <CountUp
                  to={rejectedPct}
                  decimals={Number.isInteger(rejectedPct) ? 0 : 1}
                  suffix="%"
                />
              </span>
              <span className="resource-text">
                <strong>rejected</strong> transfer {cc.rejected === 1 ? 'request' : 'requests'}
              </span>
            </div>
          </div>
        </div>

        {/* ─── Player demographics (skipped while the query loads / older backend) ─── */}
        {demographics && (
          <DemographicsCard summary={demographics} unattributed={demographics.unattributed} />
        )}
      </div>
    </div>
  );
}

/* ─── Player demographics card (shared: cohort card + per-league drill-down) ─── */

/** One demographic section — a labelled group of single-fill percentage rows. */
function DemographicSection({
  label,
  buckets,
  total,
}: {
  label: string;
  buckets: DemographicBucket[];
  total: number;
}) {
  if (!buckets.length) return null;
  return (
    <div>
      <div className="insights-group-label">{label}</div>
      {buckets.map((b) => (
        <div key={b.label} className="insights-bar-row">
          <div className="insights-bar-label" title={b.label}>
            {b.label}
          </div>
          <div className="insights-bar-track">
            <div
              className="insights-bar-fill"
              style={{ width: (b.count / Math.max(1, total)) * 100 + '%' }}
            />
          </div>
          <div className="insights-bar-num" title={`${b.count} of ${total} players`}>
            {pct(b.count, total)}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Anonymised player demographics — age groups, gender and race as percentages of the
 * slice's players (raw counts in the tooltips). Rendered with the cohort summary on
 * the insights page and with a per-league summary on the drill-down pages.
 */
export function DemographicsCard({
  summary,
  heading = 'Player Demographics',
  unattributed,
}: {
  summary: DemographicsSummary;
  heading?: string;
  /** Cohort card only: players that can't be attributed to a league (see callout). */
  unattributed?: DemographicsSummary;
}) {
  return (
    <div className="insights-card">
      <div className="insights-card-head">
        <div className="insights-card-title">{heading}</div>
        <div className="insights-card-meta">
          of {summary.totalPlayers} player{summary.totalPlayers === 1 ? '' : 's'}
        </div>
      </div>
      {summary.totalPlayers === 0 ? (
        <div className="insights-callout warn">
          No registered players in this view yet — demographic breakdowns appear once players are
          registered.
        </div>
      ) : (
        <>
          <DemographicSection
            label="Age groups"
            buckets={summary.ageGroups}
            total={summary.totalPlayers}
          />
          <DemographicSection
            label="Gender"
            buckets={summary.gender}
            total={summary.totalPlayers}
          />
          <DemographicSection label="Race" buckets={summary.race} total={summary.totalPlayers} />
        </>
      )}
      {unattributed && unattributed.totalPlayers > 0 && (
        <div
          className="insights-callout warn"
          title={`${unattributed.totalPlayers} of ${summary.totalPlayers} players unattributed`}
        >
          <strong>{unattributed.totalPlayers}</strong> player
          {unattributed.totalPlayers === 1 ? '' : 's'} can't be attributed to a league — registered
          before league assignment, or their club plays multiple leagues. They count in the totals
          above but in no per-league breakdown.
        </div>
      )}
    </div>
  );
}

/* ─── League drill-down: team directory + detail page ─── */

/** tel: hrefs allow only + and digits — strip spaces, hyphens, parens from the cell. */
const telHref = (cell: string) => cell.replace(/[^+\d]/g, '');

/**
 * Every team in one league with its owning club and the chair's contact details.
 * Club name is a button into the club detail when `onOpenClub` is given (admin);
 * plain text otherwise (operator). Email/cell render as mailto:/tel: links, only
 * when present.
 */
export function LeagueTeamDirectoryCard({
  clubs,
  leagueKey,
  onOpenClub,
}: {
  clubs: InsightsClub[];
  leagueKey: string;
  onOpenClub?: (clubId: string) => void;
}) {
  const rows = leagueTeamDirectory(clubs, leagueKey);
  if (!rows.length)
    return (
      <EmptyState
        icon={Icon.Clubs}
        title="No teams entered"
        sub="No club has entered this league yet — teams appear here once affiliations name it."
      />
    );
  const clubCount = new Set(rows.map((r) => r.clubId)).size;
  return (
    <div className="insights-card">
      <div className="insights-card-head">
        <div className="insights-card-title">Team Directory</div>
        <div className="insights-card-meta">chair contact per club</div>
      </div>
      <div className="kpi-strip mini">
        <KPI label="Teams" num={<CountUp to={rows.length} />} sub="in this league" />
        <KPI label="Clubs" num={<CountUp to={clubCount} />} sub="fielding sides" />
      </div>
      {rows.map((r) => (
        <div key={r.teamId} className="league-directory-row">
          <div className="league-directory-team">{r.teamName}</div>
          <div className="league-directory-club">
            {onOpenClub ? (
              <button
                type="button"
                className="league-directory-club-link"
                onClick={() => onOpenClub(r.clubId)}
              >
                {r.clubName}
              </button>
            ) : (
              <span>{r.clubName}</span>
            )}
          </div>
          <div className="league-directory-contact">
            {r.chairName && <span className="league-directory-chair">{r.chairName}</span>}
            {r.chairEmail && <a href={`mailto:${r.chairEmail}`}>{r.chairEmail}</a>}
            {r.chairCell && <a href={`tel:${telHref(r.chairCell)}`}>{r.chairCell}</a>}
          </div>
        </div>
      ))}
    </div>
  );
}

interface AdminLeagueDetailPageProps {
  clubs: InsightsClub[];
  leagues: League[];
  leagueKey: string;
  demographics?: DemographicsResponse;
  onBack: () => void;
  onOpenClub?: (clubId: string) => void;
}

/** The league drill-down sub-dashboard (admin Shell). */
export function AdminLeagueDetailPage({
  clubs,
  leagues,
  leagueKey,
  demographics,
  onBack,
  onOpenClub,
}: AdminLeagueDetailPageProps) {
  const copy = useCopy();
  // Falls back to the raw key for orphaned leagues (deleted from the catalogue).
  const label = findByKey(leagues, leagueKey)?.label || leagueKey;
  const leagueDemo = demographics?.perLeague?.[leagueKey];
  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">
            {copy.crumbRoot} · Admin Console / Insights / {label}
          </div>
          <h1 className="ph-title">{label}</h1>
          <p className="ph-desc">
            Every team entered in this league, the club that fields it, and the chair to contact —
            plus the league's player demographics.
          </p>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" size="sm" onClick={onBack}>
            Back to insights
          </Btn>
        </div>
      </div>
      <div className="insights-panel league-detail">
        <LeagueTeamDirectoryCard clubs={clubs} leagueKey={leagueKey} onOpenClub={onOpenClub} />
        {demographics && (
          <DemographicsCard
            summary={leagueDemo ?? { totalPlayers: 0, ageGroups: [], gender: [], race: [] }}
          />
        )}
      </div>
    </div>
  );
}

/* ─── Tenant-admin page (rendered inside the admin Shell) ─── */

interface AdminInsightsPageProps {
  clubs: InsightsClub[];
  leagues: League[];
  districts: string[];
  clearances: Array<{ status: ClearanceStatus }>;
  onOpenLeague?: (key: string) => void;
  demographics?: DemographicsResponse;
}

export function AdminInsightsPage({
  clubs,
  leagues,
  districts,
  clearances,
  onOpenLeague,
  demographics,
}: AdminInsightsPageProps) {
  const copy = useCopy();
  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">{copy.crumbRoot} · Admin Console / Insights</div>
          <h1 className="ph-title">
            Season <em>insights</em>
          </h1>
          <p className="ph-desc">
            How the cohort is organised — clubs and teams across every league, district and status,
            plus the player and clearance pipeline.
          </p>
        </div>
      </div>
      <InsightsBreakdown
        clubs={clubs}
        leagues={leagues}
        districts={districts}
        clearances={clearances}
        onOpenLeague={onOpenLeague}
        demographics={demographics}
      />
    </div>
  );
}

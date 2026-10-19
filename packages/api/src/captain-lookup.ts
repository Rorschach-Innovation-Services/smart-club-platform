/**
 * Captain resolution for a club: the captain named on the club's most relevant submitted
 * captain's report, matched against the club roster. Pure apart from the optional
 * `listPlayers` dep — callers fetch reports/scorecards once per run and pass them in.
 */
import { hasContact } from './captains-reports.js';
import type { CaptainsReport, PlayerRegistration, StoredFixtureScorecard } from './types.js';

export const normalizeName = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

export interface SourceReportOpts {
  seriesId?: string;
  competition?: string;
}

export function pickSourceReport(
  reports: CaptainsReport[],
  clubId: string,
  opts: SourceReportOpts = {},
): CaptainsReport | null {
  const candidates = reports
    .filter((r) => r.status === 'submitted' && r.clubId === clubId && r.captainName?.trim())
    .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
  return (
    (opts.seriesId && candidates.find((r) => r.seriesId === opts.seriesId)) ||
    (opts.competition && candidates.find((r) => r.competition === opts.competition)) ||
    candidates[0] ||
    null
  );
}

export type CaptainLookupReason =
  | 'no-history'
  | 'blank-captain'
  | 'not-on-roster'
  | 'ambiguous-roster'
  | 'minor'
  | 'inactive'
  | 'no-contact';

export interface CaptainMatch {
  name: string;
  playerKey?: string;
  email?: string;
  cell?: string;
}

export interface CaptainLookup {
  captainName: string;
  fromReport?: CaptainsReport;
  match: CaptainMatch | null;
  playedBefore?: boolean;
  initialOnly?: boolean;
  reason?: CaptainLookupReason;
}

export interface CaptainLookupDeps {
  reports: CaptainsReport[];
  roster?: PlayerRegistration[];
  listPlayers?: (tenant: string, clubId: string) => Promise<PlayerRegistration[]>;
  scorecards?: StoredFixtureScorecard[];
}

export interface CaptainLookupOpts extends SourceReportOpts {
  /** Club name plus aliases, used to attribute scorecard innings to the club. */
  clubNames?: string[];
}

const fullName = (p: PlayerRegistration) => normalizeName(`${p.firstName} ${p.lastName}`);

/** Roster players whose name equals `name`; `initialOnly` when only "S Phewa" form matched. */
function nameMatches(name: string, roster: PlayerRegistration[]) {
  const target = normalizeName(name);
  const exact = roster.filter((p) => fullName(p) === target);
  if (exact.length) return { players: exact, initialOnly: false };
  const [first, ...rest] = target.split(' ');
  if (first?.length !== 1 || !rest.length) return { players: [], initialOnly: false };
  const surname = rest.join(' ');
  const initial = roster.filter(
    (p) => normalizeName(p.firstName).startsWith(first) && normalizeName(p.lastName) === surname,
  );
  return { players: initial, initialOnly: initial.length > 0 };
}

export function playedBeforeIn(
  name: string,
  scorecards: StoredFixtureScorecard[],
  clubNames: string[],
): boolean {
  const target = normalizeName(name);
  const clubs = clubNames.map(normalizeName).filter(Boolean);
  const isClub = (team: string) => {
    const t = normalizeName(team);
    return clubs.some((c) => t.includes(c));
  };
  for (const card of scorecards) {
    const innings = card.innings ?? [];
    for (const inn of innings) {
      if (isClub(inn.battingTeamName)) {
        if (inn.batters.some((b) => normalizeName(b.name) === target)) return true;
        if (inn.fallOfWickets.some((f) => normalizeName(f.batterName) === target)) return true;
      } else if (innings.some((o) => o !== inn && isClub(o.battingTeamName))) {
        // The club bowled in this innings: its opponent batted, and the club batted in another.
        if (inn.bowlers.some((b) => normalizeName(b.name) === target)) return true;
      }
    }
  }
  return false;
}

export async function resolveClubCaptain(
  deps: CaptainLookupDeps,
  tenant: string,
  clubId: string,
  opts: CaptainLookupOpts = {},
): Promise<CaptainLookup> {
  const fromReport = pickSourceReport(deps.reports, clubId, opts) ?? undefined;
  if (!fromReport) {
    const anySubmitted = deps.reports.some((r) => r.status === 'submitted' && r.clubId === clubId);
    return { captainName: '', match: null, reason: anySubmitted ? 'blank-captain' : 'no-history' };
  }
  const captainName = fromReport.captainName.trim();
  const playedBefore = deps.scorecards
    ? playedBeforeIn(captainName, deps.scorecards, opts.clubNames ?? [fromReport.clubName])
    : undefined;
  const base = { captainName, fromReport, playedBefore };

  const roster = deps.roster ?? (deps.listPlayers ? await deps.listPlayers(tenant, clubId) : []);
  const { players, initialOnly } = nameMatches(captainName, roster);
  const flag = initialOnly ? { initialOnly } : {};
  // Ambiguity is judged before any eligibility filter: a namesake (father/son) must never
  // collapse into a confident match on the one adult/active/contactable row.
  if (players.length === 0) return { ...base, match: null, reason: 'not-on-roster' };
  if (players.length > 1) return { ...base, ...flag, match: null, reason: 'ambiguous-roster' };
  const p = players[0];
  if (p.isMinor) return { ...base, ...flag, match: null, reason: 'minor' };
  if ((p.status ?? 'active') !== 'active')
    return { ...base, ...flag, match: null, reason: 'inactive' };
  if (!hasContact(p)) return { ...base, ...flag, match: null, reason: 'no-contact' };
  return {
    ...base,
    ...flag,
    match: {
      name: `${p.firstName} ${p.lastName}`.trim(),
      playerKey: p.naturalKey,
      ...(p.email ? { email: p.email } : {}),
      ...(p.cell ? { cell: p.cell } : {}),
    },
  };
}

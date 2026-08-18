/**
 * Pure state/logic for the operator structure-intake wizard (upload → sections → teams
 * → plan → commit): turning a parsed workbook's bare sections
 * (`StructureIntakeParseResponse.sections` — sheet/header/rows, no league mapping, no
 * club resolution; both are operator UI choices per ADR 0009/0010) into a
 * `StructureIntakeCommitRequest`.
 *
 * No React, no network — `platform-structure-intake.tsx` owns all of that and drives
 * this module's functions off local state, the same split `intake-match.ts` keeps for
 * the doc-intake wizard. Club resolution reuses `matchClub` from intake-match.ts
 * directly (the plan's explicit instruction) rather than re-implementing tiered
 * confidence matching here.
 */
import { matchClub, type ClubIndex } from './intake-match';
import { slugifyLeagueKey } from './leagues';
import type {
  InsightsClub,
  League,
  StructureClubPlan,
  StructureIntakeCommitClub,
  StructureIntakeCommitRequest,
  StructureSection,
} from './types';

/* ─── Sections step ─── */

/** One section's operator decision: which tenant/draft league key it maps to (or
 *  `null` while unresolved), whether it's been explicitly Ignored, and whether a
 *  `suggestLeague` prefill has been CONFIRMED yet — the "Check" pill stays up until
 *  the operator has actually looked at (or picked, even re-picked) the assignment. */
export interface SectionAssignment {
  leagueKey: string | null;
  ignored: boolean;
  confirmed: boolean;
}

/** Lowercase, strip punctuation, collapse whitespace — the shared normalisation both
 *  `suggestLeague` and `divisionWarning` compare on. Deliberately simpler than
 *  intake-match's `normalise` (no club-specific stopwords: league headers/labels are a
 *  different vocabulary). */
function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * PREFILL ONLY — the wizard shows a gold "Check" pill on any section whose assignment
 * came from here until the operator confirms it (see `SectionAssignment.confirmed`).
 * Matches a section header against every tenant league's label and key (key with
 * dashes turned back into spaces), preferring an exact normalised match, then the
 * longest containment either direction — so "PREMIER LEAGUE DIVISION A" resolves to a
 * league labelled "Premier League" even though the header carries extra "DIVISION A"
 * wording the league model doesn't track (division placement happens at season setup,
 * not here). Returns `null` when nothing clears the bar; the operator picks by hand.
 */
export function suggestLeague(header: string, leagues: League[]): string | null {
  const norm = normalizeLabel(header);
  if (!norm) return null;
  let best: { key: string; score: number } | null = null;
  for (const l of leagues) {
    for (const cand of [normalizeLabel(l.label), normalizeLabel(l.key.replace(/-/g, ' '))]) {
      if (!cand) continue;
      if (cand === norm) {
        best = { key: l.key, score: 1000 };
        continue;
      }
      if (norm.includes(cand) || cand.includes(norm)) {
        const score = Math.min(cand.length, norm.length);
        if (!best || score > best.score) best = { key: l.key, score };
      }
    }
  }
  return best?.key ?? null;
}

/** Initial per-section assignment state right after parse — each section pre-scored by
 *  `suggestLeague` against the tenant's CURRENT leagues (drafts don't exist yet at this
 *  point) and left unconfirmed. */
export function initialSectionAssignments(
  sections: StructureSection[],
  leagues: League[],
): SectionAssignment[] {
  return sections.map((s) => ({
    leagueKey: suggestLeague(s.header, leagues),
    ignored: false,
    confirmed: false,
  }));
}

/** True once every non-ignored section has a league assigned — the gate for
 *  Continue on the sections step. */
export function sectionsReady(assignments: SectionAssignment[]): boolean {
  return assignments.every((a) => a.ignored || !!a.leagueKey);
}

/* ─── Draft leagues ("Create league…") ─── */

/** A client-side-only league until commit, when confirmed drafts are sent as
 *  `newLeagues` and appended fail-fast before any club write (1.2). Reuses the League
 *  shape verbatim so the sections picker and commit payload need no translation. */
export function makeDraftLeague(label: string, group: string, district: string): League {
  return { key: slugifyLeagueKey(label), label: label.trim(), group: group.trim(), district };
}

/** True if a league with this key already exists among the tenant's leagues or the
 *  drafts created so far this session — the append is effectively permanent on a live
 *  config, so catching an obvious duplicate before commit is worth the extra check. */
export function draftKeyCollides(key: string, leagues: League[]): boolean {
  return leagues.some((l) => l.key === key);
}

/**
 * "Create league…" warns when the draft name looks like a DIVISION of an existing
 * league rather than a genuinely new one — e.g. "Premier League Division A" against an
 * existing "Premier League". Strips a trailing "Division <token>" phrase or a lone
 * trailing letter (the common division-naming shapes) and checks whether what's left
 * matches an existing league's label/key; returns that league so the caller can quote
 * it in the warning copy, or `null` when the draft name carries no such wording (a
 * plain duplicate name is a separate, key-collision concern — `draftKeyCollides`).
 */
export function divisionWarning(draftLabel: string, leagues: League[]): League | null {
  const full = normalizeLabel(draftLabel);
  const stripped = normalizeLabel(
    draftLabel
      .replace(/\bdivision\s*[a-z0-9]+\b/i, '')
      .replace(/\s+[a-z]$/i, '')
      .trim(),
  );
  if (!stripped || stripped === full) return null;
  for (const l of leagues) {
    if (
      normalizeLabel(l.label) === stripped ||
      normalizeLabel(l.key.replace(/-/g, ' ')) === stripped
    ) {
      return l;
    }
  }
  return null;
}

/* ─── Teams step ─── */

/** One team row, flattened out of every non-ignored, league-assigned section. */
export interface TeamRow {
  /** `${sectionIndex}:${rowIndex}` — stable within one parse result. */
  id: string;
  sectionIndex: number;
  raw: string;
  venue?: string;
  clubId: string | null;
  /** 1 = exact, descending — see `matchClub`; 0 when unmatched. */
  clubConfidence: number;
  excluded: boolean;
}

/**
 * Strip a trailing team number ("TUKS 1"), qualifier ("PHSOB VETERANS 1" / "…
 * RESERVES"), single-letter side ("ADELAAR B"), or stray "CC" suffix down to the raw
 * club token `matchClub` can work with. A generic cousin of the Titans CLI's
 * `normalizeTeamToken` (titans-import-map.ts) — no CLUB_MAP lookup here, this only
 * prepares the string for the fuzzy matcher.
 */
export function stripTeamSuffix(raw: string): string {
  let s = raw.trim().replace(/\s+/g, ' ');
  s = s.replace(/\s+\d+$/, '');
  s = s.replace(/\s+(veterans|reserves)$/i, '');
  s = s.replace(/\s+\d+$/, '');
  s = s.replace(/\s+[a-zA-Z]$/, '');
  s = s.replace(/\s+CC$/i, '');
  return s.trim();
}

/** Resolve one team row's raw label to a club via the shared tiered matcher. */
export function resolveTeamClub(
  raw: string,
  index: ClubIndex,
): { club: { id: string; name: string } | null; confidence: number } {
  return matchClub(stripTeamSuffix(raw), index);
}

/** Flatten every row from sections that are neither ignored nor left unassigned, each
 *  auto-resolved to a club. Rows from an ignored/unassigned section never reach the
 *  teams step at all — the sections step is the gate, not a per-row filter here. */
export function buildTeamRows(
  sections: StructureSection[],
  assignments: SectionAssignment[],
  clubIndex: ClubIndex,
): TeamRow[] {
  const rows: TeamRow[] = [];
  sections.forEach((section, si) => {
    const a = assignments[si];
    if (!a || a.ignored || !a.leagueKey) return;
    section.rows.forEach((r, ri) => {
      const match = resolveTeamClub(r.raw, clubIndex);
      rows.push({
        id: `${si}:${ri}`,
        sectionIndex: si,
        raw: r.raw,
        venue: r.venue,
        clubId: match.club?.id ?? null,
        clubConfidence: match.confidence,
        excluded: false,
      });
    });
  });
  return rows;
}

/** Re-apply an operator's manual club pick / row exclusion on top of the auto-resolved
 *  rows — mirrors platform-intake.tsx's `edits`/`overrideIncluded` split. A manual pick
 *  is definitive (confidence 1, or 0 for an explicit "no club"), never a guess. */
export function applyRowEdits(
  rows: TeamRow[],
  clubEdits: Record<string, string | null>,
  excludedIds: ReadonlySet<string>,
): TeamRow[] {
  return rows.map((r) => {
    const edited = clubEdits[r.id];
    const clubId = edited !== undefined ? edited : r.clubId;
    const clubConfidence = edited !== undefined ? (edited ? 1 : 0) : r.clubConfidence;
    return { ...r, clubId, clubConfidence, excluded: excludedIds.has(r.id) };
  });
}

/** A row worth flagging in the "needs attention" filter: excluded, unmatched, or a
 *  sub-1.0 confidence match still worth a second look even though it's usable as-is. */
export function teamRowNeedsAttention(row: TeamRow): boolean {
  return row.excluded || !row.clubId || row.clubConfidence < 1;
}

/* ─── Plan step ─── */

/** True when a club already carries ANY team-plan data — the plan step's coral
 *  "Replaces this club's existing team plan" trigger and the excluded-by-default rule
 *  it drives. */
export function clubHasExistingPlan(club: Pick<InsightsClub, 'leagues' | 'leagueTeams'>): boolean {
  return (club.leagues?.length ?? 0) > 0 || Object.keys(club.leagueTeams ?? {}).length > 0;
}

/**
 * Aggregate resolved, non-excluded team rows into one `StructureClubPlan` per club —
 * counts, named sides per league, and a `firstTeamVenue` guess. Mirrors
 * `summarizeByClub` (titans-import-map.ts): a side's venue counts toward
 * `firstTeamVenue` if its raw label carries no trailing number or ends "…1" (the
 * club's presumptive first team); any club that never fields such a side falls back to
 * its very first row's venue in a second pass, exactly like the CLI's fallback.
 */
export function buildClubPlans(
  rows: TeamRow[],
  assignments: SectionAssignment[],
): Record<string, StructureClubPlan> {
  const plans: Record<string, StructureClubPlan> = {};
  const plan = (clubId: string): StructureClubPlan =>
    (plans[clubId] ??= { leagues: [], leagueTeams: {}, teamRosters: {} });

  for (const row of rows) {
    if (row.excluded || !row.clubId) continue;
    const leagueKey = assignments[row.sectionIndex]?.leagueKey;
    if (!leagueKey) continue;
    const p = plan(row.clubId);
    if (!p.leagues.includes(leagueKey)) p.leagues.push(leagueKey);
    p.leagueTeams[leagueKey] = (p.leagueTeams[leagueKey] ?? 0) + 1;
    const name = row.raw.trim().replace(/\s+/g, ' ');
    const venue = row.venue?.trim() || undefined;
    (p.teamRosters[leagueKey] ??= []).push(venue ? { name, venue } : { name });
    const suffix = row.raw.trim().match(/(\d+)$/);
    const isFirstSide = !suffix || suffix[1] === '1';
    if (isFirstSide && !p.firstTeamVenue && venue) p.firstTeamVenue = venue;
  }
  // Fallback pass: a club with rows but no firstTeamVenue yet (never fielded a
  // "…1"/unnumbered side) takes its very first row's venue instead of staying unset.
  for (const row of rows) {
    if (row.excluded || !row.clubId) continue;
    const p = plans[row.clubId];
    if (p && !p.firstTeamVenue && row.venue?.trim()) p.firstTeamVenue = row.venue.trim();
  }
  return plans;
}

/**
 * Assemble the commit body: `newLeagues` carries confirmed draft leagues (omitted
 * entirely when there are none — matches the server's `newLeagues?` optionality),
 * `overwriteByClub` sets `overwrite: true` only for clubs the operator explicitly
 * opted into replacing via "Include anyway" on the plan step.
 */
export function buildCommitPayload(
  clubPlans: Record<string, StructureClubPlan>,
  overwriteByClub: Record<string, boolean>,
  draftLeagues: League[],
): StructureIntakeCommitRequest {
  const clubs: StructureIntakeCommitClub[] = Object.entries(clubPlans).map(([clubId, p]) => ({
    clubId,
    ...(overwriteByClub[clubId] ? { overwrite: true as const } : {}),
    plan: p,
  }));
  return draftLeagues.length ? { newLeagues: draftLeagues, clubs } : { clubs };
}

/**
 * Pure MedicoachBundle builder. No DynamoDB, no env, no clock unless you omit
 * `generatedAt`. `export-medicoach.ts` is the IO shell around it, and the tests call it
 * directly with checked-in data.
 *
 * Deliberately imports nothing that reaches repo.ts: repo resolves the table name at
 * import time, which would make this module unloadable in a unit test.
 *
 * Mapping summary (the plan's Phase 1/2 + the 2026-09-30 amendment):
 *   - Leagues: catalogue entries minus `seed-*` / `demo` (and minus anything outside
 *     `--leagues`), plus leagueKeys that only appear on series (synthesised from recipes).
 *   - Competitions: one per format stream. Plan-B series are grouped by (leagueKey, stream)
 *     where the stream comes from the series name "League · Stream · Group" (`series` when
 *     the name has no stream). Season-run series form one competition per run: the newest
 *     run is stream `main`, older runs `main-<runId>`. A run's format comes from its own
 *     structure snapshot (else the league's setup structure); Plan-B streams use the
 *     tenant recipe, else inference from the fixtures.
 *   - Teams: `clubTeamsForLeague` for clubs registered in the league, plus any series
 *     participant not already covered. Team refs always include the leagueKey.
 *   - Fixtures: cancelled → skipped and counted; postponed → scheduled with a note;
 *     everything else scheduled with `sourceStatus` preserved. A `win:`/`lose:` side
 *     becomes a slot; a concrete side stays a teamRef.
 *   - People: exco + coaches deduped per person (email, else name+cell), players active
 *     only by default, deduped by naturalKey, with veterans second-club team refs.
 *   - Player placement (2026-10-02): the registered league's single side as before. A player
 *     left with NO team after that and the veterans pass is placed by fallback: every side
 *     of their club in that league when it has several, else the club's league-less squad
 *     team (`clubSquad`, one per club that needs it). Players who already had a team are
 *     never touched, so every pre-existing ref and teamRefs list stays byte-identical.
 */
import { createHash } from 'node:crypto';
import { clubTeamsForLeague, isVeteransLeague } from '../../engine/src/leagues.js';
import { isSlotRef, slotSource } from '../../engine/src/formats.js';
import {
  BUNDLE_SCHEMA,
  BUNDLE_VERSION,
  computeCounts,
  refs,
  type BundleCompetition,
  type BundleExtraPhase,
  type BundleFixture,
  type BundleFormat,
  type BundleGroup,
  type BundleInstitution,
  type BundleLeague,
  type BundlePlayer,
  type BundleSeason,
  type BundleSlot,
  type BundleStaff,
  type BundleSwap,
  type BundleTeam,
  type CricketMatchFormat,
  type MedicoachBundle,
  isRecipeKnockoutSeries,
} from './medicoach-bundle.js';
import type { CompetitionRecipe, RecipeSlot, TenantRecipes } from './medicoach-recipes/types.js';
import type {
  Club,
  CompetitionStructure,
  League,
  PlayerRegistration,
  SeasonCalendar,
  SeasonRun,
  Series,
  StageSpec,
  TenantConfig,
  VeteransAffiliation,
} from './types.js';
import { resolveVertical } from './vertical.js';

/* ─────────────────────────── Inputs / outputs ─────────────────────────── */

export interface BuildInputs {
  tenant: string;
  config: TenantConfig;
  clubs: Club[];
  playersByClub: Map<string, PlayerRegistration[]>;
  /** VETAFFIL# records per veterans club, for the coverage report. Optional. */
  veteransAffiliationsByClub?: Map<string, VeteransAffiliation[]>;
  series: Series[];
  seasonRuns: SeasonRun[];
  recipes: TenantRecipes;
  options?: {
    /** Only these league keys (seed-* and demo stay excluded). */
    leagues?: string[];
    includeInactivePlayers?: boolean;
    generatedAt?: string;
  };
}

export interface ExportSummary {
  leagues: {
    exported: string[];
    excluded: string[];
    synthesised: string[];
    withoutCompetitions: string[];
    /** Leagues with 2+ season runs: the newest exports as stream `main`, older ones as `main-<runId>`. */
    multiRun: string[];
  };
  competitions: Array<{
    league: string;
    stream: string;
    formatSource: BundleCompetition['formatSource'];
    type: BundleFormat['type'];
    groups: number;
    fixtures: number;
    placeholders: number;
  }>;
  fixtures: {
    read: number;
    exported: number;
    placeholders: number;
    cancelledSkipped: number;
    /** Postponed fixtures present in the final bundle (after orphan and league drops). */
    postponed: number;
    /** Fixtures marked completed in smart club, present in the final bundle. */
    completedInSource: number;
    undatedSkipped: number;
    missingIdSkipped: number;
    unresolvedSideSkipped: number;
    orphanSlotSkipped: number;
    seriesUnmatched: string[];
  };
  players: {
    rowsRead: number;
    exported: number;
    excludedByStatus: Record<string, number>;
    placeholdersSkipped: number;
    duplicateRowsMerged: number;
    withTeam: number;
    /** Main-club lookups (and veterans lookups) that found 2+ sides. Unchanged meaning. */
    ambiguousSide: number;
    /** After placement; 0 by construction (every player can fall back to a club squad). */
    noTeam: number;
    /** How each exported player got their team(s). Sums to `exported`. */
    placement: {
      /** The registered league's single side (with any veterans side). */
      singleSide: number;
      /** No main-club side, but a veterans second-club side. */
      veteransOnly: number;
      /** Fallback: the club has several sides in the player's league → all of them. */
      allSidesOfAmbiguous: number;
      /** Fallback: no usable league → the club's squad team. */
      clubSquad: number;
    };
    /** Why each club-squad player had no usable league. Sums to placement.clubSquad. */
    clubSquadReasons: {
      /** No registered league and the club has no single affiliation league to infer. */
      noRegisteredLeague: number;
      /** No registered league and the club is in 2+ affiliation leagues. */
      multipleCandidateLeagues: number;
      /** The registered league is not in the bundle (excluded, filtered, or unknown). */
      leagueNotExported: number;
      /** The league is in the bundle but the club has no side in it. */
      noSideInLeague: number;
    };
    /** Club squad teams created (one per club that needed one). */
    squadTeams: number;
  };
  veterans: {
    playersWithVeteransClub: number;
    resolvedVeteransTeam: number;
    affiliationsListed: number;
    affiliationsMatched: number;
    affiliationsUnmatched: number;
  };
  staff: {
    entriesRead: number;
    persons: number;
    assignments: number;
    skippedNoIdentity: number;
    sharedEmailDifferentNames: number;
  };
  institutions: { exported: number; synthesised: number; demoSkipped: number };
  /** PII-free: ids, keys and counts only. */
  warnings: string[];
  confirmations: string[];
}

export interface BuildResult {
  bundle: MedicoachBundle;
  summary: ExportSummary;
}

/* ─────────────────────────── Small helpers ─────────────────────────── */

type Dict = Record<string, unknown>;

function asDict(v: unknown): Dict {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {};
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function optStr(v: unknown): string | undefined {
  const s = str(v);
  return s ? s : undefined;
}

function optNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function slugify(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isExcludedLeagueKey(key: string): boolean {
  return key === 'demo' || key.startsWith('seed-');
}

/* ─────────────────────────── PII masking ───────────────────────────
   Everything the CLI prints goes through these (or is a count/id). */

export function maskName(name: unknown): string {
  const parts = str(name).split(/\s+/).filter(Boolean);
  if (!parts.length) return '∅';
  return parts.map((p) => `${p[0]}${'*'.repeat(Math.max(2, p.length - 1))}`).join(' ');
}

export function maskEmail(email: unknown): string {
  const e = str(email);
  const at = e.indexOf('@');
  if (at < 1) return e ? '***' : '∅';
  const domain = e.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot >= 0 ? domain.slice(dot) : '';
  return `${e[0]}***@${domain[0] ?? ''}***${tld}`;
}

export function maskCell(cell: unknown): string {
  const d = str(cell).replace(/\D/g, '');
  return d ? `***${d.slice(-3)}` : '∅';
}

/* ─────────────────────────── People identity ─────────────────────────── */

export function normaliseEmail(v: unknown): string | undefined {
  const e = str(v).toLowerCase();
  return e.includes('@') ? e : undefined;
}

export function normaliseCell(v: unknown): string | undefined {
  let d = str(v).replace(/\D/g, '');
  if (d.startsWith('27') && d.length === 11) d = `0${d.slice(2)}`;
  return d.length >= 9 ? d : undefined;
}

function normaliseName(v: unknown): string | undefined {
  const n = str(v).toLowerCase().replace(/\s+/g, ' ');
  return n || undefined;
}

/**
 * The dedupe identity for a staff entry: normalised email, else name + cell. With
 * neither, name + clubId, so two same-named contact-less people at different clubs never
 * merge. Null when there is nothing to key on.
 */
export function staffIdentity(
  entry: { name?: unknown; email?: unknown; cell?: unknown },
  clubId: string,
): string | null {
  const email = normaliseEmail(entry.email);
  if (email) return `email:${email}`;
  const name = normaliseName(entry.name);
  const cell = normaliseCell(entry.cell);
  if (name && cell) return `namecell:${name}|${cell}`;
  if (name) return `nameclub:${name}|${clubId}`;
  return null;
}

export function hashIdentity(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 24);
}

/* ─────────────────────────── Series naming ─────────────────────────── */

/** "Premier League · T20 · Group 1" → stream "T20", group "Group 1". */
export function parseSeriesName(name: string): {
  streamLabel: string | null;
  groupLabel: string | null;
} {
  const parts = String(name || '')
    .split('·')
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    streamLabel: parts.length >= 2 ? parts[1] : null,
    groupLabel: parts.length >= 3 ? parts.slice(2).join(' · ') : null,
  };
}

/** Top before Bottom, then natural order ("Group 2" < "Group 10"). */
export function compareGroupLabels(a: string, b: string): number {
  const rank = (s: string) => (/^top\b/i.test(s) ? 0 : /^bottom\b/i.test(s) ? 2 : 1);
  return rank(a) - rank(b) || a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

export function groupName(index1: number): string {
  return `Group ${index1}`;
}

/* ─────────────────────────── Overs / match format ─────────────────────────── */

export function cricketFormatForOvers(overs: number | undefined): CricketMatchFormat | undefined {
  switch (overs) {
    case 10:
      return 'T10';
    case 20:
      return 'T20';
    case 30:
      return 'T30';
    case 40:
      return 'T40';
    case 50:
      return 'ODI';
    default:
      return undefined;
  }
}

function oversFromStreamLabel(label: string | null): number | undefined {
  if (!label) return undefined;
  const t = /\bT(10|20)\b/i.exec(label);
  if (t) return Number(t[1]);
  const o = /\b(\d{2,3})\s*ov/i.exec(label);
  return o ? Number(o[1]) : undefined;
}

/* ─────────────────────────── Structure → format ─────────────────────────── */

export interface StructureMapping {
  format: BundleFormat;
  /** Swaps with positionA possibly 'last' (resolved by the caller once group sizes are known). */
  swaps: Array<{
    groupA: number;
    positionA: number | 'last';
    groupB: number;
    positionB: number;
    carryPoints: boolean;
  }>;
  /** StageSpec.id → the medicoach phase its fixtures belong to (1 = main phase). */
  phaseOfStage: Record<string, number>;
  warnings: string[];
}

function groupCountOf(stage: StageSpec): number {
  const e = stage.entrants;
  if (e.kind === 'all-registered') return 1;
  const plan = e.groups;
  if (!plan) return 1;
  return plan.kind === 'even' ? Math.max(1, plan.count) : Math.max(1, plan.sizes.length);
}

function roundsOfLegs(legs: number, warnings: string[], stageName: string): 1 | 2 {
  if (legs === 1) return 1;
  if (legs === 2) return 2;
  warnings.push(
    `stage "${stageName}": ${legs} legs has no medicoach equivalent; exported as rounds 2`,
  );
  return 2;
}

/**
 * Map a smart-club stage pipeline to a medicoach format by its SHAPE, never its name:
 *   one round robin                          → league
 *   round robin → knockout                   → groups_knockout (advance = qualifiersPerGroup)
 *   round robin → round robin (swap)         → league + extra phase `carry` + a swap
 *   round robin → round robin (more groups,
 *     or from-standings)                     → league + extra phase `subdivide`
 *   knockout alone                           → knockout
 */
export function mapStructureToFormat(structure: CompetitionStructure): StructureMapping {
  const warnings: string[] = [];
  const stages = structure.stages ?? [];
  const phaseOfStage: Record<string, number> = {};
  const swaps: StructureMapping['swaps'] = [];
  if (!stages.length) {
    warnings.push(`structure ${structure.id} has no stages; exported as a flat league`);
    return {
      format: { type: 'league', rounds: 1, extraPhases: [] },
      swaps,
      phaseOfStage,
      warnings,
    };
  }

  const first = stages[0];
  let format: BundleFormat;
  if (first.format.kind === 'round-robin') {
    format = {
      type: 'league',
      rounds: roundsOfLegs(first.format.legs, warnings, first.name),
      extraPhases: [],
    };
  } else if (first.format.kind === 'knockout') {
    format = {
      type: 'knockout',
      rounds: 1,
      extraPhases: [],
      ...(first.format.thirdPlace ? { thirdPlace: true } : {}),
    };
  } else {
    warnings.push(
      `stage "${first.name}": format ${first.format.kind} has no medicoach equivalent; exported as a league`,
    );
    format = { type: 'league', rounds: 1, extraPhases: [] };
  }
  phaseOfStage[first.id] = 1;

  let prevGroups = groupCountOf(first);
  for (let i = 1; i < stages.length; i++) {
    const stage = stages[i];
    const derived = stage.entrants.kind === 'manual' ? stage.entrants.derivedFrom : undefined;

    if (stage.format.kind === 'knockout') {
      if (format.type === 'league' && format.extraPhases.length === 0) {
        // Groups then a knockout: medicoach's groups_knockout.
        const q = derived?.qualifiersPerGroup;
        if (!q)
          warnings.push(
            `stage "${stage.name}": no qualifiersPerGroup recorded; assumed top 2 per group advance`,
          );
        format = {
          ...format,
          type: 'groups_knockout',
          advancePerGroup: q ?? 2,
          ...(stage.format.thirdPlace ? { thirdPlace: true } : {}),
        };
        phaseOfStage[stage.id] = 1;
      } else {
        const phase: BundleExtraPhase = {
          type: 'knockout',
          ...(stage.format.thirdPlace ? { thirdPlace: true } : {}),
        };
        format.extraPhases.push(phase);
        phaseOfStage[stage.id] = 1 + format.extraPhases.length;
      }
      prevGroups = 1;
      continue;
    }

    if (stage.format.kind !== 'round-robin') {
      warnings.push(
        `stage "${stage.name}": format ${stage.format.kind} has no medicoach equivalent; skipped`,
      );
      continue;
    }

    const rounds = roundsOfLegs(stage.format.legs, warnings, stage.name);
    const groups = groupCountOf(stage);
    const rule = derived?.rule;
    let phase: BundleExtraPhase;
    if (rule === 'swap') {
      phase = { type: 'league', rounds, groupSeeding: 'carry' };
      if (prevGroups < 2)
        warnings.push(
          `stage "${stage.name}": a swap needs two groups, the previous stage has ${prevGroups}`,
        );
      else
        swaps.push({
          groupA: 1,
          positionA: 'last',
          groupB: 2,
          positionB: 1,
          carryPoints: derived?.carryPoints === true,
        });
    } else if (groups > prevGroups && groups % prevGroups === 0) {
      phase = { type: 'league', rounds, groupSeeding: 'subdivide', subGroups: groups / prevGroups };
    } else if (rule === 'from-standings' && groups === prevGroups && groups === 1) {
      warnings.push(`stage "${stage.name}": from-standings into one group; exported as carry`);
      phase = { type: 'league', rounds, groupSeeding: 'carry' };
    } else {
      if (rule !== 'carry-forward')
        warnings.push(
          `stage "${stage.name}": no swap/split rule (${rule ?? stage.entrants.kind}, ${prevGroups}→${groups} groups); exported as carry`,
        );
      phase = { type: 'league', rounds, groupSeeding: 'carry' };
    }
    format.extraPhases.push(phase);
    phaseOfStage[stage.id] = 1 + format.extraPhases.length;
    prevGroups = groups;
  }

  return { format, swaps, phaseOfStage, warnings };
}

/* ─────────────────────────── Fixtures ─────────────────────────── */

/** The stored fixture fields the exporter reads. */
export interface SourceFixture {
  id?: string;
  round?: number;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  status?: string | null;
  venueName?: string;
  venueOverride?: string;
  venueLat?: number;
  venueLon?: number;
}

export type FixtureOutcome =
  | { kind: 'skip'; reason: 'cancelled' | 'undated' | 'unresolved-side' | 'missing-id' }
  | { kind: 'ok'; fixture: BundleFixture; postponed: boolean; completed: boolean };

export interface FixtureContext {
  tenant: string;
  utcOffset: string;
  seriesId: string;
  /** Resolve a concrete side id (teamId, or a legacy clubId) to its team ref + ground. */
  resolveTeam: (sideId: string) => { ref: string; ground?: string } | null;
  phase: number;
  stage: string;
  groupName?: string;
  venueWithheld?: boolean;
  timeWithheld?: boolean;
}

export function scheduledInstant(date: string, time: string | undefined, offset: string) {
  const hhmm = time && /^\d{2}:\d{2}$/.test(time) ? time : undefined;
  return { scheduledTime: `${date}T${hhmm ?? '00:00'}:00${offset}`, timeTbc: !hhmm };
}

/**
 * Map one stored fixture. Status: cancelled → skip; postponed → scheduled with a note
 * (its stored date is already the rescheduled one); anything else → scheduled with the
 * source status kept for the results backfill. A `win:`/`lose:` side is a slot; a `pos:`/`tbd:`
 * side skips the fixture (`unresolved-side`); a concrete
 * side is a teamRef (smart club materialises a knockout side by replacing the slot).
 */
export function mapFixture(f: SourceFixture, ctx: FixtureContext): FixtureOutcome {
  const status = f.status ?? null;
  // A fixture without an id can't get a stable ref; guessing one would duplicate on re-import.
  if (f.id == null || String(f.id).trim() === '') return { kind: 'skip', reason: 'missing-id' };
  if (status === 'cancelled') return { kind: 'skip', reason: 'cancelled' };
  if (!f.date || !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return { kind: 'skip', reason: 'undated' };

  const side = (
    id: string | undefined,
  ): { ref?: string; slot?: BundleSlot; ground?: string } | null => {
    if (!id) return null;
    const src = slotSource(id);
    if (src)
      return {
        slot: {
          kind: src.kind,
          ofFixtureRef: refs.fixture(ctx.tenant, ctx.seriesId, src.fixtureId),
        },
      };
    // A `pos:`/`tbd:` placeholder names neither a team nor a fixture to wait on: the fixture is
    // skipped as unresolved until the admin sets the team (ADR 0018).
    if (isSlotRef(id)) return null;
    const team = ctx.resolveTeam(id);
    return team ? { ref: team.ref, ground: team.ground } : null;
  };
  const home = side(f.home);
  const away = side(f.away);
  if (!home || !away) return { kind: 'skip', reason: 'unresolved-side' };

  const notes: string[] = [];
  const postponed = status === 'postponed';
  const completed = status === 'completed';
  if (postponed) notes.push('Postponed in smart club; the date is its rescheduled date.');
  if (completed)
    notes.push('Marked completed in smart club; needs a result from the backfill file.');

  const venue = optStr(f.venueOverride) ?? optStr(f.venueName) ?? home.ground;
  const when = scheduledInstant(f.date, f.time, ctx.utcOffset);
  const fixture: BundleFixture = {
    externalRef: refs.fixture(ctx.tenant, ctx.seriesId, String(f.id)),
    round: Number.isInteger(f.round) && (f.round as number) >= 1 ? (f.round as number) : 1,
    phase: ctx.phase,
    stage: ctx.stage,
    ...(ctx.groupName ? { groupName: ctx.groupName } : {}),
    scheduledTime: when.scheduledTime,
    ...(when.timeTbc ? { timeTbc: true } : {}),
    ...(venue ? { venue } : {}),
    ...(optNum(f.venueLat) !== undefined ? { venueLat: f.venueLat } : {}),
    ...(optNum(f.venueLon) !== undefined ? { venueLon: f.venueLon } : {}),
    ...(ctx.venueWithheld ? { venueWithheld: true } : {}),
    ...(ctx.timeWithheld ? { timeWithheld: true } : {}),
    sourceStatus: status,
    status: 'scheduled',
    ...(notes.length ? { notes } : {}),
    ...(home.ref ? { homeTeamRef: home.ref } : { homeSlot: home.slot }),
    ...(away.ref ? { awayTeamRef: away.ref } : { awaySlot: away.slot }),
  };
  return { kind: 'ok', fixture, postponed, completed };
}

/** How many times the most-met pair meets: the inferred round-robin multiplier (1 or 2). */
export function inferRounds(fixtures: Array<Pick<SourceFixture, 'home' | 'away'>>): {
  rounds: 1 | 2;
  maxMeetings: number;
} {
  const meetings = new Map<string, number>();
  for (const f of fixtures) {
    if (!f.home || !f.away) continue;
    const k = [f.home, f.away].sort().join('|');
    meetings.set(k, (meetings.get(k) ?? 0) + 1);
  }
  const maxMeetings = Math.max(0, ...meetings.values());
  return { rounds: maxMeetings >= 2 ? 2 : 1, maxMeetings };
}

/* ─────────────────────────── Build ─────────────────────────── */

interface StreamSeries {
  series: Series;
  groupLabel: string | null;
}

interface LeagueWork {
  key: string;
  catalogue?: League;
  synthesised: boolean;
  teams: Map<string, BundleTeam>; // by sourceTeamId
  /** stream key → label + series (Plan-B). */
  streams: Map<string, { label: string | null; items: StreamSeries[] }>;
  /** Season-run series grouped by run. */
  runs: Map<string, { run: SeasonRun; series: Series[] }>;
}

const EXCO_ADDITIONAL = 'additional';

export function buildBundle(input: BuildInputs): BuildResult {
  const { tenant, config, recipes } = input;
  const opts = input.options ?? {};
  const offset = recipes.utcOffset || '+02:00';
  const warnings: string[] = [];
  const confirmations: string[] = [];

  const summary: ExportSummary = {
    leagues: { exported: [], excluded: [], synthesised: [], withoutCompetitions: [], multiRun: [] },
    competitions: [],
    fixtures: {
      read: 0,
      exported: 0,
      placeholders: 0,
      cancelledSkipped: 0,
      postponed: 0,
      completedInSource: 0,
      undatedSkipped: 0,
      missingIdSkipped: 0,
      unresolvedSideSkipped: 0,
      orphanSlotSkipped: 0,
      seriesUnmatched: [],
    },
    players: {
      rowsRead: 0,
      exported: 0,
      excludedByStatus: {},
      placeholdersSkipped: 0,
      duplicateRowsMerged: 0,
      withTeam: 0,
      ambiguousSide: 0,
      noTeam: 0,
      placement: { singleSide: 0, veteransOnly: 0, allSidesOfAmbiguous: 0, clubSquad: 0 },
      clubSquadReasons: {
        noRegisteredLeague: 0,
        multipleCandidateLeagues: 0,
        leagueNotExported: 0,
        noSideInLeague: 0,
      },
      squadTeams: 0,
    },
    veterans: {
      playersWithVeteransClub: 0,
      resolvedVeteransTeam: 0,
      affiliationsListed: 0,
      affiliationsMatched: 0,
      affiliationsUnmatched: 0,
    },
    staff: {
      entriesRead: 0,
      persons: 0,
      assignments: 0,
      skippedNoIdentity: 0,
      sharedEmailDifferentNames: 0,
    },
    institutions: { exported: 0, synthesised: 0, demoSkipped: 0 },
    warnings,
    confirmations,
  };

  /* ── Institutions ── */
  const clubsById = new Map<string, Club>();
  const institutions = new Map<string, BundleInstitution>();
  for (const club of input.clubs) {
    if (club.demo) {
      summary.institutions.demoSkipped++;
      continue;
    }
    clubsById.set(club.id, club);
    const g = asDict(club.ground);
    const ground = {
      ...(optStr(g.venue) ? { venue: optStr(g.venue) } : {}),
      ...(optStr(g.address) ? { address: optStr(g.address) } : {}),
      ...(optStr(g.suburb) ? { suburb: optStr(g.suburb) } : {}),
      ...(optNum(g.lat) !== undefined ? { lat: g.lat as number } : {}),
      ...(optNum(g.lon) !== undefined ? { lon: g.lon as number } : {}),
    };
    institutions.set(club.id, {
      externalRef: refs.institution(tenant, club.id),
      sourceId: club.id,
      name: str(club.name) || club.id,
      ...(optStr(club.district) ? { district: optStr(club.district) } : {}),
      ...(recipes.province ? { province: recipes.province } : {}),
      ...(Object.keys(ground).length ? { ground } : {}),
      slugHint: slugify(str(club.name) || club.id) || club.id,
    });
  }
  const ensureInstitution = (clubId: string, nameHint: string): BundleInstitution => {
    let inst = institutions.get(clubId);
    if (!inst) {
      inst = {
        externalRef: refs.institution(tenant, clubId),
        sourceId: clubId,
        name: nameHint || clubId,
        ...(recipes.province ? { province: recipes.province } : {}),
        slugHint: slugify(nameHint || clubId) || clubId,
        synthesised: true,
      };
      institutions.set(clubId, inst);
      summary.institutions.synthesised++;
      warnings.push(
        `club ${clubId} is referenced by a series but missing from the club list; institution synthesised`,
      );
    }
    return inst;
  };

  /* ── Leagues in scope ── */
  const filter = opts.leagues?.length ? new Set(opts.leagues) : null;
  const inScope = (key: string) => !isExcludedLeagueKey(key) && (!filter || filter.has(key));
  const excluded = new Set<string>();
  // Recipe exclusions stay out of the bundle entirely (not even meta.excludedLeagues).
  const recipeExcluded = new Set<string>();
  const works = new Map<string, LeagueWork>();
  const workFor = (key: string, catalogue?: League): LeagueWork | null => {
    const excludeReason = recipes.excludeLeagues?.[key];
    if (excludeReason !== undefined) {
      if (!recipeExcluded.has(key)) {
        recipeExcluded.add(key);
        warnings.push(`league ${key} excluded by recipe: ${excludeReason}`);
      }
      return null;
    }
    if (!inScope(key)) {
      excluded.add(key);
      return null;
    }
    let w = works.get(key);
    if (!w) {
      w = {
        key,
        catalogue,
        synthesised: !catalogue,
        teams: new Map(),
        streams: new Map(),
        runs: new Map(),
      };
      works.set(key, w);
    }
    return w;
  };
  for (const l of config.leagues ?? []) workFor(l.key, l);

  /* ── Series → leagues/streams ── */
  const runsById = new Map(input.seasonRuns.map((r) => [r.id, r]));
  for (const s of input.series) {
    // Recipe knockouts (create-recipe-knockouts.ts) already exist in medicoach — they came
    // from the recipe's laterFixtures below. Re-exporting them would add a bogus group.
    if (isRecipeKnockoutSeries(s.id)) continue;
    const fixtures = Array.isArray(s.fixtures) ? s.fixtures : [];
    const run = s.seasonRunId ? runsById.get(s.seasonRunId) : undefined;
    const leagueKey = run?.leagueKey ?? (typeof s.leagueKey === 'string' ? s.leagueKey : undefined);
    if (!leagueKey) {
      summary.fixtures.seriesUnmatched.push(s.id);
      continue;
    }
    const w = workFor(
      leagueKey,
      (config.leagues ?? []).find((l) => l.key === leagueKey),
    );
    if (!w) continue;
    summary.fixtures.read += fixtures.length;
    if (run) {
      const entry = w.runs.get(run.id) ?? { run, series: [] };
      entry.series.push(s);
      w.runs.set(run.id, entry);
    } else {
      const { streamLabel, groupLabel } = parseSeriesName(s.name);
      // `series`, not `main`: `main` belongs to the league's season-run competition.
      const stream = streamLabel ? slugify(streamLabel) || 'series' : 'series';
      const entry = w.streams.get(stream) ?? { label: streamLabel, items: [] };
      entry.items.push({ series: s, groupLabel });
      w.streams.set(stream, entry);
    }
  }
  summary.leagues.excluded = [...excluded].sort();

  /* ── Teams per league ── */
  const teamRef = (leagueKey: string, teamId: string) => refs.team(tenant, leagueKey, teamId);
  for (const w of works.values()) {
    for (const club of clubsById.values()) {
      if (!Array.isArray(club.leagues) || !club.leagues.includes(w.key)) continue;
      for (const p of clubTeamsForLeague(club, w.key)) {
        const inst = institutions.get(club.id)!;
        w.teams.set(p.teamId, {
          externalRef: teamRef(w.key, p.teamId),
          institutionRef: inst.externalRef,
          sourceTeamId: p.teamId,
          name: p.name || inst.name,
          leagueKey: w.key,
          ...(p.venue ? { venue: p.venue } : {}),
          ...(optNum(p.lat) !== undefined ? { lat: p.lat } : {}),
          ...(optNum(p.lon) !== undefined ? { lon: p.lon } : {}),
        });
      }
    }
    const allSeries = [
      ...[...w.streams.values()].flatMap((e) => e.items.map((i) => i.series)),
      ...[...w.runs.values()].flatMap((e) => e.series),
    ];
    for (const s of allSeries) {
      const participants = Array.isArray(s.participants)
        ? s.participants
        : (s.teams ?? []).map((id): NonNullable<Series['participants']>[number] => ({
            teamId: id,
            clubId: id,
            name: clubsById.get(id)?.name ?? id,
          }));
      for (const p of participants) {
        if (!p?.teamId || w.teams.has(p.teamId)) continue;
        const club = clubsById.get(p.clubId);
        const inst = ensureInstitution(
          p.clubId,
          club?.name ?? (p.teamId.startsWith('tm_') ? p.name.replace(/\s+[A-Z]$/, '') : p.name),
        );
        w.teams.set(p.teamId, {
          externalRef: teamRef(w.key, p.teamId),
          institutionRef: inst.externalRef,
          sourceTeamId: p.teamId,
          name: p.name || inst.name,
          leagueKey: w.key,
          ...(p.venue ? { venue: p.venue } : {}),
          ...(optNum(p.lat) !== undefined ? { lat: p.lat } : {}),
          ...(optNum(p.lon) !== undefined ? { lon: p.lon } : {}),
        });
      }
    }
  }

  /* ── Competitions, fixtures, seasons ── */
  const leagues: BundleLeague[] = [];
  const structuresById = new Map((config.structures ?? []).map((s) => [s.id, s]));
  const calendarsById = new Map((config.calendars ?? []).map((c) => [c.id, c]));
  const latestCalendar = [...(config.calendars ?? [])]
    .filter((c) => c.blocks?.length)
    .sort((a, b) => lastEnd(b).localeCompare(lastEnd(a)))[0];

  const groundByInstitutionRef = new Map(
    [...institutions.values()].map((i) => [i.externalRef, i.ground?.venue]),
  );
  const sortedWorks = [...works.values()].sort((a, b) => {
    const ia = (config.leagues ?? []).findIndex((l) => l.key === a.key);
    const ib = (config.leagues ?? []).findIndex((l) => l.key === b.key);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.key.localeCompare(b.key);
  });

  for (const w of sortedWorks) {
    const recipe = recipes.leagues[w.key];
    const lref = refs.league(tenant, w.key);
    const competitions: BundleCompetition[] = [];
    const swaps: BundleSwap[] = [];
    // Relegation targets resolve only if the target league is exported (checked after the loop).
    const pendingRelegations: Array<{
      competitionRef: string;
      group: string;
      position: number;
      targetLeagueKey: string;
    }> = [];
    const resolveTeam = (sideId: string) => {
      const t = w.teams.get(sideId);
      return t
        ? { ref: t.externalRef, ground: t.venue ?? groundByInstitutionRef.get(t.institutionRef) }
        : null;
    };

    let missingIds = 0;
    const collect = (outcome: FixtureOutcome, into: BundleFixture[]) => {
      if (outcome.kind === 'skip') {
        if (outcome.reason === 'cancelled') summary.fixtures.cancelledSkipped++;
        else if (outcome.reason === 'undated') summary.fixtures.undatedSkipped++;
        else if (outcome.reason === 'missing-id') {
          summary.fixtures.missingIdSkipped++;
          missingIds++;
        } else summary.fixtures.unresolvedSideSkipped++;
        return;
      }
      // postponed/completed are tallied from the final bundle, after orphan and league drops.
      into.push(outcome.fixture);
    };

    // Season-run series (the league's setup) → one `main` competition.
    const setupStructure = w.catalogue?.setup
      ? structuresById.get(w.catalogue.setup.structureId)
      : undefined;
    // Newest run first: it keeps stream `main`; older runs export as `main-<runId>` so the
    // competition refs stay unique (a league normally has one run per season).
    const runsNewestFirst = [...w.runs.values()].sort(
      (a, b) =>
        str(b.run.createdAt).localeCompare(str(a.run.createdAt)) ||
        b.run.id.localeCompare(a.run.id),
    );
    if (runsNewestFirst.length > 1) {
      summary.leagues.multiRun.push(w.key);
      warnings.push(
        `league ${w.key}: ${runsNewestFirst.length} season runs; newest (${runsNewestFirst[0].run.id}) is stream "main", older runs are "main-<runId>"`,
      );
    }
    for (const [ri, { run, series }] of runsNewestFirst.entries()) {
      // The run's own snapshot is what its series were generated from; the catalogue
      // structure may have been edited since (a new version never reshapes a running season).
      const structure = run.structureSnapshot ?? setupStructure;
      if (!structure) {
        warnings.push(`league ${w.key}: run ${run.id} has no structure; skipped`);
        continue;
      }
      const mapping = mapStructureToFormat(structure);
      for (const m of mapping.warnings) warnings.push(`league ${w.key}: ${m}`);
      const seriesById = new Map(series.map((s) => [s.id, s]));
      const stream = ri === 0 ? 'main' : `main-${slugify(run.id) || ri}`;
      const compRef = refs.competition(tenant, w.key, stream);
      const groups: BundleGroup[] = [];
      const fixtures: BundleFixture[] = [];
      const firstStage = run.stages[0];
      (firstStage?.groups ?? []).forEach((g, i) => {
        groups.push({
          name: groupName(i + 1),
          ...(g.label ? { sourceName: g.label } : {}),
          order: i,
          teamRefs: g.entrants
            .map((id) => w.teams.get(id)?.externalRef)
            .filter((r): r is string => !!r),
        });
      });
      run.stages.forEach((stageRun, si) => {
        const spec = structure.stages.find((st) => st.id === stageRun.specId);
        const phase = mapping.phaseOfStage[stageRun.specId] ?? 1;
        stageRun.groups.forEach((g, gi) => {
          const s = g.seriesId ? seriesById.get(g.seriesId) : undefined;
          if (!s) return;
          seriesById.delete(s.id);
          for (const raw of s.fixtures as SourceFixture[])
            collect(
              mapFixture(raw, {
                tenant,
                utcOffset: offset,
                seriesId: s.id,
                resolveTeam,
                phase,
                stage: spec?.name ?? stageRun.specId,
                ...(si === 0 ? { groupName: groupName(gi + 1) } : {}),
                venueWithheld: s.withheld?.venue === true,
                timeWithheld: s.withheld?.time === true,
              }),
              fixtures,
            );
        });
      });
      for (const orphan of seriesById.values()) {
        warnings.push(
          `league ${w.key}: series ${orphan.id} is not linked from its run's stages; skipped`,
        );
        summary.fixtures.unresolvedSideSkipped += (orphan.fixtures as unknown[]).length;
      }
      const maxGroup = Math.max(0, ...groups.map((g) => g.teamRefs.length));
      for (const sw of mapping.swaps) {
        const sizeA = groups[sw.groupA - 1]?.teamRefs.length ?? 0;
        const positionA = sw.positionA === 'last' ? sizeA : sw.positionA;
        if (!positionA || !groups[sw.groupB - 1]) {
          warnings.push(`league ${w.key}: swap needs groups with entrants; not exported`);
          continue;
        }
        swaps.push({
          competitionRef: compRef,
          groupA: groupName(sw.groupA),
          positionA,
          groupB: groupName(sw.groupB),
          positionB: sw.positionB,
          carryPoints: sw.carryPoints,
        });
      }
      const overs = structure.overs ?? optNum(series[0]?.maxOvers);
      competitions.push({
        externalRef: compRef,
        stream,
        name: structure.name,
        formatSource: 'setup',
        format: {
          ...mapping.format,
          ...(maxGroup >= 2 ? { teamsPerGroup: maxGroup } : {}),
        },
        ...(cricketFormatForOvers(overs)
          ? { cricketMatchFormat: cricketFormatForOvers(overs) }
          : {}),
        ...(overs ? { maxOvers: overs } : {}),
        groups,
        fixtures,
      });
    }

    // Plan-B streams → one competition per stream.
    const streamKeys = [...w.streams.keys()].sort();
    for (const stream of streamKeys) {
      const { label, items } = w.streams.get(stream)!;
      items.sort((a, b) => compareGroupLabels(a.groupLabel ?? '', b.groupLabel ?? ''));
      const compRecipe: CompetitionRecipe | undefined = recipe?.competitions[stream];
      const compRef = refs.competition(tenant, w.key, stream);
      const groups: BundleGroup[] = [];
      const fixtures: BundleFixture[] = [];
      const sourceFixtures: SourceFixture[] = [];
      items.forEach(({ series: s, groupLabel }, i) => {
        const participants = Array.isArray(s.participants)
          ? s.participants.map((p) => p.teamId)
          : (s.teams ?? []);
        const teamIds = participants.length ? participants : (s.teams ?? []);
        groups.push({
          name: groupName(i + 1),
          ...(groupLabel ? { sourceName: groupLabel } : {}),
          order: i,
          teamRefs: teamIds
            .map((id) => w.teams.get(id)?.externalRef)
            .filter((r): r is string => !!r),
        });
        for (const raw of s.fixtures as SourceFixture[]) {
          sourceFixtures.push(raw);
          collect(
            mapFixture(raw, {
              tenant,
              utcOffset: offset,
              seriesId: s.id,
              resolveTeam,
              phase: 1,
              stage: 'Group stage',
              groupName: groupName(i + 1),
              venueWithheld: s.withheld?.venue === true,
              timeWithheld: s.withheld?.time === true,
            }),
            fixtures,
          );
        }
      });

      const overs = optNum(items[0]?.series.maxOvers) ?? oversFromStreamLabel(label) ?? undefined;
      const maxGroup = Math.max(0, ...groups.map((g) => g.teamRefs.length));
      let format: BundleFormat;
      let formatSource: BundleCompetition['formatSource'];
      let cricketMatchFormat = cricketFormatForOvers(overs);
      if (compRecipe) {
        format = structuredClone(compRecipe.format);
        formatSource = 'recipe';
        cricketMatchFormat = compRecipe.cricketMatchFormat ?? cricketMatchFormat;
        const actual = groups.map((g) => g.teamRefs.length);
        if (
          compRecipe.expectedGroupSizes &&
          actual.join(',') !== compRecipe.expectedGroupSizes.join(',')
        )
          warnings.push(
            `league ${w.key} ${stream}: recipe expects groups [${compRecipe.expectedGroupSizes.join(',')}], series have [${actual.join(',')}]`,
          );
        if (compRecipe.confirm) confirmations.push(`${w.key} ${stream}: ${compRecipe.confirm}`);
      } else {
        const inferred = inferRounds(sourceFixtures);
        if (inferred.maxMeetings > 2)
          warnings.push(
            `league ${w.key} ${stream}: a pair meets ${inferred.maxMeetings} times; medicoach rounds max 2, exported as 2`,
          );
        format = {
          type: 'league',
          rounds: inferred.rounds,
          extraPhases: [],
          ...(maxGroup >= 2 ? { teamsPerGroup: maxGroup } : {}),
        };
        formatSource = w.catalogue?.fixturesOnly ? 'fixtures-only' : 'inferred';
      }

      competitions.push({
        externalRef: compRef,
        stream,
        name: compRecipe?.name ?? label ?? 'Main',
        formatSource,
        format,
        ...(cricketMatchFormat ? { cricketMatchFormat } : {}),
        ...(overs ? { maxOvers: overs } : {}),
        groups,
        fixtures,
        ...(compRecipe?.confirm ? { confirm: compRecipe.confirm } : {}),
      });

      for (const sw of compRecipe?.swaps ?? [])
        swaps.push({
          competitionRef: compRef,
          groupA: groupName(sw.groupA),
          positionA: sw.positionA,
          groupB: groupName(sw.groupB),
          positionB: sw.positionB,
          carryPoints: sw.carryPoints,
        });
      for (const r of compRecipe?.positionRelegations ?? [])
        pendingRelegations.push({
          competitionRef: compRef,
          group: groupName(r.group),
          position: r.position,
          targetLeagueKey: r.targetLeagueKey,
        });
    }

    // Recipes for streams the league has no series for are reported, not invented.
    for (const stream of Object.keys(recipe?.competitions ?? {}))
      if (!w.streams.has(stream))
        warnings.push(`league ${w.key}: recipe stream "${stream}" has no series; not exported`);

    if (recipe?.confirm) confirmations.push(`${w.key}: ${recipe.confirm}`);
    if (missingIds)
      warnings.push(
        `league ${w.key}: ${missingIds} fixture(s) have no id; skipped (no stable ref)`,
      );

    // Remove fixtures whose slot source was skipped (cancelled/undated), transitively.
    for (const c of competitions) {
      let changed = true;
      while (changed) {
        changed = false;
        const present = new Set(c.fixtures.map((f) => f.externalRef));
        const kept = c.fixtures.filter((f) =>
          [f.homeSlot, f.awaySlot].every(
            (sl) => !sl || sl.kind === 'group-position' || present.has(sl.ofFixtureRef),
          ),
        );
        if (kept.length !== c.fixtures.length) {
          summary.fixtures.orphanSlotSkipped += c.fixtures.length - kept.length;
          c.fixtures = kept;
          changed = true;
        }
      }
    }

    // Season.
    const allDates = competitions
      .flatMap((c) => c.fixtures.map((f) => f.scheduledTime.slice(0, 10)))
      .sort();
    let season: BundleSeason | null = null;
    const boundCal = w.catalogue?.setup
      ? calendarsById.get(w.catalogue.setup.calendarId)
      : undefined;
    if (boundCal?.blocks?.length) season = seasonFromCalendar(tenant, w.key, boundCal);
    else if (allDates.length) {
      const name = seasonLabelFor(config, allDates[0]);
      season = {
        externalRef: refs.season(tenant, w.key, `derived-${slugify(name)}`),
        name,
        startDate: allDates[0],
        endDate: allDates[allDates.length - 1],
        source: 'fixtures',
      };
    } else if (latestCalendar) {
      season = {
        ...seasonFromCalendar(tenant, w.key, latestCalendar),
        source: 'tenant-latest-calendar',
      };
      warnings.push(
        `league ${w.key}: no setup and no fixtures; season borrowed from calendar ${latestCalendar.id}`,
      );
    }
    if (!season) {
      warnings.push(
        `league ${w.key}: no calendar and no fixtures to date a season; league not exported`,
      );
      continue;
    }

    // Recipe later-phase fixtures, placeholder-dated at the season end.
    for (const c of competitions) {
      const compRecipe = recipe?.competitions[c.stream];
      if (c.formatSource !== 'recipe' || !compRecipe?.laterFixtures?.length) continue;
      const when = scheduledInstant(season.endDate, undefined, offset);
      const refOf = (slotId: string) => refs.recipeFixture(tenant, w.key, c.stream, slotId);
      const toSlot = (s: RecipeSlot): BundleSlot =>
        s.kind === 'group-position'
          ? { kind: 'group-position', groupName: groupName(s.group), position: s.position }
          : { kind: s.kind, ofFixtureRef: refOf(s.of) };
      for (const lf of compRecipe.laterFixtures) {
        c.fixtures.push({
          externalRef: refOf(lf.slotId),
          round: lf.round,
          phase: 1,
          stage: lf.stage,
          scheduledTime: when.scheduledTime,
          timeTbc: true,
          placeholderDate: true,
          sourceStatus: null,
          status: 'scheduled',
          notes: [
            'Not generated in smart club; placeholder date (season end). Set the real date in medicoach.',
          ],
          homeSlot: toSlot(lf.home),
          awaySlot: toSlot(lf.away),
        });
      }
    }

    const catalogue = w.catalogue;
    const label = catalogue?.label ?? recipe?.label ?? w.key;
    if (w.synthesised) summary.leagues.synthesised.push(w.key);
    if (!competitions.length) summary.leagues.withoutCompetitions.push(w.key);
    for (const c of competitions) {
      summary.fixtures.exported += c.fixtures.length;
      const placeholders = c.fixtures.filter((f) => f.placeholderDate).length;
      summary.fixtures.placeholders += placeholders;
      summary.competitions.push({
        league: w.key,
        stream: c.stream,
        formatSource: c.formatSource,
        type: c.format.type,
        groups: c.groups.length,
        fixtures: c.fixtures.length,
        placeholders,
      });
    }

    leagues.push({
      externalRef: lref,
      key: w.key,
      label,
      ...((catalogue?.group ?? recipe?.group) ? { group: catalogue?.group ?? recipe?.group } : {}),
      ...((catalogue?.district ?? recipe?.district)
        ? { district: catalogue?.district ?? recipe?.district }
        : {}),
      ...(catalogue?.fixturesOnly ? { fixturesOnly: true } : {}),
      ...(w.synthesised ? { synthesised: true } : {}),
      season,
      teamRefs: [...w.teams.values()].map((t) => t.externalRef),
      competitions,
      relegation: {
        swaps,
        positionRelegations: pendingRelegations.map((r) => ({
          competitionRef: r.competitionRef,
          group: r.group,
          position: r.position,
          targetLeagueRef: refs.league(tenant, r.targetLeagueKey),
        })),
        targetLeagueRefs: [
          ...new Set(pendingRelegations.map((r) => refs.league(tenant, r.targetLeagueKey))),
        ],
      },
      ...(recipe?.confirm ? { confirm: recipe.confirm } : {}),
    });
    summary.leagues.exported.push(w.key);
  }

  // Status tallies from what the bundle actually holds (after orphan-slot and league drops).
  for (const f of leagues.flatMap((l) => l.competitions.flatMap((c) => c.fixtures))) {
    if (f.sourceStatus === 'postponed') summary.fixtures.postponed++;
    if (f.sourceStatus === 'completed') summary.fixtures.completedInSource++;
  }

  // Drop relegations into leagues that are not in this bundle (e.g. a --leagues filter).
  const exportedLeagueRefs = new Set(leagues.map((l) => l.externalRef));
  for (const l of leagues) {
    const kept = l.relegation.positionRelegations.filter((r) =>
      exportedLeagueRefs.has(r.targetLeagueRef),
    );
    if (kept.length !== l.relegation.positionRelegations.length)
      warnings.push(`league ${l.key}: relegation target not exported; relegation dropped`);
    l.relegation.positionRelegations = kept;
    l.relegation.targetLeagueRefs = l.relegation.targetLeagueRefs.filter((r) =>
      exportedLeagueRefs.has(r),
    );
  }

  // Teams: only for leagues that made it into the bundle.
  const exportedKeys = new Set(leagues.map((l) => l.key));
  const teams: BundleTeam[] = [];
  const teamsByClubLeague = new Map<string, BundleTeam[]>(); // `${clubId}|${leagueKey}`
  for (const w of sortedWorks) {
    if (!exportedKeys.has(w.key)) continue;
    for (const t of w.teams.values()) {
      teams.push(t);
      const clubId = t.institutionRef.slice(refs.institution(tenant, '').length);
      const k = `${clubId}|${w.key}`;
      teamsByClubLeague.set(k, [...(teamsByClubLeague.get(k) ?? []), t]);
    }
  }
  const sidesOf = (clubId: string, leagueKey: string) =>
    teamsByClubLeague.get(`${clubId}|${leagueKey}`) ?? [];

  /* ── Staff ── */
  const staff = buildStaff(input, clubsById, institutions, exportedKeys, sidesOf, summary);

  /* ── Players ── */
  const { players, squadTeams } = buildPlayers(
    input,
    clubsById,
    institutions,
    leagues,
    sidesOf,
    summary,
  );
  // Appended after every league team so the existing teams keep their order.
  teams.push(...squadTeams);
  summary.players.squadTeams = squadTeams.length;

  const institutionList = [...institutions.values()].sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId),
  );
  summary.institutions.exported = institutionList.length;
  summary.staff.persons = staff.length;
  summary.staff.assignments = staff.reduce((n, s) => n + s.assignments.length, 0);
  summary.players.exported = players.length;

  const host = recipes.host ?? hostFromConfig(tenant, config, warnings);
  const body = {
    schema: BUNDLE_SCHEMA,
    version: BUNDLE_VERSION,
    tenant,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    host,
    institutions: institutionList,
    teams,
    people: { staff, players },
    leagues,
    meta: { confirmations: [...confirmations], excludedLeagues: summary.leagues.excluded },
  } as const;
  const bundle: MedicoachBundle = {
    ...body,
    counts: computeCounts(body as Omit<MedicoachBundle, 'counts'>),
  } as MedicoachBundle;
  return { bundle, summary };
}

/**
 * The host institution's display name from the tenant's branding: the organisation name,
 * then the short org handle, then the app title. Only when none is set does it fall back
 * to the bare tenant slug, and that fallback is recorded as a warning so a bundle never
 * silently ships "dolphins" as the host name. slugHint derives from the resolved name.
 */
export function hostFromConfig(
  tenant: string,
  config: Pick<TenantConfig, 'branding'> | null | undefined,
  warnings: string[],
): { name: string; slugHint: string } {
  const b = config?.branding;
  const name = [b?.name, b?.copy?.orgShort, b?.title]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .find(Boolean);
  if (!name) {
    warnings.push(
      `host name fell back to tenant slug "${tenant}" — set the tenant's display name (branding.name)`,
    );
    return { name: tenant, slugHint: slugify(tenant) || tenant };
  }
  return { name, slugHint: slugify(name) || tenant };
}

function lastEnd(c: SeasonCalendar): string {
  return (
    [...(c.blocks ?? [])]
      .map((b) => b.end)
      .sort()
      .at(-1) ?? ''
  );
}

function seasonFromCalendar(tenant: string, leagueKey: string, cal: SeasonCalendar): BundleSeason {
  const starts = cal.blocks.map((b) => b.start).sort();
  const ends = cal.blocks.map((b) => b.end).sort();
  return {
    externalRef: refs.season(tenant, leagueKey, cal.id),
    name: cal.label || cal.id,
    startDate: starts[0],
    endDate: ends[ends.length - 1],
    source: 'calendar',
  };
}

/** The tenant's season label, else "YYYY/YY" from the first fixture date. */
function seasonLabelFor(config: TenantConfig, firstDate: string): string {
  if (config.seasonLabel) return config.seasonLabel;
  const y = Number(firstDate.slice(0, 4));
  return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
}

/* ─────────────────────────── Staff ─────────────────────────── */

interface StaffDraft {
  staff: BundleStaff;
  names: Set<string>;
}

function buildStaff(
  input: BuildInputs,
  clubsById: Map<string, Club>,
  institutions: Map<string, BundleInstitution>,
  exportedKeys: Set<string>,
  sidesOf: (clubId: string, leagueKey: string) => BundleTeam[],
  summary: ExportSummary,
): BundleStaff[] {
  const { tenant, config } = input;
  const vertical = resolveVertical(config);
  const slotKeys = vertical.leadershipRoles.map((r) => r.key);
  const byIdentity = new Map<string, StaffDraft>();

  const add = (
    clubId: string,
    raw: Dict,
    kind: string,
    coach?: { level?: string; body?: string; teamRefs: string[] },
  ) => {
    summary.staff.entriesRead++;
    const identity = staffIdentity(raw, clubId);
    if (!identity || !optStr(raw.name)) {
      summary.staff.skippedNoIdentity++;
      return;
    }
    const institutionRef = institutions.get(clubId)!.externalRef;
    let draft = byIdentity.get(identity);
    if (!draft) {
      draft = {
        staff: {
          externalRef: refs.staff(tenant, hashIdentity(identity)),
          name: str(raw.name),
          assignments: [],
        },
        names: new Set(),
      };
      byIdentity.set(identity, draft);
    }
    const nn = normaliseName(raw.name);
    if (nn) {
      if (identity.startsWith('email:') && draft.names.size && !draft.names.has(nn))
        summary.staff.sharedEmailDifferentNames++;
      draft.names.add(nn);
    }
    const s = draft.staff;
    if (!s.email && normaliseEmail(raw.email)) s.email = normaliseEmail(raw.email);
    if (!s.cell && optStr(raw.cell)) s.cell = optStr(raw.cell);
    const existing = s.assignments.find(
      (a) => a.institutionRef === institutionRef && a.kind === kind,
    );
    if (existing) {
      if (coach && existing.coach)
        existing.coach.teamRefs = [...new Set([...existing.coach.teamRefs, ...coach.teamRefs])];
      return;
    }
    s.assignments.push({
      institutionRef,
      kind,
      ...(coach
        ? {
            coach: {
              ...(coach.level ? { level: coach.level } : {}),
              ...(coach.body ? { body: coach.body } : {}),
              teamRefs: coach.teamRefs,
            },
          }
        : {}),
    });
  };

  const clubs = [...clubsById.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const club of clubs) {
    const exco = asDict(club.exco);
    for (const key of slotKeys) {
      const m = exco[key];
      if (m && typeof m === 'object')
        add(club.id, asDict(m), key === 'chair' ? 'chair' : `exco:${key}`);
    }
    for (const m of Array.isArray(exco.additionalMembers) ? exco.additionalMembers : [])
      if (m && typeof m === 'object') add(club.id, asDict(m), `exco:${EXCO_ADDITIONAL}`);

    for (const raw of Array.isArray(club.coaches) ? club.coaches : []) {
      const c = asDict(raw);
      // Two stored shapes: the affiliation form {name, body, level, cell, email, idNumber,
      // teams (league keys), teamIds} and the contact importer {name, email, cell, source}.
      const leagueKeys = Array.isArray(c.teams)
        ? c.teams.map(String).filter((k) => exportedKeys.has(k))
        : [];
      const teamIds = new Set(Array.isArray(c.teamIds) ? c.teamIds.map(String) : []);
      const teamRefs = new Set<string>();
      for (const k of leagueKeys) {
        const sides = sidesOf(club.id, k);
        const picked = teamIds.size ? sides.filter((t) => teamIds.has(t.sourceTeamId)) : [];
        for (const t of picked.length ? picked : sides) teamRefs.add(t.externalRef);
      }
      if (!leagueKeys.length && teamIds.size)
        for (const k of exportedKeys)
          for (const t of sidesOf(club.id, k))
            if (teamIds.has(t.sourceTeamId)) teamRefs.add(t.externalRef);
      add(club.id, c, 'coach', {
        level: optStr(c.level),
        body: optStr(c.body),
        teamRefs: [...teamRefs],
      });
    }
  }
  return [...byIdentity.values()].map((d) => d.staff);
}

/* ─────────────────────────── Players ─────────────────────────── */

function buildPlayers(
  input: BuildInputs,
  clubsById: Map<string, Club>,
  institutions: Map<string, BundleInstitution>,
  leagues: BundleLeague[],
  sidesOf: (clubId: string, leagueKey: string) => BundleTeam[],
  summary: ExportSummary,
): { players: BundlePlayer[]; squadTeams: BundleTeam[] } {
  const { tenant } = input;
  const squads = new Map<string, BundleTeam>(); // by clubId
  const squadOf = (clubId: string): BundleTeam => {
    let t = squads.get(clubId);
    if (!t) {
      const inst = institutions.get(clubId)!;
      t = {
        externalRef: refs.squadTeam(tenant, clubId),
        institutionRef: inst.externalRef,
        sourceTeamId: clubId,
        name: `${inst.name} Squad`,
        clubSquad: true,
      };
      squads.set(clubId, t);
    }
    return t;
  };
  const includeInactive = input.options?.includeInactivePlayers === true;
  const leagueKeys = new Set(leagues.map((l) => l.key));
  const affiliationLeagues = leagues.filter((l) => !l.fixturesOnly);
  const veteransLeagueKeys = leagues
    .filter((l) => isVeteransLeague({ key: l.key, label: l.label }))
    .map((l) => l.key);

  // Pick one row per naturalKey: active beats non-active, then the newest registration.
  const chosen = new Map<string, PlayerRegistration>();
  const clubIds = [...clubsById.keys()].sort();
  for (const clubId of clubIds) {
    for (const p of input.playersByClub.get(clubId) ?? []) {
      summary.players.rowsRead++;
      const status = p.status ?? 'active';
      if (p.placeholder === true) {
        summary.players.placeholdersSkipped++;
        continue;
      }
      if (status !== 'active' && !includeInactive) {
        summary.players.excludedByStatus[status] =
          (summary.players.excludedByStatus[status] ?? 0) + 1;
        continue;
      }
      const prior = chosen.get(p.naturalKey);
      if (!prior) {
        chosen.set(p.naturalKey, p);
        continue;
      }
      summary.players.duplicateRowsMerged++;
      const rank = (r: PlayerRegistration) => ((r.status ?? 'active') === 'active' ? 1 : 0);
      if (
        rank(p) > rank(prior) ||
        (rank(p) === rank(prior) && str(p.createdAt) > str(prior.createdAt))
      )
        chosen.set(p.naturalKey, p);
    }
  }

  const out: BundlePlayer[] = [];
  const exportedByKey = new Map<string, BundlePlayer>();
  for (const p of chosen.values()) {
    // Rows are read per club in clubsById, so the institution always exists.
    const inst = institutions.get(p.clubId)!;
    const teamRefs: string[] = [];

    // Main club side: the registered league, else the club's only affiliation league.
    let leagueKey = p.team && leagueKeys.has(p.team) ? p.team : undefined;
    let candidateCount = 0;
    if (!p.team) {
      const club = clubsById.get(p.clubId);
      const candidates = (club?.leagues ?? []).filter((k) =>
        affiliationLeagues.some((l) => l.key === k),
      );
      candidateCount = candidates.length;
      if (candidates.length === 1) leagueKey = candidates[0];
    }
    const sides = leagueKey ? sidesOf(p.clubId, leagueKey) : [];
    if (sides.length === 1) teamRefs.push(sides[0].externalRef);
    else if (sides.length > 1) summary.players.ambiguousSide++;

    // Veterans second club.
    let veteransInstitutionRef: string | undefined;
    if (p.veteransClubId) {
      summary.veterans.playersWithVeteransClub++;
      const vInst = institutions.get(p.veteransClubId);
      if (vInst) veteransInstitutionRef = vInst.externalRef;
      let resolved = false;
      for (const k of veteransLeagueKeys) {
        const vs = sidesOf(p.veteransClubId, k);
        if (vs.length === 1 && !teamRefs.includes(vs[0].externalRef)) {
          teamRefs.push(vs[0].externalRef);
          resolved = true;
        } else if (vs.length > 1) summary.players.ambiguousSide++;
      }
      if (resolved) summary.veterans.resolvedVeteransTeam++;
    }

    // Fallback placement, ONLY for a player the rules above left without any team: an
    // already-placed player keeps exactly the teamRefs earlier exports gave it.
    const placement = summary.players.placement;
    if (sides.length === 1) placement.singleSide++;
    else if (teamRefs.length) placement.veteransOnly++;
    else if (sides.length > 1) {
      for (const s of sides) teamRefs.push(s.externalRef);
      placement.allSidesOfAmbiguous++;
    } else {
      teamRefs.push(squadOf(p.clubId).externalRef);
      placement.clubSquad++;
      const why = summary.players.clubSquadReasons;
      if (p.team && !leagueKey) why.leagueNotExported++;
      else if (leagueKey) why.noSideInLeague++;
      else if (candidateCount > 1) why.multipleCandidateLeagues++;
      else why.noRegisteredLeague++;
    }

    if (teamRefs.length) summary.players.withTeam++;
    else summary.players.noTeam++;

    const player: BundlePlayer = {
      externalRef: refs.player(tenant, p.naturalKey),
      institutionRef: inst.externalRef,
      firstName: str(p.firstName),
      lastName: str(p.lastName),
      ...(optStr(p.dob) ? { dob: optStr(p.dob) } : {}),
      ...(optStr(p.gender) ? { gender: optStr(p.gender) } : {}),
      ...(normaliseEmail(p.email) ? { email: normaliseEmail(p.email) } : {}),
      ...(optStr(p.cell) ? { cell: optStr(p.cell) } : {}),
      isMinor: p.isMinor === true,
      ...(optStr(p.guardianName) ? { guardianName: optStr(p.guardianName) } : {}),
      sourceStatus: p.status ?? 'active',
      ...(optStr(p.battingHand) ? { battingHand: optStr(p.battingHand) } : {}),
      ...(optStr(p.bowlingHand) ? { bowlingHand: optStr(p.bowlingHand) } : {}),
      ...(optStr(p.battingType) ? { battingType: optStr(p.battingType) } : {}),
      ...(optStr(p.bowlerType) ? { bowlerType: optStr(p.bowlerType) } : {}),
      ...(typeof p.isAllRounder === 'boolean' ? { isAllRounder: p.isAllRounder } : {}),
      ...(typeof p.isWk === 'boolean' ? { isWk: p.isWk } : {}),
      ...(optStr(p.position) ? { position: optStr(p.position) } : {}),
      teamRefs,
      ...(veteransInstitutionRef ? { veteransInstitutionRef } : {}),
    };
    out.push(player);
    exportedByKey.set(p.naturalKey, player);
  }

  // Coverage: do the VETAFFIL# records agree with the exported players?
  for (const [vetsClubId, affs] of input.veteransAffiliationsByClub ?? []) {
    for (const a of affs) {
      summary.veterans.affiliationsListed++;
      const chosenRow = chosen.get(a.naturalKey);
      if (chosenRow && chosenRow.veteransClubId === vetsClubId && exportedByKey.has(a.naturalKey))
        summary.veterans.affiliationsMatched++;
      else summary.veterans.affiliationsUnmatched++;
    }
  }

  return {
    players: out.sort((a, b) => a.externalRef.localeCompare(b.externalRef)),
    squadTeams: [...squads.values()].sort((a, b) => a.externalRef.localeCompare(b.externalRef)),
  };
}

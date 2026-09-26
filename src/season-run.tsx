/**
 * Admin console — running a season (ADR 0008).
 *
 * The operator designs a structure; the admin plays it out. This is that surface: start a
 * season for a league's competition, confirm which teams are in which group at each
 * stage, and generate that stage's fixtures.
 *
 * ── WHY A HUMAN CONFIRMS ──
 * The platform has no results or ladder model, so a stage whose teams depend on earlier
 * standings cannot resolve itself. Rather than pretend, the stage says exactly what the
 * rule is — in the operator's own words, from the structure's DerivationNote — proposes
 * the best grouping it honestly can, and asks. What the admin chose, what was proposed,
 * and whether they took it are all recorded: relegation and points carry ride on these
 * decisions.
 *
 * One stage-group becomes one Series, so everything downstream (approval, release, the
 * player broadcast, travel cost) is the existing, tested path.
 */
import { useMemo, useState, useId, type CSSProperties } from 'react';
import {
  BoundedNumber,
  Btn,
  Card,
  EmptyState,
  FieldGuide,
  HowSeasonsWork,
  Icon,
  InfoDot,
  Modal,
  NextSteps,
  OptionCards,
  Pill,
  StatusTimeline,
  type StatusStep,
} from './atoms';
import { ApiError, quickStartSeason, type QuickStartSeasonRequest } from './api';
import { describeError, quickStartErrorMessage, seasonRunErrorMessage } from './error-copy';
import { HelpLink } from './help/HelpDrawer';
import { Sentry } from './sentry';
import { daysBetween, findBlock, formatIsoDate, todayIso } from '../packages/engine/src/calendar';
import { describeEntrants, groupSizes, labelFor } from '../packages/engine/src/entrants';
import { formatStampDay } from './dates';
import {
  chainFeeder,
  crossPoolSourceStage,
  feedsPoolKnockout,
  poolQualifiersFor,
  uncoveredBlocksAcross,
  type StageMaterialisation,
} from '../packages/engine/src/structure';
import {
  describeStage,
  describeStructure,
  describeUncoveredBlockAggregate,
} from '../packages/engine/src/narrative';
import { materialiseRun } from '../packages/engine/src/run';
import { STAGE_KINDS, stageKindFor, stageTitle } from '../packages/engine/src/stage-kinds';
import {
  STRUCTURE_TEMPLATES,
  defaultPlacement,
  instantiateTemplate,
} from '../packages/engine/src/templates';
import { resolveCompetitionDefaults } from '../packages/engine/src/defaults';
import { isPoolKnockout, poolPairings, roundsForFormat } from '../packages/engine/src/formats';
import {
  findByKey,
  leagueParticipants,
  leagueParticipantsWithStatus,
} from '../packages/engine/src/leagues';
import { affiliationSubmitted, currentSeasonLabel } from './data';
import type {
  Club,
  Competition,
  CompetitionStructure,
  League,
  SeasonCalendar,
  SeasonRun,
  Series,
  StageRun,
  StageSpec,
  TenantConfig,
} from './types';

type Toast = (m: string, t?: string) => void;

const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '6px 0 0' };
/** Advisory, never blocking — the same gold the operator console uses for its warnings. */
const WARN: CSSProperties = { color: 'var(--gold, #B7791F)', fontSize: 12, lineHeight: 1.5 };

type KnockoutPairing = 'seeded' | 'cross-pool' | 'within-pool';

/** A pairing's first round in miniature, as plain text. */
const PAIRING_DIAGRAMS: Record<KnockoutPairing, string> = {
  'cross-pool': 'A1 v B2 · B1 v A2',
  'within-pool': 'A1 v A2 · B1 v B2',
  seeded: '1 v 4 · 2 v 3, by position over every group',
};

/** How a pairing reads in a sentence — the console says "group", never "pool". */
const PAIRING_LABELS: Record<KnockoutPairing, string> = {
  seeded: 'seeded',
  'cross-pool': 'cross-group',
  'within-pool': 'within-group',
};

/** What happens after a season starts, in order. Shown under both ways to start one. */
const SEASON_NEXT_STEPS: Array<{ title: string; desc: string }> = [
  {
    title: 'Confirm entrants',
    desc: 'Check who plays in each group. Where a stage depends on results, you’ll type the finishing order.',
  },
  {
    title: 'Generate fixtures',
    desc: 'Each stage builds its fixtures inside its block, one series per group.',
  },
  {
    title: 'Approve',
    desc: 'Check the draft fixtures on the Fixtures list and sign them off.',
  },
  {
    title: 'Release',
    desc: 'Publish them to every club’s portal. Venues or start times can be held back.',
  },
];

/**
 * What a stage will need the admin to type, as a sentence. The registry phrases most of
 * these as the object of "you will be asked for …" ("the seeding order of …"), so a
 * lower-case entry gets that lead-in; "Nothing extra." entries already stand alone.
 *
 * A stage whose sides are chosen by hand still needs them confirmed even when its format
 * asks for nothing more — saying "Nothing extra" there contradicts the Confirm button.
 */
function whatYouWillBeAsked(stage: StageSpec): string {
  const asked = STAGE_KINDS[stageKindFor(stage.format)].youWillBeAsked;
  if (/^nothing extra/i.test(asked) && stage.entrants.kind === 'manual')
    return 'Which sides play in each group. You confirm them before this stage can generate.';
  return /^[a-z]/.test(asked) ? `You’ll be asked for ${asked}` : asked;
}

/**
 * Where a series without a season stage came from (null for a season-stage series).
 *
 * "Imported schedule" is a bulk import: the Plan B importer's `s-planb-` ids, or a series
 * that names its league but carries neither a calendar binding nor a season run. Anything
 * else was made by hand through the retired Create series form (ADR 0014). Neither can be
 * regenerated — there is no stage to rebuild them from — but their fixtures stay editable
 * (add, edit, delete) on the Fixtures list.
 */
export function seriesOrigin(s: Series): 'imported' | 'stand-alone' | null {
  if (s.seasonRunId) return null;
  if (String(s.id).startsWith('s-planb-')) return 'imported';
  if (!s.schedule && s.leagueKey) return 'imported';
  return 'stand-alone';
}

/** The pill that marks a series outside every season stage, with its explainer. */
export function SeriesOriginPill({ series }: { series: Series }) {
  const origin = seriesOrigin(series);
  if (!origin) return null;
  return (
    <span
      className="series-origin"
      title="Not part of a season stage; cannot be regenerated. Its fixtures can still be added, edited and deleted."
    >
      <Pill tone="muted">{origin === 'imported' ? 'Imported schedule' : 'Stand-alone series'}</Pill>
      <HelpLink topic="legacy-series">What is this?</HelpLink>
    </span>
  );
}

/**
 * The grouping a rebase cleared, from the most recent rebase entry that carries one.
 *
 * An entrant-spec change drops the stage back to `awaiting-entrants` and moves its old
 * groups into the rebase entry's `prefill`, so the confirm form can start from where the
 * season actually was instead of from the registered list. A later schedule- or
 * wording-only rebase appends an entry with an empty `prefill`; it must not hide the
 * earlier one, so the scan walks back past rebase entries until it finds a non-empty
 * prefill. Any confirmation in between supersedes it.
 */
function rebasePrefill(stageRun: StageRun | undefined): string[][] | undefined {
  const audit = stageRun?.audit ?? [];
  for (let i = audit.length - 1; i >= 0; i--) {
    const entry = audit[i];
    if (entry?.event !== 'rebase') return undefined;
    if (entry.prefill.length) return entry.prefill;
  }
  return undefined;
}

/** Key-order-independent JSON — the same comparison the rebase route diffs specs with. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The parts of a stage's schedule the generated series embed (dates plus the
 * `activateFrom` reveal date) — mirrors the rebase route.
 */
const scheduleShape = (s: StageSpec) => ({
  blockIndex: s.schedule.blockIndex,
  cadence: s.schedule.cadence,
  slots: s.schedule.slots,
  roundsPerDay: s.schedule.roundsPerDay,
  startAfter: s.schedule.startAfter,
  activateFrom: s.schedule.activateFrom,
});

/** A league is season-capable only once the operator has bound a competition to it. */
export function seasonCapableLeagues(allLeagues: League[]): League[] {
  return (allLeagues || []).filter((l) => (l.competitions?.length ?? 0) > 0);
}

/**
 * The calendars a bound league's competitions play on, when EVERY one of them has ended
 * (its last block finished before `today`) — or `null` when any is still current, has no
 * blocks, or can't be found. A league whose seasons are all over has nothing to start a
 * season FROM, so the launcher offers quick start for its next one.
 */
export function endedCalendarsOf(
  league: League,
  calendars: SeasonCalendar[],
  today: string = todayIso(),
): Array<{ label: string; end: string }> | null {
  const competitions = league.competitions ?? [];
  if (!competitions.length) return null;
  const ended = new Map<string, { label: string; end: string }>();
  for (const comp of competitions) {
    const cal = calendars.find((c) => c.id === comp.calendarId);
    const end = cal?.blocks[cal.blocks.length - 1]?.end;
    if (!cal || !end || daysBetween(end, today) <= 0) return null;
    ended.set(cal.id, { label: cal.label, end });
  }
  return [...ended.values()];
}

/** A competition's calendar exists, has blocks, and every one of them finished before `today`. */
function competitionEnded(
  comp: Competition,
  calendars: SeasonCalendar[],
  today: string = todayIso(),
): boolean {
  const cal = calendars.find((c) => c.id === comp.calendarId);
  return !!cal && cal.blocks.length > 0 && cal.blocks.every((b) => daysBetween(b.end, today) > 0);
}

/** The first block's start, or '' when the calendar is missing or empty — sorts last. */
function calendarStart(comp: Competition, calendars: SeasonCalendar[]): string {
  const cal = calendars.find((c) => c.id === comp.calendarId);
  return cal?.blocks.reduce((min, b) => (!min || b.start < min ? b.start : min), '') ?? '';
}

/**
 * A league's competitions split into current and ended, each most-recent calendar first.
 *
 * Reusing a structure season after season mints one competition per season, so a league
 * accumulates "T20" on 2025/26 AND on 2026/27. Config order is creation order, which put
 * the dead season first and preselected it; this is the order the picker wants instead.
 */
export function competitionsByRecency(
  league: League | undefined,
  calendars: SeasonCalendar[],
  today: string = todayIso(),
): { current: Competition[]; ended: Competition[] } {
  const newestFirst = (a: Competition, b: Competition) =>
    calendarStart(b, calendars).localeCompare(calendarStart(a, calendars));
  const all = league?.competitions ?? [];
  return {
    current: all.filter((c) => !competitionEnded(c, calendars, today)).sort(newestFirst),
    ended: all.filter((c) => competitionEnded(c, calendars, today)).sort(newestFirst),
  };
}

/** The competition preselected for a league: its newest current one, else its newest ended one. */
function defaultCompetitionId(league: League | undefined, calendars: SeasonCalendar[]): string {
  const { current, ended } = competitionsByRecency(league, calendars);
  return (current[0] ?? ended[0])?.id ?? '';
}

/* ─── Start a season ─── */

function StartSeasonForm({
  clubs,
  allLeagues,
  config,
  existingRuns,
  onCreate,
  onClose,
  toast,
  initialLeagueKey,
  onBack,
}: {
  clubs: Club[];
  allLeagues: League[];
  config: TenantConfig;
  existingRuns: SeasonRun[];
  onCreate: (run: SeasonRun) => Promise<SeasonRun | void>;
  onClose: () => void;
  toast: Toast;
  /** Preselected by the launcher — the admin already chose this league there. */
  initialLeagueKey?: string;
  /** Routes back to the league picker instead of closing outright — see `GenerateFixturesLauncher`. */
  onBack?: () => void;
}) {
  const capable = seasonCapableLeagues(allLeagues);
  const [leagueKey, setLeagueKey] = useState(initialLeagueKey ?? capable[0]?.key ?? '');
  const league = capable.find((l) => l.key === leagueKey);
  const calendars = config.calendars ?? [];
  const [competitionId, setCompetitionId] = useState(() =>
    defaultCompetitionId(league, config.calendars ?? []),
  );
  const [showPast, setShowPast] = useState(false);
  const [seasonLabel, setSeasonLabel] = useState(currentSeasonLabel());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const competition = league?.competitions?.find((c) => c.id === competitionId);
  const structure = (config.structures ?? []).find((s) => s.id === competition?.structureId);
  const calendar = calendars.find((c) => c.id === competition?.calendarId);
  // Current competitions first; ended ones wait behind "Show past seasons" — unless every
  // competition has ended, when there is nothing to hide them behind.
  const { current, ended } = competitionsByRecency(league, calendars);
  const pastHidden = current.length > 0 && !showPast;
  const visible = pastHidden ? current : [...current, ...ended];
  const optionLabel = (c: Competition) => {
    const cal = calendars.find((x) => x.id === c.calendarId);
    return cal ? `${c.label} · ${cal.label}` : c.label;
  };
  const teams = league
    ? leagueParticipants(clubs, league.key, competition?.excludeTeamIds, {
        isAffiliated: affiliationSubmitted,
      })
    : [];
  const duplicate = existingRuns.some(
    (r) =>
      r.leagueKey === leagueKey &&
      r.competitionId === competitionId &&
      r.seasonLabel === seasonLabel.trim(),
  );

  const problems: string[] = [];
  if (!league) problems.push('Pick a league.');
  if (!competition) problems.push('Pick a competition.');
  if (!structure) problems.push('That competition points at a structure that no longer exists.');
  if (!calendar) problems.push('That competition points at a calendar that no longer exists.');
  if (!seasonLabel.trim()) problems.push('Give the season a label.');
  if (teams.length < 2)
    problems.push('At least two affiliated sides must be registered for this league.');
  if (duplicate) problems.push('That season is already running for this competition.');

  async function submit() {
    if (problems.length || busy || !league || !competition || !structure || !calendar) return;
    setErr('');
    setBusy(true);
    try {
      await onCreate({
        id: 'run-' + Date.now(),
        leagueKey: league.key,
        competitionId: competition.id,
        seasonLabel: seasonLabel.trim(),
        // Frozen at start: a later structure edit must never reshape a season in flight.
        structureSnapshot: structure,
        calendarSnapshot: calendar,
        stages: structure.stages.map((s) => ({
          specId: s.id,
          status: 'awaiting-entrants' as const,
          groups: [],
        })),
        version: 1,
      });
      toast(`${league.label} · ${competition.label} · ${seasonLabel.trim()} started`);
      onClose();
    } catch (e) {
      if (!(e as { alreadyToasted?: boolean })?.alreadyToasted) {
        setErr(describeError(e, 'Could not start the season — try again'));
      }
    } finally {
      setBusy(false);
    }
  }

  if (capable.length === 0) {
    return (
      <div>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          No league has a competition bound to it yet. A season runs a league&apos;s{' '}
          <strong>competition</strong> — a format stream with a structure and a calendar — and those
          are configured by your platform operator. Ask them to set one up, then start the season
          here.
        </p>
        <p style={{ ...HINT }}>
          In the meantime, any league can quick-start a season from the league picker.
        </p>
        <div style={{ marginTop: 16 }}>
          <Btn tone="outline" onClick={onClose}>
            Close
          </Btn>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="field">
        <div className="field-label">
          League <span className="req">*</span>
        </div>
        <select
          className="field-select"
          value={leagueKey}
          onChange={(e) => {
            const next = capable.find((l) => l.key === e.target.value);
            setLeagueKey(e.target.value);
            setCompetitionId(defaultCompetitionId(next, calendars));
            setShowPast(false);
          }}
        >
          {capable.map((l) => (
            <option key={l.key} value={l.key}>
              {l.label}
            </option>
          ))}
        </select>
        {capable.length < allLeagues.length && (
          <p style={HINT}>
            Only leagues your platform operator has bound a competition to appear here.
          </p>
        )}
      </div>

      <div className="field">
        <div className="field-label">
          Competition <span className="req">*</span>
        </div>
        {/* A league usually has ONE current competition — a dropdown there implies a
            choice that doesn't exist. The select only appears for leagues running parallel
            format streams (e.g. a 50 Over and a T20 competition over the same clubs), or
            once past seasons are revealed. Each option names its calendar: reuse mints one
            competition per season, so "T20" alone is ambiguous. */}
        {visible.length === 1 ? (
          <div style={{ fontSize: 13.5, padding: '6px 0' }}>{optionLabel(visible[0])}</div>
        ) : (
          <select
            className="field-select"
            aria-label="Competition"
            value={competitionId}
            onChange={(e) => setCompetitionId(e.target.value)}
          >
            {visible.map((c) => (
              <option key={c.id} value={c.id}>
                {optionLabel(c)}
              </option>
            ))}
          </select>
        )}
        {current.length > 0 && ended.length > 0 && (
          <button
            type="button"
            style={{
              ...HINT,
              background: 'none',
              border: 0,
              padding: 0,
              cursor: 'pointer',
              textDecoration: 'underline',
              display: 'block',
            }}
            onClick={() => {
              // Hiding past seasons again must not leave a hidden one selected.
              if (showPast && ended.some((c) => c.id === competitionId))
                setCompetitionId(current[0].id);
              setShowPast(!showPast);
            }}
          >
            {showPast ? 'Hide past seasons' : `Show past seasons (${ended.length})`}
          </button>
        )}
      </div>

      <div className="field">
        <div className="field-label">
          Season <span className="req">*</span>
        </div>
        <input
          className="field-input"
          value={seasonLabel}
          onChange={(e) => setSeasonLabel(e.target.value)}
          placeholder="2026/27"
          style={{ maxWidth: 200 }}
        />
      </div>

      {structure && calendar && (
        <div
          style={{
            border: '1px solid var(--line)',
            borderRadius: 8,
            padding: 12,
            fontSize: 12.5,
            color: 'var(--muted)',
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: 'var(--ink)' }}>{structure.name}</strong> (v{structure.version}) ·{' '}
          {calendar.label}
          <br />
          {teams.length} side{teams.length === 1 ? '' : 's'} registered for {league?.label}
          {/* The GROUP SHAPE, per stage. The card already named the structure and its
              stages, but not how many groups each makes — which is the whole difference
              between competitions on the same league ("50 Over" is one flat group,
              "Premier League" is two). Without it, picking a competition is picking a
              name. Sized against the real roster, so it reads "2 groups of 6, 6" rather
              than an abstract count. */}
          <div style={{ marginTop: 6, display: 'grid', gap: 2 }}>
            {structure.stages.map((s) => {
              const plan = s.entrants.kind === 'all-registered' ? undefined : s.entrants.groups;
              const sizes = groupSizes(plan, teams.length);
              // A `manual` stage with no plan is not "one group" — it is however many the
              // admin confirms, which nothing here can predict. Saying "one group of 12"
              // would assert a shape, which is the opposite of what this line is for.
              //
              // `all-registered` says "in one group" in its own description, so adding a
              // shape clause there reads "one group of 12 · Every registered side, in one
              // group". The COUNT is the new information; the shape isn't.
              const shape =
                !plan && s.entrants.kind === 'manual'
                  ? 'groups set when you confirm entrants'
                  : s.entrants.kind === 'all-registered'
                    ? `${sizes[0]} sides`
                    : sizes.length === 1
                      ? `one group of ${sizes[0]}`
                      : `${sizes.length} groups of ${sizes.join(', ')}`;
              return (
                <div key={s.id}>
                  <strong style={{ color: 'var(--ink)' }}>{s.name}</strong> · {shape} ·{' '}
                  {describeEntrants(s.entrants)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {problems.map((p, i) => (
        <div key={i} style={ERR}>
          {p}
        </div>
      ))}
      {err && <div style={ERR}>{err}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        {/* Once routed here from the league picker there was no way back to it — Cancel
            closes the whole modal, discarding the league choice too. Matches the wizard's
            footRow Back/ghost idiom (see `SeasonSetupWizard`). */}
        {onBack && (
          <Btn tone="ghost" onClick={onBack} disabled={busy}>
            Back
          </Btn>
        )}
        <Btn tone="teal" onClick={submit} disabled={!!problems.length || busy}>
          {busy ? 'Starting…' : 'Start season'}
        </Btn>
        <Btn tone="ghost" onClick={onClose}>
          Cancel
        </Btn>
      </div>
      <div className="sr-next">
        <div className="sr-next-t">What happens next</div>
        <NextSteps steps={SEASON_NEXT_STEPS} />
      </div>
    </div>
  );
}

/** `YYYY-MM-DD` — the shape a `<input type="date">` produces. A half-typed date must
 *  never reach the engine, which has no concept of "still being typed". */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ─── Quick start — a season for a league with no competition yet ───
 *
 * The operator's season wizard is the full tool. This is the short path an admin can take
 * alone: pick one of the starter shapes, a calendar, a label and a match format, and the
 * server makes the competition, structure, calendar and run in one call
 * (POST /season-runs/quick-start). The preview is the same `describeStructure` narrative
 * the operator console shows, so what the admin reads is what the server will build.
 */

/** The dates select's value for "type my own start and end". */
const CUSTOM_DATES = '__custom__';

function QuickStartForm({
  clubs,
  league,
  config,
  onStarted,
  onClose,
}: {
  clubs: Club[];
  league: League;
  config: TenantConfig;
  /** Refetch whatever the new season touched (the runs list, the tenant config). */
  onStarted?: () => Promise<unknown> | void;
  onClose: () => void;
}) {
  const calendars = config.calendars ?? [];
  const templateName = useId();
  const [templateId, setTemplateId] = useState(STRUCTURE_TEMPLATES[0].id);
  const [calendarId, setCalendarId] = useState(calendars[0]?.id ?? CUSTOM_DATES);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  // Only the stages the admin moved; everything else follows `defaultPlacement`, so a
  // change of shape or calendar starts from the sensible default again.
  const [placementEdits, setPlacementEdits] = useState<Record<number, number>>({});
  const [seasonLabel, setSeasonLabel] = useState(currentSeasonLabel());
  // The tenant's own match formats (ADR 0014), or the built-in list when it set none.
  // Picking one prefills overs and ball type; both stay editable.
  const defaults = resolveCompetitionDefaults(config);
  const formats = defaults.matchFormats;
  const [formatLabel, setFormatLabel] = useState(formats[0].label);
  const [overs, setOvers] = useState(formats[0].overs ?? 20);
  const [ballType, setBallType] = useState(formats[0].ballType ?? '');
  function pickFormat(label: string) {
    const f = formats.find((x) => x.label === label);
    setFormatLabel(label);
    if (f?.overs !== undefined) setOvers(f.overs);
    setBallType(f?.ballType ?? '');
  }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [started, setStarted] = useState<string | null>(null);
  const [startedWarnings, setStartedWarnings] = useState<string[]>([]);

  const template = STRUCTURE_TEMPLATES.find((t) => t.id === templateId) ?? STRUCTURE_TEMPLATES[0];
  const label = seasonLabel.trim();
  const operatorCalendar = calendars.find((c) => c.id === calendarId);
  const customValid =
    ISO_DATE_RE.test(startDate) && ISO_DATE_RE.test(endDate) && endDate >= startDate;
  // Custom dates are one block — the same shape the server makes from them.
  const calendar: SeasonCalendar | undefined =
    operatorCalendar ??
    (customValid
      ? {
          id: 'quick-start-preview',
          label: label || 'Season',
          blocks: [{ id: 'b1', label: 'Block 1', start: startDate, end: endDate }],
        }
      : undefined);
  const blockCount = calendar?.blocks.length ?? 0;
  const placement = defaultPlacement(template, blockCount).map((b, i) => placementEdits[i] ?? b);
  // Gated: an unaffiliated club's side is not counted into the preview. It can still be
  // included per side when entrants are confirmed.
  const teams = leagueParticipants(clubs, league.key, [], { isAffiliated: affiliationSubmitted });
  // Built once: the narrative reads it, and so does the coverage preview below.
  const instance = instantiateTemplate(template, calendar, undefined, placement, defaults);
  const narrative = describeStructure(instance, calendar, teams.length);
  // The same aggregate the server computes on success: every structure already bound to
  // the chosen calendar (any league) plus this one. Custom dates are a single block the
  // new structure always covers, so there is nothing to check there.
  const uncovered = operatorCalendar
    ? uncoveredBlocksAcross(
        [
          ...(config.leagues ?? [])
            .flatMap((l) => l.competitions ?? [])
            .filter((c) => c.calendarId === operatorCalendar.id)
            .map((c) => (config.structures ?? []).find((st) => st.id === c.structureId))
            .filter((st): st is CompetitionStructure => st !== undefined),
          instance,
        ],
        operatorCalendar,
      ).map(
        (block) =>
          `${operatorCalendar.label}: ${describeUncoveredBlockAggregate(block, operatorCalendar.blocks.indexOf(block))}`,
      )
    : [];

  const problems: string[] = [];
  if (!label) problems.push('Give the season a label.');
  if (!operatorCalendar && !customValid)
    problems.push(
      'Give the season a start date and an end date, with the end on or after the start.',
    );
  if (teams.length < 2)
    problems.push('At least two affiliated sides must be registered for this league.');

  async function submit() {
    if (problems.length || busy) return;
    setErr('');
    setBusy(true);
    const body: QuickStartSeasonRequest = {
      leagueKey: league.key,
      templateId: template.id,
      seasonLabel: label,
      calendar: operatorCalendar
        ? { id: operatorCalendar.id }
        : { label, start: startDate, end: endDate },
      matchFormat: {
        label: formatLabel,
        overs,
        ...(ballType.trim() ? { ballType: ballType.trim() } : {}),
      },
      ...(blockCount >= 2 ? { placement } : {}),
    };
    let warnings: string[] = [];
    try {
      const res = await quickStartSeason(body);
      warnings = res.warnings ?? [];
    } catch (e) {
      if (e instanceof ApiError) {
        // The competition was written but its season was not: refetch first, so the
        // recovery copy ("pick this league again and start it from its competition")
        // finds the competition there.
        if (e.status === 500 && e.code === 'run_not_started') {
          try {
            await onStarted?.();
          } catch {
            /* the next refetch catches up */
          }
        }
      } else {
        // Not the server's answer (offline, a TypeError): nothing else would report it.
        Sentry.captureException(e, { tags: { where: 'quick-start' } });
      }
      setErr(quickStartErrorMessage(e));
      setBusy(false);
      return;
    }
    // The season exists from here on. A failed refetch only means the Seasons card is a
    // moment behind; it must not read as a failed start.
    try {
      await onStarted?.();
    } catch {
      /* the next refetch catches up */
    }
    setBusy(false);
    setStartedWarnings(warnings);
    setStarted(label);
  }

  if (started) {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        <div className="sr-callout" role="status">
          <strong>
            {league.label} · {started} has started.
          </strong>{' '}
          Its stages are on the Seasons card. Work through them in this order.
        </div>
        {startedWarnings.map((w) => (
          <div key={w} style={WARN}>
            {w}
          </div>
        ))}
        <NextSteps steps={SEASON_NEXT_STEPS} />
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn tone="teal" onClick={onClose}>
            Done
          </Btn>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="field">
        <div className="field-label">How the season is played</div>
        <OptionCards
          name={templateName}
          label="How the season is played"
          value={templateId}
          onChange={(id) => {
            setTemplateId(id);
            setPlacementEdits({});
          }}
          options={STRUCTURE_TEMPLATES.map((t) => ({
            value: t.id,
            title: t.name,
            desc: t.whenToUse,
            eg: STAGE_KINDS[stageKindFor(t.stages[0].format)].eg,
          }))}
        />
      </div>

      <div className="field">
        <div className="field-label">
          Dates <span className="req">*</span>
        </div>
        <select
          className="field-select"
          aria-label="Dates"
          value={calendarId}
          onChange={(e) => {
            setCalendarId(e.target.value);
            setPlacementEdits({});
          }}
        >
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} ·{' '}
              {c.blocks.length
                ? `${formatIsoDate(c.blocks[0].start)} → ${formatIsoDate(c.blocks[c.blocks.length - 1].end)}`
                : 'no playing blocks'}
            </option>
          ))}
          <option value={CUSTOM_DATES}>Custom dates</option>
        </select>
        {!operatorCalendar && (
          <>
            <div className="sr-date-pair">
              <label className="sr-date">
                <span className="field-label">Start date</span>
                <input
                  type="date"
                  className="field-input"
                  aria-label="Start date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </label>
              <label className="sr-date">
                <span className="field-label">End date</span>
                <input
                  type="date"
                  className="field-input"
                  aria-label="End date"
                  value={endDate}
                  min={startDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </label>
            </div>
            <FieldGuide id="block-dates" />
          </>
        )}
      </div>

      {calendar && blockCount >= 2 && (
        <div className="field">
          <div className="field-label">Where each stage plays</div>
          <div className="sr-placement">
            {template.stages.map((st, i) => (
              <label key={st.id} className="sr-placement-row">
                <span>
                  Stage {i + 1} · {st.name} plays in
                </span>
                <select
                  className="field-select"
                  aria-label={`Stage ${i + 1} plays in`}
                  value={placement[i]}
                  onChange={(e) =>
                    setPlacementEdits((p) => ({ ...p, [i]: Number(e.target.value) }))
                  }
                >
                  {calendar.blocks.map((b, bi) => (
                    <option key={b.id} value={bi}>
                      {b.label} · {formatIsoDate(b.start)} → {formatIsoDate(b.end)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <div className="field-label">
          Season <span className="req">*</span>
        </div>
        <input
          className="field-input"
          aria-label="Season"
          value={seasonLabel}
          onChange={(e) => setSeasonLabel(e.target.value)}
          maxLength={80}
          placeholder="2026/27"
          style={{ maxWidth: 200 }}
        />
      </div>

      <div className="field">
        <div className="field-label">Match format</div>
        <div className="sr-format">
          <select
            className="field-select"
            aria-label="Match format"
            value={formatLabel}
            onChange={(e) => pickFormat(e.target.value)}
            style={{ width: 220 }}
          >
            {formats.map((f) => (
              <option key={f.label} value={f.label}>
                {f.label}
              </option>
            ))}
          </select>
          <BoundedNumber
            ariaLabel="Overs"
            min={1}
            max={200}
            style={{ width: 80 }}
            value={overs}
            onChange={setOvers}
          />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>overs</span>
          <input
            className="field-input"
            aria-label="Ball type"
            placeholder="Ball type (optional)"
            value={ballType}
            onChange={(e) => setBallType(e.target.value)}
            style={{ width: 160 }}
          />
        </div>
      </div>

      <div className="sr-preview">
        <div className="sr-preview-t">
          How it will run, with the {teams.length} side{teams.length === 1 ? '' : 's'} registered
          for {league.label}
        </div>
        {narrative.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {uncovered.map((line) => (
          <p key={line} style={WARN}>
            {line}
          </p>
        ))}
        {!calendar && <p className="sr-preview-note">Dates appear once the season has them.</p>}
      </div>

      {problems.map((p, i) => (
        <div key={i} style={ERR}>
          {p}
        </div>
      ))}
      {err && <div style={ERR}>{err}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <Btn tone="teal" onClick={submit} disabled={!!problems.length || busy}>
          {busy ? 'Starting…' : 'Start season'}
        </Btn>
        <Btn tone="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/* ─── Start a season — the single entry point, routed by league ─── */

/**
 * "12 sides (2 not yet affiliated)" — every side registered for the league, with the ones
 * the affiliation gate holds back called out. `affiliated` + `unaffiliated` is the total.
 */
export function registeredSidesLabel(affiliated: number, unaffiliated: number): string {
  const total = affiliated + unaffiliated;
  return `${total} side${total === 1 ? '' : 's'}${
    unaffiliated ? ` (${unaffiliated} not yet affiliated)` : ''
  }`;
}

/**
 * One button, routed by LEAGUE, with exactly two paths (ADR 0014). A league with a
 * competition its operator set up continues to `StartSeasonForm`; a league without one
 * gets Quick start in place, under a plain statement of which case it is. A one-off cup
 * or festival is not a third path: it is the One-off tournament template in Quick start.
 */
export function GenerateFixturesLauncher({
  clubs,
  allLeagues,
  config,
  existingRuns,
  onCreateRun,
  onSeasonSetupChanged,
  onClose,
  toast,
}: {
  clubs: Club[];
  allLeagues: League[];
  config: TenantConfig;
  existingRuns: SeasonRun[];
  onCreateRun: (run: SeasonRun) => Promise<SeasonRun | void>;
  /** Refetch the runs list and tenant config after a quick start made a new season. */
  onSeasonSetupChanged?: () => Promise<unknown> | void;
  onClose: () => void;
  toast: Toast;
}) {
  const capable = seasonCapableLeagues(allLeagues);
  const isCapable = (key: string) => capable.some((l) => l.key === key);
  const [leagueKey, setLeagueKey] = useState(allLeagues[0]?.key ?? '');
  const [step, setStep] = useState<'pick' | 'season'>('pick');

  if (step === 'season') {
    return (
      <Modal
        eyebrow="Fixtures · Season"
        title={
          <>
            Start a <em>season</em>
          </>
        }
        onClose={onClose}
      >
        <StartSeasonForm
          clubs={clubs}
          allLeagues={allLeagues}
          config={config}
          existingRuns={existingRuns}
          initialLeagueKey={leagueKey}
          onCreate={onCreateRun}
          onClose={onClose}
          onBack={() => setStep('pick')}
          toast={toast}
        />
      </Modal>
    );
  }

  // The picked league can vanish while the modal is open — deleted in another tab, then
  // this console's own config refetch drops it — which simply reads as "pick again".
  const league = findByKey(allLeagues, leagueKey) as League | undefined;
  const bound = !!league && isCapable(league.key);
  // A bound league whose every calendar has ended: its next season is a quick start.
  const ended = league && bound ? endedCalendarsOf(league, config.calendars ?? []) : null;
  const quickStart = !!league && (!bound || !!ended);
  const structureName = (id: string) =>
    (config.structures ?? []).find((s) => s.id === id)?.name ?? 'structure missing';
  // The structure of the league's most recent ended competition — the one an operator
  // would renew, so quick start isn't the only road and a duplicate isn't minted unknowingly.
  const lastEnded = ended
    ? competitionsByRecency(league, config.calendars ?? []).ended[0]
    : undefined;
  const renewable = lastEnded
    ? (config.structures ?? []).find((s) => s.id === lastEnded.structureId)?.name
    : undefined;
  // The sides a season would draw on, and how many the affiliation gate holds back — the
  // admin can still include those per side on Confirm entrants.
  const pool = league
    ? leagueParticipantsWithStatus(clubs, league.key, [], affiliationSubmitted)
    : undefined;

  function submit() {
    if (bound && !ended) setStep('season');
  }

  return (
    <Modal
      eyebrow="Fixtures"
      title="Start a season"
      maxWidth={quickStart ? 900 : undefined}
      onClose={onClose}
    >
      <div style={{ display: 'grid', gap: 16 }}>
        <div className="field">
          <div className="field-label">
            League <span className="req">*</span>
          </div>
          <select
            className="field-select"
            aria-label="League"
            value={league ? leagueKey : ''}
            onChange={(e) => setLeagueKey(e.target.value)}
          >
            {!league && (
              <option value="" disabled>
                Pick a league
              </option>
            )}
            {allLeagues.some((l) => isCapable(l.key)) && (
              <optgroup label="Competition set up by your operator">
                {allLeagues
                  .filter((l) => isCapable(l.key))
                  .map((l) => (
                    <option key={l.key} value={l.key}>
                      {l.label}
                    </option>
                  ))}
              </optgroup>
            )}
            {allLeagues.some((l) => !isCapable(l.key)) && (
              <optgroup label="No competition yet — quick start one">
                {allLeagues
                  .filter((l) => !isCapable(l.key))
                  .map((l) => (
                    <option key={l.key} value={l.key}>
                      {l.label}
                    </option>
                  ))}
              </optgroup>
            )}
          </select>
        </div>

        {league && (
          <div className="sr-callout">
            {ended ? (
              <>
                <p>
                  This league&apos;s competitions are on calendars that have ended (
                  {ended.map((c) => `${c.label}, ended ${formatIsoDate(c.end)}`).join('; ')}).
                  Quick-start the new season below, or ask your operator to bind a new calendar.
                </p>
                {renewable && (
                  <p className="sr-callout-sub">
                    Your operator can also renew last season&apos;s {renewable} in the season
                    wizard.
                  </p>
                )}
              </>
            ) : bound ? (
              <p>
                This league has a competition set up by your operator:{' '}
                {(league.competitions ?? [])
                  .map((c) => `${c.label} (${structureName(c.structureId)})`)
                  .join('; ')}
                .
              </p>
            ) : (
              <p>
                No competition has been set up for this league yet. Quick-start one below, or ask
                your operator to set one up in the season wizard.
              </p>
            )}
            {pool && (
              <p className="sr-callout-sub">
                {registeredSidesLabel(pool.participants.length, pool.unaffiliated.length)}{' '}
                registered for {league.label}.
              </p>
            )}
            <HelpLink topic="blocks-vs-stages" />
          </div>
        )}

        {league && quickStart ? (
          <QuickStartForm
            key={league.key}
            clubs={clubs}
            league={league}
            config={config}
            onStarted={onSeasonSetupChanged}
            onClose={onClose}
          />
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn tone="teal" onClick={submit} disabled={!league}>
              Continue
            </Btn>
            <Btn tone="ghost" onClick={onClose}>
              Cancel
            </Btn>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ─── Entrant confirmation ─── */

/**
 * Assign each side to a group.
 *
 * A dropdown per team rather than drag-and-drop: a Promotion stream is twenty sides, and
 * a scannable table where every row states its group is faster and less error-prone than
 * shuffling chips. Live counts against the structure's expected sizes catch a miscount
 * before it becomes a fixture list.
 */
function EntrantConfirmForm({
  stage,
  stageRun,
  materialisation,
  participants,
  unaffiliated = [],
  ranked: rankedByStructure,
  rankedReason,
  pairing,
  onConfirm,
  onCancel,
}: {
  stage: StageSpec;
  stageRun: StageRun | undefined;
  materialisation: StageMaterialisation;
  participants: Array<{ teamId: string; name: string }>;
  /**
   * Sides registered for the league whose club has not submitted its affiliation. They
   * are not in the derived pool, so they are listed greyed with a one-click "Include
   * anyway"; one already in a stored confirmation starts included.
   */
  unaffiliated?: Array<{ teamId: string; name: string }>;
  /**
   * Ask for a finishing position within each group, not just membership.
   *
   * Set when a LATER stage draws cross-pool qualifiers from this one: that bracket pairs
   * "the winner of pool A against the runner-up of pool B", so the order inside each
   * group is load-bearing rather than incidental. Without it the order is however the
   * clubs happen to be registered, which is not a ranking of anything — and the bracket
   * would be confidently wrong while the console said "cross-pool".
   *
   * Also set for a seeded knockout: there `ranks` supplies the seed line straight into
   * the bracket, so the same Position column and ordering machinery applies even though
   * nothing downstream draws a cross-pool bracket from it.
   */
  ranked?: boolean;
  /** Why `ranked` is set — decides which banner copy explains the Position column. */
  rankedReason?: 'cross-pool' | 'seeding';
  /**
   * Set for a knockout fed by pools: the union picks within- or cross-group semis here,
   * per season, over the structure's default. `run` and `stages` let the form preview
   * the first round live from the groups being confirmed, before anything is saved.
   */
  pairing?: {
    structureDefault: KnockoutPairing;
    override: KnockoutPairing | undefined;
    run: SeasonRun;
    stages: StageSpec[];
  };
  onConfirm: (
    groups: string[][],
    carriedPoints: Record<string, number>,
    pairing?: KnockoutPairing | 'default',
  ) => Promise<void>;
  onCancel: () => void;
}) {
  /**
   * The groups to seed the form from, whatever state the stage is in.
   *
   * An `awaiting-entrants` stage offers its prefill; a `ready` one (seeded-split or
   * all-registered) has already RESOLVED its groups, and those are the suggestion. Using
   * only the prefill left "Edit entrants" on a resolved stage showing a blank form with
   * every side unassigned, no "Use the suggestion" button, and — because the labels fell
   * back to `['Group A']` — a single-group dropdown that couldn't express the split at all.
   */
  const suggested =
    materialisation.status === 'awaiting-entrants'
      ? materialisation.prefill
      : materialisation.groups.map((g) => ({ id: g.id, label: g.label, entrants: g.entrants }));
  // The label list must cover every group the seed produces, not just the ones the
  // operator happened to name. `groupLabels` and the group plan are edited independently
  // and neither validates the other, so "Top Six, Bottom Six" over a three-group split
  // used to walk only indices 0 and 1: the third group's sides ended up in no group, were
  // NOT counted as "not playing" (their assignment isn't undefined), and their dropdown —
  // holding a value with no matching option — silently displayed "Not playing" while the
  // state said otherwise. Confirming then dropped them from the season.
  const namedLabels = stage.groupLabels?.length
    ? stage.groupLabels
    : suggested.length
      ? suggested.map((g) => g.label)
      : ['Group A'];
  const groupCount = Math.max(namedLabels.length, suggested.length, 1);
  // `labelFor`, not a local `String.fromCharCode(65 + i)`: that spelling emits "Group ["
  // at index 26 where the shared fallback gives "Group AA", and having two of them is how
  // the save path drifted to a third ("Group 1").
  const labels = Array.from({ length: groupCount }, (_, i) => labelFor(namedLabels, i));
  const expected =
    stage.entrants.kind !== 'all-registered' && stage.entrants.groups?.kind === 'sizes'
      ? stage.entrants.groups.sizes
      : null;

  /**
   * The groups to seed from — the stored confirmation if there is one, else the grouping
   * a structure rebase cleared (so re-confirming starts from where the season actually
   * was), else the suggestion.
   */
  const seedGroups = () =>
    stageRun?.groups?.length
      ? stageRun.groups.map((g) => g.entrants)
      : (rebasePrefill(stageRun) ?? suggested.map((g) => g.entrants));

  /**
   * teamId → group index. Seeded from the prefill so "accept the suggestion" is one click.
   * An index past the groups this stage now has (a rebase that cut a group) is left
   * unassigned — shown as "not playing" and counted — rather than stored against a group
   * with no option in the dropdown, which would silently drop the side on confirm.
   */
  const seed = () => {
    const map: Record<string, number> = {};
    seedGroups().forEach((entrants, gi) => {
      if (gi < groupCount) entrants.forEach((t) => (map[t] = gi));
    });
    return map;
  };
  /** teamId → 1-based position within its group, seeded from the stored/suggested order. */
  const seedRanks = () => {
    const map: Record<string, number> = {};
    seedGroups().forEach((entrants) => entrants.forEach((t, i) => (map[t] = i + 1)));
    return map;
  };
  const [assignment, setAssignment] = useState<Record<string, number>>(seed);
  // Held-back sides the admin chose to include — seeded from any already confirmed.
  const [included, setIncluded] = useState<string[]>(() => {
    const confirmed = new Set(seedGroups().flat());
    return unaffiliated.filter((p) => confirmed.has(p.teamId)).map((p) => p.teamId);
  });
  /** Every side the form can place: the pool plus the held-back sides included so far. */
  const rows = [...participants, ...unaffiliated.filter((p) => included.includes(p.teamId))];
  const heldBack = unaffiliated.filter((p) => !included.includes(p.teamId));
  const [ranks, setRanks] = useState<Record<string, number>>(seedRanks);
  const [points, setPoints] = useState<Record<string, number>>(stageRun?.carriedPoints ?? {});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pairingChoice, setPairingChoice] = useState<KnockoutPairing | 'default'>(
    pairing?.override ?? 'default',
  );
  const pairingName = useId();
  /** The pairing this confirmation would play, with the radio's choice applied. */
  const chosenPairing: KnockoutPairing | undefined = pairing
    ? pairingChoice === 'default'
      ? pairing.structureDefault
      : pairingChoice
    : undefined;
  // "Seeded over the full field" turns this stage's OWN order into the seed line, so it
  // needs the Position column exactly as a structure-seeded knockout does.
  const ranked = rankedByStructure || chosenPairing === 'seeded';

  const note = stage.entrants.kind === 'manual' ? stage.entrants.derivedFrom : undefined;
  const wantsPoints = !!note?.carryPoints;

  // Sorted by the admin's position when the order matters downstream, otherwise left in
  // participant order — which is what it always was, and fine for a round robin.
  const groups: string[][] = labels.map((_, gi) => {
    const inGroup = rows.filter((p) => assignment[p.teamId] === gi);
    if (!ranked) return inGroup.map((p) => p.teamId);
    return [...inGroup]
      .sort(
        (a, b) =>
          (ranks[a.teamId] ?? Number.MAX_SAFE_INTEGER) -
          (ranks[b.teamId] ?? Number.MAX_SAFE_INTEGER),
      )
      .map((p) => p.teamId);
  });
  const unassigned = rows.filter((p) => assignment[p.teamId] === undefined);

  // "Not playing" is a legitimate answer — a side registered for the league but sitting
  // this competition out. Blocking on it made the option a trap: choosing it disabled
  // Confirm permanently with no way back except reassigning. It is surfaced as a count
  // the admin can see and accept instead.
  const problems: string[] = [];
  groups.forEach((g, i) => {
    // A group with NO sides isn't the same as a side sitting the competition out — the
    // structure asked for this group and nobody is in it, so it would generate zero
    // fixtures and a series with no dates.
    if (g.length === 0) problems.push(`${labels[i]} has no sides.`);
    if (g.length === 1) problems.push(`${labels[i]} has one side — it would play nobody.`);
    if (expected && expected[i] !== undefined && g.length !== expected[i])
      problems.push(`${labels[i]} has ${g.length} sides; the structure expects ${expected[i]}.`);
    if (ranked && g.length > 1) {
      // A side moved in from "Not playing" was never seeded with a rank. Unasked, it
      // sorts silently last — and two of them collide on `undefined`, which the tie check
      // below would report as "two sides in the same position", describing something that
      // didn't happen.
      if (g.some((t) => ranks[t] === undefined))
        problems.push(`Give every side in ${labels[i]} a finishing position.`);
      // A tie makes the bracket depend on participant order again — exactly what asking
      // for a ranking was meant to remove.
      const positions = g.map((t) => ranks[t]).filter((n) => n !== undefined);
      if (new Set(positions).size !== positions.length)
        problems.push(`${labels[i]} has two sides in the same position.`);
    }
  });

  /*
   * The first round the chosen pairing would actually draw, from the groups on screen —
   * not from what is stored, so flipping the radio or moving a side updates it at once.
   * Built with the same `poolQualifiersFor` → `roundsForFormat` path generation uses, so
   * a shape the pool generators refuse shows here as the seeded fallback it will become.
   */
  const drawWith = (chosen: KnockoutPairing | undefined) => {
    if (!pairing || !chosen || stage.format.kind !== 'knockout') return null;
    const format = { ...stage.format, pairing: chosen };
    const candidate: StageSpec = { ...stage, format };
    const entrants = groups.flat();
    if (entrants.length < 2) return null;
    const hypothetical: SeasonRun = {
      ...pairing.run,
      stages: [
        ...pairing.run.stages.filter((s) => s.specId !== stage.id),
        {
          specId: stage.id,
          status: 'ready',
          groups: groups.map((g, i) => ({ id: `g${i + 1}`, label: labels[i], entrants: g })),
        },
      ],
    };
    const stages = pairing.stages.map((s) => (s.id === stage.id ? candidate : s));
    const qualifiers = poolQualifiersFor(candidate, stages, hypothetical);
    const fellBack = isPoolKnockout(format) && poolPairings(format, entrants, qualifiers) === null;
    const nameOf = (id: string) => rows.find((p) => p.teamId === id)?.name ?? id;
    const first = (roundsForFormat(format, entrants, qualifiers)[0] ?? []).map(
      ([home, away]) => `${nameOf(home)} v ${nameOf(away)}`,
    );
    return { first, fellBack };
  };
  const pairingPreview = drawWith(chosenPairing);
  // Within-group only draws for a power-of-two number of pools with equal, power-of-two
  // qualifiers each (`withinPoolRounds`). When the groups on screen can't be drawn that
  // way, the option is disabled rather than offered and silently turned into the seeded
  // fallback — the server accepts any whitelisted pairing, so this is where shape is held.
  const withinRefused = !!drawWith('within-pool')?.fellBack;

  async function submit() {
    if (problems.length || busy) return;
    setErr('');
    setBusy(true);
    try {
      await onConfirm(groups, wantsPoints ? points : {}, pairing ? pairingChoice : undefined);
    } catch (e) {
      // A version race or network failure gets its own line, not "season run changed;
      // refetch" (the server's boilerplate).
      setErr(seasonRunErrorMessage(e, 'Could not confirm — try again'));
    } finally {
      setBusy(false);
    }
  }

  // The prefill carried only the top q of each earlier group (`qualifiersPerGroup`), so a
  // side missing from the form is one that did not qualify, not one the platform lost.
  const qualifiers = note?.qualifiersPerGroup;
  const trimmedPrefill =
    Number.isInteger(qualifiers) &&
    (qualifiers as number) > 0 &&
    materialisation.status === 'awaiting-entrants' &&
    !stageRun?.groups?.length &&
    suggested.length > 0;
  const whyAsked = (
    <p className="sr-why">
      <span className="sr-callout-k">Why you&apos;re asked:</span> The platform does not record
      results, so the finishing order is typed by you and recorded against your name.{' '}
      <HelpLink topic="standings-typed-by-human" />
    </p>
  );

  /** Bring a held-back side into the form — straight into the group when there is one. */
  function includeAnyway(teamId: string) {
    setIncluded((xs) => [...xs, teamId]);
    if (groupCount === 1) setAssignment((a) => ({ ...a, [teamId]: 0 }));
  }

  return (
    <div>
      {stage.entrants.kind === 'all-registered' && (
        <div className="sr-callout" style={{ marginBottom: 16 }}>
          <p>
            Every registered side is in by default. Remove a side here if it is not playing this
            season.
          </p>
        </div>
      )}

      {note && (
        <div className="sr-callout" style={{ marginBottom: 16 }}>
          <p>
            <span className="sr-callout-k">The rule:</span> {note.detail}
          </p>
          {note.carryPoints && (
            <p className="sr-callout-sub">
              Points move with the position, not the team — enter the points each side takes on.
            </p>
          )}
          {trimmedPrefill && (
            <p className="sr-callout-sub">
              Prefilled with the top {qualifiers} of each group; sides that did not qualify are not
              re-added.
            </p>
          )}
          {whyAsked}
        </div>
      )}

      {ranked && (
        <div className="sr-callout" style={{ marginBottom: 16 }}>
          {rankedReason === 'seeding' ? (
            <>
              <strong>Seeded knockout.</strong> Position 1 is the top seed — set each side&apos;s
              finishing position, not just which group it was in.
            </>
          ) : (
            <>
              <strong>Order matters here.</strong> A later stage pairs these groups across each
              other — the group winner against another group&apos;s runner-up — so set each
              side&apos;s finishing position, not just which group it was in.
            </>
          )}
          {!note && whyAsked}
        </div>
      )}

      {pairing && (
        <fieldset className="sr-pairing">
          <legend>Semi-final pairing</legend>
          <OptionCards<KnockoutPairing | 'default'>
            name={pairingName}
            label="Semi-final pairing"
            compact
            value={pairingChoice}
            onChange={setPairingChoice}
            options={[
              {
                value: 'default',
                title: `Structure default (${PAIRING_LABELS[pairing.structureDefault]})`,
                desc: PAIRING_DIAGRAMS[pairing.structureDefault],
              },
              { value: 'cross-pool', title: 'Cross-group', desc: PAIRING_DIAGRAMS['cross-pool'] },
              {
                value: 'within-pool',
                title: 'Within-group',
                desc: PAIRING_DIAGRAMS['within-pool'],
                disabled: withinRefused,
                disabledReason:
                  'Needs 2, 4, 8… groups, each sending the same number (2, 4, 8…) of qualifiers.',
              },
              {
                value: 'seeded',
                title: 'Seeded over the full field',
                desc: PAIRING_DIAGRAMS.seeded,
              },
            ]}
          />
          <FieldGuide id="semi-final-pairing" />
          <p style={HINT}>
            Applies to this season only — the structure keeps its default for the next one.
            {withinRefused &&
              ' Within-group is unavailable: these groups can’t be paired inside each group.'}
          </p>
          {pairingPreview && (
            <div style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.55 }}>
              <strong>First round:</strong> {pairingPreview.first.join(' · ') || '—'}
              {pairingPreview.fellBack && (
                <div style={{ ...HINT, color: 'var(--coral)' }}>
                  These groups can’t be drawn {PAIRING_LABELS[chosenPairing!]} — it would be paired
                  as a seeded bracket over the full field. Check the group stage’s finishing
                  positions and who qualified.
                </div>
              )}
            </div>
          )}
        </fieldset>
      )}

      {/* Once, above the table — not in every row. */}
      {ranked && (
        <div className="sr-position-guide">
          <FieldGuide id="position-column" />
        </div>
      )}

      <div className="tbl-w" style={{ maxHeight: 420, overflowY: 'auto' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Side</th>
              <th style={{ width: 200 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                  Group
                  <InfoDot title="Group">
                    <p>
                      Which group each side plays in this stage. Choose <strong>Not playing</strong>{' '}
                      to leave a side out. The group names come from the structure (e.g. Top Six,
                      Bottom Six).
                    </p>
                  </InfoDot>
                </span>
              </th>
              {ranked && (
                <th style={{ width: 90 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                    Position
                    <InfoDot title="Position">
                      <p>
                        Where each side finished in the earlier stage — it sets the seeding for a
                        knockout or the order for a cross-group draw.
                      </p>
                    </InfoDot>
                  </span>
                </th>
              )}
              {wantsPoints && (
                <th style={{ width: 130 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                    Carried points
                    <InfoDot title="Carried points">
                      <p>
                        Points this side brings into the new stage from the last one — used when the
                        structure carries points forward with the position.
                      </p>
                    </InfoDot>
                  </span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.teamId}>
                <td>{p.name}</td>
                <td>
                  <select
                    className="field-select"
                    value={assignment[p.teamId] ?? ''}
                    onChange={(e) =>
                      setAssignment((a) => {
                        const next = { ...a };
                        if (e.target.value === '') delete next[p.teamId];
                        else next[p.teamId] = Number(e.target.value);
                        return next;
                      })
                    }
                  >
                    <option value="">Not playing</option>
                    {/* Keyed by INDEX, not label: the index is the identity here (it is
                        what `assignment` stores), and `groupLabels` is free text with no
                        uniqueness check anywhere — so two groups may legitimately share a
                        name. Keying by label made that a duplicate-key error with
                        unstable reconciliation, on the control that decides relegation. */}
                    {labels.map((l, i) => (
                      <option key={i} value={i}>
                        {l}
                      </option>
                    ))}
                  </select>
                </td>
                {ranked && (
                  <td>
                    <BoundedNumber
                      min={1}
                      // A position can't exceed the group it's in. Bounding it here is
                      // what stops "3 → clear → 5" landing as 15 and quietly reordering
                      // the cross-pool bracket, which no validation downstream would see.
                      max={Math.max(1, groups[assignment[p.teamId]]?.length ?? 1)}
                      style={{ width: 70 }}
                      // Meaningless for a side that isn't in a group.
                      disabled={assignment[p.teamId] === undefined}
                      value={ranks[p.teamId] ?? 1}
                      onChange={(n) => setRanks((r) => ({ ...r, [p.teamId]: n }))}
                    />
                  </td>
                )}
                {wantsPoints && (
                  <td>
                    <input
                      className="field-input"
                      type="number"
                      style={{ width: 100 }}
                      value={points[p.teamId] ?? ''}
                      onChange={(e) =>
                        setPoints((pt) => ({ ...pt, [p.teamId]: Number(e.target.value) || 0 }))
                      }
                    />
                  </td>
                )}
              </tr>
            ))}
            {/* Held back by the affiliation gate: shown, greyed, never silently missing —
                the admin may know the form is on its way and include the side anyway. */}
            {heldBack.map((p) => (
              <tr key={p.teamId} className="sr-held-back">
                <td>
                  {p.name}
                  <div style={HINT}>Not yet affiliated</div>
                </td>
                <td colSpan={1 + (ranked ? 1 : 0) + (wantsPoints ? 1 : 0)}>
                  <Btn
                    tone="ghost"
                    size="sm"
                    aria-label={`Include ${p.name} anyway`}
                    onClick={() => includeAnyway(p.teamId)}
                  >
                    Include anyway
                  </Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
        {unassigned.length > 0 && <Pill tone="muted">{unassigned.length} not playing</Pill>}
        {labels.map((l, i) => {
          const n = groups[i].length;
          const want = expected?.[i];
          const okCount = want === undefined ? n >= 2 : n === want;
          return (
            <Pill key={i} tone={okCount ? 'teal' : 'muted'}>
              {l}: {n}
              {want !== undefined ? ` of ${want}` : ''} {okCount ? '✓' : ''}
            </Pill>
          );
        })}
        {suggested.length > 0 && (
          <Btn
            tone="ghost"
            size="sm"
            onClick={() => {
              setAssignment(seed());
              setRanks(seedRanks());
            }}
          >
            Use the suggestion
          </Btn>
        )}
      </div>

      {problems.map((p, i) => (
        <div key={i} style={ERR}>
          {p}
        </div>
      ))}
      {err && <div style={ERR}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Btn tone="teal" onClick={submit} disabled={!!problems.length || busy}>
          {busy ? 'Confirming…' : 'Confirm entrants'}
        </Btn>
        <Btn tone="ghost" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/* ─── Stage card ─── */

function StageCard({
  stage,
  index,
  stageRun,
  materialisation,
  seriesById,
  stageSeries,
  feederSeries,
  registered,
  heldBack = [],
  calendar,
  narrative,
  onConfirm,
  onGenerate,
  busy,
}: {
  /** The EFFECTIVE stage — the run's `pairingOverride` already applied. */
  stage: StageSpec;
  index: number;
  /** The run's frozen calendar — where "Plays in Block N" reads its dates from. */
  calendar: SeasonCalendar;
  /** This stage's sentence from `describeStructure` over the run's snapshot. */
  narrative?: string;
  stageRun: StageRun | undefined;
  materialisation: StageMaterialisation;
  seriesById: (id: string) => Series | undefined;
  /**
   * Every series this run generated for this stage, found by its own `seasonRunId` /
   * `stageSpecId` rather than through the run's `groups[].seriesId`. A rebase that
   * changes a stage's entrant spec clears its groups — and the back-pointers with them —
   * but the series survive under their deterministic ids, and the next generate
   * overwrites them in place. Without this the released-schedule prompt never fired for
   * exactly that stage.
   */
  stageSeries: Series[];
  /**
   * For a stage dated behind a feeder in the same block (`startAfter: 'previous-stage'`),
   * the series that feeder generated; undefined when the stage is not chained.
   */
  feederSeries: Series[] | undefined;
  /** Every side currently registered for the league — for the drift check below. */
  registered: string[];
  /**
   * Registered sides the affiliation gate holds back. Not "missing" from a group (they
   * are not in the pool), and not "departed" from one either (an admin may have included
   * one anyway): they are still registered.
   */
  heldBack?: string[];
  onConfirm: () => void;
  onGenerate: () => void;
  busy: boolean;
}) {
  const [confirmRegen, setConfirmRegen] = useState(false);
  const generated = stageRun?.status === 'generated';
  const ready = materialisation.status === 'ready';
  const fits = ready && materialisation.fits;
  /** The series a group generated: its stored back-pointer, else the run/stage lookup. */
  const linkedFor = (groupId: string) => {
    const sid = stageRun?.groups.find((x) => x.id === groupId)?.seriesId;
    return (sid ? seriesById(sid) : undefined) ?? stageSeries.find((s) => s.groupId === groupId);
  };
  const allLinked = [
    ...(stageRun?.groups ?? [])
      .map((g) => (g.seriesId ? seriesById(g.seriesId) : undefined))
      .filter((s): s is Series => !!s),
    ...stageSeries,
  ].filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i);
  // Entrants were re-confirmed after generation, so the linked series still hold the old
  // groups. Say so rather than showing the new counts beside a "Released" pill. A stored
  // back-pointer isn't required: a rebase-cleared stage has none, and its series are
  // every bit as stale.
  const staleEntrants =
    !!stageRun &&
    stageRun.status !== 'generated' &&
    (stageRun.groups.some((g) => g.seriesId !== undefined) || stageSeries.length > 0);

  // …and the same question asked of the FIXTURES, which catches what the entrants check
  // structurally cannot: re-confirming the POOL stage's finishing positions changes this
  // stage's cross-pool bracket without touching its own entrants. The stage stays
  // 'generated', so without this there is no "Needs regenerating" pill and no Generate
  // button — the admin's only escape was to remove a side, confirm, re-add it, confirm
  // again. Which is the workflow the Position column exists to serve.
  // PAIRINGS only — deliberately not dates. Rescheduling a rained-off fixture is the most
  // routine thing an admin does, and `EditFixtureRow` writes exactly that field. With
  // `date` in the key, one reschedule pinned the stage on a coral "Needs regenerating"
  // forever, over copy claiming the entrants had changed, offering a button whose only
  // effect was to destroy the reschedule.
  const fixtureKey = (fx: Array<{ round?: number; home?: string; away?: string }>) =>
    JSON.stringify((fx ?? []).map((f) => [f?.round, f?.home, f?.away]));
  // The pairing includes the run's `pairingOverride`: `materialisation` is built from the
  // effective stage, so flipping within-/cross-group after generation diverges here.
  const diverged =
    ready &&
    materialisation.groups.some((g) => {
      const linked = linkedFor(g.id);
      return !!linked && fixtureKey(g.fixtures) !== fixtureKey(linked.fixtures as never);
    });
  // A rebase that changed this stage's schedule marks it explicitly — the pairing-only
  // check above can't see a date change. The server sets the marker whether or not the
  // stage has fixtures yet, but it only means something once there are series to rebuild;
  // before that, generating simply uses the new schedule.
  const staleSchedule = !!stageRun?.staleSchedule && allLinked.length > 0;
  // A CHAINED stage must start after its feeder's last round, so a feeder regenerate that
  // pushed the feeder later can run it into this stage — while pairings, and so
  // `diverged`, stay put. Asked of the ACTUAL series on both sides: this stage's earliest
  // fixture against the feeder's latest. Only an overlap flags, so moving one of this
  // stage's own fixtures later (a rained-off opener) stays the routine edit it is above;
  // comparing against the plan instead pinned such a stage on "Needs regenerating".
  const fixtureDates = (series: Series[]) =>
    series
      .flatMap((s) => (s.fixtures ?? []) as Array<{ date?: string }>)
      .map((f) => f?.date)
      .filter((d): d is string => !!d)
      .sort();
  const ownDates = fixtureDates(allLinked);
  const feederDates = feederSeries ? fixtureDates(feederSeries) : [];
  const chainMoved =
    !!feederSeries &&
    ready &&
    ownDates.length > 0 &&
    feederDates.length > 0 &&
    ownDates[0] <= feederDates[feederDates.length - 1];
  const needsRegen = diverged || staleSchedule || chainMoved;
  const stale = staleEntrants || needsRegen;

  // A confirmed grouping is frozen — deliberately, it is a human decision about this
  // season — so it stops tracking the league's registration list. A club that joins
  // afterwards is silently in no group; one that leaves is still in a group, reaches
  // `series.teams` but not `series.participants`, and renders as "Unknown team". Neither
  // is wrong to allow, but both have to be VISIBLE, with Edit entrants as the way out.
  const grouped = new Set((stageRun?.groups ?? []).flatMap((g) => g.entrants));
  const drift = stageRun?.groups.length
    ? {
        missing: registered.filter((t) => !grouped.has(t)).length,
        departed: [...grouped].filter((t) => !registered.includes(t) && !heldBack.includes(t))
          .length,
      }
    : null;

  // Regenerating rewrites the linked series IN PLACE, and `released` is deliberately not
  // reset — so a published schedule would change under clubs and players with no prompt.
  // Every comparable action in the console asks first; this one must too.
  const releasedLinked = allLinked.filter((s) => s.released);
  const totalFixtures = materialisation.status === 'ready' ? materialisation.totalFixtures : 0;

  // Any released series this generate would overwrite asks first — whether or not the
  // stage reads as stale. The generate button is only on offer when there is something to
  // (re)build, so in the ordinary flow this is the same as before; it additionally catches
  // a rebase-cleared stage, whose series ids are deterministic and get rewritten in place.
  function requestGenerate() {
    if (releasedLinked.length) setConfirmRegen(true);
    else onGenerate();
  }

  // Where the stage is in its life: Awaiting entrants → Ready → Generated → Released.
  // Released means every group's series is out; a partly released stage is still Generated.
  const awaiting = materialisation.status === 'awaiting-entrants';
  const releasedAll =
    generated &&
    ready &&
    materialisation.groups.length > 0 &&
    materialisation.groups.every((g) => !!linkedFor(g.id)?.released);
  const currentStep = awaiting ? 0 : !generated ? 1 : releasedAll ? 3 : 2;
  const asked = whatYouWillBeAsked(stage);
  const stepHints = [
    asked,
    'Generate to create the fixtures',
    'Approve and release from the Fixtures list',
    undefined,
  ];
  const timeline: StatusStep[] = ['Awaiting entrants', 'Ready', 'Generated', 'Released'].map(
    (label, i) => ({
      label,
      state: i < currentStep ? 'done' : i === currentStep ? 'current' : 'todo',
      hint: i === currentStep ? stepHints[i] : undefined,
    }),
  );

  // "Plays in Block 2 (After the break) · 16 Jan → 27 Mar 2027": the planned dates once
  // the stage has groups to plan, else the block's own dates.
  const blockNo = stage.schedule.blockIndex + 1;
  const block = findBlock(calendar, stage.schedule.blockIndex);
  const planned = ready
    ? materialisation.groups.flatMap((g) => g.plan.dates).sort()
    : ([] as string[]);
  const span = planned.length
    ? [planned[0], planned[planned.length - 1]]
    : block
      ? [block.start, block.end]
      : null;
  const blockLabel = block?.label?.trim();
  const playsIn = `Plays in Block ${blockNo}${
    blockLabel && blockLabel !== `Block ${blockNo}` ? ` (${blockLabel})` : ''
  }${span ? ` · ${formatIsoDate(span[0])} → ${formatIsoDate(span[1])}` : ''}${
    block ? '' : ' · not on this season’s calendar'
  }`;

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: 14,
        marginBottom: 10,
        background: 'var(--white, #fff)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--muted-2)', fontWeight: 700 }}>
          STAGE {index + 1}
        </span>
        {/* A heading, not a styled span: this is the title of a section a screen reader
            should be able to jump to, and the season is a list of these. */}
        <h3 style={{ fontWeight: 700, fontSize: 14, margin: 0 }}>
          {stage.name} · {stageTitle(stage.format)}
        </h3>
        {/* The timeline below carries the ordinary status; a pill appears only when
            something needs attention. Stale before everything: a generated stage whose
            pairing, schedule or feeder moved is still 'generated' in the run. */}
        {stale ? (
          <Pill tone="coral">Needs regenerating</Pill>
        ) : ready && !fits ? (
          <Pill tone="coral">Doesn’t fit</Pill>
        ) : null}
        <InfoDot
          title="Stage status"
          options={[
            {
              label: 'Awaiting entrants',
              desc: 'This stage’s teams depend on an earlier stage’s results — confirm who plays before it can generate.',
              eg: 'a finals stage waiting on the group standings',
            },
            {
              label: 'Ready to generate',
              desc: 'Teams and groups are set and fit the calendar block. Generate its fixtures.',
            },
            {
              label: 'Doesn’t fit',
              desc: 'The rounds need more time than the calendar block allows — shorten the format or widen the block.',
              eg: '11 rounds needed but the block is only 8 weeks',
            },
            {
              label: 'Generated',
              desc: 'Fixtures exist as one or more series. Approve and release them from the list above.',
            },
            {
              label: 'Needs regenerating',
              desc: 'Entrants, pairings or the schedule changed since the fixtures were built — regenerate to catch up.',
              eg: 'a side withdrew after the fixtures were made',
            },
          ]}
        />
      </div>

      <div className="sr-stage-tl">
        <StatusTimeline steps={timeline} />
      </div>
      <div className="sr-stage-meta">
        <p className="sr-stage-block">{playsIn}</p>
        {narrative && <p>{narrative}</p>}
        {/* While awaiting entrants the timeline's hint already says this. */}
        {!awaiting && (
          <p>
            <span className="sr-stage-k">What the platform needs from you:</span> {asked}
          </p>
        )}
      </div>

      {materialisation.status === 'awaiting-entrants' ? (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
            {materialisation.reason}
          </div>
          <div style={{ marginTop: 10 }}>
            <Btn tone="teal" size="sm" onClick={onConfirm}>
              Confirm entrants
            </Btn>
          </div>
        </>
      ) : (
        <>
          {/* Why it doesn't fit. `g.plan.summary` below covers a block overrun, but a
              group too small to play anyone plans zero rounds — which "fits" any block —
              so without this the operator gets a bare "Doesn't fit" pill and no reason. */}
          {!fits && <div style={{ ...ERR, marginTop: 4 }}>{materialisation.summary}</div>}
          {materialisation.status === 'ready' && materialisation.crossPoolFallback && (
            <div style={{ ...HINT, color: 'var(--coral)', marginTop: 4 }}>
              {materialisation.crossPoolFallback}
            </div>
          )}
          {drift && (drift.missing > 0 || drift.departed > 0) && (
            <div style={{ ...HINT, color: 'var(--coral)', marginTop: 4 }}>
              {[
                drift.missing > 0 &&
                  `${drift.missing} registered side${drift.missing === 1 ? ' is' : 's are'} in no group`,
                drift.departed > 0 &&
                  `${drift.departed} side${drift.departed === 1 ? '' : 's'} in a group ${drift.departed === 1 ? 'is' : 'are'} no longer registered`,
              ]
                .filter(Boolean)
                .join(' · ')}{' '}
              — edit the entrants to bring this stage into line.
            </div>
          )}
          <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
            {materialisation.groups.map((g) => {
              const linked = g.id ? linkedFor(g.id) : undefined;
              return (
                <div key={g.id} style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
                  <strong style={{ color: 'var(--ink)' }}>{g.label}</strong> · {g.entrants.length}{' '}
                  sides · {g.fixtures.length} fixture{g.fixtures.length === 1 ? '' : 's'}
                  {g.plan.dates.length > 0 && (
                    <>
                      {' '}
                      · {formatIsoDate(g.plan.dates[0])} →{' '}
                      {formatIsoDate(g.plan.dates[g.plan.dates.length - 1])}
                    </>
                  )}
                  {linked && (
                    <>
                      {' '}
                      ·{' '}
                      <Pill tone={linked.released ? 'teal' : 'muted'}>
                        {linked.released ? 'Released' : 'Draft'}
                      </Pill>
                    </>
                  )}
                  {!g.plan.fits && <div style={ERR}>{g.plan.summary}</div>}
                </div>
              );
            })}
          </div>
          {stale && (
            <p style={{ ...HINT, color: 'var(--coral)' }}>
              {staleEntrants || diverged
                ? 'The entrants or pairing changed after these fixtures were generated'
                : staleSchedule
                  ? 'The structure’s schedule for this stage changed after these fixtures were generated'
                  : 'The stage this one follows now runs into these fixtures, so they no longer start after it'}{' '}
              — regenerate to bring the series into line.
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
            {/* A GENERATED stage still offers Regenerate when its fixtures have drifted
                from the series they produced — otherwise an upstream change leaves the
                card showing one bracket and the clubs holding another, with no way back.
                The released-schedule confirmation covers the danger. */}
            {(!generated || needsRegen) && (
              <Btn tone="teal" size="sm" onClick={requestGenerate} disabled={!fits || busy}>
                {busy
                  ? 'Generating…'
                  : // A by-hand stage generates nothing by design, so "Generate 0
                    // fixtures" reads as a bug rather than "create the empty series to
                    // enter fixtures into". The preview rail already words this properly.
                    stage.format.kind === 'manual'
                    ? `${stale ? 'Rebuild' : 'Create'} the series to enter fixtures`
                    : `${stale ? 'Regenerate' : 'Generate'} ${materialisation.totalFixtures} fixtures`}
              </Btn>
            )}
            <Btn tone="ghost" size="sm" onClick={onConfirm}>
              {generated ? 'Change entrants' : 'Edit entrants'}
            </Btn>
            {stale && (
              <HelpLink topic="what-regenerate-destroys">What regenerating replaces</HelpLink>
            )}
          </div>
          {generated && (
            <p style={HINT}>
              Fixtures live as {materialisation.groups.length} series — approve and release them
              from the Fixtures list.
            </p>
          )}
        </>
      )}

      {(() => {
        // The last CONFIRMATION — a rebase appends its own entry (`event: 'rebase'`), and
        // reporting that as "confirmed by … (overrode the suggestion)" would misstate who
        // decided the entrants.
        const last = [...(stageRun?.audit ?? [])].reverse().find((e) => !e.event);
        // `by`/`at` are stamped server-side, so both are blank on the optimistic entry
        // this client just pushed — showing "confirmed by  on " until the round trip
        // lands is worse than showing nothing.
        if (!last?.by || !last.at) return null;
        return (
          <p style={{ ...HINT, marginTop: 10 }}>
            {/* An INSTANT, so the local calendar day — slicing to its UTC day would
                report a 01:00 SAST confirmation as the day before. */}
            Entrants confirmed by {last.by} on {formatStampDay(last.at)}
            {last.accepted ? ' (accepted the suggestion)' : ' (overrode the suggestion)'}
          </p>
        );
      })()}

      {confirmRegen && (
        <Modal
          eyebrow="Fixtures · Season"
          title="Regenerate a released schedule?"
          onClose={() => setConfirmRegen(false)}
        >
          <p style={{ fontSize: 13, lineHeight: 1.6, margin: '0 0 10px' }}>
            {releasedLinked.length === 1
              ? `“${releasedLinked[0].name}” has been RELEASED`
              : `${releasedLinked.length} of this stage's series have been RELEASED`}{' '}
            — clubs and players have already been sent those fixtures. Regenerating replaces them
            with {totalFixtures} new ones and there is no undo.
          </p>
          <p style={{ margin: '0 0 12px' }}>
            <HelpLink topic="what-regenerate-destroys">What regenerating replaces</HelpLink>
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn tone="outline" size="sm" onClick={() => setConfirmRegen(false)}>
              Cancel
            </Btn>
            {/* `ink`, not `coral` — there is no .btn-coral rule, so the tone rendered
                with browser-default chrome next to a properly styled Cancel. The most
                dangerous button in the feature was the least visually weighted. */}
            <Btn
              tone="ink"
              size="sm"
              onClick={() => {
                setConfirmRegen(false);
                onGenerate();
              }}
            >
              Replace the fixtures
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ─── Adopting a newer structure version ─── */

interface RebaseOutcome {
  /** From the server — e.g. a `derivedFrom.fromStage` that no longer resolves. */
  warnings: string[];
  regenerated: string[];
  /** Regenerated, but the generate came back with a caveat the admin must act on. */
  warned: Array<{ name: string; warnings: string[] }>;
  /** Opted in, but not generatable after the rebase (awaiting entrants / doesn't fit). */
  skipped: string[];
  /** Not regenerated because something went wrong; `reason` when we know it. */
  failed: Array<{ name: string; reason?: string }>;
}

/** What adopting the live structure would do to one stage of this season. */
interface StageChange {
  id: string;
  name: string;
  kind: 'unchanged' | 'changed' | 'added' | 'removed';
  before?: string;
  after?: string;
  /** Which parts of the spec moved — entrants, format, schedule, or just the wording. */
  parts: string[];
  consequence: string;
  /** Every linked series is a draft, and the change moves fixtures ⇒ offer auto-regen. */
  regenEligible: boolean;
}

/**
 * Diff the run's frozen structure against the live one, stage by stage, with the
 * consequence the rebase route's reconciliation will have for each. Mirrors that route's
 * rules (entrant spec or group labels ⇒ back to confirmation; schedule ⇒ marked stale;
 * format ⇒ override cleared) so what the admin reviews is what the server will do.
 */
function stageChanges(
  run: SeasonRun,
  live: CompetitionStructure,
  seriesOf: (specId: string) => Series[],
): StageChange[] {
  const old = new Map(run.structureSnapshot.stages.map((s) => [s.id, s]));
  const liveIds = new Set(live.stages.map((s) => s.id));
  const cal = run.calendarSnapshot;
  const changes: StageChange[] = live.stages.map((next) => {
    const prev = old.get(next.id);
    if (!prev)
      return {
        id: next.id,
        name: next.name,
        kind: 'added',
        after: describeStage(next, cal),
        parts: [],
        consequence: 'New stage — it waits for its entrants like any other.',
        regenEligible: false,
      };
    if (stableStringify(prev) === stableStringify(next))
      return {
        id: next.id,
        name: next.name,
        kind: 'unchanged',
        parts: [],
        consequence: 'No change.',
        regenEligible: false,
      };
    const entrants =
      stableStringify(prev.entrants) !== stableStringify(next.entrants) ||
      stableStringify(prev.groupLabels) !== stableStringify(next.groupLabels);
    const format = stableStringify(prev.format) !== stableStringify(next.format);
    const schedule = stableStringify(scheduleShape(prev)) !== stableStringify(scheduleShape(next));
    const parts = [
      entrants && 'entrants',
      format && 'format',
      schedule && 'schedule',
      !entrants && !format && !schedule && 'wording',
    ].filter((p): p is string => !!p);
    const series = seriesOf(next.id);
    const released = series.some((s) => s.released);
    let consequence: string;
    let regenEligible = false;
    if (entrants) {
      consequence = `Entrants go back to confirmation, pre-filled from the current groups.${
        released ? ' Its series are released — you’ll confirm before fixtures are replaced.' : ''
      }`;
    } else if (!series.length || (!format && !schedule)) {
      consequence = 'Adopts the new version.';
    } else if (released) {
      consequence = 'Released — you’ll confirm before fixtures are replaced.';
    } else {
      consequence = 'Drafts will be regenerated.';
      regenEligible = true;
    }
    return {
      id: next.id,
      name: next.name,
      kind: 'changed',
      before: describeStage(prev, cal),
      after: describeStage(next, cal),
      parts,
      consequence,
      regenEligible,
    };
  });
  for (const prev of run.structureSnapshot.stages) {
    if (liveIds.has(prev.id)) continue;
    changes.push({
      id: prev.id,
      name: prev.name,
      kind: 'removed',
      before: describeStage(prev, cal),
      parts: [],
      consequence: seriesOf(prev.id).length
        ? 'Removed — its tracking is dropped; the series it generated stay (see below).'
        : 'Removed.',
      regenEligible: false,
    });
  }
  return changes;
}

function StructureReviewModal({
  run,
  live,
  seriesOf,
  canApply,
  onApply,
  onClose,
}: {
  run: SeasonRun;
  live: CompetitionStructure;
  seriesOf: (specId: string) => Series[];
  canApply: boolean;
  onApply: (regenIds: string[]) => Promise<RebaseOutcome>;
  onClose: () => void;
}) {
  // Frozen when the modal opens: once applied, `run` re-renders onto the new snapshot and
  // a live diff would collapse to "No change" under the outcome the admin is reading.
  const [changes] = useState(() => stageChanges(run, live, (id) => seriesOf(id)));
  const [fromVersion] = useState(run.structureSnapshot.version);
  const [optIn, setOptIn] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [outcome, setOutcome] = useState<RebaseOutcome | null>(null);
  const regenIds = changes.filter((c) => c.regenEligible && optIn[c.id] !== false).map((c) => c.id);

  async function apply() {
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      setOutcome(await onApply(regenIds));
    } catch (e) {
      // Shown inline even when the toast has fired: the admin is reading this modal, and
      // the line says which thing moved (the structure, or the season) and what to do.
      setErr(seasonRunErrorMessage(e, 'Could not apply the structure — try again'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      eyebrow="Fixtures · Season"
      maxWidth={900}
      title={
        <>
          Review changes · <em>{live.name}</em>
        </>
      }
      onClose={onClose}
    >
      <p style={{ fontSize: 13, lineHeight: 1.6, margin: '0 0 12px' }}>
        This season runs v{fromVersion}; the structure is now v{live.version}. Applying it changes
        how this season&apos;s stages are set up — the fixtures only change where you regenerate
        them. <HelpLink topic="structure-versions-and-rebase" />
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {changes.map((c) => (
          <div
            key={c.id}
            style={{
              border: '1px solid var(--line)',
              borderRadius: 8,
              padding: '10px 12px',
              fontSize: 12.5,
              lineHeight: 1.55,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong style={{ color: 'var(--ink)' }}>{c.name}</strong>
              <Pill
                tone={c.kind === 'unchanged' ? 'muted' : c.kind === 'removed' ? 'coral' : 'teal'}
              >
                {c.kind === 'unchanged'
                  ? 'Unchanged'
                  : c.kind === 'added'
                    ? 'Added'
                    : c.kind === 'removed'
                      ? 'Removed'
                      : `Changed · ${c.parts.join(', ')}`}
              </Pill>
            </div>
            {c.kind === 'changed' && c.before !== c.after && (
              <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                <div>Was: {c.before}</div>
                <div>Now: {c.after}</div>
              </div>
            )}
            {c.kind === 'added' && (
              <div style={{ color: 'var(--muted)', marginTop: 4 }}>{c.after}</div>
            )}
            <div style={{ marginTop: 4 }}>{c.consequence}</div>
            {c.regenEligible && (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={optIn[c.id] !== false}
                  disabled={busy || !!outcome}
                  onChange={(e) => setOptIn((o) => ({ ...o, [c.id]: e.target.checked }))}
                />
                Regenerate {c.name}&apos;s draft fixtures after applying
              </label>
            )}
          </div>
        ))}
      </div>

      {changes.some((c) => c.regenEligible) && (
        <p style={HINT}>
          Regenerating rebuilds a stage&apos;s fixtures from scratch — allocated venues and any
          dates you changed by hand are lost. Untick a stage to keep its drafts and regenerate it
          yourself later.
        </p>
      )}
      <p style={HINT}>
        Series from a stage or group that no longer exists — including groups cleared because a
        stage&apos;s entrants changed — are not deleted. They keep occupying their grounds on their
        dates in the venue-clash check, so releasing their replacements can be blocked until you
        delete the old series from the fixtures list on this page.
      </p>

      {outcome && (
        <div
          role="status"
          style={{
            border: '1px solid var(--line)',
            borderRadius: 8,
            padding: '10px 12px',
            marginTop: 12,
            fontSize: 12.5,
            lineHeight: 1.6,
          }}
        >
          <strong>Structure v{live.version} applied.</strong>
          {outcome.regenerated.length > 0 && (
            <div>Regenerated: {outcome.regenerated.join(', ')}.</div>
          )}
          {outcome.warned.map((w) => (
            <div key={w.name} style={{ color: 'var(--coral)' }}>
              Regenerated {w.name}, with a warning: {w.warnings.join(' ')}
            </div>
          ))}
          {outcome.skipped.length > 0 && (
            <div>
              Not regenerated — {outcome.skipped.join(', ')} can&apos;t generate as it stands; its
              card says why.
            </div>
          )}
          {outcome.failed.length > 0 && (
            <div style={{ color: 'var(--coral)' }}>
              Couldn&apos;t regenerate {outcome.failed.map((f) => f.name).join(', ')} — try again
              from its card.
              {outcome.failed
                .filter((f) => f.reason)
                .map((f) => (
                  <div key={f.name}>
                    {f.name}: {f.reason}
                  </div>
                ))}
            </div>
          )}
          {outcome.warnings.map((w, i) => (
            <div key={i} style={{ color: 'var(--coral)' }}>
              {w}
            </div>
          ))}
        </div>
      )}
      {err && <div style={ERR}>{err}</div>}
      {!canApply && !outcome && (
        <p style={ERR}>Applying a structure isn&apos;t available from here.</p>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        {outcome ? (
          <Btn tone="teal" size="sm" onClick={onClose}>
            Done
          </Btn>
        ) : (
          <>
            <Btn tone="outline" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Btn>
            <Btn tone="teal" size="sm" onClick={apply} disabled={busy || !canApply}>
              {busy ? 'Applying…' : `Apply structure v${live.version}`}
            </Btn>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ─── Season run view ─── */

export function SeasonRunsPanel({
  clubs,
  allLeagues,
  allSeries,
  runs,
  configFailed = false,
  onOpenLauncher,
  onPatchRun,
  onGenerate,
  onDeleteRun,
  structures = [],
  onRebaseRun,
  onFetchRun,
}: {
  clubs: Club[];
  allLeagues: League[];
  allSeries: Series[];
  runs: SeasonRun[];
  /**
   * The LIVE structures from tenant config. A run plays its frozen snapshot; comparing
   * against these is how the panel notices the operator has since published a newer
   * version and offers to adopt it. Absent ⇒ no banner (nothing to compare against).
   */
  structures?: CompetitionStructure[];
  /** POST /season-runs/:id/rebase. Absent ⇒ the banner explains but can't apply. */
  onRebaseRun?: (
    id: string,
    body: { structureVersion: number; version: number },
  ) => Promise<SeasonRun & { warnings?: string[] }>;
  /** A fresh read of one run — the rebase flow refetches between stage regenerations. */
  onFetchRun?: (id: string) => Promise<SeasonRun | undefined>;
  /**
   * The structures or season-runs fetch failed. Without this a loading failure renders as
   * "No season running" beside a Start CTA whose duplicate guard is checking an empty
   * list, and StartSeasonForm reports "that competition points at a structure that no
   * longer exists" about a structure that is perfectly fine.
   */
  configFailed?: boolean;
  /** Opens the shared "Generate fixtures" launcher — this panel no longer hosts its own
   *  Start-season modal, so both the top action and the empty-state CTA route through it. */
  onOpenLauncher: () => void;
  onPatchRun: (id: string, patch: Partial<SeasonRun>) => Promise<void>;
  /**
   * Generate one stage on the server (ADR 0014). Resolves with any caveats the server
   * attached to a successful generate (e.g. a pool pairing drawn as a seeded bracket).
   */
  onGenerate: (run: SeasonRun, stage: StageSpec) => Promise<{ warnings?: string[] } | undefined>;
  onDeleteRun: (id: string) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ run: SeasonRun; stage: StageSpec } | null>(null);
  const [busyStage, setBusyStage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The live structure under review, captured when the modal opens — once applied, the
  // refetched run no longer shows a skew, and the outcome must stay on screen regardless.
  const [reviewing, setReviewing] = useState<CompetitionStructure | null>(null);

  const active = runs.find((r) => r.id === activeId) ?? runs[0];
  const seriesById = (id: string) => allSeries.find((s) => s.id === id);
  /** Every series a run generated for one stage, by the series' own back-reference. */
  const seriesOfStage = (runId: string, specId: string) =>
    allSeries.filter((s) => s.seasonRunId === runId && s.stageSpecId === specId);
  // The operator has published a newer version of the structure this season froze.
  // Newer only: an older live version (a restore?) is not something to "adopt".
  const liveStructure = active
    ? structures.find((s) => s.id === active.structureSnapshot.id)
    : undefined;
  const skew =
    active && liveStructure && liveStructure.version > active.structureSnapshot.version
      ? liveStructure
      : undefined;

  const runContext = useMemo(() => {
    if (!active) return null;
    const league = findByKey(allLeagues, active.leagueKey) as League | undefined;
    const competition = league?.competitions?.find((c) => c.id === active.competitionId);
    /*
     * `excludeTeamIds` is read live rather than snapshotted: it only feeds the prefill for
     * stages nobody has confirmed yet, and a side excluded mid-season (a withdrawal) should
     * stop being offered. Stages already confirmed keep their stored entrants either way.
     *
     * The affiliation gate works the same way: an unaffiliated club's sides are not in the
     * derived pool, but the confirm form lists them with "Include anyway", and a side the
     * admin included stays in its confirmed group.
     */
    const { participants, unaffiliated } = leagueParticipantsWithStatus(
      clubs,
      active.leagueKey,
      competition?.excludeTeamIds,
      affiliationSubmitted,
    );
    const structure: CompetitionStructure = active.structureSnapshot;
    const calendar: SeasonCalendar = active.calendarSnapshot;
    // `stages` are the EFFECTIVE specs (pairing overrides applied), index-aligned with
    // `structure.stages` and `materialisations`.
    const { stages, materialisations } = materialiseRun(active, participants);
    // One sentence per stage, told from the run's own frozen structure and calendar.
    const narratives = describeStructure(structure, calendar, participants.length);
    return {
      league,
      competition,
      participants,
      unaffiliated,
      structure,
      calendar,
      stages,
      materialisations,
      narratives,
    };
  }, [active, allLeagues, clubs]);

  /**
   * Adopt the live structure, then regenerate the draft stages the admin opted in to.
   *
   * ONE STAGE AT A TIME, with a fresh read of the run before each. `onGenerate` patches
   * the run with the version it is handed, so a loop over the snapshot the rebase
   * returned would 409 on the second stage and leave the season half-regenerated. Each
   * stage is also re-materialised from that fresh run — the one on screen still describes
   * the OLD structure until the refetch lands.
   */
  async function applyRebase(
    run: SeasonRun,
    live: CompetitionStructure,
    regenIds: string[],
  ): Promise<RebaseOutcome> {
    if (!onRebaseRun) throw new Error('Applying a structure is not available here');
    const { warnings = [], ...rebased } = await onRebaseRun(run.id, {
      structureVersion: live.version,
      version: run.version,
    });
    const outcome: RebaseOutcome = {
      warnings,
      regenerated: [],
      warned: [],
      skipped: [],
      failed: [],
    };
    const participants = runContext?.participants ?? [];
    const liveName = (id: string) => live.stages.find((s) => s.id === id)?.name ?? id;
    let fresh: SeasonRun | undefined = rebased as SeasonRun;
    for (const [k, id] of regenIds.entries()) {
      if (k > 0) {
        try {
          fresh = onFetchRun ? await onFetchRun(run.id) : undefined;
        } catch (e) {
          outcome.failed.push({
            name: liveName(id),
            reason: e instanceof Error ? e.message : String(e),
          });
          // Signed out: every later fetch fails the same way. Stop, and say which stages
          // were never tried rather than leaving them out of the outcome.
          if (e instanceof ApiError && e.status === 401) {
            for (const rest of regenIds.slice(k + 1))
              outcome.failed.push({
                name: liveName(rest),
                reason: 'not attempted — sign in again',
              });
            break;
          }
          continue;
        }
      }
      const index = fresh?.structureSnapshot.stages.findIndex((s) => s.id === id) ?? -1;
      const spec = fresh?.structureSnapshot.stages[index];
      const name = spec?.name ?? liveName(id);
      if (!fresh || !spec) {
        outcome.failed.push({ name });
        continue;
      }
      const m = materialiseRun(fresh, participants).materialisations[index];
      // Not generatable as it stands (waiting on entrants, or no longer fits its block):
      // left for the admin on its card, where the pill says why.
      if (m.status !== 'ready' || !m.fits) {
        outcome.skipped.push(name);
        continue;
      }
      try {
        const generated = await onGenerate(fresh, spec);
        const caveats = generated?.warnings ?? [];
        if (caveats.length) outcome.warned.push({ name, warnings: caveats });
        else outcome.regenerated.push(name);
      } catch {
        outcome.failed.push({ name });
      }
    }
    return outcome;
  }

  async function confirmEntrants(
    run: SeasonRun,
    stage: StageSpec,
    groups: string[][],
    carriedPoints: Record<string, number>,
    prefill: string[][],
    pairing?: KnockoutPairing | 'default',
  ) {
    const accepted = JSON.stringify(prefill) === JSON.stringify(groups);
    // The structure's own pairing needs no override — storing it would only pin this
    // season to a value a later structure edit might change. `pairing` undefined means
    // the form never offered the choice, so whatever is stored stands.
    const structurePairing = stage.format.kind === 'knockout' ? stage.format.pairing : undefined;
    const override =
      pairing === undefined || pairing === 'default' || pairing === structurePairing
        ? undefined
        : pairing;
    const nextStages: StageRun[] = run.structureSnapshot.stages.map((s) => {
      const existing = run.stages.find((x) => x.specId === s.id);
      if (s.id !== stage.id)
        return existing ?? { specId: s.id, status: 'awaiting-entrants', groups: [] };
      // MEMBERSHIP changed, not order — for a feeder stage. Who plays whom is what makes
      // generated fixtures stale; a pure reorder there is the admin supplying finishing
      // positions for the cross-pool draw, which the console explicitly asks them to do.
      // Comparing the ordered arrays turned that request into a coral "Needs regenerating"
      // pill and routed them into the "there is no undo" prompt for a released schedule
      // that hadn't changed at all.
      //
      // A knockout stage is the opposite: its OWN order IS the seed line the bracket is
      // built from (or the cross-pool position), so reordering it is a real change and
      // must fall back to the ordered comparison.
      const asSets = (gs: string[][]) => JSON.stringify(gs.map((g) => [...g].sort()));
      const asOrdered = (gs: string[][]) => JSON.stringify(gs);
      const compare = stage.format.kind === 'knockout' ? asOrdered : asSets;
      const changed = compare(existing?.groups?.map((g) => g.entrants) ?? []) !== compare(groups);
      return {
        specId: s.id,
        // Re-confirming DIFFERENT entrants makes the generated fixtures stale, so the
        // stage drops back to 'ready' and the Generate button returns. Leaving it
        // 'generated' stranded the admin: the card showed the new groups next to a
        // released series still holding the old ones, with no way to regenerate.
        status: existing?.status === 'generated' && !changed ? 'generated' : 'ready',
        // `labelFor` is the same fallback the materialisation and the confirm form use.
        // The old local spelling was `Group ${i + 1}`, so an unnamed stage DISPLAYED
        // "Group A" and PERSISTED "Group 1" — visible in the dev data, where a
        // human-reconfirmed stage reads "Group 1" beside CLI-written ones reading
        // "Group A". Display-only: `g.id` is the join key to `seriesId`, and series names
        // are built from the materialisation's label (main.tsx), never this one.
        groups: groups.map((entrants, i) => ({
          id: `g${i + 1}`,
          label: labelFor(stage.groupLabels, i),
          entrants,
          seriesId: existing?.groups?.[i]?.seriesId,
        })),
        ...(Object.keys(carriedPoints).length ? { carriedPoints } : {}),
        // A pairing flip is NOT an entrant change, so it leaves `status` alone: the
        // stage's materialisation now carries the new bracket, `diverged` sees it differ
        // from the generated series, and the card says "Needs regenerating".
        ...(pairing === undefined
          ? existing?.pairingOverride
            ? { pairingOverride: existing.pairingOverride }
            : {}
          : override
            ? { pairingOverride: override }
            : {}),
        // Re-confirming entrants is not regenerating — a rebase's schedule marker stays
        // until the fixtures are actually rebuilt (main.tsx clears it there).
        ...(existing?.staleSchedule ? { staleSchedule: true } : {}),
        // `by` and `at` are OVERWRITTEN server-side from the authenticated caller — a
        // client-supplied actor is worthless as a governance record. Only `prefill` and
        // `accepted` are genuinely ours to report: the server never saw the suggestion.
        // `pairing` is the bracket the union chose here, recorded whenever it was asked.
        audit: [
          ...(existing?.audit ?? []),
          {
            at: '',
            by: '',
            prefill,
            accepted,
            ...(pairing !== undefined
              ? {
                  pairing: pairing === 'default' ? (structurePairing ?? 'default') : pairing,
                }
              : {}),
          },
        ],
      };
    });
    // The version comes from the CURRENT run in props, not the one captured when the
    // modal opened. On a 409 the modal stays open (right — the admin's work is still on
    // screen), but resending the stale version made every retry fail identically, with
    // closing and reopening as the only undiscoverable fix.
    const current = runs.find((r) => r.id === run.id) ?? run;
    await onPatchRun(run.id, { stages: nextStages, version: current.version });
    setConfirming(null);
  }

  if (runs.length === 0) {
    return (
      <>
        <Card
          title="Seasons"
          sub="Run a league's competition through its stages — confirm who plays in each group, then generate that stage's fixtures."
        >
          {/* A failed fetch is not "no season" — and offering Start here would let an
              admin begin a second run of a season that already exists, because the
              duplicate guard is checking a list that never loaded. */}
          {configFailed ? (
            <EmptyState
              icon={Icon.Shield}
              title="Couldn’t load the season setup"
              sub="This is a loading problem, not an empty season list. Refresh before starting anything — any season already running is safely stored."
            />
          ) : (
            <EmptyState
              icon={Icon.Shield}
              title="No season running"
              sub="Start a season to work through a league's competition stage by stage."
              action={
                <>
                  <div className="sr-empty-hsw">
                    <HowSeasonsWork compact />
                  </div>
                  <Btn tone="teal" icon={Icon.Plus} onClick={onOpenLauncher}>
                    Start a season
                  </Btn>
                </>
              }
            />
          )}
        </Card>
      </>
    );
  }

  // Computed once rather than twice (`ranked` and `rankedReason` below both needed it) —
  // the two calls always agreed since they share the exact same arguments, so the second
  // was pure waste, not a second opinion.
  const confirmingFeedsCrossPool =
    !!confirming && feedsPoolKnockout(confirming.stage, runContext?.stages ?? []);
  // The confirming stage as this season plays it (its pairing override applied).
  const confirmingEffective =
    confirming && runContext
      ? runContext.stages.find((s) => s.id === confirming.stage.id)
      : undefined;
  /*
   * Offer the semi-final pairing choice on a knockout fed by pools: one whose structure
   * already names a pool pairing, or a seeded one whose source stage was confirmed as two
   * or more groups (the union may still want those drawn by group this season).
   */
  const confirmingPairing = (() => {
    if (!confirming || !runContext) return undefined;
    const spec = confirming.stage;
    const format = spec.format;
    if (format.kind !== 'knockout') return undefined;
    const source = crossPoolSourceStage(spec, runContext.structure.stages);
    const pools = source
      ? (confirming.run.stages.find((s) => s.specId === source.id)?.groups.length ?? 0)
      : 0;
    if (!isPoolKnockout(format) && pools < 2) return undefined;
    return {
      structureDefault: format.pairing,
      override: confirming.run.stages.find((s) => s.specId === spec.id)?.pairingOverride,
      run: confirming.run,
      stages: runContext.structure.stages,
    };
  })();

  return (
    <>
      <Card
        title="Seasons"
        sub="Each stage confirms who plays, then generates its fixtures. A stage whose teams depend on earlier results waits for you."
        action={
          // Outline, not filled: with a season on screen the stage cards' own buttons are
          // the work, and a page has one filled button per surface.
          <Btn tone="outline" size="sm" icon={Icon.Plus} onClick={onOpenLauncher}>
            Start a season
          </Btn>
        }
      >
        {runs.length > 1 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
            {runs.map((r) => {
              const lg = findByKey(allLeagues, r.leagueKey) as League | undefined;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setActiveId(r.id)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 999,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    border: '1px solid var(--line)',
                    background:
                      r.id === active?.id ? 'var(--brand-primary, #16332B)' : 'var(--paper)',
                    color: r.id === active?.id ? '#fff' : 'var(--muted)',
                  }}
                >
                  {lg?.label ?? r.leagueKey} · {r.seasonLabel}
                </button>
              );
            })}
          </div>
        )}

        {active && runContext && (
          <>
            <div
              style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.6 }}
            >
              <strong style={{ color: 'var(--ink)' }}>
                {runContext.league?.label ?? active.leagueKey} ·{' '}
                {runContext.competition?.label ?? ''}
              </strong>{' '}
              · {active.seasonLabel} · {runContext.structure.name} (v{runContext.structure.version})
              ·{' '}
              {registeredSidesLabel(runContext.participants.length, runContext.unaffiliated.length)}{' '}
              registered
            </div>

            {skew && (
              <div
                style={{
                  border: '1px solid var(--line)',
                  borderLeft: '3px solid var(--accent, #C9A227)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  marginBottom: 12,
                  fontSize: 13,
                  lineHeight: 1.55,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ flex: 1, minWidth: 220 }}>
                  This season runs structure v{active.structureSnapshot.version}; the template is
                  now v{skew.version}. <HelpLink topic="structure-versions-and-rebase" />
                </span>
                <Btn tone="outline" size="sm" onClick={() => setReviewing(skew)}>
                  Review changes
                </Btn>
              </div>
            )}

            {runContext.structure.stages.map((spec, i) => {
              // The card shows the EFFECTIVE stage (pairing override applied), so its
              // bracket, staleness and button agree with what generation will build.
              const stage = runContext.stages[i];
              const feeder = chainFeeder(stage, runContext.stages);
              return (
                <StageCard
                  key={spec.id}
                  stage={stage}
                  index={i}
                  stageRun={active.stages.find((s) => s.specId === spec.id)}
                  materialisation={runContext.materialisations[i]}
                  seriesById={seriesById}
                  stageSeries={seriesOfStage(active.id, spec.id)}
                  feederSeries={feeder ? seriesOfStage(active.id, feeder.id) : undefined}
                  registered={runContext.participants.map((p) => p.teamId)}
                  heldBack={runContext.unaffiliated.map((p) => p.teamId)}
                  calendar={runContext.calendar}
                  narrative={runContext.narratives[i]}
                  busy={busyStage === spec.id}
                  onConfirm={() => setConfirming({ run: active, stage: spec })}
                  onGenerate={async () => {
                    const m = runContext.materialisations[i];
                    // `fits` covers the empty-group case (see materialiseStage); re-check
                    // it here so a stale render can't push a dateless series through.
                    if (m.status !== 'ready' || !m.fits) return;
                    setBusyStage(spec.id);
                    try {
                      // withToast in the caller has already surfaced the failure; swallow
                      // the rejection here so it doesn't reach the console as unhandled.
                      await onGenerate(active, spec).catch(() => {});
                    } finally {
                      setBusyStage(null);
                    }
                  }}
                />
              );
            })}

            <div style={{ marginTop: 12 }}>
              {/* Confirmed, like every other delete in the console. This removes every
                  stage's confirmed entrants, the carried-points handover and the whole
                  audit trail — the governance record relegation rides on. A ghost button
                  with an explanatory note UNDER it read as information, not a warning. */}
              <Btn tone="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
                Delete this season
              </Btn>
              <p style={HINT}>
                Fixtures already generated are kept — deleting a season only removes the
                stage-by-stage tracking.
              </p>
            </div>
          </>
        )}
      </Card>

      {confirmDelete && active && (
        <Modal
          eyebrow="Fixtures · Season"
          title="Delete this season?"
          onClose={() => setConfirmDelete(false)}
        >
          <p style={{ fontSize: 13, lineHeight: 1.6, margin: '0 0 10px' }}>
            This removes <strong>{active.seasonLabel}</strong> and everything tracked against it:
            each stage&apos;s confirmed entrants, any carried points, and the record of who
            confirmed what. That record is what relegation and the points carry rest on, and it
            cannot be recovered.
          </p>
          <p style={{ ...HINT, marginTop: 0 }}>
            The fixtures themselves are kept — the series stay exactly as they are, they just stop
            being grouped under this season.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
            <Btn tone="outline" size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Btn>
            <Btn
              tone="ink"
              size="sm"
              onClick={() => {
                setConfirmDelete(false);
                onDeleteRun(active.id);
              }}
            >
              Delete the season
            </Btn>
          </div>
        </Modal>
      )}

      {reviewing && active && (
        <StructureReviewModal
          run={active}
          live={reviewing}
          seriesOf={(specId) => seriesOfStage(active.id, specId)}
          canApply={!!onRebaseRun}
          onApply={(regenIds) => applyRebase(active, reviewing, regenIds)}
          onClose={() => setReviewing(null)}
        />
      )}

      {confirming && runContext && (
        <Modal
          eyebrow="Fixtures · Season"
          maxWidth={900}
          title={
            <>
              Confirm entrants · <em>{confirming.stage.name}</em>
            </>
          }
          onClose={() => setConfirming(null)}
        >
          <EntrantConfirmForm
            stage={confirming.stage}
            stageRun={confirming.run.stages.find((s) => s.specId === confirming.stage.id)}
            materialisation={
              runContext.materialisations[
                runContext.structure.stages.findIndex((s) => s.id === confirming.stage.id)
              ]
            }
            participants={runContext.participants}
            unaffiliated={runContext.unaffiliated}
            // Ask for finishing positions when the stage AFTER this one draws a
            // cross-pool bracket from it, OR when this stage is itself a seeded
            // knockout — there the position IS the seed line, not a downstream draw.
            // Read off the EFFECTIVE stage: a pool knockout this season overrode to
            // "seeded" takes its seed line from these positions too.
            ranked={
              confirmingFeedsCrossPool ||
              (confirmingEffective?.format.kind === 'knockout' &&
                confirmingEffective.format.pairing === 'seeded')
            }
            rankedReason={confirmingFeedsCrossPool ? 'cross-pool' : 'seeding'}
            pairing={confirmingPairing}
            onCancel={() => setConfirming(null)}
            onConfirm={(groups, carriedPoints, pairing) => {
              const m =
                runContext.materialisations[
                  runContext.structure.stages.findIndex((s) => s.id === confirming.stage.id)
                ];
              // The SAME expression the form shows as its suggestion. Reading only the
              // `awaiting-entrants` prefill recorded `prefill: []` and `accepted: false`
              // for every confirmation on a resolved stage — including every RE-confirm
              // of a manual one — so the audit trail said "overrode the suggestion"
              // about a suggestion it never stored. That trail is the whole reason this
              // flow asks a human.
              const prefill =
                m.status === 'awaiting-entrants'
                  ? m.prefill.map((g) => g.entrants)
                  : m.groups.map((g) => g.entrants);
              return confirmEntrants(
                confirming.run,
                confirming.stage,
                groups,
                carriedPoints,
                prefill,
                pairing,
              );
            }}
          />
        </Modal>
      )}
    </>
  );
}

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
import { useMemo, useState, useId, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  BoundedNumber,
  Btn,
  Card,
  Choice,
  EmptyState,
  Icon,
  InfoDot,
  Pill,
  useEscapeClose,
} from './atoms';
import { ApiError } from './api';
import {
  CADENCE_LABELS,
  T20_SLOTS,
  WEEKDAY_LABELS,
  cadenceFromLabel,
  findBlock,
  formatIsoDate,
  todayIso,
} from './competition/calendar';
import { describeEntrants, groupSizes, labelFor } from './competition/entrants';
import { formatStampDay } from './dates';
import {
  crossPoolQualifiersFor,
  feedsCrossPool,
  materialiseStage,
  type StageMaterialisation,
} from './competition/structure';
import { DEFAULT_SERIES_OVERS, SERIES_TYPES } from './competition/formats';
import { findByKey, leagueParticipants } from './leagues';
import { currentSeasonLabel } from './data';
import type {
  Cadence,
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
  TimeSlot,
  Weekday,
} from './types';

type Toast = (m: string, t?: string) => void;

const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '6px 0 0' };

function Modal({
  title,
  eyebrow = 'Fixtures · Season',
  wide,
  onClose,
  children,
}: {
  title: ReactNode;
  eyebrow?: string;
  wide?: boolean;
  onClose: () => void;
  children?: ReactNode;
}) {
  useEscapeClose(onClose);
  // A dialog with no role is, to assistive tech, an ordinary div: nothing announces that
  // a modal opened, nothing scopes the reading order to it, and Escape is the only thing
  // that behaves. `aria-labelledby` points at the visible heading so it gets a name too.
  const titleId = useId();
  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="task-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={wide ? { maxWidth: 900 } : undefined}
      >
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">{eyebrow}</div>
            <div className="task-modal-head-title" id={titleId}>
              {title}
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The confirmed groups of the stage a standings-dependent stage draws from.
 *
 * `undefined` when the rule names no source, the source hasn't been confirmed yet, or the
 * stage isn't standings-dependent at all — in which case the prefill falls back to the
 * registered list, which is the best that can honestly be offered.
 */
function derivedFromGroups(stage: StageSpec, run: SeasonRun): string[][] | undefined {
  const from = stage.entrants.kind === 'manual' ? stage.entrants.derivedFrom?.fromStage : undefined;
  if (!from) return undefined;
  const groups = run.stages.find((s) => s.specId === from)?.groups ?? [];
  return groups.length ? groups.map((g) => g.entrants) : undefined;
}

/** A league is season-capable only once the operator has bound a competition to it. */
export function seasonCapableLeagues(allLeagues: League[]): League[] {
  return (allLeagues || []).filter((l) => (l.competitions?.length ?? 0) > 0);
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
  const [competitionId, setCompetitionId] = useState(league?.competitions?.[0]?.id ?? '');
  const [seasonLabel, setSeasonLabel] = useState(currentSeasonLabel());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const competition = league?.competitions?.find((c) => c.id === competitionId);
  const structure = (config.structures ?? []).find((s) => s.id === competition?.structureId);
  const calendar = (config.calendars ?? []).find((c) => c.id === competition?.calendarId);
  const teams = league ? leagueParticipants(clubs, league.key, competition?.excludeTeamIds) : [];
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
  if (teams.length < 2) problems.push('At least two sides must be registered for this league.');
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
        setErr(e instanceof ApiError ? e.message : 'Could not start the season — try again');
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
          In the meantime, Generate fixtures still runs a flat season for any league.
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
            setCompetitionId(next?.competitions?.[0]?.id ?? '');
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
        {/* A league usually has ONE competition — a dropdown there implies a choice that
            doesn't exist. The select only appears for leagues running parallel format
            streams (e.g. a 50 Over and a T20 competition over the same clubs). */}
        {(league?.competitions ?? []).length === 1 ? (
          <div style={{ fontSize: 13.5, padding: '6px 0' }}>{league?.competitions?.[0]?.label}</div>
        ) : (
          <select
            className="field-select"
            value={competitionId}
            onChange={(e) => setCompetitionId(e.target.value)}
          >
            {(league?.competitions ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
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
        <Btn tone="outline" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/* ─── Start a flat season ───
 *
 * A league with no bound competition still needs somewhere to run its fixtures — the
 * platform used to hand it straight to the ad-hoc CreateSeriesForm, indistinguishable
 * from a one-off tournament. That conflated two different things: a LEAGUE'S season
 * (recurring, one per league per year, wants the same stage-card tracking every other
 * season gets) and a genuinely one-off series (a friendly, a cup weekend). This gives
 * the league case a SeasonRun too — synthesized as the smallest structure that's
 * honestly true of an unbound league: one stage, one group, everyone registered.
 */

/** Shares CreateSeriesForm's own defaults and Series Type options (competition/formats.ts)
 *  so a flat season's synthetic competition reads the same as the ad-hoc form's
 *  out-of-the-box series would, and stays coherent with whatever overs the admin actually
 *  sets. */
const FLAT_DEFAULT_SERIES_TYPE = SERIES_TYPES[0];

/** Sentinel `competitionId` for a flat season — parallels `AD_HOC` below, but persisted
 *  (a real SeasonRun is stored under it), so `SeasonRunsPanel` and the duplicate guard
 *  need a stable value to recognise it by. */
export const FLAT_COMPETITION_ID = '__flat__';

/** `YYYY-MM-DD` — the shape a `<input type="date">` produces, and the only shape the
 *  synthesized calendar can honestly turn into a block. A half-typed date must never
 *  reach `materialiseStage`, which has no concept of "still being typed". */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Clamp `firstRound` into a COPY of `calendar`'s block at `blockIndex`; return `calendar`
 * unchanged when `firstRound` is absent, malformed, or outside that block's date range.
 *
 * This needs no model change: the calendar this is called with is already a per-run (or
 * per-preview) frozen copy — never the shared operator calendar `config.calendars` holds
 * — so overwriting the COPY's block `start` is exactly as safe as an admin choosing a
 * different start date would have been. The planner's `every-n-weeks`/`weekdays` cadence
 * strides are computed from the block's `start`, so clamping it here is all that's needed
 * for every downstream date calculation to anchor from the new first round. Shared by
 * `buildFlatSeasonRun` and `StartFlatSeasonForm`'s live preview so both agree on the same
 * anchored calendar before submit.
 */
function withClampedBlockStart(
  calendar: SeasonCalendar,
  blockIndex: number,
  firstRound: string | undefined,
): SeasonCalendar {
  if (!firstRound || !ISO_DATE_RE.test(firstRound)) return calendar;
  const block = calendar.blocks[blockIndex];
  if (!block || firstRound < block.start || firstRound > block.end) return calendar;
  return {
    ...calendar,
    blocks: calendar.blocks.map((b, i) => (i === blockIndex ? { ...b, start: firstRound } : b)),
  };
}

/**
 * Synthesize the smallest CompetitionStructure + SeasonCalendar that's true of a league
 * with no bound competition: one stage, everyone registered, one flat round robin. Pure
 * and deterministic (the caller supplies `id`) so it's exercised directly by tests rather
 * than only through the form that calls it.
 */
export function buildFlatSeasonRun(args: {
  id: string;
  league: League;
  seasonLabel: string;
  /** An operator calendar, snapshotted verbatim — takes priority over `custom`. */
  calendar?: SeasonCalendar;
  /** A hand-picked start/end, synthesized into a single-block calendar. Ignored when
   *  `calendar` is set. */
  custom?: { start: string; end: string };
  /** Which block of the (operator or synthesized) calendar the stage plays in. Required
   *  as an INTEGER — `validateStructures` 400s the whole season on `undefined`. */
  blockIndex?: number;
  activateFrom?: string;
  /** The admin's chosen Series Type — persisted as `flatFormat` so a later regenerate
   *  reads back the SAME choice rather than re-deriving a default. */
  seriesType: string;
  /** The admin's chosen overs — persisted alongside `seriesType` for the same reason. */
  overs: number;
  /** Cadence for the synthesized stage's schedule. Defaults to weekly when omitted. */
  cadence?: Cadence;
  /** Time slots for the synthesized stage's schedule. Omitted entirely (not an empty
   *  array) when empty/undefined — mirrors main.tsx's `...(stage.schedule.slots?.length
   *  ? { slots } : {})` idiom, so the server never receives an empty `slots` array. */
  slots?: TimeSlot[];
  /** A full ISO date anchoring the first round. Clamped into the chosen block's `start`
   *  inside the per-run calendar snapshot copy — see `withClampedBlockStart`. Ignored,
   *  never thrown, when malformed or outside the block's range. */
  firstRound?: string;
}): SeasonRun {
  const {
    id,
    league,
    seasonLabel,
    calendar,
    custom,
    blockIndex,
    activateFrom,
    seriesType,
    overs,
    cadence,
    slots,
    firstRound,
  } = args;
  const resolvedBlockIndex = blockIndex ?? 0;
  const baseCalendarSnapshot: SeasonCalendar = calendar ?? {
    id: 'cal-flat-' + league.key,
    label: seasonLabel,
    // `custom` is guaranteed by the caller whenever `calendar` is absent — the form
    // never lets dates through to here otherwise (see `datesValid` below).
    blocks: [{ id: 'b1', label: 'Season', start: custom!.start, end: custom!.end }],
  };
  // A fresh copy per run — `withClampedBlockStart` never mutates `calendar`/
  // `baseCalendarSnapshot` in place, so a shared operator calendar is untouched even
  // when this run clamps its own snapshot's block start.
  const calendarSnapshot = withClampedBlockStart(
    baseCalendarSnapshot,
    resolvedBlockIndex,
    firstRound,
  );
  const structureSnapshot: CompetitionStructure = {
    id: 'st-flat-default',
    name: 'Flat season',
    version: 1,
    stages: [
      {
        id: 'stage-1',
        // Deliberately the SEASON's name, not the league's — `generateStageSeriesInner`
        // builds each series as `${league.label} · ${stage.name}`, so this is what gives
        // a flat season's fixtures the same "Promotion League · 2026/27" naming the old
        // flat path produced.
        name: seasonLabel,
        format: { kind: 'round-robin', legs: 1 },
        entrants: { kind: 'all-registered' },
        schedule: {
          blockIndex: resolvedBlockIndex,
          cadence: cadence ?? { kind: 'weekly' },
          ...(slots?.length ? { slots } : {}),
          ...(activateFrom ? { activateFrom } : {}),
        },
      },
    ],
  };
  return {
    id,
    leagueKey: league.key,
    competitionId: FLAT_COMPETITION_ID,
    seasonLabel,
    structureSnapshot,
    calendarSnapshot,
    stages: [{ specId: 'stage-1', status: 'awaiting-entrants', groups: [] }],
    version: 1,
    flatFormat: { seriesType, overs },
  };
}

function StartFlatSeasonForm({
  clubs,
  league,
  config,
  existingRuns,
  onCreate,
  onGenerateStage,
  onClose,
  onBack,
  toast,
}: {
  clubs: Club[];
  league: League;
  config: TenantConfig;
  existingRuns: SeasonRun[];
  onCreate: (run: SeasonRun) => Promise<SeasonRun | void>;
  onGenerateStage: (
    payloads: GenerateGroupPayload[],
    run: SeasonRun,
    stage: StageSpec,
  ) => Promise<void>;
  onClose: () => void;
  onBack: () => void;
  toast: Toast;
}) {
  const calendars = config.calendars ?? [];
  const [seasonLabel, setSeasonLabel] = useState(currentSeasonLabel());
  const [calendarId, setCalendarId] = useState('');
  const [blockId, setBlockId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [activateFrom, setActivateFrom] = useState('');
  const [overs, setOvers] = useState(DEFAULT_SERIES_OVERS);
  const [seriesType, setSeriesType] = useState<string>(FLAT_DEFAULT_SERIES_TYPE);
  // Scheduling options — collapsed by default (see the toggle below). Defaults stay
  // exactly the previous behaviour when the section is never opened: weekly cadence, no
  // first-round anchor, no slots.
  const [showScheduling, setShowScheduling] = useState(false);
  const [cadence, setCadence] = useState<Cadence>({ kind: 'weekly' });
  const [firstRound, setFirstRound] = useState('');
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const trimmedLabel = seasonLabel.trim();
  const calendar = calendars.find((c) => c.id === calendarId);
  const teams = leagueParticipants(clubs, league.key);

  const customValid =
    ISO_DATE_RE.test(startDate) && ISO_DATE_RE.test(endDate) && endDate >= startDate;
  const datesValid = calendar ? true : customValid;
  const blockIndex =
    calendar && calendar.blocks.length > 1
      ? Math.max(
          0,
          calendar.blocks.findIndex((b) => b.id === blockId),
        )
      : 0;

  const duplicate = existingRuns.some(
    (r) =>
      r.leagueKey === league.key &&
      r.competitionId === FLAT_COMPETITION_ID &&
      r.seasonLabel === trimmedLabel,
  );

  // Same idiom as admin.tsx's own Scheduling options: narrow the weekday list once here
  // rather than inline in the JSX.
  const selectedDays: Weekday[] = cadence.kind === 'weekdays' ? cadence.days : [];
  // The chosen block, for bounding the "First round" date input — only meaningful once a
  // calendar (not custom dates) is picked.
  const currentBlock = calendar?.blocks[blockIndex];

  // Recomputed on every keystroke, same idiom as CreateSeriesForm's own preview rail —
  // this is what catches an overrunning block before anyone clicks Start.
  const materialisation = useMemo(() => {
    if (!datesValid) return undefined;
    const baseCalendar: SeasonCalendar = calendar ?? {
      id: 'cal-flat-preview',
      label: trimmedLabel || seasonLabel,
      blocks: [{ id: 'b1', label: 'Season', start: startDate, end: endDate }],
    };
    // The SAME clamping logic `buildFlatSeasonRun` uses at submit — so the "Ready" preview
    // line reflects the anchored first-round date rather than a slightly different
    // approximation of it.
    const previewCalendar = withClampedBlockStart(
      baseCalendar,
      blockIndex,
      calendar ? firstRound || undefined : undefined,
    );
    const stage: StageSpec = {
      id: 'stage-1',
      name: trimmedLabel || seasonLabel,
      format: { kind: 'round-robin', legs: 1 },
      entrants: { kind: 'all-registered' },
      schedule: {
        blockIndex,
        cadence,
        ...(slots.length ? { slots } : {}),
        ...(activateFrom ? { activateFrom } : {}),
      },
    };
    return materialiseStage({
      stage,
      calendar: previewCalendar,
      context: {
        registered: teams.map((t) => t.teamId),
        seedOrder: teams.map((t) => t.teamId),
      },
    });
  }, [
    datesValid,
    calendar,
    trimmedLabel,
    seasonLabel,
    startDate,
    endDate,
    blockIndex,
    activateFrom,
    cadence,
    firstRound,
    slots,
    teams,
  ]);

  const ready = materialisation?.status === 'ready';
  const fits = ready && materialisation.fits;

  const problems: string[] = [];
  if (!trimmedLabel) problems.push('Give the season a label.');
  if (teams.length < 2) problems.push('At least two sides must be registered for this league.');
  if (!datesValid)
    problems.push(
      calendar
        ? 'Pick a playing block.'
        : 'Give the season a start date and an end date, with the end on or after the start.',
    );
  if (duplicate) problems.push('A flat season with that label is already running for this league.');
  if (datesValid && materialisation && !fits) problems.push(materialisation.summary);

  async function submit() {
    if (problems.length || busy || !materialisation || materialisation.status !== 'ready') return;
    setErr('');
    setBusy(true);
    const run = buildFlatSeasonRun({
      id: 'run-' + Date.now(),
      league,
      seasonLabel: trimmedLabel,
      calendar,
      custom: calendar ? undefined : { start: startDate, end: endDate },
      blockIndex,
      activateFrom: activateFrom || undefined,
      seriesType,
      overs,
      cadence,
      slots,
      firstRound: calendar ? firstRound || undefined : undefined,
    });
    let created: SeasonRun;
    try {
      // The server stamps its own fields (createdAt, version…) onto the run it returns —
      // fall back to the locally-built one only for a host that resolves with nothing.
      created = ((await onCreate(run)) as SeasonRun | undefined) ?? run;
    } catch (e) {
      if (!(e as { alreadyToasted?: boolean })?.alreadyToasted) {
        setErr(e instanceof ApiError ? e.message : 'Could not start the season — try again');
      }
      setBusy(false);
      return;
    }
    const stage = created.structureSnapshot.stages[0];
    // Read the format back from the SAVED run, not the local `seriesType`/`overs` state —
    // `flatFormat` is the single source of truth (there is no config competition to read),
    // and this is what lets a later regenerate reproduce the admin's exact choice rather
    // than whatever this form's fields happened to hold at submit time.
    const format = created.flatFormat ?? { seriesType, overs };
    const payloads: GenerateGroupPayload[] = materialisation.groups.map((g) => ({
      run: created,
      stage,
      groupId: g.id,
      groupLabel: g.label,
      entrants: g.entrants,
      fixtures: g.fixtures,
      startDate:
        g.plan.dates[0] ??
        findBlock(created.calendarSnapshot, stage.schedule.blockIndex)?.start ??
        todayIso(),
      league,
      // `structureId`/`calendarId` are never read by `generateStageSeriesInner` (it uses
      // `run.calendarSnapshot`, not the competition record) — set to the run's own
      // synthesized ids purely to satisfy `Competition`'s shape.
      competition: {
        id: FLAT_COMPETITION_ID,
        label: format.seriesType,
        matchFormat: { overs: format.overs },
        structureId: created.structureSnapshot.id,
        calendarId: created.calendarSnapshot.id,
      },
    }));
    // The run exists either way past this point — a failed generate isn't a failed
    // start, so the modal still closes and points the admin at where to retry, rather
    // than leaving them staring at a form for a season that already saved.
    let generateFailed = false;
    try {
      await onGenerateStage(payloads, created, stage);
    } catch {
      generateFailed = true;
    }
    setBusy(false);
    onClose();
    if (generateFailed) toast('Season started — generate the fixtures from the Seasons panel');
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div
        style={{
          border: '1px solid var(--line)',
          borderLeft: '3px solid var(--brand-primary, #16332B)',
          borderRadius: 8,
          padding: '10px 12px',
          fontSize: 13,
          lineHeight: 1.55,
        }}
      >
        <strong>Flat season.</strong> {league.label} has no competition bound to it, so this season
        runs as a single flat round-robin — every registered side, one group. You can drop a side
        after creating via Edit entrants on the season. For stages, groups or promotion/relegation,
        ask your platform operator to bind a competition (operator console → Season setup, or the
        Structures card).
      </div>

      <div className="field">
        <div className="field-label">
          Season <span className="req">*</span>
        </div>
        <input
          className="field-input"
          value={seasonLabel}
          onChange={(e) => setSeasonLabel(e.target.value)}
          maxLength={80}
          placeholder="2026/27"
          style={{ maxWidth: 200 }}
        />
      </div>

      {calendars.length > 0 ? (
        <div className="field">
          <div className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            Dates <span className="req">*</span>
            <InfoDot
              title="Dates — where the season's timeline comes from"
              options={[
                {
                  label: 'A season calendar',
                  desc: 'Use one the operator set up, so this season shares its playing blocks, breaks and excluded dates. Pick the block to play in.',
                },
                {
                  label: 'Custom dates',
                  desc: 'Set a plain start and end date yourself, with no shared breaks. Best for a one-off or a league with no calendar.',
                },
              ]}
            />
          </div>
          <select
            className="field-select"
            aria-label="Dates"
            value={calendarId}
            onChange={(e) => {
              const next = calendars.find((c) => c.id === e.target.value);
              setCalendarId(e.target.value);
              // Default to the first block rather than leaving the select on an unpicked
              // placeholder — `blockIndex` already treats "no selection" as block 0, so
              // an empty value here would show a control that looked unset while behaving
              // as if it wasn't.
              setBlockId(next?.blocks[0]?.id ?? '');
              // Switching to custom dates leaves no block to anchor within — a stale
              // firstRound from a previous calendar selection would otherwise clamp
              // against the synthesized single-block calendar below instead of being
              // dropped outright.
              if (!next) setFirstRound('');
            }}
          >
            <option value="">Custom dates — pick start / end</option>
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} season ·{' '}
                {c.blocks.length
                  ? `${formatIsoDate(c.blocks[0].start)} → ${formatIsoDate(c.blocks[c.blocks.length - 1].end)}`
                  : 'no playing blocks'}
              </option>
            ))}
          </select>
          {calendar && calendar.blocks.length > 1 && (
            <div style={{ marginTop: 8 }}>
              <div className="field-label">
                Playing block <span className="req">*</span>
              </div>
              <select
                className="field-select"
                aria-label="Playing block"
                value={blockId}
                onChange={(e) => setBlockId(e.target.value)}
              >
                {calendar.blocks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label} · {formatIsoDate(b.start)} → {formatIsoDate(b.end)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {!calendar && (
            <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
              <div>
                <div className="field-label">
                  Start Date <span className="req">*</span>
                </div>
                <input
                  type="date"
                  className="field-input"
                  aria-label="Start Date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div>
                <div className="field-label">
                  End Date <span className="req">*</span>
                </div>
                <input
                  type="date"
                  className="field-input"
                  aria-label="End Date"
                  value={endDate}
                  min={startDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 12 }}>
          <div className="field">
            <div className="field-label">
              Start Date <span className="req">*</span>
            </div>
            <input
              type="date"
              className="field-input"
              aria-label="Start Date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="field">
            <div className="field-label">
              End Date <span className="req">*</span>
            </div>
            <input
              type="date"
              className="field-input"
              aria-label="End Date"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* ─── Scheduling options (collapsed by default) ───
          Cadence, first round and time slots are engine knobs with sane defaults — weekly,
          no anchor, no set times — so they live behind a toggle rather than sprouting
          inline the moment dates are picked. Same idiom as admin.tsx's own Scheduling
          options toggle (CreateSeriesForm). */}
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
          <div className="cs-row">
            <div className="cs-row-label" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              Cadence
              <InfoDot
                title="Cadence — how often rounds are played"
                options={[
                  { label: 'Weekly', desc: 'One round every week.' },
                  { label: 'Every N weeks', desc: 'One round every few weeks — set the gap.' },
                  {
                    label: 'Set days only',
                    desc: 'Only on the weekdays you pick (e.g. Sat & Sun).',
                  },
                  {
                    label: 'Spread across block',
                    desc: 'Rounds spaced evenly across the whole block.',
                  },
                ]}
              />
            </div>
            <div className="cs-row-input">
              <Choice
                value={CADENCE_LABELS[cadence.kind] || CADENCE_LABELS.weekly}
                onChange={(v) => setCadence(cadenceFromLabel(v))}
                options={Object.values(CADENCE_LABELS)}
              />
              {cadence.kind === 'weekdays' && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {WEEKDAY_LABELS.map((label, day) => {
                    const on = selectedDays.includes(day as Weekday);
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() =>
                          setCadence({
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
          {/* Only meaningful against a calendar's real block — a custom start/end pair
              IS the first round, so there is nothing to anchor within it. */}
          {calendar && (
            <div className="cs-row">
              <div className="cs-row-label">First round</div>
              <div className="cs-row-input">
                <input
                  type="date"
                  aria-label="First round"
                  value={firstRound}
                  min={currentBlock?.start}
                  max={currentBlock?.end}
                  onChange={(e) => setFirstRound(e.target.value)}
                />
                {firstRound &&
                  currentBlock &&
                  (firstRound < currentBlock.start || firstRound > currentBlock.end) && (
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                      outside {currentBlock.label} — ignored
                    </div>
                  )}
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                  Optional — leave blank to start on the first day of the block. Without it,
                  every-n-weeks cadences stride from the block&apos;s first day.
                </div>
              </div>
            </div>
          )}
          <div className="cs-row">
            <div className="cs-row-label">Time slots</div>
            <div className="cs-row-input">
              <Choice
                value={slots.length ? 'Morning & afternoon' : 'No set times'}
                onChange={(v) => setSlots(v === 'No set times' ? [] : T20_SLOTS)}
                options={['No set times', 'Morning & afternoon']}
              />
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                {slots.length
                  ? 'Fixtures in a round alternate between 08:00 and 13:30 starts.'
                  : 'Fixtures carry a date only; start times are set later.'}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="field">
        <div className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          Match format
          <InfoDot title="Match format">
            <p>
              <strong>Overs</strong> — overs per side for these matches.
            </p>
            <p>
              <strong>Series type</strong> — the format’s name (e.g. One-Day, T20). It labels the
              series; it isn’t inferred from the overs, so set it to match.
            </p>
          </InfoDot>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BoundedNumber
            ariaLabel="Overs"
            min={1}
            max={100}
            style={{ width: 80 }}
            value={overs}
            onChange={setOvers}
          />
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>overs</span>
          {/* Independent of the overs count — a select, not derived, because nothing
              here can honestly infer "One-Day" from "50 overs" (a T20 union might still
              call its 20-over game something else). Mirrors CreateSeriesForm's own
              Series Type options (admin.tsx) so the two forms don't drift. */}
          <select
            className="field-select"
            aria-label="Series Type"
            value={seriesType}
            onChange={(e) => setSeriesType(e.target.value)}
            style={{ width: 200 }}
          >
            {SERIES_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <div className="field-label">Activate from</div>
        <input
          type="date"
          className="field-input"
          aria-label="Activate from"
          value={activateFrom}
          onChange={(e) => setActivateFrom(e.target.value)}
          style={{ maxWidth: 200 }}
        />
        <p style={HINT}>
          Optional — fixtures generate now but stay hidden from clubs until this date.
        </p>
      </div>

      {materialisation && datesValid && (
        <div
          style={{
            border: '1px solid var(--line)',
            borderRadius: 8,
            padding: '10px 12px',
            fontSize: 12.5,
            lineHeight: 1.5,
            background: fits ? 'var(--paper)' : 'var(--coral-pale, #FDECEA)',
            color: fits ? 'var(--muted)' : 'var(--coral)',
          }}
        >
          <strong style={{ color: fits ? 'var(--ink)' : 'var(--coral)' }}>
            {fits ? 'Ready' : 'Does not fit'}
          </strong>{' '}
          · {materialisation.summary}
        </div>
      )}

      {problems.map((p, i) => (
        <div key={i} style={ERR}>
          {p}
        </div>
      ))}
      {err && <div style={ERR}>{err}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <Btn tone="ghost" onClick={onBack} disabled={busy}>
          Back
        </Btn>
        <Btn tone="teal" onClick={submit} disabled={!!problems.length || busy}>
          {busy ? 'Starting…' : 'Start season'}
        </Btn>
        <Btn tone="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/* ─── Generate fixtures — the single entry point, routed by league ─── */

/** The select's sentinel for "no particular league" — a hand-picked, ad-hoc series. */
const AD_HOC = '__ad-hoc__';

/**
 * One button, two engines. The admin used to choose the ENGINE first — "Start a season"
 * versus "Create series" — which only makes sense once you already know whether your
 * league has a competition bound to it. Here they choose the LEAGUE, and the console picks
 * the engine: a season-capable league swaps this same modal to `StartSeasonForm`; every
 * other real league gets `StartFlatSeasonForm` — a season too, just a synthesized flat one.
 * Only "ad-hoc" (a genuine one-off, no league at all) reaches the embedded Create-series
 * flow.
 */
export function GenerateFixturesLauncher({
  clubs,
  allLeagues,
  config,
  existingRuns,
  onCreateRun,
  onGenerateStage,
  renderSeriesForm,
  onClose,
  toast,
}: {
  clubs: Club[];
  allLeagues: League[];
  config: TenantConfig;
  existingRuns: SeasonRun[];
  onCreateRun: (run: SeasonRun) => Promise<SeasonRun | void>;
  /** Same shape as `SeasonRunsPanel`'s `onGenerate` — the flat-season form needs it too,
   *  to auto-generate its one stage's fixtures right after creating the run. */
  onGenerateStage: (
    payloads: GenerateGroupPayload[],
    run: SeasonRun,
    stage: StageSpec,
  ) => Promise<void>;
  /** Rendered in place for the ad-hoc path ONLY — a render prop, not an import, because
   *  admin.tsx (which owns CreateSeriesForm) imports FROM season-run.tsx, not the other
   *  way around. There is no league to prefill: ad-hoc means the admin picks by hand. */
  renderSeriesForm: (args: { onBack: () => void }) => ReactNode;
  onClose: () => void;
  toast: Toast;
}) {
  const capable = seasonCapableLeagues(allLeagues);
  const isCapable = (key: string) => capable.some((l) => l.key === key);
  const [leagueKey, setLeagueKey] = useState(allLeagues[0]?.key ?? AD_HOC);
  const [step, setStep] = useState<'pick' | 'season' | 'flat' | 'series'>('pick');

  if (step === 'season') {
    return (
      <Modal
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

  if (step === 'flat') {
    const league = findByKey(allLeagues, leagueKey) as League | undefined;
    // The picked league can vanish between steps — deleted in another tab, then this
    // console's own config refetch drops it from `allLeagues`. `return null` here left the
    // admin staring at a dead, uncloseable modal (the launcher's only escape hatches are
    // inside the steps it renders). Falling back to the picker is always a safe, honest
    // state: it just means "pick again".
    if (league) {
      return (
        <Modal
          title={
            <>
              Start a <em>flat season</em>
            </>
          }
          onClose={onClose}
        >
          <StartFlatSeasonForm
            clubs={clubs}
            league={league}
            config={config}
            existingRuns={existingRuns}
            onCreate={onCreateRun}
            onGenerateStage={onGenerateStage}
            onClose={onClose}
            onBack={() => setStep('pick')}
            toast={toast}
          />
        </Modal>
      );
    }
    // No league to hand the form — fall through to the pick step below rather than
    // returning null (a dead modal with no close button).
  }

  if (step === 'series') {
    return (
      <Modal
        eyebrow="Fixtures"
        title={
          <>
            Create a <em>series</em>
          </>
        }
        onClose={onClose}
      >
        {renderSeriesForm({ onBack: () => setStep('pick') })}
      </Modal>
    );
  }

  function submit() {
    if (leagueKey === AD_HOC) return setStep('series');
    setStep(isCapable(leagueKey) ? 'season' : 'flat');
  }

  return (
    <Modal eyebrow="Fixtures" title="Generate fixtures" onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        <div className="field">
          <div className="field-label">
            League <span className="req">*</span>
          </div>
          <select
            className="field-select"
            value={leagueKey}
            onChange={(e) => setLeagueKey(e.target.value)}
          >
            {/* Existing tests select by `value`, not by label text or position, so
                grouping into optgroups and dropping the "· flat/structured season" suffix
                is safe — nothing here relied on either. */}
            {allLeagues.some((l) => isCapable(l.key)) && (
              <optgroup label="Structured seasons — set up by your platform operator">
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
              <optgroup label="Flat seasons — one flat round robin until a competition is bound">
                {allLeagues
                  .filter((l) => !isCapable(l.key))
                  .map((l) => (
                    <option key={l.key} value={l.key}>
                      {l.label}
                    </option>
                  ))}
              </optgroup>
            )}
            <option value={AD_HOC}>One-off series or tournament — pick the sides by hand</option>
          </select>
          <p style={HINT}>
            A league runs flat — one round robin — until your platform operator binds a competition
            to it in the operator console (Season setup). Structured leagues follow their
            competition&apos;s stages.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <Btn tone="teal" onClick={submit}>
            Continue
          </Btn>
          <Btn tone="outline" onClick={onClose}>
            Cancel
          </Btn>
        </div>
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
  ranked,
  rankedReason,
  onConfirm,
  onCancel,
}: {
  stage: StageSpec;
  stageRun: StageRun | undefined;
  materialisation: StageMaterialisation;
  participants: Array<{ teamId: string; name: string }>;
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
  onConfirm: (groups: string[][], carriedPoints: Record<string, number>) => Promise<void>;
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

  /** The groups to seed from — the stored confirmation if there is one, else the suggestion. */
  const seedGroups = () =>
    stageRun?.groups?.length
      ? stageRun.groups.map((g) => g.entrants)
      : suggested.map((g) => g.entrants);

  /** teamId → group index. Seeded from the prefill so "accept the suggestion" is one click. */
  const seed = () => {
    const map: Record<string, number> = {};
    seedGroups().forEach((entrants, gi) => entrants.forEach((t) => (map[t] = gi)));
    return map;
  };
  /** teamId → 1-based position within its group, seeded from the stored/suggested order. */
  const seedRanks = () => {
    const map: Record<string, number> = {};
    seedGroups().forEach((entrants) => entrants.forEach((t, i) => (map[t] = i + 1)));
    return map;
  };
  const [assignment, setAssignment] = useState<Record<string, number>>(seed);
  const [ranks, setRanks] = useState<Record<string, number>>(seedRanks);
  const [points, setPoints] = useState<Record<string, number>>(stageRun?.carriedPoints ?? {});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const note = stage.entrants.kind === 'manual' ? stage.entrants.derivedFrom : undefined;
  const wantsPoints = !!note?.carryPoints;

  // Sorted by the admin's position when the order matters downstream, otherwise left in
  // participant order — which is what it always was, and fine for a round robin.
  const groups: string[][] = labels.map((_, gi) => {
    const inGroup = participants.filter((p) => assignment[p.teamId] === gi);
    if (!ranked) return inGroup.map((p) => p.teamId);
    return [...inGroup]
      .sort(
        (a, b) =>
          (ranks[a.teamId] ?? Number.MAX_SAFE_INTEGER) -
          (ranks[b.teamId] ?? Number.MAX_SAFE_INTEGER),
      )
      .map((p) => p.teamId);
  });
  const unassigned = participants.filter((p) => assignment[p.teamId] === undefined);

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

  async function submit() {
    if (problems.length || busy) return;
    setErr('');
    setBusy(true);
    try {
      await onConfirm(groups, wantsPoints ? points : {});
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not confirm — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {note && (
        <div
          style={{
            border: '1px solid var(--line)',
            borderLeft: '3px solid var(--brand-primary, #16332B)',
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 14,
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          <strong>The rule:</strong> {note.detail}
          {note.carryPoints && (
            <div style={{ ...HINT, marginTop: 6 }}>
              Points move with the position, not the team — enter the points each side takes on.
            </div>
          )}
        </div>
      )}

      {ranked && (
        <div
          style={{
            border: '1px solid var(--line)',
            borderLeft: '3px solid var(--accent, #C9A227)',
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 14,
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          {rankedReason === 'seeding' ? (
            <>
              <strong>Seeded knockout.</strong> Position 1 is the top seed — set each side&apos;s
              finishing position, not just which group it was in.
            </>
          ) : (
            <>
              <strong>Order matters here.</strong> A later stage pairs these groups across each
              other — the pool winner against another pool&apos;s runner-up — so set each
              side&apos;s finishing position, not just which group it was in.
            </>
          )}
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
                      Which pool each side plays in this stage. Choose <strong>Not playing</strong>{' '}
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
                        knockout or the order for a cross-pool draw.
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
            {participants.map((p) => (
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
        <Btn tone="outline" onClick={onCancel}>
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
  registered,
  onConfirm,
  onGenerate,
  busy,
}: {
  stage: StageSpec;
  index: number;
  stageRun: StageRun | undefined;
  materialisation: StageMaterialisation;
  seriesById: (id: string) => Series | undefined;
  /** Every side currently registered for the league — for the drift check below. */
  registered: string[];
  onConfirm: () => void;
  onGenerate: () => void;
  busy: boolean;
}) {
  const [confirmRegen, setConfirmRegen] = useState(false);
  const generated = stageRun?.status === 'generated';
  const ready = materialisation.status === 'ready';
  const fits = ready && materialisation.fits;
  // Entrants were re-confirmed after generation, so the linked series still hold the old
  // groups. Say so rather than showing the new counts beside a "Released" pill.
  const staleEntrants =
    stageRun?.status === 'ready' && stageRun.groups.some((g) => g.seriesId !== undefined);

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
  const diverged =
    ready &&
    materialisation.groups.some((g) => {
      const sid = stageRun?.groups.find((x) => x.id === g.id)?.seriesId;
      const linked = sid ? seriesById(sid) : undefined;
      return !!linked && fixtureKey(g.fixtures) !== fixtureKey(linked.fixtures as never);
    });
  const stale = staleEntrants || diverged;

  // A confirmed grouping is frozen — deliberately, it is a human decision about this
  // season — so it stops tracking the league's registration list. A club that joins
  // afterwards is silently in no group; one that leaves is still in a group, reaches
  // `series.teams` but not `series.participants`, and renders as "Unknown team". Neither
  // is wrong to allow, but both have to be VISIBLE, with Edit entrants as the way out.
  const grouped = new Set((stageRun?.groups ?? []).flatMap((g) => g.entrants));
  const drift = stageRun?.groups.length
    ? {
        missing: registered.filter((t) => !grouped.has(t)).length,
        departed: [...grouped].filter((t) => !registered.includes(t)).length,
      }
    : null;

  // Regenerating rewrites the linked series IN PLACE, and `released` is deliberately not
  // reset — so a published schedule would change under clubs and players with no prompt.
  // Every comparable action in the console asks first; this one must too.
  const releasedLinked = (stageRun?.groups ?? [])
    .map((g) => (g.seriesId ? seriesById(g.seriesId) : undefined))
    .filter((s): s is Series => !!s?.released);
  const totalFixtures = materialisation.status === 'ready' ? materialisation.totalFixtures : 0;

  function requestGenerate() {
    if (stale && releasedLinked.length) setConfirmRegen(true);
    else onGenerate();
  }

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
        <h3 style={{ fontWeight: 700, fontSize: 14, margin: 0 }}>{stage.name}</h3>
        {generated ? (
          <Pill tone="teal">Generated</Pill>
        ) : stale ? (
          <Pill tone="coral">Needs regenerating</Pill>
        ) : ready && fits ? (
          <Pill tone="muted">Ready to generate</Pill>
        ) : ready ? (
          <Pill tone="coral">Doesn’t fit</Pill>
        ) : (
          <Pill tone="muted">Awaiting entrants</Pill>
        )}
        <InfoDot
          title="Stage status"
          options={[
            {
              label: 'Awaiting entrants',
              desc: 'This stage’s teams depend on an earlier stage’s results — confirm who plays before it can generate.',
            },
            {
              label: 'Ready to generate',
              desc: 'Teams and groups are set and fit the calendar block. Generate its fixtures.',
            },
            {
              label: 'Doesn’t fit',
              desc: 'The rounds need more time than the calendar block allows — shorten the format or widen the block.',
            },
            {
              label: 'Generated',
              desc: 'Fixtures exist as one or more series. Approve and release them from the list above.',
            },
            {
              label: 'Needs regenerating',
              desc: 'Entrants or pairings changed since the fixtures were built — regenerate to catch up.',
            },
          ]}
        />
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
              const series = g.id && stageRun?.groups.find((x) => x.id === g.id)?.seriesId;
              const linked = series ? seriesById(series) : undefined;
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
              The entrants changed after these fixtures were generated — regenerate to bring the
              series into line.
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            {/* A GENERATED stage still offers Regenerate when its fixtures have drifted
                from the series they produced — otherwise an upstream change leaves the
                card showing one bracket and the clubs holding another, with no way back.
                The released-schedule confirmation covers the danger. */}
            {(!generated || diverged) && (
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
            <Btn tone="outline" size="sm" onClick={onConfirm}>
              {generated ? 'Change entrants' : 'Edit entrants'}
            </Btn>
          </div>
          {generated && (
            <p style={HINT}>
              Fixtures live as {materialisation.groups.length} series — approve and release them
              from the list above.
            </p>
          )}
        </>
      )}

      {(() => {
        const last = stageRun?.audit?.[stageRun.audit.length - 1];
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
        <Modal title="Regenerate a released schedule?" onClose={() => setConfirmRegen(false)}>
          <p style={{ fontSize: 13, lineHeight: 1.6, margin: '0 0 10px' }}>
            {releasedLinked.length === 1
              ? `“${releasedLinked[0].name}” has been RELEASED`
              : `${releasedLinked.length} of this stage's series have been RELEASED`}{' '}
            — clubs and players have already been sent those fixtures. Regenerating replaces them
            with {totalFixtures} new ones and there is no undo.
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

/* ─── Season run view ─── */

export interface GenerateGroupPayload {
  run: SeasonRun;
  stage: StageSpec;
  groupId: string;
  groupLabel: string;
  entrants: string[];
  fixtures: unknown[];
  startDate: string;
  league: League | undefined;
  competition: Competition | undefined;
}

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
}: {
  clubs: Club[];
  allLeagues: League[];
  allSeries: Series[];
  runs: SeasonRun[];
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
  onGenerate: (payloads: GenerateGroupPayload[], run: SeasonRun, stage: StageSpec) => Promise<void>;
  onDeleteRun: (id: string) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ run: SeasonRun; stage: StageSpec } | null>(null);
  const [busyStage, setBusyStage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const active = runs.find((r) => r.id === activeId) ?? runs[0];
  const seriesById = (id: string) => allSeries.find((s) => s.id === id);

  const runContext = useMemo(() => {
    if (!active) return null;
    const league = findByKey(allLeagues, active.leagueKey) as League | undefined;
    // A flat run has no config competition to find — its sentinel `competitionId` never
    // appears in `league.competitions`, so that lookup always resolved to `undefined` and
    // silently discarded whatever Series Type/overs the admin actually picked at Start. The
    // run persists that choice as `flatFormat` (there is no other source of truth for it),
    // so a flat run synthesizes its Competition from there instead — regenerate then reads
    // back the SAME format rather than a re-derived default.
    const competition =
      active.competitionId === FLAT_COMPETITION_ID
        ? {
            id: FLAT_COMPETITION_ID,
            label: active.flatFormat?.seriesType ?? 'Flat season',
            matchFormat: { overs: active.flatFormat?.overs ?? 50 },
            structureId: active.structureSnapshot.id,
            calendarId: active.calendarSnapshot.id,
          }
        : league?.competitions?.find((c) => c.id === active.competitionId);
    /*
     * `excludeTeamIds` is read live rather than snapshotted: it only feeds the prefill for
     * stages nobody has confirmed yet, and a side excluded mid-season (a withdrawal) should
     * stop being offered. Stages already confirmed keep their stored entrants either way.
     */
    const participants = leagueParticipants(clubs, active.leagueKey, competition?.excludeTeamIds);
    const structure: CompetitionStructure = active.structureSnapshot;
    const calendar: SeasonCalendar = active.calendarSnapshot;
    const materialisations = structure.stages.map((stage) => {
      const stageRun = active.stages.find((s) => s.specId === stage.id);
      return materialiseStage({
        stage,
        calendar,
        context: {
          registered: participants.map((p) => p.teamId),
          seedOrder: participants.map((p) => p.teamId),
          confirmed: stageRun?.groups.length ? stageRun.groups.map((g) => g.entrants) : undefined,
          /*
           * The groups of the stage this one's rule DRAWS FROM — the whole point of
           * recording `fromStage`. A swap moves one side between two groups, so the
           * suggestion has to start from where those groups actually ended up. Without
           * it the prefill blocks the registered list into the right SIZES and calls
           * that a proposal, which for a swap proposes relegating the entire top group.
           */
          priorGroups: derivedFromGroups(stage, active),
        },
        crossPoolQualifiers: crossPoolQualifiersFor(stage, structure.stages, active),
      });
    });
    return { league, competition, participants, structure, calendar, materialisations };
  }, [active, allLeagues, clubs]);

  async function confirmEntrants(
    run: SeasonRun,
    stage: StageSpec,
    groups: string[][],
    carriedPoints: Record<string, number>,
    prefill: string[][],
  ) {
    const accepted = JSON.stringify(prefill) === JSON.stringify(groups);
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
        // `by` and `at` are OVERWRITTEN server-side from the authenticated caller — a
        // client-supplied actor is worthless as a governance record. Only `prefill` and
        // `accepted` are genuinely ours to report: the server never saw the suggestion.
        audit: [...(existing?.audit ?? []), { at: '', by: '', prefill, accepted }],
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
              sub="Generate fixtures to work through a structured competition stage by stage, or to run a flat season for any other league."
              action={
                <Btn tone="teal" icon={Icon.Plus} onClick={onOpenLauncher}>
                  Start a season
                </Btn>
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
    confirming && feedsCrossPool(confirming.stage, runContext?.structure.stages ?? []);

  return (
    <>
      <Card
        title="Seasons"
        sub="Each stage confirms who plays, then generates its fixtures. A stage whose teams depend on earlier results waits for you."
        action={
          <Btn tone="teal" size="sm" icon={Icon.Plus} onClick={onOpenLauncher}>
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
                {/* A flat run's `competition` is synthesized above with its own
                    'Flat season' fallback baked in, so this no longer needs its own
                    special case for the sentinel — only a genuinely unbound (non-flat)
                    competitionId falls through to ''. */}
                {runContext.league?.label ?? active.leagueKey} ·{' '}
                {runContext.competition?.label ?? ''}
              </strong>{' '}
              · {active.seasonLabel} · {runContext.structure.name} (v{runContext.structure.version})
              · {runContext.participants.length} sides registered
            </div>

            {runContext.structure.stages.map((stage, i) => (
              <StageCard
                key={stage.id}
                stage={stage}
                index={i}
                stageRun={active.stages.find((s) => s.specId === stage.id)}
                materialisation={runContext.materialisations[i]}
                seriesById={seriesById}
                registered={runContext.participants.map((p) => p.teamId)}
                busy={busyStage === stage.id}
                onConfirm={() => setConfirming({ run: active, stage })}
                onGenerate={async () => {
                  const m = runContext.materialisations[i];
                  // `fits` covers the empty-group case (see materialiseStage); re-check
                  // it here so a stale render can't push a dateless series through.
                  if (m.status !== 'ready' || !m.fits) return;
                  setBusyStage(stage.id);
                  try {
                    // withToast in the caller has already surfaced the failure; swallow
                    // the rejection here so it doesn't reach the console as unhandled.
                    await onGenerate(
                      m.groups.map((g) => ({
                        run: active,
                        stage,
                        groupId: g.id,
                        groupLabel: g.label,
                        entrants: g.entrants,
                        fixtures: g.fixtures,
                        // A `manual` stage plans no rounds by design, so it has no first
                        // date — fall back to the block it plays in rather than sending
                        // '', which becomes an empty `gsi1sk` that real DynamoDB rejects
                        // (dynalite accepts it, so no test would catch it) part-way
                        // through a loop that has already written the earlier groups.
                        startDate:
                          g.plan.dates[0] ??
                          findBlock(active.calendarSnapshot, stage.schedule.blockIndex)?.start ??
                          todayIso(),
                        league: runContext.league,
                        competition: runContext.competition,
                      })),
                      active,
                      stage,
                    ).catch(() => {});
                  } finally {
                    setBusyStage(null);
                  }
                }}
              />
            ))}

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
        <Modal title="Delete this season?" onClose={() => setConfirmDelete(false)}>
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

      {confirming && runContext && (
        <Modal
          wide
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
            // Ask for finishing positions when the stage AFTER this one draws a
            // cross-pool bracket from it, OR when this stage is itself a seeded
            // knockout — there the position IS the seed line, not a downstream draw.
            ranked={
              confirmingFeedsCrossPool ||
              (confirming.stage.format.kind === 'knockout' &&
                confirming.stage.format.pairing === 'seeded')
            }
            rankedReason={confirmingFeedsCrossPool ? 'cross-pool' : 'seeding'}
            onCancel={() => setConfirming(null)}
            onConfirm={(groups, carriedPoints) => {
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
              );
            }}
          />
        </Modal>
      )}
    </>
  );
}

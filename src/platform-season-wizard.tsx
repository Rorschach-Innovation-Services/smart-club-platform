/**
 * Operator console — the season setup wizard (ADR 0008 phase 3).
 *
 * Walks: season dates → which leagues play on them (and through which structure) →
 * review, and writes everything in ONE PUT at the end. Each league it touches ends with
 * one setup, `league.setup = { structureId, calendarId }` — the same thing the catalogue
 * row's "Set up" dialog writes; the wizard's draft calendar is always the calendar.
 *
 * Match format is not asked here: overs live on the structure (its editor), and two
 * formats in one season are two league entries.
 *
 * Modeled on `CreateTenantWizard` (platform.tsx): pill stepper, per-step body, a footRow
 * with Back/Continue, errors routed to the step that owns them, a terminal Done summary.
 */
import { useState, type CSSProperties } from 'react';
import {
  Btn,
  EmptyState,
  HowSeasonsWork,
  Icon,
  InfoDot,
  Modal,
  ModalCancelBtn,
  NextSteps,
  OptionCards,
  type OptionCard,
} from './atoms';
import * as api from './api';
import { ApiError } from './api';
import { describeError } from './error-copy';
import { HelpLink } from './help/HelpDrawer';
import { CalendarForm } from './platform-calendars';
import { DEFAULT_PREVIEW_TEAMS, StructureNarrative } from './platform-structures';
import {
  NO_CHOICE,
  StructurePick,
  UncoveredLines,
  cloneForLeague,
  describeSetup,
  fitVerdict,
  isOperatorStructure,
  pickOverrun,
  type LeagueChoice,
} from './platform-setup-league';
import { StepIntro } from './platform-wizard';
import { calendarSpan, formatIsoDate } from '../packages/engine/src/calendar';
import { blockOverrun } from '../packages/engine/src/structure';
import { describeBlockOverrun } from '../packages/engine/src/narrative';
import {
  STRUCTURE_TEMPLATES,
  applyPlacement,
  defaultPlacement,
  findTemplate,
  instantiateTemplate,
} from '../packages/engine/src/templates';
import { stageTitle } from '../packages/engine/src/stage-kinds';
import type { CompetitionStructure, League, SeasonCalendar, TenantConfig } from './types';

type Toast = (m: string, t?: string) => void;

const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '8px 0 0' };
const SECTION: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.05em',
  textTransform: 'uppercase',
  color: 'var(--muted-2)',
  margin: '16px 0 8px',
};

const STEPS = ['Season dates', 'League structures', 'Review & create'] as const;

const WIZARD_EYEBROW = 'Platform · Season setup';
const WIZARD_TITLE = (
  <>
    Set up the season calendar &amp; <em>leagues</em>
  </>
);

/** A league whose setup can run again on the draft calendar — same structure, new dates. */
export interface RenewableSetup {
  league: League;
  structure: CompetitionStructure;
  /** The calendar the setup names today — "currently on 2025/26" on the row. */
  calendarLabel: string;
}

/**
 * The "Run again" candidates: every league whose setup exists, resolves to a structure,
 * and names a calendar OTHER than the draft. Derived from the current setup only — a
 * league has one, so there is no history to mine. Ticking one re-points
 * `setup.calendarId` at the draft at commit; the structure is untouched.
 */
export function renewableSetups(
  leagues: League[],
  structures: CompetitionStructure[],
  calendars: SeasonCalendar[],
  draftCalendarId: string,
): RenewableSetup[] {
  return leagues.flatMap((league) => {
    const setup = league.setup;
    if (!setup || setup.calendarId === draftCalendarId) return [];
    const structure = structures.find((s) => s.id === setup.structureId);
    if (!structure) return [];
    const calendarLabel =
      calendars.find((c) => c.id === setup.calendarId)?.label ?? 'an earlier calendar';
    return [{ league, structure, calendarLabel }];
  });
}

/**
 * One ADDED league's row in the "League structures" step. Leagues appear here only after
 * the operator picks them from the "Add a league" select — the step is opt-IN. Nothing
 * is preselected: the row asks where the structure comes from and waits for an answer.
 */
function LeagueSetupRow({
  league,
  calendar,
  structures,
  choice,
  sharedWith,
  currentSetup,
  onChange,
  onRemove,
  onUpdateStructure,
  resolveTemplate,
}: {
  league: League;
  calendar: SeasonCalendar;
  structures: CompetitionStructure[];
  choice: LeagueChoice;
  sharedWith: string[];
  /** "<structure> · <calendar>" the league has today, if any — this row replaces it. */
  currentSetup?: string;
  onChange: (c: LeagueChoice) => void;
  onRemove: () => void;
  onUpdateStructure: (fn: (s: CompetitionStructure) => CompetitionStructure) => void;
  resolveTemplate: (t: (typeof STRUCTURE_TEMPLATES)[number]) => {
    structure: CompetitionStructure;
    isNew: boolean;
  };
}) {
  return (
    <div style={rowBox}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 13.5 }}>{league.label}</div>
        <Btn tone="ghost" size="sm" onClick={onRemove}>
          Remove
        </Btn>
      </div>
      {currentSetup && (
        <p style={{ ...HINT, margin: '0 0 10px' }}>Currently set up: {currentSetup}</p>
      )}
      <StructurePick
        league={league}
        calendar={calendar}
        structures={structures}
        choice={choice}
        onChange={onChange}
        resolveTemplate={resolveTemplate}
        adjust={{ sharedWith, onUpdateStructure }}
      />
    </div>
  );
}

/** One NEW template structure held in this run, and the leagues sharing it. */
interface HeldInstance {
  structure: CompetitionStructure;
  leagueLabels: string[];
}

/** The distinct new template instances the added leagues hold, in add order. */
function newTemplateInstances(
  addedKeys: string[],
  choices: Record<string, LeagueChoice>,
  leagues: League[],
): HeldInstance[] {
  const byId = new Map<string, HeldInstance>();
  for (const key of addedKeys) {
    const c = choices[key];
    if (!c || c.mode !== 'template' || !c.isNew || !c.structure) continue;
    const label = leagues.find((l) => l.key === key)?.label ?? key;
    const held = byId.get(c.structure.id);
    if (held) held.leagueLabels.push(label);
    else byId.set(c.structure.id, { structure: c.structure, leagueLabels: [label] });
  }
  return [...byId.values()];
}

/**
 * "Plays in" — which block each stage of a new template structure plays in. Shown once
 * per shared instance (every league picking the template shares it), and only when the
 * calendar has two or more blocks: with one block there is nothing to choose.
 */
function PlacementSection({
  calendar,
  instances,
  onPlace,
}: {
  calendar: SeasonCalendar;
  instances: HeldInstance[];
  onPlace: (structureId: string, stageIndex: number, blockIndex: number) => void;
}) {
  if ((calendar.blocks?.length ?? 0) < 2 || instances.length === 0) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ ...SECTION, display: 'flex', alignItems: 'center', gap: 8 }}>
        Where each stage plays
        <HelpLink topic="blocks-vs-stages" />
      </div>
      {instances.map(({ structure, leagueLabels }) => (
        <div key={structure.id} style={rowBox}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>{structure.name}</div>
          <div style={{ fontSize: 12, color: 'var(--muted-2)', marginBottom: 8 }}>
            Used by {leagueLabels.join(', ')}
          </div>
          <div className="place-chips">
            {structure.stages.map((stage, i) => (
              <div
                key={stage.id}
                className="place-chip"
                title={`${stageTitle(stage.format)} · ${stage.name}`}
              >
                <span>Stage {i + 1} plays in</span>
                <select
                  aria-label={`${structure.name}: stage ${i + 1} plays in`}
                  value={String(stage.schedule.blockIndex)}
                  onChange={(e) => onPlace(structure.id, i, Number(e.target.value))}
                >
                  {stage.schedule.blockIndex >= calendar.blocks.length && (
                    <option value={String(stage.schedule.blockIndex)}>
                      {`Block ${stage.schedule.blockIndex + 1} (not on this calendar)`}
                    </option>
                  )}
                  {calendar.blocks.map((b, bi) => (
                    <option key={b.id} value={String(bi)}>
                      {`Block ${bi + 1} — ${b.label} · ${formatIsoDate(b.start)} → ${formatIsoDate(b.end)}`}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <p style={HINT}>
            Two stages in the same block play one after the other: the later one starts after the
            earlier one finishes.
          </p>
        </div>
      ))}
    </div>
  );
}

const rowBox: CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 10,
  padding: 12,
  marginBottom: 10,
};

/**
 * One "Run again" row: a league's current setup, offered on the draft calendar with the
 * SAME structure (nothing is re-created). Unticked by default; ticked, it tells the
 * structure as a story with its fit and any block it leaves empty. A structure that plays
 * past the draft calendar's last block can't be ticked.
 */
function RenewRow({
  row,
  calendar,
  ticked,
  onTick,
  onChooseDifferently,
}: {
  row: RenewableSetup;
  calendar: SeasonCalendar;
  ticked: boolean;
  onTick: (ticked: boolean) => void;
  onChooseDifferently: () => void;
}) {
  const overrun = blockOverrun(row.structure, calendar);
  const showDetail = ticked && !overrun;
  const verdict = showDetail ? fitVerdict(row.structure, calendar) : null;
  const inputId = `renew-${row.league.key}`;
  const overrunId = `${inputId}-overrun`;
  return (
    <div style={rowBox}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <input
          type="checkbox"
          id={inputId}
          checked={ticked}
          // Ticked before the calendar shrank: left enabled so it can still be unticked.
          disabled={!!overrun && !ticked}
          aria-describedby={overrun ? overrunId : undefined}
          onChange={(e) => onTick(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <label
          htmlFor={inputId}
          style={{ flex: 1, cursor: overrun && !ticked ? 'default' : 'pointer' }}
        >
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {`${row.league.label} — Run again on ${calendar.label}: ${row.structure.name}`}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            Currently on {row.calendarLabel}
          </div>
        </label>
        <button
          type="button"
          className="text-btn"
          aria-label={`Choose differently for ${row.league.label}`}
          onClick={onChooseDifferently}
        >
          Choose differently
        </button>
      </div>
      {overrun && (
        <div id={overrunId} style={ERR}>
          {describeBlockOverrun(row.structure, overrun)}
        </div>
      )}
      {showDetail && (
        <div className="template-detail">
          <div className="stage-field-label">What {row.structure.name} does</div>
          <StructureNarrative
            structure={row.structure}
            calendar={calendar}
            teamCount={DEFAULT_PREVIEW_TEAMS}
            assumed
          />
          {verdict && (
            <div
              style={{
                fontSize: 12,
                marginTop: 8,
                color: verdict.ok ? 'var(--muted)' : 'var(--gold, #B7791F)',
              }}
            >
              {verdict.text}
            </div>
          )}
          <UncoveredLines structure={row.structure} calendar={calendar} />
        </div>
      )}
    </div>
  );
}

/** What one league's setup in this run will be, for review, the Create count and commit. */
interface PlannedSetup {
  league: League;
  /** The structure as chosen — for `cloned`, the ORIGINAL the league's copy is made from. */
  structure: CompetitionStructure;
  /** renewed: its current structure, on the draft calendar · new: template instance ·
      existing: library structure · cloned: the league's own copy of a quick-start/migrated
      structure. */
  kind: 'renewed' | 'new' | 'existing' | 'cloned';
}

const PLANNED_KIND_TEXT: Record<PlannedSetup['kind'], (name: string) => string> = {
  renewed: (name) => `run again (${name})`,
  new: (name) => `new structure (${name})`,
  existing: (name) => `existing structure (${name})`,
  cloned: (name) => `own copy of ${name}`,
};

/** Step 0's calendar source. Shown only when the client already has a calendar. */
const CALENDAR_MODE_CARDS: OptionCard<'new' | 'existing'>[] = [
  {
    value: 'new',
    title: 'Start a new season calendar',
    desc: 'Build a fresh calendar below: blocks, breaks and excluded dates for this season.',
  },
  {
    value: 'existing',
    title: 'Use an existing calendar',
    desc: 'Reuse one this client already has, so every league on it shares the same dates.',
  },
];

/** What happens after the wizard, in the admin console. */
const AFTER_SETUP_STEPS = [
  {
    title: 'Start the season',
    desc: 'Admin console → Fixtures & Venues → Start a season, once clubs are registered.',
  },
  { title: 'Confirm entrants', desc: 'The admin confirms which sides play in each stage.' },
  { title: 'Generate fixtures', desc: 'Each stage’s groups become draft series.' },
  { title: 'Approve and release', desc: 'Clubs see nothing until a series is released.' },
];

/**
 * What makes a calendar draft "edited" for the discard prompt: its name and its blocks.
 * Block ids are left out — a fresh form mints new ones on every mount.
 */
const calendarSig = (c: SeasonCalendar) =>
  JSON.stringify({
    label: c.label,
    blocks: c.blocks.map((b) => ({ label: b.label, start: b.start, end: b.end })),
  });

export function SeasonSetupWizard({
  slug,
  config,
  onDone,
  onClose,
  toast,
  save,
}: {
  slug: string;
  config: TenantConfig;
  onDone: () => void;
  onClose: () => void;
  toast: Toast;
  save: (p: Partial<TenantConfig>) => Promise<TenantConfig>;
}) {
  const calendars = config.calendars ?? [];
  const leagues = config.leagues ?? [];
  const structures = config.structures ?? [];
  /**
   * The structures a template pick may REUSE: operator-authored only. Quick-start and
   * migrated structures are minted per league and never become a prefill (ADR 0014).
   */
  const operatorStructures = structures.filter(isOperatorStructure);
  const setupText = (l: League) => (l.setup ? describeSetup(l.setup, structures, calendars) : '');

  const [step, setStep] = useState(0);

  // ── Step 1: season dates ──
  const [calMode, setCalMode] = useState<'new' | 'existing'>('new');
  const [existingCalId, setExistingCalId] = useState(calendars[0]?.id ?? '');
  const [calDraft, setCalDraft] = useState<SeasonCalendar | null>(null);
  const [calValid, setCalValid] = useState(false);
  const selectedExisting = calendars.find((c) => c.id === existingCalId);
  const calFormKey = calMode === 'existing' ? existingCalId : 'new';
  /** The draft as the calendar form first reported it, so an edit reads as unsaved input. */
  const [calBaseline, setCalBaseline] = useState<{ formKey: string; sig: string } | null>(null);

  // ── Step 2: league structures ──
  const [leagueChoices, setLeagueChoices] = useState<Record<string, LeagueChoice>>({});
  /** Leagues the operator explicitly ADDED to this season, in add order. */
  const [addedKeys, setAddedKeys] = useState<string[]>([]);
  const addLeague = (key: string) => {
    setAddedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setLeagueChoices((prev) => ({ ...prev, [key]: NO_CHOICE }));
  };
  const removeLeague = (key: string) => {
    setAddedKeys((prev) => prev.filter((k) => k !== key));
    setLeagueChoices((prev) => {
      const { [key]: _dropped, ...rest } = prev;
      void _dropped;
      return rest;
    });
  };
  /**
   * A template pick REUSES before it mints — structures are durable blueprints, not
   * per-season stampings. Order of preference: a structure already in the tenant's
   * library cloned from this template → the instance another league picked earlier in
   * THIS run (so the two share it) → a fresh instance named after the template itself.
   */
  const resolveTemplate = (
    t: (typeof STRUCTURE_TEMPLATES)[number],
  ): { structure: CompetitionStructure; isNew: boolean } => {
    const existing = operatorStructures.find((s) => s.templateId === t.id);
    if (existing) return { structure: existing, isNew: false };
    const pending = Object.values(leagueChoices).find(
      (c) => c.isNew && c.structure?.templateId === t.id,
    );
    if (pending?.structure) return { structure: pending.structure, isNew: true };
    return {
      structure: instantiateTemplate(
        t,
        calDraft ?? undefined,
        undefined,
        placementFor(t, calDraft ?? undefined),
      ),
      isNew: true,
    };
  };
  /**
   * The operator's explicit "plays in" choices, per template, one entry per stage
   * (`undefined` = not set, so the default rule still applies). Keyed by template id
   * because a template instance is SHARED by every league that picks it in this run.
   */
  const [placements, setPlacements] = useState<Record<string, Array<number | undefined>>>({});

  /**
   * Where a template's stages play on `cal`: the operator's explicit choice where they
   * made one (and the block still exists), else `defaultPlacement`.
   */
  const placementFor = (
    t: (typeof STRUCTURE_TEMPLATES)[number],
    cal: SeasonCalendar | undefined,
  ): number[] => {
    const blockCount = cal?.blocks?.length ?? 0;
    const defaults = defaultPlacement(t, blockCount);
    const explicit = placements[t.id] ?? [];
    return defaults.map((d, i) => {
      const chosen = explicit[i];
      return chosen !== undefined && chosen < blockCount ? chosen : d;
    });
  };

  /** Set one stage's block on a shared template instance, for every league holding it. */
  const setStagePlacement = (structureId: string, stageIndex: number, blockIndex: number) => {
    const held = Object.values(leagueChoices).find(
      (c) => c.structure?.id === structureId,
    )?.structure;
    if (!held) return;
    if (held.templateId) {
      const templateId = held.templateId;
      setPlacements((prev) => {
        const next = [...(prev[templateId] ?? [])];
        next[stageIndex] = blockIndex;
        return { ...prev, [templateId]: next };
      });
    }
    const placement = held.stages.map((st, i) =>
      i === stageIndex ? blockIndex : st.schedule.blockIndex,
    );
    const updated = { ...held, stages: applyPlacement(held.stages, placement) };
    setLeagueChoices((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (next[key].structure?.id === structureId)
          next[key] = { ...next[key], structure: updated };
      }
      return next;
    });
  };
  /**
   * New template instances the operator has edited through "Adjust stages". Their stages
   * are the operator's own from then on, so leaving step 0 never re-derives them.
   */
  const [customised, setCustomised] = useState<string[]>([]);

  /** Edit a held new instance in place, for every league sharing it. */
  const updateInstance = (
    structureId: string,
    fn: (s: CompetitionStructure) => CompetitionStructure,
  ) => {
    setCustomised((prev) => (prev.includes(structureId) ? prev : [...prev, structureId]));
    setLeagueChoices((prev) => {
      const current = Object.values(prev).find((c) => c.structure?.id === structureId)?.structure;
      if (!current) return prev;
      const updated = fn(current);
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (next[key].structure?.id === structureId)
          next[key] = { ...next[key], structure: updated };
      }
      return next;
    });
  };
  /** The other added leagues holding the same NEW instance as `key`. */
  const sharersOf = (key: string): string[] => {
    const id = leagueChoices[key]?.isNew ? leagueChoices[key]?.structure?.id : undefined;
    if (!id) return [];
    return addedKeys
      .filter((k) => k !== key && leagueChoices[k]?.structure?.id === id)
      .map((k) => leagues.find((l) => l.key === k)?.label ?? k);
  };
  const choiceFor = (key: string) => leagueChoices[key] ?? NO_CHOICE;
  const setChoiceFor = (key: string, c: LeagueChoice) =>
    setLeagueChoices((prev) => ({ ...prev, [key]: c }));

  // ── Step 2: run again ──
  /** Ticked "Run again" rows, keyed by league key. Every row starts unticked. */
  const [renewTicks, setRenewTicks] = useState<Record<string, boolean>>({});
  /**
   * Every league's "Run again" row against the draft calendar. A league in the chooser
   * (`addedKeys` — "Choose differently" puts it there) shows no row; removing it from the
   * chooser brings the row back.
   */
  const renewRows: RenewableSetup[] = calDraft
    ? renewableSetups(leagues, structures, calendars, calDraft.id).filter(
        (r) => !addedKeys.includes(r.league.key),
      )
    : [];
  const tickableRenew = calDraft
    ? renewRows.filter((r) => !blockOverrun(r.structure, calDraft))
    : [];
  const chooseDifferently = (key: string) => {
    setRenewTicks((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    addLeague(key);
  };

  /**
   * Every league setup this run will write, in league order: a ticked "Run again" row, or
   * the chooser pick. A pick identical to the league's current setup (same structure, on
   * the draft calendar) is left out — commit would change nothing.
   */
  const plannedSetups = (): PlannedSetup[] => {
    if (!calDraft) return [];
    return leagues.flatMap((league): PlannedSetup[] => {
      const renewed = tickableRenew.find((r) => r.league.key === league.key);
      if (renewed && renewTicks[league.key])
        return [{ league, structure: renewed.structure, kind: 'renewed' }];
      const c = leagueChoices[league.key];
      if (!c || !c.structure || pickOverrun(c, calDraft)) return [];
      const kind: PlannedSetup['kind'] = c.isNew
        ? 'new'
        : isOperatorStructure(c.structure)
          ? 'existing'
          : 'cloned';
      if (
        kind !== 'cloned' &&
        league.setup?.structureId === c.structure.id &&
        league.setup.calendarId === calDraft.id
      )
        return [];
      return [{ league, structure: c.structure, kind }];
    });
  };

  // ── Step 3: review & commit ──
  const [committing, setCommitting] = useState(false);
  const [commitErr, setCommitErr] = useState('');
  const [done, setDone] = useState<{
    calendarLabel: string;
    calendarCreated: boolean;
    created: Array<{ league: string; structure: string }>;
  } | null>(null);

  const canContinueStep0 = calValid && !!calDraft && (calMode === 'new' || !!selectedExisting);

  /**
   * An added league must end up set up: adding one and picking nothing used to save only
   * the calendar, which read as "I selected the league but it isn't set up".
   */
  const step2Blockers: Array<{ key: string; message: string }> = calDraft
    ? leagues.flatMap((l) => {
        if (!addedKeys.includes(l.key)) return [];
        const c = leagueChoices[l.key];
        if (!c?.structure)
          return [
            {
              key: l.key,
              message: `${l.label} has no structure yet — pick a template or an existing structure, or remove it.`,
            },
          ];
        if (pickOverrun(c, calDraft))
          return [
            {
              key: l.key,
              message: `${l.label}'s structure plays in a block ${calDraft.label || 'this calendar'} doesn't have — pick another structure or remove it.`,
            },
          ];
        return [];
      })
    : [];
  // A row ticked before the calendar shrank would otherwise drop out of the save silently.
  if (calDraft)
    for (const r of renewRows)
      if (renewTicks[r.league.key] && blockOverrun(r.structure, calDraft))
        step2Blockers.push({
          key: r.league.key,
          message: `${r.league.label} was ticked to run again but its structure plays in a block ${calDraft.label || 'this calendar'} doesn't have — untick it or change the calendar.`,
        });

  const dirty =
    (!!calDraft && !!calBaseline && calendarSig(calDraft) !== calBaseline.sig) ||
    addedKeys.length > 0 ||
    Object.values(renewTicks).some(Boolean);

  /**
   * Leaving step 0: re-derive every held NEW template structure's stage block positions
   * against the CURRENT `calDraft`. A template is instantiated once, at pick time, against
   * whatever `calDraft` looked like then — but the operator can go Back to step 0 and
   * change the calendar's block count afterwards; a GROW would otherwise leave a later
   * stage silently pointing at the wrong block.
   *
   * Only stages the operator has NOT placed explicitly are re-derived (`placementFor`), an
   * instance edited through "Adjust stages" is left alone, and shared instances are
   * deduped by id and updated ONCE so every league still points at the same instance.
   */
  function proceedPastCalendarStep() {
    if (calDraft) {
      const remapped = new Map<string, CompetitionStructure>();
      for (const choice of Object.values(leagueChoices)) {
        const s = choice.structure;
        const template = s?.templateId ? findTemplate(s.templateId) : undefined;
        if (
          choice.mode === 'template' &&
          choice.isNew &&
          s &&
          template &&
          !customised.includes(s.id) &&
          !remapped.has(s.id)
        ) {
          remapped.set(s.id, {
            ...s,
            stages: applyPlacement(s.stages, placementFor(template, calDraft)),
          });
        }
      }
      if (remapped.size > 0) {
        setLeagueChoices((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(next)) {
            const s = next[key].structure;
            if (s && remapped.has(s.id))
              next[key] = { ...next[key], structure: remapped.get(s.id) };
          }
          return next;
        });
      }
    }
    setStep(1);
  }

  /**
   * ONE PUT for the whole wizard. Rebuilds each array from a FRESH refetch (not this
   * modal's stale `config` prop) and merges the wizard's additions on top — the same
   * refetch-rebuild-PUT discipline the library cards use, so a concurrent edit in another
   * tab can't be silently clobbered. Only `league.setup` is written; `competitions` is
   * never touched.
   */
  async function commit() {
    if (!calDraft) return;
    setCommitting(true);
    setCommitErr('');
    try {
      const fresh = await api.platformGetTenant(slug);
      const freshCalendars = fresh.calendars ?? [];

      if (calMode === 'existing' && !freshCalendars.some((c) => c.id === calDraft.id)) {
        throw new ApiError(409, 'This calendar was deleted in another session.');
      }
      // A retry after a PUT that landed but was never acknowledged: the "new" calendar is
      // already stored under this id, so upsert it rather than append a duplicate (409).
      const calendarLanded = freshCalendars.some((c) => c.id === calDraft.id);
      const nextCalendars =
        calMode === 'existing' || calendarLanded
          ? freshCalendars.map((c) => (c.id === calDraft.id ? calDraft : c))
          : [...freshCalendars, calDraft];

      const planned = plannedSetups();
      const freshStructures = fresh.structures ?? [];
      // Deduped by id: two leagues picking the same template SHARE one new instance, so it
      // is written exactly once — and only when a planned setup still uses it. Same retry
      // guard as SetupLeagueDialog: an instance whose id is ALREADY stored (a PUT that
      // landed but was never acknowledged) is not appended again, or the save 409s on a
      // duplicate structure id.
      const newStructures = [
        ...new Map(
          planned
            .filter((p) => p.kind === 'new')
            .filter((p) => !freshStructures.some((s) => s.id === p.structure.id))
            .map((p) => [p.structure.id, p.structure] as const),
        ).values(),
      ];
      // A quick-start or migrated structure adopted in the chooser is written as the
      // adopting league's OWN copy — one per league, even when two adopt the same original.
      const clones: CompetitionStructure[] = [];

      const created: Array<{ league: string; structure: string }> = [];
      const freshLeagues = fresh.leagues ?? [];
      const gone = planned.find((p) => !freshLeagues.some((fl) => fl.key === p.league.key));
      if (gone)
        throw new ApiError(
          409,
          `${gone.league.label} was deleted in another session — nothing was saved. Close and start again.`,
        );
      const nextLeagues = freshLeagues.map((fl) => {
        const p = planned.find((x) => x.league.key === fl.key);
        if (!p) return fl;
        let structureId = p.structure.id;
        let structureName = p.structure.name;
        if (p.kind === 'cloned') {
          const clone = cloneForLeague(fl, p.structure);
          clones.push(clone);
          structureId = clone.id;
          structureName = clone.name;
        }
        if (fl.setup?.structureId === structureId && fl.setup.calendarId === calDraft.id) return fl;
        created.push({ league: fl.label, structure: structureName });
        return { ...fl, setup: { structureId, calendarId: calDraft.id } };
      });
      const nextStructures = [...freshStructures, ...newStructures, ...clones];

      await save({ calendars: nextCalendars, structures: nextStructures, leagues: nextLeagues });
      toast(`${calDraft.label} · season set up`);
      setDone({ calendarLabel: calDraft.label, calendarCreated: calMode === 'new', created });
    } catch (e) {
      setCommitErr(describeError(e, 'Could not save — try again'));
    } finally {
      setCommitting(false);
    }
  }

  const footRow: CSSProperties = { display: 'flex', gap: 8, marginTop: 18 };
  const planned = plannedSetups();

  if (done) {
    return (
      <Modal eyebrow={WIZARD_EYEBROW} title={WIZARD_TITLE} maxWidth={1040} onClose={onDone}>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          <strong>{done.calendarLabel}</strong> is {done.calendarCreated ? 'created' : 'updated'}.
        </p>
        <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12.5, color: 'var(--muted)' }}>
          {done.created.length === 0 && (
            <li>No leagues were set up — the calendar alone was written.</li>
          )}
          {done.created.map((c, i) => (
            <li key={`${c.league}-${i}`}>
              {c.league}: <strong>{c.structure}</strong>
            </li>
          ))}
        </ul>
        <div style={SECTION}>What happens next</div>
        <NextSteps steps={AFTER_SETUP_STEPS} />
        <div style={footRow}>
          <Btn tone="teal" onClick={onDone}>
            Done
          </Btn>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      eyebrow={WIZARD_EYEBROW}
      title={WIZARD_TITLE}
      maxWidth={1040}
      onClose={onClose}
      dismissable={false}
      confirmClose={dirty}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
        {STEPS.map((label, i) => (
          <span
            key={label}
            title={label}
            style={{
              width: i === step ? 22 : 8,
              height: 8,
              borderRadius: 999,
              background:
                i < step
                  ? 'var(--green)'
                  : i === step
                    ? 'var(--green-mid, var(--green))'
                    : 'var(--line2)',
              transition: 'width 200ms ease-out',
            }}
          />
        ))}
        <span
          style={{
            fontSize: 11.5,
            color: 'var(--muted-2)',
            marginLeft: 6,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
          }}
        >
          Step {step + 1} of {STEPS.length} · {STEPS[step]}
          <InfoDot title="What this wizard does">
            <p>
              This sets up a whole season in one go — the same as filling in the{' '}
              <strong>Season calendars</strong> and <strong>Competition structures</strong> cards
              yourself, then setting up each league.
            </p>
            <p>
              <strong>1. Season dates</strong> — the calendar: playing blocks, breaks, excluded
              dates.
            </p>
            <p>
              <strong>2. League structures</strong> — pick which leagues play on it and through
              which structure.
            </p>
            <p>
              <strong>3. Review &amp; create</strong> — check it and save it all at once.
            </p>
          </InfoDot>
        </span>
      </div>

      {step === 0 && (
        <>
          <StepIntro title="How a season is set up">
            <p style={{ margin: '0 0 12px' }}>
              Three steps: set the season&rsquo;s dates, choose how each structured league plays
              through them, then check it all and create it in one save.
            </p>
            <HowSeasonsWork compact />
          </StepIntro>
          {calendars.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <OptionCards
                name="calendar-mode"
                label="Season calendar"
                value={calMode}
                onChange={setCalMode}
                options={CALENDAR_MODE_CARDS}
                compact
              />
            </div>
          )}
          {calMode === 'existing' && calendars.length > 0 && (
            <div className="field" style={{ marginBottom: 14 }}>
              <div className="field-label">Season calendar</div>
              <select
                className="field-select"
                value={existingCalId}
                onChange={(e) => setExistingCalId(e.target.value)}
              >
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {`${c.label} · ${calendarSpan(c)}`}
                  </option>
                ))}
              </select>
            </div>
          )}
          <CalendarForm
            key={calMode === 'existing' ? existingCalId : 'new'}
            calendar={calMode === 'existing' ? (selectedExisting ?? null) : null}
            allCalendars={calendars}
            embedded
            onDraftChange={(draft, valid) => {
              setCalDraft(draft);
              setCalValid(valid);
              setCalBaseline((b) =>
                b && b.formKey === calFormKey
                  ? b
                  : { formKey: calFormKey, sig: calendarSig(draft) },
              );
            }}
            onSave={async () => {}}
            onClose={() => {}}
            toast={toast}
          />
          <div style={footRow}>
            <ModalCancelBtn tone="ghost" size="sm" onClickOutsideModal={onClose}>
              Cancel
            </ModalCancelBtn>
            <Btn
              tone="teal"
              size="sm"
              onClick={proceedPastCalendarStep}
              disabled={!canContinueStep0}
            >
              Continue
            </Btn>
          </div>
        </>
      )}

      {step === 1 && calDraft && (
        <>
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            Add the leagues that play on <strong>{calDraft.label}</strong> and pick the structure
            each one plays through — a double round robin, a split league, groups, a knockout. Match
            format (overs) belongs to the structure. Every choice stays editable from the league
            catalogue afterwards.
          </p>
          {leagues.length === 0 ? (
            <EmptyState
              icon={Icon.Shield}
              title="No leagues yet"
              sub="Create the league catalogue first, then come back to set leagues up."
            />
          ) : (
            (() => {
              const setUpHere = leagues.filter((l) => l.setup?.calendarId === calDraft.id);
              const renewListed = new Set(renewRows.map((r) => r.league.key));
              const addable = leagues.filter(
                (l) =>
                  !addedKeys.includes(l.key) &&
                  !renewListed.has(l.key) &&
                  l.setup?.calendarId !== calDraft.id,
              );
              return (
                <>
                  {renewRows.length > 0 && (
                    <>
                      <div style={SECTION}>Run again</div>
                      <p style={{ ...HINT, margin: '0 0 8px' }}>
                        These leagues are set up on another calendar. Tick the ones to run again on{' '}
                        {calDraft.label} — each keeps its structure and moves to the new dates;
                        nothing is re-created.
                      </p>
                      {tickableRenew.length > 0 && (
                        <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                          <button
                            type="button"
                            className="text-btn"
                            onClick={() =>
                              setRenewTicks((prev) => ({
                                ...prev,
                                ...Object.fromEntries(
                                  tickableRenew.map((r) => [r.league.key, true]),
                                ),
                              }))
                            }
                          >
                            Select all {tickableRenew.length}
                          </button>
                          <button
                            type="button"
                            className="text-btn"
                            onClick={() => setRenewTicks({})}
                          >
                            Clear
                          </button>
                        </div>
                      )}
                      {renewRows.map((r) => (
                        <RenewRow
                          key={r.league.key}
                          row={r}
                          calendar={calDraft}
                          ticked={!!renewTicks[r.league.key]}
                          onTick={(ticked) =>
                            setRenewTicks((prev) => ({ ...prev, [r.league.key]: ticked }))
                          }
                          onChooseDifferently={() => chooseDifferently(r.league.key)}
                        />
                      ))}
                    </>
                  )}
                  {setUpHere.length > 0 && (
                    <div style={{ ...rowBox, background: 'var(--paper, transparent)' }}>
                      <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 4 }}>
                        Already set up on {calDraft.label}
                      </div>
                      {setUpHere.map((l) => (
                        <div
                          key={l.key}
                          style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 2 }}
                        >
                          {l.label} —{' '}
                          {structures.find((s) => s.id === l.setup?.structureId)?.name ??
                            'a structure'}
                        </div>
                      ))}
                    </div>
                  )}
                  {addedKeys
                    .map((key) => leagues.find((l) => l.key === key))
                    .filter((l): l is League => !!l)
                    .map((l) => (
                      <LeagueSetupRow
                        key={l.key}
                        league={l}
                        calendar={calDraft}
                        structures={structures}
                        choice={choiceFor(l.key)}
                        sharedWith={sharersOf(l.key)}
                        currentSetup={setupText(l) || undefined}
                        onChange={(c) => setChoiceFor(l.key, c)}
                        onRemove={() => removeLeague(l.key)}
                        onUpdateStructure={(fn) => {
                          const id = choiceFor(l.key).structure?.id;
                          if (id) updateInstance(id, fn);
                        }}
                        resolveTemplate={resolveTemplate}
                      />
                    ))}
                  {addable.length > 0 && (
                    <div className="field" style={{ maxWidth: 420 }}>
                      <select
                        className="field-select"
                        aria-label="Add a league"
                        value=""
                        onChange={(e) => e.target.value && addLeague(e.target.value)}
                      >
                        <option value="">Add a league…</option>
                        {addable.map((l) => (
                          <option key={l.key} value={l.key}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                      <p style={HINT}>
                        Leagues you don&rsquo;t add are untouched and can be set up later from the
                        league catalogue.
                      </p>
                    </div>
                  )}
                  <PlacementSection
                    calendar={calDraft}
                    instances={newTemplateInstances(addedKeys, leagueChoices, leagues)}
                    onPlace={setStagePlacement}
                  />
                </>
              );
            })()
          )}
          {step2Blockers.length > 0 && (
            <div role="alert" style={{ ...HINT, color: 'var(--coral, #b4412e)', marginTop: 12 }}>
              {step2Blockers.map((b) => (
                <div key={b.key}>{b.message}</div>
              ))}
            </div>
          )}
          <div style={footRow}>
            <Btn tone="ghost" size="sm" onClick={() => setStep(0)}>
              Back
            </Btn>
            <Btn
              tone="teal"
              size="sm"
              onClick={() => setStep(2)}
              disabled={step2Blockers.length > 0}
            >
              Continue
            </Btn>
          </div>
        </>
      )}

      {step === 2 && calDraft && (
        <>
          <div style={SECTION}>Calendar</div>
          <div style={{ fontSize: 13 }}>
            <strong>{calDraft.label}</strong> ·{' '}
            {calMode === 'existing' ? 'updating existing' : 'new'}
          </div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--muted)' }}>
            {calDraft.blocks.map((b) => (
              <li key={b.id}>
                {b.label}: {formatIsoDate(b.start)} → {formatIsoDate(b.end)}
              </li>
            ))}
            <li>
              {(calDraft.breaks ?? []).length} break
              {(calDraft.breaks ?? []).length === 1 ? '' : 's'}
            </li>
          </ul>

          <div style={SECTION}>League setups</div>
          {planned.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}>
              No leagues set up — only the calendar is written.
            </div>
          )}
          {planned.map((p) => {
            const verdict = fitVerdict(p.structure, calDraft);
            const replaces =
              p.league.setup &&
              !(
                p.league.setup.structureId === p.structure.id &&
                p.league.setup.calendarId === calDraft.id
              )
                ? setupText(p.league)
                : '';
            return (
              <div key={p.league.key} style={{ ...rowBox, fontSize: 12.5 }}>
                <div style={{ marginBottom: 8 }}>
                  <strong>{p.league.label}</strong>:{' '}
                  <span style={{ color: 'var(--muted)' }}>
                    {PLANNED_KIND_TEXT[p.kind](p.structure.name)}
                  </span>
                </div>
                {replaces && (
                  <div data-testid="replaces-line" style={{ marginBottom: 8 }}>
                    Replaces the current setup: <strong>{replaces}</strong>
                  </div>
                )}
                <StructureNarrative
                  structure={p.structure}
                  calendar={calDraft}
                  teamCount={DEFAULT_PREVIEW_TEAMS}
                  assumed
                />
                <div
                  style={{
                    marginTop: 8,
                    color: verdict.ok ? 'var(--muted)' : 'var(--gold, #B7791F)',
                  }}
                >
                  {verdict.text}
                </div>
                <UncoveredLines structure={p.structure} calendar={calDraft} />
              </div>
            );
          })}

          <div style={SECTION}>Unchanged</div>
          {(() => {
            // Named individually only when there is something individual to say — a
            // league already set up on this calendar, or one the operator added but never
            // gave a structure. The untouched majority collapses to a count.
            const alreadySetUp = leagues.filter(
              (l) => l.setup?.calendarId === calDraft.id && !planned.some((p) => p.league === l),
            );
            const incomplete = leagues.filter(
              (l) => addedKeys.includes(l.key) && !leagueChoices[l.key]?.structure,
            );
            const overrunning = leagues.filter(
              (l) => !!pickOverrun(leagueChoices[l.key], calDraft),
            );
            const named = new Set([
              ...alreadySetUp.map((l) => l.key),
              ...incomplete.map((l) => l.key),
              ...overrunning.map((l) => l.key),
              ...planned.map((p) => p.league.key),
            ]);
            const untouched = leagues.filter((l) => !named.has(l.key)).length;
            return (
              <>
                {alreadySetUp.map((l) => (
                  <div
                    key={l.key}
                    style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}
                  >
                    {l.label} — {setupText(l)} (already set up on this calendar)
                  </div>
                ))}
                {incomplete.map((l) => (
                  <div
                    key={l.key}
                    style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}
                  >
                    {l.label} (added, but no structure picked — left unchanged)
                  </div>
                ))}
                {overrunning.map((l) => (
                  <div
                    key={l.key}
                    style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}
                  >
                    {l.label} (its structure plays past this calendar&rsquo;s last block — left
                    unchanged)
                  </div>
                ))}
                {untouched > 0 && (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}>
                    {untouched} other league{untouched === 1 ? ' keeps its' : 's keep their'}{' '}
                    current setup.
                  </div>
                )}
              </>
            );
          })()}

          {commitErr && <div style={ERR}>{commitErr}</div>}

          <div style={footRow}>
            <Btn tone="ghost" size="sm" onClick={() => setStep(1)} disabled={committing}>
              Back
            </Btn>
            <Btn tone="teal" size="sm" onClick={commit} disabled={committing}>
              {committing
                ? 'Creating…'
                : planned.length === 0
                  ? 'Create season'
                  : `Create season · ${planned.length} league${planned.length === 1 ? '' : 's'}`}
            </Btn>
          </div>
        </>
      )}
    </Modal>
  );
}

/**
 * Operator console — the season setup wizard (ADR 0008 phase 3).
 *
 * Before this, setting up a season meant hopping between three disconnected cards:
 * CalendarsCard (season dates), StructuresCard (stage pipelines) and LeaguesCard's
 * Competitions modal (binding a league to a structure + calendar), with nothing walking
 * an operator through the sequence — and the binding step, the one that actually turns a
 * calendar and a structure into something a season can run, was hidden two clicks deep.
 *
 * This wizard walks: season dates → league structures → review, and writes everything in
 * ONE PUT at the end. The three cards stay exactly as they are for later editing — this is
 * the primary path for FIRST setup, not a replacement for them.
 *
 * Modeled on `CreateTenantWizard` (platform.tsx): pill stepper, per-step body, a footRow
 * with Back/Continue, errors routed to the step that owns them, a terminal Done summary.
 */
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Btn,
  EmptyState,
  HowSeasonsWork,
  Icon,
  InfoDot,
  NextSteps,
  OptionCards,
  useEscapeClose,
  type OptionCard,
} from './atoms';
import * as api from './api';
import { ApiError } from './api';
import { HelpLink } from './help/HelpDrawer';
import { CalendarForm } from './platform-calendars';
import {
  DEFAULT_PREVIEW_TEAMS,
  StageRow,
  StructureNarrative,
  TEMPLATE_CARDS,
  previewStages,
} from './platform-structures';
import { StepIntro } from './platform-wizard';
import { calendarSpan, formatIsoDate } from '../packages/engine/src/calendar';
import { groupSizes } from '../packages/engine/src/entrants';
import { derivedEntrantTotal, previewFitAll } from '../packages/engine/src/structure';
import {
  STRUCTURE_TEMPLATES,
  applyPlacement,
  defaultPlacement,
  findTemplate,
  instantiateTemplate,
  newStructureId,
} from '../packages/engine/src/templates';
import { stageTitle } from '../packages/engine/src/stage-kinds';
import type {
  Competition,
  CompetitionStructure,
  League,
  SeasonCalendar,
  StageSpec,
  TenantConfig,
} from './types';

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

type LeagueMode = 'skip' | 'template' | 'existing';

interface LeagueChoice {
  mode: LeagueMode;
  /**
   * Built ONCE, at pick time (a template clone mints fresh ids), and held here rather than
   * recomputed on every render — recomputing would mint a new structure id per keystroke
   * and the id minted at review time would never match the one actually written.
   */
  structure?: CompetitionStructure;
  /** For review copy: "new structure (Split league with mid-season swap)" vs "existing". */
  isNew?: boolean;
  label: string;
  overs?: number;
  ballType?: string;
}

const SKIP: LeagueChoice = { mode: 'skip', label: '' };

function Host({ onClose, children }: { onClose: () => void; children?: ReactNode }) {
  useEscapeClose(onClose);
  // A dialog with no role is, to assistive tech, an ordinary div — see CalendarModal /
  // StructuresCard's Modal for the same pattern this mirrors.
  const titleId = useId();
  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="task-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ maxWidth: 1040 }}
      >
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Platform · Season setup</div>
            <div className="task-modal-head-title" id={titleId}>
              Set up the season calendar &amp; <em>competitions</em>
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
 * Whether every stage of a structure fits the draft calendar, previewed at a plausible size.
 *
 * Each stage is sized the way it will really play: split into its OWN groups (12 teams in
 * two pools is two groups of 6 — 5 rounds, not a flat 12's 11, which is what this used to
 * check and why a pools structure read "⚠" against a block it fits comfortably). A stage
 * whose DerivationNote counts qualifiers is left out of the sizes so `previewFitAll` sizes
 * it exactly (2 pools × top 2 ⇒ one bracket of 4), and chained stages are placed after
 * their feeder, all in the one walk the structure editor's preview rail also uses.
 */
function fitVerdict(
  structure: CompetitionStructure,
  calendar: SeasonCalendar,
): { ok: boolean; text: string } {
  const stages = structure.stages;
  const sizesPerStage: Record<string, number[]> = {};
  const groupCounts = new Map<string, number>();
  for (const st of stages) {
    const plan = st.entrants.kind === 'all-registered' ? undefined : st.entrants.groups;
    const total = derivedEntrantTotal(st, stages, (id) => groupCounts.get(id));
    const sizes = groupSizes(plan, total ?? DEFAULT_PREVIEW_TEAMS);
    groupCounts.set(st.id, sizes.length);
    if (total === undefined) sizesPerStage[st.id] = sizes;
  }
  const plans = previewFitAll(structure, calendar, sizesPerStage).flatMap((f) => f.plans);
  const failing = plans.find((p) => !p.fits);
  return failing
    ? { ok: false, text: `⚠ ${failing.summary}` }
    : { ok: true, text: '✓ Fits the calendar' };
}

/** How a league's structure is sourced. Compact cards: two options, one line each. */
const MODE_CARDS = (hasStructures: boolean): OptionCard<'template' | 'existing'>[] => [
  {
    value: 'template',
    title: 'Start from a template',
    desc: 'A ready-made shape that becomes a new structure for this client.',
  },
  {
    value: 'existing',
    title: 'Use an existing structure',
    desc: 'Reuse one from this client’s library. No new version is created.',
    disabled: !hasStructures,
    disabledReason: hasStructures ? undefined : 'This client has no structures yet.',
  },
];

/**
 * "Adjust stages": the structures card's own stage editor, inline, over one template
 * instance. Edits go through `onUpdate` as a function of the CURRENT instance, so two
 * quick edits never race each other on a stale copy.
 */
function AdjustStages({
  structure,
  calendar,
  onUpdate,
}: {
  structure: CompetitionStructure;
  calendar: SeasonCalendar;
  onUpdate: (fn: (s: CompetitionStructure) => CompetitionStructure) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(structure.stages[0]?.id ?? null);
  const previews = previewStages(structure, calendar, DEFAULT_PREVIEW_TEAMS);
  const patchStage = (i: number, patch: Partial<StageSpec>) =>
    onUpdate((s) => ({
      ...s,
      stages: s.stages.map((st, j) => (i === j ? { ...st, ...patch } : st)),
    }));
  const moveStage = (i: number, dir: -1 | 1) =>
    onUpdate((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.stages.length) return s;
      const stages = [...s.stages];
      [stages[i], stages[j]] = [stages[j], stages[i]];
      return { ...s, stages };
    });
  return (
    <div className="adjust-stages">
      {structure.stages.map((stage, i) => (
        <StageRow
          key={stage.id}
          stage={stage}
          index={i}
          total={structure.stages.length}
          calendar={calendar}
          earlierStages={structure.stages.slice(0, i)}
          preview={previews[i]}
          expanded={expanded === stage.id}
          onToggle={() => setExpanded(expanded === stage.id ? null : stage.id)}
          onChange={(patch) => patchStage(i, patch)}
          onRemove={() => onUpdate((s) => ({ ...s, stages: s.stages.filter((_, j) => j !== i) }))}
          onMove={(dir) => moveStage(i, dir)}
        />
      ))}
    </div>
  );
}

/**
 * One ADDED league's row in the "League structures" step. Leagues appear here only after
 * the operator picks them from the "Add a league" select — the step is opt-IN, because a
 * tenant runs a structured competition in a handful of its leagues while the other two
 * dozen stay on the flat series flow. The earlier design listed every league with a
 * "Skip" radio, which read as 29 questions demanding an answer.
 */
function LeagueSetupRow({
  league,
  calendar,
  structures,
  choice,
  sharedWith,
  onChange,
  onRemove,
  onUpdateStructure,
  resolveTemplate,
}: {
  league: League;
  calendar: SeasonCalendar;
  structures: CompetitionStructure[];
  choice: LeagueChoice;
  /** Other leagues in this run holding the same new template instance. */
  sharedWith: string[];
  onChange: (c: LeagueChoice) => void;
  onRemove: () => void;
  /** Edit this league's (shared) new template instance in place. */
  onUpdateStructure: (fn: (s: CompetitionStructure) => CompetitionStructure) => void;
  /** Resolves a template pick to a structure — reusing before minting (see the caller). */
  resolveTemplate: (t: (typeof STRUCTURE_TEMPLATES)[number]) => {
    structure: CompetitionStructure;
    isNew: boolean;
  };
}) {
  const [adjusting, setAdjusting] = useState(false);
  const verdict =
    choice.mode !== 'skip' && choice.structure ? fitVerdict(choice.structure, calendar) : null;

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

      <OptionCards
        name={`mode-${league.key}`}
        label={`Where ${league.label}'s structure comes from`}
        value={choice.mode === 'skip' ? null : choice.mode}
        onChange={(mode) => {
          setAdjusting(false);
          onChange({ mode, label: '' });
        }}
        options={MODE_CARDS(structures.length > 0)}
        compact
      />

      {choice.mode === 'template' && (
        <div style={{ marginTop: 12 }}>
          <OptionCards
            name={`tpl-${league.key}`}
            label={`Template for ${league.label}`}
            value={choice.structure?.templateId ?? null}
            onChange={(id) => {
              const t = STRUCTURE_TEMPLATES.find((x) => x.id === id);
              if (!t) return;
              setAdjusting(false);
              onChange({ mode: 'template', ...resolveTemplate(t), label: t.name });
            }}
            options={TEMPLATE_CARDS}
          />
        </div>
      )}

      {choice.mode === 'existing' && (
        <select
          className="field-select"
          aria-label={`Structure for ${league.label}`}
          value={choice.structure?.id ?? ''}
          onChange={(e) => {
            const s = structures.find((s2) => s2.id === e.target.value);
            onChange(
              s
                ? { mode: 'existing', structure: s, isNew: false, label: s.name }
                : { mode: 'existing', label: '' },
            );
          }}
          style={{ marginTop: 12 }}
        >
          <option value="">Structure…</option>
          {structures.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}

      {choice.mode !== 'skip' && choice.structure && (
        <div className="template-detail">
          <div className="stage-field-label">What {choice.structure.name} does</div>
          <StructureNarrative
            structure={choice.structure}
            calendar={calendar}
            teamCount={DEFAULT_PREVIEW_TEAMS}
            assumed
          />
          {choice.isNew ? (
            <>
              <button
                type="button"
                className="text-btn"
                aria-expanded={adjusting}
                onClick={() => setAdjusting((v) => !v)}
                style={{ marginTop: 8 }}
              >
                {adjusting ? 'Done adjusting' : 'Adjust stages'}
              </button>
              {adjusting && sharedWith.length > 0 && (
                <p style={HINT}>
                  {sharedWith.join(', ')} {sharedWith.length === 1 ? 'uses' : 'use'} this structure
                  too — changes here apply to every league on it.
                </p>
              )}
              {adjusting && (
                <AdjustStages
                  structure={choice.structure}
                  calendar={calendar}
                  onUpdate={onUpdateStructure}
                />
              )}
            </>
          ) : (
            <p style={HINT}>
              {choice.structure.name} is already in this client&rsquo;s library. Edit its stages
              from the Competition structures card.
            </p>
          )}
        </div>
      )}

      {choice.mode !== 'skip' && choice.structure && (
        <div
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}
        >
          <InfoDot
            title="Competition details"
            options={[
              {
                label: 'Competition label',
                desc: 'What this format stream is called. A league can run more than one.',
                eg: '50 Over (Red Ball)',
              },
              {
                label: 'Overs',
                desc: 'Overs per side — used on scorecards and match defaults.',
                eg: '50 for a one-day league, 20 for a T20',
              },
              {
                label: 'Ball type',
                desc: 'The ball used — shown on fixtures for clarity.',
                eg: 'Red, Pink or White',
              },
            ]}
          />
          <input
            className="field-input"
            style={{ flex: 1, minWidth: 180 }}
            placeholder="Competition label, e.g. 50 Over (Red Ball)"
            value={choice.label}
            onChange={(e) => onChange({ ...choice, label: e.target.value })}
          />
          <input
            className="field-input"
            type="number"
            min={1}
            max={200}
            style={{ width: 90 }}
            placeholder="Overs"
            value={choice.overs ?? ''}
            onChange={(e) => onChange({ ...choice, overs: +e.target.value || undefined })}
          />
          <input
            className="field-input"
            style={{ width: 140 }}
            placeholder="Ball type"
            value={choice.ballType ?? ''}
            onChange={(e) => onChange({ ...choice, ballType: e.target.value })}
          />
        </div>
      )}

      {verdict && (
        <div
          style={{
            fontSize: 12,
            marginTop: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            color: verdict.ok ? 'var(--muted)' : 'var(--gold, #B7791F)',
          }}
        >
          {verdict.text}
          <InfoDot title="Does it fit?">
            <p>
              Checks whether every round this structure produces can be scheduled inside the season
              calendar’s blocks. A <strong>⚠</strong> means the stages need more weeks than the
              blocks provide — shorten the competition or widen the blocks.
            </p>
          </InfoDot>
        </div>
      )}
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

  const [step, setStep] = useState(0);

  // ── Step 1: season dates ──
  const [calMode, setCalMode] = useState<'new' | 'existing'>('new');
  const [existingCalId, setExistingCalId] = useState(calendars[0]?.id ?? '');
  const [calDraft, setCalDraft] = useState<SeasonCalendar | null>(null);
  const [calValid, setCalValid] = useState(false);
  const selectedExisting = calendars.find((c) => c.id === existingCalId);

  // ── Step 2: league structures ──
  const [leagueChoices, setLeagueChoices] = useState<Record<string, LeagueChoice>>({});
  /** Leagues the operator explicitly ADDED to this season, in add order. */
  const [addedKeys, setAddedKeys] = useState<string[]>([]);
  const addLeague = (key: string) => {
    setAddedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setLeagueChoices((prev) => ({ ...prev, [key]: { mode: 'template', label: '' } }));
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
   * per-season stampings (the industry rule the whole model follows: structure is
   * durable, time is disposable). Order of preference: a structure already in the
   * tenant's library cloned from this template → the instance another league picked
   * earlier in THIS run (so the two share it) → a fresh instance named after the
   * template itself, never the league or season.
   */
  const resolveTemplate = (
    t: (typeof STRUCTURE_TEMPLATES)[number],
  ): { structure: CompetitionStructure; isNew: boolean } => {
    const existing = structures.find((s) => s.templateId === t.id);
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
   * because a template instance is SHARED by every league that picks it in this run —
   * one set of choices per instance, not per league.
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
  const choiceFor = (key: string) => leagueChoices[key] ?? SKIP;
  const setChoiceFor = (key: string, c: LeagueChoice) =>
    setLeagueChoices((prev) => ({ ...prev, [key]: c }));

  // ── Step 3: review & commit ──
  const [committing, setCommitting] = useState(false);
  const [commitErr, setCommitErr] = useState('');
  const [done, setDone] = useState<{
    calendarLabel: string;
    calendarCreated: boolean;
    created: Array<{ league: string; label: string }>;
  } | null>(null);

  const canContinueStep0 = calValid && !!calDraft && (calMode === 'new' || !!selectedExisting);

  /**
   * Leaving step 0: re-derive every held NEW template structure's stage block positions
   * against the CURRENT `calDraft`. A template is instantiated once, at pick time, against
   * whatever `calDraft` looked like then — but the operator can go Back to step 0 and
   * change the calendar's block count afterwards. A shrink is caught by the fit verdict
   * (it just warns); a GROW is the dangerous direction, because a later stage stays at
   * block position 0 or 1 exactly as minted, silently pointing at the wrong (now-existing)
   * block rather than the new one the operator actually added.
   *
   * Only stages the operator has NOT placed explicitly are re-derived (`placementFor`):
   * an explicit "plays in" choice survives the round trip, unless the block it names no
   * longer exists. Chaining is recomputed to match (`applyPlacement`).
   *
   * An instance edited through "Adjust stages" is left alone: its stages are the
   * operator's own now, and re-deriving by template position could undo a move.
   *
   * Only `isNew` template structures are touched — `isNew: false` choices are library
   * structures, unaffected by this wizard's own calendar draft. Structures shared by more
   * than one league (see `resolveTemplate`) are deduped by id and updated ONCE, so every
   * league still points at the same instance rather than diverging copies.
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
   * refetch-rebuild-PUT discipline CalendarsCard/StructuresCard/LeaguesCard already use,
   * so a concurrent edit in another tab can't be silently clobbered by this one PUT.
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
      const nextCalendars =
        calMode === 'existing'
          ? freshCalendars.map((c) => (c.id === calDraft.id ? calDraft : c))
          : [...freshCalendars, calDraft];

      // Deduped by id: two leagues picking the same template SHARE one new instance
      // (structures are durable blueprints), so it must be written exactly once.
      const newStructures = [
        ...new Map(
          Object.values(leagueChoices)
            .filter((c) => c.mode === 'template' && c.isNew && c.structure)
            .map((c) => [c.structure!.id, c.structure!] as const),
        ).values(),
      ];
      const nextStructures = [...(fresh.structures ?? []), ...newStructures];

      const created: Array<{ league: string; label: string }> = [];
      const freshLeagues = fresh.leagues ?? [];
      const nextLeagues = freshLeagues.map((fl) => {
        const choice = leagueChoices[fl.key];
        if (!choice || choice.mode === 'skip' || !choice.structure) return fl;
        // A concurrent session may have already bound this league on this calendar —
        // don't double it up.
        if ((fl.competitions ?? []).some((c) => c.calendarId === calDraft.id)) return fl;
        const competition: Competition = {
          id: newStructureId('comp'),
          label: choice.label.trim() || choice.structure.name,
          structureId: choice.structure.id,
          calendarId: calDraft.id,
          ...(choice.overs || choice.ballType
            ? { matchFormat: { overs: choice.overs, ballType: choice.ballType || undefined } }
            : {}),
        };
        created.push({ league: fl.label, label: competition.label });
        return { ...fl, competitions: [...(fl.competitions ?? []), competition] };
      });

      await save({ calendars: nextCalendars, structures: nextStructures, leagues: nextLeagues });
      toast(`${calDraft.label} · season set up`);
      setDone({ calendarLabel: calDraft.label, calendarCreated: calMode === 'new', created });
    } catch (e) {
      setCommitErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setCommitting(false);
    }
  }

  const footRow: CSSProperties = { display: 'flex', gap: 8, marginTop: 18 };

  if (done) {
    return (
      <Host onClose={onDone}>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          <strong>{done.calendarLabel}</strong> is {done.calendarCreated ? 'created' : 'updated'}.
        </p>
        <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12.5, color: 'var(--muted)' }}>
          {done.created.length === 0 && (
            <li>No leagues were bound to a competition — the calendar alone was written.</li>
          )}
          {done.created.map((c) => (
            <li key={c.league}>
              {c.league}: <strong>{c.label}</strong>
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
      </Host>
    );
  }

  return (
    <Host onClose={onClose}>
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
              yourself, then binding each league.
            </p>
            <p>
              <strong>1. Season dates</strong> — the calendar: playing blocks, breaks, excluded
              dates.
            </p>
            <p>
              <strong>2. League structures</strong> — pick which leagues run a structured
              competition and how.
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
            }}
            onSave={async () => {}}
            onClose={() => {}}
            toast={toast}
          />
          <div style={footRow}>
            <Btn tone="ghost" size="sm" onClick={onClose}>
              Cancel
            </Btn>
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
            Most leagues keep the simple flat series flow and need nothing here. Add only the
            leagues that run a <strong>structured competition</strong> on{' '}
            <strong>{calDraft.label}</strong> — a split league, groups, a knockout. Every choice
            stays editable from the structures and competitions cards afterwards.
          </p>
          {leagues.length === 0 ? (
            <EmptyState
              icon={Icon.Shield}
              title="No leagues yet"
              sub="Create the league catalogue first, then come back to bind competitions."
            />
          ) : (
            (() => {
              const boundHere = leagues.filter((l) =>
                (l.competitions ?? []).some((comp) => comp.calendarId === calDraft.id),
              );
              const addable = leagues.filter(
                (l) =>
                  !addedKeys.includes(l.key) &&
                  !(l.competitions ?? []).some((comp) => comp.calendarId === calDraft.id),
              );
              return (
                <>
                  {boundHere.length > 0 && (
                    <div style={{ ...rowBox, background: 'var(--paper, transparent)' }}>
                      <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 4 }}>
                        Already set up on {calDraft.label}
                      </div>
                      {boundHere.map((l) => {
                        const comp = (l.competitions ?? []).find(
                          (c) => c.calendarId === calDraft.id,
                        );
                        const structName =
                          structures.find((s) => s.id === comp?.structureId)?.name ?? 'a structure';
                        return (
                          <div
                            key={l.key}
                            style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 2 }}
                          >
                            {l.label} — {comp?.label} · {structName}
                          </div>
                        );
                      })}
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
                        Leagues you don&rsquo;t add are untouched — they keep the flat create-series
                        flow and can be set up later.
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
          <div style={footRow}>
            <Btn tone="ghost" size="sm" onClick={() => setStep(0)}>
              Back
            </Btn>
            <Btn tone="teal" size="sm" onClick={() => setStep(2)}>
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

          <div style={SECTION}>Leagues</div>
          {leagues
            .filter((l) => {
              const c = leagueChoices[l.key];
              const already = (l.competitions ?? []).some(
                (comp) => comp.calendarId === calDraft.id,
              );
              return !already && c && c.mode !== 'skip' && c.structure;
            })
            .map((l) => {
              const c = leagueChoices[l.key];
              const verdict = c?.structure ? fitVerdict(c.structure, calDraft) : null;
              return (
                <div key={l.key} style={{ ...rowBox, fontSize: 12.5 }}>
                  <div style={{ marginBottom: 8 }}>
                    <strong>{l.label}</strong>: {c?.label} ·{' '}
                    <span style={{ color: 'var(--muted)' }}>
                      {c?.isNew
                        ? `new structure (${c.structure?.name})`
                        : `existing structure (${c?.structure?.name})`}
                    </span>
                  </div>
                  {c?.structure && (
                    <StructureNarrative
                      structure={c.structure}
                      calendar={calDraft}
                      teamCount={DEFAULT_PREVIEW_TEAMS}
                      assumed
                    />
                  )}
                  {verdict && (
                    <div
                      style={{
                        marginTop: 8,
                        color: verdict.ok ? 'var(--muted)' : 'var(--gold, #B7791F)',
                      }}
                    >
                      {verdict.text}
                    </div>
                  )}
                </div>
              );
            })}

          <div style={SECTION}>Unchanged</div>
          {(() => {
            // Named individually only when there is something individual to say — a league
            // already bound on this calendar, or one the operator added but never gave a
            // structure. The untouched majority collapses to a count: listing 27 lines of
            // "(skipped)" buried the two lines that mattered.
            const alreadyBound = leagues.filter((l) =>
              (l.competitions ?? []).some((comp) => comp.calendarId === calDraft.id),
            );
            const incomplete = leagues.filter((l) => {
              const c = leagueChoices[l.key];
              return !alreadyBound.includes(l) && c && c.mode !== 'skip' && !c.structure;
            });
            const untouched =
              leagues.length -
              alreadyBound.length -
              incomplete.length -
              leagues.filter((l) => {
                const c = leagueChoices[l.key];
                return !alreadyBound.includes(l) && c && c.mode !== 'skip' && !!c.structure;
              }).length;
            return (
              <>
                {alreadyBound.map((l) => (
                  <div
                    key={l.key}
                    style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}
                  >
                    {l.label} (already set up on this calendar)
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
                {untouched > 0 && (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}>
                    {untouched} league{untouched === 1 ? ' keeps' : 's keep'} the flat series flow.
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
              {committing ? 'Creating…' : 'Create season'}
            </Btn>
          </div>
        </>
      )}
    </Host>
  );
}

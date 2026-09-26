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
import { useState, type CSSProperties } from 'react';
import {
  Btn,
  EmptyState,
  HowSeasonsWork,
  Icon,
  InfoDot,
  Modal,
  NextSteps,
  OptionCards,
  type OptionCard,
} from './atoms';
import * as api from './api';
import { ApiError } from './api';
import { describeError } from './error-copy';
import { HelpLink } from './help/HelpDrawer';
import { CalendarForm } from './platform-calendars';
import {
  DEFAULT_PREVIEW_TEAMS,
  NON_OPERATOR_GROUPS,
  StageRow,
  StructureNarrative,
  TEMPLATE_CARDS,
  previewStages,
} from './platform-structures';
import { StepIntro } from './platform-wizard';
import { calendarSpan, formatIsoDate } from '../packages/engine/src/calendar';
import { groupSizes } from '../packages/engine/src/entrants';
import {
  blockOverrun,
  derivedEntrantTotal,
  previewFitAll,
  uncoveredBlocks,
} from '../packages/engine/src/structure';
import { describeBlockOverrun, describeUncoveredBlock } from '../packages/engine/src/narrative';
import {
  STRUCTURE_TEMPLATES,
  applyPlacement,
  defaultPlacement,
  findTemplate,
  instantiateTemplate,
  newStructureId,
} from '../packages/engine/src/templates';
import { stageTitle } from '../packages/engine/src/stage-kinds';
import {
  resolveCompetitionDefaults,
  type ResolvedCompetitionDefaults,
} from '../packages/engine/src/defaults';
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

const WIZARD_EYEBROW = 'Platform · Season setup';
const WIZARD_TITLE = (
  <>
    Set up the season calendar &amp; <em>competitions</em>
  </>
);

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

/** Operator-authored: hand-made in the structures card or minted by this wizard (ADR 0014). */
const isOperatorStructure = (s: CompetitionStructure) =>
  s.source === undefined || s.source === 'operator';

/** One prior format stream a league can run again on the draft calendar. */
export interface ReusableCompetition {
  competition: Competition;
  structure: CompetitionStructure;
  /** The calendar the competition was last bound to — "(2025/26)" on the reuse row. */
  calendarLabel: string;
}

/**
 * A league's "same as last season" candidates. Over its competitions, keep those whose
 * structure resolves AND is operator-authored (quick-start and migrated structures are
 * per-league stampings, never reused — ADR 0014) AND whose (structure, label) pair is not
 * already bound on the draft calendar. The same pair bound on several past calendars is
 * one stream: keep the competition on the most RECENT calendar (latest block end; a
 * calendar that no longer exists counts as the oldest).
 */
export function reusableCompetitions(
  league: League,
  structures: CompetitionStructure[],
  calendars: SeasonCalendar[],
  draftCalendarId: string,
): ReusableCompetition[] {
  const comps = league.competitions ?? [];
  const pairKey = (c: Competition) => JSON.stringify([c.structureId, c.label]);
  const boundHere = new Set(comps.filter((c) => c.calendarId === draftCalendarId).map(pairKey));
  /** Latest block end as an ISO date — '' (sorts first) for a missing or empty calendar. */
  const recency = (calendarId: string) =>
    (calendars.find((c) => c.id === calendarId)?.blocks ?? []).reduce(
      (max, b) => (b.end > max ? b.end : max),
      '',
    );
  const best = new Map<string, { row: ReusableCompetition; end: string }>();
  for (const competition of comps) {
    const structure = structures.find((s) => s.id === competition.structureId);
    if (!structure || !isOperatorStructure(structure)) continue;
    const key = pairKey(competition);
    if (boundHere.has(key)) continue;
    const end = recency(competition.calendarId);
    const held = best.get(key);
    if (held && held.end >= end) continue;
    const calendarLabel =
      calendars.find((c) => c.id === competition.calendarId)?.label ?? 'an earlier calendar';
    best.set(key, { row: { competition, structure, calendarLabel }, end });
  }
  return [...best.values()].map((b) => b.row);
}

/** "50 overs · Red ball" — empty when the competition carries no match format. */
function matchFormatSummary(format: Competition['matchFormat']): string {
  if (!format) return '';
  const ball = format.ballType?.trim();
  return [
    format.overs ? `${format.overs} overs` : '',
    ball ? (/ball$/i.test(ball) ? ball : `${ball} ball`) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * A league's own copy of a quick-start or migrated structure. Adopting one never binds
 * the admin-minted instance to another league: the copy gets a fresh id, is operator-
 * authored (no `source`, like a hand-made structure), and is named for the adopting league.
 */
function cloneForLeague(league: League, original: CompetitionStructure): CompetitionStructure {
  // `source` is dropped so the copy reads as operator-authored, and `templateId` is
  // dropped so a league-named clone can never become `resolveTemplate`'s prefill for a
  // future template pick — the exact coupling the operator-only reuse rule exists to
  // prevent, resurfacing through the clone.
  const { source: _source, templateId: _templateId, ...rest } = original;
  void _source;
  void _templateId;
  // Quick-start structures are already named "<league> · <template>"; don't stack the
  // adopting league's own name onto itself ("Premier Men · Premier Men · …").
  const name = original.name.startsWith(`${league.label} · `)
    ? original.name
    : `${league.label} · ${original.name}`;
  return {
    ...rest,
    id: newStructureId(),
    name: name.slice(0, 80).trim(),
    stages: JSON.parse(JSON.stringify(original.stages)) as StageSpec[],
  };
}

/** Gold, never blocking: a calendar block this one structure leaves empty. */
function UncoveredLines({
  structure,
  calendar,
}: {
  structure: CompetitionStructure;
  calendar: SeasonCalendar;
}) {
  const blocks = uncoveredBlocks(structure, calendar);
  if (blocks.length === 0) return null;
  return (
    <>
      {blocks.map((b) => (
        <div
          key={b.id}
          className="uncovered-block"
          style={{ fontSize: 12, marginTop: 6, color: 'var(--gold, #B7791F)' }}
        >
          {describeUncoveredBlock(b, calendar.blocks.indexOf(b))}
        </div>
      ))}
    </>
  );
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
  defaults,
  onUpdate,
}: {
  structure: CompetitionStructure;
  /** The client's resolved competition defaults — match days and slots for new choices. */
  defaults: ResolvedCompetitionDefaults;
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
          defaults={defaults}
        />
      ))}
    </div>
  );
}

/**
 * A chooser pick's overrun of `calendar`, or null. Only a library pick or an adoption
 * ('existing' mode) can overrun: a template pick re-derives its block positions against the
 * calendar, so it is exempt.
 */
function pickOverrun(
  choice: LeagueChoice | undefined,
  calendar: SeasonCalendar,
): { block: number; has: number } | null {
  return choice?.mode === 'existing' && choice.structure
    ? blockOverrun(choice.structure, calendar)
    : null;
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
  defaults,
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
  defaults: ResolvedCompetitionDefaults;
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
  // A library pick or an adoption keeps its stages' block positions (only a template pick
  // re-derives them against the calendar), so one playing past the draft calendar's last
  // block is a hard stop — the server would 400 the binding. Left out of the plan until the
  // calendar grows or the operator picks differently.
  const overrun = pickOverrun(choice, calendar);
  const verdict =
    choice.mode !== 'skip' && choice.structure && !overrun
      ? fitVerdict(choice.structure, calendar)
      : null;

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
          {structures.filter(isOperatorStructure).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          {NON_OPERATOR_GROUPS.map(({ source, label }) => {
            const inGroup = structures.filter((s) => s.source === source);
            if (inGroup.length === 0) return null;
            return (
              <optgroup key={source} label={label}>
                {inGroup.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      )}

      {overrun && choice.structure && (
        <div style={ERR}>{describeBlockOverrun(choice.structure, overrun)}</div>
      )}
      {choice.mode !== 'skip' && choice.structure && !overrun && (
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
                  defaults={defaults}
                  onUpdate={onUpdateStructure}
                />
              )}
            </>
          ) : isOperatorStructure(choice.structure) ? (
            <p style={HINT}>
              {choice.structure.name} is already in this client&rsquo;s library. Edit its stages
              from the Competition structures card.
            </p>
          ) : (
            <p style={HINT}>
              {league.label} gets its own copy, named &ldquo;
              {`${league.label} · ${choice.structure.name}`.slice(0, 80).trim()}&rdquo; — the
              original stays with the league it was made for.
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
      {choice.mode !== 'skip' && choice.structure && !overrun && (
        <UncoveredLines structure={choice.structure} calendar={calendar} />
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

/** A reuse row: the prior competition, its league, and where the pair is being taken. */
type ReuseRowData = ReusableCompetition & { league: League };

/**
 * One "Same as last season" row: a prior format stream the league can run again on the
 * draft calendar, bound to the SAME structure (no new structure is written). Unticked by
 * default; ticked, it tells the structure as a story with its fit and any block it leaves
 * empty. A structure that plays past the draft calendar's last block can't be ticked.
 */
function ReuseRow({
  row,
  calendar,
  ticked,
  onTick,
  onChooseDifferently,
}: {
  row: ReuseRowData;
  calendar: SeasonCalendar;
  ticked: boolean;
  onTick: (ticked: boolean) => void;
  onChooseDifferently: () => void;
}) {
  const overrun = blockOverrun(row.structure, calendar);
  const format = matchFormatSummary(row.competition.matchFormat);
  const showDetail = ticked && !overrun;
  const verdict = showDetail ? fitVerdict(row.structure, calendar) : null;
  const inputId = `reuse-${row.competition.id}`;
  const overrunId = `${inputId}-overrun`;
  return (
    <div style={rowBox}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <input
          type="checkbox"
          id={inputId}
          checked={showDetail}
          disabled={!!overrun}
          aria-describedby={overrun ? overrunId : undefined}
          onChange={(e) => onTick(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <label htmlFor={inputId} style={{ flex: 1, cursor: overrun ? 'default' : 'pointer' }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {`${row.league.label} — Same as last season: ${row.structure.name} (${row.calendarLabel})`}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            {[row.competition.label, format].filter(Boolean).join(' · ')}
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

/** What one competition in this run will be, for review, the Create count and commit. */
interface PlannedCompetition {
  league: League;
  label: string;
  /** The structure as chosen — for `cloned`, the ORIGINAL the league's copy is made from. */
  structure: CompetitionStructure;
  /** reused: last season's structure again · new: template instance · existing: library
      structure · cloned: the league's own copy of a quick-start/migrated structure. */
  kind: 'reused' | 'new' | 'existing' | 'cloned';
  matchFormat?: Competition['matchFormat'];
}

const PLANNED_KIND_TEXT: Record<PlannedCompetition['kind'], (name: string) => string> = {
  reused: (name) => `same as last season (${name})`,
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
   * The structures the wizard may REUSE (template prefill and "Use an existing
   * structure"): operator-authored only. Quick-start and migrated structures are minted
   * per league and never become a prefill (ADR 0014).
   */
  const operatorStructures = structures.filter(
    (s) => s.source === undefined || s.source === 'operator',
  );
  const competitionDefaults = resolveCompetitionDefaults(config);

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
        competitionDefaults,
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

  // ── Step 2: same as last season ──
  /** Ticked reuse rows, keyed by the PRIOR competition's id. Every row starts unticked. */
  const [reuseTicks, setReuseTicks] = useState<Record<string, boolean>>({});
  /**
   * Every league's reuse rows against the draft calendar. A league in the chooser
   * (`addedKeys` — "Choose differently" puts it there) shows none of its rows; removing it
   * from the chooser brings them back.
   */
  const reuseRows: ReuseRowData[] = calDraft
    ? leagues.flatMap((league) =>
        addedKeys.includes(league.key)
          ? []
          : reusableCompetitions(league, structures, calendars, calDraft.id).map((r) => ({
              ...r,
              league,
            })),
      )
    : [];
  const tickableReuse = calDraft
    ? reuseRows.filter((r) => !blockOverrun(r.structure, calDraft))
    : [];
  const chooseDifferently = (key: string) => {
    setReuseTicks((prev) => {
      const next = { ...prev };
      for (const r of reuseRows) if (r.league.key === key) delete next[r.competition.id];
      return next;
    });
    addLeague(key);
  };

  /**
   * Every competition this run will write, in league order: the league's ticked reuse rows,
   * then its chooser pick. A pick identical to a binding the league already has on the
   * draft calendar (same structure + label) is left out — commit would drop it anyway.
   */
  const plannedCompetitions = (): PlannedCompetition[] => {
    if (!calDraft) return [];
    return leagues.flatMap((league) => {
      const reused: PlannedCompetition[] = tickableReuse
        .filter((r) => r.league.key === league.key && reuseTicks[r.competition.id])
        .map((r) => ({
          league,
          label: r.competition.label,
          structure: r.structure,
          kind: 'reused',
          matchFormat: r.competition.matchFormat,
        }));
      const c = leagueChoices[league.key];
      const picked: PlannedCompetition[] =
        c && c.mode !== 'skip' && c.structure && !pickOverrun(c, calDraft)
          ? [
              {
                league,
                label: c.label.trim() || c.structure.name,
                structure: c.structure,
                kind: c.isNew ? 'new' : isOperatorStructure(c.structure) ? 'existing' : 'cloned',
                ...(c.overs || c.ballType
                  ? { matchFormat: { overs: c.overs, ballType: c.ballType || undefined } }
                  : {}),
              },
            ]
          : [];
      return [...reused, ...picked].filter(
        (p) =>
          p.kind === 'cloned' ||
          !(league.competitions ?? []).some(
            (e) =>
              e.structureId === p.structure.id &&
              e.calendarId === calDraft.id &&
              e.label === p.label,
          ),
      );
    });
  };

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
      // A quick-start or migrated structure adopted in the chooser is written as the
      // adopting league's OWN copy — one per league, even when two adopt the same original.
      const clones: CompetitionStructure[] = [];

      const planned = plannedCompetitions();
      const created: Array<{ league: string; label: string }> = [];
      const freshLeagues = fresh.leagues ?? [];
      const nextLeagues = freshLeagues.map((fl) => {
        const existing = fl.competitions ?? [];
        const additions: Competition[] = [];
        for (const p of planned.filter((x) => x.league.key === fl.key)) {
          let structureId = p.structure.id;
          if (p.kind === 'cloned') {
            const clone = cloneForLeague(fl, p.structure);
            clones.push(clone);
            structureId = clone.id;
          }
          // Only an IDENTICAL binding (a concurrent session, or last season's pair already
          // run here) is dropped. Two format streams routinely share one structure on one
          // calendar, differing only in label — both must land.
          if (
            [...existing, ...additions].some(
              (c) =>
                c.structureId === structureId &&
                c.calendarId === calDraft.id &&
                c.label === p.label,
            )
          )
            continue;
          additions.push({
            id: newStructureId('comp'),
            label: p.label,
            structureId,
            calendarId: calDraft.id,
            ...(p.matchFormat ? { matchFormat: { ...p.matchFormat } } : {}),
          });
          created.push({ league: fl.label, label: p.label });
        }
        return additions.length > 0 ? { ...fl, competitions: [...existing, ...additions] } : fl;
      });
      const nextStructures = [...(fresh.structures ?? []), ...newStructures, ...clones];

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
  const planned = plannedCompetitions();

  if (done) {
    return (
      <Modal eyebrow={WIZARD_EYEBROW} title={WIZARD_TITLE} maxWidth={1040} onClose={onDone}>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          <strong>{done.calendarLabel}</strong> is {done.calendarCreated ? 'created' : 'updated'}.
        </p>
        <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12.5, color: 'var(--muted)' }}>
          {done.created.length === 0 && (
            <li>No leagues were bound to a competition — the calendar alone was written.</li>
          )}
          {done.created.map((c, i) => (
            <li key={`${c.league}-${i}`}>
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
      </Modal>
    );
  }

  return (
    <Modal eyebrow={WIZARD_EYEBROW} title={WIZARD_TITLE} maxWidth={1040} onClose={onClose}>
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
              const boundHere = leagues.flatMap((l) =>
                (l.competitions ?? [])
                  .filter((comp) => comp.calendarId === calDraft.id)
                  .map((comp) => ({ league: l, comp })),
              );
              const reuseListed = new Set(reuseRows.map((r) => r.league.key));
              const addable = leagues.filter(
                (l) =>
                  !addedKeys.includes(l.key) &&
                  !reuseListed.has(l.key) &&
                  !(l.competitions ?? []).some((comp) => comp.calendarId === calDraft.id),
              );
              return (
                <>
                  {reuseRows.length > 0 && (
                    <>
                      <div style={SECTION}>Same as last season</div>
                      <p style={{ ...HINT, margin: '0 0 8px' }}>
                        These leagues ran a structured competition before. Tick the ones to run
                        again on {calDraft.label} — each gets a new competition on the same
                        structure, nothing is re-created.
                      </p>
                      {tickableReuse.length > 0 && (
                        <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                          <button
                            type="button"
                            className="text-btn"
                            onClick={() =>
                              setReuseTicks((prev) => ({
                                ...prev,
                                ...Object.fromEntries(
                                  tickableReuse.map((r) => [r.competition.id, true]),
                                ),
                              }))
                            }
                          >
                            Select all {tickableReuse.length}
                          </button>
                          <button
                            type="button"
                            className="text-btn"
                            onClick={() => setReuseTicks({})}
                          >
                            Clear
                          </button>
                        </div>
                      )}
                      {reuseRows.map((r) => (
                        <ReuseRow
                          key={r.competition.id}
                          row={r}
                          calendar={calDraft}
                          ticked={!!reuseTicks[r.competition.id]}
                          onTick={(ticked) =>
                            setReuseTicks((prev) => ({ ...prev, [r.competition.id]: ticked }))
                          }
                          onChooseDifferently={() => chooseDifferently(r.league.key)}
                        />
                      ))}
                    </>
                  )}
                  {boundHere.length > 0 && (
                    <div style={{ ...rowBox, background: 'var(--paper, transparent)' }}>
                      <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 4 }}>
                        Already set up on {calDraft.label}
                      </div>
                      {boundHere.map(({ league: l, comp }) => {
                        const structName =
                          structures.find((s) => s.id === comp.structureId)?.name ?? 'a structure';
                        return (
                          <div
                            key={comp.id}
                            style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 2 }}
                          >
                            {l.label} — {comp.label} · {structName}
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
                        defaults={competitionDefaults}
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

          <div style={SECTION}>Competitions</div>
          {planned.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}>
              No competitions — only the calendar is written.
            </div>
          )}
          {planned.map((p, i) => {
            const verdict = fitVerdict(p.structure, calDraft);
            const format = matchFormatSummary(p.matchFormat);
            return (
              <div key={`${p.league.key}-${i}`} style={{ ...rowBox, fontSize: 12.5 }}>
                <div style={{ marginBottom: 8 }}>
                  <strong>{p.league.label}</strong>: {p.label}
                  {format ? ` (${format})` : ''} ·{' '}
                  <span style={{ color: 'var(--muted)' }}>
                    {PLANNED_KIND_TEXT[p.kind](p.structure.name)}
                  </span>
                </div>
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
            // competition already bound on this calendar, or a league the operator added but
            // never gave a structure. The untouched majority collapses to a count: listing 27
            // lines of "(skipped)" buried the two lines that mattered.
            const alreadyBound = leagues.flatMap((l) =>
              (l.competitions ?? [])
                .filter((comp) => comp.calendarId === calDraft.id)
                .map((comp) => ({ league: l, comp })),
            );
            const incomplete = leagues.filter((l) => {
              const c = leagueChoices[l.key];
              return c && c.mode !== 'skip' && !c.structure;
            });
            const overrunning = leagues.filter(
              (l) => !!pickOverrun(leagueChoices[l.key], calDraft),
            );
            const named = new Set([
              ...alreadyBound.map((b) => b.league.key),
              ...incomplete.map((l) => l.key),
              ...overrunning.map((l) => l.key),
              ...planned.map((p) => p.league.key),
            ]);
            const untouched = leagues.filter((l) => !named.has(l.key)).length;
            return (
              <>
                {alreadyBound.map(({ league: l, comp }) => (
                  <div
                    key={comp.id}
                    style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}
                  >
                    {l.label} — {comp.label} (already set up on this calendar)
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
              {committing
                ? 'Creating…'
                : planned.length === 0
                  ? 'Create season'
                  : `Create season · ${planned.length} competition${planned.length === 1 ? '' : 's'}`}
            </Btn>
          </div>
        </>
      )}
    </Modal>
  );
}

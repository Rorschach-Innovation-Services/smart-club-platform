/**
 * Operator console — competition structures (ADR 0008).
 *
 * The stage pipeline a league's fixtures are shaped by. Operator-managed like calendars;
 * `PUT /tenant/config` strips `structures`, so this is the only surface that writes them.
 *
 * ── WHY A LIST, NOT A CANVAS ──
 * A league structure is strictly sequential with fan-out into groups. Node canvases earn
 * their cost on BRANCHING graphs; here one would add spatial-arrangement work and buy no
 * comprehension. So: a linear vertical stage list, each stage collapsed to one
 * plain-English sentence, with a live preview rail beside it. An operator should be able
 * to read a whole structure without expanding anything.
 *
 * The preview rail is the load-bearing affordance. It answers "will this actually fit the
 * season?" while the structure is still being designed and has no teams in it — which is
 * where a 12-team bi-weekly division needing 20 weeks in a 13-week block gets caught,
 * rather than at generation time in front of a club secretary.
 */
import { useState, useId, type CSSProperties, type ReactNode } from 'react';
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
import * as api from './api';
import { ApiError } from './api';
import {
  T20_SLOTS,
  WEEKDAY_LABELS,
  calendarSpan,
  describeCadence,
  findBlock,
  formatIsoDate,
  type DatePlan,
} from './competition/calendar';
import {
  chainFeeder,
  derivedEntrantTotal,
  previewFitAll,
  previewRounds,
} from './competition/structure';
import { describeStage } from './competition/narrative';
import { groupSizes } from './competition/entrants';
import { isPoolKnockout, roundsForFormat } from './competition/formats';
import {
  STRUCTURE_TEMPLATES,
  blankStage,
  blankStructure,
  defaultPlacement,
  instantiateTemplate,
  newStructureId,
  parseStructureJson,
  structureToJson,
} from './competition/templates';
import {
  CADENCE_KINDS,
  ENTRANT_KINDS,
  STAGE_KINDS,
  stageKindFor,
  stageTitle,
} from './help/stage-kinds';
import type {
  Cadence,
  Competition,
  CompetitionStructure,
  EntrantSpec,
  FormatSpec,
  GroupPlan,
  League,
  SeasonCalendar,
  StageSpec,
  TenantConfig,
  TimeSlot,
  Weekday,
} from './types';

type Toast = (m: string, t?: string) => void;

/**
 * Which calendar the structure editor should preview against.
 *
 * A structure carries no calendar identity of its own (`blockIndex` is a bare position,
 * meaningful only once a calendar is chosen), so — unlike the old id-based `blockId` —
 * there is nothing here to resolve FROM the structure itself. The fallback is therefore:
 * the operator's own current pick, else the tenant's only calendar (nothing to choose),
 * else the calendar the bindings agree on, else none.
 *
 * "The bindings agree on" is deliberately not "the first binding" — several competitions
 * routinely bind one structure, and taking `bindingCalendarIds[0]` picked whichever
 * happened to sort first even when the others named a DIFFERENT calendar (or one that no
 * longer exists). Ask, don't guess: only a single distinct, real calendar id resolves.
 */
function resolvePreviewCalendarId(
  selectedId: string | undefined,
  calendars: SeasonCalendar[],
  bindingCalendarIds: string[],
): string {
  if (selectedId) return selectedId;
  if (calendars.length === 1) return calendars[0].id;
  const real = [...new Set(bindingCalendarIds)].filter((id) => calendars.some((c) => c.id === id));
  return real.length === 1 ? real[0] : '';
}

/**
 * Stages whose block position doesn't exist on `calendar` — the index-based twin of the
 * old id-based "block no longer exists" check. A position has no identity beyond "the
 * Nth block of whichever calendar it's read against", so unlike the old blockId model
 * there is no "which OTHER calendar does this really belong to" to report — out of range
 * is all that can be said.
 */
function stagesOffCalendar(stages: StageSpec[], calendar: SeasonCalendar | undefined): StageSpec[] {
  return stages.filter((s) => s.schedule.blockIndex >= (calendar?.blocks.length ?? 0));
}

// Capped at 20 because `validateStructures` caps `blockIndex` at 19 — a stage can never
// legitimately name a position past this list. Read against a shorter calendar it still
// renders (see `stagesOffCalendar`'s off-calendar option), hence the numeric fallback.
const ORDINALS = [
  'First',
  'Second',
  'Third',
  'Fourth',
  'Fifth',
  'Sixth',
  'Seventh',
  'Eighth',
  'Ninth',
  'Tenth',
  'Eleventh',
  'Twelfth',
  'Thirteenth',
  'Fourteenth',
  'Fifteenth',
  'Sixteenth',
  'Seventeenth',
  'Eighteenth',
  'Nineteenth',
  'Twentieth',
];

/** `0` → "First", `1` → "Second", … the operator-facing name for a 0-based block position. */
function ordinal(i: number): string {
  return ORDINALS[i] ?? `${i + 1}th`;
}

const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '6px 0 0' };
const SECTION: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.05em',
  textTransform: 'uppercase',
  color: 'var(--muted-2)',
  margin: '14px 0 6px',
};

/** A stage-editor section label with an optional "(i)" explainer beside it. */
function SectionHead({ children, info }: { children: ReactNode; info?: ReactNode }) {
  return (
    <div style={{ ...SECTION, display: 'flex', alignItems: 'center', gap: 2 }}>
      {children}
      {info}
    </div>
  );
}

/** The team count the preview reasons about while a structure has no teams in it. */
const DEFAULT_PREVIEW_TEAMS = 12;

function Modal({
  title,
  wide,
  onClose,
  children,
}: {
  title: ReactNode;
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
        style={wide ? { maxWidth: 1040 } : undefined}
      >
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Platform · Competition structures</div>
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

/* ─── Stage editor ─── */

// `help` is a full sentence (not a fragment) so it reads on its own — used both in
// the Format info-popover and as the live hint under the select. Label, help and example
// all come from the STAGE_KINDS registry, so the picker, its explainer and the season
// narrative quote the same words. `describeFormat` stays as-is for the collapsed-row
// subtitle it was written for.
//
// Every value the server accepts is listed: triple round robin (legs 1–3 are valid) and
// the "entered by hand" escape hatch (reachable through JSON import) both used to be
// missing, which rendered such a stage as the wrong choice — or a blank select — and
// retyped it on any touch.
const FORMAT_VALUES: FormatSpec[] = [
  { kind: 'round-robin', legs: 1 },
  { kind: 'round-robin', legs: 2 },
  { kind: 'round-robin', legs: 3 },
  { kind: 'knockout', pairing: 'seeded' },
  { kind: 'knockout', pairing: 'cross-pool' },
  { kind: 'knockout', pairing: 'within-pool' },
  { kind: 'single-match' },
  { kind: 'manual' },
];
const FORMAT_OPTIONS: Array<{
  label: string;
  value: FormatSpec;
  help: string;
  eg: string;
}> = FORMAT_VALUES.map((value) => {
  const k = STAGE_KINDS[stageKindFor(value)];
  return { label: k.title, value, help: k.does, eg: k.eg };
});

/** The picker label for a format — its STAGE_KINDS title, which is unique per option. */
function formatLabel(f: FormatSpec): string {
  return STAGE_KINDS[stageKindFor(f)].title;
}

/**
 * How many groups a stage declares — no plan ⇒ one. The client twin of
 * `declaredGroupCount` in the server's config-validation.ts, which the within-group rule
 * below mirrors.
 */
function declaredGroupCount(stage: StageSpec): number {
  const plan = stage.entrants.kind !== 'all-registered' ? stage.entrants.groups : undefined;
  if (!plan) return 1;
  return plan.kind === 'sizes' ? plan.sizes.length : plan.count;
}

/**
 * Mirrors `validateStructures`' v1 within-group rule: the stage must draw from a stage of
 * exactly 2 groups with `qualifiersPerGroup: 2`. The generator refuses every other shape
 * (it would need a bye, or mislabel the bracket), so the server 400s it — caught here
 * first, where the operator can still see which control to change.
 */
function breaksWithinPoolShape(stage: StageSpec, stages: StageSpec[]): boolean {
  if (stage.format.kind !== 'knockout' || stage.format.pairing !== 'within-pool') return false;
  const note = stage.entrants.kind === 'manual' ? stage.entrants.derivedFrom : undefined;
  const source = note ? stages.find((s) => s.id === note.fromStage) : undefined;
  return note?.qualifiersPerGroup !== 2 || !source || declaredGroupCount(source) !== 2;
}

/** The server's own wording for the rule above (config-validation.ts). */
const WITHIN_POOL_SHAPE = 'within-group semi-finals need 2 groups × 2 qualifiers in this version';

/**
 * One stage as the preview reasons about it: its group sizes at the preview's team count
 * — or, when its DerivationNote counts qualifiers, at exactly that many — and how it fits
 * the previewed calendar once every earlier stage (and any chained feeder) is placed.
 */
interface StagePreview {
  sizes: number[];
  /** Sized from `qualifiersPerGroup` × the source stage's group count, not the team box. */
  derived: boolean;
  /** Every group fits. True with no calendar — there is nothing to be late for. */
  fits: boolean;
  /** The plan to report: the first group that overruns, else the first group's. */
  plan: DatePlan | null;
}

/**
 * The preview for a whole structure, in ONE sequential walk — shared by the stage rows
 * and the rail so they can't disagree. Sizes are resolved here (a qualifier-counted
 * stage takes `q × source groups`, the same rule `previewFitAll` applies) because they
 * are needed with no calendar selected too; the fit is `previewFitAll`'s, so a stage set
 * to start after the previous one is checked where it will really play, not from the
 * block start on top of its feeder.
 */
function previewStages(
  structure: CompetitionStructure,
  calendar: SeasonCalendar | undefined,
  previewTeams: number,
): StagePreview[] {
  const stages = structure.stages;
  const groupCounts = new Map<string, number>();
  const sized = stages.map((stage) => {
    const total = derivedEntrantTotal(stage, stages, (id) => groupCounts.get(id));
    const sizes = groupSizes(
      stage.entrants.kind === 'all-registered' ? undefined : stage.entrants.groups,
      total ?? previewTeams,
    );
    groupCounts.set(stage.id, sizes.length);
    return { sizes, derived: total !== undefined };
  });
  const fitted = calendar
    ? previewFitAll(
        structure,
        calendar,
        Object.fromEntries(stages.map((s, i) => [s.id, sized[i].sizes])),
      )
    : null;
  return sized.map(({ sizes, derived }, i) => {
    const f = fitted?.[i];
    return {
      sizes,
      derived,
      fits: f ? f.fits : true,
      plan: f ? (f.plans.find((p) => !p.fits) ?? f.plans[0] ?? null) : null,
    };
  });
}

// "Every registered side" cannot be split — the type carries no group plan — and an
// operator who picks it expecting groups discovers that three screens later, mid-season,
// in a modal that offers "Group A" and nothing else. Its help sentence says so up front.
// Copy comes from ENTRANT_KINDS / CADENCE_KINDS; the `key`s are the stored kinds.
const ENTRANT_OPTIONS = [
  {
    key: 'all-registered',
    label: ENTRANT_KINDS['all-registered'].title,
    help: ENTRANT_KINDS['all-registered'].does,
    eg: ENTRANT_KINDS['all-registered'].eg,
  },
  {
    key: 'seeded-split',
    label: 'Seeded into groups',
    help: 'Sides are split into groups by seed order. Choose snake or top-down below.',
    eg: `${ENTRANT_KINDS['seeded-split-snake'].eg} Or ${ENTRANT_KINDS['seeded-split-blocks'].eg}`,
  },
  {
    key: 'manual',
    label: ENTRANT_KINDS.manual.title,
    help: ENTRANT_KINDS.manual.does,
    eg: ENTRANT_KINDS.manual.eg,
  },
] as const;

const CADENCE_OPTIONS = (['weekly', 'every-n-weeks', 'weekdays', 'spread'] as const).map((key) => ({
  key,
  label: CADENCE_KINDS[key].title,
  help: CADENCE_KINDS[key].does,
  eg: CADENCE_KINDS[key].eg,
}));

function Select({
  value,
  onChange,
  children,
  width,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  width?: number;
  /**
   * Accessible name. The visible caption beside these pickers is a `field-label` div,
   * which associates the two for a sighted reader and for nobody else — a screen reader
   * announces a bare combobox with no indication of what it selects.
   */
  label?: string;
}) {
  return (
    <select
      className="field-select"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={width ? { minWidth: width } : undefined}
    >
      {children}
    </select>
  );
}

/** "5, 5, 5, 4" → [5,5,5,4]. Blank and junk segments drop out. */
function parseSizes(text: string): number[] {
  return text
    .split(',')
    .map((n) => parseInt(n.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function GroupPlanEditor({
  plan,
  onChange,
}: {
  plan: GroupPlan | undefined;
  onChange: (p: GroupPlan) => void;
}) {
  const kind = plan?.kind ?? 'even';
  // The sizes box RENDERS from raw text, not from the parsed model.
  //
  // Round-tripping through `sizes.join(', ')` on every keystroke deletes the trailing
  // comma as soon as it is typed, so a third group can never be entered — which makes
  // "5, 5, 5, 4" (the 19-team Promotion Men split, the reason exact sizes exist at all)
  // unenterable. The model is still updated live so the preview rail keeps up; only the
  // text the operator sees is left alone.
  const [sizeText, setSizeText] = useState(() =>
    plan?.kind === 'sizes' ? plan.sizes.join(', ') : '',
  );
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <Select
        value={kind}
        onChange={(v) => {
          if (v === 'sizes') {
            // Seed the text alongside the model — this component doesn't remount on a
            // kind flip, so it would otherwise show an empty box over a [6,6] plan.
            setSizeText('6, 6');
            onChange({ kind: 'sizes', sizes: [6, 6] });
          } else {
            onChange({ kind: 'even', count: 2 });
          }
        }}
      >
        <option value="even">Even groups</option>
        <option value="sizes">Exact sizes</option>
      </Select>
      <InfoDot
        title="Group plan — how sides divide into groups"
        options={[
          {
            label: 'Even groups',
            desc: 'Pick a number of equal groups. If sides don’t divide evenly, the earlier groups take the extra one.',
            eg: '12 sides into 2 groups of 6',
          },
          {
            label: 'Exact sizes',
            desc: 'Type each group’s size — the only way to make groups of different sizes.',
            eg: '19 sides as "5, 5, 5, 4"',
          },
        ]}
      />
      {/* Branch on `kind`, not `plan?.kind` — `groups` is optional on a manual stage, so
          an absent plan makes the Select read "Even groups" while the comma-sizes box
          renders underneath it, and typing there writes a `sizes` plan the dropdown says
          isn't selected. */}
      {kind === 'even' ? (
        <BoundedNumber
          min={1}
          max={26}
          style={{ width: 90 }}
          value={plan?.kind === 'even' ? plan.count : 2}
          onChange={(count) => onChange({ kind: 'even', count })}
        />
      ) : (
        <input
          className="field-input"
          style={{ width: 180 }}
          placeholder="6, 6"
          value={sizeText}
          onChange={(e) => {
            setSizeText(e.target.value);
            onChange({ kind: 'sizes', sizes: parseSizes(e.target.value) });
          }}
        />
      )}
      <span style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>
        {kind === 'sizes'
          ? 'Comma-separated — the only way to say 5, 5, 5, 4.'
          : 'A remainder lands in the earlier groups.'}
      </span>
    </div>
  );
}

function StageRow({
  stage,
  index,
  total,
  calendar,
  earlierStages,
  preview,
  expanded,
  onToggle,
  onChange,
  onRemove,
  onMove,
}: {
  stage: StageSpec;
  index: number;
  total: number;
  calendar: SeasonCalendar | undefined;
  earlierStages: StageSpec[];
  /** This stage's slice of `previewStages` — the same walk the rail reads. */
  preview: StagePreview;
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<StageSpec>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  // Same raw-text treatment as the group SIZES box: round-tripping through
  // `labels.join(', ')` on every keystroke deletes the separator the moment it is typed,
  // so a second label can never be entered and "Top Six, Bottom Six" — the ADR's own
  // worked example — mangles into "Top SixBottom Six".
  const [labelText, setLabelText] = useState(() => (stage.groupLabels ?? []).join(', '));

  // Remembers the slots to restore when the control is switched back on — either the
  // T20 default, or whatever was there before (including a saved structure's own values,
  // so re-toggling never resets an operator's edits back to the default).
  const [pendingSlots, setPendingSlots] = useState<TimeSlot[]>(
    () => stage.schedule.slots ?? T20_SLOTS,
  );

  const perGroup = preview.sizes[0] ?? 0;
  const rounds = previewRounds(stage, perGroup);
  const fit = preview.plan;
  // The stage this one WOULD follow if chained: the nearest earlier stage in its block.
  // Asked of `chainFeeder` with the flag assumed on, so the checkbox and the engine agree
  // on what "the previous stage" means.
  const chained = stage.schedule.startAfter === 'previous-stage';
  const feeder = chainFeeder(
    { ...stage, schedule: { ...stage.schedule, startAfter: 'previous-stage' } },
    [...earlierStages, stage],
  );
  // A block that is set, but not reachable from the calendar being PREVIEWED against.
  // Almost always means the preview is pointed at the wrong calendar, not that anything
  // is broken.
  //
  // Deliberately true when NO calendar is selected. That state is not "the operator
  // hasn't chosen" — it is also what resolution returns when it can't tell which calendar
  // a structure belongs to, and gating this on `calendar` there left a scheduled stage
  // rendering "Pick a playing block…" over a real value, with Save enabled: the exact
  // misread this option exists to prevent.
  const offCalendar = !calendar || stage.schedule.blockIndex >= calendar.blocks.length;

  const setFormat = (label: string) => {
    const opt = FORMAT_OPTIONS.find((o) => o.label === label);
    if (opt) onChange({ format: opt.value });
  };
  const setEntrantKind = (kind: string) => {
    const groups = stage.entrants.kind !== 'all-registered' ? stage.entrants.groups : undefined;
    if (kind === 'all-registered') onChange({ entrants: { kind: 'all-registered' } });
    else if (kind === 'seeded-split')
      onChange({
        entrants: {
          kind: 'seeded-split',
          // Default to the number of groups the operator already NAMED. Coming from the
          // "this stage names 3 groups but makes one" fix-up, a hardcoded 2 would answer
          // a question they had already answered, and silently drop the third group.
          // Clamped to 26, which is what the server accepts (config-validation.ts) and
          // what `groupLetter` can name — `groupLabels` is an uncapped comma box.
          groups: groups ?? {
            kind: 'even',
            count: Math.min(26, Math.max(2, stage.groupLabels?.length ?? 2)),
          },
          method: 'blocks',
        },
      });
    else
      onChange({
        entrants: {
          kind: 'manual',
          groups,
          derivedFrom: stage.entrants.kind === 'manual' ? stage.entrants.derivedFrom : undefined,
        },
      });
  };
  const setCadence = (kind: string) => {
    const next: Cadence =
      kind === 'every-n-weeks'
        ? { kind: 'every-n-weeks', n: 2 }
        : kind === 'weekdays'
          ? { kind: 'weekdays', days: [6] }
          : kind === 'spread'
            ? { kind: 'spread' }
            : { kind: 'weekly' };
    onChange({ schedule: { ...stage.schedule, cadence: next } });
  };
  const setSlot = (i: number, patch: Partial<TimeSlot>) => {
    const current = stage.schedule.slots ?? pendingSlots;
    const next = current.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) as TimeSlot[];
    setPendingSlots(next);
    onChange({ schedule: { ...stage.schedule, slots: next } });
  };

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 10,
        marginBottom: 10,
        background: 'var(--white, #fff)',
        overflow: 'hidden',
      }}
    >
      {/* Collapsed head: the whole stage as one sentence. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          padding: '12px 14px',
          cursor: 'pointer',
        }}
        onClick={onToggle}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <span style={{ fontSize: 11, color: 'var(--muted-2)', fontWeight: 700 }}>
              STAGE {index + 1}
            </span>
            <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
              {stageTitle(stage.format)}
            </span>
            <span style={{ fontWeight: 700, fontSize: 13.5 }}>
              {stage.name || 'Untitled stage'}
            </span>
            {stage.entrants.kind === 'manual' && stage.entrants.derivedFrom && (
              <Pill tone="muted">Needs confirmation</Pill>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            {describeStage(stage, calendar)}
          </div>
        </div>
        <div
          style={{ display: 'flex', gap: 4, alignItems: 'center' }}
          onClick={(e) => e.stopPropagation()}
        >
          <Btn tone="ghost" size="sm" onClick={() => onMove(-1)} disabled={index === 0}>
            ↑
          </Btn>
          <Btn tone="ghost" size="sm" onClick={() => onMove(1)} disabled={index === total - 1}>
            ↓
          </Btn>
          <Btn tone="ghost" size="sm" onClick={onRemove} disabled={total <= 1}>
            Remove
          </Btn>
          <Btn tone="outline" size="sm" onClick={onToggle}>
            {expanded ? 'Done' : 'Edit'}
          </Btn>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '4px 14px 16px', borderTop: '1px solid var(--line2)' }}>
          <div style={SECTION}>Name</div>
          <input
            className="field-input"
            value={stage.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. Double round"
          />

          <SectionHead
            info={
              <InfoDot
                title="Format — how a group's matches are decided"
                options={FORMAT_OPTIONS.map((o) => ({ label: o.label, desc: o.help, eg: o.eg }))}
              />
            }
          >
            Format
          </SectionHead>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Select
              value={formatLabel(stage.format)}
              onChange={setFormat}
              width={220}
              label="Format"
            >
              {FORMAT_OPTIONS.map((o) => (
                <option key={o.label} value={o.label}>
                  {o.label}
                </option>
              ))}
            </Select>
            {stage.format.kind === 'knockout' && (
              <label
                style={{ fontSize: 12.5, display: 'inline-flex', gap: 6, alignItems: 'center' }}
              >
                <input
                  type="checkbox"
                  checked={!!stage.format.thirdPlace}
                  onChange={(e) =>
                    onChange({
                      format: { ...stage.format, thirdPlace: e.target.checked } as FormatSpec,
                    })
                  }
                />
                Third-place playoff
              </label>
            )}
          </div>
          {/* Live hint: the selected format's own sentence, so it always matches the pick. */}
          <p style={HINT}>
            {FORMAT_OPTIONS.find((o) => o.label === formatLabel(stage.format))?.help}
          </p>
          {stage.format.kind === 'round-robin' && stage.format.legs >= 2 && (
            <div style={{ marginTop: 10 }}>
              <label
                style={{
                  fontSize: 12.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  marginBottom: 4,
                }}
              >
                Leg order
                <InfoDot
                  title="Leg order"
                  options={[
                    {
                      label: 'Full round, then return round',
                      desc: 'Everyone plays the whole first round before any return match — the standard home-and-away shape.',
                      eg: 'first-half fixtures, then the reverse fixtures after the break',
                    },
                    {
                      label: 'Same opponents back-to-back',
                      desc: 'A pair plays both their matches close together before moving on to new opponents.',
                      eg: 'a two-match weekend against the same side',
                    },
                  ]}
                />
              </label>
              <Choice
                value={
                  stage.format.legOrder === 'interleaved'
                    ? 'Same opponents back-to-back'
                    : 'Full round, then return round'
                }
                onChange={(v) => {
                  const format = stage.format;
                  if (format.kind !== 'round-robin') return;
                  if (v === 'Same opponents back-to-back') {
                    onChange({ format: { ...format, legOrder: 'interleaved' } as FormatSpec });
                  } else {
                    // 'mirrored' is `roundRobinRounds`'s own default when `legOrder` is
                    // absent — omit the key rather than writing a value it already implies.
                    const { legOrder: _legOrder, ...restFormat } = format;
                    onChange({ format: restFormat as FormatSpec });
                  }
                }}
                options={['Full round, then return round', 'Same opponents back-to-back']}
              />
              {stage.schedule.roundsPerDay === 2 && (
                <p style={HINT}>
                  With double-headers on, interleaved plays a side&apos;s morning leg and its PM
                  return against the same opponent, rather than saving the return for a later day.
                </p>
              )}
            </div>
          )}

          <SectionHead
            info={
              <InfoDot
                title="Teams — who plays in this stage"
                options={ENTRANT_OPTIONS.map((o) => ({ label: o.label, desc: o.help, eg: o.eg }))}
              />
            }
          >
            Teams
          </SectionHead>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* 280, not 220: "Every registered side, in one group" truncates below that,
                and the clause that truncates is the one carrying the constraint. */}
            <Select value={stage.entrants.kind} onChange={setEntrantKind} width={280} label="Teams">
              {ENTRANT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </Select>
            {stage.entrants.kind === 'seeded-split' && (
              <>
                <Select
                  value={stage.entrants.method}
                  onChange={(v) =>
                    onChange({
                      entrants: {
                        ...(stage.entrants as EntrantSpec & { kind: 'seeded-split' }),
                        method: v as 'blocks' | 'snake',
                      },
                    })
                  }
                  label="Seeding method"
                >
                  <option value="blocks">Top-down</option>
                  <option value="snake">Snake</option>
                </Select>
                <InfoDot
                  title="Seeding method — how seeds fill the groups"
                  options={[
                    {
                      label: 'Top-down',
                      desc: ENTRANT_KINDS['seeded-split-blocks'].does,
                      eg: ENTRANT_KINDS['seeded-split-blocks'].eg,
                    },
                    {
                      label: 'Snake',
                      desc: ENTRANT_KINDS['seeded-split-snake'].does,
                      eg: ENTRANT_KINDS['seeded-split-snake'].eg,
                    },
                  ]}
                />
              </>
            )}
          </div>
          {stage.entrants.kind !== 'all-registered' && (
            <div style={{ marginTop: 8 }}>
              <GroupPlanEditor
                plan={stage.entrants.groups}
                onChange={(groups) =>
                  onChange({ entrants: { ...stage.entrants, groups } as EntrantSpec })
                }
              />
            </div>
          )}
          {/* There is no group-count control above, because this kind has nowhere to put
              one. Say where the control went, rather than leaving its absence to be read
              as "groups aren't configurable". */}
          {stage.entrants.kind === 'all-registered' && (
            <p style={HINT}>
              One group of everyone — this kind can&apos;t be split, and switching to it discards
              any group plan. To make groups, choose <strong>Seeded into groups</strong>: with no
              seeding supplied it blocks the registration order, which is the same list this stage
              already draws on.
            </p>
          )}
          {/* The exact state that produced the bug report: a stage named for two groups
              that puts everyone in one. Caught at design time, where it is free to fix. */}
          {stage.entrants.kind === 'all-registered' && (stage.groupLabels?.length ?? 0) > 1 && (
            <div style={{ ...ERR, lineHeight: 1.5 }}>
              This stage names {stage.groupLabels!.length} groups, but every registered side goes
              into one — the names are never used.{' '}
              <Btn tone="outline" size="sm" onClick={() => setEntrantKind('seeded-split')}>
                Split into {stage.groupLabels!.length} groups
              </Btn>
            </div>
          )}
          {stage.entrants.kind === 'manual' && index > 0 && (
            <DerivationEditor stage={stage} earlierStages={earlierStages} onChange={onChange} />
          )}

          <SectionHead
            info={
              <InfoDot title="Group names">
                <p>
                  What each group is called — these labels show on the admin’s “confirm entrants”
                  screen and on fixtures (e.g. <strong>Top Six</strong>, <strong>Bottom Six</strong>
                  ). Leave blank to fall back to Group A, Group B…
                </p>
              </InfoDot>
            }
          >
            Group names
          </SectionHead>
          <input
            className="field-input"
            value={labelText}
            placeholder="Top Six, Bottom Six"
            onChange={(e) => {
              setLabelText(e.target.value);
              onChange({
                groupLabels: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              });
            }}
          />
          <p style={HINT}>Comma-separated. Blank falls back to Group A, Group B…</p>

          <SectionHead
            info={
              <InfoDot title="Schedule — when this stage is played">
                <p>
                  The first dropdown is the <strong>playing block</strong> — which block of the
                  season calendar this stage runs in. A structure binds to blocks{' '}
                  <strong>by position</strong> (first block, second block…), so the calendar it’s
                  later paired with decides the actual dates.
                </p>
                <p>The second is the cadence — how often rounds are played inside that block.</p>
              </InfoDot>
            }
          >
            Schedule
          </SectionHead>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Select
              value={String(stage.schedule.blockIndex)}
              onChange={(v) => onChange({ schedule: { ...stage.schedule, blockIndex: Number(v) } })}
              width={240}
              label="Playing block"
            >
              {/* The stage's own position, kept selectable even when it doesn't exist on
                  the calendar being previewed — dropping it would silently rewrite the
                  stage to whatever the select falls back to, the moment the operator
                  opens a picker that was never meant to touch it. Worded two ways: with
                  no calendar chosen there's nothing to compare against, so it's a plain
                  ordinal; with one chosen but too short, say so. */}
              {offCalendar && (
                <option value={String(stage.schedule.blockIndex)}>
                  {calendar
                    ? `${ordinal(stage.schedule.blockIndex)} block (this calendar has fewer blocks)`
                    : `${ordinal(stage.schedule.blockIndex)} block`}
                </option>
              )}
              {(calendar?.blocks ?? []).map((b, i) => (
                <option key={b.id} value={String(i)}>
                  {`${ordinal(i)} block — ${b.label} · ${formatIsoDate(b.start)} → ${formatIsoDate(b.end)}`}
                </option>
              ))}
            </Select>
            <Select value={stage.schedule.cadence.kind} onChange={setCadence} label="Cadence">
              {CADENCE_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </Select>
            {stage.schedule.cadence.kind === 'every-n-weeks' && (
              <BoundedNumber
                min={1}
                max={12}
                style={{ width: 80 }}
                value={stage.schedule.cadence.n}
                onChange={(n) =>
                  onChange({
                    schedule: {
                      ...stage.schedule,
                      cadence: { kind: 'every-n-weeks', n },
                    },
                  })
                }
              />
            )}
            <InfoDot
              title="Cadence — how often rounds are played"
              options={CADENCE_OPTIONS.map((o) => ({ label: o.label, desc: o.help, eg: o.eg }))}
            />
          </div>
          <p style={HINT}>
            {CADENCE_OPTIONS.find((o) => o.key === stage.schedule.cadence.kind)?.help}
          </p>
          {stage.schedule.cadence.kind === 'weekdays' && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {WEEKDAY_LABELS.map((label, day) => {
                const days = (stage.schedule.cadence as { days: Weekday[] }).days ?? [];
                const on = days.includes(day as Weekday);
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() =>
                      onChange({
                        schedule: {
                          ...stage.schedule,
                          cadence: {
                            kind: 'weekdays',
                            days: on
                              ? days.filter((d) => d !== day)
                              : [...days, day as Weekday].sort((a, b) => a - b),
                          },
                        },
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
          {/* Chaining. Every stage dates from its block's start by default, so pools and
              their semi-finals sharing one block would overlap; ticking this moves this
              stage's rounds past the previous stage's last round, on the same playing day.
              Enabled only when there IS an earlier stage in the block — and kept
              clickable while ticked, so a stage that lost its feeder (moved block,
              reordered) can still be unticked. */}
          <label
            style={{
              fontSize: 12.5,
              display: 'inline-flex',
              gap: 6,
              alignItems: 'center',
              marginTop: 10,
            }}
          >
            <input
              type="checkbox"
              checked={chained}
              disabled={!feeder && !chained}
              onChange={(e) => {
                const { startAfter: _startAfter, ...rest } = stage.schedule;
                onChange({
                  schedule: e.target.checked ? { ...rest, startAfter: 'previous-stage' } : rest,
                });
              }}
            />
            Start after the previous stage in this block
            <InfoDot title="Start after the previous stage">
              <p>
                Lets two stages share one playing block without overlapping — groups, then their
                semi-finals and final. This stage&apos;s rounds begin after the previous stage in
                the same block finishes, still on the block&apos;s usual playing day.
              </p>
            </InfoDot>
          </label>
          {chained && !feeder ? (
            <div style={ERR}>
              No earlier stage plays in this block any more — untick this, or move the stage back
              into its feeder&apos;s block.
            </div>
          ) : (
            <p style={HINT}>
              {feeder
                ? chained
                  ? `Rounds begin after "${feeder.name || 'the previous stage'}" finishes.`
                  : `"${feeder.name || 'An earlier stage'}" also plays this block — tick this to follow it rather than overlap it.`
                : 'No earlier stage plays this block, so this stage starts at the block start.'}
            </p>
          )}
          <div style={{ marginTop: 10 }}>
            <label
              style={{
                fontSize: 12.5,
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                marginBottom: 4,
              }}
            >
              Time slots
              <InfoDot
                title="Time slots — start times on a playing day"
                options={[
                  {
                    label: 'No set times',
                    desc: 'Fixtures carry a date but no fixed start time — clubs sort it out.',
                  },
                  {
                    label: 'Morning & afternoon starts',
                    desc: 'Matches are stamped with alternating start times, cycled across the day’s fixtures.',
                    eg: '08:00 morning / 13:30 afternoon for a T20 Pink Ball day',
                  },
                  {
                    label: 'AM + PM double-headers',
                    desc: 'Each playing day hosts two full rounds — every side plays a morning and an afternoon match.',
                    eg: 'a festival day where each team plays twice',
                  },
                ]}
              />
            </label>
            <Choice
              value={
                !stage.schedule.slots
                  ? 'No set times'
                  : stage.schedule.roundsPerDay === 2
                    ? 'AM + PM double-headers'
                    : 'Morning & afternoon starts'
              }
              onChange={(v) => {
                if (v === 'No set times') {
                  // Remove both keys entirely — the server (and the planner) treat
                  // absent `slots`/`roundsPerDay` as "no slots"; persisting empty/zero
                  // values is a different, invalid state, not merely an empty one.
                  const { slots: _slots, roundsPerDay: _rpd, ...rest } = stage.schedule;
                  onChange({ schedule: rest });
                } else if (v === 'Morning & afternoon starts') {
                  const { roundsPerDay: _rpd, ...rest } = stage.schedule;
                  onChange({ schedule: { ...rest, slots: stage.schedule.slots ?? pendingSlots } });
                } else {
                  onChange({
                    schedule: {
                      ...stage.schedule,
                      slots: stage.schedule.slots ?? pendingSlots,
                      roundsPerDay: 2,
                    },
                  });
                }
              }}
              options={['No set times', 'Morning & afternoon starts', 'AM + PM double-headers']}
            />
            {stage.schedule.slots && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                {stage.schedule.slots.map((slot, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      className="field-input"
                      style={{ width: 120 }}
                      value={slot.label}
                      placeholder="Morning"
                      onChange={(e) => setSlot(i, { label: e.target.value })}
                    />
                    <input
                      className="field-input"
                      type="time"
                      style={{ width: 110 }}
                      value={slot.start}
                      onChange={(e) => setSlot(i, { start: e.target.value })}
                    />
                  </div>
                ))}
              </div>
            )}
            <p style={HINT}>
              Two starts per playing day, cycled across the stage's matches — e.g. 08:00 morning /
              13:30 afternoon for T20 Pink Ball.
            </p>
            {stage.schedule.roundsPerDay === 2 && (
              <p style={HINT}>
                Each playing day hosts two full rounds — every side plays a morning and an afternoon
                match.
              </p>
            )}
          </div>
          <div style={{ marginTop: 10 }}>
            <label
              style={{
                fontSize: 12.5,
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                marginBottom: 4,
              }}
            >
              Activate from (optional)
              <InfoDot title="Activate from">
                <p>
                  Fixtures are generated now but stay <strong>hidden from clubs</strong> until this
                  date. Leave it blank to show them straight away. Handy for a junior league that
                  only starts after the mid-season break.
                </p>
              </InfoDot>
            </label>
            <input
              className="field-input"
              type="date"
              style={{ maxWidth: 200 }}
              value={stage.schedule.activateFrom ?? ''}
              onChange={(e) =>
                onChange({
                  schedule: { ...stage.schedule, activateFrom: e.target.value || undefined },
                })
              }
            />
            <p style={HINT}>
              Fixtures generate now but stay hidden from clubs until this date — junior leagues that
              only start after the break.
            </p>
          </div>

          {/* Per-stage fit, right where the cadence was just changed. */}
          <div
            style={{
              marginTop: 14,
              padding: '10px 12px',
              borderRadius: 8,
              fontSize: 12.5,
              border: '1px solid var(--line)',
              background: !fit || fit.fits ? 'var(--paper)' : 'var(--coral-pale, #FDECEA)',
              color: !fit || fit.fits ? 'var(--muted)' : 'var(--coral)',
            }}
          >
            {!calendar
              ? 'Pick a calendar above to check this stage fits.'
              : offCalendar
                ? // Not `fit.summary` — that says "no longer exists on this calendar",
                  // which is true of the previewed calendar and reads as data loss.
                  // Nothing is lost; the preview is pointed elsewhere.
                  `This stage plays block position ${stage.schedule.blockIndex + 1}, which ${calendar.label} doesn't have. Switch "Show dates from" back, or pick a block on this calendar.`
                : `${rounds} round${rounds === 1 ? '' : 's'} per group at ${perGroup} teams · ${fit?.summary}`}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The derivation editor. A stage whose teams depend on earlier results can't resolve
 * itself — the platform has no ladder — so what's captured here is the RULE, in the
 * operator's own words. That sentence is what the admin sees when confirming entrants,
 * so it has to be worth reading.
 */
function DerivationEditor({
  stage,
  earlierStages,
  onChange,
}: {
  stage: StageSpec;
  earlierStages: StageSpec[];
  onChange: (patch: Partial<StageSpec>) => void;
}) {
  if (stage.entrants.kind !== 'manual') return null;
  const note = stage.entrants.derivedFrom;
  const entrants = stage.entrants;

  const update = (patch: Record<string, unknown> | undefined) =>
    onChange({
      entrants: {
        ...entrants,
        derivedFrom: patch
          ? ({
              rule: 'from-standings',
              fromStage: earlierStages[earlierStages.length - 1]?.id ?? '',
              detail: '',
              ...note,
              ...patch,
            } as NonNullable<typeof note>)
          : undefined,
      },
    });

  return (
    <div style={{ marginTop: 10 }}>
      <label style={{ fontSize: 12.5, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={!!note}
          onChange={(e) => update(e.target.checked ? {} : undefined)}
        />
        Teams come from an earlier stage
        <InfoDot title="Derived entrants">
          <p>
            Instead of drawing from the full registration list, this stage takes its teams from an
            earlier stage’s results — set which earlier stage and the rule for carrying them over.
          </p>
        </InfoDot>
      </label>
      {note && (
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Select
              value={note.rule}
              onChange={(v) => update({ rule: v })}
              width={190}
              label="Rule"
            >
              <option value="from-standings">Top finishers</option>
              <option value="swap">Swap between groups</option>
              <option value="winners-of">Winners of</option>
              <option value="carry-forward">Carried forward</option>
            </Select>
            <InfoDot
              title="Rule — how teams carry over"
              options={[
                {
                  label: 'Top finishers',
                  desc: 'The highest-placed sides in the earlier stage’s standings advance.',
                  eg: 'the top 4 of a group go through to the finals',
                },
                {
                  label: 'Swap between groups',
                  desc: 'Groups exchange sides by position — the bottom of the top group swaps with the top of the bottom group.',
                  eg: '11th–12th of the Top Six swap with 1st–2nd of the Bottom Six',
                },
                {
                  label: 'Winners of',
                  desc: 'The winners of earlier fixtures come through — a knockout bracket.',
                  eg: 'the two semi-final winners meet in the final',
                },
                {
                  label: 'Carried forward',
                  desc: 'A whole group continues into this stage unchanged.',
                  eg: 'the same Top Six plays a second round',
                },
              ]}
            />
            <Select
              value={note.fromStage}
              onChange={(v) => update({ fromStage: v })}
              width={200}
              label="Draws from"
            >
              <option value="">Pick the earlier stage…</option>
              {earlierStages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          <input
            className="field-input"
            value={note.detail}
            placeholder="Last in the top group swaps with first in the bottom group"
            onChange={(e) => update({ detail: e.target.value })}
          />
          <label style={{ fontSize: 12.5, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={!!note.carryPoints}
              onChange={(e) => update({ carryPoints: e.target.checked })}
            />
            Points move with the position, not the team
          </label>
          <p style={{ ...HINT, marginTop: 0 }}>
            This sentence is shown to the administrator when they confirm which teams play, so write
            it the way you&apos;d say it out loud.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              Qualifiers per group
              <InfoDot title="Qualifiers per group">
                <p>
                  How many sides go through from <strong>each</strong> group of the earlier stage —
                  2 means the top two of every group. Leave it blank when the number isn&apos;t
                  fixed.
                </p>
              </InfoDot>
            </span>
            <OptionalCount
              min={1}
              max={8}
              label="Qualifiers per group"
              value={note.qualifiersPerGroup}
              onChange={(q) => {
                // Blank REMOVES the key — an absent count is "not declared", which keeps
                // the preview's "up to" hedge; persisting 0 would be a different, invalid
                // value the server rejects.
                const { qualifiersPerGroup: _q, ...rest } = note;
                onChange({
                  entrants: {
                    ...entrants,
                    derivedFrom: q === undefined ? rest : { ...rest, qualifiersPerGroup: q },
                  },
                });
              }}
            />
          </div>
          <p style={{ ...HINT, marginTop: 0 }}>
            Makes the preview exact and pre-fills the confirmation form — you still confirm the
            finishing order.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * A whole-number box that may be left BLANK — `BoundedNumber` always holds a value, which
 * is wrong for a count that is optional by design. Same keystroke discipline: publish
 * only in-range values while typing, settle on the nearest legal one on blur; blank
 * publishes `undefined`.
 */
function OptionalCount({
  value,
  onChange,
  min,
  max,
  label,
}: {
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  min: number;
  max: number;
  label: string;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  // Re-seed when the model changes from outside, not from our own keystrokes.
  const [published, setPublished] = useState(value);
  if (value !== published) {
    setPublished(value);
    setText(value === undefined ? '' : String(value));
  }
  const publish = (n: number | undefined) => {
    setPublished(n);
    if (n !== value) onChange(n);
  };
  return (
    <input
      type="number"
      className="field-input"
      style={{ width: 80 }}
      aria-label={label}
      placeholder="—"
      min={min}
      max={max}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (!e.target.value.trim()) return publish(undefined);
        const n = parseInt(e.target.value, 10);
        if (Number.isFinite(n) && n >= min && n <= max) publish(n);
      }}
      onBlur={(e) => {
        if (!e.target.value.trim()) return;
        const n = parseInt(e.target.value, 10);
        const next = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value;
        setText(next === undefined ? '' : String(next));
        publish(next);
      }}
    />
  );
}

/* ─── Preview rail ─── */

function PreviewRail({
  structure,
  calendar,
  previews,
  previewTeams,
  onPreviewTeams,
}: {
  structure: CompetitionStructure;
  calendar: SeasonCalendar | undefined;
  /** `previewStages` over this structure — one per stage, in order. */
  previews: StagePreview[];
  previewTeams: number;
  onPreviewTeams: (n: number) => void;
}) {
  const rows = structure.stages.map((stage, i) => {
    const { sizes, derived, fits, plan } = previews[i];
    const perGroup = sizes[0] ?? previewTeams;
    const rounds = previewRounds(stage, perGroup);
    const note = stage.entrants.kind === 'manual' ? stage.entrants.derivedFrom : undefined;
    const feeder = chainFeeder(stage, structure.stages);
    // Counted from the REAL generator over placeholder entrants, not re-derived: the old
    // `perGroup - 1` was right only for a plain knockout — it previewed a single-match
    // stage of six as five fixtures, and was one short for a third-place playoff.
    const fixturesIn = (n: number) =>
      roundsForFormat(
        stage.format,
        Array.from({ length: n }, (_, i) => `t${i + 1}`),
      ).flat().length;
    // Summed PER GROUP, because groups differ in size. Multiplying the first group's
    // count by the number of groups overstated exactly the case exact sizes exist for:
    // 5, 5, 5, 4 as a double round robin is 20+20+20+12 = 72, not 4 × 20 = 80.
    const total = sizes.reduce((n, size) => n + fixturesIn(size), 0);
    return {
      stage,
      sizes,
      rounds,
      // `fits` is the whole stage (every group); `plan` carries the sentence to show.
      fit: plan ? { fits, summary: plan.summary } : null,
      total,
      derived,
      // "Exactly 4 sides — the top 2 of each of Pool stage's 2 groups."
      qualified: derived
        ? {
            count: sizes.reduce((a, b) => a + b, 0),
            q: note?.qualifiersPerGroup ?? 0,
            source: structure.stages.find((s) => s.id === note?.fromStage),
          }
        : undefined,
      feeder,
      shapeErr: breaksWithinPoolShape(stage, structure.stages),
      // A stage that produces nothing must not read as "fits". Splitting 20 teams into
      // 20 groups leaves a group of one, which plays nobody — the block is trivially
      // satisfied and the season is silently empty. Worth its own message.
      //
      // `manual` is exempt: it generates no fixtures BY DESIGN and the admin enters them
      // afterwards, so counting them here would flag a perfectly good structure as broken
      // — the same mistake `materialiseStage` documents and guards against, one layer up.
      // …and a group too small to play anyone is the same failure even when the OTHER
      // groups produce fixtures, so this asks about the sizes rather than the total.
      // Reconciling 5, 5, 5, 4 down to 12 preview teams yields a group of 0, which read
      // "5 groups of 5, 5, 5, 0 · ✓ Fits" because the total was comfortably non-zero.
      empty: stage.format.kind !== 'manual' && (total === 0 || sizes.some((n) => n < 2)),
      byHand: stage.format.kind === 'manual',
      // A pool-driven bracket (cross- or within-group) is sized by the QUALIFIERS the
      // previous stage sends, not by everyone entered. Unless the structure states how
      // many qualify (`qualifiersPerGroup` — then `derived` and the number is exact), the
      // number here is an upper bound (worst case: everybody goes through), which is the
      // safe direction for a "does it fit the block" check but has to be labelled or an
      // operator will read it as the real round count.
      qualifierBound: isPoolKnockout(stage.format) && rounds > 0 && !derived,
      block: calendar ? findBlock(calendar, stage.schedule.blockIndex)?.label : undefined,
      // Out of range for the previewed calendar. True with no calendar selected too: see
      // the note on `offCalendar` in StageRow.
      offCalendar: !calendar || stage.schedule.blockIndex >= calendar.blocks.length,
    };
  });
  const anyEmpty = rows.some((r) => r.empty);
  const anyShapeErr = rows.some((r) => r.shapeErr);
  // Only a verdict when there is a calendar to be off. With none selected the rows still
  // say where each block lives — that is useful — but "stages play on a DIFFERENT
  // calendar" is a claim about a comparison nobody made, and the footer already defers to
  // "No calendar selected" below.
  const anyOffCalendar = !!calendar && rows.some((r) => r.offCalendar);
  const ok =
    !anyEmpty && !anyShapeErr && !anyOffCalendar && rows.every((r) => !r.fit || r.fit.fits);
  const grandTotal = rows.reduce((n, r) => n + r.total, 0);

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: 14,
        background: 'var(--paper)',
        position: 'sticky',
        top: 0,
        alignSelf: 'flex-start',
      }}
    >
      <div style={{ ...SECTION, margin: '0 0 8px' }}>Preview</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <BoundedNumber
          min={2}
          max={200}
          style={{ width: 80 }}
          value={previewTeams}
          onChange={onPreviewTeams}
        />
        <span style={{ fontSize: 12, color: 'var(--muted-2)' }}>teams entered</span>
      </div>

      {rows.map((r, i) => (
        <div
          key={r.stage.id}
          style={{ paddingBottom: 10, marginBottom: 10, borderBottom: '1px solid var(--line2)' }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 3 }}>
            {i + 1}. {r.stage.name || 'Untitled'}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            {r.sizes.length} group{r.sizes.length === 1 ? '' : 's'} of {r.sizes.join(', ')} ·{' '}
            {r.byHand
              ? 'fixtures entered by hand'
              : `${r.total} fixture${r.total === 1 ? '' : 's'}`}
            <br />
            {r.qualifierBound ? 'up to ' : ''}
            {r.rounds} round{r.rounds === 1 ? '' : 's'} ×{' '}
            {describeCadence(r.stage.schedule.cadence)}
            {r.block ? ` · ${r.block}` : ''}
            {r.feeder ? `, after ${r.feeder.name || 'the previous stage'}` : ''}
            {r.qualifierBound && (
              <>
                <br />
                <em>Sized by how many qualify from the stage before.</em>
              </>
            )}
            {r.qualified && (
              <>
                <br />
                <em>
                  Exactly {r.qualified.count} side{r.qualified.count === 1 ? '' : 's'} — the top{' '}
                  {r.qualified.q} of each group in {r.qualified.source?.name || 'the stage before'}.
                </em>
              </>
            )}
          </div>
          {r.empty && (
            <div style={{ ...ERR, marginTop: 6, lineHeight: 1.5 }}>
              {r.sizes.some((n) => n < 2)
                ? r.qualified
                  ? `A group needs at least two teams — only ${r.qualified.count} qualify, split ${r.sizes.join(', ')}.`
                  : `A group needs at least two teams — this splits ${previewTeams} into ${r.sizes.join(', ')}.`
                : 'This stage generates no fixtures.'}
            </div>
          )}
          {r.shapeErr && (
            <div style={{ ...ERR, marginTop: 6, lineHeight: 1.5 }}>
              Within-group semi-finals need 2 groups × 2 qualifiers in this version — draw this
              stage from a 2-group stage and set 2 qualifiers per group.
            </div>
          )}
          {r.offCalendar ? (
            <div style={{ ...ERR, marginTop: 6, lineHeight: 1.5 }}>
              Plays block position {r.stage.schedule.blockIndex + 1}
              {calendar ? `, which ${calendar.label} doesn't have.` : '.'}
            </div>
          ) : (
            !r.empty &&
            r.fit &&
            !r.fit.fits && (
              <div style={{ ...ERR, marginTop: 6, lineHeight: 1.5 }}>{r.fit.summary}</div>
            )
          )}
        </div>
      ))}

      <div
        style={{
          fontSize: 12.5,
          fontWeight: 700,
          color: ok ? 'var(--green)' : 'var(--coral)',
        }}
      >
        {ok
          ? `✓ Fits · ${grandTotal} fixtures across ${rows.length} stage${rows.length === 1 ? '' : 's'}`
          : anyOffCalendar
            ? '⚠ One or more stages play on a different calendar'
            : anyEmpty
              ? '⚠ One or more stages generate no fixtures'
              : anyShapeErr
                ? '⚠ A within-group knockout can’t be drawn as set up'
                : '⚠ One or more stages don’t fit their block'}
      </div>
      {!calendar && (
        <p style={HINT}>No calendar selected — fit can&apos;t be checked until one is.</p>
      )}
    </div>
  );
}

/* ─── Structure editor ─── */

function StructureEditor({
  initial,
  calendars,
  bindings = [],
  onSave,
  onClose,
  toast,
}: {
  initial: CompetitionStructure;
  calendars: SeasonCalendar[];
  /**
   * The competitions that bind this structure, and the calendar each one names.
   *
   * Load-bearing twice over: it is the best signal for which calendar to EDIT against
   * (the server only accepts blocks that are on the bound calendar), and it is what lets
   * the editor refuse a save the API would reject for the whole tenant.
   */
  bindings?: Array<{ league: string; competition: string; calendarId: string }>;
  onSave: (s: CompetitionStructure) => Promise<void>;
  onClose: () => void;
  toast: Toast;
}) {
  const [draft, setDraft] = useState<CompetitionStructure>(initial);
  // A structure carries no calendar identity of its own any more, so there is nothing
  // stored to reopen against — only the tenant's own calendar or the binding(s) that use
  // this structure can suggest one. See `resolvePreviewCalendarId`.
  const [calendarId, setCalendarId] = useState(() =>
    resolvePreviewCalendarId(
      undefined,
      calendars,
      bindings.map((b) => b.calendarId),
    ),
  );
  /**
   * Did the operator pick "No calendar", or did resolution fail to name one?
   *
   * Both are `calendarId === ''` and they mean opposite things. Resolution returning
   * nothing is a question the console has to ask; the operator choosing nothing is an
   * answer it has to respect. Without this the ambiguity banner fired on a deliberate
   * "No calendar" and asserted that no calendar accounted for the blocks — directly
   * above its own detail line naming the one that does.
   */
  const [calendarChosen, setCalendarChosen] = useState(false);
  const pickCalendar = (id: string) => {
    setCalendarChosen(true);
    setCalendarId(id);
  };
  const [previewTeams, setPreviewTeams] = useState(DEFAULT_PREVIEW_TEAMS);
  const [expanded, setExpanded] = useState<string | null>(initial.stages[0]?.id ?? null);
  const [saveErr, setSaveErr] = useState('');
  const [busy, setBusy] = useState(false);
  const calendar = calendars.find((c) => c.id === calendarId);

  const patchStage = (i: number, patch: Partial<StageSpec>) =>
    setDraft((d) => ({
      ...d,
      stages: d.stages.map((s, j) => (i === j ? { ...s, ...patch } : s)),
    }));

  const moveStage = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const j = i + dir;
      if (j < 0 || j >= d.stages.length) return d;
      const stages = [...d.stages];
      [stages[i], stages[j]] = [stages[j], stages[i]];
      return { ...d, stages };
    });

  /**
   * A stage may only derive from one BEFORE it — a forward or self reference is a cycle,
   * and the API rejects it. Checked here too so the operator sees it inline rather than
   * as a round-trip 400, and because reordering stages is the easy way to create one.
   */
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push('Give the structure a name.');
  if (draft.stages.length === 0) errors.push('Add at least one stage.');
  const seen = new Set<string>();
  for (const s of draft.stages) {
    if (!s.name.trim()) errors.push('Every stage needs a name.');
    // No "needs a playing block" check any more — `blockIndex` is a plain number and
    // always has a value (defaulting to 0), so there is no unset state left to catch
    // here. Whether that position actually exists on the bound calendar is the
    // off-calendar check below, which the server also enforces at save time.
    if (s.schedule.cadence.kind === 'weekdays' && !s.schedule.cadence.days.length)
      errors.push(`"${s.name}" needs at least one playing day.`);
    // Mirrors the server's own `assertValidTimeSlots` (config-validation.ts) so a bad
    // slot is caught inline rather than as a round-trip 400.
    for (const slot of s.schedule.slots ?? []) {
      if (!slot.label.trim()) errors.push(`"${s.name}" has a time slot without a label.`);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.start))
        errors.push(`"${s.name}" has a time slot without a valid HH:MM start.`);
    }
    const note = s.entrants.kind === 'manual' ? s.entrants.derivedFrom : undefined;
    // Two different mistakes, two different messages. An unpicked source (the "Pick the
    // earlier stage…" placeholder, `fromStage: ''`) is not the same as pointing at a
    // stage that comes later, and telling an operator the second when they did the first
    // sends them looking for a problem that isn't there.
    if (note && !note.fromStage)
      errors.push(`"${s.name || 'A stage'}" needs the earlier stage it draws from.`);
    else if (note && !seen.has(note.fromStage))
      errors.push(`"${s.name}" draws from a stage that doesn't come before it.`);
    // Both mirror `validateStructures`, so they're caught inline rather than as a 400.
    if (breaksWithinPoolShape(s, draft.stages))
      errors.push(`"${s.name || 'A stage'}": ${WITHIN_POOL_SHAPE}.`);
    if (s.schedule.startAfter && !chainFeeder(s, draft.stages))
      errors.push(
        `"${s.name || 'A stage'}" starts after the previous stage, but no earlier stage plays in its block.`,
      );
    seen.add(s.id);
  }

  /*
   * Cross-calendar blocks. Two checks, deliberately asymmetric.
   *
   * A stage whose STORED block isn't on the previewed calendar is NOT an error. The
   * server never validates blockIds for an unbound structure (`validateStructures`
   * doesn't look at them), so blocking here would be stricter than the API: it would stop
   * an operator renaming a structure or fixing a cadence while a control explicitly
   * labelled "Preview" happened to point elsewhere, and would make an imported structure
   * — whose blockIds are always foreign — unsaveable until every one was re-picked.
   * Turning a preview control into a save gate is a category error; the rail and the
   * per-stage banner say it loudly instead.
   *
   * What IS an error is a structure left SPLIT across calendars — some stages moved to
   * the previewed one and some not. Nothing can schedule that, and picking a block from
   * the previewed calendar is otherwise a perfectly good thing to do (it is how a
   * structure gets retargeted), so the mixture is the thing to catch rather than the
   * edit itself.
   *
   * And a bound competition on another calendar is a hard server rule
   * (`validateCompetitions`) that 400s the entire tenant PUT — discarding the whole edit
   * and naming a calendar the operator was never shown — so it is mirrored here, in the
   * operator's own words.
   */
  if (calendar) {
    // A structure SPLIT across calendars — some stages on the previewed one, some not.
    // No calendar can run it, and it is what the recording's operator was one click
    // from creating: switch the preview, then "fix" the blank picker on one stage and
    // leave the rest. All-on and all-off are both coherent and both allowed; only the
    // mixture is a structure nothing can schedule.
    const isSplit = (stages: StageSpec[]) => {
      const off = stagesOffCalendar(stages, calendar);
      return off.length > 0 && off.length < stages.length;
    };
    const off = stagesOffCalendar(draft.stages, calendar);
    const on = draft.stages.filter((s) => !off.includes(s));
    // Only a split THIS SESSION created. One that arrived already split is pre-existing
    // damage, and blocking on it would stop an operator renaming the structure or fixing
    // a cadence until they had first edited a stage they never came here to touch — the
    // same over-blocking the note above rejects for stored blocks generally. The banner
    // and the per-stage rows still say it; only Save stays open.
    if (isSplit(draft.stages) && !isSplit(initial.stages))
      errors.push(
        `This structure is split across calendars — ${on
          .map((s) => `"${s.name || 'a stage'}"`)
          .join(', ')} now ${on.length === 1 ? 'plays' : 'play'} on ${calendar.label} while ${off
          .map((s) => `"${s.name || 'a stage'}"`)
          .join(
            ', ',
          )} still ${off.length === 1 ? 'plays' : 'play'} elsewhere. Move them all or none.`,
      );
  }
  // Deduped by calendar: one structure is routinely bound by several leagues, and three
  // identical lines naming the same calendar is noise, not information.
  for (const calId of [...new Set(bindings.map((b) => b.calendarId))]) {
    const bound = calendars.find((c) => c.id === calId);
    if (!bound) continue;
    const orphans = stagesOffCalendar(draft.stages, bound);
    if (!orphans.length) continue;
    const who = bindings
      .filter((b) => b.calendarId === calId)
      .map((b) => `${b.competition} (${b.league})`)
      .join(', ');
    errors.push(
      `${orphans.map((s) => `"${s.name || 'A stage'}"`).join(', ')} ${
        orphans.length === 1 ? 'plays' : 'play'
      } in a block that isn't on ${bound.label} — the calendar ${who} uses. Saving would be rejected.`,
    );
  }

  // With no calendar selected, EVERY scheduled stage is off it — which is the honest
  // answer, and what makes the banner below appear for a structure whose calendar
  // couldn't be resolved rather than leaving the operator with silent blank pickers.
  //
  // There is no label-matching "Move to this calendar" remap any more: a `blockIndex` is
  // a bare position with no identity beyond "the Nth block of whatever calendar it's read
  // against", so there is nothing left to match a stage's OLD block against on the newly
  // previewed calendar — that entire retargeting feature depended on blockId's cross-
  // calendar identity, which the index model deliberately does not have.
  const offPreview = calendar ? stagesOffCalendar(draft.stages, calendar) : draft.stages;
  const previews = previewStages(draft, calendar, previewTeams);

  async function submit() {
    if (errors.length || busy) return;
    setSaveErr('');
    setBusy(true);
    try {
      const next: CompetitionStructure = { ...draft, name: draft.name.trim() };
      await onSave(next);
      toast(`${draft.name.trim()} · saved`);
      onClose();
    } catch (e) {
      setSaveErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setBusy(false);
    }
  }

  function copyJson() {
    navigator.clipboard
      ?.writeText(structureToJson(draft))
      .then(() => toast('Structure JSON copied'))
      .catch(() => toast('Could not copy', 'warn'));
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="field-label">
            Structure name <span className="req">*</span>
          </div>
          <input
            className="field-input"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="e.g. Split league with mid-season swap"
          />
        </div>
        <div>
          <div className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            Show dates from
            <InfoDot title="Show dates from">
              <p>
                A <strong>preview only</strong>. Structures don’t belong to a calendar — a stage
                binds to a block by position, and the real calendar is chosen when a league binds
                this structure. Pick one here just to see real dates and check the stages fit.
              </p>
            </InfoDot>
          </div>
          <Select value={calendarId} onChange={pickCalendar} width={260} label="Show dates from">
            <option value="">No calendar</option>
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {`${c.label} · ${calendarSpan(c)}`}
              </option>
            ))}
          </Select>
        </div>
        <Btn tone="outline" size="sm" onClick={copyJson}>
          Copy JSON
        </Btn>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 280px',
          gap: 18,
          marginTop: 18,
          alignItems: 'start',
        }}
        className="structure-editor-grid"
      >
        <div>
          {/* Nothing resolved: no calendar could be picked automatically — more than one
              on the tenant, and no competition binds this structure yet. "No calendar"
              would otherwise read as "you haven't picked one", while the real message is
              "we can't tell, and only you can say". */}
          {!calendar && !calendarChosen && offPreview.length > 0 && (
            <div
              style={{
                border: '1px solid var(--line)',
                borderLeft: '3px solid var(--coral, #C0392B)',
                borderRadius: 8,
                padding: '10px 12px',
                marginBottom: 10,
                fontSize: 12.5,
                lineHeight: 1.55,
              }}
            >
              Pick a calendar under <strong>Show dates from</strong> to check this structure&apos;s
              stages fit.
              <div style={{ ...HINT, marginTop: 6 }}>
                {offPreview
                  .map((s) => `${s.name || 'a stage'} → position ${s.schedule.blockIndex + 1}`)
                  .join(' · ')}
              </div>
            </div>
          )}
          {/* The preview is pointed at a calendar this structure doesn't live on. Say so
              once, at the top, with the way out — rather than leaving the operator to
              infer it from a column of identical per-stage errors. */}
          {calendar && offPreview.length > 0 && (
            <div
              style={{
                border: '1px solid var(--line)',
                borderLeft: '3px solid var(--coral, #C0392B)',
                borderRadius: 8,
                padding: '10px 12px',
                marginBottom: 10,
                fontSize: 12.5,
                lineHeight: 1.55,
              }}
            >
              {offPreview.length === 1 ? 'One stage plays' : `${offPreview.length} stages play`} a
              block position <strong>{calendar.label}</strong> doesn&apos;t have.
              {bindings.length > 0 ? (
                <div style={{ ...HINT, marginTop: 6 }}>
                  This structure is bound while{' '}
                  {[...new Set(bindings.map((b) => `${b.competition} (${b.league})`))].join(', ')}{' '}
                  {bindings.length === 1 ? 'uses' : 'use'}{' '}
                  {[...new Set(bindings.map((b) => b.calendarId))]
                    .map((id) => calendars.find((c) => c.id === id)?.label ?? id)
                    .join(', ')}
                  . Switch <strong>Show dates from</strong> back to{' '}
                  {[...new Set(bindings.map((b) => b.calendarId))]
                    .map((id) => calendars.find((c) => c.id === id)?.label ?? id)
                    .join(' or ')}{' '}
                  to keep editing it there — or change the competition&apos;s calendar first, or
                  clone this structure to run it here.
                </div>
              ) : (
                <div style={{ ...HINT, marginTop: 6 }}>Pick each stage&apos;s block by hand.</div>
              )}
            </div>
          )}
          {draft.stages.map((stage, i) => (
            <StageRow
              key={stage.id}
              stage={stage}
              index={i}
              total={draft.stages.length}
              calendar={calendar}
              earlierStages={draft.stages.slice(0, i)}
              preview={previews[i]}
              expanded={expanded === stage.id}
              onToggle={() => setExpanded(expanded === stage.id ? null : stage.id)}
              onChange={(patch) => patchStage(i, patch)}
              onRemove={() =>
                setDraft((d) => ({ ...d, stages: d.stages.filter((_, j) => j !== i) }))
              }
              onMove={(dir) => moveStage(i, dir)}
            />
          ))}
          <Btn
            tone="outline"
            size="sm"
            icon={Icon.Plus}
            onClick={() => {
              const stage = blankStage(calendar, `Stage ${draft.stages.length + 1}`);
              setDraft((d) => ({ ...d, stages: [...d.stages, stage] }));
              setExpanded(stage.id);
            }}
          >
            Add stage
          </Btn>
        </div>

        <PreviewRail
          structure={draft}
          calendar={calendar}
          previews={previews}
          previewTeams={previewTeams}
          onPreviewTeams={setPreviewTeams}
        />
      </div>

      {errors.map((e, i) => (
        <div key={i} style={ERR}>
          {e}
        </div>
      ))}
      {saveErr && <div style={ERR}>{saveErr}</div>}

      <div className="insights-callout" style={{ marginTop: 16 }}>
        Saving creates a <strong>new version</strong> of this structure. Any season already running
        keeps the version it started with, so your changes only affect seasons started from now on.
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <Btn tone="teal" onClick={submit} disabled={!!errors.length || busy}>
          {busy ? 'Saving…' : 'Save structure'}
        </Btn>
        <Btn tone="outline" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/* ─── Template / import picker ─── */

function StartPicker({
  calendars,
  onPick,
  onClose,
  toast,
}: {
  calendars: SeasonCalendar[];
  onPick: (s: CompetitionStructure) => void;
  onClose: () => void;
  toast: Toast;
}) {
  const [importing, setImporting] = useState(false);
  const [json, setJson] = useState('');
  const [err, setErr] = useState('');
  // Which calendar a NEW structure is built against. First is the right default here —
  // unlike the editor, there is no stored structure whose blocks could say otherwise —
  // and `instantiateTemplate` now records it, so the editor reopens on it rather than
  // having to re-derive it.
  const [calendarId, setCalendarId] = useState(calendars[0]?.id ?? '');
  const calendar = calendars.find((c) => c.id === calendarId) ?? calendars[0];
  const blockCount = calendar?.blocks?.length ?? 0;
  // With two or more blocks, picking a template first asks which block each stage plays
  // in (prefilled with the default rule). With one block there is nothing to choose, so
  // a template is picked in one click as before.
  const [chosen, setChosen] = useState<(typeof STRUCTURE_TEMPLATES)[number] | null>(null);
  const [placement, setPlacement] = useState<number[]>([]);
  function chooseTemplate(t: (typeof STRUCTURE_TEMPLATES)[number]) {
    if (blockCount < 2) {
      onPick(instantiateTemplate(t, calendar));
      return;
    }
    setChosen(t);
    setPlacement(defaultPlacement(t, blockCount));
  }

  function doImport() {
    const parsed = parseStructureJson(json);
    // Positive-first: with `strictNullChecks` off (see tsconfig.app.json's ratchet), TS
    // narrows a `false`-literal discriminant less reliably than a `true` one.
    if (parsed.ok === true) {
      toast(`${parsed.structure.name} · imported`);
      onPick(parsed.structure);
      return;
    }
    setErr(parsed.error);
  }

  if (importing) {
    return (
      <div>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
          Paste a structure exported from another client, or one prepared offline. A fresh id is
          minted on import, so pasting the same JSON twice gives you two structures.
        </p>
        <textarea
          className="field-textarea"
          rows={14}
          style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          value={json}
          onChange={(e) => {
            setJson(e.target.value);
            setErr('');
          }}
          placeholder='{ "name": "Split league", "stages": [ … ] }'
        />
        {err && <div style={ERR}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <Btn tone="teal" onClick={doImport} disabled={!json.trim()}>
            Import
          </Btn>
          <Btn tone="outline" onClick={() => setImporting(false)}>
            Back
          </Btn>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
        Build a structure yourself, or start from a template that already matches how the league
        runs. Either way, everything stays editable afterwards.
      </p>
      {calendars.length > 1 && (
        <div style={{ marginBottom: 14 }}>
          <div className="field-label">Season calendar</div>
          <Select
            value={calendarId}
            onChange={(v) => {
              setCalendarId(v);
              setChosen(null);
            }}
            width={240}
            label="Season calendar"
          >
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
          <p style={HINT}>New stages are scheduled against this calendar&apos;s blocks.</p>
        </div>
      )}

      {/* Primary path: build your own. Templates are the alternative, below. */}
      <div style={{ display: 'grid', gap: 10 }}>
        <button
          type="button"
          onClick={() => onPick(blankStructure(calendar))}
          style={{
            textAlign: 'left',
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            border: '2px solid var(--brand-primary, #16332B)',
            borderRadius: 10,
            padding: '14px 16px',
            background: 'var(--green-pale, #EAF3EE)',
            cursor: 'pointer',
          }}
        >
          <span
            style={{
              flex: '0 0 auto',
              width: 30,
              height: 30,
              borderRadius: 8,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--brand-primary, #16332B)',
              color: '#fff',
            }}
          >
            <Icon.Plus />
          </span>
          <span>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Build from scratch</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, marginTop: 2 }}>
              Start with one empty stage and shape every detail yourself. Best when no template
              quite fits.
            </div>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setImporting(true)}
          style={{
            textAlign: 'left',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '12px 14px',
            background: 'var(--white, #fff)',
            cursor: 'pointer',
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 3 }}>Import JSON</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            Paste a structure exported from another client, or one prepared offline.
          </div>
        </button>
      </div>

      <div style={{ ...SECTION, marginTop: 18 }}>Or start from a template</div>
      <div style={{ display: 'grid', gap: 10 }}>
        {STRUCTURE_TEMPLATES.map((t) => (
          <div key={t.id}>
            <button
              type="button"
              onClick={() => chooseTemplate(t)}
              aria-pressed={chosen?.id === t.id}
              style={{
                width: '100%',
                textAlign: 'left',
                border:
                  chosen?.id === t.id
                    ? '2px solid var(--brand-primary, #16332B)'
                    : '1px solid var(--line)',
                borderRadius: 10,
                padding: '12px 14px',
                background: 'var(--white, #fff)',
                cursor: 'pointer',
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 3 }}>{t.name}</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                {t.whenToUse}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted-2)', marginTop: 5 }}>
                {t.stages.length} stage{t.stages.length === 1 ? '' : 's'} · {t.examples}
              </div>
            </button>
            {chosen?.id === t.id && calendar && (
              <div style={{ padding: '10px 14px 4px' }}>
                {t.stages.map((stage, i) => (
                  <div
                    key={stage.id}
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      fontSize: 12.5,
                      marginBottom: 6,
                    }}
                  >
                    <span style={{ minWidth: 220 }}>
                      Stage {i + 1} · {stageTitle(stage.format)} · {stage.name}
                    </span>
                    <span style={{ color: 'var(--muted)' }}>plays in</span>
                    <Select
                      value={String(placement[i] ?? 0)}
                      onChange={(v) =>
                        setPlacement((prev) => prev.map((b, j) => (j === i ? Number(v) : b)))
                      }
                      label={`Stage ${i + 1} plays in`}
                    >
                      {calendar.blocks.map((b, bi) => (
                        <option key={b.id} value={String(bi)}>
                          {`Block ${bi + 1} — ${b.label} · ${formatIsoDate(b.start)} → ${formatIsoDate(b.end)}`}
                        </option>
                      ))}
                    </Select>
                  </div>
                ))}
                <p style={HINT}>
                  Two stages in the same block play one after the other: the later one starts after
                  the earlier one finishes.
                </p>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <Btn
                    tone="teal"
                    size="sm"
                    onClick={() => onPick(instantiateTemplate(t, calendar, undefined, placement))}
                  >
                    Use this template
                  </Btn>
                  <Btn tone="ghost" size="sm" onClick={() => setChosen(null)}>
                    Choose another
                  </Btn>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Btn tone="ghost" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/* ─── Card ─── */

export function StructuresCard({
  slug,
  config,
  save,
  toast,
}: {
  slug: string;
  config: TenantConfig;
  save: (p: Partial<TenantConfig>) => Promise<TenantConfig>;
  toast: Toast;
}) {
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<CompetitionStructure | null>(null);
  const [confirm, setConfirm] = useState<CompetitionStructure | null>(null);
  const structures = config.structures ?? [];
  const calendars = config.calendars ?? [];

  /** Rebuild-and-PUT against the server's latest list — same guard as LeaguesCard. */
  async function saveStructures(
    build: (fresh: CompetitionStructure[]) => CompetitionStructure[],
    fallback: string,
  ): Promise<void> {
    try {
      const current = await api.platformGetTenant(slug);
      await save({ structures: build(current.structures ?? []) });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : fallback, 'warn');
      throw e;
    }
  }

  const upsert = (structure: CompetitionStructure) =>
    saveStructures((fresh) => {
      const i = fresh.findIndex((s) => s.id === structure.id);
      if (i === -1) return [...fresh, structure];
      // Editing mints a new VERSION — but the number itself is SERVER-OWNED (ADR 0008
      // phase 1): the server deep-compares this against the stored structure and decides
      // whether anything actually changed. `save`'s response seeds the query cache, so
      // the real version flows back from there rather than being guessed here. Running
      // seasons hold their own snapshot, so this never reshapes a season in flight — it
      // only affects seasons started from here on.
      const next = [...fresh];
      next[i] = structure;
      return next;
    }, 'Could not save structure');

  async function onDelete(structure: CompetitionStructure) {
    setConfirm(null);
    try {
      // Cascade: the server 409s a delete while any league still binds the structure, so
      // the bindings come off in the SAME PUT. A RUNNING season is unaffected either
      // way — it holds its own snapshot; this only stops new seasons starting from it.
      const current = await api.platformGetTenant(slug);
      const patch: Partial<TenantConfig> = {
        structures: (current.structures ?? []).filter((s) => s.id !== structure.id),
      };
      const bound = (current.leagues ?? []).filter((l) =>
        (l.competitions ?? []).some((c) => c.structureId === structure.id),
      );
      if (bound.length > 0)
        patch.leagues = (current.leagues ?? []).map((l) =>
          bound.includes(l)
            ? {
                ...l,
                competitions: (l.competitions ?? []).filter((c) => c.structureId !== structure.id),
              }
            : l,
        );
      await save(patch);
      toast(`${structure.name} · deleted`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not delete', 'warn');
    }
  }

  const usedBy = (id: string) =>
    (config.leagues ?? []).filter((l) => (l.competitions ?? []).some((c) => c.structureId === id));

  /**
   * Every competition that binds a structure, flattened with the calendar it names.
   *
   * `usedBy` answers "which leagues" — enough for the delete guard, not enough for the
   * editor, which needs the CALENDAR to open against and to mirror the server's
   * bound-calendar rule. One structure is routinely bound by several leagues.
   */
  const bindingsFor = (id: string) =>
    (config.leagues ?? []).flatMap((l) =>
      (l.competitions ?? [])
        .filter((c) => c.structureId === id)
        .map((c) => ({ league: l.label, competition: c.label, calendarId: c.calendarId })),
    );

  /**
   * Blocks a bound competition's calendar doesn't have — the editor will refuse to save.
   * `needed` is read off the structure itself (its highest position + 1, not a stored
   * count), `has` off the first mismatched bound calendar found.
   */
  const mismatchFor = (s: CompetitionStructure): { needed: number; has: number } | null => {
    for (const id of [...new Set(bindingsFor(s.id).map((b) => b.calendarId))]) {
      const bound = calendars.find((c) => c.id === id);
      if (bound && stagesOffCalendar(s.stages, bound).length > 0) {
        const needed = Math.max(...s.stages.map((st) => st.schedule.blockIndex)) + 1;
        return { needed, has: bound.blocks.length };
      }
    }
    return null;
  };

  return (
    <Card
      title="Competition structures"
      sub="The stage pipelines leagues bind to — group phases, knockouts and the transitions between them. Editing one creates a new version; seasons already running keep the version they started with."
    >
      {structures.length === 0 ? (
        <EmptyState
          icon={Icon.Shield}
          title="No structures yet"
          sub="Most leagues are one flat round robin, but a split league or groups-then-knockout needs a structure. Start from a template that matches how the league actually runs."
          action={
            <Btn tone="teal" icon={Icon.Plus} onClick={() => setPicking(true)}>
              Create your first structure
            </Btn>
          }
        />
      ) : (
        <>
          <div className="tbl-w">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Structure</th>
                  <th>Stages</th>
                  <th>Version</th>
                  <th>Used by</th>
                  <th style={{ width: 130 }}></th>
                </tr>
              </thead>
              <tbody>
                {structures.map((s) => {
                  const leagues = usedBy(s.id);
                  const mismatch = mismatchFor(s);
                  return (
                    <tr key={s.id}>
                      <td>
                        <div style={{ fontWeight: 700 }}>{s.name}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>
                          {s.stages.map((st) => st.name).join(' → ')}
                        </div>
                      </td>
                      <td>
                        <Pill tone="muted">{s.stages.length}</Pill>
                      </td>
                      <td>
                        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>v{s.version}</span>
                      </td>
                      <td>
                        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                          {leagues.length ? leagues.map((l) => l.label).join(', ') : '—'}
                        </span>
                        {/* The calendar those competitions run on. A structure is only
                            valid against the calendar its blocks belong to, so which one
                            that is belongs beside the binding, not three clicks away. */}
                        {[...new Set(bindingsFor(s.id).map((b) => b.calendarId))].length > 0 && (
                          <div style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>
                            {[...new Set(bindingsFor(s.id).map((b) => b.calendarId))]
                              .map((id) => calendars.find((c) => c.id === id)?.label ?? id)
                              .join(', ')}
                          </div>
                        )}
                        {mismatch && (
                          <div style={{ marginTop: 4 }}>
                            <Pill tone="coral">{`needs ${mismatch.needed} blocks, calendar has ${mismatch.has}`}</Pill>
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                          <Btn tone="outline" size="sm" onClick={() => setEditing(s)}>
                            Edit
                          </Btn>
                          <Btn tone="ghost" size="sm" onClick={() => setConfirm(s)}>
                            Delete
                          </Btn>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 14 }}>
            <Btn tone="teal" size="sm" icon={Icon.Plus} onClick={() => setPicking(true)}>
              Create structure
            </Btn>
          </div>
        </>
      )}

      {picking && (
        <Modal
          title={
            <>
              Start a <em>structure</em>
            </>
          }
          onClose={() => setPicking(false)}
        >
          <StartPicker
            calendars={calendars}
            toast={toast}
            onPick={(s) => {
              setPicking(false);
              setEditing(s);
            }}
            onClose={() => setPicking(false)}
          />
        </Modal>
      )}

      {editing && (
        <Modal
          wide
          title={
            <>
              Edit <em>structure</em>
            </>
          }
          onClose={() => setEditing(null)}
        >
          <StructureEditor
            initial={editing}
            calendars={calendars}
            bindings={bindingsFor(editing.id)}
            onSave={upsert}
            onClose={() => setEditing(null)}
            toast={toast}
          />
        </Modal>
      )}

      {confirm &&
        createPortal(
          <div
            className="fix-confirm"
            onClick={(e) => e.target === e.currentTarget && setConfirm(null)}
          >
            <div className="fix-confirm-box">
              <div className="fix-confirm-icon danger">
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 2L22 21H2L12 2z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M12 9v5M12 17v.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <div className="fix-confirm-title">Delete “{confirm.name}”?</div>
              <div className="fix-confirm-body">
                {usedBy(confirm.id).length > 0 && (
                  <>
                    Also removes its competition from{' '}
                    <strong>
                      {usedBy(confirm.id)
                        .map((l) => l.label)
                        .join(', ')}
                    </strong>
                    .{' '}
                  </>
                )}
                Seasons already running keep their own copy and are unaffected.
              </div>
              <div className="fix-confirm-actions">
                <Btn tone="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Btn>
                <Btn tone="ink" onClick={() => onDelete(confirm)}>
                  Yes, delete
                </Btn>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </Card>
  );
}

/* ─── Competitions: binding a league to its format streams ─── */

/**
 * A league's format streams. This is the join that lets Premier Men run T20 Pink Ball and
 * 50 Over Red Ball side by side over the same twelve registered clubs — the thing the
 * pre-ADR-0008 model could not express at all, because a league could only be one thing.
 *
 * Kept next to structures rather than inside LeaguesCard: a competition is mostly a
 * pointer at a structure and a calendar, and this is where both are understood.
 */
export function CompetitionsEditor({
  league,
  config,
  onSave,
  onClose,
  toast,
}: {
  league: League;
  config: TenantConfig;
  onSave: (key: string, competitions: Competition[]) => Promise<void>;
  onClose: () => void;
  toast: Toast;
}) {
  const [draft, setDraft] = useState<Competition[]>(league.competitions ?? []);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const structures = config.structures ?? [];
  const calendars = config.calendars ?? [];

  const patch = (i: number, p: Partial<Competition>) =>
    setDraft((d) => d.map((c, j) => (i === j ? { ...c, ...p } : c)));

  const errors: string[] = [];
  for (const c of draft) {
    if (!c.label.trim()) errors.push('Every competition needs a label.');
    if (!c.structureId) errors.push(`"${c.label || 'A competition'}" needs a structure.`);
    if (!c.calendarId) errors.push(`"${c.label || 'A competition'}" needs a calendar.`);
  }
  if (new Set(draft.map((c) => c.label.trim())).size !== draft.length && draft.length)
    errors.push('Two competitions share a label.');

  async function submit() {
    if (errors.length || busy) return;
    setErr('');
    setBusy(true);
    try {
      await onSave(
        league.key,
        draft.map((c) => ({ ...c, label: c.label.trim() })),
      );
      toast(`${league.label} · competitions saved`);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setBusy(false);
    }
  }

  if (structures.length === 0 || calendars.length === 0) {
    return (
      <div>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          A competition points at a structure and a season calendar, so both have to exist first.{' '}
          {structures.length === 0 && 'No structures are configured yet. '}
          {calendars.length === 0 && 'No season calendars are configured yet. '}
          Set them up on this page, then come back.
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
    <div>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
        Format streams this league runs. Most leagues have one; a league that plays both a T20 and a
        50 Over competition over the same clubs has two, each with its own structure.
      </p>

      {draft.length === 0 && (
        <p style={{ ...HINT, marginTop: 0 }}>
          None yet — this league uses the flat create-series flow.
        </p>
      )}

      {draft.map((c, i) => (
        <div
          key={c.id}
          style={{
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: 12,
            marginBottom: 10,
            display: 'grid',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="field-input"
              style={{ flex: 1 }}
              placeholder="e.g. 50 Over (Red Ball)"
              value={c.label}
              onChange={(e) => patch(i, { label: e.target.value })}
            />
            <Btn
              tone="ghost"
              size="sm"
              onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
            >
              Remove
            </Btn>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Select
              value={c.structureId}
              onChange={(v) => patch(i, { structureId: v })}
              width={230}
            >
              <option value="">Structure…</option>
              {structures.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Select
              value={c.calendarId}
              onChange={(v) => patch(i, { calendarId: v })}
              width={220}
              label="Calendar"
            >
              <option value="">Calendar…</option>
              {calendars.map((cal) => (
                <option key={cal.id} value={cal.id}>
                  {`${cal.label} · ${calendarSpan(cal)}`}
                </option>
              ))}
            </Select>
            <input
              className="field-input"
              type="number"
              min={1}
              max={200}
              style={{ width: 90 }}
              placeholder="Overs"
              value={c.matchFormat?.overs ?? ''}
              onChange={(e) =>
                patch(i, {
                  matchFormat: { ...c.matchFormat, overs: +e.target.value || undefined },
                })
              }
            />
            <input
              className="field-input"
              style={{ width: 150 }}
              placeholder="Ball type"
              value={c.matchFormat?.ballType ?? ''}
              onChange={(e) =>
                patch(i, { matchFormat: { ...c.matchFormat, ballType: e.target.value } })
              }
            />
          </div>
        </div>
      ))}

      <Btn
        tone="outline"
        size="sm"
        icon={Icon.Plus}
        onClick={() =>
          setDraft((d) => [
            ...d,
            {
              id: newStructureId('comp'),
              label: '',
              structureId: structures[0]?.id ?? '',
              calendarId: calendars[0]?.id ?? '',
            },
          ])
        }
      >
        Add competition
      </Btn>

      {errors.map((e, i) => (
        <div key={i} style={ERR}>
          {e}
        </div>
      ))}
      {err && <div style={ERR}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
        <Btn tone="teal" onClick={submit} disabled={!!errors.length || busy}>
          {busy ? 'Saving…' : 'Save competitions'}
        </Btn>
        <Btn tone="outline" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/** Modal host so LeaguesCard doesn't need to know the structures vocabulary. */
export function CompetitionsModal({
  league,
  config,
  onSave,
  onClose,
  toast,
}: {
  league: League;
  config: TenantConfig;
  onSave: (key: string, competitions: Competition[]) => Promise<void>;
  onClose: () => void;
  toast: Toast;
}) {
  return (
    <Modal
      title={
        <>
          Competitions · <em>{league.label}</em>
        </>
      }
      onClose={onClose}
    >
      <CompetitionsEditor
        league={league}
        config={config}
        onSave={onSave}
        onClose={onClose}
        toast={toast}
      />
    </Modal>
  );
}

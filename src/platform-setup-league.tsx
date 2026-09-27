/**
 * Operator console — setting up ONE league: which structure it plays through, on which
 * season calendar. A league has at most one setup (`league.setup`), created and changed
 * only here: from the catalogue row ("Set up" / "Change setup") and, minus the calendar
 * pick, from the season wizard's per-league rows (`StructurePick`).
 *
 * Nothing is preselected: the old binding modal defaulted the structure and calendar to
 * the library's first entries, and a hurried Save bound a league to the wrong season. Both
 * choices start empty here and Save stays disabled until each is made.
 */
import { useState, type CSSProperties } from 'react';
import { Btn, InfoDot, Modal, OptionCards, type OptionCard } from './atoms';
import * as api from './api';
import { ApiError } from './api';
import { describeError } from './error-copy';
import {
  DEFAULT_PREVIEW_TEAMS,
  NON_OPERATOR_GROUPS,
  StageRow,
  StructureNarrative,
  TEMPLATE_CARDS,
  previewStages,
} from './platform-structures';
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
import type {
  CompetitionStructure,
  League,
  SeasonCalendar,
  StageSpec,
  TenantConfig,
} from './types';

type Toast = (m: string, t?: string) => void;
type Template = (typeof STRUCTURE_TEMPLATES)[number];

const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '8px 0 0' };

/**
 * Whether every stage of a structure fits `calendar`, previewed at a plausible size.
 *
 * Each stage is sized the way it will really play: split into its OWN groups (12 teams in
 * two pools is two groups of 6 — 5 rounds, not a flat 12's 11). A stage whose
 * DerivationNote counts qualifiers is left out of the sizes so `previewFitAll` sizes it
 * exactly, and chained stages are placed after their feeder, all in the one walk the
 * structure editor's preview rail also uses.
 */
export function fitVerdict(
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

/** Operator-authored: hand-made in the structures card or minted by a setup (ADR 0014). */
export const isOperatorStructure = (s: CompetitionStructure) =>
  s.source === undefined || s.source === 'operator';

/**
 * A league's own copy of a quick-start or migrated structure. Adopting one never shares
 * the admin-minted instance with another league: the copy gets a fresh id, is operator-
 * authored (no `source`, like a hand-made structure), and is named for the adopting league.
 */
export function cloneForLeague(
  league: League,
  original: CompetitionStructure,
): CompetitionStructure {
  // `source` is dropped so the copy reads as operator-authored, and `templateId` is
  // dropped so a league-named clone can never become a template pick's reuse prefill.
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
export function UncoveredLines({
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

/** Where a league's structure comes from — 'skip' is "nothing chosen yet". */
export type LeagueMode = 'skip' | 'template' | 'existing';

export interface LeagueChoice {
  mode: LeagueMode;
  /**
   * Built ONCE, at pick time (a template instance mints fresh ids), and held here rather
   * than recomputed on every render — recomputing would mint a new structure id per
   * keystroke and the id shown at review would never match the one written.
   */
  structure?: CompetitionStructure;
  /** A new template instance (written with the setup), not a library structure. */
  isNew?: boolean;
}

export const NO_CHOICE: LeagueChoice = { mode: 'skip' };

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
 * A pick's overrun of `calendar`, or null — for every mode: a template instance is placed
 * against the calendar at pick time, but "Adjust stages" or a later calendar change can
 * still leave a stage in a block the calendar doesn't have.
 */
export function pickOverrun(
  choice: LeagueChoice | undefined,
  calendar: SeasonCalendar | undefined,
): { block: number; has: number } | null {
  return calendar && choice?.structure ? blockOverrun(choice.structure, calendar) : null;
}

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
  calendar: SeasonCalendar | undefined;
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
 * The structure half of a league setup: template or library structure, what it does, and
 * whether it fits `calendar`. Shared by the setup dialog and the season wizard's rows.
 * With no calendar yet (the dialog before one is picked) it tells the story without dates
 * and holds the fit verdict back.
 */
export function StructurePick({
  league,
  calendar,
  structures,
  choice,
  onChange,
  resolveTemplate,
  adjust,
}: {
  league: League;
  calendar: SeasonCalendar | undefined;
  structures: CompetitionStructure[];
  choice: LeagueChoice;
  onChange: (c: LeagueChoice) => void;
  /** Resolves a template pick to a structure — reusing before minting (see the caller). */
  resolveTemplate: (t: Template) => { structure: CompetitionStructure; isNew: boolean };
  /** The wizard's inline "Adjust stages" over a new template instance. */
  adjust?: {
    /** Other leagues in this run holding the same new template instance. */
    sharedWith: string[];
    onUpdateStructure: (fn: (s: CompetitionStructure) => CompetitionStructure) => void;
  };
}) {
  const [adjusting, setAdjusting] = useState(false);
  // A library pick keeps its stages' block positions, so one playing past the calendar's
  // last block is a hard stop — the server would 400 the setup.
  const overrun = pickOverrun(choice, calendar);
  const verdict =
    calendar && choice.structure && !overrun ? fitVerdict(choice.structure, calendar) : null;

  return (
    <>
      <OptionCards
        name={`mode-${league.key}`}
        label={`Where ${league.label}'s structure comes from`}
        value={choice.mode === 'skip' ? null : choice.mode}
        onChange={(mode) => {
          setAdjusting(false);
          onChange({ mode });
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
              onChange({ mode: 'template', ...resolveTemplate(t) });
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
            onChange(s ? { mode: 'existing', structure: s, isNew: false } : { mode: 'existing' });
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
      {choice.structure && !overrun && (
        <div className="template-detail">
          <div className="stage-field-label">What {choice.structure.name} does</div>
          <StructureNarrative
            structure={choice.structure}
            calendar={calendar}
            teamCount={DEFAULT_PREVIEW_TEAMS}
            assumed
          />
          {choice.isNew ? (
            adjust && (
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
                {adjusting && adjust.sharedWith.length > 0 && (
                  <p style={HINT}>
                    {adjust.sharedWith.join(', ')} {adjust.sharedWith.length === 1 ? 'uses' : 'use'}{' '}
                    this structure too — changes here apply to every league on it.
                  </p>
                )}
                {adjusting && (
                  <AdjustStages
                    structure={choice.structure}
                    calendar={calendar}
                    onUpdate={adjust.onUpdateStructure}
                  />
                )}
              </>
            )
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
      {calendar && choice.structure && !overrun && (
        <UncoveredLines structure={choice.structure} calendar={calendar} />
      )}
    </>
  );
}

/** "<structure> · <calendar>" for a league's current setup, tolerating dangling ids. */
export function describeSetup(
  setup: NonNullable<League['setup']>,
  structures: CompetitionStructure[],
  calendars: SeasonCalendar[],
): string {
  const s = structures.find((x) => x.id === setup.structureId);
  const c = calendars.find((x) => x.id === setup.calendarId);
  return `${s?.name ?? 'a missing structure'} · ${c?.label ?? 'a missing calendar'}`;
}

/**
 * Set up (or change the setup of) one league. Saves with the house refetch-rebuild-PUT:
 * the league catalogue and structures are rebuilt from a FRESH read, so a concurrent edit
 * in another tab is never clobbered, and only this league's `setup` changes.
 */
export function SetupLeagueDialog({
  slug,
  config,
  league,
  save,
  toast,
  onClose,
}: {
  slug: string;
  config: TenantConfig;
  league: League;
  save: (p: Partial<TenantConfig>) => Promise<TenantConfig>;
  toast: Toast;
  onClose: () => void;
}) {
  const structures = config.structures ?? [];
  const calendars = config.calendars ?? [];
  const [choice, setChoice] = useState<LeagueChoice>(NO_CHOICE);
  const [calendarId, setCalendarId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const calendar = calendars.find((c) => c.id === calendarId);

  /** The template a NEW instance came from — its stages can still be placed. */
  const template =
    choice.isNew && choice.structure?.templateId
      ? findTemplate(choice.structure.templateId)
      : undefined;

  /**
   * A template pick REUSES before it mints: a structure already in the library from this
   * template (operator-authored) is the durable blueprint; otherwise a fresh instance,
   * placed by the default rule on the chosen calendar (re-placed if the calendar changes).
   */
  const resolveTemplate = (t: Template) => {
    const existing = structures.find((s) => isOperatorStructure(s) && s.templateId === t.id);
    if (existing) return { structure: existing, isNew: false };
    return {
      structure: instantiateTemplate(
        t,
        calendar,
        undefined,
        defaultPlacement(t, calendar?.blocks.length ?? 0),
      ),
      isNew: true,
    };
  };

  const pickCalendar = (id: string) => {
    setCalendarId(id);
    const next = calendars.find((c) => c.id === id);
    // A new template instance follows the calendar it will play on; library structures
    // keep their own block positions (and may overrun — said below).
    if (template && choice.structure)
      setChoice({
        ...choice,
        structure: {
          ...choice.structure,
          stages: applyPlacement(
            choice.structure.stages,
            defaultPlacement(template, next?.blocks.length ?? 0),
          ),
        },
      });
  };

  const placeStage = (stageIndex: number, blockIndex: number) => {
    if (!choice.structure) return;
    const placement = choice.structure.stages.map((st, i) =>
      i === stageIndex ? blockIndex : st.schedule.blockIndex,
    );
    setChoice({
      ...choice,
      structure: {
        ...choice.structure,
        stages: applyPlacement(choice.structure.stages, placement),
      },
    });
  };

  const overrun = pickOverrun(choice, calendar);
  const current = league.setup;
  const unchanged =
    !!current &&
    !!choice.structure &&
    current.structureId === choice.structure.id &&
    current.calendarId === calendarId;
  const canSave = !!choice.structure && !!calendar && !overrun && !unchanged && !busy;

  async function submit() {
    if (!canSave || !choice.structure || !calendar) return;
    setBusy(true);
    setErr('');
    try {
      const fresh = await api.platformGetTenant(slug);
      const freshLeagues = fresh.leagues ?? [];
      const freshLeague = freshLeagues.find((l) => l.key === league.key);
      if (!freshLeague)
        throw new ApiError(409, 'This league was deleted in another session — nothing was saved.');
      if (!(fresh.calendars ?? []).some((c) => c.id === calendar.id))
        throw new ApiError(
          409,
          'This calendar was deleted in another session — nothing was saved.',
        );
      const freshStructures = fresh.structures ?? [];
      let structureId = choice.structure.id;
      let added: CompetitionStructure | null = null;
      if (choice.isNew) {
        if (!freshStructures.some((s) => s.id === structureId)) added = choice.structure;
      } else if (!isOperatorStructure(choice.structure)) {
        added = cloneForLeague(freshLeague, choice.structure);
        structureId = added.id;
      } else if (!freshStructures.some((s) => s.id === structureId)) {
        throw new ApiError(
          409,
          'This structure was deleted in another session — nothing was saved.',
        );
      }
      await save({
        ...(added ? { structures: [...freshStructures, added] } : {}),
        leagues: freshLeagues.map((l) =>
          l.key === league.key ? { ...l, setup: { structureId, calendarId: calendar.id } } : l,
        ),
      });
      toast(`${league.label} · set up`);
      onClose();
    } catch (e) {
      setErr(describeError(e, 'Could not save the setup — try again'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      eyebrow="Platform · League catalogue"
      maxWidth={880}
      title={
        current ? (
          <>
            Change setup · <em>{league.label}</em>
          </>
        ) : (
          <>
            Set up <em>{league.label}</em>
          </>
        )
      }
      onClose={onClose}
      dismissable={false}
      confirmClose={choice.mode !== 'skip' || calendarId !== ''}
    >
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
        A league plays one structure on one season calendar. Pick both — nothing is chosen for you.
      </p>
      {current && (
        <p style={{ margin: '0 0 14px', fontSize: 12.5 }}>
          Current setup: <strong>{describeSetup(current, structures, calendars)}</strong>
        </p>
      )}

      <div className="field-label">Structure</div>
      <StructurePick
        league={league}
        calendar={calendar}
        structures={structures}
        choice={choice}
        onChange={setChoice}
        resolveTemplate={resolveTemplate}
      />

      <div className="field" style={{ marginTop: 16, maxWidth: 420 }}>
        <div className="field-label">Season calendar</div>
        {calendars.length === 0 ? (
          <p style={{ ...HINT, marginTop: 0 }}>
            This client has no season calendars yet — create one first (Set up a season).
          </p>
        ) : (
          <select
            className="field-select"
            aria-label="Season calendar"
            value={calendarId}
            onChange={(e) => pickCalendar(e.target.value)}
          >
            <option value="">Calendar…</option>
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {`${c.label} · ${calendarSpan(c)}`}
              </option>
            ))}
          </select>
        )}
      </div>

      {template && calendar && calendar.blocks.length >= 2 && choice.structure && (
        <div className="place-chips" style={{ marginTop: 12 }}>
          {choice.structure.stages.map((stage, i) => (
            <div key={stage.id} className="place-chip">
              <span>Stage {i + 1} plays in</span>
              <select
                aria-label={`Stage ${i + 1} plays in`}
                value={String(stage.schedule.blockIndex)}
                onChange={(e) => placeStage(i, Number(e.target.value))}
              >
                {calendar.blocks.map((b, bi) => (
                  <option key={b.id} value={String(bi)}>
                    {`Block ${bi + 1} — ${b.label} · ${formatIsoDate(b.start)} → ${formatIsoDate(b.end)}`}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      {current && choice.structure && calendar && !unchanged && (
        <p data-testid="replaces-line" style={{ margin: '14px 0 0', fontSize: 12.5 }}>
          Replaces the current setup:{' '}
          <strong>{describeSetup(current, structures, calendars)}</strong>. Seasons already started
          keep their own copy.
        </p>
      )}
      {unchanged && (
        <p style={{ ...HINT, marginTop: 14 }}>This is already {league.label}&rsquo;s setup.</p>
      )}
      {err && <div style={ERR}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
        <Btn tone="teal" onClick={submit} disabled={!canSave}>
          {busy ? 'Saving…' : 'Save setup'}
        </Btn>
        <Btn tone="outline" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </Modal>
  );
}

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
import { useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Btn, Card, EmptyState, Icon, Pill, useEscapeClose } from './atoms';
import * as api from './api';
import { ApiError } from './api';
import { WEEKDAY_LABELS, describeCadence, findBlock } from './competition/calendar';
import { describeStage, previewFit, previewRounds } from './competition/structure';
import { groupSizes } from './competition/entrants';
import { roundsForFormat } from './competition/formats';
import {
  STRUCTURE_TEMPLATES,
  blankStage,
  blankStructure,
  instantiateTemplate,
  newStructureId,
  parseStructureJson,
  structureToJson,
} from './competition/templates';
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
  Weekday,
} from './types';

type Toast = (m: string, t?: string) => void;

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
  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal" style={wide ? { maxWidth: 1040 } : undefined}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Platform · Competition structures</div>
            <div className="task-modal-head-title">{title}</div>
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

const FORMAT_OPTIONS: Array<{ label: string; value: FormatSpec }> = [
  { label: 'Single round robin', value: { kind: 'round-robin', legs: 1 } },
  { label: 'Double round robin', value: { kind: 'round-robin', legs: 2 } },
  // The server accepts legs 1–3 and the generator implements 3; leaving it off the list
  // rendered a three-leg stage as "Single round robin" and retyped it on any touch.
  { label: 'Triple round robin', value: { kind: 'round-robin', legs: 3 } },
  { label: 'Knockout — seeded', value: { kind: 'knockout', pairing: 'seeded' } },
  { label: 'Knockout — cross-pool', value: { kind: 'knockout', pairing: 'cross-pool' } },
  { label: 'Single match', value: { kind: 'single-match' } },
  // The ADR's escape hatch. Reachable through JSON import and accepted by the server's
  // FORMAT_KINDS, so leaving it off the list rendered a blank Format select on a stage
  // that was perfectly valid — and any touch of the control would silently retype it.
  { label: 'Entered by hand', value: { kind: 'manual' } },
];

function formatLabel(f: FormatSpec): string {
  if (f.kind === 'round-robin')
    return f.legs === 3
      ? 'Triple round robin'
      : f.legs === 2
        ? 'Double round robin'
        : 'Single round robin';
  if (f.kind === 'knockout')
    return f.pairing === 'cross-pool' ? 'Knockout — cross-pool' : 'Knockout — seeded';
  if (f.kind === 'single-match') return 'Single match';
  return 'Entered by hand';
}

const ENTRANT_OPTIONS = [
  { key: 'all-registered', label: 'Every registered side' },
  { key: 'seeded-split', label: 'Seeded into groups' },
  { key: 'manual', label: 'Entered by an administrator' },
] as const;

const CADENCE_OPTIONS = [
  { key: 'weekly', label: 'Weekly' },
  { key: 'every-n-weeks', label: 'Every N weeks' },
  { key: 'weekdays', label: 'Set days only' },
  { key: 'spread', label: 'Spread across block' },
] as const;

function Select({
  value,
  onChange,
  children,
  width,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  width?: number;
}) {
  return (
    <select
      className="field-select"
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
      {/* Branch on `kind`, not `plan?.kind` — `groups` is optional on a manual stage, so
          an absent plan makes the Select read "Even groups" while the comma-sizes box
          renders underneath it, and typing there writes a `sizes` plan the dropdown says
          isn't selected. */}
      {kind === 'even' ? (
        <input
          className="field-input"
          type="number"
          min={1}
          max={26}
          style={{ width: 90 }}
          value={plan?.kind === 'even' ? plan.count : 2}
          onChange={(e) => onChange({ kind: 'even', count: Math.max(1, +e.target.value || 1) })}
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
  previewTeams,
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
  previewTeams: number;
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

  const sizes = groupSizes(
    stage.entrants.kind === 'all-registered' ? undefined : stage.entrants.groups,
    previewTeams,
  );
  const perGroup = sizes[0] ?? previewTeams;
  const rounds = previewRounds(stage, perGroup);
  const fit = calendar ? previewFit(stage, calendar, perGroup) : null;

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
          groups: groups ?? { kind: 'even', count: 2 },
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

          <div style={SECTION}>Format</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Select value={formatLabel(stage.format)} onChange={setFormat} width={220}>
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

          <div style={SECTION}>Teams</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Select value={stage.entrants.kind} onChange={setEntrantKind} width={220}>
              {ENTRANT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </Select>
            {stage.entrants.kind === 'seeded-split' && (
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
              >
                <option value="blocks">Top-down blocks</option>
                <option value="snake">Snake</option>
              </Select>
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
          {stage.entrants.kind === 'manual' && index > 0 && (
            <DerivationEditor stage={stage} earlierStages={earlierStages} onChange={onChange} />
          )}

          <div style={SECTION}>Group names</div>
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

          <div style={SECTION}>Schedule</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Select
              value={stage.schedule.blockId}
              onChange={(v) => onChange({ schedule: { ...stage.schedule, blockId: v } })}
              width={240}
            >
              <option value="">Pick a playing block…</option>
              {(calendar?.blocks ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </Select>
            <Select value={stage.schedule.cadence.kind} onChange={setCadence}>
              {CADENCE_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </Select>
            {stage.schedule.cadence.kind === 'every-n-weeks' && (
              <input
                className="field-input"
                type="number"
                min={1}
                max={12}
                style={{ width: 80 }}
                value={stage.schedule.cadence.n}
                onChange={(e) =>
                  onChange({
                    schedule: {
                      ...stage.schedule,
                      cadence: { kind: 'every-n-weeks', n: Math.max(1, +e.target.value || 1) },
                    },
                  })
                }
              />
            )}
          </div>
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
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 12.5, display: 'block', marginBottom: 4 }}>
              Activate from (optional)
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
      </label>
      {note && (
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Select value={note.rule} onChange={(v) => update({ rule: v })} width={190}>
              <option value="from-standings">Top finishers</option>
              <option value="swap">Swap between groups</option>
              <option value="winners-of">Winners of</option>
              <option value="carry-forward">Carried forward</option>
            </Select>
            <Select value={note.fromStage} onChange={(v) => update({ fromStage: v })} width={200}>
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
        </div>
      )}
    </div>
  );
}

/* ─── Preview rail ─── */

function PreviewRail({
  structure,
  calendar,
  previewTeams,
  onPreviewTeams,
}: {
  structure: CompetitionStructure;
  calendar: SeasonCalendar | undefined;
  previewTeams: number;
  onPreviewTeams: (n: number) => void;
}) {
  const rows = structure.stages.map((stage) => {
    const sizes = groupSizes(
      stage.entrants.kind === 'all-registered' ? undefined : stage.entrants.groups,
      previewTeams,
    );
    const perGroup = sizes[0] ?? previewTeams;
    const rounds = previewRounds(stage, perGroup);
    const fit = calendar ? previewFit(stage, calendar, perGroup) : null;
    // Counted from the REAL generator over placeholder entrants, not re-derived: the old
    // `perGroup - 1` was right only for a plain knockout — it previewed a single-match
    // stage of six as five fixtures, and was one short for a third-place playoff.
    const fixturesPerGroup = roundsForFormat(
      stage.format,
      Array.from({ length: perGroup }, (_, i) => `t${i + 1}`),
    ).flat().length;
    const total = fixturesPerGroup * sizes.length;
    return {
      stage,
      sizes,
      rounds,
      fit,
      total,
      // A stage that produces nothing must not read as "fits". Splitting 20 teams into
      // 20 groups leaves a group of one, which plays nobody — the block is trivially
      // satisfied and the season is silently empty. Worth its own message.
      //
      // `manual` is exempt: it generates no fixtures BY DESIGN and the admin enters them
      // afterwards, so counting them here would flag a perfectly good structure as broken
      // — the same mistake `materialiseStage` documents and guards against, one layer up.
      empty: total === 0 && stage.format.kind !== 'manual',
      byHand: stage.format.kind === 'manual',
      // A cross-pool bracket is sized by the QUALIFIERS the previous stage sends, not by
      // everyone entered — and nothing in the structure states how many qualify. The
      // number here is therefore an upper bound (worst case: everybody goes through),
      // which is the safe direction for a "does it fit the block" check but has to be
      // labelled or an operator will read it as the real round count.
      qualifierBound:
        stage.format.kind === 'knockout' && stage.format.pairing === 'cross-pool' && rounds > 0,
      block: calendar ? findBlock(calendar, stage.schedule.blockId)?.label : undefined,
    };
  });
  const anyEmpty = rows.some((r) => r.empty);
  const ok = !anyEmpty && rows.every((r) => !r.fit || r.fit.fits);
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
        <input
          className="field-input"
          type="number"
          min={2}
          max={200}
          style={{ width: 80 }}
          value={previewTeams}
          onChange={(e) => onPreviewTeams(Math.max(2, +e.target.value || 2))}
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
            {r.qualifierBound && (
              <>
                <br />
                <em>Sized by how many qualify from the stage before.</em>
              </>
            )}
          </div>
          {r.empty && (
            <div style={{ ...ERR, marginTop: 6, lineHeight: 1.5 }}>
              This stage generates no fixtures — a group needs at least two teams.
            </div>
          )}
          {!r.empty && r.fit && !r.fit.fits && (
            <div style={{ ...ERR, marginTop: 6, lineHeight: 1.5 }}>{r.fit.summary}</div>
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
          : anyEmpty
            ? '⚠ One or more stages generate no fixtures'
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
  onSave,
  onClose,
  toast,
}: {
  initial: CompetitionStructure;
  calendars: SeasonCalendar[];
  onSave: (s: CompetitionStructure) => Promise<void>;
  onClose: () => void;
  toast: Toast;
}) {
  const [draft, setDraft] = useState<CompetitionStructure>(initial);
  const [calendarId, setCalendarId] = useState(calendars[0]?.id ?? '');
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
    if (!s.schedule.blockId) errors.push(`"${s.name || 'A stage'}" needs a playing block.`);
    if (s.schedule.cadence.kind === 'weekdays' && !s.schedule.cadence.days.length)
      errors.push(`"${s.name}" needs at least one playing day.`);
    const note = s.entrants.kind === 'manual' ? s.entrants.derivedFrom : undefined;
    if (note && !seen.has(note.fromStage))
      errors.push(`"${s.name}" draws from a stage that doesn't come before it.`);
    seen.add(s.id);
  }

  async function submit() {
    if (errors.length || busy) return;
    setSaveErr('');
    setBusy(true);
    try {
      await onSave({ ...draft, name: draft.name.trim() });
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
          <div className="field-label">Preview against</div>
          <Select value={calendarId} onChange={setCalendarId} width={200}>
            <option value="">No calendar</option>
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
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
          {draft.stages.map((stage, i) => (
            <StageRow
              key={stage.id}
              stage={stage}
              index={i}
              total={draft.stages.length}
              calendar={calendar}
              earlierStages={draft.stages.slice(0, i)}
              previewTeams={previewTeams}
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
          previewTeams={previewTeams}
          onPreviewTeams={setPreviewTeams}
        />
      </div>

      {errors.map((e) => (
        <div key={e} style={ERR}>
          {e}
        </div>
      ))}
      {saveErr && <div style={ERR}>{saveErr}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
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
  const calendar = calendars[0];

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
        Start from a shape that already matches how the league runs, then tune it. A template is a
        starting point — everything stays editable afterwards.
      </p>
      <div style={{ display: 'grid', gap: 10 }}>
        {STRUCTURE_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(instantiateTemplate(t, calendar))}
            style={{
              textAlign: 'left',
              border: '1px solid var(--line)',
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
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        <Btn tone="outline" onClick={() => onPick(blankStructure(calendar))}>
          Build from scratch
        </Btn>
        <Btn tone="outline" onClick={() => setImporting(true)}>
          Import JSON
        </Btn>
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
      // Editing mints a new VERSION. Running seasons hold their own snapshot, so this
      // never reshapes a season in flight — it only affects seasons started from here on.
      const next = [...fresh];
      next[i] = { ...structure, version: (fresh[i].version ?? 1) + 1 };
      return next;
    }, 'Could not save structure');

  function onDelete(structure: CompetitionStructure) {
    setConfirm(null);
    saveStructures((fresh) => fresh.filter((s) => s.id !== structure.id), 'Could not delete')
      .then(() => toast(`${structure.name} · deleted`))
      .catch(() => {}); // the 409 referrer guard is toasted above
  }

  const usedBy = (id: string) =>
    (config.leagues ?? []).filter((l) => (l.competitions ?? []).some((c) => c.structureId === id));

  return (
    <Card
      title="Competition structures"
      sub="The stage pipelines leagues bind to — group phases, knockouts and the transitions between them. Editing one creates a new version; seasons already running keep the version they started with."
    >
      {structures.length === 0 ? (
        <EmptyState
          icon={Icon.Shield}
          title="No structures yet"
          sub="Most leagues are one flat round robin, but a split league or a pools-and-knockout needs a structure. Start from a template that matches how the league actually runs."
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
            onSave={upsert}
            onClose={() => setEditing(null)}
            toast={toast}
          />
        </Modal>
      )}

      {confirm &&
        createPortal(
          <div
            className="fix-confirm-backdrop"
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
                Seasons already running keep their own copy and are unaffected. If a league still
                binds a competition to it, the delete is blocked.
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
                  {s.name} (v{s.version})
                </option>
              ))}
            </Select>
            <Select value={c.calendarId} onChange={(v) => patch(i, { calendarId: v })} width={160}>
              <option value="">Calendar…</option>
              {calendars.map((cal) => (
                <option key={cal.id} value={cal.id}>
                  {cal.label}
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

      {errors.map((e) => (
        <div key={e} style={ERR}>
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

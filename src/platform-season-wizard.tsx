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
import { Btn, EmptyState, Icon, InfoDot, useEscapeClose } from './atoms';
import * as api from './api';
import { ApiError } from './api';
import { CalendarForm } from './platform-calendars';
import { calendarSpan, formatIsoDate } from './competition/calendar';
import { previewFit } from './competition/structure';
import {
  STRUCTURE_TEMPLATES,
  instantiateTemplate,
  newStructureId,
  templateBlockIndexForStage,
} from './competition/templates';
import type {
  Competition,
  CompetitionStructure,
  League,
  SeasonCalendar,
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

/**
 * The team count the fit verdict reasons about while nobody has registered yet — the same
 * assumption StructuresCard's preview rail makes (its own `DEFAULT_PREVIEW_TEAMS`). Kept as
 * a separate constant here rather than imported: it is a display default, not shared state.
 */
const DEFAULT_PREVIEW_TEAMS = 12;

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
              Set up a <em>season</em>
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

/** Whether every stage of a structure fits the draft calendar, previewed at a plausible size. */
function fitVerdict(
  structure: CompetitionStructure,
  calendar: SeasonCalendar,
): { ok: boolean; text: string } {
  const plans = structure.stages.map((st) => previewFit(st, calendar, DEFAULT_PREVIEW_TEAMS));
  const failing = plans.find((p) => !p.fits);
  return failing
    ? { ok: false, text: `⚠ ${failing.summary}` }
    : { ok: true, text: '✓ Fits the calendar' };
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
  onChange,
  onRemove,
  resolveTemplate,
}: {
  league: League;
  calendar: SeasonCalendar;
  structures: CompetitionStructure[];
  choice: LeagueChoice;
  onChange: (c: LeagueChoice) => void;
  onRemove: () => void;
  /** Resolves a template pick to a structure — reusing before minting (see the caller). */
  resolveTemplate: (t: (typeof STRUCTURE_TEMPLATES)[number]) => {
    structure: CompetitionStructure;
    isNew: boolean;
  };
}) {
  const verdict =
    choice.mode !== 'skip' && choice.structure ? fitVerdict(choice.structure, calendar) : null;

  return (
    <div style={rowBox}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 13.5 }}>{league.label}</div>
        <Btn tone="ghost" size="sm" onClick={onRemove}>
          Remove
        </Btn>
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, marginBottom: 8 }}>
        <label style={radioLabel}>
          <input
            type="radio"
            name={`mode-${league.key}`}
            checked={choice.mode === 'template'}
            onChange={() => onChange({ mode: 'template', label: '' })}
          />
          Start from a template
        </label>
        <label style={radioLabel}>
          <input
            type="radio"
            name={`mode-${league.key}`}
            checked={choice.mode === 'existing'}
            onChange={() => onChange({ mode: 'existing', label: '' })}
            disabled={structures.length === 0}
          />
          Use an existing structure
        </label>
        <InfoDot
          title="Where this league's structure comes from"
          options={[
            {
              label: 'Start from a template',
              desc: 'Begin from a ready-made shape (flat league, split league, pools + knockout) and it becomes a new structure for this client.',
              eg: 'a new club using the "Split league with mid-season swap" template',
            },
            {
              label: 'Use an existing structure',
              desc: 'Reuse a structure this client already has — no new version is created.',
              eg: 'last season’s Premier Men structure, run again',
            },
          ]}
        />
      </div>

      {choice.mode === 'template' && (
        <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
          {STRUCTURE_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange({ mode: 'template', ...resolveTemplate(t), label: t.name })}
              style={{
                textAlign: 'left',
                border:
                  choice.structure?.templateId === t.id
                    ? '2px solid var(--brand-primary, #16332B)'
                    : '1px solid var(--line)',
                borderRadius: 8,
                padding: '8px 10px',
                background: 'var(--white, #fff)',
                cursor: 'pointer',
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>{t.name}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.4 }}>
                {t.whenToUse}
              </div>
            </button>
          ))}
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
          style={{ marginBottom: 8 }}
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
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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

const rowBox: CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 10,
  padding: 12,
  marginBottom: 10,
};
const radioLabel: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'pointer',
};

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
    return { structure: instantiateTemplate(t, calDraft ?? undefined), isNew: true };
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
   * against the CURRENT `calDraft`, using the same rule `instantiateTemplate` applies at
   * pick time. A template is instantiated once, at pick time, against whatever `calDraft`
   * looked like then — but the operator can go Back to step 0 and change the calendar's
   * block count afterwards. A shrink is caught by the fit verdict (it just warns); a GROW
   * is the dangerous direction, because a later stage stays at block position 0 or 1
   * exactly as minted, silently pointing at the wrong (now-existing) block rather than the
   * new one the operator actually added.
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
        if (choice.mode === 'template' && choice.isNew && s && !remapped.has(s.id)) {
          remapped.set(s.id, {
            ...s,
            stages: s.stages.map((stage, i) => ({
              ...stage,
              schedule: { ...stage.schedule, blockIndex: templateBlockIndexForStage(i, calDraft) },
            })),
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
        <p style={HINT}>
          Fixture generation happens in the club admin console — &ldquo;Start a season&rdquo;
          against each competition, once clubs are registered.
        </p>
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
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            A season's real-world time — playing blocks, breaks and excluded dates. Every league
            playing this season usually shares one calendar.
          </p>
          {calendars.length > 0 && (
            <div
              style={{
                display: 'flex',
                gap: 16,
                flexWrap: 'wrap',
                marginBottom: 14,
                fontSize: 12.5,
              }}
            >
              <label style={radioLabel}>
                <input
                  type="radio"
                  checked={calMode === 'new'}
                  onChange={() => setCalMode('new')}
                />
                Start a new season calendar
              </label>
              <label style={radioLabel}>
                <input
                  type="radio"
                  checked={calMode === 'existing'}
                  onChange={() => setCalMode('existing')}
                />
                Use an existing calendar
              </label>
              <InfoDot
                title="Season calendar"
                options={[
                  {
                    label: 'Start a new season calendar',
                    desc: 'Build a fresh calendar below — blocks, breaks and excluded dates for this season.',
                  },
                  {
                    label: 'Use an existing calendar',
                    desc: 'Reuse a calendar this client already has, so every league on it shares the same dates and breaks.',
                  },
                ]}
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
            <strong>{calDraft.label}</strong> — a split league, pools, a knockout. Every choice
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
                        onChange={(c) => setChoiceFor(l.key, c)}
                        onRemove={() => removeLeague(l.key)}
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
                <div key={l.key} style={{ fontSize: 12.5, marginBottom: 6 }}>
                  <strong>{l.label}</strong>: {c?.label} —{' '}
                  {c?.isNew
                    ? `new structure (${c.structure?.name})`
                    : `existing structure (${c?.structure?.name})`}
                  {verdict && <span style={{ marginLeft: 6 }}>{verdict.ok ? '✓' : '⚠'}</span>}
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

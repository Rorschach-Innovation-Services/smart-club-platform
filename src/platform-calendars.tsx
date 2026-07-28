/**
 * Operator console — season calendars (ADR 0008).
 *
 * The playing calendar fixture generation schedules against: blocks of play, the breaks
 * between them, and one-off excluded dates. Operator-managed like districts and the
 * league catalogue; `PUT /tenant/config` strips `calendars`, so this is the only surface
 * that writes them.
 *
 * Lives outside platform.tsx (already 3,300 lines) and imports only from atoms/api/types,
 * so there is no import cycle back into the console shell.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Btn, Card, EmptyState, Icon, Pill, useEscapeClose } from './atoms';
import * as api from './api';
import { ApiError } from './api';
import {
  blockLengthDays,
  daysBetween,
  formatIsoDate,
  isValidIsoDate,
} from './competition/calendar';
import type { SeasonBlock, SeasonBreak, SeasonCalendar, TenantConfig } from './types';

type Toast = (m: string, t?: string) => void;

const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '8px 0 0' };

/** A local id for a new block — stable across edits so a rename can't orphan a series. */
function newId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}`;
}

/** Whole weeks, rounded down — how operators actually talk about block capacity. */
function weeksLabel(days: number): string {
  const w = Math.floor(days / 7);
  return w >= 1 ? `${w} week${w === 1 ? '' : 's'}` : `${days} day${days === 1 ? '' : 's'}`;
}

/* ─── Timeline strip ───
   A calendar is three or four date ranges, and a table of ISO strings makes it
   surprisingly hard to see whether they line up. This renders them proportionally on one
   axis so a gap, an overlap or a break that swallows a block is obvious at a glance —
   the cheapest possible version of the preview rail described in ADR 0008. */
function Timeline({ calendar }: { calendar: SeasonCalendar }) {
  const spans = [
    ...calendar.blocks.map((b) => ({ ...b, kind: 'block' as const })),
    ...(calendar.breaks ?? []).map((b, i) => ({
      ...b,
      id: `break-${i}`,
      kind: 'break' as const,
    })),
  ].filter((s) => isValidIsoDate(s.start) && isValidIsoDate(s.end) && s.end >= s.start);
  if (spans.length === 0) return null;

  const min = spans.reduce((a, s) => (s.start < a ? s.start : a), spans[0].start);
  const max = spans.reduce((a, s) => (s.end > a ? s.end : a), spans[0].end);
  const total = daysBetween(min, max) || 1;

  return (
    <div style={{ margin: '4px 0 14px' }}>
      <div
        style={{
          position: 'relative',
          height: 26,
          borderRadius: 6,
          background: 'var(--line2)',
          overflow: 'hidden',
        }}
      >
        {spans.map((s) => {
          const left = (daysBetween(min, s.start) / total) * 100;
          const width = Math.max(((daysBetween(s.start, s.end) + 1) / total) * 100, 1.5);
          const isBlock = s.kind === 'block';
          return (
            <div
              key={`${s.kind}-${s.id}`}
              title={`${s.label} · ${formatIsoDate(s.start)} → ${formatIsoDate(s.end)}`}
              style={{
                position: 'absolute',
                left: `${left}%`,
                width: `${width}%`,
                top: 0,
                bottom: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '.02em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                color: isBlock ? '#fff' : 'var(--muted-2)',
                background: isBlock ? 'var(--brand-primary, #16332B)' : 'transparent',
                // A break reads as absence, so it is striped rather than filled.
                backgroundImage: isBlock
                  ? undefined
                  : 'repeating-linear-gradient(45deg, var(--line) 0 4px, transparent 4px 8px)',
              }}
            >
              {isBlock ? s.label : ''}
            </div>
          );
        })}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 10.5,
          color: 'var(--muted-2)',
          marginTop: 4,
        }}
      >
        <span>{formatIsoDate(min)}</span>
        <span>{formatIsoDate(max)}</span>
      </div>
    </div>
  );
}

/**
 * Problems worth telling the operator about before they save. Hard errors block the
 * save; the server re-checks all of them (it is the authority), but catching them here
 * turns a round-trip 400 into an inline hint.
 */
function validate(draft: SeasonCalendar): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!draft.label.trim()) errors.push('Give the calendar a label, e.g. "2026/27".');
  if (draft.blocks.length === 0) errors.push('Add at least one playing block.');

  for (const b of draft.blocks) {
    const name = b.label.trim() || 'Untitled block';
    if (!b.label.trim()) errors.push('Every block needs a label.');
    if (!isValidIsoDate(b.start) || !isValidIsoDate(b.end))
      errors.push(`${name} needs a valid start and end date.`);
    else if (b.end < b.start) errors.push(`${name} ends before it starts.`);
  }

  for (const br of draft.breaks ?? []) {
    const name = br.label.trim() || 'Untitled break';
    if (!br.label.trim()) errors.push('Every break needs a label.');
    if (!isValidIsoDate(br.start) || !isValidIsoDate(br.end))
      errors.push(`${name} needs a valid start and end date.`);
    else if (br.end < br.start) errors.push(`${name} ends before it starts.`);
  }

  const usable = draft.blocks.filter(
    (b) => isValidIsoDate(b.start) && isValidIsoDate(b.end) && b.end >= b.start,
  );

  // Overlapping blocks aren't illegal — a union could run two competitions in parallel
  // windows — but they are far more often a typo, so they warn rather than block.
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i];
      const b = usable[j];
      if (a.start <= b.end && b.start <= a.end) warnings.push(`${a.label} and ${b.label} overlap.`);
    }
  }

  // A break that covers a whole block silently makes it unschedulable — the single
  // nastiest calendar mistake, because generation just quietly finds no dates.
  for (const b of usable) {
    for (const br of draft.breaks ?? []) {
      if (!isValidIsoDate(br.start) || !isValidIsoDate(br.end)) continue;
      if (br.start <= b.start && br.end >= b.end)
        errors.push(`"${br.label}" covers the whole of ${b.label} — no match could be scheduled.`);
    }
  }

  const badExcluded = (draft.excludeDates ?? []).filter((v) => !isValidIsoDate(v));
  if (badExcluded.length) errors.push(`Not a valid date: ${badExcluded.join(', ')}.`);

  return { errors, warnings };
}

function CalendarModal({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children?: ReactNode;
}) {
  useEscapeClose(onClose);
  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal">
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Platform · Season calendars</div>
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

/** One editable date range — shared by the blocks and breaks lists. */
function RangeRow({
  value,
  placeholder,
  showLength,
  onChange,
  onRemove,
}: {
  value: { label: string; start: string; end: string };
  placeholder: string;
  showLength?: boolean;
  onChange: (patch: Partial<{ label: string; start: string; end: string }>) => void;
  onRemove: () => void;
}) {
  const valid =
    isValidIsoDate(value.start) && isValidIsoDate(value.end) && value.end >= value.start;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(120px, 1.4fr) 130px 130px auto',
        gap: 8,
        alignItems: 'center',
        padding: '6px 0',
        borderBottom: '1px solid var(--line2)',
      }}
    >
      <input
        className="field-input"
        placeholder={placeholder}
        value={value.label}
        onChange={(e) => onChange({ label: e.target.value })}
      />
      <input
        className="field-input"
        type="date"
        value={value.start}
        onChange={(e) => onChange({ start: e.target.value })}
      />
      <input
        className="field-input"
        type="date"
        value={value.end}
        min={value.start || undefined}
        onChange={(e) => onChange({ end: e.target.value })}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
        {showLength && valid && (
          <span style={{ fontSize: 11, color: 'var(--muted-2)', whiteSpace: 'nowrap' }}>
            {weeksLabel(blockLengthDays(value as SeasonBlock))}
          </span>
        )}
        <Btn tone="ghost" size="sm" onClick={onRemove}>
          Remove
        </Btn>
      </div>
    </div>
  );
}

function CalendarForm({
  calendar,
  allCalendars,
  onSave,
  onClose,
  toast,
}: {
  calendar: SeasonCalendar | null;
  allCalendars: SeasonCalendar[];
  onSave: (cal: SeasonCalendar) => Promise<void>;
  onClose: () => void;
  toast: Toast;
}) {
  const editing = !!calendar;
  const [draft, setDraft] = useState<SeasonCalendar>(
    () =>
      calendar ?? {
        id: newId('cal'),
        label: '',
        blocks: [{ id: newId('blk'), label: 'Block 1', start: '', end: '' }],
        breaks: [],
        excludeDates: [],
      },
  );
  const [newExcluded, setNewExcluded] = useState('');
  const [saveErr, setSaveErr] = useState('');
  const [busy, setBusy] = useState(false);

  const { errors, warnings } = validate(draft);
  const dupLabel =
    !editing &&
    allCalendars.some((c) => c.label.trim() === draft.label.trim() && draft.label.trim());
  const canSave = errors.length === 0 && !dupLabel && !busy;

  const patch = (p: Partial<SeasonCalendar>) => setDraft((d) => ({ ...d, ...p }));
  const patchBlock = (i: number, p: Partial<SeasonBlock>) =>
    setDraft((d) => ({ ...d, blocks: d.blocks.map((b, j) => (i === j ? { ...b, ...p } : b)) }));
  const patchBreak = (i: number, p: Partial<SeasonBreak>) =>
    setDraft((d) => ({
      ...d,
      breaks: (d.breaks ?? []).map((b, j) => (i === j ? { ...b, ...p } : b)),
    }));

  function addExcluded() {
    const v = newExcluded.trim();
    if (!v || !isValidIsoDate(v)) return;
    if ((draft.excludeDates ?? []).includes(v)) return;
    patch({ excludeDates: [...(draft.excludeDates ?? []), v].sort() });
    setNewExcluded('');
  }

  async function submit() {
    if (!canSave) return;
    setSaveErr('');
    setBusy(true);
    try {
      // Trim on the way out so ' Block 1 ' and 'Block 1' can't read as different labels.
      await onSave({
        ...draft,
        label: draft.label.trim(),
        blocks: draft.blocks.map((b) => ({ ...b, label: b.label.trim() })),
        breaks: (draft.breaks ?? []).map((b) => ({ ...b, label: b.label.trim() })),
      });
      toast(editing ? `${draft.label.trim()} · updated` : `${draft.label.trim()} · created`);
      onClose();
    } catch (e) {
      setSaveErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setBusy(false);
    }
  }

  const sectionHead: CSSProperties = {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '.04em',
    textTransform: 'uppercase',
    color: 'var(--muted-2)',
    margin: '18px 0 6px',
  };

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
        Blocks are when matches are played; breaks are when they aren&apos;t. Fixture generation
        places rounds inside a block and steps over every break and excluded date.
      </p>

      <div className="field" style={{ marginTop: 14 }}>
        <div className="field-label">
          Season label <span className="req">*</span>
        </div>
        <input
          className="field-input"
          value={draft.label}
          onChange={(e) => patch({ label: e.target.value })}
          placeholder="e.g. 2026/27"
          autoFocus
        />
        {dupLabel && <div style={ERR}>A calendar with this label already exists.</div>}
      </div>

      <div style={sectionHead}>Playing blocks</div>
      {draft.blocks.map((b, i) => (
        <RangeRow
          key={b.id}
          value={b}
          placeholder="Block 1"
          showLength
          onChange={(p) => patchBlock(i, p)}
          onRemove={() => patch({ blocks: draft.blocks.filter((_, j) => j !== i) })}
        />
      ))}
      <div style={{ marginTop: 10 }}>
        <Btn
          tone="outline"
          size="sm"
          icon={Icon.Plus}
          onClick={() =>
            patch({
              blocks: [
                ...draft.blocks,
                { id: newId('blk'), label: `Block ${draft.blocks.length + 1}`, start: '', end: '' },
              ],
            })
          }
        >
          Add block
        </Btn>
      </div>

      <div style={sectionHead}>Breaks</div>
      {(draft.breaks ?? []).length === 0 && (
        <p style={{ ...HINT, marginTop: 0 }}>
          No breaks yet. Most unions need one between the two halves of the season.
        </p>
      )}
      {(draft.breaks ?? []).map((b, i) => (
        <RangeRow
          // The INDEX, not the label. Keying on the value being edited changes the key on
          // every keystroke, so React unmounts the row and mounts a fresh one — a new
          // input node, and focus on <body>. The mid-season break's label was untypeable:
          // one character per click. Blocks above key on `b.id` because they have one;
          // `SeasonBreak` doesn't, and the list is append/remove-only with a fully
          // controlled row, so the index is stable enough.
          key={i}
          value={b}
          placeholder="Mid-season break"
          onChange={(p) => patchBreak(i, p)}
          onRemove={() => patch({ breaks: (draft.breaks ?? []).filter((_, j) => j !== i) })}
        />
      ))}
      <div style={{ marginTop: 10 }}>
        <Btn
          tone="outline"
          size="sm"
          icon={Icon.Plus}
          onClick={() =>
            patch({
              breaks: [...(draft.breaks ?? []), { label: 'Mid-season break', start: '', end: '' }],
            })
          }
        >
          Add break
        </Btn>
      </div>

      <div style={sectionHead}>Excluded dates</div>
      <p style={{ ...HINT, marginTop: 0 }}>
        One-off days no match may be played — public holidays, union events, exam days.
      </p>
      {(draft.excludeDates ?? []).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {(draft.excludeDates ?? []).map((dte) => (
            <button
              key={dte}
              type="button"
              title="Remove"
              onClick={() =>
                patch({ excludeDates: (draft.excludeDates ?? []).filter((x) => x !== dte) })
              }
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 999,
                border: '1px solid var(--line)',
                background: 'var(--paper)',
                fontSize: 11.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {formatIsoDate(dte)} <span style={{ color: 'var(--muted-2)' }}>×</span>
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input
          className="field-input"
          type="date"
          style={{ maxWidth: 180 }}
          value={newExcluded}
          onChange={(e) => setNewExcluded(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addExcluded())}
        />
        <Btn tone="outline" size="sm" onClick={addExcluded} disabled={!isValidIsoDate(newExcluded)}>
          Add date
        </Btn>
      </div>

      <div style={sectionHead}>Preview</div>
      <Timeline calendar={draft} />

      {errors.map((e, i) => (
        <div key={i} style={ERR}>
          {e}
        </div>
      ))}
      {warnings.map((w) => (
        <div key={w} style={{ ...ERR, color: 'var(--gold, #B7791F)' }}>
          {w}
        </div>
      ))}
      {saveErr && <div style={ERR}>{saveErr}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
        <Btn tone="teal" onClick={submit} disabled={!canSave}>
          {busy ? 'Saving…' : editing ? 'Save calendar' : 'Create calendar'}
        </Btn>
        <Btn tone="outline" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

export function CalendarsCard({
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
  const [form, setForm] = useState<SeasonCalendar | 'new' | null>(null);
  const [confirm, setConfirm] = useState<SeasonCalendar | null>(null);
  const calendars = config.calendars ?? [];

  /**
   * Rebuild-and-PUT against the server's LATEST list, not this tab's cache — the same
   * guard `LeaguesCard` uses. Two operators (or one in two tabs) editing different
   * calendars must not erase each other, since the whole array is written at once.
   */
  async function saveCalendars(
    build: (fresh: SeasonCalendar[]) => SeasonCalendar[],
    fallback: string,
  ): Promise<void> {
    try {
      const current = await api.platformGetTenant(slug);
      await save({ calendars: build(current.calendars ?? []) });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : fallback, 'warn');
      throw e; // keeps the modal open so the operator doesn't lose their edits
    }
  }

  const onCreate = (cal: SeasonCalendar) =>
    saveCalendars((fresh) => [...fresh, cal], 'Could not create calendar');

  const onUpdate = (cal: SeasonCalendar) =>
    saveCalendars((fresh) => {
      // The refetch can reveal a concurrent delete — surface it rather than silently
      // PUTting the calendar back and resurrecting it.
      if (!fresh.some((c) => c.id === cal.id))
        throw new ApiError(409, 'This calendar was deleted in another session.');
      return fresh.map((c) => (c.id === cal.id ? cal : c));
    }, 'Could not save calendar');

  function onDelete(cal: SeasonCalendar) {
    setConfirm(null);
    saveCalendars((fresh) => fresh.filter((c) => c.id !== cal.id), 'Could not delete calendar')
      .then(() => toast(`${cal.label} · deleted`))
      .catch(() => {}); // the 409 referrer guard is already toasted above
  }

  return (
    <Card
      title="Season calendars"
      sub="The playing blocks, breaks and excluded dates fixtures are scheduled against. A calendar a series is already scheduled against can't be deleted."
    >
      {calendars.length === 0 ? (
        <EmptyState
          icon={Icon.Shield}
          title="No season calendars yet"
          sub="Set the season's playing blocks and mid-season break before this client generates fixtures — otherwise every league schedules straight through the break."
          action={
            <Btn tone="teal" icon={Icon.Plus} onClick={() => setForm('new')}>
              Create your first calendar
            </Btn>
          }
        />
      ) : (
        <>
          <div className="tbl-w">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Season</th>
                  <th>Blocks</th>
                  <th>Span</th>
                  <th>Breaks</th>
                  <th style={{ width: 130 }}></th>
                </tr>
              </thead>
              <tbody>
                {calendars.map((cal) => {
                  const usable = cal.blocks.filter(
                    (b) => isValidIsoDate(b.start) && isValidIsoDate(b.end),
                  );
                  const first = usable.reduce<string>(
                    (a, b) => (!a || b.start < a ? b.start : a),
                    '',
                  );
                  const last = usable.reduce<string>((a, b) => (!a || b.end > a ? b.end : a), '');
                  return (
                    <tr key={cal.id}>
                      <td>
                        <span style={{ fontWeight: 700 }}>{cal.label}</span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {cal.blocks.map((b) => (
                            <Pill key={b.id} tone="muted">
                              {b.label}
                            </Pill>
                          ))}
                        </div>
                      </td>
                      <td>
                        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                          {first && last ? `${formatIsoDate(first)} → ${formatIsoDate(last)}` : '—'}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                          {(cal.breaks ?? []).length || '—'}
                        </span>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                          <Btn tone="outline" size="sm" onClick={() => setForm(cal)}>
                            Edit
                          </Btn>
                          <Btn tone="ghost" size="sm" onClick={() => setConfirm(cal)}>
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
            <Btn tone="teal" size="sm" icon={Icon.Plus} onClick={() => setForm('new')}>
              Create calendar
            </Btn>
          </div>
        </>
      )}

      {form && (
        <CalendarModal
          title={
            form !== 'new' ? (
              <>
                Edit <em>calendar</em>
              </>
            ) : (
              <>
                Create a <em>calendar</em>
              </>
            )
          }
          onClose={() => setForm(null)}
        >
          <CalendarForm
            calendar={form !== 'new' ? form : null}
            allCalendars={calendars}
            onSave={form !== 'new' ? onUpdate : onCreate}
            onClose={() => setForm(null)}
            toast={toast}
          />
        </CalendarModal>
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
              <div className="fix-confirm-title">Delete “{confirm.label}”?</div>
              <div className="fix-confirm-body">
                New series can no longer be scheduled against it. If a series already uses this
                calendar, the delete is blocked.
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

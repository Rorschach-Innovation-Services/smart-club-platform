/* ─── Umpire allocation — the fixture editor's Umpires cell and the admin Umpires page ───
   Appointments are written with their own call (PUT …/officials), never through the series
   PATCH, so assigning an umpire never withdraws approval or runs the clash gate. */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Btn, Icon, Pill } from './atoms';
import { ApiError, type OfficialsNotifyStatusRow } from './api';
import {
  MAX_SCORERS_PER_FIXTURE,
  MAX_UMPIRES_PER_FIXTURE,
  findUmpireDoubleBookings,
  normaliseUmpireAlias,
  type UmpireBooking,
} from '../packages/engine/src/umpires';
import type { CaptainsReport, Club, FixtureOfficials, Scorer, Series, Umpire } from './types';
import type { PersonContacts } from './FixtureManage';
import {
  umpireRatingAverages,
  type UmpireRatingSummary,
} from '../packages/engine/src/captainsReport';

/** The minimal fixture shape these helpers read (`Series.fixtures` is `unknown[]`). */
interface FixtureLike {
  id: string;
  date?: string;
  time?: string;
  home?: string;
  away?: string;
  venueOverride?: string;
  venueName?: string;
  officials?: FixtureOfficials;
}

const fixturesOf = (s: Series) => (s.fixtures ?? []) as FixtureLike[];

/** The ground a fixture is played at, as the fixture table shows it: a hand-set override,
 *  else the allocated venue, else the home side's ground. */
export function fixtureVenueLabel(s: Series, f: FixtureLike, clubs: Club[] = []): string {
  if (f.venueOverride) return f.venueOverride;
  if (f.venueName) return f.venueName;
  const p = (s.participants ?? []).find((x) => x.teamId === f.home);
  if (p?.venue) return p.venue;
  const club = clubs.find((c) => c.id === (p?.clubId ?? f.home));
  return club?.ground?.venue ?? '';
}

/** Every appointed umpire on every fixture, as bookings for the double-booking check.
 *  `override` swaps in a draft appointment for one fixture (the open picker). */
export function officialsBookings(
  allSeries: Series[],
  clubs: Club[],
  override?: { seriesId: string; fixtureId: string; umpireIds: string[] },
): UmpireBooking[] {
  const out: UmpireBooking[] = [];
  for (const s of allSeries) {
    for (const f of fixturesOf(s)) {
      const isOverride = override?.seriesId === s.id && override.fixtureId === f.id;
      const ids = isOverride
        ? override!.umpireIds
        : (f.officials?.umpires ?? []).map((u) => u.umpireId);
      if (!ids.length || !f.date) continue;
      const venue = fixtureVenueLabel(s, f, clubs);
      for (const umpireId of ids)
        out.push({ umpireId, seriesId: s.id, fixtureId: f.id, date: f.date, time: f.time, venue });
    }
  }
  return out;
}

/**
 * Human-readable warnings for one fixture: each umpire it names who is also at a DIFFERENT
 * ground that day at an overlapping time. Never blocks a save.
 */
export function doubleBookingWarnings(
  seriesId: string,
  fixtureId: string,
  umpireIds: string[],
  allSeries: Series[],
  clubs: Club[],
  nameOf: (id: string) => string,
): string[] {
  if (!umpireIds.length) return [];
  const bookings = officialsBookings(allSeries, clubs, { seriesId, fixtureId, umpireIds });
  const seriesName = new Map(allSeries.map((s) => [s.id, s.name]));
  return findUmpireDoubleBookings(bookings)
    .map((d) => {
      const mineIsA = d.a.seriesId === seriesId && d.a.fixtureId === fixtureId;
      const mineIsB = d.b.seriesId === seriesId && d.b.fixtureId === fixtureId;
      if (!mineIsA && !mineIsB) return null;
      const other = mineIsA ? d.b : d.a;
      return `${nameOf(d.umpireId)} is also at ${other.venue}${other.time ? ` at ${other.time}` : ''} (${seriesName.get(other.seriesId) ?? other.seriesId})`;
    })
    .filter((w): w is string => !!w);
}

/**
 * Saved-state warnings for every fixture at once (one pass over all bookings), keyed
 * `seriesId#fixtureId` — what the fixture table shows next to each Umpires cell.
 */
export function doubleBookingIndex(
  allSeries: Series[],
  clubs: Club[],
  nameOf: (id: string) => string,
): Map<string, string[]> {
  const seriesName = new Map(allSeries.map((s) => [s.id, s.name]));
  const out = new Map<string, string[]>();
  const add = (mine: UmpireBooking, other: UmpireBooking, umpireId: string) => {
    const key = `${mine.seriesId}#${mine.fixtureId}`;
    const msg = `${nameOf(umpireId)} is also at ${other.venue}${other.time ? ` at ${other.time}` : ''} (${seriesName.get(other.seriesId) ?? other.seriesId})`;
    out.set(key, [...(out.get(key) ?? []), msg]);
  };
  for (const d of findUmpireDoubleBookings(officialsBookings(allSeries, clubs))) {
    add(d.a, d.b, d.umpireId);
    add(d.b, d.a, d.umpireId);
  }
  return out;
}

/* ─── The picker ─── */

/**
 * The editor's notice badge for one ledger row, or null for none (backfilled = never sent).
 * Pass the registry entry so a queued notice for someone with neither email nor cell reads as
 * waiting on contact details rather than about to go out (display only).
 */
export function noticeBadge(
  row:
    | (Pick<OfficialsNotifyStatusRow, 'status' | 'reason' | 'completedAt'> &
        Partial<Pick<OfficialsNotifyStatusRow, 'attempts'>>)
    | undefined,
  person?: { phone?: string; email?: string },
): { label: string; title?: string } | null {
  if (!row) return null;
  if (row.status === 'queued') {
    if (person && !(person.email ?? '').trim() && !(person.phone ?? '').trim()) {
      return {
        label: 'Waiting for contact details',
        title: 'No email or cell on file — add one so the queued notice can go out.',
      };
    }
    return { label: 'Notice queued' };
  }
  if (row.status === 'exhausted') {
    return {
      label: 'Couldn’t reach',
      title: `${row.attempts ?? 0} delivery attempts failed — check their email and cell on the Umpires page`,
    };
  }
  if (row.status === 'completed' && row.reason !== 'backfill') {
    return { label: 'Notified ✓', ...(row.completedAt ? { title: row.completedAt } : {}) };
  }
  return null;
}

/** True when the registry entry has neither an email nor a cell, so no notice can go out. */
export function lacksContact(u: { phone?: string; email?: string } | undefined): boolean {
  return !!u && !(u.email ?? '').trim() && !(u.phone ?? '').trim();
}

/**
 * Where to fix a missing contact differs by register: umpires are edited on the Umpires page,
 * but there is no scorer edit screen — a scorer's contacts are only captured when they're added.
 */
export function noContactHint(noun: string): string {
  const fix =
    noun === 'scorer'
      ? 'Scorer contacts are captured when the scorer is added — add them as a new scorer with a phone or email.'
      : 'Add contacts on the Umpires page.';
  return `No email or cell on file — they won’t get an appointment notice. ${fix}`;
}

/** What a slot needs of a register entry — umpires and scorers both fit (scorers have no aliases). */
type OfficialEntry = Pick<
  Umpire,
  'id' | 'displayName' | 'fullName' | 'phone' | 'email' | 'active'
> & {
  aliases?: string[];
};

function matches(u: OfficialEntry, q: string): boolean {
  const n = normaliseUmpireAlias(q);
  if (!n) return true;
  return (
    normaliseUmpireAlias(u.displayName).includes(n) ||
    (u.fullName ? normaliseUmpireAlias(u.fullName).includes(n) : false) ||
    (u.aliases ?? []).some((a) => a.includes(n))
  );
}

function UmpireSlot({
  label,
  value,
  exclude,
  umpires,
  onChange,
  onCreate,
  notice,
  noun = 'umpire',
  captureContacts = false,
}: {
  label: string;
  value: string | null;
  exclude: (string | null)[];
  umpires: OfficialEntry[];
  onChange: (id: string | null) => void;
  onCreate?: (displayName: string, contacts?: PersonContacts) => Promise<{ id: string }>;
  /** Ask for an optional phone/email before creating (scorers), as the hub's officials dialog does. */
  captureContacts?: boolean;
  /** This official's appointment-notice ledger row, when one exists. */
  notice?: OfficialsNotifyStatusRow;
  /** What the "+ Add" option calls a new register entry. */
  noun?: string;
}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [contacts, setContacts] = useState<{ phone: string; email: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const chosen = value ? umpires.find((u) => u.id === value) : undefined;
  const badge = noticeBadge(notice, chosen);
  // Keyboard: ArrowDown from the box enters the suggestions, arrows move through them (Up
  // from the first returns to the box), Enter picks (a native button click), Escape closes.
  const items = () => [...(listRef.current?.querySelectorAll('button') ?? [])];
  const close = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setQ('');
    inputRef.current?.focus();
  };
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') return close(e);
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
    if (next < 0) inputRef.current?.focus();
    else all[Math.min(next, all.length - 1)]?.focus();
  };
  if (value) {
    return (
      <div className="ump-slot">
        <span className="ump-slot-l">{label}</span>
        <span className="ump-chip">
          {chosen?.displayName ?? value}
          <button
            type="button"
            aria-label={`Remove ${chosen?.displayName ?? value}`}
            onClick={() => onChange(null)}
          >
            ×
          </button>
        </span>
        {badge && (
          <span title={badge.title}>
            <Pill tone="muted">{badge.label}</Pill>
          </span>
        )}
        {lacksContact(chosen) && <span className="ump-sub">{noContactHint(noun)}</span>}
      </div>
    );
  }
  const options = umpires
    .filter((u) => u.active && !exclude.includes(u.id) && matches(u, q))
    .slice(0, 6);
  const exact = umpires.some(
    (u) => u.active && (u.aliases ?? []).includes(normaliseUmpireAlias(q)),
  );
  const canAdd = !!onCreate && q.trim().length > 1 && !exact;
  async function create(extra?: PersonContacts) {
    setBusy(true);
    try {
      const created = extra ? await onCreate!(q.trim(), extra) : await onCreate!(q.trim());
      setQ('');
      setContacts(null);
      onChange(created.id);
    } catch {
      // The caller toasts the reason (e.g. the name already exists).
    } finally {
      setBusy(false);
    }
  }
  if (canAdd && contacts)
    return (
      <div className="ump-slot">
        <span className="ump-slot-l">{label}</span>
        <div className="ump-options" role="group" aria-label={`New ${noun} contacts`}>
          <div className="ump-option-sub">
            New {noun} “{q.trim()}”. A phone or email lets them get the appointment notice.
          </div>
          {(['phone', 'email'] as const).map((k) => (
            <label key={k} className="ump-slot-l">
              {k === 'phone' ? 'Phone (optional)' : 'Email (optional)'}
              <input
                type={k === 'email' ? 'email' : 'tel'}
                value={contacts[k]}
                onChange={(e) => setContacts({ ...contacts, [k]: e.target.value })}
              />
            </label>
          ))}
          <button
            type="button"
            className="ump-add"
            disabled={busy}
            onClick={() =>
              create({
                ...(contacts.phone.trim() ? { phone: contacts.phone.trim() } : {}),
                ...(contacts.email.trim() ? { email: contacts.email.trim() } : {}),
              })
            }
          >
            Add {noun}
          </button>
          <button type="button" disabled={busy} onClick={() => setContacts(null)}>
            Back
          </button>
        </div>
      </div>
    );
  return (
    <div className="ump-slot">
      <label className="ump-slot-l">
        {label}
        <input
          ref={inputRef}
          type="text"
          value={q}
          placeholder="Type a name…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && q.trim()) {
              e.preventDefault();
              items()[0]?.focus();
            } else if (e.key === 'Escape' && q) close(e);
          }}
          aria-label={label}
          role="combobox"
          aria-expanded={!!q.trim()}
          aria-controls={listId}
          aria-autocomplete="list"
        />
      </label>
      {/* Suggestions open once typing starts, so two empty slots don't both list the panel. */}
      {q.trim() && (
        <div
          ref={listRef}
          id={listId}
          className="ump-options"
          role="listbox"
          aria-label={`${label} suggestions`}
          onKeyDown={onListKey}
        >
          {options.map((u) => (
            <button
              type="button"
              role="option"
              aria-selected={false}
              key={u.id}
              onClick={() => {
                setQ('');
                onChange(u.id);
              }}
            >
              {u.displayName}
              {u.fullName ? <span className="ump-option-sub"> · {u.fullName}</span> : null}
            </button>
          ))}
          {canAdd && (
            <button
              type="button"
              className="ump-add"
              disabled={busy}
              onClick={() => (captureContacts ? setContacts({ phone: '', email: '' }) : create())}
            >
              + Add “{q.trim()}” as a new {noun}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export interface UmpireCellProps {
  series: Series;
  fixture: FixtureLike;
  allSeries: Series[];
  clubs: Club[];
  umpires: Umpire[];
  /** Double-booking warnings for the SAVED appointment (see doubleBookingIndex). */
  warnings?: string[];
  /** Absent ⇒ read-only (names only). */
  onSave?: (seriesId: string, fixtureId: string, umpireIds: string[]) => Promise<unknown>;
  onCreate?: (displayName: string) => Promise<Umpire>;
  /** Loads the series' notice ledger while a picker is open; failures show no badge. */
  loadNotifyStatus?: (seriesId: string) => Promise<{ rows: OfficialsNotifyStatusRow[] }>;
  /** The scorer register. Absent with nothing saved ⇒ no scorer line (non-cricket verticals). */
  scorers?: Scorer[];
  /** Absent ⇒ the scorer line is read-only. Saved independently of the umpires. */
  onSaveScorers?: (seriesId: string, fixtureId: string, scorerIds: string[]) => Promise<unknown>;
  onCreateScorer?: (displayName: string, contacts?: PersonContacts) => Promise<Scorer>;
}

type OfficialKind = 'umpires' | 'scorers';

const SCORER_LABELS = ['Scorer', 'Backup scorer'];

/** The fixture table's Officials cell: umpire names with a double-booking ⚠, the scorers,
 *  and one slot picker open at a time. */
export function UmpireCell({
  series,
  fixture,
  allSeries,
  clubs,
  umpires,
  warnings: savedWarnings = [],
  onSave,
  onCreate,
  loadNotifyStatus,
  scorers,
  onSaveScorers,
  onCreateScorer,
}: UmpireCellProps) {
  const saved = fixture.officials?.umpires ?? [];
  const savedScorers = fixture.officials?.scorers ?? [];
  const showScorers = scorers !== undefined || savedScorers.length > 0;
  const scorerRegister = scorers ?? [];
  const [openKind, setOpenKind] = useState<OfficialKind | null>(null);
  const [notices, setNotices] = useState<OfficialsNotifyStatusRow[]>([]);
  const open = openKind !== null;
  useEffect(() => {
    if (!open || !loadNotifyStatus) return;
    let live = true;
    loadNotifyStatus(series.id).then(
      (r) => live && setNotices(r.rows ?? []),
      () => {}, // Badges are a nicety: a failed load just shows none.
    );
    return () => {
      live = false;
    };
  }, [open, loadNotifyStatus, series.id]);
  // Scorer ledger rows carry the register id in `umpireId` too.
  const noticeFor = (role: 'umpire' | 'scorer', id: string | null) =>
    id
      ? notices.find((n) => n.fixtureId === fixture.id && n.role === role && n.umpireId === id)
      : undefined;
  const [slots, setSlots] = useState<(string | null)[]>([]);
  const [saving, setSaving] = useState(false);
  const nameOf = (id: string) =>
    umpires.find((u) => u.id === id)?.displayName ??
    saved.find((u) => u.umpireId === id)?.name ??
    id;
  const scorerNameOf = (id: string) =>
    scorerRegister.find((u) => u.id === id)?.displayName ??
    savedScorers.find((u) => u.scorerId === id)?.name ??
    id;
  const pool = allSeries.some((s) => s.id === series.id) ? allSeries : [...allSeries, series];
  const draftIds = slots.filter((x): x is string => !!x);
  const draftWarnings =
    openKind === 'umpires'
      ? doubleBookingWarnings(series.id, fixture.id, draftIds, pool, clubs, nameOf)
      : [];

  function start(kind: OfficialKind) {
    const ids =
      kind === 'umpires' ? saved.map((u) => u.umpireId) : savedScorers.map((u) => u.scorerId);
    const max = kind === 'umpires' ? MAX_UMPIRES_PER_FIXTURE : MAX_SCORERS_PER_FIXTURE;
    setSlots(Array.from({ length: max }, (_, i) => ids[i] ?? null));
    setOpenKind(kind);
  }
  async function save() {
    const write = openKind === 'scorers' ? onSaveScorers : onSave;
    if (!write) return;
    setSaving(true);
    try {
      await write(series.id, fixture.id, draftIds);
      setOpenKind(null);
    } catch {
      // Toasted by the caller; keep the picker open so the choice isn't lost.
    } finally {
      setSaving(false);
    }
  }

  const isScorers = openKind === 'scorers';
  return (
    <div className="ump-cell">
      <div className="ump-names">
        {saved.length ? (
          saved.map((u) => nameOf(u.umpireId)).join(', ')
        ) : (
          <span className="ump-none">—</span>
        )}
        {savedWarnings.length > 0 && (
          <span
            className="ump-warn"
            role="img"
            aria-label={`Possible double booking: ${savedWarnings.join('; ')}`}
            title={savedWarnings.join('\n')}
          >
            {' '}
            ⚠
          </span>
        )}
        {onSave && !open && (
          <button
            type="button"
            className="fix-action-btn ump-edit"
            title="Assign umpires"
            aria-label="Assign umpires"
            onClick={() => start('umpires')}
          >
            <Icon.Whistle />
          </button>
        )}
      </div>
      {showScorers && (
        <div className="ump-names">
          Scorers:{' '}
          {savedScorers.length ? (
            savedScorers.map((u) => scorerNameOf(u.scorerId)).join(', ')
          ) : (
            <span className="ump-none">—</span>
          )}
          {onSaveScorers && !open && (
            <button
              type="button"
              className="fix-action-btn ump-edit"
              title="Assign scorers"
              aria-label="Assign scorers"
              onClick={() => start('scorers')}
            >
              <Icon.Form />
            </button>
          )}
        </div>
      )}
      {open && (
        <div
          className="ump-picker"
          role="group"
          aria-label={isScorers ? 'Assign scorers' : 'Assign umpires'}
        >
          {slots.map((id, i) => (
            <UmpireSlot
              key={`${openKind}-${i}`}
              label={isScorers ? (SCORER_LABELS[i] ?? `Scorer ${i + 1}`) : `Umpire ${i + 1}`}
              value={id}
              exclude={slots.filter((_, j) => j !== i)}
              umpires={isScorers ? scorerRegister : umpires}
              onCreate={isScorers ? onCreateScorer : onCreate}
              noun={isScorers ? 'scorer' : 'umpire'}
              captureContacts={isScorers}
              notice={noticeFor(isScorers ? 'scorer' : 'umpire', id)}
              onChange={(next) => setSlots((prev) => prev.map((x, j) => (j === i ? next : x)))}
            />
          ))}
          {draftWarnings.length > 0 && (
            <div className="ump-warn-box" role="status">
              {draftWarnings.map((w) => (
                <div key={w}>⚠ {w}</div>
              ))}
              <div className="ump-warn-sub">You can still save — this is only a warning.</div>
            </div>
          )}
          <div className="ump-picker-actions">
            <Btn tone="ghost" size="sm" onClick={() => setOpenKind(null)} disabled={saving}>
              Cancel
            </Btn>
            <Btn tone="ink" size="sm" icon={Icon.Check} onClick={save} disabled={saving}>
              {saving ? 'Saving…' : isScorers ? 'Save scorers' : 'Save umpires'}
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Admin Umpires page ─── */

/**
 * The toast for a refused merge, or null for the generic copy: an umpire someone already
 * merged (a stale page, a double-click) names the umpire it went into.
 */
export function mergeErrorMessage(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== 'umpire_already_merged') return null;
  const name = err.details?.mergedIntoName;
  return typeof name === 'string' && name ? `Already merged into ${name}` : 'Already merged';
}

interface UmpireDraft {
  displayName: string;
  fullName: string;
  phone: string;
  email: string;
}

const emptyDraft: UmpireDraft = { displayName: '', fullName: '', phone: '', email: '' };

const draftOf = (u: Umpire): UmpireDraft => ({
  displayName: u.displayName,
  fullName: u.fullName ?? '',
  phone: u.phone ?? '',
  email: u.email ?? '',
});

/** Appointments per umpire across every series (from the officials joined onto GET /series). */
export function appointmentCounts(allSeries: Series[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of allSeries)
    for (const f of fixturesOf(s))
      for (const u of f.officials?.umpires ?? [])
        out.set(u.umpireId, (out.get(u.umpireId) ?? 0) + 1);
  return out;
}

export interface AdminUmpiresViewProps {
  umpires: Umpire[];
  allSeries: Series[];
  loading?: boolean;
  onCreate: (body: Partial<Umpire>) => Promise<unknown>;
  onPatch: (id: string, body: Partial<Umpire>) => Promise<unknown>;
  onMerge: (sourceId: string, targetId: string) => Promise<unknown>;
  /** Opens the "Upload appointments" page. Absent ⇒ no button. */
  onUpload?: () => void;
  /** Captain's reports — rating averages are computed here, in the browser (ADR 0004). */
  reports?: CaptainsReport[];
}

/**
 * Rating averages per umpire, with a merged entry's ratings counted under the umpire it was
 * merged into (reports keep the id that was rated at the time).
 */
export function ratingSummaries(
  reports: CaptainsReport[],
  umpires: Umpire[],
): Map<string, UmpireRatingSummary> {
  const target = new Map(umpires.filter((u) => u.mergedInto).map((u) => [u.id, u.mergedInto!]));
  const resolve = (id: string) => {
    let cur = id;
    for (let i = 0; i < 5 && target.has(cur); i++) cur = target.get(cur)!;
    return cur;
  };
  return umpireRatingAverages(
    reports.map((r) => ({
      status: r.status,
      umpires: r.umpires.map((u) => (u.umpireId ? { ...u, umpireId: resolve(u.umpireId) } : u)),
    })),
  );
}

export function AdminUmpiresView({
  umpires,
  allSeries,
  loading,
  reports = [],
  onCreate,
  onPatch,
  onMerge,
  onUpload,
}: AdminUmpiresViewProps) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'active' | 'inactive' | 'all'>('active');
  const [adding, setAdding] = useState<UmpireDraft | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: UmpireDraft } | null>(null);
  const [merging, setMerging] = useState<{ id: string; targetId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const counts = useMemo(() => appointmentCounts(allSeries), [allSeries]);
  const ratings = useMemo(() => ratingSummaries(reports, umpires), [reports, umpires]);
  const active = umpires.filter((u) => u.active);
  const inactive = umpires.filter((u) => !u.active);
  const list = (filter === 'active' ? active : filter === 'inactive' ? inactive : umpires)
    .filter((u) => matches(u, q))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const run = async (fn: () => Promise<unknown>, after: () => void) => {
    setBusy(true);
    try {
      await fn();
      after();
    } catch {
      // The caller toasts the failure; keep the form open.
    } finally {
      setBusy(false);
    }
  };
  const body = (d: UmpireDraft) => ({
    displayName: d.displayName.trim(),
    fullName: d.fullName.trim() || null,
    phone: d.phone.trim() || null,
    email: d.email.trim() || null,
  });

  const draftFields = (d: UmpireDraft, set: (d: UmpireDraft) => void, idPrefix: string) => (
    <>
      {(
        [
          ['displayName', 'Sheet name', 'e.g. A.Ngubane'],
          ['fullName', 'Full name', 'optional'],
          ['phone', 'Phone', 'optional'],
          ['email', 'Email', 'optional'],
        ] as const
      ).map(([k, l, ph]) => (
        <label key={k} className="ump-form-field" htmlFor={`${idPrefix}-${k}`}>
          {l}
          <input
            id={`${idPrefix}-${k}`}
            type={k === 'email' ? 'email' : 'text'}
            value={d[k]}
            placeholder={ph}
            onChange={(e) => set({ ...d, [k]: e.target.value })}
          />
        </label>
      ))}
    </>
  );

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Admin Console / Umpires</div>
          <h1 className="ph-title">
            <em>Umpires</em>
          </h1>
          <p className="ph-desc">
            The union&apos;s umpire panel. Appoint umpires to fixtures from the Fixtures &amp;
            Venues table, or upload the weekly appointments sheet. Contact details are only ever
            shown to admins.
          </p>
        </div>
        <div className="ph-actions">
          {onUpload && (
            <Btn tone="outline" icon={Icon.Upload} onClick={onUpload}>
              Upload appointments
            </Btn>
          )}
          <Btn tone="teal" icon={Icon.Plus} onClick={() => setAdding({ ...emptyDraft })}>
            Add umpire
          </Btn>
        </div>
      </div>

      <div className="players-stats">
        <div className="players-stat">
          <div className="players-stat-l">Active</div>
          <div className="players-stat-n">{active.length}</div>
        </div>
        <div className="players-stat">
          <div className="players-stat-l">Inactive / merged</div>
          <div className="players-stat-n">{inactive.length}</div>
        </div>
        <div className="players-stat">
          <div className="players-stat-l">Appointments</div>
          <div className="players-stat-n">{[...counts.values()].reduce((a, b) => a + b, 0)}</div>
        </div>
      </div>

      {adding && (
        <div className="ump-form" role="group" aria-label="New umpire">
          {draftFields(adding, setAdding, 'ump-new')}
          <div className="ump-form-actions">
            <Btn tone="ghost" size="sm" onClick={() => setAdding(null)} disabled={busy}>
              Cancel
            </Btn>
            <Btn
              tone="ink"
              size="sm"
              disabled={busy || !adding.displayName.trim()}
              onClick={() =>
                run(
                  () => onCreate(body(adding)),
                  () => setAdding(null),
                )
              }
            >
              {busy ? 'Saving…' : 'Add umpire'}
            </Btn>
          </div>
        </div>
      )}

      <div className="filter-row" style={{ marginTop: 14 }}>
        <input
          className="search-box"
          placeholder="Search umpires…"
          aria-label="Search umpires"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {(
          [
            ['active', 'Active', active.length],
            ['inactive', 'Inactive', inactive.length],
            ['all', 'All', umpires.length],
          ] as const
        ).map(([k, l, n]) => (
          <button
            key={k}
            className={`filter-pill ${filter === k ? 'active' : ''}`}
            aria-pressed={filter === k}
            onClick={() => setFilter(k)}
          >
            {l}
            <span className="count">{n}</span>
          </button>
        ))}
      </div>

      <div className="tbl-w" style={{ marginTop: 14 }}>
        <table className="tbl upl-tbl" aria-label="Umpires">
          <thead>
            <tr>
              <th>Umpire</th>
              <th>Contact</th>
              <th style={{ textAlign: 'right' }}>Appointments</th>
              <th>Ratings</th>
              <th>Status</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="ump-empty">
                  Loading umpires…
                </td>
              </tr>
            )}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan={6} className="ump-empty">
                  {!umpires.length
                    ? 'No umpires yet. Add one, or upload this week’s appointments sheet.'
                    : q.trim()
                      ? 'No umpires match this search.'
                      : filter === 'inactive'
                        ? 'No inactive or merged umpires.'
                        : 'No active umpires. Reactivate one from the Inactive list, or add one.'}
                </td>
              </tr>
            )}
            {list.map((u) => {
              if (editing?.id === u.id)
                return (
                  <tr key={u.id}>
                    <td colSpan={6}>
                      <div className="ump-form" role="group" aria-label={`Edit ${u.displayName}`}>
                        {draftFields(
                          editing.draft,
                          (draft) => setEditing({ id: u.id, draft }),
                          `ump-${u.id}`,
                        )}
                        <div className="ump-form-actions">
                          <Btn
                            tone="ghost"
                            size="sm"
                            onClick={() => setEditing(null)}
                            disabled={busy}
                          >
                            Cancel
                          </Btn>
                          <Btn
                            tone="ink"
                            size="sm"
                            disabled={busy || !editing.draft.displayName.trim()}
                            onClick={() =>
                              run(
                                () => onPatch(u.id, body(editing.draft)),
                                () => setEditing(null),
                              )
                            }
                          >
                            {busy ? 'Saving…' : 'Save'}
                          </Btn>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              const mergeTargets = active.filter((t) => t.id !== u.id);
              return (
                <tr key={u.id}>
                  <td data-label="Umpire">
                    <div style={{ fontWeight: 700 }}>{u.displayName}</div>
                    {u.fullName && <div className="ump-sub">{u.fullName}</div>}
                  </td>
                  <td data-label="Contact">
                    {u.phone || u.email ? (
                      <>
                        {u.phone && <div>{u.phone}</div>}
                        {u.email && <div className="ump-sub">{u.email}</div>}
                      </>
                    ) : (
                      <span className="ump-none">—</span>
                    )}
                  </td>
                  <td data-label="Appointed" className="ump-num">
                    {counts.get(u.id) ?? 0}
                  </td>
                  {/* Averages over submitted captain's reports (computed in the browser). */}
                  <td data-label="Ratings">
                    {(() => {
                      const r = ratings.get(u.id);
                      if (!r) return <span className="ump-none">No ratings yet</span>;
                      return (
                        <span
                          title={`Average of ${r.reports} captain's report${r.reports === 1 ? '' : 's'}`}
                        >
                          <strong>{r.average.toFixed(1)}</strong> / 5
                          <span className="ump-sub">
                            {' '}
                            · {r.reports} report{r.reports === 1 ? '' : 's'}
                          </span>
                          {r.lowReports > 0 && (
                            <>
                              {' '}
                              <Pill tone="coral">{r.lowReports} low</Pill>
                            </>
                          )}
                        </span>
                      );
                    })()}
                  </td>
                  <td data-label="Status">
                    {u.active ? (
                      <Pill tone="teal" dot>
                        Active
                      </Pill>
                    ) : (
                      <Pill tone="muted">
                        {u.mergedInto
                          ? `Merged into ${umpires.find((t) => t.id === u.mergedInto)?.displayName ?? u.mergedInto}`
                          : 'Inactive'}
                      </Pill>
                    )}
                  </td>
                  <td data-label="Actions">
                    {merging?.id === u.id ? (
                      <div className="ump-merge">
                        <select
                          aria-label={`Merge ${u.displayName} into`}
                          value={merging.targetId}
                          onChange={(e) => setMerging({ id: u.id, targetId: e.target.value })}
                        >
                          <option value="">Merge into…</option>
                          {mergeTargets.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.displayName}
                            </option>
                          ))}
                        </select>
                        <Btn
                          tone="ink"
                          size="sm"
                          disabled={busy || !merging.targetId}
                          onClick={() =>
                            run(
                              () => onMerge(u.id, merging.targetId),
                              () => setMerging(null),
                            )
                          }
                        >
                          Merge
                        </Btn>
                        <Btn tone="ghost" size="sm" onClick={() => setMerging(null)}>
                          Cancel
                        </Btn>
                      </div>
                    ) : (
                      <div className="ump-row-actions">
                        <Btn
                          tone="outline"
                          size="sm"
                          onClick={() => setEditing({ id: u.id, draft: draftOf(u) })}
                        >
                          Edit
                        </Btn>
                        {!u.mergedInto && (
                          <Btn
                            tone="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              run(
                                () => onPatch(u.id, { active: !u.active }),
                                () => {},
                              )
                            }
                          >
                            {u.active ? 'Deactivate' : 'Reactivate'}
                          </Btn>
                        )}
                        {!u.mergedInto && mergeTargets.length > 0 && (
                          <Btn
                            tone="ghost"
                            size="sm"
                            onClick={() => setMerging({ id: u.id, targetId: '' })}
                          >
                            Merge…
                          </Btn>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="ump-footnote">
        Merging moves every appointment and the sheet spelling to the umpire you pick, then retires
        the duplicate. It cannot be undone.
      </p>
    </div>
  );
}

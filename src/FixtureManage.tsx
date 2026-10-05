/* ─── Fixtures & Venues hub: managing a fixture without leaving the week ───
 *
 * The union office's match-week jobs, from the fixture where it found the problem:
 *   - add a fixture, edit its date / time / ground / status, remove it;
 *   - appoint umpires (two) and scorers (a scorer and a backup).
 * Every write goes through the SAME server paths the series editor uses — a whole-series
 * PATCH with the version (clash gates, approval recall, medicoach outbox all apply) for the
 * fixture itself, and the per-fixture officials item for umpires/scorers — so nothing here can
 * bypass a rule the editor enforces. Failures stay in the dialog with the reason:
 *   - a ground double-booking (409 venue_clash) lists the clashes;
 *   - a stale page (409 "series changed") asks to reload;
 *   - removing a fixture medicoach already holds (409 synced_fixture_removed) offers
 *     "Mark cancelled" (the supported path) or "Remove here only" (explicit).
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError } from './api';
import { Btn, Modal } from './atoms';
import type { FixtureRow } from './fixture-index';

/* ─── Shapes this module reads (the series cache is loosely typed) ─── */

export interface ManageSeries {
  id: string;
  name: string;
  released?: boolean;
  teams?: string[];
  participants?: Array<{ teamId: string; clubId: string; name: string; venue?: string }>;
  fixtures: unknown[];
}
export interface ManageClub {
  id: string;
  name: string;
  ground?: { venue?: string; secondaryVenue?: string };
}
export interface ManageVenue {
  id: string;
  name: string;
  suburb?: string;
  lat?: number;
  lon?: number;
}
export interface Person {
  id: string;
  displayName: string;
  fullName?: string;
  active: boolean;
}

type Fixture = Record<string, unknown> & { id: string };
type Updater = (s: ManageSeries) => ManageSeries & { confirmRemoveSynced?: boolean };

/** What a rejected series write says, in the office's words. */
export function explainWriteError(err: unknown): {
  text: string;
  clashes?: string[];
  synced?: boolean;
} {
  if (err instanceof ApiError) {
    if (err.code === 'synced_fixture_removed') return { text: err.message, synced: true };
    const clashes = err.details?.clashes as Array<Record<string, unknown>> | undefined;
    if (clashes?.length)
      return {
        text: 'This would double-book a ground. Pick another ground or time.',
        clashes: clashes.map((c) =>
          [c.venue ?? c.venueName ?? 'Ground', c.date, c.message ?? c.reason]
            .filter(Boolean)
            .join(' · '),
        ),
      };
    if (err.status === 409 && /series changed/i.test(err.message))
      return {
        text: 'Someone else changed this series since you opened it. Reload and try again.',
      };
    return { text: err.message || 'Could not save — please try again.' };
  }
  return { text: 'Could not save — check your connection and try again.' };
}

function ErrorBox({ err }: { err: ReturnType<typeof explainWriteError> | null }) {
  if (!err) return null;
  return (
    <div className="insights-callout alert fm-error" role="alert">
      <div>{err.text}</div>
      {err.clashes && (
        <ul>
          {err.clashes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const teamOptions = (s: ManageSeries, clubs: ManageClub[]) =>
  (s.participants?.length
    ? s.participants.map((p) => ({ id: p.teamId, name: p.name }))
    : (s.teams ?? []).map((id) => ({ id, name: clubs.find((c) => c.id === id)?.name ?? id }))
  ).sort((a, b) => a.name.localeCompare(b.name));

const homeGroundOf = (s: ManageSeries, clubs: ManageClub[], teamId?: string) => {
  if (!teamId) return '';
  const p = s.participants?.find((x) => x.teamId === teamId);
  return p?.venue || clubs.find((c) => c.id === (p?.clubId ?? teamId))?.ground?.venue || '';
};

/* ─── Add / edit a fixture ─── */

type GroundMode = 'home' | 'keep' | 'registered' | 'other';

export function FixtureEditDialog({
  mode,
  series,
  initialSeriesId,
  fixtureId,
  clubs,
  venues,
  onUpdateSeries,
  onClose,
  onSaved,
}: {
  mode: 'add' | 'edit';
  series: ManageSeries[];
  initialSeriesId?: string;
  fixtureId?: string;
  clubs: ManageClub[];
  venues: ManageVenue[];
  onUpdateSeries: (id: string, updater: Updater) => Promise<unknown>;
  onClose: () => void;
  onSaved?: (message: string) => void;
}) {
  const uid = useId();
  const [seriesId, setSeriesId] = useState(initialSeriesId ?? series[0]?.id ?? '');
  const s = series.find((x) => x.id === seriesId);
  const existing = (s?.fixtures as Fixture[] | undefined)?.find((f) => f.id === fixtureId);
  const teams = s ? teamOptions(s, clubs) : [];
  const lastRound = Math.max(
    0,
    ...((s?.fixtures as Fixture[]) ?? []).map((f) => Number(f.round) || 0),
  );
  const [draft, setDraft] = useState(() => ({
    round: (existing?.round as number) ?? lastRound + 1,
    date: (existing?.date as string) ?? '',
    time: (existing?.time as string) ?? '',
    home: (existing?.home as string) ?? '',
    away: (existing?.away as string) ?? '',
    status: (existing?.status as string) ?? 'scheduled',
    override: (existing?.venueOverride as string) ?? '',
    venueId: (existing?.venueId as string) ?? '',
  }));
  const [ground, setGround] = useState<GroundMode>(() =>
    existing?.venueOverride ? 'other' : existing?.venueName || existing?.venueId ? 'keep' : 'home',
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<ReturnType<typeof explainWriteError> | null>(null);
  const set = (k: keyof typeof draft, v: string | number) => setDraft((d) => ({ ...d, [k]: v }));
  const home = homeGroundOf(s ?? { id: '', name: '', fixtures: [] }, clubs, draft.home);
  const allocatedName = (existing?.venueName as string) || '';
  const syncMapped = existing?.syncMapped === true;

  const problems = [
    !s && 'Pick a series.',
    !draft.date && 'Pick a date.',
    (!draft.home || !draft.away) && 'Pick both teams.',
    draft.home && draft.home === draft.away && 'A team cannot play itself.',
    ground === 'registered' && !draft.venueId && 'Pick a ground.',
    ground === 'other' && !draft.override.trim() && 'Type the ground, or pick another option.',
    draft.time && !/^\d{2}:\d{2}$/.test(draft.time) && 'Start time must be HH:MM.',
  ].filter(Boolean) as string[];

  /** The fixture as it will be stored: ground precedence override → allocated → home. */
  function next(prev: Fixture | undefined): Fixture {
    const base: Fixture = {
      ...(prev ?? { id: `f${Date.now()}` }),
      round: Number(draft.round) || 1,
      date: draft.date,
      home: draft.home,
      away: draft.away,
      status: draft.status,
    };
    if (draft.time) base.time = draft.time;
    else delete base.time;
    const clearAllocated = () => {
      delete base.venueId;
      delete base.venueName;
      delete base.venueLat;
      delete base.venueLon;
      delete base.venueStatus;
      delete base.venueReason;
      delete base.venueLocked;
    };
    if (ground === 'home') {
      clearAllocated();
      delete base.venueOverride;
    } else if (ground === 'other') {
      clearAllocated();
      base.venueOverride = draft.override.trim();
    } else if (ground === 'registered') {
      const v = venues.find((x) => x.id === draft.venueId)!;
      clearAllocated();
      delete base.venueOverride;
      base.venueId = v.id;
      base.venueName = v.name;
      if (v.lat != null) base.venueLat = v.lat;
      if (v.lon != null) base.venueLon = v.lon;
      // Picked by hand: lock it, so a later "Allocate venues" never moves it.
      base.venueLocked = true;
      base.venueStatus = v.name === home ? 'home' : 'alternative';
      base.venueReason = v.name === home ? '' : 'Union directive';
    } else {
      delete base.venueOverride;
    }
    return base;
  }

  async function save() {
    if (problems.length || !s) return;
    setSaving(true);
    setErr(null);
    try {
      await onUpdateSeries(s.id, (cur) => ({
        ...cur,
        fixtures:
          mode === 'add'
            ? [...(cur.fixtures as Fixture[]), next(undefined)]
            : (cur.fixtures as Fixture[]).map((f) => (f.id === fixtureId ? next(f) : f)),
      }));
      onSaved?.(mode === 'add' ? 'Fixture added' : 'Fixture saved');
      onClose();
    } catch (e) {
      setErr(explainWriteError(e));
      setSaving(false);
    }
  }

  return (
    <Modal
      eyebrow={s?.name ?? 'Fixtures'}
      title={mode === 'add' ? 'Add a fixture' : 'Edit fixture'}
      maxWidth={640}
      onClose={onClose}
      confirmClose={!saving}
    >
      <div className="fm-grid">
        {mode === 'add' && (
          <label className="fm-field fm-wide">
            Series
            <select value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
              {series.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="fm-field">
          Date
          <input type="date" value={draft.date} onChange={(e) => set('date', e.target.value)} />
        </label>
        <label className="fm-field">
          Start time
          <input type="time" value={draft.time} onChange={(e) => set('time', e.target.value)} />
        </label>
        <label className="fm-field">
          Round
          <input
            type="number"
            min={1}
            value={draft.round}
            onChange={(e) => set('round', parseInt(e.target.value) || 1)}
          />
        </label>
        <label className="fm-field">
          Status
          <select value={draft.status} onChange={(e) => set('status', e.target.value)}>
            <option value="scheduled">Scheduled</option>
            <option value="postponed">Postponed</option>
            <option value="cancelled">Cancelled</option>
            <option value="completed" disabled={syncMapped}>
              {syncMapped ? 'Completed (set by medicoach)' : 'Completed'}
            </option>
          </select>
        </label>
        <label className="fm-field">
          Home (host)
          <select value={draft.home} onChange={(e) => set('home', e.target.value)}>
            <option value="">Pick a team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="fm-field">
          Away (visitors)
          <select value={draft.away} onChange={(e) => set('away', e.target.value)}>
            <option value="">Pick a team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="fm-field fm-wide fm-ground">
          <legend>Ground</legend>
          <label className="fm-radio">
            <input
              type="radio"
              name={`${uid}-ground`}
              checked={ground === 'home'}
              onChange={() => setGround('home')}
            />
            Home ground{home ? ` · ${home}` : ' (the host has none on record)'}
          </label>
          {allocatedName && (
            <label className="fm-radio">
              <input
                type="radio"
                name={`${uid}-ground`}
                checked={ground === 'keep'}
                onChange={() => setGround('keep')}
              />
              Keep the allocated ground · {allocatedName}
            </label>
          )}
          <label className="fm-radio">
            <input
              type="radio"
              name={`${uid}-ground`}
              checked={ground === 'registered'}
              onChange={() => setGround('registered')}
            />
            A registered ground
          </label>
          {ground === 'registered' && (
            <select
              aria-label="Registered ground"
              value={draft.venueId}
              onChange={(e) => set('venueId', e.target.value)}
            >
              <option value="">Pick a ground</option>
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.suburb ? ` · ${v.suburb}` : ''}
                </option>
              ))}
            </select>
          )}
          <label className="fm-radio">
            <input
              type="radio"
              name={`${uid}-ground`}
              checked={ground === 'other'}
              onChange={() => setGround('other')}
            />
            Somewhere else
          </label>
          {ground === 'other' && (
            <input
              type="text"
              aria-label="Ground name"
              placeholder="Ground name"
              value={draft.override}
              onChange={(e) => set('override', e.target.value)}
            />
          )}
        </fieldset>
      </div>
      {s?.released && (
        <p className="fm-note">
          This series is released: clubs see the change straight away, and a synced fixture&apos;s
          new date, time or ground goes to medicoach on the next sync.
        </p>
      )}
      {problems.length > 0 && (
        <ul className="fm-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <ErrorBox err={err} />
      <div className="fm-actions">
        <Btn tone="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Btn>
        <Btn tone="ink" onClick={save} disabled={saving || problems.length > 0}>
          {saving ? 'Saving…' : mode === 'add' ? 'Add fixture' : 'Save fixture'}
        </Btn>
      </div>
    </Modal>
  );
}

/* ─── Remove a fixture (or cancel it, when medicoach holds it) ─── */

export function RemoveFixtureDialog({
  row,
  onUpdateSeries,
  onClose,
  onSaved,
}: {
  row: FixtureRow;
  onUpdateSeries: (id: string, updater: Updater) => Promise<unknown>;
  onClose: () => void;
  onSaved?: (message: string) => void;
}) {
  const [busy, setBusy] = useState<null | 'remove' | 'cancel' | 'force'>(null);
  const [err, setErr] = useState<ReturnType<typeof explainWriteError> | null>(null);
  const run = async (kind: 'remove' | 'cancel' | 'force') => {
    setBusy(kind);
    setErr(null);
    try {
      await onUpdateSeries(row.seriesId, (cur) =>
        kind === 'cancel'
          ? {
              ...cur,
              fixtures: (cur.fixtures as Fixture[]).map((f) =>
                f.id === row.fixtureId ? { ...f, status: 'cancelled' } : f,
              ),
            }
          : {
              ...cur,
              fixtures: (cur.fixtures as Fixture[]).filter((f) => f.id !== row.fixtureId),
              ...(kind === 'force' ? { confirmRemoveSynced: true } : {}),
            },
      );
      onSaved?.(kind === 'cancel' ? 'Fixture marked cancelled' : 'Fixture removed');
      onClose();
    } catch (e) {
      setErr(explainWriteError(e));
      setBusy(null);
    }
  };
  return (
    <Modal eyebrow={row.seriesName} title="Remove this fixture?" maxWidth={520} onClose={onClose}>
      <p className="fm-lead">
        <strong>
          {row.home} v {row.away}
        </strong>{' '}
        · {row.date ?? 'date TBC'}
        {row.time ? ` ${row.time}` : ''}
        {row.venue ? ` · ${row.venue}` : ''}
      </p>
      <p className="fm-note">
        Removing deletes it from the schedule with its umpire and scorer appointments. If the game
        is simply off, <strong>Mark cancelled</strong> keeps the record (and tells medicoach).
      </p>
      <ErrorBox err={err} />
      <div className="fm-actions">
        <Btn tone="outline" onClick={onClose} disabled={!!busy}>
          Keep it
        </Btn>
        <Btn tone="outline" onClick={() => run('cancel')} disabled={!!busy}>
          {busy === 'cancel' ? 'Saving…' : 'Mark cancelled'}
        </Btn>
        {err?.synced ? (
          <Btn tone="ink" onClick={() => run('force')} disabled={!!busy}>
            {busy === 'force' ? 'Removing…' : 'Remove here only'}
          </Btn>
        ) : (
          <Btn tone="ink" onClick={() => run('remove')} disabled={!!busy}>
            {busy === 'remove' ? 'Removing…' : 'Remove fixture'}
          </Btn>
        )}
      </div>
    </Modal>
  );
}

/* ─── Appoint umpires or scorers ─── */

const matchName = (p: Person, q: string) => {
  const k = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const w = k(q);
  return !w || k(p.displayName).includes(w) || k(p.fullName ?? '').includes(w);
};

function PersonSlot({
  label,
  value,
  exclude,
  people,
  noun,
  onChange,
  onCreate,
}: {
  label: string;
  value: string | null;
  exclude: (string | null)[];
  people: Person[];
  noun: string;
  onChange: (id: string | null) => void;
  onCreate?: (displayName: string) => Promise<Person>;
}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const chosen = value ? people.find((p) => p.id === value) : undefined;
  if (value)
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
      </div>
    );
  const options = people
    .filter((p) => p.active && !exclude.includes(p.id) && matchName(p, q))
    .slice(0, 6);
  const exact = people.some(
    (p) => p.active && p.displayName.toLowerCase().trim() === q.toLowerCase().trim(),
  );
  const canAdd = !!onCreate && q.trim().length > 1 && !exact;
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = [...(listRef.current?.querySelectorAll('button') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') return setQ('');
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    all[Math.max(0, Math.min(all.length - 1, e.key === 'ArrowDown' ? i + 1 : i - 1))]?.focus();
  };
  return (
    <div className="ump-slot">
      <label className="ump-slot-l">
        {label}
        <input
          type="text"
          value={q}
          placeholder="Type a name…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              listRef.current?.querySelector('button')?.focus();
            }
          }}
          aria-label={label}
          role="combobox"
          aria-expanded={!!q.trim()}
          aria-controls={listId}
          aria-autocomplete="list"
        />
      </label>
      {q.trim() && (
        <div
          ref={listRef}
          id={listId}
          className="ump-options"
          role="listbox"
          aria-label={`${label} suggestions`}
          onKeyDown={onListKey}
        >
          {options.map((p) => (
            <button
              type="button"
              role="option"
              aria-selected={false}
              key={p.id}
              onClick={() => (setQ(''), onChange(p.id))}
            >
              {p.displayName}
              {p.fullName ? <span className="ump-option-sub"> · {p.fullName}</span> : null}
            </button>
          ))}
          {!options.length && !canAdd && <div className="ump-option-sub">No match.</div>}
          {canAdd && (
            <button
              type="button"
              className="ump-add"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const created = await onCreate!(q.trim());
                  setQ('');
                  onChange(created.id);
                } catch {
                  /* the caller toasts the reason */
                } finally {
                  setBusy(false);
                }
              }}
            >
              + Add “{q.trim()}” as a new {noun}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function OfficialsDialog({
  kind,
  row,
  people,
  current,
  others,
  onSave,
  onCreate,
  onClose,
  onSaved,
}: {
  kind: 'umpires' | 'scorers';
  row: FixtureRow;
  people: Person[];
  /** Registry ids appointed now, in slot order. */
  current: string[];
  /**
   * Other fixtures on the same day: who is already appointed where (to warn, never block —
   * the union double-books on purpose when one person covers back-to-back games).
   */
  others: Array<{ label: string; ids: string[]; time?: string }>;
  onSave: (ids: string[]) => Promise<unknown>;
  onCreate?: (displayName: string) => Promise<Person>;
  onClose: () => void;
  onSaved?: (message: string) => void;
}) {
  const [slots, setSlots] = useState<(string | null)[]>([current[0] ?? null, current[1] ?? null]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<ReturnType<typeof explainWriteError> | null>(null);
  const labels = kind === 'umpires' ? ['Umpire 1', 'Umpire 2'] : ['Scorer', 'Backup scorer'];
  const noun = kind === 'umpires' ? 'umpire' : 'scorer';
  const chosen = slots.filter((x): x is string => !!x);
  const elsewhere = useMemo(
    () =>
      chosen.flatMap((id) =>
        others
          .filter((o) => o.ids.includes(id))
          .map((o) => {
            const who = people.find((p) => p.id === id)?.displayName ?? id;
            return `${who} is also on ${o.label}${o.time ? ` (${o.time})` : ''}`;
          }),
      ),
    [chosen, others, people],
  );
  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await onSave(chosen);
      onSaved?.(kind === 'umpires' ? 'Umpires saved' : 'Scorers saved');
      onClose();
    } catch (e) {
      setErr(explainWriteError(e));
      setSaving(false);
    }
  }
  return (
    <Modal
      eyebrow={`${row.home} v ${row.away} · ${row.date ?? 'date TBC'}${row.time ? ` ${row.time}` : ''}`}
      title={kind === 'umpires' ? 'Appoint umpires' : 'Appoint scorers'}
      maxWidth={520}
      onClose={onClose}
    >
      <div className="ump-picker fm-picker">
        {labels.map((label, i) => (
          <PersonSlot
            key={label}
            label={label}
            value={slots[i]}
            exclude={slots.filter((_, j) => j !== i)}
            people={people}
            noun={noun}
            onChange={(id) => setSlots((s) => s.map((v, j) => (j === i ? id : v)))}
            onCreate={onCreate}
          />
        ))}
      </div>
      {kind === 'scorers' && (
        <p className="fm-note">
          The union&apos;s roster of who scores which game. Scorers still sign in to medicoach with
          their own scorer login.
        </p>
      )}
      {elsewhere.length > 0 && (
        <div className="insights-callout warn fm-warn" role="note">
          {elsewhere.map((w) => (
            <div key={w}>⚠ {w}</div>
          ))}
        </div>
      )}
      <ErrorBox err={err} />
      <div className="fm-actions">
        <Btn tone="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Btn>
        <Btn tone="ink" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : `Save ${kind}`}
        </Btn>
      </div>
    </Modal>
  );
}

/* ─── Umpire allocation — the fixture editor's Umpires cell and the admin Umpires page ───
   Appointments are written with their own call (PUT …/officials), never through the series
   PATCH, so assigning an umpire never withdraws approval or runs the clash gate. */

import { useMemo, useState } from 'react';
import { Btn, Icon, Pill } from './atoms';
import {
  MAX_UMPIRES_PER_FIXTURE,
  findUmpireDoubleBookings,
  normaliseUmpireAlias,
  type UmpireBooking,
} from '../packages/engine/src/umpires';
import type { CaptainsReport, Club, FixtureOfficials, Series, Umpire } from './types';
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

function matches(u: Umpire, q: string): boolean {
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
}: {
  label: string;
  value: string | null;
  exclude: (string | null)[];
  umpires: Umpire[];
  onChange: (id: string | null) => void;
  onCreate?: (displayName: string) => Promise<Umpire>;
}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = value ? umpires.find((u) => u.id === value) : undefined;
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
  return (
    <div className="ump-slot">
      <label className="ump-slot-l">
        {label}
        <input
          type="text"
          value={q}
          placeholder="Type a name…"
          onChange={(e) => setQ(e.target.value)}
          aria-label={label}
        />
      </label>
      {/* Suggestions open once typing starts, so two empty slots don't both list the panel. */}
      {q.trim() && (
        <div className="ump-options" role="listbox" aria-label={`${label} suggestions`}>
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
              onClick={async () => {
                setBusy(true);
                try {
                  const created = await onCreate!(q.trim());
                  setQ('');
                  onChange(created.id);
                } catch {
                  // The caller toasts the reason (e.g. the name already exists).
                } finally {
                  setBusy(false);
                }
              }}
            >
              + Add “{q.trim()}” as a new umpire
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
}

/** The fixture table's Umpires cell: names, a double-booking ⚠, and a 1–2 slot picker. */
export function UmpireCell({
  series,
  fixture,
  allSeries,
  clubs,
  umpires,
  warnings: savedWarnings = [],
  onSave,
  onCreate,
}: UmpireCellProps) {
  const saved = fixture.officials?.umpires ?? [];
  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState<(string | null)[]>([]);
  const [saving, setSaving] = useState(false);
  const nameOf = (id: string) =>
    umpires.find((u) => u.id === id)?.displayName ??
    saved.find((u) => u.umpireId === id)?.name ??
    id;
  const pool = allSeries.some((s) => s.id === series.id) ? allSeries : [...allSeries, series];
  const draftIds = slots.filter((x): x is string => !!x);
  const draftWarnings = open
    ? doubleBookingWarnings(series.id, fixture.id, draftIds, pool, clubs, nameOf)
    : [];

  function start() {
    const ids = saved.map((u) => u.umpireId);
    setSlots(Array.from({ length: MAX_UMPIRES_PER_FIXTURE }, (_, i) => ids[i] ?? null));
    setOpen(true);
  }
  async function save() {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave(series.id, fixture.id, draftIds);
      setOpen(false);
    } catch {
      // Toasted by the caller; keep the picker open so the choice isn't lost.
    } finally {
      setSaving(false);
    }
  }

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
            onClick={start}
          >
            <Icon.Whistle />
          </button>
        )}
      </div>
      {open && (
        <div className="ump-picker" role="group" aria-label="Assign umpires">
          {slots.map((id, i) => (
            <UmpireSlot
              key={i}
              label={`Umpire ${i + 1}`}
              value={id}
              exclude={slots.filter((_, j) => j !== i)}
              umpires={umpires}
              onCreate={onCreate}
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
            <Btn tone="ghost" size="sm" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Btn>
            <Btn tone="ink" size="sm" icon={Icon.Check} onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save umpires'}
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Admin Umpires page ─── */

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
            Venues table, or load the weekly appointments sheet with the importer. Contact details
            are only ever shown to admins.
          </p>
        </div>
        <div className="ph-right">
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
            onClick={() => setFilter(k)}
          >
            {l}
            <span className="count">{n}</span>
          </button>
        ))}
      </div>

      <div className="tbl-w" style={{ marginTop: 14 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Umpire</th>
              <th>Contact</th>
              <th style={{ textAlign: 'right' }}>Appointments</th>
              <th>Ratings</th>
              <th>Status</th>
              <th style={{ width: 220 }}></th>
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
                  {umpires.length
                    ? 'No umpires match this search.'
                    : 'No umpires yet. Add one, or run the appointments importer.'}
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
                  <td>
                    <div style={{ fontWeight: 700 }}>{u.displayName}</div>
                    {u.fullName && <div className="ump-sub">{u.fullName}</div>}
                  </td>
                  <td>
                    {u.phone || u.email ? (
                      <>
                        {u.phone && <div>{u.phone}</div>}
                        {u.email && <div className="ump-sub">{u.email}</div>}
                      </>
                    ) : (
                      <span className="ump-none">—</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{counts.get(u.id) ?? 0}</td>
                  {/* Averages over submitted captain's reports (computed in the browser). */}
                  <td>
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
                  <td>
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
                  <td>
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

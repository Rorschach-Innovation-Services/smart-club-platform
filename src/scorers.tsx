/* ─── Admin Scorers page ───
   The union's scorer register: the Umpires page's shape without aliases, ratings or the
   appointments-sheet upload. Appointments are made from the fixture table's Officials cell. */

import { useMemo, useState } from 'react';
import { Btn, Icon, Pill } from './atoms';
import { ApiError, type OfficialListExtras } from './api';
import {
  DeleteOfficialDialog,
  NoticeBar,
  PendingActions,
  PendingDetails,
  PendingPill,
  SignupLinkModal,
  isErased,
  partitionOfficials,
  type ErasePreview,
  type Notice,
  type OfficialFilter,
  type PendingHandlers,
  type SignupLinkHandlers,
} from './officialsAdmin';
import { fixtureVenueLabel } from './umpires';
import { normalizeText } from './fuzzyMatch';
import type { Club, FixtureOfficials, Scorer, Series } from './types';

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

/** The toast for a refused merge, or null for the generic copy (mirrors the umpires one). */
export function scorerMergeErrorMessage(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== 'scorer_already_merged') return null;
  const name = err.details?.mergedIntoName;
  return typeof name === 'string' && name ? `Already merged into ${name}` : 'Already merged';
}

/** Appointments per scorer across every series (from the officials joined onto GET /series). */
export function scorerAppointmentCounts(allSeries: Series[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of allSeries)
    for (const f of fixturesOf(s))
      for (const x of f.officials?.scorers ?? [])
        out.set(x.scorerId, (out.get(x.scorerId) ?? 0) + 1);
  return out;
}

/** Each scorer's fixtures on or after `today` (YYYY-MM-DD), soonest first, as one-line labels. */
export function scorerUpcomingAppointments(
  allSeries: Series[],
  clubs: Club[],
  today: string,
): Map<string, string[]> {
  const rows = new Map<string, Array<{ key: string; label: string }>>();
  for (const s of allSeries) {
    const teamName = (id?: string) =>
      (s.participants ?? []).find((p) => p.teamId === id)?.name ??
      clubs.find((c) => c.id === id)?.name ??
      id ??
      '';
    for (const f of fixturesOf(s)) {
      if (!f.date || f.date < today) continue;
      const venue = fixtureVenueLabel(s, f, clubs);
      const label = `${f.date}${f.time ? ` ${f.time}` : ''} · ${teamName(f.home)} v ${teamName(f.away)}${venue ? ` · ${venue}` : ''}`;
      for (const x of f.officials?.scorers ?? []) {
        const list = rows.get(x.scorerId) ?? [];
        list.push({ key: `${f.date} ${f.time ?? ''}`, label });
        rows.set(x.scorerId, list);
      }
    }
  }
  return new Map(
    [...rows].map(([id, list]) => [
      id,
      list.sort((a, b) => a.key.localeCompare(b.key)).map((x) => x.label),
    ]),
  );
}

interface ScorerDraft {
  displayName: string;
  fullName: string;
  phone: string;
  email: string;
  idNumber: string;
  emergencyPhone: string;
  address: string;
}

const emptyDraft: ScorerDraft = {
  displayName: '',
  fullName: '',
  phone: '',
  email: '',
  idNumber: '',
  emergencyPhone: '',
  address: '',
};

const draftOf = (u: Scorer): ScorerDraft => ({
  displayName: u.displayName,
  fullName: u.fullName ?? '',
  phone: u.phone ?? '',
  email: u.email ?? '',
  idNumber: u.idNumber ?? '',
  emergencyPhone: u.emergencyPhone ?? '',
  address: u.address ?? '',
});

function matches(u: Scorer, q: string): boolean {
  const n = normalizeText(q);
  if (!n) return true;
  return normalizeText(u.displayName).includes(n) || normalizeText(u.fullName ?? '').includes(n);
}

export interface AdminScorersViewProps extends PendingHandlers {
  /** The admin list: erased stubs (`erased: true`) stay in for name lookups. */
  scorers: (Scorer & OfficialListExtras)[];
  allSeries: Series[];
  clubs: Club[];
  loading?: boolean;
  onCreate: (body: Partial<Scorer>) => Promise<unknown>;
  onPatch: (id: string, body: Partial<Scorer>) => Promise<unknown>;
  onMerge: (sourceId: string, targetId: string) => Promise<unknown>;
  /** Loads Delete's confirm counts. With `onErase`, every non-pending row gets Delete. */
  loadErasePreview?: (id: string) => Promise<ErasePreview>;
  /** The scorer self-registration link. Absent ⇒ no "Registration link" button. */
  signupLink?: SignupLinkHandlers;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

export function AdminScorersView({
  scorers,
  allSeries,
  clubs,
  loading,
  onCreate,
  onPatch,
  onMerge,
  onApprove,
  onMergePending,
  onErase,
  loadErasePreview,
  signupLink,
}: AdminScorersViewProps) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<OfficialFilter>('active');
  const [notice, setNotice] = useState<Notice>(null);
  const [deleting, setDeleting] = useState<Scorer | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [adding, setAdding] = useState<ScorerDraft | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: ScorerDraft } | null>(null);
  const [merging, setMerging] = useState<{ id: string; targetId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const counts = useMemo(() => scorerAppointmentCounts(allSeries), [allSeries]);
  const upcoming = useMemo(
    () => scorerUpcomingAppointments(allSeries, clubs, todayIso()),
    [allSeries, clubs],
  );
  const { visible, active, pending, inactive } = partitionOfficials(scorers);
  const erasedIds = new Set(scorers.filter(isErased).map((u) => u.id));
  const list = (
    filter === 'active'
      ? active
      : filter === 'pending'
        ? pending
        : filter === 'inactive'
          ? inactive
          : visible
  )
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
  const body = (d: ScorerDraft) => ({
    displayName: d.displayName.trim(),
    fullName: d.fullName.trim() || null,
    phone: d.phone.trim() || null,
    email: d.email.trim() || null,
    idNumber: d.idNumber.trim() || null,
    emergencyPhone: d.emergencyPhone.trim() || null,
    address: d.address.trim() || null,
  });

  const draftFields = (d: ScorerDraft, set: (d: ScorerDraft) => void, idPrefix: string) => (
    <>
      {(
        [
          ['displayName', 'Name', 'e.g. L.Naidoo'],
          ['fullName', 'Full name', 'optional'],
          ['phone', 'Phone', 'optional'],
          ['email', 'Email', 'optional'],
          ['idNumber', 'ID number', 'optional'],
          ['emergencyPhone', 'Emergency contact', 'optional'],
          ['address', 'Home address', 'optional'],
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
          <div className="ph-crumb">Admin Console / Scorers</div>
          <h1 className="ph-title">
            <em>Scorers</em>
          </h1>
          <p className="ph-desc">
            The union&apos;s scorer register. Appoint a scorer and a backup to fixtures from the
            Fixtures &amp; Venues table. Contact details are only ever shown to admins.
          </p>
        </div>
        <div className="ph-actions">
          {signupLink && (
            <Btn
              tone="outline"
              icon={Icon.Form}
              data-testid="officials-signup-link"
              onClick={() => setLinkOpen(true)}
            >
              Registration link
            </Btn>
          )}
          <Btn tone="teal" icon={Icon.Plus} onClick={() => setAdding({ ...emptyDraft })}>
            Add scorer
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
          <div className="players-stat-n">
            {[...counts].reduce((a, [id, n]) => (erasedIds.has(id) ? a : a + n), 0)}
          </div>
        </div>
      </div>

      <NoticeBar notice={notice} onDismiss={() => setNotice(null)} />

      {adding && (
        <div className="ump-form" role="group" aria-label="New scorer">
          {draftFields(adding, setAdding, 'scr-new')}
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
              {busy ? 'Saving…' : 'Add scorer'}
            </Btn>
          </div>
        </div>
      )}

      <div className="filter-row" style={{ marginTop: 14 }}>
        <input
          className="search-box"
          placeholder="Search scorers…"
          aria-label="Search scorers"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {(
          [
            ['active', 'Active', active.length],
            ['pending', 'Pending', pending.length],
            ['inactive', 'Inactive', inactive.length],
            ['all', 'All', visible.length],
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
        <table className="tbl upl-tbl" aria-label="Scorers">
          <thead>
            <tr>
              <th>Scorer</th>
              <th>Contact</th>
              <th style={{ textAlign: 'right' }}>Appointments</th>
              <th>Status</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="ump-empty">
                  Loading scorers…
                </td>
              </tr>
            )}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan={5} className="ump-empty">
                  {!visible.length
                    ? 'No scorers yet. Add one here, or from a fixture’s Officials cell.'
                    : q.trim()
                      ? 'No scorers match this search.'
                      : filter === 'pending'
                        ? 'No registrations waiting for review.'
                        : filter === 'inactive'
                          ? 'No inactive or merged scorers.'
                          : 'No active scorers. Reactivate one from the Inactive list, or add one.'}
                </td>
              </tr>
            )}
            {list.map((u) => {
              if (editing?.id === u.id)
                return (
                  <tr key={u.id}>
                    <td colSpan={5}>
                      <div className="ump-form" role="group" aria-label={`Edit ${u.displayName}`}>
                        {draftFields(
                          editing.draft,
                          (draft) => setEditing({ id: u.id, draft }),
                          `scr-${u.id}`,
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
              const next = upcoming.get(u.id) ?? [];
              const isPending = !!u.pending;
              return (
                <tr key={u.id} data-testid={isPending ? 'pending-row' : undefined}>
                  <td data-label="Scorer">
                    <div style={{ fontWeight: 700 }}>{u.displayName}</div>
                    {u.fullName && <div className="ump-sub">{u.fullName}</div>}
                    {isPending && <PendingDetails official={u} />}
                  </td>
                  <td data-label="Contact">
                    {u.phone || u.email || u.emergencyPhone ? (
                      <>
                        {u.phone && <div>{u.phone}</div>}
                        {u.email && <div className="ump-sub">{u.email}</div>}
                        {u.emergencyPhone && (
                          <div className="ump-sub">Emergency: {u.emergencyPhone}</div>
                        )}
                      </>
                    ) : (
                      <span className="ump-none">—</span>
                    )}
                  </td>
                  <td
                    data-label="Appointed"
                    className="ump-num"
                    title={next.length ? `Upcoming:\n${next.join('\n')}` : undefined}
                  >
                    {counts.get(u.id) ?? 0}
                  </td>
                  <td data-label="Status">
                    {isPending ? (
                      <PendingPill />
                    ) : u.active ? (
                      <Pill tone="teal" dot>
                        Active
                      </Pill>
                    ) : (
                      <Pill tone="muted">
                        {u.mergedInto
                          ? `Merged into ${scorers.find((t) => t.id === u.mergedInto)?.displayName ?? u.mergedInto}`
                          : 'Inactive'}
                      </Pill>
                    )}
                  </td>
                  <td data-label="Actions">
                    {isPending ? (
                      <PendingActions
                        role="scorer"
                        official={u}
                        activeEntries={active}
                        onApprove={onApprove}
                        onMergePending={onMergePending}
                        onErase={onErase}
                        onEdit={() => setEditing({ id: u.id, draft: draftOf(u) })}
                        onNotice={setNotice}
                      />
                    ) : merging?.id === u.id ? (
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
                        {onErase && loadErasePreview && (
                          <Btn
                            tone="ghost"
                            size="sm"
                            data-testid="official-delete"
                            onClick={() => setDeleting(u)}
                          >
                            Delete
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
        {filter === 'pending'
          ? 'Approve adds the person to the register. Merge into… adds their details to an entry that is already there; nothing on that entry is replaced unless you choose it.'
          : `Merging moves every appointment to the scorer you pick, then retires the duplicate. It cannot be undone.`}
      </p>
      {deleting && onErase && loadErasePreview && (
        <DeleteOfficialDialog
          role="scorer"
          official={deleting}
          loadPreview={loadErasePreview}
          onErase={onErase}
          onClose={() => setDeleting(null)}
          onDone={setNotice}
        />
      )}
      {linkOpen && signupLink && (
        <SignupLinkModal role="scorer" link={signupLink} onClose={() => setLinkOpen(false)} />
      )}
    </div>
  );
}

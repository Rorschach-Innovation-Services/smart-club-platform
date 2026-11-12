/**
 * Audit trail screens (ADR 0023; contract: docs/api/audit.md).
 *
 * - `AuditActivityView` — the admin console's Activity page (and, with a `source`, the
 *   operator portal's per-client Activity and platform feed): newest first, filtered by
 *   person, record type and dates, "Load more" on the API cursor, and each row expanding to
 *   a Before → After table loaded only when opened.
 * - `HistoryButton` / `HistoryModal` — one record's history, same rows, loaded on open.
 *
 * Every word comes from `auditFormat.ts`; this file is layout and data loading only.
 */
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import * as api from './api';
import { ApiError } from './api';
import { qk } from './query';
import { Btn, EmptyState, Icon, Modal, Pill, useNestedEscapeClose } from './atoms';
import {
  AUDIT_FILTER_TYPES,
  auditActionSentence,
  auditActorDisplay,
  auditChangeRow,
  auditCountsText,
  auditInProgress,
  auditOutcomeLabel,
  auditTargetLabel,
  auditTypeLabel,
  auditWhen,
  type AuditLabelResolver,
} from './auditFormat';
import type { AuditEntry, AuditEntryWithDetail, AuditPage, TenantUser } from './types';

/* ─── Where the entries come from ─── */

/**
 * `admin`: the signed-in union's own feed (union-visible entries). `tenant`: one union seen
 * from the operator portal (every entry). `platform`: the operator portal's platform-level
 * entries, which belong to no union.
 */
export type AuditSource =
  | { kind: 'admin' }
  | { kind: 'tenant'; slug: string }
  | { kind: 'platform' };

const ADMIN: AuditSource = { kind: 'admin' };

/** `from` / `to` are the viewer's local days (YYYY-MM-DD), as the date inputs hold them. */
type Filters = { actor?: string; type?: string; from?: string; to?: string };

/** A local day's first / last instant, as the API takes it ("when" renders local time too). */
function localDayBound(day: string, end: boolean): string {
  const [y, m, d] = day.split('-').map(Number);
  return (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
}

/** The feed query for a set of filters: local days become instants. */
function feedQuery(filters: Filters): api.AuditFeedQuery {
  const { from, to, ...rest } = filters;
  return {
    ...rest,
    ...(from ? { from: localDayBound(from, false) } : {}),
    ...(to ? { to: localDayBound(to, true) } : {}),
  };
}

/** `f` with the date bounds `d` (the same object when they already match: no refetch). */
const withDates = (f: Filters, d: Pick<Filters, 'from' | 'to'>): Filters =>
  f.from === d.from && f.to === d.to ? f : { ...f, from: d.from, to: d.to };

/** How long a date input waits for more typing before it reloads the feed. */
const DATE_APPLY_MS = 700;

/** The operator-side slug for a source ('*' is the platform partition). */
const slugOf = (source: AuditSource) =>
  source.kind === 'tenant' ? source.slug : api.PLATFORM_AUDIT_SLUG;

function feedKey(source: AuditSource, filters: Filters) {
  return source.kind === 'admin'
    ? qk.auditFeed(filters)
    : qk.platformAuditFeed(slugOf(source), filters);
}
function fetchFeed(source: AuditSource, query: api.AuditFeedQuery): Promise<AuditPage> {
  if (source.kind === 'admin') return api.getAuditFeed(query);
  if (source.kind === 'tenant') return api.platformGetAuditFeed(source.slug, query);
  return api.platformGetPlatformAuditFeed(query);
}
function entityKey(source: AuditSource, type: string, id: string) {
  return source.kind === 'admin'
    ? qk.auditEntity(type, id)
    : qk.platformAuditEntity(slugOf(source), type, id);
}
function fetchEntity(source: AuditSource, type: string, id: string, cursor?: string) {
  const q = cursor ? { cursor } : {};
  return source.kind === 'admin'
    ? api.getAuditEntity(type, id, q)
    : api.platformGetAuditEntity(slugOf(source), type, id, q);
}
function entryKey(source: AuditSource, at: string, id: string) {
  return source.kind === 'admin'
    ? qk.auditEntry(at, id)
    : qk.platformAuditEntry(slugOf(source), at, id);
}
function fetchEntry(source: AuditSource, at: string, id: string): Promise<AuditEntryWithDetail> {
  if (source.kind === 'admin') return api.getAuditEntry(at, id);
  if (source.kind === 'tenant') return api.platformGetAuditEntry(source.slug, at, id);
  return api.platformGetPlatformAuditEntry(at, id);
}

/** Entries across pages, once each (a "started" headline is replaced under the same id). */
function flatten(pages: AuditPage[] | undefined): AuditEntry[] {
  const seen = new Set<string>();
  const out: AuditEntry[] = [];
  for (const p of pages ?? [])
    for (const e of p.items ?? []) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  return out;
}

function errorText(err: unknown, what: string): string {
  if (err instanceof ApiError && err.status === 403) return `You do not have access to ${what}.`;
  return `Could not load ${what}.`;
}

/* ─── Rows (shared by the Activity page and the History modal) ─── */

const muted: CSSProperties = { fontSize: 11.5, color: 'var(--muted)' };

function WhenCell({ at }: { at: string }) {
  const { relative, absolute } = auditWhen(at);
  return (
    <td data-label="When" style={{ whiteSpace: 'nowrap' }}>
      <time dateTime={at} title={absolute}>
        {relative}
      </time>
      <div style={muted}>{absolute}</div>
    </td>
  );
}

function WhoCell({ entry }: { entry: AuditEntry }) {
  const who = auditActorDisplay(entry.actor);
  return (
    <td data-label="Changed by" style={{ overflowWrap: 'anywhere' }}>
      <div style={{ fontWeight: 600 }}>{who.label}</div>
      {(who.operator || who.detail) && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 3 }}>
          {who.operator && <Pill tone="navy">Platform operator</Pill>}
          {who.detail && <span style={muted}>{who.detail}</span>}
        </div>
      )}
    </td>
  );
}

function WhatCell({ entry }: { entry: AuditEntry }) {
  const outcome = auditOutcomeLabel(entry);
  const counts = auditCountsText(entry.counts);
  return (
    <td data-label="What">
      <span>{auditActionSentence(entry)}</span>
      {outcome && (
        <>
          {' '}
          <Pill tone={auditInProgress(entry) ? 'gold' : 'coral'}>{outcome}</Pill>
        </>
      )}
      {entry.visibility === 'operator' && (
        <>
          {' '}
          <Pill tone="muted">Operators only</Pill>
        </>
      )}
      {counts && <div style={muted}>{counts}</div>}
    </td>
  );
}

function RecordCell({ entry, resolve }: { entry: AuditEntry; resolve?: AuditLabelResolver }) {
  const targets = entry.targets ?? [];
  const shown = targets.slice(0, 2);
  const more = targets.length - shown.length + (entry.truncated?.targets ?? 0);
  return (
    <td data-label="Record" style={{ overflowWrap: 'anywhere' }}>
      {shown.length === 0 && <span className="ump-none">—</span>}
      {shown.map((t, i) => (
        <div key={`${t.type}:${t.id}:${i}`}>
          <span style={muted}>{auditTypeLabel(t.type)}</span>{' '}
          <span style={{ fontWeight: 600 }}>{auditTargetLabel(t, resolve)}</span>
        </div>
      ))}
      {more > 0 && <div style={muted}>and {more} more</div>}
    </td>
  );
}

/** The expanded panel: field changes for each record, loaded when first opened. */
function EntryDetail({
  source,
  entry,
  resolve,
}: {
  source: AuditSource;
  entry: AuditEntry;
  resolve?: AuditLabelResolver;
}) {
  const q = useQuery({
    queryKey: entryKey(source, entry.at, entry.id),
    queryFn: () => fetchEntry(source, entry.at, entry.id),
    staleTime: 60_000,
  });
  if (q.isLoading) return <p style={muted}>Loading changes…</p>;
  if (q.isError)
    return (
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }} role="alert">
        <span style={muted}>{errorText(q.error, 'these changes')}</span>
        <Btn tone="ghost" size="sm" onClick={() => void q.refetch()}>
          Try again
        </Btn>
      </div>
    );
  const detail = q.data?.detail;
  const head = q.data?.entry ?? entry;
  const withChanges = (detail?.targets ?? []).filter((t) => t.changes.length > 0);
  const mentions = detail?.mentions ?? [];
  const truncated = head.truncated && Object.values(head.truncated).some((n) => !!n);
  const labelFor = (type: string, id: string) => {
    const t = head.targets.find((x) => x.type === type && x.id === id);
    return auditTargetLabel(t ?? { type, id }, resolve);
  };
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {withChanges.length === 0 && (
        <p style={{ ...muted, margin: 0 }}>
          No field details were recorded for this change, only who made it and when.
        </p>
      )}
      {withChanges.map((t, i) => (
        // An erasure blanks ids, so two targets of one type can share `type:id`.
        <div key={`${t.type}:${t.id}:${i}`}>
          {(withChanges.length > 1 || head.targets.length > 1) && (
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
              {auditTypeLabel(t.type)} · {labelFor(t.type, t.id)}
            </div>
          )}
          <table
            className="audit-changes"
            aria-label={`Changes to ${auditTypeLabel(t.type)} ${labelFor(t.type, t.id)}`}
            style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}
          >
            <thead>
              {/* Inside the feed's `.tbl`, which paints every thead row dark: undo it here. */}
              <tr style={{ background: 'transparent' }}>
                {['Field', 'Before', 'After'].map((h) => (
                  <th key={h} scope="col" style={changeTh}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.changes.map((c, i) => {
                const row = auditChangeRow(c);
                return (
                  <tr key={`${c.field}:${i}`} style={{ borderTop: '1px solid var(--line)' }}>
                    <td data-label="Field" style={{ ...changeTd, fontWeight: 600 }}>
                      {row.field}
                    </td>
                    {row.note ? (
                      <td data-label="Change" colSpan={2} style={{ ...changeTd, ...muted }}>
                        {row.note}
                      </td>
                    ) : (
                      <>
                        <td data-label="Before" style={{ ...changeTd, color: 'var(--muted)' }}>
                          {row.before}
                        </td>
                        <td data-label="After" style={changeTd}>
                          {row.after}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {mentions.length > 0 && (
        <p style={{ ...muted, margin: 0 }}>
          Also involved:{' '}
          {mentions
            .map((m) => `${auditTypeLabel(m.type)} · ${auditTargetLabel(m, resolve)}`)
            .join('; ')}
        </p>
      )}
      {head.outcome !== 'ok' && (
        <p style={{ ...muted, margin: 0 }}>
          {head.outcome === 'started'
            ? auditInProgress(head)
              ? 'This change is still running. Reopen it in a minute to see how it ended.'
              : 'This change was started but did not finish, so no result was recorded.'
            : `This change did not complete${head.status ? ` (error ${head.status})` : ''}.`}
        </p>
      )}
      {truncated && (
        <p style={{ ...muted, margin: 0 }}>
          Some details were left out because the change was large.
        </p>
      )}
    </div>
  );
}

const changeTh: CSSProperties = {
  textAlign: 'left',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
  padding: '4px 8px 4px 0',
};
const changeTd: CSSProperties = {
  padding: '6px 8px 6px 0',
  verticalAlign: 'top',
  overflowWrap: 'anywhere',
};

/** The table body for a list of entries; each row expands to its changes. */
function EntryRows({
  entries,
  source,
  showRecord,
  resolve,
}: {
  entries: AuditEntry[];
  source: AuditSource;
  showRecord: boolean;
  resolve?: AuditLabelResolver;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const baseId = useId();
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const cols = showRecord ? 5 : 4;
  return (
    <tbody>
      {entries.map((e) => {
        const isOpen = open.has(e.id);
        const panelId = `${baseId}-${e.id}`;
        return (
          <Fragment key={e.id}>
            <tr className="clickable" data-testid="audit-row" onClick={() => toggle(e.id)}>
              <WhenCell at={e.at} />
              <WhoCell entry={e} />
              <WhatCell entry={e} />
              {showRecord && <RecordCell entry={e} resolve={resolve} />}
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <Btn
                  tone="ghost"
                  size="sm"
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? panelId : undefined}
                  aria-label={`${isOpen ? 'Hide' : 'Show'} changes: ${auditActionSentence(e)}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    toggle(e.id);
                  }}
                >
                  {isOpen ? 'Hide' : 'Details'}
                </Btn>
              </td>
            </tr>
            {isOpen && (
              <tr id={panelId} style={{ background: 'var(--paper)' }}>
                <td colSpan={cols} style={{ padding: '12px 16px' }}>
                  <EntryDetail source={source} entry={e} resolve={resolve} />
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </tbody>
  );
}

function EntryTable({
  label,
  entries,
  source,
  showRecord,
  resolve,
}: {
  label: string;
  entries: AuditEntry[];
  source: AuditSource;
  showRecord: boolean;
  resolve?: AuditLabelResolver;
}) {
  return (
    <div className="tbl-w">
      <table className="tbl upl-tbl" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Changed by</th>
            <th scope="col">What</th>
            {showRecord && <th scope="col">Record</th>}
            <th scope="col">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <EntryRows entries={entries} source={source} showRecord={showRecord} resolve={resolve} />
      </table>
    </div>
  );
}

function LoadMore({
  hasMore,
  loading,
  onMore,
  hint,
}: {
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
  hint?: ReactNode;
}) {
  if (!hasMore) return null;
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}
    >
      <Btn tone="outline" size="sm" disabled={loading} onClick={onMore}>
        {loading ? 'Loading…' : 'Load more'}
      </Btn>
      {hint && <span style={muted}>{hint}</span>}
    </div>
  );
}

/* ─── Activity page ─── */

const fieldStyle: CSSProperties = {
  height: 34,
  border: '1px solid var(--line)',
  borderRadius: 7,
  background: 'var(--white)',
  padding: '0 10px',
  fontSize: 13,
  color: 'var(--ink)',
  minWidth: 0,
};
const filterLabel: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
};

export interface AuditActivityViewProps {
  /** Default: the signed-in union's own feed. */
  source?: AuditSource;
  /** The union's team, for the person filter and to name team members by email. */
  users?: TenantUser[];
  /** Club names, for records that carry only an id. */
  clubs?: Array<{ id: string; name?: string }>;
  /** Page heading and breadcrumb; defaults suit the admin console. */
  title?: ReactNode;
  crumb?: ReactNode;
  description?: ReactNode;
  /** Shown in the page head (the operator portal's "Back"). */
  actions?: ReactNode;
}

/** Builds the label resolver from the lists the caller already has. */
function useResolver(users?: TenantUser[], clubs?: Array<{ id: string; name?: string }>) {
  return useMemo<AuditLabelResolver>(() => {
    const byUser = new Map((users ?? []).map((u) => [u.sub, u.email]));
    const byClub = new Map((clubs ?? []).map((c) => [c.id, c.name]));
    return (type, id) =>
      type === 'user' ? byUser.get(id) : type === 'club' ? byClub.get(id) || undefined : undefined;
  }, [users, clubs]);
}

export function AuditActivityView({
  source = ADMIN,
  users,
  clubs,
  title,
  crumb,
  description,
  actions,
}: AuditActivityViewProps) {
  const [personText, setPersonText] = useState('');
  // The person text last applied: re-applying it (Enter, then blur) must not swap a typed
  // email for the key the results have since taught `people`, which would reload the feed.
  const [appliedPerson, setAppliedPerson] = useState('');
  const [filters, setFilters] = useState<Filters>({});
  const listId = useId();
  const resolve = useResolver(users, clubs);

  const q = useInfiniteQuery({
    queryKey: feedKey(source, filters),
    queryFn: ({ pageParam }) =>
      fetchFeed(source, { ...feedQuery(filters), ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AuditPage) => last.cursor || undefined,
    staleTime: 0,
  });
  const entries = useMemo(() => flatten(q.data?.pages), [q.data]);

  // People to pick from: the union's team, plus any signed-in person with an email seen in
  // the feed (a removed team member). Actor key → email: link actors and people with no email
  // stay out (their labels are not unique, so a label could not name one of them). Seen
  // actors are remembered across filter changes: a filtered page that is still loading must
  // not drop the person just picked from the list.
  const [seen, setSeen] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    const fresh = entries.filter(
      (e) => e.actor?.kind === 'user' && !!e.actor.email?.trim() && !seen.has(e.actor.key),
    );
    if (!fresh.length) return;
    setSeen((prev) => {
      const next = new Map(prev);
      for (const e of fresh) next.set(e.actor.key, e.actor.email!.trim());
      return next;
    });
  }, [entries, seen]);
  const people = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users ?? []) if (u.email) m.set(u.sub, u.email);
    for (const [key, email] of seen) if (!m.has(key)) m.set(key, email);
    return m;
  }, [users, seen]);
  const labels = useMemo(() => [...new Set(people.values())].sort(), [people]);

  // An email from the list naming ONE account filters by that actor key; anything else is
  // sent as typed: the API takes an actor key or an email (a removed team member, or an email
  // behind two accounts, is found by the email recorded on the entries).
  const applyPerson = (text: string) => {
    const t = text.trim();
    if (t === appliedPerson) return;
    setAppliedPerson(t);
    const keys = [...people]
      .filter(([, email]) => email.toLowerCase() === t.toLowerCase())
      .map(([key]) => key);
    const actor = !t ? undefined : keys.length === 1 ? keys[0] : t;
    setFilters((f) => (f.actor === actor ? f : { ...f, actor }));
  };
  const set = (patch: Filters) => setFilters((f) => ({ ...f, ...patch }));

  // Dates apply when the input is left, on Enter, or after a pause — not on every keystroke.
  const [dates, setDates] = useState<Pick<Filters, 'from' | 'to'>>({});
  const applyDates = () => setFilters((f) => withDates(f, dates));
  useEffect(() => {
    if (dates.from === filters.from && dates.to === filters.to) return;
    const timer = setTimeout(() => setFilters((f) => withDates(f, dates)), DATE_APPLY_MS);
    return () => clearTimeout(timer);
  }, [dates, filters.from, filters.to]);

  const filtered = !!(filters.actor || filters.type || filters.from || filters.to);
  const clear = () => {
    setPersonText('');
    setAppliedPerson('');
    setDates({});
    setFilters({});
  };

  const defaultDescription =
    source.kind === 'platform'
      ? 'Changes made in the operator portal that belong to no single client.'
      : 'Who changed what, and when. Open a row to see each value before and after.';

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">{crumb ?? 'Admin Console / Activity'}</div>
          <h1 className="ph-title">{title ?? <em>Activity</em>}</h1>
          <p className="ph-desc">{description ?? defaultDescription}</p>
        </div>
        {actions && <div className="ph-actions">{actions}</div>}
      </div>

      <div
        className="filter-row"
        style={{ alignItems: 'flex-end' }}
        role="group"
        aria-label="Filters"
      >
        <label style={{ ...filterLabel, flex: '1 1 220px', maxWidth: 300 }}>
          Changed by
          <input
            style={{ ...fieldStyle, width: '100%' }}
            list={listId}
            placeholder="Anyone"
            value={personText}
            onChange={(e) => {
              setPersonText(e.target.value);
              // Picking from the list (or clearing) applies at once; typing applies on Enter.
              const t = e.target.value.trim();
              if (!t || labels.includes(t)) applyPerson(t);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyPerson(personText);
            }}
            onBlur={() => applyPerson(personText)}
          />
          <datalist id={listId}>
            {labels.map((label) => (
              <option key={label} value={label} />
            ))}
          </datalist>
        </label>
        <label style={{ ...filterLabel, flex: '0 1 200px' }}>
          Record
          <select
            style={fieldStyle}
            value={filters.type ?? ''}
            onChange={(e) => set({ type: e.target.value || undefined })}
          >
            <option value="">All records</option>
            {AUDIT_FILTER_TYPES.map((t) => (
              <option key={t} value={t}>
                {auditTypeLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <label style={{ ...filterLabel, flex: '0 1 150px' }}>
          From
          <input
            type="date"
            style={fieldStyle}
            value={dates.from ?? ''}
            max={dates.to}
            onChange={(e) => setDates((d) => ({ ...d, from: e.target.value || undefined }))}
            onBlur={() => applyDates()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyDates();
            }}
          />
        </label>
        <label style={{ ...filterLabel, flex: '0 1 150px' }}>
          To
          <input
            type="date"
            style={fieldStyle}
            value={dates.to ?? ''}
            min={dates.from}
            onChange={(e) => setDates((d) => ({ ...d, to: e.target.value || undefined }))}
            onBlur={() => applyDates()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyDates();
            }}
          />
        </label>
        {filtered && (
          <Btn tone="ghost" size="sm" onClick={clear}>
            Clear filters
          </Btn>
        )}
      </div>

      {q.isLoading ? (
        <p style={{ ...muted, fontSize: 13 }}>Loading activity…</p>
      ) : q.isError && entries.length === 0 ? (
        <EmptyState
          icon={Icon.Alert}
          title={errorText(q.error, 'activity')}
          sub={
            q.error instanceof ApiError && q.error.status === 400
              ? 'Check the dates, then try again.'
              : 'Check your connection, then try again.'
          }
          action={
            <Btn tone="outline" size="sm" onClick={() => void q.refetch()}>
              Try again
            </Btn>
          }
        />
      ) : entries.length === 0 && !q.hasNextPage ? (
        <EmptyState
          icon={Icon.Clock}
          title={filtered ? 'Nothing matches these filters' : 'No activity yet'}
          sub={
            filtered
              ? 'Try a wider date range, or another person or record.'
              : 'Changes appear here as people make them.'
          }
          action={
            filtered ? (
              <Btn tone="outline" size="sm" onClick={clear}>
                Clear filters
              </Btn>
            ) : undefined
          }
        />
      ) : (
        <>
          {entries.length > 0 ? (
            <EntryTable
              label="Activity"
              entries={entries}
              source={source}
              showRecord
              resolve={resolve}
            />
          ) : (
            <p style={{ ...muted, fontSize: 13 }}>Nothing matches in the most recent changes.</p>
          )}
          {q.isFetchNextPageError && (
            <p role="alert" style={{ ...muted, marginTop: 10 }}>
              {errorText(q.error, 'more activity')}
            </p>
          )}
          <LoadMore
            hasMore={!!q.hasNextPage}
            loading={q.isFetchingNextPage}
            onMore={() => void q.fetchNextPage()}
            hint={entries.length === 0 ? 'Look further back.' : undefined}
          />
        </>
      )}

      <p className="ump-footnote">
        Shows changes people make in the console, the club portal and through links. Automated jobs,
        the Match Centre sync and scripts are not shown. History starts on the day this feature went
        live.
      </p>
    </div>
  );
}

/* ─── Per-record history ─── */

export interface HistoryTarget {
  /** Record type, as the API names it (`umpire`, `club`, `tenant-config`, …). */
  type: string;
  id: string;
  /** The record's name, for the modal title. */
  title: string;
  source?: AuditSource;
}

export function HistoryModal({
  type,
  id,
  title,
  source = ADMIN,
  onClose,
}: HistoryTarget & { onClose: () => void }) {
  // Closes only this dialog when it sits over another one (a player's details).
  useNestedEscapeClose(onClose);
  const q = useInfiniteQuery({
    queryKey: entityKey(source, type, id),
    queryFn: ({ pageParam }) => fetchEntity(source, type, id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AuditPage) => last.cursor || undefined,
    staleTime: 0,
  });
  const entries = useMemo(() => flatten(q.data?.pages), [q.data]);
  return (
    <Modal
      eyebrow={`History · ${auditTypeLabel(type)}`}
      title={title}
      onClose={onClose}
      maxWidth={820}
    >
      {q.isLoading ? (
        <p style={muted}>Loading history…</p>
      ) : q.isError && entries.length === 0 ? (
        <div role="alert" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={muted}>{errorText(q.error, 'the history')}</span>
          <Btn tone="ghost" size="sm" onClick={() => void q.refetch()}>
            Try again
          </Btn>
        </div>
      ) : entries.length === 0 && !q.hasNextPage ? (
        <p style={{ ...muted, fontSize: 13 }}>No changes recorded for this record yet.</p>
      ) : (
        <>
          {entries.length > 0 && (
            <EntryTable
              label={`History of ${title}`}
              entries={entries}
              source={source}
              showRecord={false}
            />
          )}
          <LoadMore
            hasMore={!!q.hasNextPage}
            loading={q.isFetchingNextPage}
            onMore={() => void q.fetchNextPage()}
          />
        </>
      )}
      <p className="ump-footnote">
        Changes from before this feature went live, and changes made by automated jobs, are not
        shown.
      </p>
    </Modal>
  );
}

/** A low-emphasis "History" button that opens the record's history. */
export function HistoryButton({
  type,
  id,
  title,
  source,
  tone = 'ghost',
}: HistoryTarget & { tone?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Btn
        tone={tone}
        size="sm"
        icon={Icon.Clock}
        aria-label={`History: ${title}`}
        title="Who changed this, and when"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        History
      </Btn>
      {open && (
        // React events bubble out of a portal to its React parent: keep clicks inside the
        // dialog from reaching a clickable row the button sits in.
        <span onClick={(e) => e.stopPropagation()}>
          <HistoryModal
            type={type}
            id={id}
            title={title}
            source={source}
            onClose={() => setOpen(false)}
          />
        </span>
      )}
    </>
  );
}

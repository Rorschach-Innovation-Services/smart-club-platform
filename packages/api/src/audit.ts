/**
 * Platform audit trail — capture side (pure: no Hono, no DynamoDB). One entry per request.
 *
 * The request middleware opens a scope with {@link runAudited}; anything in the call stack can
 * then enrich it with {@link auditSet} / {@link auditTarget} (both no-ops outside a scope, so
 * shared seams need no extra parameters and CLIs / crons stay unattributed). After the handler,
 * {@link buildEntry} turns the scope into the rows `repo.putAuditEntry` writes in ONE
 * transaction: headline (`A#`), detail (`D#`, only when there are values), and the `E#` / `C#` /
 * `U#` pointers. Invariant: every value that names a record (a target label, a change naming a
 * person, a mention) is stored together with that record's `E#` pointer, so an erasure can find
 * it — when the row budget runs out the VALUE is dropped, never the pointer.
 *
 * Caps: 25 targets, 40 changes per target, 40 mentions per entry, 200 characters per value,
 * 20 items per array, detail row ≤ 100 KB, ≤ 100 rows per entry (the TransactWriteItems limit).
 * Everything dropped is counted in `truncated`.
 *
 * Masked fields (ID number, address, date of birth, emergency contact, document keys, free
 * text) are recorded as changed with no value.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  auditActorPointerKey,
  auditClubPointerKey,
  auditDetailKey,
  auditEntityPointerKey,
  auditHeadlineKey,
} from './keys.js';
import {
  PLATFORM_TENANT,
  type AuditActor,
  type AuditChange,
  type AuditDetail,
  type AuditEntry,
  type AuditMention,
  type AuditOutcome,
  type AuditRef,
  type AuditTargetHead,
  type AuditTruncation,
  type AuditValue,
  type AuditVisibility,
} from './types.js';

/** First month with audit rows: tenant erasure and history reads never look earlier. */
export const AUDIT_LAUNCH_MONTH = '2026-11';
export const AUDIT_RETENTION_DAYS = 730;

export const AUDIT_CAPS = {
  targets: 25,
  changesPerTarget: 40,
  mentions: 40,
  valueChars: 200,
  arrayItems: 20,
  detailBytes: 100 * 1024,
  rows: 100,
} as const;

/**
 * Record types whose audit entries `clearCohort` removes (assumption 6): the records the cohort
 * clear itself deletes. Config, user, link, umpire, scorer and venue entries stay.
 */
export const AUDIT_COHORT_TYPES: ReadonlySet<string> = new Set([
  'club',
  'player',
  'clearance',
  'registration-review',
  'club-invite',
  'veterans-affiliation',
  'veterans-request',
  'postponement',
  'series',
  'fixture',
  'season-run',
  'fixture-result',
  'scorecard',
  'fixture-officials',
  'captains-report',
  'squad-request',
  'doc-request',
]);

// ── Request scope ──

export interface AuditScopeTarget {
  type: string;
  id: string;
  label?: string;
  op: string;
  clubId?: string;
  changes: AuditChange[];
  /** Set by {@link redactScopeFor}: an erasing request's own target of the erased type. */
  scrubbed?: true;
}

/** Mutable per-request state. The middleware creates it; the helpers enrich it. */
export interface AuditScope {
  id: string;
  /** Request start (ISO): fixes the entry's sort key, so a "started" headline is overwritten. */
  at: string;
  tenant?: string;
  actor?: AuditActor;
  action?: string;
  visibility: AuditVisibility;
  counts?: Record<string, number>;
  targets: AuditScopeTarget[];
  mentions: AuditMention[];
  truncated: AuditTruncation;
  /** True once a handler recorded something (an action, counts, a target or a mention). */
  recorded: boolean;
  /**
   * Set once a "started" headline was written: its rows sit in the partition and under the
   * actor pointer of the tenant and actor of that moment, so later auditSet calls cannot move
   * the final entry elsewhere (that would orphan the started rows).
   */
  pinned?: boolean;
}

export function newAuditScope(
  init: Partial<Pick<AuditScope, 'id' | 'at' | 'tenant' | 'actor' | 'action' | 'visibility'>> = {},
): AuditScope {
  return {
    id: init.id ?? randomUUID(),
    at: init.at ?? new Date().toISOString(),
    ...(init.tenant ? { tenant: init.tenant } : {}),
    ...(init.actor ? { actor: init.actor } : {}),
    ...(init.action ? { action: init.action } : {}),
    visibility: init.visibility ?? 'tenant',
    targets: [],
    mentions: [],
    truncated: {},
    recorded: false,
  };
}

export const auditScope = new AsyncLocalStorage<AuditScope>();

/** Run `fn` with `scope` as the current audit scope. */
export function runAudited<T>(scope: AuditScope, fn: () => T): T {
  return auditScope.run(scope, fn);
}

/** The current request's scope, or undefined outside one. */
export const currentAuditScope = (): AuditScope | undefined => auditScope.getStore();

const bump = (t: AuditTruncation, k: keyof AuditTruncation, n = 1) => {
  t[k] = (t[k] ?? 0) + n;
};

/**
 * Set entry-level facts. `action` and `counts` mark the request as having recorded something
 * (it will be flushed whatever the method/status); `tenant`, `actor` and `visibility` do not —
 * a public resolver can name the tenant and actor without turning a GET into an entry.
 * Counts merge by key (last write wins). `tenant` and `actor` are ignored once a "started"
 * headline was written (`pinned`). No-op outside a scope.
 */
export function auditSet(patch: {
  action?: string;
  tenant?: string;
  actor?: AuditActor;
  visibility?: AuditVisibility;
  counts?: Record<string, number>;
}): void {
  const s = auditScope.getStore();
  if (!s) return;
  if (patch.tenant && !s.pinned) s.tenant = patch.tenant;
  if (patch.actor && !s.pinned) s.actor = patch.actor;
  if (patch.visibility) s.visibility = patch.visibility;
  if (patch.action) {
    s.action = patch.action;
    s.recorded = true;
  }
  if (patch.counts) {
    s.counts = { ...(s.counts ?? {}), ...patch.counts };
    s.recorded = true;
  }
}

/**
 * Record one affected record. A repeat (same type + id) merges: label/op/clubId update, changes
 * append. Beyond 25 targets, 40 changes per target or 40 mentions the overflow is counted in
 * `truncated`. Values are capped here. No-op outside a scope.
 */
export function auditTarget(t: {
  type: string;
  id: string;
  label?: string;
  op: string;
  clubId?: string;
  changes?: AuditChange[];
  mentions?: AuditMention[];
}): void {
  const s = auditScope.getStore();
  if (!s) return;
  s.recorded = true;
  let target = s.targets.find((x) => x.type === t.type && x.id === t.id);
  if (!target) {
    if (s.targets.length >= AUDIT_CAPS.targets) {
      bump(s.truncated, 'targets');
    } else {
      target = { type: t.type, id: t.id, op: t.op, changes: [] };
      s.targets.push(target);
    }
  }
  if (target) {
    target.op = t.op;
    if (t.label !== undefined) target.label = capString(t.label, s.truncated);
    if (t.clubId) target.clubId = t.clubId;
    for (const c of t.changes ?? []) {
      if (target.changes.length >= AUDIT_CAPS.changesPerTarget) {
        bump(s.truncated, 'changes');
        continue;
      }
      target.changes.push(capChange(c, s.truncated));
    }
  }
  for (const m of t.mentions ?? []) addMention(s, m);
}

/**
 * Name a record the request already targets (e.g. the route's default target) without changing
 * its op or marking the request as recorded. No-op outside a scope, when the record is not a
 * target, or for an empty label.
 */
export function auditLabel(type: string, id: string, label: string | undefined): void {
  const s = auditScope.getStore();
  const target = s?.targets.find((x) => x.type === type && x.id === id);
  if (s && target && label?.trim()) target.label = capString(label.trim(), s.truncated);
}

/** Record a mention without a target (e.g. the other side of a merge). No-op outside a scope. */
export function auditMention(m: AuditMention): void {
  const s = auditScope.getStore();
  if (!s) return;
  s.recorded = true;
  addMention(s, m);
}

function addMention(s: AuditScope, m: AuditMention): void {
  const existing = s.mentions.find((x) => x.type === m.type && x.id === m.id);
  if (existing) {
    if (m.label !== undefined) existing.label = capString(m.label, s.truncated);
    return;
  }
  if (s.mentions.length >= AUDIT_CAPS.mentions) {
    bump(s.truncated, 'mentions');
    return;
  }
  s.mentions.push({
    type: m.type,
    id: m.id,
    ...(m.label !== undefined ? { label: capString(m.label, s.truncated) } : {}),
  });
}

// ── Values, masking, diffs ──

function capString(v: string, t: AuditTruncation): string {
  if (v.length <= AUDIT_CAPS.valueChars) return v;
  bump(t, 'values');
  return `${v.slice(0, AUDIT_CAPS.valueChars - 1)}…`;
}

const safeJson = (v: unknown): string => {
  try {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)) ?? '';
  } catch {
    return String(v);
  }
};

/**
 * A JSON-safe, capped copy of `v`: strings ≤ 200 chars, top-level arrays ≤ 20 items (nested
 * arrays and objects become JSON text, itself capped). undefined stays undefined.
 */
export function capValue(
  v: unknown,
  t: AuditTruncation = {},
  nested = false,
): AuditValue | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'string') return capString(v, t);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v) && !nested) {
    if (v.length > AUDIT_CAPS.arrayItems) bump(t, 'values');
    return v.slice(0, AUDIT_CAPS.arrayItems).map((x) => capValue(x, t, true) ?? null);
  }
  return capString(safeJson(v), t);
}

function capChange(c: AuditChange, t: AuditTruncation): AuditChange {
  const out: AuditChange = { field: capString(c.field, t) };
  if (c.masked) out.masked = true;
  else {
    const from = capValue(c.from, t);
    const to = capValue(c.to, t);
    if (from !== undefined) out.from = from;
    if (to !== undefined) out.to = to;
  }
  if (c.ref) out.ref = { type: c.ref.type, id: c.ref.id };
  if (c.fromRef) out.fromRef = { type: c.fromRef.type, id: c.fromRef.id };
  if (c.scrubbed) out.scrubbed = true;
  return out;
}

const MASKED_FIELDS: ReadonlySet<string> = new Set([
  'idNumber',
  'passportNumber',
  'address',
  'physicalAddress',
  'postalAddress',
  'homeAddress',
  'streetAddress',
  'dob',
  'dateOfBirth',
  'objectKey',
  'docMeta',
  'files',
  'note',
  'notes',
  'comment',
  'comments',
  'general',
  'feedback',
  'otherConcern',
  'freeText',
  'message',
  'reason',
]);

/**
 * Fields recorded as "changed" without a value: ID numbers, addresses, date of birth, emergency
 * contact, document keys/metadata, and free text (a name typed into a note can't be found for
 * scrubbing — assumption 1).
 */
export function isMaskedField(field: string): boolean {
  return (
    MASKED_FIELDS.has(field) ||
    /^emergency/i.test(field) ||
    /(ObjectKey|DocMeta|Notes?|Comments?)$/.test(field)
  );
}

/** Bookkeeping fields no diff reports by default. */
const DEFAULT_IGNORE: ReadonlySet<string> = new Set([
  'pk',
  'sk',
  'gsi1pk',
  'gsi1sk',
  'version',
  'updatedAt',
]);

/** JSON with sorted object keys, so key order never reads as a change. */
function stable(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return safeJson(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`;
}

export interface DiffOptions {
  /** Compare only these fields (default: every key of either side). */
  fields?: readonly string[];
  /** Extra fields to record without values (on top of {@link isMaskedField}). */
  mask?: readonly string[];
  /** Extra fields to skip (on top of version / updatedAt / key attributes). */
  ignore?: readonly string[];
  /**
   * Fields whose value names another record: a type name (the value IS that record's id) or a
   * resolver. The change carries `ref` / `fromRef` so the value gets its own pointer.
   */
  refs?: Record<string, string | ((v: unknown) => AuditRef | undefined)>;
}

/**
 * Field-level changes between two versions of a record (`before` null ⇒ create, `after` null ⇒
 * delete). Values are capped; masked fields carry `masked: true` and no value. Fields are
 * compared top-level with key-order-insensitive equality.
 */
export function diffFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  opts: DiffOptions = {},
): AuditChange[] {
  const b = before ?? {};
  const a = after ?? {};
  const mask = new Set(opts.mask ?? []);
  const ignore = new Set(opts.ignore ?? []);
  const fields = opts.fields ?? [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  // Inside a request, shortened values count toward the entry's `truncated` (re-capping the
  // same value in auditTarget is a no-op, so nothing is counted twice).
  const t: AuditTruncation = auditScope.getStore()?.truncated ?? {};
  const changes: AuditChange[] = [];
  for (const field of fields) {
    if (DEFAULT_IGNORE.has(field) || ignore.has(field)) continue;
    const from = b[field];
    const to = a[field];
    if (stable(from) === stable(to)) continue;
    if (mask.has(field) || isMaskedField(field)) {
      changes.push({ field, masked: true });
      continue;
    }
    const change: AuditChange = { field };
    const f = capValue(from, t);
    const tv = capValue(to, t);
    if (f !== undefined) change.from = f;
    if (tv !== undefined) change.to = tv;
    const spec = opts.refs?.[field];
    if (spec) {
      const resolve =
        typeof spec === 'string'
          ? (v: unknown) =>
              typeof v === 'string' && v
                ? { type: spec, id: v }
                : (undefined as AuditRef | undefined)
          : spec;
      const fromRef = from === undefined ? undefined : resolve(from);
      const toRef = to === undefined ? undefined : resolve(to);
      const ref = toRef ?? fromRef;
      if (ref) change.ref = ref;
      if (toRef && fromRef && (toRef.type !== fromRef.type || toRef.id !== fromRef.id))
        change.fromRef = fromRef;
    }
    changes.push(change);
  }
  return changes;
}

// ── Entry building ──

export interface AuditRequestInfo {
  status: number;
  /** Default: 'ok' below 400, else 'failed'. Pass 'started' for the pre-handler headline. */
  outcome?: AuditOutcome;
  requestId?: string;
  route?: { method: string; pattern: string };
  /** Used when the handler did not set an action (the registry's action). */
  action?: string;
}

export type AuditRow = { pk: string; sk: string } & Record<string, unknown>;

export interface AuditRowSet {
  entry: AuditEntry;
  detail: AuditDetail | null;
  /** Pointers first, then detail, then headline — the safe order for a non-atomic fallback. */
  rows: AuditRow[];
}

const refKey = (type: string, id: string) => `${type}\u0000${id}`;
const byteLength = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** TTL for an entry recorded at `at` (epoch seconds). */
export const auditExpiresAt = (at: string) =>
  Math.floor(Date.parse(at) / 1000) + AUDIT_RETENTION_DAYS * 86_400;

/**
 * Turn a scope into the rows of ONE entry. Pure (no I/O). Enforces every cap, including the
 * 100-row budget: targets (and their clubs) always fit (≤ 25 + 25); mentions, then change refs,
 * take what is left, and an item whose pointer does not fit is dropped (a mention) or loses its
 * values (a change) — never stored without its pointer.
 */
export function buildEntry(scope: AuditScope, req: AuditRequestInfo): AuditRowSet {
  const truncated: AuditTruncation = { ...scope.truncated };
  const tenant = scope.tenant || PLATFORM_TENANT;
  const at = scope.at;
  const id = scope.id;
  const expiresAt = auditExpiresAt(at);

  const actor: AuditActor = scope.actor
    ? sanitiseActor(scope.actor)
    : { kind: 'system', key: 'unattributed', via: 'unknown' };

  // Pointer budget: headline + detail (reserved) + actor pointer.
  let budget = AUDIT_CAPS.rows - 2 - (scope.actor ? 1 : 0);
  const entities = new Map<string, AuditRef>();
  const clubs = new Set<string>();
  const cost = (refs: AuditRef[], clubIds: string[]) => {
    let n = 0;
    const seenE = new Set<string>();
    const seenC = new Set<string>();
    for (const r of refs) {
      if (!r.id) continue; // a blanked id (erasure) gets no pointer
      const k = refKey(r.type, r.id);
      if (!entities.has(k) && !seenE.has(k)) {
        seenE.add(k);
        n++;
      }
    }
    for (const c of clubIds) {
      if (!clubs.has(c) && !seenC.has(c)) {
        seenC.add(c);
        n++;
      }
    }
    return n;
  };
  const take = (refs: AuditRef[], clubIds: string[]): boolean => {
    const n = cost(refs, clubIds);
    if (n > budget) return false;
    budget -= n;
    for (const r of refs) if (r.id) entities.set(refKey(r.type, r.id), { type: r.type, id: r.id });
    for (const c of clubIds) clubs.add(c);
    return true;
  };
  const clubsOf = (r: AuditRef & { clubId?: string }) => [
    ...(r.clubId ? [r.clubId] : []),
    ...(r.type === 'club' ? [r.id] : []),
  ];

  // 1. Targets (≤ 25 by construction; their pointers always fit).
  const targets = scope.targets.slice(0, AUDIT_CAPS.targets).map((t) => ({
    ...t,
    changes: t.changes.slice(0, AUDIT_CAPS.changesPerTarget).map((c) => ({ ...c })),
  }));
  for (const t of targets) take([t], clubsOf(t));

  // 2. Mentions.
  const mentions: AuditMention[] = [];
  for (const m of scope.mentions.slice(0, AUDIT_CAPS.mentions)) {
    if (take([m], clubsOf(m))) mentions.push({ ...m });
    else bump(truncated, 'rows');
  }

  // 3. Change refs.
  for (const t of targets) {
    for (const c of t.changes) {
      const refs = [c.ref, c.fromRef].filter((r): r is AuditRef => !!r);
      if (!refs.length) continue;
      if (take(refs, refs.flatMap(clubsOf))) continue;
      delete c.from;
      delete c.to;
      delete c.ref;
      delete c.fromRef;
      bump(truncated, 'rows');
    }
  }

  // 4. Detail, within its byte budget (drop trailing changes until it fits).
  let detail: AuditDetail | null = null;
  const withChanges = targets.filter((t) => t.changes.length > 0);
  if (withChanges.length || mentions.length) {
    detail = {
      targets: withChanges.map((t) => ({ type: t.type, id: t.id, changes: t.changes })),
      mentions,
    };
    while (byteLength(detail) > AUDIT_CAPS.detailBytes) {
      const last = [...detail.targets].reverse().find((t) => t.changes.length > 0);
      if (last) {
        last.changes.pop();
        bump(truncated, 'detail');
      } else if (detail.mentions.length) {
        detail.mentions.pop();
        bump(truncated, 'detail');
      } else break;
    }
    detail.targets = detail.targets.filter((t) => t.changes.length > 0);
    if (!detail.targets.length && !detail.mentions.length) detail = null;
  }
  const changeCountOf = (t: { type: string; id: string }) =>
    detail?.targets.find((d) => d.type === t.type && d.id === t.id)?.changes.length ?? 0;

  const heads: AuditTargetHead[] = targets.map((t) => ({
    type: t.type,
    id: t.id,
    ...(t.label !== undefined ? { label: t.label } : {}),
    op: t.op,
    ...(t.clubId ? { clubId: t.clubId } : {}),
    changeCount: changeCountOf(t),
    ...(t.scrubbed ? { scrubbed: true as const } : {}),
  }));

  const outcome: AuditOutcome = req.outcome ?? (req.status < 400 ? 'ok' : 'failed');
  const hasTruncation = Object.values(truncated).some((n) => (n ?? 0) > 0);
  const entry: AuditEntry = {
    id,
    at,
    tenant,
    ...(req.requestId ? { requestId: req.requestId } : {}),
    actor,
    action: scope.action ?? req.action ?? 'unknown',
    ...(req.route ? { route: { method: req.route.method, pattern: req.route.pattern } } : {}),
    status: req.status,
    outcome,
    visibility: scope.visibility,
    targets: heads,
    ...(scope.counts && Object.keys(scope.counts).length ? { counts: { ...scope.counts } } : {}),
    ...(hasTruncation ? { truncated } : {}),
    expiresAt,
  };

  const common = { entryId: id, at, expiresAt };
  const rows: AuditRow[] = [];
  for (const r of entities.values())
    rows.push({
      ...auditEntityPointerKey(tenant, r.type, r.id, at, id),
      rowType: 'audit-pointer',
      ...common,
    });
  for (const c of clubs)
    rows.push({ ...auditClubPointerKey(tenant, c, at, id), rowType: 'audit-pointer', ...common });
  if (scope.actor)
    rows.push({
      ...auditActorPointerKey(tenant, actor.key, at, id),
      rowType: 'audit-pointer',
      ...common,
    });
  if (detail)
    rows.push({ ...auditDetailKey(tenant, at, id), rowType: 'audit-detail', ...common, ...detail });
  rows.push({ ...auditHeadlineKey(tenant, at, id), rowType: 'audit', entryId: id, ...entry });
  return { entry, detail, rows };
}

/**
 * The fallback when an entry's rows could not be written (e.g. an id the key schema rejects):
 * the headline alone, without targets, mentions or detail — so nothing naming a record is
 * stored without its pointer. What was dropped is counted in `truncated`.
 */
export function headlineOnly(set: AuditRowSet): AuditRowSet {
  const head = set.rows[set.rows.length - 1];
  const { entry } = set;
  const dropped = entry.targets.length + (set.detail?.mentions.length ?? 0);
  const truncated: AuditTruncation = { ...(entry.truncated ?? {}) };
  if (dropped) bump(truncated, 'rows', dropped);
  const { truncated: _t, ...rest } = entry;
  const next: AuditEntry = {
    ...rest,
    targets: [],
    ...(Object.keys(truncated).length ? { truncated } : {}),
  };
  return {
    entry: next,
    detail: null,
    rows: [{ pk: head.pk, sk: head.sk, rowType: 'audit', entryId: entry.id, ...next }],
  };
}

/**
 * The erasing route's own entry is flushed after its scrub, so whatever it recorded about the
 * erased record type must not write a name back: targets of `type` lose label and change
 * values and are marked `scrubbed` (the console reads "Removed", as for any scrubbed target),
 * changes naming a `type` record lose values, `type` mentions lose their label. With `blankIds`
 * (a player's natural key) those ids are blanked too, and get no pointer.
 */
export function redactScopeFor(scope: AuditScope, type: string, opts: { blankIds?: boolean } = {}) {
  const names = (r: AuditRef | undefined) => !!r && r.type === type;
  const strip = (c: AuditChange): AuditChange => {
    const out: AuditChange = c.masked ? { ...c, scrubbed: true } : stripValues(c);
    if (opts.blankIds && names(out.ref)) out.ref = { ...out.ref!, id: '' };
    if (opts.blankIds && names(out.fromRef)) out.fromRef = { ...out.fromRef!, id: '' };
    return out;
  };
  for (const t of scope.targets) {
    const hit = t.type === type;
    if (hit) {
      delete t.label;
      t.scrubbed = true;
      if (opts.blankIds) t.id = '';
    }
    t.changes = t.changes.map((c) => (hit || names(c.ref) || names(c.fromRef) ? strip(c) : c));
  }
  for (const m of scope.mentions) {
    if (m.type !== type) continue;
    delete m.label;
    if (opts.blankIds) m.id = '';
  }
}

function sanitiseActor(a: AuditActor): AuditActor {
  const out: AuditActor = { kind: a.kind, key: a.key, via: a.via };
  if (a.sub) out.sub = a.sub;
  if (a.email && a.email.trim()) out.email = a.email.trim();
  if (a.role) out.role = a.role;
  if (a.operator) out.operator = true;
  if (a.recipientKind) out.recipientKind = a.recipientKind;
  if (a.recipientId) out.recipientId = a.recipientId;
  return out;
}

// ── Erasure (pure rewrites; repo.scrubAuditFor* does the I/O) ──

export interface ScrubResult {
  entry: AuditEntry;
  detail: AuditDetail | null;
  changed: boolean;
}

const stripValues = (c: AuditChange): AuditChange => {
  const { from: _f, to: _t, ...rest } = c;
  return { ...rest, scrubbed: true };
};

/**
 * Strip one record's names and values from an entry: matching targets lose their label and
 * every change value, changes whose `ref`/`fromRef` names it lose their values, and matching
 * mentions read `placeholder`. With `blankIds` the record id itself is blanked too (a player's
 * natural key is derived from their ID number); the caller then deletes its `E#` pointers.
 */
export function scrubAuditEntity(
  entry: AuditEntry,
  detail: AuditDetail | null,
  type: string,
  ids: ReadonlySet<string>,
  opts: { placeholder: string; blankIds?: boolean },
): ScrubResult {
  return scrubAuditWhere(entry, detail, (r) => r.type === type && ids.has(r.id), opts);
}

/** {@link scrubAuditEntity} for every record `hit` matches. */
function scrubAuditWhere(
  entry: AuditEntry,
  detail: AuditDetail | null,
  matches: (r: { type: string; id: string }) => boolean,
  opts: { placeholder: string; blankIds?: boolean },
): ScrubResult {
  const hit = (r: { type: string; id: string } | undefined) => !!r && matches(r);
  const blank = <T extends { id: string }>(r: T): T => (opts.blankIds ? { ...r, id: '' } : r);
  const fixChange = (c: AuditChange, inTarget: boolean): AuditChange => {
    const refHit = hit(c.ref) || hit(c.fromRef);
    if (!inTarget && !refHit) return c;
    const out = c.masked ? { ...c, scrubbed: true as const } : stripValues(c);
    if (out.ref && hit(out.ref)) out.ref = blank(out.ref);
    if (out.fromRef && hit(out.fromRef)) out.fromRef = blank(out.fromRef);
    return out;
  };
  const nextEntry: AuditEntry = {
    ...entry,
    targets: entry.targets.map((t) => {
      if (!hit(t)) return t;
      const { label: _l, ...rest } = t;
      return blank({ ...rest, scrubbed: true as const });
    }),
  };
  const nextDetail: AuditDetail | null = detail && {
    targets: detail.targets.map((t) => {
      const inTarget = hit(t);
      const changes = t.changes.map((c) => fixChange(c, inTarget));
      return inTarget ? blank({ ...t, changes }) : { ...t, changes };
    }),
    mentions: detail.mentions.map((m) => (hit(m) ? blank({ ...m, label: opts.placeholder }) : m)),
  };
  return {
    entry: nextEntry,
    detail: nextDetail,
    changed: stable(nextEntry) !== stable(entry) || stable(nextDetail) !== stable(detail),
  };
}

/**
 * Redact a deleted club's side of an entry (assumption 5): targets OF that club (their `clubId`,
 * or the club itself) lose label and values; club mentions read `placeholder`; changes naming
 * the club lose their values. Targets of any other club are untouched, so a two-club entry keeps
 * the surviving side.
 */
export function redactAuditClub(
  entry: AuditEntry,
  detail: AuditDetail | null,
  clubId: string,
  opts: { placeholder: string },
): ScrubResult {
  const ofClub = (t: AuditTargetHead) =>
    t.clubId === clubId || (t.type === 'club' && t.id === clubId);
  const matched = new Set(entry.targets.filter(ofClub).map((t) => refKey(t.type, t.id)));
  const isClub = (r: AuditRef | undefined) => !!r && r.type === 'club' && r.id === clubId;
  const nextEntry: AuditEntry = {
    ...entry,
    targets: entry.targets.map((t) => {
      if (!ofClub(t)) return t;
      const { label: _l, ...rest } = t;
      return { ...rest, scrubbed: true as const };
    }),
  };
  const nextDetail: AuditDetail | null = detail && {
    targets: detail.targets.map((t) => {
      const inTarget = matched.has(refKey(t.type, t.id));
      return {
        ...t,
        changes: t.changes.map((c) =>
          inTarget || isClub(c.ref) || isClub(c.fromRef)
            ? c.masked
              ? { ...c, scrubbed: true as const }
              : stripValues(c)
            : c,
        ),
      };
    }),
    mentions: detail.mentions.map((m) => (isClub(m) ? { ...m, label: opts.placeholder } : m)),
  };
  return {
    entry: nextEntry,
    detail: nextDetail,
    changed: stable(nextEntry) !== stable(entry) || stable(nextDetail) !== stable(detail),
  };
}

/**
 * Cohort clear (assumption 6): an entry goes when it is about cohort records only — at least one
 * target, every target a cohort type, and not a link action. Config, user and link entries stay.
 */
export function isCohortAuditEntry(entry: Pick<AuditEntry, 'targets' | 'action'>): boolean {
  return (
    entry.targets.length > 0 &&
    !entry.action.startsWith('link.') &&
    entry.targets.every((t) => AUDIT_COHORT_TYPES.has(t.type))
  );
}

const isCohortRef = (r: { type: string } | undefined) => !!r && AUDIT_COHORT_TYPES.has(r.type);

/**
 * Cohort clear, for an entry that stays ({@link isCohortAuditEntry} false): true when it still
 * names a cohort record — a cohort target beside a kept one, a cohort mention, or a change
 * whose value names a cohort record.
 */
export function auditEntryNamesCohort(
  entry: Pick<AuditEntry, 'targets'>,
  detail: AuditDetail | null,
): boolean {
  return (
    entry.targets.some(isCohortRef) ||
    !!detail?.mentions.some(isCohortRef) ||
    !!detail?.targets.some(
      (t) => isCohortRef(t) || t.changes.some((c) => isCohortRef(c.ref) || isCohortRef(c.fromRef)),
    )
  );
}

/**
 * Cohort clear, for an entry that stays: every cohort record it names loses its label and
 * values (cohort mentions read `placeholder`), as an erasure would. Ids and pointers stay.
 */
export function scrubAuditCohort(
  entry: AuditEntry,
  detail: AuditDetail | null,
  opts: { placeholder: string },
): ScrubResult {
  return scrubAuditWhere(entry, detail, isCohortRef, opts);
}

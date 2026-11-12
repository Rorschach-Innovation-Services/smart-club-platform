/**
 * Erase an umpire or scorer (admin `DELETE /umpires/:id`, `DELETE /scorers/:id`; contract in
 * docs/api/officials.md). Personal details go; an anonymous stub stays so past appointments
 * and captain's-report ratings keep resolving by id.
 *
 * The ERASE SET is the chosen record plus every record whose `mergedInto` chain resolves to it
 * (merged duplicates keep a full copy of the person's details). Steps, in this order so a
 * crash anywhere leaves a state a re-run repairs (DELETE on an erased record re-runs them all):
 *
 *   1. Stub every record in the set (PII first: from here on nothing can send to or show them).
 *   2. Fixtures: not yet played (dated tenant-today or later, undated, or `dateTbc`) ⇒ the
 *      official is removed; played ⇒ the denormalised name becomes the placeholder.
 *   3. Ledger: every row on a not-yet-played fixture; unsent (queued/exhausted) rows elsewhere.
 *   4. Captain's reports (umpires only), listed AFTER the fixtures are rewritten (a report
 *      opening copies its snapshot names from the officials row): names scrubbed per element;
 *      a pending report drops the entry on a not-yet-played fixture, and drops substitute
 *      cards naming the erased id on any fixture (repo.scrubCaptainsReportUmpires).
 *   5. Audit trail: every entry naming a record in the set loses that person's names and values
 *      (repo.scrubAuditForEntity); the record id stays, like the stub (assumption 4).
 *   6. A PII-free OFFICIALERASE# audit row.
 *
 * Every classification is derived from fixture dates, never from "was the official still on
 * it", so a re-run after a crash in step 2 still finds the right ledger rows and reports.
 *
 * A PENDING, never-erased record is hard-deleted instead (this is Reject): it cannot be
 * referenced, so no walk is needed — but its audit entries (the signup, any edits) are scrubbed
 * FIRST, while the record still exists: a re-run after the delete is a 404.
 *
 * Accepted race, as in the merge: the officials rows are read-modify-write, so an admin
 * officials PUT landing between the list and the put is overwritten.
 *
 * Deliberately no notices to co-officials, matching a normal removal.
 */
import { randomUUID } from 'node:crypto';
import type * as repoModule from './repo.js';
import { tenantDate } from './tenant-time.js';
import { resolveTeam } from './teams.js';
import type {
  Club,
  FixtureOfficials,
  OfficialErasureCounts,
  Scorer,
  Series,
  Umpire,
} from './types.js';

export type OfficialRoleKind = 'umpire' | 'scorer';

export const ERASED_PLACEHOLDER: Record<OfficialRoleKind, string> = {
  umpire: 'Removed umpire',
  scorer: 'Removed scorer',
};

export type EraseRepo = Pick<
  typeof repoModule,
  | 'getUmpire'
  | 'getScorer'
  | 'listUmpires'
  | 'listScorers'
  | 'putUmpire'
  | 'putScorer'
  | 'deleteUmpire'
  | 'deleteScorer'
  | 'listSeries'
  | 'listClubs'
  | 'listFixtureOfficials'
  | 'putFixtureOfficials'
  | 'listOfficialsNotify'
  | 'deleteOfficialsNotify'
  | 'listCaptainsReports'
  | 'scrubCaptainsReportUmpires'
  | 'scrubAuditForEntity'
  | 'putOfficialEraseLog'
>;

export interface VacatedFixture {
  seriesId: string;
  fixtureId: string;
  date?: string;
  label: string;
}

export interface ErasePreview {
  vacated: VacatedFixture[];
  counts: { today: number; upcoming: number; played: number };
}

export interface EraseResult {
  erased: string[];
  hardDeleted: boolean;
  vacated: VacatedFixture[];
}

/** The route's view plus what it logs (the audit row id and counts, never the registry id). */
export interface EraseOutcome extends EraseResult {
  auditId: string;
  counts: OfficialErasureCounts;
}

export class OfficialNotFoundError extends Error {}

type Official = Umpire | Scorer;

interface FixtureLite {
  id?: string;
  date?: string;
  dateTbc?: boolean;
  home?: string;
  away?: string;
}

/** Not yet played: dated today or later, undated, or postponed with the date to be confirmed. */
export function notYetPlayed(f: FixtureLite | undefined, today: string): boolean {
  if (!f) return false; // orphan officials row: keep the history, rename only
  return !f.date || f.dateTbc === true || f.date >= today;
}

/** The record plus every record whose mergedInto chain ends at it. */
export function eraseSetFor(id: string, registry: Array<Pick<Official, 'id' | 'mergedInto'>>) {
  const into = new Map(registry.map((r) => [r.id, r.mergedInto]));
  const set = new Set<string>([id]);
  for (const r of registry) {
    const seen = new Set<string>();
    let cur: string | undefined = r.id;
    while (cur && !seen.has(cur)) {
      if (cur === id) {
        set.add(r.id);
        break;
      }
      seen.add(cur);
      cur = into.get(cur);
    }
  }
  return set;
}

function stubOf(role: OfficialRoleKind, rec: Official, at: string, by: string): Official {
  const base = {
    id: rec.id,
    displayName: ERASED_PLACEHOLDER[role],
    active: false,
    ...(rec.mergedInto ? { mergedInto: rec.mergedInto } : {}),
    ...(rec.createdAt ? { createdAt: rec.createdAt } : {}),
    updatedAt: at,
    // A re-run keeps the first erase's stamp.
    erasedAt: rec.erasedAt ?? at,
    erasedBy: rec.erasedBy ?? by,
  };
  return role === 'umpire' ? ({ ...base, aliases: [] } as Umpire) : (base as Scorer);
}

const holds = (role: OfficialRoleKind, o: FixtureOfficials, ids: Set<string>) =>
  role === 'umpire'
    ? (o.umpires ?? []).some((u) => ids.has(u.umpireId)) ||
      (!!o.referee && ids.has(o.referee.umpireId))
    : (o.scorers ?? []).some((x) => ids.has(x.scorerId));

const ledgerRoleMatches = (role: OfficialRoleKind, rowRole: string) =>
  role === 'scorer' ? rowRole === 'scorer' : rowRole === 'umpire' || rowRole === 'referee';

interface Context {
  record: Official;
  ids: Set<string>;
  registry: Official[];
  today: string;
  fixtureOf: (seriesId: string, fixtureId: string) => FixtureLite | undefined;
  labelOf: (seriesId: string, fixtureId: string) => string;
  rows: Awaited<ReturnType<EraseRepo['listFixtureOfficials']>>;
}

async function load(
  repo: EraseRepo,
  tenant: string,
  role: OfficialRoleKind,
  id: string,
  today: string,
): Promise<Context> {
  const record =
    role === 'umpire' ? await repo.getUmpire(tenant, id) : await repo.getScorer(tenant, id);
  if (!record) throw new OfficialNotFoundError(`${role} not found`);
  const [registry, series, clubs, rows] = await Promise.all([
    role === 'umpire' ? repo.listUmpires(tenant) : repo.listScorers(tenant),
    repo.listSeries(tenant),
    repo.listClubs(tenant),
    repo.listFixtureOfficials(tenant),
  ]);
  const ids = eraseSetFor(id, registry as Official[]);
  const seriesById = new Map<string, Series>(series.map((s) => [s.id, s]));
  const clubsById = new Map<string, Club>(clubs.map((c) => [c.id, c]));
  const fixtureOf = (seriesId: string, fixtureId: string) =>
    ((seriesById.get(seriesId)?.fixtures as FixtureLite[] | undefined) ?? []).find(
      (f) => f.id === fixtureId,
    );
  const labelOf = (seriesId: string, fixtureId: string) => {
    const s = seriesById.get(seriesId);
    const f = fixtureOf(seriesId, fixtureId);
    if (!s || !f) return fixtureId;
    return `${resolveTeam(s, f.home ?? '', clubsById).name} v ${resolveTeam(s, f.away ?? '', clubsById).name}`;
  };
  return {
    record,
    ids,
    registry: registry as Official[],
    today,
    fixtureOf,
    labelOf,
    rows: rows.filter((o) => holds(role, o, ids)),
  };
}

function vacatedOf(ctx: Context): VacatedFixture[] {
  return ctx.rows
    .filter((o) => notYetPlayed(ctx.fixtureOf(o.seriesId, o.fixtureId), ctx.today))
    .map((o) => {
      const date = ctx.fixtureOf(o.seriesId, o.fixtureId)?.date;
      return {
        seriesId: o.seriesId,
        fixtureId: o.fixtureId,
        ...(date ? { date } : {}),
        label: ctx.labelOf(o.seriesId, o.fixtureId),
      };
    });
}

/** The confirm dialog's counts: which fixtures the erase would leave without this official. */
export async function previewOfficialErase(
  repo: EraseRepo,
  tenant: string,
  role: OfficialRoleKind,
  id: string,
  today: string = tenantDate(),
): Promise<ErasePreview> {
  const ctx = await load(repo, tenant, role, id, today);
  const vacated = vacatedOf(ctx);
  const todayCount = vacated.filter(
    (v) => v.date === today && !ctx.fixtureOf(v.seriesId, v.fixtureId)?.dateTbc,
  ).length;
  return {
    vacated,
    counts: {
      today: todayCount,
      upcoming: vacated.length - todayCount,
      played: ctx.rows.length - vacated.length,
    },
  };
}

export async function eraseOfficial(
  repo: EraseRepo,
  tenant: string,
  role: OfficialRoleKind,
  id: string,
  actor: string,
  today: string = tenantDate(),
): Promise<EraseOutcome> {
  const at = new Date().toISOString();
  const placeholder = ERASED_PLACEHOLDER[role];
  const counts: OfficialErasureCounts = {
    records: 0,
    vacated: 0,
    renamed: 0,
    ledger: 0,
    reports: 0,
  };
  const auditId = randomUUID();
  const audit = (hardDeleted: boolean) =>
    repo.putOfficialEraseLog(tenant, {
      id: auditId,
      kind: 'official-erasure',
      tenant,
      role,
      officialId: id,
      hardDeleted,
      erasedAt: at,
      erasedBy: actor,
      counts,
    });

  // Reject: a pending, never-erased record cannot be referenced (it is not appointable, not
  // attributable, and never a merge target), so it is hard-deleted without the walk.
  const record =
    role === 'umpire' ? await repo.getUmpire(tenant, id) : await repo.getScorer(tenant, id);
  if (!record) throw new OfficialNotFoundError(`${role} not found`);
  if (record.pending && !record.erasedAt) {
    await repo.scrubAuditForEntity(tenant, role, [id], { placeholder });
    if (role === 'umpire') await repo.deleteUmpire(tenant, id);
    else await repo.deleteScorer(tenant, id);
    counts.records = 1;
    await audit(true);
    return { erased: [id], hardDeleted: true, vacated: [], auditId, counts };
  }

  const ctx = await load(repo, tenant, role, id, today);
  const { ids } = ctx;
  counts.records = ids.size;

  // 1. Stubs.
  const byId = new Map(ctx.registry.map((r) => [r.id, r]));
  for (const x of ids) {
    const rec = byId.get(x) ?? (x === id ? ctx.record : undefined);
    if (!rec) continue;
    const stub = stubOf(role, rec, at, actor);
    if (role === 'umpire') await repo.putUmpire(tenant, stub as Umpire);
    else await repo.putScorer(tenant, stub as Scorer);
  }

  // 2. Fixtures.
  const vacated = vacatedOf(ctx);
  for (const row of ctx.rows) {
    const future = notYetPlayed(ctx.fixtureOf(row.seriesId, row.fixtureId), today);
    // putFixtureOfficials REPLACES the item (and deletes it once empty), so start from the
    // stored row: fields the erase doesn't touch must survive it.
    const { seriesId, fixtureId, referee, scorers, umpires: rowUmpires, ...stored } = row;
    const umpires = rowUmpires ?? [];
    const next: FixtureOfficials = { ...stored, umpires };
    if (role === 'umpire') {
      next.umpires = future
        ? umpires.filter((u) => !ids.has(u.umpireId))
        : umpires.map((u) => (ids.has(u.umpireId) ? { ...u, name: placeholder } : u));
      if (referee && !(future && ids.has(referee.umpireId)))
        next.referee = ids.has(referee.umpireId) ? { ...referee, name: placeholder } : referee;
      if (scorers) next.scorers = scorers;
    } else {
      if (referee) next.referee = referee;
      const s = scorers ?? [];
      next.scorers = future
        ? s.filter((x) => !ids.has(x.scorerId))
        : s.map((x) => (ids.has(x.scorerId) ? { ...x, name: placeholder } : x));
    }
    await repo.putFixtureOfficials(tenant, seriesId, fixtureId, next);
    if (future) counts.vacated++;
    else counts.renamed++;
  }

  // 3. Ledger.
  const ledger = (await repo.listOfficialsNotify(tenant)).filter(
    (r) => ledgerRoleMatches(role, r.role) && ids.has(r.umpireId),
  );
  for (const r of ledger) {
    const future = notYetPlayed(ctx.fixtureOf(r.seriesId, r.fixtureId), today);
    if (future || r.status !== 'completed') {
      await repo.deleteOfficialsNotify(tenant, r);
      counts.ledger++;
    }
  }

  // 4. Captain's reports, listed only NOW: a report opening copies its snapshot names from the
  // officials row, so one opened before step 2 finished is still caught here.
  if (role === 'umpire') {
    const reports = (await repo.listCaptainsReports(tenant)).filter(
      (r) =>
        (r.umpiresSnapshot ?? []).some((u) => ids.has(u.umpireId)) ||
        (r.umpires ?? []).some((u) => !!u.umpireId && ids.has(u.umpireId)),
    );
    for (const r of reports) {
      const drop = notYetPlayed(ctx.fixtureOf(r.seriesId, r.fixtureId), today);
      if (await repo.scrubCaptainsReportUmpires(tenant, r, ids, placeholder, drop))
        counts.reports++;
    }
  }

  // 5. Audit trail: names and values out of every entry naming the set (runs again on a re-run,
  // repairing an entry recorded while the erase was in flight).
  await repo.scrubAuditForEntity(tenant, role, ids, { placeholder });

  // 6. Audit row.
  await audit(false);
  return { erased: [...ids], hardDeleted: false, vacated, auditId, counts };
}

/**
 * The disposal flow's certificate purge, shared by the chair delete route (index.ts) and the
 * resolve-duplicate-players CLI (only when a decision opts in). A deleted player's transfer
 * certificates carry their full ID/DOB, so each resolved clearance naming them at this club —
 * inbound (they moved here) or outgoing (they left) — loses its PDF, CERT# item and pointers.
 * The row is already gone, so a purge failure is reported (via `onError`) rather than thrown;
 * erasure's prefix purge remains the backstop.
 */
import { isCertifiable } from './certificates/certifiable.js';

type RepoModule = typeof import('./repo.js');

export async function purgePlayerCertificates(
  repo: Pick<
    RepoModule,
    'listInboundForDest' | 'listClearancesForSource' | 'purgeClearanceCertificate'
  >,
  tenant: string,
  clubId: string,
  naturalKey: string,
  onError: (err: unknown, clearanceId: string) => void = (err, id) =>
    console.error(`certificate purge failed for clearance ${id}`, err),
): Promise<number> {
  const [inbound, outgoing] = await Promise.all([
    repo.listInboundForDest(tenant, clubId),
    repo.listClearancesForSource(tenant, clubId),
  ]);
  const mine = [...inbound, ...outgoing].filter(
    (x) => x.playerNaturalKey === naturalKey && isCertifiable(x),
  );
  let purged = 0;
  for (const x of mine) {
    try {
      await repo.purgeClearanceCertificate(tenant, x);
      purged++;
    } catch (err) {
      onError(err, x.id);
    }
  }
  return purged;
}

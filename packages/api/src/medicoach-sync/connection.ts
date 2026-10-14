/**
 * The operator console's view of one tenant's Match Centre connection (ADR 0020, Phase 1):
 * composed from the tenant config (intent: sync on, player sync, go-live date), SYNCHEALTH#
 * (whether the sync has ever worked), MCRECON# (whether medicoach was reachable at the last
 * reconciliation) and MCAWAIT# (fixtures medicoach does not have yet). Counts and fixture refs
 * only — no player data lives in any of these rows. The stage is inferred (`inferred: true`)
 * until the MCCONN# connection record exists.
 */
import { hasFeature } from '../features.js';
import type { SyncHealth, TenantConfig } from '../types.js';
import { playerSyncEnabled } from './player-placement.js';

type RepoModule = typeof import('../repo.js');
type ConnectionRepo = Pick<RepoModule, 'getSyncHealth' | 'getMcReconcile' | 'listMcAwait'>;

export type SyncHealthStatus = 'ok' | 'failing' | 'dry-run' | 'never';

/**
 * One word for SYNCHEALTH#, the same rule the admin sync page applies: failing when the last
 * failure is newer than the last success (or there was never a success); ok after a success;
 * never before any real run. A dry run (secrets unset) overrides — nothing is really synced.
 */
export function syncHealthStatus(health: SyncHealth | null, dryRun: boolean): SyncHealthStatus {
  if (dryRun) return 'dry-run';
  if (
    health?.lastErrorAt &&
    (!health.lastSuccessAt || Date.parse(health.lastErrorAt) > Date.parse(health.lastSuccessAt))
  )
    return 'failing';
  return health?.lastSuccessAt ? 'ok' : 'never';
}

export interface MedicoachConnectionView {
  stage: 'not_connected' | 'live';
  inferred: true;
  syncEnabled: boolean;
  playerSync: boolean;
  goLiveDate: string | null;
  dryRun: boolean;
  mcReachable: boolean | null;
  lastReconcileAt: string | null;
  health: { status: SyncHealthStatus; lastSuccessAt: string | null; lastError: string | null };
  awaitingTotal: number;
  awaiting: Array<{
    seriesId: string;
    seriesName: string;
    leagueKey: string;
    count: number;
    firstSeen: string;
    lastSeen: string;
  }>;
}

/** GET /platform/tenants/:slug/medicoach/connection — the composed view. */
export async function buildConnectionView(
  repo: ConnectionRepo,
  tenant: string,
  config: TenantConfig,
  dryRun: boolean,
): Promise<MedicoachConnectionView> {
  const [health, recon, awaiting] = await Promise.all([
    repo.getSyncHealth(tenant),
    repo.getMcReconcile(tenant),
    repo.listMcAwait(tenant),
  ]);
  const syncEnabled = hasFeature(config, 'medicoachSync');
  const rows = awaiting
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count || a.seriesId.localeCompare(b.seriesId));
  return {
    // Live once the sync is on and a real pull has ever succeeded.
    stage: syncEnabled && health?.lastSuccessAt ? 'live' : 'not_connected',
    inferred: true,
    syncEnabled,
    playerSync: playerSyncEnabled(config),
    goLiveDate: config.integrations?.medicoach?.goLiveDate ?? null,
    dryRun,
    mcReachable: recon ? recon.mcReachable : null,
    lastReconcileAt: recon?.lastReconcileAt ?? null,
    health: {
      status: syncHealthStatus(health, dryRun),
      lastSuccessAt: health?.lastSuccessAt ?? null,
      lastError: health?.lastError ?? null,
    },
    awaitingTotal: rows.reduce((sum, r) => sum + r.count, 0),
    awaiting: rows.map((r) => ({
      seriesId: r.seriesId,
      seriesName: r.seriesName ?? r.seriesId,
      leagueKey: r.leagueKey ?? '',
      count: r.count,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
    })),
  };
}

/** One row of GET /platform/medicoach/overview. */
export async function buildOverviewRow(
  repo: ConnectionRepo,
  config: TenantConfig,
  dryRun: boolean,
) {
  const view = await buildConnectionView(repo, config.tenant, config, dryRun);
  return {
    tenant: config.tenant,
    name: config.branding?.name ?? config.tenant,
    syncEnabled: view.syncEnabled,
    dryRun,
    healthStatus: view.health.status,
    awaitingTotal: view.awaitingTotal,
    lastReconcileAt: view.lastReconcileAt,
  };
}

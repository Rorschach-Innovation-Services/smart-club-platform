/**
 * Meta WhatsApp delivery statuses for captain's-report notices (sent → delivered → read, or
 * failed), received on `POST /integrations/whatsapp/status`.
 *
 * Smart club sends through medicoach's Meta app and WABA (see ./whatsapp.ts). A Meta app has
 * ONE webhook callback URL per field, and it is medicoach's, so smart club never hears from
 * Meta directly: medicoach FORWARDS the raw `statuses[]` entries for smart club's sending
 * number, signed with the medicoach sync scheme (`X-Sync-Timestamp` / `X-Sync-Signature`,
 * the shared `MedicoachSyncSecret`; see medicoach-sync-contract.ts). The route fails closed
 * while that secret is empty.
 *
 * Body: `{ "statuses": [<Meta status>, ...] }` (Meta's own envelope,
 * `entry[].changes[].value.statuses[]`, is accepted too).
 *
 * Matching is by message id (wamid) only, through the `WAMSG#<wamid>` lookup each send
 * writes. An unknown id is acknowledged and ignored (medicoach's own messages, an expired
 * lookup) — never an error, so the forwarder never retries it. Statuses only move forward:
 * sent < delivered < read, and failed is final.
 */
import type { CaptainsReportDelivery } from '../types.js';

type RepoModule = typeof import('../repo.js');

/** At most this many statuses are applied from one POST (Meta batches far fewer). */
export const MAX_STATUSES_PER_POST = 500;

type ProviderStatus = NonNullable<CaptainsReportDelivery['providerStatus']>;
const RANK: Record<ProviderStatus, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

export interface ParsedStatus {
  id: string;
  status: ProviderStatus;
  /** ISO, from Meta's epoch-seconds `timestamp`. */
  at: string;
  error?: string;
}

/** Every raw status entry in a body: `{statuses}` (forwarded) or Meta's envelope. */
function rawStatuses(payload: unknown): unknown[] {
  const top = (payload as { statuses?: unknown })?.statuses;
  if (Array.isArray(top)) return top;
  const out: unknown[] = [];
  const entries = (payload as { entry?: unknown })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const statuses = (change as { value?: { statuses?: unknown } })?.value?.statuses;
      if (Array.isArray(statuses)) out.push(...statuses);
    }
  }
  return out;
}

/** The well-formed statuses in a body (others ignored), at most MAX_STATUSES_PER_POST. */
export function parseStatuses(payload: unknown): ParsedStatus[] {
  const out: ParsedStatus[] = [];
  for (const s of rawStatuses(payload)) {
    const x = s as {
      id?: unknown;
      status?: unknown;
      timestamp?: unknown;
      errors?: Array<{ title?: unknown; message?: unknown }>;
    };
    if (typeof x.id !== 'string' || !x.id || x.id.length > 256) continue;
    if (typeof x.status !== 'string' || !(x.status in RANK)) continue;
    const secs = Number(x.timestamp);
    const at = Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000) : new Date();
    const err = Array.isArray(x.errors) ? x.errors[0] : undefined;
    const error =
      typeof err?.title === 'string'
        ? err.title
        : typeof err?.message === 'string'
          ? err.message
          : undefined;
    out.push({
      id: x.id,
      status: x.status as ProviderStatus,
      at: at.toISOString(),
      ...(error ? { error: error.slice(0, 200) } : {}),
    });
    if (out.length >= MAX_STATUSES_PER_POST) return out;
  }
  return out;
}

export interface StatusApplySummary {
  matched: number;
  unknown: number;
  stale: number;
}

/** Apply parsed statuses to the report deliveries they belong to. */
export async function applyWhatsAppStatuses(
  repo: RepoModule,
  statuses: ParsedStatus[],
): Promise<StatusApplySummary> {
  const out: StatusApplySummary = { matched: 0, unknown: 0, stale: 0 };
  for (const s of statuses) {
    const ref = await repo.getWhatsAppMessageRef(s.id);
    const report = ref
      ? await repo.getCaptainsReport(ref.tenant, ref.seriesId, ref.fixtureId, ref.clubId)
      : null;
    const index = report?.deliveries?.findIndex(
      (d) => d.channel === 'whatsapp' && d.messageId === s.id,
    );
    if (!ref || !report || index === undefined || index < 0) {
      out.unknown++;
      continue;
    }
    const current = report.deliveries![index];
    const currentRank = current.providerStatus ? RANK[current.providerStatus] : 0;
    if (RANK[s.status] <= currentRank) {
      out.stale++;
      continue;
    }
    const ok = await repo.setCaptainsReportProviderStatus(ref.tenant, report, index, s.id, {
      providerStatus: s.status,
      providerAt: s.at,
      ...(s.status === 'failed' ? { providerError: s.error ?? 'failed' } : {}),
    });
    if (ok) out.matched++;
    else out.unknown++;
  }
  return out;
}

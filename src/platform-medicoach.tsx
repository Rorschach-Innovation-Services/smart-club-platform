/**
 * Operator console: the Match Centre (medicoach) connection card for TenantEditPage
 * (ADR 0020 phase 1 — visibility only, no carry orchestration).
 *
 * Read-only status, so unlike its sibling cards it takes no {config, save}: it reads
 * GET /platform/tenants/:slug/medicoach/connection itself. It exists because fixtures
 * Smart Club holds but the Match Centre has no mapping for were invisible to operators
 * (the EMCU incident: 620 released fixtures silently absent) — the awaiting-carry count is
 * the headline. The stage is INFERRED from config until the Match Centre connection
 * summary lands, and is always labelled so.
 *
 * The status pieces (stage pill, health line, dry-run banner) are exported for the
 * per-tenant console page (platform-medicoach-console.tsx) so both read the same.
 */
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { qk } from './query';
import * as api from './api';
import { Btn, Card, Pill } from './atoms';
import { formatStamp } from './dates';
import type { MedicoachConnection } from './types';

const MUTED: CSSProperties = { color: 'var(--muted)', fontSize: 13 };

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "Live (inferred)" / "Not connected (inferred)" — the stage is never shown as fact. */
export function StagePill({ conn }: { conn: Pick<MedicoachConnection, 'stage' | 'inferred'> }) {
  const label = conn.stage === 'live' ? 'Live' : 'Not connected';
  return (
    <Pill tone={conn.stage === 'live' ? 'teal' : 'muted'} dot>
      {conn.inferred ? `${label} (inferred)` : label}
    </Pill>
  );
}

/** The sync health in plain language — what an operator should read off it. */
export function healthLine(conn: MedicoachConnection): string {
  const { status, lastSuccessAt, lastError } = conn.health;
  const lastOk = lastSuccessAt ? `last successful run ${formatStamp(lastSuccessAt)}` : null;
  if (!conn.syncEnabled) return 'The Match Centre sync is switched off for this client.';
  switch (status) {
    case 'ok':
      return `Sync is healthy${lastOk ? ` — ${lastOk}` : ''}.`;
    case 'failing':
      return (
        `Sync is failing${lastError ? `: ${lastError}` : ''}` +
        ` (${lastOk ?? 'no successful run yet'}).`
      );
    case 'dry-run':
      return 'Sync runs are dry-runs — nothing is reaching the Match Centre.';
    case 'never':
    default:
      return 'The sync has not run for this client yet.';
  }
}

export function DryRunBanner() {
  return (
    <div className="insights-callout alert" role="alert" style={{ marginTop: 0 }}>
      <strong>Warning:</strong> Sync secrets not configured — all sync runs are silent dry-runs.
      Nothing is sent to or read from the Match Centre until the secrets are set.
    </div>
  );
}

/** "N fixtures awaiting carry to Match Centre" (amber), or the all-clear (green). */
export function AwaitingCallout({ total }: { total: number }) {
  if (total > 0)
    return (
      <div className="insights-callout warn" role="status" style={{ fontSize: 12.5 }}>
        <strong style={{ fontSize: 15 }}>{plural(total, 'fixture')}</strong> awaiting carry to Match
        Centre
      </div>
    );
  return (
    <div className="insights-callout good" role="status">
      <strong>All clear:</strong> no fixtures awaiting carry to Match Centre.
    </div>
  );
}

export function MedicoachConnectionCard({ slug }: { slug: string }) {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: qk.platformMedicoachConnection(slug),
    queryFn: () => api.platformMedicoachConnection(slug),
    retry: 0,
  });
  const conn = q.data;

  return (
    <Card
      title="Match Centre"
      sub="Whether this client's fixtures are reaching the Match Centre, and what still needs a carry."
      action={
        <Btn
          tone="outline"
          size="sm"
          onClick={() => navigate(`/platform/tenants/${slug}/medicoach`)}
        >
          Open console
        </Btn>
      }
    >
      {q.isLoading ? (
        <p style={MUTED}>Loading Match Centre status…</p>
      ) : q.isError || !conn ? (
        <p style={MUTED}>Could not load the Match Centre status — refresh to retry.</p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {conn.dryRun && <DryRunBanner />}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <StagePill conn={conn} />
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{healthLine(conn)}</span>
          </div>
          <AwaitingCallout total={conn.awaitingTotal} />
        </div>
      )}
    </Card>
  );
}

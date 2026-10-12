/**
 * Operator console — Match Centre connection, per client (/platform/tenants/:slug/medicoach,
 * ADR 0020 phase 1). Read-only: the connection status, the series whose fixtures are
 * awaiting a carry to the Match Centre, and a "Check now" that reruns the reconciliation.
 *
 * Carrying is NOT done here yet — the automatic sync cannot create fixtures, so anything
 * listed needs a one-off bundle top-up run by the platform developer. Conflict and outbox
 * detail stays on the client's own Medicoach sync page (AdminMedicoachSync.tsx), deep-linked
 * rather than duplicated.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { queryClient, qk } from './query';
import * as api from './api';
import { ApiError } from './api';
import { Btn, Card, Icon } from './atoms';
import { tenantConsoleUrl } from './config';
import { formatStamp } from './dates';
import { AwaitingCallout, DryRunBanner, StagePill, healthLine, plural } from './platform-medicoach';
import type { MedicoachConnection } from './types';

type Toast = (m: string, t?: string) => void;

const MUTED: CSSProperties = { color: 'var(--muted)', fontSize: 13 };
const HINT: CSSProperties = { fontSize: 12, color: 'var(--muted-2)', margin: '10px 0 0' };

const CARRY_COPY =
  'These fixtures exist in Smart Club but not in the Match Centre. The automatic sync cannot ' +
  'create fixtures — they need a one-off carry (bundle top-up). Contact the platform ' +
  'developer to run the carry.';

const SYNC_OFF_COPY =
  'The Match Centre sync is switched off for this client, so these are not flagged on the ' +
  'client list. They are what the Match Centre would be missing if the sync is switched on.';

/**
 * The client's own Medicoach sync page (`/admin/medicoach_sync`) on that client's console
 * origin. null when this host has no reachable address for the client (see tenantConsoleUrl).
 */
export function adminSyncUrl(slug: string): string | null {
  const base = tenantConsoleUrl(slug);
  if (!base) return null;
  const u = new URL(base);
  u.pathname = '/admin/medicoach_sync';
  return u.toString();
}

function StatusRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', fontSize: 13 }}>
      <span style={{ minWidth: 150, color: 'var(--muted-2)', fontSize: 12 }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

function reachableText(r: boolean | null): string {
  if (r === null) return 'Not checked yet';
  return r ? 'Reachable' : 'Not reachable';
}

export function MedicoachConsolePage({ toast }: { toast: Toast }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const [checking, setChecking] = useState(false);

  const configQ = useQuery({
    queryKey: qk.platformTenant(slug),
    queryFn: () => api.platformGetTenant(slug),
    retry: 0,
  });
  const connQ = useQuery({
    queryKey: qk.platformMedicoachConnection(slug),
    queryFn: () => api.platformMedicoachConnection(slug),
    retry: 0,
  });

  async function checkNow() {
    setChecking(true);
    try {
      const fresh = await api.platformMedicoachReconcile(slug);
      queryClient.setQueryData<MedicoachConnection>(qk.platformMedicoachConnection(slug), fresh);
      // The client list's badges read the overview projection — keep them in step.
      queryClient.invalidateQueries({ queryKey: qk.platformMedicoachOverview() });
      // The reconcile answers 200 even when it could not check: a dry-run makes no call, and an
      // unreachable Match Centre leaves the last known state. Say so rather than "all clear".
      if (fresh.dryRun) {
        toast('Sync secrets are not configured — no check was made.', 'warn');
      } else if (fresh.mcReachable === false) {
        toast("Couldn't reach the Match Centre — showing the last known state.", 'error');
      } else {
        toast(
          fresh.awaitingTotal > 0
            ? `${plural(fresh.awaitingTotal, 'fixture')} awaiting carry`
            : 'Checked — nothing awaiting carry',
          fresh.awaitingTotal > 0 ? 'warn' : undefined,
        );
      }
    } catch (err) {
      toast(
        err instanceof ApiError
          ? err.message
          : "Couldn't check the Match Centre. Check your connection.",
        'error',
      );
    } finally {
      setChecking(false);
    }
  }

  const name = configQ.data?.branding?.name ?? slug;
  const syncUrl = adminSyncUrl(slug);
  const conn = connQ.data;

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Platform / Clients / {name} / Match Centre</div>
          <h1 className="ph-title">
            Match Centre <em>connection</em>
          </h1>
          <p className="ph-desc">
            Whether this client&apos;s fixtures are reaching the Match Centre, and which still need
            a carry. Read-only.
          </p>
        </div>
        <div className="ph-actions">
          <Btn tone="teal" size="sm" onClick={checkNow} disabled={checking || !conn}>
            {checking ? 'Checking…' : 'Check now'}
          </Btn>
          <Btn tone="outline" size="sm" onClick={() => navigate(`/platform/tenants/${slug}`)}>
            Back to settings
          </Btn>
        </div>
      </div>

      {connQ.isLoading ? (
        <p style={MUTED}>Loading Match Centre status…</p>
      ) : connQ.isError || !conn ? (
        <p style={MUTED}>Could not load the Match Centre status — refresh to retry.</p>
      ) : (
        <div className="settings-layout">
          {conn.dryRun && <DryRunBanner />}

          <Card
            title={
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                Connection <StagePill conn={conn} />
              </span>
            }
            sub={healthLine(conn)}
            action={
              <Btn
                tone="outline"
                size="sm"
                icon={Icon.Arrow}
                disabled={!syncUrl || !conn.syncEnabled}
                title={
                  !conn.syncEnabled
                    ? 'The Match Centre sync is switched off for this client'
                    : !syncUrl
                      ? 'No web address yet'
                      : `Open ${name}'s Medicoach sync page`
                }
                onClick={() => {
                  if (syncUrl) window.location.assign(syncUrl);
                }}
              >
                Sync detail
              </Btn>
            }
          >
            <div style={{ display: 'grid', gap: 6 }}>
              <StatusRow label="Sync">{conn.syncEnabled ? 'On' : 'Off'}</StatusRow>
              <StatusRow label="Player sync">{conn.playerSync ? 'On' : 'Off'}</StatusRow>
              <StatusRow label="Go-live date">{conn.goLiveDate ?? 'Not set'}</StatusRow>
              <StatusRow label="Match Centre">{reachableText(conn.mcReachable)}</StatusRow>
              <StatusRow label="Last reconcile">
                {conn.lastReconcileAt ? formatStamp(conn.lastReconcileAt) : 'Never'}
              </StatusRow>
              <StatusRow label="Last successful sync">
                {conn.health.lastSuccessAt ? formatStamp(conn.health.lastSuccessAt) : 'Never'}
              </StatusRow>
            </div>
            <p style={HINT}>
              The stage is inferred from this client&apos;s settings until the Match Centre reports
              its own connection summary. Conflicts and the outbox are on the client&apos;s Medicoach
              sync page (Sync detail).
            </p>
          </Card>

          <Card title="Awaiting carry" sub="Released fixtures the Match Centre has no record of.">
            <AwaitingCallout total={conn.awaitingTotal} />
            {conn.awaitingTotal > 0 && (
              <>
                {!conn.syncEnabled && <p style={HINT}>{SYNC_OFF_COPY}</p>}
                <p style={{ ...HINT, fontSize: 12.5, color: 'var(--muted)' }}>{CARRY_COPY}</p>
                <div className="tbl-w" style={{ marginTop: 12 }}>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Series</th>
                        <th>League</th>
                        <th>Fixtures</th>
                        <th className="hide-narrow">First seen</th>
                        <th className="hide-narrow">Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {conn.awaiting.map((a) => (
                        <tr key={a.seriesId}>
                          <td>{a.seriesName}</td>
                          <td>{a.leagueKey}</td>
                          <td>{a.count}</td>
                          <td className="hide-narrow">{formatStamp(a.firstSeen)}</td>
                          <td className="hide-narrow">{formatStamp(a.lastSeen)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

/**
 * Operator console: the medicoach PLAYER sync switch (`integrations.medicoach.playerSync`,
 * ADR 0019). Registrations go to medicoach team rosters on the 15-minute sync. It needs the
 * medicoach fixture sync (`features.medicoachSync`) on, and the client's teams must already be in
 * medicoach (bundle import) — the API probes team coverage when it is switched on and answers
 * with warnings, shown here (they are also toasted by the shared save).
 *
 * Kept in its own file, following the TransferWindowCard pattern, so platform.tsx does not grow.
 */
import { useState, type CSSProperties } from 'react';
import { Btn, Card } from './atoms';
import { ApiError } from './api';
import type { TenantConfig } from './types';

type Toast = (m: string, t?: string) => void;

const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '8px 0 0' };

export function PlayerSyncCard({
  config,
  save,
  toast,
}: {
  config: TenantConfig;
  save: (p: Partial<TenantConfig>) => Promise<TenantConfig & { warnings?: string[] }>;
  toast: Toast;
}) {
  const stored = config.integrations?.medicoach?.playerSync === true;
  const fixtureSyncOn = config.features?.medicoachSync === true;
  const [on, setOn] = useState(stored);
  const [err, setErr] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function saveIt() {
    setErr('');
    setWarnings([]);
    setBusy(true);
    try {
      const next = await save({
        integrations: {
          ...config.integrations,
          medicoach: { ...config.integrations?.medicoach, playerSync: on },
        },
      });
      setWarnings(next.warnings ?? []);
      toast(on ? 'Player sync switched on' : 'Player sync switched off');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Medicoach player sync"
      sub="Send new and changed registrations to medicoach team rosters on every sync."
    >
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <input
          type="checkbox"
          checked={on}
          disabled={!fixtureSyncOn && !stored}
          onChange={(e) => setOn(e.target.checked)}
        />
        Push players to medicoach
      </label>
      {!fixtureSyncOn && (
        <p style={HINT} role="note">
          Switch on the medicoach sync (Features: medicoachSync) first.
        </p>
      )}
      <p style={HINT}>
        Only switch it on once this client&apos;s clubs and teams are in medicoach (bundle import):
        players on a team medicoach doesn&apos;t have wait until a bundle top-up.
      </p>
      {warnings.length > 0 && (
        <div className="insights-callout warn" role="alert" style={{ marginTop: 10 }}>
          <strong>Team coverage:</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {err && <div style={ERR}>{err}</div>}
      <div style={{ marginTop: 10 }}>
        <Btn tone="teal" size="sm" onClick={saveIt} disabled={on === stored || busy}>
          {busy ? 'Saving…' : 'Save player sync'}
        </Btn>
      </div>
    </Card>
  );
}

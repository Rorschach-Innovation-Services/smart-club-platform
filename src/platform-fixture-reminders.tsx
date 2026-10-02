/**
 * Operator console: per-tenant scheduled fixture reminders (`TenantConfig.fixtureReminders`).
 *
 * The FixtureReminders cron runs every morning at 07:00 SAST and reminds each club chair of the
 * club's fixtures `leadDays` ahead. Clubs whose chair switched reminders off are skipped. Same
 * shape as ClearanceCertificateCard: local draft, dirty tracking, and the WHOLE key saved in one
 * write. `PUT /platform/tenants/:slug` re-validates (lead days 1..30, at most 4, deduped and sorted).
 *
 * Kept in its own file, following the RequiredDocsCard/CalendarsCard pattern, so platform.tsx
 * does not grow.
 */
import { useId, useState, type CSSProperties } from 'react';
import { Btn, Card } from './atoms';
import { ApiError } from './api';
import type { FixtureReminderChannel, FixtureRemindersConfig, TenantConfig } from './types';

type Toast = (m: string, t?: string) => void;

const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '8px 0 0' };
const CHECK_ROW: CSSProperties = {
  fontSize: 12.5,
  display: 'inline-flex',
  gap: 6,
  alignItems: 'center',
  marginRight: 16,
};

export const LEAD_DAYS_MIN = 1;
export const LEAD_DAYS_MAX = 30;
export const LEAD_DAYS_MAX_ENTRIES = 4;

const CHANNELS: Array<{ key: FixtureReminderChannel; label: string }> = [
  { key: 'email', label: 'Email' },
  { key: 'whatsapp', label: 'WhatsApp' },
];

const DEFAULTS: FixtureRemindersConfig = { enabled: false, leadDays: [1], channels: ['email'] };

/**
 * Parse the lead-days text ("3, 1") into a deduped, ascending list, or an error message.
 * The rules match the server's validateFixtureReminders.
 */
export function parseLeadDays(text: string): { leadDays: number[] } | { error: string } {
  const parts = text
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const nums: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!/^\d+$/.test(p) || n < LEAD_DAYS_MIN || n > LEAD_DAYS_MAX) {
      return {
        error: `Lead days must be whole numbers from ${LEAD_DAYS_MIN} to ${LEAD_DAYS_MAX}`,
      };
    }
    nums.push(n);
  }
  const leadDays = [...new Set(nums)].sort((a, b) => a - b);
  if (leadDays.length > LEAD_DAYS_MAX_ENTRIES) {
    return { error: `At most ${LEAD_DAYS_MAX_ENTRIES} lead days` };
  }
  return { leadDays };
}

export function FixtureRemindersCard({
  config,
  save,
  toast,
}: {
  config: TenantConfig;
  save: (p: Partial<TenantConfig>) => Promise<TenantConfig>;
  toast: Toast;
}) {
  const initial = config.fixtureReminders ?? DEFAULTS;
  const [enabled, setEnabled] = useState(initial.enabled);
  const [leadText, setLeadText] = useState(initial.leadDays.join(', '));
  const [channels, setChannels] = useState<FixtureReminderChannel[]>(initial.channels);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const leadId = useId();

  const parsed = parseLeadDays(leadText);
  // Canonical channel order, so ticking WhatsApp then Email doesn't look dirty.
  const orderedChannels = CHANNELS.map((c) => c.key).filter((k) => channels.includes(k));
  const dirty =
    enabled !== initial.enabled ||
    JSON.stringify(orderedChannels) !== JSON.stringify(initial.channels) ||
    !('leadDays' in parsed) ||
    JSON.stringify(parsed.leadDays) !== JSON.stringify(initial.leadDays);

  function toggleChannel(key: FixtureReminderChannel, on: boolean) {
    setChannels((cur) =>
      on ? [...cur.filter((c) => c !== key), key] : cur.filter((c) => c !== key),
    );
  }

  async function saveIt() {
    setErr('');
    if ('error' in parsed) {
      setErr(parsed.error);
      return;
    }
    if (enabled && parsed.leadDays.length === 0) {
      setErr('Add at least one lead day');
      return;
    }
    if (enabled && orderedChannels.length === 0) {
      setErr('Pick at least one channel');
      return;
    }
    setBusy(true);
    try {
      await save({
        fixtureReminders: { enabled, leadDays: parsed.leadDays, channels: orderedChannels },
      });
      setLeadText(parsed.leadDays.join(', '));
      toast('Fixture reminder settings saved');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Fixture reminders"
      sub="A morning reminder (07:00) to each club chair before their match days. Chairs can switch reminders off from their club home."
    >
      <label style={{ ...CHECK_ROW, marginBottom: 12 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Send fixture reminders
      </label>
      <div className="field" style={{ marginBottom: 12 }}>
        <label className="field-label" htmlFor={leadId}>
          Lead days
        </label>
        <input
          id={leadId}
          className="field-input"
          value={leadText}
          placeholder="e.g. 3, 1"
          onChange={(e) => setLeadText(e.target.value)}
        />
        <p style={HINT}>
          Days before the match to send a reminder, comma-separated ({LEAD_DAYS_MIN}–{LEAD_DAYS_MAX}
          , up to {LEAD_DAYS_MAX_ENTRIES}). Each club gets one reminder per match date, so lead days
          within a few days of each other collapse into the first.
        </p>
      </div>
      <div className="field" style={{ marginBottom: 12 }}>
        <div className="field-label">Channels</div>
        {CHANNELS.map((c) => (
          <label key={c.key} style={CHECK_ROW}>
            <input
              type="checkbox"
              checked={channels.includes(c.key)}
              onChange={(e) => toggleChannel(c.key, e.target.checked)}
            />
            {c.label}
          </label>
        ))}
        <p style={HINT}>
          WhatsApp only goes out once the fixture_reminder template is approved in Meta and the
          client&apos;s WhatsApp feature is on. Until then reminders go by email only.
        </p>
      </div>
      {err && <div style={{ ...ERR, marginBottom: 8 }}>{err}</div>}
      <Btn tone="teal" size="sm" onClick={saveIt} disabled={!dirty || busy}>
        {busy ? 'Saving…' : 'Save reminder settings'}
      </Btn>
    </Card>
  );
}

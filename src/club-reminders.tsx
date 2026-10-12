/**
 * Chair-facing fixture-reminders switch (club home). It writes `Club.remindersOptIn`, the same
 * flag the onboarding modal sets. The FixtureReminders cron treats an ABSENT flag as opted in
 * (CLI-imported clubs never see the onboarding modal), so only an explicit `false` stops
 * reminders, and this control renders absent as "on".
 *
 * Kept in its own file so the club.tsx change is a single mount point.
 */
import { useId, useState } from 'react';

export function RemindersOptInToggle({
  optedIn,
  onChange,
}: {
  optedIn: boolean;
  /** Persists the choice; resolves once saved (errors surface through the caller's toast). */
  onChange: (next: boolean) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const id = useId();
  return (
    <div
      style={{
        marginTop: 16,
        paddingTop: 12,
        borderTop: '1px solid var(--line)',
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
      }}
    >
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={optedIn}
        disabled={busy}
        onChange={async (e) => {
          setBusy(true);
          try {
            await onChange(e.target.checked);
          } finally {
            setBusy(false);
          }
        }}
        style={{ marginTop: 3 }}
      />
      <label htmlFor={id} style={{ fontSize: 13, lineHeight: 1.45 }}>
        <strong>Fixture reminders</strong>
        <span style={{ display: 'block', color: 'var(--muted-2)', fontSize: 12 }}>
          Email the chairperson ahead of match days, when your union has reminders switched on.
        </span>
      </label>
    </div>
  );
}

/**
 * Operator console: per-tenant notice settings — `TenantConfig.officialsContactLine` (closing
 * line of umpire/referee appointment notices) and `TenantConfig.scorecardCorrectionRecipients`
 * (extra addresses for captain's-report scorecard corrections, on top of the platform operators).
 *
 * Same shape as FixtureRemindersCard: local draft, dirty tracking, both keys saved in one write.
 * `PUT /platform/tenants/:slug` re-validates (line ≤120 chars; recipients lower-cased, deduped,
 * ≤10) — the client rules below mirror packages/api/src/notices-config.ts.
 */
import { useId, useState, type CSSProperties } from 'react';
import { Btn, Card } from './atoms';
import { ApiError, EMAIL_RE } from './api';
import type { TenantConfig } from './types';

type Toast = (m: string, t?: string) => void;

const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '8px 0 0' };

/** Mirrors the server's DEFAULT_OFFICIALS_CONTACT_LINE. */
export const DEFAULT_OFFICIALS_CONTACT_LINE = 'Medicoach - 066 344 6443';
export const OFFICIALS_CONTACT_LINE_MAX = 120;
export const SCORECARD_RECIPIENTS_MAX = 10;

/**
 * Parse the recipients textarea (one email per line; commas tolerated) into a lower-cased,
 * deduped list, or an error message. Matches validateScorecardCorrectionRecipients.
 */
export function parseRecipients(text: string): { recipients: string[] } | { error: string } {
  const recipients: string[] = [];
  for (const raw of text.split(/[\n,]+/)) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    if (!EMAIL_RE.test(email)) return { error: `"${raw.trim()}" is not a valid email` };
    if (!recipients.includes(email)) recipients.push(email);
  }
  if (recipients.length > SCORECARD_RECIPIENTS_MAX) {
    return { error: `At most ${SCORECARD_RECIPIENTS_MAX} recipients` };
  }
  return { recipients };
}

export function NoticesCard({
  config,
  save,
  toast,
}: {
  config: TenantConfig;
  save: (p: Partial<TenantConfig>) => Promise<TenantConfig>;
  toast: Toast;
}) {
  const initialLine = config.officialsContactLine ?? '';
  const initialRecipients = config.scorecardCorrectionRecipients ?? [];
  const [line, setLine] = useState(initialLine);
  const [recipientsText, setRecipientsText] = useState(initialRecipients.join('\n'));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // Set on any edit, so a value that normalises back to the saved one can say so.
  const [touched, setTouched] = useState(false);
  // Set by a successful save, cleared by the next edit: a note that outlasts the toast.
  const [justSaved, setJustSaved] = useState(false);
  const lineId = useId();
  const recipientsId = useId();

  const trimmedLine = line.trim();
  const lineError =
    trimmedLine.length > OFFICIALS_CONTACT_LINE_MAX
      ? `The contact line may be at most ${OFFICIALS_CONTACT_LINE_MAX} characters`
      : '';
  const parsed = parseRecipients(recipientsText);
  const recipientsError = 'error' in parsed ? parsed.error : '';
  const dirty =
    trimmedLine !== initialLine.trim() ||
    !('recipients' in parsed) ||
    JSON.stringify(parsed.recipients) !== JSON.stringify(initialRecipients);

  function edited() {
    setTouched(true);
    setJustSaved(false);
    setErr('');
  }

  async function saveIt() {
    setErr('');
    if (lineError) {
      setErr(lineError);
      return;
    }
    if ('error' in parsed) {
      setErr(parsed.error);
      return;
    }
    setBusy(true);
    try {
      await save({
        officialsContactLine: trimmedLine,
        scorecardCorrectionRecipients: parsed.recipients,
      });
      setLine(trimmedLine);
      setRecipientsText(parsed.recipients.join('\n'));
      setTouched(false);
      setJustSaved(true);
      toast('Notice settings saved');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Notices"
      sub="Who officials are told to contact, and who else hears about scorecard corrections."
    >
      <div className="field" style={{ marginBottom: 12 }}>
        <label className="field-label" htmlFor={lineId}>
          Umpire &amp; referee notice contact line
        </label>
        <input
          id={lineId}
          className="field-input"
          value={line}
          maxLength={OFFICIALS_CONTACT_LINE_MAX + 20}
          placeholder={DEFAULT_OFFICIALS_CONTACT_LINE}
          onChange={(e) => {
            edited();
            setLine(e.target.value);
          }}
        />
        {lineError && <div style={ERR}>{lineError}</div>}
        <p style={HINT}>
          Ends umpire and referee appointment notices: &ldquo;If you are unavailable for this
          appointment, please contact &hellip;&rdquo;. Leave blank for the default (
          {DEFAULT_OFFICIALS_CONTACT_LINE}). Scorer notices always keep the Medicoach default.
          WhatsApp notices use this line once the official_appointed_v2 template is approved in
          Meta; until then only email does.
        </p>
      </div>
      <div className="field" style={{ marginBottom: 12 }}>
        <label className="field-label" htmlFor={recipientsId}>
          Scorecard correction recipients
        </label>
        <textarea
          id={recipientsId}
          className="field-textarea"
          rows={4}
          value={recipientsText}
          placeholder={'one email per line'}
          onChange={(e) => {
            edited();
            setRecipientsText(e.target.value);
          }}
        />
        {recipientsError && <div style={ERR}>{recipientsError}</div>}
        <p style={HINT}>
          {`One email per line, up to ${SCORECARD_RECIPIENTS_MAX}.`} When a captain flags the
          scorecard as incorrect in the captain&apos;s report, these addresses get the correction
          email too, alongside the platform operators.
        </p>
      </div>
      {/* Validation errors already show inline under their field; this is for the rest. */}
      {err && err !== lineError && err !== recipientsError && (
        <div style={{ ...ERR, marginBottom: 8 }}>{err}</div>
      )}
      <Btn tone="teal" size="sm" onClick={saveIt} disabled={!dirty || busy}>
        {busy ? 'Saving…' : 'Save notice settings'}
      </Btn>
      {justSaved && !dirty && !busy && <p style={HINT}>Saved — these are the live settings.</p>}
      {!justSaved && touched && !dirty && !busy && (
        <p style={HINT}>These match the saved settings — nothing to save.</p>
      )}
    </Card>
  );
}

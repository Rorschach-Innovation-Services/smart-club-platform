/**
 * Medicoach sync failures in plain language (ADR 0016) — what the admin "Medicoach sync" page
 * and the SYNCLOG `message` say, next to the technical text kept for the "Details" toggle.
 *
 * The input is the technical message the puller (`MedicoachSyncError`) or the outbox flush
 * (`markPendingSyncFailed`) stored. Matching on those strings rather than on a stored code
 * also explains rows written before this module existed. Anything unrecognised is a
 * per-fixture message from medicoach's push answer (`results[].message`).
 *
 * Never echo a payload value here: the technical strings name field paths and statuses only
 * (a player ref must never reach a page — see the PII notes in puller.ts).
 */

/** "We'll try again" — the cron runs every 15 minutes (ADR 0016). */
const RETRY = "We'll try again automatically in 15 minutes.";

/** The plain-language text for one technical sync error; '' for none. */
export function explainSyncError(technical: string | null | undefined): string {
  const t = String(technical ?? '').trim();
  if (!t) return '';

  const unreachable = t.match(/^medicoach unreachable: (.*)$/);
  if (unreachable)
    return /timeout|abort/i.test(unreachable[1])
      ? `Couldn't reach medicoach — timed out. ${RETRY}`
      : `Couldn't reach medicoach — the connection failed. Check MedicoachSyncUrl if this keeps happening. ${RETRY}`;

  const http = t.match(/^medicoach answered HTTP (\d{3})$/);
  if (http) {
    const code = Number(http[1]);
    if (code === 401)
      return 'medicoach rejected our credentials — check the MedicoachSyncSecret matches on both sides.';
    if (code === 403)
      return 'medicoach refused access for this union — ask the medicoach team to check the sync is switched on for it.';
    if (code === 503)
      return `medicoach is unavailable right now (HTTP 503) — it may be down for maintenance, or its SmartClubSyncSecret isn't set. ${RETRY}`;
    if (code >= 500) return `medicoach had a server error (HTTP ${code}). ${RETRY}`;
    return `medicoach refused the request (HTTP ${code}) — check MedicoachSyncUrl points at medicoach's API.`;
  }

  if (t === 'medicoach answered with a body that is not JSON')
    return "medicoach sent back something that isn't sync data — check MedicoachSyncUrl points at medicoach's API, not its website.";
  if (t.startsWith('medicoach response failed the v1 contract'))
    return "medicoach's reply didn't match the agreed format (contract v1), so nothing in it was applied. One side has changed — tell the medicoach team.";
  if (t === 'medicoach answered for a different tenant')
    return 'medicoach answered for a different union — ask the medicoach team to check this union is set up on their side.';
  if (/^stopped after \d+ pages/.test(t))
    return 'There were more changes than one run fetches. The next run carries on automatically.';
  if (t === 'internal error')
    return `Something went wrong on our side while applying medicoach's changes. ${RETRY} If it keeps happening, report it.`;
  if (t === 'medicoach returned no result for this player')
    return `medicoach didn't confirm this player. ${RETRY}`;
  if (t.startsWith('the player does not fit the sync contract'))
    return "This player can't be sent: their registration is missing something the sync needs (see Details). Correct the registration and it is sent again.";
  if (t === 'medicoach returned no result for this fixture')
    return `medicoach didn't confirm this change. ${RETRY}`;
  if (t === 'the stored schedule does not fit the v1 contract')
    return "This change can't be sent: its schedule doesn't fit the sync format. Edit the fixture to correct it, or drop the change.";
  if (t === 'medicoach reported an error')
    return `medicoach couldn't apply this change and didn't say why. ${RETRY}`;
  if (t === 'push failed') return `The change couldn't be sent to medicoach. ${RETRY}`;
  return `medicoach couldn't apply this change: ${t.replace(/\.$/, '')}. ${RETRY}`;
}

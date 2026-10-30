/**
 * Validation for the operator-only notice keys on `TenantConfig`: `officialsContactLine` (the
 * closing line of umpire/referee appointment notices) and `scorecardCorrectionRecipients`
 * (extra addresses for captain's-report scorecard corrections). Pure (no repo, no Hono app) so
 * the operator route, the senders and the tests share one rule set.
 */
import { HttpError } from './auth.js';

import { EMAIL_RE } from './officials-contact.js';

export { DEFAULT_OFFICIALS_CONTACT_LINE, officialsContactLineFor } from './officials-contact.js';

export const OFFICIALS_CONTACT_LINE_MAX = 120;
export const SCORECARD_RECIPIENTS_MAX = 10;

/**
 * 400 unless `v` is a string of at most 120 characters once trimmed. Returns the trimmed value;
 * an empty string is stored as-is and reads as "use the default" (officialsContactLineFor
 * falls through on '').
 */
export function validateOfficialsContactLine(v: unknown): string {
  if (typeof v !== 'string') {
    throw new HttpError(400, 'officialsContactLine must be a string');
  }
  const line = v.trim();
  if (line.length > OFFICIALS_CONTACT_LINE_MAX) {
    throw new HttpError(
      400,
      `officialsContactLine may be at most ${OFFICIALS_CONTACT_LINE_MAX} characters`,
    );
  }
  return line;
}

/**
 * 400 unless `v` is an array of email strings (at most 10 after dedupe). Returns the addresses
 * trimmed, lower-cased and deduped in first-seen order; blank entries are dropped.
 */
export function validateScorecardCorrectionRecipients(v: unknown): string[] {
  if (!Array.isArray(v)) {
    throw new HttpError(400, 'scorecardCorrectionRecipients must be an array');
  }
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') {
      throw new HttpError(400, 'scorecardCorrectionRecipients entries must be strings');
    }
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    if (!EMAIL_RE.test(email)) {
      throw new HttpError(
        400,
        `scorecardCorrectionRecipients: "${raw.trim()}" is not a valid email`,
      );
    }
    if (!out.includes(email)) out.push(email);
  }
  if (out.length > SCORECARD_RECIPIENTS_MAX) {
    throw new HttpError(
      400,
      `scorecardCorrectionRecipients may have at most ${SCORECARD_RECIPIENTS_MAX} addresses`,
    );
  }
  return out;
}

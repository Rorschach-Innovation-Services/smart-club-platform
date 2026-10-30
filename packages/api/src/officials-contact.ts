/**
 * The appointment-notice contact line, dependency-free so the OfficialNotices cron can import
 * it without dragging auth.ts (aws-jwt-verify, hono) into its bundle. The operator-route
 * validators for the same config keys live in notices-config.ts, which re-exports these.
 */

/** The closing contact line when a tenant sets none — and ALWAYS for scorer notices. */
export const DEFAULT_OFFICIALS_CONTACT_LINE = 'Medicoach - 066 344 6443';

/** The one email-format check shared by notices-config and notify/operator-emails. */
export const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;

/** The contact line for one appointment notice: scorers always get the default. */
export function officialsContactLineFor(
  cfg: { officialsContactLine?: string },
  role: 'umpire' | 'referee' | 'scorer',
): string {
  if (role === 'scorer') return DEFAULT_OFFICIALS_CONTACT_LINE;
  return cfg.officialsContactLine?.trim() || DEFAULT_OFFICIALS_CONTACT_LINE;
}

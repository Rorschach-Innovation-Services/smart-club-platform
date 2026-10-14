/**
 * Whether a clearance can carry a transfer certificate. Dependency-free (no repo import) so
 * CLIs and pure modules can share it without loading the table client at import time;
 * issue.ts re-exports it for its existing callers.
 */
import type { PlayerClearance } from '../types.js';

export const isCertifiable = (c: Pick<PlayerClearance, 'status'>): boolean =>
  c.status === 'approved' || c.status === 'admin-override';

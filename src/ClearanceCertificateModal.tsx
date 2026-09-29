/* ─── Clearance transfer certificate viewer — shared by club portal + admin ─── */

import { DocPreviewModal } from './DocPreviewModal';
import { ApiError } from './api';
import { formatStampDay } from './dates';
import type { PlayerClearance } from './types';

/**
 * Whether to offer "View certificate": only a completed transfer has one, and never an override
 * where the admin declined it. A certifiable clearance WITHOUT certificateMeta still qualifies —
 * the view-url route lazily issues it (pre-feature approvals, or an approve-time issue failure).
 */
export const clearanceHasCertificateStatus = (
  c: Pick<PlayerClearance, 'status' | 'certificateDeclined' | 'certificateMeta'>,
) =>
  (c.status === 'approved' || c.status === 'admin-override') &&
  !(c.certificateDeclined && !c.certificateMeta);

/**
 * Inline PDF preview of a clearance's transfer certificate. `fetchUrl` mints the presigned
 * GET (club or admin route). A 410 from that route means the certificate was revoked — show
 * that plainly instead of the generic "preview unavailable" state.
 */
export function ClearanceCertificateModal({
  clearance,
  fetchUrl,
  onClose,
}: {
  clearance: PlayerClearance;
  fetchUrl: () => Promise<string>;
  onClose: () => void;
}) {
  const serial = clearance.certificateMeta?.serial;
  return (
    <DocPreviewModal
      docName={`${clearance.fromClubName} → ${clearance.toClubName}`}
      eyebrow={`Transfer certificate · ${clearance.playerName}`}
      caption={serial ? `Certificate ${serial}` : 'Transfer certificate'}
      meta={{ contentType: 'application/pdf' }}
      fetchUrl={fetchUrl}
      onClose={onClose}
      onFetchError={(err) => {
        if (err instanceof ApiError && err.status === 410) {
          const revokedAt =
            (err.details?.revokedAt as string | undefined) || clearance.certificateMeta?.revokedAt;
          return (
            <div style={{ textAlign: 'center', padding: '48px 8px', color: 'var(--muted)' }}>
              <div style={{ fontWeight: 600, color: 'var(--coral)', marginBottom: 4 }}>
                Certificate revoked
              </div>
              This transfer certificate was revoked by the Union office
              {revokedAt ? ` on ${formatStampDay(revokedAt)}` : ''} and is no longer valid.
            </div>
          );
        }
        if (err instanceof ApiError && err.status === 409) {
          return (
            <div style={{ textAlign: 'center', padding: '48px 8px', color: 'var(--muted)' }}>
              <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
                No certificate
              </div>
              A certificate is only issued once the clearance is approved.
            </div>
          );
        }
        return null;
      }}
    />
  );
}

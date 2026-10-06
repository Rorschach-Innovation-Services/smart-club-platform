/* ─── "These fixtures will lose their medicoach link" ───
 *
 * On a medicoach-synced union, regenerating a stage or adopting a newer structure (rebase)
 * whose RELEASED series medicoach mirrors re-mints fixtures, so medicoach's copies lose their
 * link (ADR 0016). The server refuses with 409 `sync_resync_required` listing them; the
 * console asks here — naming each fixture by its teams and date — and only a confirm resends
 * the request with `allowResync: true`.
 */
import { ApiError } from './api';
import { Btn, Modal } from './atoms';

export interface ResyncFixture {
  ref: string;
  seriesId?: string;
  seriesName?: string;
  fixtureId?: string;
  home?: string;
  away?: string;
  date?: string;
  time?: string;
}

export function isResyncRequired(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 409 && err.code === 'sync_resync_required';
}

/** The fixtures a refusal names (refs only from an older server). */
export function resyncFixtures(err: ApiError): ResyncFixture[] {
  const listed = err.details?.orphaned;
  if (Array.isArray(listed)) return listed as ResyncFixture[];
  const refs = err.details?.orphanedRefs;
  return Array.isArray(refs) ? refs.map((ref) => ({ ref: String(ref) })) : [];
}

export function ResyncDialog({
  error,
  action,
  onConfirm,
  onCancel,
}: {
  error: ApiError;
  action: 'regenerate' | 'rebase';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const fixtures = resyncFixtures(error);
  const verb = action === 'regenerate' ? 'Regenerating this stage' : 'Applying the new structure';
  return (
    <Modal
      eyebrow="Fixtures · Medicoach sync"
      title={`${fixtures.length} fixture${fixtures.length === 1 ? '' : 's'} will lose their medicoach link`}
      maxWidth={620}
      dismissable={false}
      onClose={onCancel}
      footer={
        <div className="mcs-card-actions" style={{ justifyContent: 'flex-end', margin: 0 }}>
          <Btn tone="outline" size="sm" autoFocus onClick={onCancel}>
            Cancel
          </Btn>
          <Btn tone="ink" size="sm" onClick={onConfirm}>
            {action === 'regenerate' ? 'Regenerate anyway' : 'Apply anyway'}
          </Btn>
        </div>
      }
    >
      <p style={{ fontSize: 13, lineHeight: 1.6, margin: '0 0 10px' }}>
        These released fixtures are mirrored in medicoach&apos;s match centre. {verb} replaces them,
        so medicoach&apos;s copies stop updating from smart club — no reschedules, and their results
        no longer come back here.
      </p>
      <p style={{ fontSize: 13, lineHeight: 1.6, margin: '0 0 12px' }}>
        <strong>Afterwards, ask your operator for a bundle top-up</strong> so medicoach gets the new
        fixtures and links them again.
      </p>
      <div className="resync-list">
        <table className="mcs-compare">
          <thead>
            <tr>
              <th scope="col">Fixture</th>
              <th scope="col">Date</th>
              <th scope="col">Series</th>
            </tr>
          </thead>
          <tbody>
            {fixtures.map((f) => (
              <tr key={f.ref}>
                <td>{f.home || f.away ? `${f.home ?? '?'} v ${f.away ?? '?'}` : f.ref}</td>
                <td>
                  {f.date ?? '—'}
                  {f.time ? ` ${f.time}` : ''}
                </td>
                <td>{f.seriesName ?? f.seriesId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

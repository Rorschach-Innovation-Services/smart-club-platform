/**
 * Admin "Request ID document" confirm + results modal (player register). Before sending it
 * shows how many selected players are reachable and how many will be skipped (minors are never
 * contacted directly; players with no email or cell have no channel). After sending it lists
 * each player's outcome. One idempotency key per open modal, so a double-click or a retried
 * POST never sends twice.
 */
import { useMemo, useState } from 'react';
import { Btn, Modal, ModalCancelBtn, Pill } from './atoms';
import { sendDocRequests, ApiError } from './api';
import type { DocRequestSendResult, DocRequestSendStatus } from './types';

export interface DocRequestTarget {
  clubId: string;
  naturalKey: string;
  firstName?: string;
  lastName?: string;
  isMinor?: boolean;
  email?: string;
  cell?: string;
}

const STATUS_LABEL: Record<DocRequestSendStatus, { text: string; tone: string }> = {
  sent: { text: 'Sent', tone: 'teal' },
  failed: { text: 'Failed', tone: 'coral' },
  skipped_minor: { text: 'Skipped — minor', tone: 'gold' },
  skipped_no_contact: { text: 'Skipped — no contact details', tone: 'gold' },
  skipped_whatsapp_unavailable: {
    text: 'Skipped — cell only, WhatsApp unavailable',
    tone: 'gold',
  },
  skipped_not_found: { text: 'Skipped — player not found', tone: 'gold' },
};

/** Client-side preview of the server's skip rule (the server re-checks every player). */
export function docRequestPreview(targets: DocRequestTarget[]) {
  let minors = 0;
  let noContact = 0;
  for (const p of targets) {
    if (p.isMinor) minors++;
    else if (!(p.email ?? '').trim() && !(p.cell ?? '').trim()) noContact++;
  }
  return { reachable: targets.length - minors - noContact, minors, noContact };
}

const newIdempotencyKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

export function DocRequestModal({
  targets,
  docName = 'ID document',
  onClose,
  onSent,
}: {
  targets: DocRequestTarget[];
  docName?: string;
  onClose: () => void;
  /** Called once the send returned (refresh the "requested" indicators). */
  onSent: () => void;
}) {
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<DocRequestSendResult[] | null>(null);
  const preview = useMemo(() => docRequestPreview(targets), [targets]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await sendDocRequests({
        players: targets.map((t) => ({ clubId: t.clubId, naturalKey: t.naturalKey })),
        docKey: 'idDoc',
        idempotencyKey,
      });
      setResults(res.results);
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The request could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const sentCount = results?.filter((r) => r.status === 'sent').length ?? 0;

  return (
    <Modal
      eyebrow="Players"
      title={`Request ${docName}`}
      onClose={onClose}
      maxWidth={560}
      footer={
        results ? (
          <Btn tone="teal" onClick={onClose}>
            Done
          </Btn>
        ) : (
          <>
            <ModalCancelBtn tone="ghost">Cancel</ModalCancelBtn>
            <Btn tone="teal" disabled={busy || preview.reachable === 0} onClick={() => void send()}>
              {busy
                ? 'Sending…'
                : `Send to ${preview.reachable} player${preview.reachable === 1 ? '' : 's'}`}
            </Btn>
          </>
        )
      }
    >
      {results ? (
        <div className="doc-request-results">
          <p style={{ marginTop: 0 }}>
            {sentCount} of {results.length} player{results.length === 1 ? '' : 's'} sent a link.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {results.map((r, i) => (
              <li
                key={`${r.clubId}-${i}`}
                className="doc-request-result"
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '6px 0',
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <span>{r.displayName}</span>
                <Pill tone={STATUS_LABEL[r.status]?.tone ?? 'gold'}>
                  {STATUS_LABEL[r.status]?.text ?? r.status}
                </Pill>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div>
          <p style={{ marginTop: 0 }}>
            Each reachable player gets an email and WhatsApp with a personal link to upload their{' '}
            {docName}. It lands on their record as if uploaded here. The link expires in 14 days.
          </p>
          <ul className="doc-request-preview" style={{ paddingLeft: 18 }}>
            <li>
              <strong>{preview.reachable}</strong> will be sent a link
            </li>
            {preview.noContact > 0 && (
              <li>
                <strong>{preview.noContact}</strong> will be skipped — no email or cell on file
              </li>
            )}
            {preview.minors > 0 && (
              <li>
                <strong>{preview.minors}</strong> will be skipped — minors are not contacted
                directly
              </li>
            )}
          </ul>
          {error && (
            <div className="rp-validation" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

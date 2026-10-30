/* ─── Union office: pre-match squad requests ───
 *
 * Every captain squad link the D-1 morning opener sent: status (pending / submitted / void), who
 * it went to, whether the notice reached them (the captain's-report notice chips), and what
 * medicoach did with the submitted squad (push outcome). Names only — the API never serves a
 * natural key or contact.
 *
 * Two row actions: Resend (a PENDING, unexpired request — a fresh link goes to the current
 * recipient and older links stop working) and Void (anything not already void, after a
 * confirm; a submitted squad is also withdrawn from medicoach). A request also voids itself
 * when its fixture is cancelled or moved. Copy link (same rule as Resend) puts the current
 * recipient's link on the clipboard for sharing by hand; it dies on the next Resend.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Btn, Modal, ModalCancelBtn, Pill } from './atoms';
import { chipFor } from './AdminCaptainsReports';
import { fmtDate } from './CaptainsReport';
import { squadMatchLine } from './SquadSelection';
import {
  ApiError,
  getSquadRequestLink,
  getSquadRequests,
  resendSquadRequest,
  voidSquadRequest,
} from './api';
import { useCopyLink } from './copyLink';
import { qk } from './query';
import type { CaptainsReportDelivery, SquadRequestView } from './types';

/** Stored void reasons in plain words (unknown ones shown as stored). */
const VOID_REASON_LABELS: Record<string, string> = {
  expired: 'Expired — never submitted',
  'fixture changed': 'Fixture changed',
  'voided by admin': 'Voided by admin',
};
const voidReasonLabel = (reason: string) => VOID_REASON_LABELS[reason] ?? reason;

type StatusFilter = 'all' | 'pending' | 'submitted' | 'void';

const STATUS_CHIPS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'void', label: 'Void' },
];

const STATUS_PILL: Record<SquadRequestView['status'], { label: string; tone: string }> = {
  pending: { label: 'Pending', tone: 'gold' },
  submitted: { label: 'Submitted', tone: 'teal' },
  void: { label: 'Void', tone: 'muted' },
};

const PUSH_REASON: Record<NonNullable<SquadRequestView['pushOutcome']>['reason'] & string, string> =
  {
    stale: 'Medicoach had a newer squad',
    'fixture-unmapped': 'Fixture not in medicoach yet',
    'scoring-started': 'Scoring had already started',
    'gave-up': 'Gave up retrying',
  };

/** The latest delivery per channel. */
function latestByChannel(r: SquadRequestView): CaptainsReportDelivery[] {
  const out = new Map<string, CaptainsReportDelivery>();
  for (const d of r.deliveries ?? []) {
    const prev = out.get(d.channel);
    if (!prev || d.at >= prev.at) out.set(d.channel, d);
  }
  return [...out.values()].sort((a, b) => a.channel.localeCompare(b.channel));
}

export function pushLine(r: SquadRequestView): { label: string; tone: string } {
  const o = r.pushOutcome;
  if (!o)
    return r.status === 'submitted'
      ? { label: 'Not sent yet', tone: 'muted' }
      : { label: '—', tone: 'muted' };
  if (o.applied) {
    const parts = [
      o.mappedPlayers != null ? `${o.mappedPlayers} linked` : '',
      o.unmappedAsGuest ? `${o.unmappedAsGuest} unlinked → guest` : '',
      o.guests ? `${o.guests} guests` : '',
    ].filter(Boolean);
    return { label: `In medicoach${parts.length ? ` (${parts.join(', ')})` : ''}`, tone: 'teal' };
  }
  return { label: o.reason ? PUSH_REASON[o.reason] : 'Not applied', tone: 'coral' };
}

/** Resend applies to a pending request whose link has not expired yet. */
export function canResend(r: SquadRequestView, nowMs = Date.now()): boolean {
  return r.status === 'pending' && Date.parse(r.linkExpiresAt) > nowMs;
}

/** Why Copy link is disabled (null = it is not): the same checks as `canResend`. */
export function copyLinkBlockedReason(r: SquadRequestView, nowMs = Date.now()): string | null {
  if (r.status === 'void') return 'Unavailable: this request is void';
  if (r.status !== 'pending') return 'Unavailable: the squad was already submitted';
  if (!(Date.parse(r.linkExpiresAt) > nowMs)) return 'Unavailable: the link has expired';
  return null;
}

export function AdminSquadRequestsTable({ requests }: { requests: SquadRequestView[] }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [voiding, setVoiding] = useState<SquadRequestView | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const errText = (err: unknown, fallback: string) =>
    err instanceof ApiError ? err.message : fallback;
  const resend = useMutation({
    mutationFn: (id: string) => resendSquadRequest(id),
    onSuccess: (res) => {
      setMessage({
        text:
          res.notice === 'sent'
            ? `Sent again to ${res.request.recipient.name || 'the recipient'}.`
            : 'A fresh link was made, but the notice did not go out — check the contact details.',
        error: res.notice !== 'sent',
      });
      void qc.invalidateQueries({ queryKey: qk.squadRequests() });
    },
    onError: (err) => setMessage({ text: errText(err, 'Could not resend'), error: true }),
  });
  const voidIt = useMutation({
    mutationFn: (id: string) => voidSquadRequest(id),
    onSuccess: () => {
      setVoiding(null);
      setMessage({ text: 'Squad request voided.' });
      void qc.invalidateQueries({ queryKey: qk.squadRequests() });
    },
    onError: (err) => {
      setVoiding(null);
      setMessage({ text: errText(err, 'Could not void'), error: true });
    },
  });
  const busy = resend.isPending || voidIt.isPending;
  const copyLink = useCopyLink(
    getSquadRequestLink,
    'It stops working if the request is resent or voided.',
  );
  const list = useMemo(
    () => requests.filter((r) => status === 'all' || r.status === status),
    [requests, status],
  );
  return (
    <>
      <div className="cr-filters">
        <div className="cr-chips" role="group" aria-label="Status">
          {STATUS_CHIPS.map((c) => {
            const n = requests.filter((r) => c.key === 'all' || r.status === c.key).length;
            return (
              <button
                key={c.key}
                type="button"
                className={`cr-chip ${status === c.key ? 'on' : ''}`}
                aria-pressed={status === c.key}
                onClick={() => setStatus(c.key)}
              >
                {c.label} <span className="cr-chip-n">{n}</span>
              </button>
            );
          })}
        </div>
      </div>
      {message && (
        <div
          className={message.error ? 'rp-validation' : 'cr-section-sub'}
          role={message.error ? 'alert' : 'status'}
        >
          {message.text}
        </div>
      )}
      {!list.length ? (
        <div className="cr-section-sub" style={{ padding: '24px 0' }}>
          {requests.length ? 'No squad requests match this filter.' : 'No squad requests yet.'}
        </div>
      ) : (
        <div className="tbl-w" style={{ marginTop: 14 }}>
          <table className="tbl cr-admin-table">
            <thead>
              <tr>
                <th>Match</th>
                <th>Sent to</th>
                <th>Notice</th>
                <th>Status</th>
                <th>Squad</th>
                <th>Medicoach</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const pill = STATUS_PILL[r.status];
                const push = pushLine(r);
                const n = (r.selection?.players.length ?? 0) + (r.selection?.guests.length ?? 0);
                return (
                  <tr key={r.id}>
                    <td data-label="Match">
                      <div style={{ fontWeight: 700 }}>{squadMatchLine(r)}</div>
                      <div className="ump-sub">
                        {fmtDate(r.matchDate)} · {r.competition}
                      </div>
                    </td>
                    <td data-label="Sent to">
                      {r.recipient.name || '—'}
                      <div className="ump-sub">
                        {r.recipient.kind === 'captain' ? 'Captain' : 'Chair'}
                        {r.recipient.forwardedBy
                          ? ` · sent on by ${r.recipient.forwardedBy.name}`
                          : ''}
                      </div>
                    </td>
                    <td data-label="Notice">
                      {latestByChannel(r).length ? (
                        latestByChannel(r).map((d) => {
                          const c = chipFor(d);
                          return (
                            <Pill key={d.channel} tone={c.tone}>
                              {c.label}
                            </Pill>
                          );
                        })
                      ) : (
                        <span className="ump-none">No notice recorded</span>
                      )}
                    </td>
                    <td data-label="Status">
                      <Pill tone={pill.tone}>{pill.label}</Pill>
                      {r.status === 'void' && r.voidReason && (
                        <div className="ump-sub">{voidReasonLabel(r.voidReason)}</div>
                      )}
                    </td>
                    <td data-label="Squad">
                      {n ? `${n} named` : '—'}
                      {r.selection?.captainName && (
                        <div className="ump-sub">Captain: {r.selection.captainName}</div>
                      )}
                    </td>
                    <td data-label="Medicoach">
                      <Pill tone={push.tone}>{push.label}</Pill>
                    </td>
                    <td data-label="Actions">
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <Btn
                          size="sm"
                          disabled={busy || !canResend(r)}
                          aria-label={`Resend — ${squadMatchLine(r)}`}
                          onClick={() => resend.mutate(r.id)}
                        >
                          Resend
                        </Btn>
                        <Btn
                          size="sm"
                          disabled={busy || copyLink.busyId === r.id || !canResend(r)}
                          aria-label={`Copy link — ${squadMatchLine(r)}`}
                          title={
                            copyLinkBlockedReason(r) ??
                            'Copy the current link to share by hand (a resend replaces it)'
                          }
                          onClick={() => copyLink.copy(r.id)}
                        >
                          Copy link
                        </Btn>
                        <Btn
                          size="sm"
                          disabled={busy || r.status === 'void'}
                          aria-label={`Void — ${squadMatchLine(r)}`}
                          onClick={() => setVoiding(r)}
                        >
                          Void
                        </Btn>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {copyLink.node}
      {voiding && (
        <Modal
          eyebrow="Squad requests"
          title="Void this squad request?"
          maxWidth={520}
          onClose={() => setVoiding(null)}
          footer={
            <>
              <ModalCancelBtn tone="outline">Cancel</ModalCancelBtn>
              <Btn tone="ink" disabled={voidIt.isPending} onClick={() => voidIt.mutate(voiding.id)}>
                Yes, void
              </Btn>
            </>
          }
        >
          <p className="ph-desc">
            {squadMatchLine(voiding)} ({fmtDate(voiding.matchDate)}): the link stops working
            {voiding.status === 'submitted'
              ? ', and the submitted squad is withdrawn from medicoach.'
              : '.'}{' '}
            This cannot be undone.
          </p>
        </Modal>
      )}
    </>
  );
}

export function AdminSquadRequestsView() {
  const query = useQuery({ queryKey: qk.squadRequests(), queryFn: () => getSquadRequests() });
  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Union office / Squad requests</div>
          <h1 className="ph-title">
            Squad <em>requests</em>
          </h1>
          <p className="ph-desc">
            The evening before a match each side's captain (or chair) gets a link to name the squad.
            Submitted squads go to medicoach as the scorer's starting line-up; the link stays
            editable until the end of match day.
          </p>
        </div>
      </div>
      {query.isLoading ? (
        <div className="cr-section-sub">Loading…</div>
      ) : query.error ? (
        <div className="rp-validation" role="alert">
          Could not load the squad requests.
        </div>
      ) : (
        <AdminSquadRequestsTable requests={query.data ?? []} />
      )}
    </div>
  );
}

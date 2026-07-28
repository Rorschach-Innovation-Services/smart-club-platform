/* ─── Player detail — read-only modal shared by the admin + club rosters ─── */

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, Btn, useEscapeClose, playerStatusPill } from './atoms';
import { getPlayerIdDocViewUrl } from './api';
import type { PlayerRegistration } from './types';
import { formatDayYear, formatStampDay } from './dates';

/** Single human-readable role label, mirroring the admin/club rosters. */
function roleLabel(p: PlayerRegistration): string {
  const bits: string[] = [];
  if (p.isWk) bits.push('WK');
  if (p.isAllRounder) bits.push('All-rounder');
  if (!p.isAllRounder) {
    if (p.bowlerType) bits.push(p.bowlerType);
    else if (!p.isWk) bits.push('Batter');
  } else if (p.bowlerType) {
    bits.push(p.bowlerType);
  }
  return bits.join(' · ') || '—';
}

/**
 * A DATE-ONLY value (a DOB). Rendered as UTC so the calendar day can't shift with the
 * host's zone — west of Greenwich a local read shows the previous day.
 */
function fmtDate(iso?: string): string {
  return formatDayYear(iso) || '—';
}

/**
 * An INSTANT (`2026-06-04T12:34:56Z` — a registration or a clearance decision).
 * Rendered in local time, which is the day it happened for the person reading it.
 */
function fmtStamp(iso?: string): string {
  return formatStampDay(iso) || '—';
}

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      color: 'var(--muted-2)',
      margin: '14px 0 6px',
      fontWeight: 700,
    }}
  >
    {children}
  </div>
);

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      gap: 12,
      fontSize: 12.5,
      padding: '4px 0',
      borderBottom: '1px solid var(--line2)',
    }}
  >
    <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{label}</span>
    <span
      style={{
        color: 'var(--ink)',
        fontWeight: 600,
        textAlign: 'right',
        wordBreak: 'break-word',
        minWidth: 0,
      }}
    >
      {value == null || value === '' ? '—' : value}
    </span>
  </div>
);

/**
 * Read-only view of a single player, opened by clicking a roster row on either the admin
 * or club players list. Every field is already in hand from the list fetch — the only
 * network call is the on-demand presign for the ID document. `teamLabel` is the resolved
 * league name (the caller owns the catalogue); `clubName` is the player's current club.
 */
export function PlayerDetailModal({
  player,
  clubId,
  clubName,
  teamLabel,
  onClose,
}: {
  player: PlayerRegistration;
  clubId: string;
  clubName?: string;
  teamLabel?: string;
  onClose: () => void;
}) {
  useEscapeClose(onClose);
  const [docBusy, setDocBusy] = useState(false);
  const [docError, setDocError] = useState('');

  async function viewIdDoc() {
    if (!clubId || !player.naturalKey) return;
    setDocBusy(true);
    setDocError('');
    try {
      const { viewUrl } = await getPlayerIdDocViewUrl(clubId, player.naturalKey);
      window.open(viewUrl, '_blank', 'noopener,noreferrer');
    } catch {
      setDocError('Could not open the ID document. Please try again.');
    } finally {
      setDocBusy(false);
    }
  }

  const fullName = `${player.firstName ?? ''} ${player.lastName ?? ''}`.trim() || '—';

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal" style={{ maxWidth: 560, width: '92vw' }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Player{clubName ? ` · ${clubName}` : ''}</div>
            <div className="task-modal-head-title">{fullName}</div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <div style={{ marginBottom: 4 }}>{playerStatusPill(player.status)}</div>

          <SectionTitle>Identity</SectionTitle>
          <Row
            label="ID type"
            value={player.idType === 'passport' ? 'Passport / visa' : 'RSA ID'}
          />
          <Row label="ID number" value={player.idNumber} />
          <Row label="Date of birth" value={fmtDate(player.dob)} />
          <Row label="Nationality" value={player.nationality} />
          <Row label="Race" value={player.race} />
          <Row label="Gender" value={player.gender} />
          {player.isMinor && <Row label="Guardian" value={player.guardianName} />}

          <SectionTitle>Contact</SectionTitle>
          <Row label="Cell" value={player.cell} />
          <Row label="Email" value={player.email} />
          <Row label="Postal address" value={player.postalAddress} />
          <Row label="Postal code" value={player.postalCode} />

          <SectionTitle>Cricket profile</SectionTitle>
          <Row label="Team" value={teamLabel || player.team} />
          <Row label="Role" value={roleLabel(player)} />
          <Row
            label="Batting"
            value={[player.battingHand, player.battingType].filter(Boolean).join(' · ')}
          />
          <Row
            label="Bowling"
            value={[player.bowlingHand, player.bowlerType].filter(Boolean).join(' · ')}
          />

          <SectionTitle>Registration</SectionTitle>
          <Row label="Current club" value={clubName} />
          <Row
            label="Previous club"
            value={player.lastClub === '—' ? 'None (first registration)' : player.lastClub}
          />
          <Row label="District" value={player.district} />
          <Row
            label="Registered via"
            value={player.registeredVia === 'portal' ? 'Portal' : 'Link'}
          />
          <Row label="Registered on" value={fmtStamp(player.createdAt)} />
          {player.status === 'clearance-rejected' && (
            <div
              style={{
                marginTop: 10,
                padding: '8px 10px',
                borderRadius: 8,
                background: 'rgba(224, 82, 82, 0.10)',
                border: '1px solid rgba(224, 82, 82, 0.35)',
                fontSize: 12,
                color: 'var(--ink)',
              }}
            >
              <strong style={{ color: 'var(--coral, #c0392b)' }}>Clearance rejected</strong>
              {player.lastClub && player.lastClub !== '—' ? ` by ${player.lastClub}` : ''}
              {player.clearanceRejectedAt ? ` · ${fmtStamp(player.clearanceRejectedAt)}` : ''}
              {player.clearanceRejectedReason ? ` — “${player.clearanceRejectedReason}”` : ''}
            </div>
          )}

          {player.idDocMeta?.objectKey && (
            <>
              <SectionTitle>ID document</SectionTitle>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 4 }}>
                <Btn
                  tone="outline"
                  size="sm"
                  icon={Icon.Eye}
                  onClick={viewIdDoc}
                  disabled={docBusy}
                >
                  {docBusy ? 'Opening…' : 'View ID document'}
                </Btn>
                {player.previousIdDocMeta?.objectKey && (
                  <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    Vetted doc from previous club on record
                  </span>
                )}
              </div>
              {docError && (
                <div style={{ fontSize: 11.5, color: 'var(--danger, #c0392b)', marginTop: 6 }}>
                  {docError}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, Btn } from './atoms';
import { currentSeasonLabel } from './data';

/* ─── RegLinkModal — shared player-registration link modal ───
   Used on BOTH the admin club-detail page and the club portal. A per-club link
   is generated once (by admin or chair); the same token-based public link is
   what players open to self-register. Shows the link plus copy / email / WhatsApp
   sharing and a summary of what the player will be asked for. */
export function RegLinkModal({ club, onClose, onRegenerate, toast }) {
  const baseUrl = (typeof window !== 'undefined' && window.location.origin) || '';
  const linkRecord = club.playerRegLink;
  const url = linkRecord ? `${baseUrl}/register/${club.id}?t=${linkRecord.token}` : '';
  const season = currentSeasonLabel();
  const [copied, setCopied] = useState(false);

  function doCopy() {
    if (!url) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
        toast && toast('Registration link copied to clipboard');
      });
    } else {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        toast && toast('Registration link copied');
      } catch {}
      ta.remove();
    }
    setTimeout(() => setCopied(false), 2200);
  }

  function emailBody() {
    return `Hi ${club.chair || 'team'},\n\nPlease share this player-registration link with your members so they can register directly into ${club.name} for the ${season} season:\n\n${url}\n\nThe link is unique to your club — each registration flows straight into the Dolphins Pipeline cohort.\n\nThe Dolphins office`;
  }
  function whatsappText() {
    return `${club.name} player registration · ${season} season: ${url}`;
  }

  const createdLabel = linkRecord
    ? new Date(linkRecord.createdAt).toLocaleString('en-ZA', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  // Normalise the chair's cell into wa.me format (digits only, 0→27)
  function waNumber(cell) {
    const digits = (cell || '').replace(/\D+/g, '');
    if (!digits) return '';
    if (digits.startsWith('0')) return '27' + digits.slice(1);
    if (digits.startsWith('27')) return digits;
    return digits;
  }
  const chairEmailValue = club.exco?.chair?.email || '';
  const chairCellValue = club.exco?.chair?.cell || '';
  const wa = waNumber(chairCellValue);
  const mailtoUrl = `mailto:${chairEmailValue}?subject=${encodeURIComponent(`${club.name} · Player Registration Link`)}&body=${encodeURIComponent(emailBody())}`;
  const waUrl = wa
    ? `https://wa.me/${wa}?text=${encodeURIComponent(whatsappText())}`
    : `https://wa.me/?text=${encodeURIComponent(whatsappText())}`;
  function sendBoth() {
    try {
      window.open(waUrl, '_blank', 'noopener,noreferrer');
    } catch {}
    try {
      window.location.href = mailtoUrl;
    } catch {}
    toast && toast('Player link sent via email & WhatsApp');
  }

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal narrow" style={{ maxWidth: 620 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Phase 03 · Player Registration</div>
            <div className="task-modal-head-title">
              Player <em>registration link</em> · {club.name}
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          {!linkRecord ? (
            <div style={{ textAlign: 'center', padding: '32px 20px' }}>
              <div
                style={{
                  width: 54,
                  height: 54,
                  borderRadius: '50%',
                  margin: '0 auto 14px',
                  background: 'rgba(15,143,74,0.12)',
                  color: 'var(--teal-deep)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon.Form />
              </div>
              <div
                style={{
                  fontFamily: "'Montserrat',sans-serif",
                  fontSize: 14,
                  fontWeight: 700,
                  marginBottom: 6,
                }}
              >
                No registration link yet
              </div>
              <p
                style={{
                  fontSize: 12.5,
                  color: 'var(--muted)',
                  maxWidth: 420,
                  margin: '0 auto 18px',
                }}
              >
                Generate a unique link for{' '}
                <strong style={{ color: 'var(--ink)' }}>{club.name}</strong>. Players opening it
                will register directly into the cohort — their data flows into club statistics and
                roster metrics automatically.
              </p>
              <Btn tone="teal" icon={Icon.Plus} onClick={onRegenerate}>
                Generate link
              </Btn>
            </div>
          ) : (
            <>
              <div
                style={{
                  background: 'var(--paper)',
                  borderRadius: 10,
                  padding: '14px 16px',
                  marginBottom: 14,
                  border: '1px solid var(--line)',
                }}
              >
                <div
                  style={{
                    fontSize: 10.5,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: 'var(--muted-2)',
                    fontFamily: "'Montserrat',sans-serif",
                    fontWeight: 700,
                    marginBottom: 6,
                  }}
                >
                  Registration link
                </div>
                <div
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 13,
                    color: 'var(--ink)',
                    wordBreak: 'break-all',
                    lineHeight: 1.45,
                    padding: '10px 12px',
                    background: 'var(--white)',
                    borderRadius: 8,
                    border: '1px solid var(--line)',
                  }}
                >
                  {url}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                  Created {createdLabel} · token <code>{linkRecord.token}</code>
                </div>
              </div>

              {/* Primary one-click send: fires email + WhatsApp together */}
              <Btn
                tone="teal"
                icon={Icon.Mail}
                onClick={sendBoth}
                style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
              >
                Send via Email + WhatsApp
              </Btn>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 8,
                  marginBottom: 14,
                }}
              >
                <Btn
                  tone={copied ? 'teal' : 'outline'}
                  icon={copied ? Icon.Check : Icon.Form}
                  onClick={doCopy}
                >
                  {copied ? 'Copied' : 'Copy link'}
                </Btn>
                <a
                  href={mailtoUrl}
                  className="btn btn-outline"
                  style={{
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  <Icon.Mail /> Email only
                </a>
                <a
                  href={waUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-outline"
                  style={{
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  <Icon.Arrow /> WhatsApp only
                </a>
              </div>

              <div
                style={{
                  background: 'var(--paper)',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  padding: '12px 14px',
                  marginBottom: 14,
                }}
              >
                <div
                  style={{
                    fontSize: 10.5,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: 'var(--muted-2)',
                    fontFamily: "'Montserrat',sans-serif",
                    fontWeight: 700,
                    marginBottom: 6,
                  }}
                >
                  What the player completes
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink)', lineHeight: 1.5 }}>
                  Name, ID number, contact details, playing role and an ID-document upload. Every
                  submission flows straight into this club's roster — no manual capture.
                </div>
              </div>

              <div
                className="row"
                style={{
                  justifyContent: 'space-between',
                  gap: 10,
                  paddingTop: 6,
                  borderTop: '1px solid var(--line)',
                }}
              >
                <Btn tone="ghost" onClick={onRegenerate}>
                  ↻ Regenerate (invalidates old link)
                </Btn>
                <Btn tone="ink" onClick={onClose}>
                  Done
                </Btn>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

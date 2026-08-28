import { useState, useId } from 'react';
import { createPortal } from 'react-dom';
import { Icon, Btn, useEscapeClose } from './atoms';
import type { WithheldField } from './types';

/* ─── ReleaseDialog — publish a series' schedule to clubs, optionally withholding
   venues and/or start times (ADR 0011) ───

   Release is where withholding is CHOSEN — the server writes the mask only on the
   false→true transition. Both fields default to shown; the admin ticks a box to hold
   one back until the union confirms it, then reveals it later (per field, whole series).
   Nothing is emailed or WhatsApped on release — each club chooses when to share
   fixtures with its players — so the copy here says so plainly. */

export function ReleaseDialog({
  seriesName,
  clubCount,
  onConfirm,
  onClose,
}: {
  seriesName: string;
  clubCount: number;
  /** Called with the withheld mask (true keys only; `{}` when nothing is withheld). */
  onConfirm: (withheld: { venue?: true; time?: true }) => void;
  onClose: () => void;
}) {
  useEscapeClose(onClose);
  const titleId = useId();
  const [withheld, setWithheld] = useState<Record<WithheldField, boolean>>({
    venue: false,
    time: false,
  });
  const toggle = (f: WithheldField) => setWithheld((w) => ({ ...w, [f]: !w[f] }));

  function confirm() {
    // True keys only — an unticked field is omitted, never stored as `false`.
    const mask: { venue?: true; time?: true } = {};
    if (withheld.venue) mask.venue = true;
    if (withheld.time) mask.time = true;
    onConfirm(mask);
  }

  const toggles: Array<{ field: WithheldField; label: string; hint: string }> = [
    {
      field: 'venue',
      label: 'Withhold venues',
      hint: "Clubs see 'Venue to be confirmed'; distance and travel cost are hidden until you reveal venues.",
    },
    {
      field: 'time',
      label: 'Withhold start times',
      hint: "Clubs see 'Time to be confirmed' until you reveal start times.",
    },
  ];

  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Fixtures · Release</div>
            <div className="task-modal-head-title" id={titleId}>
              Release {seriesName} to clubs
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <p style={{ fontSize: 13, color: 'var(--ink3)', lineHeight: 1.5, marginTop: 0 }}>
            Publishes the {seriesName} schedule to all {clubCount} clubs' portals. No email or
            WhatsApp is sent — each club chooses when to share fixtures with its players.
          </p>
          <p style={{ fontSize: 13, color: 'var(--ink3)', lineHeight: 1.5 }}>
            Hold a field back if the union hasn't confirmed it yet — you can reveal it to every club
            later, once it's set.
          </p>
          <div className="check-list" style={{ marginTop: 6 }}>
            {toggles.map(({ field, label, hint }) => (
              <button
                key={field}
                type="button"
                role="checkbox"
                aria-checked={withheld[field]}
                onClick={() => toggle(field)}
                className={`check-item ${withheld[field] ? 'on' : ''}`}
                style={{ width: '100%', textAlign: 'left', alignItems: 'flex-start' }}
              >
                <div className="box">{withheld[field] && <Icon.Check />}</div>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontWeight: 600 }}>{label}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 500 }}>
                    {hint}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="fix-confirm-actions" style={{ marginTop: 22 }}>
            <Btn tone="outline" onClick={onClose}>
              Cancel
            </Btn>
            <Btn tone="teal" icon={Icon.Arrow} onClick={confirm}>
              Release to clubs
            </Btn>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

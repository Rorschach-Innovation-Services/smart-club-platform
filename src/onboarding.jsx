/* ─── Club Onboarding · 3-step cinematic flow ─── */

import { useState as useStateOb } from 'react';
import { Icon, Btn, useEscapeClose } from './atoms';
import { formatDeadlineLong, formatDeadlineMid } from './data';

export function Onboarding({ club, onClose, onComplete, onStart, submissionDeadline }) {
  useEscapeClose(onClose);
  const deadlineLong = formatDeadlineLong(submissionDeadline);
  const deadlineMid = formatDeadlineMid(submissionDeadline);
  const [step, setStep] = useStateOb(1);
  const chair = club.exco?.chair || {};
  const [contact, setContact] = useStateOb({
    name: club.chair || chair.name || '',
    role: 'Chairperson',
    email: chair.email || '',
    cell: chair.cell || '',
    notify: true,
  });

  const totalSteps = 3;
  const labels = ['Welcome', 'Three submissions', 'Your contact'];

  function next() {
    if (step < totalSteps) setStep(step + 1);
    else {
      // Hand the verified contact up so the reminders opt-in is persisted (no cron yet).
      onComplete(contact);
      onStart && onStart();
    }
  }
  function back() {
    setStep(Math.max(1, step - 1));
  }

  return (
    <div className="ob-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`ob-modal ${step === 1 ? 'hero' : ''}`}>
        {/* ─── Header — progress bar + step label + close ─── */}
        <div className="ob-head">
          <div className="ob-step-progress">
            <div className="ob-step-label">
              <span className="num">{step}</span>
              <span>of {totalSteps}</span>
              <span className="dot">·</span>
              <span>{labels[step - 1]}</span>
            </div>
            <div className="ob-bar">
              <div className="ob-bar-fill" style={{ width: (step / totalSteps) * 100 + '%' }} />
            </div>
          </div>
          <button
            className="ob-close"
            onClick={onClose}
            title="Close (replay from the home page any time)"
          >
            <Icon.X />
          </button>
        </div>

        {/* ─── Stage ─── */}
        <div className="ob-stage">
          <div className="ob-step-content" key={step}>
            {step === 1 && <StepWelcome club={club} deadlineLong={deadlineLong} />}
            {step === 2 && <StepSubmissions deadlineLong={deadlineLong} />}
            {step === 3 && (
              <StepContact
                contact={contact}
                setContact={setContact}
                club={club}
                deadlineMid={deadlineMid}
              />
            )}
          </div>
        </div>

        {/* ─── Footer ─── */}
        <div className="ob-foot">
          <div className="ob-foot-hint">
            {step === totalSteps ? 'Ready when you are.' : 'You can skip and replay any time.'}
          </div>
          <div className="ob-foot-buttons">
            {step > 1 && (
              <Btn tone="ghost" onClick={back}>
                ← Back
              </Btn>
            )}
            {step === totalSteps ? (
              <Btn tone="teal" icon={Icon.Arrow} onClick={next}>
                Start affiliation
              </Btn>
            ) : (
              <Btn tone="ink" icon={Icon.Arrow} onClick={next}>
                Continue
              </Btn>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Step 1 — Cinematic welcome (photo left · content right) ─── */
function StepWelcome({ club, deadlineLong }) {
  return (
    <div className="ob-hero">
      <div
        className="ob-hero-photo"
        style={{ backgroundImage: "url('/venues/kingsmead-stadium.jpg')" }}
      >
        <div className="ob-hero-overlay">
          <div className="ob-hero-badge">
            <span className="dot" />
            Hollywoodbets Dolphins · 2026/27
          </div>
        </div>
      </div>
      <div className="ob-hero-content">
        <div className="ob-eyebrow">Welcome aboard</div>
        <h2 className="ob-title">
          Hello {club.chair.split(' ')[0]},<br />
          <em>welcome to the Dolphins family.</em>
        </h2>
        <p className="ob-desc">
          You're now the chair of <strong>{club.name}</strong> on the Smart Club platform — the
          digital home for every cricket club in the Dolphins Cricket Services district leagues.
        </p>
        <p className="ob-desc">
          We'll walk you through what's required before <strong>{deadlineLong}</strong>, then hand
          over to your first form. The full setup takes about 8 minutes.
        </p>
      </div>
    </div>
  );
}

/* ─── Step 2 — Three submissions ─── */
function StepSubmissions({ deadlineLong }) {
  const items = [
    {
      i: <Icon.Form />,
      t: '2026/27 Affiliation Form',
      d: 'Club details, executive committee, leagues entered and coaches by designation.',
      tag: '~ 5 min',
    },
    {
      i: <Icon.Upload />,
      t: 'Compliance documents',
      d: 'Constitution · AGM Minutes · Financial Statements · Exco Reps Listed · Code of Conduct · Safeguarding Certificate (PDF up to 10 MB each).',
      tag: '~ 3 min',
    },
    {
      i: <Icon.Star />,
      t: 'CQI self-assessment',
      d: '25 questions across admin, teams, coaching, facilities and representation. Live-scored as a raw quality-index value.',
      tag: '~ 8 min',
    },
  ];
  return (
    <div className="ob-panel">
      <div className="ob-eyebrow">What we need from you</div>
      <h2 className="ob-title">
        Three submissions <em>before {deadlineLong}</em>
      </h2>
      <p className="ob-desc" style={{ maxWidth: 560 }}>
        Everything below is a digital form built directly on the platform — no printing, no emailing
        PDFs. We've pre-filled what we can from the union database.
      </p>
      <div className="ob-deliv">
        {items.map((it, i) => (
          <div key={i} className="ob-deliv-item">
            <div className="ob-deliv-icon">{it.i}</div>
            <div>
              <div className="ob-deliv-t">{it.t}</div>
              <div className="ob-deliv-d">{it.d}</div>
            </div>
            <div className="ob-deliv-tag">{it.tag}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Step 3 — Verify contact details ─── */
function StepContact({ contact, setContact, club, deadlineMid }) {
  function up(k, v) {
    setContact((c) => ({ ...c, [k]: v }));
  }
  return (
    <div className="ob-panel">
      <div className="ob-eyebrow">Verify your contact details</div>
      <h2 className="ob-title">
        How should we <em>reach you?</em>
      </h2>
      <p className="ob-desc" style={{ maxWidth: 560 }}>
        We'll use these details for deadline reminders, fixture notifications and franchise
        communications. The chairperson is the primary contact — additional bearers come in the
        affiliation form.
      </p>
      <div className="ob-form">
        <div className="field">
          <div className="field-label">
            Full name <span className="req">*</span>
          </div>
          <input
            className="field-input"
            value={contact.name}
            onChange={(e) => up('name', e.target.value)}
          />
        </div>
        <div className="field">
          <div className="field-label">Role</div>
          <select
            className="field-select"
            value={contact.role}
            onChange={(e) => up('role', e.target.value)}
          >
            <option>Chairperson</option>
            <option>Secretary</option>
            <option>Treasurer</option>
            <option>Vice-Chair</option>
          </select>
        </div>
        <div className="field">
          <div className="field-label">
            Email <span className="req">*</span>
          </div>
          <input
            className="field-input"
            type="email"
            value={contact.email}
            onChange={(e) => up('email', e.target.value)}
          />
        </div>
        <div className="field">
          <div className="field-label">
            Cell number <span className="req">*</span>
          </div>
          <input
            className="field-input"
            value={contact.cell}
            onChange={(e) => up('cell', e.target.value)}
          />
        </div>
      </div>

      <button
        onClick={() => up('notify', !contact.notify)}
        className={`check-item ${contact.notify ? 'on' : ''} ob-notify`}
        style={{ width: '100%', textAlign: 'left' }}
      >
        <div className="box">{contact.notify && <Icon.Check />}</div>
        Send me email &amp; WhatsApp reminders as the {deadlineMid} deadline approaches.
      </button>

      <div className="ob-confirm-card">
        <div className="row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="sdot teal" />
          <span>
            Confirmed as <strong>{contact.name}</strong> · {contact.role}, {club.name}
          </span>
        </div>
        <div className="row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="sdot teal" />
          <span>
            {contact.email} · {contact.cell}
          </span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Onboarding });

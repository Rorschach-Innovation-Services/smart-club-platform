/* ─── Club Onboarding · 3-step cinematic flow ─── */

import { useState as useStateOb } from 'react';
import { Icon, Btn, useEscapeClose } from './atoms';
import {
  DEFAULT_REQUIRED_DOCS,
  activeDocs,
  completionDocs,
  formatDeadlineLong,
  formatDeadlineMid,
} from './data';
import { useCopy, useModule, useSeasonLabel, useVertical } from './branding';
import { roleLabel } from './vertical';

export function Onboarding({
  club,
  onClose,
  onComplete,
  onStart,
  submissionDeadline,
  requiredDocs = DEFAULT_REQUIRED_DOCS,
}) {
  useEscapeClose(onClose);
  const vertical = useVertical();
  // CQI + compliance both off (e.g. football): the walkthrough is affiliation → fixtures.
  const cqiOn = useModule('cqi');
  const complianceOn = useModule('compliance');
  const deadlineLong = formatDeadlineLong(submissionDeadline);
  const deadlineMid = formatDeadlineMid(submissionDeadline);
  const [step, setStep] = useStateOb(1);
  const chair = club.exco?.chair || {};
  const [contact, setContact] = useStateOb({
    name: club.chair || chair.name || '',
    role: roleLabel(vertical, 'chair'),
    email: chair.email || '',
    cell: chair.cell || '',
    notify: true,
  });

  const totalSteps = 3;
  const labels = [
    'Welcome',
    cqiOn || complianceOn ? 'Three submissions' : 'Affiliation & fixtures',
    'Your contact',
  ];

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
            {step === 2 && (
              <StepSubmissions
                deadlineLong={deadlineLong}
                requiredDocs={requiredDocs}
                cqiOn={cqiOn}
                complianceOn={complianceOn}
              />
            )}
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
  const copy = useCopy();
  const vertical = useVertical();
  const seasonLabel = useSeasonLabel();
  return (
    <div className="ob-hero">
      <div className="ob-hero-photo" style={{ backgroundImage: 'var(--hero-image)' }}>
        <div className="ob-hero-overlay">
          <div className="ob-hero-badge">
            <span className="dot" />
            {copy.eyebrow} · {seasonLabel}
          </div>
        </div>
      </div>
      <div className="ob-hero-content">
        <div className="ob-eyebrow">Welcome aboard</div>
        <h2 className="ob-title">
          Hello {club.chair.split(' ')[0]},<br />
          <em>welcome to the {copy.orgShort} family.</em>
        </h2>
        {/* Full sentence per sport — the cricket wording ("chair", "cricket club … district
            leagues") doesn't compose cleanly from terms. */}
        {vertical.sport === 'cricket' ? (
          <p className="ob-desc">
            You're now the chair of <strong>{club.name}</strong> on the Smart Club platform — the
            digital home for every cricket club in the {copy.orgName} district leagues.
          </p>
        ) : (
          <p className="ob-desc">
            You're now set up to run <strong>{club.name}</strong> on the Smart Club platform — the
            digital home for every {vertical.terms.club} in the {copy.orgName} leagues.
          </p>
        )}
        <p className="ob-desc">
          We'll walk you through what's required before <strong>{deadlineLong}</strong>, then hand
          over to your first form. The full setup takes about 8 minutes.
        </p>
      </div>
    </div>
  );
}

/* ─── Step 2 — Three submissions (or, with CQI + compliance off, affiliation → fixtures) ─── */
function StepSubmissions({
  deadlineLong,
  requiredDocs = DEFAULT_REQUIRED_DOCS,
  cqiOn = true,
  complianceOn = true,
}) {
  const copy = useCopy();
  const terms = useVertical().terms;
  const seasonLabel = useSeasonLabel();
  const affiliationOnly = !cqiOn && !complianceOn;
  // The doc list is driven by the tenant's catalogue (ADR 0009) — a legacy tenant (no
  // custom requiredDocs) reproduces the same six names in the same order as before.
  // Only docs that count towards completion are named; optional records get a generic
  // trailing note instead, so the walkthrough never implies they are required.
  const docNames = completionDocs(requiredDocs)
    .map((d) => d.name)
    .join(' · ');
  const optionalCount = activeDocs(requiredDocs).filter((d) => d.optional).length;
  const docsCopy =
    (docNames
      ? `${docNames} (max 10 MB each).`
      : `No documents are required for your ${terms.club}.`) +
    (optionalCount ? ' Optional records can be kept on file too.' : '');
  const items = [
    {
      i: <Icon.Form />,
      t: `${seasonLabel} Affiliation Form`,
      d: `${terms.Club} details, ${terms.exco}, leagues entered and coaches by designation.`,
      tag: '~ 5 min',
    },
    ...(complianceOn
      ? [
          {
            i: <Icon.Upload />,
            t: 'Compliance documents',
            d: docsCopy,
            tag: '~ 3 min',
          },
        ]
      : []),
    ...(cqiOn
      ? [
          {
            i: <Icon.Star />,
            t: 'CQI self-assessment',
            d: '25 questions across admin, teams, coaching, facilities and representation. Live-scored as a raw quality-index value.',
            tag: '~ 8 min',
          },
        ]
      : []),
    ...(affiliationOnly
      ? [
          {
            i: <Icon.Field />,
            t: 'Fixtures',
            d: `Once your affiliation is in, the ${copy.office} releases your fixtures here — share them with your players straight from the portal.`,
            tag: 'Automatic',
          },
        ]
      : []),
  ];
  return (
    <div className="ob-panel">
      <div className="ob-eyebrow">What we need from you</div>
      <h2 className="ob-title">
        {affiliationOnly ? 'Your affiliation form' : 'Three submissions'}{' '}
        <em>before {deadlineLong}</em>
      </h2>
      <p className="ob-desc" style={{ maxWidth: 560 }}>
        Everything below is a digital form built directly on the platform — no printing, no emailing
        PDFs. We've pre-filled what we can from the {terms.union} database.
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
  const vertical = useVertical();
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
        communications. The {vertical.terms.chair} is the primary contact — additional bearers come
        in the affiliation form.
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
            {vertical.leadershipRoles.map((r) => (
              <option key={r.key}>{r.label}</option>
            ))}
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

/**
 * Public umpire / scorer self-registration — the target of the per-role link the admin shares
 * from the Umpires or Scorers page (`/officials/register?t=<token>`). No auth. The token names
 * the role and the tenant; a submission lands on the register as PENDING until the office
 * approves or merges it (docs/api/officials.md). The done screen never says whether the person
 * was already on the register.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { qk } from './query';
import {
  ApiError,
  getOfficialSignup,
  getTenant,
  normalizeZaCell,
  submitOfficialSignup,
  type OfficialRole,
  type OfficialSignupBody,
} from './api';
import { useVertical } from './branding';
import { Field, Section } from './formFields';

/** Mirrors the server: names are whitespace-collapsed and at most 60 characters each. */
export const OFFICIAL_NAME_MAX = 60;
const collapse = (s: string) => s.trim().replace(/\s+/g, ' ');
const CELL_HINT = 'Enter a South African cell number, e.g. 082 123 4567.';

interface Form {
  firstNames: string;
  surname: string;
  phone: string;
  email: string;
  idNumber: string;
  emergencyPhone: string;
  address: string;
  consent: boolean;
}
const EMPTY: Form = {
  firstNames: '',
  surname: '',
  phone: '',
  email: '',
  idNumber: '',
  emergencyPhone: '',
  address: '',
  consent: false,
};

type Errors = Partial<Record<keyof Form, string>>;

/** Client-side checks; the body to send when there are none. */
export function validateOfficialSignup(
  role: OfficialRole,
  f: Form,
): { errors: Errors; body?: OfficialSignupBody } {
  const errors: Errors = {};
  const firstNames = collapse(f.firstNames);
  const surname = collapse(f.surname);
  if (!firstNames) errors.firstNames = 'Enter your first names.';
  else if (firstNames.length > OFFICIAL_NAME_MAX)
    errors.firstNames = `Keep this to ${OFFICIAL_NAME_MAX} characters or fewer.`;
  if (!surname) errors.surname = 'Enter your surname.';
  else if (surname.length > OFFICIAL_NAME_MAX)
    errors.surname = `Keep this to ${OFFICIAL_NAME_MAX} characters or fewer.`;
  const phone = normalizeZaCell(f.phone);
  if (!f.phone.trim()) errors.phone = 'Enter your cell number.';
  else if (!phone) errors.phone = CELL_HINT;
  const email = f.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    errors.email = 'Enter a valid email address, or leave it blank.';
  let emergencyPhone: string | null = null;
  if (role === 'scorer' && f.emergencyPhone.trim()) {
    emergencyPhone = normalizeZaCell(f.emergencyPhone);
    if (!emergencyPhone) errors.emergencyPhone = CELL_HINT;
  }
  if (!f.consent) errors.consent = 'Tick the consent box to continue.';
  if (Object.keys(errors).length) return { errors };
  const body: OfficialSignupBody = {
    firstNames,
    surname,
    phone: phone!,
    ...(email ? { email } : {}),
    consent: true,
  };
  if (role === 'scorer') {
    if (f.idNumber.trim()) body.idNumber = f.idNumber.trim();
    if (emergencyPhone) body.emergencyPhone = emergencyPhone;
    if (f.address.trim()) body.address = collapse(f.address);
  }
  return { errors, body };
}

/**
 * The branded public frame (logo, tagline, footer) as on the club signup page, with the card
 * centred in a single column like the player registration page.
 */
function Frame({
  branding,
  children,
}: {
  branding?: { logoUrl?: string; name?: string; copy?: Record<string, string> } | null;
  children?: ReactNode;
}) {
  return (
    <div className="ps-screen">
      <div className="ps-brand">
        {branding?.logoUrl && (
          <img className="ps-brand-logo" src={branding.logoUrl} alt={branding?.name ?? 'Logo'} />
        )}
        <div
          className="ps-eyebrow"
          style={{ margin: 0, color: 'rgba(255,255,255,0.6)', fontSize: 11 }}
        >
          {branding?.copy?.tagline ?? 'Smart Club Integration'}
        </div>
      </div>
      <div className="ps-cards reg-cards-sm">
        <div className="ps-card reg-card" style={{ cursor: 'default' }}>
          {children}
        </div>
      </div>
      <div className="ps-footer">
        <span>{branding?.name ?? 'Smart Club'}</span>
        <span className="dot" />
        <span>{branding?.copy?.footer ?? 'Powered by Medicoach'}</span>
      </div>
    </div>
  );
}

function FieldError({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <div
      id={id}
      role="alert"
      style={{ color: 'var(--danger-on-dark)', fontSize: 12, marginTop: 4 }}
    >
      {text}
    </div>
  );
}

export function OfficialSignupPage() {
  const [params] = useSearchParams();
  const token = params.get('t');
  const tenantQuery = useQuery({ queryKey: qk.tenant(), queryFn: getTenant, retry: 0 });
  const branding = tenantQuery.data?.branding;
  const t = useVertical().terms;

  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'error' | 'done'>('loading');
  // Bumped by Retry on the load-error screen.
  const [attempt, setAttempt] = useState(0);
  const [role, setRole] = useState<OfficialRole>('umpire');
  const [tenantName, setTenantName] = useState('');
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    if (!token) {
      setState('invalid');
      return;
    }
    getOfficialSignup(token).then(
      (r) => {
        if (!live) return;
        setRole(r.role === 'scorer' ? 'scorer' : 'umpire');
        setTenantName(r.tenantName || '');
        setState('ready');
      },
      // Only a refused token (400/404) is "Link not valid"; a network error or 5xx can be
      // retried.
      (err) =>
        live &&
        setState(
          err instanceof ApiError && (err.status === 400 || err.status === 404)
            ? 'invalid'
            : 'error',
        ),
    );
    return () => {
      live = false;
    };
  }, [token, attempt]);

  const set = (k: Exclude<keyof Form, 'consent'>) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const office = `the ${tenantName || t.union} office`;
  const roleNoun = role === 'scorer' ? 'scorer' : 'umpire';
  const title = role === 'scorer' ? 'Scorer registration' : 'Umpire registration';

  async function submit(e: { preventDefault: () => void }) {
    e.preventDefault();
    setError('');
    const { errors: found, body } = validateOfficialSignup(role, form);
    setErrors(found);
    if (!body || !token) return;
    setBusy(true);
    try {
      await submitOfficialSignup(token, body);
      setState('done');
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 429) setError('Too many submissions right now. Please try again later.');
      else if (status === 404) setState('invalid');
      else
        setError(
          err instanceof ApiError && err.message
            ? err.message
            : 'Could not submit. Please try again.',
        );
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading')
    return <Frame branding={branding}>Checking your registration link…</Frame>;

  if (state === 'error')
    return (
      <Frame branding={branding}>
        <h1 className="ps-title" style={{ fontSize: 22 }}>
          Something went wrong
        </h1>
        <p className="ps-desc">
          We couldn&apos;t load this page. Check your connection and try again.
        </p>
        <button
          className="btn btn-teal"
          type="button"
          onClick={() => {
            setState('loading');
            setAttempt((n) => n + 1);
          }}
          style={{ width: '100%', marginTop: 8, justifyContent: 'center' }}
        >
          Retry
        </button>
      </Frame>
    );

  if (state === 'invalid')
    return (
      <Frame branding={branding}>
        <h1 className="ps-title" style={{ fontSize: 22 }}>
          Link not valid
        </h1>
        <p className="ps-desc">
          This registration link is invalid or has been replaced. Ask the {t.union} office for the
          current link.
        </p>
      </Frame>
    );

  if (state === 'done')
    return (
      <Frame branding={branding}>
        <div className="ps-eyebrow">{title}</div>
        <h1 className="ps-title" style={{ fontSize: 22 }}>
          Registration received
        </h1>
        <p className="ps-desc">
          Thank you. Your details have been sent to {office}. They will review them before you are
          appointed as {roleNoun === 'umpire' ? 'an umpire' : 'a scorer'} to any fixture.
        </p>
      </Frame>
    );

  return (
    <Frame branding={branding}>
      <div className="ps-eyebrow">{tenantName || t.Union}</div>
      <h1 className="ps-title" style={{ fontSize: 24 }}>
        {title}
      </h1>
      <p className="ps-desc" style={{ marginBottom: 18 }}>
        Register your details with {office} so they can appoint you as{' '}
        {roleNoun === 'umpire' ? 'an umpire' : 'a scorer'} and contact you about fixtures.
      </p>
      <form onSubmit={submit} className="reg-form" noValidate data-testid="official-signup-form">
        <Section title="Your details">
          <div>
            <Field
              label="First names"
              required
              value={form.firstNames}
              onChange={set('firstNames')}
              maxLength={OFFICIAL_NAME_MAX}
              autoComplete="given-name"
              invalid={!!errors.firstNames}
            />
            <FieldError id="os-first-err" text={errors.firstNames} />
          </div>
          <div>
            <Field
              label="Surname"
              required
              value={form.surname}
              onChange={set('surname')}
              maxLength={OFFICIAL_NAME_MAX}
              autoComplete="family-name"
              invalid={!!errors.surname}
            />
            <FieldError id="os-surname-err" text={errors.surname} />
          </div>
          <div>
            <Field
              label="Cell phone"
              type="tel"
              inputMode="tel"
              required
              value={form.phone}
              onChange={set('phone')}
              placeholder="082 123 4567"
              autoComplete="tel"
              invalid={!!errors.phone}
            />
            <FieldError id="os-phone-err" text={errors.phone} />
          </div>
          <div>
            <Field
              label="Email"
              type="email"
              value={form.email}
              onChange={set('email')}
              autoComplete="email"
              invalid={!!errors.email}
            />
            <FieldError id="os-email-err" text={errors.email} />
          </div>
        </Section>
        {role === 'scorer' && (
          <Section title="For the scorers' register">
            <Field label="ID number" value={form.idNumber} onChange={set('idNumber')} />
            <div>
              <Field
                label="Emergency contact number"
                type="tel"
                inputMode="tel"
                value={form.emergencyPhone}
                onChange={set('emergencyPhone')}
                placeholder="082 123 4567"
                invalid={!!errors.emergencyPhone}
              />
              <FieldError id="os-emergency-err" text={errors.emergencyPhone} />
            </div>
            <Field
              label="Home address"
              value={form.address}
              onChange={set('address')}
              autoComplete="street-address"
              span
            />
          </Section>
        )}

        <label
          className="rp-check rp-pill"
          style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px' }}
        >
          <input
            type="checkbox"
            checked={form.consent}
            aria-invalid={!!errors.consent || undefined}
            onChange={(e) => setForm((f) => ({ ...f, consent: e.target.checked }))}
          />
          <span style={{ fontSize: 12.5, lineHeight: 1.55 }}>
            I ask to be registered as {roleNoun === 'umpire' ? 'an umpire' : 'a scorer'} with{' '}
            <strong>{tenantName || `the ${t.Union}`}</strong>, and I consent to my personal
            information being processed for this purpose (POPIA): {office} will use these details to
            appoint me to fixtures and to contact me about them. My contact details are shown only
            to the {t.union}&apos;s administrators.
          </span>
        </label>
        <FieldError id="os-consent-err" text={errors.consent} />

        {error && (
          <div role="alert" style={{ color: 'var(--danger-on-dark)', fontSize: 12.5 }}>
            {error}
          </div>
        )}
        <button
          className="btn btn-teal"
          type="submit"
          disabled={busy}
          style={{ width: '100%', marginTop: 4, justifyContent: 'center' }}
        >
          {busy ? 'Submitting…' : 'Register'}
        </button>
      </form>
    </Frame>
  );
}

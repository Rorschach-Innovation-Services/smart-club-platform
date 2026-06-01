/**
 * Public player-registration page — the real target of the share links the admin
 * generates (`/register/:clubId?t=<token>`). No auth. Validates the token, then
 * captures a registration. Minors (under 18 by DOB) require a guardian name
 * (POPIA). A successful submit increments the club's derived player count.
 */
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { getRegistration, submitRegistration, ApiError } from './api.js';

function isMinor(dob) {
  if (!dob) return false;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return false;
  const eighteen = new Date(born);
  eighteen.setFullYear(eighteen.getFullYear() + 18);
  return eighteen.getTime() > Date.now();
}

export function RegisterPage() {
  const { clubId } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t');

  const [state, setState] = useState('loading'); // loading | ready | invalid | done
  const [clubName, setClubName] = useState('');
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    dob: '',
    cell: '',
    email: '',
    guardianName: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      if (!token) {
        setState('invalid');
        return;
      }
      try {
        const r = await getRegistration(clubId, token);
        if (!live) return;
        setClubName(r.clubName);
        setState('ready');
      } catch {
        if (live) setState('invalid');
      }
    })();
    return () => {
      live = false;
    };
  }, [clubId, token]);

  const minor = isMinor(form.dob);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await submitRegistration(clubId, token, form);
      setState('done');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('This person is already registered for the club.');
      } else {
        setError(err?.message || 'Could not submit. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading') {
    return <CenterCard>Checking your registration link…</CenterCard>;
  }
  if (state === 'invalid') {
    return (
      <CenterCard>
        <h1 className="ps-title" style={{ fontSize: 22 }}>
          Link not valid
        </h1>
        <p className="ps-desc">
          This registration link is invalid or has expired. Ask your club for a fresh link.
        </p>
      </CenterCard>
    );
  }
  if (state === 'done') {
    return (
      <CenterCard>
        <h1 className="ps-title" style={{ fontSize: 22 }}>
          You&apos;re registered 🎉
        </h1>
        <p className="ps-desc">Thanks — your registration for {clubName} has been received.</p>
      </CenterCard>
    );
  }

  return (
    <CenterCard wide>
      <div className="ps-eyebrow">Player registration</div>
      <h1 className="ps-title" style={{ fontSize: 24 }}>
        {clubName}
      </h1>
      <p className="ps-desc" style={{ marginBottom: 18 }}>
        Register as a player for the 2026/27 season.
      </p>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <Row>
          <Field label="First name" required value={form.firstName} onChange={set('firstName')} />
          <Field label="Last name" required value={form.lastName} onChange={set('lastName')} />
        </Row>
        <Field label="Date of birth" type="date" required value={form.dob} onChange={set('dob')} />
        <Row>
          <Field label="Cell" value={form.cell} onChange={set('cell')} />
          <Field label="Email" type="email" value={form.email} onChange={set('email')} />
        </Row>
        {minor && (
          <Field
            label="Parent / guardian name (required for under-18s)"
            required
            value={form.guardianName}
            onChange={set('guardianName')}
          />
        )}
        {error && <div style={{ color: 'var(--coral)', fontSize: 12.5 }}>{error}</div>}
        <button className="btn btn-ink" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Submitting…' : 'Register'}
        </button>
      </form>
    </CenterCard>
  );
}

function CenterCard({ children, wide }) {
  return (
    <div className="ps-screen">
      <div className="ps-cards" style={{ justifyContent: 'center' }}>
        <div className="ps-card" style={{ cursor: 'default', maxWidth: wide ? 520 : 420 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function Row({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>{children}</div>;
}

function Field({ label, type = 'text', required, value, onChange }) {
  return (
    <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>
      {label}
      <input
        className="field-input"
        type={type}
        required={required}
        value={value}
        onChange={onChange}
        style={{ width: '100%', marginTop: 4, fontSize: 16 }}
      />
    </label>
  );
}

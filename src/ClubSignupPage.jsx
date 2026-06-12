/**
 * Public club self-registration page — the target of the tenant-wide signup link
 * the admin shares (`/signup?t=<token>`). No auth. Validates the token, then one
 * submit creates the club AND the rep's passwordless account server-side. The
 * same link doubles as the way back in: "Already registered? Sign in" routes to
 * the normal OTP login with the email pre-filled (Login.jsx reads ?email=).
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { qk } from './query.js';
import { getClubSignup, submitClubSignup, getTenant, ApiError } from './api.js';

export function ClubSignupPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('t');

  // Branding for the header/footer — same cached query the app shell uses.
  const tenantQuery = useQuery({ queryKey: qk.tenant(), queryFn: getTenant, retry: 0 });
  const branding = tenantQuery.data?.branding;

  const [state, setState] = useState('loading'); // loading | ready | invalid | done
  const [orgName, setOrgName] = useState('');
  const [districts, setDistricts] = useState([]);
  const [form, setForm] = useState({
    repName: '',
    repEmail: '',
    repCell: '',
    clubName: '',
    district: '',
    consent: false,
  });
  const [done, setDone] = useState(null); // { clubName, email, replayed }
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      if (!token) {
        setState('invalid');
        return;
      }
      try {
        const r = await getClubSignup(token);
        if (!live) return;
        setOrgName(r.orgName || '');
        setDistricts(r.districts || []);
        setState('ready');
      } catch {
        if (live) setState('invalid');
      }
    })();
    return () => {
      live = false;
    };
  }, [token]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  // Sign-in is the normal OTP login at "/" — carry the typed email so it's pre-filled.
  const gotoSignIn = (email) => navigate(email ? `/?email=${encodeURIComponent(email)}` : '/');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setNameError('');
    setBusy(true);
    const email = form.repEmail.trim().toLowerCase();
    try {
      const res = await submitClubSignup(token, {
        clubName: form.clubName.trim(),
        district: form.district,
        repName: form.repName.trim(),
        repEmail: email,
        repCell: form.repCell.trim() || undefined,
        consent: form.consent === true,
      });
      // 201 echoes { clubName, email }; a 200 replay carries only { clubId, replayed }.
      setDone({
        clubName: res?.clubName ?? form.clubName.trim(),
        email: res?.email ?? email,
        replayed: !!res?.replayed,
      });
      setState('done');
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 409 && err.code === 'name_taken') {
        // A different club owns this name; never route to sign-in here.
        setNameError('A club with that name is already registered — choose a different name.');
      } else if (status === 429) {
        setError('Too many signups right now — try again in a little while.');
      } else if (status === 404) {
        // Link rotated/revoked while the form was open.
        setState('invalid');
      } else {
        setError(err?.message || 'Could not submit. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading') {
    return <Frame branding={branding}>Checking your signup link…</Frame>;
  }

  if (state === 'invalid') {
    return (
      <Frame branding={branding}>
        <h1 className="ps-title" style={{ fontSize: 22 }}>
          Link not valid
        </h1>
        <p className="ps-desc">
          This link isn&apos;t valid any more — ask the union office for the current signup link.
        </p>
        <SignInLink onClick={() => gotoSignIn(form.repEmail.trim())} />
      </Frame>
    );
  }

  if (state === 'done') {
    return (
      <Frame branding={branding}>
        <h1 className="ps-title" style={{ fontSize: 22 }}>
          {done.replayed ? 'Already registered' : 'Club registered'}
        </h1>
        <p className="ps-desc">
          {done.replayed
            ? `${done.clubName} was already registered with this email — you're all set to sign in.`
            : `${done.clubName} is registered with ${orgName || 'the union'}.`}{' '}
          Sign-in is passwordless: enter your email and we&apos;ll email you a one-time code.
        </p>
        <button
          className="btn btn-teal"
          type="button"
          onClick={() => gotoSignIn(done.email)}
          style={{ width: '100%', marginTop: 8 }}
        >
          Continue to sign in
        </button>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 14, lineHeight: 1.5 }}>
          Already signed in on this device? Sign out and back in to see your new club.
        </p>
      </Frame>
    );
  }

  return (
    <Frame branding={branding} wide>
      <div className="ps-eyebrow">Club registration</div>
      <h1 className="ps-title" style={{ fontSize: 24 }}>
        {orgName || 'Register your club'}
      </h1>
      <p className="ps-desc" style={{ marginBottom: 18 }}>
        Register your club for the 2026/27 season. You&apos;ll sign in with your email — no password
        needed.
      </p>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <Field label="Your name" required value={form.repName} onChange={set('repName')} />
        <Row>
          <Field
            label="Email"
            type="email"
            required
            value={form.repEmail}
            onChange={set('repEmail')}
          />
          <Field label="Cell" value={form.repCell} onChange={set('repCell')} />
        </Row>
        <Field label="Club name" required value={form.clubName} onChange={set('clubName')} />
        {nameError && (
          <div style={{ color: 'var(--coral)', fontSize: 12.5, marginTop: -8 }}>{nameError}</div>
        )}
        <label style={{ display: 'block' }}>
          <span className="reg-label">
            District<span className="req">*</span>
          </span>
          <select
            className="field-select"
            required
            value={form.district}
            onChange={set('district')}
            style={{ width: '100%', fontSize: 16 }}
          >
            <option value="" disabled>
              Select a district…
            </option>
            {districts.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            required
            checked={form.consent}
            onChange={(e) => setForm((f) => ({ ...f, consent: e.target.checked }))}
            style={{ marginTop: 3 }}
          />
          <span style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            I consent to the union storing these details to administer my club&apos;s affiliation.
          </span>
        </label>
        {error && <div style={{ color: 'var(--coral)', fontSize: 12.5 }}>{error}</div>}
        <button
          className="btn btn-teal"
          type="submit"
          disabled={busy}
          style={{ width: '100%', marginTop: 4 }}
        >
          {busy ? 'Registering…' : 'Register club'}
        </button>
      </form>
      <SignInLink onClick={() => gotoSignIn(form.repEmail.trim())} />
    </Frame>
  );
}

function SignInLink({ onClick }) {
  return (
    <div style={{ marginTop: 16, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
      Already registered?{' '}
      <button
        type="button"
        onClick={onClick}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          font: 'inherit',
          color: 'var(--teal-deep)',
          textDecoration: 'underline',
          cursor: 'pointer',
        }}
      >
        Sign in
      </button>
    </div>
  );
}

function Frame({ branding, children, wide }) {
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
          Smart Club Integration · Cricket Services
        </div>
      </div>
      <div className="ps-cards" style={{ justifyContent: 'center' }}>
        <div className="ps-card reg-card" style={{ maxWidth: wide ? 520 : 420, cursor: 'default' }}>
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

function Row({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>{children}</div>;
}

function Field({ label, type = 'text', required, value, onChange }) {
  return (
    <label style={{ display: 'block' }}>
      <span className="reg-label">
        {label}
        {required && <span className="req">*</span>}
      </span>
      <input
        className="field-input"
        type={type}
        required={required}
        value={value}
        onChange={onChange}
        style={{ width: '100%', fontSize: 16 }}
      />
    </label>
  );
}

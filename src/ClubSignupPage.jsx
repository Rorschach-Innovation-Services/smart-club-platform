/**
 * Public club self-registration page — the target of the tenant-wide signup link
 * the admin shares (`/signup?t=<token>`). No auth. Validates the token, then one
 * submit creates the club AND the rep's passwordless account server-side. The
 * same link doubles as the way back in: "Already registered? Sign in" routes to
 * the normal OTP login with the email pre-filled (Login.jsx reads ?email=).
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { qk } from './query.js';
import {
  getClubSignup,
  submitClubSignup,
  getTenant,
  getActiveTenant,
  normalizeZaCell,
  ApiError,
} from './api.js';
import { useAuth, membershipFor } from './auth.jsx';

/**
 * Which CTA the done view shows for an already-signed-in visitor:
 * 'admin'  — admin membership → straight to the admin console;
 * 'club'   — rep whose refreshed clubIds include the new club → open it;
 * null     — no membership / refresh hasn't landed → plain sign-in fallback.
 * Pure so vitest can table-test the branches.
 */
export function signupDoneCta(membership, clubId) {
  if (!membership) return null;
  if (membership.role === 'admin') return 'admin';
  if (clubId && (membership.clubIds ?? []).includes(clubId)) return 'club';
  return null;
}

export function ClubSignupPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('t');

  // Branding for the header/footer — same cached query the app shell uses.
  const tenantQuery = useQuery({ queryKey: qk.tenant(), queryFn: getTenant, retry: 0 });
  const branding = tenantQuery.data?.branding;

  // Signed-in visitors (e.g. a rep registering a second club) get their session
  // refreshed after submit so the new membership lands without a sign-out.
  const auth = useAuth();

  const [state, setState] = useState('loading'); // loading | ready | invalid | done
  const [orgName, setOrgName] = useState('');
  // The link's tenant (from the GET) — the done view only offers signed-in CTAs
  // when it matches the host's active tenant (a multi-union user signed into
  // union B opening union A's link must get the plain sign-in fallback).
  const [tenant, setTenant] = useState('');
  const [districts, setDistricts] = useState([]);
  const [form, setForm] = useState({
    repName: '',
    repEmail: '',
    repCell: '',
    clubName: '',
    district: '',
  });
  const [done, setDone] = useState(null); // { clubId, clubName, email, replayed }
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState('');
  const [cellError, setCellError] = useState('');
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
        setTenant(r.tenant || '');
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

  // PreTokenGen's membership read is eventually consistent: the forced refresh in
  // submit can mint a token that predates the new membership. If the done view is
  // showing the fallback to a signed-in rep on this tenant's host, retry the
  // refresh ONCE after ~1s (the live context re-renders the CTA when it lands).
  const retriedRefresh = useRef(false);
  useEffect(() => {
    if (state !== 'done' || !done?.clubId || retriedRefresh.current) return;
    if (auth.status !== 'signedIn' || tenant !== getActiveTenant()) return;
    if (signupDoneCta(membershipFor(auth.memberships, tenant), done.clubId)) return;
    // Mark "retried" only when the timer actually fires — a dep change mid-wait
    // (context identity churn) cancels and reschedules rather than losing the retry.
    const t = setTimeout(() => {
      retriedRefresh.current = true;
      auth.refreshSession?.().catch(() => false);
    }, 1000);
    return () => clearTimeout(t);
  }, [state, done, tenant, auth]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  // Sign-in is the normal OTP login at "/" — carry the typed email so it's pre-filled.
  const gotoSignIn = (email) => navigate(email ? `/?email=${encodeURIComponent(email)}` : '/');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setNameError('');
    setCellError('');
    const email = form.repEmail.trim().toLowerCase();
    // Cell is optional, but a non-empty value must normalize (same rule as the
    // server) — send the canonical 0XXXXXXXXX form, never the raw input.
    const rawCell = form.repCell.trim();
    const cell = rawCell ? normalizeZaCell(rawCell) : undefined;
    if (rawCell && !cell) {
      setCellError('Enter a valid South African cell number, e.g. 083 555 0001.');
      return;
    }
    setBusy(true);
    try {
      const res = await submitClubSignup(token, {
        clubName: form.clubName.trim(),
        district: form.district,
        repName: form.repName.trim(),
        repEmail: email,
        repCell: cell,
      });
      // Already signed in (e.g. a rep adding a second club): force a token
      // re-mint so the new membership lands without a sign-out — PreTokenGen
      // re-reads memberships on the forced mint. Failure just leaves the
      // sign-in fallback CTA; never block the success screen on it.
      if (auth.status === 'signedIn') {
        await auth.refreshSession?.().catch(() => false);
      }
      // 201 echoes { clubId, clubName, email }; a 200 replay carries only { clubId, replayed }.
      setDone({
        clubId: res?.clubId ?? null,
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
    // Signed-in CTAs only when this link's tenant is the host's active tenant —
    // a multi-union user on the wrong host gets the plain sign-in fallback (a
    // navigate would drop them into the wrong union's shell).
    const membership =
      auth.status === 'signedIn' && tenant && tenant === getActiveTenant()
        ? membershipFor(auth.memberships, tenant)
        : null;
    const cta = signupDoneCta(membership, done.clubId);
    return (
      <Frame branding={branding}>
        <h1 className="ps-title" style={{ fontSize: 22 }}>
          {done.replayed ? 'Already registered' : 'Club registered'}
        </h1>
        <p className="ps-desc">
          {done.replayed
            ? `${done.clubName} was already registered with this email — you're all set to sign in.`
            : `${done.clubName} is registered with ${orgName || 'the union'}.`}{' '}
          {cta === null &&
            "Sign-in is passwordless: enter your email and we'll email you a one-time code."}
        </p>
        {cta === 'admin' && (
          <button
            className="btn btn-teal"
            type="button"
            onClick={() => navigate('/')}
            style={{ width: '100%', marginTop: 8 }}
          >
            Open the admin console
          </button>
        )}
        {cta === 'club' && (
          <>
            <button
              className="btn btn-teal"
              type="button"
              onClick={() => navigate(`/club/${done.clubId}`)}
              style={{ width: '100%', marginTop: 8 }}
            >
              Go to {done.clubName}
            </button>
            <p
              style={{
                fontSize: 12,
                color: 'var(--muted-on-dark)',
                marginTop: 14,
                lineHeight: 1.5,
              }}
            >
              You&apos;re signed in and your session was refreshed — the new club is ready.
            </p>
          </>
        )}
        {cta === null && (
          <>
            <button
              className="btn btn-teal"
              type="button"
              onClick={() => gotoSignIn(done.email)}
              style={{ width: '100%', marginTop: 8 }}
            >
              Continue to sign in
            </button>
            <p
              style={{
                fontSize: 12,
                color: 'var(--muted-on-dark)',
                marginTop: 14,
                lineHeight: 1.5,
              }}
            >
              Already signed in on this device? Sign out and back in to see your new club.
            </p>
          </>
        )}
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
          <div>
            <Field label="Cell" value={form.repCell} onChange={set('repCell')} />
            {cellError && (
              <div style={{ color: 'var(--danger-on-dark)', fontSize: 12.5, marginTop: 4 }}>
                {cellError}
              </div>
            )}
          </div>
        </Row>
        <Field label="Club name" required value={form.clubName} onChange={set('clubName')} />
        {nameError && (
          <div style={{ color: 'var(--danger-on-dark)', fontSize: 12.5, marginTop: -8 }}>
            {nameError}
          </div>
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
        <p style={{ fontSize: 12.5, color: 'var(--muted-on-dark)', lineHeight: 1.5, margin: 0 }}>
          By registering, you agree the union may store these details to administer your club&apos;s
          affiliation.
        </p>
        {error && <div style={{ color: 'var(--danger-on-dark)', fontSize: 12.5 }}>{error}</div>}
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
    <div
      style={{ marginTop: 16, textAlign: 'center', fontSize: 12.5, color: 'var(--muted-on-dark)' }}
    >
      Already registered?{' '}
      <button
        type="button"
        onClick={onClick}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          font: 'inherit',
          color: 'var(--green-bright)',
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

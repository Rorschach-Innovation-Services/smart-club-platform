/**
 * Passwordless login screen — replaces the prototype's role picker.
 *
 * Two steps: enter email → enter the emailed OTP. Role/tenant/clubs are derived
 * from the resulting token (see auth.jsx), not chosen here. Branded from the
 * resolved tenant config.
 */
import { useState } from 'react';
import { useAuth, IS_LOCAL_AUTH } from './auth';
import { getActiveTenant } from './api';

export function Login({ tenantConfig }) {
  const auth = useAuth();
  const branding = tenantConfig?.branding;
  // Local dev: no Cognito — a "sign in as" form sets the identity directly.
  return IS_LOCAL_AUTH ? (
    <DevLogin auth={auth} branding={branding} />
  ) : (
    <OtpLogin auth={auth} branding={branding} />
  );
}

/* ─── Cloud: passwordless email OTP ─── */
function OtpLogin({ auth, branding }) {
  const { startSignIn, submitOtp, status, signedOutReason } = auth;
  const [email, setEmail] = useState(
    () => new URLSearchParams(window.location.search).get('email') ?? '',
  );
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resent, setResent] = useState(false);

  const awaitingOtp = status === 'otp';

  async function handleEmail(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await startSignIn(email.trim().toLowerCase());
    } catch (err) {
      setError(err?.message || 'Could not start sign-in. Check the email and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleOtp(e) {
    e.preventDefault();
    setError('');
    setResent(false);
    setBusy(true);
    try {
      await submitOtp(code.trim());
    } catch (err) {
      // Cognito's sign-in session times out (15 min) — its raw copy ("Invalid
      // session for the user, session is expired.") gives no recovery path.
      const expired = /session is expired|invalid session/i.test(err?.message ?? '');
      setError(
        expired
          ? 'That code took too long — send a new one below and use it right away.'
          : err?.message || 'Invalid or expired code. Request a new one.',
      );
    } finally {
      setBusy(false);
    }
  }

  // New Cognito sign-in session + new email; previous codes stop working.
  async function handleResend() {
    setError('');
    setResent(false);
    setCode('');
    setBusy(true);
    try {
      await startSignIn(email.trim().toLowerCase());
      setResent(true);
    } catch (err) {
      setError(err?.message || 'Could not send a new code. Try again.');
    } finally {
      setBusy(false);
    }
  }

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

      <div className="ps-intro">
        <div className="ps-eyebrow">{branding?.copy?.eyebrow ?? '2026 / 27 Season'}</div>
        <h1 className="ps-title">{branding?.copy?.welcome ?? 'Sign in'}</h1>
        <p className="ps-desc">
          Sign in with your email — we&apos;ll send you a one-time code. No password needed.
        </p>
      </div>

      <div className="ps-cards" style={{ justifyContent: 'center' }}>
        <div className="ps-card" style={{ cursor: 'default', maxWidth: 420 }}>
          {!awaitingOtp ? (
            <form onSubmit={handleEmail}>
              {signedOutReason === 'expired' && (
                <div
                  role="status"
                  style={{
                    // Matches the .kpi.warn palette (index.html) — no warn token exists yet.
                    background: '#F5EFD8',
                    color: '#6E5618',
                    borderRadius: 8,
                    padding: '8px 12px',
                    fontSize: 12.5,
                    marginBottom: 14,
                  }}
                >
                  You were signed out — your session expired. Sign in again to continue.
                </div>
              )}
              <div className="ps-card-role">Step 1 of 2</div>
              <div className="ps-card-title" style={{ marginBottom: 14 }}>
                Your email
              </div>
              <input
                className="field-input"
                type="email"
                required
                autoFocus
                placeholder="you@club.co.za"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{ width: '100%', marginBottom: 12, fontSize: 16 }}
              />
              {error && (
                <div style={{ color: 'var(--danger-on-dark)', fontSize: 12.5, marginBottom: 10 }}>
                  {error}
                </div>
              )}
              <button
                className="btn btn-ink"
                type="submit"
                disabled={busy}
                style={{ width: '100%' }}
              >
                {busy ? 'Sending…' : 'Send me a code'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleOtp}>
              <div className="ps-card-role">Step 2 of 2</div>
              <div className="ps-card-title" style={{ marginBottom: 6 }}>
                Enter the code
              </div>
              <p style={{ fontSize: 12.5, color: 'var(--muted-on-dark)', marginBottom: 14 }}>
                We emailed a one-time code to <strong>{email}</strong>.
              </p>
              <input
                className="field-input"
                inputMode="numeric"
                autoFocus
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                style={{
                  width: '100%',
                  marginBottom: 12,
                  fontSize: 18,
                  letterSpacing: '0.3em',
                  textAlign: 'center',
                }}
              />
              {error && (
                <div style={{ color: 'var(--danger-on-dark)', fontSize: 12.5, marginBottom: 10 }}>
                  {error}
                </div>
              )}
              {resent && (
                <div
                  role="status"
                  style={{ color: 'var(--muted-on-dark)', fontSize: 12.5, marginBottom: 10 }}
                >
                  New code sent — check your email (including spam / “Other”).
                </div>
              )}
              <button
                className="btn btn-ink"
                type="submit"
                disabled={busy}
                style={{ width: '100%' }}
              >
                {busy ? 'Verifying…' : 'Verify & sign in'}
              </button>
              <button
                type="button"
                onClick={handleResend}
                disabled={busy}
                style={{
                  width: '100%',
                  marginTop: 10,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--muted-on-dark)',
                  fontSize: 12.5,
                  textDecoration: 'underline',
                }}
              >
                Didn&apos;t get it? Send a new code
              </button>
            </form>
          )}
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

/* ─── Local dev "sign in as" (no Cognito) ─── */
function DevLogin({ auth, branding }) {
  const tenant = getActiveTenant() || 'dolphins';
  const [role, setRole] = useState('admin');
  const [clubIds, setClubIds] = useState('ukzn');

  function go(e) {
    e.preventDefault();
    const ids = clubIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    auth.devSignIn({
      sub: `dev-${role}`,
      email: `${role}@${tenant}.local`,
      memberships: [{ tenantId: tenant, role, clubIds: role === 'rep' ? ids : [] }],
    });
  }

  return (
    <div className="ps-screen">
      <div className="ps-intro">
        <div className="ps-eyebrow">Local dev · {tenant}</div>
        <h1 className="ps-title">{branding?.copy?.welcome ?? 'Sign in (dev)'}</h1>
        <p className="ps-desc">
          Offline mode — no Cognito. Pick a role to sign in as; this sets a dev identity the local
          API trusts via <code>x-dev-auth</code>.
        </p>
      </div>
      <div className="ps-cards" style={{ justifyContent: 'center' }}>
        <form className="ps-card" style={{ cursor: 'default', maxWidth: 420 }} onSubmit={go}>
          <div className="ps-card-role">Local sign-in</div>
          <label
            style={{ display: 'block', fontSize: 12, color: 'var(--muted-on-dark)', marginTop: 12 }}
          >
            Role
            <select
              className="field-select"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              style={{ width: '100%', marginTop: 4 }}
            >
              <option value="admin">Administrator — whole {tenant} union</option>
              <option value="rep">Club rep — specific club(s)</option>
            </select>
          </label>
          {role === 'rep' && (
            <label
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--muted-on-dark)',
                marginTop: 10,
              }}
            >
              Club IDs (comma-separated)
              <input
                className="field-input"
                value={clubIds}
                onChange={(e) => setClubIds(e.target.value)}
                placeholder="ukzn, clares"
                style={{ width: '100%', marginTop: 4, fontSize: 16 }}
              />
            </label>
          )}
          <button className="btn btn-ink" type="submit" style={{ width: '100%', marginTop: 14 }}>
            Enter as {role}
          </button>
        </form>
      </div>
      <div className="ps-footer">
        <span>{branding?.name ?? 'Smart Club'}</span>
        <span className="dot" />
        <span>local dev</span>
      </div>
    </div>
  );
}

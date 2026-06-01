/**
 * Passwordless login screen — replaces the prototype's role picker.
 *
 * Two steps: enter email → enter the emailed OTP. Role/tenant/clubs are derived
 * from the resulting token (see auth.jsx), not chosen here. Branded from the
 * resolved tenant config.
 */
import { useState } from 'react';
import { useAuth } from './auth.jsx';

export function Login({ tenantConfig }) {
  const { startSignIn, submitOtp, status } = useAuth();
  const branding = tenantConfig?.branding;
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
    setBusy(true);
    try {
      await submitOtp(code.trim());
    } catch (err) {
      setError(err?.message || 'Invalid or expired code. Request a new one.');
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
                <div style={{ color: 'var(--coral)', fontSize: 12.5, marginBottom: 10 }}>
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
              <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>
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
                <div style={{ color: 'var(--coral)', fontSize: 12.5, marginBottom: 10 }}>
                  {error}
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

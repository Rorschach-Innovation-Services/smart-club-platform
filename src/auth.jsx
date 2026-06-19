/**
 * Authentication context.
 *
 * Cloud mode: Cognito passwordless email OTP (Amplify v6). Role/tenant/club scope
 * come from the token's `memberships` claim (PreTokenGeneration). See ADR 0003.
 *
 * Local mode (VITE_LOCAL_AUTH=1): Cognito can't run offline, so a dev "login as"
 * sets the identity directly (see devAuth.js). Amplify is never touched.
 *
 * useAuth(): { status, email, memberships, signedOutReason, startSignIn, submitOtp,
 * signOutUser, refreshSession, devSignIn? }. signedOutReason ('expired' | '') lets
 * Login explain a forced sign-out (session lost mid-use, e.g. signed out in
 * another tab). refreshSession() forces a token re-mint so membership changes
 * land without a sign-out (PreTokenGen re-reads memberships on the forced mint).
 */
import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { Amplify } from 'aws-amplify';
import { Hub } from 'aws-amplify/utils';
import { signIn, confirmSignIn, signOut, fetchAuthSession, getCurrentUser } from 'aws-amplify/auth';
import { setTokenProvider, setAuthLostHandler } from './api';
import { getDevIdentity, setDevIdentity, clearDevIdentity } from './devAuth';

const LOCAL_AUTH = import.meta.env.VITE_LOCAL_AUTH === '1';

const AuthContext = createContext(null);

// ───────────────────────── Local (offline) provider ─────────────────────────
function LocalAuthProvider({ children }) {
  const initial = getDevIdentity();
  const [identity, setIdentity] = useState(initial);

  const devSignIn = useCallback((id) => {
    setDevIdentity(id);
    setIdentity(id);
  }, []);
  const signOutUser = useCallback(async () => {
    clearDevIdentity();
    setIdentity(null);
  }, []);

  const value = {
    status: identity ? 'signedIn' : 'signedOut',
    email: identity?.email ?? '',
    memberships: identity?.memberships ?? [],
    devSignIn,
    signOutUser,
    // The dev identity is static — there's no token to re-mint, so a refresh can
    // never pick up new memberships. False routes callers to the sign-out fallback.
    refreshSession: async () => false,
    // no-ops so the Login OTP form never appears in local mode
    startSignIn: async () => {},
    submitOtp: async () => {},
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ───────────────────────── Cloud (Cognito) provider ─────────────────────────
function CloudAuthProvider({ children }) {
  const [status, setStatus] = useState('loading');
  const [email, setEmail] = useState('');
  const [memberships, setMemberships] = useState([]);
  // Why the last sign-out happened ('expired' | ''), so Login can explain it.
  const [signedOutReason, setSignedOutReason] = useState('');
  // Current status for the mount-once listeners below (avoids re-registering).
  const statusRef = useRef(status);
  statusRef.current = status;
  // Epoch counter: focus + visibilitychange can overlap, and a revalidation in
  // flight when the user signs out must not resurrect the dead session. Each call
  // claims a sequence number; only the latest may write state (signOutUser bumps
  // it to cancel in-flight loads).
  const loadSeq = useRef(0);

  /** Re-read the Amplify session into React state. Returns true iff it landed on
   * signedIn (submitOtp uses this to retry/surface a transient post-OTP failure). */
  const loadSession = useCallback(async () => {
    const seq = ++loadSeq.current;
    // A discovered-dead session (vs a deliberate sign-out) gets an explanation on
    // the login screen — this covers cross-tab sign-outs found via revalidation.
    const wasSignedIn = () => statusRef.current === 'signedIn';
    const signedOut = () => {
      if (statusRef.current === 'otp') return; // never wipe the mid-login OTP form
      if (wasSignedIn()) setSignedOutReason('expired');
      setStatus('signedOut');
    };
    try {
      await getCurrentUser();
      const session = await fetchAuthSession();
      if (seq !== loadSeq.current) return false;
      const payload = session.tokens?.idToken?.payload;
      if (!payload) {
        signedOut();
        return false;
      }
      setEmail(payload.email ?? '');
      try {
        setMemberships(JSON.parse(payload.memberships ?? '[]'));
      } catch {
        setMemberships([]);
      }
      setSignedOutReason('');
      setStatus('signedIn');
      return true;
    } catch (err) {
      if (seq !== loadSeq.current) return false;
      // "No user" is definitive → signed out. Anything else (network blip during
      // token refresh) must not kick a signed-in tab back to the login screen;
      // it only downgrades the initial load, where there's no session to protect.
      if (err?.name === 'UserUnAuthenticatedException' || !wasSignedIn()) {
        signedOut();
      }
      return false;
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  // Keep React state honest about the real session: an authed request that finds
  // no token (or gets a 401) revalidates; so do same-tab Amplify auth events and
  // tab focus (Amplify shares localStorage across tabs but Hub events don't cross
  // tabs — a sign-out elsewhere is only visible by re-reading the session).
  useEffect(() => {
    // Revalidate rather than blind-flip: loadSession only lands on signedOut when
    // the local session is really gone (and sets signedOutReason itself), so a
    // systemic server-side 401 can't cause a sign-in → bounce loop.
    setAuthLostHandler(() => {
      loadSession();
    });
    const unsubscribe = Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedOut' || payload.event === 'tokenRefresh_failure') {
        loadSession();
      }
    });
    const revalidate = () => {
      // Only while signedIn — revalidating mid-login would wipe the OTP form.
      if (document.visibilityState === 'visible' && statusRef.current === 'signedIn') {
        loadSession();
      }
    };
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    return () => {
      setAuthLostHandler(null);
      unsubscribe();
      window.removeEventListener('focus', revalidate);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, [loadSession]);

  const startSignIn = useCallback(async (addr) => {
    setSignedOutReason('');
    setEmail(addr);
    await signIn({
      username: addr,
      options: { authFlowType: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' },
    });
    setStatus('otp');
  }, []);

  const submitOtp = useCallback(
    async (code) => {
      await confirmSignIn({ challengeResponse: code });
      // The code is consumed at this point — if the session read hiccups
      // (transient network), retry once rather than stranding the user on the
      // OTP form; then tell them what to do (Login surfaces err.message).
      if (!(await loadSession()) && !(await loadSession())) {
        throw new Error("You're signed in, but loading your session failed — refresh the page.");
      }
    },
    [loadSession],
  );

  /** Force Cognito to mint fresh tokens (PreTokenGen re-reads memberships on the
   * forced mint), then fold them into React state. Returns true iff the refreshed
   * session landed on signedIn — false means "still on the old claims" and callers
   * should fall back to the sign-out path. */
  const refreshSession = useCallback(async () => {
    try {
      await fetchAuthSession({ forceRefresh: true });
    } catch (err) {
      // Cloud-only path with no offline rehearsal — keep the failure observable so
      // a field report ("CTA never appeared") is distinguishable from staleness.
      console.warn('refreshSession: forced token refresh failed', err);
      return false;
    }
    return loadSession();
  }, [loadSession]);

  const signOutUser = useCallback(async () => {
    await signOut();
    loadSeq.current++; // cancel any in-flight revalidation — deliberate sign-out wins
    setMemberships([]);
    setEmail('');
    setSignedOutReason('');
    setStatus('signedOut');
  }, []);

  const value = {
    status,
    email,
    memberships,
    signedOutReason,
    startSignIn,
    submitOtp,
    signOutUser,
    refreshSession,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Configure Amplify + the token provider only in cloud mode (local has no pool).
if (!LOCAL_AUTH) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: import.meta.env.VITE_USER_POOL_ID,
        userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
      },
    },
  });
  // Resolved-but-empty = definitively signed out → null (api.js treats it as auth
  // lost). A thrown error (network blip during token refresh) propagates so the
  // request fails like any network error instead of signing the user out.
  setTokenProvider(async () => {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() ?? null;
  });
}

export function AuthProvider({ children }) {
  return LOCAL_AUTH ? (
    <LocalAuthProvider>{children}</LocalAuthProvider>
  ) : (
    <CloudAuthProvider>{children}</CloudAuthProvider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** The caller's membership for the active tenant, or null. */
export function membershipFor(memberships, tenant) {
  return memberships.find((m) => m.tenantId === tenant) ?? null;
}

export const IS_LOCAL_AUTH = LOCAL_AUTH;

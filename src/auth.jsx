/**
 * Authentication context.
 *
 * Cloud mode: Cognito passwordless email OTP (Amplify v6). Role/tenant/club scope
 * come from the token's `memberships` claim (PreTokenGeneration). See ADR 0003.
 *
 * Local mode (VITE_LOCAL_AUTH=1): Cognito can't run offline, so a dev "login as"
 * sets the identity directly (see devAuth.js). Amplify is never touched.
 *
 * useAuth(): { status, email, memberships, startSignIn, submitOtp, signOutUser,
 * devSignIn? }.
 */
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Amplify } from 'aws-amplify';
import { signIn, confirmSignIn, signOut, fetchAuthSession, getCurrentUser } from 'aws-amplify/auth';
import { setTokenProvider } from './api.js';
import { getDevIdentity, setDevIdentity, clearDevIdentity } from './devAuth.js';

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

  const loadSession = useCallback(async () => {
    try {
      await getCurrentUser();
      const session = await fetchAuthSession();
      const payload = session.tokens?.idToken?.payload;
      if (!payload) {
        setStatus('signedOut');
        return;
      }
      setEmail(payload.email ?? '');
      try {
        setMemberships(JSON.parse(payload.memberships ?? '[]'));
      } catch {
        setMemberships([]);
      }
      setStatus('signedIn');
    } catch {
      setStatus('signedOut');
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  const startSignIn = useCallback(async (addr) => {
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
      await loadSession();
    },
    [loadSession],
  );

  const signOutUser = useCallback(async () => {
    await signOut();
    setMemberships([]);
    setEmail('');
    setStatus('signedOut');
  }, []);

  const value = { status, email, memberships, startSignIn, submitOtp, signOutUser };
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
  setTokenProvider(async () => {
    try {
      const session = await fetchAuthSession();
      return session.tokens?.idToken?.toString() ?? null;
    } catch {
      return null;
    }
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

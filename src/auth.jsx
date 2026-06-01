/**
 * Authentication via Cognito passwordless email OTP (Amplify v6).
 *
 * Replaces the prototype's "pick a role" screen with real identity. Role, tenant,
 * and club scope come from the token's `memberships` claim (stamped by the
 * PreTokenGeneration Lambda) — never chosen by the user. See docs/architecture/0003.
 *
 * Exposes useAuth(): { status, email, memberships, startSignIn, submitOtp,
 * signOutUser } and registers a token provider so api.js can attach the ID token.
 */
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Amplify } from 'aws-amplify';
import { signIn, confirmSignIn, signOut, fetchAuthSession, getCurrentUser } from 'aws-amplify/auth';
import { setTokenProvider } from './api.js';

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
    },
  },
});

// api.js asks for a fresh ID token on each request; Amplify caches/refreshes it.
setTokenProvider(async () => {
  try {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() ?? null;
  } catch {
    return null;
  }
});

function parseMemberships(payload) {
  try {
    return JSON.parse(payload?.memberships ?? '[]');
  } catch {
    return [];
  }
}

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // status: 'loading' | 'signedOut' | 'otp' (awaiting code) | 'signedIn'
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
      setMemberships(parseMemberships(payload));
      setStatus('signedIn');
    } catch {
      setStatus('signedOut');
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  /** Begin passwordless sign-in: request an email OTP. */
  const startSignIn = useCallback(async (addr) => {
    setEmail(addr);
    await signIn({
      username: addr,
      options: { authFlowType: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' },
    });
    setStatus('otp');
  }, []);

  /** Complete sign-in with the emailed code. */
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

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** The caller's membership for the active tenant, or null. */
export function membershipFor(memberships, tenant) {
  return memberships.find((m) => m.tenantId === tenant) ?? null;
}

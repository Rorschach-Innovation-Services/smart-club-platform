/**
 * LOCAL-DEV ONLY identity holder (active when VITE_LOCAL_AUTH=1).
 *
 * Cognito passwordless OTP can't run offline, so the local stack uses a dev
 * "login as" that picks a tenant/role/clubs. The chosen identity is sent to the
 * local API as the `x-dev-auth` header (base64 JSON), which the API trusts only
 * when LOCAL_AUTH=1. Persisted to localStorage so a refresh stays signed in.
 */
import type { Membership } from './types';

const KEY = 'smartclub.devAuth';

/** The dev "login as" identity, shaped like the cloud token's relevant claims. */
export interface DevIdentity {
  tenant?: string;
  role?: string;
  email?: string;
  memberships?: Membership[];
}

let _identity: DevIdentity | null = load();

function load(): DevIdentity | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

export function getDevIdentity(): DevIdentity | null {
  return _identity;
}

export function setDevIdentity(identity: DevIdentity) {
  _identity = identity;
  localStorage.setItem(KEY, JSON.stringify(identity));
}

export function clearDevIdentity() {
  _identity = null;
  localStorage.removeItem(KEY);
}

/** base64(JSON) for the x-dev-auth header, or null when signed out. */
export function devAuthHeader() {
  if (!_identity) return null;
  return btoa(JSON.stringify(_identity));
}

/**
 * Pure portal-routing decisions, extracted so they're unit-testable without
 * importing the app entry (src/main.jsx renders at module load).
 *
 * Role vocabulary note: the *token* role is 'admin' | 'rep', but routing collapses
 * everything non-admin to the string 'club' (the rep portal). These helpers speak
 * the routing role ('admin' | 'club').
 */

import { PLATFORM_TENANT } from './types';
import type { Membership } from './types';

/** Routing role for a tenant membership: 'admin' for an admin, else 'club'. */
export function routingRole(membership) {
  return membership?.role === 'admin' ? 'admin' : 'club';
}

/**
 * Whether the caller holds the platform-operator membership `{tenantId:'*',
 * role:'operator'}` — the gate for the /platform/* portal. Mirrors
 * requirePlatformOperator in packages/api/src/auth.ts. Independent of any
 * tenant membership: an operator may also be a tenant admin, or hold nothing else.
 */
export function isOperator(memberships: Membership[] | null | undefined): boolean {
  return (memberships ?? []).some((m) => m.tenantId === PLATFORM_TENANT && m.role === 'operator');
}

/**
 * Guard for the `/club/:clubId/*` route: admins manage clubs via /admin/clubs/:id,
 * never the rep portal, so an admin left on a /club URL (e.g. an in-tab
 * sign-out→sign-in from a rep session, which doesn't re-run the "/" role redirect)
 * is sent to the admin dashboard. Returns the redirect target, or null for a rep
 * (who legitimately stays on the club portal).
 */
export function clubRouteRedirect(role) {
  return role === 'admin' ? '/admin/dashboard' : null;
}

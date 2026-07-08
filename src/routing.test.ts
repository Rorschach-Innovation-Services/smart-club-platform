import { describe, it, expect } from 'vitest';
import { routingRole, clubRouteRedirect, isOperator } from './routing';

// Regression guard for the bug where an admin, after an in-tab sign-out→sign-in
// from a rep session, was left rendering the club portal at a stale /club/:id URL.
// The /club/:clubId/* route must redirect admins to the admin dashboard.
describe('routingRole', () => {
  it('maps an admin membership to the admin routing role', () => {
    expect(routingRole({ tenantId: 'dolphins', role: 'admin', clubIds: [] })).toBe('admin');
  });
  it('maps a rep membership to the club routing role', () => {
    expect(routingRole({ tenantId: 'dolphins', role: 'rep', clubIds: ['medicoach-cc'] })).toBe(
      'club',
    );
  });
  it('treats a missing/unknown membership as club (never admin)', () => {
    expect(routingRole(null)).toBe('club');
    expect(routingRole(undefined)).toBe('club');
    expect(routingRole({ tenantId: 'dolphins', role: 'something-else' })).toBe('club');
  });
});

// Gate for the /platform/* operator portal — must mirror requirePlatformOperator
// (packages/api/src/auth.ts): ONLY the exact {tenantId:'*', role:'operator'} pair.
describe('isOperator (the /platform/* gate)', () => {
  it('recognises the platform membership', () => {
    expect(isOperator([{ tenantId: '*', role: 'operator', clubIds: [] }])).toBe(true);
  });
  it('recognises it alongside ordinary tenant memberships', () => {
    expect(
      isOperator([
        { tenantId: 'dolphins', role: 'admin', clubIds: [] },
        { tenantId: '*', role: 'operator', clubIds: [] },
      ]),
    ).toBe(true);
  });
  it('rejects a tenant admin, an operator role on a real tenant, and a non-operator on "*"', () => {
    expect(isOperator([{ tenantId: 'dolphins', role: 'admin', clubIds: [] }])).toBe(false);
    expect(isOperator([{ tenantId: 'dolphins', role: 'operator' as never, clubIds: [] }])).toBe(
      false,
    );
    expect(isOperator([{ tenantId: '*', role: 'admin', clubIds: [] }])).toBe(false);
  });
  it('handles empty/missing memberships', () => {
    expect(isOperator([])).toBe(false);
    expect(isOperator(null)).toBe(false);
    expect(isOperator(undefined)).toBe(false);
  });
});

describe('clubRouteRedirect (the /club/:clubId/* guard)', () => {
  it('redirects an admin off the rep club portal to the admin dashboard', () => {
    expect(clubRouteRedirect('admin')).toBe('/admin/dashboard');
  });
  it('lets a rep stay on the club portal (no redirect)', () => {
    expect(clubRouteRedirect('club')).toBeNull();
  });
});

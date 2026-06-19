import { describe, it, expect } from 'vitest';
import { routingRole, clubRouteRedirect } from './routing';

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

describe('clubRouteRedirect (the /club/:clubId/* guard)', () => {
  it('redirects an admin off the rep club portal to the admin dashboard', () => {
    expect(clubRouteRedirect('admin')).toBe('/admin/dashboard');
  });
  it('lets a rep stay on the club portal (no redirect)', () => {
    expect(clubRouteRedirect('club')).toBeNull();
  });
});

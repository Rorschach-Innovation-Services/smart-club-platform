import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

// Mirror the prod TENANT_HOST_MAP from sst.config.ts. Stubbed before importing config.js
// because resolveTenantSlug parses the map once at module load.
vi.stubEnv(
  'VITE_TENANT_HOST_MAP',
  JSON.stringify({
    'dolphinspipeline.medicoach.co.za': 'dolphins',
    'www.dolphinspipeline.medicoach.co.za': 'dolphins',
    'api.dolphinspipeline.medicoach.co.za': 'dolphins',
  }),
);
vi.stubEnv('VITE_DEFAULT_TENANT', 'dolphins');

let resolveTenantSlug;
beforeAll(async () => {
  ({ resolveTenantSlug } = await import('./config'));
});

const atHost = (hostname, search = '') =>
  vi.stubGlobal('window', { location: { hostname, search } });
afterEach(() => vi.unstubAllGlobals());

describe('resolveTenantSlug', () => {
  // Agreement with the backend resolveTenant() for every in-scope prod host.
  it('maps the vanity web host to its tenant (label != slug)', () => {
    atHost('dolphinspipeline.medicoach.co.za');
    expect(resolveTenantSlug()).toBe('dolphins');
  });

  it('maps the www alias to its tenant', () => {
    atHost('www.dolphinspipeline.medicoach.co.za');
    expect(resolveTenantSlug()).toBe('dolphins');
  });

  it('resolves a clean per-union subdomain by leftmost label', () => {
    atHost('lions.medicoach.co.za');
    expect(resolveTenantSlug()).toBe('lions');
  });

  it('falls back to the default tenant for a bare CloudFront host', () => {
    atHost('d111abcdef8.cloudfront.net');
    expect(resolveTenantSlug()).toBe('dolphins');
  });

  it('honors ?tenant= on a bare host (dev)', () => {
    atHost('localhost', '?tenant=lions');
    expect(resolveTenantSlug()).toBe('lions');
  });
});

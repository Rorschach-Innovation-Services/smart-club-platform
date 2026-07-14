/**
 * apiBase() host→API-origin resolution (src/api.ts) + the pure vanity-domain
 * helpers in infra/tenants.ts that derive its VITE_API_HOST_MAP input.
 *
 * The tenants-helper tests live here (not next to infra/tenants.ts) because
 * vitest only collects src/** (see vite.config.ts). Asserting the exact derived
 * values for the dolphins entry pins the sst.config.ts refactor: the rendered
 * prod map/origins must stay value-identical to the old inline constants.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiBase } from './api';
import {
  VANITY,
  hostTenantMap,
  allowedOrigins,
  apiHostMap,
  webOriginMap,
  SHARED_API_HOST,
  type VanityDomain,
} from '../infra/tenants';

const WEB = 'dolphinspipeline.medicoach.co.za';
const API_ORIGIN = 'https://api.dolphinspipeline.medicoach.co.za';
const FALLBACK = 'https://dxxxxxxxx.cloudfront.net';
const SHARED_API_URL = `https://${SHARED_API_HOST}`;

// apiBase() reads import.meta.env at call time, so stubs apply per test.
const atHost = (hostname: string) => vi.stubGlobal('window', { location: { hostname } });
const withMap = (value: string) => vi.stubEnv('VITE_API_HOST_MAP', value);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('apiBase', () => {
  it('returns the mapped API origin for a vanity web host', () => {
    vi.stubEnv('VITE_API_URL', FALLBACK);
    withMap(JSON.stringify({ [WEB]: API_ORIGIN, [`www.${WEB}`]: API_ORIGIN }));
    atHost(WEB);
    expect(apiBase()).toBe(API_ORIGIN);
  });

  it('returns the mapped API origin for the www variant', () => {
    vi.stubEnv('VITE_API_URL', FALLBACK);
    withMap(JSON.stringify({ [WEB]: API_ORIGIN, [`www.${WEB}`]: API_ORIGIN }));
    atHost(`www.${WEB}`);
    expect(apiBase()).toBe(API_ORIGIN);
  });

  it('matches case-insensitively on the hostname', () => {
    withMap(JSON.stringify({ [WEB]: API_ORIGIN }));
    atHost('DolphinsPipeline.Medicoach.co.za');
    expect(apiBase()).toBe(API_ORIGIN);
  });

  it('falls back to VITE_API_URL for an unmapped host (bare CloudFront)', () => {
    vi.stubEnv('VITE_API_URL', FALLBACK);
    withMap(JSON.stringify({ [WEB]: API_ORIGIN }));
    atHost('dxxxxxxxx.cloudfront.net');
    expect(apiBase()).toBe(FALLBACK);
  });

  it('routes a wildcard club host to the shared API URL', () => {
    vi.stubEnv('VITE_API_URL', FALLBACK);
    vi.stubEnv('VITE_WILDCARD_WEB_SUFFIX', '.club.medicoach.co.za');
    vi.stubEnv('VITE_SHARED_API_URL', SHARED_API_URL);
    withMap('{}');
    atHost('demo.club.medicoach.co.za');
    expect(apiBase()).toBe(SHARED_API_URL);
  });

  it('prefers an explicit API-host map entry over the wildcard suffix', () => {
    vi.stubEnv('VITE_API_URL', FALLBACK);
    vi.stubEnv('VITE_WILDCARD_WEB_SUFFIX', '.club.medicoach.co.za');
    vi.stubEnv('VITE_SHARED_API_URL', SHARED_API_URL);
    // A vanity tenant that also happens to live under the suffix keeps its own API host.
    withMap(JSON.stringify({ 'dolphins.club.medicoach.co.za': API_ORIGIN }));
    atHost('dolphins.club.medicoach.co.za');
    expect(apiBase()).toBe(API_ORIGIN);
  });

  it('falls back to VITE_API_URL when the map is malformed JSON (and logs it)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('VITE_API_URL', FALLBACK);
    withMap('{not json');
    atHost(WEB);
    expect(apiBase()).toBe(FALLBACK);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('infra/tenants helpers (dolphins prod rendering)', () => {
  // These exact values are what sst.config.ts used to hardcode inline — the
  // data-driven derivation must reproduce them verbatim.
  it('hostTenantMap covers webHost, www variant, and apiHost', () => {
    expect(hostTenantMap(VANITY)).toEqual({
      [WEB]: 'dolphins',
      [`www.${WEB}`]: 'dolphins',
      ['api.' + WEB]: 'dolphins',
    });
  });

  it('allowedOrigins lists https web origin + www variant', () => {
    expect(allowedOrigins(VANITY)).toEqual([`https://${WEB}`, `https://www.${WEB}`]);
  });

  it('apiHostMap points webHost and www variant at the API origin', () => {
    expect(apiHostMap(VANITY)).toEqual({ [WEB]: API_ORIGIN, [`www.${WEB}`]: API_ORIGIN });
  });

  it('webOriginMap gives slug → canonical vanity origin', () => {
    expect(webOriginMap(VANITY)).toEqual({ dolphins: `https://${WEB}` });
  });

  it('skips disabled entries and omits www when www:false', () => {
    const vanity: VanityDomain[] = [
      ...VANITY,
      {
        slug: 'lions',
        webHost: 'lions.example.co.za',
        www: false,
        apiHost: 'api.lions.example.co.za',
        enabled: true,
      },
      {
        slug: 'ghost',
        webHost: 'ghost.example.co.za',
        www: true,
        apiHost: 'api.ghost.example.co.za',
        enabled: false,
      },
    ];
    const hosts = hostTenantMap(vanity);
    expect(hosts['lions.example.co.za']).toBe('lions');
    expect(hosts['api.lions.example.co.za']).toBe('lions');
    expect(hosts['www.lions.example.co.za']).toBeUndefined();
    expect(Object.keys(hosts).some((h) => h.includes('ghost'))).toBe(false);
    expect(allowedOrigins(vanity)).toEqual([
      `https://${WEB}`,
      `https://www.${WEB}`,
      'https://lions.example.co.za',
    ]);
    expect(apiHostMap(vanity)['lions.example.co.za']).toBe('https://api.lions.example.co.za');
    expect(apiHostMap(vanity)['ghost.example.co.za']).toBeUndefined();
  });

  it('points a vanity tenant with NO apiHost at the shared API host', () => {
    const vanity: VanityDomain[] = [
      {
        slug: 'sharks',
        webHost: 'clubs.sharks.co.za',
        www: true,
        enabled: true,
      },
    ];
    // No per-tenant API host, and no host→tenant entry for one either.
    expect(hostTenantMap(vanity)).toEqual({
      'clubs.sharks.co.za': 'sharks',
      'www.clubs.sharks.co.za': 'sharks',
    });
    expect(apiHostMap(vanity)).toEqual({
      'clubs.sharks.co.za': SHARED_API_URL,
      'www.clubs.sharks.co.za': SHARED_API_URL,
    });
  });
});

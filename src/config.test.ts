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
let applyTheme;
beforeAll(async () => {
  ({ resolveTenantSlug, applyTheme } = await import('./config'));
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

// Minimal document stand-in (vitest runs in node — no jsdom dependency): only the
// surface applyTheme touches. Mirrors index.html's static <link rel="icon">.
const atDocument = () => {
  const rootTokens = {};
  const favicon = {
    href: '/favicon.svg',
    type: 'image/svg+xml',
    removeAttribute(name) {
      delete this[name];
    },
  };
  const doc = {
    title: 'Smart Club Platform',
    documentElement: {
      style: {
        setProperty: (token, value) => {
          rootTokens[token] = value;
        },
      },
    },
    querySelector: (sel) => (sel === 'link[rel="icon"]' ? favicon : null),
  };
  vi.stubGlobal('document', doc);
  return { doc, favicon, rootTokens };
};

describe('applyTheme', () => {
  it('points the favicon link at branding.faviconUrl and drops the stale type hint', () => {
    const { favicon } = atDocument();
    applyTheme({ faviconUrl: '/dolphins-logo.png', logoUrl: '/other.png' });
    expect(favicon.href).toBe('/dolphins-logo.png');
    expect(favicon.type).toBeUndefined();
  });

  it('falls back to logoUrl when faviconUrl is absent', () => {
    const { favicon } = atDocument();
    applyTheme({ logoUrl: '/dolphins-logo.png' });
    expect(favicon.href).toBe('/dolphins-logo.png');
  });

  it('leaves the neutral favicon alone when branding carries no image', () => {
    const { favicon } = atDocument();
    applyTheme({ title: 'Dolphins Pipeline' });
    expect(favicon.href).toBe('/favicon.svg');
    expect(favicon.type).toBe('image/svg+xml');
  });

  it('sets color tokens verbatim — including url() values like --hero-image', () => {
    const { rootTokens, doc } = atDocument();
    applyTheme({
      colors: { '--green': '#0E3529', '--hero-image': "url('/venues/kingsmead-stadium.jpg')" },
      title: 'Dolphins Pipeline — Smart Club Integration',
    });
    expect(rootTokens['--green']).toBe('#0E3529');
    expect(rootTokens['--hero-image']).toBe("url('/venues/kingsmead-stadium.jpg')");
    expect(doc.title).toBe('Dolphins Pipeline — Smart Club Integration');
  });

  it('is a no-op for a null/undefined branding payload', () => {
    const { favicon, doc } = atDocument();
    applyTheme(null);
    applyTheme(undefined);
    expect(favicon.href).toBe('/favicon.svg');
    expect(doc.title).toBe('Smart Club Platform');
  });
});

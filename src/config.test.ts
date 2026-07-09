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
  const created: { rel: string; href: string; dataset: Record<string, string> }[] = [];
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
    head: { appendChild: (el) => created.push(el) },
    createElement: () => ({ rel: '', href: '', dataset: {} }),
    querySelector: (sel) => (sel === 'link[rel="icon"]' ? favicon : null),
  };
  vi.stubGlobal('document', doc);
  return { doc, favicon, rootTokens, created };
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

  it('rewrites a legacy value-named key onto its semantic role token', () => {
    const { rootTokens, doc } = atDocument();
    applyTheme({
      colors: { '--green': '#0E3529', '--hero-image': "url('/venues/kingsmead-stadium.jpg')" },
      title: 'Dolphins Pipeline — Smart Club Integration',
    });
    // --green maps to --brand-primary (the primitives alias the role in index.html).
    expect(rootTokens['--brand-primary']).toBe('#0E3529');
    expect(rootTokens['--green']).toBeUndefined();
    // Non-legacy tokens (hero, role keys, custom extras) are set verbatim.
    expect(rootTokens['--hero-image']).toBe("url('/venues/kingsmead-stadium.jpg')");
    expect(doc.title).toBe('Dolphins Pipeline — Smart Club Integration');
  });

  it('sets role-keyed tokens verbatim', () => {
    const { rootTokens } = atDocument();
    applyTheme({ colors: { '--brand-primary': '#123456', '--brand-accent': '#ABCDEF' } });
    expect(rootTokens['--brand-primary']).toBe('#123456');
    expect(rootTokens['--brand-accent']).toBe('#ABCDEF');
  });

  it('sets --brand-font and injects a web-font stylesheet when a font is given', () => {
    const { rootTokens, created } = atDocument();
    applyTheme({ font: { family: 'Poppins', url: 'https://fonts.example/poppins.css' } });
    expect(rootTokens['--brand-font']).toBe("Poppins, 'Montserrat', sans-serif");
    expect(created).toHaveLength(1);
    expect(created[0].href).toBe('https://fonts.example/poppins.css');
    expect(created[0].rel).toBe('stylesheet');
  });

  it('is a no-op for a null/undefined branding payload', () => {
    const { favicon, doc } = atDocument();
    applyTheme(null);
    applyTheme(undefined);
    expect(favicon.href).toBe('/favicon.svg');
    expect(doc.title).toBe('Smart Club Platform');
  });
});

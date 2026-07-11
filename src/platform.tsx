/**
 * Platform operator portal (/platform/*) — the cross-tenant client console.
 *
 * Rendered by main.tsx inside the authenticated shell but OUTSIDE any tenant
 * membership: the gate is the platform membership {tenantId:'*', role:'operator'}
 * (isOperator in routing.ts, mirroring requirePlatformOperator on the API).
 * Three screens: client list → per-client settings (identity, branding, copy,
 * color tokens, feature flags, league catalogue, deadline, admins, DNS go-live
 * sheet) → a create-client wizard. All writes go through the /platform/* client
 * in api.ts.
 */
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode, CSSProperties } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { queryClient, qk } from './query';
import * as api from './api';
import { ApiError, EMAIL_RE } from './api';
import { resolveCopy } from './branding';
import { Icon, Pill, Btn, EmptyState, useToast, useEscapeClose } from './atoms';
import { LeagueForm } from './admin';
import type { TenantConfig, TenantSummary, BrandingCopy, League } from './types';
import {
  BRAND_ROLES,
  HERO_TOKEN,
  CANONICAL_ROLE_TOKENS,
  THEME_PRESETS,
  DEFAULT_BRAND_COLORS,
  LEGACY_TO_ROLE,
  isValidHex,
  hex6,
  onColor,
  contrastRatio,
  deriveScale,
  defaultHeroGradient,
  fontStack,
} from './platform-theme';

/* ─── Contract mirrors (keep in sync with the API) ─── */

// Mirrors packages/api/src/tenant-validation.ts so the wizard rejects a bad slug
// before the round-trip; the server remains authoritative (409/400 handled inline).
const TENANT_SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;
const RESERVED_TENANT_SLUGS = ['www', 'api', 'platform', 'admin', '*'];
function slugProblem(slug: string): string | null {
  if (!TENANT_SLUG_RE.test(slug))
    return 'slug must be 2–32 chars: a lowercase letter, then lowercase letters, digits or hyphens';
  if (RESERVED_TENANT_SLUGS.includes(slug)) return `slug "${slug}" is reserved`;
  return null;
}

// Mirrors LOGO_CONTENT_TYPES / MAX_LOGO_BYTES on POST …/logo-upload.
const LOGO_TYPES = ['image/png', 'image/svg+xml', 'image/webp'];
const MAX_LOGO_BYTES = 1024 * 1024;

/** The org-copy slots resolveCopy (src/branding.ts) falls back over. */
// Order matters for the Copy card's 2-column grid: heroBlurb (the only full-width
// textarea) is LAST so the ten single-line fields fill complete rows above it with
// no orphaned cell. The save loop is order-independent, so this is display-only.
const COPY_SLOTS: { key: keyof BrandingCopy & string; label: string; hint?: string }[] = [
  {
    key: 'orgShort',
    label: 'Short org name',
    hint: 'Feeds the derived defaults in the other slots.',
  },
  { key: 'welcome', label: 'Sign-in welcome' },
  { key: 'eyebrow', label: 'Sign-in eyebrow' },
  { key: 'office', label: 'Office label' },
  { key: 'admin', label: 'Administrators label' },
  {
    key: 'support',
    label: 'Support contact',
    hint: '“Name · email” — tenant admins edit this too.',
  },
  { key: 'footer', label: 'Footer credit' },
  { key: 'cohortName', label: 'Cohort name' },
  { key: 'heroTitle', label: 'Hero title' },
  { key: 'crumbRoot', label: 'Breadcrumb root' },
  { key: 'heroBlurb', label: 'Hero blurb' },
];

/**
 * Known per-tenant feature flags (an open map — customs are allowed too).
 * `def` mirrors the API-side default (hasFeature) applied when the key is
 * absent from the row, so the portal shows the EFFECTIVE state.
 */
const KNOWN_FLAGS = [
  {
    key: 'whatsappInvites',
    label: 'WhatsApp invites',
    hint: 'Staff invites & fixtures also go out over WhatsApp.',
    def: true,
  },
  {
    key: 'selfServeBranding',
    label: 'Self-serve branding',
    hint: 'Tenant admins may edit their own branding.',
    def: false,
  },
];

const fmtDate = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

const MONO: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12.5,
};
const ERR: CSSProperties = { color: 'var(--coral, #C0392B)', fontSize: 12, marginTop: 6 };
const HINT: CSSProperties = { fontSize: 11.5, color: 'var(--muted-2)', margin: '8px 0 0' };

type Toast = (m: string, t?: string) => void;

/* ─── Shared bits ─── */

function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className ? `field ${className}` : 'field'} style={{ marginBottom: 12 }}>
      <div className="field-label">{label}</div>
      {children}
      {error && <div style={ERR}>{error}</div>}
      {hint && !error && <p style={HINT}>{hint}</p>}
    </div>
  );
}

/** On/off chip toggle — same palette as the Settings status chips. */
function FlagToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 12px',
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 700,
        fontFamily: "'Montserrat',sans-serif",
        border: '1px solid var(--line)',
        cursor: 'pointer',
        background: on ? 'var(--green-pale)' : 'var(--line2)',
        color: on ? 'var(--green)' : 'var(--muted-2)',
      }}
    >
      <span className={`sdot ${on ? 'teal' : 'muted'}`} />
      {on ? 'On' : 'Off'}
    </button>
  );
}

/** Card — same surface as atoms.Card but with its own save footer wiring. */
function Panel({
  title,
  sub,
  children,
  style,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="card" style={style}>
      <div className="card-head">
        <div>
          <div className="card-title">{title}</div>
          {sub && <div className="card-sub">{sub}</div>}
        </div>
      </div>
      <div className="card-body">{children}</div>
    </div>
  );
}

function LogoThumb({ url, name, size = 30 }: { url?: string; name: string; size?: number }) {
  return url ? (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Tenant marks are routinely light-on-transparent — preview on the dark brand green.
        background: 'var(--green, #0B3D2E)',
        overflow: 'hidden',
      }}
    >
      <img src={url} alt="" style={{ maxWidth: '80%', maxHeight: '80%', objectFit: 'contain' }} />
    </span>
  ) : (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--paper)',
        border: '1px solid var(--line)',
        color: 'var(--muted-2)',
        fontFamily: "'Montserrat',sans-serif",
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {(name || '?')[0].toUpperCase()}
    </span>
  );
}

/* ─── Portal chrome: header + nav + routes ─── */

export function PlatformPortal({
  userEmail,
  signOutUser,
  hasTenantConsole,
}: {
  userEmail: string;
  signOutUser: () => void;
  hasTenantConsole: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [toastShow, toastNode] = useToast();
  const path = location.pathname;
  const onClients = path === '/platform' || path.startsWith('/platform/tenants');

  return (
    <div data-screen-label="Platform · operator">
      <header className="app-header">
        <span className="h-sub" style={{ color: '#fff', fontWeight: 700 }}>
          Smart Club Platform
        </span>
        <div className="h-divider" />
        <span className="h-sub">Operator console</span>
        <div className="h-spacer" />
        <button className="h-switch" onClick={signOutUser} title="Sign out">
          <svg viewBox="0 0 16 16" fill="none">
            <path
              d="M9 2H4a1 1 0 00-1 1v10a1 1 0 001 1h5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M11 5l3 3-3 3M7 8h7"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Sign out
        </button>
        <div className="h-user">
          <div className="h-avatar" style={{ background: 'var(--gold)', color: 'var(--ink)' }}>
            {(userEmail || 'OP').slice(0, 2).toUpperCase()}
          </div>
          <div>
            <div className="h-user-name">{userEmail || 'Operator'}</div>
            <div className="h-user-role">Platform · Operator</div>
          </div>
        </div>
      </header>

      <div className="shell">
        <aside className="nav">
          <div className="nav-section">Platform</div>
          <button
            className={`nav-item ${onClients ? 'active' : ''}`}
            onClick={() => navigate('/platform')}
          >
            <span className="ni-icon">
              <Icon.Clubs />
            </span>
            <span className="ni-label">Clients</span>
          </button>
          <button
            className={`nav-item ${path === '/platform/new' ? 'active' : ''}`}
            onClick={() => navigate('/platform/new')}
          >
            <span className="ni-icon">
              <Icon.Plus />
            </span>
            <span className="ni-label">New client</span>
          </button>

          {hasTenantConsole && (
            <>
              <div className="nav-section" style={{ marginTop: 18 }}>
                Workspace
              </div>
              <button className="nav-item" onClick={() => navigate('/')}>
                <span className="ni-icon">
                  <Icon.Dashboard />
                </span>
                <span className="ni-label">Tenant console</span>
              </button>
            </>
          )}

          <div className="nav-footer">
            <strong>Smart Club Platform</strong> · Operator
            <br />
            <span style={{ color: 'var(--muted-3)' }}>Powered by Medicoach</span>
          </div>
        </aside>

        <main className="main">
          <Routes>
            <Route path="/platform" element={<TenantListPage />} />
            <Route path="/platform/new" element={<CreateTenantWizard toast={toastShow} />} />
            <Route path="/platform/tenants/:slug" element={<TenantEditPage toast={toastShow} />} />
            <Route path="*" element={<Navigate to="/platform" replace />} />
          </Routes>
        </main>
      </div>
      {toastNode}
    </div>
  );
}

/* ─── Client list ─── */

function TenantListPage() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: qk.platformTenants(), queryFn: api.platformListTenants });
  const tenants = q.data ?? [];

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Platform / Clients</div>
          <h1 className="ph-title">
            Client <em>unions</em>
          </h1>
          <p className="ph-desc">
            Every tenant on the platform — branding, deadline and admin access at a glance.
          </p>
        </div>
        <div className="ph-actions">
          <Btn tone="teal" size="sm" icon={Icon.Plus} onClick={() => navigate('/platform/new')}>
            New client
          </Btn>
        </div>
      </div>

      {q.isLoading ? (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading clients…</p>
      ) : q.isError ? (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>
          Could not load the client registry — refresh to retry.
        </p>
      ) : tenants.length === 0 ? (
        <EmptyState
          icon={Icon.Clubs}
          title="No clients yet"
          sub="Create the first tenant — branding, deadline and its first admin in one pass."
          action={
            <Btn tone="teal" icon={Icon.Plus} onClick={() => navigate('/platform/new')}>
              New client
            </Btn>
          }
        />
      ) : (
        <div className="tbl-w">
          <table className="tbl">
            <thead>
              <tr>
                <th>Client</th>
                <th>Slug</th>
                <th>Deadline</th>
                <th>Admins</th>
                <th>Features</th>
                <th style={{ width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t: TenantSummary) => {
                // Effective flags: explicit truthy keys plus known flags whose
                // per-flag default kicks in when the key is absent from the row.
                const effective = new Set<string>();
                for (const f of KNOWN_FLAGS)
                  if ((t.features?.[f.key] ?? f.def) === true) effective.add(f.key);
                for (const [k, v] of Object.entries(t.features ?? {})) if (v) effective.add(k);
                const flags = [...effective];
                return (
                  <tr
                    key={t.tenant}
                    className="clickable"
                    onClick={() => navigate(`/platform/tenants/${t.tenant}`)}
                  >
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                        <LogoThumb url={t.logoUrl} name={t.name} />
                        <span>
                          <span
                            style={{
                              display: 'block',
                              fontFamily: "'Montserrat',sans-serif",
                              fontSize: 13,
                              fontWeight: 700,
                            }}
                          >
                            {t.name}
                          </span>
                          {t.title && (
                            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t.title}</span>
                          )}
                        </span>
                      </span>
                    </td>
                    <td>
                      <span style={MONO}>{t.tenant}</span>
                    </td>
                    <td>
                      <span style={{ fontSize: 12.5 }}>{fmtDate(t.submissionDeadline)}</span>
                    </td>
                    <td>
                      <span
                        style={{
                          fontFamily: "'Montserrat',sans-serif",
                          fontSize: 13,
                          fontWeight: 700,
                        }}
                      >
                        {t.adminCount}
                      </span>
                    </td>
                    <td>
                      {flags.length === 0 ? (
                        <span style={{ color: 'var(--muted-2)', fontSize: 12 }}>—</span>
                      ) : (
                        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                          {flags.map((k) => (
                            <Pill key={k} tone="teal">
                              {k}
                            </Pill>
                          ))}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', paddingRight: 18 }}>
                      <Icon.Arrow />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ─── Client settings (edit page) ─── */

function TenantEditPage({ toast }: { toast: Toast }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: qk.platformTenant(slug),
    queryFn: () => api.platformGetTenant(slug),
    retry: 0,
  });

  if (q.isLoading) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading client…</p>;
  if (q.isError || !q.data)
    return (
      <div>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 14 }}>
          {q.error instanceof ApiError && q.error.status === 404
            ? `No client with slug “${slug}”.`
            : 'Could not load this client — refresh to retry.'}
        </p>
        <Btn tone="outline" size="sm" onClick={() => navigate('/platform')}>
          All clients
        </Btn>
      </div>
    );
  const config = q.data;

  /**
   * PUT the patch, seed the cache from the authoritative response, refresh the
   * list projection. PUT replaces each top-level key wholesale (shallow merge on
   * the row), so branding/features writers must send the FULL object — the
   * helpers below spread the latest cached value before overriding.
   */
  async function save(patch: Partial<TenantConfig>): Promise<TenantConfig> {
    const next = await api.platformUpdateTenant(slug, patch);
    queryClient.setQueryData(qk.platformTenant(slug), next);
    queryClient.invalidateQueries({ queryKey: qk.platformTenants() });
    return next;
  }
  function latest(): TenantConfig {
    return queryClient.getQueryData<TenantConfig>(qk.platformTenant(slug)) ?? config;
  }
  const saveBranding = (changes: Record<string, unknown>) =>
    save({ branding: { ...latest().branding, ...changes } as TenantConfig['branding'] });

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Platform / Clients / {config.branding?.name ?? slug}</div>
          <h1 className="ph-title">
            {config.branding?.name ?? slug} <em>settings</em>
          </h1>
          <p className="ph-desc">
            Branding, copy, theme tokens, feature flags, leagues, admin access and the vanity-domain
            go-live checklist for this client.
          </p>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" size="sm" onClick={() => navigate('/platform')}>
            All clients
          </Btn>
        </div>
      </div>

      {/* Deliberate, height-balanced tiers — compact identity/access cards in equal-height
          rows, then the two heavy editors full-width, then the go-live checklist. */}
      <div className="settings-layout">
        <div className="settings-row-3">
          <IdentityCard
            key={`id-${config.tenant}`}
            config={config}
            saveBranding={saveBranding}
            toast={toast}
          />
          <LogoCard
            key={`logo-${config.tenant}`}
            config={config}
            saveBranding={saveBranding}
            toast={toast}
          />
          <DeadlineCard key={`dl-${config.tenant}`} config={config} save={save} toast={toast} />
        </div>
        <div className="settings-row-2">
          <FeaturesCard key={`ft-${config.tenant}`} config={config} save={save} toast={toast} />
          <AdminsCard key={`ad-${config.tenant}`} config={config} toast={toast} />
        </div>
        <CopyCard
          key={`cp-${config.tenant}`}
          config={config}
          saveBranding={saveBranding}
          toast={toast}
        />
        <BrandCard
          key={`cl-${config.tenant}`}
          config={config}
          saveBranding={saveBranding}
          toast={toast}
        />
        <LeaguesCard
          key={`lg-${config.tenant}`}
          slug={slug}
          config={config}
          save={save}
          toast={toast}
        />
        <DnsPanel slug={slug} />
      </div>
    </div>
  );
}

type BrandingSaver = (changes: Record<string, unknown>) => Promise<TenantConfig>;

function IdentityCard({
  config,
  saveBranding,
  toast,
}: {
  config: TenantConfig;
  saveBranding: BrandingSaver;
  toast: Toast;
}) {
  const [name, setName] = useState(config.branding?.name ?? '');
  const [title, setTitle] = useState(config.branding?.title ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty =
    name.trim() !== (config.branding?.name ?? '') ||
    title.trim() !== (config.branding?.title ?? '');

  async function saveIt() {
    setErr('');
    if (!name.trim()) {
      setErr('Organisation name is required');
      return;
    }
    setBusy(true);
    try {
      await saveBranding({ name: name.trim(), title: title.trim() });
      toast('Identity saved');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Identity" sub="Shown across the client's portals, emails and sign-in screen.">
      <Field label="Organisation name" error={err}>
        <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Browser title">
        <input
          className="field-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Sharks Smart Club"
        />
      </Field>
      <Field label="Slug" hint="Fixed — it keys the tenant's data and its default host label.">
        <input
          className="field-input"
          value={config.tenant}
          disabled
          style={{ ...MONO, color: 'var(--muted)' }}
        />
      </Field>
      <Btn tone="teal" size="sm" onClick={saveIt} disabled={!dirty || busy}>
        {busy ? 'Saving…' : 'Save identity'}
      </Btn>
    </Panel>
  );
}

function LogoCard({
  config,
  saveBranding,
  toast,
}: {
  config: TenantConfig;
  saveBranding: BrandingSaver;
  toast: Toast;
}) {
  const [logoUrl, setLogoUrl] = useState(config.branding?.logoUrl ?? '');
  const [faviconUrl, setFaviconUrl] = useState(config.branding?.faviconUrl ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<'upload' | 'save' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty =
    logoUrl.trim() !== (config.branding?.logoUrl ?? '') ||
    faviconUrl.trim() !== (config.branding?.faviconUrl ?? '');

  async function onFile(file: File | undefined) {
    if (!file) return;
    setErr('');
    if (!LOGO_TYPES.includes(file.type)) {
      setErr('PNG, SVG or WebP only');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setErr('Logo must be 1 MB or less');
      return;
    }
    setBusy('upload');
    try {
      const post = await api.platformLogoUploadUrl(config.tenant, file.type);
      await api.uploadLogoToS3(post, file);
      // Persist immediately — an unsaved upload would orphan the S3 object.
      await saveBranding({ logoUrl: post.publicUrl });
      setLogoUrl(post.publicUrl);
      toast('Logo uploaded');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Upload failed — try again');
    } finally {
      setBusy(null);
    }
  }

  async function saveUrls() {
    setErr('');
    setBusy('save');
    try {
      // An empty favicon must DROP the key (applyTheme falls back to the logo);
      // undefined is omitted by JSON serialization.
      await saveBranding({
        logoUrl: logoUrl.trim(),
        faviconUrl: faviconUrl.trim() || undefined,
      });
      toast('Branding assets saved');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel title="Logo & favicon" sub="The mark on the sign-in screen, header and browser tab.">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <LogoThumb
          url={logoUrl.trim() || undefined}
          name={config.branding?.name ?? config.tenant}
          size={52}
        />
        <div>
          <input
            ref={fileRef}
            type="file"
            accept={LOGO_TYPES.join(',')}
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              onFile(f);
            }}
          />
          <Btn
            tone="outline"
            size="sm"
            icon={Icon.Upload}
            disabled={!!busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy === 'upload' ? 'Uploading…' : 'Upload logo'}
          </Btn>
          <p style={HINT}>PNG, SVG or WebP · max 1 MB · saved on upload.</p>
        </div>
      </div>
      <Field label="Logo URL">
        <input
          className="field-input"
          style={MONO}
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
        />
      </Field>
      <Field label="Favicon URL" hint="Optional — falls back to the logo.">
        <input
          className="field-input"
          style={MONO}
          value={faviconUrl}
          onChange={(e) => setFaviconUrl(e.target.value)}
          placeholder="https://…/favicon.png"
        />
      </Field>
      {err && <div style={{ ...ERR, marginBottom: 8 }}>{err}</div>}
      <Btn tone="teal" size="sm" onClick={saveUrls} disabled={!dirty || !!busy}>
        {busy === 'save' ? 'Saving…' : 'Save assets'}
      </Btn>
    </Panel>
  );
}

function DeadlineCard({
  config,
  save,
  toast,
}: {
  config: TenantConfig;
  save: (p: Partial<TenantConfig>) => Promise<TenantConfig>;
  toast: Toast;
}) {
  const initial = (config.submissionDeadline ?? '').slice(0, 10);
  const [value, setValue] = useState(initial);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function saveIt() {
    setErr('');
    if (!value || Number.isNaN(Date.parse(value))) {
      setErr('Pick a valid date');
      return;
    }
    setBusy(true);
    try {
      await save({ submissionDeadline: value });
      toast('Deadline saved');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Affiliation deadline"
      sub="The date clubs must submit affiliation, documents and CQI by."
    >
      <Field label="Submission deadline" error={err}>
        <input
          className="field-input"
          type="date"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <Btn tone="teal" size="sm" onClick={saveIt} disabled={value === initial || busy}>
        {busy ? 'Saving…' : 'Save deadline'}
      </Btn>
    </Panel>
  );
}

function FeaturesCard({
  config,
  save,
  toast,
}: {
  config: TenantConfig;
  save: (p: Partial<TenantConfig>) => Promise<TenantConfig>;
  toast: Toast;
}) {
  const [flags, setFlags] = useState<Record<string, boolean>>({ ...(config.features ?? {}) });
  const [newKey, setNewKey] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(flags) !== JSON.stringify(config.features ?? {});
  const customKeys = Object.keys(flags).filter((k) => !KNOWN_FLAGS.some((f) => f.key === k));

  function addKey() {
    const k = newKey.trim();
    setErr('');
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(k)) {
      setErr('Keys start with a letter — letters, digits, - and _ only');
      return;
    }
    if (k in flags || KNOWN_FLAGS.some((f) => f.key === k)) {
      setErr(`"${k}" is already listed`);
      return;
    }
    setFlags({ ...flags, [k]: true });
    setNewKey('');
  }

  async function saveIt() {
    setErr('');
    setBusy(true);
    try {
      await save({ features: flags });
      toast('Features saved');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setBusy(false);
    }
  }

  const row: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '8px 0',
    borderBottom: '1px solid var(--line2)',
  };

  return (
    <Panel title="Features" sub="Per-tenant flags — absent keys fall back to the platform default.">
      {KNOWN_FLAGS.map((f) => (
        <div key={f.key} style={row}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{f.label}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{f.hint}</div>
            <div style={{ ...MONO, fontSize: 11, color: 'var(--muted-2)', marginTop: 2 }}>
              {f.key}
            </div>
          </div>
          <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            {!(f.key in flags) && (
              <span
                style={{
                  fontSize: 10.5,
                  color: 'var(--muted-2)',
                  border: '1px solid var(--line2)',
                  borderRadius: 999,
                  padding: '1px 7px',
                }}
              >
                default
              </span>
            )}
            <FlagToggle
              on={flags[f.key] ?? f.def}
              onChange={(v) => setFlags({ ...flags, [f.key]: v })}
            />
          </div>
        </div>
      ))}
      {customKeys.map((k) => (
        <div key={k} style={row}>
          <div style={MONO}>{k}</div>
          <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <FlagToggle on={!!flags[k]} onChange={(v) => setFlags({ ...flags, [k]: v })} />
            <Btn
              tone="ghost"
              size="sm"
              onClick={() => {
                const next = { ...flags };
                delete next[k];
                setFlags(next);
              }}
            >
              Remove
            </Btn>
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          className="field-input"
          style={{ ...MONO, flex: 1 }}
          placeholder="customFlagKey"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addKey())}
        />
        <Btn tone="outline" size="sm" icon={Icon.Plus} onClick={addKey} disabled={!newKey.trim()}>
          Add
        </Btn>
      </div>
      {err && <div style={ERR}>{err}</div>}
      <div style={{ marginTop: 14 }}>
        <Btn tone="teal" size="sm" onClick={saveIt} disabled={!dirty || busy}>
          {busy ? 'Saving…' : 'Save features'}
        </Btn>
      </div>
    </Panel>
  );
}

/** Modal host for LeagueForm — main.tsx's TaskModal is private (and importing it
 *  would create a cycle), so this reuses the same global task-modal classes. */
function LeagueModal({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children?: ReactNode;
}) {
  useEscapeClose(onClose);
  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal narrow">
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Platform · League catalogue</div>
            <div className="task-modal-head-title">{title}</div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function LeaguesCard({
  slug,
  config,
  save,
  toast,
}: {
  slug: string;
  config: TenantConfig;
  save: (p: Partial<TenantConfig>) => Promise<TenantConfig>;
  toast: Toast;
}) {
  const [form, setForm] = useState<League | 'new' | null>(null);
  const [confirm, setConfirm] = useState<League | null>(null);
  const leagues = config.leagues ?? [];

  /**
   * Rebuild-and-PUT against the server's latest catalogue, not this tab's cache:
   * the tenant admin console writes the same whole array, so a stale operator tab
   * must not silently erase a league created there. LeagueForm swallows rejections,
   * so errors are toasted here before re-throwing (which keeps the modal open).
   */
  async function saveLeagues(
    build: (fresh: League[]) => League[],
    fallback: string,
  ): Promise<void> {
    try {
      const current = await api.platformGetTenant(slug);
      await save({ leagues: build(current.leagues ?? []) });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : fallback, 'warn');
      throw e;
    }
  }

  const onCreate = (league: League) =>
    saveLeagues((fresh) => [...fresh, league], 'Could not create league');
  const onUpdate = (key: string, patch: Partial<League>) =>
    saveLeagues((fresh) => {
      // The refetch can reveal a concurrent delete from the tenant admin console —
      // surface that instead of silently PUTting the catalogue back without it.
      if (!fresh.some((l) => l.key === key))
        throw new ApiError(
          409,
          'This league was deleted in the admin console — it can no longer be edited.',
        );
      // key is the immutable matching token stored on clubs — never overwritten
      return fresh.map((l) => (l.key === key ? { ...l, ...patch, key: l.key } : l));
    }, 'Could not save league');
  function onDelete(league: League) {
    setConfirm(null);
    saveLeagues((fresh) => fresh.filter((l) => l.key !== league.key), 'Could not delete league')
      .then(() => toast(`${league.label} · deleted`))
      .catch(() => {}); // 409 delete-guard (clubs registered) already toasted above
  }

  return (
    <Panel
      title="League catalogue"
      sub="The leagues clubs opt into during affiliation — fixtures are generated per league. Deleting a league clubs are registered for is blocked; that stays a tenant-admin decision."
    >
      {leagues.length === 0 ? (
        <EmptyState
          icon={Icon.Shield}
          title="No leagues yet"
          sub="Create the leagues clubs opt into during affiliation, before this client invites its clubs."
          action={
            <Btn tone="teal" icon={Icon.Plus} onClick={() => setForm('new')}>
              Create your first league
            </Btn>
          }
        />
      ) : (
        <>
          <div className="tbl-w">
            <table className="tbl">
              <thead>
                <tr>
                  <th>League</th>
                  <th>District</th>
                  <th>Group</th>
                  <th>Note</th>
                  <th style={{ width: 130 }}></th>
                </tr>
              </thead>
              <tbody>
                {leagues.map((L) => (
                  <tr key={L.key}>
                    <td>
                      <span style={{ fontWeight: 700 }}>{L.label}</span>
                    </td>
                    <td>
                      <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{L.district}</span>
                    </td>
                    <td>
                      <Pill tone="muted">{L.group}</Pill>
                    </td>
                    <td>
                      <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{L.note ?? ''}</span>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        <Btn tone="outline" size="sm" onClick={() => setForm(L)}>
                          Edit
                        </Btn>
                        <Btn tone="ghost" size="sm" onClick={() => setConfirm(L)}>
                          Delete
                        </Btn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 14 }}>
            <Btn tone="teal" size="sm" icon={Icon.Plus} onClick={() => setForm('new')}>
              Create league
            </Btn>
          </div>
        </>
      )}

      {form && (
        <LeagueModal
          title={
            form !== 'new' ? (
              <>
                Edit <em>league</em>
              </>
            ) : (
              <>
                Create a <em>league</em>
              </>
            )
          }
          onClose={() => setForm(null)}
        >
          <LeagueForm
            league={form !== 'new' ? form : null}
            allLeagues={leagues}
            onCreate={onCreate}
            onUpdate={onUpdate}
            onClose={() => setForm(null)}
            toast={toast}
          />
        </LeagueModal>
      )}

      {confirm &&
        createPortal(
          <div
            className="fix-confirm"
            onClick={(e) => e.target === e.currentTarget && setConfirm(null)}
          >
            <div className="fix-confirm-box">
              <div className="fix-confirm-icon danger">
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 2L22 21H2L12 2z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M12 9v5M12 17v.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <div className="fix-confirm-title">Delete “{confirm.label}”?</div>
              <div className="fix-confirm-body">
                It disappears from this client's affiliation picker and fixture filters. If clubs
                are already registered for it, the delete is blocked.
              </div>
              <div className="fix-confirm-actions">
                <Btn tone="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Btn>
                <Btn tone="ink" onClick={() => onDelete(confirm)}>
                  Yes, delete
                </Btn>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </Panel>
  );
}

function CopyCard({
  config,
  saveBranding,
  toast,
}: {
  config: TenantConfig;
  saveBranding: BrandingSaver;
  toast: Toast;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const { key } of COPY_SLOTS) out[key] = (config.branding?.copy?.[key] as string) ?? '';
    return out;
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // Derived defaults shown as placeholders — recomputed live so editing orgShort
  // updates the office/cohort/hero placeholders it feeds (mirrors resolveCopy).
  const derived = resolveCopy({
    name: config.branding?.name,
    title: config.branding?.title,
    copy: draft.orgShort.trim() ? { orgShort: draft.orgShort.trim() } : {},
  });
  const saved = () => {
    const out: Record<string, string> = {};
    for (const { key } of COPY_SLOTS) out[key] = (config.branding?.copy?.[key] as string) ?? '';
    return out;
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved());

  async function saveIt() {
    setErr('');
    setBusy(true);
    try {
      // Start from the latest saved copy so ad-hoc slots (keys outside COPY_SLOTS)
      // survive a save. Known slots are then overridden: empty slots are DELETED
      // (not stored as '') so the derived default applies.
      const copy: Record<string, string> = {
        ...((config.branding?.copy ?? {}) as Record<string, string>),
      };
      for (const { key } of COPY_SLOTS) {
        const v = (draft[key] ?? '').trim();
        if (v) copy[key] = v;
        else delete copy[key];
      }
      await saveBranding({ copy });
      toast('Copy saved');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Copy"
      sub="Org copy slots — leave a slot blank to use the derived default shown as its placeholder."
    >
      <div className="copy-grid">
        {COPY_SLOTS.map(({ key, label, hint }) => (
          <Field
            key={key}
            label={label}
            hint={hint}
            className={key === 'heroBlurb' ? 'copy-full' : undefined}
          >
            {key === 'heroBlurb' ? (
              <textarea
                className="field-textarea"
                rows={2}
                value={draft[key]}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                placeholder={derived[key] || ''}
              />
            ) : (
              <input
                className="field-input"
                value={draft[key]}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                placeholder={
                  (derived as unknown as Record<string, string>)[key] ||
                  (key === 'support' ? 'Nomsa Dlamini · office@union.co.za' : '')
                }
              />
            )}
          </Field>
        ))}
      </div>
      {err && <div style={{ ...ERR, marginTop: 12, marginBottom: 8 }}>{err}</div>}
      <Btn tone="teal" size="sm" onClick={saveIt} disabled={!dirty || busy}>
        {busy ? 'Saving…' : 'Save copy'}
      </Btn>
    </Panel>
  );
}

/* ─── Brand & theme editor ─── */

/** Editing state for the brand: role/extra colour tokens + the optional typeface. */
interface BrandDraft {
  colors: Record<string, string>;
  font: { family: string; url: string };
}

/** Rewrite any legacy value-named key (--green…) to its semantic role, so the draft is role-keyed. */
function normalizeColors(colors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors)) out[LEGACY_TO_ROLE[k] ?? k] = v;
  return out;
}

/** Drop blank values — a blank token falls back to the app default at runtime. */
function pruneColors(colors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors)) if (String(v).trim()) out[k] = String(v).trim();
  return out;
}

/** Order-independent map compare — the dirty check must not flip on key order alone. */
function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[k] === b[k]);
}

function brandingToDraft(b?: TenantConfig['branding']): BrandDraft {
  return {
    colors: normalizeColors(b?.colors ?? {}),
    font: { family: b?.font?.family ?? '', url: b?.font?.url ?? '' },
  };
}

/** The persisted font shape (undefined when no family set — clears any stored font). */
function draftFontOut(font: BrandDraft['font']): { family: string; url?: string } | undefined {
  const family = font.family.trim();
  if (!family) return undefined;
  const url = font.url.trim();
  return url ? { family, url } : { family };
}

function sameFont(
  a?: { family?: string; url?: string },
  b?: { family?: string; url?: string },
): boolean {
  return (a?.family ?? '') === (b?.family ?? '') && (a?.url ?? '') === (b?.url ?? '');
}

/** A native colour picker styled as a swatch (the pragmatic, universally-understood control). */
function SwatchInput({
  value,
  onChange,
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  title?: string;
}) {
  return (
    <label
      title={title}
      style={{
        position: 'relative',
        width: 34,
        height: 34,
        flexShrink: 0,
        borderRadius: 8,
        border: '1px solid var(--line)',
        background: isValidHex(value) ? value : 'var(--paper2)',
        cursor: 'pointer',
        display: 'inline-block',
      }}
    >
      <input
        type="color"
        value={hex6(value)}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: 0,
          cursor: 'pointer',
          border: 'none',
          padding: 0,
          background: 'none',
        }}
      />
    </label>
  );
}

/** One brand-colour role: swatch picker + label + synced hex field + inline validation. */
function ColorRow({
  role,
  value,
  onChange,
}: {
  role: (typeof BRAND_ROLES)[number];
  value: string;
  onChange: (v: string) => void;
}) {
  const invalid = !!value.trim() && !isValidHex(value);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
      <SwatchInput value={value} onChange={onChange} title={role.label} />
      <div style={{ width: 118, flexShrink: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{role.label}</div>
        <div style={{ ...MONO, fontSize: 10.5, color: 'var(--muted-2)' }}>{role.token}</div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <input
          className="field-input"
          style={{ ...MONO, width: '100%', ...(invalid ? { borderColor: 'var(--coral)' } : {}) }}
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#0B3D2E"
        />
        <div
          style={{
            fontSize: 10.5,
            color: invalid ? 'var(--coral)' : 'var(--muted-2)',
            marginTop: 3,
          }}
        >
          {invalid ? 'Enter a hex colour, e.g. #0B3D2E' : role.hint}
        </div>
      </div>
    </div>
  );
}

/**
 * The reusable brand-editing surface — presets, generate-from-one-colour, per-role
 * pickers, typeface, hero backdrop and a live scoped preview. Controlled: the parent
 * (BrandCard on the detail page, the create wizard) owns the draft. showAdvanced adds
 * the raw-token escape hatch for arbitrary/legacy tokens (detail page only).
 */
function BrandFields({
  value,
  onChange,
  showAdvanced = false,
  split = false,
}: {
  value: BrandDraft;
  onChange: (d: BrandDraft) => void;
  showAdvanced?: boolean;
  /** Lay controls and the live preview side-by-side (client settings page). Off in the
   *  narrow wizard column, where the fields stack. Constant per mounted instance. */
  split?: boolean;
}) {
  const { colors, font } = value;
  const [base, setBase] = useState(() =>
    isValidHex(colors['--brand-primary']) ? colors['--brand-primary'] : '#0E3529',
  );
  const [newToken, setNewToken] = useState('');
  const [newValue, setNewValue] = useState('');
  const [advErr, setAdvErr] = useState('');

  const setColors = (patch: Record<string, string>) =>
    onChange({ ...value, colors: { ...colors, ...patch } });
  const setColor = (token: string, v: string) => setColors({ [token]: v });
  const setFont = (patch: Partial<BrandDraft['font']>) =>
    onChange({ ...value, font: { ...font, ...patch } });
  const removeToken = (t: string) => {
    const next = { ...colors };
    delete next[t];
    onChange({ ...value, colors: next });
  };

  const extraTokens = Object.keys(colors).filter((t) => !CANONICAL_ROLE_TOKENS.includes(t));
  const hero = colors[HERO_TOKEN] ?? '';
  const primary = colors['--brand-primary'] ?? '';
  const lightPrimary = isValidHex(primary) && contrastRatio(primary, '#FFFFFF') < 4.5;

  // Scoped preview: the draft roles are set as CSS vars on this wrapper only — never
  // on :root — so the mock reflects edits without fighting applyTheme.
  const previewVars: Record<string, string> = { fontFamily: fontStack(font.family) };
  for (const r of BRAND_ROLES)
    if (isValidHex(colors[r.token])) previewVars[r.token] = colors[r.token];
  previewVars['--brand-on-primary'] = isValidHex(primary) ? onColor(primary) : '#FFFFFF';
  previewVars[HERO_TOKEN] = hero || defaultHeroGradient(colors);

  function addToken() {
    const t = newToken.trim();
    setAdvErr('');
    if (!/^--[a-z][a-z0-9-]*$/i.test(t)) {
      setAdvErr('Tokens are CSS custom properties, e.g. --brand-primary');
      return;
    }
    if (t in colors) {
      setAdvErr(`${t} is already listed`);
      return;
    }
    setColors({ [t]: newValue.trim() });
    setNewToken('');
    setNewValue('');
  }

  return (
    <div className={split ? 'brand-split' : undefined}>
      <div>
        <div className="field-label">Starter palettes</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '6px 0 16px' }}>
          {THEME_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onChange({ ...value, colors: { ...colors, ...p.colors } })}
              title={`Use the ${p.label} palette`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 12px 5px 6px',
                borderRadius: 999,
                border: '1px solid var(--line)',
                background: 'var(--white)',
                fontSize: 11.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  display: 'flex',
                  borderRadius: 999,
                  overflow: 'hidden',
                  border: '1px solid var(--line)',
                }}
              >
                {['--brand-primary', '--brand-primary-bright', '--brand-accent'].map((t) => (
                  <span key={t} style={{ width: 13, height: 13, background: p.colors[t] }} />
                ))}
              </span>
              {p.label}
            </button>
          ))}
        </div>

        <Field
          label="Base brand colour"
          hint="Pick one colour, then Generate to derive the primary scale (deep → tint). Fine-tune any role below."
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <SwatchInput value={base} onChange={setBase} title="Base brand colour" />
            <input
              className="field-input"
              style={{ ...MONO, flex: 1, minWidth: 0 }}
              value={base}
              spellCheck={false}
              onChange={(e) => setBase(e.target.value)}
              placeholder="#0E3529"
            />
            <Btn
              tone="teal"
              size="sm"
              onClick={() => onChange({ ...value, colors: { ...colors, ...deriveScale(base) } })}
              disabled={!isValidHex(base)}
            >
              Generate
            </Btn>
          </div>
        </Field>

        <div className="field-label" style={{ marginTop: 4 }}>
          Colour roles
        </div>
        <div style={{ margin: '8px 0 2px' }}>
          {BRAND_ROLES.map((r) => (
            <ColorRow
              key={r.token}
              role={r}
              value={colors[r.token] ?? ''}
              onChange={(v) => setColor(r.token, v)}
            />
          ))}
        </div>
        {lightPrimary && (
          <div
            style={{ fontSize: 11.5, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.5 }}
          >
            Light primary — white text on primary buttons may read as low-contrast.
          </div>
        )}

        <Field
          label="Typeface"
          hint="Optional. A font-family name; add a web-font stylesheet URL if it isn't a system font."
        >
          <input
            className="field-input"
            placeholder="Montserrat"
            value={font.family}
            onChange={(e) => setFont({ family: e.target.value })}
          />
          <input
            className="field-input"
            style={{ ...MONO, fontSize: 11.5, marginTop: 8 }}
            placeholder="https://fonts.googleapis.com/css2?family=…&display=swap"
            value={font.url}
            spellCheck={false}
            onChange={(e) => setFont({ url: e.target.value })}
          />
        </Field>

        <Field
          label="Hero backdrop"
          hint="A url('…') image or any CSS background. Blank uses a gradient built from your primary."
        >
          <input
            className="field-input"
            style={{ ...MONO, fontSize: 11.5 }}
            placeholder="url('/venues/ground.jpg')"
            value={hero}
            spellCheck={false}
            onChange={(e) => setColor(HERO_TOKEN, e.target.value)}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span
              style={{
                width: 66,
                height: 38,
                borderRadius: 8,
                flexShrink: 0,
                border: '1px solid var(--line)',
                backgroundImage: hero || defaultHeroGradient(colors),
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            />
            <Btn
              tone="outline"
              size="sm"
              onClick={() => setColor(HERO_TOKEN, defaultHeroGradient(colors))}
            >
              Use generated gradient
            </Btn>
            {hero && (
              <Btn tone="ghost" size="sm" onClick={() => removeToken(HERO_TOKEN)}>
                Clear
              </Btn>
            )}
          </div>
        </Field>
      </div>

      <div className={split ? 'brand-preview' : undefined}>
        <div className="field-label" style={{ marginTop: 4 }}>
          Preview
        </div>
        <div
          style={{
            ...(previewVars as CSSProperties),
            marginTop: 8,
            borderRadius: 12,
            overflow: 'hidden',
            border: '1px solid var(--line)',
          }}
        >
          <div
            style={{
              backgroundImage: 'var(--hero-image)',
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              padding: '20px 16px',
              color: '#fff',
            }}
          >
            <div
              style={{
                fontSize: 10.5,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                opacity: 0.85,
              }}
            >
              Your union · 2026 / 27
            </div>
            <div style={{ fontSize: 17, fontWeight: 800, marginTop: 4 }}>
              From your club to the top.
            </div>
          </div>
          <div style={{ background: 'var(--white)', padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span
                style={{
                  padding: '7px 14px',
                  borderRadius: 8,
                  background: 'var(--brand-primary)',
                  color: 'var(--brand-on-primary)',
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                Primary action
              </span>
              <span
                style={{ color: 'var(--brand-primary-bright)', fontSize: 12.5, fontWeight: 700 }}
              >
                A link
              </span>
              <span
                style={{
                  padding: '5px 10px',
                  borderRadius: 999,
                  background: 'var(--brand-primary-tint)',
                  color: 'var(--brand-primary)',
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                Badge
              </span>
              <span
                style={{
                  padding: '5px 10px',
                  borderRadius: 999,
                  background: 'var(--brand-accent)',
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                Accent
              </span>
            </div>
            <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--muted)' }}>
              Sample body text rendered in the tenant typeface.
            </p>
          </div>
        </div>

        {showAdvanced && (
          <details style={{ marginTop: 14 }}>
            <summary
              style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', cursor: 'pointer' }}
            >
              Advanced — raw tokens{extraTokens.length ? ` (${extraTokens.length})` : ''}
            </summary>
            <div style={{ marginTop: 10 }}>
              {extraTokens.map((t) => (
                <div
                  key={t}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}
                >
                  <span
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 5,
                      flexShrink: 0,
                      border: '1px solid var(--line)',
                      background: colors[t] || 'transparent',
                    }}
                  />
                  <span style={{ ...MONO, width: 116, flexShrink: 0, color: 'var(--muted)' }}>
                    {t}
                  </span>
                  <input
                    className="field-input"
                    style={{ ...MONO, flex: 1, minWidth: 0 }}
                    value={colors[t] ?? ''}
                    spellCheck={false}
                    onChange={(e) => setColor(t, e.target.value)}
                  />
                  <Btn tone="ghost" size="sm" onClick={() => removeToken(t)}>
                    Remove
                  </Btn>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input
                  className="field-input"
                  style={{ ...MONO, width: 116, flexShrink: 0 }}
                  placeholder="--token"
                  value={newToken}
                  onChange={(e) => setNewToken(e.target.value)}
                />
                <input
                  className="field-input"
                  style={{ ...MONO, flex: 1, minWidth: 0 }}
                  placeholder="#0B3D2E"
                  value={newValue}
                  spellCheck={false}
                  onChange={(e) => setNewValue(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addToken())}
                />
                <Btn
                  tone="outline"
                  size="sm"
                  icon={Icon.Plus}
                  onClick={addToken}
                  disabled={!newToken.trim()}
                >
                  Add
                </Btn>
              </div>
              {advErr && <div style={ERR}>{advErr}</div>}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

/** The client detail-page brand editor — wraps BrandFields with draft state + save. */
function BrandCard({
  config,
  saveBranding,
  toast,
}: {
  config: TenantConfig;
  saveBranding: BrandingSaver;
  toast: Toast;
}) {
  const [draft, setDraft] = useState<BrandDraft>(() => brandingToDraft(config.branding));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const savedColors = pruneColors(normalizeColors(config.branding?.colors ?? {}));
  const prunedColors = pruneColors(draft.colors);
  const fontOut = draftFontOut(draft.font);
  const invalid = BRAND_ROLES.some(
    (r) => !!draft.colors[r.token]?.trim() && !isValidHex(draft.colors[r.token]),
  );
  const dirty = !sameMap(prunedColors, savedColors) || !sameFont(fontOut, config.branding?.font);

  async function saveIt() {
    setErr('');
    setBusy(true);
    try {
      // Blank tokens are dropped (app default applies); font undefined clears any stored font.
      await saveBranding({ colors: prunedColors, font: fontOut });
      toast('Branding saved');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Brand & theme"
      sub="Colours, typeface and hero backdrop, injected at runtime. Blank colours fall back to the app default; edits preview live below."
    >
      <BrandFields value={draft} onChange={setDraft} showAdvanced split />
      {err && <div style={ERR}>{err}</div>}
      <div style={{ marginTop: 14 }}>
        <Btn tone="teal" size="sm" onClick={saveIt} disabled={!dirty || busy || invalid}>
          {busy ? 'Saving…' : 'Save branding'}
        </Btn>
      </div>
    </Panel>
  );
}

function AdminsCard({ config, toast }: { config: TenantConfig; toast: Toast }) {
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(config.adminCount ?? 0);

  async function add() {
    const addr = email.trim().toLowerCase();
    setErr('');
    if (!EMAIL_RE.test(addr)) {
      setErr('Enter a valid email address');
      return;
    }
    setBusy(true);
    try {
      const res = await api.platformAddAdmin(config.tenant, addr);
      setCount(res.adminCount);
      setEmail('');
      queryClient.invalidateQueries({ queryKey: qk.platformTenants() });
      queryClient.invalidateQueries({ queryKey: qk.platformTenant(config.tenant) });
      toast(`${res.email} granted admin access`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not add the admin — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Admins" sub="Tenant administrators — they sign in with an email one-time code.">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 14 }}>
        <span style={{ fontFamily: "'Montserrat',sans-serif", fontSize: 22, fontWeight: 800 }}>
          {count}
        </span>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>admin{count === 1 ? '' : 's'}</span>
      </div>
      <Field
        label="Add an admin"
        error={err}
        hint="Idempotent — re-adding an existing admin is safe."
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="field-input"
            type="email"
            style={{ flex: 1 }}
            placeholder="admin@union.co.za"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
          />
          <Btn
            tone="teal"
            size="sm"
            icon={Icon.Plus}
            onClick={add}
            disabled={busy || !email.trim()}
          >
            {busy ? 'Adding…' : 'Add'}
          </Btn>
        </div>
      </Field>
    </Panel>
  );
}

function DnsPanel({ slug }: { slug: string }) {
  const q = useQuery({ queryKey: qk.platformDns(slug), queryFn: () => api.platformDnsSheet(slug) });
  const sheet = q.data;

  return (
    <Panel
      title="DNS / go-live"
      sub="The vanity-domain checklist — values in ‹angle brackets› are operator-filled from the deploy outputs."
    >
      {q.isLoading ? (
        <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>Loading checklist…</p>
      ) : q.isError || !sheet ? (
        <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
          Could not load the checklist — refresh to retry.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6, margin: '0 0 16px' }}>
            {sheet.note}
          </p>
          <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {sheet.steps.map((s, i) => (
              <li
                key={s.key}
                style={{
                  display: 'flex',
                  gap: 14,
                  padding: '14px 0',
                  borderTop: i === 0 ? 'none' : '1px solid var(--line2)',
                }}
              >
                <span
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--green-pale)',
                    color: 'var(--green)',
                    fontFamily: "'Montserrat',sans-serif",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  {i + 1}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{ fontSize: 13, fontWeight: 700, fontFamily: "'Montserrat',sans-serif" }}
                  >
                    {s.title}
                  </div>
                  <p
                    style={{
                      fontSize: 12.5,
                      color: 'var(--muted)',
                      lineHeight: 1.6,
                      margin: '4px 0 0',
                    }}
                  >
                    {s.detail}
                  </p>
                  {s.records && (
                    <div style={{ overflowX: 'auto', marginTop: 10 }}>
                      <table style={{ borderCollapse: 'collapse', ...MONO }}>
                        <thead>
                          <tr>
                            {['Type', 'Host', 'Target'].map((h) => (
                              <th
                                key={h}
                                style={{
                                  textAlign: 'left',
                                  padding: '4px 18px 4px 0',
                                  fontSize: 11,
                                  color: 'var(--muted-2)',
                                  fontWeight: 600,
                                }}
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {s.records.map((r, j) => (
                            <tr key={j}>
                              <td style={{ padding: '4px 18px 4px 0' }}>{r.type}</td>
                              <td style={{ padding: '4px 18px 4px 0' }}>{r.host}</td>
                              <td style={{ padding: '4px 18px 4px 0', color: 'var(--muted)' }}>
                                {r.target}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </Panel>
  );
}

/* ─── Create-client wizard ─── */

// Named step indices — the wizard hops these by name, not by fragile integer literals.
const STEP = {
  Slug: 0,
  Identity: 1,
  Logo: 2,
  Brand: 3,
  Deadline: 4,
  Admin: 5,
  Done: 6,
} as const;
const WIZARD_STEPS = ['Slug', 'Identity', 'Logo', 'Brand', 'Deadline', 'First admin'];

function CreateTenantWizard({ toast }: { toast: Toast }) {
  const navigate = useNavigate();
  const [step, setStep] = useState<number>(STEP.Slug);
  const [brand, setBrand] = useState<BrandDraft>(() => ({
    colors: { ...DEFAULT_BRAND_COLORS },
    font: { family: '', url: '' },
  }));
  const [slug, setSlug] = useState('');
  const [slugErr, setSlugErr] = useState('');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [nameErr, setNameErr] = useState('');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState('');
  const [logoErr, setLogoErr] = useState('');
  const [deadline, setDeadline] = useState('');
  const [deadlineErr, setDeadlineErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<TenantConfig | null>(null);
  const [logoOutcome, setLogoOutcome] = useState<'done' | 'failed' | null>(null);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminErr, setAdminErr] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminDone, setAdminDone] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // Revoke the last preview object URL when the wizard unmounts (pickLogo/clearLogo
  // revoke the previous one on replacement, but nothing else frees the final one).
  const logoPreviewRef = useRef('');
  logoPreviewRef.current = logoPreview;
  useEffect(
    () => () => {
      if (logoPreviewRef.current) URL.revokeObjectURL(logoPreviewRef.current);
    },
    [],
  );

  function nextFromSlug() {
    const s = slug.trim().toLowerCase();
    const problem = slugProblem(s);
    setSlugErr(problem ?? '');
    if (problem) return;
    setSlug(s);
    setStep(STEP.Identity);
  }
  function nextFromName() {
    if (!name.trim()) {
      setNameErr('Organisation name is required');
      return;
    }
    setNameErr('');
    setStep(STEP.Logo);
  }
  function pickLogo(file: File | undefined) {
    setLogoErr('');
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) {
      setLogoErr('PNG, SVG or WebP only');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoErr('Logo must be 1 MB or less');
      return;
    }
    // One object URL per pick (not per render) — revoke the previous preview.
    if (logoPreview) URL.revokeObjectURL(logoPreview);
    setLogoPreview(URL.createObjectURL(file));
    setLogoFile(file);
  }
  function clearLogo() {
    if (logoPreview) URL.revokeObjectURL(logoPreview);
    setLogoPreview('');
    setLogoFile(null);
  }

  /**
   * Create on the deadline step. The logo (if picked) uploads AFTER the create —
   * the presign route 404s for a tenant that doesn't exist yet — and a failed
   * upload degrades to a warning (the client exists; retry from its settings).
   */
  async function createClient() {
    setDeadlineErr('');
    if (!deadline || Number.isNaN(Date.parse(deadline))) {
      setDeadlineErr('Pick the affiliation deadline');
      return;
    }
    setCreating(true);
    try {
      const brandFont = draftFontOut(brand.font);
      const cfg = await api.platformCreateTenant({
        slug,
        branding: {
          name: name.trim(),
          ...(title.trim() ? { title: title.trim() } : {}),
          colors: pruneColors(brand.colors),
          ...(brandFont ? { font: brandFont } : {}),
        },
        submissionDeadline: deadline,
      });
      queryClient.invalidateQueries({ queryKey: qk.platformTenants() });
      let finalCfg = cfg;
      if (logoFile) {
        try {
          const post = await api.platformLogoUploadUrl(cfg.tenant, logoFile.type);
          await api.uploadLogoToS3(post, logoFile);
          finalCfg = await api.platformUpdateTenant(cfg.tenant, {
            branding: { ...cfg.branding, logoUrl: post.publicUrl },
          });
          setLogoOutcome('done');
        } catch (e) {
          console.error('wizard logo upload failed', e);
          setLogoOutcome('failed');
          toast(
            'Client created, but the logo upload failed — retry from its settings page.',
            'warn',
          );
        }
      }
      queryClient.setQueryData(qk.platformTenant(cfg.tenant), finalCfg);
      setCreated(finalCfg);
      setStep(STEP.Admin);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : 'Could not create the client — try again.';
      if (err instanceof ApiError && err.status === 409) {
        setSlugErr(msg);
        setStep(STEP.Slug);
      } else if (err instanceof ApiError && err.status === 400 && /slug/i.test(msg)) {
        setSlugErr(msg);
        setStep(STEP.Slug);
      } else if (err instanceof ApiError && err.status === 400 && /name/i.test(msg)) {
        setNameErr(msg);
        setStep(STEP.Identity);
      } else {
        setDeadlineErr(msg);
      }
    } finally {
      setCreating(false);
    }
  }

  async function addFirstAdmin() {
    if (!created) return;
    const addr = adminEmail.trim().toLowerCase();
    setAdminErr('');
    if (!EMAIL_RE.test(addr)) {
      setAdminErr('Enter a valid email address');
      return;
    }
    setAdminBusy(true);
    try {
      const res = await api.platformAddAdmin(created.tenant, addr);
      setAdminDone(res.email);
      queryClient.invalidateQueries({ queryKey: qk.platformTenants() });
      queryClient.invalidateQueries({ queryKey: qk.platformTenant(created.tenant) });
      setStep(STEP.Done);
    } catch (e) {
      setAdminErr(e instanceof ApiError ? e.message : 'Could not add the admin — try again');
    } finally {
      setAdminBusy(false);
    }
  }

  const footRow: CSSProperties = { display: 'flex', gap: 8, marginTop: 18 };

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Platform / Clients / New</div>
          <h1 className="ph-title">
            New <em>client</em>
          </h1>
          <p className="ph-desc">
            Slug, branding basics, deadline and the first admin — the client is usable on the
            platform host at once; its vanity domain goes live per the DNS sheet.
          </p>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" size="sm" onClick={() => navigate('/platform')}>
            Cancel
          </Btn>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 620 }}>
        <div className="card-body">
          {step < STEP.Done && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
              {WIZARD_STEPS.map((label, i) => (
                <span
                  key={label}
                  title={label}
                  style={{
                    width: i === step ? 22 : 8,
                    height: 8,
                    borderRadius: 999,
                    background:
                      i < step
                        ? 'var(--green)'
                        : i === step
                          ? 'var(--green-mid, var(--green))'
                          : 'var(--line2)',
                    transition: 'width 200ms ease-out',
                  }}
                />
              ))}
              <span style={{ fontSize: 11.5, color: 'var(--muted-2)', marginLeft: 6 }}>
                Step {step + 1} of {WIZARD_STEPS.length} · {WIZARD_STEPS[step]}
              </span>
            </div>
          )}

          {step === STEP.Slug && (
            <>
              <Field
                label="Tenant slug"
                error={slugErr}
                hint="Lowercase letter first; letters, digits and hyphens. It keys the tenant's data and default host label — it cannot change later."
              >
                <input
                  className="field-input"
                  style={MONO}
                  autoFocus
                  placeholder="sharks"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), nextFromSlug())}
                />
              </Field>
              <div style={footRow}>
                <Btn tone="teal" size="sm" onClick={nextFromSlug} disabled={!slug.trim()}>
                  Continue
                </Btn>
              </div>
            </>
          )}

          {step === STEP.Identity && (
            <>
              <Field label="Organisation name" error={nameErr}>
                <input
                  className="field-input"
                  autoFocus
                  placeholder="e.g. Sharks Cricket Union"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), nextFromName())}
                />
              </Field>
              <Field label="Browser title" hint="Optional — the browser-tab title.">
                <input
                  className="field-input"
                  placeholder="e.g. Sharks Smart Club"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <div style={footRow}>
                <Btn tone="ghost" size="sm" onClick={() => setStep(STEP.Slug)}>
                  Back
                </Btn>
                <Btn tone="teal" size="sm" onClick={nextFromName} disabled={!name.trim()}>
                  Continue
                </Btn>
              </div>
            </>
          )}

          {step === STEP.Logo && (
            <>
              <Field
                label="Logo (optional)"
                error={logoErr}
                hint="PNG, SVG or WebP, max 1 MB. It uploads after the client is created — you can also add it later from the settings page."
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <LogoThumb url={logoPreview || undefined} name={name} size={52} />
                  <input
                    ref={fileRef}
                    type="file"
                    accept={LOGO_TYPES.join(',')}
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      pickLogo(f);
                    }}
                  />
                  <Btn
                    tone="outline"
                    size="sm"
                    icon={Icon.Upload}
                    onClick={() => fileRef.current?.click()}
                  >
                    {logoFile ? `Replace ${logoFile.name}` : 'Choose logo'}
                  </Btn>
                  {logoFile && (
                    <Btn tone="ghost" size="sm" onClick={clearLogo}>
                      Clear
                    </Btn>
                  )}
                </div>
              </Field>
              <div style={footRow}>
                <Btn tone="ghost" size="sm" onClick={() => setStep(STEP.Identity)}>
                  Back
                </Btn>
                <Btn tone="teal" size="sm" onClick={() => setStep(STEP.Brand)}>
                  {logoFile ? 'Continue' : 'Skip for now'}
                </Btn>
              </div>
            </>
          )}

          {step === STEP.Brand && (
            <>
              <p
                style={{
                  fontSize: 12.5,
                  color: 'var(--muted)',
                  margin: '0 0 14px',
                  lineHeight: 1.6,
                }}
              >
                Set this client's colours, typeface and hero backdrop — or keep the default and
                refine it later from the settings page.
              </p>
              <BrandFields value={brand} onChange={setBrand} />
              <div style={footRow}>
                <Btn tone="ghost" size="sm" onClick={() => setStep(STEP.Logo)}>
                  Back
                </Btn>
                <Btn tone="teal" size="sm" onClick={() => setStep(STEP.Deadline)}>
                  Continue
                </Btn>
              </div>
            </>
          )}

          {step === STEP.Deadline && (
            <>
              <Field
                label="Affiliation deadline"
                error={deadlineErr}
                hint="The date clubs must submit affiliation, documents and CQI by — editable later."
              >
                <input
                  className="field-input"
                  type="date"
                  autoFocus
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                />
              </Field>
              <div style={footRow}>
                <Btn tone="ghost" size="sm" onClick={() => setStep(STEP.Brand)} disabled={creating}>
                  Back
                </Btn>
                <Btn tone="teal" size="sm" onClick={createClient} disabled={creating || !deadline}>
                  {creating ? 'Creating…' : 'Create client'}
                </Btn>
              </div>
            </>
          )}

          {step === STEP.Admin && created && (
            <>
              <p
                style={{
                  fontSize: 12.5,
                  color: 'var(--muted)',
                  margin: '0 0 14px',
                  lineHeight: 1.6,
                }}
              >
                <strong>{created.branding?.name}</strong> is created. Grant its first administrator
                — they sign in with an email one-time code, no password.
              </p>
              <Field label="First admin email" error={adminErr}>
                <input
                  className="field-input"
                  type="email"
                  autoFocus
                  placeholder="admin@union.co.za"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addFirstAdmin())}
                />
              </Field>
              <div style={footRow}>
                <Btn tone="ghost" size="sm" onClick={() => setStep(STEP.Done)} disabled={adminBusy}>
                  Skip for now
                </Btn>
                <Btn
                  tone="teal"
                  size="sm"
                  icon={Icon.Plus}
                  onClick={addFirstAdmin}
                  disabled={adminBusy || !adminEmail.trim()}
                >
                  {adminBusy ? 'Adding…' : 'Add admin'}
                </Btn>
              </div>
            </>
          )}

          {step === STEP.Done && created && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                <LogoThumb
                  url={created.branding?.logoUrl || undefined}
                  name={created.branding?.name ?? slug}
                  size={44}
                />
                <div>
                  <div
                    style={{ fontFamily: "'Montserrat',sans-serif", fontSize: 16, fontWeight: 800 }}
                  >
                    {created.branding?.name} is live on the platform
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    slug <span style={MONO}>{created.tenant}</span> · deadline{' '}
                    {fmtDate(created.submissionDeadline)}
                  </div>
                </div>
              </div>
              <ul
                style={{
                  margin: '0 0 14px',
                  paddingLeft: 18,
                  fontSize: 12.5,
                  color: 'var(--muted)',
                  lineHeight: 1.8,
                }}
              >
                <li>
                  Logo:{' '}
                  {logoOutcome === 'done'
                    ? 'uploaded'
                    : logoOutcome === 'failed'
                      ? 'upload failed — retry from the settings page'
                      : 'not set — add it from the settings page'}
                </li>
                <li>
                  First admin: {adminDone || 'not granted yet — add one from the settings page'}
                </li>
              </ul>
              <p
                style={{
                  fontSize: 12,
                  color: 'var(--muted-2)',
                  margin: '0 0 16px',
                  lineHeight: 1.6,
                }}
              >
                The client serves from the platform host immediately. Its own vanity domain goes
                live once the DNS / go-live checklist (certificates, client CNAMEs, VANITY entry,
                deploy) on the settings page is completed.
              </p>
              <div style={footRow}>
                <Btn
                  tone="teal"
                  size="sm"
                  onClick={() => navigate(`/platform/tenants/${created.tenant}`)}
                >
                  Open client settings & DNS sheet
                </Btn>
                <Btn tone="outline" size="sm" onClick={() => navigate('/platform')}>
                  All clients
                </Btn>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState as useStateApp, useMemo as useMemoApp, useEffect } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
  useParams,
} from 'react-router-dom';
import { QueryClientProvider, useQuery, useQueries } from '@tanstack/react-query';
import { queryClient, qk } from './query.js';
import * as api from './api.js';
import { ApiError } from './api.js';
import { resolveTenantSlug, applyTheme } from './config.js';
import { setActiveTenant } from './api.js';
import { AuthProvider, useAuth, membershipFor } from './auth.jsx';
import { routingRole, clubRouteRedirect } from './routing.js';
import { Login } from './Login.jsx';
import { RegisterPage } from './RegisterPage.jsx';
import { ClubSignupPage } from './ClubSignupPage.jsx';
import {
  REQUIRED_DOCS,
  SUBMISSION_DEADLINE_DEFAULT,
  docCompletion,
  docsAllComplete,
  affiliationSubmitted,
  computeMarkCompliance,
  computeRevertCompliance,
  safeguardingMeta,
  MIN_SAFEGUARDING_FILES,
} from './data.jsx';
import { exportRowsToXlsx } from './exportXlsx.js';
import { openBccReminder } from './mailto.js';
import {
  Icon,
  Pill,
  Btn,
  EmptyState,
  ProgChip,
  ClubNameCell,
  affPill,
  cqiBand,
  useToast,
  useEscapeClose,
} from './atoms.jsx';
import {
  AdminDashboard,
  AdminClubsList,
  AdminClubDetail,
  AdminPlayersView,
  AdminFixtures,
  AdminLeagues,
  AdminSettingsView,
  AdminTeamAccessView,
  AdminClearances,
  LeagueForm,
  CreateSeriesForm,
} from './admin.jsx';
import { parseSupport } from './support.js';
import {
  ClubHome,
  AffiliationForm,
  DocumentsView,
  CQIView,
  ClubFixturesView,
  ClubPlayersView,
  RequestPlayerForm,
  ClubClearancesView,
} from './club.jsx';
import { Onboarding } from './onboarding.jsx';

// Resolve the tenant before any query runs so x-tenant is attached to requests.
const TENANT_SLUG = resolveTenantSlug();
setActiveTenant(TENANT_SLUG);

/* ─── HelpModal — support guidance + union office contacts ─── */
function HelpModal({ onClose, support }) {
  useEscapeClose(onClose);
  // parseSupport (admin.jsx) is the single source of truth for splitting the
  // "Name · email" support string — same logic the edit modal uses.
  const contacts = support
    ? [{ ...parseSupport(support), role: 'Union office' }]
    : [{ name: 'Union office', role: 'Support', email: '' }];
  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="task-modal narrow" style={{ maxWidth: 560 }}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            <div className="task-modal-head-eyebrow">Need Help</div>
            <div className="task-modal-head-title">
              Support &amp; <em>union office</em>
            </div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close">
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">
          <div
            style={{
              background: 'var(--paper)',
              borderRadius: 10,
              padding: '16px 18px',
              marginBottom: 16,
              border: '1px solid var(--line)',
            }}
          >
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: 'var(--ink)' }}>
              If your club is missing one of the required documents, reach out to the union office.
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {contacts.map((c) => (
              <a
                key={c.email || c.name}
                href={c.email ? `mailto:${c.email}` : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '14px 16px',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  background: 'var(--white)',
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: 'rgba(15,143,74,0.12)',
                    color: 'var(--teal-deep)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: "'Montserrat',sans-serif",
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  {c.name[0]}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "'Montserrat',sans-serif",
                      fontSize: 13,
                      fontWeight: 700,
                      color: 'var(--ink)',
                    }}
                  >
                    {c.name}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{c.role}</div>
                  {c.email && (
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--teal-deep)',
                        marginTop: 2,
                        fontWeight: 500,
                      }}
                    >
                      {c.email}
                    </div>
                  )}
                </div>
                <span style={{ color: 'var(--muted-2)' }}>
                  <Icon.Mail />
                </span>
              </a>
            ))}
          </div>
          <div
            style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 14, fontStyle: 'italic' }}
          >
            Tip: include your club name and which document is outstanding so the office can help
            quickly.
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── TaskModal — wraps the affiliation form & documents view ─── */
function TaskModal({ eyebrow, title, onClose, narrow, children }) {
  useEscapeClose(onClose);
  // Portal to document.body so the fixed backdrop centers against the viewport, not the
  // residual transform left on `.main > *` by the fadeUp animation (see admin.jsx fix-confirm).
  return createPortal(
    <div className="task-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`task-modal ${narrow ? 'narrow' : ''}`}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            {eyebrow && <div className="task-modal-head-eyebrow">{eyebrow}</div>}
            <div className="task-modal-head-title">{title}</div>
          </div>
          <button
            className="task-modal-close"
            onClick={onClose}
            title="Close (your inputs are saved)"
          >
            <Icon.X />
          </button>
        </div>
        <div className="task-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── Splash / status screens ─── */
function Splash({ message, action }) {
  return (
    <div className="ps-screen">
      <div className="ps-intro" style={{ textAlign: 'center' }}>
        <div className="ps-eyebrow">Smart Club Integration</div>
        <p className="ps-desc">{message}</p>
        {action}
      </div>
    </div>
  );
}

/* ─── Root ─── */
/**
 * Fallback shown when a single view throws during render, so one crashing screen shows a
 * recoverable message instead of blanking the whole app (as a stray `ReferenceError` once
 * did to the admin Fixtures tab). Used with `react-error-boundary`'s <ErrorBoundary>, which
 * resets on navigation via `resetKeys`.
 */
function ViewErrorFallback({ resetErrorBoundary }) {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      <h2 style={{ fontSize: 18, color: 'var(--ink)', marginBottom: 8 }}>
        Something went wrong loading this view
      </h2>
      <p style={{ fontSize: 13, marginBottom: 16 }}>
        Try again, or pick another section from the menu. If it keeps happening, contact support.
      </p>
      <button className="btn btn-ink" onClick={resetErrorBoundary}>
        Try again
      </button>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

function AppRoutes() {
  const { status } = useAuth();

  // Tenant branding/config (public). Apply theme as soon as it loads.
  const tenantQuery = useQuery({ queryKey: qk.tenant(), queryFn: api.getTenant, retry: 0 });
  useEffect(() => {
    if (tenantQuery.data?.branding) applyTheme(tenantQuery.data.branding);
  }, [tenantQuery.data]);

  return (
    <Routes>
      {/* Public player registration — available with or without auth. */}
      <Route path="/register/:clubId" element={<RegisterPage />} />
      {/* Public club self-registration — the tenant-wide signup link. */}
      <Route path="/signup" element={<ClubSignupPage />} />
      <Route
        path="/*"
        element={
          status === 'loading' ? (
            <Splash message="Loading…" />
          ) : status === 'signedIn' ? (
            <AuthedApp tenantConfig={tenantQuery.data} />
          ) : (
            <Login tenantConfig={tenantQuery.data} />
          )
        }
      />
    </Routes>
  );
}

/* ─── Authenticated app: loads tenant-scoped data + builds API-backed handlers ─── */
function AuthedApp({ tenantConfig }) {
  const { memberships, email, signOutUser } = useAuth();
  const [toastShow, toastNode] = useToast();
  const [showOnboarding, setShowOnboarding] = useStateApp(false);
  const [showCreateSeries, setShowCreateSeries] = useStateApp(false);
  // null = closed; {} = create; a league object = edit
  const [showLeagueForm, setShowLeagueForm] = useStateApp(null);
  const [showHelp, setShowHelp] = useStateApp(false);

  const membership = membershipFor(memberships, TENANT_SLUG);
  const role = routingRole(membership);

  // ── Data ──
  const clubsQuery = useQuery({
    queryKey: qk.clubs(),
    queryFn: api.getClubs,
    enabled: !!membership && role === 'admin',
  });
  const repClubQueries = useQueries({
    queries: (membership && role === 'club' ? membership.clubIds : []).map((id) => ({
      queryKey: qk.club(id),
      queryFn: () => api.getClub(id),
    })),
  });
  const seriesQuery = useQuery({
    queryKey: qk.series(),
    queryFn: api.getSeriesList,
    enabled: !!membership,
  });
  const meQuery = useQuery({ queryKey: qk.me(), queryFn: api.getMe, enabled: !!membership });
  // Tenant roster for Team & Access (admins only). Not part of the initial-load gate —
  // the Team page handles its own loading/empty so the rest of the console renders immediately.
  const usersQuery = useQuery({
    queryKey: qk.users(),
    queryFn: api.getUsers,
    enabled: !!membership && role === 'admin',
  });

  if (!membership) {
    return (
      <div className="ps-screen">
        <div className="ps-intro" style={{ textAlign: 'center' }}>
          <h1 className="ps-title" style={{ fontSize: 22 }}>
            No access
          </h1>
          <p className="ps-desc">
            Your account isn&apos;t linked to {tenantConfig?.branding?.name ?? 'this union'}. Ask an
            administrator to invite you, or sign out and try another account.
          </p>
          <Btn tone="ink" size="sm" onClick={signOutUser}>
            Sign out
          </Btn>
        </div>
      </div>
    );
  }

  const clubs =
    role === 'admin' ? (clubsQuery.data ?? []) : repClubQueries.map((q) => q.data).filter(Boolean);
  const allSeries = seriesQuery.data ?? [];
  const users = usersQuery.data ?? [];
  // Leagues live in tenant config (admin-managed catalogue clubs opt into).
  const allLeagues = tenantConfig?.leagues ?? [];
  const onboarded = meQuery.data?.onboardingSeen ?? {};
  const submissionDeadline = tenantConfig?.submissionDeadline ?? SUBMISSION_DEADLINE_DEFAULT;

  const dataLoading =
    role === 'admin' ? clubsQuery.isLoading : repClubQueries.some((q) => q.isLoading);
  const dataError = role === 'admin' ? clubsQuery.isError : repClubQueries.some((q) => q.isError);
  // A 404 means the requested club is gone (deleted, or a stale membership) — not an outage.
  const dataErrorObj =
    role === 'admin' ? clubsQuery.error : repClubQueries.find((q) => q.isError)?.error;
  const clubNotFound = dataErrorObj instanceof ApiError && dataErrorObj.status === 404;
  // Wait for `me` too so `onboardingSeen` is known before the club portal's auto-open
  // onboarding effect runs — otherwise it races an unresolved /me, reads an empty map, and
  // re-opens the walkthrough every visit even after it's been dismissed/completed.
  if (dataLoading || seriesQuery.isLoading || meQuery.isLoading)
    return <Splash message="Loading your clubs…" />;
  if (dataError || seriesQuery.isError)
    return (
      <Splash
        message={
          clubNotFound
            ? 'That club could not be found — it may have been removed. Sign out and choose another account.'
            : import.meta.env.VITE_LOCAL_AUTH === '1'
              ? 'Could not reach the local API. Is it running? Start it with `npm run dev:local`.'
              : 'Could not load your clubs. Refresh to retry.'
        }
        action={
          clubNotFound ? (
            <Btn tone="ink" size="sm" onClick={signOutUser}>
              Sign out
            </Btn>
          ) : null
        }
      />
    );

  // ── Series mutations (preserve prototype signatures; back with the API) ──
  const invalidate = (key) => queryClient.invalidateQueries({ queryKey: key });
  async function withToast(fn, errMsg, opts = {}) {
    try {
      return await fn();
    } catch (err) {
      const conflict = err instanceof ApiError && err.status === 409;
      // Most 409s are optimistic-concurrency clashes → generic refresh copy. But user-mgmt
      // 409s ("user already active…", "cannot remove the last admin") carry actionable copy
      // the admin must see, so those callers pass `rawConflict` to surface err.message.
      const rawConflict = conflict && opts.rawConflict;
      // 401s carry the session-expired copy from api.js — more useful than errMsg.
      // (When auth is truly lost the app flips to Login anyway; this covers the rest.)
      const authError = err instanceof ApiError && err.status === 401;
      toastShow(
        rawConflict || authError
          ? err.message
          : conflict
            ? 'Someone else just changed this — refreshing.'
            : errMsg || err.message,
        'warn',
      );
      if (conflict) {
        (opts.invalidate ?? [qk.clubs(), qk.series(), qk.tenant()]).forEach(invalidate);
      }
      // Flag so callers that rethrow (e.g. an upload UI) don't toast this a second time.
      if (err && typeof err === 'object') err.alreadyToasted = true;
      throw err;
    }
  }
  // updateSeries keeps the (id, updater) shape: apply the updater to the cached
  // series, then PATCH the computed value with its version (→ 409 on conflict).
  function updateSeries(seriesId, updater) {
    const cur = allSeries.find((s) => s.id === seriesId);
    if (!cur) return;
    const next = updater(cur);
    // Strip approval from generic edits: approval is toggled only via setApproved
    // (a dedicated, single-field write). Omitting it lets the server's gate recall a
    // draft series' approval whenever its fixtures are edited — so the admin must
    // re-approve before release. (A live series keeps its state, per the server rule.)
    const { approved: _a, approvedAt: _aa, ...rest } = next;
    withToast(
      () => api.patchSeries(seriesId, { ...rest, version: cur.version }),
      'Could not save fixtures',
    )
      .then(() => invalidate(qk.series()))
      .catch(() => {});
  }
  function deleteSeries(seriesId) {
    withToast(() => api.deleteSeriesReq(seriesId), 'Could not delete series')
      .then(() => invalidate(qk.series()))
      .catch(() => {});
  }
  function duplicateSeries(seriesId) {
    withToast(() => api.duplicateSeriesReq(seriesId), 'Could not duplicate series')
      .then(() => invalidate(qk.series()))
      .catch(() => {});
  }
  function setReleased(seriesId, value) {
    // Send the cached version so release/recall is race-safe (409 on conflict),
    // not silent last-write-wins.
    const cur = allSeries.find((s) => s.id === seriesId);
    withToast(
      () => api.patchSeries(seriesId, { released: value, version: cur?.version }),
      'Could not update release',
    )
      .then(() => invalidate(qk.series()))
      .catch(() => {});
  }
  // Approve / unapprove a series for release (single-field write so a fixture edit
  // can independently recall approval server-side). Returns the promise so callers
  // can chain a toast.
  function setApproved(seriesId, value) {
    const cur = allSeries.find((s) => s.id === seriesId);
    return withToast(
      () => api.patchSeries(seriesId, { approved: value, version: cur?.version }),
      'Could not update approval',
    )
      .then(() => invalidate(qk.series()))
      .catch(() => {});
  }
  function setSubmissionDeadline(iso) {
    withToast(() => api.putTenantConfig({ submissionDeadline: iso }), 'Could not save deadline')
      .then(() => invalidate(qk.tenant()))
      .catch(() => {});
  }
  function saveOrgName(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return Promise.reject(new Error('name required'));
    // Branding is replaced wholesale by PUT /tenant/config (shallow merge), so spread the
    // current branding (incl. copy.support) and override only the name to avoid clobbering.
    return withToast(
      () => api.putTenantConfig({ branding: { ...tenantConfig?.branding, name: trimmed } }),
      'Could not save organisation name',
    ).then(() => invalidate(qk.tenant()));
  }
  function setSupportContact({ name, email }) {
    // Return the chain raw (no .catch swallow) so the edit modal's own .catch
    // sees a failed save — otherwise it would show "updated" and close on error.
    return withToast(
      () => api.putSupportContact({ name, email }),
      'Could not save support contact',
    ).then(() => invalidate(qk.tenant()));
  }
  function setOnboarded(updater) {
    const next = typeof updater === 'function' ? updater(onboarded) : updater;
    api
      .patchMe({ onboardingSeen: next })
      .then(() => invalidate(qk.me()))
      .catch(() => {});
  }
  function onCreateSeries(s) {
    return withToast(() => api.createSeries(s), 'Could not create series').then((created) => {
      invalidate(qk.series());
      return created;
    });
  }
  // ── League mutations: leagues are a config array, written whole via PUT /tenant/config. ──
  function onCreateLeague(league) {
    if (allLeagues.some((l) => l.key === league.key)) {
      toastShow('A league with that name already exists.', 'warn');
      return Promise.reject(new Error('duplicate league key'));
    }
    const next = [...allLeagues, league];
    return withToast(() => api.putTenantConfig({ leagues: next }), 'Could not create league').then(
      (cfg) => {
        invalidate(qk.tenant());
        return cfg;
      },
    );
  }
  function updateLeague(key, patch) {
    const cur = allLeagues.find((l) => l.key === key);
    if (!cur) return Promise.resolve();
    const merged = { ...cur, ...patch, key: cur.key }; // key is immutable
    const next = allLeagues.map((l) => (l.key === key ? merged : l));
    return withToast(() => api.putTenantConfig({ leagues: next }), 'Could not save league')
      .then(() => invalidate(qk.tenant()))
      .catch(() => {});
  }
  function deleteLeague(key) {
    const next = allLeagues.filter((l) => l.key !== key);
    return withToast(() => api.putTenantConfig({ leagues: next }), 'Could not delete league')
      .then(() => {
        invalidate(qk.tenant());
        invalidate(qk.clubs());
      })
      .catch(() => {});
  }

  return (
    <>
      <Routes>
        <Route
          path="/"
          element={
            <Navigate
              to={role === 'admin' ? '/admin/dashboard' : `/club/${membership.clubIds[0] ?? ''}`}
              replace
            />
          }
        />
        <Route
          path="/admin/*"
          element={
            role === 'admin' ? (
              <Shell
                role="admin"
                {...{
                  clubs,
                  users,
                  allSeries,
                  allLeagues,
                  toastShow,
                  onboarded,
                  setOnboarded,
                  showOnboarding,
                  setShowOnboarding,
                  showCreateSeries,
                  setShowCreateSeries,
                  showLeagueForm,
                  setShowLeagueForm,
                  showHelp,
                  setShowHelp,
                  submissionDeadline,
                  setSubmissionDeadline,
                  setSupportContact,
                  saveOrgName,
                  updateSeries,
                  deleteSeries,
                  duplicateSeries,
                  setReleased,
                  setApproved,
                  onCreateSeries,
                  onCreateLeague,
                  updateLeague,
                  deleteLeague,
                  withToast,
                  invalidate,
                  membership,
                  tenantConfig,
                  userEmail: email,
                  signOutUser,
                }}
              />
            ) : (
              <Navigate to={`/club/${membership.clubIds[0] ?? ''}`} replace />
            )
          }
        />
        <Route
          path="/club/:clubId/*"
          element={
            // Role guard, symmetric with /admin/* above (see clubRouteRedirect): admins
            // manage clubs via /admin/clubs/:id, never the rep portal, so an admin left on
            // a /club URL (e.g. an in-tab sign-out→sign-in from a rep session, which does
            // not re-run the "/" role redirect) is bounced to the admin dashboard instead
            // of rendering the club shell.
            clubRouteRedirect(role) ? (
              <Navigate to={clubRouteRedirect(role)} replace />
            ) : (
              <Shell
                role="club"
                {...{
                  clubs,
                  allSeries,
                  allLeagues,
                  toastShow,
                  onboarded,
                  setOnboarded,
                  showOnboarding,
                  setShowOnboarding,
                  showCreateSeries,
                  setShowCreateSeries,
                  showLeagueForm,
                  setShowLeagueForm,
                  showHelp,
                  setShowHelp,
                  submissionDeadline,
                  setSubmissionDeadline,
                  setSupportContact,
                  saveOrgName,
                  updateSeries,
                  deleteSeries,
                  duplicateSeries,
                  setReleased,
                  setApproved,
                  onCreateSeries,
                  onCreateLeague,
                  updateLeague,
                  deleteLeague,
                  withToast,
                  invalidate,
                  membership,
                  tenantConfig,
                  userEmail: email,
                  signOutUser,
                }}
              />
            )
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {toastNode}
      {showHelp && (
        <HelpModal
          onClose={() => setShowHelp(false)}
          support={tenantConfig?.branding?.copy?.support}
        />
      )}
    </>
  );
}

function Shell({
  role,
  clubs,
  users = [],
  allSeries,
  allLeagues,
  toastShow,
  onboarded,
  setOnboarded,
  showOnboarding,
  setShowOnboarding,
  showCreateSeries,
  setShowCreateSeries,
  showLeagueForm,
  setShowLeagueForm,
  showHelp,
  setShowHelp,
  submissionDeadline,
  setSubmissionDeadline,
  setSupportContact,
  saveOrgName,
  updateSeries,
  deleteSeries,
  duplicateSeries,
  setReleased,
  setApproved,
  onCreateSeries,
  onCreateLeague,
  updateLeague,
  deleteLeague,
  withToast,
  invalidate,
  membership,
  tenantConfig,
  userEmail,
  signOutUser,
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const routeParams = useParams();
  const branding = tenantConfig?.branding;
  // Union office email for mailto actions — parsed from the tenant support copy
  // slot via the shared parseSupport helper, so it stays correct per tenant.
  const unionEmail = parseSupport(branding?.copy?.support).email;

  // ── Derive clubId from URL ──
  let clubId;
  if (role === 'club') {
    clubId = routeParams.clubId;
  } else {
    const m = location.pathname.match(/^\/admin\/clubs\/([^/]+)/);
    clubId = m ? m[1] : (clubs[0]?.id ?? '');
  }

  const activeClub = useMemoApp(
    () => clubs.find((c) => c.id === clubId) || clubs[0],
    [clubs, clubId],
  );

  // ── Player roster + clearance state/data (lives here, where clubId is known) ──
  const [showRequestPlayer, setShowRequestPlayer] = useStateApp(false);
  const [busyClearanceId, setBusyClearanceId] = useStateApp(null);
  // Signup-link share modal, lifted to Shell (which persists across admin views)
  // so empty-state buttons can open it in one click: set true + route to the
  // clubs list, where AdminClubsList renders it.
  const [showShareLink, setShowShareLink] = useStateApp(false);

  const playersQuery = useQuery({
    queryKey: qk.players(clubId),
    queryFn: () => api.getPlayers(clubId),
    enabled: role === 'club' && !!clubId,
  });
  const clearancesQuery = useQuery({
    queryKey: qk.clearances(clubId),
    queryFn: () => api.getClearances(clubId),
    enabled: role === 'club' && !!clubId,
  });
  const clubDirectoryQuery = useQuery({
    queryKey: qk.clubDirectory(),
    queryFn: api.getClubDirectory,
    enabled: role === 'club',
  });
  const allClearancesQuery = useQuery({
    queryKey: qk.allClearances(),
    queryFn: api.getAllClearances,
    enabled: role === 'admin',
  });
  // Tenant-wide club signup link (admin) — drives the share modal + Settings card.
  const signupLinkQuery = useQuery({
    queryKey: qk.signupLink(),
    queryFn: api.getClubSignupLink,
    enabled: role === 'admin',
  });
  const players = playersQuery.data ?? [];
  const clearances = clearancesQuery.data ?? { incoming: [], outbound: [] };
  const clubDirectory = clubDirectoryQuery.data ?? [];
  const allClearances = allClearancesQuery.data ?? [];
  const signupLink = signupLinkQuery.data?.clubSignupLink ?? null;

  // ── Derive view from URL ──
  let view;
  if (role === 'admin') {
    const seg = location.pathname.replace(/^\/admin\/?/, '');
    if (seg.startsWith('clubs/')) view = 'club_detail';
    else if (seg === 'clubs') view = 'clubs_list';
    else if (seg === 'cqi') view = 'cqi_admin';
    else if (seg === '' || seg === 'dashboard') view = 'dashboard';
    else view = seg;
  } else {
    const base = `/club/${clubId}`;
    if (location.pathname === base || location.pathname === base + '/') view = 'home';
    else view = location.pathname.slice(base.length + 1);
  }

  // ── Auto-open onboarding the first time a club portal is entered ──
  useEffect(() => {
    // Only for a club the rep actually owns — never on a foreign/cross-club URL (which
    // renders the access-denied splash; onboarding must not pop over it for the wrong club).
    const ownsClub = clubs.some((c) => c.id === clubId);
    if (
      role === 'club' &&
      ownsClub &&
      activeClub &&
      !affiliationSubmitted(activeClub) &&
      !onboarded[clubId]
    ) {
      const t = setTimeout(() => setShowOnboarding(true), 350);
      return () => clearTimeout(t);
    }
    // `onboarded[clubId]` in deps: a later /me refetch that flips it to seen re-runs this
    // and clears any pending open, so a dismissed walkthrough never re-pops.
  }, [role, clubId, onboarded[clubId]]);

  // ── Navigation helpers ──
  function switchProfile() {
    setShowOnboarding(false);
    signOutUser();
  }
  function gotoAdminView(v) {
    const map = { dashboard: 'dashboard', clubs_list: 'clubs', cqi_admin: 'cqi' };
    navigate(`/admin/${map[v] || v}`);
  }
  // One-click path to the signup-link share modal from any admin view.
  function openShareLink() {
    setShowShareLink(true);
    gotoAdminView('clubs_list');
  }
  function gotoClubView(v, cid = clubId) {
    navigate(v === 'home' ? `/club/${cid}` : `/club/${cid}/${v}`);
  }
  function setActiveClub(id) {
    if (role === 'admin') navigate(`/admin/clubs/${id}`);
    else gotoClubView('home', id);
  }
  function changeClub(id) {
    navigate(`/club/${id}`);
    const c = clubs.find((x) => x.id === id);
    if (!onboarded[id] && c && !affiliationSubmitted(c))
      setTimeout(() => setShowOnboarding(true), 250);
  }

  // ── Club mutations (API-backed; curried by current clubId) ──
  // Resolves on success, rejects on failure (withToast already surfaces the error
  // toast). Fire-and-forget callers append .catch(() => {}); callers that need to
  // confirm success (e.g. Save draft) chain off the returned promise.
  function updateClub(updates) {
    return withToast(
      () => api.patchClub(clubId, { ...updates, version: activeClub?.version }),
      'Could not save changes',
    ).then(() => {
      invalidate(qk.club(clubId));
      invalidate(qk.clubs());
    });
  }

  // ── Compliance override mark / revert (reversible "Mark as compliant") ──
  // Patch with an EXPLICIT base version (not activeClub's) and resolve to the
  // server's fresh club, so a chained Undo carries the correct (incremented)
  // version. Without this, a fast Undo would race the post-write refetch and
  // send a stale version → 409 ("Someone else just changed this") and no-op.
  function patchClubAt(version, updates) {
    return withToast(
      () => api.patchClub(clubId, { ...updates, version }),
      'Could not save changes',
    ).then((updated) => {
      invalidate(qk.club(clubId));
      invalidate(qk.clubs());
      return updated;
    });
  }
  // Mark `keys` compliant, then offer an Undo that reverts exactly the docs this
  // call flipped. The Undo closure binds the server-returned `updated` club so it
  // carries the correct (incremented) version — never the stale `activeClub`.
  // Doc/meta computation lives in computeMarkCompliance (data.jsx) so it's tested.
  function markComplianceFor(club, keys) {
    if (!club) return Promise.resolve(club);
    const { docs, docMeta, flipped } = computeMarkCompliance(club, keys, new Date().toISOString());
    // Nothing was Missing → every requested doc is already compliant (upload or
    // existing override). Skip the no-op version-bumping write; just confirm.
    if (!flipped.length) {
      toastShow('All documents already compliant');
      return Promise.resolve(club);
    }
    return (
      patchClubAt(club.version, { docs, docMeta })
        .then((updated) => {
          toastShow('Marked compliant', 'ok', {
            label: 'Undo',
            onClick: () => revertComplianceFor(updated, flipped),
          });
          return updated;
        })
        // withToast already surfaced the error toast and re-threw; swallow here only
        // to avoid an unhandled rejection. No Undo is offered on a failed write.
        .catch(() => undefined)
    );
  }
  // Revert override-only docs (markedCompliant && no uploaded file); uploads are
  // structurally untouchable. Relies on repo.updateClub replacing docMeta wholesale
  // (shallow merge), so a deleted key does not resurrect server-side.
  function revertComplianceFor(club, keys) {
    if (!club) return Promise.resolve(club);
    const { docs, docMeta, reverted } = computeRevertCompliance(club, keys);
    if (!reverted.length) return Promise.resolve(club);
    return (
      patchClubAt(club.version, { docs, docMeta })
        .then((updated) => {
          toastShow('Compliance override removed', 'ok', {
            label: 'Undo',
            onClick: () => markComplianceFor(updated, reverted),
          });
          return updated;
        })
        // withToast owns the user-facing error; swallow to avoid an unhandled rejection.
        .catch(() => undefined)
    );
  }
  // Admin appends a note to the active club's communication log (server-side
  // list_append, so concurrent notes don't clobber each other).
  function addNote(text) {
    return withToast(() => api.addClubNote(clubId, text), 'Could not save note').then(() => {
      invalidate(qk.club(clubId));
      invalidate(qk.clubs());
    });
  }
  // Safeguarding writes are version-pinned server-side (append/remove are
  // read-modify-write), so a parallel writer 409s instead of losing a file.
  // One silent retry re-reads and re-applies server-side — safe for both ops.
  const retryOnConflict = (send) =>
    send().catch((err) => (err?.status === 409 ? send() : Promise.reject(err)));
  // Compliance doc: DocumentsView uploads to S3 first, then calls this with the
  // stored object metadata. (No-arg legacy callers just flip the flag server-side.)
  function uploadDoc(key, meta) {
    // Rejects on failure (withToast rethrows, flagged alreadyToasted) so the upload UI
    // doesn't report a false success.
    return withToast(
      () =>
        retryOnConflict(() => api.markDocUploaded(clubId, key, meta ?? { objectKey: '', size: 0 })),
      'Could not record upload',
    ).then(() => {
      invalidate(qk.club(clubId));
      invalidate(qk.clubs());
    });
  }
  // Mark a doc "Unavailable" (or undo it) — e.g. a club with no financial
  // statements to upload. Sets the docs flag so compliance reads complete, and
  // stamps a distinct {unavailable} sentinel (vs the admin {markedCompliant}
  // override) so the UI can label it correctly. Undo clears both.
  function setDocUnavailable(key, makeUnavailable) {
    const club = activeClub;
    if (!club) return Promise.resolve();
    const docs = { ...(club.docs || {}), [key]: makeUnavailable };
    const docMeta = { ...(club.docMeta || {}) };
    if (makeUnavailable) docMeta[key] = { unavailable: true, at: new Date().toISOString() };
    else delete docMeta[key];
    return patchClubAt(club.version, { docs, docMeta })
      .then((updated) => {
        if (makeUnavailable) {
          toastShow('Marked unavailable', 'ok', {
            label: 'Undo',
            onClick: () => setDocUnavailable(key, false),
          });
        } else {
          toastShow('Reset — upload when ready');
        }
        return updated;
      })
      .catch(() => undefined);
  }
  // Safeguarding course booking: a club with no certificates yet declares the date its
  // people will complete the safeguarding course. Sets docs.safeguarding so compliance
  // reads complete, and stamps a {courseBooked, courseDate} sentinel (preserving any
  // files already uploaded). Undo clears the booking, re-deriving the flag from files.
  function setSafeguardingCourse(courseDate) {
    const club = activeClub;
    if (!club) return Promise.resolve();
    const norm = safeguardingMeta(club.docMeta?.safeguarding);
    const docs = { ...(club.docs || {}), safeguarding: true };
    const docMeta = {
      ...(club.docMeta || {}),
      safeguarding: {
        files: norm.files,
        courseBooked: true,
        courseDate,
        at: new Date().toISOString(),
      },
    };
    return patchClubAt(club.version, { docs, docMeta })
      .then((updated) => {
        toastShow('Course date recorded', 'ok', {
          label: 'Undo',
          onClick: () => clearSafeguardingCourse(),
        });
        return updated;
      })
      .catch(() => undefined);
  }
  function clearSafeguardingCourse() {
    const club = activeClub;
    if (!club) return Promise.resolve();
    const norm = safeguardingMeta(club.docMeta?.safeguarding);
    const stillSatisfied = norm.files.length >= MIN_SAFEGUARDING_FILES;
    const docs = { ...(club.docs || {}), safeguarding: stillSatisfied };
    const docMeta = { ...(club.docMeta || {}) };
    if (norm.files.length) docMeta.safeguarding = { files: norm.files };
    else delete docMeta.safeguarding;
    return patchClubAt(club.version, { docs, docMeta })
      .then((updated) => {
        toastShow('Reset — upload certificates when ready');
        return updated;
      })
      .catch(() => undefined);
  }
  // Remove one stored safeguarding certificate (the only multi-file doc).
  function removeDocFile(key, objectKey) {
    return withToast(
      () => retryOnConflict(() => api.deleteDocFile(clubId, key, objectKey)),
      'Could not remove file',
    ).then(() => {
      invalidate(qk.club(clubId));
      invalidate(qk.clubs());
      toastShow('Certificate removed');
    });
  }
  // ── Player roster + clearances (club role) ──
  // Players self-register via the shared Registration link (RegLinkModal → public RegisterPage),
  // which captures the full Union field set + ID document — no in-portal chair form.
  // Destination club initiates a clearance request for a player at another club.
  // busyClearanceId === 'new' disables the request form's submit so a double-click
  // can't fire two POSTs (which would race the duplicate-pending guard).
  function requestClearance({ fromClubId, idNumber, note }) {
    setBusyClearanceId('new');
    return withToast(
      () => api.createClearance(clubId, { fromClubId, idNumber, note }),
      'Could not request clearance',
      { rawConflict: true },
    )
      .then(() => {
        invalidate(qk.clearances(clubId));
        setShowRequestPlayer(false);
        toastShow('Clearance requested — the source club will be asked to action it.');
      })
      .catch(() => {})
      .finally(() => setBusyClearanceId(null));
  }
  // Source club toggles a fees/misconduct confirmation on an incoming request.
  function toggleClearanceFlag(req, field) {
    setBusyClearanceId(req.id);
    return withToast(
      () =>
        api.patchClearance(req.fromClubId, req.id, {
          [field]: !req[field],
          version: req.version,
        }),
      'Could not update clearance',
    )
      .then(() => invalidate(qk.clearances(clubId)))
      .catch(() => {})
      .finally(() => setBusyClearanceId(null));
  }
  // Source club issues the clearance (both confirmations done) → the player moves.
  function approveClearance(req) {
    setBusyClearanceId(req.id);
    return withToast(
      () =>
        api.patchClearance(req.fromClubId, req.id, {
          action: 'issue',
          feesCleared: true,
          misconductCleared: true,
          version: req.version,
        }),
      'Could not issue clearance',
      { rawConflict: true },
    )
      .then(() => {
        invalidate(qk.clearances(clubId));
        invalidate(qk.players(clubId));
        toastShow(`${req.playerName} cleared to ${req.toClubName}`);
      })
      .catch(() => {})
      .finally(() => setBusyClearanceId(null));
  }
  // Admin overrides an overdue request, issuing it on the source club's behalf.
  function overrideClearance(req) {
    setBusyClearanceId(req.id);
    return withToast(
      () => api.overrideClearance(req.id, { fromClubId: req.fromClubId, version: req.version }),
      'Could not override clearance',
      { rawConflict: true },
    )
      .then(() => {
        invalidate(qk.allClearances());
        toastShow(`${req.playerName} cleared to ${req.toClubName} · Union override`);
      })
      .catch(() => {})
      .finally(() => setBusyClearanceId(null));
  }
  function saveExco(members) {
    return withToast(() => api.saveExco(clubId, members), 'Could not save exco')
      .then(() => {
        invalidate(qk.club(clubId));
        invalidate(qk.clubs());
      })
      .catch(() => {});
  }
  // Admin invites a rep/admin: creates the Cognito account + membership server-side. The
  // spec carries { email, role, clubIds?, channels?, link? }; the modal owns the success view
  // (login link + per-channel results) off the returned { sub, email, loginUrl, results? }.
  // User-mgmt 409s ("user already active", "cannot remove the last admin") are surfaced
  // verbatim (rawConflict) and refresh the users list rather than clubs/series/tenant.
  const userConflictOpts = { rawConflict: true, invalidate: [qk.users()] };
  function inviteUser(spec) {
    return withToast(() => api.inviteUser(spec), 'Could not send invite', userConflictOpts).then(
      (res) => {
        invalidate(qk.users());
        return res;
      },
    );
  }
  // Change a user's role and/or club scope.
  function patchUser(sub, body) {
    return withToast(
      () => api.patchUser(sub, body),
      'Could not update user',
      userConflictOpts,
    ).then((res) => {
      invalidate(qk.users());
      return res;
    });
  }
  // Remove a user's access to this tenant (server hard-revokes + enforces last-admin).
  function removeUser(sub) {
    return withToast(() => api.removeUser(sub), 'Could not remove user', userConflictOpts).then(
      () => invalidate(qk.users()),
    );
  }
  // Permanently remove a club (server cascades players/docs/clearances and
  // offboards reps whose only club it was). Touches clubs, users (rep rescope),
  // series (fixtures now reference a missing id) and the admin clearance list —
  // refresh all four, then land back on the list the club just vanished from.
  function deleteClub(id) {
    return withToast(() => api.deleteClub(id), 'Could not remove club').then(() => {
      invalidate(qk.clubs());
      invalidate(qk.users());
      invalidate(qk.series());
      invalidate(qk.allClearances());
      gotoAdminView('clubs_list');
      toastShow('Club removed');
    });
  }
  // Re-send the staff invite notification. Resolves to { results } for the caller to surface.
  function resendInvite(sub) {
    return withToast(() => api.resendInvite(sub), 'Could not resend invite');
  }
  async function generatePlayerRegLink(targetClubId) {
    const res = await withToast(() => api.generateRegLink(targetClubId), 'Could not create link');
    invalidate(qk.club(targetClubId));
    invalidate(qk.clubs());
    return res?.playerRegLink;
  }
  // Mint (or replace) the tenant-wide club signup link. The server revokes any
  // prior token in the same call, so the old link dies the moment this resolves.
  function generateSignupLink() {
    return withToast(() => api.generateClubSignupLink(), 'Could not generate signup link').then(
      (res) => {
        invalidate(qk.signupLink());
        return res?.clubSignupLink;
      },
    );
  }
  function revokeSignupLink() {
    return withToast(() => api.revokeClubSignupLink(), 'Could not revoke signup link').then(() =>
      invalidate(qk.signupLink()),
    );
  }
  // Share released fixtures with the club's players (email/WhatsApp). The modal owns
  // the result toast, so this just refreshes the comm log on success.
  async function sendFixtures(targetClubId, payload) {
    const res = await api.sendClubFixtures(targetClubId, payload);
    invalidate(qk.club(targetClubId));
    invalidate(qk.clubs());
    return res;
  }

  if (!activeClub && role === 'club') {
    return <Splash message="This club isn't available on your account." />;
  }

  // — NAV —
  // Clearance badge counts: admin sees cohort-wide; a club counts only requests it must action.
  // Clearances no longer carry a time limit, so there is no "overdue" tier — just pending.
  const adminPendingClearances = allClearances.filter((r) => r.status === 'pending').length;
  const myIncomingClearances = (clearances.incoming ?? []).filter((r) => r.status === 'pending');
  const myPendingClearances = myIncomingClearances.length;
  const myPlayerCount = players.length;

  // Nav items are listed in their natural journey order here, then sorted alphabetically
  // by label for display (see the `.sort` below) — same for clubNav.
  const adminNav = [
    { v: 'dashboard', label: 'Cohort Dashboard', icon: Icon.Dashboard },
    { v: 'clubs_list', label: 'All Clubs', icon: Icon.Clubs, num: clubs.length },
    { v: 'players', label: 'Players', icon: Icon.Users },
    {
      v: 'affiliations',
      label: 'Affiliations',
      icon: Icon.Form,
      num: clubs.filter((c) => affiliationSubmitted(c)).length + '/' + clubs.length,
      dot: clubs.filter((c) => !affiliationSubmitted(c)).length ? 'gold' : 'teal',
    },
    {
      v: 'documents',
      label: 'Compliance Docs',
      icon: Icon.Upload,
      num: clubs.filter(docsAllComplete).length + '/' + clubs.length,
      dot: 'gold',
    },
    {
      v: 'cqi_admin',
      label: 'CQI Submissions',
      icon: Icon.Star,
      num: clubs.filter((c) => c.cqi > 0).length + '/' + clubs.length,
      dot: 'gold',
    },
    { v: 'leagues', label: 'Leagues', icon: Icon.Shield, num: allLeagues.length },
    { v: 'fixtures', label: 'Fixtures & Venues', icon: Icon.Field, dot: 'teal' },
    {
      v: 'clearances',
      label: 'Clearances',
      icon: Icon.Shield,
      num: adminPendingClearances || undefined,
      dot: adminPendingClearances ? 'gold' : 'teal',
    },
    { v: 'team', label: 'Team & Access', icon: Icon.Users, num: users.length || undefined },
  ].sort((a, b) => a.label.localeCompare(b.label));

  const releasedForMe = allSeries.filter((s) => s.released && s.teams.includes(clubId));
  const hasReleased = releasedForMe.length > 0;

  // Built only for the club role (admins never use it). activeClub is guaranteed
  // defined past the guard above for the club role, but is undefined for an admin
  // with a blank cohort — so guard the whole array to avoid a deref crash.
  const clubNav =
    role === 'club' && activeClub
      ? [
          { v: 'home', label: 'Home', icon: Icon.Dashboard },
          {
            v: 'affiliation',
            label: 'Affiliation',
            icon: Icon.Form,
            dot: affiliationSubmitted(activeClub) ? 'teal' : 'coral',
          },
          {
            v: 'documents',
            label: 'Documents',
            icon: Icon.Upload,
            dot: docCompletion(activeClub) === 100 ? 'teal' : 'gold',
          },
          { v: 'cqi', label: 'CQI', icon: Icon.Star, dot: activeClub.cqi > 0 ? 'teal' : 'muted' },
          {
            v: 'players',
            label: 'Players',
            icon: Icon.Clubs,
            num: myPlayerCount || undefined,
            dot: myPlayerCount ? 'teal' : 'muted',
          },
          {
            v: 'clearances',
            label: 'Clearances',
            icon: Icon.Shield,
            num: myPendingClearances || undefined,
            dot: myPendingClearances ? 'gold' : 'muted',
          },
          {
            v: 'fixtures',
            label: 'Fixtures',
            icon: Icon.Field,
            dot: hasReleased ? 'teal' : affiliationSubmitted(activeClub) ? 'gold' : 'muted',
            num: hasReleased ? 'NEW' : undefined,
          },
          { v: '_help', label: 'Need Help?', icon: Icon.Mail, action: () => setShowHelp(true) },
        ].sort((a, b) => a.label.localeCompare(b.label))
      : [];

  const nav = role === 'admin' ? adminNav : clubNav;
  const orgName = branding?.name ?? 'Smart Club';
  const orgFooter = branding?.copy?.footer ?? 'Powered by Medicoach';

  function renderMain() {
    if (role === 'admin') {
      const gotoList = () => gotoAdminView('clubs_list');
      if (view === 'dashboard')
        return (
          <AdminDashboard
            clubs={clubs}
            gotoClub={setActiveClub}
            gotoList={gotoList}
            gotoAdminView={gotoAdminView}
            onInviteAdmin={() => gotoAdminView('team')}
            onShareLink={openShareLink}
            toast={toastShow}
            submissionDeadline={submissionDeadline}
            onUpdateDeadline={setSubmissionDeadline}
            support={branding?.copy?.support}
            onUpdateSupport={setSupportContact}
          />
        );
      if (view === 'clubs_list')
        return (
          <AdminClubsList
            clubs={clubs}
            gotoClub={setActiveClub}
            toast={toastShow}
            submissionDeadline={submissionDeadline}
            onInvite={inviteUser}
            signupLink={signupLink}
            onGenerateSignupLink={generateSignupLink}
            onRevokeSignupLink={revokeSignupLink}
            showShareLink={showShareLink}
            setShowShareLink={setShowShareLink}
          />
        );
      if (view === 'club_detail')
        return (
          <AdminClubDetail
            club={activeClub}
            gotoList={gotoList}
            onGenerateLink={() => generatePlayerRegLink(activeClub.id)}
            onInvite={inviteUser}
            toast={toastShow}
            allLeagues={allLeagues}
            onSetLeagues={(keys) => updateClub({ leagues: keys }).catch(() => {})}
            onUpdateChair={({ name, email, cell }) =>
              updateClub({
                chair: name,
                // Shallow-merge on the server replaces the whole exco object, so send the
                // full exco with siblings preserved and only the chair contact updated.
                exco: {
                  ...(activeClub?.exco || {}),
                  chair: { ...(activeClub?.exco?.chair || {}), name, email, cell },
                },
              })
            }
            onAddNote={addNote}
            onDeleteClub={deleteClub}
            onReconfirmAffiliation={() => updateClub({ amendmentPending: false })}
            allSeries={allSeries}
            onMarkCompliant={() =>
              markComplianceFor(
                activeClub,
                REQUIRED_DOCS.map((d) => d.key),
              )
            }
            onRevertDoc={(key) => revertComplianceFor(activeClub, [key])}
          />
        );
      if (view === 'affiliations')
        return (
          <AdminFiltered
            clubs={clubs}
            kind="affiliation"
            gotoClub={setActiveClub}
            onGetSignupLink={openShareLink}
            toast={toastShow}
          />
        );
      if (view === 'documents')
        return (
          <AdminFiltered
            clubs={clubs}
            kind="docs"
            gotoClub={setActiveClub}
            onGetSignupLink={openShareLink}
            toast={toastShow}
          />
        );
      if (view === 'cqi_admin')
        return (
          <AdminFiltered
            clubs={clubs}
            kind="cqi"
            gotoClub={setActiveClub}
            onGetSignupLink={openShareLink}
            toast={toastShow}
          />
        );
      if (view === 'leagues')
        return (
          <AdminLeagues
            allLeagues={allLeagues}
            clubs={clubs}
            onCreate={() => setShowLeagueForm({})}
            onEdit={(L) => setShowLeagueForm(L)}
            onDeleteLeague={deleteLeague}
            toast={toastShow}
          />
        );
      if (view === 'players')
        return <AdminPlayersView clubs={clubs} leagues={allLeagues} toast={toastShow} />;
      if (view === 'fixtures')
        return (
          <AdminFixtures
            clubs={clubs}
            allSeries={allSeries}
            onCreateSeries={() => setShowCreateSeries(true)}
            onUpdateSeries={updateSeries}
            onDeleteSeries={deleteSeries}
            onDuplicateSeries={duplicateSeries}
            onSetReleased={setReleased}
            onSetApproved={setApproved}
            toast={toastShow}
          />
        );
      if (view === 'clearances')
        return (
          <AdminClearances
            clearances={allClearances}
            leagues={allLeagues}
            onOverride={overrideClearance}
            busyId={busyClearanceId}
          />
        );
      if (view === 'team')
        return (
          <AdminTeamAccessView
            users={users}
            clubs={clubs}
            onInvite={inviteUser}
            onPatchUser={patchUser}
            onRemoveUser={removeUser}
            onResend={resendInvite}
            currentUserEmail={userEmail}
            toast={toastShow}
          />
        );
      if (view === 'settings')
        return (
          <AdminSettingsView
            orgName={orgName}
            submissionDeadline={submissionDeadline}
            support={branding?.copy?.support}
            onSaveOrg={saveOrgName}
            onUpdateDeadline={setSubmissionDeadline}
            onUpdateSupport={setSupportContact}
            onManageTeam={() => gotoAdminView('team')}
            signupLink={signupLink}
            onGenerateSignupLink={generateSignupLink}
            onRevokeSignupLink={revokeSignupLink}
            toast={toastShow}
          />
        );
    } else {
      if (view === 'home' || view === 'affiliation' || view === 'documents')
        return (
          <ClubHome
            club={activeClub}
            goto={gotoClubView}
            toast={toastShow}
            replayOnboarding={() => setShowOnboarding(true)}
            submissionDeadline={submissionDeadline}
            allLeagues={allLeagues}
          />
        );
      if (view === 'cqi')
        return (
          <CQIView
            club={activeClub}
            goto={gotoClubView}
            toast={toastShow}
            submissionDeadline={submissionDeadline}
            allLeagues={allLeagues}
            onSubmit={(score, answers) => {
              updateClub({ cqi: score, cqiAnswers: answers }).catch(() => {});
              gotoClubView('home');
            }}
          />
        );
      if (view === 'fixtures') {
        if (!affiliationSubmitted(activeClub))
          return (
            <ComingSoon title="Fixtures & Venues" phase="02" unlocked={false} eta="Aug 2026" />
          );
        return (
          <ClubFixturesView
            club={activeClub}
            allSeries={allSeries}
            clubs={clubs}
            toast={toastShow}
            onSendFixtures={sendFixtures}
          />
        );
      }
      if (view === 'players') {
        return (
          <ClubPlayersView
            club={activeClub}
            players={players}
            clearances={clearances}
            leagues={allLeagues}
            onGenerateLink={() => generatePlayerRegLink(activeClub.id)}
            toast={toastShow}
          />
        );
      }
      if (view === 'clearances') {
        return (
          <ClubClearancesView
            club={activeClub}
            clearances={clearances}
            leagues={allLeagues}
            onClearFees={(req) => toggleClearanceFlag(req, 'feesCleared')}
            onClearMisconduct={(req) => toggleClearanceFlag(req, 'misconductCleared')}
            onApprove={approveClearance}
            onOpenRequest={() => setShowRequestPlayer(true)}
            busyId={busyClearanceId}
          />
        );
      }
    }
    return null;
  }

  // Explicit cross-club denial: a rep on a URL for a club not in their membership. Returned
  // here — after all hooks, before any chrome — so it's a clean FULL-SCREEN denial (not the
  // rep's own header/sidebar wrapped around an access-denied panel). Safe from a loading
  // false-positive: AuthedApp only renders Shell past its dataLoading gate, and a rep's
  // `clubs` come from repClubQueries keyed on membership.clubIds, so only a genuinely-foreign
  // clubId fails this check. Admins are unaffected (role-scoped).
  if (role === 'club' && clubId && !clubs.some((c) => c.id === clubId)) {
    const ownClub = membership?.clubIds?.[0];
    return (
      <Splash
        message="You don't have access to that club."
        action={
          ownClub ? (
            <Btn tone="ink" size="sm" onClick={() => navigate(`/club/${ownClub}`)}>
              Go to my club
            </Btn>
          ) : (
            <Btn tone="ink" size="sm" onClick={signOutUser}>
              Sign out
            </Btn>
          )
        }
      />
    );
  }

  const userName = role === 'admin' ? userEmail || 'Admin' : activeClub.chair;
  const userInitials =
    role === 'admin'
      ? (userEmail || 'A').slice(0, 2).toUpperCase()
      : activeClub.chair
          .split(' ')
          .map((w) => w[0])
          .slice(0, 2)
          .join('');

  return (
    <div data-screen-label={role === 'admin' ? 'Admin · ' + view : 'Club · ' + view}>
      <header className="app-header">
        <div className="h-logo">
          {branding?.logoUrl && <img className="h-logo-img" src={branding.logoUrl} alt={orgName} />}
        </div>
        <div className="h-divider" />
        <span className="h-sub">Smart Club Integration · Cricket Services</span>

        <div className="h-spacer" />

        {role === 'club' && clubs.length > 1 && (
          <select
            className="field-select"
            style={{
              height: 34,
              width: 'auto',
              minWidth: 180,
              background: 'rgba(255,255,255,0.06)',
              color: '#fff',
              border: '1px solid rgba(255,255,255,0.08)',
              paddingRight: 30,
              fontSize: 12.5,
            }}
            value={clubId}
            onChange={(e) => changeClub(e.target.value)}
          >
            {clubs.map((c) => (
              <option key={c.id} value={c.id} style={{ background: '#fff', color: '#000' }}>
                {c.name}
              </option>
            ))}
          </select>
        )}

        <button className="h-switch" onClick={switchProfile} title="Sign out">
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
          <div
            className="h-avatar"
            style={{
              background: role === 'admin' ? 'var(--gold)' : 'var(--teal)',
              color: role === 'admin' ? 'var(--ink)' : '#fff',
            }}
          >
            {userInitials}
          </div>
          <div>
            <div className="h-user-name">{userName}</div>
            <div className="h-user-role">
              {role === 'admin' ? `${orgName} · Admin` : activeClub.name + ' · Chair'}
            </div>
          </div>
        </div>
      </header>

      <div className="shell">
        <aside className="nav">
          <div className="nav-section">{role === 'admin' ? 'Cohort' : 'Integration journey'}</div>
          {nav.map((n) => (
            <button
              key={n.v}
              className={`nav-item ${view === n.v ? 'active' : ''}`}
              onClick={() => {
                if (n.action) {
                  n.action();
                  return;
                }
                role === 'admin' ? gotoAdminView(n.v) : gotoClubView(n.v);
              }}
            >
              <span className="ni-icon">
                <n.icon />
              </span>
              <span className="ni-label">{n.label}</span>
              {n.num && <span className={`ni-num ${n.num === 'NEW' ? 'new' : ''}`}>{n.num}</span>}
              {!n.num && n.dot && <span className={`ni-dot ${n.dot}`} />}
            </button>
          ))}

          {role === 'admin' && (
            <>
              <div className="nav-section" style={{ marginTop: 18 }}>
                Workspace
              </div>
              {[
                {
                  v: 'settings',
                  label: 'Settings',
                  icon: Icon.Shield,
                  action: () => gotoAdminView('settings'),
                },
                {
                  v: '_help',
                  label: 'Need Help?',
                  icon: Icon.Mail,
                  action: () => setShowHelp(true),
                },
              ]
                .sort((a, b) => a.label.localeCompare(b.label))
                .map((n) => (
                  <button
                    key={n.v}
                    className={`nav-item ${view === n.v ? 'active' : ''}`}
                    onClick={n.action}
                  >
                    <span className="ni-icon">
                      <n.icon />
                    </span>
                    <span className="ni-label">{n.label}</span>
                  </button>
                ))}
            </>
          )}

          <div className="nav-footer">
            <strong>{orgName}</strong> · Smart Club Integration
            <br />
            v 1.0.0 · Cricket Services · 2026/27
            <br />
            <span style={{ color: 'var(--muted-3)' }}>{orgFooter}</span>
          </div>
        </aside>

        <main className={`main ${view === 'fixtures' && allSeries.length > 0 ? 'fullbleed' : ''}`}>
          <ErrorBoundary
            FallbackComponent={ViewErrorFallback}
            resetKeys={[view]}
            onError={(error, info) =>
              console.error('View render error:', error, info?.componentStack)
            }
          >
            {renderMain()}
          </ErrorBoundary>
        </main>
      </div>

      {showOnboarding && role === 'club' && (
        <Onboarding
          club={activeClub}
          submissionDeadline={submissionDeadline}
          onClose={() => {
            // Dismissing also marks the walkthrough seen (persisted via setOnboarded →
            // patchMe), so it doesn't re-auto-open on every visit. The Home "Walkthrough"
            // button still lets the chair replay it intentionally.
            setOnboarded((o) => ({ ...o, [clubId]: true }));
            setShowOnboarding(false);
          }}
          onComplete={(contact) => {
            setOnboarded((o) => ({ ...o, [clubId]: true }));
            setShowOnboarding(false);
            toastShow('Welcome, ' + activeClub.chair.split(' ')[0] + " · let's get started");
            // Persist just the reminders opt-in (a non-affiliation field, so it's never
            // locked). No scheduled reminders yet — this only stops dropping the choice.
            // Best-effort: a stale-version 409 here just means the flag didn't persist, so
            // log it (don't swallow) rather than surfacing an error toast over the welcome.
            if (contact && !!contact.notify !== !!activeClub.remindersOptIn) {
              updateClub({ remindersOptIn: !!contact.notify }).catch((err) =>
                console.warn('reminders opt-in not persisted', err),
              );
            }
          }}
          onStart={() => gotoClubView('affiliation')}
        />
      )}

      {role === 'club' && view === 'affiliation' && (
        <TaskModal
          eyebrow={`Phase 01 · ${activeClub.name}`}
          title={
            <>
              2026/27 <em>Affiliation Form</em>
            </>
          }
          onClose={() => gotoClubView('home')}
        >
          <AffiliationForm
            club={activeClub}
            goto={gotoClubView}
            toast={toastShow}
            allLeagues={allLeagues}
            onSaveDraft={(payload) =>
              updateClub({
                district: payload.district,
                exco: payload.exco,
                coaches: payload.coaches,
                ground: payload.ground,
                leagues: payload.leagues,
              })
            }
            onSubmit={(payload) => {
              // Affiliation submit marks the club complete. The form is no longer locked
              // — reps may re-edit, which re-flags the club for admin re-confirmation.
              updateClub({
                affiliation: 'complete',
                district: payload.district,
                exco: payload.exco,
                coaches: payload.coaches || [],
                ground: payload.ground || {},
                leagues: payload.leagues || [],
                docs: { ...activeClub.docs, exco: true },
              }).catch(() => {});
              gotoClubView('home');
            }}
          />
        </TaskModal>
      )}

      {role === 'club' && view === 'documents' && (
        <TaskModal
          narrow
          eyebrow={`Compliance · ${activeClub.name}`}
          title={
            <>
              Required <em>compliance documents</em>
            </>
          }
          onClose={() => gotoClubView('home')}
        >
          <DocumentsView
            club={activeClub}
            goto={gotoClubView}
            toast={toastShow}
            onUpload={uploadDoc}
            onRemoveFile={removeDocFile}
            onMarkUnavailable={setDocUnavailable}
            onSetSafeguardingCourse={setSafeguardingCourse}
            onClearSafeguardingCourse={clearSafeguardingCourse}
            onSaveExco={saveExco}
            submissionDeadline={submissionDeadline}
            unionEmail={unionEmail}
          />
        </TaskModal>
      )}

      {role === 'club' && showRequestPlayer && activeClub && (
        <TaskModal
          narrow
          eyebrow={`Clearances · ${activeClub.name}`}
          title={
            <>
              Request a <em>player</em>
            </>
          }
          onClose={() => setShowRequestPlayer(false)}
        >
          <RequestPlayerForm
            club={activeClub}
            directory={clubDirectory}
            busy={busyClearanceId === 'new'}
            onSubmit={requestClearance}
            onCancel={() => setShowRequestPlayer(false)}
          />
        </TaskModal>
      )}

      {role === 'admin' && showLeagueForm && (
        <TaskModal
          eyebrow="Catalogue · Cricket Services"
          narrow
          title={
            showLeagueForm.key ? (
              <>
                Edit <em>league</em>
              </>
            ) : (
              <>
                Create a <em>league</em>
              </>
            )
          }
          onClose={() => setShowLeagueForm(null)}
        >
          <LeagueForm
            league={showLeagueForm.key ? showLeagueForm : null}
            allLeagues={allLeagues}
            onCreate={onCreateLeague}
            onUpdate={updateLeague}
            onClose={() => setShowLeagueForm(null)}
            toast={toastShow}
          />
        </TaskModal>
      )}
      {role === 'admin' && showCreateSeries && (
        <TaskModal
          eyebrow="Fixtures · Cricket Services"
          title={
            <>
              Create a new <em>series</em>
            </>
          }
          onClose={() => setShowCreateSeries(false)}
        >
          <CreateSeriesForm
            clubs={clubs}
            allLeagues={allLeagues}
            onCreate={(s) => {
              onCreateSeries(s)
                .then(() => {
                  const tail = s.bulkSend
                    ? ` · bulk-sent to ${s.teams.length} club${s.teams.length === 1 ? '' : 's'}`
                    : '';
                  toastShow(`${s.name} created · ${s.fixtures.length} fixtures generated${tail}`);
                })
                .catch(() => {});
            }}
            onClose={() => setShowCreateSeries(false)}
          />
        </TaskModal>
      )}
    </div>
  );
}

/* ─── Filtered admin views (Affiliation / Docs / CQI) ─── */
function AdminFiltered({ clubs, kind, gotoClub, onGetSignupLink, toast }) {
  const titles = {
    affiliation: {
      t: 'Affiliation tracker',
      crumb: 'Affiliations',
      desc: 'Track which clubs have completed the 2026/27 union affiliation form.',
      icon: Icon.Form,
      empty:
        'Clubs register themselves via your signup link and appear here — then track who has completed the 2026/27 affiliation form.',
    },
    docs: {
      t: 'Compliance docs tracker',
      crumb: 'Compliance Docs',
      desc: 'Monitor compliance document uploads across all clubs.',
      icon: Icon.Upload,
      empty:
        'Clubs register themselves via your signup link and appear here — then monitor their compliance document uploads.',
    },
    cqi: {
      t: 'CQI submission tracker',
      crumb: 'CQI Submissions',
      desc: 'Real-time view of CQI self-assessments returned by clubs across all five categories.',
      icon: Icon.Star,
      empty:
        'Clubs register themselves via your signup link and appear here — then collect CQI self-assessments across all five categories.',
    },
  }[kind];

  // "Outstanding" depends on the tracker: affiliation not submitted (affiliation),
  // any missing doc (docs), or no CQI submission (cqi).
  const isOutstanding = (c) =>
    kind === 'affiliation'
      ? !affiliationSubmitted(c)
      : kind === 'docs'
        ? !docsAllComplete(c)
        : c.cqi === 0;

  function remindOutstanding() {
    openBccReminder({
      emails: clubs.filter(isOutstanding).map((c) => c.exco?.chair?.email),
      subject: {
        affiliation: '2026/27 affiliation outstanding — please complete',
        docs: 'Compliance documents outstanding — please upload',
        cqi: 'CQI self-assessment outstanding — please submit',
      }[kind],
      toast,
      emptyMessage: 'No outstanding clubs with a chairperson email on file',
    });
  }

  function exportTracker() {
    const rows = clubs.map((c) => {
      const base = { Club: c.name, Chair: c.chair };
      if (kind === 'affiliation')
        return {
          ...base,
          Status: c.affiliation,
          Submitted: affiliationSubmitted(c)
            ? 'Submitted'
            : c.affiliation === 'in_progress'
              ? 'Draft saved'
              : '—',
        };
      if (kind === 'docs')
        return {
          ...base,
          ...Object.fromEntries(
            REQUIRED_DOCS.map((d) => [d.name, c.docs[d.key] ? 'Uploaded' : 'Missing']),
          ),
          'Progress %': docCompletion(c),
        };
      return {
        ...base,
        Score: c.cqi > 0 ? c.cqi : '—',
        Band: cqiBand(c.cqi).label,
        Submitted: c.cqi > 0 ? 'Submitted' : '—',
        Players: c.players || '—',
      };
    });
    exportRowsToXlsx(`${kind}-tracker.xlsx`, titles.crumb, rows).catch(() =>
      toast?.('Export failed — please retry'),
    );
  }

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Admin Console / {titles.crumb}</div>
          <h1 className="ph-title">{titles.t}</h1>
          <p className="ph-desc">{titles.desc}</p>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" size="sm" icon={Icon.Mail} onClick={remindOutstanding}>
            Send reminder to outstanding
          </Btn>
          <Btn tone="ink" size="sm" icon={Icon.Download} onClick={exportTracker}>
            Export
          </Btn>
        </div>
      </div>

      {clubs.length === 0 ? (
        <EmptyState
          icon={titles.icon}
          title="No clubs in your cohort yet"
          sub={titles.empty}
          action={
            <Btn tone="teal" icon={Icon.Mail} onClick={onGetSignupLink}>
              Get the club signup link
            </Btn>
          }
        />
      ) : (
        <div className="tbl-w">
          <table className="tbl">
            <thead>
              <tr>
                <th>Club</th>
                <th>Chair</th>
                {kind === 'affiliation' && (
                  <>
                    <th>Status</th>
                    <th>Submitted</th>
                  </>
                )}
                {kind === 'docs' && (
                  <>
                    {REQUIRED_DOCS.map((d) => (
                      <th key={d.key}>{d.name}</th>
                    ))}
                    <th>Progress</th>
                  </>
                )}
                {kind === 'cqi' && (
                  <>
                    <th>Score</th>
                    <th>Band</th>
                    <th>Submitted</th>
                    <th>Players</th>
                  </>
                )}
                <th style={{ width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {clubs.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => gotoClub(c.id)}>
                  <td>
                    <ClubNameCell club={c} />
                  </td>
                  <td>
                    <span style={{ fontSize: 12.5 }}>{c.chair}</span>
                  </td>

                  {kind === 'affiliation' && (
                    <>
                      <td>{affPill(c.affiliation)}</td>
                      <td>
                        {affiliationSubmitted(c) ? (
                          <Pill tone="teal" dot>
                            Submitted
                          </Pill>
                        ) : (
                          <Pill tone="coral" dot>
                            Outstanding
                          </Pill>
                        )}
                      </td>
                    </>
                  )}

                  {kind === 'docs' && (
                    <>
                      {REQUIRED_DOCS.map((d) => (
                        <td key={d.key}>
                          {c.docs[d.key] ? (
                            <Pill tone="teal" dot>
                              Uploaded
                            </Pill>
                          ) : (
                            <Pill tone="coral" dot>
                              Missing
                            </Pill>
                          )}
                        </td>
                      ))}
                      <td>
                        <ProgChip
                          value={docCompletion(c)}
                          tone={
                            docCompletion(c) === 100
                              ? 'teal'
                              : docCompletion(c) > 0
                                ? 'gold'
                                : 'coral'
                          }
                        />
                      </td>
                    </>
                  )}

                  {kind === 'cqi' && (
                    <>
                      <td>
                        <span
                          style={{
                            fontFamily: "'Montserrat',sans-serif",
                            fontSize: 15,
                            fontWeight: 800,
                            color:
                              c.cqi >= 80
                                ? 'var(--teal-deep)'
                                : c.cqi >= 65
                                  ? 'var(--ink)'
                                  : c.cqi > 0
                                    ? '#076B36'
                                    : 'var(--muted-2)',
                          }}
                        >
                          {c.cqi > 0 ? c.cqi.toFixed(1) : '—'}
                        </span>
                      </td>
                      <td>
                        <Pill tone={cqiBand(c.cqi).tone}>{cqiBand(c.cqi).label}</Pill>
                      </td>
                      <td>
                        <span
                          style={{
                            fontSize: 11.5,
                            color: 'var(--muted)',
                            fontFamily: "'Montserrat',sans-serif",
                          }}
                        >
                          {c.cqi > 0 ? 'Submitted' : '—'}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontFamily: "'Montserrat',sans-serif", fontSize: 12 }}>
                          {c.players || '—'}
                        </span>
                      </td>
                    </>
                  )}

                  <td style={{ textAlign: 'right', paddingRight: 18 }}>
                    <Icon.Arrow />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ─── Coming soon placeholder ─── */
function ComingSoon({ title, phase, unlocked, eta }) {
  const headline = unlocked ? 'Coming soon' : 'This phase unlocks after affiliation';
  const detailDesc = unlocked
    ? `Phase ${phase} of the Smart Club Integration journey. Your affiliation is in — this module is in final development and will arrive shortly.`
    : `Phase ${phase} of the Smart Club Integration journey. Activates automatically once your club has completed affiliation and uploaded compliance documents.`;
  const detailBody = unlocked
    ? "We're putting the finishing touches on this module. You'll be notified by email and on your home page the moment it's ready — no action needed from your side."
    : 'Once your club has been confirmed by the Union office, this module activates with live data — fixtures, player registration, scoring, and clinical management — all sourced from the Medicoach platform.';
  const ring = unlocked ? 'var(--teal)' : 'var(--paper3)';
  const ringBg = unlocked ? 'var(--teal-pale)' : 'var(--paper)';
  const ringFg = unlocked ? 'var(--teal-deep)' : 'var(--muted-2)';

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">
            Phase {phase}{' '}
            {unlocked && (
              <>
                · <span style={{ color: 'var(--teal-deep)' }}>Unlocked</span>
              </>
            )}
          </div>
          <h1 className="ph-title">{title}</h1>
          <p className="ph-desc">{detailDesc}</p>
        </div>
        {unlocked && (
          <div className="ph-actions">
            <span className="pill pill-teal" style={{ padding: '5px 12px' }}>
              <span className="sdot teal" />
              Available {eta || 'Q3 2026'}
            </span>
          </div>
        )}
      </div>

      <div
        style={{
          background: 'var(--white)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          padding: '60px 40px',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 96,
            height: 96,
            margin: '0 auto 20px',
            borderRadius: '50%',
            background: ringBg,
            border: `2px ${unlocked ? 'solid' : 'dashed'} ${ring}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: ringFg,
          }}
        >
          {unlocked ? (
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M12 7v5l3 2"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M12 7v6M12 16v.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          )}
        </div>
        <div
          style={{
            fontFamily: "'Montserrat',sans-serif",
            fontSize: 18,
            fontWeight: 700,
            marginBottom: 8,
          }}
        >
          {headline}
        </div>
        <div
          style={{
            fontSize: 13,
            color: 'var(--muted)',
            maxWidth: 460,
            margin: '0 auto',
            lineHeight: 1.6,
          }}
        >
          {detailBody}
        </div>
        {unlocked && (
          <div style={{ marginTop: 22, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Btn tone="outline" size="sm" icon={Icon.Bell}>
              Notify me when ready
            </Btn>
            <Btn tone="ghost" size="sm" icon={Icon.Mail}>
              Talk to the union office
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);

import { useState as useStateApp, useMemo as useMemoApp, useEffect } from 'react';
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
import { Login } from './Login.jsx';
import { RegisterPage } from './RegisterPage.jsx';
import { REQUIRED_DOCS, SUBMISSION_DEADLINE_DEFAULT, docCompletion } from './data.jsx';
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
  AdminFixtures,
  AdminLeagues,
  LeagueForm,
  CreateSeriesForm,
} from './admin.jsx';
import { parseSupport } from './support.js';
import { ClubHome, AffiliationForm, DocumentsView, CQIView, ClubFixturesView } from './club.jsx';
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
  const role = membership?.role === 'admin' ? 'admin' : 'club';

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
  if (dataLoading || seriesQuery.isLoading) return <Splash message="Loading your clubs…" />;
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
  async function withToast(fn, errMsg) {
    try {
      return await fn();
    } catch (err) {
      const conflict = err instanceof ApiError && err.status === 409;
      toastShow(
        conflict ? 'Someone else just changed this — refreshing.' : errMsg || err.message,
        'warn',
      );
      if (conflict) {
        invalidate(qk.clubs());
        invalidate(qk.series());
        invalidate(qk.tenant());
      }
      throw err;
    }
  }
  // updateSeries keeps the (id, updater) shape: apply the updater to the cached
  // series, then PATCH the computed value with its version (→ 409 on conflict).
  function updateSeries(seriesId, updater) {
    const cur = allSeries.find((s) => s.id === seriesId);
    if (!cur) return;
    const next = updater(cur);
    withToast(
      () => api.patchSeries(seriesId, { ...next, version: cur.version }),
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
  function setSubmissionDeadline(iso) {
    withToast(() => api.putTenantConfig({ submissionDeadline: iso }), 'Could not save deadline')
      .then(() => invalidate(qk.tenant()))
      .catch(() => {});
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
                  updateSeries,
                  deleteSeries,
                  duplicateSeries,
                  setReleased,
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
                updateSeries,
                deleteSeries,
                duplicateSeries,
                setReleased,
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
  updateSeries,
  deleteSeries,
  duplicateSeries,
  setReleased,
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
    if (role === 'club' && activeClub && !activeClub.paid && !onboarded[clubId]) {
      const t = setTimeout(() => setShowOnboarding(true), 350);
      return () => clearTimeout(t);
    }
  }, [role, clubId]);

  // ── Navigation helpers ──
  function switchProfile() {
    setShowOnboarding(false);
    signOutUser();
  }
  function gotoAdminView(v) {
    const map = { dashboard: 'dashboard', clubs_list: 'clubs', cqi_admin: 'cqi' };
    navigate(`/admin/${map[v] || v}`);
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
    if (!onboarded[id] && c && !c.paid) setTimeout(() => setShowOnboarding(true), 250);
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
  // Mark `keys` compliant. Preserves the original "set all four true" behaviour;
  // only docs WITHOUT an uploaded file get a {markedCompliant} sentinel, and real
  // uploads (objectKey) are left untouched. `flipped` = docs that were previously
  // Missing — exactly the set a matching Undo should revert.
  function markComplianceFor(club, keys) {
    if (!club) return Promise.resolve(club);
    const docs = { ...club.docs };
    const docMeta = { ...(club.docMeta ?? {}) };
    const at = new Date().toISOString();
    const flipped = [];
    for (const k of keys) {
      if (club.docMeta?.[k]?.objectKey) continue; // real upload → leave as-is
      if (!club.docs?.[k]) flipped.push(k); // was Missing → track for Undo
      docs[k] = true;
      docMeta[k] = { markedCompliant: true, at };
    }
    return patchClubAt(club.version, { docs, docMeta })
      .then((updated) => {
        if (flipped.length)
          toastShow('Marked compliant', 'ok', {
            label: 'Undo',
            onClick: () => revertComplianceFor(updated ?? activeClub, flipped),
          });
        return updated;
      })
      .catch(() => {});
  }
  // Revert ONLY override-only docs (markedCompliant && no uploaded file), computed
  // against the freshest known club. Relies on repo.updateClub replacing docMeta
  // wholesale (shallow merge), so a deleted key does not resurrect server-side.
  function revertComplianceFor(club, keys) {
    if (!club) return Promise.resolve(club);
    const docs = { ...club.docs };
    const docMeta = { ...(club.docMeta ?? {}) };
    const reverted = [];
    for (const k of keys) {
      const m = docMeta[k];
      if (m && m.markedCompliant && !m.objectKey) {
        docs[k] = false;
        delete docMeta[k];
        reverted.push(k);
      }
    }
    if (!reverted.length) return Promise.resolve(club);
    return patchClubAt(club.version, { docs, docMeta })
      .then((updated) => {
        toastShow('Compliance override removed', 'ok', {
          label: 'Undo',
          onClick: () => markComplianceFor(updated ?? activeClub, reverted),
        });
        return updated;
      })
      .catch(() => {});
  }
  // Admin appends a note to the active club's communication log (server-side
  // list_append, so concurrent notes don't clobber each other).
  function addNote(text) {
    return withToast(() => api.addClubNote(clubId, text), 'Could not save note').then(() => {
      invalidate(qk.club(clubId));
      invalidate(qk.clubs());
    });
  }
  // Compliance doc: DocumentsView uploads to S3 first, then calls this with the
  // stored object metadata. (No-arg legacy callers just flip the flag server-side.)
  function uploadDoc(key, meta) {
    return withToast(
      () => api.markDocUploaded(clubId, key, meta ?? { objectKey: '', size: 0 }),
      'Could not record upload',
    )
      .then(() => {
        invalidate(qk.club(clubId));
        invalidate(qk.clubs());
      })
      .catch(() => {});
  }
  function saveExco(members) {
    return withToast(() => api.saveExco(clubId, members), 'Could not save exco')
      .then(() => {
        invalidate(qk.club(clubId));
        invalidate(qk.clubs());
      })
      .catch(() => {});
  }
  function setPaid(id, paid) {
    return withToast(() => api.setPaid(id, paid), 'Could not update payment')
      .then(() => {
        invalidate(qk.club(id));
        invalidate(qk.clubs());
      })
      .catch(() => {});
  }
  // Admin invites a rep/admin: creates the Cognito account + membership server-side.
  function inviteUser(spec) {
    return withToast(() => api.inviteUser(spec), 'Could not send invite');
  }
  async function generatePlayerRegLink(targetClubId) {
    const res = await withToast(() => api.generateRegLink(targetClubId), 'Could not create link');
    invalidate(qk.club(targetClubId));
    invalidate(qk.clubs());
    return res?.playerRegLink;
  }
  async function onboardClub(spec) {
    const created = await withToast(() => api.onboardClub(spec), 'Could not onboard club');
    invalidate(qk.clubs());
    return created;
  }
  async function bulkOnboardClubs(specs) {
    if (!Array.isArray(specs) || specs.length === 0) return [];
    // The API returns { created, skipped } (per-spec, non-atomic). Surface skips.
    const res = await withToast(() => api.bulkOnboardClubs(specs), 'Could not onboard clubs');
    invalidate(qk.clubs());
    if (res?.skipped?.length) {
      toastShow(`${res.skipped.length} skipped (duplicate or invalid name)`, 'warn');
    }
    return res?.created ?? [];
  }

  if (!activeClub && role === 'club') {
    return <Splash message="This club isn't available on your account." />;
  }

  // — NAV —
  const adminNav = [
    { v: 'dashboard', label: 'Cohort Dashboard', icon: Icon.Dashboard },
    { v: 'clubs_list', label: 'All Clubs', icon: Icon.Clubs, num: clubs.length },
    {
      v: 'affiliations',
      label: 'Affiliations',
      icon: Icon.Form,
      num: clubs.filter((c) => c.paid).length + '/' + clubs.length,
      dot: clubs.filter((c) => !c.paid).length ? 'gold' : 'teal',
    },
    {
      v: 'documents',
      label: 'Compliance Docs',
      icon: Icon.Upload,
      num: clubs.filter((c) => Object.values(c.docs).every((v) => v)).length + '/' + clubs.length,
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
  ];

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
            dot: activeClub.paid ? 'teal' : 'coral',
          },
          {
            v: 'documents',
            label: 'Documents',
            icon: Icon.Upload,
            dot: docCompletion(activeClub) === 100 ? 'teal' : 'gold',
          },
          { v: 'cqi', label: 'CQI', icon: Icon.Star, dot: activeClub.cqi > 0 ? 'teal' : 'muted' },
          {
            v: 'fixtures',
            label: 'Fixtures',
            icon: Icon.Field,
            dot: hasReleased ? 'teal' : activeClub.paid ? 'gold' : 'muted',
            num: hasReleased ? 'NEW' : undefined,
          },
          { v: '_help', label: 'Need Help?', icon: Icon.Mail, action: () => setShowHelp(true) },
        ]
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
            onOnboardClub={onboardClub}
            onBulkOnboardClubs={bulkOnboardClubs}
            knownClubs={tenantConfig?.knownClubs ?? []}
          />
        );
      if (view === 'club_detail')
        return (
          <AdminClubDetail
            club={activeClub}
            gotoList={gotoList}
            onGenerateLink={() => generatePlayerRegLink(activeClub.id)}
            onSetPaid={setPaid}
            onInvite={inviteUser}
            toast={toastShow}
            allLeagues={allLeagues}
            onSetLeagues={(keys) => updateClub({ leagues: keys }).catch(() => {})}
            onAddNote={addNote}
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
            onOnboard={() => gotoAdminView('clubs_list')}
            toast={toastShow}
          />
        );
      if (view === 'documents')
        return (
          <AdminFiltered
            clubs={clubs}
            kind="docs"
            gotoClub={setActiveClub}
            onOnboard={() => gotoAdminView('clubs_list')}
            toast={toastShow}
          />
        );
      if (view === 'cqi_admin')
        return (
          <AdminFiltered
            clubs={clubs}
            kind="cqi"
            gotoClub={setActiveClub}
            onOnboard={() => gotoAdminView('clubs_list')}
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
          />
        );
      if (view === 'cqi')
        return (
          <CQIView
            club={activeClub}
            goto={gotoClubView}
            toast={toastShow}
            submissionDeadline={submissionDeadline}
            onSubmit={(score, answers) => {
              updateClub({ cqi: score, cqiAnswers: answers }).catch(() => {});
              gotoClubView('home');
            }}
          />
        );
      if (view === 'fixtures') {
        if (!activeClub.paid)
          return (
            <ComingSoon title="Fixtures & Venues" phase="02" unlocked={false} eta="Aug 2026" />
          );
        return (
          <ClubFixturesView
            club={activeClub}
            allSeries={allSeries}
            clubs={clubs}
            toast={toastShow}
          />
        );
      }
    }
    return null;
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

        <button className="h-bell">
          <Icon.Bell />
          <span className="h-bell-dot" />
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
                  v: '_settings',
                  label: 'Settings',
                  icon: Icon.Shield,
                  action: () =>
                    toastShow(
                      'Settings coming soon — workspace preferences, notifications and access controls.',
                      'warn',
                    ),
                },
                {
                  v: '_help',
                  label: 'Need Help?',
                  icon: Icon.Mail,
                  action: () => setShowHelp(true),
                },
              ].map((n) => (
                <button key={n.v} className="nav-item" onClick={n.action}>
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
          {renderMain()}
        </main>
      </div>

      {showOnboarding && role === 'club' && (
        <Onboarding
          club={activeClub}
          submissionDeadline={submissionDeadline}
          onClose={() => setShowOnboarding(false)}
          onComplete={() => {
            setOnboarded((o) => ({ ...o, [clubId]: true }));
            setShowOnboarding(false);
            toastShow('Welcome, ' + activeClub.chair.split(' ')[0] + " · let's get started");
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
            unionEmail={unionEmail}
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
              // Affiliation submit marks the club complete (locking the form) but
              // does NOT set paid — payment is a separate admin action.
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
            onSaveExco={saveExco}
            submissionDeadline={submissionDeadline}
            unionEmail={unionEmail}
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
function AdminFiltered({ clubs, kind, gotoClub, onOnboard, toast }) {
  const titles = {
    affiliation: {
      t: 'Affiliation tracker',
      crumb: 'Affiliations',
      desc: 'Track which clubs have completed the 2026/27 union affiliation form.',
      icon: Icon.Form,
      empty: 'Onboard your clubs to start tracking who has completed the 2026/27 affiliation form.',
    },
    docs: {
      t: 'Compliance docs tracker',
      crumb: 'Compliance Docs',
      desc: 'Monitor uploads of Constitution, AGM Minutes, Financial Statements and Exco Reps Listed.',
      icon: Icon.Upload,
      empty:
        'Onboard your clubs to start monitoring Constitution, AGM Minutes, Financials and Exco Reps uploads.',
    },
    cqi: {
      t: 'CQI submission tracker',
      crumb: 'CQI Submissions',
      desc: 'Real-time view of CQI self-assessments returned by clubs across all five categories.',
      icon: Icon.Star,
      empty:
        'Onboard your clubs to start collecting CQI self-assessments across all five categories.',
    },
  }[kind];

  // "Outstanding" depends on the tracker: unpaid (affiliation), any missing doc
  // (docs), or no CQI submission (cqi).
  const isOutstanding = (c) =>
    kind === 'affiliation'
      ? !c.paid
      : kind === 'docs'
        ? !Object.values(c.docs).every(Boolean)
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
          Payment: c.paid ? 'Submitted' : 'Outstanding',
          Submitted: c.paid
            ? 'Paid'
            : c.affiliation === 'complete'
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
            <Btn tone="teal" icon={Icon.Plus} onClick={onOnboard}>
              Onboard your first club
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
                    <th>Payment</th>
                    <th>Submitted</th>
                  </>
                )}
                {kind === 'docs' && (
                  <>
                    <th>Constitution</th>
                    <th>AGM Minutes</th>
                    <th>Financials</th>
                    <th>Exco Reps</th>
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
                        {c.paid ? (
                          <Pill tone="teal" dot>
                            Submitted
                          </Pill>
                        ) : (
                          <Pill tone="coral" dot>
                            Outstanding
                          </Pill>
                        )}
                      </td>
                      <td>
                        <span
                          style={{
                            fontSize: 11.5,
                            color: 'var(--muted)',
                            fontFamily: "'Montserrat',sans-serif",
                          }}
                        >
                          {c.paid
                            ? 'Paid'
                            : c.affiliation === 'complete'
                              ? 'Submitted'
                              : c.affiliation === 'in_progress'
                                ? 'Draft saved'
                                : '—'}
                        </span>
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

import { useState as useStateApp, useMemo as useMemoApp, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter, Routes, Route, Navigate,
  useNavigate, useLocation, useParams,
} from 'react-router-dom';
import {
  REQUIRED_DOCS, SAMPLE_CLUBS, SERIES,
  cohortStats, docCompletion,
} from './data.jsx';
import {
  Icon, Pill, Btn, ProgChip, ClubNameCell,
  affPill, cqiBand, useToast,
} from './atoms.jsx';
import {
  AdminDashboard, AdminClubsList, AdminClubDetail, AdminFixtures,
  CreateSeriesForm,
} from './admin.jsx';
import {
  ClubHome, AffiliationForm, DocumentsView, CQIView, ClubFixturesView,
} from './club.jsx';
import { Onboarding } from './onboarding.jsx';

/* ─── Brand mark: leaping dolphin silhouette ───
   Stylised stand-in until the user provides the official Hollywoodbets Dolphins logo. */
function DolphinMark() {
  return (
    <svg viewBox="0 0 64 64" fill="currentColor" aria-label="Dolphins emblem">
      {/* Body: arched leaping dolphin with curled tail */}
      <path d="M5 44
        C 5 26, 22 12, 40 14
        C 48 14.8, 55 16, 60 13
        L 55 24
        C 58 31, 53 41, 41 44
        L 38 38
        C 30 44, 18 45, 9 44
        Z"/>
      {/* Tail fluke */}
      <path d="M3 46 C 6 47, 10 48, 13 50 L 7 53 C 4 52, 2 49, 3 46 Z"/>
      {/* Dorsal fin */}
      <path d="M28 18 L 32 11 L 35 19 Z"/>
      {/* Eye */}
      <circle cx="49" cy="22" r="1.6" fill="rgba(255,255,255,0.92)"/>
    </svg>
  );
}

/* ─── Profile Select (entry screen) ─── */
function ProfileSelect({ onSelect, clubs }) {
  const stats = cohortStats(clubs);
  const unpaid = clubs.filter(c => !c.paid).length;

  return (
    <div className="ps-screen">
      <div className="ps-brand">
        <img className="ps-brand-logo" src="/dolphins-logo.png" alt="Hollywoodbets Dolphins"/>
        <div className="ps-eyebrow" style={{margin:0, color:"rgba(255,255,255,0.6)", fontSize:11}}>Smart Club Integration · KZNCU &amp; EMCU</div>
      </div>

      <div className="ps-intro">
        <div className="ps-eyebrow">KZNCU &amp; EMCU · 2026 / 27 Season</div>
        <h1 className="ps-title">Welcome — <em>choose your profile</em></h1>
        <p className="ps-desc">
          Sign in as a Dolphins administrator to manage all affiliated clubs, or as a club delegate to complete your affiliation, compliance and CQI submissions.
        </p>
      </div>

      <div className="ps-cards">
        {/* DOLPHINS ADMIN */}
        <button className="ps-card gold" onClick={() => onSelect("admin")}>
          <div className="ps-card-icon">
            <svg viewBox="0 0 28 28" fill="none">
              <path d="M14 3L4 7v6c0 6 4 9.5 10 11 6-1.5 10-5 10-11V7l-10-4z"
                    stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
              <path d="M9.5 14l3 3 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div>
            <div className="ps-card-role">Administrator</div>
            <div className="ps-card-title">Dolphins office</div>
          </div>
          <p className="ps-card-desc">
            Track the cohort, monitor affiliation payments, review compliance documents and CQI submissions across every KZNCU &amp; EMCU club.
          </p>
          <div className="ps-card-meta">
            <div className="ps-card-stat">
              <div className="ps-card-stat-n">{stats.total}</div>
              <div className="ps-card-stat-l">Clubs</div>
            </div>
            <div className="ps-card-stat">
              <div className="ps-card-stat-n">{stats.paid}</div>
              <div className="ps-card-stat-l">Affiliated</div>
            </div>
            <div className="ps-card-stat">
              <div className="ps-card-stat-n">{unpaid}</div>
              <div className="ps-card-stat-l">Outstanding</div>
            </div>
          </div>
          <div className="ps-card-cta">
            <span className="ps-card-cta-text">Enter admin console</span>
            <span className="ps-card-cta-arrow"><Icon.Arrow/></span>
          </div>
        </button>

        {/* CLUB */}
        <button className="ps-card teal" onClick={() => onSelect("club")}>
          <div className="ps-card-icon">
            <svg viewBox="0 0 28 28" fill="none">
              <circle cx="10" cy="11" r="4" stroke="currentColor" strokeWidth="1.8"/>
              <circle cx="20" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8"/>
              <path d="M2 23c1-3.5 4-5.2 8-5.2s7 1.7 8 5.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              <path d="M18 23c.5-2.6 2.6-4 5-4s4.5 1.4 5 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <div className="ps-card-role">Club portal</div>
            <div className="ps-card-title">Chairperson / Delegate</div>
          </div>
          <p className="ps-card-desc">
            Complete your 2026/27 affiliation form, upload compliance documents and submit the Club Quality Index self-assessment.
          </p>
          <div className="ps-card-meta">
            <div className="ps-card-stat">
              <div className="ps-card-stat-n">3</div>
              <div className="ps-card-stat-l">Submissions</div>
            </div>
            <div className="ps-card-stat">
              <div className="ps-card-stat-n">R 4,500</div>
              <div className="ps-card-stat-l">Union fee</div>
            </div>
            <div className="ps-card-stat">
              <div className="ps-card-stat-n">22 Jun</div>
              <div className="ps-card-stat-l">Deadline</div>
            </div>
          </div>
          <div className="ps-card-cta">
            <span className="ps-card-cta-text">Enter club portal</span>
            <span className="ps-card-cta-arrow"><Icon.Arrow/></span>
          </div>
        </button>
      </div>

      <div className="ps-footer">
        <span>v 0.9.0</span>
        <span className="dot"/>
        <span>KZNCU &amp; EMCU · 2026/27</span>
        <span className="dot"/>
        <span>Powered by Medicoach</span>
      </div>
    </div>
  );
}

/* ─── Main App ─── */


/* ─── TaskModal — wraps the affiliation form & documents view ─── */
function TaskModal({ eyebrow, title, sub, onClose, narrow, children }) {
  return (
    <div className="task-modal-backdrop" onClick={e=>e.target===e.currentTarget && onClose()}>
      <div className={`task-modal ${narrow?"narrow":""}`}>
        <div className="task-modal-head">
          <div className="task-modal-head-text">
            {eyebrow && <div className="task-modal-head-eyebrow">{eyebrow}</div>}
            <div className="task-modal-head-title">{title}</div>
          </div>
          <button className="task-modal-close" onClick={onClose} title="Close (your inputs are saved)">
            <Icon.X/>
          </button>
        </div>
        <div className="task-modal-body">
          {children}
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppRoutes/>
    </BrowserRouter>
  );
}

function AppRoutes() {
  const [clubs, setClubs] = useStateApp(SAMPLE_CLUBS);
  const [allSeries, setAllSeries] = useStateApp(SERIES);
  const [onboarded, setOnboarded] = useStateApp({});
  const [showOnboarding, setShowOnboarding] = useStateApp(false);
  const [showCreateSeries, setShowCreateSeries] = useStateApp(false);
  const [toastShow, toastNode] = useToast();
  const navigate = useNavigate();

  function updateSeries(seriesId, updater) {
    setAllSeries(prev => prev.map(s => s.id === seriesId ? updater(s) : s));
  }
  function deleteSeries(seriesId) {
    setAllSeries(prev => prev.filter(s => s.id !== seriesId));
  }
  function duplicateSeries(seriesId) {
    setAllSeries(prev => {
      const orig = prev.find(s => s.id === seriesId);
      if (!orig) return prev;
      const copy = {
        ...orig,
        id: "s-" + Date.now(),
        name: orig.name + " · Copy",
        released: false, releasedAt: null,
        fixtures: orig.fixtures.map((f, i) => ({...f, id: "fc" + Date.now() + "_" + i})),
      };
      return [...prev, copy];
    });
  }
  function setReleased(seriesId, value) {
    setAllSeries(prev => prev.map(s => s.id === seriesId
      ? {...s, released: value, releasedAt: value ? new Date().toISOString() : null}
      : s));
  }

  const shellProps = {
    clubs, setClubs, allSeries, setAllSeries, toastShow,
    onboarded, setOnboarded, showOnboarding, setShowOnboarding,
    showCreateSeries, setShowCreateSeries,
    updateSeries, deleteSeries, duplicateSeries, setReleased,
  };

  return (
    <>
      <Routes>
        <Route path="/" element={
          <ProfileSelect
            clubs={clubs}
            onSelect={(r) => navigate(r === "admin" ? "/admin/dashboard" : "/club/phoenix")}
          />
        }/>
        <Route path="/admin/*" element={<Shell role="admin" {...shellProps}/>}/>
        <Route path="/club/:clubId/*" element={<Shell role="club" {...shellProps}/>}/>
        <Route path="*" element={<Navigate to="/" replace/>}/>
      </Routes>
      {toastNode}
    </>
  );
}

function Shell({
  role, clubs, setClubs, allSeries, setAllSeries, toastShow,
  onboarded, setOnboarded, showOnboarding, setShowOnboarding,
  showCreateSeries, setShowCreateSeries,
  updateSeries, deleteSeries, duplicateSeries, setReleased,
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const routeParams = useParams();

  // ── Derive clubId from URL ──
  let clubId;
  if (role === "club") {
    clubId = routeParams.clubId;
  } else {
    const m = location.pathname.match(/^\/admin\/clubs\/([^/]+)/);
    clubId = m ? m[1] : "phoenix";   // fallback for header avatar before drilling in
  }

  const activeClub = useMemoApp(
    () => clubs.find(c => c.id === clubId) || clubs[0],
    [clubs, clubId]
  );

  // ── Derive view from URL (used for nav highlighting & modal logic) ──
  let view;
  if (role === "admin") {
    const seg = location.pathname.replace(/^\/admin\/?/, "");
    if (seg.startsWith("clubs/")) view = "club_detail";
    else if (seg === "clubs") view = "clubs_list";
    else if (seg === "cqi") view = "cqi_admin";
    else if (seg === "" || seg === "dashboard") view = "dashboard";
    else view = seg;                 // affiliations | documents | fixtures
  } else {
    const base = `/club/${clubId}`;
    if (location.pathname === base || location.pathname === base + "/") view = "home";
    else view = location.pathname.slice(base.length + 1);
  }

  // ── Auto-open onboarding the first time a club portal is entered ──
  useEffect(() => {
    if (role === "club" && activeClub && !activeClub.paid && !onboarded[clubId]) {
      const t = setTimeout(() => setShowOnboarding(true), 350);
      return () => clearTimeout(t);
    }
  }, [role, clubId]); // re-fire when URL switches club

  // ── Navigation helpers (replace old setView/setRole/setClubId) ──
  function switchProfile() {
    setShowOnboarding(false);
    navigate("/");
  }
  function gotoAdminView(v) {
    const map = { dashboard:"dashboard", clubs_list:"clubs", cqi_admin:"cqi" };
    navigate(`/admin/${map[v] || v}`);
  }
  function gotoClubView(v, cid = clubId) {
    navigate(v === "home" ? `/club/${cid}` : `/club/${cid}/${v}`);
  }
  function setActiveClub(id) {
    if (role === "admin") navigate(`/admin/clubs/${id}`);
    else gotoClubView("home", id);
  }
  function changeRole(r) {
    if (r === "admin") navigate("/admin/dashboard");
    else navigate(`/club/${clubId}`);
  }
  function changeClub(id) {
    navigate(`/club/${id}`);
    const c = clubs.find(x => x.id === id);
    if (!onboarded[id] && c && !c.paid) {
      setTimeout(() => setShowOnboarding(true), 250);
    }
  }

  // ── Club mutations (curried by current clubId) ──
  function updateClub(updates) {
    setClubs(cs => cs.map(c => c.id === clubId ? {...c, ...updates} : c));
  }
  function uploadDoc(key) {
    setClubs(cs => cs.map(c => c.id === clubId ? {...c, docs: {...c.docs, [key]: true}} : c));
  }
  function saveExco(members) {
    setClubs(cs => cs.map(c => c.id === clubId
      ? {...c, exco: members, docs: {...c.docs, exco: true}}
      : c));
  }

  // — NAV definition —
  const adminNav = [
    { v:"dashboard",   label:"Cohort Dashboard", icon:Icon.Dashboard },
    { v:"clubs_list",  label:"All Clubs",        icon:Icon.Clubs, num: clubs.length },
    { v:"affiliations",label:"Affiliations",     icon:Icon.Form,  num: clubs.filter(c=>c.paid).length+"/"+clubs.length, dot: clubs.filter(c=>!c.paid).length ? "gold" : "teal" },
    { v:"documents",   label:"Compliance Docs",  icon:Icon.Upload, num: clubs.filter(c=>Object.values(c.docs).every(v=>v)).length+"/"+clubs.length, dot:"gold" },
    { v:"cqi_admin",   label:"CQI Submissions",  icon:Icon.Star,   num: clubs.filter(c=>c.cqi>0).length+"/"+clubs.length, dot:"gold" },
    { v:"fixtures",   label:"Fixtures & Venues", icon:Icon.Field,  dot:"teal" },
  ];

  // Has any released series that includes this club?
  const releasedForMe = allSeries.filter(s => s.released && s.teams.includes(clubId));
  const hasReleased = releasedForMe.length > 0;

  const clubNav = [
    { v:"home",        label:"Home",           icon:Icon.Dashboard },
    { v:"affiliation", label:"Affiliation",    icon:Icon.Form,    dot: activeClub.paid ? "teal" : "coral" },
    { v:"documents",   label:"Documents",      icon:Icon.Upload,  dot: docCompletion(activeClub)===100 ? "teal" : "gold" },
    { v:"cqi",         label:"CQI",            icon:Icon.Star,    dot: activeClub.cqi>0 ? "teal" : "muted" },
    { v:"fixtures",    label:"Fixtures",       icon:Icon.Field,
      dot: hasReleased ? "teal" : activeClub.paid ? "gold" : "muted",
      num: hasReleased ? "NEW" : undefined },
  ];

  const nav = role === "admin" ? adminNav : clubNav;

  // — render main pane —
  function renderMain() {
    if (role === "admin") {
      const gotoList = () => gotoAdminView("clubs_list");
      if (view === "dashboard")    return <AdminDashboard clubs={clubs} gotoClub={setActiveClub} gotoList={gotoList} />;
      if (view === "clubs_list")   return <AdminClubsList clubs={clubs} gotoClub={setActiveClub} />;
      if (view === "club_detail")  return <AdminClubDetail club={activeClub} gotoList={gotoList} />;
      if (view === "affiliations") return <AdminFiltered clubs={clubs} kind="affiliation" gotoClub={setActiveClub}/>;
      if (view === "documents")    return <AdminFiltered clubs={clubs} kind="docs" gotoClub={setActiveClub}/>;
      if (view === "cqi_admin")    return <AdminFiltered clubs={clubs} kind="cqi" gotoClub={setActiveClub}/>;
      if (view === "fixtures")     return <AdminFixtures
                                              clubs={clubs}
                                              allSeries={allSeries}
                                              onCreateSeries={()=>setShowCreateSeries(true)}
                                              onUpdateSeries={updateSeries}
                                              onDeleteSeries={deleteSeries}
                                              onDuplicateSeries={duplicateSeries}
                                              onSetReleased={setReleased}
                                              toast={toastShow}
                                            />;
    } else {
      // Affiliation + Documents render in modals layered on top of Home (handled below).
      // The base content stays Home while those are open.
      if (view === "home" || view === "affiliation" || view === "documents")
        return <ClubHome club={activeClub} goto={gotoClubView} toast={toastShow} replayOnboarding={()=>setShowOnboarding(true)}/>;
      if (view === "cqi")      return <CQIView club={activeClub} goto={gotoClubView} toast={toastShow}
                                       onSubmit={(score)=>{ updateClub({cqi: score}); gotoClubView("home"); }}/>;
      if (view === "fixtures") {
        // Locked until affiliation is paid
        if (!activeClub.paid) return <ComingSoon title="Fixtures & Venues" phase="02" unlocked={false} eta="Aug 2026"/>;
        return <ClubFixturesView club={activeClub} allSeries={allSeries} clubs={clubs} toast={toastShow}/>;
      }
    }
    return null;
  }

  return (
    <div data-screen-label={role === "admin" ? "Admin · " + view : "Club · " + view}>
      {/* ─── Top header ─── */}
      <header className="app-header">
        <div className="h-logo">
          <img className="h-logo-img" src="/dolphins-logo.png" alt="Hollywoodbets Dolphins"/>
        </div>
        <div className="h-divider"/>
        <span className="h-sub">Smart Club Integration · KZNCU &amp; EMCU</span>

        <div className="h-spacer"/>

        {/* Role switch */}
        <div className="role-switch" title="Switch perspective">
          <button className={`role-btn ${role==="admin"?"active":""}`} onClick={()=>changeRole("admin")}>Admin · Dolphins</button>
          <button className={`role-btn club ${role==="club"?"active":""}`} onClick={()=>changeRole("club")}>Club</button>
        </div>

        {/* Club selector for club role */}
        {role === "club" && (
          <select
            className="field-select"
            style={{height:34, width:"auto", minWidth:180, background:"rgba(255,255,255,0.06)", color:"#fff", border:"1px solid rgba(255,255,255,0.08)", paddingRight:30, fontSize:12.5}}
            value={clubId} onChange={e=>changeClub(e.target.value)}
          >
            {clubs.map(c=><option key={c.id} value={c.id} style={{background:"#fff", color:"#000"}}>{c.name}</option>)}
          </select>
        )}

        <button className="h-switch" onClick={switchProfile} title="Log out and return to the login page">
          <svg viewBox="0 0 16 16" fill="none"><path d="M9 2H4a1 1 0 00-1 1v10a1 1 0 001 1h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M11 5l3 3-3 3M7 8h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Log out
        </button>

        <button className="h-bell"><Icon.Bell/><span className="h-bell-dot"/></button>

        <div className="h-user">
          <div className="h-avatar" style={{background: role==="admin"?"var(--gold)":"var(--teal)", color: role==="admin"?"var(--ink)":"#fff"}}>
            {role === "admin" ? "NN" : activeClub.chair.split(" ").map(w=>w[0]).slice(0,2).join("")}
          </div>
          <div>
            <div className="h-user-name">{role === "admin" ? "Niall Naidoo" : activeClub.chair}</div>
            <div className="h-user-role">{role === "admin" ? "Dolphins · Admin" : activeClub.name + " · Chair"}</div>
          </div>
        </div>
      </header>

      {/* ─── Shell ─── */}
      <div className="shell">
        {/* Left nav */}
        <aside className="nav">
          <div className="nav-section">{role === "admin" ? "Cohort" : "Integration journey"}</div>
          {nav.map(n=>(
            <button
              key={n.v}
              className={`nav-item ${view===n.v?"active":""}`}
              onClick={()=> role === "admin" ? gotoAdminView(n.v) : gotoClubView(n.v)}
            >
              <span className="ni-icon"><n.icon/></span>
              <span className="ni-label">{n.label}</span>
              {n.num && <span className={`ni-num ${n.num==="NEW"?"new":""}`}>{n.num}</span>}
              {!n.num && n.dot && <span className={`ni-dot ${n.dot}`}/>}
            </button>
          ))}

          {role === "admin" && (
            <>
              <div className="nav-section" style={{marginTop:18}}>Workspace</div>
              {[
                {v:"_settings", label:"Settings",       icon:Icon.Shield},
                {v:"_help",     label:"Help & support", icon:Icon.Mail},
              ].map(n=>(
                <button key={n.v} className="nav-item" onClick={()=>{}}>
                  <span className="ni-icon"><n.icon/></span>
                  <span className="ni-label">{n.label}</span>
                </button>
              ))}
            </>
          )}

          <div className="nav-footer">
            <strong>Dolphins</strong> · Smart Club Integration<br/>
            v 0.9.0 · KZNCU &amp; EMCU · 2026/27<br/>
            <span style={{color:"var(--muted-3)"}}>Powered by Medicoach</span>
          </div>
        </aside>

        {/* Main content */}
        <main className={`main ${view==="fixtures"?"fullbleed":""}`}>{renderMain()}</main>
      </div>

      {showOnboarding && role === "club" && (
        <Onboarding
          club={activeClub}
          onClose={() => setShowOnboarding(false)}
          onComplete={() => {
            setOnboarded(o => ({...o, [clubId]: true}));
            setShowOnboarding(false);
            toastShow("Welcome, " + activeClub.chair.split(" ")[0] + " · let's get started");
          }}
          onStart={() => gotoClubView("affiliation")}
        />
      )}

      {/* ─── Task modals: Affiliation form & Compliance documents ─── */}
      {role === "club" && view === "affiliation" && (
        <TaskModal
          eyebrow={`Phase 01 · ${activeClub.name}`}
          title={<>2026/27 <em>Affiliation Form</em></>}
          onClose={() => gotoClubView("home")}
        >
          <AffiliationForm
            club={activeClub}
            goto={gotoClubView}
            toast={toastShow}
            onSubmit={(payload)=>{
              updateClub({
                affiliation:"complete", paid:true,
                exco: payload.exco,
                coaches: payload.coaches || [],
                ground: payload.ground || null,
                docs: {...activeClub.docs, exco: true},
              });
              gotoClubView("home");
            }}
          />
        </TaskModal>
      )}

      {role === "club" && view === "documents" && (
        <TaskModal
          narrow
          eyebrow={`Compliance · ${activeClub.name}`}
          title={<>Required <em>compliance documents</em></>}
          onClose={() => gotoClubView("home")}
        >
          <DocumentsView
            club={activeClub}
            goto={gotoClubView}
            toast={toastShow}
            onUpload={uploadDoc}
            onSaveExco={saveExco}
          />
        </TaskModal>
      )}

      {role === "admin" && showCreateSeries && (
        <TaskModal
          eyebrow="Fixtures · KZNCU & EMCU"
          title={<>Create a new <em>series</em></>}
          onClose={() => setShowCreateSeries(false)}
        >
          <CreateSeriesForm
            clubs={clubs}
            onCreate={(s) => { setAllSeries(prev => [...prev, s]); toastShow(`${s.name} created · ${s.fixtures.length} fixtures generated`); }}
            onClose={() => setShowCreateSeries(false)}
          />
        </TaskModal>
      )}
    </div>
  );
}

/* ─── Filtered admin views (Affiliation / Docs / CQI) ─── */
function AdminFiltered({ clubs, kind, gotoClub }) {
  const titles = {
    affiliation: { t:"Affiliation tracker", crumb:"Affiliations", desc:"Track which clubs have completed and paid the 2026/27 union affiliation form." },
    docs:        { t:"Compliance docs tracker", crumb:"Compliance Docs", desc:"Monitor uploads of Constitution, AGM Minutes, Financial Statements and Exco Reps Listed." },
    cqi:         { t:"CQI submission tracker", crumb:"CQI Submissions", desc:"Real-time view of CQI self-assessments returned by clubs across all five categories." },
  }[kind];

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Dolphins · Admin Console / {titles.crumb}</div>
          <h1 className="ph-title">{titles.t}</h1>
          <p className="ph-desc">{titles.desc}</p>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" size="sm" icon={Icon.Mail}>Send reminder to outstanding</Btn>
          <Btn tone="ink" size="sm" icon={Icon.Download}>Export</Btn>
        </div>
      </div>

      <div className="tbl-w">
        <table className="tbl">
          <thead>
            <tr>
              <th>Club</th>
              <th>Chair</th>
              {kind === "affiliation" && <><th>Status</th><th>Payment</th><th>Submitted</th></>}
              {kind === "docs" && <><th>Constitution</th><th>AGM Minutes</th><th>Financials</th><th>Exco Reps</th><th>Progress</th></>}
              {kind === "cqi" && <><th>Score</th><th>Band</th><th>Submitted</th><th>Players</th></>}
              <th style={{width:60}}></th>
            </tr>
          </thead>
          <tbody>
            {clubs.map(c=>{
              return (
                <tr key={c.id} className="clickable" onClick={()=>gotoClub(c.id)}>
                  <td><ClubNameCell club={c}/></td>
                  <td><span style={{fontSize:12.5}}>{c.chair}</span></td>

                  {kind === "affiliation" && <>
                    <td>{affPill(c.affiliation)}</td>
                    <td>{c.paid
                          ? <Pill tone="teal" dot>Paid · R 4,500</Pill>
                          : <Pill tone="coral" dot>Outstanding</Pill>}</td>
                    <td><span style={{fontSize:11.5, color:"var(--muted)", fontFamily:"'Montserrat',sans-serif"}}>
                      {c.paid ? "12 May 2026" : c.affiliation==="in_progress" ? "Draft saved" : "—"}
                    </span></td>
                  </>}

                  {kind === "docs" && <>
                    {REQUIRED_DOCS.map(d=>(
                      <td key={d.key}>{c.docs[d.key]
                        ? <Pill tone="teal" dot>Uploaded</Pill>
                        : <Pill tone="coral" dot>Missing</Pill>}</td>
                    ))}
                    <td><ProgChip value={docCompletion(c)} tone={docCompletion(c)===100?"teal":docCompletion(c)>0?"gold":"coral"}/></td>
                  </>}

                  {kind === "cqi" && <>
                    <td><span style={{fontFamily:"'Montserrat',sans-serif", fontSize:15, fontWeight:800, color: c.cqi>=80?"var(--teal-deep)" : c.cqi>=65 ? "var(--ink)" : c.cqi>0 ? "#076B36" : "var(--muted-2)"}}>{c.cqi>0?c.cqi.toFixed(1):"—"}</span></td>
                    <td><Pill tone={cqiBand(c.cqi).tone}>{cqiBand(c.cqi).label}</Pill></td>
                    <td><span style={{fontSize:11.5, color:"var(--muted)", fontFamily:"'Montserrat',sans-serif"}}>
                      {c.cqi>0 ? "16 May 2026" : "—"}
                    </span></td>
                    <td><span style={{fontFamily:"'Montserrat',sans-serif", fontSize:12}}>{c.players || "—"}</span></td>
                  </>}

                  <td style={{textAlign:"right",paddingRight:18}}><Icon.Arrow/></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Coming soon placeholder for non-MVP phase modules ─── */
function ComingSoon({ title, phase, unlocked, eta }) {
  const headline   = unlocked ? "Coming soon" : "This phase unlocks after affiliation";
  const detailDesc = unlocked
    ? `Phase ${phase} of the Smart Club Integration journey. Your affiliation is in — this module is in final development and will arrive shortly.`
    : `Phase ${phase} of the Smart Club Integration journey. Activates automatically once your club has completed affiliation and uploaded compliance documents.`;
  const detailBody = unlocked
    ? "We're putting the finishing touches on this module. You'll be notified by email and on your home page the moment it's ready — no action needed from your side."
    : "Once your club has been confirmed by the Union office, this module activates with live data — fixtures, player registration, scoring, and clinical management — all sourced from the Medicoach platform.";
  const ring   = unlocked ? "var(--teal)"     : "var(--paper3)";
  const ringBg = unlocked ? "var(--teal-pale)": "var(--paper)";
  const ringFg = unlocked ? "var(--teal-deep)": "var(--muted-2)";

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Phase {phase} {unlocked && <>· <span style={{color:"var(--teal-deep)"}}>Unlocked</span></>}</div>
          <h1 className="ph-title">{title}</h1>
          <p className="ph-desc">{detailDesc}</p>
        </div>
        {unlocked && (
          <div className="ph-actions">
            <span className="pill pill-teal" style={{padding:"5px 12px"}}>
              <span className="sdot teal"/>Available {eta || "Q3 2026"}
            </span>
          </div>
        )}
      </div>

      <div style={{background:"var(--white)", border:"1px solid var(--line)", borderRadius:14, padding:"60px 40px", textAlign:"center"}}>
        <div style={{
          width:96, height:96, margin:"0 auto 20px", borderRadius:"50%",
          background:ringBg, border:`2px ${unlocked?"solid":"dashed"} ${ring}`,
          display:"flex",alignItems:"center",justifyContent:"center", color:ringFg,
        }}>
          {unlocked ? (
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M12 7v6M12 16v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          )}
        </div>
        <div style={{fontFamily:"'Montserrat',sans-serif", fontSize:18, fontWeight:700, marginBottom:8}}>{headline}</div>
        <div style={{fontSize:13, color:"var(--muted)", maxWidth:460, margin:"0 auto", lineHeight:1.6}}>
          {detailBody}
        </div>
        {unlocked && (
          <div style={{marginTop:22, display:"inline-flex", alignItems:"center", gap:8}}>
            <Btn tone="outline" size="sm" icon={Icon.Bell}>Notify me when ready</Btn>
            <Btn tone="ghost"   size="sm" icon={Icon.Mail}>Talk to the union office</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Embedded Fixture Automation Engine ─── */
function FixtureEngineEmbed({ role, club }) {
  const [filter, setFilter] = useStateApp("all"); // for admin: filter dropdown
  return (
    <>
      <div className="embed-bar">
        <span style={{
          fontFamily:"'Montserrat',sans-serif", fontSize:10, fontWeight:700,
          color:"#fff", background:"var(--ink)", padding:"3px 9px", borderRadius:10,
          letterSpacing:"0.1em",
        }}>PHASE 02</span>
        <div>
          <div className="crumb">
            {role==="admin"
              ? "Dolphins · Admin Console / Fixtures & Venues"
              : `Club Portal · ${club.name} / Fixtures`}
          </div>
          <div className="title">
            {role==="admin"
              ? "Provincial fixture automation & venue allocation"
              : "Your league fixtures & venue bookings"}
          </div>
        </div>
        <div className="spacer"/>
        {role === "admin" && (
          <select className="field-select" style={{height:30, width:180, fontSize:12}} value={filter} onChange={e=>setFilter(e.target.value)}>
            <option value="all">All leagues</option>
            <option value="prem">Premier League</option>
            <option value="prom">Promotion League</option>
            <option value="women">Premier Women</option>
            <option value="vets">Veterans League</option>
          </select>
        )}
        <Btn tone="outline" size="sm" icon={Icon.Download}>Export schedule</Btn>
        <Btn tone="ink" size="sm" icon={Icon.Arrow} onClick={()=>window.open("Fixture Automation Engine.html","_blank")}>Open full engine</Btn>
      </div>
      <iframe
        className="embed-frame"
        src="Fixture Automation Engine.html"
        title="Medicoach Fixture Automation Engine"
        onLoad={e=>{
          try {
            const doc = e.target.contentDocument;
            const css = doc.createElement("style");
            css.textContent = `
              .header{display:none !important}
              .shell{min-height:100vh !important}
              .panel{top:0 !important;height:100vh !important}
            `;
            doc.head.appendChild(css);
          } catch(err) { /* cross-origin or other */ }
        }}
      />
    </>
  );
}

createRoot(document.getElementById("root")).render(<App/>);
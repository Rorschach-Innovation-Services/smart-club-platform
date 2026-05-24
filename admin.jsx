/* ─── Admin views ─── */

const { useState: useStateA, useMemo: useMemoA } = React;

/* ─── AdminFixtures — series cards + drilldown fixture table with distance + travel-cost ─── */
function AdminFixtures({ clubs, allSeries, onCreateSeries, onUpdateSeries, onDeleteSeries, onDuplicateSeries, onSetReleased, toast }) {
  const [activeId, setActiveId] = useStateA(allSeries[0]?.id);
  const active = allSeries.find(s => s.id === activeId) || allSeries[0];
  const [confirm, setConfirm] = useStateA(null); // shared confirmation modal state
  const clubBy = (id) => clubs.find(c => c.id === id);

  // Aggregate distance + fuel per series
  const seriesAgg = (s) => {
    let totalKm = 0, totalCost = 0;
    s.fixtures.forEach(f => {
      const home = clubBy(f.home), away = clubBy(f.away);
      if (!home || !away) return;
      const c = fixtureCost(home, away, s.costPerKm, s.carsPerAwayTrip);
      totalKm += c.roundTripKm;
      totalCost += c.fuelR;
    });
    return { totalKm, totalCost };
  };

  // Shared release/recall confirmation builders — used by header, card, and bottom bar
  function askRelease(s) {
    setConfirm({
      title:`Release ${s.fixtures.length} fixtures to the league?`,
      body:`This publishes the full ${s.name} schedule to all ${s.teams.length} affiliated clubs. They'll see it in their portals immediately and receive email + SMS notifications.`,
      onYes: () => { onSetReleased(s.id, true); setConfirm(null); toast?.(s.name + " · released to " + s.teams.length + " clubs"); },
    });
  }
  function askRecall(s) {
    setConfirm({
      title:"Recall this release?",
      body:"All clubs will be notified that the schedule has been pulled back to draft. They won't see updates until you release again.",
      danger: true,
      onYes: () => { onSetReleased(s.id, false); setConfirm(null); toast?.(s.name + " · recalled to draft"); },
    });
  }

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Dolphins · Admin Console / Fixtures &amp; Venues</div>
          <h1 className="ph-title">Fixtures &amp; <em>Venues</em></h1>
          <p className="ph-desc">Auto-generated round-robin schedules across each KZNCU &amp; EMCU series. Home venues flow from the affiliation form. Travel distance and fuel cost are calculated for every away fixture.</p>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" icon={Icon.Download} size="sm">Export schedule</Btn>
          <Btn tone="outline" icon={Icon.Plus} size="sm" onClick={onCreateSeries}>Create series</Btn>
          {/* Primary CTA — always visible. State reflects the active series. */}
          {active && (active.released
            ? <Btn tone="outline" size="sm" onClick={()=>askRecall(active)}>Recall release</Btn>
            : <Btn tone="teal"    size="sm" icon={Icon.Arrow} onClick={()=>askRelease(active)}>Release to clubs</Btn>
          )}
        </div>
      </div>

      {/* Series cards strip — each card has its own quick release/recall button */}
      <div className="series-strip">
        {allSeries.map(s => {
          const agg = seriesAgg(s);
          return (
            <div key={s.id} className={`series-card ${s.id===activeId?"active":""}`} onClick={()=>setActiveId(s.id)} role="button" tabIndex={0}>
              <div className="series-card-head">
                <div className="series-card-name">{s.name}</div>
                {s.released
                  ? <div className="series-card-released">Released</div>
                  : <div className="series-card-draft">Draft</div>}
              </div>
              <div style={{fontSize:11, color:"var(--muted)", fontWeight:500, fontFamily:"'Montserrat',sans-serif"}}>
                {s.teams.length} teams · {s.fixtures.length} fixtures · {s.maxOvers} ov · start {new Date(s.startDate).toLocaleDateString("en-GB", {day:"numeric", month:"short"})}
              </div>
              <div className="series-card-meta">
                <div className="series-card-stat">
                  <div className="series-card-stat-l">Total km</div>
                  <div className="series-card-stat-n">{Math.round(agg.totalKm).toLocaleString()}</div>
                </div>
                <div className="series-card-stat">
                  <div className="series-card-stat-l">Travel</div>
                  <div className="series-card-stat-n" style={{color:"var(--green)"}}>R {Math.round(agg.totalCost).toLocaleString()}</div>
                </div>
              </div>
              {/* Quick action — stops card click so it doesn't also switch tab */}
              <div className="series-card-cta" onClick={e=>e.stopPropagation()}>
                {s.released
                  ? <button className="series-card-btn recall" onClick={()=>askRecall(s)}>↺ Recall draft</button>
                  : <button className="series-card-btn release" onClick={()=>askRelease(s)}>Release to clubs →</button>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Active series drill-down */}
      {active && (
        <FixtureTable
          series={active}
          clubs={clubs}
          onUpdateSeries={onUpdateSeries}
          onDeleteSeries={onDeleteSeries}
          onDuplicateSeries={onDuplicateSeries}
          onSetReleased={onSetReleased}
          onAskRelease={askRelease}
          onAskRecall={askRecall}
          toast={toast}
        />
      )}

      {/* Shared confirmation modal — portaled to document.body so it escapes the
          .main containing block (which has a residual transform from .main > *
          fadeUp animation that otherwise breaks position:fixed centering). */}
      {confirm && ReactDOM.createPortal(
        <div className="fix-confirm" onClick={(e)=>e.target===e.currentTarget && setConfirm(null)}>
          <div className="fix-confirm-box">
            <div className={`fix-confirm-icon ${confirm.danger?"danger":"go"}`}>
              {confirm.danger ? (
                <svg viewBox="0 0 24 24" fill="none"><path d="M12 2L22 21H2L12 2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><path d="M12 9v5M12 17v.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none"><path d="M4 12l5 5L20 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              )}
            </div>
            <div className="fix-confirm-title">{confirm.title}</div>
            <div className="fix-confirm-body">{confirm.body}</div>
            <div className="fix-confirm-actions">
              <Btn tone="outline" onClick={()=>setConfirm(null)}>Cancel</Btn>
              <Btn tone={confirm.danger?"ink":"teal"} icon={confirm.danger?undefined:Icon.Arrow} onClick={confirm.onYes}>
                {confirm.danger ? "Yes, recall" : "Release to clubs"}
              </Btn>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

/* ─── FixtureTable with full human-in-the-loop editing ─── */
function FixtureTable({ series, clubs, onUpdateSeries, onDeleteSeries, onDuplicateSeries, onSetReleased, onAskRelease, onAskRecall, toast }) {
  const clubBy = (id) => clubs.find(c => c.id === id);
  const [editingId, setEditingId] = useStateA(null);
  const [filter, setFilter] = useStateA("all");
  const [confirm, setConfirm] = useStateA(null); // {title, body, onYes} — for delete/regen only; release uses parent's modal

  // Helpers — operate on series.fixtures via onUpdateSeries
  function updateFixture(fixtureId, updates) {
    onUpdateSeries(series.id, (s) => ({
      ...s,
      fixtures: s.fixtures.map(f => f.id === fixtureId ? {...f, ...updates} : f),
    }));
  }
  function deleteFixture(fixtureId) {
    onUpdateSeries(series.id, (s) => ({
      ...s,
      fixtures: s.fixtures.filter(f => f.id !== fixtureId),
    }));
  }
  function addFixture() {
    const newId = "f" + Date.now();
    const last = series.fixtures[series.fixtures.length - 1];
    const nextRound = last ? last.round + 1 : 1;
    const baseDate = last ? new Date(last.date) : new Date(series.startDate);
    baseDate.setDate(baseDate.getDate() + 7);
    const newFix = {
      id: newId,
      round: nextRound,
      date: baseDate.toISOString().slice(0,10),
      home: series.teams[0],
      away: series.teams[1] || series.teams[0],
      status: "scheduled",
    };
    onUpdateSeries(series.id, (s) => ({...s, fixtures: [...s.fixtures, newFix]}));
    setEditingId(newId);
    toast?.("Fixture added — edit details");
  }
  function regenerate() {
    onUpdateSeries(series.id, (s) => ({
      ...s,
      fixtures: generateRoundRobin(s.teams, s.startDate),
    }));
    setConfirm(null);
    toast?.(`${series.name} · fixtures regenerated`);
  }

  // Build rows with computed cost
  const allRows = series.fixtures.map(f => {
    const home = clubBy(f.home), away = clubBy(f.away);
    const c = fixtureCost(home, away, series.costPerKm, series.carsPerAwayTrip);
    return { f, home, away, c };
  });
  let totalKm = 0, totalCost = 0;
  allRows.forEach(r => { totalKm += r.c.roundTripKm; totalCost += r.c.fuelR; });
  const rows = filter === "all" ? allRows : allRows.filter(r => (r.f.status||"scheduled") === filter);

  const statusCounts = {
    all: allRows.length,
    scheduled: allRows.filter(r => (r.f.status||"scheduled") === "scheduled").length,
    completed: allRows.filter(r => r.f.status === "completed").length,
    postponed: allRows.filter(r => r.f.status === "postponed").length,
    cancelled: allRows.filter(r => r.f.status === "cancelled").length,
  };

  return (
    <div>
      {/* Hero header */}
      <div className="fix-header">
        <div>
          <div className="fix-header-title">{series.name}</div>
          <div className="fix-header-sub">
            {series.seriesType} · {series.teams.length} teams · {series.fixtures.length} fixtures · {series.maxOvers} overs · {series.category}
          </div>
        </div>
        <div className="fix-header-aggs">
          <div className="fix-header-agg">
            <div className="fix-header-agg-l">Season distance</div>
            <div className="fix-header-agg-n"><CountUp to={Math.round(totalKm)}/><span className="unit">km</span></div>
          </div>
          <div className="fix-header-agg">
            <div className="fix-header-agg-l">Travel cost</div>
            <div className="fix-header-agg-n">R <CountUp to={Math.round(totalCost)}/></div>
          </div>
          <div className="fix-header-agg">
            <div className="fix-header-agg-l">@ R / km</div>
            <div className="fix-header-agg-n">R {series.costPerKm.toFixed(2)}<span className="unit">× {series.carsPerAwayTrip} cars</span></div>
          </div>
        </div>
      </div>

      {/* Toolbar — filter + actions */}
      <div className="fix-toolbar">
        <div className="fix-toolbar-left">
          {[
            {k:"all",       label:"All"},
            {k:"scheduled", label:"Scheduled"},
            {k:"completed", label:"Completed"},
            {k:"postponed", label:"Postponed"},
            {k:"cancelled", label:"Cancelled"},
          ].map(f => (
            <button key={f.k} className={`filter-pill ${filter===f.k?"active":""}`} onClick={()=>setFilter(f.k)}>
              {f.label}<span className="count">{statusCounts[f.k]}</span>
            </button>
          ))}
        </div>
        <div className="fix-toolbar-right">
          <Btn tone="outline" size="sm" icon={Icon.Plus} onClick={addFixture}>Add fixture</Btn>
          <Btn tone="outline" size="sm" onClick={()=>setConfirm({
            title: "Regenerate all fixtures?",
            body: "This will replace every fixture in this series with a fresh round-robin based on the current teams + start date. All manual edits, dates, and status changes will be lost. This cannot be undone.",
            onYes: regenerate,
            danger: true,
          })}>↻ Regenerate</Btn>
          <Btn tone="outline" size="sm" onClick={()=>{ onDuplicateSeries(series.id); toast?.("Series duplicated"); }}>Duplicate</Btn>
          <Btn tone="ghost" size="sm" onClick={()=>setConfirm({
            title: "Delete this series?",
            body: `Permanently remove "${series.name}" along with all ${series.fixtures.length} fixtures. The Dolphins office cannot undo this.`,
            onYes: () => { onDeleteSeries(series.id); setConfirm(null); toast?.("Series deleted"); },
            danger: true,
          })}>Delete series</Btn>
        </div>
      </div>

      {/* Table */}
      <div className="fix-table-wrap">
        <table className="fix-table">
          <thead>
            <tr>
              <th style={{width:50}}>Rd</th>
              <th style={{width:120}}>Date</th>
              <th>Home (host)</th>
              <th>Venue · Suburb</th>
              <th>Away (visitors)</th>
              <th style={{width:90, textAlign:"right"}}>Distance</th>
              <th style={{width:110, textAlign:"right"}}>Travel</th>
              <th style={{width:110}}>Status</th>
              <th style={{width:80}}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({f, home, away, c}) => {
              if (editingId === f.id) {
                return <EditFixtureRow
                  key={f.id}
                  fixture={f}
                  teams={series.teams.map(clubBy).filter(Boolean)}
                  onSave={(updates) => { updateFixture(f.id, updates); setEditingId(null); }}
                  onCancel={() => setEditingId(null)}
                />;
              }
              const status = f.status || "scheduled";
              return (
                <tr key={f.id} className={status === "cancelled" || status === "postponed" ? "fix-muted-row" : ""}>
                  <td><span className="fix-row-rd">R{f.round}</span></td>
                  <td><span className="fix-row-date">{new Date(f.date).toLocaleDateString("en-GB", {weekday:"short", day:"numeric", month:"short"})}</span></td>
                  <td>
                    <div className="fix-row-team">
                      {home && <ClubAvatar club={home} size={26}/>}
                      <div>
                        <div className="fix-row-team-name">{home?.name || "TBD"}</div>
                        <div className="fix-row-team-sub">{home?.sub}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="fix-row-venue">
                      <div className="fix-row-venue-name">{f.venueOverride || home?.ground?.venue || "—"}</div>
                      <div className="fix-row-venue-suburb">{home?.ground?.suburb || ""}</div>
                    </div>
                  </td>
                  <td>
                    <div className="fix-row-team">
                      {away && <ClubAvatar club={away} size={26}/>}
                      <div>
                        <div className="fix-row-team-name">{away?.name || "TBD"}</div>
                        <div className="fix-row-team-sub">{away?.sub}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{textAlign:"right"}}><span className="fix-row-dist">{c.distanceKm.toFixed(1)}<span className="unit">km</span></span></td>
                  <td style={{textAlign:"right"}}><span className="fix-row-cost"><span className="cur">R</span>{Math.round(c.fuelR).toLocaleString()}</span></td>
                  <td><span className={`fix-status ${status}`}>{status}</span></td>
                  <td>
                    <div className="fix-row-actions">
                      <button className="fix-action-btn" title="Edit fixture" onClick={()=>setEditingId(f.id)}>
                        <svg viewBox="0 0 16 16" fill="none"><path d="M11 2l3 3-7.5 7.5L3 13l.5-3.5L11 2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>
                      </button>
                      <button className="fix-action-btn danger" title="Delete fixture" onClick={()=>deleteFixture(f.id)}>
                        <svg viewBox="0 0 16 16" fill="none"><path d="M3 4h10M5 4l1-2h4l1 2M5 4v9a1 1 0 001 1h4a1 1 0 001-1V4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan="9" style={{padding:"28px", textAlign:"center", color:"var(--muted)", fontSize:13}}>
                No fixtures match this filter.
              </td></tr>
            )}
          </tbody>
        </table>
        <div className="fix-totals">
          <div className="fix-totals-item">
            <div className="fix-totals-l">Fixtures</div>
            <div className="fix-totals-n">{series.fixtures.length}</div>
          </div>
          <div className="fix-totals-item">
            <div className="fix-totals-l">Total km (round-trip)</div>
            <div className="fix-totals-n">{Math.round(totalKm).toLocaleString()} km</div>
          </div>
          <div className="fix-totals-item">
            <div className="fix-totals-l">Season fuel total</div>
            <div className="fix-totals-n green">R {Math.round(totalCost).toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Release bar — bottom-right CTA to publish the fixtures to clubs */}
      <div className={`fix-release-bar ${series.released ? "released" : ""}`}>
        <div className="fix-release-text">
          {series.released ? (
            <>
              <div className="fix-release-eyebrow">✓ Live to clubs</div>
              <div className="fix-release-text-title">Fixtures released to all {series.teams.length} clubs</div>
              <div className="fix-release-text-sub">
                Published {new Date(series.releasedAt).toLocaleString("en-GB", {day:"numeric", month:"short", hour:"2-digit", minute:"2-digit"})} · every club portal now shows their schedule + travel costs · email + SMS notifications sent
              </div>
            </>
          ) : (
            <>
              <div className="fix-release-eyebrow">Draft mode</div>
              <div className="fix-release-text-title">Visible only to the Dolphins office</div>
              <div className="fix-release-text-sub">
                Once released, every fixture goes live in every club portal, the Athlete Management System is notified, and email/SMS reminders go out to chairs &amp; captains.
              </div>
            </>
          )}
        </div>
        <div className="fix-release-actions">
          {series.released
            ? <Btn tone="outline" onClick={()=>onAskRecall?.(series)}>Recall draft</Btn>
            : <Btn tone="teal" icon={Icon.Arrow} onClick={()=>onAskRelease?.(series)}>Release to clubs →</Btn>}
        </div>
      </div>

      {/* Confirmation modal */}
      {confirm && (
        <div className="fix-confirm" onClick={(e)=>e.target===e.currentTarget && setConfirm(null)}>
          <div className="fix-confirm-box">
            <div className="fix-confirm-icon">
              <svg viewBox="0 0 24 24" fill="none"><path d="M12 2L22 21H2L12 2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><path d="M12 9v5M12 17v.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
            </div>
            <div className="fix-confirm-title">{confirm.title}</div>
            <div className="fix-confirm-body">{confirm.body}</div>
            <div className="fix-confirm-actions">
              <Btn tone="outline" onClick={()=>setConfirm(null)}>Cancel</Btn>
              <Btn tone="ink" onClick={confirm.onYes}>Yes, continue</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* Inline edit row */
function EditFixtureRow({ fixture, teams, onSave, onCancel }) {
  const [draft, setDraft] = useStateA({
    round: fixture.round,
    date: fixture.date,
    home: fixture.home,
    away: fixture.away,
    venueOverride: fixture.venueOverride || "",
    status: fixture.status || "scheduled",
  });
  function u(k, v) { setDraft(prev => ({...prev, [k]: v})); }
  return (
    <tr className="fix-edit-tr">
      <td colSpan="9">
        <div className="fix-edit-grid">
          <div className="fix-edit-field">
            <label>Round</label>
            <input type="number" min="1" value={draft.round} onChange={e=>u("round", parseInt(e.target.value)||1)}/>
          </div>
          <div className="fix-edit-field">
            <label>Date</label>
            <input type="date" value={draft.date} onChange={e=>u("date", e.target.value)}/>
          </div>
          <div className="fix-edit-field">
            <label>Home (host)</label>
            <select value={draft.home} onChange={e=>u("home", e.target.value)}>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="fix-edit-field">
            <label>Away (visitors)</label>
            <select value={draft.away} onChange={e=>u("away", e.target.value)}>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="fix-edit-field" style={{gridColumn:"span 2"}}>
            <label>Venue override</label>
            <input type="text" placeholder="(use home club's ground)" value={draft.venueOverride} onChange={e=>u("venueOverride", e.target.value)}/>
          </div>
          <div className="fix-edit-field">
            <label>Status</label>
            <select value={draft.status} onChange={e=>u("status", e.target.value)}>
              <option value="scheduled">Scheduled</option>
              <option value="completed">Completed</option>
              <option value="postponed">Postponed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div className="fix-edit-actions" style={{gridColumn:"span 6", justifyContent:"flex-end", marginTop:8}}>
            <Btn tone="ghost" size="sm" onClick={onCancel}>Cancel</Btn>
            <Btn tone="ink" size="sm" icon={Icon.Check} onClick={()=>onSave(draft)}>Save changes</Btn>
          </div>
        </div>
      </td>
    </tr>
  );
}

/* ─── CreateSeriesForm — long form mirroring the cricclubs structure ─── */
function CreateSeriesForm({ clubs, onCreate, onClose }) {
  const [d, setD] = useStateA({
    name:"", startDate:"", divisions:false, groups:1,
    maxOvers:20, maxPlayers:11, rosterLimit:"No Limit",
    ballType:"Hard Tennis Ball", seriesType:"Twenty20 (16-25 overs)",
    powerPlay:false, category:"Men", level:"Club",
    winPoints:2, bonusPoints:0, lossPoints:0, tiePoints:1, abandonedPoints:1,
    ballsPerOver:0, maxBallsPerOver:0, minLeagueMatches:0,
    configureExtras:false, lockAfterLive:false, lockAfterManual:false, preventTeamSwitch:false,
    umpireReportsMandatory:false, captainReportsMandatory:false, sendReportEmails:false,
    rankCalculator:"New", hideSeriesDetails:false, allowLockedRegistration:false,
    pointsTableOrder:["Most Points", "NRR", "Head To Head", "Number of Wins", "Win Percentage"],
    tags:"",
    teams: [],
    costPerKm: 4.5, carsPerAwayTrip: 3,
  });
  function u(k, v) { setD(prev => ({...prev, [k]: v})); }
  function toggleTeam(id) { setD(prev => ({...prev, teams: prev.teams.includes(id) ? prev.teams.filter(t=>t!==id) : [...prev.teams, id]})); }
  function moveOrder(idx, dir) {
    setD(prev => {
      const arr = [...prev.pointsTableOrder];
      const j = idx + dir;
      if (j < 0 || j >= arr.length) return prev;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
      return {...prev, pointsTableOrder: arr};
    });
  }

  const eligibleTeams = clubs.filter(c => c.paid);
  const canCreate = d.name && d.startDate && d.teams.length >= 2;

  function submit() {
    if (!canCreate) return;
    const series = {
      id: "s-" + Date.now(),
      ...d,
      tags: d.tags ? d.tags.split(",").map(s=>s.trim()).filter(Boolean) : [],
      fixtures: generateRoundRobin(d.teams, d.startDate),
    };
    onCreate(series);
    onClose();
  }

  return (
    <div className="cs-form">
      {/* Basic info */}
      <div className="cs-row">
        <div className="cs-row-label">Series Name<span className="req">*</span></div>
        <div className="cs-row-input"><input className="field-input" placeholder="e.g. Premier League T20 · 2026/27" value={d.name} onChange={e=>u("name",e.target.value)}/></div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Start Date<span className="req">*</span></div>
        <div className="cs-row-input"><input type="date" value={d.startDate} onChange={e=>u("startDate",e.target.value)}/></div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Series has Divisions?</div>
        <div className="cs-row-input"><YN value={d.divisions} onChange={v=>u("divisions",v)}/></div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Groups</div>
        <div className="cs-row-input"><input className="field-input" type="number" min="1" max="8" value={d.groups} onChange={e=>u("groups", parseInt(e.target.value)||1)} style={{width:90}}/></div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Maximum Overs</div>
        <div className="cs-row-input">
          <select className="field-select" value={d.maxOvers} onChange={e=>u("maxOvers",parseInt(e.target.value))} style={{width:120}}>
            {[10,15,20,25,30,40,45,50].map(v=><option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Max Players per Team in a Match</div>
        <div className="cs-row-input">
          <select className="field-select" value={d.maxPlayers} onChange={e=>u("maxPlayers",parseInt(e.target.value))} style={{width:90}}>
            {[7,8,9,10,11,12,13].map(v=><option key={v}>{v}</option>)}
          </select>
        </div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Max Player Limit for Roster</div>
        <div className="cs-row-input">
          <select className="field-select" value={d.rosterLimit} onChange={e=>u("rosterLimit",e.target.value)} style={{width:130}}>
            <option>No Limit</option><option>15</option><option>18</option><option>20</option><option>25</option>
          </select>
        </div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Ball Type</div>
        <div className="cs-row-input">
          <select className="field-select" value={d.ballType} onChange={e=>u("ballType",e.target.value)} style={{width:200}}>
            <option>Cricket Ball</option><option>Hard Tennis Ball</option><option>Tape Ball</option>
          </select>
        </div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Series Type</div>
        <div className="cs-row-input">
          <select className="field-select" value={d.seriesType} onChange={e=>u("seriesType",e.target.value)} style={{width:220}}>
            <option>Twenty20 (16-25 overs)</option><option>One-Day (40-50 overs)</option><option>Multi-Day</option><option>The Hundred</option>
          </select>
        </div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Power Play Applicable?</div>
        <div className="cs-row-input"><YN value={d.powerPlay} onChange={v=>u("powerPlay",v)}/></div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Category</div>
        <div className="cs-row-input">
          <select className="field-select" value={d.category} onChange={e=>u("category",e.target.value)} style={{width:120}}>
            <option>Men</option><option>Women</option><option>Mixed</option><option>U19</option>
          </select>
        </div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Level</div>
        <div className="cs-row-input">
          <select className="field-select" value={d.level} onChange={e=>u("level",e.target.value)} style={{width:140}}>
            <option>Club</option><option>School</option><option>Veterans</option>
          </select>
        </div>
      </div>

      {/* Points */}
      <div className="cs-section">
        <div className="cs-section-title">— Points Awards</div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Match outcomes<span className="req">*</span></div>
        <div className="cs-row-input cs-row-multi">
          <div className="cs-row-multi-item"><label>Win</label><input type="number" value={d.winPoints} onChange={e=>u("winPoints",parseInt(e.target.value)||0)}/></div>
          <div className="cs-row-multi-item"><label>Bonus</label><input type="number" value={d.bonusPoints} onChange={e=>u("bonusPoints",parseInt(e.target.value)||0)}/></div>
          <div className="cs-row-multi-item"><label>Loss</label><input type="number" value={d.lossPoints} onChange={e=>u("lossPoints",parseInt(e.target.value)||0)}/></div>
          <div className="cs-row-multi-item"><label>Tie</label><input type="number" value={d.tiePoints} onChange={e=>u("tiePoints",parseInt(e.target.value)||0)}/></div>
          <div className="cs-row-multi-item"><label>Abandoned</label><input type="number" value={d.abandonedPoints} onChange={e=>u("abandonedPoints",parseInt(e.target.value)||0)}/></div>
        </div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Balls per over / Max</div>
        <div className="cs-row-input cs-row-multi">
          <div className="cs-row-multi-item"><label>Standard</label><input type="number" value={d.ballsPerOver} onChange={e=>u("ballsPerOver",parseInt(e.target.value)||0)}/></div>
          <div className="cs-row-multi-item"><label>Max</label><input type="number" value={d.maxBallsPerOver} onChange={e=>u("maxBallsPerOver",parseInt(e.target.value)||0)}/></div>
        </div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Minimum league matches (player playoff eligibility)</div>
        <div className="cs-row-input"><input className="field-input" type="number" value={d.minLeagueMatches} onChange={e=>u("minLeagueMatches",parseInt(e.target.value)||0)} style={{width:90}}/></div>
      </div>

      {/* Yes / No config */}
      <div className="cs-section">
        <div className="cs-section-title">— Match &amp; Scorecard Configuration</div>
      </div>
      {[
        ["configureExtras","Configure extras as good balls?"],
        ["lockAfterLive","Lock scorecard after live scoring?"],
        ["lockAfterManual","Lock scorecard after manual update?"],
        ["preventTeamSwitch","Prevent players switching teams after playing?"],
        ["umpireReportsMandatory","Umpire reports mandatory?"],
        ["captainReportsMandatory","Captain reports mandatory?"],
        ["sendReportEmails","Email captain/umpires for end-of-match reports?"],
        ["hideSeriesDetails","Hide series details?"],
        ["allowLockedRegistration","Allow player registration when team is locked?"],
      ].map(([key, label]) => (
        <div key={key} className="cs-row">
          <div className="cs-row-label">{label}</div>
          <div className="cs-row-input"><YN value={d[key]} onChange={v=>u(key,v)}/></div>
        </div>
      ))}
      <div className="cs-row">
        <div className="cs-row-label">Rank Calculator</div>
        <div className="cs-row-input"><Choice value={d.rankCalculator} onChange={v=>u("rankCalculator",v)} options={["Old","New"]}/></div>
      </div>

      {/* Travel cost defaults */}
      <div className="cs-section">
        <div className="cs-section-title">— Travel &amp; Logistics</div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Default cost per km / Cars per away trip</div>
        <div className="cs-row-input cs-row-multi">
          <div className="cs-row-multi-item"><label>R / km</label><input type="number" step="0.10" value={d.costPerKm} onChange={e=>u("costPerKm",parseFloat(e.target.value)||0)}/></div>
          <div className="cs-row-multi-item"><label>Cars</label><input type="number" value={d.carsPerAwayTrip} onChange={e=>u("carsPerAwayTrip",parseInt(e.target.value)||1)}/></div>
        </div>
      </div>

      {/* Points Table Order */}
      <div className="cs-section">
        <div className="cs-section-title">— Points Table Order</div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Tie-break sequence (top wins first)</div>
        <div className="cs-row-input">
          <div className="cs-points-list">
            {d.pointsTableOrder.map((rule, idx)=>(
              <div key={rule} className="cs-points-row">
                <span className="order-num">{idx+1}</span>
                {rule}
                <span className="cs-points-grip" style={{display:"flex",gap:4}}>
                  <button onClick={()=>moveOrder(idx,-1)} disabled={idx===0} style={{background:"transparent",border:0,color:"var(--muted)",cursor:idx===0?"not-allowed":"pointer",padding:2}}>↑</button>
                  <button onClick={()=>moveOrder(idx, 1)} disabled={idx===d.pointsTableOrder.length-1} style={{background:"transparent",border:0,color:"var(--muted)",cursor:idx===d.pointsTableOrder.length-1?"not-allowed":"pointer",padding:2}}>↓</button>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Teams */}
      <div className="cs-section">
        <div className="cs-section-title">— Teams Entered ({d.teams.length} selected)</div>
      </div>
      <div className="cs-row">
        <div className="cs-row-label">Pick affiliated clubs (paid only)</div>
        <div className="cs-row-input">
          <div className="cs-teams-grid">
            {eligibleTeams.map(c => {
              const on = d.teams.includes(c.id);
              return (
                <button key={c.id} className={`cs-team-chip ${on?"on":""}`} onClick={()=>toggleTeam(c.id)}>
                  {on && <Icon.Check/>}{c.name}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Tags */}
      <div className="cs-row">
        <div className="cs-row-label">Tags <span style={{color:"var(--muted)", fontSize:11, marginLeft:4}}>(comma-separated)</span></div>
        <div className="cs-row-input"><input className="field-input" placeholder="Premier, Men, Round-robin" value={d.tags} onChange={e=>u("tags",e.target.value)}/></div>
      </div>

      <div className="row" style={{marginTop:22, justifyContent:"space-between", gap:10, padding:"12px 0"}}>
        <div style={{fontSize:11.5, color:"var(--muted)", fontFamily:"'Montserrat',sans-serif", fontWeight:500}}>
          {canCreate
            ? `Ready · will generate ${(d.teams.length * (d.teams.length-1) / 2)} round-robin fixtures from ${d.startDate}`
            : "Series name, start date and at least 2 teams are required"}
        </div>
        <div className="row" style={{gap:8}}>
          <Btn tone="outline" onClick={onClose}>Cancel</Btn>
          <Btn tone="teal" icon={Icon.Check} disabled={!canCreate} onClick={submit}>Create series</Btn>
        </div>
      </div>
    </div>
  );
}

function AdminDashboard({ clubs, gotoClub, gotoList }) {
  const stats = cohortStats(clubs);
  const pct = (n,d) => Math.round(n/d*100);

  // Sort by progress descending for "at risk" / "leaders"
  const ranked = [...clubs].map(c => ({...c, prog: overallProgress(c)})).sort((a,b)=>b.prog-a.prog);
  const leaders = ranked.slice(0, 5);
  const atRisk  = [...ranked].sort((a,b)=>a.prog-b.prog).slice(0, 5);

  // Phase completion roll-up
  const phases = [
    { num:"01", label:"Affiliation",   tone:"navy",  done: clubs.filter(c=>c.paid).length },
    { num:"02", label:"League / Fixtures", tone:"teal", done: clubs.filter(c=>c.affiliation==="complete").length },
    { num:"03", label:"Player Registration", tone:"navy", done: clubs.filter(c=>c.players >= 30).length },
    { num:"04", label:"Live Scoring / Talent ID", tone:"teal", done: 0 },
    { num:"05", label:"Compliance Docs", tone:"gold", done: clubs.filter(c=>Object.values(c.docs).every(v=>v)).length },
  ];

  return (
    <div>
      {/* Aspirational hero banner */}
      <div className="hero-banner" style={{backgroundImage:"url('players/ackerman-green.jpg?v=8')", height:170}}>
        <div className="hero-content">
          <div className="hero-eyebrow">Hollywoodbets Dolphins · KZNCU &amp; EMCU</div>
          <h2 className="hero-title">Building the next <em>generation</em>.</h2>
          <p className="hero-sub">Every club below is a feeder for our provincial squad. Track readiness, lift standards, identify talent.</p>
        </div>
        <div className="hero-attrib"><strong>Marques Ackerman</strong> · 78* (63)</div>
      </div>

      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Dolphins · Admin Console</div>
          <h1 className="ph-title">Club Integration <em>Cohort</em></h1>
          <p className="ph-desc">86 affiliated clubs across KZNCU &amp; EMCU. Track affiliation, document compliance, CQI scoring and franchise readiness for the 2026/27 season.</p>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" icon={Icon.Download} size="sm">Export cohort report</Btn>
          <Btn tone="ink" icon={Icon.Mail} size="sm">Send bulk reminder</Btn>
        </div>
      </div>

      {/* Deadline banner */}
      <div className="deadline">
        <div className="deadline-icon"><Icon.Clock/></div>
        <div className="deadline-text">
          <strong>Submission deadline · 22 June 2026.</strong> Clubs must complete affiliation, upload required compliance documents, and submit the CQI form. <span className="days">31 days remaining</span>.
        </div>
        <div className="deadline-cta">
          <Btn tone="outline" size="sm">Edit deadline</Btn>
        </div>
      </div>

      <div className="kpi-strip">
        <KPI label="Total clubs" num={<CountUp to={stats.total}/>} sub="2026/27 season" />
        <KPI tone={statusFor(pct(stats.paid, stats.total))}
             label="Affiliated &amp; paid"
             num={<CountUp to={stats.paid}/>}
             sub={`${pct(stats.paid, stats.total)}% of cohort`}/>
        <KPI tone={statusFor(pct(stats.docsComplete, stats.total))}
             label="Docs compliant"
             num={<CountUp to={stats.docsComplete}/>}
             sub={`${pct(stats.docsComplete, stats.total)}% complete`}/>
        <KPI tone={statusFor(pct(stats.cqiSubmitted, stats.total))}
             label="CQI submitted"
             num={<CountUp to={stats.cqiSubmitted}/>}
             sub={`${pct(stats.cqiSubmitted, stats.total)}% submitted`}/>
        <KPI tone={statusFor(stats.avgCqi, 75, 60)}
             label="Avg CQI score"
             num={<CountUp to={stats.avgCqi} decimals={1}/>}
             sub="of 100"/>
      </div>

      {/* Phase roll-up */}
      <Card title="Integration phase roll-up" sub="Cohort progress through the 5-phase smart integration journey">
        <div className="phase-track" style={{borderRadius:0, border:"none"}}>
          {phases.map((p,i)=>(
            <div key={i} className="phase-step" style={{padding:"14px 18px", borderRight: i<phases.length-1?"1px solid var(--line)":"none"}}>
              <div className="ps-n">PHASE {p.num}</div>
              <div className="ps-t">{p.label}</div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginTop:10}}>
                <div style={{flex:1}}><ProgressBar value={pct(p.done, stats.total)} tone={p.tone}/></div>
                <div style={{fontFamily:"'Montserrat',sans-serif", fontSize:11, color:"var(--muted)"}}>{p.done}/{stats.total}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div style={{display:"grid", gridTemplateColumns:"1.4fr 1fr", gap:16, marginTop:16}}>
        <Card
          title="Recent activity"
          sub="Last 7 days · all districts"
        >
          <div style={{display:"flex", flexDirection:"column", gap:10}}>
            {[
              {who:"Clares CC",       what:"submitted CQI form", when:"2h ago", tone:"teal"},
              {who:"Harlequins CC",   what:"uploaded AGM Minutes", when:"5h ago", tone:"teal"},
              {who:"UKZN CC",         what:"completed affiliation payment · R 4,500", when:"1d ago", tone:"navy"},
              {who:"Phoenix CC",      what:"viewed affiliation form but has not submitted", when:"2d ago", tone:"gold"},
              {who:"Berea Rovers CC", what:"affiliation form started, payment pending", when:"3d ago", tone:"gold"},
              {who:"Tongaat CC",      what:"has not started — 2 reminders sent", when:"6d ago", tone:"coral"},
            ].map((a,i)=>(
              <div key={i} className="row" style={{padding:"8px 10px", borderRadius:6, background: i%2 ? "var(--paper)":"transparent"}}>
                <span className={`sdot ${a.tone}`}/>
                <span style={{fontWeight:500, color:"var(--ink)", fontSize:13}}>{a.who}</span>
                <span style={{flex:1, fontSize:13, color:"var(--muted)"}}>{a.what}</span>
                <span style={{fontFamily:"'Montserrat',sans-serif", fontSize:10.5, color:"var(--muted-2)"}}>{a.when}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Leaderboard" sub="Highest overall integration progress"
              action={<button className="btn btn-ghost btn-sm" onClick={gotoList}>View all <Icon.Arrow/></button>}>
          <div style={{display:"flex", flexDirection:"column", gap:8}}>
            {leaders.map((c,i)=>(
              <button key={c.id} className="row" style={{padding:"6px 4px", width:"100%", textAlign:"left"}} onClick={()=>gotoClub(c.id)}>
                <span style={{
                  fontFamily:"'Montserrat',sans-serif", fontSize:11, fontWeight:800,
                  color: i===0?"#076B36": i<3 ? "var(--ink)":"var(--muted-2)",
                  width:20, textAlign:"center",
                }}>0{i+1}</span>
                <ClubAvatar club={c} size={26}/>
                <span style={{flex:1, fontSize:13, fontWeight:500}}>{c.name}</span>
                <ProgChip value={c.prog} tone={c.prog >= 80 ? "teal" : c.prog >= 60 ? "gold" : "coral"}/>
              </button>
            ))}
          </div>
          <div className="hr"/>
          <div style={{fontFamily:"'Montserrat',sans-serif", fontSize:10, fontWeight:700, color:"var(--coral)", letterSpacing:"0.14em", textTransform:"uppercase", marginBottom:10}}>At risk · needs intervention</div>
          <div style={{display:"flex", flexDirection:"column", gap:8}}>
            {atRisk.map(c=>(
              <button key={c.id} className="row" style={{padding:"6px 4px", width:"100%", textAlign:"left"}} onClick={()=>gotoClub(c.id)}>
                <ClubAvatar club={c} size={26}/>
                <span style={{flex:1, fontSize:13, fontWeight:500}}>{c.name}</span>
                <ProgChip value={c.prog} tone="coral"/>
              </button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ─── Cohort insights — visualises CQI bands, doc compliance, outstanding resources ─── */
function ClubInsights({ clubs }) {
  // CQI bands
  const bandTone = (key) => key === "C" ? "warn" : key === "D" ? "danger" : key === "P" ? "pending" : "";
  const bands = [
    { key:"A", label:"A · 80+",     count: clubs.filter(c => c.cqi >= 80).length },
    { key:"B", label:"B · 65–80",   count: clubs.filter(c => c.cqi >= 65 && c.cqi < 80).length },
    { key:"C", label:"C · 50–65",   count: clubs.filter(c => c.cqi >= 50 && c.cqi < 65).length },
    { key:"D", label:"D · <50",     count: clubs.filter(c => c.cqi >  0 && c.cqi < 50).length },
    { key:"P", label:"Pending",     count: clubs.filter(c => c.cqi === 0).length },
  ];
  const maxBand = Math.max(...bands.map(b => b.count), 1);
  const submitted = clubs.filter(c => c.cqi > 0);
  const avgCqi = submitted.length ? submitted.reduce((s,c)=>s+c.cqi, 0) / submitted.length : 0;

  // Doc compliance per required doc
  const docStats = REQUIRED_DOCS.map(d => {
    const uploaded = clubs.filter(c => c.docs[d.key]).length;
    const pct = clubs.length ? Math.round(uploaded / clubs.length * 100) : 0;
    return { key: d.key, name: d.name, count: uploaded, total: clubs.length, pct };
  });
  const mostMissing = [...docStats].sort((a,b) => a.count - b.count)[0];
  const docTone = (pct) => pct >= 70 ? "" : pct >= 40 ? "warn" : "danger";

  // Resources required
  const unpaid = clubs.filter(c => !c.paid).length;
  const incompleteDocs = clubs.filter(c => !Object.values(c.docs).every(v=>v)).length;
  const noCqi = clubs.filter(c => c.cqi === 0).length;
  const totalReminders = unpaid + noCqi;

  return (
    <div className="insights-panel">
      {/* ─── CQI Score Distribution ─── */}
      <div className="insights-card">
        <div className="insights-card-head">
          <div className="insights-card-title">CQI Score Distribution</div>
          <div className="insights-card-meta">Avg <CountUp to={avgCqi} decimals={1}/></div>
        </div>
        {bands.map(b => (
          <div key={b.key} className="insights-bar-row">
            <div className="insights-bar-label">{b.label}</div>
            <div className="insights-bar-track">
              <div className={`insights-bar-fill ${bandTone(b.key)}`} style={{width: (b.count/maxBand*100)+"%"}}/>
            </div>
            <div className="insights-bar-num">{b.count}</div>
          </div>
        ))}
        <div className="insights-callout good">
          <strong>{submitted.length}</strong> of {clubs.length} clubs submitted CQI · spread across {bands.filter(b=>b.count>0 && b.key!=="P").length} performance band{bands.filter(b=>b.count>0 && b.key!=="P").length===1?"":"s"}
        </div>
      </div>

      {/* ─── Document Compliance ─── */}
      <div className="insights-card">
        <div className="insights-card-head">
          <div className="insights-card-title">Document Compliance</div>
          <div className="insights-card-meta">of {clubs.length} clubs</div>
        </div>
        {docStats.map(d => (
          <div key={d.key} className="insights-bar-row wide-label">
            <div className="insights-bar-label" title={d.name}>{d.name}</div>
            <div className="insights-bar-track">
              <div className={`insights-bar-fill ${docTone(d.pct)}`} style={{width: d.pct+"%"}}/>
            </div>
            <div className="insights-bar-num">{d.count}/{d.total}</div>
          </div>
        ))}
        <div className={`insights-callout ${mostMissing.pct < 40 ? "alert" : "warn"}`}>
          Most missing: <strong>{mostMissing.name}</strong> — only <strong>{mostMissing.count}</strong> of {mostMissing.total} clubs uploaded
        </div>
      </div>

      {/* ─── Resources Required ─── */}
      <div className="insights-card">
        <div className="insights-card-head">
          <div className="insights-card-title">Resources Required</div>
          <div className="insights-card-meta">22 Jun deadline</div>
        </div>
        <div className="resource-list">
          <div className="resource-row">
            <span className={`resource-num ${unpaid > clubs.length*0.3 ? "danger" : unpaid > 0 ? "warn" : "good"}`}>
              <CountUp to={unpaid}/>
            </span>
            <span className="resource-text"><strong>{unpaid === 1 ? "club" : "clubs"}</strong> haven't paid affiliation · R 4,500 each</span>
          </div>
          <div className="resource-row">
            <span className={`resource-num ${incompleteDocs > clubs.length*0.3 ? "danger" : incompleteDocs > 0 ? "warn" : "good"}`}>
              <CountUp to={incompleteDocs}/>
            </span>
            <span className="resource-text"><strong>{incompleteDocs === 1 ? "club" : "clubs"}</strong> missing one or more compliance docs</span>
          </div>
          <div className="resource-row">
            <span className={`resource-num ${noCqi > clubs.length*0.3 ? "danger" : noCqi > 0 ? "warn" : "good"}`}>
              <CountUp to={noCqi}/>
            </span>
            <span className="resource-text"><strong>{noCqi === 1 ? "club" : "clubs"}</strong> haven't submitted their CQI form</span>
          </div>
        </div>
        <div className="insights-callout alert">
          Send <strong>{totalReminders}</strong> reminder{totalReminders===1?"":"s"} before <strong>22 June</strong> — target the at-risk clubs first.
        </div>
      </div>
    </div>
  );
}

function AdminClubsList({ clubs, gotoClub }) {
  const [q, setQ] = useStateA("");
  const [filter, setFilter] = useStateA("all");

  const filtered = useMemoA(()=>{
    let cs = clubs;
    if (q) cs = cs.filter(c => c.name.toLowerCase().includes(q.toLowerCase()) || c.chair.toLowerCase().includes(q.toLowerCase()));
    if (filter === "complete")   cs = cs.filter(c => c.affiliation === "complete" && Object.values(c.docs).every(v=>v) && c.cqi > 0);
    if (filter === "incomplete") cs = cs.filter(c => !(c.affiliation === "complete" && Object.values(c.docs).every(v=>v) && c.cqi > 0));
    if (filter === "not_paid")   cs = cs.filter(c => !c.paid);
    if (filter === "no_cqi")     cs = cs.filter(c => c.cqi === 0);
    return cs;
  }, [clubs, q, filter]);

  const counts = useMemoA(()=>({
    all: clubs.length,
    complete: clubs.filter(c => c.affiliation === "complete" && Object.values(c.docs).every(v=>v) && c.cqi > 0).length,
    incomplete: clubs.filter(c => !(c.affiliation === "complete" && Object.values(c.docs).every(v=>v) && c.cqi > 0)).length,
    not_paid: clubs.filter(c => !c.paid).length,
    no_cqi: clubs.filter(c => c.cqi === 0).length,
  }), [clubs]);

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Dolphins · Admin Console / Clubs</div>
          <h1 className="ph-title">Club <em>directory</em></h1>
          <p className="ph-desc">Filter, sort and drill into each affiliated club's submission status across all five phases of the smart integration programme.</p>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" icon={Icon.Download} size="sm">Export CSV</Btn>
          <Btn tone="ink" icon={Icon.Plus} size="sm">Onboard new club</Btn>
        </div>
      </div>

      {/* Cohort insights panel — CQI distribution, document compliance, resources required */}
      <ClubInsights clubs={clubs}/>

      <div className="filter-row">
        <input className="search-box" placeholder="Search by club name or chairperson…" value={q} onChange={e=>setQ(e.target.value)}/>
        {[
          {k:"all", label:"All clubs"},
          {k:"complete", label:"Fully integrated"},
          {k:"incomplete", label:"Incomplete"},
          {k:"not_paid", label:"Affiliation unpaid"},
          {k:"no_cqi", label:"CQI not submitted"},
        ].map(f => (
          <button key={f.k} className={`filter-pill ${filter===f.k?"active":""}`} onClick={()=>setFilter(f.k)}>
            {f.label}<span className="count">{counts[f.k]}</span>
          </button>
        ))}
      </div>

      <div className="tbl-w">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{width:"24%"}}>Club</th>
              <th>Chairperson</th>
              <th>Affiliation</th>
              <th>Docs</th>
              <th>CQI</th>
              <th>Overall</th>
              <th style={{width:60}}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(c=>{
              const dc = docCompletion(c);
              const op = overallProgress(c);
              const band = cqiBand(c.cqi);
              return (
                <tr key={c.id} className="clickable" onClick={()=>gotoClub(c.id)}>
                  <td><ClubNameCell club={c}/></td>
                  <td><div style={{fontSize:12.5}}>{c.chair}</div><div style={{fontSize:10.5,color:"var(--muted-2)",fontFamily:"'Montserrat',sans-serif"}}>{c.sub}</div></td>
                  <td>{affPill(c.affiliation)} {c.paid && <span style={{fontFamily:"'Montserrat',sans-serif", fontSize:10, color:"var(--teal-deep)", marginLeft:6}}>· PAID</span>}</td>
                  <td><ProgChip value={dc} tone={dc===100?"teal":dc>=50?"gold":"coral"}/></td>
                  <td><Pill tone={band.tone}>{band.label}</Pill></td>
                  <td><ProgChip value={op} tone={op>=80?"teal":op>=50?"gold":"coral"}/></td>
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

function AdminClubDetail({ club, gotoList }) {
  if (!club) return null;
  const dc = docCompletion(club);
  const op = overallProgress(club);
  const band = cqiBand(club.cqi);

  const phases = [
    { n:"01", t:"Affiliation",        done: club.paid, val: club.paid ? 100 : (club.affiliation==="in_progress"?40:0), detail: club.paid ? "Paid R 4,500 · 12 May 2026" : "Awaiting payment" },
    { n:"02", t:"League & Fixtures",  done: club.affiliation==="complete", val: club.affiliation==="complete"?100:0, detail: club.affiliation==="complete"?`Allocated to ${club.sub==="EMCU"?"EMCU Premier":"Provincial Promotion"}`: "Pending affiliation" },
    { n:"03", t:"Player Registration", done: club.players >= 30, val: Math.min(100, (club.players||0)/60*100), detail: `${club.players||0} players registered` },
    { n:"04", t:"Live Scoring",        done: false, val: club.cqi>0 ? 25 : 0, detail: "Begins round 1 · 02 Aug 2026" },
    { n:"05", t:"Compliance",          done: dc===100, val: dc, detail: `${Object.values(club.docs).filter(v=>v).length} of 4 docs uploaded` },
  ];

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb"><a onClick={gotoList}>Clubs</a> &nbsp;/&nbsp; {club.name}</div>
          <div style={{display:"flex",alignItems:"center",gap:14, marginTop:4}}>
            <ClubAvatar club={club} size={44}/>
            <div>
              <h1 className="ph-title" style={{margin:0}}>{club.name}</h1>
              <div style={{fontSize:12, color:"var(--muted)", fontFamily:"'Montserrat',sans-serif", marginTop:4}}>{club.district} · {club.sub} · {club.chair}</div>
            </div>
          </div>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" icon={Icon.Mail} size="sm">Email chairperson</Btn>
          <Btn tone="ink" icon={Icon.Eye} size="sm">View as club</Btn>
        </div>
      </div>

      <div className="kpi-strip">
        <KPI tone="navy" label="Overall progress"  num={op+"%"}  sub="all phases" />
        <KPI tone="teal" label="Affiliation"       num={club.paid?"Paid":"Pending"} sub={club.paid?"R 4,500":"R 0 · awaiting"} />
        <KPI tone="gold" label="Documents"         num={`${Object.values(club.docs).filter(v=>v).length}/4`} sub="compliance docs" />
        <KPI tone={band.tone==="coral"?"coral":""} label="CQI score" num={club.cqi.toFixed(1)} sub={band.label} />
        <KPI label="Players"                       num={club.players}  sub={`${club.teams} teams · ${club.juniors} junior`} />
      </div>

      <div style={{display:"grid", gridTemplateColumns:"1.4fr 1fr", gap:16}}>
        <div className="stack">
          <Card title="Phase status" sub="Smart Club Integration · 5-phase journey">
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {phases.map(p=>(
                <div key={p.n} style={{
                  display:"grid", gridTemplateColumns:"48px 1fr 180px 90px", gap:14,
                  alignItems:"center", padding:"10px 12px", border:"1px solid var(--line)",
                  borderRadius:8, background:p.done?"rgba(15,143,74,0.03)":"var(--white)",
                }}>
                  <div style={{
                    width:36,height:36,borderRadius:"50%",
                    background: p.done?"var(--teal)":"var(--paper2)", color: p.done?"#fff":"var(--muted)",
                    display:"flex",alignItems:"center",justifyContent:"center",
                    fontFamily:"'Montserrat',sans-serif", fontSize:12, fontWeight:800
                  }}>{p.done ? <Icon.Check/> : p.n}</div>
                  <div>
                    <div style={{fontFamily:"'Montserrat',sans-serif", fontSize:13, fontWeight:700}}>{p.t}</div>
                    <div style={{fontSize:11, color:"var(--muted)", fontFamily:"'Montserrat',sans-serif", marginTop:2}}>{p.detail}</div>
                  </div>
                  <ProgressBar value={p.val} tone={p.done?"teal":"gold"}/>
                  <div style={{textAlign:"right", fontFamily:"'Montserrat',sans-serif", fontSize:12, color:"var(--ink)", fontWeight:500}}>{Math.round(p.val)}%</div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Compliance documents"
                sub="KZNCU 2026/27 club requirements upload"
                action={<Btn tone="outline" size="sm" icon={Icon.Download}>Download bundle</Btn>}>
            {REQUIRED_DOCS.map(d => {
              const up = club.docs[d.key];
              return (
                <div key={d.key} className={`doc-row ${up?"uploaded":""}`}>
                  <div className="doc-icon"><Icon.Doc/></div>
                  <div className="doc-info">
                    <div className="doc-name">{d.name}{!up && <span className="doc-required-tag">Required</span>}</div>
                    <div className="doc-meta">{up ? `${d.key}_2026.pdf · uploaded 14 May 2026 · 1.2 MB` : "Not yet uploaded · awaiting club"}</div>
                  </div>
                  {up ? <Pill tone="teal" dot>Approved</Pill> : <Pill tone="coral" dot>Missing</Pill>}
                </div>
              );
            })}
          </Card>

          <Card title="CQI breakdown" sub="Per-category contribution to overall score">
            {club.cqi === 0 ? (
              <div style={{textAlign:"center", padding:"28px 0", color:"var(--muted)", fontSize:13}}>
                CQI form not yet submitted by this club.
              </div>
            ) : (
              <div className="score-grid" style={{marginBottom:0}}>
                {CQI_STRUCTURE.map(cat => {
                  // Approximate per-cat score from the overall score
                  const ratio = Math.min(1, club.cqi/100);
                  const wiggle = ({admin:1.05, teams:0.95, coaching:1.0, facilities:0.85, representation:1.0})[cat.key] || 1;
                  const score = Math.min(cat.weight, cat.weight * ratio * wiggle);
                  return (
                    <div key={cat.key} className="score-card" style={{"--fill": (score/cat.weight*100)+"%", "--accent": cat.accent}}>
                      <div>
                        <span className="sc-cat">{cat.title}</span>
                        <span className="sc-w">/{cat.weight}</span>
                      </div>
                      <div className="sc-num">{score.toFixed(1)}<span className="sc-of">/{cat.weight}</span></div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="Club details">
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr", gap:"12px 18px"}}>
              {[
                ["District", club.district],
                ["Sub-union", club.sub],
                ["Chairperson", club.chair],
                ["Status", club.paid?"Active member":"Pending"],
                ["Senior teams", club.teams],
                ["Women's teams", club.women],
                ["Junior teams", club.juniors],
                ["Players", club.players],
              ].map(([k,v],i)=>(
                <div key={i}>
                  <div style={{fontSize:10, textTransform:"uppercase", letterSpacing:"0.1em", color:"var(--muted-2)", marginBottom:3}}>{k}</div>
                  <div style={{fontSize:13, color:"var(--ink)", fontWeight:500}}>{v}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Communication log">
            <div className="stack" style={{gap:8}}>
              {[
                {tone:"teal", t:"Affiliation invitation sent", d:"03 May 2026 · auto-system"},
                {tone:"navy", t:"Login link emailed to chair", d:"05 May 2026"},
                {tone:"gold", t:"Reminder — CQI form pending",  d:"15 May 2026"},
                {tone:"teal", t:"AGM document uploaded",        d:"18 May 2026 · by chair", off: !club.docs.agm},
              ].filter(x=>!x.off).map((m,i)=>(
                <div key={i} style={{display:"flex",alignItems:"start",gap:10, padding:"8px 0", borderBottom:"1px solid var(--line2)"}}>
                  <span className={`sdot ${m.tone}`} style={{marginTop:6}}/>
                  <div style={{flex:1}}>
                    <div style={{fontSize:12.5, color:"var(--ink)"}}>{m.t}</div>
                    <div style={{fontSize:10.5, color:"var(--muted-2)", fontFamily:"'Montserrat',sans-serif", marginTop:2}}>{m.d}</div>
                  </div>
                </div>
              ))}
            </div>
            <Btn tone="outline" size="sm" icon={Icon.Plus} style={{width:"100%", marginTop:10, justifyContent:"center"}}>New note / reminder</Btn>
          </Card>

          <Card title="Quick actions">
            <div className="stack" style={{gap:6}}>
              <Btn tone="ink" icon={Icon.Mail}>Send reminder</Btn>
              <Btn tone="outline" icon={Icon.Eye}>View submitted CQI form</Btn>
              <Btn tone="outline" icon={Icon.Download}>Download affiliation form</Btn>
              <Btn tone="outline" icon={Icon.Shield}>Mark as compliant</Btn>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { AdminDashboard, AdminClubsList, AdminClubDetail, AdminFixtures, CreateSeriesForm });

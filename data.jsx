/* ─── Sample data ─── */

// Sub-unions / districts derived from the affiliation form's drop-down
const DISTRICTS = [
  "Ethekwini Metro Cricket Union",
  "Umkhanyakude Cricket District",
  "Ugu Cricket District",
  "KCCD",
  "Illembe Cricket District",
];

const LEAGUES = [
  "Premier League",
  "Promotion League",
  "Premier Women",
  "Promotion Women",
  "Veterans League",
  "EMCU Division 1",
  "EMCU Division 2",
  "EMCU Division 3",
];

const COACHING_LEVELS = ["Level 1", "Level 2", "Level 3", "Level 4"];

// Required compliance documents (from KZNCU Club Requirements 26-27)
const REQUIRED_DOCS = [
  { key: "constitution", name: "Club Constitution", desc: "Current signed club constitution document" },
  { key: "agm",          name: "AGM Minutes",       desc: "Minutes of the most recent AGM, signed off" },
  { key: "financials",   name: "Financial Statements", desc: "Annual financial statements for the prior season" },
  { key: "exco",         name: "Exco Reps Listed",  desc: "Full list of executive committee representatives with contact details" },
];

// Sample clubs — names drawn from the actual Dolphins CQI list
// Each carries denormalised submission state so the admin views can score them.
const SAMPLE_CLUBS = [
  {
    id: "ukzn",       name: "UKZN CC",             district: "Ethekwini Metro CU",
    sub: "EMCU",      chair: "Ashraf Ganie",       affiliation: "complete", paid: true,
    cqi: 91.89,       docs: { constitution:true,  agm:true,  financials:true,  exco:true },
    players: 57,      teams: 3, women: 0, juniors: 0, color:"#1B2A4A",
    ground: { venue:"Howard College Oval", suburb:"Glenwood", lat:-29.8666, lon:30.9783 },
  },
  {
    id: "clares",     name: "Clares CC",           district: "Ethekwini Metro CU",
    sub: "EMCU",      chair: "Rajin Ramsaroop",    affiliation: "complete", paid: true,
    cqi: 87.4,        docs: { constitution:true,  agm:true,  financials:true,  exco:false },
    players: 72,      teams: 6, women: 1, juniors: 3, color:"#1D9E75",
    ground: { venue:"Clares Cricket Field", suburb:"Glenwood", lat:-29.8533, lon:30.9512 },
  },
  {
    id: "chatsworth", name: "Chatsworth Sporting CC", district: "Ethekwini Metro CU",
    sub: "EMCU",      chair: "Jason Sathiaseelan", affiliation: "complete", paid: true,
    cqi: 81.2,        docs: { constitution:true,  agm:true,  financials:false, exco:true },
    players: 114,     teams: 10, women: 1, juniors: 3, color:"#C8A84B",
    ground: { venue:"Chatsworth Sports Ground", suburb:"Chatsworth", lat:-29.9112, lon:30.8868 },
  },
  {
    id: "umlazi",     name: "Umlazi CC",           district: "Ethekwini Metro CU",
    sub: "EMCU",      chair: "Simphiwe Shangase",  affiliation: "complete", paid: true,
    cqi: 64.8,        docs: { constitution:true,  agm:false, financials:false, exco:true },
    players: 58,      teams: 6, women: 1, juniors: 3, color:"#D85A30",
    ground: { venue:"Umlazi Comtech Ground", suburb:"Umlazi", lat:-29.9678, lon:30.8842 },
  },
  {
    id: "crusaders",  name: "Crusaders CC",        district: "Ethekwini Metro CU",
    sub: "EMCU",      chair: "Duncun Miller",      affiliation: "complete", paid: true,
    cqi: 78.5,        docs: { constitution:true,  agm:true,  financials:true,  exco:true },
    players: 88,      teams: 9, women: 1, juniors: 3, color:"#2E4070",
    ground: { venue:"Crusaders Park", suburb:"Durban North", lat:-29.7956, lon:31.0356 },
  },
  {
    id: "berea",      name: "Berea Rovers CC",     district: "Ethekwini Metro CU",
    sub: "EMCU",      chair: "Wayne Scott",        affiliation: "in_progress", paid: false,
    cqi: 0,           docs: { constitution:false, agm:false, financials:false, exco:false },
    players: 0,       teams: 3, women: 0, juniors: 1, color:"#243356",
    ground: { venue:"Berea Rovers Oval", suburb:"Berea", lat:-29.8348, lon:31.0050 },
  },
  {
    id: "rhythm",     name: "Rhythm DHSOB CC",     district: "Ethekwini Metro CU",
    sub: "EMCU",      chair: "Mags Reddy",         affiliation: "complete", paid: true,
    cqi: 68.4,        docs: { constitution:true,  agm:false, financials:true,  exco:true },
    players: 92,      teams: 9, women: 1, juniors: 1, color:"#1D9E75",
    ground: { venue:"DHS Old Boys Field", suburb:"Stamford Hill", lat:-29.8205, lon:31.0009 },
  },
  {
    id: "warriors",   name: "African Warriors CC", district: "Ethekwini Metro CU",
    sub: "EMCU",      chair: "Knowledge Vilakazi", affiliation: "complete", paid: true,
    cqi: 72.1,        docs: { constitution:true,  agm:true,  financials:false, exco:true },
    players: 64,      teams: 5, women: 2, juniors: 3, color:"#1B2A4A",
    ground: { venue:"KwaMashu K-Section Ground", suburb:"KwaMashu", lat:-29.7311, lon:30.9876 },
  },
  {
    id: "phoenix",    name: "Phoenix CC",          district: "Ethekwini Metro CU",
    sub: "EMCU",      chair: "Bradley Chetty",     affiliation: "not_started", paid: false,
    cqi: 0,           docs: { constitution:false, agm:false, financials:false, exco:false },
    players: 0,       teams: 6, women: 0, juniors: 2, color:"#C8A84B",
    ground: { venue:"Phoenix Sports Complex", suburb:"Phoenix", lat:-29.7003, lon:31.0214 },
  },
  {
    id: "verulam",    name: "Verulam CC",          district: "Ethekwini Metro CU",
    sub: "Verulam",   chair: "Kugan Subrayen",     affiliation: "in_progress", paid: false,
    cqi: 38.5,        docs: { constitution:true,  agm:false, financials:false, exco:false },
    players: 21,      teams: 1, women: 0, juniors: 2, color:"#D85A30",
    ground: { venue:"Verulam Sports Field", suburb:"Verulam", lat:-29.6411, lon:31.0498 },
  },
  {
    id: "harlequins", name: "Harlequins CC",       district: "Ethekwini Metro CU",
    sub: "EMCU",      chair: "Eric Cavanagh",      affiliation: "complete", paid: true,
    cqi: 84.2,        docs: { constitution:true,  agm:true,  financials:true,  exco:true },
    players: 96,      teams: 10, women: 0, juniors: 2, color:"#1D9E75",
    ground: { venue:"Kingsmead North", suburb:"Stamford Hill", lat:-29.8195, lon:31.0308 },
  },
  {
    id: "spartan",    name: "Spartan Sporting CC", district: "Ethekwini Metro CU",
    sub: "EMCU",      chair: "Shafee Ayob",        affiliation: "complete", paid: true,
    cqi: 56.3,        docs: { constitution:true,  agm:true,  financials:false, exco:false },
    players: 38,      teams: 5, women: 0, juniors: 2, color:"#2E4070",
    ground: { venue:"Spartan Park", suburb:"Mount Edgecombe", lat:-29.7256, lon:31.0489 },
  },
  {
    id: "ilembe",     name: "Ilembe CC",           district: "Illembe Cricket District",
    sub: "Ilembe",    chair: "Naren Singh",        affiliation: "complete", paid: true,
    cqi: 47.6,        docs: { constitution:true,  agm:false, financials:true,  exco:false },
    players: 28,      teams: 2, women: 0, juniors: 0, color:"#8A6E1C",
    ground: { venue:"KwaDukuza Stadium", suburb:"KwaDukuza", lat:-29.3398, lon:31.2810 },
  },
  {
    id: "tongaat",    name: "Tongaat CC",          district: "Ethekwini Metro CU",
    sub: "Tongaat",   chair: "Praven Govender",    affiliation: "not_started", paid: false,
    cqi: 0,           docs: { constitution:false, agm:false, financials:false, exco:false },
    players: 0,       teams: 1, women: 0, juniors: 1, color:"#D85A30",
    ground: { venue:"Tongaat Sports Field", suburb:"Tongaat", lat:-29.5783, lon:31.1149 },
  },
];

// CQI structure — categories, weights, and questions
// Weighting model: Admin 20 / Teams 20 / Coaching 20 / Facilities 15 / Representation 10 / Financial 15 = 100
const CQI_STRUCTURE = [
  {
    key: "admin", title: "Administration", weight: 20, accent: "var(--navy)",
    desc: "Governance, documentation and structural compliance.",
    questions: [
      { key: "constitution", label: "Club has a current Constitution", kind: "yn", pts: 4 },
      { key: "conduct",      label: "Code of Conduct is in place",      kind: "yn", pts: 3 },
      { key: "inventory",    label: "General Admin Inventory maintained", kind: "yn", pts: 3 },
      { key: "agm",          label: "AGM conducted at least once a year", kind: "yn", pts: 4 },
      { key: "officers",     label: "Chairperson, Secretary & Treasurer in place", kind: "yn", pts: 4 },
      { key: "minutes",      label: "Minutes of AGM available",          kind: "yn", pts: 4 },
      { key: "playerdb",     label: "Player database available",         kind: "yn", pts: 3 },
    ],
  },
  {
    key: "teams", title: "Teams", weight: 20, accent: "var(--teal)",
    desc: "Squad depth across senior, women and junior structures.",
    questions: [
      { key: "premprom",     label: "1st Team plays in Premier or Promotion league", kind: "yn", pts: 5 },
      { key: "senior",       label: "Number of Senior Teams",          kind: "num", max: 12, pts: 8 },
      { key: "women",        label: "Number of Women's Teams",         kind: "num", max: 6,  pts: 6 },
      { key: "juniorB",      label: "Number of Junior Boys Teams",     kind: "num", max: 8,  pts: 3 },
      { key: "juniorG",      label: "Number of Junior Girls Teams",    kind: "num", max: 6,  pts: 3 },
    ],
  },
  {
    key: "coaching", title: "Coaching", weight: 20, accent: "var(--gold)",
    desc: "Coach-to-team ratio and accreditation levels.",
    questions: [
      { key: "coaches",      label: "Total Coaches at the club",       kind: "num", max: 20, pts: 8 },
      { key: "certified",    label: "Number of Certified Coaches",     kind: "num", max: 20, pts: 8 },
      { key: "level2",       label: "1st Team coach is Level 2 or above", kind: "yn", pts: 9 },
    ],
  },
  {
    key: "facilities", title: "Facilities", weight: 15, accent: "var(--coral)",
    desc: "Playing fields, nets and venue ownership.",
    questions: [
      { key: "covers",       label: "Square covers available",         kind: "yn", pts: 2 },
      { key: "boundary",     label: "Adequate boundary rope available", kind: "yn", pts: 2 },
      { key: "scoreboard",   label: "Scoreboard available",            kind: "yn", pts: 2 },
      { key: "ownFacility",  label: "Responsible for own facility",    kind: "yn", pts: 2 },
      { key: "fieldsGrass",  label: "Number of Grass fields",          kind: "num", max: 10, pts: 3 },
      { key: "fieldsArt",    label: "Number of Artificial fields",     kind: "num", max: 10, pts: 1 },
      { key: "netsGrass",    label: "Number of Grass nets",            kind: "num", max: 12, pts: 2 },
      { key: "netsArt",      label: "Number of Artificial nets",       kind: "num", max: 12, pts: 1 },
    ],
  },
  {
    key: "representation", title: "Representation", weight: 10, accent: "var(--navy-light)",
    desc: "Player demographics across the club (must sum to 100%).",
    questions: [
      { key: "pctBA",        label: "% Black African",                 kind: "pct", pts: 4 },
      { key: "pctIN",        label: "% Indian",                        kind: "pct", pts: 2 },
      { key: "pctCO",        label: "% Coloured",                      kind: "pct", pts: 2 },
      { key: "pctWH",        label: "% White",                         kind: "pct", pts: 2 },
    ],
  },
  {
    key: "financial", title: "Financial Sustainability", weight: 15, accent: "var(--green)",
    desc: "Member subscriptions and monetary sponsorships keeping the club running.",
    questions: [
      { key: "subCycle",  label: "Subscription cycle",                kind: "choice", options: ["Annual","Seasonal"], pts: 2 },
      { key: "subAmount", label: "Subscription cost per member",      kind: "money",  currency: "R", pts: 4 },
      { key: "sponsors",  label: "Number of monetary sponsors",       kind: "num",    max: 10, pts: 9 },
    ],
  },
];

// Aggregate stats helpers
function cohortStats(clubs) {
  const total = clubs.length;
  const affComplete = clubs.filter(c => c.affiliation === "complete").length;
  const paid = clubs.filter(c => c.paid).length;
  const cqiSubmitted = clubs.filter(c => c.cqi > 0).length;
  const avgCqi = clubs.filter(c => c.cqi > 0).reduce((s,c)=>s+c.cqi,0) / Math.max(1, cqiSubmitted);
  const docsComplete = clubs.filter(c => Object.values(c.docs).every(v=>v)).length;
  return { total, affComplete, paid, cqiSubmitted, avgCqi, docsComplete };
}

function docCompletion(club) {
  const vals = Object.values(club.docs);
  return Math.round(vals.filter(v=>v).length / vals.length * 100);
}

function overallProgress(club) {
  // 5 weighted phases: 20% each
  const p1 = club.paid ? 100 : (club.affiliation === "in_progress" ? 40 : 0);
  const p2 = club.affiliation === "complete" ? 100 : 0; // assume league assigned once affiliated
  const p3 = Math.min(100, (club.players || 0) / 60 * 100);
  const p4 = club.cqi > 60 ? 100 : club.cqi > 0 ? 50 : 0;
  const p5 = docCompletion(club);
  return Math.round((p1 + p2 + p3 + p4 + p5) / 5);
}

/* ─── FIXTURE GENERATION + TRAVEL COSTS ───
   Haversine great-circle distance between two lat/lon coords (km).
   Round-robin schedule generator.
   Travel cost = round-trip distance × cars × cost per km. */
function haversineKm(a, b) {
  if (!a || !b) return 0;
  const R = 6371;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
}

function fixtureCost(homeClub, awayClub, costPerKm=4.5, cars=3) {
  const km = haversineKm(homeClub.ground, awayClub.ground);
  const roundTripKm = km * 2;
  const fuelR = roundTripKm * cars * costPerKm;
  return { distanceKm: km, roundTripKm, cars, costPerKm, fuelR };
}

// Round-robin: each team plays every other team once. Home/away alternates fairly.
function generateRoundRobin(teamIds, startDateISO) {
  if (teamIds.length < 2) return [];
  const teams = [...teamIds];
  if (teams.length % 2 === 1) teams.push(null); // bye
  const n = teams.length;
  const rounds = n - 1;
  const start = new Date(startDateISO);
  const fixtures = [];
  let fixtureId = 1;
  for (let r = 0; r < rounds; r++) {
    const matchDate = new Date(start.getTime() + r * 7 * 86400000); // weekly rounds
    for (let i = 0; i < n/2; i++) {
      const home = teams[i], away = teams[n - 1 - i];
      if (!home || !away) continue;
      // Alternate home/away by round so it's fair
      const swap = r % 2 === 1;
      fixtures.push({
        id: "f" + (fixtureId++),
        round: r + 1,
        date: matchDate.toISOString().slice(0,10),
        home: swap ? away : home,
        away: swap ? home : away,
      });
    }
    // Rotate teams (keep teams[0] fixed)
    const fixed = teams[0];
    const rest = teams.slice(1);
    rest.unshift(rest.pop());
    teams.splice(0, teams.length, fixed, ...rest);
  }
  return fixtures;
}

// One pre-made series so the admin lands on populated content
const _premierTeams = ["ukzn", "clares", "chatsworth", "crusaders", "rhythm", "harlequins", "warriors", "umlazi"];
const SERIES = [
  {
    id: "s-prem-26-27",
    name: "Premier League · 2026/27",
    startDate: "2026-08-01",
    divisions: false,
    groups: 1,
    maxOvers: 50,
    maxPlayers: 11,
    rosterLimit: 18,
    ballType: "Cricket Ball",
    seriesType: "One-Day (40-50 overs)",
    powerPlay: true,
    category: "Men",
    level: "Club",
    winPoints: 4,
    bonusPoints: 1,
    lossPoints: 0,
    tiePoints: 2,
    abandonedPoints: 1,
    ballsPerOver: 6,
    maxBallsPerOver: 8,
    minLeagueMatches: 2,
    configureExtras: false,
    lockAfterLive: true,
    lockAfterManual: true,
    preventTeamSwitch: true,
    umpireReportsMandatory: true,
    captainReportsMandatory: true,
    sendReportEmails: true,
    rankCalculator: "New",
    hideSeriesDetails: false,
    allowLockedRegistration: false,
    pointsTableOrder: ["Most Points", "NRR", "Head To Head", "Number of Wins", "Win Percentage"],
    tags: ["Premier", "Men", "Round-robin"],
    teams: _premierTeams,
    costPerKm: 4.5,
    carsPerAwayTrip: 3,
    released: false,
    releasedAt: null,
    fixtures: generateRoundRobin(_premierTeams, "2026-08-02"),
  },
  {
    id: "s-prom-26-27",
    name: "Promotion League · 2026/27",
    startDate: "2026-08-08",
    divisions: false, groups: 1, maxOvers: 50, maxPlayers: 11, rosterLimit: 18,
    ballType: "Cricket Ball", seriesType: "One-Day (40-50 overs)", powerPlay: true,
    category: "Men", level: "Club",
    winPoints: 4, bonusPoints: 1, lossPoints: 0, tiePoints: 2, abandonedPoints: 1,
    ballsPerOver: 6, maxBallsPerOver: 8, minLeagueMatches: 2,
    configureExtras: false, lockAfterLive: true, lockAfterManual: true, preventTeamSwitch: true,
    umpireReportsMandatory: false, captainReportsMandatory: true, sendReportEmails: true,
    rankCalculator: "New", hideSeriesDetails: false, allowLockedRegistration: false,
    pointsTableOrder: ["Most Points", "NRR", "Head To Head", "Number of Wins", "Win Percentage"],
    tags: ["Promotion", "Men"],
    teams: ["spartan", "ilembe", "verulam", "tongaat"],
    costPerKm: 4.5, carsPerAwayTrip: 3,
    released: false,
    releasedAt: null,
    fixtures: generateRoundRobin(["spartan", "ilembe", "verulam", "tongaat"], "2026-08-08"),
  },
];

Object.assign(window, {
  DISTRICTS, LEAGUES, COACHING_LEVELS, REQUIRED_DOCS,
  SAMPLE_CLUBS, CQI_STRUCTURE, SERIES,
  cohortStats, docCompletion, overallProgress,
  haversineKm, fixtureCost, generateRoundRobin,
});

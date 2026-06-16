/* ─── Sample data ─── */

// 2026/27 season submission deadline — editable by the Dolphins admin via
// the "Edit deadline" button on the cohort dashboard. Stored as ISO date so
// date inputs and helpers work naturally.
export const SUBMISSION_DEADLINE_DEFAULT = '2026-06-21';

// "21 June 2026"
export function formatDeadlineLong(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
}

// "21 Jun"
export function formatDeadlineShort(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}

// "21 June"
export function formatDeadlineMid(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' });
}

// Whole days between today and the deadline (floor at 0). Past = 0.
export function daysUntil(iso) {
  if (!iso) return 0;
  const target = new Date(iso + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.ceil((target - today) / 86400000);
  return Math.max(0, diff);
}

// Whole days since a full ISO timestamp (e.g. invitedAt `2026-06-04T…Z`). Floor at 0.
export function daysAgo(iso) {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86400000));
}

// Sub-unions / districts derived from the affiliation form's drop-down
export const DISTRICTS = [
  'Ethekwini Metro Cricket Union',
  'Umkhanyakude Cricket District',
  'Ugu Cricket District',
  'KCCD',
  'Illembe Cricket District',
];

/* Leagues are admin-managed per-tenant config now (TenantConfig.leagues), read on the
   client via src/leagues.js helpers. The former static catalogue was removed from this
   client bundle; its content lives in packages/api/seed-data/<tenant>.json as the demo
   seed (see git history for the original arrays). DISTRICTS above stays live. */

// 'None' leads both lists so a coach without accreditation is an explicit,
// selectable state (and the default for a freshly added coach) rather than a
// silently presumed CSA Level 2.
export const COACHING_BODIES = ['None', 'CSA', 'Gary Kirsten'];
export const COACHING_LEVELS = ['None', 'Level 1', 'Level 2', 'Level 3', 'Level 4'];
// Total years of coaching experience, captured on the affiliation form. Kept in
// sync with COACH_EXPERIENCE in packages/api/src/catalogue.ts (server validation).
export const COACH_EXPERIENCE = ['0-3', '4-10', '10+'];

/**
 * Current cricket season label, e.g. "2026/27". Mirrors `seasonLabel` in
 * packages/api/src/index.ts so client copy and server emails agree. `d` is
 * injectable so tests can pin the clock.
 */
export function currentSeasonLabel(d = new Date()) {
  const y = d.getFullYear();
  return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
}

/** Time-of-day greeting. `d` is injectable so tests can pin the clock. */
export function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// ── Player registration profile vocabularies (mirror the official Union form) ──
export const BATTING_TYPES = ['Top Order', 'Mid Order', 'Low Order', 'WK Batsman', 'Bat All Round'];
export const BOWLER_TYPES = ['Fast', 'Medium Fast', 'Medium', 'Slow', 'Finger Spin', 'Wrist Spin'];
export const HANDS = ['Right', 'Left'];
export const RACES = ['African', 'Indian', 'Coloured', 'White', 'Other'];
export const GENDERS = ['Male', 'Female', 'Non-binary'];

// Clearances no longer expire or carry a countdown — a request stays pending until the
// source club actions it (or the union overrides). The former 14-day window, its overdue
// math (CLEARANCE_WINDOW_DAYS / daysSinceIso / clearanceOverdue / clearanceDaysRemaining)
// and the countdown UI were removed product-wide.

/**
 * Derive an ISO date of birth from a 13-digit RSA ID (YYMMDD…), matching the server
 * (see packages/api/src/index.ts `dobFromSaId`). The century digit is absent, so we pivot
 * year-relative (not on a frozen constant): assume the 2000s, fall back to the 1900s only
 * if that would be in the future. Self-updates each year. Returns '' if it isn't a real,
 * non-future date — so the register form can show/hide the DOB preview safely.
 */
export function dobFromSaId(idNumber) {
  if (!/^\d{13}$/.test(idNumber)) return '';
  const yy = parseInt(idNumber.slice(0, 2), 10);
  const mm = parseInt(idNumber.slice(2, 4), 10);
  const dd = parseInt(idNumber.slice(4, 6), 10);
  const currentYear = new Date().getFullYear();
  const year = 2000 + yy <= currentYear ? 2000 + yy : 1900 + yy;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
  const iso = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime()) || d.getTime() > Date.now()) return '';
  if (d.getMonth() + 1 !== mm || d.getDate() !== dd) return '';
  return iso;
}

/** Whole-year age derived from a 13-digit RSA ID. Returns null if the ID isn't valid. */
export function ageFromSaId(idNumber) {
  const dob = dobFromSaId(String(idNumber || ''));
  if (!dob) return null;
  const b = new Date(dob + 'T00:00:00');
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age >= 0 ? age : null;
}

/**
 * Time remaining until an ISO term-end date, as { years, months, expired, label }.
 * label reads like "1 yr 4 mo left", "3 mo left", "expired", or '' if no end date.
 */
export function termRemaining(termEnd) {
  if (!termEnd) return { years: 0, months: 0, expired: false, label: '' };
  const end = new Date(termEnd);
  if (isNaN(end.getTime())) return { years: 0, months: 0, expired: false, label: '' };
  const now = new Date();
  if (end.getTime() <= now.getTime())
    return { years: 0, months: 0, expired: true, label: 'expired' };
  let months = (end.getFullYear() - now.getFullYear()) * 12 + (end.getMonth() - now.getMonth());
  if (end.getDate() < now.getDate()) months--;
  if (months < 0) months = 0;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  const parts = [];
  if (years) parts.push(`${years} yr${years > 1 ? 's' : ''}`);
  if (rem) parts.push(`${rem} mo`);
  if (!parts.length) parts.push('<1 mo');
  return { years, months, expired: false, label: `${parts.join(' ')} left` };
}

// Required compliance documents (from Cricket Services Club Requirements 26-27)
export const REQUIRED_DOCS = [
  {
    key: 'constitution',
    name: 'Club Constitution',
    desc: 'Current signed club constitution document',
  },
  { key: 'agm', name: 'AGM Minutes', desc: 'Minutes of the most recent AGM, signed off' },
  {
    key: 'financials',
    name: 'Financial Statements',
    desc: 'Annual financial statements for the prior season',
  },
  {
    key: 'exco',
    name: 'Exco Reps Listed',
    desc: 'Full list of executive committee representatives with contact details',
  },
  {
    key: 'codeOfConduct',
    name: 'Code of Conduct',
    desc: 'Club code of conduct governing player & member behaviour',
  },
  {
    key: 'safeguarding',
    name: 'Safeguarding Certificate',
    desc: 'Valid safeguarding / child-protection certificates — one per person, at least two people',
  },
];

// ── Compliance document file types ──
// Accepted upload formats. Word covers Google Docs (which exports .docx/.pdf).
// Mirrored server-side in packages/api/src/catalogue.ts DOC_CONTENT_TYPES.
export const DOC_MIME_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
export const DOC_ACCEPT = '.pdf,.doc,.docx';

// Browsers (notably on Windows) often report an empty `file.type` for .doc/.docx —
// resolve from the filename extension before validating, or valid files get
// rejected (or worse: signed and stored as application/pdf forever).
export function resolveDocMime(file) {
  if (file?.type) return file.type;
  const ext = String(file?.name || '')
    .split('.')
    .pop()
    .toLowerCase();
  return DOC_MIME_TYPES[ext] || '';
}
export const isAllowedDocMime = (mime) => Object.values(DOC_MIME_TYPES).includes(mime);
export function extFromMime(mime) {
  const hit = Object.entries(DOC_MIME_TYPES).find(([, m]) => m === mime);
  return hit ? hit[0] : 'pdf';
}

// Doc-completion helpers — the single source of truth for every count/gate so the
// definition can't drift across call sites. Both are driven by REQUIRED_DOCS and
// tolerate clubs whose `docs` object predates a newly-added key (treated as missing).
export const docsUploadedCount = (club) => REQUIRED_DOCS.filter((d) => club.docs?.[d.key]).length;
export const docsAllComplete = (club) => REQUIRED_DOCS.every((d) => !!club.docs?.[d.key]);

// ── Safeguarding: multi-file document (one certificate per person, min 2 people) ──
// Canonical docMeta.safeguarding shape: { files: [{objectKey, size, contentType?,
// uploadedAt}], markedCompliant?, at? }. Mirrored server-side in packages/api.
export const MIN_SAFEGUARDING_FILES = 2;

/**
 * Normalize any historical docMeta.safeguarding shape to the canonical one:
 *  - new `{ files: [...] }` wrapper → as-is
 *  - legacy single real upload `{ objectKey, ... }` → one-entry files array
 *  - legacy admin sentinel `{ markedCompliant: true, at }` → empty files + flag
 *  - missing/null → empty files, no flag
 */
export function safeguardingMeta(meta) {
  const base = {
    files: [],
    markedCompliant: false,
    courseBooked: false,
    courseDate: '',
    at: undefined,
  };
  if (!meta) return base;
  const courseBooked = !!meta.courseBooked;
  const courseDate = meta.courseDate || '';
  if (Array.isArray(meta.files)) {
    return {
      files: meta.files,
      markedCompliant: !!meta.markedCompliant,
      courseBooked,
      courseDate,
      at: meta.at,
    };
  }
  if (meta.objectKey)
    return {
      ...base,
      files: [meta],
      markedCompliant: !!meta.markedCompliant,
      courseBooked,
      courseDate,
    };
  return {
    files: [],
    markedCompliant: !!meta.markedCompliant,
    courseBooked,
    courseDate,
    at: meta.at,
  };
}

/**
 * Whether safeguarding is satisfied: admin override, a booked safeguarding course
 * (the club has none yet but has scheduled training), or the 2-person minimum met.
 */
export function safeguardingSatisfied(meta) {
  const m = safeguardingMeta(meta);
  return m.markedCompliant || m.courseBooked || m.files.length >= MIN_SAFEGUARDING_FILES;
}

/**
 * Derive display fields for an uploaded compliance document from its `docMeta` entry.
 * A real upload carries an `objectKey`; an admin "mark compliant" override (or a sample
 * club) has none, so `real` is false and the file fields are null. Single source of truth
 * for the club portal row, the admin row, and the preview modal header.
 */
export function docFileMeta(meta) {
  const real = !!(meta && meta.objectKey);
  const fileName = real ? String(meta.objectKey).split('/').pop() : null;
  const uploadedDate =
    real && meta.uploadedAt
      ? new Date(meta.uploadedAt).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })
      : null;
  const sizeMB = real && meta.size ? `${(meta.size / 1e6).toFixed(1)} MB` : null;
  const metaText = [fileName, uploadedDate && `uploaded ${uploadedDate}`, sizeMB]
    .filter(Boolean)
    .join(' · ');
  // Word docs can't render in an iframe — the preview modal branches on this.
  // Legacy uploads (no contentType) predate Word support, so they're PDFs.
  const isPdf = !real
    ? true
    : meta.contentType
      ? meta.contentType === DOC_MIME_TYPES.pdf
      : String(meta.objectKey).toLowerCase().endsWith('.pdf');
  return { real, fileName, uploadedDate, sizeMB, metaText, isPdf };
}

/**
 * Decide what a document preview should render, so a real-but-fileless doc is never
 * misrepresented by the demo sample:
 *  - 'real' → a stored S3 file exists; mint a presigned GET and show it.
 *  - 'demo' → local/demo mode; show the bundled sample PDF (sample clubs have no docMeta).
 *  - 'none' → production doc with no usable file (admin override / empty key); show an
 *             explicit "no file on record" state, NOT the sample.
 */
export function resolvePreviewSource(meta, isLocalDemo) {
  const objectKey = meta?.objectKey;
  const hasRealFile = !!objectKey && !String(objectKey).startsWith('local/');
  if (hasRealFile && !isLocalDemo) return 'real';
  if (isLocalDemo) return 'demo';
  return 'none';
}

// Sample clubs — names drawn from the actual Dolphins CQI list
// Each carries denormalised submission state so the admin views can score them.
export const SAMPLE_CLUBS = [
  {
    id: 'ukzn',
    name: 'UKZN CC',
    district: 'Ethekwini Metro Cricket Union',
    sub: 'EMCU',
    chair: 'Ashraf Ganie',
    affiliation: 'complete',
    cqi: 91.89,
    docs: {
      constitution: true,
      agm: true,
      financials: true,
      exco: true,
      codeOfConduct: true,
      safeguarding: true,
    },
    players: 57,
    teams: 3,
    women: 0,
    juniors: 0,
    color: '#1B2A4A',
    ground: { venue: 'Howard College Oval', suburb: 'Glenwood', lat: -29.8666, lon: 30.9783 },
  },
  {
    id: 'clares',
    name: 'Clares CC',
    district: 'Ethekwini Metro Cricket Union',
    sub: 'EMCU',
    chair: 'Rajin Ramsaroop',
    affiliation: 'complete',
    cqi: 87.4,
    docs: {
      constitution: true,
      agm: true,
      financials: true,
      exco: false,
      codeOfConduct: false,
      safeguarding: false,
    },
    players: 72,
    teams: 6,
    women: 1,
    juniors: 3,
    color: '#1D9E75',
    ground: { venue: 'Clares Cricket Field', suburb: 'Glenwood', lat: -29.8533, lon: 30.9512 },
  },
  {
    id: 'chatsworth',
    name: 'Chatsworth Sporting CC',
    district: 'Ethekwini Metro Cricket Union',
    sub: 'EMCU',
    chair: 'Jason Sathiaseelan',
    affiliation: 'complete',
    cqi: 81.2,
    docs: {
      constitution: true,
      agm: true,
      financials: false,
      exco: true,
      codeOfConduct: false,
      safeguarding: false,
    },
    players: 114,
    teams: 10,
    women: 1,
    juniors: 3,
    color: '#C8A84B',
    ground: {
      venue: 'Chatsworth Sports Ground',
      suburb: 'Chatsworth',
      lat: -29.9112,
      lon: 30.8868,
    },
  },
  {
    id: 'umlazi',
    name: 'Umlazi CC',
    district: 'Ethekwini Metro Cricket Union',
    sub: 'EMCU',
    chair: 'Simphiwe Shangase',
    affiliation: 'complete',
    cqi: 64.8,
    docs: {
      constitution: true,
      agm: false,
      financials: false,
      exco: true,
      codeOfConduct: false,
      safeguarding: false,
    },
    players: 58,
    teams: 6,
    women: 1,
    juniors: 3,
    color: '#D85A30',
    ground: { venue: 'Umlazi Comtech Ground', suburb: 'Umlazi', lat: -29.9678, lon: 30.8842 },
  },
  {
    id: 'crusaders',
    name: 'Crusaders CC',
    district: 'Ethekwini Metro Cricket Union',
    sub: 'EMCU',
    chair: 'Duncun Miller',
    affiliation: 'complete',
    cqi: 78.5,
    docs: {
      constitution: true,
      agm: true,
      financials: true,
      exco: true,
      codeOfConduct: true,
      safeguarding: true,
    },
    players: 88,
    teams: 9,
    women: 1,
    juniors: 3,
    color: '#2E4070',
    ground: { venue: 'Crusaders Park', suburb: 'Durban North', lat: -29.7956, lon: 31.0356 },
  },
  {
    id: 'berea',
    name: 'Berea Rovers CC',
    district: 'Ethekwini Metro Cricket Union',
    sub: 'EMCU',
    chair: 'Wayne Scott',
    affiliation: 'in_progress',
    cqi: 0,
    docs: {
      constitution: false,
      agm: false,
      financials: false,
      exco: false,
      codeOfConduct: false,
      safeguarding: false,
    },
    players: 0,
    teams: 3,
    women: 0,
    juniors: 1,
    color: '#243356',
    ground: { venue: 'Berea Rovers Oval', suburb: 'Berea', lat: -29.8348, lon: 31.005 },
  },
  {
    id: 'rhythm',
    name: 'Rhythm DHSOB CC',
    district: 'Ethekwini Metro Cricket Union',
    sub: 'EMCU',
    chair: 'Mags Reddy',
    affiliation: 'complete',
    cqi: 68.4,
    docs: {
      constitution: true,
      agm: false,
      financials: true,
      exco: true,
      codeOfConduct: false,
      safeguarding: false,
    },
    players: 92,
    teams: 9,
    women: 1,
    juniors: 1,
    color: '#1D9E75',
    ground: { venue: 'DHS Old Boys Field', suburb: 'Stamford Hill', lat: -29.8205, lon: 31.0009 },
  },
  {
    id: 'warriors',
    name: 'African Warriors CC',
    district: 'Ethekwini Metro Cricket Union',
    sub: 'EMCU',
    chair: 'Knowledge Vilakazi',
    affiliation: 'complete',
    cqi: 72.1,
    docs: {
      constitution: true,
      agm: true,
      financials: false,
      exco: true,
      codeOfConduct: false,
      safeguarding: false,
    },
    players: 64,
    teams: 5,
    women: 2,
    juniors: 3,
    color: '#1B2A4A',
    ground: { venue: 'KwaMashu K-Section Ground', suburb: 'KwaMashu', lat: -29.7311, lon: 30.9876 },
  },
  {
    id: 'phoenix',
    name: 'Phoenix CC',
    district: 'Ethekwini Metro Cricket Union',
    sub: 'EMCU',
    chair: 'Bradley Chetty',
    affiliation: 'not_started',
    cqi: 0,
    docs: {
      constitution: false,
      agm: false,
      financials: false,
      exco: false,
      codeOfConduct: false,
      safeguarding: false,
    },
    players: 0,
    teams: 6,
    women: 0,
    juniors: 2,
    color: '#C8A84B',
    ground: { venue: 'Phoenix Sports Complex', suburb: 'Phoenix', lat: -29.7003, lon: 31.0214 },
  },
  {
    id: 'verulam',
    name: 'Verulam CC',
    district: 'Ethekwini Metro Cricket Union',
    sub: 'EMCU',
    chair: 'Kugan Subrayen',
    affiliation: 'in_progress',
    cqi: 38.5,
    docs: {
      constitution: true,
      agm: false,
      financials: false,
      exco: false,
      codeOfConduct: false,
      safeguarding: false,
    },
    players: 21,
    teams: 1,
    women: 0,
    juniors: 2,
    color: '#D85A30',
    ground: { venue: 'Verulam Sports Field', suburb: 'Verulam', lat: -29.6411, lon: 31.0498 },
  },
  {
    id: 'harlequins',
    name: 'Harlequins CC',
    district: 'Ethekwini Metro Cricket Union',
    sub: 'EMCU',
    chair: 'Eric Cavanagh',
    affiliation: 'complete',
    cqi: 84.2,
    docs: {
      constitution: true,
      agm: true,
      financials: true,
      exco: true,
      codeOfConduct: true,
      safeguarding: true,
    },
    players: 96,
    teams: 10,
    women: 0,
    juniors: 2,
    color: '#1D9E75',
    ground: { venue: 'Kingsmead North', suburb: 'Stamford Hill', lat: -29.8195, lon: 31.0308 },
  },
  {
    id: 'spartan',
    name: 'Spartan Sporting CC',
    district: 'Ethekwini Metro Cricket Union',
    sub: 'EMCU',
    chair: 'Shafee Ayob',
    affiliation: 'complete',
    cqi: 56.3,
    docs: {
      constitution: true,
      agm: true,
      financials: false,
      exco: false,
      codeOfConduct: false,
      safeguarding: false,
    },
    players: 38,
    teams: 5,
    women: 0,
    juniors: 2,
    color: '#2E4070',
    ground: { venue: 'Spartan Park', suburb: 'Mount Edgecombe', lat: -29.7256, lon: 31.0489 },
  },
  {
    id: 'ilembe',
    name: 'Ilembe CC',
    district: 'Illembe Cricket District',
    sub: 'ICD',
    chair: 'Naren Singh',
    affiliation: 'complete',
    cqi: 47.6,
    docs: {
      constitution: true,
      agm: false,
      financials: true,
      exco: false,
      codeOfConduct: false,
      safeguarding: false,
    },
    players: 28,
    teams: 2,
    women: 0,
    juniors: 0,
    color: '#8A6E1C',
    ground: { venue: 'KwaDukuza Stadium', suburb: 'KwaDukuza', lat: -29.3398, lon: 31.281 },
  },
  {
    id: 'tongaat',
    name: 'Tongaat CC',
    district: 'Ethekwini Metro Cricket Union',
    sub: 'EMCU',
    chair: 'Praven Govender',
    affiliation: 'not_started',
    cqi: 0,
    docs: {
      constitution: false,
      agm: false,
      financials: false,
      exco: false,
      codeOfConduct: false,
      safeguarding: false,
    },
    players: 0,
    teams: 1,
    women: 0,
    juniors: 1,
    color: '#D85A30',
    ground: { venue: 'Tongaat Sports Field', suburb: 'Tongaat', lat: -29.5783, lon: 31.1149 },
  },
];

// Decorate each club with the league keys they registered for, so the
// admin series-creation flow can auto-filter teams by league.
const _LEAGUES_BY_CLUB = {
  ukzn: ['premier', 'premierWomen', 'emcuD1', 'emcuU11'],
  clares: ['premier', 'veterans', 'emcuD1', 'emcuD3_s1'],
  chatsworth: ['premier', 'emcuD2', 'emcuD3_s2', 'emcuU11', 'emcuU13'],
  umlazi: ['promotion', 'emcuD1', 'emcuU11'],
  crusaders: ['premier', 'emcuD1', 'emcuD2'],
  rhythm: ['promotion', 'premierWomen', 'emcuD2', 'emcuD4_s1', 'emcuU13'],
  warriors: ['promotion', 'emcuD3_s1', 'emcuU13'],
  harlequins: ['premier', 'veterans', 'emcuD1', 'emcuD3_s2', 'emcuU11', 'emcuU13'],
  spartan: ['promotion', 'emcuD2', 'emcuD4_s2'],
  // Ilembe CC lives in the Illembe district — its leagues come from that catalogue.
  ilembe: ['premier', 'ilembeA30', 'ilembeBT20'],
  phoenix: [],
  berea: [],
  verulam: [],
  tongaat: [],
};
SAMPLE_CLUBS.forEach((c) => {
  c.leagues = _LEAGUES_BY_CLUB[c.id] || [];
});

// CQI structure — categories, weights, and questions
// Weighting model: Admin 20 / Teams 20 / Coaching 20 / Facilities 15 / Representation 10 / Financial 15 = 100
export const CQI_STRUCTURE = [
  {
    // Key stays 'admin' so existing byCat references keep resolving; the old
    // governance questions (constitution/conduct/agm/minutes/officers/playerdb/
    // inventory) were dropped as redundant with the affiliation form + compliance
    // uploads, and replaced with forward-looking mandate/ambition questions.
    key: 'admin',
    title: 'Club Mandate and Objectives',
    weight: 20,
    accent: 'var(--navy)',
    desc: "The club's vision, ambition and development pathways for the seasons ahead.",
    questions: [
      {
        key: 'vision',
        label: 'Unified vision for cricket development over the next 3–5 years',
        kind: 'yn',
        pts: 3,
      },
      {
        key: 'ambition',
        label: 'Ambition to compete at a higher level (league promotion / provincial)',
        kind: 'rating',
        pts: 4,
      },
      {
        key: 'pathway',
        label: 'Defined pathway toward representative / professional cricket',
        kind: 'yn',
        pts: 3,
      },
      {
        key: 'retention',
        label: 'Commitment to growing player numbers and improving retention',
        kind: 'rating',
        pts: 4,
      },
      {
        key: 'accredAim',
        label: 'Club aims for all coaches to be formally accredited / qualified',
        kind: 'yn',
        pts: 3,
      },
      {
        key: 'coachDev',
        label: 'Ambition to invest in ongoing coach development and upskilling',
        kind: 'rating',
        pts: 4,
      },
    ],
  },
  {
    key: 'teams',
    title: 'Teams',
    weight: 20,
    accent: 'var(--teal)',
    desc: 'Squad depth across senior, women and junior structures.',
    questions: [
      {
        key: 'premprom',
        label: '1st Team plays in Premier or Promotion league',
        kind: 'yn',
        pts: 5,
      },
      { key: 'senior', label: 'Number of Senior Teams', kind: 'num', max: 12, pts: 8 },
      { key: 'women', label: "Number of Women's Teams", kind: 'num', max: 6, pts: 6 },
      { key: 'juniorB', label: 'Number of Junior Boys Teams', kind: 'num', max: 8, pts: 3 },
      { key: 'juniorG', label: 'Number of Junior Girls Teams', kind: 'num', max: 6, pts: 3 },
    ],
  },
  {
    key: 'coaching',
    title: 'Coaching',
    weight: 20,
    accent: 'var(--gold)',
    desc: 'Coach-to-team ratio and accreditation levels.',
    questions: [
      { key: 'coaches', label: 'Total Coaches at the club', kind: 'num', max: 20, pts: 8 },
      { key: 'certified', label: 'Number of Certified Coaches', kind: 'num', max: 20, pts: 8 },
      { key: 'level2', label: '1st Team coach is Level 2 or above', kind: 'yn', pts: 9 },
    ],
  },
  {
    key: 'facilities',
    title: 'Facilities',
    weight: 15,
    accent: 'var(--coral)',
    desc: 'Playing fields, nets and venue ownership.',
    questions: [
      { key: 'covers', label: 'Square covers available', kind: 'yn', pts: 2 },
      { key: 'boundary', label: 'Adequate boundary rope available', kind: 'yn', pts: 2 },
      { key: 'scoreboard', label: 'Scoreboard available', kind: 'yn', pts: 2 },
      { key: 'ownFacility', label: 'Responsible for own facility', kind: 'yn', pts: 2 },
      {
        key: 'fieldsGrass',
        label: 'Number of Grass fields or auxiliary fields',
        kind: 'num',
        max: 10,
        pts: 3,
      },
      {
        key: 'fieldsArt',
        label: 'Number of Artificial fields or auxiliary fields',
        kind: 'num',
        max: 10,
        pts: 1,
      },
      { key: 'netsGrass', label: 'Number of Grass nets', kind: 'num', max: 12, pts: 2 },
      { key: 'netsArt', label: 'Number of Artificial nets', kind: 'num', max: 12, pts: 1 },
    ],
  },
  {
    key: 'representation',
    title: 'Representation',
    weight: 10,
    accent: 'var(--navy-light)',
    desc: 'Player demographics across the club.',
    questions: [
      { key: 'pctBA', label: 'Black African', kind: 'count', max: 15, pts: 4 },
      { key: 'pctIN', label: 'Indian', kind: 'count', max: 15, pts: 2 },
      { key: 'pctCO', label: 'Coloured', kind: 'count', max: 15, pts: 2 },
      { key: 'pctWH', label: 'White', kind: 'count', max: 15, pts: 2 },
    ],
  },
  {
    key: 'financial',
    title: 'Financial Sustainability',
    weight: 15,
    accent: 'var(--green)',
    desc: 'Member subscriptions and monetary sponsorships keeping the club running.',
    questions: [
      {
        key: 'subCycle',
        label: 'Subscription cycle',
        kind: 'choice',
        options: ['Annual', 'Seasonal'],
        pts: 2,
      },
      {
        key: 'subAmount',
        label: 'Subscription cost per player',
        kind: 'money',
        currency: 'R',
        pts: 4,
      },
      { key: 'sponsors', label: 'Number of monetary sponsors', kind: 'num', max: 10, pts: 9 },
    ],
  },
];

// Aggregate stats helpers
export function cohortStats(clubs) {
  const total = clubs.length;
  const affComplete = clubs.filter((c) => c.affiliation === 'complete').length;
  const cqiSubmitted = clubs.filter((c) => c.cqi > 0).length;
  const avgCqi =
    clubs.filter((c) => c.cqi > 0).reduce((s, c) => s + c.cqi, 0) / Math.max(1, cqiSubmitted);
  const docsComplete = clubs.filter(docsAllComplete).length;
  return { total, affComplete, cqiSubmitted, avgCqi, docsComplete };
}

export function docCompletion(club) {
  return Math.round((docsUploadedCount(club) / REQUIRED_DOCS.length) * 100);
}

// ── Reversible "Mark as compliant" — pure doc/meta computation ──
// Kept here (UI-free) so the override-safety invariants can be unit-tested.
// `at` is passed in (not generated) to keep these deterministic.

// Mark `keys` compliant. Sets each doc true and stamps a {markedCompliant}
// sentinel — EXCEPT docs that already have a real uploaded file (objectKey),
// which are left untouched so an upload is never overwritten. `flipped` lists
// the docs that were previously Missing — exactly the set a matching Undo
// should revert (already-Override docs are excluded so Undo can't over-revert).
export function computeMarkCompliance(club, keys, at) {
  const docs = { ...club.docs };
  const docMeta = { ...(club.docMeta ?? {}) };
  const flipped = [];
  for (const k of keys) {
    if (k === 'safeguarding') {
      // Multi-file doc: "has a real upload" means the 2-person minimum is met.
      // The sentinel must PRESERVE the files array — uploads are never erased.
      const m = safeguardingMeta(club.docMeta?.safeguarding);
      if (m.files.length >= MIN_SAFEGUARDING_FILES) continue; // satisfied → leave as-is
      if (m.courseBooked) continue; // club booked a safeguarding course → its own declaration, leave as-is
      if (!club.docs?.[k]) flipped.push(k);
      docs[k] = true;
      docMeta[k] = { files: m.files, markedCompliant: true, at };
      continue;
    }
    if (club.docMeta?.[k]?.objectKey) continue; // real upload → leave as-is
    if (!club.docs?.[k]) flipped.push(k); // was Missing → track for Undo
    docs[k] = true;
    docMeta[k] = { markedCompliant: true, at };
  }
  return { docs, docMeta, flipped };
}

// Revert ONLY override-only docs (markedCompliant && no uploaded file). Real
// uploads are structurally untouchable. `reverted` lists the docs actually
// flipped back to Missing (empty when nothing qualifies → caller can no-op).
export function computeRevertCompliance(club, keys) {
  const docs = { ...club.docs };
  const docMeta = { ...(club.docMeta ?? {}) };
  const reverted = [];
  for (const k of keys) {
    const m = docMeta[k];
    if (k === 'safeguarding') {
      const norm = safeguardingMeta(m);
      // A booked safeguarding course is a club self-declaration, not an admin override —
      // "Revert" (which undoes admin mark-compliant) must never strip it.
      if (norm.courseBooked) continue;
      const satisfied = norm.files.length >= MIN_SAFEGUARDING_FILES;
      // Revertable: an explicit sentinel, OR a compliant flag the uploads don't
      // justify — legacy flag-only records (no docMeta at all) and grandfathered
      // single-file records predate the 2-person minimum and carry no sentinel.
      if (!norm.markedCompliant && !(club.docs?.[k] && !satisfied)) continue;
      // Strip the override but keep every uploaded file; the flag then derives
      // purely from the uploads (a lingering sentinel stays removable even when
      // the club later met the minimum on its own).
      docs[k] = satisfied;
      if (norm.files.length) docMeta[k] = { files: norm.files };
      else delete docMeta[k];
      reverted.push(k);
      continue;
    }
    if (m && m.markedCompliant && !m.objectKey) {
      docs[k] = false;
      delete docMeta[k];
      reverted.push(k);
    }
  }
  return { docs, docMeta, reverted };
}

// Canonical "did the club submit its affiliation form" — the form fact.
export function affiliationSubmitted(club) {
  return club.affiliation === 'complete';
}

export function overallProgress(club) {
  // 5 weighted phases: 20% each
  const p1 = affiliationSubmitted(club) ? 100 : club.affiliation === 'in_progress' ? 40 : 0;
  const p2 = affiliationSubmitted(club) ? 100 : 0; // fixtures phase clears once affiliation is in
  const p3 = Math.min(100, ((club.players || 0) / 60) * 100);
  const p4 = club.cqi > 60 ? 100 : club.cqi > 0 ? 50 : 0;
  const p5 = docCompletion(club);
  return Math.round((p1 + p2 + p3 + p4 + p5) / 5);
}

/* ─── FIXTURE GENERATION + TRAVEL COSTS ───
   Haversine great-circle distance between two lat/lon coords (km).
   Round-robin schedule generator.
   Travel cost = round-trip distance × cars × cost per km. */
export function haversineKm(a, b) {
  if (!a || !b) return 0;
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Shared travel-cost defaults — used as fixtureCost's parameter defaults AND by
// display sites that read series.costPerKm/carsPerAwayTrip directly, so a series
// missing the fields (hand-crafted API payload) renders the same numbers it costs.
export const DEFAULT_COST_PER_KM = 4.5;
export const DEFAULT_CARS = 3;

export function fixtureCost(
  homeClub,
  awayClub,
  costPerKm = DEFAULT_COST_PER_KM,
  cars = DEFAULT_CARS,
) {
  // Null-safe: a fixture can reference a deleted club (lookup → undefined);
  // haversineKm already returns 0 for a missing coord, so cost degrades to R0.
  const km = haversineKm(homeClub?.ground, awayClub?.ground);
  const roundTripKm = km * 2;
  const fuelR = roundTripKm * cars * costPerKm;
  return { distanceKm: km, roundTripKm, cars, costPerKm, fuelR };
}

// Resolve whether an end date should drive scheduling. Empty/absent `dateMode`
// falls back to a format-based default: tournaments are bounded events (spread),
// series run weekly (reference). Shared by the create form and `regenerate` so
// the two paths can never interpret a stored series differently.
export function resolveSpread({ dateMode, kind } = {}) {
  return (dateMode || (kind === 'tournament' ? 'spread' : 'reference')) === 'spread';
}

// Round-robin: each team plays every other team once. Home/away alternates fairly.
export function generateRoundRobin(teamIds, startDateISO, options = {}) {
  if (teamIds.length < 2) return [];
  const teams = [...teamIds];
  if (teams.length % 2 === 1) teams.push(null); // bye
  const n = teams.length;
  const rounds = n - 1;
  const start = new Date(startDateISO);
  // When an end date drives the schedule, spread rounds evenly across the
  // [start, end] window (last round lands on the end date); otherwise fall back
  // to one round per week. A one-day floor keeps the generator self-protecting:
  // even if a caller passes a window too short for the round count, rounds never
  // stack onto the same date.
  const { endDateISO, spread } = options;
  const end = spread && endDateISO ? new Date(endDateISO) : null;
  const rawStep =
    end && rounds > 1 ? (end.getTime() - start.getTime()) / (rounds - 1) : 7 * 86400000;
  const step = Math.max(rawStep, 86400000);
  const fixtures = [];
  let fixtureId = 1;
  for (let r = 0; r < rounds; r++) {
    const matchDate = new Date(start.getTime() + r * step);
    for (let i = 0; i < n / 2; i++) {
      const home = teams[i],
        away = teams[n - 1 - i];
      if (!home || !away) continue;
      // Alternate home/away by round so it's fair
      const swap = r % 2 === 1;
      fixtures.push({
        id: 'f' + fixtureId++,
        round: r + 1,
        date: matchDate.toISOString().slice(0, 10),
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
const _premierTeams = [
  'ukzn',
  'clares',
  'chatsworth',
  'crusaders',
  'rhythm',
  'harlequins',
  'warriors',
  'umlazi',
];
export const SERIES = [
  {
    id: 's-emcu-d1-26-27',
    name: 'EMCU Division 1 · 2026/27',
    startDate: '2026-08-01',
    divisions: false,
    groups: 1,
    maxOvers: 50,
    maxPlayers: 11,
    rosterLimit: 18,
    ballType: 'Cricket Ball',
    seriesType: 'One-Day (40-50 overs)',
    powerPlay: true,
    category: 'Men',
    level: 'Club',
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
    rankCalculator: 'New',
    hideSeriesDetails: false,
    allowLockedRegistration: false,
    pointsTableOrder: ['Most Points', 'NRR', 'Head To Head', 'Number of Wins', 'Win Percentage'],
    tags: ['EMCU Divisions', 'EMCU Division 1', 'Round-robin'],
    teams: _premierTeams,
    costPerKm: 4.5,
    carsPerAwayTrip: 3,
    released: false,
    releasedAt: null,
    fixtures: generateRoundRobin(_premierTeams, '2026-08-02'),
  },
  {
    id: 's-emcu-d2-26-27',
    name: 'EMCU Division 2 · 2026/27',
    startDate: '2026-08-08',
    divisions: false,
    groups: 1,
    maxOvers: 50,
    maxPlayers: 11,
    rosterLimit: 18,
    ballType: 'Cricket Ball',
    seriesType: 'One-Day (40-50 overs)',
    powerPlay: true,
    category: 'Men',
    level: 'Club',
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
    umpireReportsMandatory: false,
    captainReportsMandatory: true,
    sendReportEmails: true,
    rankCalculator: 'New',
    hideSeriesDetails: false,
    allowLockedRegistration: false,
    pointsTableOrder: ['Most Points', 'NRR', 'Head To Head', 'Number of Wins', 'Win Percentage'],
    tags: ['EMCU Divisions', 'EMCU Division 2'],
    teams: ['spartan', 'ilembe', 'verulam', 'tongaat'],
    costPerKm: 4.5,
    carsPerAwayTrip: 3,
    released: false,
    releasedAt: null,
    fixtures: generateRoundRobin(['spartan', 'ilembe', 'verulam', 'tongaat'], '2026-08-08'),
  },
];

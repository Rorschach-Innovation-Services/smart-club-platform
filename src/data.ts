/* ─── Sample data ─── */

import type { Club, RequiredDoc } from './types';
import { fixturesFromDates, legacyRoundDates, roundRobinPairings } from './competition/fixtures';
import { slotRefLabel } from './competition/formats';
import {
  daysSince,
  daysUntilDate,
  formatDay,
  formatDayLong,
  formatDayMid,
  formatStampDay,
  isRealDate,
  monthsUntil,
  timeAgo,
  todayDate,
  wholeYearsSince,
} from './dates';

// 2026/27 season submission deadline — editable by the Dolphins admin via
// the "Edit deadline" button on the cohort dashboard. Stored as ISO date so
// date inputs and helpers work naturally.
export const SUBMISSION_DEADLINE_DEFAULT = '2026-06-21';

/* ─── Deadline display ───
   Thin wrappers over src/dates.ts, kept under their existing names so every call site is
   unchanged. The formatting moved to dayjs so month names match the rest of the app —
   these previously used `en-ZA` ("21 Jun") while the fixtures views used `en-GB`
   ("13 Sept"), which is an ICU quirk, not a locale choice anyone made.

   A malformed deadline echoes back the raw string rather than rendering blank: it is
   admin-entered and seeing the bad value is more useful than seeing nothing. */

// "21 June 2026"
export function formatDeadlineLong(iso) {
  if (!iso) return '';
  return formatDayLong(iso) || iso;
}

// "21 Jun"
export function formatDeadlineShort(iso) {
  if (!iso) return '';
  return formatDay(iso) || iso;
}

// "21 June"
export function formatDeadlineMid(iso) {
  if (!iso) return '';
  return formatDayMid(iso) || iso;
}

// Whole days between today and the deadline (floor at 0). Past = 0.
export function daysUntil(iso) {
  return daysUntilDate(iso);
}

// Whole days since a full ISO timestamp (e.g. invitedAt `2026-06-04T…Z`). Floor at 0.
export function daysAgo(iso) {
  return daysSince(iso);
}

// Compact "time ago" label for a full ISO timestamp, e.g. 'just now' / '2h ago' / '3d ago'.
// `now` is injectable so the output is deterministic under test.
export function relTimeAgo(iso: string | undefined, now: number = Date.now()): string {
  return timeAgo(iso, now);
}

/** One row in the cohort-wide "Recent activity" feed. */
export interface ActivityRow {
  who: string;
  what: string;
  at: string;
  tone: 'teal' | 'navy' | 'coral';
}

const ACTIVITY_WINDOW_MS = 7 * 86400000;
const ACTIVITY_LIMIT = 6;

// Event-TYPE labels per comm-log kind (ok/fail). An unknown or legacy-undefined kind
// falls back to the invite copy, matching the per-club timeline idiom (admin.tsx).
const ACTIVITY_LABELS = {
  fixtures: { ok: 'Fixtures shared with players', fail: 'Fixtures broadcast failed to send' },
  reglink: { ok: 'Player registration link sent', fail: 'Registration link failed to send' },
  invite: { ok: 'Onboarding invite sent', fail: 'Onboarding invite failed to send' },
} as const;

/**
 * Cohort-wide "recent activity" derived from each club's REAL timestamped events. Newest
 * first, within the last 7 days, capped at 6 rows.
 *
 * PII-safe by construction: emits only the club name, a fixed event-TYPE label, and the
 * timestamp — never recipient contact details (`commLog.to`), free-text send summaries, or
 * note bodies. (The per-club timeline may show `→ recipient` inside a single club's drawer;
 * this feed is cohort-wide and always visible, so contact details must never reach it.)
 * Notes are excluded entirely for the same reason. Events without a valid timestamp are
 * skipped — affiliation/CQI "submitted" milestones carry no per-event timestamp and so
 * cannot be reconstructed here.
 */
export function buildRecentActivity(clubs: Club[], now: number = Date.now()): ActivityRow[] {
  const cutoff = now - ACTIVITY_WINDOW_MS;
  const inWindow = (iso?: string) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return !Number.isNaN(t) && t >= cutoff && t <= now;
  };
  const rows: ActivityRow[] = [];
  for (const club of clubs || []) {
    if (!club) continue;
    const who = club.name;
    for (const e of club.commLog || []) {
      if (e?.status === 'skipped' || !inWindow(e?.at)) continue;
      const failed = e.status === 'failed';
      const tone: ActivityRow['tone'] = failed ? 'coral' : e.kind === 'fixtures' ? 'teal' : 'navy';
      const label =
        ACTIVITY_LABELS[e.kind as keyof typeof ACTIVITY_LABELS] ?? ACTIVITY_LABELS.invite;
      rows.push({ who, what: failed ? label.fail : label.ok, at: e.at, tone });
    }
    if (club.onboardedVia === 'self-signup' && inWindow(club.onboardedAt)) {
      rows.push({
        who,
        what: 'Joined via signup link',
        at: club.onboardedAt as string,
        tone: 'teal',
      });
    }
  }
  // Sort on the parsed instant (offset-safe), newest first.
  rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return rows.slice(0, ACTIVITY_LIMIT);
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

// Player nationality (demonyms), captured on registration. Alphabetical; 'South African' is
// the default for SA-ID registrants and MUST appear verbatim. The dropdown has no free-text or
// empty option, so only these values are ever stored (the server keeps it lenient like race/gender).
export const NATIONALITIES = [
  'Afghan',
  'Albanian',
  'Algerian',
  'American',
  'Andorran',
  'Angolan',
  'Antiguan',
  'Argentine',
  'Armenian',
  'Australian',
  'Austrian',
  'Azerbaijani',
  'Bahamian',
  'Bahraini',
  'Bangladeshi',
  'Barbadian',
  'Belarusian',
  'Belgian',
  'Belizean',
  'Beninese',
  'Bhutanese',
  'Bolivian',
  'Bosnian',
  'Botswanan',
  'Brazilian',
  'British',
  'Bruneian',
  'Bulgarian',
  'Burkinabé',
  'Burmese',
  'Burundian',
  'Cambodian',
  'Cameroonian',
  'Canadian',
  'Cape Verdean',
  'Central African',
  'Chadian',
  'Chilean',
  'Chinese',
  'Colombian',
  'Comoran',
  'Congolese',
  'Costa Rican',
  'Croatian',
  'Cuban',
  'Cypriot',
  'Czech',
  'Danish',
  'Djiboutian',
  'Dominican',
  'Dutch',
  'East Timorese',
  'Ecuadorean',
  'Egyptian',
  'Emirati',
  'English',
  'Equatorial Guinean',
  'Eritrean',
  'Estonian',
  'Eswatini',
  'Ethiopian',
  'Fijian',
  'Finnish',
  'French',
  'Gabonese',
  'Gambian',
  'Georgian',
  'German',
  'Ghanaian',
  'Greek',
  'Grenadian',
  'Guatemalan',
  'Guinean',
  'Guyanese',
  'Haitian',
  'Honduran',
  'Hungarian',
  'Icelandic',
  'Indian',
  'Indonesian',
  'Iranian',
  'Iraqi',
  'Irish',
  'Israeli',
  'Italian',
  'Ivorian',
  'Jamaican',
  'Japanese',
  'Jordanian',
  'Kazakh',
  'Kenyan',
  'Kittitian',
  'Kuwaiti',
  'Kyrgyz',
  'Laotian',
  'Latvian',
  'Lebanese',
  'Liberian',
  'Libyan',
  'Liechtensteiner',
  'Lithuanian',
  'Luxembourgish',
  'Macedonian',
  'Malagasy',
  'Malawian',
  'Malaysian',
  'Maldivian',
  'Malian',
  'Maltese',
  'Marshallese',
  'Mauritanian',
  'Mauritian',
  'Mexican',
  'Micronesian',
  'Moldovan',
  'Monégasque',
  'Mongolian',
  'Montenegrin',
  'Moroccan',
  'Mozambican',
  'Namibian',
  'Nauruan',
  'Nepali',
  'New Zealander',
  'Nicaraguan',
  'Nigerian',
  'Nigerien',
  'North Korean',
  'Northern Irish',
  'Norwegian',
  'Omani',
  'Pakistani',
  'Palauan',
  'Palestinian',
  'Panamanian',
  'Papua New Guinean',
  'Paraguayan',
  'Peruvian',
  'Philippine',
  'Polish',
  'Portuguese',
  'Qatari',
  'Romanian',
  'Russian',
  'Rwandan',
  'Saint Lucian',
  'Salvadoran',
  'Samoan',
  'San Marinese',
  'São Toméan',
  'Saudi',
  'Scottish',
  'Senegalese',
  'Serbian',
  'Seychellois',
  'Sierra Leonean',
  'Singaporean',
  'Slovak',
  'Slovenian',
  'Solomon Islander',
  'Somali',
  'South African',
  'South Korean',
  'South Sudanese',
  'Spanish',
  'Sri Lankan',
  'Sudanese',
  'Surinamese',
  'Swedish',
  'Swiss',
  'Syrian',
  'Taiwanese',
  'Tajik',
  'Tanzanian',
  'Thai',
  'Togolese',
  'Tongan',
  'Trinidadian',
  'Tunisian',
  'Turkish',
  'Turkmen',
  'Tuvaluan',
  'Ugandan',
  'Ukrainian',
  'Uruguayan',
  'Uzbek',
  'Vanuatuan',
  'Venezuelan',
  'Vietnamese',
  'Welsh',
  'Yemeni',
  'Zambian',
  'Zimbabwean',
  'Other',
];

// Chairperson motivation, captured on the affiliation form (Union volunteer/engagement
// reporting). Mirror of INVOLVEMENT_REASONS in packages/api/src/catalogue.ts — keep in sync.
export const INVOLVEMENT_REASONS = [
  'Passion and love for the game of cricket',
  'Giving back to the cricket community',
  'Continuing a family or personal cricket legacy',
  'Building friendships and community connections',
  'Promoting cricket in my local area',
  'Staying involved in cricket after my playing career',
  'Volunteering and serving the community',
];

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
  // Strict parsing rejects 31 February outright, so the round-trip check the old
  // lenient-Date version needed (re-reading month/day to spot a rollover) is gone.
  if (!isRealDate(iso) || iso > todayDate()) return '';
  return iso;
}

// Oldest date of birth the server accepts (packages/api/src/index.ts MIN_DOB).
export const MIN_DOB = '1920-01-01';

export type DobError = '' | 'incomplete' | 'year-format' | 'not-real' | 'future' | 'too-old';

/**
 * Compose a manual day/month/year entry (register page, passport holders) into an ISO
 * date of birth. Returns `dob: ''` with a reason whenever the parts don't make a date
 * the server would accept — the same bounds as `resolvePlayerDob` server-side. The
 * `year-format` case is separate from `too-old` so a two-digit year ("58") gets asked
 * for four digits rather than being scolded about 1920.
 */
export function composeDob(
  day: string,
  month: string,
  year: string,
): { dob: string; error: DobError } {
  const d = day.trim();
  const m = month.trim();
  const y = year.trim();
  if (!d || !m || !y) return { dob: '', error: 'incomplete' };
  if (!/^\d{4}$/.test(y)) return { dob: '', error: 'year-format' };
  // Year bound checked numerically before composing — dayjs's strict parser rejects
  // far-out years like 0019 as unparseable, which would surface as "doesn't exist".
  if (Number(y) < Number(MIN_DOB.slice(0, 4))) return { dob: '', error: 'too-old' };
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  if (!isRealDate(iso)) return { dob: '', error: 'not-real' };
  if (iso > todayDate()) return { dob: '', error: 'future' };
  return { dob: iso, error: '' };
}

/** Whole-year age derived from a 13-digit RSA ID. Returns null if the ID isn't valid. */
export function ageFromSaId(idNumber) {
  const dob = dobFromSaId(String(idNumber || ''));
  if (!dob) return null;
  const age = wholeYearsSince(dob);
  return age !== null && age >= 0 ? age : null;
}

/**
 * Time remaining until an ISO term-end date, as { years, months, expired, label }.
 * label reads like "1 yr 4 mo left", "3 mo left", "expired", or '' if no end date.
 */
export function termRemaining(termEnd) {
  if (!termEnd) return { years: 0, months: 0, expired: false, label: '' };
  const remaining = monthsUntil(termEnd);
  if (remaining === null) return { years: 0, months: 0, expired: false, label: '' };
  if (remaining.expired) return { years: 0, months: 0, expired: true, label: 'expired' };
  const months = remaining.months;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  const parts = [];
  if (years) parts.push(`${years} yr${years > 1 ? 's' : ''}`);
  if (rem) parts.push(`${rem} mo`);
  if (!parts.length) parts.push('<1 mo');
  return { years, months, expired: false, label: `${parts.join(' ')} left` };
}

// ── Compliance documents (per-tenant catalogue, ADR 0009) ──
// The shared DEFAULT catalogue — the read-time fallback for tenants with no explicit
// `requiredDocs` on their config (mirror of DEFAULT_REQUIRED_DOCS in
// packages/api/src/catalogue.ts; keep in sync). The legacy hardcoded behaviors are now
// declarative flags on each entry: `kind:'form'` (satisfied on-platform, not a file),
// `multiFile`+`minFiles`/`maxFiles` (append, complete at the minimum),
// `allowMeetingBooked` / `allowCourseBooked` / `allowUnavailable` (the escape hatches),
// `accepts` (upload formats; absent ⇒ pdf/doc/docx), `archived` (excluded from counts,
// files still viewable). The tenant's live list arrives on GET /tenant; every helper
// below takes it as a parameter with this default so legacy call sites are unchanged.
export const DEFAULT_REQUIRED_DOCS: RequiredDoc[] = [
  {
    key: 'constitution',
    name: 'Club Constitution',
    desc: 'Current signed club constitution document',
  },
  {
    key: 'agm',
    name: 'AGM Minutes',
    desc: 'Minutes of the most recent AGM, signed off',
    allowMeetingBooked: true,
  },
  {
    key: 'financials',
    name: 'Financial Statements',
    desc: 'Annual financial statements for the prior season',
    allowUnavailable: true,
  },
  {
    key: 'exco',
    name: 'Exco Reps Listed',
    desc: 'Full list of executive committee representatives with contact details',
    kind: 'form',
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
    multiFile: true,
    minFiles: 2,
    maxFiles: 10,
    allowCourseBooked: true,
  },
];

/** @deprecated transitional alias — call sites should take the tenant's list instead. */
export const REQUIRED_DOCS = DEFAULT_REQUIRED_DOCS;

/**
 * The catalogue minus archived entries — what counts, gates and upload flows see.
 *
 * Coerces a non-array argument to the defaults rather than throwing. The doc helpers
 * below read like array predicates (`clubs.filter(docsAllComplete)`), and `filter`/`map`
 * pass the INDEX as the second argument — which lands in their catalogue parameter. A
 * bare default only covers `undefined`, so index 0 would otherwise reach `.filter` on a
 * number and white-screen the page. Callers that mean a specific catalogue still pass one.
 */
export const activeDocs = (docs) =>
  (Array.isArray(docs) ? docs : DEFAULT_REQUIRED_DOCS).filter((d) => !d.archived);

/** A structural doc role (self-serve onboarding, ADR 0010) — the two roles downstream
 *  wizards read documents through, rather than by literal doc key. */
export type DocRole = 'memberDatabase' | 'committee';

/**
 * The active doc KEY carrying a structural role, or `null` if none is assigned. Client
 * mirror of packages/api/src/catalogue.ts `docKeyForRole` — the SPA can't import
 * packages/api, and `validateRequiredDocs` guarantees at most one active doc per role,
 * so "first match wins" here is exact. Used where a wizard needs the literal key (to
 * presign/commit or fetch a view-url), even though gating itself reads the already-
 * role-resolved `InsightsClub.intake` server projection.
 */
export function docKeyForRole(docs: RequiredDoc[], role: DocRole): string | null {
  const hit = docs.find((d) => d.role === role && !d.archived);
  return hit?.key ?? null;
}

/** Whether any active doc in the catalogue carries the given structural role — the
 *  onboarding checklist's role-assigned test, sharing `docKeyForRole`'s resolution. */
export function roleAssigned(docs: RequiredDoc[], role: DocRole): boolean {
  return docKeyForRole(docs, role) !== null;
}

// ── Compliance document file types ──
// Every uploadable format → its exact MIME type. Word covers Google Docs (which exports
// .docx/.pdf); the spreadsheet trio serves catalogues whose docs are filled-in workbooks.
// Mirrored server-side in packages/api/src/catalogue.ts DOC_FORMAT_MIME.
export const DOC_FORMAT_MIME = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
};
// The legacy accepted set — the default when a doc definition declares no `accepts`.
export const DEFAULT_DOC_FORMATS = ['pdf', 'doc', 'docx'];

/** The formats one doc definition accepts (a RequiredDoc or undefined for legacy). */
export const docFormats = (doc) => doc?.accepts ?? DEFAULT_DOC_FORMATS;
/** `accept=` attribute string for one doc's file input, e.g. ".pdf,.doc,.docx". */
export const docAccept = (doc) =>
  docFormats(doc)
    .map((f) => `.${f}`)
    .join(',');
/** Whether a resolved MIME type is accepted for this doc. */
export const docMimeAllowed = (doc, mime) =>
  docFormats(doc).some((f) => DOC_FORMAT_MIME[f] === mime);

/** @deprecated per-doc now — use DOC_FORMAT_MIME / docAccept(doc). */
export const DOC_MIME_TYPES = {
  pdf: DOC_FORMAT_MIME.pdf,
  doc: DOC_FORMAT_MIME.doc,
  docx: DOC_FORMAT_MIME.docx,
};
/** @deprecated use docAccept(doc). */
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
  return DOC_FORMAT_MIME[ext] || '';
}
/** @deprecated use docMimeAllowed(doc, mime) — this checks the legacy pdf/doc/docx set. */
export const isAllowedDocMime = (mime) => Object.values(DOC_MIME_TYPES).includes(mime);
export function extFromMime(mime) {
  const hit = Object.entries(DOC_FORMAT_MIME).find(([, m]) => m === mime);
  return hit ? hit[0] : 'pdf';
}

/**
 * The inline-preview render strategy a compliance/ID file maps to. Driven by the stored
 * `contentType`, falling back to the objectKey extension for legacy uploads and Windows'
 * empty `file.type` (the same dual strategy as resolveDocMime). The preview modal + every
 * doc surface branch on this:
 *  - 'pdf'   → iframe (unchanged);              'docx'  → docx-preview (sandboxed iframe)
 *  - 'sheet' → SheetJS → HTML (sandboxed iframe); 'image' → <img> (ID docs, jpeg/png)
 *  - 'word-legacy' → .doc (Word 97 binary): no in-browser renderer, download fallback
 *  - 'unknown'     → anything unrecognised (also download fallback / raw iframe attempt)
 */
export type DocPreviewKind = 'pdf' | 'docx' | 'sheet' | 'image' | 'word-legacy' | 'unknown';

const SHEET_PREVIEW_MIMES = new Set([
  DOC_FORMAT_MIME.xls,
  DOC_FORMAT_MIME.xlsx,
  DOC_FORMAT_MIME.ods,
]);
const IMAGE_PREVIEW_MIMES = new Set(['image/jpeg', 'image/png']);
const PREVIEW_KIND_BY_EXT: Record<string, DocPreviewKind> = {
  pdf: 'pdf',
  docx: 'docx',
  doc: 'word-legacy',
  xls: 'sheet',
  xlsx: 'sheet',
  ods: 'sheet',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
};

export function docPreviewKind(meta): DocPreviewKind {
  const ct = meta?.contentType;
  // A recognised contentType wins outright (it can even override a conflicting extension).
  // An UNrecognised one falls through to the objectKey extension — a generic
  // application/octet-stream on an `.xlsx` should still preview — and only when both
  // signals fail do we land on 'unknown'.
  if (ct) {
    if (ct === DOC_FORMAT_MIME.pdf) return 'pdf';
    if (ct === DOC_FORMAT_MIME.docx) return 'docx';
    if (ct === DOC_FORMAT_MIME.doc) return 'word-legacy';
    if (SHEET_PREVIEW_MIMES.has(ct)) return 'sheet';
    if (IMAGE_PREVIEW_MIMES.has(ct)) return 'image';
  }
  const ext = String(meta?.objectKey || '')
    .toLowerCase()
    .split('.')
    .pop();
  return PREVIEW_KIND_BY_EXT[ext] ?? 'unknown';
}

// Doc-completion helpers — the single source of truth for every count/gate so the
// definition can't drift across call sites. Driven by the tenant's catalogue (default:
// the shared list), skip archived entries, and tolerate clubs whose `docs` object
// predates a newly-added key (treated as missing).
export const docsUploadedCount = (club, docs = DEFAULT_REQUIRED_DOCS) =>
  activeDocs(docs).filter((d) => club.docs?.[d.key]).length;
export const docsAllComplete = (club, docs = DEFAULT_REQUIRED_DOCS) =>
  activeDocs(docs).every((d) => !!club.docs?.[d.key]);

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
 * Whether a multi-file doc is satisfied: admin override, a booked course (the club has
 * no certificates yet but has scheduled training), or the file minimum met. The minimum
 * comes from the doc definition (`minFiles`); the legacy 2-person default applies when
 * no definition is at hand.
 */
export function safeguardingSatisfied(meta, minFiles = MIN_SAFEGUARDING_FILES) {
  const m = safeguardingMeta(meta);
  return m.markedCompliant || m.courseBooked || m.files.length >= minFiles;
}

/** Effective file minimum for a multi-file doc definition (legacy default: 2). */
export const docMinFiles = (doc) => doc?.minFiles ?? MIN_SAFEGUARDING_FILES;

// ── AGM Minutes: "we haven't held our AGM yet" → record a future meeting date ──
// A club with no minutes to upload declares the date the AGM will be held. Mirrors the
// safeguarding course-booking sentinel but for a single-file doc:
// docMeta.agm = { meetingBooked: true, meetingDate: 'YYYY-MM-DD', at: ISO } (no objectKey).
// docs.agm is satisfied by either a real upload OR a booked meeting. Single source of truth
// for the club row, the admin row, and the revert guard so the definition can't drift.
export function agmMeta(meta) {
  return {
    meetingBooked: !!meta?.meetingBooked,
    meetingDate: meta?.meetingDate || '',
  };
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
  const uploadedDate = real && meta.uploadedAt ? formatStampDay(meta.uploadedAt) : null;
  const sizeMB = real && meta.size ? `${(meta.size / 1e6).toFixed(1)} MB` : null;
  const metaText = [fileName, uploadedDate && `uploaded ${uploadedDate}`, sizeMB]
    .filter(Boolean)
    .join(' · ');
  // The preview modal branches on docPreviewKind now; isPdf stays as its narrow twin
  // (pdf-or-not) so existing callers/tests keep resolving. Delegating keeps the
  // contentType/extension dual strategy in one place (docPreviewKind).
  const isPdf = docPreviewKind(meta) === 'pdf';
  return { real, fileName, uploadedDate, sizeMB, metaText, isPdf };
}

/**
 * Decide what a document preview should render, so a real-but-fileless doc is never
 * misrepresented by the demo sample:
 *  - 'real' → a stored file exists; mint a view-url and show it. In local mode a
 *             `local/`-prefixed objectKey now counts too — the view-url API serves its
 *             actual bytes off the dev:local upload sink (see /local-uploads/* in
 *             packages/api/src/index.ts), so there's real content to fetch.
 *  - 'demo' → local/demo mode with NO stored file at all (sample clubs have no
 *             docMeta); show the bundled sample PDF.
 *  - 'none' → production doc with no usable file (admin override / empty key); show an
 *             explicit "no file on record" state, NOT the sample.
 */
export function resolvePreviewSource(meta, isLocalDemo) {
  const objectKey = meta?.objectKey;
  if (objectKey && (!String(objectKey).startsWith('local/') || isLocalDemo)) return 'real';
  if (isLocalDemo) return 'demo';
  return 'none';
}

// CQI structure — categories, weights, and questions
// Weighting model: Admin 18 / Teams 18 / Coaching 18 / Facilities 14 / Representation 9 /
// Financial 13 / Governance 10 = 100. The six capability categories were scaled from their
// original 20/20/20/15/10/15 (=100) down to 90 to make room for the 10-pt Governance &
// Compliance dimension. Stored club.cqi is a per-submission snapshot — historical scores
// predate this 7th dimension and re-baseline only when a club next submits.
export const CQI_STRUCTURE = [
  {
    // Key stays 'admin' so existing byCat references keep resolving. The forward-looking
    // mandate/ambition questions live here; the governance checks they once shared the
    // category with (constitution/conduct/agm/minutes/officers/playerdb/inventory) now live
    // in the dedicated 'governance' category below, auto-filled from compliance documents.
    key: 'admin',
    title: 'Club Mandate and Objectives',
    weight: 18,
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
    weight: 18,
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
    weight: 18,
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
    weight: 14,
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
    weight: 9,
    accent: 'var(--navy-light)',
    desc: 'Player demographics across the club.',
    // `max` is vestigial for kind:'count' — these render as uncapped number inputs
    // (CountInput) and score on proportional share, so no per-race limit is enforced.
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
    weight: 13,
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
  {
    // Governance & Compliance — the foundational checks the Cricket Services requirements
    // expect. These are NOT entered by the club: they auto-fill from the compliance documents
    // and club data (see deriveGovernance below), but stay editable so a club can correct a
    // nuance. Reuses the legacy governance question keys.
    key: 'governance',
    title: 'Governance & Compliance',
    weight: 10,
    accent: 'var(--navy)',
    desc: 'Auto-filled from your compliance documents and club records — adjust if needed.',
    questions: [
      { key: 'constitution', label: 'Club has a current Constitution', kind: 'yn', pts: 2 },
      { key: 'codeOfConduct', label: 'Code of Conduct is in place', kind: 'yn', pts: 1 },
      { key: 'inventory', label: 'General Admin Inventory maintained', kind: 'yn', pts: 1 },
      { key: 'agmConducted', label: 'AGM conducted at least once a year', kind: 'yn', pts: 2 },
      {
        key: 'officers',
        label: 'Chairperson, Secretary & Treasurer in place',
        kind: 'yn',
        pts: 2,
      },
      { key: 'agmMinutes', label: 'Minutes of AGM available', kind: 'yn', pts: 1 },
      { key: 'playerdb', label: 'Player database available', kind: 'yn', pts: 1 },
    ],
  },
];

// ── CQI Governance auto-fill ──
// The Governance & Compliance category is derived from compliance documents and club records
// rather than entered by the club. Single source of truth for both the club CQI form and the
// admin breakdown so the mapping can't drift.
export const GOVERNANCE_KEYS = [
  'constitution',
  'codeOfConduct',
  'inventory',
  'agmConducted',
  'officers',
  'agmMinutes',
  'playerdb',
];

/** The seven governance answers derived from a club's documents and records. */
export function deriveGovernance(club: Partial<Club>): Record<string, boolean> {
  const docs = club?.docs || {};
  const playerCount = club?.players ?? club?.playerCount ?? 0;
  return {
    constitution: !!docs.constitution,
    codeOfConduct: !!docs.codeOfConduct,
    // No standalone source — admin inventory is maintained on-platform via the affiliation
    // form and roster, so it's treated as in place (editable if a club disagrees).
    inventory: true,
    // docs.agm is satisfied by uploaded minutes OR a booked AGM meeting date.
    agmConducted: !!docs.agm,
    officers: !!docs.exco,
    agmMinutes: !!docs.agm,
    playerdb: playerCount > 0,
  };
}

// Old-schema CQI answer keys with no equivalent in the current structure. Their presence in a
// stored cqiAnswers marks a submission made BEFORE the Governance & Compliance category
// existed — back then an approximation block wrote governance-ish keys (constitution / officers
// / inventory / playerdb) into cqiAnswers. Those are NOT genuine club overrides, so they must
// not win over the live document derivation. A current submission never writes these keys.
const LEGACY_CQI_KEYS = ['agm', 'minutes', 'conduct'];

/**
 * A club's genuine stored CQI answers. For legacy submissions (detected by an orphan old-schema
 * key) the colliding governance keys are dropped so they re-derive from the documents rather
 * than freezing on a stale approximation. Single source of truth for "did the club genuinely
 * answer this" — used both to build effectiveAnswers and to tag answer provenance.
 */
export function genuineCqiAnswers(club: Partial<Club>): Record<string, any> {
  const stored: Record<string, any> = { ...(club?.cqiAnswers || {}) };
  if (LEGACY_CQI_KEYS.some((k) => k in stored)) {
    for (const k of GOVERNANCE_KEYS) delete stored[k];
  }
  return stored;
}

/**
 * Effective CQI answers for scoring/display: the auto-filled governance values overlaid by
 * whatever the club has genuinely stored. Because we persist only governance OVERRIDES (see
 * governanceOverrides), untouched governance answers keep tracking the documents live — so
 * every consumer that scores or renders answers must read through this, not raw cqiAnswers.
 */
export function effectiveAnswers(club: Partial<Club>): Record<string, any> {
  return { ...deriveGovernance(club), ...genuineCqiAnswers(club) };
}

/**
 * Strip governance answers that equal their derived value, leaving only genuine club
 * overrides. Called at submit so a club that later uploads a document isn't frozen on the
 * stale auto-filled value it happened to submit with.
 *
 * Legacy marker keys are stripped too: effectiveAnswers carries them through from a legacy
 * club's stored answers, so without this a re-save would re-persist them — and their presence
 * makes genuineCqiAnswers discard governance overrides on every subsequent read, silently
 * reverting the edit. A current submission never writes these keys.
 */
export function governanceOverrides(
  answers: Record<string, any>,
  club: Partial<Club>,
): Record<string, any> {
  const derived: Record<string, any> = deriveGovernance(club);
  const out: Record<string, any> = { ...answers };
  for (const k of GOVERNANCE_KEYS) {
    if (out[k] === derived[k]) delete out[k];
  }
  for (const k of LEGACY_CQI_KEYS) delete out[k];
  return out;
}

// Aggregate stats helpers
export function cohortStats(clubs, requiredDocs = DEFAULT_REQUIRED_DOCS) {
  const total = clubs.length;
  const affComplete = clubs.filter((c) => c.affiliation === 'complete').length;
  const cqiSubmitted = clubs.filter((c) => c.cqi > 0).length;
  const avgCqi =
    clubs.filter((c) => c.cqi > 0).reduce((s, c) => s + c.cqi, 0) / Math.max(1, cqiSubmitted);
  // Wrapped, never passed as a bare predicate: filter would hand docsAllComplete the
  // array index as its catalogue argument. Threading the tenant's own catalogue also
  // keeps this count honest for a client whose doc set isn't the shared default.
  const docsComplete = clubs.filter((c) => docsAllComplete(c, requiredDocs)).length;
  return { total, affComplete, cqiSubmitted, avgCqi, docsComplete };
}

export function docCompletion(club, docs = DEFAULT_REQUIRED_DOCS) {
  const active = activeDocs(docs);
  if (!active.length) return 100; // a tenant with no required docs is trivially complete
  return Math.round((docsUploadedCount(club, docs) / active.length) * 100);
}

// ── Reversible "Mark as compliant" — pure doc/meta computation ──
// Kept here (UI-free) so the override-safety invariants can be unit-tested.
// `at` is passed in (not generated) to keep these deterministic.

// Mark `keys` compliant. Sets each doc true and stamps a {markedCompliant}
// sentinel — EXCEPT docs that already have a real uploaded file (objectKey),
// which are left untouched so an upload is never overwritten. `flipped` lists
// the docs that were previously Missing — exactly the set a matching Undo
// should revert (already-Override docs are excluded so Undo can't over-revert).
export function computeMarkCompliance(club, keys, at, requiredDocs = DEFAULT_REQUIRED_DOCS) {
  const docs = { ...club.docs };
  const docMeta = { ...(club.docMeta ?? {}) };
  const flipped = [];
  for (const k of keys) {
    const def = requiredDocs.find((d) => d.key === k);
    // Multi-file behavior comes from the definition, or — for a key retired from the
    // catalogue — from the stored meta shape (a files[] array only ever comes from the
    // multi-file path).
    const multi = def ? !!def.multiFile : Array.isArray(club.docMeta?.[k]?.files);
    if (multi) {
      // Multi-file doc: "has a real upload" means the file minimum is met.
      // The sentinel must PRESERVE the files array — uploads are never erased.
      const m = safeguardingMeta(club.docMeta?.[k]);
      if (m.files.length >= docMinFiles(def)) continue; // satisfied → leave as-is
      if (m.courseBooked) continue; // club booked a course → its own declaration, leave as-is
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

/**
 * Compute the docs/docMeta for marking a doc "Unavailable" (the `allowUnavailable`
 * escape hatch) or undoing it. `at` is passed in, not generated, to keep this
 * deterministic — same contract as computeMarkCompliance.
 *
 * The sentinel rides ALONGSIDE whatever is stored (same slot as markedCompliant), never
 * replacing it: a flat `docMeta[key] = { unavailable }` would erase a multi-file doc's
 * files[] array and drop a single-file doc's objectKey, orphaning that object in a bucket
 * with no lifecycle rule. The UI only offers the affordance when nothing is on file, but
 * this must not depend on that gate.
 */
export function computeDocUnavailable(
  club,
  key,
  makeUnavailable,
  at,
  requiredDocs = DEFAULT_REQUIRED_DOCS,
) {
  const def = requiredDocs.find((d) => d.key === key);
  const stored = club.docMeta?.[key];
  // Multi-file behaviour from the definition, or — for a key retired from the catalogue
  // — from the stored shape, since a files[] array only ever comes from that path.
  const multi = def ? !!def.multiFile : Array.isArray(stored?.files);
  const norm = safeguardingMeta(stored);
  const docMeta = { ...(club.docMeta || {}) };
  let nextFlag = makeUnavailable;
  if (makeUnavailable) {
    docMeta[key] = multi
      ? { ...(stored ?? {}), files: norm.files, unavailable: true, at }
      : { ...(stored ?? {}), unavailable: true, at };
  } else if (multi && norm.files.length) {
    // Undo on a multi-file doc keeps the uploads and re-derives the flag from them.
    docMeta[key] = { files: norm.files };
    nextFlag = norm.files.length >= docMinFiles(def);
  } else if (!multi && stored?.objectKey) {
    // Undo on a single-file doc that still has its upload: drop only the sentinel.
    const { unavailable: _unavailable, at: _at, ...rest } = stored;
    docMeta[key] = rest;
    nextFlag = true;
  } else {
    delete docMeta[key];
  }
  return { docs: { ...(club.docs || {}), [key]: nextFlag }, docMeta };
}

// Revert ONLY override-only docs (markedCompliant && no uploaded file). Real
// uploads are structurally untouchable. `reverted` lists the docs actually
// flipped back to Missing (empty when nothing qualifies → caller can no-op).
export function computeRevertCompliance(club, keys, requiredDocs = DEFAULT_REQUIRED_DOCS) {
  const docs = { ...club.docs };
  const docMeta = { ...(club.docMeta ?? {}) };
  const reverted = [];
  for (const k of keys) {
    const m = docMeta[k];
    const def = requiredDocs.find((d) => d.key === k);
    const multi = def ? !!def.multiFile : Array.isArray(m?.files);
    if (multi) {
      const norm = safeguardingMeta(m);
      // A booked course is a club self-declaration, not an admin override —
      // "Revert" (which undoes admin mark-compliant) must never strip it.
      if (norm.courseBooked) continue;
      const satisfied = norm.files.length >= docMinFiles(def);
      // Revertable: an explicit sentinel, OR a compliant flag the uploads don't
      // justify — legacy flag-only records (no docMeta at all) and grandfathered
      // single-file records predate the file minimum and carry no sentinel.
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
    // A booked meeting is a club self-declaration (a future meeting date), not an admin
    // override — "Revert" must never strip it. Shape-driven (not key-driven) so a
    // retired meeting-booked key keeps its declaration too.
    if (agmMeta(m).meetingBooked) continue;
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

export function overallProgress(club, requiredDocs = DEFAULT_REQUIRED_DOCS) {
  // 5 weighted phases: 20% each
  const p1 = affiliationSubmitted(club) ? 100 : club.affiliation === 'in_progress' ? 40 : 0;
  const p2 = affiliationSubmitted(club) ? 100 : 0; // fixtures phase clears once affiliation is in
  const p3 = Math.min(100, ((club.players || 0) / 60) * 100);
  const p4 = club.cqi > 60 ? 100 : club.cqi > 0 ? 50 : 0;
  const p5 = docCompletion(club, requiredDocs);
  return Math.round((p1 + p2 + p3 + p4 + p5) / 5);
}

/* ─── FIXTURE GENERATION + TRAVEL COSTS ───
   Haversine great-circle distance between two lat/lon coords (km).
   Round-robin schedule generator.
   Travel cost = round-trip distance × cars × cost per km. */
export function haversineKm(a, b) {
  // Guarded on the COORDINATES, not on the objects. `{}` is truthy, and a pending
  // knockout side resolves to `ground: {}` (resolveTeam's slot-ref branch), as does a
  // club with no ground on record — so an object check let NaN through and every
  // bracket's later rounds rendered "NaN km" and "R NaN". A missing coordinate means
  // "unknown distance", and zero is the only honest number to add to a total.
  const finite = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon);
  if (!finite(a) || !finite(b)) return 0;
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

/**
 * Travel distance and fuel cost for one fixture.
 *
 * `venue` is the ALLOCATED ground (ADR 0008 phase 2), when there is one. Without it the
 * cost is the away side's round trip to the home ground — the original model, and still
 * correct for any series that has never been through allocation.
 *
 * With it, both sides travel to wherever the match was actually placed: allocation
 * routinely moves a fixture off the home ground (maintenance, a double-booking), and
 * costing that against the home ground understates the away trip and ignores the home
 * side's entirely. A venue with no pinned coordinates falls back to the old measure
 * rather than silently costing R0 — `haversineKm` returns 0 for a missing coord, so an
 * unpinned venue would otherwise read as "no travel at all".
 *
 * `distanceKm`/`fuelR` are the COMBINED figure — right for a union's series total, wrong
 * for one club's fuel budget. `home` and `away` split it per side, so a club portal can
 * show what THAT club travels rather than the sum of both journeys.
 */
export function fixtureCost(
  homeClub,
  awayClub,
  costPerKm = DEFAULT_COST_PER_KM,
  cars = DEFAULT_CARS,
  venue?: { lat?: number; lon?: number },
) {
  const venuePinned = Number.isFinite(venue?.lat) && Number.isFinite(venue?.lon);
  // Null-safe: a fixture can reference a deleted club (lookup → undefined);
  // haversineKm already returns 0 for a missing coord, so cost degrades to R0.
  let km, homeLeg, awayLeg;
  if (venuePinned) {
    homeLeg = haversineKm(homeClub?.ground, venue);
    awayLeg = haversineKm(awayClub?.ground, venue);
    // A home-ground fixture has a zero home leg, so this reduces to the away trip and
    // matches the pre-allocation number.
    km = homeLeg + awayLeg;
  } else {
    km = haversineKm(homeClub?.ground, awayClub?.ground);
    // Without an allocated ground the match is at the home side's, so only the away
    // side travels — which is what the pre-allocation model always meant.
    homeLeg = 0;
    awayLeg = km;
  }
  const roundTripKm = km * 2;
  const fuelR = roundTripKm * cars * costPerKm;
  const leg = (oneWayKm) => {
    const legRoundTripKm = oneWayKm * 2;
    return {
      distanceKm: oneWayKm,
      roundTripKm: legRoundTripKm,
      fuelR: legRoundTripKm * cars * costPerKm,
    };
  };
  return {
    distanceKm: km,
    roundTripKm,
    cars,
    costPerKm,
    fuelR,
    venuePinned,
    /** What the HOME side travels — zero unless allocation moved the fixture. */
    home: leg(homeLeg),
    /** What the AWAY side travels. */
    away: leg(awayLeg),
  };
}

/* ─── TEAM ↔ CLUB RESOLUTION ───
   A series participant is a *team*, not a club. For a single-team club the teamId
   equals the clubId (legacy-compatible); a multi-team club uses `tm_…` ids and a
   `series.participants` snapshot. These helpers read that snapshot so fixtures keep
   resolving names/coords even after the club later edits its roster — and fall back
   to club-id semantics for legacy series that predate participants.

   PARITY: a behavioural twin lives in packages/api/src/teams.ts (used by the player
   broadcast). Keep the matching/fallback rules in sync. The shapes differ on purpose
   — this one returns `{ ground: {...} }` to feed fixtureCost; the backend returns
   flat coords to feed its schedule text — and the orphan/missing display strings
   differ by surface (staff-facing "Removed club"/"Unknown team" here vs player-facing
   "TBA" there). */

// Distinct clubs participating in a series — one portal + one notification per club,
// so this (not series.teams.length, which counts sides) is what release/broadcast copy
// should show. Legacy series have no participants: every teamId is a clubId, so the
// team count already equals the club count.
export function distinctClubCount(series) {
  const parts = series?.participants;
  if (Array.isArray(parts) && parts.length) {
    return new Set(parts.map((p) => p && p.clubId).filter(Boolean)).size;
  }
  return Array.isArray(series?.teams) ? series.teams.length : 0;
}

// The teamIds this club fields in a series. Legacy series (no participants) ⇒ [clubId].
export function teamIdsForClub(series, clubId) {
  const parts = series?.participants;
  if (Array.isArray(parts) && parts.length) {
    return parts.filter((p) => p && p.clubId === clubId).map((p) => p.teamId);
  }
  return [clubId];
}

// Resolve a fixture's home/away id → { teamId, clubId, club, name, ground }. `ground`
// carries the venue label + coords used for display and travel cost (team override
// when set, else the club ground). `clubBy(clubId)` looks up the live club.
export function resolveTeam(series, teamId, clubBy) {
  const lookup = typeof clubBy === 'function' ? clubBy : () => undefined;
  // A knockout's later rounds reference earlier fixtures ("win:f3") because the winner
  // isn't known yet. Resolve those to a readable slot label BEFORE the participant
  // lookup, which would otherwise find nothing and render "Unknown team" for every
  // fixture past round one. See competition/formats.ts for the reference format.
  const slot = slotRefLabel(teamId, series?.fixtures);
  if (slot) {
    return { teamId, clubId: undefined, club: undefined, name: slot, ground: {}, pending: true };
  }
  const parts = series?.participants;
  if (Array.isArray(parts) && parts.length) {
    const p = parts.find((x) => x && x.teamId === teamId);
    if (p) {
      const club = lookup(p.clubId);
      const g = (club && club.ground) || {};
      const lat = Number.isFinite(p.lat) ? p.lat : g.lat;
      const lon = Number.isFinite(p.lon) ? p.lon : g.lon;
      return {
        teamId,
        clubId: p.clubId,
        club,
        name: p.name || club?.name || 'Team',
        ground: { ...g, venue: p.venue || g.venue, lat, lon },
      };
    }
    // participants present but this id isn't in it — an orphaned reference.
    return { teamId, clubId: undefined, club: undefined, name: 'Unknown team', ground: {} };
  }
  // Legacy series: the teamId IS a clubId.
  const club = lookup(teamId);
  return {
    teamId,
    clubId: teamId,
    club,
    name: club?.name ?? 'Removed club',
    ground: (club && club.ground) || {},
  };
}

// Resolve whether an end date should drive scheduling. Empty/absent `dateMode`
// falls back to a format-based default: tournaments are bounded events (spread),
// series run weekly (reference). Shared by the create form and `regenerate` so
// the two paths can never interpret a stored series differently.
export function resolveSpread({ dateMode, kind }: { dateMode?: string; kind?: string } = {}) {
  return (dateMode || (kind === 'tournament' ? 'spread' : 'reference')) === 'spread';
}

/**
 * Round-robin: each team plays every other team once. Home/away alternates fairly.
 *
 * Now a thin wrapper over src/competition/fixtures.ts, which owns the pairing rotation
 * and both date strategies (ADR 0008). Behaviour is unchanged and must stay that way —
 * the create/regenerate parity test in data.test.ts is the gate.
 *
 * For a series scheduled against a season calendar, callers use `fixturesFromPlan` with
 * dates from `planRoundDates` instead; this signature stays for the legacy path.
 */
export function generateRoundRobin(
  teamIds: (string | null)[],
  startDateISO: string,
  options: { endDateISO?: string; spread?: boolean } = {},
) {
  const rounds = roundRobinPairings(teamIds);
  return fixturesFromDates(rounds, legacyRoundDates(rounds.length, startDateISO, options));
}

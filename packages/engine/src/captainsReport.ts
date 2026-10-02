/**
 * Captain's report on umpires — the shapes and pure rules shared by the API (which opens,
 * stores and serves reports) and the club portal / admin console (which fill and read them).
 *
 * The report rates the on-field umpires (five criteria, 1–5), notes areas of concern and
 * comments, and carries a captain's declaration. Misconduct reporting is NOT part of it.
 *
 * Everything here is pure: no repo, no clock (callers pass `now`), no DOM.
 */

// ───────────────────────── Form content ─────────────────────────

/** Part One guidance from the union's Captain's Report on Umpires form. */
export const RATING_GUIDE = [
  { score: 5, text: 'Accurate decisions, excellent performance, management & communication' },
  {
    score: 4,
    text: 'Some error(s) in decisions but good recovery; good management & communication',
  },
  {
    score: 3,
    text: 'Evident errors in decisions; average performance, management & communication',
  },
  {
    score: 2,
    text: 'Inaccurate decisions; below-standard performance, management & communication',
  },
  { score: 1, text: 'Poor umpiring and management; negative impact on the match environment' },
] as const;

export const RATING_CRITERIA = [
  { key: 'decisions', label: 'Correct decisions' },
  { key: 'pressure', label: 'Coping with pressure' },
  { key: 'behaviour', label: 'Management of player behaviour' },
  { key: 'communication', label: 'Player / management communication' },
  { key: 'regulations', label: 'Application of regulations' },
] as const;

export type RatingKey = (typeof RATING_CRITERIA)[number]['key'];

export const CONCERN_AREAS = [
  { key: 'lbw', label: 'LBW decisions' },
  { key: 'wkCatches', label: 'Catches by wicket-keeper' },
  { key: 'batPad', label: 'Bat / pad catches' },
  { key: 'noBallWide', label: 'No balls / wides' },
  { key: 'conditions', label: 'Ground / weather / light' },
  { key: 'other', label: 'Other' },
] as const;

/** A rating at or below this counts as "low" (the admin view's filter). */
export const LOW_RATING = 2;

/** One umpire's section of a report. `umpireId` is set whenever the umpire is a registry entry. */
export interface ReportUmpireEntry {
  umpireId?: string;
  name: string;
  /** True when a different umpire stood than the one(s) appointed. */
  substitute?: boolean;
  ratings: Partial<Record<RatingKey, number>>;
  concerns: Record<string, boolean>;
  otherConcern: string;
  comments: string;
}

export const emptyUmpireEntry = (over: Partial<ReportUmpireEntry> = {}): ReportUmpireEntry => ({
  name: '',
  ratings: {},
  concerns: {},
  otherConcern: '',
  comments: '',
  ...over,
});

/** The mean of the criteria rated so far, or null when none is. */
export function avgRating(u: Pick<ReportUmpireEntry, 'ratings'>): number | null {
  const vals = RATING_CRITERIA.map((c) => u.ratings?.[c.key]).filter(
    (v): v is number => typeof v === 'number',
  );
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

export const umpireEntryComplete = (u: ReportUmpireEntry): boolean =>
  !!u.name.trim() && RATING_CRITERIA.every((c) => typeof u.ratings?.[c.key] === 'number');

/** Any criterion rated `LOW_RATING` or below. */
export const hasLowRating = (u: Pick<ReportUmpireEntry, 'ratings'>): boolean =>
  RATING_CRITERIA.some((c) => {
    const v = u.ratings?.[c.key];
    return typeof v === 'number' && v <= LOW_RATING;
  });

// ───────────────────────── Umpire cards from the appointment ─────────────────────────

/** An appointed umpire, as snapshotted onto the report when it opened. */
export interface AppointedUmpire {
  umpireId: string;
  name: string;
}

/**
 * How the umpire cards behave for an appointment:
 *   - 'registry': nobody appointed → two cards, each a registry pick (or free text);
 *   - 'single':   one appointed   → one card, autofilled with that umpire;
 *   - 'pair':     two appointed   → two cards, each a dropdown limited to the pair.
 * Every mode keeps a "Different umpire stood" escape (registry pick or free text,
 * `substitute: true`).
 */
export type UmpireCardMode = 'registry' | 'single' | 'pair';

export function umpireCardMode(appointed: AppointedUmpire[]): UmpireCardMode {
  if (appointed.length >= 2) return 'pair';
  return appointed.length === 1 ? 'single' : 'registry';
}

/** The starting cards for a report: one per appointed umpire (prefilled), else two blanks. */
export function initialUmpireCards(appointed: AppointedUmpire[]): ReportUmpireEntry[] {
  const mode = umpireCardMode(appointed);
  if (mode === 'registry') return [emptyUmpireEntry(), emptyUmpireEntry()];
  return appointed.slice(0, 2).map((a) => emptyUmpireEntry({ umpireId: a.umpireId, name: a.name }));
}

/**
 * The appointed umpires card `index` may pick: the appointment minus any umpire another card
 * already holds, so the same umpire can't be rated twice.
 */
export function appointedChoices(
  appointed: AppointedUmpire[],
  cards: Pick<ReportUmpireEntry, 'umpireId'>[],
  index: number,
): AppointedUmpire[] {
  const taken = new Set(
    cards
      .filter((_, i) => i !== index)
      .map((c) => c.umpireId)
      .filter(Boolean) as string[],
  );
  return appointed.filter((a) => !taken.has(a.umpireId));
}

/** Pick an appointed umpire into a card (keeps nothing of the previous umpire's ratings). */
export function pickAppointed(card: ReportUmpireEntry, a: AppointedUmpire): ReportUmpireEntry {
  if (card.umpireId === a.umpireId && !card.substitute) return card;
  return emptyUmpireEntry({ umpireId: a.umpireId, name: a.name });
}

/**
 * "Different umpire stood": the card becomes a substitute. A registry umpire keeps its id;
 * a free-text name has none.
 */
export function pickSubstitute(
  card: ReportUmpireEntry,
  who: { umpireId?: string; name: string },
): ReportUmpireEntry {
  const sameUmpire = card.substitute && card.umpireId === who.umpireId && card.name === who.name;
  if (sameUmpire) return card;
  return emptyUmpireEntry({
    ...(who.umpireId ? { umpireId: who.umpireId } : {}),
    name: who.name,
    substitute: true,
  });
}

/**
 * Problems with a report as submitted, as user-facing sentences (empty ⇒ valid). The same
 * rule set runs in the browser (to enable Submit) and on the server (to accept it).
 */
export function submissionProblems(input: {
  captainName?: string;
  umpires?: ReportUmpireEntry[];
  declaration?: boolean;
}): string[] {
  const problems: string[] = [];
  if (!input.captainName?.trim()) problems.push("Enter the captain's name.");
  const umpires = input.umpires ?? [];
  if (!umpires.length) problems.push('Rate at least one umpire.');
  if (umpires.length > 2) problems.push('A report rates at most two umpires.');
  umpires.forEach((u, i) => {
    if (!u.name?.trim()) problems.push(`Name umpire ${i + 1}.`);
    for (const c of RATING_CRITERIA) {
      const v = u.ratings?.[c.key];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5)
        problems.push(`Rate umpire ${i + 1} on "${c.label}" (1–5).`);
    }
  });
  const ids = umpires.map((u) => u.umpireId).filter(Boolean);
  if (new Set(ids).size !== ids.length) problems.push('The same umpire is rated twice.');
  if (!input.declaration) problems.push('Confirm the declaration.');
  return problems;
}

// ───────────────────────── Deadline: 3rd business day, 18h00 SAST ─────────────────────────

/** The tenant clock: South Africa is UTC+2 all year (no DST). */
const SAST_OFFSET_HOURS = 2;
/** Reports are due at 18h00 local on the deadline day. */
const DEADLINE_HOUR_LOCAL = 18;
/** Business days after the match by which the report is due. */
export const REPORT_BUSINESS_DAYS = 3;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
};

/** Easter Sunday (Gregorian, anonymous algorithm) as YYYY-MM-DD. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The fixed-date public holidays (Public Holidays Act 36 of 1994), as MM-DD. */
const FIXED_HOLIDAYS = [
  '01-01', // New Year's Day
  '03-21', // Human Rights Day
  '04-27', // Freedom Day
  '05-01', // Workers' Day
  '06-16', // Youth Day
  '08-09', // National Women's Day
  '09-24', // Heritage Day
  '12-16', // Day of Reconciliation
  '12-25', // Christmas Day
  '12-26', // Day of Goodwill
];

/**
 * One-off holidays declared by the President (elections, special occasions). Add new ones
 * here as they are gazetted — a missing entry only makes a deadline a day early.
 */
export const DECLARED_HOLIDAYS: readonly string[] = [
  '2016-08-03', // local government elections
  '2019-05-08', // national elections
  '2021-11-01', // local government elections
  '2023-12-15', // Rugby World Cup celebration
  '2024-05-29', // national elections
];

/**
 * South African public holidays for a year, as a set of YYYY-MM-DD dates.
 *
 *   - the ten fixed-date holidays, Good Friday and Family Day (the Monday after Easter);
 *   - Sunday → Monday observance (s.2(1) of the Act). When that Monday is itself a holiday
 *     (25 Dec on a Sunday, 26 Dec on the Monday) the observance moves to the next free day,
 *     which is how 27 Dec 2022 was declared;
 *   - the declared one-offs above.
 */
export function saPublicHolidays(year: number): Set<string> {
  const easter = easterSunday(year);
  const base = [
    ...FIXED_HOLIDAYS.map((md) => `${year}-${md}`),
    addDays(easter, -2), // Good Friday
    addDays(easter, 1), // Family Day
  ].sort();
  const out = new Set(base);
  for (const day of base) {
    if (toDate(day).getUTCDay() !== 0) continue;
    let observed = addDays(day, 1);
    while (out.has(observed)) observed = addDays(observed, 1);
    out.add(observed);
  }
  for (const d of DECLARED_HOLIDAYS) if (d.startsWith(`${year}-`)) out.add(d);
  return out;
}

const holidayCache = new Map<number, Set<string>>();
export function isSaPublicHoliday(iso: string): boolean {
  const year = Number(iso.slice(0, 4));
  let set = holidayCache.get(year);
  if (!set) holidayCache.set(year, (set = saPublicHolidays(year)));
  return set.has(iso);
}

/** Monday–Friday and not a public holiday. */
export function isBusinessDay(iso: string): boolean {
  const dow = toDate(iso).getUTCDay();
  return dow !== 0 && dow !== 6 && !isSaPublicHoliday(iso);
}

/** The deadline DAY: the 3rd business day after the match (YYYY-MM-DD), or null. */
export function reportDeadlineDate(matchDate: string | null | undefined): string | null {
  if (!matchDate || !DATE_RE.test(matchDate)) return null;
  let day = matchDate;
  let counted = 0;
  while (counted < REPORT_BUSINESS_DAYS) {
    day = addDays(day, 1);
    if (isBusinessDay(day)) counted++;
  }
  return day;
}

/**
 * When a report is due: 18h00 SAST on the 3rd business day after the match, skipping
 * weekends and SA public holidays. Returned as an ISO instant (UTC), or null without a date.
 */
export function reportDeadline(matchDate: string | null | undefined): string | null {
  const day = reportDeadlineDate(matchDate);
  if (!day) return null;
  const hourUtc = String(DEADLINE_HOUR_LOCAL - SAST_OFFSET_HOURS).padStart(2, '0');
  return `${day}T${hourUtc}:00:00.000Z`;
}

/**
 * "Late" is DERIVED, never stored: a pending report past its deadline, or one submitted
 * after it. A void report is never late.
 */
export function isReportLate(
  r: { status: string; deadline?: string | null; submittedAt?: string | null },
  nowIso: string,
): boolean {
  if (!r.deadline || r.status === 'void') return false;
  if (r.status === 'submitted') return !!r.submittedAt && r.submittedAt > r.deadline;
  return nowIso > r.deadline;
}

// ───────────────────────── Umpire rating averages ─────────────────────────

export interface UmpireRatingSummary {
  umpireId: string;
  name: string;
  /** Reports that rated this umpire. */
  reports: number;
  /** Mean of the per-report averages, 1–5. */
  average: number;
  /** Mean per criterion. */
  byCriterion: Partial<Record<RatingKey, number>>;
  /** Reports with any criterion at or below LOW_RATING. */
  lowReports: number;
}

/**
 * Average ratings per registry umpire across SUBMITTED reports. Entries without an
 * `umpireId` (free-text substitutes) can't be attributed and are left out.
 */
export function umpireRatingAverages(
  reports: { status: string; umpires?: ReportUmpireEntry[] }[],
): Map<string, UmpireRatingSummary> {
  const acc = new Map<
    string,
    { name: string; avgs: number[]; crit: Record<string, number[]>; low: number }
  >();
  for (const r of reports) {
    if (r.status !== 'submitted') continue;
    for (const u of r.umpires ?? []) {
      if (!u.umpireId) continue;
      const avg = avgRating(u);
      if (avg == null) continue;
      const a = acc.get(u.umpireId) ?? { name: u.name, avgs: [], crit: {}, low: 0 };
      a.avgs.push(avg);
      for (const c of RATING_CRITERIA) {
        const v = u.ratings?.[c.key];
        if (typeof v === 'number') (a.crit[c.key] ??= []).push(v);
      }
      if (hasLowRating(u)) a.low++;
      acc.set(u.umpireId, a);
    }
  }
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const out = new Map<string, UmpireRatingSummary>();
  for (const [umpireId, a] of acc) {
    const byCriterion: Partial<Record<RatingKey, number>> = {};
    for (const [k, xs] of Object.entries(a.crit)) byCriterion[k as RatingKey] = mean(xs);
    out.set(umpireId, {
      umpireId,
      name: a.name,
      reports: a.avgs.length,
      average: mean(a.avgs),
      byCriterion,
      lowReports: a.low,
    });
  }
  return out;
}

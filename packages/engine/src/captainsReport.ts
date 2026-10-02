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

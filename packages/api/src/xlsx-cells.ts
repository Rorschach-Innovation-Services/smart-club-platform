/**
 * Excel cell readers shared by the workbook importers (reminder fixtures, EMCU fixtures,
 * umpire appointments). exceljs hands back a cell value as a string, number, Date, rich-text
 * object, hyperlink object or formula object; these turn it into plain text, an ISO date or
 * an HH:MM time.
 *
 * Dates and times arrive in three shapes:
 *   - a JS Date: a calendar date (year ≥ 1970, maybe with a time of day) or, for a cell
 *     formatted as a time, the 1899-12-30 epoch plus the wall clock — exceljs puts the wall
 *     clock in the UTC fields either way;
 *   - a plain number when the cell carries no date format: an Excel SERIAL (46305 =
 *     2026-10-10), whose fraction is the time of day (46305.5417 = 2026-10-10 13:00), or a
 *     bare day fraction (0.5417 = 13:00);
 *   - text: ISO / d/m/yyyy dates, "HH:MM" / "9h30" / "9.30" times.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const DAY_MS = 86_400_000;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
/** 20000 ≈ 1954, 80000 ≈ 2119: a serial outside is not a plausible fixture date. */
const SERIAL_MIN = 20000;
const SERIAL_MAX = 80000;

/** A formula cell's cached result, else the value itself. */
export const unwrapCell = (v: unknown): unknown =>
  v && typeof v === 'object' && !(v instanceof Date) && 'result' in (v as object)
    ? (v as { result: unknown }).result
    : v;

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Text of a cell, whitespace collapsed: rich text joined, formula results unwrapped,
 * hyperlink text read. A Date (or any other object) reads as ''.
 */
export function cellText(raw: unknown): string {
  const v = unwrapCell(raw);
  if (v == null || v instanceof Date) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText))
      return collapse((o.richText as Array<{ text: string }>).map((r) => r.text).join(''));
    if ('result' in o) return cellText(o.result);
    if (typeof o.text === 'string') return collapse(o.text);
    return '';
  }
  return collapse(String(v));
}

const isSerial = (v: number) => v >= SERIAL_MIN && v < SERIAL_MAX;

/**
 * A calendar date cell → ISO: a real Date (≥1970; any time of day is ignored), an Excel
 * serial (its fraction ignored), or ISO / d/m/yyyy text.
 */
export function cellDate(raw: unknown): string | undefined {
  const v = unwrapCell(raw);
  if (v instanceof Date)
    return v.getUTCFullYear() >= 1970 ? v.toISOString().slice(0, 10) : undefined;
  if (typeof v === 'number') {
    if (!isSerial(v)) return undefined;
    return new Date(EXCEL_EPOCH_MS + Math.floor(v) * DAY_MS).toISOString().slice(0, 10);
  }
  const t = cellText(v);
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const d = new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])));
    if (d.getUTCDate() === Number(dmy[1])) return d.toISOString().slice(0, 10);
  }
  return undefined;
}

/** Minutes past midnight → HH:MM. */
const hhmm = (mins: number) => `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;

export interface CellTimeOptions {
  /**
   * The umpire appointments sheet's tolerance: text may run on after the time ("13:00
   * start"), a 0 fraction reads as 00:00, and the hour/minute are not range-checked.
   */
  lenient?: boolean;
}

/**
 * A time-of-day cell → HH:MM: a 1899-epoch Date; a calendar Date (≥1970) whose time of day
 * is not midnight (a combined date+time cell); a day fraction (0.5417 = 13:00); the fraction
 * of a date serial (46305.5417 = 13:00 — the date half is `cellDate`'s); or "HH:MM" text. A
 * plain date (midnight Date, whole serial) has no time.
 */
export function cellTime(raw: unknown, opts: CellTimeOptions = {}): string | undefined {
  const v = unwrapCell(raw);
  if (v instanceof Date) {
    if (v.getUTCFullYear() < 1970) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
    const mins = Math.round((((v.getTime() % DAY_MS) + DAY_MS) % DAY_MS) / 60_000) % (24 * 60);
    return mins ? hhmm(mins) : undefined;
  }
  if (typeof v === 'number') {
    if (v > 0 && v < 1) return hhmm(Math.round(v * 24 * 60));
    if (v === 0) return opts.lenient ? '00:00' : undefined;
    if (isSerial(v)) {
      const mins = Math.round((v - Math.floor(v)) * 24 * 60) % (24 * 60);
      return mins ? hhmm(mins) : undefined;
    }
    return undefined;
  }
  const t = cellText(v);
  if (opts.lenient) {
    const m = t.match(/^(\d{1,2})[:h.](\d{2})/i);
    return m ? `${pad(Number(m[1]))}:${m[2]}` : undefined;
  }
  const m = t.match(/^(\d{1,2})[:h.](\d{2})$/i);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
  return `${pad(Number(m[1]))}:${m[2]}`;
}

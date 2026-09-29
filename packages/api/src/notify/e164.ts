/**
 * Pure phone normalisation, split out of whatsapp.ts so a caller that only needs `toE164`
 * (e.g. the import-titans-contacts CLI's plan-builder) does NOT load whatsapp.ts — whose
 * module-level `WHATSAPP_DRY_RUN` is frozen from process.env at import time. A CLI that
 * bootstraps its notify env from SST linked secrets must be able to do so BEFORE whatsapp.ts
 * loads. whatsapp.ts re-exports this, so existing importers are unchanged.
 */

/**
 * Normalize a South African cell to E.164 digits (no +). Mirrors the frontend
 * `waNumber` rule: strip non-digits, swap a leading 0 for country code 27. Returns
 * null when the result isn't a plausible 10–15 digit number so the caller can skip
 * the channel with a clear reason rather than hand Meta a bad recipient.
 */
export function toE164(cell: string | undefined | null): string | null {
  const digits = (cell || '').replace(/\D+/g, '');
  if (!digits) return null;
  let n = digits;
  if (n.startsWith('0')) n = '27' + n.slice(1);
  if (n.length < 10 || n.length > 15) return null;
  return n;
}

/**
 * The notice an admin sees when a series save added fixtures smart club can't send to Match
 * Centre as creates (PATCH /series answers `medicoachAwaitingCarry`: fixture ids now awaiting
 * a carry). null when there are none, or the tenant isn't synced (the field is absent).
 */
export function awaitingCarryNotice(res: unknown): string | null {
  const ids = (res as { medicoachAwaitingCarry?: unknown } | null | undefined)
    ?.medicoachAwaitingCarry;
  if (!Array.isArray(ids) || !ids.length) return null;
  const n = ids.length;
  return `${n} fixture${n === 1 ? '' : 's'} will need a Match Centre carry — see the connection console.`;
}

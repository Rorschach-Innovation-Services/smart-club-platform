/**
 * Shape guards for the ADR 0008 competition configuration: season calendars,
 * competition structures, and the league->competition bindings that join them.
 *
 * Extracted from index.ts so the seed CLI can run the SAME assertions the operator
 * route runs. Seeding writes tenant config through repo directly, which bypasses
 * `PUT /platform/tenants/:slug` entirely — without these, a dangling
 * structureId/calendarId/blockId would persist happily and only fail much later, at
 * fixture-generation time, with no obvious cause.
 *
 * Every function throws HttpError so the route behaviour is byte-for-byte unchanged;
 * CLI callers surface `err.message`.
 */
import dayjs from 'dayjs';
import dayjsUtc from 'dayjs/plugin/utc.js';
import dayjsCustomParseFormat from 'dayjs/plugin/customParseFormat.js';
import { HttpError } from './auth.js';
import type { CompetitionStructure, League, SeasonCalendar } from './types.js';

// Strict date-only parsing (`YYYY-MM-DD`) needs both plugins. Idempotent — dayjs
// ignores a repeat extend, so this is safe alongside index.ts doing the same.
dayjs.extend(dayjsUtc);
dayjs.extend(dayjsCustomParseFormat);

/**
 * Season-calendar shape guard (ADR 0008). Calendars drive fixture dates, so a malformed
 * one silently mis-schedules a whole league — every field is checked here rather than
 * trusted and discovered at generation time.
 *
 * Dates are strict date-only `YYYY-MM-DD`: dayjs's lenient mode would happily accept
 * '2026-02-31' and roll it into March, which is exactly the kind of quiet corruption a
 * fixture calendar must not carry. The counts are generous but finite — the CONFIG item
 * has a hard 400KB ceiling and calendars share it with leagues, knownClubs and branding.
 */
export function validateCalendars(calendars: unknown): asserts calendars is SeasonCalendar[] {
  if (!Array.isArray(calendars)) throw new HttpError(400, 'calendars must be an array');
  if (calendars.length > 20) throw new HttpError(400, 'a client is limited to 20 season calendars');

  const isDate = (v: unknown): v is string =>
    typeof v === 'string' && dayjs.utc(v, 'YYYY-MM-DD', true).isValid();

  const ids = calendars.map((cal) => (cal as SeasonCalendar | undefined)?.id);
  if (ids.some((id) => typeof id !== 'string' || !id.trim()))
    throw new HttpError(400, 'every calendar needs an id');
  if (new Set(ids).size !== ids.length) throw new HttpError(409, 'duplicate calendar id');

  for (const cal of calendars as SeasonCalendar[]) {
    const name = cal.label?.trim() || cal.id;
    if (!cal.label?.trim()) throw new HttpError(400, 'every calendar needs a label');
    if (cal.label.trim().length > 80)
      throw new HttpError(400, 'calendar labels must be 80 characters or fewer');

    if (!Array.isArray(cal.blocks) || cal.blocks.length === 0)
      throw new HttpError(400, `"${name}" needs at least one playing block`);
    if (cal.blocks.length > 20)
      throw new HttpError(400, `"${name}" is limited to 20 playing blocks`);
    const blockIds = cal.blocks.map((b): unknown => b?.id);
    if (blockIds.some((id) => typeof id !== 'string' || !id.trim()))
      throw new HttpError(400, `every block in "${name}" needs an id`);
    if (new Set(blockIds).size !== blockIds.length)
      throw new HttpError(409, `duplicate block id in "${name}"`);
    for (const b of cal.blocks) {
      if (!b.label?.trim()) throw new HttpError(400, `every block in "${name}" needs a label`);
      if (!isDate(b.start) || !isDate(b.end))
        throw new HttpError(400, `block "${b.label}" needs valid start and end dates`);
      if (b.end < b.start) throw new HttpError(400, `block "${b.label}" ends before it starts`);
    }

    if (cal.breaks !== undefined) {
      if (!Array.isArray(cal.breaks))
        throw new HttpError(400, `breaks in "${name}" must be an array`);
      if (cal.breaks.length > 50) throw new HttpError(400, `"${name}" is limited to 50 breaks`);
      for (const br of cal.breaks) {
        if (!br?.label?.trim()) throw new HttpError(400, `every break in "${name}" needs a label`);
        if (!isDate(br.start) || !isDate(br.end))
          throw new HttpError(400, `break "${br.label}" needs valid start and end dates`);
        if (br.end < br.start)
          throw new HttpError(400, `break "${br.label}" ends before it starts`);
      }
    }

    if (cal.excludeDates !== undefined) {
      if (!Array.isArray(cal.excludeDates))
        throw new HttpError(400, `excluded dates in "${name}" must be an array`);
      if (cal.excludeDates.length > 366)
        throw new HttpError(400, `"${name}" is limited to 366 excluded dates`);
      const bad = cal.excludeDates.find((v) => !isDate(v));
      if (bad !== undefined)
        throw new HttpError(400, `"${bad}" is not a valid excluded date in "${name}"`);
    }
  }
}

const FORMAT_KINDS = new Set(['round-robin', 'knockout', 'single-match', 'manual']);
const ENTRANT_KINDS = new Set(['all-registered', 'manual', 'seeded-split']);
const CADENCE_KINDS = new Set(['weekly', 'every-n-weeks', 'weekdays', 'spread']);

/**
 * Competition-structure shape guard (ADR 0008). A structure decides how a whole league's
 * fixtures are shaped, so a malformed one is worse than a rejected save.
 *
 * The load-bearing check is the LAST one: a `derivedFrom.fromStage` must name an EARLIER
 * stage. Stages form a pipeline, and a reference forwards (or to itself) is either a
 * cycle or a stage waiting on results that do not exist yet — both of which would leave
 * a season permanently unresolvable with no obvious cause.
 */
export function validateStructures(
  structures: unknown,
): asserts structures is CompetitionStructure[] {
  if (!Array.isArray(structures)) throw new HttpError(400, 'structures must be an array');
  if (structures.length > 50)
    throw new HttpError(400, 'a client is limited to 50 competition structures');

  const ids = structures.map((s) => (s as CompetitionStructure | undefined)?.id);
  if (ids.some((id) => typeof id !== 'string' || !id.trim()))
    throw new HttpError(400, 'every structure needs an id');
  if (new Set(ids).size !== ids.length) throw new HttpError(409, 'duplicate structure id');

  for (const st of structures as CompetitionStructure[]) {
    const name = st.name?.trim() || st.id;
    if (!st.name?.trim()) throw new HttpError(400, 'every structure needs a name');
    if (st.name.trim().length > 80)
      throw new HttpError(400, 'structure names must be 80 characters or fewer');
    if (!Number.isInteger(st.version) || st.version < 1)
      throw new HttpError(400, `"${name}" needs a whole version number of 1 or more`);

    if (!Array.isArray(st.stages) || st.stages.length === 0)
      throw new HttpError(400, `"${name}" needs at least one stage`);
    if (st.stages.length > 20) throw new HttpError(400, `"${name}" is limited to 20 stages`);

    const stageIds = st.stages.map((s): unknown => s?.id);
    if (stageIds.some((id) => typeof id !== 'string' || !(id as string).trim()))
      throw new HttpError(400, `every stage in "${name}" needs an id`);
    if (new Set(stageIds).size !== stageIds.length)
      throw new HttpError(409, `duplicate stage id in "${name}"`);

    const seen = new Set<string>();
    for (const stage of st.stages) {
      const sName = stage.name?.trim() || stage.id;
      if (!stage.name?.trim()) throw new HttpError(400, `every stage in "${name}" needs a name`);
      if (!stage.format || !FORMAT_KINDS.has(stage.format.kind))
        throw new HttpError(400, `stage "${sName}" has an unknown format`);
      if (stage.format.kind === 'round-robin' && ![1, 2, 3].includes(stage.format.legs))
        throw new HttpError(400, `stage "${sName}" must play 1, 2 or 3 legs`);
      if (!stage.entrants || !ENTRANT_KINDS.has(stage.entrants.kind))
        throw new HttpError(400, `stage "${sName}" has an unknown entrant rule`);
      if (!stage.schedule?.blockId?.trim())
        throw new HttpError(400, `stage "${sName}" needs a playing block`);
      const cad = stage.schedule.cadence;
      if (!cad || !CADENCE_KINDS.has(cad.kind))
        throw new HttpError(400, `stage "${sName}" has an unknown cadence`);
      // The PAYLOAD matters as much as the kind: a missing `n` renders as "every NaN
      // weeks" and places exactly one round, reported as an opaque "Block 1 fits 1 at
      // this cadence"; an out-of-range weekday passes the empty-list guard and then
      // places nothing at all.
      if (cad.kind === 'every-n-weeks' && (!Number.isInteger(cad.n) || cad.n < 1 || cad.n > 12))
        throw new HttpError(400, `stage "${sName}" needs a whole number of weeks between 1 and 12`);
      if (cad.kind === 'weekdays') {
        if (!Array.isArray(cad.days) || cad.days.length === 0)
          throw new HttpError(400, `stage "${sName}" needs at least one playing day`);
        if (cad.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
          throw new HttpError(400, `stage "${sName}" has a playing day outside 0-6`);
      }
      if (
        stage.format.kind === 'knockout' &&
        !['seeded', 'cross-pool'].includes(stage.format.pairing)
      )
        throw new HttpError(400, `stage "${sName}" has an unknown knockout pairing`);
      const plan = stage.entrants.kind !== 'all-registered' ? stage.entrants.groups : undefined;
      if (plan) {
        if (plan.kind === 'sizes') {
          if (!Array.isArray(plan.sizes) || plan.sizes.length === 0)
            throw new HttpError(400, `stage "${sName}" needs at least one group size`);
          if (plan.sizes.some((n) => !Number.isInteger(n) || n < 1))
            throw new HttpError(400, `stage "${sName}" has a group size below 1`);
        } else if (plan.kind === 'even') {
          if (!Number.isInteger(plan.count) || plan.count < 1 || plan.count > 26)
            throw new HttpError(400, `stage "${sName}" needs between 1 and 26 groups`);
        } else {
          throw new HttpError(400, `stage "${sName}" has an unknown group plan`);
        }
      }
      if (
        stage.entrants.kind === 'seeded-split' &&
        !['blocks', 'snake'].includes(stage.entrants.method)
      )
        throw new HttpError(400, `stage "${sName}" has an unknown seeding method`);

      const note = stage.entrants.kind === 'manual' ? stage.entrants.derivedFrom : undefined;
      if (note) {
        if (!note.fromStage?.trim())
          throw new HttpError(400, `stage "${sName}" derives from an unnamed stage`);
        if (!seen.has(note.fromStage))
          throw new HttpError(
            400,
            `stage "${sName}" derives from "${note.fromStage}", which does not come before it`,
          );
      }
      seen.add(stage.id);
    }
  }
}

/**
 * A league's competition bindings. Each names a structure and a calendar that must
 * actually exist on the tenant — a dangling reference is a season nobody can start, and
 * the failure would only surface later at generation time.
 */
export function validateCompetitions(
  leagues: League[],
  structures: CompetitionStructure[],
  calendars: SeasonCalendar[],
): void {
  for (const lg of leagues) {
    if (lg.competitions === undefined) continue;
    if (!Array.isArray(lg.competitions))
      throw new HttpError(400, `competitions on "${lg.label}" must be an array`);
    if (lg.competitions.length > 10)
      throw new HttpError(400, `"${lg.label}" is limited to 10 competitions`);
    const ids = lg.competitions.map((comp): unknown => comp?.id);
    if (ids.some((id) => typeof id !== 'string' || !(id as string).trim()))
      throw new HttpError(400, `every competition on "${lg.label}" needs an id`);
    if (new Set(ids).size !== ids.length)
      throw new HttpError(409, `duplicate competition id on "${lg.label}"`);
    for (const comp of lg.competitions) {
      if (!comp.label?.trim())
        throw new HttpError(400, `every competition on "${lg.label}" needs a label`);
      const structure = structures.find((st) => st.id === comp.structureId);
      if (!structure)
        throw new HttpError(
          400,
          `competition "${comp.label}" points at a structure that doesn't exist`,
        );
      const calendar = calendars.find((cal) => cal.id === comp.calendarId);
      if (!calendar)
        throw new HttpError(
          400,
          `competition "${comp.label}" points at a calendar that doesn't exist`,
        );
      // There is no UI for exclusions yet — they arrive by JSON import or a raw API call,
      // which is exactly when a shape guard earns its keep. A bare string here would be
      // iterated character by character on the client and silently drop the wrong sides.
      if (comp.excludeTeamIds !== undefined) {
        if (
          !Array.isArray(comp.excludeTeamIds) ||
          comp.excludeTeamIds.some((id): boolean => typeof id !== 'string' || !id.trim())
        )
          throw new HttpError(
            400,
            `competition "${comp.label}": excludeTeamIds must be an array of team ids`,
          );
      }
      // Structures and calendars are authored independently, so a structure's stages can
      // name blocks the bound calendar has never had. Caught here — the one place all
      // three are in scope — rather than surfacing months later as "That playing block no
      // longer exists" the first time someone tries to generate a season.
      const blockIds = new Set(calendar.blocks.map((b) => b.id));
      const orphan = structure.stages.find((stage) => !blockIds.has(stage.schedule.blockId));
      if (orphan)
        throw new HttpError(
          400,
          `competition "${comp.label}": stage "${orphan.name}" plays in a block that isn't on ${calendar.label}`,
        );
    }
  }
}

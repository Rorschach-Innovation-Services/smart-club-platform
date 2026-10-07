/**
 * Knockout "Set team" (ADR 0018): put a real team into a placeholder side (`pos:`, `win:`,
 * `lose:`, `tbd:`) of one fixture, or put the placeholder back.
 *
 * The placeholder is kept in `fixture.slots[side]` — the convention the medicoach puller
 * already uses when it fills a knockout side (puller.ts `applySlotFills`) — so a revert is
 * exact and an importer re-run still matches the fixture by `slots[side] ?? side`
 * (stable ids, risk R8). A team from outside the series ("Community Cup winner") joins the
 * series' `participants` snapshot and `teams[]`, so every display path resolves it and the
 * operator roster-overwrite guard sees the reference (risk R7).
 *
 * Pure: the route loads the series and clubs, calls this, runs the clash gate on the result
 * and writes it through the normal PATCH path.
 */
import { HttpError } from './auth.js';
import { isSlotRef, slotSource } from '../../engine/src/formats.js';
import { clubSides } from '../../engine/src/leagues.js';
import type { Club, Series } from './types.js';

export type Side = 'home' | 'away';

export interface SetSideOp {
  fixtureId: string;
  side: Side;
  /** The team to put in; `null` reverts the side to its stored placeholder. */
  teamId: string | null;
}

type Participant = NonNullable<Series['participants']>[number];

interface SlottedFixture {
  id?: string;
  home?: string;
  away?: string;
  slots?: { home?: string; away?: string };
  [key: string]: unknown;
}

/** Validate the wire shape of a `setSide` action; throws a 400 on anything else. */
export function parseSetSide(raw: unknown): SetSideOp {
  const op = raw as Record<string, unknown> | null;
  if (!op || typeof op !== 'object' || Array.isArray(op))
    throw new HttpError(400, 'setSide must be an object');
  if (typeof op.fixtureId !== 'string' || !op.fixtureId)
    throw new HttpError(400, 'setSide.fixtureId is required');
  if (op.side !== 'home' && op.side !== 'away')
    throw new HttpError(400, 'setSide.side must be "home" or "away"');
  if (op.teamId !== null && (typeof op.teamId !== 'string' || !op.teamId.trim()))
    throw new HttpError(400, 'setSide.teamId must be a team id, or null to revert');
  return {
    fixtureId: op.fixtureId,
    side: op.side,
    teamId: op.teamId === null ? null : (op.teamId as string).trim(),
  };
}

/** The participant snapshot for a team id from the tenant's clubs (any league), or null. */
export function tenantParticipant(clubs: Club[], teamId: string): Participant | null {
  for (const club of clubs) {
    const p = clubSides(club).find((s) => s.teamId === teamId);
    if (!p) continue;
    return {
      teamId: p.teamId,
      clubId: p.clubId,
      name: p.name,
      ...(p.venue ? { venue: p.venue } : {}),
      ...(Number.isFinite(p.lat) ? { lat: p.lat } : {}),
      ...(Number.isFinite(p.lon) ? { lon: p.lon } : {}),
    };
  }
  return null;
}

/** The fields a set-side writes. `setTeamAdded` lists the teams Set team brought into the
 * series (and may therefore take out again). */
export type SetSideWrite = Pick<Series, 'fixtures' | 'teams'> &
  Partial<Pick<Series, 'participants'>> & { setTeamAdded: string[] };

export interface SetSideOptions {
  /** The series is synced with medicoach: it fills `win:`/`lose:` sides itself (ADR 0016). */
  syncMapped?: boolean;
}

/**
 * The series fields a set-side writes: `fixtures`, `teams`, `setTeamAdded`, plus
 * `participants` when they change. Throws an HttpError (404 unknown fixture; 400 bad team;
 * 409 nothing to set or revert, the same team again (`no_change`), or a `win:`/`lose:` side of
 * a medicoach-synced series (`sync_owned_side`)).
 *
 * A team Set team brought in (listed in `setTeamAdded`) leaves `teams`/`participants` again
 * when a revert or a replacement leaves no fixture side or `slots` value naming it. Teams the
 * series had of its own (an importer's group union) are never removed.
 */
export function applySetSide(
  current: Series,
  op: SetSideOp,
  clubs: Club[],
  opts: SetSideOptions = {},
): SetSideWrite {
  const fixtures = (current.fixtures as SlottedFixture[]) ?? [];
  const idx = fixtures.findIndex((f) => f && f.id === op.fixtureId);
  if (idx < 0) throw new HttpError(404, `fixture ${op.fixtureId} not found`);
  const f = fixtures[idx];
  const { side } = op;
  const other: Side = side === 'home' ? 'away' : 'home';
  const stored = f.slots?.[side];
  const placeholder = stored ?? f[side];
  let teams = Array.isArray(current.teams) ? [...current.teams] : [];
  const parts = Array.isArray(current.participants) ? current.participants : undefined;
  const legacy = !parts || !parts.length;
  let participants = parts ? [...parts] : undefined;
  let added = Array.isArray(current.setTeamAdded)
    ? (current.setTeamAdded as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  if (opts.syncMapped && placeholder && slotSource(placeholder))
    throw new HttpError(
      409,
      `medicoach decides this side: the ${side} side of ${op.fixtureId} is filled by the medicoach sync from the result of the match it depends on`,
      { code: 'sync_owned_side' },
    );
  // The team the side holds now, when it was set from a placeholder (revert/replace drops it).
  const previous = stored && isSlotRef(stored) ? f[side] : undefined;
  let next: SlottedFixture;

  if (op.teamId === null) {
    if (!stored || !isSlotRef(stored))
      throw new HttpError(
        409,
        `the ${side} side of ${op.fixtureId} has no placeholder to revert to`,
      );
    const slots = { ...(f.slots ?? {}) };
    delete slots[side];
    next = { ...f, [side]: stored };
    if (Object.keys(slots).length) next.slots = slots;
    else delete next.slots;
  } else {
    const teamId = op.teamId;
    if (!placeholder || !isSlotRef(placeholder))
      throw new HttpError(
        409,
        `the ${side} side of ${op.fixtureId} is not a knockout placeholder — edit the fixture instead`,
      );
    if (isSlotRef(teamId)) throw new HttpError(400, 'setSide.teamId must be a real team');
    if (f[side] === teamId)
      throw new HttpError(409, `the ${side} side of ${op.fixtureId} is already ${teamId}`, {
        code: 'no_change',
      });
    if (f[other] === teamId) throw new HttpError(400, 'a team cannot play itself');
    if (legacy) {
      // A legacy series' sides ARE clubIds and it has no snapshot to extend; starting one
      // here would orphan every other side, so only a club can go in.
      if (!teams.includes(teamId)) {
        if (!clubs.some((c) => c.id === teamId)) throw new HttpError(400, `unknown club ${teamId}`);
        added = [...added, teamId];
      }
    } else if (!participants!.some((p) => p.teamId === teamId)) {
      const p = tenantParticipant(clubs, teamId);
      if (!p) throw new HttpError(400, `unknown team ${teamId}`);
      participants = [...participants!, p];
      if (!added.includes(teamId)) added = [...added, teamId];
    }
    if (!teams.includes(teamId)) teams.push(teamId);
    // Never overwrite a stored placeholder: re-setting a set side keeps the original.
    next = { ...f, [side]: teamId, slots: { ...(f.slots ?? {}), [side]: placeholder } };
  }
  const nextFixtures = [...fixtures];
  nextFixtures[idx] = next;
  if (previous && previous !== op.teamId && added.includes(previous)) {
    const named = nextFixtures.some(
      (x) =>
        x &&
        (x.home === previous ||
          x.away === previous ||
          x.slots?.home === previous ||
          x.slots?.away === previous),
    );
    if (!named) {
      teams = teams.filter((t) => t !== previous);
      if (participants) participants = participants.filter((p) => p.teamId !== previous);
      added = added.filter((t) => t !== previous);
    }
  }
  const participantsChanged =
    !!participants &&
    (participants.length !== (parts?.length ?? 0) || participants.some((p, i) => p !== parts![i]));
  return {
    fixtures: nextFixtures,
    teams,
    setTeamAdded: added,
    ...(participantsChanged ? { participants } : {}),
  };
}

/** The team ids a series knows: `teams[]` plus the participant snapshot. */
function knownTeams(series: Pick<Series, 'teams' | 'participants'>): Set<string> {
  return new Set<string>([
    ...(Array.isArray(series.teams) ? series.teams : []),
    ...(Array.isArray(series.participants) ? series.participants.map((p) => p?.teamId) : []),
  ]);
}

/**
 * Fixture sides that resolve to nothing: not a participant / series team, not a placeholder,
 * and not a side filled from a stored placeholder (`slots[side]`). PATCH refuses a write that
 * would ADD one (risk R7). Judged against `knownFrom`'s teams (default: the series itself), so
 * the before/after comparison uses one team set; with none known nothing can be judged and
 * nothing is returned. Returns "f3 home tm_x" lines (empty when clean).
 */
export function orphanSides(
  series: Pick<Series, 'fixtures' | 'teams' | 'participants'>,
  knownFrom: Pick<Series, 'teams' | 'participants'> = series,
): string[] {
  const known = knownTeams(knownFrom);
  if (!known.size) return [];
  const out: string[] = [];
  for (const f of (series.fixtures as SlottedFixture[]) ?? []) {
    if (!f || typeof f !== 'object') continue;
    for (const side of ['home', 'away'] as const) {
      const v = f[side];
      if (typeof v !== 'string' || !v) continue;
      if (known.has(v) || isSlotRef(v)) continue;
      const slot = f.slots?.[side];
      if (typeof slot === 'string' && isSlotRef(slot)) continue;
      out.push(`${f.id ?? '?'} ${side} ${v}`);
    }
  }
  return out;
}

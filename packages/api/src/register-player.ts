/**
 * The clearance-aware player-registration core, shared by EVERY path that puts a player on a
 * club's roster with registration semantics: the public link (`POST /register/:clubId`), the
 * chair's single in-portal form (`POST /clubs/:id/players`), the chair's quick-add grid
 * (`POST /clubs/:id/players/batch`) and the chair's spreadsheet upload
 * (`POST /clubs/:id/roster/commit`). One semantics, no drift: wherever a person is registered,
 * the same cross-club lookup decides between a plain row, a clearance from the club that
 * actually rosters them, a sourceless clearance to a declared previous club, or an off-system
 * registration review.
 *
 * Extracted from index.ts's createSelfRegistration (+ registerWithoutClearance). index.ts is the
 * Lambda entry and cannot be imported from here, so the chairman notice (notifyClearanceOpened,
 * which lives with the other notify helpers in index.ts) is injected by the caller.
 *
 * REQUIRED-FIELD CONTRACT: this core enforces only the IDENTITY minimum — first + last name, and
 * either a 13-digit RSA ID (dob derived from it) or a passport/visa number with a date of birth.
 * Every other required field is the CALLER's contract: the public link and the chair single form
 * keep their full Union set (team, district, nationality, cell, …); the bulk chair routes
 * deliberately relax it (see their route comments).
 */
import { randomUUID } from 'node:crypto';
import * as repo from './repo.js';
import { HttpError } from './auth.js';
import { hasModule } from './features.js';
import {
  playerNaturalKey,
  resolvePlayerDob,
  normalizeId,
  computeIsMinor,
} from './player-identity.js';
import type {
  Club,
  DirectoryClub,
  PlayerClearance,
  PlayerRegistration,
  TenantConfig,
} from './types.js';

const now = () => new Date().toISOString();

/** One roster row for the same identity at ANOTHER club — findPlayerAcrossClubs' row shape. */
export type CrossClubHit = Awaited<ReturnType<typeof repo.findPlayerAcrossClubs>>[number];

/** naturalKey → every club (other than the excluded destination) rostering that identity. */
export type CrossClubIndex = Map<string, CrossClubHit[]>;

/**
 * Optional pre-read tenant state for BULK callers, so a chunk of rows doesn't re-read the
 * same things per row. `crossClubIndex` (built once per request by buildCrossClubIndex) wins
 * over `clubs`; with only `clubs`, findPlayerAcrossClubs reuses the list instead of listing
 * clubs per row. Both are snapshots taken at request start — fine for the same reason the
 * operator roster intake's prefetch is: any write a stale snapshot misses still lands on a
 * conditional write (dest dedup / source status flip) and maps to an idempotent outcome.
 */
export interface RegisterPrefetch {
  clubs?: Array<{ id: string; name: string }>;
  crossClubIndex?: CrossClubIndex;
}

/** The chairman heads-up for a newly opened clearance (index.ts's notifyClearanceOpened). */
export type ClearanceOpenedNotifier = (
  tenant: string,
  tenantConfig: TenantConfig | null,
  fromClub: Club,
  clearance: PlayerClearance,
  by: string,
) => Promise<void>;

export interface RegisterPlayerOptions {
  registeredVia: NonNullable<PlayerRegistration['registeredVia']>;
  /** Stamped on the row when present (portal paths); the public link leaves it absent. */
  registeredBy?: string;
  tenantConfig: TenantConfig | null;
  /** The declared on-system or directory previous club id ('' / absent = none declared). Run
   *  the free-text "Other" value through resolveDeclaredPreviousClubId first. */
  lastClubId?: string;
  /** The raw free-text previous club ("Other"); raises an off-system review when it survives
   *  as text (no lastClubId) and isn't the '—' first-registration sentinel. */
  typedPreviousClub?: string;
  /** The club whose link/portal the registration came through (review audit). Defaults to
   *  the destination club. */
  linkClub?: { id: string; name: string };
  directory?: DirectoryClub[];
  notifyClearanceOpened: ClearanceOpenedNotifier;
  prefetch?: RegisterPrefetch;
}

/**
 * What a registration did. `duplicate` = this identity is already on the destination roster;
 * `clearance-already-open` = a transfer for this identity is already in flight (either at
 * another club, or this club's own row is still clearance-pending). Neither wrote anything.
 */
export type RegisterPlayerOutcome =
  | { outcome: 'created'; player: PlayerRegistration }
  | { outcome: 'review-opened'; player: PlayerRegistration; reviewId: string }
  | { outcome: 'clearance-opened'; player: PlayerRegistration; clearance: PlayerClearance }
  | { outcome: 'duplicate'; player: PlayerRegistration }
  | { outcome: 'clearance-already-open'; player: PlayerRegistration };

export const IDENTITY_ERROR =
  'provide a valid 13-digit RSA ID, or a passport/visa number with date of birth';

/**
 * An EXACT on-system club name typed into "Other" is the same declaration as picking that
 * club from the list, and must take the same path — resolved BEFORE anything keys on
 * lastClubId (the public route's previous==current guard and source-club cap, and the
 * clearance decision), so all see one flow. Left as free text it would register as a fresh
 * signing with no clearance AND no off-system alert (exact matches deliberately don't alert).
 * Near-name variants stay free text and alert. Returns the resolved id, or ''.
 */
export async function resolveDeclaredPreviousClubId(
  tenant: string,
  lastClubId: unknown,
  typedPreviousClub: unknown,
  clubs?: Array<{ id: string; name: string }>,
): Promise<string> {
  const picked = typeof lastClubId === 'string' ? lastClubId.trim() : '';
  if (picked) return picked;
  if (typeof typedPreviousClub !== 'string') return '';
  const typed = typedPreviousClub.trim();
  if (!typed || typed === '—') return '';
  const nameKey = typed.toLowerCase();
  const match = (clubs ?? (await repo.listClubs(tenant))).find(
    (cl) => cl.name.trim().toLowerCase() === nameKey,
  );
  return match ? match.id : '';
}

/**
 * Read every OTHER club's roster once and index it by naturalKey — the bulk callers' cross-club
 * prefetch. One paginated query per club (bounded parallelism) instead of one GetItem per
 * (row × club), which is what keeps a 50-row chunk inside the API Gateway timeout.
 */
export async function buildCrossClubIndex(
  tenant: string,
  clubs: Array<{ id: string; name: string }>,
  excludeClubId: string,
): Promise<CrossClubIndex> {
  const CONCURRENCY = 8;
  const index: CrossClubIndex = new Map();
  const others = clubs.filter((c) => c.id !== excludeClubId);
  for (let i = 0; i < others.length; i += CONCURRENCY) {
    const slice = others.slice(i, i + CONCURRENCY);
    // eslint-disable-next-line no-await-in-loop -- sequential slices, each internally parallel
    const rosters = await Promise.all(slice.map((c) => repo.listPlayers(tenant, c.id)));
    slice.forEach((c, k) => {
      for (const p of rosters[k]) {
        const hit: CrossClubHit = { clubId: c.id, clubName: c.name, status: p.status };
        const list = index.get(p.naturalKey);
        if (list) list.push(hit);
        else index.set(p.naturalKey, [hit]);
      }
    });
  }
  return index;
}

/**
 * Register one player onto `destClub`'s roster. Before creating anything it looks up where this
 * exact person is ALREADY registered across the union (by naturalKey), so a transfer routes to
 * their REAL current club — not merely the club they named — and the same person can never be
 * active at two clubs at once:
 *
 *  - Active elsewhere → the row is created 'clearance-pending' + a registration-origin clearance
 *    FROM that club (which — or the union office — must approve before the player goes active).
 *    If the named club isn't where they're actually registered, the clearance still routes to the
 *    real club, with a `note` recording the mismatch for whoever reviews it.
 *  - Mid-transfer elsewhere (already 'clearance-pending') → `clearance-already-open`, never a
 *    competing clearance.
 *  - Not registered anywhere else, named an on-system club → 'clearance-pending' row + a
 *    sourceless registration-origin clearance from that club (a club still digitising its squad
 *    is indistinguishable from one the player never played for; the clearance settles
 *    fees/misconduct either way).
 *  - Not registered anywhere else, named a DIRECTORY club → the same, flagged fromClubDirectory.
 *  - Not registered anywhere else, no previous club → a plain active row; plus a best-effort
 *    off-system registration review when a free-text previous club was typed.
 *
 * With the clearances module OFF the row always lands active, noting (never touching) any prior
 * registration elsewhere — see registerWithoutClearance.
 *
 * Throws HttpError(400) for an input below the identity minimum, or a declared previous club
 * that no longer exists; repo.DestinationClubGoneError propagates (the destination was deleted
 * mid-flight). Dedup/in-flight conflicts are OUTCOMES, never throws.
 */
export async function registerPlayerForClub(
  tenant: string,
  destClub: Club,
  input: Partial<PlayerRegistration>,
  opts: RegisterPlayerOptions,
): Promise<RegisterPlayerOutcome> {
  if (!input.firstName?.trim() || !input.lastName?.trim()) {
    throw new HttpError(400, 'firstName and lastName are required');
  }
  if (!normalizeId(input.idNumber)) throw new HttpError(400, IDENTITY_ERROR);
  const dob = resolvePlayerDob(input);
  if (!dob) throw new HttpError(400, IDENTITY_ERROR);

  const ts = now();
  const player: PlayerRegistration = {
    ...input,
    naturalKey: playerNaturalKey({ ...input, dob }),
    clubId: destClub.id,
    firstName: input.firstName,
    lastName: input.lastName,
    dob,
    isMinor: computeIsMinor(dob),
    idType: input.idType ?? 'sa-id',
    idNumber: normalizeId(input.idNumber),
    status: 'active',
    registeredVia: opts.registeredVia,
    ...(opts.registeredBy ? { registeredBy: opts.registeredBy } : {}),
    version: 0,
    consentAt: ts,
    createdAt: ts,
  };
  const lastClubId = opts.lastClubId ?? '';
  const directory = opts.directory ?? [];
  const tenantConfig = opts.tenantConfig;

  let opened: PlayerClearance | undefined;
  try {
    opened = await materialize(tenant, player, destClub, lastClubId, directory, opts);
  } catch (err: unknown) {
    if (err instanceof repo.DuplicatePendingClearanceError) {
      return { outcome: 'clearance-already-open', player };
    }
    if (
      err instanceof repo.PlayerExistsAtDestinationError ||
      (err as { name?: string }).name === 'ConditionalCheckFailedException'
    ) {
      // The destination already holds this identity. A row still clearance-pending there was
      // put by an earlier registration whose transfer is in flight (e.g. a re-committed
      // spreadsheet chunk) — report that, not a plain duplicate. One read, conflict path only.
      const existing = await repo
        .getPlayer(tenant, destClub.id, player.naturalKey)
        .catch(() => null);
      return {
        outcome: existing?.status === 'clearance-pending' ? 'clearance-already-open' : 'duplicate',
        player,
      };
    }
    throw err;
  }
  if (opened) return { outcome: 'clearance-opened', player, clearance: opened };

  // Off-system previous club: a free-text "Other" club with no on-system match, so no clearance
  // could be opened. The row is already active; flag it (best-effort) so admins see which club
  // was typed. Excludes the '—' first-registration sentinel. Registration reviews ride the
  // clearances module: with it off there is no transfer oversight, so no alert either.
  const typed = opts.typedPreviousClub?.trim();
  if (hasModule(tenantConfig, 'clearances') && !lastClubId && typed && typed !== '—') {
    const reviewId = randomUUID();
    const link = opts.linkClub ?? { id: destClub.id, name: destClub.name };
    try {
      await repo.createRegistrationReview(tenant, {
        id: reviewId,
        kind: 'off-system-alert',
        playerNaturalKey: player.naturalKey,
        playerName: `${player.firstName} ${player.lastName}`,
        idNumber: player.idNumber,
        destClubId: destClub.id,
        destClubName: destClub.name,
        linkClubId: link.id,
        linkClubName: link.name,
        typedPreviousClub: typed,
        createdAt: now(),
        status: 'open',
        version: 0,
      });
      return { outcome: 'review-opened', player, reviewId };
    } catch (err) {
      console.warn('failed to create off-system registration alert', err);
    }
  }
  return { outcome: 'created', player };
}

/** The write half of registerPlayerForClub (mutates `player`). Returns the clearance it opened. */
async function materialize(
  tenant: string,
  player: PlayerRegistration,
  destClub: Club,
  lastClubId: string,
  directory: DirectoryClub[],
  opts: RegisterPlayerOptions,
): Promise<PlayerClearance | undefined> {
  const tenantConfig = opts.tenantConfig;
  const notifyBy = opts.registeredBy ?? 'registration';
  // Re-registration at the SAME club (previous == the club being joined): record the history
  // name; there is nothing to transfer. Falls through to a plain active row (or the guards below).
  if (lastClubId && lastClubId === player.clubId) {
    player.lastClub = destClub.name;
  }

  // Where is this exact person already registered elsewhere in the union? This — not the
  // declared previous club — decides the transfer, so a wrong/duplicate/deleted pick can't
  // mis-route the clearance or leave the player active at two clubs.
  const prefetch = opts.prefetch;
  const elsewhere = prefetch?.crossClubIndex
    ? (prefetch.crossClubIndex.get(player.naturalKey) ?? []).filter(
        (h) => h.clubId !== player.clubId,
      )
    : await repo.findPlayerAcrossClubs(tenant, player.naturalKey, player.clubId, prefetch?.clubs);
  const activeSources = elsewhere.filter((e) => e.status === 'active');

  // Mid-transfer check runs FIRST, before the active-source branch: a person can be BOTH
  // clearance-pending at one club and active at another (their previous club rosters them
  // while a transfer is open, which is routine while clubs are still digitising). Letting the
  // active branch win there opens a SECOND clearance from the same source club, and both can
  // then resolve — the first deletes the source row, the second finds it already gone and,
  // being registration-origin, activates its destination anyway. That lands one person active
  // at two clubs. Refusing the registration outright is what this function documents.
  //
  // With the clearances module OFF there is no transfer to compete with, so the no-touch flow
  // runs BEFORE that guard: a row left clearance-pending when the module was switched off must
  // not 409 the player forever — it is just another prior registration (noted, never modified).
  if (!hasModule(tenantConfig, 'clearances')) {
    const priorSources = elsewhere.filter(
      (e) => e.status === 'active' || e.status === 'clearance-pending',
    );
    await registerWithoutClearance(tenant, player, lastClubId, directory, priorSources);
    return undefined;
  }

  if (elsewhere.some((e) => e.status === 'clearance-pending')) {
    // Already mid-transfer under this identity — don't open a competing clearance or a second row.
    throw new repo.DuplicatePendingClearanceError();
  }

  if (activeSources.length > 0) {
    // Route to the club they NAMED only if that's genuinely where they are; otherwise auto-route
    // to their real current club and flag the mismatch on the clearance note.
    const named = activeSources.find((s) => s.clubId === lastClubId);
    const source = named ?? activeSources[0];
    player.lastClub = source.clubName;
    let note: string | undefined;
    if (!named) {
      const namedClub = lastClubId ? await repo.getClub(tenant, lastClubId) : null;
      const namedDirectory = namedClub ? undefined : directory.find((e) => e.id === lastClubId);
      note = lastClubId
        ? namedClub
          ? `Auto-routed: player named "${namedClub.name}" as previous club, but is registered at ${source.clubName}.`
          : namedDirectory
            ? `Auto-routed: player named "${namedDirectory.name}" (not yet on the system) as previous club, but is registered at ${source.clubName}.`
            : `Auto-routed: the named previous club is not on the system; player is registered at ${source.clubName}.`
        : `Auto-routed to ${source.clubName}, where the player is registered (no previous club was named).`;
    }
    player.status = 'clearance-pending';
    const clearance: PlayerClearance = {
      id: randomUUID(),
      playerNaturalKey: player.naturalKey,
      playerName: `${player.firstName} ${player.lastName}`,
      idNumber: player.idNumber,
      team: player.team,
      fromClubId: source.clubId,
      toClubId: player.clubId,
      fromClubName: source.clubName,
      toClubName: destClub.name,
      // requestedAt feeds the admin-list gsi1 sort key — required even though no rep initiated
      // this (requestedBy stays absent; origin says who did).
      requestedAt: now(),
      origin: 'registration',
      note,
      feesCleared: false,
      misconductCleared: false,
      status: 'pending',
      clubApprovedAt: null,
      adminOverrideAt: null,
      version: 0,
    };
    await repo.createPlayerWithClearance(tenant, player, clearance);
    // Best-effort chairman heads-up (never throws). The source club record isn't loaded on
    // this branch — the cross-club lookup returns roster rows — so fetch it FRESH just for the
    // notice (never from a bulk prefetch: the notice's daily cap counts the club's live comm
    // log). A read fault only costs the notice, never the committed registration.
    const sourceClub = await repo.getClub(tenant, source.clubId).catch(() => null);
    if (sourceClub) {
      await opts.notifyClearanceOpened(tenant, tenantConfig, sourceClub, clearance, notifyBy);
    }
    return clearance;
  }

  // Not registered anywhere else, but the player DECLARED a previous club: open a pending
  // clearance to it regardless of whether that club has them on its roster here. Roster
  // absence is not evidence the transfer isn't real — a club still digitising its squad
  // looks identical to one the player never played for, and the fees/misconduct obligation
  // the clearance exists to settle is owed in the real world either way. Two source shapes,
  // both sourceless (no player row to flip):
  //   - a real ON-SYSTEM club → it approves in its own portal, or the Union office overrides;
  //   - a DIRECTORY club (operator-entered, not on the system) → flagged fromClubDirectory so
  //     the Union office can approve it or reallocate it once the club registers.
  // The real-club lookup runs FIRST so a club that claimed a directory slug between the
  // form's GET and this POST is treated as the on-system club it now is.
  if (lastClubId && lastClubId !== player.clubId) {
    const sourceClub = await repo.getClub(tenant, lastClubId);
    const dirEntry = sourceClub ? undefined : directory.find((e) => e.id === lastClubId);
    if (!sourceClub && !dirEntry) {
      // The entry vanished (operator removed/renamed it) between GET and POST. The
      // player has already uploaded an ID document at this point — guide, don't baffle.
      throw new HttpError(400, 'that previous club is no longer listed — please re-select it');
    }
    const fromClubName = sourceClub ? sourceClub.name : dirEntry!.name;
    player.status = 'clearance-pending';
    player.lastClub = fromClubName;
    const clearance: PlayerClearance = {
      id: randomUUID(),
      playerNaturalKey: player.naturalKey,
      playerName: `${player.firstName} ${player.lastName}`,
      idNumber: player.idNumber,
      team: player.team,
      fromClubId: lastClubId,
      toClubId: player.clubId,
      fromClubName,
      toClubName: destClub.name,
      requestedAt: now(),
      origin: 'registration',
      ...(sourceClub ? {} : { fromClubDirectory: true }),
      note: sourceClub
        ? `${fromClubName} has no roster record of this player. If they did play there, ${fromClubName} can approve the clearance as usual. If they did not, the Union office can reallocate it to the club they actually left — declining is deliberately not an option, since it would permanently flag a legitimately registered player.`
        : `"${fromClubName}" is not yet on the system — the Union office can approve this clearance, or reallocate it once the club registers.`,
      feesCleared: false,
      misconductCleared: false,
      status: 'pending',
      clubApprovedAt: null,
      adminOverrideAt: null,
      version: 0,
    };
    await repo.createPlayerWithSourcelessClearance(tenant, player, clearance);
    // Chairman heads-up only for an ON-SYSTEM source: a directory entry has no club
    // record and no chairman on file — the union office resolves those.
    if (sourceClub) {
      await opts.notifyClearanceOpened(tenant, tenantConfig, sourceClub, clearance, notifyBy);
    }
    return clearance;
  }
  player.status = 'active';
  await repo.createPlayer(tenant, player);
  return undefined;
}

/**
 * Registration for a tenant with the clearances module OFF (no transfer tracking): the row
 * always lands active at the joining club and no clearance, review or clearance notice is ever
 * created.
 *  - Registered at another club (active, or a clearance-pending row left over from when the
 *    module was on) → the new row carries a transferNote "Previously registered at <club>" and
 *    records that club as `lastClub`. The other club's roster is NEVER touched: the public route
 *    is unauthenticated, so letting it deactivate a row at a club the caller doesn't control
 *    would turn a leaked link + an ID number into a roster takeover. Admins resolve the duplicate.
 *  - A declared previous club with no roster record → recorded as history (`lastClub`) only.
 */
async function registerWithoutClearance(
  tenant: string,
  player: PlayerRegistration,
  lastClubId: string,
  directory: DirectoryClub[],
  priorSources: Array<{ clubId: string; clubName: string }>,
): Promise<void> {
  player.status = 'active';
  if (priorSources.length > 0) {
    player.lastClub = priorSources[0].clubName;
    player.transferNote = `Previously registered at ${priorSources.map((s) => s.clubName).join(', ')}.`;
  } else if (lastClubId && lastClubId !== player.clubId) {
    const named =
      (await repo.getClub(tenant, lastClubId))?.name ??
      directory.find((e) => e.id === lastClubId)?.name;
    if (named) player.lastClub = named;
  }
  await repo.createPlayer(tenant, player);
}

/* ─── Name source for the Captain's Report "captain's name" picker ───
 *
 * A rep can read their OWN club's players (GET /clubs/:id/players), so the captain's name
 * is suggested from real registrations. Nobody else's roster is ever offered.
 */

interface RosterPlayer {
  firstName?: string;
  lastName?: string;
}

/** The rep's own club's registered players, as name suggestions. */
export function ownRoster(_club: { id: string }, players: RosterPlayer[] = []) {
  const real = players
    .map((p) => ({ name: `${p.firstName || ''} ${p.lastName || ''}`.trim(), sub: 'Registered' }))
    .filter((p) => p.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { players: real };
}

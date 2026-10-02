/* ─── Name sources for the Captain's Report pickers ───
 *
 * A rep can read their OWN club's players (GET /clubs/:id/players) but not another
 * club's — the API is club-scoped for POPIA. So the opposition's players / coaches /
 * officials aren't reachable yet. Until a names-only roster endpoint exists, local dev
 * (VITE_LOCAL_AUTH) fills the pickers with clearly-labelled sample names so the flow
 * can be demoed; everywhere else the picker falls back to typing the name.
 */

export const SAMPLE_ROSTERS = import.meta.env?.VITE_LOCAL_AUTH === '1';

const FIRST = [
  'Sanele',
  'Kyle',
  'Ayanda',
  'Ruan',
  'Thabo',
  'Yusuf',
  'Liam',
  'Sibusiso',
  'Keegan',
  'Nkosi',
  'Dylan',
  'Ashwin',
  'Lwazi',
  'Jason',
  'Mpho',
  'Riaan',
  'Kabelo',
  'Imraan',
  'Wian',
  'Lindani',
  'Prenelan',
  'Bandile',
  'Michael',
  'Zaid',
];
const LAST = [
  'Mthembu',
  'Naidoo',
  'Dlamini',
  'van Wyk',
  'Pillay',
  'Khumalo',
  'Govender',
  'Botha',
  'Ndlovu',
  'Moodley',
  'Zulu',
  'Pretorius',
  'Cele',
  'Maharaj',
  'Shezi',
  'Smith',
  'Ngcobo',
  'Reddy',
  'Mkhize',
  'Coetzee',
];

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

// Deterministic per club, so the same opposition always shows the same names.
export function sampleRoster(seed) {
  let h = hash(seed);
  const used = new Set();
  const next = () => {
    for (;;) {
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
      const name = `${FIRST[h % FIRST.length]} ${LAST[(h >>> 8) % LAST.length]}`;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
  };
  const many = (n, sub) => Array.from({ length: n }, () => ({ name: next(), sub }));
  return {
    sample: true,
    players: many(14, '1st XI').sort((a, b) => a.name.localeCompare(b.name)),
    coaches: [...many(1, 'Head coach'), ...many(1, 'Assistant coach')],
    officials: [...many(1, 'Team manager'), ...many(1, 'Chair'), ...many(1, 'Scorer')],
  };
}

/** The rep's own club — real registrations when present, sample names in local dev. */
export function ownRoster(club, players = []) {
  const real = players
    .map((p) => ({ name: `${p.firstName || ''} ${p.lastName || ''}`.trim(), sub: 'Registered' }))
    .filter((p) => p.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (real.length || !SAMPLE_ROSTERS) return { sample: false, players: real };
  return { sample: true, players: sampleRoster(club.id).players };
}

/** The opposition — only sample names until a names-only endpoint exists. */
export function oppositionRoster(clubId) {
  return SAMPLE_ROSTERS && clubId ? sampleRoster(clubId) : null;
}

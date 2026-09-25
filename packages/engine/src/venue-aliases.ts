/**
 * Ground-name aliases shipped in code (ADR 0014).
 *
 * Keys and values are both in `normaliseName` form (packages/api/src/venue-clash.ts):
 * lowercase, punctuation stripped, generic words such as "cricket" and "club" dropped. The
 * API's clash gates merge a tenant's own `competitionDefaults.venueAliases` over this map.
 * Every entry is a dolphins spelling; `packages/api/scripts/backfill-venue-aliases.ts` copies
 * the map into the dolphins config, after which a follow-up can empty it here.
 */

/** Ground-name variants that don't normalise onto the venue registry's own name —
 * union sheet spellings on one side, club-record spellings on the other. Values are
 * the normalised form of real dolphins registry venue names. */
export const DEFAULT_VENUE_ALIASES: Record<string, string> = {
  acc1: 'toti1', // "ACC 1" (REVISED) = Amanzimtoti's Toti 1
  // Exact-field numbering (union, 31 Aug 2026): the registry rows and club records are now
  // named by exact field number ("Siripat 1", "Crusaders 1", "Danville 1", "Harlequins 1"…),
  // so every OLD spelling aliases FORWARD onto the numbered canonical form.
  siripatroadgrounds: 'siripat1', // was "Siripat Road Grounds"
  siripatgrounds: 'siripat2', // was "Siripat Grounds"
  crawfordnc: 'crawfordnorthcoast', // Railways
  laheepark: 'laheeparkoval', // PTCC's pinned "Lahee park cricket oval"
  tills: 'tillscrescentground', // Delta
  hammond: 'hammondoval', // UKZN's "Hammond Cricket Oval"
  danville: 'danville1', // was "Danville"
  vanriebekparkharlequins1: 'harlequins1', // was "Van Riebek Park (Harlequins 1)"
  vanriebekparkharlequins2: 'harlequins2', // was "Van Riebek Park (Harlequins 2)"
  crusaderssports: 'crusaders1', // was "Crusaders Sports Club"
  crusaders2field: 'crusaders2', // was "Crusaders 2 Field"
  catormanor: 'catomanor1', // typo generic "Cator Manor" → merged into Cato Manor 1
  catomanor: 'catomanor1', // generic "Cato Manor" → merged into Cato Manor 1
  harlequins: 'harlequins1', // generic "Harlequins" → merged into Harlequins 1
  highburygrounds: 'highbury1', // generic "Highbury grounds" → merged into Highbury 1
  foresthills: 'foresthillssports', // "Forest Hills CC" → "Forest Hills Sports Club"
  phoenixstonebridge: 'stonebridge', // East Coast / Phoenix / Parkgate
  penguinstreet: 'penguinstreetground', // Meadowridge's "PENGUIN STREET GROUND"
  // From the union's "facility updated" permitted-fields sheet (17 Aug 2026).
  dhubriroad: 'dhubriroadgrounds',
  hammondukzn: 'hammondoval', // "Hammond (UKZN)"
  laheepark1: 'laheeparkoval',
  penguinstreetchatsworth: 'penguinstreetground', // "Penguin Street (Chatsworth)"
  phoenixsydmore: 'sidmore', // East Coast's "Sidmore" = the facility list's "Phoenix Sydmore"
  totioval: 'toti1', // "Toti Oval"
  gledhowgrounds: 'gledhowground', // Ilembe's club-record spelling of Dawnheights' "Gledhow Cricket Ground" — one shared field (union, 31 Aug 2026)
  chatsworthpenguingrounds: 'penguinstreetground', // Saints' club-record "Chatsworth, Penguin Grounds" = the registry's "PENGUIN STREET GROUND" (KCCD's re-base) — one field, one ledger row
  // 2026-27 Release workbook spellings (single-file union release) → the numbered
  // registry canonical forms. Each key is the release sheet's own spelling, normalised.
  gledhow: 'gledhowground', // release "Gledhow" = the registry's "Gledhow Cricket Ground" (Dawnheights/Ilembe's shared field)
  totioval1: 'toti1', // release "Toti Oval 1" = Amanzimtoti's "Toti 1"
  totioval2: 'toti2', // release "Toti Oval 2" = Amanzimtoti's "Toti 2"
  commons1wbhs: 'commons1', // release "Commons 1 [WBHS]" = the registry's "Commons 1"
  commons2wbhs: 'commons2', // release "Commons 2 [WBHS]" = the registry's "Commons 2"
  mpumalanga: 'mpumalangatownshipstadium', // release "Mpumalanga" = West CC's "Mpumalanga Township Cricket Stadium"
  kloofcountry: 'kloof', // release "Kloof Country Club" = the registry's "Kloof CC" (reinstated Sep 2026)
};

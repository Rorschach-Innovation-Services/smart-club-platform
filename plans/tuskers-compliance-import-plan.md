# Tuskers compliance import — plan

One-time import of the KZN Inland Cricket Union ("Tuskers") pack into a new `tuskers`
tenant: 8 clubs + their compliance documents. Mirrors the Titans import
(`import-titans-compliance.ts` + `titans-import-map.ts` + ADR 0009 catalogue), with two
structural differences: **no league-structure workbook** (so no `--structure` /
`--with-teams` phases at all), and a **different doc taxonomy** (below), derived from
reading every one of the 165 files in `/Users/carlton/Downloads/Tuskers`.

Every file in the pack was text-extracted and read (or, for images/scans, visually
inspected) before this plan was written; the classification table below is
content-verified, not filename-guessed.

## Union / tenant facts

- Union: KwaZulu-Natal Inland Cricket Union NPC ("KZNICU", reg 2022/599317/08), brand
  **Tuskers** (elephant logo), Pietermaritzburg Oval.
- Tenant id: `tuskers`. District for all 8 clubs: `Umgungundlovu` (every club's District
  Teams form says so; Greytown's form has one line reading "Uthukela" but its MCA line
  and geography say Umgungundlovu — flag in the runbook, import as Umgungundlovu).
- Audit marker: `import:tuskers-compliance-2026`. Manifest:
  `./tuskers-import-created-clubs.json` (gitignore it, plus
  `tuskers-import-backup-*.json`).

## The 8 clubs (CLUB_MAP)

| folder (exact)            | canonical name (from their own docs) | notes                                                           |
| ------------------------- | ------------------------------------ | --------------------------------------------------------------- |
| `Young Natalians CC Club` | Young Natalians Cricket Club         | union account YOUNGCC                                           |
| `Howick CC Club`          | Howick Cricket Club                  |                                                                 |
| `Standard CC Club`        | Standard Cricket Club                | est. 1886, plays at Collegians                                  |
| `Masibemunye CC Club`     | Masibemunye Cricket Club             | Imbali Hub; no constitution, no logo in pack                    |
| `Greytown CC Club`        | Greytown Cricket Club                | form declares "Have a Club Constitution: NO"                    |
| `UKZN CC Club`            | UKZN Cricket Club                    | union bills it as "Varsity CC" (INU000150) — same club          |
| `MCC Club`                | Maritzburg Cricket Club              | est. 1884; folder says "MCC"                                    |
| `Lancashire CC Club`      | Lancashire Cricket Club              | NPO constitution; sponsored style "Hollywoodbets Lancashire CC" |

Ids via `clubIdFromName(name)` as always (never hand-typed).

## Tuskers requiredDocs catalogue (add to `CATALOGUES` in `configure-tenant-docs.ts`)

`OFFICE = pdf/doc/docx`; `SHEET = OFFICE + xls/xlsx/ods`; new format additions below.

| key                   | name                                                      | shape                                             | accepts                      | notes                                                                                                                                           |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `constitution`        | Club constitution                                         | single                                            | OFFICE                       | mostly scanned PDFs; Greytown/Masi have none → stays outstanding (correct signal)                                                               |
| `agmMinutes`          | AGM minutes                                               | multiFile, min 1, max 6                           | OFFICE + **odt**             | clubs supplied 2–3 years each; Howick's is .odt                                                                                                 |
| `financials`          | Financial statements                                      | multiFile, min 1, max 6, allowUnavailable         | OFFICE                       | LCC has 2 years of treasurer reports; some clubs only have it embedded in AGM minutes                                                           |
| `affiliationForm`     | District affiliation form                                 | multiFile, min 1, max 4                           | SHEET                        | the KZNICU "District Teams" registration workbook; year variants both kept                                                                      |
| `affiliationFees`     | Affiliation fees (invoice / statement / proof of payment) | multiFile, min 1, max 8, allowUnavailable         | pdf + SHEET + **jpg/png**    | Standard's POP is a phone photo (.jpg)                                                                                                          |
| `nominalRoll`         | Nominal roll (player register)                            | multiFile, min 1, max 4, `role: 'memberDatabase'` | SHEET                        | 2–3 workbooks per club; Standard's CSA team return also lands here                                                                              |
| `clubLogo`            | Club logo                                                 | single, allowUnavailable                          | **jpg/png**                  | Masi + Greytown + YN have none                                                                                                                  |
| `facilityAgreement`   | Facility agreement / SLA                                  | multiFile, min 1, max 6, allowUnavailable         | OFFICE + **jpg/png**         | MCC Lynwood + Linpark letters, UKZN SLA letters, Howick facility code-of-conduct                                                                |
| `disciplinaryRecords` | Disciplinary records                                      | multiFile, min 1, max 15, allowUnavailable        | OFFICE + **jpg/png**         | DC notices/outcomes, incident + umpire reports, arbitration, unregistered-player notices; Standard/UKZN have ~8–10 each after dedupe            |
| `unionCorrespondence` | Union correspondence                                      | multiFile, min 1, max 10, allowUnavailable        | OFFICE + SHEET               | KZN Inland letters (Clause 18.1 notices, sanction letters, affiliation confirmations, thank-you), the union's multi-club verification workbooks |
| `playerRegistrations` | Player registrations & clearances                         | multiFile, min 1, max 8, allowUnavailable         | pdf + **jpg/png**            | individual KZNICU registration forms + clearance scans; PII-heavy (full RSA IDs)                                                                |
| `clubRecords`         | Other club records                                        | multiFile, min 1, max 8, allowUnavailable         | OFFICE + SHEET + **jpg/png** | funding docs, transport claims, coaching staff list, safeguarding-training screenshot, women's-trial scan, unidentifiable SKM scan              |

**Platform precondition — new accepted formats.** `DOC_FORMAT_MIME` in `catalogue.ts`
currently maps pdf/doc/docx/xls/xlsx/ods only. Add `odt`
(`application/vnd.oasis.opendocument.text`), `jpg`/`jpeg` (`image/jpeg`), `png`
(`image/png`). Trace every consumer of `DOC_FORMAT_MIME`/the accepts type (presign
route validation, operator required-docs card accepts editor, doc viewer) and extend
type unions/tests accordingly. Images render natively in browsers, so no viewer work
should be needed beyond allowing the type — verify, don't assume.

## Import CLI

New `packages/api/src/import-tuskers-compliance.ts` + `tuskers-import-map.ts`,
copy-and-trim of the Titans pair (the planb→titans lineage precedent — do NOT refactor
the shared core as part of this):

- Drop everything structure/teams-related: `--structure`, `--with-teams`,
  `--add-missing-leagues`, `parseStructureWorkbook`, `summarizeByClub`,
  `SECTION_LEAGUE_MAP`, `EXTRA_LEAGUES`, `KNOWN_STRUCTURE_ANOMALIES`, team-plan
  building. `buildClub` takes no summary: `leagues: []`, `teams/women/juniors` from
  `deriveTeamPlanCounts({})`, `ground: {}` (no venue source), `district: 'Umgungundlovu'`.
- Keep, verbatim in behaviour: fail-closed parse phase, dedupeGroup (content-hash),
  FILE_OVERRIDES, catalogue coverage + MIME validation, merge-never-clobber doc
  uploads, single-audit-note, content-addressed keys
  (`tuskers/${clubId}/${docKey}-import-…`), created-clubs manifest
  (write-before-create), revert semantics incl. `revertManifestGate`, backup file.
- **One extension**: `FILE_OVERRIDES` values may be `'skip'`, a docKey string, or
  `{ club: '<clubId>', docKey: '<key>' }` — a club reassignment for the three misfiled
  files (below). classifyAll resolves the club from the folder unless an override
  reassigns it.
- npm script `import-tuskers-compliance` in `packages/api/package.json` (mirror the
  titans entry).

## Classification spec (content-verified)

DOC_RULES, first match wins (tune while iterating `--parse-only` against the real pack
— zero unclassified files is the exit criterion, fail-closed as ever):

1. `/nominal\s*roll|team\s*return/i` → `nominalRoll`
2. `/affiliation\s*form|district\s*teams|verification/i` → `affiliationForm` — **but**
   the two union "Inland Club & District Verification" workbooks (MCC + LCC folders) are
   union-side checklists → override to `unionCorrespondence`
3. `/affiliation\s*fee|statement|proof.?of.?payment|payment/i` → `affiliationFees`
4. `/consti/i` → `constitution` (covers "Signed NPO Consti LCC")
5. `/agm|annual\s*general|minute/i` → `agmMinutes`
6. `/financ|treasurer|income|balance\s*sheet/i` → `financials`
7. `/logo/i` → `clubLogo`
8. `/clearance|registration|\breg\b/i` → `playerRegistrations`
9. `/\bdc\b|disciplinar|incident|umpire|arbitration|unregistered/i` → `disciplinaryRecords`
10. `/\bsla\b/i` → `facilityAgreement`
11. `/funding|funds|transport\s*claim|coaching\s*staff|trial|training/i` → `clubRecords`
12. `/kzn\s*inland\s*letter|inland\s*letter|thank\s*you|kzn\s*cricket/i` → `unionCorrespondence`

Rule-order caveats found while reading: "Affiliation Letter Masibemunye CC" is union
correspondence, not fees/form (needs override or rule tuning); "Greytown Affiliation
fees payment.pdf" and "…Fee Payment Notification.pdf" are byte-identical content (same
FNB trace id) — if not byte-identical files, skip one via override; DC letters that
start "KZN Inland Letter …" must hit the disciplinary rule only if genuinely DC —
sanction letters (unregistered players, Clause 18.1/19.2) go to `unionCorrespondence`
per the table below. When rules fight, prefer an exact-path FILE_OVERRIDE with a
one-line reason (Titans convention) over a cleverer regex.

### FILE_OVERRIDES that MUST exist (reviewed decisions, with reasons)

Skips:

- `MCC Club/virat-kohli-4k-ap-1920x1080.jpg` — downloaded wallpaper, not a document.
- `MCC Club/Lynwood Club.jpg` — the VENUE's logo, not MCC's (MCC's own is `MCC logo.jpg`).
- `Standard CC Club/Appeals Letter Standard CC.docx` — misnamed: a KZNICU letter about
  returning a cricket roller to Carter High School; belongs to no club in this pack.
- `Greytown CC Club/Greytown CC DC Inquiry 2026.docx` — despite the name, a BLANK
  meeting sign-in register template (the `.pdf` of the same stem is the real DC summons
  and imports normally).
- Every `.docx` half of a docx+pdf pair of the same letter (pdf canonical — the signed/
  rendered form). Pairs found: Howick DC Letter, Howick Unregistered Players, Howick
  letter 24 nov 2025 (≙ `Howick CC Letter 2025.pdf`), Standard KZN Inland 14 March
  2024, Standard Regional Final 2024 (≙ Franchise Final pdf), Standard DC 19-Feb notice
  (`Standard DC Letter Chad Potgieter.docx` AND `Standard DC letter Chad Potgieter
2024.docx` are the same notice; the `.pdf` sibling is a re-scheduled variant — keep
  pdf(s)), Standard DC 21-Feb notice docx, Masi Affiliation Letter docx, Masi KZN
  Inland 07 March docx, Masi Revised Funding docx, UKZN DC letter Ashok Bharath docx,
  UKZN DC Letter Ashok.docx (28-Feb outcome; the 29-Feb pdf is the fuller final), UKZN
  Letter 02 Dec 25 docx, UKZN DC Letter 2025.docx (≙ `UKZN Letter 07 Dec 25.pdf`),
  UKZN Thank You letter docx, MCC KZN Inland 15 Feb docx, MCC KZN Inland 06 March docx,
  MCC DC letter Shaun Truter docx, Greytown KZN Inland 26 Feb docx. Verify each pair's
  content before skipping (the readers' reports flagged same-stem-different-content
  traps); anything byte-identical dedupes automatically and needs no override.

Reassignments (the `{club, docKey}` extension):

- `MCC Club/asanda.jpg` → `{ club: masibemunye-cricket-club, docKey: playerRegistrations }`
  — it's Asanda Khumalo's (Masibemunye) registration form, misfiled in MCC's folder.
- `Standard CC Club/KZN Inland Letter Lancashire Ground Booking 26 March 2024.pdf` →
  `{ club: lancashire-cricket-club, docKey: unionCorrespondence }` — addressed to
  Lancashire's chairman (Michael Patricks Oval usage), misfiled in Standard's folder.

Forced docKeys (regexes won't catch these):

- `MCC Club/D Fynn.pdf` → `playerRegistrations` (scanned registration form, no keyword).
- `UKZN CC Club/Cian Fortman .jpg` → `playerRegistrations` (photo of a filled
  registration/clearance form — full RSA ID, PII; note trailing space in filename).
- `MCC Club/Michael king Reg.pdf` → `playerRegistrations` (check `\breg\b` catches it;
  override if not).
- `UKZN CC Club/LETTER TO YOGESH J - 11 JAN 2024.pdf` → `facilityAgreement` (headed
  "SERVICE LEVEL AGREEMENT", Peter Booysen Ovals confirmation).
- `MCC Club/MCC letter 2024.pdf` + `MCC Club/SLA Doc MCC.pdf` → `facilityAgreement` —
  byte-identical (dedupe collapses them); `MCC SLA.pdf` is a DIFFERENT letter (Lynwood
  vs Linpark), also `facilityAgreement`.
- `Howick CC Club/Howick Cricket Club Code of Conduct.pdf` → `facilityAgreement`
  (it's a facility-use code for Howick High School's ground, not a member CoC).
- `Howick CC Club/KZN CRICKET - ARBITRATION - REPORT.pdf` → `disciplinaryRecords`
  (Howick/Masi arbitration outcome; lives under Howick, where the union filed it).
- `Standard CC Club/Standard Womens Trial.pdf` → `clubRecords` (scanned trial notice).
- `Masibemunye CC Club/SKM_C30824080810300.pdf` → `clubRecords` (scanner-default name,
  image-only, content unidentifiable — note in runbook to ask the club what it is).
- `MCC Club/Screenshot 2024-04-08 083019 - Kurt Mannikam.png` → `clubRecords`
  (safeguarding-training progress screenshot).
- `Standard CC Club/umpires report Standard vs Masi 2024.jpg` → `disciplinaryRecords`
  (photo of handwritten umpire report — check rule 9 catches "umpires"; override if not).
- `MCC Club/District Teams Affiliation Form - 2024_25 …(1) MCC.xlsx` — same content as
  the "2024 Season" one and openpyxl's read_only mode choked on it; if exceljs also
  fails to open it, skip with that reason, else let it import (multiFile key).

Known content facts to encode as comments (they justify the overrides): AGM filename
years lie (YN "AGM 2025.docx" holds 24 Jun 2026 minutes; Howick "AGM 2023.odt" holds 12
Jun 2024 minutes) — never derive anything from filename years.

## Phase 2 (approved 24 Sep 2026): roster import — `import-tuskers-roster.ts`

User directive: wherever a nominal roll carries ENOUGH identity information, its players
must be created on the platform for that club **and team**. Mirrors
`import-titans-roster.ts`'s shell (parse-only / dry-run / confirm / revert, PII masking,
fail-closed cross-club duplicate exclusion via `findCrossClubDuplicates`,
`reconcilePlayerCount` per touched club, `registeredBy = 'import:tuskers-compliance-2026'`)
but the parsing layer is tuskers-specific: these workbooks are NOT the union template
Titans used, and the TEAM comes from the SHEET NAME, not an age-group column.

### Importable vs skipped (content-verified)

`SKIP_ROSTER` (documented, reported, never silent): **Young Natalians, Masibemunye,
Greytown, UKZN** — their rolls carry no ID and no DOB column at all (name+gender+race
only); `PlayerRegistration.dob` is required and `playerNaturalKey` needs an ID or
name+DOB, so no player is buildable. Their compliance DOCUMENTS import normally; report
these four to the union for proper roster exports.

Importable, via a per-club `ROSTER_SOURCES` config in `tuskers-import-map.ts` —
`{ clubId, file (exact rel path), sheets: [{ name, leagueKey | null, colMap }] }`:

1. **MCC** — `MCC Club/Maritzburg CC Nominal Roll.xlsx` ONLY (the `(9)` variant and the
   sparse 2024 template overlap it — skip both as roster sources, with reasons). Union
   template, header row 3, offset one column (`Name:`/`Surname:`/`Race:`/`Gender:`/
   `Age:`/`IDNumber:`/`DOB:`/…). Sheets: PREM→`premier-league` (IDs+DOB; ~11 trailing
   name-only rows become exceptions), VETERANS→`veterans-league` (IDs), UMG DIV
   2→`div-2`, UMG DIV 3→`div-3` (IDs; DIV 1 is header-only), U9/U11/U13/U15→`u9…u15`
   (DOB-only → written only under `--allow-missing-id`), WOMEN→`womens-league`
   (name-only header variant — all rows exception out; parsed + reported).
   Known ID mangling (values not reproduced here — PII): leading-zero-lost 12-digit
   cells, apostrophe-quoted text cells, digit groups separated by spaces, and one value
   padded with a fake all-zeros tail — `cleanIdCell` + Luhn decides; never hand-fix.
2. **Lancashire** — `Lancashire CC Club/Lancashire CC Nominal Roll.xlsx`. CSA-export
   header row 1: `Name|Surname|PlayerType|BattingHand|BowlingHand|BowlingAction|Gender|
Race|Team|BirthDate|Status` (+`ServerPlayerID|Organisation|Region` on junior sheets).
   **The `BirthDate` column holds identity values, NOT dates**: 13-digit RSA IDs
   (→ id-based row), a couple of 8-digit `yyyymmdd` dates (→ dob-only rows, need
   `--allow-missing-id`), Zimbabwean national IDs (`NN-NNNNNNNaNN` shape; no DOB
   derivable → exception reason `foreign-id-no-dob`, reported, never written), and
   blanks (→ exception).
   `Status` filter: import `Active` and blank (report the blank count); exclude
   `NOT`/"Left Group" rows, reported. Sheets: `Premier League 2023`→`premier-league`,
   `U9…U16`→`u9…u16`, `Vets`→`veterans-league`, `Women`→`womens-league` (reduced no-ID
   header — exceptions), **`3rds`/`4ths`→`null`**: team ordinals, not league names —
   parse + report, import those players with NO team rather than guessing a division
   (runbook: union to confirm where 3rds/4ths play).
3. **Standard** — TWO sources: `Standard CC Club/Standard CC Nominal Roll.xlsx` (union
   template; PREM→`premier-league`, UMG DIV 1→`div-1`, UMG DIV 2→`div-2` carry IDs;
   VETERANS→`veterans-league`, U-sheets, WOMEN as per MCC) and
   `Standard CC Club/Standard CSA Generic Team Return Form 2025_26-1.xlsx` (sheet
   `202526`, header `ID No.|First Name|Surname|…|D.O.B.|School or Hub/RPC|Race|Gender`,
   19 fully-identified players → `premier-league`, and the FIRST-listed source so its
   fresher identities win the intra-club dedupe). One known intra-sheet duplicate
   (Lourens Erasmus twice on UMG DIV 2).
4. **Howick** — `Howick CC Club/Howick CC Nominal Roll.xlsx`. Only UMG DIV 1/2/3 carry
   IDs (→`div-1`/`div-2`/`div-3`), and they are ~the same 14 players repeated across all
   three sheets — intra-club dedupe by naturalKey is what makes this importable at all.
   Several 14-digit leading-zero-corrupted IDs exception out as `bad-id`; the same
   players appear with valid 13-digit IDs on DIV 2, which dedupe keeps. PREM/WOMEN/
   VETERANS/U9–U15 are name-only → exceptions (reported).

### Parsing approach

Do NOT force these through `parseRosterSheet` (its header detection targets the Titans
union template). Build a thin tuskers parser driven by each source's `colMap`
(explicit header-cell → field mapping, asserted against the real header row — abort if
the header drifts), REUSING the pure cell-level helpers from `roster-normalize.ts`
(`cleanIdCell`, `cellDobIso`, `normalizeGender`, `normalizeRace`, `splitFullName`,
`collapseWhitespace`) and `player-identity.ts` (`playerNaturalKey`, `dobFromSaId`,
`computeIsMinor`) so identity/dedup semantics can never drift from the platform's.
Exception reasons reuse the Titans vocabulary (`bad-id`, `bad-id-checksum`,
`no-usable-identity`, `missing-surname`) plus `foreign-id-no-dob` and
`excluded-status`. All ID printing via `maskId`.

### Team & league placement

- `player.team` = the sheet's mapped league key. A player appearing on MULTIPLE sheets
  (Howick's DIV1/2/3, Standard roll vs CSA return): the first occurrence in
  `ROSTER_SOURCES`/sheet order wins (sources ordered senior-competition-first); every
  further appearance is deduped and REPORTED (`also on: …`), never a second player row.
- **Tenant leagues gate** (the titans `ensureLeaguesConfigured` pattern): the tenant has
  ZERO leagues configured today. Define `TUSKERS_LEAGUES` in the map file —
  `premier-league`, `div-1`, `div-2`, `div-3`, `womens-league`, `veterans-league`, `u9`,
  `u11`, `u13`, `u15`, `u16` — with labels + a single group, mirroring the EXTRA_LEAGUES
  shape. Dry-run prints which referenced keys are missing; `--confirm
--add-missing-leagues` appends exactly the referenced-and-missing ones (idempotent);
  a referenced key NOT in `TUSKERS_LEAGUES` aborts. Keys never referenced by a written
  row are not appended.
- After confirm, union each touched club's `leagues[]` with the league keys its written
  players landed in (merge, never remove — the dolphins "Insights zero because
  club.leagues was never set" lesson), via `repo.updateClub` with the import actor.

### CLI

`packages/api/src/import-tuskers-roster.ts`, npm script `import-tuskers-roster`. Flags:
`--dir`, `--parse-only`, `--confirm`, `--club <id>`, `--allow-missing-id`,
`--add-missing-leagues`, `--revert [--confirm]`. Revert deletes players whose
`registeredBy === 'import:tuskers-compliance-2026'` then reconciles counts (run before
a compliance `--revert` when reverting everything). Runs AFTER the compliance import
(createPlayer needs the club rows).

### Tests

Real-file classification is impractical to embed (PII), so: unit-test the colMap header
assertion, the sheet→league mapping table, Lancashire's BirthDate trichotomy
(id / 8-digit dob / Zim id / blank), status filtering, intra-club naturalKey dedupe
(first-source-wins + report), the multi-sheet Howick collapse, `SKIP_ROSTER` coverage of
exactly the four no-identity clubs, and TUSKERS_LEAGUES gating. Use synthetic rows.
Acceptance: `--parse-only` against the real pack prints per-club valid/exception
counts consistent with the measured data (MCC largest; Howick ~14 distinct after
dedupe; Standard CSA 19 + roll seniors; Lancashire seniors+juniors minus Women/status
exclusions) — paste the table in the report.

## Deliberately OUT of scope

- Venue/ground seeding, league/team plans beyond the league keys above (no structure
  workbook exists; divisions/pools are season-wizard work).
- Tenant creation itself: the import aborts if `tuskers` has no TenantConfig; standing
  the tenant up (operator portal / existing bootstrap path) is a runbook prerequisite,
  not part of this CLI.

## Tests

Mirror `test/import-titans.test.ts`'s approach against the NEW map file:

- classifier: embed the real 165 relative paths (generate from the pack listing) and
  assert zero unclassified, zero unmapped folders, and the exact override outcomes above
  (spot-check the reassignments and the Greytown docx/pdf split).
- catalogue coverage: `TUSKERS_DOC_KEYS` ⊆ tuskers catalogue keys;
  `catalogueCoverageProblems`-equivalent both directions for the multiFile set.
- `DOC_FORMAT_MIME` additions: jpg/jpeg/png/odt resolve; presign-route accept logic
  passes for an image on a key that accepts it and still rejects one that doesn't.
- The `{club, docKey}` override extension: unit-test classifyAll's reassignment.

## Runbook

`docs/runbooks/tuskers-compliance-import.md`, patterned on the Titans one, minus
structure/teams, plus: the misfiled-file overrides table, the "filename years lie"
warning, the Varsity CC = UKZN alias, the Greytown/Masi no-constitution facts, PII
handling (registration forms + rolls carry full RSA IDs incl. minors), and the
SKM-scan/Chad-P-Clearance/POP scans that are image-only (no text layer) and were
classified from filename + visual inspection.

## Acceptance for this pass

1. `npx tsx packages/api/src/import-tuskers-compliance.ts --parse-only --dir
"/Users/carlton/Downloads/Tuskers"` runs CLEAN (zero unclassified, zero unmapped
   folders, every club has docs) and its classification table matches this spec.
2. `configure-tenant-docs.ts` has the tuskers catalogue and validates.
3. tsc + prettier + full api test suite pass.
4. Nothing written to any AWS stage (SSO is expired anyway; dry-run/confirm are the
   user-driven next step per the runbook).

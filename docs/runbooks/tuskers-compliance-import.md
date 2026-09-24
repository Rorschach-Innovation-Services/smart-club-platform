# Tuskers compliance import — clubs, documents and rosters

One-time import of the KwaZulu-Natal Inland Cricket Union ("KZNICU", brand **Tuskers**)
compliance pack into the `tuskers` tenant: 8 clubs and their compliance documents
(constitutions, AGM minutes, financials, affiliation forms and fees, nominal rolls, logos,
facility agreements, disciplinary records, union correspondence, player registrations and
other club records), then the players from every nominal roll that carries enough
identity data (see [Roster import](#roster-import)).

**Input** (from the union, extracted locally, never committed): one folder per club, 165
files (pdf/doc/docx/odt/xlsx/jpg/png). Every file was text-extracted or visually inspected
before the classifier was written. The reviewed decisions are in
`plans/tuskers-compliance-import-plan.md`.

**Scripts**: `packages/api/src/import-tuskers-compliance.ts` (clubs + documents),
`packages/api/src/import-tuskers-roster.ts` (players), `packages/api/src/tuskers-import-map.ts`
(pure club map, filename classifier and roster source config, no AWS) and
`packages/api/src/tuskers-roster-parse.ts` (pure roster parser).
This is a copy-and-trim of the Titans pair (see
[titans-compliance-import.md](./titans-compliance-import.md)). It follows the same
contract: `--parse-only` touches nothing, dry-run is the default, every abort is
fail-closed with a printed reason, a backup is written before any write, and `--revert`
undoes cleanly.

**What's different from Titans:**

- **No league-structure workbook.** There is no `--structure`, `--with-teams` or
  `--add-missing-leagues`. Clubs are created with `leagues: []`, no team plan and an
  empty `ground`. Leagues, teams and venues come later through the season wizard.
- **A different doc taxonomy** (12 keys, most of them multi-file). See Prerequisites.
- **FILE_OVERRIDES can reassign a file to another club.** A value can be `'skip'`, a
  doc key, or `{ club, docKey }` for a file the union filed in the wrong club's folder.
- **The roster import is tuskers-specific.** These rolls are not the union template
  Titans used, and the team comes from the sheet name. See [Roster import](#roster-import).

## Prerequisites

1. **The `tuskers` tenant exists.** This CLI does not create tenants. It aborts with
   `tenant "tuskers" has no config` until the tenant has been stood up through the
   operator portal (or the existing bootstrap path). **On dev it already exists**,
   operator-created, with branding name "Tuskers", six districts (the one these clubs
   use is `uMgungundlovu Cricket District`), eight leagues (see [Leagues](#leagues)) and
   an operator-set deadline of 2026-08-07. **Prod differs**: see
   [Prod differences](#prod-differences).
2. **The platform build that accepts odt/jpg/jpeg/png is deployed to the target stage.**
   `DOC_FORMAT_MIME` (`catalogue.ts`) gained `odt`, `jpg`, `jpeg` and `png` for this pack.
   Without it, `configure-tenant-docs` fails validation, and chairs can't upload photos
   through the portal.
3. **The `tuskers` requiredDocs catalogue is configured.** The catalogue lives in
   `configure-tenant-docs.ts` (`CATALOGUES.tuskers`). Apply it with:

   ```bash
   npx sst shell --stage <stage> -- npm --prefix packages/api run configure-tenant-docs -- tuskers
   … --confirm
   ```

   | key                   | shape                       | accepts                  |
   | --------------------- | --------------------------- | ------------------------ |
   | `constitution`        | single                      | pdf/doc/docx             |
   | `agmMinutes`          | multi, 1–6                  | pdf/doc/docx/odt         |
   | `financials`          | multi, 1–6, unavailable ok  | pdf/doc/docx             |
   | `affiliationForm`     | multi, 1–4                  | office + sheets          |
   | `affiliationFees`     | multi, 1–8, unavailable ok  | office + sheets + images |
   | `nominalRoll`         | multi, 1–4, memberDatabase  | office + sheets          |
   | `clubLogo`            | single, unavailable ok      | jpg/jpeg/png             |
   | `facilityAgreement`   | multi, 1–6, unavailable ok  | pdf/doc/docx + images    |
   | `disciplinaryRecords` | multi, 1–15, unavailable ok | pdf/doc/docx + images    |
   | `unionCorrespondence` | multi, 1–10, unavailable ok | office + sheets          |
   | `playerRegistrations` | multi, 1–8, unavailable ok  | pdf + images             |
   | `clubRecords`         | multi, 1–8, unavailable ok  | office + sheets + images |

   The dry-run asserts that the catalogue covers every `TUSKERS_DOC_KEYS` entry. It also
   checks the multi-file shape in both directions and that each cap holds the busiest
   club after dedupe. It aborts with the exact problem if not. Measured worst cases:
   UKZN has 8 disciplinary records, Standard has 6 union letters, Masibemunye has 6 club
   records, and nominal rolls, affiliation fees and player registrations top out at 3.

4. **Unzip the pack locally, never into the repo.** `--parse-only` needs no AWS
   credentials, so iterate on it offline.

## Commands

Run these from the repo root. `--parse-only` needs no `sst shell` because it never
imports `repo.js`.

```bash
# Phase P: parse only. Classifies every file and prints the classification table,
# per-club coverage and the post-dedupe upload preview. Touches NOTHING.
npx tsx packages/api/src/import-tuskers-compliance.ts --parse-only --dir "<pack>"

# Phase 1: dry-run (the default, no --confirm). Asserts catalogue coverage, validates every
# file's MIME type against the catalogue, and prints the create/merge diff plus the
# would-upload report. Read-only.
npx sst shell --stage <stage> -- npm --prefix packages/api run import-tuskers-compliance -- \
  --dir "<pack>"

# Phase 2: write clubs and upload documents (after reviewing the dry run).
… --confirm
… --confirm --skip-docs            # clubs only, no S3/doc writes
… --confirm --club howick-cricket-club   # one club only

# Onto a pre-existing tenant club with a different id (repeatable; prod needs this):
… --confirm --map-club lancashire-cricket-club=lancashire-cricket-club-pmb

# Revert (dry-run / confirm). Same semantics as Titans; see "Revert" below.
# Pass the SAME --map-club flags the import used, or the mapped club is not visited.
… --revert
… --revert --confirm
… --revert --all --confirm
… --revert --all --erase-preexisting --confirm
```

Dry-run and `--confirm` both resolve the district from the tenant config and check every
`--map-club` target exists (see below). `--parse-only` needs neither.

Expected Phase P result: 165 files, of which 142 are classified and 23 are deliberate
skips. That leaves 140 distinct uploads, because 2 byte-identical duplicates dedupe
(Greytown's two copies of the same FNB payment notification, and MCC's `MCC letter
2024.pdf` / `SLA Doc MCC.pdf`). There are zero unclassified files and every club has
documents.

## The 8 clubs

All 8 clubs belong in the **uMgungundlovu** district. The district string is **not
hardcoded**: dry-run and `--confirm` read the tenant's configured districts and use the
single one matching `/mgungundlovu/i` (dev: `uMgungundlovu Cricket District`, prod:
`uMgungundlovu District`). Admin district filters and insights match on the exact string.
Zero or several matches abort, printing the configured list. The district is written only
to clubs this import **creates**; the merge path never changes an existing club's
district.

| folder                    | club                         | notes                                                                     |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| `Young Natalians CC Club` | Young Natalians Cricket Club | no logo in the pack                                                       |
| `Howick CC Club`          | Howick Cricket Club          | AGM minutes are `.odt`                                                    |
| `Standard CC Club`        | Standard Cricket Club        | proof of payment is a phone photo                                         |
| `Masibemunye CC Club`     | Masibemunye Cricket Club     | **no constitution, no logo**                                              |
| `Greytown CC Club`        | Greytown Cricket Club        | **no constitution** (its form says so); no logo                           |
| `UKZN CC Club`            | UKZN Cricket Club            | **the union invoices it as "Varsity CC"** (INU000150). It's the same club |
| `MCC Club`                | Maritzburg Cricket Club      | folder says "MCC"; its documents say Maritzburg                           |
| `Lancashire CC Club`      | Lancashire Cricket Club      | NPO constitution ("Signed NPO Consti LCC")                                |

The missing constitutions and logos stay **outstanding** on the platform. That's the
correct compliance signal, not an import gap. `constitution` has no
`allowUnavailable` escape, so Greytown and Masibemunye will show it as required until
they supply one.

### Chairpersons (names only)

Each club's `chair` is seeded with a **name** taken from the club's own documents
(`CLUB_MAP[].chair` in `tuskers-import-map.ts`). Phone numbers and emails in those same
documents are deliberately **not** imported: they are PII, and a contact on the club
record would start driving chair notifications. The name lands only when this import
**creates** the club. The merge path never overwrites a chair, same as Titans.

Several sources are 2024-era. **Have the union confirm each chair at onboarding.**

| club                         | chair          | source (vintage)                                                                |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------- |
| Young Natalians Cricket Club | Faiyaz Patel   | 2026/27 affiliation form, signed 24 Jun 2026                                    |
| Howick Cricket Club          | Ashley Sokaloo | elected at the AGM of 12 Jun 2024                                               |
| Standard Cricket Club        | Robbie Coutts  | AGM minutes 2023/2024                                                           |
| Masibemunye Cricket Club     | Mondli Ndlovu  | AGM minutes 14 Jul 2023 and union letters                                       |
| Greytown Cricket Club        | Sadaf Zaman    | AGM minutes 2023 and 2024 (also the subject of the 2026 DC eligibility inquiry) |
| UKZN Cricket Club            | Dale Nadasan   | AGM of 27 Mar 2026 (current exco)                                               |
| Maritzburg Cricket Club      | Barry Moig     | AGM minutes 05 Jul 2024 (MCC calls the role "president")                        |
| Lancashire Cricket Club      | Mike Buckley   | 2024/25 District Teams affiliation form                                         |

**Greytown's district:** one line on its District Teams form reads "Uthukela", but its
MCA line and its geography both say Umgungundlovu. It imports as uMgungundlovu. Confirm
this with the union if it matters.

## Misfiled and overridden files

`FILE_OVERRIDES` in `tuskers-import-map.ts` carries a one-line reason for each entry.
Here are the ones worth knowing before sign-off.

**Reassigned to another club** (the `{ club, docKey }` extension):

| file                                                                             | goes to                             | why                                                        |
| -------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| `MCC Club/asanda.jpg`                                                            | Masibemunye → `playerRegistrations` | Asanda Khumalo's registration form, a Masibemunye player   |
| `Standard CC Club/KZN Inland Letter Lancashire Ground Booking 26 March 2024.pdf` | Lancashire → `unionCorrespondence`  | addressed to Lancashire's chairman (Michael Patricks Oval) |

**Skipped (not a document for this club):** `virat-kohli-4k-ap-1920x1080.jpg` (a
wallpaper), `Lynwood Club.jpg` (the venue's logo, not MCC's), `Appeals Letter Standard
CC.docx` (a misnamed letter about returning a roller to Carter High School), and
`Greytown CC DC Inquiry 2026.docx` (a blank meeting sign-in register. The `.pdf` of the
same stem is the real DC summons and does import).

**Skipped as the `.docx` half of a same-content docx+pdf pair.** The pdf is the
signed/rendered form and is canonical. Each pair was text-compared (`textutil` vs
`pdftotext`). In 17 of them the only differences are bullet glyphs. The 18th, `UKZN DC
Letter Ashok.docx`, is a reworded 28 Feb draft of the 29 Feb pdf final with the same
sanction (5 matches, all suspended for 12 months). One more
skip is a second PDF render of an identical letter: `UKZN Letter 07 Dec 25.pdf` is
text-identical to `UKZN DC Letter 25.pdf` but has different bytes, so dedupe can't
collapse it.

**Same stem, different content: both kept.** These two `.docx` files look like drafts of
a pdf sibling, but they are 28 Feb 2024 **outcome** letters whose sanction differs from
the 29 Feb pdf final:

- `Standard DC Letter Chad Potgieter.docx`: 1 match plus 5 suspended for 12 months. The
  pdf final says 1 match, with a 1-match ban on reoffence.
- `MCC DC Letter Shaun Truter.docx`: 3 matches suspended. The pdf final says 5.

The union should confirm which sanction stands. Both are on record as
`disciplinaryRecords`.

**Classified from content, not filename.** Among others: the two union "Inland Club &
District Verification" workbooks go to `unionCorrespondence`, not `affiliationForm`.
Lancashire's "Final treasurers report AGM 2024" and Standard's "Balance Sheet Income
Statement" go to `financials`. Standard's two `POP -` PDFs (union-to-club payments: R20,000
prize money and a R5,250 grant) go to `clubRecords`. The 2025 unregistered-player letters
without a keyword in the name go to `disciplinaryRecords` alongside their "DC
Letter"-named twins. The 2024 "KZN Inland Letter …" series (Clause 18.1 premier-league
requirements and unregistered-player sanctions under the old template) goes to
`unionCorrespondence`.

## Never trust filename years

AGM and letter filenames carry years that don't match their contents. Young Natalians'
`Young Nats AGM 2025.docx` holds **24 Jun 2026** minutes, and Howick's `Howick AGM
2023.odt` holds **12 Jun 2024** minutes. Nothing in this import derives anything from a
filename year. When a club asks "which AGM is this?", open the document.

## Image-only files (no text layer)

These were classified from the filename plus visual inspection, because there was no text
to read:

- `Masibemunye CC Club/SKM_C30824080810300.pdf`: a scanner-default name with
  **unidentifiable** content, filed as `clubRecords`. **Ask Masibemunye what it is.**
- `Standard CC Club/Chad P Clearance.pdf`: a scanned clearance (`playerRegistrations`).
- The proof-of-payment scans: `Standard POP Affiliation fees.jpg`, `Proof_Of_Payment (4)
MCC.pdf`, and Standard's two `POP -` bank audit reports.
- The registration-form scans and photos: `D Fynn.pdf`, `Michael king Reg.pdf`,
  `asanda.jpg`, `Cian Fortman .jpg` (note the trailing space in that filename),
  `Sohail Gani Clearance.jpg`.
- `umpires report Standard vs Masi 2024.jpg` (a handwritten umpire report) and
  `Standard Womens Trial.pdf`.

## PII handling

The registration forms, clearances and nominal rolls carry **full RSA ID numbers,
including minors'**. Lancashire's roll puts IDs in its `BirthDate` column, and
`Cian Fortman .jpg` is a photo of a filled form. Keep the extracted pack in a private
location (never a shared drive, never committed). Once the import is signed off and
verified, delete the pack and the `tuskers-import-backup-*.json` files this import writes
to the current directory on every `--confirm`. Never paste an ID number into a PR, Slack
message or this runbook.

## Merge-never-clobber, MIME validation, revert

These behave exactly like the Titans import. The detailed rationale is in
[titans-compliance-import.md](./titans-compliance-import.md), sections "Doc uploads
merge, never clobber" and "Revert semantics". In short:

- Multi-file keys union with whatever a club rep already uploaded. A single-file key
  (`constitution`, `clubLogo`) never overwrites a non-import upload. Admin
  `markedCompliant`/`courseBooked` sentinels are carried forward.
- Every file's MIME type is validated against the catalogue's `accepts` before any S3
  write, in dry-run too.
- S3 keys are content-addressed:
  `tuskers/${clubId}/${docKey}-import-${sha256.slice(0,16)}.${ext}`. Re-runs are
  idempotent.
- The audit note (`Imported from Tuskers (KZN Inland) compliance pack
(import:tuskers-compliance-2026)`) is appended once per club. `updateClub` writes carry
  the actor `import:tuskers-compliance-2026`.
- The created-clubs manifest records every club this import **created**, written before
  each create. `--revert --all` force-deletes only those. `--all --erase-preexisting`
  refuses outright if the manifest is missing or corrupt. Keep the manifest (gitignored)
  until the import is signed off. It is **stage-scoped**:
  `./tuskers-import-created-clubs.<stage>.json` (in `packages/api/`, the npm `--prefix`
  working directory), so dev evidence can never steer a prod revert. The stage comes from
  `SST_STAGE` if set, else from the `SST_RESOURCE_App` JSON that `sst shell` injects
  (`{"name","stage"}`, the same source as the sst SDK's `Resource.App.stage`). Outside
  `sst shell` it falls back to the legacy unsuffixed `./tuskers-import-created-clubs.json`.
  `--confirm` and `--revert` print the path they use. The dev run's 8 ids were moved to
  `tuskers-import-created-clubs.dev.json`.

## Verification checklist (after `--confirm`)

1. The tenant has the 8 clubs (7 on prod, plus the mapped `-pmb` club). Every club this
   import created is in the resolved uMgungundlovu district, with no leagues (the roster
   import sets them).
2. Per-club doc counts match the Phase P upload preview. Spot-check UKZN
   (`disciplinaryRecords` = 8), Standard (`unionCorrespondence` = 6) and Masibemunye
   (`playerRegistrations` = 2, including the reassigned `asanda.jpg`).
3. Open one image doc (a club logo or `Standard POP Affiliation fees.jpg`) in the admin
   doc viewer. It should render inline as an image. Howick's `.odt` AGM minutes download
   rather than preview, which is expected because there is no in-browser odt renderer.
4. Lancashire has the reassigned Michael Patricks Oval letter under
   `unionCorrespondence`. Standard does not.
5. `aws s3 ls s3://$UPLOADS_BUCKET/tuskers/ --recursive | wc -l` should be about 140.

## Roster import

`import-tuskers-roster.ts` creates a player for every nominal-roll row with enough
identity data, in the club **and team** the sheet names. The source config is
`ROSTER_SOURCES` in `tuskers-import-map.ts`: an exact file, the exact worksheets, a league
key per sheet, and an explicit header-cell → field map (`colMap`). Every header row is
asserted cell for cell, and every worksheet must be either parsed or listed as ignored.
Any drift aborts the run. Identity semantics are the platform's own (`cleanIdCell`, the
Luhn check, `playerNaturalKey`, `dobFromSaId`), shared with the Titans import and the
registration routes.

### Run order

1. `import-tuskers-compliance --confirm`: clubs first. `createPlayer` needs the club rows,
   and the roster dry-run warns (and `--confirm` aborts) for any club that doesn't exist yet.
2. Compliance documents (the same `--confirm`, unless you ran `--skip-docs`).
3. `import-tuskers-roster --confirm --add-missing-leagues [--allow-missing-id]`.

### Commands

```bash
# Parse only: no AWS, touches nothing. Prints per-club, per-sheet valid/exception tables.
npx tsx packages/api/src/import-tuskers-roster.ts --parse-only --dir "<pack>"
npx tsx packages/api/src/import-tuskers-roster.ts --parse-only --dir "<pack>" --allow-missing-id

# Dry-run (default): the same report, plus the league gate and would-create/already-present.
npx sst shell --stage <stage> -- npm --prefix packages/api run import-tuskers-roster -- \
  --dir "<pack>" --allow-missing-id

# Write.
… --confirm --add-missing-leagues --allow-missing-id
… --confirm --add-missing-leagues --allow-missing-id --club maritzburg-cricket-club

# Revert (deletes players with registeredBy = import:tuskers-compliance-2026).
… --revert
… --revert --confirm
```

`--club` narrows what is reported and written, but every source is still parsed so the
cross-club duplicate check sees every claimant. The CLI rejects flag combinations that
would otherwise be silently ignored: `--parse-only --confirm`, and `--revert` with
`--dir`, `--club`, `--allow-missing-id`, `--add-missing-leagues` or `--parse-only`.

### Choosing the ID mode (read before `--confirm`)

**For this pack, `--allow-missing-id` is the correct mode.** As with Titans, a dob-only
row is not corrupt. It identifies a player by name plus a real date of birth, which
`playerNaturalKey` supports as its documented fallback. MCC's junior sheets (U9 to U15)
have a filled DOB column and an empty ID column (66 rows, plus one PREM row whose ID is
unusable). Lancashire has two 8-digit `yyyymmdd` values in its `BirthDate` column, and
Standard has two rows (one PREM, one U9) with a DOB but no ID. Strict mode drops all of
them. The per-club report says so:
`↳ N dob-only row(s) withheld in strict mode — re-run with --allow-missing-id`.

Measured with `--parse-only` on the pack as supplied (distinct players after intra-club
dedupe):

| club              | strict | `--allow-missing-id` |
| ----------------- | ------ | -------------------- |
| Maritzburg (MCC)  | 60     | 127                  |
| Lancashire        | 130    | 132                  |
| Standard          | 49     | 50                   |
| Howick            | 11     | 11                   |
| **total written** | 250    | 320                  |

There are no cross-club duplicates in either mode.

### Per-club expectations

- **MCC**: `Maritzburg CC Nominal Roll.xlsx` only. PREM, UMG DIV 2/3 and VETERANS carry
  IDs. About 11 trailing PREM rows are name-only and are exceptions. The U-sheets are
  DOB-only (see above). The WOMEN sheet is name-only, so every row is an exception.
  Known ID mangling (lost leading zeros, apostrophe-quoted text, space-grouped digits) is
  cleaned by `cleanIdCell`. Five rows fail the Luhn check (`bad-id-checksum`) and are never
  written. Seniors repeated across PREM/DIV 2/DIV 3/VETERANS collapse into one player
  (first sheet wins).
- **Lancashire**: `Lancashire CC Nominal Roll.xlsx` (the CSA export). The `BirthDate`
  column holds identity values, not dates: 13-digit RSA IDs, two `yyyymmdd` dates
  (dob-only), five Zimbabwean national IDs (`foreign-id-no-dob`, never written, because
  no date of birth can be derived) and blanks (`no-usable-identity`). Rows whose `Status`
  is `Active` or blank import. The blank count (58) is reported. `NOT` rows (19) are
  `excluded-status`. The Women sheet has no identity columns. **3rds and 4ths are team
  ordinals, not leagues**: their 23 distinct players import with **no team**. The union
  must confirm where 3rds and 4ths play before anyone assigns them. The export spells some
  races `COL` and `Black African`; the parser maps these to Coloured and African.
- **Standard**: two sources. The 2025/26 CSA team return is parsed first, so its identities
  win the dedupe: 18 of its 19 players import, and one fails the Luhn check. Then the
  2022/23 roll's seniors (PREM, UMG DIV 1/2), minus repeats of CSA-return players. Under
  `--allow-missing-id`, one PREM row with no ID but the same name and DOB as a
  CSA-return player is deduped as the same person (`via name+dob`) rather than becoming a
  second, dob-only player row. VETERANS, the U-sheets and WOMEN are
  name-only.
- **Howick**: only UMG DIV 1/2/3 carry IDs, and they are the same ~14 players repeated
  across all three sheets. Dedupe collapses them to **11** distinct players. Of the other
  3, one has a checksum-failing ID on every sheet and two have no ID anywhere. Three DIV 1/3 IDs are 14-digit
  leading-zero-corrupted (`bad-id`); the same players carry valid IDs on DIV 2, and dedupe
  keeps those. Howick's DOB column is free-text `d-m-yyyy`, which the shared date parser
  reads month-first, so it is deliberately **not** used. PREM, WOMEN, VETERANS and
  U9 to U15 are name-only.

The `… Nominal Rolls 2024.xlsx` files (MCC, Howick, Lancashire, Standard) and
`MCC Nominal Roll (9).xlsx` are deliberately not roster sources (`ROSTER_NON_SOURCES`
records why). A new nominal-roll file that is in neither list aborts the run.

### Four clubs can't be imported (report to the union)

**Young Natalians, Masibemunye, Greytown and UKZN** (`SKIP_ROSTER`): their rolls have no
ID-number column and no DOB column, only name, gender and race. `PlayerRegistration.dob`
is required, and a natural key needs an ID or a name plus DOB, so no player can be built.
Their compliance documents import normally. Ask the union for roster exports with ID
numbers for these four clubs.

### Leagues

The live `tuskers` tenant (dev) already has eight leagues, all shaped
`{ key, label, group: "Overarching Leagues", district: "All districts" }`:
`premier-league`, `promotion-league`, `women-s-premier-league`,
`women-s-promotion-league`, `veterans-league`, `u11`, `u13` and `u15`. `TUSKERS_LEAGUES`
(in the map file) uses those keys exactly for the sheets that map to them, so nothing is
duplicated. The Women sheets map to `women-s-premier-league`, the operator's key, never a
parallel one. Today no Women row has identity data, so nothing lands there yet.

Keys the roster references that the tenant lacks:

| key     | label          | group               | district                                       |
| ------- | -------------- | ------------------- | ---------------------------------------------- |
| `div-1` | UMG Division 1 | Overarching Leagues | the tenant's uMgungundlovu district (resolved) |
| `div-2` | UMG Division 2 | Overarching Leagues | the tenant's uMgungundlovu district (resolved) |
| `div-3` | UMG Division 3 | Overarching Leagues | the tenant's uMgungundlovu district (resolved) |
| `u9`    | U9             | Overarching Leagues | All districts                                  |
| `u16`   | U16            | Overarching Leagues | All districts                                  |

The divisions are district-scoped, so they carry the district name rather than the
`All districts` sentinel: the platform offers a district league only to that district's
clubs. That name differs per stage, so the map file holds a placeholder and the roster CLI
substitutes the tenant's resolved uMgungundlovu district (the same resolver as the
compliance CLI, fail-closed) before appending. `u16` is appended only if a written row lands in it. Today every valid U16 player
also appears on Lancashire's Premier sheet, which wins, so it isn't appended.

The dry-run prints which referenced keys are missing. On the dev tenant as configured,
that is exactly `div-1`, `div-2`, `div-3` and `u9`. `--confirm --add-missing-leagues`
appends exactly the ones that eligible rows reference and the tenant lacks. It is idempotent, and it never adds a key no written row uses.
Without the flag, `--confirm` aborts when a key is missing. A referenced key that isn't in
`TUSKERS_LEAGUES` always aborts.

After writing, each touched club's `leagues[]` is **unioned** with the keys its players
landed in (merge, never remove). A club with no leagues reads as zero in every
league-scoped view (the dolphins Insights lesson).

### Exception reasons

`bad-id`, `bad-id-checksum`, `no-usable-identity` and `missing-surname` mean what they
mean in the Titans import. There are two new ones:

- `foreign-id-no-dob`: a Zimbabwean national ID. It is a real identity, but no date of
  birth can be derived from it and the sheet has no separate DOB.
- `excluded-status`: a Lancashire row whose `Status` is neither `Active` nor blank.

Report lines only ever say `<sheet> row <n>: <reason>`, with a fully masked ID where
relevant. No name, date of birth or partial ID is ever printed.

### Revert order

To revert everything, revert the **roster first**, then the compliance import:

```bash
… import-tuskers-roster -- --revert --confirm [--map-club …]
… import-tuskers-compliance -- --revert --all --confirm [--map-club …]
```

Pass the same `--map-club` flags the import used. A mapped club is never in the
created-clubs manifest (it is never created), so even `--all` only strips its
import-marked docs and deletes its imported players. It never deletes the club.

The compliance revert treats a club with players as non-pristine. Removing the imported
players first lets it delete the clubs it created. The roster revert deletes only players
with `registeredBy = import:tuskers-compliance-2026`, reconciles each club's player count,
and leaves appended leagues and `club.leagues` in place.

### Roster verification (after `--confirm`)

1. The per-club player counts match the parse report's `distinct` column for the mode you
   ran.
2. Lancashire's 3rds/4ths players have no team. Hand the list to the union.
3. Each of MCC, Lancashire, Standard and Howick has `leagues[]` set.

## Prod differences

Checked against the live prod tenant with a read-only script. Prod is **not** a copy of
dev:

- **Districts are named differently.** Prod uses `uMgungundlovu District`,
  `uMzinyathi District` and so on, where dev uses `… Cricket District`. The district
  resolver handles this (see [The 8 clubs](#the-8-clubs)); nothing is hardcoded.
- **Four clubs already exist from self-signup.**

  | prod club id                  | state                                                                                         | import action          | chair kept  |
  | ----------------------------- | --------------------------------------------------------------------------------------------- | ---------------------- | ----------- |
  | `greytown-cricket-club`       | empty, same id as ours                                                                        | merge                  | Sadaf Zaman |
  | `howick-cricket-club`         | empty, same id as ours                                                                        | merge                  | Seth        |
  | `masibemunye-cricket-club`    | empty, same id as ours                                                                        | merge                  | S'bonelo    |
  | `lancashire-cricket-club-pmb` | "Lancashire Cricket Club PMB", affiliation complete, real uploads under the default catalogue | merge via `--map-club` | "Admin"     |

  The merge path fills only absent doc-key seeds and appends the audit note. It never
  touches chair, name, district or affiliation, so the self-signup values stay.

- **Prod Greytown sits in `uMzinyathi District`.** That was its own signup choice, and
  the merge keeps it. That is geographically correct, unlike dev, where this import
  created Greytown and put it in uMgungundlovu with the rest.
- **Lancashire must be mapped.** Our CLUB_MAP id `lancashire-cricket-club` would create a
  duplicate of the existing `-pmb` club. On prod, pass the mapping to **both** CLIs, and
  to their reverts:

  ```bash
  … import-tuskers-compliance -- --dir "<pack>" --confirm \
      --map-club lancashire-cricket-club=lancashire-cricket-club-pmb
  … import-tuskers-roster -- --dir "<pack>" --confirm --add-missing-leagues --allow-missing-id \
      --map-club lancashire-cricket-club=lancashire-cricket-club-pmb
  ```

  A mapped club is **never created**. If the target id doesn't exist on the tenant,
  dry-run, `--confirm` and `--revert` all abort. Every club-keyed read and write follows
  the target id: the create-vs-merge decision, S3 key prefixes
  (`tuskers/lancashire-cricket-club-pmb/…`), docMeta, the backup, revert scoping, player
  `clubId`, the `club.leagues` union and `reconcilePlayerCount`.

- **The `-pmb` club's real uploads stay untouched.** Its default-catalogue docs remain as
  they are. The single-file clash rule protects its `constitution`: an existing non-import
  upload is reported as a clash and left in place. Its `agm` and other legacy default keys
  are archived in the tuskers catalogue, so they keep resolving. Multi-file keys union
  with anything already there.
- **League keys differ.** Prod has `premier-league`, `promotion-league`, `womens-league`,
  `veterans-league`, `u11`, `u13` and `u16`. It has no `u15`, `u9` or `div-*`, so on prod
  `--add-missing-leagues` appends `div-1`, `div-2`, `div-3` (with prod's uMgungundlovu
  district name), `u9` and `u15`. Prod's women's key is `womens-league`, not dev's
  `women-s-premier-league`. No Women row is written today, so this doesn't bite yet.
  Revisit the Women mapping before any women's roster lands on prod.
- **Manifests are stage-scoped.** A prod `--confirm` writes
  `tuskers-import-created-clubs.prod.json`. It never touches the dev file.

## Other notes

- **`.ods` nominal rolls need this CLI.** The operator roster wizard only accepts
  `.xlsx`, `.xls` and `.csv`. A roll that a club supplies as `.ods` (the `nominalRoll`
  doc key accepts it) can't go through the wizard. Use this CLI, or convert the file
  first. This pack has no `.ods` rolls.
- **Tutorial videos.** Without tuskers-specific tutorials config, Tuskers clubs see the
  shared default videos, which were recorded for the default document flow, not this
  12-key catalogue. Before onboarding, the operator should either record and upload
  Tuskers videos (operator portal, per-tenant tutorials) or set the tenant's no-fallback
  flag (`tutorialsNoFallback`) so no misleading video is shown.

## Out of scope

- Venue/ground seeding and league/team plans beyond the roster's league keys, because no
  structure workbook exists. Divisions and pools are season-wizard work.
- Tenant creation (see Prerequisites #1).

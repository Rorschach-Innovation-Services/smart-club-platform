# Titans compliance import — clubs, documents, and rosters

One-time import of the Titans Cricket 2026-27 affiliation pack into the `titans` tenant:
21 clubs, their compliance documents (league entry, assets register, health tracker,
member database, committee, constitution, AGM, chairman's report, financials, facility
agreements), the league-structure workbook (team counts per league, home venues), and —
in a separate, later pass — player rosters parsed out of each club's member database.

**Inputs** (from the union, extracted locally — never committed):

- `Compliance Documents/` — 21 club folders, ~114 files (pdf/doc/docx/xls/xlsx/ods).
- `Titans Club Cricket 2026-2027 PROMOTION RELEGATION.xlsx` — the league structure
  (`SENIORS` sheet + `JUNIORS ` sheet, note the trailing space in the sheet name).

**Scripts**: `packages/api/src/import-titans-compliance.ts` (clubs + docs + optional
teams) and `packages/api/src/import-titans-roster.ts` (players, run after). Both mirror
the `import-planb-fixtures.ts` precedent: `--parse-only` touches nothing, dry-run is the
default (no `--confirm`), every abort is fail-closed and printed with a reason, a backup
is written before any destructive write, and `--revert` undoes cleanly. The parsing/
classification/name-resolution logic they share lives in
`packages/api/src/titans-import-map.ts` (pure, no AWS); row-level spreadsheet
normalization (header detection, ID cleanup, race/gender/age-group mapping) lives in
`packages/api/src/roster-normalize.ts` (also pure, tenant-neutral).

## Prerequisites

1. **ADR 0009 (per-tenant compliance-doc catalogue) is deployed.** This is what lets
   `titans` run a completely different doc set from `dolphins` — see
   [0009-per-tenant-required-docs.md](../architecture/0009-per-tenant-required-docs.md).
   It's already implemented and merged into the working tree; confirm it's live on the
   target stage before running anything here (a tenant whose `requiredDocs` catalogue
   can't be configured will fail this import's own coverage assertion — see below).
2. **The `titans` tenant's `requiredDocs` catalogue is configured** via the operator
   console's **Required documents** card (`platform-required-docs.tsx`,
   `PUT /platform/tenants/titans`) with **exactly** these keys, matching what
   `TITANS_DOC_KEYS` in `titans-import-map.ts` expects:

   | key                 | name                             | notes                                      |
   | ------------------- | -------------------------------- | ------------------------------------------ |
   | `leagueEntry`       | League entry form                | single-file                                |
   | `assetsRegister`    | Club assets register             | single-file                                |
   | `healthTracker`     | Club health tracker              | single-file                                |
   | `memberDatabase`    | Member database                  | single-file (source for the roster import) |
   | `committee`         | Club committee                   | single-file                                |
   | `constitution`      | Club constitution                | single-file                                |
   | `agm`               | AGM pack                         | **multiFile**, `maxFiles` ≥ 3              |
   | `chairmansReport`   | Chairman's report                | single-file                                |
   | `financials`        | Financial statements             | single-file                                |
   | `facilityAgreement` | Facility agreement / lease / MOU | **multiFile**, `maxFiles` ≥ 4              |

   The two multi-file caps are not arbitrary: Centurion Kavaliers submitted 3 AGM
   documents (agenda, notice, minutes) and Irene Villagers 4 distinct facility MOUs
   (7 files, 3 of which are byte-identical copies that dedupe away). The dry-run
   computes the real post-dedupe worst case per key and **aborts** if the catalogue's
   `maxFiles` can't hold it, or if either key is configured single-file — these CLIs
   write through `repo` and so bypass the route validation that would otherwise catch
   it, which is exactly why the check lives in the script.

   Every key needs `accepts` covering at least `xlsx`/`xls`/`ods` in addition to
   `pdf`/`doc`/`docx` — most of the pack's league entry/assets register/health
   tracker/member database docs are filled-in workbooks, not PDFs (`DOC_FORMAT_MIME` in
   `catalogue.ts` already maps all six). The compliance import's dry-run phase asserts
   `resolveRequiredDocs(config)` covers every one of these keys and **aborts with the
   missing-key list** if the catalogue isn't configured yet — it will never silently
   half-import against a wrong catalogue.

3. **Unzip the pack locally**, e.g. into a scratch directory — never into the repo.
   `--parse-only` needs no AWS credentials at all, so iterate the parsing entirely
   offline before touching a real stage.
4. **DACC = Differently Abled Cricket Club — sign this off explicitly with the union
   before `--confirm`.** The folder is named "DACC"; every compliance document inside it
   (Members Database header, etc.) spells out "Differently Abled Cricket Club" in full,
   and the structure spreadsheet's team tokens are "DIFFERENTLY ABLED 1".."7" (Fourth,
   Fifth and Sixth League). `CLUB_MAP` in `titans-import-map.ts` encodes this expansion
   as `DACC (Differently Abled Cricket Club)` — a one-line confirmation from the union
   that this reading is correct is cheap insurance against onboarding the wrong club
   identity for a whole club.
5. **PII handling.** The "Clubs Database"/member-database workbooks carry names, race,
   gender and full SA ID numbers for every player, including minors. Keep the extracted
   pack in a private location (never a shared drive, never committed), delete it — and
   the `titans-import-backup-*.json` / `planb-backup-*.json`-style backup files this
   import writes to the current directory on every `--confirm` — once the import is
   signed off and verified. Every report this pair of scripts prints masks ID numbers
   (fully, `*************`, via `maskId` in `import-titans-roster.ts` — no partial digits
   either, since the first 6 of an RSA ID are a full date of birth) — never paste an unmasked
   ID into a PR description, Slack message, or this runbook.

## Doc uploads merge, never clobber

`runDocUploadPhase` writes `docMeta[docKey]` by **merging** — union of stored files with
this run's resolved entries, deduped on `objectKey` — never a bare
`docMeta[docKey] = { files: entries }` overwrite. This matters for both shapes:

- **Multi-file** (`agm`, `facilityAgreement`): a club rep who uploaded a facility MOU
  through the portal before this import ran keeps it; this run's files are added
  alongside, not instead of. `markedCompliant`/`courseBooked`/`courseDate`/`at`
  sentinel fields set by an admin are preserved too.
- **Single-file**: an existing objectKey that doesn't carry the `-import-` marker (a
  real upload) is still refused outright, exactly as before — a single-file doc can only
  ever hold one file, so there's no "merge" to do, only "never overwrite a real one".
  What changed is that `markedCompliant`/`at` are now preserved forward here too if an
  admin had set them, instead of being silently dropped by the write.

`docs[docKey]` is recomputed the same way the HTTP presign/commit routes do:
`markedCompliant || courseBooked || files.length >= minFiles` (via
`multiFileLimits` in `catalogue.ts`), not just "does this key have a file".

Every uploaded file's resolved MIME type is validated against the doc definition's
`accepts` (`acceptedMimes` in `catalogue.ts`) before any S3 write — the same check the
HTTP upload route applies. This CLI writes through `repo`/S3 directly, bypassing that
route entirely, so the check has to live here; an unaccepted/unresolvable extension
aborts the doc-upload phase with the full offender list rather than uploading it anyway.

The audit note (`"Imported from Titans compliance pack…"`) is now only appended once per
club — re-running `--confirm` after a partial revert (which the workflow above
explicitly encourages) no longer accumulates duplicate notes.

## Deadline framing — read before touching `--confirm`

The union's **22 Aug submissionDeadline** gates _visibility_ of each club's compliance
status on the platform (what shows as outstanding vs. complete), not _collection_ — the
documents themselves already exist in the extracted pack before this import ever runs.
There is no reason the deadline should ever pressure a rushed `--confirm` past a failed
sign-off (an aborted parse phase, an unresolved cross-club ID clash, a missing catalogue
key). Fix the underlying data or map table and re-run `--parse-only` until it's clean —
the deadline is a display concern the import satisfies once it finally runs cleanly, not
a reason to force a write through a known-bad state.

## Commands

Run from the repo root. `--parse-only` needs no `sst shell` — it never imports `repo.js`.

```bash
# Phase P — parse only. Classifies every file, parses the structure workbook, prints
# the classification/coverage/resolution tables. Touches NOTHING.
npx tsx packages/api/src/import-titans-compliance.ts --parse-only \
  --dir "<pack>/Compliance Documents" \
  --structure "<pack>/Titans Club Cricket 2026-2027 PROMOTION RELEGATION.xlsx"

# Phase 1 — dry-run (default, no --confirm). Loads the tenant config + existing clubs,
# asserts catalogue coverage, prints the create/merge diff. Requires sst shell (touches
# DynamoDB via a read-only path).
npx sst shell --stage <stage> -- npm --prefix packages/api run import-titans-compliance -- \
  --dir "<pack>/Compliance Documents" \
  --structure "<pack>/Titans Club Cricket 2026-2027 PROMOTION RELEGATION.xlsx"

# Phase 2 — write clubs + upload documents (after reviewing the dry run).
… --confirm

# Add team rosters (leagues[]/leagueTeams/teamRosters) on top of the above:
… --confirm --with-teams

# Clubs only, skip the S3/doc upload phase (e.g. to unblock roster import sooner):
… --confirm --skip-docs

# One club only, for targeted debugging:
… --confirm --club adelaar-cricket-club

# Revert (dry-run / confirm):
… --revert
… --revert --confirm
… --revert --all --confirm   # also force-deletes NOT-pristine, IMPORT-CREATED clubs (see Revert semantics)
… --revert --all --erase-preexisting --confirm   # ALSO erases a pre-existing club's real data — separate explicit flag, see Revert semantics

# Roster import — run AFTER the clubs above exist (createPlayer requires the club row).
npx tsx packages/api/src/import-titans-roster.ts --parse-only --dir "<pack>/Compliance Documents"
npx sst shell --stage <stage> -- npm --prefix packages/api run import-titans-roster -- \
  --dir "<pack>/Compliance Documents"                      # dry-run
… --confirm                                                 # strict mode: drops unusable-ID rows
… --confirm --allow-missing-id                              # also writes dob-only rows
… --revert
… --revert --confirm
```

## Choosing the roster ID mode (read before `--confirm`)

**For this pack, `--allow-missing-id` is the correct mode, and strict mode is the wrong
default.** The union circulated two versions of the member-database template: one with an
`ID number (Compulsory)` column, and one with a `Date of Birth` column instead. Rows from
the second are not corrupt — they simply identify a player by name + real date of birth,
which `playerNaturalKey` supports as its documented fallback.

Measured on the pack as supplied (`--parse-only`):

| mode                 | eligible rows | clubs importing zero                              |
| -------------------- | ------------- | ------------------------------------------------- |
| strict (default)     | 1 626         | Adelaar, Eersterust, Hammanskraal, Atteridgeville |
| `--allow-missing-id` | 2 520         | Atteridgeville only                               |

(These are lower than earlier measurements by exactly the number of rows now caught by
the Luhn check-digit validation — 55 rows across both modes — plus, in `--allow-missing-id`
mode, 2 further rows caught by dob-only cross-club duplicate detection. See "New exception
reasons" and "Cross-club duplicate detection" below.)

Running strict would silently drop ~900 real players and three entire clubs. The per-club
report names this case explicitly — a club whose sheets carry no ID column at all prints
`↳ template has no ID-number column (Date of Birth variant)` above its exception rows, so
a wall of `bad-id` is never mistaken for corrupt data.

Still run **strict first** as a diagnostic: the difference between the two runs is exactly
the set of dob-only players, and it is worth eyeballing that list once before writing.

**Atteridgeville imports zero rows in either mode, and that is correct.** Its ID column is
present in the header but completely blank, and there is no DOB column; the junior sheet
carries only an age group. There is no identity to build a player from, so — like
Queenswood — the club must resupply a proper roster export. Its compliance _documents_
import normally; only its players are blocked. Report both clubs back to the union
together.

## New exception reason: `bad-id-checksum`

`cleanIdCell` (`roster-normalize.ts`) now verifies the RSA ID's Luhn check digit (the
13th digit), not just that the first 6 digits form a plausible date. A 13-digit cell
that reads as a real calendar date but fails the checksum — the dominant error mode in
hand-typed member databases is a transposed pair of digits — is **never** silently
promoted to a usable id (a wrong checksum means a wrong `naturalKey`, which would
silently break future dedup/transfers). It's also **never** hard-aborted: real registers
genuinely contain checksum typos, so it's reported as its own exception reason,
`bad-id-checksum`, in both strict and `--allow-missing-id` mode (unlike a `bad-id`
row, it is never promoted to dob-only either, even under `--allow-missing-id` — the
digits themselves are suspect, not just the checksum). The per-club summary line
surfaces a separate count, e.g. `exceptions=93 (of which bad-checksum=2)`, so an
operator can see at a glance how many of a club's failures are checksum typos worth a
quick manual look versus genuine missing-identity rows. Measured on the real pack: 55
rows across all clubs.

## Unknown race/gender report

`normalizeRace`/`normalizeGender` (`roster-normalize.ts`) already returned an
`unknownRaw` field for any cell value that didn't match a canonical value or documented
synonym — this used to be read nowhere, so a club whose sheet said (for example)
"Caucasian" lost that demographic silently. The per-club report now surfaces it:

```
     ↳ unknown gender: 2 row(s), 2 distinct value(s): Make, Maake
```

capped at 10 distinct values (with a "+N more distinct" suffix) and 40 characters per
value, so a genuinely messy column doesn't blow up the report. This never changes what's
written — an unrecognised value still isn't set on the player — it just makes sure the
operator sees it instead of it silently vanishing.

## Cross-club duplicate detection now covers dob-only identities

`findCrossClubDuplicates` (`import-titans-roster.ts`) used to key on the raw
`idNumber`, so a dob-only row (no `idNumber` at all — exactly what
`--allow-missing-id` writes) was never checked against another club's dob-only row for
the same person. It now keys on the resolved `naturalKey`, which exists for both
id-based and dob-only rows, so a player who appears in two clubs' sheets under
`--allow-missing-id` is caught the same way an id-based duplicate always was. The report
never prints a raw ID (masked, as before) or a raw DOB (PII, and unlike an ID it was
never masked before this fix — it's simply never printed for a dob-only match: the line
reads `dob-only match: claimed by <club>, <club>`). Measured on the real pack: this
caught one real dob-only duplicate (Adelaar / Centurion Kavaliers) that strict-mode's
id-only check had no way to see.

## Dry-run doc-upload preview

`--parse-only` (Phase P, no AWS access at all) now prints a **doc upload preview**
computed purely from local file content hashes — per club/key would-upload counts and
the dedupe collapse (e.g. Irene Villagers' `facilityAgreement: 7 file(s) → would upload 4
(3 byte-identical duplicate(s) skipped)`). What it can't know without a real tenant to
compare against — which files are already stored (no-op skips) and MIME-type validation
against the tenant's configured catalogue — is reported by the **dry-run** phase (Phase
1, `sst shell`, no `--confirm`): it now calls the exact same doc-upload code path
`--confirm` runs, strictly read-only (no S3 client is even constructed unless
`--confirm` is passed), so what dry-run reports as "would upload"/"already-current
(no-op)" is guaranteed to match what `--confirm` actually does.

## What "fail-closed" means here, and how to extend the map tables

Both scripts abort rather than guess. Every abort prints exactly what to fix:

- **An unclassified compliance file** (`titans-import-map.ts`'s `DOC_RULES`/
  `FILE_OVERRIDES`) aborts Phase P. Add a regex to `DOC_RULES` if it's a genuinely new
  naming convention, or an exact-path entry to `FILE_OVERRIDES` (`'skip'` or a forced
  doc key) if it's a one-off duplicate/stray file — always with a one-line reason
  comment, same convention as the two entries already there (Adelaar's committee
  pdf+xls pair, Queenswood's duplicate health-tracker pdf, Sinoville's non-tabular
  contact list).
- **An unresolved structure-sheet team token** (`resolveClubToken`) aborts Phase P
  unless it's in `KNOWN_STRUCTURE_ANOMALIES` — a small, reviewed, documented exception
  list (same pattern as `import-planb-fixtures.ts`'s `KEEP_LIST`/`DELETE_SLUGS`), never
  a silent catch-all. Extend `CLUB_MAP[].sheetTokens` or `TOKEN_REDIRECTS` for a genuine
  new spelling/typo; add to `KNOWN_STRUCTURE_ANOMALIES` only for a token you've
  confirmed cannot be resolved to any club at all (document why, as the one existing
  entry does).
- **A club with zero classified docs**, or an **empty mapped league section**, aborts
  Phase P.
- **A tenant `requiredDocs` catalogue missing any of `TITANS_DOC_KEYS`** aborts Phase 1
  (dry-run) with the exact missing-key list — see Prerequisites #2.
- **A cross-club duplicate identity** — matched on the resolved `naturalKey`, so this
  covers a dob-only identity (`--allow-missing-id`) as well as an id-based one (see
  "Cross-club duplicate detection now covers dob-only identities" above) —
  (`import-titans-roster.ts`'s `findCrossClubDuplicates`) is reported and **all claimant
  rows are excluded from writing** — never a guess at which club is right. Resolve with
  the union (which club actually has this player) and either fix the source file or
  accept the exclusion; the script never auto-resolves this.
- **A date-plausible ID whose Luhn check digit is wrong** is reported as its own
  exception reason (`bad-id-checksum`) and never written — see "New exception reason:
  bad-id-checksum" above. Not a hard abort (real registers contain checksum typos), but
  never silently promoted either.
- **A file whose resolved MIME type isn't in the tenant catalogue's `accepts` for its
  doc key** aborts the doc-upload phase (Phase 1 dry-run or `--confirm`) with the full
  offender list — the same validation the HTTP upload route applies, which these CLIs
  would otherwise bypass by writing through `repo`/S3 directly.
- **A club with no memberDatabase file and not on `SKIP_ROSTER`** aborts the roster
  script's Phase P.

## Verification checklist (after `--confirm`)

1. **23 clubs on the tenant total** — the 21 imported + the pre-existing `admin-cc` and
   `test-cc` (left untouched by this import; never overwritten, never deleted).
2. **Per-club doc counts match the classification table** printed by
   `--parse-only` — spot-check a handful of clubs in the admin console's club detail
   view against the printed per-club doc-key coverage.
3. **Spot-check one PDF view-url and one xlsx download** from the admin console for a
   club with both (e.g. Centurion Kavaliers, which has an AGM pdf pack and an xls
   assets register) — confirms the S3 upload + `docMeta` write round-trips correctly for
   both a single-file and a multiFile key.
4. **`playerCount` vs the roster report**: for each touched club, the admin console's
   player count should match the roster import's per-club "valid" count (minus any
   cross-club-duplicate exclusions and, in strict mode, any bad-ID exceptions). If it
   drifts, run `reconcilePlayerCount` — the roster script already calls it once per
   touched club after `--confirm`, but a partial/interrupted run may need a manual
   re-run of just that step.
5. **S3 object count**:
   ```bash
   aws s3 ls s3://$UPLOADS_BUCKET/titans/ --recursive | wc -l
   ```
   should be in the same ballpark as the number of distinct (club, docKey) doc uploads
   reported by `--confirm` (content-addressed keys mean a re-run never inflates this —
   see Revert semantics).

## Revert semantics

**Compliance script** (`import-titans-compliance.ts --revert`): for each of the 21
CLUB_MAP clubs found on the tenant —

- **Pristine** (`affiliation === 'not_started'`, zero players, and every stored
  `docMeta` objectKey carries the `-import-` marker — i.e. nothing an admin or club rep
  has genuinely uploaded) → the whole club row is deleted via `repo.eraseClubData`
  (which also purges every S3 object under the club's own `docMeta`).
- **Not pristine** (any real progress) → only the import-marked doc keys are stripped
  (`docs[key] = false`, `docMeta[key]` removed) — see "Strip now deletes the S3 objects
  it de-references" below; everything else on the club — real affiliation progress, real
  uploads, roster — is left untouched.
- **`--all`** force-deletes every club **this import positively created** (via the
  `titans-import-created-clubs.json` manifest — see below), even if it's not pristine
  any more (e.g. an interrupted `--confirm`, or someone started progress on it before
  the revert). It **never** touches a club the import only **merged** into — a
  pre-existing club that happened to be missing a `ground`/`leagues` field this import
  filled in keeps its real chair/exco/CQI/roster/uploads untouched by `--all`, exactly
  like the no-`--all` case.
- **`--all --erase-preexisting`** additionally force-deletes a pre-existing (merged-into)
  club's real data. This is the ONLY way to erase a club the import didn't create — a
  separate, explicit opt-in on top of `--all`, never the default, because that data
  belongs to the club, not to this import.

### Why `--all` needs a positive "did this import create it" signal

`mine` (every club whose id is in `CLUB_MAP`) includes both clubs this import created
AND pre-existing clubs it only merged into — `admin-cc`/`test-cc` aren't in `CLUB_MAP`
so they're never touched either way, but a real pre-existing Titans club (unlikely for
this specific one-time import, but the script has no way to assume otherwise) could be.
The old `--all` erased every `mine` club unconditionally, including one it only merged
a missing `ground.venue` into — a real chair, real exco, a real roster, gone.

Every `--confirm` run of `import-titans-compliance.ts` records the id of every club it
actually **created** (not merged into) to a stable manifest,
`./titans-import-created-clubs.json` (gitignored — see `.gitignore`), merging with
whatever the file already had from a prior run. Each id is persisted the moment its
`createClub` is attempted — write-before-create, not batched at the end of the club
loop — so an interrupted run (throttle, expired credentials, Ctrl-C) never loses the ids
it already created; re-running converges instead of drifting. `--revert --all` reads
this manifest and force-deletes only the ids in it (plus whatever's already pristine,
which was always safe).

**If the manifest is missing or unreadable:**

- **`--all` alone** prints a warning and falls back to pristine-only deletion — the same
  as no `--all` — rather than guessing.
- **`--all --erase-preexisting` refuses outright.** Without a manifest this run cannot
  positively tell an import-created club apart from a pre-existing one it only merged
  into — and for THIS flag combination, "fall back to pristine-only" would be a lie:
  every non-pristine `CLUB_MAP` club would otherwise be treated as "pre-existing, force
  it" (`forcedPreexisting`) and fully deleted, which is exactly the destructive
  ambiguity `--erase-preexisting` exists to gate behind explicit intent. Fix or restore
  the manifest, or drop `--erase-preexisting` and accept the strip-only outcome.

A manifest that's **present but corrupt** (unreadable, truncated, hand-edited into
invalid JSON, or not a plain array of id strings) is never silently treated as empty on
a WRITE: `--confirm` aborts before touching anything rather than clobbering every id a
prior run recorded. On READ (`--revert`), a corrupt manifest is treated the same as a
missing one — "no positive evidence" — per the two bullets above.

(Why this signal and not something else: `onboardedVia` is typed to the single existing
value `'self-signup'` and isn't ours to repurpose — `types.ts` is out of scope for this
import; the audit note is appended to both created AND merged clubs, so it can't
discriminate between them; `club.version` isn't reliable either — a freshly created club
only stays at version 1 until the very next merge/doc-upload write touches it, which
routinely happens later in the same run. Recording creation at the moment it happens is
the only signal that can't drift from what actually occurred.)

**Keep `titans-import-created-clubs.json` until the import is fully signed off** —
alongside the `titans-import-backup-*.json` snapshots, it's local revert-support state,
not repo content (gitignored, never committed).

### Strip now deletes the S3 objects it de-references

The non-pristine strip path used to delete `docMeta[key]` and set `docs[key] = false`
but never issue an S3 delete — every import-uploaded document (including member
databases full of names, race, ID numbers, minors) stayed in the bucket unreferenced
forever (ADR 0009 deliberately has no lifecycle rule to clean these up). It now deletes
every S3 object the stripped keys reference — for a multi-file doc, every entry in
`files[]` that carries the `-import-` marker — best-effort with a `console.warn` on
failure (same pattern the HTTP routes use for their own doc-replace/delete paths): one
failed S3 delete doesn't abort the DynamoDB strip already in progress for that club. The
confirm summary line now reports the object count: `Reverted: 2 club(s) deleted, 5
club(s) stripped of import docs (11 S3 object(s) deleted).`

**Roster script** (`import-titans-roster.ts --revert`): deletes every player row whose
`registeredBy === 'import:titans-compliance-2026'` (the exact marker this import writes,
never a real chair/rep-registered row), then reconciles `playerCount` on every touched
club. Run the roster revert **before** the compliance revert if reverting everything —
a pristine-check on a club that still has import-created players will correctly refuse
the club-level delete.

Content-addressed S3 keys (`titans/${clubId}/${docKey}-import-${sha256.slice(0,16)}.${ext}`)
make a re-import after a partial revert idempotent: re-running `--confirm` never
re-uploads or duplicates a file whose content hash is already on record.

## Known limitations

- **Queenswood's roster is unimportable as supplied.** `QCC players database
2026-2027.xlsx` is a names-only template (one bare full-name string per age-group
  column, no surname/ID/DOB/gender/race column at all) — there is no identity data to
  build a `PlayerRegistration` from. It's on `SKIP_ROSTER` in `titans-import-map.ts`
  with the full reason; the roster script reports it and continues. The club needs a
  proper roster export before this can ever import — Queenswood's compliance
  _documents_ (league entry, committee, health tracker) import normally; only the
  player roster is blocked.
- **Excel-date-mangled junior IDs, strict mode.** Several clubs' junior sheets have the
  "ID number" column actually holding a date of birth (DACC's Junior Leagues sheet
  literally, and TUKS'/others' junior ID columns show Date-typed or date-shaped-string
  cells throughout). `cleanIdCell` in `roster-normalize.ts` correctly flags these as
  `date-mangled` (unrecoverable as an ID) and, when no separate DOB column exists, the
  parsed date is usable **only** as a dob-only identity — which strict mode (the
  default) drops into the per-club exception report. Re-run with `--allow-missing-id`
  to write these rows using name+dob identity instead of an ID.
- **Women's and Veterans teams need league keys configured before `--with-teams` can
  write them.** The structure workbook's `WOMEN'S PREMIER LEAGUE`, `WOMEN'S PROMOTION
LEAGUE` and `VETERANS LEAGUE` sections are fully parsed and reported (team counts,
  home venues, per-club rollups) but resolve to `leagueKey: null` — the tenant has no
  configured league key for them yet. Once the operator adds those leagues, extend
  `SECTION_LEAGUE_MAP` in `titans-import-map.ts` to map the section headers onto the
  new keys; until then, `--with-teams` only ever writes the 9 men's senior + 4 junior
  league keys.
- **Compliance spreadsheet documents download rather than preview inline.** The admin
  console's doc viewer renders PDFs in-browser but xls/xlsx/ods documents (the majority
  of this pack — league entry forms, assets registers, health trackers, member
  databases are almost all workbooks) download instead of previewing. Expected, not a
  bug in this import — verify those docs by downloading rather than expecting an inline
  preview.
- **One genuine source-data anomaly, documented not fixed**: the JUNIORS sheet's `U/11
GOLD A` section has a row where a venue name landed in the team-name cell (see
  `KNOWN_STRUCTURE_ANOMALIES` in `titans-import-map.ts` for the full diagnosis). Excluded
  from team counts, reported on every parse-only run, not resolved algorithmically —
  needs the union to identify the intended team.

# Lions (CGL) onboarding: master sequence

End-to-end order for standing up the Central Gauteng Lions ("CGL", tenant `lions`) on the
platform: tenant, clubs, fixtures, officer accounts, compliance documents and invites. The
league season starts **10/11 Oct 2026**, so the cutover is split. Tenant, affiliation,
fixtures and contacts `--data-only` go live by 8 to 10 Oct. Compliance and invite sends
follow in the week of 12 Oct.

Each importer has the usual family contract: `--parse-only` touches no AWS, dry-run is the
default, `--confirm` writes a gitignored JSON backup before anything else, and `--revert`
undoes it. **Every prod `--confirm` is user-run.** Claude prepares and dry-runs on dev only.

| stage | script (npm alias)                | detail runbook                                         |
| ----- | --------------------------------- | ------------------------------------------------------ |
| 1     | `configure-tenant-docs`           | this page                                              |
| 2     | `import-lions-affiliation`        | this page                                              |
| 3     | `bootstrap-lions-fixture-prereqs` | [lions-fixtures-import.md](./lions-fixtures-import.md) |
| 4     | `import-lions-fixtures`           | [lions-fixtures-import.md](./lions-fixtures-import.md) |
| 5, 7  | `import-lions-contacts`           | [lions-contact-import.md](./lions-contact-import.md)   |
| 6     | `import-lions-compliance`         | this page                                              |

Every tenant command below runs from the repo root as:

```bash
npx sst shell --stage <stage> -- npm --prefix packages/api run <alias> -- <flags>
```

Backups and stage-scoped manifests land in `packages/api/` (the `--prefix` working
directory). They hold officer contact details (POPIA) and are gitignored. Keep them until the
import is signed off, then delete them along with the pack.

## 0. Pack preparation (done 2 Oct 2026)

The raw pack is `~/Downloads/Lions` (156 files, about 115 MB). The importers read a cleaned
working copy in `~/Downloads/Lions/prepared/`. The originals are untouched.

- **Fixtures workbook** converted `.xlsb` → values-only `.xlsx`, and the Sunday grounds
  `.ods` → `.xlsx`. Verified with an independent reader: 0 diffs on all 13 sheets. See
  `prepared/conversion-fidelity-report.md`.
- **Compliance pack** cleaned into `prepared/compliance/`: 28 club folders, 30 byte-identical
  loose root duplicates dropped, 7 unique root files in `_root-unique/`, nested zips and
  Outlook `.msg` attachments extracted, Old Parktonians' `.pptx` also converted to PDF. See
  `prepared/compliance-manifest.md`.
- **CGL handouts**: `prepared/lions-club-list-signoff.md` (club identity, stage 2) and
  `prepared/lions-clash-and-capacity-questions.md` (grounds, stage 4).

**Pending user action:** export Azaadville's `ACC AGM Minutes .pages` to PDF in Pages.app and
save it as `prepared/compliance/Azaadville/ACC AGM Minutes .pdf`. The `.pages` file can't be
uploaded, and the extracted QuickLook image is page 1 only, so both are skipped. That
filename is already pinned to `agmMinutes` in `FILE_OVERRIDES`. Until it's there,
Azaadville has no AGM minutes, which is the correct outstanding signal. This only gates
stage 6.

## 1. Tenant, districts and document catalogue

1. **Operator portal (dev first, then prod):** create tenant `lions` with sport cricket,
   season label `2026-27` and CGL branding.
2. **Districts:** `Johannesburg`, `Sedibeng`, `Mogale City`, `West Rand`. The importers
   resolve these by pattern (`johannesburg|joburg|jhb`, `sedibeng`, `mogale`, `west rand`)
   and need exactly one configured match each. Zero or two matches abort with the
   configured list printed. Extra districts are fine.
3. **Catalogue:** 11 keys. `constitution`, `agmMinutes` (multi), `financials` (multi,
   unavailable ok, accepts `pptx`), `committee`, `memberDatabase`, `chairmansReport`
   (optional), `bankConfirmation`, `orgRegistration`, `beeCert` (optional), `clubLogo`
   (optional) and `clubRecords` (optional multi).

   ```bash
   … configure-tenant-docs -- lions             # dry-run
   … configure-tenant-docs -- lions --confirm
   ```

   **The pptx build must be deployed to the stage first.** `pptx`/`ppt` were added to
   `DocFormat` and `DOC_FORMAT_MIME` for this pack. Without it, `configure-tenant-docs`
   fails validation. Uploads are download-only; there is no inline pptx viewer.

4. **First CGL admin**, if known: `bootstrap-admin`. Otherwise operators approve and release
   (operators are auto-granted admin on new tenants).
5. **Tutorials:** lions starts with no tutorial config, so clubs see the shared default
   videos. Decide before invites (stage 7): upload lions videos, or set the no-fallback flag.

**Verify:** the tenant opens in the admin console with the four districts, and the club
portal's document list shows the 11 lions keys.

## 2. Affiliation: the club universe

`import-lions-affiliation` creates every club from the CGL 2026/27 affiliation form export,
plus the fixtures-only, T20-only and compliance-only clubs in `CLUB_MAP`. Created clubs get
their district, catalogue doc-key seeds and, for affiliated clubs, chair name, `exco.chair` /
`exco.sec`, home grounds and one audit note with the facilities summary. An existing club is
merged (absent fields only, never clobbered). It creates no users and sends nothing.

Expected parse: 43 responses → 42 clubs (UJ's earlier submission dropped), **49 clubs** in
total: 42 affiliated, 4 fixtures/T20-only (EP Ottomans, Marks Park, Marks Park Thistles, PAV
Soweto) and 3 compliance-only (Calypso, Diepsloot, Gauteng Lions Deaf). By district:
Johannesburg 37, Sedibeng 7, Mogale City 4, West Rand 1. The 7 non-affiliated clubs'
districts are best guesses, flagged `*`.

```bash
# Parse only (no AWS). --file defaults to ~/Downloads/Lions/CGL Affiliation 2026_27 (Responses) (2).xlsx
npx tsx packages/api/src/import-lions-affiliation.ts --parse-only

# Regenerate the CGL club-list sign-off after any CLUB_MAP change
npx tsx packages/api/src/import-lions-affiliation.ts --parse-only \
  --signoff ~/Downloads/Lions/prepared/lions-club-list-signoff.md

… import-lions-affiliation                    # dry-run: create/merge diff
… import-lions-affiliation -- --confirm
… import-lions-affiliation -- --confirm --club <club-id>   # one club
```

On a fresh tenant no league keys exist yet, so the affiliation import assigns no leagues and
says so. The fixtures import's club-league sync fills them in stage 4.

**CGL sign-off rule.** Club ids are baked into S3 keys, memberships and series snapshots at
`--confirm`, and there's no tooling to unpick a wrong merge. The sign-off went to CGL with a
**reply-by of 7 Oct**. If CGL is silent, proceed with the table as it stands, keeping
ambiguous identities **split** (Wits Lions vs Wits University, Marks Park vs Marks Park
Thistles). A wrong split is mendable; a wrong merge is not. The sign-off never blocks the
fixtures cutover. If CGL does reply, change `CLUB_MAP` (and the fixture map's aliases),
regenerate the sign-off, re-run the parses and only then `--confirm`.

**Verify:** the console lists 49 lions clubs with the right districts. Spot-check one
affiliated club's chair and secretary, and that Orange Farm exists (empty compliance folder,
still a club).

## 3. Fixture prerequisites

`bootstrap-lions-fixture-prereqs` adds the 15 league keys, merges the lions venue aliases into
the tenant config (so the API's release and in-season clash gates match the importer), and
seeds the venue registry with 66 canonical grounds. Idempotent, never overwrites.

```bash
npx tsx packages/api/src/bootstrap-lions-fixture-prereqs.ts --parse-only
… bootstrap-lions-fixture-prereqs
… bootstrap-lions-fixture-prereqs -- --confirm
```

Detail and the venue policy: [lions-fixtures-import.md](./lions-fixtures-import.md#prerequisites).

**Verify:** the console's Fixtures & Venues shows 66 registry grounds, and the league list
has the 13 sheet leagues plus the two T20 cups.

## 4. Fixtures

19 draft series: 1,513 league fixtures from 13 sheets plus 72 T20 pool fixtures.

```bash
npx tsx packages/api/src/import-lions-fixtures.ts --parse-only
… import-lions-fixtures                       # dry-run
… import-lions-fixtures -- --confirm
```

**Clash policy is a hard stop.** There's no `--allow-clashes`. Today there is exactly one
clash: Lens Tech 1, 4 Apr 2027 09:00 (Sunday 2 R22 v Sunday 4 R22), and it's on the CGL
question list. If CGL hasn't answered by cutover, write everything except the contested
series with `--only` and hold that one. The command and the other ways out are in
[lions-fixtures-import.md](./lions-fixtures-import.md#clash-policy-hard-stop).

Caveats to carry into the release and to CGL:

- **31 TBC fixtures** import venue-less. The release gate places each at its home club's
  ground and clash-checks it there, so set grounds from CGL's answers before releasing the
  affected series (Sunday 1 to 5 and HWB Premier T20 A Group B).
- **Results aren't displayable yet.** The played T20 rounds (20/27 Sep, 3/4 Oct) show as past
  fixtures with no outcome until the match-centre programme lands.
- **T20 semis and finals are a follow-up pass.** Pool rounds only. The Ladies semis/final on
  10 Oct go in once CGL names the qualifiers.
- **26 fixtures at 3 unregistered grounds** (Ferndale High School, Sir John Adams, Puntans)
  are written unlocked as venue overrides.

**Verify:** the checklist in
[lions-fixtures-import.md](./lions-fixtures-import.md#verification-checklist-after---confirm).

## 5. Contacts `--data-only` (cutover)

Creates each chairman's and secretary's Cognito user (welcome message suppressed), grants the
club-rep membership and fills any empty officer slot. **Sends nothing.** Expected: 84 officer
slots → 82 people, no blockers.

```bash
… import-lions-contacts -- --data-only        # dry-run
… import-lions-contacts -- --data-only --confirm
```

Neither the fixtures import nor the console release sends anything. Chairs push fixtures to
their players from the portal themselves, so nothing here depends on invites having gone out.

## 6. Compliance documents (week of 12 Oct)

`import-lions-compliance` attaches the cleaned pack's documents to the clubs stage 2 created.
It normally only merges (fills absent doc-key seeds, appends one audit note). If affiliation
hasn't run, it creates the doc club itself and records it in its own manifest. Uploads use
content-addressed keys (`lions/<clubId>/<docKey>-import-<sha16>.<ext>`), so re-runs are
idempotent, and a rep's own upload is never overwritten.

Expected parse: 131 files, **113 classified → 113 distinct uploads** for 28 clubs, zero
unclassified. 114 once the Azaadville PDF lands. Orange Farm has no folder and is skipped in
the doc pass only.

```bash
npx tsx packages/api/src/import-lions-compliance.ts --parse-only   # --dir defaults to prepared/compliance
… import-lions-compliance                     # dry-run: catalogue coverage + MIME checks
… import-lions-compliance -- --confirm
… import-lions-compliance -- --confirm --skip-docs                 # clubs only
… import-lions-compliance -- --confirm --club <club-id>            # one club
```

**memberDatabase stays outstanding** for every club. The 43 player databases are Drive links
in the affiliation form, and the roster import (Phase 6) waits on them being downloaded. That
is the correct compliance signal, not an import gap.

**Verify:** per-club doc counts match the parse report's upload preview. Open one PDF inline,
and check that Old Parktonians has both its pptx (download-only) and the converted PDF.

## 7. Contacts sends (user-run)

Invites to the 82 officers by email plus the `staff_portal_invite` WhatsApp template. Two
gates first, both from [lions-contact-import.md](./lions-contact-import.md):

1. **Origin gate.** Run the dry run with `WILDCARD_ENABLED=1
WILDCARD_WEB_SUFFIX=.club.medicoach.co.za`. The plan header must read
   `https://lions.club.medicoach.co.za`. Anything else, stop.
2. **Portal spot-check.** Someone signs in to the lions club portal and checks branding,
   fixtures and districts by hand.

```bash
WILDCARD_ENABLED=1 WILDCARD_WEB_SUFFIX=.club.medicoach.co.za \
npx sst shell --stage prod -- npm --prefix packages/api run import-lions-contacts -- \
  --channels email,whatsapp                   # dry-run
WILDCARD_ENABLED=1 WILDCARD_WEB_SUFFIX=.club.medicoach.co.za \
npx sst shell --stage prod -- npm --prefix packages/api run import-lions-contacts -- \
  --channels email,whatsapp --confirm
```

Use the same `--club`/`--skip-club` filters on every run.

## 8. Draft approval and release (admin console)

In Fixtures & Venues, approve and then release each `s-lions-*` series. The server-side
release gate re-runs the clash check with the tenant's venue aliases, including the TBC
fixtures at their home grounds. A 409 names the clashing fixtures: fix the venue in the
console, or get CGL's answer, then release again. Don't release a held series (stage 4
`--only` contingency) until its clash is resolved and it's imported.

**Verify** from a club rep's view: a club in each league sees its released fixtures, with
venue and time, in the club portal.

## Revert order

Undo in reverse dependency order: **roster (once it exists) → contacts → compliance →
fixtures → affiliation**. Each later import makes the clubs non-pristine, so the affiliation
revert skips any club with players, documents or affiliation progress, and says which import
to revert first.

```bash
… import-lions-contacts -- --revert [--manifest <path>]      # acts immediately, no dry-run
… import-lions-compliance -- --revert                         # strip import docs (dry-run)
… import-lions-compliance -- --revert --confirm
… import-lions-compliance -- --revert --all --confirm         # also delete clubs IT created
… import-lions-fixtures -- --revert                            # dry-run
… import-lions-fixtures -- --revert --confirm
… import-lions-affiliation -- --revert                         # dry-run
… import-lions-affiliation -- --revert --confirm               # delete pristine created clubs
```

- **Contacts** restores each person's lions membership from its pre-image, removes ones that
  didn't exist, and empties officer slots it filled that still hold that person. It leaves
  Cognito users in place and can't unsend messages.
- **Compliance** deletes only the S3 objects and doc entries this import wrote. A multi-file
  doc that also holds a rep's uploads keeps those files; only the import's entries go.
- **Fixtures** backs up, then deletes the 19 series. A released series in scope makes
  `--confirm` refuse unless you pass `--include-released`, because deleting it pulls it from
  club portals immediately. Leagues, registry and aliases stay.
- **Affiliation** needs its stage-scoped manifest
  (`lions-affiliation-created-clubs.<stage>.json`). Without it, nothing is deleted. It never
  deletes a club it only merged into.

The bootstrap and `configure-tenant-docs` have no revert. Their writes are additive config
and harmless on their own.

## Open items

- CGL: club-list sign-off (7 Oct), ground capacities and the Lens Tech 1 clash, grounds for
  31 TBC fixtures, the 9 inferred ground equivalences, Ladies T20 qualifiers.
- User: Azaadville `.pages` → PDF export (before stage 6), the 43 Drive player databases (for
  the roster phase), tutorials decision (before stage 7).
- Follow-ups: inline pptx viewer, Macrocomm cup fixtures if supplied, results once the match
  centre lands.

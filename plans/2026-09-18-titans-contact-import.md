# Titans Contact Import CLI Implementation Plan

> **Status:** COMPLETED — implemented, review-fixed and APPROVED on branch `titans-contact-import` (20 Sep 2026).
>
> **SUPERSEDED DETAIL — template secrets no longer exist.** After this plan was executed, the
> WhatsApp template-name SST secrets were replaced by the code registry
> `packages/api/src/notify/whatsapp-templates.ts` (see `docs/runbooks/whatsapp-templates.md`).
> Any `sst secret set Whatsapp*Template …` instruction below is historical: do NOT run it —
> the only WhatsApp precondition now is the template being Active in Meta under its registry
> name. This file is kept as a record of the plan as executed.

## Specification

**Problem:** The titans tenant (prod) has 22 clubs with no chairpersons, coaches, or staff recorded and no one invited to the portal. Titans supplied `TITANS CLUB CHAIRMANS CONTACT LIST- 2026-2027.xls` (22 club sections, 40 people, all with email, all but one with cell). Today the only path is the operator console's per-person rep-invite modal — no bulk path, and the WhatsApp staff-invite channel silently no-ops because no caller threads `cell` through, and the staff template body is changing to 4 variables (`{{1}}` name, `{{2}}` org, `{{3}}` email on file, `{{4}}` sign-in link — template `staff_portal_invite`, pending Meta review).

**Goal:** A CLI (`import-titans-contacts`) in the established Titans-importer pattern (dry-run by default, `--confirm` write gate, revert manifest) that parses the contact workbook, maps each person to their club, writes office-bearers into `Club.exco`/coach data, creates club-scoped `rep` accounts, and sends invites over email and/or WhatsApp. This session goes only as far as a successful dry run — no `--confirm` execution.

**Scope:**

- IN: workbook parser + tests, designation→role mapping, club-name alias resolution against the live club list, exco merge writes, `grantClubRep` account creation, `sendStaffInvite` sends with cell/name threaded, comm-log entries, revert manifest + `--revert`, 4-param staff WhatsApp template support in `notify/`.
- OUT: running `--confirm` anywhere; changing the HTTP invite routes' request shapes (routes keep sending email-only effectively); a batch HTTP endpoint/UI; Meta template creation (user is doing it); committing the spreadsheet or any PII to the repo.

**Success Criteria:**

- [ ] `npx tsx packages/api/src/import-titans-contacts.ts --file <xlsx> --parse-only` prints a full per-club plan with zero unexplained rows (40 people accounted for: mapped, or listed as blockers)
- [ ] Dry run against the dev stage resolves clubs from the live club list and reports account/send plans without writing
- [ ] Parser + mapping covered by tests with a synthetic fixture (no real PII in repo)
- [ ] `tsc --noEmit`, eslint, and the api test suite pass
- [ ] Unmatched club sections and exco-slot conflicts are hard blockers for `--confirm` (fail closed), surfaced in dry-run output

## Context Loading

_Run before starting:_

```bash
read packages/api/src/import-titans-compliance.ts   # the pattern to follow (flags, dry-run, manifest, revert)
read packages/api/src/titans-import-map.ts          # club id derivation + name normalization idioms
read packages/api/src/committee-parse.ts            # header aliases, cell cleaning idioms
read packages/api/src/notify/index.ts               # sendStaffInvite orchestrator
read packages/api/src/notify/whatsapp.ts            # sendStaffInviteWhatsApp, toE164, cleanParam
read packages/api/src/tenant-admin.ts               # grantClubRep, ensurePasswordlessUser usage
read packages/api/src/repo.ts                       # listClubs, appendClubCommEvents, claimInviteSend
read packages/api/src/origins.ts                    # canonicalWebOrigin
read packages/api/src/types.ts                      # Club.exco/coaches, ClubCommEvent kinds, Role
read packages/api/package.json                      # script registration pattern
read packages/api/test/import-titans.test.ts        # test idioms for importers (exceljs synthetic fixtures)
```

## Source data facts (verified 18 Sep 2026)

Sheet `"CLUB CONTACT LIST "` (trailing space), columns A–E from header row 8 (0-indexed 7): `NAME | SURNAME | DESIGNATION | Cellphone | E-mail`. Club section rows have ONLY the DESIGNATION cell filled (uppercase club name). 22 sections, 40 people. Known quirks:

- Typos: `Chariman` (Eersterust), `TITANS UMPIRES ASSCOCIATION`
- Combined designations: "Chairman, 1st Men and Ladies, Pta 3", "Club Chairman/ 1st Team & Snr Womens", "Vice Chairman and Treasurer", "IVCC Director of Cricket, Mens & Womens Head Coach"
- One person with no cell (the Centurion Kavaliers contact); leading-space emails; mixed-case emails; cell formats vary (`0NN NNN NNNN` spaced, `0NNNNNNNNN` unspaced, and one double-spaced landline-looking TUT number — values not reproduced here, PII)
- Sections needing aliases to system club names: CBC OLD BOYS→CBCOB, DIFFERENTLY ABLED→DACC, HARLEQUINS SENIORS→Harlequins, IRENE VILLAGERS CRICKET→Irene Villagers, POLICE→Police Cricket Club, PRETORIA→Pretoria Cricket Club
- Sections with no known system club: TITANS SCORERS ASSOCIATION, TITANS UMPIRES ASSCOCIATION (resolve against the LIVE club list — prod has 22 clubs vs the import map's 21, so one may exist)
- Queenswood Cricket Club is on the system but absent from the sheet (informational, not a blocker)
- File is legacy `.xls` (BIFF): CLI accepts `.xlsx` only (exceljs), with an error message telling the user to convert; a converted copy is produced outside the repo for the actual run

## Tasks

## Notify Tasks

### Task 1: 4-param staff WhatsApp template + cell threading

**Context:** `packages/api/src/notify/whatsapp.ts`, `packages/api/src/notify/index.ts`, existing notify tests if any

**Steps:**

1. [ ] `sendStaffInviteWhatsApp` gains `email` in its input and sends four body params in order: name (fallback `'there'`), orgName, email, link — matching template `staff_portal_invite`. Run ALL params through `cleanParam` (today it sends raw params, `whatsapp.ts:175-179`; sheet-sourced names/emails can carry whitespace Meta rejects — don't rely on callers pre-cleaning)
2. [ ] `sendStaffInvite` orchestrator passes `contact.email` through to the WhatsApp channel (email channel unchanged)
3. [ ] Update the comment block above `STAFF_TEMPLATE` to document the 4-param body and the pending `staff_portal_invite` name, and add an explicit warning: until the `WhatsappStaffTemplate` secret is repointed on a stage, that stage's default is the 3-param `club_onboarding_invite`, so a real staff-WhatsApp send there gets a Meta param-count rejection recorded as `failed` (email unaffected). This is acceptable — the path is unreachable via HTTP routes (none pass `cell`) and the CLI runbook pins the secret on BOTH dev and prod before any WhatsApp `--confirm`
4. [ ] Check all `sendStaffInvite` callers still type-check (they pass no `cell`/`name` — must remain valid, channels behave as today)
5. [ ] Tests: param order/count, email inclusion, and cleanParam application (dry-run mode returns synthetic ids; assert via the dry-run log path or by exporting a testable param builder)

**Verify:** `npm --prefix packages/api test -- notify` (or the suite's file filter) and `npx tsc --noEmit`

---

## Importer Tasks

### Task 2: Contact workbook parser + designation/club mapping (pure, no AWS)

**Context:** `packages/api/src/committee-parse.ts`, `packages/api/src/roster-normalize.ts`, `packages/api/src/titans-import-map.ts`, `packages/api/src/club-id.ts`

**Steps:**

1. [ ] Create `packages/api/src/titans-contacts-parse.ts`:
   - `parseContactsWorkbook(wb: ExcelJS.Workbook): ParsedContacts` — locates the header row (NAME/SURNAME/DESIGNATION headers, case/space-insensitive), walks rows, starts a new club section on rows where only DESIGNATION is filled, collects people rows (any of name/surname/email present). Trims/collapses whitespace, lowercases emails, keeps raw designation. Rejects workbooks where the header row or any expected column is missing (fail closed, name what's missing).
   - `mapDesignation(raw: string): DesignationMapping` — ordered regex table: chair-like (`/cha[ir]{2}(man|person|lady)?|chariman/i` — cover the typo) → `{ excoKey: 'chair' }`; `/vice/i` → `{ excoKey: 'vc' }`; `/treasurer/i` → `{ excoKey: 'tre' }`; `/secretar/i` → `{ excoKey: 'sec' }`; `/coach|director of cricket/i` → `{ coach: true }`; `/admin|manager/i` → `{}`; anything else → `{ unmapped: true }`. First match on a comma/slash-split of the designation wins for the exco slot; a combined "Vice Chairman and Treasurer" maps to `vc` only (one person, one slot) with the extra roles noted in the report. Every person regardless of mapping gets `invite: true` unless the CLI's `--data-only` is set (CLI concern, not the mapper's).
   - `resolveClubs(sections: string[], liveClubs: {id,name}[]): ResolvedClubs` — normalize both sides (uppercase, collapse spaces, strip trailing `CRICKET CLUB`/`CRICKET`/`CC`), apply the alias table from the source-data facts above, then exact-match. Returns matched pairs + unmatched sections + system clubs with no section. Never fuzzy-guesses: no match = unmatched.
2. [ ] Tests in `packages/api/test/titans-contacts-parse.test.ts` using a synthetic exceljs workbook (invented names/numbers, but structurally faithful: trailing-space sheet name, section rows, the `Chariman` typo, a missing cell, a landline, combined designations, a leading-space email). Cover: full parse shape, each designation-mapping branch, alias resolution, unmatched-section reporting, missing-column rejection.

**Verify:** `npm --prefix packages/api test -- titans-contacts`

---

### Task 3: The CLI — plan, dry-run, confirm, revert

**Context:** `packages/api/src/import-titans-compliance.ts` (pattern), `packages/api/src/tenant-admin.ts`, `packages/api/src/repo.ts`, `packages/api/src/origins.ts`, `packages/api/src/notify/index.ts`, `packages/api/package.json`

**Steps:**

1. [ ] Create `packages/api/src/import-titans-contacts.ts` with usage header; register npm script `import-titans-contacts`. Flags:
   - `--file <path>` (required; `.xlsx` only — detect BIFF via `isLegacyXlsBuffer` and error with a convert instruction)
   - `--parse-only` (no AWS: parse + mapping + designation report only)
   - `--confirm` (write gate; DEFAULT IS DRY-RUN — resolves clubs/users/origin read-only and prints the full plan)
   - `--club <name>` (filter to one section), `--skip-club <name>` (repeatable; explicitly skip a section — the ONLY way an unmatched section stops blocking `--confirm`)
   - `--channels <email,whatsapp>` (default `email`), `--data-only` (exco/coach writes only, no accounts/sends)
   - `--revert [--manifest <path>]`
   - tenant is hardcoded `titans` (this is a titans-specific importer, like its siblings)
2. [ ] Plan build (dry-run and confirm share it). CRITICAL: the unit of account work is the **email, not the row** — group people by lowercased email first (same person may chair two clubs). For each grouped person: club ids (all sections they appear under), designation mapping per club, exco action per club (`set` when slot empty; `keep` when slot already holds the same email; `CONFLICT` when it holds someone else — blocker; `DUPLICATE-SLOT` when two sheet rows in the same club map to the same slot — blocker), coach action, account action via lookup (`create` / `pending-exists (re-invite ok)` / `active (409 — skip account+send, report)` / `admin-elsewhere (blocker for rep grant)`), channel plan (email always if selected; whatsapp with `toE164` result, `no cell` skip, and a **landline heuristic**: ZA numbers not starting 06/07/08 after the leading 0 — e.g. the TUT `012` number — are marked `skipped (landline?)`, since `toE164` happily accepts them and a confirm would bill a Meta send to a landline), link = `canonicalWebOrigin('titans')` — if empty, sends are a hard blocker (never fall back to localhost in a CLI). **clubIds on grant are a UNION**: sheet clubs ∪ the person's existing titans-membership clubIds — `grantClubRep` (`tenant-admin.ts:87-88`) REPLACES the membership wholesale, so passing only the sheet clubs would strip scopes granted earlier. One send per email (not per club); the send's club-scoped idempotency marker uses the person's first resolved club; comm-log entries go to every club they're attached to. Replayed markers report as `sent-previously (skipped)` — a distinct summary category. If `listClubs` returns no clubs for the tenant on this stage, abort with a clear "tenant has no clubs on stage" error (dev may not have a titans cohort).
3. [ ] Dry-run output: per-club table + summary (counts by action) + BLOCKERS section (unmatched sections, exco conflicts, missing origin, admin-collisions). Exit non-zero if blockers exist. `--confirm` refuses to run while blockers exist (fail closed; no override flag).
4. [ ] Confirm path (BUILD but DO NOT RUN in this session): per grouped person, in order — exco/coach merge writes (RE-READ each club immediately before writing and merge only the planned slots into the current exco object, since `POST /clubs/:id/exco` is whole-object replacement and a rep may save concurrently; abort that person's exco write with a drift warning if the slot changed since planning); `grantClubRep` with the UNIONED clubIds when invited (extend `grantClubRep` with an optional `{ invitedBy }` opts arg that stamps `invitedAt`/`invitedBy` on the membership, matching the HTTP invite path at `index.ts:6368-6374`; existing callers unchanged); the full invite-marker lifecycle — `repo.claimInviteSend` (extend the `kind` union at `repo.ts:644` AND the `priorKind` cast at `repo.ts:679` with `'staff-invite'`), then `sendStaffInvite({email, name, cell, orgName, channels, link})`, then `repo.completeInviteSend` (`repo.ts:712`) on success and `repo.releaseInviteClaim` (`repo.ts:701`) in the per-person catch so a crash-before-send never blocks the person for the 72h TTL; `repo.appendClubCommEvents` with kind `'staff-invite'` (extend the API `ClubCommEvent` kind union) to each of their clubs, recording per-channel results. Per-person try/catch: a failure records the row, releases its claim, and continues; summary lists failures; process exits non-zero on any failure. Manifest (JSON, path printed) appended as writes land: **full prior membership snapshot** (not just "created" — grants replace, so revert needs the pre-image; `null` when the user had no titans membership), exco slots written (with prior value), created-user flags, comm-log keys.
5. [ ] `--revert`: from the manifest — restore each person's prior titans membership snapshot (remove the membership entirely when the pre-image is `null`). NOTE: no removal helper exists in `tenant-admin.ts`; the guarded logic lives inline in `DELETE /admin/users/:sub` (`index.ts:~6880-6899`, `writeUserGuarded`/`guardAdminDecrement`) — extract a shared `restoreMembership`/removal helper into `tenant-admin.ts` and have both the route and the CLI use it (reps never trip the admin guard, but use the guarded write anyway; never hand-write `USER#` items). Exco restore: re-read, and only restore a slot whose current value is exactly what this run wrote (skip + warn on drift). Does NOT delete Cognito users (harmless dormant OTP users; note this in usage) and cannot unsend messages (say so).
6. [ ] Tests in `packages/api/test/import-titans-contacts.test.ts` for the pure plan-builder (feed parsed contacts + a fake club list + fake existing-user lookups; assert actions, blockers, exco-conflict detection, channel skips). No AWS in tests.

**Verify:** `npm --prefix packages/api test -- import-titans-contacts && npx tsc --noEmit`

---

## Frontend Task

### Task 4: Comm-log label for the new kind

**Context:** `src/admin.tsx` (comm-log label map, ~:6251), `src/types.ts` (frontend `ClubCommEvent` kind union, ~:843-847)

**Steps:**

1. [ ] Add `'staff-invite'` to the frontend `ClubCommEvent` kind union (and add the veterans kinds the union is already missing, per the API union at `packages/api/src/types.ts:752-766`, so the two stop drifting)
2. [ ] Add a `commLabels['staff-invite']` entry (e.g. "Staff invite sent") — without it the fallback renders imported invites as "Onboarding invite", which misleads admins auditing the club

**Verify:** `npx tsc --noEmit`

---

## Runbook Task

### Task 5: Runbook + preflight

**Context:** `docs/runbooks/titans-compliance-import.md` (tone/structure), repo lint config

**Steps:**

1. [ ] `docs/runbooks/titans-contact-import.md`: convert step (.xls→.xlsx, outside the repo), parse-only → dev dry-run → prod dry-run → prod confirm sequence with exact commands (`npx sst shell --stage <stage> -- npm --prefix packages/api run import-titans-contacts -- ...`), the WhatsApp preconditions (template approved + `sst secret set WhatsappStaffTemplate staff_portal_invite` on **both dev and prod** + deploy — until then any real staff-WhatsApp send fails on Meta param-count against the 3-param default), landlines ride email-only (the `skipped (landline?)` heuristic), the Queenswood/associations findings, revert semantics (memberships restored from pre-image snapshots; messages cannot be unsent; Cognito users left dormant), POPIA note (names/org/email/link only in WhatsApp params)
2. [ ] Preflight: eslint + prettier + `tsc --noEmit` on touched files; full api test suite

**Verify:** `npx tsc --noEmit && npx eslint <touched files> && npm --prefix packages/api test`

## Execution notes

- Branch `titans-contact-import` off `main` (created)
- Converted workbook already at `/Users/carlton/Downloads/titans-contacts-2026-27.xlsx` — NOTE the conversion may have trimmed the sheet name's trailing space; the parser must match sheet names TRIMMED
- This session: implement, test, run `--parse-only` on the real file, then a dev-stage dry run (which may abort cleanly if dev has no titans cohort — that abort is itself a valid outcome). NO `--confirm` anywhere; prod dry-run is left to the user (prod reads are blocked for Claude)

## Review notes (devil's-advocate, 18 Sep 2026 — all folded in above)

1. **Destructive grant** — `grantClubRep` replaces the titans membership wholesale (`tenant-admin.ts:87-88`); fixed by grouping by email + unioning clubIds with existing membership + full pre-image snapshots in the manifest
2. **Marker lifecycle** — plan used `claimInviteSend` alone; added `completeInviteSend`/`releaseInviteClaim`, the `priorKind` cast extension, and the `sent-previously` replay category
3. **Revert helpers don't exist** — membership removal lives inline in the DELETE route; added the extract-shared-helper step and drift-guarded exco restore
4. **Intra-sheet slot collisions** — added `DUPLICATE-SLOT` blocker
5. **Frontend label fallback** mislabels the new kind as "Onboarding invite" — added Task 4
6. **Landline passes toE164** — added the 06/07/08 heuristic + email-only runbook rule
7. **3-param default template mismatch after Task 1** — documented; secret pinned on both stages in the runbook; `cleanParam` added to the staff sender
8. **Missing invite provenance** — `grantClubRep` gains optional `{ invitedBy }` stamping `invitedAt`/`invitedBy`

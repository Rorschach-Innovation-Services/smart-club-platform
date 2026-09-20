# Titans contact import — office bearers, coaches, and portal invites

One-time import of the Titans Cricket 2026-27 **club contact list** into the `titans`
tenant: each club's chairperson / vice / treasurer / secretary written into `Club.exco`,
coaches into `Club.coaches`, a club-scoped `rep` account created per person, and an invite
sent over email (and optionally WhatsApp). Complements the compliance/roster import — that
one loads clubs + documents + players; this one loads the **people** and gets them into the
portal.

**Input** (from the union, converted locally — never committed): the
`TITANS CLUB CHAIRMANS CONTACT LIST- 2026-2027` workbook. One sheet named
`CLUB CONTACT LIST ` (trailing space — the parser matches it trimmed), columns
`NAME | SURNAME | DESIGNATION | Cellphone | E-mail`, with an uppercase club name in the
DESIGNATION cell of each section-header row.

**Script**: `packages/api/src/import-titans-contacts.ts`. Mirrors
`import-titans-compliance.ts` exactly — `--parse-only` touches nothing, dry-run is the
default (no `--confirm`), every abort is fail-closed and printed with a reason, a backup is
written before any write, and `--revert` undoes cleanly. The parser + designation/club
mapping is pure and lives in `packages/api/src/titans-contacts-parse.ts` (no AWS), so
`--parse-only` runs under plain `npx tsx`.

## The .xls → .xlsx conversion (do this first, OUTSIDE the repo)

The union's file is a legacy `.xls` (Excel 97-2003 / BIFF). exceljs reads OOXML only, so the
importer detects a `.xls` and refuses with a convert instruction. Open it in Excel or
LibreOffice and **Save As `.xlsx`**. Keep the converted copy outside the repo — it holds
real personal contact details (POPIA). The reference converted copy for this import lives at
`/Users/carlton/Downloads/titans-contacts-2026-27.xlsx`.

> The conversion may trim the sheet name's trailing space; the parser matches the sheet name
> **trimmed**, and falls back to any sheet carrying a NAME/SURNAME/DESIGNATION header, so
> either way it resolves.

## Prerequisites

1. **The `titans` tenant exists on the target stage** with clubs already imported (this
   script resolves each section against the LIVE club list — run
   `import-titans-compliance.ts` first). If the tenant has no clubs on the stage, the dry-run
   aborts cleanly with "tenant has no clubs on this stage" — expected on a dev stage with no
   titans cohort.
2. **A canonical web origin for `titans`** (vanity host or wildcard). The invite link is
   `canonicalWebOrigin('titans')`; if it's empty, any run that would send is a hard blocker
   (a CLI never falls back to localhost). Email-only `--data-only` runs are unaffected.
3. **For WhatsApp sends only** — the four-param staff template must be live on the stage
   (see the WhatsApp preconditions below). Email needs nothing beyond SES being configured.

## The sequence

### 1. Parse-only (no AWS — iterate the mapping locally)

```bash
npx tsx packages/api/src/import-titans-contacts.ts \
  --file "/Users/carlton/Downloads/titans-contacts-2026-27.xlsx" --parse-only
```

Prints every section → club resolution, every person's designation → role mapping, the
unmatched sections, and any club with no section. Resolves against the known 21-club import
map (a live dry-run resolves against the real tenant, which may carry an extra club). Review
the **designation mappings** here before going further — a mis-mapped chair is the main risk.

Expected for the 2026-27 file: **22 sections, 40 people**, all with email, exactly one
person (Centurion Kavaliers) with no cell, the `Chariman` typo (Eersterust) and
`TITANS UMPIRES ASSCOCIATION` typo tolerated, combined designations resolving to one slot
(e.g. "Vice Chairman and Treasurer" → vice-chair, treasurer noted), the TUT `012` number
flagged `[landline?]`, and **two unmatched sections** — `TITANS SCORERS ASSOCIATION` and
`TITANS UMPIRES ASSCOCIATION` (the union scorers/umpires bodies, which have no system club).
Queenswood Cricket Club is on the system but absent from the sheet (informational).

### 2. Dev dry-run (read-only against the stage)

```bash
npx sst shell --stage dev -- \
  npm --prefix packages/api run import-titans-contacts -- \
  --file "/Users/carlton/Downloads/titans-contacts-2026-27.xlsx"
```

Resolves clubs/users/origin read-only and prints the full plan: per-person account action
(`create` / `pending-exists` / `active` / `admin-elsewhere`), exco slot actions
(`set` / `keep` / `CONFLICT` / `DUPLICATE-SLOT`), the unioned grant clubIds, and the channel
plan. Aborts non-zero if any blocker stands. If dev has no titans cohort, it aborts cleanly
with "tenant has no clubs on this stage" — that is a valid outcome, not a failure.

### 3. Prod dry-run

```bash
npx sst shell --stage prod -- \
  npm --prefix packages/api run import-titans-contacts -- \
  --file "/Users/carlton/Downloads/titans-contacts-2026-27.xlsx"
```

The scorers/umpires sections will be unmatched blockers unless prod carries a club for them.
Resolve each blocker deliberately: add the club first, or exclude the section with
`--skip-club "TITANS SCORERS ASSOCIATION" --skip-club "TITANS UMPIRES ASSCOCIATION"`.
`--skip-club` is the ONLY way an unmatched section stops blocking `--confirm`.

### 4. Prod confirm (writes — run by the deploy owner, never by Claude)

```bash
npx sst shell --stage prod -- \
  npm --prefix packages/api run import-titans-contacts -- \
  --file "/Users/carlton/Downloads/titans-contacts-2026-27.xlsx" \
  --skip-club "TITANS SCORERS ASSOCIATION" --skip-club "TITANS UMPIRES ASSCOCIATION" \
  --confirm
```

`--confirm` refuses to run while any blocker stands (no override flag). It writes exco/coach
data, grants rep accounts (unioning the sheet clubs with each person's existing membership —
`grantClubRep` replaces membership wholesale, so the union prevents stripping prior scopes),
and sends invites. A backup of the pre-run club state and an incremental revert manifest
(`titans-contacts-import-manifest.json`) are written. Per-person failures are recorded and
the run continues; the process exits non-zero if any person failed.

Useful modifiers: `--data-only` (exco/coach writes only, no accounts/sends), `--club "<SECTION>"`
(one section), `--channels email,whatsapp` (default is `email`).

**Re-runs must use the SAME `--club`/`--skip-club` filters as the first run.** Each person's
single send marker lives on their FIRST resolved club (the first section they appear under
that survives the filters). Changing the filters between runs can move that first-resolved
club, so the idempotency marker lands on a different club's keyspace, the replay guard misses,
and the person is sent a second invite. Keep the filter set identical across a first run and
any resend/repeat.

**Partial and total send failures on re-run.** The send marker is only _completed_ when at
least one channel actually sent; a person whose completed marker is replayed on a re-run shows
as `sent-previously` (skipped) and is not re-sent. If EVERY requested channel failed (e.g. a
WhatsApp send rejected because the template isn't Active in Meta yet, with no email selected), the run releases
that person's claim and records a per-person failure — so a corrected re-run can send. But a
PARTIAL failure (one channel sent, another failed) completes the marker: that person is
`sent-previously` on the next run and the failed channel is **not** retried automatically. To
resend the failed channel you must either let the marker's 72h TTL lapse, or fix the underlying
cause (e.g. get the WhatsApp template Active in Meta) and use a fresh idempotency key / fresh
claim.

## WhatsApp preconditions (email needs none of this)

The staff sender emits **four** params for the dedicated template `staff_portal_invite`
({{1}} name, {{2}} org, {{3}} email on file, {{4}} sign-in link). The template name +
language live in the code registry `packages/api/src/notify/whatsapp-templates.ts` (entry
`staffInvite`) — there is no per-template secret to set. Before any WhatsApp `--confirm`:

1. Confirm `staff_portal_invite` is **Active in Meta** (4-param Utility body). It has been
   Active since 18 Sep 2026 (template id 1388345850069490).
2. The deployed API must be running the 4-param sender code — i.e. this change must be
   deployed to the target stage (`npx sst deploy --stage <stage>`). No `sst secret set` is
   needed. Note the import CLI itself runs your **local** code under `sst shell`, so the
   import doesn't wait on a deploy; the deploy only matters for the API's own runtime sends.
3. Landlines ride email only. The importer flags ZA numbers whose subscriber part doesn't
   start 06/07/08 (e.g. the TUT `012` number) as `skipped (landline?)` — `toE164` would
   otherwise happily bill a Meta conversation to a number that can never receive it.

## Revert

```bash
npx sst shell --stage <stage> -- \
  npm --prefix packages/api run import-titans-contacts -- \
  --revert [--manifest ./titans-contacts-import-manifest.json]
```

Restores each person's titans membership from the **pre-image snapshot** in the manifest
(removing the membership entirely — full offboard — when they had none before), through the
shared guarded `restoreMembership` helper (never a hand-written USER# item, and the
last-admin guard still applies). Exco slots are restored only where the current value is
still exactly what this run wrote (drift is skipped + warned). Coach entries this import
appended are removed too, matched on the person's email **and** the import's `source` tag —
a coach entry added or edited by anyone else is left intact. Revert does **NOT** delete
Cognito users — a dormant passwordless OTP user with no membership has no access and is
harmless — and it **cannot unsend** messages already delivered.

## POPIA

WhatsApp params carry only name, org, the recipient's own email, and the sign-in link — no
other personal data. The converted workbook and the manifest/backup files hold real contact
details and must stay outside the repo. Nothing in this import is committed.

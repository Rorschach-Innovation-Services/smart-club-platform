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

> **Origin env vars are required.** `sst shell` injects linked resources and secrets but NOT
> the Lambda's plain env, so `WILDCARD_ENABLED`/`WILDCARD_WEB_SUFFIX` are unset and
> `canonicalWebOrigin('titans')` resolves to nothing — the run then blocks with
> "no canonical web origin for titans". Prefix both commands below with the same values prod's
> Lambda carries (see sst.config.ts / infra/tenants.ts):
> `WILDCARD_ENABLED=1 WILDCARD_WEB_SUFFIX=.club.medicoach.co.za`
>
> **The send secrets need no prefix.** `sst shell` exposes the `FromEmail`,
> `WhatsappAccessToken` and `WhatsappPhoneNumberId` secrets only as `SST_RESOURCE_*` JSON, not
> as the `FROM_EMAIL` / `WHATSAPP_*` env the notify senders read. The CLI copies them across at
> startup (before the senders load; an env value you set yourself wins) and prints
> `· notify config from SST linked secrets: FROM_EMAIL, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID`.
> If that line is missing or incomplete, a secret is unset on the stage and `--confirm` will
> refuse (see the dry-run send guard below). `SES_REGION` already defaults to `eu-west-1`,
> the Lambda's value.

```bash
WILDCARD_ENABLED=1 WILDCARD_WEB_SUFFIX=.club.medicoach.co.za \
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
WILDCARD_ENABLED=1 WILDCARD_WEB_SUFFIX=.club.medicoach.co.za \
npx sst shell --stage prod -- \
  npm --prefix packages/api run import-titans-contacts -- \
  --file "/Users/carlton/Downloads/titans-contacts-2026-27.xlsx" \
  --skip-club "TITANS SCORERS ASSOCIATION" --skip-club "TITANS UMPIRES ASSCOCIATION" \
  --confirm
```

`--confirm` refuses to run while any blocker stands (no override flag).

**Dry-run send guard.** Before it writes anything (backup, exco, accounts, send markers),
`--confirm` checks every channel you requested with `--channels`. If any of them is in notify
dry-run (`FROM_EMAIL` unset for email; `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID`
unset for WhatsApp; or `NOTIFY_DRY_RUN=1`) and at least one invite is planned, it aborts with
e.g. `email channel is in notify dry-run (FROM_EMAIL unset) — refusing --confirm`. A dry-run
"send" returns a fake success and the run would complete that person's send marker, so the
real invite would never go out and a plain re-run would skip them (the 29 Sep 2026 incident).
`--allow-dry-run-sends` overrides the guard for a deliberate no-real-send test only; it prints
a warning banner and still completes the markers, so a later real send needs `--resend`.
`--data-only` plans no sends, so the guard never fires for it.

After the guards, `--confirm` writes exco/coach
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
cause (e.g. get the WhatsApp template Active in Meta) and re-run with `--resend` (which claims
a fresh key). `--resend` re-sends **every** channel to **everyone** invite-planned, not just
the failed channel.

## Recovery: the 29 Sep 2026 dry-run sends (`--resend`, run once)

**What happened.** The prod `--confirm --channels email,whatsapp` run on 29 Sep 2026 wrote
the exco/coach data and the Cognito/DynamoDB accounts correctly. But all 38 invites went out
in notify dry-run, because `sst shell` doesn't set `FROM_EMAIL` / `WHATSAPP_*` (see step 3).
Each "send" returned a fake success, so the CLI **completed** all 38 `staff-invite` markers
(key `staff-import-<email>`). A plain re-run reports everyone `sent-previously` and sends
nothing. (Those markers expire 72h after the run, around 2 Oct 2026. `--resend` works before
and after that.)

**The fix.** `--resend` claims a different key per person (`staff-import-<email>#resend`), so
the completed markers are ignored and the invite goes out. The rest of the run is already
idempotent. Accounts show `pending-exists` and are re-granted with the same union of clubs,
and exco slots show `keep`, so nothing is written twice. A re-run with `--resend` does
nothing except send the invites. Anyone who has signed in since 29 Sep shows `active` and is
not re-invited.

**Rules.**

- Use `--resend` **once**, for this incident. It sends to **everyone** the run matches, so
  use the **same** `--skip-club` filters as the 29 Sep run. Different filters change who
  matches and which club holds each person's marker.
- The `#resend` key is fixed. If the resend run is interrupted, running the same command
  again skips the people it already reached (they show `sent-previously` on the resend key
  for 72h) and sends only to the rest.
- Do the dry-run first (same command without `--confirm`) and check that the
  `notify config from SST linked secrets: FROM_EMAIL, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID`
  line is printed. If a secret is missing, the `--confirm` run stops before it writes or
  sends anything.

```bash
# 1. dry-run preview (read-only)
WILDCARD_ENABLED=1 WILDCARD_WEB_SUFFIX=.club.medicoach.co.za \
npx sst shell --stage prod -- \
  npm --prefix packages/api run import-titans-contacts -- \
  --file "/Users/carlton/Downloads/titans-contacts-2026-27.xlsx" \
  --skip-club "TITANS SCORERS ASSOCIATION" --skip-club "TITANS UMPIRES ASSCOCIATION" \
  --channels email,whatsapp --resend

# 2. the recovery send (deploy owner only)
WILDCARD_ENABLED=1 WILDCARD_WEB_SUFFIX=.club.medicoach.co.za \
npx sst shell --stage prod -- \
  npm --prefix packages/api run import-titans-contacts -- \
  --file "/Users/carlton/Downloads/titans-contacts-2026-27.xlsx" \
  --skip-club "TITANS SCORERS ASSOCIATION" --skip-club "TITANS UMPIRES ASSCOCIATION" \
  --channels email,whatsapp --confirm --resend
```

Expect the summary line `· granted N rep account(s), 38 invite(s) sent, 0 already-sent (replay), …`.
N is the number of people still not signed in; the invite count falls by the same amount if
anyone has signed in since. A new comm-log entry per channel is added to each club, next to
the 29 Sep dry-run entries.

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

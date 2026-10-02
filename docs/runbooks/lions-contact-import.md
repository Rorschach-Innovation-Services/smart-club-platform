# Lions (CGL) contact import: officer accounts and portal invites

`packages/api/src/import-lions-contacts.ts` (npm alias `import-lions-contacts`) gives every
affiliated CGL club's **chairman** and **secretary** a club-rep portal account and, when you ask
for it, sends them the staff invite. It reads the same CGL 2026/27 affiliation form export as
`import-lions-affiliation` and parses it with the same `lions-affiliation-parse.ts`, so club
resolution, phone normalisation and email cleaning are identical. Chairman maps to exco slot
`chair` and secretary to `sec`.

It is adapted from `import-titans-contacts.ts` (see `titans-contact-import.md`). The send path
is unchanged: SES email plus the 4-param WhatsApp `staff_portal_invite` template, the
dry-run send guard, idempotent send markers, `--resend`, `--allow-dry-run-sends`, the
`SST_RESOURCE_*` secret bootstrap, `grantClubRep`/`restoreMembership` (never a hand-written
USER# item), the blocker report and the revert manifest.

**Two differences from Titans:**

- **`--data-only` grants memberships.** It creates the Cognito user (with Cognito's welcome
  message suppressed), grants the rep membership and fills any empty officer slot, but sends
  nothing. Titans' `--data-only` skipped the grant. This is the mode the fixtures cutover runs.
  A later send run sees these people as `pending-exists`, re-grants them idempotently and
  sends.
- **Officer slots are usually already filled.** `import-lions-affiliation` writes
  `exco.chair`/`exco.sec` from the same form data, so the normal slot action is `keep` and
  nothing is written. A slot holding a _different_ email is a `CONFLICT` blocker and is never
  overwritten.

## Data-quality handling (2026/27 form)

| Case                                                                           | Handling                                                                                                                                                             |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Several emails in one cell (Soweto Pioneers sec, Orange Farm chair + sec)      | First email used; reported as `form-warning`                                                                                                                         |
| Landline number (VUT chairman, `016…`)                                         | Email only (`whatsapp:skip(landline?)`); reported                                                                                                                    |
| Chairman and secretary give **one email** (Heidelberg, Riverlea)               | One account holding both slots. The invite's name and WhatsApp cell come from the officer whose name appears in the email address. Each slot keeps its own form name |
| Chairman and secretary give **one cell** under different emails (Trent Bridge) | Two accounts. The secretary is invited by email only, so one phone never gets two WhatsApps                                                                          |
| Extra numbers in one cell (Noordgesig chairman)                                | First number used; reported                                                                                                                                          |
| Blank officer                                                                  | Slot left empty; reported, not a blocker                                                                                                                             |
| Officer with details but no usable email                                       | **Blocker**: an account is keyed by email                                                                                                                            |
| Club with no affiliation response (7 clubs)                                    | Reported as "no officers to invite"                                                                                                                                  |

Expected `--parse-only` output for the 2 Oct 2026 file: 43 responses → 42 clubs (UJ's older
submission dropped), **84 officer slots → 82 people** (two shared emails), 80 WhatsApp-capable
and 2 email-only (VUT landline, Trent Bridge shared cell), 7 clubs with no contacts, **no
blockers**.

## Prerequisites

1. The `lions` tenant exists on the stage and `import-lions-affiliation --confirm` has run.
   Every affiliated club must be on the stage; a missing one is a blocker.
2. **For sends only:** a canonical web origin for `lions`. The invite link is
   `canonicalWebOrigin('lions')`. `sst shell` doesn't carry the Lambda's plain env, so prefix
   the command with `WILDCARD_ENABLED=1 WILDCARD_WEB_SUFFIX=.club.medicoach.co.za`. The plan
   header prints the resolved origin. **Gate (plan amendment 9): it must read
   `https://lions.club.medicoach.co.za` before any send.** `--data-only` needs no origin.
3. **For WhatsApp only:** `staff_portal_invite` must be Active in Meta. It is already approved
   for Titans, and no new template is needed (see `titans-contact-import.md`).
4. **Gate before any send `--confirm`:** someone has checked the lions portal (branding,
   fixtures, districts) by hand.

## Sequence

```bash
# 1. Parse-only (no AWS). --file defaults to ~/Downloads/Lions/CGL Affiliation 2026_27 (Responses) (2).xlsx
npx tsx packages/api/src/import-lions-contacts.ts --parse-only

# 2. Dev dry-run (read-only)
npx sst shell --stage dev -- npm --prefix packages/api run import-lions-contacts -- --data-only

# 3. Fixtures cutover (prod, user-run): memberships + slots, NO sends
npx sst shell --stage prod -- npm --prefix packages/api run import-lions-contacts -- --data-only
npx sst shell --stage prod -- npm --prefix packages/api run import-lions-contacts -- --data-only --confirm

# 4. Week of 12 Oct, after the portal check (prod, user-run): invites
WILDCARD_ENABLED=1 WILDCARD_WEB_SUFFIX=.club.medicoach.co.za \
npx sst shell --stage prod -- npm --prefix packages/api run import-lions-contacts -- \
  --channels email,whatsapp                     # dry-run: check origin + the notify-secrets line
WILDCARD_ENABLED=1 WILDCARD_WEB_SUFFIX=.club.medicoach.co.za \
npx sst shell --stage prod -- npm --prefix packages/api run import-lions-contacts -- \
  --channels email,whatsapp --confirm
```

`--confirm` refuses while any blocker stands. `--skip-club "<id or name>"` (repeatable) is the
only escape hatch. `--club "<id or name>"` limits the run to one club. **Use the same
filters for every run**: each person's single send marker lives on their first club.

The dry-run send guard, partial-failure behaviour and `--resend` semantics are exactly as in
`titans-contact-import.md`. A `--data-only` run never trips the guard because it plans no
sends.

## Manifest, backup and revert

`--confirm` writes a club backup (`lions-contacts-import-backup-<ts>.json`) and an incremental
revert manifest next to it. The manifest is stage-scoped by default
(`lions-contacts-import-manifest.<stage>.json`), so a dev manifest can't be reverted against
prod. Repeat runs merge into it and keep the earliest pre-image.

```bash
npx sst shell --stage <stage> -- npm --prefix packages/api run import-lions-contacts -- \
  --revert [--manifest <path>]
```

Revert restores each granted person's lions membership from its pre-image through
`restoreMembership`. A person with no prior membership is removed, and fully offboarded if it
was their only membership. It also empties officer slots this import filled, but only those
still holding that person. It leaves Cognito users in place and cannot unsend messages. In the
revert order (roster → contacts → compliance → fixtures → affiliation), contacts come before
affiliation.

## POPIA

The workbook, manifest and backups hold real contact details. They stay out of the repo
(gitignored). WhatsApp params carry only name, org, the recipient's own email and the sign-in
link.

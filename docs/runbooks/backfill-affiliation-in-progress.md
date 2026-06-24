# Runbook — Backfill stuck `not_started` clubs to `in_progress`

**Owner:** runs in the **medicoach AWS account** (`af-south-1`), against the prod
DynamoDB table. **App code change:** already shipped (see below) — this is the one-time
data step to finish the rollout.

**Why:** Before this change the backend never wrote `affiliation: 'in_progress'` — clubs
went straight `not_started → complete` on submit. A club that filled its affiliation form
but only **saved a draft** (or saved the standalone Exco step) kept `affiliation:
'not_started'` next to a fully-populated `exco`, so the admin console showed
"Pending / Awaiting submission" beside a filled form — looked "out of sync."

---

## What shipped in code (deploy first)

- `PATCH /clubs/:id` and `POST /clubs/:id/exco` now set `not_started → in_progress` on the
  first save that carries affiliation-form data (`exco`/`leagues`/`coaches`/`ground`).
  Never downgrades `complete`; never overrides an explicit `affiliation` (submit still sends
  `complete`). So **new** draft saves are correct without any backfill.
- The admin UI now shows three states — _Pending_ / _In progress · draft saved_ / _Submitted_
  — and the affiliation-form modal labels draft data "not yet submitted."

EXISTING records won't gain `in_progress` until their next save (an abandoned draft may
never save again), so backfill them once.

## Backfill (run AFTER the API deploy)

The script is **dry-run by default** and only touches `not_started` clubs with real draft
evidence (`hasAffiliationDraft` — a named non-chair officer, additional members, chair
governance fields, leagues, coaches, or a populated ground). It deliberately ignores the
`docs.exco` flag, so an admin "Mark as compliant" override does **not** flip an untouched
club. `complete` and already-`in_progress` clubs are never modified. Idempotent — safe to
re-run; uses optimistic-concurrency (a concurrent rep save 409s and is skipped, re-run picks
it up).

```bash
# 1. Dry-run — lists which clubs WOULD change, writes nothing.
sst shell --stage prod -- npx tsx packages/api/src/backfill-affiliation-in-progress.ts dolphins

# 2. Review the list. For prod today this should be the draft clubs among the 8 not_started
#    (e.g. amanzimtoti-cricket-club). Bare signup-only clubs must NOT appear.

# 3. Apply.
sst shell --stage prod -- npx tsx packages/api/src/backfill-affiliation-in-progress.ts dolphins --confirm
```

`<tenant>` is the union slug (`dolphins` for prod). Swap `--stage prod` for `--stage dev` to
rehearse on dev first.

## Verify

```bash
# Re-query the formerly not_started clubs — drafts should now read in_progress.
aws dynamodb query --profile medicoach --region af-south-1 \
  --table-name dolphins-smart-club-prod-DataTable-bbxuffsw \
  --index-name gsi1 \
  --key-condition-expression "gsi1pk = :p" \
  --expression-attribute-values '{":p":{"S":"TENANT#dolphins#TYPE#CLUB"}}' \
  --projection-expression "id, affiliation" --output json
```

In the admin console, a backfilled club now shows **"In progress · draft saved"** on the
phase card, top KPI, club-details Status, and the clubs-list pill; opening **View affiliation
form** shows the populated fields with a "Draft — not yet submitted" note. Affiliated counts
and league eligibility are unchanged (those gate on `complete`).

# Runbook — Backfill clearances for players who declared an on-system previous club

**Owner:** runs in the **medicoach AWS account** (`af-south-1`), against the prod DynamoDB
table. **Status: already executed against prod on 29 Jul 2026** — 46 clearances opened,
0 failed. This runbook is the record of that run and the procedure if it is ever needed
again (a new tenant, or a re-run after the fixes below).

> ⚠️ **The 29 Jul run went BEFORE the code deploy. Do not repeat that ordering.**
> The protection these 46 clearances depend on — the server-side refusal to reject a clearance
> whose source club has no record of the player — lives in the same undeployed change. Until
> the API ships, the union console shows an **enabled Reject button** on all 46, and one click
> permanently flags a legitimately registered player (see Aftercare). Between the backfill and
> the deploy, the only protection is telling the union office not to action them.
>
> **Deploy the API first, then run the script.** If a run has already happened out of order,
> deploying is the highest-priority remediation, not a follow-up.

**App code change:** ships together with the rule change in `createSelfRegistration`. The
backfill without the rule change would refill within days; the rule change without the
backfill leaves the existing population uncleared.

---

## Why

`createSelfRegistration` used to decide "does this need a clearance?" from **roster
presence**: it looked the player up across the union by `naturalKey` (`sha256("sa-id-<id>")`).
A player who declared a previous club that _is_ on the system but had no roster row for them
fell through to a plain `active` registration, with the club name kept as history text only.

That assumed every club's roster on the platform is complete. It is not — a club still
digitising its squad is indistinguishable from one the player never played for, and the
fees/misconduct obligation a clearance settles is owed in the real world either way. The rule
was also inverted relative to risk: a previous club **not on the system at all** (a directory
entry) opened a real clearance, while one that **was** on the system — reachable, able to flag
unpaid fees — got none.

It dropped roughly 1–2 transfers a day. An earlier one-off remediation
(`backfill-registration-clearance.ts`, 16 Jul 2026, 7 players) treated this as a legacy
backlog — its docstring says the players "registered before the transfer-clearance flow
existed" — but the flow shipped on 13 Jul (`6ad0456`), so the gap simply refilled.

## What the script does (and refuses to do)

`packages/api/src/backfill-declared-club-clearance.ts` enumerates the affected population
itself — it takes only a tenant, never a player. A player is affected when **all** of:

- they self-registered (`registeredVia: 'link'`). Chair-entered rows (`'portal'`) take
  `lastClub` as free history text and no live path could open a clearance for them;
- they are `active`;
- their `lastClub` names an on-system club other than their own;
- they hold no clearance under their identity, **as either source or destination**;
- they have no row at that source club (a rostered player is `open-clearance.ts`'s case).

For each, one transaction writes the canonical + mirror clearance items (`origin:
'registration'`, **no** `fromClubDirectory`) and flips the destination row `active` →
`clearance-pending`, normalising `lastClub` to the source club's canonical name.

It is deliberately **sourceless**: no placeholder roster row at the source club and no source
`playerCount` change. That matches `repo.createPlayerWithSourcelessClearance`, which the fixed
live path uses, and is safe because `resolveClearance` and `rejectClearance` both branch on the
source row's _actual_ absence rather than on `fromClubDirectory`. The older
`backfill-registration-clearance.ts` writes a placeholder because it predates that tolerance —
**prefer this script** for the declared-club case.

Refusals, all of which abort before any write:

- two clubs whose names normalise identically (would misroute a clearance silently);
- the affected population changing between the dry run and `--confirm` — the operator approved
  a list they read, so a registration landing in between must not be swept in unreviewed.

Per-player transactions are isolated: one conflicting row does not abandon the rest, and a
`TransactionCanceledException` is reported with its `CancellationReasons` codes
(`[0]` clearance id replay, `[1]` mirror, `[2]` player row gone or no longer active).

### Known scope caveat

The live rule keys on the `lastClubId` the form posted; the script keys on a normalised
**name** match, because `lastClubId` is not persisted on the row. It is therefore slightly
broader: a player who typed an exact on-system club name into "Other" is swept here but would
not be by the live path. That is deliberate — they declared that club either way — but it
means the two predicates are not identical, and after the fact there is no way to tell which
of the 46 came from the dropdown and which from free text.

## Procedure

Dry-run first, always. It prints the full affected list and writes nothing.

```sh
AWS_PROFILE=medicoach AWS_REGION=af-south-1 \
TABLE_NAME=dolphins-smart-club-prod-DataTable-bbxuffsw \
npx tsx packages/api/src/backfill-declared-club-clearance.ts dolphins
```

Read the list. Then, to write:

```sh
AWS_PROFILE=medicoach AWS_REGION=af-south-1 \
TABLE_NAME=dolphins-smart-club-prod-DataTable-bbxuffsw \
npx tsx packages/api/src/backfill-declared-club-clearance.ts dolphins --confirm
```

Verify independently afterwards — do not trust the script's own enumeration alone. A
table-wide `scan` filtered to `begins_with(sk, "CLEARANCE#")` catches directory-slug
partitions that a per-club sweep would miss; a second count that agrees is the check that
matters.

## The 29 Jul 2026 run

46 players, 0 failures. Prod clearance count went 11 → 57. All 46 were `registeredVia: 'link'`,
and no player ended up holding more than one clearance. Largest clusters:

| Source club             | Destination                       | Players |
| ----------------------- | --------------------------------- | ------- |
| Harlequins Cricket Club | Forest Hills Cricket Club         | 9       |
| Newlands Cricket Club   | Simplex Reservoir Hills Crimson   | 3       |
| African Warriors CC     | Hollywoodbets Chatsworth Sporting | 2       |

The Harlequins → Forest Hills cluster looks like a genuine club-to-club movement that never
went through clearance.

### Second prod mutation, same day: the note rewrite

The backfill's first `note` was written for us, not for the club rep who reads it verbatim on
their pending card ("Backfilled: the declared previous club was on the system but had no roster
record…"). `packages/api/src/patch-backfill-clearance-notes.ts` replaced it with text that
answers the rep's actual questions — why they are being asked about someone they have no record
of, and what their options are.

Run against prod the same day: **46 rewritten, 0 failed**. Verified afterwards: 0 of the 29 Jul
batch still carry the old text, 92 items carry the new one (46 × canonical + mirror, so both
sides moved together), the 16 Jul batch's 14 items were untouched (it used different text and
the match is exact), and status counts were unchanged — 98 pending / 2 admin-override / 14
approved, the same 57 clearances as before.

The script is exact-match guarded on the old text AND `status === 'pending'`, so it is a no-op
on a re-run and never edits a clearance a club has already actioned. It touches only `note` —
no status, roster, or counts. Canonical and mirror are written sequentially rather than in a
transaction: if the mirror write ever failed after the canonical succeeded, a re-run would skip
that pair (enumeration reads the canonical, which no longer matches) and the mirror would keep
the old text. It did not happen here, but check both sides if it is ever re-run.

## Aftercare — this is the part that matters

**Never reject these.** Rejection flags a legitimately active player `clearance-rejected`,
which is terminal: there is no reactivation endpoint, and for a sourceless clearance the
destination row is the player's only registration record. Recovery means deleting the row —
which purges the S3 ID doc and loses `createdAt`/`consentAt` — and re-registering from scratch.

Once the change ships this is **server-enforced**, not just documented:
`POST /admin/clearances/:cid/reject` returns 409 for any registration-origin clearance whose
source club holds no row for the player, and the admin console disables the button and explains
why. Do not weaken that guard.

**Until it is deployed, none of that is running.** Check before relying on it — if
`GET /admin/clearances` returns no `sourceRostered` field on pending registration-origin
clearances, the guard is not live and the console's Reject button is enabled.

The available resolutions are:

- the source club approves in its portal (correct when the player did play there);
- the union office **overrides & approves**;
- the union office **reallocates** the clearance to the club the player actually left — the
  right tool when the player picked the wrong on-system club.

### Disposing of a clearance that should never have existed

Junk from a leaked registration link, or a player who named a club they genuinely never played
for. Reject is refused for these (above) and the player cannot be deleted while
`clearance-pending`, so the procedure is two steps:

1. **Override & approve, with a reason.** Write what actually happened —
   _"not a real registration, removing"_. This is not optional in spirit: without it the
   resolved record reads as _"the Union approved this transfer"_ for a transfer that never
   happened, and this history is read for disputes. The reason is stored as `overrideReason`
   and shown on the resolved card.
2. **Delete the player** from the destination club's roster — Clubs → the destination club →
   Players → the player's row. (A union admin can reach any club's roster; `assertClubAccess`
   returns early for role `admin`.) The delete guard only blocks
   `clearance-pending`, so it works once step 1 has resolved the clearance. `repo.deletePlayer`
   also purges the player's ID documents from S3, so nothing personal is left behind.

Step 2 is optional if the player is legitimate and simply named the wrong club — the override
plus its reason is the whole fix, and they stay active at the club they registered with.

There is deliberately no cancel/void route. Override-with-a-reason was chosen over a distinct
`voided` status because it reuses a path the union already knows, and the annotation carries
the information a separate status would have. Revisit if disposal becomes frequent enough that
scanning the history for annotated overrides is a chore.

There are **no notifications** for clearances, so nothing tells those clubs to act. Expect
club-portal queues and selection complaints until they are worked through: a
`clearance-pending` player still appears on the roster and in demographics, but their club
cannot delete them.

## Related

- `docs/runbooks/` sibling: the 16 Jul placeholder-writing backfill has no runbook; its record
  lives in the script docstring.
- `packages/api/src/open-clearance.ts` — the case where the player **is** rostered at the
  source club.
- `packages/api/src/backfill-registration-clearance.ts` — placeholder-writing variant; predates
  the sourceless-resolution tolerance.

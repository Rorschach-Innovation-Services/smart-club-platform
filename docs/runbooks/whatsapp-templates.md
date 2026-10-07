# Runbook — WhatsApp clearance-pending template

**Owner:** runs in the **medicoach AWS account** (the WhatsApp WABA + phone-number id are
reused from medicoach — recipients see medicoach's WhatsApp display name until a
Dolphins-owned WABA lands). **Status: LIVE.** `club_clearance_pending_v2` (English, Utility) was
approved in WhatsApp Manager on 7 Oct 2026 under the medicoach WABA (template ID
1076095408549057). Nothing needs creating — this runbook is the reference for its copy,
variables, and how the name reaches the Lambda. It is the ONLY WhatsApp message the clearance
flow sends (resolutions are email-only).

> **v1 retired in code (7 Oct 2026).** The original 4-param, link-less `club_clearance_pending`
> (template ID 1015867618110855, live since 4 Aug 2026) has no registry entry any more and
> nothing sends it. A clearance notice with **no link** now **skips** WhatsApp instead of
> falling back to v1 — see [Retired — `club_clearance_pending`](#retired--club_clearance_pending-v1)
> below for when it is safe to delete it in WhatsApp Manager.

This runbook covers the one business-initiated WhatsApp template the clearance flow uses:

| Template purpose      | Registry name (code)        | Sent to         | When                                                                                     |
| --------------------- | --------------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| Clearance **pending** | `club_clearance_pending_v2` | FROM-club chair | a clearance opens against the club (create / self-register / reassign), reopen, reminder |

> **Template names live in code, not secrets.** The name + language for every WhatsApp
> template are held in the code registry `packages/api/src/notify/whatsapp-templates.ts`
> (entry `clearancePendingV2` for this one). There is no `sst secret set` for a template name.
> The four former name secrets (`WhatsappInviteTemplate`, `WhatsappStaffTemplate`,
> `WhatsappReglinkTemplate`, `WhatsappClearanceTemplate` — there was never a fixtures secret)
> have been removed; any values previously set for them on a stage are now inert and can be
> ignored.

It is a **Utility** template, **body-only** (no header, no buttons). Its `{{5}}` is a deep link
to the clearance in the chair's club portal, but the chair may hold no portal login (chair
invites were removed with admin onboarding), so the copy still points at the union office as
the way through.

> **No link ⇒ no WhatsApp.** The link is built from the tenant's canonical web origin (or, for
> an authenticated admin action on a dev stage, a localhost request Origin). Meta rejects an
> empty param, so when there is no link the WhatsApp channel is recorded `skipped` with error
> `no portal link for this tenant` and only the email goes. Deployed dev stages resolve no
> canonical origin, so `skipped` WhatsApp rows on dev clearances are expected.

> **Resolved notices are email-only.** When the union office **issues** (override) or
> **declines** (reject) a clearance, both clubs' chairs are notified **by email only** — there
> is no WhatsApp template for a resolution. The pending notice is the one that needs a
> response; a resolution is informational, the email carries the reason and the per-outcome
> copy, and 2 clubs × 2 channels per resolution was judged too much WhatsApp volume (each
> business-initiated message is a billed Meta conversation). Only the **pending** notice goes
> over WhatsApp.

> **Reopen reuses the pending template — no new Meta template.** When the union office reopens
> a rejected clearance (`POST /admin/clearances/:cid/reopen`), the comm-log kind is
> `clearance-reopened` and the daily pending-notice cap is bypassed (a reopen is deliberate
> admin action). The two chairs get **different** content: the **source** chair receives the
> pending WhatsApp template above (the source club must decide the transfer again), while the
> **destination** chair's WhatsApp channel is recorded `skipped` with error
> `no destination template for reopen` — the destination gets an **email-only** heads-up
> (there is deliberately no destination reopen template, and the pending copy would wrongly
> tell the destination its club must act). If you ever add one, create it in Meta, add a new
> entry to the code registry, and wire the sender + body here; until then the skipped row
> keeps the comm log honest.

> **POPIA — no reason over WhatsApp.** The admin's free-text reject/override note is **never**
> sent on WhatsApp. Free admin text about a named player crossing to Meta is a
> cross-border-transfer concern — the reason travels on the email (to the two clubs' chairs,
> inside the union's own channel) and in the club portal. The pending template sends names
> only. Keep it that way when editing the copy — do **not** add a reason variable.

---

## Why

Both clearance dialogs in the union console promise "Both clubs' chairs will be notified by
email where an address is on file." The pending-clearance heads-up also goes over WhatsApp:
email is live the moment the API deploys; WhatsApp is best-effort and only delivers once this
template exists in Meta under the registry name (`club_clearance_pending_v2`). Each channel
records its own `sent`/`skipped`/`failed` outcome in the club's comm log,
so a not-yet-created template shows as a dry-run `sent` locally and (once wired to a real
token) surfaces Meta's rejection as a `failed` row rather than sinking the email.

---

## 1 · Body variables

The template takes **five positional body parameters**, in this order:

| Var     | Value                                                                   |
| ------- | ----------------------------------------------------------------------- |
| `{{1}}` | chair name (falls back to "there")                                      |
| `{{2}}` | from-club (previous club) name                                          |
| `{{3}}` | player name                                                             |
| `{{4}}` | to-club (new club) name                                                 |
| `{{5}}` | clearance link (`https://<tenant>/club/<id>/clearances?clearance=<id>`) |

> See `sendClearanceWhatsApp` in `packages/api/src/notify/whatsapp.ts`. Copy the body text
> below verbatim so the placeholders line up with what the code sends.

`{{1}}`–`{{4}}` are whitespace-collapsed and length-bounded before sending (`cleanParam`) —
Meta rejects params with newlines, tabs, or 4+ consecutive spaces, and the player name comes
from the public register form as free text. The link (`{{5}}`) is server-built from the tenant
origin and passed through whole; truncating it would break it.

## 2 · Approved body copy (as it stands in WhatsApp Manager)

**`club_clearance_pending_v2`** — vars `{{1}}` chair, `{{2}}` from-club, `{{3}}` player,
`{{4}}` to-club, `{{5}}` link:

```
Hello {{1}},

A player clearance is awaiting {{2}}'s review: {{3}} has applied to join {{4}} and needs a clearance from your club.

Review it here: {{5}}

Please have this reviewed and approved or rejected in your club portal, or contact your union office if you have any questions.
```

The link line sits before the closing sentence rather than at the very end because Meta rejects a
body that ends on a variable. The "contact your union office" sentence stays: a chair with no
portal login can't get past sign-in, and that sentence is their way through.

Category **Utility**, language **English (`en`)**. The name and language are held in the code
registry `packages/api/src/notify/whatsapp-templates.ts` (entry `clearancePendingV2`), whose
`bodyText` must match the copy above. If it is ever re-created under a different name or language
code, edit that entry — there is no env/secret override.

## 3 · Deploy — the code needs no config

The template name + language are in the code registry, not a secret. Deploying is just
`sst deploy --stage dev` / `sst deploy --stage prod` — the same deploy that ships the sender code.

**Runtime gate:** the `clearancePendingV2` entry's `status` is read at runtime by the
ClearanceReminders cron, which only adds the WhatsApp channel while it is `'registered'` (and the
tenant's `whatsappInvites` feature is on). If the template is ever re-created under a **different**
name or language, change that entry in `whatsapp-templates.ts` and deploy — no `sst secret set` step. The only
WhatsApp secrets that still exist are `WhatsappAccessToken` and `WhatsappPhoneNumberId`; the
former per-template name secrets have been removed and any values once set for them are inert.

## 4 · Dry-run behaviour (until approved + token wired)

WhatsApp sends are **dry-run** whenever `NOTIFY_DRY_RUN=1`, or the `WHATSAPP_ACCESS_TOKEN` /
`WHATSAPP_PHONE_NUMBER_ID` secrets are unset (`WHATSAPP_DRY_RUN` in
`packages/api/src/notify/whatsapp.ts`). In dry-run the code logs a line like:

```
[notify:whatsapp dry-run] would send clearance notice for <club> to <e164>
```

and returns a synthetic `dry-run-<uuid>` message id — the comm-log row is recorded as
`sent` with that id, so the flow is exercised end-to-end without contacting Meta. Email has
its own independent dry-run gate (`NOTIFY_DRY_RUN=1` or `FROM_EMAIL` unset), logging
`[notify:email dry-run] would send clearance-<outcome> notice …`. Nothing is delivered to a
real recipient until the token/phone-id secrets and (for WhatsApp) an approved template are in place.

## Aftercare

- A club with no chair email/cell on file gets a `skipped` comm-log row for that channel
  (reason "no valid chair email/cell on file"), not a failure — expected for clubs still
  being onboarded.
- A notice with no clearance link gets a `skipped` WhatsApp row (reason "no portal link for
  this tenant") — expected on dev stages, which have no canonical web origin.
- A directory-sourced clearance (previous club not on the system) has no Club record to
  notify, so only the destination club is messaged on a resolution — that is by design.
- Watch the comm log for `failed` WhatsApp rows after wiring a real token: they carry Meta's
  error code/message and usually mean the template name/language or a body param is off.

## captains_report_due — v2 copy, edited in place (4 Oct 2026)

The planned separate `captains_report_open` template was NOT created. Both copies take 3
body params, so the existing `captains_report_due` was EDITED in WhatsApp Manager to the v2
body instead ("works once" was ambiguous; "{{2}}'s" read badly for clubs such as Crusaders;
{{2}} now carries the UNION name, not the club). Meta serves the previously approved body
until the edit clears review — during that window the union name renders inside the old
club-possessive sentence, which is cosmetic only.

Current body (3 variables — the registry's `bodyText` must match it exactly):

```
Hello {{1}},

The {{2}} captain's report for {{3}} is open. Please rate the umpires.

Tap the button below to open it. You can submit it once; the link expires on the date shown in the report.
```

- Params: `{{1}}` recipient name, `{{2}}` union name (e.g. `KZN Dolphins`),
  `{{3}}` match line + date (e.g. `Umzinto CC v African Warriors on Sun 20 Sep 2026`).
- Button (unchanged): **Visit website**, dynamic URL
  `https://platform.club.medicoach.co.za/r/{{1}}` — the signed report token is the suffix.
- Meta allows one edit per day / ten per month; if an edit is rejected, the previous
  approved version keeps sending.

---

## Appendix — `fixture_reminder` (scheduled fixture reminders) — NOT YET REGISTERED

The FixtureReminders cron (`packages/api/src/crons/fixture-reminders.ts`, daily 07:00 SAST)
reminds club chairs of upcoming fixtures for tenants whose operator enabled **Fixture
reminders** in the operator portal. Email works as soon as it deploys. WhatsApp needs this
template created in Meta first.

| Template purpose | Registry name (code) | Sent to    | When                                            |
| ---------------- | -------------------- | ---------- | ----------------------------------------------- |
| Fixture reminder | `fixture_reminder`   | club chair | N days before a match day (operator `leadDays`) |

**Runtime gate:** this template's registry `status` is read at runtime (as is
`captains_report_due`'s). The cron
**skips WhatsApp entirely** while the `fixtureReminder` entry in
`packages/api/src/notify/whatsapp-templates.ts` is anything other than `'registered'`. It does not
attempt the send and wait for Meta to reject it, because that would fail the same send for every
tenant on every run. WhatsApp also needs the tenant's channels to include it and the
`whatsappInvites` feature on.

Body variables (Utility, English `en`, body-only, no buttons):

| Var     | Value                               |
| ------- | ----------------------------------- |
| `{{1}}` | chair name (falls back to "there")  |
| `{{2}}` | club name                           |
| `{{3}}` | fixture date, e.g. `Sat 2026-11-07` |
| `{{4}}` | portal link (tenant web origin)     |

Proposed body (reconstructed from the parameter order, so check it against what Meta approves):

```
Hello {{1}},

A reminder that {{2}} has fixtures on {{3}}. See the match details in your club portal: {{4}}

If you have any questions, please contact your union office.
```

The template deliberately carries no opponent, kick-off time or ground. Those go in the email
and the portal, which both respect withheld fields (ADR 0011).

To activate:

1. Create `fixture_reminder` in WhatsApp Manager (medicoach WABA) with the body above and wait for
   approval. If Meta rejects the URL variable, drop `{{4}}`. That means changing `paramCount`/
   `params` in the registry and `fixtureReminderParams` in `whatsapp.ts`; the arity test will flag
   anything you miss.
2. Change the `fixtureReminder` entry's `status` from `'pending'` to `'registered'` and deploy.
   No secret is involved.

---

## Retired — `club_clearance_pending` (v1)

`club_clearance_pending` (4 params, no link; template ID 1015867618110855) was the clearance
template from 4 Aug 2026. On 7 Oct 2026 `club_clearance_pending_v2` (same copy plus a link line)
was approved, and the same day v1 was **retired in code**: its registry entry was removed, the
sender no longer falls back to it, and the ClearanceReminders cron's WhatsApp gate moved to v2's
status. v2 was created as a **new** template rather than an in-place edit of v1, because changing
v1's arity (4 → 5) under the same name would have failed every live 4-param send with error
132000 the moment the edit cleared review.

**Deleting it in WhatsApp Manager:** once this change is deployed to **every** stage (dev and
prod), nothing sends `club_clearance_pending` and it can be deleted from the medicoach WABA.
Before then, an older deployment could still send it, so leave it in place until both stages run
the v2-only code. Meta blocks reusing a deleted template name for **30 days**, so do not delete it
if you expect to need that exact name again soon.

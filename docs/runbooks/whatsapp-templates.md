# Runbook — WhatsApp clearance-pending template

**Owner:** runs in the **medicoach AWS account** (the WhatsApp WABA + phone-number id are
reused from medicoach — recipients see medicoach's WhatsApp display name until a
Dolphins-owned WABA lands). **Status: LIVE.** `club_clearance_pending` (English, Utility) was
created in WhatsApp Manager on 4 Aug 2026 under the medicoach WABA and is Active (template ID
1015867618110855); as of 30 Aug 2026 it shows 20 sent / 20 delivered / 15 read. Nothing needs
creating — this runbook is the reference for its copy, variables, and how the name reaches the
Lambda. It is the ONLY WhatsApp message the clearance flow sends (resolutions are email-only).

This runbook covers the one business-initiated WhatsApp template the clearance flow uses:

| Template purpose      | Default name (secret)                                  | Sent to         | When                                                                   |
| --------------------- | ------------------------------------------------------ | --------------- | ---------------------------------------------------------------------- |
| Clearance **pending** | `club_clearance_pending` (`WhatsappClearanceTemplate`) | FROM-club chair | a clearance opens against the club (create / self-register / reassign) |

It is a **Utility** template, **body-only** (no header, no buttons, no links) — the chair may
hold no portal login (chair invites were removed with admin onboarding), so the copy points at
the club portal / union office rather than telling the recipient to sign in.

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
> tell the destination its club must act). If you ever add one, wire a new secret and body
> here; until then the skipped row keeps the comm log honest.

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
template exists in Meta under the default name (or the secret is pointed at the approved
name). Each channel records its own `sent`/`skipped`/`failed` outcome in the club's comm log,
so a not-yet-created template shows as a dry-run `sent` locally and (once wired to a real
token) surfaces Meta's rejection as a `failed` row rather than sinking the email.

---

## 1 · Body variables

The template takes **four positional body parameters**, in this order:

| Var     | Value                              |
| ------- | ---------------------------------- |
| `{{1}}` | chair name (falls back to "there") |
| `{{2}}` | from-club (previous club) name     |
| `{{3}}` | player name                        |
| `{{4}}` | to-club (new club) name            |

> See `sendClearanceWhatsApp` in `packages/api/src/notify/whatsapp.ts`. Copy the body text
> below verbatim so the placeholders line up with what the code sends.

All parameters are whitespace-collapsed and length-bounded before sending (`cleanParam`) —
Meta rejects params with newlines, tabs, or 4+ consecutive spaces, and the player name comes
from the public register form as free text.

## 2 · Approved body copy (as it stands in WhatsApp Manager)

**`club_clearance_pending`** — vars `{{1}}` chair, `{{2}}` from-club, `{{3}}` player, `{{4}}` to-club:

```
Hello {{1}},

A player clearance is awaiting {{2}}'s review: {{3}} has applied to join {{4}} and needs a clearance from your club.

Please have this reviewed and approved or rejected in your club portal, or contact your union office if you have any questions.
```

Category **Utility**, language **English (`en`)**. If it is ever re-created under
a different language code, also set the matching `WHATSAPP_CLEARANCE_TEMPLATE_LANG` env
override — the code defaults the pending-clearance template language to `en`.

## 3 · Deploy — no secrets needed for the default name

The template name is an SST secret **with a default** baked into `sst.config.ts`
(`new sst.Secret('WhatsappClearanceTemplate', 'club_clearance_pending')`). When no value has
been set for a stage, SST hands the Lambda the default — this is how the staff, reg-link and
pending-clearance templates already run on dev and prod: only `WhatsappAccessToken`,
`WhatsappPhoneNumberId`, `WhatsappInviteTemplate` and `FromEmail` have ever been set
explicitly.

So the normal path is:

1. Create + get the template approved in Meta **under the default name above**.
2. `sst deploy --stage dev` / `sst deploy --stage prod`.

**Only if** Meta approves the template under a different name, point the secret at it and
redeploy:

```sh
sst secret set WhatsappClearanceTemplate <approved-name> --stage <stage>
sst deploy --stage <stage>
```

The secret is wired to `WHATSAPP_CLEARANCE_TEMPLATE` in `sst.config.ts`.

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
- A directory-sourced clearance (previous club not on the system) has no Club record to
  notify, so only the destination club is messaged on a resolution — that is by design.
- Watch the comm log for `failed` WhatsApp rows after wiring a real token: they carry Meta's
  error code/message and usually mean the template name/language or a body param is off.

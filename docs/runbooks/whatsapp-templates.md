# Runbook — WhatsApp clearance templates (pending / approved / rejected)

**Owner:** runs in the **medicoach AWS account** (the WhatsApp WABA + phone-number id are
reused from medicoach — recipients see medicoach's WhatsApp display name until a
Dolphins-owned WABA lands). **Status: templates NOT yet created in Meta.** Until each
template is approved under the WABA that owns `WHATSAPP_PHONE_NUMBER_ID`, the corresponding
send stays in **dry-run** (logged, never delivered — see below), and
email carries the notice on its own.

This runbook covers the three business-initiated WhatsApp templates the clearance flow uses:

| Template purpose       | Default name (secret)                                           | Sent to            | When                                                                   |
| ---------------------- | --------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------- |
| Clearance **pending**  | `club_clearance_pending` (`WhatsappClearanceTemplate`)          | FROM-club chair    | a clearance opens against the club (create / self-register / reassign) |
| Clearance **approved** | `club_clearance_approved` (`WhatsappClearanceApprovedTemplate`) | BOTH clubs' chairs | the union office overrides & issues the clearance                      |
| Clearance **rejected** | `club_clearance_rejected` (`WhatsappClearanceRejectedTemplate`) | BOTH clubs' chairs | the union office rejects the clearance                                 |

All three are **Utility** templates, **body-only** (no header, no buttons, no links) — the
chair may hold no portal login (chair invites were removed with admin onboarding), so the
copy points at the club portal / union office rather than telling the recipient to sign in.

> **POPIA — no reason over WhatsApp.** The admin's free-text reject/override note is
> **never** sent on WhatsApp. Free admin text about a named player crossing to Meta is a
> cross-border-transfer concern, so the resolved templates carry names only; the reason
> travels on the email (to the two clubs' chairs, inside the union's own channel) and in the
> club portal. The pending template likewise sends names only. Keep it that way when
> editing the copy — do **not** add a reason variable.

---

## Why

Both clearance dialogs in the union console promise "Both clubs' chairs will be notified by
email/WhatsApp where contact details are on file." Email is live the moment the API deploys;
WhatsApp is best-effort and only delivers once these templates exist in Meta under the
default names (or the secret is pointed at the approved name). Each channel records its own `sent`/`skipped`/`failed` outcome in the club's comm log,
so a not-yet-created template shows as a dry-run `sent` locally and (once wired to a real
token) surfaces Meta's rejection as a `failed` row rather than sinking the email.

---

## 1 · Body variables

Every template takes **four positional body parameters**, in this order:

| Var     | Value                              |
| ------- | ---------------------------------- |
| `{{1}}` | chair name (falls back to "there") |
| `{{2}}` | player name                        |
| `{{3}}` | from-club (previous club) name     |
| `{{4}}` | to-club (new club) name            |

> ⚠️ The **pending** template's order differs by history — it is `{{1}}` chair, `{{2}}`
> from-club, `{{3}}` player, `{{4}}` to-club (see `sendClearanceWhatsApp` in
> `packages/api/src/notify/whatsapp.ts`). The **approved/rejected** templates are `{{1}}`
> chair, `{{2}}` player, `{{3}}` from-club, `{{4}}` to-club (see
> `sendClearanceResolvedWhatsApp`). Copy the body text below verbatim so the placeholders
> line up with what the code sends.

All parameters are whitespace-collapsed and length-bounded before sending (`cleanParam`) —
Meta rejects params with newlines, tabs, or 4+ consecutive spaces, and the player name comes
from the public register form as free text.

## 2 · Body copy to submit to Meta

**`club_clearance_pending`** — vars `{{1}}` chair, `{{2}}` from-club, `{{3}}` player, `{{4}}` to-club:

```
Hello {{1}}, a player clearance is awaiting {{2}}'s review: {{3}} has applied to join {{4}} and needs a clearance from your club. Please review it in your club portal, or contact your union office with any questions.
```

**`club_clearance_approved`** — vars `{{1}}` chair, `{{2}}` player, `{{3}}` from-club, `{{4}}` to-club:

```
Hello {{1}}, the union office has issued the clearance for {{2}} from {{3}} to {{4}}. They are now registered at {{4}}. Details are in the email to your club and in the club portal.
```

**`club_clearance_rejected`** — vars `{{1}}` chair, `{{2}}` player, `{{3}}` from-club, `{{4}}` to-club:

```
Hello {{1}}, the union office has rejected the clearance for {{2}} from {{3}} to {{4}}. Details are in the email to your club and in the club portal.
```

Submit all three as **Utility** category, language **English (`en`)**. If a template is
approved under a different language code, also set the matching `*_LANG` env override (e.g.
`WHATSAPP_CLEARANCE_APPROVED_TEMPLATE_LANG`) — the code defaults every clearance template
language to `en`.

## 3 · Deploy — no secrets needed for the default names

Each template name is an SST secret **with a default** baked into `sst.config.ts`
(`new sst.Secret('WhatsappClearanceApprovedTemplate', 'club_clearance_approved')`). When no
value has been set for a stage, SST hands the Lambda the default — this is how the staff,
reg-link and pending-clearance templates already run on dev and prod: only
`WhatsappAccessToken`, `WhatsappPhoneNumberId`, `WhatsappInviteTemplate` and `FromEmail`
have ever been set explicitly.

So the normal path is:

1. Create + get the three templates approved in Meta **under the default names above**.
2. `sst deploy --stage dev` / `sst deploy --stage prod`.

**Only if** Meta approves a template under a different name, point the secret at it and
redeploy:

```sh
sst secret set WhatsappClearanceTemplate <approved-name> --stage <stage>
sst secret set WhatsappClearanceApprovedTemplate <approved-name> --stage <stage>
sst secret set WhatsappClearanceRejectedTemplate <approved-name> --stage <stage>
sst deploy --stage <stage>
```

The secrets are wired to `WHATSAPP_CLEARANCE_TEMPLATE`, `WHATSAPP_CLEARANCE_APPROVED_TEMPLATE`
and `WHATSAPP_CLEARANCE_REJECTED_TEMPLATE` in `sst.config.ts`.

## 4 · Dry-run behaviour (until approved + token wired)

WhatsApp sends are **dry-run** whenever `NOTIFY_DRY_RUN=1`, or the `WHATSAPP_ACCESS_TOKEN` /
`WHATSAPP_PHONE_NUMBER_ID` secrets are unset (`WHATSAPP_DRY_RUN` in
`packages/api/src/notify/whatsapp.ts`). In dry-run the code logs a line like:

```
[notify:whatsapp dry-run] would send clearance rejected notice for <club> to <e164>
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

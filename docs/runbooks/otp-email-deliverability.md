# Runbook — Fix OTP / transactional emails landing in spam

**Owner:** runs in the **medicoach AWS account** + **medicoach.co.za DNS zone**.
**App code change:** none required (see step 6 fallback).
**Why:** sign-in OTP codes (and staff invite / fixtures emails) frequently land in
junk because the sending domain has **no DKIM signature** and **no DMARC policy**.

---

## Diagnosis (captured 2026-06-18, live account)

| Check             | af-south-1 (Cognito OTP)                                             | eu-west-1 (invites / reg-links / fixtures)                     |
| ----------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| Production access | ✅ granted, 50k/day, sending enabled                                 | n/a (separate region)                                          |
| Sender identity   | `info@medicoach.co.za` — **EMAIL_ADDRESS**, no domain identity       | `info@medicoach.co.za` — **EMAIL_ADDRESS**, no domain identity |
| **DKIM**          | ❌ `SigningEnabled: false`, `NOT_STARTED`                            | ❌ not signed                                                  |
| **DMARC**         | ❌ none at `_dmarc.medicoach.co.za`                                  | ❌ same record governs both                                    |
| SPF / MX (apex)   | Microsoft 365 only: `v=spf1 include:spf.protection.outlook.com -all` | same                                                           |

**Root cause:** mail is sent `From: info@medicoach.co.za` with no DKIM signature and no
DMARC policy, while the apex domain is tightly locked to Microsoft 365 (`-all`).
Receiving servers see unauthenticated mail from an otherwise-strict domain → spam.

**Sender** (for reference): `packages/api/src/enable-passwordless.ts:37-40` —
`Smart Club Platform <info@medicoach.co.za>`, Cognito EMAIL_OTP, SES af-south-1.

> ⚠️ **DMARC is domain-wide.** It does not respect the af-south-1 / eu-west-1 split.
> If you publish a DMARC `quarantine`/`reject` policy before **both** regions are
> DKIM-signed, the unsigned stream's real mail gets quarantined. Fix both regions
> (steps 1 + 2) before ramping DMARC past `p=none` (step 4).

---

## Steps

DKIM keys are **per-region per-identity**, so af-south-1 and eu-west-1 each emit their
own 3 CNAMEs — publish all **6** in the single medicoach.co.za DNS zone.

### 1. af-south-1 — verify the domain identity + Easy DKIM (fixes OTP)

```bash
aws sesv2 create-email-identity --region af-south-1 \
  --email-identity medicoach.co.za \
  --dkim-signing-attributes NextSigningKeyLength=RSA_2048_BIT
```

Read back the 3 DKIM tokens and publish them as CNAMEs:

```bash
aws sesv2 get-email-identity --region af-south-1 \
  --email-identity medicoach.co.za \
  --query 'DkimAttributes.Tokens' --output text
```

For each `<token>`: `<token>._domainkey.medicoach.co.za  CNAME  <token>.dkim.amazonses.com`
These are independent of the M365 records and won't disturb existing Outlook mail.
Once SES auto-signs from the domain identity, **all** mail from any `@medicoach.co.za`
address — including the Cognito OTP sends via the `info@` email identity — is DKIM-signed.

### 2. eu-west-1 — same (REQUIRED — fixes invites/fixtures AND unblocks the DMARC ramp)

```bash
aws sesv2 create-email-identity --region eu-west-1 \
  --email-identity medicoach.co.za \
  --dkim-signing-attributes NextSigningKeyLength=RSA_2048_BIT
aws sesv2 get-email-identity --region eu-west-1 \
  --email-identity medicoach.co.za \
  --query 'DkimAttributes.Tokens' --output text
```

Publish its 3 CNAMEs the same way.

### 3. (Optional) Custom MAIL FROM for SPF alignment — belt-and-suspenders

DKIM alignment alone already satisfies DMARC; this adds aligned SPF. It uses a
**subdomain**, so it never touches the apex M365 SPF. Per region:

```bash
aws sesv2 put-email-identity-mail-from-attributes --region <region> \
  --email-identity medicoach.co.za \
  --mail-from-domain mail.medicoach.co.za \
  --behavior-on-mx-failure USE_DEFAULT_VALUE
```

Then publish for `mail.medicoach.co.za`:

- `MX 10 feedback-smtp.<region>.amazonses.com`
- `TXT "v=spf1 include:amazonses.com ~all"`

### 4. Publish DMARC — monitor first, then ramp

Start delivery-neutral (safe for the existing M365 flow):

```
_dmarc.medicoach.co.za   TXT   "v=DMARC1; p=none; rua=mailto:dmarc@medicoach.co.za; fo=1"
```

Watch the aggregate (`rua`) reports for ~1 week. Only ramp `none → quarantine → reject`
once reports show **all three** streams passing aligned auth: **M365**, **SES af-south-1**,
**SES eu-west-1**.

### 5. Verify (this is the real test of "no code change needed")

- Both regions show DKIM live:
  ```bash
  aws sesv2 get-email-identity --region af-south-1 --email-identity medicoach.co.za --query 'DkimAttributes.Status'
  aws sesv2 get-email-identity --region eu-west-1  --email-identity medicoach.co.za --query 'DkimAttributes.Status'
  ```
  Expect `"SUCCESS"` for each.
- `dig +short TXT _dmarc.medicoach.co.za` returns the DMARC record.
- Trigger a real **OTP** sign-in and a real **invite** to a Gmail + an Outlook test inbox.
  Open → "Show original" (Gmail) / message headers (Outlook): expect **DKIM: PASS** and
  **DMARC: PASS**, and the message in the inbox, not junk.

### 6. Fallback — ONLY if step 5 shows OTP mail still unsigned

AWS's documented behavior is that domain Easy DKIM signs all mail from the domain, so
this should not be needed. If it is, point Cognito's `SourceArn` at the **domain**
identity instead of the email identity:

- Edit `packages/api/src/enable-passwordless.ts` — `SES_IDENTITY` and the ARN built from
  it → use `identity/medicoach.co.za`. The `From` can stay `info@medicoach.co.za`.
- Re-run the post-deploy script (its header note requires a re-run after any user-pool
  update): `npm --workspace packages/api run enable-passwordless`.
- Re-verify per step 5.

---

## Notes

- No sandbox/quota work needed — production access is already granted in af-south-1.
- Leave the existing `info@medicoach.co.za` EMAIL_ADDRESS identities in place; the domain
  identity coexists and takes over DKIM signing for the whole domain.

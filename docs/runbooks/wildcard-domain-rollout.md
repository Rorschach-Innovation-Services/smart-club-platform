# Runbook — one-time wildcard-domain rollout

Arms the wildcard platform ([ADR 0007](../architecture/0007-wildcard-subdomains-shared-api-host.md)):
after this, a tenant created in the portal is live at `https://<slug>.club.medicoach.co.za`
immediately. **One-time.** Deploys/AWS CLIs are user-run. **Ordering is load-bearing — the live
`dolphins` tenant must never break.** The feature is dormant until `SHARED_API_CERT_ARN` is set
in `infra/tenants.ts`, so the code can already be merged/deployed safely before you start here.

Region rules: web/CloudFront cert MUST be **us-east-1**; API Gateway cert MUST be **af-south-1**.
Profile: `--profile medicoach` (account `433453514361`).

## 0. Verify cPanel can host the wildcard CNAME

In cPanel, create `*.club` CNAME → the current CloudFront distribution domain (from
`aws cloudfront list-distributions --profile medicoach --query 'DistributionList.Items[].DomainName'`).
Confirm it resolves:

```bash
dig +short probe.club.medicoach.co.za CNAME
```

CloudFront returns a 403 until the alias exists (step 4) — harmless; `dolphins` is untouched.
**Do not proceed until the wildcard resolves.**

> **Contingency — cPanel can't host the wildcard.** Delegate the `club.medicoach.co.za`
> subzone to Route53 (create the hosted zone, point cPanel `club` NS records at it). Then
> **all** records under `club.medicoach.co.za` live in Route53 — the wildcard ACM validation
> CNAME (step 1), `api.club` (step 5), and `*.club`. After delegating, re-verify
> `aws acm describe-certificate` shows `DomainValidationOptions[].ValidationStatus = SUCCESS`
> for the `*.club.…` SAN. A cert validated against a now-dead cPanel record renews fine only
> while that record still exists in the **authoritative** zone; otherwise ACM's DNS renewal
> silently fails ~13 months later and takes `dolphins`' vanity hosts down too (same cert).

## 1. Reissue/request the certs (no prod impact yet)

```bash
# Web: reissue us-east-1 cert, superset of existing SANs + the wildcard.
npm --prefix packages/api run request-cert -- \
  --region us-east-1 --replace <current WEB_CERT_ARN> \
  --add '*.club.medicoach.co.za' --profile medicoach

# API: NEW af-south-1 single-name cert (existing API_CERT_ARN untouched).
npm --prefix packages/api run request-cert -- \
  --region af-south-1 --add 'api.club.medicoach.co.za' --profile medicoach
```

`--replace` reads the existing SANs and requests a superset, so no live host is dropped.
Add the printed validation CNAMEs in the authoritative zone (per step 0). Existing SANs
re-validate instantly (their CNAMEs already exist); only the new `_x.club.…` and
`_x.api.club.…` records are new. Wait for both certs to reach **ISSUED** (the tool polls).

> **GO/NO-GO GATE — the web cert is SHARED with the live `dolphins` tenant.** Before landing
> any config, prove the new us-east-1 cert is a strict **superset** of the old one — a dropped
> SAN takes `dolphins` down at deploy:
>
> ```bash
> aws acm describe-certificate --profile medicoach --region us-east-1 \
>   --certificate-arn <NEW WEB_CERT_ARN> \
>   --query 'Certificate.SubjectAlternativeNames' --output json
> ```
>
> The output MUST contain every SAN the current cert has (`dolphinspipeline.medicoach.co.za`,
> `www.dolphinspipeline.medicoach.co.za`, plus any other live vanity hosts) **and**
> `*.club.medicoach.co.za`. If anything is missing, STOP — do not land the ARN.

## 2. Land the config

In `infra/tenants.ts`, set:

- `WEB_CERT_ARN` → the reissued us-east-1 ARN,
- `SHARED_API_CERT_ARN` → the new af-south-1 ARN (**this arms the wildcard**),
- `WEB_CNAME_TARGET` → the CloudFront distribution domain (from step 0).

Run `npm run typecheck` and the test suites.

## 3. Pre-deploy checks

```bash
aws cloudfront list-distributions --profile medicoach \
  --query 'DistributionList.Items[].Aliases.Items'      # no other distribution claims *.club.…
npx sst diff --stage prod
```

Expect: viewer-cert swap on the distribution, ONE new alias (`*.club.…`), ONE new API
Gateway domain + mapping (`api.club.…`), and a **Lambda env update in place — NOT a
replacement**. No distribution/API replacement.

The `resolveTenant()` Origin branch on `SHARED_API_HOST` (`packages/api/src/auth.ts:133`) has
never run in prod. Its _logic_ is unit-tested (`packages/api/test/resolve-tenant.test.ts`);
what tests can't cover — whether API Gateway forwards the `Origin` header to the Lambda on the
shared host — is the GO/NO-GO gate in **step 4**, run against the deployed domain BEFORE the DNS
cutover. Note it **cannot** be reproduced in a dev stage: `WILDCARD_ENABLED`, `SHARED_API_HOST`
and `WILDCARD_WEB_SUFFIX` are hardwired prod-only in `sst.config.ts` (`WILDCARD_ENABLED` derives
from `wildcardEnabled = isProd && SHARED_API_CERT_ARN !== ''`), so the branch is dead off-prod —
don't waste time trying.

## 4. Deploy

```bash
npx sst deploy --stage prod
```

`dolphins` stays up throughout: same distribution (the new cert covers all old SANs, so the
swap is seamless), its API domain unchanged, and `resolveTenant()`'s first branch (host map)
unchanged. Record the `sharedApiTarget` output.

**GO/NO-GO GATE — validate Origin-based tenant resolution on the deployed shared host, BEFORE
the step-5 DNS cutover.** `api.club.…` isn't in public DNS yet, so resolve it manually to the
API Gateway regional domain (`sharedApiTarget`) and hit the real deployed Lambda — this proves
API Gateway forwards the `Origin` header end-to-end, the one thing unit tests can't:

```bash
SHARED_API_TARGET=<sharedApiTarget from above>   # e.g. d-xxxx.execute-api.af-south-1.amazonaws.com
# Origin present → dolphins JSON:
curl -s --connect-to api.club.medicoach.co.za:443:${SHARED_API_TARGET}:443 \
  https://api.club.medicoach.co.za/tenant \
  -H 'Origin: https://dolphins.club.medicoach.co.za' | head -c 120
# No Origin → 400 unknown tenant (proves it does NOT fall through to leftmost-label):
curl -s --connect-to api.club.medicoach.co.za:443:${SHARED_API_TARGET}:443 \
  https://api.club.medicoach.co.za/tenant | head -c 120
```

First curl must return dolphins branding JSON. If it returns `400`/HTML instead, **STOP** — do
NOT proceed to step 5; the wildcard is not public yet, so there is nothing to roll back.
Investigate Origin forwarding before cutting over DNS.

## 5. DNS go-live (authoritative zone per step 0)

- Keep `*.club` CNAME → CloudFront distribution domain.
- Add `api.club` CNAME → the `sharedApiTarget` from step 4 (an explicit record beats the
  wildcard for API-vs-web routing). **Load-bearing and silent if forgotten:** without this
  record `api.club` falls through `*.club` to the CloudFront SPA, so every wildcard tenant's
  API call returns HTML — a total outage with no error naming the missing record. The step-6
  `curl …/tenant` with an `Origin` header is the canary; do not skip it.
- Keep both ACM validation CNAMEs **permanently** (renewals reuse them). ACM DNS renewal now
  depends on records this repo can't observe — a removed `_x.club.…` ACM validation CNAME (the
  one validating the `*.club` SAN, distinct from the `*.club` alias record that serves traffic)
  silently fails renewal ~13 months later and takes `dolphins` down too (shared web cert).
  Step 7's expiry alarm is the only backstop.

`api.club` is DNS-dead until this step, so any curl before it looks like an outage — expected
(and a safety property: the shared API can't answer before the web wildcard is live).

## 6. Verify

```bash
curl -s https://api.club.medicoach.co.za/tenant \
  -H 'Origin: https://dolphins.club.medicoach.co.za' | head -c 120   # dolphins branding JSON
curl -s https://api.club.medicoach.co.za/tenant                       # 400 unknown tenant (no Origin)
curl -s 'https://api.club.medicoach.co.za/tenant?tenant=nope'         # 404 tenant not found
curl -sI https://anything.club.medicoach.co.za/                       # 200 (SPA)
curl -sI https://dolphinspipeline.medicoach.co.za/                    # 200 (unchanged)
curl -s https://api.dolphinspipeline.medicoach.co.za/tenant | head -c 120   # dolphins JSON (unchanged)
```

Then in a browser: create a test tenant in `/platform` → open `https://<slug>.club.medicoach.co.za`
→ branded login + OTP end-to-end; a nonexistent slug → the "This club isn't available" screen;
`https://dolphins.club.medicoach.co.za` redirects to the vanity host.

## 7. Cert-expiry watch

ACM renewal now depends on DNS records this repo can't observe. Add a CloudWatch alarm on the
ACM `DaysToExpiry` metric for both certs (or, at minimum, a dated calendar reminder against each
cert's `NotAfter`).

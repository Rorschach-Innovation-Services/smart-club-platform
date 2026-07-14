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
replacement**. No distribution/API replacement. Optionally smoke-test the Origin branch in
the dev stage first (temporarily point `SHARED_API_HOST` at the dev execute-api host).

## 4. Deploy

```bash
npx sst deploy --stage prod
```

`dolphins` stays up throughout: same distribution (the new cert covers all old SANs, so the
swap is seamless), its API domain unchanged, and `resolveTenant()`'s first branch (host map)
unchanged. Record the `sharedApiTarget` output.

## 5. DNS go-live (authoritative zone per step 0)

- Keep `*.club` CNAME → CloudFront distribution domain.
- Add `api.club` CNAME → the `sharedApiTarget` from step 4 (an explicit record beats the
  wildcard for API-vs-web routing).
- Keep both ACM validation CNAMEs **permanently** (renewals reuse them).

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

# Deploy & auth spike — runbook

Exact commands to stand up the backend in **af-south-1** and de-risk the auth flow.
Run these with your `medicoach` AWS credentials. Nothing here is destructive to prod
(everything targets `--stage dev`).

> **Order matters.** Do the auth spike (step 2) and confirm passwordless works _before_
> relying on it. If it isn't available in af-south-1, switch to the CUSTOM_AUTH fallback
> (step 6) — the app code is unaffected.

## 1. Install

```bash
# repo root — SST + frontend deps
npm install
# API package deps (Hono, AWS SDK v3, aws-jwt-verify, tsx)
cd packages/api && npm install && cd ../..
```

## 2. Deploy to the dev stage

```bash
npm run deploy:dev
```

This provisions (af-south-1): the DynamoDB table, the Uploads bucket, the Cognito user
pool + client + PreTokenGeneration trigger, the Hono API (Lambda + HTTP API), and the
StaticSite. Note the outputs:

```
api:               https://xxxx.execute-api.af-south-1.amazonaws.com
userPoolId:        af-south-1_xxxxxxxxx
userPoolClientId:  xxxxxxxxxxxxxxxxxxxxxxxxxx
url:               https://xxxx.cloudfront.net
```

> **Spike outcome (resolved):** Essentials tier deploys fine, but `EMAIL_OTP` as a first
> auth factor (`Policies.SignInPolicy.AllowedFirstAuthFactors`) **cannot** be set via SST —
> it only exists in pulumi-aws 7.x and SST 3.x bundles 6.x, so the IaC silently dropped it.
> It's enabled by the post-deploy script in step 3 instead. (Cognito's built-in email is
> used — no SES setup needed.) The CUSTOM_AUTH fallback (old step 6) is therefore not needed.

## 3. Enable passwordless email OTP (required post-deploy step)

```bash
npx sst shell --stage dev -- npm --prefix packages/api run enable-passwordless
```

This sets `AllowedFirstAuthFactors=[PASSWORD, EMAIL_OTP]` on the pool via the AWS API
(idempotent). **Re-run it after any deploy that recreates the user pool.** Confirm with:

```bash
aws cognito-idp describe-user-pool --region af-south-1 --user-pool-id <poolId> \
  --query 'UserPool.Policies.SignInPolicy'   # → AllowedFirstAuthFactors includes EMAIL_OTP
```

## 4. Provision the tenants (blank)

```bash
# Writes ONLY each tenant's config (branding + deadline). Cohort starts blank —
# real unions onboard their own clubs/series in the app.
npx sst shell --stage dev -- npm --prefix packages/api run seed
```

Verify the `TENANT#dolphins` / `TENANT#lions` CONFIG items exist (no `CLUB#`/`SERIES#` items —
the cohort is empty). To load the demo 14 clubs + 2 series into a tenant (set/demo accounts
only): `… run seed -- dolphins --demo`. To blank a tenant that already has data:
`… run clear-cohort -- dolphins --confirm` (keeps config + admins).

## 5. Bootstrap the first admin (per tenant)

```bash
npx sst shell --stage dev -- \
  npm --prefix packages/api run bootstrap-admin -- dolphins you@example.com
```

This creates a **CONFIRMED** Cognito user (suppressed invite; a random unused password
confirms the account so EMAIL_OTP is offered) and an admin `USER#` membership. The user
signs in via email OTP. Thereafter admins invite reps via `POST /admin/users`, which uses
the same confirmed-user flow.

## 6. Prove the end-to-end auth + isolation path

Get an ID token by signing in with email OTP. Easiest is the AWS CLI initiate/respond
(USER_AUTH → EMAIL_OTP):

```bash
POOL=af-south-1_xxxxxxxxx          # from step 2
CLIENT=xxxxxxxxxxxxxxxxxxxxxxxxxx  # from step 2
API=https://xxxx.execute-api.af-south-1.amazonaws.com

# Start passwordless sign-in
aws cognito-idp initiate-auth --region af-south-1 \
  --auth-flow USER_AUTH \
  --client-id "$CLIENT" \
  --auth-parameters USERNAME=you@example.com,PREFERRED_CHALLENGE=EMAIL_OTP
# → returns a Session; check your email for the code, then:
aws cognito-idp respond-to-auth-challenge --region af-south-1 \
  --client-id "$CLIENT" --challenge-name EMAIL_OTP \
  --session "<SESSION>" \
  --challenge-responses USERNAME=you@example.com,EMAIL_OTP_CODE=123456
# → returns AuthenticationResult.IdToken
TOKEN="<IdToken>"
```

Then exercise the API (dev uses the `x-tenant` header since there's no custom domain yet):

```bash
# Admin can list Dolphins clubs
curl -s "$API/clubs" -H "authorization: Bearer $TOKEN" -H "x-tenant: dolphins" | jq length

# Tenant isolation: same token must NOT see Lions (403, no membership)
curl -s -o /dev/null -w '%{http_code}\n' "$API/clubs" \
  -H "authorization: Bearer $TOKEN" -H "x-tenant: lions"   # → 403

# Public branding (no auth)
curl -s "$API/tenant" -H "x-tenant: lions" | jq .branding.name   # → "DP World Lions"

# Generate a reg link, then register a player unauthenticated
curl -s -X POST "$API/clubs/ukzn/reg-link" \
  -H "authorization: Bearer $TOKEN" -H "x-tenant: dolphins" | jq .
TKN="<token from above>"
curl -s -X POST "$API/register/ukzn?t=$TKN" -H 'content-type: application/json' \
  -d '{"firstName":"A","lastName":"B","dob":"2000-01-01","email":"a@b.com"}' -w '\n%{http_code}\n'
# repeat the same body → 409 (dedup)
```

**Spike is green when:** admin lists clubs, the cross-tenant call returns 403, OTP login
works, and registration + dedup behave. (Verified on the live dev stage — see task #1.)

> For an automated token without an inbox (e.g. CI), the choice-based USER_AUTH flow also
> accepts a PASSWORD factor: set a known password on a test user
> (`admin-set-user-password --permanent`) and pass `USERNAME,PASSWORD,PREFERRED_CHALLENGE=PASSWORD`
> to `initiate-auth` — it returns the IdToken directly.

## 7. Tear down dev

```bash
npm run deploy:remove
```

## Notes

- **Custom domains + edge branding** (prod): add `domain` to the StaticSite and a
  CloudFront Function mapping host → branding. In dev we use `x-tenant`. See
  [auth-and-roles.md](auth-and-roles.md).
- **Email delivery:** Cognito's default email has a low daily cap — fine for the spike.
  For real use, wire SES (available in af-south-1).
- **POPIA / erasure:** see [popia-compliance.md](popia-compliance.md).

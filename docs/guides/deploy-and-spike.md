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
> It's enabled by the post-deploy script in step 3 instead. The CUSTOM_AUTH fallback (old
> step 6) is therefore not needed.
>
> **OTP email (2026-06):** Cognito's built-in sender (`COGNITO_DEFAULT`,
> `no-reply@verificationemail.com`, 50/day cap) gets Gmail-spam-binned, so codes never
> arrive. The fix is SES `DEVELOPER` mode with `info@medicoach.co.za` — but Cognito
> **requires the SES identity in the pool's own region** (af-south-1; an eu-west-1 ARN is
> rejected with `InvalidParameterException`), and this account's af-south-1 SES starts
> sandboxed. The step-3 script applies the email config automatically once af-south-1 SES
> is ready (identity verified + production access); until then it leaves the default
> sender alone, because a sandboxed `DEVELOPER` config would reject OTP mail outright.
> One-time SES setup (then re-run step 3):
>
> ```bash
> # 1. Create + verify the identity (click the link AWS emails to the address):
> aws sesv2 create-email-identity --email-identity info@medicoach.co.za \
>   --region af-south-1 --profile medicoach
> # 2. Request production access (AWS reviews, typically within 24h):
> aws sesv2 put-account-details --region af-south-1 --profile medicoach \
>   --production-access-enabled --mail-type TRANSACTIONAL \
>   --website-url https://medicoach.co.za \
>   --use-case-description "Transactional email for the Smart Club Platform (multi-tenant cricket-union administration SaaS): one-time sign-in codes via Amazon Cognito and onboarding invites to club officials. Low volume (tens/day), opt-in recipients (invited staff), no marketing."
> # 3. Check status:
> aws sesv2 get-account --region af-south-1 --profile medicoach \
>   --query '{Production:ProductionAccessEnabled}'
> ```

## 3. Pool post-deploy config: passwordless OTP + SES email (required)

```bash
npx sst shell --stage dev -- npm --prefix packages/api run enable-passwordless
```

This sets `AllowedFirstAuthFactors=[PASSWORD, EMAIL_OTP]` and — once af-south-1 SES is
ready (see above) — the SES `DEVELOPER` email configuration, in one atomic
`UpdateUserPool` call (idempotent). **Re-run it after any deploy that updates or
recreates the user pool** — a pool update from pulumi resets the sign-in policy back to
`[PASSWORD]` (pulumi-aws 6.x can't express it) and the email config back to
`COGNITO_DEFAULT`, which breaks OTP login until this script runs. Confirm with:

```bash
aws cognito-idp describe-user-pool --region af-south-1 --user-pool-id <poolId> \
  --query 'UserPool.{Email:EmailConfiguration,SignIn:Policies.SignInPolicy}'
# → AllowedFirstAuthFactors includes EMAIL_OTP;
#   EmailSendingAccount=DEVELOPER, SourceArn ends ...af-south-1...identity/info@medicoach.co.za
#   (EmailSendingAccount stays COGNITO_DEFAULT until the SES setup above is complete)
```

The first switch to `DEVELOPER` auto-creates the
`AWSServiceRoleForAmazonCognitoIdpEmailService` service-linked role; if the deploying
principal lacks `iam:CreateServiceLinkedRole`, pre-create it with
`aws iam create-service-linked-role --aws-service-name email.cognito-idp.amazonaws.com`.

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

For the cross-tenant operator portal (`/platform` — tenant creation, branding, flags),
bootstrap a **platform operator** the same way (see
[onboarding-a-tenant.md](onboarding-a-tenant.md)):

```bash
npx sst shell --stage dev -- \
  npm --prefix packages/api run bootstrap-operator -- you@example.com
```

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

## Sentry — error monitoring (one-time setup, then automatic)

Errors (frontend + backend) report to **Sentry org `medicoach-ap`, EU region
(`de.sentry.io`)** — kept in the EU for POPIA. Two projects: `dolphins-web` (SPA) and
`dolphins-api` (Lambda). With no DSN set, all Sentry code is a guarded no-op, so the
stack deploys fine before this is done.

**One-time provisioning:**

1. In `de.sentry.io` (org `medicoach-ap`, team `medicoach`) create two projects if they
   don't exist: `dolphins-web` (platform React) and `dolphins-api` (platform Node/AWS
   Lambda). Copy each project's DSN (host must be `*.de.sentry.io`).
2. Set the DSNs as SST secrets (per stage):

   ```bash
   npx sst secret set SentryDsnApi '<dolphins-api DSN>' --stage dev
   npx sst secret set SentryDsnWeb '<dolphins-web DSN>' --stage dev
   ```

3. Create a Sentry **org auth token** (scopes: `project:releases`, `project:read`,
   `project:write`) for source-map upload. Put it in a git-ignored file at repo root:

   ```bash
   echo 'SENTRY_AUTH_TOKEN=<token>' > .env.sentry-build-plugin
   ```

**Every deploy (automatic):** `npm run deploy[:dev]` derives one release id
(`dolphins@<version>+<gitSha>`) shared by both builds, injects the DSNs, and — because
`npm run build` inherits the shell env / auto-loads `.env.sentry-build-plugin` — uploads
the SPA source maps to `dolphins-web` and deletes the `.map` files before they reach S3.

> **Verify after a real deploy:** the build log should show `@sentry/vite-plugin` uploading
> artifacts. If the auth token is missing the plugin warns and skips upload (the build still
> succeeds) — so confirm the latest release in `dolphins-web` actually has artifacts, else
> production stack traces will be minified. A forced 500 should appear in `dolphins-api`
> tagged with `tenant`/`role`; a deliberate 4xx should **not** create an event.

## 7. Tear down dev

```bash
npm run deploy:remove
```

## Notes

- **Custom domains** (prod): vanity hosts, certs, and the host→tenant map are all driven
  by `infra/tenants.ts` — see the go-live checklist in
  [onboarding-a-tenant.md](onboarding-a-tenant.md). Branding is applied at runtime from
  `GET /tenant` (no edge function). In dev we use `x-tenant`. See
  [auth-and-roles.md](auth-and-roles.md).
- **Email delivery:** Cognito's default email has a low daily cap — fine for the spike.
  For real use, wire SES (available in af-south-1).
- **POPIA / erasure:** see [popia-compliance.md](popia-compliance.md).

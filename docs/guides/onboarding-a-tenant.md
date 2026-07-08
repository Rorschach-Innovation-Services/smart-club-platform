# Onboarding a new client (tenant)

Adding a client (e.g. Sharks) happens in the **operator portal** — no code change and no
seed run. The whole platform is one shared stack
([ADR 0002](../architecture/0002-single-tenant-saas-vs-isolated-stacks.md)); the tenant
registry and the operator role are
[ADR 0006](../architecture/0006-platform-operator-and-tenant-registry.md).

Only the **vanity domain** (their own hostname) needs infra work — the go-live checklist
below.

## 0. One-time: bootstrap a platform operator

The portal is gated by the platform membership `{tenantId: '*', role: 'operator'}`. There
is no tenant admin above operators, so the first one is provisioned out-of-band:

```bash
npx sst shell --stage <stage> -- \
  npm --prefix packages/api run bootstrap-operator -- you@medicoach.co.za
```

They sign in via the normal email OTP from any configured host and open **`/platform`**.
(Local dev: `npm run dev:local`, then pick **Platform operator** in the dev sign-in.)

## 1. Create the client in the portal

`/platform` → **New client**. The wizard walks through:

1. **Slug** — short, unique, lowercase (`^[a-z][a-z0-9-]{1,31}$`; `www`, `api`, `platform`,
   `admin` are reserved). It becomes the `TENANT#<slug>#` key prefix and (usually) the
   vanity subdomain. A duplicate slug is rejected with a 409 — never silently merged.
2. **Identity** — organisation name (required) + display title.
3. **Logo** — PNG/SVG/WebP, ≤ 1 MB. Uploaded to the public assets bucket under
   `branding/<slug>/`; a failed upload just warns (retry from the client's settings page).
4. **Deadline** — the affiliation submission deadline. The tenant is created here, blank:
   the client onboards its own clubs/series in the app.
5. **First admin** — email address; grants a passwordless Cognito account + admin
   membership (same mechanics as the `bootstrap-admin` CLI, which still works).

Everything else — copy slots, color tokens, favicon, feature flags, more admins — is
edited later from the client's settings page. Branding editing is operator-only for now
(tenant-admin self-service is reserved behind the `selfServeBranding` flag; see ADR 0006).

## 2. Vanity go-live checklist

A new tenant exists in the registry immediately, but its own hostname needs certs + DNS.
The client's settings page has a **DNS sheet** with these steps and the CNAME records to
send them; `infra/tenants.ts` carries the same runbook. **Sequence matters.**

1. **Reissue BOTH ACM certs with the new SANs.** ACM cannot append SANs to an existing
   cert — request **new** certs, and each must still cover **all** existing tenant hosts
   plus the new `<webHost>`, `www.<webHost>` and `<apiHost>`, or the tenants already live
   get cert errors. Mind the regions: web/CloudFront cert in **us-east-1**, API Gateway
   cert in **af-south-1** (HTTP API custom domains are regional).

   ```bash
   aws acm describe-certificate --region us-east-1 --profile medicoach \
     --certificate-arn <web-arn> --query 'Certificate.SubjectAlternativeNames'
   aws acm describe-certificate --region af-south-1 --profile medicoach \
     --certificate-arn <api-arn> --query 'Certificate.SubjectAlternativeNames'
   ```

2. **Validate, then swap the ARNs.** The client creates the ACM DNS-validation CNAMEs at
   their provider; once both certs are ISSUED, update `WEB_CERT_ARN` / `API_CERT_ARN` in
   `infra/tenants.ts`. This must **complete before** the deploy that adds the alias.

3. **Check for alias conflicts.** `sst diff` will NOT catch `CNAMEAlreadyExists` — if
   another distribution in the shared medicoach account already claims the host, the
   deploy fails mid-flight:

   ```bash
   aws cloudfront list-distributions --profile medicoach \
     --query 'DistributionList.Items[].Aliases.Items'
   ```

4. **Add the `VANITY` entry and deploy.** In `infra/tenants.ts`:

   ```ts
   { slug: 'sharks', webHost: 'clubs.sharks.co.za', www: true,
     apiHost: 'api.clubs.sharks.co.za', enabled: true },
   ```

   `sst.config.ts` derives everything from this — the web alias on the shared CloudFront
   distribution, the extra API Gateway domain mapping, `TENANT_HOST_MAP`, the CORS
   allowlist, and the SPA's web→API map. Then `npx sst deploy --stage prod` (deploys are
   user-run).

5. **Client creates the live CNAMEs** (targets are in the deploy outputs / DNS sheet):
   `<webHost>` and `www.<webHost>` → the CloudFront distribution domain; `<apiHost>` → the
   API Gateway regional domain. Each tenant gets its **own API hostname** because the API
   resolves the tenant from its own `Host` header (ADR 0006).

6. **Verify.** Open `https://<webHost>` — the login page paints with the client's logo,
   colors and copy, and sign-in works end to end.

## 3. Hand over

The first admin signs in via email OTP, generates the tenant's **club signup link**
(All Clubs → "Invite clubs", or Settings → Club self-registration) and shares it once with
the club reps. Each rep registers their own club through the link — that creates the club
**and** the rep's account/membership, so no per-club admin work remains. Team & Access
(`POST /admin/users`) is only needed for additional admins or extra reps.

## Dev stages & the seed CLI

The seed CLI still provisions the dev/demo tenants (dolphins, lions), but `BRANDING` in
`seed-core.ts` is **dev/demo seed data only** — the DynamoDB CONFIG rows are the registry
source of truth. The default seed is create-if-absent (it will never overwrite a
portal-edited row; `--force` is the explicit escape hatch):

```bash
npx sst shell --stage dev -- npm --prefix packages/api run seed            # skip-if-exists
npx sst shell --stage dev -- npm --prefix packages/api run seed -- lions --force
```

To bring pre-existing rows up to the current branding shape (full color-token family,
new copy slots, the registry GSI) without re-seeding, use the merge-patch backfill:

```bash
npx sst shell --stage <stage> -- \
  npm --prefix packages/api run backfill-branding -- --dry-run   # then without --dry-run
```

## Catalogue customisation

v1 ships shared, frozen districts/leagues/CQI. Per-tenant catalogue overrides
(different leagues or CQI weights) are a phase-2 feature — see
[ADR 0005](../architecture/0005-frozen-catalogues-v1.md). Branding, copy, feature flags,
deadline, known-clubs, and required-docs are already per-tenant.

## Offboarding

To remove a client (contract end / POPIA erasure), see
[popia-compliance.md](popia-compliance.md#erasure). Deleting the CONFIG row also removes
the tenant from the platform registry (the GSI entry lives on the same item).

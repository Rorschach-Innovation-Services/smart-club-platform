# Onboarding a new union (tenant)

Adding a union (e.g. Sharks) is configuration, not a code change. The whole platform is
one shared stack ([ADR 0002](../architecture/0002-single-tenant-saas-vs-isolated-stacks.md)).

## Steps

1. **Choose a slug** — short, unique, lowercase (e.g. `sharks`). It becomes the `TENANT#<slug>#`
   key prefix and the subdomain. The seed/create path uses `attribute_not_exists` so a
   duplicate slug is rejected rather than silently merging tenants.

2. **Add branding.**
   - Add a branding block for the slug in `packages/api/src/seed-core.ts` (`name`, `title`,
     `logoUrl`, `colors`, `copy`).
   - Add `packages/api/seed-data/<slug>.json` with at least `{ submissionDeadline }` (the
     `clubs`/`series` fields are only used by the opt-in `--demo` load).
   - Upload the logo to the Uploads bucket / a CDN path referenced by `logoUrl`.

3. **Provision the tenant (blank):**

   ```bash
   npx sst shell --stage <stage> -- npm --prefix packages/api run seed -- <slug>
   ```

   This writes only the config (branding + deadline) — the cohort starts **empty** so the
   union onboards its own clubs/series in the app. (For a demo/set account, append `--demo`
   to also load the sample clubs + series. To blank a tenant that already has data:
   `… run clear-cohort -- <slug> --confirm`.)

4. **Point DNS + TLS** (prod): add the host(s) to the StaticSite/API `domain` config and to
   `TENANT_HOST_MAP` in `sst.config.ts` (a host→tenant slug map — needed when the host label
   isn't the slug, e.g. `api.<…>` or a vanity host like `dolphinspipeline` → `dolphins`).
   Mind the cert region: the **web/CloudFront cert MUST be in us-east-1**; the **API Gateway
   custom-domain cert MUST be in af-south-1** (HTTP API custom domains are regional — a
   us-east-1 cert can't attach). Each cert's SANs must cover **every** host it fronts —
   verify before deploy, or CloudFront/API GW serve cert errors for the missing host:

   ```bash
   aws acm describe-certificate --region us-east-1 --profile medicoach \
     --certificate-arn <web-arn> --query 'Certificate.SubjectAlternativeNames'   # apex + www
   aws acm describe-certificate --region af-south-1 --profile medicoach \
     --certificate-arn <api-arn> --query 'Certificate.SubjectAlternativeNames'   # api.<…>
   ```

   `medicoach.co.za` is on external DNS, so use `dns: false` + `cert: <arn>` and create the
   CNAMEs manually. Branding is resolved client-side (no edge function today). (Dev uses the
   `x-tenant` header instead.) See the dolphinspipeline setup for a worked example.

5. **Bootstrap the first admin** (chicken-and-egg: admin-create-only means no one can invite
   the first admin):

   ```bash
   npx sst shell --stage <stage> -- \
     npm --prefix packages/api run bootstrap-admin -- <slug> admin@union.co.za
   ```

6. **Hand over.** The first admin signs in via email OTP, generates the tenant's **club
   signup link** (All Clubs → "Invite clubs", or Settings → Club self-registration) and
   shares it once with the club reps. Each rep registers their own club through the link —
   that creates the club **and** the rep's account/membership, so no per-club admin work
   remains. Clubs appear in the console as they register. Team & Access
   (`POST /admin/users`) is only needed for additional admins or extra reps on an existing
   club.

## Catalogue customisation

v1 ships shared, frozen districts/leagues/CQI. Per-tenant catalogue overrides
(different leagues or CQI weights) are a phase-2 feature — see
[ADR 0005](../architecture/0005-frozen-catalogues-v1.md). Branding, deadline, known-clubs,
and required-docs are already per-tenant.

## Offboarding

To remove a union (contract end / POPIA erasure), see
[popia-compliance.md](popia-compliance.md#erasure).

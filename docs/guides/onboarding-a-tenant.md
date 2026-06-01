# Onboarding a new union (tenant)

Adding a union (e.g. Sharks) is configuration, not a code change. The whole platform is
one shared stack ([ADR 0002](../architecture/0002-single-tenant-saas-vs-isolated-stacks.md)).

## Steps

1. **Choose a slug** — short, unique, lowercase (e.g. `sharks`). It becomes the `TENANT#<slug>#`
   key prefix and the subdomain. The seed/create path uses `attribute_not_exists` so a
   duplicate slug is rejected rather than silently merging tenants.

2. **Add branding + seed data.**
   - Add a branding block for the slug in `packages/api/src/seed.ts` (`name`, `title`,
     `logoUrl`, `colors`, `copy`).
   - Add `packages/api/seed-data/<slug>.json` with `{ submissionDeadline, knownClubs,
clubs, series }`. (For an empty union, `clubs: []`, `series: []`.)
   - Upload the logo to the Uploads bucket / a CDN path referenced by `logoUrl`.

3. **Seed the tenant:**

   ```bash
   npx sst shell --stage <stage> -- npm --prefix packages/api run seed -- <slug>
   ```

4. **Point DNS + TLS** (prod): add the subdomain to the StaticSite `domain` config with an
   ACM cert in af-south-1, and the CloudFront Function host→branding mapping. (Dev uses the
   `x-tenant` header instead.)

5. **Bootstrap the first admin** (chicken-and-egg: admin-create-only means no one can invite
   the first admin):

   ```bash
   npx sst shell --stage <stage> -- \
     npm --prefix packages/api run bootstrap-admin -- <slug> admin@union.co.za
   ```

6. **Hand over.** The first admin signs in via email OTP and invites reps through the app
   (`POST /admin/users`), assigning each rep their club(s).

## Catalogue customisation

v1 ships shared, frozen districts/leagues/CQI. Per-tenant catalogue overrides
(different leagues or CQI weights) are a phase-2 feature — see
[ADR 0005](../architecture/0005-frozen-catalogues-v1.md). Branding, deadline, known-clubs,
and required-docs are already per-tenant.

## Offboarding

To remove a union (contract end / POPIA erasure), see
[popia-compliance.md](popia-compliance.md#erasure).

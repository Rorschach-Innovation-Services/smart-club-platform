# Onboarding a new client (tenant)

Adding a client (e.g. Sharks) happens in the **operator portal** — no code change, no
seed run, and (since the wildcard platform,
[ADR 0007](../architecture/0007-wildcard-subdomains-shared-api-host.md)) **no domain work**:
the client is live at `https://<slug>.club.medicoach.co.za` the moment it's created. The
whole platform is one shared stack
([ADR 0002](../architecture/0002-single-tenant-saas-vs-isolated-stacks.md)); the tenant
registry and the operator role are
[ADR 0006](../architecture/0006-platform-operator-and-tenant-registry.md).

A **vanity domain** (the client's own hostname) is now an OPTIONAL upsell — the checklist in
§2. It needs only a single web-cert reissue, because a vanity tenant shares the platform API
host by default.

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

1. **Slug** — short, unique, lowercase (`^[a-z][a-z0-9-]{0,30}[a-z0-9]$`; `www`, `api`,
   `platform`, `admin` are reserved). It is the client's **fixed internal ID**: the
   `TENANT#<slug>#` key prefix, S3 prefixes, memberships, signed links and Medicoach refs all
   carry it, so it can never change. It is also the client's first web address label
   (`<slug>.club.medicoach.co.za`), which **can** change later (§1b). A duplicate slug is
   rejected with a 409 — never silently merged — and so is a slug that is, or was, any
   client's web address.
2. **Identity** — organisation name (required) + display title.
3. **Logo** — PNG/SVG/WebP, ≤ 1 MB. Uploaded to the public assets bucket under
   `branding/<slug>/`; a failed upload just warns (retry from the client's settings page).
4. **Deadline** — the affiliation submission deadline. The tenant is created here, blank:
   the client onboards its own clubs/series in the app.
5. **First admin** — email address; grants a passwordless Cognito account + admin
   membership (same mechanics as the `bootstrap-admin` CLI, which still works).

Everything else — copy slots, color tokens, favicon, feature flags, more admins — is
edited later from the client's settings page. When setup is finished, the operator can mark
**Setup complete** on that page for a hand-off summary (the live URLs to share); it's
informational and reversible — nothing about the client depends on it. Branding editing is
operator-only for now (tenant-admin self-service is reserved behind the `selfServeBranding`
flag; see ADR 0006).

## 1b. Changing a client's web address (rebrand)

The web address label is separate from the slug
([ADR 0024](../architecture/0024-public-address-separate-from-slug.md)). On the client's
settings page, **Web address → Change** moves it, e.g. `westernprovincecricket` →
`cobras` serves the client at `https://cobras.club.medicoach.co.za`. The internal ID stays
`westernprovincecricket`. Under the hood this is
`PUT /platform/tenants/<slug>/address { publicSlug, expectedCurrent }` (contract in
[tenant.md](../api/tenant.md)).

Before you confirm, tell the client:

- **The old address is retired.** It stops working at once (other API instances may honour it
  for up to a minute) and shows "This club isn't available". It is never given to another
  client. The client can move back to one of its own old addresses later.
- **Everyone signs in again** on the new address; sessions and unsent drafts are per-address.
- **Links already sent to the old address stop working**: player-registration and club-signup
  links, invites, clearance notices. Re-share the registration and signup links from the new
  address. Captain's-report, squad, document-request and certificate links are unaffected
  (they live on `platform.club.medicoach.co.za`), as are the Medicoach sync and stored files.

The change is refused (409) for a client with a vanity domain (its address is set in
`infra/tenants.ts`), for an address another client uses or used, for another client's slug, and
when someone else changed the address since you loaded the page (reload and retry).

## 2. Optional: a vanity domain

The client is already live at `https://<slug>.club.medicoach.co.za`. A vanity domain (their
own hostname) is an upsell. With the shared API host it needs only a **single web-cert
reissue** — no per-tenant API cert. There is no DNS card in the console any more (it was
deleted in September 2026); the client settings page only shows the live URL on the setup
card. The records and steps live here and in the header comment of `infra/tenants.ts`.
**Sequence matters.**

1. **Reissue the WEB cert with the new SANs.** ACM cannot append SANs to an existing cert —
   request a new **us-east-1** cert covering **all** existing web hosts plus `<webHost>` and
   `www.<webHost>`. The helper builds the superset so no live SAN is dropped:

   ```bash
   npm --prefix packages/api run request-cert -- \
     --region us-east-1 --replace <current WEB_CERT_ARN> \
     --add <webHost> --add www.<webHost> --profile medicoach
   ```

   (Only reissue the af-south-1 API cert if the client insists on their **own** `apiHost`
   instead of sharing `api.club.medicoach.co.za` — usually they shouldn't.)

2. **Validate, then swap the ARN.** The client creates the ACM DNS-validation CNAMEs; once
   ISSUED, update `WEB_CERT_ARN` in `infra/tenants.ts`. Must **complete before** the deploy.

3. **Check for alias conflicts.** `sst diff` will NOT catch `CNAMEAlreadyExists`:

   ```bash
   aws cloudfront list-distributions --profile medicoach \
     --query 'DistributionList.Items[].Aliases.Items'
   ```

4. **Add the `VANITY` entry and deploy.** In `infra/tenants.ts` (leave `apiHost` unset so
   the client shares the platform API host):

   ```ts
   { slug: 'sharks', webHost: 'clubs.sharks.co.za', www: true, enabled: true },
   ```

   `sst.config.ts` derives everything from this — the web alias on the shared CloudFront
   distribution, `TENANT_HOST_MAP`, `WEB_ORIGIN_MAP`, the CORS allowlist, and the SPA's
   web→API map. Then `npx sst deploy --stage prod` (deploys are user-run).

5. **Client creates the live CNAMEs** at their DNS provider / cPanel:
   `<webHost>` and `www.<webHost>` → the CloudFront distribution domain. That target is
   `WEB_CNAME_TARGET` in `infra/tenants.ts`; if it is ever empty, read it from
   `aws cloudfront list-distributions --profile medicoach`. (Never advertise
   `www.<slug>.club.medicoach.co.za` — the single-label wildcard cert doesn't cover it.)

6. **Verify.** Open `https://<webHost>` — the login paints with the client's branding and
   sign-in works end to end. The SPA redirects `<slug>.club.medicoach.co.za` to the vanity
   host so sessions stay on one origin.

## 3. Hand over — two paths

**Small / organic clients** (the club list isn't known up front, or clubs are happy to
self-register): the first admin signs in via email OTP, generates the tenant's **club
signup link** (All Clubs → "Invite clubs", or Settings → Club self-registration) and
shares it once with the club reps. Each rep registers their own club through the link —
that creates the club **and** the rep's account/membership, so no per-club admin work
remains. Team & Access (`POST /admin/users`) is only needed for additional admins or
extra reps.

**Federated clients with a known club list, an affiliation pack, and an existing
compliance/structure workbook** (a union like Titans): use the operator's own
**onboarding checklist** instead — §4 below. It's the same shape of work the Titans
engineer CLIs used to do, now done by an operator with no code and no engineer on the
critical path.

## 4. Bulk-onboard a federated client — the operator checklist

Open **`/platform/tenants/<slug>/onboarding`** (or the "Client onboarding" card on the
client's settings page — the operator's step-by-step map for this exact scenario:
20+ known clubs, an affiliation pack already in hand, a league-structure workbook, and
club rosters to bring in before any rep can sign in). Each row shows a **done / in
progress / not started** state, a real progress count where the step is bulk (e.g. "12
of 21 clubs have a member database"), and the first non-done step is called out as
**Up next**. Work down the list in order — later steps genuinely depend on earlier ones:

1. **Document catalogue** — decide what this client submits (Settings → Required
   documents), and mark which document is the **member database** and which is the
   **committee list**. Downstream steps read those documents through their assigned
   ROLE, not by file name. The one hard gate is the **member-database** role: the roster
   step stays locked (with an on-screen explanation) until it's assigned, because it has
   no other way in. The **reps** step is not gated on the committee role — its manual
   invite works without it, so it unlocks once clubs exist; assigning the committee role
   just enables extraction from committee documents instead of typing every contact by
   hand. See
   [ADR 0010](../architecture/0010-self-serve-onboarding.md#1-doc-roles-not-literal-keys).
2. **Districts & leagues** — set up the client's districts and the leagues its clubs
   play in (Settings). Every club and team plan below is built against these.
3. **Clubs exist** — get every club onto the register (Settings → club directory, or
   let the structure wizard in step 5 create them from the workbook as it goes).
4. **Documents in** — run the **bulk document intake** wizard
   (`/platform/tenants/<slug>/doc-intake`) against the client's submission pack (a zip
   or a folder), so every club's member database and committee document land in one
   pass instead of 20+ individual uploads. **This has to come before rosters** — the
   roster wizard parses from the stored member database, it never asks for a fresh
   upload.
5. **Structure & teams in** — run the **structure intake** wizard
   (`/platform/tenants/<slug>/structure-intake`) against the league-structure workbook:
   upload → confirm which workbook section maps to which league (or create a league
   inline) → match/create clubs → review the per-club team plan → commit. A club with
   an existing team plan is excluded from the commit by default; confirm "Include
   anyway" to replace it deliberately.
6. **Rosters in** — run the **roster intake** wizard
   (`/platform/tenants/<slug>/roster-intake`): pick the clubs to parse (only clubs with
   a stored member database are selectable), review each club's parsed players
   (exceptions, duplicate players across clubs, junior age-band mapping), then commit.
   A club whose workbook has no ID-number column gets an explicit "no ID column" toggle
   before committing those rows — it's opt-in per club, never silent.
7. **Reps invited** — run the **reps** page (`/platform/tenants/<slug>/reps`): extract a
   contact from each club's stored committee document (a hint, always reviewed before
   sending) or type one in by hand, then send the invite. A committee document that
   can't be read automatically (usually a scanned PDF) opens the same invite form next
   to a "View document" link instead of erroring.
8. **Setup complete** — once every row reads done, mark setup complete from the
   client's settings page (the same milestone this guide already covers in §1) and
   share the live links.

Every wizard step opens with a short "what this does" explanation and an ⓘ next to any
option whose effect isn't obvious — the checklist and the wizards it links to are
designed so an operator never needs an engineer, or this document, mid-flow. The design
reasoning (why parsing is server-side, why there's no portal undo, the ID-number
decision) is [ADR 0010](../architecture/0010-self-serve-onboarding.md).

## Engineer fallback (large one-off imports, or a workbook shape the wizards reject)

The operator suite in §4 supersedes the original Titans engineer CLIs as the
**go-forward path** for a federated-client onboarding. The CLIs — catalogue script,
compliance/structure import, roster import — still exist and still work; keep them for:

- **Reverting a bad operator commit.** There is deliberately no portal undo (see
  [ADR 0010](../architecture/0010-self-serve-onboarding.md#4-provenance-is-the-revert-contract--there-is-no-portal-undo)) —
  every operator-suite write is provenance-stamped (`intake:roster:…`,
  `intake:structure:…`), the **same shape** as the CLI's own `import:titans-*` markers.
  A CLI `--revert` mode that understands these `intake:*` batches is **not built yet**,
  though: `import-titans-roster.ts --revert` is hardcoded to the CLI's own
  `import:titans-compliance-2026` marker. It's recorded in
  [ADR 0010 §4](../architecture/0010-self-serve-onboarding.md#4-provenance-is-the-revert-contract--there-is-no-portal-undo)
  as the natural next step; until then, recovering an operator commit is a hand-written
  scan on the `registeredBy` prefix (`intake:roster:<slug>:<date>…`), not a flag.
- **A workbook layout the structure wizard's "unsupported layout" screen rejects.** The
  wizard's manifest-free parser handles most shapes; a genuinely unusual one is still an
  engineer-CLI job, same as any pre-suite client.
- **A first bulk import at a scale or urgency where the review-table wizards are too
  slow** (thousands of rows, a hard same-day deadline) — the CLI's `--parse-only` /
  `--confirm` two-phase flow is still the fastest path for a very large one-off.

See [titans-compliance-import.md](../runbooks/titans-compliance-import.md) for the full
CLI runbook.

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
the tenant from the platform registry (the GSI entry lives on the same item), and its
`<slug>.club.medicoach.co.za` URL immediately shows the "club isn't available" screen.

> **Slug reuse:** erasing a client retires every web address it ever used (ADR 0024); those
> labels are tombstones and cannot become a new client's slug. A client that **never changed**
> its address has no tombstones, so its slug can be created again after an erase — and that
> resurrects its URL for a **different** client. Operator-only, low risk — but avoid reusing a
> slug that was ever public.

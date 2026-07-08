# ADR 0006 — Platform operator role, tenant registry, and the /platform portal

**Status:** Accepted

## Context

Onboarding a tenant used to mean editing `seed-core.ts`, running the seed CLI, and
hand-editing host maps in `sst.config.ts` — code changes for what ADR 0002 promised was
configuration. There was also no cross-tenant surface at all: no way to list tenants (the
CONFIG rows were only gettable by slug), no role above tenant admin, and branding edits
meant re-seeding (which clobbered admin-edited fields like `adminCount` and
`copy.support`).

Whitelabeling the platform needs: someone who can administer **all** tenants, a way to
**enumerate** them, a UI to create/configure them, and a domain scheme that scales past
one hardcoded client.

## Decision

### Operator = a platform membership `{tenantId: '*', role: 'operator'}`

The operator is an ordinary `USER#` record whose memberships include the sentinel tenant
`'*'` (`PLATFORM_TENANT`). It rides the existing `memberships` claim through the
PreTokenGeneration Lambda **verbatim — zero auth-pipeline changes**. It can never collide
with tenant access in prod: `resolveTenant` derives the tenant from the Host header, and
no host maps to `'*'` (the `x-tenant`/`?tenant=` overrides that could are dev-only);
`requireTenantMembership` matches the exact tenantId; and slug validation reserves `*` so
no tenant can ever be created under it. The repo layer skips `TENANT#` marker
reconciliation for `'*'`, so an operator never appears in any tenant's Team & Access
roster or admin count.

Operators are provisioned out-of-band (nobody sits above them):
`npm --prefix packages/api run bootstrap-operator -- <email>` under `sst shell`.

### Tenant registry = a GSI partition on the existing CONFIG rows

Every tenant CONFIG item carries `gsi1pk: 'PLATFORM#TENANTS', gsi1sk: <slug>`;
`repo.listTenants()` is one query. **The keys are derived inside the repo write choke
points** (`createTenantConfig` / `putTenantConfig`), never supplied by callers: `stripKeys`
removes GSI attributes on every read, and `putTenantConfig` whole-item-Puts, so a caller
round-tripping a read config could never carry them back — the first `PUT /tenant/config`
would silently delist the tenant. Rows written before the registry get the attributes via
the idempotent `ensureTenantConfigGsi` (run by the `backfill-branding` CLI). Deleting the
CONFIG row deletes the registry entry — same item.

`seed-core.ts` `BRANDING` is demoted to **dev/demo seed data**; the CONFIG rows are the
source of truth. The seed CLI is create-if-absent with an explicit `--force`, so a re-seed
can no longer clobber portal-edited branding.

### The portal lives at `/platform/*` in the existing SPA

Not a separate app: it reuses the session (email OTP), the API client, the design system,
and the one deploy. `isOperator` gates the routes client-side; every `/platform/*` API
route sits behind `authenticate + requirePlatformOperator`. The portal is
tenant-independent — an operator signs in from any configured host, and `:slug` in the
path names the target tenant explicitly instead of the request host. A tenant-less
operator lands on `/platform` instead of the "account isn't linked" gate.

### Branding editing is operator-only; `selfServeBranding` is the upgrade path

The portal edits identity, copy slots, color tokens, favicon, feature flags, deadline and
admins. Tenant admins keep only the two existing narrow editors (org name, support
contact). When a client wants self-service, the reserved `selfServeBranding` flag turns it
on per tenant — the edit form already works against the shared
`applyTenantConfigPatch`, so it's a gate, not a rewrite. Operator-first avoids shipping a
footgun (a tenant admin repainting production colors) before anyone asks for it. Note the
enforcement split: branding operator-onlyness is a UI convention, not an API one —
`PUT /tenant/config` accepts a branding patch from tenant admins (the org-name editor
depends on it) — whereas `features` IS API-enforced (stripped from tenant-admin patches).

### Each tenant gets its own API hostname

The API resolves the tenant from **its own** `Host` header — a shared API host would make
every authed request ambiguous. So each `VANITY` entry pairs a webHost with a dedicated
apiHost: the web hosts ride as aliases on the one CloudFront distribution (one multi-SAN
cert), the extra apiHosts are additional API Gateway domain mappings onto the one API. The
SPA picks its API base at runtime (`apiBase()` over the baked `VITE_API_HOST_MAP`) instead
of a compile-time constant. `infra/tenants.ts` is the single registry `sst.config.ts`
derives domains, host→tenant map, CORS origins, and the web→API map from.

### Logos live in the public assets bucket

Uploads go to the **public** `TutorialAssets` bucket under `branding/<slug>/…` — the login
page renders the logo unauthenticated, so the private `Uploads` bucket is the wrong home.
Upload is a presigned **POST**, not PUT: only a POST policy can enforce
`content-length-range` (≤ 1 MB) server-side, plus a png/svg/webp content-type allowlist.
The SST resource keeps its historical `TutorialAssets` name — renaming would replace the
bucket.

## Why

- **`'*'` membership over a dedicated "platform" tenant or a user flag.** A dedicated
  tenant would be a phantom row in the registry, in erasure sweeps, and in marker
  reconciliation; a separate flag (Cognito attribute or new claim) would need a new
  token-mint path and a second authorization vocabulary. The sentinel reuses everything —
  storage, claim, middleware shape — and needed only two `continue`s in marker
  reconciliation.
- **GSI over a scan or a separate registry item.** A scan is O(table); a single "list of
  tenants" item is a second source of truth that can drift from the CONFIG rows. The GSI
  keys the registry off the rows themselves.
- **Portal-in-SPA over a separate app.** A second app means a second auth wiring, deploy,
  and design system for three screens. The marginal bundle cost is a lazy route.

## Consequences

- Pre-registry CONFIG rows are invisible to `listTenants()` until `backfill-branding`
  runs — a required step when promoting this to an existing stage.
- Marker reconciliation and slug validation must keep treating `'*'` as special; both are
  unit-tested.
- A portal-created tenant is real immediately, but unreachable on its own domain until the
  vanity go-live checklist completes (certs → `infra/tenants.ts` → deploy → client
  CNAMEs) — see [onboarding-a-tenant.md](../guides/onboarding-a-tenant.md).
- Logo objects are world-readable by design; nothing sensitive may ever be written under
  `branding/`.

## Deferred: wildcard-subdomain scheme

The zero-deploy alternative — `<slug>.smartclub.medicoach.co.za` +
`<slug>.api.smartclub.medicoach.co.za` wildcard baselines, so a portal-created tenant is
**instantly** reachable — is designed but deliberately not built:

- Two wildcard cert reissues (`*.smartclub…` us-east-1, `*.api.smartclub…` af-south-1) on
  top of the vanity certs, plus a wildcard API Gateway custom domain.
- cPanel (the external DNS host for `medicoach.co.za`) has **unverified** support for the
  nested wildcard CNAMEs this needs.
- `originAllowed()` is an enumerated allowlist that also anti-phishing-validates
  invite/reg-link URLs server-side; a wildcard origin would need a tenant-registry
  existence check on that path or it widens the phishing surface.
- `GET /tenant` on an unclaimed subdomain needs a designed "club doesn't exist" state
  instead of a raw 404.

Vanity go-live is a checklist measured in one cert turnaround, which is acceptable at the
current onboarding rate. Revisit if instant demo URLs become a sales need.

## Alternatives considered

- **Dedicated platform tenant** (`TENANT#platform#` + admin role): phantom tenant
  everywhere a real one is enumerated; rejected above.
- **Cognito group / custom attribute for operators:** authorization would live in two
  places (DB memberships + pool attributes), breaking the ADR 0003 model where the `USER#`
  record is the single authority.
- **Separate operator app** (own Vite app or subdomain): duplicated auth/deploy/design for
  three screens.
- **Wildcard subdomains now:** deferred, above.

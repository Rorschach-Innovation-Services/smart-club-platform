# ADR 0007 — Wildcard tenant subdomains + one shared API host

**Status:** Accepted (July 2026). Supersedes the "Deferred: wildcard-subdomain scheme"
section of [ADR 0006](0006-platform-operator-and-tenant-registry.md).

## Context

A tenant created in the operator portal ([ADR 0006](0006-platform-operator-and-tenant-registry.md))
existed only as a DynamoDB CONFIG row: reachable on no domain until a manual, code-editing,
deploy-gated runbook completed (reissue two ACM certs, edit `infra/tenants.ts`, deploy, and
hand-create cPanel CNAMEs). We wanted portal-created tenants reachable **instantly, with zero
per-tenant work**, while keeping the vanity-domain path for clients who want their own hostname.

The platform is one shared stack ([ADR 0002](0002-single-tenant-saas-vs-isolated-stacks.md)):
one CloudFront distribution, one HTTP API Lambda, one DynamoDB table. Only hostnames were ever
per-tenant. `medicoach.co.za` DNS is external cPanel (no Route53). The account's CloudFront
cache-policy quota is maxed (20/20), so no new distribution can be created.

## Decision

Every tenant is reachable at **`https://<slug>.club.medicoach.co.za`** the moment it's created:

1. **Web** — ONE wildcard alias `*.club.medicoach.co.za` on the existing CloudFront
   distribution (no new distribution; the reissued us-east-1 `WEB_CERT_ARN` gains the
   `*.club.…` SAN alongside the existing vanity hosts).
2. **API** — ONE shared host **`api.club.medicoach.co.za`** for all wildcard tenants
   (`SHARED_API_HOST`), a single af-south-1 `SHARED_API_CERT_ARN`. The API resolves the
   tenant from the request's **`Origin`** header when the Host is the shared host (it's
   `api.club.…` for everyone). See `resolveTenant()` in `packages/api/src/auth.ts`.

The whole scheme is **armed by setting `SHARED_API_CERT_ARN`** in `infra/tenants.ts`; until
then it is dormant and the stack behaves exactly as the vanity-only setup, so the code can
land (and even deploy) ahead of the rollout. Rollout: `docs/runbooks/wildcard-domain-rollout.md`.

### Shared API host vs a wildcard API host

We chose ONE shared API host over `*.api.club.…`. A wildcard API host would have needed no
resolver change (the existing leftmost-label rule already resolves `demo.api.club.…` → `demo`)
but costs a second wildcard cert reissue and a wildcard API Gateway domain. The shared host
needs only one cert, at the cost of Origin-based resolution. **The trade this locks in:** a
**non-browser** authenticated client hitting the shared API host MUST send an `Origin` header
(or use a vanity host), because Origin is the only tenant signal there. Browsers always send a
truthful Origin, so this is invisible to the SPA; it matters only for curl/e2e/native clients.

### Why Origin-derived tenant selection is safe

`resolveTenant()` only *selects* which tenant a request targets; it is not the isolation
boundary. Enumerated in code:

- `GET /tenant` is the only **unauthenticated** consumer and returns only public per-tenant
  data (branding, deadline, leagues, districts, tutorials, flags), with a pre-existing
  `?tenant=` fallback — Origin adds no exposure.
- `/register/*` and `/club-signup` derive the tenant from **tokens**, not host/Origin.
- Every authed route gates on `requireTenantMembership`: the JWT `memberships` claim is the
  real boundary. A spoofed Origin only lets a caller select a tenant they already belong to —
  the same power the dev `x-tenant` header grants.

There are **no cookies** (Amplify localStorage), so no CSRF surface. `club.medicoach.co.za` is
**not** on the Public Suffix List, so a domain-wide cookie would be readable across tenants:
**never move auth to cookies scoped at/above `club.medicoach.co.za`.**

### CORS vs link validation (split origin checks)

`packages/api/src/origins.ts` splits what used to be one `originAllowed`:

- `originAllowed` (CORS) is broad: localhost, `*.cloudfront.net`, enumerated vanity origins,
  and any single-label `https://<label>.club.medicoach.co.za`.
- `originAllowedForTenant` (invite/registration link validation) is strict: only THAT tenant's
  own origins (its vanity host + www, and its wildcard host). It rejects `*.cloudfront.net` and
  other tenants' hosts — closing a pre-existing hole where an admin could aim a platform-branded
  invite at an attacker's CloudFront clone. A dormant tenant with no canonical origin yet falls
  back to the broad check (nothing tenant-specific to enforce), so behavior is unchanged until a
  tenant gains a vanity/wildcard origin.

`canonicalWebOrigin(slug)` — a tenant's vanity origin if it has one, else its wildcard origin —
is the single source for outbound links and the D5 redirect.

### One origin per tenant (D5)

A vanity tenant is also reachable on the wildcard host, but sessions (localStorage/Cognito
tokens) don't cross origins. So the SPA redirects the wildcard host to the tenant's canonical
vanity origin at boot (`redirectToCanonicalOrigin`, scoped to fire ONLY on the wildcard host for
a tenant that has a vanity origin). Wildcard-only tenants and the vanity host itself are untouched.

### Unknown club

On the wildcard host every `<slug>.club.…` resolves in DNS, so an unclaimed/mistyped slug would
otherwise load a half-broken app. `GET /tenant` returns 404 for an unknown slug; the SPA renders
a neutral-branded "This club isn't available" screen and does not retry the 404 (also stops
subdomain-scanning bots from tripling DynamoDB reads).

## Consequences

- Portal-created tenants are live immediately — no cert, DNS, or deploy per tenant.
- Vanity domains remain an optional upsell, now needing only ONE web-cert reissue (a vanity
  tenant may share the API host by leaving `VanityDomain.apiHost` unset).
- The slug is now a live DNS label, so `TENANT_SLUG_RE` forbids a trailing hyphen.
- ACM renewal depends on validation CNAMEs held in cPanel (or a delegated Route53 zone) that
  this repo can't observe — a cert-expiry alarm is part of the rollout.
- Operators get an explicit, reversible "setup complete" milestone (informational only) with a
  hand-off summary of the live URLs.

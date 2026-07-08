# Smart Club Platform

A multi-tenant SaaS for cricket unions to run club **affiliation, compliance, the Club
Quality Index (CQI), and fixtures** for a season. Each union (tenant) gets its own branded
site on its own subdomain; all unions share one backend. Hosted entirely in AWS
**af-south-1** for South African data residency (POPIA).

Two unions ship today as tenants — **Hollywoodbets Dolphins** and **DP World Lions** — from
one codebase. New clients are created in the **operator portal** (`/platform`), not forked:
see [`docs/guides/onboarding-a-tenant.md`](docs/guides/onboarding-a-tenant.md) and
[ADR 0006](docs/architecture/0006-platform-operator-and-tenant-registry.md).

> The sibling `../lions-smart-club` repo (github `niallnaidoo/lions-smart-club`) is a stale
> pre-backend prototype fork, superseded by the `lions` tenant here — it should be archived.

> Stack: Vite 5 + React 18 (SPA, JSX) · TanStack Query · AWS Amplify (auth) on the front;
> SST → DynamoDB + Lambda (Hono) + API Gateway + Cognito (passwordless email OTP) + S3 on
> the back. See [`docs/architecture/overview.md`](docs/architecture/overview.md).

## Run & test locally

```bash
npm install
cd packages/api && npm install && cd ..
```

Local config goes in **`.env.development.local`** (gitignored; loaded only in dev, never in a
production `build`, so it can't leak into a deploy). Create the file with one of the two
profiles below.

### Option A — fully offline (no AWS, recommended)

Runs the whole backend on your machine — an in-process DynamoDB (`dynalite`, no Docker/Java)
and the same Hono API. Cognito can't run offline, so login is a dev "sign in as" picker.

```bash
# .env.development.local
VITE_API_URL=http://localhost:3333
VITE_LOCAL_AUTH=1
VITE_DEFAULT_TENANT=dolphins
```

```bash
npm run dev:local        # local API + dynalite (:3333) AND the SPA (:3201), BLANK cohort
npm run dev:local:demo   # same, but pre-loads 14 sample clubs + 2 series to click through
```

(Starts both together and stops both on Ctrl-C. To run just the API: `npm --prefix
packages/api run dev:local`.) Open the SPA, pick **Administrator** (or **Club rep** + club
ids) — no email/OTP. Tenants start **blank** (like production) — onboard a club to begin; use
`dev:local:demo` if you want the sample cohort. Data persists within a run and resets when you
restart (dynalite is in-memory); uploads are stubbed (no S3).

### Option B — local frontend → deployed dev backend (real Cognito OTP)

```bash
# .env.development.local
VITE_API_URL=https://<api>.execute-api.af-south-1.amazonaws.com
VITE_USER_POOL_ID=af-south-1_xxxxx
VITE_USER_POOL_CLIENT_ID=xxxxx
VITE_DEFAULT_TENANT=dolphins
```

`npm run dev`, then sign in with a bootstrapped user via real email OTP (the API's CORS
allowlist permits `localhost`). Use for testing the real auth path. (`npm run dev:sst` also
runs the API Lambda live against the dev cloud resources.)

`localhost` has no subdomain, so the tenant comes from `VITE_DEFAULT_TENANT` (or `?tenant=lions`).

## Deploy

All AWS resources live in one `sst.config.ts`. The full step-by-step (including the Cognito
passwordless **auth spike** to run first) is in
[`docs/guides/deploy-and-spike.md`](docs/guides/deploy-and-spike.md):

```bash
npm run deploy:dev     # stage=dev, af-south-1, profile medicoach
npm run deploy         # stage=prod
```

After deploying, seed the dev tenants and bootstrap the first admin (dev stages; in prod,
tenants and admins are created via the operator portal):

```bash
npx sst shell --stage dev -- npm --prefix packages/api run seed
npx sst shell --stage dev -- npm --prefix packages/api run bootstrap-admin -- dolphins you@example.com
npx sst shell --stage dev -- npm --prefix packages/api run bootstrap-operator -- you@example.com  # /platform portal
```

## How it works

- **Tenancy.** One DynamoDB table, every item keyed `TENANT#<t>#…`; middleware scopes each
  request to the caller's tenant. Branding resolves per host. See
  [ADR 0002](docs/architecture/0002-single-tenant-saas-vs-isolated-stacks.md).
- **Auth.** Passwordless email OTP via Cognito. Role/tenant/club scope ride the token's
  `memberships` claim (no passwords, no role-picking). See
  [ADR 0003](docs/architecture/0003-cognito-passwordless-memberships.md).
- **Thin API.** The API is tenant-scoped CRUD; dashboards, leaderboards, travel-cost,
  round-robin and CQI scoring are computed in the browser. See
  [ADR 0004](docs/architecture/0004-thin-crud-client-side-compute.md).
- **Player registration.** Public, tokenized links (`/register/:clubId?t=…`) capture players
  (with POPIA consent for minors); club player counts derive from these.

## Project layout

| Path            | Purpose                                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`          | React SPA. `main.jsx` (shell + routing), `admin.jsx`, `club.jsx`, `atoms.jsx`, `data.jsx` (shared catalogues + compute helpers), `api.js`, `auth.jsx`, `config.js`, `query.js`, `Login.jsx`, `RegisterPage.jsx` |
| `packages/api/` | Hono API on Lambda: `index.ts` (routes), `repo.ts` (tenant-scoped DynamoDB), `auth.ts` (JWT + tenant middleware), `pre-token-gen.ts`, `seed.ts`, `bootstrap-admin.ts`                                           |
| `sst.config.ts` | All AWS infra (af-south-1)                                                                                                                                                                                      |
| `docs/`         | [architecture](docs/architecture/) (ADRs, data model), [api](docs/api/) reference, [guides](docs/guides/) (deploy, auth, tenant onboarding, POPIA)                                                              |

## Quality

```bash
npm run lint
npm run format:check
cd packages/api && npm run typecheck
```

_Powered by Medicoach._

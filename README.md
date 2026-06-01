# Smart Club Platform

A multi-tenant SaaS for cricket unions to run club **affiliation, compliance, the Club
Quality Index (CQI), and fixtures** for a season. Each union (tenant) gets its own branded
site on its own subdomain; all unions share one backend. Hosted entirely in AWS
**af-south-1** for South African data residency (POPIA).

Two unions ship today as tenants — **Hollywoodbets Dolphins** and **DP World Lions** — from
one codebase. Adding another is a config row + seed, not a fork.

> Stack: Vite 5 + React 18 (SPA, JSX) · TanStack Query · AWS Amplify (auth) on the front;
> SST → DynamoDB + Lambda (Hono) + API Gateway + Cognito (passwordless email OTP) + S3 on
> the back. See [`docs/architecture/overview.md`](docs/architecture/overview.md).

## Quick start (local dev)

```bash
npm install
cd packages/api && npm install && cd ..
npm run dev            # http://localhost:3201
```

The SPA talks to a deployed dev API. Set these in a `.env` (Vite reads `VITE_*`); the deploy
prints them (see the runbook):

```
VITE_API_URL=https://xxxx.execute-api.af-south-1.amazonaws.com
VITE_USER_POOL_ID=af-south-1_xxxxxxxxx
VITE_USER_POOL_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
VITE_DEFAULT_TENANT=dolphins      # dev only: which tenant to theme as (prod uses the host)
```

Without a backend the app still loads (neutral theme) but sign-in and data won't work.

## Deploy

All AWS resources live in one `sst.config.ts`. The full step-by-step (including the Cognito
passwordless **auth spike** to run first) is in
[`docs/guides/deploy-and-spike.md`](docs/guides/deploy-and-spike.md):

```bash
npm run deploy:dev     # stage=dev, af-south-1, profile medicoach
npm run deploy         # stage=prod
```

After deploying, seed tenants and bootstrap the first admin:

```bash
npx sst shell --stage dev -- npm --prefix packages/api run seed
npx sst shell --stage dev -- npm --prefix packages/api run bootstrap-admin -- dolphins you@example.com
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

| Path | Purpose |
|------|---------|
| `src/` | React SPA. `main.jsx` (shell + routing), `admin.jsx`, `club.jsx`, `atoms.jsx`, `data.jsx` (shared catalogues + compute helpers), `api.js`, `auth.jsx`, `config.js`, `query.js`, `Login.jsx`, `RegisterPage.jsx` |
| `packages/api/` | Hono API on Lambda: `index.ts` (routes), `repo.ts` (tenant-scoped DynamoDB), `auth.ts` (JWT + tenant middleware), `pre-token-gen.ts`, `seed.ts`, `bootstrap-admin.ts` |
| `sst.config.ts` | All AWS infra (af-south-1) |
| `docs/` | [architecture](docs/architecture/) (ADRs, data model), [api](docs/api/) reference, [guides](docs/guides/) (deploy, auth, tenant onboarding, POPIA) |

## Quality

```bash
npm run lint
npm run format:check
cd packages/api && npm run typecheck
```

*Powered by Medicoach.*

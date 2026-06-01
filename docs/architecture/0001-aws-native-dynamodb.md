# ADR 0001 — AWS-native backend on DynamoDB

**Status:** Accepted

## Context

The prototype is a front-end-only SPA already deployed to AWS (S3 + CloudFront via SST) in
`af-south-1`. South African data residency (POPIA) was the reason that region was chosen. We
need real persistence, auth, and file storage, and the team's strength is front-end, not ops.

Two broad paths existed: a Backend-as-a-Service (Supabase or Firebase) that bundles
DB + auth + storage with minimal backend code, or staying AWS-native and building on the
existing SST deployment.

## Decision

Stay **AWS-native via SST**, with **DynamoDB** as the database, plus Lambda (Hono), API
Gateway, Cognito, and S3 — all in `af-south-1`.

## Why

- **Residency.** Supabase and Firebase have no `af-south-1` region; club data (including
  minors') would leave South Africa. Staying on AWS keeps every byte in Cape Town, which is
  the constraint that originally fixed the region.
- **One cloud, one deploy.** The app already ships through SST to AWS. Adding Dynamo/Lambda/
  Cognito to the same `sst.config.ts` avoids introducing a second vendor and a second
  operational surface.
- **DynamoDB over Aurora.** The domain is small and id-keyed with known access patterns
  (see [data-model.md](data-model.md)). DynamoDB on-demand has no idle cost and no instance to
  manage; Aurora Serverless carries a baseline cost and more operational weight than this scale
  justifies.

## Consequences

- Relational conveniences (ad-hoc joins, server-side aggregation) are unavailable. This is
  acceptable because computation stays client-side — see
  [ADR 0004](0004-thin-crud-client-side-compute.md).
- Single-table design requires modelling access patterns up front; documented in
  [data-model.md](data-model.md).
- More backend code than a BaaS would need (auth wiring, an API layer), but the residency and
  single-cloud benefits outweigh it.

## Alternatives considered

- **Supabase** (Postgres + Auth + Storage + RLS): least backend code, but no SA region — fails
  residency.
- **Firebase**: fast to start, but Firestore (NoSQL document) is a poor fit for the relational
  domain (clubs ↔ series ↔ fixtures ↔ players) and also has no SA region.
- **AWS + Aurora Serverless Postgres**: relational comfort, but baseline cost and ops weight
  exceed the need at tens of clubs per tenant.

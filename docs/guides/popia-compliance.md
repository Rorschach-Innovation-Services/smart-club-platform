# POPIA compliance

The platform stores personal information of club officials and players — including
**minors** (junior leagues U11/U13/U15) — so South Africa's Protection of Personal
Information Act (POPIA) applies. This guide records the design choices that support
compliance. It is engineering guidance, not legal advice; confirm specifics with counsel.

## Data residency

All persistent data lives in a single DynamoDB table in **af-south-1 (Cape Town)**, and all
compute (Lambda) and storage (S3) run in the same region. Data does not leave South Africa.
CloudFront (static assets + the branding edge function) is the only global component and
holds no personal information. Residency was the reason AWS af-south-1 was chosen — see
[ADR 0001](../architecture/0001-aws-native-dynamodb.md).

## Lawful processing & consent

- **Players** register via a public link. The registration captures consent at submission
  time (`consentAt`, stamped server-side).
- **Minors** (computed from date of birth, under 18) require a **guardian name** before the
  registration is accepted; the server rejects a minor registration without it. Treat the
  guardian field as the record of parental consent. (If stronger proof is later required —
  guardian identity / signed consent — extend the registration payload; the field is already
  load-bearing.)
- Collect the minimum necessary fields. The current set is name, DOB, optional cell/email,
  and (for minors) guardian name.

## Tenant isolation

Each union's data is partitioned under `TENANT#<t>#` and access is gated by the caller's
tenant membership, so one union cannot access another's personal data. See
[auth-and-roles.md](auth-and-roles.md).

## Erasure & offboarding {#erasure}

POPIA's right to erasure and contract-end offboarding are supported by tenant-prefixed
deletion:

- `repo.eraseTenantData(tenant)` scans the table by the `TENANT#<t>#` prefix and
  batch-deletes all clubs, series, players, and the tenant config.
- Users (`USER#<sub>`) are not tenant-prefixed; they are enumerated for a tenant via the
  `TENANT#<t>#TYPE#USER` GSI (`repo.listTenantUsers`) and deleted, along with their Cognito
  accounts.

For an individual erasure request (a single player/official), delete that item by its key
(`PLAYER#<naturalKey>` under the club, or the `USER#` record + Cognito user).

## Retention

Define a retention period per season and schedule deletion of stale player registrations.
Not automated in v1 — flagged as an operational follow-up.

## Auditability

Club `paid` and affiliation changes record `changedBy`/`changedAt`. Consider extending
audit coverage (who viewed/exported personal data) before onboarding paying unions at scale.

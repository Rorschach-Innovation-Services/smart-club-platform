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

### Cross-border transfer (outbound messaging)

One flow is a **deliberate, documented exception** to the residency rule: the onboarding
**invite** to a club chairperson. When an admin sends it (`POST /clubs/:id/send-invite`,
`packages/api/src/notify/`), the chair's **name, email and cell** are transmitted to:

- **Amazon SES in `eu-west-1` (Ireland)** for the email — this account's verified sending
  identity with production access lives in eu-west-1 (af-south-1 SES exists but is
  sandboxed for this account, so it cannot send to unverified recipients); and
- **Meta Platforms (WhatsApp Cloud API, global/US)** for the WhatsApp message — an inherently
  global processor.

**Sign-in (OTP) email is not part of this exception**: Cognito requires its SES identity
to live in the pool's own region, so OTP codes are sent from SES **af-south-1** (set by
`packages/api/src/enable-passwordless.ts` once that region's identity is verified and
production access is granted) — staff emails stay in the residency region. Until then the
pool uses Cognito's default sender, also region-local.

The invite flow is a cross-border transfer of personal information under **POPIA s72**.
Basis and controls:

- **Lawful basis:** operational communication necessary to deliver the service the club is
  being onboarded into (the chair provides these details for exactly this purpose). Confirm
  the s72 ground (consent / necessity for the contract) with counsel before enabling real
  sends.
- **Data minimisation:** only the three contact fields and a link leave the region — no player
  or minor data is ever sent through this path.
- **Auditability:** every send is recorded in the club's `commLog` (channel, recipient,
  status, timestamp, actor) so transfers are traceable. The per-send idempotency markers
  (`INVITE#<key>` items) also hold the recipient; both the `commLog` and the markers are
  deleted by tenant/cohort erasure (`repo.eraseTenantData` enumerates the markers
  explicitly — they're not in the club listing index).
- **Sub-processors:** AWS (SES, Ireland) and Meta Platforms (WhatsApp). Add both to the
  processor register / DPA set.
- **Gate:** the path runs in dry-run until SES production access is granted and the secrets are
  set (`FROM_EMAIL`, `WHATSAPP_*`), so nothing leaves the region until this is signed off.

**Residency-improving follow-up:** a Dolphins-owned SES identity + WhatsApp Business account
do not change the regions involved by themselves (WhatsApp is inherently global), but SES
**is** available in af-south-1 — once that region has production access (already required
for Cognito OTP email, see deploy guide step 3), pointing the notify module's `SES_REGION`
at af-south-1 would bring invite email back into the residency region too. Tracked as tech
debt.

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

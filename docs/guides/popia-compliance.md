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

One flow is a **deliberate, documented exception** to the residency rule: the **staff
invite** to an admin or rep. When an admin sends it (`POST /admin/users` /
`/admin/users/:sub/resend` with `channels`, `packages/api/src/notify/`), the invitee's
**email (and cell, for WhatsApp)** is transmitted to:

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

- **Lawful basis:** operational communication necessary to deliver the service the person is
  being given access to (the invitee's details are provided for exactly this purpose). Confirm
  the s72 ground (consent / necessity for the contract) with counsel before enabling real
  sends.
- **Data minimisation:** only the contact fields and a sign-in link leave the region — no
  player or minor data is ever sent through this path. (Historic chair-onboarding invites,
  recorded in club `commLog`s before that flow was retired in favour of club
  self-registration, fall under the same exception.)
- **Auditability:** sends are recorded (channel, recipient, status, timestamp, actor) so
  transfers are traceable. The per-send idempotency markers (`INVITE#<key>` items, still used
  by the fixtures broadcast) hold the recipient; both the `commLog` and the markers are
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

- **Club reps** register their club via the public signup link and provide their own name,
  email and cell. The form requires an explicit consent tick; `signupConsentAt` is stamped
  server-side on the club record (see [signup.md](../api/signup.md)).
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

### Retired document types

When a compliance document type is removed from `REQUIRED_DOCS`, already-uploaded PDFs
become unreachable from the product (the UI only renders `REQUIRED_DOCS`) and would sit
orphaned in the uploads bucket — the same data-minimisation problem as replaced files.
Run the matching cleanup script per tenant **after** the API deploy. The API rejects doc
keys outside its `DOC_KEYS` allowlist (plus keys already on the club record), so once the
backend ships, stale pre-deploy SPA tabs cannot repopulate the retired key:

```sh
# dry-run first, then with --confirm
sst shell --stage <stage> -- npx tsx packages/api/src/cleanup-club-inventory.ts <tenant>
sst shell --stage <stage> -- npx tsx packages/api/src/cleanup-club-inventory.ts <tenant> --confirm
```

Done for Club Inventory (retired from the 2026/27 requirements, June 2026). Note the
removal also retroactively shifts doc-completion counts: clubs missing only the retired
document flip to complete on deploy, and tracker exports lose that column — flag this to
the union office if reports were already circulated.

## Auditability

Affiliation changes record `changedBy`/`changedAt`, and self-registered clubs carry
`onboardedVia`/`signupConsentAt`. Consider extending
audit coverage (who viewed/exported personal data) before onboarding paying unions at scale.

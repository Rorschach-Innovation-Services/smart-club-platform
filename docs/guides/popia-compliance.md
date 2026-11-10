# POPIA compliance

The platform stores personal information of club officials and players — including
**minors** (junior leagues U11/U13/U15) — so South Africa's Protection of Personal
Information Act (POPIA) applies. This guide records the design choices that support
compliance. It is engineering guidance, not legal advice; confirm specifics with counsel.

## Data residency

All persistent data lives in a single DynamoDB table in **af-south-1 (Cape Town)**, and all
compute (Lambda) and storage (S3) run in the same region. Data does not leave South Africa.
CloudFront (static assets) is the only global component and
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
- **Chair onboarding send (reg link + tutorials):** when a chair completes affiliation, the
  same path delivers their club's player-registration link plus a link to the how-to-use-the-app
  tutorial videos, over email + WhatsApp (recorded in `commLog` as `kind: 'reglink'`). Only the
  chair's own contact fields and two non-sensitive links (the reg link; the public `/tutorials`
  page) leave the region — no player/minor data. The reg link is operational communication
  necessary to deliver the service; the **tutorials link is product guidance** and is the weaker
  fit for the s72 "necessity for the contract" ground — confirm its basis with counsel alongside
  the invite flow. If in doubt, the tutorials link can be dropped from the outbound messages
  (it also lives on the in-app Help panel) without affecting the reg-link delivery.
- **Clearance-pending chairman notice:** when a player clearance opens against a club (a
  destination club requests a player, a self-registration declares a previous club, or the
  union office reallocates a clearance), the from-club chair's **email and cell** leave the
  region via the same processors, and — unlike the flows above — the message body carries the
  **player's name**, which for a self-registered minor is a **child's name** crossing to Meta
  and SES (recorded in `commLog` as `kind: 'clearance'`). Basis: operational communication
  necessary to run the transfer/clearance process the union is contracted to provide; the
  child-name element rides the same necessity ground but is the weaker fit — confirm with
  counsel alongside the invite flow. Controls: no ID number, contact detail, or other player
  field is included (name only); sends are capped per club per day (anti-abuse of the public
  registration route); and the same dry-run gate applies.
- **EMCU scorer broadcast (Oct 2026, one-off CLI `send-emcu-scorer-broadcast.ts`).** Purpose:
  **scorer access for EMCU fixtures** on MediCoach. Each EMCU club chair's email and cell leave
  the region via the same processors: the email carries the club's MediCoach scorer logins
  (`scorer<n>.<code>@medicoach.co.za` + password — credentials, not personal information of the
  chair, but sensitive), the WhatsApp only says they were emailed (**no credentials on
  WhatsApp**). EMCU players' (including minors', on the registered — usually guardian — contact)
  email and cell leave the region for a notice that their matches are scored live and scouted on MediCoach (first
  name only). Basis: operational communication necessary to deliver live scoring of the
  fixtures the union runs; confirm with counsel alongside the invite flow. Controls: passwords
  are never logged or written to the run manifest / delivery rows (tests assert it), the
  credentials file stays outside both repos (mode 0600), and replies go to
  info@medicoach.co.za. **End-of-season step:** disable every `scorer*@medicoach.co.za` account
  in MediCoach.
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
  email and cell. The form carries a notice that the union stores these details to administer
  affiliation; consent is implied by submitting (no checkbox), and `signupConsentAt` is
  stamped server-side on the club record at submit time (see [signup.md](../api/signup.md)).
- **Players** register via a public link. The registration captures consent at submission
  time (`consentAt`, stamped server-side).
- **Minors** (computed from date of birth, under 18) require a **guardian name** before the
  registration is accepted; the server rejects a minor registration without it. Treat the
  guardian field as the record of parental consent. (If stronger proof is later required —
  guardian identity / signed consent — extend the registration payload; the field is already
  load-bearing.)
- Collect the minimum necessary fields. The current set is name, DOB, optional cell/email,
  and (for minors) guardian name.
- **Umpires and scorers** can register themselves through a per-role public link (see
  [Umpire and scorer registers](#officials)). The form has a required consent checkbox and
  the server stamps `consentAt` on the record.

## Veterans finder — data minimisation & opaque handles

The veterans squad-selection finder ([ADR 0013](../architecture/0013-veterans-squad-selection.md))
is a tenant-wide name search, so it is minimised by design. The server reads a fixed
`ProjectionExpression` (`sk, firstName, lastName, status, veteransClubId, team, clubId`) that
never touches `idNumber`, `dob`, `cell` or `email` — only the fields needed to show a name plus
primary club and apply the exclusions ever enter Lambda memory, and a test pins the projection so
it cannot silently grow. The finder returns an opaque `candidateId` =
`HMAC-SHA256(secret, tenant|primaryClubId|naturalKey)` rather than the player's identity key
(itself a sha256 identity hash, brute-forceable from a name plus an age guess if handed out): the
HMAC is irreversible and bound to the (tenant, primary club, player) triple, so it can only be
redeemed against that club's rows. Access is gated on the requesting club being fixtured in a
released veterans series (not on the self-settable `club.leagues`), and every finder call is
logged to CloudWatch (tenant, club, rep, query length, result count) as an enumeration-risk audit
trail.

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

For an individual **player** erasure request, a union admin uses "Erase player" in the admin
player modal, which calls `DELETE /admin/players/:nk`. It removes the person from every club in
the tenant: player rows, clearances (with certificates and ID documents), registration reviews,
veterans requests; it scrubs captain's reports that name them and the `captainRef` on pending
`REPORTOPEN#` markers; and it writes a PII-free `PLAYERERASE#` audit row. See the
[API reference](../api/clearances.md#player-erasure) for the contract and what it does **not**
cover (past comm-log entries, `INVITE#` markers, data already exported to Medicoach). For an
official, delete the `USER#` record + Cognito user.

## Umpire and scorer registers {#officials}

The union's umpire and scorer registers hold named individuals who are sent appointment
notices. Contact details are shown only to administrators. See the
[officials API](../api/officials.md) for the contract.

**Collected through the public link.** The office shares one link per role
(`/officials/register?t=<token>`); replacing or turning it off kills the old token at once.
Umpires give first names, surname, cell phone and an optional email. Scorers give the same
plus an optional ID number, emergency contact number and home address. The submit requires a
ticked consent box (the details are used by the union's office to appoint the person and
contact them about fixtures); the server records `consentAt` and `source:
'self-registration'`. The record waits as **pending** (inactive, not appointable) until an
admin approves it, merges it into an existing entry, or rejects it. Reject hard-deletes the
pending record. A merge never overwrites a held phone or email without the admin choosing;
`consentAt` moves to the target and the pending copy is then deleted. The public response is
the same whether or not the person was already on the register. A submission never changes an
existing record: each one is filed separately, so someone holding the link who knows a
person's cell cannot overwrite that person's details. Same-cell pending entries are shown to
the admin side by side, and rejecting one leaves the others.

**Erasure (Delete).** An admin's Delete on an umpire or scorer (`DELETE /umpires/:id`,
`/scorers/:id`) wipes:

- the record's name, full name, aliases, phone, email and (scorers) ID number, emergency
  contact and address, and the same on every record merged into it;
- the official from every fixture not yet played (dated today or later, undated, or date
  TBC), and their name on the officials rows of played fixtures;
- for umpires, the name fields on captain's reports (`umpiresSnapshot[].name`,
  `umpires[].name`, `umpires[].attributed.freeTextName`); a pending report on a fixture not
  yet played drops the entry instead;
- unsent appointment notices (and every notice on fixtures not yet played).

It keeps an anonymous stub under the same id (`Removed umpire` / `Removed scorer`, inactive),
so past appointments and ratings, which are keyed by id, still resolve. Each run writes a
PII-free `OFFICIALERASE#` audit row (role, id, actor, counts). Delete can be re-run on an
erased record to finish an interrupted erase.

**Known residuals.**

- Ids are name slugs (for example `u-a-ngubane`), so the id kept on the stub still hints at
  the name. Re-keying would break rating attribution.
- Free-text umpire names typed by captains, with no register id, are not found by an erase.
- A captain's draft save that read its report just before an erase can write the old name
  back. Re-running Delete clears it.
- If a later appointments sheet still names an erased umpire, an upload with "create
  umpires" on makes a fresh record rather than reviving the stub.
- Erasing on a match day removes the official from that day's fixture, and from its pending
  captain's-report card, even if the match has already been played: today counts as "not yet
  played".
- Registry ids (name slugs) persist in CloudWatch logs written before the erase. The erase
  and pending-merge log lines themselves carry only the role, counts and the audit row id.

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

# Runbook — Clearance certificates: first deploy + backfill

**Owner:** the user runs every AWS command; Claude wrote the code and this runbook.
**Status: NOT YET DEPLOYED.** Feature branch work of 29 Sep 2026 (transfer-certificate PDFs on
clearance approval/override, `CERT#` registry, KMS-signed JWS, public `/verify/:serial` page).

## What the deploy creates

| Resource                                           | Where                 | Notes                                                                                                                                                                                                                       |
| -------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CertSigningKey` (KMS, ECC_NIST_P256, SIGN_VERIFY) | af-south-1, per stage | `retainOnDelete` on every stage; `protect` in prod. **Losing this key breaks JWS verification of every certificate ever issued.** No rotation: a future rotation ADDS a key (selected by the JWS `kid`) and keeps this one. |
| Alias `alias/smart-club-<stage>-cert-signing`      | af-south-1            | Convenience only; the Lambda uses the ARN.                                                                                                                                                                                  |
| Lambda env                                         | —                     | `CERT_SIGNING_KEY_ARN`, `VERIFY_BASE_URL`; fonts arrive via `copyFiles` (first use of copyFiles in this stack).                                                                                                             |

## Pre-deploy checks

1. **KMS ECC availability (one-time).** Asymmetric KMS is expected in af-south-1; the deploy
   itself is the test — `aws.kms.Key` fails fast if the key spec is unsupported. Fallback
   (documented in the plan): create the key in eu-west-1 and pass its ARN; cross-region
   `kms:Sign` adds ~180 ms per issuance.
2. **Prod verify host must serve the SPA before the first certificate is printed.**
   Prod `VERIFY_BASE_URL` is `https://platform.club.medicoach.co.za` (the reserved `platform`
   label on the wildcard suffix). Confirm the wildcard CloudFront alias + DNS cover it, then
   run this check — it **must print `200`** (the SPA shell) before the first prod certificate
   is printed:

   ```sh
   curl -sS -o /dev/null -w '%{http_code}' https://platform.club.medicoach.co.za/verify/healthcheck
   ```

   Anything else (000 / SSL error, 403, 404) means the host isn't serving the SPA yet — stop.
   In a browser the same URL shows the NOT FOUND banner (no certificate has that serial),
   which is expected. **The QR on every printed certificate embeds this host forever — it
   must never churn.**

3. No new secrets. Nothing to `sst secret set` for this feature.

## Deploy

```sh
npx sst deploy --stage dev        # then smoke-test on dev
npx sst deploy --stage production
```

Post-deploy smoke test (per stage):

1. Approve (or union-override) a test clearance → the resolved card shows **View certificate**;
   the modal renders the PDF inline.
2. Scan the QR (or open the printed verify URL) → branded VALID page with match checklist and
   the **masked** ID number.
3. On the VALID page, **check a PDF file**: pick the downloaded certificate PDF → it reports
   a match. `GET /verify/<serial>` now returns the stored PDF's `sha256` (VALID responses
   only), and the page compares it against the SHA-256 of the file the viewer holds; any
   edited or re-saved PDF reports a mismatch.
4. `curl -sS <api>/verify-keys` → one entry `{ kid, publicKeyPem, fingerprint }` (see
   **Key pinning** below).
5. Admin → **Revoke certificate** with a reason → verify page flips to REVOKED (status + dates
   only, no player details, no `sha256`).

## Key pinning / independent verification

`GET /verify-keys` (public, no auth) is the certificate signing-key directory: a JSON array of
`{ kid, publicKeyPem, fingerprint }` for the active key(s). `fingerprint` is the SHA-256 of
the key's DER SubjectPublicKeyInfo as colon-separated hex (`AB:12:…`) — the standard public-key
fingerprint format. It returns `[]` (and reports to Sentry) if KMS is unreachable; retry.

**After the first deploy of each stage, once:**

1. `curl -sS https://<api-host>/verify-keys` and record the `kid` + `fingerprint` in the
   union's own records (the tenant's governance docs / minutes, not only in this repo).
   That recorded fingerprint is the **out-of-band trust anchor**.
2. Recompute it yourself to confirm the response is internally consistent:

   ```sh
   curl -sS https://<api-host>/verify-keys | jq -r '.[0].publicKeyPem' > cert-key.pem
   openssl pkey -pubin -in cert-key.pem -outform DER | openssl dgst -sha256 -c
   ```

A verifier who has pinned the fingerprint no longer needs to trust any later response from
the platform: they check that a key's fingerprint matches the pinned value, then verify a
certificate's `signedPayload` (compact JWS, ES256, header `kid`) against that key **offline**.
If the fingerprint served ever changes without a documented rotation (a rotation ADDS a new
`kid`; the pinned one keeps verifying old certificates), treat it as an incident.

Local dev (`LOCAL_AUTH=1`) signs with a persisted P-256 key at
`<dirname(LOCAL_UPLOADS_DIR)>/cert-signing-dev.pem` (default `$TMPDIR/cert-signing-dev.pem`),
so local certificates keep verifying across API restarts. Delete the file to rotate it;
it is never used outside `LOCAL_AUTH=1`.

## Per-tenant setup (operator portal)

Tenant edit page → **Clearance certificate** card:

- Template: **Classic certificate** (landscape, default) or **Confirmation certificate**
  (portrait, tabular).
- Org contact (feeds the confirmation footer): Reg no · Address · Telephone · Website · Email.
  Blank fields are simply omitted from the rendered footer.

## Backfill (existing approved clearances)

Certificates otherwise appear lazily the first time someone opens **View certificate** on an
old approved clearance. To pre-issue in bulk:

```sh
cd packages/api
# dry-run first — prints what would be issued and what is skipped and why
CERT_SIGNING_KEY_ARN=<arn> VERIFY_BASE_URL=<url> \
  npm run backfill-clearance-certificates -- --tenant dolphins
# then apply
CERT_SIGNING_KEY_ARN=<arn> VERIFY_BASE_URL=<url> \
  npm run backfill-clearance-certificates -- --tenant dolphins --apply
```

Skipped by default (each listed in the dry-run output):

- the ~55 **imported/backfilled** clearances (no real digital approval on file) —
  `--include-imported` issues them with "Recorded from historical records · no digital
  approval on file" wording;
- **declined overrides** (`certificateDeclined`), clearances with **no approval timestamp**,
  and clearances whose **player is no longer at the destination club** (almost certainly a
  disposal — a certificate must not claim a transfer that didn't happen).

Pre-feature organic approvals have no recorded approver; their certificates read
"Approving official not recorded · <date>". That is deliberate (ECTA evidence honesty).

## Operational notes

- **Union override dialog** has an "Issue transfer certificate" checkbox (default ON).
  Untick it when the override is disposing of a junk clearance ("override, then delete the
  player") — a declined override can never be issued later, not even lazily.
- **Revocation** is admin-only (`Revoke certificate`, reason required) and permanent; the
  verify page then shows REVOKED with no player details.
- **POPIA:** certificate PDFs live under `${tenant}/${fromClubId}/clearances/<id>/` in the
  uploads bucket and are purged (with the `CERT#` registry item) by player delete, club
  erase and tenant erase. The public verify page never shows the full ID number or DOB.
  The `sha256` it returns is a hash of the PDF, not of any personal field.
- Approval requests now take ~1–3 s longer (certificate renders inline). If issuance fails,
  the approval still lands (`certificatePending: true`) and the certificate is created on
  first view.

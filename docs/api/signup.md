# API — Club self-registration (public)

Clubs join the platform by registering **themselves**: an admin generates one tenant-wide
signup link and shares it; a club rep opens it, enters their own contact details and the
club's name + district, and the platform creates **both the club and the rep's account**
(Cognito user + a `rep` membership scoped to the new club). The rep then signs in with the
normal email OTP — PreTokenGen picks up the new membership with no further admin action.
There is no approval gate: the club is immediately visible in the admin console.

Like the player-registration link, the signup token is global and **self-describes its
tenant**, distinguished by `kind: "club-signup"` on the `TOKEN#` item (and no `clubId`).
One token is active per tenant at a time; its pointer lives in
`TenantConfig.clubSignupLink` so admins can retrieve and revoke it.

## Admin link management (admin-only)

### `GET /admin/club-signup-link`

```
200 → { clubSignupLink: { token, createdAt } | null }
```

The SPA builds the shareable URL client-side: `https://<tenant-host>/signup?t=<token>`.

### `POST /admin/club-signup-link` — generate / rotate

Mints a fresh `crypto.randomUUID()` token and revokes the previous one (the old link stops
working immediately). `200 → { clubSignupLink }`.

### `DELETE /admin/club-signup-link` — revoke

Deletes the token and clears the config pointer. `200 → { ok: true }`.

> The pointer is written with a targeted update (never the whole-config merge), and
> `PUT /tenant/config` strips `clubSignupLink` from patches — a concurrent Settings save
> can't resurrect a revoked link. The pointer is also the source of validity: the public
> routes require the token to match the tenant's current `clubSignupLink`, so a TOKEN#
> item orphaned by a partial rotation/revoke failure is inert.

## `GET /club-signup?t=<token>` — validate the link (public)

```
200 → { tenant, orgName, districts: string[] }
400 → missing token
404 → invalid/revoked token, wrong token kind, pointer mismatch, or erased tenant
```

## `POST /club-signup?t=<token>` — register a club (public)

Body:

```jsonc
{
  "clubName": "Kingsmead CC", // required, ≤ 80 chars, must slug to a non-empty id
  "district": "…", // required, one of the catalogue districts
  "repName": "…", // required, ≤ 80 chars — becomes the club's chair contact
  "repEmail": "…", // required — becomes the rep's login identity (normalized lowercase)
  "repCell": "…", // optional, ≤ 20 chars
  "consent": true, // required POPIA consent (see popia-compliance.md)
}
```

Behaviour:

- **Club:** built like the old admin onboard (slug id, neutral affiliation state), with the
  rep landing on `exco.chair`, plus provenance: `onboardedVia: "self-signup"`,
  `signupConsentAt`, `changedBy: <repEmail>`.
- **Account:** idempotent Cognito provisioning + membership write. A brand-new email gets a
  `rep` membership (`invitedBy: "self-signup"`); an existing rep in the tenant has the new
  club **appended** to their `clubIds` (never duplicated); an existing **admin** keeps their
  membership untouched (admins already see every club).
- **Replay:** re-submitting the same club name with the same email returns
  `200 { clubId, replayed: true }` instead of an error (covers double-clicks and retries) —
  the page routes the rep to sign-in.
- **Name collision:** the same name (or a name that slugs to the same id) submitted by a
  _different_ email is `409` with `code: "name_taken"` — the rep must choose another name;
  they are **not** sent to sign-in.
- **Abuse:** the unguessable, admin-revocable token is the gate, backed by a per-token
  hourly rate cap. No TTL — rotation is an admin action.

```
201 → { clubId, clubName, email }
200 → { clubId, replayed: true }
400 → missing/invalid fields, bad district, empty-slug name, consent not given
404 → invalid/revoked token or erased tenant
409 → { error, code: "name_taken" }
429 → too many signups this hour — retry later
```

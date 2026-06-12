# API — Player registration (public)

Open to the world (alongside the club-signup routes — see [signup.md](signup.md)). A union
admin/rep issues a link
(`POST /clubs/:id/reg-link`) and shares it; members register without an account. The
registration token is global and **self-describes its tenant**, so these routes never
trust the request host for authorization. See
[ADR 0002](../architecture/0002-single-tenant-saas-vs-isolated-stacks.md).

Registrations drive the derived `club.players` count.

## `GET /register/:clubId?t=<token>` — validate a link

Resolves the token → `{ tenant, clubId }` and checks it matches `:clubId`.

```
200 → { tenant, clubId, clubName }
400 → missing token
404 → invalid registration link / club not found
```

## `POST /register/:clubId?t=<token>` — submit a registration

Body:

```jsonc
{
  "firstName": "…", // required
  "lastName": "…", // required
  "dob": "YYYY-MM-DD", // required — determines minor status
  "cell": "…", // optional
  "email": "…", // optional
  "guardianName": "…", // REQUIRED if the player is a minor (POPIA)
}
```

Behaviour:

- **Minor detection:** computed from `dob` (under 18). Junior leagues (U11/U13/U15) make
  this load-bearing — a minor without `guardianName` is rejected `400`.
- **Dedup:** a `naturalKey` (email → cell → name+dob) keys the registration per club. A
  repeat submission returns `409 "already registered"`.
- **Consent:** `consentAt` is stamped server-side. See
  [popia-compliance.md](../guides/popia-compliance.md).
- **Abuse:** the route is rate-limited at API Gateway; tokens are unguessable
  (`crypto.randomUUID`).

```
201 → { ok: true }
400 → missing fields / minor without guardian / missing token
404 → invalid registration link
409 → already registered
```

# API — Users & invitations

User identity is in Cognito; authorization (tenant + role + clubs) is in the `USER#`
record and travels in the token's `memberships` claim via the PreTokenGeneration Lambda.
See [ADR 0003](../architecture/0003-cognito-passwordless-memberships.md).

> Club reps normally provision **themselves** via the public signup link
> ([signup.md](signup.md)) — registering a club creates their account and membership in one
> step. This route remains for inviting additional admins and extra reps to an existing club.

## `POST /admin/users` — invite a user (admin)

Creates a Cognito account (suppressed invite — the user signs in via email OTP) and writes
/updates their `USER#` record with a membership for the **caller's** tenant.

Body:

```jsonc
{
  "email": "rep@club.co.za", // required
  "role": "rep", // "rep" | "admin"
  "clubIds": ["ukzn"], // clubs a rep is scoped to (ignored for admins)
}
```

Behaviour:

- If the email already exists (e.g. a rep at another union), a new membership for this
  tenant is **added** to their existing `memberships[]` — one person can belong to several
  unions and clubs. Handover/role change is just another call (replaces this tenant's
  membership).
- The first admin of a brand-new tenant is created out-of-band by the platform bootstrap
  script, not this route (chicken-and-egg). See
  [onboarding-a-tenant.md](../guides/onboarding-a-tenant.md).

```
201 → { sub, email }
400 → email required
403 → not an admin of this tenant
```

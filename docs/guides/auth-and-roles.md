# Auth & roles

How identity, tenancy, and permissions fit together. Decisions:
[ADR 0003](../architecture/0003-cognito-passwordless-memberships.md).

## Sign-in (passwordless email OTP)

Users sign in with their email and a one-time code — no passwords. Cognito's `USER_AUTH`
flow with `EMAIL_OTP` (Essentials feature plan). Accounts are created three ways: a club
rep **self-registers** through the tenant's signup link (registering a club provisions the
account + membership in one step — see [signup.md](../api/signup.md)), an admin invite
(`POST /admin/users`) for additional admins/reps, or the platform bootstrap script for a
new tenant's first admin. Cognito's own open self-signup stays disabled — every account is
created server-side through one of those three gates.

If passwordless isn't available in af-south-1, the fallback is a `CUSTOM_AUTH` OTP via
Lambda triggers (same token shape, app unaffected) — see
[deploy-and-spike.md](deploy-and-spike.md) step 6.

## Identity vs authorization

- **Identity** lives in Cognito (the user's `sub` and email).
- **Authorization** lives in the `USER#<sub>` record as
  `memberships: [{ tenantId, role, clubIds }]`. A **PreTokenGeneration Lambda** reads that
  record on every token mint and stamps `memberships` onto the ID token.

Because authorization is a DB record (not a fixed Cognito attribute):

- **Handover / role change** = edit the `USER#` record; effective on next token refresh.
- **Multi-union users** = multiple entries in `memberships[]` (one email, many unions).

## Roles

| Role    | Scope                                                                                 |
| ------- | ------------------------------------------------------------------------------------- |
| `admin` | Everything in their tenant: all clubs, series, the club signup link, invites, config. |
| `rep`   | Only the clubs in their `clubIds`: read/patch that club, exco, docs, reg-link.        |

## Tenant resolution & isolation

Every request's tenant is derived from the **host** (prod custom domains, e.g.
`dolphins.example.com` → `dolphins`) or an `x-tenant` header (dev). Middleware selects the
caller's membership for that tenant; **no membership → 403**. The raw `execute-api` host
and `localhost` are ignored so the host can't be spoofed into a real tenant — dev callers
pass `x-tenant` explicitly.

All data keys are prefixed `TENANT#<t>#`, so a query scoped to one tenant can never read
another's rows. This is the isolation boundary;
[ADR 0002](../architecture/0002-single-tenant-saas-vs-isolated-stacks.md) explains why
logical isolation (one table, one region) is sufficient here.

## Affiliation lock

The affiliation form is read-only once `affiliation === "complete"`. The server rejects
rep edits to affiliation fields on a completed club with `403`.

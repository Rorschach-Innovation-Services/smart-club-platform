# ADR 0003 — Cognito passwordless OTP with a `memberships[]` claim

**Status:** Accepted — verified on the dev stage (af-south-1).

> **Spike resolution.** Native passwordless email OTP works in af-south-1, with two caveats
> discovered at deploy time: (1) enabling `EMAIL_OTP` as a first auth factor
> (`Policies.SignInPolicy.AllowedFirstAuthFactors`) can't be done through SST — that field
> only exists in pulumi-aws 7.x and SST 3.x bundles 6.x — so it's set by a post-deploy
> script (`enable-passwordless`); (2) accounts must be CONFIRMED for OTP to be offered, so
> the invite/bootstrap flow sets a random unused password to confirm them. The
> CUSTOM_AUTH-trigger fallback was therefore not needed.

## Context

Club reps and union admins need to sign in. The users are non-technical (chairpersons,
officials); password management and reset flows are friction and a support burden. We also need
authorization that distinguishes admins from reps and scopes each user to the right club(s),
across a multi-tenant platform where one person could plausibly be involved with more than one
union (cross-district clubs already exist in the domain).

## Decision

Use **Amazon Cognito with passwordless email OTP** (the `USER_AUTH` flow). Identity and
authorization are carried in a **`memberships` claim**: `[{ tenantId, role, clubIds[] }]`,
stamped onto the token by a **PreTokenGeneration Lambda** that reads the user's `USER#<sub>`
record. Cognito's open self-signup is disabled — accounts are created server-side: by the
public club-signup flow (a rep registering their club provisions their account + membership;
the admin-issued signup token is the gate), by an admin invite, or by the platform bootstrap
script for each new tenant's first admin.

## Why

- **Passwordless removes the biggest support cost** (forgotten passwords) for non-technical
  users and needs no password-rules/reset UI.
- **PreTokenGeneration reading a DB record (not a fixed Cognito attribute)** means role and
  club assignment can change without rewriting an immutable attribute — so **rep handover and
  revocation are just a record edit**.
- **`memberships[]` (an array, not a single `clubId`/`tenantId`)** lets one email belong to
  multiple unions and clubs. A single-valued claim would collide with Cognito's per-pool email
  uniqueness and block cross-union users and handovers.
- The request middleware picks the membership matching the authenticated host's tenant and
  rejects if none — this is the enforcement point for tenant isolation
  ([ADR 0002](0002-single-tenant-saas-vs-isolated-stacks.md)).

## Consequences

- **Passwordless `USER_AUTH`/`EMAIL_OTP` requires Cognito's paid Essentials feature plan**, and
  its availability in `af-south-1` must be confirmed. The step-0 spike validates this and the
  full invite → PreTokenGen-claims → OTP path end-to-end.
- **Fallback:** if Essentials/passwordless is unavailable in `af-south-1`, implement OTP via
  `CUSTOM_AUTH` Lambda triggers (Define/Create/Verify), which work in any region. The token
  shape and `memberships` claim are unchanged, so app code is unaffected.
- **Claim size:** `memberships[]` must stay within JWT/Cognito claim limits — bounded in
  practice (a user belongs to few clubs); verified in the spike.
- **Stale claims:** a `USER#` edit only takes effect on the next token refresh — acceptable for
  this domain.

## Alternatives considered

- **Email + password:** familiar but adds reset/lockout flows and support load; rejected.
- **Admin-issued access codes** (reuse the prototype's share tokens for login): simplest, but
  codes get forwarded, there's no real per-user identity, and it's weak for a compliance
  system. Kept only for the public player-registration link, not for rep/admin login.
- **Single `custom:clubId`/`custom:tenantId` attribute:** simpler claim, but breaks on
  handover and multi-union users; rejected in favour of `memberships[]`.

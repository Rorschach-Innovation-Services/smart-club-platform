# Runbook — Seed a test cohort you can log into

**Owner:** anyone with AWS access to the target stage (dev).
**App code change:** none — `seed-cohort` is a CLI, not a route.
**Why:** `seed --demo` predates ADR 0008 and carries no calendars, structures or season
runs, and there is no admin "create club" endpoint. So there was no way to stand up clubs
with real competition data and actually sign in as them.

---

## What it creates

One command (`packages/api/src/seed-cohort.ts`) writes a complete ADR 0008 cohort:

|             |                                                                                         |
| ----------- | --------------------------------------------------------------------------------------- |
| Calendar    | Two blocks either side of a festive break                                               |
| Structures  | Flat round robin, split league with swap, pools → knockout (from `STRUCTURE_TEMPLATES`) |
| Leagues     | 3 by default, each with three competitions binding a structure + the calendar           |
| Clubs       | Up to 24 real KZN clubs with grounds and coordinates; two field a second side           |
| Venues      | One per club, from its ground                                                           |
| Season runs | One per league — the flat round robin, materialised                                     |
| Series      | One per stage-group — **approved and released**, so a rep can see them                  |

**Clubs overlap between leagues on purpose.** Every club enters the first league (so it
always has a full field); the rest fan out across the others by index. A club playing
Premier Men _and_ the Reserve league is the normal case in club cricket, and it is what
makes per-league team rosters and `Series.participants` worth testing at all.

**Idempotent.** Every id derives from `(tenant, league, season)`, so re-running converges
rather than duplicating — and the series id is byte-identical to what the admin UI's
generate button produces, so the two paths overwrite each other rather than stacking.

**Club registrations reconcile per league, not globally.** A run is authoritative for the
leagues named in `--leagues` and leaves every other league alone. So re-seeding the same
leagues with a smaller `--per-league` genuinely _shrinks_ them, while seeding a different
set later adds to what is already there. A blanket union would have been worse than a
blanket overwrite: the store would keep the old, larger membership while the fixtures and
the CLI's own summary reported the new, smaller one.

---

## 1. Offline dry run (do this first)

Costs nothing, touches no AWS, and catches shape errors before they reach a real table.

```bash
npm run dev:local        # dynalite on :4567, API on :3333, SPA on :3201

TABLE_NAME=SmartClubLocal DYNAMO_ENDPOINT=http://localhost:4567 LOCAL_AUTH=1 \
AWS_REGION=localhost AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
  npx tsx packages/api/src/seed-cohort.ts dolphins \
    --admin admin@example.com --rep rep@example.com
```

Expected output at the defaults — 16 clubs across 3 leagues, with two clubs fielding a
second side (so Premier Men runs 18 sides → 153 fixtures):

```
· config: calendar "2026/27 season", 3 structures, 3 leagues (Premier Men, Reserve Men, Premier Women)
· 16 clubs
· 16 venues
· Premier Men: 16 clubs · run run-seed-premier-men-2026-27 · 1 series, 153 fixtures — approved + released
· Reserve Men: 8 clubs · run run-seed-reserve-men-2026-27 · 1 series, 45 fixtures — approved + released
· Premier Women: 8 clubs · run run-seed-premier-women-2026-27 · 1 series, 28 fixtures — approved + released
· 3 series, 226 fixtures across 3 leagues
```

Offline the Cognito calls are stubbed (`LOCAL_AUTH=1`), so the grants print a
deterministic `local-…` sub instead of a real one. Sign in through the SPA's role picker.

> The local API does **not** hot-reload. Restart it after editing anything under
> `packages/api/src/`, or your change silently will not run.

---

## 2. Deploy and seed the dev stage

```bash
npm run deploy:dev
npx sst shell --stage dev -- npm --prefix packages/api run enable-passwordless
npx sst shell --stage dev -- npm --prefix packages/api run seed -- dolphins   # tenant config must exist first
```

**Read the `enable-passwordless` output before going further** — it reports whether OTP
mail will actually arrive. See [Deliverability](#deliverability) below.

Then bootstrap the operator and seed the cohort. One address can hold operator _and_
tenant admin (different `tenantId`s), so this is two addresses total, not three:

```bash
npx sst shell --stage dev -- npm --prefix packages/api run bootstrap-operator -- you+dev@example.com

npx sst shell --stage dev -- npm --prefix packages/api run seed-cohort -- \
  dolphins --clubs 12 --season 2026/27 \
  --admin you+dev@example.com --rep you+rep@example.com
```

Run it a second time and confirm the counts do not move.

### Flags

| Flag              | Default                                                | Notes                                                        |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| `--clubs N`       | 16                                                     | 2–24 — the size of the club roster                           |
| `--leagues a,b,c` | `seed-premier-men,seed-reserve-men,seed-premier-women` | Comma-separated, max 6. `--league` (singular) still accepted |
| `--per-league N`  | _(unset)_                                              | Give **every** league exactly N clubs (see below)            |
| `--season LABEL`  | `2026/27`                                              | Also drives calendar dates and every derived id              |
| `--admin EMAIL`   | —                                                      | `grantTenantAdmin`                                           |
| `--rep EMAIL`     | —                                                      | `grantClubRep`, scoped to every seeded club                  |

**`--per-league` vs the default.** Without it, every club joins the first league and the
rest fan out — so with 16 clubs and 3 leagues you get 16/8/8. With `--per-league 12` each
league takes a rotating window of exactly 12 clubs from the roster, so you get 12/12/12
with partial overlap (8 shared, 4 unique between any pair). Windows must overlap: three
leagues of 12 cannot be disjoint within a 16-club roster, and overlapping entries are the
realistic case anyway.

```bash
# 12 clubs in each of three leagues
… run seed-cohort -- dolphins --clubs 16 --per-league 12
```

Known league keys (`seed-premier-men`, `seed-reserve-men`, `seed-premier-women`,
`seed-t20-cup`, `seed-under-19`) get proper labels and groups; any other key works and gets
a derived label.

`--admin` and `--rep` **must differ**. Memberships are one-per-tenant, so the same address
for both would leave only the second grant — the CLI refuses rather than reporting a
success that leaves one view unreachable.

**Watch for the fit warning.** A league whose rounds outrun its calendar block does not
fail — it quietly generates _fewer_ rounds, producing a round robin where some sides never
meet. That is broken data wearing the costume of real data, so the CLI prints:

```
⚠ Big League · Group A: only 21 of 25 rounds fit … — 4 round(s) DROPPED, so some sides
  never play each other. Use fewer --clubs, a wider block, or a denser cadence.
```

The defaults (16 clubs, 3 leagues) fit comfortably. It bites around 22+ clubs in one league.

---

## 3. Sign in

Point the local SPA at the deployed dev backend — `.env.development.local` already
documents this as "Option B": comment out the three local lines and uncomment the dev
pool values, then `npm run dev`.

Dev has no custom domains, so the tenant comes from `?tenant=<slug>` or
`VITE_DEFAULT_TENANT` and rides as the `x-tenant` header (`src/config.ts:29`,
`packages/api/src/auth.ts:125`).

**As `you+dev@example.com`** — one OTP, and the token carries both roles:

- the admin console for the tenant, and
- `/platform` for the operator portal, with no second sign-in.

Check Fixtures: the season run's stage reads `generated` with an approved, released
series behind it.

**As `you+rep@example.com`** — lands on the first seeded club and shows its fixtures.

---

## 4. Switching between clubs

The rep's membership lists **every** seeded club, so one sign-in reaches all of them at
`/club/<id>`. `assertClubAccess` (`packages/api/src/auth.ts:242`) permits any club in
`clubIds`, and a club outside the list gives a clean "You don't have access to that club"
splash (`src/main.tsx:2304`).

> ⚠️ **There is no club switcher in the UI.** A rep always lands on `clubIds[0]`
> (`src/main.tsx:1032`); other clubs are reachable only by editing the URL, or by keeping
> one tab open per club (they share the token). This is a known gap, not a seeding
> failure.

> ⚠️ **An admin cannot preview the rep experience.** `clubRouteRedirect` bounces admins
> off every `/club/...` URL to the admin dashboard. Checking what a club actually sees
> requires the rep login — there is no admin shortcut.

---

## 5. Granting access to someone else

Nothing is tied to a particular inbox. Only the first operator bootstrap needs a shell;
everything after it is UI.

| Role     | Path                                                                                                                | AWS creds?                      |
| -------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Operator | `bootstrap-operator <email>`                                                                                        | **yes** — no UI mints operators |
| Admin    | Operator portal → tenant → add admin (`POST /platform/tenants/:slug/admins`), or `bootstrap-admin <tenant> <email>` | no, via the portal              |
| Rep      | Admin console invite → `POST /admin/users` with `role: 'rep'` and `clubIds`                                         | no                              |

Handing over an already-seeded cohort needs no re-seed — just grant against their address.

> Dev has its **own Cognito pool**. Operators bootstrapped on prod do not carry over.

### New tenants auto-grant admin to every operator

`POST /platform/tenants` now also gives **tenant-admin to every platform operator**, on
**all stages including prod**. So a tenant created through the portal is immediately
administrable by the whole operator group — no `bootstrap-admin` needed.

The grants are ordinary explicit memberships: visible on each `USER#` record, listed in the
tenant's Team & Access page, and individually revocable. The response carries
`operatorAdmins: { granted, failed }`. It is best-effort — the tenant is already created by
the time it runs, so a failure is logged and reported rather than turning a successful
creation into a 500.

> ⚠️ **POPIA note.** This deliberately widens the tenant boundary: from creation, every
> operator can read that tenant's clubs, chair contact details and player registrations.
> Previously an operator had no route to any of it. Requested deliberately — but it is the
> reason to keep the operator group small and to revoke rather than accumulate.

> 🚨 **Deploying this to prod requires the backfill FIRST, or it silently does nothing.**
> Operators are enumerated via a `PLATFORM#OPERATORS` marker that `repo.putUser` maintains.
> Anyone made an operator _before_ this shipped has no marker, so `listOperators()` returns
> them — and the auto-grant quietly skips them. Nothing errors; new tenants are just
> invisible to half the team.
>
> ```bash
> npx sst shell --stage prod -- npx tsx packages/api/src/backfill-operator-markers.ts            # dry run
> npx sst shell --stage prod -- npx tsx packages/api/src/backfill-operator-markers.ts --confirm
> ```
>
> Already run on **dev** (3 operators indexed, 29 Jul 2026). Prod has 5 operators and has
> **not** been done.

> ⚠️ **An operator membership alone gives NO access to clubs, leagues or fixtures.**
> `requireTenantMembership` matches `tenantId === tenant`, and an operator's is the sentinel
> `'*'`, so an operator-only account gets **403** on `/clubs`, `/series` and `/season-runs`
> — they reach `/platform/*` and nothing else. Anyone testing leagues needs a **tenant
> admin** membership as well. Both live happily on one address (different `tenantId`s):
>
> ```bash
> npx sst shell --stage dev -- npm --prefix packages/api run bootstrap-operator -- them@example.com
> npx sst shell --stage dev -- npm --prefix packages/api run bootstrap-admin -- dolphins them@example.com
> ```
>
> That covers the admin console and the operator portal in one sign-in. Seeing the _club_
> side still needs a separate rep address — admin and rep cannot coexist in one tenant.

---

## Deliverability

A teammate can only sign in if the OTP reaches them.

**Observed on dev, 2026-07-29 — the good state, no per-recipient setup needed:**

| Check              | Value                                                         |
| ------------------ | ------------------------------------------------------------- |
| Pool sender        | SES `DEVELOPER`, `Smart Club Platform <info@medicoach.co.za>` |
| First auth factors | `PASSWORD`, `EMAIL_OTP`                                       |
| SES af-south-1     | production access ✅, sending enabled, 50 000/day             |

So OTP reaches **any** address — grant a teammate and they can sign in immediately.
Verified end to end: `initiate-auth` for a seeded admin returns an `EMAIL_OTP` challenge
and dispatches a real code.

Re-check with `enable-passwordless` (it prints what is missing) or directly:

```bash
aws sesv2 get-account --region af-south-1 --profile medicoach \
  --query '{Production:ProductionAccessEnabled,Enabled:SendingEnabled}'
```

**The two states that would break a teammate**, if this ever regresses:

- **`COGNITO_DEFAULT`** — reaches any inbox, but capped at 50/day and sent from
  `no-reply@verificationemail.com`, which Gmail spam-bins. Tell them to check junk.
- **SES `DEVELOPER` while af-south-1 is sandboxed** — unverified recipients are **rejected
  outright**. They receive nothing, and the app gives no clue why. `enable-passwordless.ts`
  deliberately refuses to switch to DEVELOPER while sandboxed for exactly this reason.

> Note the pool config is reset by any deploy that updates the user pool — re-run
> `enable-passwordless` after one, or OTP sign-in breaks.

Codes arrive but land in spam? That is DKIM/DMARC, not this — see
[otp-email-deliverability.md](otp-email-deliverability.md).

---

## Teardown

```bash
npx sst shell --stage dev -- npm --prefix packages/api run clear-cohort -- dolphins --confirm
```

Removes clubs, players, series and season runs. **Keeps** the tenant config (so the
calendar, structures and league survive) and **keeps** venues. Both are intentional and
harmless — a re-seed converges on them, because the venue ids are derived from club ids.

---

## What it deliberately does not do

- **No results or standings.** They do not exist in the model — ADR 0008 makes standings
  admin-confirmed, and `DerivationNote` is recorded but never executed.
- **Only the flat round robin is run as a season.** It resolves from `all-registered`
  alone, so it generates unattended. The split-league and pools-to-knockout structures are
  installed but their later stages are `manual`/`derivedFrom` and correctly sit at
  `awaiting-entrants` until an admin confirms standings — drive those by hand from the
  season card. That is the feature working, not the seed falling short.
- **It does not create tenants.** Seed into one that exists; new tenants come from the
  operator portal wizard (`POST /platform/tenants`).

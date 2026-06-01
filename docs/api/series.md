# API — Series & fixtures

A series carries match config plus an **embedded** `fixtures[]` array. Fixtures are
generated client-side (`generateRoundRobin`) and POSTed whole. Writes use optimistic
concurrency (`version`; `409` on conflict). All series writes are admin-only; reps read.

## `GET /series` — list (rep + admin)

`200 → Series[]` for the tenant. (The club fixtures view filters this to released series
that include the club.)

## `POST /series` — create (admin)

Body: a full series object including client-generated `fixtures[]`. The server sets
`version: 1` and defaults `released: false`, `releasedAt: null`.

```
201 → Series
```

## `PATCH /series/:id` — update / release / recall (admin)

Partial update — covers fixture edits, regeneration (send the whole new `fixtures[]`), and
release/recall. When `released` is set, the server stamps `releasedAt` (release → now,
recall → null) for trustworthy timestamps.

Send the current `version`; mismatch → `409 "series changed; refetch"`. This is the path
most exposed to concurrent edits (two admins, or one in two tabs), so always refetch on 409.

```
200 → Series   404   409 version conflict
```

## `DELETE /series/:id` — delete (admin)

`200 → { ok: true }`.

## `POST /series/:id/duplicate` — duplicate (admin)

Clones the series with a fresh id, `name + " · Copy"`, `released: false`, `version: 1`.

```
201 → Series
```

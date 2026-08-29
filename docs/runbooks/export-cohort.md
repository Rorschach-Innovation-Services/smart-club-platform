# Runbook — Export a tenant's club cohort to .xlsx

**Owner:** anyone with AWS access to the target stage.
**App code change:** none — `export-cohort` is a read-only CLI, not a route.
**Why:** get a tenant's full club cohort (affiliation form data, chair/exco details,
coaches, CQI submissions) into a formatted spreadsheet for offline analysis, without
touching DynamoDB.

---

## Run it

```
npx sst shell --stage prod -- npm --prefix packages/api run export-cohort -- dolphins
```

`sst shell` injects the stage's `Data` resource so the repo layer resolves the right
table. Swap `--stage prod` for `--stage dev` and `dolphins` for any tenant slug.

Output defaults to `cohort-export-<tenant>-<YYYY-MM-DD>.xlsx` in the current directory.
Override the path with `--out`:

```
npx sst shell --stage prod -- npm --prefix packages/api run export-cohort -- dolphins --out /tmp/dolphins.xlsx
```

The command prints the club count, the row count per sheet, and the output path.

## What it reads

Read-only: one `listClubs` gsi1 query (full-projection club items) plus one tenant-config
get (for resolving league keys to display labels). No writes.

## Sheets

| Sheet               | One row per   | Notes                                                             |
| ------------------- | ------------- | ----------------------------------------------------------------- |
| Clubs & Affiliation | club          | status, chair, players, team counts, leagues, ground, onboarding  |
| Chair & Exco        | office bearer | chair/sec/tre/vc + additional members; ID/term columns chair-only |
| Coaches             | coach         | body, level, status, contact, experience, resolved team labels    |
| Teams & Rosters     | roster team   | from `teamRosters`, league resolved to its label                  |
| CQI Scores          | club          | stored vs recomputed total, band, per-category earned/possible    |
| CQI Answers (raw)   | club          | one column per question, values via `effectiveAnswers`            |

CQI scoring reuses the frontend's single source of truth (`src/data.ts` catalogue +
`src/cqiScore.ts` `scoreCQI`/`cqiBand`) — the same functions the SPA scores with. A club
with no CQI submission shows blank score/answer cells (not 0), matching the "Pending"
band in the UI.

## Notes

- The CLI lives at `packages/api/src/export-cohort.ts`. Like `seed-cohort.ts`, it imports
  from the frontend tree and is type-checked under `tsconfig.seed.json`, not the strict
  api project.
- `scoreCQI`/`cqiBand` were extracted from `src/atoms.tsx` (React) into `src/cqiScore.ts`
  so a Node CLI can import them; `atoms.tsx` re-exports both, so every SPA call site is
  unchanged.

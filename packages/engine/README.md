# @smart-club/engine

The fixture and competition-structure engine: season calendars, entrants, formats and
knockout labels, fixture generation, structure templates, the season narrative, venue
allocation, league participants, season-run helpers, and the competition/season domain
types (`src/types.ts`) that the web app and the API both re-export.

It must stay pure: no React, no DOM, no AWS SDK, no I/O. `dayjs` is the only runtime
dependency, resolved from the repo root.

There is no build step and no workspace link. The web app (`src/`) and the API
(`packages/api/`) import it by relative path, e.g. `../packages/engine/src/calendar`.

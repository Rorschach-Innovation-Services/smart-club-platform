# Hollywoodbets Dolphins · Smart Club Platform

A clickable front-end prototype of the **Smart Club Integration Platform** for
the Hollywoodbets Dolphins, covering club affiliation, compliance documents,
the Club Quality Index (CQI), fixture automation, and travel-cost modelling
across **KZNCU & EMCU** for the 2026/27 season.

> ⚠️ **Prototype only.** No backend, no database, no payments — all state is
> in-memory React state and resets on page refresh. See *What's missing* below.

---

## Quick start

```bash
npm install
npm run dev
# then open http://localhost:3201
```

The dev server already binds to `0.0.0.0`, so to preview on your phone over
Wi-Fi find your LAN IP (`ipconfig getifaddr en0`) and open
`http://<your-ip>:3201`.

## Build & deploy

```bash
npm run build        # produces dist/
npm run preview      # serve the build locally on :3201
npm run deploy       # deploy to AWS (S3 + CloudFront) via SST, stage=prod
```

First-time deploy: ~5 min (SST bootstraps a Pulumi state bucket in your AWS
account — `home: "aws"` means local state, no SST cloud login). Subsequent
deploys: ~30s for code-only diffs, ~2 min if CloudFront config changes.

Region: `af-south-1`. AWS profile: `medicoach`. The deploy URL is printed at the
end of `sst deploy` as `Web: <id>.cloudfront.net`. Deep links (e.g.
`/admin/dashboard`) return HTTP 200 via a CloudFront `customErrorResponses`
rule wired up in `sst.config.ts`.

To tear down a non-prod stage: `npm run deploy:remove`. Prod has `protect: true`
on its resources, which blocks destructive Pulumi diffs but does **not** make
`sst remove --stage prod` safe — that command will still attempt teardown and
fail partway, leaving the stack in a broken state. Don't run remove against prod
without manually unsetting `protect` in `sst.config.ts` first.

## Quality

```bash
npm run lint           # ESLint
npm run format         # Prettier write
npm run format:check   # Prettier check (CI-friendly, no writes)
```

---

## What's in the box

### Two profiles

- **Dolphins Admin** — cohort dashboard, all-clubs list with insights, affiliation
  / docs / CQI trackers, fixture automation with human-in-the-loop editing, and
  a release-to-clubs workflow.
- **Club Portal** — three-phase integration journey: 2026/27 affiliation form
  (chair, exco, coaches, ground locator, leagues), compliance document uploads,
  CQI self-assessment, and a live fixtures view once the Dolphins office
  releases the schedule.

### Notable features

- Real **Leaflet + OpenStreetMap + Nominatim** ground locator (no API key needed)
- **Round-robin fixture generator** with haversine distance + fuel cost per
  fixture (configurable cars × R/km)
- **Release-to-clubs** flow with a centered confirmation popup, gated club-side
  views, and pulsing "NEW" nav badges when a release lands
- **3-step cinematic onboarding** for first-time club logins
- **CountUp animations** with conditional traffic-light tones on admin KPIs
- Full **mobile + tablet responsive** pass — 16px inputs to prevent iOS
  focus-zoom, tightened payment block, full-width CTAs

---

## File map

| Path | Purpose |
|---|---|
| `index.html` | Vite entrypoint at repo root — embeds global CSS, loads `src/main.jsx` as an ES module |
| `src/data.jsx` | Seed `SAMPLE_CLUBS`, `SERIES`, `CQI_STRUCTURE`, helpers (`haversineKm`, `fixtureCost`, `generateRoundRobin`) |
| `src/atoms.jsx` | Design-system primitives: `Btn`, `Pill`, `Card`, `KPI`, `CountUp`, `NumSlider`, etc. |
| `src/main.jsx` | `App` + `Shell` — React Router routes, role/profile state, task modals, nav |
| `src/club.jsx` | Club-side views: `ClubHome`, `AffiliationForm`, `DocumentsView`, `CQIView`, `ClubFixturesView` (Leaflet ground locator lives here) |
| `src/admin.jsx` | Admin views: `AdminDashboard`, `AdminClubsList`, `AdminClubDetail`, `AdminFixtures`, `FixtureTable`, `CreateSeriesForm` |
| `src/onboarding.jsx` | 3-step cinematic welcome modal |
| `public/players/` | Hero photography (Ackerman, Viljoen, Mokoena) |
| `public/dolphins-logo.png` | Official Hollywoodbets Dolphins emblem |
| `vite.config.js` | Vite config (dev + preview bind to port 3201) |
| `vercel.json` | Explicit Vite preset, SPA rewrite, immutable cache headers |

**Stack:** Vite 5 + React 18 + react-router-dom v6 + Leaflet. JSX, not TypeScript.

### URL map

| URL | View |
|---|---|
| `/` | Profile picker |
| `/admin/dashboard` | Cohort dashboard |
| `/admin/clubs` | All clubs list |
| `/admin/clubs/:clubId` | Drill-down club detail |
| `/admin/affiliations`, `/admin/documents`, `/admin/cqi` | Filtered trackers |
| `/admin/fixtures` | Series + fixtures |
| `/club/:clubId` | Club home |
| `/club/:clubId/affiliation` | Affiliation form (modal) |
| `/club/:clubId/documents` | Compliance docs (modal) |
| `/club/:clubId/cqi` | CQI self-assessment |
| `/club/:clubId/fixtures` | Released fixtures |

Deep links work; browser back/forward works; refresh keeps you on the same view.

---

## What's missing for production

This is a UX prototype. To make it real, you'd add:

| Layer | Suggested stack |
|---|---|
| Database & API | Postgres on Supabase (auto-REST + Auth in one) |
| File uploads | Supabase Storage / S3 for compliance docs |
| Payments | Stripe / Yoco / PayFast for the R 4,500 affiliation fee |
| Email + SMS | Postmark / Resend + Twilio / Clickatell |
| Hosting | Vercel (front) + Supabase (back) |

The component shape (`updateClub`, `uploadDoc`, `saveExco`, `setReleased`
handlers in `Shell` / `AppRoutes`) is friendly to API swapping — replace those
with `fetch` calls and the UI keeps working.

---

## Brand

Monochrome + Hollywoodbets Dolphins dark green, with the official emblem.
Montserrat (300–900) throughout. Subtle motion (`fadeUp`, `kenburns`,
`pulseDot`, count-ups). The hero player photography (Ackerman, Viljoen,
Mokoena) is used aspirationally to position club-level players within the
Dolphins ecosystem.

*Powered by Medicoach.*

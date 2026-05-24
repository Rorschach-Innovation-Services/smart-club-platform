# Hollywoodbets Dolphins · Smart Club Platform

A clickable front-end prototype of the **Smart Club Integration Platform** for
the Hollywoodbets Dolphins, covering club affiliation, compliance documents,
the Club Quality Index (CQI), fixture automation, and travel-cost modelling
across **KZNCU & EMCU** for the 2026/27 season.

> ⚠️ **Prototype only.** No backend, no database, no payments — all state is
> in-memory React state and resets on page refresh. See *What's missing* below.

---

## Quick start

This is a zero-build static site. Any HTTP server works.

```bash
# from the project root
python3 -m http.server 3201
# then open http://localhost:3201
```

Or just double-click `index.html` (Chrome/Edge — Safari blocks file:// fetches).

To preview on your phone over Wi-Fi:

```bash
python3 -m http.server 3201 --bind 0.0.0.0
# find your LAN IP with: ipconfig getifaddr en0
# then on phone: http://<your-ip>:3201
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

| File | Purpose |
|---|---|
| `index.html` | Shell — global CSS, Leaflet + React CDNs, Babel-standalone, mounts `<App/>` |
| `data.jsx` | Seed `SAMPLE_CLUBS`, `SERIES`, `CQI_STRUCTURE`, helpers (`haversineKm`, `fixtureCost`, `generateRoundRobin`) |
| `atoms.jsx` | Design-system primitives: `Btn`, `Pill`, `Card`, `KPI`, `CountUp`, `NumSlider`, etc. |
| `main.jsx` | `App` + `Shell` — routing, role/profile state, task modals, nav |
| `club.jsx` | Club-side views: `ClubHome`, `AffiliationForm`, `DocumentsView`, `CQIView`, `ClubFixturesView` |
| `admin.jsx` | Admin views: `AdminDashboard`, `AdminClubsList`, `AdminFixtures`, `FixtureTable`, `CreateSeriesForm` |
| `onboarding.jsx` | 3-step cinematic welcome modal |
| `players/` | Aspirational hero photography (Ackerman, Viljoen, Mokoena) |
| `dolphins-logo.png` | Official Hollywoodbets Dolphins emblem |

The whole thing uses **React 18 + Babel-standalone in the browser** — no build
step, no bundler. Edit any `.jsx` and refresh. Cache-buster `?v=N` on the
`<script>` tags in `index.html` forces a hard reload.

---

## What's missing for production

This is a UX prototype. To make it real, you'd add:

| Layer | Suggested stack |
|---|---|
| Database & API | Postgres on Supabase (auto-REST + Auth in one) |
| File uploads | Supabase Storage / S3 for compliance docs |
| Payments | Stripe / Yoco / PayFast for the R 4,500 affiliation fee |
| Email + SMS | Postmark / Resend + Twilio / Clickatell |
| Build | Vite (replaces in-browser Babel for faster mobile loads) |
| Hosting | Vercel (front) + Supabase (back) |

The component shape (`updateClub`, `uploadDoc`, `saveExco`, `setReleased`
handlers in `Shell`) is friendly to API swapping — replace those with `fetch`
calls and the UI keeps working.

---

## Brand

Monochrome + Hollywoodbets Dolphins dark green, with the official emblem.
Montserrat (300–900) throughout. Subtle motion (`fadeUp`, `kenburns`,
`pulseDot`, count-ups). The hero player photography (Ackerman, Viljoen,
Mokoena) is used aspirationally to position club-level players within the
Dolphins ecosystem.

*Powered by Medicoach.*

# Tutorial videos runbook

How the "How to use the app" videos on the public `/tutorials` page get hosted and
updated. The page (`src/TutorialsPage.tsx`) renders whatever the public `/tenant`
payload returns in `tutorials[]`; that list comes from `DEFAULT_TUTORIALS` in
`packages/api/src/index.ts` (or a per-tenant `config.tutorials` override).

**The operator portal is the primary way to manage per-tenant videos.** An operator
uploads a client's own clips (and optionally opts them out of the shared default set)
from the tenant's settings screen — see "Per-tenant overrides" below. `scripts/
upload-tutorials.sh` still exists, but only for maintaining the SHARED default set
(the `tutorials/01-creating-account.mp4`-style files every tenant without an override
falls back to) — it is never the right tool for a single client's own videos.

## Where the files live

A public-read S3 bucket (`TutorialAssets`, `access: 'public'` in `sst.config.ts`),
served directly over its regional HTTPS REST endpoint. **No CloudFront** — the shared
`medicoach` account is at its CloudFront cache-policy quota (20/20), so a dedicated
Router/distribution can't be created without freeing a slot or a quota increase. S3
still serves byte-range requests, so the `<video>` player can seek; a cross-origin
`<video>` needs no CORS. The MP4s are **not** part of the web build — they're uploaded
out-of-band, so a `sst deploy` never re-uploads or purges them, and they never bloat git.

- Object keys live under the `tutorials/` prefix, e.g. `tutorials/01-creating-account.mp4`
  for the shared default set, or `tutorials/<slug>/<kind>-<uuid8>[-name].<ext>` for a
  tenant's own operator-uploaded clips (see "Per-tenant overrides" below).
- Served at `https://<bucket>.s3.af-south-1.amazonaws.com/tutorials/<file>`.
- The bucket's CORS policy allows `GET/HEAD/PUT/POST` from any origin (`sst.config.ts`)
  — presigned URLs are the auth, so the operator portal's origin doesn't need
  allowlisting, and `exposeHeaders: ['ETag']` lets the browser read each multipart
  part's ETag to assemble the completion request.
- `DEFAULT_TUTORIALS` builds those absolute URLs from the `TUTORIALS_BASE_URL` env var
  (= the bucket's HTTPS endpoint, `tutorialBaseUrl` output), wired in `sst.config.ts`.
- **Future**: if a CloudFront cache-policy slot frees up (or the quota is raised), this
  can move back behind a Router for edge caching — flip the bucket to `access: 'cloudfront'`,
  add `const cdn = new sst.aws.Router('Cdn'); cdn.routeBucket('/tutorials', tutorialAssets)`,
  and set `TUTORIALS_BASE_URL`/`tutorialBaseUrl` to `cdn.url`. Object keys stay the same.

## Canonical filenames

`DEFAULT_TUTORIALS` expects exactly these keys (order = on-screen numbering):

| #   | Key (`tutorials/…`)         | Recording                                |
| --- | --------------------------- | ---------------------------------------- |
| 1   | `01-creating-account.mp4`   | Step 1 — Creating your account           |
| 2   | `02-affiliation.mp4`        | Step 2 — Completing the affiliation form |
| 3   | `03-compliance-forms.mp4`   | Step 3 — Uploading compliance forms      |
| 4   | `04-cqi.mp4`                | Step 4 — Completing the CQI              |
| 5   | `05-onboarding-players.mp4` | Step 5 — Onboarding players              |
| 6   | `06-clearances.mp4`         | Step 6 — Player clearances               |
| 7   | `00-full-walkthrough.mp4`   | Smart Club Tutorial (full cut)           |

## First-time setup

1. **Deploy the infra** (adds the bucket + CDN):

   ```sh
   npx sst deploy --stage prod
   ```

   Note the two new outputs: `tutorialBucket` (bucket name) and `tutorialBaseUrl`.

2. **Upload the videos.** The recordings are in `~/Downloads/Tutorial videos`. The
   helper script renames them to the canonical keys and uploads with the right
   content-type:

   ```sh
   scripts/upload-tutorials.sh <tutorialBucket>
   ```

   (Override the source folder with a 2nd arg; override AWS profile/region with the
   `AWS_PROFILE` / `AWS_REGION` env vars. Defaults: `medicoach` / `af-south-1`.)

3. **Verify** the page: open `https://<your-host>/tutorials` — all 7 videos should
   play and seek.

`DEFAULT_TUTORIALS` already points at these URLs, so no further deploy is needed
after the upload (the API reads `TUTORIALS_BASE_URL` at runtime).

## Updating or replacing a clip

Re-record, drop the new file in the source folder under the **same raw name**, and
re-run the upload script (or `aws s3 cp` that one file to its `tutorials/<key>`).
Objects carry `Cache-Control: public,max-age=86400`, so a browser that already cached
the old clip may keep it for up to a day. Served straight from S3 (no CDN), there's no
distribution to invalidate; to force-refresh immediately, change the key (e.g.
`…-v2.mp4`) and update the matching entry in `DEFAULT_TUTORIALS`.

## Per-tenant overrides

To give one union a different set, an operator uploads clips through the platform
portal and saves them onto that tenant's `tutorials: TutorialVideo[]` — no manual S3
work or deploy needed. Under the hood:

- **Upload**: `POST /platform/tenants/:slug/tutorial-upload` presigns the upload —
  either a single presigned POST (posters, and videos ≤ 100 MB) or a multipart upload
  (larger videos; the browser PUTs each part straight to S3, then calls
  `.../tutorial-upload/complete`). Object keys land under `tutorials/<slug>/` — a
  **separate, per-tenant prefix** one level below the shared default clips
  (`tutorials/<file>.mp4`), so a tenant's own uploads can never collide with, shadow,
  or (via the cleanup below) get confused with the shared set.
- **Save**: `PUT /platform/tenants/:slug` with a `tutorials` array of `{title, url,
  poster?}` (https URLs only — normally the `publicUrl` the upload step returned).
  Optionally set `tutorialsNoFallback: true` so an empty/absent override serves **no**
  videos instead of quietly falling back to `DEFAULT_TUTORIALS` — for a client whose
  own onboarding flow has diverged enough that the shared clips would mislead.
- **Cleanup**: saving a new `tutorials` array deletes the S3 objects for any dropped
  entry, but ONLY when its URL sits under that tenant's own `tutorials/<slug>/`
  prefix — the shared default clips and every other tenant's assets are hard-excluded
  from deletion, so a slug mix-up can't take out shared media. Deletion is
  best-effort: a failure is logged, never blocks the config save.
- **Abandoned uploads**: a multipart upload that's never completed or aborted (a
  browser tab closed mid-upload) is cleaned up automatically — `sst.config.ts` adds an
  S3 lifecycle rule (`abortIncompleteMultipartUpload`, scoped to the `tutorials/`
  prefix) that aborts it after 3 days, freeing the part storage.

Tenant admins cannot write `tutorials` or `tutorialsNoFallback` themselves — both are
operator-only, stripped from `PUT /tenant/config` the same way `features`/`districts`
are (ADR 0006).

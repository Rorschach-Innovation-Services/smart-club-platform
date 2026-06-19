# Tutorial videos runbook

How the "How to use the app" videos on the public `/tutorials` page get hosted and
updated. The page (`src/TutorialsPage.jsx`) renders whatever the public `/tenant`
payload returns in `tutorials[]`; that list comes from `DEFAULT_TUTORIALS` in
`packages/api/src/index.ts` (or a per-tenant `config.tutorials` override).

## Where the files live

A public-read S3 bucket (`TutorialAssets`, `access: 'public'` in `sst.config.ts`),
served directly over its regional HTTPS REST endpoint. **No CloudFront** — the shared
`medicoach` account is at its CloudFront cache-policy quota (20/20), so a dedicated
Router/distribution can't be created without freeing a slot or a quota increase. S3
still serves byte-range requests, so the `<video>` player can seek; a cross-origin
`<video>` needs no CORS. The MP4s are **not** part of the web build — they're uploaded
out-of-band, so a `sst deploy` never re-uploads or purges them, and they never bloat git.

- Object keys live under the `tutorials/` prefix, e.g. `tutorials/01-creating-account.mp4`.
- Served at `https://<bucket>.s3.af-south-1.amazonaws.com/tutorials/<file>`.
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

To give one union a different set, write a `tutorials: TutorialVideo[]` array onto
that tenant's `CONFIG` item (absolute URLs work as-is). Absent ⇒ `DEFAULT_TUTORIALS`.

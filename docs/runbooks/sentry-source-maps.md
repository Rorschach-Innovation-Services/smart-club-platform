# Runbook — Sentry releases + source-map upload (web)

**Owner:** Sentry org **medicoach-ap** on the **EU region** (`https://de.sentry.io/`), project
**dolphins-web** (the platform-wide web project for every tenant). **Status: wired, token not
yet set.** Until the `SentryAuthToken` secret is set on a stage, that stage's web build logs
the plugin's "No auth token provided" warning and skips the upload. The deploy still succeeds;
production stack traces just stay minified.

> **Build-time only.** `SENTRY_AUTH_TOKEN` is passed to the `npm run build` child process that
> SST spawns for the `Web` StaticSite (`sst.config.ts`, the `environment` block next to the
> `VITE_SENTRY_*` entries). It is **not** `VITE_`-prefixed, so Vite never inlines it into the
> bundle. `@sentry/vite-plugin` reads it from `process.env.SENTRY_AUTH_TOKEN`.

> **Nothing leaks to S3/CloudFront.** `vite.config.ts` builds with `sourcemap: 'hidden'`, so
> the shipped JS has no `//# sourceMappingURL` comment. After upload the plugin deletes
> `./dist/**/*.map` (`filesToDeleteAfterUpload`), so the maps never reach the bucket.

---

## Why

Frontend errors in Sentry arrive tagged with the release `smart-club@<version>+<gitSha>`
(`sentryRelease` in `sst.config.ts`, passed to the build as `VITE_SENTRY_RELEASE`). The SDK
and the vite plugin both read that same value, so once maps are uploaded against the release,
Sentry resolves minified frames back to `src/**` file and line numbers. Without the token no
release is created and no maps are uploaded.

---

## 1 · Create the token in Sentry

Use an **organization auth token** (or an internal integration token). Don't use a personal
member token.

1. Sign in at **https://de.sentry.io/** → org **medicoach-ap**.
2. **Settings → Developer Settings → Organization Tokens → Create New Token**
   (or **Custom Integrations → Create New Integration → Internal Integration** if you prefer a
   named integration).
3. Scopes: **`project:releases`** (create releases + upload artifacts) and **`org:read`**.
   Org tokens get the release/upload scopes automatically; for an internal integration, set
   _Releases: Admin_ and _Organization: Read_.
4. Name it something like `smart-club-web-build` and copy the token. Sentry shows it only
   once.

> Member tokens can't create projects in this org, but that doesn't matter here. The token
> only writes releases and artifacts into the existing `dolphins-web` project.

---

## 2 · Set the secret

From the repo root, logged in to the AWS account that hosts the stage:

```sh
npx sst secret set SentryAuthToken <token> --stage prod
# optional — also upload maps for dev deploys
npx sst secret set SentryAuthToken <token> --stage dev
```

The secret defaults to `''` (`new sst.Secret('SentryAuthToken', '')`), so an unset stage keeps
deploying exactly as before. Setting it takes effect on the **next deploy** of that stage. It
doesn't trigger a redeploy on its own.

---

## 3 · Verify on the next deploy

Deploy as usual (`npx sst deploy --stage prod`) and read the `Web` build output:

- **Before (no token):** the plugin prints a warning like
  `No auth token provided. Will not create release. Will not upload source maps.`
- **After (token set):** the log shows the plugin creating release
  `smart-club@<version>+<sha>` and uploading source maps / artifact bundles, then deleting the
  `.map` files.

Then confirm in Sentry:

1. **dolphins-web → Releases**: the new `smart-club@…` release is listed.
2. On that release, **Source Maps / Artifact Bundles** shows the uploaded bundle.
3. The next web error for that release shows de-minified frames (`src/...tsx` paths).

Spot-check that no maps shipped: `curl -sI https://<web host>/assets/<some chunk>.js.map`
should return the SPA fallback (`index.html`, `content-type: text/html`), not a JSON map.

---

## Rotating / revoking

Revoke the token in Sentry, create a new one, and re-run `sst secret set` for each stage. To
turn uploads off again, run `npx sst secret remove SentryAuthToken --stage <stage>`. The secret
falls back to its `''` default and the build returns to the warn-and-skip path.

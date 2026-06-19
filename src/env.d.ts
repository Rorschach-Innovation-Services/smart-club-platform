/**
 * Manual environment-variable typing that AUGMENTS the SST-generated
 * `src/sst-env.d.ts` (which declares the deployed VITE_* vars but is overwritten
 * on every `sst dev`/`deploy`).
 *
 * `VITE_LOCAL_AUTH` is a dev-only flag, read in api.ts / auth.tsx / devAuth.ts /
 * main.tsx / DocPreviewModal.tsx / club.tsx, that SST does NOT emit. Declaring it
 * here via interface declaration merging is additive and survives SST regeneration.
 *
 * Do NOT edit sst-env.d.ts, and do NOT redeclare any var it already owns.
 */
interface ImportMetaEnv {
  readonly VITE_LOCAL_AUTH?: string;
}

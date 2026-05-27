/// <reference path="./.sst/platform/config.d.ts" />
export default $config({
  app(input) {
    return {
      name: 'dolphins-smart-club',
      removal: input?.stage === 'prod' ? 'retain' : 'remove',
      protect: input?.stage === 'prod',
      home: 'aws',
      providers: {
        aws: { region: 'af-south-1', profile: 'medicoach' },
      },
    };
  },
  async run() {
    const web = new sst.aws.StaticSite('Web', {
      build: { command: 'npm run build', output: 'dist' },

      // ── SPA fallback ──
      // Plain `errorPage` passes through CloudFront's 403/404 status. React Router
      // deep-link refreshes need HTTP 200 so analytics, uptime checks, and crawlers
      // don't see every deep link as an error. Remap explicitly:
      transform: {
        cdn: (args) => {
          args.customErrorResponses = [
            { errorCode: 403, responseCode: 200, responsePagePath: '/index.html' },
            { errorCode: 404, responseCode: 200, responsePagePath: '/index.html' },
          ];
        },
      },

      // ── Cache headers ──
      // SST default applies `immutable, max-age=31536000` to everything. That breaks
      // unhashed `public/` files — a logo swap wouldn't propagate for a year.
      // Only Vite's hashed `assets/**` get immutable; public files get 1 day.
      assets: {
        fileOptions: [
          {
            files: '**/*.html',
            cacheControl: 'max-age=0,no-cache,no-store,must-revalidate',
          },
          {
            files: 'assets/**',
            cacheControl: 'public,max-age=31536000,immutable',
          },
          { files: '*.png', cacheControl: 'public,max-age=86400' },
          { files: 'players/**', cacheControl: 'public,max-age=86400' },
        ],
      },
    });
    return { url: web.url };
  },
});

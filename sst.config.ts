/// <reference path="./.sst/platform/config.d.ts" />

/**
 * Smart Club Platform — multi-tenant SaaS infrastructure (af-south-1).
 *
 * One shared stack serves every union (tenant): one DynamoDB table (tenant-scoped
 * keys), one Cognito pool (passwordless email OTP + a PreTokenGeneration trigger that
 * stamps a `memberships` claim), one Hono API on Lambda, and the existing StaticSite.
 *
 * See docs/architecture/ for the decisions behind this shape.
 */
export default $config({
  app(input) {
    return {
      name: 'dolphins-smart-club',
      removal: input?.stage === 'prod' ? 'retain' : 'remove',
      protect: input?.stage === 'prod',
      home: 'aws',
      providers: {
        // af-south-1 (Cape Town) for South African data residency (POPIA).
        aws: { region: 'af-south-1', profile: 'medicoach' },
      },
    };
  },

  async run() {
    // ── Data: single DynamoDB table, tenant-scoped keys ──
    // pk/sk primary, gsi1 for per-tenant listing & by-tenant user lookups.
    // See docs/architecture/data-model.md.
    const table = new sst.aws.Dynamo('Data', {
      fields: {
        pk: 'string',
        sk: 'string',
        gsi1pk: 'string',
        gsi1sk: 'string',
      },
      primaryIndex: { hashKey: 'pk', rangeKey: 'sk' },
      globalIndexes: {
        gsi1: { hashKey: 'gsi1pk', rangeKey: 'gsi1sk' },
      },
    });

    // ── Uploads: private compliance PDFs + tenant logos (presigned access) ──
    const uploads = new sst.aws.Bucket('Uploads');

    // ── Auth: Cognito user pool with passwordless email OTP ──
    // Passwordless USER_AUTH/EMAIL_OTP requires the Essentials feature plan.
    // These args ride the underlying aws.cognito.UserPool via transform; if the
    // provider rejects userPoolTier/signInPolicy in af-south-1, fall back to
    // CUSTOM_AUTH triggers (see docs/architecture/0003 and the auth spike runbook).
    const userPool = new sst.aws.CognitoUserPool('Auth', {
      usernames: ['email'],
      // PreTokenGeneration stamps `memberships` onto the ID token from the USER# record.
      triggers: {
        preTokenGeneration: {
          handler: 'packages/api/src/pre-token-gen.handler',
          link: [table],
          // Explicit env so repo.ts resolves the table name in the trigger
          // runtime (matches the API function — link alone wasn't enough).
          environment: { TABLE_NAME: table.name },
        },
      },
      transform: {
        userPool: (args) => {
          // Admin-create-only: no open self-signup.
          args.adminCreateUserConfig = { allowAdminCreateUserOnly: true };
          // Essentials plan (required for passwordless email OTP).
          // @ts-expect-error userPoolTier not in this provider version's types
          args.userPoolTier = 'ESSENTIALS';
          args.autoVerifiedAttributes = ['email'];
          // NOTE: EMAIL_OTP as a first auth factor (Policies.SignInPolicy
          // .AllowedFirstAuthFactors) can't be set here — it only exists in
          // pulumi-aws 7.x and SST 3.x bundles 6.x. It's enabled by the
          // post-deploy `enable-passwordless` script. See docs/architecture/0003.
        },
      },
    });

    const userPoolClient = userPool.addClient('WebClient', {
      transform: {
        client: (args) => {
          args.explicitAuthFlows = ['ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'];
          args.generateSecret = false;
        },
      },
    });

    // ── API: one Hono Lambda behind a $default route ──
    // JWT is verified inside the app (aws-jwt-verify) so public routes (/tenant,
    // /register) and protected routes can coexist on one catch-all route.
    const api = new sst.aws.ApiGatewayV2('Api');
    api.route('$default', {
      handler: 'packages/api/src/index.handler',
      // Linking grants IAM + Resource access. userPool link lets the API call
      // AdminCreateUser for the invite flow.
      link: [table, uploads, userPool, userPoolClient],
      environment: {
        USER_POOL_ID: userPool.id,
        USER_POOL_CLIENT_ID: userPoolClient.id,
        UPLOADS_BUCKET: uploads.name,
        TABLE_NAME: table.name,
        // STAGE gates the dev-only x-tenant header (prod resolves tenant by host).
        STAGE: $app.stage,
        // Comma-separated extra CORS origins (custom tenant domains in prod).
        ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? '',
      },
      nodejs: { install: ['aws-jwt-verify'] },
    });

    // ── Web: existing StaticSite, now wired to the API + Cognito ──
    const web = new sst.aws.StaticSite('Web', {
      build: { command: 'npm run build', output: 'dist' },

      // Vite bakes these at build time (one platform build; tenant is resolved at
      // runtime by hostname). See docs/architecture/0002.
      environment: {
        VITE_API_URL: api.url,
        VITE_USER_POOL_ID: userPool.id,
        VITE_USER_POOL_CLIENT_ID: userPoolClient.id,
        VITE_AWS_REGION: 'af-south-1',
      },

      // ── SPA fallback ──
      // Remap 403/404 to 200 + index.html so React Router deep links resolve.
      // (API authz 403s are API Gateway responses, unaffected by this CDN rule.)
      transform: {
        cdn: (args) => {
          args.customErrorResponses = [
            { errorCode: 403, responseCode: 200, responsePagePath: '/index.html' },
            { errorCode: 404, responseCode: 200, responsePagePath: '/index.html' },
          ];
        },
      },

      // ── Cache headers ──
      // Only Vite's hashed assets/** are immutable; unhashed public files get 1 day.
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

    return {
      url: web.url,
      api: api.url,
      userPoolId: userPool.id,
      userPoolClientId: userPoolClient.id,
    };
  },
});

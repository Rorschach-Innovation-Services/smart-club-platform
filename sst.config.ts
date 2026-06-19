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
    // ── Prod custom domains ──
    // medicoach.co.za is on external DNS (no Route53 zone), so SST uses dns:false +
    // pre-issued ACM certs; the apex/api/www CNAMEs are created manually after deploy.
    // Web cert MUST be us-east-1 (CloudFront); API cert MUST be af-south-1 (HTTP API
    // custom domains are regional — a us-east-1 cert can't attach). Both cover www.
    // NOTE: the cert ARNs below are specific to AWS account 433453514361 — re-issue per
    // account if this stack is ever deployed elsewhere. Each cert's SANs must cover every
    // host it fronts (web cert: apex + www; API cert: api.<…>) or CloudFront/API GW serve
    // cert errors. See docs/guides/onboarding-a-tenant.md.
    const isProd = $app.stage === 'prod';
    const WEB_CERT =
      'arn:aws:acm:us-east-1:433453514361:certificate/5c749bdd-1687-4ecc-a3b7-f4e35aaab487';
    const API_CERT =
      'arn:aws:acm:af-south-1:433453514361:certificate/f485b435-3bef-42f0-a27f-3b798e98c8eb';
    const PROD_WEB_HOST = 'dolphinspipeline.medicoach.co.za';
    const PROD_API_HOST = 'api.dolphinspipeline.medicoach.co.za';
    // Custom-domain hosts don't follow the leftmost-label tenant convention (the API
    // lives at api.<…> and the union's vanity host is "dolphinspipeline", not "dolphins"),
    // so map them explicitly. resolveTenant()/resolveTenantSlug() consult this first and
    // fall back to the leftmost label for clean per-union subdomains. See auth.ts.
    const TENANT_HOST_MAP: Record<string, string> = {
      [PROD_WEB_HOST]: 'dolphins',
      [`www.${PROD_WEB_HOST}`]: 'dolphins',
      [PROD_API_HOST]: 'dolphins',
    };

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
      // Self-expire only items that carry `expiresAt` (epoch seconds) — currently just
      // the INVITE# idempotency markers, so they don't accumulate. Clubs/players/series
      // have no `expiresAt`, so TTL never touches them.
      ttl: 'expiresAt',
    });

    // ── Uploads: private compliance PDFs + tenant logos (presigned access) ──
    const uploads = new sst.aws.Bucket('Uploads');

    // ── Tutorial videos: public how-to-use-the-app MP4s, served straight from S3 ──
    // Public-read bucket served over its regional HTTPS REST endpoint. No CloudFront: this
    // (shared medicoach) account is at its CloudFront cache-policy quota (20/20), and a
    // dedicated Router would need a free slot — see docs/guides/tutorial-videos.md. The
    // clips are large (≈1.2 GB across the 6 steps + a 1.17 GB full cut) and non-sensitive,
    // so they live here rather than in the web build's `public/` — no git bloat, no
    // re-upload on every web deploy. S3 serves byte-range requests so the <video> player
    // can seek, and a cross-origin <video> needs no CORS. Files are uploaded out-of-band
    // (see the runbook), NOT synced from the repo, so a deploy never purges them. Object
    // keys live under the `tutorials/` prefix, e.g. tutorials/01-creating-account.mp4.
    const tutorialAssets = new sst.aws.Bucket('TutorialAssets', { access: 'public' });
    // Virtual-hosted-style HTTPS endpoint (af-south-1). DEFAULT_TUTORIALS builds
    // `${TUTORIALS_BASE_URL}/tutorials/<file>` from this.
    const tutorialsBaseUrl = $interpolate`https://${tutorialAssets.name}.s3.af-south-1.amazonaws.com`;

    // ── Auth: Cognito user pool with passwordless email OTP ──
    // Passwordless USER_AUTH/EMAIL_OTP requires the Essentials feature plan.
    // These args ride the underlying aws.cognito.UserPool via transform; if the
    // provider rejects userPoolTier/signInPolicy in af-south-1, fall back to
    // CUSTOM_AUTH triggers (see docs/architecture/0003 and the auth spike runbook).
    // OTP email: Cognito's default sender (no-reply@verificationemail.com, 50/day)
    // gets spam-binned by Gmail, so the pool should send via SES DEVELOPER mode.
    // That config is NOT set here: Cognito requires an af-south-1 SES identity
    // (cross-region ARNs are rejected) and this account's af-south-1 SES starts
    // sandboxed — so enable-passwordless.ts applies it once SES is ready. Deploys
    // that update the pool reset it (UpdateUserPool omits = resets); re-run the
    // script after every deploy. See docs/guides/deploy-and-spike.md step 3.
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
          // OTP sign-in session window (minutes, max 15). The default 3 min expires
          // before slow OTP email lands — "Invalid session for the user, session
          // is expired" on every code typed from a late-arriving email.
          args.authSessionValidity = 15;
        },
      },
    });

    // ── Outbound messaging secrets (onboarding invites) ──
    // Reused from the medicoach account: the verified SES identity (eu-west-1) and the
    // Meta WhatsApp Cloud API credentials. Defaulted to '' so the stack still deploys
    // before they're set — the API's notify module dry-runs while any of these is empty
    // (see packages/api/src/notify). Set real values with `sst secret set` only after
    // SES production access is granted; until then email to unverified clubs is rejected.
    // ⚠️ POPIA: these route chair PII to SES (Ireland) + Meta (global) — a documented
    // cross-border transfer. See docs/guides/popia-compliance.md.
    const fromEmail = new sst.Secret('FromEmail', '');
    const whatsappAccessToken = new sst.Secret('WhatsappAccessToken', '');
    const whatsappPhoneNumberId = new sst.Secret('WhatsappPhoneNumberId', '');
    const whatsappInviteTemplate = new sst.Secret(
      'WhatsappInviteTemplate',
      'club_onboarding_invite',
    );
    // Staff (admin/rep) invites reuse the invite template by default until a dedicated
    // Meta-approved staff template exists. Read by notify/whatsapp.ts (WHATSAPP_STAFF_TEMPLATE).
    const whatsappStaffTemplate = new sst.Secret('WhatsappStaffTemplate', 'club_onboarding_invite');
    // Chair onboarding (player-reg link + tutorials), sent on affiliation-complete. Read by
    // notify/whatsapp.ts (WHATSAPP_REGLINK_TEMPLATE) — create + approve this Utility template
    // (body vars {{1}} chair, {{2}} club, {{3}} reg link, {{4}} tutorials URL) before real sends.
    const whatsappReglinkTemplate = new sst.Secret('WhatsappReglinkTemplate', 'club_reglink_ready');

    // ── API: one Hono Lambda behind a $default route ──
    // JWT is verified inside the app (aws-jwt-verify) so public routes (/tenant,
    // /register) and protected routes can coexist on one catch-all route.
    const api = new sst.aws.ApiGatewayV2('Api', {
      // Prod: dedicated regional custom domain so the Host header carries the tenant
      // (raw execute-api hosts resolve to null). dns:false — CNAME added manually at
      // the external DNS provider. With a domain set, `api.url` becomes the custom URL,
      // so VITE_API_URL + ALLOWED_ORIGINS below pick it up automatically.
      domain: isProd ? { name: PROD_API_HOST, dns: false, cert: API_CERT } : undefined,
    });
    api.route('$default', {
      handler: 'packages/api/src/index.handler',
      // Linking grants IAM + Resource access. userPool link lets the API call
      // AdminCreateUser for the invite flow.
      link: [
        table,
        uploads,
        userPool,
        userPoolClient,
        fromEmail,
        whatsappAccessToken,
        whatsappPhoneNumberId,
        whatsappInviteTemplate,
        whatsappStaffTemplate,
        whatsappReglinkTemplate,
      ],
      // SES isn't covered by `link` (it's not an SST resource), so grant it directly.
      // SES authorizes by verified identity, not resource ARN, hence resources: ['*'].
      // Works cross-region/same-account: this stack deploys with the medicoach profile,
      // so the Lambda role can SendEmail for that account's eu-west-1 identity.
      permissions: [{ actions: ['ses:SendEmail', 'ses:SendRawEmail'], resources: ['*'] }],
      // Two external calls (SES + Meta), each with up to 3 backoff retries, can run long
      // on a bad day; give the handler headroom over the worst case.
      timeout: '30 seconds',
      environment: {
        USER_POOL_ID: userPool.id,
        USER_POOL_CLIENT_ID: userPoolClient.id,
        UPLOADS_BUCKET: uploads.name,
        TABLE_NAME: table.name,
        // STAGE gates the dev-only x-tenant header (prod resolves tenant by host).
        STAGE: $app.stage,
        // Base URL (public S3) for the tutorial videos. DEFAULT_TUTORIALS builds
        // absolute `${TUTORIALS_BASE_URL}/tutorials/<file>` links from this.
        TUTORIALS_BASE_URL: tutorialsBaseUrl,
        // Host→tenant map for custom domains (JSON). Consulted by resolveTenant() before
        // the leftmost-label fallback. Empty off-prod (dev uses the x-tenant header).
        TENANT_HOST_MAP: JSON.stringify(isProd ? TENANT_HOST_MAP : {}),
        // Trusted CORS origins (custom tenant domains in prod). The web app is cross-origin
        // to the API (different subdomains), so its origin must be listed here.
        ALLOWED_ORIGINS: isProd
          ? `https://${PROD_WEB_HOST},https://www.${PROD_WEB_HOST}`
          : (process.env.ALLOWED_ORIGINS ?? ''),
        // Outbound messaging. SES_REGION must stay eu-west-1 — that's where the
        // verified identity with production access lives (this account's af-south-1
        // SES exists but is sandboxed: unverified recipients are rejected).
        SES_REGION: 'eu-west-1',
        FROM_EMAIL: fromEmail.value,
        WHATSAPP_ACCESS_TOKEN: whatsappAccessToken.value,
        WHATSAPP_PHONE_NUMBER_ID: whatsappPhoneNumberId.value,
        WHATSAPP_INVITE_TEMPLATE: whatsappInviteTemplate.value,
        WHATSAPP_STAFF_TEMPLATE: whatsappStaffTemplate.value,
        WHATSAPP_REGLINK_TEMPLATE: whatsappReglinkTemplate.value,
        // Force dry-run regardless of secrets (set NOTIFY_DRY_RUN=1 in the deploy env)
        // — the verified-only/dry-run gate while awaiting SES production access.
        NOTIFY_DRY_RUN: process.env.NOTIFY_DRY_RUN ?? '',
      },
      nodejs: { install: ['aws-jwt-verify'] },
    });

    // ── Web: existing StaticSite, now wired to the API + Cognito ──
    const web = new sst.aws.StaticSite('Web', {
      build: { command: 'npm run build', output: 'dist' },

      // Prod: serve at the union's custom domain (+ www alias on the same distribution;
      // the us-east-1 cert covers both). dns:false — CNAMEs added manually at the external
      // DNS provider. Aliases (not redirects) keep DNS to simple same-target CNAMEs.
      domain: isProd
        ? { name: PROD_WEB_HOST, dns: false, cert: WEB_CERT, aliases: [`www.${PROD_WEB_HOST}`] }
        : undefined,

      // Vite bakes these at build time (one platform build; tenant is resolved at
      // runtime by hostname). See docs/architecture/0002.
      environment: {
        VITE_API_URL: api.url,
        VITE_USER_POOL_ID: userPool.id,
        VITE_USER_POOL_CLIENT_ID: userPoolClient.id,
        VITE_AWS_REGION: 'af-south-1',
        // Tenant fallback for bare/www hosts, and the host→tenant map mirroring the API
        // (so dolphinspipeline.* → dolphins client-side too). Empty map off-prod.
        VITE_DEFAULT_TENANT: 'dolphins',
        VITE_TENANT_HOST_MAP: JSON.stringify(isProd ? TENANT_HOST_MAP : {}),
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
      // ⚠️ fileOptions REPLACES the platform's default '**' upload: a file matching
      // no entry is silently never uploaded. The list is processed in reverse with
      // first-processed-wins dedupe, so the catch-all must come FIRST and the
      // specific overrides after it.
      assets: {
        fileOptions: [
          { files: '**', cacheControl: 'public,max-age=86400' },
          {
            files: '**/*.html',
            cacheControl: 'max-age=0,no-cache,no-store,must-revalidate',
          },
          {
            files: 'assets/**',
            cacheControl: 'public,max-age=31536000,immutable',
          },
        ],
      },
    });

    return {
      url: web.url,
      api: api.url,
      userPoolId: userPool.id,
      userPoolClientId: userPoolClient.id,
      // For the tutorial-video upload runbook (docs/guides/tutorial-videos.md).
      tutorialBucket: tutorialAssets.name,
      tutorialBaseUrl: tutorialsBaseUrl,
    };
  },
});

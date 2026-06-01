/**
 * Cognito PreTokenGeneration trigger.
 *
 * Stamps the user's `memberships` onto the ID token from their USER# record, so
 * authorization (tenant + role + clubIds) travels in the token instead of being a
 * fixed Cognito attribute. Because it reads the DB on every token mint/refresh,
 * role changes and rep handovers take effect by editing the USER# item — no
 * attribute migration. See docs/architecture/0003.
 *
 * Claims must be strings, so `memberships` is JSON-encoded; the API and SPA decode it.
 */
import type { PreTokenGenerationTriggerHandler } from 'aws-lambda';
import { getUser } from './repo.js';

export const handler: PreTokenGenerationTriggerHandler = async (event) => {
  const sub = event.request.userAttributes.sub;
  const user = sub ? await getUser(sub) : null;
  const memberships = user?.memberships ?? [];

  event.response = {
    claimsOverrideDetails: {
      claimsToAddOrOverride: {
        memberships: JSON.stringify(memberships),
      },
    },
  };

  return event;
};

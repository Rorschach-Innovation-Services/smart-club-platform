/**
 * The notify env bootstrap for CLIs run under `sst shell` (extracted from
 * import-titans-contacts.ts so other scripts can call it without loading that CLI). Imports
 * nothing that loads notify/email.ts or notify/whatsapp.ts — the whole point.
 */
import { fromSstResource } from './env.js';

/** process.env name ← SST linked-secret name, for the notify config a Lambda gets via its
 * `environment:` block (sst.config.ts) but `sst shell` only exposes as SST_RESOURCE_<Name>.
 * SES_REGION needs no entry: email.ts already defaults it to eu-west-1, the Lambda's value. */
const NOTIFY_SECRET_ENV: ReadonlyArray<readonly [envName: string, secretName: string]> = [
  ['FROM_EMAIL', 'FromEmail'],
  ['WHATSAPP_ACCESS_TOKEN', 'WhatsappAccessToken'],
  ['WHATSAPP_PHONE_NUMBER_ID', 'WhatsappPhoneNumberId'],
];

/**
 * Populate missing notify env from SST linked secrets (the `sst shell` SST_RESOURCE_<Name>
 * JSON — the same mechanism env.ts uses for the table/pool). MUST run before notify/email.ts or
 * notify/whatsapp.ts is loaded: both freeze their dry-run flag from process.env at import time.
 * A value already present in the env wins; an empty secret (the '' default) is not copied, so
 * that channel stays dry-run and the --confirm guard names it. No SST context (--parse-only,
 * tests) ⇒ no-op. Returns the env NAMES it filled — never the values.
 */
export function bootstrapNotifyEnvFromSst(env: NodeJS.ProcessEnv = process.env): string[] {
  const filled: string[] = [];
  for (const [envName, secretName] of NOTIFY_SECRET_ENV) {
    if (env[envName]) continue;
    const value = fromSstResource(secretName, 'value', env);
    if (typeof value === 'string' && value) {
      env[envName] = value;
      filled.push(envName);
    }
  }
  return filled;
}

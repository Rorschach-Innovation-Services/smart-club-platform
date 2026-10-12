/**
 * Video-header delivery experiment — sends one of the Dolphins welcome-broadcast WhatsApp
 * templates with its VIDEO header carried two ways, so delivery can be compared on real phones:
 *
 *   - `meta-hosted`: the local file is uploaded to Meta first (uploadWhatsAppMedia) and the
 *     header references the returned media id — observed to be the reliable option;
 *   - `s3-link`: the header carries a public HTTPS link that Meta fetches at send time.
 *
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run experiment:video-header -- \
 *     --template dolphins_player_welcome --to <cell>[,<cell>…] \
 *     --video-file <local.mp4> --video-url <https://…> [--variant meta|link|both] [--name Test]
 *   … --confirm             # REAL upload + sends (default is a dry run that prints the plan)
 *   … --allow-pending       # send although the registry entry is not 'registered' yet — ONLY
 *                           # when Meta has actually approved the template
 *
 * Test phone numbers are PII: pass them with --to, never commit them.
 *
 * Conventions follow send-dolphins-welcome-broadcast.ts: bootstrapNotifyEnvFromSst() runs before
 * the notify module loads, and --confirm refuses while WhatsApp would silently dry-run.
 */
import { pathToFileURL } from 'node:url';
// Never loads notify/whatsapp.ts (see import-titans-contacts.ts) — whatsapp.ts is imported
// dynamically AFTER bootstrapNotifyEnvFromSst().
import { bootstrapNotifyEnvFromSst } from './import-titans-contacts.js';
import { toE164 } from './notify/e164.js';
import {
  WHATSAPP_TEMPLATES,
  type WhatsAppTemplateDefinition,
} from './notify/whatsapp-templates.js';

export const EXPERIMENT_TEMPLATE_KEYS = [
  'dolphinsStaffWelcome',
  'dolphinsPlayerWelcome',
  'dolphinsPlayerFyi',
] as const;
export type ExperimentTemplateKey = (typeof EXPERIMENT_TEMPLATE_KEYS)[number];

export type Variant = 'meta' | 'link';
export const VARIANT_LABEL: Record<Variant, string> = { meta: 'meta-hosted', link: 's3-link' };

export interface ExperimentArgs {
  template: ExperimentTemplateKey;
  /** E.164 digits (no +), deduped, in the order given. */
  to: string[];
  variants: Variant[];
  videoFile?: string;
  videoUrl?: string;
  name: string;
  confirm: boolean;
  allowPending: boolean;
}

/** A registry key or Meta template name → one of the three dolphins template keys. PURE. */
export function resolveTemplateKey(raw: string): ExperimentTemplateKey {
  const needle = raw.trim();
  for (const key of EXPERIMENT_TEMPLATE_KEYS) {
    if (needle === key || needle === WHATSAPP_TEMPLATES[key].name) return key;
  }
  const allowed = EXPERIMENT_TEMPLATE_KEYS.flatMap((k) => [k, WHATSAPP_TEMPLATES[k].name]);
  throw new Error(`--template "${raw}" is not one of: ${allowed.join(', ')}`);
}

/** Parse + validate the CLI flags. PURE (throws on invalid input). */
export function parseExperimentArgs(argv: string[]): ExperimentArgs {
  let template: string | undefined;
  let toRaw: string | undefined;
  let variant = 'both';
  let videoFile: string | undefined;
  let videoUrl: string | undefined;
  let name = 'Test';
  let confirm = false;
  let allowPending = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--template') template = argv[++i];
    else if (a === '--to') toRaw = argv[++i];
    else if (a === '--variant') variant = argv[++i] ?? '';
    else if (a === '--video-file') videoFile = argv[++i];
    else if (a === '--video-url') videoUrl = argv[++i];
    else if (a === '--name') name = argv[++i] ?? '';
    else if (a === '--confirm') confirm = true;
    else if (a === '--allow-pending') allowPending = true;
    else throw new Error(`unknown flag ${a}`);
  }
  if (!template) throw new Error('--template is required');
  const key = resolveTemplateKey(template);

  const to: string[] = [];
  for (const part of (toRaw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const e164 = toE164(part);
    if (!e164) throw new Error(`--to: "${part}" is not a usable cell number`);
    if (!to.includes(e164)) to.push(e164);
  }
  if (to.length === 0) throw new Error('--to needs at least one cell number');

  const variants: Variant[] =
    variant === 'both'
      ? ['meta', 'link']
      : variant === 'meta' || variant === 'link'
        ? [variant]
        : [];
  if (variants.length === 0)
    throw new Error(`--variant must be meta, link or both (got "${variant}")`);
  if (variants.includes('meta') && !videoFile) {
    throw new Error('the meta variant needs --video-file <local path> (uploaded to Meta)');
  }
  if (variants.includes('link')) {
    if (!videoUrl) throw new Error('the link variant needs --video-url <https URL>');
    if (!/^https:\/\/\S+$/.test(videoUrl)) throw new Error('--video-url must be an https URL');
  }
  if (!name.trim()) throw new Error('--name cannot be empty');

  return {
    template: key,
    to,
    variants,
    ...(videoFile ? { videoFile } : {}),
    ...(videoUrl ? { videoUrl } : {}),
    name: name.trim(),
    confirm,
    allowPending,
  };
}

export interface PlannedSend {
  to: string;
  variant: Variant;
  label: string;
}

/** Every number × variant, sequential order: per number, meta-hosted before s3-link. PURE. */
export function planExperimentSends(args: Pick<ExperimentArgs, 'to' | 'variants'>): PlannedSend[] {
  return args.to.flatMap((to) =>
    args.variants.map((variant) => ({ to, variant, label: VARIANT_LABEL[variant] })),
  );
}

/** Refusal reasons for --confirm (empty ⇒ proceed). PURE. */
export function experimentRefusals(
  def: WhatsAppTemplateDefinition,
  args: Pick<ExperimentArgs, 'allowPending'>,
  whatsappDryRun: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = [];
  if (def.status !== 'registered' && !args.allowPending) {
    out.push(
      `template ${def.name} is "${def.status}" in the registry — pass --allow-pending ONLY if Meta has approved it`,
    );
  }
  if (whatsappDryRun) {
    const missing = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'].filter((n) => !env[n]);
    const reason =
      env.NOTIFY_DRY_RUN === '1'
        ? 'NOTIFY_DRY_RUN=1'
        : missing.length
          ? `${missing.join(' + ')} unset`
          : 'notify module loaded before env was set';
    out.push(
      `whatsapp channel is in notify dry-run (${reason}) — refusing --confirm; run under ` +
        '`npx sst shell --stage <stage>` with the WhatsappAccessToken / WhatsappPhoneNumberId secrets set',
    );
  }
  return out;
}

interface SendOutcome extends PlannedSend {
  status: 'sent' | 'failed';
  messageId?: string;
  error?: string;
}

async function main(): Promise<void> {
  const args = parseExperimentArgs(process.argv.slice(2));

  // FIRST, before the dynamic import of notify/whatsapp.ts (it freezes WHATSAPP_DRY_RUN on load).
  const filled = bootstrapNotifyEnvFromSst();
  if (filled.length) console.log(`· notify config from SST linked secrets: ${filled.join(', ')}`);
  const whatsapp = await import('./notify/whatsapp.js');

  const def: WhatsAppTemplateDefinition = WHATSAPP_TEMPLATES[args.template];
  const plan = planExperimentSends(args);
  console.log(`\n── Video-header experiment: ${def.name} (registry status: ${def.status})`);
  if (def.paramCount > 0) console.log(`   {{1}} = "${args.name}"`);
  if (args.variants.includes('meta')) console.log(`   meta-hosted: upload ${args.videoFile}`);
  if (args.variants.includes('link')) console.log(`   s3-link:     ${args.videoUrl}`);
  for (const p of plan) console.log(`   → +${p.to}  ${p.label}`);

  if (args.allowPending && def.status !== 'registered') {
    console.warn(
      '\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' +
        `!! --allow-pending: sending ${def.name} although the registry says "${def.status}".\n` +
        '!! Only valid if Meta has APPROVED it — otherwise every send fails (error 132001).\n' +
        '!! Flip the registry status to "registered" once confirmed.\n' +
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n',
    );
  }

  const refusals = experimentRefusals(def, args, whatsapp.WHATSAPP_DRY_RUN);
  if (!args.confirm) {
    for (const r of refusals) console.log(`⚠ --confirm would refuse: ${r}`);
    console.log(
      `\n[dry-run] ${plan.length} send(s) planned; nothing uploaded or sent. Re-run with --confirm.`,
    );
    return;
  }
  if (refusals.length) throw new Error(refusals.join('\n'));

  let mediaId: string | undefined;
  if (args.variants.includes('meta')) {
    ({ mediaId } = await whatsapp.uploadWhatsAppMedia(args.videoFile!));
    console.log(`\n· uploaded ${args.videoFile} → Meta media id ${mediaId}`);
  }

  const opts = { allowPending: args.allowPending };
  const outcomes: SendOutcome[] = [];
  for (const p of plan) {
    const ref: import('./notify/whatsapp.js').VideoRef =
      p.variant === 'meta' ? { id: mediaId! } : { link: args.videoUrl! };
    try {
      const { messageId } =
        args.template === 'dolphinsStaffWelcome'
          ? await whatsapp.sendDolphinsStaffWelcomeWhatsApp(p.to, args.name, ref, opts)
          : args.template === 'dolphinsPlayerWelcome'
            ? await whatsapp.sendDolphinsPlayerWelcomeWhatsApp(p.to, args.name, ref, opts)
            : await whatsapp.sendDolphinsPlayerFyiWhatsApp(p.to, ref, opts);
      outcomes.push({ ...p, status: 'sent', messageId });
      console.log(`  ✓ +${p.to}  ${p.label}  wamid ${messageId}`);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      outcomes.push({ ...p, status: 'failed', error });
      console.error(`  ✗ +${p.to}  ${p.label}  ${error}`);
    }
  }

  console.log('\n── Summary');
  console.log('  to               variant      status  wamid / error');
  for (const o of outcomes) {
    console.log(
      `  ${`+${o.to}`.padEnd(16)} ${o.label.padEnd(12)} ${o.status.padEnd(7)} ${o.messageId ?? o.error ?? ''}`,
    );
  }
  console.log(
    '\nCheck each phone: does the video play inline? Delivery statuses for these wamids arrive ' +
      'via the whatsapp-status webhook.',
  );
  if (outcomes.some((o) => o.status === 'failed')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

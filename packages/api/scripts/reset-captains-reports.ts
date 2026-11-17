/**
 * One-off: redo submitted captain's reports from scratch, by CR number. Two separate phases —
 * plus a third, unrelated mode that voids the pending reports of abandoned matches.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/reset-captains-reports.ts \
 *     --stage=<stage> --tenant=dolphins --refs=CR-2026-0132,CR-2026-0133 --reset   (dry run)
 *   … --reset --confirm      void the submitted rows + reopen them for the chair — SENDS NOTHING
 *   … --send                 (dry run: shows who would get the notice)
 *   … --send --confirm       notify the chair of each reopened report (email + WhatsApp)
 *   … --backup-dir=<dir>     (default packages/api/)   … --link-base=<https url> (non-prod)
 *   … --void-abandoned --dates=2026-11-14,2026-11-15   (dry run; NO --refs)
 *   … --void-abandoned --dates=… --confirm             void them — SENDS NOTHING
 *
 * --reset: one Query of the tenant's CAPREPORT partition (no scan) resolves the refs; every
 * ref must exist and be `submitted`. A JSON backup of the full items is written (dry run too —
 * the reopen overwrites the void row, so the backup is the only copy of the bad submission).
 * Then per report: conditional `SET status='void'` (only while `submitted`), and a reopen via
 * `openReportsForFixture` with `result: null` (⇒ the chair is the recipient, a fresh random
 * memberId ⇒ a new link; old links are dead). NO NOTICE can go out: notify modules are loaded
 * WITHOUT the SST notify env (dry-run), `deadlineMs: 1` makes `notifyRecipient` return
 * 'deferred' before its NOTIFY# claim, and `sendNotice` throws as a backstop. The original CR
 * number is NOT carried over: resubmission mints a new one (the route never passes `ref`).
 *
 * --send: `bootstrapNotifyEnvFromSst()` FIRST, then the notify modules are `await import()`ed
 * (their dry-run flag freezes at import). `--confirm` is refused when the link base is
 * localhost or any channel is dry-run. Reports are found by the CAPREPORT ids printed by
 * --reset (`--refs` then holds report ids, `<series>~<fixture>~<club>`, or old CR numbers are
 * looked up in the backup file via `--backup=<file>`). Each must be pending, source=auto,
 * never notified. The notice goes through `openReportsForFixture` (its existing-pending branch
 * → `notifyRecipient`), with the notice window forced open.
 *
 * --reset refuses a fixture whose stored result is ABANDONED (before any write): the reopen
 * would be refused by the opener, leaving the submitted report void.
 *
 * --void-abandoned: one Query of the CAPREPORT partition (no scan) → pending, source=auto,
 * matchDate in --dates; one stored-result read per distinct fixture; those whose match is
 * abandoned are voided (`voidPendingCaptainsReport`, voidReason 'match abandoned in
 * medicoach' — pending-only, so a report submitted meanwhile is left alone). A JSON backup of
 * the rows to void is written (dry run too). Sends nothing: no notify module is loaded.
 *
 * Exit status: 1 for a bad flag, a stage mismatch, a failed guard or a failed notice; else 0.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CaptainsReport } from '../src/types.js';
import { bootstrapNotifyEnvFromSst } from '../src/notify-env-bootstrap.js';
import { confirmRefusals, resolveLinkBase, sstStage } from './backfill-captains-report-notices.js';

const DEFAULT_BACKUP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE =
  'usage: reset-captains-reports --stage=<stage> [--tenant=<id>] ' +
  '(--refs=<CR-…|report id,…> (--reset | --send) | --void-abandoned --dates=<YYYY-MM-DD,…>) ' +
  '[--confirm] [--backup=<file>] [--backup-dir=<dir>] [--link-base=<url>]';

export interface ResetArgs {
  stage: string;
  tenant: string;
  /** --reset / --send only (empty for --void-abandoned). */
  refs: string[];
  mode: 'reset' | 'send' | 'void-abandoned';
  /** --void-abandoned only: the match dates to sweep. */
  dates?: string[];
  confirm: boolean;
  backup?: string;
  backupDir?: string;
  linkBase?: string;
}

const list = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const validDate = (d: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(d) &&
  !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) &&
  new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** Parse the CLI flags; throws (message = the reason) on anything bad or unknown. Pure. */
export function parseResetArgs(argv: string[]): ResetArgs {
  const out: Partial<ResetArgs> & { confirm: boolean; tenant: string } = {
    confirm: false,
    tenant: 'dolphins',
  };
  const modes = new Set<ResetArgs['mode']>();
  for (const arg of argv) {
    const [flag, ...rest] = arg.split('=');
    const value = rest.join('=').trim();
    if (arg === '--confirm') out.confirm = true;
    else if (arg === '--dry-run') out.confirm = false;
    else if (arg === '--reset') modes.add('reset');
    else if (arg === '--send') modes.add('send');
    else if (arg === '--void-abandoned') modes.add('void-abandoned');
    else if (flag === '--stage' && value) out.stage = value;
    else if (flag === '--tenant' && value) out.tenant = value;
    else if (flag === '--refs' && value) out.refs = list(value);
    else if (flag === '--dates' && value) {
      const dates = list(value);
      const bad = dates.filter((d) => !validDate(d));
      if (bad.length) throw new Error(`--dates: not YYYY-MM-DD: ${bad.join(', ')}`);
      out.dates = dates;
    } else if (flag === '--backup' && value) out.backup = value;
    else if (flag === '--backup-dir' && value) out.backupDir = value;
    else if (flag === '--link-base' && value) out.linkBase = value;
    else throw new Error(`unknown or empty flag "${arg}"`);
  }
  if (!out.stage) throw new Error('--stage is required');
  if (modes.size !== 1)
    throw new Error('exactly one of --reset | --send | --void-abandoned is required');
  out.mode = [...modes][0];
  if (out.mode === 'void-abandoned') {
    if (out.refs) throw new Error('--refs is not allowed with --void-abandoned (use --dates)');
    if (!out.dates?.length) throw new Error('--dates is required with --void-abandoned');
    out.refs = [];
  } else {
    if (out.dates) throw new Error('--dates is only for --void-abandoned');
    if (!out.refs?.length) throw new Error('--refs is required');
  }
  return out as ResetArgs;
}

type RepoModule = typeof import('../src/repo.js');
type ReportsModule = typeof import('../src/captains-reports.js');

const chairLine = (c: { name: string; email?: string; cell?: string }) =>
  `${c.name || '(no name)'} email=${c.email || '(none)'} cell=${c.cell || '(none)'}`;

async function rawDdb() {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  const { tableName } = await import('../src/env.js');
  const endpoint = process.env.DYNAMO_ENDPOINT;
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient(
      endpoint
        ? {
            endpoint,
            region: 'localhost',
            credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
          }
        : {},
    ),
  );
  return { ddb, UpdateCommand, table: tableName() };
}

// ───────────────────────── --reset ─────────────────────────

export async function runReset(
  args: ResetArgs,
  repo: RepoModule,
  reports: ReportsModule,
  log: (l: string) => void = console.log,
): Promise<number> {
  const config = await repo.getTenantConfig(args.tenant);
  if (!config) {
    log(`tenant "${args.tenant}" not found`);
    return 1;
  }
  const { chairContactOf } = await import('../src/club-contacts.js');
  const { captainsReportKey } = await import('../src/keys.js');

  // One Query of the single CAPREPORT partition.
  const all = await repo.listCaptainsReports(args.tenant);
  const targets: CaptainsReport[] = [];
  const problems: string[] = [];
  for (const ref of args.refs) {
    const hits = all.filter((r) => r.ref === ref);
    if (hits.length !== 1) problems.push(`${ref}: ${hits.length} report(s) carry this ref`);
    else if (hits[0].status !== 'submitted')
      problems.push(`${ref}: status is ${hits[0].status}, not submitted`);
    else targets.push(hits[0]);
  }
  if (problems.length) {
    for (const p of problems) log(`ERROR ${p}`);
    log('nothing written');
    return 1;
  }

  const goLive = config.integrations?.medicoach?.goLiveDate;
  log(
    `${args.confirm ? 'CONFIRM' : 'DRY RUN'} --reset tenant=${args.tenant} stage=${args.stage} ` +
      `refs=${args.refs.join(',')} goLive=${goLive ?? '(unset)'}`,
  );
  for (const r of targets) {
    const club = await repo.getClub(args.tenant, r.clubId);
    const series = await repo.getSeries(args.tenant, r.seriesId);
    const fx = (series?.fixtures as Array<{ id?: string; date?: string }> | undefined)?.find(
      (f) => f?.id === r.fixtureId,
    );
    const abandoned = reports.isAbandonedResult(
      await repo.getFixtureResult(args.tenant, r.seriesId, r.fixtureId),
    );
    const why = !club
      ? 'club not found'
      : !series || !fx?.date
        ? 'fixture not found in series'
        : !goLive || fx.date < goLive
          ? 'fixture before tenant go-live (reopen would be skipped)'
          : abandoned
            ? 'match abandoned (reopen would be refused)'
            : null;
    log(
      `  ${r.ref} [${r.id}] ${r.clubName} v ${r.opponentName} ${r.matchDate} ` +
        `submittedBy=${r.submittedBy ?? '?'} via=${r.submittedVia ?? '?'}`,
    );
    if (why) {
      log(`ERROR ${r.ref}: ${why} — nothing written`);
      return 1;
    }
    log(`    would void, then reopen for chair: ${chairLine(chairContactOf(club!))}`);
  }

  const dir = args.backupDir ? resolve(args.backupDir) : DEFAULT_BACKUP_DIR;
  await mkdir(dir, { recursive: true });
  const file = join(
    dir,
    `captains-report-reset-backup-${args.tenant}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await writeFile(
    file,
    JSON.stringify({ tenant: args.tenant, stage: args.stage, reports: targets }, null, 2),
  );
  log(`backup: ${file}`);

  if (!args.confirm) {
    log('DRY RUN done: nothing written, no notice sent. Re-run with --confirm to reset.');
    return 0;
  }

  const { ddb, UpdateCommand, table } = await rawDdb();
  const neverSend = async (): Promise<never> => {
    throw new Error('reset-captains-reports --reset must never send a notice');
  };
  let failed = 0;
  for (const r of targets) {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: captainsReportKey(args.tenant, r.seriesId, r.fixtureId, r.clubId),
        UpdateExpression: 'SET #s = :void, updatedAt = :now',
        ConditionExpression: 'attribute_exists(pk) AND #s = :submitted',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':void': 'void',
          ':submitted': 'submitted',
          ':now': new Date().toISOString(),
        },
      }),
    );
    const outcome = await reports.openReportsForFixture(
      {
        tenant: args.tenant,
        seriesId: r.seriesId,
        fixtureId: r.fixtureId,
        result: null,
        config,
        sides: [r.side],
      },
      {
        repo,
        log,
        // Belt and braces: the past deadline stops notifyRecipient BEFORE its NOTIFY# claim;
        // the throwing sender would stop a send; the notify modules are dry-run anyway.
        deadlineMs: 1,
        sendNotice: neverSend,
        linkSecret: () => 'reset-no-send',
        linkBase: () => 'https://reset.invalid',
      },
    );
    const fresh = await repo.getCaptainsReport(args.tenant, r.seriesId, r.fixtureId, r.clubId);
    const ok =
      outcome.opened.includes(r.id) &&
      fresh?.status === 'pending' &&
      fresh.recipient.memberId !== r.recipient.memberId;
    if (!ok) {
      failed++;
      log(
        `  FAILED ${r.ref} [${r.id}]: voided but not reopened ` +
          `(skipped=${outcome.skipped ?? '-'} status=${fresh?.status ?? 'missing'}) — ` +
          `the submission is in ${file}`,
      );
      continue;
    }
    const club = await repo.getClub(args.tenant, r.clubId);
    log(`  ${r.ref} (old ref) [${r.id}] → status=${fresh.status} source=${fresh.source}`);
    log(`    recipient: ${fresh.recipient.kind} ${club ? chairLine(chairContactOf(club)) : ''}`);
    log(`    linkExpiresAt=${fresh.linkExpiresAt} memberId=${fresh.recipient.memberId}`);
    log('    no notice sent (run --send when ready); resubmission will get a NEW CR number');
  }
  log(`done: reset=${targets.length - failed} failed=${failed}`);
  return failed ? 1 : 0;
}

// ───────────────────────── --void-abandoned ─────────────────────────

/**
 * Void the pending auto reports of abandoned matches on `args.dates` (dry run unless
 * `confirm`). Sends nothing. Returns the exit status.
 */
export async function runVoidAbandoned(
  args: ResetArgs,
  repo: RepoModule,
  reports: ReportsModule,
  log: (l: string) => void = console.log,
): Promise<number> {
  const config = await repo.getTenantConfig(args.tenant);
  if (!config) {
    log(`tenant "${args.tenant}" not found`);
    return 1;
  }
  const dates = new Set(args.dates ?? []);
  // One Query of the single CAPREPORT partition.
  const candidates = (await repo.listCaptainsReports(args.tenant))
    .filter((r) => r.status === 'pending' && r.source === 'auto' && dates.has(r.matchDate))
    .sort((a, b) => a.matchDate.localeCompare(b.matchDate) || a.id.localeCompare(b.id));
  // One stored-result read per distinct fixture.
  const abandoned = new Map<string, boolean>();
  const targets: CaptainsReport[] = [];
  for (const r of candidates) {
    const key = `${r.seriesId}#${r.fixtureId}`;
    if (!abandoned.has(key))
      abandoned.set(
        key,
        reports.isAbandonedResult(
          await repo.getFixtureResult(args.tenant, r.seriesId, r.fixtureId),
        ),
      );
    if (abandoned.get(key)) targets.push(r);
  }

  log(
    `${args.confirm ? 'CONFIRM' : 'DRY RUN'} --void-abandoned tenant=${args.tenant} ` +
      `stage=${args.stage} dates=${[...dates].join(',')} pending=${candidates.length} ` +
      `abandoned=${targets.length}`,
  );
  for (const r of targets)
    log(
      `  [${r.id}] ${r.clubName} v ${r.opponentName} ${r.matchDate} → ${r.recipient.kind} ` +
        `${r.notifiedAt ? 'notified' : 'never notified'} — would void`,
    );

  const dir = args.backupDir ? resolve(args.backupDir) : DEFAULT_BACKUP_DIR;
  await mkdir(dir, { recursive: true });
  const file = join(
    dir,
    `captains-report-void-abandoned-backup-${args.tenant}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await writeFile(
    file,
    JSON.stringify({ tenant: args.tenant, stage: args.stage, reports: targets }, null, 2),
  );
  log(`backup: ${file}`);

  if (!args.confirm) {
    log(`DRY RUN done: ${targets.length} would be voided; nothing written, no notice sent.`);
    return 0;
  }
  let voided = 0;
  for (const r of targets) {
    if (await repo.voidPendingCaptainsReport(args.tenant, r, reports.ABANDONED_VOID_REASON)) {
      voided++;
      log(`  [${r.id}] voided`);
    } else log(`  [${r.id}] no longer pending — left alone`);
  }
  log(`done: voided=${voided} left=${targets.length - voided}; no notice sent`);
  return 0;
}

// ───────────────────────── --send ─────────────────────────

/** --send identifies reports by report id, or by old CR number via the --reset backup file. */
async function resolveSendIds(args: ResetArgs, log: (l: string) => void) {
  const crs = args.refs.filter((x) => /^CR-\d{4}-\d+$/.test(x));
  const ids = args.refs.filter((x) => !crs.includes(x));
  if (!crs.length) return ids;
  if (!args.backup) {
    log(
      'ERROR --send with CR numbers needs --backup=<the --reset backup file> (or pass report ids)',
    );
    return null;
  }
  const saved = JSON.parse(await readFile(resolve(args.backup), 'utf8')) as {
    reports: CaptainsReport[];
  };
  for (const cr of crs) {
    const hit = saved.reports.find((r) => r.ref === cr);
    if (!hit) {
      log(`ERROR ${cr} not in ${args.backup}`);
      return null;
    }
    ids.push(hit.id);
  }
  return ids;
}

export async function runSend(
  args: ResetArgs,
  repo: RepoModule,
  reports: ReportsModule,
  linkBase: string,
  dryRun: Record<string, boolean>,
  log: (l: string) => void = console.log,
): Promise<number> {
  const config = await repo.getTenantConfig(args.tenant);
  if (!config) {
    log(`tenant "${args.tenant}" not found`);
    return 1;
  }
  const { hasFeature } = await import('../src/features.js');
  const { chairContactOf } = await import('../src/club-contacts.js');
  const channels = hasFeature(config, 'whatsappInvites', true) ? ['email', 'whatsapp'] : ['email'];
  const usedDryRun = Object.fromEntries(channels.map((c) => [c, !!dryRun[c]]));
  if (args.confirm) {
    const refusals = confirmRefusals(linkBase, usedDryRun);
    if (refusals.length) {
      for (const r of refusals) log(`REFUSED --confirm: ${r}`);
      return 1;
    }
  }
  const ids = await resolveSendIds(args, log);
  if (!ids) return 1;

  const targets: CaptainsReport[] = [];
  for (const id of ids) {
    const key = reports.parseCaptainsReportId(id);
    const r = key
      ? await repo.getCaptainsReport(args.tenant, key.seriesId, key.fixtureId, key.clubId)
      : null;
    const why = !key
      ? 'not a report id'
      : !r
        ? 'not found'
        : r.status !== 'pending'
          ? `status is ${r.status}, not pending`
          : r.source !== 'auto'
            ? `source is ${r.source}, not auto`
            : r.notifiedAt
              ? `already notified at ${r.notifiedAt}`
              : null;
    if (why) {
      log(`ERROR ${id}: ${why} — nothing sent`);
      return 1;
    }
    targets.push(r!);
  }

  log(
    `${args.confirm ? 'CONFIRM' : 'DRY RUN'} --send tenant=${args.tenant} stage=${args.stage} ` +
      `link-base=${linkBase} channels: ${channels.map((c) => `${c}=${usedDryRun[c] ? 'DRY' : 'live'}`).join(' ')}`,
  );
  for (const r of targets) {
    const club = await repo.getClub(args.tenant, r.clubId);
    const chair = club ? chairContactOf(club) : null;
    log(
      `  [${r.id}] ${r.clubName} v ${r.opponentName} ${r.matchDate} → ${r.recipient.kind} ` +
        `${chair ? chairLine(chair) : '(club not found)'}` +
        `${chair && !reports.hasContact(chair) ? ' — NO CONTACT: notice would be lost for good' : ''}`,
    );
  }
  if (!args.confirm) {
    log('DRY RUN done: nothing sent. Re-run with --confirm to notify.');
    return 0;
  }

  let failed = 0;
  reports.setReportNoticeWindowOverride(() => true);
  try {
    for (const r of targets) {
      try {
        const outcome = await reports.openReportsForFixture(
          {
            tenant: args.tenant,
            seriesId: r.seriesId,
            fixtureId: r.fixtureId,
            result: null,
            config,
            sides: [r.side],
          },
          { repo, log, linkBase: () => linkBase },
        );
        if (outcome.skipped) log(`  [${r.id}] skipped: ${outcome.skipped}`);
      } catch (err) {
        failed++;
        log(`  [${r.id}] FAILED: ${err instanceof Error ? err.message : err}`);
      }
      const after = await repo.getCaptainsReport(args.tenant, r.seriesId, r.fixtureId, r.clubId);
      log(`  [${r.id}] recipient=${after?.recipient.kind} ${after?.recipient.name ?? ''}`);
      log(`    notifiedAt=${after?.notifiedAt ?? '(unset — NOT delivered)'}`);
      for (const d of after?.deliveries ?? [])
        log(`    delivery ${d.channel}: ${d.status}${d.reason ? ` (${d.reason})` : ''} at ${d.at}`);
      if (!after?.notifiedAt) failed++;
    }
  } finally {
    reports.setReportNoticeWindowOverride(undefined);
  }
  log(`done: sent=${targets.length - failed} failed=${failed}`);
  return failed ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  let args: ResetArgs;
  try {
    args = parseResetArgs(argv);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : err}\n${USAGE}`);
    return 1;
  }
  const actual = sstStage();
  if (actual !== args.stage) {
    console.error(`REFUSED: --stage=${args.stage} but sst shell stage is ${actual ?? '(none)'}`);
    return 1;
  }
  if (args.mode === 'reset' || args.mode === 'void-abandoned') {
    // NO notify bootstrap: the notify modules load dry-run, so nothing can go out.
    const [repo, reports] = await Promise.all([
      import('../src/repo.js'),
      import('../src/captains-reports.js'),
    ]);
    return args.mode === 'reset'
      ? runReset(args, repo, reports)
      : runVoidAbandoned(args, repo, reports);
  }
  // FIRST: notify env from the SST secrets, before any notify module can load.
  const filled = bootstrapNotifyEnvFromSst();
  if (filled.length) console.log(`notify env from SST secrets: ${filled.join(', ')}`);
  const linkBase = resolveLinkBase(args.linkBase) ?? 'http://localhost:5173';
  process.env.CAPTAINS_REPORT_LINK_BASE_URL = linkBase;
  const [repo, reports, { EMAIL_DRY_RUN }, { WHATSAPP_DRY_RUN }] = await Promise.all([
    import('../src/repo.js'),
    import('../src/captains-reports.js'),
    import('../src/notify/email.js'),
    import('../src/notify/whatsapp.js'),
  ]);
  return runSend(args, repo, reports, linkBase, {
    email: EMAIL_DRY_RUN,
    whatsapp: WHATSAPP_DRY_RUN,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((status) => process.exit(status))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

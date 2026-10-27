/**
 * One-off backfill: open the captain's reports (and send the chair notices) for every fixture
 * played on the given dates that never got one — the 10–11 Oct 2026 weekend, where no
 * medicoach result arrived so nothing opened. A thin invocation of `openMatchDayReports` (the
 * same code path the 18:00 sync run uses), with the 18:00 window forced open.
 *
 * Untouchable by construction: a side with ANY report row (portal-filed, submitted, void,
 * already notified) is left alone; the NOTIFY# per-recipient ledger stops a second send.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/backfill-captains-report-notices.ts \
 *     --tenant=dolphins --dates=2026-10-10,2026-10-11                 (dry-run: prints the plan)
 *   … --confirm                                                       (opens + notifies)
 *   … --series=<id,id>   (only these series)   … --backup-dir=<dir>   (default packages/api/)
 *   … --link-base=<https url>   (non-prod: the stage's web URL — prod derives the platform host)
 *
 * ENV ORDER IS LOAD-BEARING: notify/email.ts and notify/whatsapp.ts freeze their dry-run flag
 * at import. `bootstrapNotifyEnvFromSst()` runs first, then every module that can reach them
 * is `await import()`ed — never a top-level import (the 29 Sep 2026 dry-run incident mode).
 *
 * `--confirm` is refused when the link base is localhost (env.ts fallback — links would be
 * dead) or any channel the tenant uses is still dry-run (a dry "send" completes the NOTIFY#
 * claim, so the real notice could never go). A chair with no email/cell gets an
 * 'undelivered' notice that ALSO completes the claim for good — the dry run lists them; fix
 * the contacts first.
 *
 * Backup (`--confirm`): `packages/api/captains-report-backfill-backup-<tenant>-<ISO>.json` —
 * every targeted fixture's report rows as read before the run (gitignored by
 * `packages/api/*-backup-*.json`). An audit pre-image, not a rollback: notices cannot be
 * unsent; undo a created report by deleting it by id.
 *
 * Exit status: 1 for a bad/unknown flag, a refused --confirm, or `failed > 0`; else 0.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WILDCARD_WEB_SUFFIX } from '../../../infra/tenants.js';
import { bootstrapNotifyEnvFromSst } from '../src/notify-env-bootstrap.js';
import { sstStage } from '../src/env.js';

/** packages/api — where the backup lands unless `--backup-dir` says otherwise. */
const DEFAULT_BACKUP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE =
  'usage: backfill-captains-report-notices --tenant=<id> --dates=YYYY-MM-DD[,…] ' +
  '[--series=<id,…>] [--confirm] [--backup-dir=<dir>] [--link-base=<url>]';

export interface BackfillArgs {
  tenant: string;
  dates: string[];
  seriesIds?: string[];
  confirm: boolean;
  backupDir?: string;
  linkBase?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (d: string) =>
  DATE_RE.test(d) &&
  !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) &&
  new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const list = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Parse the CLI flags; throws (message = the reason) on anything bad or unknown. Pure. */
export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const out: Partial<BackfillArgs> & { confirm: boolean } = { confirm: false };
  for (const arg of argv) {
    const [flag, ...rest] = arg.split('=');
    const value = rest.join('=');
    if (arg === '--confirm') out.confirm = true;
    else if (arg === '--dry-run') out.confirm = false;
    else if (flag === '--tenant' && value) out.tenant = value;
    else if (flag === '--dates' && value) {
      const dates = list(value);
      const bad = dates.filter((d) => !validDate(d));
      if (bad.length) throw new Error(`--dates: not YYYY-MM-DD: ${bad.join(', ')}`);
      out.dates = dates;
    } else if (flag === '--series' && value) out.seriesIds = list(value);
    else if (flag === '--backup-dir' && value) out.backupDir = value;
    else if (flag === '--link-base' && value) out.linkBase = value;
    else throw new Error(`unknown or empty flag "${arg}"`);
  }
  if (!out.tenant) throw new Error('--tenant is required');
  if (!out.dates?.length) throw new Error('--dates is required');
  return out as BackfillArgs;
}

/** The stage `sst shell` injected (`SST_STAGE`, else `SST_RESOURCE_App.stage`), or null. */
export { sstStage };

/**
 * The captain's-report link base for this run: an explicit `--link-base`, else an env value
 * already set, else — prod only — the platform host (sst.config.ts: `https://platform` + the
 * wildcard suffix; the wildcard is armed in prod). Non-prod stages use their CloudFront URL,
 * which a script cannot derive: pass `--link-base`. Pure over its inputs.
 */
export function resolveLinkBase(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (flag) return flag.replace(/\/+$/, '');
  if (env.CAPTAINS_REPORT_LINK_BASE_URL) return env.CAPTAINS_REPORT_LINK_BASE_URL;
  if (sstStage(env) === 'prod') return `https://platform${WILDCARD_WEB_SUFFIX}`;
  return undefined;
}

/** Why `--confirm` must not run (empty ⇒ proceed). Pure. */
export function confirmRefusals(linkBase: string, dryRun: Record<string, boolean>): string[] {
  const out: string[] = [];
  let host = '';
  try {
    host = new URL(linkBase).hostname;
  } catch {
    out.push(`link base "${linkBase}" is not a URL`);
  }
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost'))
    out.push(
      `link base is ${linkBase} — the links would be dead (pass --link-base / run in sst shell)`,
    );
  for (const [channel, dry] of Object.entries(dryRun))
    if (dry) out.push(`${channel} is in notify dry-run — a dry send completes the NOTIFY# claim`);
  return out;
}

type RepoModule = typeof import('../src/repo.js');
type ReportsModule = typeof import('../src/captains-reports.js');

export interface BackfillDeps {
  repo: RepoModule;
  reports: ReportsModule;
  /** Channel → still dry-run (the notify modules' frozen flags). */
  dryRun: Record<string, boolean>;
  linkBase: string;
  log?: (line: string) => void;
  now?: () => Date;
  /** Passed through to the opener (tests). */
  sendNotice?: import('../src/captains-reports.js').CaptainsReportDeps['sendNotice'];
  linkSecret?: () => string;
}

/** Run the backfill (dry-run prints only). Returns the exit status. */
export async function runBackfill(args: BackfillArgs, deps: BackfillDeps): Promise<number> {
  const { repo, reports } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const now = deps.now ?? (() => new Date());
  const config = await repo.getTenantConfig(args.tenant);
  if (!config) {
    log(`tenant "${args.tenant}" not found`);
    return 1;
  }
  const { hasFeature } = await import('../src/features.js');
  const { chairContactOf } = await import('../src/club-contacts.js');
  const { projectSeriesForClub } = await import('../src/series-projection.js');
  const { tenantDate } = await import('../src/tenant-time.js');
  const { isSlotRef } = await import('../../engine/src/formats.js');

  const channels = hasFeature(config, 'whatsappInvites', true) ? ['email', 'whatsapp'] : ['email'];
  const usedDryRun = Object.fromEntries(channels.map((c) => [c, !!deps.dryRun[c]]));
  if (args.confirm) {
    const refusals = confirmRefusals(deps.linkBase, usedDryRun);
    if (refusals.length) {
      for (const r of refusals) log(`REFUSED --confirm: ${r}`);
      return 1;
    }
  }

  const goLive = config.integrations?.medicoach?.goLiveDate;
  const today = tenantDate(now());
  const dates = new Set(args.dates);
  const only = args.seriesIds ? new Set(args.seriesIds) : null;
  const series = (await repo.listSeries(args.tenant)).filter(
    (s) => (!only || only.has(s.id)) && projectSeriesForClub(s, today) !== null,
  );
  const expiry = (date: string) =>
    reports.fmtExpiry(reports.reportLinkExpiry(date, now().getTime()));

  log(
    `${args.confirm ? 'CONFIRM' : 'DRY RUN'} tenant=${args.tenant} dates=${args.dates.join(',')} ` +
      `series=${series.length} link-base=${deps.linkBase} goLive=${goLive ?? '(unset — nothing opens)'} ` +
      `dry-run channels: ${channels.map((c) => `${c}=${usedDryRun[c] ? 'DRY' : 'live'}`).join(' ')}`,
  );
  const backup: Array<{ seriesId: string; fixtureId: string; reports: unknown[] }> = [];
  let wouldOpen = 0;
  for (const s of series) {
    const byTeam = new Map((s.participants ?? []).map((p) => [p.teamId, p]));
    for (const f of (s.fixtures as Array<Record<string, unknown>> | undefined) ?? []) {
      const date = typeof f?.date === 'string' ? f.date : '';
      if (!f?.id || !dates.has(date)) continue;
      const fixtureId = String(f.id);
      const rows = await repo.listCaptainsReportsForFixture(args.tenant, s.id, fixtureId);
      backup.push({ seriesId: s.id, fixtureId, reports: rows });
      const stored = await repo.getFixtureResult(args.tenant, s.id, fixtureId);
      const result = !stored
        ? 'no result'
        : stored.cleared
          ? 'result CLEARED'
          : `result "${stored.summary ?? '(no summary)'}"`;
      const status = `status=${String(f.status ?? 'scheduled')}${f.dateTbc === true ? ' dateTbc' : ''}`;
      log(`${date} ${s.name ?? s.id} [${s.id}/${fixtureId}] ${status}; ${result}`);
      if (f.dateTbc === true || f.status === 'cancelled') {
        log('    skipped (undated postponement / cancelled)');
        continue;
      }
      if (!goLive || date < goLive) {
        log('    skipped (before the tenant go-live date)');
        continue;
      }
      for (const side of ['home', 'away'] as const) {
        const teamId = f[side];
        if (typeof teamId !== 'string' || !teamId || isSlotRef(teamId)) {
          log(`    ${side}: no team (slot) — skipped`);
          continue;
        }
        const clubId = byTeam.get(teamId)?.clubId ?? teamId;
        const row = rows.find((r) => r.clubId === clubId);
        const club = await repo.getClub(args.tenant, clubId);
        const chair = club ? chairContactOf(club) : null;
        const contact = chair
          ? `chair email=${chair.email ? 'yes' : 'NO'} cell=${chair.cell ? 'yes' : 'NO'}${
              reports.hasContact(chair) ? '' : ' — NO CONTACT: notice would be lost for good'
            }`
          : 'club NOT FOUND — skipped';
        const name = club?.name ?? clubId;
        if (row && !reports.noticeUnsettled(row)) {
          log(
            `    ${side} ${name}: report ${row.status}/${row.source}/${row.recipient.kind}` +
              `${row.notifiedAt ? ' notified' : ''} → left alone`,
          );
        } else if (row) {
          log(
            `    ${side} ${name}: pending, notice never went out → would retry notice; ${contact}`,
          );
          wouldOpen++;
        } else if (club) {
          log(
            `    ${side} ${name}: would open + notify chair (link expires ${expiry(date)}); ${contact}`,
          );
          wouldOpen++;
        } else log(`    ${side} ${name}: ${contact}`);
      }
    }
  }
  if (!args.confirm) {
    log(`DRY RUN done: ${wouldOpen} side(s) would open/notify. Re-run with --confirm to send.`);
    return 0;
  }

  const dir = args.backupDir ? resolve(args.backupDir) : DEFAULT_BACKUP_DIR;
  await mkdir(dir, { recursive: true });
  const file = join(
    dir,
    `captains-report-backfill-backup-${args.tenant}-${now().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await writeFile(
    file,
    JSON.stringify({ tenant: args.tenant, dates: args.dates, backup }, null, 2),
  );
  log(`backup: ${file}`);

  // The backfill sends outside 18:00 on purpose.
  reports.setReportNoticeWindowOverride(() => true);
  try {
    const sum = await reports.openMatchDayReports(
      args.tenant,
      config,
      {
        repo,
        log,
        linkBase: () => deps.linkBase,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.sendNotice ? { sendNotice: deps.sendNotice } : {}),
        ...(deps.linkSecret ? { linkSecret: deps.linkSecret } : {}),
      },
      { targetDates: args.dates, ...(args.seriesIds ? { seriesIds: args.seriesIds } : {}) },
    );
    log(
      `done: fixtures=${sum.fixtures} opened=${sum.opened} notified=${sum.notified} ` +
        `failed=${sum.failed} deferred=${sum.deferred} skipped=${sum.skipped}`,
    );
    return sum.failed > 0 ? 1 : 0;
  } finally {
    reports.setReportNoticeWindowOverride(undefined);
  }
}

export async function main(argv: string[]): Promise<number> {
  let args: BackfillArgs;
  try {
    args = parseBackfillArgs(argv);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : err}\n${USAGE}`);
    return 1;
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
  return runBackfill(args, {
    repo,
    reports,
    linkBase,
    dryRun: { email: EMAIL_DRY_RUN, whatsapp: WHATSAPP_DRY_RUN },
  });
}

// Only run as a CLI — a test imports the helpers / runBackfill directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((status) => process.exit(status))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

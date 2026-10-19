/**
 * One-off: resend pending captain's reports of a match weekend to each side's CAPTAIN.
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/resend-captains-report-notices.ts \
 *     --stage=<stage> [--tenant=dolphins] --dates=2026-10-17,2026-10-18 \
 *     [--series=<id>,…] [--only=<report id>,…] [--allow-chair-fallback] \
 *     [--backup-dir=<dir>] [--link-base=<url>] [--confirm]
 *
 * Selection: one Query of the tenant's CAPREPORT partition (no scan) → pending, source=auto,
 * matchDate in --dates (+ --series / --only). A report is skipped as already handled only when
 * its CURRENT recipient (memberId) was actually reached: the NOTIFY# slot for that memberId is
 * completed AND a `sent` delivery was recorded after the slot was claimed. A captain recipient
 * reached that way is done; a chair recipient only counts when reached today (SAST) — i.e. a
 * chair fallback of an earlier run of this script. A re-address whose send failed on every
 * channel released its slot, so a re-run re-notifies it.
 *
 * Captain: `resolveClubCaptain` over the same reports list, one `listPlayers` per club and one
 * `listFixtureScorecards` (playedBefore evidence). Unresolved → skipped with the reason, or with
 * --allow-chair-fallback a fresh chair recipient. The dry run (always printed) and a JSON
 * backup of every selected item (dry run too) come first.
 *
 * --confirm (refused when the link base is local or any channel is notify dry-run): per report
 * `readdressCaptainsReport` (fresh memberId ⇒ new link, new NOTIFY# slot; never bumps
 * forwardCount; clears reminderSentAt; refreshes an expired linkExpiresAt), then the send path
 * of reset-captains-reports --send: `openReportsForFixture` with `result: null` for that side,
 * the 18:00 window forced open. The chair's old link is kept (`chairMemberId`) when the chair
 * was the recipient. `notifiedAt` is first-send-only (if_not_exists), so success is judged on
 * the deliveries recorded after the re-address.
 *
 * Exit status: 1 for a bad flag, a stage mismatch, a refused --confirm, a conflict or a failed
 * notice; else 0.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CaptainLookup } from '../src/captain-lookup.js';
import type { CaptainsReport, Club, PlayerRegistration } from '../src/types.js';
import { bootstrapNotifyEnvFromSst } from '../src/notify-env-bootstrap.js';
import { confirmRefusals, resolveLinkBase, sstStage } from './backfill-captains-report-notices.js';

const DEFAULT_BACKUP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE =
  'usage: resend-captains-report-notices --stage=<stage> [--tenant=<id>] --dates=<YYYY-MM-DD,…> ' +
  '[--series=<id>,…] [--only=<report id>,…] [--exclude=<report id>,…] [--allow-chair-fallback] ' +
  '[--backup-dir=<dir>] [--link-base=<url>] [--confirm]';

export interface ResendArgs {
  stage: string;
  tenant: string;
  dates: string[];
  seriesIds?: string[];
  only?: string[];
  exclude?: string[];
  allowChairFallback: boolean;
  confirm: boolean;
  backupDir?: string;
  linkBase?: string;
}

const list = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const validDate = (d: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

/** Parse the CLI flags; throws (message = the reason) on anything bad or unknown. Pure. */
export function parseResendArgs(argv: string[]): ResendArgs {
  const out: Partial<ResendArgs> & {
    confirm: boolean;
    tenant: string;
    allowChairFallback: boolean;
  } = { confirm: false, tenant: 'dolphins', allowChairFallback: false };
  for (const arg of argv) {
    const [flag, ...rest] = arg.split('=');
    const value = rest.join('=').trim();
    if (arg === '--confirm') out.confirm = true;
    else if (arg === '--dry-run') out.confirm = false;
    else if (arg === '--allow-chair-fallback') out.allowChairFallback = true;
    else if (flag === '--stage' && value) out.stage = value;
    else if (flag === '--tenant' && value) out.tenant = value;
    else if (flag === '--dates' && value) {
      const dates = list(value);
      const bad = dates.filter((d) => !validDate(d));
      if (bad.length) throw new Error(`--dates: not YYYY-MM-DD: ${bad.join(', ')}`);
      out.dates = dates;
    } else if (flag === '--series' && value) out.seriesIds = list(value);
    else if (flag === '--only' && value) out.only = list(value);
    else if (flag === '--exclude' && value) out.exclude = list(value);
    else if (flag === '--backup-dir' && value) out.backupDir = value;
    else if (flag === '--link-base' && value) out.linkBase = value;
    else throw new Error(`unknown or empty flag "${arg}"`);
  }
  if (!out.stage) throw new Error('--stage is required');
  if (!out.dates?.length) throw new Error('--dates is required');
  return out as ResendArgs;
}

type RepoModule = typeof import('../src/repo.js');
type ReportsModule = typeof import('../src/captains-reports.js');

const chairLine = (c: { name: string; email?: string; cell?: string }) =>
  `${c.name || '(no name)'} email=${c.email || '(none)'} cell=${c.cell || '(none)'}`;

const channelsOf = (c: { email?: string; cell?: string }) =>
  [c.email ? 'email' : null, c.cell ? 'whatsapp' : null].filter(Boolean).join('+') || 'NONE';

interface Plan {
  report: CaptainsReport;
  kind: 'captain' | 'chair';
  lookup: CaptainLookup;
  contact: { name: string; email?: string; cell?: string };
}

export interface ResendOptions {
  now?: () => Date;
}

export async function runResend(
  args: ResendArgs,
  repo: RepoModule,
  reports: ReportsModule,
  linkBase: string,
  dryRun: Record<string, boolean>,
  log: (l: string) => void = console.log,
  opts: ResendOptions = {},
): Promise<number> {
  const now = opts.now ?? (() => new Date());
  const config = await repo.getTenantConfig(args.tenant);
  if (!config) {
    log(`tenant "${args.tenant}" not found`);
    return 1;
  }
  const { hasFeature } = await import('../src/features.js');
  const { chairContactOf } = await import('../src/club-contacts.js');
  const { resolveClubCaptain } = await import('../src/captain-lookup.js');
  const { TENANT_UTC_OFFSET_MINUTES } = await import('../src/tenant-time.js');
  const channels = hasFeature(config, 'whatsappInvites', true) ? ['email', 'whatsapp'] : ['email'];
  const usedDryRun = Object.fromEntries(channels.map((c) => [c, !!dryRun[c]]));
  if (args.confirm) {
    const refusals = confirmRefusals(linkBase, usedDryRun);
    if (refusals.length) {
      for (const r of refusals) log(`REFUSED --confirm: ${r}`);
      return 1;
    }
  }
  const sastDay = (ms: number) =>
    new Date(ms + TENANT_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
  const today = sastDay(now().getTime());

  // One Query of the single CAPREPORT partition — also the captain-history source.
  const all = await repo.listCaptainsReports(args.tenant);
  const dates = new Set(args.dates);
  const selected = all
    .filter(
      (r) =>
        r.status === 'pending' &&
        r.source === 'auto' &&
        dates.has(r.matchDate) &&
        (!args.seriesIds?.length || args.seriesIds.includes(r.seriesId)),
    )
    .sort((a, b) => a.matchDate.localeCompare(b.matchDate) || a.id.localeCompare(b.id));

  log(
    `${args.confirm ? 'CONFIRM' : 'DRY RUN'} resend tenant=${args.tenant} stage=${args.stage} ` +
      `dates=${args.dates.join(',')} series=${args.seriesIds?.join(',') ?? '(all)'} ` +
      `chair-fallback=${args.allowChairFallback ? 'on' : 'off'} link-base=${linkBase} ` +
      `channels: ${channels.map((c) => `${c}=${usedDryRun[c] ? 'DRY' : 'live'}`).join(' ')}`,
  );

  const skipped: Array<{ id: string; why: string }> = [];
  const targets: CaptainsReport[] = [];
  for (const r of selected) {
    if (args.only?.length && !args.only.includes(r.id)) {
      skipped.push({ id: r.id, why: 'not in --only' });
      continue;
    }
    if (args.exclude?.includes(r.id)) {
      skipped.push({ id: r.id, why: 'in --exclude' });
      continue;
    }
    const slot = await repo.getCaptainsReportNotify(
      args.tenant,
      r.id,
      `recipient#${r.recipient.memberId}`,
    );
    const sentForCurrent =
      slot?.status === 'completed'
        ? (r.deliveries ?? []).filter(
            (d) =>
              d.status === 'sent' &&
              d.purpose !== 'reminder' &&
              (!slot.startedAt || d.at >= slot.startedAt),
          )
        : [];
    if (slot?.status === 'in_progress') {
      skipped.push({ id: r.id, why: `NOTIFY# claim for the current recipient is in progress` });
      continue;
    }
    if (sentForCurrent.length && r.recipient.kind === 'captain') {
      skipped.push({ id: r.id, why: `already sent to captain ${r.recipient.name}` });
      continue;
    }
    if (sentForCurrent.some((d) => sastDay(Date.parse(d.at)) === today)) {
      skipped.push({ id: r.id, why: `already sent to the ${r.recipient.kind} today` });
      continue;
    }
    targets.push(r);
  }
  for (const id of args.only ?? [])
    if (!selected.some((r) => r.id === id))
      skipped.push({ id, why: 'not a pending auto report on those dates' });

  // Fetched once per run and handed to the lookup.
  const scorecards = await repo.listFixtureScorecards(args.tenant);
  const availability = await repo.getFixtureScorecardAvailability(
    args.tenant,
    targets.map((r) => ({ seriesId: r.seriesId, fixtureId: r.fixtureId })),
  );
  const clubs = new Map<string, Club | null>();
  const rosters = new Map<string, PlayerRegistration[]>();
  for (const r of targets) {
    if (!clubs.has(r.clubId)) clubs.set(r.clubId, await repo.getClub(args.tenant, r.clubId));
    if (!rosters.has(r.clubId))
      rosters.set(r.clubId, await repo.listPlayers(args.tenant, r.clubId));
  }

  const plans: Plan[] = [];
  const unresolved: string[] = [];
  const nowMs = now().getTime();
  for (const r of targets) {
    const club = clubs.get(r.clubId) ?? null;
    if (!club) {
      skipped.push({ id: r.id, why: 'club not found' });
      unresolved.push(`  [${r.id}] ${r.clubName}: club not found — skipped`);
      continue;
    }
    const lookup = await resolveClubCaptain(
      { reports: all, roster: rosters.get(r.clubId) ?? [], scorecards },
      args.tenant,
      r.clubId,
      {
        seriesId: r.seriesId,
        competition: r.competition,
        clubNames: [...new Set([club.name, r.clubName].filter(Boolean))],
      },
    );
    const chair = chairContactOf(club);
    const expired = reports.reportExpirySeconds(r) * 1000 <= nowMs;
    const src = lookup.fromReport;
    log(
      `  [${r.id}] ${r.clubName} v ${r.opponentName} ${r.matchDate} (${r.side}) ` +
        `competition="${r.competition}"`,
    );
    log(`    old recipient: ${r.recipient.kind} ${r.recipient.name || '(no name)'}`);
    log(
      `    source report: ${src ? `${src.ref ?? '(no ref)'} submittedAt=${src.submittedAt ?? '?'} competition="${src.competition}"` : '(none)'}` +
        ` | target competition="${r.competition}"` +
        `${src && src.competition !== r.competition ? '  <<< DIFFERENT COMPETITION' : ''}`,
    );
    log(
      `    captain: "${lookup.captainName || '-'}" playedBefore=${lookup.playedBefore ?? '-'} ` +
        `initialOnly=${lookup.initialOnly ? 'YES' : 'no'}` +
        `${lookup.reason ? ` reason=${lookup.reason}` : ''}`,
    );
    log(
      `    scorecard attached: ${availability.get(`${r.seriesId}#${r.fixtureId}`)?.available ? 'y' : 'n'}` +
        ` | linkExpiresAt=${r.linkExpiresAt ?? '(unset)'} refresh=${expired ? 'YES' : 'no'}`,
    );
    const prior = (r.deliveries ?? []).map(
      (d) =>
        `${d.channel}:${d.status}${d.reason ? `(${d.reason})` : ''}/${d.purpose}/${d.recipientKind}@${d.at}`,
    );
    log(`    prior deliveries: ${prior.length ? prior.join(' ') : '(none)'}`);
    if (lookup.match) {
      plans.push({ report: r, kind: 'captain', lookup, contact: lookup.match });
      log(`    PLAN → captain ${chairLine(lookup.match)} channels=${channelsOf(lookup.match)}`);
    } else if (args.allowChairFallback) {
      plans.push({ report: r, kind: 'chair', lookup, contact: chair });
      const lost = reports.hasContact(chair) ? '' : ' — NO CONTACT: notice would be lost';
      log(`    PLAN → FALLBACK chair ${chairLine(chair)} channels=${channelsOf(chair)}${lost}`);
      unresolved.push(
        `  [${r.id}] ${r.clubName} (${lookup.reason}): FALLBACK → chair ${chairLine(chair)}`,
      );
    } else {
      skipped.push({ id: r.id, why: `captain unresolved (${lookup.reason})` });
      log(`    PLAN → skip: captain unresolved (${lookup.reason}); --allow-chair-fallback to send`);
      unresolved.push(
        `  [${r.id}] ${r.clubName} (${lookup.reason}): UNRESOLVED — chair would be ${chairLine(chair)}`,
      );
    }
  }

  log('');
  log(`skipped (${skipped.length}):`);
  for (const s of skipped) log(`  [${s.id}] ${s.why}`);
  log('');
  log(`===== UNRESOLVED / FALLBACK (${unresolved.length}) =====`);
  for (const u of unresolved) log(u);
  log('==========================================');

  const dir = args.backupDir ? resolve(args.backupDir) : DEFAULT_BACKUP_DIR;
  await mkdir(dir, { recursive: true });
  const file = join(
    dir,
    `captains-report-resend-backup-${args.tenant}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await writeFile(
    file,
    JSON.stringify({ tenant: args.tenant, stage: args.stage, reports: selected }, null, 2),
  );
  log(`backup: ${file}`);

  if (!args.confirm) {
    log(`DRY RUN done: ${plans.length} planned, nothing written, no notice sent.`);
    return 0;
  }

  let failed = 0;
  let sent = 0;
  reports.setReportNoticeWindowOverride(() => true);
  try {
    for (const p of plans) {
      const r = p.report;
      const chairMemberId = r.recipient.kind === 'chair' ? r.recipient.memberId : r.chairMemberId;
      const expired = reports.reportExpirySeconds(r) * 1000 <= now().getTime();
      const linkExpiresAt = expired
        ? new Date(reports.reportLinkExpiry(r.matchDate, now().getTime()) * 1000).toISOString()
        : undefined;
      const memberId = randomUUID();
      let readdressed: CaptainsReport;
      try {
        readdressed = await repo.readdressCaptainsReport(
          args.tenant,
          r,
          {
            recipient: { kind: p.kind, memberId, name: p.contact.name },
            ...(p.kind === 'captain'
              ? {
                  recipientContact: {
                    ...(p.contact.email ? { email: p.contact.email } : {}),
                    ...(p.contact.cell ? { cell: p.contact.cell } : {}),
                  },
                  captainName: p.lookup.match!.name,
                }
              : {}),
            ...(chairMemberId ? { chairMemberId } : {}),
            ...(linkExpiresAt ? { linkExpiresAt } : {}),
          },
          { expectedMemberId: r.recipient.memberId },
        );
      } catch (err) {
        if (!(err instanceof repo.CaptainsReportForwardConflict)) throw err;
        failed++;
        const fresh = await repo.getCaptainsReport(args.tenant, r.seriesId, r.fixtureId, r.clubId);
        log(
          `  [${r.id}] CONFLICT — changed meanwhile, skipped: status=${fresh?.status ?? 'missing'} ` +
            `recipient=${fresh?.recipient.kind ?? '-'} ${fresh?.recipient.name ?? ''}`,
        );
        continue;
      }
      const before = readdressed.deliveries?.length ?? 0;
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
        log(`  [${r.id}] FAILED: ${err instanceof Error ? err.message : err}`);
      }
      const after = await repo.getCaptainsReport(args.tenant, r.seriesId, r.fixtureId, r.clubId);
      const fresh = (after?.deliveries ?? []).slice(before);
      const ok = after?.recipient.memberId === memberId && fresh.some((d) => d.status === 'sent');
      log(
        `  [${r.id}] ${ok ? 'SENT' : 'NOT DELIVERED'} recipient=${after?.recipient.kind} ` +
          `${after?.recipient.name ?? ''} memberId ${after?.recipient.memberId === memberId ? 'new' : 'UNEXPECTED'}`,
      );
      log(`    notifiedAt=${after?.notifiedAt ?? '(unset)'} (first send only)`);
      for (const d of fresh)
        log(`    delivery ${d.channel}: ${d.status}${d.reason ? ` (${d.reason})` : ''} at ${d.at}`);
      if (ok) sent++;
      else failed++;
    }
  } finally {
    reports.setReportNoticeWindowOverride(undefined);
  }
  log(`done: sent=${sent} failed=${failed}`);
  return failed ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  let args: ResendArgs;
  try {
    args = parseResendArgs(argv);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : err}\n${USAGE}`);
    return 1;
  }
  const actual = sstStage();
  if (actual !== args.stage) {
    console.error(`REFUSED: --stage=${args.stage} but sst shell stage is ${actual ?? '(none)'}`);
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
  return runResend(args, repo, reports, linkBase, {
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

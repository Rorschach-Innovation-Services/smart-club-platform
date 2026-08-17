/**
 * Recall accidentally-released fixture series back to draft (dolphins tenant):
 *
 *   npx sst shell --stage prod -- npm --prefix packages/api run recall-release              # dry-run
 *   npx sst shell --stage prod -- npm --prefix packages/api run recall-release -- --confirm
 *   … -- --since 2026-08-17T00:00:00Z [--confirm]   # override the cutoff
 *
 * The 16 Aug 2026 amendment import landed its 13 new series as DRAFTS for review, but
 * an admin released them before the review happened. This recalls every `s-planb-*`
 * series whose server-stamped `releasedAt` is AFTER the import finished — exactly the
 * post-import releases — writing `released: false, releasedAt: null` (the same
 * single-field recall the console's "Recall draft" button performs; `approved` is
 * deliberately left as-is so re-releasing after review is one click). Series released
 * BEFORE the import (the long-live 50-over/30-over schedules clubs already use) are
 * listed but never touched.
 *
 * Recalling hides the fixtures from club portals immediately. It cannot un-send any
 * release notifications (email/WhatsApp) the accidental release may have triggered.
 */
import * as repo from './repo.js';

const TENANT = 'dolphins';
const ID_PREFIX = 's-planb-';
/** When the 16 Aug 2026 import finished writing (from its backup filename stamp). */
const DEFAULT_SINCE = '2026-08-16T21:14:21Z';

function parseArgs(argv: string[]) {
  const args = { confirm: false, since: DEFAULT_SINCE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') args.confirm = true;
    else if (a === '--since') args.since = argv[++i] ?? '';
    else throw new Error(`unknown flag ${a}`);
  }
  if (Number.isNaN(Date.parse(args.since)))
    throw new Error(`--since must be an ISO timestamp, got "${args.since}"`);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cutoff = Date.parse(args.since);

  const all = await repo.listSeries(TENANT);
  const released = all
    .filter((s) => String(s.id).startsWith(ID_PREFIX) && s.released)
    .sort((a, b) => String(a.releasedAt ?? '').localeCompare(String(b.releasedAt ?? '')));

  if (!released.length) {
    console.log('No released s-planb-* series found — nothing to recall.');
    return;
  }

  const toRecall: typeof released = [];
  console.log(`Released s-planb-* series (cutoff: releasedAt > ${args.since}):\n`);
  for (const s of released) {
    const at = s.releasedAt ? String(s.releasedAt) : '(no timestamp)';
    const after = s.releasedAt ? Date.parse(String(s.releasedAt)) > cutoff : false;
    if (after) {
      toRecall.push(s);
      console.log(`  RECALL  ${s.id}  released ${at}  (${s.name})`);
    } else {
      console.log(`  keep    ${s.id}  released ${at}  (${s.name}) — pre-import release, untouched`);
    }
  }

  if (!toRecall.length) {
    console.log('\nNothing released after the cutoff — nothing to recall.');
    return;
  }
  console.log(
    `\n${toRecall.length} series to recall to draft (clubs stop seeing them immediately; any release notifications already sent cannot be recalled).`,
  );
  if (!args.confirm) {
    console.log('[dry-run] nothing written. Re-run with --confirm to recall.');
    return;
  }

  for (const s of toRecall) {
    await repo.updateSeries(TENANT, String(s.id), {
      released: false,
      releasedAt: null,
      version: s.version,
    });
    console.log(`recalled ${s.id} → draft`);
  }
  console.log('Done. Review in the console, then approve + release each series as normal.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

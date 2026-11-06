/**
 * One-off: send "upload your ID document" doc-requests (email + WhatsApp) to the players listed
 * in a "missing valid ID" workbook, after matching them against the tenant's player register.
 * Mirrors the per-player pipeline of `POST /admin/doc-requests` (index.ts) as a CLI, since the
 * route needs a Cognito admin JWT. DRY-RUN by default:
 *
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run request-id-docs -- \
 *     --tenant dolphins --file "<xlsx>"              # dry run: match + plan report, nothing sent
 *   … --tenant dolphins --file "<xlsx>" --confirm    # real sends
 *
 * Optional: --requested-by <email> (requestedBy / comm-log `by`; default carlton42@mailbox.org),
 * --idempotency-key <key> (default sheet-missing-id-nov2026; /^[A-Za-z0-9_-]{8,80}$/),
 * --only "<substring>" (player or club name filter, for a small test batch),
 * --link-origin <https://host> (email link origin; derived from infra/tenants.ts on prod, REQUIRED
 * on any other stage), --email-correction (adds an apology line to the email for the earlier
 * broken link), --channels <csv> (email,whatsapp; default both). A subset run merges into lastSendResults
 * per channel. NOTE: the NOTIFY# claim is per (request, idempotency key), so a WhatsApp-only
 * resend after a run that already sent email needs a NEW --idempotency-key.
 *
 * Sheet "Players", header row 0: `# | Problem | Detail | Player | Club | Team | Status | ID type |
 * ID / passport no. | Uploaded on | File type`. Matching is by normalized ID in the named club,
 * falling back to every club (moved players). Duplicate IDs prefer an 'active' row; still
 * ambiguous ⇒ skipped. A name mismatch only warns — the ID match wins.
 *
 * Idempotent per (request, idempotency key) via the NOTIFY#docreq# ledger: a re-run after a
 * partial failure never re-sends to a player already sent. Reads are targeted (listClubs +
 * listPlayers per club) — no Scans. The workbook holds PII: stdout prints only display names,
 * club names and sheet row numbers — never IDs, keys, contacts, tokens or links.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';
import type {
  Channel,
  Club,
  ClubCommEvent,
  PlayerRegistration,
  SendResult,
  TenantConfig,
} from './types.js';
import { normalizeId } from './player-identity.js';
import { captainsReportLinkSecret, sstStage } from './env.js';
import {
  SHARED_API_CERT_ARN,
  VANITY,
  WILDCARD_WEB_SUFFIX,
  webOriginMap,
  type VanityDomain,
} from '../../../infra/tenants.js';
import {
  WHATSAPP_TEMPLATES,
  type WhatsAppTemplateDefinition,
} from './notify/whatsapp-templates.js';
import { hasFeature } from './features.js';
import { orgCopy } from './branding.js';
import {
  DOC_REQUEST_DOCS,
  DOC_REQUEST_LINK_DAYS,
  aggregateDocRequestStatus,
  docRequestSkipReason,
  fmtDocRequestExpiry,
  signDocRequestLinkToken,
  type DocRequestSendStatus,
} from './doc-requests.js';
import { bootstrapNotifyEnvFromSst } from './notify-env-bootstrap.js';

// ───────────────────────── Sheet parsing ─────────────────────────

export interface SheetRow {
  /** The sheet's `#` column (falls back to the 1-based sheet row). */
  num: string;
  /** 1-based sheet row number. */
  line: number;
  problem: string;
  player: string;
  club: string;
  idNumber: string;
}

const HEADERS = ['#', 'Problem', 'Player', 'Club', 'ID / passport no.'] as const;

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim();

/** Parse the "Players" sheet's rows (header row 0). Rows with no player name are dropped. */
export function parseSheetRows(rows: unknown[][]): SheetRow[] {
  const header = (rows[0] ?? []).map(str);
  const col = (h: string) => {
    const i = header.indexOf(h);
    if (i < 0) throw new Error(`sheet header "${h}" not found`);
    return i;
  };
  const [cNum, cProblem, cPlayer, cClub, cId] = HEADERS.map(col);
  const out: SheetRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const player = str(row[cPlayer]);
    if (!player) continue;
    out.push({
      num: str(row[cNum]) || String(r + 1),
      line: r + 1,
      problem: str(row[cProblem]),
      player,
      club: str(row[cClub]),
      idNumber: str(row[cId]),
    });
  }
  return out;
}

// ───────────────────────── Matching (pure) ─────────────────────────

export type MatchPlayer = Pick<
  PlayerRegistration,
  'naturalKey' | 'clubId' | 'firstName' | 'lastName' | 'idNumber' | 'status'
>;

export type MatchOutcome =
  | {
      kind: 'matched';
      row: SheetRow;
      player: MatchPlayer;
      /** Set when the sheet club matched no DB club. */
      unmatchedClub: boolean;
      /** Set when the player was found at a club other than the sheet's club. */
      movedFromSheetClub: boolean;
      nameMismatch: boolean;
    }
  | { kind: 'ambiguous'; row: SheetRow; unmatchedClub: boolean; candidates: number }
  | { kind: 'not-found'; row: SheetRow; unmatchedClub: boolean };

const tokens = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Loose name check: every token of one name appears in the other (either direction). */
export function namesAgree(sheetName: string, firstName: string, lastName: string): boolean {
  const a = tokens(sheetName);
  const b = tokens(`${firstName ?? ''} ${lastName ?? ''}`);
  if (!a.length || !b.length) return false;
  const bs = new Set(b);
  const as = new Set(a);
  return a.every((t) => bs.has(t)) || b.every((t) => as.has(t));
}

/** Club name key: case-insensitive, trimmed. */
const clubKey = (s: string) => s.trim().toLowerCase();

/** Index each club's players by normalized ID. */
export function indexPlayersById(players: MatchPlayer[]): Map<string, MatchPlayer[]> {
  const idx = new Map<string, MatchPlayer[]>();
  for (const p of players) {
    const id = normalizeId(p.idNumber);
    if (!id) continue;
    const list = idx.get(id) ?? [];
    list.push(p);
    idx.set(id, list);
  }
  return idx;
}

/** Prefer a single candidate, else the single 'active' one; null ⇒ ambiguous. */
function pickCandidate(cands: MatchPlayer[]): MatchPlayer | null {
  if (cands.length === 1) return cands[0];
  const active = cands.filter((p) => (p.status ?? 'active') === 'active');
  return active.length === 1 ? active[0] : null;
}

/**
 * Match sheet rows to players. `playersByClub` holds every tenant club's players (keyed by
 * clubId). The named club is searched first; a miss falls back to every club.
 */
export function matchRows(
  rows: SheetRow[],
  clubs: Array<Pick<Club, 'id' | 'name'>>,
  playersByClub: Map<string, MatchPlayer[]>,
): MatchOutcome[] {
  const clubByName = new Map<string, string>();
  for (const c of clubs) clubByName.set(clubKey(c.name), c.id);
  const indexes = new Map<string, Map<string, MatchPlayer[]>>();
  for (const [clubId, players] of playersByClub) indexes.set(clubId, indexPlayersById(players));

  return rows.map((row): MatchOutcome => {
    const sheetClubId = clubByName.get(clubKey(row.club));
    const unmatchedClub = !sheetClubId;
    const id = normalizeId(row.idNumber);
    if (!id) return { kind: 'not-found', row, unmatchedClub };

    let cands = sheetClubId ? (indexes.get(sheetClubId)?.get(id) ?? []) : [];
    let moved = false;
    if (!cands.length) {
      cands = [];
      for (const [clubId, idx] of indexes) {
        if (clubId === sheetClubId) continue;
        cands.push(...(idx.get(id) ?? []));
      }
      moved = cands.length > 0;
    }
    if (!cands.length) return { kind: 'not-found', row, unmatchedClub };
    const player = pickCandidate(cands);
    if (!player) return { kind: 'ambiguous', row, unmatchedClub, candidates: cands.length };
    return {
      kind: 'matched',
      row,
      player,
      unmatchedClub,
      movedFromSheetClub: moved,
      nameMismatch: !namesAgree(row.player, player.firstName, player.lastName),
    };
  });
}

/** --only filter: substring of the sheet player/club name or the matched club's name. */
export function matchesOnly(o: MatchOutcome, only: string, clubName?: string): boolean {
  const q = only.toLowerCase();
  return [o.row.player, o.row.club, clubName ?? ''].some((s) => s.toLowerCase().includes(q));
}

// ───────────────────────── Channels (pure) ─────────────────────────

const ALL_CHANNELS: Channel[] = ['email', 'whatsapp'];

/** Parse `--channels <csv>` (values email|whatsapp); undefined ⇒ both. */
export function parseChannelsArg(csv: string | undefined): Channel[] {
  if (csv === undefined) return [...ALL_CHANNELS];
  const out: Channel[] = [];
  for (const raw of csv.split(',')) {
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    if (v !== 'email' && v !== 'whatsapp')
      throw new Error(`--channels: unknown channel "${v}" (allowed: email, whatsapp)`);
    if (!out.includes(v)) out.push(v);
  }
  if (!out.length) throw new Error('--channels: no channels given (allowed: email, whatsapp)');
  return out;
}

/**
 * Effective channels = requested ∩ allowed. An explicitly requested WhatsApp leg must be usable
 * (feature on + template ready) — a WhatsApp-only run must never silently become a no-op.
 */
export function resolveChannels(
  requested: Channel[],
  opts: { whatsappOn: boolean; templateReady: boolean },
): Channel[] {
  if (requested.includes('whatsapp')) {
    if (!opts.whatsappOn)
      throw new Error('--channels includes whatsapp but the tenant has whatsappInvites off');
    if (!opts.templateReady)
      throw new Error(
        '--channels includes whatsapp but the player_doc_request template is not ready ' +
          '(playerDocRequestTemplateReady() is false)',
      );
  }
  const allowed: Channel[] = opts.whatsappOn ? ['email', 'whatsapp'] : ['email'];
  const eff = ALL_CHANNELS.filter((c) => requested.includes(c) && allowed.includes(c));
  if (!eff.length) throw new Error('no effective channels — nothing to send');
  return eff;
}

/** Pre-send skip for the effective channel set (wraps docRequestSkipReason). */
export function channelSkipReason(
  player: Pick<PlayerRegistration, 'isMinor' | 'email' | 'cell'>,
  channels: Channel[],
  hasCell: (cell: string | undefined) => boolean,
): DocRequestSendStatus | null {
  const email = channels.includes('email');
  const wa = channels.includes('whatsapp');
  if (email && wa) return docRequestSkipReason(player, true, hasCell);
  // Single channel: blank out the other contact so only the attempted one counts.
  if (wa) return docRequestSkipReason({ ...player, email: undefined }, true, hasCell);
  return docRequestSkipReason({ ...player, cell: undefined }, false, hasCell);
}

/**
 * Merge a subset run's results into the stored ones: entries for the attempted channels are
 * replaced; other channels' previous entries are kept.
 */
export function mergeSendResults(
  prior: SendResult[] | undefined,
  next: SendResult[],
  attempted: Channel[],
): SendResult[] {
  return [...(prior ?? []).filter((r) => !attempted.includes(r.channel)), ...next];
}

// ───────────────────────── Report ─────────────────────────

export interface ReportLine {
  bucket:
    | 'will-send'
    | 'skip'
    | 'moved'
    | 'name-mismatch'
    | 'ambiguous'
    | 'not-found'
    | 'unmatched-club';
  text: string;
}

const rowTag = (r: SheetRow) => `#${r.num} (row ${r.line})`;

/**
 * PII-free report lines for the outcomes. `skipOf` predicts the pre-send skip for a matched
 * player (null = will send). Lines carry only display names, club names and row numbers.
 */
export function buildReport(
  outcomes: MatchOutcome[],
  clubName: (id: string) => string,
  skipOf: (p: MatchPlayer) => DocRequestSendStatus | null,
): { lines: ReportLine[]; unmatchedClubNames: string[] } {
  const lines: ReportLine[] = [];
  const unmatched = new Set<string>();
  for (const o of outcomes) {
    const tag = rowTag(o.row);
    const problem = o.row.problem ? ` [${o.row.problem}]` : '';
    if (o.unmatchedClub) unmatched.add(o.row.club || '(blank)');
    if (o.kind === 'not-found') {
      lines.push({
        bucket: 'not-found',
        text: `${tag} ${o.row.player} @ ${o.row.club}${problem}`,
      });
      continue;
    }
    if (o.kind === 'ambiguous') {
      lines.push({
        bucket: 'ambiguous',
        text: `${tag} ${o.row.player} @ ${o.row.club} — ${o.candidates} candidates, skipped`,
      });
      continue;
    }
    const dbName = `${o.player.firstName ?? ''} ${o.player.lastName ?? ''}`.trim();
    const at = clubName(o.player.clubId);
    if (o.movedFromSheetClub) {
      lines.push({
        bucket: 'moved',
        text: `${tag} ${o.row.player}: sheet "${o.row.club}" → found at ${at}`,
      });
    }
    if (o.nameMismatch) {
      lines.push({
        bucket: 'name-mismatch',
        text: `${tag} sheet "${o.row.player}" vs register "${dbName}" @ ${at} (ID match wins)`,
      });
    }
    const skip = skipOf(o.player);
    lines.push(
      skip
        ? { bucket: 'skip', text: `${tag} ${dbName} @ ${at} — ${skip}` }
        : { bucket: 'will-send', text: `${tag} ${dbName} @ ${at}${problem}` },
    );
  }
  return { lines, unmatchedClubNames: [...unmatched].sort() };
}

const BUCKET_TITLES: Record<ReportLine['bucket'], string> = {
  'will-send': 'Will send',
  skip: 'Predicted skips',
  moved: 'Found at another club',
  'name-mismatch': 'Name mismatch warnings',
  ambiguous: 'Ambiguous — skipped',
  'not-found': 'Not found',
  'unmatched-club': 'Unmatched club names',
};

function printReport(report: ReturnType<typeof buildReport>, verbose: boolean): void {
  for (const b of Object.keys(BUCKET_TITLES) as Array<ReportLine['bucket']>) {
    if (b === 'unmatched-club') continue;
    const mine = report.lines.filter((l) => l.bucket === b);
    console.log(`\n── ${BUCKET_TITLES[b]}: ${mine.length}`);
    if (verbose || b !== 'will-send') for (const l of mine) console.log(`  ${l.text}`);
  }
  console.log(`\n── ${BUCKET_TITLES['unmatched-club']}: ${report.unmatchedClubNames.length}`);
  for (const n of report.unmatchedClubNames) console.log(`  ${n}`);
}

// ───────────────────────── Args ─────────────────────────

interface Args {
  tenant: string;
  file: string;
  confirm: boolean;
  requestedBy: string;
  idempotencyKey: string;
  only?: string;
  channels: Channel[];
  linkOrigin?: string;
  emailCorrection: boolean;
  /** Send ONLY to players whose stored request has a FAILED whatsapp result (targeted retry). */
  onlyFailedWhatsapp: boolean;
}

/** The --email-correction paragraph (resend after the Nov 2026 localhost-link run). */
export const EMAIL_CORRECTION_NOTE =
  'Apologies — the link in our earlier email did not work. The button and link below are correct.';

function parseArgs(argv: string[]): Args {
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tenant = get('--tenant');
  const file = get('--file');
  if (!tenant || !file) throw new Error('usage: --tenant <slug> --file <xlsx> [--confirm]');
  const idempotencyKey = get('--idempotency-key') ?? 'sheet-missing-id-nov2026';
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey))
    throw new Error('--idempotency-key must match /^[A-Za-z0-9_-]{8,80}$/');
  return {
    tenant,
    file,
    confirm: argv.includes('--confirm'),
    requestedBy: get('--requested-by') ?? 'carlton42@mailbox.org',
    idempotencyKey,
    only: get('--only'),
    channels: parseChannelsArg(get('--channels')),
    linkOrigin: get('--link-origin'),
    emailCorrection: argv.includes('--email-correction'),
    onlyFailedWhatsapp: argv.includes('--only-failed-whatsapp'),
  };
}

// ───────────────────────── Link origin ─────────────────────────

/**
 * The web origin for the emailed `/d/<token>` link. `sst shell` does NOT carry the
 * Lambda-baked WEB_ORIGIN_MAP / WILDCARD_* / CAPTAINS_REPORT_LINK_BASE_URL env (only
 * SST_RESOURCE_*), so canonicalWebOrigin() would return null and the link base would fall
 * back to localhost. Instead this mirrors how sst.config.ts bakes them, from infra/tenants.ts
 * (prod-only: `isProd`, `wildcardEnabled = isProd && SHARED_API_CERT_ARN !== ''`).
 * An explicit --link-origin always wins; any other stage, or an unresolvable prod tenant,
 * requires it. Throws with a clear message otherwise. Pure.
 */
export function resolveLinkOrigin(opts: {
  stage: string | null;
  tenant: string;
  linkOrigin?: string;
  vanity?: VanityDomain[];
  wildcardEnabled?: boolean;
  wildcardSuffix?: string;
}): string {
  if (opts.linkOrigin) return opts.linkOrigin.replace(/\/+$/, '');
  if (opts.stage === 'prod') {
    const wildcardEnabled = opts.wildcardEnabled ?? (SHARED_API_CERT_ARN as string) !== '';
    const suffix = opts.wildcardSuffix ?? WILDCARD_WEB_SUFFIX;
    const origin =
      webOriginMap(opts.vanity ?? VANITY)[opts.tenant] ??
      (wildcardEnabled ? `https://${opts.tenant}${suffix}` : null);
    if (origin) return origin;
    throw new Error(
      `no link origin for tenant "${opts.tenant}" on prod (no vanity entry, wildcard not armed) ` +
        '— pass --link-origin <https://host>',
    );
  }
  throw new Error(
    `stage is ${opts.stage ? `"${opts.stage}"` : 'unknown (no SST_STAGE / SST_RESOURCE_App)'} — ` +
      'the link origin is only derived on prod; pass --link-origin <https://host>',
  );
}

/** Hard guard before any email send: https only, never a loopback host. Throws. Pure. */
export function assertSendableLinkOrigin(origin: string): void {
  if (!origin.startsWith('https://') || /localhost|127\.0\.0\.1/i.test(origin)) {
    throw new Error(
      `--confirm aborted: link origin "${origin}" is not a public https origin — ` +
        'emailed links would be dead. Pass --link-origin <https://host>.',
    );
  }
}

// ───────────────────────── Meta template preflight ─────────────────────────

/** The live template definition as Meta's Graph API returns it (fields we check). */
export interface MetaTemplate {
  name?: string;
  language?: string;
  status?: string;
  parameter_format?: string;
  components?: Array<{
    type?: string;
    text?: string;
    buttons?: Array<{ type?: string; text?: string; url?: string }>;
  }>;
}

/**
 * Compare Meta's LIVE template against the code registry. The registry's `registered` flag
 * alone once let a BUTTONS-less approved version through (every send: "(#100) Invalid
 * parameter"). Returns one message per mismatch, each quoting what Meta returned for that
 * part (structure only — no PII). Empty ⇒ OK. Pure.
 */
export function checkMetaTemplate(def: WhatsAppTemplateDefinition, meta: MetaTemplate): string[] {
  const problems: string[] = [];
  const comps = meta.components ?? [];
  if (meta.status !== 'APPROVED')
    problems.push(`status is ${JSON.stringify(meta.status)}, expected "APPROVED"`);
  if (meta.language !== def.lang)
    problems.push(`language is ${JSON.stringify(meta.language)}, expected "${def.lang}"`);
  const body = comps.find((c) => c.type === 'BODY');
  const placeholders = new Set((body?.text ?? '').match(/\{\{\d+\}\}/g) ?? []);
  if (!body || placeholders.size !== def.paramCount)
    problems.push(
      `BODY should have ${def.paramCount} positional {{n}} placeholders; Meta BODY: ` +
        JSON.stringify(body ?? null),
    );
  const buttons = comps.find((c) => c.type === 'BUTTONS');
  const urlOk = (buttons?.buttons ?? []).some(
    (b) => b.type === 'URL' && typeof b.url === 'string' && b.url.endsWith('/d/{{1}}'),
  );
  if (!urlOk)
    problems.push(
      "no URL button ending in '/d/{{1}}'; Meta BUTTONS: " + JSON.stringify(buttons ?? null),
    );
  return problems;
}

/**
 * Fetch the live template from Meta and check it. Returns null when skipped (no token / no
 * metaId), else the problem list. Never prints the token.
 */
async function metaTemplatePreflight(def: WhatsAppTemplateDefinition): Promise<string[] | null> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) {
    console.log('· meta preflight skipped: no token');
    return null;
  }
  if (!def.metaId) {
    console.log(`· meta preflight skipped: registry entry ${def.name} has no metaId`);
    return null;
  }
  const url =
    `https://graph.facebook.com/v22.0/${def.metaId}` +
    '?fields=name,language,status,components,parameter_format';
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as MetaTemplate & { error?: unknown };
  if (!res.ok)
    return [`Meta GET failed (HTTP ${res.status}): ${JSON.stringify(json.error ?? json)}`];
  return checkMetaTemplate(def, json);
}

// ───────────────────────── Main ─────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const docKey = 'idDoc';
  const doc = DOC_REQUEST_DOCS[docKey];
  if (!doc) throw new Error(`unknown document "${docKey}"`);

  // Parse first (no SST context needed) so an offline run proves the file reads.
  const wb = XLSX.read(await readFile(args.file));
  const ws = wb.Sheets['Players'];
  if (!ws) throw new Error('sheet "Players" not found in workbook');
  const rows = parseSheetRows(XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' }));
  const noId = rows.filter((r) => !normalizeId(r.idNumber)).length;
  console.log(
    `· parsed ${rows.length} player row(s) across ${new Set(rows.map((r) => r.club)).size} ` +
      `club name(s); ${noId} with no usable ID`,
  );

  // FIRST, before any dynamic import of a notify module (they freeze dry-run flags at import).
  const filled = bootstrapNotifyEnvFromSst();
  if (filled.length) console.log(`· notify config from SST linked secrets: ${filled.join(', ')}`);

  const repo = await import('./repo.js');
  const [notify, whatsapp] = await Promise.all([
    import('./notify/index.js'),
    import('./notify/whatsapp.js'),
  ]);

  const tenant = args.tenant;
  const cfg: TenantConfig | null = await repo.getTenantConfig(tenant).catch(() => null);
  const whatsappOn = hasFeature(cfg, 'whatsappInvites', true);
  const whatsappUsable = whatsappOn && whatsapp.playerDocRequestTemplateReady();
  const channels = resolveChannels(args.channels, {
    whatsappOn,
    templateReady: whatsapp.playerDocRequestTemplateReady(),
  });
  const fullRun = channels.length === 2;
  const orgName = cfg ? orgCopy(cfg).name : tenant;
  if (args.onlyFailedWhatsapp && (channels.length !== 1 || channels[0] !== 'whatsapp'))
    throw new Error('--only-failed-whatsapp requires --channels whatsapp');

  if (args.confirm) {
    const missing: string[] = [];
    if (channels.includes('email')) missing.push('FROM_EMAIL');
    if (channels.includes('whatsapp'))
      missing.push('WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID');
    const absent = missing.filter((k) => !process.env[k]);
    if (absent.length) {
      throw new Error(
        `--confirm aborted: missing notify env ${absent.join(', ')} — sends would silently ` +
          'dry-run. Run under `npx sst shell --stage <stage>` with the secrets set.',
      );
    }
  }

  const clubs = await repo.listClubs(tenant);
  if (!clubs.length) throw new Error(`tenant "${tenant}" has no clubs on this stage`);
  const clubById = new Map(clubs.map((c) => [c.id, c]));
  const playersByClub = new Map<string, PlayerRegistration[]>();
  for (const c of clubs) playersByClub.set(c.id, await repo.listPlayers(tenant, c.id));
  const fullById = new Map<string, PlayerRegistration>();
  for (const list of playersByClub.values())
    for (const p of list) fullById.set(`${p.clubId}\u0000${p.naturalKey}`, p);
  const full = (p: MatchPlayer) => fullById.get(`${p.clubId}\u0000${p.naturalKey}`)!;
  const clubName = (id: string) => clubById.get(id)?.name ?? '(unknown club)';

  const allOutcomes = matchRows(rows, clubs, playersByClub);
  const outcomes = args.only
    ? allOutcomes.filter((o) =>
        matchesOnly(o, args.only!, o.kind === 'matched' ? clubName(o.player.clubId) : undefined),
      )
    : allOutcomes;
  const hasCell = (cell: string | undefined) => !!whatsapp.toE164(cell ?? '');
  const skipOf = (p: MatchPlayer) => channelSkipReason(full(p), channels, hasCell);

  console.log(
    `· tenant ${tenant}: ${clubs.length} club(s); whatsapp ${whatsappOn ? 'on' : 'off'}, ` +
      `usable ${whatsappUsable}; channels ${channels.join('+')}; ${outcomes.length} row(s)` +
      (args.only ? ` (--only "${args.only}"; ${allOutcomes.length} total)` : ''),
  );
  const report = buildReport(outcomes, clubName, skipOf);
  printReport(report, true);

  // Link origin (not PII) — resolved + printed on the dry run too, so the operator sees it.
  let origin: string | null = null;
  try {
    origin = resolveLinkOrigin({
      stage: sstStage(),
      tenant,
      linkOrigin: args.linkOrigin,
    });
    console.log(`\n· link origin: ${origin}`);
    if (args.emailCorrection) console.log('· email correction note: ON');
  } catch (e) {
    if (args.confirm && channels.includes('email')) throw e;
    console.log(`\n· link origin: UNRESOLVED — ${(e as Error).message}`);
  }
  if (args.confirm && channels.includes('email')) assertSendableLinkOrigin(origin!);

  if (channels.includes('whatsapp')) {
    const problems = await metaTemplatePreflight(WHATSAPP_TEMPLATES.playerDocRequest);
    if (problems?.length) {
      console.log('· meta preflight FAILED:');
      for (const p of problems) console.log(`  - ${p}`);
      if (args.confirm) throw new Error('--confirm aborted: Meta template preflight failed');
    } else if (problems) console.log('· meta preflight OK (APPROVED, lang, BODY, URL button)');
  }

  if (!args.confirm) {
    console.log(`\ndry run (channels ${channels.join('+')}) — nothing sent; add --confirm`);
    return;
  }

  // ── Send loop: mirrors POST /admin/doc-requests per player.
  // Email sends are guarded above; a whatsapp-only run may have no origin (link unused there).
  const linkOrigin = origin ?? '';
  const secret = captainsReportLinkSecret();
  const idempotencyKey = args.idempotencyKey;
  const perClub = new Map<string, SendResult[]>();
  const statusCounts = new Map<DocRequestSendStatus, number>();
  const bump = (s: DocRequestSendStatus) => statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
  let errored = 0;
  const nowMs = Date.now();
  const at = new Date(nowMs).toISOString();
  const seen = new Set<string>();

  console.log('\n── Sending');
  for (const o of outcomes) {
    if (o.kind !== 'matched') continue;
    const player = full(o.player);
    const t = { clubId: player.clubId, naturalKey: player.naturalKey };
    const k = `${t.clubId}\u0000${t.naturalKey}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const club = clubById.get(t.clubId)!;
    const displayName = `${player.firstName ?? ''} ${player.lastName ?? ''}`.trim() || 'Player';
    const tag = `${rowTag(o.row)} ${displayName} @ ${club.name}`;

    const skip = channelSkipReason(player, channels, hasCell);
    if (skip) {
      bump(skip);
      console.log(`  ${tag}: ${skip}`);
      continue;
    }

    // One flaky network call must not abort the whole batch (a mid-run ETIMEDOUT did on
    // 6 Nov): errors are reported per player and the loop moves on. While our ledger claim
    // is outstanding it is released on error, so a rerun RETRIES the player instead of
    // replay-skipping them; once completed/released it is left alone (no double sends).
    let claimedRequestId: string | null = null;
    try {
      const existing = await repo.getDocRequest(tenant, t.naturalKey, docKey);
      if (args.onlyFailedWhatsapp) {
        const wa = existing?.lastSendResults?.find((r) => r.channel === 'whatsapp');
        if (!wa || wa.status !== 'failed') {
          console.log(`  ${tag}: skipped (whatsapp not in failed state — nothing to retry)`);
          continue;
        }
      }
      const reuse = existing && existing.status === 'pending' && existing.clubId === t.clubId;
      const requestId = reuse ? existing.requestId : randomUUID();
      if (!(await repo.claimDocRequestNotify(tenant, requestId, idempotencyKey))) {
        const prior = reuse ? (existing.lastSendResults ?? []) : [];
        const status = prior.length
          ? aggregateDocRequestStatus(prior, notify.TEMPLATE_PENDING)
          : 'sent';
        bump(status);
        console.log(`  ${tag}: ${status} (replay — already claimed, not re-sent)`);
        continue;
      }
      claimedRequestId = requestId;
      const linkExpiresAt = new Date(
        nowMs + DOC_REQUEST_LINK_DAYS * 24 * 3600 * 1000,
      ).toISOString();
      const request = {
        requestId,
        clubId: t.clubId,
        naturalKey: t.naturalKey,
        docKey,
        docName: doc.name,
        requestedBy: args.requestedBy,
        createdAt: reuse ? existing.createdAt : at,
        linkExpiresAt,
        status: 'pending' as const,
        ...(reuse && existing.lastSendResults ? { lastSendResults: existing.lastSendResults } : {}),
        ...(reuse && existing.lastSentAt ? { lastSentAt: existing.lastSentAt } : {}),
      };
      await repo.putDocRequest(tenant, request);
      const token = signDocRequestLinkToken(
        { t: tenant, q: requestId, e: Math.floor(Date.parse(linkExpiresAt) / 1000) },
        secret,
      );
      const { results: sendResults } = await notify.sendDocRequestNotice({
        player: { firstName: player.firstName, email: player.email, cell: player.cell },
        orgName,
        clubName: club.name,
        docName: doc.name,
        link: `${linkOrigin}/d/${token}`,
        ...(args.emailCorrection ? { correctionNote: EMAIL_CORRECTION_NOTE } : {}),
        token,
        expiresText: fmtDocRequestExpiry(linkExpiresAt),
        channels,
      });
      if (sendResults.some((r) => r.status === 'sent')) {
        await repo.completeDocRequestNotify(tenant, requestId, idempotencyKey);
      } else {
        await repo.releaseDocRequestNotify(tenant, requestId, idempotencyKey);
      }
      claimedRequestId = null;
      const stored = fullRun
        ? sendResults
        : mergeSendResults(reuse ? existing.lastSendResults : undefined, sendResults, channels);
      await repo.setDocRequestSendResults(tenant, t.naturalKey, docKey, requestId, stored, at);
      const list = perClub.get(t.clubId) ?? [];
      list.push(...sendResults);
      perClub.set(t.clubId, list);
      const status = aggregateDocRequestStatus(sendResults, notify.TEMPLATE_PENDING);
      bump(status);
      const legs = sendResults.map((r) => `${r.channel}:${r.status}`).join(' ');
      console.log(`  ${tag}: ${status} (${legs})`);
    } catch (err) {
      errored++;
      console.log(`  ${tag}: ERROR ${err instanceof Error ? err.message : String(err)}`);
      if (claimedRequestId)
        await repo
          .releaseDocRequestNotify(tenant, claimedRequestId, idempotencyKey)
          .catch(() => {});
    }
    await sleep(150);
  }

  // Comm log: one PII-free summary row per club per channel (counts only).
  for (const [clubId, sends] of perClub) {
    const events: ClubCommEvent[] = [];
    for (const channel of ['email', 'whatsapp'] as const) {
      const mine = sends.filter((r) => r.channel === channel);
      if (!mine.length) continue;
      const n = (s: SendResult['status']) => mine.filter((r) => r.status === s).length;
      const parts = [
        n('sent') ? `${n('sent')} sent` : '',
        n('skipped') ? `${n('skipped')} skipped` : '',
        n('failed') ? `${n('failed')} failed` : '',
      ].filter(Boolean);
      events.push({
        id: randomUUID(),
        channel,
        status: n('sent') ? 'sent' : n('failed') ? 'failed' : 'skipped',
        at,
        by: args.requestedBy,
        idempotencyKey: `docreq-${idempotencyKey}-${channel}`,
        kind: 'doc-request',
        summary: `${doc.name}: ${parts.join(' · ')}`,
      });
    }
    await repo.appendClubCommEvents(tenant, clubId, events);
  }

  console.log(`\n── Summary (channels ${channels.join('+')})`);
  for (const [s, n] of [...statusCounts].sort()) console.log(`  ${s}: ${n}`);
  if (errored) {
    console.log(`  errored: ${errored} (claims released — rerun with the SAME key to retry them)`);
    process.exitCode = 1;
  }
  printReport(report, false);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

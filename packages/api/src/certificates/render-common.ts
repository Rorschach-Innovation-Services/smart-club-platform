/**
 * Shared certificate-rendering pieces: the view model both templates draw from, fonts,
 * width-budget text fitting, logo resolution, QR, colours and approval copy.
 *
 * Nothing here may fail issuance for a cosmetic reason: a logo that can't be fetched or
 * isn't PNG/JPEG falls back to a text wordmark, and text is always fitted to its box
 * (shrink, then ellipsis) so a long club or player name can never overlap its neighbours.
 */
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dayjs from 'dayjs';
import dayjsUtc from 'dayjs/plugin/utc.js';
import QRCode from 'qrcode';
import { rgb, type PDFFont, type PDFDocument, type PDFImage, type RGB } from 'pdf-lib';
import type {
  CertificateApproval,
  CertificateTemplate,
  OrgContact,
  PlayerClearance,
} from '../types.js';
import { TENANT_UTC_OFFSET_MINUTES } from '../tenant-time.js';

dayjs.extend(dayjsUtc);

// ───────────────────────── View model ─────────────────────────

export interface LogoAsset {
  bytes: Uint8Array;
  kind: 'png' | 'jpg';
}

export interface CertificateView {
  template: CertificateTemplate;
  serial: string;
  issuedAt: string;
  orgName: string;
  orgContact?: OrgContact;
  logo: LogoAsset | null;
  accent: RGB;
  playerName: string;
  idNumber?: string;
  idType?: 'sa-id' | 'passport';
  dob?: string;
  team?: string;
  fromClubName: string;
  toClubName: string;
  effectiveDate: string;
  origin: 'registration' | 'request';
  transferring: CertificateApproval;
  acquiring: CertificateApproval;
  verifyUrl: string;
  qrPng: Uint8Array;
}

// ───────────────────────── Dates ─────────────────────────

const sast = (iso: string) => dayjs(iso).utcOffset(TENANT_UTC_OFFSET_MINUTES);

/** "29 September 2026" in SAST ('' for a missing/invalid value). */
export function fmtDate(iso?: string | null): string {
  if (!iso) return '';
  // A bare YYYY-MM-DD is a calendar date, not an instant — never shift it across midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const d = dayjs(iso);
    return d.isValid() ? d.format('D MMMM YYYY') : '';
  }
  const d = sast(iso);
  return d.isValid() ? d.format('D MMMM YYYY') : '';
}

/** "29 Sep 2026, 14:05 SAST" ('' for a missing/invalid value). */
export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '';
  const d = sast(iso);
  return d.isValid() ? `${d.format('D MMM YYYY, HH:mm')} SAST` : '';
}

/** The calendar date (SAST) of an ISO instant: YYYY-MM-DD. */
export function sastDate(iso: string): string {
  return sast(iso).format('YYYY-MM-DD');
}

// ───────────────────────── Approvals ─────────────────────────

/**
 * The approval record the certificate states, derived from the clearance. `historical`
 * (backfill --include-imported) marks a transfer recorded from paper history.
 */
export function buildApprovals(
  c: PlayerClearance,
  opts: { historical?: boolean } = {},
): { transferring: CertificateApproval; acquiring: CertificateApproval } {
  let transferring: CertificateApproval;
  if (opts.historical) {
    transferring = { kind: 'historical', at: c.clubApprovedAt ?? c.adminOverrideAt ?? undefined };
  } else if (c.status === 'admin-override') {
    transferring = {
      kind: 'admin',
      by: c.overriddenBy,
      at: c.adminOverrideAt ?? undefined,
    };
  } else if (c.clubApprovedBy) {
    transferring = { kind: 'club', by: c.clubApprovedBy, at: c.clubApprovedAt ?? undefined };
  } else {
    transferring = { kind: 'not-recorded', at: c.clubApprovedAt ?? undefined };
  }
  const acquiring: CertificateApproval =
    c.origin === 'registration'
      ? { kind: 'registration', at: c.requestedAt }
      : c.requestedBy
        ? { kind: 'club', by: c.requestedBy, at: c.requestedAt }
        : { kind: 'not-recorded', at: c.requestedAt };
  return { transferring, acquiring };
}

/** The effective (approval) date of a resolved clearance, YYYY-MM-DD in SAST. */
export function effectiveDateOf(c: PlayerClearance): string {
  const at = c.status === 'admin-override' ? c.adminOverrideAt : c.clubApprovedAt;
  return sastDate(at ?? c.adminOverrideAt ?? c.clubApprovedAt ?? c.requestedAt);
}

export interface ApprovalCopy {
  official: string;
  decision: string;
  via: string;
  when: string;
  /** One-line summary (classic template). */
  summary: string;
}

/** Human copy for one side of the approval record. */
export function approvalCopy(
  a: CertificateApproval,
  side: 'transferring' | 'acquiring',
): ApprovalCopy {
  const when = fmtDateTime(a.at);
  const date = fmtDate(a.at);
  switch (a.kind) {
    case 'club':
      return {
        official: a.by ?? 'Club representative',
        decision: side === 'transferring' ? 'Approved' : 'Requested',
        via: 'Club portal (authenticated)',
        when,
        summary: `${side === 'transferring' ? 'Approved' : 'Requested'} by ${a.by ?? 'club representative'} · ${date}`,
      };
    case 'admin':
      return {
        official: a.by ?? 'Union office',
        decision: 'Approved (union override)',
        via: "Issued by the union office on the clubs' behalf",
        when,
        summary: `Issued by the union office on the clubs' behalf · ${date}`,
      };
    case 'registration':
      return {
        official: 'Player (self-registration)',
        decision: 'Registered',
        via: 'Public registration',
        when,
        summary: `Registered via public registration · ${date}`,
      };
    case 'historical':
      return {
        official: 'Not recorded',
        decision: 'Recorded from historical records',
        via: 'No digital approval on file',
        when: date,
        summary: 'Recorded from historical records · no digital approval on file',
      };
    case 'not-recorded':
    default:
      return {
        official: 'Approving official not recorded',
        decision: side === 'transferring' ? 'Approved' : 'Requested',
        via: 'Club portal',
        when,
        summary: `Approving official not recorded · ${date}`,
      };
  }
}

// ───────────────────────── Colours ─────────────────────────

export const DEFAULT_ACCENT = '#B89B4A';

/** Parse #RGB / #RRGGBB → pdf-lib RGB, or null. */
export function parseHex(hex: string | undefined | null): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map((ch) => ch + ch).join('');
  const n = parseInt(h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** The certificate accent: `--brand-accent` when a valid hex, else the classic gold. */
export function accentColor(colors: Record<string, string> | undefined): RGB {
  return parseHex(colors?.['--brand-accent']) ?? parseHex(DEFAULT_ACCENT)!;
}

/** Blend `c` toward white by `t` (0 = c, 1 = white) — shaded table cells. */
export function tint(c: RGB, t: number): RGB {
  return rgb(c.red + (1 - c.red) * t, c.green + (1 - c.green) * t, c.blue + (1 - c.blue) * t);
}

export const INK = rgb(0.13, 0.13, 0.15);
export const MUTED = rgb(0.4, 0.4, 0.43);

// ───────────────────────── Fonts ─────────────────────────

const FONT_FILES = {
  regular: 'EBGaramond-Regular.ttf',
  semibold: 'EBGaramond-SemiBold.ttf',
  italic: 'EBGaramond-Italic.ttf',
} as const;

const fontCache = new Map<string, Promise<Uint8Array>>();

/**
 * Where the TTFs live: the Lambda bundle (sst.config copyFiles → <root>/certificates/fonts),
 * next to this module (tsx / tests / sst dev), or next to a bundled entry file.
 */
function fontDirCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out: string[] = [];
  if (process.env.LAMBDA_TASK_ROOT) {
    out.push(path.join(process.env.LAMBDA_TASK_ROOT, 'certificates', 'fonts'));
  }
  out.push(path.join(here, 'fonts'), path.join(here, 'certificates', 'fonts'));
  return out;
}

async function loadFontFile(file: string): Promise<Uint8Array> {
  for (const dir of fontDirCandidates()) {
    const p = path.join(dir, file);
    try {
      await access(p);
    } catch {
      continue;
    }
    return new Uint8Array(await readFile(p));
  }
  throw new Error(
    `certificate font ${file} not found (looked in ${fontDirCandidates().join(', ')}) — ` +
      'is copyFiles set for packages/api/src/certificates/fonts?',
  );
}

/** EB Garamond bytes, read once per process. A failed read is not cached. */
export function garamondBytes(weight: keyof typeof FONT_FILES): Promise<Uint8Array> {
  const file = FONT_FILES[weight];
  let p = fontCache.get(file);
  if (!p) {
    p = loadFontFile(file).catch((err) => {
      fontCache.delete(file);
      throw err;
    });
    fontCache.set(file, p);
  }
  return p;
}

// ───────────────────────── Text fitting ─────────────────────────

const ELLIPSIS = '…';

/**
 * Replace characters the font can't encode (Helvetica is WinAnsi-only; a custom font may
 * lack a glyph) so drawText never throws on an unusual name.
 */
export function safeText(font: PDFFont, text: string): string {
  const supported = new Set(font.getCharacterSet());
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const cp = ch.codePointAt(0)!;
    if (supported.has(cp)) out += ch;
    else {
      const stripped = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      out += stripped && supported.has(stripped.codePointAt(0)!) ? stripped : '?';
    }
  }
  return out;
}

/** Truncate `text` with an ellipsis so it fits `maxWidth` at `size`. */
export function truncateToWidth(
  font: PDFFont,
  text: string,
  size: number,
  maxWidth: number,
): string {
  const t = safeText(font, text);
  if (font.widthOfTextAtSize(t, size) <= maxWidth) return t;
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = t.slice(0, mid).trimEnd() + ELLIPSIS;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? ELLIPSIS : t.slice(0, lo).trimEnd() + ELLIPSIS;
}

/**
 * Fit `text` into `maxWidth`: shrink from `maxSize` down to `minSize`, then truncate at
 * `minSize`. Returns the text to draw and the size to draw it at.
 */
export function fitText(
  font: PDFFont,
  text: string,
  maxSize: number,
  minSize: number,
  maxWidth: number,
): { text: string; size: number } {
  const t = safeText(font, text);
  const w = font.widthOfTextAtSize(t, maxSize);
  if (w <= maxWidth) return { text: t, size: maxSize };
  const size = Math.max(minSize, Math.floor(((maxSize * maxWidth) / w) * 10) / 10);
  return { text: truncateToWidth(font, t, size, maxWidth), size };
}

/** Greedy word wrap into at most `maxLines` lines; the last line is ellipsised if cut. */
export function wrapText(
  font: PDFFont,
  text: string,
  size: number,
  maxWidth: number,
  maxLines = Infinity,
): string[] {
  const words = safeText(font, text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line =
      font.widthOfTextAtSize(w, size) <= maxWidth ? w : truncateToWidth(font, w, size, maxWidth);
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines - 1);
  const rest = lines.slice(maxLines - 1).join(' ');
  kept.push(truncateToWidth(font, `${rest}${ELLIPSIS}`, size, maxWidth));
  return kept;
}

// ───────────────────────── Logo ─────────────────────────

const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_TIMEOUT_MS = 3000;

/** PNG / JPEG magic-byte sniff; anything else (SVG, WebP, HTML error page…) is null. */
export function sniffImage(bytes: Uint8Array): 'png' | 'jpg' | null {
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return null;
}

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(LOGO_TIMEOUT_MS) });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length <= LOGO_MAX_BYTES ? buf : null;
}

/**
 * Resolve the tenant logo to embeddable bytes, or null (→ text wordmark). Absolute http(s)
 * URLs are fetched; a relative path (SPA `public/` asset) is read from the repo's public/
 * dir when present (dev/tests), else fetched from the platform web origin. Never throws.
 */
export async function resolveLogo(
  logoUrl: string | undefined,
  webOrigin: string | undefined,
): Promise<LogoAsset | null> {
  const url = (logoUrl ?? '').trim();
  if (!url) return null;
  try {
    let bytes: Uint8Array | null = null;
    if (/^https?:\/\//i.test(url)) {
      bytes = await fetchBytes(url);
    } else if (url.startsWith('/') && !url.startsWith('//') && !url.includes('..')) {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const local = path.resolve(here, '../../../../public', `.${url}`);
      try {
        bytes = new Uint8Array(await readFile(local));
      } catch {
        if (webOrigin) bytes = await fetchBytes(`${webOrigin.replace(/\/$/, '')}${url}`);
      }
    }
    if (!bytes || bytes.length > LOGO_MAX_BYTES) return null;
    const kind = sniffImage(bytes);
    return kind ? { bytes, kind } : null;
  } catch (err) {
    console.warn(`certificate: logo ${url} unavailable, using wordmark`, err);
    return null;
  }
}

/** Embed a resolved logo; a corrupt image degrades to null (wordmark), never a throw. */
export async function embedLogo(
  doc: PDFDocument,
  logo: LogoAsset | null,
): Promise<PDFImage | null> {
  if (!logo) return null;
  try {
    return logo.kind === 'png' ? await doc.embedPng(logo.bytes) : await doc.embedJpg(logo.bytes);
  } catch (err) {
    console.warn('certificate: logo could not be embedded, using wordmark', err);
    return null;
  }
}

/** Scale (w,h) to fit inside (maxW,maxH), preserving aspect. */
export function fitBox(
  w: number,
  h: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  const s = Math.min(maxW / w, maxH / h, 1e9);
  return { width: w * s, height: h * s };
}

// ───────────────────────── QR ─────────────────────────

/** The public verify URL for a serial. */
export function verifyUrlFor(baseUrl: string, serial: string): string {
  return `${baseUrl.replace(/\/$/, '')}/verify/${serial}`;
}

/** QR PNG (error-correction M) of `url`. */
export async function qrPng(url: string): Promise<Uint8Array> {
  const buf = await QRCode.toBuffer(url, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 360,
  });
  return new Uint8Array(buf);
}

/**
 * "ID number" vs "Passport number" label for the player's document. Sentence case by default
 * (classic uses it mid-line, beside "Date of birth"); `titleCase` for table labels that sit
 * beside "Full Name" / "Date of Birth" (confirmation).
 */
export function idLabel(idType: CertificateView['idType'], titleCase = false): string {
  if (titleCase) return idType === 'passport' ? 'Passport Number' : 'ID Number';
  return idType === 'passport' ? 'Passport number' : 'ID number';
}

/** The footer contact segments (regNo, address, phone, website, email), blanks omitted. */
export function contactSegments(c: OrgContact | undefined): string[] {
  if (!c) return [];
  return [
    c.regNo ? `Reg. No. ${c.regNo}` : '',
    c.address ?? '',
    c.phone ? `Tel ${c.phone}` : '',
    c.website ?? '',
    c.email ?? '',
  ].filter(Boolean);
}

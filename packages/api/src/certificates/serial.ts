/**
 * Certificate serials and ID masking.
 *
 * A serial is `SC-TRF-` + 20 Crockford base32 characters (100 bits from the CSPRNG), grouped
 * `XXXXX-XXXXX-XXXXX-XXXXX` so a human can read it off paper. The serial IS the verify-page
 * capability: the 100-bit space is what makes enumeration pointless (there is no rate limit).
 * Lookup normalises the way people actually retype codes: case-insensitive, hyphens/spaces
 * optional, and Crockford's aliases (O→0, I/L→1).
 */
import { randomBytes } from 'node:crypto';

export const SERIAL_PREFIX = 'SC-TRF-';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY_CHARS = 20;
const GROUP = 5;

/** Encode the top `chars * 5` bits of `bytes` as Crockford base32. */
export function crockfordEncode(bytes: Uint8Array, chars: number): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  let i = 0;
  while (out.length < chars) {
    if (bits < 5) {
      if (i >= bytes.length) throw new Error('crockfordEncode: not enough input bytes');
      acc = ((acc << 8) | bytes[i++]) & 0xffff;
      bits += 8;
    }
    bits -= 5;
    out += CROCKFORD[(acc >> bits) & 31];
  }
  return out;
}

const group = (body: string): string => body.match(new RegExp(`.{1,${GROUP}}`, 'g'))!.join('-');

/**
 * A fresh serial: `SC-TRF-XXXXX-XXXXX-XXXXX-XXXXX` (13 random bytes → 100 bits used). A body
 * starting `SCTRF` is redrawn: retyped without hyphens it would be indistinguishable from the
 * prefix, and normaliseSerial would strip it.
 */
export function newSerial(): string {
  const bare = SERIAL_PREFIX.replace(/-/g, '');
  let body: string;
  do body = crockfordEncode(randomBytes(13), BODY_CHARS);
  while (body.startsWith(bare));
  return SERIAL_PREFIX + group(body);
}

/**
 * Canonicalise user input into the stored serial form, or null when it can't be one.
 * Accepts the prefix or not, any case, any hyphen/space grouping, and Crockford aliases.
 */
export function normaliseSerial(input: string): string | null {
  if (typeof input !== 'string') return null;
  let s = input.toUpperCase().replace(/[\s-]/g, '');
  const bare = SERIAL_PREFIX.replace(/-/g, '');
  if (s.startsWith(bare)) s = s.slice(bare.length);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== BODY_CHARS) return null;
  for (const ch of s) if (!CROCKFORD.includes(ch)) return null;
  return SERIAL_PREFIX + group(s);
}

/**
 * Mask an ID/passport number for public display: first 2 + last 3 characters, the rest `*`.
 * Anything too short to leave a meaningful hidden middle is fully masked.
 */
export function maskIdNumber(id: string | undefined | null): string {
  const v = (id ?? '').replace(/\s/g, '');
  if (!v) return '';
  if (v.length <= 6) return '*'.repeat(v.length);
  return v.slice(0, 2) + '*'.repeat(v.length - 5) + v.slice(-3);
}

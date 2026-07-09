/**
 * Shared theming primitives for the operator portal.
 *
 * The single source of truth for the two-layer brand-token model, colour maths and
 * starter palettes used by the client Brand editor and the create-client wizard
 * (src/platform.tsx), and by applyTheme (src/config.ts) for the legacy→role key map.
 *
 * Two-layer token model (see index.html :root): tenants set semantic ROLE tokens
 * (--brand-primary, --brand-accent, …); the value-named primitives (--green, …)
 * alias the roles, so the app's 2,800+ CSS references re-colour automatically when a
 * role changes. Editing a role, not a colour, is what keeps a second brand's "green"
 * from meaning nothing.
 */

export interface BrandRole {
  /** The --brand-* custom property tenants set. */
  token: string;
  /** Human role name shown in the editor. */
  label: string;
  /** One-line "where it shows". */
  hint: string;
  /** True ⇒ deriveScale() can generate it from the base brand colour. */
  derived: boolean;
}

/** The editable colour roles, in display order. Hero image and font have their own controls. */
export const BRAND_ROLES: BrandRole[] = [
  {
    token: '--brand-primary',
    label: 'Primary · deep',
    hint: 'Dark surfaces & primary buttons',
    derived: true,
  },
  {
    token: '--brand-primary-mid',
    label: 'Primary · mid',
    hint: 'Mid fills & gradients',
    derived: true,
  },
  {
    token: '--brand-primary-bright',
    label: 'Primary · bright',
    hint: 'Links & highlights',
    derived: true,
  },
  {
    token: '--brand-primary-tint',
    label: 'Primary · tint',
    hint: 'Soft backgrounds & badges',
    derived: true,
  },
  {
    token: '--brand-neutral',
    label: 'Warm neutral',
    hint: 'Eyebrows & stone accents',
    derived: false,
  },
  {
    token: '--brand-accent',
    label: 'Warm accent',
    hint: 'Gold / brass badge moments',
    derived: false,
  },
];

/** The imagery role — a url(…) or gradient, edited separately from the colours. */
export const HERO_TOKEN = '--hero-image';

/** The canonical role tokens (colours + hero) — used to tell roles apart from Advanced extras. */
export const CANONICAL_ROLE_TOKENS: string[] = [...BRAND_ROLES.map((r) => r.token), HERO_TOKEN];

/**
 * Legacy value-named keys → their semantic role token. applyTheme rewrites any stored
 * legacy key to its role before setProperty, so --brand-primary reflects the tenant's
 * colour (Phase 2's --brand-on-primary derives from it). Rendering is correct either
 * way — the primitives alias the roles in index.html — this just keeps roles authoritative.
 */
export const LEGACY_TO_ROLE: Record<string, string> = {
  '--green': '--brand-primary',
  '--green-mid': '--brand-primary-mid',
  '--green-bright': '--brand-primary-bright',
  '--green-pale': '--brand-primary-tint',
  '--cream': '--brand-neutral',
  '--gold-warm': '--brand-accent',
};

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** True for a #rgb or #rrggbb hex string (whitespace tolerated). */
export const isValidHex = (v: string): boolean => HEX_RE.test((v ?? '').trim());

/** A valid #RRGGBB for a native colour input — expands #rgb, falls back to black. */
export function hex6(v: string): string {
  return isValidHex(v) ? `#${normHex(v).toUpperCase()}` : '#000000';
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function normHex(hex: string): string {
  let c = (hex ?? '').trim().replace(/^#/, '');
  if (c.length === 3)
    c = c
      .split('')
      .map((x) => x + x)
      .join('');
  return c;
}

export interface Hsl {
  /** 0–360 */ h: number;
  /** 0–100 */ s: number;
  /** 0–100 */ l: number;
}

/** #rrggbb → HSL. Assumes a valid hex (guard with isValidHex). */
export function hexToHsl(hex: string): Hsl {
  const c = normHex(hex);
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = h * 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s: s * 100, l: l * 100 };
}

/** HSL → #RRGGBB (uppercase). */
export function hslToHex(h: number, s: number, l: number): string {
  const sN = clamp(s, 0, 100) / 100;
  const lN = clamp(l, 0, 100) / 100;
  const hN = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((hN / 60) % 2) - 1));
  const m = lN - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hN < 60) [r, g, b] = [c, x, 0];
  else if (hN < 120) [r, g, b] = [x, c, 0];
  else if (hN < 180) [r, g, b] = [0, c, x];
  else if (hN < 240) [r, g, b] = [0, x, c];
  else if (hN < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

/** WCAG relative luminance (0–1). Assumes a valid hex. */
export function luminance(hex: string): number {
  const c = normHex(hex);
  const ch = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio (1–21) between two hex colours. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

const INK = '#0A0F14';
const WHITE = '#FFFFFF';

/** The more legible of ink / white on a given background — the --brand-on-primary rule. */
export function onColor(hex: string): string {
  return contrastRatio(hex, WHITE) >= contrastRatio(hex, INK) ? WHITE : INK;
}

/** role token → hex value. */
export type BrandScale = Record<string, string>;

/**
 * Derive the four-step primary scale from one base brand colour: keep the hue,
 * snap each token to the lightness band the app's green family uses (≈16/26/42/93),
 * and desaturate the tint. Good for saturated mid-to-dark hues; a very light or
 * pale brand should lean on presets + manual role edits (its "deep" won't match).
 */
export function deriveScale(baseHex: string): BrandScale {
  if (!isValidHex(baseHex)) return { ...DEFAULT_BRAND_COLORS };
  const { h, s } = hexToHsl(baseHex);
  const sat = Math.max(s, 12); // never a fully grey scale
  return {
    '--brand-primary': hslToHex(h, Math.min(sat, 80), 16),
    '--brand-primary-mid': hslToHex(h, Math.min(sat, 78), 26),
    '--brand-primary-bright': hslToHex(h, Math.min(sat, 70), 42),
    '--brand-primary-tint': hslToHex(h, Math.min(sat, 30), 93),
  };
}

/** A neutral hero gradient built from a scale — the --hero-image default when no image is set. */
export function defaultHeroGradient(scale: BrandScale): string {
  const mid = scale['--brand-primary-mid'] ?? '#2E363F';
  const deep = scale['--brand-primary'] ?? '#1A1F26';
  return `linear-gradient(160deg, ${mid} 0%, ${deep} 55%, #0A0F14 100%)`;
}

/**
 * Build a safe font-family stack from a single family name, always falling back to
 * Montserrat then sans-serif. A value that already looks like a stack (has a comma)
 * is passed through untouched.
 */
export function fontStack(family: string): string {
  const f = (family ?? '').trim();
  if (!f) return "'Montserrat', sans-serif";
  if (f.includes(',')) return f;
  const bare = f.replace(/['"]/g, '');
  const quoted = /\s/.test(bare) ? `'${bare}'` : bare;
  return `${quoted}, 'Montserrat', sans-serif`;
}

export interface ThemePreset {
  id: string;
  label: string;
  /** A full six-role colour set. */
  colors: BrandScale;
}

/** One-click starter palettes — each sets every colour role. Hero uses the derived gradient. */
export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'green',
    label: 'Dolphins green',
    colors: {
      '--brand-primary': '#0E3529',
      '--brand-primary-mid': '#215F47',
      '--brand-primary-bright': '#4B8A6C',
      '--brand-primary-tint': '#E8F0EB',
      '--brand-neutral': '#E7DDC6',
      '--brand-accent': '#B89B4A',
    },
  },
  {
    id: 'navy',
    label: 'Navy & gold',
    colors: {
      '--brand-primary': '#111F3A',
      '--brand-primary-mid': '#24406B',
      '--brand-primary-bright': '#4B6DA0',
      '--brand-primary-tint': '#E9EDF4',
      '--brand-neutral': '#E7DDC6',
      '--brand-accent': '#C8A84B',
    },
  },
  {
    id: 'maroon',
    label: 'Maroon',
    colors: {
      '--brand-primary': '#3A0F1D',
      '--brand-primary-mid': '#6B2133',
      '--brand-primary-bright': '#A04B5F',
      '--brand-primary-tint': '#F3E9EC',
      '--brand-neutral': '#E7DDC6',
      '--brand-accent': '#B89B4A',
    },
  },
  {
    id: 'teal',
    label: 'Deep teal',
    colors: {
      '--brand-primary': '#0C2E30',
      '--brand-primary-mid': '#175457',
      '--brand-primary-bright': '#3E8A8D',
      '--brand-primary-tint': '#E6F0F0',
      '--brand-neutral': '#E7DDC6',
      '--brand-accent': '#B89B4A',
    },
  },
];

/** The default role palette (Dolphins green) — the wizard's starting point. */
export const DEFAULT_BRAND_COLORS: BrandScale = THEME_PRESETS[0].colors;

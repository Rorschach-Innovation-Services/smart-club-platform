import { describe, it, expect } from 'vitest';
import {
  isValidHex,
  hex6,
  hexToHsl,
  hslToHex,
  onColor,
  contrastRatio,
  deriveScale,
  defaultHeroGradient,
  fontStack,
  LEGACY_TO_ROLE,
  BRAND_ROLES,
  CANONICAL_ROLE_TOKENS,
  THEME_PRESETS,
  DEFAULT_BRAND_COLORS,
} from './platform-theme';

describe('isValidHex', () => {
  it('accepts #rgb and #rrggbb, rejects the rest', () => {
    expect(isValidHex('#0E3529')).toBe(true);
    expect(isValidHex('#abc')).toBe(true);
    expect(isValidHex('  #FFF ')).toBe(true);
    expect(isValidHex('0E3529')).toBe(false);
    expect(isValidHex('#12')).toBe(false);
    expect(isValidHex("url('/x.jpg')")).toBe(false);
    expect(isValidHex('')).toBe(false);
  });
});

describe('hex6', () => {
  it('expands short hex and falls back to black for invalid input', () => {
    expect(hex6('#abc')).toBe('#AABBCC');
    expect(hex6('#0e3529')).toBe('#0E3529');
    expect(hex6('nope')).toBe('#000000');
  });
});

describe('hexToHsl / hslToHex', () => {
  it('round-trips a colour within rounding tolerance', () => {
    const start = '#215F47';
    const { h, s, l } = hexToHsl(start);
    const back = hexToHsl(hslToHex(h, s, l));
    expect(Math.abs(back.h - h)).toBeLessThan(2);
    expect(Math.abs(back.s - s)).toBeLessThan(2);
    expect(Math.abs(back.l - l)).toBeLessThan(2);
  });

  it('reports greys as zero saturation', () => {
    expect(hexToHsl('#808080').s).toBeCloseTo(0, 5);
  });
});

describe('onColor / contrastRatio', () => {
  it('picks white on a dark brand and ink on a light one', () => {
    expect(onColor('#0E3529')).toBe('#FFFFFF');
    expect(onColor('#E8F0EB')).toBe('#0A0F14');
  });

  it('is symmetric and bounded 1..21', () => {
    const r = contrastRatio('#000000', '#FFFFFF');
    expect(r).toBeCloseTo(21, 0);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(r, 5);
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5);
  });
});

describe('deriveScale', () => {
  it('produces the four primary roles, dark→light', () => {
    const s = deriveScale('#1E7A55');
    const keys = [
      '--brand-primary',
      '--brand-primary-mid',
      '--brand-primary-bright',
      '--brand-primary-tint',
    ];
    for (const k of keys) expect(isValidHex(s[k])).toBe(true);
    const l = keys.map((k) => hexToHsl(s[k]).l);
    expect(l[0]).toBeLessThan(l[1]);
    expect(l[1]).toBeLessThan(l[2]);
    expect(l[2]).toBeLessThan(l[3]);
  });

  it('keeps the base hue across the scale', () => {
    const base = '#2E5AA8';
    const baseHue = hexToHsl(base).h;
    const s = deriveScale(base);
    // The deep/mid/bright keep the hue; the tint is desaturated so hue can drift.
    expect(Math.abs(hexToHsl(s['--brand-primary-mid']).h - baseHue)).toBeLessThan(4);
  });

  it('falls back to the default palette for invalid input', () => {
    expect(deriveScale('not-a-colour')['--brand-primary']).toBe(
      DEFAULT_BRAND_COLORS['--brand-primary'],
    );
  });
});

describe('defaultHeroGradient', () => {
  it('embeds the scale mid + deep', () => {
    const g = defaultHeroGradient({
      '--brand-primary': '#0E3529',
      '--brand-primary-mid': '#215F47',
    });
    expect(g).toContain('#215F47');
    expect(g).toContain('#0E3529');
    expect(g.startsWith('linear-gradient(')).toBe(true);
  });
});

describe('fontStack', () => {
  it('quotes multi-word families and always appends fallbacks', () => {
    expect(fontStack('Poppins')).toBe("Poppins, 'Montserrat', sans-serif");
    expect(fontStack('DM Sans')).toBe("'DM Sans', 'Montserrat', sans-serif");
    expect(fontStack('')).toBe("'Montserrat', sans-serif");
  });

  it('passes an existing stack through untouched', () => {
    expect(fontStack('Inter, system-ui, sans-serif')).toBe('Inter, system-ui, sans-serif');
  });
});

describe('token model invariants', () => {
  it('maps every legacy key onto a real role token', () => {
    for (const role of Object.values(LEGACY_TO_ROLE)) {
      expect(BRAND_ROLES.some((r) => r.token === role)).toBe(true);
    }
  });

  it('lists every colour role plus hero as canonical', () => {
    for (const r of BRAND_ROLES) expect(CANONICAL_ROLE_TOKENS).toContain(r.token);
    expect(CANONICAL_ROLE_TOKENS).toContain('--hero-image');
  });

  it('every preset defines all six colour roles', () => {
    for (const p of THEME_PRESETS) {
      for (const r of BRAND_ROLES) expect(isValidHex(p.colors[r.token])).toBe(true);
    }
  });
});

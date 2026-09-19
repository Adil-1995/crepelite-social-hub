import { describe, expect, it } from 'vitest';
import {
  BRAND_PRESETS,
  DEFAULT_APPEARANCE,
  contrastTextFor,
  isValidBrandColor,
  normaliseBrandColor,
} from '@shared/index';

/**
 * The brand colour is user-chosen, so nothing may assume it is dark. The
 * contrast rule is what keeps a pale colour from producing white-on-white
 * buttons.
 */
describe('brand colour parsing', () => {
  it('accepts a six-digit hex with or without the hash', () => {
    expect(normaliseBrandColor('#B4562A')).toBe('#b4562a');
    expect(normaliseBrandColor('b4562a')).toBe('#b4562a');
    expect(normaliseBrandColor('  #B4562A  ')).toBe('#b4562a');
  });

  it('rejects anything else rather than guessing', () => {
    for (const bad of ['', '#fff', 'red', '#12345', '#1234567', 'rgb(1,2,3)', '#ghijkl']) {
      expect(normaliseBrandColor(bad)).toBeNull();
    }
  });

  it('validates the same shapes it normalises', () => {
    expect(isValidBrandColor('#b4562a')).toBe(true);
    expect(isValidBrandColor('#fff')).toBe(false);
  });
});

describe('contrast', () => {
  it('puts dark text on a light colour and light text on a dark one', () => {
    expect(contrastTextFor('#ffffff')).toBe('#000000');
    expect(contrastTextFor('#ffe400')).toBe('#000000');
    expect(contrastTextFor('#000000')).toBe('#ffffff');
    expect(contrastTextFor('#b4562a')).toBe('#ffffff');
  });

  it('never leaves a preset unreadable', () => {
    // Every shipped preset must produce legible text without anyone checking.
    for (const preset of BRAND_PRESETS) {
      const text = contrastTextFor(preset.value);
      expect(['#ffffff', '#000000']).toContain(text);
      expect(ratio(preset.value, text)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('holds across the whole colour space, not just the presets', () => {
    // A user can pick anything, so sample widely rather than trusting taste.
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
          expect(ratio(hex, contrastTextFor(hex))).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

describe('defaults', () => {
  it('ships the CrepeLite colour, and it is among the presets', () => {
    expect(DEFAULT_APPEARANCE.brandColor).toBe('#b4562a');
    expect(BRAND_PRESETS.some((p) => p.value === DEFAULT_APPEARANCE.brandColor)).toBe(true);
  });

  it('offers only valid, distinct presets', () => {
    for (const p of BRAND_PRESETS) expect(isValidBrandColor(p.value)).toBe(true);
    expect(new Set(BRAND_PRESETS.map((p) => p.value)).size).toBe(BRAND_PRESETS.length);
  });
});

/** WCAG relative-luminance contrast ratio. */
function ratio(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = hex.replace('#', '');
    const ch = (i: number) => {
      const v = parseInt(n.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

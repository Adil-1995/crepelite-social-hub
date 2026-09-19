import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE } from '@shared/index';
import { applyBrandColor, rampFor, resetBrandColor } from '@/theme/brand';

/**
 * The preset builds every brand-coloured surface from three families of custom
 * properties, and they are not linked to each other: `--p-brand-*` is the
 * primitive palette, `--p-primary-*` is a *copy* of that ramp made by the
 * semantic layer, and `--color-brand-*` drives the Tailwind utilities. Writing
 * only one of them leaves the app half-recoloured, which is what shipped the
 * first time: PrimeVue's `updatePrimaryPalette` touched `--p-primary-*` alone,
 * and nothing visible read it.
 */
const STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'] as const;

function inlineVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

beforeEach(() => {
  document.documentElement.removeAttribute('style');
  document.documentElement.className = '';
  document.head.innerHTML = '<meta name="theme-color" content="#b4562a" />';
});

describe('applyBrandColor', () => {
  it('writes the whole ramp to every family that the theme reads', () => {
    const ramp = applyBrandColor('#1f6f8b');
    expect(ramp).not.toBeNull();

    for (const step of STEPS) {
      const expected = ramp![step];
      expect(expected, `ramp is missing step ${step}`).toBeTruthy();
      expect(inlineVar(`--p-brand-${step}`)).toBe(expected);
      expect(inlineVar(`--p-primary-${step}`)).toBe(expected);
      expect(inlineVar(`--color-brand-${step}`)).toBe(expected);
    }
  });

  it('keeps the three families in step with each other', () => {
    applyBrandColor('#5b8c3e');
    for (const step of STEPS) {
      expect(inlineVar(`--p-primary-${step}`)).toBe(inlineVar(`--p-brand-${step}`));
      expect(inlineVar(`--color-brand-${step}`)).toBe(inlineVar(`--p-brand-${step}`));
    }
  });

  it('sets a readable text colour for both schemes', () => {
    applyBrandColor('#ffe400');
    // A pale brand needs dark text on it, in light mode and in dark mode alike:
    // dark mode uses the lighter 300 step, which is paler still.
    expect(inlineVar('--brand-contrast')).toBe('#000000');
    expect(inlineVar('--brand-contrast-dark')).toBe('#000000');

    applyBrandColor('#113d4c');
    expect(inlineVar('--brand-contrast')).toBe('#ffffff');
  });

  it('follows the browser chrome', () => {
    applyBrandColor('#6b4bb3');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#6b4bb3');
  });

  it('clears the overrides for the shipped colour instead of recomputing it', () => {
    applyBrandColor('#1f6f8b');
    expect(inlineVar('--p-brand-600')).not.toBe('');

    applyBrandColor(DEFAULT_APPEARANCE.brandColor);
    // The stylesheet's hand-tuned ramp is not what the generator produces from
    // the same seed, so the default has to fall back to the stylesheet rather
    // than pin a generated approximation of it.
    expect(rampFor(DEFAULT_APPEARANCE.brandColor)['600']).not.toBe(DEFAULT_APPEARANCE.brandColor);
    for (const step of STEPS) {
      expect(inlineVar(`--p-brand-${step}`)).toBe('');
      expect(inlineVar(`--p-primary-${step}`)).toBe('');
      expect(inlineVar(`--color-brand-${step}`)).toBe('');
    }
    expect(inlineVar('--brand-contrast')).toBe('');
  });

  it('suppresses transitions while the variables change, and only while they change', () => {
    // Chrome will not restart an in-flight `transition: background` when the
    // custom property behind it is rewritten, so the button the user is
    // looking at keeps the old colour unless the swap happens with transitions
    // off.
    const root = document.documentElement;
    const original = root.style.setProperty.bind(root.style);
    const classesDuringWrite: boolean[] = [];
    root.style.setProperty = (name: string, value: string, priority?: string) => {
      classesDuringWrite.push(root.classList.contains('brand-switching'));
      return original(name, value, priority);
    };

    applyBrandColor('#b3305e');
    root.style.setProperty = original;

    expect(classesDuringWrite.length).toBeGreaterThan(0);
    expect(classesDuringWrite.every(Boolean)).toBe(true);
    expect(root.classList.contains('brand-switching')).toBe(false);
  });

  it('rejects a colour it cannot parse without touching anything', () => {
    applyBrandColor('#1f6f8b');
    const before = document.documentElement.getAttribute('style');

    expect(applyBrandColor('not-a-colour')).toBeNull();
    expect(applyBrandColor('#fff')).toBeNull();
    expect(document.documentElement.getAttribute('style')).toBe(before);
  });
});

describe('resetBrandColor', () => {
  it('returns to the shipped stylesheet and forgets the choice', () => {
    applyBrandColor('#c98a2e');
    localStorage.setItem('crepelite:brandColor', '#c98a2e');

    resetBrandColor();

    expect(inlineVar('--p-brand-600')).toBe('');
    expect(localStorage.getItem('crepelite:brandColor')).toBeNull();
  });
});

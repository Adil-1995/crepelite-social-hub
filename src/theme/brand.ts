import { palette } from '@primeuix/themes';
import { DEFAULT_APPEARANCE, contrastTextFor, normaliseBrandColor } from '@shared/index';
import { withoutTransitions } from '@/theme/repaint';

/**
 * Runtime brand colour.
 *
 * The app is themed from one primitive ramp. `--p-brand-*` feeds the PrimeVue
 * preset (both its primitive palette and the `primary` semantic, which is a
 * copy of the same ramp rather than a reference to it) and `--color-brand-*`
 * feeds the Tailwind utilities. Changing the colour has to reach all three or
 * the buttons, the nav and the links end up disagreeing.
 *
 * Everything is written as inline custom properties on `:root`, which beat the
 * stylesheet without regenerating it. That matters because the colour picker
 * fires continuously while it is dragged.
 *
 * The chosen colour is cached in localStorage and applied before the first
 * paint, because waiting for Firestore would show the old colour and then
 * visibly repaint.
 */
const CACHE_KEY = 'crepelite:brandColor';

/** Every step the ramps define, in both the PrimeVue and the Tailwind naming. */
const STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'] as const;


/** PrimeVue's generator gives a 50–950 ramp from a single colour. */
export function rampFor(hex: string): Record<string, string> {
  return palette(hex) as Record<string, string>;
}

/**
 * Applies a colour everywhere it is used.
 *
 * Returns the ramp so callers can preview without committing.
 */
export function applyBrandColor(hex: string): Record<string, string> | null {
  const colour = normaliseBrandColor(hex);
  if (!colour) return null;

  const root = document.documentElement;
  const ramp = rampFor(colour);
  // The shipped colour has a hand-tuned ramp in the stylesheet that the
  // generator does not reproduce exactly, so the default clears the overrides
  // instead of recomputing them.
  const isDefault = colour === DEFAULT_APPEARANCE.brandColor;

  withoutTransitions(() => {
    for (const step of STEPS) {
      const value = ramp[step] ?? colour;
      setOrClear(root, `--p-brand-${step}`, isDefault ? null : value);
      setOrClear(root, `--p-primary-${step}`, isDefault ? null : value);
      setOrClear(root, `--color-brand-${step}`, isDefault ? null : value);
    }

    // Text that sits on the brand colour has to stay legible whatever is
    // picked; a pale brand with white text is unreadable.
    setOrClear(root, '--brand-contrast', isDefault ? null : contrastTextFor(colour));
    // In dark mode the preset uses the 300 step as the primary, which is much
    // lighter, so its contrast is computed separately.
    setOrClear(root, '--brand-contrast-dark', isDefault ? null : contrastTextFor(ramp['300'] ?? colour));
  });

  // The installed-app chrome should follow too.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colour);

  return ramp;
}

function setOrClear(root: HTMLElement, name: string, value: string | null): void {
  if (value === null) root.style.removeProperty(name);
  else root.style.setProperty(name, value);
}

export function cacheBrandColor(hex: string): void {
  try {
    localStorage.setItem(CACHE_KEY, hex);
  } catch {
    /* private mode — the colour still applies for this session */
  }
}

export function cachedBrandColor(): string {
  try {
    return normaliseBrandColor(localStorage.getItem(CACHE_KEY) ?? '') ?? DEFAULT_APPEARANCE.brandColor;
  } catch {
    return DEFAULT_APPEARANCE.brandColor;
  }
}

/** Applies the cached colour at startup, before anything is rendered. */
export function initBrandColor(): void {
  const cached = cachedBrandColor();
  if (cached !== DEFAULT_APPEARANCE.brandColor) applyBrandColor(cached);
}

/** Drops the override and returns to the shipped colour. */
export function resetBrandColor(): void {
  applyBrandColor(DEFAULT_APPEARANCE.brandColor);
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * CrepeLite brand tokens — the single source of truth for colour.
 *
 * These ramps are mirrored by the Tailwind `@theme` block in
 * `src/styles/main.css` (utilities such as `bg-brand-600`) and consumed by the
 * PrimeVue preset in `src/theme/crepelite-theme.ts`. Change a value here and in
 * `main.css` together — never override PrimeVue colours in a component.
 */

export const brand = {
  50: '#fff4ea',
  100: '#fde3cc',
  200: '#f9c79c',
  300: '#f1a466',
  400: '#e3843e',
  500: '#c9652f',
  600: '#b4562a',
  700: '#8f4222',
  800: '#6e331d',
  900: '#4e2515',
  950: '#2f150c',
} as const;

/** Warm cream surfaces for light mode. */
export const surfaceLight = {
  0: '#ffffff',
  50: '#fff8ef',
  100: '#f6ede2',
  200: '#eadccb',
  300: '#ddcab4',
  400: '#c0a68c',
  500: '#9c8a7b',
  600: '#8c7766',
  700: '#6b5646',
  800: '#4a392c',
  900: '#2b1d14',
  950: '#17120f',
} as const;

/** Warm charcoal surfaces for dark mode. */
export const surfaceDark = {
  0: '#ffffff',
  50: '#f7ede3',
  100: '#e6d9cb',
  200: '#c4b3a4',
  300: '#9c8a7b',
  400: '#7a6757',
  500: '#5c4c3f',
  600: '#3d3029',
  700: '#2d231d',
  800: '#221a15',
  900: '#17120f',
  950: '#0f0b09',
} as const;

export const radius = {
  none: '0',
  xs: '0.25rem',
  sm: '0.5rem',
  md: '0.75rem',
  lg: '0.875rem',
  xl: '1.125rem',
} as const;

/**
 * Minimum comfortable touch target. The app is mobile-first, so interactive
 * PrimeVue components are sized from this rather than from desktop defaults.
 */
export const touchTargetPx = 44;

/** CSS class toggled on `<html>` for dark mode (see `useThemeMode`). */
export const darkModeSelector = '.dark';

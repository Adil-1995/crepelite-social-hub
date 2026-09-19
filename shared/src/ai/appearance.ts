/**
 * Workspace appearance.
 *
 * The brand colour is a property of the business, not of the device, so it
 * lives with the workspace and everyone on the team sees the same thing. Dark
 * mode stays per-device, because that is a preference about the room you are
 * sitting in.
 */
export interface AppearanceSettings {
  /** Hex, e.g. `#b4562a`. The whole primary ramp is derived from it. */
  brandColor: string;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  brandColor: '#b4562a',
};

/** Ready-made choices, so nobody has to find a hex code to get started. */
export const BRAND_PRESETS = [
  { name: 'CrepeLite', value: '#b4562a' },
  { name: 'Chocolate', value: '#6f4322' },
  { name: 'Pistachio', value: '#5b8c3e' },
  { name: 'Berry', value: '#b3305e' },
  { name: 'Caramel', value: '#c98a2e' },
  { name: 'Ocean', value: '#1f6f8b' },
  { name: 'Grape', value: '#6b4bb3' },
  { name: 'Slate', value: '#44566b' },
] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isValidBrandColor(value: string): boolean {
  return HEX.test(value);
}

/** Normalises user input (`B4562A`, `#B4562A`) to `#b4562a`. */
export function normaliseBrandColor(value: string): string | null {
  const trimmed = value.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return HEX.test(withHash) ? withHash.toLowerCase() : null;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const channel = (i: number) => {
    const v = parseInt(n.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * Text colour to place on the brand colour.
 *
 * Compares the actual contrast ratio against both candidates and returns the
 * better one, rather than switching at a fixed lightness. A threshold looks
 * right for typical colours and quietly fails in the middle of the range,
 * where neither option is comfortable: the worst case is around 4.6:1, and
 * only pure black reaches it — a softened near-black drops it below the 4.5:1
 * the text needs.
 */
export function contrastTextFor(hex: string): '#ffffff' | '#000000' {
  const l = luminance(hex);
  const againstWhite = 1.05 / (l + 0.05);
  const againstBlack = (l + 0.05) / 0.05;
  return againstBlack > againstWhite ? '#000000' : '#ffffff';
}

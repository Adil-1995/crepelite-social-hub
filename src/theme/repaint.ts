/**
 * Recolouring the page without leaving parts of it behind.
 *
 * Every brand-coloured surface reads its colour through a custom property, and
 * PrimeVue animates those properties with `transition: background 0.2s`.
 * Chrome does not restart an in-flight transition when the custom property
 * behind it is rewritten, so an element that is on screen at that moment keeps
 * its old colour until something unrelated forces a recalculation — which is
 * precisely the button the user is looking at when they switch theme or pick a
 * brand colour.
 *
 * Doing the swap with transitions switched off sidesteps it. Nothing is lost:
 * a theme change is meant to be instant anyway.
 */
const SUPPRESS_CLASS = 'brand-switching';

export function withoutTransitions(write: () => void): void {
  const root = document.documentElement;
  root.classList.add(SUPPRESS_CLASS);
  try {
    write();
    // Resolve the new values while transitions are still off.
    void root.offsetHeight;
  } finally {
    root.classList.remove(SUPPRESS_CLASS);
  }
}

import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { withoutTransitions } from '@/theme/repaint';
import { useUiStore } from '@/stores/ui';

/**
 * Every brand-coloured surface reads its colour through a custom property that
 * PrimeVue animates. Chrome does not restart an in-flight transition when the
 * property behind it is rewritten, so whatever is on screen keeps its old
 * colour — the one thing a live theme switch must not do. Both entry points
 * that recolour the page therefore have to go through the suppression.
 */
beforeEach(() => {
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  localStorage.clear();
  setActivePinia(createPinia());
});

describe('withoutTransitions', () => {
  it('holds the class for the duration of the write and no longer', () => {
    const seen: boolean[] = [];
    expect(document.documentElement.classList.contains('brand-switching')).toBe(false);

    withoutTransitions(() => {
      seen.push(document.documentElement.classList.contains('brand-switching'));
    });

    expect(seen).toEqual([true]);
    expect(document.documentElement.classList.contains('brand-switching')).toBe(false);
  });

  it('does not strand the page with transitions disabled when the write throws', () => {
    expect(() =>
      withoutTransitions(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(document.documentElement.classList.contains('brand-switching')).toBe(false);
  });
});

describe('theme mode', () => {
  it('switches the scheme with transitions suppressed', () => {
    const ui = useUiStore();
    const root = document.documentElement;
    const suppressedWhenFlipped: boolean[] = [];
    const toggle = root.classList.toggle.bind(root.classList);
    root.classList.toggle = (token: string, force?: boolean) => {
      if (token === 'dark') suppressedWhenFlipped.push(root.classList.contains('brand-switching'));
      return toggle(token, force);
    };

    ui.setThemeMode('dark');
    root.classList.toggle = toggle;

    expect(root.classList.contains('dark')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');
    // The class change that flips the scheme has to land while transitions
    // are off, and the page must not be left with them disabled.
    expect(suppressedWhenFlipped).toEqual([true]);
    expect(root.classList.contains('brand-switching')).toBe(false);
  });

  it('still remembers the choice', () => {
    const ui = useUiStore();
    ui.setThemeMode('light');
    expect(localStorage.getItem('crepelite:theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

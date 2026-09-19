import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { withoutTransitions } from '@/theme/repaint';

export type ThemeMode = 'light' | 'dark' | 'system';

const THEME_KEY = 'crepelite:theme';

function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

/**
 * App chrome state. Transient feedback (toasts) and confirmations are NOT here:
 * they come from PrimeVue's ToastService / ConfirmationService through
 * `useFeedback()`. See `docs/ui-architecture.md`.
 */
export const useUiStore = defineStore('ui', () => {
  const themeMode = ref<ThemeMode>(readStoredMode());
  const systemDark = ref(prefersDark());
  /** Mobile navigation drawer (PrimeVue Drawer `visible` model). */
  const navDrawerOpen = ref(false);
  /** Set by the service worker when a new build is waiting. */
  const updateAvailable = ref(false);
  const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine);

  const isDark = computed(() => (themeMode.value === 'system' ? systemDark.value : themeMode.value === 'dark'));

  /** Applies the `.dark` class PrimeVue's `darkModeSelector` and Tailwind both read. */
  function applyTheme() {
    // Suppressed transitions, or the elements already on screen keep their old
    // colours — see theme/repaint.ts.
    withoutTransitions(() => {
      document.documentElement.classList.toggle('dark', isDark.value);
      document.documentElement.style.colorScheme = isDark.value ? 'dark' : 'light';
    });
  }

  function setThemeMode(mode: ThemeMode) {
    themeMode.value = mode;
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      /* private mode — the in-memory value still applies */
    }
    applyTheme();
  }

  /** Called once from `main.ts` after the pinia instance exists. */
  function initTheme() {
    applyTheme();
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      systemDark.value = e.matches;
      if (themeMode.value === 'system') applyTheme();
    });
    window.addEventListener('online', () => (online.value = true));
    window.addEventListener('offline', () => (online.value = false));
  }

  return { themeMode, isDark, setThemeMode, initTheme, navDrawerOpen, updateAvailable, online };
});

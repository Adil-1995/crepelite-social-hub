import type { App } from 'vue';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import ConfirmationService from 'primevue/confirmationservice';
import DialogService from 'primevue/dialogservice';
import Tooltip from 'primevue/tooltip';
import FocusTrap from 'primevue/focustrap';
import { CrepeLitePreset, themeOptions } from '@/theme/crepelite-theme';

/**
 * Global PrimeVue installation.
 *
 * PrimeVue is the official UI library for CrepeLite: toasts, confirmations,
 * overlays, focus trapping and accessible primitives all come from here rather
 * than from hand-written components. See `docs/ui-architecture.md`.
 */
export function installPrimeVue(app: App): void {
  app.use(PrimeVue, {
    theme: {
      preset: CrepeLitePreset,
      options: themeOptions,
    },
    // Ripple is off: it fights with native touch feedback on mobile.
    ripple: false,
    inputVariant: 'outlined',
    // Mobile-first default sizing for form fields and buttons.
    pt: undefined,
    ptOptions: { mergeSections: true, mergeProps: true },
    zIndex: {
      modal: 1100,
      overlay: 1000,
      menu: 1000,
      tooltip: 1200,
    },
    locale: undefined,
  });

  app.use(ToastService);
  app.use(ConfirmationService);
  app.use(DialogService);

  app.directive('tooltip', Tooltip);
  app.directive('focustrap', FocusTrap);
}

import { ref } from 'vue';
import { registerSW } from 'virtual:pwa-register';

/**
 * PWA lifecycle: update prompt + install affordance.
 *
 * The service worker is registered with `registerType: 'prompt'`, so a new
 * build never swaps under the user's feet — `updateAvailable` drives a Toast
 * and `applyUpdate()` performs the swap.
 */
export const updateAvailable = ref(false);
export const offlineReady = ref(false);
export const installPromptAvailable = ref(false);

let applySW: ((reload?: boolean) => Promise<void>) | null = null;
let deferredInstall: BeforeInstallPromptEvent | null = null;

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function initPwa(): void {
  applySW = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateAvailable.value = true;
    },
    onOfflineReady() {
      offlineReady.value = true;
    },
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    // Keep the browser mini-infobar suppressed; we show our own affordance.
    e.preventDefault();
    deferredInstall = e as BeforeInstallPromptEvent;
    installPromptAvailable.value = true;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    installPromptAvailable.value = false;
  });
}

export async function applyUpdate(): Promise<void> {
  updateAvailable.value = false;
  await applySW?.(true);
}

/** Returns true when the user accepted the install prompt. */
export async function promptInstall(): Promise<boolean> {
  if (!deferredInstall) return false;
  await deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  deferredInstall = null;
  installPromptAvailable.value = false;
  return outcome === 'accepted';
}

/** True when running as an installed app rather than a browser tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

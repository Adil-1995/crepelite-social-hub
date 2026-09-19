import { computed, ref } from 'vue';
import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
import { firebaseApp } from '@/app/firebase';
import { api } from '@/services/api';
import { useFeedback } from '@/composables/useFeedback';

/**
 * Web push registration (FCM).
 *
 * The token is registered against the signed-in user server-side; nothing about
 * the device is kept in local state beyond the permission status.
 */
const supported = ref(false);
const permission = ref<NotificationPermission>(
  typeof Notification === 'undefined' ? 'default' : Notification.permission,
);

void isSupported()
  .then((ok) => {
    supported.value = ok && typeof Notification !== 'undefined';
  })
  .catch(() => {
    supported.value = false;
  });

export function usePush() {
  const { info, reportApiError } = useFeedback();
  const enabled = computed(() => permission.value === 'granted');
  const blocked = computed(() => permission.value === 'denied');

  /** Asks for permission, gets a token and registers it. Returns success. */
  async function enable(): Promise<boolean> {
    if (!supported.value) return false;
    try {
      const result = await Notification.requestPermission();
      permission.value = result;
      if (result !== 'granted') return false;

      const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
      if (!vapidKey) {
        info('Push is not configured', 'This deployment has no web push key set.');
        return false;
      }

      const messaging = getMessaging(firebaseApp);
      const registration = await navigator.serviceWorker.ready;
      const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
      if (!token) return false;

      await api.registerPushToken({ token, platform: navigator.userAgent.slice(0, 200) });

      // Foreground messages do not raise a system notification: surface them.
      onMessage(messaging, (payload) => {
        const title = payload.notification?.title;
        if (title) info(title, payload.notification?.body);
      });

      return true;
    } catch (e) {
      reportApiError(e, 'Could not enable push notifications');
      return false;
    }
  }

  return { supported, permission, enabled, blocked, enable };
}

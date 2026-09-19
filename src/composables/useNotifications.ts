import { computed } from 'vue';
import { collection, limit, orderBy, query } from 'firebase/firestore';
import { db } from '@/app/firebase';
import { useLiveQuery } from '@/composables/useFirestore';
import { useAuthStore } from '@/stores/auth';
import { useWorkspaceStore } from '@/stores/workspace';
import type { AppNotification } from '@shared/index';

/**
 * Recent workspace notifications. Bounded to the newest 50 so the bell badge
 * never costs an unbounded read.
 */
export function useNotifications(max = 50) {
  const ws = useWorkspaceStore();
  const auth = useAuthStore();

  const { items, loading, error } = useLiveQuery<AppNotification>(
    () =>
      ws.workspaceId
        ? query(collection(db, `workspaces/${ws.workspaceId}/notifications`), orderBy('createdAt', 'desc'), limit(max))
        : null,
    [() => ws.workspaceId],
  );

  const uid = computed(() => auth.user?.uid ?? '');
  const unread = computed(() => items.value.filter((n) => !(n.readBy ?? []).includes(uid.value)));
  const unreadCount = computed(() => unread.value.length);

  return { notifications: items, unread, unreadCount, loading, error };
}

/**
 * Unread count for the navigation badge.
 *
 * Firestore has no "array does not contain" operator, so unread is derived
 * client-side from the same bounded window `useNotifications` already reads —
 * no extra query, no extra reads.
 */
export function useUnreadCount() {
  return useNotifications(50).unreadCount;
}

import { computed } from 'vue';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { DateTime } from 'luxon';
import { Timestamp } from 'firebase/firestore';
import type { Delivery, Post } from '@shared/index';
import { db } from '@/app/firebase';
import { useLiveQuery } from '@/composables/useFirestore';
import { useWorkspaceStore } from '@/stores/workspace';

/**
 * Dashboard data.
 *
 * Three bounded realtime queries, each backed by an index in
 * firestore.indexes.json. No polling and no unbounded listeners — the counts
 * are derived from the same snapshots the lists already render.
 */
export function useDashboard() {
  const ws = useWorkspaceStore();

  const dayBounds = computed(() => {
    const now = DateTime.now().setZone(ws.timezone);
    return {
      start: Timestamp.fromMillis(now.startOf('day').toMillis()),
      end: Timestamp.fromMillis(now.endOf('day').toMillis()),
    };
  });

  /** Everything scheduled for the local day, in either direction of "now". */
  const today = useLiveQuery<Delivery>(
    () =>
      ws.workspaceId
        ? query(
            collection(db, `workspaces/${ws.workspaceId}/deliveries`),
            where('scheduledAt', '>=', dayBounds.value.start),
            where('scheduledAt', '<=', dayBounds.value.end),
            orderBy('scheduledAt', 'asc'),
            limit(100),
          )
        : null,
    [() => ws.workspaceId, () => ws.timezone],
  );

  /** Deliveries a human has to deal with. */
  const attention = useLiveQuery<Delivery>(
    () =>
      ws.workspaceId
        ? query(
            collection(db, `workspaces/${ws.workspaceId}/deliveries`),
            where('status', 'in', ['failed', 'needs_reauth']),
            orderBy('updatedAt', 'desc'),
            limit(20),
          )
        : null,
    [() => ws.workspaceId],
  );

  /** Next posts going out, regardless of day. */
  const upcoming = useLiveQuery<Post>(
    () =>
      ws.workspaceId
        ? query(
            collection(db, `workspaces/${ws.workspaceId}/posts`),
            where('status', 'in', ['scheduled', 'publishing']),
            orderBy('calendarAt', 'asc'),
            limit(10),
          )
        : null,
    [() => ws.workspaceId],
  );

  const counts = computed(() => {
    const list = today.items.value;
    const count = (...statuses: Delivery['status'][]) => list.filter((d) => statuses.includes(d.status)).length;
    return {
      scheduledToday: count('queued', 'awaiting_queue'),
      publishedToday: count('published'),
      processing: count('publishing', 'processing'),
      failed: count('failed'),
      needsAttention: attention.items.value.length,
    };
  });

  const loading = computed(() => today.loading.value || attention.loading.value || upcoming.loading.value);
  const error = computed(() => today.error.value ?? attention.error.value ?? upcoming.error.value);

  function refresh() {
    today.refresh();
    attention.refresh();
    upcoming.refresh();
  }

  return {
    todayDeliveries: today.items,
    attentionDeliveries: attention.items,
    upcomingPosts: upcoming.items,
    counts,
    loading,
    error,
    refresh,
  };
}

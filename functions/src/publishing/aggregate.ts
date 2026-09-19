import type { Transaction } from 'firebase-admin/firestore';
import { derivePostStatus, type Delivery, type DeliverySummaryEntry, type PostStatus } from '@shared/index';
import { FieldValue, Timestamp, db, paths } from '../utils/firestore';

export interface PostAggregate {
  status: PostStatus;
  deliverySummary: Record<string, DeliverySummaryEntry>;
  calendarAt: Timestamp | null;
}

export function summarize(deliveries: Delivery[], fallbackCalendarAt: Timestamp | null = null): PostAggregate {
  const deliverySummary: Record<string, DeliverySummaryEntry> = {};
  let earliest: number | null = null;
  for (const d of deliveries) {
    deliverySummary[d.channelId] = {
      deliveryId: d.id,
      provider: d.provider,
      status: d.status,
      scheduledAt: d.scheduledAt ?? null,
      externalPostUrl: d.externalPostUrl ?? null,
      errorMessage: d.error?.message ?? null,
    };
    const at = d.publishedAt?.toMillis() ?? d.scheduledAt?.toMillis() ?? null;
    if (d.status !== 'cancelled' && at != null && (earliest == null || at < earliest)) earliest = at;
  }
  return {
    status: derivePostStatus(deliveries.map((d) => d.status)),
    deliverySummary,
    calendarAt: earliest != null ? Timestamp.fromMillis(earliest) : fallbackCalendarAt,
  };
}

/** Reads every delivery of a post inside a transaction (must run before any tx write). */
export async function readPostDeliveries(tx: Transaction, workspaceId: string, postId: string): Promise<Delivery[]> {
  const q = db().collection(paths.deliveries(workspaceId)).where('postId', '==', postId);
  const snap = await tx.get(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Delivery);
}

/** Applies overrides (deliveries changed in this tx) and writes the post aggregate. */
export function writePostAggregate(
  tx: Transaction,
  workspaceId: string,
  postId: string,
  deliveries: Delivery[],
  overrides: Map<string, Partial<Delivery>>,
  extra: Record<string, unknown> = {},
): PostAggregate {
  const merged = deliveries.map((d) => (overrides.has(d.id) ? ({ ...d, ...overrides.get(d.id) } as Delivery) : d));
  for (const [id, o] of overrides) if (!deliveries.some((d) => d.id === id)) merged.push({ id, ...o } as Delivery);
  const agg = summarize(merged);
  tx.update(db().doc(paths.post(workspaceId, postId)), {
    status: agg.status,
    deliverySummary: agg.deliverySummary,
    ...(agg.calendarAt ? { calendarAt: agg.calendarAt } : {}),
    updatedAt: FieldValue.serverTimestamp(),
    ...extra,
  });
  return agg;
}

/**
 * Two-layer scheduling strategy.
 *
 * Cloud Tasks accepts a scheduleTime at most ~30 days ahead. Deliveries inside
 * the window get a Cloud Task immediately (layer 1); later ones are stored as
 * `awaiting_queue` and promoted by the daily `queueUpcomingDeliveries` job (layer 2).
 * The job uses the same window, so a delivery is always enqueued ≥ 1 day before
 * Cloud Tasks' hard limit is relevant and never lost.
 */
export const CLOUD_TASKS_MAX_SCHEDULE_DAYS = 30;
export const QUEUE_WINDOW_DAYS = 29;
const DAY_MS = 24 * 60 * 60 * 1000;

export function queueWindowEnd(now: Date | number): number {
  const ms = typeof now === 'number' ? now : now.getTime();
  return ms + QUEUE_WINDOW_DAYS * DAY_MS;
}

export type QueueLayer = 'task' | 'awaiting_queue';

export function queueLayerFor(scheduledAtMs: number, now: Date | number): QueueLayer {
  return scheduledAtMs <= queueWindowEnd(now) ? 'task' : 'awaiting_queue';
}

/** Deterministic Cloud Task id. One id per (delivery, scheduleVersion, attempt) → enqueue is idempotent. */
export function deliveryTaskId(deliveryId: string, scheduleVersion: number, attempt = 0): string {
  const safe = deliveryId.replace(/[^A-Za-z0-9_-]/g, '_');
  return attempt > 0 ? `dlv-${safe}-v${scheduleVersion}-r${attempt}` : `dlv-${safe}-v${scheduleVersion}`;
}

export function statusCheckTaskId(deliveryId: string, scheduleVersion: number, check: number): string {
  const safe = deliveryId.replace(/[^A-Za-z0-9_-]/g, '_');
  return `chk-${safe}-v${scheduleVersion}-c${check}`;
}

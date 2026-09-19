import type { DeliveryStatus, PostStatus } from './types';

/**
 * Allowed delivery transitions. Every server-side status write goes through
 * `assertTransition` so an illegal jump (e.g. published → queued) is impossible.
 */
export const DELIVERY_TRANSITIONS: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  draft: ['awaiting_queue', 'queued', 'cancelled'],
  awaiting_queue: ['queued', 'awaiting_queue', 'cancelled', 'draft'],
  queued: ['publishing', 'queued', 'awaiting_queue', 'cancelled', 'draft', 'needs_reauth', 'failed'],
  publishing: ['published', 'processing', 'failed', 'needs_reauth', 'queued'],
  processing: ['published', 'failed', 'processing', 'needs_reauth', 'queued'],
  failed: ['queued', 'awaiting_queue', 'cancelled', 'draft', 'published'],
  needs_reauth: ['queued', 'awaiting_queue', 'cancelled', 'draft'],
  // `published` is terminal for scheduling. Edits of published content use provider updatePublished.
  published: [],
  cancelled: ['draft', 'queued', 'awaiting_queue'],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: DeliveryStatus,
    public readonly to: DeliveryStatus,
  ) {
    super(`Illegal delivery transition ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: DeliveryStatus, to: DeliveryStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** Statuses in which a delivery is waiting to run and may be rescheduled or cancelled. */
export const PENDING_STATUSES: readonly DeliveryStatus[] = ['awaiting_queue', 'queued'];
/** Statuses in which an external call may be in flight — no edits allowed. */
export const IN_FLIGHT_STATUSES: readonly DeliveryStatus[] = ['publishing', 'processing'];
/** Statuses that need a human. */
export const ATTENTION_STATUSES: readonly DeliveryStatus[] = ['failed', 'needs_reauth'];

export function isEditableDelivery(status: DeliveryStatus): boolean {
  return !IN_FLIGHT_STATUSES.includes(status) && status !== 'published';
}

/**
 * Aggregated post status derived from its deliveries. Deliveries are independent:
 * a failing network never blocks the others.
 */
export function derivePostStatus(statuses: readonly DeliveryStatus[]): PostStatus {
  if (statuses.length === 0) return 'draft';
  const active = statuses.filter((s) => s !== 'cancelled');
  if (active.length === 0) return 'cancelled';
  if (active.every((s) => s === 'draft')) return 'draft';

  const published = active.filter((s) => s === 'published').length;
  const failed = active.filter((s) => s === 'failed' || s === 'needs_reauth').length;
  const inFlight = active.some((s) => s === 'publishing' || s === 'processing');
  const pending = active.some((s) => s === 'queued' || s === 'awaiting_queue');

  if (inFlight) return 'publishing';
  if (pending) return published > 0 ? 'publishing' : 'scheduled';
  if (published > 0 && failed === 0) return 'published';
  if (published > 0 && failed > 0) return 'partially_published';
  if (failed > 0) return 'failed';
  return 'draft';
}

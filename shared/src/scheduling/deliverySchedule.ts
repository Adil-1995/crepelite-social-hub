/**
 * Computes the effective scheduledAt of each delivery from the post time,
 * an optional per-variant absolute override and per-platform minute offsets.
 */
export interface VariantTiming {
  channelId: string;
  offsetMinutes: number;
  scheduledAtOverrideMs: number | null;
}

export function effectiveDeliveryTime(postScheduledAtMs: number | null, timing: VariantTiming): number | null {
  if (timing.scheduledAtOverrideMs != null) return timing.scheduledAtOverrideMs;
  if (postScheduledAtMs == null) return null;
  return postScheduledAtMs + Math.round(timing.offsetMinutes) * 60_000;
}

export const MAX_OFFSET_MINUTES = 7 * 24 * 60;

/** A minimum lead time so a "scheduled" post is not accidentally in the past once saved. */
export const MIN_SCHEDULE_LEAD_MS = 60_000;

export function isInPast(ms: number, now: number, graceMs = MIN_SCHEDULE_LEAD_MS): boolean {
  return ms < now - graceMs;
}

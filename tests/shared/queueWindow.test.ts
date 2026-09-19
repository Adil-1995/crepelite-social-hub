import { describe, expect, it } from 'vitest';
import {
  CLOUD_TASKS_MAX_SCHEDULE_DAYS,
  MAX_OFFSET_MINUTES,
  MIN_SCHEDULE_LEAD_MS,
  QUEUE_WINDOW_DAYS,
  deliveryTaskId,
  effectiveDeliveryTime,
  isInPast,
  queueLayerFor,
  queueWindowEnd,
  statusCheckTaskId,
} from '@shared/index';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-19T12:00:00.000Z');

describe('two-layer queue window', () => {
  it('stays inside the Cloud Tasks limit', () => {
    // Cloud Tasks refuses a schedule time more than 30 days out, so the window
    // must leave headroom rather than sit exactly on the boundary.
    expect(QUEUE_WINDOW_DAYS).toBeLessThan(CLOUD_TASKS_MAX_SCHEDULE_DAYS);
  });

  it('ends QUEUE_WINDOW_DAYS from now', () => {
    expect(queueWindowEnd(NOW)).toBe(NOW + QUEUE_WINDOW_DAYS * DAY);
  });

  it('queues a task for anything inside the window', () => {
    expect(queueLayerFor(NOW + 60_000, NOW)).toBe('task');
    expect(queueLayerFor(NOW + 10 * DAY, NOW)).toBe('task');
    expect(queueLayerFor(NOW + (QUEUE_WINDOW_DAYS - 1) * DAY, NOW)).toBe('task');
  });

  it('holds anything beyond the window until the daily sweep', () => {
    expect(queueLayerFor(NOW + (QUEUE_WINDOW_DAYS + 1) * DAY, NOW)).toBe('awaiting_queue');
    expect(queueLayerFor(NOW + 365 * DAY, NOW)).toBe('awaiting_queue');
  });

  it('treats a past instant as immediately queueable', () => {
    expect(queueLayerFor(NOW - DAY, NOW)).toBe('task');
  });
});

describe('task identifiers', () => {
  it('changes when the schedule version changes', () => {
    // A stale task must not collide with the new one, which is what makes the
    // old invocation a safe no-op.
    expect(deliveryTaskId('d1', 1)).not.toBe(deliveryTaskId('d1', 2));
  });

  it('changes per attempt', () => {
    expect(deliveryTaskId('d1', 1, 0)).not.toBe(deliveryTaskId('d1', 1, 1));
  });

  it('is stable for the same inputs', () => {
    expect(deliveryTaskId('d1', 3, 2)).toBe(deliveryTaskId('d1', 3, 2));
  });

  it('produces Cloud Tasks-safe names', () => {
    for (const id of [deliveryTaskId('d1', 1, 0), statusCheckTaskId('d1', 1, 0)]) {
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(id.length).toBeLessThanOrEqual(500);
    }
  });

  it('never collides with a status-check task', () => {
    expect(deliveryTaskId('d1', 1, 0)).not.toBe(statusCheckTaskId('d1', 1, 0));
  });
});

describe('effectiveDeliveryTime', () => {
  it('returns null for an unscheduled post', () => {
    expect(effectiveDeliveryTime(null, { offsetMinutes: 0, scheduledAtOverrideMs: null })).toBeNull();
  });

  it('adds the per-variant offset', () => {
    expect(effectiveDeliveryTime(NOW, { offsetMinutes: 30, scheduledAtOverrideMs: null })).toBe(NOW + 30 * 60_000);
  });

  it('lets an absolute override win over the offset', () => {
    const override = NOW + 5 * DAY;
    expect(effectiveDeliveryTime(NOW, { offsetMinutes: 30, scheduledAtOverrideMs: override })).toBe(override);
  });

  it('caps the offset at one week', () => {
    expect(MAX_OFFSET_MINUTES).toBe(7 * 24 * 60);
  });
});

describe('isInPast', () => {
  it('accepts any future instant', () => {
    expect(isInPast(NOW + 1000, NOW)).toBe(false);
    expect(isInPast(NOW + MIN_SCHEDULE_LEAD_MS + 1000, NOW)).toBe(false);
  });

  it('tolerates small clock skew rather than rejecting a just-passed time', () => {
    // graceMs exists so a save that takes a moment does not turn a valid
    // schedule into a past one.
    expect(isInPast(NOW - 1000, NOW)).toBe(false);
    expect(isInPast(NOW - MIN_SCHEDULE_LEAD_MS + 1, NOW)).toBe(false);
  });

  it('rejects a time beyond the grace window', () => {
    expect(isInPast(NOW - MIN_SCHEDULE_LEAD_MS - 1, NOW)).toBe(true);
    expect(isInPast(NOW - 60 * 60 * 1000, NOW)).toBe(true);
  });

  it('honours an explicit grace override', () => {
    expect(isInPast(NOW - 5000, NOW, 0)).toBe(true);
    expect(isInPast(NOW - 5000, NOW, 10_000)).toBe(false);
  });
});

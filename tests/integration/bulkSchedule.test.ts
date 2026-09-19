import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { planBulkSchedule } from '@shared/index';
import { adminDb, WORKSPACE_ID, clearFirestore, shutdown } from './helpers';

/**
 * Bulk scheduling, end to end against the emulator.
 *
 * The scenario the spec calls out: 30 posts across October, one per day. What
 * matters is that the server produces exactly 30 posts on 30 distinct local
 * days, with one delivery per destination and no duplicate delivery ids — a
 * collision there would mean two posts fighting over the same Cloud Task.
 *
 * Requires the Firestore emulator (and therefore a JDK): `npm run test:emulator`.
 */
const TZ = 'Africa/Casablanca';

beforeEach(clearFirestore);
afterAll(shutdown);

/**
 * Mirrors what the server does with a plan: one post per entry, one variant and
 * one delivery per (post, channel), using the deterministic id convention.
 */
async function materialise(plan: ReturnType<typeof planBulkSchedule>, channelIds: string[], jobId: string) {
  const db = adminDb();
  let batch = db.batch();
  let ops = 0;

  for (const entry of plan.entries) {
    const postId = `${jobId}_${entry.itemId}`;
    batch.set(db.doc(`workspaces/${WORKSPACE_ID}/posts/${postId}`), {
      id: postId,
      workspaceId: WORKSPACE_ID,
      status: 'scheduled',
      calendarAt: new Date(entry.scheduledAtMs),
      schedule: { scheduledAt: new Date(entry.scheduledAtMs), timezone: TZ },
      channelIds,
      source: { kind: 'bulk', bulkJobId: jobId },
      revision: 1,
    });
    ops++;

    for (const channelId of channelIds) {
      const deliveryId = `${postId}_${channelId}`;
      batch.set(db.doc(`workspaces/${WORKSPACE_ID}/deliveries/${deliveryId}`), {
        id: deliveryId,
        workspaceId: WORKSPACE_ID,
        postId,
        channelId,
        provider: 'mock',
        status: 'queued',
        scheduledAt: new Date(entry.scheduledAtMs),
        scheduleVersion: 1,
      });
      ops++;
      // Firestore batches cap at 500 writes.
      if (ops >= 400) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
  }
  if (ops) await batch.commit();
}

describe('30 posts across October, one per day', () => {
  const channelIds = ['ch-a', 'ch-b'];
  const jobId = 'bulk1';

  it('creates 30 posts on 30 distinct days with no duplicate deliveries', async () => {
    const plan = planBulkSchedule({
      itemIds: Array.from({ length: 30 }, (_, i) => `item${i + 1}`),
      from: '2026-10-01',
      to: '2026-10-30',
      timezone: TZ,
      times: ['10:00'],
      frequency: { type: 'daily' },
      distribution: 'sequential',
    });

    expect(plan.entries).toHaveLength(30);
    expect(plan.unassignedItemIds).toEqual([]);

    await materialise(plan, channelIds, jobId);

    const posts = await adminDb().collection(`workspaces/${WORKSPACE_ID}/posts`).get();
    expect(posts.size).toBe(30);

    // One local day each, at the requested wall-clock time.
    const days = posts.docs.map((d) =>
      DateTime.fromJSDate(d.data().calendarAt.toDate(), { zone: TZ }).toFormat('yyyy-MM-dd'),
    );
    expect(new Set(days).size).toBe(30);

    for (const doc of posts.docs) {
      const local = DateTime.fromJSDate(doc.data().calendarAt.toDate(), { zone: TZ });
      expect(local.toFormat('HH:mm')).toBe('10:00');
      expect(local.month).toBe(10);
    }

    // 30 posts × 2 destinations, every id unique.
    const deliveries = await adminDb().collection(`workspaces/${WORKSPACE_ID}/deliveries`).get();
    expect(deliveries.size).toBe(60);
    const ids = deliveries.docs.map((d) => d.id);
    expect(new Set(ids).size).toBe(60);
  });

  it('is idempotent: re-running the same job does not double up', async () => {
    const plan = planBulkSchedule({
      itemIds: Array.from({ length: 10 }, (_, i) => `item${i + 1}`),
      from: '2026-10-01',
      to: '2026-10-10',
      timezone: TZ,
      times: ['10:00'],
      frequency: { type: 'daily' },
      distribution: 'sequential',
    });

    await materialise(plan, channelIds, 'bulk2');
    await materialise(plan, channelIds, 'bulk2');

    // Deterministic ids mean the second run overwrites rather than appends.
    const posts = await adminDb().collection(`workspaces/${WORKSPACE_ID}/posts`).get();
    const deliveries = await adminDb().collection(`workspaces/${WORKSPACE_ID}/deliveries`).get();
    expect(posts.size).toBe(10);
    expect(deliveries.size).toBe(20);
  });
});

describe('weekday-restricted plans', () => {
  it('only schedules on the chosen weekdays', async () => {
    const plan = planBulkSchedule({
      itemIds: Array.from({ length: 8 }, (_, i) => `item${i + 1}`),
      from: '2026-10-01',
      to: '2026-10-31',
      timezone: TZ,
      times: ['09:00'],
      frequency: { type: 'weekdays', weekdays: [1, 3, 5] },
      distribution: 'sequential',
    });

    await materialise(plan, ['ch-a'], 'bulk3');

    const posts = await adminDb().collection(`workspaces/${WORKSPACE_ID}/posts`).get();
    expect(posts.size).toBe(8);

    for (const doc of posts.docs) {
      const weekday = DateTime.fromJSDate(doc.data().calendarAt.toDate(), { zone: TZ }).weekday;
      expect([1, 3, 5]).toContain(weekday);
    }
  });
});

describe('the queue window', () => {
  it('splits a long range into queued and awaiting_queue', async () => {
    const now = Date.now();
    const plan = planBulkSchedule({
      itemIds: Array.from({ length: 40 }, (_, i) => `item${i + 1}`),
      from: DateTime.now().plus({ days: 1 }).toFormat('yyyy-MM-dd'),
      to: DateTime.now().plus({ days: 40 }).toFormat('yyyy-MM-dd'),
      timezone: TZ,
      times: ['10:00'],
      frequency: { type: 'daily' },
      distribution: 'sequential',
      notBeforeMs: now,
    });

    const { queueLayerFor } = await import('@shared/index');
    const layers = plan.entries.map((e) => queueLayerFor(e.scheduledAtMs, now));

    // Anything past the window must wait for the daily sweep rather than
    // being handed to Cloud Tasks, which would reject it.
    expect(layers).toContain('task');
    expect(layers).toContain('awaiting_queue');
  });
});

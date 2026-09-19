import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { executeDelivery } from '../../functions/src/publishing/engine';
import { MockProvider } from '../../functions/src/providers/mock/mockProvider';
import {
  FakeDispatcher,
  clearFirestore,
  mockRegistry,
  readDelivery,
  readPost,
  seedPost,
  shutdown,
  taskPayload,
} from './helpers';

/**
 * The tests that matter most.
 *
 * Cloud Tasks guarantees *at-least-once* delivery, so the engine has to supply
 * the "at most once" half. Every assertion here is about a real way a customer
 * could end up with the same post published twice — or with a working
 * destination republished because a different one failed.
 *
 * `MockProvider.publishLog` records every *logical* publication, so a duplicate
 * shows up as a second entry even when the delivery document looks fine.
 *
 * Requires the Firestore emulator (and therefore a JDK): `npm run test:emulator`.
 */
const dispatcher = new FakeDispatcher();
const deps = () => ({ registry: mockRegistry(), dispatcher });

beforeEach(async () => {
  await clearFirestore();
  MockProvider.publishLog = [];
  dispatcher.reset();
});

afterAll(shutdown);

describe('duplicate task delivery', () => {
  it('publishes once when the same task runs twice', async () => {
    const [deliveryId] = await seedPost({ postId: 'p1', channels: [{ channelId: 'ch-a', outcome: 'success' }] });

    const first = await executeDelivery(taskPayload(deliveryId!), deps());
    const second = await executeDelivery(taskPayload(deliveryId!), deps());

    expect(first.action).toBe('published');
    // The second invocation must be a no-op, not a second publication.
    expect(second.action).toBe('ignored');
    expect(MockProvider.publishLog).toHaveLength(1);

    const delivery = await readDelivery(deliveryId!);
    expect(delivery?.status).toBe('published');
    expect(delivery?.externalPostId).toBeTruthy();
  });

  it('publishes once even when both tasks run concurrently', async () => {
    const [deliveryId] = await seedPost({ postId: 'p2', channels: [{ channelId: 'ch-a', outcome: 'success' }] });

    // The transactional claim is what makes this safe; without it both
    // executions would read `queued` and both would publish.
    const [a, b] = await Promise.all([
      executeDelivery(taskPayload(deliveryId!), deps()),
      executeDelivery(taskPayload(deliveryId!), deps()),
    ]);

    const actions = [a.action, b.action].sort();
    expect(actions).toContain('published');
    expect(MockProvider.publishLog).toHaveLength(1);
  });
});

describe('stale schedule version', () => {
  it('ignores a task whose scheduleVersion no longer matches', async () => {
    const [deliveryId] = await seedPost({ postId: 'p3', channels: [{ channelId: 'ch-a', outcome: 'success' }] });

    // Simulate a reschedule: the delivery moves to version 2, but the version-1
    // task still fires because Cloud Tasks cannot always be cancelled.
    const { adminDb, WORKSPACE_ID } = await import('./helpers');
    await adminDb().doc(`workspaces/${WORKSPACE_ID}/deliveries/${deliveryId}`).update({ scheduleVersion: 2 });

    const outcome = await executeDelivery(taskPayload(deliveryId!, 1), deps());

    expect(outcome.action).toBe('ignored');
    expect(MockProvider.publishLog).toHaveLength(0);

    const delivery = await readDelivery(deliveryId!);
    expect(delivery?.status).toBe('queued');
    expect(delivery?.externalPostId).toBeNull();
  });

  it('runs the new version normally', async () => {
    const [deliveryId] = await seedPost({ postId: 'p4', channels: [{ channelId: 'ch-a', outcome: 'success' }] });
    const { adminDb, WORKSPACE_ID } = await import('./helpers');
    await adminDb().doc(`workspaces/${WORKSPACE_ID}/deliveries/${deliveryId}`).update({ scheduleVersion: 2 });

    const outcome = await executeDelivery(taskPayload(deliveryId!, 2), deps());

    expect(outcome.action).toBe('published');
    expect(MockProvider.publishLog).toHaveLength(1);
  });
});

describe('cancelled delivery', () => {
  it('does not publish when a task fires after cancellation', async () => {
    const [deliveryId] = await seedPost({ postId: 'p5', channels: [{ channelId: 'ch-a', outcome: 'success' }] });
    const { adminDb, WORKSPACE_ID } = await import('./helpers');
    await adminDb().doc(`workspaces/${WORKSPACE_ID}/deliveries/${deliveryId}`).update({ status: 'cancelled' });

    const outcome = await executeDelivery(taskPayload(deliveryId!), deps());

    expect(outcome.action).toBe('ignored');
    expect(MockProvider.publishLog).toHaveLength(0);
  });
});

describe('partial publication', () => {
  it('leaves the post partially_published when one destination fails', async () => {
    const ids = await seedPost({
      postId: 'p6',
      channels: [
        { channelId: 'ch-facebook', outcome: 'success' },
        { channelId: 'ch-instagram', outcome: 'success' },
        { channelId: 'ch-tiktok', outcome: 'failure' },
      ],
    });

    for (const id of ids) await executeDelivery(taskPayload(id), deps());

    const post = await readPost('p6');
    expect(post?.status).toBe('partially_published');

    // The two that worked must be published, and published exactly once.
    expect(MockProvider.publishLog).toHaveLength(2);

    const fb = await readDelivery('p6_ch-facebook');
    const ig = await readDelivery('p6_ch-instagram');
    const tt = await readDelivery('p6_ch-tiktok');

    expect(fb?.status).toBe('published');
    expect(ig?.status).toBe('published');
    expect(tt?.status).toBe('failed');
    expect(tt?.error?.retryable).toBe(false);
  });

  it('retries only the failed destination, never the ones that worked', async () => {
    const ids = await seedPost({
      postId: 'p7',
      channels: [
        { channelId: 'ch-facebook', outcome: 'success' },
        { channelId: 'ch-instagram', outcome: 'success' },
        { channelId: 'ch-tiktok', outcome: 'rate_limit' },
      ],
    });
    for (const id of ids) await executeDelivery(taskPayload(id), deps());

    const publishedBefore = MockProvider.publishLog.length;
    expect(publishedBefore).toBe(2);

    const fbBefore = await readDelivery('p7_ch-facebook');

    // Re-queue TikTok the way a manual retry does, then run its task.
    const { adminDb, WORKSPACE_ID } = await import('./helpers');
    await adminDb().doc(`workspaces/${WORKSPACE_ID}/deliveries/p7_ch-tiktok`).update({
      status: 'queued',
      scheduleVersion: 2,
      error: null,
      publishingLease: null,
    });

    // This time the mock succeeds.
    await adminDb().doc(`workspaces/${WORKSPACE_ID}/postVariants/p7_ch-tiktok`).update({
      'providerSettings.mockOutcome': 'success',
    });

    const outcome = await executeDelivery(taskPayload('p7_ch-tiktok', 2), deps());
    expect(outcome.action).toBe('published');

    // Exactly one more publication — the other two were not touched.
    expect(MockProvider.publishLog).toHaveLength(publishedBefore + 1);
    expect(MockProvider.publishLog.filter((r) => r.deliveryId === 'p7_ch-facebook')).toHaveLength(1);

    const fbAfter = await readDelivery('p7_ch-facebook');
    expect(fbAfter?.externalPostId).toBe(fbBefore?.externalPostId);
    expect(fbAfter?.attemptCount).toBe(fbBefore?.attemptCount);

    const post = await readPost('p7');
    expect(post?.status).toBe('published');
  });
});

describe('error classification', () => {
  it('schedules an automatic retry for a retryable failure', async () => {
    const [deliveryId] = await seedPost({ postId: 'p8', channels: [{ channelId: 'ch-a', outcome: 'rate_limit' }] });

    const outcome = await executeDelivery(taskPayload(deliveryId!), deps());

    expect(outcome.action).toBe('retry_scheduled');
    expect(MockProvider.publishLog).toHaveLength(0);
    expect(dispatcher.enqueued.length).toBeGreaterThan(0);
  });

  it('does not retry a validation failure', async () => {
    const [deliveryId] = await seedPost({ postId: 'p9', channels: [{ channelId: 'ch-a', outcome: 'failure' }] });

    const outcome = await executeDelivery(taskPayload(deliveryId!), deps());

    expect(outcome.action).toBe('failed');
    const delivery = await readDelivery(deliveryId!);
    expect(delivery?.status).toBe('failed');
    expect(delivery?.error?.retryable).toBe(false);
  });

  it('marks an expired authorisation as needing reconnection', async () => {
    const [deliveryId] = await seedPost({ postId: 'p10', channels: [{ channelId: 'ch-a', outcome: 'auth_expired' }] });

    const outcome = await executeDelivery(taskPayload(deliveryId!), deps());

    expect(outcome.action).toBe('needs_reauth');
    const delivery = await readDelivery(deliveryId!);
    expect(delivery?.status).toBe('needs_reauth');
    // A reconnect is a human action: it must not be retried automatically.
    expect(delivery?.error?.retryable).toBe(false);
  });
});

describe('asynchronous processing', () => {
  it('checkpoints before the irreversible call and waits rather than republishing', async () => {
    const [deliveryId] = await seedPost({ postId: 'p11', channels: [{ channelId: 'ch-a', outcome: 'processing' }] });

    const outcome = await executeDelivery(taskPayload(deliveryId!), deps());

    expect(outcome.action).toBe('processing');
    const delivery = await readDelivery(deliveryId!);
    expect(delivery?.status).toBe('processing');
    // The checkpoint is what lets reconciliation resolve the real outcome
    // instead of creating a second post.
    expect(Object.keys(delivery?.processingMetadata ?? {}).length).toBeGreaterThan(0);
    expect(delivery?.nextStatusCheckAt).toBeTruthy();
  });

  it('does not publish again when a duplicate task arrives mid-processing', async () => {
    const [deliveryId] = await seedPost({ postId: 'p12', channels: [{ channelId: 'ch-a', outcome: 'processing' }] });

    await executeDelivery(taskPayload(deliveryId!), deps());
    const logAfterFirst = MockProvider.publishLog.length;

    const second = await executeDelivery(taskPayload(deliveryId!), deps());

    expect(second.action).toBe('ignored');
    expect(MockProvider.publishLog).toHaveLength(logAfterFirst);
  });
});

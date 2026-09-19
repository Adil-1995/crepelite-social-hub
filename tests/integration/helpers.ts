import { deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { MockOAuthAdapter, MockProvider } from '../../functions/src/providers/mock/mockProvider';
import { ProviderRegistry } from '../../functions/src/providers/registry';
import type { DeliveryTaskPayload, EnqueueOptions, TaskDispatcher, TaskKind, TaskTarget } from '../../functions/src/tasks/dispatcher';

/**
 * Shared harness for the emulator-backed integration tests.
 *
 * Requires the Firestore emulator (and therefore a JDK). Run with
 * `npm run test:emulator`.
 */
export const PROJECT_ID = 'demo-crepelite';
export const WORKSPACE_ID = 'ws-test';
export const CONNECTION_ID = 'conn-mock';

process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.GCLOUD_PROJECT ??= PROJECT_ID;

export function adminDb() {
  if (!getApps().length) initializeApp({ projectId: PROJECT_ID });
  return getFirestore();
}

/** Records what would have been enqueued, so tests can assert on scheduling. */
export class FakeDispatcher implements TaskDispatcher {
  enqueued: Array<{ target: TaskTarget; payload: DeliveryTaskPayload; opts: EnqueueOptions }> = [];
  cancelled: Array<{ kind: TaskKind; taskId: string }> = [];

  async enqueue(target: TaskTarget, payload: DeliveryTaskPayload, opts: EnqueueOptions): Promise<string> {
    this.enqueued.push({ target, payload, opts });
    return `task-${payload.deliveryId}-v${payload.scheduleVersion}-s${payload.seq}`;
  }

  async cancel(_target: TaskTarget, kind: TaskKind, taskId: string): Promise<void> {
    this.cancelled.push({ kind, taskId });
  }

  reset() {
    this.enqueued = [];
    this.cancelled = [];
  }
}

export function mockRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry({ allowDevOnly: true });
  registry.register(new MockProvider(new MockOAuthAdapter()));
  return registry;
}

export interface SeedChannel {
  channelId: string;
  /** One of MOCK_OUTCOMES: success, failure, processing, rate_limit, auth_expired… */
  outcome: string;
}

/**
 * Seeds one post with a variant and a delivery per channel, all ready to run.
 * Delivery ids follow the deterministic `{postId}_{channelId}` convention.
 */
export async function seedPost(opts: {
  postId: string;
  channels: SeedChannel[];
  scheduledAtMs?: number;
  status?: string;
}): Promise<string[]> {
  const db = adminDb();
  const now = Date.now();
  const scheduledAt = Timestamp.fromMillis(opts.scheduledAtMs ?? now - 1000);
  const batch = db.batch();
  const deliveryIds: string[] = [];

  batch.set(db.doc(`workspaces/${WORKSPACE_ID}/socialConnections/${CONNECTION_ID}`), {
    id: CONNECTION_ID,
    workspaceId: WORKSPACE_ID,
    provider: 'mock',
    authFamily: 'mock',
    accountName: 'Mock Account',
    status: 'connected',
    scopes: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  batch.set(db.doc(`workspaces/${WORKSPACE_ID}/posts/${opts.postId}`), {
    id: opts.postId,
    workspaceId: WORKSPACE_ID,
    titleInternal: opts.postId,
    masterContent: { text: 'hello', title: '', description: '', hashtags: [], link: '' },
    mediaIds: [],
    status: opts.status ?? 'scheduled',
    schedule: { scheduledAt, timezone: 'Africa/Casablanca' },
    channelIds: opts.channels.map((c) => c.channelId),
    internalNotes: '',
    source: { kind: 'manual' },
    deliverySummary: {},
    calendarAt: scheduledAt,
    searchKeywords: [],
    createdBy: 'tester',
    updatedBy: 'tester',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    revision: 1,
  });

  for (const ch of opts.channels) {
    const variantId = `${opts.postId}_${ch.channelId}`;
    const deliveryId = `${opts.postId}_${ch.channelId}`;
    deliveryIds.push(deliveryId);

    batch.set(db.doc(`workspaces/${WORKSPACE_ID}/socialChannels/${ch.channelId}`), {
      id: ch.channelId,
      workspaceId: WORKSPACE_ID,
      provider: 'mock',
      connectionId: CONNECTION_ID,
      externalId: `ext-${ch.channelId}`,
      name: ch.channelId,
      handle: null,
      avatarUrl: null,
      kind: 'mock',
      status: 'connected',
      enabled: true,
      metadata: {},
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    batch.set(db.doc(`workspaces/${WORKSPACE_ID}/postVariants/${variantId}`), {
      id: variantId,
      workspaceId: WORKSPACE_ID,
      postId: opts.postId,
      provider: 'mock',
      channelId: ch.channelId,
      syncMode: 'master',
      format: 'feed',
      content: { text: 'hello', title: '', description: '', hashtags: [], link: '' },
      mediaIds: null,
      // This is what tells MockProvider how to behave.
      providerSettings: { mockOutcome: ch.outcome },
      scheduledAtOverride: null,
      offsetMinutes: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    batch.set(db.doc(`workspaces/${WORKSPACE_ID}/deliveries/${deliveryId}`), {
      id: deliveryId,
      workspaceId: WORKSPACE_ID,
      postId: opts.postId,
      variantId,
      provider: 'mock',
      channelId: ch.channelId,
      connectionId: CONNECTION_ID,
      status: 'queued',
      scheduledAt,
      scheduleVersion: 1,
      taskName: `task-${deliveryId}-v1`,
      executor: 'functions',
      externalPostId: null,
      externalPostUrl: null,
      attemptCount: 0,
      autoRetryCount: 0,
      lastAttemptAt: null,
      publishedAt: null,
      publishingLease: null,
      error: null,
      processingMetadata: {},
      nextStatusCheckAt: null,
      statusCheckCount: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
  return deliveryIds;
}

export async function readDelivery(deliveryId: string) {
  const snap = await adminDb().doc(`workspaces/${WORKSPACE_ID}/deliveries/${deliveryId}`).get();
  return snap.data();
}

export async function readPost(postId: string) {
  const snap = await adminDb().doc(`workspaces/${WORKSPACE_ID}/posts/${postId}`).get();
  return snap.data();
}

export function taskPayload(deliveryId: string, scheduleVersion = 1, seq = 0): DeliveryTaskPayload {
  return { kind: 'execute', workspaceId: WORKSPACE_ID, deliveryId, scheduleVersion, seq };
}

/** Wipes the emulator between tests. */
export async function clearFirestore(): Promise<void> {
  const res = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`Could not clear the Firestore emulator: ${res.status}`);
}

export async function shutdown(): Promise<void> {
  await Promise.all(getApps().map((a) => deleteApp(a)));
}

import {
  IN_FLIGHT_STATUSES,
  deliveryTaskId,
  effectiveDeliveryTime,
  hasBlockingIssues,
  isInPast,
  queueLayerFor,
  resolveVariantContent,
  validateVariant,
  type Delivery,
  type DeliveryStatus,
  type Post,
  type PostVariant,
  type SocialChannel,
  type SocialConnection,
  type ValidationIssue,
} from '@shared/index';
import type { Transaction } from 'firebase-admin/firestore';
import { FieldValue, Timestamp, db, deliveryIdFor, paths } from '../utils/firestore';
import { fail } from '../utils/errors';
import { log } from '../utils/logger';
import type { ProviderRegistry } from '../providers/registry';
import { parseTaskName, type TaskDispatcher, type TaskTarget } from '../tasks/dispatcher';
import { readPostDeliveries, writePostAggregate } from '../publishing/aggregate';
import { audit, type AuditActor } from '../services/audit';
import { loadMediaAssets } from '../services/media';
import { OUTCOME_UNKNOWN } from '../publishing/engine';

export interface SchedulerDeps {
  registry: ProviderRegistry;
  dispatcher: TaskDispatcher;
  now?: () => number;
}

export interface ChannelIssues {
  channelId: string;
  provider: string;
  channelName: string;
  issues: ValidationIssue[];
}

interface PostBundle {
  post: Post;
  variants: PostVariant[];
  channels: Map<string, SocialChannel>;
  connections: Map<string, SocialConnection>;
}

export async function loadPostBundle(workspaceId: string, postId: string): Promise<PostBundle> {
  const postSnap = await db().doc(paths.post(workspaceId, postId)).get();
  if (!postSnap.exists) fail('not-found', 'Post not found');
  const post = { id: postSnap.id, ...postSnap.data() } as Post;
  const variantSnaps = await db().collection(paths.variants(workspaceId)).where('postId', '==', postId).get();
  const variants = variantSnaps.docs.map((d) => ({ id: d.id, ...d.data() }) as PostVariant).filter((v) => post.channelIds.includes(v.channelId));
  const channels = new Map<string, SocialChannel>();
  const connections = new Map<string, SocialConnection>();
  if (variants.length) {
    const chSnaps = await db().getAll(...variants.map((v) => db().doc(paths.channel(workspaceId, v.channelId))));
    for (const s of chSnaps) if (s.exists) channels.set(s.id, { id: s.id, ...s.data() } as SocialChannel);
    const connIds = [...new Set([...channels.values()].map((c) => c.connectionId))];
    if (connIds.length) {
      const cSnaps = await db().getAll(...connIds.map((id) => db().doc(paths.connection(workspaceId, id))));
      for (const s of cSnaps) if (s.exists) connections.set(s.id, { id: s.id, ...s.data() } as SocialConnection);
    }
  }
  return { post, variants, channels, connections };
}

/** Validates every targeted variant (shared rules + provider runtime checks). */
export async function validateBundle(registry: ProviderRegistry, b: PostBundle): Promise<ChannelIssues[]> {
  const out: ChannelIssues[] = [];
  for (const v of b.variants) {
    const channel = b.channels.get(v.channelId);
    const issues: ValidationIssue[] = [];
    if (!channel) {
      out.push({ channelId: v.channelId, provider: v.provider, channelName: v.channelId, issues: [{ field: 'channel', code: 'channel_missing', message: 'This account is no longer connected.', severity: 'error' }] });
      continue;
    }
    if (!registry.has(v.provider)) {
      out.push({ channelId: v.channelId, provider: v.provider, channelName: channel.name, issues: [{ field: 'provider', code: 'provider_unavailable', message: `${v.provider} is not available in this environment.`, severity: 'error' }] });
      continue;
    }
    const provider = registry.get(v.provider);
    const connection = b.connections.get(channel.connectionId);
    if (!connection || connection.status !== 'connected') {
      issues.push({ field: 'channel', code: 'account_not_authorized', message: `${channel.name}: account no longer authorized — reconnect it.`, severity: 'error' });
    }
    if (!channel.enabled) issues.push({ field: 'channel', code: 'channel_disabled', message: `${channel.name} is disabled.`, severity: 'error' });
    let media: Awaited<ReturnType<typeof loadMediaAssets>> = [];
    try {
      media = await loadMediaAssets(b.post.workspaceId, v.mediaIds ?? b.post.mediaIds);
    } catch (e) {
      issues.push({ field: 'media', code: 'media_missing', message: (e as Error).message, severity: 'error' });
    }
    const content = resolveVariantContent(provider.manifest, b.post.masterContent, v);
    issues.push(
      ...validateVariant(provider.manifest, {
        format: v.format,
        content,
        settings: v.providerSettings,
        channelMetadata: channel.metadata,
        media: media.map((m) => ({ id: m.id, kind: m.kind, mimeType: m.mimeType, size: m.size, width: m.width, height: m.height, durationSec: m.durationSec, fileName: m.fileName })),
      }),
    );
    issues.push(...(await provider.validateContent({ channel, format: v.format, content, settings: v.providerSettings, media })));
    if (issues.length) out.push({ channelId: v.channelId, provider: v.provider, channelName: channel.name, issues });
  }
  return out;
}

interface PendingEnqueue {
  deliveryId: string;
  version: number;
  target: TaskTarget;
  scheduleAt: number;
}

interface PendingCancel {
  taskName: string;
}

function baseDelivery(
  post: Post,
  variant: PostVariant,
  channel: SocialChannel,
  executor: TaskTarget,
): Omit<Delivery, 'status' | 'scheduledAt' | 'scheduleVersion' | 'createdAt' | 'updatedAt'> {
  return {
    id: deliveryIdFor(post.id, channel.id),
    workspaceId: post.workspaceId,
    postId: post.id,
    variantId: variant.id,
    provider: variant.provider,
    channelId: channel.id,
    connectionId: channel.connectionId,
    taskName: null,
    executor,
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
  };
}

async function dispatchAfterCommit(deps: SchedulerDeps, workspaceId: string, enqueues: PendingEnqueue[], cancels: PendingCancel[]): Promise<void> {
  for (const c of cancels) {
    const parsed = parseTaskName(c.taskName);
    if (parsed) await deps.dispatcher.cancel(parsed.target, parsed.kind, parsed.id);
  }
  for (const e of enqueues) {
    try {
      const taskName = await deps.dispatcher.enqueue(
        e.target,
        { kind: 'execute', workspaceId, deliveryId: e.deliveryId, scheduleVersion: e.version, seq: 0 },
        { id: deliveryTaskId(e.deliveryId, e.version), scheduleAt: new Date(e.scheduleAt) },
      );
      // Only record the task name if the delivery was not rescheduled meanwhile.
      await db().runTransaction(async (tx) => {
        const ref = db().doc(paths.delivery(workspaceId, e.deliveryId));
        const snap = await tx.get(ref);
        if (snap.exists && snap.get('scheduleVersion') === e.version) tx.update(ref, { taskName });
      });
    } catch (err) {
      // The delivery stays queued without a taskName; reconcileDeliveries re-enqueues it.
      log.error('Enqueue failed; reconciliation will retry', { deliveryId: e.deliveryId, error: String(err) });
    }
  }
}

export type ScheduleMode = { kind: 'at'; scheduledAtMs: number; timezone: string } | { kind: 'now'; timezone: string };

/**
 * Schedules (or re-schedules) every targeted channel of a post.
 * Each call bumps scheduleVersion of affected deliveries, so any older task
 * that still fires is ignored by the engine.
 */
export async function schedulePost(
  deps: SchedulerDeps,
  workspaceId: string,
  postId: string,
  mode: ScheduleMode,
  actor: AuditActor,
): Promise<{ deliveries: Array<{ id: string; channelId: string; status: DeliveryStatus; scheduledAt: number }>; skipped: string[] }> {
  const nowMs = (deps.now ?? Date.now)();
  if (mode.kind === 'at' && isInPast(mode.scheduledAtMs, nowMs)) fail('invalid-argument', 'The scheduled time is in the past');

  const bundle = await loadPostBundle(workspaceId, postId);
  if (bundle.variants.length === 0) fail('failed-precondition', 'Select at least one network before scheduling');
  const issues = await validateBundle(deps.registry, bundle);
  const blocking = issues.filter((c) => hasBlockingIssues(c.issues));
  if (blocking.length) fail('failed-precondition', 'Some networks have validation errors', { channels: blocking });

  // Executor per channel (worker for heavy media)
  const executors = new Map<string, TaskTarget>();
  for (const v of bundle.variants) {
    const media = await loadMediaAssets(workspaceId, v.mediaIds ?? bundle.post.mediaIds);
    executors.set(v.channelId, deps.registry.get(v.provider).executorFor(v.format, media));
  }

  const enqueues: PendingEnqueue[] = [];
  const cancels: PendingCancel[] = [];
  const skipped: string[] = [];
  const result: Array<{ id: string; channelId: string; status: DeliveryStatus; scheduledAt: number }> = [];

  await db().runTransaction(async (tx: Transaction) => {
    enqueues.length = 0;
    cancels.length = 0;
    skipped.length = 0;
    result.length = 0;
    const postRef = db().doc(paths.post(workspaceId, postId));
    const postSnap = await tx.get(postRef);
    if (!postSnap.exists) fail('not-found', 'Post not found');
    const post = { id: postSnap.id, ...postSnap.data() } as Post;
    const existing = await readPostDeliveries(tx, workspaceId, postId);
    const byChannel = new Map(existing.map((d) => [d.channelId, d]));
    const overrides = new Map<string, Partial<Delivery>>();
    const postAt = mode.kind === 'at' ? mode.scheduledAtMs : nowMs;

    for (const v of bundle.variants) {
      const channel = bundle.channels.get(v.channelId) as SocialChannel;
      const at =
        mode.kind === 'now'
          ? nowMs
          : (effectiveDeliveryTime(postAt, { channelId: v.channelId, offsetMinutes: v.offsetMinutes, scheduledAtOverrideMs: v.scheduledAtOverride?.toMillis() ?? null }) as number);
      const cur = byChannel.get(v.channelId);
      if (cur && (cur.status === 'published' || IN_FLIGHT_STATUSES.includes(cur.status))) {
        skipped.push(v.channelId); // never re-publish or touch in-flight deliveries
        continue;
      }
      const layer = queueLayerFor(at, nowMs);
      const status: DeliveryStatus = layer === 'task' ? 'queued' : 'awaiting_queue';
      const version = (cur?.scheduleVersion ?? 0) + 1;
      const executor = executors.get(v.channelId) ?? 'functions';
      const fields: Partial<Delivery> = {
        ...baseDelivery(post, v, channel, executor),
        status,
        scheduledAt: Timestamp.fromMillis(at),
        scheduleVersion: version,
        attemptCount: cur?.attemptCount ?? 0,
        processingMetadata: {},
      };
      const ref = db().doc(paths.delivery(workspaceId, fields.id as string));
      if (cur) {
        if (cur.taskName) cancels.push({ taskName: cur.taskName });
        tx.update(ref, { ...fields, nextAttemptAt: null, updatedAt: FieldValue.serverTimestamp() });
      } else {
        tx.set(ref, { ...fields, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      }
      overrides.set(fields.id as string, fields);
      if (layer === 'task') enqueues.push({ deliveryId: fields.id as string, version, target: executor, scheduleAt: at });
      result.push({ id: fields.id as string, channelId: v.channelId, status, scheduledAt: at });
    }

    // Channels removed from the post: cancel their pending deliveries.
    for (const d of existing) {
      if (post.channelIds.includes(d.channelId) || d.status === 'published' || d.status === 'cancelled' || IN_FLIGHT_STATUSES.includes(d.status)) continue;
      const upd: Partial<Delivery> = { status: 'cancelled', scheduleVersion: d.scheduleVersion + 1, taskName: null };
      if (d.taskName) cancels.push({ taskName: d.taskName });
      tx.update(db().doc(paths.delivery(workspaceId, d.id)), { ...upd, updatedAt: FieldValue.serverTimestamp() });
      overrides.set(d.id, upd);
    }

    writePostAggregate(tx, workspaceId, postId, existing, overrides, {
      schedule: { scheduledAt: mode.kind === 'at' ? Timestamp.fromMillis(mode.scheduledAtMs) : Timestamp.fromMillis(nowMs), timezone: mode.timezone },
      revision: FieldValue.increment(1),
    });
    await audit(
      {
        workspaceId,
        actor,
        action: mode.kind === 'now' ? 'post.publish_now' : existing.length ? 'post.rescheduled' : 'post.scheduled',
        entityType: 'post',
        entityId: postId,
        metadata: { scheduledAt: new Date(postAt).toISOString(), timezone: mode.timezone, channels: result.map((r) => r.channelId), skipped },
      },
      tx,
    );
  });

  await dispatchAfterCommit(deps, workspaceId, enqueues, cancels);
  return { deliveries: result, skipped };
}

/** Cancels pending deliveries. Published and in-flight ones are left untouched. */
export async function cancelPost(deps: SchedulerDeps, workspaceId: string, postId: string, channelIds: string[] | undefined, actor: AuditActor) {
  const cancels: PendingCancel[] = [];
  const cancelled: string[] = [];
  const blocked: string[] = [];
  await db().runTransaction(async (tx) => {
    cancels.length = 0;
    cancelled.length = 0;
    blocked.length = 0;
    const postSnap = await tx.get(db().doc(paths.post(workspaceId, postId)));
    if (!postSnap.exists) fail('not-found', 'Post not found');
    const deliveries = await readPostDeliveries(tx, workspaceId, postId);
    const overrides = new Map<string, Partial<Delivery>>();
    for (const d of deliveries) {
      if (channelIds && !channelIds.includes(d.channelId)) continue;
      if (d.status === 'published' || d.status === 'cancelled') continue;
      if (IN_FLIGHT_STATUSES.includes(d.status)) {
        blocked.push(d.channelId);
        continue;
      }
      const upd: Partial<Delivery> = { status: 'cancelled', scheduleVersion: d.scheduleVersion + 1, taskName: null, publishingLease: null };
      if (d.taskName) cancels.push({ taskName: d.taskName });
      tx.update(db().doc(paths.delivery(workspaceId, d.id)), { ...upd, updatedAt: FieldValue.serverTimestamp() });
      overrides.set(d.id, upd);
      cancelled.push(d.channelId);
    }
    const extra: Record<string, unknown> = { revision: FieldValue.increment(1) };
    if (deliveries.length === 0) extra.status = 'cancelled';
    writePostAggregate(tx, workspaceId, postId, deliveries, overrides, extra);
    await audit({ workspaceId, actor, action: 'post.cancelled', entityType: 'post', entityId: postId, metadata: { cancelled, blocked } }, tx);
  });
  await dispatchAfterCommit(deps, workspaceId, [], cancels);
  return { cancelled, blocked };
}

/** Manual retry of one failed delivery. Never touches the post's other deliveries. */
export async function retryDelivery(deps: SchedulerDeps, workspaceId: string, deliveryId: string, confirmPossibleDuplicate: boolean, actor: AuditActor) {
  const nowMs = (deps.now ?? Date.now)();
  const snap = await db().doc(paths.delivery(workspaceId, deliveryId)).get();
  if (!snap.exists) fail('not-found', 'Delivery not found');
  const d0 = { id: snap.id, ...snap.data() } as Delivery;
  const conn = await db().doc(paths.connection(workspaceId, d0.connectionId)).get();
  if (!conn.exists || conn.get('status') !== 'connected') {
    fail('failed-precondition', 'Reconnect the account before retrying', { reason: 'needs_reauth', connectionId: d0.connectionId });
  }

  let enqueue: PendingEnqueue | null = null;
  await db().runTransaction(async (tx) => {
    const ref = db().doc(paths.delivery(workspaceId, deliveryId));
    const s = await tx.get(ref);
    const d = { id: s.id, ...s.data() } as Delivery;
    if (d.status !== 'failed' && d.status !== 'needs_reauth') fail('failed-precondition', `Only failed deliveries can be retried (current: ${d.status})`);
    if ((d.error?.code === OUTCOME_UNKNOWN || d.error?.code === 'unexpected_error') && !confirmPossibleDuplicate) {
      fail('failed-precondition', 'The previous attempt may have been published. Confirm that it is not on the platform before retrying.', { reason: 'confirm_possible_duplicate' });
    }
    const deliveries = await readPostDeliveries(tx, workspaceId, d.postId);
    const version = d.scheduleVersion + 1;
    const upd: Partial<Delivery> = {
      status: 'queued',
      scheduleVersion: version,
      scheduledAt: Timestamp.fromMillis(nowMs),
      taskName: null,
      autoRetryCount: 0,
      publishingLease: null,
      processingMetadata: {},
      statusCheckCount: 0,
      nextStatusCheckAt: null,
    };
    tx.update(ref, { ...upd, updatedAt: FieldValue.serverTimestamp() });
    writePostAggregate(tx, workspaceId, d.postId, deliveries, new Map([[d.id, upd]]));
    await audit({ workspaceId, actor, action: 'delivery.retried', entityType: 'delivery', entityId: d.id, metadata: { postId: d.postId, provider: d.provider, previousError: d.error?.code ?? null } }, tx);
    enqueue = { deliveryId: d.id, version, target: d.executor ?? 'functions', scheduleAt: nowMs };
  });
  if (enqueue) await dispatchAfterCommit(deps, workspaceId, [enqueue], []);
  return { ok: true };
}

/**
 * Layer 2 of the 30-day strategy: promotes awaiting_queue deliveries that
 * entered the Cloud Tasks window. Safe to run any number of times.
 */
export async function promoteAwaitingDelivery(deps: SchedulerDeps, workspaceId: string, deliveryId: string): Promise<boolean> {
  const nowMs = (deps.now ?? Date.now)();
  let enqueue: PendingEnqueue | null = null;
  await db().runTransaction(async (tx) => {
    const ref = db().doc(paths.delivery(workspaceId, deliveryId));
    const s = await tx.get(ref);
    if (!s.exists) return;
    const d = { id: s.id, ...s.data() } as Delivery;
    if (d.status !== 'awaiting_queue' || !d.scheduledAt) return;
    if (queueLayerFor(d.scheduledAt.toMillis(), nowMs) !== 'task') return;
    const deliveries = await readPostDeliveries(tx, workspaceId, d.postId);
    const upd: Partial<Delivery> = { status: 'queued' };
    tx.update(ref, { ...upd, updatedAt: FieldValue.serverTimestamp() });
    writePostAggregate(tx, workspaceId, d.postId, deliveries, new Map([[d.id, upd]]));
    enqueue = { deliveryId: d.id, version: d.scheduleVersion, target: d.executor ?? 'functions', scheduleAt: Math.max(nowMs, d.scheduledAt.toMillis()) };
  });
  if (!enqueue) return false;
  await dispatchAfterCommit(deps, workspaceId, [enqueue], []);
  return true;
}

/**
 * Re-enqueues a delivery whose task was lost. Cloud Tasks refuses to reuse a
 * task name for a while after it ran, so recovery tasks use a time-bucketed
 * id: repeated reconciliation runs in the same bucket stay idempotent, and the
 * engine's claim transaction makes any extra task harmless.
 */
export async function reEnqueueDelivery(deps: SchedulerDeps, d: Delivery, bucket: number): Promise<void> {
  const nowMs = (deps.now ?? Date.now)();
  // Spaced so that follow-up retries (seq + 1, + 2 …) never collide with the next bucket.
  const seq = 1_000_000 + bucket * 100;
  const scheduleAt = Math.max(nowMs, d.scheduledAt?.toMillis() ?? nowMs);
  try {
    const taskName = await deps.dispatcher.enqueue(
      d.executor ?? 'functions',
      { kind: 'execute', workspaceId: d.workspaceId, deliveryId: d.id, scheduleVersion: d.scheduleVersion, seq },
      { id: deliveryTaskId(d.id, d.scheduleVersion, seq), scheduleAt: new Date(scheduleAt) },
    );
    await db().runTransaction(async (tx) => {
      const ref = db().doc(paths.delivery(d.workspaceId, d.id));
      const snap = await tx.get(ref);
      if (snap.exists && snap.get('scheduleVersion') === d.scheduleVersion) tx.update(ref, { taskName });
    });
  } catch (err) {
    log.error('Recovery enqueue failed', { deliveryId: d.id, error: String(err) });
  }
}

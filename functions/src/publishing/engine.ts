import { randomUUID } from 'node:crypto';
import {
  AUTO_RETRY_LIMIT,
  backoffDelaySeconds,
  canTransition,
  composeCaption,
  deliveryTaskId,
  hasBlockingIssues,
  queueLayerFor,
  resolveVariantContent,
  statusCheckTaskId,
  validateVariant,
  type Delivery,
  type DeliveryError,
  type DeliveryStatus,
  type MediaAsset,
  type Post,
  type PostVariant,
  type SocialChannel,
  type SocialConnection,
} from '@shared/index';
import { FieldValue, Timestamp, db, paths } from '../utils/firestore';
import { log } from '../utils/logger';
import { ProviderError, toProviderError } from '../providers/errors';
import type { ProviderRegistry } from '../providers/registry';
import type { PublishResult, SocialProvider, StatusResult } from '../providers/types';
import type { DeliveryTaskPayload, TaskDispatcher } from '../tasks/dispatcher';
import { resolveCredentials, markConnectionNeedsReauth } from '../services/credentials';
import { loadMediaAssets, resolveMedia } from '../services/media';
import { readPostDeliveries, writePostAggregate } from './aggregate';
import { audit, SYSTEM_ACTOR } from '../services/audit';
import { notify } from '../services/notifications';

/**
 * Publishing engine — executes one delivery exactly once.
 *
 * Guarantees (see docs/ARCHITECTURE.md §Idempotency):
 * 1. Claim in a Firestore transaction: the task's scheduleVersion must equal the
 *    delivery's, the status must be `queued`, and no live lease may exist.
 *    Stale / duplicate / cancelled tasks are ignored.
 * 2. The claim sets status=publishing with a time-bounded lease owned by this
 *    execution and increments attemptCount.
 * 3. The provider call runs outside the transaction. Providers checkpoint
 *    identifiers (container id, publish_id, upload URI) before irreversible steps.
 * 4. Finalisation runs in a transaction that only applies if this execution
 *    still owns the lease, storing externalPostId and the new status.
 * 5. A publishing delivery whose lease expired is never blindly re-published:
 *    it is resolved through the provider's status API using its checkpoint,
 *    or marked `outcome_unknown`, which requires an explicit user confirmation
 *    to retry.
 */

export interface EngineDeps {
  registry: ProviderRegistry;
  dispatcher: TaskDispatcher;
  now?: () => number;
  /** Lease duration; must exceed the task dispatch deadline. */
  leaseMs?: number;
}

export type EngineOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'deferred'; reason: string; until: number }
  | { action: 'published'; externalPostId: string }
  | { action: 'processing' }
  | { action: 'retry_scheduled'; at: number }
  | { action: 'failed'; error: DeliveryError }
  | { action: 'needs_reauth'; error: DeliveryError };

const DEFAULT_LEASE_MS = 35 * 60 * 1000;
const EARLY_TOLERANCE_MS = 60 * 1000;
const MAX_STATUS_CHECKS = 60;
const MAX_STATUS_CHECK_DELAY_SEC = 30 * 60;

export const OUTCOME_UNKNOWN = 'outcome_unknown';

function deliveryRef(workspaceId: string, deliveryId: string) {
  return db().doc(paths.delivery(workspaceId, deliveryId));
}

function leaseAlive(d: Delivery, nowMs: number): boolean {
  return !!d.publishingLease && d.publishingLease.expiresAt.toMillis() > nowMs;
}

interface Loaded {
  delivery: Delivery;
  post: Post;
  variant: PostVariant;
  channel: SocialChannel;
  connection: SocialConnection;
  provider: SocialProvider;
  media: MediaAsset[];
}

async function loadContext(registry: ProviderRegistry, delivery: Delivery): Promise<Loaded> {
  const w = delivery.workspaceId;
  const [postSnap, variantSnap, channelSnap, connSnap] = await db().getAll(
    db().doc(paths.post(w, delivery.postId)),
    db().doc(paths.variant(w, delivery.variantId)),
    db().doc(paths.channel(w, delivery.channelId)),
    db().doc(paths.connection(w, delivery.connectionId)),
  );
  if (!postSnap?.exists || !variantSnap?.exists) throw ProviderError.validation('The post or its variant no longer exists', 'post_missing');
  if (!channelSnap?.exists || !connSnap?.exists) {
    throw new ProviderError({ code: 'channel_missing', message: 'The social account was disconnected', category: 'AUTH', retryable: false });
  }
  const post = { id: postSnap.id, ...postSnap.data() } as Post;
  const variant = { id: variantSnap.id, ...variantSnap.data() } as PostVariant;
  const channel = { id: channelSnap.id, ...channelSnap.data() } as SocialChannel;
  const connection = { id: connSnap.id, ...connSnap.data() } as SocialConnection;
  if (!registry.has(delivery.provider)) throw ProviderError.config(`Provider "${delivery.provider}" is not available in this environment`);
  const provider = registry.get(delivery.provider);
  const media = await loadMediaAssets(w, variant.mediaIds ?? post.mediaIds);
  return { delivery, post, variant, channel, connection, provider, media };
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

type Claim =
  | { type: 'ignore'; reason: string }
  | { type: 'defer'; reason: string; untilMs: number }
  | { type: 'publish'; delivery: Delivery }
  | { type: 'recover'; delivery: Delivery };

async function claim(payload: DeliveryTaskPayload, owner: string, nowMs: number, leaseMs: number, registry: ProviderRegistry): Promise<Claim> {
  const ref = deliveryRef(payload.workspaceId, payload.deliveryId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { type: 'ignore', reason: 'missing' };
    const d = { id: snap.id, ...snap.data() } as Delivery;

    if (d.scheduleVersion !== payload.scheduleVersion) return { type: 'ignore', reason: 'stale_schedule_version' };
    if (d.status === 'publishing') {
      if (leaseAlive(d, nowMs)) return { type: 'ignore', reason: 'lease_held' };
      // Previous executor died mid-flight. Take the lease to resolve, never to blindly re-publish.
      const lease = { owner, acquiredAt: Timestamp.fromMillis(nowMs), expiresAt: Timestamp.fromMillis(nowMs + leaseMs) };
      tx.update(ref, { publishingLease: lease, updatedAt: FieldValue.serverTimestamp() });
      return { type: 'recover', delivery: { ...d, publishingLease: lease } };
    }
    if (d.status !== 'queued') return { type: 'ignore', reason: `status_${d.status}` };

    const scheduledMs = d.scheduledAt?.toMillis() ?? nowMs;
    if (scheduledMs - nowMs > EARLY_TOLERANCE_MS) return { type: 'defer', reason: 'early', untilMs: scheduledMs };

    // Channel-level rate limiting / concurrency (provider-declared maxConcurrent)
    const channelSnap = await tx.get(db().doc(paths.channel(d.workspaceId, d.channelId)));
    const rateLimitedUntil = (channelSnap.get('rateLimitedUntil') as Timestamp | undefined)?.toMillis() ?? 0;
    if (rateLimitedUntil > nowMs) return { type: 'defer', reason: 'rate_limited', untilMs: rateLimitedUntil };
    const maxConcurrent = registry.has(d.provider) ? registry.get(d.provider).manifest.rateLimit.maxConcurrent : 1;
    const busy = await tx.get(
      db().collection(paths.deliveries(d.workspaceId)).where('channelId', '==', d.channelId).where('status', '==', 'publishing'),
    );
    const live = busy.docs.filter((b) => {
      const exp = (b.get('publishingLease.expiresAt') as Timestamp | undefined)?.toMillis() ?? 0;
      return b.id !== d.id && exp > nowMs;
    }).length;
    if (live >= maxConcurrent) return { type: 'defer', reason: 'channel_busy', untilMs: nowMs + 60_000 };

    const lease = { owner, acquiredAt: Timestamp.fromMillis(nowMs), expiresAt: Timestamp.fromMillis(nowMs + leaseMs) };
    const deliveries = await readPostDeliveries(tx, d.workspaceId, d.postId);
    const update: Partial<Delivery> = {
      status: 'publishing',
      publishingLease: lease,
      attemptCount: (d.attemptCount ?? 0) + 1,
      lastAttemptAt: Timestamp.fromMillis(nowMs),
    };
    tx.update(ref, { ...update, updatedAt: FieldValue.serverTimestamp() });
    writePostAggregate(tx, d.workspaceId, d.postId, deliveries, new Map([[d.id, update]]));
    return { type: 'publish', delivery: { ...d, ...update } };
  });
}

// ---------------------------------------------------------------------------
// Finalise
// ---------------------------------------------------------------------------

interface Finalisation {
  status: DeliveryStatus;
  externalPostId?: string | null;
  externalPostUrl?: string | null;
  error?: DeliveryError | null;
  metadata?: Record<string, unknown>;
  nextStatusCheckAt?: number | null;
  statusCheckCount?: number;
  autoRetryCount?: number;
}

/** Applies the final state if (and only if) this execution still owns the lease. */
async function finalise(d: Delivery, owner: string, nowMs: number, f: Finalisation): Promise<{ applied: boolean; previousPostStatus: string | null; postStatus: string | null }> {
  const ref = deliveryRef(d.workspaceId, d.id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const postSnap = await tx.get(db().doc(paths.post(d.workspaceId, d.postId)));
    if (!snap.exists) return { applied: false, previousPostStatus: null, postStatus: null };
    const cur = { id: snap.id, ...snap.data() } as Delivery;
    if (cur.publishingLease?.owner !== owner) {
      log.error('Lease lost before finalisation', { deliveryId: d.id, status: f.status, externalPostId: f.externalPostId ?? null });
      // We did publish: never lose the external id even without the lease.
      if (f.status === 'published' && cur.status !== 'published' && f.externalPostId) {
        tx.update(ref, { externalPostId: f.externalPostId, externalPostUrl: f.externalPostUrl ?? null, updatedAt: FieldValue.serverTimestamp() });
      }
      return { applied: false, previousPostStatus: null, postStatus: null };
    }
    if (!canTransition(cur.status, f.status)) {
      log.error('Refusing illegal delivery transition', { deliveryId: d.id, from: cur.status, to: f.status });
      return { applied: false, previousPostStatus: null, postStatus: null };
    }
    const deliveries = await readPostDeliveries(tx, d.workspaceId, d.postId);
    const update: Partial<Delivery> = {
      status: f.status,
      publishingLease: null,
      error: f.error === undefined ? cur.error : f.error,
      processingMetadata: { ...(cur.processingMetadata ?? {}), ...(f.metadata ?? {}) },
    };
    if (f.externalPostId !== undefined) update.externalPostId = f.externalPostId;
    if (f.externalPostUrl !== undefined) update.externalPostUrl = f.externalPostUrl;
    if (f.status === 'published') update.publishedAt = Timestamp.fromMillis(nowMs);
    if (f.nextStatusCheckAt !== undefined) update.nextStatusCheckAt = f.nextStatusCheckAt ? Timestamp.fromMillis(f.nextStatusCheckAt) : null;
    if (f.statusCheckCount !== undefined) update.statusCheckCount = f.statusCheckCount;
    if (f.autoRetryCount !== undefined) update.autoRetryCount = f.autoRetryCount;
    tx.update(ref, { ...update, updatedAt: FieldValue.serverTimestamp() });
    const agg = writePostAggregate(tx, d.workspaceId, d.postId, deliveries, new Map([[d.id, update]]));
    return { applied: true, previousPostStatus: (postSnap.get('status') as string) ?? null, postStatus: agg.status };
  });
}

async function persistCheckpoint(d: Delivery, owner: string, data: Record<string, unknown>): Promise<void> {
  const ref = deliveryRef(d.workspaceId, d.id);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.get('publishingLease.owner') !== owner) throw new Error('Lease lost; aborting before an irreversible step');
    const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    for (const [k, v] of Object.entries(data)) updates[`processingMetadata.${k}`] = v;
    tx.update(ref, updates);
  });
}

// ---------------------------------------------------------------------------
// Outcome handling
// ---------------------------------------------------------------------------

async function afterFinalise(
  deps: EngineDeps,
  d: Delivery,
  post: Pick<Post, 'titleInternal' | 'masterContent'> | null,
  res: { applied: boolean; previousPostStatus: string | null; postStatus: string | null },
  status: DeliveryStatus,
  error: DeliveryError | null,
): Promise<void> {
  if (!res.applied) return;
  const title = post?.titleInternal || post?.masterContent.text.slice(0, 60) || 'Post';
  const actions: Record<string, string> = { published: 'delivery.published', failed: 'delivery.failed', needs_reauth: 'delivery.needs_reauth' };
  if (actions[status]) {
    await audit({
      workspaceId: d.workspaceId,
      actor: SYSTEM_ACTOR,
      action: actions[status] as string,
      entityType: 'delivery',
      entityId: d.id,
      metadata: { postId: d.postId, provider: d.provider, channelId: d.channelId, error: error ? { code: error.code, category: error.category } : null },
    });
  }
  if (status === 'needs_reauth') {
    await notify({
      workspaceId: d.workspaceId,
      kind: 'reauth',
      title: `🔐 Reconnect ${d.provider}`,
      body: `${title}: ${error?.message ?? 'Authentication expired'}`,
      postId: d.postId,
      deliveryId: d.id,
      connectionId: d.connectionId,
      dedupeKey: `reauth_${d.id}_v${d.scheduleVersion}_a${d.attemptCount}`,
    });
  }
  if (res.postStatus && res.postStatus !== res.previousPostStatus) {
    const map: Record<string, { kind: 'published' | 'partial' | 'failed'; title: string }> = {
      published: { kind: 'published', title: '✅ Post published' },
      partially_published: { kind: 'partial', title: '⚠️ Partial publication' },
      failed: { kind: 'failed', title: '❌ Publication failed' },
    };
    const n = map[res.postStatus];
    if (n) {
      await notify({
        workspaceId: d.workspaceId,
        kind: n.kind,
        title: n.title,
        body: n.kind === 'published' ? title : `${title} — ${error?.message ?? 'needs attention'}`,
        postId: d.postId,
        dedupeKey: `post_${d.postId}_${res.postStatus}_${d.scheduleVersion}_${d.attemptCount}`,
      });
      await audit({ workspaceId: d.workspaceId, actor: SYSTEM_ACTOR, action: `post.${res.postStatus}`, entityType: 'post', entityId: d.postId, metadata: {} });
    }
  }
}

async function handleError(deps: EngineDeps, d: Delivery, owner: string, nowMs: number, e: unknown, post: Loaded['post'] | null, payload: DeliveryTaskPayload): Promise<EngineOutcome> {
  const err = toProviderError(e);
  let error = err.toDeliveryError();
  // A non-provider exception may have happened after the platform accepted the post.
  if (!(e instanceof ProviderError)) {
    error = { ...error, code: OUTCOME_UNKNOWN, message: `Unexpected error: ${error.message}. Check the platform before retrying.`, retryable: false };
  }
  log.warn('Delivery attempt failed', { deliveryId: d.id, provider: d.provider, code: error.code, category: error.category, retryable: error.retryable });

  if (err.needsReauth) {
    await markConnectionNeedsReauth(d.workspaceId, d.connectionId, err).catch(() => undefined);
    const res = await finalise(d, owner, nowMs, { status: 'needs_reauth', error });
    await afterFinalise(deps, d, post, res, 'needs_reauth', error);
    return { action: 'needs_reauth', error };
  }

  if (err.category === 'RATE_LIMIT' && err.retryAfterSec) {
    await db()
      .doc(paths.channel(d.workspaceId, d.channelId))
      .set({ rateLimitedUntil: Timestamp.fromMillis(nowMs + err.retryAfterSec * 1000) }, { merge: true })
      .catch(() => undefined);
  }

  const retries = d.autoRetryCount ?? 0;
  if (error.retryable && retries < AUTO_RETRY_LIMIT) {
    const delaySec = backoffDelaySeconds(retries + 1, { retryAfterSec: err.retryAfterSec });
    const at = nowMs + delaySec * 1000;
    const res = await finalise(d, owner, nowMs, { status: 'queued', error, autoRetryCount: retries + 1 });
    if (res.applied) {
      const seq = payload.seq + 1;
      const target = d.executor ?? 'functions';
      const taskName = await deps.dispatcher.enqueue(target, { ...payload, kind: 'execute', seq }, { id: deliveryTaskId(d.id, d.scheduleVersion, seq), scheduleAt: new Date(at) });
      await deliveryRef(d.workspaceId, d.id).update({ taskName, nextAttemptAt: Timestamp.fromMillis(at) });
    }
    return { action: 'retry_scheduled', at };
  }

  const res = await finalise(d, owner, nowMs, { status: 'failed', error: { ...error, retryable: error.retryable && error.code !== OUTCOME_UNKNOWN } });
  await afterFinalise(deps, d, post, res, 'failed', error);
  return { action: 'failed', error };
}

async function applyResult(
  deps: EngineDeps,
  d: Delivery,
  owner: string,
  nowMs: number,
  result: PublishResult | StatusResult,
  post: Loaded['post'] | null,
  payload: DeliveryTaskPayload,
  statusCheckCount: number,
): Promise<EngineOutcome> {
  if (result.kind === 'published') {
    const res = await finalise(d, owner, nowMs, {
      status: 'published',
      externalPostId: result.externalPostId,
      externalPostUrl: result.externalPostUrl,
      error: null,
      metadata: result.metadata ?? {},
      nextStatusCheckAt: null,
    });
    await afterFinalise(deps, d, post, res, 'published', null);
    return { action: 'published', externalPostId: result.externalPostId };
  }
  if (result.kind === 'processing') {
    if (statusCheckCount >= MAX_STATUS_CHECKS) {
      const error: DeliveryError = { code: 'processing_timeout', message: 'The platform is still processing after many checks. Verify on the platform.', category: 'PROCESSING', retryable: false };
      const res = await finalise(d, owner, nowMs, { status: 'failed', error });
      await afterFinalise(deps, d, post, res, 'failed', error);
      return { action: 'failed', error };
    }
    const delaySec = Math.min(MAX_STATUS_CHECK_DELAY_SEC, Math.round(result.checkAfterSec * 1.5 ** Math.min(statusCheckCount, 10)));
    const at = nowMs + delaySec * 1000;
    const res = await finalise(d, owner, nowMs, { status: 'processing', metadata: result.metadata, nextStatusCheckAt: at, statusCheckCount });
    if (res.applied) {
      await deps.dispatcher.enqueue(
        'functions',
        { kind: 'status_check', workspaceId: d.workspaceId, deliveryId: d.id, scheduleVersion: d.scheduleVersion, seq: statusCheckCount + 1 },
        { id: statusCheckTaskId(d.id, d.scheduleVersion, statusCheckCount + 1), scheduleAt: new Date(at) },
      );
    }
    return { action: 'processing' };
  }
  if (result.kind === 'failed') {
    const error: DeliveryError = { code: result.code, message: result.message, category: result.category, retryable: result.retryable };
    return handleError(deps, d, owner, nowMs, new ProviderError({ ...error }), post, payload);
  }
  // not_published: nothing reached the platform — safe to run again as a fresh queued attempt.
  const res = await finalise(d, owner, nowMs, { status: 'queued', error: null });
  if (res.applied) {
    const seq = payload.seq + 1;
    await deps.dispatcher.enqueue(d.executor ?? 'functions', { ...payload, kind: 'execute', seq }, { id: deliveryTaskId(d.id, d.scheduleVersion, seq), scheduleAt: new Date(nowMs) });
  }
  return { action: 'retry_scheduled', at: nowMs };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function executeDelivery(payload: DeliveryTaskPayload, deps: EngineDeps): Promise<EngineOutcome> {
  const nowMs = (deps.now ?? Date.now)();
  const owner = `exec_${randomUUID()}`;
  const c = await claim(payload, owner, nowMs, deps.leaseMs ?? DEFAULT_LEASE_MS, deps.registry);

  if (c.type === 'ignore') {
    log.info('Delivery task ignored', { deliveryId: payload.deliveryId, reason: c.reason, taskVersion: payload.scheduleVersion });
    return { action: 'ignored', reason: c.reason };
  }
  if (c.type === 'defer') {
    const seq = payload.seq + 1;
    if (queueLayerFor(c.untilMs, nowMs) === 'task') {
      const d = (await deliveryRef(payload.workspaceId, payload.deliveryId).get()).data() as Delivery;
      await deps.dispatcher.enqueue(d.executor ?? 'functions', { ...payload, seq }, { id: deliveryTaskId(payload.deliveryId, payload.scheduleVersion, seq), scheduleAt: new Date(c.untilMs) });
    }
    return { action: 'deferred', reason: c.reason, until: c.untilMs };
  }
  if (c.type === 'recover') return recover(c.delivery, owner, nowMs, deps, payload);

  const d = c.delivery;
  let loaded: Loaded | null = null;
  try {
    loaded = await loadContext(deps.registry, d);
    const { provider, variant, post, channel, connection, media } = loaded;
    const manifest = provider.manifest;
    const content = resolveVariantContent(manifest, post.masterContent, variant);
    const caption = composeCaption(content.text, content.hashtags, !!manifest.capabilities.fields.hashtags.appendToText);

    // Backend re-validation: never send obviously invalid content to a platform.
    const issues = [
      ...validateVariant(manifest, {
        format: variant.format,
        content,
        settings: variant.providerSettings,
        channelMetadata: channel.metadata,
        media: media.map((m) => ({ id: m.id, kind: m.kind, mimeType: m.mimeType, size: m.size, width: m.width, height: m.height, durationSec: m.durationSec, fileName: m.fileName })),
      }),
      ...(await provider.validateContent({ channel, format: variant.format, content, settings: variant.providerSettings, media })),
    ];
    if (hasBlockingIssues(issues)) {
      throw ProviderError.validation(issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' '), 'validation_failed');
    }

    const credentials = await resolveCredentials(deps.registry, channel, connection);
    const result = await provider.publish({
      delivery: d,
      variant,
      channel,
      format: variant.format,
      content,
      caption,
      settings: variant.providerSettings,
      media: media.map(resolveMedia),
      credentials,
      postScheduledAt: post.schedule?.scheduledAt?.toMillis() ?? null,
      previous: d.processingMetadata ?? {},
      checkpoint: (data) => persistCheckpoint(d, owner, data),
    });
    return await applyResult(deps, d, owner, nowMs, result, post, payload, 0);
  } catch (e) {
    return handleError(deps, d, owner, nowMs, e, loaded?.post ?? null, payload);
  }
}

/** Resolves a delivery whose previous executor died while publishing. */
async function recover(d: Delivery, owner: string, nowMs: number, deps: EngineDeps, payload: DeliveryTaskPayload): Promise<EngineOutcome> {
  const hasCheckpoint = Object.keys(d.processingMetadata ?? {}).length > 0;
  try {
    const loaded = await loadContext(deps.registry, d);
    if (hasCheckpoint && loaded.provider.getPublicationStatus) {
      const credentials = await resolveCredentials(deps.registry, loaded.channel, loaded.connection);
      const status = await loaded.provider.getPublicationStatus({
        delivery: d,
        channel: loaded.channel,
        credentials,
        metadata: d.processingMetadata,
        checkpoint: (data) => persistCheckpoint(d, owner, data),
      });
      log.info('Recovered in-flight delivery via provider status', { deliveryId: d.id, result: status.kind });
      return applyResult(deps, d, owner, nowMs, status, loaded.post, payload, d.statusCheckCount ?? 0);
    }
  } catch (e) {
    log.warn('Recovery status lookup failed', { deliveryId: d.id, error: String(e) });
  }
  const error: DeliveryError = {
    code: OUTCOME_UNKNOWN,
    message: 'The publishing process was interrupted and its outcome could not be confirmed. Check the platform before retrying to avoid a duplicate.',
    category: 'UNKNOWN',
    retryable: false,
  };
  const res = await finalise(d, owner, nowMs, { status: 'failed', error });
  await afterFinalise(deps, d, null, res, 'failed', error);
  return { action: 'failed', error };
}

/** Deferred status check for `processing` deliveries (never blocks a function for minutes). */
export async function checkDeliveryStatus(payload: DeliveryTaskPayload, deps: EngineDeps): Promise<EngineOutcome> {
  const nowMs = (deps.now ?? Date.now)();
  const owner = `chk_${randomUUID()}`;
  const ref = deliveryRef(payload.workspaceId, payload.deliveryId);
  const claimed = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const d = { id: snap.id, ...snap.data() } as Delivery;
    if (d.scheduleVersion !== payload.scheduleVersion || d.status !== 'processing' || leaseAlive(d, nowMs)) return null;
    const lease = { owner, acquiredAt: Timestamp.fromMillis(nowMs), expiresAt: Timestamp.fromMillis(nowMs + (deps.leaseMs ?? DEFAULT_LEASE_MS)) };
    tx.update(ref, { publishingLease: lease, updatedAt: FieldValue.serverTimestamp() });
    return { ...d, publishingLease: lease };
  });
  if (!claimed) return { action: 'ignored', reason: 'not_processing_or_stale' };

  const checks = (claimed.statusCheckCount ?? 0) + 1;
  let loaded: Loaded | null = null;
  try {
    loaded = await loadContext(deps.registry, claimed);
    if (!loaded.provider.getPublicationStatus) throw ProviderError.config('Provider cannot report publication status');
    const credentials = await resolveCredentials(deps.registry, loaded.channel, loaded.connection);
    const status = await loaded.provider.getPublicationStatus({
      delivery: { ...claimed, statusCheckCount: checks - 1 },
      channel: loaded.channel,
      credentials,
      metadata: claimed.processingMetadata ?? {},
      checkpoint: (data) => persistCheckpoint(claimed, owner, data),
    });
    if (status.kind === 'not_published') {
      // Processing metadata says the job vanished without publishing.
      return applyResult(deps, claimed, owner, nowMs, { kind: 'failed', code: 'processing_lost', message: 'The platform lost the processing job', category: 'PROCESSING', retryable: true }, loaded.post, payload, checks);
    }
    return applyResult(deps, claimed, owner, nowMs, status, loaded.post, payload, checks);
  } catch (e) {
    const err = toProviderError(e);
    if (err.retryable) {
      // Transient failure while checking: keep processing, check again later.
      return applyResult(deps, claimed, owner, nowMs, { kind: 'processing', checkAfterSec: 60, metadata: {} }, loaded?.post ?? null, payload, checks);
    }
    return handleError(deps, claimed, owner, nowMs, err, loaded?.post ?? null, payload);
  }
}

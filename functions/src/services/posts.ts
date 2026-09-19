import {
  IN_FLIGHT_STATUSES,
  contentFromMaster,
  defaultSettings,
  suggestFormat,
  type Delivery,
  type MasterContent,
  type Post,
  type PostInput,
  type PostVariant,
  type SocialChannel,
  type VariantInput,
} from '@shared/index';
import type { Transaction } from 'firebase-admin/firestore';
import { FieldValue, Timestamp, clean, db, newId, paths, tsFromIso, variantIdFor } from '../utils/firestore';
import { fail } from '../utils/errors';
import type { ProviderRegistry } from '../providers/registry';
import { audit, type AuditActor } from './audit';
import { loadMediaAssets } from './media';
import { readPostDeliveries, writePostAggregate } from '../publishing/aggregate';
import { parseTaskName, type TaskDispatcher } from '../tasks/dispatcher';

export function searchKeywords(title: string, master: MasterContent): string[] {
  const words = `${title} ${master.title} ${master.text} ${master.hashtags.join(' ')}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
  return [...new Set(words)].slice(0, 60);
}

async function loadChannels(workspaceId: string, ids: string[]): Promise<Map<string, SocialChannel>> {
  const map = new Map<string, SocialChannel>();
  if (ids.length === 0) return map;
  const snaps = await db().getAll(...ids.map((id) => db().doc(paths.channel(workspaceId, id))));
  for (const s of snaps) {
    if (!s.exists) fail('invalid-argument', `Channel ${s.id} does not exist`);
    map.set(s.id, { id: s.id, ...s.data() } as SocialChannel);
  }
  return map;
}

function buildVariant(registry: ProviderRegistry, post: { id: string; workspaceId: string; masterContent: MasterContent }, channel: SocialChannel, input: VariantInput, now: Timestamp): Omit<PostVariant, 'createdAt'> {
  if (!registry.has(channel.provider)) fail('failed-precondition', `${channel.provider} is not available in this environment`);
  const manifest = registry.get(channel.provider).manifest;
  if (!manifest.capabilities.formats.some((f) => f.id === input.format)) fail('invalid-argument', `${manifest.displayName} does not support "${input.format}"`);
  if (input.syncMode === 'custom' && !input.content) fail('invalid-argument', 'Custom variants need content');
  return {
    id: variantIdFor(post.id, channel.id),
    workspaceId: post.workspaceId,
    postId: post.id,
    provider: channel.provider,
    channelId: channel.id,
    syncMode: input.syncMode,
    format: input.format,
    // Linked variants store a snapshot for reference; the effective content is always re-derived from the master.
    content: input.syncMode === 'custom' && input.content ? input.content : contentFromMaster(manifest, post.masterContent),
    mediaIds: input.mediaIds,
    providerSettings: { ...defaultSettings(manifest), ...input.providerSettings },
    scheduledAtOverride: input.scheduledAtOverride ? tsFromIso(input.scheduledAtOverride) : null,
    offsetMinutes: input.offsetMinutes,
    updatedAt: now,
  };
}

async function assertMedia(workspaceId: string, input: PostInput): Promise<void> {
  const ids = new Set([...input.mediaIds, ...input.variants.flatMap((v) => v.mediaIds ?? [])]);
  await loadMediaAssets(workspaceId, [...ids]).catch((e: Error) => fail('invalid-argument', e.message));
}

export async function createPost(registry: ProviderRegistry, input: PostInput, actor: AuditActor, opts: { postId?: string; source?: Post['source'] } = {}): Promise<{ postId: string }> {
  await assertMedia(input.workspaceId, input);
  const channels = await loadChannels(input.workspaceId, input.variants.map((v) => v.channelId));
  const postId = opts.postId ?? newId();
  const now = Timestamp.now();
  const ref = db().doc(paths.post(input.workspaceId, postId));
  const post: Omit<Post, 'id'> = {
    workspaceId: input.workspaceId,
    titleInternal: input.titleInternal,
    masterContent: input.masterContent,
    mediaIds: input.mediaIds,
    status: 'draft',
    schedule: { scheduledAt: input.scheduledAt ? tsFromIso(input.scheduledAt) : null, timezone: input.timezone },
    channelIds: input.variants.map((v) => v.channelId),
    internalNotes: input.internalNotes,
    source: opts.source ?? { kind: 'manual' },
    deliverySummary: {},
    calendarAt: input.scheduledAt ? tsFromIso(input.scheduledAt) : null,
    searchKeywords: searchKeywords(input.titleInternal, input.masterContent),
    createdBy: actor.uid ?? 'system',
    updatedBy: actor.uid ?? 'system',
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
  const batch = db().batch();
  batch.create(ref, clean(post));
  for (const v of input.variants) {
    const variant = buildVariant(registry, { id: postId, workspaceId: input.workspaceId, masterContent: input.masterContent }, channels.get(v.channelId) as SocialChannel, v, now);
    batch.set(db().doc(paths.variant(input.workspaceId, variant.id)), clean({ ...variant, createdAt: now }));
  }
  for (const m of new Set([...input.mediaIds, ...input.variants.flatMap((v) => v.mediaIds ?? [])])) {
    batch.update(db().doc(paths.mediaAsset(input.workspaceId, m)), { usedBy: FieldValue.arrayUnion(postId), lastUsedAt: now });
  }
  await batch.commit().catch((e: { code?: number }) => {
    if (e.code === 6) fail('already-exists', 'Post already exists');
    throw e;
  });
  await audit({ workspaceId: input.workspaceId, actor, action: 'post.created', entityType: 'post', entityId: postId, metadata: { channels: post.channelIds, source: post.source.kind } });
  return { postId };
}

export async function updatePost(
  registry: ProviderRegistry,
  dispatcher: TaskDispatcher,
  input: PostInput & { postId: string; expectedRevision?: number },
  actor: AuditActor,
): Promise<{ postId: string; lockedChannels: string[]; revision: number }> {
  await assertMedia(input.workspaceId, input);
  const channels = await loadChannels(input.workspaceId, input.variants.map((v) => v.channelId));
  const w = input.workspaceId;
  const lockedChannels: string[] = [];
  const cancelTasks: string[] = [];
  let revision = 0;
  let mediaDiff = { added: [] as string[], removed: [] as string[] };

  await db().runTransaction(async (tx: Transaction) => {
    lockedChannels.length = 0;
    cancelTasks.length = 0;
    const ref = db().doc(paths.post(w, input.postId));
    const snap = await tx.get(ref);
    if (!snap.exists) fail('not-found', 'Post not found');
    const post = { id: snap.id, ...snap.data() } as Post;
    if (input.expectedRevision != null && post.revision !== input.expectedRevision) {
      fail('aborted', 'This post was changed by someone else. Reload to see the latest version.', { reason: 'revision_conflict', revision: post.revision });
    }
    const deliveries = await readPostDeliveries(tx, w, post.id);
    const byChannel = new Map(deliveries.map((d) => [d.channelId, d]));
    const variantSnaps = await tx.get(db().collection(paths.variants(w)).where('postId', '==', post.id));
    const now = Timestamp.now();

    const locked = (channelId: string) => {
      const d = byChannel.get(channelId);
      return !!d && (d.status === 'published' || IN_FLIGHT_STATUSES.includes(d.status));
    };

    const nextChannelIds = input.variants.map((v) => v.channelId);
    // Locked channels cannot be removed from the post.
    for (const id of post.channelIds) if (locked(id) && !nextChannelIds.includes(id)) nextChannelIds.push(id);

    const overrides = new Map<string, Partial<Delivery>>();
    for (const v of input.variants) {
      if (locked(v.channelId)) {
        lockedChannels.push(v.channelId);
        continue;
      }
      const variant = buildVariant(registry, { id: post.id, workspaceId: w, masterContent: input.masterContent }, channels.get(v.channelId) as SocialChannel, v, now);
      tx.set(db().doc(paths.variant(w, variant.id)), clean({ ...variant, createdAt: now }), { merge: true });
    }
    // Removed channels: delete variant and cancel pending delivery.
    for (const vs of variantSnaps.docs) {
      const channelId = vs.get('channelId') as string;
      if (nextChannelIds.includes(channelId)) continue;
      tx.delete(vs.ref);
      const d = byChannel.get(channelId);
      if (d && d.status !== 'cancelled') {
        const upd: Partial<Delivery> = { status: 'cancelled', scheduleVersion: d.scheduleVersion + 1, taskName: null };
        if (d.taskName) cancelTasks.push(d.taskName);
        tx.update(db().doc(paths.delivery(w, d.id)), { ...upd, updatedAt: FieldValue.serverTimestamp() });
        overrides.set(d.id, upd);
      }
    }

    const before = new Set(post.mediaIds);
    const after = new Set(input.mediaIds);
    mediaDiff = { added: [...after].filter((m) => !before.has(m)), removed: [...before].filter((m) => !after.has(m)) };
    for (const m of mediaDiff.added) tx.update(db().doc(paths.mediaAsset(w, m)), { usedBy: FieldValue.arrayUnion(post.id), lastUsedAt: now });

    revision = post.revision + 1;
    const fields = {
      titleInternal: input.titleInternal,
      masterContent: input.masterContent,
      mediaIds: input.mediaIds,
      internalNotes: input.internalNotes,
      channelIds: nextChannelIds,
      searchKeywords: searchKeywords(input.titleInternal, input.masterContent),
      updatedBy: actor.uid ?? 'system',
      revision,
      // Drafts keep the desired time; scheduled posts change time only through schedulePost.
      ...(deliveries.length === 0 || post.status === 'draft'
        ? { schedule: { scheduledAt: input.scheduledAt ? tsFromIso(input.scheduledAt) : null, timezone: input.timezone }, calendarAt: input.scheduledAt ? tsFromIso(input.scheduledAt) : null }
        : {}),
    };
    if (deliveries.length) writePostAggregate(tx, w, post.id, deliveries, overrides, fields);
    else tx.update(ref, { ...fields, updatedAt: FieldValue.serverTimestamp() });
    await audit({ workspaceId: w, actor, action: 'post.edited', entityType: 'post', entityId: post.id, metadata: { channels: nextChannelIds, lockedChannels } }, tx);
  });

  // Media no longer used by this post
  for (const m of mediaDiff.removed) {
    await db().doc(paths.mediaAsset(w, m)).update({ usedBy: FieldValue.arrayRemove(input.postId) }).catch(() => undefined);
  }
  for (const t of cancelTasks) {
    const p = parseTaskName(t);
    if (p) await dispatcher.cancel(p.target, p.kind, p.id);
  }
  return { postId: input.postId, lockedChannels, revision };
}

export async function deletePost(dispatcher: TaskDispatcher, workspaceId: string, postId: string, actor: AuditActor): Promise<void> {
  const tasks: string[] = [];
  let mediaIds: string[] = [];
  await db().runTransaction(async (tx) => {
    tasks.length = 0;
    const ref = db().doc(paths.post(workspaceId, postId));
    const snap = await tx.get(ref);
    if (!snap.exists) fail('not-found', 'Post not found');
    const deliveries = await readPostDeliveries(tx, workspaceId, postId);
    if (deliveries.some((d) => d.status === 'published' || IN_FLIGHT_STATUSES.includes(d.status))) {
      fail('failed-precondition', 'Posts with published or in-progress publications cannot be deleted. Cancel the pending ones instead.');
    }
    const variants = await tx.get(db().collection(paths.variants(workspaceId)).where('postId', '==', postId));
    mediaIds = (snap.get('mediaIds') as string[]) ?? [];
    for (const d of deliveries) {
      if (d.taskName) tasks.push(d.taskName);
      tx.delete(db().doc(paths.delivery(workspaceId, d.id)));
    }
    variants.docs.forEach((v) => tx.delete(v.ref));
    tx.delete(ref);
    await audit({ workspaceId, actor, action: 'post.deleted', entityType: 'post', entityId: postId, metadata: {} }, tx);
  });
  for (const t of tasks) {
    const p = parseTaskName(t);
    if (p) await dispatcher.cancel(p.target, p.kind, p.id);
  }
  for (const m of mediaIds) await db().doc(paths.mediaAsset(workspaceId, m)).update({ usedBy: FieldValue.arrayRemove(postId) }).catch(() => undefined);
}

/** Variant input for a channel with provider defaults (used by bulk and import). */
export function defaultVariantInput(
  registry: ProviderRegistry,
  channel: SocialChannel,
  media: Array<{ kind: 'image' | 'video'; width: number | null; height: number | null }>,
  overrides: { format?: string; providerSettings?: Record<string, unknown>; offsetMinutes?: number } = {},
): VariantInput {
  const manifest = registry.get(channel.provider).manifest;
  const format = overrides.format ?? suggestFormat(manifest, media)?.id ?? manifest.capabilities.formats[0]?.id ?? 'post';
  return {
    channelId: channel.id,
    syncMode: 'master',
    format,
    mediaIds: null,
    providerSettings: { ...defaultSettings(manifest), ...(overrides.providerSettings ?? {}) },
    offsetMinutes: overrides.offsetMinutes ?? 0,
    scheduledAtOverride: null,
  };
}

import {
  createPostSchema,
  updatePostSchema,
  postRef,
  schedulePostSchema,
  publishNowSchema,
  cancelPostSchema,
  retryDeliverySchema,
  updatePublishedSchema,
  deletePublishedSchema,
  composeCaption,
  resolveVariantContent,
  type Delivery,
  type Post,
  type PostVariant,
  type SocialChannel,
  type SocialConnection,
} from '@shared/index';
import { requirePermission } from '../auth/access';
import { callable } from './callable';
import { getRegistry } from '../providers';
import { getDispatcher } from '../tasks/dispatcher';
import { createPost, deletePost, updatePost } from '../services/posts';
import { cancelPost, retryDelivery, schedulePost } from '../scheduling/scheduler';
import { userActor, audit } from '../services/audit';
import { resolveCredentials } from '../services/credentials';
import { FieldValue, db, paths } from '../utils/firestore';
import { fail } from '../utils/errors';
import { ALL_SECRETS } from '../config/env';

const deps = () => ({ registry: getRegistry(), dispatcher: getDispatcher() });

export const createPostFn = callable(createPostSchema, async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'content.write');
  return createPost(getRegistry(), data, userActor(actor.uid, actor.email));
});

export const updatePostFn = callable(updatePostSchema, async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'content.write');
  return updatePost(getRegistry(), getDispatcher(), data, userActor(actor.uid, actor.email));
});

export const deletePostFn = callable(postRef, async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'content.write');
  await deletePost(getDispatcher(), data.workspaceId, data.postId, userActor(actor.uid, actor.email));
  return { ok: true };
});

export const schedulePostFn = callable(
  schedulePostSchema,
  async (data, req) => {
    const actor = await requirePermission(req, data.workspaceId, 'content.schedule');
    return schedulePost(deps(), data.workspaceId, data.postId, { kind: 'at', scheduledAtMs: Date.parse(data.scheduledAt), timezone: data.timezone }, userActor(actor.uid, actor.email));
  },
  { secrets: ALL_SECRETS },
);

export const publishNowFn = callable(
  publishNowSchema,
  async (data, req) => {
    const actor = await requirePermission(req, data.workspaceId, 'content.schedule');
    const ws = await db().doc(paths.workspace(data.workspaceId)).get();
    return schedulePost(deps(), data.workspaceId, data.postId, { kind: 'now', timezone: (ws.get('timezone') as string) ?? 'UTC' }, userActor(actor.uid, actor.email));
  },
  { secrets: ALL_SECRETS },
);

export const cancelPostFn = callable(cancelPostSchema, async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'content.schedule');
  return cancelPost(deps(), data.workspaceId, data.postId, data.channelIds, userActor(actor.uid, actor.email));
});

export const retryDeliveryFn = callable(retryDeliverySchema, async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'content.schedule');
  return retryDelivery(deps(), data.workspaceId, data.deliveryId, data.confirmPossibleDuplicate, userActor(actor.uid, actor.email));
});

async function loadPublished(workspaceId: string, deliveryId: string) {
  const dSnap = await db().doc(paths.delivery(workspaceId, deliveryId)).get();
  if (!dSnap.exists) fail('not-found', 'Delivery not found');
  const delivery = { id: dSnap.id, ...dSnap.data() } as Delivery;
  if (delivery.status !== 'published' || !delivery.externalPostId) fail('failed-precondition', 'Only published deliveries can be changed on the platform');
  const [p, v, c, conn] = await db().getAll(
    db().doc(paths.post(workspaceId, delivery.postId)),
    db().doc(paths.variant(workspaceId, delivery.variantId)),
    db().doc(paths.channel(workspaceId, delivery.channelId)),
    db().doc(paths.connection(workspaceId, delivery.connectionId)),
  );
  if (!p?.exists || !v?.exists || !c?.exists || !conn?.exists) fail('failed-precondition', 'The post or account no longer exists');
  return {
    delivery,
    post: { id: p.id, ...p.data() } as Post,
    variant: { id: v.id, ...v.data() } as PostVariant,
    channel: { id: c.id, ...c.data() } as SocialChannel,
    connection: { id: conn.id, ...conn.data() } as SocialConnection,
  };
}

/** Pushes the current variant content to an already-published post — only if the provider supports it. */
export const updatePublishedFn = callable(
  updatePublishedSchema,
  async (data, req) => {
    const actor = await requirePermission(req, data.workspaceId, 'content.schedule');
    const { delivery, post, variant, channel, connection } = await loadPublished(data.workspaceId, data.deliveryId);
    const provider = getRegistry().get(delivery.provider);
    if (!provider.getCapabilities(channel).canEditPublishedPost || !provider.updatePublished) {
      fail('failed-precondition', 'This platform does not allow this published content to be edited through its API.', { reason: 'edit_not_supported' });
    }
    const content = resolveVariantContent(provider.manifest, post.masterContent, variant);
    const caption = composeCaption(content.text, content.hashtags, !!provider.manifest.capabilities.fields.hashtags.appendToText);
    const credentials = await resolveCredentials(getRegistry(), channel, connection);
    await provider.updatePublished({ delivery, channel, credentials, content, caption, settings: variant.providerSettings });
    await db().doc(paths.delivery(data.workspaceId, delivery.id)).update({ lastRemoteUpdateAt: FieldValue.serverTimestamp() });
    await audit({ workspaceId: data.workspaceId, actor: userActor(actor.uid, actor.email), action: 'delivery.updated_on_platform', entityType: 'delivery', entityId: delivery.id, metadata: { provider: delivery.provider } });
    return { ok: true };
  },
  { secrets: ALL_SECRETS },
);

/** Destructive: removes the publication from the platform. Requires explicit confirmation. */
export const deletePublishedFn = callable(
  deletePublishedSchema,
  async (data, req) => {
    const actor = await requirePermission(req, data.workspaceId, 'content.schedule');
    const { delivery, channel, connection } = await loadPublished(data.workspaceId, data.deliveryId);
    const provider = getRegistry().get(delivery.provider);
    if (!provider.getCapabilities(channel).canDeletePost || !provider.deletePublished) {
      fail('failed-precondition', 'This platform does not allow deleting this publication through its API.');
    }
    const credentials = await resolveCredentials(getRegistry(), channel, connection);
    await provider.deletePublished({ delivery, channel, credentials });
    await db().doc(paths.delivery(data.workspaceId, delivery.id)).update({ removedFromPlatformAt: FieldValue.serverTimestamp() });
    await audit({ workspaceId: data.workspaceId, actor: userActor(actor.uid, actor.email), action: 'delivery.deleted_on_platform', entityType: 'delivery', entityId: delivery.id, metadata: { provider: delivery.provider } });
    return { ok: true };
  },
  { secrets: ALL_SECRETS },
);

/** Duplicates a post as a new draft (same content, variants and media). */
export const duplicatePostFn = callable(postRef, async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'content.write');
  const snap = await db().doc(paths.post(data.workspaceId, data.postId)).get();
  if (!snap.exists) fail('not-found', 'Post not found');
  const post = { id: snap.id, ...snap.data() } as Post;
  const variants = await db().collection(paths.variants(data.workspaceId)).where('postId', '==', post.id).get();
  return createPost(
    getRegistry(),
    {
      workspaceId: data.workspaceId,
      titleInternal: post.titleInternal ? `${post.titleInternal} (copy)` : '',
      masterContent: post.masterContent,
      mediaIds: post.mediaIds,
      internalNotes: post.internalNotes,
      timezone: post.schedule.timezone,
      scheduledAt: null,
      variants: variants.docs.map((d) => {
        const v = d.data() as PostVariant;
        return {
          channelId: v.channelId,
          syncMode: v.syncMode,
          format: v.format,
          content: v.content,
          mediaIds: v.mediaIds,
          providerSettings: v.providerSettings,
          offsetMinutes: v.offsetMinutes,
          scheduledAtOverride: null,
        };
      }),
    },
    userActor(actor.uid, actor.email),
  );
});

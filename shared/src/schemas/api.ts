import { z } from 'zod';
import { isValidTimeZone } from '../scheduling/time';
import { MAX_OFFSET_MINUTES } from '../scheduling/deliverySchedule';

/**
 * Request schemas for every callable. The PWA uses them for form validation;
 * the backend re-validates every request with the same schemas.
 */

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'Invalid id');
export const zId = id;
const isoInstant = z.iso.datetime({ offset: true });
const timezone = z.string().refine(isValidTimeZone, 'Invalid IANA timezone');
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected yyyy-MM-dd');
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');
const hashtag = z.string().trim().min(1).max(100).transform((t) => t.replace(/^#+/, ''));

export const workspaceRef = z.object({ workspaceId: id });

export const masterContentSchema = z.object({
  text: z.string().max(70_000).default(''),
  title: z.string().max(500).default(''),
  description: z.string().max(10_000).default(''),
  hashtags: z.array(hashtag).max(60).default([]),
  link: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]).default(''),
});

export const variantContentSchema = masterContentSchema;

export const variantInputSchema = z.object({
  channelId: id,
  syncMode: z.enum(['master', 'custom']),
  format: z.string().min(1).max(40),
  content: variantContentSchema.optional(),
  mediaIds: z.array(id).max(35).nullable().default(null),
  providerSettings: z.record(z.string(), z.unknown()).default({}),
  offsetMinutes: z.number().int().min(-MAX_OFFSET_MINUTES).max(MAX_OFFSET_MINUTES).default(0),
  scheduledAtOverride: isoInstant.nullable().default(null),
});
export type VariantInput = z.infer<typeof variantInputSchema>;

export const postInputSchema = z.object({
  workspaceId: id,
  titleInternal: z.string().trim().max(200).default(''),
  masterContent: masterContentSchema,
  mediaIds: z.array(id).max(35).default([]),
  internalNotes: z.string().max(5000).default(''),
  variants: z.array(variantInputSchema).max(30).default([]),
  timezone: timezone,
  /** Desired post time (UTC ISO). Stored on drafts too; only scheduling creates deliveries. */
  scheduledAt: isoInstant.nullable().default(null),
});
export type PostInput = z.infer<typeof postInputSchema>;

export const createPostSchema = postInputSchema;
export const updatePostSchema = postInputSchema.extend({
  postId: id,
  /** Optimistic concurrency: reject when the post changed since the editor loaded it. */
  expectedRevision: z.number().int().min(0).optional(),
});

export const postRef = z.object({ workspaceId: id, postId: id });

export const schedulePostSchema = z.object({
  workspaceId: id,
  postId: id,
  scheduledAt: isoInstant,
  timezone: timezone,
});

export const publishNowSchema = postRef;

export const cancelPostSchema = z.object({
  workspaceId: id,
  postId: id,
  /** Cancel only these channels; all pending deliveries when omitted. */
  channelIds: z.array(id).optional(),
});

export const deliveryRef = z.object({ workspaceId: id, deliveryId: id });

export const retryDeliverySchema = deliveryRef.extend({
  /** Required when the previous outcome is unknown (possible duplicate). */
  confirmPossibleDuplicate: z.boolean().default(false),
});

export const updatePublishedSchema = deliveryRef;

export const deletePublishedSchema = deliveryRef.extend({ confirm: z.literal(true) });

export const registerMediaSchema = z.object({
  workspaceId: id,
  mediaId: id,
  fileName: z.string().min(1).max(300),
  mimeType: z.string().regex(/^(image|video)\/[A-Za-z0-9.+-]+$/, 'Only images and videos are supported'),
  size: z.number().int().positive(),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  durationSec: z.number().nonnegative().nullable().default(null),
  checksum: z.string().max(128).nullable().default(null),
  extension: z.string().regex(/^[a-z0-9]{1,8}$/),
  hasThumbnail: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

export const mediaRef = z.object({ workspaceId: id, mediaId: id });
export const updateMediaTagsSchema = mediaRef.extend({ tags: z.array(z.string().trim().min(1).max(40)).max(20) });

export const startOAuthSchema = z.object({
  workspaceId: id,
  authFamily: z.string().min(1).max(40),
  /** App path to return to after the callback (validated as same-origin path). */
  returnTo: z.string().regex(/^\/[A-Za-z0-9/_?=&.-]*$/).default('/connections'),
  /** Existing connection to re-authorise. */
  connectionId: id.optional(),
});

export const connectionRef = z.object({ workspaceId: id, connectionId: id });
export const disconnectSchema = connectionRef.extend({ confirm: z.boolean().default(false) });
export const channelToggleSchema = z.object({ workspaceId: id, channelId: id, enabled: z.boolean() });

export const bulkFrequencySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('daily') }),
  z.object({ type: z.literal('weekdays'), weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7) }),
  z.object({ type: z.literal('interval'), everyNDays: z.number().int().min(1).max(60) }),
]);

export const bulkItemSchema = z.discriminatedUnion('kind', [
  /** Schedule an existing draft post as-is. */
  z.object({ kind: z.literal('draft'), itemId: id, postId: id }),
  /** Create a new post from media + caption. */
  z.object({
    kind: z.literal('media'),
    itemId: id,
    mediaIds: z.array(id).min(1).max(35),
    text: z.string().max(70_000).default(''),
    title: z.string().max(500).default(''),
  }),
]);

export const bulkScheduleSchema = z.object({
  workspaceId: id,
  items: z.array(bulkItemSchema).min(1).max(200),
  from: localDate,
  to: localDate,
  timezone,
  times: z.array(localTime).min(1).max(12),
  frequency: bulkFrequencySchema,
  distribution: z.enum(['sequential', 'random', 'manual']),
  seed: z.number().int().optional(),
  manual: z.record(z.string(), z.object({ date: localDate, time: localTime })).optional(),
  channelIds: z.array(id).min(1).max(30),
  /** Minutes after the slot per provider id, e.g. { facebook: 5, tiktok: 30 }. */
  providerOffsets: z.record(z.string(), z.number().int().min(0).max(MAX_OFFSET_MINUTES)).default({}),
  /** Per-channel defaults for new variants (format + settings like Pinterest board). */
  channelDefaults: z.record(z.string(), z.object({ format: z.string().optional(), providerSettings: z.record(z.string(), z.unknown()).default({}) })).default({}),
  hashtags: z.array(hashtag).max(60).default([]),
  link: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]).default(''),
});
export type BulkScheduleInput = z.infer<typeof bulkScheduleSchema>;

export const fetchImportSchema = z.object({
  workspaceId: id,
  channelId: id,
  from: localDate,
  to: localDate,
  timezone,
});

export const importPostsSchema = z.object({
  workspaceId: id,
  importJobId: id,
  externalPostIds: z.array(z.string().min(1).max(200)).min(1).max(100),
  destinationChannelIds: z.array(id).max(30).default([]),
  /** When present, imported posts are scheduled with the bulk planner. */
  schedule: bulkScheduleSchema
    .pick({ from: true, to: true, timezone: true, times: true, frequency: true, distribution: true, seed: true, providerOffsets: true, channelDefaults: true })
    .nullable()
    .default(null),
});

export const workspaceCreateSchema = z.object({ name: z.string().trim().min(2).max(80), timezone });
export const workspaceUpdateSchema = z.object({ workspaceId: id, name: z.string().trim().min(2).max(80).optional(), timezone: timezone.optional() });

export const inviteMemberSchema = z.object({
  workspaceId: id,
  email: z.email().transform((e) => e.toLowerCase()),
  role: z.enum(['ADMIN', 'EDITOR', 'VIEWER']),
});
export const updateMemberSchema = z.object({ workspaceId: id, uid: id, role: z.enum(['ADMIN', 'EDITOR', 'VIEWER']) });
export const removeMemberSchema = z.object({ workspaceId: id, uid: id });
export const revokeInvitationSchema = z.object({ workspaceId: id, email: z.email().transform((e) => e.toLowerCase()) });

export const notificationPrefsSchema = z.object({
  pushEnabled: z.boolean(),
  onPublished: z.boolean(),
  onPartial: z.boolean(),
  onFailed: z.boolean(),
  onReauth: z.boolean(),
});
export const registerPushTokenSchema = z.object({ token: z.string().min(10).max(4096), platform: z.string().max(200).default('') });

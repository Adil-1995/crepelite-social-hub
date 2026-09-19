import { bulkScheduleSchema, fetchImportSchema, importPostsSchema, zId, type SocialChannel } from '@shared/index';
import { requirePermission } from '../auth/access';
import { callable } from './callable';
import { getRegistry } from '../providers';
import { getDispatcher } from '../tasks/dispatcher';
import { createBulkSchedule } from '../services/bulk';
import { fetchImportCandidates, importPostsAsDrafts } from '../services/imports';
import { defaultVariantInput } from '../services/posts';
import { loadMediaAssets } from '../services/media';
import { userActor } from '../services/audit';
import { ALL_SECRETS } from '../config/env';
import { db, paths } from '../utils/firestore';
import { fail } from '../utils/errors';

export const createBulkScheduleFn = callable(
  bulkScheduleSchema.extend({ jobId: zId }),
  async (data, req) => {
    const actor = await requirePermission(req, data.workspaceId, 'content.schedule');
    return createBulkSchedule({ registry: getRegistry(), dispatcher: getDispatcher() }, data, userActor(actor.uid, actor.email));
  },
  { secrets: ALL_SECRETS, timeoutSeconds: 540, memory: '512MiB' },
);

export const fetchImportCandidatesFn = callable(
  fetchImportSchema,
  async (data, req) => {
    const actor = await requirePermission(req, data.workspaceId, 'content.write');
    return fetchImportCandidates(getRegistry(), data, userActor(actor.uid, actor.email));
  },
  { secrets: ALL_SECRETS, timeoutSeconds: 120 },
);

/**
 * Imports selected posts as drafts; when a schedule is given the drafts whose
 * media is available are distributed with the bulk planner to the destinations.
 */
export const importPostsFn = callable(
  importPostsSchema,
  async (data, req) => {
    const actor = await requirePermission(req, data.workspaceId, 'content.write');
    const registry = getRegistry();
    const who = userActor(actor.uid, actor.email);
    const channels: SocialChannel[] = [];
    for (const id of data.destinationChannelIds) {
      const s = await db().doc(paths.channel(data.workspaceId, id)).get();
      if (!s.exists) fail('invalid-argument', `Channel ${id} not found`);
      channels.push({ id: s.id, ...s.data() } as SocialChannel);
    }
    const ws = await db().doc(paths.workspace(data.workspaceId)).get();
    const timezone = data.schedule?.timezone ?? (ws.get('timezone') as string);
    const drafts = await importPostsAsDrafts(
      registry,
      { workspaceId: data.workspaceId, importJobId: data.importJobId, externalPostIds: data.externalPostIds, destinationChannelIds: data.destinationChannelIds, timezone },
      who,
      async (mediaIds) => {
        const media = await loadMediaAssets(data.workspaceId, mediaIds);
        return channels.map((c) =>
          defaultVariantInput(registry, c, media, {
            format: data.schedule?.channelDefaults[c.id]?.format,
            providerSettings: data.schedule?.channelDefaults[c.id]?.providerSettings,
            offsetMinutes: data.schedule?.providerOffsets[c.provider] ?? 0,
          }),
        );
      },
    );
    let bulk = null;
    const schedulable = drafts.filter((d) => d.mediaReady && d.note !== 'Already imported');
    if (data.schedule && schedulable.length && channels.length) {
      bulk = await createBulkSchedule(
        { registry, dispatcher: getDispatcher() },
        {
          ...data.schedule,
          workspaceId: data.workspaceId,
          jobId: `import_${data.importJobId}`,
          items: schedulable.map((d) => ({ kind: 'draft' as const, itemId: d.postId, postId: d.postId })),
          channelIds: channels.map((c) => c.id),
          hashtags: [],
          link: '',
        },
        who,
      );
    }
    return { drafts, bulk };
  },
  { secrets: ALL_SECRETS, timeoutSeconds: 540, memory: '1GiB' },
);

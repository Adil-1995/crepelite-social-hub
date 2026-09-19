import {
  hasBlockingIssues,
  planBulkSchedule,
  resolveVariantContent,
  validateVariant,
  contentFromMaster,
  type BulkPlanEntry,
  type BulkScheduleInput,
  type MasterContent,
  type Post,
  type PostInput,
  type SocialChannel,
  type VariantInput,
} from '@shared/index';
import { FieldValue, db, paths } from '../utils/firestore';
import { fail } from '../utils/errors';
import type { ProviderRegistry } from '../providers/registry';
import type { TaskDispatcher } from '../tasks/dispatcher';
import { createPost, defaultVariantInput, updatePost } from './posts';
import { loadMediaAssets } from './media';
import { schedulePost } from '../scheduling/scheduler';
import { audit, type AuditActor } from './audit';
import { log } from '../utils/logger';

export interface BulkItemResult {
  itemId: string;
  postId: string | null;
  scheduledAt: number | null;
  status: 'scheduled' | 'failed' | 'skipped';
  error?: string;
}

async function loadChannels(workspaceId: string, ids: string[]): Promise<SocialChannel[]> {
  const snaps = await db().getAll(...ids.map((id) => db().doc(paths.channel(workspaceId, id))));
  return snaps.map((s) => {
    if (!s.exists) fail('invalid-argument', `Channel ${s.id} not found`);
    return { id: s.id, ...s.data() } as SocialChannel;
  });
}

/**
 * Bulk planner (server side). The PWA shows the exact same plan as a preview
 * (shared planBulkSchedule, same seed); nothing is created until the user
 * confirms. Post ids are derived from the job id + item id, so repeating the
 * request never duplicates posts.
 */
export async function createBulkSchedule(
  deps: { registry: ProviderRegistry; dispatcher: TaskDispatcher; now?: () => number },
  input: BulkScheduleInput & { jobId: string },
  actor: AuditActor,
): Promise<{ jobId: string; results: BulkItemResult[] }> {
  const nowMs = (deps.now ?? Date.now)();
  const plan = planBulkSchedule({
    itemIds: input.items.map((i) => i.itemId),
    from: input.from,
    to: input.to,
    timezone: input.timezone,
    times: input.times,
    frequency: input.frequency,
    distribution: input.distribution,
    seed: input.seed,
    manual: input.manual,
    notBeforeMs: nowMs + 2 * 60_000,
  });
  if (plan.unassignedItemIds.length > 0) fail('failed-precondition', plan.warnings.join(' '), { unassigned: plan.unassignedItemIds });

  const channels = await loadChannels(input.workspaceId, input.channelIds);
  for (const c of channels) {
    if (!deps.registry.has(c.provider)) fail('failed-precondition', `${c.provider} is not available`);
    if (c.status !== 'connected' || !c.enabled) fail('failed-precondition', `${c.name} is not connected`);
  }

  const jobRef = db().doc(`${paths.bulkJobs(input.workspaceId)}/${input.jobId}`);
  const existing = await jobRef.get();
  if (existing.exists && existing.get('status') === 'completed') {
    return { jobId: input.jobId, results: existing.get('results') as BulkItemResult[] };
  }

  // Pass 1 — build every post input and validate all of them before writing anything.
  const entryByItem = new Map<string, BulkPlanEntry>(plan.entries.map((e) => [e.itemId, e]));
  const prepared: Array<{ itemId: string; postId: string; entry: BulkPlanEntry; input: PostInput; existingPost: Post | null }> = [];
  const problems: Array<{ itemId: string; messages: string[] }> = [];

  for (const item of input.items) {
    const entry = entryByItem.get(item.itemId) as BulkPlanEntry;
    let master: MasterContent;
    let mediaIds: string[];
    let existingPost: Post | null = null;
    let postId: string;
    if (item.kind === 'draft') {
      const snap = await db().doc(paths.post(input.workspaceId, item.postId)).get();
      if (!snap.exists) {
        problems.push({ itemId: item.itemId, messages: ['Draft not found'] });
        continue;
      }
      existingPost = { id: snap.id, ...snap.data() } as Post;
      if (existingPost.status !== 'draft') {
        problems.push({ itemId: item.itemId, messages: [`"${existingPost.titleInternal || 'Post'}" is not a draft`] });
        continue;
      }
      master = existingPost.masterContent;
      mediaIds = existingPost.mediaIds;
      postId = existingPost.id;
    } else {
      master = { text: item.text, title: item.title, description: '', hashtags: input.hashtags, link: input.link };
      mediaIds = item.mediaIds;
      postId = `${input.jobId}_${item.itemId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
    }
    const media = await loadMediaAssets(input.workspaceId, mediaIds).catch((e: Error) => {
      problems.push({ itemId: item.itemId, messages: [e.message] });
      return null;
    });
    if (!media) continue;

    const variants: VariantInput[] = channels.map((c) =>
      defaultVariantInput(deps.registry, c, media, {
        format: input.channelDefaults[c.id]?.format,
        providerSettings: input.channelDefaults[c.id]?.providerSettings,
        offsetMinutes: input.providerOffsets[c.provider] ?? 0,
      }),
    );
    const messages: string[] = [];
    for (const v of variants) {
      const channel = channels.find((c) => c.id === v.channelId) as SocialChannel;
      const manifest = deps.registry.get(channel.provider).manifest;
      const content = resolveVariantContent(manifest, master, { syncMode: 'master', content: contentFromMaster(manifest, master) });
      const issues = validateVariant(manifest, {
        format: v.format,
        content,
        settings: v.providerSettings,
        channelMetadata: channel.metadata,
        media: media.map((m) => ({ id: m.id, kind: m.kind, mimeType: m.mimeType, size: m.size, width: m.width, height: m.height, durationSec: m.durationSec, fileName: m.fileName })),
      });
      if (hasBlockingIssues(issues)) messages.push(...issues.filter((i) => i.severity === 'error').map((i) => `${channel.name}: ${i.message}`));
    }
    if (messages.length) {
      problems.push({ itemId: item.itemId, messages });
      continue;
    }
    prepared.push({
      itemId: item.itemId,
      postId,
      entry,
      existingPost,
      input: {
        workspaceId: input.workspaceId,
        titleInternal: existingPost?.titleInternal ?? (item.kind === 'media' ? item.title : ''),
        masterContent: master,
        mediaIds,
        internalNotes: existingPost?.internalNotes ?? '',
        timezone: input.timezone,
        scheduledAt: new Date(entry.scheduledAtMs).toISOString(),
        variants,
      },
    });
  }
  if (problems.length) fail('failed-precondition', 'Some contents are not valid for the selected networks', { problems });

  await jobRef.set(
    { workspaceId: input.workspaceId, status: 'running', config: { ...input, items: input.items.length }, createdBy: actor.uid, createdAt: FieldValue.serverTimestamp(), postIds: prepared.map((p) => p.postId) },
    { merge: true },
  );

  // Pass 2 — create/update + schedule each post (each scheduling is its own transaction).
  const results: BulkItemResult[] = [];
  for (const p of prepared) {
    try {
      const exists = p.existingPost || (await db().doc(paths.post(input.workspaceId, p.postId)).get()).exists;
      if (exists) await updatePost(deps.registry, deps.dispatcher, { ...p.input, postId: p.postId }, actor);
      else await createPost(deps.registry, p.input, actor, { postId: p.postId, source: { kind: 'bulk', bulkJobId: input.jobId } });
      await schedulePost(deps, input.workspaceId, p.postId, { kind: 'at', scheduledAtMs: p.entry.scheduledAtMs, timezone: input.timezone }, actor);
      results.push({ itemId: p.itemId, postId: p.postId, scheduledAt: p.entry.scheduledAtMs, status: 'scheduled' });
    } catch (e) {
      log.warn('Bulk item failed', { jobId: input.jobId, itemId: p.itemId, error: (e as Error).message });
      results.push({ itemId: p.itemId, postId: p.postId, scheduledAt: p.entry.scheduledAtMs, status: 'failed', error: (e as Error).message });
    }
  }
  const failed = results.filter((r) => r.status === 'failed').length;
  await jobRef.set({ status: failed ? 'failed' : 'completed', results, completedAt: FieldValue.serverTimestamp() }, { merge: true });
  await audit({ workspaceId: input.workspaceId, actor, action: 'bulk.scheduled', entityType: 'bulk', entityId: input.jobId, metadata: { posts: results.length, failed } });
  return { jobId: input.jobId, results };
}

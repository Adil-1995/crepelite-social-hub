import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DateTime } from 'luxon';
import type { ImportCandidate, SocialChannel, SocialConnection } from '@shared/index';
import { FieldValue, db, newId, paths } from '../utils/firestore';
import { fail } from '../utils/errors';
import type { ProviderRegistry } from '../providers/registry';
import type { ImportedMedia, ImportedPost } from '../providers/types';
import { resolveCredentials } from './credentials';
import { bucket, storagePathFor } from './media';
import { createPost } from './posts';
import { audit, type AuditActor } from './audit';
import { log } from '../utils/logger';
import { MAX_UPLOAD_BYTES } from '../api/media';

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

/**
 * Import = read the user's OWN posts through the provider's official API
 * (`listPosts`). No scraping, ever. When the API does not expose the original
 * file, the candidate is flagged and the user must upload it manually.
 */
export async function fetchImportCandidates(
  registry: ProviderRegistry,
  input: { workspaceId: string; channelId: string; from: string; to: string; timezone: string },
  actor: AuditActor,
): Promise<{ importJobId: string; candidates: ImportCandidate[] }> {
  const chSnap = await db().doc(paths.channel(input.workspaceId, input.channelId)).get();
  if (!chSnap.exists) fail('not-found', 'Channel not found');
  const channel = { id: chSnap.id, ...chSnap.data() } as SocialChannel;
  const provider = registry.get(channel.provider);
  if (!provider.getCapabilities(channel).canReadPosts || !provider.listPosts) {
    fail('failed-precondition', `${provider.displayName} does not allow reading your posts through its API.`);
  }
  const connSnap = await db().doc(paths.connection(input.workspaceId, channel.connectionId)).get();
  const connection = { id: connSnap.id, ...connSnap.data() } as SocialConnection;
  const credentials = await resolveCredentials(registry, channel, connection);
  const fromMs = DateTime.fromISO(input.from, { zone: input.timezone }).startOf('day').toMillis();
  const toMs = DateTime.fromISO(input.to, { zone: input.timezone }).endOf('day').toMillis();
  if (toMs < fromMs) fail('invalid-argument', 'Invalid date range');
  const posts = await provider.listPosts({ channel, credentials, fromMs, toMs, limit: 100 });

  const id = newId();
  const candidates: ImportCandidate[] = posts.map(({ media: _m, ...c }) => c);
  // Original media URLs stay in a server-only subdocument.
  const mediaById: Record<string, ImportedMedia[]> = Object.fromEntries(posts.map((p) => [p.externalPostId, p.media]));
  await db().doc(paths.importJob(input.workspaceId, id)).set({
    workspaceId: input.workspaceId,
    provider: channel.provider,
    channelId: channel.id,
    status: 'ready',
    range: { from: input.from, to: input.to },
    candidates,
    importedPostIds: [],
    error: null,
    createdBy: actor.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await db().doc(`importMedia/${input.workspaceId}__${id}`).set({ workspaceId: input.workspaceId, media: mediaById, createdAt: FieldValue.serverTimestamp() });
  await audit({ workspaceId: input.workspaceId, actor, action: 'import.fetched', entityType: 'import', entityId: id, metadata: { provider: channel.provider, count: candidates.length } });
  return { importJobId: id, candidates };
}

/** Streams an official-API media URL into Storage and registers a MediaAsset. */
async function copyRemoteMedia(workspaceId: string, m: ImportedMedia, actorUid: string, label: string): Promise<string | null> {
  if (!m.url) return null;
  const res = await fetch(m.url);
  if (!res.ok || !res.body) return null;
  const mime = (res.headers.get('content-type') ?? m.mimeType ?? '').split(';')[0]?.trim() ?? '';
  const ext = EXT[mime];
  if (!ext) return null;
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_UPLOAD_BYTES) return null;
  const mediaId = newId();
  const path = storagePathFor(workspaceId, mediaId, ext);
  const file = bucket().file(path);
  await pipeline(Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream), file.createWriteStream({ contentType: mime, resumable: false }));
  const [meta] = await file.getMetadata();
  const fileName = `${label}.${ext}`;
  await db().doc(paths.mediaAsset(workspaceId, mediaId)).set({
    workspaceId,
    kind: mime.startsWith('video/') ? 'video' : 'image',
    storagePath: path,
    thumbnailPath: null,
    fileName,
    searchName: fileName.toLowerCase(),
    mimeType: mime,
    size: Number(meta.size),
    width: null,
    height: null,
    durationSec: null,
    checksum: (meta.md5Hash as string | undefined) ?? null,
    tags: ['imported'],
    usedBy: [],
    status: 'ready',
    source: 'import',
    createdBy: actorUid,
    createdAt: FieldValue.serverTimestamp(),
    lastUsedAt: null,
  });
  return mediaId;
}

export interface ImportedDraft {
  externalPostId: string;
  postId: string;
  mediaReady: boolean;
  note: string | null;
}

/** Normalises selected candidates into draft posts (optionally targeting destination channels). */
export async function importPostsAsDrafts(
  registry: ProviderRegistry,
  input: { workspaceId: string; importJobId: string; externalPostIds: string[]; destinationChannelIds: string[]; timezone: string },
  actor: AuditActor,
  variantsFor: (mediaIds: string[]) => Promise<import('@shared/index').VariantInput[]>,
): Promise<ImportedDraft[]> {
  const jobRef = db().doc(paths.importJob(input.workspaceId, input.importJobId));
  const job = await jobRef.get();
  if (!job.exists) fail('not-found', 'Import not found');
  const candidates = (job.get('candidates') as ImportCandidate[]) ?? [];
  const mediaDoc = await db().doc(`importMedia/${input.workspaceId}__${input.importJobId}`).get();
  const mediaById = (mediaDoc.get('media') as Record<string, ImportedMedia[]>) ?? {};
  const provider = job.get('provider') as string;
  const channelId = job.get('channelId') as string;
  await jobRef.update({ status: 'importing', updatedAt: FieldValue.serverTimestamp() });

  const out: ImportedDraft[] = [];
  for (const externalPostId of input.externalPostIds) {
    const c = candidates.find((x) => x.externalPostId === externalPostId);
    if (!c) continue;
    const postId = `imp_${input.importJobId}_${externalPostId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
    if ((await db().doc(paths.post(input.workspaceId, postId)).get()).exists) {
      out.push({ externalPostId, postId, mediaReady: true, note: 'Already imported' });
      continue;
    }
    const mediaIds: string[] = [];
    let mediaReady = c.mediaRetrievable;
    if (c.mediaRetrievable) {
      for (const [i, m] of (mediaById[externalPostId] ?? []).entries()) {
        try {
          const id = await copyRemoteMedia(input.workspaceId, m, actor.uid ?? 'system', `${provider}-${externalPostId}-${i + 1}`);
          if (id) mediaIds.push(id);
          else mediaReady = false;
        } catch (e) {
          log.warn('Import media copy failed', { externalPostId, error: (e as Error).message });
          mediaReady = false;
        }
      }
    }
    const note = mediaReady ? null : (c.mediaNote ?? 'The original file must be uploaded manually.');
    const tags = [...c.text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1] as string);
    const text = c.text.replace(/(\s*#[\p{L}\p{N}_]+)+\s*$/u, '').trim();
    await createPost(
      registry,
      {
        workspaceId: input.workspaceId,
        titleInternal: `Import ${provider} ${c.publishedAt.slice(0, 10)}`,
        masterContent: { text, title: '', description: '', hashtags: tags, link: '' },
        mediaIds,
        internalNotes: [`Imported from ${provider}${c.permalink ? `: ${c.permalink}` : ''}`, note ? `⚠️ ${note}` : null].filter(Boolean).join('\n'),
        timezone: input.timezone,
        scheduledAt: null,
        variants: mediaReady && input.destinationChannelIds.length ? await variantsFor(mediaIds) : [],
      },
      actor,
      { postId, source: { kind: 'import', importJobId: input.importJobId, importedFrom: { provider, channelId, externalPostId, ...(c.permalink ? { permalink: c.permalink } : {}) } } },
    );
    out.push({ externalPostId, postId, mediaReady, note });
  }
  await jobRef.update({ status: 'completed', importedPostIds: FieldValue.arrayUnion(...out.map((o) => o.postId)), updatedAt: FieldValue.serverTimestamp() });
  await audit({ workspaceId: input.workspaceId, actor, action: 'import.imported', entityType: 'import', entityId: input.importJobId, metadata: { count: out.length, needsManualMedia: out.filter((o) => !o.mediaReady).length } });
  return out;
}

export type { ImportedPost };

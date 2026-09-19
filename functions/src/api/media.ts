import { onRequest } from 'firebase-functions/v2/https';
import { mediaRef, registerMediaSchema, updateMediaTagsSchema } from '@shared/index';
import { requirePermission } from '../auth/access';
import { callable } from './callable';
import { FieldValue, db, newId, paths } from '../utils/firestore';
import { fail } from '../utils/errors';
import { bucket, storagePathFor, verifyPullSignature } from '../services/media';
import { audit, userActor } from '../services/audit';
import { CORE_SECRETS, REGION } from '../config/env';

/** Hub-wide upload ceiling (providers have their own, usually lower, limits). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Called after the PWA finished a resumable upload to
 * workspaces/{w}/media/{mediaId}/original.{ext}. The server verifies the
 * object really exists and matches the declared type/size before creating
 * the MediaAsset (clients cannot write mediaAssets directly).
 */
export const registerMediaFn = callable(registerMediaSchema, async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'media.write');
  const path = storagePathFor(data.workspaceId, data.mediaId, data.extension);
  const file = bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) fail('failed-precondition', 'Upload not found. Upload the file first.');
  const [meta] = await file.getMetadata();
  const size = Number(meta.size);
  if (meta.contentType !== data.mimeType) fail('invalid-argument', 'Content type does not match the uploaded file');
  if (size !== data.size) fail('invalid-argument', 'Size does not match the uploaded file');
  if (size > MAX_UPLOAD_BYTES) {
    await file.delete().catch(() => undefined);
    fail('invalid-argument', 'File too large');
  }
  const thumbPath = `workspaces/${data.workspaceId}/media/${data.mediaId}/thumbnail.jpg`;
  const thumbnailPath = data.hasThumbnail && (await bucket().file(thumbPath).exists())[0] ? thumbPath : null;
  const ref = db().doc(paths.mediaAsset(data.workspaceId, data.mediaId));
  await ref.create({
    workspaceId: data.workspaceId,
    kind: data.mimeType.startsWith('video/') ? 'video' : 'image',
    storagePath: path,
    thumbnailPath,
    fileName: data.fileName,
    mimeType: data.mimeType,
    size,
    width: data.width,
    height: data.height,
    durationSec: data.durationSec,
    checksum: data.checksum ?? (meta.md5Hash as string | undefined) ?? null,
    tags: data.tags,
    usedBy: [],
    status: 'ready',
    source: 'upload',
    createdBy: actor.uid,
    createdAt: FieldValue.serverTimestamp(),
    lastUsedAt: null,
    searchName: data.fileName.toLowerCase(),
  }).catch((e: { code?: number }) => {
    if (e.code === 6) fail('already-exists', 'Media already registered');
    throw e;
  });
  await audit({ workspaceId: data.workspaceId, actor: userActor(actor.uid, actor.email), action: 'media.uploaded', entityType: 'media', entityId: data.mediaId, metadata: { fileName: data.fileName, size } });
  return { mediaId: data.mediaId };
});

export const deleteMediaFn = callable(mediaRef, async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'media.write');
  const ref = db().doc(paths.mediaAsset(data.workspaceId, data.mediaId));
  const snap = await ref.get();
  if (!snap.exists) fail('not-found', 'Media not found');
  const usedBy = (snap.get('usedBy') as string[]) ?? [];
  if (usedBy.length > 0) fail('failed-precondition', 'This file is used by posts. Remove it from those posts first.', { usedBy });
  await bucket().deleteFiles({ prefix: `workspaces/${data.workspaceId}/media/${data.mediaId}/` }).catch(() => undefined);
  await ref.delete();
  await audit({ workspaceId: data.workspaceId, actor: userActor(actor.uid, actor.email), action: 'media.deleted', entityType: 'media', entityId: data.mediaId, metadata: { fileName: snap.get('fileName') } });
  return { ok: true };
});

export const copyMediaFn = callable(mediaRef, async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'media.write');
  const snap = await db().doc(paths.mediaAsset(data.workspaceId, data.mediaId)).get();
  if (!snap.exists) fail('not-found', 'Media not found');
  const src = snap.data() as Record<string, unknown> & { storagePath: string; thumbnailPath: string | null; fileName: string };
  const id = newId();
  const ext = src.storagePath.split('.').pop() ?? 'bin';
  const dest = storagePathFor(data.workspaceId, id, ext);
  await bucket().file(src.storagePath).copy(bucket().file(dest));
  let thumbnailPath: string | null = null;
  if (src.thumbnailPath) {
    thumbnailPath = `workspaces/${data.workspaceId}/media/${id}/thumbnail.jpg`;
    await bucket().file(src.thumbnailPath).copy(bucket().file(thumbnailPath));
  }
  const fileName = src.fileName.replace(/(\.[^.]+)?$/, ' (copy)$1');
  await db().doc(paths.mediaAsset(data.workspaceId, id)).set({
    ...src,
    storagePath: dest,
    thumbnailPath,
    fileName,
    searchName: fileName.toLowerCase(),
    usedBy: [],
    source: 'copy',
    createdBy: actor.uid,
    createdAt: FieldValue.serverTimestamp(),
    lastUsedAt: null,
  });
  return { mediaId: id };
});

export const updateMediaTagsFn = callable(updateMediaTagsSchema, async (data, req) => {
  await requirePermission(req, data.workspaceId, 'media.write');
  await db().doc(paths.mediaAsset(data.workspaceId, data.mediaId)).update({ tags: [...new Set(data.tags.map((t) => t.toLowerCase()))] });
  return { ok: true };
});

/**
 * GET /media-pull/{workspaceId}/{mediaId}?exp&sig — serves a media file to
 * platforms that pull from a verified domain (TikTok PULL_FROM_URL).
 * Access requires an HMAC signature that expires; streams from Storage.
 */
export const mediaPull = onRequest({ region: REGION, secrets: CORE_SECRETS, timeoutSeconds: 3600, memory: '512MiB' }, async (req, res) => {
  const m = /\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/.exec(req.path);
  const exp = String(req.query.exp ?? '');
  const sig = String(req.query.sig ?? '');
  if (!m || !verifyPullSignature(m[1] as string, m[2] as string, exp, sig)) {
    res.status(403).send('Forbidden');
    return;
  }
  const snap = await db().doc(paths.mediaAsset(m[1] as string, m[2] as string)).get();
  if (!snap.exists) {
    res.status(404).send('Not found');
    return;
  }
  res.set('Content-Type', snap.get('mimeType') as string);
  res.set('Content-Length', String(snap.get('size')));
  res.set('Cache-Control', 'private, no-store');
  bucket()
    .file(snap.get('storagePath') as string)
    .createReadStream()
    .on('error', () => res.destroy())
    .pipe(res);
});

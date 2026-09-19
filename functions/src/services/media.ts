import { createHmac, timingSafeEqual } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import type { MediaAsset } from '@shared/index';
import type { ResolvedMedia } from '../providers/types';
import { APP_SIGNING_KEY, config, isEmulator, secretValue } from '../config/env';
import { db, paths } from '../utils/firestore';
import { ProviderError } from '../providers/errors';

export function bucket() {
  const name = config.mediaBucket();
  return name ? getStorage().bucket(name) : getStorage().bucket();
}

export function storagePathFor(workspaceId: string, mediaId: string, ext: string): string {
  return `workspaces/${workspaceId}/media/${mediaId}/original.${ext}`;
}

function signingKey(): string {
  const k = secretValue(APP_SIGNING_KEY);
  if (k) return k;
  if (isEmulator()) return 'crepelite-dev-signing-key';
  throw new Error('APP_SIGNING_KEY is not configured');
}

/** HMAC-signed, expiring URL served by the `mediaPull` function (for providers requiring a verified domain). */
export function signPullUrl(workspaceId: string, mediaId: string, ttlSec = 2 * 3600): string {
  const base = config.mediaPullBaseUrl();
  if (!base) throw ProviderError.config('MEDIA_PULL_BASE_URL is not configured (required for pull-from-URL publishing on verified domains).');
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = createHmac('sha256', signingKey()).update(`${workspaceId}/${mediaId}/${exp}`).digest('base64url');
  return `${base.replace(/\/$/, '')}/${workspaceId}/${mediaId}?exp=${exp}&sig=${sig}`;
}

export function verifyPullSignature(workspaceId: string, mediaId: string, exp: string, sig: string): boolean {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now() / 1000) return false;
  const expected = createHmac('sha256', signingKey()).update(`${workspaceId}/${mediaId}/${expNum}`).digest();
  const given = Buffer.from(sig, 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function resolveMedia(asset: MediaAsset): ResolvedMedia {
  const file = bucket().file(asset.storagePath);
  return {
    asset,
    async getPublicUrl(opts) {
      if (opts?.verifiedDomain) return signPullUrl(asset.workspaceId, asset.id);
      const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 2 * 3600 * 1000 });
      return url;
    },
    async getThumbnailUrl() {
      if (!asset.thumbnailPath) return null;
      const [url] = await bucket().file(asset.thumbnailPath).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 2 * 3600 * 1000 });
      return url;
    },
    openStream(range) {
      return file.createReadStream(range ? { start: range.start, end: range.end } : undefined);
    },
  };
}

export async function loadMediaAssets(workspaceId: string, ids: string[]): Promise<MediaAsset[]> {
  if (ids.length === 0) return [];
  const refs = ids.map((id) => db().doc(paths.mediaAsset(workspaceId, id)));
  const snaps = await db().getAll(...refs);
  const out: MediaAsset[] = [];
  for (const s of snaps) {
    if (!s.exists) throw ProviderError.validation(`Media ${s.id} no longer exists`, 'media_missing');
    const a = { id: s.id, ...s.data() } as MediaAsset;
    if (a.status !== 'ready') throw ProviderError.validation(`Media ${a.fileName} is not ready`, 'media_not_ready');
    out.push(a);
  }
  return out;
}

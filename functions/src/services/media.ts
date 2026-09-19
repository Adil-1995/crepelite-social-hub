import { createHmac, timingSafeEqual } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import type { MediaAsset } from '@shared/index';
import type { ResolvedMedia } from '../providers/types';
import { APP_SIGNING_KEY, config, isEmulator, secretValue } from '../config/env';
import { db, paths } from '../utils/firestore';
import { ProviderError } from '../providers/errors';
import { log } from '../utils/logger';

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

/**
 * A V4 signed URL needs a private key. The Cloud Functions runtime has none,
 * so the SDK signs through the IAM `signBlob` API — which fails unless the
 * runtime service account may impersonate itself. That grant is easy to miss,
 * and when it is missing every publish dies with an IAM error that says
 * nothing about media.
 *
 * `signPullUrl` is the escape hatch: an HMAC-signed, expiring URL served by
 * our own `mediaPull` function, with no IAM involvement at all.
 */
function isSigningUnavailable(e: unknown): boolean {
  const msg = (e as Error)?.message ?? '';
  return /signBlob|iam.serviceAccounts|Permission.*denied|could not (be )?sign/i.test(msg);
}

export function resolveMedia(asset: MediaAsset): ResolvedMedia {
  const file = bucket().file(asset.storagePath);
  const expires = () => Date.now() + 2 * 3600 * 1000;

  return {
    asset,
    async getPublicUrl(opts) {
      // Providers that require a verified domain must use our own domain.
      if (opts?.verifiedDomain) return signPullUrl(asset.workspaceId, asset.id);
      try {
        const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: expires() });
        return url;
      } catch (e) {
        if (!isSigningUnavailable(e)) throw e;
        // Serving through mediaPull costs a function invocation per fetch, so
        // this is the fallback rather than the default. Grant the runtime
        // service account roles/iam.serviceAccountTokenCreator to restore the
        // cheaper direct path — see docs/deployment.md.
        log.warn('signed URL unavailable, serving media through mediaPull', {
          mediaId: asset.id,
          reason: (e as Error).message,
        });
        return signPullUrl(asset.workspaceId, asset.id);
      }
    },
    async getThumbnailUrl() {
      if (!asset.thumbnailPath) return null;
      try {
        const [url] = await bucket().file(asset.thumbnailPath).getSignedUrl({ version: 'v4', action: 'read', expires: expires() });
        return url;
      } catch (e) {
        if (!isSigningUnavailable(e)) throw e;
        // Thumbnails are decorative; losing one must not fail a publish.
        log.warn('thumbnail URL unavailable', { mediaId: asset.id, reason: (e as Error).message });
        return null;
      }
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

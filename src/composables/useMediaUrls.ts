import { shallowRef, triggerRef } from 'vue';
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import { storage } from '@/app/firebase';
import type { MediaAsset } from '@shared/index';

/**
 * Lazily resolves Storage download URLs, cached for the session.
 *
 * Workspace members can read their own media directly (see storage.rules), so
 * previews never travel through a Function. Each path is resolved at most once;
 * failures are cached as `null` so a missing object is not retried on every
 * render.
 */
const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

export function useMediaUrls() {
  const version = shallowRef(0);

  async function resolve(path: string | null | undefined): Promise<string | null> {
    if (!path) return null;
    if (cache.has(path)) return cache.get(path) ?? null;

    const existing = pending.get(path);
    if (existing) return existing;

    const task = getDownloadURL(storageRef(storage, path))
      .then((url) => {
        cache.set(path, url);
        return url;
      })
      .catch(() => {
        cache.set(path, null);
        return null;
      })
      .finally(() => {
        pending.delete(path);
        version.value++;
        triggerRef(version);
      });

    pending.set(path, task);
    return task;
  }

  /**
   * Synchronous accessor for templates: returns the cached URL and kicks off
   * resolution on first miss. Reading `version` keeps callers reactive.
   */
  function urlFor(path: string | null | undefined): string | null {
    void version.value;
    if (!path) return null;
    if (!cache.has(path) && !pending.has(path)) void resolve(path);
    return cache.get(path) ?? null;
  }

  /** Poster if the asset has one, otherwise the original (images only). */
  function previewUrl(asset: Pick<MediaAsset, 'kind' | 'storagePath' | 'thumbnailPath'>): string | null {
    if (asset.thumbnailPath) return urlFor(asset.thumbnailPath);
    return asset.kind === 'image' ? urlFor(asset.storagePath) : null;
  }

  return { urlFor, previewUrl, resolve };
}

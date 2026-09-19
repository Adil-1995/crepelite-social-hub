import { reactive, ref } from 'vue';
import { ref as storageRef, uploadBytesResumable, type UploadTask } from 'firebase/storage';
import { storage } from '@/app/firebase';
import { api } from '@/services/api';

/**
 * Resumable media uploads.
 *
 * Deliberately not PrimeVue `FileUpload`'s uploader: originals can be up to
 * 4 GB and must survive a flaky mobile connection, so the Firebase resumable
 * protocol does the transfer (progress, pause, cancel, resume) and PrimeVue
 * provides the surrounding UI. Reliability beats component purity.
 *
 * Sequence per file: probe dimensions → upload original → upload poster →
 * `registerMedia` (the server re-checks size and content type against the
 * stored object before creating the MediaAsset).
 */

export type UploadState = 'probing' | 'uploading' | 'registering' | 'done' | 'error' | 'cancelled';

export interface UploadItem {
  id: string;
  file: File;
  name: string;
  kind: 'image' | 'video';
  progress: number;
  state: UploadState;
  error: string | null;
  mediaId: string | null;
  previewUrl: string | null;
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** Matches the `^[A-Za-z0-9_-]{8,64}$` id shape the Storage rules enforce. */
function newMediaId(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

function extensionOf(file: File): string {
  const fromName = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (/^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  const fromType = file.type.split('/')[1]?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  return /^[a-z0-9]{1,8}$/.test(fromType) ? fromType : 'bin';
}

interface Probe {
  width: number | null;
  height: number | null;
  durationSec: number | null;
  poster: Blob | null;
  previewUrl: string | null;
}

/** Reads intrinsic dimensions and grabs a poster frame, entirely in the browser. */
async function probe(file: File): Promise<Probe> {
  const url = URL.createObjectURL(file);
  const empty: Probe = { width: null, height: null, durationSec: null, poster: null, previewUrl: url };

  if (file.type.startsWith('image/')) {
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { ...empty, width: img.naturalWidth || null, height: img.naturalHeight || null };
    } catch {
      return empty;
    }
  }

  if (file.type.startsWith('video/')) {
    return await new Promise<Probe>((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      const fail = () => resolve(empty);
      video.onerror = fail;
      video.onloadedmetadata = () => {
        const base: Probe = {
          ...empty,
          width: video.videoWidth || null,
          height: video.videoHeight || null,
          durationSec: Number.isFinite(video.duration) ? video.duration : null,
        };
        // Seek a little in: frame 0 is often black.
        video.onseeked = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = Math.min(video.videoWidth || 640, 640);
            canvas.height = Math.round((canvas.width / (video.videoWidth || 640)) * (video.videoHeight || 360));
            const ctx = canvas.getContext('2d');
            if (!ctx) return resolve(base);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((blob) => resolve({ ...base, poster: blob }), 'image/jpeg', 0.8);
          } catch {
            resolve(base);
          }
        };
        try {
          video.currentTime = Math.min(1, (video.duration || 1) / 2);
        } catch {
          resolve(base);
        }
      };
      video.src = url;
    });
  }

  return empty;
}

export function useMediaUpload(workspaceId: () => string | null) {
  const items = reactive<UploadItem[]>([]);
  const tasks = new Map<string, UploadTask>();
  const uploading = ref(false);

  function kindOf(file: File): 'image' | 'video' | null {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    return null;
  }

  async function uploadOne(item: UploadItem): Promise<string | null> {
    const ws = workspaceId();
    if (!ws) return null;

    const mediaId = newMediaId();
    const ext = extensionOf(item.file);

    item.state = 'probing';
    const info = await probe(item.file);
    item.previewUrl = info.previewUrl;

    item.state = 'uploading';
    const originalRef = storageRef(storage, `workspaces/${ws}/media/${mediaId}/original.${ext}`);
    const task = uploadBytesResumable(originalRef, item.file, { contentType: item.file.type });
    tasks.set(item.id, task);

    try {
      await new Promise<void>((resolve, reject) => {
        task.on(
          'state_changed',
          (snap) => {
            item.progress = snap.totalBytes ? Math.round((snap.bytesTransferred / snap.totalBytes) * 100) : 0;
          },
          reject,
          resolve,
        );
      });
    } catch (e) {
      const code = (e as { code?: string })?.code ?? '';
      if (code === 'storage/canceled') {
        item.state = 'cancelled';
      } else {
        item.state = 'error';
        item.error = code === 'storage/unauthorized' ? 'You do not have permission to upload here.' : 'Upload failed.';
      }
      tasks.delete(item.id);
      return null;
    }
    tasks.delete(item.id);

    // Poster frame is best-effort: a failure must not lose the original.
    let hasThumbnail = false;
    if (info.poster) {
      try {
        const thumbRef = storageRef(storage, `workspaces/${ws}/media/${mediaId}/thumbnail.jpg`);
        await uploadBytesResumable(thumbRef, info.poster, { contentType: 'image/jpeg' });
        hasThumbnail = true;
      } catch {
        hasThumbnail = false;
      }
    }

    item.state = 'registering';
    try {
      await api.registerMedia({
        workspaceId: ws,
        mediaId,
        fileName: item.file.name.slice(0, 300),
        mimeType: item.file.type,
        size: item.file.size,
        width: info.width,
        height: info.height,
        durationSec: info.durationSec,
        checksum: null,
        extension: ext,
        hasThumbnail,
        tags: [],
      });
      item.mediaId = mediaId;
      item.progress = 100;
      item.state = 'done';
      return mediaId;
    } catch (e) {
      item.state = 'error';
      item.error = (e as Error).message || 'Could not register the upload.';
      return null;
    }
  }

  /** Uploads sequentially: parallel large uploads starve a mobile connection. */
  async function add(files: File[]): Promise<string[]> {
    const accepted: UploadItem[] = [];
    for (const file of files) {
      const kind = kindOf(file);
      if (!kind) continue;
      const item: UploadItem = {
        id: newMediaId(),
        file,
        name: file.name,
        kind,
        progress: 0,
        state: 'probing',
        error: null,
        mediaId: null,
        previewUrl: null,
      };
      items.push(item);
      accepted.push(item);
    }

    uploading.value = true;
    const ids: string[] = [];
    try {
      for (const item of accepted) {
        const id = await uploadOne(item);
        if (id) ids.push(id);
      }
    } finally {
      uploading.value = false;
    }
    return ids;
  }

  function cancel(itemId: string) {
    tasks.get(itemId)?.cancel();
  }

  function dismiss(itemId: string) {
    const i = items.findIndex((x) => x.id === itemId);
    if (i >= 0) {
      const [removed] = items.splice(i, 1);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    }
  }

  function clearFinished() {
    for (const item of [...items]) {
      if (item.state === 'done' || item.state === 'cancelled') dismiss(item.id);
    }
  }

  return { items, uploading, add, cancel, dismiss, clearFinished };
}

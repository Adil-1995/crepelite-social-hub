import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import { storage } from '@/app/firebase';
import type { MediaAsset } from '@shared/index';

/**
 * Pulls a few representative frames out of a video, in the browser.
 *
 * Cloud Functions have no ffmpeg, and shipping a whole video somewhere to read
 * three frames would be slow and expensive. The browser already has a decoder,
 * so the frames are grabbed here, downscaled, and sent as small JPEGs.
 *
 * Three frames — near the start, the middle and near the end — is enough to
 * tell preparation from a finished plate from a shot of the room, which is the
 * distinction the caption depends on.
 */
const MAX_EDGE = 512;
const QUALITY = 0.72;

function capture(video: HTMLVideoElement): string | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;

  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  try {
    return canvas.toDataURL('image/jpeg', QUALITY);
  } catch {
    // A cross-origin frame taints the canvas; better no frame than a throw.
    return null;
  }
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done, { once: true });
    try {
      video.currentTime = time;
    } catch {
      done();
    }
    // Never hang the generator on a video that refuses to seek.
    setTimeout(done, 3000);
  });
}

export async function extractFrames(asset: MediaAsset, count = 3): Promise<string[]> {
  if (asset.kind !== 'video') return [];

  let url: string;
  try {
    url = await getDownloadURL(storageRef(storage, asset.storagePath));
  } catch {
    return [];
  }

  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  const ready = await new Promise<boolean>((resolve) => {
    video.onloadeddata = () => resolve(true);
    video.onerror = () => resolve(false);
    setTimeout(() => resolve(false), 15000);
  });
  if (!ready) return [];

  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const points = duration
    ? Array.from({ length: count }, (_, i) => Math.min(duration - 0.1, (duration * (i + 0.5)) / count))
    : [0];

  const frames: string[] = [];
  for (const t of points) {
    await seek(video, t);
    const frame = capture(video);
    if (frame) frames.push(frame);
  }

  video.removeAttribute('src');
  video.load();
  return frames;
}

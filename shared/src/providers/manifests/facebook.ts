import type { ProviderManifest } from '../manifest';
import { GB, MB, defaultFromMaster } from '../helpers';

/**
 * Facebook Pages via the Meta Graph API. Sources (checked 2026-09):
 * - https://developers.facebook.com/docs/pages-api/posts
 * - https://developers.facebook.com/docs/video-api/guides/reels-publishing
 * See docs/providers/facebook.md.
 */
export const facebookManifest: ProviderManifest = {
  id: 'facebook',
  displayName: 'Facebook',
  authFamily: 'meta',
  brandColor: '#1877F2',
  iconPath: 'M14 8h3V4h-3c-2.8 0-5 2.2-5 5v2H7v4h2v9h4v-9h3l1-4h-4V9c0-.6.4-1 1-1z',
  channelKinds: [{ id: 'facebook_page', label: 'Facebook Page' }],
  apiVersion: 'v26.0',
  docs: 'docs/providers/facebook.md',
  capabilities: {
    supports: { text: true, image: true, video: true, carousel: true, shortVideo: true, story: false },
    fields: {
      text: { supported: true, maxLength: 63206, label: 'Post text' },
      title: { supported: false },
      description: { supported: false },
      hashtags: { supported: true, appendToText: true },
      link: { supported: true, maxLength: 2048 },
    },
    formats: [
      {
        id: 'post',
        label: 'Post',
        description: 'Text, link or up to 10 photos',
        media: { min: 0, max: 10, images: true, videos: false, mixed: false },
        preview: 'feed',
      },
      {
        id: 'video',
        label: 'Video',
        media: { min: 1, max: 1, images: false, videos: true, mixed: false },
        preview: 'video',
      },
      {
        id: 'reel',
        label: 'Reel',
        description: '9:16 video, 3–90 s',
        media: { min: 1, max: 1, images: false, videos: true, mixed: false },
        constraints: {
          video: { mimeTypes: ['video/mp4', 'video/quicktime'], maxBytes: 1 * GB, minDurationSec: 3, maxDurationSec: 90, minWidth: 540, minAspectRatio: 0.5, maxAspectRatio: 0.6 },
        },
        preview: 'vertical',
      },
    ],
    media: {
      image: { mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff'], maxBytes: 10 * MB },
      video: { mimeTypes: ['video/mp4', 'video/quicktime'], maxBytes: 4 * GB, minDurationSec: 1 },
    },
    canReadPosts: true,
    canCreatePost: true,
    canUpdatePost: true,
    canDeletePost: true,
    canScheduleNative: true,
    canFetchStatus: true,
    // "An app can only update a Page post if the post was made using that app." Text only.
    canEditPublishedPost: true,
    editableAfterPublish: ['text'],
    importMediaRetrievable: true,
    asyncProcessing: true,
    webhooks: false,
  },
  settingsFields: [],
  rateLimit: { maxConcurrent: 2, strategy: 'headers', publishQuota: 'Reels: 30 API-published per Page per 24 h' },
  fromMaster: defaultFromMaster,
  validate: ({ format, content, media }) => {
    if (format === 'post' && media.length === 0 && !content.text.trim() && !content.link.trim()) {
      return [{ field: 'content.text', code: 'required', message: 'A Facebook post needs text, a link or at least one photo.', severity: 'error' }];
    }
    if (format === 'post' && media.length > 0 && content.link.trim()) {
      return [{ field: 'content.link', code: 'link_with_photos', message: 'Links with photos are published as plain text in the caption (no link preview).', severity: 'warning' }];
    }
    return [];
  },
};

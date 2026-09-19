import type { ProviderManifest, ValidationIssue } from '../manifest';
import { MB, defaultFromMaster } from '../helpers';

/**
 * Instagram professional accounts (Business/Creator) via the Instagram
 * Content Publishing API. Sources (checked 2026-09):
 * - https://developers.facebook.com/docs/instagram-platform/content-publishing
 * - https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
 */
const IG_IMAGE = { mimeTypes: ['image/jpeg'], maxBytes: 8 * MB, minWidth: 320, maxWidth: 1440, minAspectRatio: 0.8, maxAspectRatio: 1.91 };
const IG_REEL_VIDEO = { mimeTypes: ['video/mp4', 'video/quicktime'], maxBytes: 300 * MB, minDurationSec: 3, maxDurationSec: 15 * 60, minAspectRatio: 0.01, maxAspectRatio: 10 };

export const instagramManifest: ProviderManifest = {
  id: 'instagram',
  displayName: 'Instagram',
  authFamily: 'meta',
  brandColor: '#E4405F',
  iconPath: 'M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4zm5 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm5.5-2a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  channelKinds: [{ id: 'instagram_professional', label: 'Instagram professional account' }],
  apiVersion: 'v26.0',
  docs: 'docs/providers/instagram.md',
  capabilities: {
    supports: { text: false, image: true, video: true, carousel: true, shortVideo: true, story: true },
    fields: {
      text: { supported: true, maxLength: 2200, label: 'Caption' },
      title: { supported: false },
      description: { supported: false },
      hashtags: { supported: true, max: 30, appendToText: true },
      // Links in captions are not clickable on Instagram.
      link: { supported: false },
    },
    formats: [
      { id: 'feed', label: 'Feed image', media: { min: 1, max: 1, images: true, videos: false, mixed: false }, preview: 'feed' },
      {
        id: 'carousel',
        label: 'Carousel',
        description: '2–10 images/videos, cropped to the first item ratio',
        media: { min: 2, max: 10, images: true, videos: true, mixed: true },
        preview: 'feed',
      },
      { id: 'reel', label: 'Reel', description: '3 s – 15 min, 9:16 recommended', media: { min: 1, max: 1, images: false, videos: true, mixed: false }, preview: 'vertical' },
      {
        id: 'story',
        label: 'Story',
        description: 'Image or video (3–60 s)',
        media: { min: 1, max: 1, images: true, videos: true, mixed: false },
        constraints: {
          image: { mimeTypes: ['image/jpeg'], maxBytes: 8 * MB },
          video: { mimeTypes: ['video/mp4', 'video/quicktime'], maxBytes: 100 * MB, minDurationSec: 3, maxDurationSec: 60, minAspectRatio: 0.1, maxAspectRatio: 10 },
        },
        preview: 'story',
      },
    ],
    media: { image: IG_IMAGE, video: IG_REEL_VIDEO },
    canReadPosts: true,
    canCreatePost: true,
    canUpdatePost: false,
    canDeletePost: false,
    canScheduleNative: false,
    canFetchStatus: true,
    // The API does not allow editing the caption/media of published media.
    canEditPublishedPost: false,
    editableAfterPublish: [],
    importMediaRetrievable: true,
    asyncProcessing: true,
    webhooks: false,
  },
  settingsFields: [
    { key: 'shareToFeed', label: 'Also show the Reel in the Feed', type: 'switch', formats: ['reel'], defaultValue: true },
    { key: 'altText', label: 'Alt text', type: 'textarea', formats: ['feed'], maxLength: 1000, help: 'Describes the image for people using screen readers.' },
  ],
  rateLimit: { maxConcurrent: 1, strategy: 'headers', publishQuota: '100 API-published posts per account per rolling 24 h (carousel = 1)' },
  fromMaster: defaultFromMaster,
  validate: ({ content, channelMetadata }) => {
    const issues: ValidationIssue[] = [];
    const mentions = (content.text.match(/(^|\s)@[\w.]+/g) ?? []).length;
    if (mentions > 20) issues.push({ field: 'content.text', code: 'too_many_mentions', message: `Instagram allows 20 @mentions per caption (${mentions} found).`, severity: 'error' });
    if (channelMetadata && channelMetadata.accountType === 'PERSONAL') {
      issues.push({ field: 'channel', code: 'account_type', message: 'Instagram publishing requires a Business or Creator account.', severity: 'error' });
    }
    return issues;
  },
};

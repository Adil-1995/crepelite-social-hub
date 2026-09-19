import type { ProviderManifest, ValidationIssue } from '../manifest';
import { GB, MB, defaultFromMaster } from '../helpers';

/**
 * TikTok Content Posting API (Direct Post). Sources (checked 2026-09):
 * - https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 * - https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
 * - https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 * - https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
 */
export const TIKTOK_PRIVACY_LEVELS = [
  { value: 'PUBLIC_TO_EVERYONE', label: 'Everyone' },
  { value: 'MUTUAL_FOLLOW_FRIENDS', label: 'Friends' },
  { value: 'FOLLOWER_OF_CREATOR', label: 'Followers' },
  { value: 'SELF_ONLY', label: 'Only me' },
];

export const tiktokManifest: ProviderManifest = {
  id: 'tiktok',
  displayName: 'TikTok',
  authFamily: 'tiktok',
  brandColor: '#111111',
  iconPath: 'M16 3c.4 2.4 2 4 4.5 4.3v3.3c-1.6 0-3.1-.5-4.5-1.3v6.4A6.3 6.3 0 1 1 9.7 9.4v3.4a3 3 0 1 0 3 3V3H16z',
  channelKinds: [{ id: 'tiktok_account', label: 'TikTok account' }],
  apiVersion: 'v2',
  docs: 'docs/providers/tiktok.md',
  capabilities: {
    supports: { text: false, image: true, video: true, carousel: true, shortVideo: true, story: false },
    fields: {
      text: { supported: true, maxLength: 2200, label: 'Caption' },
      title: { supported: true, maxLength: 90, label: 'Photo post title' },
      description: { supported: false },
      hashtags: { supported: true, appendToText: true },
      link: { supported: false },
    },
    formats: [
      { id: 'video', label: 'Video', media: { min: 1, max: 1, images: false, videos: true, mixed: false }, preview: 'vertical' },
      { id: 'photo', label: 'Photo post', description: '1–35 images', media: { min: 1, max: 35, images: true, videos: false, mixed: false }, preview: 'vertical' },
    ],
    media: {
      image: { mimeTypes: ['image/jpeg', 'image/webp'], maxBytes: 20 * MB, maxWidth: 1920 },
      video: { mimeTypes: ['video/mp4', 'video/webm', 'video/quicktime'], maxBytes: 4 * GB, minDurationSec: 1, maxDurationSec: 600, minWidth: 360 },
    },
    canReadPosts: true,
    canCreatePost: true,
    canUpdatePost: false,
    canDeletePost: false,
    canScheduleNative: false,
    canFetchStatus: true,
    canEditPublishedPost: false,
    editableAfterPublish: [],
    // The Display API returns metadata and cover images only, never the original video file.
    importMediaRetrievable: false,
    asyncProcessing: true,
    webhooks: true,
  },
  settingsFields: [
    {
      key: 'privacyLevel',
      label: 'Who can view',
      type: 'select',
      required: true,
      options: TIKTOK_PRIVACY_LEVELS,
      optionsFromChannel: 'privacyLevelOptions',
      help: 'TikTok requires you to choose this explicitly for every post.',
    },
    { key: 'disableComment', label: 'Turn off comments', type: 'switch', defaultValue: false },
    { key: 'disableDuet', label: 'Turn off Duet', type: 'switch', formats: ['video'], defaultValue: false },
    { key: 'disableStitch', label: 'Turn off Stitch', type: 'switch', formats: ['video'], defaultValue: false },
    { key: 'autoAddMusic', label: 'Add recommended music', type: 'switch', formats: ['photo'], defaultValue: false },
    { key: 'brandOrganic', label: 'Promotes your own business', type: 'switch', defaultValue: false },
    { key: 'brandedContent', label: 'Paid partnership (branded content)', type: 'switch', defaultValue: false },
    { key: 'isAigc', label: 'AI-generated content', type: 'switch', defaultValue: false },
  ],
  rateLimit: { maxConcurrent: 1, strategy: 'fixed', publishQuota: 'Init endpoints: 6 requests/min per user token; creator daily cap reported by creator_info' },
  fromMaster: defaultFromMaster,
  validate: ({ settings, channelMetadata, media, format }) => {
    const issues: ValidationIssue[] = [];
    const privacy = settings.privacyLevel as string | undefined;
    const allowed = channelMetadata?.privacyLevelOptions as Array<{ value: string }> | undefined;
    if (privacy && allowed && allowed.length > 0 && !allowed.some((o) => o.value === privacy)) {
      issues.push({ field: 'settings.privacyLevel', code: 'privacy_option_mismatch', message: 'This privacy option is not available for this TikTok account.', severity: 'error' });
    }
    if (channelMetadata && channelMetadata.appAudited === false && privacy && privacy !== 'SELF_ONLY') {
      issues.push({
        field: 'settings.privacyLevel',
        code: 'provider_not_approved',
        message: 'Provider not approved for public publishing: until TikTok audits this app, posts can only be published as "Only me".',
        severity: 'error',
      });
    }
    if (settings.brandedContent === true && privacy === 'SELF_ONLY') {
      issues.push({ field: 'settings.brandedContent', code: 'branded_private', message: 'Branded content cannot be private on TikTok.', severity: 'error' });
    }
    const maxDuration = channelMetadata?.maxVideoPostDurationSec as number | undefined;
    if (format === 'video' && maxDuration) {
      for (const m of media) {
        if (m.durationSec && m.durationSec > maxDuration) {
          issues.push({ field: 'media', code: 'video_too_long', message: `This TikTok account can post videos up to ${maxDuration}s.`, severity: 'error' });
        }
      }
    }
    if (format === 'photo' && channelMetadata && channelMetadata.photoPullDomainVerified === false) {
      issues.push({
        field: 'media',
        code: 'domain_not_verified',
        message: 'TikTok photo posts pull images from a verified domain. Verify the media domain in the TikTok developer portal first.',
        severity: 'error',
      });
    }
    return issues;
  },
};

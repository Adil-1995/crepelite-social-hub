import type { MasterContent } from '../../domain/types';
import type { ProviderManifest, ValidationIssue } from '../manifest';
import { GB, titledFromMaster } from '../helpers';

/**
 * YouTube Data API v3. Sources (checked 2026-09):
 * - https://developers.google.com/youtube/v3/docs/videos/insert
 * - https://developers.google.com/youtube/v3/determine_quota_cost
 * - https://developers.google.com/youtube/v3/docs/videos#resource (snippet/status limits)
 */
export const YOUTUBE_CATEGORIES = [
  { value: '22', label: 'People & Blogs' },
  { value: '26', label: 'Howto & Style' },
  { value: '24', label: 'Entertainment' },
  { value: '19', label: 'Travel & Events' },
  { value: '1', label: 'Film & Animation' },
  { value: '10', label: 'Music' },
  { value: '17', label: 'Sports' },
  { value: '27', label: 'Education' },
  { value: '28', label: 'Science & Technology' },
  { value: '23', label: 'Comedy' },
  { value: '25', label: 'News & Politics' },
];

export const youtubeManifest: ProviderManifest = {
  id: 'youtube',
  displayName: 'YouTube',
  authFamily: 'google',
  brandColor: '#FF0000',
  iconPath: 'M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8zM10 15V9l5.2 3L10 15z',
  channelKinds: [{ id: 'youtube_channel', label: 'YouTube channel' }],
  apiVersion: 'v3',
  docs: 'docs/providers/youtube.md',
  capabilities: {
    supports: { text: false, image: false, video: true, carousel: false, shortVideo: true, story: false },
    fields: {
      text: { supported: false },
      title: { supported: true, required: true, maxLength: 100, label: 'Video title' },
      description: { supported: true, maxLength: 5000, lengthUnit: 'bytes', label: 'Video description' },
      hashtags: { supported: false },
      link: { supported: false },
    },
    formats: [
      { id: 'video', label: 'Video', media: { min: 1, max: 1, images: false, videos: true, mixed: false }, preview: 'video' },
      {
        id: 'short',
        label: 'Short',
        description: 'Square or vertical, up to 3 minutes. YouTube classifies Shorts automatically.',
        media: { min: 1, max: 1, images: false, videos: true, mixed: false },
        constraints: {
          video: { mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'], maxBytes: 256 * GB, maxDurationSec: 180, maxAspectRatio: 1 },
        },
        preview: 'vertical',
      },
    ],
    media: {
      video: {
        mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo', 'video/x-matroska', 'video/mpeg', 'video/3gpp'],
        maxBytes: 256 * GB,
        minDurationSec: 1,
      },
    },
    canReadPosts: true,
    canCreatePost: true,
    canUpdatePost: true,
    canDeletePost: true,
    canScheduleNative: true,
    canFetchStatus: true,
    canEditPublishedPost: true,
    editableAfterPublish: ['title', 'description', 'tags', 'privacyStatus', 'categoryId'],
    // The Data API never returns the original video file.
    importMediaRetrievable: false,
    asyncProcessing: true,
    webhooks: false,
  },
  settingsFields: [
    {
      key: 'privacyStatus',
      label: 'Visibility',
      type: 'select',
      required: true,
      defaultValue: 'private',
      options: [
        { value: 'public', label: 'Public' },
        { value: 'unlisted', label: 'Unlisted' },
        { value: 'private', label: 'Private' },
      ],
      help: 'Uploads from unverified Google API projects are forced to private by YouTube.',
    },
    { key: 'madeForKids', label: 'Made for kids', type: 'select', required: true, options: [{ value: 'no', label: 'No, it is not made for kids' }, { value: 'yes', label: 'Yes, it is made for kids' }], help: 'Required by YouTube (COPPA).' },
    { key: 'categoryId', label: 'Category', type: 'select', required: true, defaultValue: '22', options: YOUTUBE_CATEGORIES },
    { key: 'tags', label: 'Tags', type: 'tags', help: 'Up to 500 characters in total.' },
    { key: 'notifySubscribers', label: 'Notify subscribers', type: 'switch', defaultValue: true },
    { key: 'containsSyntheticMedia', label: 'Contains realistic altered or synthetic content', type: 'switch', defaultValue: false },
    {
      key: 'nativeSchedule',
      label: 'Upload early and let YouTube publish at the scheduled time',
      type: 'switch',
      defaultValue: false,
      help: 'Uses status.publishAt. Combine with a negative platform offset (e.g. −120 min) so the upload and processing finish before the post time.',
    },
  ],
  rateLimit: { maxConcurrent: 1, strategy: 'fixed', publishQuota: 'videos.insert: 100 per day per project (video uploads bucket); other calls 10,000 units/day' },
  fromMaster: (master: MasterContent) => titledFromMaster(master, 100, true),
  validate: ({ content, settings }) => {
    const issues: ValidationIssue[] = [];
    if (/[<>]/.test(content.title)) issues.push({ field: 'content.title', code: 'invalid_chars', message: 'YouTube titles cannot contain < or >.', severity: 'error' });
    if (/[<>]/.test(content.description)) issues.push({ field: 'content.description', code: 'invalid_chars', message: 'YouTube descriptions cannot contain < or >.', severity: 'error' });
    const tags = Array.isArray(settings.tags) ? (settings.tags as string[]) : [];
    // YouTube counts a tag containing spaces as if it were quoted (+2) and separators between tags.
    const total = tags.reduce((acc, t) => acc + t.length + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1);
    if (total > 500) issues.push({ field: 'settings.tags', code: 'too_long', message: `Tags use ${total} of 500 characters.`, severity: 'error' });
    return issues;
  },
};

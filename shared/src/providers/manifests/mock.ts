import type { ProviderManifest } from '../manifest';
import { GB, MB, defaultFromMaster } from '../helpers';

export const MOCK_OUTCOMES = [
  { value: 'success', label: 'Success' },
  { value: 'failure', label: 'Failure (validation, not retryable)' },
  { value: 'processing', label: 'Processing, then success' },
  { value: 'processing_fail', label: 'Processing, then failure' },
  { value: 'rate_limit', label: 'Rate limit (retryable)' },
  { value: 'auth_expired', label: 'Auth expired (needs reconnect)' },
  { value: 'network_flaky', label: 'Network error once, then success' },
];

/**
 * MOCK provider — development and tests only. It never talks to a real
 * network, its ids are prefixed `mock_` and the UI labels it as MOCK.
 * The backend refuses to register it when APP_ENV=production.
 */
export const mockManifest: ProviderManifest = {
  id: 'mock',
  displayName: 'Mock Network',
  authFamily: 'mock',
  brandColor: '#7C3AED',
  iconPath: 'M4 4h16v16H4z M8 8v8 M12 8v8 M16 8v8',
  channelKinds: [{ id: 'mock_channel', label: 'Mock channel' }],
  apiVersion: 'mock-1',
  docs: 'docs/adding-provider.md',
  devOnly: true,
  capabilities: {
    supports: { text: true, image: true, video: true, carousel: true, shortVideo: true, story: false },
    fields: {
      text: { supported: true, maxLength: 5000, label: 'Text' },
      title: { supported: true, maxLength: 150 },
      description: { supported: false },
      hashtags: { supported: true, appendToText: true, max: 30 },
      link: { supported: true },
    },
    formats: [
      { id: 'post', label: 'Post', media: { min: 0, max: 10, images: true, videos: true, mixed: true }, preview: 'feed' },
      { id: 'video', label: 'Video', media: { min: 1, max: 1, images: false, videos: true, mixed: false }, preview: 'vertical' },
    ],
    media: {
      image: { mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], maxBytes: 50 * MB },
      video: { mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'], maxBytes: 4 * GB },
    },
    canReadPosts: true,
    canCreatePost: true,
    canUpdatePost: true,
    canDeletePost: true,
    canScheduleNative: false,
    canFetchStatus: true,
    canEditPublishedPost: true,
    editableAfterPublish: ['text', 'title'],
    importMediaRetrievable: true,
    asyncProcessing: true,
    webhooks: false,
  },
  settingsFields: [{ key: 'mockOutcome', label: 'Simulated outcome', type: 'select', required: true, defaultValue: 'success', options: MOCK_OUTCOMES }],
  rateLimit: { maxConcurrent: 5, strategy: 'fixed' },
  fromMaster: defaultFromMaster,
};

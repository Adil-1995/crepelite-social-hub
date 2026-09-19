import type { MasterContent } from '../../domain/types';
import type { ProviderManifest } from '../manifest';
import { GB, MB, titledFromMaster } from '../helpers';

/**
 * Pinterest API v5. Sources (checked 2026-09):
 * - https://developers.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/
 * - https://developers.pinterest.com/docs/api/v5/pins-create/
 */
export const pinterestManifest: ProviderManifest = {
  id: 'pinterest',
  displayName: 'Pinterest',
  authFamily: 'pinterest',
  brandColor: '#E60023',
  iconPath: 'M12 2a10 10 0 0 0-3.6 19.3c-.1-.8-.2-2 0-2.9l1.2-5s-.3-.6-.3-1.5c0-1.4.8-2.5 1.8-2.5.9 0 1.3.7 1.3 1.5 0 .9-.6 2.2-.9 3.4-.2 1 .5 1.9 1.6 1.9 1.9 0 3.3-2 3.3-4.9 0-2.6-1.8-4.4-4.5-4.4-3 0-4.8 2.3-4.8 4.6 0 .9.4 1.9.8 2.4l.1.4-.3 1.2c0 .2-.2.3-.4.2-1.4-.7-2.2-2.7-2.2-4.3 0-3.5 2.5-6.7 7.3-6.7 3.8 0 6.8 2.7 6.8 6.4 0 3.8-2.4 6.9-5.8 6.9-1.1 0-2.2-.6-2.5-1.3l-.7 2.6c-.2 1-.9 2.2-1.4 2.9A10 10 0 1 0 12 2z',
  channelKinds: [{ id: 'pinterest_account', label: 'Pinterest account' }],
  apiVersion: 'v5',
  docs: 'docs/providers/pinterest.md',
  capabilities: {
    supports: { text: false, image: true, video: true, carousel: false, shortVideo: false, story: false },
    fields: {
      text: { supported: false },
      title: { supported: true, maxLength: 100, label: 'Pin title' },
      description: { supported: true, maxLength: 800, label: 'Pin description' },
      hashtags: { supported: false },
      link: { supported: true, maxLength: 2048 },
    },
    formats: [
      { id: 'image_pin', label: 'Image Pin', media: { min: 1, max: 1, images: true, videos: false, mixed: false }, preview: 'pin' },
      { id: 'video_pin', label: 'Video Pin', media: { min: 1, max: 1, images: false, videos: true, mixed: false }, preview: 'pin' },
    ],
    media: {
      image: { mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff'], maxBytes: 20 * MB },
      video: { mimeTypes: ['video/mp4', 'video/quicktime', 'video/x-m4v'], maxBytes: 2 * GB, minDurationSec: 4, maxDurationSec: 15 * 60 },
    },
    canReadPosts: true,
    canCreatePost: true,
    canUpdatePost: true,
    canDeletePost: true,
    canScheduleNative: false,
    canFetchStatus: true,
    canEditPublishedPost: true,
    editableAfterPublish: ['title', 'description', 'link', 'board', 'altText'],
    importMediaRetrievable: true,
    asyncProcessing: true,
    webhooks: false,
  },
  settingsFields: [
    { key: 'boardId', label: 'Board', type: 'select', required: true, optionsFromChannel: 'boards', help: 'Boards are loaded from your Pinterest account.' },
    { key: 'altText', label: 'Alt text', type: 'textarea', maxLength: 500 },
  ],
  rateLimit: { maxConcurrent: 2, strategy: 'headers' },
  fromMaster: (master: MasterContent) => titledFromMaster(master, 100, false),
  validate: ({ settings, channelMetadata }) => {
    const boards = channelMetadata?.boards as Array<{ value: string }> | undefined;
    const board = settings.boardId as string | undefined;
    if (board && boards && !boards.some((b) => b.value === board)) {
      return [{ field: 'settings.boardId', code: 'board_missing', message: 'The selected board no longer exists. Refresh boards and pick another one.', severity: 'error' }];
    }
    return [];
  },
};

import type { MasterContent, SocialProviderId, VariantContent } from '../domain/types';

/**
 * A ProviderManifest is the static, secret-free, client-safe description of a
 * social network: what it supports, which settings it needs and how to
 * validate content for it. The PWA renders the composer, connections and
 * previews from manifests only; the backend SocialProvider implementation
 * references the same manifest. Adding a network = adding one manifest + one
 * backend provider (see docs/adding-provider.md).
 */

export type MediaSupportKey = 'text' | 'image' | 'video' | 'carousel' | 'shortVideo' | 'story';

export interface ContentFormat {
  id: string;
  label: string;
  description?: string;
  /** Media requirements for this format. */
  media: {
    min: number;
    max: number;
    images: boolean;
    videos: boolean;
    /** Images and videos may be combined (e.g. Instagram carousel). */
    mixed: boolean;
  };
  /** Per-format overrides of the provider media constraints. */
  constraints?: Partial<MediaConstraints>;
  /** Preview layout hint for the PWA. */
  preview: 'feed' | 'vertical' | 'story' | 'pin' | 'video';
}

export interface ImageConstraints {
  mimeTypes: string[];
  maxBytes: number;
  minWidth?: number;
  maxWidth?: number;
  /** width / height */
  minAspectRatio?: number;
  maxAspectRatio?: number;
}

export interface VideoConstraints {
  mimeTypes: string[];
  maxBytes: number;
  minDurationSec?: number;
  maxDurationSec?: number;
  minWidth?: number;
  minAspectRatio?: number;
  maxAspectRatio?: number;
}

export interface MediaConstraints {
  image?: ImageConstraints;
  video?: VideoConstraints;
}

export interface TextFieldSupport {
  supported: boolean;
  required?: boolean;
  maxLength?: number;
  /** How the limit is counted. Most platforms count UTF-16 units; YouTube description counts bytes. */
  lengthUnit?: 'utf16' | 'bytes' | 'graphemes';
  label?: string;
}

export interface ContentFieldSupport {
  text: TextFieldSupport;
  title: TextFieldSupport;
  description: TextFieldSupport;
  hashtags: { supported: boolean; max?: number; /** appended to text when publishing */ appendToText?: boolean };
  link: { supported: boolean; required?: boolean; maxLength?: number };
}

export type SettingsFieldType = 'text' | 'textarea' | 'select' | 'switch' | 'tags' | 'url' | 'number';

export interface SettingsFieldOption {
  value: string;
  label: string;
}

export interface SettingsField {
  key: string;
  label: string;
  type: SettingsFieldType;
  required?: boolean;
  /** Only shown/validated for these format ids. */
  formats?: string[];
  options?: SettingsFieldOption[];
  /**
   * Dynamic options from the selected channel metadata, e.g. "boards" reads
   * channel.metadata.boards = [{ value, label }].
   */
  optionsFromChannel?: string;
  defaultValue?: string | boolean | number | string[];
  maxLength?: number;
  help?: string;
}

export interface ProviderCapabilities {
  supports: Record<MediaSupportKey, boolean>;
  fields: ContentFieldSupport;
  formats: ContentFormat[];
  media: MediaConstraints;
  canReadPosts: boolean;
  canCreatePost: boolean;
  canUpdatePost: boolean;
  canDeletePost: boolean;
  canScheduleNative: boolean;
  canFetchStatus: boolean;
  canEditPublishedPost: boolean;
  /** Which content keys may be changed after publishing (when canEditPublishedPost). */
  editableAfterPublish: Array<keyof VariantContent | string>;
  /** Whether imported posts' original media can be downloaded through the official API. */
  importMediaRetrievable: boolean;
  /** Publishing can finish asynchronously (processing state). */
  asyncProcessing: boolean;
  webhooks: boolean;
}

export interface ProviderRateLimit {
  /** Max concurrent publish executions per channel. */
  maxConcurrent: number;
  strategy: 'headers' | 'fixed';
  /** Documented publish quota, informative. */
  publishQuota?: string;
}

export interface ProviderManifest {
  id: SocialProviderId;
  displayName: string;
  /** Networks sharing an OAuth grant use the same family (meta → facebook + instagram). */
  authFamily: string;
  brandColor: string;
  /** Single-path 24×24 SVG icon. */
  iconPath: string;
  channelKinds: Array<{ id: string; label: string }>;
  capabilities: ProviderCapabilities;
  settingsFields: SettingsField[];
  rateLimit: ProviderRateLimit;
  apiVersion: string;
  docs: string;
  /** Development/testing only — never registered in production. */
  devOnly?: boolean;
  /** Maps master content to this network's variant defaults (linked mode). */
  fromMaster?: (master: MasterContent) => VariantContent;
  /** Provider specific pure validation, on top of the generic rules. */
  validate?: (input: ValidationInput) => ValidationIssue[];
}

export interface MediaInfo {
  id: string;
  kind: 'image' | 'video';
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  fileName: string;
}

export interface ValidationInput {
  format: string;
  content: VariantContent;
  media: MediaInfo[];
  settings: Record<string, unknown>;
  /** Non-secret channel metadata (boards, privacy options, account type...). */
  channelMetadata?: Record<string, unknown>;
}

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

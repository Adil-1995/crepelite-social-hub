/**
 * Domain model shared by the PWA, Cloud Functions and the publisher worker.
 * Firestore layout is documented in docs/DATABASE.md.
 */

/** Structural type satisfied by both firebase/firestore and firebase-admin Timestamps. */
export interface Ts {
  readonly seconds: number;
  readonly nanoseconds: number;
  toMillis(): number;
  toDate(): Date;
}

/** Provider ids are open strings so new networks never require a core type change. */
export type SocialProviderId = string;

export const ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  timezone: string; // IANA, e.g. Africa/Casablanca
  ownerId: string;
  createdAt: Ts;
  updatedAt: Ts;
}

export interface WorkspaceMember {
  uid: string;
  role: Role;
  email: string;
  displayName: string | null;
  photoURL: string | null;
  addedAt: Ts;
  addedBy: string | null;
}

export interface WorkspaceInvitation {
  id: string; // lower-cased email
  email: string;
  role: Exclude<Role, 'OWNER'>;
  invitedBy: string;
  createdAt: Ts;
  expiresAt: Ts;
}

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  defaultWorkspaceId: string | null;
  notificationPrefs: NotificationPrefs;
  createdAt: Ts;
}

export interface NotificationPrefs {
  pushEnabled: boolean;
  onPublished: boolean;
  onPartial: boolean;
  onFailed: boolean;
  onReauth: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  pushEnabled: false,
  onPublished: false,
  onPartial: true,
  onFailed: true,
  onReauth: true,
};

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export interface MasterContent {
  text: string;
  title: string;
  description: string;
  hashtags: string[];
  link: string;
}

export const EMPTY_MASTER_CONTENT: MasterContent = {
  text: '',
  title: '',
  description: '',
  hashtags: [],
  link: '',
};

export const POST_STATUSES = [
  'draft',
  'scheduled',
  'publishing',
  'published',
  'partially_published',
  'failed',
  'cancelled',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export interface PostSchedule {
  /** UTC instant. Null for drafts / publish-now. */
  scheduledAt: Ts | null;
  /** IANA timezone the user scheduled in (used to render and to re-derive local time). */
  timezone: string;
}

export interface PostSource {
  kind: 'manual' | 'bulk' | 'import';
  bulkJobId?: string;
  importJobId?: string;
  importedFrom?: { provider: SocialProviderId; channelId: string; externalPostId: string; permalink?: string };
}

export interface Post {
  id: string;
  workspaceId: string;
  titleInternal: string;
  masterContent: MasterContent;
  mediaIds: string[];
  status: PostStatus;
  schedule: PostSchedule;
  /** Channel ids targeted by this post (one variant + one delivery per channel). */
  channelIds: string[];
  internalNotes: string;
  source: PostSource;
  /** Denormalised per-channel status summary for list/calendar rendering. */
  deliverySummary: Record<string, DeliverySummaryEntry>;
  /** Earliest delivery scheduledAt, used for calendar range queries. */
  calendarAt: Ts | null;
  searchKeywords: string[];
  createdBy: string;
  updatedBy: string;
  createdAt: Ts;
  updatedAt: Ts;
  /** Increments on every server-side change, used for optimistic concurrency in the composer. */
  revision: number;
}

export interface DeliverySummaryEntry {
  deliveryId: string;
  provider: SocialProviderId;
  status: DeliveryStatus;
  scheduledAt: Ts | null;
  externalPostUrl: string | null;
  errorMessage: string | null;
}

export type SyncMode = 'master' | 'custom';

/** Per-platform content. Fields not supported by a provider are ignored by it. */
export interface VariantContent {
  text: string;
  title: string;
  description: string;
  hashtags: string[];
  link: string;
}

export interface PostVariant {
  id: string;
  workspaceId: string;
  postId: string;
  provider: SocialProviderId;
  channelId: string;
  syncMode: SyncMode;
  /** Content format id declared by the provider manifest (e.g. feed, reel, story, short). */
  format: string;
  content: VariantContent;
  /** Media override; null = use post.mediaIds. */
  mediaIds: string[] | null;
  providerSettings: Record<string, unknown>;
  /** Absolute override. When null the delivery time = post time + offsetMinutes. */
  scheduledAtOverride: Ts | null;
  offsetMinutes: number;
  createdAt: Ts;
  updatedAt: Ts;
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export const DELIVERY_STATUSES = [
  'draft',
  'awaiting_queue',
  'queued',
  'publishing',
  'processing',
  'published',
  'failed',
  'cancelled',
  'needs_reauth',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const ERROR_CATEGORIES = [
  'AUTH',
  'RATE_LIMIT',
  'VALIDATION',
  'MEDIA',
  'NETWORK',
  'PLATFORM',
  'PERMISSION',
  'PROCESSING',
  'UNKNOWN',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export interface DeliveryError {
  code: string;
  message: string;
  category: ErrorCategory;
  retryable: boolean;
  httpStatus?: number | null;
  at?: Ts;
}

export interface PublishingLease {
  owner: string; // execution id
  acquiredAt: Ts;
  expiresAt: Ts;
}

export interface Delivery {
  id: string;
  workspaceId: string;
  postId: string;
  variantId: string;
  provider: SocialProviderId;
  channelId: string;
  connectionId: string;
  status: DeliveryStatus;
  scheduledAt: Ts | null;
  scheduleVersion: number;
  taskName: string | null;
  /** Which executor runs this delivery. */
  executor: 'functions' | 'worker';
  externalPostId: string | null;
  externalPostUrl: string | null;
  attemptCount: number;
  autoRetryCount: number;
  lastAttemptAt: Ts | null;
  publishedAt: Ts | null;
  publishingLease: PublishingLease | null;
  error: DeliveryError | null;
  /**
   * Provider-specific checkpoint data persisted *before* irreversible steps
   * (e.g. Instagram container id, TikTok publish_id, YouTube upload URI) so that
   * reconciliation can resolve the real outcome instead of re-publishing.
   */
  processingMetadata: Record<string, unknown>;
  nextStatusCheckAt: Ts | null;
  statusCheckCount: number;
  /** When the next automatic retry runs (retryable errors only). */
  nextAttemptAt?: Ts | null;
  createdAt: Ts;
  updatedAt: Ts;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export type MediaKind = 'image' | 'video';

export interface MediaAsset {
  id: string;
  workspaceId: string;
  kind: MediaKind;
  storagePath: string;
  thumbnailPath: string | null;
  fileName: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  checksum: string | null;
  tags: string[];
  /** Post ids referencing this asset. Maintained server-side. */
  usedBy: string[];
  status: 'uploading' | 'ready' | 'error';
  source: 'upload' | 'import' | 'copy';
  createdBy: string;
  createdAt: Ts;
  lastUsedAt: Ts | null;
}

// ---------------------------------------------------------------------------
// Connections / Channels
// ---------------------------------------------------------------------------

export const CONNECTION_STATUSES = ['connected', 'expired', 'needs_reauth', 'revoked', 'error'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Public, client-readable metadata of an OAuth connection. Never contains tokens. */
export interface SocialConnection {
  id: string;
  workspaceId: string;
  provider: SocialProviderId;
  /** Provider "family" sharing one OAuth grant (e.g. meta → facebook + instagram). */
  authFamily: string;
  accountName: string;
  externalAccountId: string;
  status: ConnectionStatus;
  scopes: string[];
  expiresAt: Ts | null;
  lastHealthCheckAt: Ts | null;
  lastError: DeliveryError | null;
  createdBy: string;
  createdAt: Ts;
  updatedAt: Ts;
}

/** A publishing destination (page, IG account, board owner, channel...). */
export interface SocialChannel {
  id: string;
  workspaceId: string;
  provider: SocialProviderId;
  connectionId: string;
  externalId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  kind: string; // provider specific: page | ig_business | tiktok_user | pinterest_user | youtube_channel | mock
  status: ConnectionStatus;
  enabled: boolean;
  /** Non-secret provider metadata (e.g. Pinterest boards, TikTok privacy options). */
  metadata: Record<string, unknown>;
  createdAt: Ts;
  updatedAt: Ts;
}

// ---------------------------------------------------------------------------
// Jobs / logs / notifications
// ---------------------------------------------------------------------------

export interface BulkJob {
  id: string;
  workspaceId: string;
  status: 'completed' | 'failed' | 'running';
  postIds: string[];
  config: Record<string, unknown>;
  createdBy: string;
  createdAt: Ts;
}

export interface ImportCandidate {
  externalPostId: string;
  permalink: string | null;
  publishedAt: string; // ISO
  text: string;
  mediaType: 'image' | 'video' | 'carousel' | 'text' | 'unknown';
  thumbnailUrl: string | null;
  /** Whether the media can be retrieved via the official API. */
  mediaRetrievable: boolean;
  mediaNote: string | null;
}

export interface ImportJob {
  id: string;
  workspaceId: string;
  provider: SocialProviderId;
  channelId: string;
  status: 'fetching' | 'ready' | 'importing' | 'completed' | 'failed';
  range: { from: string; to: string };
  candidates: ImportCandidate[];
  importedPostIds: string[];
  error: DeliveryError | null;
  createdBy: string;
  createdAt: Ts;
  updatedAt: Ts;
}

export interface AuditLog {
  id: string;
  workspaceId: string;
  actor: { uid: string | null; type: 'user' | 'system'; email?: string | null };
  action: string;
  entityType: 'post' | 'delivery' | 'connection' | 'channel' | 'media' | 'member' | 'workspace' | 'bulk' | 'import';
  entityId: string;
  metadata: Record<string, unknown>;
  timestamp: Ts;
}

export type NotificationKind = 'published' | 'partial' | 'failed' | 'reauth';

export interface AppNotification {
  id: string;
  workspaceId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  postId: string | null;
  deliveryId: string | null;
  connectionId: string | null;
  readBy: string[];
  createdAt: Ts;
}

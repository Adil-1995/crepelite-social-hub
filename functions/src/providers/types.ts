import type { Readable } from 'node:stream';
import type {
  Delivery,
  ImportCandidate,
  MediaAsset,
  PostVariant,
  ProviderCapabilities,
  ProviderManifest,
  SocialChannel,
  SocialProviderId,
  ValidationIssue,
  VariantContent,
} from '@shared/index';
import type { TokenSet } from '../services/tokenVault';

/**
 * Backend contract every social network implements. The core (scheduler,
 * publishing engine, API, UI) only talks to this interface through the
 * ProviderRegistry — never to a concrete client.
 */

// ---------------------------------------------------------------------------
// OAuth — shared per auth family (e.g. Meta → Facebook + Instagram)
// ---------------------------------------------------------------------------

export interface AuthorizationUrlRequest {
  state: string;
  redirectUri: string;
  /** PKCE S256 challenge, when the adapter uses PKCE. */
  codeChallenge: string | null;
  nonce: string;
}

export interface OAuthCallbackRequest {
  code: string;
  redirectUri: string;
  codeVerifier: string | null;
  /** Raw callback query (some providers return extra params). */
  query: Record<string, string>;
}

export interface OAuthResult {
  externalAccountId: string;
  accountName: string;
  scopes: string[];
  tokens: TokenSet;
}

/** A publishing destination discovered for a connection. */
export interface DiscoveredDestination {
  provider: SocialProviderId;
  externalId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  kind: string;
  metadata: Record<string, unknown>;
  /** Channel-scoped credentials (e.g. a Facebook Page access token). Stored in the vault, never in the channel doc. */
  channelTokens?: TokenSet;
}

export interface OAuthAdapter {
  readonly family: string;
  readonly displayName: string;
  /** Whether the adapter uses PKCE (S256). */
  readonly usesPkce: boolean;
  isConfigured(): boolean;
  /** What is missing, for the "Provider configuration required" message. */
  missingConfiguration(): string[];
  getAuthorizationUrl(req: AuthorizationUrlRequest): string;
  handleOAuthCallback(req: OAuthCallbackRequest): Promise<OAuthResult>;
  /** Returns refreshed tokens, or throws ProviderError(AUTH) when re-consent is required. */
  refreshAuthorization(tokens: TokenSet): Promise<TokenSet>;
  /** Best-effort revocation at the provider. */
  disconnect(tokens: TokenSet): Promise<void>;
  /** Lists every destination reachable with this grant (pages, IG accounts, channels...). */
  getDestinations(tokens: TokenSet): Promise<DiscoveredDestination[]>;
  /** Lightweight token validity probe used by the periodic health check. */
  checkHealth(tokens: TokenSet): Promise<{ ok: boolean; expiresAt?: number | null; scopes?: string[] }>;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export interface ResolvedMedia {
  asset: MediaAsset;
  /** Short-lived URL the provider can fetch (signed Storage URL or verified pull domain). */
  getPublicUrl(opts?: { verifiedDomain?: boolean }): Promise<string>;
  /** Signed URL of the stored thumbnail (video cover), or null when none exists. */
  getThumbnailUrl(): Promise<string | null>;
  /** Streams bytes from Storage without loading the file in memory. */
  openStream(range?: { start: number; end: number }): Readable;
}

export interface ChannelCredentials {
  /** Token to call the API for this channel (page token for Facebook, user token elsewhere). */
  accessToken: string;
  connection: TokenSet;
  channel: TokenSet | null;
}

export interface PublishContext {
  delivery: Delivery;
  variant: PostVariant;
  channel: SocialChannel;
  format: string;
  content: VariantContent;
  /** Final caption (text + hashtags) as rendered by the preview. */
  caption: string;
  settings: Record<string, unknown>;
  media: ResolvedMedia[];
  credentials: ChannelCredentials;
  /** The post's own scheduled instant (ms). Deliveries may run earlier via negative offsets (native scheduling). */
  postScheduledAt: number | null;
  /** Metadata persisted by a previous attempt (resume instead of re-publish). */
  previous: Record<string, unknown>;
  /**
   * Persists provider checkpoint data on the delivery BEFORE an irreversible
   * step, so a crash can be reconciled without publishing twice.
   */
  checkpoint(data: Record<string, unknown>): Promise<void>;
}

export type PublishResult =
  | { kind: 'published'; externalPostId: string; externalPostUrl: string | null; metadata?: Record<string, unknown> }
  | { kind: 'processing'; checkAfterSec: number; metadata: Record<string, unknown> };

export interface StatusContext {
  delivery: Delivery;
  channel: SocialChannel;
  credentials: ChannelCredentials;
  metadata: Record<string, unknown>;
  /**
   * Some platforms need a final call once processing ends (e.g. Instagram
   * media_publish). Providers checkpoint before it, exactly like in publish().
   */
  checkpoint(data: Record<string, unknown>): Promise<void>;
}

export type StatusResult =
  | PublishResult
  | { kind: 'failed'; code: string; message: string; category: import('@shared/index').ErrorCategory; retryable: boolean }
  /** Nothing was published and it is safe to publish again. */
  | { kind: 'not_published' };

export interface UpdatePublishedContext {
  delivery: Delivery;
  channel: SocialChannel;
  credentials: ChannelCredentials;
  content: VariantContent;
  caption: string;
  settings: Record<string, unknown>;
}

export interface ListPostsRequest {
  channel: SocialChannel;
  credentials: ChannelCredentials;
  fromMs: number;
  toMs: number;
  limit: number;
}

export interface ImportedMedia {
  kind: 'image' | 'video';
  /** Official API URL of the original file. Absent when the API does not expose it. */
  url: string | null;
  mimeType: string | null;
}

export interface ImportedPost extends ImportCandidate {
  media: ImportedMedia[];
}

export interface SocialProvider {
  readonly id: SocialProviderId;
  readonly displayName: string;
  readonly manifest: ProviderManifest;
  readonly auth: OAuthAdapter;

  getCapabilities(channel?: SocialChannel): ProviderCapabilities;

  /** Runtime (async) validation on top of the shared manifest rules, e.g. account status, creator limits. */
  validateContent(ctx: { channel: SocialChannel; format: string; content: VariantContent; settings: Record<string, unknown>; media: MediaAsset[] }): Promise<ValidationIssue[]>;

  /** Chooses where heavy work runs (Cloud Run worker for large video transfers). */
  executorFor(format: string, media: MediaAsset[]): 'functions' | 'worker';

  publish(ctx: PublishContext): Promise<PublishResult>;

  getPublicationStatus?(ctx: StatusContext): Promise<StatusResult>;
  updatePublished?(ctx: UpdatePublishedContext): Promise<void>;
  deletePublished?(ctx: { delivery: Delivery; channel: SocialChannel; credentials: ChannelCredentials }): Promise<void>;
  listPosts?(req: ListPostsRequest): Promise<ImportedPost[]>;
  getPost?(req: { channel: SocialChannel; credentials: ChannelCredentials; externalPostId: string }): Promise<ImportedPost | null>;

  /** Webhook verification + parsing; returns events keyed by provider publish ids. */
  webhook?: WebhookHandler;
}

export interface WebhookEvent {
  eventId: string;
  /** External id we stored on the delivery (e.g. TikTok publish_id). */
  lookup: { field: 'processingMetadata.publishId' | 'externalPostId'; value: string };
  type: string;
}

export interface WebhookHandler {
  /** GET verification handshake (Meta hub.challenge etc.). */
  verifyHandshake?(query: Record<string, string>): string | null;
  /** Must verify the signature per the provider's documentation. Throws if invalid. */
  verifyAndParse(req: { rawBody: Buffer; headers: Record<string, string | string[] | undefined> }): WebhookEvent[];
}

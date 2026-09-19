import { randomUUID } from 'node:crypto';
import { mockManifest, type MediaAsset, type SocialChannel, type ValidationIssue } from '@shared/index';
import { ProviderError } from '../errors';
import type {
  AuthorizationUrlRequest,
  DiscoveredDestination,
  ImportedPost,
  ListPostsRequest,
  OAuthAdapter,
  OAuthCallbackRequest,
  OAuthResult,
  PublishContext,
  PublishResult,
  SocialProvider,
  StatusContext,
  StatusResult,
  UpdatePublishedContext,
} from '../types';
import type { TokenSet } from '../../services/tokenVault';

/**
 * MOCK provider for development and automated tests.
 *
 * - Never calls a network; ids are prefixed `mock_` and the UI shows a MOCK badge.
 * - Only registered when APP_ENV !== production (see providers/index.ts).
 * - Outcome is chosen per variant with settings.mockOutcome.
 */
export class MockOAuthAdapter implements OAuthAdapter {
  readonly family = 'mock';
  readonly displayName = 'Mock Network';
  readonly usesPkce = true;

  isConfigured(): boolean {
    return true;
  }
  missingConfiguration(): string[] {
    return [];
  }

  /** "Authorises" immediately by redirecting straight to our own callback. */
  getAuthorizationUrl(req: AuthorizationUrlRequest): string {
    const u = new URL(req.redirectUri);
    u.searchParams.set('state', req.state);
    u.searchParams.set('code', `mock_code_${randomUUID()}`);
    return u.toString();
  }

  async handleOAuthCallback(req: OAuthCallbackRequest): Promise<OAuthResult> {
    if (!req.code.startsWith('mock_code_')) throw ProviderError.validation('Invalid mock authorization code', 'invalid_code');
    if (!req.codeVerifier) throw ProviderError.validation('Missing PKCE verifier', 'pkce_missing');
    return {
      externalAccountId: 'mock_account',
      accountName: 'Mock Account (MOCK)',
      scopes: ['mock.publish', 'mock.read'],
      tokens: {
        accessToken: `mock_at_${randomUUID()}`,
        refreshToken: `mock_rt_${randomUUID()}`,
        expiresAt: Date.now() + 24 * 3600 * 1000,
        extra: { mockReauthed: 'true' },
      },
    };
  }

  async refreshAuthorization(tokens: TokenSet): Promise<TokenSet> {
    if (tokens.extra?.mockRevoked === 'true') throw new ProviderError({ code: 'mock_revoked', message: 'Mock grant revoked', category: 'AUTH', retryable: false });
    return { ...tokens, accessToken: `mock_at_${randomUUID()}`, expiresAt: Date.now() + 24 * 3600 * 1000 };
  }

  async disconnect(): Promise<void> {}

  async getDestinations(): Promise<DiscoveredDestination[]> {
    return [
      { provider: 'mock', externalId: 'mock_channel_a', name: 'Mock Channel A', handle: '@mock_a', avatarUrl: null, kind: 'mock_channel', metadata: { mock: true } },
      { provider: 'mock', externalId: 'mock_channel_b', name: 'Mock Channel B', handle: '@mock_b', avatarUrl: null, kind: 'mock_channel', metadata: { mock: true } },
    ];
  }

  async checkHealth(tokens: TokenSet) {
    return { ok: tokens.extra?.mockRevoked !== 'true', expiresAt: tokens.expiresAt ?? null };
  }
}

export interface MockPublishRecord {
  deliveryId: string;
  scheduleVersion: number;
  externalPostId: string;
  at: number;
}

export class MockProvider implements SocialProvider {
  readonly id = 'mock';
  readonly displayName = 'Mock Network';
  readonly manifest = mockManifest;
  /** Every *logical* publication performed — tests assert on it to detect duplicates. */
  static publishLog: MockPublishRecord[] = [];

  constructor(readonly auth: OAuthAdapter) {}

  getCapabilities() {
    return this.manifest.capabilities;
  }

  async validateContent(): Promise<ValidationIssue[]> {
    return [];
  }

  executorFor(format: string, media: MediaAsset[]): 'functions' | 'worker' {
    return format === 'video' && media.some((m) => m.size > 200 * 1024 * 1024) ? 'worker' : 'functions';
  }

  private outcome(ctx: { settings: Record<string, unknown> }): string {
    return (ctx.settings.mockOutcome as string | undefined) ?? 'success';
  }

  private record(ctx: PublishContext): { externalPostId: string } {
    const externalPostId = `mock_${randomUUID()}`;
    MockProvider.publishLog.push({ deliveryId: ctx.delivery.id, scheduleVersion: ctx.delivery.scheduleVersion, externalPostId, at: Date.now() });
    return { externalPostId };
  }

  async publish(ctx: PublishContext): Promise<PublishResult> {
    const outcome = this.outcome(ctx);
    switch (outcome) {
      case 'failure':
        throw new ProviderError({ code: 'mock_invalid_media', message: 'MOCK: the platform rejected the media', category: 'MEDIA', retryable: false, httpStatus: 400 });
      case 'auth_expired':
        if (ctx.credentials.connection.extra?.mockReauthed !== 'true') {
          throw new ProviderError({ code: 'mock_token_expired', message: 'MOCK: authentication expired', category: 'AUTH', retryable: false, httpStatus: 401 });
        }
        break;
      case 'rate_limit':
        if (ctx.delivery.autoRetryCount < 1) {
          throw new ProviderError({ code: 'mock_rate_limited', message: 'MOCK: rate limited', category: 'RATE_LIMIT', retryable: true, httpStatus: 429, retryAfterSec: 30 });
        }
        break;
      case 'network_flaky':
        if (ctx.delivery.autoRetryCount < 1) {
          throw new ProviderError({ code: 'network_error', message: 'MOCK: connection reset', category: 'NETWORK', retryable: true });
        }
        break;
      case 'processing':
      case 'processing_fail': {
        const jobId = (ctx.previous.mockJobId as string | undefined) ?? `mock_job_${randomUUID()}`;
        await ctx.checkpoint({ mockJobId: jobId, mockOutcome: outcome });
        return { kind: 'processing', checkAfterSec: 10, metadata: { mockJobId: jobId, mockOutcome: outcome } };
      }
      default:
        break;
    }
    const { externalPostId } = this.record(ctx);
    return { kind: 'published', externalPostId, externalPostUrl: null, metadata: { mock: true } };
  }

  async getPublicationStatus(ctx: StatusContext): Promise<StatusResult> {
    const jobId = ctx.metadata.mockJobId as string | undefined;
    if (!jobId) return { kind: 'not_published' };
    if (ctx.metadata.mockOutcome === 'processing_fail') {
      return { kind: 'failed', code: 'mock_processing_failed', message: 'MOCK: media processing failed', category: 'PROCESSING', retryable: false };
    }
    if (ctx.delivery.statusCheckCount < 1) return { kind: 'processing', checkAfterSec: 10, metadata: ctx.metadata };
    const externalPostId = `mock_${jobId.replace('mock_job_', '')}`;
    MockProvider.publishLog.push({ deliveryId: ctx.delivery.id, scheduleVersion: ctx.delivery.scheduleVersion, externalPostId, at: Date.now() });
    return { kind: 'published', externalPostId, externalPostUrl: null };
  }

  async updatePublished(ctx: UpdatePublishedContext): Promise<void> {
    if (!ctx.delivery.externalPostId?.startsWith('mock_')) throw ProviderError.validation('Not a mock publication');
  }

  async deletePublished(): Promise<void> {}

  async listPosts(req: ListPostsRequest): Promise<ImportedPost[]> {
    const out: ImportedPost[] = [];
    const span = req.toMs - req.fromMs;
    for (let i = 0; i < Math.min(5, req.limit); i++) {
      const at = new Date(req.fromMs + (span * (i + 1)) / 6);
      const retrievable = i !== 3;
      out.push({
        externalPostId: `mock_import_${req.channel.id}_${i}`,
        permalink: null,
        publishedAt: at.toISOString(),
        text: `MOCK imported post #${i + 1} ✨ #crepelite`,
        mediaType: 'image',
        thumbnailUrl: null,
        mediaRetrievable: retrievable,
        mediaNote: retrievable ? null : 'MOCK: the original file must be uploaded manually.',
        media: retrievable ? [] : [{ kind: 'image', url: null, mimeType: null }],
      });
    }
    return out;
  }
}

export function isMockChannel(channel: SocialChannel): boolean {
  return channel.provider === 'mock';
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import { tiktokManifest, type MediaAsset, type ValidationIssue } from '@shared/index';
import { TIKTOK_CLIENT_SECRET, config, secretValue } from '../../config/env';
import type { TokenSet } from '../../services/tokenVault';
import { ProviderError } from '../errors';
import { HttpClient, type RateLimitInfo } from '../http';
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
  WebhookEvent,
  WebhookHandler,
} from '../types';

/**
 * TikTok Content Posting API (Direct Post) — https://developers.tiktok.com/doc/content-posting-api-get-started
 * Host: open.tiktokapis.com (v2). Checked 2026-09.
 *
 * Until TikTok audits the app, every post is forced to SELF_ONLY (private).
 * TIKTOK_APP_AUDITED=true must only be set after approval; the manifest
 * validation blocks public privacy levels otherwise ("Provider not approved
 * for public publishing").
 */
const API = 'https://open.tiktokapis.com';
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish', 'video.upload', 'video.list'];
const MIN_CHUNK = 5 * 1024 * 1024;
const CHUNK = 10 * 1024 * 1024;

interface TikTokEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string; log_id?: string };
}

export function mapTikTokError(status: number, body: unknown, rl: RateLimitInfo): ProviderError {
  const err = (body as TikTokEnvelope<unknown>)?.error ?? {};
  const code = err.code ?? `http_${status}`;
  const message = err.message || `TikTok API error (HTTP ${status})`;
  const mk = (category: ProviderError['category'], retryable: boolean, needsReauth = false, retryAfterSec: number | null = rl.retryAfterSec) =>
    new ProviderError({ code: `tiktok_${code}`, message, category, retryable, needsReauth, httpStatus: status, retryAfterSec });
  switch (code) {
    case 'access_token_invalid':
    case 'auth_removed':
      return mk('AUTH', false, true);
    case 'scope_not_authorized':
    case 'scope_permission_missed':
      return mk('PERMISSION', false, true);
    case 'rate_limit_exceeded':
      return mk('RATE_LIMIT', true, false, rl.retryAfterSec ?? 60);
    case 'spam_risk_too_many_posts':
    case 'reached_active_user_cap':
      return mk('RATE_LIMIT', true, false, 6 * 3600);
    case 'spam_risk_user_banned_from_posting':
    case 'unaudited_client_can_only_post_to_private_accounts':
    case 'url_ownership_unverified':
      return mk('PERMISSION', false);
    case 'privacy_level_option_mismatch':
    case 'invalid_params':
    case 'invalid_file_upload':
      return mk('VALIDATION', false);
    case 'internal_error':
      return mk('PLATFORM', true);
    default:
      return ProviderError.fromHttp(status || 500, `tiktok_${code}`, message, rl.retryAfterSec);
  }
}

class TikTokApi {
  readonly http: HttpClient;
  constructor(fetchImpl?: typeof fetch) {
    this.http = new HttpClient('tiktok', mapTikTokError, fetchImpl);
  }
  /** TikTok answers 200 with error.code != "ok" on some failures. */
  async call<T>(path: string, token: string, json?: unknown, method = 'POST', query?: Record<string, string>): Promise<T> {
    const res = await this.http.request<TikTokEnvelope<T>>({
      method,
      url: `${API}${path}`,
      headers: { Authorization: `Bearer ${token}` },
      ...(json !== undefined ? { json } : {}),
      ...(query ? { query } : {}),
    });
    if (res.data.error?.code && res.data.error.code !== 'ok') throw mapTikTokError(res.status, res.data, res.rateLimit);
    return res.data.data as T;
  }
}

export class TikTokOAuthAdapter implements OAuthAdapter {
  readonly family = 'tiktok';
  readonly displayName = 'TikTok';
  // PKCE is required by TikTok only for mobile/desktop apps; this web flow is a confidential client protected by state.
  readonly usesPkce = false;
  readonly api: TikTokApi;

  constructor(fetchImpl?: typeof fetch) {
    this.api = new TikTokApi(fetchImpl);
  }

  missingConfiguration(): string[] {
    const m: string[] = [];
    if (!config.tiktok.clientKey()) m.push('TIKTOK_CLIENT_KEY');
    if (!secretValue(TIKTOK_CLIENT_SECRET)) m.push('TIKTOK_CLIENT_SECRET (secret)');
    return m;
  }
  isConfigured(): boolean {
    return this.missingConfiguration().length === 0;
  }

  getAuthorizationUrl(req: AuthorizationUrlRequest): string {
    const u = new URL('https://www.tiktok.com/v2/auth/authorize/');
    u.searchParams.set('client_key', config.tiktok.clientKey());
    u.searchParams.set('scope', TIKTOK_SCOPES.join(','));
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', req.redirectUri);
    u.searchParams.set('state', req.state);
    return u.toString();
  }

  private async token(form: Record<string, string>): Promise<TokenSet & { openId: string }> {
    const res = await this.api.http.request<{
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      refresh_expires_in?: number;
      open_id?: string;
      scope?: string;
      token_type?: string;
      error?: string;
      error_description?: string;
    }>({
      method: 'POST',
      url: `${API}/v2/oauth/token/`,
      form: { client_key: config.tiktok.clientKey(), client_secret: secretValue(TIKTOK_CLIENT_SECRET), ...form },
    });
    const d = res.data;
    if (!d.access_token) {
      throw new ProviderError({ code: `tiktok_${d.error ?? 'token_error'}`, message: d.error_description ?? 'TikTok token request failed', category: 'AUTH', retryable: false });
    }
    return {
      accessToken: d.access_token,
      refreshToken: d.refresh_token ?? null,
      expiresAt: d.expires_in ? Date.now() + d.expires_in * 1000 : null,
      refreshExpiresAt: d.refresh_expires_in ? Date.now() + d.refresh_expires_in * 1000 : null,
      scope: d.scope ?? null,
      tokenType: d.token_type ?? 'Bearer',
      openId: d.open_id ?? '',
      extra: { openId: d.open_id ?? '' },
    };
  }

  async handleOAuthCallback(req: OAuthCallbackRequest): Promise<OAuthResult> {
    const t = await this.token({ code: req.code, grant_type: 'authorization_code', redirect_uri: req.redirectUri });
    const info = await this.userInfo(t.accessToken);
    const { openId: _o, ...tokens } = t;
    return { externalAccountId: t.openId, accountName: info.display_name ?? info.username ?? 'TikTok', scopes: (t.scope ?? '').split(',').filter(Boolean), tokens };
  }

  async userInfo(token: string) {
    const d = await this.api.call<{ user: { open_id: string; display_name?: string; username?: string; avatar_url?: string } }>('/v2/user/info/', token, undefined, 'GET', {
      fields: 'open_id,display_name,username,avatar_url',
    });
    return d.user;
  }

  async refreshAuthorization(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) throw new ProviderError({ code: 'tiktok_no_refresh', message: 'TikTok authorization expired. Reconnect TikTok.', category: 'AUTH', retryable: false });
    const { openId: _o, ...t } = await this.token({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    return { ...t, extra: tokens.extra ?? {} };
  }

  async disconnect(tokens: TokenSet): Promise<void> {
    await this.api.http
      .request({ method: 'POST', url: `${API}/v2/oauth/revoke/`, form: { client_key: config.tiktok.clientKey(), client_secret: secretValue(TIKTOK_CLIENT_SECRET), token: tokens.accessToken } })
      .catch(() => undefined);
  }

  async creatorInfo(token: string) {
    return this.api.call<{
      creator_avatar_url?: string;
      creator_username?: string;
      creator_nickname?: string;
      privacy_level_options: string[];
      comment_disabled: boolean;
      duet_disabled: boolean;
      stitch_disabled: boolean;
      max_video_post_duration_sec: number;
    }>('/v2/post/publish/creator_info/query/', token, {});
  }

  async getDestinations(tokens: TokenSet): Promise<DiscoveredDestination[]> {
    const info = await this.userInfo(tokens.accessToken);
    const creator = await this.creatorInfo(tokens.accessToken).catch(() => null);
    return [
      {
        provider: 'tiktok',
        externalId: info.open_id,
        name: info.display_name ?? info.username ?? 'TikTok',
        handle: info.username ? `@${info.username}` : null,
        avatarUrl: info.avatar_url ?? null,
        kind: 'tiktok_account',
        metadata: {
          username: info.username ?? null,
          privacyLevelOptions: (creator?.privacy_level_options ?? []).map((v) => ({ value: v, label: labelForPrivacy(v) })),
          maxVideoPostDurationSec: creator?.max_video_post_duration_sec ?? null,
          commentDisabled: creator?.comment_disabled ?? false,
          duetDisabled: creator?.duet_disabled ?? false,
          stitchDisabled: creator?.stitch_disabled ?? false,
          appAudited: config.tiktok.audited(),
          photoPullDomainVerified: !!config.mediaPullBaseUrl(),
        },
      },
    ];
  }

  async checkHealth(tokens: TokenSet) {
    await this.userInfo(tokens.accessToken);
    return { ok: true, expiresAt: tokens.expiresAt ?? null };
  }
}

function labelForPrivacy(v: string): string {
  return ({ PUBLIC_TO_EVERYONE: 'Everyone', MUTUAL_FOLLOW_FRIENDS: 'Friends', FOLLOWER_OF_CREATOR: 'Followers', SELF_ONLY: 'Only me' } as Record<string, string>)[v] ?? v;
}

interface TtMeta {
  publishId?: string;
  uploadDone?: boolean;
}

export class TikTokProvider implements SocialProvider {
  readonly id = 'tiktok';
  readonly displayName = 'TikTok';
  readonly manifest = tiktokManifest;
  readonly webhook: WebhookHandler;

  constructor(readonly auth: TikTokOAuthAdapter) {
    this.webhook = new TikTokWebhook();
  }

  getCapabilities() {
    return this.manifest.capabilities;
  }

  async validateContent(ctx: Parameters<SocialProvider['validateContent']>[0]): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    if (!this.auth.isConfigured()) {
      issues.push({ field: 'provider', code: 'provider_not_configured', message: `Provider configuration required: ${this.auth.missingConfiguration().join(', ')}`, severity: 'error' });
    }
    if (!config.tiktok.audited() && ctx.settings.privacyLevel && ctx.settings.privacyLevel !== 'SELF_ONLY') {
      issues.push({ field: 'settings.privacyLevel', code: 'provider_not_approved', message: 'Provider not approved for public publishing. Until TikTok audits the app, choose "Only me".', severity: 'error' });
    }
    return issues;
  }

  executorFor(format: string): 'functions' | 'worker' {
    return format === 'video' ? 'worker' : 'functions';
  }

  async publish(ctx: PublishContext): Promise<PublishResult> {
    const token = ctx.credentials.accessToken;
    const prev = ctx.previous as TtMeta;
    if (prev.publishId) return { kind: 'processing', checkAfterSec: 5, metadata: { publishId: prev.publishId } };

    // Required before every post: refreshes creator options and detects posting caps.
    const creator = await this.auth.creatorInfo(token);
    const privacy = String(ctx.settings.privacyLevel ?? '');
    if (!creator.privacy_level_options.includes(privacy)) throw ProviderError.validation('Selected privacy level is not available for this TikTok account', 'privacy_level_option_mismatch');

    const common = {
      privacy_level: privacy,
      disable_comment: ctx.settings.disableComment === true || creator.comment_disabled,
      brand_content_toggle: ctx.settings.brandedContent === true,
      brand_organic_toggle: ctx.settings.brandOrganic === true,
      is_aigc: ctx.settings.isAigc === true,
    };

    if (ctx.format === 'photo') {
      const urls: string[] = [];
      for (const m of ctx.media) urls.push(await m.getPublicUrl({ verifiedDomain: true }));
      const d = await this.auth.api.call<{ publish_id: string }>('/v2/post/publish/content/init/', token, {
        post_info: { ...common, title: ctx.content.title.slice(0, 90), description: ctx.caption, auto_add_music: ctx.settings.autoAddMusic === true },
        source_info: { source: 'PULL_FROM_URL', photo_images: urls, photo_cover_index: 0 },
        post_mode: 'DIRECT_POST',
        media_type: 'PHOTO',
      });
      await ctx.checkpoint({ publishId: d.publish_id });
      return { kind: 'processing', checkAfterSec: 15, metadata: { publishId: d.publish_id } };
    }

    // Video: FILE_UPLOAD streamed from Storage chunk by chunk (never the whole file in memory).
    const media = ctx.media[0]!;
    const size = media.asset.size;
    const chunkSize = size < MIN_CHUNK ? size : CHUNK;
    const total = size < MIN_CHUNK ? 1 : Math.floor(size / chunkSize);
    const d = await this.auth.api.call<{ publish_id: string; upload_url: string }>('/v2/post/publish/video/init/', token, {
      post_info: {
        ...common,
        title: ctx.caption,
        disable_duet: ctx.settings.disableDuet === true || creator.duet_disabled,
        disable_stitch: ctx.settings.disableStitch === true || creator.stitch_disabled,
      },
      source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: total },
    });
    await ctx.checkpoint({ publishId: d.publish_id });
    for (let i = 0; i < total; i++) {
      const start = i * chunkSize;
      const end = i === total - 1 ? size - 1 : start + chunkSize - 1;
      const buf = await readRange(media.openStream({ start, end }));
      await this.auth.api.http.request({
        method: 'PUT',
        url: d.upload_url,
        headers: { 'Content-Type': media.asset.mimeType, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(buf.length) },
        body: new Uint8Array(buf),
        timeoutMs: 10 * 60 * 1000,
      });
    }
    await ctx.checkpoint({ uploadDone: true });
    return { kind: 'processing', checkAfterSec: 20, metadata: { publishId: d.publish_id, uploadDone: true } };
  }

  async getPublicationStatus(ctx: StatusContext): Promise<StatusResult> {
    const publishId = (ctx.metadata as TtMeta).publishId;
    if (!publishId) return { kind: 'not_published' };
    const d = await this.auth.api.call<{ status: string; fail_reason?: string; publicaly_available_post_id?: Array<string | number> }>(
      '/v2/post/publish/status/fetch/',
      ctx.credentials.accessToken,
      { publish_id: publishId },
    );
    switch (d.status) {
      case 'PUBLISH_COMPLETE': {
        const postId = d.publicaly_available_post_id?.[0];
        const username = ctx.channel.metadata.username as string | undefined;
        if (postId != null) {
          return { kind: 'published', externalPostId: String(postId), externalPostUrl: username ? `https://www.tiktok.com/@${username}/video/${postId}` : null, metadata: { publishId } };
        }
        // Private (SELF_ONLY) posts never get a public id; keep TikTok's publish_id as the reference.
        return { kind: 'published', externalPostId: publishId, externalPostUrl: null, metadata: { publishId, privateOrUnderReview: true } };
      }
      case 'FAILED': {
        const reason = d.fail_reason ?? 'unknown';
        const retryable = reason === 'internal';
        const category = reason === 'auth_removed' ? 'AUTH' : /format|size|duration|frame|picture/.test(reason) ? 'MEDIA' : reason.startsWith('spam_risk') ? 'RATE_LIMIT' : retryable ? 'PLATFORM' : 'PROCESSING';
        return { kind: 'failed', code: `tiktok_${reason}`, message: `TikTok rejected the post (${reason})`, category, retryable };
      }
      default:
        return { kind: 'processing', checkAfterSec: 30, metadata: { publishId } };
    }
  }

  async listPosts(req: ListPostsRequest): Promise<ImportedPost[]> {
    type V = { id: string; title?: string; video_description?: string; create_time: number; share_url?: string; cover_image_url?: string };
    const out: ImportedPost[] = [];
    let cursor: number | undefined = req.toMs;
    while (out.length < req.limit) {
      const d: { videos: V[]; cursor: number; has_more: boolean } = await this.auth.api.call('/v2/video/list/', req.credentials.accessToken, { max_count: 20, cursor }, 'POST', {
        fields: 'id,title,video_description,create_time,share_url,cover_image_url',
      });
      for (const v of d.videos) {
        const at = v.create_time * 1000;
        if (at < req.fromMs || at > req.toMs) continue;
        out.push({
          externalPostId: v.id,
          permalink: v.share_url ?? null,
          publishedAt: new Date(at).toISOString(),
          text: v.video_description ?? v.title ?? '',
          mediaType: 'video',
          thumbnailUrl: v.cover_image_url ?? null,
          mediaRetrievable: false,
          mediaNote: 'TikTok does not provide the original video file through its API. Upload the original manually.',
          media: [{ kind: 'video', url: null, mimeType: null }],
        });
      }
      const oldest = Math.min(...d.videos.map((v) => v.create_time * 1000));
      if (!d.has_more || oldest < req.fromMs) break;
      cursor = d.cursor;
    }
    return out.slice(0, req.limit);
  }

  static isVideo(media: MediaAsset[]): boolean {
    return media.some((m) => m.kind === 'video');
  }
}

async function readRange(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(parts);
}

/**
 * TikTok webhook: header `TikTok-Signature: t=<unix>,s=<hex hmac>` where
 * s = HMAC-SHA256(client_secret, `${t}.${rawBody}`). Events older than 5 minutes are rejected.
 */
export class TikTokWebhook implements WebhookHandler {
  verifyAndParse(req: { rawBody: Buffer; headers: Record<string, string | string[] | undefined> }): WebhookEvent[] {
    const header = String(req.headers['tiktok-signature'] ?? '');
    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
    const t = Number(parts.t);
    const s = parts.s ?? '';
    const secret = secretValue(TIKTOK_CLIENT_SECRET);
    if (!secret || !t || !s) throw new Error('Missing TikTok signature');
    if (Math.abs(Date.now() / 1000 - t) > 300) throw new Error('Stale TikTok webhook');
    const expected = createHmac('sha256', secret).update(`${t}.${req.rawBody.toString('utf8')}`).digest();
    const given = Buffer.from(s, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('Invalid TikTok signature');

    const body = JSON.parse(req.rawBody.toString('utf8')) as { event: string; create_time: number; user_openid: string; content: string };
    let content: { publish_id?: string } = {};
    try {
      content = JSON.parse(body.content) as { publish_id?: string };
    } catch {
      content = {};
    }
    if (!content.publish_id) return [];
    return [{ eventId: `${body.event}_${content.publish_id}_${body.create_time}`, type: body.event, lookup: { field: 'processingMetadata.publishId', value: content.publish_id } }];
  }
}

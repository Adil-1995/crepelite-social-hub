import { Readable } from 'node:stream';
import { youtubeManifest, type ValidationIssue } from '@shared/index';
import { GOOGLE_OAUTH_CLIENT_SECRET, config, secretValue } from '../../config/env';
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
  ResolvedMedia,
  SocialProvider,
  StatusContext,
  StatusResult,
  UpdatePublishedContext,
} from '../types';

/**
 * YouTube Data API v3 — https://developers.google.com/youtube/v3
 * Upload: resumable protocol, streamed from Storage (Cloud Run worker).
 * Quota (2026): videos.insert uses the separate "video uploads" bucket (100/day by default).
 * Unverified API projects: uploads are forced to private until the audit passes.
 */
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.force-ssl'];
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';

export function mapGoogleError(status: number, body: unknown, rl: RateLimitInfo): ProviderError {
  const e = (body as { error?: { message?: string; errors?: Array<{ reason?: string }> } | string; error_description?: string })?.error;
  const reason = typeof e === 'object' ? (e?.errors?.[0]?.reason ?? '') : String(e ?? '');
  const message = (typeof e === 'object' ? e?.message : (body as { error_description?: string })?.error_description) || `YouTube API error (HTTP ${status})`;
  const code = `youtube_${reason || status}`;
  if (reason === 'invalid_grant' || status === 401) return new ProviderError({ code, message, category: 'AUTH', retryable: false, needsReauth: true, httpStatus: status });
  if (['quotaExceeded', 'uploadLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(reason)) {
    return new ProviderError({ code, message, category: 'RATE_LIMIT', retryable: true, httpStatus: status, retryAfterSec: rl.retryAfterSec ?? (reason === 'rateLimitExceeded' ? 60 : 6 * 3600) });
  }
  if (['forbidden', 'insufficientPermissions', 'youtubeSignupRequired', 'channelNotFound'].includes(reason)) return new ProviderError({ code, message, category: 'PERMISSION', retryable: false, httpStatus: status });
  if (/^invalid/.test(reason) || reason === 'mediaBodyRequired') return new ProviderError({ code, message, category: 'VALIDATION', retryable: false, httpStatus: status });
  return ProviderError.fromHttp(status, code, message, rl.retryAfterSec);
}

export class GoogleOAuthAdapter implements OAuthAdapter {
  readonly family = 'google';
  readonly displayName = 'Google (YouTube)';
  readonly usesPkce = true;
  readonly http: HttpClient;

  constructor(fetchImpl?: typeof fetch) {
    this.http = new HttpClient('youtube', mapGoogleError, fetchImpl);
  }

  missingConfiguration(): string[] {
    const m: string[] = [];
    if (!config.google.clientId()) m.push('GOOGLE_OAUTH_CLIENT_ID');
    if (!secretValue(GOOGLE_OAUTH_CLIENT_SECRET)) m.push('GOOGLE_OAUTH_CLIENT_SECRET (secret)');
    return m;
  }
  isConfigured(): boolean {
    return this.missingConfiguration().length === 0;
  }

  getAuthorizationUrl(req: AuthorizationUrlRequest): string {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', config.google.clientId());
    u.searchParams.set('redirect_uri', req.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', YOUTUBE_SCOPES.join(' '));
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('include_granted_scopes', 'true');
    u.searchParams.set('state', req.state);
    if (req.codeChallenge) {
      u.searchParams.set('code_challenge', req.codeChallenge);
      u.searchParams.set('code_challenge_method', 'S256');
    }
    return u.toString();
  }

  private async token(form: Record<string, string>): Promise<TokenSet> {
    const res = await this.http.request<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string }>({
      method: 'POST',
      url: 'https://oauth2.googleapis.com/token',
      form: { client_id: config.google.clientId(), client_secret: secretValue(GOOGLE_OAUTH_CLIENT_SECRET), ...form },
    });
    const d = res.data;
    return { accessToken: d.access_token, refreshToken: d.refresh_token ?? form.refresh_token ?? null, expiresAt: d.expires_in ? Date.now() + d.expires_in * 1000 : null, scope: d.scope ?? null, tokenType: d.token_type ?? 'Bearer' };
  }

  async handleOAuthCallback(req: OAuthCallbackRequest): Promise<OAuthResult> {
    const tokens = await this.token({ grant_type: 'authorization_code', code: req.code, redirect_uri: req.redirectUri, ...(req.codeVerifier ? { code_verifier: req.codeVerifier } : {}) });
    const granted = (tokens.scope ?? '').split(' ');
    if (!granted.includes(YOUTUBE_SCOPES[0] as string)) {
      throw new ProviderError({ code: 'youtube_scope_missing', message: 'The YouTube upload permission was not granted', category: 'PERMISSION', retryable: false });
    }
    const ch = await this.channels(tokens.accessToken);
    const first = ch[0];
    return { externalAccountId: first?.id ?? 'google', accountName: first?.snippet.title ?? 'YouTube', scopes: granted, tokens };
  }

  async channels(token: string) {
    const r = await this.http.request<{ items?: Array<{ id: string; snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url: string } } } }> }>({
      url: `${API}/channels`,
      query: { part: 'snippet', mine: 'true' },
      headers: { Authorization: `Bearer ${token}` },
    });
    return r.data.items ?? [];
  }

  async refreshAuthorization(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) throw new ProviderError({ code: 'youtube_no_refresh', message: 'Google authorization expired. Reconnect YouTube.', category: 'AUTH', retryable: false });
    return this.token({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
  }

  async disconnect(tokens: TokenSet): Promise<void> {
    await this.http.request({ method: 'POST', url: 'https://oauth2.googleapis.com/revoke', form: { token: tokens.refreshToken ?? tokens.accessToken } }).catch(() => undefined);
  }

  async getDestinations(tokens: TokenSet): Promise<DiscoveredDestination[]> {
    const items = await this.channels(tokens.accessToken);
    return items.map((c) => ({
      provider: 'youtube',
      externalId: c.id,
      name: c.snippet.title,
      handle: c.snippet.customUrl ?? null,
      avatarUrl: c.snippet.thumbnails?.default?.url ?? null,
      kind: 'youtube_channel',
      metadata: { apiAudited: config.google.youtubeAudited() },
    }));
  }

  async checkHealth(tokens: TokenSet) {
    await this.channels(tokens.accessToken);
    return { ok: true, expiresAt: tokens.expiresAt ?? null };
  }
}

interface YtMeta {
  uploadUri?: string;
  videoId?: string;
}

export class YouTubeProvider implements SocialProvider {
  readonly id = 'youtube';
  readonly displayName = 'YouTube';
  readonly manifest = youtubeManifest;

  constructor(readonly auth: GoogleOAuthAdapter) {}

  getCapabilities() {
    return this.manifest.capabilities;
  }

  async validateContent(ctx: Parameters<SocialProvider['validateContent']>[0]): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    if (!this.auth.isConfigured()) {
      issues.push({ field: 'provider', code: 'provider_not_configured', message: `Provider configuration required: ${this.auth.missingConfiguration().join(', ')}`, severity: 'error' });
    }
    if (!config.google.youtubeAudited() && ctx.settings.privacyStatus !== 'private') {
      issues.push({
        field: 'settings.privacyStatus',
        code: 'api_not_audited',
        message: 'This Google API project is not audited yet: YouTube will lock uploads as private regardless of this setting.',
        severity: 'warning',
      });
    }
    return issues;
  }

  executorFor(): 'functions' | 'worker' {
    return 'worker';
  }

  private metadata(ctx: { content: PublishContext['content']; settings: Record<string, unknown> }, publishAtMs: number | null) {
    const privacy = String(ctx.settings.privacyStatus ?? 'private');
    const status: Record<string, unknown> = {
      privacyStatus: publishAtMs ? 'private' : privacy,
      selfDeclaredMadeForKids: ctx.settings.madeForKids === 'yes',
      containsSyntheticMedia: ctx.settings.containsSyntheticMedia === true,
    };
    if (publishAtMs) status.publishAt = new Date(publishAtMs).toISOString();
    return {
      snippet: {
        title: ctx.content.title,
        description: ctx.content.description,
        tags: Array.isArray(ctx.settings.tags) ? ctx.settings.tags : [],
        categoryId: String(ctx.settings.categoryId ?? '22'),
      },
      status,
    };
  }

  async publish(ctx: PublishContext): Promise<PublishResult> {
    const token = ctx.credentials.accessToken;
    const prev = ctx.previous as YtMeta;
    if (prev.videoId) return { kind: 'processing', checkAfterSec: 5, metadata: { videoId: prev.videoId } };
    const media = ctx.media[0]!;

    // Native scheduling: YouTube publishes at the post time (only if still ≥ 15 min ahead, as a private+publishAt video).
    const wantsNative = ctx.settings.nativeSchedule === true && ctx.settings.privacyStatus === 'public';
    const publishAtMs = wantsNative && ctx.postScheduledAt && ctx.postScheduledAt > Date.now() + 15 * 60_000 ? ctx.postScheduledAt : null;

    let uploadUri = prev.uploadUri;
    let offset = 0;
    if (uploadUri) {
      const probe = await this.probe(uploadUri, token, media.asset.size);
      if (probe.videoId) return this.afterUpload(ctx, probe.videoId);
      offset = probe.nextOffset;
    } else {
      const init = await this.auth.http.request({
        method: 'POST',
        url: UPLOAD,
        query: { uploadType: 'resumable', part: 'snippet,status', notifySubscribers: ctx.settings.notifySubscribers !== false },
        headers: { Authorization: `Bearer ${token}`, 'X-Upload-Content-Length': String(media.asset.size), 'X-Upload-Content-Type': media.asset.mimeType },
        json: this.metadata(ctx, publishAtMs),
      });
      uploadUri = init.headers.get('location') ?? undefined;
      if (!uploadUri) throw new ProviderError({ code: 'youtube_no_upload_uri', message: 'YouTube did not return an upload session', category: 'PLATFORM', retryable: true });
      // The session URI is the resumability checkpoint; it holds no credentials.
      await ctx.checkpoint({ uploadUri });
    }

    const videoId = await this.upload(uploadUri, token, media, offset);
    await ctx.checkpoint({ videoId });
    return this.afterUpload(ctx, videoId);
  }

  private afterUpload(_ctx: PublishContext, videoId: string): PublishResult {
    return { kind: 'processing', checkAfterSec: 60, metadata: { videoId } };
  }

  /** Streams bytes [offset, size) — the file never sits in memory. */
  private async upload(uri: string, token: string, media: ResolvedMedia, offset: number): Promise<string> {
    const size = media.asset.size;
    const stream = media.openStream(offset > 0 ? { start: offset, end: size - 1 } : undefined);
    const res = await this.auth.http.request<{ id: string }>({
      method: 'PUT',
      url: uri,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': media.asset.mimeType,
        'Content-Length': String(size - offset),
        ...(offset > 0 ? { 'Content-Range': `bytes ${offset}-${size - 1}/${size}` } : {}),
      },
      body: Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>,
      duplex: 'half',
      timeoutMs: 55 * 60 * 1000,
    });
    if (res.status === 308 || !res.data?.id) throw new ProviderError({ code: 'youtube_upload_incomplete', message: 'Upload interrupted; it will resume', category: 'NETWORK', retryable: true });
    return res.data.id;
  }

  /** Resumable-upload status probe: 308 → bytes received so far; 200/201 → finished. */
  private async probe(uri: string, token: string, size: number): Promise<{ nextOffset: number; videoId?: string }> {
    const res = await this.auth.http.request<{ id?: string }>({ method: 'PUT', url: uri, headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0', 'Content-Range': `bytes */${size}` } });
    if (res.status === 200 || res.status === 201) return { nextOffset: size, videoId: res.data?.id };
    const range = res.headers.get('range');
    const m = range ? /bytes=0-(\d+)/.exec(range) : null;
    return { nextOffset: m ? Number(m[1]) + 1 : 0 };
  }

  async getPublicationStatus(ctx: StatusContext): Promise<StatusResult> {
    const meta = ctx.metadata as YtMeta;
    if (!meta.videoId) {
      // Upload session started but not finished: nothing is on YouTube yet → resume the upload.
      return { kind: 'not_published' };
    }
    const r = await this.auth.http.request<{ items?: Array<{ status?: { uploadStatus?: string; failureReason?: string; rejectionReason?: string }; processingDetails?: { processingStatus?: string } }> }>({
      url: `${API}/videos`,
      query: { part: 'status,processingDetails', id: meta.videoId },
      headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` },
    });
    const v = r.data.items?.[0];
    if (!v) return { kind: 'failed', code: 'youtube_video_missing', message: 'The uploaded video no longer exists on YouTube', category: 'PLATFORM', retryable: false };
    const upload = v.status?.uploadStatus;
    if (upload === 'failed' || upload === 'rejected' || upload === 'deleted') {
      return { kind: 'failed', code: `youtube_${upload}`, message: `YouTube ${upload} the video${v.status?.failureReason ? ` (${v.status.failureReason})` : v.status?.rejectionReason ? ` (${v.status.rejectionReason})` : ''}`, category: 'MEDIA', retryable: false };
    }
    const processing = v.processingDetails?.processingStatus;
    if (processing === 'failed' || processing === 'terminated') return { kind: 'failed', code: 'youtube_processing_failed', message: 'YouTube could not process the video', category: 'PROCESSING', retryable: false };
    if (upload === 'processed' || processing === 'succeeded') {
      return { kind: 'published', externalPostId: meta.videoId, externalPostUrl: `https://www.youtube.com/watch?v=${meta.videoId}`, metadata: { videoId: meta.videoId } };
    }
    return { kind: 'processing', checkAfterSec: 60, metadata: { videoId: meta.videoId } };
  }

  async updatePublished(ctx: UpdatePublishedContext): Promise<void> {
    const id = ctx.delivery.externalPostId;
    if (!id) throw ProviderError.validation('No published video id');
    const m = this.metadata(ctx, null);
    await this.auth.http.request({
      method: 'PUT',
      url: `${API}/videos`,
      query: { part: 'snippet,status' },
      headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` },
      json: { id, snippet: m.snippet, status: { privacyStatus: m.status.privacyStatus, selfDeclaredMadeForKids: m.status.selfDeclaredMadeForKids } },
    });
  }

  async deletePublished(ctx: Parameters<NonNullable<SocialProvider['deletePublished']>>[0]): Promise<void> {
    if (!ctx.delivery.externalPostId) throw ProviderError.validation('No published video id');
    await this.auth.http.request({ method: 'DELETE', url: `${API}/videos`, query: { id: ctx.delivery.externalPostId }, headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` } });
  }

  async listPosts(req: ListPostsRequest): Promise<ImportedPost[]> {
    const auth = { Authorization: `Bearer ${req.credentials.accessToken}` };
    const ch = await this.auth.http.request<{ items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> }>({
      url: `${API}/channels`,
      query: { part: 'contentDetails', id: req.channel.externalId },
      headers: auth,
    });
    const uploads = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return [];
    const out: ImportedPost[] = [];
    let pageToken: string | undefined;
    do {
      const r: { data: { items?: Array<{ snippet: { title: string; description: string; publishedAt: string; resourceId: { videoId: string }; thumbnails?: { medium?: { url: string } } }; contentDetails?: { videoPublishedAt?: string } }>; nextPageToken?: string } } =
        await this.auth.http.request({ url: `${API}/playlistItems`, query: { part: 'snippet,contentDetails', playlistId: uploads, maxResults: 50, pageToken }, headers: auth });
      let older = false;
      for (const it of r.data.items ?? []) {
        const at = Date.parse(it.contentDetails?.videoPublishedAt ?? it.snippet.publishedAt);
        if (at < req.fromMs) older = true;
        if (at < req.fromMs || at > req.toMs) continue;
        const id = it.snippet.resourceId.videoId;
        out.push({
          externalPostId: id,
          permalink: `https://www.youtube.com/watch?v=${id}`,
          publishedAt: new Date(at).toISOString(),
          text: [it.snippet.title, it.snippet.description].filter(Boolean).join('\n\n'),
          mediaType: 'video',
          thumbnailUrl: it.snippet.thumbnails?.medium?.url ?? null,
          mediaRetrievable: false,
          mediaNote: 'The YouTube Data API does not provide the original video file. Upload the original manually.',
          media: [{ kind: 'video', url: null, mimeType: null }],
        });
      }
      pageToken = older ? undefined : r.data.nextPageToken;
    } while (pageToken && out.length < req.limit);
    return out.slice(0, req.limit);
  }
}

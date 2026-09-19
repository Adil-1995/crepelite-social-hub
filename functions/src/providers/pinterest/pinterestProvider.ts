import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { pinterestManifest, type ValidationIssue } from '@shared/index';
import { PINTEREST_CLIENT_SECRET, config, secretValue } from '../../config/env';
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
 * Pinterest API v5 — https://developers.pinterest.com/docs/api/v5/
 * Scopes: boards:read, pins:read, pins:write, user_accounts:read.
 * Apps with Trial access must use the sandbox host (PINTEREST_API_BASE=https://api-sandbox.pinterest.com).
 */
export const PINTEREST_SCOPES = ['boards:read', 'pins:read', 'pins:write', 'user_accounts:read'];

export function mapPinterestError(status: number, body: unknown, rl: RateLimitInfo): ProviderError {
  const b = body as { code?: number; message?: string };
  const message = b?.message || `Pinterest API error (HTTP ${status})`;
  const code = `pinterest_${b?.code ?? status}`;
  if (status === 429) {
    const retry = rl.retryAfterSec ?? (rl.resetAtMs ? Math.ceil((rl.resetAtMs - Date.now()) / 1000) : 60);
    return new ProviderError({ code, message, category: 'RATE_LIMIT', retryable: true, httpStatus: status, retryAfterSec: Math.max(1, retry) });
  }
  return ProviderError.fromHttp(status, code, message, rl.retryAfterSec);
}

class PinterestApi {
  readonly http: HttpClient;
  constructor(fetchImpl?: typeof fetch) {
    this.http = new HttpClient('pinterest', mapPinterestError, fetchImpl);
  }
  base(): string {
    return config.pinterest.apiBase().replace(/\/$/, '');
  }
  async call<T>(method: string, path: string, token: string, json?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    const res = await this.http.request<T>({ method, url: `${this.base()}/v5${path}`, headers: { Authorization: `Bearer ${token}` }, ...(json !== undefined ? { json } : {}), ...(query ? { query } : {}) });
    return res.data;
  }
}

export class PinterestOAuthAdapter implements OAuthAdapter {
  readonly family = 'pinterest';
  readonly displayName = 'Pinterest';
  readonly usesPkce = false;
  readonly api: PinterestApi;

  constructor(fetchImpl?: typeof fetch) {
    this.api = new PinterestApi(fetchImpl);
  }

  missingConfiguration(): string[] {
    const m: string[] = [];
    if (!config.pinterest.appId()) m.push('PINTEREST_APP_ID');
    if (!secretValue(PINTEREST_CLIENT_SECRET)) m.push('PINTEREST_CLIENT_SECRET (secret)');
    return m;
  }
  isConfigured(): boolean {
    return this.missingConfiguration().length === 0;
  }

  getAuthorizationUrl(req: AuthorizationUrlRequest): string {
    const u = new URL('https://www.pinterest.com/oauth/');
    u.searchParams.set('client_id', config.pinterest.appId());
    u.searchParams.set('redirect_uri', req.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', PINTEREST_SCOPES.join(','));
    u.searchParams.set('state', req.state);
    return u.toString();
  }

  private async token(form: Record<string, string>): Promise<TokenSet> {
    const basic = Buffer.from(`${config.pinterest.appId()}:${secretValue(PINTEREST_CLIENT_SECRET)}`).toString('base64');
    const res = await this.api.http.request<{ access_token: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; scope?: string; token_type?: string }>({
      method: 'POST',
      url: `${this.api.base()}/v5/oauth/token`,
      headers: { Authorization: `Basic ${basic}` },
      form,
    });
    const d = res.data;
    return {
      accessToken: d.access_token,
      refreshToken: d.refresh_token ?? form.refresh_token ?? null,
      expiresAt: d.expires_in ? Date.now() + d.expires_in * 1000 : null,
      refreshExpiresAt: d.refresh_token_expires_in ? Date.now() + d.refresh_token_expires_in * 1000 : null,
      scope: d.scope ?? null,
      tokenType: d.token_type ?? 'bearer',
    };
  }

  async handleOAuthCallback(req: OAuthCallbackRequest): Promise<OAuthResult> {
    const tokens = await this.token({ grant_type: 'authorization_code', code: req.code, redirect_uri: req.redirectUri });
    const user = await this.api.call<{ username: string; id?: string }>('GET', '/user_account', tokens.accessToken);
    return { externalAccountId: user.id ?? user.username, accountName: user.username, scopes: (tokens.scope ?? '').split(/[ ,]/).filter(Boolean), tokens };
  }

  async refreshAuthorization(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) throw new ProviderError({ code: 'pinterest_no_refresh', message: 'Pinterest authorization expired. Reconnect Pinterest.', category: 'AUTH', retryable: false });
    return this.token({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
  }

  async disconnect(): Promise<void> {
    // Pinterest v5 has no token revocation endpoint; users revoke access from their Pinterest settings.
  }

  async listBoards(token: string): Promise<Array<{ value: string; label: string }>> {
    const boards: Array<{ value: string; label: string }> = [];
    let bookmark: string | undefined;
    do {
      const r: { items: Array<{ id: string; name: string }>; bookmark?: string | null } = await this.api.call('GET', '/boards', token, undefined, { page_size: 100, bookmark });
      boards.push(...r.items.map((b) => ({ value: b.id, label: b.name })));
      bookmark = r.bookmark ?? undefined;
    } while (bookmark && boards.length < 2000);
    return boards;
  }

  async getDestinations(tokens: TokenSet): Promise<DiscoveredDestination[]> {
    const user = await this.api.call<{ username: string; id?: string; profile_image?: string; account_type?: string }>('GET', '/user_account', tokens.accessToken);
    const boards = await this.listBoards(tokens.accessToken);
    return [
      {
        provider: 'pinterest',
        externalId: user.id ?? user.username,
        name: user.username,
        handle: `@${user.username}`,
        avatarUrl: user.profile_image ?? null,
        kind: 'pinterest_account',
        metadata: { boards, accountType: user.account_type ?? null, boardsRefreshedAt: Date.now() },
      },
    ];
  }

  async checkHealth(tokens: TokenSet) {
    await this.api.call('GET', '/user_account', tokens.accessToken);
    return { ok: true, expiresAt: tokens.expiresAt ?? null };
  }
}

interface PinMeta {
  mediaId?: string;
  pinRequestedAt?: number;
  pinId?: string;
  boardId?: string;
  title?: string;
}

export class PinterestProvider implements SocialProvider {
  readonly id = 'pinterest';
  readonly displayName = 'Pinterest';
  readonly manifest = pinterestManifest;

  constructor(readonly auth: PinterestOAuthAdapter) {}

  getCapabilities() {
    return this.manifest.capabilities;
  }

  async validateContent(): Promise<ValidationIssue[]> {
    if (!this.auth.isConfigured()) {
      return [{ field: 'provider', code: 'provider_not_configured', message: `Provider configuration required: ${this.auth.missingConfiguration().join(', ')}`, severity: 'error' }];
    }
    return [];
  }

  executorFor(format: string): 'functions' | 'worker' {
    return format === 'video_pin' ? 'worker' : 'functions';
  }

  private pinBody(ctx: { content: PublishContext['content']; settings: Record<string, unknown> }) {
    return {
      board_id: String(ctx.settings.boardId ?? ''),
      title: ctx.content.title || undefined,
      description: ctx.content.description || undefined,
      link: ctx.content.link || undefined,
      alt_text: (ctx.settings.altText as string) || undefined,
    };
  }

  async publish(ctx: PublishContext): Promise<PublishResult> {
    const token = ctx.credentials.accessToken;
    const prev = ctx.previous as PinMeta;
    if (prev.pinId) return this.published(prev.pinId);
    if (prev.mediaId) return { kind: 'processing', checkAfterSec: 5, metadata: { mediaId: prev.mediaId } };

    if (ctx.format === 'image_pin') {
      const url = await ctx.media[0]!.getPublicUrl();
      await ctx.checkpoint({ pinRequestedAt: Date.now(), boardId: ctx.settings.boardId, title: ctx.content.title });
      const pin = await this.auth.api.call<{ id: string }>('POST', '/pins', token, { ...this.pinBody(ctx), media_source: { source_type: 'image_url', url } });
      await ctx.checkpoint({ pinId: pin.id });
      return this.published(pin.id);
    }

    if (ctx.format === 'video_pin') {
      const media = ctx.media[0]!;
      const reg = await this.auth.api.call<{ media_id: string; upload_url: string; upload_parameters: Record<string, string> }>('POST', '/media', token, { media_type: 'video' });
      await ctx.checkpoint({ mediaId: reg.media_id });
      await this.uploadMultipart(reg.upload_url, reg.upload_parameters, media);
      const cover = await media.getThumbnailUrl();
      await ctx.checkpoint({ uploadDone: true, coverUrl: cover, pin: this.pinBody(ctx) });
      return { kind: 'processing', checkAfterSec: 15, metadata: { mediaId: reg.media_id } };
    }
    throw ProviderError.validation(`Unsupported Pinterest format "${ctx.format}"`);
  }

  /** Streams the file into the pre-signed multipart upload (no Bearer token required). */
  private async uploadMultipart(url: string, params: Record<string, string>, media: ResolvedMedia): Promise<void> {
    const boundary = `----crepelite${randomUUID().replace(/-/g, '')}`;
    let pre = '';
    for (const [k, v] of Object.entries(params)) pre += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
    pre += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${media.asset.fileName.replace(/"/g, '')}"\r\nContent-Type: ${media.asset.mimeType}\r\n\r\n`;
    const post = `\r\n--${boundary}--\r\n`;
    const preBuf = Buffer.from(pre);
    const postBuf = Buffer.from(post);
    async function* body() {
      yield preBuf;
      for await (const chunk of media.openStream()) yield chunk as Buffer;
      yield postBuf;
    }
    const stream = Readable.toWeb(Readable.from(body())) as ReadableStream<Uint8Array>;
    await this.auth.api.http.request({
      method: 'POST',
      url,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(preBuf.length + media.asset.size + postBuf.length) },
      body: stream,
      duplex: 'half',
      timeoutMs: 30 * 60 * 1000,
    });
  }

  private published(pinId: string): PublishResult {
    return { kind: 'published', externalPostId: pinId, externalPostUrl: `https://www.pinterest.com/pin/${pinId}/`, metadata: { pinId } };
  }

  async getPublicationStatus(ctx: StatusContext): Promise<StatusResult> {
    const token = ctx.credentials.accessToken;
    const meta = ctx.metadata as PinMeta & { uploadDone?: boolean; coverUrl?: string | null; pin?: Record<string, unknown> };
    if (meta.pinId) return this.published(meta.pinId);
    if (meta.pinRequestedAt) {
      // A pin creation was requested but not confirmed: look for it instead of creating another one.
      const found = await this.findRecentPin(token, meta.boardId, meta.title, meta.pinRequestedAt);
      if (found) return this.published(found);
      if (!meta.mediaId) {
        return { kind: 'failed', code: 'outcome_unknown', message: 'Pinterest did not confirm the Pin. Check the board before retrying.', category: 'UNKNOWN', retryable: false };
      }
    }
    if (!meta.mediaId) return { kind: 'not_published' };
    if (!meta.uploadDone) return { kind: 'not_published' }; // upload never completed: nothing was pinned
    const m = await this.auth.api.call<{ status: 'registered' | 'processing' | 'succeeded' | 'failed' }>('GET', `/media/${meta.mediaId}`, token);
    if (m.status === 'failed') return { kind: 'failed', code: 'pinterest_media_failed', message: 'Pinterest could not process the video', category: 'MEDIA', retryable: false };
    if (m.status !== 'succeeded') return { kind: 'processing', checkAfterSec: 20, metadata: { mediaId: meta.mediaId } };

    const pinBody = meta.pin ?? {};
    await ctx.checkpoint({ pinRequestedAt: Date.now(), boardId: pinBody.board_id, title: pinBody.title });
    const source: Record<string, unknown> = { source_type: 'video_id', media_id: meta.mediaId };
    if (meta.coverUrl) source.cover_image_url = meta.coverUrl;
    else source.cover_image_key_frame_time = 1;
    const pin = await this.auth.api.call<{ id: string }>('POST', '/pins', token, { ...pinBody, media_source: source });
    await ctx.checkpoint({ pinId: pin.id });
    return this.published(pin.id);
  }

  private async findRecentPin(token: string, boardId: string | undefined, title: string | undefined, sinceMs: number): Promise<string | null> {
    if (!boardId) return null;
    const r = await this.auth.api.call<{ items: Array<{ id: string; title?: string; created_at?: string }> }>('GET', `/boards/${boardId}/pins`, token, undefined, { page_size: 25 });
    const hit = r.items.find((p) => (p.created_at ? Date.parse(p.created_at) >= sinceMs - 120_000 : false) && (!title || p.title === title));
    return hit?.id ?? null;
  }

  async updatePublished(ctx: UpdatePublishedContext): Promise<void> {
    if (!ctx.delivery.externalPostId) throw ProviderError.validation('No published Pin id');
    await this.auth.api.call('PATCH', `/pins/${ctx.delivery.externalPostId}`, ctx.credentials.accessToken, this.pinBody(ctx));
  }

  async deletePublished(ctx: Parameters<NonNullable<SocialProvider['deletePublished']>>[0]): Promise<void> {
    if (!ctx.delivery.externalPostId) throw ProviderError.validation('No published Pin id');
    await this.auth.api.call('DELETE', `/pins/${ctx.delivery.externalPostId}`, ctx.credentials.accessToken);
  }

  async listPosts(req: ListPostsRequest): Promise<ImportedPost[]> {
    type Pin = {
      id: string;
      title?: string;
      description?: string;
      link?: string;
      created_at: string;
      media?: { media_type?: string; images?: Record<string, { url: string }>; cover_image_url?: string };
    };
    const out: ImportedPost[] = [];
    let bookmark: string | undefined;
    do {
      const r: { items: Pin[]; bookmark?: string | null } = await this.auth.api.call('GET', '/pins', req.credentials.accessToken, undefined, { page_size: 100, bookmark });
      for (const p of r.items) {
        const at = Date.parse(p.created_at);
        if (at < req.fromMs || at > req.toMs) continue;
        const isVideo = p.media?.media_type === 'video';
        const imageUrl = p.media?.images?.originals?.url ?? p.media?.images?.['1200x']?.url ?? null;
        out.push({
          externalPostId: p.id,
          permalink: `https://www.pinterest.com/pin/${p.id}/`,
          publishedAt: new Date(at).toISOString(),
          text: [p.title, p.description].filter(Boolean).join('\n\n'),
          mediaType: isVideo ? 'video' : 'image',
          thumbnailUrl: p.media?.cover_image_url ?? imageUrl,
          mediaRetrievable: !isVideo && !!imageUrl,
          mediaNote: isVideo ? 'Pinterest does not provide the original video file through its API. Upload the original manually.' : null,
          media: [{ kind: isVideo ? 'video' : 'image', url: isVideo ? null : imageUrl, mimeType: null }],
        });
      }
      bookmark = r.bookmark ?? undefined;
      const oldest = Math.min(...r.items.map((p) => Date.parse(p.created_at)));
      if (oldest < req.fromMs) break;
    } while (bookmark && out.length < req.limit);
    return out.slice(0, req.limit);
  }
}

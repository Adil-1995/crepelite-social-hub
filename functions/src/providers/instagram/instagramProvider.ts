import { instagramManifest, type MediaAsset, type ValidationIssue } from '@shared/index';
import { ProviderError } from '../errors';
import type { MetaOAuthService } from '../meta/metaOAuthService';
import type {
  ImportedPost,
  ListPostsRequest,
  PublishContext,
  PublishResult,
  ResolvedMedia,
  SocialProvider,
  StatusContext,
  StatusResult,
} from '../types';

/**
 * Instagram Content Publishing (professional accounts, Facebook Login variant):
 *   POST /{ig-user-id}/media         → container (image_url / video_url + media_type)
 *   GET  /{container-id}?fields=status_code   (IN_PROGRESS | FINISHED | ERROR | EXPIRED | PUBLISHED)
 *   POST /{ig-user-id}/media_publish → media id
 *
 * Checkpoints: child/container ids are stored before media_publish, and
 * `publishRequestedAt` right before it. If a crash happens after media_publish
 * the container reports PUBLISHED; we then mark the delivery published and look
 * the media up by timestamp — never publishing the container twice.
 */
type ContainerStatus = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';

interface IgMeta {
  childIds?: string[];
  containerId?: string;
  publishRequestedAt?: number;
  mediaId?: string;
}

export class InstagramProvider implements SocialProvider {
  readonly id = 'instagram';
  readonly displayName = 'Instagram';
  readonly manifest = instagramManifest;

  constructor(readonly auth: MetaOAuthService) {}

  private get graph() {
    return this.auth.graph;
  }

  getCapabilities() {
    return this.manifest.capabilities;
  }

  async validateContent(): Promise<ValidationIssue[]> {
    if (!this.auth.isConfigured()) {
      return [{ field: 'provider', code: 'provider_not_configured', message: `Provider configuration required: ${this.auth.missingConfiguration().join(', ')}`, severity: 'error' }];
    }
    return [];
  }

  /** Instagram pulls media from a URL — no heavy transfer on our side. */
  executorFor(): 'functions' | 'worker' {
    return 'functions';
  }

  private async containerStatus(id: string, token: string): Promise<{ status: ContainerStatus; message?: string }> {
    const r = await this.graph.get<{ status_code: ContainerStatus; status?: string }>(id, token, { fields: 'status_code,status' });
    return { status: r.status_code, message: r.status };
  }

  private async createItem(igId: string, token: string, m: ResolvedMedia, extra: Record<string, string | boolean | undefined>): Promise<string> {
    const url = await m.getPublicUrl();
    const params: Record<string, string | boolean | undefined> = { ...extra };
    if (m.asset.kind === 'image') params.image_url = url;
    else {
      params.video_url = url;
      params.media_type ??= 'VIDEO';
    }
    const r = await this.graph.post<{ id: string }>(`${igId}/media`, token, params);
    return r.id;
  }

  async publish(ctx: PublishContext): Promise<PublishResult> {
    const token = ctx.credentials.accessToken;
    const igId = ctx.channel.externalId;
    const prev = ctx.previous as IgMeta;
    if (prev.containerId) return this.advance(ctx, prev, ctx.checkpoint); // resume, never recreate

    let containerId: string;
    switch (ctx.format) {
      case 'feed': {
        const m = ctx.media[0] as ResolvedMedia;
        containerId = await this.createItem(igId, token, m, { caption: ctx.caption, alt_text: (ctx.settings.altText as string) || undefined });
        break;
      }
      case 'reel': {
        const m = ctx.media[0] as ResolvedMedia;
        containerId = await this.createItem(igId, token, m, { media_type: 'REELS', caption: ctx.caption, share_to_feed: ctx.settings.shareToFeed !== false });
        break;
      }
      case 'story': {
        const m = ctx.media[0] as ResolvedMedia;
        containerId = await this.createItem(igId, token, m, { media_type: 'STORIES' });
        break;
      }
      case 'carousel': {
        let childIds = prev.childIds ?? [];
        if (childIds.length === 0) {
          for (const m of ctx.media) childIds.push(await this.createItem(igId, token, m, { is_carousel_item: true }));
          await ctx.checkpoint({ childIds, caption: ctx.caption });
        }
        childIds = [...childIds];
        const pending = await this.pendingChildren(childIds, token);
        if (pending === 'error') throw new ProviderError({ code: 'ig_child_error', message: 'Instagram could not process a carousel item', category: 'MEDIA', retryable: false });
        if (pending > 0) return { kind: 'processing', checkAfterSec: 20, metadata: { childIds } };
        containerId = await this.createCarousel(igId, token, childIds, ctx.caption);
        break;
      }
      default:
        throw ProviderError.validation(`Unsupported Instagram format "${ctx.format}"`);
    }
    await ctx.checkpoint({ containerId });
    return this.advance(ctx, { containerId }, ctx.checkpoint);
  }

  private async createCarousel(igId: string, token: string, childIds: string[], caption: string): Promise<string> {
    const r = await this.graph.post<{ id: string }>(`${igId}/media`, token, { media_type: 'CAROUSEL', children: childIds.join(','), caption });
    return r.id;
  }

  private async pendingChildren(childIds: string[], token: string): Promise<number | 'error'> {
    let pending = 0;
    for (const id of childIds) {
      const s = await this.containerStatus(id, token);
      if (s.status === 'ERROR' || s.status === 'EXPIRED') return 'error';
      if (s.status === 'IN_PROGRESS') pending++;
    }
    return pending;
  }

  /** Moves a checkpointed publication forward: children → container → media_publish. */
  private async advance(ctx: { channel: PublishContext['channel']; credentials: PublishContext['credentials']; caption?: string }, meta: IgMeta, checkpoint: (d: Record<string, unknown>) => Promise<void>): Promise<PublishResult> {
    const token = ctx.credentials.accessToken;
    const igId = ctx.channel.externalId;
    if (meta.mediaId) return this.published(meta.mediaId, token);
    if (!meta.containerId) throw new ProviderError({ code: 'ig_no_container', message: 'Instagram container missing', category: 'UNKNOWN', retryable: false });

    const s = await this.containerStatus(meta.containerId, token);
    if (s.status === 'IN_PROGRESS') return { kind: 'processing', checkAfterSec: 20, metadata: { containerId: meta.containerId } };
    if (s.status === 'ERROR') throw new ProviderError({ code: 'ig_container_error', message: `Instagram could not process the media${s.message ? `: ${s.message}` : ''}`, category: 'MEDIA', retryable: false });
    if (s.status === 'EXPIRED') throw new ProviderError({ code: 'ig_container_expired', message: 'The Instagram container expired (not published within 24 h)', category: 'PROCESSING', retryable: true });
    if (s.status === 'PUBLISHED') {
      // media_publish already happened (e.g. crash before we saved the id).
      const found = meta.publishRequestedAt ? await this.findRecentMedia(igId, token, meta.publishRequestedAt) : null;
      if (found) return this.published(found, token);
      return { kind: 'published', externalPostId: meta.containerId, externalPostUrl: null, metadata: { note: 'Published; media id resolved from container' } };
    }
    // FINISHED → publish exactly once
    await checkpoint({ publishRequestedAt: Date.now() });
    const r = await this.graph.post<{ id: string }>(`${igId}/media_publish`, token, { creation_id: meta.containerId });
    await checkpoint({ mediaId: r.id });
    return this.published(r.id, token);
  }

  private async published(mediaId: string, token: string): Promise<PublishResult> {
    let permalink: string | null = null;
    try {
      permalink = (await this.graph.get<{ permalink?: string }>(mediaId, token, { fields: 'permalink' })).permalink ?? null;
    } catch {
      permalink = null; // stories have no permalink after expiry; not fatal
    }
    return { kind: 'published', externalPostId: mediaId, externalPostUrl: permalink, metadata: { mediaId } };
  }

  private async findRecentMedia(igId: string, token: string, sinceMs: number): Promise<string | null> {
    const r = await this.graph.get<{ data: Array<{ id: string; timestamp: string }> }>(`${igId}/media`, token, { fields: 'id,timestamp', limit: 5 });
    const hit = r.data.find((m) => Date.parse(m.timestamp) >= sinceMs - 60_000);
    return hit?.id ?? null;
  }

  async getPublicationStatus(ctx: StatusContext): Promise<StatusResult> {
    const meta = ctx.metadata as IgMeta & { caption?: string };
    if (meta.mediaId) return this.published(meta.mediaId, ctx.credentials.accessToken);
    if (!meta.containerId && meta.childIds?.length) {
      const pending = await this.pendingChildren(meta.childIds, ctx.credentials.accessToken);
      if (pending === 'error') return { kind: 'failed', code: 'ig_child_error', message: 'Instagram could not process a carousel item', category: 'MEDIA', retryable: false };
      if (pending > 0) return { kind: 'processing', checkAfterSec: 30, metadata: { childIds: meta.childIds } };
      // All children processed → create the carousel container once, then continue.
      const containerId = await this.createCarousel(ctx.channel.externalId, ctx.credentials.accessToken, meta.childIds, meta.caption ?? '');
      await ctx.checkpoint({ containerId });
      return this.advance({ channel: ctx.channel, credentials: ctx.credentials }, { ...meta, containerId }, ctx.checkpoint);
    }
    if (!meta.containerId) return { kind: 'not_published' };
    return this.advance({ channel: ctx.channel, credentials: ctx.credentials }, meta, ctx.checkpoint);
  }

  async listPosts(req: ListPostsRequest): Promise<ImportedPost[]> {
    type IgMedia = {
      id: string;
      caption?: string;
      media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
      media_url?: string;
      thumbnail_url?: string;
      permalink?: string;
      timestamp: string;
      children?: { data: Array<{ media_type: string; media_url?: string }> };
    };
    const items = await this.graph.paginate<IgMedia>(
      `${req.channel.externalId}/media`,
      req.credentials.accessToken,
      {
        fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_type,media_url}',
        since: Math.floor(req.fromMs / 1000),
        until: Math.floor(req.toMs / 1000),
        limit: 50,
      },
      req.limit,
    );
    return items.map((m) => {
      const media =
        m.media_type === 'CAROUSEL_ALBUM'
          ? (m.children?.data ?? []).map((c) => ({ kind: c.media_type === 'VIDEO' ? ('video' as const) : ('image' as const), url: c.media_url ?? null, mimeType: null }))
          : [{ kind: m.media_type === 'VIDEO' ? ('video' as const) : ('image' as const), url: m.media_url ?? null, mimeType: null }];
      const retrievable = media.length > 0 && media.every((x) => !!x.url);
      return {
        externalPostId: m.id,
        permalink: m.permalink ?? null,
        publishedAt: m.timestamp,
        text: m.caption ?? '',
        mediaType: m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : m.media_type === 'VIDEO' ? 'video' : 'image',
        thumbnailUrl: m.thumbnail_url ?? m.media_url ?? null,
        mediaRetrievable: retrievable,
        // Instagram omits media_url for media containing copyrighted material.
        mediaNote: retrievable ? null : 'Instagram did not provide the original file (e.g. copyrighted audio). Upload the original manually.',
        media,
      };
    });
  }

  static mediaKinds(media: MediaAsset[]): string {
    return media.map((m) => m.kind).join(',');
  }
}

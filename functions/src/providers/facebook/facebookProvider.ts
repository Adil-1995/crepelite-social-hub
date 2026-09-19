import { facebookManifest, type ValidationIssue } from '@shared/index';
import { ProviderError } from '../errors';
import type { MetaOAuthService } from '../meta/metaOAuthService';
import type {
  ImportedPost,
  ListPostsRequest,
  PublishContext,
  PublishResult,
  SocialProvider,
  StatusContext,
  StatusResult,
  UpdatePublishedContext,
} from '../types';

/**
 * Facebook Pages (Graph API, page access token):
 *   text/link  → POST /{page}/feed {message, link}
 *   1 photo    → POST /{page}/photos {url, caption}
 *   N photos   → POST /{page}/photos {url, published=false} ×N, then /{page}/feed {attached_media}
 *   video      → POST /{page}/videos {file_url, description}  → processing → GET /{video}?fields=status
 *   reel       → /{page}/video_reels start → rupload (file_url header) → finish (video_state=PUBLISHED)
 * Update: POST /{post-id} {message} — only for posts created by this app.
 */
interface FbMeta {
  photoIds?: string[];
  videoId?: string;
  reel?: boolean;
  reelUploaded?: boolean;
  reelFinishRequested?: boolean;
}

interface VideoStatus {
  status?: {
    video_status?: string;
    uploading_phase?: { status?: string };
    processing_phase?: { status?: string };
    publishing_phase?: { status?: string; publish_status?: string };
  };
  permalink_url?: string;
  post_id?: string;
}

export class FacebookProvider implements SocialProvider {
  readonly id = 'facebook';
  readonly displayName = 'Facebook';
  readonly manifest = facebookManifest;

  constructor(readonly auth: MetaOAuthService) {}

  private get graph() {
    return this.auth.graph;
  }

  getCapabilities() {
    return this.manifest.capabilities;
  }

  async validateContent(ctx: Parameters<SocialProvider['validateContent']>[0]): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    if (!this.auth.isConfigured()) {
      issues.push({ field: 'provider', code: 'provider_not_configured', message: `Provider configuration required: ${this.auth.missingConfiguration().join(', ')}`, severity: 'error' });
    }
    if (ctx.channel.metadata.canCreateContent === false) {
      issues.push({ field: 'channel', code: 'missing_task', message: 'Your role on this Page does not allow creating content (CREATE_CONTENT).', severity: 'error' });
    }
    return issues;
  }

  executorFor(): 'functions' | 'worker' {
    return 'functions'; // Facebook pulls videos from file_url
  }

  private postUrl(id: string): string {
    return `https://www.facebook.com/${id}`;
  }

  async publish(ctx: PublishContext): Promise<PublishResult> {
    const token = ctx.credentials.accessToken;
    const page = ctx.channel.externalId;
    const prev = ctx.previous as FbMeta;
    const link = ctx.content.link.trim();

    if (ctx.format === 'post') {
      if (ctx.media.length === 0) {
        const r = await this.graph.post<{ id: string }>(`${page}/feed`, token, { message: ctx.caption, link: link || undefined });
        return { kind: 'published', externalPostId: r.id, externalPostUrl: this.postUrl(r.id) };
      }
      const message = link ? `${ctx.caption}\n\n${link}`.trim() : ctx.caption;
      if (ctx.media.length === 1) {
        const url = await ctx.media[0]!.getPublicUrl();
        const r = await this.graph.post<{ id: string; post_id?: string }>(`${page}/photos`, token, { url, caption: message, published: true });
        const id = r.post_id ?? r.id;
        return { kind: 'published', externalPostId: id, externalPostUrl: this.postUrl(id) };
      }
      let photoIds = prev.photoIds ?? [];
      if (photoIds.length === 0) {
        for (const m of ctx.media) {
          const url = await m.getPublicUrl();
          const r = await this.graph.post<{ id: string }>(`${page}/photos`, token, { url, published: false });
          photoIds.push(r.id);
        }
        await ctx.checkpoint({ photoIds });
      }
      photoIds = [...photoIds];
      const r = await this.graph.post<{ id: string }>(`${page}/feed`, token, {
        message,
        attached_media: JSON.stringify(photoIds.map((id) => ({ media_fbid: id }))),
      });
      return { kind: 'published', externalPostId: r.id, externalPostUrl: this.postUrl(r.id) };
    }

    if (ctx.format === 'video') {
      if (prev.videoId) return { kind: 'processing', checkAfterSec: 5, metadata: { videoId: prev.videoId } };
      const url = await ctx.media[0]!.getPublicUrl();
      const r = await this.graph.post<{ id: string }>(`${page}/videos`, token, { file_url: url, description: ctx.caption, title: ctx.content.title || undefined });
      await ctx.checkpoint({ videoId: r.id });
      return { kind: 'processing', checkAfterSec: 30, metadata: { videoId: r.id } };
    }

    if (ctx.format === 'reel') {
      let videoId = prev.videoId;
      if (!videoId) {
        const start = await this.graph.post<{ video_id: string; upload_url?: string }>(`${page}/video_reels`, token, { upload_phase: 'start' });
        videoId = start.video_id;
        await ctx.checkpoint({ videoId, reel: true });
      }
      if (!prev.reelUploaded) {
        const url = await ctx.media[0]!.getPublicUrl();
        await this.graph.rupload(`https://rupload.facebook.com/video-upload/${this.graph.version}/${videoId}`, token, { file_url: url });
        await ctx.checkpoint({ reelUploaded: true });
      }
      if (!prev.reelFinishRequested) {
        await ctx.checkpoint({ reelFinishRequested: true });
        await this.graph.post(`${page}/video_reels`, token, { upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: ctx.caption });
      }
      return { kind: 'processing', checkAfterSec: 30, metadata: { videoId } };
    }

    throw ProviderError.validation(`Unsupported Facebook format "${ctx.format}"`);
  }

  private async videoStatus(videoId: string, token: string): Promise<StatusResult> {
    const r = await this.graph.get<VideoStatus>(videoId, token, { fields: 'status,permalink_url,post_id' });
    const s = r.status ?? {};
    if (s.video_status === 'error' || s.processing_phase?.status === 'error' || s.uploading_phase?.status === 'error' || s.video_status === 'upload_failed') {
      return { kind: 'failed', code: 'fb_video_error', message: 'Facebook could not process the video', category: 'MEDIA', retryable: false };
    }
    if (s.video_status === 'expired') return { kind: 'failed', code: 'fb_video_expired', message: 'The Facebook upload session expired', category: 'PROCESSING', retryable: true };
    const publishedPhase = s.publishing_phase?.status === 'complete' || s.publishing_phase?.publish_status === 'published';
    if (s.video_status === 'ready' && (publishedPhase || !s.publishing_phase)) {
      const url = r.permalink_url ? (r.permalink_url.startsWith('http') ? r.permalink_url : `https://www.facebook.com${r.permalink_url}`) : this.postUrl(videoId);
      return { kind: 'published', externalPostId: r.post_id ?? videoId, externalPostUrl: url, metadata: { videoId } };
    }
    return { kind: 'processing', checkAfterSec: 30, metadata: { videoId } };
  }

  async getPublicationStatus(ctx: StatusContext): Promise<StatusResult> {
    const meta = ctx.metadata as FbMeta;
    if (meta.videoId) {
      // Reel session whose "finish" was never requested: nothing is public yet → safe to resume publish().
      if (meta.reel && !meta.reelFinishRequested) return { kind: 'not_published' };
      return this.videoStatus(meta.videoId, ctx.credentials.accessToken);
    }
    // Feed posts are synchronous: without an id we cannot prove the outcome.
    return { kind: 'failed', code: 'outcome_unknown', message: 'Facebook did not confirm the post before the process stopped. Check the Page before retrying.', category: 'UNKNOWN', retryable: false };
  }

  async updatePublished(ctx: UpdatePublishedContext): Promise<void> {
    const id = ctx.delivery.externalPostId;
    if (!id) throw ProviderError.validation('No published post id');
    const videoId = ctx.delivery.processingMetadata?.videoId as string | undefined;
    if (videoId) await this.graph.post(videoId, ctx.credentials.accessToken, { description: ctx.caption });
    else await this.graph.post(id, ctx.credentials.accessToken, { message: ctx.caption });
  }

  async deletePublished(ctx: Parameters<NonNullable<SocialProvider['deletePublished']>>[0]): Promise<void> {
    if (!ctx.delivery.externalPostId) throw ProviderError.validation('No published post id');
    await this.graph.delete(ctx.delivery.externalPostId, ctx.credentials.accessToken);
  }

  async listPosts(req: ListPostsRequest): Promise<ImportedPost[]> {
    type Attachment = { media_type?: string; media?: { image?: { src?: string }; source?: string }; subattachments?: { data: Attachment[] } };
    type FbPost = { id: string; message?: string; created_time: string; permalink_url?: string; full_picture?: string; attachments?: { data: Attachment[] } };
    const posts = await this.graph.paginate<FbPost>(
      `${req.channel.externalId}/published_posts`,
      req.credentials.accessToken,
      {
        fields: 'id,message,created_time,permalink_url,full_picture,attachments{media_type,media,subattachments}',
        since: Math.floor(req.fromMs / 1000),
        until: Math.floor(req.toMs / 1000),
        limit: 50,
      },
      req.limit,
    );
    return posts.map((p) => {
      const atts = (p.attachments?.data ?? []).flatMap((a) => (a.subattachments?.data?.length ? a.subattachments.data : [a]));
      const media = atts
        .filter((a) => a.media_type === 'photo' || a.media_type === 'video' || a.media_type === 'album')
        .map((a) => ({
          kind: a.media_type === 'video' ? ('video' as const) : ('image' as const),
          // The Pages API returns image sources; video files are not exposed on attachments.
          url: a.media_type === 'video' ? null : (a.media?.image?.src ?? null),
          mimeType: null,
        }));
      const retrievable = media.every((m) => !!m.url);
      return {
        externalPostId: p.id,
        permalink: p.permalink_url ?? null,
        publishedAt: p.created_time,
        text: p.message ?? '',
        mediaType: media.length === 0 ? 'text' : media.some((m) => m.kind === 'video') ? 'video' : media.length > 1 ? 'carousel' : 'image',
        thumbnailUrl: p.full_picture ?? null,
        mediaRetrievable: retrievable,
        mediaNote: retrievable ? null : 'Facebook does not expose the original video file through this API. Upload the original manually.',
        media,
      };
    });
  }
}

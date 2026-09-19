import { mockProviderEnabled } from '../config/env';
import { ProviderRegistry } from './registry';
import { MetaOAuthService } from './meta/metaOAuthService';
import { FacebookProvider } from './facebook/facebookProvider';
import { InstagramProvider } from './instagram/instagramProvider';
import { TikTokOAuthAdapter, TikTokProvider } from './tiktok/tiktokProvider';
import { PinterestOAuthAdapter, PinterestProvider } from './pinterest/pinterestProvider';
import { GoogleOAuthAdapter, YouTubeProvider } from './youtube/youtubeProvider';
import { MockOAuthAdapter, MockProvider } from './mock/mockProvider';

/**
 * Provider registration — the single place where concrete networks are
 * listed on the backend. Adding LinkedIn = one more `register(...)` line
 * (plus its manifest in shared/src/providers). See docs/adding-provider.md.
 */
export function buildRegistry(opts: { allowDevOnly: boolean } = { allowDevOnly: mockProviderEnabled() }): ProviderRegistry {
  const meta = new MetaOAuthService();
  return new ProviderRegistry(opts)
    .register(new FacebookProvider(meta))
    .register(new InstagramProvider(meta))
    .register(new TikTokProvider(new TikTokOAuthAdapter()))
    .register(new PinterestProvider(new PinterestOAuthAdapter()))
    .register(new YouTubeProvider(new GoogleOAuthAdapter()))
    .register(new MockProvider(new MockOAuthAdapter()));
}

let registry: ProviderRegistry | null = null;
export function getRegistry(): ProviderRegistry {
  registry ??= buildRegistry();
  return registry;
}
export function setRegistry(r: ProviderRegistry | null): void {
  registry = r;
}

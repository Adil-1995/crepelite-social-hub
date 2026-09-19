import type { SocialProviderId } from '@shared/index';
import type { OAuthAdapter, SocialProvider } from './types';

/**
 * The only entry point to network-specific code. Callers ask
 * `providerRegistry.get('instagram')` — there is no `if (provider === ...)`
 * anywhere in the core.
 */
export class ProviderRegistry {
  private readonly providers = new Map<SocialProviderId, SocialProvider>();
  private readonly adapters = new Map<string, OAuthAdapter>();

  constructor(private readonly opts: { allowDevOnly: boolean }) {}

  register(provider: SocialProvider): this {
    if (provider.manifest.devOnly && !this.opts.allowDevOnly) return this; // e.g. MockProvider in production
    if (this.providers.has(provider.id)) throw new Error(`Provider "${provider.id}" already registered`);
    if (provider.manifest.id !== provider.id) throw new Error(`Provider "${provider.id}" manifest id mismatch`);
    const existing = this.adapters.get(provider.auth.family);
    if (existing && existing !== provider.auth) throw new Error(`Auth family "${provider.auth.family}" registered with two different adapters`);
    this.providers.set(provider.id, provider);
    this.adapters.set(provider.auth.family, provider.auth);
    return this;
  }

  get(id: SocialProviderId): SocialProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`Provider "${id}" is not registered`);
    return p;
  }

  has(id: SocialProviderId): boolean {
    return this.providers.has(id);
  }

  list(): SocialProvider[] {
    return [...this.providers.values()];
  }

  authAdapter(family: string): OAuthAdapter {
    const a = this.adapters.get(family);
    if (!a) throw new Error(`Auth family "${family}" is not registered`);
    return a;
  }

  authFamilies(): OAuthAdapter[] {
    return [...this.adapters.values()];
  }

  providersForFamily(family: string): SocialProvider[] {
    return this.list().filter((p) => p.auth.family === family);
  }
}

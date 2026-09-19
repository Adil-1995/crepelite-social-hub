import type { AIContentProvider } from './types';
import { OpenAIContentProvider } from './openai/openaiProvider';
import { MockAIContentProvider } from './mock/mockAiProvider';
import { env, isProduction } from '../config/env';

/**
 * Resolves the caption generator.
 *
 * Same shape as the social ProviderRegistry: the callables ask the registry
 * and never name a vendor, so changing model provider is a registration
 * change rather than an edit spread across the backend.
 */
export class AIProviderRegistry {
  private readonly providers = new Map<string, AIContentProvider>();

  constructor(private readonly opts: { allowMock: boolean }) {}

  register(provider: AIContentProvider): this {
    // The mock returns fixed text. Letting it answer in production would put
    // invented captions in front of real customers.
    if (provider.id === 'mock' && !this.opts.allowMock) return this;
    if (this.providers.has(provider.id)) throw new Error(`AI provider "${provider.id}" already registered`);
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): AIContentProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`AI provider "${id}" is not registered`);
    return p;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  list(): AIContentProvider[] {
    return [...this.providers.values()];
  }

  /**
   * The provider to use: the configured one when it is usable, otherwise the
   * first that is, so a missing key degrades to a clear "not configured"
   * rather than a stack trace.
   */
  active(): AIContentProvider | null {
    const preferred = env('AI_PROVIDER', 'openai');
    const chosen = this.providers.get(preferred);
    if (chosen?.isConfigured()) return chosen;
    return this.list().find((p) => p.isConfigured()) ?? null;
  }
}

let registry: AIProviderRegistry | null = null;

export function getAIRegistry(): AIProviderRegistry {
  if (registry) return registry;
  const allowMock = !isProduction() && env('ENABLE_MOCK_AI', 'true') !== 'false';
  registry = new AIProviderRegistry({ allowMock });
  registry.register(new OpenAIContentProvider());
  registry.register(new MockAIContentProvider());
  return registry;
}

/** Tests build their own registry rather than mutating the cached one. */
export function resetAIRegistry(): void {
  registry = null;
}

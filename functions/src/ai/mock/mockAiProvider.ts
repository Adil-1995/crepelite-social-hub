import type { AiCaptionSuggestion, AiPlatformVariant, AiTone } from '@shared/index';
import type { AIContentProvider, AiAdaptOutput, AiCaptionOutput, AiRewriteOutput, AiUsage } from '../types';
import { ProviderError } from '../../providers/errors';

/**
 * Deterministic stand-in for the real model.
 *
 * Tests must never call a paid API: it is slow, costs money, and makes
 * assertions depend on a model's mood. This one returns fixed text and can be
 * told to fail, so every branch the UI handles — success, provider failure,
 * timeout, quota — is reachable without a network.
 *
 * Development only. The registry refuses to serve it in production.
 */
export type MockOutcome = 'success' | 'failure' | 'timeout' | 'rate_limited' | 'unconfigured';

/** Darija samples, so tests assert on the script actually shipping to users. */
const SAMPLES: Record<AiTone, string> = {
  natural: 'هاد الكريب واجد باش يرضي عشاق الشوكولا 😍🍫\nشنو كتفضلو أكثر: الشوكولا ولا الفواكه؟',
  promotional: 'الكريب ديالنا كيتحضر دابا 🔥\nدوزو تشوفو بنفسكم، غادي يعجبكم بزاف!',
  reel: 'واش نتا من عشاق الشوكولا؟ 😍🍫',
  elegant: 'كريب بسيط، ومذاق كيبقى فالبال.',
  brand: 'CrepeLite 🍫 هاد الكريب ديالنا كيجي بنين بزاف!',
};

export class MockAIContentProvider implements AIContentProvider {
  readonly id = 'mock';
  readonly displayName = 'Mock AI';
  readonly model = 'mock-1';

  /** Tests flip this to exercise each failure the UI must survive. */
  static outcome: MockOutcome = 'success';
  /** Every call made, so tests can assert on how the media was passed. */
  static calls: Array<{ action: string; images: number; language: string; tones: string[] }> = [];

  static reset() {
    MockAIContentProvider.outcome = 'success';
    MockAIContentProvider.calls = [];
  }

  isConfigured(): boolean {
    return MockAIContentProvider.outcome !== 'unconfigured';
  }

  missingConfiguration(): string[] {
    return this.isConfigured() ? [] : ['MOCK_AI_KEY (secret)'];
  }

  private guard(): void {
    switch (MockAIContentProvider.outcome) {
      case 'failure':
        throw new ProviderError({ code: 'ai_provider_error', message: 'The model provider returned 500.', category: 'PLATFORM', retryable: true });
      case 'timeout':
        throw new ProviderError({ code: 'ai_timeout', message: 'The model took too long to respond.', category: 'NETWORK', retryable: true });
      case 'rate_limited':
        throw new ProviderError({ code: 'ai_rate_limited', message: 'The model provider is rate limiting us. Try again shortly.', category: 'RATE_LIMIT', retryable: true });
      case 'unconfigured':
        throw ProviderError.config('The mock provider is not configured.');
      default:
    }
  }

  private usage(): AiUsage {
    return { inputTokens: 120, outputTokens: 60, estimatedCostUsd: null };
  }

  async generateCaption(input: Parameters<AIContentProvider['generateCaption']>[0]): Promise<AiCaptionOutput> {
    this.guard();
    const images = input.media?.images.length ?? 0;
    MockAIContentProvider.calls.push({
      action: 'generate',
      images,
      language: input.request.language,
      tones: [...input.tones],
    });

    const suggestions: AiCaptionSuggestion[] = input.tones.map((tone, i) => ({
      id: `s${i + 1}`,
      tone,
      text: SAMPLES[tone] ?? SAMPLES.natural,
      hashtags: input.request.useHashtags ? ['crepelite', 'crepes', 'casablanca'] : [],
    }));

    return {
      suggestions,
      understanding: input.media
        ? {
            summary: 'A chocolate crêpe with strawberries on a plate.',
            subjects: ['crêpe', 'chocolate sauce', 'strawberries'],
            inputType: input.media.type,
            framesAnalysed: images,
          }
        : null,
      usage: this.usage(),
    };
  }

  async rewriteCaption(input: Parameters<AIContentProvider['rewriteCaption']>[0]): Promise<AiRewriteOutput> {
    this.guard();
    MockAIContentProvider.calls.push({ action: 'rewrite', images: 0, language: input.request.language, tones: [input.request.tone] });

    const map: Record<string, string> = {
      shorter: input.text.split('\n')[0] ?? input.text,
      longer: `${input.text}\nوزيد عليها لمسة ديال الفواكه الطازجة.`,
      add_emojis: `${input.text} 😍🍫`,
      remove_emojis: input.text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim(),
      add_cta: `${input.text}\nدوزو تشوفو!`,
    };
    return { text: map[input.instruction] ?? input.text, usage: this.usage() };
  }

  async adaptCaptionToPlatforms(input: Parameters<AIContentProvider['adaptCaptionToPlatforms']>[0]): Promise<AiAdaptOutput> {
    this.guard();
    MockAIContentProvider.calls.push({ action: 'adapt', images: 0, language: input.request.language, tones: [input.request.tone] });

    const variants: AiPlatformVariant[] = input.targets.map((t) => {
      const caps = t.manifest.capabilities.fields;
      return {
        channelId: t.channelId,
        provider: t.manifest.id,
        text: caps.text.supported ? `${input.text} (${t.manifest.displayName})` : '',
        title: caps.title.supported ? `${t.manifest.displayName} title` : '',
        description: caps.description.supported ? `${t.manifest.displayName} description` : '',
        hashtags: caps.hashtags.supported ? ['crepelite'] : [],
      };
    });

    return { variants, usage: this.usage() };
  }
}

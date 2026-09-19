import type {
  AiCaptionSuggestion,
  AiContentSettings,
  AiLanguage,
  AiMediaUnderstanding,
  AiPlatformVariant,
  AiTone,
} from '@shared/index';
import { AI_QUOTA_DEFAULTS } from '@shared/index';
import type {
  AIContentProvider,
  AiAdaptOutput,
  AiCaptionOutput,
  AiMediaInput,
  AiRewriteOutput,
  AiUsage,
} from '../types';
import {
  PLATFORM_STYLE_GUIDE,
  UNDERSTANDING_INSTRUCTION,
  buildCaptionInstruction,
  buildRewriteInstruction,
  buildSystemPrompt,
  describePlatform,
} from '../prompts';
import { OPENAI_API_KEY, env, secretValue } from '../../config/env';
import { ProviderError } from '../../providers/errors';
import { log } from '../../utils/logger';

/**
 * OpenAI-backed caption generation.
 *
 * Uses the HTTP API directly rather than the SDK: one dependency fewer in the
 * functions bundle, and the request shape is visible where it is reviewed.
 *
 * The model id is configuration, not a constant, because vendors retire model
 * names on their own schedule and a hardcoded one turns into an outage.
 */
const API_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * Fallback only. Set OPENAI_MODEL to the vision-capable model you actually
 * want — check the vendor's current lineup rather than trusting this default.
 */
const DEFAULT_MODEL = 'gpt-4o';

interface ChatMessage {
  role: 'system' | 'user';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }>;
}

export class OpenAIContentProvider implements AIContentProvider {
  readonly id = 'openai';
  readonly displayName = 'OpenAI';

  get model(): string {
    return env('OPENAI_MODEL', DEFAULT_MODEL);
  }

  isConfigured(): boolean {
    return this.missingConfiguration().length === 0;
  }

  missingConfiguration(): string[] {
    return secretValue(OPENAI_API_KEY) ? [] : ['OPENAI_API_KEY (secret)'];
  }

  // ── transport ──────────────────────────────────────────────────────────

  private async call(messages: ChatMessage[], maxTokens: number): Promise<{ parsed: unknown; usage: AiUsage }> {
    const key = secretValue(OPENAI_API_KEY);
    if (!key) throw ProviderError.config('OPENAI_API_KEY is not configured');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(env('OPENAI_TIMEOUT_MS', '45000')));

    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.8,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw new ProviderError({ code: 'ai_timeout', message: 'The model took too long to respond.', category: 'NETWORK', retryable: true });
      }
      throw new ProviderError({ code: 'ai_network', message: 'Could not reach the model provider.', category: 'NETWORK', retryable: true });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      // The error body can echo request content — captions, media hints — so
      // only the vendor's short machine code is kept, never the prose.
      let vendorCode: string | null = null;
      let vendorParam: string | null = null;
      let vendorMessage: string | null = null;
      try {
        const parsedBody = JSON.parse(await res.text()) as {
          error?: { code?: string; type?: string; param?: string; message?: string };
        };
        vendorCode = parsedBody.error?.code ?? parsedBody.error?.type ?? null;
        vendorParam = parsedBody.error?.param ?? null;
        // A 400 describes the request shape — a bad model name, an unsupported
        // parameter — and names no user content, so it is safe to keep and is
        // the only thing that makes the failure diagnosable. Other statuses
        // can carry content-policy detail, so their message stays out.
        vendorMessage = res.status === 400 ? (parsedBody.error?.message ?? '').slice(0, 300) : null;
      } catch {
        vendorCode = null;
      }
      log.warn('AI provider rejected the request', {
        status: res.status,
        vendorCode,
        vendorParam,
        vendorMessage,
        model: this.model,
      });
      if (res.status === 429) {
        throw new ProviderError({ code: 'ai_rate_limited', message: 'The model provider is rate limiting us. Try again shortly.', category: 'RATE_LIMIT', retryable: true });
      }
      if (res.status === 401 || res.status === 403) {
        throw ProviderError.config('The model provider rejected the API key.');
      }
      throw new ProviderError({
        code: 'ai_provider_error',
        message: `The model provider returned ${res.status}.`,
        category: 'PLATFORM',
        retryable: res.status >= 500,
        httpStatus: res.status,
      });
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new ProviderError({ code: 'ai_empty', message: 'The model returned nothing.', category: 'PLATFORM', retryable: true });

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ProviderError({ code: 'ai_bad_json', message: 'The model returned malformed output.', category: 'PLATFORM', retryable: true });
    }

    return { parsed, usage: this.usageFrom(json.usage) };
  }

  /**
   * Token counts come from the provider; the money figure only appears when
   * rates are configured, because a made-up number is worse than none.
   */
  private usageFrom(u?: { prompt_tokens?: number; completion_tokens?: number }): AiUsage {
    const inputTokens = u?.prompt_tokens ?? null;
    const outputTokens = u?.completion_tokens ?? null;
    const inRate = Number(env('OPENAI_INPUT_USD_PER_MTOK', ''));
    const outRate = Number(env('OPENAI_OUTPUT_USD_PER_MTOK', ''));

    const ratesKnown = Number.isFinite(inRate) && Number.isFinite(outRate) && inRate > 0 && outRate > 0;
    const estimatedCostUsd =
      ratesKnown && inputTokens != null && outputTokens != null
        ? (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate
        : null;

    return { inputTokens, outputTokens, estimatedCostUsd };
  }

  private mediaParts(media: AiMediaInput | null): ChatMessage['content'] {
    if (!media || !media.images.length) return [];
    return media.images.slice(0, AI_QUOTA_DEFAULTS.maxVideoFrames + 1).map((img) => ({
      type: 'image_url' as const,
      // `low` detail is enough to identify a dessert and its toppings, and
      // costs a fraction of `high`.
      image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'low' as const },
    }));
  }

  // ── generation ─────────────────────────────────────────────────────────

  async generateCaption(input: {
    request: Parameters<AIContentProvider['generateCaption']>[0]['request'];
    settings: AiContentSettings;
    media: AiMediaInput | null;
    tones: readonly AiTone[];
  }): Promise<AiCaptionOutput> {
    const { request, settings, media, tones } = input;
    const hasMedia = !!media?.images.length;

    const schema = `
Reply with JSON only, in exactly this shape:
{
  "understanding": { "summary": string, "subjects": string[] },
  "captions": [ { "tone": string, "text": string, "hashtags": string[] } ]
}
Produce exactly ${tones.length} caption${tones.length === 1 ? '' : 's'}, one per requested tone, in this order: ${tones.join(', ')}.`.trim();

    const userParts: ChatMessage['content'] = [
      { type: 'text', text: buildCaptionInstruction(request, settings, hasMedia) },
      ...(hasMedia ? [{ type: 'text' as const, text: UNDERSTANDING_INSTRUCTION }] : []),
      ...(media?.hints.length ? [{ type: 'text' as const, text: `Media details: ${media.hints.join('; ')}` }] : []),
      ...(this.mediaParts(media) as Array<{ type: 'image_url'; image_url: { url: string; detail?: 'low' } }>),
      { type: 'text', text: schema },
    ];

    const { parsed, usage } = await this.call(
      [
        { role: 'system', content: buildSystemPrompt(settings, request.language, tones[0] ?? request.tone) },
        { role: 'user', content: userParts },
      ],
      400 * tones.length + 300,
    );

    const out = parsed as {
      understanding?: { summary?: string; subjects?: string[] };
      captions?: Array<{ tone?: string; text?: string; hashtags?: string[] }>;
    };

    const suggestions: AiCaptionSuggestion[] = (out.captions ?? [])
      .filter((c) => typeof c.text === 'string' && c.text.trim())
      .slice(0, tones.length)
      .map((c, i) => ({
        id: `s${i + 1}`,
        tone: (tones[i] ?? request.tone) as AiTone,
        text: String(c.text).trim(),
        hashtags: (c.hashtags ?? []).map((h) => String(h).replace(/^#+/, '').trim()).filter(Boolean).slice(0, 10),
      }));

    if (!suggestions.length) {
      throw new ProviderError({ code: 'ai_no_captions', message: 'The model did not return a usable caption.', category: 'PLATFORM', retryable: true });
    }

    const understanding: AiMediaUnderstanding | null = hasMedia
      ? {
          summary: String(out.understanding?.summary ?? '').trim(),
          subjects: (out.understanding?.subjects ?? []).map(String).filter(Boolean).slice(0, 12),
          inputType: media!.type,
          framesAnalysed: media!.images.length,
        }
      : null;

    return { suggestions, understanding, usage };
  }

  async rewriteCaption(input: {
    text: string;
    instruction: Parameters<AIContentProvider['rewriteCaption']>[0]['instruction'];
    settings: AiContentSettings;
    request: { language: AiLanguage; tone: AiTone };
  }): Promise<AiRewriteOutput> {
    const { parsed, usage } = await this.call(
      [
        { role: 'system', content: buildSystemPrompt(input.settings, input.request.language, input.request.tone) },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Here is an existing caption:\n"""${input.text}"""` },
            { type: 'text', text: buildRewriteInstruction(input.instruction) },
            { type: 'text', text: 'Reply with JSON only: { "text": string }. Keep the same language and script.' },
          ],
        },
      ],
      800,
    );

    const text = String((parsed as { text?: string }).text ?? '').trim();
    if (!text) throw new ProviderError({ code: 'ai_no_text', message: 'The model returned nothing usable.', category: 'PLATFORM', retryable: true });
    return { text, usage };
  }

  async adaptCaptionToPlatforms(input: Parameters<AIContentProvider['adaptCaptionToPlatforms']>[0]): Promise<AiAdaptOutput> {
    const { text, settings, request, targets } = input;

    const platformSpec = targets
      .map((t, i) => `[${i}] ${describePlatform(t.manifest, t.channel.name)}`)
      .join('\n\n');

    const { parsed, usage } = await this.call(
      [
        { role: 'system', content: buildSystemPrompt(settings, request.language, request.tone) },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Adapt this caption for each destination:\n"""${text}"""` },
            { type: 'text', text: PLATFORM_STYLE_GUIDE },
            { type: 'text', text: `Destinations:\n${platformSpec}` },
            {
              type: 'text',
              text: `${request.useEmojis ? 'Emojis are welcome.' : 'No emojis.'} ${
                request.useHashtags ? 'Return hashtags without the # sign.' : 'Return empty hashtag arrays.'
              }\nReply with JSON only: { "variants": [ { "index": number, "text": string, "title": string, "description": string, "hashtags": string[] } ] } — one entry per destination index, respecting each one's supported fields and limits.`,
            },
          ],
        },
      ],
      500 * targets.length + 300,
    );

    const raw = (parsed as { variants?: Array<{ index?: number; text?: string; title?: string; description?: string; hashtags?: string[] }> }).variants ?? [];

    const variants: AiPlatformVariant[] = targets.map((t, i) => {
      const found = raw.find((v) => Number(v.index) === i) ?? raw[i];
      const caps = t.manifest.capabilities.fields;
      return {
        channelId: t.channelId,
        provider: t.manifest.id,
        text: caps.text.supported ? String(found?.text ?? text).trim() : '',
        title: caps.title.supported ? String(found?.title ?? '').trim() : '',
        description: caps.description.supported ? String(found?.description ?? '').trim() : '',
        hashtags: caps.hashtags.supported
          ? (found?.hashtags ?? []).map((h) => String(h).replace(/^#+/, '').trim()).filter(Boolean).slice(0, caps.hashtags.max ?? 10)
          : [],
      };
    });

    return { variants, usage };
  }
}

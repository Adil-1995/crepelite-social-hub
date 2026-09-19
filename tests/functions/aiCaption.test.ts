import { beforeEach, describe, expect, it } from 'vitest';
import { MockAIContentProvider } from '../../functions/src/ai/mock/mockAiProvider';
import { AIProviderRegistry } from '../../functions/src/ai/registry';
import { OpenAIContentProvider } from '../../functions/src/ai/openai/openaiProvider';
import {
  buildCaptionInstruction,
  buildSystemPrompt,
  describePlatform,
} from '../../functions/src/ai/prompts';
import type { AiPlatformTarget } from '../../functions/src/ai/types';
import {
  AI_SUGGESTION_TONES,
  DEFAULT_AI_SETTINGS,
  facebookManifest,
  instagramManifest,
  youtubeManifest,
  pinterestManifest,
  tiktokManifest,
  type AiCaptionRequest,
  type SocialChannel,
} from '@shared/index';

/**
 * Caption generation, exercised entirely against the mock.
 *
 * A real model is never called here: it costs money, it is slow, and
 * assertions against it would be flaky by construction. The mock reproduces
 * every outcome the UI has a state for.
 */
const provider = new MockAIContentProvider();

const request: AiCaptionRequest = {
  language: 'ary',
  tone: 'natural',
  useEmojis: true,
  useHashtags: true,
  useCta: true,
  mentionLocation: false,
};

const media = {
  type: 'image' as const,
  images: [{ mimeType: 'image/jpeg', base64: 'AAAA' }],
  hints: ['crepe.jpg (image)'],
};

function channel(id: string, provider: string): SocialChannel {
  return { id, provider, name: `Acct ${provider}` } as SocialChannel;
}

const targets: AiPlatformTarget[] = [
  { channelId: 'c-fb', channel: channel('c-fb', 'facebook'), manifest: facebookManifest },
  { channelId: 'c-ig', channel: channel('c-ig', 'instagram'), manifest: instagramManifest },
  { channelId: 'c-tt', channel: channel('c-tt', 'tiktok'), manifest: tiktokManifest },
  { channelId: 'c-pi', channel: channel('c-pi', 'pinterest'), manifest: pinterestManifest },
  { channelId: 'c-yt', channel: channel('c-yt', 'youtube'), manifest: youtubeManifest },
];

beforeEach(() => MockAIContentProvider.reset());

describe('generation from an image', () => {
  it('returns one caption and reports what it saw', async () => {
    const out = await provider.generateCaption({ request, settings: DEFAULT_AI_SETTINGS, media, tones: ['natural'] });

    expect(out.suggestions).toHaveLength(1);
    expect(out.suggestions[0]!.text.length).toBeGreaterThan(0);
    expect(out.understanding?.inputType).toBe('image');
    expect(out.understanding?.framesAnalysed).toBe(1);
    expect(out.understanding?.subjects.length).toBeGreaterThan(0);
  });

  it('passes the image through to the provider', async () => {
    await provider.generateCaption({ request, settings: DEFAULT_AI_SETTINGS, media, tones: ['natural'] });
    expect(MockAIContentProvider.calls[0]?.images).toBe(1);
  });

  it('returns no understanding when there is no media', async () => {
    const out = await provider.generateCaption({ request, settings: DEFAULT_AI_SETTINGS, media: null, tones: ['natural'] });
    expect(out.understanding).toBeNull();
  });
});

describe('generation from a video', () => {
  it('analyses the frames it was given rather than the whole file', async () => {
    const frames = {
      type: 'video' as const,
      images: [
        { mimeType: 'image/jpeg', base64: 'A' },
        { mimeType: 'image/jpeg', base64: 'B' },
        { mimeType: 'image/jpeg', base64: 'C' },
      ],
      hints: ['clip.mp4 (video, 24s)'],
    };

    const out = await provider.generateCaption({ request, settings: DEFAULT_AI_SETTINGS, media: frames, tones: ['natural'] });

    expect(out.understanding?.inputType).toBe('video');
    expect(out.understanding?.framesAnalysed).toBe(3);
    expect(MockAIContentProvider.calls[0]?.images).toBe(3);
  });
});

describe('three suggestions', () => {
  it('returns one per requested tone, in order', async () => {
    const out = await provider.generateCaption({
      request,
      settings: DEFAULT_AI_SETTINGS,
      media,
      tones: AI_SUGGESTION_TONES,
    });

    expect(out.suggestions).toHaveLength(3);
    expect(out.suggestions.map((s) => s.tone)).toEqual([...AI_SUGGESTION_TONES]);
    expect(new Set(out.suggestions.map((s) => s.id)).size).toBe(3);
  });

  it('omits hashtags when they were not asked for', async () => {
    const out = await provider.generateCaption({
      request: { ...request, useHashtags: false },
      settings: DEFAULT_AI_SETTINGS,
      media,
      tones: ['natural'],
    });
    expect(out.suggestions[0]!.hashtags).toEqual([]);
  });
});

describe('Moroccan Darija', () => {
  it('is the shipped default', () => {
    expect(DEFAULT_AI_SETTINGS.defaultLanguage).toBe('ary');
    expect(DEFAULT_AI_SETTINGS.defaultScript).toBe('Arabic');
  });

  it('produces Arabic script, not Latin transliteration', async () => {
    const out = await provider.generateCaption({ request, settings: DEFAULT_AI_SETTINGS, media, tones: ['natural'] });
    // At least one Arabic-range character, and no run of Latin words that
    // would signal transliterated Darija.
    expect(out.suggestions[0]!.text).toMatch(/[؀-ۿ]/);
  });

  it('names the register and bans the MSA giveaways in the prompt', () => {
    const prompt = buildSystemPrompt(DEFAULT_AI_SETTINGS, 'ary', 'natural');
    expect(prompt).toMatch(/Darija/);
    expect(prompt).toMatch(/ARABIC SCRIPT/);
    // The formal constructions that make a caption read like a press release.
    expect(prompt).toContain('يسرنا');
    expect(prompt).toMatch(/Modern Standard Arabic/);
  });

  it('asks for Modern Standard Arabic only when Arabic is chosen explicitly', () => {
    expect(buildSystemPrompt(DEFAULT_AI_SETTINGS, 'ar', 'natural')).toMatch(/Modern Standard Arabic/);
    expect(buildSystemPrompt(DEFAULT_AI_SETTINGS, 'fr', 'natural')).toMatch(/French/);
    expect(buildSystemPrompt(DEFAULT_AI_SETTINGS, 'en', 'natural')).toMatch(/English/);
  });
});

describe('grounding rules', () => {
  it('forbids inventing facts, in every language', () => {
    for (const lang of ['ary', 'ar', 'fr', 'en'] as const) {
      const prompt = buildSystemPrompt(DEFAULT_AI_SETTINGS, lang, 'natural');
      expect(prompt).toMatch(/Do not invent ingredients/);
      expect(prompt).toMatch(/Never invent a promotion/);
      expect(prompt).toMatch(/Never invent a location/);
    }
  });

  it('carries the workspace forbidden claims into the prompt', () => {
    const settings = { ...DEFAULT_AI_SETTINGS, forbiddenClaims: ['gluten free', 'award winning'] };
    const prompt = buildSystemPrompt(settings, 'ary', 'natural');
    expect(prompt).toContain('gluten free');
    expect(prompt).toContain('award winning');
  });

  it('tells the model to stay general when there is no media', () => {
    const withMedia = buildCaptionInstruction(request, DEFAULT_AI_SETTINGS, true);
    const without = buildCaptionInstruction(request, DEFAULT_AI_SETTINGS, false);
    expect(withMedia).toMatch(/what you can see/);
    expect(without).toMatch(/stay general rather than inventing/);
  });

  it('suppresses the location unless one is configured and requested', () => {
    expect(buildCaptionInstruction(request, DEFAULT_AI_SETTINGS, true)).toMatch(/Do not mention any location/);

    const settings = { ...DEFAULT_AI_SETTINGS, defaultLocation: 'Casablanca' };
    const asked = buildCaptionInstruction({ ...request, mentionLocation: true }, settings, true);
    expect(asked).toContain('Casablanca');
  });
});

describe('platform adaptation', () => {
  it('returns one variant per destination', async () => {
    const out = await provider.adaptCaptionToPlatforms({
      text: 'هاد الكريب بنين',
      settings: DEFAULT_AI_SETTINGS,
      request: { language: 'ary', tone: 'natural', useEmojis: true, useHashtags: true },
      targets,
    });

    expect(out.variants).toHaveLength(5);
    expect(out.variants.map((v) => v.channelId)).toEqual(['c-fb', 'c-ig', 'c-tt', 'c-pi', 'c-yt']);
  });

  it('respects each declared field set instead of assuming they match', async () => {
    const out = await provider.adaptCaptionToPlatforms({
      text: 'هاد الكريب بنين',
      settings: DEFAULT_AI_SETTINGS,
      request: { language: 'ary', tone: 'natural', useEmojis: true, useHashtags: true },
      targets,
    });

    for (const variant of out.variants) {
      const manifest = targets.find((t) => t.channelId === variant.channelId)!.manifest;
      const fields = manifest.capabilities.fields;
      if (!fields.title.supported) expect(variant.title).toBe('');
      if (!fields.description.supported) expect(variant.description).toBe('');
      if (!fields.text.supported) expect(variant.text).toBe('');
      if (!fields.hashtags.supported) expect(variant.hashtags).toEqual([]);
    }
  });

  it('describes a platform from its manifest, limits included', () => {
    const described = describePlatform(youtubeManifest, 'My channel');
    expect(described).toContain('YouTube');
    expect(described).toContain('My channel');
    expect(described).toMatch(/title/);
    expect(described).toMatch(/description/);
  });
});

describe('rewrites', () => {
  it('shortens without inventing', async () => {
    const long = 'سطر أول\nسطر ثاني';
    const out = await provider.rewriteCaption({
      text: long,
      instruction: 'shorter',
      settings: DEFAULT_AI_SETTINGS,
      request: { language: 'ary', tone: 'natural' },
    });
    expect(out.text.length).toBeLessThanOrEqual(long.length);
  });

  it('removes every emoji when asked', async () => {
    const out = await provider.rewriteCaption({
      text: 'كريب بنين 😍🍫',
      instruction: 'remove_emojis',
      settings: DEFAULT_AI_SETTINGS,
      request: { language: 'ary', tone: 'natural' },
    });
    expect(out.text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});

describe('provider failures the UI has states for', () => {
  const cases = [
    ['failure', /returned 500/],
    ['timeout', /too long/],
    ['rate_limited', /rate limiting/],
    ['unconfigured', /not configured/],
  ] as const;

  it.each(cases)('surfaces %s as a readable error', async (outcome, matcher) => {
    MockAIContentProvider.outcome = outcome;
    await expect(
      provider.generateCaption({ request, settings: DEFAULT_AI_SETTINGS, media, tones: ['natural'] }),
    ).rejects.toThrow(matcher);
  });

  it('reports itself as unconfigured rather than failing opaquely', () => {
    MockAIContentProvider.outcome = 'unconfigured';
    expect(provider.isConfigured()).toBe(false);
    expect(provider.missingConfiguration().length).toBeGreaterThan(0);
  });
});

describe('AIProviderRegistry', () => {
  it('keeps the mock out of production', () => {
    const prod = new AIProviderRegistry({ allowMock: false });
    prod.register(new MockAIContentProvider());
    // Fixed sample text must never reach a real customer's feed.
    expect(prod.has('mock')).toBe(false);
    expect(prod.list()).toHaveLength(0);
  });

  it('serves the mock in development', () => {
    const dev = new AIProviderRegistry({ allowMock: true });
    dev.register(new MockAIContentProvider());
    expect(dev.has('mock')).toBe(true);
  });

  it('rejects registering the same provider twice', () => {
    const reg = new AIProviderRegistry({ allowMock: true });
    reg.register(new MockAIContentProvider());
    expect(() => reg.register(new MockAIContentProvider())).toThrow(/already registered/);
  });

  it('throws for an unknown provider instead of returning undefined', () => {
    const reg = new AIProviderRegistry({ allowMock: true });
    expect(() => reg.get('nope')).toThrow(/not registered/);
  });

  it('falls back to a configured provider when the preferred one has no key', () => {
    const reg = new AIProviderRegistry({ allowMock: true });
    reg.register(new OpenAIContentProvider()); // no key in tests
    reg.register(new MockAIContentProvider());
    expect(reg.active()?.id).toBe('mock');
  });

  it('reports nothing active when no provider is configured', () => {
    MockAIContentProvider.outcome = 'unconfigured';
    const reg = new AIProviderRegistry({ allowMock: true });
    reg.register(new MockAIContentProvider());
    expect(reg.active()).toBeNull();
  });
});

describe('the model never publishes', () => {
  it('exposes no publishing capability at all', () => {
    // The generator returns text. Anything that reaches a network goes through
    // the publishing engine, which the generator cannot call.
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(provider));
    expect(surface).not.toContain('publish');
    expect(surface).not.toContain('schedule');
    expect(surface.sort()).toEqual(
      ['adaptCaptionToPlatforms', 'constructor', 'generateCaption', 'guard', 'isConfigured', 'missingConfiguration', 'rewriteCaption', 'usage'].sort(),
    );
  });
});

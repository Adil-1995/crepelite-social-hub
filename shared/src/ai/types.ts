import type { SocialProviderId, Ts } from '../domain/types';

/**
 * AI caption generation — shared contract.
 *
 * The PWA renders the generator from these types and the backend validates
 * against the same schemas, so the two cannot drift.
 */

/**
 * Languages the generator writes in.
 *
 * `ary` is the ISO 639-3 code for Moroccan Arabic (Darija) and is kept
 * separate from `ar` on purpose: Darija written in Arabic script is a
 * different register from Modern Standard Arabic, and asking for "Arabic"
 * reliably produces MSA, which reads stiff and corporate in a dessert shop's
 * social feed.
 */
export const AI_LANGUAGES = [
  { value: 'ary', label: 'الدارجة المغربية', script: 'Arabic', rtl: true },
  { value: 'ar', label: 'العربية', script: 'Arabic', rtl: true },
  { value: 'fr', label: 'Français', script: 'Latin', rtl: false },
  { value: 'en', label: 'English', script: 'Latin', rtl: false },
] as const;

export type AiLanguage = (typeof AI_LANGUAGES)[number]['value'];

export const AI_LANGUAGE_IDS = AI_LANGUAGES.map((l) => l.value) as readonly AiLanguage[];

export function isRtl(language: AiLanguage): boolean {
  return AI_LANGUAGES.find((l) => l.value === language)?.rtl ?? false;
}

/** Writing registers offered in the generator. */
export const AI_TONES = [
  { value: 'natural', label: 'طبيعي', labelLatin: 'Natural' },
  { value: 'promotional', label: 'ترويجي', labelLatin: 'Promotional' },
  { value: 'reel', label: 'قصير للريلز', labelLatin: 'Short / Reels' },
  { value: 'elegant', label: 'أنيق', labelLatin: 'Elegant' },
  { value: 'brand', label: 'CrepeLite', labelLatin: 'Brand voice' },
] as const;

export type AiTone = (typeof AI_TONES)[number]['value'];
export const AI_TONE_IDS = AI_TONES.map((t) => t.value) as readonly AiTone[];

/** The three variations produced when asking for a set of suggestions. */
export const AI_SUGGESTION_TONES: readonly AiTone[] = ['natural', 'promotional', 'reel'];

/** Follow-up edits offered on a generated caption. */
export const AI_REWRITES = [
  { value: 'shorter', label: 'Shorter' },
  { value: 'longer', label: 'Longer' },
  { value: 'more_promotional', label: 'More promotional' },
  { value: 'more_natural', label: 'More natural' },
  { value: 'add_emojis', label: 'Add emojis' },
  { value: 'remove_emojis', label: 'Remove emojis' },
  { value: 'add_cta', label: 'Add a call to action' },
] as const;

export type AiRewrite = (typeof AI_REWRITES)[number]['value'];
export const AI_REWRITE_IDS = AI_REWRITES.map((r) => r.value) as readonly AiRewrite[];

// ---------------------------------------------------------------------------
// Workspace settings
// ---------------------------------------------------------------------------

/**
 * Per-workspace generator defaults. Editable in Settings → AI content, so the
 * brand voice is configuration rather than something baked into the code.
 */
export interface AiContentSettings {
  defaultLanguage: AiLanguage;
  /** Derived from the language, stored so a future language can override it. */
  defaultScript: 'Arabic' | 'Latin';
  defaultTone: AiTone;
  useEmojis: boolean;
  useHashtags: boolean;
  useCta: boolean;
  mentionLocation: boolean;
  /** What the business is, in the workspace's own words. Steers every prompt. */
  brandContext: string;
  /** Claims the model must never make — prices, health claims, awards. */
  forbiddenClaims: string[];
  defaultLocation: string;
  defaultHashtags: string[];
  enabled: boolean;
}

export const DEFAULT_AI_SETTINGS: AiContentSettings = {
  defaultLanguage: 'ary',
  defaultScript: 'Arabic',
  defaultTone: 'natural',
  useEmojis: true,
  useHashtags: true,
  useCta: true,
  mentionLocation: false,
  brandContext:
    'CrepeLite is a crêperie and dessert shop. The voice is young, warm and local — the way a friend would recommend the place, not the way a brochure would describe it.',
  forbiddenClaims: [],
  defaultLocation: '',
  defaultHashtags: [],
  enabled: true,
};

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export type AiInputType = 'image' | 'video' | 'text';

export interface AiCaptionRequest {
  language: AiLanguage;
  tone: AiTone;
  useEmojis: boolean;
  useHashtags: boolean;
  useCta: boolean;
  mentionLocation: boolean;
  /** Existing caption, when rewriting rather than generating from scratch. */
  seedText?: string;
}

export interface AiCaptionSuggestion {
  id: string;
  tone: AiTone;
  text: string;
  hashtags: string[];
}

/** What the model understood from the media, surfaced so the user can judge it. */
export interface AiMediaUnderstanding {
  summary: string;
  /** Concrete things seen: "chocolate sauce", "strawberries", "counter". */
  subjects: string[];
  inputType: AiInputType;
  /** Frames actually analysed, for video. */
  framesAnalysed: number;
}

export interface AiCaptionResult {
  suggestions: AiCaptionSuggestion[];
  understanding: AiMediaUnderstanding | null;
  provider: string;
  model: string;
}

/** One caption tailored to a network, respecting that network's fields. */
export interface AiPlatformVariant {
  channelId: string;
  provider: SocialProviderId;
  text: string;
  title: string;
  description: string;
  hashtags: string[];
}

// ---------------------------------------------------------------------------
// Usage log
// ---------------------------------------------------------------------------

export type AiAction = 'generate' | 'adapt' | 'rewrite';

/** One row per model call, for cost visibility and auditing. Never secrets. */
export interface AiGeneration {
  id: string;
  workspaceId: string;
  postId: string | null;
  mediaIds: string[];
  userId: string;
  action: AiAction;
  language: AiLanguage;
  tone: AiTone;
  provider: string;
  model: string;
  inputType: AiInputType;
  /** The suggestions returned, so a later "why did it say that" is answerable. */
  generatedText: string[];
  accepted: boolean;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  estimatedCostUsd: number | null;
  createdAt: Ts;
}

// ---------------------------------------------------------------------------
// Quotas
// ---------------------------------------------------------------------------

/**
 * Generation is the only feature that costs money per click, so it is capped
 * per workspace. These are defaults; deployment can override them.
 */
export const AI_QUOTA_DEFAULTS = {
  perDay: 100,
  perHour: 30,
  /** Largest image sent to the model, after downscaling. */
  maxImageBytes: 4 * 1024 * 1024,
  /** Frames pulled from a video. Three covers start, middle and end. */
  maxVideoFrames: 3,
  maxSuggestions: 3,
} as const;

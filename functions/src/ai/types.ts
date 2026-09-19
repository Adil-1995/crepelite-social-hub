import type {
  AiCaptionRequest,
  AiCaptionSuggestion,
  AiContentSettings,
  AiInputType,
  AiMediaUnderstanding,
  AiPlatformVariant,
  AiRewrite,
  ProviderManifest,
  SocialChannel,
} from '@shared/index';

/**
 * The only entry point to model-specific code.
 *
 * Mirrors the SocialProvider arrangement: the app talks to this interface and
 * a registry resolves the implementation, so swapping model vendor is a
 * registration change rather than an edit across the codebase.
 */

/** Media handed to the model, already fetched and bounded by the caller. */
export interface AiMediaInput {
  type: AiInputType;
  /** Base64 image payloads. One for a photo, a handful of frames for a video. */
  images: Array<{ mimeType: string; base64: string }>;
  /** Filenames and durations give the model harmless extra context. */
  hints: string[];
}

export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
}

export interface AiCaptionOutput {
  suggestions: AiCaptionSuggestion[];
  understanding: AiMediaUnderstanding | null;
  usage: AiUsage;
}

export interface AiRewriteOutput {
  text: string;
  usage: AiUsage;
}

export interface AiAdaptOutput {
  variants: AiPlatformVariant[];
  usage: AiUsage;
}

/** A destination described for the model, built from its manifest. */
export interface AiPlatformTarget {
  channelId: string;
  channel: SocialChannel;
  manifest: ProviderManifest;
}

export interface AIContentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly model: string;

  isConfigured(): boolean;
  missingConfiguration(): string[];

  /**
   * Generates captions. When `media` is present the provider must ground the
   * text in what it actually sees; inventing ingredients or promotions is a
   * correctness failure, not a style one.
   */
  generateCaption(input: {
    request: AiCaptionRequest;
    settings: AiContentSettings;
    media: AiMediaInput | null;
    /** How many suggestions, and in which registers. */
    tones: readonly AiCaptionRequest['tone'][];
  }): Promise<AiCaptionOutput>;

  rewriteCaption(input: {
    text: string;
    instruction: AiRewrite;
    settings: AiContentSettings;
    request: Pick<AiCaptionRequest, 'language' | 'tone'>;
  }): Promise<AiRewriteOutput>;

  /** One variant per target, shaped by each network's declared capabilities. */
  adaptCaptionToPlatforms(input: {
    text: string;
    settings: AiContentSettings;
    request: Pick<AiCaptionRequest, 'language' | 'tone' | 'useEmojis' | 'useHashtags'>;
    targets: AiPlatformTarget[];
  }): Promise<AiAdaptOutput>;
}

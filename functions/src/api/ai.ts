import { FieldValue } from 'firebase-admin/firestore';
import {
  AI_QUOTA_DEFAULTS,
  AI_SUGGESTION_TONES,
  DEFAULT_AI_SETTINGS,
  aiAdaptSchema,
  aiGenerateSchema,
  aiMarkAcceptedSchema,
  aiRewriteSchema,
  aiSettingsSchema,
  workspaceRef,
  type AiAction,
  type AiContentSettings,
  type AiInputType,
  type AiLanguage,
  type AiTone,
  type MediaAsset,
  type SocialChannel,
} from '@shared/index';
import { callable } from './callable';
import { requirePermission } from '../auth/access';
import { db, newId, paths } from '../utils/firestore';
import { fail } from '../utils/errors';
import { log } from '../utils/logger';
import { AI_SECRETS } from '../config/env';
import { getAIRegistry } from '../ai/registry';
import { consumeAiQuota, readAiQuota } from '../ai/quota';
import type { AiMediaInput, AiPlatformTarget } from '../ai/types';
import { bucket, loadMediaAssets } from '../services/media';
import { audit, userActor } from '../services/audit';
import { createManifestCatalog } from '@shared/index';
import { mockProviderEnabled } from '../config/env';

/**
 * AI caption generation.
 *
 * Every model call happens here. The API key is bound to these callables only
 * and never leaves the backend; media is read with the admin SDK straight from
 * Storage, so nothing is made public to let a model see it.
 */

const SETTINGS_DOC = 'aiContent';

function settingsRef(workspaceId: string) {
  return db().doc(`${paths.workspace(workspaceId)}/settings/${SETTINGS_DOC}`);
}

async function loadSettings(workspaceId: string): Promise<AiContentSettings> {
  const snap = await settingsRef(workspaceId).get();
  return { ...DEFAULT_AI_SETTINGS, ...((snap.data() as Partial<AiContentSettings> | undefined) ?? {}) };
}

function scriptFor(language: AiLanguage): 'Arabic' | 'Latin' {
  return language === 'ary' || language === 'ar' ? 'Arabic' : 'Latin';
}

/**
 * Reads media for the model.
 *
 * Images come straight out of Storage with the admin SDK — no signed URL, no
 * public object, nothing that outlives the request. Video frames arrive from
 * the browser, which already has the file decoded; Cloud Functions have no
 * ffmpeg, and shipping a whole video anywhere to read three frames would be
 * both slow and expensive.
 */
async function buildMediaInput(
  workspaceId: string,
  mediaIds: string[],
  frames: string[],
): Promise<AiMediaInput | null> {
  if (!mediaIds.length && !frames.length) return null;

  const images: AiMediaInput['images'] = [];
  const hints: string[] = [];
  let type: AiInputType = 'text';

  let assets: MediaAsset[] = [];
  if (mediaIds.length) {
    assets = await loadMediaAssets(workspaceId, mediaIds.slice(0, 4));
  }

  for (const asset of assets) {
    hints.push(`${asset.fileName} (${asset.kind}${asset.durationSec ? `, ${Math.round(asset.durationSec)}s` : ''})`);
    if (asset.kind === 'video') {
      type = 'video';
      continue; // frames for video come from the browser
    }
    type = type === 'video' ? 'video' : 'image';

    if (asset.size > AI_QUOTA_DEFAULTS.maxImageBytes) {
      hints.push(`${asset.fileName} was too large to analyse`);
      continue;
    }
    try {
      const [buf] = await bucket().file(asset.storagePath).download();
      images.push({ mimeType: asset.mimeType, base64: buf.toString('base64') });
    } catch (e) {
      log.warn('could not read media for analysis', { mediaId: asset.id, error: (e as Error).message });
    }
  }

  for (const frame of frames.slice(0, AI_QUOTA_DEFAULTS.maxVideoFrames)) {
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(frame);
    if (!match) continue;
    images.push({ mimeType: match[1]!, base64: match[2]! });
    type = 'video';
  }

  if (!images.length) return type === 'text' ? null : { type, images: [], hints };
  return { type, images, hints };
}

/** One row per model call. Never secrets, never the media itself. */
async function recordGeneration(input: {
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
  generatedText: string[];
  usage: { inputTokens: number | null; outputTokens: number | null; estimatedCostUsd: number | null };
}): Promise<string> {
  const id = newId();
  await db()
    .doc(`${paths.workspace(input.workspaceId)}/aiGenerations/${id}`)
    .set({
      id,
      workspaceId: input.workspaceId,
      postId: input.postId,
      mediaIds: input.mediaIds,
      userId: input.userId,
      action: input.action,
      language: input.language,
      tone: input.tone,
      provider: input.provider,
      model: input.model,
      inputType: input.inputType,
      generatedText: input.generatedText,
      accepted: false,
      usage: { inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens },
      estimatedCostUsd: input.usage.estimatedCostUsd,
      createdAt: FieldValue.serverTimestamp(),
    });
  return id;
}

function activeProvider() {
  const provider = getAIRegistry().active();
  if (!provider) {
    fail('failed-precondition', 'AI caption generation is not configured for this deployment.', {
      reason: 'ai_not_configured',
      missing: getAIRegistry().list().flatMap((p) => p.missingConfiguration()),
    });
  }
  return provider;
}

// ── status ────────────────────────────────────────────────────────────────

export const getAiStatusFn = callable(
  workspaceRef,
  async (data, req) => {
    await requirePermission(req, data.workspaceId, 'workspace.read');
    const registry = getAIRegistry();
    const provider = registry.active();
    const [settings, quota] = await Promise.all([loadSettings(data.workspaceId), readAiQuota(data.workspaceId)]);

    return {
      configured: !!provider,
      provider: provider?.id ?? null,
      model: provider?.model ?? null,
      missing: provider ? [] : registry.list().flatMap((p) => p.missingConfiguration()),
      settings,
      quota,
    };
  },
  { secrets: AI_SECRETS },
);

// ── generate ──────────────────────────────────────────────────────────────

export const generateCaptionFn = callable(
  aiGenerateSchema,
  async (data, req) => {
    const actor = await requirePermission(req, data.workspaceId, 'content.write');
    const settings = await loadSettings(data.workspaceId);
    if (!settings.enabled) fail('failed-precondition', 'AI generation is switched off for this workspace.', { reason: 'ai_disabled' });

    const provider = activeProvider();

    // Reserved before the call: a request that fails partway still burned
    // provider tokens, so it still has to count.
    const quota = await consumeAiQuota(data.workspaceId);

    const media = await buildMediaInput(data.workspaceId, data.mediaIds, data.frames);
    const tones: AiTone[] = data.count === 3 ? [...AI_SUGGESTION_TONES] : [data.tone];

    const result = await provider.generateCaption({
      request: {
        language: data.language,
        tone: data.tone,
        useEmojis: data.useEmojis,
        useHashtags: data.useHashtags,
        useCta: data.useCta,
        mentionLocation: data.mentionLocation,
        ...(data.seedText ? { seedText: data.seedText } : {}),
      },
      settings,
      media,
      tones,
    });

    const generationId = await recordGeneration({
      workspaceId: data.workspaceId,
      postId: data.postId,
      mediaIds: data.mediaIds,
      userId: actor.uid,
      action: 'generate',
      language: data.language,
      tone: data.tone,
      provider: provider.id,
      model: provider.model,
      inputType: media?.type ?? 'text',
      generatedText: result.suggestions.map((s) => s.text),
      usage: result.usage,
    });

    return {
      generationId,
      suggestions: result.suggestions,
      understanding: result.understanding,
      provider: provider.id,
      model: provider.model,
      quota,
    };
  },
  { secrets: AI_SECRETS, timeoutSeconds: 120, memory: '512MiB' },
);

// ── rewrite ───────────────────────────────────────────────────────────────

export const rewriteCaptionFn = callable(
  aiRewriteSchema,
  async (data, req) => {
    const actor = await requirePermission(req, data.workspaceId, 'content.write');
    const settings = await loadSettings(data.workspaceId);
    if (!settings.enabled) fail('failed-precondition', 'AI generation is switched off for this workspace.', { reason: 'ai_disabled' });

    const provider = activeProvider();
    const quota = await consumeAiQuota(data.workspaceId);

    const result = await provider.rewriteCaption({
      text: data.text,
      instruction: data.instruction,
      settings,
      request: { language: data.language, tone: data.tone },
    });

    const generationId = await recordGeneration({
      workspaceId: data.workspaceId,
      postId: data.postId,
      mediaIds: [],
      userId: actor.uid,
      action: 'rewrite',
      language: data.language,
      tone: data.tone,
      provider: provider.id,
      model: provider.model,
      inputType: 'text',
      generatedText: [result.text],
      usage: result.usage,
    });

    return { generationId, text: result.text, quota };
  },
  { secrets: AI_SECRETS, timeoutSeconds: 90 },
);

// ── adapt to platforms ────────────────────────────────────────────────────

export const adaptCaptionFn = callable(
  aiAdaptSchema,
  async (data, req) => {
    const actor = await requirePermission(req, data.workspaceId, 'content.write');
    const settings = await loadSettings(data.workspaceId);
    if (!settings.enabled) fail('failed-precondition', 'AI generation is switched off for this workspace.', { reason: 'ai_disabled' });

    const provider = activeProvider();

    const snaps = await db().getAll(...data.channelIds.map((id) => db().doc(paths.channel(data.workspaceId, id))));
    const catalog = createManifestCatalog({ includeDevOnly: mockProviderEnabled() });

    const targets: AiPlatformTarget[] = [];
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const channel = { id: snap.id, ...snap.data() } as SocialChannel;
      const manifest = catalog.find(channel.provider);
      if (!manifest) continue;
      targets.push({ channelId: channel.id, channel, manifest });
    }
    if (!targets.length) fail('invalid-argument', 'None of those destinations exist in this workspace.');

    const quota = await consumeAiQuota(data.workspaceId);

    const result = await provider.adaptCaptionToPlatforms({
      text: data.text,
      settings,
      request: { language: data.language, tone: data.tone, useEmojis: data.useEmojis, useHashtags: data.useHashtags },
      targets,
    });

    const generationId = await recordGeneration({
      workspaceId: data.workspaceId,
      postId: data.postId,
      mediaIds: [],
      userId: actor.uid,
      action: 'adapt',
      language: data.language,
      tone: data.tone,
      provider: provider.id,
      model: provider.model,
      inputType: 'text',
      generatedText: result.variants.map((v) => v.text),
      usage: result.usage,
    });

    return { generationId, variants: result.variants, quota };
  },
  { secrets: AI_SECRETS, timeoutSeconds: 120, memory: '512MiB' },
);

// ── bookkeeping ───────────────────────────────────────────────────────────

/**
 * Marks a suggestion as taken. Acceptance rate is the only honest signal of
 * whether the generator is worth what it costs.
 */
export const markAiGenerationAcceptedFn = callable(aiMarkAcceptedSchema, async (data, req) => {
  await requirePermission(req, data.workspaceId, 'content.write');
  await db()
    .doc(`${paths.workspace(data.workspaceId)}/aiGenerations/${data.generationId}`)
    .set({ accepted: true }, { merge: true });
  return { ok: true };
});

export const updateAiSettingsFn = callable(aiSettingsSchema, async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'workspace.settings');
  const { workspaceId, ...rest } = data;

  const settings: AiContentSettings = {
    ...DEFAULT_AI_SETTINGS,
    ...rest,
    defaultScript: scriptFor(rest.defaultLanguage),
  };

  await settingsRef(workspaceId).set({ ...settings, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await audit({
    workspaceId,
    actor: userActor(actor.uid, actor.email),
    action: 'workspace.ai_settings_changed',
    entityType: 'workspace',
    entityId: workspaceId,
    metadata: { language: settings.defaultLanguage, tone: settings.defaultTone, enabled: settings.enabled },
  });

  return { ok: true, settings };
});

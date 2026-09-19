import type { MasterContent, PostVariant, VariantContent } from '../domain/types';
import type { ContentFormat, MediaInfo, ProviderManifest } from './manifest';
import { defaultFromMaster } from './helpers';

/** Content a variant has while linked to the master. */
export function contentFromMaster(manifest: ProviderManifest, master: MasterContent): VariantContent {
  return (manifest.fromMaster ?? defaultFromMaster)(master);
}

/**
 * Effective content: linked variants always follow the master; customised ones
 * keep their own content until the user re-syncs them ("Reset to master").
 */
export function resolveVariantContent(
  manifest: ProviderManifest,
  master: MasterContent,
  variant: Pick<PostVariant, 'syncMode' | 'content'>,
): VariantContent {
  return variant.syncMode === 'master' ? contentFromMaster(manifest, master) : variant.content;
}

export function defaultSettings(manifest: ProviderManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of manifest.settingsFields) {
    if (f.defaultValue !== undefined) out[f.key] = Array.isArray(f.defaultValue) ? [...f.defaultValue] : f.defaultValue;
  }
  return out;
}

/** Picks the most natural format for the selected media. */
export function suggestFormat(manifest: ProviderManifest, media: Pick<MediaInfo, 'kind' | 'width' | 'height'>[]): ContentFormat | undefined {
  const formats = manifest.capabilities.formats;
  const images = media.filter((m) => m.kind === 'image').length;
  const videos = media.filter((m) => m.kind === 'video').length;
  const fits = (f: ContentFormat) =>
    media.length >= f.media.min &&
    media.length <= f.media.max &&
    (images === 0 || f.media.images) &&
    (videos === 0 || f.media.videos) &&
    (f.media.mixed || images === 0 || videos === 0);
  const candidates = formats.filter(fits);
  if (videos === 1 && media.length === 1) {
    const v = media[0];
    const vertical = v?.width && v?.height ? v.height > v.width : false;
    const verticalFormat = candidates.find((f) => f.preview === 'vertical');
    if (vertical && verticalFormat) return verticalFormat;
  }
  return candidates[0] ?? formats[0];
}

/** Variant fields the user changes when they "Customize for this platform". */
export function customiseVariant(manifest: ProviderManifest, master: MasterContent, variant: Pick<PostVariant, 'syncMode' | 'content'>): VariantContent {
  return { ...resolveVariantContent(manifest, master, variant) };
}

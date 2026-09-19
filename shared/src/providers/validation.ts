import type { ContentFormat, MediaInfo, ProviderManifest, TextFieldSupport, ValidationInput, ValidationIssue } from './manifest';

export function utf16Length(s: string): number {
  return s.length;
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function graphemeLength(s: string): number {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<unknown> } }).Segmenter;
  if (!Seg) return [...s].length;
  let n = 0;
  for (const _ of new Seg(undefined, { granularity: 'grapheme' }).segment(s)) n++;
  return n;
}

function measure(s: string, unit: TextFieldSupport['lengthUnit']): number {
  if (unit === 'bytes') return byteLength(s);
  if (unit === 'graphemes') return graphemeLength(s);
  return utf16Length(s);
}

export function extractHashtags(text: string): string[] {
  return [...text.matchAll(/(^|\s)#([\p{L}\p{N}_]+)/gu)].map((m) => (m[2] ?? '').toLowerCase());
}

export function normaliseHashtag(tag: string): string {
  return tag.trim().replace(/^#+/, '').replace(/\s+/g, '');
}

/**
 * Final caption: text plus hashtags that are not already present in it.
 * Used identically by the preview and by providers when publishing.
 */
export function composeCaption(text: string, hashtags: string[], append: boolean): string {
  if (!append || hashtags.length === 0) return text;
  const present = new Set(extractHashtags(text));
  const extra = hashtags.map(normaliseHashtag).filter((t) => t && !present.has(t.toLowerCase()));
  if (extra.length === 0) return text;
  const tags = extra.map((t) => `#${t}`).join(' ');
  return text.trim() ? `${text.trimEnd()}\n\n${tags}` : tags;
}

export function findFormat(manifest: ProviderManifest, formatId: string): ContentFormat | undefined {
  return manifest.capabilities.formats.find((f) => f.id === formatId);
}

function mb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function validateMediaItem(m: MediaInfo, format: ContentFormat, manifest: ProviderManifest, idx: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const field = `media[${idx}]`;
  const constraints = { ...manifest.capabilities.media, ...format.constraints };
  const push = (code: string, message: string, severity: 'error' | 'warning' = 'error') =>
    issues.push({ field, code, message: `${m.fileName}: ${message}`, severity });

  if (m.kind === 'image') {
    if (!format.media.images) return [{ field, code: 'unsupported_media', message: `${m.fileName}: images are not supported in "${format.label}".`, severity: 'error' }];
    const c = constraints.image;
    if (!c) return [{ field, code: 'unsupported_media', message: `${manifest.displayName} does not accept images.`, severity: 'error' }];
    if (!c.mimeTypes.includes(m.mimeType)) push('unsupported_mime', `${m.mimeType} is not accepted (allowed: ${c.mimeTypes.join(', ')}).`);
    if (m.size > c.maxBytes) push('file_too_large', `file is ${mb(m.size)}, max ${mb(c.maxBytes)}.`);
    if (m.width && m.height) {
      const ratio = m.width / m.height;
      if (c.minAspectRatio && ratio < c.minAspectRatio - 0.005) push('aspect_ratio', `aspect ratio ${ratio.toFixed(2)} is below the minimum ${c.minAspectRatio.toFixed(2)}.`);
      if (c.maxAspectRatio && ratio > c.maxAspectRatio + 0.005) push('aspect_ratio', `aspect ratio ${ratio.toFixed(2)} exceeds the maximum ${c.maxAspectRatio.toFixed(2)}.`);
      if (c.minWidth && m.width < c.minWidth) push('resolution', `width ${m.width}px is below ${c.minWidth}px.`);
      if (c.maxWidth && m.width > c.maxWidth) push('resolution', `width ${m.width}px exceeds ${c.maxWidth}px and will be downscaled by the platform.`, 'warning');
    }
  } else {
    if (!format.media.videos) return [{ field, code: 'unsupported_media', message: `${m.fileName}: videos are not supported in "${format.label}".`, severity: 'error' }];
    const c = constraints.video;
    if (!c) return [{ field, code: 'unsupported_media', message: `${manifest.displayName} does not accept videos.`, severity: 'error' }];
    if (!c.mimeTypes.includes(m.mimeType)) push('unsupported_mime', `${m.mimeType} is not accepted (allowed: ${c.mimeTypes.join(', ')}).`);
    if (m.size > c.maxBytes) push('file_too_large', `file is ${mb(m.size)}, max ${mb(c.maxBytes)}.`);
    if (m.durationSec != null) {
      if (c.minDurationSec && m.durationSec < c.minDurationSec) push('video_too_short', `video is ${m.durationSec.toFixed(1)}s, minimum ${c.minDurationSec}s.`);
      if (c.maxDurationSec && m.durationSec > c.maxDurationSec) push('video_too_long', `video is ${Math.round(m.durationSec)}s, maximum ${c.maxDurationSec}s.`);
    } else {
      push('unknown_duration', 'video duration could not be read; the platform may reject it.', 'warning');
    }
    if (m.width && m.height) {
      const ratio = m.width / m.height;
      if (c.minAspectRatio && ratio < c.minAspectRatio - 0.005) push('aspect_ratio', `aspect ratio ${ratio.toFixed(2)} is below the minimum ${c.minAspectRatio.toFixed(2)}.`);
      if (c.maxAspectRatio && ratio > c.maxAspectRatio + 0.005) push('aspect_ratio', `aspect ratio ${ratio.toFixed(2)} exceeds the maximum ${c.maxAspectRatio.toFixed(2)}.`);
      if (c.minWidth && Math.min(m.width, m.height) < c.minWidth) push('resolution', `resolution ${m.width}×${m.height} is below the minimum.`);
    }
  }
  return issues;
}

function checkText(field: string, label: string, value: string, spec: TextFieldSupport): ValidationIssue[] {
  if (!spec.supported) return [];
  const issues: ValidationIssue[] = [];
  if (spec.required && !value.trim()) issues.push({ field, code: 'required', message: `${label} is required.`, severity: 'error' });
  if (spec.maxLength != null) {
    const len = measure(value, spec.lengthUnit);
    if (len > spec.maxLength) {
      const unit = spec.lengthUnit === 'bytes' ? 'bytes' : 'characters';
      issues.push({ field, code: 'too_long', message: `${label} is ${len} ${unit}; the limit is ${spec.maxLength}.`, severity: 'error' });
    }
  }
  return issues;
}

/** Generic + provider-specific validation. Pure: runs in the PWA and again in the backend. */
export function validateVariant(manifest: ProviderManifest, input: ValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const caps = manifest.capabilities;
  const format = findFormat(manifest, input.format);
  if (!format) {
    return [{ field: 'format', code: 'unsupported_format', message: `${manifest.displayName} does not support the "${input.format}" format.`, severity: 'error' }];
  }

  const f = caps.fields;
  const caption = composeCaption(input.content.text, input.content.hashtags, !!f.hashtags.appendToText);
  issues.push(...checkText('content.text', f.text.label ?? 'Text', caption, f.text));
  issues.push(...checkText('content.title', f.title.label ?? 'Title', input.content.title, f.title));
  issues.push(...checkText('content.description', f.description.label ?? 'Description', input.content.description, f.description));

  if (f.hashtags.supported && f.hashtags.max != null) {
    const count = new Set([...extractHashtags(input.content.text), ...input.content.hashtags.map((h) => normaliseHashtag(h).toLowerCase())]).size;
    if (count > f.hashtags.max) issues.push({ field: 'content.hashtags', code: 'too_many_hashtags', message: `${count} hashtags; ${manifest.displayName} allows ${f.hashtags.max}.`, severity: 'error' });
  }

  if (f.link.supported) {
    const link = input.content.link.trim();
    if (f.link.required && !link) issues.push({ field: 'content.link', code: 'required', message: 'Link is required.', severity: 'error' });
    if (link) {
      let valid = false;
      try {
        const u = new URL(link);
        valid = u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        valid = false;
      }
      if (!valid) issues.push({ field: 'content.link', code: 'invalid_url', message: 'Link must be a valid http(s) URL.', severity: 'error' });
      if (f.link.maxLength && link.length > f.link.maxLength) issues.push({ field: 'content.link', code: 'too_long', message: `Link exceeds ${f.link.maxLength} characters.`, severity: 'error' });
    }
  }

  // Media count / mix
  const { media } = input;
  if (media.length < format.media.min) {
    issues.push({ field: 'media', code: 'media_required', message: format.media.min === 1 ? `"${format.label}" needs at least one media file.` : `"${format.label}" needs at least ${format.media.min} media files.`, severity: 'error' });
  }
  if (media.length > format.media.max) {
    issues.push({ field: 'media', code: 'too_many_media', message: `"${format.label}" accepts at most ${format.media.max} media file(s); ${media.length} selected.`, severity: 'error' });
  }
  const hasImages = media.some((m) => m.kind === 'image');
  const hasVideos = media.some((m) => m.kind === 'video');
  if (hasImages && hasVideos && !format.media.mixed) {
    issues.push({ field: 'media', code: 'mixed_media', message: `"${format.label}" cannot mix images and videos.`, severity: 'error' });
  }
  media.forEach((m, i) => issues.push(...validateMediaItem(m, format, manifest, i)));

  // Settings
  for (const s of manifest.settingsFields) {
    if (s.formats && !s.formats.includes(format.id)) continue;
    const v = input.settings[s.key];
    const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
    if (s.required && empty) {
      issues.push({ field: `settings.${s.key}`, code: 'required', message: `${s.label} is required for ${manifest.displayName}.`, severity: 'error' });
      continue;
    }
    if (!empty && s.type === 'select' && s.options && !s.options.some((o) => o.value === v)) {
      issues.push({ field: `settings.${s.key}`, code: 'invalid_option', message: `${s.label}: "${String(v)}" is not a valid option.`, severity: 'error' });
    }
    if (!empty && typeof v === 'string' && s.maxLength && v.length > s.maxLength) {
      issues.push({ field: `settings.${s.key}`, code: 'too_long', message: `${s.label} exceeds ${s.maxLength} characters.`, severity: 'error' });
    }
  }

  if (manifest.validate) issues.push(...manifest.validate(input));
  return issues;
}

export function hasBlockingIssues(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

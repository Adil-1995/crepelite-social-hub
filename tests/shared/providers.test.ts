import { describe, expect, it } from 'vitest';
import {
  ALL_MANIFESTS,
  EMPTY_MASTER_CONTENT,
  composeCaption,
  contentFromMaster,
  createManifestCatalog,
  defaultSettings,
  extractHashtags,
  findFormat,
  hasBlockingIssues,
  normaliseHashtag,
  resolveVariantContent,
  suggestFormat,
  validateVariant,
  type MediaInfo,
  type ProviderManifest,
} from '@shared/index';

const prodCatalog = createManifestCatalog({ includeDevOnly: false });
const devCatalog = createManifestCatalog({ includeDevOnly: true });

const image = (over: Partial<MediaInfo> = {}): MediaInfo => ({
  id: 'm1',
  kind: 'image',
  mimeType: 'image/jpeg',
  size: 500_000,
  width: 1080,
  height: 1080,
  durationSec: null,
  fileName: 'photo.jpg',
  ...over,
});

const video = (over: Partial<MediaInfo> = {}): MediaInfo => ({
  id: 'v1',
  kind: 'video',
  mimeType: 'video/mp4',
  size: 8_000_000,
  width: 1080,
  height: 1920,
  durationSec: 20,
  fileName: 'clip.mp4',
  ...over,
});

describe('manifest catalog', () => {
  it('registers the five launch networks', () => {
    for (const id of ['facebook', 'instagram', 'tiktok', 'pinterest', 'youtube']) {
      expect(prodCatalog.has(id)).toBe(true);
    }
  });

  it('keeps development-only providers out of production', () => {
    const devOnly = ALL_MANIFESTS.filter((m) => m.devOnly).map((m) => m.id);
    expect(devOnly.length).toBeGreaterThan(0);
    for (const id of devOnly) {
      expect(prodCatalog.has(id)).toBe(false);
      expect(devCatalog.has(id)).toBe(true);
    }
  });

  it('throws on an unknown provider instead of returning undefined', () => {
    expect(() => prodCatalog.get('myspace')).toThrow(/Unknown provider/);
    expect(prodCatalog.find('myspace')).toBeUndefined();
  });

  it('rejects duplicate ids', () => {
    const first = ALL_MANIFESTS[0]!;
    expect(() => createManifestCatalog.constructor).toBeDefined();
    expect(() => new (Object.getPrototypeOf(prodCatalog).constructor)([first, first], { includeDevOnly: true })).toThrow(
      /Duplicate/,
    );
  });

  it('groups Facebook and Instagram under one OAuth grant', () => {
    const meta = prodCatalog.get('facebook').authFamily;
    expect(prodCatalog.get('instagram').authFamily).toBe(meta);
    const family = prodCatalog.byAuthFamily(meta).map((m) => m.id);
    expect(family).toContain('facebook');
    expect(family).toContain('instagram');
  });

  it('exposes each auth family exactly once', () => {
    const families = prodCatalog.authFamilies();
    expect(new Set(families).size).toBe(families.length);
  });
});

describe('manifest shape', () => {
  it.each(ALL_MANIFESTS.map((m) => [m.id, m] as [string, ProviderManifest]))(
    '%s declares everything the UI renders from',
    (_id, m) => {
      expect(m.displayName).toBeTruthy();
      expect(m.authFamily).toBeTruthy();
      expect(m.brandColor).toMatch(/^#[0-9a-fA-F]{3,8}$/);
      expect(m.iconPath.length).toBeGreaterThan(0);
      expect(m.capabilities.formats.length).toBeGreaterThan(0);
      expect(m.apiVersion).toBeTruthy();
      // `docs` points at the in-repo provider document, not an external URL.
      expect(m.docs).toMatch(new RegExp(String.raw`^docs/.+.md$`));
      expect(m.rateLimit.maxConcurrent).toBeGreaterThan(0);
    },
  );

  it.each(ALL_MANIFESTS.map((m) => [m.id, m] as [string, ProviderManifest]))(
    '%s declares coherent formats',
    (_id, m) => {
      const ids = m.capabilities.formats.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const f of m.capabilities.formats) {
        expect(f.media.min).toBeLessThanOrEqual(f.media.max);
        expect(f.label).toBeTruthy();
        // A format must accept at least one kind of media, or none at all.
        if (f.media.max > 0) expect(f.media.images || f.media.videos).toBe(true);
      }
    },
  );

  it.each(ALL_MANIFESTS.map((m) => [m.id, m] as [string, ProviderManifest]))(
    '%s scopes every settings field to a real format',
    (_id, m) => {
      const formatIds = new Set(m.capabilities.formats.map((f) => f.id));
      for (const field of m.settingsFields) {
        expect(field.key).toBeTruthy();
        expect(field.label).toBeTruthy();
        for (const f of field.formats ?? []) expect(formatIds).toContain(f);
      }
    },
  );

  it('only claims editable fields when editing is supported', () => {
    for (const m of ALL_MANIFESTS) {
      if (!m.capabilities.canEditPublishedPost) {
        expect(m.capabilities.editableAfterPublish).toEqual([]);
      }
    }
  });
});

describe('hashtags and captions', () => {
  it('strips leading hashes', () => {
    expect(normaliseHashtag('##crepes')).toBe('crepes');
    expect(normaliseHashtag('crepes')).toBe('crepes');
  });

  it('pulls hashtags out of free text', () => {
    // Hashtags are lower-cased so the same tag never appears twice.
    expect(extractHashtags('Fresh #crepes in #Casablanca today')).toEqual(['crepes', 'casablanca']);
    expect(extractHashtags('no tags here')).toEqual([]);
  });

  it('appends hashtags only when the provider wants them in the caption', () => {
    expect(composeCaption('Hello', ['a', 'b'], true)).toContain('#a');
    expect(composeCaption('Hello', ['a', 'b'], false)).toBe('Hello');
  });
});

describe('variants', () => {
  const master = { ...EMPTY_MASTER_CONTENT, text: 'Fresh crepes', title: 'Crepes', hashtags: ['crepes'] };

  it('derives linked content from the master for every provider', () => {
    for (const m of ALL_MANIFESTS) {
      const content = contentFromMaster(m, master);
      expect(typeof content.text).toBe('string');
      expect(typeof content.title).toBe('string');
    }
  });

  it('keeps custom content and ignores the master', () => {
    const m = prodCatalog.get('instagram');
    const custom = { ...EMPTY_MASTER_CONTENT, text: 'Only for Instagram' };
    const resolved = resolveVariantContent(m, master, { syncMode: 'custom', content: custom });
    expect(resolved.text).toBe('Only for Instagram');
  });

  it('re-derives linked content when the master changes', () => {
    const m = prodCatalog.get('facebook');
    const resolved = resolveVariantContent(m, master, { syncMode: 'master', content: { ...EMPTY_MASTER_CONTENT } });
    expect(resolved.text).toContain('Fresh crepes');
  });

  it('seeds provider settings from their declared defaults', () => {
    for (const m of ALL_MANIFESTS) {
      const settings = defaultSettings(m);
      for (const field of m.settingsFields) {
        if (field.defaultValue !== undefined) expect(settings[field.key]).toEqual(field.defaultValue);
      }
    }
  });

  it('suggests a vertical format for a portrait video where one exists', () => {
    const m = prodCatalog.get('instagram');
    const suggested = suggestFormat(m, [video({ width: 1080, height: 1920 })]);
    expect(suggested).toBeDefined();
    const hasVertical = m.capabilities.formats.some((f) => f.preview === 'vertical');
    if (hasVertical) expect(suggested!.preview).toBe('vertical');
  });

  it('always suggests some format, even with no media', () => {
    for (const m of ALL_MANIFESTS) {
      expect(suggestFormat(m, [])).toBeDefined();
    }
  });
});

describe('validation', () => {
  it('finds a declared format and rejects an unknown one', () => {
    const m = prodCatalog.get('facebook');
    const first = m.capabilities.formats[0]!;
    expect(findFormat(m, first.id)).toBeDefined();
    expect(findFormat(m, 'not-a-format')).toBeUndefined();
  });

  it('flags an unknown format as a blocking issue', () => {
    const m = prodCatalog.get('facebook');
    const issues = validateVariant(m, {
      format: 'not-a-format',
      content: { ...EMPTY_MASTER_CONTENT, text: 'hi' },
      media: [image()],
      settings: {},
    });
    expect(hasBlockingIssues(issues)).toBe(true);
  });

  it('flags a caption beyond the declared limit', () => {
    for (const m of ALL_MANIFESTS) {
      const max = m.capabilities.fields.text.maxLength;
      if (!max || !m.capabilities.fields.text.supported) continue;
      const format = m.capabilities.formats[0]!;
      const media = format.media.min > 0 ? [format.media.videos && !format.media.images ? video() : image()] : [];
      const issues = validateVariant(m, {
        format: format.id,
        content: { ...EMPTY_MASTER_CONTENT, text: 'x'.repeat(max + 1) },
        media,
        settings: defaultSettings(m),
      });
      expect(issues.some((i) => i.field === 'content.text' && i.severity === 'error')).toBe(true);
    }
  });

  it('flags too few media for a format that requires them', () => {
    for (const m of ALL_MANIFESTS) {
      const format = m.capabilities.formats.find((f) => f.media.min > 0);
      if (!format) continue;
      const issues = validateVariant(m, {
        format: format.id,
        content: { ...EMPTY_MASTER_CONTENT, text: 'hello' },
        media: [],
        settings: defaultSettings(m),
      });
      expect(hasBlockingIssues(issues)).toBe(true);
    }
  });

  it('flags too many media for a format', () => {
    for (const m of ALL_MANIFESTS) {
      const format = m.capabilities.formats.find((f) => f.media.max > 0 && f.media.max < 20 && f.media.images);
      if (!format) continue;
      const media = Array.from({ length: format.media.max + 1 }, (_, i) => image({ id: `m${i}` }));
      const issues = validateVariant(m, {
        format: format.id,
        content: { ...EMPTY_MASTER_CONTENT, text: 'hello' },
        media,
        settings: defaultSettings(m),
      });
      expect(hasBlockingIssues(issues)).toBe(true);
    }
  });

  it('treats warnings as non-blocking', () => {
    expect(hasBlockingIssues([{ field: 'x', code: 'c', message: 'm', severity: 'warning' }])).toBe(false);
    expect(hasBlockingIssues([{ field: 'x', code: 'c', message: 'm', severity: 'error' }])).toBe(true);
    expect(hasBlockingIssues([])).toBe(false);
  });

  it('requires settings a provider marks as required', () => {
    for (const m of ALL_MANIFESTS) {
      const required = m.settingsFields.find((f) => f.required && !f.defaultValue);
      if (!required) continue;
      const format = required.formats?.[0] ?? m.capabilities.formats[0]!.id;
      const formatDef = findFormat(m, format)!;
      const media = Array.from({ length: Math.max(formatDef.media.min, 0) }, (_, i) =>
        formatDef.media.images ? image({ id: `m${i}` }) : video({ id: `v${i}` }),
      );
      const issues = validateVariant(m, {
        format,
        content: { ...EMPTY_MASTER_CONTENT, text: 'hello', title: 'title' },
        media,
        settings: {},
      });
      expect(issues.some((i) => i.severity === 'error')).toBe(true);
    }
  });
});

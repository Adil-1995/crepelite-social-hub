import type { ProviderManifest } from './manifest';
import { facebookManifest } from './manifests/facebook';
import { instagramManifest } from './manifests/instagram';
import { tiktokManifest } from './manifests/tiktok';
import { pinterestManifest } from './manifests/pinterest';
import { youtubeManifest } from './manifests/youtube';
import { mockManifest } from './manifests/mock';

/**
 * Client-safe catalog of every network the Hub knows about.
 * To add a network: create `manifests/<id>.ts` and add it here, then register
 * the backend provider (functions/src/providers/index.ts). Nothing else in
 * the core needs to change — see docs/adding-provider.md.
 */
const ALL_MANIFESTS: ProviderManifest[] = [
  instagramManifest,
  facebookManifest,
  tiktokManifest,
  pinterestManifest,
  youtubeManifest,
  mockManifest,
];

export class ManifestCatalog {
  private readonly byId = new Map<string, ProviderManifest>();

  constructor(manifests: ProviderManifest[], opts: { includeDevOnly: boolean }) {
    for (const m of manifests) {
      if (m.devOnly && !opts.includeDevOnly) continue;
      if (this.byId.has(m.id)) throw new Error(`Duplicate provider manifest "${m.id}"`);
      this.byId.set(m.id, m);
    }
  }

  get(id: string): ProviderManifest {
    const m = this.byId.get(id);
    if (!m) throw new Error(`Unknown provider "${id}"`);
    return m;
  }

  find(id: string): ProviderManifest | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(): ProviderManifest[] {
    return [...this.byId.values()];
  }

  /** Providers that share one OAuth grant (e.g. meta → facebook, instagram). */
  byAuthFamily(family: string): ProviderManifest[] {
    return this.list().filter((m) => m.authFamily === family);
  }

  authFamilies(): string[] {
    return [...new Set(this.list().map((m) => m.authFamily))];
  }
}

export function createManifestCatalog(opts: { includeDevOnly: boolean }): ManifestCatalog {
  return new ManifestCatalog(ALL_MANIFESTS, opts);
}

export { ALL_MANIFESTS };

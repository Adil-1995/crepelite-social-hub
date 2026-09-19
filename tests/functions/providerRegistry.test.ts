import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../functions/src/providers/registry';
import type { OAuthAdapter, SocialProvider } from '../../functions/src/providers/types';
import { facebookManifest, instagramManifest, mockManifest, type ProviderManifest } from '@shared/index';

/**
 * The registry is what keeps the core provider-agnostic: adding a network is
 * registration only, and there is no `if (provider === 'instagram')` anywhere
 * else. These tests pin the guarantees the rest of the backend relies on.
 */
const adapters = new Map<string, OAuthAdapter>();

function adapterFor(family: string): OAuthAdapter {
  if (!adapters.has(family)) adapters.set(family, { family } as unknown as OAuthAdapter);
  return adapters.get(family)!;
}

function fakeProvider(manifest: ProviderManifest, auth = adapterFor(manifest.authFamily)): SocialProvider {
  return { id: manifest.id, manifest, auth } as unknown as SocialProvider;
}

describe('ProviderRegistry', () => {
  it('registers and returns a provider', () => {
    const reg = new ProviderRegistry({ allowDevOnly: true });
    reg.register(fakeProvider(mockManifest));
    expect(reg.has(mockManifest.id)).toBe(true);
    expect(reg.get(mockManifest.id).manifest.id).toBe(mockManifest.id);
  });

  it('silently drops a dev-only provider when dev mode is off', () => {
    const reg = new ProviderRegistry({ allowDevOnly: false });
    reg.register(fakeProvider(mockManifest));

    // The mock must never be reachable in production, whatever the caller does.
    expect(reg.has(mockManifest.id)).toBe(false);
    expect(() => reg.get(mockManifest.id)).toThrow(/not registered/);
    expect(reg.list().map((p) => p.id)).not.toContain(mockManifest.id);
  });

  it('still registers normal providers when dev mode is off', () => {
    const reg = new ProviderRegistry({ allowDevOnly: false });
    reg.register(fakeProvider(facebookManifest));
    expect(reg.has('facebook')).toBe(true);
  });

  it('throws rather than returning undefined for an unknown provider', () => {
    const reg = new ProviderRegistry({ allowDevOnly: true });
    expect(() => reg.get('myspace')).toThrow(/not registered/);
    expect(reg.has('myspace')).toBe(false);
  });

  it('rejects registering the same provider twice', () => {
    const reg = new ProviderRegistry({ allowDevOnly: true });
    reg.register(fakeProvider(facebookManifest));
    expect(() => reg.register(fakeProvider(facebookManifest))).toThrow(/already registered/);
  });

  it('rejects a provider whose id does not match its manifest', () => {
    const reg = new ProviderRegistry({ allowDevOnly: true });
    const mismatched = { ...fakeProvider(facebookManifest), id: 'not-facebook' } as SocialProvider;
    expect(() => reg.register(mismatched)).toThrow(/manifest id mismatch/);
  });

  it('rejects two different OAuth adapters for one family', () => {
    const reg = new ProviderRegistry({ allowDevOnly: true });
    reg.register(fakeProvider(facebookManifest));
    const rogue = fakeProvider(instagramManifest, { family: facebookManifest.authFamily } as unknown as OAuthAdapter);
    expect(() => reg.register(rogue)).toThrow(/two different adapters/);
  });

  it('keeps registration chainable', () => {
    const reg = new ProviderRegistry({ allowDevOnly: true });
    expect(reg.register(fakeProvider(facebookManifest))).toBe(reg);
  });

  it('groups providers that share one OAuth grant', () => {
    const reg = new ProviderRegistry({ allowDevOnly: true });
    reg.register(fakeProvider(facebookManifest)).register(fakeProvider(instagramManifest));

    const ids = reg.providersForFamily(facebookManifest.authFamily).map((p) => p.id);
    expect(ids).toContain('facebook');
    expect(ids).toContain('instagram');
  });

  it('exposes one adapter per family, not one per provider', () => {
    const reg = new ProviderRegistry({ allowDevOnly: true });
    reg.register(fakeProvider(facebookManifest)).register(fakeProvider(instagramManifest));
    expect(reg.authFamilies()).toHaveLength(1);
    expect(reg.authAdapter(facebookManifest.authFamily)).toBeDefined();
  });

  it('returns an empty list for a family with no providers', () => {
    const reg = new ProviderRegistry({ allowDevOnly: true });
    expect(reg.providersForFamily('nothing-here')).toEqual([]);
  });

  it('throws for an OAuth family that was never registered', () => {
    const reg = new ProviderRegistry({ allowDevOnly: true });
    expect(() => reg.authAdapter('meta')).toThrow(/not registered/);
  });
});

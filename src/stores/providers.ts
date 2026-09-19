import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { createManifestCatalog, type ProviderManifest } from '@shared/index';
import { appEnv } from '@/app/firebase';
import { api, type ProviderStatus } from '@/services/api';

/**
 * Client-side provider catalog built only from shared manifests
 * (capabilities, formats, settings). The UI never imports provider clients.
 * Runtime status (configured? approved?) comes from the backend.
 */
export const useProvidersStore = defineStore('providers', () => {
  const catalog = createManifestCatalog({ includeDevOnly: appEnv !== 'production' });
  const status = ref<ProviderStatus | null>(null);
  const loadingStatus = ref(false);

  async function loadStatus(workspaceId: string) {
    loadingStatus.value = true;
    try {
      status.value = await api.getProviderStatus({ workspaceId });
    } finally {
      loadingStatus.value = false;
    }
  }

  function manifest(id: string): ProviderManifest | undefined {
    return catalog.find(id);
  }

  const families = computed(() => {
    const list = catalog.authFamilies().map((family) => {
      const members = catalog.byAuthFamily(family);
      const runtime = status.value?.families.find((f) => f.family === family);
      return {
        family,
        providers: members,
        displayName: runtime?.displayName ?? members.map((m) => m.displayName).join(' & '),
        configured: runtime?.configured ?? null,
        missing: runtime?.missing ?? [],
        available: status.value ? !!runtime : true,
        devOnly: members.every((m) => m.devOnly),
      };
    });
    return list.filter((f) => f.available);
  });

  return { catalog, status, loadingStatus, loadStatus, manifest, families, list: () => catalog.list() };
});

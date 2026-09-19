<script setup lang="ts">
import { computed } from 'vue';
import Checkbox from 'primevue/checkbox';
import Message from 'primevue/message';
import Avatar from 'primevue/avatar';
import Button from 'primevue/button';
import { useRouter } from 'vue-router';
import type { SocialChannel } from '@shared/index';
import { useWorkspaceStore } from '@/stores/workspace';
import { useProvidersStore } from '@/stores/providers';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';
import EmptyState from '@/components/domain/EmptyState.vue';

/**
 * Channel picker grouped by provider.
 *
 * Providers come from the workspace's connected channels and the shared
 * manifest catalog — no platform is hardcoded here, so a new provider appears
 * automatically once its manifest and connection exist.
 */
const model = defineModel<string[]>({ required: true });
const props = withDefaults(defineProps<{ disabled?: boolean; showUnavailable?: boolean }>(), {
  disabled: false,
  showUnavailable: true,
});

const ws = useWorkspaceStore();
const providers = useProvidersStore();
const router = useRouter();

interface Group {
  provider: string;
  displayName: string;
  channels: SocialChannel[];
}

const groups = computed<Group[]>(() => {
  const byProvider = new Map<string, SocialChannel[]>();
  for (const c of ws.channels) {
    if (!byProvider.has(c.provider)) byProvider.set(c.provider, []);
    byProvider.get(c.provider)!.push(c);
  }
  return [...byProvider.entries()]
    .map(([provider, channels]) => ({
      provider,
      displayName: providers.manifest(provider)?.displayName ?? provider,
      channels: channels.slice().sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
});

const hasAnyChannel = computed(() => ws.channels.length > 0);

/** A channel can be targeted only when it is enabled and its auth is healthy. */
function selectable(c: SocialChannel): boolean {
  return c.enabled && c.status === 'connected';
}

function reasonUnavailable(c: SocialChannel): string {
  if (!c.enabled) return 'Disabled for this workspace';
  if (c.status === 'needs_reauth' || c.status === 'expired') return 'Reconnect this account to publish';
  if (c.status === 'revoked') return 'Access was revoked';
  return 'Unavailable';
}

function toggleProvider(g: Group) {
  const ids = g.channels.filter(selectable).map((c) => c.id);
  const allOn = ids.every((id) => model.value.includes(id));
  model.value = allOn ? model.value.filter((id) => !ids.includes(id)) : [...new Set([...model.value, ...ids])];
}

function providerState(g: Group): boolean {
  const ids = g.channels.filter(selectable).map((c) => c.id);
  return ids.length > 0 && ids.every((id) => model.value.includes(id));
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <EmptyState
      v-if="!hasAnyChannel"
      icon="pi pi-link"
      title="No accounts connected"
      message="Connect a social account to choose where this post goes."
      action-label="Go to connections"
      action-icon="pi pi-arrow-right"
      @action="router.push('/connections')"
    />

    <fieldset v-for="g in groups" :key="g.provider" class="flex flex-col gap-2 border-0 p-0">
      <legend class="sr-only">{{ g.displayName }}</legend>

      <div class="flex items-center gap-2">
        <ProviderIcon :provider="g.provider" :size="18" />
        <span class="text-sm font-semibold text-ink">{{ g.displayName }}</span>
        <Button
          v-if="g.channels.filter(selectable).length > 1"
          :label="providerState(g) ? 'Clear' : 'All'"
          text
          size="small"
          :disabled="props.disabled"
          class="ml-auto"
          @click="toggleProvider(g)"
        />
      </div>

      <ul class="flex flex-col gap-1">
        <li v-for="c in g.channels" :key="c.id">
          <label
            v-if="selectable(c)"
            class="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted"
          >
            <Checkbox v-model="model" :value="c.id" :input-id="`ch-${c.id}`" :disabled="props.disabled" />
            <Avatar
              :image="c.avatarUrl ?? undefined"
              :label="c.avatarUrl ? undefined : c.name.slice(0, 1).toUpperCase()"
              shape="circle"
              size="normal"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm text-ink">{{ c.name }}</span>
              <span v-if="c.handle" class="block truncate text-xs text-ink-soft">{{ c.handle }}</span>
            </span>
          </label>

          <div
            v-else-if="props.showUnavailable"
            class="flex min-h-11 items-center gap-3 rounded-lg px-2 py-1.5 opacity-60"
          >
            <i class="pi pi-lock text-ink-soft" aria-hidden="true" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm text-ink">{{ c.name }}</span>
              <span class="block truncate text-xs text-ink-soft">{{ reasonUnavailable(c) }}</span>
            </span>
            <Button
              v-if="c.status === 'needs_reauth' || c.status === 'expired'"
              label="Reconnect"
              size="small"
              text
              @click="router.push('/connections')"
            />
          </div>
        </li>
      </ul>
    </fieldset>

    <Message v-if="hasAnyChannel && model.length === 0" severity="warn" :closable="false" size="small">
      Select at least one destination.
    </Message>
  </div>
</template>

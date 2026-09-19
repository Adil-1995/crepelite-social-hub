<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Button from 'primevue/button';
import Message from 'primevue/message';
import { useRouter } from 'vue-router';
import type { SocialChannel } from '@shared/index';
import { useWorkspaceStore } from '@/stores/workspace';
import { useProvidersStore } from '@/stores/providers';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';
import EmptyState from '@/components/domain/EmptyState.vue';

/**
 * Destination picker: one tappable avatar per account, with the network badged
 * on the corner.
 *
 * Only accounts that can actually receive a post are listed. A disabled
 * channel, or one whose authorisation has lapsed, is not shown at all — it is
 * noise in the one place where a mis-tap publishes to the wrong business.
 * Those live on the connections screen, which is where they get fixed.
 *
 * Providers come from the shared manifest catalog, so a new network appears
 * here automatically.
 */
const model = defineModel<string[]>({ required: true });
const props = withDefaults(defineProps<{ disabled?: boolean; compact?: boolean }>(), {
  disabled: false,
  compact: false,
});

const ws = useWorkspaceStore();
const providers = useProvidersStore();
const router = useRouter();

/** Publishable right now: enabled, and the connection is healthy. */
const available = computed(() =>
  ws.channels
    .filter((c) => c.enabled && c.status === 'connected')
    .slice()
    .sort((a, b) => {
      const p = (providers.manifest(a.provider)?.displayName ?? a.provider).localeCompare(
        providers.manifest(b.provider)?.displayName ?? b.provider,
      );
      return p !== 0 ? p : a.name.localeCompare(b.name);
    }),
);

/** Accounts hidden because they need attention, counted for the hint below. */
const needsAttention = computed(() => ws.channels.filter((c) => c.enabled && c.status !== 'connected').length);

const hasAnyConnection = computed(() => ws.connections.length > 0);

/**
 * Local mirror of the selection.
 *
 * `model.value` reads the incoming prop, which only updates after the parent
 * re-renders. Two taps inside one tick would both read the pre-update value
 * and the second would silently discard the first — on the one control where
 * a lost selection means publishing to the wrong account.
 */
const selection = ref<string[]>([...model.value]);
watch(model, (v) => {
  if (v.length !== selection.value.length || v.some((id, i) => id !== selection.value[i])) {
    selection.value = [...v];
  }
});

function isSelected(id: string): boolean {
  return selection.value.includes(id);
}

function commit(next: string[]) {
  selection.value = next;
  model.value = next;
}

function toggle(channel: SocialChannel) {
  if (props.disabled) return;
  commit(
    isSelected(channel.id)
      ? selection.value.filter((id) => id !== channel.id)
      : [...selection.value, channel.id],
  );
}

function selectAll() {
  commit(selection.value.length === available.value.length ? [] : available.value.map((c) => c.id));
}

const allSelected = computed(() => available.value.length > 0 && selection.value.length === available.value.length);
const initial = (name: string) => name.trim().slice(0, 1).toUpperCase() || '?';
</script>

<template>
  <div class="flex flex-col gap-3">
    <EmptyState
      v-if="!hasAnyConnection"
      icon="pi pi-link"
      title="No accounts connected"
      message="Connect a social account to choose where this post goes."
      action-label="Go to connections"
      action-icon="pi pi-arrow-right"
      @action="router.push('/connections')"
    />

    <EmptyState
      v-else-if="!available.length"
      icon="pi pi-exclamation-triangle"
      title="No account can publish right now"
      message="Every connected account is disabled or needs reconnecting."
      action-label="Fix connections"
      action-icon="pi pi-arrow-right"
      @action="router.push('/connections')"
    />

    <template v-else>
      <div v-if="!compact" class="flex items-center gap-2">
        <span class="text-sm font-medium text-ink">
          {{ selection.length ? `${selection.length} selected` : 'Where does this go?' }}
        </span>
        <Button
          v-if="available.length > 1"
          :label="allSelected ? 'Clear' : 'Select all'"
          text
          size="small"
          class="ml-auto"
          :disabled="disabled"
          @click="selectAll"
        />
      </div>

      <ul class="flex flex-wrap gap-3">
        <li v-for="c in available" :key="c.id">
          <button
            type="button"
            class="group flex w-[4.5rem] flex-col items-center gap-1.5 rounded-xl p-1 transition-opacity"
            :class="[disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer', !isSelected(c.id) && !disabled ? 'opacity-70 hover:opacity-100' : '']"
            :aria-pressed="isSelected(c.id)"
            :aria-label="`${c.name} on ${providers.manifest(c.provider)?.displayName ?? c.provider}`"
            :disabled="disabled"
            @click="toggle(c)"
          >
            <span class="relative block">
              <span
                class="block h-12 w-12 overflow-hidden rounded-full border-2 bg-muted transition-colors"
                :class="isSelected(c.id) ? 'border-brand-500' : 'border-line group-hover:border-ink-soft'"
              >
                <img
                  v-if="c.avatarUrl"
                  :src="c.avatarUrl"
                  alt=""
                  loading="lazy"
                  class="h-full w-full object-cover"
                />
                <span v-else class="flex h-full w-full items-center justify-center text-base font-semibold text-ink-soft">
                  {{ initial(c.name) }}
                </span>
              </span>

              <!-- Network badge -->
              <span
                class="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-surface bg-surface"
              >
                <ProviderIcon :provider="c.provider" :size="12" />
              </span>

              <!-- Selected tick -->
              <span
                v-if="isSelected(c.id)"
                class="absolute -left-0.5 -top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white"
                aria-hidden="true"
              >
                <i class="pi pi-check" style="font-size: 0.6rem" />
              </span>
            </span>

            <span class="w-full truncate text-center text-[11px] leading-tight text-ink" :title="c.name">
              {{ c.name }}
            </span>
          </button>
        </li>
      </ul>

      <p v-if="needsAttention && !compact" class="text-xs text-ink-soft">
        {{ needsAttention }} {{ needsAttention === 1 ? 'account is' : 'accounts are' }} hidden because
        {{ needsAttention === 1 ? 'it needs' : 'they need' }} reconnecting.
        <Button label="Review" text size="small" @click="router.push('/connections')" />
      </p>

      <Message v-if="!selection.length && !compact" severity="warn" :closable="false" size="small">
        Pick at least one destination.
      </Message>
    </template>
  </div>
</template>

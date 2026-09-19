<script setup lang="ts">
import { computed } from 'vue';
import { useProvidersStore } from '@/stores/providers';

/**
 * Brand mark for a provider, drawn from the single-path SVG in its manifest.
 * PrimeIcons has no social brand marks, so manifests carry their own path —
 * this is the only place brand iconography is rendered.
 */
const props = withDefaults(defineProps<{ provider: string; size?: number; colored?: boolean }>(), {
  size: 20,
  colored: true,
});
const providers = useProvidersStore();
const manifest = computed(() => providers.manifest(props.provider));
const label = computed(() => manifest.value?.displayName ?? props.provider);
</script>

<template>
  <svg
    v-if="manifest"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    role="img"
    :aria-label="label"
    :style="{ color: colored ? manifest.brandColor : 'currentColor' }"
    class="shrink-0"
  >
    <title>{{ label }}</title>
    <path :d="manifest.iconPath" fill="currentColor" />
  </svg>
  <i v-else class="pi pi-globe" :style="{ fontSize: `${size}px` }" :aria-label="label" />
</template>

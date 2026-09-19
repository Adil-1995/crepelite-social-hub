<script setup lang="ts">
import { computed } from 'vue';
import Tag from 'primevue/tag';
import type { DeliveryStatus } from '@shared/index';
import { DELIVERY_STATUS_UI } from '@/lib/status';

/** Maps a delivery status to a PrimeVue Tag. Status is never colour-only. */
const props = defineProps<{ status: DeliveryStatus; compact?: boolean }>();
const ui = computed(() => DELIVERY_STATUS_UI[props.status]);
</script>

<template>
  <Tag
    :severity="ui.severity"
    :icon="ui.icon"
    :value="compact ? undefined : ui.label"
    :aria-label="`Status: ${ui.label}`"
    :title="ui.label"
  />
</template>

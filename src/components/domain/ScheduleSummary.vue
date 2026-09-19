<script setup lang="ts">
import { computed } from 'vue';
import Message from 'primevue/message';
import type { Ts } from '@shared/index';
import { QUEUE_WINDOW_DAYS } from '@shared/index';
import { formatDateTime, formatRelative, toMillis } from '@/lib/format';
import { useWorkspaceStore } from '@/stores/workspace';

/**
 * Human explanation of when a post goes out, including the two-layer queue:
 * beyond the Cloud Tasks horizon a delivery waits in `awaiting_queue` first.
 */
const props = defineProps<{ scheduledAt: Ts | number | Date | null; channelCount: number }>();
const ws = useWorkspaceStore();

const ms = computed(() => toMillis(props.scheduledAt));
const beyondWindow = computed(() => {
  if (ms.value == null) return false;
  return ms.value - Date.now() > QUEUE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
});
const inPast = computed(() => ms.value != null && ms.value <= Date.now());
</script>

<template>
  <div class="flex flex-col gap-2">
    <p v-if="ms == null" class="text-sm text-ink-muted">
      No date set — this stays a draft until you schedule it.
    </p>
    <template v-else>
      <p class="text-sm text-ink">
        <i class="pi pi-clock mr-1 text-ink-soft" aria-hidden="true" />
        {{ formatDateTime(ms, ws.timezone) }}
        <span class="text-ink-soft">({{ ws.timezone }})</span>
      </p>
      <p class="text-xs text-ink-soft">
        {{ formatRelative(ms, ws.timezone) }} ·
        {{ channelCount }} {{ channelCount === 1 ? 'destination' : 'destinations' }}
      </p>
    </template>

    <Message v-if="inPast" severity="error" :closable="false" size="small">
      That time is in the past. Pick a future time or publish now.
    </Message>
    <Message v-else-if="beyondWindow" severity="info" :closable="false" size="small">
      More than {{ QUEUE_WINDOW_DAYS }} days ahead — this waits in the schedule and is queued automatically
      closer to the date.
    </Message>
  </div>
</template>

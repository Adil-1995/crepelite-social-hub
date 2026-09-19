<script setup lang="ts">
import Button from 'primevue/button';
import Message from 'primevue/message';

/** Error state with a retry affordance, used by every data-backed screen. */
defineProps<{ title?: string; message: string; retryable?: boolean }>();
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="p-4">
    <Message severity="error" :closable="false">
      <div class="flex flex-col gap-2">
        <span class="font-semibold">{{ title ?? 'Something went wrong' }}</span>
        <span class="text-sm">{{ message }}</span>
        <Button
          v-if="retryable !== false"
          label="Try again"
          icon="pi pi-refresh"
          severity="secondary"
          size="small"
          outlined
          class="self-start"
          @click="emit('retry')"
        />
      </div>
    </Message>
  </div>
</template>

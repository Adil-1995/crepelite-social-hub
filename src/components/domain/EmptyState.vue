<script setup lang="ts">
import Button from 'primevue/button';

/** Consistent empty state: icon, title, explanation and at most one action. */
defineProps<{
  icon?: string;
  title: string;
  message?: string;
  actionLabel?: string;
  actionIcon?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ action: [] }>();
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
    <i :class="icon ?? 'pi pi-inbox'" class="text-3xl text-ink-soft" aria-hidden="true" />
    <p class="text-base font-semibold text-ink">{{ title }}</p>
    <p v-if="message" class="max-w-sm text-sm text-ink-muted">{{ message }}</p>
    <Button
      v-if="actionLabel"
      :label="actionLabel"
      :icon="actionIcon"
      :disabled="disabled"
      class="mt-1"
      @click="emit('action')"
    />
    <slot />
  </div>
</template>

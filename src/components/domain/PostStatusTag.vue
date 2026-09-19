<script setup lang="ts">
import { computed } from 'vue';
import Tag from 'primevue/tag';
import type { PostStatus } from '@shared/index';
import { POST_STATUS_UI } from '@/lib/status';

const props = defineProps<{ status: PostStatus }>();
const ui = computed(() => POST_STATUS_UI[props.status]);
</script>

<template>
  <Tag :severity="ui.severity" :icon="ui.icon" :value="ui.label" :aria-label="`Status: ${ui.label}`" />
</template>

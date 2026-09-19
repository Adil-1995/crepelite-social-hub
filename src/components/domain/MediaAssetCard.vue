<script setup lang="ts">
import { computed } from 'vue';
import Card from 'primevue/card';
import Tag from 'primevue/tag';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import ProgressBar from 'primevue/progressbar';
import Skeleton from 'primevue/skeleton';
import type { MediaAsset } from '@shared/index';
import { formatBytes, formatDuration } from '@/lib/format';

/** Media library tile. Upload progress and selection are both driven from here. */
const props = defineProps<{
  asset: MediaAsset;
  url?: string | null;
  selectable?: boolean;
  selected?: boolean;
  progress?: number | null;
}>();
const emit = defineEmits<{ select: [id: string]; open: [id: string]; remove: [id: string] }>();

const inUse = computed(() => (props.asset.usedBy?.length ?? 0) > 0);
const isVideo = computed(() => props.asset.kind === 'video');
const uploading = computed(() => props.asset.status === 'uploading' || props.progress != null);
</script>

<template>
  <Card class="overflow-hidden" :class="selected ? 'ring-2 ring-brand-500' : ''">
    <template #header>
      <div class="relative aspect-square w-full overflow-hidden bg-muted">
        <Skeleton v-if="!url && asset.status !== 'error'" width="100%" height="100%" border-radius="0" />
        <img
          v-else-if="url && !isVideo"
          :src="url"
          :alt="asset.fileName"
          loading="lazy"
          decoding="async"
          class="h-full w-full object-cover"
        />
        <video v-else-if="url && isVideo" :src="url" muted playsinline preload="metadata" class="h-full w-full object-cover" />
        <div v-else class="flex h-full items-center justify-center">
          <i class="pi pi-exclamation-triangle text-2xl text-bad" aria-hidden="true" />
        </div>

        <Checkbox
          v-if="selectable"
          :model-value="selected"
          binary
          class="absolute left-2 top-2"
          :aria-label="`Select ${asset.fileName}`"
          @update:model-value="emit('select', asset.id)"
        />

        <Tag
          v-if="isVideo && asset.durationSec"
          :value="formatDuration(asset.durationSec)"
          severity="contrast"
          class="absolute bottom-2 right-2"
        />
        <Tag v-if="inUse" icon="pi pi-link" value="In use" severity="info" class="absolute bottom-2 left-2" />

        <div v-if="uploading" class="absolute inset-x-0 bottom-0">
          <ProgressBar :value="progress ?? 0" :show-value="false" style="height: 4px" />
        </div>
      </div>
    </template>

    <template #content>
      <p class="truncate text-xs font-medium text-ink" :title="asset.fileName">{{ asset.fileName }}</p>
      <p class="text-xs text-ink-soft">{{ formatBytes(asset.size) }}</p>
    </template>

    <template #footer>
      <div class="flex justify-end gap-1">
        <Button icon="pi pi-eye" text rounded size="small" aria-label="Preview" @click="emit('open', asset.id)" />
        <Button
          icon="pi pi-trash"
          text
          rounded
          size="small"
          severity="danger"
          :disabled="inUse"
          :title="inUse ? 'Used by a post — remove it there first' : 'Delete'"
          aria-label="Delete"
          @click="emit('remove', asset.id)"
        />
      </div>
    </template>
  </Card>
</template>

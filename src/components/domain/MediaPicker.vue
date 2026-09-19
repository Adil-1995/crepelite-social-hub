<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { collection, orderBy } from 'firebase/firestore';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Skeleton from 'primevue/skeleton';
import ProgressBar from 'primevue/progressbar';
import Message from 'primevue/message';
import type { MediaAsset } from '@shared/index';
import { db } from '@/app/firebase';
import { usePagedQuery } from '@/composables/useFirestore';
import { useWorkspaceStore } from '@/stores/workspace';
import { useMediaUrls } from '@/composables/useMediaUrls';
import { useMediaUpload } from '@/composables/useMediaUpload';
import { formatDuration } from '@/lib/format';
import EmptyState from '@/components/domain/EmptyState.vue';

/**
 * Library picker used by the composer and the bulk planner.
 *
 * Selection order is preserved — it is the carousel order the networks receive.
 */
const visible = defineModel<boolean>('visible', { required: true });
const props = withDefaults(defineProps<{ selected: string[]; max?: number }>(), { max: 35 });
const emit = defineEmits<{ confirm: [ids: string[]] }>();

const ws = useWorkspaceStore();
const { previewUrl } = useMediaUrls();
const uploads = useMediaUpload(() => ws.workspaceId);
const fileInput = ref<HTMLInputElement | null>(null);
const picked = ref<string[]>([]);

const { items, loading, done, loadMore, reset } = usePagedQuery<MediaAsset>(
  () =>
    ws.workspaceId
      ? { base: collection(db, `workspaces/${ws.workspaceId}/mediaAssets`), constraints: [orderBy('createdAt', 'desc')] }
      : null,
  24,
  [() => ws.workspaceId],
);

watch(visible, (open) => {
  if (open) picked.value = [...props.selected];
});

const atLimit = computed(() => picked.value.length >= props.max);

function toggle(id: string) {
  const i = picked.value.indexOf(id);
  if (i >= 0) picked.value.splice(i, 1);
  else if (!atLimit.value) picked.value.push(id);
}

function orderOf(id: string): number {
  return picked.value.indexOf(id) + 1;
}

function pickFiles() {
  fileInput.value?.click();
}

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length) return;
  const ids = await uploads.add(files);
  reset();
  for (const id of ids) if (!atLimit.value) picked.value.push(id);
}

function confirm() {
  emit('confirm', [...picked.value]);
  visible.value = false;
}

const activeUploads = computed(() => uploads.items.filter((i) => i.state !== 'done'));
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    header="Choose media"
    :style="{ width: 'min(52rem, calc(100vw - 2rem))' }"
    :breakpoints="{ '960px': '95vw' }"
  >
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-2">
        <Button label="Upload" icon="pi pi-upload" size="small" :loading="uploads.uploading.value" @click="pickFiles" />
        <input ref="fileInput" type="file" accept="image/*,video/*" multiple class="hidden" @change="onFiles" />
        <span class="text-sm text-ink-muted">{{ picked.length }} of {{ max }} selected</span>
      </div>

      <Message v-if="atLimit" severity="info" :closable="false" size="small">
        You have reached the maximum of {{ max }} files for one post.
      </Message>

      <ul v-if="activeUploads.length" class="flex flex-col gap-2">
        <li v-for="u in activeUploads" :key="u.id" class="flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-xs text-ink-muted">{{ u.name }}</span>
          <ProgressBar
            v-if="u.state === 'uploading'"
            :value="u.progress"
            :show-value="false"
            style="height: 6px; width: 8rem"
          />
          <span v-else-if="u.state === 'error'" class="text-xs text-bad">{{ u.error }}</span>
          <span v-else class="text-xs text-ink-soft">…</span>
        </li>
      </ul>

      <div v-if="loading && !items.length" class="grid grid-cols-3 gap-2 sm:grid-cols-5">
        <Skeleton v-for="i in 10" :key="i" height="6rem" />
      </div>

      <EmptyState
        v-else-if="!items.length"
        icon="pi pi-images"
        title="Nothing in the library yet"
        message="Upload a photo or video to use it in this post."
        action-label="Upload media"
        action-icon="pi pi-upload"
        @action="pickFiles"
      />

      <ul v-else class="grid max-h-[50vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-5">
        <li v-for="a in items" :key="a.id">
          <button
            type="button"
            class="relative block aspect-square w-full overflow-hidden rounded-lg border-2 transition-colors"
            :class="picked.includes(a.id) ? 'border-brand-500' : 'border-transparent hover:border-line'"
            :aria-pressed="picked.includes(a.id)"
            :aria-label="a.fileName"
            :disabled="!picked.includes(a.id) && atLimit"
            @click="toggle(a.id)"
          >
            <img
              v-if="previewUrl(a)"
              :src="previewUrl(a) ?? undefined"
              :alt="a.fileName"
              loading="lazy"
              class="h-full w-full object-cover"
            />
            <span v-else class="flex h-full items-center justify-center bg-muted">
              <i :class="a.kind === 'video' ? 'pi pi-video' : 'pi pi-image'" class="text-ink-soft" aria-hidden="true" />
            </span>

            <span
              v-if="picked.includes(a.id)"
              class="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white"
            >
              {{ orderOf(a.id) }}
            </span>
            <span
              v-if="a.kind === 'video' && a.durationSec"
              class="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] text-white"
            >
              {{ formatDuration(a.durationSec) }}
            </span>
          </button>
        </li>
      </ul>

      <div v-if="items.length && !done" class="flex justify-center">
        <Button label="Load more" size="small" text :loading="loading" @click="loadMore" />
      </div>
    </div>

    <template #footer>
      <Button label="Cancel" severity="secondary" outlined @click="visible = false" />
      <Button label="Use selection" icon="pi pi-check" @click="confirm" />
    </template>
  </Dialog>
</template>

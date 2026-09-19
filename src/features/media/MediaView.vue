<script setup lang="ts">
import { computed, ref } from 'vue';
import { collection, orderBy, where } from 'firebase/firestore';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import Skeleton from 'primevue/skeleton';
import Dialog from 'primevue/dialog';
import ProgressBar from 'primevue/progressbar';
import Message from 'primevue/message';
import Card from 'primevue/card';
import IconField from 'primevue/iconfield';
import InputIcon from 'primevue/inputicon';
import type { MediaAsset } from '@shared/index';
import { db } from '@/app/firebase';
import { usePagedQuery } from '@/composables/useFirestore';
import { useWorkspaceStore } from '@/stores/workspace';
import { useMediaUpload } from '@/composables/useMediaUpload';
import { useMediaUrls } from '@/composables/useMediaUrls';
import { useFeedback } from '@/composables/useFeedback';
import { api } from '@/services/api';
import { formatBytes, formatDateTime, formatDuration } from '@/lib/format';
import MediaAssetCard from '@/components/domain/MediaAssetCard.vue';
import EmptyState from '@/components/domain/EmptyState.vue';
import ErrorState from '@/components/domain/ErrorState.vue';

/**
 * Media library. Uploads use the Firebase resumable protocol (see
 * `useMediaUpload`); PrimeVue supplies every surrounding control.
 */
const ws = useWorkspaceStore();
const { previewUrl, urlFor } = useMediaUrls();
const { success, reportApiError, confirmDestructive } = useFeedback();
const uploads = useMediaUpload(() => ws.workspaceId);

const search = ref('');
const kind = ref<string | null>(null);
const preview = ref<MediaAsset | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const kindOptions = [
  { label: 'All media', value: null },
  { label: 'Images', value: 'image' },
  { label: 'Videos', value: 'video' },
];

const canWrite = computed(() => ws.can('media.write'));

const { items, loading, done, error, loadMore, reset, removeLocal } = usePagedQuery<MediaAsset>(
  () => {
    if (!ws.workspaceId) return null;
    const base = collection(db, `workspaces/${ws.workspaceId}/mediaAssets`);
    const constraints = kind.value
      ? [where('kind', '==', kind.value), orderBy('createdAt', 'desc')]
      : [orderBy('createdAt', 'desc')];
    return { base, constraints };
  },
  24,
  [() => ws.workspaceId, kind],
);

/**
 * Filename filter is applied to the loaded pages rather than as a query:
 * Firestore has no substring operator, and the alternative (a keyword array)
 * would cost a write amplification the library does not need.
 */
const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return items.value;
  return items.value.filter((a) => a.fileName.toLowerCase().includes(q));
});

function pickFiles() {
  fileInput.value?.click();
}

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length) return;
  const ids = await uploads.add(files);
  if (ids.length) {
    success(`${ids.length} ${ids.length === 1 ? 'file' : 'files'} uploaded`);
    reset();
  }
}

async function remove(id: string) {
  const asset = items.value.find((a) => a.id === id);
  if (!asset || !ws.workspaceId) return;
  const ok = await confirmDestructive({
    header: 'Delete this file?',
    message: `"${asset.fileName}" will be removed permanently. This cannot be undone.`,
    acceptLabel: 'Delete',
  });
  if (!ok) return;
  try {
    await api.deleteMedia({ workspaceId: ws.workspaceId, mediaId: id });
    success('File deleted');
    // Drop it locally: a re-query can still be answered from the Firestore
    // cache, which knows nothing about a server-side delete.
    removeLocal(id);
  } catch (e) {
    reportApiError(e, 'Could not delete the file');
  }
}

const activeUploads = computed(() => uploads.items.filter((i) => i.state !== 'done'));
</script>

<template>
  <div class="flex flex-col gap-4 p-3 lg:p-6">
    <!-- Controls -->
    <div class="flex flex-wrap items-center gap-2">
      <IconField class="min-w-0 flex-1">
        <InputIcon class="pi pi-search" />
        <InputText v-model="search" placeholder="Search filenames" fluid aria-label="Search media" />
      </IconField>

      <Select
        v-model="kind"
        :options="kindOptions"
        option-label="label"
        option-value="value"
        class="w-40"
        aria-label="Filter by type"
      />

      <Button
        label="Upload"
        icon="pi pi-upload"
        :disabled="!canWrite"
        :loading="uploads.uploading.value"
        @click="pickFiles"
      />
      <input
        ref="fileInput"
        type="file"
        aria-label="Choose images or videos to upload"
        accept="image/*,video/*"
        multiple
        class="hidden"
        @change="onFiles"
      />
    </div>

    <Message v-if="!canWrite" severity="info" :closable="false">
      You can browse the library, but uploading needs editor access.
    </Message>

    <!-- In-flight uploads -->
    <Card v-if="activeUploads.length">
      <template #content>
        <div class="mb-2 flex items-center justify-between">
          <p class="text-sm font-semibold text-ink">Uploading</p>
          <Button label="Clear finished" text size="small" @click="uploads.clearFinished()" />
        </div>
        <ul class="flex flex-col gap-3">
          <li v-for="u in activeUploads" :key="u.id" class="flex items-center gap-3">
            <i :class="u.kind === 'video' ? 'pi pi-video' : 'pi pi-image'" class="text-ink-soft" aria-hidden="true" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm text-ink">{{ u.name }}</p>
              <ProgressBar
                v-if="u.state === 'uploading' || u.state === 'probing'"
                :value="u.progress"
                :show-value="false"
                style="height: 6px"
                class="mt-1"
              />
              <p v-else-if="u.state === 'registering'" class="text-xs text-ink-soft">Finalising…</p>
              <p v-else-if="u.state === 'error'" class="text-xs text-bad">{{ u.error }}</p>
              <p v-else-if="u.state === 'cancelled'" class="text-xs text-ink-soft">Cancelled</p>
            </div>
            <Button
              v-if="u.state === 'uploading'"
              icon="pi pi-times"
              text
              rounded
              severity="secondary"
              size="small"
              aria-label="Cancel upload"
              @click="uploads.cancel(u.id)"
            />
            <Button
              v-else
              icon="pi pi-trash"
              text
              rounded
              severity="secondary"
              size="small"
              aria-label="Dismiss"
              @click="uploads.dismiss(u.id)"
            />
          </li>
        </ul>
      </template>
    </Card>

    <ErrorState v-if="error" :message="error.message" @retry="reset" />

    <template v-else>
      <div v-if="loading && !items.length" class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Skeleton v-for="i in 8" :key="i" height="12rem" />
      </div>

      <EmptyState
        v-else-if="!visible.length"
        icon="pi pi-images"
        :title="search ? 'No files match that search' : 'Your library is empty'"
        :message="
          search
            ? 'Try a different filename.'
            : 'Upload the photos and videos you want to publish. They stay here for reuse across posts.'
        "
        :action-label="search ? undefined : 'Upload media'"
        action-icon="pi pi-upload"
        :disabled="!canWrite"
        @action="pickFiles"
      />

      <template v-else>
        <ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <li v-for="a in visible" :key="a.id">
            <MediaAssetCard :asset="a" :url="previewUrl(a)" @open="preview = a" @remove="remove" />
          </li>
        </ul>

        <div class="flex justify-center">
          <Button
            v-if="!done"
            label="Load more"
            icon="pi pi-chevron-down"
            severity="secondary"
            outlined
            :loading="loading"
            @click="loadMore"
          />
        </div>
      </template>
    </template>

    <!-- Preview -->
    <Dialog
      :visible="preview !== null"
      modal
      :header="preview?.fileName"
      :style="{ width: 'min(52rem, calc(100vw - 2rem))' }"
      :dismissable-mask="true"
      @update:visible="preview = null"
    >
      <div v-if="preview" class="flex flex-col gap-3">
        <div class="flex max-h-[60vh] items-center justify-center overflow-hidden rounded-lg bg-muted">
          <img
            v-if="preview.kind === 'image'"
            :src="urlFor(preview.storagePath) ?? undefined"
            :alt="preview.fileName"
            class="max-h-[60vh] w-auto object-contain"
          />
          <video
            v-else
            :src="urlFor(preview.storagePath) ?? undefined"
            controls
            playsinline
            class="max-h-[60vh] w-auto"
          />
        </div>

        <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt class="text-ink-soft">Type</dt>
          <dd class="text-ink">{{ preview.mimeType }}</dd>
          <dt class="text-ink-soft">Size</dt>
          <dd class="text-ink">{{ formatBytes(preview.size) }}</dd>
          <template v-if="preview.width && preview.height">
            <dt class="text-ink-soft">Dimensions</dt>
            <dd class="text-ink">{{ preview.width }} × {{ preview.height }}</dd>
          </template>
          <template v-if="preview.durationSec">
            <dt class="text-ink-soft">Duration</dt>
            <dd class="text-ink">{{ formatDuration(preview.durationSec) }}</dd>
          </template>
          <dt class="text-ink-soft">Uploaded</dt>
          <dd class="text-ink">{{ formatDateTime(preview.createdAt, ws.timezone) }}</dd>
          <dt class="text-ink-soft">Used by</dt>
          <dd class="text-ink">
            {{ preview.usedBy?.length ?? 0 }} {{ (preview.usedBy?.length ?? 0) === 1 ? 'post' : 'posts' }}
          </dd>
        </dl>
      </div>
    </Dialog>
  </div>
</template>

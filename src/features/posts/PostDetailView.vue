<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { collection, orderBy, query, where } from 'firebase/firestore';
import Card from 'primevue/card';
import Button from 'primevue/button';
import Skeleton from 'primevue/skeleton';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import DatePicker from 'primevue/datepicker';
import Dialog from 'primevue/dialog';
import type { Delivery, Post } from '@shared/index';
import { db } from '@/app/firebase';
import { useLiveDoc, useLiveQuery } from '@/composables/useFirestore';
import { useWorkspaceStore } from '@/stores/workspace';
import { useProvidersStore } from '@/stores/providers';
import { usePostActions } from '@/composables/usePostActions';
import { formatDateTime, fromPickerDate, toPickerDate } from '@/lib/format';
import DeliveryStatusTag from '@/components/domain/DeliveryStatusTag.vue';
import PostStatusTag from '@/components/domain/PostStatusTag.vue';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';
import ScheduleSummary from '@/components/domain/ScheduleSummary.vue';
import ErrorState from '@/components/domain/ErrorState.vue';

/**
 * A single post and its per-destination deliveries.
 *
 * Deliveries are independent: one failing network never blocks the others, and
 * retrying one never republishes the ones that already succeeded.
 */
const props = defineProps<{ postId: string }>();
const ws = useWorkspaceStore();
const providers = useProvidersStore();
const router = useRouter();
const actions = usePostActions();

const rescheduleOpen = ref(false);
const rescheduleAt = ref<Date | null>(null);
const busy = ref(false);

const postDoc = useLiveDoc<Post>(
  () => (ws.workspaceId ? `workspaces/${ws.workspaceId}/posts/${props.postId}` : null),
  [() => ws.workspaceId, () => props.postId],
);

const deliveriesQ = useLiveQuery<Delivery>(
  () =>
    ws.workspaceId
      ? query(
          collection(db, `workspaces/${ws.workspaceId}/deliveries`),
          where('postId', '==', props.postId),
          orderBy('scheduledAt', 'asc'),
        )
      : null,
  [() => ws.workspaceId, () => props.postId],
);

const post = computed(() => postDoc.data.value);
const deliveries = computed(() => deliveriesQ.items.value);

const channelName = (id: string) => ws.channels.find((c) => c.id === id)?.name ?? 'Unknown destination';
const providerName = (id: string) => providers.manifest(id)?.displayName ?? id;

const canEdit = computed(
  () => ws.can('content.write') && post.value && post.value.status !== 'published' && post.value.status !== 'publishing',
);

async function retry(d: Delivery) {
  busy.value = true;
  try {
    await actions.retryDelivery(d);
  } finally {
    busy.value = false;
  }
}

function openReschedule() {
  rescheduleAt.value = toPickerDate(post.value?.calendarAt ?? null, ws.timezone) ?? new Date(Date.now() + 3600_000);
  rescheduleOpen.value = true;
}

async function confirmReschedule() {
  const ms = fromPickerDate(rescheduleAt.value, ws.timezone);
  if (!ms || !post.value) return;
  busy.value = true;
  try {
    if (await actions.schedule(post.value, ms)) rescheduleOpen.value = false;
  } finally {
    busy.value = false;
  }
}

async function cancelSchedule() {
  if (post.value) await actions.cancel(post.value);
}

async function publishNow() {
  if (post.value) await actions.publishNow(post.value);
}

function openExternal(url: string | null) {
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

async function remove() {
  if (post.value && (await actions.remove(post.value))) await router.push('/posts');
}
</script>

<template>
  <div class="flex flex-col gap-4 p-3 lg:p-6">
    <div v-if="postDoc.loading.value" class="flex flex-col gap-3">
      <Skeleton height="3rem" />
      <Skeleton height="12rem" />
      <Skeleton height="8rem" />
    </div>

    <ErrorState
      v-else-if="postDoc.error.value"
      :message="postDoc.error.value.message"
      :retryable="false"
    />

    <Card v-else-if="!post">
      <template #content>
        <div class="flex flex-col items-center gap-3 py-8 text-center">
          <i class="pi pi-file text-3xl text-ink-soft" aria-hidden="true" />
          <p class="font-semibold text-ink">This post no longer exists</p>
          <Button label="Back to posts" icon="pi pi-arrow-left" @click="router.push('/posts')" />
        </div>
      </template>
    </Card>

    <template v-else>
      <!-- Header -->
      <div class="flex flex-wrap items-start gap-3">
        <Button icon="pi pi-arrow-left" text rounded severity="secondary" aria-label="Back" @click="router.back()" />
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-lg font-semibold text-ink">
            {{ post.titleInternal || 'Untitled post' }}
          </h1>
          <div class="mt-1 flex flex-wrap items-center gap-2">
            <PostStatusTag :status="post.status" />
            <Tag v-if="post.source?.kind && post.source.kind !== 'manual'" :value="post.source.kind" severity="secondary" />
          </div>
        </div>
      </div>

      <!-- Actions -->
      <div class="flex flex-wrap gap-2">
        <Button
          v-if="canEdit"
          label="Edit"
          icon="pi pi-pencil"
          @click="router.push(`/compose/${post.id}`)"
        />
        <Button
          v-if="ws.can('content.schedule') && post.status === 'draft'"
          label="Publish now"
          icon="pi pi-send"
          severity="secondary"
          @click="publishNow"
        />
        <Button
          v-if="ws.can('content.schedule') && actions.hasPending(post)"
          label="Reschedule"
          icon="pi pi-calendar"
          severity="secondary"
          outlined
          @click="openReschedule"
        />
        <Button
          v-if="ws.can('content.schedule') && actions.hasPending(post)"
          label="Cancel schedule"
          icon="pi pi-ban"
          severity="secondary"
          outlined
          @click="cancelSchedule"
        />
        <Button
          v-if="ws.can('content.write')"
          label="Delete"
          icon="pi pi-trash"
          severity="danger"
          outlined
          class="ml-auto"
          @click="remove"
        />
      </div>

      <Message v-if="post.status === 'partially_published'" severity="warn" :closable="false">
        Some destinations published and others did not. Retry only the failed ones below — the successful
        destinations are never republished.
      </Message>

      <!-- Schedule -->
      <Card>
        <template #title><span class="text-sm">Schedule</span></template>
        <template #content>
          <ScheduleSummary :scheduled-at="post.calendarAt" :channel-count="deliveries.length" />
        </template>
      </Card>

      <!-- Content -->
      <Card>
        <template #title><span class="text-sm">Content</span></template>
        <template #content>
          <div class="flex flex-col gap-3">
            <div v-if="post.masterContent?.title">
              <p class="text-xs font-medium text-ink-soft">Title</p>
              <p class="text-sm text-ink">{{ post.masterContent.title }}</p>
            </div>
            <div v-if="post.masterContent?.text">
              <p class="text-xs font-medium text-ink-soft">Caption</p>
              <p class="whitespace-pre-wrap text-sm text-ink">{{ post.masterContent.text }}</p>
            </div>
            <div v-if="post.masterContent?.hashtags?.length" class="flex flex-wrap gap-1">
              <Tag v-for="h in post.masterContent.hashtags" :key="h" :value="`#${h}`" severity="secondary" />
            </div>
            <div v-if="post.masterContent?.link">
              <p class="text-xs font-medium text-ink-soft">Link</p>
              <a :href="post.masterContent.link" target="_blank" rel="noopener noreferrer" class="text-sm text-info underline">
                {{ post.masterContent.link }}
              </a>
            </div>
            <p v-if="post.mediaIds?.length" class="text-xs text-ink-soft">
              {{ post.mediaIds.length }} media {{ post.mediaIds.length === 1 ? 'file' : 'files' }} attached
            </p>
          </div>
        </template>
      </Card>

      <!-- Deliveries -->
      <Card>
        <template #title><span class="text-sm">Destinations</span></template>
        <template #content>
          <div v-if="deliveriesQ.loading.value" class="flex flex-col gap-2">
            <Skeleton v-for="i in 2" :key="i" height="3rem" />
          </div>

          <p v-else-if="!deliveries.length" class="py-4 text-sm text-ink-soft">
            This post has no destinations yet. Edit it to choose where it goes.
          </p>

          <ul v-else class="flex flex-col divide-y divide-line">
            <li v-for="d in deliveries" :key="d.id" class="flex flex-col gap-2 py-3">
              <div class="flex items-center gap-3">
                <ProviderIcon :provider="d.provider" :size="22" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-ink">{{ channelName(d.channelId) }}</p>
                  <p class="truncate text-xs text-ink-soft">
                    {{ providerName(d.provider) }} · {{ formatDateTime(d.scheduledAt, ws.timezone) }}
                  </p>
                </div>
                <DeliveryStatusTag :status="d.status" />
              </div>

              <Message v-if="d.error" severity="error" :closable="false" size="small">
                <span class="text-xs">{{ d.error.message }}</span>
              </Message>

              <div class="flex flex-wrap gap-2">
                <Button
                  v-if="d.externalPostUrl"
                  label="View on network"
                  icon="pi pi-external-link"
                  size="small"
                  text
                  @click="openExternal(d.externalPostUrl)"
                />
                <Button
                  v-if="(d.status === 'failed' || d.status === 'needs_reauth') && ws.can('content.schedule')"
                  label="Retry this destination"
                  icon="pi pi-refresh"
                  size="small"
                  severity="secondary"
                  outlined
                  :loading="busy"
                  @click="retry(d)"
                />
                <span v-if="d.attemptCount > 1" class="self-center text-xs text-ink-soft">
                  {{ d.attemptCount }} attempts
                </span>
              </div>
            </li>
          </ul>
        </template>
      </Card>
    </template>

    <!-- Reschedule -->
    <Dialog
      v-model:visible="rescheduleOpen"
      modal
      header="Reschedule post"
      :style="{ width: 'min(26rem, calc(100vw - 2rem))' }"
    >
      <div class="flex flex-col gap-3">
        <label for="reschedule-at" class="text-sm font-medium text-ink">New date and time</label>
        <DatePicker
          input-id="reschedule-at"
          v-model="rescheduleAt"
          show-time
          hour-format="24"
          :min-date="new Date()"
          date-format="d M yy"
          fluid
        />
        <p class="text-xs text-ink-soft">Times are in {{ ws.timezone }}.</p>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" outlined @click="rescheduleOpen = false" />
        <Button label="Reschedule" icon="pi pi-check" :loading="busy" @click="confirmReschedule" />
      </template>
    </Dialog>
  </div>
</template>

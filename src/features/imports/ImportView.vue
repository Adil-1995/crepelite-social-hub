<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { DateTime } from 'luxon';
import Card from 'primevue/card';
import Button from 'primevue/button';
import Select from 'primevue/select';
import DatePicker from 'primevue/datepicker';
import Message from 'primevue/message';
import Skeleton from 'primevue/skeleton';
import Checkbox from 'primevue/checkbox';
import Tag from 'primevue/tag';
import type { ImportCandidate } from '@shared/index';
import { useWorkspaceStore } from '@/stores/workspace';
import { useProvidersStore } from '@/stores/providers';
import { api } from '@/services/api';
import { useFeedback } from '@/composables/useFeedback';
import { formatDate, truncate } from '@/lib/format';
import SocialNetworkSelector from '@/components/domain/SocialNetworkSelector.vue';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';
import EmptyState from '@/components/domain/EmptyState.vue';

/**
 * Import your own published posts and crosspost them elsewhere.
 *
 * Everything comes from the providers' official read APIs — nothing is ever
 * scraped. Where a network does not let the original media be retrieved, the
 * draft is created with a note so the file can be attached by hand.
 */
const ws = useWorkspaceStore();
const providers = useProvidersStore();
const router = useRouter();
const { success, warn, reportApiError } = useFeedback();

const sourceChannelId = ref<string | null>(null);
const fromDate = ref<Date>(DateTime.now().minus({ days: 30 }).toJSDate());
const toDate = ref<Date>(new Date());
const fetching = ref(false);
const importing = ref(false);
const importJobId = ref<string | null>(null);
const candidates = ref<ImportCandidate[]>([]);
const selected = ref<string[]>([]);
const destinationChannelIds = ref<string[]>([]);
const fetched = ref(false);

/** Only channels whose provider can read back its own posts. */
const readableChannels = computed(() =>
  ws.activeChannels
    .filter((c) => providers.manifest(c.provider)?.capabilities.canReadPosts)
    .map((c) => ({
      label: `${c.name} · ${providers.manifest(c.provider)?.displayName ?? c.provider}`,
      value: c.id,
      provider: c.provider,
    })),
);

const sourceChannel = computed(() => ws.channels.find((c) => c.id === sourceChannelId.value));
const sourceManifest = computed(() => (sourceChannel.value ? providers.manifest(sourceChannel.value.provider) : undefined));

const localDate = (d: Date) => DateTime.fromJSDate(d).setZone(ws.timezone, { keepLocalTime: true }).toFormat('yyyy-MM-dd');

const canFetch = computed(() => !!sourceChannelId.value && !fetching.value);
const canImport = computed(() => selected.value.length > 0 && !!importJobId.value && !importing.value);

async function fetchCandidates() {
  if (!ws.workspaceId || !sourceChannelId.value) return;
  fetching.value = true;
  fetched.value = false;
  try {
    const res = await api.fetchImportCandidates({
      workspaceId: ws.workspaceId,
      channelId: sourceChannelId.value,
      from: localDate(fromDate.value),
      to: localDate(toDate.value),
      timezone: ws.timezone,
    });
    importJobId.value = res.importJobId;
    candidates.value = res.candidates;
    selected.value = [];
    fetched.value = true;
    if (!res.candidates.length) warn('Nothing found', 'No posts were returned for that period.');
  } catch (e) {
    reportApiError(e, 'Could not fetch your posts');
  } finally {
    fetching.value = false;
  }
}

function toggleAll() {
  selected.value = selected.value.length === candidates.value.length ? [] : candidates.value.map((c) => c.externalPostId);
}

async function runImport() {
  if (!ws.workspaceId || !importJobId.value) return;
  importing.value = true;
  try {
    const res = await api.importPosts({
      workspaceId: ws.workspaceId,
      importJobId: importJobId.value,
      externalPostIds: selected.value,
      destinationChannelIds: destinationChannelIds.value,
      schedule: null,
    });
    const needsManual = res.drafts.filter((d) => !d.mediaReady).length;
    success(
      `${res.drafts.length} ${res.drafts.length === 1 ? 'draft' : 'drafts'} created`,
      needsManual ? `${needsManual} need their media uploaded manually.` : undefined,
    );
    await router.push('/posts?status=draft');
  } catch (e) {
    reportApiError(e, 'Could not import the posts');
  } finally {
    importing.value = false;
  }
}

const mediaWarnings = computed(() => candidates.value.filter((c) => selected.value.includes(c.externalPostId) && !c.mediaRetrievable).length);
</script>

<template>
  <div class="flex flex-col gap-4 p-3 lg:p-6">
    <Message severity="secondary" :closable="false">
      Imports use each network's official API to read back your own posts. Nothing is scraped, and only accounts
      you have connected can be read.
    </Message>

    <EmptyState
      v-if="!readableChannels.length"
      icon="pi pi-download"
      title="No account can be imported from"
      message="None of your connected networks support reading your own posts back, or nothing is connected yet."
      action-label="Go to connections"
      action-icon="pi pi-arrow-right"
      @action="router.push('/connections')"
    />

    <template v-else>
      <!-- Source -->
      <Card>
        <template #title><span class="text-sm">Where to import from</span></template>
        <template #content>
          <div class="flex flex-col gap-4">
            <div class="flex flex-col gap-1.5">
              <label for="import-source" class="text-sm font-medium text-ink">Account</label>
              <Select
                id="import-source"
                v-model="sourceChannelId"
                :options="readableChannels"
                option-label="label"
                option-value="value"
                placeholder="Choose an account"
                fluid
              >
                <template #option="{ option }">
                  <div class="flex items-center gap-2">
                    <ProviderIcon :provider="option.provider" :size="16" />
                    <span>{{ option.label }}</span>
                  </div>
                </template>
              </Select>
            </div>

            <div class="grid gap-4 sm:grid-cols-2">
              <div class="flex flex-col gap-1.5">
                <label for="import-from" class="text-sm font-medium text-ink">From</label>
                <DatePicker id="import-from" v-model="fromDate" date-format="d M yy" :max-date="toDate" fluid />
              </div>
              <div class="flex flex-col gap-1.5">
                <label for="import-to" class="text-sm font-medium text-ink">To</label>
                <DatePicker id="import-to" v-model="toDate" date-format="d M yy" :max-date="new Date()" fluid />
              </div>
            </div>

            <Message
              v-if="sourceManifest && !sourceManifest.capabilities.importMediaRetrievable"
              severity="warn"
              :closable="false"
              size="small"
            >
              {{ sourceManifest.displayName }} does not allow the original media to be downloaded through its API.
              Drafts will be created with the text, and you will need to upload the media manually.
            </Message>

            <Button
              label="Find my posts"
              icon="pi pi-search"
              :disabled="!canFetch"
              :loading="fetching"
              class="self-start"
              @click="fetchCandidates"
            />
          </div>
        </template>
      </Card>

      <!-- Candidates -->
      <div v-if="fetching" class="flex flex-col gap-3">
        <Skeleton v-for="i in 4" :key="i" height="5rem" />
      </div>

      <template v-else-if="fetched">
        <EmptyState
          v-if="!candidates.length"
          icon="pi pi-inbox"
          title="No posts in that period"
          message="Try widening the date range."
        />

        <Card v-else>
          <template #title>
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm">{{ candidates.length }} posts found</span>
              <Button
                :label="selected.length === candidates.length ? 'Clear all' : 'Select all'"
                size="small"
                text
                @click="toggleAll"
              />
            </div>
          </template>
          <template #content>
            <ul class="flex flex-col divide-y divide-line">
              <li v-for="c in candidates" :key="c.externalPostId" class="py-3">
                <label class="flex cursor-pointer items-start gap-3">
                  <Checkbox v-model="selected" :value="c.externalPostId" :input-id="`c-${c.externalPostId}`" />

                  <span
                    v-if="c.thumbnailUrl"
                    class="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-muted"
                  >
                    <img :src="c.thumbnailUrl" alt="" loading="lazy" class="h-full w-full object-cover" />
                  </span>
                  <span v-else class="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <i class="pi pi-file text-ink-soft" aria-hidden="true" />
                  </span>

                  <span class="min-w-0 flex-1">
                    <span class="block text-sm text-ink">{{ truncate(c.text || 'No caption', 120) }}</span>
                    <span class="mt-1 flex flex-wrap items-center gap-2">
                      <Tag :value="c.mediaType" severity="secondary" />
                      <span class="text-xs text-ink-soft">{{ formatDate(new Date(c.publishedAt), ws.timezone) }}</span>
                      <Tag
                        v-if="!c.mediaRetrievable"
                        value="Upload media manually"
                        severity="warn"
                        icon="pi pi-exclamation-triangle"
                      />
                    </span>
                    <span v-if="c.mediaNote" class="mt-1 block text-xs text-warn">{{ c.mediaNote }}</span>
                  </span>
                </label>
              </li>
            </ul>
          </template>
        </Card>

        <!-- Destinations -->
        <Card v-if="selected.length">
          <template #title><span class="text-sm">Crosspost to (optional)</span></template>
          <template #content>
            <p class="mb-3 text-xs text-ink-muted">
              Leave this empty to import as plain drafts, or choose destinations to prepare them for crossposting.
            </p>
            <SocialNetworkSelector v-model="destinationChannelIds" :show-unavailable="false" />
          </template>
        </Card>

        <div v-if="selected.length" class="sticky bottom-20 flex flex-col gap-2 lg:bottom-4">
          <Message v-if="mediaWarnings" severity="warn" :closable="false" size="small">
            {{ mediaWarnings }} of the selected posts need their media uploaded manually after import.
          </Message>
          <Button
            :label="`Import ${selected.length} ${selected.length === 1 ? 'post' : 'posts'}`"
            icon="pi pi-download"
            :disabled="!canImport"
            :loading="importing"
            fluid
            @click="runImport"
          />
        </div>
      </template>
    </template>
  </div>
</template>

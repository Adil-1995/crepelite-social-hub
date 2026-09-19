<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import Chips from 'primevue/autocomplete';
import DatePicker from 'primevue/datepicker';
import Card from 'primevue/card';
import Message from 'primevue/message';
import Skeleton from 'primevue/skeleton';
import Tag from 'primevue/tag';
import Stepper from 'primevue/stepper';
import StepList from 'primevue/steplist';
import Step from 'primevue/step';
import StepPanels from 'primevue/steppanels';
import StepPanel from 'primevue/steppanel';
import { useComposer } from '@/composables/useComposer';
import { useWorkspaceStore } from '@/stores/workspace';
import { useMediaUrls } from '@/composables/useMediaUrls';
import { useFeedback } from '@/composables/useFeedback';
import { fromPickerDate, toPickerDate, formatDuration } from '@/lib/format';
import SocialNetworkSelector from '@/components/domain/SocialNetworkSelector.vue';
import PlatformVariantEditor from '@/components/domain/PlatformVariantEditor.vue';
import MediaPicker from '@/components/domain/MediaPicker.vue';
import ScheduleSummary from '@/components/domain/ScheduleSummary.vue';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';
import ErrorState from '@/components/domain/ErrorState.vue';

/**
 * Post composer: Media → Content → Platforms → Customise → Schedule → Review.
 *
 * Runs as an immersive route (no app chrome) so the phone keyboard has room.
 */
const props = defineProps<{ postId?: string }>();
const router = useRouter();
const ws = useWorkspaceStore();
const { previewUrl } = useMediaUrls();
const { success, reportApiError, confirmDestructive } = useFeedback();
const c = useComposer(() => props.postId);

const step = ref('1');
const pickerOpen = ref(false);
const hashtagInput = ref<string[]>([]);

const scheduledDate = computed<Date | null>({
  get: () => toPickerDate(c.draft.scheduledAtMs, ws.timezone),
  set: (d) => {
    c.draft.scheduledAtMs = fromPickerDate(d, ws.timezone);
  },
});

onMounted(async () => {
  await c.load();
  hashtagInput.value = [...c.draft.masterContent.hashtags];
  if (c.restoredFromLocal.value) {
    success('Draft restored', 'We recovered unsaved changes from this device.');
  }
});

const steps = [
  { value: '1', label: 'Media', icon: 'pi pi-image' },
  { value: '2', label: 'Content', icon: 'pi pi-pencil' },
  { value: '3', label: 'Platforms', icon: 'pi pi-share-alt' },
  { value: '4', label: 'Customise', icon: 'pi pi-sliders-h' },
  { value: '5', label: 'Schedule', icon: 'pi pi-calendar' },
  { value: '6', label: 'Review', icon: 'pi pi-check-circle' },
];

const channelOf = (id: string) => ws.channels.find((x) => x.id === id);

function onHashtags(values: string[]) {
  c.draft.masterContent.hashtags = values.map((v) => v.replace(/^#+/, '').trim()).filter(Boolean).slice(0, 60);
}

function removeMedia(id: string) {
  c.draft.mediaIds = c.draft.mediaIds.filter((m) => m !== id);
}

function moveMedia(id: string, delta: number) {
  const i = c.draft.mediaIds.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= c.draft.mediaIds.length) return;
  const next = [...c.draft.mediaIds];
  const [item] = next.splice(i, 1);
  if (item) next.splice(j, 0, item);
  c.draft.mediaIds = next;
}

async function onMediaConfirm(ids: string[]) {
  c.draft.mediaIds = ids;
  await c.fetchMedia(ids);
}

const busy = ref(false);

async function saveDraft() {
  busy.value = true;
  try {
    const id = await c.save();
    success('Draft saved');
    await router.replace(`/posts/${id}`);
  } catch (e) {
    reportApiError(e, 'Could not save the draft');
  } finally {
    busy.value = false;
  }
}

async function schedule() {
  busy.value = true;
  try {
    const id = await c.saveAndSchedule();
    success('Post scheduled');
    await router.replace(`/posts/${id}`);
  } catch (e) {
    reportApiError(e, 'Could not schedule the post');
  } finally {
    busy.value = false;
  }
}

async function publishNow() {
  const ok = await confirmDestructive({
    header: 'Publish now?',
    message: 'This sends the post to every selected destination immediately.',
    acceptLabel: 'Publish now',
    icon: 'pi pi-send',
  });
  if (!ok) return;
  busy.value = true;
  try {
    const id = await c.saveAndPublish();
    success('Publishing started');
    await router.replace(`/posts/${id}`);
  } catch (e) {
    reportApiError(e, 'Could not publish the post');
  } finally {
    busy.value = false;
  }
}

async function close() {
  if (c.dirty.value) {
    const leave = await confirmDestructive({
      header: 'Discard unsaved changes?',
      message: 'Your draft is kept on this device, but nothing is saved to the workspace.',
      acceptLabel: 'Leave',
      rejectLabel: 'Keep editing',
    });
    if (!leave) return;
  }
  router.back();
}

let leaveConfirmed = false;
onBeforeRouteLeave(async () => {
  if (!c.dirty.value || leaveConfirmed || busy.value) return true;
  const leave = await confirmDestructive({
    header: 'Leave the composer?',
    message: 'Your draft is kept on this device, but nothing is saved to the workspace.',
    acceptLabel: 'Leave',
    rejectLabel: 'Keep editing',
  });
  leaveConfirmed = leave;
  return leave;
});

const mediaAssets = computed(() =>
  c.draft.mediaIds.map((id) => c.mediaById.get(id)).filter((a): a is NonNullable<typeof a> => !!a),
);

const summaryIssues = computed(() =>
  c.draft.variants.map((v) => ({
    variant: v,
    channel: channelOf(v.channelId),
    issues: c.issuesByChannel.value[v.channelId] ?? [],
  })),
);
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-app">
    <!-- Header -->
    <header class="safe-top sticky top-0 z-10 border-b border-line bg-surface">
      <div class="flex h-14 items-center gap-2 px-3">
        <Button icon="pi pi-times" text rounded severity="secondary" aria-label="Close composer" @click="close" />
        <h1 class="min-w-0 flex-1 truncate text-base font-semibold text-ink">
          {{ props.postId ? 'Edit post' : 'New post' }}
        </h1>
        <Button
          label="Save draft"
          icon="pi pi-save"
          size="small"
          severity="secondary"
          outlined
          :loading="busy || c.saving.value"
          @click="saveDraft"
        />
      </div>
    </header>

    <div v-if="c.loading.value" class="flex flex-col gap-3 p-4">
      <Skeleton height="3rem" />
      <Skeleton height="12rem" />
    </div>

    <ErrorState v-else-if="c.loadError.value" :message="c.loadError.value" :retryable="false" />

    <div v-else class="flex-1 pb-8">
      <Stepper v-model:value="step" class="w-full">
        <StepList class="overflow-x-auto scrollbar-none">
          <Step v-for="s in steps" :key="s.value" :value="s.value">
            <span class="whitespace-nowrap">{{ s.label }}</span>
          </Step>
        </StepList>

        <StepPanels>
          <!-- 1 · Media -->
          <StepPanel v-slot="{ activateCallback }" value="1">
            <div class="flex flex-col gap-4 p-3 lg:p-6">
              <div class="flex items-center justify-between gap-2">
                <p class="text-sm text-ink-muted">
                  Choose the photos or videos for this post. The order is the order networks receive them.
                </p>
                <Button label="Choose" icon="pi pi-images" size="small" @click="pickerOpen = true" />
              </div>

              <Card v-if="!mediaAssets.length">
                <template #content>
                  <div class="flex flex-col items-center gap-3 py-8 text-center">
                    <i class="pi pi-image text-3xl text-ink-soft" aria-hidden="true" />
                    <p class="text-sm font-semibold text-ink">No media yet</p>
                    <p class="max-w-xs text-xs text-ink-muted">
                      Some networks accept text-only posts; most need at least one image or video.
                    </p>
                    <Button label="Choose media" icon="pi pi-images" @click="pickerOpen = true" />
                  </div>
                </template>
              </Card>

              <ul v-else class="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                <li v-for="(a, i) in mediaAssets" :key="a.id" class="relative">
                  <div class="aspect-square overflow-hidden rounded-lg bg-muted">
                    <img
                      v-if="previewUrl(a)"
                      :src="previewUrl(a) ?? undefined"
                      :alt="a.fileName"
                      class="h-full w-full object-cover"
                    />
                    <span v-else class="flex h-full items-center justify-center">
                      <i :class="a.kind === 'video' ? 'pi pi-video' : 'pi pi-image'" class="text-ink-soft" aria-hidden="true" />
                    </span>
                  </div>
                  <span
                    v-if="a.kind === 'video' && a.durationSec"
                    class="absolute bottom-9 right-1 rounded bg-black/70 px-1 text-[10px] text-white"
                  >
                    {{ formatDuration(a.durationSec) }}
                  </span>
                  <div class="mt-1 flex items-center justify-center gap-0.5">
                    <Button
                      icon="pi pi-chevron-left"
                      text
                      rounded
                      size="small"
                      :disabled="i === 0"
                      :aria-label="`Move ${a.fileName} earlier`"
                      @click="moveMedia(a.id, -1)"
                    />
                    <Button
                      icon="pi pi-trash"
                      text
                      rounded
                      size="small"
                      severity="danger"
                      :aria-label="`Remove ${a.fileName}`"
                      @click="removeMedia(a.id)"
                    />
                    <Button
                      icon="pi pi-chevron-right"
                      text
                      rounded
                      size="small"
                      :disabled="i === mediaAssets.length - 1"
                      :aria-label="`Move ${a.fileName} later`"
                      @click="moveMedia(a.id, 1)"
                    />
                  </div>
                </li>
              </ul>

              <div class="flex justify-end">
                <Button label="Next" icon="pi pi-arrow-right" icon-pos="right" @click="activateCallback('2')" />
              </div>
            </div>
          </StepPanel>

          <!-- 2 · Content -->
          <StepPanel v-slot="{ activateCallback }" value="2">
            <div class="flex flex-col gap-4 p-3 lg:p-6">
              <div class="flex flex-col gap-1.5">
                <label for="internal-title" class="text-sm font-medium text-ink">Internal title</label>
                <InputText id="internal-title" v-model="c.draft.titleInternal" maxlength="200" fluid />
                <small class="text-ink-soft">Only visible inside CrepeLite — it helps you find the post later.</small>
              </div>

              <div class="flex flex-col gap-1.5">
                <label for="master-text" class="text-sm font-medium text-ink">Caption</label>
                <Textarea id="master-text" v-model="c.draft.masterContent.text" rows="6" auto-resize fluid />
                <small class="text-ink-soft">
                  Each network trims this to its own limit — you will see the exact counts in Customise.
                </small>
              </div>

              <div class="flex flex-col gap-1.5">
                <label for="master-title" class="text-sm font-medium text-ink">Title</label>
                <InputText id="master-title" v-model="c.draft.masterContent.title" maxlength="500" fluid />
                <small class="text-ink-soft">Used by networks that show a separate title, such as video platforms.</small>
              </div>

              <div class="flex flex-col gap-1.5">
                <label for="master-desc" class="text-sm font-medium text-ink">Description</label>
                <Textarea id="master-desc" v-model="c.draft.masterContent.description" rows="4" auto-resize fluid />
              </div>

              <div class="flex flex-col gap-1.5">
                <label for="master-tags" class="text-sm font-medium text-ink">Hashtags</label>
                <Chips
                  input-id="master-tags"
                  v-model="hashtagInput"
                  multiple
                  :typeahead="false"
                  :suggestions="[]"
                  placeholder="Type and press enter"
                  fluid
                  @update:model-value="onHashtags"
                />
              </div>

              <div class="flex flex-col gap-1.5">
                <label for="master-link" class="text-sm font-medium text-ink">Link</label>
                <InputText
                  id="master-link"
                  v-model="c.draft.masterContent.link"
                  type="url"
                  inputmode="url"
                  placeholder="https://"
                  fluid
                />
              </div>

              <div class="flex justify-between">
                <Button label="Back" icon="pi pi-arrow-left" severity="secondary" outlined @click="activateCallback('1')" />
                <Button label="Next" icon="pi pi-arrow-right" icon-pos="right" @click="activateCallback('3')" />
              </div>
            </div>
          </StepPanel>

          <!-- 3 · Platforms -->
          <StepPanel v-slot="{ activateCallback }" value="3">
            <div class="flex flex-col gap-4 p-3 lg:p-6">
              <SocialNetworkSelector v-model="c.selectedChannelIds.value" />

              <div class="flex justify-between">
                <Button label="Back" icon="pi pi-arrow-left" severity="secondary" outlined @click="activateCallback('2')" />
                <Button
                  label="Next"
                  icon="pi pi-arrow-right"
                  icon-pos="right"
                  :disabled="!c.draft.variants.length"
                  @click="activateCallback('4')"
                />
              </div>
            </div>
          </StepPanel>

          <!-- 4 · Customise -->
          <StepPanel v-slot="{ activateCallback }" value="4">
            <div class="flex flex-col gap-4 p-3 lg:p-6">
              <Message v-if="!c.draft.variants.length" severity="info" :closable="false">
                Choose at least one destination first.
              </Message>

              <template v-else>
                <div class="flex flex-wrap items-center gap-2">
                  <p class="min-w-0 flex-1 text-sm text-ink-muted">
                    Each platform follows the master content until you customise it.
                  </p>
                  <Button
                    label="Apply master to all"
                    icon="pi pi-undo"
                    size="small"
                    severity="secondary"
                    text
                    @click="c.applyMasterTo(c.draft.variants.map((v) => v.channelId))"
                  />
                </div>

                <PlatformVariantEditor
                  v-for="v in c.draft.variants"
                  :key="v.channelId"
                  :variant="v"
                  :manifest="c.manifestFor(v.provider)!"
                  :channel="channelOf(v.channelId)"
                  :issues="c.issuesByChannel.value[v.channelId] ?? []"
                  :effective-text="c.effectiveContent(v).text"
                  :effective-title="c.effectiveContent(v).title"
                  :effective-description="c.effectiveContent(v).description"
                  @customise="c.customise"
                  @reset="c.resetToMaster"
                  @patch="(patch) => Object.assign(v, patch)"
                  @patch-content="(patch) => Object.assign(v.content, patch)"
                  @patch-setting="({ key, value }) => (v.providerSettings[key] = value)"
                />
              </template>

              <div class="flex justify-between">
                <Button label="Back" icon="pi pi-arrow-left" severity="secondary" outlined @click="activateCallback('3')" />
                <Button label="Next" icon="pi pi-arrow-right" icon-pos="right" @click="activateCallback('5')" />
              </div>
            </div>
          </StepPanel>

          <!-- 5 · Schedule -->
          <StepPanel v-slot="{ activateCallback }" value="5">
            <div class="flex flex-col gap-4 p-3 lg:p-6">
              <div class="flex flex-col gap-1.5">
                <label for="schedule-at" class="text-sm font-medium text-ink">Date and time</label>
                <DatePicker
                  input-id="schedule-at"
                  v-model="scheduledDate"
                  show-time
                  hour-format="24"
                  :min-date="new Date()"
                  date-format="d M yy"
                  show-button-bar
                  fluid
                />
                <small class="text-ink-soft">Times are in {{ ws.timezone }}, the workspace timezone.</small>
              </div>

              <Card>
                <template #content>
                  <ScheduleSummary :scheduled-at="c.draft.scheduledAtMs" :channel-count="c.draft.variants.length" />
                </template>
              </Card>

              <div class="flex justify-between">
                <Button label="Back" icon="pi pi-arrow-left" severity="secondary" outlined @click="activateCallback('4')" />
                <Button label="Review" icon="pi pi-arrow-right" icon-pos="right" @click="activateCallback('6')" />
              </div>
            </div>
          </StepPanel>

          <!-- 6 · Review -->
          <StepPanel v-slot="{ activateCallback }" value="6">
            <div class="flex flex-col gap-4 p-3 lg:p-6">
              <Message v-if="c.blockingChannels.value.length" severity="error" :closable="false">
                {{ c.blockingChannels.value.length }}
                {{ c.blockingChannels.value.length === 1 ? 'destination has' : 'destinations have' }}
                a problem that must be fixed before publishing.
              </Message>

              <Card>
                <template #title><span class="text-sm">Summary</span></template>
                <template #content>
                  <div class="flex flex-col gap-3">
                    <div class="flex items-center gap-2 text-sm">
                      <i class="pi pi-image text-ink-soft" aria-hidden="true" />
                      <span class="text-ink">
                        {{ mediaAssets.length }} media {{ mediaAssets.length === 1 ? 'file' : 'files' }}
                      </span>
                    </div>
                    <ScheduleSummary :scheduled-at="c.draft.scheduledAtMs" :channel-count="c.draft.variants.length" />
                  </div>
                </template>
              </Card>

              <Card>
                <template #title><span class="text-sm">Destinations</span></template>
                <template #content>
                  <ul class="flex flex-col divide-y divide-line">
                    <li v-for="s in summaryIssues" :key="s.variant.channelId" class="flex items-start gap-3 py-3">
                      <ProviderIcon :provider="s.variant.provider" :size="20" />
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-sm text-ink">{{ s.channel?.name ?? s.variant.provider }}</p>
                        <p class="truncate text-xs text-ink-soft">
                          {{ c.manifestFor(s.variant.provider)?.displayName }} ·
                          {{ s.variant.syncMode === 'custom' ? 'Customised' : 'Follows master' }}
                          <template v-if="s.variant.offsetMinutes"> · +{{ s.variant.offsetMinutes }} min</template>
                        </p>
                        <ul v-if="s.issues.length" class="mt-1 flex flex-col gap-0.5">
                          <li
                            v-for="(i, idx) in s.issues"
                            :key="idx"
                            class="text-xs"
                            :class="i.severity === 'error' ? 'text-bad' : 'text-warn'"
                          >
                            {{ i.message }}
                          </li>
                        </ul>
                      </div>
                      <Tag
                        :value="s.issues.some((i) => i.severity === 'error') ? 'Blocked' : 'Ready'"
                        :severity="s.issues.some((i) => i.severity === 'error') ? 'danger' : 'success'"
                        :icon="s.issues.some((i) => i.severity === 'error') ? 'pi pi-times-circle' : 'pi pi-check-circle'"
                      />
                    </li>
                  </ul>
                </template>
              </Card>

              <div class="flex flex-wrap items-center gap-2">
                <Button label="Back" icon="pi pi-arrow-left" severity="secondary" outlined @click="activateCallback('5')" />
                <Button
                  label="Save draft"
                  icon="pi pi-save"
                  severity="secondary"
                  outlined
                  :loading="busy"
                  @click="saveDraft"
                />
                <Button
                  label="Publish now"
                  icon="pi pi-send"
                  severity="secondary"
                  :disabled="!c.canPublishNow.value || !ws.can('content.schedule')"
                  :loading="busy"
                  @click="publishNow"
                />
                <Button
                  label="Schedule"
                  icon="pi pi-calendar-plus"
                  class="ml-auto"
                  :disabled="!c.canSchedule.value || !ws.can('content.schedule')"
                  :loading="busy"
                  @click="schedule"
                />
              </div>
            </div>
          </StepPanel>
        </StepPanels>
      </Stepper>
    </div>

    <MediaPicker v-model:visible="pickerOpen" :selected="c.draft.mediaIds" @confirm="onMediaConfirm" />
  </div>
</template>

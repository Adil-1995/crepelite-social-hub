<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import AutoComplete from 'primevue/autocomplete';
import DatePicker from 'primevue/datepicker';
import Message from 'primevue/message';
import Skeleton from 'primevue/skeleton';
import SelectButton from 'primevue/selectbutton';
import Accordion from 'primevue/accordion';
import AccordionPanel from 'primevue/accordionpanel';
import AccordionHeader from 'primevue/accordionheader';
import AccordionContent from 'primevue/accordioncontent';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import type { MediaAsset } from '@shared/index';
import { useComposer, type DraftVariant } from '@/composables/useComposer';
import { useWorkspaceStore } from '@/stores/workspace';
import { useMediaUrls } from '@/composables/useMediaUrls';
import { useFeedback } from '@/composables/useFeedback';
import { fromPickerDate, toPickerDate, formatDuration } from '@/lib/format';
import SocialNetworkSelector from '@/components/domain/SocialNetworkSelector.vue';
import PlatformVariantEditor from '@/components/domain/PlatformVariantEditor.vue';
import PostPreview from '@/components/domain/PostPreview.vue';
import MediaPicker from '@/components/domain/MediaPicker.vue';
import ScheduleSummary from '@/components/domain/ScheduleSummary.vue';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';
import ErrorState from '@/components/domain/ErrorState.vue';

/**
 * Post composer: one screen.
 *
 * Everything that decides what gets published is visible at once — accounts,
 * media, text, timing — with a live preview beside it. The wizard this
 * replaces made you walk six steps before you could see the result of the
 * first one.
 *
 * Per-platform customisation stays folded away until asked for, under the
 * preview of the platform it applies to.
 *
 * Runs as an immersive route (no app chrome) so the phone keyboard has room.
 */
const props = defineProps<{ postId?: string }>();
const router = useRouter();
const ws = useWorkspaceStore();
const { previewUrl } = useMediaUrls();
const { success, reportApiError, confirmDestructive } = useFeedback();
const c = useComposer(() => props.postId);

const pickerOpen = ref(false);
const hashtagInput = ref<string[]>([]);
const busy = ref(false);
/** Phones cannot show editor and preview at once. */
const mobilePane = ref<'edit' | 'preview'>('edit');
const activePreview = ref<string>('');

const paneOptions = [
  { label: 'Edit', value: 'edit' },
  { label: 'Preview', value: 'preview' },
];

const scheduledDate = computed<Date | null>({
  get: () => toPickerDate(c.draft.scheduledAtMs, ws.timezone),
  set: (d) => {
    c.draft.scheduledAtMs = fromPickerDate(d, ws.timezone);
  },
});

onMounted(async () => {
  await c.load();
  hashtagInput.value = [...c.draft.masterContent.hashtags];
  if (c.restoredFromLocal.value) success('Draft restored', 'We recovered unsaved changes from this device.');
  if (c.draft.variants.length) activePreview.value = c.draft.variants[0]!.channelId;
});

const channelOf = (id: string) => ws.channels.find((x) => x.id === id);

const selectedChannelIds = computed<string[]>({
  get: () => c.selectedChannelIds.value,
  set: (ids) => {
    c.selectedChannelIds.value = ids;
    // Keep the preview tab pointing at something that still exists.
    if (!ids.includes(activePreview.value)) activePreview.value = ids[0] ?? '';
  },
});

function onHashtags(values: string[]) {
  c.draft.masterContent.hashtags = values.map((v) => v.replace(/^#+/, '').trim()).filter(Boolean).slice(0, 60);
}

const mediaAssets = computed(() =>
  c.draft.mediaIds.map((id) => c.mediaById.get(id)).filter((a): a is MediaAsset => !!a),
);

function assetsFor(variant: DraftVariant): MediaAsset[] {
  return c.effectiveMediaIds(variant).map((id) => c.mediaById.get(id)).filter((a): a is MediaAsset => !!a);
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

const blockedCount = computed(() => c.blockingChannels.value.length);
const canPublish = computed(() => c.canPublishNow.value && ws.can('content.schedule'));
const canSchedule = computed(() => c.canSchedule.value && ws.can('content.schedule'));

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
  const count = c.draft.variants.length;
  const ok = await confirmDestructive({
    header: 'Publish now?',
    message: `This sends the post to ${count} ${count === 1 ? 'destination' : 'destinations'} immediately.`,
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
  if (!c.dirty.value) {
    router.back();
    return;
  }
  const leave = await confirmDestructive({
    header: 'Discard unsaved changes?',
    message: 'Your draft is kept on this device, but nothing is saved to the workspace.',
    acceptLabel: 'Leave',
    rejectLabel: 'Keep editing',
  });
  if (leave) router.back();
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
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-app">
    <!-- Header -->
    <header class="safe-top sticky top-0 z-20 border-b border-line bg-surface">
      <div class="flex h-14 items-center gap-2 px-3">
        <Button icon="pi pi-times" text rounded severity="secondary" aria-label="Close composer" @click="close" />
        <h1 class="min-w-0 flex-1 truncate text-base font-semibold text-ink">
          {{ props.postId ? 'Edit post' : 'New post' }}
        </h1>
        <SelectButton
          v-model="mobilePane"
          :options="paneOptions"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          size="small"
          class="lg:hidden"
          aria-label="Editor or preview"
        />
      </div>
    </header>

    <div v-if="c.loading.value" class="flex flex-col gap-3 p-4">
      <Skeleton height="3rem" />
      <Skeleton height="14rem" />
    </div>

    <ErrorState v-else-if="c.loadError.value" :message="c.loadError.value" :retryable="false" />

    <div v-else class="mx-auto grid w-full max-w-6xl flex-1 gap-6 p-3 pb-28 lg:grid-cols-[minmax(0,1fr)_22rem] lg:p-6">
      <!-- Editor -->
      <div class="flex flex-col gap-5" :class="mobilePane === 'preview' ? 'hidden lg:flex' : ''">
        <section aria-label="Destinations">
          <SocialNetworkSelector v-model="selectedChannelIds" />
        </section>

        <section class="flex flex-col gap-2" aria-label="Media">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-ink">Media</span>
            <Button
              :label="mediaAssets.length ? 'Change' : 'Add'"
              icon="pi pi-images"
              size="small"
              text
              class="ml-auto"
              @click="pickerOpen = true"
            />
          </div>

          <button
            v-if="!mediaAssets.length"
            type="button"
            class="flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line text-ink-soft transition-colors hover:border-brand-400 hover:text-ink-muted"
            @click="pickerOpen = true"
          >
            <i class="pi pi-images text-xl" aria-hidden="true" />
            <span class="text-xs">Add photos or videos</span>
          </button>

          <ul v-else class="flex flex-wrap gap-2">
            <li v-for="(a, i) in mediaAssets" :key="a.id" class="relative">
              <span class="block h-20 w-20 overflow-hidden rounded-lg bg-muted">
                <img
                  v-if="previewUrl(a)"
                  :src="previewUrl(a) ?? undefined"
                  :alt="a.fileName"
                  class="h-full w-full object-cover"
                />
                <span v-else class="flex h-full w-full items-center justify-center">
                  <i :class="a.kind === 'video' ? 'pi pi-video' : 'pi pi-image'" class="text-ink-soft" aria-hidden="true" />
                </span>
              </span>
              <span
                v-if="a.kind === 'video' && a.durationSec"
                class="pointer-events-none absolute bottom-9 right-1 rounded bg-black/70 px-1 text-[10px] text-white"
              >
                {{ formatDuration(a.durationSec) }}
              </span>
              <div class="mt-0.5 flex items-center justify-center gap-0.5">
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
                  icon="pi pi-times"
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
        </section>

        <section class="flex flex-col gap-1.5" aria-label="Caption">
          <label for="master-text" class="text-sm font-medium text-ink">Caption</label>
          <Textarea
            id="master-text"
            v-model="c.draft.masterContent.text"
            rows="6"
            auto-resize
            fluid
            placeholder="What do you want to say?"
          />
          <small class="text-ink-soft">Each network trims this to its own limit — the previews show where.</small>
        </section>

        <Accordion multiple>
          <AccordionPanel value="more">
            <AccordionHeader>More content</AccordionHeader>
            <AccordionContent>
              <div class="flex flex-col gap-4 pt-1">
                <div class="flex flex-col gap-1.5">
                  <label for="master-title" class="text-sm font-medium text-ink">Title</label>
                  <InputText id="master-title" v-model="c.draft.masterContent.title" maxlength="500" fluid />
                  <small class="text-ink-soft">Used by networks that show a separate title, such as video platforms.</small>
                </div>
                <div class="flex flex-col gap-1.5">
                  <label for="master-desc" class="text-sm font-medium text-ink">Description</label>
                  <Textarea id="master-desc" v-model="c.draft.masterContent.description" rows="3" auto-resize fluid />
                </div>
                <div class="flex flex-col gap-1.5">
                  <label for="master-tags" class="text-sm font-medium text-ink">Hashtags</label>
                  <AutoComplete
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
                <div class="flex flex-col gap-1.5">
                  <label for="internal-title" class="text-sm font-medium text-ink">Internal title</label>
                  <InputText id="internal-title" v-model="c.draft.titleInternal" maxlength="200" fluid />
                  <small class="text-ink-soft">Only visible inside CrepeLite.</small>
                </div>
              </div>
            </AccordionContent>
          </AccordionPanel>
        </Accordion>

        <section class="flex flex-col gap-2" aria-label="Schedule">
          <label for="schedule-at" class="text-sm font-medium text-ink">When</label>
          <DatePicker
            input-id="schedule-at"
            v-model="scheduledDate"
            show-time
            hour-format="24"
            :min-date="new Date()"
            date-format="d M yy"
            show-button-bar
            placeholder="Leave empty to keep it a draft"
            fluid
          />
          <ScheduleSummary :scheduled-at="c.draft.scheduledAtMs" :channel-count="c.draft.variants.length" />
        </section>
      </div>

      <!-- Preview -->
      <div class="flex flex-col gap-3" :class="mobilePane === 'edit' ? 'hidden lg:flex' : ''">
        <div v-if="!c.draft.variants.length" class="rounded-xl border border-dashed border-line px-4 py-10 text-center">
          <i class="pi pi-eye mb-2 block text-2xl text-ink-soft" aria-hidden="true" />
          <p class="text-sm text-ink-muted">Pick a destination to see the preview.</p>
        </div>

        <Tabs v-else v-model:value="activePreview" class="lg:sticky lg:top-20">
          <TabList>
            <Tab v-for="v in c.draft.variants" :key="v.channelId" :value="v.channelId">
              <span class="flex items-center gap-1.5">
                <ProviderIcon :provider="v.provider" :size="14" />
                <span class="max-w-[6rem] truncate">{{ channelOf(v.channelId)?.name ?? v.provider }}</span>
                <i
                  v-if="c.blockingChannels.value.includes(v.channelId)"
                  class="pi pi-exclamation-circle text-bad"
                  style="font-size: 0.7rem"
                  aria-label="Has a problem"
                />
              </span>
            </Tab>
          </TabList>

          <TabPanels>
            <TabPanel v-for="v in c.draft.variants" :key="v.channelId" :value="v.channelId">
              <div class="flex flex-col gap-3">
                <PostPreview
                  :manifest="c.manifestFor(v.provider)!"
                  :channel="channelOf(v.channelId)"
                  :content="c.effectiveContent(v)"
                  :media="assetsFor(v)"
                  :media-urls="previewUrl"
                  :issues="c.issuesByChannel.value[v.channelId] ?? []"
                  :format="v.format"
                />

                <Accordion multiple>
                  <AccordionPanel value="tune">
                    <AccordionHeader>
                      <span class="text-sm">
                        {{ v.syncMode === 'custom' ? 'Customised for this platform' : 'Customise for this platform' }}
                      </span>
                    </AccordionHeader>
                    <AccordionContent>
                      <PlatformVariantEditor
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
                    </AccordionContent>
                  </AccordionPanel>
                </Accordion>
              </div>
            </TabPanel>
          </TabPanels>
        </Tabs>
      </div>
    </div>

    <!-- Actions -->
    <footer class="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur">
      <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-3 py-2.5">
        <Message
          v-if="blockedCount"
          severity="error"
          :closable="false"
          size="small"
          class="order-last w-full lg:order-none lg:w-auto"
        >
          {{ blockedCount }} {{ blockedCount === 1 ? 'destination needs' : 'destinations need' }} fixing
        </Message>

        <Button
          label="Save draft"
          icon="pi pi-save"
          severity="secondary"
          outlined
          size="small"
          :loading="busy || c.saving.value"
          @click="saveDraft"
        />
        <Button
          label="Publish now"
          icon="pi pi-send"
          severity="secondary"
          size="small"
          class="ml-auto"
          :disabled="!canPublish"
          :loading="busy"
          @click="publishNow"
        />
        <Button
          label="Schedule"
          icon="pi pi-calendar-plus"
          size="small"
          :disabled="!canSchedule"
          :loading="busy"
          @click="schedule"
        />
      </div>
    </footer>

    <MediaPicker v-model:visible="pickerOpen" :selected="c.draft.mediaIds" @confirm="onMediaConfirm" />
  </div>
</template>

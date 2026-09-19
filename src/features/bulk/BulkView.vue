<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { DateTime } from 'luxon';
import Card from 'primevue/card';
import Button from 'primevue/button';
import DatePicker from 'primevue/datepicker';
import Select from 'primevue/select';
import MultiSelect from 'primevue/multiselect';
import InputNumber from 'primevue/inputnumber';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import Message from 'primevue/message';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Tag from 'primevue/tag';
import Stepper from 'primevue/stepper';
import StepList from 'primevue/steplist';
import Step from 'primevue/step';
import StepPanels from 'primevue/steppanels';
import StepPanel from 'primevue/steppanel';
import {
  planBulkSchedule,
  type BulkDistribution,
  type BulkFrequency,
  type BulkPlanEntry,
} from '@shared/index';
import { useWorkspaceStore } from '@/stores/workspace';
import { useMediaUrls } from '@/composables/useMediaUrls';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/app/firebase';
import type { MediaAsset } from '@shared/index';
import { useFeedback } from '@/composables/useFeedback';
import { api } from '@/services/api';
import { formatDateTime } from '@/lib/format';
import MediaPicker from '@/components/domain/MediaPicker.vue';
import SocialNetworkSelector from '@/components/domain/SocialNetworkSelector.vue';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';

/**
 * Bulk planner: many pieces of media across a date range.
 *
 * The preview runs the same `planBulkSchedule` the server uses, seeded so the
 * random distribution the user approves is exactly the one that gets created.
 * The server still re-plans and re-validates — the client plan is a preview,
 * never the source of truth.
 */
const ws = useWorkspaceStore();
const router = useRouter();
const { previewUrl } = useMediaUrls();
const { success, reportApiError } = useFeedback();

const step = ref('1');
const pickerOpen = ref(false);
const mediaIds = ref<string[]>([]);
/** Thumbnails for the picked files, fetched once per id. */
const assets = ref<Map<string, MediaAsset>>(new Map());
const captions = ref<Record<string, string>>({});
const channelIds = ref<string[]>([]);
const creating = ref(false);

const today = DateTime.now().setZone(ws.timezone).startOf('day');
const fromDate = ref<Date>(today.plus({ days: 1 }).toJSDate());
const toDate = ref<Date>(today.plus({ days: 14 }).toJSDate());
const times = ref<string[]>(['10:00', '18:00']);
const newTime = ref('');
const frequencyType = ref<BulkFrequency['type']>('daily');
const weekdays = ref<number[]>([1, 2, 3, 4, 5]);
const everyNDays = ref(2);
const distribution = ref<BulkDistribution>('sequential');
const seed = ref(Math.floor(Math.random() * 1_000_000));
const providerOffsets = ref<Record<string, number>>({});

const frequencyOptions = [
  { label: 'Every day', value: 'daily' },
  { label: 'Chosen weekdays', value: 'weekdays' },
  { label: 'Every N days', value: 'interval' },
];

const weekdayOptions = [
  { label: 'Monday', value: 1 },
  { label: 'Tuesday', value: 2 },
  { label: 'Wednesday', value: 3 },
  { label: 'Thursday', value: 4 },
  { label: 'Friday', value: 5 },
  { label: 'Saturday', value: 6 },
  { label: 'Sunday', value: 7 },
];

const distributionOptions = [
  { label: 'In order', value: 'sequential', description: 'Items go out in the order you picked them' },
  { label: 'Shuffled', value: 'random', description: 'Randomised, but reproducible from the preview' },
];

const localDate = (d: Date) => DateTime.fromJSDate(d).setZone(ws.timezone, { keepLocalTime: true }).toFormat('yyyy-MM-dd');

const frequency = computed<BulkFrequency>(() => {
  if (frequencyType.value === 'weekdays') return { type: 'weekdays', weekdays: weekdays.value };
  if (frequencyType.value === 'interval') return { type: 'interval', everyNDays: everyNDays.value };
  return { type: 'daily' };
});

/** The selected providers, so offsets can be set per network. */
const selectedProviders = computed(() => {
  const set = new Set<string>();
  for (const id of channelIds.value) {
    const ch = ws.channels.find((c) => c.id === id);
    if (ch) set.add(ch.provider);
  }
  return [...set];
});

const plan = computed(() => {
  if (!mediaIds.value.length || !times.value.length) return null;
  try {
    return planBulkSchedule({
      itemIds: mediaIds.value,
      from: localDate(fromDate.value),
      to: localDate(toDate.value),
      timezone: ws.timezone,
      times: [...times.value].sort(),
      frequency: frequency.value,
      distribution: distribution.value,
      seed: seed.value,
      notBeforeMs: Date.now(),
    });
  } catch {
    return null;
  }
});

interface PreviewRow extends BulkPlanEntry {
  caption: string;
}

const previewRows = computed<PreviewRow[]>(
  () => plan.value?.entries.map((e) => ({ ...e, caption: captions.value[e.itemId] ?? '' })) ?? [],
);

const unassigned = computed(() => plan.value?.unassignedItemIds ?? []);

const canPreview = computed(() => mediaIds.value.length > 0 && channelIds.value.length > 0 && times.value.length > 0);
const canCreate = computed(() => canPreview.value && (plan.value?.entries.length ?? 0) > 0);

function addTime() {
  const t = newTime.value.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t) || times.value.includes(t)) return;
  times.value = [...times.value, t].sort();
  newTime.value = '';
}

function removeTime(t: string) {
  times.value = times.value.filter((x) => x !== t);
}

async function onMediaConfirm(ids: string[]) {
  mediaIds.value = ids;
  if (!ws.workspaceId) return;
  const missing = ids.filter((id) => !assets.value.has(id));
  const snaps = await Promise.all(
    missing.map((id) => getDoc(doc(db, `workspaces/${ws.workspaceId}/mediaAssets/${id}`)).catch(() => null)),
  );
  const next = new Map(assets.value);
  for (const snap of snaps) {
    if (snap?.exists()) next.set(snap.id, { ...(snap.data() as MediaAsset), id: snap.id });
  }
  assets.value = next;
}

function thumbFor(id: string): string | null {
  const a = assets.value.get(id);
  return a ? previewUrl(a) : null;
}

function captionPlaceholder(id: string): string {
  return assets.value.get(id)?.fileName ?? 'Caption';
}

function reshuffle() {
  seed.value = Math.floor(Math.random() * 1_000_000);
}

async function create() {
  if (!ws.workspaceId || !canCreate.value) return;
  creating.value = true;
  try {
    const jobId = `bulk_${Date.now().toString(36)}`;
    const res = await api.createBulkSchedule({
      jobId,
      workspaceId: ws.workspaceId,
      items: mediaIds.value.map((id) => ({
        kind: 'media' as const,
        itemId: id,
        mediaIds: [id],
        text: captions.value[id] ?? '',
        title: '',
      })),
      from: localDate(fromDate.value),
      to: localDate(toDate.value),
      timezone: ws.timezone,
      times: [...times.value].sort(),
      frequency: frequency.value,
      distribution: distribution.value,
      seed: seed.value,
      channelIds: channelIds.value,
      providerOffsets: providerOffsets.value,
      channelDefaults: {},
      hashtags: [],
      link: '',
    });

    const scheduled = res.results.filter((r) => r.status === 'scheduled').length;
    const failed = res.results.filter((r) => r.status === 'failed').length;
    if (failed) {
      reportApiError(
        new Error(`${failed} of ${res.results.length} items could not be scheduled.`),
        'Bulk schedule partly created',
      );
    } else {
      success('Bulk schedule created', `${scheduled} posts scheduled.`);
    }
    await router.push('/calendar');
  } catch (e) {
    reportApiError(e, 'Could not create the bulk schedule');
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-4 p-3 lg:p-6">
    <Stepper v-model:value="step">
      <StepList class="overflow-x-auto scrollbar-none">
        <Step value="1"><span class="whitespace-nowrap">Content</span></Step>
        <Step value="2"><span class="whitespace-nowrap">Destinations</span></Step>
        <Step value="3"><span class="whitespace-nowrap">Schedule</span></Step>
        <Step value="4"><span class="whitespace-nowrap">Preview</span></Step>
      </StepList>

      <StepPanels>
        <!-- 1 · Content -->
        <StepPanel v-slot="{ activateCallback }" value="1">
          <div class="flex flex-col gap-4">
            <div class="flex flex-wrap items-center gap-2">
              <p class="min-w-0 flex-1 text-sm text-ink-muted">
                Pick the media to spread across the date range. Each file becomes one post.
              </p>
              <Button label="Choose media" icon="pi pi-images" size="small" @click="pickerOpen = true" />
            </div>

            <Message v-if="!mediaIds.length" severity="info" :closable="false">
              Choose at least one file to continue.
            </Message>

            <ul v-else class="flex flex-col gap-3">
              <li v-for="(id, i) in mediaIds" :key="id">
                <Card>
                  <template #content>
                    <div class="flex gap-3">
                      <span class="w-6 shrink-0 text-sm font-semibold text-ink-soft">{{ i + 1 }}</span>
                      <div class="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-muted">
                        <img
                          v-if="thumbFor(id)"
                          :src="thumbFor(id) ?? undefined"
                          :alt="captionPlaceholder(id)"
                          class="h-full w-full object-cover"
                        />
                        <span v-else class="flex h-full items-center justify-center">
                          <i class="pi pi-image text-ink-soft" aria-hidden="true" />
                        </span>
                      </div>
                      <div class="min-w-0 flex-1">
                        <label :for="`caption-${id}`" class="text-xs font-medium text-ink">Caption</label>
                        <Textarea
                          :id="`caption-${id}`"
                          :model-value="captions[id] ?? ''"
                          rows="2"
                          auto-resize
                          fluid
                          @update:model-value="(v) => (captions[id] = v ?? '')"
                        />
                      </div>
                    </div>
                  </template>
                </Card>
              </li>
            </ul>

            <div class="flex justify-end">
              <Button
                label="Next"
                icon="pi pi-arrow-right"
                icon-pos="right"
                :disabled="!mediaIds.length"
                @click="activateCallback('2')"
              />
            </div>
          </div>
        </StepPanel>

        <!-- 2 · Destinations -->
        <StepPanel v-slot="{ activateCallback }" value="2">
          <div class="flex flex-col gap-4">
            <SocialNetworkSelector v-model="channelIds" />

            <Card v-if="selectedProviders.length">
              <template #title><span class="text-sm">Stagger by network</span></template>
              <template #content>
                <p class="mb-3 text-xs text-ink-muted">
                  Delay each network after the slot time so the same content does not appear everywhere at once.
                </p>
                <ul class="flex flex-col gap-3">
                  <li v-for="p in selectedProviders" :key="p" class="flex items-center gap-3">
                    <ProviderIcon :provider="p" :size="20" />
                    <span class="min-w-0 flex-1 text-sm text-ink">{{ p }}</span>
                    <InputNumber
                      :model-value="providerOffsets[p] ?? 0"
                      :min="0"
                      :max="10080"
                      suffix=" min"
                      show-buttons
                      class="w-36"
                      :aria-label="`Delay for ${p}`"
                      @update:model-value="(v) => (providerOffsets[p] = v ?? 0)"
                    />
                  </li>
                </ul>
              </template>
            </Card>

            <div class="flex justify-between">
              <Button label="Back" icon="pi pi-arrow-left" severity="secondary" outlined @click="activateCallback('1')" />
              <Button
                label="Next"
                icon="pi pi-arrow-right"
                icon-pos="right"
                :disabled="!channelIds.length"
                @click="activateCallback('3')"
              />
            </div>
          </div>
        </StepPanel>

        <!-- 3 · Schedule -->
        <StepPanel v-slot="{ activateCallback }" value="3">
          <div class="flex flex-col gap-4">
            <div class="grid gap-4 sm:grid-cols-2">
              <div class="flex flex-col gap-1.5">
                <label for="bulk-from" class="text-sm font-medium text-ink">From</label>
                <DatePicker input-id="bulk-from" v-model="fromDate" date-format="d M yy" :min-date="new Date()" fluid />
              </div>
              <div class="flex flex-col gap-1.5">
                <label for="bulk-to" class="text-sm font-medium text-ink">To</label>
                <DatePicker input-id="bulk-to" v-model="toDate" date-format="d M yy" :min-date="fromDate" fluid />
              </div>
            </div>

            <div class="flex flex-col gap-1.5">
              <label for="bulk-freq" class="text-sm font-medium text-ink">Which days</label>
              <Select
                input-id="bulk-freq"
                v-model="frequencyType"
                :options="frequencyOptions"
                option-label="label"
                option-value="value"
                fluid
              />
            </div>

            <div v-if="frequencyType === 'weekdays'" class="flex flex-col gap-1.5">
              <label for="bulk-weekdays" class="text-sm font-medium text-ink">Weekdays</label>
              <MultiSelect
                input-id="bulk-weekdays"
                v-model="weekdays"
                :options="weekdayOptions"
                option-label="label"
                option-value="value"
                display="chip"
                fluid
              />
            </div>

            <div v-if="frequencyType === 'interval'" class="flex flex-col gap-1.5">
              <label for="bulk-interval" class="text-sm font-medium text-ink">Every</label>
              <InputNumber
                input-id="bulk-interval"
                v-model="everyNDays"
                :min="1"
                :max="60"
                suffix=" days"
                show-buttons
                class="w-40"
              />
            </div>

            <div class="flex flex-col gap-1.5">
              <span class="text-sm font-medium text-ink">Times of day</span>
              <div class="flex flex-wrap items-center gap-2">
                <Tag
                  v-for="t in times"
                  :key="t"
                  :value="t"
                  severity="secondary"
                  class="cursor-pointer"
                  @click="removeTime(t)"
                />
                <InputText
                  v-model="newTime"
                  placeholder="HH:mm"
                  class="w-24"
                  aria-label="Add a time"
                  @keydown.enter.prevent="addTime"
                />
                <Button icon="pi pi-plus" size="small" text aria-label="Add time" @click="addTime" />
              </div>
              <small class="text-ink-soft">Tap a time to remove it. Times are in {{ ws.timezone }}.</small>
            </div>

            <div class="flex flex-col gap-1.5">
              <label for="bulk-dist" class="text-sm font-medium text-ink">Order</label>
              <Select
                input-id="bulk-dist"
                v-model="distribution"
                :options="distributionOptions"
                option-label="label"
                option-value="value"
                fluid
              >
                <template #option="{ option }">
                  <div class="flex flex-col">
                    <span>{{ option.label }}</span>
                    <span class="text-xs text-ink-soft">{{ option.description }}</span>
                  </div>
                </template>
              </Select>
            </div>

            <div class="flex justify-between">
              <Button label="Back" icon="pi pi-arrow-left" severity="secondary" outlined @click="activateCallback('2')" />
              <Button
                label="Preview"
                icon="pi pi-arrow-right"
                icon-pos="right"
                :disabled="!canPreview"
                @click="activateCallback('4')"
              />
            </div>
          </div>
        </StepPanel>

        <!-- 4 · Preview -->
        <StepPanel v-slot="{ activateCallback }" value="4">
          <div class="flex flex-col gap-4">
            <Message v-if="!plan" severity="warn" :closable="false">
              This configuration produces no slots. Widen the date range or add more times.
            </Message>

            <template v-else>
              <div class="flex flex-wrap items-center gap-2">
                <p class="min-w-0 flex-1 text-sm text-ink">
                  <strong>{{ plan.entries.length }}</strong> posts ·
                  {{ channelIds.length }} {{ channelIds.length === 1 ? 'destination' : 'destinations' }} ·
                  <strong>{{ plan.entries.length * channelIds.length }}</strong> publications
                </p>
                <Button
                  v-if="distribution === 'random'"
                  label="Shuffle again"
                  icon="pi pi-refresh"
                  size="small"
                  text
                  @click="reshuffle"
                />
              </div>

              <Message v-if="unassigned.length" severity="warn" :closable="false">
                {{ unassigned.length }} {{ unassigned.length === 1 ? 'item has' : 'items have' }} no slot.
                Widen the range or add more times per day.
              </Message>

              <Message v-for="(w, i) in plan.warnings" :key="i" severity="info" :closable="false" size="small">
                {{ w }}
              </Message>

              <!-- Phones -->
              <ul class="flex flex-col gap-2 lg:hidden">
                <li v-for="(row, i) in previewRows" :key="row.itemId">
                  <Card>
                    <template #content>
                      <div class="flex items-center gap-3">
                        <span class="w-6 shrink-0 text-sm text-ink-soft">{{ i + 1 }}</span>
                        <div class="min-w-0 flex-1">
                          <p class="text-sm font-medium text-ink">
                            {{ formatDateTime(row.scheduledAtMs, ws.timezone) }}
                          </p>
                          <p class="truncate text-xs text-ink-soft">{{ row.caption || 'No caption' }}</p>
                        </div>
                        <Tag v-if="row.shifted" value="DST shift" severity="warn" />
                      </div>
                    </template>
                  </Card>
                </li>
              </ul>

              <!-- Desktop -->
              <DataTable
                :value="previewRows"
                class="hidden lg:block"
                data-key="itemId"
                size="small"
                striped-rows
                paginator
                :rows="15"
                aria-label="Bulk schedule preview"
              >
                <Column header="#" style="width: 4rem">
                  <template #body="{ index }">{{ index + 1 }}</template>
                </Column>
                <Column header="When">
                  <template #body="{ data }">
                    {{ formatDateTime(data.scheduledAtMs, ws.timezone) }}
                  </template>
                </Column>
                <Column field="caption" header="Caption">
                  <template #body="{ data }">
                    <span class="text-sm">{{ data.caption || '—' }}</span>
                  </template>
                </Column>
                <Column header="Notes" style="width: 10rem">
                  <template #body="{ data }">
                    <Tag v-if="data.shifted" value="DST shift" severity="warn" />
                    <Tag v-else-if="data.ambiguous" value="Ambiguous" severity="warn" />
                    <span v-else class="text-xs text-ink-soft">—</span>
                  </template>
                </Column>
              </DataTable>
            </template>

            <div class="flex flex-wrap justify-between gap-2">
              <Button label="Back" icon="pi pi-arrow-left" severity="secondary" outlined @click="activateCallback('3')" />
              <Button
                label="Create schedule"
                icon="pi pi-check"
                :disabled="!canCreate"
                :loading="creating"
                @click="create"
              />
            </div>
          </div>
        </StepPanel>
      </StepPanels>
    </Stepper>

    <MediaPicker v-model:visible="pickerOpen" :selected="mediaIds" :max="200" @confirm="onMediaConfirm" />
  </div>
</template>

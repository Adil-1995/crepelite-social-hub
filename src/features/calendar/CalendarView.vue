<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { collection, orderBy, query, where, Timestamp } from 'firebase/firestore';
import { DateTime } from 'luxon';
import Button from 'primevue/button';
import SelectButton from 'primevue/selectbutton';
import Card from 'primevue/card';
import Skeleton from 'primevue/skeleton';
import Popover from 'primevue/popover';
import type { Post } from '@shared/index';
import { db } from '@/app/firebase';
import { useLiveQuery } from '@/composables/useFirestore';
import { useWorkspaceStore } from '@/stores/workspace';
import { formatTime, toMillis, truncate } from '@/lib/format';
import PostStatusTag from '@/components/domain/PostStatusTag.vue';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';
import EmptyState from '@/components/domain/EmptyState.vue';
import ErrorState from '@/components/domain/ErrorState.vue';

/**
 * Editorial calendar.
 *
 * A domain component rather than a PrimeVue one — PrimeVue has no editorial
 * calendar — but every control inside it is PrimeVue. Phones default to the
 * agenda view; month and week are for wider screens.
 */
type ViewMode = 'agenda' | 'week' | 'month';

const ws = useWorkspaceStore();
const router = useRouter();

const isSmall = typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches;
const view = ref<ViewMode>(isSmall ? 'agenda' : 'month');
const anchor = ref(DateTime.now().setZone(ws.timezone).startOf('day'));
const dayPopover = ref<InstanceType<typeof Popover> | null>(null);
const popoverDay = ref<string | null>(null);

const viewOptions: Array<{ label: string; value: ViewMode; icon: string }> = [
  { label: 'Agenda', value: 'agenda', icon: 'pi pi-list' },
  { label: 'Week', value: 'week', icon: 'pi pi-calendar' },
  { label: 'Month', value: 'month', icon: 'pi pi-calendar-plus' },
];

/** Query range covers the visible period, padded so week rows are complete. */
const range = computed(() => {
  const zone = ws.timezone;
  const base = anchor.value.setZone(zone);
  if (view.value === 'agenda') return { start: base.startOf('day'), end: base.plus({ days: 30 }).endOf('day') };
  if (view.value === 'week') return { start: base.startOf('week'), end: base.endOf('week') };
  return { start: base.startOf('month').startOf('week'), end: base.endOf('month').endOf('week') };
});

const { items, loading, error, refresh } = useLiveQuery<Post>(
  () =>
    ws.workspaceId
      ? query(
          collection(db, `workspaces/${ws.workspaceId}/posts`),
          where('calendarAt', '>=', Timestamp.fromMillis(range.value.start.toMillis())),
          where('calendarAt', '<=', Timestamp.fromMillis(range.value.end.toMillis())),
          orderBy('calendarAt', 'asc'),
        )
      : null,
  [() => ws.workspaceId, () => range.value.start.toMillis(), () => range.value.end.toMillis()],
);

/** Posts bucketed by local `yyyy-MM-dd`. */
const byDay = computed(() => {
  const map = new Map<string, Post[]>();
  for (const p of items.value) {
    const ms = toMillis(p.calendarAt);
    if (ms == null) continue;
    const key = DateTime.fromMillis(ms, { zone: ws.timezone }).toFormat('yyyy-MM-dd');
    const list = map.get(key) ?? [];
    list.push(p);
    map.set(key, list);
  }
  return map;
});

const monthGrid = computed(() => {
  const days: DateTime[] = [];
  let cursor = range.value.start;
  while (cursor <= range.value.end) {
    days.push(cursor);
    cursor = cursor.plus({ days: 1 });
  }
  return days;
});

const weekdayLabels = computed(() => {
  const start = DateTime.now().setZone(ws.timezone).startOf('week');
  return Array.from({ length: 7 }, (_, i) => start.plus({ days: i }).toFormat('ccc'));
});

const agendaDays = computed(() =>
  [...byDay.value.entries()]
    .filter(([key]) => key >= range.value.start.toFormat('yyyy-MM-dd'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, posts]) => ({
      key,
      date: DateTime.fromISO(key, { zone: ws.timezone }),
      posts: posts.slice().sort((x, y) => (toMillis(x.calendarAt) ?? 0) - (toMillis(y.calendarAt) ?? 0)),
    })),
);

const heading = computed(() => {
  if (view.value === 'month') return anchor.value.toFormat('LLLL yyyy');
  if (view.value === 'week') {
    const s = range.value.start;
    const e = range.value.end;
    return `${s.toFormat('d LLL')} – ${e.toFormat('d LLL yyyy')}`;
  }
  return 'Next 30 days';
});

function move(delta: number) {
  const unit = view.value === 'month' ? 'months' : view.value === 'week' ? 'weeks' : 'days';
  const amount = view.value === 'agenda' ? delta * 30 : delta;
  anchor.value = anchor.value.plus({ [unit]: amount });
}

function today() {
  anchor.value = DateTime.now().setZone(ws.timezone).startOf('day');
}

function postsFor(d: DateTime): Post[] {
  return byDay.value.get(d.toFormat('yyyy-MM-dd')) ?? [];
}

function isToday(d: DateTime): boolean {
  return d.hasSame(DateTime.now().setZone(ws.timezone), 'day');
}

function isCurrentMonth(d: DateTime): boolean {
  return d.month === anchor.value.month;
}

function openDay(event: Event, d: DateTime) {
  popoverDay.value = d.toFormat('yyyy-MM-dd');
  dayPopover.value?.toggle(event);
}

const popoverPosts = computed(() => (popoverDay.value ? (byDay.value.get(popoverDay.value) ?? []) : []));

function titleOf(p: Post): string {
  return p.titleInternal?.trim() || truncate(p.masterContent?.text?.trim() ?? '', 40) || 'Untitled post';
}

function open(postId: string) {
  void router.push(`/posts/${postId}`);
}
</script>

<template>
  <div class="flex flex-col gap-4 p-3 lg:p-6">
    <!-- Toolbar -->
    <div class="flex flex-wrap items-center gap-2">
      <Button icon="pi pi-chevron-left" text rounded severity="secondary" aria-label="Previous" @click="move(-1)" />
      <Button icon="pi pi-chevron-right" text rounded severity="secondary" aria-label="Next" @click="move(1)" />
      <Button label="Today" size="small" text @click="today" />
      <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{{ heading }}</h2>
      <SelectButton
        v-model="view"
        :options="viewOptions"
        option-label="label"
        option-value="value"
        :allow-empty="false"
        aria-label="Calendar view"
      />
    </div>

    <ErrorState v-if="error" :message="error.message" @retry="refresh" />

    <template v-else>
      <div v-if="loading" class="flex flex-col gap-3">
        <Skeleton height="4rem" />
        <Skeleton height="16rem" />
      </div>

      <!-- Agenda -->
      <template v-else-if="view === 'agenda'">
        <EmptyState
          v-if="!agendaDays.length"
          icon="pi pi-calendar"
          title="Nothing scheduled in this period"
          message="Schedule a post and it will appear here."
          action-label="Create a post"
          action-icon="pi pi-plus"
          :disabled="!ws.can('content.write')"
          @action="router.push('/compose')"
        />

        <section v-for="day in agendaDays" :key="day.key" class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold" :class="isToday(day.date) ? 'text-brand-600' : 'text-ink'">
            {{ day.date.toFormat('cccc d LLLL') }}
            <span v-if="isToday(day.date)" class="text-xs font-normal">· today</span>
          </h3>

          <Card>
            <template #content>
              <ul class="flex flex-col divide-y divide-line">
                <li v-for="p in day.posts" :key="p.id">
                  <button
                    type="button"
                    class="flex min-h-14 w-full items-center gap-3 py-2 text-left"
                    @click="open(p.id)"
                  >
                    <span class="w-12 shrink-0 text-sm font-medium tabular-nums text-ink-muted">
                      {{ formatTime(p.calendarAt, ws.timezone) }}
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm text-ink">{{ titleOf(p) }}</span>
                      <span class="mt-0.5 flex items-center gap-1">
                        <ProviderIcon
                          v-for="d in Object.values(p.deliverySummary ?? {})"
                          :key="d.deliveryId"
                          :provider="d.provider"
                          :size="14"
                        />
                      </span>
                    </span>
                    <PostStatusTag :status="p.status" />
                  </button>
                </li>
              </ul>
            </template>
          </Card>
        </section>
      </template>

      <!-- Week -->
      <div v-else-if="view === 'week'" class="grid grid-cols-1 gap-3 sm:grid-cols-7">
        <div v-for="d in monthGrid" :key="d.toISO() ?? ''" class="flex flex-col gap-2">
          <h3 class="text-xs font-semibold" :class="isToday(d) ? 'text-brand-600' : 'text-ink-muted'">
            {{ d.toFormat('ccc d') }}
          </h3>
          <ul class="flex flex-col gap-1">
            <li v-for="p in postsFor(d)" :key="p.id">
              <button
                type="button"
                class="w-full rounded-lg border border-line bg-surface p-2 text-left transition-colors hover:bg-muted"
                @click="open(p.id)"
              >
                <span class="block text-xs font-medium tabular-nums text-ink-muted">
                  {{ formatTime(p.calendarAt, ws.timezone) }}
                </span>
                <span class="mt-0.5 block truncate text-xs text-ink">{{ titleOf(p) }}</span>
              </button>
            </li>
          </ul>
          <p v-if="!postsFor(d).length" class="text-xs text-ink-soft">—</p>
        </div>
      </div>

      <!-- Month -->
      <div v-else class="overflow-x-auto">
        <div class="min-w-[44rem]">
          <div class="grid grid-cols-7 gap-px">
            <div v-for="w in weekdayLabels" :key="w" class="px-2 py-1 text-center text-xs font-semibold text-ink-soft">
              {{ w }}
            </div>
          </div>

          <div class="grid grid-cols-7 gap-px rounded-lg bg-line">
            <button
              v-for="d in monthGrid"
              :key="d.toISO() ?? ''"
              type="button"
              class="flex min-h-24 flex-col gap-1 bg-surface p-1.5 text-left transition-colors hover:bg-muted"
              :class="isCurrentMonth(d) ? '' : 'opacity-50'"
              :aria-label="`${d.toFormat('d LLLL')}, ${postsFor(d).length} posts`"
              @click="openDay($event, d)"
            >
              <span
                class="self-start rounded px-1 text-xs font-medium"
                :class="isToday(d) ? 'bg-brand-600 text-white' : 'text-ink-muted'"
              >
                {{ d.day }}
              </span>

              <span v-for="p in postsFor(d).slice(0, 3)" :key="p.id" class="min-w-0 truncate text-[11px] text-ink">
                <span class="tabular-nums text-ink-soft">{{ formatTime(p.calendarAt, ws.timezone) }}</span>
                {{ titleOf(p) }}
              </span>
              <span v-if="postsFor(d).length > 3" class="text-[11px] text-ink-soft">
                +{{ postsFor(d).length - 3 }} more
              </span>
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- Day details -->
    <Popover ref="dayPopover">
      <div class="w-72 max-w-[85vw]">
        <p class="mb-2 text-sm font-semibold text-ink">
          {{ popoverDay ? DateTime.fromISO(popoverDay).toFormat('cccc d LLLL') : '' }}
        </p>
        <ul v-if="popoverPosts.length" class="flex flex-col divide-y divide-line">
          <li v-for="p in popoverPosts" :key="p.id">
            <button type="button" class="flex w-full items-center gap-2 py-2 text-left" @click="open(p.id)">
              <span class="w-10 shrink-0 text-xs tabular-nums text-ink-soft">
                {{ formatTime(p.calendarAt, ws.timezone) }}
              </span>
              <span class="min-w-0 flex-1 truncate text-sm text-ink">{{ titleOf(p) }}</span>
              <PostStatusTag :status="p.status" />
            </button>
          </li>
        </ul>
        <p v-else class="text-sm text-ink-soft">Nothing scheduled.</p>

        <Button
          v-if="ws.can('content.write')"
          label="Create a post"
          icon="pi pi-plus"
          size="small"
          text
          class="mt-2"
          @click="router.push('/compose')"
        />
      </div>
    </Popover>
  </div>
</template>

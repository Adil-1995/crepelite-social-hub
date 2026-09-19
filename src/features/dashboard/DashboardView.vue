<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import Card from 'primevue/card';
import Button from 'primevue/button';
import Skeleton from 'primevue/skeleton';
import Message from 'primevue/message';
import { useDashboard } from '@/composables/useDashboard';
import { useWorkspaceStore } from '@/stores/workspace';
import { formatTime, formatDateTime } from '@/lib/format';
import { useProvidersStore } from '@/stores/providers';
import DeliveryStatusTag from '@/components/domain/DeliveryStatusTag.vue';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';
import EmptyState from '@/components/domain/EmptyState.vue';
import ErrorState from '@/components/domain/ErrorState.vue';

/** Today at a glance: what is going out, what went out, what needs a human. */
const router = useRouter();
const ws = useWorkspaceStore();
const providers = useProvidersStore();
const { todayDeliveries, attentionDeliveries, upcomingPosts, counts, loading, error, refresh } = useDashboard();

interface Stat {
  key: string;
  label: string;
  value: number;
  icon: string;
  tone: string;
  to?: string;
}

const stats = computed<Stat[]>(() => [
  { key: 'scheduled', label: 'Scheduled today', value: counts.value.scheduledToday, icon: 'pi pi-clock', tone: 'text-info', to: '/calendar' },
  { key: 'published', label: 'Published today', value: counts.value.publishedToday, icon: 'pi pi-check-circle', tone: 'text-ok' },
  { key: 'processing', label: 'Processing', value: counts.value.processing, icon: 'pi pi-spin pi-spinner', tone: 'text-warn' },
  { key: 'attention', label: 'Needs attention', value: counts.value.needsAttention, icon: 'pi pi-exclamation-triangle', tone: 'text-bad', to: '/posts?status=failed' },
]);

const channelName = (channelId: string) => ws.channels.find((c) => c.id === channelId)?.name ?? 'Unknown destination';
const providerName = (id: string) => providers.manifest(id)?.displayName ?? id;

const remainingToday = computed(() =>
  todayDeliveries.value.filter((d) => d.status === 'queued' || d.status === 'awaiting_queue'),
);
</script>

<template>
  <div class="flex flex-col gap-4 p-3 lg:p-6">
    <ErrorState v-if="error" :message="error.message" @retry="refresh" />

    <template v-else>
      <!-- Counters -->
      <section aria-label="Today at a glance">
        <ul class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <li v-for="s in stats" :key="s.key">
            <Card
              :class="s.to ? 'cursor-pointer transition-shadow hover:shadow-md' : ''"
              :role="s.to ? 'button' : undefined"
              :tabindex="s.to ? 0 : undefined"
              @click="s.to && router.push(s.to)"
              @keydown.enter="s.to && router.push(s.to)"
            >
              <template #content>
                <div class="flex items-center gap-3">
                  <i :class="[s.icon, s.tone]" class="text-xl" aria-hidden="true" />
                  <div class="min-w-0">
                    <Skeleton v-if="loading" width="2rem" height="1.5rem" />
                    <p v-else class="text-xl font-semibold text-ink">{{ s.value }}</p>
                    <p class="truncate text-xs text-ink-muted">{{ s.label }}</p>
                  </div>
                </div>
              </template>
            </Card>
          </li>
        </ul>
      </section>

      <!-- Connections needing attention -->
      <Message v-if="ws.attentionConnections.length" severity="warn" :closable="false">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm">
            {{ ws.attentionConnections.map((c) => c.accountName).join(', ') }}
            {{ ws.attentionConnections.length === 1 ? 'needs' : 'need' }} reconnecting.
          </span>
          <Button label="Fix now" size="small" @click="router.push('/connections')" />
        </div>
      </Message>

      <!-- Needs attention -->
      <section v-if="attentionDeliveries.length" aria-labelledby="attention-heading">
        <h2 id="attention-heading" class="mb-2 text-sm font-semibold text-ink">Needs attention</h2>
        <Card>
          <template #content>
            <ul class="flex flex-col divide-y divide-line">
              <li
                v-for="d in attentionDeliveries"
                :key="d.id"
                class="flex min-h-14 cursor-pointer items-center gap-3 py-2"
                role="button"
                tabindex="0"
                @click="router.push(`/posts/${d.postId}`)"
                @keydown.enter="router.push(`/posts/${d.postId}`)"
              >
                <ProviderIcon :provider="d.provider" :size="20" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm text-ink">{{ channelName(d.channelId) }}</p>
                  <p class="truncate text-xs text-bad">
                    {{ d.error?.message ?? 'Publishing did not complete.' }}
                  </p>
                </div>
                <DeliveryStatusTag :status="d.status" compact />
              </li>
            </ul>
          </template>
        </Card>
      </section>

      <!-- Remaining today -->
      <section aria-labelledby="today-heading">
        <h2 id="today-heading" class="mb-2 text-sm font-semibold text-ink">Still going out today</h2>
        <Card>
          <template #content>
            <div v-if="loading" class="flex flex-col gap-3">
              <Skeleton v-for="i in 3" :key="i" height="2.5rem" />
            </div>

            <EmptyState
              v-else-if="!remainingToday.length"
              icon="pi pi-check-circle"
              title="Nothing left for today"
              message="Everything scheduled for today has already run."
              action-label="Open the calendar"
              action-icon="pi pi-calendar"
              @action="router.push('/calendar')"
            />

            <ul v-else class="flex flex-col divide-y divide-line">
              <li
                v-for="d in remainingToday"
                :key="d.id"
                class="flex min-h-14 cursor-pointer items-center gap-3 py-2"
                role="button"
                tabindex="0"
                @click="router.push(`/posts/${d.postId}`)"
                @keydown.enter="router.push(`/posts/${d.postId}`)"
              >
                <span class="w-12 shrink-0 text-sm font-medium tabular-nums text-ink-muted">
                  {{ formatTime(d.scheduledAt, ws.timezone) }}
                </span>
                <ProviderIcon :provider="d.provider" :size="20" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm text-ink">{{ channelName(d.channelId) }}</p>
                  <p class="truncate text-xs text-ink-soft">{{ providerName(d.provider) }}</p>
                </div>
                <DeliveryStatusTag :status="d.status" compact />
              </li>
            </ul>
          </template>
        </Card>
      </section>

      <!-- Upcoming -->
      <section aria-labelledby="upcoming-heading">
        <h2 id="upcoming-heading" class="mb-2 text-sm font-semibold text-ink">Coming up</h2>
        <Card>
          <template #content>
            <div v-if="loading" class="flex flex-col gap-3">
              <Skeleton v-for="i in 3" :key="i" height="2.5rem" />
            </div>

            <EmptyState
              v-else-if="!upcomingPosts.length"
              icon="pi pi-calendar-plus"
              title="Nothing scheduled yet"
              message="Create your first post and pick a time for it."
              action-label="Create a post"
              action-icon="pi pi-plus"
              :disabled="!ws.can('content.write')"
              @action="router.push('/compose')"
            />

            <ul v-else class="flex flex-col divide-y divide-line">
              <li
                v-for="p in upcomingPosts"
                :key="p.id"
                class="flex min-h-14 cursor-pointer items-center gap-3 py-2"
                role="button"
                tabindex="0"
                @click="router.push(`/posts/${p.id}`)"
                @keydown.enter="router.push(`/posts/${p.id}`)"
              >
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm text-ink">
                    {{ p.titleInternal || p.masterContent?.text || 'Untitled post' }}
                  </p>
                  <p class="truncate text-xs text-ink-soft">{{ formatDateTime(p.calendarAt, ws.timezone) }}</p>
                </div>
                <div class="flex shrink-0 items-center gap-1">
                  <ProviderIcon
                    v-for="d in Object.values(p.deliverySummary ?? {}).slice(0, 4)"
                    :key="d.deliveryId"
                    :provider="d.provider"
                    :size="16"
                  />
                </div>
              </li>
            </ul>
          </template>
        </Card>
      </section>
    </template>
  </div>
</template>

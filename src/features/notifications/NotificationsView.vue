<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Card from 'primevue/card';
import Button from 'primevue/button';
import Skeleton from 'primevue/skeleton';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import Badge from 'primevue/badge';
import type { AppNotification, NotificationKind } from '@shared/index';
import { useNotifications } from '@/composables/useNotifications';
import { useAuthStore } from '@/stores/auth';
import { useWorkspaceStore } from '@/stores/workspace';
import { api } from '@/services/api';
import { useFeedback } from '@/composables/useFeedback';
import { formatRelative } from '@/lib/format';
import EmptyState from '@/components/domain/EmptyState.vue';
import ErrorState from '@/components/domain/ErrorState.vue';

/** Notification centre: what failed, what needs reconnecting, what finished. */
const router = useRouter();
const auth = useAuthStore();
const ws = useWorkspaceStore();
const { reportApiError } = useFeedback();
const { notifications, unread, unreadCount, loading, error } = useNotifications();

const tab = ref<'unread' | 'all'>('unread');
const marking = ref(false);

const KIND_UI: Record<NotificationKind, { icon: string; tone: string }> = {
  published: { icon: 'pi pi-check-circle', tone: 'text-ok' },
  partial: { icon: 'pi pi-exclamation-triangle', tone: 'text-warn' },
  failed: { icon: 'pi pi-times-circle', tone: 'text-bad' },
  reauth: { icon: 'pi pi-key', tone: 'text-bad' },
};

const visible = computed(() => (tab.value === 'unread' ? unread.value : notifications.value));

function isUnread(n: AppNotification): boolean {
  return !(n.readBy ?? []).includes(auth.user?.uid ?? '');
}

async function markRead(ids: string[]) {
  if (!ws.workspaceId || !ids.length) return;
  marking.value = true;
  try {
    await api.markNotificationsRead({ workspaceId: ws.workspaceId, ids });
  } catch (e) {
    reportApiError(e, 'Could not update notifications');
  } finally {
    marking.value = false;
  }
}

function open(n: AppNotification) {
  if (isUnread(n)) void markRead([n.id]);
  if (n.postId) void router.push(`/posts/${n.postId}`);
  else if (n.connectionId) void router.push('/connections');
}

// Land on "All" when there is nothing unread, so the screen is never empty for
// no reason.
watch(
  unreadCount,
  (c) => {
    if (c === 0 && notifications.value.length > 0) tab.value = 'all';
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex flex-col gap-4 p-3 lg:p-6">
    <ErrorState v-if="error" :message="error.message" :retryable="false" />

    <template v-else>
      <div class="flex items-center gap-2">
        <Tabs v-model:value="tab" class="min-w-0 flex-1">
          <TabList>
            <Tab value="unread">
              Unread
              <Badge v-if="unreadCount" :value="String(unreadCount)" severity="danger" class="ml-2" />
            </Tab>
            <Tab value="all">All</Tab>
          </TabList>
        </Tabs>

        <Button
          v-if="unreadCount"
          label="Mark all read"
          icon="pi pi-check"
          size="small"
          text
          :loading="marking"
          @click="markRead(unread.map((n) => n.id))"
        />
      </div>

      <div v-if="loading" class="flex flex-col gap-3">
        <Skeleton v-for="i in 4" :key="i" height="4rem" />
      </div>

      <EmptyState
        v-else-if="!visible.length"
        icon="pi pi-bell"
        :title="tab === 'unread' ? 'Nothing unread' : 'No notifications yet'"
        :message="
          tab === 'unread'
            ? 'You are up to date.'
            : 'You will be told here when a publication fails or an account needs reconnecting.'
        "
      />

      <Card v-else>
        <template #content>
          <ul class="flex flex-col divide-y divide-line">
            <li v-for="n in visible" :key="n.id">
              <button
                type="button"
                class="flex w-full min-h-14 items-start gap-3 py-3 text-left"
                @click="open(n)"
              >
                <i :class="[KIND_UI[n.kind].icon, KIND_UI[n.kind].tone]" class="mt-0.5" aria-hidden="true" />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-2">
                    <span class="truncate text-sm font-medium text-ink">{{ n.title }}</span>
                    <span v-if="isUnread(n)" class="h-2 w-2 shrink-0 rounded-full bg-brand-500" aria-label="Unread" />
                  </span>
                  <span class="mt-0.5 block text-xs text-ink-muted">{{ n.body }}</span>
                  <span class="mt-0.5 block text-xs text-ink-soft">
                    {{ formatRelative(n.createdAt, ws.timezone) }}
                  </span>
                </span>
                <i v-if="n.postId || n.connectionId" class="pi pi-chevron-right mt-1 text-xs text-ink-soft" aria-hidden="true" />
              </button>
            </li>
          </ul>
        </template>
      </Card>

      <p class="text-center text-xs text-ink-soft">
        Choose which of these also arrive as push notifications in
        <Button label="Settings" text size="small" @click="router.push('/settings')" />.
      </p>
    </template>
  </div>
</template>

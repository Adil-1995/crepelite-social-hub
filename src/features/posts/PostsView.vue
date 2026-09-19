<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { collection, orderBy, where } from 'firebase/firestore';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import SelectButton from 'primevue/selectbutton';
import Skeleton from 'primevue/skeleton';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import IconField from 'primevue/iconfield';
import Menu from 'primevue/menu';
import InputIcon from 'primevue/inputicon';
import type { MenuItem } from 'primevue/menuitem';
import type { DeliverySummaryEntry, Post, PostStatus } from '@shared/index';
import { db } from '@/app/firebase';
import { usePagedQuery } from '@/composables/useFirestore';
import { useWorkspaceStore } from '@/stores/workspace';
import { usePostActions } from '@/composables/usePostActions';
import { formatDateTime, truncate } from '@/lib/format';
import PostCard from '@/components/domain/PostCard.vue';
import PostStatusTag from '@/components/domain/PostStatusTag.vue';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';
import EmptyState from '@/components/domain/EmptyState.vue';
import ErrorState from '@/components/domain/ErrorState.vue';

/**
 * Post list. Cards on phones, DataTable from `lg` up — the table is the added
 * case, never a squeezed desktop layout forced onto a small screen.
 */
const ws = useWorkspaceStore();
const route = useRoute();
const router = useRouter();
const actions = usePostActions();

const statusOptions: Array<{ label: string; value: PostStatus | null }> = [
  { label: 'All', value: null },
  { label: 'Draft', value: 'draft' },
  { label: 'Scheduled', value: 'scheduled' },
  { label: 'Publishing', value: 'publishing' },
  { label: 'Published', value: 'published' },
  { label: 'Partial', value: 'partially_published' },
  { label: 'Failed', value: 'failed' },
];

const status = ref<PostStatus | null>((route.query.status as PostStatus) ?? null);
const search = ref('');

watch(status, (s) => {
  void router.replace({ query: s ? { status: s } : {} });
});

const { items, loading, done, error, loadMore, reset } = usePagedQuery<Post>(
  () => {
    if (!ws.workspaceId) return null;
    const base = collection(db, `workspaces/${ws.workspaceId}/posts`);
    const constraints = status.value
      ? [where('status', '==', status.value), orderBy('updatedAt', 'desc')]
      : [orderBy('updatedAt', 'desc')];
    return { base, constraints };
  },
  20,
  [() => ws.workspaceId, status],
);

const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return items.value;
  return items.value.filter(
    (p) =>
      p.titleInternal?.toLowerCase().includes(q) ||
      p.masterContent?.text?.toLowerCase().includes(q),
  );
});

/** DataTable slot props are untyped, so narrow once here. */
function summaryOf(p: Post): DeliverySummaryEntry[] {
  return Object.values(p.deliverySummary ?? {});
}

function titleOf(p: Post): string {
  const t = p.titleInternal?.trim();
  if (t) return t;
  const text = p.masterContent?.text?.trim();
  return text ? truncate(text, 80) : 'Untitled post';
}

function menuFor(p: Post): MenuItem[] {
  return actions.menuItems(p, () => reset());
}

// One popup Menu is reused by every table row.
const rowMenu = ref<InstanceType<typeof Menu> | null>(null);
const rowMenuItems = ref<MenuItem[]>([]);

function openRowMenu(event: Event, post: Post) {
  rowMenuItems.value = menuFor(post);
  rowMenu.value?.toggle(event);
}

function open(postId: string) {
  void router.push(`/posts/${postId}`);
}
</script>

<template>
  <div class="flex flex-col gap-4 p-3 lg:p-6">
    <div class="flex flex-col gap-3">
      <IconField>
        <InputIcon class="pi pi-search" />
        <InputText v-model="search" placeholder="Search loaded posts" fluid aria-label="Search posts" />
      </IconField>

      <div class="-mx-3 overflow-x-auto px-3 scrollbar-none">
        <SelectButton
          v-model="status"
          :options="statusOptions"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          aria-label="Filter by status"
          class="w-max"
        />
      </div>
    </div>

    <ErrorState v-if="error" :message="error.message" @retry="reset" />

    <template v-else>
      <div v-if="loading && !items.length" class="flex flex-col gap-3">
        <Skeleton v-for="i in 5" :key="i" height="6rem" />
      </div>

      <EmptyState
        v-else-if="!visible.length"
        icon="pi pi-list"
        :title="status || search ? 'No posts match' : 'No posts yet'"
        :message="
          status || search
            ? 'Try another filter or search term.'
            : 'Create your first post and choose where and when it goes out.'
        "
        :action-label="status || search ? undefined : 'Create a post'"
        action-icon="pi pi-plus"
        :disabled="!ws.can('content.write')"
        @action="router.push('/compose')"
      />

      <template v-else>
        <!-- Phones -->
        <ul class="flex flex-col gap-3 lg:hidden">
          <li v-for="p in visible" :key="p.id">
            <PostCard :post="p" :actions="menuFor(p)" @open="open" />
          </li>
        </ul>

        <!-- Desktop -->
        <DataTable
          :value="visible"
          class="hidden lg:block"
          data-key="id"
          striped-rows
          size="small"
          row-hover
          :rows="visible.length"
          aria-label="Posts"
          @row-click="(e) => open((e.data as Post).id)"
        >
          <Column header="Post">
            <template #body="{ data }">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium text-ink">{{ titleOf(data) }}</p>
                <p v-if="data.masterContent?.text" class="truncate text-xs text-ink-soft">
                  {{ data.masterContent.text }}
                </p>
              </div>
            </template>
          </Column>

          <Column header="Status" style="width: 11rem">
            <template #body="{ data }"><PostStatusTag :status="data.status" /></template>
          </Column>

          <Column header="Destinations" style="width: 12rem">
            <template #body="{ data }">
              <div class="flex items-center gap-1">
                <ProviderIcon
                  v-for="d in summaryOf(data)"
                  :key="d.deliveryId"
                  :provider="d.provider"
                  :size="16"
                />
                <span v-if="!summaryOf(data).length" class="text-xs text-ink-soft">—</span>
              </div>
            </template>
          </Column>

          <Column header="When" style="width: 14rem">
            <template #body="{ data }">
              <span class="text-sm">{{ formatDateTime(data.calendarAt, ws.timezone) }}</span>
            </template>
          </Column>

          <Column style="width: 4rem">
            <template #body="{ data }">
              <Button
                icon="pi pi-ellipsis-v"
                text
                rounded
                severity="secondary"
                aria-label="Post actions"
                @click.stop="openRowMenu($event, data)"
              />
            </template>
          </Column>
        </DataTable>

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

    <Menu ref="rowMenu" :model="rowMenuItems" :popup="true" />
  </div>
</template>

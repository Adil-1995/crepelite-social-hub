<script setup lang="ts">
import { computed } from 'vue';
import Card from 'primevue/card';
import Menu from 'primevue/menu';
import Button from 'primevue/button';
import { ref } from 'vue';
import type { MenuItem } from 'primevue/menuitem';
import type { Post } from '@shared/index';
import { useWorkspaceStore } from '@/stores/workspace';
import { formatDateTime, truncate } from '@/lib/format';
import PostStatusTag from '@/components/domain/PostStatusTag.vue';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';
import DeliveryStatusTag from '@/components/domain/DeliveryStatusTag.vue';

/** Mobile-first summary of a post. Used by the posts list and the calendar agenda. */
const props = defineProps<{ post: Post; actions?: MenuItem[] }>();
const emit = defineEmits<{ open: [postId: string] }>();

const ws = useWorkspaceStore();
const menu = ref<InstanceType<typeof Menu> | null>(null);

const summary = computed(() => Object.values(props.post.deliverySummary ?? {}));
const when = computed(() => formatDateTime(props.post.calendarAt ?? props.post.schedule?.scheduledAt ?? null, ws.timezone));
const title = computed(() => {
  const t = props.post.titleInternal?.trim();
  if (t) return t;
  const text = props.post.masterContent?.text?.trim();
  return text ? truncate(text, 80) : 'Untitled post';
});
</script>

<template>
  <Card
    class="cursor-pointer transition-shadow hover:shadow-md"
    role="button"
    tabindex="0"
    :aria-label="`Open post ${title}`"
    @click="emit('open', post.id)"
    @keydown.enter.prevent="emit('open', post.id)"
    @keydown.space.prevent="emit('open', post.id)"
  >
    <template #content>
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <div class="mb-1 flex flex-wrap items-center gap-2">
            <PostStatusTag :status="post.status" />
            <span class="text-xs text-ink-soft">{{ when }}</span>
          </div>

          <p class="truncate text-sm font-semibold text-ink">{{ title }}</p>
          <p v-if="post.masterContent?.text" class="mt-0.5 line-clamp-2 text-xs text-ink-muted">
            {{ post.masterContent.text }}
          </p>

          <ul v-if="summary.length" class="mt-2 flex flex-wrap items-center gap-2">
            <li v-for="d in summary" :key="d.deliveryId" class="flex items-center gap-1">
              <ProviderIcon :provider="d.provider" :size="16" />
              <DeliveryStatusTag :status="d.status" compact />
            </li>
          </ul>
        </div>

        <Button
          v-if="actions?.length"
          icon="pi pi-ellipsis-v"
          text
          rounded
          severity="secondary"
          aria-label="Post actions"
          aria-haspopup="true"
          @click.stop="menu?.toggle($event)"
        />
        <Menu v-if="actions?.length" ref="menu" :model="actions" :popup="true" />
      </div>
    </template>
  </Card>
</template>

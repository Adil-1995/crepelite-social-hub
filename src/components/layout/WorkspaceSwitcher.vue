<script setup lang="ts">
import { computed, ref } from 'vue';
import Button from 'primevue/button';
import Menu from 'primevue/menu';
import type { MenuItem } from 'primevue/menuitem';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useWorkspaceStore } from '@/stores/workspace';

/** Switches the active workspace. Collapses to a label when there is only one. */
const auth = useAuthStore();
const ws = useWorkspaceStore();
const router = useRouter();
const menu = ref<InstanceType<typeof Menu> | null>(null);

const current = computed(
  () => ws.workspace?.name ?? auth.memberships.find((m) => m.workspaceId === ws.workspaceId)?.workspaceName ?? 'Workspace',
);

const items = computed<MenuItem[]>(() => {
  const list: MenuItem[] = auth.memberships.map((m) => ({
    label: m.workspaceName,
    icon: m.workspaceId === ws.workspaceId ? 'pi pi-check' : 'pi pi-building',
    command: () => ws.select(m.workspaceId),
  }));
  if (auth.canCreateWorkspace) {
    list.push({ separator: true }, { label: 'New workspace', icon: 'pi pi-plus', command: () => router.push('/onboarding') });
  }
  return list;
});
</script>

<template>
  <div v-if="auth.memberships.length > 1 || auth.canCreateWorkspace">
    <Button
      text
      severity="secondary"
      class="max-w-[12rem]"
      aria-haspopup="true"
      aria-label="Switch workspace"
      @click="menu?.toggle($event)"
    >
      <i class="pi pi-building mr-2" aria-hidden="true" />
      <span class="truncate">{{ current }}</span>
      <i class="pi pi-chevron-down ml-2 text-xs" aria-hidden="true" />
    </Button>
    <Menu ref="menu" :model="items" :popup="true" />
  </div>
  <span v-else class="truncate font-semibold text-ink">{{ current }}</span>
</template>

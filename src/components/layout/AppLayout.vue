<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from 'primevue/button';
import Avatar from 'primevue/avatar';
import Menu from 'primevue/menu';
import Badge from 'primevue/badge';
import Message from 'primevue/message';
import Drawer from 'primevue/drawer';
import type { MenuItem } from 'primevue/menuitem';
import type { Permission } from '@shared/index';
import { useAuthStore } from '@/stores/auth';
import { useWorkspaceStore } from '@/stores/workspace';
import { useUiStore } from '@/stores/ui';
import { useUnreadCount } from '@/composables/useNotifications';
import { installPromptAvailable, promptInstall } from '@/app/pwa';
import { initials } from '@/lib/format';
import WorkspaceSwitcher from '@/components/layout/WorkspaceSwitcher.vue';

/**
 * Application shell: bottom navigation on phones, sidebar from `lg` up.
 * Mobile-first — the desktop layout is the added case, not the baseline.
 */
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const ws = useWorkspaceStore();
const ui = useUiStore();
const unread = useUnreadCount();
const profileMenu = ref<InstanceType<typeof Menu> | null>(null);

interface NavEntry {
  label: string;
  icon: string;
  to: string;
  permission?: Permission;
}

/** Bottom bar destinations, either side of the central Create action. */
const primaryNav: NavEntry[] = [
  { label: 'Calendar', icon: 'pi pi-calendar', to: '/calendar' },
  { label: 'Posts', icon: 'pi pi-list', to: '/posts' },
  { label: 'Media', icon: 'pi pi-images', to: '/media' },
  { label: 'More', icon: 'pi pi-bars', to: '/more' },
];

const sidebarNav: NavEntry[] = [
  { label: 'Today', icon: 'pi pi-home', to: '/dashboard' },
  { label: 'Calendar', icon: 'pi pi-calendar', to: '/calendar' },
  { label: 'Posts', icon: 'pi pi-list', to: '/posts' },
  { label: 'Media', icon: 'pi pi-images', to: '/media' },
  { label: 'Bulk planner', icon: 'pi pi-clone', to: '/bulk', permission: 'content.schedule' },
  { label: 'Import', icon: 'pi pi-download', to: '/import', permission: 'content.write' },
  { label: 'Connections', icon: 'pi pi-link', to: '/connections' },
  { label: 'Activity', icon: 'pi pi-history', to: '/logs' },
  { label: 'Settings', icon: 'pi pi-cog', to: '/settings' },
];

const visibleSidebar = computed(() => sidebarNav.filter((e) => !e.permission || ws.can(e.permission)));
const canCreate = computed(() => ws.can('content.write'));
const attention = computed(() => ws.attentionConnections);

function isActive(to: string): boolean {
  return route.path === to || route.path.startsWith(to + '/');
}

const activeClass = 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-900/40 dark:text-brand-200';

const profileItems = computed<MenuItem[]>(() => [
  { label: auth.user?.email ?? 'Signed in', disabled: true },
  { separator: true },
  { label: 'Settings', icon: 'pi pi-cog', command: () => router.push('/settings') },
  { label: 'Notifications', icon: 'pi pi-bell', command: () => router.push('/notifications') },
  { separator: true },
  {
    label: 'Sign out',
    icon: 'pi pi-sign-out',
    command: async () => {
      await auth.signOut();
      await router.push('/login');
    },
  },
]);
</script>

<template>
  <div class="min-h-dvh bg-app">
    <!-- Desktop sidebar -->
    <aside
      class="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-line bg-surface lg:flex"
      aria-label="Main navigation"
    >
      <div class="flex h-16 items-center gap-2 border-b border-line px-4">
        <img src="/favicon.svg" alt="" class="h-7 w-7" aria-hidden="true" />
        <span class="font-semibold text-ink">CrepeLite</span>
      </div>

      <div class="border-b border-line px-3 py-2">
        <WorkspaceSwitcher />
      </div>

      <nav class="flex-1 overflow-y-auto p-2">
        <ul class="flex flex-col gap-0.5">
          <li v-for="e in visibleSidebar" :key="e.to">
            <RouterLink
              :to="e.to"
              class="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors"
              :class="isActive(e.to) ? activeClass : 'text-ink-muted hover:bg-muted'"
              :aria-current="isActive(e.to) ? 'page' : undefined"
            >
              <i :class="e.icon" aria-hidden="true" />
              <span>{{ e.label }}</span>
            </RouterLink>
          </li>
        </ul>
      </nav>

      <div class="border-t border-line p-3">
        <Button v-if="canCreate" label="Create post" icon="pi pi-plus" fluid @click="router.push('/compose')" />
      </div>
    </aside>

    <!-- Top bar -->
    <header class="safe-top sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur lg:pl-60" role="banner">
      <div class="flex h-14 items-center gap-2 px-3">
        <Button
          class="lg:hidden"
          icon="pi pi-bars"
          text
          rounded
          severity="secondary"
          aria-label="Open navigation"
          @click="ui.navDrawerOpen = true"
        />

        <h1 class="min-w-0 flex-1 truncate text-base font-semibold text-ink">
          {{ route.meta.title ?? 'CrepeLite' }}
        </h1>

        <Button
          v-if="installPromptAvailable"
          icon="pi pi-download"
          text
          rounded
          severity="secondary"
          aria-label="Install app"
          title="Install app"
          @click="promptInstall()"
        />

        <div class="relative">
          <Button
            icon="pi pi-bell"
            text
            rounded
            severity="secondary"
            :aria-label="unread > 0 ? 'Notifications, ' + unread + ' unread' : 'Notifications'"
            @click="router.push('/notifications')"
          />
          <Badge
            v-if="unread > 0"
            :value="unread > 9 ? '9+' : String(unread)"
            severity="danger"
            class="pointer-events-none absolute -right-0.5 -top-0.5"
          />
        </div>

        <Button
          text
          rounded
          severity="secondary"
          aria-label="Account menu"
          aria-haspopup="true"
          @click="profileMenu?.toggle($event)"
        >
          <Avatar
            :image="auth.user?.photoURL ?? undefined"
            :label="auth.user?.photoURL ? undefined : initials(auth.user?.displayName ?? auth.user?.email)"
            shape="circle"
            size="normal"
          />
        </Button>
        <Menu ref="profileMenu" :model="profileItems" :popup="true" />
      </div>

      <div v-if="!ui.online" class="bg-warn-bg px-3 py-1.5 text-center text-xs font-medium text-warn">
        <i class="pi pi-wifi mr-1" aria-hidden="true" />
        Offline — changes will sync when you reconnect.
      </div>
    </header>

    <!-- Mobile navigation drawer -->
    <Drawer v-model:visible="ui.navDrawerOpen" header="CrepeLite" class="w-72">
      <div class="mb-3">
        <WorkspaceSwitcher />
      </div>
      <nav aria-label="Navigation">
        <ul class="flex flex-col gap-0.5">
          <li v-for="e in visibleSidebar" :key="e.to">
            <RouterLink
              :to="e.to"
              class="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm"
              :class="isActive(e.to) ? activeClass : 'text-ink-muted'"
              @click="ui.navDrawerOpen = false"
            >
              <i :class="e.icon" aria-hidden="true" />
              <span>{{ e.label }}</span>
            </RouterLink>
          </li>
        </ul>
      </nav>
    </Drawer>

    <!-- Content -->
    <main class="pb-nav lg:pb-8 lg:pl-60" role="main">
      <Message v-if="attention.length" severity="warn" :closable="false" class="mx-3 mt-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm">
            {{ attention.length }} {{ attention.length === 1 ? 'account needs' : 'accounts need' }} attention.
          </span>
          <Button label="Review" size="small" text @click="router.push('/connections')" />
        </div>
      </Message>

      <slot />
    </main>

    <!-- Mobile bottom navigation -->
    <nav
      class="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur lg:hidden"
      aria-label="Primary"
    >
      <ul class="grid grid-cols-5 items-center">
        <li v-for="(e, i) in primaryNav" :key="e.to" :style="{ gridColumn: i < 2 ? i + 1 : i + 2 }">
          <RouterLink
            :to="e.to"
            class="flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px]"
            :class="isActive(e.to) ? 'text-brand-600 dark:text-brand-300' : 'text-ink-soft'"
            :aria-current="isActive(e.to) ? 'page' : undefined"
          >
            <i :class="e.icon" class="text-lg" aria-hidden="true" />
            <span>{{ e.label }}</span>
          </RouterLink>
        </li>

        <li class="flex justify-center" style="grid-column: 3; grid-row: 1">
          <Button
            icon="pi pi-plus"
            rounded
            :disabled="!canCreate"
            class="-mt-6 h-14 w-14 shadow-lg"
            aria-label="Create post"
            @click="router.push('/compose')"
          />
        </li>
      </ul>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import Card from 'primevue/card';
import Button from 'primevue/button';
import SelectButton from 'primevue/selectbutton';
import type { Permission } from '@shared/index';
import { useWorkspaceStore } from '@/stores/workspace';
import { useAuthStore } from '@/stores/auth';
import { useUiStore, type ThemeMode } from '@/stores/ui';
import { installPromptAvailable, promptInstall, isStandalone } from '@/app/pwa';
import { initials } from '@/lib/format';
import Avatar from 'primevue/avatar';

/** Mobile "More" hub: the destinations that do not fit in the bottom bar. */
const router = useRouter();
const ws = useWorkspaceStore();
const auth = useAuthStore();
const ui = useUiStore();

interface Entry {
  label: string;
  description: string;
  icon: string;
  to: string;
  permission?: Permission;
}

const entries: Entry[] = [
  { label: 'Today', description: 'What is going out and what needs attention', icon: 'pi pi-home', to: '/dashboard' },
  { label: 'Connections', description: 'Connect and manage social accounts', icon: 'pi pi-link', to: '/connections' },
  { label: 'Bulk planner', description: 'Schedule many posts across a date range', icon: 'pi pi-clone', to: '/bulk', permission: 'content.schedule' },
  { label: 'Import & crosspost', description: 'Bring your own posts back in', icon: 'pi pi-download', to: '/import', permission: 'content.write' },
  { label: 'Notifications', description: 'Failures, reconnects and finished jobs', icon: 'pi pi-bell', to: '/notifications' },
  { label: 'Activity log', description: 'Who changed what, and when', icon: 'pi pi-history', to: '/logs' },
  { label: 'Settings', description: 'Workspace, team and notifications', icon: 'pi pi-cog', to: '/settings' },
];

const visible = computed(() => entries.filter((e) => !e.permission || ws.can(e.permission)));

const themeOptions: Array<{ label: string; value: ThemeMode; icon: string }> = [
  { label: 'Light', value: 'light', icon: 'pi pi-sun' },
  { label: 'Dark', value: 'dark', icon: 'pi pi-moon' },
  { label: 'System', value: 'system', icon: 'pi pi-desktop' },
];

const showInstall = computed(() => installPromptAvailable.value && !isStandalone());

async function signOut() {
  await auth.signOut();
  await router.replace('/login');
}
</script>

<template>
  <div class="flex flex-col gap-4 p-3 lg:p-6">
    <Card>
      <template #content>
        <div class="flex items-center gap-3">
          <Avatar
            :image="auth.user?.photoURL ?? undefined"
            :label="auth.user?.photoURL ? undefined : initials(auth.user?.displayName ?? auth.user?.email)"
            shape="circle"
            size="large"
          />
          <div class="min-w-0 flex-1">
            <p class="truncate font-semibold text-ink">{{ auth.user?.displayName || 'Your account' }}</p>
            <p class="truncate text-xs text-ink-soft">{{ auth.user?.email }}</p>
            <p v-if="ws.role" class="mt-0.5 text-xs text-ink-muted">{{ ws.role }} in {{ ws.workspace?.name }}</p>
          </div>
        </div>
      </template>
    </Card>

    <Card v-if="showInstall">
      <template #content>
        <div class="flex items-center gap-3">
          <i class="pi pi-mobile text-xl text-brand-600" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-ink">Install CrepeLite</p>
            <p class="text-xs text-ink-muted">Add it to your home screen for full-screen, offline-ready access.</p>
          </div>
          <Button label="Install" size="small" @click="promptInstall()" />
        </div>
      </template>
    </Card>

    <nav aria-label="More destinations">
      <Card>
        <template #content>
          <ul class="flex flex-col divide-y divide-line">
            <li v-for="e in visible" :key="e.to">
              <button
                type="button"
                class="flex min-h-14 w-full items-center gap-3 py-2 text-left"
                @click="router.push(e.to)"
              >
                <i :class="e.icon" class="w-5 text-center text-ink-soft" aria-hidden="true" />
                <span class="min-w-0 flex-1">
                  <span class="block text-sm text-ink">{{ e.label }}</span>
                  <span class="block truncate text-xs text-ink-soft">{{ e.description }}</span>
                </span>
                <i class="pi pi-chevron-right text-xs text-ink-soft" aria-hidden="true" />
              </button>
            </li>
          </ul>
        </template>
      </Card>
    </nav>

    <Card>
      <template #content>
        <p class="mb-2 text-sm font-semibold text-ink">Appearance</p>
        <SelectButton
          :model-value="ui.themeMode"
          :options="themeOptions"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          aria-labelledby="Appearance"
          @update:model-value="ui.setThemeMode"
        />
      </template>
    </Card>

    <Button label="Sign out" icon="pi pi-sign-out" severity="secondary" outlined fluid @click="signOut" />
  </div>
</template>

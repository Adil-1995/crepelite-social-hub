<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Card from 'primevue/card';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import Message from 'primevue/message';
import SelectButton from 'primevue/selectbutton';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs, type UserProfile } from '@shared/index';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/app/firebase';
import { api } from '@/services/api';
import { useWorkspaceStore } from '@/stores/workspace';
import { useAuthStore } from '@/stores/auth';
import { useUiStore, type ThemeMode } from '@/stores/ui';
import { useFeedback } from '@/composables/useFeedback';
import { usePush } from '@/composables/usePush';
import { timezoneOptions } from '@/lib/timezones';

/** Workspace, appearance and notification settings. */
const ws = useWorkspaceStore();
const auth = useAuthStore();
const ui = useUiStore();
const router = useRouter();
const { success, reportApiError } = useFeedback();
const push = usePush();

const tab = ref('workspace');
const name = ref('');
const timezone = ref('');
const savingWorkspace = ref(false);
const prefs = ref<NotificationPrefs>({ ...DEFAULT_NOTIFICATION_PREFS });
const savingPrefs = ref(false);

const canEditWorkspace = computed(() => ws.can('workspace.settings'));

watch(
  () => ws.workspace,
  (w) => {
    if (!w) return;
    name.value = w.name;
    timezone.value = w.timezone;
  },
  { immediate: true },
);

onMounted(async () => {
  if (!auth.user) return;
  const snap = await getDoc(doc(db, `users/${auth.user.uid}`)).catch(() => null);
  if (snap?.exists()) {
    const profile = snap.data() as UserProfile;
    prefs.value = { ...DEFAULT_NOTIFICATION_PREFS, ...(profile.notificationPrefs ?? {}) };
  }
});

const workspaceDirty = computed(
  () => !!ws.workspace && (name.value !== ws.workspace.name || timezone.value !== ws.workspace.timezone),
);

async function saveWorkspace() {
  if (!ws.workspaceId || !workspaceDirty.value) return;
  savingWorkspace.value = true;
  try {
    await api.updateWorkspace({ workspaceId: ws.workspaceId, name: name.value.trim(), timezone: timezone.value });
    success('Workspace updated');
  } catch (e) {
    reportApiError(e, 'Could not update the workspace');
  } finally {
    savingWorkspace.value = false;
  }
}

async function savePrefs() {
  savingPrefs.value = true;
  try {
    // Turning push on needs browser permission and a device token first.
    if (prefs.value.pushEnabled && !push.enabled.value) {
      const granted = await push.enable();
      if (!granted) {
        prefs.value.pushEnabled = false;
        savingPrefs.value = false;
        return;
      }
    }
    await api.updateNotificationPrefs(prefs.value);
    success('Notification settings saved');
  } catch (e) {
    reportApiError(e, 'Could not save notification settings');
  } finally {
    savingPrefs.value = false;
  }
}

const themeOptions: Array<{ label: string; value: ThemeMode }> = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'System', value: 'system' },
];

const notificationRows: Array<{ key: keyof NotificationPrefs; label: string; description: string }> = [
  { key: 'onFailed', label: 'A publication fails', description: 'A destination could not publish.' },
  { key: 'onPartial', label: 'Only some destinations publish', description: 'The post went out partially.' },
  { key: 'onReauth', label: 'An account needs reconnecting', description: 'Authorisation expired or was revoked.' },
  { key: 'onPublished', label: 'Everything publishes', description: 'Confirmation for successful posts.' },
];
</script>

<template>
  <div class="flex flex-col gap-4 p-3 lg:p-6">
    <Tabs v-model:value="tab">
      <TabList>
        <Tab value="workspace">Workspace</Tab>
        <Tab value="notifications">Notifications</Tab>
        <Tab value="appearance">Appearance</Tab>
      </TabList>

      <TabPanels>
        <!-- Workspace -->
        <TabPanel value="workspace">
          <div class="flex flex-col gap-4">
            <Message v-if="!canEditWorkspace" severity="info" :closable="false">
              Only owners and admins can change workspace settings.
            </Message>

            <Card>
              <template #content>
                <form class="flex flex-col gap-4" @submit.prevent="saveWorkspace">
                  <div class="flex flex-col gap-1.5">
                    <label for="ws-name" class="text-sm font-medium text-ink">Workspace name</label>
                    <InputText
                      id="ws-name"
                      v-model="name"
                      maxlength="80"
                      :disabled="!canEditWorkspace || savingWorkspace"
                      fluid
                    />
                  </div>

                  <div class="flex flex-col gap-1.5">
                    <label for="ws-tz" class="text-sm font-medium text-ink">Timezone</label>
                    <Select
                      id="ws-tz"
                      v-model="timezone"
                      :options="timezoneOptions"
                      option-label="label"
                      option-value="value"
                      filter
                      :disabled="!canEditWorkspace || savingWorkspace"
                      fluid
                    />
                    <small class="text-ink-soft">
                      Changing this affects how existing schedules are displayed, not when they run.
                    </small>
                  </div>

                  <Button
                    type="submit"
                    label="Save changes"
                    icon="pi pi-check"
                    :disabled="!canEditWorkspace || !workspaceDirty"
                    :loading="savingWorkspace"
                    class="self-start"
                  />
                </form>
              </template>
            </Card>

            <Card>
              <template #content>
                <div class="flex items-center gap-3">
                  <i class="pi pi-users text-xl text-ink-soft" aria-hidden="true" />
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-semibold text-ink">Team</p>
                    <p class="text-xs text-ink-muted">Invite people and manage their roles.</p>
                  </div>
                  <Button label="Manage" icon="pi pi-arrow-right" icon-pos="right" size="small" text @click="router.push('/settings/team')" />
                </div>
              </template>
            </Card>
          </div>
        </TabPanel>

        <!-- Notifications -->
        <TabPanel value="notifications">
          <Card>
            <template #content>
              <div class="flex flex-col gap-4">
                <div class="flex items-start gap-3">
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-medium text-ink">Push notifications</p>
                    <p class="text-xs text-ink-muted">
                      Get alerts on this device even when CrepeLite is closed.
                    </p>
                    <p v-if="push.blocked.value" class="mt-1 text-xs text-bad">
                      Notifications are blocked in your browser settings for this site.
                    </p>
                    <p v-else-if="!push.supported.value" class="mt-1 text-xs text-warn">
                      This browser does not support web push.
                    </p>
                  </div>
                  <ToggleSwitch
                    v-model="prefs.pushEnabled"
                    :disabled="!push.supported.value || push.blocked.value"
                    aria-label="Enable push notifications"
                  />
                </div>

                <div class="flex flex-col divide-y divide-line border-t border-line">
                  <div v-for="row in notificationRows" :key="row.key" class="flex items-start gap-3 py-3">
                    <div class="min-w-0 flex-1">
                      <p class="text-sm text-ink">{{ row.label }}</p>
                      <p class="text-xs text-ink-soft">{{ row.description }}</p>
                    </div>
                    <ToggleSwitch v-model="prefs[row.key] as boolean" :aria-label="row.label" />
                  </div>
                </div>

                <Button
                  label="Save notification settings"
                  icon="pi pi-check"
                  :loading="savingPrefs"
                  class="self-start"
                  @click="savePrefs"
                />
              </div>
            </template>
          </Card>
        </TabPanel>

        <!-- Appearance -->
        <TabPanel value="appearance">
          <Card>
            <template #content>
              <div class="flex flex-col gap-3">
                <p class="text-sm font-medium text-ink">Theme</p>
                <SelectButton
                  :model-value="ui.themeMode"
                  :options="themeOptions"
                  option-label="label"
                  option-value="value"
                  :allow-empty="false"
                  aria-label="Theme"
                  @update:model-value="ui.setThemeMode"
                />
                <p class="text-xs text-ink-soft">This preference is stored on this device only.</p>
              </div>
            </template>
          </Card>
        </TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

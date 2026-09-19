<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
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
import Textarea from 'primevue/textarea';
import AutoComplete from 'primevue/autocomplete';
import ColorPicker from 'primevue/colorpicker';
import Tag from 'primevue/tag';
import {
  AI_LANGUAGES,
  AI_TONES,
  BRAND_PRESETS,
  DEFAULT_AI_SETTINGS,
  DEFAULT_APPEARANCE,
  normaliseBrandColor,
  type AiContentSettings,
} from '@shared/index';
import { applyBrandColor, cacheBrandColor, cachedBrandColor, resetBrandColor } from '@/theme/brand';

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
  void loadAi();
  void loadAppearance();
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

// ── AI content ────────────────────────────────────────────────────────────
const ai = ref<AiContentSettings>({ ...DEFAULT_AI_SETTINGS });
const aiStatus = ref<{ configured: boolean; provider: string | null; model: string | null; missing: string[] } | null>(null);
const aiHashtags = ref<string[]>([]);
const aiClaims = ref<string[]>([]);
const savingAi = ref(false);
const loadingAi = ref(false);

const aiLanguageOptions = AI_LANGUAGES.map((l) => ({ label: l.label, value: l.value }));
const aiToneOptions = AI_TONES.map((t) => ({ label: t.label + ' · ' + t.labelLatin, value: t.value }));

async function loadAi() {
  if (!ws.workspaceId) return;
  loadingAi.value = true;
  try {
    const s = await api.getAiStatus({ workspaceId: ws.workspaceId });
    ai.value = { ...s.settings };
    aiHashtags.value = [...s.settings.defaultHashtags];
    aiClaims.value = [...s.settings.forbiddenClaims];
    aiStatus.value = { configured: s.configured, provider: s.provider, model: s.model, missing: s.missing };
  } catch {
    // A workspace whose deployment has no key still renders the form; the
    // settings are saved and take effect once a key exists.
  } finally {
    loadingAi.value = false;
  }
}

async function saveAi() {
  if (!ws.workspaceId) return;
  savingAi.value = true;
  try {
    await api.updateAiSettings({
      workspaceId: ws.workspaceId,
      defaultLanguage: ai.value.defaultLanguage,
      defaultTone: ai.value.defaultTone,
      useEmojis: ai.value.useEmojis,
      useHashtags: ai.value.useHashtags,
      useCta: ai.value.useCta,
      mentionLocation: ai.value.mentionLocation,
      brandContext: ai.value.brandContext,
      forbiddenClaims: aiClaims.value,
      defaultLocation: ai.value.defaultLocation,
      defaultHashtags: aiHashtags.value,
      enabled: ai.value.enabled,
    });
    success('AI settings saved');
  } catch (e) {
    reportApiError(e, 'Could not save the AI settings');
  } finally {
    savingAi.value = false;
  }
}

// ── Brand colour ──────────────────────────────────────────────────────────
/**
 * The picker previews live, so the colour is applied as it changes and only
 * persisted on save. Leaving without saving must not strand the workspace on
 * a colour nobody chose, so the original is restored on unmount.
 */
const brandColor = ref(cachedBrandColor());
const savedBrandColor = ref(cachedBrandColor());
const savingBrand = ref(false);

/** PrimeVue's ColorPicker works in bare hex, without the leading #. */
const brandHex = computed({
  get: () => brandColor.value.replace('#', ''),
  set: (v: string) => {
    const next = normaliseBrandColor(v);
    if (next) preview(next);
  },
});

function preview(hex: string) {
  brandColor.value = hex;
  applyBrandColor(hex);
}

const brandDirty = computed(() => brandColor.value !== savedBrandColor.value);

async function loadAppearance() {
  if (!ws.workspaceId) return;
  try {
    const a = await api.getAppearance({ workspaceId: ws.workspaceId });
    savedBrandColor.value = a.brandColor;
    brandColor.value = a.brandColor;
    applyBrandColor(a.brandColor);
  } catch {
    // Falls back to whatever is cached locally.
  }
}

async function saveBrand() {
  if (!ws.workspaceId) return;
  savingBrand.value = true;
  try {
    await api.updateAppearance({ workspaceId: ws.workspaceId, brandColor: brandColor.value });
    savedBrandColor.value = brandColor.value;
    cacheBrandColor(brandColor.value);
    success('Brand colour saved', 'Everyone in this workspace sees it.');
  } catch (e) {
    reportApiError(e, 'Could not save the brand colour');
  } finally {
    savingBrand.value = false;
  }
}

function revertBrand() {
  preview(savedBrandColor.value);
}

function useDefaultBrand() {
  preview(DEFAULT_APPEARANCE.brandColor);
}

// An unsaved preview must not outlive this screen.
onUnmounted(() => {
  if (brandDirty.value) {
    if (savedBrandColor.value === DEFAULT_APPEARANCE.brandColor) resetBrandColor();
    else applyBrandColor(savedBrandColor.value);
  }
});

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
        <Tab value="ai">AI content</Tab>
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
                      input-id="ws-tz"
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

        <!-- AI content -->
        <TabPanel value="ai">
          <div class="flex flex-col gap-4">
            <Message v-if="aiStatus && !aiStatus.configured" severity="warn" :closable="false">
              <p class="text-sm font-medium">AI generation is not configured for this deployment.</p>
              <p v-if="aiStatus.missing.length" class="mt-1 text-xs">Missing: {{ aiStatus.missing.join(', ') }}</p>
              <p class="mt-1 text-xs">These settings save anyway and apply once a key is set.</p>
            </Message>
            <Message v-else-if="aiStatus" severity="secondary" :closable="false" size="small">
              <span class="text-xs">Provider: {{ aiStatus.provider }} · model: {{ aiStatus.model }}</span>
            </Message>

            <Card>
              <template #content>
                <div class="flex flex-col gap-4">
                  <div class="flex items-start gap-3">
                    <div class="min-w-0 flex-1">
                      <p class="text-sm font-medium text-ink">Enable AI captions</p>
                      <p class="text-xs text-ink-muted">Adds the generator to the composer.</p>
                    </div>
                    <ToggleSwitch v-model="ai.enabled" :disabled="!canEditWorkspace" aria-label="Enable AI captions" />
                  </div>

                  <div class="grid gap-4 sm:grid-cols-2">
                    <div class="flex flex-col gap-1.5">
                      <label for="ai-default-lang" class="text-sm font-medium text-ink">Default language</label>
                      <Select
                        input-id="ai-default-lang"
                        v-model="ai.defaultLanguage"
                        :options="aiLanguageOptions"
                        option-label="label"
                        option-value="value"
                        :disabled="!canEditWorkspace"
                        fluid
                      />
                      <small class="text-ink-soft">Moroccan Darija is written in Arabic script.</small>
                    </div>
                    <div class="flex flex-col gap-1.5">
                      <label for="ai-default-tone" class="text-sm font-medium text-ink">Default tone</label>
                      <Select
                        input-id="ai-default-tone"
                        v-model="ai.defaultTone"
                        :options="aiToneOptions"
                        option-label="label"
                        option-value="value"
                        :disabled="!canEditWorkspace"
                        fluid
                      />
                    </div>
                  </div>

                  <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <label class="flex items-center gap-2 text-sm text-ink">
                      <ToggleSwitch v-model="ai.useEmojis" :disabled="!canEditWorkspace" aria-label="Emojis by default" /> Emojis
                    </label>
                    <label class="flex items-center gap-2 text-sm text-ink">
                      <ToggleSwitch v-model="ai.useHashtags" :disabled="!canEditWorkspace" aria-label="Hashtags by default" /> Hashtags
                    </label>
                    <label class="flex items-center gap-2 text-sm text-ink">
                      <ToggleSwitch v-model="ai.useCta" :disabled="!canEditWorkspace" aria-label="Call to action by default" /> CTA
                    </label>
                    <label class="flex items-center gap-2 text-sm text-ink">
                      <ToggleSwitch v-model="ai.mentionLocation" :disabled="!canEditWorkspace" aria-label="Mention location by default" /> Location
                    </label>
                  </div>

                  <div class="flex flex-col gap-1.5">
                    <label for="ai-brand" class="text-sm font-medium text-ink">Brand context</label>
                    <Textarea id="ai-brand" v-model="ai.brandContext" rows="4" auto-resize maxlength="2000" :disabled="!canEditWorkspace" fluid />
                    <small class="text-ink-soft">What the business is and how it should sound. Steers every generation.</small>
                  </div>

                  <div class="flex flex-col gap-1.5">
                    <label for="ai-location" class="text-sm font-medium text-ink">Location</label>
                    <InputText id="ai-location" v-model="ai.defaultLocation" :disabled="!canEditWorkspace" fluid />
                    <small class="text-ink-soft">Only used when a generation is asked to mention it.</small>
                  </div>

                  <div class="flex flex-col gap-1.5">
                    <label for="ai-tags" class="text-sm font-medium text-ink">Always include these hashtags</label>
                    <AutoComplete input-id="ai-tags" v-model="aiHashtags" multiple :typeahead="false" :suggestions="[]" placeholder="Type and press enter" :disabled="!canEditWorkspace" fluid />
                  </div>

                  <div class="flex flex-col gap-1.5">
                    <label for="ai-claims" class="text-sm font-medium text-ink">Never claim</label>
                    <AutoComplete input-id="ai-claims" v-model="aiClaims" multiple :typeahead="false" :suggestions="[]" placeholder="e.g. prices, awards, health benefits" :disabled="!canEditWorkspace" fluid />
                    <small class="text-ink-soft">
                      The generator is already told never to invent prices, promotions or locations. Add anything
                      specific to this business.
                    </small>
                  </div>

                  <Button
                    label="Save AI settings"
                    icon="pi pi-check"
                    :loading="savingAi"
                    :disabled="!canEditWorkspace || loadingAi"
                    class="self-start"
                    @click="saveAi"
                  />
                </div>
              </template>
            </Card>
          </div>
        </TabPanel>

        <!-- Appearance -->
        <TabPanel value="appearance">
          <div class="flex flex-col gap-4">
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
                  <p class="text-xs text-ink-soft">Light or dark is per device. The brand colour below is shared.</p>
                </div>
              </template>
            </Card>

            <Card>
              <template #content>
                <div class="flex flex-col gap-4">
                  <div>
                    <p class="text-sm font-medium text-ink">Brand colour</p>
                    <p class="text-xs text-ink-muted">
                      Buttons, links, active navigation and focus rings all follow it. Changes preview immediately
                      and apply to the whole workspace once saved.
                    </p>
                  </div>

                  <Message v-if="!canEditWorkspace" severity="info" :closable="false" size="small">
                    Only owners and admins can change the brand colour.
                  </Message>

                  <!-- Presets -->
                  <ul class="flex flex-wrap gap-2">
                    <li v-for="preset in BRAND_PRESETS" :key="preset.value">
                      <button
                        type="button"
                        class="flex w-20 flex-col items-center gap-1 rounded-lg p-1 transition-opacity"
                        :class="canEditWorkspace ? 'hover:opacity-100' : 'cursor-not-allowed opacity-50'"
                        :aria-pressed="brandColor === preset.value"
                        :aria-label="preset.name"
                        :disabled="!canEditWorkspace"
                        @click="preview(preset.value)"
                      >
                        <span
                          class="block h-9 w-9 rounded-full border-2 transition-colors"
                          :class="brandColor === preset.value ? 'border-ink' : 'border-line'"
                          :style="{ backgroundColor: preset.value }"
                        />
                        <span class="truncate text-[11px] text-ink-muted">{{ preset.name }}</span>
                      </button>
                    </li>
                  </ul>

                  <!-- Custom -->
                  <div class="flex flex-wrap items-end gap-3">
                    <div class="flex flex-col gap-1.5">
                      <label for="brand-picker" class="text-sm font-medium text-ink">Custom</label>
                      <ColorPicker
                        input-id="brand-picker"
                        v-model="brandHex"
                        format="hex"
                        :disabled="!canEditWorkspace"
                      />
                    </div>
                    <div class="flex flex-col gap-1.5">
                      <label for="brand-hex" class="text-sm font-medium text-ink">Hex</label>
                      <InputText
                        id="brand-hex"
                        :model-value="brandColor"
                        class="w-32 font-mono"
                        :disabled="!canEditWorkspace"
                        @update:model-value="(v) => v && preview(normaliseBrandColor(v) ?? brandColor)"
                      />
                    </div>
                  </div>

                  <!-- What it looks like -->
                  <div class="rounded-xl border border-line p-3">
                    <p class="mb-2 text-xs font-medium text-ink-soft">Preview</p>
                    <div class="flex flex-wrap items-center gap-2">
                      <Button label="Primary" size="small" />
                      <Button label="Outlined" size="small" outlined />
                      <Button label="Text" size="small" text />
                      <Tag value="Scheduled" icon="pi pi-clock" />
                      <span class="text-sm font-medium text-brand-600">Link text</span>
                    </div>
                  </div>

                  <div class="flex flex-wrap gap-2">
                    <Button
                      label="Save brand colour"
                      icon="pi pi-check"
                      :loading="savingBrand"
                      :disabled="!canEditWorkspace || !brandDirty"
                      @click="saveBrand"
                    />
                    <Button
                      v-if="brandDirty"
                      label="Discard"
                      severity="secondary"
                      outlined
                      :disabled="savingBrand"
                      @click="revertBrand"
                    />
                    <Button
                      label="Use the default"
                      severity="secondary"
                      text
                      :disabled="!canEditWorkspace || brandColor === DEFAULT_APPEARANCE.brandColor"
                      @click="useDefaultBrand"
                    />
                  </div>
                </div>
              </template>
            </Card>
          </div>
        </TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

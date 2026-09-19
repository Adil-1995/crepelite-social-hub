<script setup lang="ts">
import { computed } from 'vue';
import Card from 'primevue/card';
import Button from 'primevue/button';
import Select from 'primevue/select';
import MultiSelect from 'primevue/multiselect';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Textarea from 'primevue/textarea';
import ToggleSwitch from 'primevue/toggleswitch';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import Chip from 'primevue/chip';
import type { SettingsField, SettingsFieldOption, SocialChannel, ValidationIssue, ProviderManifest } from '@shared/index';
import { utf16Length, byteLength, graphemeLength } from '@shared/index';
import type { DraftVariant } from '@/composables/useComposer';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';

/**
 * Per-platform customisation.
 *
 * Every control is rendered from the provider manifest — formats, supported
 * fields, limits and provider settings. Nothing here knows the name of a
 * specific network, so a new provider becomes editable with no change to this
 * component.
 */
const props = defineProps<{
  variant: DraftVariant;
  manifest: ProviderManifest;
  channel: SocialChannel | undefined;
  issues: ValidationIssue[];
  effectiveText: string;
  effectiveTitle: string;
  effectiveDescription: string;
}>();

/**
 * One-way data flow: the composer owns `draft.variants`, this editor only
 * describes the change it wants. Nothing here mutates the prop.
 */
const emit = defineEmits<{
  customise: [channelId: string];
  reset: [channelId: string];
  patch: [patch: Partial<Pick<DraftVariant, 'format' | 'offsetMinutes'>>];
  patchContent: [patch: Partial<DraftVariant['content']>];
  patchSetting: [payload: { key: string; value: unknown }];
}>();

const variant = computed(() => props.variant);

const caps = computed(() => props.manifest.capabilities);
const fields = computed(() => caps.value.fields);
const isCustom = computed(() => variant.value.syncMode === 'custom');

const formatOptions = computed(() =>
  caps.value.formats.map((f) => ({ label: f.label, value: f.id, description: f.description })),
);

const errors = computed(() => props.issues.filter((i) => i.severity === 'error'));
const warnings = computed(() => props.issues.filter((i) => i.severity === 'warning'));

/** Counts the way the provider counts, so the limit shown is the real one. */
function countFor(value: string, unit: 'utf16' | 'bytes' | 'graphemes' | undefined): number {
  if (unit === 'bytes') return byteLength(value);
  if (unit === 'graphemes') return graphemeLength(value);
  return utf16Length(value);
}

function remaining(value: string, max: number | undefined, unit: 'utf16' | 'bytes' | 'graphemes' | undefined): number | null {
  return max == null ? null : max - countFor(value, unit);
}

const textRemaining = computed(() => remaining(props.effectiveText, fields.value.text.maxLength, fields.value.text.lengthUnit));
const titleRemaining = computed(() =>
  remaining(props.effectiveTitle, fields.value.title.maxLength, fields.value.title.lengthUnit),
);
const descriptionRemaining = computed(() =>
  remaining(props.effectiveDescription, fields.value.description.maxLength, fields.value.description.lengthUnit),
);

/** Settings fields that apply to the selected format. */
const visibleSettings = computed(() =>
  props.manifest.settingsFields.filter((f) => !f.formats || f.formats.includes(variant.value.format)),
);

/** Static options, or options read from the channel metadata (Pinterest boards…). */
function optionsFor(field: SettingsField): SettingsFieldOption[] {
  if (field.optionsFromChannel) {
    const raw = props.channel?.metadata?.[field.optionsFromChannel];
    if (Array.isArray(raw)) return raw as SettingsFieldOption[];
    return [];
  }
  return field.options ?? [];
}

function settingValue(key: string): unknown {
  return variant.value.providerSettings[key];
}

function setSetting(key: string, value: unknown) {
  emit('patchSetting', { key, value });
}

function fieldIssue(field: string): ValidationIssue | undefined {
  return props.issues.find((i) => i.field === field || i.field === `settings.${field}`);
}
</script>

<template>
  <Card>
    <template #content>
      <!-- Header -->
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <ProviderIcon :provider="variant.provider" :size="22" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-ink">{{ channel?.name ?? manifest.displayName }}</p>
          <p class="truncate text-xs text-ink-soft">{{ manifest.displayName }}</p>
        </div>
        <Tag
          :value="isCustom ? 'Customised' : 'Follows master'"
          :severity="isCustom ? 'info' : 'secondary'"
          :icon="isCustom ? 'pi pi-pencil' : 'pi pi-link'"
        />
      </div>

      <!-- Issues -->
      <Message v-if="errors.length" severity="error" :closable="false" class="mb-3" size="small">
        <ul class="flex list-disc flex-col gap-0.5 pl-4">
          <li v-for="(i, idx) in errors" :key="idx" class="text-xs">{{ i.message }}</li>
        </ul>
      </Message>
      <Message v-else-if="warnings.length" severity="warn" :closable="false" class="mb-3" size="small">
        <ul class="flex list-disc flex-col gap-0.5 pl-4">
          <li v-for="(i, idx) in warnings" :key="idx" class="text-xs">{{ i.message }}</li>
        </ul>
      </Message>

      <div class="flex flex-col gap-4">
        <!-- Format -->
        <div v-if="formatOptions.length > 1" class="flex flex-col gap-1.5">
          <label :for="`format-${variant.channelId}`" class="text-sm font-medium text-ink">Format</label>
          <Select
            :input-id="`format-${variant.channelId}`"
            :model-value="variant.format"
            @update:model-value="(v) => emit('patch', { format: v as string })"
            :options="formatOptions"
            option-label="label"
            option-value="value"
            :invalid="!!fieldIssue('format')"
            fluid
          >
            <template #option="{ option }">
              <div class="flex flex-col">
                <span>{{ option.label }}</span>
                <span v-if="option.description" class="text-xs text-ink-soft">{{ option.description }}</span>
              </div>
            </template>
          </Select>
        </div>

        <!-- Sync controls -->
        <div class="flex flex-wrap items-center gap-2">
          <Button
            v-if="!isCustom"
            label="Customise for this platform"
            icon="pi pi-pencil"
            size="small"
            severity="secondary"
            outlined
            @click="emit('customise', variant.channelId)"
          />
          <Button
            v-else
            label="Reset to master"
            icon="pi pi-undo"
            size="small"
            severity="secondary"
            outlined
            @click="emit('reset', variant.channelId)"
          />
        </div>

        <!-- Content -->
        <template v-if="isCustom">
          <div v-if="fields.title.supported" class="flex flex-col gap-1.5">
            <label :for="`title-${variant.channelId}`" class="text-sm font-medium text-ink">
              {{ fields.title.label ?? 'Title' }}
              <span v-if="fields.title.required" class="text-bad" aria-hidden="true">*</span>
            </label>
            <InputText
              :id="`title-${variant.channelId}`"
              :model-value="variant.content.title"
              @update:model-value="(v) => emit('patchContent', { title: v ?? '' })"
              :invalid="!!fieldIssue('content.title')"
              fluid
            />
            <small v-if="titleRemaining !== null" :class="titleRemaining < 0 ? 'text-bad' : 'text-ink-soft'">
              {{ titleRemaining }} left
            </small>
          </div>

          <div v-if="fields.text.supported" class="flex flex-col gap-1.5">
            <label :for="`text-${variant.channelId}`" class="text-sm font-medium text-ink">
              {{ fields.text.label ?? 'Caption' }}
              <span v-if="fields.text.required" class="text-bad" aria-hidden="true">*</span>
            </label>
            <Textarea
              :id="`text-${variant.channelId}`"
              :model-value="variant.content.text"
              @update:model-value="(v) => emit('patchContent', { text: v ?? '' })"
              rows="4"
              auto-resize
              :invalid="!!fieldIssue('content.text')"
              fluid
            />
            <small v-if="textRemaining !== null" :class="textRemaining < 0 ? 'text-bad' : 'text-ink-soft'">
              {{ textRemaining }} left
            </small>
          </div>

          <div v-if="fields.description.supported" class="flex flex-col gap-1.5">
            <label :for="`desc-${variant.channelId}`" class="text-sm font-medium text-ink">
              {{ fields.description.label ?? 'Description' }}
            </label>
            <Textarea
              :id="`desc-${variant.channelId}`"
              :model-value="variant.content.description"
              @update:model-value="(v) => emit('patchContent', { description: v ?? '' })"
              rows="3"
              auto-resize
              :invalid="!!fieldIssue('content.description')"
              fluid
            />
            <small v-if="descriptionRemaining !== null" :class="descriptionRemaining < 0 ? 'text-bad' : 'text-ink-soft'">
              {{ descriptionRemaining }} left
            </small>
          </div>

          <div v-if="fields.link.supported" class="flex flex-col gap-1.5">
            <label :for="`link-${variant.channelId}`" class="text-sm font-medium text-ink">
              Link
              <span v-if="fields.link.required" class="text-bad" aria-hidden="true">*</span>
            </label>
            <InputText
              :id="`link-${variant.channelId}`"
              :model-value="variant.content.link"
              @update:model-value="(v) => emit('patchContent', { link: v ?? '' })"
              type="url"
              inputmode="url"
              placeholder="https://"
              :invalid="!!fieldIssue('content.link')"
              fluid
            />
          </div>
        </template>

        <!-- Read-only preview of the inherited content -->
        <div v-else class="rounded-lg bg-muted p-3">
          <p v-if="effectiveTitle" class="text-sm font-medium text-ink">{{ effectiveTitle }}</p>
          <p v-if="effectiveText" class="mt-1 whitespace-pre-wrap text-sm text-ink-muted">{{ effectiveText }}</p>
          <p v-if="!effectiveTitle && !effectiveText" class="text-sm text-ink-soft">
            This platform will use the master content.
          </p>
          <div class="mt-2 flex flex-wrap gap-1">
            <span v-if="textRemaining !== null && textRemaining < 0" class="text-xs text-bad">
              {{ -textRemaining }} characters over the limit
            </span>
          </div>
        </div>

        <!-- Provider settings -->
        <div v-if="visibleSettings.length" class="flex flex-col gap-4 border-t border-line pt-4">
          <p class="text-sm font-semibold text-ink">{{ manifest.displayName }} options</p>

          <div v-for="f in visibleSettings" :key="f.key" class="flex flex-col gap-1.5">
            <label :for="`set-${variant.channelId}-${f.key}`" class="text-sm font-medium text-ink">
              {{ f.label }}
              <span v-if="f.required" class="text-bad" aria-hidden="true">*</span>
            </label>

            <Select
              v-if="f.type === 'select'"
              :input-id="`set-${variant.channelId}-${f.key}`"
              :model-value="settingValue(f.key)"
              :options="optionsFor(f)"
              option-label="label"
              option-value="value"
              :invalid="!!fieldIssue(f.key)"
              :placeholder="optionsFor(f).length ? 'Choose' : 'Nothing available'"
              :disabled="!optionsFor(f).length"
              fluid
              @update:model-value="(v) => setSetting(f.key, v)"
            />

            <MultiSelect
              v-else-if="f.type === 'tags'"
              :input-id="`set-${variant.channelId}-${f.key}`"
              :model-value="settingValue(f.key)"
              :options="optionsFor(f)"
              option-label="label"
              option-value="value"
              :invalid="!!fieldIssue(f.key)"
              fluid
              @update:model-value="(v) => setSetting(f.key, v)"
            />

            <ToggleSwitch
              v-else-if="f.type === 'switch'"
              :input-id="`set-${variant.channelId}-${f.key}`"
              :model-value="Boolean(settingValue(f.key))"
              @update:model-value="(v) => setSetting(f.key, v)"
            />

            <InputNumber
              v-else-if="f.type === 'number'"
              :input-id="`set-${variant.channelId}-${f.key}`"
              :model-value="settingValue(f.key) as number"
              :invalid="!!fieldIssue(f.key)"
              fluid
              @update:model-value="(v) => setSetting(f.key, v)"
            />

            <Textarea
              v-else-if="f.type === 'textarea'"
              :id="`set-${variant.channelId}-${f.key}`"
              :model-value="settingValue(f.key) as string"
              rows="3"
              auto-resize
              :maxlength="f.maxLength"
              :invalid="!!fieldIssue(f.key)"
              fluid
              @update:model-value="(v) => setSetting(f.key, v)"
            />

            <InputText
              v-else
              :id="`set-${variant.channelId}-${f.key}`"
              :model-value="settingValue(f.key) as string"
              :type="f.type === 'url' ? 'url' : 'text'"
              :maxlength="f.maxLength"
              :invalid="!!fieldIssue(f.key)"
              fluid
              @update:model-value="(v) => setSetting(f.key, v)"
            />

            <small v-if="f.help" class="text-ink-soft">{{ f.help }}</small>
            <small v-if="fieldIssue(f.key)" class="text-bad">{{ fieldIssue(f.key)?.message }}</small>
          </div>
        </div>

        <!-- Timing offset -->
        <div class="flex flex-col gap-1.5 border-t border-line pt-4">
          <label :for="`offset-${variant.channelId}`" class="text-sm font-medium text-ink">
            Delay after the post time
          </label>
          <div class="flex items-center gap-2">
            <InputNumber
              :input-id="`offset-${variant.channelId}`"
              :model-value="variant.offsetMinutes"
              @update:model-value="(v) => emit('patch', { offsetMinutes: v ?? 0 })"
              :min="0"
              :max="10080"
              suffix=" min"
              show-buttons
              class="w-40"
            />
            <Chip v-if="variant.offsetMinutes > 0" :label="`+${variant.offsetMinutes} min`" />
          </div>
          <small class="text-ink-soft">Stagger networks so the same content does not appear everywhere at once.</small>
        </div>
      </div>
    </template>
  </Card>
</template>

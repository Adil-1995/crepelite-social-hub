<script setup lang="ts">
import { computed } from 'vue';
import Message from 'primevue/message';
import type { MediaAsset, ProviderManifest, SocialChannel, ValidationIssue, VariantContent } from '@shared/index';
import { composeCaption, utf16Length } from '@shared/index';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';

/**
 * What the post will look like on one network.
 *
 * The frame is chosen from the manifest's `preview` hint rather than from the
 * provider id, so a new network renders sensibly without touching this file.
 * It is a faithful sketch, not a pixel-perfect mock — its job is to catch
 * "the caption is cut off" and "the crop loses the product" before publishing,
 * not to imitate every network's chrome.
 */
const props = defineProps<{
  manifest: ProviderManifest;
  channel: SocialChannel | undefined;
  content: VariantContent;
  media: MediaAsset[];
  mediaUrls: (asset: MediaAsset) => string | null;
  issues: ValidationIssue[];
  format: string;
}>();

const formatDef = computed(() => props.manifest.capabilities.formats.find((f) => f.id === props.format));
const shape = computed(() => formatDef.value?.preview ?? 'feed');

const fields = computed(() => props.manifest.capabilities.fields);

/** The caption as the network will actually receive it. */
const caption = computed(() =>
  composeCaption(props.content.text, props.content.hashtags, props.manifest.capabilities.fields.hashtags.appendToText ?? false),
);

/** Networks cut the caption in the feed; show where the fold lands. */
const FOLD = 125;
const captionFolded = computed(() => utf16Length(caption.value) > FOLD);
const captionHead = computed(() => (captionFolded.value ? caption.value.slice(0, FOLD) : caption.value));

const first = computed(() => props.media[0] ?? null);
const firstUrl = computed(() => (first.value ? props.mediaUrls(first.value) : null));

const aspect = computed(() => {
  if (shape.value === 'vertical' || shape.value === 'story') return 'aspect-[9/16]';
  if (shape.value === 'pin') return 'aspect-[2/3]';
  if (shape.value === 'video') return 'aspect-video';
  return 'aspect-square';
});

const errors = computed(() => props.issues.filter((i) => i.severity === 'error'));
const warnings = computed(() => props.issues.filter((i) => i.severity === 'warning'));

const handle = computed(() => props.channel?.handle ?? props.channel?.name ?? props.manifest.displayName);
const displayName = computed(() => props.channel?.name ?? props.manifest.displayName);
const initial = computed(() => displayName.value.trim().slice(0, 1).toUpperCase() || '?');
</script>

<template>
  <div class="flex flex-col gap-2">
    <!-- Account header -->
    <div class="flex items-center gap-2">
      <span class="relative block">
        <span class="block h-8 w-8 overflow-hidden rounded-full bg-muted">
          <img v-if="channel?.avatarUrl" :src="channel.avatarUrl" alt="" class="h-full w-full object-cover" />
          <span v-else class="flex h-full w-full items-center justify-center text-xs font-semibold text-ink-soft">
            {{ initial }}
          </span>
        </span>
        <span class="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-surface bg-surface">
          <ProviderIcon :provider="manifest.id" :size="10" />
        </span>
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-semibold text-ink">{{ displayName }}</span>
        <span class="block truncate text-xs text-ink-soft">{{ formatDef?.label ?? manifest.displayName }}</span>
      </span>
    </div>

    <!-- The post -->
    <div class="overflow-hidden rounded-xl border border-line bg-surface">
      <!-- Title above the media where the network shows one -->
      <p v-if="fields.title.supported && content.title" class="border-b border-line px-3 py-2 text-sm font-semibold text-ink">
        {{ content.title }}
      </p>

      <!-- Media -->
      <div v-if="media.length" class="relative bg-muted" :class="aspect">
        <img
          v-if="firstUrl"
          :src="firstUrl"
          alt=""
          class="h-full w-full object-cover"
        />
        <span v-else class="flex h-full w-full items-center justify-center">
          <i :class="first?.kind === 'video' ? 'pi pi-video' : 'pi pi-image'" class="text-2xl text-ink-soft" aria-hidden="true" />
        </span>

        <span
          v-if="media.length > 1"
          class="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white"
        >
          1/{{ media.length }}
        </span>
        <span
          v-if="first?.kind === 'video'"
          class="absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white"
          aria-hidden="true"
        >
          <i class="pi pi-play" style="font-size: 0.6rem" />
        </span>
      </div>

      <div
        v-else-if="manifest.capabilities.supports.text"
        class="px-3 py-4 text-sm text-ink-soft"
      >
        Text-only post
      </div>

      <div v-else class="flex items-center justify-center gap-2 bg-muted px-3 py-6 text-xs text-ink-soft">
        <i class="pi pi-image" aria-hidden="true" />
        {{ manifest.displayName }} needs an image or video
      </div>

      <!-- Caption -->
      <div v-if="caption || content.description" class="px-3 py-2">
        <p class="whitespace-pre-wrap text-sm text-ink">
          <span class="font-semibold">{{ handle }}</span>
          {{ ' ' }}{{ captionHead }}<span v-if="captionFolded" class="text-ink-soft">… more</span>
        </p>
        <p
          v-if="fields.description.supported && content.description"
          class="mt-1 whitespace-pre-wrap text-xs text-ink-muted"
        >
          {{ content.description }}
        </p>
      </div>

      <p v-if="fields.link.supported && content.link" class="truncate border-t border-line px-3 py-2 text-xs text-info">
        {{ content.link }}
      </p>
    </div>

    <!-- Validation, inline with the preview it belongs to -->
    <Message v-if="errors.length" severity="error" :closable="false" size="small">
      <ul class="flex list-disc flex-col gap-0.5 pl-4">
        <li v-for="(i, idx) in errors" :key="idx" class="text-xs">{{ i.message }}</li>
      </ul>
    </Message>
    <Message v-else-if="warnings.length" severity="warn" :closable="false" size="small">
      <ul class="flex list-disc flex-col gap-0.5 pl-4">
        <li v-for="(i, idx) in warnings" :key="idx" class="text-xs">{{ i.message }}</li>
      </ul>
    </Message>
  </div>
</template>

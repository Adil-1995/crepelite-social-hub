<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import Message from 'primevue/message';
import Card from 'primevue/card';
import Tag from 'primevue/tag';
import Textarea from 'primevue/textarea';
import ProgressSpinner from 'primevue/progressspinner';
import Skeleton from 'primevue/skeleton';
import SelectButton from 'primevue/selectbutton';
import {
  AI_LANGUAGES,
  AI_REWRITES,
  AI_TONES,
  isRtl,
  type AiCaptionSuggestion,
  type AiLanguage,
  type AiRewrite,
  type AiTone,
  type MediaAsset,
} from '@shared/index';
import { api, type AiStatus } from '@/services/api';
import { useWorkspaceStore } from '@/stores/workspace';
import { useFeedback } from '@/composables/useFeedback';
import { extractFrames } from '@/composables/useVideoFrames';

/**
 * Caption generator.
 *
 * The model never writes into the post. It proposes, the user picks, and only
 * then does anything reach the caption field — so a bad suggestion costs a
 * glance, not a correction.
 */
const visible = defineModel<boolean>('visible', { required: true });
const props = defineProps<{
  media: MediaAsset[];
  postId: string | null;
  currentText: string;
}>();
const emit = defineEmits<{ use: [text: string, hashtags: string[]] }>();

const ws = useWorkspaceStore();
const { reportApiError, success } = useFeedback();

type Phase = 'idle' | 'analyzing' | 'generating' | 'rewriting' | 'ready' | 'error';

const status = ref<AiStatus | null>(null);
const loadingStatus = ref(false);
const phase = ref<Phase>('idle');
const errorMessage = ref<string | null>(null);
const suggestions = ref<AiCaptionSuggestion[]>([]);
const understanding = ref<string | null>(null);
const generationId = ref<string | null>(null);
const editing = ref<Record<string, string>>({});

const language = ref<AiLanguage>('ary');
const tone = ref<AiTone>('natural');
const useEmojis = ref(true);
const useHashtags = ref(true);
const useCta = ref(true);
const mentionLocation = ref(false);
const count = ref<1 | 3>(3);

const countOptions = [
  { label: '1', value: 1 },
  { label: '3', value: 3 },
];

const languageOptions = AI_LANGUAGES.map((l) => ({ label: l.label, value: l.value }));
const toneOptions = AI_TONES.map((t) => ({ label: `${t.label} · ${t.labelLatin}`, value: t.value }));

const hasVideo = computed(() => props.media.some((m) => m.kind === 'video'));
const hasMedia = computed(() => props.media.length > 0);
const rtl = computed(() => isRtl(language.value));
const busy = computed(() => phase.value === 'analyzing' || phase.value === 'generating' || phase.value === 'rewriting');

const quotaLow = computed(() => {
  const q = status.value?.quota;
  return q ? q.dayRemaining <= 5 || q.hourRemaining <= 2 : false;
});

/** Load status and apply the workspace defaults whenever the dialog opens. */
watch(visible, async (open) => {
  if (!open || !ws.workspaceId) return;
  suggestions.value = [];
  understanding.value = null;
  errorMessage.value = null;
  phase.value = 'idle';

  loadingStatus.value = true;
  try {
    const s = await api.getAiStatus({ workspaceId: ws.workspaceId });
    status.value = s;
    language.value = s.settings.defaultLanguage;
    tone.value = s.settings.defaultTone;
    useEmojis.value = s.settings.useEmojis;
    useHashtags.value = s.settings.useHashtags;
    useCta.value = s.settings.useCta;
    mentionLocation.value = s.settings.mentionLocation;
  } catch (e) {
    errorMessage.value = reportApiError(e, 'Could not reach the generator').message;
  } finally {
    loadingStatus.value = false;
  }
});

async function generate() {
  if (!ws.workspaceId || busy.value) return;
  errorMessage.value = null;
  suggestions.value = [];
  understanding.value = null;

  try {
    // Frames are pulled here because the browser already has the decoder.
    let frames: string[] = [];
    if (hasVideo.value) {
      phase.value = 'analyzing';
      const video = props.media.find((m) => m.kind === 'video');
      if (video) frames = await extractFrames(video, 3);
    }

    phase.value = 'generating';
    const res = await api.generateCaption({
      workspaceId: ws.workspaceId,
      postId: props.postId,
      mediaIds: props.media.map((m) => m.id),
      frames,
      language: language.value,
      tone: tone.value,
      useEmojis: useEmojis.value,
      useHashtags: useHashtags.value,
      useCta: useCta.value,
      mentionLocation: mentionLocation.value,
      count: count.value,
      seedText: props.currentText.slice(0, 5000),
    });

    suggestions.value = res.suggestions;
    understanding.value = res.understanding?.summary ?? null;
    generationId.value = res.generationId;
    editing.value = Object.fromEntries(res.suggestions.map((s) => [s.id, s.text]));
    if (status.value) status.value.quota = res.quota;
    phase.value = 'ready';
  } catch (e) {
    phase.value = 'error';
    errorMessage.value = reportApiError(e, 'Could not generate a caption').message;
  }
}

async function rewrite(s: AiCaptionSuggestion, instruction: AiRewrite) {
  if (!ws.workspaceId || busy.value) return;
  phase.value = 'rewriting';
  try {
    const res = await api.rewriteCaption({
      workspaceId: ws.workspaceId,
      postId: props.postId,
      text: editing.value[s.id] ?? s.text,
      instruction,
      language: language.value,
      tone: s.tone,
    });
    editing.value[s.id] = res.text;
    if (status.value) status.value.quota = res.quota;
    phase.value = 'ready';
  } catch (e) {
    phase.value = 'ready';
    reportApiError(e, 'Could not rewrite the caption');
  }
}

async function use(s: AiCaptionSuggestion) {
  const text = editing.value[s.id] ?? s.text;
  emit('use', text, useHashtags.value ? s.hashtags : []);

  if (ws.workspaceId && generationId.value) {
    // Acceptance rate is the only honest measure of whether this is worth
    // what it costs; a failure to record it must not block the user.
    await api
      .markAiGenerationAccepted({ workspaceId: ws.workspaceId, generationId: generationId.value })
      .catch(() => undefined);
  }
  success('Caption added');
  visible.value = false;
}

async function copy(s: AiCaptionSuggestion) {
  try {
    await navigator.clipboard.writeText(editing.value[s.id] ?? s.text);
    success('Copied');
  } catch {
    reportApiError(new Error('Your browser blocked clipboard access.'), 'Could not copy');
  }
}

const toneLabel = (t: AiTone) => AI_TONES.find((x) => x.value === t)?.label ?? t;
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    header="✨ Generar con IA"
    :style="{ width: 'min(44rem, calc(100vw - 2rem))' }"
    :breakpoints="{ '960px': '95vw' }"
    :dismissable-mask="!busy"
  >
    <div v-if="loadingStatus" class="flex flex-col gap-3">
      <Skeleton height="2.5rem" />
      <Skeleton height="8rem" />
    </div>

    <Message v-else-if="status && !status.configured" severity="warn" :closable="false">
      <p class="text-sm font-medium">AI generation is not configured for this deployment.</p>
      <p v-if="status.missing.length" class="mt-1 text-xs">Missing: {{ status.missing.join(', ') }}</p>
    </Message>

    <div v-else class="flex flex-col gap-4">
      <!-- Options -->
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <label for="ai-lang" class="text-sm font-medium text-ink">Idioma</label>
          <Select
            input-id="ai-lang"
            v-model="language"
            :options="languageOptions"
            option-label="label"
            option-value="value"
            :disabled="busy"
            fluid
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <label for="ai-tone" class="text-sm font-medium text-ink">Estilo</label>
          <Select
            input-id="ai-tone"
            v-model="tone"
            :options="toneOptions"
            option-label="label"
            option-value="value"
            :disabled="busy || count === 3"
            fluid
          />
          <small v-if="count === 3" class="text-ink-soft">Con 3 versiones se usan tres estilos distintos.</small>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
        <label class="flex items-center gap-2 text-sm text-ink">
          <ToggleSwitch v-model="useEmojis" :disabled="busy" aria-label="Añadir emojis" /> Emojis
        </label>
        <label class="flex items-center gap-2 text-sm text-ink">
          <ToggleSwitch v-model="useHashtags" :disabled="busy" aria-label="Añadir hashtags" /> Hashtags
        </label>
        <label class="flex items-center gap-2 text-sm text-ink">
          <ToggleSwitch v-model="useCta" :disabled="busy" aria-label="Añadir llamada a la acción" /> CTA
        </label>
        <label class="flex items-center gap-2 text-sm text-ink">
          <ToggleSwitch v-model="mentionLocation" :disabled="busy" aria-label="Mencionar ubicación" /> Ubicación
        </label>
        <span class="ml-auto flex items-center gap-2">
          <span class="text-sm text-ink-muted">Versiones</span>
          <SelectButton
            v-model="count"
            :options="countOptions"
            option-label="label"
            option-value="value"
            :allow-empty="false"
            size="small"
            :disabled="busy"
            aria-label="Número de versiones"
          />
        </span>
      </div>

      <Message v-if="!hasMedia" severity="info" :closable="false" size="small">
        Sin imagen ni vídeo la IA escribe en general. Añade media y describirá lo que realmente aparece.
      </Message>

      <Message v-if="quotaLow && status" severity="warn" :closable="false" size="small">
        Quedan {{ status.quota.dayRemaining }} generaciones hoy y {{ status.quota.hourRemaining }} esta hora.
      </Message>

      <Button
        :label="phase === 'analyzing' ? 'Analizando el vídeo…' : phase === 'generating' ? 'Generando…' : '✨ Generar'"
        icon="pi pi-sparkles"
        :loading="busy"
        :disabled="busy || (status?.quota.dayRemaining ?? 1) <= 0"
        @click="generate"
      />

      <!-- Working -->
      <div v-if="busy" class="flex items-center gap-3 rounded-xl bg-muted px-4 py-6">
        <ProgressSpinner style="width: 2rem; height: 2rem" stroke-width="4" aria-label="Trabajando" />
        <span class="text-sm text-ink-muted">
          {{ phase === 'analyzing' ? 'Analizando el vídeo…' : phase === 'rewriting' ? 'Reescribiendo…' : `Generando ${count} caption${count === 1 ? '' : 's'}…` }}
        </span>
      </div>

      <Message v-else-if="errorMessage" severity="error" :closable="false">{{ errorMessage }}</Message>

      <!-- Results -->
      <template v-if="suggestions.length && !busy">
        <Message v-if="understanding" severity="secondary" :closable="false" size="small">
          <span class="text-xs"><strong>La IA ve:</strong> {{ understanding }}</span>
        </Message>

        <ul class="flex flex-col gap-3">
          <li v-for="s in suggestions" :key="s.id">
            <Card>
              <template #content>
                <div class="mb-2 flex items-center gap-2">
                  <Tag :value="toneLabel(s.tone)" severity="secondary" />
                  <Tag v-if="s.hashtags.length && useHashtags" :value="`${s.hashtags.length} hashtags`" severity="info" />
                </div>

                <Textarea
                  v-model="editing[s.id]"
                  rows="4"
                  auto-resize
                  fluid
                  :dir="rtl ? 'rtl' : 'ltr'"
                  :class="rtl ? 'text-right' : ''"
                  :aria-label="`Caption ${toneLabel(s.tone)}`"
                />

                <div v-if="s.hashtags.length && useHashtags" class="mt-2 flex flex-wrap gap-1">
                  <Tag v-for="h in s.hashtags" :key="h" :value="`#${h}`" severity="secondary" />
                </div>

                <div class="mt-3 flex flex-wrap gap-1">
                  <Button label="Usar este" icon="pi pi-check" size="small" @click="use(s)" />
                  <Button icon="pi pi-copy" size="small" text severity="secondary" aria-label="Copiar" @click="copy(s)" />
                  <Button
                    v-for="r in AI_REWRITES"
                    :key="r.value"
                    :label="r.label"
                    size="small"
                    text
                    severity="secondary"
                    :disabled="busy"
                    @click="rewrite(s, r.value)"
                  />
                </div>
              </template>
            </Card>
          </li>
        </ul>

        <Button label="Regenerar" icon="pi pi-refresh" severity="secondary" outlined :disabled="busy" @click="generate" />
      </template>
    </div>

    <template #footer>
      <p class="mr-auto text-xs text-ink-soft">
        La IA nunca publica. Eliges tú lo que entra en el post.
      </p>
      <Button label="Cerrar" severity="secondary" outlined :disabled="busy" @click="visible = false" />
    </template>
  </Dialog>
</template>

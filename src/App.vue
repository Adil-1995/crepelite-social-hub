<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import Toast from 'primevue/toast';
import Button from 'primevue/button';
import ConfirmDialog from 'primevue/confirmdialog';
import DynamicDialog from 'primevue/dynamicdialog';
import { useToast } from 'primevue/usetoast';
import AppLayout from '@/components/layout/AppLayout.vue';
import { applyUpdate, initPwa, updateAvailable } from '@/app/pwa';

/**
 * Application root. The three PrimeVue service outlets are mounted once here —
 * features reach them through `useFeedback()` and never render their own.
 *
 * Public routes (sign-in) and immersive routes (the composer) render without
 * the shell chrome.
 */
const route = useRoute();
const toast = useToast();

const chromeless = computed(() => route.meta.public === true || route.meta.immersive === true);

onMounted(initPwa);

// A new build never swaps under the user: they choose when to reload.
watch(updateAvailable, (available) => {
  if (!available) return;
  toast.add({
    severity: 'info',
    summary: 'Update available',
    detail: 'Reload to get the latest version of CrepeLite.',
    group: 'update',
  });
});
</script>

<template>
  <component :is="chromeless ? 'div' : AppLayout">
    <router-view v-slot="{ Component }">
      <component :is="Component" />
    </router-view>
  </component>

  <!-- Global PrimeVue service outlets (toast, confirm, dynamic dialogs). -->
  <Toast position="top-center" :pt="{ root: { class: 'safe-top' } }" />
  <Toast position="top-center" group="update" :pt="{ root: { class: 'safe-top' } }">
    <template #message="slotProps">
      <div class="flex w-full items-center gap-3">
        <i class="pi pi-refresh text-lg" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <p class="font-semibold">{{ slotProps.message.summary }}</p>
          <p class="text-sm">{{ slotProps.message.detail }}</p>
        </div>
        <Button label="Reload" size="small" @click="applyUpdate()" />
      </div>
    </template>
  </Toast>
  <ConfirmDialog :draggable="false" :style="{ width: 'min(28rem, calc(100vw - 2rem))' }" />
  <DynamicDialog />
</template>

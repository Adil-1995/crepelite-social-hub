<script setup lang="ts">
import Toast from 'primevue/toast';
import ConfirmDialog from 'primevue/confirmdialog';
import DynamicDialog from 'primevue/dynamicdialog';

/**
 * Application shell. The three PrimeVue service outlets are mounted once here
 * — features call them through `useFeedback()` and never render their own.
 */
</script>

<template>
  <router-view v-slot="{ Component }">
    <component :is="Component" />
  </router-view>

  <!-- Global PrimeVue service outlets (toast, confirm, dynamic dialogs). -->
  <Toast
    position="top-center"
    :pt="{ root: { class: 'safe-top' } }"
  />
  <ConfirmDialog
    :draggable="false"
    :style="{ width: 'min(28rem, calc(100vw - 2rem))' }"
  />
  <DynamicDialog />
</template>

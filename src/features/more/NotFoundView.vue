<script setup lang="ts">
import { useRouter } from 'vue-router';
import Button from 'primevue/button';

const router = useRouter();
</script>

<template>
  <div class="safe-top safe-bottom flex min-h-dvh flex-col items-center justify-center gap-4 bg-app px-6 text-center">
    <i class="pi pi-compass text-4xl text-ink-soft" aria-hidden="true" />
    <h1 class="text-xl font-semibold text-ink">Page not found</h1>
    <p class="max-w-sm text-sm text-ink-muted">
      That link does not point anywhere in CrepeLite. It may have been moved or deleted.
    </p>
    <div class="flex flex-wrap justify-center gap-2">
      <Button label="Go to Today" icon="pi pi-home" @click="router.push('/dashboard')" />
      <Button label="Back" icon="pi pi-arrow-left" severity="secondary" outlined @click="router.back()" />
    </div>
  </div>
</template>

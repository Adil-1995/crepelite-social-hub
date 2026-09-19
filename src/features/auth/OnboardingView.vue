<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import Message from 'primevue/message';
import { DEFAULT_TIMEZONE, workspaceCreateSchema } from '@shared/index';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/auth';
import { useWorkspaceStore } from '@/stores/workspace';
import { useFeedback } from '@/composables/useFeedback';
import { timezoneOptions } from '@/lib/timezones';

/**
 * First-run workspace creation. Reached automatically when a signed-in user
 * has no membership; the backend creates the OWNER membership.
 */
const router = useRouter();
const auth = useAuthStore();
const ws = useWorkspaceStore();
const { reportApiError, success } = useFeedback();

const name = ref('CrepeLite');
const timezone = ref(guessTimezone());
const busy = ref(false);
const errorMessage = ref<string | null>(null);

function guessTimezone(): string {
  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timezoneOptions.some((t) => t.value === detected) ? detected : DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

const parsed = computed(() => workspaceCreateSchema.safeParse({ name: name.value, timezone: timezone.value }));
const canSubmit = computed(() => parsed.value.success);

async function create() {
  if (!canSubmit.value || busy.value) return;
  busy.value = true;
  errorMessage.value = null;
  try {
    const { workspaceId } = await api.createWorkspace({ name: name.value.trim(), timezone: timezone.value });
    await auth.bootstrap();
    ws.select(workspaceId);
    success('Workspace ready', name.value.trim());
    await router.replace('/connections');
  } catch (e) {
    errorMessage.value = reportApiError(e, 'Could not create the workspace').message;
  } finally {
    busy.value = false;
  }
}

async function signOut() {
  await auth.signOut();
  await router.replace('/login');
}
</script>

<template>
  <div class="safe-top safe-bottom flex min-h-dvh items-center justify-center bg-app px-4 py-8">
    <div class="w-full max-w-md">
      <div class="mb-6 text-center">
        <h1 class="text-xl font-semibold text-ink">Set up your workspace</h1>
        <p class="mt-1 text-sm text-ink-muted">
          A workspace holds your connected accounts, media and schedule. You can invite your team later.
        </p>
      </div>

      <div class="card p-5">
        <Message v-if="errorMessage" severity="error" :closable="false" class="mb-4">{{ errorMessage }}</Message>

        <form class="flex flex-col gap-4" novalidate @submit.prevent="create">
          <div class="flex flex-col gap-1.5">
            <label for="ws-name" class="text-sm font-medium text-ink">Workspace name</label>
            <InputText id="ws-name" v-model="name" :disabled="busy" maxlength="80" fluid autofocus />
            <small class="text-ink-soft">Between 2 and 80 characters.</small>
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
              :disabled="busy"
              fluid
            />
            <small class="text-ink-soft">All scheduling times are shown and stored against this zone.</small>
          </div>

          <Button type="submit" label="Create workspace" icon="pi pi-check" :loading="busy" :disabled="!canSubmit" fluid />
        </form>
      </div>

      <div class="mt-4 text-center">
        <Button label="Sign out" text size="small" icon="pi pi-sign-out" @click="signOut" />
      </div>
    </div>
  </div>
</template>

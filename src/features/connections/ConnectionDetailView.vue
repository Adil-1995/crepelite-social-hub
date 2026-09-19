<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import Card from 'primevue/card';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import Message from 'primevue/message';
import Skeleton from 'primevue/skeleton';
import ToggleSwitch from 'primevue/toggleswitch';
import Avatar from 'primevue/avatar';
import type { SocialConnection } from '@shared/index';
import { useLiveDoc } from '@/composables/useFirestore';
import { useWorkspaceStore } from '@/stores/workspace';
import { useProvidersStore } from '@/stores/providers';
import { api } from '@/services/api';
import { useFeedback } from '@/composables/useFeedback';
import { formatDateTime, formatRelative } from '@/lib/format';
import { CONNECTION_STATUS_UI } from '@/lib/status';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';
import ErrorState from '@/components/domain/ErrorState.vue';

/** One connection in detail: scopes, health, destinations and capabilities. */
const props = defineProps<{ connectionId: string }>();
const ws = useWorkspaceStore();
const providers = useProvidersStore();
const router = useRouter();
const { success, reportApiError, confirmDestructive } = useFeedback();

const busy = ref(false);

const connDoc = useLiveDoc<SocialConnection>(
  () => (ws.workspaceId ? `workspaces/${ws.workspaceId}/socialConnections/${props.connectionId}` : null),
  [() => ws.workspaceId, () => props.connectionId],
);

const connection = computed(() => connDoc.data.value);
const manifest = computed(() => (connection.value ? providers.manifest(connection.value.provider) : undefined));
const channels = computed(() => ws.channels.filter((c) => c.connectionId === props.connectionId));
const ui = computed(() => (connection.value ? CONNECTION_STATUS_UI[connection.value.status] : null));
const canManage = computed(() => ws.can('connections.manage'));

const capabilityRows = computed(() => {
  const caps = manifest.value?.capabilities;
  if (!caps) return [];
  return [
    { label: 'Create posts', enabled: caps.canCreatePost },
    { label: 'Read your own posts', enabled: caps.canReadPosts },
    { label: 'Edit after publishing', enabled: caps.canEditPublishedPost },
    { label: 'Delete published posts', enabled: caps.canDeletePost },
    { label: 'Native scheduling', enabled: caps.canScheduleNative },
    { label: 'Publishing status checks', enabled: caps.canFetchStatus },
    { label: 'Webhooks', enabled: caps.webhooks },
  ];
});

async function refresh() {
  if (!ws.workspaceId) return;
  busy.value = true;
  try {
    const { status } = await api.refreshConnection({ workspaceId: ws.workspaceId, connectionId: props.connectionId });
    success('Status refreshed', status);
  } catch (e) {
    reportApiError(e, 'Could not refresh the connection');
  } finally {
    busy.value = false;
  }
}

async function reconnect() {
  if (!ws.workspaceId || !connection.value) return;
  busy.value = true;
  try {
    const { authorizationUrl } = await api.startOAuth({
      workspaceId: ws.workspaceId,
      authFamily: connection.value.authFamily,
      returnTo: '/connections',
      connectionId: props.connectionId,
    });
    window.location.href = authorizationUrl;
  } catch (e) {
    reportApiError(e, 'Could not start the reconnection');
    busy.value = false;
  }
}

async function disconnect() {
  if (!ws.workspaceId) return;
  busy.value = true;
  try {
    const probe = await api.disconnectConnection({
      workspaceId: ws.workspaceId,
      connectionId: props.connectionId,
      confirm: false,
    });
    const scheduled = probe.dependentScheduled ?? 0;
    const ok = await confirmDestructive({
      header: `Disconnect ${connection.value?.accountName ?? 'this account'}?`,
      message:
        scheduled > 0
          ? `${scheduled} scheduled ${scheduled === 1 ? 'publication' : 'publications'} will be cancelled.`
          : 'This account will stop publishing. You can reconnect it later.',
      acceptLabel: 'Disconnect',
    });
    if (!ok) return;
    await api.disconnectConnection({ workspaceId: ws.workspaceId, connectionId: props.connectionId, confirm: true });
    success('Account disconnected');
    await router.push('/connections');
  } catch (e) {
    reportApiError(e, 'Could not disconnect the account');
  } finally {
    busy.value = false;
  }
}

async function toggleChannel(channelId: string, enabled: boolean) {
  if (!ws.workspaceId) return;
  try {
    await api.setChannelEnabled({ workspaceId: ws.workspaceId, channelId, enabled });
  } catch (e) {
    reportApiError(e, 'Could not update the destination');
  }
}
</script>

<template>
  <div class="flex flex-col gap-4 p-3 lg:p-6">
    <div v-if="connDoc.loading.value" class="flex flex-col gap-3">
      <Skeleton height="4rem" />
      <Skeleton height="10rem" />
    </div>

    <ErrorState v-else-if="connDoc.error.value" :message="connDoc.error.value.message" :retryable="false" />

    <Card v-else-if="!connection">
      <template #content>
        <div class="flex flex-col items-center gap-3 py-8 text-center">
          <i class="pi pi-link text-3xl text-ink-soft" aria-hidden="true" />
          <p class="font-semibold text-ink">This connection no longer exists</p>
          <Button label="Back to connections" icon="pi pi-arrow-left" @click="router.push('/connections')" />
        </div>
      </template>
    </Card>

    <template v-else>
      <div class="flex items-start gap-3">
        <Button icon="pi pi-arrow-left" text rounded severity="secondary" aria-label="Back" @click="router.back()" />
        <ProviderIcon :provider="connection.provider" :size="28" />
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-lg font-semibold text-ink">{{ connection.accountName }}</h1>
          <div class="mt-1 flex flex-wrap items-center gap-2">
            <Tag v-if="ui" :severity="ui.severity" :icon="ui.icon" :value="ui.label" />
            <span class="text-xs text-ink-soft">{{ manifest?.displayName }}</span>
          </div>
        </div>
      </div>

      <Message v-if="connection.lastError" severity="error" :closable="false">
        {{ connection.lastError.message }}
      </Message>

      <div v-if="canManage" class="flex flex-wrap gap-2">
        <Button label="Refresh status" icon="pi pi-refresh" severity="secondary" outlined :loading="busy" @click="refresh" />
        <Button label="Reconnect" icon="pi pi-key" severity="secondary" outlined :loading="busy" @click="reconnect" />
        <Button label="Disconnect" icon="pi pi-times" severity="danger" outlined class="ml-auto" :loading="busy" @click="disconnect" />
      </div>

      <!-- Destinations -->
      <Card>
        <template #title><span class="text-sm">Destinations</span></template>
        <template #content>
          <ul v-if="channels.length" class="flex flex-col divide-y divide-line">
            <li v-for="c in channels" :key="c.id" class="flex min-h-14 items-center gap-3 py-2">
              <Avatar
                :image="c.avatarUrl ?? undefined"
                :label="c.avatarUrl ? undefined : c.name.slice(0, 1).toUpperCase()"
                shape="circle"
              />
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm text-ink">{{ c.name }}</p>
                <p class="truncate text-xs text-ink-soft">{{ c.handle ?? c.kind }}</p>
              </div>
              <ToggleSwitch
                :model-value="c.enabled"
                :disabled="!canManage || connection.status !== 'connected'"
                :aria-label="`Enable ${c.name}`"
                @update:model-value="(v) => toggleChannel(c.id, Boolean(v))"
              />
            </li>
          </ul>
          <p v-else class="py-4 text-sm text-ink-soft">No publishing destinations were returned for this account.</p>
        </template>
      </Card>

      <!-- Health -->
      <Card>
        <template #title><span class="text-sm">Authorisation</span></template>
        <template #content>
          <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt class="text-ink-soft">Connected</dt>
            <dd class="text-ink">{{ formatDateTime(connection.createdAt, ws.timezone) }}</dd>

            <dt class="text-ink-soft">Last checked</dt>
            <dd class="text-ink">
              {{ connection.lastHealthCheckAt ? formatRelative(connection.lastHealthCheckAt, ws.timezone) : 'Never' }}
            </dd>

            <dt class="text-ink-soft">Expires</dt>
            <dd class="text-ink">
              {{ connection.expiresAt ? formatDateTime(connection.expiresAt, ws.timezone) : 'No expiry reported' }}
            </dd>
          </dl>

          <div v-if="connection.scopes?.length" class="mt-4">
            <p class="mb-1 text-xs font-medium text-ink-soft">Granted permissions</p>
            <div class="flex flex-wrap gap-1">
              <Tag v-for="s in connection.scopes" :key="s" :value="s" severity="secondary" />
            </div>
          </div>

          <p class="mt-4 text-xs text-ink-soft">
            Access tokens are held server-side and are never sent to this device.
          </p>
        </template>
      </Card>

      <!-- Capabilities -->
      <Card v-if="capabilityRows.length">
        <template #title><span class="text-sm">What this network supports</span></template>
        <template #content>
          <ul class="flex flex-col gap-2">
            <li v-for="row in capabilityRows" :key="row.label" class="flex items-center gap-2 text-sm">
              <i
                :class="row.enabled ? 'pi pi-check text-ok' : 'pi pi-minus text-ink-soft'"
                aria-hidden="true"
              />
              <span :class="row.enabled ? 'text-ink' : 'text-ink-soft'">{{ row.label }}</span>
            </li>
          </ul>
          <p v-if="manifest" class="mt-3 text-xs text-ink-soft">
            API {{ manifest.apiVersion }} ·
            <a :href="manifest.docs" target="_blank" rel="noopener noreferrer" class="underline">provider documentation</a>
          </p>
        </template>
      </Card>
    </template>
  </div>
</template>

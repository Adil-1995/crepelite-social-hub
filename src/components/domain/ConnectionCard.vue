<script setup lang="ts">
import { computed, ref } from 'vue';
import Card from 'primevue/card';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import Menu from 'primevue/menu';
import Message from 'primevue/message';
import ToggleSwitch from 'primevue/toggleswitch';
import Avatar from 'primevue/avatar';
import type { MenuItem } from 'primevue/menuitem';
import type { SocialChannel, SocialConnection } from '@shared/index';
import { CONNECTION_STATUS_UI } from '@/lib/status';
import { formatRelative } from '@/lib/format';
import { useWorkspaceStore } from '@/stores/workspace';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';

/** One connected account plus the channels it publishes to. */
const props = defineProps<{
  connection: SocialConnection;
  channels: SocialChannel[];
  busy?: boolean;
}>();
const emit = defineEmits<{
  reconnect: [connectionId: string];
  disconnect: [connectionId: string];
  refresh: [connectionId: string];
  toggleChannel: [payload: { channelId: string; enabled: boolean }];
}>();

const ws = useWorkspaceStore();
const menu = ref<InstanceType<typeof Menu> | null>(null);
const ui = computed(() => CONNECTION_STATUS_UI[props.connection.status]);
const healthy = computed(() => props.connection.status === 'connected');
const canManage = computed(() => ws.can('connections.manage'));

const items = computed<MenuItem[]>(() => [
  { label: 'Refresh status', icon: 'pi pi-refresh', command: () => emit('refresh', props.connection.id) },
  { label: 'Reconnect', icon: 'pi pi-key', command: () => emit('reconnect', props.connection.id) },
  { separator: true },
  {
    label: 'Disconnect',
    icon: 'pi pi-times',
    class: 'text-bad',
    command: () => emit('disconnect', props.connection.id),
  },
]);
</script>

<template>
  <Card>
    <template #content>
      <div class="flex items-start gap-3">
        <ProviderIcon :provider="connection.provider" :size="28" />

        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="truncate font-semibold text-ink">{{ connection.accountName }}</span>
            <Tag :severity="ui.severity" :icon="ui.icon" :value="ui.label" />
          </div>
          <p v-if="connection.lastHealthCheckAt" class="mt-0.5 text-xs text-ink-soft">
            Checked {{ formatRelative(connection.lastHealthCheckAt, ws.timezone) }}
          </p>
        </div>

        <Button
          v-if="canManage"
          icon="pi pi-ellipsis-v"
          text
          rounded
          severity="secondary"
          :loading="busy"
          aria-label="Connection actions"
          aria-haspopup="true"
          @click="menu?.toggle($event)"
        />
        <Menu v-if="canManage" ref="menu" :model="items" :popup="true" />
      </div>

      <Message v-if="!healthy" severity="warn" :closable="false" class="mt-3" size="small">
        <span v-if="connection.lastError">{{ connection.lastError.message }}</span>
        <span v-else>This account must be reconnected before it can publish.</span>
      </Message>

      <ul v-if="channels.length" class="mt-3 flex flex-col divide-y divide-line">
        <li v-for="c in channels" :key="c.id" class="flex min-h-11 items-center gap-3 py-2">
          <Avatar
            :image="c.avatarUrl ?? undefined"
            :label="c.avatarUrl ? undefined : c.name.slice(0, 1).toUpperCase()"
            shape="circle"
            size="normal"
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-ink">{{ c.name }}</span>
            <span v-if="c.handle" class="block truncate text-xs text-ink-soft">{{ c.handle }}</span>
          </span>
          <ToggleSwitch
            :model-value="c.enabled"
            :disabled="!canManage || !healthy"
            :aria-label="`Enable ${c.name}`"
            @update:model-value="(v) => emit('toggleChannel', { channelId: c.id, enabled: Boolean(v) })"
          />
        </li>
      </ul>

      <p v-else class="mt-3 text-sm text-ink-soft">No publishing destinations were returned for this account.</p>
    </template>

    <template v-if="!healthy && canManage" #footer>
      <Button label="Reconnect" icon="pi pi-key" :loading="busy" @click="emit('reconnect', connection.id)" />
    </template>
  </Card>
</template>

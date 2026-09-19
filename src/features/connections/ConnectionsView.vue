<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Card from 'primevue/card';
import Button from 'primevue/button';
import Message from 'primevue/message';
import Skeleton from 'primevue/skeleton';
import Tag from 'primevue/tag';
import { useWorkspaceStore } from '@/stores/workspace';
import { useProvidersStore } from '@/stores/providers';
import { api } from '@/services/api';
import { useFeedback } from '@/composables/useFeedback';
import ProviderIcon from '@/components/domain/ProviderIcon.vue';
import ConnectionCard from '@/components/domain/ConnectionCard.vue';
import EmptyState from '@/components/domain/EmptyState.vue';

/**
 * Connected accounts, grouped by OAuth family.
 *
 * Everything on this screen is driven by the shared manifest catalog plus the
 * backend's provider status — no network is hardcoded, so a new provider shows
 * up as soon as its manifest and credentials exist.
 */
const ws = useWorkspaceStore();
const providers = useProvidersStore();
const route = useRoute();
const router = useRouter();
const { success, reportApiError, confirmDestructive } = useFeedback();

const busyId = ref<string | null>(null);
const startingFamily = ref<string | null>(null);

onMounted(async () => {
  if (ws.workspaceId) await providers.loadStatus(ws.workspaceId).catch(() => undefined);

  // The OAuth callback returns here with a result flag.
  const connected = route.query.connected;
  const failed = route.query.error;
  if (typeof connected === 'string') {
    success('Account connected', connected);
    await router.replace({ path: '/connections' });
  } else if (typeof failed === 'string') {
    reportApiError(new Error(failed), 'Could not connect the account');
    await router.replace({ path: '/connections' });
  }
});

const canManage = computed(() => ws.can('connections.manage'));

/** Families that have at least one connection, and those that do not yet. */
const connectedByFamily = computed(() => {
  const map = new Map<string, typeof ws.connections>();
  for (const c of ws.connections) {
    const list = map.get(c.authFamily) ?? [];
    list.push(c);
    map.set(c.authFamily, list);
  }
  return map;
});

const availableFamilies = computed(() =>
  providers.families.filter((f) => !(connectedByFamily.value.get(f.family)?.length)),
);

function channelsFor(connectionId: string) {
  return ws.channels.filter((c) => c.connectionId === connectionId);
}

async function connect(family: string, connectionId?: string) {
  if (!ws.workspaceId || !canManage.value) return;
  startingFamily.value = family;
  try {
    const { authorizationUrl } = await api.startOAuth({
      workspaceId: ws.workspaceId,
      authFamily: family,
      returnTo: '/connections',
      ...(connectionId ? { connectionId } : {}),
    });
    // Full-page redirect: the provider will not render inside an iframe or popup
    // reliably on mobile, and installed PWAs block popups.
    window.location.href = authorizationUrl;
  } catch (e) {
    reportApiError(e, 'Could not start the connection');
    startingFamily.value = null;
  }
}

async function reconnect(connectionId: string) {
  const conn = ws.connections.find((c) => c.id === connectionId);
  if (conn) await connect(conn.authFamily, connectionId);
}

async function refresh(connectionId: string) {
  if (!ws.workspaceId) return;
  busyId.value = connectionId;
  try {
    const { status } = await api.refreshConnection({ workspaceId: ws.workspaceId, connectionId });
    success('Status refreshed', status);
  } catch (e) {
    reportApiError(e, 'Could not refresh the connection');
  } finally {
    busyId.value = null;
  }
}

async function disconnect(connectionId: string) {
  if (!ws.workspaceId) return;
  const conn = ws.connections.find((c) => c.id === connectionId);
  busyId.value = connectionId;
  try {
    // First call reports what would break; the user confirms with the real numbers.
    const probe = await api.disconnectConnection({ workspaceId: ws.workspaceId, connectionId, confirm: false });
    if (probe.requiresConfirmation) {
      const scheduled = probe.dependentScheduled ?? 0;
      const ok = await confirmDestructive({
        header: `Disconnect ${conn?.accountName ?? 'this account'}?`,
        message:
          scheduled > 0
            ? `${scheduled} scheduled ${scheduled === 1 ? 'publication' : 'publications'} will be cancelled. This cannot be undone.`
            : 'This account will stop publishing. You can reconnect it later.',
        acceptLabel: 'Disconnect',
      });
      if (!ok) return;
      const result = await api.disconnectConnection({ workspaceId: ws.workspaceId, connectionId, confirm: true });
      success('Account disconnected', result.cancelledDeliveries ? `${result.cancelledDeliveries} scheduled publications cancelled` : undefined);
    } else {
      success('Account disconnected');
    }
  } catch (e) {
    reportApiError(e, 'Could not disconnect the account');
  } finally {
    busyId.value = null;
  }
}

async function toggleChannel(payload: { channelId: string; enabled: boolean }) {
  if (!ws.workspaceId) return;
  try {
    await api.setChannelEnabled({ workspaceId: ws.workspaceId, ...payload });
  } catch (e) {
    reportApiError(e, 'Could not update the destination');
  }
}
</script>

<template>
  <div class="flex flex-col gap-4 p-3 lg:p-6">
    <Message v-if="!canManage" severity="info" :closable="false">
      You can see connected accounts, but only owners and admins can change them.
    </Message>

    <!-- Connected accounts -->
    <section v-if="ws.connections.length" aria-labelledby="connected-heading" class="flex flex-col gap-3">
      <h2 id="connected-heading" class="text-sm font-semibold text-ink">Connected accounts</h2>
      <ConnectionCard
        v-for="c in ws.connections"
        :key="c.id"
        :connection="c"
        :channels="channelsFor(c.id)"
        :busy="busyId === c.id"
        @reconnect="reconnect"
        @disconnect="disconnect"
        @refresh="refresh"
        @toggle-channel="toggleChannel"
      />
    </section>

    <!-- Available to connect -->
    <section aria-labelledby="available-heading" class="flex flex-col gap-3">
      <h2 id="available-heading" class="text-sm font-semibold text-ink">
        {{ ws.connections.length ? 'Add another network' : 'Connect a network' }}
      </h2>

      <div v-if="providers.loadingStatus && !providers.status" class="flex flex-col gap-3">
        <Skeleton v-for="i in 3" :key="i" height="5rem" />
      </div>

      <EmptyState
        v-else-if="!availableFamilies.length && !ws.connections.length"
        icon="pi pi-link"
        title="No networks available"
        message="No provider credentials are configured for this environment yet."
      />

      <Card v-for="f in availableFamilies" :key="f.family">
        <template #content>
          <div class="flex items-center gap-3">
            <div class="flex shrink-0 items-center gap-1">
              <ProviderIcon v-for="p in f.providers" :key="p.id" :provider="p.id" :size="24" />
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-semibold text-ink">{{ f.displayName }}</span>
                <Tag v-if="f.devOnly" value="Development only" severity="secondary" icon="pi pi-wrench" />
                <Tag
                  v-else-if="f.configured === false"
                  value="Not configured"
                  severity="warn"
                  icon="pi pi-exclamation-triangle"
                />
              </div>
              <p class="mt-0.5 text-xs text-ink-muted">
                {{ f.providers.map((p) => p.displayName).join(' · ') }}
              </p>
              <p v-if="f.configured === false && f.missing.length" class="mt-1 text-xs text-warn">
                Missing credentials: {{ f.missing.join(', ') }}
              </p>
            </div>

            <Button
              label="Connect"
              icon="pi pi-plus"
              size="small"
              :disabled="!canManage || f.configured === false"
              :loading="startingFamily === f.family"
              @click="connect(f.family)"
            />
          </div>
        </template>
      </Card>
    </section>

    <!-- Provider notices -->
    <Message v-if="providers.status?.notices" severity="secondary" :closable="false">
      <ul class="flex list-disc flex-col gap-1 pl-4 text-xs">
        <li v-if="!providers.status.notices.tiktokAudited">
          TikTok posts stay private until the app passes TikTok's content-posting audit.
        </li>
        <li v-if="!providers.status.notices.youtubeAudited">
          YouTube uploads are private until Google completes the OAuth verification.
        </li>
        <li v-if="providers.status.notices.pinterestSandbox">
          Pinterest is running against the sandbox — pins will not appear publicly.
        </li>
      </ul>
    </Message>
  </div>
</template>

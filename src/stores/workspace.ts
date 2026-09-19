import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { collection, query, orderBy } from 'firebase/firestore';
import { can as canDo, type Permission, type SocialChannel, type SocialConnection, type Workspace, type WorkspaceMember, DEFAULT_TIMEZONE } from '@shared/index';
import { db } from '@/app/firebase';
import { useAuthStore } from './auth';
import { useLiveDoc, useLiveQuery } from '@/composables/useFirestore';

const STORAGE_KEY = 'crepelite.workspaceId';

function readStoredId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Active workspace + realtime membership, channels and connection metadata.
 * Only the workspace id is persisted locally (no data, no tokens).
 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const auth = useAuthStore();
  const workspaceId = ref<string | null>(readStoredId());

  watch(
    () => auth.memberships,
    (ms) => {
      if (ms.length === 0) {
        workspaceId.value = null;
        return;
      }
      if (!workspaceId.value || !ms.some((m) => m.workspaceId === workspaceId.value)) workspaceId.value = ms[0]!.workspaceId;
    },
    { immediate: true },
  );
  watch(workspaceId, (id) => {
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* private mode */
    }
  });

  const ws = useLiveDoc<Workspace>(() => (workspaceId.value ? `workspaces/${workspaceId.value}` : null), [workspaceId]);
  const me = useLiveDoc<WorkspaceMember>(() => (workspaceId.value && auth.user ? `workspaces/${workspaceId.value}/members/${auth.user.uid}` : null), [workspaceId, () => auth.user?.uid]);
  const channelsQ = useLiveQuery<SocialChannel>(() => (workspaceId.value ? query(collection(db, `workspaces/${workspaceId.value}/socialChannels`), orderBy('name')) : null), [workspaceId]);
  const connectionsQ = useLiveQuery<SocialConnection>(() => (workspaceId.value ? collection(db, `workspaces/${workspaceId.value}/socialConnections`) : null), [workspaceId]);

  const workspace = computed(() => ws.data.value);
  const role = computed(() => me.data.value?.role ?? auth.memberships.find((m) => m.workspaceId === workspaceId.value)?.role ?? null);
  const timezone = computed(() => workspace.value?.timezone ?? import.meta.env.VITE_DEFAULT_TIMEZONE ?? DEFAULT_TIMEZONE);
  const channels = computed(() => channelsQ.items.value);
  const activeChannels = computed(() => channels.value.filter((c) => c.enabled && c.status !== 'revoked'));
  const connections = computed(() => connectionsQ.items.value.filter((c) => c.status !== 'revoked'));
  const attentionConnections = computed(() => connections.value.filter((c) => c.status !== 'connected'));

  function can(p: Permission): boolean {
    return canDo(role.value, p);
  }

  function select(id: string) {
    workspaceId.value = id;
  }

  return { workspaceId, workspace, role, timezone, channels, activeChannels, connections, attentionConnections, can, select, loading: computed(() => ws.loading.value) };
});

<script setup lang="ts">
import { computed, ref } from 'vue';
import { collection, orderBy, query } from 'firebase/firestore';
import Card from 'primevue/card';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import Message from 'primevue/message';
import Skeleton from 'primevue/skeleton';
import Avatar from 'primevue/avatar';
import Tag from 'primevue/tag';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import { canManageMember, type Role, type WorkspaceInvitation, type WorkspaceMember } from '@shared/index';
import { db } from '@/app/firebase';
import { useLiveQuery } from '@/composables/useFirestore';
import { useWorkspaceStore } from '@/stores/workspace';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/services/api';
import { useFeedback } from '@/composables/useFeedback';
import { formatDate, initials } from '@/lib/format';
import ErrorState from '@/components/domain/ErrorState.vue';

/**
 * Team management. The last owner can never be removed or demoted — ownership
 * moves through the explicit transfer flow instead.
 */
const ws = useWorkspaceStore();
const auth = useAuthStore();
const { success, reportApiError, confirmDestructive } = useFeedback();

const inviteEmail = ref('');
const inviteRole = ref<Exclude<Role, 'OWNER'>>('EDITOR');
const inviting = ref(false);
const transferOpen = ref(false);
const transferTo = ref<string | null>(null);
const busyUid = ref<string | null>(null);

const roleOptions: Array<{ label: string; value: Exclude<Role, 'OWNER'>; description: string }> = [
  { label: 'Admin', value: 'ADMIN', description: 'Manage the workspace, team and connections' },
  { label: 'Editor', value: 'EDITOR', description: 'Create, edit and schedule posts' },
  { label: 'Viewer', value: 'VIEWER', description: 'Read-only access' },
];

const membersQ = useLiveQuery<WorkspaceMember>(
  () => (ws.workspaceId ? query(collection(db, `workspaces/${ws.workspaceId}/members`), orderBy('addedAt', 'asc')) : null),
  [() => ws.workspaceId],
);

const invitationsQ = useLiveQuery<WorkspaceInvitation>(
  () => (ws.workspaceId ? collection(db, `workspaces/${ws.workspaceId}/invitations`) : null),
  [() => ws.workspaceId],
);

const members = computed(() => membersQ.items.value);
const invitations = computed(() => invitationsQ.items.value);
const myRole = computed(() => ws.role);
const canManage = computed(() => ws.can('members.manage'));
const owners = computed(() => members.value.filter((m) => m.role === 'OWNER'));

const emailValid = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail.value.trim()));

function mayManage(member: WorkspaceMember): boolean {
  if (!myRole.value) return false;
  if (member.uid === auth.user?.uid) return false;
  return canManageMember(myRole.value, member.role, member.role);
}

function assignableRoles(member: WorkspaceMember): Array<{ label: string; value: Exclude<Role, 'OWNER'> }> {
  if (!myRole.value) return [];
  return roleOptions.filter((r) => canManageMember(myRole.value!, member.role, r.value));
}

async function invite() {
  if (!ws.workspaceId || !emailValid.value) return;
  inviting.value = true;
  try {
    await api.inviteMember({ workspaceId: ws.workspaceId, email: inviteEmail.value.trim(), role: inviteRole.value });
    success('Invitation sent', inviteEmail.value.trim());
    inviteEmail.value = '';
  } catch (e) {
    reportApiError(e, 'Could not send the invitation');
  } finally {
    inviting.value = false;
  }
}

async function changeRole(member: WorkspaceMember, role: Exclude<Role, 'OWNER'>) {
  if (!ws.workspaceId) return;
  busyUid.value = member.uid;
  try {
    await api.updateMemberRole({ workspaceId: ws.workspaceId, uid: member.uid, role });
    success('Role updated', `${member.email} is now ${role.toLowerCase()}`);
  } catch (e) {
    reportApiError(e, 'Could not change the role');
  } finally {
    busyUid.value = null;
  }
}

async function removeMember(member: WorkspaceMember) {
  if (!ws.workspaceId) return;
  const ok = await confirmDestructive({
    header: `Remove ${member.displayName || member.email}?`,
    message: 'They lose access to this workspace immediately. Their posts stay.',
    acceptLabel: 'Remove',
  });
  if (!ok) return;
  busyUid.value = member.uid;
  try {
    await api.removeMember({ workspaceId: ws.workspaceId, uid: member.uid });
    success('Member removed');
  } catch (e) {
    reportApiError(e, 'Could not remove the member');
  } finally {
    busyUid.value = null;
  }
}

async function revoke(invitation: WorkspaceInvitation) {
  if (!ws.workspaceId) return;
  try {
    await api.revokeInvitation({ workspaceId: ws.workspaceId, email: invitation.email });
    success('Invitation revoked');
  } catch (e) {
    reportApiError(e, 'Could not revoke the invitation');
  }
}

async function transferOwnership() {
  if (!ws.workspaceId || !transferTo.value) return;
  const target = members.value.find((m) => m.uid === transferTo.value);
  const ok = await confirmDestructive({
    header: 'Transfer ownership?',
    message: `${target?.displayName || target?.email} becomes the owner and you become an admin. Only they can undo this.`,
    acceptLabel: 'Transfer ownership',
  });
  if (!ok) return;
  try {
    await api.transferOwnership({ workspaceId: ws.workspaceId, uid: transferTo.value });
    success('Ownership transferred');
    transferOpen.value = false;
    transferTo.value = null;
  } catch (e) {
    reportApiError(e, 'Could not transfer ownership');
  }
}

const transferCandidates = computed(() =>
  members.value.filter((m) => m.uid !== auth.user?.uid).map((m) => ({ label: m.displayName || m.email, value: m.uid })),
);

const roleSeverity: Record<Role, 'success' | 'info' | 'secondary' | 'contrast'> = {
  OWNER: 'contrast',
  ADMIN: 'info',
  EDITOR: 'success',
  VIEWER: 'secondary',
};
</script>

<template>
  <div class="flex flex-col gap-4 p-3 lg:p-6">
    <ErrorState v-if="membersQ.error.value" :message="membersQ.error.value.message" :retryable="false" />

    <template v-else>
      <Message v-if="!canManage" severity="info" :closable="false">
        You can see who is in this workspace, but only owners and admins can make changes.
      </Message>

      <!-- Invite -->
      <Card v-if="canManage">
        <template #title><span class="text-sm">Invite someone</span></template>
        <template #content>
          <form class="flex flex-col gap-3 sm:flex-row sm:items-end" @submit.prevent="invite">
            <div class="flex min-w-0 flex-1 flex-col gap-1.5">
              <label for="invite-email" class="text-sm font-medium text-ink">Email</label>
              <InputText
                id="invite-email"
                v-model="inviteEmail"
                type="email"
                inputmode="email"
                placeholder="name@example.com"
                :invalid="inviteEmail.length > 0 && !emailValid"
                :disabled="inviting"
                fluid
              />
            </div>
            <div class="flex flex-col gap-1.5 sm:w-44">
              <label for="invite-role" class="text-sm font-medium text-ink">Role</label>
              <Select
                id="invite-role"
                v-model="inviteRole"
                :options="roleOptions"
                option-label="label"
                option-value="value"
                :disabled="inviting"
                fluid
              >
                <template #option="{ option }">
                  <div class="flex flex-col">
                    <span>{{ option.label }}</span>
                    <span class="text-xs text-ink-soft">{{ option.description }}</span>
                  </div>
                </template>
              </Select>
            </div>
            <Button type="submit" label="Invite" icon="pi pi-send" :disabled="!emailValid" :loading="inviting" />
          </form>
        </template>
      </Card>

      <!-- Pending invitations -->
      <Card v-if="invitations.length">
        <template #title><span class="text-sm">Pending invitations</span></template>
        <template #content>
          <ul class="flex flex-col divide-y divide-line">
            <li v-for="i in invitations" :key="i.id" class="flex min-h-14 items-center gap-3 py-2">
              <i class="pi pi-envelope text-ink-soft" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm text-ink">{{ i.email }}</p>
                <p class="text-xs text-ink-soft">
                  Invited as {{ i.role.toLowerCase() }} · expires {{ formatDate(i.expiresAt, ws.timezone) }}
                </p>
              </div>
              <Button
                v-if="canManage"
                label="Revoke"
                size="small"
                text
                severity="danger"
                @click="revoke(i)"
              />
            </li>
          </ul>
        </template>
      </Card>

      <!-- Members -->
      <Card>
        <template #title><span class="text-sm">Members</span></template>
        <template #content>
          <div v-if="membersQ.loading.value" class="flex flex-col gap-2">
            <Skeleton v-for="i in 3" :key="i" height="3rem" />
          </div>

          <template v-else>
            <!-- Phones -->
            <ul class="flex flex-col divide-y divide-line lg:hidden">
              <li v-for="m in members" :key="m.uid" class="flex flex-col gap-2 py-3">
                <div class="flex items-center gap-3">
                  <Avatar
                    :image="m.photoURL ?? undefined"
                    :label="m.photoURL ? undefined : initials(m.displayName ?? m.email)"
                    shape="circle"
                  />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm text-ink">
                      {{ m.displayName || m.email }}
                      <span v-if="m.uid === auth.user?.uid" class="text-xs text-ink-soft">· you</span>
                    </p>
                    <p class="truncate text-xs text-ink-soft">{{ m.email }}</p>
                  </div>
                  <Tag :value="m.role" :severity="roleSeverity[m.role]" />
                </div>

                <div v-if="mayManage(m)" class="flex flex-wrap items-center gap-2">
                  <Select
                    :model-value="m.role"
                    :options="assignableRoles(m)"
                    option-label="label"
                    option-value="value"
                    size="small"
                    class="w-36"
                    :disabled="busyUid === m.uid"
                    :aria-label="`Role for ${m.email}`"
                    @update:model-value="(v) => changeRole(m, v)"
                  />
                  <Button
                    label="Remove"
                    size="small"
                    text
                    severity="danger"
                    :loading="busyUid === m.uid"
                    @click="removeMember(m)"
                  />
                </div>
              </li>
            </ul>

            <!-- Desktop -->
            <DataTable :value="members" class="hidden lg:block" data-key="uid" size="small" aria-label="Members">
              <Column header="Member">
                <template #body="{ data }">
                  <div class="flex items-center gap-3">
                    <Avatar
                      :image="data.photoURL ?? undefined"
                      :label="data.photoURL ? undefined : initials(data.displayName ?? data.email)"
                      shape="circle"
                      size="normal"
                    />
                    <div class="min-w-0">
                      <p class="truncate text-sm text-ink">
                        {{ data.displayName || data.email }}
                        <span v-if="data.uid === auth.user?.uid" class="text-xs text-ink-soft">· you</span>
                      </p>
                      <p class="truncate text-xs text-ink-soft">{{ data.email }}</p>
                    </div>
                  </div>
                </template>
              </Column>

              <Column header="Role" style="width: 14rem">
                <template #body="{ data }">
                  <Select
                    v-if="mayManage(data)"
                    :model-value="data.role"
                    :options="assignableRoles(data)"
                    option-label="label"
                    option-value="value"
                    size="small"
                    :disabled="busyUid === data.uid"
                    :aria-label="`Role for ${data.email}`"
                    @update:model-value="(v) => changeRole(data, v)"
                  />
                  <Tag v-else :value="data.role" :severity="roleSeverity[data.role as Role]" />
                </template>
              </Column>

              <Column header="Joined" style="width: 12rem">
                <template #body="{ data }">
                  <span class="text-sm">{{ formatDate(data.addedAt, ws.timezone) }}</span>
                </template>
              </Column>

              <Column style="width: 8rem">
                <template #body="{ data }">
                  <Button
                    v-if="mayManage(data)"
                    label="Remove"
                    size="small"
                    text
                    severity="danger"
                    :loading="busyUid === data.uid"
                    @click="removeMember(data)"
                  />
                </template>
              </Column>
            </DataTable>
          </template>
        </template>
      </Card>

      <!-- Ownership -->
      <Card v-if="myRole === 'OWNER'">
        <template #title><span class="text-sm">Ownership</span></template>
        <template #content>
          <div class="flex flex-wrap items-center gap-3">
            <p class="min-w-0 flex-1 text-sm text-ink-muted">
              You are the owner of this workspace. There is always exactly one owner.
            </p>
            <Button
              label="Transfer ownership"
              icon="pi pi-user-edit"
              severity="secondary"
              outlined
              size="small"
              :disabled="!transferCandidates.length"
              @click="transferOpen = true"
            />
          </div>
          <p v-if="!transferCandidates.length" class="mt-2 text-xs text-ink-soft">
            Invite someone else before you can transfer ownership.
          </p>
          <p v-if="owners.length > 1" class="mt-2 text-xs text-warn">
            This workspace has {{ owners.length }} owners, which should not happen. Contact support.
          </p>
        </template>
      </Card>
    </template>

    <Dialog
      v-model:visible="transferOpen"
      modal
      header="Transfer ownership"
      :style="{ width: 'min(26rem, calc(100vw - 2rem))' }"
    >
      <div class="flex flex-col gap-3">
        <label for="transfer-to" class="text-sm font-medium text-ink">New owner</label>
        <Select
          id="transfer-to"
          v-model="transferTo"
          :options="transferCandidates"
          option-label="label"
          option-value="value"
          placeholder="Choose a member"
          fluid
        />
        <Message severity="warn" :closable="false" size="small">
          You will become an admin. Only the new owner can transfer it back.
        </Message>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" outlined @click="transferOpen = false" />
        <Button label="Transfer" icon="pi pi-check" :disabled="!transferTo" @click="transferOwnership" />
      </template>
    </Dialog>
  </div>
</template>

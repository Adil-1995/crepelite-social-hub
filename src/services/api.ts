import { httpsCallable, type FunctionsError } from 'firebase/functions';
import type { z } from 'zod';
import type {
  bulkScheduleSchema,
  cancelPostSchema,
  channelToggleSchema,
  connectionRef,
  createPostSchema,
  deletePublishedSchema,
  deliveryRef,
  disconnectSchema,
  fetchImportSchema,
  importPostsSchema,
  inviteMemberSchema,
  mediaRef,
  notificationPrefsSchema,
  postRef,
  registerMediaSchema,
  registerPushTokenSchema,
  removeMemberSchema,
  retryDeliverySchema,
  revokeInvitationSchema,
  schedulePostSchema,
  startOAuthSchema,
  updateMediaTagsSchema,
  updateMemberSchema,
  updatePostSchema,
  workspaceCreateSchema,
  workspaceRef,
  workspaceUpdateSchema,
  ImportCandidate,
  Role,
  DeliveryStatus,
  ValidationIssue,
} from '@shared/index';
import { functions } from '@/app/firebase';

type In<S extends z.ZodType> = z.input<S>;

function call<I, O>(name: string) {
  const fn = httpsCallable<I, O>(functions, name, { timeout: 540_000 });
  return async (data: I): Promise<O> => (await fn(data)).data;
}

export interface Membership {
  workspaceId: string;
  workspaceName: string;
  role: Role;
}

export interface ScheduleResult {
  deliveries: Array<{ id: string; channelId: string; status: DeliveryStatus; scheduledAt: number }>;
  skipped: string[];
}

export interface ProviderStatus {
  environment: 'development' | 'staging' | 'production';
  mockEnabled: boolean;
  families: Array<{ family: string; displayName: string; configured: boolean; missing: string[]; providers: string[] }>;
  notices: { tiktokAudited: boolean; youtubeAudited: boolean; pinterestSandbox: boolean };
}

export interface BulkItemResult {
  itemId: string;
  postId: string | null;
  scheduledAt: number | null;
  status: 'scheduled' | 'failed' | 'skipped';
  error?: string;
}

/** Typed callable API. The backend re-validates every payload with the same shared schemas. */
export const api = {
  bootstrapUser: call<Record<string, never>, { acceptedInvitations: string[]; emailVerified: boolean; memberships: Membership[]; canCreateWorkspace: boolean }>('bootstrapUser'),
  createWorkspace: call<In<typeof workspaceCreateSchema>, { workspaceId: string }>('createWorkspace'),
  updateWorkspace: call<In<typeof workspaceUpdateSchema>, { ok: true }>('updateWorkspace'),
  inviteMember: call<In<typeof inviteMemberSchema>, { ok: true }>('inviteMember'),
  revokeInvitation: call<In<typeof revokeInvitationSchema>, { ok: true }>('revokeInvitation'),
  updateMemberRole: call<In<typeof updateMemberSchema>, { ok: true }>('updateMemberRole'),
  removeMember: call<In<typeof removeMemberSchema>, { ok: true }>('removeMember'),
  transferOwnership: call<{ workspaceId: string; uid: string }, { ok: true }>('transferOwnership'),
  updateNotificationPrefs: call<In<typeof notificationPrefsSchema>, { ok: true }>('updateNotificationPrefs'),
  registerPushToken: call<In<typeof registerPushTokenSchema>, { ok: true }>('registerPushToken'),
  markNotificationsRead: call<{ workspaceId: string; ids: string[] }, { ok: true }>('markNotificationsRead'),

  createPost: call<In<typeof createPostSchema>, { postId: string }>('createPost'),
  updatePost: call<In<typeof updatePostSchema>, { postId: string; lockedChannels: string[]; revision: number }>('updatePost'),
  deletePost: call<In<typeof postRef>, { ok: true }>('deletePost'),
  duplicatePost: call<In<typeof postRef>, { postId: string }>('duplicatePost'),
  schedulePost: call<In<typeof schedulePostSchema>, ScheduleResult>('schedulePost'),
  publishNow: call<In<typeof postRef>, ScheduleResult>('publishNow'),
  cancelPost: call<In<typeof cancelPostSchema>, { cancelled: string[]; blocked: string[] }>('cancelPost'),
  retryDelivery: call<In<typeof retryDeliverySchema>, { ok: true }>('retryDelivery'),
  updatePublished: call<In<typeof deliveryRef>, { ok: true }>('updatePublished'),
  deletePublished: call<In<typeof deletePublishedSchema>, { ok: true }>('deletePublished'),

  registerMedia: call<In<typeof registerMediaSchema>, { mediaId: string }>('registerMedia'),
  deleteMedia: call<In<typeof mediaRef>, { ok: true }>('deleteMedia'),
  copyMedia: call<In<typeof mediaRef>, { mediaId: string }>('copyMedia'),
  updateMediaTags: call<In<typeof updateMediaTagsSchema>, { ok: true }>('updateMediaTags'),

  getProviderStatus: call<In<typeof workspaceRef>, ProviderStatus>('getProviderStatus'),
  startOAuth: call<In<typeof startOAuthSchema>, { authorizationUrl: string }>('startOAuth'),
  refreshConnection: call<In<typeof connectionRef>, { status: string }>('refreshConnection'),
  disconnectConnection: call<In<typeof disconnectSchema>, { requiresConfirmation: boolean; dependentScheduled?: number; dependentPostIds?: string[]; cancelledDeliveries?: number }>(
    'disconnectConnection',
  ),
  setChannelEnabled: call<In<typeof channelToggleSchema>, { ok: true }>('setChannelEnabled'),
  mockRevokeConnection: call<{ workspaceId: string; connectionId: string }, { ok: true }>('mockRevokeConnection'),

  createBulkSchedule: call<In<typeof bulkScheduleSchema> & { jobId: string }, { jobId: string; results: BulkItemResult[] }>('createBulkSchedule'),
  fetchImportCandidates: call<In<typeof fetchImportSchema>, { importJobId: string; candidates: ImportCandidate[] }>('fetchImportCandidates'),
  importPosts: call<
    In<typeof importPostsSchema>,
    { drafts: Array<{ externalPostId: string; postId: string; mediaReady: boolean; note: string | null }>; bulk: { jobId: string; results: BulkItemResult[] } | null }
  >('importPosts'),
};

export interface ApiErrorInfo {
  code: string;
  message: string;
  details: Record<string, unknown> | null;
  channelIssues: Array<{ channelId: string; provider: string; channelName: string; issues: ValidationIssue[] }>;
  offline: boolean;
}

/** Normalises callable errors into something the UI can show. */
export function apiError(e: unknown): ApiErrorInfo {
  const fe = e as FunctionsError & { details?: Record<string, unknown> };
  const code = (fe?.code ?? 'unknown').replace(/^functions\//, '');
  const details = (fe?.details as Record<string, unknown> | undefined) ?? null;
  const offline = typeof navigator !== 'undefined' && !navigator.onLine;
  let message = fe?.message || 'Something went wrong';
  if (code === 'unavailable' || offline) message = 'You are offline. Changes will need a connection to be saved.';
  if (code === 'internal' && !details) message = 'Unexpected server error. Please try again.';
  const channelIssues = (details?.channels as ApiErrorInfo['channelIssues'] | undefined) ?? [];
  const issues = details?.issues as Array<{ path: string; message: string }> | undefined;
  if (issues?.length) message = `${message}: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`;
  return { code, message, details, channelIssues, offline };
}

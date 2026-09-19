/**
 * Cloud Functions entry point (Firebase Functions v2).
 *
 * The exported names are the deployed function names. Task-queue functions
 * must keep the names used by tasks/dispatcher.ts (executeDelivery, checkDeliveryStatus).
 */
import { setGlobalOptions } from 'firebase-functions/v2';
import { REGION } from './config/env';

setGlobalOptions({ region: REGION, maxInstances: 20 });

// Posts & publishing
export {
  createPostFn as createPost,
  updatePostFn as updatePost,
  deletePostFn as deletePost,
  duplicatePostFn as duplicatePost,
  schedulePostFn as schedulePost,
  publishNowFn as publishNow,
  cancelPostFn as cancelPost,
  retryDeliveryFn as retryDelivery,
  updatePublishedFn as updatePublished,
  deletePublishedFn as deletePublished,
} from './api/posts';

// Media
export { registerMediaFn as registerMedia, deleteMediaFn as deleteMedia, copyMediaFn as copyMedia, updateMediaTagsFn as updateMediaTags, mediaPull } from './api/media';

// Workspace, team, user
export {
  bootstrapUserFn as bootstrapUser,
  createWorkspaceFn as createWorkspace,
  updateWorkspaceFn as updateWorkspace,
  inviteMemberFn as inviteMember,
  revokeInvitationFn as revokeInvitation,
  updateMemberRoleFn as updateMemberRole,
  removeMemberFn as removeMember,
  transferOwnershipFn as transferOwnership,
  updateNotificationPrefsFn as updateNotificationPrefs,
  registerPushTokenFn as registerPushToken,
  markNotificationsReadFn as markNotificationsRead,
} from './api/workspace';

// Connections / OAuth
export {
  getProviderStatusFn as getProviderStatus,
  startOAuthFn as startOAuth,
  oauthCallback,
  refreshConnectionFn as refreshConnection,
  disconnectConnectionFn as disconnectConnection,
  setChannelEnabledFn as setChannelEnabled,
  mockRevokeConnectionFn as mockRevokeConnection,
} from './api/connections';

// Bulk & import
export { createBulkScheduleFn as createBulkSchedule, fetchImportCandidatesFn as fetchImportCandidates, importPostsFn as importPosts } from './api/bulkImport';

// Tasks & scheduled jobs
export {
  executeDeliveryTask as executeDelivery,
  checkDeliveryStatusTask as checkDeliveryStatus,
  queueUpcomingDeliveriesJob as queueUpcomingDeliveries,
  reconcileDeliveriesJob as reconcileDeliveries,
  connectionHealthJob as connectionHealth,
  cleanupOAuthStatesJob as cleanupOAuthStates,
} from './tasks/handlers';

// Webhooks
export { webhooks } from './webhooks/webhooks';

export {
  getAiStatusFn as getAiStatus,
  generateCaptionFn as generateCaption,
  rewriteCaptionFn as rewriteCaption,
  adaptCaptionFn as adaptCaption,
  markAiGenerationAcceptedFn as markAiGenerationAccepted,
  updateAiSettingsFn as updateAiSettings,
  getAppearanceFn as getAppearance,
  updateAppearanceFn as updateAppearance,
} from './api/ai';

import { useRouter } from 'vue-router';
import type { MenuItem } from 'primevue/menuitem';
import type { Delivery, Post } from '@shared/index';
import { api } from '@/services/api';
import { useWorkspaceStore } from '@/stores/workspace';
import { useFeedback } from '@/composables/useFeedback';

/**
 * Post and delivery operations shared by the list, the detail screen and the
 * calendar, so every entry point enforces the same permissions, confirmations
 * and wording.
 */
export function usePostActions() {
  const ws = useWorkspaceStore();
  const router = useRouter();
  const { success, warn, reportApiError, confirmDestructive } = useFeedback();

  const canWrite = () => ws.can('content.write');
  const canSchedule = () => ws.can('content.schedule');

  /** Pending deliveries can still be cancelled or rescheduled. */
  function hasPending(post: Post): boolean {
    return Object.values(post.deliverySummary ?? {}).some(
      (d) => d.status === 'queued' || d.status === 'awaiting_queue',
    );
  }

  function hasPublished(post: Post): boolean {
    return Object.values(post.deliverySummary ?? {}).some((d) => d.status === 'published');
  }

  async function publishNow(post: Post): Promise<boolean> {
    if (!ws.workspaceId || !canSchedule()) return false;
    const ok = await confirmDestructive({
      header: 'Publish now?',
      message: 'This sends the post to every selected destination immediately.',
      acceptLabel: 'Publish now',
      icon: 'pi pi-send',
    });
    if (!ok) return false;
    try {
      const res = await api.publishNow({ workspaceId: ws.workspaceId, postId: post.id });
      if (res.skipped?.length) {
        warn('Publishing started', `${res.skipped.length} destination(s) were skipped.`);
      } else {
        success('Publishing started', `${res.deliveries.length} destination(s).`);
      }
      return true;
    } catch (e) {
      reportApiError(e, 'Could not publish');
      return false;
    }
  }

  async function schedule(post: Post, whenMs: number): Promise<boolean> {
    if (!ws.workspaceId || !canSchedule()) return false;
    try {
      const res = await api.schedulePost({
        workspaceId: ws.workspaceId,
        postId: post.id,
        scheduledAt: new Date(whenMs).toISOString(),
        timezone: ws.timezone,
      });
      success('Post scheduled', `${res.deliveries.length} destination(s).`);
      return true;
    } catch (e) {
      reportApiError(e, 'Could not schedule the post');
      return false;
    }
  }

  async function cancel(post: Post): Promise<boolean> {
    if (!ws.workspaceId || !canSchedule()) return false;
    const ok = await confirmDestructive({
      header: 'Cancel this schedule?',
      message: 'Pending publications are cancelled. Anything already published stays online.',
      acceptLabel: 'Cancel schedule',
    });
    if (!ok) return false;
    try {
      const res = await api.cancelPost({ workspaceId: ws.workspaceId, postId: post.id });
      if (res.blocked?.length) {
        warn('Partly cancelled', `${res.blocked.length} destination(s) were already publishing.`);
      } else {
        success('Schedule cancelled');
      }
      return true;
    } catch (e) {
      reportApiError(e, 'Could not cancel the schedule');
      return false;
    }
  }

  async function duplicate(post: Post): Promise<boolean> {
    if (!ws.workspaceId || !canWrite()) return false;
    try {
      const { postId } = await api.duplicatePost({ workspaceId: ws.workspaceId, postId: post.id });
      success('Post duplicated');
      await router.push(`/compose/${postId}`);
      return true;
    } catch (e) {
      reportApiError(e, 'Could not duplicate the post');
      return false;
    }
  }

  async function remove(post: Post): Promise<boolean> {
    if (!ws.workspaceId || !canWrite()) return false;
    const published = hasPublished(post);
    const ok = await confirmDestructive({
      header: 'Delete this post?',
      message: published
        ? 'The CrepeLite record is deleted. Anything already published stays on the social network.'
        : 'This cannot be undone.',
      acceptLabel: 'Delete',
    });
    if (!ok) return false;
    try {
      await api.deletePost({ workspaceId: ws.workspaceId, postId: post.id });
      success('Post deleted');
      return true;
    } catch (e) {
      reportApiError(e, 'Could not delete the post');
      return false;
    }
  }

  /**
   * Retries a single failed delivery. The others are untouched — a retry never
   * republishes a destination that already succeeded.
   */
  async function retryDelivery(delivery: Pick<Delivery, 'id' | 'status' | 'externalPostId' | 'error'>): Promise<boolean> {
    if (!ws.workspaceId || !canSchedule()) return false;

    // When the previous attempt may have reached the network, the server needs
    // an explicit acknowledgement before trying again.
    const uncertain = delivery.error?.category === 'NETWORK' || delivery.error?.category === 'UNKNOWN';
    if (uncertain) {
      const ok = await confirmDestructive({
        header: 'Retry this destination?',
        message:
          'The previous attempt did not report a clear outcome, so retrying could publish twice. Check the account before continuing.',
        acceptLabel: 'Retry anyway',
      });
      if (!ok) return false;
    }

    try {
      await api.retryDelivery({
        workspaceId: ws.workspaceId,
        deliveryId: delivery.id,
        confirmPossibleDuplicate: uncertain,
      });
      success('Retry queued');
      return true;
    } catch (e) {
      reportApiError(e, 'Could not retry');
      return false;
    }
  }

  /**
   * Menu entries for a post, filtered by role and current status.
   *
   * `onDone` reports the deleted id when the action removed the post, so the
   * caller can drop the row locally — re-querying is not enough, because
   * Firestore's cache can still answer with a document a callable deleted.
   */
  function menuItems(post: Post, onDone: (result?: { removedId?: string }) => void = () => {}): MenuItem[] {
    const run = (fn: () => Promise<boolean>, removedId?: string) => async () => {
      if (await fn()) onDone(removedId ? { removedId } : undefined);
    };
    const editable = post.status !== 'published' && post.status !== 'publishing';

    const items: MenuItem[] = [
      { label: 'Open', icon: 'pi pi-eye', command: () => router.push(`/posts/${post.id}`) },
    ];

    if (canWrite() && editable) {
      items.push({ label: 'Edit', icon: 'pi pi-pencil', command: () => router.push(`/compose/${post.id}`) });
    }
    if (canWrite()) {
      items.push({ label: 'Duplicate', icon: 'pi pi-copy', command: run(() => duplicate(post)) });
    }
    if (canSchedule() && post.status === 'draft') {
      items.push({ label: 'Publish now', icon: 'pi pi-send', command: run(() => publishNow(post)) });
    }
    if (canSchedule() && hasPending(post)) {
      items.push({ label: 'Cancel schedule', icon: 'pi pi-ban', command: run(() => cancel(post)) });
    }
    if (canWrite()) {
      items.push({ separator: true }, { label: 'Delete', icon: 'pi pi-trash', command: run(() => remove(post), post.id) });
    }
    return items;
  }

  return { publishNow, schedule, cancel, duplicate, remove, retryDelivery, menuItems, hasPending, hasPublished };
}

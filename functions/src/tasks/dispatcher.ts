import { getFunctions } from 'firebase-admin/functions';
import { CloudTasksClient } from '@google-cloud/tasks';
import { CLOUD_TASKS_MAX_SCHEDULE_DAYS } from '@shared/index';
import { REGION, config } from '../config/env';
import { log } from '../utils/logger';

/**
 * Cloud Tasks abstraction. Each delivery gets its own named task, so
 * enqueueing the same (delivery, scheduleVersion, attempt) twice is a no-op.
 *
 * - `functions` target → Firebase task-queue functions (executeDelivery / checkDeliveryStatus)
 * - `worker` target    → Cloud Run publisher-worker via an HTTP task with an OIDC token
 */
export type TaskKind = 'execute' | 'status_check';
export type TaskTarget = 'functions' | 'worker';

export interface DeliveryTaskPayload {
  kind: TaskKind;
  workspaceId: string;
  deliveryId: string;
  scheduleVersion: number;
  /** Retry number for execute tasks, status-check counter for status_check tasks. */
  seq: number;
}

export interface EnqueueOptions {
  id: string;
  scheduleAt: Date;
}

export interface TaskDispatcher {
  enqueue(target: TaskTarget, payload: DeliveryTaskPayload, opts: EnqueueOptions): Promise<string>;
  cancel(target: TaskTarget, kind: TaskKind, taskId: string): Promise<void>;
}

const MAX_MS = CLOUD_TASKS_MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000;

function assertWithinWindow(when: Date): void {
  if (when.getTime() - Date.now() > MAX_MS) {
    throw new Error(`Cannot schedule a Cloud Task more than ${CLOUD_TASKS_MAX_SCHEDULE_DAYS} days ahead; use awaiting_queue`);
  }
}

const FUNCTION_FOR_KIND: Record<TaskKind, string> = {
  execute: 'executeDelivery',
  status_check: 'checkDeliveryStatus',
};

function isAlreadyExists(e: unknown): boolean {
  const code = (e as { code?: string | number }).code;
  const msg = String((e as Error).message ?? '');
  return code === 'functions/task-already-exists' || code === 6 || /already exists/i.test(msg);
}

function isNotFound(e: unknown): boolean {
  const code = (e as { code?: string | number }).code;
  return code === 'functions/not-found' || code === 5 || /not.?found/i.test(String((e as Error).message ?? ''));
}

export class FirebaseTaskQueueDispatcher implements TaskDispatcher {
  private workerClient: CloudTasksClient | null = null;

  async enqueue(target: TaskTarget, payload: DeliveryTaskPayload, opts: EnqueueOptions): Promise<string> {
    assertWithinWindow(opts.scheduleAt);
    if (target === 'worker' && config.workerUrl()) return this.enqueueWorker(payload, opts);
    if (target === 'worker') log.warn('WORKER_URL not configured; running heavy delivery in Cloud Functions', { deliveryId: payload.deliveryId });

    const queue = getFunctions().taskQueue(`locations/${REGION}/functions/${FUNCTION_FOR_KIND[payload.kind]}`);
    try {
      await queue.enqueue(payload as unknown as Record<string, unknown>, { id: opts.id, scheduleTime: opts.scheduleAt, dispatchDeadlineSeconds: 1800 });
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
      log.info('Task already exists (idempotent enqueue)', { taskId: opts.id });
    }
    return `functions:${payload.kind}:${opts.id}`;
  }

  private async enqueueWorker(payload: DeliveryTaskPayload, opts: EnqueueOptions): Promise<string> {
    this.workerClient ??= new CloudTasksClient();
    const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
    const parent = this.workerClient.queuePath(project, config.tasksLocation(), config.workerQueue());
    const name = `${parent}/tasks/${opts.id}`;
    try {
      await this.workerClient.createTask({
        parent,
        task: {
          name,
          scheduleTime: { seconds: Math.floor(opts.scheduleAt.getTime() / 1000) },
          dispatchDeadline: { seconds: 1800 },
          httpRequest: {
            httpMethod: 'POST',
            url: `${config.workerUrl().replace(/\/$/, '')}/tasks/${payload.kind === 'execute' ? 'execute' : 'status'}`,
            headers: { 'Content-Type': 'application/json' },
            body: Buffer.from(JSON.stringify(payload)).toString('base64'),
            oidcToken: { serviceAccountEmail: config.workerServiceAccount(), audience: config.workerUrl() },
          },
        },
      });
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
    }
    return `worker:${payload.kind}:${opts.id}`;
  }

  async cancel(target: TaskTarget, kind: TaskKind, taskId: string): Promise<void> {
    try {
      if (target === 'worker' && config.workerUrl()) {
        this.workerClient ??= new CloudTasksClient();
        const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
        await this.workerClient.deleteTask({ name: this.workerClient.taskPath(project, config.tasksLocation(), config.workerQueue(), taskId) });
        return;
      }
      await getFunctions().taskQueue(`locations/${REGION}/functions/${FUNCTION_FOR_KIND[kind]}`).delete(taskId);
    } catch (e) {
      // Already executed or deleted: fine. scheduleVersion makes stale tasks harmless anyway.
      if (!isNotFound(e)) log.warn('Task cancel failed (stale task will be ignored by scheduleVersion)', { taskId, error: String(e) });
    }
  }
}

/** Parses "functions:execute:dlv-..." task names stored on deliveries. */
export function parseTaskName(taskName: string): { target: TaskTarget; kind: TaskKind; id: string } | null {
  const m = /^(functions|worker):(execute|status_check):(.+)$/.exec(taskName);
  if (!m) return null;
  return { target: m[1] as TaskTarget, kind: m[2] as TaskKind, id: m[3] as string };
}

/** Deterministic in-memory dispatcher for tests. */
export class InMemoryDispatcher implements TaskDispatcher {
  tasks = new Map<string, { target: TaskTarget; payload: DeliveryTaskPayload; scheduleAt: Date; cancelled: boolean }>();
  enqueueCalls = 0;

  async enqueue(target: TaskTarget, payload: DeliveryTaskPayload, opts: EnqueueOptions): Promise<string> {
    assertWithinWindow(opts.scheduleAt);
    this.enqueueCalls++;
    if (!this.tasks.has(opts.id)) this.tasks.set(opts.id, { target, payload, scheduleAt: opts.scheduleAt, cancelled: false });
    return `${target}:${payload.kind}:${opts.id}`;
  }

  async cancel(_target: TaskTarget, _kind: TaskKind, taskId: string): Promise<void> {
    const t = this.tasks.get(taskId);
    if (t) t.cancelled = true;
  }

  active(): Array<{ id: string; payload: DeliveryTaskPayload; scheduleAt: Date; target: TaskTarget }> {
    return [...this.tasks.entries()].filter(([, t]) => !t.cancelled).map(([id, t]) => ({ id, payload: t.payload, scheduleAt: t.scheduleAt, target: t.target }));
  }

  take(id: string): DeliveryTaskPayload {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`No task ${id}`);
    this.tasks.delete(id);
    return t.payload;
  }
}

let dispatcher: TaskDispatcher | null = null;
export function getDispatcher(): TaskDispatcher {
  dispatcher ??= new FirebaseTaskQueueDispatcher();
  return dispatcher;
}
export function setDispatcher(d: TaskDispatcher | null): void {
  dispatcher = d;
}

import type { DeliveryError, ErrorCategory } from './types';

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  /** When true the connection must be re-authorised before retrying. */
  needsReauth: boolean;
}

/**
 * Default HTTP classification. Providers refine it with platform error codes
 * (e.g. Meta error code 190 → AUTH) before falling back to this.
 */
export function classifyHttpStatus(status: number | null | undefined): ClassifiedError {
  if (status == null) return { category: 'NETWORK', retryable: true, needsReauth: false };
  if (status === 401) return { category: 'AUTH', retryable: false, needsReauth: true };
  if (status === 403) return { category: 'PERMISSION', retryable: false, needsReauth: false };
  if (status === 408) return { category: 'NETWORK', retryable: true, needsReauth: false };
  if (status === 409) return { category: 'PLATFORM', retryable: true, needsReauth: false };
  if (status === 413 || status === 415) return { category: 'MEDIA', retryable: false, needsReauth: false };
  if (status === 422 || status === 400) return { category: 'VALIDATION', retryable: false, needsReauth: false };
  if (status === 429) return { category: 'RATE_LIMIT', retryable: true, needsReauth: false };
  if (status >= 500) return { category: 'PLATFORM', retryable: true, needsReauth: false };
  return { category: 'UNKNOWN', retryable: false, needsReauth: false };
}

export const AUTO_RETRY_LIMIT = 5;

/**
 * Exponential backoff with full jitter, capped. `attempt` starts at 1.
 * `retryAfterSec` from provider headers always wins when larger.
 */
export function backoffDelaySeconds(
  attempt: number,
  opts: { baseSec?: number; maxSec?: number; retryAfterSec?: number | null; random?: () => number } = {},
): number {
  const base = opts.baseSec ?? 30;
  const max = opts.maxSec ?? 60 * 60;
  const random = opts.random ?? Math.random;
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(exp / 2 + random() * (exp / 2));
  return Math.max(jittered, Math.ceil(opts.retryAfterSec ?? 0));
}

export function makeDeliveryError(
  code: string,
  message: string,
  category: ErrorCategory,
  retryable: boolean,
  httpStatus: number | null = null,
): DeliveryError {
  return { code, message, category, retryable, httpStatus };
}

/** Human-oriented hint shown next to failed deliveries. */
export function errorActionHint(err: Pick<DeliveryError, 'category'> | null | undefined): string {
  switch (err?.category) {
    case 'AUTH':
      return 'Reconnect the account, then retry.';
    case 'PERMISSION':
      return 'The connected account lacks a required permission. Reconnect and grant all requested permissions.';
    case 'RATE_LIMIT':
      return 'The platform is rate limiting requests. It will be retried automatically.';
    case 'VALIDATION':
    case 'MEDIA':
      return 'Fix the content for this platform, then retry.';
    case 'NETWORK':
    case 'PLATFORM':
      return 'Temporary platform problem. Retry later.';
    case 'PROCESSING':
      return 'The platform could not process the media.';
    default:
      return 'Check the details and retry.';
  }
}

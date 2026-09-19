import { classifyHttpStatus, type DeliveryError, type ErrorCategory } from '@shared/index';

/**
 * Every provider failure is normalised into a ProviderError so the publishing
 * engine can decide uniformly: retry with backoff, mark needs_reauth, or fail.
 */
export class ProviderError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly needsReauth: boolean;
  readonly httpStatus: number | null;
  readonly retryAfterSec: number | null;

  constructor(opts: {
    code: string;
    message: string;
    category: ErrorCategory;
    retryable: boolean;
    needsReauth?: boolean;
    httpStatus?: number | null;
    retryAfterSec?: number | null;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = 'ProviderError';
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable;
    this.needsReauth = opts.needsReauth ?? opts.category === 'AUTH';
    this.httpStatus = opts.httpStatus ?? null;
    this.retryAfterSec = opts.retryAfterSec ?? null;
  }

  static fromHttp(status: number, code: string, message: string, retryAfterSec: number | null = null): ProviderError {
    const c = classifyHttpStatus(status);
    return new ProviderError({ code, message, category: c.category, retryable: c.retryable, needsReauth: c.needsReauth, httpStatus: status, retryAfterSec });
  }

  static config(message: string): ProviderError {
    return new ProviderError({ code: 'provider_not_configured', message, category: 'PERMISSION', retryable: false });
  }

  static validation(message: string, code = 'invalid_content'): ProviderError {
    return new ProviderError({ code, message, category: 'VALIDATION', retryable: false });
  }

  toDeliveryError(): DeliveryError {
    return { code: this.code, message: this.message.slice(0, 1000), category: this.category, retryable: this.retryable, httpStatus: this.httpStatus };
  }
}

export function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const err = e as { name?: string; message?: string; code?: string };
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(err?.message ?? '')) {
    return new ProviderError({ code: 'network_error', message: err.message ?? 'Network error', category: 'NETWORK', retryable: true, cause: e });
  }
  return new ProviderError({ code: 'unexpected_error', message: err?.message ?? String(e), category: 'UNKNOWN', retryable: false, cause: e });
}

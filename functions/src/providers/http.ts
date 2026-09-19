import { ProviderError } from './errors';
import { log } from '../utils/logger';

/**
 * Minimal fetch wrapper for provider APIs:
 * - timeouts
 * - rate-limit header parsing (Retry-After, X-RateLimit-*, Meta X-App-Usage / X-Business-Use-Case-Usage)
 * - provider-specific error mapping via `mapError`
 * - no retries here: retries are scheduled by the publishing engine with backoff,
 *   never as tight loops inside a request.
 */
export interface RateLimitInfo {
  retryAfterSec: number | null;
  remaining: number | null;
  resetAtMs: number | null;
  /** Highest usage percentage reported by Meta usage headers. */
  usagePercent: number | null;
}

export function parseRateLimit(headers: Headers): RateLimitInfo {
  const retryAfter = headers.get('retry-after');
  let retryAfterSec: number | null = null;
  if (retryAfter) {
    const n = Number(retryAfter);
    retryAfterSec = Number.isFinite(n) ? n : Math.max(0, Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000));
  }
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  let usagePercent: number | null = null;
  for (const h of ['x-app-usage', 'x-business-use-case-usage', 'x-ad-account-usage']) {
    const raw = headers.get(h);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const values: number[] = [];
      const walk = (v: unknown) => {
        if (typeof v === 'number') values.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
          for (const [k, x] of Object.entries(v)) {
            if (k === 'estimated_time_to_regain_access' && typeof x === 'number' && x > 0) retryAfterSec = Math.max(retryAfterSec ?? 0, x * 60);
            else if (k !== 'type') walk(x);
          }
        }
      };
      walk(parsed);
      if (values.length) usagePercent = Math.max(usagePercent ?? 0, ...values);
    } catch {
      // ignore malformed usage headers
    }
  }
  const resetNum = reset ? Number(reset) : NaN;
  return {
    retryAfterSec,
    remaining: remaining != null && remaining !== '' ? Number(remaining) : null,
    // Pinterest sends seconds-until-reset; epoch seconds are > 1e9
    resetAtMs: Number.isFinite(resetNum) ? (resetNum > 1e9 ? resetNum * 1000 : Date.now() + resetNum * 1000) : null,
    usagePercent,
  };
}

export interface HttpRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  json?: unknown;
  form?: Record<string, string>;
  body?: RequestInit['body'] | ReadableStream<Uint8Array>;
  timeoutMs?: number;
  /** Required by Node fetch for streaming request bodies. */
  duplex?: 'half';
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
  rateLimit: RateLimitInfo;
}

export type ErrorMapper = (status: number, body: unknown, rateLimit: RateLimitInfo) => ProviderError;

export class HttpClient {
  constructor(
    private readonly providerId: string,
    private readonly mapError: ErrorMapper,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const url = new URL(req.url);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Accept: 'application/json', ...(req.headers ?? {}) };
    let body: RequestInit['body'] | ReadableStream<Uint8Array> | undefined = req.body;
    if (req.json !== undefined) {
      headers['Content-Type'] = 'application/json; charset=UTF-8';
      body = JSON.stringify(req.json);
    } else if (req.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(req.form).toString();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: req.method ?? 'GET',
        headers,
        body: body as RequestInit['body'],
        signal: controller.signal,
        ...(req.duplex ? { duplex: req.duplex } : {}),
      } as RequestInit);
    } catch (e) {
      throw new ProviderError({ code: 'network_error', message: `${this.providerId}: ${(e as Error).message}`, category: 'NETWORK', retryable: true, cause: e });
    } finally {
      clearTimeout(timer);
    }
    const rateLimit = parseRateLimit(res.headers);
    const text = await res.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (rateLimit.usagePercent != null && rateLimit.usagePercent >= 80) {
      log.warn('Provider rate-limit usage high', { provider: this.providerId, usagePercent: rateLimit.usagePercent });
    }
    if (!res.ok && res.status !== 308) throw this.mapError(res.status, data, rateLimit);
    return { status: res.status, headers: res.headers, data: data as T, rateLimit };
  }
}

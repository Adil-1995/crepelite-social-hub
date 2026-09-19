import { createHmac } from 'node:crypto';
import { config } from '../../config/env';
import { ProviderError } from '../errors';
import { HttpClient, type RateLimitInfo } from '../http';

/**
 * Thin Graph API client shared by the Facebook and Instagram providers.
 * Version is configurable (META_GRAPH_VERSION, default v26.0 — current as of 2026-09).
 * Every call carries appsecret_proof when the app secret is available.
 */
interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; is_transient?: boolean; error_user_msg?: string; fbtrace_id?: string };
}

export function mapMetaError(status: number, body: unknown, rl: RateLimitInfo): ProviderError {
  const e = (body as GraphErrorBody)?.error ?? {};
  const code = e.code ?? 0;
  const sub = e.error_subcode ?? 0;
  const message = e.error_user_msg || e.message || `Meta API error (HTTP ${status})`;
  const tag = `meta_${code}${sub ? '_' + sub : ''}`;
  const mk = (category: ProviderError['category'], retryable: boolean, needsReauth = false) =>
    new ProviderError({ code: tag, message, category, retryable, needsReauth, httpStatus: status, retryAfterSec: rl.retryAfterSec });

  if (code === 190 || code === 102 || code === 463 || code === 467) return mk('AUTH', false, true);
  if ([4, 17, 32, 613].includes(code) || (code >= 80001 && code <= 80014)) {
    return new ProviderError({ code: tag, message, category: 'RATE_LIMIT', retryable: true, httpStatus: status, retryAfterSec: rl.retryAfterSec ?? 15 * 60 });
  }
  if (code === 10 || (code >= 200 && code <= 299) || code === 368) return mk('PERMISSION', false);
  if (code === 9007 || code === 2207027) return mk('PROCESSING', true); // media not ready yet
  if (code === 9004 || code === 36000 || code === 36001 || code === 36003 || code === 2207026 || code === 352) return mk('MEDIA', false);
  if (code === 1 || code === 2 || e.is_transient) return mk('PLATFORM', true);
  if (code === 100) return mk('VALIDATION', false);
  if (status >= 500) return mk('PLATFORM', true);
  if (status === 429) return mk('RATE_LIMIT', true);
  return mk('UNKNOWN', false);
}

export class MetaGraphClient {
  private readonly http: HttpClient;

  constructor(
    private readonly appSecret: () => string,
    fetchImpl?: typeof fetch,
  ) {
    this.http = new HttpClient('meta', mapMetaError, fetchImpl);
  }

  get version(): string {
    return config.meta.graphVersion();
  }

  url(path: string, host = 'graph.facebook.com'): string {
    return `https://${host}/${this.version}/${path.replace(/^\//, '')}`;
  }

  private proof(token: string): Record<string, string> {
    const secret = this.appSecret();
    // App tokens ("appId|secret") do not take a proof.
    return secret && token && !token.includes('|') ? { appsecret_proof: createHmac('sha256', secret).update(token).digest('hex') } : {};
  }

  private auth(token: string): Record<string, string> {
    return token ? { access_token: token, ...this.proof(token) } : {};
  }

  async get<T>(path: string, token: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const res = await this.http.request<T>({ url: this.url(path), query: { ...query, ...this.auth(token) } });
    return res.data;
  }

  async post<T>(path: string, token: string, form: Record<string, string | number | boolean | undefined | null>): Promise<T> {
    const body: Record<string, string> = { ...this.auth(token) };
    for (const [k, v] of Object.entries(form)) if (v !== undefined && v !== null) body[k] = typeof v === 'string' ? v : JSON.stringify(v);
    const res = await this.http.request<T>({ method: 'POST', url: this.url(path), form: body });
    return res.data;
  }

  async delete<T>(path: string, token: string): Promise<T> {
    const res = await this.http.request<T>({ method: 'DELETE', url: this.url(path), query: this.auth(token) });
    return res.data;
  }

  /** Resumable-upload host used by Reels (rupload.facebook.com). */
  async rupload<T>(url: string, token: string, headers: Record<string, string>): Promise<T> {
    const res = await this.http.request<T>({ method: 'POST', url, headers: { Authorization: `OAuth ${token}`, ...headers } });
    return res.data;
  }

  /** Follows Graph cursor pagination up to `max` items. */
  async paginate<T>(path: string, token: string, query: Record<string, string | number | undefined>, max: number): Promise<T[]> {
    const out: T[] = [];
    let page = await this.get<{ data: T[]; paging?: { next?: string; cursors?: { after?: string } } }>(path, token, query);
    for (;;) {
      out.push(...(page.data ?? []));
      const after = page.paging?.cursors?.after;
      if (out.length >= max || !page.paging?.next || !after) break;
      page = await this.get(path, token, { ...query, after });
    }
    return out.slice(0, max);
  }
}

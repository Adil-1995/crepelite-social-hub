import * as fl from 'firebase-functions/logger';

/**
 * Structured Cloud Logging with mandatory sanitisation. Tokens, secrets,
 * authorization codes and signed URLs must never reach the logs.
 */
const SENSITIVE_KEYS = /^(access_?token|refresh_?token|id_?token|client_?secret|app_?secret|secret|password|auth(orization)?_?code|code_?verifier|authorization|token|fb_exchange_token|input_token|appsecret_proof|signature|sig|upload_url|uploadUrl|x-goog-signature|cookie|set-cookie)$/i;
const SENSITIVE_QUERY = /([?&](?:access_token|refresh_token|client_secret|code|code_verifier|appsecret_proof|token|sig|signature|X-Goog-Signature|X-Goog-Credential)=)[^&\s"]+/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return value.replace(SENSITIVE_QUERY, '$1[redacted]').replace(BEARER, '$1[redacted]');
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: sanitize(value.message, depth + 1) };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => fl.debug(msg, sanitize(data ?? {})),
  info: (msg: string, data?: Record<string, unknown>) => fl.info(msg, sanitize(data ?? {})),
  warn: (msg: string, data?: Record<string, unknown>) => fl.warn(msg, sanitize(data ?? {})),
  error: (msg: string, data?: Record<string, unknown>) => fl.error(msg, sanitize(data ?? {})),
};

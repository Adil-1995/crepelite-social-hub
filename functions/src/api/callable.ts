import { onCall, type CallableRequest } from 'firebase-functions/v2/https';
import type { ZodType } from 'zod';
import { REGION, env } from '../config/env';
import { parse } from '../utils/errors';
import { log } from '../utils/logger';
import { ProviderError } from '../providers/errors';
import { HttpsError } from 'firebase-functions/v2/https';
import type { SecretParam } from 'firebase-functions/params';

type Secret = SecretParam;

/**
 * Callable wrapper: region, shared-schema validation, secret binding and
 * error normalisation (provider errors become readable HttpsErrors; unknown
 * errors never leak internals).
 */
export function callable<I, O>(schema: ZodType<I>, handler: (data: I, request: CallableRequest) => Promise<O>, opts: { secrets?: Secret[]; timeoutSeconds?: number; memory?: '256MiB' | '512MiB' | '1GiB' } = {}) {
  return onCall(
    {
      region: REGION,
      secrets: opts.secrets ?? [],
      timeoutSeconds: opts.timeoutSeconds ?? 60,
      memory: opts.memory ?? '256MiB',
      enforceAppCheck: env('ENFORCE_APP_CHECK') === 'true',
    },
    async (request) => {
      const data = parse(schema, request.data);
      try {
        return await handler(data, request);
      } catch (e) {
        if (e instanceof HttpsError) throw e;
        if (e instanceof ProviderError) {
          throw new HttpsError(e.category === 'AUTH' ? 'unauthenticated' : e.category === 'VALIDATION' ? 'invalid-argument' : 'failed-precondition', e.message, {
            code: e.code,
            category: e.category,
          });
        }
        log.error('Unhandled callable error', { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
        throw new HttpsError('internal', 'Unexpected server error');
      }
    },
  );
}

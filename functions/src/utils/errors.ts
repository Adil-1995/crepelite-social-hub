import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https';
import { ZodError, type ZodType } from 'zod';

export function fail(code: FunctionsErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new HttpsError(code, message, details);
}

/** Parses a callable payload with a shared schema; the backend never trusts client validation. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof ZodError) {
      fail('invalid-argument', 'Invalid request', {
        issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw e;
  }
}

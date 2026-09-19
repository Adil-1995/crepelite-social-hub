import { defineSecret } from 'firebase-functions/params';

/**
 * Runtime configuration.
 *
 * - Non-secret values come from functions/.env.<projectAlias> (committed templates
 *   in functions/.env.example) or the process environment.
 * - Secrets live in Google Secret Manager (`firebase functions:secrets:set NAME`)
 *   and are bound to the functions that need them. In the emulator they are read
 *   from functions/.secret.local.
 *
 * APP_ENV defaults to "production" unless running in the emulator, so a
 * misconfigured deploy can never enable development-only features (MockProvider).
 */
export type AppEnv = 'development' | 'staging' | 'production';

export function appEnv(): AppEnv {
  const v = process.env.APP_ENV;
  if (v === 'development' || v === 'staging' || v === 'production') return v;
  return process.env.FUNCTIONS_EMULATOR === 'true' ? 'development' : 'production';
}

export const isEmulator = (): boolean => process.env.FUNCTIONS_EMULATOR === 'true';
export const isProduction = (): boolean => appEnv() === 'production';
/** The MockProvider is only ever available outside production. */
export const mockProviderEnabled = (): boolean => !isProduction() && process.env.ENABLE_MOCK_PROVIDER !== 'false';

export function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const REGION = env('FUNCTIONS_REGION', 'europe-west1');

// Secrets (values never logged, never sent to clients)
export const META_APP_SECRET = defineSecret('META_APP_SECRET');
export const TIKTOK_CLIENT_SECRET = defineSecret('TIKTOK_CLIENT_SECRET');
export const PINTEREST_CLIENT_SECRET = defineSecret('PINTEREST_CLIENT_SECRET');
export const GOOGLE_OAUTH_CLIENT_SECRET = defineSecret('GOOGLE_OAUTH_CLIENT_SECRET');
/** HMAC key for short-lived media pull URLs and OAuth state binding. */
export const APP_SIGNING_KEY = defineSecret('APP_SIGNING_KEY');
/** Only used when KMS_KEY_NAME is empty (emulator / development). */
export const TOKEN_ENCRYPTION_KEY = defineSecret('TOKEN_ENCRYPTION_KEY');

export const PROVIDER_SECRETS = [META_APP_SECRET, TIKTOK_CLIENT_SECRET, PINTEREST_CLIENT_SECRET, GOOGLE_OAUTH_CLIENT_SECRET];
export const CORE_SECRETS = [APP_SIGNING_KEY, TOKEN_ENCRYPTION_KEY];
export const ALL_SECRETS = [...PROVIDER_SECRETS, ...CORE_SECRETS];

/** Reads a secret safely: returns '' when unset or when the placeholder "unset" is stored. */
export function secretValue(secret: { value(): string; name: string }): string {
  try {
    const v = secret.value() || process.env[secret.name] || '';
    return v === 'unset' ? '' : v;
  } catch {
    const v = process.env[secret.name] ?? '';
    return v === 'unset' ? '' : v;
  }
}

export const config = {
  appBaseUrl: () => env('APP_BASE_URL', 'http://localhost:5173'),
  /** Public base URL of the HTTP functions (oauth callback, webhooks, media pull). */
  apiBaseUrl: () => env('API_BASE_URL', ''),
  kmsKeyName: () => env('KMS_KEY_NAME'),
  tasksLocation: () => env('TASKS_LOCATION', REGION),
  workerUrl: () => env('WORKER_URL'),
  workerServiceAccount: () => env('WORKER_INVOKER_SERVICE_ACCOUNT'),
  workerQueue: () => env('WORKER_QUEUE', 'publisher-worker'),
  mediaBucket: () => env('MEDIA_BUCKET'),
  /** Verified URL prefix (TikTok PULL_FROM_URL) served by the mediaPull function via Hosting. */
  mediaPullBaseUrl: () => env('MEDIA_PULL_BASE_URL'),
  meta: {
    appId: () => env('META_APP_ID'),
    loginConfigId: () => env('META_LOGIN_CONFIG_ID'),
    graphVersion: () => env('META_GRAPH_VERSION', 'v26.0'),
  },
  tiktok: {
    clientKey: () => env('TIKTOK_CLIENT_KEY'),
    /** Set to "true" only after TikTok approved the app for public Direct Post. */
    audited: () => env('TIKTOK_APP_AUDITED') === 'true',
  },
  pinterest: {
    appId: () => env('PINTEREST_APP_ID'),
    /** Use https://api-sandbox.pinterest.com while the app only has Trial access. */
    apiBase: () => env('PINTEREST_API_BASE', 'https://api.pinterest.com'),
  },
  google: {
    clientId: () => env('GOOGLE_OAUTH_CLIENT_ID'),
    /** Set to "true" once the Google API project passed the YouTube API audit (otherwise uploads are forced private). */
    youtubeAudited: () => env('YOUTUBE_API_AUDITED') === 'true',
  },
};

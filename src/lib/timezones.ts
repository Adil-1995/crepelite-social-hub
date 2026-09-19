import { DEFAULT_TIMEZONE } from '@shared/index';

export interface TimezoneOption {
  label: string;
  value: string;
}

/**
 * IANA zones for the workspace timezone picker.
 *
 * `Intl.supportedValuesOf` gives the full, current list from the runtime, so
 * the app never ships a stale hardcoded table. A small fallback covers older
 * engines that lack the API.
 */
const FALLBACK = [
  'Africa/Casablanca',
  'Africa/Cairo',
  'Africa/Lagos',
  'America/Chicago',
  'America/Los_Angeles',
  'America/New_York',
  'America/Sao_Paulo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/Berlin',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Paris',
  'UTC',
];

function listZones(): string[] {
  try {
    const supported = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const zones = supported ? supported('timeZone') : [];
    return zones.length ? zones : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

export const timezoneOptions: TimezoneOption[] = (() => {
  const zones = listZones();
  const withDefault = zones.includes(DEFAULT_TIMEZONE) ? zones : [DEFAULT_TIMEZONE, ...zones];
  return withDefault
    .map((value) => ({ value, label: value.replace(/_/g, ' ') }))
    .sort((a, b) => a.label.localeCompare(b.label));
})();

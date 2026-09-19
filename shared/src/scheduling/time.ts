import { DateTime, IANAZone } from 'luxon';

export const DEFAULT_TIMEZONE = 'Africa/Casablanca';

export function isValidTimeZone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

export interface LocalToUtcResult {
  utc: Date;
  /** The wall-clock time did not exist (DST gap) and was shifted forward. */
  shifted: boolean;
  /** The wall-clock time happened twice (DST overlap); the earlier instant is used. */
  ambiguous: boolean;
  /** Normalised local time actually used (HH:mm). */
  effectiveLocalTime: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Converts a wall-clock date/time in an IANA zone to a UTC instant.
 * Never store local strings — persist `utc` plus the zone.
 */
export function localToUtc(date: string, time: string, zone: string): LocalToUtcResult {
  if (!DATE_RE.test(date)) throw new RangeError(`Invalid date "${date}" (expected yyyy-MM-dd)`);
  if (!TIME_RE.test(time)) throw new RangeError(`Invalid time "${time}" (expected HH:mm)`);
  if (!isValidTimeZone(zone)) throw new RangeError(`Invalid IANA timezone "${zone}"`);

  const dt = DateTime.fromISO(`${date}T${time}`, { zone });
  if (!dt.isValid) throw new RangeError(`Invalid local date/time ${date} ${time} in ${zone}`);

  const effectiveLocalTime = dt.toFormat('HH:mm');
  const shifted = effectiveLocalTime !== time || dt.toFormat('yyyy-MM-dd') !== date;

  // Ambiguity: the same wall time maps to two instants when an hour repeats.
  const possible = dt.getPossibleOffsets();
  const ambiguous = possible.length > 1;
  const chosen = ambiguous
    ? possible.reduce((earliest, candidate) => (candidate.toMillis() < earliest.toMillis() ? candidate : earliest))
    : dt;

  return { utc: chosen.toUTC().toJSDate(), shifted, ambiguous, effectiveLocalTime };
}

export interface LocalParts {
  date: string; // yyyy-MM-dd
  time: string; // HH:mm
  weekday: number; // 1 = Monday … 7 = Sunday
  offset: string; // e.g. +01:00
}

export function utcToLocalParts(instant: Date | number, zone: string): LocalParts {
  const dt = DateTime.fromMillis(typeof instant === 'number' ? instant : instant.getTime(), { zone });
  return { date: dt.toFormat('yyyy-MM-dd'), time: dt.toFormat('HH:mm'), weekday: dt.weekday, offset: dt.toFormat('ZZ') };
}

export function formatInZone(instant: Date | number, zone: string, format = 'dd LLL yyyy, HH:mm', locale = 'en'): string {
  const ms = typeof instant === 'number' ? instant : instant.getTime();
  return DateTime.fromMillis(ms, { zone }).setLocale(locale).toFormat(format);
}

/** Adds calendar days in a zone (DST-safe: keeps wall-clock time). */
export function addLocalDays(date: string, days: number, zone: string): string {
  return DateTime.fromISO(date, { zone }).plus({ days }).toFormat('yyyy-MM-dd');
}

export function localDateRange(from: string, to: string, zone: string): string[] {
  const start = DateTime.fromISO(from, { zone });
  const end = DateTime.fromISO(to, { zone });
  if (!start.isValid || !end.isValid) throw new RangeError('Invalid date range');
  if (end < start) return [];
  const out: string[] = [];
  for (let d = start; d <= end; d = d.plus({ days: 1 })) out.push(d.toFormat('yyyy-MM-dd'));
  return out;
}

export function weekdayOf(date: string, zone: string): number {
  return DateTime.fromISO(date, { zone }).weekday;
}

/** Start/end (UTC ms) of a local day — used for "today" dashboards and calendar queries. */
export function localDayBounds(date: string, zone: string): { start: number; end: number } {
  const start = DateTime.fromISO(date, { zone }).startOf('day');
  return { start: start.toMillis(), end: start.plus({ days: 1 }).toMillis() };
}

export function todayInZone(zone: string, now: Date = new Date()): string {
  return DateTime.fromJSDate(now, { zone }).toFormat('yyyy-MM-dd');
}

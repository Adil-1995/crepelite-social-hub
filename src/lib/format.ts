import { DateTime } from 'luxon';
import type { Ts } from '@shared/index';

/** Firestore Timestamp | millis | Date | null → millis | null. */
export function toMillis(v: Ts | number | Date | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof (v as Ts).toMillis === 'function') return (v as Ts).toMillis();
  // Firestore REST/emulator shape
  const s = (v as { seconds?: number }).seconds;
  return typeof s === 'number' ? s * 1000 : null;
}

export function formatDateTime(v: Ts | number | Date | null | undefined, zone: string): string {
  const ms = toMillis(v);
  return ms == null ? '—' : DateTime.fromMillis(ms, { zone }).toFormat('d LLL yyyy, HH:mm');
}

export function formatTime(v: Ts | number | Date | null | undefined, zone: string): string {
  const ms = toMillis(v);
  return ms == null ? '—' : DateTime.fromMillis(ms, { zone }).toFormat('HH:mm');
}

export function formatDate(v: Ts | number | Date | null | undefined, zone: string): string {
  const ms = toMillis(v);
  return ms == null ? '—' : DateTime.fromMillis(ms, { zone }).toFormat('d LLL yyyy');
}

/** "in 3 hours" / "2 days ago". */
export function formatRelative(v: Ts | number | Date | null | undefined, zone: string): string {
  const ms = toMillis(v);
  return ms == null ? '—' : (DateTime.fromMillis(ms, { zone }).toRelative() ?? '—');
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const n = bytes / 1024 ** i;
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Local `yyyy-MM-dd` + `HH:mm` for a given zone, used by the date inputs. */
export function splitLocal(v: Ts | number | Date | null | undefined, zone: string): { date: string; time: string } | null {
  const ms = toMillis(v);
  if (ms == null) return null;
  const dt = DateTime.fromMillis(ms, { zone });
  return { date: dt.toFormat('yyyy-MM-dd'), time: dt.toFormat('HH:mm') };
}

/** A JS Date positioned so that a PrimeVue DatePicker shows the workspace-local time. */
export function toPickerDate(v: Ts | number | Date | null | undefined, zone: string): Date | null {
  const ms = toMillis(v);
  if (ms == null) return null;
  const p = DateTime.fromMillis(ms, { zone });
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
}

/** Inverse of `toPickerDate`: reads the picker's wall-clock as workspace-local time. */
export function fromPickerDate(d: Date | null | undefined, zone: string): number | null {
  if (!d) return null;
  return DateTime.fromObject(
    { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() },
    { zone },
  ).toMillis();
}

export function initials(name: string | null | undefined, fallback = '?'): string {
  const n = (name ?? '').trim();
  if (!n) return fallback;
  const parts = n.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || fallback;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDuration,
  formatTime,
  fromPickerDate,
  initials,
  splitLocal,
  toMillis,
  toPickerDate,
  truncate,
} from '@/lib/format';

const TZ = 'Africa/Casablanca';
const INSTANT = DateTime.fromISO('2026-10-05T14:30:00', { zone: TZ }).toMillis();

/** Stand-in for a Firestore Timestamp, which is all the formatters need. */
const ts = (ms: number) => ({
  seconds: Math.floor(ms / 1000),
  nanoseconds: 0,
  toMillis: () => ms,
  toDate: () => new Date(ms),
});

describe('toMillis', () => {
  it('accepts every shape the app receives', () => {
    expect(toMillis(INSTANT)).toBe(INSTANT);
    expect(toMillis(new Date(INSTANT))).toBe(INSTANT);
    expect(toMillis(ts(INSTANT))).toBe(INSTANT);
  });

  it('handles the plain {seconds} shape the emulator can return', () => {
    expect(toMillis({ seconds: 1000 } as never)).toBe(1_000_000);
  });

  it('returns null for nothing', () => {
    expect(toMillis(null)).toBeNull();
    expect(toMillis(undefined)).toBeNull();
  });
});

describe('date formatting', () => {
  it('renders in the workspace timezone, not the browser one', () => {
    expect(formatTime(INSTANT, TZ)).toBe('14:30');
    expect(formatTime(INSTANT, 'Asia/Tokyo')).not.toBe('14:30');
  });

  it('formats dates and datetimes', () => {
    expect(formatDate(INSTANT, TZ)).toBe('5 Oct 2026');
    expect(formatDateTime(INSTANT, TZ)).toBe('5 Oct 2026, 14:30');
  });

  it('shows an em dash rather than "Invalid Date" for missing values', () => {
    expect(formatDateTime(null, TZ)).toBe('—');
    expect(formatDate(undefined, TZ)).toBe('—');
    expect(formatTime(null, TZ)).toBe('—');
  });
});

describe('picker round-trip', () => {
  it('returns the same instant it was given', () => {
    const picker = toPickerDate(INSTANT, TZ);
    expect(picker).toBeInstanceOf(Date);
    expect(fromPickerDate(picker, TZ)).toBe(INSTANT);
  });

  it('interprets the picker wall-clock in the workspace zone', () => {
    // The picker has no timezone: 14:30 in it must mean 14:30 in the workspace,
    // whatever the browser's own zone is.
    const picker = new Date(2026, 9, 5, 14, 30, 0, 0);
    const ms = fromPickerDate(picker, TZ)!;
    expect(DateTime.fromMillis(ms, { zone: TZ }).toFormat('yyyy-MM-dd HH:mm')).toBe('2026-10-05 14:30');
  });

  it('handles nothing', () => {
    expect(toPickerDate(null, TZ)).toBeNull();
    expect(fromPickerDate(null, TZ)).toBeNull();
  });
});

describe('splitLocal', () => {
  it('splits into the yyyy-MM-dd and HH:mm the API expects', () => {
    expect(splitLocal(INSTANT, TZ)).toEqual({ date: '2026-10-05', time: '14:30' });
  });

  it('returns null for nothing', () => {
    expect(splitLocal(null, TZ)).toBeNull();
  });
});

describe('formatBytes', () => {
  it('scales through the units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB');
  });

  it('drops the decimal once the number is big enough to not need it', () => {
    expect(formatBytes(15 * 1024)).toBe('15 KB');
  });

  it('does not produce NaN for rubbish input', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
  });
});

describe('formatDuration', () => {
  it('renders m:ss', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3)).toBe('0:03');
    expect(formatDuration(600)).toBe('10:00');
  });

  it('returns an empty string for nothing', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(undefined)).toBe('');
  });
});

describe('initials', () => {
  it('takes at most two initials', () => {
    expect(initials('Adil Chair')).toBe('AC');
    expect(initials('Adil Something Chair')).toBe('AS');
    expect(initials('Adil')).toBe('A');
  });

  it('falls back when there is no name', () => {
    expect(initials(null)).toBe('?');
    expect(initials('   ')).toBe('?');
    expect(initials(undefined, 'X')).toBe('X');
  });
});

describe('truncate', () => {
  it('leaves short strings alone', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('adds an ellipsis and never exceeds the limit', () => {
    const out = truncate('abcdefghij', 5);
    expect(out).toBe('abcd…');
    expect(out.length).toBe(5);
  });
});

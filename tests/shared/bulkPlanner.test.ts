import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { planBulkSchedule, planDays, seededRandom, type BulkPlanInput } from '@shared/index';

const TZ = 'Africa/Casablanca';

function base(overrides: Partial<BulkPlanInput> = {}): BulkPlanInput {
  return {
    itemIds: [],
    from: '2026-10-01',
    to: '2026-10-30',
    timezone: TZ,
    times: ['10:00'],
    frequency: { type: 'daily' },
    distribution: 'sequential',
    ...overrides,
  };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `item-${i + 1}`);

describe('planDays', () => {
  it('returns every day for a daily frequency', () => {
    const days = planDays({ from: '2026-10-01', to: '2026-10-30', timezone: TZ, frequency: { type: 'daily' } });
    expect(days).toHaveLength(30);
    expect(days[0]).toBe('2026-10-01');
    expect(days.at(-1)).toBe('2026-10-30');
  });

  it('filters to the selected weekdays', () => {
    const days = planDays({
      from: '2026-10-01',
      to: '2026-10-31',
      timezone: TZ,
      frequency: { type: 'weekdays', weekdays: [6, 7] },
    });
    for (const d of days) {
      const weekday = DateTime.fromISO(d, { zone: TZ }).weekday;
      expect([6, 7]).toContain(weekday);
    }
  });

  it('honours an N-day interval', () => {
    const days = planDays({
      from: '2026-10-01',
      to: '2026-10-10',
      timezone: TZ,
      frequency: { type: 'interval', everyNDays: 3 },
    });
    expect(days).toEqual(['2026-10-01', '2026-10-04', '2026-10-07', '2026-10-10']);
  });
});

describe('planBulkSchedule', () => {
  it('schedules 30 posts one per day across October', () => {
    const result = planBulkSchedule(base({ itemIds: ids(30) }));

    expect(result.entries).toHaveLength(30);
    expect(result.unassignedItemIds).toEqual([]);

    // Exactly one per calendar day, in order, at the requested local time.
    const dates = result.entries.map((e) => e.date);
    expect(new Set(dates).size).toBe(30);
    expect(dates).toEqual([...dates].sort());

    for (const entry of result.entries) {
      expect(entry.time).toBe('10:00');
      const local = DateTime.fromMillis(entry.scheduledAtMs, { zone: TZ });
      expect(local.toFormat('yyyy-MM-dd')).toBe(entry.date);
      expect(local.toFormat('HH:mm')).toBe('10:00');
    }
  });

  it('assigns items in order for the sequential distribution', () => {
    const result = planBulkSchedule(base({ itemIds: ids(5), to: '2026-10-05' }));
    expect(result.entries.map((e) => e.itemId)).toEqual(ids(5));
  });

  it('uses every slot when there are several times per day', () => {
    const result = planBulkSchedule(base({ itemIds: ids(6), to: '2026-10-03', times: ['09:00', '13:00', '19:00'] }));
    expect(result.entries).toHaveLength(6);
    expect(result.entries.filter((e) => e.date === '2026-10-01')).toHaveLength(3);
  });

  it('reports items that do not fit', () => {
    const result = planBulkSchedule(base({ itemIds: ids(5), from: '2026-10-01', to: '2026-10-02' }));
    expect(result.entries).toHaveLength(2);
    expect(result.unassignedItemIds).toHaveLength(3);
  });

  it('is reproducible for a given seed and differs across seeds', () => {
    const a = planBulkSchedule(base({ itemIds: ids(10), distribution: 'random', seed: 1234 }));
    const b = planBulkSchedule(base({ itemIds: ids(10), distribution: 'random', seed: 1234 }));
    const c = planBulkSchedule(base({ itemIds: ids(10), distribution: 'random', seed: 9999 }));

    expect(a.entries.map((e) => e.itemId)).toEqual(b.entries.map((e) => e.itemId));
    expect(a.entries.map((e) => e.itemId)).not.toEqual(c.entries.map((e) => e.itemId));
  });

  it('skips slots before notBeforeMs', () => {
    const cutoff = DateTime.fromISO('2026-10-05T12:00', { zone: TZ }).toMillis();
    const result = planBulkSchedule(base({ itemIds: ids(30), notBeforeMs: cutoff }));
    for (const entry of result.entries) {
      expect(entry.scheduledAtMs).toBeGreaterThanOrEqual(cutoff);
    }
  });

  it('produces instants that are strictly increasing', () => {
    const result = planBulkSchedule(base({ itemIds: ids(20), times: ['08:00', '20:00'] }));
    const times = result.entries.map((e) => e.scheduledAtMs);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    }
  });

  it('keeps the requested wall-clock time across a DST change', () => {
    // Europe/Madrid moves off summer time on 25 October 2026.
    const result = planBulkSchedule(
      base({ itemIds: ids(6), timezone: 'Europe/Madrid', from: '2026-10-23', to: '2026-10-28', times: ['10:00'] }),
    );
    for (const entry of result.entries) {
      const local = DateTime.fromMillis(entry.scheduledAtMs, { zone: 'Europe/Madrid' });
      expect(local.toFormat('HH:mm')).toBe('10:00');
    }
  });
});

describe('seededRandom', () => {
  it('is deterministic', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('stays within [0, 1)', () => {
    const rnd = seededRandom(7);
    for (let i = 0; i < 1000; i++) {
      const v = rnd();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

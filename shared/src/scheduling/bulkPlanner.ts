import { localDateRange, localToUtc, weekdayOf } from './time';

export type BulkFrequency =
  | { type: 'daily' }
  | { type: 'weekdays'; weekdays: number[] } // 1 = Monday … 7 = Sunday
  | { type: 'interval'; everyNDays: number };

export type BulkDistribution = 'sequential' | 'random' | 'manual';

export interface BulkPlanInput {
  itemIds: string[];
  from: string; // yyyy-MM-dd (local)
  to: string; // yyyy-MM-dd (local, inclusive)
  timezone: string;
  /** Publication slots per selected day, e.g. ["13:00","19:00"] = 2 per day. */
  times: string[];
  frequency: BulkFrequency;
  distribution: BulkDistribution;
  /** Seed for the random distribution so preview and server-side creation agree. */
  seed?: number;
  /** Manual distribution: itemId → { date, time }. */
  manual?: Record<string, { date: string; time: string }>;
  /** Slots earlier than this instant are skipped (e.g. now). */
  notBeforeMs?: number;
}

export interface BulkPlanEntry {
  itemId: string;
  date: string;
  time: string;
  scheduledAtMs: number;
  /** DST adjusted the wall-clock time (gap). */
  shifted: boolean;
  ambiguous: boolean;
}

export interface BulkPlanResult {
  entries: BulkPlanEntry[];
  totalSlots: number;
  unassignedItemIds: string[];
  warnings: string[];
}

/** Deterministic PRNG (mulberry32) so random plans are reproducible from the seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rnd: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function planDays(input: Pick<BulkPlanInput, 'from' | 'to' | 'timezone' | 'frequency'>): string[] {
  const days = localDateRange(input.from, input.to, input.timezone);
  const f = input.frequency;
  switch (f.type) {
    case 'daily':
      return days;
    case 'weekdays': {
      const set = new Set(f.weekdays);
      return days.filter((d) => set.has(weekdayOf(d, input.timezone)));
    }
    case 'interval': {
      const n = Math.max(1, Math.floor(f.everyNDays));
      return days.filter((_, i) => i % n === 0);
    }
  }
}

export function planBulkSchedule(input: BulkPlanInput): BulkPlanResult {
  const warnings: string[] = [];
  const times = [...new Set(input.times)].sort();
  if (times.length === 0) throw new RangeError('At least one publication time is required');
  if (input.itemIds.length === 0) return { entries: [], totalSlots: 0, unassignedItemIds: [], warnings };

  if (input.distribution === 'manual') {
    const entries: BulkPlanEntry[] = [];
    const unassigned: string[] = [];
    for (const id of input.itemIds) {
      const slot = input.manual?.[id];
      if (!slot) {
        unassigned.push(id);
        continue;
      }
      const r = localToUtc(slot.date, slot.time, input.timezone);
      entries.push({ itemId: id, date: slot.date, time: r.effectiveLocalTime, scheduledAtMs: r.utc.getTime(), shifted: r.shifted, ambiguous: r.ambiguous });
    }
    entries.sort((a, b) => a.scheduledAtMs - b.scheduledAtMs);
    return { entries, totalSlots: entries.length, unassignedItemIds: unassigned, warnings };
  }

  const slots: Omit<BulkPlanEntry, 'itemId'>[] = [];
  for (const date of planDays(input)) {
    for (const time of times) {
      const r = localToUtc(date, time, input.timezone);
      if (input.notBeforeMs != null && r.utc.getTime() < input.notBeforeMs) continue;
      slots.push({ date, time: r.effectiveLocalTime, scheduledAtMs: r.utc.getTime(), shifted: r.shifted, ambiguous: r.ambiguous });
      if (r.shifted) warnings.push(`${date} ${time} does not exist in ${input.timezone} (DST); moved to ${r.effectiveLocalTime}.`);
    }
  }
  slots.sort((a, b) => a.scheduledAtMs - b.scheduledAtMs);

  const items = input.distribution === 'random' ? shuffle(input.itemIds, seededRandom(input.seed ?? 1)) : [...input.itemIds];
  const count = Math.min(items.length, slots.length);
  const entries: BulkPlanEntry[] = [];
  for (let i = 0; i < count; i++) entries.push({ itemId: items[i] as string, ...(slots[i] as Omit<BulkPlanEntry, 'itemId'>) });

  const unassignedItemIds = items.slice(count);
  if (unassignedItemIds.length > 0) {
    warnings.push(`Only ${slots.length} slots available for ${items.length} contents. Extend the date range, add times or increase frequency.`);
  }
  return { entries, totalSlots: slots.length, unassignedItemIds, warnings };
}

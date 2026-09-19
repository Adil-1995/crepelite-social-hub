import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STATUSES,
  DELIVERY_TRANSITIONS,
  IllegalTransitionError,
  assertTransition,
  canTransition,
  derivePostStatus,
  isEditableDelivery,
  type DeliveryStatus,
} from '@shared/index';

describe('delivery state machine', () => {
  it('declares a transition list for every status', () => {
    for (const status of DELIVERY_STATUSES) {
      expect(DELIVERY_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('treats published as terminal', () => {
    expect(DELIVERY_TRANSITIONS.published).toEqual([]);
    for (const to of DELIVERY_STATUSES) {
      expect(canTransition('published', to)).toBe(false);
    }
  });

  it('throws on an illegal jump', () => {
    expect(() => assertTransition('published', 'queued')).toThrow(IllegalTransitionError);
    expect(() => assertTransition('draft', 'published')).toThrow(IllegalTransitionError);
  });

  it('allows the normal publishing path', () => {
    expect(canTransition('draft', 'queued')).toBe(true);
    expect(canTransition('queued', 'publishing')).toBe(true);
    expect(canTransition('publishing', 'published')).toBe(true);
    expect(canTransition('publishing', 'processing')).toBe(true);
    expect(canTransition('processing', 'published')).toBe(true);
  });

  it('allows a failed delivery to be retried but not a published one', () => {
    expect(canTransition('failed', 'queued')).toBe(true);
    expect(canTransition('published', 'queued')).toBe(false);
  });

  it('blocks editing while a provider call may be in flight', () => {
    expect(isEditableDelivery('publishing')).toBe(false);
    expect(isEditableDelivery('processing')).toBe(false);
    expect(isEditableDelivery('published')).toBe(false);
    expect(isEditableDelivery('queued')).toBe(true);
    expect(isEditableDelivery('failed')).toBe(true);
  });
});

describe('derivePostStatus', () => {
  const cases: Array<[string, DeliveryStatus[], string]> = [
    ['no deliveries', [], 'draft'],
    ['all drafts', ['draft', 'draft'], 'draft'],
    ['all cancelled', ['cancelled', 'cancelled'], 'cancelled'],
    ['all queued', ['queued', 'queued'], 'scheduled'],
    ['awaiting queue', ['awaiting_queue'], 'scheduled'],
    ['one in flight', ['publishing', 'queued'], 'publishing'],
    ['processing counts as in flight', ['processing', 'published'], 'publishing'],
    ['all published', ['published', 'published'], 'published'],
    ['all failed', ['failed', 'failed'], 'failed'],
    ['needs_reauth counts as failed', ['needs_reauth'], 'failed'],
    ['mixed success and failure', ['published', 'failed'], 'partially_published'],
    ['published plus needs_reauth', ['published', 'needs_reauth'], 'partially_published'],
    ['cancelled is ignored beside a success', ['published', 'cancelled'], 'published'],
  ];

  it.each(cases)('%s → %s', (_label, statuses, expected) => {
    expect(derivePostStatus(statuses)).toBe(expected);
  });

  it('reports publishing, not scheduled, once some destinations are already out', () => {
    // A partially-delivered post is still working, so the user sees progress
    // rather than a status that suggests nothing has happened.
    expect(derivePostStatus(['published', 'queued'])).toBe('publishing');
  });
});

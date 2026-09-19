import { describe, expect, it } from 'vitest';
import { ProviderError, toProviderError } from '../../functions/src/providers/errors';
import { ERROR_CATEGORIES, type ErrorCategory } from '@shared/index';

/**
 * Error classification decides whether a failed delivery is retried
 * automatically. Getting it wrong either spams a provider with doomed retries
 * or silently strands a recoverable failure, so the categories are pinned here.
 */
describe('ProviderError', () => {
  it('carries a category from the shared list', () => {
    const err = new ProviderError({ code: 'x', message: 'boom', category: 'NETWORK', retryable: true });
    expect(ERROR_CATEGORIES).toContain(err.category);
  });

  it('keeps the retryable flag it was given', () => {
    expect(new ProviderError({ code: 'x', message: 'm', category: 'NETWORK', retryable: true }).retryable).toBe(true);
    expect(new ProviderError({ code: 'x', message: 'm', category: 'VALIDATION', retryable: false }).retryable).toBe(false);
  });

  it('is a real Error, so stack traces and instanceof work', () => {
    const err = new ProviderError({ code: 'x', message: 'boom', category: 'UNKNOWN', retryable: false });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('boom');
  });
});

describe('toProviderError', () => {
  it('passes a ProviderError straight through', () => {
    const original = new ProviderError({ code: 'a', message: 'm', category: 'RATE_LIMIT', retryable: true });
    expect(toProviderError(original)).toBe(original);
  });

  it('wraps an unknown throw without losing the message', () => {
    const err = toProviderError(new Error('something odd'));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('something odd');
  });

  it('survives non-Error throws', () => {
    for (const thrown of ['a string', 42, null, undefined, { weird: true }]) {
      const err = toProviderError(thrown);
      expect(err).toBeInstanceOf(ProviderError);
      expect(typeof err.message).toBe('string');
      expect(ERROR_CATEGORIES).toContain(err.category as ErrorCategory);
    }
  });

  it('defaults an unclassified failure to a non-retryable UNKNOWN', () => {
    // An unrecognised error must not be retried blindly: a blind retry on an
    // unknown outcome is exactly how a post gets published twice.
    const err = toProviderError(new Error('mystery'));
    expect(err.category).toBe('UNKNOWN');
    expect(err.retryable).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { formatDate, sentenceCase, shortId } from './format';

describe('ticket display formatting', () => {
  it('turns API status values into readable labels', () => {
    expect(sentenceCase('awaiting_customer')).toBe('Awaiting customer');
  });

  it('uses only the first eight characters for the public ticket label', () => {
    expect(shortId('22222222-2222-4222-8222-222222222222')).toBe('22222222');
  });

  it('formats valid timestamps for the current locale', () => {
    expect(formatDate('2026-08-11T12:30:00Z')).toMatch(/2026/);
  });
});

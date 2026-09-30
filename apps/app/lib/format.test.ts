import { describe, expect, it } from 'vitest';
import { shortAddress, untilText } from './format';

describe('format', () => {
  it('shortens addresses', () => {
    expect(shortAddress('713NQALYzFN2zVSJ1ERqhSFiQTMqVnFyCVybYdn3r9Gj')).toBe('713N…r9Gj');
    expect(shortAddress('short')).toBe('short');
  });
  it('describes time left', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(untilText('2026-01-01T05:00:00Z', now)).toBe('in 5 hours');
    expect(untilText('2026-01-05T00:00:00Z', now)).toBe('in 4 days');
    expect(untilText('2025-12-31T00:00:00Z', now)).toBe('now');
  });
});

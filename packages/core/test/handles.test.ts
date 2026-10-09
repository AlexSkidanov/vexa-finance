import { describe, expect, it } from 'vitest';
import { formatHandle, isReservedHandle, normalizeHandle, validateHandle } from '../src/handles.js';

describe('handles', () => {
  it('normalizes every accepted spelling to the bare name', () => {
    for (const input of ['alex', '@alex', 'alex.vexa', '@Alex.VEXA', '  alex  ']) {
      expect(normalizeHandle(input)).toBe('alex');
    }
  });

  it('formats for display', () => {
    expect(formatHandle('alex')).toBe('@alex.vexa');
  });

  it.each([
    ['al', 'too_short'],
    ['a'.repeat(21), 'too_long'],
    ['-alex', 'invalid_characters'],
    ['alex_', 'invalid_characters'],
    ['al ex', 'invalid_characters'],
    ['álex', 'invalid_characters'],
    ['al--ex', 'repeated_separators'],
    ['support', 'reserved'],
    ['sup_port', 'reserved'],
    ['vexa_help', 'reserved'],
    ['admin', 'reserved'],
  ])('rejects %s (%s)', (input, reason) => {
    expect(validateHandle(input)).toEqual({ ok: false, reason });
  });

  it.each(['alex', 'alex-b', 'a_1', 'satoshi21', 'abc'])('accepts %s', (input) => {
    expect(validateHandle(input)).toEqual({ ok: true, handle: input });
  });

  it('treats vexa-prefixed and -suffixed names as reserved', () => {
    expect(isReservedHandle('vexateam')).toBe(true);
    expect(isReservedHandle('payvexa')).toBe(true);
    expect(isReservedHandle('alex')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { classifyRecipient, handleProblem } from './handles';

describe('handleProblem', () => {
  it('accepts valid handles in any accepted form', () => {
    expect(handleProblem('alex')).toBeNull();
    expect(handleProblem('@Alex.vexa')).toBeNull();
    expect(handleProblem('a_b-c9')).toBeNull();
  });
  it('explains what is wrong', () => {
    expect(handleProblem('ab')).toMatch(/At least 3/);
    expect(handleProblem('a'.repeat(21))).toMatch(/At most 20/);
    expect(handleProblem('-alex')).toMatch(/Lowercase letters/);
    expect(handleProblem('al__ex')).toMatch(/in a row/);
    expect(handleProblem('support')).toMatch(/reserved/);
    expect(handleProblem('vexa_help')).toMatch(/reserved/);
  });
});

describe('classifyRecipient', () => {
  it('normalizes handles', () => {
    expect(classifyRecipient(' @Alice ')).toEqual({
      kind: 'handle',
      handle: 'alice',
      display: '@alice.vexa',
    });
  });
  it('spots Solana addresses', () => {
    const addr = '713NQALYzFN2zVSJ1ERqhSFiQTMqVnFyCVybYdn3r9Gj';
    expect(classifyRecipient(addr)).toEqual({ kind: 'address', address: addr });
  });
  it('reports empty and invalid input', () => {
    expect(classifyRecipient('  ')).toEqual({ kind: 'empty' });
    expect(classifyRecipient('a!')).toMatchObject({ kind: 'invalid' });
  });
});

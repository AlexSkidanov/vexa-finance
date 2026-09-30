import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode } from '@vexa/core';
import { createNearClient, encodeTransaction, signTransaction, TGAS } from '../src/near/client.js';

const seed = new Uint8Array(32).fill(7);
const publicKey = ed25519.getPublicKey(seed);
const privateKey = `ed25519:${base58Encode(new Uint8Array([...seed, ...publicKey]))}`;

describe('NEAR transactions', () => {
  it('borsh-encodes a function call the way nearcore expects', () => {
    const encoded = encodeTransaction({
      signerId: 'relayer.near',
      publicKey,
      nonce: 5n,
      receiverId: 'policy.near',
      blockHash: new Uint8Array(32).fill(1),
      actions: [
        {
          functionCall: {
            method: 'm',
            args: Uint8Array.of(123, 125),
            gas: 30n * TGAS,
            deposit: 1n,
          },
        },
      ],
    });
    const view = new DataView(encoded.buffer);
    let at = 0;
    const str = () => {
      const n = view.getUint32(at, true);
      const s = new TextDecoder().decode(encoded.subarray(at + 4, at + 4 + n));
      at += 4 + n;
      return s;
    };
    expect(str()).toBe('relayer.near');
    expect(encoded[at]).toBe(0); // ed25519 key type
    expect([...encoded.subarray(at + 1, at + 33)]).toEqual([...publicKey]);
    at += 33;
    expect(view.getBigUint64(at, true)).toBe(5n);
    at += 8;
    expect(str()).toBe('policy.near');
    at += 32; // block hash
    expect(view.getUint32(at, true)).toBe(1); // one action
    at += 4;
    expect(encoded[at]).toBe(2); // FunctionCall
    at += 1;
    expect(str()).toBe('m');
    expect(view.getUint32(at, true)).toBe(2);
    at += 4 + 2;
    expect(view.getBigUint64(at, true)).toBe(30n * TGAS);
    expect(view.getBigUint64(at + 8, true)).toBe(1n); // deposit, u128 low half
    expect(view.getBigUint64(at + 16, true)).toBe(0n);
    expect(at + 24).toBe(encoded.length);

    const signed = signTransaction(encoded, seed);
    expect(signed.length).toBe(encoded.length + 65);
    expect(ed25519.verify(signed.subarray(encoded.length + 1), sha256(encoded), publicKey)).toBe(
      true,
    );
  });

  it('surfaces contract panics by their code and waits out RPC timeouts', async () => {
    const calls: string[] = [];
    const fetch = (async (_: string, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string) as { method: string };
      calls.push(method);
      const reply = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 'vexa', result }));
      if (method === 'query')
        return reply({ nonce: 1, block_hash: base58Encode(new Uint8Array(32).fill(2)) });
      if (method === 'send_tx')
        return new Response(
          JSON.stringify({ error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } }),
        );
      return reply({
        transaction: { hash: 'h' },
        status: {
          Failure: {
            ActionError: {
              kind: {
                FunctionCallError: {
                  ExecutionError:
                    'Smart contract panicked: AGENT_PAUSED: the owner has paused this agent',
                },
              },
            },
          },
        },
      });
    }) as unknown as typeof globalThis.fetch;
    const near = createNearClient({
      rpcUrl: 'http://near',
      accountId: 'relayer.near',
      privateKey,
      fetch,
    });
    const call = near.call('policy.near', 'request_signature', {});
    // The client polls `tx` every 5 s after a timeout; don't wait in real time.
    await expect(
      Promise.race([call, new Promise((r) => setTimeout(r, 6_000))]),
    ).rejects.toMatchObject({
      message: 'AGENT_PAUSED: the owner has paused this agent',
    });
    expect(calls).toEqual(['query', 'send_tx', 'tx']);
  }, 10_000);
});

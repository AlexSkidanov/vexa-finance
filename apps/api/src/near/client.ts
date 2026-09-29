/**
 * A small NEAR JSON-RPC client: view calls, and function calls signed by the
 * Vexa relayer account. Transactions are borsh-encoded here (the layout is
 * stable and short); see https://nomicon.io/RuntimeSpec/Transactions.
 *
 * The relayer pays gas and storage for everything Vexa does on NEAR. Calls
 * wait for the final outcome, including callbacks: a policy contract call
 * that asks the MPC network to sign only resolves when the signature is back.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode, base58Encode, base64Decode, base64Encode } from '@vexa/core';

export const TGAS = 1_000_000_000_000n;
export const NEAR = 10n ** 24n;

export class NearError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'NearError';
  }
}

export interface NearCallResult<T = unknown> {
  value: T;
  txHash: string;
}

export interface NearClient {
  accountId: string;
  view<T>(contract: string, method: string, args?: object): Promise<T>;
  call<T>(
    contract: string,
    method: string,
    args: object,
    opts?: { gas?: bigint; deposit?: bigint },
  ): Promise<NearCallResult<T>>;
  deploy(code: Uint8Array): Promise<string>;
}

// ---------------------------------------------------------------------------
// Borsh
// ---------------------------------------------------------------------------

class Writer {
  private parts: Uint8Array[] = [];
  bytes(b: Uint8Array) {
    this.parts.push(b);
    return this;
  }
  u8(n: number) {
    return this.bytes(Uint8Array.of(n));
  }
  u32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return this.bytes(b);
  }
  u64(n: bigint) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return this.bytes(b);
  }
  u128(n: bigint) {
    return this.u64(n & ((1n << 64n) - 1n)).u64(n >> 64n);
  }
  string(s: string) {
    const b = new TextEncoder().encode(s);
    return this.u32(b.length).bytes(b);
  }
  vec(b: Uint8Array) {
    return this.u32(b.length).bytes(b);
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

export type NearAction =
  | { functionCall: { method: string; args: Uint8Array; gas: bigint; deposit: bigint } }
  | { deployContract: { code: Uint8Array } };

/** borsh(Transaction). Action variants: 1 DeployContract, 2 FunctionCall. */
export function encodeTransaction(tx: {
  signerId: string;
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  actions: NearAction[];
}): Uint8Array {
  const w = new Writer()
    .string(tx.signerId)
    .u8(0) // ed25519
    .bytes(tx.publicKey)
    .u64(tx.nonce)
    .string(tx.receiverId)
    .bytes(tx.blockHash)
    .u32(tx.actions.length);
  for (const action of tx.actions) {
    if ('functionCall' in action) {
      const f = action.functionCall;
      w.u8(2).string(f.method).vec(f.args).u64(f.gas).u128(f.deposit);
    } else {
      w.u8(1).vec(action.deployContract.code);
    }
  }
  return w.done();
}

/** borsh(SignedTransaction): the transaction, then an ed25519 signature over its SHA-256. */
export function signTransaction(encoded: Uint8Array, secretSeed: Uint8Array): Uint8Array {
  const signature = ed25519.sign(sha256(encoded), secretSeed);
  return new Writer().bytes(encoded).u8(0).bytes(signature).done();
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

interface RpcOptions {
  rpcUrl: string;
  fetch?: typeof fetch;
}

async function rpc<T>(opts: RpcOptions, method: string, params: unknown): Promise<T> {
  const res = await (opts.fetch ?? fetch)(opts.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'vexa', method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json()) as {
    result?: T;
    error?: { name?: string; cause?: { name?: string }; data?: unknown };
  };
  if (body.error) {
    const name = body.error.cause?.name ?? body.error.name ?? 'RPC_ERROR';
    throw new NearError(name, body.error);
  }
  return body.result as T;
}

interface Outcome {
  status: { SuccessValue?: string; Failure?: unknown } | string;
  transaction: { hash: string };
}

function parseOutcome<T>(outcome: Outcome): NearCallResult<T> {
  const status = outcome.status;
  if (typeof status === 'object' && status && 'Failure' in status && status.Failure) {
    // The contract's panic message, e.g. "LIMIT_PROOF_MISMATCH: ...".
    const text = JSON.stringify(status.Failure);
    const panic = /"ExecutionError":"(?:Smart contract panicked: )?([^"]+)"/.exec(text)?.[1];
    throw new NearError(panic ?? 'transaction failed', status.Failure);
  }
  const raw =
    typeof status === 'object' && status?.SuccessValue ? base64Decode(status.SuccessValue) : null;
  const text = raw && raw.length > 0 ? new TextDecoder().decode(raw) : '';
  return { value: (text ? JSON.parse(text) : null) as T, txHash: outcome.transaction.hash };
}

/**
 * `privateKey` is NEAR's `ed25519:<base58>` form: the 32-byte seed followed
 * by the 32-byte public key.
 */
export function createNearClient(
  opts: RpcOptions & { accountId: string; privateKey: string },
): NearClient {
  const secret = base58Decode(opts.privateKey.replace(/^ed25519:/, ''));
  if (!secret || secret.length !== 64)
    throw new Error('NEAR private key must be ed25519:<64 bytes base58>');
  const seed = secret.slice(0, 32);
  const publicKey = ed25519.getPublicKey(seed);
  const publicKeyString = `ed25519:${base58Encode(publicKey)}`;

  async function send(receiverId: string, actions: NearAction[]): Promise<Outcome> {
    const key = await rpc<{ nonce: number | string; block_hash: string }>(opts, 'query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: opts.accountId,
      public_key: publicKeyString,
    });
    const encoded = encodeTransaction({
      signerId: opts.accountId,
      publicKey,
      nonce: BigInt(key.nonce) + 1n,
      receiverId,
      blockHash: base58Decode(key.block_hash)!,
      actions,
    });
    const signed = base64Encode(signTransaction(encoded, seed));
    const hash = base58Encode(sha256(encoded));
    try {
      return await rpc<Outcome>(opts, 'send_tx', { signed_tx_base64: signed, wait_until: 'FINAL' });
    } catch (e) {
      // A call that waits on the MPC network can outlast the RPC's own
      // timeout. The transaction is in; keep asking for its final outcome.
      if (!(e instanceof NearError) || !/TIMEOUT/i.test(e.message)) throw e;
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((r) => setTimeout(r, 5_000));
        try {
          return await rpc<Outcome>(opts, 'tx', {
            tx_hash: hash,
            sender_account_id: opts.accountId,
            wait_until: 'FINAL',
          });
        } catch (again) {
          if (!(again instanceof NearError) || !/TIMEOUT|UNKNOWN_TRANSACTION/i.test(again.message))
            throw again;
        }
      }
      throw new NearError('timed out waiting for the NEAR transaction', { hash });
    }
  }

  return {
    accountId: opts.accountId,

    async view<T>(contract: string, method: string, args: object = {}) {
      const result = await rpc<{ result: number[] }>(opts, 'query', {
        request_type: 'call_function',
        finality: 'final',
        account_id: contract,
        method_name: method,
        args_base64: base64Encode(new TextEncoder().encode(JSON.stringify(args))),
      });
      const text = new TextDecoder().decode(Uint8Array.from(result.result));
      return (text ? JSON.parse(text) : null) as T;
    },

    async call<T>(
      contract: string,
      method: string,
      args: object,
      o: { gas?: bigint; deposit?: bigint } = {},
    ) {
      const outcome = await send(contract, [
        {
          functionCall: {
            method,
            args: new TextEncoder().encode(JSON.stringify(args)),
            gas: o.gas ?? 300n * TGAS,
            deposit: o.deposit ?? 0n,
          },
        },
      ]);
      return parseOutcome<T>(outcome);
    },

    async deploy(code: Uint8Array) {
      const outcome = await send(opts.accountId, [{ deployContract: { code } }]);
      return parseOutcome(outcome).txHash;
    },
  };
}

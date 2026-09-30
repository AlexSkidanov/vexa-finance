/**
 * The shielded Zcash wallet stealth routes pass through: a zingolib light
 * wallet (zingo-cli) syncing from a public lightwalletd server, no full node.
 * zingo-cli has no library bindings, so each operation is one CLI call
 * against the wallet's data directory; calls are serialized. zingolib goes
 * online through the Nym mixnet, via the `nym-proxy` binary built beside it
 * (see apps/api/Dockerfile), so the indexer never sees the server's address.
 *
 * The wallet is restored from ZCASH_SEED the first time. Each route gets its
 * own Orchard-only unified address, so 1Click's deposits land shielded.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ZcashWallet {
  /** A fresh shielded (Orchard) unified address. */
  newAddress(): Promise<string>;
  /** Spendable shielded zatoshis, after syncing. */
  spendable(): Promise<bigint>;
  /** Sends `zatoshis` to `to` (1Click's deposit addresses are transparent) and returns the txid. */
  send(to: string, zatoshis: bigint): Promise<string>;
}

/** The first JSON value in zingo-cli's output (it prints status lines around it). */
export function firstJson<T>(output: string): T {
  const start = output.search(/[[{]/);
  if (start < 0) throw new Error(`zingo-cli printed no JSON: ${output.slice(0, 200)}`);
  for (let end = output.length; end > start; end--) {
    const candidate = output.slice(start, end).trimEnd();
    if (!candidate.endsWith('}') && !candidate.endsWith(']')) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // keep shrinking
    }
  }
  throw new Error(`zingo-cli output isn't JSON: ${output.slice(0, 200)}`);
}

export function createZingoWallet(opts: {
  cliPath: string;
  dataDir: string;
  server: string;
  seed: string;
  birthday: number;
  /** Path to nym-proxy; defaults to the one beside zingo-cli. */
  nymProxy?: string;
}): ZcashWallet {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  async function cli(args: string[]): Promise<string> {
    const fresh = !existsSync(opts.dataDir) || readdirSync(opts.dataDir).length === 0;
    const base = ['--data-dir', opts.dataDir, '--server', opts.server];
    const restore = fresh ? ['--birthday', String(opts.birthday)] : [];
    const { stdout } = await run(opts.cliPath, [...base, ...restore, '--waitsync', ...args], {
      // The seed goes through the environment, never argv (visible to `ps`).
      env: {
        ...process.env,
        ...(opts.nymProxy ? { ZINGO_NYM_PROXY: opts.nymProxy } : {}),
        ...(fresh ? { ZINGO_SEED: opts.seed } : {}),
      },
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  return {
    newAddress: () =>
      serial(async () => {
        const out = firstJson<unknown>(await cli(['new_address', 'o']));
        const list = Array.isArray(out) ? out : [out];
        const address = list
          .map((a) =>
            typeof a === 'string' ? a : (a as { encoded_address?: string }).encoded_address,
          )
          .find((a): a is string => !!a && a.startsWith('u1'));
        if (!address) throw new Error('zingo-cli returned no unified address');
        return address;
      }),

    spendable: () =>
      serial(async () => {
        const out = firstJson<{ spendable_balance: number | string }>(
          await cli(['spendable_balance']),
        );
        return BigInt(out.spendable_balance);
      }),

    send: (to, zatoshis) =>
      serial(async () => {
        const out = await cli(['quicksend', to, zatoshis.toString()]);
        const parsed = firstJson<unknown>(out);
        const txid =
          (Array.isArray(parsed)
            ? parsed[0]
            : (parsed as { txids?: string[]; txid?: string }).txids?.[0]) ??
          (parsed as { txid?: string }).txid;
        if (typeof txid !== 'string')
          throw new Error(`zingo-cli send failed: ${out.slice(0, 300)}`);
        return txid;
      }),
  };
}

/**
 * Shared plumbing for the operational scripts: reading .env and keypairs, and
 * sending a transaction with confirmation.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase58Encoder,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const LAMPORTS = 1_000_000_000;
export const sol = (lamports: bigint | number) => (Number(lamports) / LAMPORTS).toFixed(6);

/** `--name value` from argv. */
export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

export const execute = process.argv.includes('--execute');

export function loadEnv() {
  const path = arg('env') ? resolve(arg('env')!) : join(ROOT, '.env');
  config({ path, quiet: true });
  return (key: string) => {
    const v = process.env[key]?.trim();
    if (!v) throw new Error(`${key} is not set in ${path}`);
    return v;
  };
}

/** A keypair from a base58 secret or a JSON byte array, as .env stores them. */
export function keypairBytes(raw: string): Uint8Array {
  return raw.startsWith('[')
    ? Uint8Array.from(JSON.parse(raw))
    : new Uint8Array(getBase58Encoder().encode(raw));
}

/** A keypair file, as `solana-keygen` writes them. `~` is expanded. */
export async function keypairFile(path: string): Promise<KeyPairSigner> {
  const full = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(full, 'utf8'))));
}

export function connect(rpcUrl: string) {
  const ws = new URL(rpcUrl);
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
  if (ws.port) ws.port = String(Number(ws.port) + 1);
  return {
    rpc: createSolanaRpc(rpcUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(ws.toString()),
  };
}

export type Connection = ReturnType<typeof connect>;

export async function sendTx(
  { rpc, rpcSubscriptions }: Connection,
  payer: KeyPairSigner,
  instructions: Instruction[],
): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  // The RPC URL comes from .env, so its cluster isn't known to the type system.
  type Factory = typeof sendAndConfirmTransactionFactory;
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  } as Parameters<Factory>[0]);
  await sendAndConfirm(signed as Parameters<typeof sendAndConfirm>[0], {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  return getSignatureFromTransaction(signed);
}

/** Prints an error and any simulation logs Kit attached along its cause chain, then exits. */
export function fail(e: unknown): never {
  console.error(e instanceof Error ? e.message : e);
  for (let err = e as { context?: { logs?: string[] }; cause?: unknown } | undefined; err;) {
    if (err.context?.logs) {
      console.error(err.context.logs.join('\n'));
      break;
    }
    err = err.cause as typeof err;
  }
  process.exit(1);
}

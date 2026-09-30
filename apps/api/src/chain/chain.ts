/**
 * The API's connection to Solana: reads account state, co-signs sponsored
 * transactions with the fee payer, and sends them.
 *
 * Kept behind an interface so route tests can run on LiteSVM instead of
 * mainnet.
 */
import {
  appendTransactionMessageInstructions,
  createKeyPairFromBytes,
  createSignerFromKeyPair,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
  type TransactionSigner,
} from '@solana/kit';
import {
  CONFIDENTIAL_ACCOUNT_SPACE,
  STAKE_RECORD_LEN,
  contextStateSpace,
  ProofType,
  type RentTable,
} from '@vexa/core/solana';

export interface LatestBlockhash {
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}

export interface Chain {
  feePayer: Address;
  getAccountData(address: Address): Promise<Uint8Array | null>;
  getRentTable(): Promise<RentTable>;
  getMinimumBalance(space: bigint): Promise<bigint>;
  getLatestBlockhash(): Promise<LatestBlockhash>;
  /**
   * Adds the fee payer's signature, simulates, sends and waits for
   * confirmation. Throws ChainError if simulation or execution fails; a
   * failed simulation costs nothing.
   */
  signAndSend(transaction: Transaction): Promise<string>;
  /** Builds, signs (fee payer only) and sends a server-originated transaction. */
  sendAsFeePayer(instructions: Instruction[]): Promise<string>;
  /** The fee payer as a signer, for server-built instructions it signs. */
  feePayerSigner: TransactionSigner;
}

export class ChainError extends Error {
  constructor(
    message: string,
    readonly logs: string[] = [],
  ) {
    super(message);
    this.name = 'ChainError';
  }
}

export async function loadFeePayer(
  raw: string,
): Promise<{ pair: CryptoKeyPair; signer: KeyPairSigner }> {
  const bytes = raw.trim().startsWith('[')
    ? Uint8Array.from(JSON.parse(raw))
    : new Uint8Array(getBase58Encoder().encode(raw.trim()));
  const pair = await createKeyPairFromBytes(bytes);
  return { pair, signer: await createSignerFromKeyPair(pair) };
}

export function rentSpaces() {
  return {
    confidentialAccount: CONFIDENTIAL_ACCOUNT_SPACE,
    equalityContext: contextStateSpace(ProofType.VerifyCiphertextCommitmentEquality),
    validityContext: contextStateSpace(ProofType.VerifyBatchedGroupedCiphertext3HandlesValidity),
    rangeU128Context: contextStateSpace(ProofType.VerifyBatchedRangeProofU128),
    rangeU64Context: contextStateSpace(ProofType.VerifyBatchedRangeProofU64),
    stakeRecord: BigInt(STAKE_RECORD_LEN),
    tokenAccount: 165n,
  } satisfies Record<keyof RentTable, bigint>;
}

/** Chain backed by a Solana JSON-RPC endpoint (Alchemy in production). */
export async function createRpcChain(opts: {
  rpcUrl: string;
  feePayerKeypair: string;
}): Promise<Chain> {
  const rpc = createSolanaRpc(opts.rpcUrl);
  const { pair, signer } = await loadFeePayer(opts.feePayerKeypair);
  let rentCache: RentTable | null = null;

  const confirm = async (signature: string, lastValidBlockHeight: bigint) => {
    for (;;) {
      const { value } = await rpc.getSignatureStatuses([signature as never]).send();
      const status = value[0];
      if (status?.err)
        throw new ChainError(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized')
        return;
      const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
      if (height > lastValidBlockHeight) throw new ChainError(`transaction ${signature} expired`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  const send = async (signed: Transaction, lastValidBlockHeight: bigint) => {
    const wire = getBase64EncodedWireTransaction(signed);
    const sim = await rpc
      .simulateTransaction(wire, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' })
      .send();
    if (sim.value.err) {
      throw new ChainError(`simulation failed: ${JSON.stringify(sim.value.err)}`, [
        ...(sim.value.logs ?? []),
      ]);
    }
    const signature = await rpc
      .sendTransaction(wire, { encoding: 'base64', skipPreflight: true, maxRetries: 5n })
      .send();
    await confirm(signature, lastValidBlockHeight);
    return signature;
  };

  const chain: Chain = {
    feePayer: signer.address,
    feePayerSigner: signer,

    async getAccountData(address) {
      const { value } = await rpc
        .getAccountInfo(address, { encoding: 'base64', commitment: 'confirmed' })
        .send();
      return value ? new Uint8Array(Buffer.from(value.data[0], 'base64')) : null;
    },

    async getMinimumBalance(space) {
      return rpc.getMinimumBalanceForRentExemption(space).send();
    },

    async getRentTable() {
      if (rentCache) return rentCache;
      const spaces = rentSpaces();
      const entries = await Promise.all(
        Object.entries(spaces).map(
          async ([k, space]) =>
            [k, await rpc.getMinimumBalanceForRentExemption(space).send()] as const,
        ),
      );
      rentCache = Object.fromEntries(entries) as unknown as RentTable;
      return rentCache;
    },

    async getLatestBlockhash() {
      const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      return value;
    },

    async signAndSend(transaction) {
      const signed = await partiallySignTransaction([pair], transaction);
      // The client chose the blockhash; give it the standard ~60s window.
      const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
      return send(signed, height + 150n);
    },

    async sendAsFeePayer(instructions) {
      const latest = await chain.getLatestBlockhash();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      );
      const signed = await signTransactionMessageWithSigners(message);
      await send(signed, latest.lastValidBlockHeight);
      return getSignatureFromTransaction(signed);
    },
  };
  return chain;
}

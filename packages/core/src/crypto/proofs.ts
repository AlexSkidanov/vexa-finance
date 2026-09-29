/**
 * Proof generation for confidential transfers and withdrawals.
 *
 * These are line-by-line ports of `spl-token-confidential-transfer-proof-
 * generation` (transfer.rs, withdraw.rs), built on @solana/zk-sdk's WASM
 * bindings. Proofs made here were checked against mainnet's verifier by
 * simulation; see docs/ARCHITECTURE.md, "Proof compatibility".
 *
 * Everything in this file runs on the user's device. Amounts and secret keys
 * go in; only proofs and ciphertexts come out.
 */
import { ristretto255 } from '@noble/curves/ed25519.js';
import type { AeKey, ElGamalKeypair, ElGamalSecretKey } from '@solana/zk-sdk';
import {
  AeCiphertext,
  BatchedGroupedCiphertext3HandlesValidityProofData,
  BatchedRangeProofU128Data,
  BatchedRangeProofU64Data,
  CiphertextCommitmentEqualityProofData,
  ElGamalCiphertext,
  ElGamalPubkey,
  GroupedElGamalCiphertext3Handles,
  PedersenCommitment,
  PedersenOpening,
} from '@solana/zk-sdk';
import {
  combineLoHi,
  commitmentOf,
  extractFromGrouped,
  splitAmount,
  subtractCiphertexts,
  TRANSFER_AMOUNT_HI_BITS,
  TRANSFER_AMOUNT_LO_BITS,
} from './ristretto.js';

const REMAINING_BALANCE_BITS = 64;
const RANGE_PROOF_PADDING_BITS = 16;

/**
 * Frees WASM objects when the builder is done with them. Some constructors
 * take ownership of their arguments (arrays passed by value are moved into
 * Rust), which zeroes the JS handle; those are skipped rather than freed twice.
 */
class Scope {
  private objects: { free(): void }[] = [];
  keep<T extends { free(): void }>(o: T): T {
    this.objects.push(o);
    return o;
  }
  close() {
    for (const o of this.objects.reverse()) {
      if ((o as unknown as { __wbg_ptr?: number }).__wbg_ptr !== 0) o.free();
    }
  }
}

function decryptAe(ae: AeKey, bytes: Uint8Array): bigint {
  const ct = AeCiphertext.fromBytes(bytes);
  if (!ct) throw new Error('malformed decryptable balance');
  try {
    const amount = ct.decrypt(ae);
    if (amount === undefined)
      throw new Error('decryptable balance was not encrypted under this AE key');
    return amount;
  } finally {
    ct.free();
  }
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

export interface TransferProofInput {
  elgamal: ElGamalKeypair;
  ae: AeKey;
  /** The source account's `available_balance` ciphertext (64 bytes). */
  availableBalance: Uint8Array;
  /** The source account's `decryptable_available_balance` (36 bytes). */
  decryptableAvailableBalance: Uint8Array;
  amount: bigint;
  destinationElgamalPubkey: Uint8Array;
  /** The mint's auditor key, or null when the mint has none. */
  auditorElgamalPubkey: Uint8Array | null;
}

export interface TransferProofs {
  equalityProof: Uint8Array;
  ciphertextValidityProof: Uint8Array;
  rangeProof: Uint8Array;
  /** Amount halves encrypted under (source, destination, auditor). 128 bytes each. */
  groupedCiphertextLo: Uint8Array;
  groupedCiphertextHi: Uint8Array;
  /** The auditor's slice of the above, which the Transfer instruction carries. */
  auditorCiphertextLo: Uint8Array;
  auditorCiphertextHi: Uint8Array;
  /** AE-encrypted remaining balance, for the source account's fast-decrypt field. */
  newDecryptableAvailableBalance: Uint8Array;
}

export function buildTransferProofs(input: TransferProofInput): TransferProofs {
  const s = new Scope();
  try {
    const [lo, hi] = splitAmount(input.amount);
    const source = s.keep(input.elgamal.pubkey());
    const destination = s.keep(ElGamalPubkey.fromBytes(input.destinationElgamalPubkey));
    // No auditor: the identity point, as Token-2022 expects.
    const auditor = s.keep(
      ElGamalPubkey.fromBytes(input.auditorElgamalPubkey ?? new Uint8Array(32)),
    );

    const openingLo = s.keep(new PedersenOpening());
    const openingHi = s.keep(new PedersenOpening());
    const groupedLo = s.keep(
      GroupedElGamalCiphertext3Handles.encryptWith(source, destination, auditor, lo, openingLo),
    );
    const groupedHi = s.keep(
      GroupedElGamalCiphertext3Handles.encryptWith(source, destination, auditor, hi, openingHi),
    );
    const groupedLoBytes = groupedLo.toBytes();
    const groupedHiBytes = groupedHi.toBytes();

    const balance = decryptAe(input.ae, input.decryptableAvailableBalance);
    if (balance < input.amount) throw new Error('insufficient confidential balance');
    const remaining = balance - input.amount;

    const remainingOpening = s.keep(new PedersenOpening());
    const remainingCommitment = s.keep(PedersenCommitment.from(remaining, remainingOpening));

    // available − (lo + hi·2^16), using the source's handles.
    const transferredFromSource = combineLoHi(
      extractFromGrouped(groupedLoBytes, 0),
      extractFromGrouped(groupedHiBytes, 0),
      TRANSFER_AMOUNT_LO_BITS,
    );
    const remainingCiphertext = s.keep(
      ElGamalCiphertext.fromBytes(
        subtractCiphertexts(input.availableBalance, transferredFromSource),
      )!,
    );

    const equality = s.keep(
      new CiphertextCommitmentEqualityProofData(
        input.elgamal,
        remainingCiphertext,
        remainingCommitment,
        remainingOpening,
        remaining,
      ),
    );
    const validity = s.keep(
      new BatchedGroupedCiphertext3HandlesValidityProofData(
        source,
        destination,
        auditor,
        groupedLo,
        groupedHi,
        lo,
        hi,
        openingLo,
        openingHi,
      ),
    );

    const paddingOpening = s.keep(new PedersenOpening());
    const paddingCommitment = s.keep(PedersenCommitment.from(0n, paddingOpening));
    const range = s.keep(
      new BatchedRangeProofU128Data(
        [
          remainingCommitment,
          s.keep(PedersenCommitment.fromBytes(commitmentOf(groupedLoBytes))),
          s.keep(PedersenCommitment.fromBytes(commitmentOf(groupedHiBytes))),
          paddingCommitment,
        ],
        new BigUint64Array([remaining, lo, hi, 0n]),
        new Uint8Array([
          REMAINING_BALANCE_BITS,
          TRANSFER_AMOUNT_LO_BITS,
          TRANSFER_AMOUNT_HI_BITS,
          RANGE_PROOF_PADDING_BITS,
        ]),
        [remainingOpening, openingLo, openingHi, paddingOpening],
      ),
    );

    return {
      equalityProof: equality.toBytes(),
      ciphertextValidityProof: validity.toBytes(),
      rangeProof: range.toBytes(),
      groupedCiphertextLo: groupedLoBytes,
      groupedCiphertextHi: groupedHiBytes,
      auditorCiphertextLo: extractFromGrouped(groupedLoBytes, 2),
      auditorCiphertextHi: extractFromGrouped(groupedHiBytes, 2),
      newDecryptableAvailableBalance: s.keep(input.ae.encrypt(remaining)).toBytes(),
    };
  } finally {
    s.close();
  }
}

// ---------------------------------------------------------------------------
// Withdraw (confidential → public, before the vault burns it)
// ---------------------------------------------------------------------------

export interface WithdrawProofInput {
  elgamal: ElGamalKeypair;
  ae: AeKey;
  availableBalance: Uint8Array;
  decryptableAvailableBalance: Uint8Array;
  amount: bigint;
}

export interface WithdrawProofs {
  equalityProof: Uint8Array;
  rangeProof: Uint8Array;
  newDecryptableAvailableBalance: Uint8Array;
}

/** ElGamal::encode(amount): a ciphertext of `amount` with zero randomness. */
function encodeAmount(amount: bigint): Uint8Array {
  const out = new Uint8Array(64);
  if (amount > 0n) out.set(ristretto255.Point.BASE.multiply(amount).toBytes(), 0);
  // Handle is the identity (all zeros).
  return out;
}

export function buildWithdrawProofs(input: WithdrawProofInput): WithdrawProofs {
  const s = new Scope();
  try {
    const balance = decryptAe(input.ae, input.decryptableAvailableBalance);
    if (balance < input.amount) throw new Error('insufficient confidential balance');
    const remaining = balance - input.amount;

    const opening = s.keep(new PedersenOpening());
    const commitment = s.keep(PedersenCommitment.from(remaining, opening));
    const remainingCiphertext = s.keep(
      ElGamalCiphertext.fromBytes(
        subtractCiphertexts(input.availableBalance, encodeAmount(input.amount)),
      )!,
    );

    const equality = s.keep(
      new CiphertextCommitmentEqualityProofData(
        input.elgamal,
        remainingCiphertext,
        commitment,
        opening,
        remaining,
      ),
    );
    const range = s.keep(
      new BatchedRangeProofU64Data(
        [commitment],
        new BigUint64Array([remaining]),
        new Uint8Array([64]),
        [opening],
      ),
    );
    return {
      equalityProof: equality.toBytes(),
      rangeProof: range.toBytes(),
      newDecryptableAvailableBalance: s.keep(input.ae.encrypt(remaining)).toBytes(),
    };
  } finally {
    s.close();
  }
}

// ---------------------------------------------------------------------------
// Decryption
// ---------------------------------------------------------------------------

/**
 * Decrypts a transfer amount from its grouped ciphertexts with one party's
 * secret key: index 0 for the sender, 1 for the recipient, 2 for the auditor.
 */
export function decryptTransferAmount(
  secret: ElGamalSecretKey,
  groupedCiphertextLo: Uint8Array,
  groupedCiphertextHi: Uint8Array,
  index: 0 | 1 | 2,
): bigint {
  const lo = GroupedElGamalCiphertext3Handles.fromBytes(groupedCiphertextLo);
  const hi = GroupedElGamalCiphertext3Handles.fromBytes(groupedCiphertextHi);
  try {
    return (
      lo.decrypt(secret, index) + (hi.decrypt(secret, index) << BigInt(TRANSFER_AMOUNT_LO_BITS))
    );
  } finally {
    lo.free();
    hi.free();
  }
}

/** Decrypts an account's pending balance (lo 16 bits + hi 32 bits). */
export function decryptPendingBalance(
  secret: ElGamalSecretKey,
  pendingLo: Uint8Array,
  pendingHi: Uint8Array,
): bigint {
  const lo = ElGamalCiphertext.fromBytes(pendingLo);
  const hi = ElGamalCiphertext.fromBytes(pendingHi);
  if (!lo || !hi) throw new Error('malformed pending balance ciphertext');
  try {
    return secret.decrypt(lo) + (secret.decrypt(hi) << BigInt(TRANSFER_AMOUNT_LO_BITS));
  } finally {
    lo.free();
    hi.free();
  }
}

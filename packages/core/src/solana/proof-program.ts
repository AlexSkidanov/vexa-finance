/**
 * The ZK ElGamal proof program: verifies a proof and, optionally, records its
 * public context in a "context state" account that Token-2022 instructions
 * read later. Splitting verification from use is what lets a confidential
 * transfer span several transactions despite the 1232-byte size limit.
 *
 * Context state layout: authority (32) | proof type (1) | context (N).
 */
import { AccountRole, type Address, type Instruction } from '@solana/kit';
import { ZK_ELGAMAL_PROOF_PROGRAM } from './programs.js';

export const ProofType = {
  CloseContextState: 0,
  VerifyZeroCiphertext: 1,
  VerifyCiphertextCiphertextEquality: 2,
  VerifyCiphertextCommitmentEquality: 3,
  VerifyPubkeyValidity: 4,
  VerifyPercentageWithCap: 5,
  VerifyBatchedRangeProofU64: 6,
  VerifyBatchedRangeProofU128: 7,
  VerifyBatchedRangeProofU256: 8,
  VerifyGroupedCiphertext2HandlesValidity: 9,
  VerifyBatchedGroupedCiphertext2HandlesValidity: 10,
  VerifyGroupedCiphertext3HandlesValidity: 11,
  VerifyBatchedGroupedCiphertext3HandlesValidity: 12,
} as const;
export type ProofType = (typeof ProofType)[keyof typeof ProofType];

const CONTEXT_HEADER = 33;

/** Byte size of each proof's public context, as stored after the header. */
export const PROOF_CONTEXT_LEN = {
  [ProofType.VerifyCiphertextCommitmentEquality]: 128, // pubkey | ciphertext | commitment
  [ProofType.VerifyBatchedRangeProofU64]: 264, // 8 commitments | 8 bit lengths
  [ProofType.VerifyBatchedRangeProofU128]: 264,
  [ProofType.VerifyBatchedGroupedCiphertext3HandlesValidity]: 352, // 3 pubkeys | 2 grouped ciphertexts
} as const;

export function contextStateSpace(type: keyof typeof PROOF_CONTEXT_LEN): bigint {
  return BigInt(CONTEXT_HEADER + PROOF_CONTEXT_LEN[type]);
}

/**
 * Verify a proof. With `context`, the result is written to that (pre-created,
 * proof-program-owned) account; without it, the proof is only checked.
 */
export function verifyProofInstruction(
  type: ProofType,
  proof: Uint8Array,
  context?: { account: Address; authority: Address },
): Instruction {
  const data = new Uint8Array(1 + proof.length);
  data[0] = type;
  data.set(proof, 1);
  return {
    programAddress: ZK_ELGAMAL_PROOF_PROGRAM,
    accounts: context
      ? [
          { address: context.account, role: AccountRole.WRITABLE },
          { address: context.authority, role: AccountRole.READONLY },
        ]
      : [],
    data,
  };
}

/** Closes a context state account and returns its rent to `destination`. */
export function closeContextStateInstruction(
  account: Address,
  destination: Address,
  authority: Address,
): Instruction {
  return {
    programAddress: ZK_ELGAMAL_PROOF_PROGRAM,
    accounts: [
      { address: account, role: AccountRole.WRITABLE },
      { address: destination, role: AccountRole.WRITABLE },
      { address: authority, role: AccountRole.READONLY_SIGNER },
    ],
    data: new Uint8Array([ProofType.CloseContextState]),
  };
}

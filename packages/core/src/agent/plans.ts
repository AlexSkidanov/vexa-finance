/**
 * Plans for agent accounts. They're the standard plans with the agent's MPC
 * address as the owner (a no-op signer: the policy contract gets NEAR to sign
 * for it) plus, for payments:
 *
 * - a fourth proof context holding the limit proof;
 * - `RequireContexts` first in the transfer transaction, binding it to the
 *   exact proofs the policy contract checked;
 * - the agent's durable nonce as the transfer's lifetime, because MPC signing
 *   takes longer than a blockhash lives.
 *
 * ```text
 *   stage 1  create 4 proof contexts                          fee payer
 *   stage 2  verify equality + validity | range | limit       fee payer
 *   stage 3  advance nonce, RequireContexts, transfer, close  fee payer + agent (MPC)
 * ```
 */
import { sha256 } from '@noble/hashes/sha2.js';
import {
  createNoopSigner,
  generateKeyPairSigner,
  type Address,
  type TransactionSigner,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import { getConfidentialTransferInstruction } from '@solana-program/token-2022';
import {
  closeContextStateInstruction,
  contextStateSpace,
  ProofType,
  verifyProofInstruction,
} from '../solana/proof-program.js';
import { VAULT_PROGRAM, ZK_ELGAMAL_PROOF_PROGRAM } from '../solana/programs.js';
import { applyPendingPlan, configurePlan, type Plan, type RentTable } from '../solana/plans.js';
import { requireContextsInstruction, type VaultAccounts } from '../solana/vault.js';
import type { AgentPaymentProofs } from './proofs.js';

export interface AgentAccounts {
  /** The agent's MPC-derived Solana address. */
  address: Address;
  cusdc: Address;
  nonceAccount: Address;
}

/** Opens the agent's confidential account (signed by the agent via NEAR). */
export function agentConfigurePlan(
  input: Omit<Parameters<typeof configurePlan>[0], 'owner' | 'tokenAccount'> & {
    agent: AgentAccounts;
  },
): Plan {
  const plan = configurePlan({
    ...input,
    owner: createNoopSigner(input.agent.address),
    tokenAccount: input.agent.cusdc,
  });
  return { ...plan, kind: 'agent-configure' };
}

/** Makes funds sent to the agent spendable. */
export function agentApplyPendingPlan(
  input: Omit<Parameters<typeof applyPendingPlan>[0], 'owner' | 'ownerCusdc'> & {
    agent: AgentAccounts;
  },
): Plan {
  const plan = applyPendingPlan({
    ...input,
    owner: createNoopSigner(input.agent.address),
    ownerCusdc: input.agent.cusdc,
  });
  return { ...plan, kind: 'agent-apply-pending' };
}

export interface AgentTransferInput {
  vault: VaultAccounts;
  feePayer: Address;
  agent: AgentAccounts;
  /** The durable nonce's current value (`decodeNonceAccount`). */
  nonce: string;
  destinationToken: Address;
  proofs: Pick<
    AgentPaymentProofs,
    | 'equality'
    | 'validity'
    | 'range'
    | 'newDecryptableBalance'
    | 'auditorCiphertextLo'
    | 'auditorCiphertextHi'
  > &
    Partial<Pick<AgentPaymentProofs, 'limit' | 'validityContext' | 'limitContext'>>;
  rent: Pick<RentTable, 'equalityContext' | 'validityContext' | 'rangeU128Context'>;
}

/**
 * A payment from the agent: with a limit proof to anyone its policy allows,
 * or (`sweep`, no limit proof) back to the owner, which is always allowed.
 */
export async function agentTransferPlan(
  input: AgentTransferInput & { sweep?: boolean },
): Promise<Plan & { contexts: { validity: Address; limit: Address | null } }> {
  const feePayer = createNoopSigner(input.feePayer);
  const agent: TransactionSigner = createNoopSigner(input.agent.address);
  const withLimit = !input.sweep;
  if (
    withLimit &&
    !(input.proofs.limit && input.proofs.validityContext && input.proofs.limitContext)
  )
    throw new Error('a payment needs its limit proof and contexts');
  const [equality, validity, range, limit] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const ctx = (account: Address) => ({ account, authority: input.feePayer });
  const create = (
    account: TransactionSigner,
    lamports: bigint,
    type: Parameters<typeof contextStateSpace>[0],
  ) =>
    getCreateAccountInstruction({
      payer: feePayer,
      newAccount: account,
      lamports,
      space: contextStateSpace(type),
      programAddress: ZK_ELGAMAL_PROOF_PROGRAM,
    });
  const contexts = [equality, validity, range, ...(withLimit ? [limit] : [])];

  return {
    kind: withLimit ? 'agent-payment' : 'agent-sweep',
    contexts: { validity: validity.address, limit: withLimit ? limit.address : null },
    stages: [
      [
        {
          label: 'create-proof-contexts',
          instructions: [
            create(
              equality,
              input.rent.equalityContext,
              ProofType.VerifyCiphertextCommitmentEquality,
            ),
            create(
              validity,
              input.rent.validityContext,
              ProofType.VerifyBatchedGroupedCiphertext3HandlesValidity,
            ),
            create(range, input.rent.rangeU128Context, ProofType.VerifyBatchedRangeProofU128),
            ...(withLimit
              ? [create(limit, input.rent.rangeU128Context, ProofType.VerifyBatchedRangeProofU128)]
              : []),
          ],
        },
      ],
      [
        {
          label: 'verify-equality-and-validity',
          instructions: [
            verifyProofInstruction(
              ProofType.VerifyCiphertextCommitmentEquality,
              input.proofs.equality,
              ctx(equality.address),
            ),
            verifyProofInstruction(
              ProofType.VerifyBatchedGroupedCiphertext3HandlesValidity,
              input.proofs.validity,
              ctx(validity.address),
            ),
          ],
        },
        {
          label: 'verify-range',
          instructions: [
            verifyProofInstruction(
              ProofType.VerifyBatchedRangeProofU128,
              input.proofs.range,
              ctx(range.address),
            ),
          ],
        },
        ...(withLimit
          ? [
              {
                label: 'verify-limit' as const,
                instructions: [
                  verifyProofInstruction(
                    ProofType.VerifyBatchedRangeProofU128,
                    input.proofs.limit!,
                    ctx(limit.address),
                  ),
                ],
              },
            ]
          : []),
      ],
      [
        {
          label: 'agent-transfer',
          durableNonce: {
            nonceAccount: input.agent.nonceAccount,
            authority: input.agent.address,
            nonce: input.nonce,
          },
          instructions: [
            ...(withLimit
              ? [
                  requireContextsInstruction({
                    program: input.vault.program ?? VAULT_PROGRAM,
                    contexts: [
                      { account: validity.address, hash: sha256(input.proofs.validityContext!) },
                      { account: limit.address, hash: sha256(input.proofs.limitContext!) },
                    ],
                  }),
                ]
              : []),
            getConfidentialTransferInstruction({
              sourceToken: input.agent.cusdc,
              mint: input.vault.cusdcMint,
              destinationToken: input.destinationToken,
              equalityRecord: equality.address,
              ciphertextValidityRecord: validity.address,
              rangeRecord: range.address,
              authority: agent,
              newSourceDecryptableAvailableBalance: input.proofs.newDecryptableBalance,
              transferAmountAuditorCiphertextLo: input.proofs.auditorCiphertextLo,
              transferAmountAuditorCiphertextHi: input.proofs.auditorCiphertextHi,
              equalityProofInstructionOffset: 0,
              ciphertextValidityProofInstructionOffset: 0,
              rangeProofInstructionOffset: 0,
            }),
            ...contexts.map((c) =>
              closeContextStateInstruction(c.address, input.feePayer, input.feePayer),
            ),
          ],
        },
      ],
    ],
  };
}

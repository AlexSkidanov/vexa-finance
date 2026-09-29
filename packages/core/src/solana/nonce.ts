/**
 * Durable nonces for agent payments.
 *
 * An agent payment is signed by NEAR's MPC network after the policy contract
 * approves it, which can take tens of seconds, and it's sent after its proofs
 * are verified. A recent blockhash could expire in between, so the payment
 * transaction uses the agent's durable nonce instead: a value stored in a
 * nonce account that stays valid until the agent (through the policy
 * contract) advances it, which the payment itself does.
 *
 * Each agent's nonce account is created by Vexa's fee payer at a seed-derived
 * address, so the owner's device can compute it before the agent exists.
 */
import {
  createAddressWithSeed,
  getAddressDecoder,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import {
  getCreateAccountWithSeedInstruction,
  getInitializeNonceAccountInstruction,
} from '@solana-program/system';
import { SYSTEM_PROGRAM } from './programs.js';

export const NONCE_ACCOUNT_LEN = 80n;

/** `vexa-nonce-` plus the agent id without dashes, cut to Solana's 32-byte seed limit. */
export function agentNonceSeed(agentId: string): string {
  return `vexa-nonce-${agentId.replace(/-/g, '')}`.slice(0, 32);
}

export function findAgentNonceAccount(feePayer: Address, agentId: string): Promise<Address> {
  return createAddressWithSeed({
    baseAddress: feePayer,
    programAddress: SYSTEM_PROGRAM,
    seed: agentNonceSeed(agentId),
  });
}

/** Creates and initializes an agent's nonce account, with the agent as its authority. */
export async function createAgentNonceInstructions(input: {
  feePayer: TransactionSigner;
  agentId: string;
  agent: Address;
  lamports: bigint;
}): Promise<Instruction[]> {
  const nonceAccount = await findAgentNonceAccount(input.feePayer.address, input.agentId);
  return [
    getCreateAccountWithSeedInstruction({
      payer: input.feePayer,
      newAccount: nonceAccount,
      baseAccount: input.feePayer,
      base: input.feePayer.address,
      seed: agentNonceSeed(input.agentId),
      amount: input.lamports,
      space: NONCE_ACCOUNT_LEN,
      programAddress: SYSTEM_PROGRAM,
    }),
    getInitializeNonceAccountInstruction({ nonceAccount, nonceAuthority: input.agent }),
  ];
}

/** The authority and current value of a nonce account (versions and state 1). */
export function decodeNonceAccount(data: Uint8Array): { authority: Address; nonce: string } | null {
  if (data.length !== Number(NONCE_ACCOUNT_LEN)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(4, true) !== 1) return null;
  const addresses = getAddressDecoder();
  return {
    authority: addresses.decode(data.subarray(8, 40)),
    nonce: addresses.decode(data.subarray(40, 72)),
  };
}

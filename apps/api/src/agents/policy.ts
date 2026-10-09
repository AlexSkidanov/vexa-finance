/**
 * The NEAR policy contract (contracts/near-policy), as the API uses it. The
 * API is the contract's relayer: it pays gas and storage and relays calls,
 * but can't change a policy or move an agent's funds on its own, because
 * every call carries a signature by the owner or the agent's authority key.
 */
import { agentAddress, type PolicyTerms } from '@vexa/core/agent';
import { base58Decode, base64Encode } from '@vexa/core';
import { NEAR, NearError, TGAS, type NearClient } from '../near/client.js';

export interface OnChainAgent {
  address: string;
  cusdc: string;
  owner: string;
  ownerCusdc: string;
  authority: string;
  nonceAccount: string;
  status: 'Active' | 'Paused' | 'Revoked';
  authNonce: bigint;
  nextIndex: bigint;
  window: { atMs: number; index: bigint; commitment: string }[];
}

export class PolicyRefused extends Error {
  constructor(
    /** The contract's error code, e.g. `LIMIT_PROOF_MISMATCH`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyRefused';
  }
}

export interface SignRequest {
  agentId: string;
  message: Uint8Array;
  validityContext?: Uint8Array;
  limitContext?: Uint8Array;
  index?: bigint;
  windowStart?: bigint;
  domain?: string;
  signer: 'agent' | 'owner';
  nonce: bigint;
  /** Base58 Ed25519 signature over the authorization message. */
  signature: string;
}

export interface PolicyContract {
  contractId: string;
  mpcRoot(): Promise<string>;
  agentAddress(agentId: string): Promise<string>;
  getAgent(agentId: string): Promise<OnChainAgent | null>;
  createPolicy(input: {
    agentId: string;
    owner: string;
    authority: string;
    nonceAccount: string;
    policy: PolicyTerms;
    signature: string;
  }): Promise<string>;
  updatePolicy(input: {
    agentId: string;
    policy: PolicyTerms;
    nonce: bigint;
    signature: string;
  }): Promise<void>;
  setPaused(input: {
    agentId: string;
    paused: boolean;
    nonce: bigint;
    signature: string;
  }): Promise<void>;
  revoke(input: { agentId: string; nonce: bigint; signature: string }): Promise<void>;
  /** The 64-byte Ed25519 signature for `message`, from the MPC network. */
  requestSignature(input: SignRequest): Promise<Uint8Array>;
}

const policyJson = (p: PolicyTerms) => ({
  max_per_request: p.maxPerRequest.toString(),
  daily_limit: p.dailyLimit.toString(),
  allowed_recipients: p.allowedRecipients,
  allowed_domains: p.allowedDomains,
});

const b64sig = (s: string) => {
  const bytes = base58Decode(s);
  if (!bytes || bytes.length !== 64)
    throw new PolicyRefused('BAD_SIGNATURE', 'signatures are 64 bytes');
  return base64Encode(bytes);
};

/** Turns a contract panic ("CODE: detail") into a PolicyRefused. */
async function relay<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof NearError) {
      const m = /^([A-Z_]+): (.*)$/s.exec(e.message);
      if (m) throw new PolicyRefused(m[1]!, m[2]!);
    }
    throw e;
  }
}

export function createPolicyContract(opts: {
  near: NearClient;
  contractId: string;
  mpcContract: string;
}): PolicyContract {
  const { near, contractId } = opts;
  let root: Promise<string> | undefined;
  const mpcRoot = () =>
    (root ??= near.view<string>(opts.mpcContract, 'public_key', { domain_id: 1 }).catch((e) => {
      root = undefined;
      throw e;
    }));

  return {
    contractId,
    mpcRoot,
    async agentAddress(agentId) {
      return agentAddress(await mpcRoot(), contractId, agentId);
    },

    async getAgent(agentId) {
      const a = await near.view<Record<string, unknown> | null>(contractId, 'get_agent', {
        agent_id: agentId,
      });
      if (!a) return null;
      return {
        address: a.address as string,
        cusdc: a.cusdc as string,
        owner: a.owner as string,
        ownerCusdc: a.owner_cusdc as string,
        authority: a.authority as string,
        nonceAccount: a.nonce_account as string,
        status: a.status as OnChainAgent['status'],
        authNonce: BigInt(a.auth_nonce as string),
        nextIndex: BigInt(a.next_index as string),
        window: (a.window as { at_ms: string; index: string; commitment: string }[]).map((w) => ({
          atMs: Number(w.at_ms),
          index: BigInt(w.index),
          commitment: w.commitment,
        })),
      };
    },

    async createPolicy(i) {
      const { value } = await relay(() =>
        near.call<string>(
          contractId,
          'create_policy',
          {
            agent_id: i.agentId,
            owner: i.owner,
            authority: i.authority,
            nonce_account: i.nonceAccount,
            policy: policyJson(i.policy),
            signature: b64sig(i.signature),
          },
          // Storage for the agent record; the contract refunds what it doesn't use.
          { gas: 100n * TGAS, deposit: NEAR / 50n },
        ),
      );
      return value;
    },

    async updatePolicy(i) {
      await relay(() =>
        near.call(contractId, 'update_policy', {
          agent_id: i.agentId,
          policy: policyJson(i.policy),
          nonce: i.nonce.toString(),
          signature: b64sig(i.signature),
        }),
      );
    },

    async setPaused(i) {
      await relay(() =>
        near.call(contractId, 'set_paused', {
          agent_id: i.agentId,
          paused: i.paused,
          nonce: i.nonce.toString(),
          signature: b64sig(i.signature),
        }),
      );
    },

    async revoke(i) {
      await relay(() =>
        near.call(contractId, 'revoke_policy', {
          agent_id: i.agentId,
          nonce: i.nonce.toString(),
          signature: b64sig(i.signature),
        }),
      );
    },

    async requestSignature(i) {
      const { value } = await relay(() =>
        near.call<string | null>(
          contractId,
          'request_signature',
          {
            agent_id: i.agentId,
            message: base64Encode(i.message),
            validity: i.validityContext ? base64Encode(i.validityContext) : null,
            limit: i.limitContext ? base64Encode(i.limitContext) : null,
            index: i.index?.toString() ?? null,
            window_start: i.windowStart?.toString() ?? null,
            domain: i.domain ?? null,
            signer: i.signer === 'agent' ? 'Agent' : 'Owner',
            nonce: i.nonce.toString(),
            signature: b64sig(i.signature),
          },
          // 1 yoctoNEAR goes to the MPC signer; the rest covers the payment record.
          { gas: 300n * TGAS, deposit: NEAR / 1000n },
        ),
      );
      if (!value || !/^[0-9a-f]{128}$/.test(value))
        throw new PolicyRefused('MPC_FAILED', 'the MPC network did not return a signature');
      return Uint8Array.from(value.match(/../g)!.map((h) => parseInt(h, 16)));
    },
  };
}

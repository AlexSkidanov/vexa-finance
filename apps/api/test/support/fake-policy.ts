/**
 * A stand-in for the NEAR policy contract in API tests. It checks the same
 * owner and agent authorizations the contract does (with @vexa/core's message
 * format) and tracks auth nonces and payment indexes, then "signs" as the MPC
 * network would, with an ordinary keypair per agent. The contract's own rules
 * are tested in contracts/near-policy.
 */
import { generateKeyPairSigner, signBytes, type KeyPairSigner } from '@solana/kit';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode } from '@vexa/core';
import {
  authorizationMessage,
  createPayload,
  encodePolicy,
  signPayload,
  type PolicyAction,
  type PolicyTerms,
} from '@vexa/core/agent';
import { PolicyRefused, type OnChainAgent, type PolicyContract } from '../../src/agents/policy.js';

interface FakeAgent {
  owner: string;
  authority: string;
  nonceAccount: string;
  policy: PolicyTerms;
  status: OnChainAgent['status'];
  authNonce: bigint;
  nextIndex: bigint;
  window: { atMs: number; index: bigint }[];
}

export function fakePolicyContract(contractId = 'policy.test'): PolicyContract & {
  signers: Map<string, KeyPairSigner>;
} {
  const signers = new Map<string, KeyPairSigner>();
  const agents = new Map<string, FakeAgent>();

  const signer = async (agentId: string) => {
    if (!signers.has(agentId)) signers.set(agentId, await generateKeyPairSigner());
    return signers.get(agentId)!;
  };
  const verify = (
    key: string,
    action: PolicyAction,
    agentId: string,
    nonce: bigint,
    payload: Uint8Array,
    sig: string,
  ) => {
    const message = authorizationMessage({ contract: contractId, action, agentId, nonce, payload });
    if (!ed25519.verify(base58Decode(sig)!, message, base58Decode(key)!))
      throw new PolicyRefused('BAD_SIGNATURE', 'authorization signature is invalid');
  };
  const agent = (id: string) => {
    const a = agents.get(id);
    if (!a) throw new PolicyRefused('UNKNOWN_AGENT', id);
    return a;
  };
  const ownerChange = (
    id: string,
    action: PolicyAction,
    nonce: bigint,
    payload: Uint8Array,
    sig: string,
  ) => {
    const a = agent(id);
    if (nonce !== a.authNonce) throw new PolicyRefused('STALE_NONCE', 'use the current auth nonce');
    verify(a.owner, action, id, nonce, payload, sig);
    a.authNonce++;
    return a;
  };

  return {
    contractId,
    signers,
    mpcRoot: async () => 'ed25519:G9hwngxWNKdmqMCmU1Yt6LPhFpayJeKFxyAV1HqMNLtF',
    agentAddress: async (id) => (await signer(id)).address,

    async getAgent(id) {
      const a = agents.get(id);
      if (!a) return null;
      return {
        address: (await signer(id)).address,
        cusdc: '',
        owner: a.owner,
        ownerCusdc: '',
        authority: a.authority,
        nonceAccount: a.nonceAccount,
        status: a.status,
        authNonce: a.authNonce,
        nextIndex: a.nextIndex,
        window: a.window.map((w) => ({ ...w, commitment: '' })),
      };
    },

    async createPolicy(i) {
      verify(
        i.owner,
        'create',
        i.agentId,
        0n,
        createPayload(i.policy, i.authority, i.nonceAccount),
        i.signature,
      );
      agents.set(i.agentId, {
        owner: i.owner,
        authority: i.authority,
        nonceAccount: i.nonceAccount,
        policy: i.policy,
        status: 'Active',
        authNonce: 1n,
        nextIndex: 0n,
        window: [],
      });
      return (await signer(i.agentId)).address;
    },

    async updatePolicy(i) {
      ownerChange(i.agentId, 'update_policy', i.nonce, encodePolicy(i.policy), i.signature).policy =
        i.policy;
    },
    async setPaused(i) {
      const a = ownerChange(
        i.agentId,
        'set_paused',
        i.nonce,
        Uint8Array.of(i.paused ? 1 : 0),
        i.signature,
      );
      a.status = i.paused ? 'Paused' : 'Active';
    },
    async revoke(i) {
      ownerChange(i.agentId, 'revoke_policy', i.nonce, new Uint8Array(0), i.signature).status =
        'Revoked';
    },

    async requestSignature(i) {
      const a = agent(i.agentId);
      if (i.nonce !== a.authNonce)
        throw new PolicyRefused('STALE_NONCE', 'use the current auth nonce');
      const payload = signPayload({
        message: i.message,
        index: i.index,
        windowStart: i.windowStart,
        domain: i.domain,
      });
      verify(
        i.signer === 'agent' ? a.authority : a.owner,
        'sign',
        i.agentId,
        i.nonce,
        payload,
        i.signature,
      );
      a.authNonce++;
      if (i.limitContext) {
        if (a.status === 'Paused')
          throw new PolicyRefused('AGENT_PAUSED', 'the owner has paused this agent');
        if (a.status === 'Revoked')
          throw new PolicyRefused('AGENT_REVOKED', 'the agent is revoked');
        if (i.index !== a.nextIndex)
          throw new PolicyRefused('STALE_INDEX', `next is ${a.nextIndex}`);
        if (a.policy.allowedDomains.length && !a.policy.allowedDomains.includes(i.domain ?? ''))
          throw new PolicyRefused('DOMAIN_NOT_ALLOWED', i.domain ?? 'no domain');
        a.window.push({ atMs: Date.now(), index: i.index });
        a.nextIndex++;
      }
      return new Uint8Array(
        await signBytes((await signer(i.agentId)).keyPair.privateKey, i.message),
      );
    },
  };
}

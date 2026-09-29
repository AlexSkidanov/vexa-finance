/**
 * An agent paying on LiteSVM, with proofs from the agent-proofs WASM. NEAR's
 * MPC signature is played by an ordinary keypair standing in for the agent's
 * derived address; everything the policy contract binds to (the proof
 * contexts, RequireContexts, the durable nonce) runs for real.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  getBase64Encoder,
  getTransactionDecoder,
  generateKeyPairSigner,
  partiallySignTransaction,
  type KeyPairSigner,
  type Transaction,
} from '@solana/kit';
import { AeCiphertext } from '@solana/zk-sdk';
import {
  buildTransferProofs,
  decryptableZeroBalance,
  decryptPendingBalance,
  pubkeyValidityProof,
} from '../src/crypto/index.js';
import {
  agentApplyPendingPlan,
  agentConfigurePlan,
  agentTransferPlan,
  buildAgentPaymentProofs,
  deriveAgentKeys,
  type AgentAccounts,
  type AgentKeys,
} from '../src/agent/index.js';
import {
  compilePlan,
  configurePlan,
  createAgentNonceInstructions,
  decodeConfidentialAccount,
  decodeNonceAccount,
  depositPlan,
  findAgentNonceAccount,
  findAta,
  quoteFee,
  TOKEN_2022_PROGRAM,
  transferPlan,
  type Plan,
} from '../src/solana/index.js';
import { createTestbed, vaultBinaryExists, type Testbed, type Wallet } from './support/testbed.js';

const USDC = 1_000_000n;
const LIMITS = { maxPerRequest: 10n * USDC, dailyLimit: 25n * USDC };

describe.skipIf(!vaultBinaryExists())('agent payments on LiteSVM', { timeout: 60_000 }, () => {
  let bed: Testbed;
  let owner: Wallet;
  let shop: Wallet;
  let mpc: KeyPairSigner;
  let keys: AgentKeys;
  let agent: AgentAccounts;
  const agentId = '5f0c6a1e-0000-4000-8000-000000000001';

  /** Sends a plan; transactions labelled in `agentSigns` get the "MPC" signature. */
  async function send(plan: Plan, agentSigns: string[] = []) {
    const compiled = await compilePlan(plan, {
      feePayer: bed.feePayer.address,
      ...bed.blockhash(),
    });
    for (const stage of compiled.stages) {
      for (const { label, transaction } of stage) {
        let tx: Transaction = getTransactionDecoder().decode(
          getBase64Encoder().encode(transaction),
        );
        if (agentSigns.includes(label)) tx = await partiallySignTransaction([mpc.keyPair], tx);
        await bed.sendAsFeePayer(tx);
      }
    }
    bed.svm.expireBlockhash();
  }

  const state = (account: typeof agent.cusdc) => decodeConfidentialAccount(bed.account(account)!)!;
  const available = (account: typeof agent.cusdc, ae: AgentKeys['ae']) =>
    AeCiphertext.fromBytes(state(account).decryptableAvailableBalance)!.decrypt(ae)!;
  const pending = (w: Wallet) =>
    decryptPendingBalance(
      w.keys.elgamal.secret(),
      state(w.cusdc).pendingBalanceLo,
      state(w.cusdc).pendingBalanceHi,
    );

  async function onboard(usdc: bigint): Promise<Wallet> {
    const w = await bed.newWallet(usdc);
    await send(
      configurePlan({
        vault: bed.vault,
        feePayer: bed.feePayer.address,
        owner: w.signer,
        tokenAccount: w.cusdc,
        pubkeyValidityProof: pubkeyValidityProof(w.keys.elgamal),
        decryptableZeroBalance: decryptableZeroBalance(w.keys.ae),
        rent: bed.rent,
      }),
    );
    return w;
  }

  async function pay(amount: bigint, index: bigint, window: { indices: bigint[]; amount: bigint }) {
    const s = state(agent.cusdc);
    const proofs = buildAgentPaymentProofs({
      elgamalSecret: keys.elgamalSecret,
      aeKey: keys.aeBytes,
      availableBalance: s.availableBalance,
      decryptableAvailableBalance: s.decryptableAvailableBalance,
      amount,
      destinationElgamalPubkey: shop.keys.elgamal.pubkey().toBytes(),
      auditorElgamalPubkey: null,
      openingSeed: keys.openingSeed,
      index,
      ...LIMITS,
      window,
    });
    const nonce = decodeNonceAccount(bed.account(agent.nonceAccount)!)!.nonce;
    return agentTransferPlan({
      vault: bed.vault,
      feePayer: bed.feePayer.address,
      agent,
      nonce,
      destinationToken: shop.cusdc,
      proofs,
      rent: bed.rent,
    });
  }

  beforeAll(async () => {
    bed = await createTestbed();
    owner = await onboard(100n * USDC);
    shop = await onboard(0n);
    mpc = await generateKeyPairSigner();
    keys = deriveAgentKeys(agentId, crypto.getRandomValues(new Uint8Array(32)));
    agent = {
      address: mpc.address,
      cusdc: await findAta(mpc.address, bed.vault.cusdcMint, TOKEN_2022_PROGRAM),
      nonceAccount: await findAgentNonceAccount(bed.feePayer.address, agentId),
    };
    await bed.sendDirect(
      bed.feePayer,
      await createAgentNonceInstructions({
        feePayer: bed.feePayer,
        agentId,
        agent: agent.address,
        lamports: bed.svm.minimumBalanceForRentExemption(80n),
      }),
    );

    // Open the agent's account, then fund it from the owner's balance.
    await send(
      agentConfigurePlan({
        vault: bed.vault,
        feePayer: bed.feePayer.address,
        agent,
        pubkeyValidityProof: pubkeyValidityProof(keys.elgamal),
        decryptableZeroBalance: decryptableZeroBalance(keys.ae),
        rent: bed.rent,
      }),
      ['fund-and-configure'],
    );
    const fee = quoteFee(bed.feeSchedule, 100n * USDC);
    await send(
      depositPlan({
        vault: bed.vault,
        owner: owner.signer,
        ownerUsdc: owner.usdc,
        ownerCusdc: owner.cusdc,
        amount: 100n * USDC,
        expectedPendingBalanceCreditCounter: 1n,
        newDecryptableAvailableBalance: owner.keys.ae.encrypt(100n * USDC - fee).toBytes(),
      }),
    );
    const o = state(owner.cusdc);
    const funding = buildTransferProofs({
      elgamal: owner.keys.elgamal,
      ae: owner.keys.ae,
      availableBalance: o.availableBalance,
      decryptableAvailableBalance: o.decryptableAvailableBalance,
      amount: 30n * USDC,
      destinationElgamalPubkey: keys.elgamal.pubkey().toBytes(),
      auditorElgamalPubkey: null,
    });
    await send(
      await transferPlan({
        feePayer: bed.feePayer.address,
        owner: owner.signer,
        mint: bed.vault.cusdcMint,
        sourceToken: owner.cusdc,
        destinationToken: agent.cusdc,
        proofs: funding,
        rent: bed.rent,
      }),
    );
    await send(
      agentApplyPendingPlan({
        agent,
        expectedPendingBalanceCreditCounter: 1n,
        newDecryptableAvailableBalance: keys.ae.encrypt(30n * USDC).toBytes(),
      }),
      ['apply-pending'],
    );
    expect(available(agent.cusdc, keys.ae)).toBe(30n * USDC);
  });

  it('pays within its limits, the second payment covering the first in its window', async () => {
    await send(await pay(9n * USDC, 0n, { indices: [], amount: 0n }), ['agent-transfer']);
    expect(pending(shop)).toBe(9n * USDC);
    expect(available(agent.cusdc, keys.ae)).toBe(21n * USDC);

    await send(await pay(7n * USDC, 1n, { indices: [0n], amount: 9n * USDC }), ['agent-transfer']);
    expect(pending(shop)).toBe(16n * USDC);
    // Nothing was left behind: every proof context was closed.
    expect(available(agent.cusdc, keys.ae)).toBe(14n * USDC);
  });

  it('refuses to build a payment over its limits', () => {
    const s = state(agent.cusdc);
    expect(() =>
      buildAgentPaymentProofs({
        elgamalSecret: keys.elgamalSecret,
        aeKey: keys.aeBytes,
        availableBalance: s.availableBalance,
        decryptableAvailableBalance: s.decryptableAvailableBalance,
        amount: 10n * USDC,
        destinationElgamalPubkey: shop.keys.elgamal.pubkey().toBytes(),
        auditorElgamalPubkey: null,
        openingSeed: keys.openingSeed,
        index: 2n,
        ...LIMITS,
        window: { indices: [0n, 1n], amount: 16n * USDC },
      }),
    ).toThrow(/LIMIT_EXCEEDED/);
  });

  it('fails on-chain if the proofs in its contexts are not the ones approved', async () => {
    const plan = await pay(USDC, 2n, { indices: [0n, 1n], amount: 16n * USDC });
    // Tamper with the approved limit-proof hash in RequireContexts.
    const step = plan.stages[2]![0]!;
    const data = Uint8Array.from(step.instructions[0]!.data!);
    data[40]! ^= 1;
    step.instructions[0] = { ...step.instructions[0]!, data };
    await expect(send(plan, ['agent-transfer'])).rejects.toThrow();
  });

  it('sends everything back to the owner, re-derived from the owner side', async () => {
    const s = state(agent.cusdc);
    const back = available(agent.cusdc, keys.ae);
    const proofs = buildTransferProofs({
      elgamal: keys.elgamal,
      ae: keys.ae,
      availableBalance: s.availableBalance,
      decryptableAvailableBalance: s.decryptableAvailableBalance,
      amount: back,
      destinationElgamalPubkey: owner.keys.elgamal.pubkey().toBytes(),
      auditorElgamalPubkey: null,
    });
    const before = pending(owner);
    await send(
      await agentTransferPlan({
        vault: bed.vault,
        feePayer: bed.feePayer.address,
        agent,
        nonce: decodeNonceAccount(bed.account(agent.nonceAccount)!)!.nonce,
        destinationToken: owner.cusdc,
        sweep: true,
        proofs: {
          equality: proofs.equalityProof,
          validity: proofs.ciphertextValidityProof,
          range: proofs.rangeProof,
          newDecryptableBalance: proofs.newDecryptableAvailableBalance,
          auditorCiphertextLo: proofs.auditorCiphertextLo,
          auditorCiphertextHi: proofs.auditorCiphertextHi,
        },
        rent: bed.rent,
      }),
      ['agent-transfer'],
    );
    expect(pending(owner) - before).toBe(back);
    expect(available(agent.cusdc, keys.ae)).toBe(0n);
  });
});

/**
 * Reading the vault's fee schedule and a user's $VEXA position from chain.
 * $VEXA balances and stakes are public token balances, not money movements,
 * so the API may read and return them.
 */
import type { Address } from '@solana/kit';
import { vexaWeight } from '@vexa/core';
import {
  decodeFeeSchedule,
  decodeStakeRecord,
  feeDiscountBps,
  findAta,
  findStakeRecord,
  TOKEN_PROGRAM,
  type FeeSchedule,
} from '@vexa/core/solana';
import type { Deps } from '../context.js';

export async function readFeeSchedule(
  deps: Pick<Deps, 'chain' | 'vault'>,
): Promise<FeeSchedule | null> {
  const data = await deps.chain.getAccountData(deps.vault.fees);
  return data ? decodeFeeSchedule(data) : null;
}

export interface VexaPosition {
  vexaMint: Address;
  walletAccount: Address | null;
  stakeRecord: Address | null;
  held: bigint;
  staked: bigint;
  unlockAt: number | null;
  weight: bigint;
  discountBps: number;
}

/** What's staked in the vault and held in the wallet, and the weight they add up to. */
export async function readVexaPosition(
  deps: Pick<Deps, 'chain' | 'vault'>,
  wallet: Address,
  fees: FeeSchedule | null,
): Promise<VexaPosition | null> {
  if (!fees?.vexaMint) return null;
  // $VEXA may be a classic Token or a Token-2022 mint (pump.fun launches the
  // latter); the wallet's account is derived under whichever owns it.
  const tokenProgram = (await deps.chain.getAccountOwner(fees.vexaMint)) ?? TOKEN_PROGRAM;
  const [walletAccount, stakeRecord] = await Promise.all([
    findAta(wallet, fees.vexaMint, tokenProgram),
    findStakeRecord(wallet, deps.vault.program),
  ]);
  const [walletData, stakeData] = await Promise.all([
    deps.chain.getAccountData(walletAccount),
    deps.chain.getAccountData(stakeRecord),
  ]);
  const held =
    walletData && walletData.length >= 72
      ? new DataView(walletData.buffer, walletData.byteOffset).getBigUint64(64, true)
      : 0n;
  const stake = stakeData ? decodeStakeRecord(stakeData) : null;
  const staked = stake && stake.vexaMint === fees.vexaMint ? stake.amount : 0n;
  const weight = vexaWeight(staked, held);
  return {
    vexaMint: fees.vexaMint,
    walletAccount: walletData ? walletAccount : null,
    stakeRecord: stake ? stakeRecord : null,
    held,
    staked,
    unlockAt: stake?.unlockAt ?? null,
    weight,
    discountBps: feeDiscountBps(fees, weight),
  };
}

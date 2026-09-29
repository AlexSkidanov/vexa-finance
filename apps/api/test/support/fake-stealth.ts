/**
 * Stand-ins for 1Click and the Zcash wallet, for stealth tests on LiteSVM.
 * USDC really moves on the testbed: deposits are read from chain, and the
 * return leg "bridges" by minting USDC to the recipient (the testbed admin is
 * the USDC mint authority). ZEC is only a number in the fake wallet.
 */
import { generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit';
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getMintToInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token-2022';
import { findAta, TOKEN_PROGRAM } from '@vexa/core/solana';
import type { Testbed } from '../../../../packages/core/test/support/testbed.js';
import { ASSET_ZEC, type OneClick, type SwapStatus } from '../../src/stealth/oneclick.js';
import type { ZcashWallet } from '../../src/stealth/zcash.js';

interface Swap {
  origin: string;
  amountIn: bigint;
  amountOut: bigint;
  recipient: string;
  refundTo: string;
  deposit: KeyPairSigner | null;
  status: SwapStatus;
}

/** 1 USDC base unit ↔ 100 zatoshis, minus fixed withdraw fees like 1Click's. */
export const rates = {
  usdcToZec: (usdc: bigint) => usdc * 100n - 32_000n,
  zecToUsdc: (zats: bigint) => zats / 100n - 310_000n,
};

export function fakeStealth(bed: Testbed, opts: { refundLeg1?: boolean } = {}) {
  const swaps = new Map<string, Swap>();
  let zec = 0n;
  const sent = new Map<string, bigint>();

  const oneClick: OneClick = {
    async quote(i) {
      const toZec = i.destinationAsset === ASSET_ZEC;
      const deposit = toZec ? await generateKeyPairSigner() : null;
      const depositAddress = deposit ? deposit.address : `t1fake${swaps.size}${Date.now()}`;
      swaps.set(depositAddress, {
        origin: i.originAsset,
        amountIn: i.amount,
        amountOut: toZec ? rates.usdcToZec(i.amount) : rates.zecToUsdc(i.amount),
        recipient: i.recipient,
        refundTo: i.refundTo,
        deposit,
        status: 'PENDING_DEPOSIT',
      });
      return {
        depositAddress,
        amountIn: i.amount.toString(),
        amountOut: '0',
        minAmountOut: '0',
        deadline: new Date(Date.now() + 3_600_000).toISOString(),
        timeEstimate: 60,
      };
    },

    async status(depositAddress) {
      const swap = swaps.get(depositAddress)!;
      if (swap.status === 'PENDING_DEPOSIT') {
        if (swap.deposit) {
          const ata = await findAta(swap.deposit.address, bed.vault.usdcMint, TOKEN_PROGRAM);
          const funded = bed.account(ata) ? bed.tokenAmount(ata) >= swap.amountIn : false;
          if (funded && opts.refundLeg1) {
            // Send it back to refundTo, as 1Click does.
            const back = await findAta(swap.refundTo as Address, bed.vault.usdcMint, TOKEN_PROGRAM);
            await bed.sendDirect(bed.admin, [
              getTransferCheckedInstruction(
                {
                  source: ata,
                  mint: bed.vault.usdcMint,
                  destination: back,
                  authority: swap.deposit,
                  amount: swap.amountIn,
                  decimals: 6,
                },
                { programAddress: TOKEN_PROGRAM },
              ),
            ]);
            swap.status = 'REFUNDED';
          } else if (funded) {
            zec += swap.amountOut;
            swap.status = 'SUCCESS';
          }
        } else if ((sent.get(depositAddress) ?? 0n) >= swap.amountIn) {
          const to = await findAta(swap.recipient as Address, bed.vault.usdcMint, TOKEN_PROGRAM);
          await bed.sendDirect(bed.admin, [
            getCreateAssociatedTokenIdempotentInstruction({
              payer: bed.admin,
              ata: to,
              owner: swap.recipient as Address,
              mint: bed.vault.usdcMint,
              tokenProgram: TOKEN_PROGRAM,
            }),
            getMintToInstruction(
              {
                mint: bed.vault.usdcMint,
                token: to,
                mintAuthority: bed.admin,
                amount: swap.amountOut,
              },
              { programAddress: TOKEN_PROGRAM },
            ),
          ]);
          swap.status = 'SUCCESS';
        }
      }
      return {
        status: swap.status,
        amountOut: swap.status === 'SUCCESS' ? swap.amountOut.toString() : null,
        refunded: swap.status === 'REFUNDED',
      };
    },

    async submitDeposit() {},
  };

  const zcash: ZcashWallet = {
    async newAddress() {
      return `u1fake${Math.random().toString(36).slice(2)}`;
    },
    async spendable() {
      return zec;
    },
    async send(to, zatoshis) {
      if (zatoshis > zec) throw new Error('insufficient ZEC');
      zec -= zatoshis;
      sent.set(to, (sent.get(to) ?? 0n) + zatoshis);
      return `txid${sent.size}`;
    },
  };

  return { oneClick, zcash, zecBalance: () => zec };
}

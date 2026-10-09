import type { Testbed } from '../../../../packages/core/test/support/testbed.js';
import { ChainError, type Chain } from '../../src/chain/chain.js';

/** The API's Chain, backed by a LiteSVM testbed instead of an RPC node. */
export function litesvmChain(bed: Testbed): Chain {
  return {
    feePayer: bed.feePayer.address,
    feePayerSigner: bed.feePayer,
    async getAccountData(a) {
      return bed.account(a);
    },
    async getRentTable() {
      return bed.rent;
    },
    async getMinimumBalance(space) {
      return bed.svm.minimumBalanceForRentExemption(space);
    },
    async getLatestBlockhash() {
      bed.svm.expireBlockhash();
      return bed.blockhash() as never;
    },
    async signAndSend(tx) {
      try {
        return await bed.sendAsFeePayer(tx);
      } catch (e) {
        throw new ChainError((e as Error).message, (e as { logs?: string[] }).logs ?? []);
      }
    },
    async sendAsFeePayer(instructions) {
      await bed.sendDirect(bed.feePayer, instructions);
      return '';
    },
  };
}

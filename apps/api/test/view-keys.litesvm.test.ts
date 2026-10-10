/**
 * View keys end to end: the owner issues one, the auditor exports and
 * decrypts it with no Vexa account, new transfers are synced in, and
 * revoking cuts access. The API only ever handles encrypted records.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { exportAudit, Vexa } from '@vexa/sdk';
import { signWithSolanaSeed } from '@vexa/core/crypto';
import {
  createTestbed,
  vaultBinaryExists,
  type Testbed,
  type Wallet,
} from '../../../packages/core/test/support/testbed.js';
import { litesvmChain } from './support/litesvm.js';
import { sessionToken, testApp } from './helpers.js';

const USDC = 1_000_000n;

describe.skipIf(!vaultBinaryExists())(
  'view keys over HTTP, on LiteSVM',
  { timeout: 120_000 },
  () => {
    let bed: Testbed;
    let api: ReturnType<typeof testApp>;
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      return api.app.request(url.pathname + url.search, init);
    }) as typeof globalThis.fetch;

    async function person(handle: string, usdc: bigint): Promise<{ wallet: Wallet; vexa: Vexa }> {
      const wallet = await bed.newWallet(usdc);
      const vexa = new Vexa({
        accessToken: sessionToken(randomUUID()),
        baseUrl: 'http://api.test',
        maxRetries: 0,
        fetch,
      });
      await vexa.handles.claim(handle, {
        solanaAddress: wallet.signer.address,
        elgamalPubkey: wallet.keys.elgamalPubkey,
        sign: (m) => signWithSolanaSeed(wallet.keys.solanaSeed, m),
      });
      await vexa.money.openAccount(wallet.keys);
      return { wallet, vexa };
    }

    beforeAll(async () => {
      bed = await createTestbed();
      api = testApp({ chain: litesvmChain(bed), vault: bed.vault as never });
    });

    it('lets an auditor read a scoped, revocable history', async () => {
      const alice = await person('alice', 100n * USDC);
      await person('bob', 0n);
      await alice.vexa.money.deposit(100n * USDC, alice.wallet.keys);
      await alice.vexa.money.transfer(
        { to: '@bob', amount: 12_340_000n, memo: 'invoice 7, "Q3"' },
        alice.wallet.keys,
      );

      const from = new Date(Date.now() - 60_000);
      const to = new Date(Date.now() + 3_600_000);
      const { viewKey, recorded } = await alice.vexa.viewKeys.create(
        { from, to, label: 'audit' },
        alice.wallet.keys,
      );
      expect(recorded).toBe(1);
      expect(viewKey).toMatch(/^vxview_/);

      const first = await exportAudit(viewKey, { baseUrl: 'http://api.test', fetch });
      expect(first.signatureValid).toBe(true);
      expect(first.rows).toMatchObject([
        { direction: 'sent', counterparty: 'bob', amount: 12_340_000n, memo: 'invoice 7, "Q3"' },
      ]);
      // What Vexa stored and signed holds no amount or memo in the clear.
      expect(first.signed).not.toContain('12340000');
      expect(first.signed).not.toContain('invoice');
      expect(first.csv).toContain('12.340000');

      // Later transfers join the key when the owner syncs.
      await alice.vexa.money.transfer({ to: '@bob', amount: 1_000_000n }, alice.wallet.keys);
      expect(await alice.vexa.viewKeys.sync(alice.wallet.keys)).toBe(1);
      const second = await exportAudit(viewKey, { baseUrl: 'http://api.test', fetch });
      expect(second.rows.map((r) => r.amount)).toEqual([12_340_000n, 1_000_000n]);

      // A tampered export fails the signature check.
      const res = await api.app.request(
        `/v1/audit/export?viewKey=${encodeURIComponent(viewKey.slice('vxview_'.length).split('.').slice(0, 2).join('.'))}`,
      );
      const { verifyAuditExport, verifyAuditExportMlDsa } = await import('@vexa/core/crypto');
      const signing = (await (await api.app.request('/v1/audit/signing-key')).json()) as {
        publicKey: string;
        keys: { algorithm: string; publicKey: string }[];
      };
      const pqKey = signing.keys.find((k) => k.algorithm === 'ml-dsa-65')!.publicKey;
      const pqSig = res.headers.get('x-vexa-signature-ml-dsa-65')!;
      const body = await res.text();
      expect(verifyAuditExport(body, res.headers.get('x-vexa-signature')!, signing.publicKey)).toBe(
        true,
      );
      // The post-quantum signature covers the same bytes.
      expect(verifyAuditExportMlDsa(body, pqSig, pqKey)).toBe(true);
      expect(
        verifyAuditExport(
          body.replace('sent', 'received'),
          res.headers.get('x-vexa-signature')!,
          signing.publicKey,
        ),
      ).toBe(false);
      expect(verifyAuditExportMlDsa(body.replace('sent', 'received'), pqSig, pqKey)).toBe(false);

      // Bob can't use Alice's view key id with a guessed secret.
      const [id] = viewKey.slice('vxview_'.length).split('.');
      expect(
        (await api.app.request(`/v1/audit/export?viewKey=${id}.11111111111111111111111111111111`))
          .status,
      ).toBe(404);

      await alice.vexa.viewKeys.revoke(id!);
      await expect(exportAudit(viewKey, { baseUrl: 'http://api.test', fetch })).rejects.toThrow(
        /404/,
      );
    });
  },
);

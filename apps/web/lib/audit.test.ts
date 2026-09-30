import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode } from '@vexa/core';
import { deriveViewKey, encodeViewKey, encryptViewRecord } from '@vexa/core/view-keys';
import {
  MSG_INVALID,
  MSG_REVOKED,
  openViewKey,
  parseExport,
  sampleReport,
  splitCsvLine,
  totals,
} from './audit';

describe('splitCsvLine', () => {
  it('handles quoted fields', () => {
    expect(splitCsvLine('a,"b, c","say ""hi""",d')).toEqual(['a', 'b, c', 'say "hi"', 'd']);
  });
});

describe('parseExport', () => {
  it('reads the scope comment and rows', () => {
    const csv = [
      '# vexa audit export; view key abc; scope 2026-01-01T00:00:00.000Z to 2026-06-30T00:00:00.000Z',
      'transfer_id,created_at,direction,counterparty,tx_sig,record',
      't1,2026-02-01T10:00:00.000Z,sent,"@a,b.vexa",sig1,AAAA',
      '',
    ].join('\n');
    const p = parseExport(csv);
    expect(p.keyId).toBe('abc');
    expect(p.scopeFrom?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(p.records).toHaveLength(1);
    expect(p.records[0]?.counterparty).toBe('@a,b.vexa');
  });
});

describe('sampleReport', () => {
  it('adds up to the design figures', () => {
    const t = totals(sampleReport().rows);
    expect(t.sent).toBe(18_420_000_000n);
    expect(t.received).toBe(31_905_500_000n);
  });
});

describe('openViewKey', () => {
  afterEach(() => vi.unstubAllGlobals());

  const id = '4f5c7a1e-9f1b-4c8e-8a2d-3b6f0e9d1c2a';
  const key = deriveViewKey(new Uint8Array(32).fill(7), id);
  const seed = new Uint8Array(32).fill(9);
  const publicKey = base58Encode(ed25519.getPublicKey(seed));

  function exportCsv() {
    const tid = '11111111-2222-4333-8444-555555555555';
    const rec = encryptViewRecord(key.decryptionKey, tid, { amount: 12_500_000n, memo: 'Lunch' });
    const b64 = btoa(String.fromCharCode(...rec));
    return [
      `# vexa audit export; view key ${id}; scope 2026-01-01T00:00:00.000Z to 2026-06-30T00:00:00.000Z`,
      'transfer_id,created_at,direction,counterparty,tx_sig,record',
      `${tid},2026-06-14T12:00:00.000Z,sent,@bob.vexa,5KqSig,${b64}`,
      '',
    ].join('\n');
  }

  it('rejects malformed keys before any request', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(openViewKey('vxview_short')).rejects.toThrow(MSG_INVALID);
    expect(f).not.toHaveBeenCalled();
  });

  it('maps 404 to revoked', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    await expect(openViewKey(encodeViewKey(key))).rejects.toThrow(MSG_REVOKED);
  });

  it('verifies, decrypts and never sends the decryption half', async () => {
    const csv = exportCsv();
    const sig = base58Encode(ed25519.sign(new TextEncoder().encode(csv), seed));
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      if (url.includes('/signing-key')) return Response.json({ publicKey });
      return new Response(csv, { headers: { 'x-vexa-signature': sig } });
    });
    const encoded = encodeViewKey(key);
    const report = await openViewKey(encoded);
    expect(report.signatureValid).toBe(true);
    expect(report.rows[0]?.amount).toBe(12_500_000n);
    expect(report.rows[0]?.memo).toBe('Lunch');
    const decryptHalf = encoded.split('.')[2]!;
    expect(urls.join(' ')).not.toContain(decryptHalf);
  });

  it('flags a bad signature', async () => {
    const csv = exportCsv();
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/signing-key')) return Response.json({ publicKey });
      return new Response(csv, { headers: { 'x-vexa-signature': '1111' } });
    });
    const report = await openViewKey(encodeViewKey(key));
    expect(report.signatureValid).toBe(false);
  });
});

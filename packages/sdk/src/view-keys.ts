/**
 * View keys: give an auditor read access to your transfers in a time range.
 *
 *   const { viewKey } = await vexa.viewKeys.create({ from, to, label: 'FY2026 audit' }, keys);
 *   // hand `viewKey` (vxview_…) to the auditor; later: await vexa.viewKeys.sync(keys)
 *
 *   // the auditor, with no Vexa account:
 *   const { rows, csv, signatureValid } = await exportAudit(viewKey);
 *
 * Amounts and memos are decrypted on your device and re-encrypted to the
 * view key; the auditor decrypts them on theirs. Vexa stores only those
 * ciphertexts and signs what it serves.
 */
import { base64Decode, base64Encode } from '@vexa/core';
import {
  decodeViewKey,
  decryptViewRecord,
  deriveViewKey,
  encodeViewKey,
  encryptViewRecord,
  verifyAuditExport,
  verifyAuditExportMlDsa,
  viewKeyAccessHash,
  viewKeyAccessToken,
  type UserKeys,
} from '@vexa/core/crypto';
import type { RequestOptions } from './http.js';
import type { ActivityTransfer, Money } from './money.js';
import { DEFAULT_BASE_URLS } from './base-urls.js';

type Call = <T>(method: string, path: string, opts?: RequestOptions) => Promise<T>;

export interface ViewKeySummary {
  id: string;
  label: string | null;
  from: string;
  to: string;
  revokedAt: string | null;
  createdAt: string;
}

export class ViewKeys {
  constructor(
    private readonly call: Call,
    private readonly money: Money,
  ) {}

  list(): Promise<ViewKeySummary[]> {
    return this.call<{ data: ViewKeySummary[] }>('GET', '/v1/view-keys').then((r) => r.data);
  }

  /** Issues a view key for transfers in [from, to) and fills it with what's there now. */
  async create(
    input: { from: Date; to: Date; label?: string },
    keys: UserKeys,
  ): Promise<{ id: string; viewKey: string; recorded: number }> {
    const id = crypto.randomUUID();
    const key = deriveViewKey(keys.viewRoot, id);
    await this.call('POST', '/v1/view-keys', {
      body: {
        id,
        from: input.from.toISOString(),
        to: input.to.toISOString(),
        accessHash: viewKeyAccessHash(key.accessSecret),
        ...(input.label ? { label: input.label } : {}),
      },
      idempotencyKey: `view-key:${id}`,
    });
    const recorded = await this.fill(id, keys);
    return { id, viewKey: encodeViewKey(key), recorded };
  }

  /** The view key string for one you issued, again. */
  viewKeyFor(id: string, keys: UserKeys): string {
    return encodeViewKey(deriveViewKey(keys.viewRoot, id));
  }

  /**
   * Adds transfers made since a key was issued (or last synced) to every
   * active key whose scope covers them. Returns how many records were added.
   */
  async sync(keys: UserKeys): Promise<number> {
    const now = new Date();
    let added = 0;
    for (const k of await this.list()) {
      if (k.revokedAt || new Date(k.from) > now) continue;
      added += await this.fill(k.id, keys);
    }
    return added;
  }

  /** Revokes a key. The auditor loses access, and Vexa deletes its records. */
  revoke(id: string): Promise<void> {
    return this.call('DELETE', `/v1/view-keys/${id}`);
  }

  private async fill(id: string, keys: UserKeys): Promise<number> {
    const key = deriveViewKey(keys.viewRoot, id);
    const current = await this.call<ViewKeySummary & { recorded: string[] }>(
      'GET',
      `/v1/view-keys/${id}`,
    );
    const done = new Set(current.recorded);
    const from = new Date(current.from);
    const to = new Date(current.to);

    // Walk activity newest first until we're before the scope.
    const pending: ActivityTransfer[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.money.activity(keys, { limit: 100, before });
      for (const item of page) {
        if (item.kind !== 'transfer') continue;
        const at = new Date(item.createdAt);
        if (at >= from && at < to && !done.has(item.id)) pending.push(item);
      }
      const last = page[page.length - 1];
      if (page.length < 100 || !last || new Date(last.createdAt) < from) break;
      before = last.createdAt;
    }

    let added = 0;
    for (let i = 0; i < pending.length; i += 200) {
      const records = pending.slice(i, i + 200).map((t) => ({
        transferId: t.id,
        record: base64Encode(
          encryptViewRecord(key.decryptionKey, t.id, { amount: t.amount, memo: t.memo }),
        ),
      }));
      const res = await this.call<{ added: number }>('POST', `/v1/view-keys/${id}/records`, {
        body: { records },
        idempotencyKey: true,
      });
      added += res.added;
    }
    return added;
  }
}

export interface AuditRow {
  transferId: string;
  createdAt: string;
  direction: 'sent' | 'received';
  counterparty: string;
  txSig: string | null;
  /** USDC base units. */
  amount: bigint;
  memo: string | null;
}

/**
 * For auditors: fetches a view key's export, checks Vexa's signature on it,
 * and decrypts every row locally. `csv` is the decrypted CSV to keep;
 * `signed` is exactly what Vexa signed (with encrypted records), for proof.
 */
export async function exportAudit(
  viewKey: string,
  opts: { baseUrl?: string; fetch?: typeof fetch } = {},
): Promise<{
  rows: AuditRow[];
  csv: string;
  signed: string;
  signature: string;
  /** The post-quantum ML-DSA-65 signature (base64), or null if the export had none. */
  pqSignature: string | null;
  /** Every signature on the export verified, the ML-DSA-65 one included. */
  signatureValid: boolean;
  /** The ML-DSA-65 signature's own result; null if the export had none. */
  pqSignatureValid: boolean | null;
}> {
  const key = decodeViewKey(viewKey);
  const base = (opts.baseUrl ?? DEFAULT_BASE_URLS.live).replace(/\/$/, '');
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const [exported, signingKey] = await Promise.all([
    f(`${base}/v1/audit/export?viewKey=${encodeURIComponent(viewKeyAccessToken(key))}`),
    f(`${base}/v1/audit/signing-key`).then(
      (r) =>
        r.json() as Promise<{
          publicKey: string;
          keys?: { algorithm: string; publicKey: string }[];
        }>,
    ),
  ]);
  if (!exported.ok) throw new Error(`export failed: ${exported.status}`);
  const signed = await exported.text();
  const signature = exported.headers.get('x-vexa-signature') ?? '';
  const pqSignature = exported.headers.get('x-vexa-signature-ml-dsa-65');
  const pqKey = signingKey.keys?.find((k) => k.algorithm === 'ml-dsa-65')?.publicKey;
  const pqSignatureValid = pqSignature
    ? !!pqKey && verifyAuditExportMlDsa(signed, pqSignature, pqKey)
    : null;
  const signatureValid =
    verifyAuditExport(signed, signature, signingKey.publicKey) && pqSignatureValid !== false;

  const rows: AuditRow[] = [];
  for (const line of signed.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('transfer_id,')) continue;
    // record and tx_sig never contain commas; counterparty may be quoted.
    const parts = line.split(',');
    const [transferId, createdAt, direction] = parts;
    const record = parts[parts.length - 1]!;
    const txSig = parts[parts.length - 2]!;
    const counterparty = parts
      .slice(3, parts.length - 2)
      .join(',')
      .replace(/^"|"$/g, '')
      .replace(/""/g, '"');
    const { amount, memo } = decryptViewRecord(
      key.decryptionKey,
      transferId!,
      base64Decode(record)!,
    );
    rows.push({
      transferId: transferId!,
      createdAt: createdAt!,
      direction: direction as AuditRow['direction'],
      counterparty,
      txSig: txSig || null,
      amount,
      memo,
    });
  }
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const csv = [
    'transfer_id,created_at,direction,counterparty,amount_usdc,memo,tx_sig',
    ...rows.map((r) =>
      [
        r.transferId,
        r.createdAt,
        r.direction,
        esc(r.counterparty),
        (Number(r.amount) / 1e6).toFixed(6),
        esc(r.memo ?? ''),
        r.txSig ?? '',
      ].join(','),
    ),
  ].join('\n');
  return {
    rows,
    csv: `${csv}\n`,
    signed,
    signature,
    pqSignature,
    signatureValid,
    pqSignatureValid,
  };
}

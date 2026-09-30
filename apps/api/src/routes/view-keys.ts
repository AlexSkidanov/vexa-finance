/**
 * View keys and audit exports.
 *
 * The owner's device creates a view key, re-encrypts the transfers in its
 * scope to it and uploads those records; an auditor holding the key fetches
 * them as a signed CSV and decrypts them locally. The API stores and serves
 * ciphertext it can't read: it never has a view key's decryption half.
 */
import { Hono } from 'hono';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  AddViewRecordsRequest,
  base58Decode,
  base58Encode,
  base64Decode,
  base64Encode,
  CreateViewKeyRequest,
  hexToBytes,
} from '@vexa/core';
import { notFound } from '../errors.js';
import type { AppBindings, Deps } from '../context.js';
import type { ViewKeyRow } from '../store/types.js';
import { authenticate, principalOf } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';
import { parseBody } from '../lib/validate.js';

/** The Ed25519 key that signs exports, derived from VIEW_KEY_ENCRYPTION_KEY. */
function signingKey(env: Deps['env']) {
  const seed = hkdf(
    sha256,
    hexToBytes(env.VIEW_KEY_ENCRYPTION_KEY),
    new TextEncoder().encode('vexa.finance'),
    new TextEncoder().encode('vexa/audit-signing/v1'),
    32,
  );
  return { seed, publicKey: base58Encode(ed25519.getPublicKey(seed)) };
}

const view = (v: ViewKeyRow) => ({
  id: v.id,
  label: v.label,
  from: v.scopeFrom.toISOString(),
  to: v.scopeTo.toISOString(),
  revokedAt: v.revokedAt?.toISOString() ?? null,
  createdAt: v.createdAt.toISOString(),
});

const csvField = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export const viewKeys = new Hono<AppBindings>()
  .post('/', authenticate(), idempotent(), async (c) => {
    const body = await parseBody(c, CreateViewKeyRequest);
    const key = await c.get('deps').store.viewKeys.create({
      id: body.id,
      ownerId: principalOf(c).userId,
      label: body.label ?? null,
      scopeFrom: new Date(body.from),
      scopeTo: new Date(body.to),
      accessHash: body.accessHash,
    });
    return c.json(view(key), 201);
  })

  .get('/', authenticate(), async (c) => {
    const keys = await c.get('deps').store.viewKeys.list(principalOf(c).userId);
    return c.json({ data: keys.map(view) });
  })

  /** The key and which transfers it already covers, so the owner's device can fill in the rest. */
  .get('/:id', authenticate(), async (c) => {
    const { store } = c.get('deps');
    const key = await store.viewKeys.get(principalOf(c).userId, c.req.param('id'));
    if (!key) throw notFound('View key');
    return c.json({ ...view(key), recorded: await store.viewKeys.recordedTransferIds(key.id) });
  })

  .post('/:id/records', authenticate(), idempotent(), async (c) => {
    const { store } = c.get('deps');
    const key = await store.viewKeys.get(principalOf(c).userId, c.req.param('id'));
    if (!key || key.revokedAt) throw notFound('View key');
    const body = await parseBody(c, AddViewRecordsRequest);
    const added = await store.viewKeys.addRecords(
      key,
      body.records.map((r) => ({ transferId: r.transferId, record: base64Decode(r.record)! })),
    );
    return c.json({ added }, 201);
  })

  /** Revokes the key for good and deletes everything it could read. */
  .delete('/:id', authenticate(), async (c) => {
    const revoked = await c
      .get('deps')
      .store.viewKeys.revoke(principalOf(c).userId, c.req.param('id'));
    if (!revoked) throw notFound('View key');
    return c.body(null, 204);
  });

export const audit = new Hono<AppBindings>()
  /** The public key audit exports are signed with. */
  .get('/signing-key', (c) =>
    c.json({ algorithm: 'ed25519', publicKey: signingKey(c.get('deps').env).publicKey }),
  )

  /**
   * GET /v1/audit/export?viewKey=<id>.<access secret>
   *
   * No other authentication: the access secret is the credential. Returns a
   * CSV of the transfers in scope, each with its record still encrypted to
   * the view key, and an Ed25519 signature over the body in `X-Vexa-Signature`.
   */
  .get('/export', async (c) => {
    const { store, env } = c.get('deps');
    const [, access] = (c.req.query('viewKey') ?? '').split('.');
    const secret = access ? base58Decode(access) : null;
    const key = secret ? await store.viewKeys.byAccessHash(bytesToHex(sha256(secret))) : null;
    if (!key) throw notFound('View key');

    const rows = await store.viewKeys.exportRows(key);
    const lines = [
      `# vexa audit export; view key ${key.id}; scope ${key.scopeFrom.toISOString()} to ${key.scopeTo.toISOString()}`,
      'transfer_id,created_at,direction,counterparty,tx_sig,record',
      ...rows.map((r) =>
        [
          r.transferId,
          r.createdAt.toISOString(),
          r.direction,
          csvField(r.counterparty),
          r.txSig ?? '',
          base64Encode(r.record),
        ].join(','),
      ),
    ];
    const csv = `${lines.join('\n')}\n`;
    const { seed } = signingKey(env);
    const signature = base58Encode(ed25519.sign(new TextEncoder().encode(csv), seed));
    return c.body(csv, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'x-vexa-signature': signature,
      'cache-control': 'no-store',
    });
  });

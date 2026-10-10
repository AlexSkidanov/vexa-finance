/**
 * The audit portal: opens a view key in this browser, fetches the signed
 * export, checks the signature and decrypts each record locally. The key and
 * the decrypted rows live in memory only; nothing is persisted or logged.
 */
import {
  decodeViewKey,
  decryptViewRecord,
  verifyAuditExport,
  verifyAuditExportMlDsa,
  viewKeyAccessToken,
} from '@vexa/core/view-keys';
import type { ViewKey } from '@vexa/core/view-keys';
import { formatUsdc } from './format';
import { API_URL } from './site';

/** Real keys are `vxview_<uuid>.<base58>.<base58>`. */
export const VIEW_KEY_RE = /^vxview_[A-Za-z0-9_.-]{24,}$/;

export const MSG_INVALID =
  'That does not look like a view key. Keys start with vxview_ and are at least 32 characters.';
export const MSG_REVOKED = "This view key was revoked or doesn't exist.";
export const MSG_NETWORK = "Couldn't reach Vexa right now. Check your connection and try again.";

export class AuditError extends Error {}

export interface AuditRow {
  transferId: string;
  createdAt: Date;
  direction: 'sent' | 'received';
  counterparty: string;
  txSig: string | null;
  /** USDC base units; null if this record didn't decrypt. */
  amount: bigint | null;
  memo: string | null;
}

export interface AuditReport {
  sample: boolean;
  keyId: string;
  scopeFrom: Date | null;
  scopeTo: Date | null;
  rows: AuditRow[];
  /** Every signature the export carries checked out, including the post-quantum one. */
  signatureValid: boolean;
  /** The ML-DSA-65 signature's result; null if the export didn't carry one. */
  pqSignatureValid: boolean | null;
  /** The export exactly as received, and its signatures, for "Download signed original". */
  rawCsv: string | null;
  signature: string | null;
  publicKey: string | null;
  pqSignature: string | null;
  pqPublicKey: string | null;
}

/* ── In-memory store shared by /audit and /audit/report ── */

let current: AuditReport | null = null;
export const getReport = () => current;
export const setReport = (r: AuditReport | null) => {
  current = r;
};

/* ── CSV ── */

/** Splits one CSV line, honouring double-quoted fields. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out;
}

export interface ParsedExport {
  keyId: string | null;
  scopeFrom: Date | null;
  scopeTo: Date | null;
  records: {
    transferId: string;
    createdAt: Date;
    direction: 'sent' | 'received';
    counterparty: string;
    txSig: string | null;
    record: string;
  }[];
}

const SCOPE_RE = /view key ([^;]+);\s*scope (\S+) to (\S+)/;

export function parseExport(csv: string): ParsedExport {
  const lines = csv.split(/\r?\n/).filter((l) => l.length > 0);
  let keyId: string | null = null;
  let scopeFrom: Date | null = null;
  let scopeTo: Date | null = null;
  const records: ParsedExport['records'] = [];
  let header: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith('#')) {
      const m = SCOPE_RE.exec(line);
      if (m && !keyId) {
        keyId = m[1]!.trim();
        scopeFrom = validDate(m[2]!);
        scopeTo = validDate(m[3]!);
      }
      continue;
    }
    const cells = splitCsvLine(line);
    if (!header) {
      header = cells;
      continue;
    }
    const get = (name: string) => cells[header!.indexOf(name)] ?? '';
    const createdAt = validDate(get('created_at'));
    const direction = get('direction');
    if (!createdAt || (direction !== 'sent' && direction !== 'received')) continue;
    records.push({
      transferId: get('transfer_id'),
      createdAt,
      direction,
      counterparty: get('counterparty'),
      txSig: get('tx_sig') || null,
      record: get('record'),
    });
  }
  return { keyId, scopeFrom, scopeTo, records };
}

function validDate(s: string): Date | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ── Opening a key ── */

export async function openViewKey(input: string): Promise<AuditReport> {
  const text = input.trim();
  if (!VIEW_KEY_RE.test(text)) throw new AuditError(MSG_INVALID);
  let key: ViewKey;
  try {
    key = decodeViewKey(text);
  } catch {
    throw new AuditError(MSG_INVALID);
  }

  let exportRes: Response;
  let keyRes: Response;
  try {
    [exportRes, keyRes] = await Promise.all([
      fetch(`${API_URL}/v1/audit/export?viewKey=${encodeURIComponent(viewKeyAccessToken(key))}`, {
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }),
      fetch(`${API_URL}/v1/audit/signing-key`, { cache: 'no-store', credentials: 'omit' }),
    ]);
  } catch {
    throw new AuditError(MSG_NETWORK);
  }
  if (exportRes.status === 404) throw new AuditError(MSG_REVOKED);
  if (!exportRes.ok) throw new AuditError(MSG_NETWORK);

  const csv = await exportRes.text();
  const signature = exportRes.headers.get('x-vexa-signature');
  const pqSignature = exportRes.headers.get('x-vexa-signature-ml-dsa-65');
  let publicKey: string | null = null;
  let pqPublicKey: string | null = null;
  if (keyRes.ok) {
    const body = (await keyRes.json().catch(() => null)) as {
      publicKey?: unknown;
      keys?: { algorithm?: unknown; publicKey?: unknown }[];
    } | null;
    if (body && typeof body.publicKey === 'string') publicKey = body.publicKey;
    const pq = Array.isArray(body?.keys)
      ? body.keys.find((k) => k?.algorithm === 'ml-dsa-65')
      : undefined;
    if (pq && typeof pq.publicKey === 'string') pqPublicKey = pq.publicKey;
  }
  const edValid = !!signature && !!publicKey && verifyAuditExport(csv, signature, publicKey);
  const pqSignatureValid = pqSignature
    ? !!pqPublicKey && verifyAuditExportMlDsa(csv, pqSignature, pqPublicKey)
    : null;
  const signatureValid = edValid && pqSignatureValid !== false;

  const parsed = parseExport(csv);
  const rows: AuditRow[] = parsed.records.map((r) => {
    let amount: bigint | null = null;
    let memo: string | null = null;
    try {
      const rec = decryptViewRecord(key.decryptionKey, r.transferId, base64ToBytes(r.record));
      amount = rec.amount;
      memo = rec.memo;
    } catch {
      // Left as undecrypted; the report counts it.
    }
    return {
      transferId: r.transferId,
      createdAt: r.createdAt,
      direction: r.direction,
      counterparty: r.counterparty,
      txSig: r.txSig,
      amount,
      memo,
    };
  });
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return {
    sample: false,
    keyId: parsed.keyId ?? key.id,
    scopeFrom: parsed.scopeFrom,
    scopeTo: parsed.scopeTo,
    rows,
    signatureValid,
    pqSignatureValid,
    rawCsv: csv,
    signature,
    publicKey,
    pqSignature,
    pqPublicKey,
  };
}

/* ── Totals and downloads ── */

export function totals(rows: AuditRow[]) {
  let sent = 0n;
  let received = 0n;
  let decrypted = 0;
  for (const r of rows) {
    if (r.amount === null) continue;
    decrypted++;
    if (r.direction === 'sent') sent += r.amount;
    else received += r.amount;
  }
  return { sent, received, decrypted };
}

const csvField = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function decryptedCsv(report: AuditReport): string {
  const head = [
    `# vexa audit report; view key ${report.keyId}; decrypted in the browser${report.sample ? '; SAMPLE DATA' : ''}`,
    'date,direction,counterparty,amount_usdc,memo,tx_sig,transfer_id',
  ];
  const body = report.rows.map((r) =>
    [
      r.createdAt.toISOString(),
      r.direction,
      csvField(r.counterparty),
      r.amount === null ? '' : formatUsdc(r.amount).replace(/,/g, ''),
      csvField(r.memo ?? ''),
      r.txSig ?? '',
      r.transferId,
    ].join(','),
  );
  return `${[...head, ...body].join('\n')}\n`;
}

export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── Sample data (local, never from the API) ── */

const usdc = (s: string) => BigInt(Math.round(parseFloat(s) * 100)) * 10_000n;

export function sampleReport(): AuditReport {
  const rows: [string, 'sent' | 'received', string, string, string, string][] = [
    ['2026-06-28', 'received', '@studio-north.vexa', '4200.00', 'June retainer', '5Kq…e2a'],
    ['2026-06-14', 'sent', '@bob.vexa', '12.50', 'Lunch', '3Hm…c91'],
    ['2026-05-31', 'received', '@studio-north.vexa', '4200.00', 'May retainer', '9Tz…a4d'],
    ['2026-05-02', 'sent', '@rent.vexa', '1850.00', 'May rent', '7Fx…0b7'],
    ['2026-04-30', 'received', '@studio-north.vexa', '4200.00', 'April retainer', '2Qp…d3e'],
    ['2026-04-02', 'sent', '@rent.vexa', '1850.00', 'April rent', '8Lw…f61'],
    ['2026-03-15', 'received', '@studio-north.vexa', '19305.50', 'Q1 project', '4Nr…b2c'],
    ['2026-01-06', 'sent', '7f3aQ…c91e', '14707.50', 'Withdrawal to exchange', '6Vd…88a'],
  ];
  return {
    sample: true,
    keyId: 'sample',
    scopeFrom: new Date('2026-01-01T00:00:00Z'),
    scopeTo: new Date('2026-06-30T00:00:00Z'),
    rows: rows.map(([date, direction, counterparty, amount, memo, tx], i) => ({
      transferId: `sample-${i + 1}`,
      createdAt: new Date(`${date}T12:00:00Z`),
      direction,
      counterparty,
      // Sample rows have no real transaction; the short form is shown unlinked.
      txSig: tx,
      amount: usdc(amount),
      memo,
    })),
    signatureValid: false,
    pqSignatureValid: null,
    rawCsv: null,
    signature: null,
    publicKey: null,
    pqSignature: null,
    pqPublicKey: null,
  };
}

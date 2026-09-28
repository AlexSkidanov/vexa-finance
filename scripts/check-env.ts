/**
 * pnpm check-env
 *
 * Validates every value in .env and probes each external dependency
 * (Supabase, Postgres, Alchemy/Solana, NEAR, NEAR Intents, GitHub).
 * Prints a pass/fail table and exits non-zero if anything required fails.
 *
 * Usage: pnpm check-env [--env path/to/.env]
 *
 * Secret values are never printed: every detail string is passed through
 * redact() before output.
 */
import { createHmac, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { z } from 'zod';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFlag = process.argv.indexOf('--env');
const ENV_PATH =
  envFlag > -1 && process.argv[envFlag + 1]
    ? resolve(process.argv[envFlag + 1]!)
    : resolve(ROOT, '.env');
const TIMEOUT_MS = 12_000;

// ---------------------------------------------------------------------------
// Well-known constants
// ---------------------------------------------------------------------------

const SOLANA_GENESIS: Record<string, string> = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};
const CANONICAL_USDC: Record<string, string> = {
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ZK_ELGAMAL_PROOF_PROGRAM = 'ZkE1Gama1Proof11111111111111111111111111111';
const NEAR_CHAIN_ID: Record<string, string> = { testnet: 'testnet', mainnet: 'mainnet' };
const CANONICAL_MPC: Record<string, string> = {
  testnet: 'v1.signer-prod.testnet',
  mainnet: 'v1.signer',
};
const MPC_ED25519_DOMAIN_ID = 1;
const LAMPORTS_PER_SOL = 1_000_000_000;

// ---------------------------------------------------------------------------
// Base58 + ed25519 helpers (no extra deps)
// ---------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map([...B58].map((c, i) => [c, i]));

function b58decode(s: string): Uint8Array | null {
  if (!s) return null;
  let n = 0n;
  for (const c of s) {
    const v = B58_MAP.get(c);
    if (v === undefined) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function ed25519PubFromSeed(seed: Uint8Array): Uint8Array {
  const priv = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  const jwk = createPublicKey(priv).export({ format: 'jwk' });
  return Buffer.from(jwk.x as string, 'base64url');
}

function isPubkey(s: string): boolean {
  return b58decode(s)?.length === 32;
}

/** Accepts base58 64-byte secret key, or a solana-keygen JSON array. Returns pubkey or null. */
function solanaKeypairPubkey(raw: string): string | null {
  let bytes: Uint8Array | null = null;
  const s = raw.trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) bytes = Uint8Array.from(arr);
    } catch {
      return null;
    }
  } else {
    bytes = b58decode(s);
  }
  if (!bytes || bytes.length !== 64) return null;
  const derived = ed25519PubFromSeed(bytes.subarray(0, 32));
  if (!Buffer.from(derived).equals(Buffer.from(bytes.subarray(32)))) return null;
  return b58encode(derived);
}

/** Accepts ed25519:<base58> with 64-byte (seed||pub) or 32-byte (seed) payload. Returns NEAR public key string or null. */
function nearKeyPublic(raw: string): string | null {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(raw.trim());
  if (!m) return null;
  const bytes = b58decode(m[1]!);
  if (!bytes || (bytes.length !== 64 && bytes.length !== 32)) return null;
  const derived = ed25519PubFromSeed(bytes.subarray(0, 32));
  if (bytes.length === 64 && !Buffer.from(derived).equals(Buffer.from(bytes.subarray(32))))
    return null;
  return `ed25519:${b58encode(derived)}`;
}

function decodeJwt(token: string): { header: any; payload: any; parts: string[] } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()),
      payload: JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()),
      parts,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Env spec
// ---------------------------------------------------------------------------

type Level = 'required' | 'later' | 'optional';
interface Spec {
  group: string;
  key: string;
  level: Level;
  schema: z.ZodTypeAny;
  secret?: boolean;
  note?: string;
}

const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes hex (64 chars); use `openssl rand -hex 32`');
const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u), 'must be http(s)');
const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), 'must be https');
const pubkey = z.string().refine(isPubkey, 'not a base58 32-byte Solana public key');
const solKeypair = z
  .string()
  .refine(
    (s) => solanaKeypairPubkey(s) !== null,
    'not a valid 64-byte ed25519 keypair (base58 or JSON array); pubkey half must match secret half',
  );
const nearAccount = z
  .string()
  .regex(
    /^(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*$/,
    'not a valid NEAR account id',
  );
const any = z.string();

const SPECS: Spec[] = [
  // App
  {
    group: 'App',
    key: 'NODE_ENV',
    level: 'required',
    schema: z.enum(['development', 'test', 'production']),
  },
  {
    group: 'App',
    key: 'PORT',
    level: 'required',
    schema: z.coerce.number().int().min(1).max(65535),
  },
  {
    group: 'App',
    key: 'LOG_LEVEL',
    level: 'required',
    schema: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']),
  },
  { group: 'App', key: 'API_BASE_URL', level: 'required', schema: httpUrl },
  { group: 'App', key: 'API_KEY_ENCRYPTION_KEY', level: 'required', schema: hex32, secret: true },
  {
    group: 'App',
    key: 'WEBHOOK_SIGNING_SECRET',
    level: 'required',
    schema: z.string().min(32, 'must be at least 32 chars'),
    secret: true,
  },
  { group: 'App', key: 'VIEW_KEY_ENCRYPTION_KEY', level: 'required', schema: hex32, secret: true },
  {
    group: 'App',
    key: 'WEBAUTHN_RP_ID',
    level: 'required',
    schema: z.string().regex(/^[a-z0-9.-]+$/, 'must be a bare hostname, no scheme/port'),
  },
  { group: 'App', key: 'WEBAUTHN_RP_NAME', level: 'required', schema: z.string().min(1) },
  {
    group: 'App',
    key: 'WEBAUTHN_ORIGINS',
    level: 'required',
    schema: z
      .string()
      .refine(
        (s) => s.split(',').every((o) => httpUrl.safeParse(o.trim()).success),
        'comma-separated list of http(s) origins',
      ),
  },
  // Supabase
  { group: 'Supabase', key: 'SUPABASE_URL', level: 'required', schema: httpsUrl },
  {
    group: 'Supabase',
    key: 'SUPABASE_ANON_KEY',
    level: 'required',
    schema: z.string().min(20),
    secret: true,
  },
  {
    group: 'Supabase',
    key: 'SUPABASE_SERVICE_ROLE_KEY',
    level: 'required',
    schema: z.string().min(20),
    secret: true,
  },
  {
    group: 'Supabase',
    key: 'SUPABASE_DB_URL',
    level: 'required',
    schema: z.string().regex(/^postgres(ql)?:\/\//, 'must start with postgresql://'),
    secret: true,
  },
  // Required-ness depends on the key style; decided in the Supabase probe.
  {
    group: 'Supabase',
    key: 'SUPABASE_JWT_SECRET',
    level: 'optional',
    schema: z.string().min(32),
    secret: true,
  },
  // Alchemy
  {
    group: 'Alchemy',
    key: 'ALCHEMY_SOLANA_RPC_URL',
    level: 'required',
    schema: httpsUrl,
    secret: true,
  },
  {
    group: 'Alchemy',
    key: 'ALCHEMY_WEBHOOK_SIGNING_KEY',
    level: 'required',
    schema: z.string().min(16),
    secret: true,
  },
  {
    group: 'Alchemy',
    key: 'ALCHEMY_WEBHOOK_ID',
    level: 'later',
    schema: z.string().regex(/^wh_/, 'expected wh_...'),
    note: 'Phase 2',
  },
  {
    group: 'Alchemy',
    key: 'ALCHEMY_NOTIFY_AUTH_TOKEN',
    level: 'later',
    schema: z.string().min(16),
    secret: true,
    note: 'Phase 2',
  },
  // Solana
  {
    group: 'Solana',
    key: 'SOLANA_CLUSTER',
    level: 'required',
    schema: z.enum(['devnet', 'mainnet-beta']),
  },
  {
    group: 'Solana',
    key: 'SOLANA_FEE_PAYER_KEYPAIR',
    level: 'required',
    schema: solKeypair,
    secret: true,
  },
  {
    group: 'Solana',
    key: 'SOLANA_ADMIN_KEYPAIR',
    level: 'required',
    schema: solKeypair,
    secret: true,
  },
  { group: 'Solana', key: 'USDC_MINT', level: 'required', schema: pubkey },
  {
    group: 'Solana',
    key: 'VAULT_PROGRAM_ID',
    level: 'later',
    schema: pubkey,
    note: 'Phase 1 (anchor deploy)',
  },
  {
    group: 'Solana',
    key: 'CUSDC_MINT',
    level: 'later',
    schema: pubkey,
    note: 'Phase 1 (vault init)',
  },
  { group: 'Solana', key: 'VEXA_TOKEN_MINT', level: 'later', schema: pubkey, note: 'Phase 3' },
  {
    group: 'Solana',
    key: 'TREASURY_OWNER_PUBKEY',
    level: 'later',
    schema: pubkey,
    note: 'Phase 2',
  },
  {
    group: 'Solana',
    key: 'FEE_PAYER_MIN_SOL',
    level: 'optional',
    schema: z.coerce.number().positive(),
  },
  {
    group: 'Solana',
    key: 'ADMIN_MIN_SOL',
    level: 'optional',
    schema: z.coerce.number().nonnegative(),
  },
  // NEAR
  { group: 'NEAR', key: 'NEAR_NETWORK', level: 'required', schema: z.enum(['testnet', 'mainnet']) },
  { group: 'NEAR', key: 'NEAR_RPC_URL', level: 'required', schema: httpsUrl, secret: true },
  { group: 'NEAR', key: 'NEAR_DEPLOYER_ACCOUNT_ID', level: 'required', schema: nearAccount },
  {
    group: 'NEAR',
    key: 'NEAR_DEPLOYER_PRIVATE_KEY',
    level: 'required',
    schema: z
      .string()
      .refine((s) => nearKeyPublic(s) !== null, 'must be ed25519:<base58> (64-byte secret key)'),
    secret: true,
  },
  {
    group: 'NEAR',
    key: 'NEAR_POLICY_CONTRACT_ID',
    level: 'later',
    schema: nearAccount,
    note: 'Phase 3',
  },
  { group: 'NEAR', key: 'NEAR_MPC_CONTRACT_ID', level: 'required', schema: nearAccount },
  {
    group: 'NEAR',
    key: 'NEAR_DEPLOYER_MIN_NEAR',
    level: 'optional',
    schema: z.coerce.number().nonnegative(),
  },
  // Intents
  { group: 'NEAR Intents', key: 'INTENTS_1CLICK_BASE_URL', level: 'required', schema: httpsUrl },
  {
    group: 'NEAR Intents',
    key: 'INTENTS_1CLICK_JWT',
    level: 'optional',
    schema: z.string().min(20),
    secret: true,
  },
  // Zcash
  {
    group: 'Zcash',
    key: 'ZCASH_NETWORK',
    level: 'later',
    schema: z.enum(['mainnet', 'testnet']),
    note: 'Phase 3',
  },
  {
    group: 'Zcash',
    key: 'ZCASH_WALLET_RPC_URL',
    level: 'later',
    schema: httpUrl,
    secret: true,
    note: 'Phase 3',
  },
  { group: 'Zcash', key: 'ZCASH_WALLET_RPC_USER', level: 'later', schema: any, note: 'Phase 3' },
  {
    group: 'Zcash',
    key: 'ZCASH_WALLET_RPC_PASSWORD',
    level: 'later',
    schema: any,
    secret: true,
    note: 'Phase 3',
  },
  // CI / deploy / stubs
  {
    group: 'GitHub',
    key: 'GITHUB_TOKEN',
    level: 'optional',
    schema: z.string().min(20),
    secret: true,
  },
  {
    group: 'Railway',
    key: 'RAILWAY_TOKEN',
    level: 'optional',
    schema: z.string().min(10),
    secret: true,
  },
  { group: 'Stubs', key: 'CARD_ISSUER_API_KEY', level: 'optional', schema: any, secret: true },
  { group: 'Stubs', key: 'KYC_PROVIDER_API_KEY', level: 'optional', schema: any, secret: true },
];

// ---------------------------------------------------------------------------
// Result table
// ---------------------------------------------------------------------------

type Status = 'PASS' | 'FAIL' | 'WARN' | 'PENDING' | 'SKIP';
interface Row {
  group: string;
  check: string;
  status: Status;
  detail: string;
}

const env: Record<string, string> = {};
const valid = new Set<string>();

function v(key: string): string {
  return env[key] ?? '';
}

let secretValues: string[] = [];
function redact(s: string): string {
  let out = s;
  for (const sv of secretValues) out = out.split(sv).join('***');
  // Belt and braces: API keys embedded in URL paths.
  return out.replace(/(\/v2\/)[A-Za-z0-9_-]{8,}/g, '$1***');
}

function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as any).cause;
    const c = cause?.code ?? cause?.message;
    return c ? `${e.message} (${c})` : e.message;
  }
  return String(e);
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body };
}

async function rpc<T = any>(url: string, method: string, params: unknown): Promise<T> {
  const { status, body } = await fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  if (body?.error) {
    const e = body.error;
    throw new Error(
      e.cause?.name ??
        (typeof e.data === 'string' ? e.data : null) ??
        e.message ??
        JSON.stringify(e),
    );
  }
  if (body?.result?.error) throw new Error(String(body.result.error));
  return body.result as T;
}

function blocked(group: string, check: string, keys: string[]): Row | null {
  const bad = keys.filter((k) => !valid.has(k));
  return bad.length
    ? { group, check, status: 'SKIP', detail: `blocked: fix ${bad.join(', ')} first` }
    : null;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function probeSupabase(): Promise<Row[]> {
  const G = 'Supabase';
  const rows: Row[] = [];
  const b = blocked(G, 'API reachable', [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]);
  if (b) return [b];

  const url = v('SUPABASE_URL').replace(/\/$/, '');
  const anon = v('SUPABASE_ANON_KEY');
  const service = v('SUPABASE_SERVICE_ROLE_KEY');
  const projectRef = new URL(url).hostname.split('.')[0];

  // Key roles
  const anonJwt = decodeJwt(anon);
  const serviceJwt = decodeJwt(service);
  if (anon === service) {
    rows.push({
      group: G,
      check: 'Key roles',
      status: 'FAIL',
      detail: 'anon and service role keys are identical',
    });
  } else if (anonJwt && serviceJwt) {
    const problems: string[] = [];
    if (anonJwt.payload.role !== 'anon')
      problems.push(`SUPABASE_ANON_KEY has role "${anonJwt.payload.role}"`);
    if (serviceJwt.payload.role !== 'service_role')
      problems.push(`SUPABASE_SERVICE_ROLE_KEY has role "${serviceJwt.payload.role}"`);
    if (anonJwt.payload.ref && anonJwt.payload.ref !== projectRef)
      problems.push(`anon key is for project ${anonJwt.payload.ref}, URL is ${projectRef}`);
    if (serviceJwt.payload.ref && serviceJwt.payload.ref !== projectRef)
      problems.push(`service key is for project ${serviceJwt.payload.ref}`);
    rows.push({
      group: G,
      check: 'Key roles',
      status: problems.length ? 'FAIL' : 'PASS',
      detail: problems.join('; ') || `legacy JWT keys, project ${projectRef}`,
    });
  } else if (anon.startsWith('sb_publishable_') && service.startsWith('sb_secret_')) {
    rows.push({
      group: G,
      check: 'Key roles',
      status: 'PASS',
      detail: 'new-style publishable/secret keys',
    });
  } else {
    rows.push({
      group: G,
      check: 'Key roles',
      status: 'WARN',
      detail:
        'mixed or unrecognised key formats; expected two legacy JWTs or sb_publishable_/sb_secret_',
    });
  }

  // Auth health
  try {
    const { status } = await fetchJson(`${url}/auth/v1/health`, { headers: { apikey: anon } });
    rows.push({
      group: G,
      check: 'Auth API (anon key)',
      status: status === 200 ? 'PASS' : 'FAIL',
      detail: `GET /auth/v1/health -> ${status}`,
    });
  } catch (e) {
    rows.push({ group: G, check: 'Auth API (anon key)', status: 'FAIL', detail: errMsg(e) });
  }

  // Service role against PostgREST
  try {
    const headers: Record<string, string> = { apikey: service };
    if (serviceJwt) headers.authorization = `Bearer ${service}`;
    const { status } = await fetchJson(`${url}/rest/v1/`, { headers });
    rows.push({
      group: G,
      check: 'REST API (service key)',
      status: status === 200 ? 'PASS' : 'FAIL',
      detail: `GET /rest/v1/ -> ${status}`,
    });
  } catch (e) {
    rows.push({ group: G, check: 'REST API (service key)', status: 'FAIL', detail: errMsg(e) });
  }

  // JWT secret / signing keys
  const secret = v('SUPABASE_JWT_SECRET');
  if (anonJwt && anonJwt.header.alg === 'HS256') {
    if (!secret) {
      rows.push({
        group: G,
        check: 'JWT secret',
        status: 'FAIL',
        detail: 'project uses legacy HS256 keys; SUPABASE_JWT_SECRET is required',
      });
    } else {
      const sig = createHmac('sha256', secret)
        .update(`${anonJwt.parts[0]}.${anonJwt.parts[1]}`)
        .digest('base64url');
      rows.push({
        group: G,
        check: 'JWT secret',
        status: sig === anonJwt.parts[2] ? 'PASS' : 'FAIL',
        detail:
          sig === anonJwt.parts[2]
            ? 'verifies the anon key signature'
            : 'does not verify the anon key: wrong secret or wrong project',
      });
    }
  } else {
    try {
      const { status, body } = await fetchJson(`${url}/auth/v1/.well-known/jwks.json`, {
        headers: { apikey: anon },
      });
      const n = Array.isArray(body?.keys) ? body.keys.length : 0;
      if (status === 200 && n > 0) {
        rows.push({
          group: G,
          check: 'JWT signing keys',
          status: 'PASS',
          detail: `${n} asymmetric key(s) in JWKS; API will verify via JWKS`,
        });
      } else if (secret) {
        rows.push({
          group: G,
          check: 'JWT signing keys',
          status: 'PASS',
          detail: 'no JWKS keys; will verify with SUPABASE_JWT_SECRET (not verifiable here)',
        });
      } else {
        rows.push({
          group: G,
          check: 'JWT signing keys',
          status: 'FAIL',
          detail: 'no JWKS keys and no SUPABASE_JWT_SECRET; set the legacy secret',
        });
      }
    } catch (e) {
      rows.push({ group: G, check: 'JWT signing keys', status: 'FAIL', detail: errMsg(e) });
    }
  }

  // Postgres
  if (!valid.has('SUPABASE_DB_URL')) {
    rows.push(blocked(G, 'Postgres connection', ['SUPABASE_DB_URL'])!);
  } else {
    const dbUrl = new URL(v('SUPABASE_DB_URL'));
    const sql = postgres(v('SUPABASE_DB_URL'), {
      max: 1,
      connect_timeout: 10,
      idle_timeout: 1,
      prepare: false,
      onnotice: () => {},
    });
    try {
      const [r] =
        await sql`select current_database() as db, current_setting('server_version') as version`;
      const notes: string[] = [`postgres ${r!.version}`];
      let status: Status = 'PASS';
      if (dbUrl.port === '6543') {
        status = 'WARN';
        notes.push('transaction pooler (6543): use the session pooler (5432) for migrations');
      }
      if (dbUrl.hostname.startsWith('db.')) {
        status = 'WARN';
        notes.push('direct host is IPv6-only; Railway needs the session pooler URI');
      }
      rows.push({ group: G, check: 'Postgres connection', status, detail: notes.join('; ') });
    } catch (e) {
      rows.push({ group: G, check: 'Postgres connection', status: 'FAIL', detail: errMsg(e) });
    } finally {
      await sql.end({ timeout: 2 }).catch(() => {});
    }
  }

  return rows;
}

async function probeSolana(): Promise<Row[]> {
  const G = 'Solana';
  const rows: Row[] = [];
  const b = blocked(G, 'Alchemy RPC reachable', ['ALCHEMY_SOLANA_RPC_URL', 'SOLANA_CLUSTER']);
  if (b) return [b];

  const url = v('ALCHEMY_SOLANA_RPC_URL');
  const cluster = v('SOLANA_CLUSTER');

  try {
    const [genesis, version] = await Promise.all([
      rpc<string>(url, 'getGenesisHash', []),
      rpc<any>(url, 'getVersion', []),
    ]);
    const match = genesis === SOLANA_GENESIS[cluster];
    rows.push({
      group: G,
      check: 'Alchemy RPC / cluster',
      status: match ? 'PASS' : 'FAIL',
      detail: match
        ? `${cluster}, solana-core ${version['solana-core']}`
        : `RPC is not ${cluster} (genesis ${genesis}); the URL and SOLANA_CLUSTER disagree`,
    });
    if (!match) return rows;
  } catch (e) {
    rows.push({ group: G, check: 'Alchemy RPC / cluster', status: 'FAIL', detail: errMsg(e) });
    return rows;
  }

  // Keypairs + balances
  const minSol = Number(v('FEE_PAYER_MIN_SOL') || 0.05);
  const adminMinSol = Number(v('ADMIN_MIN_SOL') || 0.02);
  const feePayer = valid.has('SOLANA_FEE_PAYER_KEYPAIR')
    ? solanaKeypairPubkey(v('SOLANA_FEE_PAYER_KEYPAIR'))
    : null;
  const admin = valid.has('SOLANA_ADMIN_KEYPAIR')
    ? solanaKeypairPubkey(v('SOLANA_ADMIN_KEYPAIR'))
    : null;

  if (feePayer && admin && feePayer === admin) {
    rows.push({
      group: G,
      check: 'Keypair separation',
      status: 'WARN',
      detail: 'fee payer and admin are the same key; use two keys',
    });
  }

  for (const [label, pk, min, hint] of [
    ['Fee payer balance', feePayer, minSol, `needs >= ${minSol} SOL`],
    ['Admin balance', admin, adminMinSol, `needs >= ${adminMinSol} SOL`],
  ] as const) {
    if (!pk) {
      rows.push({
        group: G,
        check: label,
        status: 'SKIP',
        detail: 'blocked: keypair invalid or missing',
      });
      continue;
    }
    try {
      const { value } = await rpc<{ value: number }>(url, 'getBalance', [
        pk,
        { commitment: 'confirmed' },
      ]);
      const sol = value / LAMPORTS_PER_SOL;
      const ok = sol >= min;
      const fund =
        cluster === 'devnet'
          ? `; run: solana airdrop 2 ${pk} -u devnet (or faucet.solana.com)`
          : '';
      rows.push({
        group: G,
        check: label,
        status: ok ? 'PASS' : 'FAIL',
        detail: `${pk}: ${sol.toFixed(4)} SOL${ok ? '' : ` (${hint}${fund})`}`,
      });
    } catch (e) {
      rows.push({ group: G, check: label, status: 'FAIL', detail: errMsg(e) });
    }
  }

  // Confidential transfers depend on the ZK ElGamal proof program being enabled on the cluster.
  // Simulate a VerifyPubkeyValidity call with garbage proof data: an enabled program runs and
  // rejects the proof (InvalidInstructionData); a disabled one fails before executing.
  if (feePayer) {
    try {
      const msg = Buffer.concat([
        Buffer.from([1, 0, 1, 2]),
        b58decode(feePayer)!,
        b58decode(ZK_ELGAMAL_PROOF_PROGRAM)!,
        Buffer.alloc(32),
        Buffer.from([1, 1, 0, 2, 4, 0]),
      ]);
      const tx = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), msg]).toString('base64');
      const { value } = await rpc<{ value: { err: any; logs: string[] | null } }>(
        url,
        'simulateTransaction',
        [tx, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }],
      );
      const ran = (value.logs ?? []).some((l) => l.includes('invalid proof data'));
      if (ran) {
        rows.push({
          group: G,
          check: 'ZK ElGamal proof program',
          status: 'PASS',
          detail: `enabled on ${cluster} (confidential transfers available)`,
        });
      } else if (JSON.stringify(value.err ?? '').includes('AccountNotFound')) {
        rows.push({
          group: G,
          check: 'ZK ElGamal proof program',
          status: 'SKIP',
          detail: 'fund the fee payer first (simulation needs an existing payer)',
        });
      } else {
        rows.push({
          group: G,
          check: 'ZK ElGamal proof program',
          status: 'FAIL',
          detail: `not executing on ${cluster}: ${JSON.stringify(value.err)}`,
        });
      }
    } catch (e) {
      rows.push({ group: G, check: 'ZK ElGamal proof program', status: 'FAIL', detail: errMsg(e) });
    }
  }

  // Mints and program
  async function parsedAccount(addr: string) {
    const { value } = await rpc<{ value: any }>(url, 'getAccountInfo', [
      addr,
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    return value;
  }

  if (valid.has('USDC_MINT')) {
    try {
      const acc = await parsedAccount(v('USDC_MINT'));
      const canonical = CANONICAL_USDC[cluster];
      if (!acc) {
        rows.push({
          group: G,
          check: 'USDC mint',
          status: 'FAIL',
          detail: `account not found on ${cluster}`,
        });
      } else if (acc.owner !== TOKEN_PROGRAM || acc.data?.parsed?.type !== 'mint') {
        rows.push({
          group: G,
          check: 'USDC mint',
          status: 'FAIL',
          detail: 'account is not an SPL Token mint',
        });
      } else {
        const same = v('USDC_MINT') === canonical;
        rows.push({
          group: G,
          check: 'USDC mint',
          status: same ? 'PASS' : 'WARN',
          detail: same
            ? `Circle USDC on ${cluster}, ${acc.data.parsed.info.decimals} decimals`
            : `valid mint, but not Circle's ${cluster} USDC (${canonical})`,
        });
      }
    } catch (e) {
      rows.push({ group: G, check: 'USDC mint', status: 'FAIL', detail: errMsg(e) });
    }
  }

  if (valid.has('VAULT_PROGRAM_ID')) {
    try {
      const acc = await parsedAccount(v('VAULT_PROGRAM_ID'));
      rows.push({
        group: G,
        check: 'Vault program',
        status: acc?.executable ? 'PASS' : 'FAIL',
        detail: acc?.executable
          ? 'deployed and executable'
          : 'not deployed / not executable on this cluster',
      });
    } catch (e) {
      rows.push({ group: G, check: 'Vault program', status: 'FAIL', detail: errMsg(e) });
    }
  }

  if (valid.has('CUSDC_MINT')) {
    try {
      const acc = await parsedAccount(v('CUSDC_MINT'));
      const ext = (acc?.data?.parsed?.info?.extensions ?? []).find(
        (x: any) => x.extension === 'confidentialTransferMint',
      );
      if (!acc || acc.owner !== TOKEN_2022_PROGRAM) {
        rows.push({
          group: G,
          check: 'cUSDC mint',
          status: 'FAIL',
          detail: 'not a Token-2022 mint on this cluster',
        });
      } else if (!ext) {
        rows.push({
          group: G,
          check: 'cUSDC mint',
          status: 'FAIL',
          detail: 'Token-2022 mint without ConfidentialTransfer extension',
        });
      } else {
        const auto = ext.state?.autoApproveNewAccounts;
        rows.push({
          group: G,
          check: 'cUSDC mint',
          status: auto ? 'PASS' : 'WARN',
          detail: auto
            ? 'Token-2022 + ConfidentialTransfer, auto-approve on'
            : 'ConfidentialTransfer present but auto-approve is off',
        });
      }
    } catch (e) {
      rows.push({ group: G, check: 'cUSDC mint', status: 'FAIL', detail: errMsg(e) });
    }
  }

  if (valid.has('VEXA_TOKEN_MINT')) {
    try {
      const acc = await parsedAccount(v('VEXA_TOKEN_MINT'));
      const ok = acc?.data?.parsed?.type === 'mint';
      rows.push({
        group: G,
        check: '$VEXA mint',
        status: ok ? 'PASS' : 'FAIL',
        detail: ok ? 'mint exists' : 'not a mint on this cluster',
      });
    } catch (e) {
      rows.push({ group: G, check: '$VEXA mint', status: 'FAIL', detail: errMsg(e) });
    }
  }

  return rows;
}

async function probeNear(): Promise<Row[]> {
  const G = 'NEAR';
  const rows: Row[] = [];
  const b = blocked(G, 'NEAR RPC reachable', ['NEAR_RPC_URL', 'NEAR_NETWORK']);
  if (b) return [b];

  const url = v('NEAR_RPC_URL');
  const network = v('NEAR_NETWORK');

  try {
    const status = await rpc<any>(url, 'status', []);
    const ok = status.chain_id === NEAR_CHAIN_ID[network];
    rows.push({
      group: G,
      check: 'RPC / network',
      status: ok ? 'PASS' : 'FAIL',
      detail: ok
        ? `${status.chain_id}, block ${status.sync_info?.latest_block_height}`
        : `RPC chain_id is ${status.chain_id}, NEAR_NETWORK is ${network}`,
    });
    if (!ok) return rows;
  } catch (e) {
    rows.push({ group: G, check: 'RPC / network', status: 'FAIL', detail: errMsg(e) });
    return rows;
  }

  const viewAccount = (account_id: string) =>
    rpc<any>(url, 'query', { request_type: 'view_account', finality: 'final', account_id });

  // Deployer account + key
  if (valid.has('NEAR_DEPLOYER_ACCOUNT_ID')) {
    const id = v('NEAR_DEPLOYER_ACCOUNT_ID');
    try {
      const acc = await viewAccount(id);
      const near = Number(BigInt(acc.amount) / 10n ** 21n) / 1000;
      const minNear = Number(v('NEAR_DEPLOYER_MIN_NEAR') || 0.1);
      rows.push({
        group: G,
        check: 'Deployer account',
        status: near >= minNear ? 'PASS' : 'FAIL',
        detail: `${id}: ${near.toFixed(3)} NEAR${near >= minNear ? '' : ` (needs >= ${minNear} NEAR)`}`,
      });
    } catch (e) {
      rows.push({
        group: G,
        check: 'Deployer account',
        status: 'FAIL',
        detail: `${id}: ${errMsg(e)}`,
      });
    }

    const pub = valid.has('NEAR_DEPLOYER_PRIVATE_KEY')
      ? nearKeyPublic(v('NEAR_DEPLOYER_PRIVATE_KEY'))
      : null;
    if (!pub) {
      rows.push({
        group: G,
        check: 'Deployer access key',
        status: 'SKIP',
        detail: 'blocked: fix NEAR_DEPLOYER_PRIVATE_KEY first',
      });
    } else {
      try {
        const ak = await rpc<any>(url, 'query', {
          request_type: 'view_access_key',
          finality: 'final',
          account_id: id,
          public_key: pub,
        });
        const full = ak.permission === 'FullAccess';
        rows.push({
          group: G,
          check: 'Deployer access key',
          status: full ? 'PASS' : 'FAIL',
          detail: full
            ? `${pub} is a full-access key`
            : `${pub} is a function-call key; deploy needs full access`,
        });
      } catch (e) {
        rows.push({
          group: G,
          check: 'Deployer access key',
          status: 'FAIL',
          detail: `${pub} not on ${id}: ${errMsg(e)}`,
        });
      }
    }
  }

  // MPC signer
  if (valid.has('NEAR_MPC_CONTRACT_ID')) {
    const mpc = v('NEAR_MPC_CONTRACT_ID');
    if (mpc !== CANONICAL_MPC[network]) {
      rows.push({
        group: G,
        check: 'MPC contract id',
        status: 'WARN',
        detail: `expected ${CANONICAL_MPC[network]} on ${network}`,
      });
    }
    try {
      const res = await rpc<any>(url, 'query', {
        request_type: 'call_function',
        finality: 'final',
        account_id: mpc,
        method_name: 'public_key',
        args_base64: Buffer.from(JSON.stringify({ domain_id: MPC_ED25519_DOMAIN_ID })).toString(
          'base64',
        ),
      });
      const key = JSON.parse(Buffer.from(res.result).toString());
      const isEd = typeof key === 'string' && key.startsWith('ed25519:');
      rows.push({
        group: G,
        check: 'MPC signer (Ed25519)',
        status: isEd ? 'PASS' : 'WARN',
        detail: isEd
          ? `${mpc} exposes an Ed25519 domain (needed for Solana)`
          : `${mpc} reachable, but domain ${MPC_ED25519_DOMAIN_ID} is not Ed25519`,
      });
    } catch (e) {
      try {
        await viewAccount(mpc);
        rows.push({
          group: G,
          check: 'MPC signer (Ed25519)',
          status: 'WARN',
          detail: `${mpc} exists but Ed25519 domain lookup failed: ${errMsg(e)}`,
        });
      } catch (e2) {
        rows.push({
          group: G,
          check: 'MPC signer (Ed25519)',
          status: 'FAIL',
          detail: `${mpc}: ${errMsg(e2)}`,
        });
      }
    }
  }

  // Policy contract (Phase 3)
  if (valid.has('NEAR_POLICY_CONTRACT_ID')) {
    const id = v('NEAR_POLICY_CONTRACT_ID');
    try {
      const acc = await viewAccount(id);
      const deployed = acc.code_hash && acc.code_hash !== '11111111111111111111111111111111';
      rows.push({
        group: G,
        check: 'Policy contract',
        status: deployed ? 'PASS' : 'PENDING',
        detail: deployed ? `${id} has code deployed` : `${id} exists, no code yet`,
      });
    } catch (e) {
      rows.push({
        group: G,
        check: 'Policy contract',
        status: 'PENDING',
        detail: `${id}: ${errMsg(e)} (created in Phase 3)`,
      });
    }
  }

  return rows;
}

async function probeIntents(): Promise<Row[]> {
  const G = 'NEAR Intents';
  const b = blocked(G, '1Click API', ['INTENTS_1CLICK_BASE_URL']);
  if (b) return [b];
  const base = v('INTENTS_1CLICK_BASE_URL').replace(/\/$/, '');
  const headers: Record<string, string> = {};
  if (v('INTENTS_1CLICK_JWT')) headers.authorization = `Bearer ${v('INTENTS_1CLICK_JWT')}`;
  try {
    const { status, body } = await fetchJson(`${base}/v0/tokens`, { headers });
    if (status !== 200 || !Array.isArray(body)) {
      return [
        {
          group: G,
          check: '1Click API',
          status: 'FAIL',
          detail: `GET /v0/tokens -> ${status}${status === 401 ? ' (JWT rejected)' : ''}`,
        },
      ];
    }
    const hasZec = body.some((t: any) => String(t.symbol).toUpperCase() === 'ZEC');
    const hasSolUsdc = body.some(
      (t: any) =>
        String(t.symbol).toUpperCase() === 'USDC' && String(t.blockchain).toLowerCase() === 'sol',
    );
    const ok = hasZec && hasSolUsdc;
    const route = ok
      ? 'USDC(sol) and ZEC both routable'
      : `missing: ${[!hasSolUsdc && 'USDC on sol', !hasZec && 'ZEC'].filter(Boolean).join(', ')}`;
    return [
      {
        group: G,
        check: '1Click API',
        status: ok ? 'PASS' : 'WARN',
        detail: `${body.length} tokens; ${route}`,
      },
      {
        group: G,
        check: '1Click JWT',
        status: v('INTENTS_1CLICK_JWT') ? 'PASS' : 'SKIP',
        detail: v('INTENTS_1CLICK_JWT') ? 'accepted' : 'not set (quotes work, with an extra fee)',
      },
    ];
  } catch (e) {
    return [{ group: G, check: '1Click API', status: 'FAIL', detail: errMsg(e) }];
  }
}

async function probeGithub(): Promise<Row[]> {
  const G = 'GitHub';
  if (!v('GITHUB_TOKEN'))
    return [{ group: G, check: 'Token', status: 'SKIP', detail: 'not set (CI only)' }];
  const headers = {
    authorization: `Bearer ${v('GITHUB_TOKEN')}`,
    'user-agent': 'vexa-check-env',
    accept: 'application/vnd.github+json',
  };
  try {
    const me = await fetchJson('https://api.github.com/user', { headers });
    if (me.status !== 200)
      return [{ group: G, check: 'Token', status: 'FAIL', detail: `GET /user -> ${me.status}` }];
    const repo = await fetchJson('https://api.github.com/repos/AlexSkidanov/vexa-finance', {
      headers,
    });
    return [
      { group: G, check: 'Token', status: 'PASS', detail: `authenticated as ${me.body.login}` },
      {
        group: G,
        check: 'Repo AlexSkidanov/vexa-finance',
        status: repo.status === 200 ? 'PASS' : 'WARN',
        detail:
          repo.status === 200
            ? 'accessible'
            : `-> ${repo.status} (not created yet, or token lacks access)`,
      },
    ];
  } catch (e) {
    return [{ group: G, check: 'Token', status: 'FAIL', detail: errMsg(e) }];
  }
}

function crossChecks(): Row[] {
  const G = 'Consistency';
  const rows: Row[] = [];
  const cluster = v('SOLANA_CLUSTER');
  const near = v('NEAR_NETWORK');
  if (cluster === 'mainnet-beta' && near === 'testnet') {
    rows.push({
      group: G,
      check: 'Solana vs NEAR network',
      status: 'WARN',
      detail:
        'Solana mainnet with NEAR testnet MPC: agent keys would be secured by the testnet signer',
    });
  }
  if (cluster === 'devnet' && near === 'mainnet') {
    rows.push({
      group: G,
      check: 'Solana vs NEAR network',
      status: 'WARN',
      detail: 'Solana devnet with NEAR mainnet: real NEAR spent on test traffic',
    });
  }
  if (v('NODE_ENV') === 'production' && cluster === 'devnet') {
    rows.push({
      group: G,
      check: 'NODE_ENV vs cluster',
      status: 'WARN',
      detail: 'NODE_ENV=production on devnet',
    });
  }
  if (valid.has('WEBAUTHN_RP_ID') && valid.has('WEBAUTHN_ORIGINS')) {
    const rp = v('WEBAUTHN_RP_ID');
    const bad = v('WEBAUTHN_ORIGINS')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => {
        const h = new URL(o).hostname;
        return h !== rp && !h.endsWith(`.${rp}`);
      });
    rows.push({
      group: G,
      check: 'WebAuthn RP ID vs origins',
      status: bad.length ? 'FAIL' : 'PASS',
      detail: bad.length
        ? `RP ID ${rp} is not a suffix of: ${bad.join(', ')}`
        : `all origins are under ${rp}`,
    });
  }
  if (
    valid.has('API_KEY_ENCRYPTION_KEY') &&
    v('API_KEY_ENCRYPTION_KEY') === v('VIEW_KEY_ENCRYPTION_KEY')
  ) {
    rows.push({
      group: G,
      check: 'Key reuse',
      status: 'FAIL',
      detail: 'API_KEY_ENCRYPTION_KEY and VIEW_KEY_ENCRYPTION_KEY must differ',
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const COLORS: Record<Status, string> = {
  PASS: '32',
  FAIL: '31',
  WARN: '33',
  PENDING: '36',
  SKIP: '90',
};
const tty = process.stdout.isTTY;
const color = (s: Status, text: string) => (tty ? `\x1b[${COLORS[s]}m${text}\x1b[0m` : text);

function printTable(rows: Row[]) {
  const w = {
    group: Math.max(5, ...rows.map((r) => r.group.length)),
    check: Math.max(5, ...rows.map((r) => r.check.length)),
  };
  const line = `${'-'.repeat(w.group)}  ${'-'.repeat(w.check)}  -------  ${'-'.repeat(40)}`;
  console.log(`${'GROUP'.padEnd(w.group)}  ${'CHECK'.padEnd(w.check)}  STATUS   DETAIL`);
  console.log(line);
  let last = '';
  for (const r of rows) {
    if (last && r.group !== last) console.log('');
    last = r.group;
    console.log(
      `${r.group.padEnd(w.group)}  ${r.check.padEnd(w.check)}  ${color(r.status, r.status.padEnd(7))}  ${redact(r.detail)}`,
    );
  }
}

async function main() {
  if (!existsSync(ENV_PATH)) {
    console.error(
      `No .env found at ${ENV_PATH}.\nRun: cp .env.example .env  then fill it in (see docs/SETUP.md).`,
    );
    process.exit(1);
  }
  const parsed = config({ path: ENV_PATH, override: true, quiet: true } as any).parsed ?? {};
  for (const s of SPECS) env[s.key] = (parsed[s.key] ?? process.env[s.key] ?? '').trim();
  secretValues = SPECS.filter((s) => s.secret && env[s.key] && env[s.key]!.length >= 6)
    .map((s) => env[s.key]!)
    .sort((a, b) => b.length - a.length);

  const rows: Row[] = [];

  // 1. Format validation
  for (const s of SPECS) {
    const value = env[s.key]!;
    if (!value) {
      const status: Status =
        s.level === 'required' ? 'FAIL' : s.level === 'later' ? 'PENDING' : 'SKIP';
      const detail =
        s.level === 'required'
          ? 'missing'
          : s.level === 'later'
            ? `set in ${s.note ?? 'a later phase'}`
            : 'not set';
      rows.push({ group: s.group, check: s.key, status, detail });
      continue;
    }
    const r = s.schema.safeParse(value);
    if (r.success) {
      valid.add(s.key);
      let detail = s.secret ? 'set (hidden)' : 'ok';
      if (s.key === 'SOLANA_FEE_PAYER_KEYPAIR' || s.key === 'SOLANA_ADMIN_KEYPAIR')
        detail = `pubkey ${solanaKeypairPubkey(value)}`;
      if (s.key === 'NEAR_DEPLOYER_PRIVATE_KEY') detail = `public ${nearKeyPublic(value)}`;
      rows.push({ group: s.group, check: s.key, status: 'PASS', detail });
    } else {
      rows.push({
        group: s.group,
        check: s.key,
        status: 'FAIL',
        detail: r.error.issues.map((i) => i.message).join('; '),
      });
    }
  }

  // 2. Connectivity (in parallel)
  const probes = await Promise.all([
    probeSupabase(),
    probeSolana(),
    probeNear(),
    probeIntents(),
    probeGithub(),
  ]);
  const probeRows = [...crossChecks(), ...probes.flat()];

  console.log('\nVexa environment check\n======================\n');
  console.log('Values\n');
  printTable(rows);
  console.log('\nConnectivity\n');
  printTable(probeRows);

  const all = [...rows, ...probeRows];
  const count = (s: Status) => all.filter((r) => r.status === s).length;
  console.log(
    `\n${color('PASS', `${count('PASS')} pass`)}, ${color('FAIL', `${count('FAIL')} fail`)}, ${color('WARN', `${count('WARN')} warn`)}, ` +
      `${color('PENDING', `${count('PENDING')} pending (later phases)`)}, ${color('SKIP', `${count('SKIP')} skipped`)}\n`,
  );
  if (count('FAIL') > 0) {
    console.log('Result: FAIL. Fix the rows above (docs/SETUP.md explains each one).\n');
    process.exit(1);
  }
  console.log('Result: PASS. Phase 0 environment is ready.\n');
}

main().catch((e) => {
  console.error(redact(errMsg(e)));
  process.exit(1);
});

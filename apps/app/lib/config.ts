/** Build-time configuration. Everything here is inlined by Next at build. */

export const API_URL = (process.env.NEXT_PUBLIC_VEXA_API_URL ?? 'https://api.vexa.finance').replace(
  /\/+$/,
  '',
);

export const SITE_URL = 'https://vexa.finance';

/** $VEXA's contract address on Solana (launched on pump.fun). */
export const VEXA_MINT = '71ur38S2zxj1DaA2Untd8VYmAEkvyeXWkw3gycPDpump';
export const AUDIT_URL = `${SITE_URL}/audit/`;
export const DOCS_URL = 'https://github.com/AlexSkidanov/vexa-finance/blob/main/docs/API.md';

/**
 * Optional: a Solana RPC to read the wallet's plain USDC balance on the Add
 * money screen. Off by default, so the app talks to nobody but the Vexa API.
 * If you set it, add its origin to connect-src in netlify.toml.
 */
export const SOLANA_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || null;

/**
 * The demo fakes every call with sample data. It exists in `next dev`, and in
 * a build only when NEXT_PUBLIC_VEXA_DEMO=1 was set at build time; otherwise
 * next.config.ts leaves its code out of the bundle.
 */
export const DEMO_AVAILABLE = process.env.VEXA_DEMO === '1';

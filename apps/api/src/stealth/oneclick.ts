/**
 * NEAR Intents 1Click: cross-chain swaps through a deposit address.
 * https://docs.near-intents.org (OpenAPI: /docs/v0/openapi.yaml)
 *
 * Ask for a quote, send exactly `amountIn` to its `depositAddress`, then poll
 * the status by that address. With an API key (partners.near-intents.org)
 * quotes carry no extra fee; without one 1Click adds about 0.2%.
 */

export const ASSET_USDC_SOLANA = 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near';
export const ASSET_ZEC = 'nep141:zec.omft.near';

export type SwapStatus =
  | 'PENDING_DEPOSIT'
  | 'KNOWN_DEPOSIT_TX'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'INCOMPLETE_DEPOSIT'
  | 'REFUNDED'
  | 'FAILED';

export interface Quote {
  depositAddress: string;
  /** Base units of the origin asset to send, exactly. */
  amountIn: string;
  /** Base units of the destination asset, after fees. */
  amountOut: string;
  minAmountOut: string;
  deadline: string;
  timeEstimate: number;
}

export interface SwapState {
  status: SwapStatus;
  /** Present once 1Click has the deposit: what actually came out. */
  amountOut: string | null;
  refunded: boolean;
}

export class OneClickError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'OneClickError';
  }
}

export interface OneClick {
  quote(input: {
    originAsset: string;
    destinationAsset: string;
    amount: bigint;
    recipient: string;
    refundTo: string;
    /** Basis points. Default 100 (1%). */
    slippageBps?: number;
  }): Promise<Quote>;
  status(depositAddress: string): Promise<SwapState>;
  /** Tells 1Click about a deposit so it starts sooner. Optional; failures are ignored. */
  submitDeposit(depositAddress: string, txHash: string): Promise<void>;
}

export function createOneClick(opts: {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
}): OneClick {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey) headers['X-API-Key'] = opts.apiKey;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await f(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok)
      throw new OneClickError(`1Click ${path}: ${res.status} ${text.slice(0, 300)}`, res.status);
    return JSON.parse(text) as T;
  }

  return {
    async quote(i) {
      const res = await call<{ quote: Quote }>('POST', '/v0/quote', {
        dry: false,
        swapType: 'EXACT_INPUT',
        slippageTolerance: i.slippageBps ?? 100,
        originAsset: i.originAsset,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: i.destinationAsset,
        amount: i.amount.toString(),
        refundTo: i.refundTo,
        refundType: 'ORIGIN_CHAIN',
        recipient: i.recipient,
        recipientType: 'DESTINATION_CHAIN',
        deadline: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      });
      return res.quote;
    },

    async status(depositAddress) {
      const res = await call<{
        status: SwapStatus;
        swapDetails?: { amountOut?: string | null; refundedAmount?: string | null };
      }>('GET', `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
      return {
        status: res.status,
        amountOut: res.swapDetails?.amountOut ?? null,
        refunded: !!res.swapDetails?.refundedAmount && res.swapDetails.refundedAmount !== '0',
      };
    },

    async submitDeposit(depositAddress, txHash) {
      await call('POST', '/v0/deposit/submit', { depositAddress, txHash }).catch(() => undefined);
    },
  };
}

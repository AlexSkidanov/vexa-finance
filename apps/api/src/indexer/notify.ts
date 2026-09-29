import type { Logger } from '../logger.js';

/**
 * Adds addresses to the Alchemy webhook through its Notify API, so the
 * indexer hears about their activity. Adding an address that's already
 * watched is a no-op on Alchemy's side. Best effort: failures are logged,
 * never fatal.
 */
export async function watchAddresses(opts: {
  authToken: string | undefined;
  webhookId: string | undefined;
  addresses: string[];
  logger: Logger;
  fetch?: typeof fetch;
}): Promise<boolean> {
  if (!opts.authToken || !opts.webhookId || opts.addresses.length === 0) return false;
  try {
    const res = await (opts.fetch ?? fetch)(
      'https://dashboard.alchemy.com/api/update-webhook-addresses',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'X-Alchemy-Token': opts.authToken },
        body: JSON.stringify({
          webhook_id: opts.webhookId,
          addresses_to_add: opts.addresses,
          addresses_to_remove: [],
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      opts.logger.warn({ status: res.status }, 'could not update Alchemy webhook addresses');
      return false;
    }
    return true;
  } catch (err) {
    opts.logger.warn({ err }, 'could not reach Alchemy Notify API');
    return false;
  }
}

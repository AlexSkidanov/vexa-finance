import type { Address } from '@solana/kit';
import type { Env } from './env.js';
import type { Chain } from './chain/chain.js';
import type { Logger } from './logger.js';
import type { AuthProvider } from './lib/auth-provider.js';
import type { TokenVerifier } from './lib/tokens.js';
import type { Store } from './store/types.js';

/** Who is making the request, once authenticated. */
export interface Principal {
  userId: string;
  email: string | null;
  /** How they authenticated. Some routes, like creating API keys, require a session. */
  via: 'session' | 'api_key';
  apiKeyId?: string;
}

/** Everything a route needs, injected once at startup so tests can swap any piece. */
export interface Deps {
  env: Env;
  logger: Logger;
  store: Store;
  auth: AuthProvider;
  tokens: TokenVerifier;
  chain: Chain;
  vault: VaultAddresses;
  version: string;
}

export interface VaultAddresses {
  program: Address;
  config: Address;
  usdcMint: Address;
  cusdcMint: Address;
  usdcReserve: Address;
}

export type AppBindings = {
  Variables: {
    deps: Deps;
    requestId: string;
    logger: Logger;
    principal?: Principal;
  };
};

import type { Env } from './env.js';
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
  version: string;
}

export type AppBindings = {
  Variables: {
    deps: Deps;
    requestId: string;
    logger: Logger;
    principal?: Principal;
  };
};

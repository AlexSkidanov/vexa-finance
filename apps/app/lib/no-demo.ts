// Replaces demo-client.ts in production builds. See next.config.ts.
import type { VexaClient } from './client';

export function createDemoClient(): VexaClient {
  throw new Error('Demo mode is not part of this build');
}

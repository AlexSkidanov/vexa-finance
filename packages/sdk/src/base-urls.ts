import type { ApiEnvironment } from '@vexa/core';

export const DEFAULT_BASE_URLS: Record<ApiEnvironment, string> = {
  live: 'https://api.vexa.finance',
  test: 'https://sandbox.api.vexa.finance',
};

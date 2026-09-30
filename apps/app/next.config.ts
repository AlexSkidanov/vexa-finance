import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

export default function config(phase: string): NextConfig {
  // Demo mode (sample data, no API) exists in `next dev` and in builds made
  // with NEXT_PUBLIC_VEXA_DEMO=1. Anywhere else its code isn't even bundled.
  const demo = phase === PHASE_DEVELOPMENT_SERVER || process.env.NEXT_PUBLIC_VEXA_DEMO === '1';
  return {
    output: 'export',
    trailingSlash: true,
    images: { unoptimized: true },
    reactStrictMode: true,
    poweredByHeader: false,
    agentRules: false,
    env: { VEXA_DEMO: demo ? '1' : '0' },
    turbopack: {
      resolveAlias: {
        // @vexa/core/agent loads the agent-proof WASM with createRequire, which
        // only agents running in Node need. The owner's app never builds those.
        module: { browser: './lib/no-module.ts' },
        ...(demo ? {} : { '@/lib/demo-client': './lib/no-demo.ts' }),
      },
    },
  };
}

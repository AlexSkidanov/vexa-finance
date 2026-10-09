'use client';

import { useEffect, useState } from 'react';
import type { AccountKeys } from '@/lib/live';
import { getAccountKeys } from '@/lib/live';
import { CONTRACTS } from '@/lib/site';

const LABEL: Record<string, string> = {
  ed25519: 'Ed25519',
  secp256k1: 'secp256k1',
  'ml-dsa-65': 'ML-DSA-65',
};

/**
 * The live signature scheme of the agent policy contract's keys, read from
 * NEAR mainnet in the browser so nobody has to take our word for it.
 */
export function QuantumKey() {
  const [keys, setKeys] = useState<AccountKeys | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void getAccountKeys(CONTRACTS.policy).then((k) => live && setKeys(k));
    return () => {
      live = false;
    };
  }, []);

  const schemes = keys ? [...new Set(keys.schemes)].map((s) => LABEL[s] ?? s).join(' + ') : null;
  return (
    <div className="box" style={{ padding: 'clamp(20px,2.6vw,28px)' }} aria-live="polite">
      <div className="num-label" style={{ marginBottom: 12 }}>
        Live from NEAR mainnet · {CONTRACTS.policy}
      </div>
      <div style={{ font: '400 28px/1.2 var(--sans)', color: 'var(--paper)', marginBottom: 12 }}>
        {keys === undefined ? 'Reading keys…' : keys === null ? 'Unavailable' : schemes}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span className={keys?.postQuantum ? 'dot' : 'dot dot-moss'} />
        <span style={{ font: '400 14px/1.4 var(--mono)', color: 'var(--body)' }}>
          {keys === undefined
            ? 'checking'
            : keys === null
              ? 'could not reach NEAR RPC'
              : keys.postQuantum
                ? 'post-quantum: every full-access key is ML-DSA-65'
                : 'not yet post-quantum: rotation to ML-DSA-65 planned'}
        </span>
      </div>
      <p style={{ font: '400 16px/1.45 var(--sans)', color: 'var(--body)', margin: 0 }}>
        The keys that can change the agent policy contract. Check them yourself with{' '}
        <span style={{ font: '400 14px var(--mono)', wordBreak: 'break-all' }}>
          near account list-keys {CONTRACTS.policy} network-config mainnet now
        </span>
        .
      </p>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import type { Health } from '@/lib/live';
import { getHealth } from '@/lib/live';
import { STATUS_URL } from '@/lib/site';

export function StatusChip() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    let live = true;
    void getHealth().then((h) => live && setHealth(h));
    return () => {
      live = false;
    };
  }, []);
  const label =
    health === 'ok'
      ? 'All systems normal · Solana mainnet · NEAR mainnet'
      : health === 'degraded'
        ? 'Degraded · see status'
        : health === 'unreachable'
          ? 'Status unavailable'
          : 'Checking status…';
  return (
    <a
      href={STATUS_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-live="polite"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        color: 'inherit',
        textDecoration: 'none',
      }}
    >
      <span className={health === 'ok' ? 'dot' : 'dot dot-moss'} />
      {label}
    </a>
  );
}

'use client';

import { useEffect, useState } from 'react';
import type { MintInfo } from '@/lib/live';
import { getMint } from '@/lib/live';
import { VEXA_MINT } from '@/lib/site';

/**
 * $VEXA's contract address with its live status, read from Solana mainnet in
 * the browser: "launching" until the mint exists, then "live" with its supply.
 */
export function VexaMint() {
  const [mint, setMint] = useState<MintInfo | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    void getMint(VEXA_MINT).then((m) => live && setMint(m));
    return () => {
      live = false;
    };
  }, []);

  const copy = () => {
    void navigator.clipboard?.writeText(VEXA_MINT).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  const status =
    mint === undefined
      ? 'Checking Solana…'
      : mint === null
        ? 'Status unavailable'
        : mint.exists
          ? 'Live on Solana'
          : 'Launching on pump.fun';
  const supply =
    mint?.exists && mint.supply && mint.decimals != null
      ? (BigInt(mint.supply) / 10n ** BigInt(mint.decimals)).toLocaleString('en-US')
      : null;

  return (
    <div aria-live="polite">
      <div className="num-label">Contract address</div>
      <button
        type="button"
        onClick={copy}
        title="Copy the contract address"
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'block',
          font: '400 15px/1.5 var(--mono)',
          color: 'var(--paper)',
          wordBreak: 'break-all',
          userSelect: 'all',
        }}
      >
        {VEXA_MINT}
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <span className={mint?.exists ? 'dot' : 'dot dot-moss'} />
        <span style={{ font: '400 14px/1.4 var(--mono)', color: 'var(--body)' }}>
          {copied ? 'Copied' : status}
          {supply ? ` · ${supply} $VEXA` : ''}
        </span>
      </div>
    </div>
  );
}

'use client';

import type { ReactNode } from 'react';
import type { FeeQuote } from '@/lib/client';
import { formatAmount, formatBps } from '@/lib/amount';
import { Row } from './ui';

/** Fee, discount and what's left, as the vault will compute them. */
export function QuoteRows({
  amount,
  quote,
  netLabel,
}: {
  amount: bigint;
  quote: FeeQuote;
  netLabel: string;
}) {
  return (
    <div className="stack-sm">
      <Row k="Amount" v={`${formatAmount(amount)} USDC`} />
      <Row
        k={
          <>
            Fee (0.10%, capped at 5 USDC)
            {quote.discountBps > 0 && (
              <span className="signal"> · $VEXA −{formatBps(quote.discountBps)}</span>
            )}
          </>
        }
        v={`${formatAmount(quote.fee)} USDC`}
      />
      <Row k={netLabel} v={<strong>{formatAmount(quote.net)} USDC</strong>} />
    </div>
  );
}

export function Done({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="stack" role="status">
      <p className="eyebrow signal" style={{ margin: 0 }}>
        Done
      </p>
      <h2 className="page-title" style={{ fontSize: 32 }}>
        {title}
      </h2>
      {children}
    </div>
  );
}

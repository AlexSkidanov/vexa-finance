'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Activity } from '@/lib/client';
import { formatAmount } from '@/lib/amount';
import { formatWhen, shortAddress } from '@/lib/format';
import { Decrypt } from './decrypt';
import { Icon } from './icons';

const HIDE_KEY = 'vexa.hideBalance';

/** Whether amounts are hidden on screen; a per-device preference. */
export function useHidden(): [boolean, () => void] {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(HIDE_KEY) === '1');
    } catch {
      // stays visible
    }
  }, []);
  return [
    hidden,
    () =>
      setHidden((h) => {
        try {
          localStorage.setItem(HIDE_KEY, h ? '0' : '1');
        } catch {
          // just for this page
        }
        return !h;
      }),
  ];
}

export function Amount({
  units,
  hidden,
  sign,
}: {
  units: bigint;
  hidden?: boolean;
  sign?: '+' | '−';
}) {
  if (hidden) return <span aria-label="Hidden">••••</span>;
  return (
    <>
      {sign ?? ''}
      {formatAmount(units)}
    </>
  );
}

export function BigBalance({ units, hidden }: { units: bigint | null; hidden: boolean }) {
  if (hidden) {
    return (
      <div className="balance-num" aria-label="Balance hidden">
        ••••••
      </div>
    );
  }
  return (
    <Decrypt
      className="balance-num"
      text={units === null ? null : formatAmount(units)}
      fallback="▒▒▒▒.▒▒"
    />
  );
}

function describe(a: Activity): { title: string; sub: string; icon: () => React.ReactNode } {
  if (a.kind === 'transfer') {
    // A received transfer's `to` is you; the sender isn't part of the activity feed.
    return a.direction === 'sent'
      ? { title: a.to, sub: a.memo ?? 'Sent', icon: Icon.send }
      : { title: a.memo ?? 'Received', sub: 'Received', icon: Icon.receive };
  }
  if (a.kind === 'deposit')
    return { title: 'Added to private balance', sub: 'Deposit', icon: Icon.deposit };
  return {
    title: a.destination ? `To ${shortAddress(a.destination)}` : 'Withdrawal',
    sub: 'Withdrawal',
    icon: Icon.withdraw,
  };
}

/** The activity list, newest first. */
export function ActivityList({ items, hidden }: { items: Activity[]; hidden?: boolean }) {
  return (
    <div className="list">
      {items.map((a) => {
        const d = describe(a);
        const Ic = d.icon;
        return (
          <Link key={a.id} href={`/activity/?id=${a.id}`} className="item">
            <span className="item-icon">
              <Ic />
            </span>
            <span className="min0">
              <span className="item-title" style={{ display: 'block' }}>
                {d.title}
              </span>
              <span className="item-sub" style={{ display: 'block' }}>
                {d.sub} · {formatWhen(a.createdAt)}
              </span>
            </span>
            <span
              className={`item-amount ${a.kind === 'transfer' && a.direction === 'received' ? 'in' : ''}`}
            >
              {a.kind === 'transfer' ? (
                <Amount
                  units={a.amount}
                  hidden={hidden}
                  sign={a.direction === 'received' ? '+' : '−'}
                />
              ) : (
                <span className="muted small">on Solscan</span>
              )}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

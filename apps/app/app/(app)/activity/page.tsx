'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { ActivityList, Amount, useHidden } from '@/components/money';
import { useClient } from '@/components/session';
import { StealthTracker } from '@/components/stealth-tracker';
import {
  Empty,
  Loading,
  PageHead,
  ProblemNote,
  Row,
  Sheet,
  StatusChip,
  useAction,
  useLoad,
} from '@/components/ui';
import type { Activity } from '@/lib/client';
import { formatWhen, shortAddress, solscanAccount, solscanTx } from '@/lib/format';

const PAGE = 50;
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'sent', label: 'Sent' },
  { key: 'received', label: 'Received' },
  { key: 'deposit', label: 'Deposits' },
  { key: 'withdrawal', label: 'Withdrawals' },
] as const;
type Filter = (typeof FILTERS)[number]['key'];

const matches = (a: Activity, f: Filter) =>
  f === 'all' || (a.kind === 'transfer' ? a.direction === f : a.kind === f);

function ActivityScreen() {
  const client = useClient();
  const router = useRouter();
  const params = useSearchParams();
  const openId = params.get('id');
  const [hidden] = useHidden();
  const [filter, setFilter] = useState<Filter>('all');
  const [more, setMore] = useState<Activity[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const first = useLoad(async () => {
    const page = await client.activity({ limit: PAGE });
    setMore([]);
    setExhausted(page.length < PAGE);
    return page;
  }, [client]);
  const loadMore = useAction();

  const all = useMemo(() => [...(first.data ?? []), ...more], [first.data, more]);
  const shown = all.filter((a) => matches(a, filter));
  const selected = openId ? all.find((a) => a.id === openId) : undefined;

  return (
    <>
      <PageHead
        title="Activity"
        lede="Transfer amounts and memos are decrypted on this device. Deposits and withdrawals are public on Solana."
      />
      <div className="row" role="group" aria-label="Filter" style={{ marginBottom: 18 }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className="seg"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {first.loading && !first.data && <Loading label="Decrypting activity…" />}
      <ProblemNote problem={first.error} onRetry={first.reload} />
      {first.data && shown.length === 0 && (
        <Empty>{filter === 'all' ? 'No activity yet.' : 'Nothing here with this filter.'}</Empty>
      )}
      {shown.length > 0 && <ActivityList items={shown} hidden={hidden} />}
      {first.data && !exhausted && (
        <div style={{ marginTop: 20 }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loadMore.busy}
            aria-busy={loadMore.busy}
            onClick={() =>
              void loadMore.run(async () => {
                const last = all[all.length - 1];
                const page = await client.activity({ limit: PAGE, before: last?.createdAt });
                setMore((m) => [...m, ...page]);
                if (page.length < PAGE) setExhausted(true);
              })
            }
          >
            {loadMore.busy ? 'Loading…' : 'Load older'}
          </button>
          <ProblemNote problem={loadMore.error} />
        </div>
      )}

      {openId && (
        <Sheet title="Details" onClose={() => router.replace('/activity/')}>
          {selected ? (
            <Detail item={selected} hidden={hidden} />
          ) : first.loading ? (
            <Loading />
          ) : (
            <p className="help">This item isn’t in your recent activity.</p>
          )}
        </Sheet>
      )}
    </>
  );
}

function Detail({ item, hidden }: { item: Activity; hidden: boolean }) {
  const client = useClient();
  const sent = item.kind === 'transfer' && item.direction === 'sent';
  // Only the sender can look a transfer up; it says whether it went stealth.
  const status = useLoad(
    () => (sent ? client.transferStatus(item.id) : Promise.resolve(null)),
    [client, item.id, sent],
  );
  const stealth = status.data?.mode === 'stealth';

  if (item.kind !== 'transfer') {
    return (
      <div className="stack">
        <div className="stack-sm">
          <Row k="Type" v={item.kind === 'deposit' ? 'Deposit' : 'Withdrawal'} />
          <Row k="Status" v={<StatusChip status={item.status} />} />
          <Row k="When" v={formatWhen(item.createdAt)} />
          {item.destination && (
            <Row
              k="To"
              v={
                <a
                  href={solscanAccount(item.destination)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="tx-link mono"
                >
                  {shortAddress(item.destination, 6, 6)}
                </a>
              }
            />
          )}
          <Row k="Amount" v="Public on-chain" />
        </div>
        {item.txSig && (
          <a
            href={solscanTx(item.txSig)}
            target="_blank"
            rel="noopener noreferrer"
            className="tlink"
          >
            View on Solscan
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="stack-sm">
        <Row k="Direction" v={item.direction === 'sent' ? 'Sent' : 'Received'} />
        {item.direction === 'sent' && <Row k="To" v={item.to} />}
        <Row
          k="Amount"
          v={
            <>
              <Amount units={item.amount} hidden={hidden} /> USDC
            </>
          }
        />
        {item.memo && <Row k="Memo" v={item.memo} />}
        <Row k="When" v={formatWhen(item.createdAt)} />
        {sent && (
          <Row
            k="Route"
            v={status.loading ? '…' : stealth ? 'Stealth, via Zcash' : 'Private transfer'}
          />
        )}
        {status.data && !stealth && (
          <Row k="Status" v={<StatusChip status={status.data.status} />} />
        )}
      </div>
      {item.direction === 'received' && item.amount === 0n && (
        <p className="help">A stealth payment shows its amount once its route has paid you.</p>
      )}
      {stealth && <StealthTracker id={item.id} />}
      {item.txSig && (
        <a href={solscanTx(item.txSig)} target="_blank" rel="noopener noreferrer" className="tlink">
          View on Solscan (amount encrypted)
        </a>
      )}
      <ProblemNote problem={status.error} />
    </div>
  );
}

export default function ActivityPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ActivityScreen />
    </Suspense>
  );
}

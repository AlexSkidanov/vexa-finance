'use client';

import Link from 'next/link';
import { Icon } from '@/components/icons';
import { ActivityList, Amount, BigBalance, useHidden } from '@/components/money';
import { useClient, useSession } from '@/components/session';
import { Empty, Loading, ProblemNote, useAction, useLoad } from '@/components/ui';

export default function Home() {
  const client = useClient();
  const { profile } = useSession();
  const [hidden, toggle] = useHidden();
  const balance = useLoad(() => client.balance(), [client]);
  const activity = useLoad(() => client.activity({ limit: 6 }), [client]);
  const apply = useAction();
  const b = balance.data;

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">{profile?.handle}</p>
        <div className="balance">
          <div className="spread">
            <span className="num-label" style={{ margin: 0 }}>
              Private balance · USDC
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={toggle}
              aria-pressed={hidden}
              aria-label={hidden ? 'Show amounts' : 'Hide amounts'}
            >
              {hidden ? <Icon.hidden /> : <Icon.privacy />}
            </button>
          </div>
          <div style={{ marginTop: 14 }}>
            <BigBalance units={b ? b.available : null} hidden={hidden} />
          </div>
          <p className="help" style={{ marginTop: 12 }}>
            {balance.loading && !b
              ? 'Decrypting on this device…'
              : 'Encrypted on Solana. Decrypted here, only for you.'}
          </p>
          <ProblemNote problem={balance.error} onRetry={balance.reload} />
          {b && b.pending > 0n && (
            <div className="notice" style={{ marginTop: 16 }}>
              <div className="spread">
                <span>
                  <strong>
                    <Amount units={b.pending} hidden={hidden} /> USDC
                  </strong>{' '}
                  received and waiting. Apply it to make it spendable.
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={apply.busy}
                  aria-busy={apply.busy}
                  onClick={() =>
                    void apply.run(async () => {
                      await client.applyPending();
                      balance.reload();
                    })
                  }
                >
                  {apply.busy ? 'Applying…' : 'Apply pending'}
                </button>
              </div>
              <ProblemNote problem={apply.error} />
            </div>
          )}
          <div className="quick">
            <Link href="/add/" className="btn btn-secondary">
              Add money
            </Link>
            <Link href="/send/" className="btn btn-primary">
              Send
            </Link>
            <Link href="/withdraw/" className="btn btn-secondary">
              Withdraw
            </Link>
          </div>
        </div>
      </header>

      <section className="section" aria-labelledby="recent">
        <div className="section-head">
          <h2 className="section-title" id="recent">
            Recent activity
          </h2>
          <Link href="/activity/" className="tlink">
            See all
          </Link>
        </div>
        {activity.loading && !activity.data && <Loading label="Decrypting activity…" />}
        <ProblemNote problem={activity.error} onRetry={activity.reload} />
        {activity.data && activity.data.length === 0 && (
          <Empty>
            Nothing yet. <Link href="/add/">Add money</Link> to get started, or share your handle so
            people can pay you.
          </Empty>
        )}
        {activity.data && activity.data.length > 0 && (
          <ActivityList items={activity.data.slice(0, 6)} hidden={hidden} />
        )}
      </section>
    </>
  );
}

'use client';

import Link from 'next/link';
import { useClient } from '@/components/session';
import { Empty, Loading, PageHead, ProblemNote, StatusChip, useLoad } from '@/components/ui';
import { formatAmount } from '@/lib/amount';

export default function Agents() {
  const client = useClient();
  const agents = useLoad(() => client.agents(), [client]);
  const tier = useLoad(() => client.tier(), [client]);
  const live = agents.data?.filter((a) => a.status !== 'revoked').length ?? 0;
  const atLimit = !!tier.data && live >= tier.data.tier.maxAgents;

  return (
    <>
      <PageHead
        title="Agents"
        lede="Sub-accounts for software that pays on your behalf, each with its own balance and limits enforced by NEAR."
      >
        {atLimit ? (
          <span className="muted small">Tier limit reached</span>
        ) : (
          <Link href="/agents/new/" className="btn btn-primary btn-sm">
            New agent
          </Link>
        )}
      </PageHead>
      {tier.data && (
        <p className="help" style={{ marginTop: -12, marginBottom: 20 }}>
          Your tier allows {tier.data.tier.maxAgents} agents, each up to{' '}
          {formatAmount(tier.data.tier.agentDailyLimit)} USDC a day. {live} in use.
        </p>
      )}
      {agents.loading && !agents.data && <Loading />}
      <ProblemNote problem={agents.error} onRetry={agents.reload} />
      {agents.data && agents.data.length === 0 && (
        <Empty>No agents yet. Create one, fund it, and give its credential to your software.</Empty>
      )}
      {agents.data && agents.data.length > 0 && (
        <div className="grid gap-lg" style={{ ['--min' as string]: '260px', gap: 12 }}>
          {agents.data.map((a) => (
            <Link key={a.id} href={`/agents/view/?id=${a.id}`} className="card-link">
              <div className="spread">
                <span className="item-title">{a.name ?? 'Unnamed agent'}</span>
                <StatusChip status={a.status} />
              </div>
              <div className="stack-sm" style={{ marginTop: 16 }}>
                <span className="item-sub">
                  Up to {formatAmount(BigInt(a.policy.maxPerRequest))} per payment
                </span>
                <span className="item-sub">
                  {formatAmount(BigInt(a.policy.dailyLimit))} a day
                  {a.policy.allowedRecipients.length > 0 &&
                    ` · ${a.policy.allowedRecipients.length} recipient${a.policy.allowedRecipients.length === 1 ? '' : 's'}`}
                  {a.policy.allowedDomains.length > 0 &&
                    ` · ${a.policy.allowedDomains.length} domain${a.policy.allowedDomains.length === 1 ? '' : 's'}`}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

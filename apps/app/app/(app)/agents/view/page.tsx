'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { AgentSnippet, PolicyForm } from '@/components/agents';
import { Amount } from '@/components/money';
import { useClient } from '@/components/session';
import {
  AmountInput,
  amountState,
  Empty,
  Loading,
  newIdempotencyKey,
  OnceSecret,
  PageHead,
  ProblemNote,
  Row,
  Sheet,
  StatusChip,
  useAction,
  useLoad,
} from '@/components/ui';
import type { AgentTrace } from '@/lib/client';
import { amountToInput, formatAmount, percentOf } from '@/lib/amount';
import { formatDay, formatWhen, shortAddress } from '@/lib/format';

type Panel = 'fund' | 'policy' | 'revoke' | 'sweep' | 'credential' | null;

function AgentScreen({ id }: { id: string }) {
  const client = useClient();
  const agent = useLoad(() => client.agent(id), [client, id]);
  const funds = useLoad(() => client.agentFunds(id), [client, id]);
  const traces = useLoad(() => client.agentTraces(id), [client, id]);
  const tier = useLoad(() => client.tier(), [client]);
  const [panel, setPanel] = useState<Panel>(null);
  const toggle = useAction();

  if (agent.loading && !agent.data) return <Loading />;
  if (!agent.data) {
    return (
      <>
        <PageHead title="Agent" back={{ href: '/agents/', label: 'Agents' }} />
        <ProblemNote problem={agent.error} onRetry={agent.reload} />
      </>
    );
  }

  const a = agent.data;
  const status = funds.data?.status ?? a.status;
  const daily = BigInt(a.policy.dailyLimit);
  const spent = funds.data?.spentToday ?? 0n;
  const pct = percentOf(spent, daily);
  const reload = () => {
    agent.reload();
    funds.reload();
  };

  return (
    <>
      <PageHead title={a.name ?? 'Unnamed agent'} back={{ href: '/agents/', label: 'Agents' }}>
        <StatusChip status={status} />
      </PageHead>

      <section className="hgrid" style={{ ['--min' as string]: '200px' }}>
        <div className="hcell">
          <div className="num-label">Available</div>
          <div className="big" style={{ fontSize: 34 }}>
            {funds.data ? <Amount units={funds.data.available} /> : '▒▒.▒▒'}
          </div>
          {funds.data && funds.data.pending > 0n && (
            <p className="help">
              + <Amount units={funds.data.pending} /> pending: the agent applies it when it next
              pays.
            </p>
          )}
        </div>
        <div className="hcell">
          <div className="num-label">Spent today</div>
          <div className="big" style={{ fontSize: 34 }}>
            {funds.data ? <Amount units={spent} /> : '▒▒.▒▒'}
          </div>
          <div
            className={`meter ${pct >= 100 ? 'full' : ''}`}
            style={{ marginTop: 14 }}
            aria-hidden="true"
          >
            <div style={{ width: `${pct}%` }} />
          </div>
          <p className="help">of {formatAmount(daily)} USDC in the last 24 hours</p>
        </div>
      </section>
      <ProblemNote problem={funds.error} onRetry={funds.reload} />

      <div className="row" style={{ marginTop: 20 }}>
        {status !== 'revoked' && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setPanel('fund')}>
            Fund
          </button>
        )}
        {status !== 'revoked' && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setPanel('policy')}
          >
            Edit limits
          </button>
        )}
        {status !== 'revoked' && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={toggle.busy}
            aria-busy={toggle.busy}
            onClick={() =>
              void toggle.run(async () => {
                if (status === 'active') await client.pauseAgent(id);
                else await client.resumeAgent(id);
                reload();
              })
            }
          >
            {toggle.busy ? 'Saving…' : status === 'active' ? 'Pause' : 'Resume'}
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setPanel('sweep')}
        >
          Take funds back
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setPanel('credential')}
        >
          Credential
        </button>
        {status !== 'revoked' && (
          <button type="button" className="btn-text" onClick={() => setPanel('revoke')}>
            Revoke
          </button>
        )}
      </div>
      <div style={{ marginTop: 12 }}>
        <ProblemNote problem={toggle.error} />
      </div>

      <section className="section">
        <h2 className="section-title" style={{ marginBottom: 14 }}>
          Policy · version {a.policy.version}
        </h2>
        <div className="panel-flat stack-sm">
          <Row k="Most per payment" v={`${formatAmount(BigInt(a.policy.maxPerRequest))} USDC`} />
          <Row k="Daily limit" v={`${formatAmount(daily)} USDC`} />
          <Row
            k="Recipients"
            v={
              a.policy.allowedRecipients.length === 0
                ? 'Anyone'
                : a.policy.allowedRecipients.map((r) => shortAddress(r, 6, 6)).join(', ')
            }
          />
          <Row
            k="x402 domains"
            v={a.policy.allowedDomains.length === 0 ? 'Any' : a.policy.allowedDomains.join(', ')}
          />
          <Row
            k="Agent account"
            v={<span className="mono">{shortAddress(a.cusdcAccount, 6, 6)}</span>}
          />
          <Row k="Created" v={formatDay(a.createdAt)} />
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Traces</h2>
          <button
            type="button"
            className="tlink"
            style={{ background: 'none', border: 0, cursor: 'pointer' }}
            onClick={traces.reload}
          >
            Refresh
          </button>
        </div>
        <p className="help" style={{ marginTop: -6, marginBottom: 14 }}>
          What the agent logged as it worked: requests, payment prompts, policy checks. Never
          amounts.
        </p>
        {traces.loading && !traces.data && <Loading />}
        <ProblemNote problem={traces.error} onRetry={traces.reload} />
        {traces.data && traces.data.length === 0 && <Empty>No traces yet.</Empty>}
        {traces.data && traces.data.length > 0 && <Traces traces={traces.data} />}
      </section>

      <section className="section">
        <h2 className="section-title" style={{ marginBottom: 14 }}>
          Use it
        </h2>
        <AgentSnippet />
      </section>

      {panel === 'fund' && <FundSheet id={id} onClose={() => setPanel(null)} onDone={reload} />}
      {panel === 'policy' && (
        <PolicySheet
          id={id}
          policy={a.policy}
          tierLimit={tier.data?.tier.agentDailyLimit}
          onClose={() => setPanel(null)}
          onDone={reload}
        />
      )}
      {panel === 'revoke' && <RevokeSheet id={id} onClose={() => setPanel(null)} onDone={reload} />}
      {panel === 'sweep' && <SweepSheet id={id} onClose={() => setPanel(null)} onDone={reload} />}
      {panel === 'credential' && (
        <Sheet title="Agent credential" onClose={() => setPanel(null)}>
          <p className="help" style={{ marginTop: 0, marginBottom: 12 }}>
            Re-derived from your passkey. It’s the same one you got when you created the agent.
          </p>
          <OnceSecret
            value={client.credentialFor(id)}
            what="credential"
            warning={
              <>
                <strong>Treat it like a card number.</strong> Anyone with it and your API key can
                spend from this agent, within its limits.
              </>
            }
          />
        </Sheet>
      )}
    </>
  );
}

function Traces({ traces }: { traces: AgentTrace[] }) {
  const groups = useMemo(() => {
    const m = new Map<string, AgentTrace[]>();
    for (const t of traces) {
      const k = t.requestId ?? t.id;
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return [...m.entries()];
  }, [traces]);
  return (
    <div className="stack">
      {groups.map(([key, steps]) => (
        <div key={key} className="panel-flat">
          <div className="spread" style={{ marginBottom: 10 }}>
            <span className="mono small muted">request {key.slice(0, 8)}</span>
            <span className="small muted">{formatWhen(steps[steps.length - 1]!.createdAt)}</span>
          </div>
          <ol className="steps">
            {[...steps].reverse().map((t) => (
              <li
                key={t.id}
                className="step"
                data-state={t.step === 'failed' || t.detail.passed === false ? 'error' : 'done'}
              >
                <span className="step-dot" aria-hidden="true">
                  {t.step === 'failed' || t.detail.passed === false ? '!' : '·'}
                </span>
                <div className="min0">
                  <div className="step-label">{t.step.replace(/_/g, ' ')}</div>
                  <div className="step-detail mono" style={{ overflowWrap: 'anywhere' }}>
                    {Object.entries(t.detail)
                      .map(([k, v]) => `${k}: ${String(v)}`)
                      .join(' · ')}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function FundSheet({
  id,
  onClose,
  onDone,
}: {
  id: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const client = useClient();
  const balance = useLoad(() => client.balance(), [client]);
  const [input, setInput] = useState('');
  const [key] = useState(newIdempotencyKey);
  const [done, setDone] = useState(false);
  const act = useAction();
  const { parsed, problem } = amountState(input);
  const b = balance.data;
  const spendable = b ? b.available + b.pending : null;
  const over = parsed.ok && spendable !== null && parsed.value > spendable;

  return (
    <Sheet title={done ? 'Funded' : 'Fund agent'} onClose={onClose} dismissable={!act.busy}>
      {done ? (
        <div className="stack">
          <p className="help" style={{ marginTop: 0 }}>
            A private transfer from your balance. It shows as pending until the agent next pays.
          </p>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <div className="stack">
          <AmountInput
            id="fund-amount"
            label="Amount"
            value={input}
            onChange={setInput}
            {...(spendable ? { onMax: () => setInput(amountToInput(spendable)) } : {})}
          />
          {problem && <p className="field-error">{problem}</p>}
          {over && <p className="field-error">That’s more than your balance.</p>}
          {b && (
            <p className="help">
              Your balance: <Amount units={spendable!} /> USDC. Free, and the amount stays
              encrypted.
            </p>
          )}
          <ProblemNote problem={act.error ?? balance.error} />
          <button
            type="button"
            className="btn btn-primary btn-lg"
            disabled={!parsed.ok || over || act.busy}
            aria-busy={act.busy}
            onClick={() =>
              parsed.ok &&
              void act.run(async () => {
                await client.fundAgent(id, parsed.value, key);
                setDone(true);
                onDone();
              })
            }
          >
            {act.busy
              ? 'Encrypting and sending…'
              : parsed.ok
                ? `Send ${formatAmount(parsed.value)} USDC`
                : 'Send'}
          </button>
        </div>
      )}
    </Sheet>
  );
}

function PolicySheet({
  id,
  policy,
  tierLimit,
  onClose,
  onDone,
}: {
  id: string;
  policy: Parameters<typeof PolicyForm>[0]['initial'];
  tierLimit?: bigint;
  onClose: () => void;
  onDone: () => void;
}) {
  const client = useClient();
  const act = useAction();
  return (
    <Sheet title="Edit limits" onClose={onClose} dismissable={!act.busy}>
      <PolicyForm
        initial={policy}
        tierLimit={tierLimit}
        submitLabel="Save policy"
        busyLabel="Signing and updating on NEAR…"
        busy={act.busy}
        error={act.error}
        onSubmit={(p) =>
          void act.run(async () => {
            await client.updateAgentPolicy(id, p);
            onDone();
            onClose();
          })
        }
      />
    </Sheet>
  );
}

function RevokeSheet({
  id,
  onClose,
  onDone,
}: {
  id: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const client = useClient();
  const act = useAction();
  return (
    <Sheet title="Revoke this agent?" onClose={onClose} dismissable={!act.busy}>
      <p className="help" style={{ marginTop: 0 }}>
        It can never pay again, and this can’t be undone. Its balance stays put until you take it
        back.
      </p>
      <ProblemNote problem={act.error} />
      <div className="sheet-actions">
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={act.busy}
          aria-busy={act.busy}
          onClick={() =>
            void act.run(async () => {
              await client.revokeAgent(id);
              onDone();
              onClose();
            })
          }
        >
          {act.busy ? 'Revoking on NEAR…' : 'Revoke for good'}
        </button>
        <button type="button" className="btn btn-secondary" disabled={act.busy} onClick={onClose}>
          Keep it
        </button>
      </div>
    </Sheet>
  );
}

function SweepSheet({
  id,
  onClose,
  onDone,
}: {
  id: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const client = useClient();
  const act = useAction();
  const [swept, setSwept] = useState<bigint | null>(null);
  return (
    <Sheet
      title={swept === null ? 'Take funds back' : 'Done'}
      onClose={onClose}
      dismissable={!act.busy}
    >
      {swept === null ? (
        <>
          <p className="help" style={{ marginTop: 0 }}>
            Moves everything the agent holds, pending included, back to your balance. Works even
            when it’s paused or revoked.
          </p>
          <ProblemNote problem={act.error} />
          <div className="sheet-actions">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              disabled={act.busy}
              aria-busy={act.busy}
              onClick={() =>
                void act.run(async () => {
                  setSwept(await client.sweepAgent(id));
                  onDone();
                })
              }
            >
              {act.busy ? 'Proving and sweeping…' : 'Take it all back'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={act.busy}
              onClick={onClose}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="stack">
          <p className="help" style={{ marginTop: 0 }}>
            {swept === 0n
              ? 'The agent had nothing to take back.'
              : `${formatAmount(swept)} USDC is on its way to your balance. Apply it from Home.`}
          </p>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </Sheet>
  );
}

function AgentFromQuery() {
  const id = useSearchParams().get('id');
  if (!id) {
    return (
      <>
        <PageHead title="Agent" back={{ href: '/agents/', label: 'Agents' }} />
        <Empty>No agent selected.</Empty>
      </>
    );
  }
  return <AgentScreen id={id} />;
}

export default function AgentPage() {
  return (
    <Suspense fallback={<Loading />}>
      <AgentFromQuery />
    </Suspense>
  );
}

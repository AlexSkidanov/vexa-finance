'use client';

import { useState } from 'react';
import type { AgentPolicyInput, AgentSummary } from '@/lib/client';
import { amountToInput, formatAmount } from '@/lib/amount';
import { describeError } from '@/lib/errors';
import { shortAddress } from '@/lib/format';
import { classifyRecipient } from '@/lib/handles';
import { Code } from './code';
import { useClient } from './session';
import { AmountInput, amountState, ProblemNote } from './ui';
import type { Problem } from '@/lib/errors';

const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;
const MAX_LIST = 32;

/** The fields of an agent policy, for creating an agent or changing its limits. */
export function PolicyForm({
  initial,
  tierLimit,
  submitLabel,
  busyLabel,
  busy,
  error,
  onSubmit,
  children,
}: {
  initial?: AgentSummary['policy'];
  /** Most the owner's $VEXA tier allows per day. */
  tierLimit?: bigint;
  submitLabel: string;
  busyLabel: string;
  busy: boolean;
  error: Problem | null;
  onSubmit: (policy: AgentPolicyInput) => void;
  children?: React.ReactNode;
}) {
  const client = useClient();
  const [max, setMax] = useState(initial ? amountToInput(BigInt(initial.maxPerRequest)) : '');
  const [daily, setDaily] = useState(initial ? amountToInput(BigInt(initial.dailyLimit)) : '');
  const [recipients, setRecipients] = useState<{ label: string; account: string }[]>(
    (initial?.allowedRecipients ?? []).map((a) => ({ label: shortAddress(a, 6, 6), account: a })),
  );
  const [domains, setDomains] = useState<string[]>(initial?.allowedDomains ?? []);
  const [recipientInput, setRecipientInput] = useState('');
  const [domainInput, setDomainInput] = useState('');
  const [listProblem, setListProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const m = amountState(max);
  const d = amountState(daily);
  const maxV = m.parsed.ok ? m.parsed.value : null;
  const dailyV = d.parsed.ok ? d.parsed.value : null;
  const maxOverDaily = maxV !== null && dailyV !== null && maxV > dailyV;
  const overTier = tierLimit !== undefined && dailyV !== null && dailyV > tierLimit;
  const valid = maxV !== null && dailyV !== null && !maxOverDaily && !overTier;

  const addRecipient = async () => {
    setListProblem(null);
    const s = recipientInput.trim();
    if (!s) return;
    if (recipients.length >= MAX_LIST) return setListProblem(`Up to ${MAX_LIST} recipients.`);
    const r = classifyRecipient(s);
    if (r.kind === 'address') {
      if (!recipients.some((x) => x.account === s))
        setRecipients([...recipients, { label: shortAddress(s, 6, 6), account: s }]);
      setRecipientInput('');
      return;
    }
    if (r.kind !== 'handle') return setListProblem(r.kind === 'invalid' ? r.message : null);
    setAdding(true);
    try {
      const { display, account } = await client.recipientAccount(r.handle);
      if (!recipients.some((x) => x.account === account))
        setRecipients([...recipients, { label: display, account }]);
      setRecipientInput('');
    } catch (e) {
      setListProblem(describeError(e).message);
    } finally {
      setAdding(false);
    }
  };

  const addDomain = () => {
    setListProblem(null);
    const s = domainInput
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    if (!s) return;
    if (!DOMAIN.test(s) || s.length > 253) return setListProblem('That isn’t a domain name.');
    if (domains.length >= MAX_LIST) return setListProblem(`Up to ${MAX_LIST} domains.`);
    if (!domains.includes(s)) setDomains([...domains, s]);
    setDomainInput('');
  };

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || busy) return;
        onSubmit({
          maxPerRequest: maxV,
          dailyLimit: dailyV,
          allowedRecipients: recipients.map((r) => r.account),
          allowedDomains: domains,
        });
      }}
    >
      {children}
      <AmountInput id="max" label="Most per payment" value={max} onChange={setMax} />
      {m.problem && <p className="field-error">{m.problem}</p>}
      <AmountInput
        id="daily"
        label="Daily limit (rolling 24 hours)"
        value={daily}
        onChange={setDaily}
      />
      {d.problem && <p className="field-error">{d.problem}</p>}
      {maxOverDaily && (
        <p className="field-error">The per-payment maximum can’t exceed the daily limit.</p>
      )}
      {overTier && tierLimit !== undefined && (
        <p className="field-error">
          Your $VEXA tier allows up to {formatAmount(tierLimit)} USDC a day per agent.
        </p>
      )}

      <div>
        <label className="field-label" htmlFor="recipient">
          Allowed recipients (optional)
        </label>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input
            id="recipient"
            className="input"
            placeholder="@shop or a cUSDC account"
            autoCapitalize="none"
            spellCheck={false}
            value={recipientInput}
            onChange={(e) => setRecipientInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void addRecipient();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={adding}
            onClick={() => void addRecipient()}
          >
            {adding ? '…' : 'Add'}
          </button>
        </div>
        <p className="help">
          {recipients.length === 0
            ? 'Empty: the agent may pay anyone.'
            : 'The agent may pay only these.'}
        </p>
        <Chips
          items={recipients.map((r) => ({ key: r.account, label: r.label }))}
          onRemove={(k) => setRecipients(recipients.filter((r) => r.account !== k))}
        />
      </div>

      <div>
        <label className="field-label" htmlFor="domain">
          Allowed domains for x402 (optional)
        </label>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input
            id="domain"
            className="input"
            placeholder="api.example.com"
            autoCapitalize="none"
            spellCheck={false}
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addDomain();
              }
            }}
          />
          <button type="button" className="btn btn-secondary" onClick={addDomain}>
            Add
          </button>
        </div>
        <p className="help">
          {domains.length === 0
            ? 'Empty: the agent may pay for any site that asks with HTTP 402.'
            : 'The agent may pay for these sites only.'}
        </p>
        <Chips
          items={domains.map((x) => ({ key: x, label: x }))}
          onRemove={(k) => setDomains(domains.filter((x) => x !== k))}
        />
      </div>
      {listProblem && <p className="field-error">{listProblem}</p>}
      <p className="help">
        The NEAR policy contract enforces these limits on every payment; neither Vexa nor the agent
        can change them without your passkey.
      </p>
      <ProblemNote problem={error} />
      <button className="btn btn-primary btn-lg" disabled={!valid || busy} aria-busy={busy}>
        {busy ? busyLabel : submitLabel}
      </button>
    </form>
  );
}

function Chips({
  items,
  onRemove,
}: {
  items: { key: string; label: string }[];
  onRemove: (key: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="row" style={{ marginTop: 10 }}>
      {items.map((i) => (
        <span key={i.key} className="chip">
          {i.label}
          <button
            type="button"
            onClick={() => onRemove(i.key)}
            aria-label={`Remove ${i.label}`}
            style={{
              background: 'none',
              border: 0,
              color: 'var(--ash)',
              cursor: 'pointer',
              padding: '0 0 0 4px',
              fontSize: 16,
            }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

export const AGENT_SNIPPET = `import { VexaAgent } from "@vexa/sdk";

// Your API key (Settings → API keys) and this agent's credential.
const agent = new VexaAgent({
  apiKey: process.env.VEXA_API_KEY,
  credential: process.env.VEXA_AGENT_CREDENTIAL,
});

// Pay a handle, within the policy
await agent.pay({ to: "@shop.vexa", amount: 1_500_000n }); // 1.5 USDC

// Or let x402 pay when a site answers 402 Payment Required
const res = await agent.fetch("https://api.example.com/v1/report");`;

export function AgentSnippet() {
  return <Code code={AGENT_SNIPPET} />;
}

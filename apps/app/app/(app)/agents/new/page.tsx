'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AgentSnippet, PolicyForm } from '@/components/agents';
import { useClient } from '@/components/session';
import { OnceSecret, PageHead, useAction, useLoad } from '@/components/ui';
import type { AgentSummary } from '@/lib/client';

export default function NewAgent() {
  const client = useClient();
  const tier = useLoad(() => client.tier(), [client]);
  const create = useAction();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ agent: AgentSummary; credential: string } | null>(null);
  const [saved, setSaved] = useState(false);

  if (created) {
    return (
      <>
        <PageHead title={`${created.agent.name ?? 'Agent'} is ready`} />
        <div className="stack">
          <p className="page-lede" style={{ marginTop: 0 }}>
            This is the agent’s credential. Put it in your agent’s environment with your API key.
          </p>
          <OnceSecret
            value={created.credential}
            what="credential"
            warning={
              <>
                <strong>Store it somewhere safe.</strong> With your API key it can spend from this
                agent, within its limits. You can show it again from the agent’s page while
                unlocked.
              </>
            }
          />
          <AgentSnippet />
          <p className="help">
            VexaAgent runs in Node, where it builds each payment’s proofs. If the credential leaks,
            pause or revoke the agent and sweep its funds back.
          </p>
          <label className="checkbox">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            I’ve stored the credential somewhere safe.
          </label>
          <div className="row">
            <Link
              href={`/agents/view/?id=${created.agent.id}`}
              className="btn btn-primary"
              aria-disabled={!saved}
              style={saved ? undefined : { pointerEvents: 'none', opacity: 0.45 }}
            >
              Fund and manage it
            </Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="New agent"
        back={{ href: '/agents/', label: 'Agents' }}
        lede="Set its limits. You’ll fund it next; it can only spend what you give it."
      />
      <PolicyForm
        tierLimit={tier.data?.tier.agentDailyLimit}
        submitLabel="Create agent"
        busyLabel="Registering the policy on NEAR and opening its account…"
        busy={create.busy}
        error={create.error}
        onSubmit={(policy) =>
          void create.run(async () => {
            setCreated(
              await client.createAgent({ ...(name.trim() ? { name: name.trim() } : {}), policy }),
            );
          })
        }
      >
        <div>
          <label className="field-label" htmlFor="name">
            Name
          </label>
          <input
            id="name"
            className="input"
            maxLength={64}
            placeholder="research-bot"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </PolicyForm>
    </>
  );
}

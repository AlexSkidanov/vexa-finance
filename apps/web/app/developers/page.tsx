import { Code, minCol, SubHero } from '@/components/ui';
import { pageMeta } from '@/lib/meta';
import { DOCS } from '@/lib/site';

export const metadata = pageMeta(
  'Developers',
  'Private USDC in a few lines. Send money, create agents with spend limits and pay x402 APIs with @vexa/sdk.',
  '/developers/',
);

const SAMPLES = [
  {
    title: 'Send money',
    code: `import { Vexa } from "@vexa/sdk";

const vexa = await Vexa.signIn(); // passkey

await vexa.money.transfer({
  to: "@bob.vexa",
  amount: "12.50",
  memo: "Lunch",      // encrypted end to end
  mode: "standard"   // or "stealth"
});`,
  },
  {
    title: 'Create an agent',
    code: `const agent = await vexa.agents.create({
  name: "research-bot",
  policy: {
    maxPerPayment: "5.00",
    dailyLimit: "50.00",
    allowedDomains: ["api.example.com"]
  }
});

// shown once; re-derivable from the passkey
const credential = await vexa.agents.credentialFor(agent.id);`,
  },
  {
    title: 'Pay an x402 API',
    code: `import { VexaAgent } from "@vexa/sdk";

const bot = new VexaAgent({ apiKey, credential });

// 402 → quote → NEAR policy check → paid → retried
const res = await bot.fetch(
  "https://api.example.com/v1/report"
);
const data = await res.json();`,
  },
];

const LINKS = [
  { t: 'Quickstart', s: 'Sign in, deposit, send.', href: DOCS.quickstart },
  { t: 'SDK', s: 'money, agents, view keys, webhooks.', href: DOCS.api },
  { t: 'API reference', s: 'Every endpoint under /v1.', href: DOCS.api },
  { t: 'Agents and x402', s: 'VexaAgent, policies, traces.', href: DOCS.agents },
  {
    t: 'Accepting x402 payments',
    s: 'scheme: "vexa", X-PAYMENT, parseX402Payment.',
    href: DOCS.x402,
  },
  { t: 'Webhooks', s: 'Events and signature verification.', href: DOCS.webhooks },
  { t: 'Changelog', s: 'What shipped, by date.', href: DOCS.changelog },
];

export default function Developers() {
  return (
    <>
      <SubHero eyebrow="Developers" title="Private USDC in a few lines.">
        <div
          data-reveal="1"
          data-delay="140"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 14,
            background: 'var(--surface)',
            border: '1px solid var(--hair)',
            padding: '14px 18px',
            font: '400 16px/1 var(--mono)',
            color: 'var(--paper)',
            maxWidth: '100%',
            overflowX: 'auto',
            boxSizing: 'border-box',
          }}
        >
          <span style={{ color: 'var(--moss)' }} aria-hidden="true">
            $
          </span>
          <code style={{ font: 'inherit', userSelect: 'all', whiteSpace: 'nowrap' }}>
            npm install @vexa/sdk
          </code>
        </div>
      </SubHero>
      <section className="wrap sec-next grid" style={{ ...minCol(320), gap: 20 }}>
        {SAMPLES.map((s, i) => (
          <div key={s.title} data-reveal="1" data-delay={String(i * 100)} className="min0">
            <h2
              style={{
                font: '500 22px/1.2 var(--sans)',
                color: 'var(--paper)',
                margin: '0 0 12px',
              }}
            >
              {s.title}
            </h2>
            <Code code={s.code} />
          </div>
        ))}
      </section>
      <section className="wrap sec-next">
        <div
          data-reveal="1"
          className="grid"
          style={{ ...minCol(200), borderTop: '1px solid var(--paper)' }}
        >
          {LINKS.map((d) => (
            <a
              key={d.t}
              href={d.href}
              target="_blank"
              rel="noopener noreferrer"
              className="doc-link"
            >
              <div style={{ font: '500 20px/1.2 var(--sans)', marginBottom: 4 }}>{d.t}</div>
              <div style={{ font: '400 15px/1.4 var(--sans)', color: 'var(--ash)' }}>{d.s}</div>
            </a>
          ))}
        </div>
      </section>
    </>
  );
}

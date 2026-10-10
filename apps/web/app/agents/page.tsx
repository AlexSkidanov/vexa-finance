import { TLink } from '@/components/transition';
import { minCol, SubHero, TierTable } from '@/components/ui';
import { pageMeta } from '@/lib/meta';
import { APP_URL } from '@/lib/site';

export const metadata = pageMeta(
  'Agents',
  'Give your AI a card with a limit. A NEAR contract signs each payment only if it fits your policy, and it checks the limit on the hidden amount.',
  '/agents/',
);

const POLICY = [
  ['Max per payment', '5.00 USDC'],
  ['Daily limit', '50.00 USDC'],
  ['Allowed recipients', '@openrouter.vexa'],
  ['Allowed websites', 'api.example.com'],
];

const TRACE = [
  ['14:02:01', 'request  GET api.example.com/v1/report'],
  ['14:02:01', 'payment_required  0.25 USDC'],
  ['14:02:02', 'quote  0.25 USDC → @openrouter.vexa'],
  ['14:02:02', 'policy_check  passed on NEAR'],
  ['14:02:04', 'paid  tx 5Kq…e2a'],
  ['14:02:04', 'retried → completed  200'],
];

const CONTROLS = [
  'Pause and resume at any time.',
  'Revoke for good, then take the funds back.',
  'Edit limits; the new policy is signed by your wallet.',
  'Every step of every request, traced live.',
];

export default function Agents() {
  return (
    <>
      <SubHero
        eyebrow="Agents"
        title="Give your AI a card with a limit."
        lede="An agent account holds USDC and spends it within your rules: a maximum per payment, a daily limit, allowed recipients and allowed websites. A NEAR contract signs each payment only if it fits, and it checks the limit on the hidden amount."
      />
      <section
        className="wrap sec-next grid"
        style={{ ...minCol(300), gap: 'clamp(24px,3vw,40px)' }}
      >
        <div data-reveal="1" className="box">
          <div className="num-label" style={{ marginBottom: 22 }}>
            Policy
          </div>
          <div style={{ display: 'grid', gap: 14 }}>
            {POLICY.map(([k, v]) => (
              <div key={k} className="policy-row">
                <span className="k">{k}</span>
                <span className="v">{v}</span>
              </div>
            ))}
          </div>
        </div>
        <div data-reveal="1" data-delay="100" className="box">
          <div className="num-label" style={{ marginBottom: 22 }}>
            Live trace
          </div>
          <div
            style={{
              display: 'grid',
              gap: 10,
              font: '400 15px/1.5 var(--mono)',
              color: 'var(--body)',
            }}
          >
            {TRACE.map(([t, s], i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '72px 1fr',
                  gap: 12,
                  alignItems: 'baseline',
                }}
              >
                <span style={{ color: 'var(--moss)' }}>{t}</span>
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{s}</span>
              </div>
            ))}
          </div>
        </div>
        <div data-reveal="1" data-delay="200" className="box">
          <div className="num-label" style={{ marginBottom: 22 }}>
            Owner controls
          </div>
          <div
            style={{
              display: 'grid',
              gap: 12,
              font: '400 19px/1.35 var(--sans)',
              color: 'var(--body)',
            }}
          >
            {CONTROLS.map((c, i) => (
              <div
                key={c}
                style={
                  i < CONTROLS.length - 1
                    ? { borderBottom: '1px solid var(--hair)', paddingBottom: 12 }
                    : undefined
                }
              >
                {c}
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="wrap sec-next">
        <h2 data-reveal="1" className="h2-sm" style={{ marginBottom: 12 }}>
          Agent limits by tier
        </h2>
        <p data-reveal="1" className="body-18" style={{ margin: '0 0 24px', maxWidth: 640 }}>
          Tiers come from staked $VEXA.{' '}
          <TLink href="/vexa/" className="inline-link">
            See $VEXA.
          </TLink>
        </p>
        <TierTable />
        <p data-reveal="1" className="body-18" style={{ margin: '24px 0 0', maxWidth: 680 }}>
          The policy contract is controlled only by post-quantum ML-DSA-65 keys, live on NEAR
          mainnet.{' '}
          <TLink href="/quantum/" className="inline-link">
            See quantum readiness.
          </TLink>
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 36 }}>
          <a href={APP_URL} className="btn btn-primary">
            Create an agent
          </a>
          <TLink href="/developers/" className="btn btn-secondary">
            Read the docs
          </TLink>
        </div>
      </section>
    </>
  );
}

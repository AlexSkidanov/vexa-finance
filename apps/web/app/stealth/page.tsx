import { minCol, Stat, SubHero } from '@/components/ui';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta(
  'Stealth transfers',
  "No on-chain link between you and the recipient. A stealth transfer routes your USDC through the Zcash shielded pool via NEAR Intents and back to the recipient's Vexa balance.",
  '/stealth/',
);

const ROUTE = [
  { label: 'You', sub: 'Vexa balance', dot: '#F2F2F2' },
  { label: 'One-time address', sub: 'Solana', dot: '#0A0A0B' },
  { label: 'Shielded pool', sub: 'Zcash · NEAR Intents', dot: '#3DE6A5' },
  { label: 'One-time address', sub: 'Solana', dot: '#0A0A0B' },
  { label: 'Recipient', sub: 'Vexa balance', dot: '#F2F2F2' },
];

const STATES = ['Routing', 'Shielded', 'Returning', 'Settled', 'Refunded'];

export default function Stealth() {
  return (
    <>
      <SubHero
        eyebrow="Stealth transfers"
        title="No on-chain link between you and the recipient."
        lede="A stealth transfer routes your USDC through the Zcash shielded pool via NEAR Intents and back to the recipient's Vexa balance. It takes longer and costs a little more than a standard transfer."
      />
      <section className="wrap sec-next">
        <div
          data-reveal="1"
          className="tscroll"
          tabIndex={0}
          role="region"
          aria-label="Stealth transfer route"
          style={{ border: '1px solid var(--hair)', padding: 'clamp(24px,4vw,48px)' }}
        >
          <ol
            style={{
              display: 'flex',
              alignItems: 'center',
              minWidth: 700,
              margin: 0,
              padding: 0,
              listStyle: 'none',
            }}
          >
            {ROUTE.map((r, i) => (
              <li key={i} style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: 'grid',
                    justifyItems: 'center',
                    gap: 12,
                    textAlign: 'center',
                    minWidth: 110,
                  }}
                >
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: '50%',
                      background: r.dot,
                      border: '1px solid #F2F2F2',
                    }}
                  />
                  <div style={{ font: '500 18px/1.2 var(--sans)', color: 'var(--paper)' }}>
                    {r.label}
                  </div>
                  <div style={{ font: '400 13px/1.4 var(--mono)', color: 'var(--ash)' }}>
                    {r.sub}
                  </div>
                </div>
                {i < ROUTE.length - 1 && (
                  <div
                    aria-hidden="true"
                    style={{
                      flex: 1,
                      height: 1,
                      background:
                        'repeating-linear-gradient(90deg,#6B6B70 0 6px,transparent 6px 12px)',
                      margin: '7px 8px 0',
                      alignSelf: 'start',
                    }}
                  />
                )}
              </li>
            ))}
          </ol>
        </div>
      </section>
      <section className="wrap sec-next">
        <div className="hgrid" style={minCol(220)}>
          <Stat
            label="Time"
            value="10–30 min"
            note="You can leave the page."
            size="clamp(36px,3.6vw,52px)"
          />
          <Stat
            label="Minimum"
            value="5 USDC"
            note="Below that, use a standard transfer."
            size="clamp(36px,3.6vw,52px)"
            delay={60}
          />
          <Stat
            label="Cost"
            value="≈ $0.60"
            note="Bridge fees, plus 0.10% on the way out and again on the way back in."
            size="clamp(36px,3.6vw,52px)"
            delay={120}
          />
        </div>
      </section>
      <section className="wrap sec-next grid gap-lg" style={minCol(300)}>
        <div data-reveal="1" className="ncard">
          <h3 className="h3" style={{ marginBottom: 18 }}>
            What you will see
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {STATES.map((s) => (
              <span key={s} className="chip" style={{ fontSize: 15, padding: '9px 14px' }}>
                {s}
              </span>
            ))}
          </div>
        </div>
        <div data-reveal="1" data-delay="100" className="ncard">
          <h3 className="h3">If the first swap fails</h3>
          <p className="body-18">
            Your USDC comes back to your balance automatically. The timeline ends in Refunded, and
            nothing else moves.
          </p>
        </div>
      </section>
    </>
  );
}

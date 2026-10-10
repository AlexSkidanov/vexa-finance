import { minCol, Stat, SubHero, TierTable } from '@/components/ui';
import { pageMeta } from '@/lib/meta';
import { VexaMint } from '@/components/vexa-mint';
import { APP_URL, CONTRACTS, VEXA_LINKS } from '@/lib/site';

export const metadata = pageMeta(
  '$VEXA',
  'Lower fees and more agent capacity, by weight. $VEXA is paired with NEAR so Vexa can fund its agent network from its own liquidity.',
  '/vexa/',
);

const SIZE = 'clamp(30px,3vw,44px)';

const NEAR_FLOW: [string, string][] = [
  [
    'Agents run on NEAR',
    `Every agent payment is checked by the policy contract ${CONTRACTS.policy} before it is signed. Each check costs a little NEAR in gas, and each new agent needs about 0.02 NEAR of storage.`,
  ],
  [
    'The pool supplies the NEAR',
    'With $VEXA paired against NEAR, Vexa can swap for the NEAR its agents consume straight from its own pool, instead of selling for SOL or USDC first and bridging from there.',
  ],
  [
    'Fewer hops to NEAR',
    "NEAR held on Solana moves to the NEAR chain in one step through NEAR Intents, where it funds the relayer that submits agents' policy checks.",
  ],
];

export default function Vexa() {
  return (
    <>
      <SubHero
        eyebrow="$VEXA"
        title="Lower fees and more agent capacity, by weight."
        lede="Your weight is staked $VEXA plus half of what sits in your wallet. Discounts apply automatically to deposits and withdrawals. Staking locks for 7 days after each stake."
      />
      <section className="wrap sec-next">
        <div className="hgrid hgrid-3">
          <Stat
            label="Supply"
            value="≤ 1B"
            note="1,000,000,000 at launch. The mint authority is revoked, so supply can only go down; the live supply is below."
            size={SIZE}
          />
          <Stat
            label="Standard"
            value="Token-2022"
            note="SPL Token Extensions on Solana, 6 decimals. No freeze authority."
            size={SIZE}
            delay={60}
          />
          <Stat
            label="Pair"
            value="VEXA/NEAR"
            note="Liquidity pairs with NEAR to fund the agent network."
            size={SIZE}
            delay={120}
          />
          <Stat
            label="Weight"
            value="S + W/2"
            note="Staked $VEXA plus half your wallet balance, recomputed on every quote."
            size={SIZE}
            delay={180}
          />
          <div data-reveal="1" data-delay="240" className="hcell">
            <VexaMint />
          </div>
          <div data-reveal="1" data-delay="300" className="hcell">
            <div className="num-label">VEXA/NEAR pool</div>
            <div style={{ font: '400 15px/1.5 var(--mono)', color: 'var(--ash)' }}>
              Shown here once the pool is live.
            </div>
          </div>
        </div>
      </section>
      <section className="wrap sec-next">
        <h2 data-reveal="1" className="h2-sm" style={{ marginBottom: 12 }}>
          Why $VEXA pairs with NEAR
        </h2>
        <p data-reveal="1" className="body-18" style={{ margin: '0 0 28px', maxWidth: 680 }}>
          Vexa&rsquo;s AI agents are governed on NEAR, so running them costs NEAR. Pairing $VEXA
          with NEAR means the token&rsquo;s own liquidity can cover that cost with fewer bridge
          hops.
        </p>
        <div className="grid gap-lg" style={minCol(260)}>
          {NEAR_FLOW.map(([t, b], i) => (
            <div
              key={t}
              data-reveal="1"
              {...(i ? { 'data-delay': String(i * 80) } : {})}
              className="ncard"
            >
              <div className="ncard-n">0{i + 1}</div>
              <h3 className="h3">{t}</h3>
              <p className="body-18">{b}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="wrap sec-next">
        <h2 data-reveal="1" className="h2-sm" style={{ marginBottom: 24 }}>
          Tiers
        </h2>
        <TierTable signalDiscount />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 36 }}>
          <a href={APP_URL} className="btn btn-primary">
            Stake in the app
          </a>
          <a
            href={VEXA_LINKS.pumpfun}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary"
          >
            $VEXA on pump.fun
          </a>
          <a
            href={VEXA_LINKS.solscan}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary"
          >
            Token on Solscan
          </a>
        </div>
      </section>
    </>
  );
}

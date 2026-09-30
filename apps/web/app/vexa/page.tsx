import { minCol, Stat, SubHero, TierTable } from '@/components/ui';
import { pageMeta } from '@/lib/meta';
import { APP_URL } from '@/lib/site';

export const metadata = pageMeta(
  '$VEXA',
  'Lower fees and more agent capacity, by weight. Your weight is staked $VEXA plus half of what sits in your wallet.',
  '/vexa/',
);

const SIZE = 'clamp(28px,2.8vw,40px)';

export default function Vexa() {
  return (
    <>
      <SubHero
        eyebrow="$VEXA"
        title="Lower fees and more agent capacity, by weight."
        lede="Your weight is staked $VEXA plus half of what sits in your wallet. Discounts apply automatically to deposits and withdrawals. Staking locks for 7 days after each stake."
      />
      <section className="wrap sec-next">
        <div className="hgrid" style={minCol(200)}>
          <Stat
            label="Supply"
            value="1,000,000,000"
            note="Fixed. Mint authority revoked."
            size={SIZE}
          />
          <Stat label="Standard" value="SPL · 6 dec" note="On Solana." size={SIZE} delay={60} />
          <Stat
            label="Weight"
            value="staked + wallet ÷ 2"
            note="Recomputed on every quote."
            size={SIZE}
            delay={120}
          />
          <div data-reveal="1" data-delay="180" className="hcell">
            <div className="num-label">Mint address</div>
            <div style={{ font: '400 15px/1.5 var(--mono)', color: 'var(--ash)' }}>
              Shown here once $VEXA is live.
            </div>
          </div>
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
          <span
            className="btn btn-secondary"
            aria-disabled="true"
            title="The token address is published here once $VEXA is live."
          >
            Token on Solscan
          </span>
        </div>
      </section>
    </>
  );
}

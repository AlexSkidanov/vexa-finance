import { FeeCalculator } from '@/components/fee-calculator';
import { minCol, SubHero } from '@/components/ui';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta(
  'Pricing',
  '0.10% in, 0.10% out, capped at 5 USDC. Everything between is free. Work out any fee with the calculator.',
  '/pricing/',
);

const ROWS = [
  {
    k: 'Deposits and withdrawals',
    v: '0.10%',
    note: 'Capped at 5 USDC, rounded up to the smallest unit. $VEXA discounts apply.',
  },
  {
    k: 'Transfers between Vexa users',
    v: 'Free',
    note: 'Instant. The amount is hidden on Solana.',
  },
  {
    k: 'Stealth transfers',
    v: '≈ $0.60 + 0.2%',
    note: 'Bridge costs until Vexa has a 1Click partner key, plus the vault fee on the way out and back in.',
  },
  { k: 'Network fees', v: '0', note: 'Paid by Vexa. You never hold SOL.' },
];

export default function Pricing() {
  return (
    <>
      <SubHero
        eyebrow="Pricing"
        title="0.10% in, 0.10% out, capped at 5 USDC. Everything between is free."
      />
      <section
        className="wrap sec-next grid gap-lg"
        style={{ ...minCol(320), alignItems: 'start' }}
      >
        <dl data-reveal="1" style={{ display: 'grid', gap: 0, margin: 0 }}>
          {ROWS.map((r) => (
            <div key={r.k} className="price-row">
              <dt style={{ font: '500 22px/1.2 var(--sans)', color: 'var(--paper)' }}>{r.k}</dt>
              <dd
                style={{
                  margin: 0,
                  font: '400 18px/1.2 var(--mono)',
                  color: 'var(--paper)',
                  textAlign: 'right',
                }}
              >
                {r.v}
              </dd>
              <dd
                style={{
                  margin: 0,
                  gridColumn: '1 / -1',
                  font: '400 17px/1.45 var(--sans)',
                  color: 'var(--ash)',
                  textWrap: 'pretty',
                }}
              >
                {r.note}
              </dd>
            </div>
          ))}
        </dl>
        <FeeCalculator />
      </section>
    </>
  );
}

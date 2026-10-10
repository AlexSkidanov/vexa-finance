import { PageHead } from '@/components/ui';

const PLANNED: [string, string][] = [
  ['Spend from your private balance', 'Pay anywhere cards are taken, straight from your USDC.'],
  ['Virtual first, physical later', 'A card number in the app the day you sign up for it.'],
  ['Freeze in one tap', 'Lock and unlock the card from your phone at any time.'],
  ['Cards for agents', 'Give an AI agent its own card with the same limits you set today.'],
];

export default function Cards() {
  return (
    <>
      <PageHead
        title="Cards"
        lede="A Vexa card that spends from your private USDC balance. We're building it now."
      />

      <section className="panel-flat stack" aria-label="Vexa card preview">
        <span className="chip chip-signal" style={{ justifySelf: 'start', width: 'fit-content' }}>
          Coming soon
        </span>
        <div
          aria-hidden="true"
          style={{
            width: '100%',
            maxWidth: 360,
            aspectRatio: '1.586',
            borderRadius: 16,
            border: '1px solid var(--hair)',
            background:
              'radial-gradient(120% 140% at 100% 0%, rgba(61,230,165,.18), transparent 55%), var(--vault)',
            padding: 22,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ font: '600 24px/1 var(--sans)', letterSpacing: '-.04em' }}>vexa</span>
          <span style={{ font: '400 15px/1 var(--mono)', color: 'var(--ash)', letterSpacing: 2 }}>
            •••• •••• •••• ••••
          </span>
        </div>
      </section>

      <section className="section hgrid" style={{ ['--min' as string]: '220px' }}>
        {PLANNED.map(([title, body]) => (
          <div key={title} className="hcell">
            <div className="num-label" style={{ marginBottom: 10 }}>
              Planned
            </div>
            <p style={{ margin: '0 0 6px', font: '500 18px/1.3 var(--sans)' }}>{title}</p>
            <p className="help" style={{ margin: 0 }}>
              {body}
            </p>
          </div>
        ))}
      </section>

      <p className="notice">
        Cards aren&rsquo;t available yet, and nothing here is live. We&rsquo;ll announce the launch
        on vexa.finance.
      </p>
    </>
  );
}

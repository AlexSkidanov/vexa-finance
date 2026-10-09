import { TLink } from '@/components/transition';
import { DataTable, minCol, SubHero } from '@/components/ui';
import { pageMeta } from '@/lib/meta';
import { CONTRACTS, GITHUB_URL, solscanAccount } from '@/lib/site';

export const metadata = pageMeta(
  'How it works',
  'Your USDC becomes cUSDC, a confidential token on Solana, one to one. The balance is encrypted with keys derived from your passkey.',
  '/how-it-works/',
);

const FLOW = [
  {
    n: '01',
    title: 'USDC in',
    body: 'Send USDC to your passkey wallet on Solana, then deposit. The deposit is public, like any USDC transfer.',
  },
  {
    n: '02',
    title: 'cUSDC, 1:1',
    body: 'The vault mints a confidential token backed by the reserve. Supply and reserve are both public and always match.',
  },
  {
    n: '03',
    title: 'Encrypted balance',
    body: 'Your balance and every transfer amount are encrypted with keys from your passkey. Memos are encrypted end to end.',
  },
  {
    n: '04',
    title: 'USDC out',
    body: 'Withdraw to any address that already holds USDC. Your device builds the proof; the amount becomes public at the edge.',
  },
];

const VIS = [
  ['Deposit', 'public', 'public', 'public'],
  ['Transfer between Vexa users', 'hidden', 'visible', 'visible'],
  ['Stealth transfer', 'hidden', 'one-time addresses', 'hidden'],
  ['Withdrawal', 'public', 'public', 'public'],
  ['Balance', 'hidden', '—', '—'],
];

const KEYS = ['wallet', 'encryption keys', 'agent keys', 'view keys'];

export default function HowItWorks() {
  return (
    <>
      <SubHero
        eyebrow="How it works"
        title="USDC in. A private balance. USDC out."
        lede="Your USDC becomes cUSDC, a confidential token on Solana, one to one. The balance is encrypted with keys derived from your passkey. Withdraw and it is USDC again."
      />
      <section className="wrap sec-next">
        <div className="hgrid" style={minCol(220)}>
          {FLOW.map((f, i) => (
            <div
              key={f.n}
              data-reveal="1"
              data-delay={String(i * 80)}
              className="hcell"
              style={{ padding: 'clamp(22px,3vw,32px)' }}
            >
              <div className="ncard-n" style={{ marginBottom: 34 }}>
                {f.n}
              </div>
              <div
                style={{
                  font: '500 clamp(24px,2.2vw,30px)/1.1 var(--sans)',
                  letterSpacing: '-.02em',
                  color: 'var(--paper)',
                  marginBottom: 10,
                }}
              >
                {f.title}
              </div>
              <div
                style={{
                  font: '400 17px/1.45 var(--sans)',
                  color: 'var(--body)',
                  textWrap: 'pretty',
                }}
              >
                {f.body}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="wrap sec-next">
        <h2 data-reveal="1" className="h2-sm">
          What is public and what is private
        </h2>
        <div data-reveal="1" data-delay="80">
          <DataTable
            label="What is public and what is private"
            head={['Action', 'Amount', 'Parties', 'Link between them']}
            rows={VIS}
            template="1.2fr 1fr 1fr 1fr"
            minWidth={560}
            cell={(c) =>
              c === 0
                ? {
                    style: {
                      font: '400 19px/1.3 var(--sans)',
                      color: 'var(--paper)',
                      padding: '16px 16px 16px 0',
                    },
                  }
                : {
                    style: {
                      fontSize: 15,
                      padding: c === 3 ? '18px 0 16px 0' : '18px 16px 16px 0',
                    },
                  }
            }
          />
        </div>
      </section>
      <section className="wrap sec-next grid gap-lg" style={minCol(300)}>
        <div data-reveal="1" className="ncard">
          <h3 className="h3">One passkey, every key</h3>
          <p className="body-18" style={{ marginBottom: 18 }}>
            Signing in with your passkey derives the Solana wallet, the encryption keys, agent keys
            and view keys. Vexa stores none of them.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <span className="chip">passkey</span>
            <span
              className="mono"
              style={{ font: '400 14px/1 var(--mono)', color: 'var(--moss)', padding: '8px 0' }}
            >
              →
            </span>
            {KEYS.map((k) => (
              <span key={k} className="chip">
                {k}
              </span>
            ))}
          </div>
        </div>
        <div data-reveal="1" data-delay="100" className="ncard">
          <h3 className="h3">Zero-knowledge proofs, plainly</h3>
          <p className="body-18" style={{ marginBottom: 18 }}>
            Your device proves you have enough without showing how much. Solana checks the proof and
            moves the encrypted balance. It takes one to three seconds on a laptop.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}>
            <a
              href={solscanAccount(CONTRACTS.vault)}
              target="_blank"
              rel="noopener noreferrer"
              className="tlink mono hit"
            >
              Vault program
            </a>
            <TLink href="/security/" className="tlink mono hit">
              Reserve
            </TLink>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="tlink mono hit"
            >
              GitHub
            </a>
          </div>
        </div>
      </section>
    </>
  );
}

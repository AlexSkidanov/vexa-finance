import { QuantumKey } from '@/components/quantum-key';
import { DataTable, minCol, Stat, SubHero } from '@/components/ui';
import { pageMeta } from '@/lib/meta';
import { CONTRACTS, DOCS, NEAR_PQ } from '@/lib/site';

export const metadata = pageMeta(
  'Quantum readiness',
  'What a quantum computer would break, what NEAR has already made post-quantum with ML-DSA, and where each part of Vexa stands, with a live key check.',
  '/quantum/',
);

const NEAR_SHIPPED: [string, string][] = [
  [
    'Accounts are not their keys',
    'A NEAR account is a name like vexa-policy.near, controlled by access keys that can be added and removed. On Bitcoin or Ethereum the address is the key, so a broken key means a lost address. On NEAR you rotate the key and keep the account.',
  ],
  [
    'ML-DSA-65 is live on mainnet',
    'Since nearcore 2.13, NEAR accepts ML-DSA-65 (NIST FIPS 204, formerly Dilithium) as a third signature scheme next to Ed25519 and secp256k1. Any account can add an ML-DSA key and remove its old ones in one transaction, and that account is then post-quantum at the key level.',
  ],
  [
    'Wallets are following',
    'Meteor Wallet signs with ML-DSA today. Ledger and other wallets are working on it with Near One.',
  ],
  [
    'Contracts can verify it next',
    'nearcore 2.14, in release candidates now, adds an ml_dsa_verify host function so contracts can check ML-DSA signatures themselves, and universal accounts with a post-quantum-safe derivation.',
  ],
];

const NEAR_NEXT: [string, string, string][] = [
  ['Post-quantum consensus', 'End of 2027', 'Validators still sign blocks with Ed25519.'],
  [
    'Post-quantum Chain Signatures',
    'No timeline yet',
    'No practical post-quantum threshold scheme exists today.',
  ],
  ['Falcon (FN-DSA)', 'Under consideration', 'Smaller signatures than ML-DSA.'],
  [
    'Seed-phrase ownership proofs',
    'Research',
    'Prove you own a key with a zero-knowledge proof of its seed, which quantum computers cannot reverse.',
  ],
];

const VEXA: [string, string, string][] = [
  [
    'Keys that can change the agent policy contract',
    'Shown live above',
    'Rotate to ML-DSA-65. Available on NEAR now.',
  ],
  [
    'Agent limit checks',
    'Run on NEAR',
    'Fully post-quantum when NEAR consensus is, targeted for end of 2027.',
  ],
  [
    'Agent wallets on Solana (NEAR Chain Signatures)',
    'Ed25519 threshold signing',
    'Waits on post-quantum threshold signing, which has no timeline.',
  ],
  [
    'Encrypted balances and amounts',
    'ElGamal on Curve25519, set by Solana',
    'Waits on a post-quantum confidential token standard on Solana.',
  ],
  ['Stealth transfers', 'Zcash Orchard via NEAR Intents', 'Waits on Zcash and NEAR Intents.'],
  [
    'Signed audit exports and webhooks',
    'Ed25519',
    'Add an ML-DSA-65 signature alongside the current one.',
  ],
  ['Stored secrets (API keys, view keys)', 'AES-256-GCM', 'Already quantum-resistant.'],
];

export default function Quantum() {
  return (
    <>
      <SubHero
        eyebrow="Quantum readiness"
        title="Getting ready for Q-Day, in the open."
        lede="A large enough quantum computer will break the signatures and encryption most blockchains use today. NEAR, where Vexa's agent policy lives, is one of the first blockchains with post-quantum signatures on mainnet. Here is what that covers, what it doesn't yet, and where every part of Vexa stands."
      />
      <section className="wrap sec-next">
        <div className="hgrid" style={minCol(220)}>
          <Stat
            label="On NEAR mainnet"
            value="ML-DSA-65"
            note="NIST FIPS 204 signatures, since nearcore 2.13."
            size="clamp(36px,3.6vw,52px)"
          />
          <Stat
            label="NEAR consensus"
            value="2027"
            note="Near One's target for post-quantum block signing."
            size="clamp(36px,3.6vw,52px)"
            delay={60}
          />
          <Stat
            label="Already safe"
            value="AES-256"
            note="Symmetric encryption and SHA-2/SHA-3 hashes hold up."
            size="clamp(36px,3.6vw,52px)"
            delay={120}
          />
        </div>
      </section>

      <section className="wrap sec-next grid" style={{ ...minCol(300), gap: 24 }}>
        <div data-reveal="1">
          <QuantumKey />
        </div>
        <div data-reveal="1" data-delay="80" className="ncard">
          <h3 className="h3">Why a privacy product cares now</h3>
          <p className="body-18">
            Blockchains keep everything forever. Someone can save today&rsquo;s encrypted balances
            and signatures and break them once a quantum computer exists. That is called{' '}
            <em>harvest now, decrypt later</em>, and it means data written today has to survive
            Q-Day, whenever it comes.
          </p>
        </div>
      </section>

      <section className="wrap sec-next">
        <h2 data-reveal="1" className="h2-sm" style={{ marginBottom: 24 }}>
          What NEAR has shipped
        </h2>
        <div className="grid gap-lg" style={minCol(280)}>
          {NEAR_SHIPPED.map(([t, b], i) => (
            <div
              key={t}
              data-reveal="1"
              {...(i ? { 'data-delay': String(i * 60) } : {})}
              className="ncard"
            >
              <h3 className="h3">{t}</h3>
              <p className="body-18">{b}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="wrap sec-next">
        <h2 data-reveal="1" className="h2-sm" style={{ marginBottom: 24 }}>
          What NEAR is still working on
        </h2>
        <div data-reveal="1" data-delay="80">
          <DataTable
            label="NEAR post-quantum roadmap"
            head={['Work', 'Status', 'Why it matters']}
            rows={NEAR_NEXT}
            template="1.1fr .8fr 1.6fr"
            minWidth={620}
            cell={(c) => ({ className: c === 0 ? 'td first' : 'td' })}
          />
        </div>
      </section>

      <section className="wrap sec-next">
        <h2 data-reveal="1" className="h2-sm" style={{ marginBottom: 12 }}>
          Where Vexa stands
        </h2>
        <p data-reveal="1" className="body-18" style={{ margin: '0 0 24px', maxWidth: 680 }}>
          Vexa uses three chains, and each moves at its own pace. We won&rsquo;t call Vexa
          quantum-proof until every row below is.
        </p>
        <div data-reveal="1" data-delay="80">
          <DataTable
            label="Vexa quantum readiness"
            head={['Part of Vexa', 'Today', 'Path to post-quantum']}
            rows={VEXA}
            template="1.3fr 1.1fr 1.5fr"
            minWidth={680}
            cell={(c) => ({ className: c === 0 ? 'td first' : 'td' })}
          />
        </div>
      </section>

      <section className="wrap sec-next">
        <p data-reveal="1" className="body-18" style={{ margin: 0, maxWidth: 720 }}>
          Sources: Near One&rsquo;s{' '}
          <a href={NEAR_PQ.intro} target="_blank" rel="noopener noreferrer" className="inline-link">
            Preparing NEAR for the Quantum Computing Era
          </a>{' '}
          and{' '}
          <a
            href={NEAR_PQ.roadmap}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-link"
          >
            the post-quantum roadmap
          </a>
          , the{' '}
          <a
            href={NEAR_PQ.release}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-link"
          >
            nearcore 2.13 release notes
          </a>{' '}
          and NIST FIPS 204. Our technical notes are in{' '}
          <a href={DOCS.quantum} target="_blank" rel="noopener noreferrer" className="inline-link">
            QUANTUM.md
          </a>
          . Timelines are NEAR&rsquo;s and can change. The policy contract is{' '}
          <span className="mono" style={{ fontSize: '.9em' }}>
            {CONTRACTS.policy}
          </span>
          .
        </p>
      </section>
    </>
  );
}

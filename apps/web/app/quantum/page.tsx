import { QuantumKey } from '@/components/quantum-key';
import { DataTable, minCol, Stat, SubHero } from '@/components/ui';
import { pageMeta } from '@/lib/meta';
import { CONTRACTS, DOCS, NEAR_PQ, PQ_ROTATION } from '@/lib/site';

export const metadata = pageMeta(
  'Quantum readiness',
  "Vexa's agent policy contract is controlled only by post-quantum ML-DSA-65 keys, live on NEAR mainnet. A live key check, the on-chain proof, and where every other part of Vexa stands.",
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
    'Done: ML-DSA-65 keys only since 9 October 2026.',
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
        title="Post-quantum keys, live on mainnet."
        lede="Since 9 October 2026, the contract that enforces every agent's spending limits has been controlled only by ML-DSA-65 keys, the NIST post-quantum signature standard, on NEAR mainnet. Its elliptic-curve key is deleted. Check it live below, see the transactions, and see what still depends on Solana, NEAR and Zcash upgrading."
      />
      <section className="wrap sec-next">
        <div className="hgrid" style={minCol(220)}>
          <Stat
            label="Live on mainnet"
            value="ML-DSA-65"
            note="The only key type on vexa-policy.near since 9 October 2026."
            size="clamp(36px,3.6vw,52px)"
          />
          <Stat
            label="Elliptic-curve keys"
            value="0"
            note="The Ed25519 key was deleted in an ML-DSA-signed transaction."
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
          <h3 className="h3">On-chain proof</h3>
          <p className="body-18" style={{ marginBottom: 14 }}>
            Every step of the rotation is a public NEAR mainnet transaction, signed on{' '}
            {PQ_ROTATION.date}.
          </p>
          <ul className="body-18" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
            <li>
              <a
                href={PQ_ROTATION.addKeyTx}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-link"
              >
                ML-DSA-65 key added
              </a>
            </li>
            <li>
              <a
                href={PQ_ROTATION.removeEd25519Tx}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-link"
              >
                Ed25519 key deleted, signed with ML-DSA-65
              </a>
            </li>
            <li>
              <a
                href={PQ_ROTATION.keys}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-link"
              >
                The contract&rsquo;s current keys on NearBlocks
              </a>
            </li>
          </ul>
        </div>
      </section>

      <section className="wrap sec-next">
        <div data-reveal="1" className="ncard" style={{ maxWidth: 760 }}>
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

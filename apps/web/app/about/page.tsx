import { ProsePage } from '@/components/prose-page';
import { TLink } from '@/components/transition';
import { pageMeta } from '@/lib/meta';
import { CONTACT_EMAIL, GITHUB_URL } from '@/lib/site';

export const metadata = pageMeta(
  'About',
  'Vexa is a privacy neobank on Solana: encrypted USDC balances, agents with spend limits enforced on NEAR, and stealth transfers through the Zcash shielded pool.',
  '/about/',
);

export default function About() {
  return (
    <ProsePage eyebrow="About" title="Money should be private by default.">
      <h2>What Vexa is</h2>
      <p>
        Vexa is a bank account for USDC on Solana where only you can read the balance. Amounts are
        encrypted on chain with keys derived from your passkey, agents spend within limits a NEAR
        contract enforces, and stealth transfers route through the Zcash shielded pool so there is
        no on-chain link between sender and recipient.
      </p>
      <h2>How we build</h2>
      <p>
        The code is open source and the reserve is public. Anyone can check that every cUSDC is
        backed by USDC, read the contracts and verify the deployed bytecode. See{' '}
        <TLink href="/security/">Security and transparency</TLink> or the code on{' '}
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
        .
      </p>
      <h2>Ready for what comes next</h2>
      <p>
        Quantum computers will one day break the cryptography most blockchains use. Vexa enforces
        agent limits in a NEAR contract that has been controlled only by post-quantum ML-DSA-65 keys
        since 9 October 2026, and publishes where every part of the product stands on{' '}
        <TLink href="/quantum/">Quantum readiness</TLink>.
      </p>
      <h2>Contact</h2>
      <p>
        Write to{' '}
        <span className="mono" style={{ fontSize: '.9em', userSelect: 'all' }}>
          {CONTACT_EMAIL}
        </span>
        .
      </p>
    </ProsePage>
  );
}

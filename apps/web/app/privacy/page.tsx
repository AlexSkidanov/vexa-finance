import { ProsePage } from '@/components/prose-page';
import { pageMeta } from '@/lib/meta';
import { CONTACT_EMAIL } from '@/lib/site';

export const metadata = pageMeta(
  'Privacy policy',
  'What Vexa can and cannot see, and what this website collects.',
  '/privacy/',
);

export default function Privacy() {
  return (
    <ProsePage eyebrow="Legal" title="Privacy policy">
      <h2>What Vexa cannot see</h2>
      <p>
        Balances, transfer amounts and memos are encrypted with keys that stay on your devices. Vexa
        cannot read them. A view key you create lets whoever holds it read the transfers in its date
        range until you revoke it.
      </p>
      <h2>What is public anyway</h2>
      <p>
        Solana is a public ledger. Deposits and withdrawals, and the fact that two accounts
        transacted in a standard transfer, are visible to anyone. Stealth transfers remove that
        link.
      </p>
      <h2>What the service keeps</h2>
      <p>
        To run your account, Vexa keeps what it needs to operate it, such as your handle, your
        public keys and records of transactions it relays, in their encrypted form where amounts are
        involved.
      </p>
      <h2>This website</h2>
      <ul>
        <li>No advertising or cross-site tracking cookies.</li>
        <li>Fonts are served from this site.</li>
        <li>
          The audit portal decrypts in your browser and keeps the key in memory only; closing the
          tab clears it.
        </li>
      </ul>
      <h2>Questions</h2>
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

import { ProsePage } from '@/components/prose-page';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta(
  'Risk disclosures',
  'The risks of holding and moving USDC with Vexa. Read before you deposit.',
  '/risk/',
);

export default function Risk() {
  return (
    <ProsePage eyebrow="Legal" title="Risk disclosures">
      <p style={{ marginTop: 28 }}>Read this before you deposit. It is not a complete list.</p>
      <h2>Not a bank deposit</h2>
      <p>
        Vexa is not a bank. Balances are not covered by deposit insurance or any government
        protection scheme.
      </p>
      <h2>Stablecoin risk</h2>
      <p>
        cUSDC is backed one to one by USDC held in a public reserve. USDC is issued by a third party
        and could lose its peg, be frozen or be affected by its issuer&rsquo;s decisions.
      </p>
      <h2>Software and network risk</h2>
      <p>
        Smart contracts, cryptography and the networks Vexa uses (Solana, NEAR, Zcash and the
        bridges between them) can have bugs, outages or attacks. Transfers on chain are final.
      </p>
      <h2>Key loss</h2>
      <p>
        Your keys come from your passkey. If you lose every passkey, nobody can recover the account,
        including Vexa. Add a second passkey on another device.
      </p>
      <h2>Stealth transfers</h2>
      <p>
        Stealth transfers route through external bridges and the Zcash shielded pool. They take 10
        to 30 minutes, cost more than standard transfers, and depend on third-party services. If the
        first swap fails, funds return to your balance.
      </p>
      <h2>Agents</h2>
      <p>
        An agent spends on its own within the limits you set. Set limits you are comfortable losing,
        and pause or revoke an agent at any time.
      </p>
      <h2>Legal and tax</h2>
      <p>
        Rules differ by country and can change. You are responsible for any taxes and for using Vexa
        where it is lawful.
      </p>
    </ProsePage>
  );
}

import { ProsePage } from '@/components/prose-page';
import { TLink } from '@/components/transition';
import { pageMeta } from '@/lib/meta';
import { CONTACT_EMAIL } from '@/lib/site';

export const metadata = pageMeta('Terms', 'The terms for using Vexa and this website.', '/terms/');

export default function Terms() {
  return (
    <ProsePage eyebrow="Legal" title="Terms of use">
      <h2>Using Vexa</h2>
      <p>
        Vexa is software that lets you hold and move USDC on Solana with encrypted balances. By
        opening an account or using this website you agree to use it lawfully and at your own risk,
        and to keep your passkeys safe.
      </p>
      <h2>Your keys, your funds</h2>
      <p>
        Your keys are derived from your passkey on your devices. Vexa does not hold them and cannot
        recover an account if every passkey is lost. Vexa cannot move your funds or read your
        balance.
      </p>
      <h2>Fees</h2>
      <p>
        Fees are shown on the <TLink href="/pricing/">pricing page</TLink> and in the app before you
        confirm anything. Fees can change; the app always shows the current fee before you act.
      </p>
      <h2>No advice</h2>
      <p>
        Nothing on this website is financial, legal or tax advice. Read the{' '}
        <TLink href="/risk/">risk disclosures</TLink> before you deposit.
      </p>
      <h2>Changes and questions</h2>
      <p>
        These terms may be updated as the product changes. Questions go to{' '}
        <span className="mono" style={{ fontSize: '.9em', userSelect: 'all' }}>
          {CONTACT_EMAIL}
        </span>
        .
      </p>
    </ProsePage>
  );
}
